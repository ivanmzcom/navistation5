// A namespaced entry in the console's per-user AsyncStorage. Never store passwords.
const KEY = "navistation5.authentication.v1";
function failure() {
  const error = new Error("Saved login unavailable");
  error.code = "NDLOGIN_STORAGE";
  return error;
}
function valid(value) {
  return (
    value &&
    value.schema === 1 &&
    typeof value.serverUrl === "string" &&
    /^https?:\/\/[^/@?#\s]+\/?$/.test(value.serverUrl) &&
    value.serverUrl.length <= 2048 &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    value.username.length <= 1024 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{32}$/.test(value.token) &&
    typeof value.salt === "string" &&
    /^[a-f0-9]{32}$/.test(value.salt) &&
    Object.keys(value).sort().join(",") ===
      "salt,schema,serverUrl,token,username"
  );
}
export function createCredentialStore({ storage, isRuntimeCurrent } = {}) {
  const get = storage?.getItem,
    set = storage?.setItem,
    remove = storage?.removeItem;
  if (
    ![get, set, remove, isRuntimeCurrent].every(
      (fn) => typeof fn === "function",
    )
  )
    throw failure();
  let queue = Promise.resolve();
  function check() {
    if (
      !isRuntimeCurrent() ||
      storage.getItem !== get ||
      storage.setItem !== set ||
      storage.removeItem !== remove
    )
      throw failure();
  }
  function run(operation) {
    const pending = queue.then(async () => {
      try {
        check();
        const result = await operation();
        check();
        return result;
      } catch {
        throw failure();
      }
    });
    queue = pending.catch(() => undefined);
    return pending;
  }
  return Object.freeze({
    load: () =>
      run(async () => {
        const text = await Reflect.apply(get, storage, [KEY]);
        if (text === null) return undefined;
        if (typeof text !== "string" || text.length > 4096) throw failure();
        const value = JSON.parse(text);
        if (!valid(value)) throw failure();
        return value;
      }),
    save: (value) => {
      const record = {
        schema: 1,
        serverUrl: value?.serverUrl,
        username: value?.username,
        token: value?.token,
        salt: value?.salt,
      };
      if (!valid(record)) return Promise.reject(failure());
      const text = JSON.stringify(record);
      if (text.length > 4096) return Promise.reject(failure());
      return run(() => Reflect.apply(set, storage, [KEY, text]));
    },
    forget: () => run(() => Reflect.apply(remove, storage, [KEY])),
  });
}
