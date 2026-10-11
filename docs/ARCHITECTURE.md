# Architecture

## Installation

The ELF locates `SceShellUI`, stops it and verifies firmware, module identities
and the Control Center executor. It captures the live PID, runtime, app instance
and JS thread, then rechecks them before publishing the bootstrap. It restores
the executor vtable and credential scope afterward.

The bootstrap forwards the original executor call and schedules Hermes v89 code
on the normal JS thread. The build checks its exception barrier and layout
fingerprints. UI bytecode is limited to 163840 bytes. Published native storage
stays mapped until ShellUI exits.

An audio-enabled start configures HTTP audio through ShellUI's
`sceMediaFwSetAudioTagFeature(0)` export. The installer verifies module files and
entry points first. Two native snapshots must show empty CURRENT and service-20
slots; an existing source skips this adjustment. Status and recovery packages do
not change audio configuration.

A repeat load preserves a healthy controller. Conflicting or failed controllers
are rejected.

## Music card and session

The JSX hook replaces the Music element with a local React Native view.
`ui/firmware-profile.mjs` holds bundle fingerprints. The renderer and session pin
module factories, cache records and exports to detect runtime replacement.

The session signs in through OpenSubsonic. It saves the reusable token and salt
in per-user Control Center AsyncStorage under `navistation5.authentication.v1`
and restores them on the next card mount. Sign out removes that entry. The
password is not persisted; AsyncStorage does not encrypt the token.

Album covers load near the visible scroll position. Controller navigation scrolls
the target row into view before focusing it. Detail views focus individual song
rows rather than the scroll container. L1 and R1 switch collection tabs.

`ui/i18n.mjs` selects translations from the cached native
`StringResource.defaultLocale`. Regional locales share their language;
unsupported languages use Spanish. This read does not change console settings.

## Playback

The resident audio owner retains the RNPS Media player across card remounts.
Its transport tracks the owned source ID, rejects foreign audio and waits for
Stop confirmation before starting another track. It does not retry a lost Play
request. Stream URLs must match the configured server origin. A source that does
not start within 30 seconds fails and is stopped after another identity check.

Play keeps album or playlist order. Shuffle mixes a copy of the playable entries
once and leaves the visible track order intact. Each stream is resolved when its
song starts. Fresh native end-of-song samples advance the queue even with the
card closed. Pause retains the queue; Stop, sign out, disposal and individual
song selection cancel it.

Confirmed Playing emits one silent notification per song through
`VshNMNotificationModule.Send`. The object payload follows the system toast schema
used by [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus/blob/main/src/sm_log.c).
The notification contains title and artist. A notification failure does not stop
playback, and resuming a paused song does not emit another notification.

## Cleanup

Disposal blocks new session work, waits for the owned player's Stop acknowledgement,
then retires the session and removes the JSX hook. Runtime identity checks remain
active during the drain. A failed Stop leaves the runtime available for a retry.
Use `await controller.dispose()`; an idle controller returns its final snapshot
synchronously for the installer's replacement path. Renderer failures use the
same drain before restoring stock rendering.

The JSX hook recognizes the firmware's Control Center power menu by item IDs
and Hermes callback locations. Shutdown and reboot callbacks wait for disposal
before forwarding the original callback once. A failed drain or 10-second
deadline forwards the power action. Rest mode and unrelated JSX are unchanged.
This covers menu requests while the hook is active, not crashes, kernel panics
or forced power loss.
