/**
 * Portable OpenSubsonic client. No browser globals, storage, console or UI hooks.
 * Protocol: https://opensubsonic.netlify.app/docs/api-reference/
 * The injected transport and crypto providers are trusted runtime dependencies.
 */
import { DEFAULT_SERVER_URL } from "./navidrome-catalog.mjs";

const API_VERSION = "1.16.1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ALBUM_TYPES = ["random", "newest", "highest", "frequent", "recent", "starred",
  "alphabeticalByName", "alphabeticalByArtist"];

function failure(message, code) {
  const error = new Error(message);
  if (Number.isInteger(code) || (typeof code === "string" && /^ND[A-Z]+_[A-Z0-9_]{1,48}$/.test(code))) error.code = code;
  return error;
}

function diagnosticCode(error, fallback) {
  const descriptor = error && Object.getOwnPropertyDescriptor(error, "code");
  const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof code === "string" && /^ND[A-Z]+_[A-Z0-9_]{1,48}$/.test(code) ? code : fallback;
}

function initializationFailure(code) {
  const error = failure("OpenSubsonic client initialization unavailable");
  error.code = code;
  return error;
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("Invalid OpenSubsonic response structure");
  }
  return value;
}

function string(value, label, maximum = 4096, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.length > maximum) {
    throw failure(`Invalid ${label}`);
  }
  // Reject isolated UTF-16 surrogates without relying on TextEncoder in Hermes.
  try { encodeURIComponent(value); }
  catch { throw failure(`Invalid ${label} encoding`); }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure(`Invalid ${label}`);
  }
  return value;
}

function baseUrl(value, allowHttp) {
  string(value, "server URL");
  // Deliberately restrict the accepted syntax; do not assume a global URL class.
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?((?:\/[^\s?#\\]*)?)$/.exec(value);
  if (!match || (match[1] !== "https" && !allowHttp) ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      (match[3] && (+match[3] < 1 || +match[3] > 65535))) {
    throw failure("Expected an HTTPS server URL without credentials, query or fragment");
  }
  return value.replace(/\/+$/, "");
}

function encodeForm(entries) {
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function arrayField(value, key) {
  object(value);
  if (value[key] === undefined) return [];
  if (!Array.isArray(value[key])) throw failure("Invalid OpenSubsonic list");
  return value[key];
}

function payload(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
    throw failure("OpenSubsonic response is missing its payload");
  }
  return body[key];
}

function serverInfo(body) {
  return {
    version: typeof body.version === "string" ? body.version : undefined,
    type: typeof body.type === "string" ? body.type : undefined,
    serverVersion: typeof body.serverVersion === "string" ? body.serverVersion : undefined,
    openSubsonic: body.openSubsonic === true,
  };
}

/**
 * transport(request) -> Promise<{status: number, body: string, redirected?: boolean}>.
 * Default redirectPolicy is 'error': transport must reject before following.
 * RNPS supports the explicit alternative 'reject-final-url-change': native
 * redirects have already happened when its final URL check runs. It cannot
 * detect a redirect chain that returns to the original URL. See its capabilities.
 * Transport must enforce timeoutMs and its documented response-byte bound;
 * RNPS checks at JS network events after native allocation. No app logging or
 * credential persistence; RNPS cache/TLS/cookies use documented native policy.
 * randomBytes(16) -> Promise or value containing exactly 16 cryptographic bytes.
 * md5Utf8(text) -> Promise or value containing the 32-character hexadecimal MD5
 * of the UTF-8 text. No Math.random fallback or browser crypto assumptions.
 */
export function createOpenSubsonicClient({ transport, randomBytes, md5Utf8,
  serverUrl = DEFAULT_SERVER_URL, clientName = "NavidromePS5/0.1.0",
  allowHttp = false, timeoutMs = 30000, redirectPolicy = "error" } = {}) {
  if (![transport, randomBytes, md5Utf8].every(value => typeof value === "function")) {
    throw initializationFailure("NDSESSION_CLIENT_PROVIDERS");
  }
  if (typeof encodeURIComponent !== "function" || typeof Number.isSafeInteger !== "function" ||
      typeof Number.isInteger !== "function" || typeof JSON.parse !== "function") {
    throw initializationFailure("NDSESSION_CLIENT_INTRINSICS");
  }
  let server;
  try { server = baseUrl(serverUrl, allowHttp === true); }
  catch { throw initializationFailure("NDSESSION_CLIENT_SERVER_URL"); }
  try { string(clientName, "client name", 128); }
  catch { throw initializationFailure("NDSESSION_CLIENT_NAME"); }
  try { integer(timeoutMs, 1, 120000, "request timeout"); }
  catch { throw initializationFailure("NDSESSION_CLIENT_TIMEOUT"); }
  if (!["error", "reject-final-url-change", "match-native-response-target"].includes(redirectPolicy)) {
    throw initializationFailure("NDSESSION_CLIENT_REDIRECT_POLICY");
  }
  let credentials = null;
  let generation = 0;
  let state = "disconnected";
  let formPost = false;

  function assertCurrent(expected) {
    if (expected !== generation || !credentials) throw failure("Navidrome session has ended");
  }

  function connectedGeneration() {
    if (state !== "connected") throw failure("Connect to Navidrome first");
    return generation;
  }

  function clearCredentials() {
    if (credentials) { credentials.username = ""; credentials.password = ""; }
    credentials = null;
    state = "disconnected";
    formPost = false;
  }

  async function authentication(expected) {
    assertCurrent(expected);
    let bytes;
    let token;
    try { bytes = await randomBytes(16); }
    catch (error) { throw failure("Unable to generate authentication salt", diagnosticCode(error, "NDLOGIN_RANDOM")); }
    assertCurrent(expected);
    if (!bytes || bytes.length !== 16) throw failure("Secure random provider returned invalid bytes", "NDLOGIN_RANDOM_LENGTH");
    let salt = "";
    for (let i = 0; i < 16; i++) {
      const byte = bytes[i];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw failure("Secure random provider returned invalid bytes");
      }
      salt += (byte < 16 ? "0" : "") + byte.toString(16);
    }
    try { token = await md5Utf8(credentials.password + salt); }
    catch { throw failure("Unable to compute authentication token", "NDLOGIN_MD5"); }
    assertCurrent(expected);
    if (typeof token !== "string" || !/^[a-fA-F0-9]{32}$/.test(token)) {
      throw failure("MD5 provider returned an invalid token", "NDLOGIN_MD5_RESULT");
    }
    return [["u", credentials.username], ["t", token.toLowerCase()], ["s", salt],
      ["v", API_VERSION], ["c", clientName], ["f", "json"]];
  }

  async function request(endpoint, parameters, expected, publicDiscovery = false) {
    // The extension endpoint is publicly accessible by specification. Discover
    // POST support before sending any authentication material to ping.
    const auth = publicDiscovery ? [["v", API_VERSION], ["c", clientName], ["f", "json"]]
      : await authentication(expected);
    const form = encodeForm(auth.concat(parameters));
    assertCurrent(expected);
    const post = formPost && !publicDiscovery;
    const endpointUrl = `${server}/rest/${endpoint}.view`;
    let response;
    try {
      response = await transport({
        url: post ? endpointUrl : `${endpointUrl}?${form}`,
        method: post ? "POST" : "GET",
        headers: post ? { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }
          : { Accept: "application/json" },
        body: post ? form : undefined, timeoutMs, maxResponseBytes: MAX_BODY_BYTES,
        redirect: redirectPolicy, cache: "no-store",
      });
    } catch (error) { throw failure("Navidrome request failed", diagnosticCode(error, "NDLOGIN_REQUEST")); }
    assertCurrent(expected);
    object(response);
    if (response.redirected === true || !Number.isInteger(response.status) ||
        response.status < 200 || response.status >= 300) {
      const error = failure("Navidrome returned an unsuccessful HTTP response", "NDLOGIN_HTTP");
      if (Number.isInteger(response.status)) error.httpStatus = response.status;
      throw error;
    }
    // Defense after the transport's byte check. RNPS can enforce this only when
    // its native backend delivers events, not before native allocation.
    if (typeof response.body !== "string" || response.body.length > MAX_BODY_BYTES) {
      throw failure("Invalid or oversized Navidrome response body", "NDLOGIN_BODY");
    }
    let parsed;
    try { parsed = JSON.parse(response.body); }
    catch { throw failure("Navidrome returned invalid JSON", "NDLOGIN_JSON"); }
    const body = object(object(parsed)["subsonic-response"]);
    if (body.status !== "ok") {
      throw failure("Navidrome rejected the request", body.error && body.error.code);
    }
    return body;
  }

  async function detail(endpoint, key, id) {
    string(id, "item ID");
    return object(payload(await request(endpoint, [["id", id]], connectedGeneration()), key));
  }

  async function resourceUrl(endpoint, parameters) {
    const expected = connectedGeneration();
    const form = encodeForm((await authentication(expected)).concat(parameters));
    assertCurrent(expected);
    return `${server}/rest/${endpoint}.view?${form}`;
  }

  return Object.freeze({
    get state() { return state; },
    get serverUrl() { return server; },
    get usesFormPost() { return formPost; },
    get sessionVersion() { return generation; },

    async login({ username, password } = {}) {
      string(username, "username", 1024);
      string(password, "password", 16384, true);
      const expected = ++generation;
      clearCredentials();
      credentials = { username, password };
      state = "connecting";
      try {
        try {
          const body = await request("getOpenSubsonicExtensions", [], expected, true);
          const extensions = payload(body, "openSubsonicExtensions");
          if (Array.isArray(extensions)) {
            formPost = extensions.some(extension => extension && extension.name === "formPost" &&
              Array.isArray(extension.versions) && extension.versions.includes(1));
          }
        } catch {
          // Extension discovery is optional. Keep the authenticated GET path.
          assertCurrent(expected);
          formPost = false;
        }
        const info = serverInfo(await request("ping", [], expected));
        assertCurrent(expected);
        state = "connected";
        return { ...info, formPost };
      } catch (error) {
        if (expected === generation) clearCredentials();
        throw error;
      }
    },

    logout() { ++generation; clearCredentials(); },
    async ping() { return serverInfo(await request("ping", [], connectedGeneration())); },

    async getAlbumList2({ type = "newest", size = 100, offset = 0 } = {}) {
      if (!ALBUM_TYPES.includes(type)) throw failure("Unsupported album list type");
      integer(size, 1, 500, "album list size");
      integer(offset, 0, Number.MAX_SAFE_INTEGER, "album list offset");
      const body = await request("getAlbumList2", [["type", type], ["size", size], ["offset", offset]],
        connectedGeneration());
      return arrayField(payload(body, "albumList2"), "album");
    },

    async getPlaylists() {
      const body = await request("getPlaylists", [], connectedGeneration());
      return arrayField(payload(body, "playlists"), "playlist");
    },
    getAlbum(id) { return detail("getAlbum", "album", id); },
    getPlaylist(id) { return detail("getPlaylist", "playlist", id); },
    getSong(id) { return detail("getSong", "song", id); },
    getArtist(id) { return detail("getArtist", "artist", id); },

    async search3(query, { songCount = 50, songOffset = 0, albumCount = 20,
      albumOffset = 0, artistCount = 20, artistOffset = 0 } = {}) {
      string(query, "search query", 4096, true);
      const parameters = [["query", query]];
      for (const [key, value, maximum] of [["songCount", songCount, 500],
        ["songOffset", songOffset, Number.MAX_SAFE_INTEGER], ["albumCount", albumCount, 500],
        ["albumOffset", albumOffset, Number.MAX_SAFE_INTEGER], ["artistCount", artistCount, 500],
        ["artistOffset", artistOffset, Number.MAX_SAFE_INTEGER]]) {
        parameters.push([key, integer(value, 0, maximum, "search pagination")]);
      }
      const result = payload(await request("search3", parameters, connectedGeneration()), "searchResult3");
      return { song: arrayField(result, "song"), album: arrayField(result, "album"),
        artist: arrayField(result, "artist") };
    },

    streamUrl(id, { format, maxBitRate } = {}) {
      string(id, "song ID");
      const parameters = [["id", id]];
      if (format !== undefined) {
        if (typeof format !== "string" || !/^[a-zA-Z0-9]{1,20}$/.test(format)) {
          throw failure("Invalid stream format");
        }
        parameters.push(["format", format]);
      }
      if (maxBitRate !== undefined) {
        parameters.push(["maxBitRate", integer(maxBitRate, 0, 1000000, "stream bitrate")]);
      }
      return resourceUrl("stream", parameters);
    },

    coverArtUrl(id, { size } = {}) {
      string(id, "cover art ID");
      const parameters = [["id", id]];
      if (size !== undefined) parameters.push(["size", integer(size, 1, 4096, "cover size")]);
      return resourceUrl("getCoverArt", parameters);
    },
  });
}
