/**
 * Dormant pre-bootstrap observer for the captured CC webpack loader.
 * Importing this module changes nothing. See docs/ARCHITECTURE.md.
 * Context authentication and isolated-realm identity belong to the native loader.
 */
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

const own = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const proto = Object.getPrototypeOf;
const data = value => ({ value, writable: true, enumerable: true, configurable: true });
const ownValue = (object, key) => {
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

function inheritedDescriptor(object, key) {
  for (let current = object; current !== null; current = proto(current)) {
    const descriptor = own(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/**
 * Must run immediately before the NORMAL CC bundle evaluation in its own realm.
 * `contextProof` must come from the loader's independently checked executor and
 * bundle mapping. These fields do not authenticate themselves in JavaScript.
 *
 * `scheduleCleanup(callback, maxLifetimeMs)` / `cancelCleanup(ticket)` must be
 * trusted host bindings. Cleanup is also required in the loader's finally path;
 * a timer cannot interrupt a synchronous stalled bundle evaluation.
 *
 * No require/factory/chunk callback is invoked by this helper. `finish()` returns
 * the captured require only after all bootstrap writes and validates their shape.
 */
export function armControlCenterRequireCapture({ globalObject, contextProof,
  scheduleCleanup, cancelCleanup, maxLifetimeMs = 1000 } = {}) {
  if (typeof Reflect !== "object" || !Reflect || typeof Reflect.ownKeys !== "function") {
    throw new Error("The native own-key intrinsic is unavailable");
  }
  if (globalObject !== globalThis || ownValue(globalObject, "Function") !== Function ||
      !contextProof || contextProof.firmware !== 0x13200006 ||
      contextProof.bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
      contextProof.titleId !== "NPXS40003" ||
      contextProof.isolatedRealm !== true || contextProof.phase !== "before-application" ||
      typeof contextProof.executorIdentity !== "string" || !contextProof.executorIdentity) {
    throw new Error("A loader-verified isolated CC realm and pre-bootstrap identity are required");
  }
  if (typeof scheduleCleanup !== "function" || typeof cancelCleanup !== "function" ||
      !Number.isInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 3000) {
    throw new TypeError("Bounded host cleanup bindings are required (1–3000 ms)");
  }
  const functionPrototype = Function.prototype;
  if (own(globalObject, "application") || own(globalObject, "webpackChunkapplication")) {
    throw new Error("The application bootstrap has already started or the realm is not fresh");
  }
  if (inheritedDescriptor(functionPrototype, "m") || !Object.isExtensible(functionPrototype)) {
    throw new Error("Function.prototype.m cannot be observed without changing existing semantics");
  }
  let state = "arming", candidate, factories, cache, chunk, deadlineTicket;
  let deadlineScheduled = false, unexpectedWrites = 0;
  const conflicts = [], temporary = [];

  function removeTemporary(entry) {
    if (!entry.active) return;
    const current = own(entry.object, entry.key);
    if (current?.set === entry.setter && current.get === undefined &&
        current.configurable === true && current.enumerable === false) {
      delete entry.object[entry.key];
    } else {
      conflicts.push(entry.label);
    }
    entry.active = false;
  }
  function detach() {
    for (const entry of [...temporary].reverse()) removeTemporary(entry);
    if (deadlineScheduled) {
      deadlineScheduled = false;
      try { cancelCleanup(deadlineTicket); }
      catch { conflicts.push("host-cleanup-ticket"); }
    }
  }
  function cancel(reason = "cancelled") {
    if (state === "finished" || state === "cancelled" || state === "rejected" || state === "expired") {
      return { state, conflicts: [...conflicts] };
    }
    state = reason === "expired" ? "expired" : reason === "rejected" ? "rejected" : "cancelled";
    detach();
    candidate = factories = cache = chunk = undefined;
    return { state, conflicts: [...conflicts] };
  }
  function observe(object, key, label, handler) {
    if (own(object, key)) throw new Error("Unexpected preexisting bootstrap property");
    const entry = { object, key, label, active: true, setter: undefined };
    entry.setter = function (value) {
      // Reproduce the ordinary assignment as a normal own data property first.
      define(this, key, data(value));
      if (this === object) entry.active = false;
      try { handler(this, value); }
      catch { cancel("rejected"); }
    };
    define(object, key, { set: entry.setter, enumerable: false, configurable: true });
    temporary.push(entry);
    return entry;
  }
  function tableMatches(value) {
    if (!Array.isArray(value) || ownValue(value, "length") !== 3900) return false;
    // All indices are assigned in captured global #0; never invoke a factory.
    for (let index = 0; index < 3900; index++) {
      if (typeof ownValue(value, String(index)) !== "function") return false;
    }
    for (const index of [1, 2, 3, 161, 325, 415, 1123, 1359, 1360, 2813, 2814, 2819]) {
      if (ownValue(ownValue(value, String(index)), "length") !== 3) return false;
    }
    return ownValue(ownValue(value, "0"), "length") === 2;
  }
  function candidateMatches(receiver, value) {
    return typeof receiver === "function" && proto(receiver) === functionPrototype &&
      ownValue(receiver, "name") === "r" && ownValue(receiver, "length") === 1 &&
      typeof ownValue(receiver, "e") === "function" && !own(receiver, "c") &&
      !own(receiver, "s") && tableMatches(value) &&
      typeof ownValue(globalObject, "webpackChunkapplication") === "function" &&
      ownValue(ownValue(globalObject, "webpackChunkapplication"), "length") === 2 &&
      !own(globalObject, "application");
  }
  let prototypeObserver;
  try {
    prototypeObserver = observe(functionPrototype, "m", "Function.prototype.m", (receiver, value) => {
      if (state !== "armed" || !candidateMatches(receiver, value)) {
        if (++unexpectedWrites > 32) cancel("rejected");
        return;
      }
      candidate = receiver;
      factories = value;
      chunk = ownValue(globalObject, "webpackChunkapplication");
      // The only realm-wide observation ends at #1 +0x67, before c or entry.
      removeTemporary(prototypeObserver);
      state = "awaiting-cache";
      observe(candidate, "c", "require.c", (receiverC, valueC) => {
        if (receiverC !== candidate || state !== "awaiting-cache" ||
            !valueC || typeof valueC !== "object" || Array.isArray(valueC) ||
            Reflect.ownKeys(valueC).length !== 0 || ownValue(candidate, "m") !== factories) {
          cancel("rejected"); return;
        }
        cache = valueC;
        state = "awaiting-entry";
        observe(candidate, "s", "require.s", (receiverS, valueS) => {
          const helpers = ["e", "d", "r", "t", "n", "o"];
          if (receiverS !== candidate || valueS !== 1359 || state !== "awaiting-entry" ||
              ownValue(candidate, "m") !== factories || ownValue(candidate, "c") !== cache ||
              ownValue(globalObject, "webpackChunkapplication") !== chunk ||
              helpers.some(key => typeof ownValue(candidate, key) !== "function") ||
              ownValue(candidate, "p") !== "http://0.0.0.0:8081/") {
            cancel("rejected"); return;
          }
          // #1 executes require(1359) after this assignment; the helper does not.
          state = "captured";
        });
      });
    });
    state = "armed";
    deadlineTicket = scheduleCleanup(() => cancel("expired"), maxLifetimeMs);
    deadlineScheduled = true;
    // Reject a scheduler that fires synchronously, before the native evaluation.
    if (state !== "armed") {
      cancelCleanup(deadlineTicket);
      deadlineScheduled = false;
      throw new Error("Cleanup fired before CC evaluation");
    }
  } catch (error) {
    cancel("rejected");
    throw error;
  }
  return Object.freeze({
    status: () => ({ state, unexpectedWrites, conflicts: [...conflicts] }),
    cancel: () => cancel(),
    finish() {
      const entry = cache && ownValue(cache, "1359");
      const application = ownValue(globalObject, "application");
      if (state !== "captured" || ownValue(candidate, "m") !== factories ||
          ownValue(candidate, "c") !== cache || ownValue(candidate, "s") !== 1359 ||
          ownValue(globalObject, "webpackChunkapplication") !== chunk ||
          !entry || ownValue(entry, "i") !== 1359 || ownValue(entry, "l") !== true ||
          !application || ownValue(entry, "exports") !== application) {
        cancel("rejected");
        throw new Error("The expected CC bootstrap was not captured");
      }
      detach();
      if (conflicts.length) {
        state = "rejected";
        candidate = factories = cache = chunk = undefined;
        throw new Error("A bootstrap observer was replaced by another writer");
      }
      const captured = candidate;
      state = "finished";
      candidate = factories = cache = chunk = undefined;
      return captured;
    },
  });
}
