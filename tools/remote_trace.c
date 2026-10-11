/* SPDX-License-Identifier: GPL-3.0-or-later */
#define ND_MAX_TRACE_CALLS 64U
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-function"
#include "remote_trace_core.inc"
#pragma clang diagnostic pop
#include "remote_trace.h"
#include <sys/time.h>

#define ND_MAX_MAPPING (1024U * 1024U)
#define ND_MAX_TRACE_IO 512U
#define ND_TOUCH_STRIDE 4096U
#define ND_MAX_TOUCHES (ND_TRACE_MAX_INITIALIZED_MAPPING / ND_TOUCH_STRIDE)
_Static_assert(SYS_gettimeofday == 116, "profiled gettimeofday syscall");
_Static_assert(sizeof(struct timeval) == 16, "target timeval ABI");
_Static_assert(offsetof(struct timeval, tv_sec) == 0, "target timeval seconds ABI");
_Static_assert(offsetof(struct timeval, tv_usec) == 8, "target timeval microseconds ABI");
_Static_assert(ND_MAX_TOUCHES + 8U <= ND_MAX_TRACE_CALLS, "initialization and cleanup budget");
struct trace_io {
    uint64_t address;
    size_t requested;
    int writing, result, local_error, error, success;
};
struct nd_trace {
    struct report r;
    struct remote_call operations[ND_MAX_TRACE_CALLS];
    struct trace_io io[ND_MAX_TRACE_IO];
    size_t operation_count, io_count, bytes_written, bytes_read;
    size_t bytes_write_completed, bytes_read_attempted, io_rejected;
    uint64_t owned_mapping;
    size_t owned_size, initialized_pages;
    int initialization_attempted, initialization_complete;
    int ready, closed, retained, close_result;
};

struct nd_trace *nd_trace_begin(pid_t expected_pid) {
    struct nd_trace *t = calloc(1, sizeof(*t));
    if (!t)
        return NULL;
    struct report *r = &t->r;
    r->target = r->before_target = r->final_target = -1;
    r->probe_pid = getpid();
    r->firmware = kernel_get_fw_version();
    if (monotonic_ns(&r->started_ns)) {
        r->failure = "clock failed";
        return t;
    }
    if (r->firmware != UINT32_C(0x13200006) || expected_pid <= 0) {
        r->failure = "unsupported firmware or missing expected PID";
        return t;
    }
    if (credential_setup(&r->credentials)) {
        r->failure = "credential setup failed";
        return t;
    }
    r->target = find_shellui(&r->process_bytes, &r->process_records);
    r->before_target = find_shellui(NULL, NULL);
    if (r->target != expected_pid || r->before_target != expected_pid) {
        r->failure = "ShellUI identity changed before attach";
        return t;
    }
    uint64_t started;
    if (monotonic_ns(&started)) {
        r->failure = "attach clock failed";
        return t;
    }
    r->attach = trace_call(PT_ATTACH, r->target, NULL, 0);
    r->accepted = call_ok(&r->attach);
    if (!r->accepted) {
        r->failure = "attach rejected";
        return t;
    }
    wait_for_stop(r->target, &r->attach_wait, started);
    note_stop(r, &r->attach_wait);
    if (!r->target_stopped || r->attach_wait.signal != SIGSTOP) {
        r->failure = "attach stop not confirmed";
        return t;
    }
    struct ptrace_lwpinfo info = {0};
    r->initial_lwp = trace_call(PT_LWPINFO, r->target, &info, sizeof(info));
    if (!call_ok(&r->initial_lwp) || info.pl_lwpid <= 0) {
        r->failure = "initial LWP unavailable";
        return t;
    }
    r->lwp = info.pl_lwpid;
    r->save_regs = trace_call(PT_GETREGS, r->lwp, &r->original, 0);
    if (!call_ok(&r->save_regs)) {
        r->failure = "register save failed";
        return t;
    }
    r->regs_saved = 1;
    r->preexisting_tf = !!(r->original.r_rflags & 0x100);
    if (r->preexisting_tf) {
        r->failure = "preexisting single-step flag";
        return t;
    }
    const uint32_t handles[2] = {1, 0x2001};
    for (unsigned i = 0; i < 2 && r->entry <= 0; ++i) {
        errno = 0;
        r->entry = kernel_dynlib_resolve(r->target, handles[i], "HoLVWNanBBc");
        r->resolve_error[i] = r->entry > 0 ? 0 : saved_error();
        if (r->entry > 0)
            r->resolve_handle = handles[i];
    }
    if (r->entry <= 0 || (uint64_t)r->entry > USER_END - sizeof(r->gate_bytes) ||
        kernel_proc_copyout(r->target, r->entry, r->gate_bytes, sizeof(r->gate_bytes))) {
        r->failure = "syscall gate unavailable";
        return t;
    }
    const uint8_t expected[12] = {0x48, 0xc7, 0xc0, 0x14, 0, 0, 0, 0x49, 0x89, 0xca, 0x0f, 0x05};
    r->gate_valid = memcmp(r->gate_bytes, expected, sizeof(expected)) == 0;
    if (!r->gate_valid) {
        r->failure = "syscall gate bytes changed";
        return t;
    }
    struct remote_call *c = &t->operations[t->operation_count++];
    c->name = "getpid";
    c->number = SYS_getpid;
    if (!execute_remote(r, c) || c->remote_carry || c->remote_rax != (uint64_t)r->target) {
        if (!r->failure)
            r->failure = "remote getpid not confirmed";
        return t;
    }
    r->getpid_matches = 1;
    t->ready = 1;
    return t;
}

int nd_trace_ready(const struct nd_trace *t) {
    return t && t->ready && !t->closed && !t->retained && !t->r.operator_recovery_required &&
           t->r.target_stopped && !t->r.regs_dirty;
}

static struct remote_call *operation(struct nd_trace *t, const char *name, uint64_t number) {
    if (!nd_trace_ready(t) || t->operation_count >= ND_MAX_TRACE_CALLS)
        return NULL;
    struct remote_call *c = &t->operations[t->operation_count++];
    c->name = name;
    c->number = number;
    return c;
}
static int range_ok(uint64_t address, size_t size) {
    return address >= MAP_BYTES && size && size <= ND_MAX_MAPPING && address <= USER_END - size;
}
static int run(struct nd_trace *t, struct remote_call *c) {
    if (!c)
        return -1;
    if (!execute_remote(&t->r, c)) {
        t->ready = 0;
        if (!t->r.failure)
            t->r.failure = "remote operation not confirmed";
        return -1;
    }
    /* A proven syscall error still leaves a stopped, restored tracee. Allow
     * rollback of earlier unpublished mappings in that case. */
    if (c->remote_carry) {
        t->r.failure = "remote syscall returned an error";
        return -1;
    }
    return 0;
}
int nd_trace_map(struct nd_trace *t, size_t size, uint64_t *address) {
    if (!t || t->owned_mapping || !address || !size || size > ND_TRACE_MAX_INITIALIZED_MAPPING ||
        size % MAP_BYTES)
        return -1;
    *address = 0;
    struct remote_call *c = operation(t, "mmap-rw", SYS_mmap);
    if (!c)
        return -1;
    c->args[1] = size;
    c->args[2] = PROT_READ | PROT_WRITE;
    c->args[3] = MAP_PRIVATE | MAP_ANONYMOUS;
    c->args[4] = UINT64_MAX;
    if (run(t, c) || !range_ok(c->remote_rax, size) || c->remote_rax % MAP_BYTES)
        return -1;
    *address = c->remote_rax;
    t->owned_mapping = *address;
    t->owned_size = size;
    return 0;
}
int nd_trace_initialize_mapping(struct nd_trace *t, uint64_t address, size_t size) {
    if (!nd_trace_ready(t) || t->initialization_attempted || address != t->owned_mapping ||
        size != t->owned_size || !size || size > ND_TRACE_MAX_INITIALIZED_MAPPING ||
        size % ND_TOUCH_STRIDE ||
        t->operation_count + size / ND_TOUCH_STRIDE + 4U > ND_MAX_TRACE_CALLS) {
        errno = EINVAL;
        return -1;
    }
    t->initialization_attempted = 1;
    for (size_t offset = 0; offset < size; offset += ND_TOUCH_STRIDE) {
        struct remote_call *c =
            operation(t, "gettimeofday-initialize-private-page", SYS_gettimeofday);
        if (!c)
            return -1;
        c->args[0] = address + offset; /* timezone=NULL; never touch existing objects. */
        if (run(t, c) || c->remote_rax != 0) {
            if (!t->r.failure)
                t->r.failure = "mapping initialization syscall failed";
            return -1;
        }
        struct timeval value = {0};
        if (nd_trace_read(t, address + offset, &value, sizeof(value)) || value.tv_sec <= 0 ||
            value.tv_usec < 0 || value.tv_usec >= 1000000) {
            if (!t->r.failure)
                t->r.failure = "mapping initialization readback invalid";
            return -1;
        }
        ++t->initialized_pages;
    }
    t->initialization_complete = 1;
    return 0;
}
int nd_trace_protect(struct nd_trace *t, uint64_t address, size_t size, int prot) {
    if (!range_ok(address, size) || address % MAP_BYTES || size % MAP_BYTES ||
        (prot != PROT_READ && prot != (PROT_READ | PROT_EXEC)))
        return -1;
    struct remote_call *c = operation(t, "mprotect", SYS_mprotect);
    if (!c)
        return -1;
    c->args[0] = address;
    c->args[1] = size;
    c->args[2] = (uint64_t)prot;
    return run(t, c) || c->remote_rax != 0 ? -1 : 0;
}
int nd_trace_unmap(struct nd_trace *t, uint64_t address, size_t size) {
    if (!range_ok(address, size) || address % MAP_BYTES || size % MAP_BYTES)
        return -1;
    struct remote_call *c = operation(t, "munmap-unpublished", SYS_munmap);
    if (!c)
        return -1;
    c->args[0] = address;
    c->args[1] = size;
    if (run(t, c) || c->remote_rax != 0)
        return -1;
    if (address == t->owned_mapping && size == t->owned_size)
        t->owned_mapping = 0;
    return 0;
}
static int memory_io(struct nd_trace *t, uint64_t address, void *data, size_t size, int writing) {
    if (!nd_trace_ready(t) || !data || !range_ok(address, size) ||
        (writing && (!t->owned_mapping || !t->initialization_complete))) {
        if (t)
            ++t->io_rejected;
        errno = EINVAL;
        return -1;
    }
    if (t->io_count == ND_MAX_TRACE_IO) {
        ++t->io_rejected;
        if (!t->r.failure)
            t->r.failure = "memory I/O evidence capacity exhausted";
        errno = ENOSPC;
        return -1;
    }
    struct trace_io *io = &t->io[t->io_count++];
    io->address = address;
    io->requested = size;
    io->writing = writing;
    if (writing)
        t->bytes_written += size;
    else
        t->bytes_read_attempted += size;
    /* Fresh mapping writes are permitted only after normal kernel-to-user
     * gettimeofday writes materialized every 4-KiB subpage. Existing executor
     * publication/rollback remains the caller's guarded aligned 8-byte write. */
    errno = 0;
    io->result = writing ? kernel_proc_copyin(t->r.target, data, (intptr_t)address, size)
                         : kernel_proc_copyout(t->r.target, (intptr_t)address, data, size);
    io->local_error = errno;
    io->success = io->result == 0;
    if (io->success) {
        if (writing)
            t->bytes_write_completed += size;
        else
            t->bytes_read += size;
        return 0;
    }
    io->error = io->local_error > 0 ? io->local_error : EIO;
    if (!t->r.failure)
        t->r.failure = writing ? "kernel_proc_copyin failed" : "kernel_proc_copyout failed";
    /* Failed/partial I/O does not imply that the tracee resumed. Keep the
     * stopped scope available for the caller's existing rollback/cleanup. */
    errno = io->error;
    return -1;
}
int nd_trace_read(struct nd_trace *t, uint64_t address, void *data, size_t size) {
    return memory_io(t, address, data, size, 0);
}
int nd_trace_write(struct nd_trace *t, uint64_t address, const void *data, size_t size) {
    return memory_io(t, address, (void *)data, size, 1);
}

void nd_trace_retain(struct nd_trace *t, const char *reason) {
    if (!t || t->retained)
        return;
    struct report *r = &t->r;
    /* Set the latch before cleanup: no later close can enter PT_DETACH. */
    t->ready = 0;
    t->retained = 1;
    t->close_result = -1;
    r->detach_skipped_unsafe = 1;
    r->operator_recovery_required = 1;
    r->failure = reason ? reason : "caller requires tracer retention";
    if (!t->closed) {
        if (r->regs_dirty) {
            if (!r->target_stopped)
                recover_stop(r);
            restore_registers(r);
        }
        r->final_target = find_shellui(NULL, NULL);
        credential_restore(&r->credentials);
        t->closed = 1;
    }
}

int nd_trace_close(struct nd_trace *t) {
    if (!t)
        return -1;
    struct report *r = &t->r;
    if (t->retained)
        return -1;
    if (r->operator_recovery_required) {
        nd_trace_retain(t, r->failure);
        return -1;
    }
    if (t->closed)
        return t->close_result;
    t->ready = 0;
    if (r->regs_dirty) {
        if (!r->target_stopped)
            recover_stop(r);
        restore_registers(r);
    }
    if (r->accepted) {
        if (r->regs_dirty) {
            r->detach_skipped_unsafe = 1;
            r->operator_recovery_required = 1;
            r->failure = "registers not restored; tracer must remain alive";
        } else {
            r->detach = trace_call(PT_DETACH, r->target, NULL, (uint64_t)r->detach_signal);
            r->detach_ok = call_ok(&r->detach);
            if (r->detach_ok)
                r->target_stopped = 0;
            else {
                r->operator_recovery_required = 1;
                r->failure = "detach unconfirmed; tracer must remain alive";
            }
        }
    }
    r->final_target = find_shellui(NULL, NULL);
    credential_restore(&r->credentials);
    t->closed = 1;
    const int identity_changed = r->target > 0 && r->final_target != r->target;
    if (identity_changed && !r->failure)
        r->failure = "ShellUI identity changed during trace scope";
    t->close_result = r->operator_recovery_required ||
                              (r->credentials.saved && !r->credentials.restored) || identity_changed
                          ? -1
                          : 0;
    return t->close_result;
}
void nd_trace_json(FILE *f, const struct nd_trace *t) {
    if (!t) {
        fputs("null", f);
        return;
    }
    const struct report *r = &t->r;
    fprintf(
        f,
        "{\"pid\":%d,\"finalPid\":%d,\"firmware\":\"0x%08x\",\"failure\":\"%s\","
        "\"ready\":%s,\"closed\":%s,\"retained\":%s,\"targetStopped\":%s,\"lwp\":%d,\"gate\":\"0x%"
        "llx\","
        "\"registersRestored\":%s,\"registersDirty\":%s,\"detachOk\":%s,\"detachSignal\":%d,"
        "\"operatorRecoveryRequired\":%s,\"credentialsRestored\":%s,\"bytesWriteAttempted\":%zu,"
        "\"bytesRead\":%zu,\"attach\":",
        r->target, r->final_target, r->firmware, r->failure ? r->failure : "",
        t->ready ? "true" : "false", t->closed ? "true" : "false", t->retained ? "true" : "false",
        r->target_stopped ? "true" : "false", r->lwp, (unsigned long long)r->entry,
        r->regs_restored ? "true" : "false", r->regs_dirty ? "true" : "false",
        r->detach_ok ? "true" : "false", r->detach_signal,
        r->operator_recovery_required ? "true" : "false",
        r->credentials.restored ? "true" : "false", t->bytes_written, t->bytes_read);
    write_call(f, &r->attach);
    fputs(",\"attachWait\":", f);
    write_wait(f, &r->attach_wait);
    fputs(",\"detach\":", f);
    write_call(f, &r->detach);
    fprintf(f,
            ",\"detachSkippedUnsafe\":%s,\"unattributedStepTrap\":%s,\"capabilityMode\":\"fullcaps_"
            "ff_debugger_authid_4800000000010003\","
            "\"credentialScope\":{\"saved\":%s,\"setupError\":%d,\"restoreCapsError\":%d,"
            "\"restoreAttrsError\":%d,"
            "\"restoreAuthError\":%d,\"verifyCapsError\":%d,\"verifyAttrsError\":%d,"
            "\"verifyAuthError\":%d},"
            "\"registerRestores\":[",
            r->detach_skipped_unsafe ? "true" : "false",
            r->unattributed_step_trap ? "true" : "false", r->credentials.saved ? "true" : "false",
            r->credentials.setup_error, r->credentials.restore_caps_error,
            r->credentials.restore_attrs_error, r->credentials.restore_auth_error,
            r->credentials.verify_caps_error, r->credentials.verify_attrs_error,
            r->credentials.verify_auth_error);
    for (size_t i = 0; i < r->restore_count; ++i) {
        if (i)
            fputc(',', f);
        fputs("{\"set\":", f);
        write_call(f, &r->restores[i].set);
        fputs(",\"readback\":", f);
        write_call(f, &r->restores[i].get);
        fprintf(f, ",\"matches\":%s}", r->restores[i].matches ? "true" : "false");
    }
    fprintf(f, "],\"recoveryAttempted\":%s,\"recoveryOk\":%s,\"recoverySignal\":",
            r->recovery_attempted ? "true" : "false", r->recovery_ok ? "true" : "false");
    write_call(f, &r->recovery_signal);
    fputs(",\"recoveryWait\":", f);
    write_wait(f, &r->recovery_wait);
    fputs(",\"operations\":[", f);
    for (size_t i = 0; i < t->operation_count; ++i) {
        if (i)
            fputc(',', f);
        write_remote(f, &t->operations[i]);
    }
    fprintf(f,
            "],\"bytesWriteReportedSuccess\":%zu,\"bytesReadAttempted\":%zu,"
            "\"ioRejected\":%zu,\"mappingInitialization\":{\"attempted\":%s,\"complete\":%s,"
            "\"mappingBytes\":%zu,\"stride\":%u,\"initializedPages\":%zu,\"maximumPages\":%u},"
            "\"memoryIO\":[",
            t->bytes_write_completed, t->bytes_read_attempted, t->io_rejected,
            t->initialization_attempted ? "true" : "false",
            t->initialization_complete ? "true" : "false", t->owned_size, ND_TOUCH_STRIDE,
            t->initialized_pages, ND_MAX_TOUCHES);
    for (size_t i = 0; i < t->io_count; ++i) {
        const struct trace_io *io = &t->io[i];
        if (i)
            fputc(',', f);
        fprintf(f,
                "{\"backend\":\"%s\",\"operation\":\"%s\",\"address\":\"0x%llx\","
                "\"bytesRequested\":%zu,\"bytesCompleted\":null,\"lengthSource\":\"SDK status "
                "only; no transfer count\","
                "\"bytesReportedSuccess\":%zu,\"success\":%s,\"result\":%d,\"localErrno\":%d,"
                "\"effectiveErrno\":%d}",
                io->writing ? "kernel_proc_copyin" : "kernel_proc_copyout",
                io->writing ? "write" : "read", (unsigned long long)io->address, io->requested,
                io->success ? io->requested : 0, io->success ? "true" : "false", io->result,
                io->local_error, io->error);
    }
    fputs("]}", f);
}
void nd_trace_destroy(struct nd_trace *t) {
    if (t && t->closed && !t->retained && !t->r.operator_recovery_required)
        free(t);
}
