/* One-shot native CC entry. This is an inactive payload image, not an installer. */
#ifndef ND_CC_BOOTSTRAP_STUB_H
#define ND_CC_BOOTSTRAP_STUB_H
#include <stdint.h>
#include <stddef.h>

#define ND_STUB_PAGE 0x4000U
#define ND_STUB_STATE_OFFSET 0x4000U
#define ND_STUB_SCRIPT_OFFSET 0x8000U
#define ND_STUB_SOURCE_URL_OFFSET 0x7000U
#define ND_STUB_MAGIC UINT64_C(0x4e44434353545542)
#define ND_STUB_MAX_FDES 16U
#ifdef __cplusplus
#define ND_STATIC_ASSERT static_assert
#else
#define ND_STATIC_ASSERT _Static_assert
#endif

/* NativeExtensions accesses message+0, static byte+8, exception type+16.
 * Own zeroed storage, deliberately larger than its observed 20-byte extent;
 * this is not a Mono object or a claim about the marshaler's class size. */
struct nd_native_exception {
    uint64_t message;
    uint8_t is_static;
    uint8_t padding[7];
    int32_t type;
    uint8_t reserved[44];
};
ND_STATIC_ASSERT(offsetof(struct nd_native_exception, type) == 16, "native exception type");
ND_STATIC_ASSERT(sizeof(struct nd_native_exception) == 64, "owned exception storage");

struct nd_fde_expectation { uint64_t fde, pc_start, pc_end; };

struct nd_bootstrap_state {
    uint64_t magic;
    uint64_t executor, runtime, original_vtable, cloned_vtable;
    uint64_t original_call, evaluate, free_string;
    uint64_t script, script_bytes, source_url;
    uint64_t app_instance_id;
    uint32_t state; /* 0 armed, 1 entered, 2 bootstrap finished / forward ready */
    uint32_t active_calls; /* Workers only; excludes original after tail jump. */
    uint32_t vtable_restored;
    uint32_t identity_accepted;
    uint32_t evaluation_attempted;
    int32_t exception_type;
    uint32_t exception_static;
    uint32_t exception_freed;
    uint32_t restore_conflict;
    uint32_t message_bytes;
    char message[192];
    /* Keep Itanium ABI metadata immediately before all 19 original slots. */
    uint64_t cloned_table[21];
    /* ShellUI's own libc bindings, guarded by the installer. These offsets
     * are also used by tail thunks and the linker's indirect personality slot.
     * No payload C++ runtime is linked or called inside ShellUI. */
    uint64_t cxa_begin_catch; /* +0x1f0 */
    uint64_t cxa_end_catch;   /* +0x1f8 */
    uint64_t add_dynamic_fde; /* +0x200, void(uintptr_t individual_fde) */
    uint64_t iterate_fde_cache; /* +0x208, void(callback(start,end,fde,group)) */
    uint64_t personality; /* +0x210: DW.ref.__gxx_personality_v0 aliases this */
    uint32_t eh_expected_count;
    uint32_t eh_verified_mask;
    uint32_t eh_registered_count; /* Calls made, NOT proof of registration. */
    uint32_t cpp_exception_caught;
    uint32_t eh_failure; /* 0 OK; 1 bindings; 2 image; 3 count; 4 verification */
    uint32_t forward_ready;
    struct nd_fde_expectation eh_expected[ND_STUB_MAX_FDES];
    uint64_t feature0_setter;
    uint32_t feature0_enabled;
    uint32_t feature0_attempted;
    int32_t feature0_result;
    uint32_t feature0_reserved;
    uint64_t feature0_get_service, feature0_get_info;
    uint32_t feature0_gate_enabled, feature0_gate_attempted;
    int32_t feature0_gate_result, feature0_gate_service;
    int32_t feature0_gate_current_result, feature0_gate_slot_result;
    uint32_t feature0_gate_queries, feature0_gate_canaries;
    struct { int32_t src_id, service, playing, progress, duration; uint32_t uri_head, context_head, seen; } feature0_gate_shape[2];
};
ND_STATIC_ASSERT(offsetof(struct nd_bootstrap_state, cxa_begin_catch) == 0x1f0, "begin thunk");
ND_STATIC_ASSERT(offsetof(struct nd_bootstrap_state, cxa_end_catch) == 0x1f8, "end thunk");
ND_STATIC_ASSERT(offsetof(struct nd_bootstrap_state, personality) == 0x210, "personality slot");
ND_STATIC_ASSERT(sizeof(struct nd_bootstrap_state) < 0x3000, "state/source URL separation");
#endif
