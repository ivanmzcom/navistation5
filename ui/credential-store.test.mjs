import test from "node:test";
import assert from "node:assert/strict";
import { createCredentialStore } from "./credential-store.mjs";
import { createOpenSubsonicClient } from "./opensubsonic-client.mjs";
import { md5Utf8 } from "./md5-utf8.mjs";
const record = {
  serverUrl: "http://navidrome.local:4533",
  username: "listener",
  token: "a".repeat(32),
  salt: "b".repeat(32),
};
function fixture() {
  const values = new Map();
  let current = true;
  const storage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
  };
  return {
    storage,
    values,
    store: createCredentialStore({ storage, isRuntimeCurrent: () => current }),
    change: () => {
      current = false;
    },
  };
}
test("saved authentication survives a new store and disconnect removes only its own key", async () => {
  const f = fixture();
  f.values.set("other-app-key", "leave");
  await f.store.save({ ...record, password: "never-save" });
  const fresh = createCredentialStore({
    storage: f.storage,
    isRuntimeCurrent: () => true,
  });
  assert.deepEqual(await fresh.load(), { schema: 1, ...record });
  assert(![...f.values.values()].some((v) => v.includes("never-save")));
  await fresh.forget();
  assert.equal(await fresh.load(), undefined);
  assert.equal(f.values.get("other-app-key"), "leave");
});
test("queued disconnect wins over an in-flight save", async () => {
  const f = fixture();
  let release;
  f.storage.setItem = async (key, value) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    f.values.set(key, value);
  };
  const store = createCredentialStore({
    storage: f.storage,
    isRuntimeCurrent: () => true,
  });
  const save = store.save(record);
  await Promise.resolve();
  await Promise.resolve();
  const forget = store.forget();
  release();
  await Promise.all([save, forget]);
  assert.equal(await store.load(), undefined);
});
test("malformed records and native errors never reveal credentials", async () => {
  const f = fixture();
  await f.store.save(record);
  const key = [...f.values.keys()][0];
  for (const value of [
    { schema: 1, ...record, password: "secret" },
    { schema: 1, ...record, token: "bad" },
    { schema: 1, ...record, serverUrl: "https://user:secret@example.com" },
  ]) {
    f.values.set(key, JSON.stringify(value));
    await assert.rejects(
      f.store.load(),
      (e) => e.code === "NDLOGIN_STORAGE" && !e.message.includes("secret"),
    );
  }
  f.storage.getItem = async () => {
    throw new Error("secret");
  };
  await assert.rejects(f.store.load(), { code: "NDLOGIN_STORAGE" });
  f.change();
  await assert.rejects(f.store.forget(), { code: "NDLOGIN_STORAGE" });
});
test("saved token authenticates a fresh client without the original password", async () => {
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    return {
      status: 200,
      body: JSON.stringify({
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          openSubsonicExtensions: [],
        },
      }),
    };
  };
  const create = () =>
    createOpenSubsonicClient({
      serverUrl: record.serverUrl,
      allowHttp: true,
      transport,
      randomBytes: () => Array(16).fill(7),
      md5Utf8,
    });
  const first = create();
  await first.login({
    username: record.username,
    password: "original-password",
  });
  const auth = await first.savedAuthentication();
  first.logout();
  const restored = create();
  await restored.login(auth);
  assert.equal(restored.state, "connected");
  const url = new URL(requests.at(-1).url);
  assert.equal(url.searchParams.get("t"), auth.token);
  assert.equal(url.searchParams.get("s"), auth.salt);
  assert(!JSON.stringify(auth).includes("original-password"));
  restored.logout();
  await assert.rejects(restored.savedAuthentication());
  await assert.rejects(restored.login({ ...auth, password: "mixed" }));
});
