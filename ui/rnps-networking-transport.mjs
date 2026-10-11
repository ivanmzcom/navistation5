import { FIRMWARE, BASE_DLL_HBC_SHA256 } from "./firmware-profile.mjs";
// RNPS Networking bridge. Redirects occur before final URL validation; configure a trusted server.

const ENDPOINTS = [
  "getOpenSubsonicExtensions",
  "ping",
  "getAlbumList2",
  "getPlaylists",
  "getPlaylist",
  "getAlbum",
  "getSong",
  "getArtist",
  "search3",
];
const BYTE_LIMIT = 4 * 1024 * 1024;

function initializationFailure(code) {
  const error = new Error("RNPS networking initialization unavailable");
  error.code = code;
  return error;
}

function own(object, key) {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function method(object, key, code) {
  try {
    for (
      let level = 0;
      object && level < 3;
      level++, object = Object.getPrototypeOf(object)
    ) {
      const value = own(object, key);
      if (typeof value === "function") return value;
    }
  } catch {
    throw initializationFailure(`${code}_READ`);
  }
  throw initializationFailure(code);
}

function cachedNetworking(baseRequire) {
  const record = own(own(baseRequire, "c"), "w/W2Hpjb");
  if (!record || own(record, "l") !== true)
    throw initializationFailure("NDNET_MODULE_CACHE");
  return own(record, "exports");
}

function serverBase(value, allowHttp) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^https?:\/\/(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::[0-9]{1,5})?(?:\/[^\s?#\\]*)?$/.test(
      value,
    ) ||
    (!value.startsWith("https://") && allowHttp !== true) ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw new Error(
      "An HTTPS or explicitly enabled HTTP Navidrome server is required",
    );
  return value.replace(/\/+$/, "");
}

// Native URI formatting may decode percent escapes in the query. Compare
// individual form parameters, preserving origin/path, separators, order and
// duplicate keys; decoding the whole URL could mistake a delimiter for data.
function sameResponseUrl(expected, received, allowNativePath = false) {
  if (expected === received) return true;
  if (
    typeof received !== "string" ||
    received.length > 65536 ||
    /[\u0000-\u0020\u007f#\\]/.test(received)
  )
    return false;
  if (
    allowNativePath &&
    received.startsWith("/") &&
    !received.startsWith("//")
  ) {
    const origin = /^https?:\/\/[^/]+/.exec(expected);
    if (!origin) return false;
    const target = expected.slice(origin[0].length);
    // Captured PS5 13.20 emits a relative response target. A path-only value
    // cannot establish the final origin/query; expose this in capabilities.
    if (received.indexOf("?") < 0) return received === target.split("?")[0];
    return sameResponseUrl(expected, origin[0] + received);
  }
  const split = expected.indexOf("?"),
    otherSplit = received.indexOf("?");
  if (
    split < 0 ||
    otherSplit < 0 ||
    expected.slice(0, split) !== received.slice(0, otherSplit)
  )
    return false;
  const parameters = expected.slice(split + 1).split("&"),
    other = received.slice(otherSplit + 1).split("&");
  if (parameters.length !== other.length) return false;
  function pair(text) {
    const equal = text.indexOf("=");
    if (equal < 0) return undefined;
    return [
      decodeURIComponent(text.slice(0, equal).replace(/\+/g, " ")),
      decodeURIComponent(text.slice(equal + 1).replace(/\+/g, " ")),
    ];
  }
  try {
    return parameters.every((parameter, index) => {
      const a = pair(parameter),
        b = pair(other[index]);
      return a && b && a[0] === b[0] && a[1] === b[1];
    });
  } catch {
    return false;
  }
}

// Count UTF-8 bytes across UTF-16 chunks, including a surrogate pair split
// between events. Lone surrogates count as the three-byte replacement scalar.
function countChunk(text, counter, maximum) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (counter.high && unit >= 0xdc00 && unit <= 0xdfff) {
      counter.bytes += 1; // Previous high surrogate already counted as three.
      counter.high = false;
    } else {
      counter.high = unit >= 0xd800 && unit <= 0xdbff;
      counter.bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (counter.bytes > maximum)
      throw new Error("RNPS response exceeds the byte limit");
  }
}

/**
 * baseRequire is the observed global.base_dll, already initialized.
 * scheduleTimer(fn,ms)/cancelTimer(id) are the real realm timer functions.
 * The caller measures firmware/bundle identity; supplied hashes do not prove it.
 * Returns transport(request), with .capabilities and .abortAll().
 */
export function createRNPSNetworkingTransport({
  baseRequire,
  firmware,
  baseBundleSha256,
  serverUrl,
  scheduleTimer,
  cancelTimer,
  allowHttp = false,
} = {}) {
  if (
    firmware !== FIRMWARE ||
    baseBundleSha256 !== BASE_DLL_HBC_SHA256 ||
    typeof baseRequire !== "function" ||
    typeof scheduleTimer !== "function" ||
    typeof cancelTimer !== "function"
  )
    throw initializationFailure("NDNET_IDENTITY");
  let server, networking;
  try {
    server = serverBase(serverUrl, allowHttp);
  } catch {
    throw initializationFailure("NDNET_SERVER_URL");
  }
  try {
    networking = cachedNetworking(baseRequire);
  } catch {
    throw initializationFailure("NDNET_MODULE_CACHE");
  }
  if (!networking || typeof networking !== "object")
    throw initializationFailure("NDNET_MODULE_EXPORT");
  const sendRequest = method(networking, "sendRequest", "NDNET_SEND_REQUEST");
  const abortRequest = method(
    networking,
    "abortRequest",
    "NDNET_ABORT_REQUEST",
  );
  const addListener = method(networking, "addListener", "NDNET_ADD_LISTENER");
  const pending = new Set();

  function transport(request = {}) {
    return new Promise((resolve, reject) => {
      let requestId,
        timer,
        finished = false,
        responseSeen = false,
        status;
      let chunks = [],
        counter = { bytes: 0, high: false };
      const subscriptions = [];
      const stop = () => settle("NDNET_CANCELLED", true);

      function settle(error, abort = false) {
        if (finished) return;
        finished = true;
        pending.delete(stop);
        if (timer !== undefined) {
          try {
            cancelTimer(timer);
          } catch {}
        }
        for (const subscription of subscriptions) {
          try {
            subscription.remove();
          } catch {}
        }
        subscriptions.length = 0;
        if (abort && requestId !== undefined) {
          try {
            abortRequest.call(networking, requestId);
          } catch {}
        }
        if (error) {
          chunks = [];
          reject(initializationFailure(error));
          return;
        }
        const body = chunks.join("");
        chunks = [];
        resolve({ status, body });
      }

      function listen(name, callback) {
        const subscription = addListener.call(networking, name, (event) => {
          if (
            finished ||
            !Array.isArray(event) ||
            event[0] !== requestId ||
            requestId === undefined
          )
            return;
          try {
            callback(event);
          } catch {
            settle("NDNET_EVENT_PROCESSING", true);
          }
        });
        if (!subscription || typeof subscription.remove !== "function")
          throw new Error("Missing event subscription");
        subscriptions.push(subscription);
      }

      try {
        if (cachedNetworking(baseRequire) !== networking)
          throw new Error("Networking changed");
        const { url, body, timeoutMs, maxResponseBytes, redirect, cache } =
          request;
        if (
          typeof url !== "string" ||
          url.length > 65536 ||
          /[\u0000-\u0020\u007f#\\]/.test(url) ||
          !url.startsWith(`${server}/rest/`)
        )
          throw new Error("Invalid Navidrome URL");
        const endpoint = url.slice(server.length + 6).split("?")[0];
        if (!ENDPOINTS.some((name) => endpoint === `${name}.view`))
          throw new Error("Unsupported endpoint");
        if (
          !["GET", "POST"].includes(request.method) ||
          (body !== undefined &&
            (request.method !== "POST" ||
              typeof body !== "string" ||
              body.length > 65536)) ||
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 120000 ||
          !Number.isSafeInteger(maxResponseBytes) ||
          maxResponseBytes < 1 ||
          maxResponseBytes > BYTE_LIMIT ||
          !["reject-final-url-change", "match-native-response-target"].includes(
            redirect,
          ) ||
          cache !== "no-store"
        )
          throw new Error("Unsupported transport policy");
        const headers = {
          "Cache-Control": "no-store, no-cache",
          Pragma: "no-cache",
        };
        if (
          !request.headers ||
          typeof request.headers !== "object" ||
          Array.isArray(request.headers)
        )
          throw new Error("Invalid headers");
        for (const name of Object.keys(request.headers)) {
          const value = own(request.headers, name);
          if (
            !["accept", "content-type"].includes(name.toLowerCase()) ||
            typeof value !== "string" ||
            value.length > 256 ||
            /[\r\n\u0000]/.test(value)
          )
            throw new Error("Unsupported header");
          headers[name] = value;
        }

        listen("didReceiveNetworkResponse", (event) => {
          const [, nextStatus, responseHeaders, finalUrl] = event;
          if (endpoint === "getOpenSubsonicExtensions.view") {
            // Public, unauthenticated discovery only; exclude all query data,
            // credentials, fragments and unexpected URL characters.
            const target =
              typeof finalUrl === "string" ? finalUrl.split("?")[0] : undefined;
            transport.publicResponseTarget =
              target === ""
                ? "[empty]"
                : typeof target === "string" &&
                    target.length <= 110 &&
                    /^(?:https?:\/\/[A-Za-z0-9.:-]+)?\/[A-Za-z0-9._/-]*$/.test(
                      target,
                    )
                  ? target
                  : "[unavailable]";
          }
          if (
            responseSeen ||
            !Number.isInteger(nextStatus) ||
            nextStatus < 100 ||
            nextStatus > 599 ||
            typeof finalUrl !== "string" ||
            !sameResponseUrl(
              url,
              finalUrl,
              redirect === "match-native-response-target",
            )
          ) {
            settle(
              typeof finalUrl !== "string"
                ? "NDNET_RESPONSE_URL_MISSING"
                : !sameResponseUrl(
                      url,
                      finalUrl,
                      redirect === "match-native-response-target",
                    )
                  ? finalUrl.split("?")[0] === url.split("?")[0]
                    ? "NDNET_RESPONSE_QUERY_CHANGED"
                    : "NDNET_RESPONSE_TARGET_CHANGED"
                  : "NDNET_RESPONSE_STATUS",
              true,
            );
            return;
          }
          responseSeen = true;
          status = nextStatus;
          if (responseHeaders && typeof responseHeaders === "object") {
            for (const key of Object.keys(responseHeaders)) {
              const value = responseHeaders[key];
              if (
                key.toLowerCase() === "content-length" &&
                /^\d+$/.test(String(value)) &&
                Number(value) > maxResponseBytes
              ) {
                settle("NDNET_RESPONSE_LIMIT", true);
                return;
              }
            }
          }
        });
        listen("didReceiveNetworkIncrementalData", (event) => {
          if (typeof event[1] !== "string") {
            settle("NDNET_RESPONSE_DATA", true);
            return;
          }
          countChunk(event[1], counter, maxResponseBytes);
          if (event[1]) chunks.push(event[1]);
          if (chunks.length >= 64) chunks = [chunks.join("")];
        });
        listen("didReceiveNetworkData", (event) => {
          if (typeof event[1] !== "string") {
            settle("NDNET_RESPONSE_DATA", true);
            return;
          }
          counter = { bytes: 0, high: false };
          countChunk(event[1], counter, maxResponseBytes);
          chunks = [event[1]];
        });
        listen("didReceiveNetworkDataProgress", (event) => {
          if (Number.isFinite(event[1]) && event[1] > maxResponseBytes)
            settle("NDNET_RESPONSE_LIMIT", true);
        });
        listen("didCompleteNetworkResponse", (event) => {
          if (event[1] || event[2]) {
            settle(event[2] ? "NDNET_NATIVE_TIMEOUT" : "NDNET_NATIVE_ERROR");
            return;
          }
          if (!responseSeen) {
            settle("NDNET_RESPONSE_METADATA");
            return;
          }
          settle();
        });
        pending.add(stop);
        timer = scheduleTimer(() => settle("NDNET_TIMEOUT", true), timeoutMs);
        // Real wrapper signature: method, trackingName, URL, headers, data,
        // responseType, incrementalUpdates, timeout, requestId callback.
        sendRequest.call(
          networking,
          request.method,
          "NavidromePS5",
          url,
          headers,
          body,
          "text",
          true,
          timeoutMs,
          (id) => {
            if (!Number.isSafeInteger(id) || id < 1) {
              settle("NDNET_REQUEST_ID", true);
              return;
            }
            requestId = id;
            if (finished) {
              try {
                abortRequest.call(networking, id);
              } catch {}
            }
          },
        );
      } catch {
        settle("NDNET_REQUEST_START", true);
      }
    });
  }

  transport.capabilities = Object.freeze({
    redirectPolicy: "match-native-response-target",
    rejectsRedirectBeforeFollowing: false,
    nativeResponseTarget: "relative-path-observed",
    verifiesFinalOrigin: false,
    verifiesFinalQueryWhenAbsent: false,
    responseLimit: "on-js-network-event",
    nativeTimeout: true,
    cancellation: true,
    trackingName: "NavidromePS5",
    cacheControl: "request-headers",
    cookiePolicy: "native-unspecified",
    tlsPolicy: server.startsWith("https://")
      ? "native-system-defaults"
      : "not-applicable-http",
    callsNimbus: false,
  });
  transport.abortAll = () => {
    for (const stop of Array.from(pending)) stop();
  };
  return transport;
}
