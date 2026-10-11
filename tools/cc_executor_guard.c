/* SPDX-License-Identifier: GPL-3.0-or-later
 * Fixed read-only CC pointer route capture. No ptrace, Mono calls, traversal,
 * object allocation in ShellUI, target writes, hooks, or module loading.
 * Shared helpers retain the original process/SELF/credential checks.
 */
#define ND_DUMP_MODULES
#define ND_MODULE_HELPERS_ONLY
/* The installer owns its SDK init wrapper. Do not export a second one. */
#define __wrap___patch_init __attribute__((unused)) static nd_cc_unused_patch_init
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-function"
#include "module_probe.c"
#undef __wrap___patch_init
#pragma clang diagnostic pop
#include <time.h>
#include <fcntl.h>

#include "cc_executor_guard.h"

#define VM_LIMIT (4U * 1024U * 1024U)
#define READ_LIMIT 8192U
#define RECORD_LIMIT 48U
#define RECORD_BYTES 520U

struct read_record {
    const char *name;
    uintptr_t address;
    size_t size;
    unsigned char initial[RECORD_BYTES], final[RECORD_BYTES];
    int initial_error, final_error, attempted, final_attempted, stable;
    int map_index;
};
struct registry_capture {
    struct read_record records[RECORD_LIMIT];
    size_t count, remote_bytes_requested;
    unsigned char *vm_raw;
    size_t vm_bytes, vm_records;
    int vm_error, vm_accepted, vm_capture_error;
    struct credential_scope vm_scope;
};

static int reg_read(pid_t pid, struct registry_capture *r, uintptr_t address,
                    void *dest, size_t size)
{
    if (!size || size > RECORD_BYTES || address < 0x10000 || address >= USER_VADDR_END ||
        size > USER_VADDR_END - address || size > READ_LIMIT - r->remote_bytes_requested)
        return EINVAL;
    r->remote_bytes_requested += size;
    for (size_t done = 0; done < size;) {
        size_t n = 0x1000U - ((address + done) & 0xfffU);
        if (n > size - done) n = size - done;
        errno = 0;
        if (kernel_proc_copyout(pid, (intptr_t)(address + done),
                                (unsigned char *)dest + done, n) != 0)
            return errno ? errno : EIO;
        done += n;
    }
    return 0;
}

static int module_range(const struct module_result *m, uintptr_t addr,
                        size_t size, unsigned required, int allow_bss)
{
    for (size_t i = 0; i < m->segment_count; ++i) {
        const struct segment_result *s = &m->segments[i];
        const uint64_t length = allow_bss ? s->program_header.p_memsz : s->program_header.p_filesz;
        if ((s->program_header.p_flags & required) == required && addr >= s->address &&
            addr - s->address <= length && size <= length - (addr - s->address))
            return (int)i;
    }
    return -1;
}

/* Admit only the SDK kinfo_vmentry prefix/stride, sorted nonoverlapping lower
 * user mappings and known protection bits. Unknown layouts stop heap reads.
 * Paths are variable-length and never interpreted as instructions.
 */
static int query_maps(pid_t pid, struct registry_capture *r)
{
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_VMMAP, pid};
    size_t needed = 0;
    if (sysctl(mib, 4, NULL, &needed, NULL, 0) != 0) return errno ? errno : EIO;
    if (!needed || needed > VM_LIMIT) return EOVERFLOW;
    size_t capacity = needed + needed / 8;
    if (capacity > VM_LIMIT) capacity = VM_LIMIT;
    r->vm_raw = malloc(capacity);
    if (!r->vm_raw) return ENOMEM;
    size_t used = capacity;
    if (sysctl(mib, 4, r->vm_raw, &used, NULL, 0) != 0) return errno ? errno : EIO;
    if (!used || used > capacity) return EOVERFLOW;
    r->vm_bytes = used;
    uint64_t previous_end = 0;
    for (size_t off = 0; off < used;) {
        int stride = 0;
        if (used - off < sizeof(stride)) return EPROTO;
        memcpy(&stride, r->vm_raw + off, sizeof(stride));
        if (stride < (int)offsetof(struct kinfo_vmentry, kve_path) ||
            stride > (int)sizeof(struct kinfo_vmentry) || (stride & 3) ||
            (size_t)stride > used - off) return EPROTO;
        struct kinfo_vmentry e = {0};
        memcpy(&e, r->vm_raw + off, (size_t)stride);
        if (e.kve_start >= e.kve_end || e.kve_end > USER_VADDR_END ||
            e.kve_start < previous_end || (e.kve_start & 0xfff) || (e.kve_end & 0xfff) ||
            (e.kve_protection & ~(KVME_PROT_READ | KVME_PROT_WRITE | KVME_PROT_EXEC))) return EPROTO;
        previous_end = e.kve_end;
        ++r->vm_records;
        off += (size_t)stride;
    }
    r->vm_accepted = r->vm_records > 0;
    return r->vm_accepted ? 0 : EPROTO;
}

static int maps_with_scope(pid_t pid, struct registry_capture *r)
{
    struct credential_scope *s = &r->vm_scope;
    const pid_t self = getpid();
    uint8_t saved_caps[16], saved_attrs[32], caps[16], attrs[32];
    int caps_attempted = 0, attrs_attempted = 0, error = 0;
    s->attempted = 1;
    if (kernel_get_ucred_caps(self, saved_caps) != 0 ||
        kernel_get_ucred_attrs(self, saved_attrs) != 0) {
        s->setup_error = errno ? errno : EIO;
        return s->setup_error;
    }
    memcpy(caps, saved_caps, sizeof(caps)); memcpy(attrs, saved_attrs, sizeof(attrs));
    caps[5] = 0x1c; caps[7] = 0x40; caps[15] |= 0x40; attrs[3] |= 0x80;
    errno = 0; caps_attempted = 1;
    if (kernel_set_ucred_caps(self, caps) != 0) { error = s->setup_error = errno ? errno : EIO; goto restore; }
    errno = 0; attrs_attempted = 1;
    if (kernel_set_ucred_attrs(self, attrs) != 0) { error = s->setup_error = errno ? errno : EIO; goto restore; }
    error = s->query_error = query_maps(pid, r);
restore:
    if (attrs_attempted) {
        errno = 0;
        if (kernel_set_ucred_attrs(self, saved_attrs) != 0) s->restore_attrs_error = errno ? errno : EIO;
    }
    if (caps_attempted) {
        errno = 0;
        if (kernel_set_ucred_caps(self, saved_caps) != 0) s->restore_caps_error = errno ? errno : EIO;
    }
    errno = 0;
    const int caps_readback = kernel_get_ucred_caps(self, caps);
    const int caps_error = caps_readback ? (errno ? errno : EIO) : 0;
    errno = 0;
    const int attrs_readback = kernel_get_ucred_attrs(self, attrs);
    const int attrs_error = attrs_readback ? (errno ? errno : EIO) : 0;
    if (caps_error || attrs_error) s->restore_verify_error = caps_error ? caps_error : attrs_error;
    else if (memcmp(caps, saved_caps, sizeof(caps)) || memcmp(attrs, saved_attrs, sizeof(attrs))) s->restore_verify_error = EIO;
    s->restore_error = s->restore_attrs_error ? s->restore_attrs_error :
                       s->restore_caps_error ? s->restore_caps_error : s->restore_verify_error;
    s->restored = !s->restore_error;
    if (!s->restored) { r->vm_accepted = 0; return s->restore_error; }
    return error;
}

static int readable_map(const struct registry_capture *r, uintptr_t address, size_t size)
{
    if (!r->vm_accepted || address < 0x10000 || address >= USER_VADDR_END ||
        size > USER_VADDR_END - address) return -1;
    int index = 0;
    for (size_t off = 0; off < r->vm_bytes; ++index) {
        struct kinfo_vmentry e = {0};
        int stride; memcpy(&stride, r->vm_raw + off, sizeof(stride));
        memcpy(&e, r->vm_raw + off, (size_t)stride);
        if ((e.kve_protection & KVME_PROT_READ) && address >= e.kve_start &&
            address < e.kve_end && size <= e.kve_end - address) return index;
        off += (size_t)stride;
    }
    return -1;
}

static struct read_record *record_read(pid_t pid, struct registry_capture *r,
                                      const char *name, uintptr_t address,
                                      size_t size, int require_map)
{
    if (r->count >= RECORD_LIMIT || size > sizeof(r->records[0].initial)) return NULL;
    struct read_record *v = &r->records[r->count++];
    v->name = name; v->address = address; v->size = size;
    v->map_index = require_map ? readable_map(r, address, size) : -1;
    if (require_map && v->map_index < 0) { v->initial_error = EACCES; return v; }
    v->attempted = 1;
    v->initial_error = reg_read(pid, r, address, v->initial, size);
    return v;
}

static uintptr_t record_pointer(const struct read_record *v)
{
    uintptr_t p = 0;
    if (v && v->attempted && !v->initial_error && v->size >= sizeof(p)) memcpy(&p, v->initial, sizeof(p));
    return p;
}

struct route_module_profile {
    const char *role, *name, *installed_path, *capture_path;
    uintptr_t aot_offset;
    const char *mvid;
    size_t fingerprint_count;
    struct { uintptr_t offset; unsigned char bytes[16]; } fingerprints[10];
};
struct route_vtable_profile {
    const char *name;
    uintptr_t slot_offset, recipe_offset;
    unsigned char recipe[4];
};
#include "cc_executor_native_route_1320.h"

/* All object offsets below are established by getters/constructors in the
 * exact AOT profiles. A live expected vtable comes from the module GOT slot
 * used by an allocator for the exact local TypeDef, not guessed MonoClass
 * offsets. Null/uninitialized vtable slots stop this reader. */
static void load_installed_header_in_memory(struct module_result *m)
{
    FILE *input = fopen(m->installed_path, "rb");
    if (!input) { m->capture_error = errno ? errno : EIO; return; }
    errno = 0;
    m->capture_bytes = fread(m->installed_metadata, 1, sizeof(m->installed_metadata), input);
    const int error = ferror(input) ? (errno ? errno : EIO) : 0;
    const int closed = fclose(input);
    if (error || closed || !m->capture_bytes) {
        m->capture_error = error ? error : errno ? errno : EIO; return;
    }
    memcpy(m->installed_header, m->installed_metadata,
           m->capture_bytes < HEADER_BYTES ? m->capture_bytes : HEADER_BYTES);
}

static const char *guard_module(pid_t pid, struct registry_capture *r,
                               struct module_result *m,
                               const struct route_module_profile *p)
{
    inspect_module(pid, m);
    if (m->lookup_result || m->base <= 0 || !m->read_attempted ||
        m->read_result || m->bytes_read != HEADER_BYTES) return "module_unavailable";
    load_installed_header_in_memory(m);
    if (parse_self_layout(m)) return "module_self_layout_failed";
    for (size_t i = 0; i < p->fingerprint_count; ++i) {
        const uintptr_t address = (uintptr_t)m->base + p->fingerprints[i].offset;
        unsigned char raw[16];
        if (module_range(m, address, sizeof(raw), PF_X, 0) < 0 ||
            reg_read(pid, r, address, raw, sizeof(raw)) ||
            memcmp(raw, p->fingerprints[i].bytes, sizeof(raw))) return "code_fingerprint_mismatch";
    }
    if (!p->aot_offset) return NULL; /* Native module: code/SELF/RTTI guards. */
    const intptr_t aot = kernel_dynlib_dlsym(pid, m->handle, "mono_aot_file_info");
    uint64_t version = 0, guid = 0; char mvid[37] = {0};
    if (aot <= 0 || (uintptr_t)aot != (uintptr_t)m->base + p->aot_offset ||
        module_range(m, (uintptr_t)aot, 0xc0, PF_R, 0) < 0 ||
        reg_read(pid, r, (uintptr_t)aot, &version, sizeof(version)) || version != 171 ||
        reg_read(pid, r, (uintptr_t)aot + 0xb8, &guid, sizeof(guid)) ||
        module_range(m, guid, sizeof(mvid), PF_R, 0) < 0 ||
        reg_read(pid, r, guid, mvid, sizeof(mvid)) ||
        memcmp(mvid, p->mvid, sizeof(mvid))) return "aot_mvid_mismatch";
    return NULL;
}

static uintptr_t read_field(pid_t pid, struct registry_capture *r,
                            const char *name, uintptr_t object, size_t offset)
{
    /* Admit the whole interval through the selected field in one mapping,
     * while transferring only its eight bytes. This also rejects overflow. */
    if (!object || (object & 7) || offset > 0x3c0 || readable_map(r, object, offset + 8) < 0) return 0;
    return record_pointer(record_read(pid, r, name, object + offset, 8, 1));
}

static int exact_type(pid_t pid, struct registry_capture *r, const char *name,
                      uintptr_t object, uintptr_t expected_vtable)
{
    if (!expected_vtable || (expected_vtable & 7) || readable_map(r, expected_vtable, 8) < 0) return 0;
    return read_field(pid, r, name, object, 0) == expected_vtable;
}

static const char *capture_native_identity(pid_t pid, struct registry_capture *r,
                                         struct module_result *m, uintptr_t executor)
{
    const uintptr_t base = (uintptr_t)m->base, vt = base + 0x95320;
    if (read_field(pid, r, "native_executor_vtable", executor, 0) != vt)
        return "native_executor_type_mismatch";
    if (module_range(m, vt - 16, 16 + 19 * 8, PF_R, 0) < 0 ||
        module_range(m, base + 0x953b8, 16, PF_R, 0) < 0 ||
        module_range(m, base + 0x8db5f, 20, PF_R, 0) < 0)
        return "native_type_metadata_outside_module";
    struct read_record *meta = record_read(pid, r, "native_vtable_metadata", vt - 16, 16, 1);
    if (!meta || meta->initial_error) return "native_vtable_metadata_unreadable";
    uint64_t top = 1, ti = 0; memcpy(&top, meta->initial, 8); memcpy(&ti, meta->initial + 8, 8);
    if (top || ti != base + 0x953b8) return "native_vtable_rtti_mismatch";
    struct read_record *table = record_read(pid, r, "native_vtable_19_methods", vt, 19 * 8, 1);
    if (!table || table->initial_error) return "native_vtable_unreadable";
    for (size_t i = 0; i < 19; ++i) {
        uintptr_t method = 0; memcpy(&method, table->initial + i * 8, 8);
        if (method != base + native_vtable_offsets[i] || module_range(m, method, 1, PF_X, 0) < 0)
            return "native_vtable_method_mismatch";
    }
    struct read_record *rtti = record_read(pid, r, "native_typeinfo", ti, 16, 1);
    uintptr_t type_name = 0;
    if (!rtti || rtti->initial_error) return "native_typeinfo_unreadable";
    memcpy(&type_name, rtti->initial + 8, 8);
    if (type_name != base + 0x8db5f) return "native_typeinfo_name_pointer_mismatch";
    static const char expected[] = "N4rnps11JSIExecutorE";
    struct read_record *name = record_read(pid, r, "native_rtti_name", type_name, sizeof(expected), 1);
    if (!name || name->initial_error || memcmp(name->initial, expected, sizeof(expected)))
        return "native_rtti_name_mismatch";
    struct read_record *backend = record_read(pid, r, "native_backend_i32", executor + 0x48, 4, 1);
    struct read_record *instance = record_read(pid, r, "native_app_instance_id_i64", executor + 0x70, 8, 1);
    if (!backend || backend->initial_error || !instance || instance->initial_error)
        return "native_identity_fields_unreadable";
    const uintptr_t runtime = read_field(pid, r, "native_runtime_pointer", executor, 0x78);
    const uintptr_t runtime_vt = read_field(pid, r, "native_runtime_vtable_candidate", runtime, 0);
    if (!runtime || !runtime_vt || readable_map(r, runtime_vt, 8) < 0)
        return "native_runtime_unavailable";
    return NULL;
}

/* MonoString prefix is MonoObject(16), int32 length(+16), UTF16(+20).
 * Source corroboration: object-forward.h; AOT ApplicationName06001b12 checks
 * the same +16 length. Field metadata declares sealed System.String. Read
 * only two known fields, at most256 UTF16 units, with a final terminator. */
static const char *capture_string(pid_t pid, struct registry_capture *r,
                                  uintptr_t string, const char *header_name,
                                  const char *text_name, const char *expected)
{
    if (!string || (string & 7)) return "identity_string_null_or_misaligned";
    struct read_record *h = record_read(pid, r, header_name, string, 20, 1);
    if (!h || h->initial_error) return "identity_string_header_unreadable";
    int32_t length = -1; memcpy(&length, h->initial + 16, 4);
    if (length <= 0 || length > 256) return "identity_string_length_out_of_bounds";
    const size_t bytes = ((size_t)length + 1) * 2;
    struct read_record *text = record_read(pid, r, text_name, string + 20, bytes, 1);
    if (!text || text->initial_error) return "identity_string_payload_unreadable";
    uint16_t terminator = 1; memcpy(&terminator, text->initial + (size_t)length * 2, 2);
    if (terminator) return "identity_string_terminator_mismatch";
    for (int32_t i = 0; i < length; ++i) {
        uint16_t c; memcpy(&c, text->initial + (size_t)i * 2, 2);
        if (c < 0x20 || c > 0x7e) return "identity_string_not_printable_ascii";
    }
    if (expected) {
        if (strlen(expected) != (size_t)length) return "control_center_bundle_identity_mismatch";
        for (int32_t i = 0; i < length; ++i)
            if (text->initial[(size_t)i * 2] != (unsigned char)expected[i])
                return "control_center_bundle_identity_mismatch";
    }
    return NULL;
}

static const char *capture_app_identity(pid_t pid, struct registry_capture *r,
                                      struct module_result *m, uintptr_t scene)
{
    const uintptr_t base = (uintptr_t)m->base, slot = base + 0x82340;
    unsigned char recipe[3];
    if (module_range(m, base + 0x52974, 3, PF_R, 0) < 0 ||
        reg_read(pid, r, base + 0x52974, recipe, 3) || memcmp(recipe, "\x0d\x01\x2d", 3) ||
        module_range(m, slot, 8, PF_R | PF_W, 1) < 0)
        return "application_identity_type_recipe_mismatch";
    uintptr_t vt = record_pointer(record_read(pid, r, "exception_data_expected_vtable", slot, 8, 1));
    uintptr_t data = read_field(pid, r, "render_exception_handler_data", scene, 0x358);
    if (!exact_type(pid, r, "exception_data_actual_vtable", data, vt))
        return "application_identity_type_mismatch";
    uintptr_t name = read_field(pid, r, "application_name_string", data, 0x10);
    uintptr_t bundle = read_field(pid, r, "application_bundle_string", data, 0x40);
    const char *failure = capture_string(pid, r, name, "application_name_header", "application_name_utf16le", "rnps-control-center");
    if (failure) return failure;
    return capture_string(pid, r, bundle, "application_bundle_header", "application_bundle_utf16le",
                          "/system_ex/rnps/apps/NPXS40003/application.ps.bundle");
}


static const struct read_record *named_record(const struct registry_capture *r, const char *name)
{
    for (size_t i = 0; i < r->count; ++i)
        if (!strcmp(r->records[i].name, name)) return &r->records[i];
    return NULL;
}
static void result_text(const struct registry_capture *r, const char *name, char dest[257])
{
    const struct read_record *v = named_record(r, name);
    if (!v || v->initial_error || !v->attempted || v->size < 2 || v->size > 514 || (v->size & 1)) return;
    const size_t count = v->size / 2 - 1;
    for (size_t i = 0; i < count; ++i) {
        uint16_t c; memcpy(&c, v->initial + i * 2, 2);
        if (c < 0x20 || c > 0x7e) { dest[0] = 0; return; }
        dest[i] = (char)c;
    }
    dest[count] = 0;
}
int nd_cc_guard_find_shellui(pid_t *result)
{
    if (!result) return EINVAL;
    *result = -1;
    if (kernel_get_fw_version() != UINT32_C(0x13200006)) return ENOTSUP;
    struct credential_scope scope = {0};
    const pid_t pid = find_shellui(NULL, &scope);
    if (!scope.restored) return EACCES;
    if (pid <= 0) return ESRCH;
    *result = pid;
    return 0;
}

int nd_cc_guard_capture(pid_t expected_pid, struct nd_cc_identity *result)
{
    if (!result) return EINVAL;
    memset(result, 0, sizeof(*result));
    result->requested_pid = expected_pid;
    if (expected_pid <= 0) { result->stage = "arguments"; result->failure = "invalid_pid"; return EINVAL; }
    const uint32_t fw = kernel_get_fw_version();
    static struct registry_capture r;
    memset(&r, 0, sizeof(r));
    struct credential_scope initial = {0}, final = {0};
    struct module_result modules[4] = {0};
    int guard_accepted[4] = {0}, all_identity = 1, route_complete = 0;
    pid_t pid = -1, final_pid = -1;
    uintptr_t expected_vt[5] = {0}, native_executor = 0, js_thread = 0;
    const char *failure = "firmware_not_exact", *stage = "firmware";
    for (size_t i = 0; i < 4; ++i) {
        modules[i].name = module_profiles[i].name;
        modules[i].installed_path = module_profiles[i].installed_path;
        modules[i].capture_path = module_profiles[i].capture_path;
        modules[i].dump_prefix = module_profiles[i].role;
    }
    if (fw != UINT32_C(0x13200006)) goto finish;
    stage = "process";
    pid = find_shellui(NULL, &initial);
    if (pid <= 0 || pid != expected_pid || !initial.restored) { failure = "process_or_initial_credentials"; goto finish; }
    for (size_t i = 0; i < 4; ++i) {
        stage = module_profiles[i].role;
        failure = guard_module(pid, &r, &modules[i], &module_profiles[i]);
        if (failure) goto finish;
        guard_accepted[i] = 1;
    }
    stage = "vtable_recipes";
    for (size_t i = 0; i < 5; ++i) {
        const uintptr_t address = (uintptr_t)modules[2].base + vtable_profiles[i].recipe_offset;
        unsigned char raw[4];
        if (module_range(&modules[2], address, 4, PF_R, 0) < 0 ||
            reg_read(pid, &r, address, raw, 4) || memcmp(raw, vtable_profiles[i].recipe, 4)) {
            failure = "vtable_recipe_mismatch"; goto finish;
        }
    }
    stage = "maps";
    r.vm_error = maps_with_scope(pid, &r);
    if (r.vm_error || !r.vm_accepted || !r.vm_scope.restored || r.vm_capture_error) {
        failure = "vmmap_or_credentials_failed"; goto finish;
    }
    /* Capture the five expected type slots before following the application.
     * These are single MonoVTable pointers, not static-field double pointers. */
    for (size_t i = 0; i < 5; ++i) {
        stage = vtable_profiles[i].name;
        const uintptr_t address = (uintptr_t)modules[2].base + vtable_profiles[i].slot_offset;
        if (module_range(&modules[2], address, 8, PF_R | PF_W, 1) < 0) {
            failure = "vtable_slot_outside_rw_module"; goto reread;
        }
        expected_vt[i] = record_pointer(record_read(pid, &r, stage, address, 8, 1));
        if (!expected_vt[i] || readable_map(&r, expected_vt[i], 8) < 0) {
            failure = "expected_vtable_uninitialized_or_unreadable"; goto reread;
        }
    }
    stage = "menu_manager_static_slot";
    const uintptr_t slot = (uintptr_t)modules[0].base + 0x189e18;
    if (module_range(&modules[0], slot, 8, PF_R | PF_W, 1) < 0) {
        failure = "manager_slot_outside_rw_module"; goto reread;
    }
    uintptr_t object = record_pointer(record_read(pid, &r, stage, slot, 8, 1));
    stage = "menu_manager_static_cell";
    object = read_field(pid, &r, stage, object, 0);
    if (!object) { failure = "manager_unavailable"; goto reread; }
#define FOLLOW(label, offset) do { \
    stage = label; object = read_field(pid, &r, stage, object, offset); \
    if (!object) { failure = "field_null_or_unreadable"; goto reread; } \
} while (0)
#define TYPE(label, index) do { \
    stage = label; if (!exact_type(pid, &r, stage, object, expected_vt[index])) { \
        failure = "object_type_mismatch_or_unreadable"; goto reread; } \
} while (0)
    FOLLOW("manager_scene", 0x30);
    FOLLOW("stack_scene", 0x360);
    FOLLOW("scene_render", 0x350);
    const uintptr_t render_scene = object;
    FOLLOW("render_application", 0x380);
    TYPE("application_actual_vtable", 4);
    FOLLOW("application_context", 0x38);
    TYPE("context_actual_vtable", 0);
    FOLLOW("context_data", 0x30);
    TYPE("data_actual_vtable", 1);
    FOLLOW("data_bridge", 0x18);
    TYPE("bridge_actual_vtable", 2);
    FOLLOW("bridge_executor", 0x18);
    TYPE("executor_actual_vtable", 3);
    stage = "executor_native";
    native_executor = read_field(pid, &r, stage, object, 0x80);
    if (!native_executor || readable_map(&r, native_executor, 8) < 0) {
        failure = "native_executor_null_or_unreadable"; goto reread;
    }
    stage = "executor_js_thread";
    js_thread = read_field(pid, &r, stage, object, 0x40);
    if (!js_thread || readable_map(&r, js_thread, 8) < 0) {
        failure = "js_thread_null_or_unreadable"; goto reread;
    }
    stage = "native_identity";
    failure = capture_native_identity(pid, &r, &modules[3], native_executor);
    if (failure) goto reread;
    stage = "application_identity";
    failure = capture_app_identity(pid, &r, &modules[1], render_scene);
    if (failure) goto reread;
    route_complete = 1; failure = NULL;
#undef FOLLOW
#undef TYPE
reread:
    for (size_t i = 0; i < r.count; ++i) {
        struct read_record *v = &r.records[i];
        if (!v->attempted || v->initial_error) continue;
        if (readable_map(&r, v->address, v->size) < 0) {
            v->final_error = EACCES;
            if (!failure) { stage = v->name; failure = "reread_mapping_failed"; }
            continue;
        }
        v->final_attempted = 1;
        v->final_error = reg_read(pid, &r, v->address, v->final, v->size);
        v->stable = !v->final_error && !memcmp(v->initial, v->final, v->size);
        if (!v->stable && !failure) { stage = v->name; failure = "route_changed_during_capture"; }
    }
finish:
    if (pid > 0) {
        for (size_t i = 0; i < 4; ++i) {
            if (modules[i].lookup_attempted) check_module_identity(pid, &modules[i]);
            all_identity &= modules[i].identity_unchanged;
        }
        final_pid = find_shellui(NULL, &final);
    } else all_identity = 0;
    if (!failure && !all_identity) failure = "module_identity_changed";
    if (!failure && (final_pid != pid || !final.restored)) failure = "process_or_final_credentials";
    const int complete = route_complete && !failure && all_identity && initial.restored &&
        final.restored && r.vm_scope.restored && final_pid == pid;
    result->firmware = fw; result->initial_pid = pid; result->final_pid = final_pid;
    result->stage = stage; result->failure = failure; result->complete = complete;
    result->credentials_restored = initial.restored && final.restored && r.vm_scope.restored;
    result->records = r.count; result->bytes_requested = r.remote_bytes_requested;
    result->vmmap_bytes = r.vm_bytes; result->vmmap_records = r.vm_records;
    result->stable = r.count > 0;
    for (size_t i = 0; i < r.count; ++i) result->stable &= r.records[i].stable;
    for (size_t i = 0; i < 4; ++i) {
        result->modules[i].name = modules[i].name; result->modules[i].handle = modules[i].handle;
        result->modules[i].base = (uintptr_t)modules[i].base;
        result->modules[i].guard_accepted = guard_accepted[i];
        result->modules[i].identity_unchanged = modules[i].identity_unchanged;
    }
#define OBS(member, label) result->member = record_pointer(named_record(&r, label))
    OBS(application, "render_application"); OBS(context, "application_context");
    OBS(data, "context_data"); OBS(bridge, "data_bridge"); OBS(managed_executor, "bridge_executor");
    OBS(native_executor, "executor_native"); OBS(js_thread, "executor_js_thread");
    OBS(native_vtable, "native_executor_vtable"); OBS(runtime, "native_runtime_pointer");
    OBS(runtime_vtable_candidate, "native_runtime_vtable_candidate");
    OBS(app_instance_id, "native_app_instance_id_i64");
#undef OBS
    const struct read_record *backend = named_record(&r, "native_backend_i32");
    if (backend && !backend->initial_error && backend->attempted) memcpy(&result->backend, backend->initial, 4);
    const struct read_record *methods = named_record(&r, "native_vtable_19_methods");
    if (methods && !methods->initial_error && methods->attempted) memcpy(result->native_methods, methods->initial, sizeof(result->native_methods));
    result_text(&r, "application_name_utf16le", result->application_name);
    result_text(&r, "application_bundle_utf16le", result->bundle_path);
    free(r.vm_raw); r.vm_raw = NULL;
    for (size_t i = 0; i < 4; ++i) free(modules[i].segments);
    return complete && result->stable ? 0 : EIO;
}

int nd_cc_guard_libc(pid_t expected_pid, struct nd_cc_libc_identity *result)
{
    /* Evidence: capture/ui-bridge/eh-barrier/libc-dynamic-fde.json,
     * installerGuards. Offsets and instruction prefixes belong to FW13.20;
     * the handle and base are resolved by module name in the target process.
     * ASLR must not require recompiling this payload. */
    static const struct route_module_profile profile = {
        "libc", "libSceLibcInternal.sprx", "/system/common/lib/libSceLibcInternal.sprx", NULL, 0, "", 5, {
            {0x1ecf0, {0x55,0x41,0x56,0x53,0x48,0x89,0xfb,0xe8,0xb4,0x03,0x00,0x00,0x89,0xc5,0xe8,0xdd}},
            {0x1f0d0, {0x55,0x48,0x89,0xe5,0x53,0x50,0xe8,0x25,0x36,0x01,0x00,0x48,0x8b,0x38,0x48,0x85}},
            {0x32720, {0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x83,0xec}},
            {0x35c50, {0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec}},
            {0x35bf0, {0x55,0x48,0x89,0xe5,0x41,0x56,0x53,0x48,0x89,0xfb,0x48,0x8d,0x3d,0xbf,0xbf,0x18}},
        }
    };
    if (!result) return EINVAL;
    memset(result, 0, sizeof(*result)); result->module.name = profile.name;
    if (expected_pid <= 0 || kernel_get_fw_version() != UINT32_C(0x13200006)) {
        result->failure = "libc_arguments_or_firmware"; return EINVAL;
    }
    static struct registry_capture r;
    memset(&r, 0, sizeof(r));
    struct module_result module = {0};
    module.name = profile.name; module.installed_path = profile.installed_path; module.dump_prefix = profile.role;
    result->failure = guard_module(expected_pid, &r, &module, &profile);
    if (!result->failure && ((uintptr_t)module.base < 0x10000 ||
            (uintptr_t)module.base >= USER_VADDR_END || ((uintptr_t)module.base & 0x3fff)))
        result->failure = "libc_runtime_base_invalid";
    result->module.guard_accepted = !result->failure;
    if (module.lookup_attempted) check_module_identity(expected_pid, &module);
    if (!result->failure && !module.identity_unchanged) result->failure = "libc_identity_changed";
    result->module.handle = module.handle; result->module.base = (uintptr_t)module.base;
    result->module.identity_unchanged = module.identity_unchanged;
    result->bytes_requested = r.remote_bytes_requested + module.bytes_read;
    if (!result->failure) {
        const uintptr_t base = result->module.base;
        result->cxa_begin_catch = base + 0x1ecf0; result->cxa_end_catch = base + 0x1f0d0;
        result->personality = base + 0x32720; result->add_dynamic_fde = base + 0x35c50;
        result->iterate_fde_cache = base + 0x35bf0; result->accepted = 1;
    }
    free(module.segments);
    return result->accepted ? 0 : EIO;
}
