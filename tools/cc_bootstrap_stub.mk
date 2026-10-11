# Build only. No deployment, injection or tests.
ifndef PS5_PAYLOAD_SDK
$(error Set PS5_PAYLOAD_SDK to your ps5-payload-sdk checkout)
endif
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
.PHONY: all
all: ../build/cc-bootstrap-stub.bin
../build/cc-bootstrap-stub.o: cc_bootstrap_stub.c cc_bootstrap_stub.h
	mkdir -p ../build
	$(CC) -x c++ -std=c++17 -Os -Wall -Wextra -Werror -ffreestanding -fno-builtin -fPIC -fvisibility=hidden -fvisibility-nodllstorageclass=hidden -fno-stack-protector -fexceptions -funwind-tables -fno-rtti -fno-threadsafe-statics -mno-red-zone -mgeneral-regs-only -c $< -o $@
../build/cc-bootstrap-stub.elf: ../build/cc-bootstrap-stub.o cc_bootstrap_stub.ld
	$(LD) --static --no-undefined -T cc_bootstrap_stub.ld ../build/cc-bootstrap-stub.o -o $@
../build/cc-bootstrap-stub.bin: ../build/cc-bootstrap-stub.elf
	$(OBJCOPY) -O binary $< $@
