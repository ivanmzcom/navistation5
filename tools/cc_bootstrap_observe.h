/* Bounded observation after confirmed detach. No ptrace or target calls. */
#ifndef ND_CC_BOOTSTRAP_OBSERVE_H
#define ND_CC_BOOTSTRAP_OBSERVE_H
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/types.h>
#include "cc_bootstrap_stub.h"
struct nd_bootstrap_observation {
    int attempted, complete, stable, timed_out;
    int pid_before, pid_after, pid_error, read_error, clock_error;
    int scope_saved, setup_error, restore_caps_error, restore_attrs_error;
    int verify_caps_error, verify_attrs_error, credentials_restored;
    uint32_t samples;
    int64_t start_before_sec, start_before_usec, start_after_sec, start_after_usec;
    uint64_t elapsed_ns, bytes_read, executor_vtable;
    const char *status;
    struct nd_bootstrap_state state;
};
/* Only call once caller has detached and restored its own credentials.
 * Fixed 2 s / 101 samples limit, stack storage, exact PID/name/start time,
 * immutable state identity, two consecutive snapshots for stable status.
 * This does not prove the original forwarded call returned or UI appeared. */
void nd_bootstrap_observe(pid_t pid, uint64_t mapping, size_t code_bytes,
                          const struct nd_bootstrap_state *expected,
                          struct nd_bootstrap_observation *result);
/* Error message text is deliberately omitted: it may contain user secrets. */
void nd_bootstrap_observation_json(FILE *out, const struct nd_bootstrap_observation *result);
#endif
