/* Copied core from remote_syscall_probe.c SHA256
 * 4fcb71ae14c38e638c794706656eb2ea9913e345b7ff83ffdb59be3dedc58604. Baseline preserved unchanged.
 * Private to remote_trace.c; no entry point. */
/* SPDX-License-Identifier: GPL-3.0-or-later
 * Independent stage 2: verified getpid syscall gate, getpid, temporary RW
 * mmap/munmap. No target memory writes, injected code, RET, or executable map.
 * Own-process credential helpers mirror ptrace_probe.c intentionally, keeping
 * that runtime-proven baseline unchanged. SDK attribute conventions derive
 * from John Tornblom's SDK v0.43 crt/patch.c, GPL-3.0-or-later.
 */
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <ps5/kernel.h>

#include <signal.h>
#include <sys/mman.h>
#include <machine/reg.h>

#define EXPECTED_FW UINT32_C(0x13200000)
#define DEBUGGER_AUTHID UINT64_C(0x4800000000010003)
#define MAX_PROCESS_BYTES (16U * 1024U * 1024U)
#define WAIT_DEADLINE_NS UINT64_C(1000000000)
#define POLL_NS 5000000L
#define MAX_WAIT_EVENTS 256U
#define MAP_BYTES UINT64_C(0x4000)
#define USER_END UINT64_C(0x0000800000000000)

struct raw_result {
    int64_t rax;
    uint64_t carry;
};
_Static_assert(sizeof(struct raw_result) == 16, "raw syscall return size");
_Static_assert(offsetof(struct raw_result, carry) == 8, "raw syscall return ABI");
extern struct raw_result nd_raw_syscall4(uint64_t number, uint64_t a0, uint64_t a1, uint64_t a2,
                                         uint64_t a3);

struct syscall_result {
    int attempted;
    struct raw_result raw;
    int kernel_error;
    int local_error;
};

struct credential_scope {
    pid_t self;
    uint64_t saved_authid;
    uint8_t saved_caps[16], saved_attrs[32];
    int saved;
    int setup_error;
    int caps_attempted, attrs_attempted, auth_attempted;
    int restore_caps_error, restore_attrs_error, restore_auth_error;
    int verify_caps_error, verify_attrs_error, verify_auth_error;
    int restored;
};

/* Disable the SDK's ordinary startup patch installation. */
int __wrap___patch_init(void) { return 0; }

static int saved_error(void) { return errno ? errno : EIO; }

static void credential_restore(struct credential_scope *scope) {
    if (!scope->saved)
        return;
    /* All restoration operations are attempted despite earlier failures. */
    if (scope->attrs_attempted) {
        errno = 0;
        if (kernel_set_ucred_attrs(scope->self, scope->saved_attrs) != 0)
            scope->restore_attrs_error = saved_error();
    }
    if (scope->caps_attempted) {
        errno = 0;
        if (kernel_set_ucred_caps(scope->self, scope->saved_caps) != 0)
            scope->restore_caps_error = saved_error();
    }
    if (scope->auth_attempted) {
        errno = 0;
        if (kernel_set_ucred_authid(scope->self, scope->saved_authid) != 0)
            scope->restore_auth_error = saved_error();
    }
    uint8_t caps[16], attrs[32];
    errno = 0;
    if (kernel_get_ucred_caps(scope->self, caps) != 0)
        scope->verify_caps_error = saved_error();
    else if (memcmp(caps, scope->saved_caps, sizeof(caps)) != 0)
        scope->verify_caps_error = EIO;
    errno = 0;
    if (kernel_get_ucred_attrs(scope->self, attrs) != 0)
        scope->verify_attrs_error = saved_error();
    else if (memcmp(attrs, scope->saved_attrs, sizeof(attrs)) != 0)
        scope->verify_attrs_error = EIO;
    errno = 0;
    const uint64_t authid = kernel_get_ucred_authid(scope->self);
    if (authid == 0)
        scope->verify_auth_error = saved_error();
    else if (authid != scope->saved_authid)
        scope->verify_auth_error = EIO;
    scope->restored = !scope->restore_caps_error && !scope->restore_attrs_error &&
                      !scope->restore_auth_error && !scope->verify_caps_error &&
                      !scope->verify_attrs_error && !scope->verify_auth_error;
}

static int credential_setup(struct credential_scope *scope) {
    scope->self = getpid();
    errno = 0;
    scope->saved_authid = kernel_get_ucred_authid(scope->self);
    if (!scope->saved_authid) {
        scope->setup_error = saved_error();
        return -1;
    }
    errno = 0;
    if (kernel_get_ucred_caps(scope->self, scope->saved_caps) != 0) {
        scope->setup_error = saved_error();
        return -1;
    }
    errno = 0;
    if (kernel_get_ucred_attrs(scope->self, scope->saved_attrs) != 0) {
        scope->setup_error = saved_error();
        return -1;
    }
    scope->saved = 1;
    uint8_t caps[16], attrs[32];
    memset(caps, 0xff, sizeof(caps));
    memcpy(attrs, scope->saved_attrs, sizeof(attrs));
    attrs[3] |= 0x80;
    scope->caps_attempted = 1;
    errno = 0;
    if (kernel_set_ucred_caps(scope->self, caps) != 0) {
        scope->setup_error = saved_error();
        return -1;
    }
    scope->attrs_attempted = 1;
    errno = 0;
    if (kernel_set_ucred_attrs(scope->self, attrs) != 0) {
        scope->setup_error = saved_error();
        return -1;
    }
    scope->auth_attempted = 1;
    errno = 0;
    if (kernel_set_ucred_authid(scope->self, DEBUGGER_AUTHID) != 0) {
        scope->setup_error = saved_error();
        return -1;
    }
    return 0;
}

static pid_t find_shellui(size_t *returned_bytes, size_t *records_parsed) {
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
    const size_t minimum =
        offsetof(struct kinfo_proc, ki_comm) + sizeof(((struct kinfo_proc *)0)->ki_comm);
    for (unsigned int attempt = 0; attempt < 3; ++attempt) {
        size_t needed = 0;
        if (sysctl(mib, 4, NULL, &needed, NULL, 0) != 0)
            return -1;
        if (!needed || needed > MAX_PROCESS_BYTES) {
            errno = EOVERFLOW;
            return -1;
        }
        size_t capacity = needed + needed / 8;
        if (capacity > MAX_PROCESS_BYTES)
            capacity = MAX_PROCESS_BYTES;
        unsigned char *buffer = malloc(capacity);
        if (!buffer)
            return -1;
        size_t used = capacity;
        if (sysctl(mib, 4, buffer, &used, NULL, 0) != 0) {
            const int error = saved_error();
            free(buffer);
            if (error == ENOMEM && attempt < 2)
                continue;
            errno = error;
            return -1;
        }
        if (used > capacity) {
            free(buffer);
            errno = EOVERFLOW;
            return -1;
        }
        if (returned_bytes)
            *returned_bytes = used;
        if (records_parsed)
            *records_parsed = 0;
        pid_t found = -1;
        int error = ENOENT;
        for (size_t offset = 0; offset < used;) {
            int size = 0;
            if (used - offset < sizeof(size)) {
                error = EPROTO;
                found = -1;
                break;
            }
            memcpy(&size, buffer + offset, sizeof(size));
            if (size <= 0 || (size_t)size < minimum || (size_t)size > used - offset) {
                error = EPROTO;
                found = -1;
                break;
            }
            struct kinfo_proc process;
            memset(&process, 0, sizeof(process));
            memcpy(&process, buffer + offset,
                   (size_t)size < sizeof(process) ? (size_t)size : sizeof(process));
            if (records_parsed)
                ++*records_parsed;
            if (memcmp(process.ki_comm, "SceShellUI", sizeof("SceShellUI")) == 0) {
                if (found > 0 || process.ki_pid <= 0) {
                    error = found > 0 ? EEXIST : EPROTO;
                    found = -1;
                    break;
                }
                found = process.ki_pid;
                error = 0;
            }
            offset += (size_t)size;
        }
        free(buffer);
        errno = error;
        return found;
    }
    errno = ENOMEM;
    return -1;
}

static struct syscall_result capture_call(uint64_t number, uint64_t a0, uint64_t a1, uint64_t a2,
                                          uint64_t a3) {
    struct syscall_result result = {0};
    result.attempted = 1;
    errno = 0;
    result.raw = nd_raw_syscall4(number, a0, a1, a2, a3);
    result.local_error = errno;
    if (result.raw.carry != 0)
        result.kernel_error =
            result.raw.rax > 0 && result.raw.rax <= INT_MAX ? (int)result.raw.rax : -1;
    return result;
}

static int monotonic_ns(uint64_t *result) {
    struct timespec ts;
    errno = 0;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return -1;
    if (ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L ||
        (uint64_t)ts.tv_sec > (UINT64_MAX - (uint64_t)ts.tv_nsec) / UINT64_C(1000000000)) {
        errno = EOVERFLOW;
        return -1;
    }
    *result = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
    return 0;
}

static void write_call(FILE *file, const struct syscall_result *call) {
    fprintf(file,
            "{\"attempted\":%s,\"rax\":\"0x%016" PRIx64 "\",\"signedRax\":%" PRId64
            ",\"carry\":%" PRIu64 ",\"kernelError\":%d,\"localErrno\":%d}",
            call->attempted ? "true" : "false", (uint64_t)call->raw.rax, call->raw.rax,
            call->raw.carry, call->kernel_error, call->local_error);
}

struct wait_event {
    struct syscall_result call;
    int status;
};
struct stop_wait {
    struct wait_event events[MAX_WAIT_EVENTS];
    size_t count;
    int stopped, signal, timed_out, error, exited, unexpected;
    uint64_t elapsed_ns;
};
struct remote_call {
    const char *name;
    uint64_t number, args[6];
    struct syscall_result set, verify_set, step, lwp, get;
    struct stop_wait wait;
    int attempted, prepared_matches, result_valid, remote_carry, remote_error;
    uint64_t remote_rax, remote_rip, remote_flags;
    lwpid_t stopped_lwp;
};
struct restore_attempt {
    struct syscall_result set, get;
    int matches;
    uint32_t observed_trapno, observed_err;
};
struct report {
    uint32_t firmware;
    pid_t probe_pid, target, before_target, final_target;
    uint64_t started_ns;
    int process_error, before_error, final_error, clock_error;
    size_t process_bytes, process_records;
    struct credential_scope credentials;
    struct syscall_result attach, initial_lwp, save_regs, detach;
    struct stop_wait attach_wait;
    int accepted, attach_incongruent, target_stopped, target_exited, detach_ok;
    int detach_signal, detach_skipped_unsafe, operator_recovery_required;
    int unattributed_step_trap;
    lwpid_t lwp;
    struct reg original;
    int regs_saved, regs_dirty, preexisting_tf, regs_restored;
    /* Installer bounds all remote calls, plus one final cleanup attempt. */
    struct restore_attempt restores[ND_MAX_TRACE_CALLS + 1U];
    size_t restore_count;
    intptr_t entry;
    uint32_t resolve_handle;
    int resolve_error[2], gate_read_error, gate_valid;
    uint8_t gate_bytes[12];
    struct remote_call calls[3];
    int getpid_matches, map_valid, map_may_exist, munmap_ok;
    uint64_t mapping;
    struct syscall_result recovery_signal;
    struct stop_wait recovery_wait;
    int recovery_attempted, recovery_ok;
    pid_t recovery_target;
    int recovery_identity_error;
    const char *failure;
};

static int call_ok(const struct syscall_result *call) {
    return call->attempted && call->raw.carry == 0 && call->raw.rax == 0;
}

static struct syscall_result trace_call(int request, pid_t target, void *address, uint64_t data) {
    return capture_call(SYS_ptrace, (uint64_t)request, (uint64_t)target,
                        (uint64_t)(uintptr_t)address, data);
}

static void wait_for_stop(pid_t pid, struct stop_wait *wait, uint64_t started) {
    for (;;) {
        uint64_t now;
        if (monotonic_ns(&now) != 0 || now < started) {
            wait->error = saved_error();
            return;
        }
        wait->elapsed_ns = now - started;
        if (wait->elapsed_ns >= WAIT_DEADLINE_NS) {
            wait->timed_out = 1;
            return;
        }
        if (wait->count == MAX_WAIT_EVENTS) {
            wait->error = EOVERFLOW;
            return;
        }
        struct wait_event *event = &wait->events[wait->count++];
        event->call = capture_call(SYS_wait4, (uint64_t)pid, (uint64_t)(uintptr_t)&event->status,
                                   WNOHANG | WUNTRACED, 0);
        if (event->call.raw.carry) {
            if (event->call.kernel_error != EINTR) {
                wait->error = event->call.kernel_error;
                return;
            }
        } else if (event->call.raw.rax == pid) {
            if (WIFSTOPPED(event->status)) {
                wait->stopped = 1;
                wait->signal = WSTOPSIG(event->status);
            } else {
                wait->exited = WIFEXITED(event->status) || WIFSIGNALED(event->status);
                wait->unexpected = 1;
            }
            return;
        } else if (event->call.raw.rax != 0) {
            wait->unexpected = 1;
            return;
        }
        const struct timespec pause = {.tv_sec = 0, .tv_nsec = POLL_NS};
        errno = 0;
        if (nanosleep(&pause, NULL) != 0 && errno != EINTR) {
            wait->error = saved_error();
            return;
        }
    }
}

/* Trap number/error are kernel trap-frame metadata, not writable user state.
 * Compare every architectural field explicitly; do not compare padding. */
static int same_registers(const struct reg *a, const struct reg *b) {
#define SAME(field)                                                                                \
    if (a->field != b->field)                                                                      \
    return 0
    SAME(r_r15);
    SAME(r_r14);
    SAME(r_r13);
    SAME(r_r12);
    SAME(r_r11);
    SAME(r_r10);
    SAME(r_r9);
    SAME(r_r8);
    SAME(r_rdi);
    SAME(r_rsi);
    SAME(r_rbp);
    SAME(r_rbx);
    SAME(r_rdx);
    SAME(r_rcx);
    SAME(r_rax);
    SAME(r_fs);
    SAME(r_gs);
    SAME(r_es);
    SAME(r_ds);
    SAME(r_rip);
    SAME(r_cs);
    SAME(r_rflags);
    SAME(r_rsp);
    SAME(r_ss);
#undef SAME
    return 1;
}

static int restore_registers(struct report *report) {
    if (!report->regs_dirty)
        return 1;
    if (!report->regs_saved || !report->target_stopped ||
        report->restore_count == sizeof(report->restores) / sizeof(report->restores[0]))
        return 0;
    struct restore_attempt *attempt = &report->restores[report->restore_count++];
    attempt->set = trace_call(PT_SETREGS, report->lwp, &report->original, 0);
    /* Readback is attempted even when SETREGS reports failure. */
    struct reg observed = {0};
    attempt->get = trace_call(PT_GETREGS, report->lwp, &observed, 0);
    if (call_ok(&attempt->get)) {
        attempt->observed_trapno = observed.r_trapno;
        attempt->observed_err = observed.r_err;
        attempt->matches = same_registers(&report->original, &observed);
    }
    if (call_ok(&attempt->set) && call_ok(&attempt->get) && attempt->matches) {
        report->regs_dirty = 0;
        report->regs_restored = 1;
        return 1;
    }
    return 0;
}

static void note_stop(struct report *report, const struct stop_wait *wait) {
    report->target_stopped = wait->stopped;
    if (wait->exited)
        report->target_exited = 1;
    /* SIGTRAP is preserved until both its LWP and RIP prove our step. */
    if (wait->stopped && wait->signal != SIGSTOP)
        report->detach_signal = wait->signal;
}

static void inspect_step_result(struct report *report, struct remote_call *call) {
    struct ptrace_lwpinfo info = {0};
    call->lwp = trace_call(PT_LWPINFO, report->target, &info, sizeof(info));
    if (!call_ok(&call->lwp))
        return;
    call->stopped_lwp = info.pl_lwpid;
    if (call->stopped_lwp != report->lwp)
        return;
    struct reg result = {0};
    call->get = trace_call(PT_GETREGS, report->lwp, &result, 0);
    if (!call_ok(&call->get))
        return;
    call->remote_rax = (uint64_t)result.r_rax;
    call->remote_rip = (uint64_t)result.r_rip;
    call->remote_flags = (uint64_t)result.r_rflags;
    call->remote_carry = !!(result.r_rflags & 1);
    if (call->remote_carry)
        call->remote_error = result.r_rax > 0 && result.r_rax <= INT_MAX ? (int)result.r_rax : -1;
    call->result_valid = (uint64_t)result.r_rip == (uint64_t)report->entry + 0xc;
    if (call->result_valid && report->detach_signal == SIGTRAP)
        report->detach_signal = 0;
}

static int recover_stop(struct report *report) {
    if (report->target_stopped)
        return 1;
    if (report->recovery_attempted || report->target_exited)
        return 0;
    report->recovery_attempted = 1;
    errno = 0;
    report->recovery_target = find_shellui(NULL, NULL);
    if (report->recovery_target != report->target) {
        report->recovery_identity_error = report->recovery_target <= 0 ? saved_error() : ESTALE;
        return 0;
    }
    uint64_t started;
    if (monotonic_ns(&started) != 0) {
        report->recovery_wait.error = saved_error();
        return 0;
    }
    report->recovery_signal = capture_call(SYS_kill, (uint64_t)report->target, SIGSTOP, 0, 0);
    /* A pending trace stop can be recovered even if sending SIGSTOP fails. */
    wait_for_stop(report->target, &report->recovery_wait, started);
    note_stop(report, &report->recovery_wait);
    report->recovery_ok = report->target_stopped;
    return report->recovery_ok;
}

static int execute_remote(struct report *report, struct remote_call *call) {
    if (!report->target_stopped || !report->gate_valid || !report->regs_saved || report->regs_dirty)
        return 0;
    uint64_t started;
    if (monotonic_ns(&started) != 0) {
        call->wait.error = saved_error();
        return 0;
    }
    struct reg modified = report->original;
    modified.r_rip = report->entry + 0xa;
    modified.r_rax = (int64_t)call->number;
    modified.r_rdi = (int64_t)call->args[0];
    modified.r_rsi = (int64_t)call->args[1];
    modified.r_rdx = (int64_t)call->args[2];
    modified.r_r10 = (int64_t)call->args[3];
    modified.r_r8 = (int64_t)call->args[4];
    modified.r_r9 = (int64_t)call->args[5];
    call->attempted = 1;
    report->regs_dirty = 1; /* Before SETREGS, including partial failure. */
    report->regs_restored = 0;
    call->set = trace_call(PT_SETREGS, report->lwp, &modified, 0);
    if (!call_ok(&call->set))
        goto restore;
    struct reg prepared = {0};
    call->verify_set = trace_call(PT_GETREGS, report->lwp, &prepared, 0);
    call->prepared_matches = call_ok(&call->verify_set) && same_registers(&modified, &prepared);
    if (!call->prepared_matches)
        goto restore;
    report->target_stopped = 0; /* A failed/incongruent step is also uncertain. */
    call->step = trace_call(PT_STEP, report->lwp, (void *)(uintptr_t)1, 0);
    if (!call_ok(&call->step))
        goto restore;
    wait_for_stop(report->target, &call->wait, started);
    note_stop(report, &call->wait);
    if (!call->wait.stopped || call->wait.signal != SIGTRAP)
        goto restore;
    /* Single-step must stop just after SYSCALL, before the foreign RET. */
    inspect_step_result(report, call);
restore:
    if (!report->target_stopped && recover_stop(report) &&
        report->recovery_wait.signal == SIGTRAP && call_ok(&call->step))
        inspect_step_result(report, call);
    restore_registers(report);
    /* A trace stop after our attempted step may be synthetic even if its
     * LWP/RIP could not be read or did not match. Never deliver that uncertain
     * SIGTRAP at the restored original RIP. Keep the tracer relationship for
     * explicit recovery, regardless of successful register restoration.
     * An initial attach stop is not covered: it has no attempted PT_STEP. */
    if (call->step.attempted && !call->result_valid &&
        ((call->wait.stopped && call->wait.signal == SIGTRAP) ||
         (report->recovery_wait.stopped && report->recovery_wait.signal == SIGTRAP))) {
        report->unattributed_step_trap = 1;
        report->operator_recovery_required = 1;
        report->detach_skipped_unsafe = 1;
        report->detach_signal = 0;
        report->failure = "unattributed SIGTRAP after attempted step; retain tracer";
    }
    /* Recovery can establish the result for evidence/cleanup; it never
     * authorizes the next stage after the original bounded wait failed. */
    return call->result_valid && !report->regs_dirty && call->wait.stopped &&
           call->wait.signal == SIGTRAP;
}

static int valid_mapping(uint64_t address) {
    return address >= MAP_BYTES && address <= USER_END - MAP_BYTES &&
           (address & (MAP_BYTES - 1)) == 0;
}

static void write_wait(FILE *file, const struct stop_wait *wait) {
    fprintf(file,
            "{\"deadlineMs\":1000,\"pollMs\":5,\"elapsedNs\":%" PRIu64
            ",\"stopped\":%s,\"signal\":%d,\"timeout\":%s,\"error\":%d,"
            "\"exited\":%s,\"unexpected\":%s,\"events\":[",
            wait->elapsed_ns, wait->stopped ? "true" : "false", wait->signal,
            wait->timed_out ? "true" : "false", wait->error, wait->exited ? "true" : "false",
            wait->unexpected ? "true" : "false");
    for (size_t i = 0; i < wait->count; ++i) {
        fprintf(file, "%s{\"status\":%d,\"call\":", i ? "," : "", wait->events[i].status);
        write_call(file, &wait->events[i].call);
        fputc('}', file);
    }
    fputs("]}", file);
}

static void write_remote(FILE *file, const struct remote_call *call) {
    fprintf(file, "{\"name\":\"%s\",\"number\":%" PRIu64 ",\"attempted\":%s,\"args\":[", call->name,
            call->number, call->attempted ? "true" : "false");
    for (unsigned i = 0; i < 6; ++i)
        fprintf(file, "%s\"0x%016" PRIx64 "\"", i ? "," : "", call->args[i]);
    fputs("],\"setRegisters\":", file);
    write_call(file, &call->set);
    fputs(",\"verifySetRegisters\":", file);
    write_call(file, &call->verify_set);
    fprintf(file, ",\"preparedRegistersMatch\":%s", call->prepared_matches ? "true" : "false");
    fputs(",\"step\":", file);
    write_call(file, &call->step);
    fputs(",\"wait\":", file);
    write_wait(file, &call->wait);
    fputs(",\"lwpInfo\":", file);
    write_call(file, &call->lwp);
    fputs(",\"getRegisters\":", file);
    write_call(file, &call->get);
    fprintf(file,
            ",\"stoppedLwp\":%d,\"resultValid\":%s,\"remoteRax\":\"0x%016" PRIx64
            "\",\"remoteRip\":\"0x%016" PRIx64 "\",\"remoteRflags\":\"0x%016" PRIx64
            "\",\"remoteCarry\":%d,\"remoteKernelError\":%d}",
            (int)call->stopped_lwp, call->result_valid ? "true" : "false", call->remote_rax,
            call->remote_rip, call->remote_flags, call->remote_carry, call->remote_error);
}
