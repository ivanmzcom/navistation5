/* SPDX-License-Identifier: GPL-3.0-or-later
 * Four-argument local syscall through the SDK's libkernel gate.
 * SysV AMD64 returns { int64_t rax; uint64_t carry; } in RAX and RDX.
 * The SDK __crt_syscall epilogue is RET and preserves the gate's flags.
 */
.text
.global nd_raw_syscall4
.type nd_raw_syscall4,@function
nd_raw_syscall4:
    /* Sixth syscall argument on stack; also align RSP before CALL. */
    pushq $0
    xorl %r9d, %r9d
    call __crt_syscall
    /* No instruction changing EFLAGS may precede this SETC. */
    setc %dl
    movzbl %dl, %edx
    addq $8, %rsp
    ret
.size nd_raw_syscall4,.-nd_raw_syscall4
.section .note.GNU-stack,"",@progbits
