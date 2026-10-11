import test from "node:test";
import assert from "node:assert/strict";
import { createPowerMenuDrain } from "./power-menu-drain.mjs";

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup() {
  const calls = [],
    locations = new Map(),
    timers = new Map();
  let valid = true,
    resolve,
    reject,
    timer = 0;
  const stopped = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const listItems = ["suspend", "shutdown", "reboot"].map((id, index) => {
    function onPress(...args) {
      calls.push({ id, receiver: this, args });
    }
    locations.set(onPress, [0x3dde85, 0x3dded3, 0x3ddf21][index]);
    return Object.freeze({ id, onPress, label: id });
  });
  const drain = createPowerMenuDrain({
    matchesLocation: (fn, offset) => locations.get(fn) === offset,
    isRuntimeCurrent: () => valid,
    beforePower() {
      calls.push("drain");
      return stopped;
    },
    scheduleTimer(fn, ms) {
      timers.set(++timer, { fn, ms });
      return timer;
    },
    cancelTimer(id) {
      timers.delete(id);
    },
  });
  const props = Object.freeze({
    title: "Power",
    listItems: Object.freeze(listItems),
  });
  return {
    drain,
    props,
    calls,
    timers,
    resolve,
    reject,
    invalidate() {
      valid = false;
    },
  };
}
test("verified reboot waits for drain, keeps arguments and forwards once", async () => {
  const e = setup(),
    props = e.drain.decorate(e.props),
    receiver = {};
  const handler = props.listItems[2].onPress;
  assert.notEqual(props, e.props);
  assert.equal(props.listItems[0], e.props.listItems[0]);
  assert.equal(handler.call(receiver, "fixture"), undefined);
  handler();
  assert.deepEqual(e.calls, ["drain"]);
  assert.equal(e.drain.status().pending, true);
  e.resolve();
  await tick();
  assert.deepEqual(e.calls[1], { id: "reboot", receiver, args: ["fixture"] });
  assert.equal(e.calls.length, 2);
  assert.equal(e.timers.size, 0);
  assert.equal(e.drain.status().drain, "confirmed");
});
test("rejected or stalled drain never traps a normal shutdown", async () => {
  for (const timeout of [false, true]) {
    const e = setup(),
      handler = e.drain.decorate(e.props).listItems[1].onPress;
    handler();
    if (timeout) {
      [...e.timers.values()][0].fn();
      e.resolve();
    } else e.reject(new Error("fixture"));
    await tick();
    assert.equal(e.calls.filter((call) => call.id === "shutdown").length, 1);
    assert.equal(e.drain.status().drain, timeout ? "timeout" : "failed");
  }
});
test("foreign callbacks and unrelated JSX props remain untouched", () => {
  const e = setup();
  assert.equal(
    e.drain.decorate({ onPress() {} }).onPress instanceof Function,
    true,
  );
  const items = [...e.props.listItems];
  items[2] = { id: "reboot", onPress() {} };
  const props = { listItems: items };
  assert.equal(e.drain.decorate(props), props);
  assert.deepEqual(e.calls, []);
});
test("a retired runtime forwards the Sony action without issuing Stop", () => {
  const e = setup(),
    handler = e.drain.decorate(e.props).listItems[2].onPress;
  e.invalidate();
  handler();
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].id, "reboot");
});
test("accessor props are rejected without invoking their getters", () => {
  const e = setup();
  const props = {
    get listItems() {
      throw new Error("Getter must not run");
    },
  };
  assert.equal(e.drain.decorate(props), props);
});
