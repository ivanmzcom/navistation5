/**
 * Local Music renderer for an already authenticated Control Center JS realm.
 * Uses base_dll only; importing or creating it does not load factories or log in.
 * The caller installs/restores its entry hook and owns executor authentication.
 */
import { createLocalMusicScreen } from "./local-music-screen.mjs";
import { createShellUiBaseLocalSession } from "./shellui-base-local-session.mjs";
import { BASE_DLL_HBC_SHA256 } from "./rnps-networking-transport.mjs";
import { idleAudioStatus } from "./audio-player.mjs";
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

const BASE_SOURCE_SHA256 = "924e90c2257cd6b0a1e895dc45abf4882ddd3504a6c32964ff74d259b975092c";
const PRIMITIVES = [
  ["View", "KHrppdvq"], ["Text", "goS0m6II"], ["Button", "lmmSrzlb"],
  ["TextInput", "asrd/hDd"], ["FocusLayerPS", "gWzUSBF9", "default"],
  ["Image", "DNUs8Rda"], ["FontSizePS", "MESJr5x+", "default"],
];
const MODULE_LABELS = {
  "ogN/Sdtl": "react", DkKR87qr: "jsx", KHrppdvq: "view", goS0m6II: "text",
  lmmSrzlb: "button", "asrd/hDd": "text-input", gWzUSBF9: "focus-layer",
  DNUs8Rda: "image", "MESJr5x+": "font-size",
};

function own(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * contextProof uses the existing native-loader shape: firmware, bundleSha256,
 * baseDllSha256 (source SHA), titleId, isolatedRealm, phase, executorIdentity.
 * Those values are assertions by the caller, not JS verification of the native
 * executor. isRuntimeCurrent must remain true for that actual executor/realm.
 *
 * Component receives the original stock props plus optional renderStockMusic
 * supplied by the entry hook. Normal local rendering offers it as an explicit
 * UI choice. After a local failure, onState must restore the hook synchronously;
 * fallback requests requireRestored=true and cannot bypass an active hook.
 * No stock client/onLogin/onPlay props become bindings for the local screen.
 * Audio stays disabled until a separate, real backend is connected.
 */
export function createBaseLocalMusicRenderer({ globalObject, contextProof,
  isRuntimeCurrent, onState, audioConfig } = {}) {
  if (typeof globalThis === "undefined" || globalObject !== globalThis ||
      typeof isRuntimeCurrent !== "function" ||
      (onState !== undefined && typeof onState !== "function") ||
      typeof Reflect !== "object" || !Reflect || typeof Reflect.apply !== "function") {
    throw new Error("NDUI: renderer-context");
  }
  let initialCurrent = false;
  try { initialCurrent = isRuntimeCurrent() === true; } catch { /* Fixed diagnostic below. */ }
  if (!initialCurrent) throw new Error("NDUI: renderer-runtime");
  if (own(contextProof, "firmware") !== 0x13200006 ||
      own(contextProof, "bundleSha256") !== CONTROL_CENTER_HBC_SHA256 ||
      own(contextProof, "baseDllSha256") !== BASE_SOURCE_SHA256 ||
      own(contextProof, "titleId") !== "NPXS40003" || own(contextProof, "isolatedRealm") !== true ||
      own(contextProof, "phase") !== "application-running" ||
      typeof own(contextProof, "executorIdentity") !== "string" ||
      !own(contextProof, "executorIdentity")) {
    throw new Error("NDUI: renderer-proof");
  }
  const base = own(globalObject, "base_dll"), factories = own(base, "m"), cache = own(base, "c");
  if (typeof base !== "function" || !factories || !cache) {
    throw new Error("NDUI: base-loader");
  }
  const allowed = new Map(), records = [];
  let phase = "created", reason, failureReason, fallback = "not-used";
  let sessionInitialization = "not-created", renders = 0;
  let session, LocalMusic, sessionReason;
  const native = {};
  for (const [, id] of PRIMITIVES) {
    const factory = own(factories, id);
    if (typeof factory !== "function") throw new Error(`NDUI: ${MODULE_LABELS[id]}-factory`);
    allowed.set(id, factory);
  }

  function current() {
    return phase !== "disposed" && phase !== "failed" && isRuntimeCurrent() &&
      own(globalObject, "base_dll") === base && own(base, "m") === factories && own(base, "c") === cache &&
      [...allowed].every(([id, factory]) => own(factories, id) === factory) &&
      records.every(({ id, record, exported, factory }) => own(cache, id) === record &&
        own(record, "i") === id && own(record, "l") === true && own(record, "exports") === exported &&
        own(factories, id) === factory);
  }
  function pinModule(id, allowInitialize) {
    if (!current()) throw new Error("NDUI: renderer-runtime");
    const label = MODULE_LABELS[id] || "module";
    const factory = own(factories, id);
    let record = own(cache, id), returned;
    if (typeof factory !== "function") throw new Error(`NDUI: ${label}-factory`);
    if (record === undefined && allowInitialize) {
      try { returned = Reflect.apply(base, undefined, [id]); }
      catch { throw new Error(`NDUI: ${label}-initialize`); }
      record = own(cache, id);
    }
    const exported = own(record, "exports");
    if (!record || own(record, "i") !== id || own(record, "l") !== true || exported === undefined ||
        (returned !== undefined && returned !== exported)) {
      throw new Error(`NDUI: ${label}-cache`);
    }
    records.push({ id, record, exported, factory });
    if (!current()) throw new Error("NDUI: renderer-runtime");
    return exported;
  }
  // These aliases must already be cached. Their factories are never forced here.
  const React = pinModule("ogN/Sdtl", false);
  const jsxExports = pinModule("DkKR87qr", false);
  const ReactComponent = own(React, "Component"), createElement = own(React, "createElement");
  if (typeof ReactComponent !== "function" || typeof createElement !== "function" ||
      typeof own(jsxExports, "jsx") !== "function") {
    throw new Error("NDUI: react-jsx-shape");
  }
  function uiCurrent() {
    return current() && own(React, "Component") === ReactComponent && own(React, "createElement") === createElement;
  }
  function status() {
    let connection;
    try { connection = session?.status(); } catch { connection = { unavailable: true }; }
    return Object.freeze({ phase, reason, failureReason, fallback, sessionInitialization, sessionReason, renders,
      runtime: "base_dll", playbackAvailable: connection?.playback?.available === true,
      playback: connection?.playback || idleAudioStatus(), session: connection });
  }
  function notify() {
    // Diagnostics receive no stock props, credentials, server responses or errors.
    try { onState?.(status()); } catch { /* Diagnostics must not interrupt rendering. */ }
  }
  function fail(code) {
    if (phase === "disposed") return;
    phase = "failed"; reason = code; failureReason = failureReason || code;
    try { session?.dispose(); } catch { /* Preserve the original fixed failure code. */ }
    // Retain the disposed session so late Stop ACK diagnostics stay observable.
    if (sessionInitialization === "ready") sessionInitialization = "disposed";
    notify();
  }
  function initialize() {
    if (!uiCurrent()) throw new Error("NDUI: renderer-runtime");
    if (phase === "ready") return;
    if (phase !== "created") throw new Error("NDUI: initialization-state");
    phase = "initializing";
    notify();
    for (const [name, id, member] of PRIMITIVES) {
      const exported = pinModule(id, true);
      const component = member ? own(exported, member) : exported;
      if (!component || (typeof component !== "function" && typeof component !== "object")) {
        throw new Error(`NDUI: ${MODULE_LABELS[id]}-component`);
      }
      native[name] = component;
    }
    try { LocalMusic = createLocalMusicScreen({ React, native }); }
    catch { throw new Error("NDUI: local-screen-create"); }
    if (typeof LocalMusic !== "function") throw new Error("NDUI: local-screen-shape");
    sessionInitialization = "initializing";
    try {
      session = createShellUiBaseLocalSession({ baseRequire: base, firmware: 0x13200006,
        baseBundleSha256: BASE_DLL_HBC_SHA256, isRuntimeCurrent: uiCurrent, onState: notify, audioConfig });
      sessionInitialization = "ready";
    } catch (error) {
      // The real local screen remains usable and disables unavailable login.
      sessionInitialization = "unavailable";
      const code = own(error, "code");
      sessionReason = typeof code === "string" && /^ND(SESSION|NET|RNG)_[A-Z0-9_]{1,48}$/.test(code) ?
        code : "NDSESSION_INITIALIZATION_UNKNOWN";
    }
    if (!uiCurrent()) throw new Error("NDUI: renderer-runtime");
    phase = "ready";
    notify();
  }

  function restoredStock(stockProps) {
    const renderStockMusic = own(stockProps, "renderStockMusic");
    if (typeof renderStockMusic !== "function") {
      fallback = "unavailable"; notify(); return null;
    }
    try {
      // The hook independently checks confirmed restoration and the original
      // runtime/descriptors. A failed or absent cleanup cannot mount stock here.
      const element = Reflect.apply(renderStockMusic, undefined, [{ requireRestored: true }]);
      fallback = "stock"; notify(); return element;
    } catch {
      fallback = "blocked"; notify(); return null;
    }
  }
  class LocalMusicBoundary extends ReactComponent {
    constructor(props) {
      super(props);
      this.state = { failed: false, recoveryReady: false };
      this.failureReported = false;
    }
    static getDerivedStateFromError() {
      // React invokes this for descendant render/commit failures. Do not mount
      // either branch again until componentDidCatch has requested rollback.
      return { failed: true, recoveryReady: false };
    }
    componentDidCatch() {
      // Do not inspect the error or component stack, which can contain props.
      if (this.failureReported) {
        // The one attempted stock fallback also failed. The derived state
        // already selects null; never repeat the Sony subtree indefinitely.
        fallback = "blocked-descendant";
        notify();
        return;
      }
      this.failureReported = true;
      fail("NDUI: local-descendant-failed");
      this.setState({ recoveryReady: true });
    }
    render() {
      if (this.state.failed) {
        return this.state.recoveryReady ? restoredStock(own(this.props, "stockProps")) : null;
      }
      return own(this.props, "children");
    }
  }
  function Component(stockProps) {
    if (phase === "disposed" || phase === "failed") return restoredStock(stockProps);
    try {
      initialize();
      if (!uiCurrent()) throw new Error("NDUI: renderer-runtime");
      renders++;
      const renderStockMusic = own(stockProps, "renderStockMusic");
      const props = { shellProps: stockProps, ...(session ? session.bindings() : {}) };
      if (typeof renderStockMusic === "function") props.renderStockMusic = renderStockMusic;
      // React.createElement is shared with JSX but does not re-enter the caller's
      // JSX interception. The existing outer menu retains its layout/width/height.
      const localElement = Reflect.apply(createElement, React, [LocalMusic, props]);
      const element = Reflect.apply(createElement, React, [LocalMusicBoundary, {
        stockProps, children: localElement,
      }]);
      notify();
      return element;
    } catch (error) {
      const message = own(error, "message");
      const code = typeof message === "string" && /^NDUI: [a-z0-9-]+$/.test(message) ?
        message : "NDUI: local-render-failed";
      fail(code);
      return restoredStock(stockProps);
    }
  }

  return Object.freeze({ Component, status,
    stopPlayback: () => session ? session.stopPlayback() : Promise.resolve(idleAudioStatus()),
    dispose() {
    if (phase === "disposed") return status();
    phase = "disposed";
    try { session?.dispose(); } catch { if (!failureReason) reason = "NDUI: session-dispose-failed"; }
    // Session keeps only disposed clients and the owned player until Stop ACK.
    LocalMusic = undefined;
    for (const key of Object.keys(native)) delete native[key];
    sessionInitialization = "disposed";
    notify();
    return status();
  } });
}
