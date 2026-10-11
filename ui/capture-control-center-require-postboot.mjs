/** Dormant observer of normal CC factory calls; no factories are invoked extra. */
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

const own = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const apply = typeof Reflect === "object" && Reflect ? Reflect.apply : undefined;
const originalCall = Function.prototype.call;
const value = (object, key) => {
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

/**
 * Requires a native-loader-verified, isolated, already-running CC realm.
 * CC #2 +0x35 reads factory.call; +0x4e calls it with
 * this=factory, arguments=[exports,module,exports,require].
 * All calls are forwarded exactly once through captured Reflect.apply.
 */
export function armControlCenterRequirePostboot({ globalObject, contextProof,
  scheduleCleanup, cancelCleanup, maxLifetimeMs = 1000 } = {}) {
  if (typeof apply !== "function" || typeof originalCall !== "function" ||
      typeof own !== "function" || typeof define !== "function") {
    throw new Error("The native call/descriptor intrinsics are unavailable");
  }
  if (globalObject !== globalThis || value(globalObject, "Function") !== Function ||
      !contextProof || contextProof.firmware !== 0x13200006 ||
      contextProof.bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
      contextProof.titleId !== "NPXS40003" || contextProof.isolatedRealm !== true ||
      contextProof.phase !== "application-running" ||
      typeof contextProof.executorIdentity !== "string" || !contextProof.executorIdentity) {
    throw new Error("A loader-verified isolated running CC realm is required");
  }
  if (typeof scheduleCleanup !== "function" || typeof cancelCleanup !== "function" ||
      !Number.isInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 30000) {
    throw new TypeError("Bounded host cleanup bindings are required (1–30000 ms)");
  }
  const application = value(globalObject, "application");
  const chunk = value(globalObject, "webpackChunkapplication");
  if (!application || typeof chunk !== "function" || value(chunk, "length") !== 2) {
    throw new Error("CC application/bootstrap globals are unavailable");
  }
  const target = Function.prototype;
  const before = own(target, "call");
  if (!before || before.value !== originalCall || !before.configurable || !before.writable) {
    throw new Error("Function.prototype.call has changed or cannot be restored");
  }
  let state = "arming", calls = 0, captured, capturedModule, factories, cache;
  let reason, matchStage = 0;
  let ticket, scheduled = false, observing = false;
  const conflicts = [];
  let wrapper;
  function detach() {
    if (observing) {
      observing = false;
      const current = own(target, "call");
      if (current && current.value === wrapper && current.get === undefined &&
          current.set === undefined && current.enumerable === before.enumerable &&
          current.writable === before.writable && current.configurable === before.configurable) {
        define(target, "call", before);
      } else conflicts.push("Function.prototype.call");
    }
    if (scheduled) {
      scheduled = false;
      try { cancelCleanup(ticket); } catch { conflicts.push("host-cleanup-ticket"); }
    }
  }
  function cancel(reason = "cancelled") {
    if (["finished", "cancelled", "rejected", "expired"].includes(state)) return;
    state = reason;
    detach();
    captured = capturedModule = factories = cache = undefined;
  }
  function match(factory, args) {
    if (args.length !== 4 || typeof factory !== "function" ||
        args[0] !== args[2] || !args[1] || typeof args[1] !== "object" ||
        typeof args[3] !== "function") return undefined;
    matchStage = Math.max(matchStage, 1);
    const module = args[1], require = args[3], id = value(module, "i");
    if (!Number.isInteger(id) || id < 0 || id >= 3900 || value(module, "l") !== false ||
        value(module, "exports") !== args[2]) return undefined;
    matchStage = Math.max(matchStage, 2);
    if (value(require, "name") !== "r" ||
        value(require, "length") !== 1 || value(require, "s") !== 1359) return undefined;
    matchStage = Math.max(matchStage, 3);
    const table = value(require, "m"), modules = value(require, "c");
    if (!Array.isArray(table) || value(table, "length") !== 3900 ||
        !modules || typeof modules !== "object" ||
        value(table, String(id)) !== factory || value(modules, String(id)) !== module) return undefined;
    matchStage = Math.max(matchStage, 4);
    const entry = value(modules, "1359");
    if (!entry || value(entry, "i") !== 1359 || value(entry, "l") !== true ||
        value(entry, "exports") !== application || value(globalObject, "application") !== application ||
        value(globalObject, "webpackChunkapplication") !== chunk) return undefined;
    matchStage = Math.max(matchStage, 5);
    for (let index = 0; index < 3900; index++) {
      if (typeof value(table, String(index)) !== "function") return undefined;
    }
    matchStage = 6;
    return { require, module, table, modules };
  }
  wrapper = function (...args) {
    if (state === "armed") {
      try {
        calls++;
        const result = match(this, args);
        if (result) {
          captured = result.require; capturedModule = result.module;
          factories = result.table; cache = result.modules;
          state = "captured";
          // Restore before the normal factory runs, including its nested requires.
          detach();
        } else if (calls >= 131072) { reason = "call-limit"; cancel("rejected"); }
      } catch { reason = "observer-error"; cancel("rejected"); }
    }
    return apply(originalCall, this, args);
  };
  try {
    define(target, "call", { ...before, value: wrapper });
    observing = true; state = "armed";
    ticket = scheduleCleanup(() => { reason = "capture-deadline"; cancel("expired"); }, maxLifetimeMs);
    scheduled = true;
    if (state !== "armed") {
      cancelCleanup(ticket); scheduled = false;
      throw new Error("The cleanup scheduler performed calls before returning control");
    }
  } catch (error) {
    cancel("rejected");
    throw error;
  }
  return Object.freeze({
    status: () => ({ state, calls, reason, matchStage, conflicts: [...conflicts] }),
    cancel: () => { cancel(); return { state, conflicts: [...conflicts] }; },
    finish() {
      const entry = cache && value(cache, "1359");
      if (state !== "captured" || !capturedModule ||
          value(captured, "m") !== factories || value(captured, "c") !== cache ||
          value(cache, String(value(capturedModule, "i"))) !== capturedModule ||
          value(capturedModule, "l") !== true ||
          !entry || value(entry, "i") !== 1359 || value(entry, "l") !== true ||
          value(entry, "exports") !== application || value(captured, "s") !== 1359 ||
          value(globalObject, "application") !== application ||
          value(globalObject, "webpackChunkapplication") !== chunk || conflicts.length) {
        cancel("rejected");
        throw new Error("A completed normal CC factory call was not captured");
      }
      detach();
      const result = captured;
      state = "finished";
      captured = capturedModule = factories = cache = undefined;
      return result;
    },
  });
}
