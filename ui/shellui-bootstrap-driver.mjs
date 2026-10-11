/** Inactive composition API. The native loader owns executor authentication/evaluation. */
import { armControlCenterRequireCapture } from "./capture-control-center-require.mjs";
import { armControlCenterRequirePostboot } from "./capture-control-center-require-postboot.mjs";
import { installLocalMusicEntry, installLocalMusicMenu, CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";
import { createLocalMusicScreen } from "./local-music-screen.mjs";
import { createShellUiLocalSession } from "./shellui-local-session.mjs";
import { BASE_DLL_HBC_SHA256 } from "./rnps-networking-transport.mjs";

const value = (object, key) => {
  if ((typeof object !== "object" || object === null) && typeof object !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

export const BASE_DLL_SOURCE_SHA256 = "924e90c2257cd6b0a1e895dc45abf4882ddd3504a6c32964ff74d259b975092c";
const NATIVE_COMPONENTS = [
  ["View", "KHrppdvq"], ["Text", "goS0m6II"], ["Button", "lmmSrzlb"],
  ["TextInput", "asrd/hDd"], ["FocusLayerPS", "gWzUSBF9", "default"],
];

function loaded(require, id) {
  const cache = value(require, "c");
  const factories = value(require, "m");
  if (!cache || typeof cache !== "object" || typeof value(factories, String(id)) !== "function") return undefined;
  const module = value(cache, String(id));
  if (!module || value(module, "i") !== id || value(module, "l") !== true) return undefined;
  return value(module, "exports");
}

/**
 * No globals, prototype hooks, target module factories or network calls at creation.
 * Bindings may be absent: the UI can truthfully show connection/audio unavailable.
 * Never invokes evaluation itself; loader evaluates arm -> normal CC boot -> finish,
 * or arms postboot and waits for an otherwise normal uncached module request.
 */
export function createShellUiBootstrapDriver({ globalObject, scheduleCleanup,
  cancelCleanup, maxLifetimeMs = 1000, LocalMusic, client, library, onLogin, onPlay } = {}) {
  let phase = "created", observer, require, installation, mode, entryRoute, reopen, activeUiGeneration;
  let bindings = { LocalMusic, client, library, onLogin, onPlay };
  let missingModules = [], lastRollback, lastCaptureRollback, uiInitialization = "not-created";
  let ownedSession, sessionInitialization = "not-created";

  const status = () => ({ phase, mode, entryRoute, reopen, capture: observer?.status(),
    missingModules: [...missingModules], lastRollback, lastCaptureRollback, uiInitialization,
    sessionInitialization, session: ownedSession?.status() });
  function assertUsable() {
    if (phase === "disposed") throw new Error("The CC bootstrap driver is disposed");
  }
  return Object.freeze({
    status,
    armCapture({ mode: requestedMode, contextProof } = {}) {
      assertUsable();
      if (observer || require || installation) throw new Error("A capture is already owned by this driver");
      if (requestedMode !== "preboot" && requestedMode !== "postboot") {
        throw new TypeError("Select preboot or postboot capture explicitly");
      }
      if (contextProof?.baseDllSha256 !== BASE_DLL_SOURCE_SHA256) {
        throw new Error("The loader must verify the captured shared base_dll identity");
      }
      const arm = requestedMode === "preboot" ? armControlCenterRequireCapture : armControlCenterRequirePostboot;
      observer = arm({ globalObject, contextProof, scheduleCleanup, cancelCleanup, maxLifetimeMs });
      mode = requestedMode;
      phase = "waiting-capture";
      return status();
    },
    completeCapture() {
      assertUsable();
      if (require) return status();
      if (!observer) throw new Error("No capture is armed");
      const observed = observer.status();
      if (observed.state !== "captured") {
        phase = ["cancelled", "rejected", "expired"].includes(observed.state) ? "capture-failed" : "waiting-capture";
        return status();
      }
      try {
        // Call only after normal bundle/factory execution returns to the host.
        require = observer.finish();
        phase = "require-captured";
      } catch (error) {
        lastCaptureRollback = observer.cancel(); phase = "capture-failed";
        throw error;
      }
      return status();
    },
    setBindings(next = {}) {
      assertUsable();
      if (installation) throw new Error("Close the local view and uninstall before changing bindings");
      for (const key of ["LocalMusic", "client", "library", "onLogin", "onPlay"]) {
        if (Object.prototype.hasOwnProperty.call(next, key)) bindings[key] = next[key];
      }
      return status();
    },
    tryInstall() {
      assertUsable();
      if (installation) return status();
      if (!require) throw new Error("Capture the loader before installing the local music menu");
      if (typeof Reflect !== "object" || !Reflect || typeof Reflect.apply !== "function") {
        throw new Error("The native apply intrinsic is unavailable");
      }
      const useLoadedContainer = loaded(require, 2814) !== undefined;
      // Prefer 2814 only if it was already loaded by normal UI use.
      const ids = useLoadedContainer ? [1, 2, 3, 2814] : [1, 2, 3, 74, 2813];
      const modules = new Map();
      missingModules = [];
      for (const id of ids) {
        const exports = loaded(require, id);
        if (exports === undefined) missingModules.push(id);
        else modules.set(id, exports);
      }
      const base = value(globalObject, "base_dll");
      const baseFactories = value(base, "m"), baseCache = value(base, "c");
      const allowedFactories = new Map();
      // module 1's native properties are accessors that can require factories.
      // Inspect their known factory targets now; initialize only in local render.
      if (typeof base !== "function" || loaded(base, "NiSiE5q6") !== modules.get(1) ||
          loaded(base, "ogN/Sdtl") !== modules.get(2) || loaded(base, "DkKR87qr") !== modules.get(3)) {
        missingModules.push("base_dll:identity");
      } else {
        for (const [, id] of NATIVE_COMPONENTS) {
          const factory = value(baseFactories, id);
          if (typeof factory !== "function") missingModules.push(`base_dll:factory:${id}`);
          else allowedFactories.set(id, factory);
        }
      }
      if (missingModules.length) {
        phase = "waiting-modules";
        return status();
      }
      try {
        if (bindings.LocalMusic !== undefined && typeof bindings.LocalMusic !== "function") {
          throw new TypeError("An optional local renderer must be a real React component function");
        }
        const reactExports = modules.get(2);
        const React = typeof value(reactExports, "Component") === "function" ? reactExports : value(reactExports, "default");
        const jsx = value(modules.get(3), "jsx");
        if (typeof jsx !== "function") throw new Error("The captured JSX runtime is unavailable");
        let Component, native;
        const generation = {};
        activeUiGeneration = generation;
        uiInitialization = "pending-local-render";
        function initializeLocalUi() {
          if (!installation || phase === "disposed" || activeUiGeneration !== generation) {
            throw new Error("The local music binding is no longer installed");
          }
          if (uiInitialization === "ready") return;
          if (uiInitialization !== "pending-local-render") throw new Error("Local UI initialization is unavailable");
          uiInitialization = "initializing";
          try {
            if (value(globalObject, "base_dll") !== base || value(base, "m") !== baseFactories ||
                value(base, "c") !== baseCache || loaded(base, "NiSiE5q6") !== modules.get(1) ||
                loaded(base, "ogN/Sdtl") !== modules.get(2) || loaded(base, "DkKR87qr") !== modules.get(3)) {
              throw new Error("The shared UI runtime changed");
            }
            native = {};
            for (const [name, id, member] of NATIVE_COMPONENTS) {
              if (value(baseFactories, id) !== allowedFactories.get(id)) throw new Error("A native UI factory changed");
              let exported = loaded(base, id);
              if (exported === undefined) {
                if (value(baseCache, id) !== undefined) throw new Error("A native UI module is incomplete");
                // Five audited primitive modules only; normal local React render,
                // never installation, capture, a Sony music module, or a getter.
                const result = Reflect.apply(base, undefined, [id]);
                exported = loaded(base, id);
                if (exported === undefined || exported !== result) throw new Error("Native UI initialization did not complete");
              }
              native[name] = member ? value(exported, member) : exported;
              if (!native[name]) throw new Error("A native UI primitive is unavailable");
            }
            Component = bindings.LocalMusic || createLocalMusicScreen({ React, native });
            if (bindings.client === undefined && bindings.library === undefined && bindings.onLogin === undefined) {
              sessionInitialization = "initializing";
              try {
                ownedSession = createShellUiLocalSession({ require, baseRequire: base,
                  firmware: 0x13200006, bundleSha256: CONTROL_CENTER_HBC_SHA256,
                  baseBundleSha256: BASE_DLL_HBC_SHA256,
                  isRuntimeCurrent: () => !!installation && phase !== "disposed" &&
                    activeUiGeneration === generation && value(globalObject, "base_dll") === base &&
                    value(base, "m") === baseFactories && value(base, "c") === baseCache,
                });
                sessionInitialization = "ready";
              } catch {
                // Keep the local view accessible if its real runtime bindings
                // are unavailable. The renderer disables connection controls.
                sessionInitialization = "unavailable";
              }
            } else sessionInitialization = "external-bindings";
            uiInitialization = "ready";
          } catch (error) {
            uiInitialization = "failed";
            throw error;
          }
        }
        function LazyLocalMusic(props) {
          initializeLocalUi();
          return jsx(Component, ownedSession ? { ...props, ...ownedSession.bindings() } : props);
        }
        function LocalMusicFrame(props) {
          initializeLocalUi();
          return jsx(native.View, props);
        }
        const install = useLoadedContainer ? installLocalMusicEntry : installLocalMusicMenu;
        installation = install({ require, firmware: 0x13200006,
          bundleSha256: CONTROL_CENTER_HBC_SHA256, ...bindings, LocalMusic: LazyLocalMusic, View: LocalMusicFrame });
        entryRoute = useLoadedContainer ? "cached-container-2814" : "memo-menu-2813";
        reopen = useLoadedContainer ? "reopenMusic" : "reopenControlCenter";
        phase = "installed";
      } catch (error) {
        activeUiGeneration = undefined;
        uiInitialization = "not-created";
        phase = "install-failed";
        throw error;
      }
      return status();
    },
    uninstall() {
      assertUsable();
      if (!installation) return status();
      ownedSession?.dispose(); ownedSession = undefined;
      sessionInitialization = "not-created";
      lastRollback = installation?.uninstall() || { restored: [], conflicts: [] };
      installation = undefined;
      activeUiGeneration = undefined;
      entryRoute = reopen = undefined;
      uiInitialization = "not-created";
      phase = require ? "require-captured" : "created";
      return status();
    },
    dispose() {
      if (phase === "disposed") return status();
      ownedSession?.dispose(); ownedSession = undefined;
      sessionInitialization = "not-created";
      lastRollback = installation?.uninstall() || { restored: [], conflicts: [] };
      installation = undefined;
      activeUiGeneration = undefined;
      entryRoute = reopen = undefined;
      uiInitialization = "not-created";
      if (observer) lastCaptureRollback = observer.cancel();
      observer = undefined;
      require = undefined; bindings = {}; missingModules = [];
      phase = "disposed";
      return status();
    },
  });
}
