/* Checked ptrace/syscall scope for the CC installer. Own-process privileges. */
#ifndef ND_REMOTE_TRACE_H
#define ND_REMOTE_TRACE_H
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/types.h>
struct nd_trace;
#define ND_TRACE_MAX_INITIALIZED_MAPPING (13U * 16384U)
struct nd_trace *nd_trace_begin(pid_t expected_pid);
int nd_trace_ready(const struct nd_trace *t);
int nd_trace_map(struct nd_trace *t, size_t size, uint64_t *address);
/* Only the exact fresh RW mapping owned by this trace. gettimeofday writes
 * 16 bytes per 4096-byte subpage through the verified remote syscall gate. */
int nd_trace_initialize_mapping(struct nd_trace *t, uint64_t address, size_t size);
int nd_trace_protect(struct nd_trace *t, uint64_t address, size_t size, int prot);
int nd_trace_unmap(struct nd_trace *t, uint64_t address, size_t size);
/* SDK copy helpers. Write requires completed initialization of the owned map;
 * the installer also uses it for its separately guarded executor-vtable slot.
 * Return/errno are preserved; no SDK byte count exists, so complete bytewise
 * readback remains mandatory. Failure can have partially changed memory. */
int nd_trace_write(struct nd_trace *t, uint64_t address, const void *data, size_t size);
int nd_trace_read(struct nd_trace *t, uint64_t address, void *data, size_t size);
/* Irreversible recovery state: never detach or free this trace afterward.
 * Best-effort register/own-credential restoration still runs. The caller must
 * keep its tracer process alive, and can emit nd_trace_json after this call. */
void nd_trace_retain(struct nd_trace *t, const char *reason);
int nd_trace_close(struct nd_trace *t);
void nd_trace_json(FILE *f, const struct nd_trace *t);
/* Destroy only after close succeeded. An unsafe trace relationship is retained. */
void nd_trace_destroy(struct nd_trace *t);
#endif
