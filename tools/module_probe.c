/* SPDX-License-Identifier: GPL-3.0-or-later
 * Read-only inspection of named modules in the live ShellUI process.
 * Uses the PS5 Payload SDK APIs; it does not attach or inject into ShellUI.
 */
#include <errno.h>
#include <elf.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#include <unistd.h>

#include <ps5/kernel.h>

#ifdef ND_UI_BRIDGE_EXPORTS
#if !defined(ND_RESOLVE_EXPORTS) || defined(ND_DUMP_MODULES) || defined(ND_RUNTIME_MODULES) || defined(ND_MEDIAFW_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES)
#error UI bridge exports require the separate read-only export variant
#endif
#ifndef ND_READER_SOURCE_SHA256
#error UI bridge exports require their build source hash
#endif
#define ND_CAPTURE_PROFILE "ui-bridge-exports-1320-v2"
#endif
#if (defined(ND_RUNTIME_MODULES) + defined(ND_MEDIAFW_MODULES) + defined(ND_UI_BRIDGE_MODULES) + defined(ND_VSH_COMMON_MODULES)) > 1
#error Select one fixed module profile
#endif
#if defined(ND_RUNTIME_MODULES) || defined(ND_MEDIAFW_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES)
#if !defined(ND_DUMP_MODULES) || defined(ND_RESOLVE_EXPORTS)
#error Fixed profiles require the read-only dump variant
#endif
#ifndef ND_READER_SOURCE_SHA256
#error Fixed capture requires its build source hash
#endif
#ifdef ND_RUNTIME_MODULES
#define ND_CAPTURE_PROFILE "rnps-runtime-1320-v1"
#elif defined(ND_VSH_COMMON_MODULES)
#define ND_CAPTURE_PROFILE "vsh-common-1320-v1"
#elif defined(ND_UI_BRIDGE_MODULES)
#define ND_CAPTURE_PROFILE "ui-bridge-1320-v1"
#else
#define ND_CAPTURE_PROFILE "mediafw-1320-v1"
#endif
#endif
#if defined(ND_DUMP_MODULES) && defined(ND_RESOLVE_EXPORTS)
#error Select one diagnostic variant
#endif
#if defined(ND_DUMP_MODULES) || defined(ND_RESOLVE_EXPORTS)
#define ND_MODULE_LAYOUT
#endif

#ifdef ND_UI_BRIDGE_EXPORTS
#define REPORT_PATH "/data/navidrome-ui-bridge-exports-14.json"
#define REPORT_SCHEMA 5
#elif defined(ND_RESOLVE_EXPORTS)
#define REPORT_PATH "/data/navidrome-module-exports.json"
#define REPORT_SCHEMA 5
#elif defined(ND_VSH_COMMON_MODULES)
#define REPORT_PATH "/data/navidrome-vsh-common-module-dump.json"
#define REPORT_SCHEMA 4
#elif defined(ND_RUNTIME_MODULES)
#define REPORT_PATH "/data/navidrome-runtime-module-dump.json"
#define REPORT_SCHEMA 4
#elif defined(ND_MEDIAFW_MODULES)
#define REPORT_PATH "/data/navidrome-mediafw-module-dump.json"
#define REPORT_SCHEMA 4
#elif defined(ND_UI_BRIDGE_MODULES)
#define REPORT_PATH "/data/navidrome-ui-bridge-module-dump.json"
#define REPORT_SCHEMA 4
#elif defined(ND_DUMP_MODULES)
#define REPORT_PATH "/data/navidrome-module-dump.json"
#define REPORT_SCHEMA 4
#else
#define REPORT_PATH "/data/navidrome-module-probe.json"
#define REPORT_SCHEMA 3
#endif
#ifdef ND_UI_BRIDGE_EXPORTS
#define PROCESS_CAPTURE_PATH "/data/navidrome-ui-bridge-exports-14-proc-records.bin"
#elif defined(ND_VSH_COMMON_MODULES)
#define PROCESS_CAPTURE_PATH "/data/navidrome-vsh-common-proc-records.bin"
#elif defined(ND_RUNTIME_MODULES)
#define PROCESS_CAPTURE_PATH "/data/navidrome-runtime-proc-records.bin"
#elif defined(ND_MEDIAFW_MODULES)
#define PROCESS_CAPTURE_PATH "/data/navidrome-mediafw-proc-records.bin"
#elif defined(ND_UI_BRIDGE_MODULES)
#define PROCESS_CAPTURE_PATH "/data/navidrome-ui-bridge-proc-records.bin"
#else
#define PROCESS_CAPTURE_PATH "/data/navidrome-proc-records.bin"
#endif
#define EXPECTED_FW UINT32_C(0x13200000)
#define MAX_PROCESS_BYTES (16U * 1024U * 1024U)
#define HEADER_BYTES 64U
#define SELF_HEADER_BYTES 4096U

#ifdef ND_MODULE_LAYOUT
#define MAX_PROGRAM_HEADERS 128U
#define MAX_MODULE_BYTES (32U * 1024U * 1024U)
#define USER_VADDR_END UINT64_C(0x0000800000000000)
struct segment_result {
    unsigned int index;
    Elf64_Phdr program_header;
    uintptr_t address;
    char path[96];
    uint64_t bytes_read;
    uint64_t bytes_written;
    uint64_t failure_offset;
    int read_error;
    int write_error;
    int complete;
};
#endif

#ifdef ND_RESOLVE_EXPORTS
#define MAX_EXPORTS 128U
#define EXPORT_SAMPLE_BYTES 16U
struct export_request {
    const char *import_name;
    const char *member_name;
    const char *member_token;
};
struct export_result {
    const struct export_request *request;
    intptr_t address;
    int resolve_error;
    int sample_allowed;
    unsigned int segment_index;
    uint32_t segment_flags;
    int read_attempted;
    int read_result;
    int read_error;
    size_t bytes_read;
    unsigned char sample[EXPORT_SAMPLE_BYTES];
};
/* Exact ImplMap import names captured in FW 13.20; aliases retain the
 * managed member alongside the real entrypoint. Source: rea-managed-2.json. */
static const struct export_request native_exports[] = {
#ifdef ND_UI_BRIDGE_EXPORTS
    /* Exact PUI ImplMap names; DLL SHA256 934a897a3be3a1da63af3abfcb22a2f882279c08c0c2437d9711609e84dc9eae. */
    {"JSExecutorRunLoopIterateCurrentRunLoop", "JSExecutorRunLoopIterateCurrentRunLoop", "0x06001234"},
    {"JSExecutorCreate", "JSExecutorCreate", "0x06001236"},
    {"JSExecutorDelete", "JSExecutorDelete", "0x06001237"},
    {"JSExecutorSetContextName", "JSExecutorSetContextName", "0x06001238"},
    {"JSExecutorEvaluateScript", "JSExecutorEvaluateScript", "0x0600123b"},
    {"JSExecutorCallFunctionReturnFlushedQueue", "JSExecutorCallFunctionReturnFlushedQueue", "0x06001240"},
    {"JSExecutorInvokeCallbackAndReturnFlushedQueue", "JSExecutorInvokeCallbackAndReturnFlushedQueue", "0x06001241"},
    {"JSExecutorFlushedQueue", "JSExecutorFlushedQueue", "0x06001242"},
    {"JSExecutorCallGlobal", "JSExecutorCallGlobal", "0x06001245"},
    {"_sceRnpsMessageQueueThreadCreate", "_sceRnpsMessageQueueThreadCreate", "0x06001a26"},
    {"_sceRnpsMessageQueueThreadRun", "_sceRnpsMessageQueueThreadRun", "0x06001a28"},
    {"_sceRnpsMessageQueueThreadRegisterCallbacks", "_sceRnpsMessageQueueThreadRegisterCallbacks", "0x06001a2a"},
    {"JSCExecutorCopyToJSCStr", "JSCExecutorCopyToJSCStr", "0x0600129c"},
    {"JSCExecutorFreeJSCStr", "JSCExecutorFreeJSCStr", "0x0600129d"},
#else
    {"SendMessageSyncWebMusicCore", "SendMessageSyncWebMusicCore", "0x06000019"},
    {"RegisterNotifyMessageWebMusicCore", "RegisterNotifyMessageWebMusicCore", "0x0600001a"},
    {"UnregisterMessageWebMusicCore", "UnregisterMessageWebMusicCore", "0x0600001b"},
    {"ForwardMediaEventWebMusicCore", "ForwardMediaEventWebMusicCore", "0x0600001c"},
    {"SendMessageSyncWebMusicCoreMessage", "SendMessageSyncWebMusicCoreMessage", "0x06000037"},
    {"RegisterNotifyWebMusicCoreMessage", "RegisterNotifyWebMusicCoreMessage", "0x06000038"},
    {"UnregisterWebMusicCoreMessage", "UnregisterWebMusicCoreMessage", "0x06000039"},
    {"SendMessageSync", "SendMessageSync", "0x06000050"},
    {"SendMessageAsync", "SendMessageAsync", "0x06000051"},
    {"AbortMessage", "AbortMessage", "0x06000052"},
    {"RegisterNotify", "RegisterNotify2", "0x06000053"},
    {"UnregisterNotify", "UnregisterNotify", "0x06000054"},
    {"setVideoMode", "SetVideoMode", "0x06000075"},
    {"getProhibitionFlags", "GetProhibitionFlags", "0x060000fe"},
    {"addProhibitionFlagListener", "AddProhibitionFlagListener", "0x060000ff"},
    {"removeProhibitionFlagListener", "RemoveProhibitionFlagListener", "0x06000100"},
    {"addTelemetryErrorListener", "AddTelemetryErrorListener", "0x060001ef"},
    {"removeTelemetryErrorListener", "RemoveTelemetryErrorListener", "0x060001f0"},
    {"isDualCore", "IsDualCore", "0x060001f1"},
    {"MASSValueSizeMax", "MASSValueSizeMax", "0x06000230"},
    {"MASSMCInitialize", "MASSMCInitialize", "0x06000233"},
    {"MASSMCTerminate", "MASSMCTerminate", "0x06000235"},
    {"MASSMCSendMessage", "MASSMCSendMessage", "0x06000237"},
    {"MASSMCReadMessage", "MASSMCReadMessage", "0x06000239"},
    {"MASSMCDeleteMessage", "MASSMCDeleteMessage", "0x0600023b"},
    {"MASSMCIsMediaAppProvisioned", "MASSMCIsMediaAppProvisioned", "0x0600023d"},
    {"MASSMAInitialize", "MASSMAInitialize", "0x0600023f"},
    {"MASSMATerminate", "MASSMATerminate", "0x06000241"},
    {"MASSMASendMessage", "MASSMASendMessage", "0x06000243"},
    {"MASSMAReadMessage", "MASSMAReadMessage", "0x06000245"},
    {"MASSMADeleteMessage", "MASSMADeleteMessage", "0x06000247"},
    {"InitializeMediaModule", "InitializeMediaModule", "0x0600024d"},
    {"FinalizeMediaModule", "FinalizeMediaModule", "0x0600024e"},
    {"ServiceSupported", "ServiceSupported", "0x0600024f"},
    {"RegisterNotifyCommandWebMusicCore", "RegisterNotifyCommandWebMusicCore", "0x06000250"},
    {"UnregisterCommandWebMusicCore", "UnregisterCommandWebMusicCore", "0x06000251"},
    {"GetMediaPlaybackInfo", "GetMediaPlaybackInfo", "0x06000252"},
    {"RemoveMediaSource", "RemoveMediaSource", "0x06000253"},
    {"PlayUri", "PlayUri", "0x06000254"},
    {"PlayUriByDeviceId", "PlayUriByDeviceId", "0x06000255"},
    {"PlaybackCommand", "PlaybackCommand", "0x06000256"},
    {"GetVolume", "GetVolume", "0x06000257"},
    {"SetVolume", "SetVolume", "0x06000258"},
    {"GetMute", "GetMute", "0x06000259"},
    {"SetMute", "SetMute", "0x0600025a"},
    {"GetCurrentSrcId", "GetCurrentSrcId", "0x0600025b"},
    {"SetCurrentSrcId", "SetCurrentSrcId", "0x0600025c"},
    {"GetServiceType", "GetServiceType", "0x0600025d"},
    {"SetServiceType", "SetServiceType", "0x0600025e"},
    {"GetCapabilities", "GetCapabilities", "0x0600025f"},
    {"GetServiceTypeFromSrcId", "GetServiceTypeFromSrcId", "0x06000260"},
    {"GetCurrentTime", "GetCurrentTime", "0x06000261"},
    {"SetCurrentTime", "SetCurrentTime", "0x06000262"},
    {"Seek", "Seek", "0x06000263"},
    {"GetUsbDeviceListArray", "GetUsbDeviceListArray", "0x06000264"},
    {"GetUsbFileItemListArray", "GetUsbFileItemListArray", "0x06000265"},
    {"RegisterMediaEventCallback", "RegisterMediaEventCallback", "0x06000266"},
    {"ForbidCopyrightProtectedContents", "ForbidCopyrightProtectedContents", "0x06000267"},
    {"GetServiceTypeFromTitleId", "GetServiceTypeFromTitleId", "0x06000268"},
    {"GetTitleIdFromServiceType", "GetTitleIdFromServiceType", "0x06000269"},
    {"GetSrcIdList", "GetSrcIdList", "0x0600026a"},
    {"IsSrcIdPlaying", "IsSrcIdPlaying", "0x0600026b"},
    {"TerminateMusicCore", "TerminateMusicCore", "0x0600026c"},
    {"TerminateMusicService", "TerminateMusicService2", "0x0600026d"},
    {"getDecryptionKeys", "getDecryptionKeys", "0x060002ca"},
#endif
};
#ifndef ND_UI_BRIDGE_EXPORTS
static const struct export_request managed_exports[] = {
    {"mono_aot_file_info", "mono_aot_file_info", ""},
};
_Static_assert(sizeof(native_exports) / sizeof(native_exports[0]) == 65,
               "Captured ImplMap must contain exactly 65 imports");
#else
_Static_assert(sizeof(native_exports) / sizeof(native_exports[0]) == 14,
               "UI bridge resolution must contain exactly 14 confirmed imports");
#endif
_Static_assert(sizeof(native_exports) / sizeof(native_exports[0]) <= MAX_EXPORTS,
               "Export enumeration must remain bounded");
#endif

/* The ordinary SDK startup installs patches. This probe needs no patches. */
int __wrap___patch_init(void) { return 0; }

struct module_result {
    const char *name;
    const char *installed_path;
    const char *capture_path;
    uint32_t handle;
    intptr_t base;
    intptr_t entry;
    int lookup_attempted;
    int lookup_result;
    int lookup_error;
    int base_error;
    int entry_error;
    int read_attempted;
    int read_result;
    int read_error;
    size_t bytes_read;
    unsigned char header[HEADER_BYTES];
    int capture_error;
    size_t capture_bytes;
    unsigned char installed_header[HEADER_BYTES];
#if defined(ND_RUNTIME_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES)
    intptr_t aot_info;
    int aot_resolve_error;
#endif
#ifdef ND_MODULE_LAYOUT
    const char *dump_prefix;
    unsigned char installed_metadata[SELF_HEADER_BYTES];
    size_t elf_offset;
    Elf64_Ehdr elf_header;
    int layout_validated;
    int layout_error;
    uint64_t dump_size;
    size_t segment_count;
    struct segment_result *segments;
    int identity_checked;
    uint32_t final_handle;
    intptr_t final_base;
    int final_lookup_result;
    int final_lookup_error;
    int final_base_error;
    int identity_unchanged;
    int dump_complete;
#endif
#ifdef ND_RESOLVE_EXPORTS
    struct export_result *exports;
    size_t export_count;
    size_t found_count;
    int resolution_error;
    int resolution_complete;
    int require_executable;
#endif
};

struct process_diagnostics {
    size_t returned_bytes;
    size_t capture_bytes;
    size_t records_parsed;
    int capture_error;
    int first_record_size;
};

struct credential_scope {
    int attempted;
    int setup_error;
    int query_error;
    int restore_caps_error;
    int restore_attrs_error;
    int restore_verify_error;
    int restore_error;
    int restored;
};

static void capture_process_records(const unsigned char *records, size_t length,
                                    struct process_diagnostics *diagnostics)
{
    if (diagnostics == NULL)
        return;
    diagnostics->returned_bytes = length;
    if (length >= sizeof(diagnostics->first_record_size))
        memcpy(&diagnostics->first_record_size, records,
               sizeof(diagnostics->first_record_size));
    errno = 0;
    FILE *out = fopen(PROCESS_CAPTURE_PATH, "wb");
    if (out == NULL) {
        diagnostics->capture_error = errno;
        return;
    }
    const size_t written = fwrite(records, 1, length, out);
    const int write_error = errno;
    const int close_failed = fclose(out) != 0;
    if (written != length || close_failed) {
        diagnostics->capture_error = written != length ? (write_error ? write_error : EIO)
                                                      : errno;
        return;
    }
    diagnostics->capture_bytes = length;
}

static pid_t query_shellui(struct process_diagnostics *diagnostics)
{
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
    const size_t minimum_record = offsetof(struct kinfo_proc, ki_comm) +
                                  sizeof(((struct kinfo_proc *)0)->ki_comm);

    for (unsigned int attempt = 0; attempt < 3; ++attempt) {
        size_t required = 0;
        if (sysctl(mib, 4, NULL, &required, NULL, 0) != 0)
            return -1;
        if (required == 0 || required > MAX_PROCESS_BYTES) {
            errno = EOVERFLOW;
            return -1;
        }
        size_t capacity = required + required / 8;
        if (capacity > MAX_PROCESS_BYTES)
            capacity = MAX_PROCESS_BYTES;
        unsigned char *records = malloc(capacity);
        if (records == NULL)
            return -1;

        size_t used = capacity;
        if (sysctl(mib, 4, records, &used, NULL, 0) != 0) {
            const int saved_error = errno;
            free(records);
            if (saved_error == ENOMEM && attempt < 2)
                continue;
            errno = saved_error;
            return -1;
        }
        if (used > capacity) {
            free(records);
            errno = EOVERFLOW;
            return -1;
        }
        capture_process_records(records, used, diagnostics);

        pid_t found = -1;
        int result_error = ENOENT;
        for (size_t offset = 0; offset < used;) {
            int record_size = 0;
            if (used - offset < sizeof(record_size)) {
                result_error = EPROTO;
                found = -1;
                break;
            }
            memcpy(&record_size, records + offset, sizeof(record_size));
            if (record_size <= 0 || (size_t)record_size < minimum_record ||
                (size_t)record_size > used - offset) {
                result_error = EPROTO;
                found = -1;
                break;
            }

            struct kinfo_proc record;
            memset(&record, 0, sizeof(record));
            const size_t copy_size = (size_t)record_size < sizeof(record)
                                         ? (size_t)record_size : sizeof(record);
            memcpy(&record, records + offset, copy_size);
            if (diagnostics != NULL)
                ++diagnostics->records_parsed;
            if (memcmp(record.ki_comm, "SceShellUI", sizeof("SceShellUI")) == 0) {
                if (found > 0 || record.ki_pid <= 0) {
                    result_error = found > 0 ? EEXIST : EPROTO;
                    found = -1;
                    break;
                }
                found = record.ki_pid;
                result_error = 0;
            }
            offset += (size_t)record_size;
        }
        free(records);
        errno = result_error;
        return found;
    }
    errno = ENOMEM;
    return -1;
}

static pid_t find_shellui(struct process_diagnostics *diagnostics,
                         struct credential_scope *scope)
{
    const pid_t self = getpid();
    uint8_t saved_caps[16], saved_attrs[32], caps[16], attrs[32];
    int caps_attempted = 0, attrs_attempted = 0;
    int result_error = 0;
    pid_t result = -1;
    scope->attempted = 1;

    errno = 0;
    if (kernel_get_ucred_caps(self, saved_caps) != 0 ||
        kernel_get_ucred_attrs(self, saved_attrs) != 0) {
        scope->setup_error = errno ? errno : EIO;
        errno = scope->setup_error;
        return -1;
    }
    memcpy(caps, saved_caps, sizeof(caps));
    memcpy(attrs, saved_attrs, sizeof(attrs));
    /* Exact own-process credentials used by SDK v0.43 crt/patch.c
     * (John Tornblom, GPL-3.0-or-later), without syscall-origin patches. */
    caps[5] = 0x1c;
    caps[7] = 0x40;
    caps[15] |= 0x40;
    attrs[3] |= 0x80;

    errno = 0;
    caps_attempted = 1;
    if (kernel_set_ucred_caps(self, caps) != 0) {
        result_error = scope->setup_error = errno ? errno : EIO;
        goto restore;
    }
    errno = 0;
    attrs_attempted = 1;
    if (kernel_set_ucred_attrs(self, attrs) != 0) {
        result_error = scope->setup_error = errno ? errno : EIO;
        goto restore;
    }

    errno = 0;
    result = query_shellui(diagnostics);
    result_error = scope->query_error = result <= 0 ? errno : 0;

restore:
    if (attrs_attempted) {
        errno = 0;
        if (kernel_set_ucred_attrs(self, saved_attrs) != 0)
            scope->restore_attrs_error = errno ? errno : EIO;
    }
    if (caps_attempted) {
        errno = 0;
        if (kernel_set_ucred_caps(self, saved_caps) != 0)
            scope->restore_caps_error = errno ? errno : EIO;
    }
    errno = 0;
    if (kernel_get_ucred_caps(self, caps) != 0 ||
        kernel_get_ucred_attrs(self, attrs) != 0) {
        scope->restore_verify_error = errno ? errno : EIO;
    } else if (memcmp(caps, saved_caps, sizeof(caps)) != 0 ||
               memcmp(attrs, saved_attrs, sizeof(attrs)) != 0) {
        scope->restore_verify_error = EIO;
    }
    scope->restore_error = scope->restore_attrs_error ? scope->restore_attrs_error :
                           scope->restore_caps_error ? scope->restore_caps_error :
                           scope->restore_verify_error;
    scope->restored = scope->restore_error == 0;
    if (scope->restore_error != 0) {
        result = -1;
        result_error = scope->restore_error;
    }
    errno = result_error;
    return result;
}

static void write_scope(FILE *out, const struct credential_scope *scope)
{
    fprintf(out,
            "{\"attempted\":%s,\"setupError\":%d,\"queryError\":%d,"
            "\"restoreCapsError\":%d,\"restoreAttrsError\":%d,"
            "\"restoreVerifyError\":%d,\"restoreError\":%d,\"restored\":%s}",
            scope->attempted ? "true" : "false", scope->setup_error,
            scope->query_error, scope->restore_caps_error, scope->restore_attrs_error,
            scope->restore_verify_error, scope->restore_error,
            scope->restored ? "true" : "false");
}

static int read_header(pid_t pid, intptr_t address, struct module_result *result)
{
    if (address <= 0 || (uintptr_t)address > UINTPTR_MAX - HEADER_BYTES) {
        errno = EINVAL;
        return -1;
    }
    while (result->bytes_read < HEADER_BYTES) {
        const uintptr_t current = (uintptr_t)address + result->bytes_read;
        size_t count = 0x1000U - (current & 0xfffU);
        if (count > HEADER_BYTES - result->bytes_read)
            count = HEADER_BYTES - result->bytes_read;
        errno = 0;
        const int rc = kernel_proc_copyout(pid, (intptr_t)current,
                                           result->header + result->bytes_read,
                                           count);
        if (rc != 0)
            return rc;
        result->bytes_read += count;
    }
    return 0;
}

static void inspect_module(pid_t pid, struct module_result *result)
{
    result->lookup_attempted = 1;
    errno = 0;
    result->lookup_result = kernel_dynlib_handle(pid, result->name, &result->handle);
    result->lookup_error = result->lookup_result != 0 ? errno : 0;
    if (result->lookup_result != 0)
        return;

    errno = 0;
    result->base = kernel_dynlib_mapbase_addr(pid, result->handle);
    result->base_error = result->base == 0 ? errno : 0;
    errno = 0;
    result->entry = kernel_dynlib_entry_addr(pid, result->handle);
    result->entry_error = result->entry == 0 ? errno : 0;
    if (result->base == 0)
        return;

    result->read_attempted = 1;
    result->read_result = read_header(pid, result->base, result);
    result->read_error = result->read_result != 0 ? errno : 0;
#if defined(ND_RUNTIME_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES)
    /* Symbol lookup only: do not call any Mono API or inspect its pointer. */
    errno = 0;
    result->aot_info = kernel_dynlib_dlsym(pid, result->handle, "mono_aot_file_info");
    result->aot_resolve_error = result->aot_info > 0 ? 0 : (errno ? errno : ENOENT);
#endif
}

static void capture_installed_header(struct module_result *result)
{
    if (result->installed_path == NULL)
        return;
    unsigned char buffer[SELF_HEADER_BYTES];
    FILE *input = fopen(result->installed_path, "rb");
    if (input == NULL) {
        result->capture_error = errno;
        return;
    }
    const size_t length = fread(buffer, 1, sizeof(buffer), input);
    const int read_failed = ferror(input);
    const int read_error = errno;
    const int close_failed = fclose(input) != 0;
    if (read_failed || close_failed || length == 0) {
        result->capture_error = read_failed ? (read_error ? read_error : EIO)
                                           : (close_failed ? errno : EIO);
        return;
    }
    FILE *output = fopen(result->capture_path, "wb");
    if (output == NULL) {
        result->capture_error = errno;
        return;
    }
    const size_t written = fwrite(buffer, 1, length, output);
    const int write_error = errno;
    const int output_close_failed = fclose(output) != 0;
    if (written != length || output_close_failed) {
        result->capture_error = written != length ? (write_error ? write_error : EIO)
                                                 : errno;
        return;
    }
    result->capture_bytes = length;
    memcpy(result->installed_header, buffer,
           length < HEADER_BYTES ? length : HEADER_BYTES);
#ifdef ND_MODULE_LAYOUT
    memcpy(result->installed_metadata, buffer, length);
#endif
}

#ifdef ND_MODULE_LAYOUT
static int parse_self_layout(struct module_result *result)
{
    if (result->capture_error != 0 || result->capture_bytes < sizeof(Elf64_Ehdr))
        return result->capture_error ? result->capture_error : ENOEXEC;
    if (result->base <= 0 || (uintptr_t)result->base >= USER_VADDR_END)
        return EINVAL;
    const unsigned char *metadata = result->installed_metadata;
    const size_t length = result->capture_bytes;
    size_t candidates = 0;
    for (size_t offset = 0; offset <= length - sizeof(Elf64_Ehdr); ++offset) {
        if (memcmp(metadata + offset, ELFMAG, SELFMAG) != 0)
            continue;
        Elf64_Ehdr header;
        memcpy(&header, metadata + offset, sizeof(header));
        if (header.e_ident[EI_CLASS] != ELFCLASS64 ||
            header.e_ident[EI_DATA] != ELFDATA2LSB ||
            header.e_ident[EI_VERSION] != EV_CURRENT ||
            header.e_version != EV_CURRENT || header.e_machine != EM_X86_64 ||
            header.e_ehsize != sizeof(Elf64_Ehdr) ||
            header.e_phentsize != sizeof(Elf64_Phdr) ||
            header.e_phnum == 0 || header.e_phnum > MAX_PROGRAM_HEADERS ||
            header.e_phoff < sizeof(Elf64_Ehdr) ||
            header.e_phoff > length - offset ||
            (size_t)header.e_phnum * sizeof(Elf64_Phdr) >
                length - offset - (size_t)header.e_phoff)
            continue;
        if (header.e_type != ET_EXEC && header.e_type != ET_DYN &&
            (header.e_type < ET_LOOS || header.e_type > ET_HIOS))
            continue;
        result->elf_header = header;
        result->elf_offset = offset;
        ++candidates;
    }
    if (candidates != 1)
        return ENOEXEC;

    struct segment_result *segments = calloc(result->elf_header.e_phnum,
                                              sizeof(*segments));
    if (segments == NULL)
        return ENOMEM;
    int error = 0;
    uint64_t minimum_vaddr = UINT64_MAX;
    size_t count = 0;
    uint64_t total_size = 0;
    for (unsigned int i = 0; i < result->elf_header.e_phnum; ++i) {
        Elf64_Phdr phdr;
        memcpy(&phdr, metadata + result->elf_offset + result->elf_header.e_phoff +
                          (size_t)i * sizeof(phdr), sizeof(phdr));
        if (phdr.p_type != PT_LOAD || (phdr.p_flags & 7U) == 0)
            continue;
        if (phdr.p_vaddr < minimum_vaddr)
            minimum_vaddr = phdr.p_vaddr;
        if (phdr.p_filesz > phdr.p_memsz ||
            phdr.p_memsz > UINT64_MAX - phdr.p_vaddr ||
            phdr.p_filesz > UINT64_MAX - phdr.p_offset ||
            phdr.p_vaddr > UINTPTR_MAX - (uintptr_t)result->base ||
            phdr.p_memsz > UINTPTR_MAX - ((uintptr_t)result->base + phdr.p_vaddr) ||
            phdr.p_vaddr > USER_VADDR_END - (uintptr_t)result->base ||
            phdr.p_memsz > USER_VADDR_END - ((uintptr_t)result->base + phdr.p_vaddr) ||
            phdr.p_filesz > MAX_MODULE_BYTES - total_size ||
            (phdr.p_align > 1 &&
             ((phdr.p_align & (phdr.p_align - 1)) != 0 ||
              phdr.p_vaddr % phdr.p_align != phdr.p_offset % phdr.p_align))) {
            error = EINVAL;
            break;
        }
        if (phdr.p_filesz == 0)
            continue;
        struct segment_result *segment = &segments[count];
        segment->index = i;
        segment->program_header = phdr;
        segment->address = (uintptr_t)result->base + phdr.p_vaddr;
        const int path_length = snprintf(segment->path, sizeof(segment->path),
                                         "/data/navidrome-%s-seg-%u.bin",
                                         result->dump_prefix, i);
        if (path_length < 0 || (size_t)path_length >= sizeof(segment->path)) {
            error = ENAMETOOLONG;
            break;
        }
        total_size += phdr.p_filesz;
        ++count;
    }
    /* These SPRX modules use zero-based virtual addresses. Do not infer a
     * different load bias from an unexpected header. */
    if (minimum_vaddr != 0 || count == 0)
        error = ENOEXEC;
    if (error != 0) {
        free(segments);
        return error;
    }
    result->segments = segments;
    result->segment_count = count;
    result->dump_size = total_size;
    result->layout_validated = 1;
    return 0;
}

static void check_module_identity(pid_t pid, struct module_result *result)
{
    result->identity_checked = 1;
    errno = 0;
    result->final_lookup_result = kernel_dynlib_handle(pid, result->name,
                                                      &result->final_handle);
    result->final_lookup_error = result->final_lookup_result != 0 ? errno : 0;
    if (result->final_lookup_result == 0) {
        errno = 0;
        result->final_base = kernel_dynlib_mapbase_addr(pid, result->final_handle);
        result->final_base_error = result->final_base == 0 ? errno : 0;
    }
    result->identity_unchanged = result->final_lookup_result == 0 &&
                                 result->final_handle == result->handle &&
                                 result->final_base == result->base;
}

#ifdef ND_DUMP_MODULES
static void dump_segment(pid_t pid, struct segment_result *segment)
{
    unsigned char buffer[4096];
    errno = 0;
    FILE *out = fopen(segment->path, "wb");
    if (out == NULL) {
        segment->write_error = errno ? errno : EIO;
        return;
    }
    while (segment->bytes_read < segment->program_header.p_filesz) {
        const uintptr_t address = segment->address + segment->bytes_read;
        size_t count = sizeof(buffer) - (address & 0xfffU);
        const uint64_t remaining = segment->program_header.p_filesz - segment->bytes_read;
        if (count > remaining)
            count = (size_t)remaining;
        segment->failure_offset = segment->bytes_read;
        errno = 0;
        if (kernel_proc_copyout(pid, (intptr_t)address, buffer, count) != 0) {
            segment->read_error = errno ? errno : EIO;
            break;
        }
        segment->bytes_read += count;
        errno = 0;
        const size_t written = fwrite(buffer, 1, count, out);
        segment->bytes_written += written;
        if (written != count) {
            segment->write_error = errno ? errno : EIO;
            break;
        }
    }
    errno = 0;
    if (fclose(out) != 0 && segment->write_error == 0)
        segment->write_error = errno ? errno : EIO;
    segment->complete = segment->read_error == 0 && segment->write_error == 0 &&
                        segment->bytes_read == segment->program_header.p_filesz &&
                        segment->bytes_written == segment->program_header.p_filesz;
}

static void dump_module(pid_t pid, struct module_result *result)
{
    if (result->installed_path == NULL)
        return;
    if (pid <= 0 || !result->lookup_attempted || result->lookup_result != 0 ||
        result->base <= 0) {
        result->layout_error = ESRCH;
        return;
    }
    result->layout_error = parse_self_layout(result);
    int all_complete = result->layout_error == 0;
    if (result->layout_validated) {
        for (size_t i = 0; i < result->segment_count; ++i) {
            dump_segment(pid, &result->segments[i]);
            if (!result->segments[i].complete)
                all_complete = 0;
        }
    }
    check_module_identity(pid, result);
    result->dump_complete = all_complete && result->identity_unchanged;
}

static void write_dump(FILE *out, const struct module_result *result)
{
    fprintf(out,
            ",\"selfLayout\":{\"validated\":%s,\"error\":%d,\"elfOffset\":%zu,"
            "\"elfType\":%u,\"phoff\":%" PRIu64 ",\"phentsize\":%u,\"phnum\":%u,"
            "\"totalFileBytes\":%" PRIu64 "},\"segments\":[",
            result->layout_validated ? "true" : "false", result->layout_error,
            result->elf_offset, result->elf_header.e_type, result->elf_header.e_phoff,
            result->elf_header.e_phentsize, result->elf_header.e_phnum, result->dump_size);
    for (size_t i = 0; i < result->segment_count; ++i) {
        const struct segment_result *segment = &result->segments[i];
        if (i != 0)
            fputc(',', out);
        fprintf(out,
                "{\"index\":%u,\"address\":\"0x%" PRIxPTR "\",\"flags\":%u,"
                "\"path\":\"%s\",\"vaddr\":\"0x%" PRIx64 "\",\"fileOffset\":%" PRIu64
                ",\"memSize\":%" PRIu64 ",\"size\":%" PRIu64 ",\"bytesRead\":%" PRIu64
                ",\"bytesWritten\":%" PRIu64 ",\"readError\":%d,\"writeError\":%d,"
                "\"failureOffset\":",
                segment->index, segment->address, segment->program_header.p_flags,
                segment->path, segment->program_header.p_vaddr, segment->program_header.p_offset,
                segment->program_header.p_memsz, segment->program_header.p_filesz,
                segment->bytes_read, segment->bytes_written, segment->read_error,
                segment->write_error);
        if (segment->complete)
            fputs("null", out);
        else
            fprintf(out, "%" PRIu64, segment->failure_offset);
        fprintf(out, ",\"complete\":%s}", segment->complete ? "true" : "false");
    }
    fprintf(out,
            "],\"moduleIdentity\":{\"checked\":%s,\"finalHandle\":%" PRIu32
            ",\"finalBase\":\"0x%" PRIxPTR "\",\"lookupResult\":%d,\"lookupError\":%d,"
            "\"baseError\":%d,\"unchanged\":%s},\"dumpComplete\":%s",
            result->identity_checked ? "true" : "false", result->final_handle,
            (uintptr_t)result->final_base, result->final_lookup_result,
            result->final_lookup_error, result->final_base_error,
            result->identity_unchanged ? "true" : "false",
            result->dump_complete ? "true" : "false");
}
#endif
#endif

#ifdef ND_RESOLVE_EXPORTS
static void read_export_sample(pid_t pid, struct export_result *symbol)
{
    symbol->read_attempted = 1;
    while (symbol->bytes_read < EXPORT_SAMPLE_BYTES) {
        const uintptr_t address = (uintptr_t)symbol->address + symbol->bytes_read;
        size_t count = 0x1000U - (address & 0xfffU);
        if (count > EXPORT_SAMPLE_BYTES - symbol->bytes_read)
            count = EXPORT_SAMPLE_BYTES - symbol->bytes_read;
        errno = 0;
        const int rc = kernel_proc_copyout(pid, (intptr_t)address,
                                          symbol->sample + symbol->bytes_read, count);
        if (rc != 0) {
            symbol->read_result = rc;
            symbol->read_error = errno ? errno : EIO;
            return;
        }
        symbol->bytes_read += count;
    }
}

static void resolve_module_exports(pid_t pid, struct module_result *result)
{
    if (pid <= 0 || !result->lookup_attempted || result->lookup_result != 0 ||
        result->base <= 0) {
        result->resolution_error = ESRCH;
        return;
    }
    result->layout_error = parse_self_layout(result);
    if (result->layout_error != 0) {
        result->resolution_error = result->layout_error;
        check_module_identity(pid, result);
        return;
    }
    const struct export_request *requests = NULL;
    size_t count = 0;
#ifdef ND_UI_BRIDGE_EXPORTS
    if (strcmp(result->name, "libNativeExtensions.sprx") == 0) {
        requests = native_exports;
        count = sizeof(native_exports) / sizeof(native_exports[0]);
        result->require_executable = 1;
    }
#else
    if (strcmp(result->name, "libReactNative.Modules.Vsh.Media.sprx") == 0) {
        requests = native_exports;
        count = sizeof(native_exports) / sizeof(native_exports[0]);
        result->require_executable = 1;
    } else if (strcmp(result->name, "ReactNative.Modules.Vsh.Media.dll.sprx") == 0) {
        requests = managed_exports;
        count = sizeof(managed_exports) / sizeof(managed_exports[0]);
    }
#endif
    if (count == 0 || count > MAX_EXPORTS) {
        result->resolution_error = EINVAL;
        return;
    }
    result->exports = calloc(count, sizeof(*result->exports));
    if (result->exports == NULL) {
        result->resolution_error = ENOMEM;
        return;
    }
    result->export_count = count;
    int samples_ok = 1;
    for (size_t i = 0; i < count; ++i) {
        struct export_result *symbol = &result->exports[i];
        symbol->request = &requests[i];
        errno = 0;
        symbol->address = kernel_dynlib_dlsym(pid, result->handle, requests[i].import_name);
#ifdef ND_UI_BRIDGE_EXPORTS
        symbol->resolve_error = symbol->address <= 0 ? (errno ? errno : ENOENT) : 0;
        if (symbol->address <= 0) {
            samples_ok = 0;
            continue;
        }
#else
        symbol->resolve_error = symbol->address == 0 ? errno : 0;
        if (symbol->address <= 0)
            continue;
#endif
        ++result->found_count;
        for (size_t j = 0; j < result->segment_count; ++j) {
            const struct segment_result *segment = &result->segments[j];
            const uint32_t required_flag = result->require_executable ? PF_X : PF_R;
            if ((segment->program_header.p_flags & required_flag) == 0 ||
                (uintptr_t)symbol->address < segment->address)
                continue;
            const uint64_t offset = (uintptr_t)symbol->address - segment->address;
            if (offset > segment->program_header.p_filesz ||
                EXPORT_SAMPLE_BYTES > segment->program_header.p_filesz - offset)
                continue;
            symbol->sample_allowed = 1;
            symbol->segment_index = segment->index;
            symbol->segment_flags = segment->program_header.p_flags;
            read_export_sample(pid, symbol);
            if (symbol->read_result != 0)
                samples_ok = 0;
            break;
        }
#ifdef ND_UI_BRIDGE_EXPORTS
        if (!symbol->sample_allowed || symbol->bytes_read != EXPORT_SAMPLE_BYTES)
            samples_ok = 0;
#endif
    }
    check_module_identity(pid, result);
    result->resolution_complete = result->identity_unchanged && samples_ok;
}

static void write_exports(FILE *out, const struct module_result *result)
{
    fprintf(out,
            ",\"selfLayout\":{\"validated\":%s,\"error\":%d,\"elfOffset\":%zu,"
            "\"phoff\":%" PRIu64 ",\"phnum\":%u},\"exportCount\":%zu,"
            "\"foundCount\":%zu,\"sampleKind\":\"%s\",\"exports\":[",
            result->layout_validated ? "true" : "false", result->layout_error,
            result->elf_offset, result->elf_header.e_phoff, result->elf_header.e_phnum,
            result->export_count, result->found_count,
            result->require_executable ? "function" : "data");
    for (size_t i = 0; i < result->export_count; ++i) {
        const struct export_result *symbol = &result->exports[i];
        if (i != 0)
            fputc(',', out);
        fprintf(out,
                "{\"name\":\"%s\",\"memberName\":\"%s\",\"memberToken\":\"%s\","
                "\"address\":\"0x%" PRIxPTR "\",\"found\":%s,\"moduleOffset\":",
                symbol->request->import_name, symbol->request->member_name,
                symbol->request->member_token, (uintptr_t)symbol->address,
                symbol->address > 0 ? "true" : "false");
        if (symbol->address >= result->base && result->base > 0)
            fprintf(out, "\"0x%" PRIxPTR "\"", (uintptr_t)(symbol->address - result->base));
        else
            fputs("null", out);
        fprintf(out,
                ",\"resolveError\":%d,\"sampleAllowed\":%s,\"segmentIndex\":",
                symbol->resolve_error, symbol->sample_allowed ? "true" : "false");
        if (symbol->sample_allowed)
            fprintf(out, "%u", symbol->segment_index);
        else
            fputs("null", out);
        fprintf(out,
                ",\"segmentFlags\":%u,\"readAttempted\":%s,\"readResult\":",
                symbol->segment_flags, symbol->read_attempted ? "true" : "false");
        if (symbol->read_attempted)
            fprintf(out, "%d", symbol->read_result);
        else
            fputs("null", out);
        fprintf(out, ",\"readError\":%d,\"bytesRead\":%zu,\"header16Hex\":",
                symbol->read_error, symbol->bytes_read);
        if (symbol->bytes_read == EXPORT_SAMPLE_BYTES && symbol->read_result == 0) {
            fputc('"', out);
            for (size_t j = 0; j < EXPORT_SAMPLE_BYTES; ++j)
                fprintf(out, "%02x", symbol->sample[j]);
            fputc('"', out);
        } else {
            fputs("null", out);
        }
        fputc('}', out);
    }
    fprintf(out,
            "],\"moduleIdentity\":{\"checked\":%s,\"finalHandle\":%" PRIu32
            ",\"finalBase\":\"0x%" PRIxPTR "\",\"lookupResult\":%d,\"lookupError\":%d,"
            "\"baseError\":%d,\"unchanged\":%s},\"resolutionError\":%d,\"resolutionComplete\":%s",
            result->identity_checked ? "true" : "false", result->final_handle,
            (uintptr_t)result->final_base, result->final_lookup_result,
            result->final_lookup_error, result->final_base_error,
            result->identity_unchanged ? "true" : "false", result->resolution_error,
            result->resolution_complete ? "true" : "false");
}
#endif

static void write_module(FILE *out, const struct module_result *result)
{
    fprintf(out,
            "{\"name\":\"%s\",\"handle\":%" PRIu32
            ",\"base\":\"0x%" PRIxPTR "\",\"entry\":\"0x%" PRIxPTR
            "\",\"lookupAttempted\":%s,\"lookupResult\":",
            result->name, result->handle, (uintptr_t)result->base,
            (uintptr_t)result->entry, result->lookup_attempted ? "true" : "false");
    if (result->lookup_attempted)
        fprintf(out, "%d", result->lookup_result);
    else
        fputs("null", out);
    fprintf(out,
            ",\"lookupError\":%d,\"baseError\":%d,\"entryError\":%d,"
            "\"readAttempted\":%s,\"readResult\":", result->lookup_error,
            result->base_error, result->entry_error,
            result->read_attempted ? "true" : "false");
    if (result->read_attempted)
        fprintf(out, "%d", result->read_result);
    else
        fputs("null", out);
    fprintf(out, ",\"readError\":%d,\"bytesRead\":%zu,\"header64Hex\":",
            result->read_error, result->bytes_read);
    if (result->read_attempted && result->read_result == 0 &&
        result->bytes_read == HEADER_BYTES) {
        fputc('"', out);
        for (size_t i = 0; i < HEADER_BYTES; ++i)
            fprintf(out, "%02x", result->header[i]);
        fputc('"', out);
    } else {
        fputs("null", out);
    }
    if (result->installed_path != NULL) {
#if defined(ND_RUNTIME_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES)
        fprintf(out, ",\"aotInfoSymbol\":{\"name\":\"mono_aot_file_info\","
                     "\"address\":\"0x%" PRIxPTR "\",\"found\":%s,\"resolveError\":%d}",
                (uintptr_t)result->aot_info, result->aot_info > 0 ? "true" : "false",
                result->aot_resolve_error);
#endif
        fprintf(out,
                ",\"installedHeader\":{\"source\":\"%s\",\"capture\":\"%s\","
                "\"bytes\":%zu,\"error\":%d,\"header64Hex\":",
                result->installed_path, result->capture_path,
                result->capture_bytes, result->capture_error);
        if (result->capture_bytes >= HEADER_BYTES) {
            fputc('"', out);
            for (size_t i = 0; i < HEADER_BYTES; ++i)
                fprintf(out, "%02x", result->installed_header[i]);
            fputc('"', out);
        } else {
            fputs("null", out);
        }
        fputc('}', out);
#ifdef ND_DUMP_MODULES
        write_dump(out, result);
#endif
#ifdef ND_RESOLVE_EXPORTS
        write_exports(out, result);
#endif
    }
    fputc('}', out);
}

#ifndef ND_MODULE_HELPERS_ONLY
int main(void)
{
    const uint32_t firmware = kernel_get_fw_version();
    const int firmware_ok = (firmware & UINT32_C(0xffff0000)) == EXPECTED_FW;
    pid_t pid = -1;
    int process_error = 0;
    struct process_diagnostics diagnostics = {0};
    struct credential_scope initial_scope = {0}, final_scope = {0};
    struct module_result modules[] = {
#ifdef ND_UI_BRIDGE_EXPORTS
        {.name = "libNativeExtensions.sprx",
         .installed_path = "/system_ex/common_ex/lib/libNativeExtensions.sprx",
         .capture_path = "/data/navidrome-ui-bridge-exports-14-native-extensions.self-header.bin",
         .dump_prefix = "ui-bridge-exports-14-native-extensions"},
#elif defined(ND_VSH_COMMON_MODULES)
        {.name = "ReactNative.Vsh.Common.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/ReactNative.Vsh.Common.dll.sprx",
         .capture_path = "/data/navidrome-vsh-common-managed.self-header.bin",
         .dump_prefix = "vsh-common-managed"},
#elif defined(ND_RUNTIME_MODULES)
        {.name = "ReactNative.PUI.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/ReactNative.PUI.dll.sprx",
         .capture_path = "/data/navidrome-runtime-pui.self-header.bin",
         .dump_prefix = "runtime-pui"},
        {.name = "ReactNative.Modules.Vsh.WebAppLauncher.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/ReactNative.Modules.Vsh.WebAppLauncher.dll.sprx",
         .capture_path = "/data/navidrome-runtime-web-managed.self-header.bin",
         .dump_prefix = "runtime-web-managed"},
        {.name = "libReactNative.Modules.Vsh.WebAppLauncher.sprx",
         .installed_path = "/system_ex/common_ex/lib/libReactNative.Modules.Vsh.WebAppLauncher.sprx",
         .capture_path = "/data/navidrome-runtime-web-native.self-header.bin",
         .dump_prefix = "runtime-web-native"},
        {.name = "Sce.Vsh.ShellUI.ReactNativeApps.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/Sce.Vsh.ShellUI.ReactNativeApps.dll.sprx",
         .capture_path = "/data/navidrome-runtime-rnps-apps.self-header.bin",
         .dump_prefix = "runtime-rnps-apps"},
        {.name = "Sce.Vsh.ShellUI.ReactNativeShellApp.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/Sce.Vsh.ShellUI.ReactNativeShellApp.dll.sprx",
         .capture_path = "/data/navidrome-runtime-rnps-shell.self-header.bin",
         .dump_prefix = "runtime-rnps-shell"},
#elif defined(ND_UI_BRIDGE_MODULES)
        {.name = "libNativeExtensions.sprx",
         .installed_path = "/system_ex/common_ex/lib/libNativeExtensions.sprx",
         .capture_path = "/data/navidrome-ui-bridge-native-extensions.self-header.bin",
         .dump_prefix = "ui-bridge-native-extensions"},
        {.name = "Sce.Vsh.ShellUI.Legacy.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/Sce.Vsh.ShellUI.Legacy.dll.sprx",
         .capture_path = "/data/navidrome-ui-bridge-legacy.self-header.bin",
         .dump_prefix = "ui-bridge-legacy"},
#elif defined(ND_MEDIAFW_MODULES)
        {.name = "libSceMediaFrameworkInterface.sprx",
         .installed_path = "/system/common/lib/libSceMediaFrameworkInterface.sprx",
         .capture_path = "/data/navidrome-mediafw-interface.self-header.bin",
         .dump_prefix = "mediafw-interface"},
        {.name = "libSceMediaFrameworkUtil.sprx",
         .installed_path = "/system/common/lib/libSceMediaFrameworkUtil.sprx",
         .capture_path = "/data/navidrome-mediafw-util.self-header.bin",
         .dump_prefix = "mediafw-util"},
        {.name = "libSceMusicFrameworkInterface.sprx",
         .installed_path = "/system/common/lib/libSceMusicFrameworkInterface.sprx",
         .capture_path = "/data/navidrome-mediafw-music-framework.self-header.bin",
         .dump_prefix = "mediafw-music-framework"},
        {.name = "libSceMusicCoreInterface.sprx",
         .installed_path = "/system/common/lib/libSceMusicCoreInterface.sprx",
         .capture_path = "/data/navidrome-mediafw-music-core.self-header.bin",
         .dump_prefix = "mediafw-music-core"},
#else
        {.name = "libReactNative.Modules.Vsh.Media.sprx",
         .installed_path = "/system_ex/common_ex/lib/libReactNative.Modules.Vsh.Media.sprx",
         .capture_path = "/data/navidrome-media-native.self-header.bin",
#ifdef ND_MODULE_LAYOUT
         .dump_prefix = "native",
#endif
        },
        {.name = "ReactNative.Modules.Vsh.Media.dll.sprx",
         .installed_path = "/system_ex/common_ex/lib/ReactNative.Modules.Vsh.Media.dll.sprx",
         .capture_path = "/data/navidrome-media-managed.self-header.bin",
#ifdef ND_MODULE_LAYOUT
         .dump_prefix = "managed",
#endif
        },
#ifndef ND_RESOLVE_EXPORTS
        {.name = "libmonosgen-2.0.sprx"}
#endif
#endif
    };

    if (firmware_ok) {
        errno = 0;
        pid = find_shellui(&diagnostics, &initial_scope);
        process_error = pid <= 0 ? errno : 0;
    }
    FILE *out = fopen(REPORT_PATH, "w");
    if (out == NULL) {
        perror(REPORT_PATH);
        return 1;
    }
    fprintf(out,
            "{\"schema\":%d,\"firmware\":\"0x%08" PRIx32
            "\",\"expectedFirmware\":\"0x13200000\",\"firmwareAccepted\":%s,"
            "\"pid\":%d,\"processError\":%d,",
            REPORT_SCHEMA, firmware, firmware_ok ? "true" : "false", (int)pid, process_error);
#if defined(ND_RUNTIME_MODULES) || defined(ND_MEDIAFW_MODULES) || defined(ND_UI_BRIDGE_MODULES) || defined(ND_VSH_COMMON_MODULES) || defined(ND_UI_BRIDGE_EXPORTS)
    /* Emitted before reading any module data; identifies the fixed allowlist
     * and the exact source selected by the local build profile. */
    fprintf(out, "\"captureProfile\":\"%s\",\"readerSourceSha256\":\"%s\",",
            ND_CAPTURE_PROFILE, ND_READER_SOURCE_SHA256);
    fflush(out);
#endif
    fprintf(out,
            "\"processLayout\":{\"structSize\":%zu,\"pidOffset\":%zu,"
            "\"commOffset\":%zu,\"commSize\":%zu},"
            "\"processRecords\":{\"capture\":\"%s\",\"returnedBytes\":%zu,"
            "\"captureBytes\":%zu,\"captureError\":%d,\"firstRecordSize\":%d,"
            "\"recordsParsed\":%zu},\"initialCredentialScope\":",
            sizeof(struct kinfo_proc), offsetof(struct kinfo_proc, ki_pid),
            offsetof(struct kinfo_proc, ki_comm), sizeof(((struct kinfo_proc *)0)->ki_comm),
            PROCESS_CAPTURE_PATH, diagnostics.returned_bytes, diagnostics.capture_bytes,
            diagnostics.capture_error, diagnostics.first_record_size,
            diagnostics.records_parsed);
    write_scope(out, &initial_scope);
    fputs(",\"modules\":[", out);
    fflush(out);

    int all_read = firmware_ok && pid > 0;
    if (firmware_ok && initial_scope.restore_error == 0) {
        for (size_t i = 0; i < sizeof(modules) / sizeof(modules[0]); ++i) {
            if (pid > 0)
                inspect_module(pid, &modules[i]);
            capture_installed_header(&modules[i]);
#ifdef ND_DUMP_MODULES
            dump_module(pid, &modules[i]);
            if (modules[i].installed_path != NULL && !modules[i].dump_complete)
                all_read = 0;
#endif
#ifdef ND_RESOLVE_EXPORTS
            resolve_module_exports(pid, &modules[i]);
            if (!modules[i].resolution_complete)
                all_read = 0;
#endif
            if (i != 0)
                fputc(',', out);
            write_module(out, &modules[i]);
#ifdef ND_MODULE_LAYOUT
            free(modules[i].segments);
            modules[i].segments = NULL;
#endif
#ifdef ND_RESOLVE_EXPORTS
            free(modules[i].exports);
            modules[i].exports = NULL;
#endif
            fflush(out);
            if (!modules[i].read_attempted || modules[i].read_result != 0)
                all_read = 0;
        }
    }

    errno = 0;
    const pid_t final_pid = firmware_ok && pid > 0
                               ? find_shellui(NULL, &final_scope) : -1;
    const int final_error = firmware_ok && pid > 0 && final_pid <= 0 ? errno : 0;
    const int same_process = pid > 0 && pid == final_pid;
    fprintf(out,
            "],\"finalPid\":%d,\"finalProcessError\":%d,"
            "\"sameProcess\":%s,\"finalCredentialScope\":",
            (int)final_pid, final_error, same_process ? "true" : "false");
    write_scope(out, &final_scope);
    fputs(",\"complete\":true}\n", out);
    const int write_failed = ferror(out);
    const int close_failed = fclose(out) != 0;
    if (write_failed || close_failed)
        return 1;
    return all_read && same_process ? 0 : 2;
}
#endif
