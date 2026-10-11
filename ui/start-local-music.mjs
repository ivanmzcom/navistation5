/** Explicit, deferred startup. Importing this module schedules or installs nothing. */
import { createShellUiBootstrapDriver, BASE_DLL_SOURCE_SHA256 } from "./shellui-bootstrap-driver.mjs";
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

export const LOCAL_MUSIC_STATUS_GLOBAL = "__navidromeLocalMusicStatus";
const CAPTURE_MS = 30000, POLL_MS = 100, MAX_POLLS = 350, STARTUP_MS = 35000;
const owners = new WeakMap();
const own = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const value = (object, key) => {
  if ((typeof object !== "object" || object === null) && typeof object !== "function") return undefined;
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

function copyProof(proof) {
  const result = {};
  for (const key of ["firmware", "bundleSha256", "baseDllSha256", "titleId",
    "isolatedRealm", "phase", "executorIdentity"]) result[key] = value(proof, key);
  if (result.firmware !== 0x13200006 || result.bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
      result.baseDllSha256 !== BASE_DLL_SOURCE_SHA256 || result.titleId !== "NPXS40003" ||
      result.isolatedRealm !== true || result.phase !== "application-running" ||
      typeof result.executorIdentity !== "string" || !result.executorIdentity) {
    throw new Error("A native-loader-verified running CC context proof is required");
  }
  return Object.freeze(result);
}

/**
 * The caller verifies the realm/executor and hashes; these assertions cannot
 * authenticate a native executor from JavaScript. Uses only already-materialized
 * functions from the already-loaded, captured base_dll timer module. Global timer
 * getters can remain lazy; startup does not read or replace them.
 * No module factory, native component, login or network request runs at startup.
 * An ordinary uncached CC module request may require the user to open Music.
 */
export function startLocalMusic({ globalObject, contextProof, bindings = {} } = {}) {
  if (typeof globalThis === "undefined" || globalObject !== globalThis ||
      typeof own !== "function" || typeof define !== "function") {
    throw new Error("The current isolated global and descriptor intrinsics are required");
  }
  const proof = copyProof(contextProof);
  const previous = owners.get(globalObject);
  if (previous) return previous;
  if (own(globalObject, LOCAL_MUSIC_STATUS_GLOBAL)) {
    throw new Error("The startup diagnostic slot is owned by another invocation");
  }

  let phase = "created", reason, polls = 0, startedAt, driver, published;
  let active = true, insideBootstrap = true, now, apply, timeout, clearTimeout;
  const tickets = new Set(), cleanupErrors = [];
  let latestDriverStatus, lastAttempt;
  const suppliedBindings = {};

  function readDriver() {
    if (driver) {
      try { latestDriverStatus = driver.status(); }
      catch { cleanupErrors.push("driver-status"); }
    }
    return latestDriverStatus;
  }
  function ownsSlot() {
    const descriptor = own(globalObject, LOCAL_MUSIC_STATUS_GLOBAL);
    return descriptor && descriptor.value === published && descriptor.writable === false &&
      descriptor.configurable === true && descriptor.enumerable === false;
  }
  function snapshot() {
    const state = readDriver();
    let elapsedMs;
    if (now && startedAt !== undefined) {
      const elapsed = now() - startedAt;
      if (Number.isFinite(elapsed)) elapsedMs = Math.max(0, elapsed);
    }
    return Object.freeze({ schema: 1, phase, reason, polls, elapsedMs,
      captureTtlMs: CAPTURE_MS, startupLimitMs: STARTUP_MS, maxPolls: MAX_POLLS,
      needsAction: phase === "waiting-capture" ? "openMusic" :
        phase === "installed" ? state?.reopen : undefined,
      driver: state, lastAttempt, cleanupErrors: [...cleanupErrors] });
  }
  function publish() {
    if (published !== undefined && !ownsSlot()) throw new Error("The diagnostic slot changed");
    const next = snapshot();
    define(globalObject, LOCAL_MUSIC_STATUS_GLOBAL,
      { value: next, writable: false, enumerable: false, configurable: true });
    published = next;
    return next;
  }
  function cancelTimer(ticket) {
    tickets.delete(ticket);
    apply(clearTimeout, globalObject, [ticket]);
  }
  function clean() {
    active = false;
    for (const ticket of [...tickets]) {
      try { cancelTimer(ticket); } catch { cleanupErrors.push("timer-cancel"); }
    }
    if (driver) {
      try { latestDriverStatus = driver.dispose(); }
      catch { cleanupErrors.push("driver-dispose"); }
    }
  }
  function fail(code) {
    if (!active) return;
    reason = code; phase = "failed";
    lastAttempt = readDriver();
    clean();
    try { publish(); } catch { cleanupErrors.push("diagnostic-slot"); }
  }
  function schedule(callback, delay) {
    let scheduling = true, synchronous = false, ticket;
    const invoke = () => {
      if (scheduling || insideBootstrap) { synchronous = true; return; }
      tickets.delete(ticket);
      if (!active) return;
      try { callback(); } catch { fail("deferred-callback-failed"); }
    };
    ticket = apply(timeout, globalObject, [invoke, delay]);
    scheduling = false;
    if (synchronous || !Number.isSafeInteger(ticket) || ticket < 1) {
      try { apply(clearTimeout, globalObject, [ticket]); } catch { cleanupErrors.push("timer-cancel"); }
      throw new Error("The captured timer did not return an asynchronous RNPS timer ticket");
    }
    tickets.add(ticket);
    return ticket;
  }
  function poll() {
    polls++;
    if (polls > MAX_POLLS || now() - startedAt >= STARTUP_MS) {
      fail("startup-deadline"); return;
    }
    let state = driver.completeCapture();
    if (state.phase === "capture-failed") { fail("capture-failed"); return; }
    if (state.phase !== "waiting-capture") state = driver.tryInstall();
    phase = state.phase;
    publish();
    if (phase === "installed") return;
    if (phase !== "waiting-capture" && phase !== "waiting-modules") {
      fail("unexpected-driver-state"); return;
    }
    if (polls >= MAX_POLLS) { fail("startup-poll-limit"); return; }
    schedule(poll, POLL_MS);
  }
  function deferredStart() {
    // This callback is reached through the existing RNPS JS timer dispatch.
    // The original native CallFunctionFlushedQueue must run after bootstrap
    // to forward the queued native Timing.createTimer request normally.
    if (now() - startedAt >= STARTUP_MS) { fail("initial-dispatch-deadline"); return; }
    driver = createShellUiBootstrapDriver({ globalObject, ...suppliedBindings,
      scheduleCleanup: schedule, cancelCleanup: cancelTimer, maxLifetimeMs: CAPTURE_MS });
    driver.armCapture({ mode: "postboot", contextProof: proof });
    phase = "waiting-capture";
    publish();
    schedule(poll, POLL_MS);
  }
  const controller = Object.freeze({
    status() {
      try { return publish(); }
      catch { fail("diagnostic-slot-changed"); return snapshot(); }
    },
    dispose() {
      if (active) { phase = "disposed"; reason = "explicit-dispose"; clean(); }
      try { return publish(); } catch { return snapshot(); }
    },
  });
  owners.set(globalObject, controller);
  publish();
  try {
    // Never read accessors: global timer polyfills may initialize a factory.
    const reflect = value(globalObject, "Reflect"), date = value(globalObject, "Date");
    apply = value(reflect, "apply");
    const dateNow = value(date, "now");
    if (value(globalObject, "Function") !== Function || value(globalObject, "Object") !== Object ||
        typeof Reflect !== "object" || reflect !== Reflect || date !== Date ||
        typeof apply !== "function" || typeof dateNow !== "function" ||
        typeof value(Function.prototype, "call") !== "function") {
      fail("global-intrinsics-unavailable"); return controller;
    }
    const base = value(globalObject, "base_dll");
    const timerModule = value(value(base, "c"), "oFysat5F");
    const timerExports = value(timerModule, "exports");
    timeout = value(timerExports, "setTimeout");
    clearTimeout = value(timerExports, "clearTimeout");
    if (typeof base !== "function" || value(timerModule, "i") !== "oFysat5F" ||
        value(timerModule, "l") !== true || typeof timeout !== "function" ||
        typeof clearTimeout !== "function") {
      fail("loaded-base-timer-module-unavailable"); return controller;
    }
    now = () => apply(dateNow, date, []);
    startedAt = now();
    if (!Number.isFinite(startedAt)) { fail("clock-unavailable"); return controller; }
    for (const key of ["LocalMusic", "client", "library", "onLogin", "onPlay"]) {
      const descriptor = own(bindings, key);
      if (descriptor && !("value" in descriptor)) throw new Error("Bindings must be own data values");
      if (descriptor) suppliedBindings[key] = descriptor.value;
    }
    phase = "scheduled";
    publish();
    schedule(deferredStart, 0);
  } catch { fail("startup-preflight-or-scheduling-failed"); }
  finally { insideBootstrap = false; }
  return controller;
}

/** Refresh the diagnostic snapshot after local rendering without starting work. */
export function getLocalMusicStatus({ globalObject } = {}) {
  return owners.get(globalObject)?.status();
}

/** Native error/finally cleanup, or explicit removal after closing the local view. */
export function stopLocalMusic({ globalObject } = {}) {
  return owners.get(globalObject)?.dispose();
}
