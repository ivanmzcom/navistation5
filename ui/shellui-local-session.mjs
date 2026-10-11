/**
 * Local RNPS/OpenSubsonic session. Construct only in the normal local UI turn.
 * Creation may initialize the three exact runtime modules listed below; it
 * sends no HTTP request and does not generate random bytes until login.
 */
import { DEFAULT_SERVER_URL, allowsLocalHttp } from "./navidrome-catalog.mjs";
import { createLocalNavidromeLibrary } from "./navidrome-library.mjs";
import { createOpenSubsonicClient } from "./opensubsonic-client.mjs";
import { createRNPSNetworkingTransport, BASE_DLL_HBC_SHA256 } from "./rnps-networking-transport.mjs";
import { createCCRandomBytes } from "./shellui-runtime-bindings.mjs";
import { md5Utf8 } from "./md5-utf8.mjs";
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

function own(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function runtimeModule(loader, id) {
  const factories = own(loader, "m"), cache = own(loader, "c");
  if (typeof loader !== "function" || !cache || typeof own(factories, String(id)) !== "function") {
    throw new Error("The required runtime factory is unavailable");
  }
  let record = own(cache, String(id)), returned;
  if (record === undefined) {
    returned = Reflect.apply(loader, undefined, [id]);
    record = own(cache, String(id));
  }
  if (!record || own(record, "i") !== id || own(record, "l") !== true ||
      own(record, "exports") === undefined ||
      (returned !== undefined && returned !== own(record, "exports"))) {
    throw new Error("A required runtime module did not complete initialization");
  }
  return own(record, "exports");
}

/**
 * The caller validates the real realm and passes its captured requires/hashes.
 * Allowed lazy targets: CC 1406 (Random), base w/W2Hpjb (RCTNetworking),
 * base oFysat5F (JSTimers). Their normal dependencies initialize as usual.
 * Login is the only entry that sends requests. No PSN/provider service type.
 * Established sessions survive closing Music; dispose clears owned sessions.
 */
export function createShellUiLocalSession({ require, baseRequire, firmware,
  bundleSha256, baseBundleSha256, serverUrl = DEFAULT_SERVER_URL,
  timeoutMs = 30000, isRuntimeCurrent } = {}) {
  if (firmware !== 0x13200006 || bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
      baseBundleSha256 !== BASE_DLL_HBC_SHA256 || typeof isRuntimeCurrent !== "function" ||
      !isRuntimeCurrent() || typeof Reflect !== "object" || typeof Reflect.apply !== "function") {
    throw new Error("A verified active CC runtime is required for the local session");
  }
  const ccFactories = own(require, "m"), ccCache = own(require, "c");
  const baseFactories = own(baseRequire, "m"), baseCache = own(baseRequire, "c");
  const randomFactory = own(ccFactories, "1406");
  const networkingFactory = own(baseFactories, "w/W2Hpjb");
  const timerFactory = own(baseFactories, "oFysat5F");
  function currentRuntime() {
    return isRuntimeCurrent() && own(require, "m") === ccFactories && own(require, "c") === ccCache &&
      own(baseRequire, "m") === baseFactories && own(baseRequire, "c") === baseCache &&
      own(ccFactories, "1406") === randomFactory &&
      own(baseFactories, "w/W2Hpjb") === networkingFactory && own(baseFactories, "oFysat5F") === timerFactory;
  }
  runtimeModule(require, 1406);
  const networking = runtimeModule(baseRequire, "w/W2Hpjb");
  const timers = runtimeModule(baseRequire, "oFysat5F");
  const setTimer = own(timers, "setTimeout"), clearTimer = own(timers, "clearTimeout");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function" || !currentRuntime()) {
    throw new Error("The real RNPS timer bindings are unavailable");
  }
  const randomBytes = createCCRandomBytes({ require, firmware, bundleSha256 });
  let disposed = false, serial = 0, active, pending;

  function makeConnection(url) {
    if (disposed || !currentRuntime()) throw new Error("The local runtime is unavailable");
    const allowHttp = allowsLocalHttp(url);
    const transport = createRNPSNetworkingTransport({ baseRequire, firmware,
      baseBundleSha256, serverUrl: url, allowHttp,
      scheduleTimer: (fn, ms) => Reflect.apply(setTimer, timers, [fn, ms]),
      cancelTimer: id => Reflect.apply(clearTimer, timers, [id]),
    });
    let loginCurrent;
    function assertLive() {
      if (disposed || !currentRuntime() || own(own(baseCache, "w/W2Hpjb"), "exports") !== networking ||
          (loginCurrent && !loginCurrent())) {
        transport.abortAll();
        throw new Error("The local Navidrome session is no longer current");
      }
    }
    const raw = createOpenSubsonicClient({ serverUrl: url, timeoutMs, allowHttp,
      redirectPolicy: "match-native-response-target", md5Utf8,
      randomBytes: async length => {
        assertLive(); const result = await randomBytes(length); assertLive(); return result;
      },
      transport: async request => {
        assertLive(); const response = await transport(request); assertLive(); return response;
      },
    });
    // Preserve the client's live getters and methods. Logout adds cancellation
    // for this connection's requests only; no shared native requests are touched.
    const client = Object.create(raw);
    Object.defineProperty(client, "logout", { enumerable: true, value() {
      loginCurrent = undefined;
      raw.logout();
      transport.abortAll();
    } });
    Object.freeze(client);
    const library = createLocalNavidromeLibrary({ client });
    return { client, library, transport,
      setLoginCurrent: check => { loginCurrent = check; },
      clearLoginCurrent: () => { loginCurrent = undefined; },
    };
  }
  active = makeConnection(serverUrl);

  async function onLogin({ serverUrl: requestedUrl, username, password, isCurrent } = {}) {
    if (typeof isCurrent !== "function" || !isCurrent() || disposed) {
      throw new Error("The local login view is unavailable");
    }
    const attempt = ++serial;
    pending?.client.logout();
    active?.client.logout();
    let connection;
    const credentials = { username, password };
    password = undefined;
    try {
      connection = makeConnection(requestedUrl);
      pending = connection;
      connection.setLoginCurrent(() => !disposed && serial === attempt && isCurrent());
      await connection.client.login(credentials);
      if (disposed || serial !== attempt || !isCurrent()) throw new Error("The local login was cancelled");
      connection.clearLoginCurrent();
      active = connection;
      return { client: connection.client, library: connection.library };
    } catch {
      connection?.client.logout();
      throw new Error("Navidrome connection failed");
    } finally {
      credentials.username = credentials.password = "";
      if (pending === connection) pending = undefined;
    }
  }

  return Object.freeze({
    bindings() {
      if (disposed) throw new Error("The local session is disposed");
      return { client: active.client, library: active.library, onLogin };
    },
    status: () => ({ disposed, state: active?.client.state,
      redirectPolicy: "match-native-response-target", ownsSession: true }),
    dispose() {
      if (disposed) return;
      disposed = true; serial++;
      pending?.client.logout(); active?.client.logout();
      pending = active = undefined;
    },
  });
}
