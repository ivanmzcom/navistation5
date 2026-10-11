import {
  FIRMWARE,
  CONTROL_CENTER_HBC_SHA256,
  BASE_DLL_SOURCE_SHA256,
} from "./firmware-profile.mjs";
/** Installs the local renderer at the shared JSX boundary in this CC realm. */
import { installLocalMusicJsx } from "./shellui-jsx-hook.mjs";
import { createBaseLocalMusicRenderer } from "./base-local-music-screen.mjs";

const STATUS = "__navidromeLocalMusicStatus";
const own = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const value = (object, key) => {
  if (!object || (typeof object !== "object" && typeof object !== "function"))
    return undefined;
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

export function startDirectMusic({
  globalObject,
  contextProof,
  audioConfig,
} = {}) {
  if (globalObject !== globalThis || own(globalObject, STATUS)) {
    throw new Error("NDUI: global-or-status-slot");
  }
  const selectedAudioConfig = audioConfig == null ? undefined : audioConfig;
  const proof = {};
  for (const key of [
    "firmware",
    "titleId",
    "isolatedRealm",
    "phase",
    "executorIdentity",
    "bundleSha256",
    "baseDllSha256",
  ])
    proof[key] = value(contextProof, key);
  if (
    proof.firmware !== FIRMWARE ||
    proof.titleId !== "NPXS40003" ||
    proof.isolatedRealm !== true ||
    proof.phase !== "application-running" ||
    proof.bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
    proof.baseDllSha256 !== BASE_DLL_SOURCE_SHA256 ||
    typeof proof.executorIdentity !== "string" ||
    !proof.executorIdentity
  ) {
    throw new Error("NDUI: context-proof");
  }
  Object.freeze(proof);
  const base = value(globalObject, "base_dll");
  const factories = value(base, "m"),
    cache = value(base, "c");
  let active = true,
    phase = "created",
    reason,
    renderer,
    installation,
    published;
  let lastRollback,
    closing = false,
    cleanup;
  const cleanupErrors = [];
  function current() {
    return (
      active &&
      value(globalObject, "base_dll") === base &&
      value(base, "m") === factories &&
      value(base, "c") === cache &&
      (!installation || installation.isRuntimeCurrent())
    );
  }
  function snapshot() {
    const renderState = renderer ? renderer.status() : undefined;
    const hookState = installation ? installation.status() : undefined;
    return Object.freeze({
      schema: 1,
      phase,
      reason,
      route: "shared-jsx",
      needsAction: phase === "installed" ? "reopenMusic" : undefined,
      driver: {
        phase,
        entryRoute: "shared-jsx",
        reopen: "reopenMusic",
        uiInitialization: renderState?.phase || "not-created",
        sessionInitialization:
          renderState?.sessionInitialization || "not-created",
        renderer: renderState,
        hook: hookState,
        lastRollback,
      },
      cleanupErrors: [...cleanupErrors],
    });
  }
  function publish() {
    const before = own(globalObject, STATUS);
    if (
      published !== undefined &&
      (!before ||
        before.value !== published ||
        before.writable !== false ||
        before.enumerable !== false ||
        before.configurable !== true)
    ) {
      throw new Error("NDUI: status-slot-changed");
    }
    const next = snapshot();
    define(globalObject, STATUS, {
      value: next,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    published = next;
    return next;
  }
  function clean() {
    if (cleanup) return cleanup;
    closing = true;
    function complete() {
      active = false;
      if (installation) {
        try {
          lastRollback = installation.uninstall();
        } catch {
          cleanupErrors.push("jsx-uninstall");
        }
      }
      if (phase === "stopping") phase = "disposed";
      return publish();
    }
    let result;
    try {
      result = renderer?.dispose();
    } catch (error) {
      cleanupErrors.push("renderer-dispose");
      throw error;
    }
    if (!result || typeof result.then !== "function") return complete();
    cleanup = result.then(complete, (error) => {
      cleanup = undefined;
      cleanupErrors.push("renderer-dispose");
      publish();
      throw error;
    });
    return cleanup;
  }
  const controller = Object.freeze({
    status() {
      return publish();
    },
    async stopPlayback() {
      if (renderer && typeof renderer.stopPlayback === "function")
        await renderer.stopPlayback();
      return publish();
    },
    dispose() {
      if (active) {
        phase = "stopping";
        reason = "explicit-dispose";
        return clean();
      }
      return publish();
    },
  });
  publish();
  try {
    if (typeof base !== "function" || !factories || !cache)
      throw new Error("NDUI: base-runtime");
    renderer = createBaseLocalMusicRenderer({
      globalObject,
      contextProof: proof,
      audioConfig: selectedAudioConfig,
      isRuntimeCurrent: current,
      onState: (state) => {
        if (published === undefined) return;
        if (active && !closing && state.phase === "failed") {
          phase = "failed";
          reason = "NDUI: renderer-failed";
          const stopped = clean();
          if (stopped && typeof stopped.catch === "function")
            stopped.catch(() => undefined);
        }
        publish();
      },
    });
    installation = installLocalMusicJsx({
      globalObject,
      baseRequire: base,
      contextProof: proof,
      LocalMusic: renderer.Component,
      beforePower: () => controller.dispose(),
      onState: () => {
        if (active && phase === "installed") publish();
      },
    });
    phase = "installed";
    publish();
  } catch (error) {
    phase = "failed";
    const message = value(error, "message");
    reason =
      typeof message === "string" && /^(NDUI|NDJSX): [a-z0-9-]+$/.test(message)
        ? message
        : "direct-ui-install-failed";
    const stopped = clean();
    if (stopped && typeof stopped.catch === "function")
      stopped.catch(() => undefined);
    publish();
  }
  return controller;
}
