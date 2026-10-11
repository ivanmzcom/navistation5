import { FIRMWARE, BASE_DLL_HBC_SHA256 } from "./firmware-profile.mjs";
// Owns the Navidrome login and resident player across card remounts.
import { DEFAULT_SERVER_URL, allowsLocalHttp } from "./navidrome-catalog.mjs";
import { createLocalNavidromeLibrary } from "./navidrome-library.mjs";
import { createOpenSubsonicClient } from "./opensubsonic-client.mjs";
import { createRNPSNetworkingTransport } from "./rnps-networking-transport.mjs";
import { createBaseRandomBytes } from "./base-runtime-bindings.mjs";
import { md5Utf8 } from "./md5-utf8.mjs";
import { createResidentAudioControlTransport } from "./resident-audio-control-transport.mjs";
import { createAudioPlayer, idleAudioStatus } from "./audio-player.mjs";
import { createPlaybackNotifications } from "./playback-notifications.mjs";
import { createCredentialStore } from "./credential-store.mjs";

function own(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function"))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function initializationFailure(code) {
  const error = new Error("Local session initialization unavailable");
  error.code = code;
  return error;
}

function initializeStage(code, initialize) {
  try {
    return initialize();
  } catch (error) {
    // Only our fixed symbolic codes may cross the constructor boundary. Never
    // retain a native error message, cause, URL, credentials or error object.
    let nested;
    try {
      nested = own(error, "code");
    } catch {
      /* Use the fixed stage below. */
    }
    throw initializationFailure(
      typeof nested === "string" &&
        /^(NDSESSION|NDNET|NDRNG)_[A-Z0-9_]{1,48}$/.test(nested)
        ? nested
        : code,
    );
  }
}

// Construct on the normal JS thread. Module initialization is lazy; incomplete
// cache records are rejected. Saved login may reconnect; playback needs user action.
export function createShellUiBaseLocalSession({
  baseRequire,
  firmware,
  baseBundleSha256,
  serverUrl = DEFAULT_SERVER_URL,
  timeoutMs = 30000,
  isRuntimeCurrent,
  onState,
  audioConfig,
} = {}) {
  if (
    firmware !== FIRMWARE ||
    baseBundleSha256 !== BASE_DLL_HBC_SHA256 ||
    typeof baseRequire !== "function" ||
    typeof isRuntimeCurrent !== "function" ||
    typeof Reflect !== "object" ||
    !Reflect ||
    typeof Reflect.apply !== "function"
  ) {
    throw initializationFailure("NDSESSION_IDENTITY");
  }
  if (!initializeStage("NDSESSION_CURRENT_READ", isRuntimeCurrent)) {
    throw initializationFailure("NDSESSION_RUNTIME_CHANGED");
  }
  const factories = own(baseRequire, "m"),
    cache = own(baseRequire, "c");
  const networkingFactory = own(factories, "w/W2Hpjb"),
    timerFactory = own(factories, "oFysat5F");
  if (
    !cache ||
    typeof networkingFactory !== "function" ||
    typeof timerFactory !== "function"
  ) {
    throw initializationFailure("NDSESSION_DEPENDENCIES");
  }
  let disposed = false,
    closing = false,
    disposal,
    serial = 0,
    active,
    pending,
    loginFailureCode,
    publicResponseTarget;
  const modules = [];
  function currentRuntime() {
    return (
      !disposed &&
      isRuntimeCurrent() &&
      own(baseRequire, "m") === factories &&
      own(baseRequire, "c") === cache &&
      own(factories, "w/W2Hpjb") === networkingFactory &&
      own(factories, "oFysat5F") === timerFactory &&
      modules.every(
        ({ id, record, exported }) =>
          own(cache, id) === record &&
          own(record, "i") === id &&
          own(record, "l") === true &&
          own(record, "exports") === exported,
      )
    );
  }
  function module(id, label) {
    if (!currentRuntime())
      throw initializationFailure("NDSESSION_RUNTIME_CHANGED");
    let record = own(cache, id),
      returned;
    if (record === undefined) {
      returned = initializeStage(`NDSESSION_${label}_INITIALIZE`, () =>
        Reflect.apply(baseRequire, undefined, [id]),
      );
      record = own(cache, id);
    }
    const exported = own(record, "exports");
    if (
      !record ||
      own(record, "i") !== id ||
      own(record, "l") !== true ||
      exported === undefined ||
      (returned !== undefined && returned !== exported)
    ) {
      throw initializationFailure(`NDSESSION_${label}_CACHE`);
    }
    modules.push({ id, record, exported });
    if (!currentRuntime())
      throw initializationFailure("NDSESSION_RUNTIME_CHANGED");
    return exported;
  }
  initializeStage("NDSESSION_NETWORKING_READ", () =>
    module("w/W2Hpjb", "NETWORKING"),
  );
  const timers = initializeStage("NDSESSION_TIMERS_READ", () =>
    module("oFysat5F", "TIMERS"),
  );
  const setTimer = own(timers, "setTimeout"),
    clearTimer = own(timers, "clearTimeout");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw initializationFailure("NDSESSION_TIMER_EXPORTS");
  }
  const randomBytes = initializeStage("NDSESSION_RNG_CREATE", () =>
    createBaseRandomBytes({
      baseRequire,
      firmware,
      baseBundleSha256,
      isRuntimeCurrent: currentRuntime,
    }),
  );
  const storageExports = module("3MUht1S/", "STORAGE");
  const savedLogin = createCredentialStore({
    storage: storageExports.default || storageExports,
    isRuntimeCurrent: currentRuntime,
  });

  const audio =
    audioConfig === undefined
      ? undefined
      : createAudioPlayer({
          token: own(audioConfig, "token"),
          randomBytes,
          isRuntimeCurrent: currentRuntime,
          onState,
          onTrackStart: createPlaybackNotifications({
            baseRequire,
            isRuntimeCurrent: currentRuntime,
          }),
          scheduleTimer: (fn, ms) => Reflect.apply(setTimer, timers, [fn, ms]),
          cancelTimer: (id) => Reflect.apply(clearTimer, timers, [id]),
          transport: createResidentAudioControlTransport({
            token: own(audioConfig, "token"),
            baseRequire,
            firmware,
            baseBundleSha256,
            isRuntimeCurrent: currentRuntime,
            scheduleTimer: (fn, ms) =>
              Reflect.apply(setTimer, timers, [fn, ms]),
            cancelTimer: (id) => Reflect.apply(clearTimer, timers, [id]),
          }),
        });
  function currentSession() {
    return !closing && currentRuntime();
  }
  function stopPlayback() {
    return audio ? audio.stopPlayback() : Promise.resolve(idleAudioStatus());
  }
  function stopWithoutWaiting() {
    // Logout is synchronous in OpenSubsonic; retain the separate Stop ACK state.
    stopPlayback().catch(() => undefined);
  }
  async function onPlay({
    client,
    library,
    resolveStream,
    isCurrent,
    tracks,
    track,
  } = {}) {
    if (
      !audio ||
      !currentSession() ||
      client !== active?.client ||
      library !== active?.library ||
      client.state !== "connected" ||
      typeof resolveStream !== "function" ||
      typeof isCurrent !== "function"
    ) {
      throw initializationFailure("ND_AUDIO_SESSION_CHANGED");
    }
    const version = client.sessionVersion;
    const sessionCheck = () =>
      currentSession() &&
      client === active?.client &&
      library === active?.library &&
      client.state === "connected" &&
      client.sessionVersion === version;
    const check = () => sessionCheck() && isCurrent();
    if (Array.isArray(tracks) && tracks.length) {
      return audio.playCollection(
        tracks.map((track) => ({
          track,
          resolveStream: async () => {
            if (!sessionCheck())
              throw initializationFailure("ND_AUDIO_SESSION_CHANGED");
            const url = await library.resolveStream(track.uri);
            if (!sessionCheck())
              throw initializationFailure("ND_AUDIO_SESSION_CHANGED");
            return url;
          },
        })),
        check,
        sessionCheck,
      );
    }
    return audio.play(
      async () => {
        if (!check()) throw initializationFailure("ND_AUDIO_SESSION_CHANGED");
        const url = await resolveStream();
        if (!check()) throw initializationFailure("ND_AUDIO_SESSION_CHANGED");
        return url;
      },
      check,
      track
        ? {
            uri: track.uri,
            name: track.name,
            artist: track.artist,
            albumUri:
              typeof track.context === "string" &&
              track.context.startsWith("navidrome:album:")
                ? track.context
                : undefined,
          }
        : undefined,
    );
  }

  function makeConnection(url) {
    if (!currentSession())
      throw initializationFailure("NDSESSION_RUNTIME_CHANGED");
    const allowHttp = allowsLocalHttp(url);
    const transport = initializeStage("NDSESSION_TRANSPORT_CREATE", () =>
      createRNPSNetworkingTransport({
        baseRequire,
        firmware,
        baseBundleSha256,
        serverUrl: url,
        allowHttp,
        scheduleTimer: (fn, ms) => Reflect.apply(setTimer, timers, [fn, ms]),
        cancelTimer: (id) => Reflect.apply(clearTimer, timers, [id]),
      }),
    );
    let loginCurrent;
    function assertLive() {
      if (
        !currentSession() ||
        own(timers, "setTimeout") !== setTimer ||
        own(timers, "clearTimeout") !== clearTimer ||
        (loginCurrent && !loginCurrent())
      ) {
        transport.abortAll();
        throw new Error("The local Navidrome session is no longer current");
      }
    }
    const raw = initializeStage("NDSESSION_CLIENT_CREATE", () =>
      createOpenSubsonicClient({
        serverUrl: url,
        timeoutMs,
        allowHttp,
        redirectPolicy: "match-native-response-target",
        md5Utf8,
        randomBytes: async (length) => {
          assertLive();
          const result = await randomBytes(length);
          assertLive();
          return result;
        },
        transport: async (request) => {
          assertLive();
          const response = await transport(request);
          assertLive();
          return response;
        },
      }),
    );
    const client = initializeStage("NDSESSION_CLIENT_WRAPPER", () => {
      const wrapped = Object.create(raw);
      Object.defineProperty(wrapped, "logout", {
        enumerable: true,
        value() {
          loginCurrent = undefined;
          raw.logout();
          transport.abortAll();
          if (active?.client === wrapped || pending?.client === wrapped)
            stopWithoutWaiting();
        },
      });
      Object.freeze(wrapped);
      return wrapped;
    });
    const library = initializeStage("NDSESSION_LIBRARY_CREATE", () =>
      createLocalNavidromeLibrary({
        client,
        ...(audio ? { streamFormat: "mp3", streamMaxBitRate: 192 } : {}),
      }),
    );
    return {
      client,
      library,
      transport,
      setLoginCurrent: (check) => {
        loginCurrent = check;
      },
      clearLoginCurrent: () => {
        loginCurrent = undefined;
      },
    };
  }
  active = initializeStage("NDSESSION_CONNECTION_CREATE", () =>
    makeConnection(serverUrl),
  );

  async function onLogin({
    serverUrl: requestedUrl,
    username,
    password,
    token,
    salt,
    isCurrent,
    restore = false,
  } = {}) {
    if (typeof isCurrent !== "function" || !isCurrent() || !currentSession()) {
      throw new Error("The local login view is unavailable");
    }
    const attempt = ++serial;
    loginFailureCode = undefined;
    publicResponseTarget = undefined;
    pending?.client.logout();
    active?.client.logout();
    let connection;
    const credentials = { username, password, token, salt };
    password = undefined;
    try {
      await stopPlayback();
      if (!currentSession() || serial !== attempt || !isCurrent())
        throw new Error("The local login was cancelled");
      connection = makeConnection(requestedUrl);
      pending = connection;
      connection.setLoginCurrent(
        () => currentSession() && serial === attempt && isCurrent(),
      );
      await connection.client.login(credentials);
      if (!currentSession() || serial !== attempt || !isCurrent())
        throw new Error("The local login was cancelled");
      let rememberFailed = false;
      if (!restore) {
        try {
          const authentication = await connection.client.savedAuthentication();
          if (!currentSession() || serial !== attempt || !isCurrent())
            throw new Error("Cancelled");
          await savedLogin.save({
            serverUrl: connection.client.serverUrl,
            ...authentication,
          });
        } catch {
          rememberFailed = true;
        }
      }
      if (!currentSession() || serial !== attempt || !isCurrent())
        throw new Error("The local login was cancelled");
      connection.clearLoginCurrent();
      active = connection;
      return {
        client: connection.client,
        library: connection.library,
        rememberFailed,
      };
    } catch (error) {
      connection?.client.logout();
      publicResponseTarget = connection?.transport.publicResponseTarget;
      const code = own(error, "code");
      loginFailureCode =
        typeof code === "string" && /^ND[A-Z]+_[A-Z0-9_]{1,48}$/.test(code)
          ? code
          : Number.isInteger(code) && code >= 0 && code <= 999
            ? `NDAUTH_${code}`
            : "NDLOGIN_UNKNOWN";
      throw initializationFailure(loginFailureCode);
    } finally {
      credentials.username =
        credentials.password =
        credentials.token =
        credentials.salt =
          "";
      if (pending === connection) pending = undefined;
      try {
        onState?.();
      } catch {
        /* Fixed diagnostics must not change login. */
      }
    }
  }

  async function onRestore({ isCurrent } = {}) {
    const authentication = await savedLogin.load();
    if (!authentication) return undefined;
    return onLogin({ ...authentication, isCurrent, restore: true });
  }
  async function onDisconnect() {
    serial++;
    await savedLogin.forget();
    pending?.client.logout();
    active?.client.logout();
  }

  return Object.freeze({
    bindings() {
      if (!currentSession())
        throw new Error("The local session is unavailable");
      return {
        client: active.client,
        library: active.library,
        onLogin,
        onRestore,
        onDisconnect,
        ...(audio ? { onPlay, audio } : {}),
      };
    },
    stopPlayback,
    status: () => ({
      disposed,
      playback: audio ? audio.status() : idleAudioStatus(),
      state: active?.client.state,
      pending: pending !== undefined,
      loginFailureCode,
      publicResponseTarget,
      redirectPolicy: "match-native-response-target",
      ownsSession: true,
      runtime: "base_dll",
    }),
    dispose() {
      if (disposed) return disposal;
      if (disposal) return disposal;
      closing = true;
      serial++;
      // Cancel login/stream work, but retain the pinned native runtime until Stop
      // is acknowledged. Closing rejects new session operations immediately.
      pending?.client.logout();
      active?.client.logout();
      function complete() {
        disposed = true;
        pending = active = undefined;
      }
      const playback = audio?.status();
      const idle =
        !audio ||
        (playback.stopConfirmed &&
          !playback.pending &&
          !playback.stopPending &&
          !playback.workerActive &&
          playback.closeConfirmed);
      const stopped = audio ? audio.dispose() : Promise.resolve();
      if (idle) complete(); // Keep synchronous cleanup for guarded idle recovery.
      disposal = stopped.then(
        () => {
          complete();
        },
        (error) => {
          // Preserve the runtime and failed Stop diagnostics; another dispose can
          // retry safely without permitting a new login or Play.
          disposal = undefined;
          throw error;
        },
      );
      return disposal;
    },
  });
}
