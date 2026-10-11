/* SPDX-License-Identifier: GPL-3.0-or-later
 * Exact-firmware installer with optional live identity discovery. Publication is disabled until the independently
 * reviewed native exception barrier and package both declare readiness.
 * No allocation is released after any attempted executor-vtable publication.
 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
/* SDK ships sha256.h without libmd. Use its already installed static libcrypto
 * primitive API, retaining its supported SHA256 context ABI. No TLS/network. */
#define OPENSSL_API_COMPAT 0x10100000L
#include <openssl/sha.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <ps5/kernel.h>
#include "cc_executor_guard.h"
#include "cc_bootstrap_stub.h"
#include "cc_bootstrap_observe.h"
#include "remote_trace.h"

#ifndef ND_CC_PAYLOAD_HEADER
#define ND_CC_PAYLOAD_HEADER "../build/cc-install-payload.h"
#endif
#include ND_CC_PAYLOAD_HEADER
#ifndef ND_CC_AUTODETECT_IDENTITY
#define ND_CC_AUTODETECT_IDENTITY 0
#endif
#ifndef ND_CC_ENABLE_PUBLICATION
#define ND_CC_ENABLE_PUBLICATION 0
#endif
#if ND_CC_PACKAGE_SCHEMA != 1
#error Unsupported CC package schema
#endif
#if ND_CC_ENABLE_PUBLICATION && !ND_CC_CPP_BARRIER_READY
#error Publication requires the reviewed native exception barrier
#endif
static const volatile unsigned publication_enabled = ND_CC_ENABLE_PUBLICATION;
static const volatile unsigned exception_barrier_ready = ND_CC_CPP_BARRIER_READY;

#define ND_MAX_IMAGE (ND_TRACE_MAX_INITIALIZED_MAPPING - ND_STUB_SCRIPT_OFFSET)
#define ND_MAX_MAPPING ND_TRACE_MAX_INITIALIZED_MAPPING
static const char source_url[] = "navidrome://cc-local-entry";
_Static_assert(sizeof(struct nd_bootstrap_state) < ND_STUB_SOURCE_URL_OFFSET - ND_STUB_STATE_OFFSET, "state/source URL overlap");
_Static_assert(ND_STUB_STATE_OFFSET == 0x4000 && ND_STUB_SCRIPT_OFFSET == 0x8000, "stub fixed layout");

struct file_proof { const char *path, *expected; size_t size, bytes; int accepted, error; char digest[65]; };
struct install_report {
    const char *stage, *failure;
    time_t started, finished;
    pid_t target_pid;
    struct nd_cc_identity before, after;
    struct nd_cc_libc_identity libc_before, libc_after;
    struct nd_bootstrap_observation observation;
    struct file_proof files[3];
    uint64_t mapping, clone, observed_vtable;
    size_t mapping_size, script_mapping_size;
    int allocation, copied, protections, guards_match, native_code_before, native_code_after;
    int publication_attempted, publication_confirmed;
    int rollback_attempted, rollback_confirmed, unmap_attempted, unmapped;
    int close_result, recovery_retained, report_error;
};

static int digest_matches(const void *data, size_t size, const char *expected)
{
    if (strlen(expected) != 64) return 0;
    unsigned char digest[32]; char hex[65]; SHA256_CTX ctx;
    if (!SHA256_Init(&ctx) || !SHA256_Update(&ctx, data, size) || !SHA256_Final(digest, &ctx)) return 0;
    for (size_t i = 0; i < 32; ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    return !strcmp(hex, expected);
}

static int hash_file(struct file_proof *p)
{
    FILE *f = fopen(p->path, "rb");
    if (!f) { p->error = errno ? errno : EIO; return -1; }
    struct stat before, after; unsigned char buffer[16384], digest[32]; SHA256_CTX ctx;
    if (!SHA256_Init(&ctx)) { p->error = EIO; goto done; }
    if (fstat(fileno(f), &before) || !S_ISREG(before.st_mode) || before.st_size != (off_t)p->size) {
        p->error = ESTALE; goto done;
    }
    while (p->bytes < p->size) {
        size_t count = p->size - p->bytes; if (count > sizeof(buffer)) count = sizeof(buffer);
        const size_t n = fread(buffer, 1, count, f);
        if (!n) { p->error = ferror(f) && errno ? errno : EIO; goto done; }
        if (!SHA256_Update(&ctx, buffer, n)) { p->error = EIO; goto done; }
        p->bytes += n;
    }
    if (fgetc(f) != EOF || ferror(f) || fstat(fileno(f), &after) ||
        before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
        before.st_size != after.st_size || before.st_mtime != after.st_mtime) {
        p->error = ESTALE; goto done;
    }
    if (!SHA256_Final(digest, &ctx)) { p->error = EIO; goto done; }
    for (size_t i = 0; i < 32; ++i) snprintf(p->digest + i * 2, 3, "%02x", digest[i]);
    p->accepted = !strcmp(p->digest, p->expected);
    if (!p->accepted) p->error = ESTALE;
done:
    if (fclose(f) && !p->error) p->error = errno ? errno : EIO;
    return p->error ? -1 : 0;
}

static int package_identity(const struct nd_cc_identity *i)
{
    if (!(i->complete && i->stable && i->credentials_restored && i->backend == 1 &&
          i->initial_pid > 0 && i->initial_pid == i->final_pid &&
          i->firmware == ND_CC_EXPECTED_FIRMWARE)) return 0;
#if ND_CC_AUTODETECT_IDENTITY
    /* Full pointer/type/module guard remains authoritative. No wildcard read
     * address: these values were discovered while this exact PID is stopped. */
    return i->native_executor && i->runtime && i->app_instance_id && i->js_thread;
#else
    return i->initial_pid == ND_CC_EXPECTED_PID &&
        i->native_executor == ND_CC_EXPECTED_EXECUTOR && i->runtime == ND_CC_EXPECTED_RUNTIME &&
        i->app_instance_id == ND_CC_EXPECTED_APP_INSTANCE_ID && i->js_thread == ND_CC_EXPECTED_JS_THREAD;
#endif
}
static int same_identity(const struct nd_cc_identity *a, const struct nd_cc_identity *b)
{
    if (!package_identity(a) || !package_identity(b)) return 0;
    if (a->initial_pid != b->initial_pid || a->native_executor != b->native_executor ||
        a->runtime != b->runtime || a->app_instance_id != b->app_instance_id ||
        a->js_thread != b->js_thread) return 0;
    if (a->application != b->application || a->context != b->context || a->data != b->data ||
        a->bridge != b->bridge || a->managed_executor != b->managed_executor ||
        a->native_vtable != b->native_vtable || a->runtime_vtable_candidate != b->runtime_vtable_candidate ||
        strcmp(a->application_name, b->application_name) || strcmp(a->bundle_path, b->bundle_path) ||
        memcmp(a->native_methods, b->native_methods, sizeof(a->native_methods))) return 0;
    for (size_t n = 0; n < 4; ++n)
        if (!a->modules[n].guard_accepted || !b->modules[n].guard_accepted ||
            !a->modules[n].identity_unchanged || !b->modules[n].identity_unchanged ||
            a->modules[n].base != b->modules[n].base || a->modules[n].handle != b->modules[n].handle) return 0;
    return 1;
}
static int write_and_verify(struct nd_trace *t, uint64_t address, const void *data, size_t size)
{
    const unsigned char *src = data; unsigned char copy[4096];
    for (size_t pos = 0; pos < size;) {
        size_t n = size - pos; if (n > sizeof(copy)) n = sizeof(copy);
        if (nd_trace_write(t, address + pos, src + pos, n) ||
            nd_trace_read(t, address + pos, copy, n) || memcmp(copy, src + pos, n)) return -1;
        pos += n;
    }
    return 0;
}
static int native_entry_bytes(struct nd_trace *t, const struct nd_cc_identity *i)
{
    /* Captured native-extensions.manifest.json, code at actual VAs
     * 0x806e3cf10, 0x806e381f0, 0x806e25af0. Relocate only after module guard. */
    static const struct { uint64_t offset; unsigned char bytes[16]; } expected[] = {
        {0x30f10, {0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec}},
        {0x2c1f0, {0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x83,0xec}},
        {0x19af0, {0x48,0x85,0xff,0x0f,0x85,0x17,0x01,0x00,0x00,0xc3,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc}},
    };
    for (size_t n = 0; n < sizeof(expected) / sizeof(expected[0]); ++n) {
        unsigned char raw[16];
        if (nd_trace_read(t, i->modules[3].base + expected[n].offset, raw, sizeof(raw)) ||
            memcmp(raw, expected[n].bytes, sizeof(raw))) return 0;
    }
    return 1;
}
static void identity_json(FILE *f, const struct nd_cc_identity *i)
{
    fprintf(f, "{\"complete\":%s,\"stable\":%s,\"credentialsRestored\":%s,\"pid\":%d,\"finalPid\":%d,"
        "\"stage\":\"%s\",\"failure\":\"%s\",\"executor\":\"0x%" PRIxPTR "\",\"vtable\":\"0x%" PRIxPTR "\","
        "\"runtime\":\"0x%" PRIxPTR "\",\"appInstanceId\":\"0x%" PRIx64 "\",\"backend\":%d,"
        "\"name\":\"%s\",\"bundle\":\"%s\",\"records\":%zu,\"bytesRequested\":%zu,"
        "\"application\":\"0x%" PRIxPTR "\",\"context\":\"0x%" PRIxPTR "\",\"data\":\"0x%" PRIxPTR "\","
        "\"bridge\":\"0x%" PRIxPTR "\",\"managedExecutor\":\"0x%" PRIxPTR "\",\"jsThread\":\"0x%" PRIxPTR "\","
        "\"modules\":[",
        i->complete ? "true" : "false", i->stable ? "true" : "false", i->credentials_restored ? "true" : "false",
        i->initial_pid, i->final_pid, i->stage ? i->stage : "", i->failure ? i->failure : "",
        i->native_executor, i->native_vtable, i->runtime, i->app_instance_id, i->backend,
        i->complete ? i->application_name : "", i->complete ? i->bundle_path : "", i->records, i->bytes_requested,
        i->application, i->context, i->data, i->bridge, i->managed_executor, i->js_thread);
    for (size_t n = 0; n < 4; ++n) {
        const struct nd_cc_guard_module *m = &i->modules[n];
        if (n) fputc(',', f);
        fprintf(f, "{\"name\":\"%s\",\"base\":\"0x%" PRIxPTR "\",\"handle\":%u,\"guardAccepted\":%s,\"identityUnchanged\":%s}",
            m->name ? m->name : "", m->base, m->handle,
            m->guard_accepted ? "true" : "false", m->identity_unchanged ? "true" : "false");
    }
    fputs("]}", f);
}
static void libc_json(FILE *f, const struct nd_cc_libc_identity *i)
{
    fprintf(f, "{\"accepted\":%s,\"failure\":\"%s\",\"base\":\"0x%" PRIxPTR "\",\"handle\":%u,"
        "\"guardAccepted\":%s,\"identityUnchanged\":%s,\"bytesRequested\":%zu,"
        "\"beginCatch\":\"0x%" PRIx64 "\",\"endCatch\":\"0x%" PRIx64 "\",\"personality\":\"0x%" PRIx64 "\","
        "\"addDynamicFde\":\"0x%" PRIx64 "\",\"iterateFdeCache\":\"0x%" PRIx64 "\"}",
        i->accepted?"true":"false",i->failure?i->failure:"",i->module.base,i->module.handle,
        i->module.guard_accepted?"true":"false",i->module.identity_unchanged?"true":"false",i->bytes_requested,
        i->cxa_begin_catch,i->cxa_end_catch,i->personality,i->add_dynamic_fde,i->iterate_fde_cache);
}

int main(void)
{
    static struct install_report r;
    r.stage = "package"; r.started = time(NULL); r.close_result = 0;
    const char *id = ND_CC_PACKAGE_ID;
    if (!*id || strlen(id) > 48) return 3;
    for (const char *p = id; *p; ++p)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '_' || *p == '-')) return 3;
    char report_path[192];
    snprintf(report_path, sizeof(report_path), "/data/navidrome-cc-install-%s-%jd-%d.json", id, (intmax_t)r.started, getpid());
    const int fd = open(report_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return 3;
    FILE *out = fdopen(fd, "w"); if (!out) { close(fd); return 3; }
    struct nd_trace *trace = NULL;
    struct nd_bootstrap_state state = {0};
    if (!publication_enabled || !exception_barrier_ready) {
        r.failure = "publication_disabled_pending_native_exception_barrier"; goto report;
    }
    if (kernel_get_fw_version() != ND_CC_EXPECTED_FIRMWARE || ND_CC_EXPECTED_FIRMWARE != UINT32_C(0x13200006)) {
        r.failure = "firmware_mismatch"; goto report;
    }
    if (!ND_CC_STUB_CODE_BYTES || ND_CC_STUB_CODE_BYTES > ND_STUB_PAGE ||
        ND_CC_STUB_CODE_BYTES > sizeof(nd_cc_stub_image) || sizeof(nd_cc_stub_image) > ND_STUB_SCRIPT_OFFSET ||
        sizeof(nd_cc_hbc_image) < 128 || sizeof(nd_cc_hbc_image) > ND_MAX_IMAGE ||
        !digest_matches(nd_cc_stub_image, sizeof(nd_cc_stub_image), ND_CC_STUB_SHA256) ||
        !digest_matches(nd_cc_hbc_image, sizeof(nd_cc_hbc_image), ND_CC_HBC_SHA256)) {
        r.failure = "package_image_size_or_hash_mismatch"; goto report;
    }
    /* This profile is tied to the captured Hermes bytecode version 89. */
    const unsigned char hbc_prefix[12] = {0xc6,0x1f,0xbc,0x03,0xc1,0x03,0x19,0x1f,0x59,0,0,0};
    uint32_t hbc_file_length = 0;
    memcpy(&hbc_file_length, nd_cc_hbc_image + 32, sizeof(hbc_file_length));
    if (sizeof(nd_cc_hbc_image) < 128 || memcmp(nd_cc_hbc_image, hbc_prefix, sizeof(hbc_prefix)) ||
        hbc_file_length != sizeof(nd_cc_hbc_image)) {
        r.failure = "package_hbc_header_mismatch"; goto report;
    }
    r.script_mapping_size = (sizeof(nd_cc_hbc_image) + ND_STUB_PAGE - 1) & ~(size_t)(ND_STUB_PAGE - 1);
    r.mapping_size = ND_STUB_SCRIPT_OFFSET + r.script_mapping_size;
    if (r.mapping_size > ND_MAX_MAPPING) {
        r.failure = "package_exceeds_mapping_initialization_budget"; goto report;
    }
    r.files[0] = (struct file_proof){.path="/system_ex/rnps/apps/NPXS40003/application.ps.bundle",.size=6494240,
        .expected="952d0615f36a1db9a1fa23f5c5dd190dcb2f53f6b8827cdddc9340d4561114f7"};
    r.files[1] = (struct file_proof){.path="/system_ex/rnps/apps/NPXS40141/base_dll.ps.bundle",.size=1026448,
        .expected="33d67df1d95b834015d2c8ae4750d70cb54656954afda3b4227f147cac7b1b40"};
    r.files[2] = (struct file_proof){.path="/system_ex/rnps/apps/NPXS40141/base_dll.ps.bundle.hbc",.size=839040,
        .expected="e3a29881ce96604cbd06898d16bb93d199a99f4f62711954a823ab1cd5a22210"};
    r.stage = "installed_bundle_hashes_before_attach";
    for (size_t i = 0; i < 3; ++i) if (hash_file(&r.files[i])) { r.failure = "installed_bundle_hash_mismatch"; goto report; }
    r.target_pid = ND_CC_EXPECTED_PID;
#if ND_CC_AUTODETECT_IDENTITY
    r.stage = "discover_shellui";
    if (nd_cc_guard_find_shellui(&r.target_pid)) {
        r.failure = "shellui_discovery_failed"; goto report;
    }
#endif
    r.stage = "trace_attach";
    trace = nd_trace_begin(r.target_pid);
    if (!nd_trace_ready(trace)) { r.failure = "trace_not_ready"; goto cleanup; }
    r.stage = "stopped_identity_guard";
    if (nd_cc_guard_capture(r.target_pid, &r.before) || !package_identity(&r.before)) {
        r.failure = "stopped_identity_differs_from_package"; goto cleanup;
    }
    r.native_code_before = native_entry_bytes(trace, &r.before);
    if (!r.native_code_before) { r.failure = "native_entry_bytes_mismatch"; goto cleanup; }
    r.stage = "stopped_libc_eh_guard";
    if (nd_cc_guard_libc(r.target_pid, &r.libc_before)) { r.failure = "libc_eh_guard_failed"; goto cleanup; }
    r.stage = "allocate_rw";
    if (r.mapping_size > ND_MAX_MAPPING || nd_trace_map(trace, r.mapping_size, &r.mapping)) {
        r.failure = "mapping_not_confirmed"; goto cleanup;
    }
    r.allocation = 1;
    r.stage = "initialize_private_mapping_pages";
    if (nd_trace_initialize_mapping(trace, r.mapping, r.mapping_size)) {
        r.failure = "mapping_initialization_not_confirmed"; goto cleanup;
    }
    const uint64_t state_address = r.mapping + ND_STUB_STATE_OFFSET;
    r.clone = state_address + offsetof(struct nd_bootstrap_state, cloned_table) + 16;
    state.magic = ND_STUB_MAGIC; state.executor = r.before.native_executor; state.runtime = r.before.runtime;
    state.original_vtable = r.before.native_vtable; state.cloned_vtable = r.clone;
    state.original_call = r.before.native_methods[5];
    /* Original native method avoids the exported wrapper's seventh offset arg. */
    state.evaluate = r.before.native_methods[4];
    state.free_string = r.before.modules[3].base + 0x19af0;
    state.script = r.mapping + ND_STUB_SCRIPT_OFFSET; state.script_bytes = sizeof(nd_cc_hbc_image);
    state.source_url = r.mapping + ND_STUB_SOURCE_URL_OFFSET; state.app_instance_id = r.before.app_instance_id;
    state.cxa_begin_catch = r.libc_before.cxa_begin_catch; state.cxa_end_catch = r.libc_before.cxa_end_catch;
    state.personality = r.libc_before.personality; state.add_dynamic_fde = r.libc_before.add_dynamic_fde;
    state.iterate_fde_cache = r.libc_before.iterate_fde_cache;
    state.cloned_table[0] = 0; state.cloned_table[1] = r.before.modules[3].base + 0x953b8;
    memcpy(state.cloned_table + 2, r.before.native_methods, sizeof(r.before.native_methods));
    state.cloned_table[2 + 5] = r.mapping;
    r.stage = "copy_readback";
    if (write_and_verify(trace, r.mapping, nd_cc_stub_image, ND_CC_STUB_CODE_BYTES) ||
        write_and_verify(trace, state_address, &state, sizeof(state)) ||
        write_and_verify(trace, state.source_url, source_url, sizeof(source_url)) ||
        write_and_verify(trace, state.script, nd_cc_hbc_image, sizeof(nd_cc_hbc_image))) {
        r.failure = "image_copy_or_readback_failed"; goto cleanup;
    }
    r.copied = 1; r.stage = "protect_code_rx_script_r";
    if (nd_trace_protect(trace, r.mapping, ND_STUB_PAGE, PROT_READ | PROT_EXEC) ||
        nd_trace_protect(trace, state.script, r.script_mapping_size, PROT_READ)) {
        r.failure = "image_protection_failed"; goto cleanup;
    }
    r.protections = 1; r.stage = "identity_recheck_before_publication";
    if (nd_cc_guard_capture(r.target_pid, &r.after) || !same_identity(&r.before, &r.after)) {
        r.failure = "identity_changed_before_publication"; goto cleanup;
    }
    r.native_code_after = native_entry_bytes(trace, &r.after);
    if (!r.native_code_after) { r.failure = "native_entry_bytes_changed"; goto cleanup; }
    if (nd_cc_guard_libc(r.target_pid, &r.libc_after) ||
        r.libc_after.module.base != r.libc_before.module.base || r.libc_after.module.handle != r.libc_before.module.handle) {
        r.failure = "libc_eh_guard_changed"; goto cleanup;
    }
    r.guards_match = 1;
    if (nd_trace_read(trace, state.executor, &r.observed_vtable, 8) || r.observed_vtable != state.original_vtable) {
        r.failure = "vtable_changed_before_publication"; goto cleanup;
    }
    r.stage = "publish_vtable";
    r.publication_attempted = 1; /* From here allocation is retained forever. */
    if (nd_trace_write(trace, state.executor, &r.clone, 8) ||
        nd_trace_read(trace, state.executor, &r.observed_vtable, 8) || r.observed_vtable != r.clone) {
        r.failure = "publication_write_or_readback_failed"; goto rollback;
    }
    r.publication_confirmed = 1; goto cleanup;
rollback:
    r.rollback_attempted = 1;
    if (!nd_trace_read(trace, state.executor, &r.observed_vtable, 8)) {
        if (r.observed_vtable == state.original_vtable) r.rollback_confirmed = 1;
        else if (r.observed_vtable == r.clone &&
                 !nd_trace_write(trace, state.executor, &state.original_vtable, 8) &&
                 !nd_trace_read(trace, state.executor, &r.observed_vtable, 8) &&
                 r.observed_vtable == state.original_vtable) r.rollback_confirmed = 1;
    }
    if (!r.rollback_confirmed) {
        r.recovery_retained = 1;
        nd_trace_retain(trace, "publication rollback unconfirmed; keep tracer and mapping alive");
        goto report;
    }
cleanup:
    if (trace) {
        if (r.allocation && !r.publication_attempted && nd_trace_ready(trace)) {
            r.unmap_attempted = 1;
            r.unmapped = nd_trace_unmap(trace, r.mapping, r.mapping_size) == 0;
        }
        r.close_result = nd_trace_close(trace);
        if (r.close_result) r.recovery_retained = 1;
    }
    if (r.publication_confirmed && !r.close_result && !r.recovery_retained) {
        r.stage = "postpublication_read_only_observation";
        nd_bootstrap_observe(r.target_pid, r.mapping, ND_CC_STUB_CODE_BYTES, &state, &r.observation);
        if (!r.observation.complete) r.failure = "postpublication_observation_failed";
        else if (!strcmp(r.observation.status, "native_exception")) r.failure = "native_exception_observed";
        else if (!strcmp(r.observation.status, "native_barrier_rejected")) r.failure = "native_barrier_rejected";
        else if (!strcmp(r.observation.status, "vtable_restore_unconfirmed") ||
                 !strcmp(r.observation.status, "vtable_unexpected")) r.failure = "postpublication_vtable_unconfirmed";
    }
report:
    r.finished = time(NULL);
    fprintf(out, "{\"identityMode\":\"%s\",\"detectedPid\":%d,",
        ND_CC_AUTODETECT_IDENTITY ? "automatic-runtime" : "captured-session", r.target_pid);
    fprintf(out, "\"schema\":1,\"packageId\":\"%s\",\"packageSha256\":\"%s\","
        "\"publicationEnabled\":%s,\"exceptionBarrierReady\":%s,\"stage\":\"%s\",\"failure\":\"%s\","
        "\"startedUnix\":%jd,\"finishedUnix\":%jd,\"mapping\":\"0x%" PRIx64 "\",\"mappingBytes\":%zu,"
        "\"cloneVtable\":\"0x%" PRIx64 "\",\"copiedAndReadback\":%s,\"protectionsConfirmed\":%s,"
        "\"guardsMatch\":%s,\"nativeCodeBefore\":%s,\"nativeCodeAfter\":%s,"
        "\"publicationAttempted\":%s,\"publicationConfirmed\":%s,"
        "\"rollbackAttempted\":%s,\"rollbackConfirmed\":%s,\"unmapAttempted\":%s,\"unmapped\":%s,"
        "\"allocationRetained\":%s,\"recoveryRetained\":%s,\"closeResult\":%d,\"installedFiles\":[",
        id, ND_CC_PACKAGE_SHA256, publication_enabled ? "true" : "false", exception_barrier_ready ? "true" : "false",
        r.stage, r.failure ? r.failure : "", (intmax_t)r.started, (intmax_t)r.finished, r.mapping, r.mapping_size, r.clone,
        r.copied ? "true" : "false", r.protections ? "true" : "false", r.guards_match ? "true" : "false",
        r.native_code_before ? "true" : "false", r.native_code_after ? "true" : "false",
        r.publication_attempted ? "true" : "false", r.publication_confirmed ? "true" : "false",
        r.rollback_attempted ? "true" : "false", r.rollback_confirmed ? "true" : "false",
        r.unmap_attempted ? "true" : "false", r.unmapped ? "true" : "false",
        r.allocation && !r.unmapped ? "true" : "false", r.recovery_retained ? "true" : "false", r.close_result);
    for (size_t i = 0; i < 3; ++i) {
        const struct file_proof *p = &r.files[i]; if (i) fputc(',', out);
        fprintf(out, "{\"path\":\"%s\",\"bytes\":%zu,\"sha256\":\"%s\",\"accepted\":%s,\"error\":%d}",
            p->path ? p->path : "", p->bytes, p->digest, p->accepted ? "true" : "false", p->error);
    }
    fputs("],\"identityBefore\":", out); identity_json(out, &r.before);
    fputs(",\"identityAfter\":", out); identity_json(out, &r.after);
    fputs(",\"libcBefore\":", out); libc_json(out, &r.libc_before);
    fputs(",\"libcAfter\":", out); libc_json(out, &r.libc_after);
    fputs(",\"trace\":", out); nd_trace_json(out, trace);
    fputs(",\"observation\":", out); nd_bootstrap_observation_json(out, &r.observation);
    fprintf(out, ",\"status\":\"%s\",\"notice\":\"Installed file hashes are provenance, not a read of live HBC. Publication does not prove JS executed. Published memory remains until ShellUI exits.\"}\n",
        r.recovery_retained ? "operator_recovery_required" : r.observation.attempted ? r.observation.status :
        r.publication_confirmed && !r.close_result ? "published_pending_execution" : "not_published");
    r.report_error = ferror(out); if (fclose(out)) r.report_error = 1;
    if (r.recovery_retained) {
        /* Exiting a still-attached tracer can terminate the tracee. Retain
         * this payload; the report explicitly requires operator recovery. */
        for (;;) sleep(1);
    }
    nd_trace_destroy(trace);
    return r.report_error || r.failure || !r.publication_confirmed ? 2 : 0;
}
