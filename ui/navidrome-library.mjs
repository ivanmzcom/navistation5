/** Local client/catalog composition. No ShellUI calls or provider registration. */
import { NavidromeCatalog, createLocalNavidromeCatalog, parseItemUri } from "./navidrome-catalog.mjs";

function createLibrary({ client, nativeServiceType, projectDuration,
  coverSize, streamFormat, streamMaxBitRate }, local) {
  if (!client || !["getAlbumList2", "getPlaylists", "getAlbum", "getPlaylist", "streamUrl", "coverArtUrl"]
    .every(name => typeof client[name] === "function")) {
    throw new TypeError("An OpenSubsonic client is required");
  }
  const catalogOptions = { nativeServiceType, projectDuration,
    coverUrl: id => client.coverArtUrl(id, { size: coverSize }) };
  const catalog = local ? createLocalNavidromeCatalog(catalogOptions) : new NavidromeCatalog(catalogOptions);

  function session() {
    if (client.state !== "connected" || !Number.isSafeInteger(client.sessionVersion)) {
      throw new Error("Connect to Navidrome first");
    }
    return client.sessionVersion;
  }

  function assertSession(expected) {
    if (session() !== expected) throw new Error("Navidrome session has changed");
  }

  return Object.freeze({
    async albumSection({ type = "newest", size = 100, offset = 0,
      name = "Álbumes", index = 1 } = {}) {
      const expected = session();
      const items = await client.getAlbumList2({ type, size, offset });
      assertSession(expected);
      if (!items.length) return undefined;
      const result = await catalog.section(items, { name, kind: "album", id: `albums:${type}:${offset}`, index });
      assertSession(expected);
      return result;
    },

    async playlistSection({ name = "Listas", index = 1 } = {}) {
      const expected = session();
      const items = await client.getPlaylists();
      assertSession(expected);
      if (!items.length) return undefined;
      const result = await catalog.section(items, { name, kind: "playlist", id: "playlists", index });
      assertSession(expected);
      return result;
    },

    async collectionTracks(uri, srcInfo) {
      const expected = session();
      const { kind, id } = parseItemUri(uri);
      if (kind !== "album" && kind !== "playlist") {
        throw new TypeError("An album or playlist URI is required");
      }
      const item = kind === "album" ? await client.getAlbum(id) : await client.getPlaylist(id);
      assertSession(expected);
      if (item.id !== id) throw new Error("Navidrome returned a different collection");
      const result = await catalog.collectionTracks(item, kind, srcInfo);
      assertSession(expected);
      return result;
    },

    async resolveStream(uri) {
      const expected = session();
      const result = await catalog.resolveStream(uri, id => client.streamUrl(id,
        { format: streamFormat, maxBitRate: streamMaxBitRate }));
      assertSession(expected);
      return result;
    },
  });
}

/** Provider-facing models require an established, distinct nativeServiceType. */
export function createNavidromeLibrary(options = {}) {
  return createLibrary(options, false);
}

/**
 * Local-screen catalog only; no nativeServiceType, title ID or registration.
 * The same four library methods return models without a serviceType property.
 * resolveStream still only generates a fresh URL; an actual player is optional
 * and supplied separately to LocalMusic via onPlay.
 */
export function createLocalNavidromeLibrary(options = {}) {
  return createLibrary(options, true);
}
