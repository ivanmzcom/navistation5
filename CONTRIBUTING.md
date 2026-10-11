# Contributing

Run `npm test` before submitting changes. For UI/native changes, also build with
the exact supported Hermes/SDK toolchain and document what was actually checked
on hardware. Distinguish offline checks from console validation.

Keep configuration in ignored `config.local.json`; never commit tokens, signed
stream URLs, passwords, console reports, Sony binaries or copyrighted media.
Do not weaken firmware, ownership, runtime, rollback or publication guards to
make another firmware work. A new firmware requires a separately established
ABI profile and validation. Changes to the exception barrier require a fresh
source, assembly, CFI and LSDA review before updating its recorded fingerprints.

Contributions are licensed under GPL-3.0-or-later.
