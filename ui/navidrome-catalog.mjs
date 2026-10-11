// Projects OpenSubsonic items into Music-card models. See contracts/catalog.ts.

export const DEFAULT_SERVER_URL =
  typeof __NAVISTATION_SERVER_URL__ === "string"
    ? __NAVISTATION_SERVER_URL__
    : "http://navidrome.local:4533";
export const STREAM_PREFIX = DEFAULT_SERVER_URL + "/rest/stream.view?";
// Plain HTTP is allowed only for the configured origin.
export function allowsLocalHttp(serverUrl) {
  return (
    typeof serverUrl === "string" &&
    serverUrl.replace(/\/+$/, "") === DEFAULT_SERVER_URL
  );
}
export const SERVICE_NAME = "navidrome";
const KINDS = new Set(["song", "album", "playlist", "artist"]);

function opaqueId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new TypeError("Navidrome item requires a nonempty string ID");
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.length ? value : fallback;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function explicit(item) {
  return item.explicitStatus === "explicit"
    ? true
    : item.explicitStatus === "clean"
      ? false
      : undefined;
}

function artistNames(item) {
  if (Array.isArray(item.artists)) {
    const names = item.artists
      .map((artist) => text(artist?.name))
      .filter(Boolean);
    if (names.length) return names.join(", ");
  }
  return text(item.displayArtist, text(item.artist, " "));
}

/** Internal identifiers, not streaming URLs or a claimed PS5 URI scheme. */
export function itemUri(kind, id) {
  if (!KINDS.has(kind)) throw new TypeError("Unknown Navidrome item kind");
  return `navidrome:${kind}:${encodeURIComponent(opaqueId(id))}`;
}

export function parseItemUri(uri) {
  if (typeof uri !== "string") throw new TypeError("Invalid Navidrome URI");
  const match = /^navidrome:(song|album|playlist|artist):(.+)$/.exec(uri);
  if (!match) throw new TypeError("Invalid Navidrome URI");
  let id;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    throw new TypeError("Invalid Navidrome URI encoding");
  }
  opaqueId(id);
  if (itemUri(match[1], id) !== uri)
    throw new TypeError("Noncanonical Navidrome URI");
  return { kind: match[1], id };
}

export class NavidromeCatalog {
  constructor({ coverUrl, projectDuration } = {}) {
    if (coverUrl !== undefined && typeof coverUrl !== "function") {
      throw new TypeError("coverUrl must resolve a cover ID to an image URL");
    }
    if (
      projectDuration !== undefined &&
      typeof projectDuration !== "function"
    ) {
      throw new TypeError("projectDuration must be a function");
    }
    this.coverUrl = coverUrl;
    // PS5 runLength units are unresolved. No implicit seconds/ms conversion.
    this.projectDuration = projectDuration;
  }

  async cover(item) {
    if (typeof item.coverArt !== "string" || !item.coverArt || !this.coverUrl)
      return undefined;
    let url;
    try {
      url = await this.coverUrl(item.coverArt);
    } catch {
      throw new Error("Unable to resolve Navidrome cover URL");
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new TypeError("Cover resolver must return an HTTP(S) URL");
    }
    return url;
  }

  /** @returns {Promise<import('./contracts/catalog').LocalNavidromeHomeCard>} */
  async collection(item, kind) {
    record(item, "Navidrome collection");
    if (kind !== "album" && kind !== "playlist" && kind !== "artist") {
      throw new TypeError("Expected an album, playlist, or artist");
    }
    const id = opaqueId(item.id);
    const contextUri = itemUri(kind, id);
    return {
      id,
      name: text(item.name, "Sin título"),
      type: kind,
      cardType: kind,
      subType: kind,
      artist: artistNames(item),
      image_url: await this.cover(item),
      uri: contextUri,
      contextUri,
      trackUri: undefined,
      inLibrary: undefined,
      explicit: explicit(item),
      deeplink: undefined,
      total: count(kind === "artist" ? item.albumCount : item.songCount),
      providedName: undefined,
      serviceName: SERVICE_NAME,
    };
  }

  async section(items, { name, kind, id, index = 1 }) {
    if (!Array.isArray(items))
      throw new TypeError("Expected a collection array");
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new TypeError("Section index must be a positive integer");
    }
    const title = text(name, "Biblioteca");
    const sections = await Promise.all(
      items.map((item) => this.collection(item, kind)),
    );
    return {
      name: title,
      sections,
      serviceName: SERVICE_NAME,
      strandId: opaqueId(id),
      // Control Center #14294 derives this field from the card count.
      strandIndex: index,
      strandName: title,
      strandRows: sections.length,
    };
  }

  /** @returns {Promise<import('./contracts/catalog').LocalNavidromeTrack>} */
  async track(song, { contextUri, kind = "album", coverArt } = {}) {
    record(song, "Navidrome song");
    const id = opaqueId(song.id);
    const context = parseItemUri(contextUri);
    if (context.kind !== kind)
      throw new TypeError("Track parent kind and URI differ");
    const audio =
      song.isDir !== true &&
      song.isVideo !== true &&
      song.type !== "video" &&
      (song.contentType == null ||
        (typeof song.contentType === "string" &&
          song.contentType.startsWith("audio/")));
    const duration =
      typeof song.duration === "number" &&
      Number.isFinite(song.duration) &&
      song.duration >= 0
        ? song.duration
        : undefined;
    return {
      id,
      name: text(song.title, "Sin título"),
      type: kind,
      strandType: kind,
      itemType: "track",
      subType: kind === "album" ? "albumtrack" : "track",
      artist: artistNames(song),
      image_url: await this.cover({ coverArt: song.coverArt || coverArt }),
      context: contextUri,
      uri: itemUri("song", id),
      explicit: explicit(song),
      inLibrary: undefined,
      isPlayable: audio,
      deeplink: undefined,
      serviceName: SERVICE_NAME,
      total: undefined,
      releaseDate: undefined,
      durationSeconds: duration,
      runLength:
        duration === undefined || !this.projectDuration
          ? undefined
          : this.projectDuration(duration),
      isFullyPlayed: undefined,
      resumePosition: undefined,
      description: undefined,
      startTime: undefined,
      endTime: undefined,
    };
  }

  async collectionTracks(collection, kind, srcInfo = undefined) {
    record(collection, "Navidrome collection");
    if (kind !== "album" && kind !== "playlist")
      throw new TypeError("Expected album or playlist");
    const contextUri = itemUri(kind, collection.id);
    const songs = kind === "album" ? collection.song : collection.entry;
    if (songs !== undefined && !Array.isArray(songs))
      throw new TypeError("Invalid song array");
    return {
      srcInfo,
      tracks: await Promise.all(
        (songs || []).map((song) =>
          this.track(song, {
            contextUri,
            kind,
            coverArt: collection.coverArt,
          }),
        ),
      ),
    };
  }

  /** Resolve credentials at playback time; the catalog retains opaque URIs. */
  async resolveStream(uri, streamUrl) {
    const item = parseItemUri(uri);
    if (item.kind !== "song" || typeof streamUrl !== "function") {
      throw new TypeError("A song URI and stream resolver are required");
    }
    let url;
    try {
      url = await streamUrl(item.id);
    } catch {
      throw new Error("Unable to resolve Navidrome stream URL");
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new TypeError("Stream resolver must return an HTTP(S) URL");
    }
    return url;
  }
}

/**
 * Catalog for our local React screen before native provider registration exists.
 * Cards, sections and tracks omit serviceType entirely. All opaque identifiers,
 * session ownership and on-demand resource URL rules remain unchanged.
 */
export function createLocalNavidromeCatalog(options = {}) {
  return new NavidromeCatalog(options);
}
