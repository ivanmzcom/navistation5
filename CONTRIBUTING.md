# Contributing

Run `npm run format:check`, `npm test` and build with the supported SDK/Hermes
toolchain. For runtime
changes, report what you checked on a console and what remains untested.

Keep credentials, tokens, signed stream URLs, diagnostic console captures and
copyrighted binaries out of commits. Use `config.local.json` for your server.
Public UI screenshots belong in `docs/images`; check them for private data and
describe third-party imagery in `NOTICE.md`.

Preserve firmware, ownership and rollback checks. New firmware needs a verified
ABI profile. Bootstrap changes need a source, assembly, CFI and LSDA review
before updating `tools/CC_BARRIER_REVIEW.json`.

Contributions use GPL-3.0-or-later.

UI translations live in `ui/i18n.mjs`. Keep each language column aligned with
`keys`, translate every entry and retain short button labels for the Music card.
Add regional locale coverage in `ui/i18n.test.mjs` when adding a language.

Run `npm run format` for JavaScript and documentation. Python tools use Black
24.10.0; native installer sources use clang-format 18 and `.clang-format`.
Keep the reviewed bootstrap source and header byte-for-byte unchanged unless
you are reviewing a bootstrap change. Generated firmware tables and inspection
profiles are not formatter inputs.
