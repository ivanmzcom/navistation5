/**
 * Reversible CC Music element substitution, before its constructor runs.
 * Importing this module installs nothing. No require or target factory is called.
 * Evidence: capture/hermes-analysis/ui-hook-contract/jsx-music-entry.md.
 */
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

const BASE_SOURCE_SHA256 = "924e90c2257cd6b0a1e895dc45abf4882ddd3504a6c32964ff74d259b975092c";
const own = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const prototype = Object.getPrototypeOf;
const create = Object.create;
const apply = typeof Reflect === "object" && Reflect ? Reflect.apply : undefined;
const keys = typeof Reflect === "object" && Reflect ? Reflect.ownKeys : undefined;
const owners = new WeakMap();
const CC_JSONP = 46403;
const CC_MUSIC_CONSTRUCTOR = 3170820;
const CC_MUSIC_RENDER = 3172469;
const BASE_REQUIRE = 4833;
const BASE_ALIAS_FACTORY = 88878;
const BASE_JSX_FACTORY = 444035;
const BASE_JSX = 444175;

function value(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function same(a, b) {
  return !!a && !!b && a.value === b.value && a.get === b.get && a.set === b.set &&
    a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable;
}

function completeModule(cache, id) {
  const module = value(cache, id);
  if (!module || value(module, "i") !== id || value(module, "l") !== true) return undefined;
  return module;
}

/**
 * contextProof is supplied by the independently verified native loader; these
 * JavaScript fields cannot authenticate themselves. The native loader must have
 * selected the isolated, application-running CC executor and captured bundles.
 * LocalMusic receives the original shell prop values plus renderStockMusic.
 * The explicit stock callback calls the original JSX function, bypassing this
 * substitution. Normal local rendering does not call that callback. A local
 * failure may request requireRestored=true after confirmed hook rollback.
 * Reopen Music after installation; an already mounted tree is not remounted.
 */
export function installLocalMusicJsx({ globalObject, baseRequire, contextProof, LocalMusic, onState } = {}) {
  if (typeof apply !== "function" || typeof keys !== "function" ||
      globalObject !== globalThis || value(globalObject, "Object") !== Object ||
      value(globalObject, "Function") !== Function || typeof LocalMusic !== "function" ||
      (onState !== undefined && typeof onState !== "function") ||
      value(contextProof, "firmware") !== 0x13200006 ||
      value(contextProof, "bundleSha256") !== CONTROL_CENTER_HBC_SHA256 ||
      value(contextProof, "baseDllSha256") !== BASE_SOURCE_SHA256 ||
      value(contextProof, "titleId") !== "NPXS40003" ||
      value(contextProof, "isolatedRealm") !== true ||
      value(contextProof, "phase") !== "application-running" ||
      typeof value(contextProof, "executorIdentity") !== "string" ||
      !value(contextProof, "executorIdentity")) {
    throw new Error("NDJSX: context-proof");
  }
  const hermes = value(globalObject, "HermesInternal");
  const locate = value(hermes, "getFunctionLocation");
  let nativeLocation;
  try { if (typeof locate === "function") nativeLocation = apply(locate, hermes, [locate]); }
  catch { throw new Error("NDJSX: location-intrinsic-read"); }
  if (typeof locate !== "function" || value(nativeLocation, "isNative") !== true) {
    throw new Error("NDJSX: location-unavailable");
  }
  // Hermes registers this intrinsic with length=0; do not infer its arguments
  // from Function.length. It reads its first argument and returns own data.
  function location(fn, offset, expectedFile) {
    if (typeof fn !== "function") return undefined;
    let record;
    try { record = apply(locate, hermes, [fn]); }
    catch { throw new Error("NDJSX: location-function-read"); }
    const file = value(record, "fileName");
    if (value(record, "isNative") !== false || value(record, "segmentID") !== 0 ||
        value(record, "virtualOffset") !== offset || typeof file !== "string" ||
        !file || file.length > 4096 || (expectedFile !== undefined && file !== expectedFile)) return undefined;
    return file;
  }
  const application = value(globalObject, "application");
  const chunk = value(globalObject, "webpackChunkapplication");
  const ccFile = location(chunk, CC_JSONP);
  const base = value(globalObject, "base_dll");
  const baseFile = location(base, BASE_REQUIRE);
  if (!application || value(chunk, "length") !== 2 || !ccFile) throw new Error("NDJSX: cc-fingerprint");
  if (!baseFile) throw new Error("NDJSX: base-fingerprint");
  const factories = value(base, "m"), cache = value(base, "c");
  const aliasFactory = value(factories, "DkKR87qr");
  const jsxFactory = value(factories, "oEJgnyX8");
  const aliasModule = completeModule(cache, "DkKR87qr");
  const jsxModule = completeModule(cache, "oEJgnyX8");
  const exported = value(aliasModule, "exports");
  if (baseRequire !== undefined && baseRequire !== base) throw new Error("NDJSX: base-identity");
  if (!factories || !cache || !aliasModule || !jsxModule || !exported ||
      exported !== value(jsxModule, "exports") || owners.has(exported)) {
    throw new Error("NDJSX: module-fingerprint");
  }
  if (!location(aliasFactory, BASE_ALIAS_FACTORY, baseFile)) throw new Error("NDJSX: alias-factory-fingerprint");
  if (!location(jsxFactory, BASE_JSX_FACTORY, baseFile)) throw new Error("NDJSX: jsx-factory-fingerprint");
  const beforeJsx = own(exported, "jsx"), beforeJsxs = own(exported, "jsxs");
  const original = beforeJsx && beforeJsx.value;
  for (const descriptor of [beforeJsx, beforeJsxs]) {
    if (!descriptor || !("value" in descriptor) || descriptor.value !== original ||
        typeof original !== "function" || (!descriptor.configurable && !descriptor.writable)) {
      throw new Error("NDJSX: alias-descriptors");
    }
  }
  if (value(original, "length") !== 3 || !location(original, BASE_JSX, baseFile)) {
    throw new Error("NDJSX: jsx-fingerprint");
  }

  let active = false, removed = false, candidates = 0, substitutions = 0;
  let reason, lastRollback;
  const conflicts = [];
  const owner = {};
  let afterJsx, afterJsxs;

  function runtimeIdentity() {
    return value(globalObject, "application") === application &&
      value(globalObject, "webpackChunkapplication") === chunk &&
      value(globalObject, "HermesInternal") === hermes &&
      value(hermes, "getFunctionLocation") === locate && value(globalObject, "base_dll") === base &&
      value(base, "m") === factories && value(base, "c") === cache &&
      value(factories, "DkKR87qr") === aliasFactory && value(factories, "oEJgnyX8") === jsxFactory &&
      completeModule(cache, "DkKR87qr") === aliasModule && completeModule(cache, "oEJgnyX8") === jsxModule &&
      value(aliasModule, "exports") === exported && value(jsxModule, "exports") === exported;
  }
  function isRuntimeCurrent() {
    return active && !removed && owners.get(exported) === owner && runtimeIdentity() &&
      same(own(exported, "jsx"), afterJsx) && same(own(exported, "jsxs"), afterJsxs);
  }
  function status() {
    return { active, removed, candidates, substitutions, reason,
      conflicts: [...conflicts], lastRollback: lastRollback && {
        restored: [...lastRollback.restored], conflicts: [...lastRollback.conflicts],
      } };
  }
  function notify() {
    // Only counters and fixed state codes; publication must not break rendering.
    try { if (onState) onState(status()); } catch { /* Caller owns diagnostics. */ }
  }
  function restoredRuntime() {
    return removed && !active && conflicts.length === 0 && runtimeIdentity() &&
      same(own(exported, "jsx"), beforeJsx) && same(own(exported, "jsxs"), beforeJsxs);
  }
  function restore() {
    if (removed) return { restored: [], conflicts: [] };
    active = false;
    const restored = [], failed = [];
    for (const [key, before, after] of [["jsxs", beforeJsxs, afterJsxs], ["jsx", beforeJsx, afterJsx]]) {
      if (same(own(exported, key), before)) continue;
      if (after && same(own(exported, key), after)) {
        try {
          define(exported, key, before);
          if (same(own(exported, key), before)) restored.push(key);
          else failed.push(key);
        } catch { failed.push(key); }
      } else failed.push(key);
    }
    for (const key of failed) if (!conflicts.includes(key)) conflicts.push(key);
    if (!failed.length && owners.get(exported) === owner) owners.delete(exported);
    removed = !failed.length;
    lastRollback = { restored, conflicts: failed };
    notify();
    return { restored: [...restored], conflicts: [...failed] };
  }
  function wrapper(...args) {
    let forwarded = args;
    if (active && args.length >= 2 && typeof args[0] === "function" && args[0] !== LocalMusic &&
        args[1] !== null && typeof args[1] === "object") {
      try {
        const Type = args[0], props = args[1];
        const connection = own(props, "connectionStatus"), layout = own(props, "layoutStatus");
        const classPrototype = value(Type, "prototype");
        const render = value(classPrototype, "render");
        if (connection && "value" in connection && layout && "value" in layout &&
            typeof render === "function" && value(classPrototype, "constructor") === Type) {
          if (candidates < 999999) { candidates++; notify(); }
          if (!isRuntimeCurrent()) {
            reason = "runtime-changed"; restore();
          } else if (location(Type, CC_MUSIC_CONSTRUCTOR, ccFile) &&
              location(render, CC_MUSIC_RENDER, ccFile)) {
            if (own(props, "renderStockMusic")) throw new Error("NDJSX: stock-prop-collision");
            const receiver = this;
            const originalArgs = args;
            const localProps = create(prototype(props));
            for (const key of keys(props)) {
              const descriptor = own(props, key);
              if (!descriptor || !("value" in descriptor)) throw new Error("NDJSX: props-accessor");
              define(localProps, key, descriptor);
            }
            define(localProps, "renderStockMusic", { configurable: true, enumerable: true, writable: false,
              value: function renderStockMusic(options) {
                const requireRestored = value(options, "requireRestored") === true;
                if (!(requireRestored ? restoredRuntime() : isRuntimeCurrent() || restoredRuntime()) ||
                    value(Type, "prototype") !== classPrototype || value(classPrototype, "render") !== render ||
                    value(classPrototype, "constructor") !== Type) throw new Error("NDJSX: entry-inactive");
                return apply(original, receiver, originalArgs);
              },
            });
            forwarded = [...args];
            forwarded[0] = LocalMusic;
            forwarded[1] = localProps;
            if (substitutions < 999999) { substitutions++; notify(); }
          }
        }
      } catch {
        // Preserve the normal JSX operation exactly once on an observer fault;
        // restore only descriptors still owned by this installation.
        reason = "element-guard-failed";
        try { restore(); } catch { active = false; }
        forwarded = args;
      }
    }
    return apply(original, this, forwarded);
  }
  afterJsx = { ...beforeJsx, value: wrapper };
  afterJsxs = { ...beforeJsxs, value: wrapper };
  try {
    if (!runtimeIdentity() || !same(own(exported, "jsx"), beforeJsx) ||
        !same(own(exported, "jsxs"), beforeJsxs)) throw new Error("NDJSX: preinstall-identity");
    owners.set(exported, owner);
    define(exported, "jsx", afterJsx);
    define(exported, "jsxs", afterJsxs);
    active = true;
    if (!isRuntimeCurrent()) throw new Error("NDJSX: installed-identity");
    notify();
  } catch (error) {
    restore();
    throw error;
  }
  return Object.freeze({
    status,
    isRuntimeCurrent,
    uninstall: () => restore(),
  });
}
