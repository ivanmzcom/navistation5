/** Dedicated captured RNPS 9-argument Networking channel. No Navidrome allowlist changes.
 * POST body is private; no request/error/body/native error text reaches diagnostics.
 * Sony can report only a relative response path, so final origin is not provable.
 * The fixed loopback daemon must not redirect. Limits apply at JS event delivery.
 */
import { BASE_DLL_HBC_SHA256 } from "./rnps-networking-transport.mjs";
const ENDPOINT = "http://127.0.0.1:9185/v1/control";
const LIMIT = 4096;
function own(object, key) {
  const d = object && Object.getOwnPropertyDescriptor(object, key);
  return d && "value" in d ? d.value : undefined;
}
function failure(code) { const error = new Error("Local audio control unavailable"); error.code = code; return error; }
function method(object, key) {
  for (let level = 0; object && level < 3; level++, object = Object.getPrototypeOf(object)) {
    const value = own(object, key);
    if (typeof value === "function") return value;
  }
  throw failure("ND_AUDIO_TRANSPORT_SHAPE");
}
export function createAudioControlTransport({ baseRequire, firmware, baseBundleSha256,
  scheduleTimer, cancelTimer } = {}) {
  if (firmware !== 0x13200006 || baseBundleSha256 !== BASE_DLL_HBC_SHA256 ||
      typeof baseRequire !== "function" || typeof scheduleTimer !== "function" ||
      typeof cancelTimer !== "function") throw failure("ND_AUDIO_TRANSPORT_IDENTITY");
  const cache = own(baseRequire, "c"), factories = own(baseRequire, "m");
  const record = own(cache, "w/W2Hpjb"), factory = own(factories, "w/W2Hpjb");
  const networking = own(record, "exports");
  if (own(record, "l") !== true || !networking || typeof factory !== "function") {
    throw failure("ND_AUDIO_TRANSPORT_CACHE");
  }
  const send = method(networking, "sendRequest"), abort = method(networking, "abortRequest");
  const add = method(networking, "addListener");
  function pinned() {
    return own(baseRequire, "c") === cache && own(baseRequire, "m") === factories &&
      own(cache, "w/W2Hpjb") === record && own(record, "l") === true &&
      own(record, "exports") === networking && own(factories, "w/W2Hpjb") === factory &&
      method(networking, "sendRequest") === send && method(networking, "abortRequest") === abort &&
      method(networking, "addListener") === add;
  }
  return function request(body) {
    return new Promise((resolve, reject) => {
      let id, timer, finished = false, seen = false, status, chunks = [], size = 0;
      const subscriptions = [];
      function finish(code, cancel = false) {
        if (finished) return;
        finished = true;
        if (timer !== undefined) { try { cancelTimer(timer); } catch {} }
        for (const subscription of subscriptions) { try { subscription.remove(); } catch {} }
        if (cancel && id !== undefined) { try { Reflect.apply(abort, networking, [id]); } catch {} }
        if (code) { chunks = []; reject(failure(code)); return; }
        const text = chunks.join(""); chunks = [];
        resolve({ status, body: text });
      }
      function listen(name, callback) {
        const subscription = Reflect.apply(add, networking, [name, event => {
          if (finished || id === undefined || !Array.isArray(event) || event[0] !== id) return;
          try { callback(event); } catch { finish("ND_AUDIO_TRANSPORT_EVENT", true); }
        }]);
        if (!subscription || typeof subscription.remove !== "function") throw failure("ND_AUDIO_TRANSPORT_EVENT");
        subscriptions.push(subscription);
      }
      function data(value, replace) {
        // Daemon response contains ASCII fixed codes, owner and numeric fields.
        if (typeof value !== "string" || /[^\x00-\x7f]/.test(value)) { finish("ND_AUDIO_RESPONSE_DATA", true); return; }
        if (replace) { chunks = []; size = 0; }
        size += value.length;
        if (size > LIMIT) { finish("ND_AUDIO_RESPONSE_LIMIT", true); return; }
        chunks.push(value);
        if (chunks.length >= 32) chunks = [chunks.join("")];
      }
      try {
        if (!pinned()) throw failure("ND_AUDIO_TRANSPORT_CHANGED");
        if (typeof body !== "string" || body.length > 12288 || /[^\x20-\x7e]/.test(body)) {
          throw failure("ND_AUDIO_REQUEST_BODY");
        }
        listen("didReceiveNetworkResponse", event => {
          if (seen || ![200, 202, 400, 403, 409].includes(event[1]) ||
              (event[3] !== ENDPOINT && event[3] !== "/v1/control")) {
            finish("ND_AUDIO_RESPONSE_TARGET", true); return;
          }
          seen = true; status = event[1];
          const headers = event[2];
          if (headers && typeof headers === "object") {
            for (const key of Object.keys(headers)) {
              if (key.toLowerCase() === "content-length" && Number(own(headers, key)) > LIMIT) {
                finish("ND_AUDIO_RESPONSE_LIMIT", true); return;
              }
            }
          }
        });
        listen("didReceiveNetworkIncrementalData", event => data(event[1], false));
        listen("didReceiveNetworkData", event => data(event[1], true));
        listen("didReceiveNetworkDataProgress", event => {
          if (Number.isFinite(event[1]) && event[1] > LIMIT) finish("ND_AUDIO_RESPONSE_LIMIT", true);
        });
        listen("didCompleteNetworkResponse", event => {
          if (event[1] || event[2]) finish(event[2] ? "ND_AUDIO_CONTROL_TIMEOUT" : "ND_AUDIO_CONTROL_NETWORK");
          else if (!seen) finish("ND_AUDIO_RESPONSE_METADATA");
          else finish();
        });
        timer = scheduleTimer(() => finish("ND_AUDIO_CONTROL_TIMEOUT", true), 20000);
        Reflect.apply(send, networking, ["POST", "NavidromeAudioControl", ENDPOINT,
          { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" },
          body, "text", true, 20000, requestId => {
            if (!Number.isSafeInteger(requestId) || requestId < 1) { finish("ND_AUDIO_REQUEST_ID", true); return; }
            id = requestId;
            if (finished) { try { Reflect.apply(abort, networking, [id]); } catch {} }
          }]);
        body = undefined;
      } catch (error) {
        const code = own(error, "code");
        finish(typeof code === "string" && /^ND_AUDIO_[A-Z0-9_]+$/.test(code) ? code : "ND_AUDIO_REQUEST_START", true);
      }
    });
  };
}
