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

#define PROCESS_CAPTURE_PATH "/data/navidrome-proc-records.bin"
#define EXPECTED_FW UINT32_C(0x13200000)
#define MAX_PROCESS_BYTES (16U * 1024U * 1024U)
#define HEADER_BYTES 64U
#define SELF_HEADER_BYTES 4096U

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
                                    struct process_diagnostics *diagnostics) {
    if (diagnostics == NULL)
        return;
    diagnostics->returned_bytes = length;
    if (length >= sizeof(diagnostics->first_record_size))
        memcpy(&diagnostics->first_record_size, records, sizeof(diagnostics->first_record_size));
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
        diagnostics->capture_error = written != length ? (write_error ? write_error : EIO) : errno;
        return;
    }
    diagnostics->capture_bytes = length;
}

static pid_t query_shellui(struct process_diagnostics *diagnostics) {
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
    const size_t minimum_record =
        offsetof(struct kinfo_proc, ki_comm) + sizeof(((struct kinfo_proc *)0)->ki_comm);

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
            const size_t copy_size =
                (size_t)record_size < sizeof(record) ? (size_t)record_size : sizeof(record);
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

static pid_t find_shellui(struct process_diagnostics *diagnostics, struct credential_scope *scope) {
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
    if (kernel_get_ucred_caps(self, caps) != 0 || kernel_get_ucred_attrs(self, attrs) != 0) {
        scope->restore_verify_error = errno ? errno : EIO;
    } else if (memcmp(caps, saved_caps, sizeof(caps)) != 0 ||
               memcmp(attrs, saved_attrs, sizeof(attrs)) != 0) {
        scope->restore_verify_error = EIO;
    }
    scope->restore_error = scope->restore_attrs_error  ? scope->restore_attrs_error
                           : scope->restore_caps_error ? scope->restore_caps_error
                                                       : scope->restore_verify_error;
    scope->restored = scope->restore_error == 0;
    if (scope->restore_error != 0) {
        result = -1;
        result_error = scope->restore_error;
    }
    errno = result_error;
    return result;
}

static int read_header(pid_t pid, intptr_t address, struct module_result *result) {
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
        const int rc =
            kernel_proc_copyout(pid, (intptr_t)current, result->header + result->bytes_read, count);
        if (rc != 0)
            return rc;
        result->bytes_read += count;
    }
    return 0;
}

static void inspect_module(pid_t pid, struct module_result *result) {
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
}

static int parse_self_layout(struct module_result *result) {
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
        if (header.e_ident[EI_CLASS] != ELFCLASS64 || header.e_ident[EI_DATA] != ELFDATA2LSB ||
            header.e_ident[EI_VERSION] != EV_CURRENT || header.e_version != EV_CURRENT ||
            header.e_machine != EM_X86_64 || header.e_ehsize != sizeof(Elf64_Ehdr) ||
            header.e_phentsize != sizeof(Elf64_Phdr) || header.e_phnum == 0 ||
            header.e_phnum > MAX_PROGRAM_HEADERS || header.e_phoff < sizeof(Elf64_Ehdr) ||
            header.e_phoff > length - offset ||
            (size_t)header.e_phnum * sizeof(Elf64_Phdr) > length - offset - (size_t)header.e_phoff)
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

    struct segment_result *segments = calloc(result->elf_header.e_phnum, sizeof(*segments));
    if (segments == NULL)
        return ENOMEM;
    int error = 0;
    uint64_t minimum_vaddr = UINT64_MAX;
    size_t count = 0;
    uint64_t total_size = 0;
    for (unsigned int i = 0; i < result->elf_header.e_phnum; ++i) {
        Elf64_Phdr phdr;
        memcpy(&phdr,
               metadata + result->elf_offset + result->elf_header.e_phoff +
                   (size_t)i * sizeof(phdr),
               sizeof(phdr));
        if (phdr.p_type != PT_LOAD || (phdr.p_flags & 7U) == 0)
            continue;
        if (phdr.p_vaddr < minimum_vaddr)
            minimum_vaddr = phdr.p_vaddr;
        if (phdr.p_filesz > phdr.p_memsz || phdr.p_memsz > UINT64_MAX - phdr.p_vaddr ||
            phdr.p_filesz > UINT64_MAX - phdr.p_offset ||
            phdr.p_vaddr > UINTPTR_MAX - (uintptr_t)result->base ||
            phdr.p_memsz > UINTPTR_MAX - ((uintptr_t)result->base + phdr.p_vaddr) ||
            phdr.p_vaddr > USER_VADDR_END - (uintptr_t)result->base ||
            phdr.p_memsz > USER_VADDR_END - ((uintptr_t)result->base + phdr.p_vaddr) ||
            phdr.p_filesz > MAX_MODULE_BYTES - total_size ||
            (phdr.p_align > 1 && ((phdr.p_align & (phdr.p_align - 1)) != 0 ||
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
                                         "/data/navidrome-%s-seg-%u.bin", result->dump_prefix, i);
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

static void check_module_identity(pid_t pid, struct module_result *result) {
    result->identity_checked = 1;
    errno = 0;
    result->final_lookup_result = kernel_dynlib_handle(pid, result->name, &result->final_handle);
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
