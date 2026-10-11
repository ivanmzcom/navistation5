import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackNotifications } from "./playback-notifications.mjs";

test("native song notices use object payloads and display metadata without stream or artwork URLs", async () => {
  const calls = [];
  let valid = true;
  const notification = {
    async Send(value) {
      calls.push(value);
    },
  };
  const baseRequire = {
    c: {
      bX5JscBE: { l: true, exports: { VshNMNotificationModule: notification } },
    },
  };
  const notify = createPlaybackNotifications({
    baseRequire,
    isRuntimeCurrent: () => valid,
  });
  assert.equal(calls.length, 0);
  await notify({
    name: 'Song "one"',
    artist: "Artist",
    uri: "private-id",
    image_url: "http://private/art",
    stream: "http://private/stream",
  });
  assert.equal(calls[0].userId, 254);
  assert.equal(typeof calls[0].payload, "object");
  const view = calls[0].payload.rawData.viewData;
  assert.equal(view.message.body, 'Song "one"');
  assert.equal(view.subMessage.body, "Artist");
  assert.deepEqual(view.actions, []);
  assert.equal(calls[0].payload.rawData.soundEffect, "none");
  assert.equal(JSON.stringify(calls).includes("private"), false);
  valid = false;
  await notify({ name: "Other" });
  assert.equal(calls.length, 1);
  valid = true;
  notification.Send = async () => {
    throw new Error("changed binding invoked");
  };
  await notify({ name: "Other" });
  assert.equal(calls.length, 1);
});
