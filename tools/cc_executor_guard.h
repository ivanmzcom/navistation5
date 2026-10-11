/* SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef ND_CC_EXECUTOR_GUARD_H
#define ND_CC_EXECUTOR_GUARD_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

struct nd_cc_guard_module {
    const char *name;
    uint32_t handle;
    uintptr_t base;
    int guard_accepted, identity_unchanged;
};

struct nd_cc_identity {
    pid_t requested_pid, initial_pid, final_pid;
    uint32_t firmware;
    int complete, credentials_restored, stable;
    const char *stage, *failure;
    size_t records, bytes_requested, vmmap_bytes, vmmap_records;
    struct nd_cc_guard_module modules[4];
    uintptr_t application, context, data, bridge, managed_executor;
    uintptr_t native_executor, js_thread, native_vtable, runtime;
    uintptr_t runtime_vtable_candidate, native_methods[19];
    uint64_t app_instance_id;
    int32_t backend;
    char application_name[257], bundle_path[257];
};

/* Read-only exact-FW guard, no files created, no target calls or writes.
 * The caller owns process stop/trace scope and must keep it across this call
 * and any subsequent transaction. This function does not stop/resume/attach.
 * Static observation storage: not reentrant. Returns0 only for complete exact
 * CC bundle/name + JSIExecutor identity, stable rereads, final PID/module and
 * credential readback. It does not prove queue affinity or future lifetime.
 */
/* Discover the unique ShellUI PID with the existing bounded process parser.
 * Read-only; verifies exact firmware and restores/readbacks own credentials. */
int nd_cc_guard_find_shellui(pid_t *result);
int nd_cc_guard_capture(pid_t expected_pid, struct nd_cc_identity *result);

struct nd_cc_libc_identity {
    struct nd_cc_guard_module module;
    uint64_t cxa_begin_catch, cxa_end_catch, personality, add_dynamic_fde, iterate_fde_cache;
    size_t bytes_requested;
    const char *failure;
    int accepted;
};
/* Separate exact-FW native EH binding guard. Requires caller's stopped trace
 * and own read credentials. No target calls, resolution by guessing, writes,
 * or capture files. Uses the captured libc handle/base/SELF/code profile. */
int nd_cc_guard_libc(pid_t expected_pid, struct nd_cc_libc_identity *result);
struct nd_cc_feature0_identity {
    struct nd_cc_guard_module module;
    uint64_t setter, resolved, get_service, get_info;
    uint32_t entry_guard_mask;
    int read_error;
    const char *failure;
    int accepted;
};
int nd_cc_guard_feature0(pid_t pid, struct nd_cc_feature0_identity *result);
#endif
