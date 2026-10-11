import { FIRMWARE, BASE_DLL_HBC_SHA256 } from "./firmware-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createResidentAudioControlTransport } from "./resident-audio-control-transport.mjs";
import { createAudioPlayer } from "./audio-player.mjs";

const TOKEN = "a".repeat(64),
  URI = "http://navidrome.local:4533/rest/stream.view?id=test&t=private";
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
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
const mutations = (e) => e.calls.filter((value) => value.method !== "query");
async function start(e) {
  assert.equal((await e.send("claim", 1)).ok, true);
  const response = await e.send("play", 2, "owner-a", URI);
  assert.equal(response.http, 202);
  assert.equal(response.accepted, true);
  return response;
}

test("construction is passive, validates string constants, and pins exact cached bindings", async () => {
  const e = setup();
  assert.equal(e.calls.length, 0);
  e.baseRequire.c = { ...e.baseRequire.c };
  const changed = await e.send("claim", 1);
  assert.equal(changed.code, "ND_AUDIO_TRANSPORT_CHANGED");
  assert.equal(e.calls.length, 0);
  const f = setup();
  f.media.PlayerCommands.pauseCommand = 0;
  assert.throws(() => createResidentAudioControlTransport(f.config), {
    code: "ND_AUDIO_TRANSPORT_SHAPE",
  });
});

test("authentication and malformed requests cannot reveal ownership or invoke native APIs", async () => {
  const e = setup();
  const result = await e.transport(
    JSON.stringify({
      token: "b".repeat(64),
      command: "status",
      owner: "x",
      sequence: 1,
    }),
  );
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).status, undefined);
  assert.equal(
    (await e.send("play", 1, "owner-a", "http://other.invalid/stream")).http,
    400,
  );
  assert.equal(e.calls.length, 0);
});

test("normal playback accepts empty URI, absent errorState, numeric boolean and fractional milliseconds", async () => {
  const e = setup();
  await start(e);
  const submitted = e.calls.find((value) => value.method === "play").options;
  assert.deepEqual(submitted, {
    serviceType: 20,
    coreName: "SystemMusicCore",
    titleId: "PPSA99985",
    uri: URI,
    offsetUri: "",
    offset: 0,
    playbackSource: 1,
    username: "",
    token: "",
  });
  const observed = await e.send("status", 3);
  assert.equal(observed.status.phase, "playing");
  assert.equal(observed.status.currentTime, 1.2505);
  assert.equal(observed.status.duration, 90.001);
  assert.equal(observed.status.playbackSampleFresh, true);
  assert.equal(observed.status.audioBackend, "resident-mediafw");
  assert.equal(observed.status.audibilityVerified, false);
  const serialized = JSON.stringify(observed);
  for (const secret of [TOKEN, URI, "srcId", "srcUri"])
    assert.equal(serialized.includes(secret), false);
});

test("pause, resume and stop double-check own source and send actual string constants", async () => {
  const e = setup();
  await start(e);
  assert.equal((await e.send("pause", 3)).status.phase, "paused");
  assert.equal((await e.send("status", 4)).status.phase, "paused");
  assert.equal((await e.send("resume", 5)).accepted, true);
  assert.equal((await e.send("status", 6)).status.phase, "playing");
  const stopped = await e.send("stop", 7);
  assert.equal(stopped.status.phase, "idle");
  assert.equal(stopped.status.closeConfirmed, true);
  assert.deepEqual(
    e.calls.filter((v) => v.method === "command").map((v) => v.options.command),
    ["pause", "play", "stop"],
  );
  for (let i = 0; i < e.calls.length; i++)
    if (e.calls[i].method === "command") {
      assert.equal(e.calls[i - 1].method, "query");
      assert.deepEqual(e.calls[i - 1].options, {});
      assert.equal(e.calls[i - 2].method, "query");
      assert.deepEqual(e.calls[i - 2].options, { serviceType: 20 });
      assert.equal(e.calls[i].options.srcId, 41);
    }
});

test("CURRENT service10 alias is accepted only for our exact source; explicit slot remains service20", async () => {
  const e = setup();
  e.intercept((kind, options) =>
    kind === "query" && options.serviceType === undefined && e.getSlot()
      ? Promise.resolve({ ...e.getSlot(), serviceType: 10 })
      : undefined,
  );
  await start(e);
  assert.equal((await e.send("status", 3)).status.phase, "playing");
  assert.equal((await e.send("pause", 4)).ok, true);
  assert.equal((await e.send("resume", 5)).ok, true);
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = e.getSlot().durationMs;
  assert.equal((await e.send("status", 6)).status.phase, "idle");
  assert.equal((await e.send("play", 7, "owner-a", URI)).ok, true);
  e.intercept((kind, options) =>
    kind === "query" && options.serviceType === undefined
      ? Promise.resolve({ ...e.getSlot(), serviceType: 10, srcId: 999 })
      : undefined,
  );
  assert.equal((await e.send("stop", 8)).code, "ND_AUDIO_SOURCE_OWNERSHIP");
  e.intercept(undefined);
  e.getSlot().serviceType = 10;
  assert.equal((await e.send("pause", 9)).code, "ND_AUDIO_SOURCE_OWNERSHIP");
});

test("delayed Stop acknowledgement state is polled before next Play without repeating Stop", async () => {
  const e = setup();
  await start(e);
  let stopSent = false,
    reads = 0;
  e.intercept((kind, options) => {
    if (kind === "command" && options.command === "stop") {
      stopSent = true;
      return Promise.resolve({ result: 0 });
    }
    if (
      kind === "query" &&
      options.serviceType === 20 &&
      stopSent &&
      ++reads === 3
    )
      e.getSlot().isPlaying = 0;
  });
  const pending = e.send("play", 3, "owner-a", URI);
  await tick();
  assert.equal(mutations(e).filter((v) => v.method === "play").length, 1);
  e.expire(100);
  await tick();
  e.expire(100);
  assert.equal((await pending).accepted, true);
  assert.equal(mutations(e).filter((v) => v.method === "command").length, 1);
  assert.equal(mutations(e).filter((v) => v.method === "play").length, 2);
});

test("Stop polling has a finite budget; later own acknowledged stop can recover through status", async () => {
  const e = setup();
  await start(e);
  e.intercept((kind) =>
    kind === "command" ? Promise.resolve({ result: 0 }) : undefined,
  );
  const pending = e.send("stop", 3);
  await tick();
  for (let i = 0; i < 5; i++) {
    e.expire(100);
    await tick();
  }
  const expired = await pending;
  assert.equal(expired.code, "ND_AUDIO_CLOSE_UNCONFIRMED");
  assert.equal(expired.status.closeConfirmed, false);
  assert.equal(expired.status.phase, "stopping");
  assert.equal(e.timers.size, 0);
  e.getSlot().isPlaying = false;
  const recovered = await e.send("status", 4);
  assert.equal(recovered.status.phase, "idle");
  assert.equal(recovered.status.closeConfirmed, true);
  assert.equal((await e.send("stop", 5)).status.closeConfirmed, true);
  assert.equal(mutations(e).filter((v) => v.method === "command").length, 1);
});

test("failed Stop cannot turn a later external pause into a confirmed close", async () => {
  const e = setup();
  await start(e);
  e.intercept((kind) =>
    kind === "command" ? Promise.resolve({ result: -1 }) : undefined,
  );
  assert.equal((await e.send("stop", 3)).code, "ND_AUDIO_NATIVE_RESULT");
  e.getSlot().isPlaying = 0;
  const observed = await e.send("status", 4);
  assert.equal(observed.status.phase, "stopping");
  assert.equal(observed.status.closeConfirmed, false);
});

test("Stop confirmation rejects a foreign source and bounds a missing query reply", async () => {
  for (const missing of [false, true]) {
    const e = setup();
    await start(e);
    let sent = false;
    e.intercept((kind, options) => {
      if (kind === "command") {
        sent = true;
        return Promise.resolve({ result: 0 });
      }
      if (kind === "query" && options.serviceType === 20 && sent)
        return missing
          ? new Promise(() => {})
          : Promise.resolve({ ...e.getSlot(), srcId: 999, isPlaying: 0 });
    });
    const pending = e.send("play", 3, "owner-a", URI);
    await tick();
    if (missing) e.expire(750);
    assert.equal(
      (await pending).code,
      missing ? "ND_AUDIO_CONTROL_TIMEOUT" : "ND_AUDIO_SOURCE_OWNERSHIP",
    );
    assert.equal(mutations(e).filter((v) => v.method === "play").length, 1);
    assert.equal(mutations(e).filter((v) => v.method === "command").length, 1);
  }
});

test("fresh engine never adopts even a stopped source in service20", async () => {
  for (const playing of [0, 1, false, true]) {
    const e = setup();
    e.setSlot({
      result: 0,
      serviceType: 20,
      srcId: 6,
      isPlaying: playing,
      srcUri: "",
    });
    const denied = await e.send("claim", 1);
    assert.equal(denied.code, "ND_AUDIO_SOURCE_OWNERSHIP");
    assert.equal(denied.status.owner, "");
    assert.equal(denied.status.lastSequence, 0);
    assert.equal(mutations(e).length, 0);
  }
});

test("post-removal successful service20 sentinel is empty only with the exact empty playback fields", async () => {
  const empty = {
    result: 0,
    srcId: -1000,
    serviceType: 20,
    isPlaying: 0,
    srcUri: "",
    contextUri: "",
    progressMs: 0,
    durationMs: 0,
  };
  for (const extra of [{}, { errorState: 0, isPlaying: false }]) {
    const e = setup();
    e.setSlot({ ...empty, ...extra });
    e.current({ result: -1000, errorState: 0 });
    assert.equal((await e.send("claim", 1)).ok, true);
    assert.equal((await e.send("status", 2)).status.closeConfirmed, true);
    assert.equal(mutations(e).length, 0);
    assert.equal((await e.send("play", 3, "owner-a", URI)).accepted, true);
    assert.equal(mutations(e).length, 1);
  }
  for (const changed of [
    { srcId: -2 },
    { serviceType: 10 },
    { isPlaying: 1 },
    { progressMs: 1 },
    { durationMs: 1 },
    { srcUri: URI },
    { contextUri: URI },
    { srcUri: undefined },
    { contextUri: undefined },
    { errorState: 1 },
  ]) {
    const e = setup();
    e.setSlot({ ...empty, ...changed });
    e.current({ result: -1000, errorState: 0 });
    assert.equal((await e.send("claim", 1)).ok, false);
    assert.equal(mutations(e).length, 0);
  }
  const f = setup();
  f.setSlot(empty);
  f.current(empty);
  assert.equal((await f.send("claim", 1)).ok, false);
  assert.equal(mutations(f).length, 0);
});

test("foreign CURRENT, changed URI and changed source prevent every playback mutation", async () => {
  for (const change of [
    (e) => e.current({ result: 0, serviceType: 1, srcId: 90, isPlaying: 1 }),
    (e) => {
      e.getSlot().srcUri = "http://other.invalid/";
    },
    (e) => {
      e.getSlot().srcId = 90;
    },
  ]) {
    const e = setup();
    await start(e);
    change(e);
    assert.equal((await e.send("pause", 3)).code, "ND_AUDIO_SOURCE_OWNERSHIP");
    assert.equal((await e.send("stop", 4)).code, "ND_AUDIO_SOURCE_OWNERSHIP");
    assert.equal(mutations(e).length, 1);
  }
});

test("claim transfer cleans own source and resets sequence only after confirmed success", async () => {
  const e = setup();
  await start(e);
  assert.equal((await e.send("status", 100)).ok, true);
  const next = await e.send("claim", 1, "owner-b");
  assert.equal(next.ok, true);
  assert.equal(next.status.owner, "owner-b");
  assert.equal(next.status.lastSequence, 1);
  assert.equal(next.status.closeConfirmed, true);
  assert.equal((await e.send("status", 101, "owner-a")).code, "ND_OWNER");
  assert.equal((await e.send("status", 1, "owner-b")).code, "ND_SEQUENCE");
  assert.equal((await e.send("play", 2, "owner-b", URI)).ok, true);
  assert.equal(
    mutations(e).filter((value) => value.method === "play").length,
    2,
  );
  const f = setup();
  await start(f);
  f.current({ result: 0, serviceType: 1, srcId: 90, isPlaying: true });
  const denied = await f.send("claim", 1, "owner-b");
  assert.equal(denied.ok, false);
  assert.equal(denied.status.owner, "owner-a");
  assert.equal(denied.status.lastSequence, 2);
});

test("lost Play reply never retries or adopts a queried ID; only its late reply establishes ownership", async () => {
  const e = setup();
  await e.send("claim", 1);
  let finishPlay;
  e.intercept((kind) =>
    kind === "play"
      ? new Promise((resolve) => {
          finishPlay = resolve;
        })
      : undefined,
  );
  const pending = e.send("play", 2, "owner-a", URI);
  await tick();
  e.expire(5000);
  assert.equal((await pending).code, "ND_AUDIO_CONTROL_TIMEOUT");
  e.setSlot({
    result: 0,
    serviceType: 20,
    srcId: 77,
    isPlaying: 1,
    srcUri: URI,
    progressMs: 1000,
    durationMs: 5000,
  });
  assert.equal(
    (await e.send("play", 3, "owner-a", URI)).code,
    "ND_AUDIO_PLAY_UNCERTAIN",
  );
  assert.equal((await e.send("stop", 4)).code, "ND_AUDIO_PLAY_UNCERTAIN");
  assert.equal(mutations(e).length, 1);
  finishPlay({ result: 0, serviceType: 20, srcId: 77 });
  await tick();
  assert.equal((await e.send("status", 5)).status.phase, "playing");
  assert.equal((await e.send("stop", 6)).status.closeConfirmed, true);
  assert.equal(mutations(e).filter((v) => v.method === "play").length, 1);
});

test("bounded query deadline and concurrent rejection leave no queued native requests", async () => {
  const e = setup();
  e.intercept(() => new Promise(() => {}));
  const pending = e.send("claim", 1);
  await tick();
  const busy = await e.send("claim", 1, "owner-b");
  assert.equal(busy.code, "ND_AUDIO_BUSY");
  e.expire(3000);
  const result = await pending;
  assert.equal(result.code, "ND_AUDIO_CONTROL_TIMEOUT");
  assert.equal(result.status.hostReachable, false);
  assert.equal(result.status.owner, "");
  assert.equal(result.status.lastSequence, 0);
  assert.equal(e.calls.length, 1);
  assert.equal(e.timers.size, 0);
});

test("native rejection is sanitized and a changed runtime prevents late reply ownership", async () => {
  const e = setup();
  await e.send("claim", 1);
  e.intercept((kind) =>
    kind === "play" ? Promise.reject(new Error(URI + TOKEN)) : undefined,
  );
  const result = await e.send("play", 2, "owner-a", URI);
  assert.equal(result.code, "ND_AUDIO_NATIVE_REJECTED");
  assert.equal(JSON.stringify(result).includes(URI), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  const f = setup();
  await f.send("claim", 1);
  let finish;
  f.intercept((kind) =>
    kind === "play"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  const pending = f.send("play", 2, "owner-a", URI);
  await tick();
  f.invalidate();
  finish({ result: 0, serviceType: 20, srcId: 42 });
  assert.equal((await pending).code, "ND_AUDIO_TRANSPORT_CHANGED");
  assert.equal(mutations(f).length, 1);
});

test("existing createAudioPlayer uses the unchanged schema through a full control lifecycle", async () => {
  const e = setup();
  const player = createAudioPlayer({
    token: TOKEN,
    transport: e.transport,
    randomBytes: async () => new Uint8Array(16).fill(7),
    isRuntimeCurrent: () => true,
    scheduleTimer: e.config.scheduleTimer,
    cancelTimer: e.config.cancelTimer,
  });
  await player.play(
    async () => URI,
    () => true,
  );
  assert.equal((await player.refresh()).phase, "playing");
  assert.equal((await player.pause()).phase, "paused");
  await player.resume();
  assert.equal((await player.refresh()).phase, "playing");
  assert.equal((await player.stopPlayback()).stopConfirmed, true);
  await player.dispose();
});

test("a source that never starts times out and stops only its owned source without retrying Play", async () => {
  const e = setup();
  await start(e);
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = 0;
  e.getSlot().durationMs = 0;
  assert.equal((await e.send("status", 3)).status.phase, "opening");
  e.expire(30000);
  const result = await e.send("status", 4);
  assert.equal(result.code, "ND_AUDIO_START_TIMEOUT");
  assert.equal(result.status.phase, "error");
  assert.equal(result.status.closeConfirmed, true);
  assert.equal(mutations(e).filter((v) => v.method === "play").length, 1);
  assert.deepEqual(
    mutations(e)
      .filter((v) => v.method === "command")
      .map((v) => v.options),
    [{ command: "stop", srcId: 41, playbackSource: 1 }],
  );
  const retained = await e.send("status", 5);
  assert.equal(retained.status.phase, "error");
  assert.equal(retained.status.errorCode, "ND_AUDIO_START_TIMEOUT");
  assert.equal((await e.send("play", 6, "owner-a", URI)).accepted, true);
});

test("startup timeout does not stop a source selected by another player", async () => {
  const e = setup();
  await start(e);
  e.expire(30000);
  e.current({ ...e.getSlot(), srcId: 99, serviceType: 10 });
  assert.equal((await e.send("status", 3)).code, "ND_AUDIO_SOURCE_OWNERSHIP");
  assert.equal(mutations(e).filter((v) => v.method === "command").length, 0);
});

test("observed playback cancels the startup deadline", async () => {
  const e = setup();
  await start(e);
  assert.equal((await e.send("status", 3)).status.phase, "playing");
  assert.equal(
    [...e.timers.values()].some((v) => v.ms === 30000),
    false,
  );
});

test("Stop releases its source so a new renderer can claim after an update", async () => {
  const e = setup();
  await start(e);
  const oldId = e.getSlot().srcId;
  assert.equal((await e.send("stop", 3)).status.closeConfirmed, true);
  assert.equal(e.getSlot(), null);
  assert.deepEqual(
    e.calls.filter((v) => v.method === "remove").map((v) => v.options),
    [{ srcId: oldId }],
  );
  const replacement = createResidentAudioControlTransport(e.config);
  const result = await replacement(
    JSON.stringify({
      token: TOKEN,
      owner: "new-ui",
      sequence: 1,
      command: "claim",
    }),
  );
  assert.equal(JSON.parse(result.body).ok, true);
});

test("failed removal blocks cleanup and retries only the known stopped source", async () => {
  const e = setup();
  await start(e);
  e.intercept((kind) =>
    kind === "remove" ? Promise.resolve({ result: -1 }) : undefined,
  );
  const failed = await e.send("stop", 3);
  assert.equal(failed.code, "ND_AUDIO_NATIVE_RESULT");
  assert.equal(failed.status.closeConfirmed, false);
  assert.equal(e.getSlot().isPlaying, 0);
  e.intercept(undefined);
  assert.equal((await e.send("stop", 4)).status.closeConfirmed, true);
  assert.equal(e.getSlot(), null);
  assert.equal(e.calls.filter((v) => v.method === "command").length, 1);
});

test("album queue advances once at EOF without a mounted UI and ends after its final song", async () => {
  const e = setup();
  const resolved = [];
  const player = createAudioPlayer({
    token: TOKEN,
    transport: e.transport,
    randomBytes: async () => new Uint8Array(16).fill(7),
    isRuntimeCurrent: () => true,
    scheduleTimer: e.config.scheduleTimer,
    cancelTimer: e.config.cancelTimer,
  });
  await player.playCollection(
    [0, 1].map((index) => ({
      track: { uri: `song-${index}`, name: `Song ${index}` },
      resolveStream: async () => {
        resolved.push(index);
        return URI;
      },
    })),
    () => true,
    () => true,
  );
  e.expire(1000);
  await tick();
  assert.equal(player.status().phase, "playing");
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = e.getSlot().durationMs;
  e.expire(1000);
  await tick();
  await tick();
  assert.deepEqual(resolved, [0, 1]);
  assert.equal(player.status().currentTrack.uri, "song-1");
  assert.equal(JSON.stringify(player.status()).includes(URI), false);
  e.expire(1000);
  await tick();
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = e.getSlot().durationMs;
  e.expire(1000);
  await tick();
  assert.deepEqual(resolved, [0, 1]);
  assert.equal(player.status().phase, "idle");
  await player.dispose();
});
test("pause and explicit Stop never start the next album song", async () => {
  const e = setup();
  let resolved = 0;
  const player = createAudioPlayer({
    token: TOKEN,
    transport: e.transport,
    randomBytes: async () => new Uint8Array(16).fill(7),
    isRuntimeCurrent: () => true,
    scheduleTimer: e.config.scheduleTimer,
    cancelTimer: e.config.cancelTimer,
  });
  const entries = [0, 1].map((i) => ({
    track: { uri: `song-${i}` },
    resolveStream: async () => {
      resolved++;
      return URI;
    },
  }));
  await player.playCollection(
    entries,
    () => true,
    () => true,
  );
  await player.refresh();
  await player.pause();
  e.getSlot().progressMs = e.getSlot().durationMs;
  await player.refresh();
  await tick();
  assert.equal(resolved, 1);
  await player.stopPlayback();
  await tick();
  assert.equal(resolved, 1);
  assert.equal(player.status().currentTrack, undefined);
});

test("an expired session cannot resolve or start another queued song", async () => {
  const e = setup();
  let valid = true,
    resolved = 0;
  const player = createAudioPlayer({
    token: TOKEN,
    transport: e.transport,
    randomBytes: async () => new Uint8Array(16).fill(7),
    isRuntimeCurrent: () => true,
    scheduleTimer: e.config.scheduleTimer,
    cancelTimer: e.config.cancelTimer,
  });
  await player.playCollection(
    [0, 1].map((i) => ({
      track: { uri: `song-${i}` },
      resolveStream: async () => {
        resolved++;
        return URI;
      },
    })),
    () => true,
    () => valid,
  );
  await player.refresh();
  valid = false;
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = e.getSlot().durationMs;
  await player.refresh();
  await tick();
  assert.equal(resolved, 1);
  assert.equal(player.status().errorCode, "ND_AUDIO_CANCELLED");
  await player.dispose();
});

test("song notifications happen on confirmed Playing, once per start and never on resume", async () => {
  const e = setup();
  const notices = [];
  const player = createAudioPlayer({
    token: TOKEN,
    transport: e.transport,
    randomBytes: async () => new Uint8Array(16).fill(7),
    isRuntimeCurrent: () => true,
    scheduleTimer: e.config.scheduleTimer,
    cancelTimer: e.config.cancelTimer,
    onTrackStart: (track) => {
      notices.push(track.name);
    },
  });
  await player.play(
    async () => URI,
    () => true,
    { uri: "song-1", name: "First" },
  );
  assert.deepEqual(notices, []);
  e.expire(1000);
  await tick();
  assert.deepEqual(notices, ["First"]);
  await player.refresh();
  await player.pause();
  await player.resume();
  await player.refresh();
  assert.deepEqual(notices, ["First"]);
  await player.playCollection(
    [0, 1].map((i) => ({
      track: { uri: `song-${i}`, name: `Album ${i}` },
      resolveStream: async () => URI,
    })),
    () => true,
    () => true,
  );
  await player.refresh();
  e.getSlot().isPlaying = 0;
  e.getSlot().progressMs = e.getSlot().durationMs;
  await player.refresh();
  await tick();
  await player.refresh();
  assert.deepEqual(notices, ["First", "Album 0", "Album 1"]);
  await player.dispose();
});
