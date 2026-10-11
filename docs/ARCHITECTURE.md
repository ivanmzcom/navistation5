# Architecture and validation

The native installer finds the unique `SceShellUI` process, stops it for a bounded
transaction, and verifies the exact firmware, module/SELF identities, Control
Center application, executor and runtime. It captures the live PID, executor,
runtime, app instance and JS thread instead of embedding session addresses.
It rechecks the complete identity before publication and restores the vtable and
credential scope. Firmware profiles contain verification fingerprints and ABI
constants; the system modules themselves are not included.

The reviewed bootstrap forwards the original executor call and schedules the
bundled Hermes v89 code on the normal runtime thread. Its exception barrier,
code/layout fingerprints and 131072-byte bytecode limit remain enforced.
Published native storage is retained until ShellUI exits; repeated loads retain
small allocations. An incompatible build is rejected rather than silently
regenerating its review fingerprints.

The JS driver verifies its runtime and module/cache identities, then renders the
custom card through the resident Control Center JSX route. The card signs in via
OpenSubsonic and uses the resident RNPS Media API for playback. No native app,
queue-stream service or HTTP control proxy needs to remain open.

The audio transport keeps an ownership ledger. It does not adopt external audio,
replay lost Play requests, or infer a successful Stop from a submitted command.
The configured Navidrome origin is the only accepted stream origin. Runtime and
sequence checks reject stale requests when a card/session changes.

Repeat loading inspects only the owned frozen controller and its status. An
intact card is preserved; conflicting, failed, removed or disposed controllers
are rejected. There is no automatic replacement or shutdown of active audio.

## Tests and limits

`npm test` exercises 17 transport cases plus three automatic-discovery tests.
The latter compile the actual C identity-policy functions in automatic and
captured modes and execute the actual generated repeat-load JS prelude. They
cover changed-session acceptance, mid-transaction identity/module rejection,
controller preservation and malformed-controller rejection.

Hardware validation in the private development environment confirmed playback
in Home and Rayman, track changes, pause/resume, and two identical automatic ELF
loads in one initialized session. The public build changes server configuration
and clears development login defaults; that build has not yet been exercised on
a console. Reboot validation, other firmware, additional games, credential
persistence and automatic startup loading remain future work.
