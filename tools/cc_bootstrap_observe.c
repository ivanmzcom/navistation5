/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "cc_bootstrap_observe.h"
#include <errno.h>
#include <inttypes.h>
#include <stddef.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#include <time.h>
#include <unistd.h>
#include <ps5/kernel.h>

#define ND_OBSERVE_NS UINT64_C(2000000000)
#define ND_USER_END UINT64_C(0x0000800000000000)
static int error_code(void) { return errno ? errno : EIO; }
static int now_ns(uint64_t *out)
{
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0 || t.tv_nsec < 0 || t.tv_nsec >= 1000000000) return -1;
    *out = (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
    return 0;
}
static int exact_pid(pid_t pid, struct timeval *start)
{
    /* Single known PID, no process-list allocation or heap traversal. Unknown
     * kernel record layouts fail closed; no dynamic buffer retry. */
    unsigned char bytes[8192]; size_t size = sizeof(bytes);
    const size_t minimum = offsetof(struct kinfo_proc, ki_comm) + sizeof(((struct kinfo_proc *)0)->ki_comm);
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    errno = 0;
    if (sysctl(mib, 4, bytes, &size, NULL, 0)) return error_code();
    if (size < minimum || size > sizeof(bytes)) return EPROTO;
    int stride; memcpy(&stride, bytes, sizeof(stride));
    if (stride <= 0 || (size_t)stride != size) return EPROTO;
    struct kinfo_proc process = {0};
    memcpy(&process, bytes, size < sizeof(process) ? size : sizeof(process));
    if (process.ki_pid != pid || memcmp(process.ki_comm, "SceShellUI", sizeof("SceShellUI"))) return ESTALE;
    if (process.ki_start.tv_sec <= 0 || process.ki_start.tv_usec < 0 || process.ki_start.tv_usec >= 1000000) return EPROTO;
    *start = process.ki_start;
    return 0;
}
static int same_static(const struct nd_bootstrap_state *a, const struct nd_bootstrap_state *b)
{
    return !memcmp(a, b, offsetof(struct nd_bootstrap_state, state)) &&
        !memcmp(a->cloned_table, b->cloned_table, sizeof(a->cloned_table)) &&
        !memcmp(&a->cxa_begin_catch, &b->cxa_begin_catch, 5 * sizeof(uint64_t));
}
static int state_bounds(const struct nd_bootstrap_state *s, uint64_t mapping, size_t code_bytes)
{
    if (s->state > 2 || s->eh_expected_count > ND_STUB_MAX_FDES || s->message_bytes >= sizeof(s->message)) return 0;
    /* During registration an expectation is filled field by field, so only
     * check complete FDE records after the worker has finished. */
    if (s->state == 2)
        for (uint32_t n = 0; n < s->eh_expected_count; ++n) {
            const struct nd_fde_expectation *e = &s->eh_expected[n];
            if (e->fde < mapping || e->fde >= mapping + code_bytes ||
                e->pc_start < mapping || e->pc_start >= e->pc_end ||
                e->pc_end > mapping + code_bytes) return 0;
        }
    return 1;
}
static const char *describe(const struct nd_bootstrap_observation *r)
{
    const struct nd_bootstrap_state *s = &r->state;
    if (!r->complete) return "observation_failed";
    if (!r->stable) return "changing_snapshot";
    if (r->executor_vtable != s->original_vtable && r->executor_vtable != s->cloned_vtable) return "vtable_unexpected";
    if (!s->state) return r->executor_vtable == s->cloned_vtable ? "pending_armed" : "pending_vtable_original";
    if (s->state == 1) return "entered";
    if (!s->vtable_restored || r->executor_vtable != s->original_vtable || s->restore_conflict) return "vtable_restore_unconfirmed";
    if (!s->identity_accepted) return "identity_rejected";
    if (s->eh_failure || !s->eh_expected_count ||
        s->eh_verified_mask != (UINT32_C(1) << s->eh_expected_count) - 1) return "native_barrier_rejected";
    if (s->cpp_exception_caught || s->exception_type || s->message_bytes) return "native_exception";
    if (!s->evaluation_attempted) return "evaluation_not_attempted";
    return "evaluation_finished_vtable_restored";
}
void nd_bootstrap_observe(pid_t pid, uint64_t mapping, size_t code_bytes,
                          const struct nd_bootstrap_state *expected,
                          struct nd_bootstrap_observation *r)
{
    if (!r) return;
    memset(r, 0, sizeof(*r)); r->attempted = 1; r->status = "observation_failed";
    const pid_t self = getpid();
    uint8_t saved_caps[16], saved_attrs[32], caps[16], attrs[32];
    int caps_attempted = 0, attrs_attempted = 0, previous_valid = 0;
    struct timeval started_before = {0}, started_after = {0};
    struct nd_bootstrap_state previous = {0}; uint64_t previous_vtable = 0;
    uint64_t start = 0, now = 0;
    if (!expected || pid <= 0 || mapping < 0x10000 || mapping > ND_USER_END - ND_STUB_SCRIPT_OFFSET ||
        mapping % ND_STUB_PAGE || !code_bytes || code_bytes > ND_STUB_PAGE ||
        expected->magic != ND_STUB_MAGIC || expected->executor < 0x10000 || expected->executor > ND_USER_END - 8 ||
        kernel_get_fw_version() != UINT32_C(0x13200006)) { r->read_error = EINVAL; return; }
    if (now_ns(&start)) { r->clock_error = error_code(); return; }
    errno = 0;
    if (kernel_get_ucred_caps(self, saved_caps) || kernel_get_ucred_attrs(self, saved_attrs)) {
        r->setup_error = error_code(); return;
    }
    r->scope_saved = 1;
    memcpy(caps, saved_caps, sizeof(caps)); memcpy(attrs, saved_attrs, sizeof(attrs));
    caps[5] = 0x1c; caps[7] = 0x40; caps[15] |= 0x40; attrs[3] |= 0x80;
    caps_attempted = 1; errno = 0;
    if (kernel_set_ucred_caps(self, caps)) { r->setup_error = error_code(); goto restore; }
    attrs_attempted = 1; errno = 0;
    if (kernel_set_ucred_attrs(self, attrs)) { r->setup_error = error_code(); goto restore; }
    r->pid_error = exact_pid(pid, &started_before);
    if (r->pid_error) goto restore;
    r->pid_before = pid;
    r->start_before_sec = (int64_t)started_before.tv_sec; r->start_before_usec = (int64_t)started_before.tv_usec;
    for (uint32_t n = 0; n < 101; ++n) {
        if (now_ns(&now) || now < start) { r->clock_error = error_code(); break; }
        r->elapsed_ns = now - start;
        if (r->elapsed_ns >= ND_OBSERVE_NS) { r->timed_out = 1; break; }
        errno = 0;
        if (kernel_proc_copyout(pid, (intptr_t)(mapping + ND_STUB_STATE_OFFSET), &r->state, sizeof(r->state))) {
            r->read_error = error_code(); break;
        }
        r->bytes_read += sizeof(r->state);
        if (!same_static(&r->state, expected) || !state_bounds(&r->state, mapping, code_bytes)) {
            r->read_error = ESTALE; break;
        }
        errno = 0;
        if (kernel_proc_copyout(pid, (intptr_t)expected->executor, &r->executor_vtable, 8)) {
            r->read_error = error_code(); break;
        }
        r->bytes_read += 8; ++r->samples;
        r->stable = previous_valid && previous_vtable == r->executor_vtable &&
            !memcmp(&previous, &r->state, sizeof(previous));
        if (r->stable && r->state.state == 2 && !r->state.active_calls) break;
        previous = r->state; previous_vtable = r->executor_vtable; previous_valid = 1;
        if (now_ns(&now) || now < start) { r->clock_error = error_code(); break; }
        r->elapsed_ns = now - start;
        if (r->elapsed_ns >= ND_OBSERVE_NS) { r->timed_out = 1; break; }
        const uint64_t remaining = ND_OBSERVE_NS - r->elapsed_ns;
        const struct timespec pause = {.tv_sec = 0, .tv_nsec = (long)(remaining < 20000000 ? remaining : 20000000)};
        errno = 0;
        if (nanosleep(&pause, NULL) && errno != EINTR) { r->clock_error = error_code(); break; }
        if (n == 100) r->timed_out = 1;
    }
    r->pid_error = exact_pid(pid, &started_after);
    if (!r->pid_error) {
        r->start_after_sec = (int64_t)started_after.tv_sec; r->start_after_usec = (int64_t)started_after.tv_usec;
    }
    if (!r->pid_error && (started_after.tv_sec != started_before.tv_sec || started_after.tv_usec != started_before.tv_usec))
        r->pid_error = ESTALE;
    if (!r->pid_error) r->pid_after = pid;
restore:
    if (attrs_attempted) {
        errno = 0; if (kernel_set_ucred_attrs(self, saved_attrs)) r->restore_attrs_error = error_code();
    }
    if (caps_attempted) {
        errno = 0; if (kernel_set_ucred_caps(self, saved_caps)) r->restore_caps_error = error_code();
    }
    errno = 0;
    if (kernel_get_ucred_caps(self, caps)) r->verify_caps_error = error_code();
    else if (memcmp(caps, saved_caps, sizeof(caps))) r->verify_caps_error = EIO;
    errno = 0;
    if (kernel_get_ucred_attrs(self, attrs)) r->verify_attrs_error = error_code();
    else if (memcmp(attrs, saved_attrs, sizeof(attrs))) r->verify_attrs_error = EIO;
    r->credentials_restored = !r->restore_caps_error && !r->restore_attrs_error && !r->verify_caps_error && !r->verify_attrs_error;
    r->complete = r->samples && !r->setup_error && !r->pid_error && !r->read_error && !r->clock_error &&
        r->pid_before == pid && r->pid_after == pid && r->credentials_restored;
    r->status = describe(r);
}
void nd_bootstrap_observation_json(FILE *out, const struct nd_bootstrap_observation *r)
{
    const struct nd_bootstrap_state *s = &r->state;
    fprintf(out, "{\"attempted\":%s,\"complete\":%s,\"status\":\"%s\",\"stable\":%s,\"timedOut\":%s,"
        "\"deadlineMs\":2000,\"samples\":%u,\"bytesRead\":%" PRIu64 ",\"elapsedNs\":%" PRIu64 ","
        "\"pidBefore\":%d,\"pidAfter\":%d,\"pidError\":%d,\"readError\":%d,\"clockError\":%d,"
        "\"startTimeBefore\":{\"sec\":%" PRId64 ",\"usec\":%" PRId64 "},"
        "\"startTimeAfter\":{\"sec\":%" PRId64 ",\"usec\":%" PRId64 "},"
        "\"executorVtable\":\"0x%" PRIx64 "\",\"state\":%u,\"activeWorkers\":%u,\"vtableRestored\":%u,"
        "\"identityAccepted\":%u,\"evaluationAttempted\":%u,\"nativeExceptionType\":%d,\"exceptionMessageBytes\":%u,"
        "\"cppExceptionCaught\":%u,\"ehFailure\":%u,\"ehExpectedCount\":%u,\"ehRegisteredCount\":%u,"
        "\"ehVerifiedMask\":%u,\"forwardReady\":%u,\"credentialsRestored\":%s,\"credentialErrors\":{"
        "\"setup\":%d,\"restoreCaps\":%d,\"restoreAttrs\":%d,\"verifyCaps\":%d,\"verifyAttrs\":%d},"
        "\"notice\":\"Read-only, non-atomic observations. No proof of forwarded-call return or visible UI; exception text omitted.\"}",
        r->attempted?"true":"false",r->complete?"true":"false",r->status?r->status:"not_attempted",
        r->stable?"true":"false",r->timed_out?"true":"false",r->samples,r->bytes_read,r->elapsed_ns,
        r->pid_before,r->pid_after,r->pid_error,r->read_error,r->clock_error,
        r->start_before_sec,r->start_before_usec,r->start_after_sec,r->start_after_usec,r->executor_vtable,
        s->state,s->active_calls,s->vtable_restored,s->identity_accepted,s->evaluation_attempted,s->exception_type,s->message_bytes,
        s->cpp_exception_caught,s->eh_failure,s->eh_expected_count,s->eh_registered_count,s->eh_verified_mask,s->forward_ready,
        r->credentials_restored?"true":"false",r->setup_error,r->restore_caps_error,r->restore_attrs_error,
        r->verify_caps_error,r->verify_attrs_error);
}
