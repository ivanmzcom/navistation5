import test from "node:test";
import { startDirectMusic } from "./start-direct-music.mjs";
import {
  CONTROL_CENTER_HBC_SHA256,
  BASE_DLL_SOURCE_SHA256,
} from "./firmware-profile.mjs";
import assert from "node:assert/strict";
import { FIRMWARE, BASE_DLL_HBC_SHA256 } from "./firmware-profile.mjs";
import { createResidentAudioControlTransport } from "./resident-audio-control-transport.mjs";
import { createShellUiBaseLocalSession } from "./shellui-base-local-session.mjs";
const TOKEN = "a".repeat(64),
  URI = "http://navidrome.local:4533/rest/stream.view?id=fixture";
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function setup() {
  const calls = [],
    timers = new Map();
  let nextTimer = 0,
    nextId = 40,
    valid = true,
    slot = null,
    currentOverride,
    handler;
  const media = {
    PlayerCommands: {
      pauseCommand: "pause",
      playCommand: "play",
      stopCommand: "stop",
    },
    GetCurrentPlayInfo(options) {
      calls.push({ method: "query", options });
      if (handler) {
        const v = handler("query", options);
        if (v !== undefined) return v;
      }
      if (options.serviceType === undefined && currentOverride !== undefined)
        return Promise.resolve(currentOverride);
      return Promise.resolve(
        slot
          ? { ...slot }
          : options.serviceType === 20
            ? { result: -1000, errorState: 0 }
            : { result: -3001 },
      );
    },
    PlayMediaUri(options) {
      calls.push({ method: "play", options });
      if (handler) {
        const v = handler("play", options);
        if (v !== undefined) return v;
      }
      slot = {
        result: 0,
        serviceType: 20,
        srcId: ++nextId,
        isPlaying: 1,
        srcUri: "",
        progressMs: 1250.5,
        durationMs: 90001,
      };
      return Promise.resolve({ result: 0, serviceType: 20, srcId: slot.srcId });
    },
    RemoveSourceById(options) {
      calls.push({ method: "remove", options });
      if (handler) {
        const v = handler("remove", options);
        if (v !== undefined) return v;
      }
      assert.equal(options.srcId, slot.srcId);
      slot = null;
      return Promise.resolve({ result: 0 });
    },
    PlayerCommand(options) {
      calls.push({ method: "command", options });
      if (handler) {
        const v = handler("command", options);
        if (v !== undefined) return v;
      }
      assert.equal(options.srcId, slot.srcId);
      slot.isPlaying = options.command === "play" ? 1 : 0;
      return Promise.resolve({ result: 0 });
    },
  };
  function baseRequire() {
    throw new Error("No factory initialization allowed");
  }
  baseRequire.c = {
    bX5JscBE: { i: "bX5JscBE", l: true, exports: { VshNMMediaModule: media } },
  };
  baseRequire.m = { bX5JscBE() {} };
  const config = {
    token: TOKEN,
    baseRequire,
    firmware: FIRMWARE,
    baseBundleSha256: BASE_DLL_HBC_SHA256,
    isRuntimeCurrent: () => valid,
    scheduleTimer(fn, ms) {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    cancelTimer(id) {
      timers.delete(id);
    },
  };
  const transport = createResidentAudioControlTransport(config);
  async function send(command, sequence, owner = "owner-a", url) {
    const result = await transport(
      JSON.stringify({
        token: TOKEN,
        owner,
        sequence,
        command,
        ...(url ? { url } : {}),
      }),
    );
    return { http: result.status, ...JSON.parse(result.body) };
  }
  return {
    calls,
    timers,
    media,
    baseRequire,
    config,
    transport,
    send,
    invalidate() {
      valid = false;
    },
    setSlot(value) {
      slot = value;
    },
    getSlot() {
      return slot;
    },
    current(value) {
      currentOverride = value;
    },
    intercept(value) {
      handler = value;
    },
    expire(ms) {
      const entry = [...timers.entries()].find(([, value]) => value.ms === ms);
      assert.ok(entry);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

function makeSession() {
  const e = setup();
  const exports = {
    "w/W2Hpjb": {
      sendRequest() {},
      abortRequest() {},
      addListener() {
        return { remove() {} };
      },
    },
    oFysat5F: {
      setTimeout: e.config.scheduleTimer,
      clearTimeout: e.config.cancelTimer,
    },
    Q9AKMtOM: {
      get() {
        return { GenerateSecureRandom: async () => "AAAAAAAAAAAAAAAAAAAAAA==" };
      },
    },
    ZUfSJvzB: { toByteArray: () => Array(16).fill(0) },
    "3MUht1S/": {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
  };
  for (const [id, v] of Object.entries(exports)) {
    e.baseRequire.m[id] = function () {};
    e.baseRequire.c[id] = { i: id, l: true, exports: v };
  }
  const session = createShellUiBaseLocalSession({
    ...e.config,
    audioConfig: { token: TOKEN },
  });
  return { e, session, audio: session.bindings().audio };
}

test("session disposal sends Stop before invalidating native runtime", async () => {
  const { e, session, audio } = makeSession();
  await audio.play(
    async () => URI,
    () => true,
  );
  const stopped = session.dispose();
  assert.equal(session.status().disposed, false);
  assert.throws(() => session.bindings());
  assert.equal(session.dispose(), stopped);
  await stopped;
  assert.equal(
    e.calls.filter(
      (c) => c.method === "command" && c.options.command === "stop",
    ).length,
    1,
  );
  assert.equal(e.getSlot(), null);
  assert.equal(session.status().disposed, true);
  assert.equal(session.status().playback.stopConfirmed, true);
});
test("idle disposal remains synchronous for guarded replacement", async () => {
  const { session } = makeSession();
  const stopped = session.dispose();
  assert.equal(session.status().disposed, true);
  await stopped;
});
test("failed Stop preserves runtime for retry and rejects new session operations", async () => {
  const { e, session, audio } = makeSession();
  await audio.play(
    async () => URI,
    () => true,
  );
  e.intercept((method, options) =>
    method === "command" && options.command === "stop"
      ? Promise.reject(new Error("fixture"))
      : undefined,
  );
  await assert.rejects(session.dispose());
  assert.equal(session.status().disposed, false);
  assert.equal(session.status().playback.stopConfirmed, false);
  assert.throws(() => session.bindings());
  e.intercept(undefined);
  await session.dispose();
  assert.equal(e.getSlot(), null);
  assert.equal(session.status().disposed, true);
});
test("disposal retains runtime identity guards", async () => {
  const { e, session, audio } = makeSession();
  await audio.play(
    async () => URI,
    () => true,
  );
  e.invalidate();
  await assert.rejects(session.dispose());
  assert.equal(e.calls.filter((c) => c.method === "command").length, 0);
  assert.equal(session.status().disposed, false);
});

function makeController() {
  const { e } = makeSession();
  const saved = new Map();
  for (const key of [
    "base_dll",
    "application",
    "webpackChunkapplication",
    "HermesInternal",
    "__navidromeLocalMusicStatus",
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const locations = new Map();
  function pin(fn, offset, file = "base") {
    locations.set(fn, {
      isNative: false,
      segmentID: 0,
      virtualOffset: offset,
      fileName: file,
    });
    return fn;
  }
  class Component {
    constructor(props) {
      this.props = props;
    }
    setState(patch) {
      this.state = { ...this.state, ...patch };
    }
  }
  function jsx(type, props, key) {
    return { type, props, key };
  }
  const exported = { jsx: pin(jsx, 444175), jsxs: jsx };
  const modules = {
    "ogN/Sdtl": {
      Component,
      createElement: (type, props) => ({ type, props }),
    },
    DkKR87qr: exported,
    oEJgnyX8: exported,
  };
  for (const id of [
    "KHrppdvq",
    "goS0m6II",
    "lmmSrzlb",
    "asrd/hDd",
    "DNUs8Rda",
    "3yWchaHU",
  ])
    modules[id] = function Primitive() {};
  modules.gWzUSBF9 = { default: function Focus() {} };
  modules["MESJr5x+"] = { default: function Font() {} };
  for (const [id, exports] of Object.entries(modules)) {
    e.baseRequire.m[id] = function factory() {};
    e.baseRequire.c[id] = { i: id, l: true, exports };
  }
  pin(e.baseRequire.m.DkKR87qr, 88878);
  pin(e.baseRequire.m.oEJgnyX8, 444035);
  function chunk(a, b) {}
  const locate = (fn) =>
    fn === locate ? { isNative: true } : locations.get(fn);
  Object.assign(globalThis, {
    base_dll: pin(e.baseRequire, 4833),
    application: {},
    webpackChunkapplication: pin(chunk, 46403, "cc"),
    HermesInternal: { getFunctionLocation: locate },
  });
  const contextProof = {
    firmware: FIRMWARE,
    bundleSha256: CONTROL_CENTER_HBC_SHA256,
    baseDllSha256: BASE_DLL_SOURCE_SHA256,
    titleId: "NPXS40003",
    isolatedRealm: true,
    phase: "application-running",
    executorIdentity: "fixture",
  };
  const control = startDirectMusic({
    globalObject: globalThis,
    contextProof,
    audioConfig: { token: TOKEN },
  });
  assert.equal(
    control.status().phase,
    "installed",
    JSON.stringify(control.status()),
  );
  class SonyMusic {
    render() {}
  }
  pin(SonyMusic, 3170820, "cc");
  pin(SonyMusic.prototype.render, 3172469, "cc");
  const local = exported.jsx(SonyMusic, {
    connectionStatus: 1,
    layoutStatus: 1,
  });
  const rendered = local.type(local.props);
  const audio = rendered.props.children.props.audio;
  assert.ok(audio);
  return {
    e,
    control,
    audio,
    exported,
    rendered,
    pin,
    original: jsx,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}
test("controller drains Stop before removing the JSX hook and renderer", async () => {
  const f = makeController();
  try {
    await f.audio.play(
      async () => URI,
      () => true,
    );
    const disposal = f.control.dispose();
    assert.equal(f.control.status().phase, "stopping");
    assert.equal(f.control.status().driver.hook.active, true);
    assert.equal(f.control.dispose(), disposal);
    await disposal;
    const status = f.control.status();
    assert.equal(status.phase, "disposed");
    assert.equal(status.driver.renderer.phase, "disposed");
    assert.equal(status.driver.renderer.session.disposed, true);
    assert.equal(status.driver.renderer.playback.stopConfirmed, true);
    assert.equal(status.driver.hook.removed, true);
    assert.equal(f.exported.jsx, f.original);
    assert.equal(f.e.getSlot(), null);
  } finally {
    f.restore();
  }
});
test("idle controller teardown returns a synchronous disposed snapshot", async () => {
  const f = makeController();
  try {
    assert.equal(f.control.dispose().phase, "disposed");
  } finally {
    f.restore();
  }
});

test("controller retains hook on Stop rejection and permits a safe retry", async () => {
  const f = makeController();
  try {
    await f.audio.play(
      async () => URI,
      () => true,
    );
    f.e.intercept((method, options) =>
      method === "command" && options.command === "stop"
        ? Promise.reject(new Error("fixture"))
        : undefined,
    );
    await assert.rejects(f.control.dispose());
    assert.equal(f.control.status().driver.hook.active, true);
    assert.equal(f.control.status().driver.renderer.session.disposed, false);
    f.e.intercept(undefined);
    await f.control.dispose();
    assert.equal(f.control.status().phase, "disposed");
    assert.equal(f.control.status().driver.hook.removed, true);
    assert.equal(f.e.getSlot(), null);
  } finally {
    f.restore();
  }
});
test("descendant UI failure also drains audio before rollback", async () => {
  const f = makeController();
  try {
    await f.audio.play(
      async () => URI,
      () => true,
    );
    const boundary = new f.rendered.type(f.rendered.props);
    boundary.componentDidCatch();
    await tick();
    const status = f.control.status();
    assert.equal(status.phase, "failed");
    assert.equal(status.driver.hook.removed, true);
    assert.equal(status.driver.renderer.session.disposed, true);
    assert.equal(status.driver.renderer.playback.stopConfirmed, true);
    assert.equal(f.e.getSlot(), null);
  } finally {
    f.restore();
  }
});

test("verified power menu waits for player disposal before forwarding reboot", async () => {
  const f = makeController();
  try {
    await f.audio.play(
      async () => URI,
      () => true,
    );
    const calls = [];
    function suspend() {
      calls.push("suspend");
    }
    function shutdown() {
      calls.push("shutdown");
    }
    function reboot() {
      assert.equal(f.e.getSlot(), null);
      assert.equal(f.control.status().phase, "disposed");
      calls.push("reboot");
    }
    const listItems = [
      { id: "suspend", onPress: f.pin(suspend, 0x3dde85, "cc") },
      { id: "shutdown", onPress: f.pin(shutdown, 0x3dded3, "cc") },
      { id: "reboot", onPress: f.pin(reboot, 0x3ddf21, "cc") },
    ];
    const rendered = f.exported.jsx(function FunctionControl() {}, {
      listItems,
    });
    assert.notEqual(rendered.props.listItems, listItems);
    assert.equal(f.control.status().driver.hook.power.menus, 1);
    rendered.props.listItems[2].onPress();
    assert.deepEqual(calls, []);
    await tick();
    assert.deepEqual(calls, ["reboot"]);
    assert.equal(f.control.status().driver.hook.power.drain, "confirmed");
    assert.equal(f.control.status().driver.hook.removed, true);
  } finally {
    f.restore();
  }
});
