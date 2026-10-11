ENTRY(nd_hook)
SECTIONS {
  . = 0;
  .text : {
    KEEP(*(.text.nd_hook)) *(.text*) *(.rodata*)
    . = ALIGN(8);
    nd_lsda_start = .;
    KEEP(*(.gcc_except_table*))
    nd_lsda_end = .;
    . = ALIGN(8);
    nd_eh_frame_start = .;
    KEEP(*(.eh_frame))
    nd_eh_frame_end = .;
  }
  ASSERT(nd_hook == 0, "hook must be first byte of the mapped image")
  ASSERT(SIZEOF(.text) < 0x4000, "stub exceeds one executable page")
  . = 0x4000;
  .nd_state : { KEEP(*(.nd_state)) }
  /* Indirect pcrel CIE reference to the target pointer supplied in state. */
  DW.ref.__gxx_personality_v0 = nd_state + 0x210;
  ASSERT(nd_state == 0x4000, "unexpected state address")
  ASSERT(SIZEOF(.nd_state) < 0x4000, "state exceeds one writable page")
  /DISCARD/ : {
    *(.comment) *(.note*) *(.eh_frame_hdr)
    *(.data.DW.ref.__gxx_personality_v0)
  }
}
