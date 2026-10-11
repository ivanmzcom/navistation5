# Build only. Publication is disabled by default; no deployment or tests.
ifndef PS5_PAYLOAD_SDK
$(error Set PS5_PAYLOAD_SDK to your ps5-payload-sdk checkout)
endif
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
INSTALLER_ENABLE_PUBLICATION ?= 0
ifeq ($(INSTALLER_ENABLE_PUBLICATION),0)
INSTALLER_MODE := disabled
else ifeq ($(INSTALLER_ENABLE_PUBLICATION),1)
INSTALLER_MODE := enabled
else
$(error INSTALLER_ENABLE_PUBLICATION must be exactly 0 or 1)
endif
INSTALLER_OUT := ../build/navidrome-cc-installer-$(INSTALLER_MODE).elf
INSTALLER_PACKAGE ?= ../build/cc-install-payload.h
INSTALLER_SOURCES := cc_installer.c cc_executor_guard.c cc_bootstrap_observe.c remote_trace.c raw_syscall4.S
INSTALLER_DEPS := $(INSTALLER_SOURCES) remote_trace_core.inc remote_trace.h \
  cc_executor_guard.h cc_bootstrap_stub.h cc_bootstrap_observe.h cc_executor_native_route_1320.h \
  shellui_module_helpers.inc $(INSTALLER_PACKAGE) cc_installer.mk
.PHONY: all
all: $(INSTALLER_OUT)
$(INSTALLER_OUT): $(INSTALLER_DEPS)
	mkdir -p ../build
	$(CC) $(CPPFLAGS) -std=c11 -O2 -Wall -Wextra -Werror \
	  -I$(PS5_SYSROOT)/user/homebrew/include \
	  -DND_CC_ENABLE_PUBLICATION=$(INSTALLER_ENABLE_PUBLICATION) -DND_CC_PAYLOAD_HEADER='"$(INSTALLER_PACKAGE)"' \
	  -Wl,--wrap=__patch_init -o $@ $(INSTALLER_SOURCES) \
	  $(PS5_SYSROOT)/user/homebrew/lib/libcrypto.a
