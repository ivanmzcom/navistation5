# NaviStation5

Experimental open-source PS5 homebrew for listening to a **Navidrome** library
through the Control Center Music card, including while a game is open.

The current route runs the UI and audio controls in the resident Control Center
runtime. It does not require a separate installed audio application, an auxiliary
HTTP service, or keeping a foreground homebrew app open.

## Current support

- PS5 firmware **13.20**, exact profile `0x13200006`.
- Music-card interface: login, albums, tracks, cover art, playback and progress.
- Resident audio: play, pause, resume, stop and track changes.
- One ELF discovers the current ShellUI/Control Center identity automatically.
- Repeated loading preserves an intact existing card and its audio state.

Audio and track controls were verified in Home and Rayman on the development
console. Automatic discovery and loading the same ELF twice were verified in an
initialized session. **Loading after a fresh console reboot has not yet been
verified.** Other firmware is unsupported and rejected by the guards.

## Build

Requirements: Node.js 20+, Python 3, Make, a configured
[ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk), and
[Hermes 0.12.0](https://github.com/facebook/hermes/releases/tag/v0.12.0)
with bytecode version 89. The reviewed native stub must reproduce the recorded
binary fingerprint; changing the compiler or stub requires a new static review.

```sh
npm ci
cp config.example.json config.local.json
# Edit serverUrl in config.local.json to point to your Navidrome server.
export PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk
export HERMESC=/path/to/hermesc
# Configure LLVM as required by your SDK, e.g. the reviewed LLVM 18 toolchain:
export LLVM_CONFIG=/path/to/llvm-18/bin/llvm-config
npm test
npm run build
```

Output: `build/navistation5.elf`. The build generates a private control token and
embeds the configured server origin. Username and password are entered in the
console interface; they are not source defaults or build settings. Server URLs
must be HTTP(S) origins without credentials, paths, query strings or fragments.
All networking and stream validation use that same configured origin.

The build has no deployment step and never connects to a console. No Sony
libraries, console dumps, music, credentials or preconfigured ELF are distributed.

## Load on the console

1. Activate your jailbreak and ELF loader.
2. Open Control Center and Music once to initialize its normal runtime.
3. Send `build/navistation5.elf` using your loader (typically TCP port 9021).
4. Reopen Music and sign in to Navidrome.

This integration lives in memory. Repeat the load after restarting the console;
the same ELF can be reused without capturing session addresses or recompiling.
Automatic discovery does not activate the jailbreak or install a boot service.
A repeat load preserves an existing working card, so it does not upgrade that
card to a new bundled UI. For now, load once per boot.

The retired native “Prueba de audio Navidrome” app is unnecessary. Do not install
it or place its old folder in a homebrew auto-registration directory.

## Source layout

- `ui/`: Music-card interface, OpenSubsonic client and resident audio transport.
- `tools/`: native installer, session/firmware guards and build tooling.
- `tools/profiles/`: inspection metadata for this project's native bootstrap stub.

See [architecture](docs/ARCHITECTURE.md), [contributing](CONTRIBUTING.md) and
[third-party notices](NOTICE.md). This repository contains the current resident
route; private console captures and retired native-player experiments remain
outside the public project.

## License

GPL-3.0-or-later. Independent homebrew; not affiliated with Sony, PlayStation or
the Navidrome project.
