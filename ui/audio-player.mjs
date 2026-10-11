import { STREAM_PREFIX } from "./navidrome-catalog.mjs";
/** Session-owned bridge to the independent homebrew player. No Sony media IDs.
 * One serialized sequence covers every command, including status. Claim is an
 * explicit takeover performed only for Play. No URL/token is kept in snapshots.
 */
const PHASES = ["idle", "opening", "playing", "paused", "stopping", "error"];
function failure(code) { const error = new Error("Local audio operation failed"); error.code = code; return error; }
function safeCode(value, fallback = "ND_AUDIO_UNKNOWN") {
  return typeof value === "string" && /^ND_[A-Z0-9_]{1,60}$/.test(value) ? value : fallback;
}
export function idleAudioStatus(available = false) {
  return Object.freeze({ available, phase: "idle", pending: false, stopPending: false,
    workerActive: false, closeConfirmed: true, stopConfirmed: true, accepted: false, errorCode: "", audibilityVerified: false,
    audioBackend: "", hostReachable: false, controlsAvailable: false,
    playbackSampleFresh: false, currentTime: null, duration: null });
}
export function createAudioPlayer({ token, transport, randomBytes, isRuntimeCurrent,
  scheduleTimer, cancelTimer, onState } = {}) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) ||
      [transport, randomBytes, isRuntimeCurrent, scheduleTimer, cancelTimer].some(value => typeof value !== "function")) {
    throw failure("ND_AUDIO_CONFIG");
  }
  let owner, sequence = 0, mayOwn = false, disposed = false, generation = 0, queued = 0;
  let stopConfirmed = true;
  let chain = Promise.resolve(), stopPromise, pollTimer, polling = false;
  let state = { ...idleAudioStatus(true) };
  const listeners = new Set();
  function status() { return Object.freeze({ ...state, pending: queued > 0, stopConfirmed }); }
  function notify() {
    const value = status();
    try { onState?.(); } catch {}
    for (const listener of Array.from(listeners)) { try { listener(value); } catch {} }
  }
  function current() { try { return !disposed && isRuntimeCurrent() === true; } catch { return false; } }
  function live(turn) {
    if (!current() || generation !== turn) throw failure("ND_AUDIO_CANCELLED");
  }
  function enqueue(work) {
    queued++; notify();
    const task = chain.then(work);
    chain = task.then(() => undefined, () => undefined);
    return task.then(() => { queued--; notify(); schedulePoll(); return status(); }, error => {
      queued--; notify(); schedulePoll(); throw error;
    });
  }
  function setFailure(error) {
    state.errorCode = safeCode(error?.code);
    if (["ND_AUDIO_HOST_UNAVAILABLE", "ND_AUDIO_CONTROL_TIMEOUT", "ND_AUDIO_CONTROL_NETWORK"].includes(state.errorCode)) {
      // A sleeping client cannot answer. Its remote source may still be audible;
      // retain the last phase but do not present stale timing as a live sample.
      state.hostReachable = false; state.controlsAvailable = false;
      state.playbackSampleFresh = false; state.currentTime = state.duration = null;
      state.accepted = false; notify(); return;
    }
    state.phase = "error"; state.accepted = false; notify();
  }
  function decode(response) {
    let value;
    try { value = JSON.parse(response.body); } catch { throw failure("ND_AUDIO_RESPONSE_JSON"); }
    if (!value || value.schema !== 1 || typeof value.ok !== "boolean" || typeof value.accepted !== "boolean" ||
        typeof value.code !== "string" || (value.code !== "" && safeCode(value.code, "") !== value.code)) {
      throw failure("ND_AUDIO_RESPONSE_SCHEMA");
    }
    const observed = value.status;
    if (observed !== undefined && (!observed || typeof observed.owner !== "string" ||
        !/^[A-Za-z0-9._:-]{0,64}$/.test(observed.owner) || !PHASES.includes(observed.phase) ||
        typeof observed.errorCode !== "string" ||
        (observed.errorCode !== "" && safeCode(observed.errorCode, "") !== observed.errorCode) ||
        !Number.isSafeInteger(observed.lastSequence) || observed.lastSequence < 0 ||
        typeof observed.workerActive !== "boolean" || typeof observed.closeConfirmed !== "boolean" ||
        observed.audibilityVerified !== false)) throw failure("ND_AUDIO_RESPONSE_SCHEMA");
    if (["native-mediafw", "resident-mediafw"].includes(observed?.audioBackend)) {
      const time = value => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
      if (typeof observed.hostReachable !== "boolean" || typeof observed.controlsAvailable !== "boolean" ||
          typeof observed.playbackSampleFresh !== "boolean" ||
          !time(observed.currentTime) || !time(observed.duration) ||
          (observed.controlsAvailable && !observed.hostReachable) ||
          (observed.playbackSampleFresh && !observed.hostReachable)) throw failure("ND_AUDIO_RESPONSE_SCHEMA");
    }
    if (value.ok && (!observed || ![200, 202].includes(response.status))) throw failure("ND_AUDIO_RESPONSE_SCHEMA");
    if (!value.ok && ![400, 403, 409].includes(response.status)) throw failure("ND_AUDIO_RESPONSE_SCHEMA");
    return value;
  }
  function observe(value) {
    const observed = value.status;
    if (!observed) return;
    sequence = Math.max(sequence, observed.lastSequence);
    if (observed.owner !== owner) {
      // An authenticated owner mismatch proves that this session cannot issue
      // playback mutations. A subsequent explicit Play may claim again.
      mayOwn = false; stopConfirmed = true;
      state = { ...idleAudioStatus(true), stopPending: state.stopPending, errorCode: "ND_OWNER" };
      return;
    }
    mayOwn = true;
    state = { ...state, phase: observed.phase, workerActive: observed.workerActive,
      closeConfirmed: observed.closeConfirmed, accepted: value.accepted,
      errorCode: observed.errorCode, audibilityVerified: false,
      audioBackend: observed.audioBackend || "", hostReachable: observed.hostReachable !== false,
      controlsAvailable: observed.controlsAvailable !== false,
      playbackSampleFresh: observed.playbackSampleFresh === true,
      currentTime: observed.playbackSampleFresh === true ? observed.currentTime : null,
      duration: observed.playbackSampleFresh === true ? observed.duration : null };
  }
  async function command(name, url) {
    if (!owner || sequence >= Number.MAX_SAFE_INTEGER) throw failure("ND_AUDIO_SEQUENCE_EXHAUSTED");
    const requestSequence = ++sequence;
    let body = JSON.stringify({ token, owner, sequence: requestSequence, command: name,
      ...(url === undefined ? {} : { url }) });
    url = undefined;
    let response;
    try { response = await transport(body); } finally { body = undefined; }
    const value = decode(response);
    observe(value);
    if (!value.ok) { const error = failure(safeCode(value.code)); error.response = value; throw error; }
    if (value.status.owner !== owner || value.status.lastSequence !== requestSequence) throw failure("ND_AUDIO_RESPONSE_IDENTITY");
    if (name === "claim" || name === "stop") stopConfirmed =
      !value.status.workerActive && value.status.closeConfirmed && value.status.phase === "idle";
    notify();
    return value;
  }
  async function ensureClaim(turn) {
    live(turn);
    if (mayOwn) return;
    if (!owner) {
      const bytes = await randomBytes(16);
      live(turn);
      if (!bytes || bytes.length !== 16) throw failure("ND_AUDIO_OWNER_RANDOM");
      let text = "";
      for (const byte of bytes) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw failure("ND_AUDIO_OWNER_RANDOM");
        text += byte.toString(16).padStart(2, "0");
      }
      owner = text;
    }
    stopConfirmed = false;
    mayOwn = true; // A lost response cannot prove that Claim did not take effect.
    try { await command("claim"); }
    catch (error) {
      if (error.code !== "ND_SEQUENCE" || !error.response?.status) throw error;
      live(turn);
      mayOwn = true;
      await command("claim"); // One safe synchronization retry, never retry Play.
    }
    live(turn);
  }
  function play(resolveStream, isRequestCurrent) {
    const turn = ++generation;
    if (typeof resolveStream !== "function" || typeof isRequestCurrent !== "function") return Promise.reject(failure("ND_AUDIO_STREAM_RESOLVER"));
    function requestLive() {
      live(turn);
      if (isRequestCurrent() !== true) throw failure("ND_AUDIO_CANCELLED");
    }
    return enqueue(async () => {
      let url;
      try {
        requestLive();
        if (state.stopPending) throw failure("ND_AUDIO_STOP_PENDING");
        // Resolve late, after all older control operations; the session resolver
        // also verifies its client/version and mounted request after awaiting.
        url = await resolveStream(); requestLive();
        if (typeof url !== "string" || url.length > 8192 || /[^\x21-\x7e]/.test(url) ||
            !url.startsWith(STREAM_PREFIX)) throw failure("ND_AUDIO_URL_POLICY");
        await ensureClaim(turn); requestLive();
        stopConfirmed = false;
        state.phase = "accepted"; state.accepted = false;
        state.workerActive = true; state.closeConfirmed = false; notify();
        await command("play", url); url = undefined;
        return status();
      } catch (error) {
        url = undefined; setFailure(error); throw failure(safeCode(error?.code));
      }
    });
  }
  function stopPlayback() {
    generation++;
    if (stopPromise) return stopPromise;
    if (stopConfirmed && queued === 0 && !state.workerActive && state.closeConfirmed) {
      state = { ...idleAudioStatus(true) }; notify(); return Promise.resolve(status());
    }
    // Queued Play may still be resolving its owner. It observes generation and
    // cannot start after this Stop; the queued Stop handles any in-flight Claim.
    state.stopPending = true; notify();
    const operation = enqueue(async () => {
      try {
        if (mayOwn) {
          try { await command("stop"); }
          catch (error) {
            if (error.code !== "ND_OWNER" || mayOwn) throw error;
          }
          if (state.workerActive || !state.closeConfirmed) throw failure("ND_AUDIO_CLOSE_UNCONFIRMED");
        }
        stopConfirmed = true;
        if (disposed) token = "";
        state = { ...idleAudioStatus(true) }; notify(); return status();
      } catch (error) { state.stopPending = true; setFailure(error); throw failure(safeCode(error?.code)); }
    });
    stopPromise = operation.then(value => { stopPromise = undefined; return value; }, error => {
      stopPromise = undefined; throw error;
    });
    return stopPromise;
  }
  function control(name) {
    if (!["pause", "resume", "status"].includes(name)) return Promise.reject(failure("ND_AUDIO_COMMAND"));
    const turn = generation;
    return enqueue(async () => {
      try {
        live(turn);
        if (!mayOwn) return status();
        if (state.stopPending) throw failure("ND_AUDIO_STOP_PENDING");
        await command(name); return status();
      } catch (error) { setFailure(error); throw failure(safeCode(error?.code)); }
    });
  }
  function schedulePoll() {
    if (pollTimer !== undefined || polling || !listeners.size || !mayOwn || !current()) return;
    if (!state.workerActive && !["accepted", "opening", "playing", "paused", "stopping"].includes(state.phase)) return;
    pollTimer = scheduleTimer(() => {
      pollTimer = undefined;
      if (queued || !listeners.size || !current()) { schedulePoll(); return; }
      polling = true;
      control("status").then(() => { polling = false; schedulePoll(); }, () => { polling = false; });
    }, 1000);
  }
  return Object.freeze({ status, play, stopPlayback,
    pause: () => control("pause"), resume: () => control("resume"), refresh: () => control("status"),
    subscribe(listener) {
      if (typeof listener !== "function" || disposed) return () => undefined;
      listeners.add(listener); listener(status()); schedulePoll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && pollTimer !== undefined) { cancelTimer(pollTimer); pollTimer = undefined; }
      };
    },
    dispose() {
      disposed = true;
      if (pollTimer !== undefined) { try { cancelTimer(pollTimer); } catch {} pollTimer = undefined; }
      listeners.clear();
      const stopped = stopPlayback();
      stopped.then(() => { token = ""; }, () => undefined);
      return stopped;
    },
  });
}
