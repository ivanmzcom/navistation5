/* SPDX-License-Identifier: GPL-3.0-or-later
 * Freestanding C++, using ShellUI's own exception runtime. All code/state/EH
 * remain resident until ShellUI exits. No syscalls, Mono, timers or network.
 */
#include "cc_bootstrap_stub.h"
extern "C" {
__attribute__((section(".nd_state"), visibility("hidden")))
struct nd_bootstrap_state nd_state;
extern __attribute__((visibility("hidden")))
const unsigned char nd_eh_frame_start[], nd_eh_frame_end[];
}
typedef void (*nd_eval_fn)(uint64_t, const void *, uint64_t, const char *, int,
                         struct nd_native_exception *);
typedef void (*nd_free_fn)(uint64_t);
typedef void (*nd_add_fde_fn)(uintptr_t);
typedef void (*nd_fde_callback)(uint64_t, uint64_t, uint64_t, uint64_t);
typedef void (*nd_iterate_fde_fn)(nd_fde_callback);

/* Entry rsp%16=8. Seven pushes give rsp%16=0 for call. Restore six original
 * args and exact entry RSP, then tail jump: stock exceptions bypass our frame,
 * even when registration fails. Runtime thunks preserve argument registers. */
__asm__(
    ".section .text.nd_hook,\"ax\",@progbits\n"
    ".globl nd_hook\n.hidden nd_hook\n.type nd_hook,@function\n"
    "nd_hook:\n.cfi_startproc\n"
    "pushq %rbp\n.cfi_def_cfa_offset 16\n.cfi_offset %rbp,-16\n"
    "movq %rsp,%rbp\n.cfi_def_cfa_register %rbp\n"
    "pushq %rdi\npushq %rsi\npushq %rdx\npushq %rcx\npushq %r8\npushq %r9\n"
    "call nd_bootstrap_worker\n"
    "popq %r9\npopq %r8\npopq %rcx\npopq %rdx\npopq %rsi\npopq %rdi\n"
    "popq %rbp\n.cfi_def_cfa %rsp,8\n.cfi_restore %rbp\n"
    "jmp *%rax\n.cfi_endproc\n.size nd_hook,.-nd_hook\n"
    ".section .text.nd_thunks,\"ax\",@progbits\n"
    ".globl __cxa_begin_catch\n.hidden __cxa_begin_catch\n"
    ".type __cxa_begin_catch,@function\n__cxa_begin_catch:\n"
    "jmp *nd_state+0x1f0(%rip)\n.size __cxa_begin_catch,.-__cxa_begin_catch\n"
    ".globl __cxa_end_catch\n.hidden __cxa_end_catch\n"
    ".type __cxa_end_catch,@function\n__cxa_end_catch:\n"
    "jmp *nd_state+0x1f8(%rip)\n.size __cxa_end_catch,.-__cxa_end_catch\n"
    ".previous\n");

/* Called with target cache locked. Scalar-only; never re-enter cache APIs. */
static void nd_verify_fde(uint64_t start, uint64_t end, uint64_t fde, uint64_t group)
{
    struct nd_bootstrap_state *s = &nd_state;
    if (fde != group) return;
    for (uint32_t i = 0; i < s->eh_expected_count; ++i) {
        const struct nd_fde_expectation *e = &s->eh_expected[i];
        if (e->fde == fde && e->pc_start == start && e->pc_end == end)
            s->eh_verified_mask |= 1U << i;
    }
}

/* Offline package inspection checks every CIE encoding. This image only uses
 * 32-bit lengths and pcrel sdata4 initial locations. Parse all records before
 * making target calls. Register FDE pointers, never CIE/section pointers. */
static bool nd_register_frames(struct nd_bootstrap_state *s)
{
    if (!s->cxa_begin_catch || !s->cxa_end_catch || !s->personality ||
        !s->add_dynamic_fde || !s->iterate_fde_cache) {
        s->eh_failure = 1; return false;
    }
    const unsigned char *p;
    const unsigned char *end;
    /* External linker symbols otherwise use GOTPCREL on the PS5 ABI; static
     * lld can relax comparisons into absolute immediates. Force RIP-relative
     * addresses so this image remains relocatable at any mapping base. */
    __asm__("leaq nd_eh_frame_start(%%rip),%0\n"
            "leaq nd_eh_frame_end(%%rip),%1" : "=r"(p), "=r"(end));
    while (p < end) {
        if ((uintptr_t)(end - p) < 4) { s->eh_failure = 2; return false; }
        uint32_t length = *(const uint32_t *)p;
        if (!length) {
            if (p + 4 != end) { s->eh_failure = 2; return false; }
            p += 4; break;
        }
        if (length < 4 || length == UINT32_MAX || length > (uintptr_t)(end - p - 4)) {
            s->eh_failure = 2; return false;
        }
        if (*(const uint32_t *)(p + 4)) {
            if (length < 12) { s->eh_failure = 2; return false; }
            if (s->eh_expected_count >= ND_STUB_MAX_FDES) {
                s->eh_failure = 3; return false;
            }
            struct nd_fde_expectation *e = &s->eh_expected[s->eh_expected_count++];
            e->fde = (uintptr_t)p;
            e->pc_start = (uintptr_t)(p + 8) + *(const int32_t *)(p + 8);
            e->pc_end = e->pc_start + *(const uint32_t *)(p + 12);
            if (e->pc_start >= e->pc_end) { s->eh_failure = 2; return false; }
        }
        p += length + 4;
    }
    if (p != end || !s->eh_expected_count) { s->eh_failure = 2; return false; }
    for (uint32_t i = 0; i < s->eh_expected_count; ++i) {
        ((nd_add_fde_fn)(uintptr_t)s->add_dynamic_fde)(s->eh_expected[i].fde);
        ++s->eh_registered_count;
    }
    ((nd_iterate_fde_fn)(uintptr_t)s->iterate_fde_cache)(nd_verify_fde);
    if (s->eh_verified_mask != (1U << s->eh_expected_count) - 1) {
        s->eh_failure = 4; return false;
    }
    return true;
}

extern "C" __attribute__((visibility("hidden"), noinline, used))
uint64_t nd_bootstrap_worker(uint64_t executor)
{
    struct nd_bootstrap_state *s = &nd_state;
    __atomic_add_fetch(&s->active_calls, 1, __ATOMIC_SEQ_CST);
    uint32_t expected = 0;
    const bool owner = s->magic == ND_STUB_MAGIC && executor == s->executor &&
        __atomic_compare_exchange_n(&s->state, &expected, 1, 0,
                                    __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
    if (owner) {
        uint64_t previous = s->cloned_vtable;
        s->vtable_restored = __atomic_compare_exchange_n(
            (uint64_t *)(uintptr_t)executor, &previous, s->original_vtable,
            0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
        if (!s->vtable_restored) s->restore_conflict = 1;
        s->identity_accepted = s->vtable_restored &&
            *(const uint32_t *)(uintptr_t)(executor + 0x48) == 1 &&
            *(const uint64_t *)(uintptr_t)(executor + 0x70) == s->app_instance_id &&
            *(const uint64_t *)(uintptr_t)(executor + 0x78) == s->runtime;
        if (s->identity_accepted && nd_register_frames(s)) {
            try {
                struct nd_native_exception exception = {};
                s->evaluation_attempted = 1;
                ((nd_eval_fn)(uintptr_t)s->evaluate)(executor,
                    (const void *)(uintptr_t)s->script, s->script_bytes,
                    (const char *)(uintptr_t)s->source_url, 0, &exception);
                s->exception_type = exception.type;
                s->exception_static = exception.is_static;
                if (exception.message) {
                    const char *message = (const char *)(uintptr_t)exception.message;
                    uint32_t i = 0;
                    while (i + 1 < sizeof(s->message) && message[i]) {
                        s->message[i] = message[i]; ++i;
                    }
                    s->message[i] = 0;
                    s->message_bytes = i;
                    if (!exception.is_static) {
                        ((nd_free_fn)(uintptr_t)s->free_string)(exception.message);
                        s->exception_freed = 1;
                    }
                }
            } catch (...) {
                /* Target runtime only; no allocation, formatting or logging. */
                s->cpp_exception_caught = 1;
            }
        }
        __atomic_store_n(&s->state, 2, __ATOMIC_RELEASE);
    }
    __atomic_store_n(&s->forward_ready, 1, __ATOMIC_RELEASE);
    __atomic_sub_fetch(&s->active_calls, 1, __ATOMIC_SEQ_CST);
    return s->original_call;
}
