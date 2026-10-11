import { STREAM_PREFIX } from "./navidrome-catalog.mjs";
/** Normal resident RNPS Media API. Keep the returned transport alive across UI
 * remounts: its private closure is the ownership ledger. Never reconstruct that
 * ledger from a shared service's current source. Construction makes no API call.
 * No initialization, event listeners, source removal or service termination.
 */
import { BASE_DLL_HBC_SHA256 } from "./rnps-networking-transport.mjs";

const MODULE = "bX5JscBE", SERVICE = 20;

function own(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function failure(code) { const error = new Error("Resident audio control unavailable"); error.code = code; return error; }
function integer(value) { return Number.isSafeInteger(value) && value >= -2147483648 && value <= 4294967295; }
function flag(value) { return value === true || value === 1 ? true : value === false || value === 0 ? false : undefined; }
function seconds(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1000 : null; }
function validUri(value) {
  return typeof value === "string" && value.length <= 4095 && value.length > STREAM_PREFIX.length &&
    value.startsWith(STREAM_PREFIX) && !/[^\x21-\x7e]|[#\\]/.test(value);
}

export function createResidentAudioControlTransport({ token, baseRequire, firmware, baseBundleSha256,
  isRuntimeCurrent, scheduleTimer, cancelTimer } = {}) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || firmware !== 0x13200006 ||
      baseBundleSha256 !== BASE_DLL_HBC_SHA256 ||
      [baseRequire, isRuntimeCurrent, scheduleTimer, cancelTimer].some(value => typeof value !== "function")) {
    throw failure("ND_AUDIO_TRANSPORT_IDENTITY");
  }
  const cache = own(baseRequire, "c"), factories = own(baseRequire, "m");
  const record = own(cache, MODULE), factory = own(factories, MODULE), modules = own(record, "exports");
  if (own(record, "i") !== MODULE || own(record, "l") !== true || typeof factory !== "function" || !modules) {
    throw failure("ND_AUDIO_TRANSPORT_CACHE");
  }
  // NativeModules can expose a host object: use its observed property access,
  // while pinning the surrounding ordinary JS cache with data descriptors.
  let media, query, play, command, commands, pauseCommand, playCommand, stopCommand;
  try {
    media = modules.VshNMMediaModule;
    query = media.GetCurrentPlayInfo; play = media.PlayMediaUri; command = media.PlayerCommand;
    commands = media.PlayerCommands;
    pauseCommand = commands.pauseCommand; playCommand = commands.playCommand; stopCommand = commands.stopCommand;
  } catch { throw failure("ND_AUDIO_TRANSPORT_SHAPE"); }
  if ([query, play, command].some(value => typeof value !== "function") ||
      pauseCommand !== "pause" || playCommand !== "play" || stopCommand !== "stop") {
    throw failure("ND_AUDIO_TRANSPORT_SHAPE");
  }
  function pinned() {
    try {
      return isRuntimeCurrent() === true && own(baseRequire, "c") === cache && own(baseRequire, "m") === factories &&
        own(cache, MODULE) === record && own(factories, MODULE) === factory && own(record, "i") === MODULE &&
        own(record, "l") === true && own(record, "exports") === modules && modules.VshNMMediaModule === media &&
        media.GetCurrentPlayInfo === query && media.PlayMediaUri === play && media.PlayerCommand === command &&
        media.PlayerCommands === commands && commands.pauseCommand === pauseCommand &&
        commands.playCommand === playCommand && commands.stopCommand === stopCommand;
    } catch { return false; }
  }
  if (!pinned()) throw failure("ND_AUDIO_TRANSPORT_CHANGED");
  let owner = "", sequence = 0, sourceId = null, sourceUri, busy = false, uncertain = false;
  let phase = "idle", errorCode = "", closeConfirmed = true, fresh = false, currentTime = null, duration = null;
  let reachable = true, sourceMatches = true, stopped = true, stopAck = false;
  function snapshot() {
    const live = reachable && pinned(), sampled = fresh && live;
    return { owner, phase, errorCode, lastSequence: sequence, workerActive: busy,
      closeConfirmed, audibilityVerified: false, audioBackend: "resident-mediafw",
      hostReachable: live, controlsAvailable: live && !busy && !uncertain && sourceMatches,
      playbackSampleFresh: sampled, currentTime: sampled ? currentTime : null,
      duration: sampled ? duration : null };
  }
  function response(status, ok, code = "", accepted = false) {
    return { status, body: JSON.stringify({ schema: 1, ok, accepted, code, status: snapshot() }) };
  }
  function stale(code) {
    errorCode = code; fresh = false; currentTime = duration = null;
    if (code === "ND_AUDIO_CONTROL_TIMEOUT" || code === "ND_AUDIO_NATIVE_REJECTED" ||
        code === "ND_AUDIO_TRANSPORT_CHANGED") reachable = false;
  }
  function invoke(fn, args, timeout, lateResult) {
    return new Promise((resolve, reject) => {
      let done = false, timedOut = false, lateHandled = false, ticket;
      function finish(ok, value) {
        if (done) {
          if (ok && timedOut && !lateHandled && lateResult && pinned()) {
            lateHandled = true;
            try { lateResult(value); } catch { /* Submission remains uncertain. */ }
          }
          return;
        }
        done = true;
        if (ticket !== undefined) { try { cancelTimer(ticket); } catch {} }
        if (!pinned()) { reject(failure("ND_AUDIO_TRANSPORT_CHANGED")); return; }
        if (ok) { reachable = true; resolve(value); }
        else reject(failure(value));
      }
      try {
        if (!pinned()) throw failure("ND_AUDIO_TRANSPORT_CHANGED");
        ticket = scheduleTimer(() => { timedOut = true; finish(false, "ND_AUDIO_CONTROL_TIMEOUT"); }, timeout);
        const pending = Reflect.apply(fn, media, args);
        if (!pending || typeof pending.then !== "function") finish(false, "ND_AUDIO_NATIVE_REJECTED");
        else pending.then(value => finish(true, value), () => finish(false, "ND_AUDIO_NATIVE_REJECTED"));
      } catch { finish(false, pinned() ? "ND_AUDIO_NATIVE_REJECTED" : "ND_AUDIO_TRANSPORT_CHANGED"); }
    });
  }
  function decodeInfo(value, current = false) {
    const result = own(value, "result"), error = own(value, "errorState");
    if (!integer(result)) throw failure("ND_AUDIO_NATIVE_RESPONSE");
    if ((result === -1000 && error === 0) || (current && result === -3001)) return { empty: true };
    if (result !== 0 || (error !== undefined && (!integer(error) || error !== 0))) throw failure("ND_AUDIO_NATIVE_RESULT");
    const id = own(value, "srcId"), service = own(value, "serviceType"), uri = own(value, "srcUri");
    const playing = flag(own(value, "isPlaying"));
    if (!current && id === -1000 && service === SERVICE && playing === false && uri === "" &&
        own(value, "contextUri") === "" && own(value, "progressMs") === 0 && own(value, "durationMs") === 0) {
      return { empty: true };
    }
    if (!integer(id) || id <= 0 || !integer(service) || playing === undefined ||
        (uri !== undefined && typeof uri !== "string")) throw failure("ND_AUDIO_NATIVE_RESPONSE");
    return { empty: false, id, service, uri, playing,
      time: seconds(own(value, "progressMs")), duration: seconds(own(value, "durationMs")) };
  }
  function matches(info, current = false) {
    return !info.empty && sourceId !== null && info.id === sourceId &&
      (info.service === SERVICE || (current && info.service === 10)) &&
      (info.uri === undefined || info.uri === "" || info.uri === sourceUri);
  }
  function requireOwned(info, current = false) {
    if (!matches(info, current)) { sourceMatches = false; throw failure("ND_AUDIO_SOURCE_OWNERSHIP"); }
    sourceMatches = true;
  }
  async function pair() {
    const slot = decodeInfo(await invoke(query, [{ serviceType: SERVICE }], 3000));
    const current = decodeInfo(await invoke(query, [{}], 3000), true);
    if (!pinned()) throw failure("ND_AUDIO_TRANSPORT_CHANGED");
    return { slot, current };
  }
  function sample(info) {
    requireOwned(info);
    fresh = true; currentTime = info.time; duration = info.duration;
    if (info.playing) { phase = "playing"; stopped = false; closeConfirmed = false; }
    else if (stopped || (phase === "stopping" && stopAck)) { stopped = true; phase = "idle"; closeConfirmed = true; }
    else if (info.duration !== null && info.duration > 0 && info.time !== null && info.time >= info.duration) {
      phase = "idle"; stopped = true; closeConfirmed = true;
    } else if (phase !== "opening" && phase !== "stopping") phase = "paused";
  }
  async function guardedSource() {
    const info = await pair();
    requireOwned(info.slot);
    requireOwned(info.current, true);
    sample(info.slot);
    return info.slot;
  }
  function forgetEmpty() {
    sourceId = null; sourceUri = undefined; stopped = true; stopAck = false; sourceMatches = true;
    closeConfirmed = true; phase = "idle"; fresh = false; currentTime = duration = null;
  }
  async function emptyOrOwned() {
    const info = await pair();
    if (!info.slot.empty) requireOwned(info.slot);
    if (!info.current.empty) requireOwned(info.current, true);
    if (info.slot.empty && info.current.empty) { if (!uncertain) forgetEmpty(); return; }
    if (sourceId === null) throw failure("ND_AUDIO_SOURCE_OWNERSHIP");
    sample(info.slot);
  }
  async function stopOwned() {
    if (uncertain) throw failure("ND_AUDIO_PLAY_UNCERTAIN");
    if (sourceId === null) { await emptyOrOwned(); return; }
    const info = await pair();
    if (info.slot.empty && info.current.empty) { forgetEmpty(); return; }
    requireOwned(info.slot);
    requireOwned(info.current, true);
    phase = "stopping"; closeConfirmed = false; fresh = false;
    if (!stopAck) {
      const result = await invoke(command, [{ command: stopCommand, srcId: sourceId, playbackSource: 1 }], 3000);
      if (own(result, "result") !== 0) throw failure("ND_AUDIO_NATIVE_RESULT");
      stopAck = true;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const after = decodeInfo(await invoke(query, [{ serviceType: SERVICE }], 750));
      if (after.empty) { forgetEmpty(); return; }
      requireOwned(after);
      if (!after.playing) { stopped = true; sample(after); return; }
      if (attempt < 5) await new Promise(resolve => scheduleTimer(resolve, 100));
    }
    throw failure("ND_AUDIO_CLOSE_UNCONFIRMED");
  }
  function recordPlay(value, uri) {
    const id = own(value, "srcId");
    if (own(value, "result") !== 0 || own(value, "serviceType") !== SERVICE || !integer(id) || id <= 0) return false;
    sourceId = id; sourceUri = uri; uncertain = false; stopped = false; stopAck = false; sourceMatches = true;
    phase = "opening"; closeConfirmed = false; fresh = false; reachable = true;
    return true;
  }
  function parse(body) {
    if (typeof body !== "string" || body.length > 12288 || /[^\x20-\x7e]/.test(body)) throw failure("ND_AUDIO_REQUEST_BODY");
    let request; try { request = JSON.parse(body); } catch { throw failure("ND_AUDIO_REQUEST_BODY"); }
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).some(key => !["token", "owner", "sequence", "command", "url"].includes(key))) throw failure("ND_AUDIO_REQUEST_BODY");
    if (request.token !== token) throw failure("ND_AUTH");
    if (typeof request.owner !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(request.owner) ||
        !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
        !["claim", "play", "pause", "resume", "stop", "status"].includes(request.command) ||
        (request.command === "play" ? !validUri(request.url) : request.url !== undefined)) throw failure("ND_AUDIO_REQUEST_BODY");
    return request;
  }
  return async function transport(body) {
    let request;
    try { request = parse(body); } catch (error) {
      // Invalid authentication must not disclose our owner or playback state.
      return { status: error.code === "ND_AUTH" ? 403 : 400,
        body: JSON.stringify({ schema: 1, ok: false, accepted: false, code: error.code }) };
    }
    body = undefined;
    if (!pinned()) { stale("ND_AUDIO_TRANSPORT_CHANGED"); return response(409, false, errorCode); }
    if (request.command !== "claim" && request.owner !== owner) return response(409, false, "ND_OWNER");
    if (request.owner === owner && request.sequence <= sequence) return response(409, false, "ND_SEQUENCE");
    if (busy) return response(409, false, "ND_AUDIO_BUSY");
    const transfer = request.command === "claim" && request.owner !== owner;
    if (!transfer) sequence = request.sequence;
    busy = true; errorCode = "";
    let accepted = false;
    try {
      if (request.command === "claim") {
        await stopOwned();
        owner = request.owner; sequence = request.sequence;
      } else if (request.command === "play") {
        if (uncertain) throw failure("ND_AUDIO_PLAY_UNCERTAIN");
        await stopOwned();
        // The two queries also refuse a paused/playing foreign CURRENT source.
        await emptyOrOwned();
        const uri = request.url;
        uncertain = true; stopped = false; closeConfirmed = false; phase = "opening"; fresh = false;
        const result = await invoke(play, [{ serviceType: SERVICE, coreName: "SystemMusicCore", titleId: "PPSA99985",
          uri, offsetUri: "", offset: 0, playbackSource: 1, username: "", token: "" }], 5000,
          value => { recordPlay(value, uri); });
        if (!recordPlay(result, uri)) throw failure("ND_AUDIO_PLAY_UNCERTAIN");
        accepted = true;
      } else if (request.command === "stop") await stopOwned();
      else if (request.command === "status") {
        if (uncertain) throw failure("ND_AUDIO_PLAY_UNCERTAIN");
        await emptyOrOwned();
      } else {
        if (uncertain) throw failure("ND_AUDIO_PLAY_UNCERTAIN");
        if (sourceId === null || stopped) throw failure("ND_AUDIO_NO_SOURCE");
        await guardedSource();
        const value = request.command === "pause" ? pauseCommand : playCommand;
        const result = await invoke(command, [{ command: value, srcId: sourceId, playbackSource: 1 }], 3000);
        if (own(result, "result") !== 0) throw failure("ND_AUDIO_NATIVE_RESULT");
        phase = request.command === "pause" ? "paused" : "opening"; fresh = false;
        accepted = true;
      }
      busy = false;
      return response(accepted ? 202 : 200, true, "", accepted);
    } catch (error) {
      busy = false;
      const code = typeof error?.code === "string" && /^ND_[A-Z0-9_]+$/.test(error.code) ? error.code : "ND_AUDIO_NATIVE_REJECTED";
      stale(code);
      return response(409, false, code);
    } finally { request.url = undefined; request = undefined; }
  };
}
