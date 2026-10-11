import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalMusicScreen,
  shuffleTracks,
} from "./local-music-screen.mjs";
class Component {
  constructor(props) {
    this.props = props;
  }
  setState(update) {
    this.state = {
      ...this.state,
      ...(typeof update === "function" ? update(this.state) : update),
    };
  }
}
const Screen = createLocalMusicScreen({
  React: { Component, createElement() {} },
  native: { View: 1, Text: 1, Button: 1, TextInput: 1, FocusLayerPS: 1 },
});
const library = {
  albumSection() {},
  playlistSection() {},
  collectionTracks() {},
  resolveStream() {},
};
const disconnected = {
  state: "disconnected",
  sessionVersion: 0,
  serverUrl: "http://server:4533",
  logout() {},
};
const connected = {
  client: { ...disconnected, state: "connected", sessionVersion: 1 },
  library,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function screen(onRestore, onDisconnect) {
  const s = new Screen({
    client: disconnected,
    library,
    onLogin() {},
    onRestore,
    onDisconnect,
  });
  s.browse = () => {
    s.browsed = true;
  };
  return s;
}
test("mount restores saved login and missing saved login leaves the form usable", async () => {
  const s = screen(async () => connected);
  s.componentDidMount();
  await flush();
  assert.equal(s.state.connected, true);
  assert.equal(s.browsed, true);
  assert.equal(s.state.username, "");
  assert.equal(s._passwordValue(), "");
  const empty = screen(async () => undefined);
  empty.componentDidMount();
  await flush();
  assert.equal(empty.state.connected, false);
  assert.equal(empty.state.busy, false);
  assert.equal(empty.state.error, "");
});
test("late restored login cannot mount a session after the card closes", async () => {
  let release;
  const s = screen(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  s.componentDidMount();
  s.componentWillUnmount();
  release(connected);
  await flush();
  assert.equal(s.browsed, undefined);
  assert.equal(s.state.connected, false);
});
test("disconnect waits for deletion and reports failure without claiming the login was erased", async () => {
  let release;
  const s = screen(
    async () => connected,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  s.componentDidMount();
  await flush();
  const pending = s.disconnect();
  assert.equal(s.state.connected, true);
  release();
  await pending;
  assert.equal(s.state.connected, false);
  assert.equal(s.state.busy, false);
  const bad = screen(
    async () => connected,
    async () => {
      throw new Error("native secret");
    },
  );
  bad.componentDidMount();
  await flush();
  await bad.disconnect();
  assert.equal(bad.state.connected, true);
  assert.equal(bad.state.error, "No se pudo borrar la sesión guardada.");
});

const albums = (offset, count) =>
  Array.from({ length: count }, (_, i) => ({
    uri: `navidrome:album:${offset + i}`,
    name: `Album ${offset + i}`,
    image_url: `http://server/cover/${offset + i}`,
  }));
function catalogScreen(albumSection) {
  const client = { ...connected.client };
  const s = new Screen({ client, library: { ...library, albumSection } });
  s._alive = true;
  return s;
}
test("infinite catalog appends without disabling controls, deduplicates and ends on a short batch", async () => {
  const calls = [];
  let release;
  const s = catalogScreen(async (args) => {
    calls.push(args);
    if (args.offset === 0) return { sections: albums(0, 30) };
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await s.browse("albums");
  const pending = s.loadMore();
  s.loadMore();
  assert.equal(s.state.busy, false);
  assert.equal(s.state.loadingMore, true);
  assert.equal(calls.length, 2);
  release({ sections: [...albums(29, 1), ...albums(30, 4)] });
  await pending;
  assert.equal(s.state.rows.length, 34);
  assert.equal(s.state.more, false);
  assert.equal(s._catalogs.get("albums").offset, 35);
  assert.equal(s._covers.size, 34);
  await s.loadMore();
  assert.equal(calls.length, 2);
});
test("an in-flight catalog append cannot overwrite an album opened meanwhile", async () => {
  let release;
  const s = catalogScreen(async (args) =>
    args.offset === 0
      ? { sections: albums(0, 30) }
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  s._connection.library.collectionTracks = async () => ({
    tracks: [{ uri: "navidrome:track:1", name: "Song", isPlayable: true }],
  });
  await s.browse("albums");
  const pending = s.loadMore();
  await s.openCollection(s.state.rows[0]);
  release({ sections: albums(30, 30) });
  await pending;
  assert.equal(s.state.view, "tracks");
  assert.equal(s.state.rows[0].name, "Song");
});
test("returning to albums retains loaded covers, scroll position and focus without refetching", async () => {
  let calls = 0;
  const s = catalogScreen(async () => {
    calls++;
    return { sections: albums(0, 20) };
  });
  s._connection.library.collectionTracks = async () => ({ tracks: [] });
  await s.browse("albums");
  s._grid = { scrollTo() {} };
  s._gridHeight = 400;
  s.focusCollection(s.state.rows[15]);
  const y = s._scrollY;
  await s.openCollection(s.state.rows[15]);
  await s.browse("albums");
  assert.equal(calls, 1);
  assert.equal(s.state.focused, "item-15");
  assert.equal(s._scrollY, y);
  assert.ok(y > 0);
  assert.equal(s._covers.size, 20);
});
test("failed infinite loading preserves the visible catalog and can retry the same offset", async () => {
  let fail = true;
  const offsets = [];
  const s = catalogScreen(async (args) => {
    offsets.push(args.offset);
    if (args.offset === 0) return { sections: albums(0, 30) };
    if (fail) throw new Error("private transport error");
    return undefined;
  });
  await s.browse("albums");
  await s.loadMore();
  assert.equal(s.state.loadMoreError, true);
  assert.equal(s.state.rows.length, 30);
  fail = false;
  await s.loadMore();
  assert.deepEqual(offsets, [0, 30, 30]);
  assert.equal(s.state.more, false);
  assert.equal(s.state.loadMoreError, false);
});

const song = (i) => ({
  uri: `navidrome:song:${i}`,
  context: "navidrome:album:0",
  name: `Song ${i}`,
  isPlayable: true,
  durationSeconds: 120 + i,
});
test("a single-song album plays from the grid and preserves its scroll and selection", async () => {
  let played;
  const s = catalogScreen(async () => ({ sections: albums(0, 20) }));
  s.props.onPlay = async (request) => {
    played = request.track;
    assert.equal(await request.resolveStream(), "http://stream");
  };
  s._connection.library.resolveStream = async () => "http://stream";
  s._connection.library.collectionTracks = async () => ({ tracks: [song(1)] });
  await s.browse("albums");
  s._gridHeight = 400;
  s._grid = { scrollTo() {} };
  s.focusCollection(s.state.rows[15]);
  const y = s._scrollY;
  await s.openCollection(s.state.rows[15]);
  assert.equal(played.uri, "navidrome:song:1");
  assert.equal(s.state.view, "albums");
  assert.equal(s.state.rows.length, 20);
  assert.equal(s.state.focused, "item-15");
  assert.equal(s._scrollY, y);
  assert.equal(s.state.nowPlaying.name, "Song 1");
  assert.equal(s.state.busy, false);
  assert.equal(s._covers.size, 20);
});
test("a single-song playlist opens detail and an unavailable album track does not autoplay", async () => {
  for (const [uri, isPlayable] of [
    ["navidrome:playlist:one", true],
    ["navidrome:album:one", false],
  ]) {
    const s = catalogScreen(async () => ({ sections: albums(0, 1) }));
    let plays = 0;
    s.props.onPlay = async () => {
      plays++;
    };
    s._connection.library.collectionTracks = async () => ({
      tracks: [{ ...song(1), isPlayable }],
    });
    await s.openCollection({ uri, name: "One" });
    assert.equal(s.state.view, "tracks");
    assert.equal(plays, 0);
  }
});
test("single-song playback failure keeps the album grid and shows the retryable error", async () => {
  const s = catalogScreen(async () => ({ sections: albums(0, 1) }));
  s.props.onPlay = async () => {
    throw new Error("private response");
  };
  s._connection.library.collectionTracks = async () => ({ tracks: [song(1)] });
  await s.browse("albums");
  await s.openCollection(s.state.rows[0]);
  assert.equal(s.state.view, "albums");
  assert.equal(s.state.error, "No se pudo reproducir");
  assert.equal(s.state.busy, false);
});
test("closing while a single-song album loads cannot start playback", async () => {
  let release,
    plays = 0;
  const s = catalogScreen(async () => ({ sections: albums(0, 1) }));
  s.props.onPlay = async () => {
    plays++;
  };
  s._connection.library.collectionTracks = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await s.browse("albums");
  const pending = s.openCollection(s.state.rows[0]);
  s.componentWillUnmount();
  release({ tracks: [song(1)] });
  await pending;
  assert.equal(plays, 0);
});
test("album detail exposes all songs with durations and plays a song beyond the former page", async () => {
  const s = catalogScreen(async () => ({ sections: albums(0, 1) }));
  let played;
  s.props.onPlay = async ({ track }) => {
    played = track;
  };
  s._connection.library.collectionTracks = async () => ({
    tracks: Array.from({ length: 12 }, (_, i) => song(i)),
  });
  await s.browse("albums");
  await s.openCollection(s.state.rows[0]);
  assert.equal(s.state.rows.length, 12);
  assert.equal(s.state.rows[11].durationSeconds, 131);
  assert.equal(s.state.more, false);
  await s.play(s.state.rows[11]);
  assert.equal(played.uri, "navidrome:song:11");
});
test("grid and detail render with native scroll containers", async () => {
  const h = (type, props, ...children) => ({ type, props, children });
  const RenderScreen = createLocalMusicScreen({
    React: { Component, createElement: h },
    native: {
      View: "view",
      Text: "text",
      Button: "button",
      TextInput: "input",
      FocusLayerPS: "focus",
      ScrollView: "scroll",
    },
  });
  const s = new RenderScreen({
    client: { ...connected.client },
    library: {
      ...library,
      albumSection: async () => ({ sections: albums(0, 2) }),
      collectionTracks: async () => ({ tracks: [song(0), song(1)] }),
    },
  });
  s._alive = true;
  await s.browse("albums");
  assert.ok(s.render());
  await s.openCollection(s.state.rows[0]);
  assert.equal(s.renderTracks().type, "focus");
  assert.equal(s.renderTracks().children[0].type, "scroll");
  assert.ok(s.render());
});

test("direct single playback cancels a pending catalog append without leaving its loading indicator", async () => {
  let release;
  const s = catalogScreen(async (args) =>
    args.offset === 0
      ? { sections: albums(0, 30) }
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  s.props.onPlay = async () => {};
  s._connection.library.collectionTracks = async () => ({ tracks: [song(1)] });
  await s.browse("albums");
  const pending = s.loadMore();
  await s.openCollection(s.state.rows[0]);
  release({ sections: albums(30, 30) });
  await pending;
  assert.equal(s.state.view, "albums");
  assert.equal(s.state.rows.length, 30);
  assert.equal(s.state.loadingMore, false);
});

test("the selected song remains fully visible when the player shrinks the track list", async () => {
  const h = (type, props, ...children) => ({ type, props, children });
  const RenderScreen = createLocalMusicScreen({
    React: { Component, createElement: h },
    native: {
      View: "view",
      Text: "text",
      Button: "button",
      TextInput: "input",
      FocusLayerPS: "focus",
      ScrollView: "scroll",
    },
  });
  const s = new RenderScreen({
    client: { ...connected.client },
    library: { ...library },
  });
  s._alive = true;
  s.state = {
    ...s.state,
    view: "tracks",
    collection: { uri: "navidrome:album:0" },
    rows: Array.from({ length: 10 }, (_, index) => ({ ...song(index), index })),
    focused: "item-4",
  };
  let y;
  s._trackList = {
    scrollTo(args) {
      y = args.y;
    },
  };
  s._trackY = 0;
  s.renderTracks().children[0].props.onLayout({
    nativeEvent: { layout: { height: 240 } },
  });
  assert.ok(y > 0);
  assert.ok(4 * 84 + 80 <= y + 240 - 72);
});

test("controller navigation skips unavailable songs, recovers container focus and leaves the list at its edges", () => {
  const s = catalogScreen(async () => ({ sections: [] }));
  s.props.onPlay = async () => {};
  s.state = {
    ...s.state,
    view: "tracks",
    rows: [
      { ...song(0), index: 0 },
      { ...song(1), index: 1, isPlayable: false },
      { ...song(2), index: 2 },
    ],
  };
  const focused = [];
  for (const key of ["track-0", "track-2", "album-play", "audio-pause"])
    s._coverRefs.set(key, {
      focus() {
        focused.push(key);
      },
    });
  assert.equal(s.moveTrack(1), true);
  assert.equal(s.state.focused, "item-0");
  assert.equal(s.moveTrack(1, 0), true);
  assert.equal(s.state.focused, "item-2");
  assert.equal(s.moveTrack(-1, 2), true);
  assert.equal(s.state.focused, "item-0");
  assert.equal(s.moveTrack(-1, 0), true);
  assert.equal(focused.at(-1), "album-play");
  assert.equal(s.moveTrack(1, 2), true);
  assert.equal(focused.at(-1), "audio-pause");
  s._busy = true;
  assert.equal(s.moveTrack(1), false);
});
test("L1 and R1 activate library tabs and ignore login/account screens", async () => {
  const s = catalogScreen(async () => ({ sections: albums(0, 2) }));
  s._connection.library.playlistSection = async () => ({
    sections: [{ uri: "navidrome:playlist:0", name: "List" }],
  });
  assert.equal(s.switchTab("playlists"), true);
  await flush();
  assert.equal(s.state.view, "playlists");
  assert.equal(s.switchTab("albums"), true);
  await flush();
  assert.equal(s.state.view, "albums");
  s.state.accountOpen = true;
  assert.equal(s.switchTab("playlists"), false);
  assert.equal(s.state.view, "albums");
  s.state.accountOpen = false;
  s.state.connected = false;
  assert.equal(s.switchTab("playlists"), false);
});

test("grid Down selects the next row even when its cover is outside the viewport", () => {
  const s = catalogScreen(async () => ({ sections: [] }));
  s.state = {
    ...s.state,
    view: "albums",
    rows: albums(0, 12).map((item, index) => ({ ...item, index })),
  };
  let focused, y;
  s._gridHeight = 250;
  s._grid = {
    scrollTo(args) {
      y = args.y;
    },
  };
  s._coverRefs.set("item-8", {
    focus() {
      focused = 8;
    },
  });
  assert.equal(s.moveCollection(1, 3), true);
  assert.equal(focused, 8);
  assert.equal(s.state.focused, "item-8");
  assert.ok(y > 0);
  s._coverRefs.set("item-11", {
    focus() {
      focused = 11;
    },
  });
  assert.equal(s.moveCollection(1, 8), true);
  assert.equal(focused, 11);
  assert.equal(s.moveCollection(1, 11), true);
  assert.equal(s.moveCollection(-1, 0), false);
});
test("album Play sends all playable songs in order with display metadata only", async () => {
  const s = catalogScreen(async () => ({ sections: [] }));
  let request;
  s.props.onPlay = async (value) => {
    request = value;
  };
  s._connection.library.collectionTracks = async () => ({
    tracks: [song(0), { ...song(1), isPlayable: false }, song(2)],
  });
  await s.openCollection({ uri: "navidrome:album:0", name: "Album" });
  await s.play(s.state.rows[0], true);
  assert.deepEqual(
    request.tracks.map((track) => track.uri),
    [song(0).uri, song(2).uri],
  );
  assert.equal(
    request.tracks.some((track) => "image_url" in track),
    false,
  );
});

test("playlist Play retains its returned track order and shuffle keeps every playable song once", async () => {
  const s = catalogScreen(async () => ({ sections: [] }));
  const calls = [];
  s.props.onPlay = async (value) => {
    calls.push(value);
  };
  s._connection.library.collectionTracks = async () => ({
    tracks: [song(3), { ...song(7), isPlayable: false }, song(1), song(2)],
  });
  await s.openCollection({ uri: "navidrome:playlist:0", name: "List" });
  await s.play(s.state.rows[0], true);
  assert.deepEqual(
    calls[0].tracks.map((track) => track.uri),
    [song(3).uri, song(1).uri, song(2).uri],
  );
  await s.play(s.state.rows[0], "shuffle");
  assert.deepEqual(
    calls[1].tracks.map((track) => track.uri).sort(),
    calls[0].tracks.map((track) => track.uri).sort(),
  );
  assert.equal(calls[1].track.uri, calls[1].tracks[0].uri);
  assert.equal(s.state.nowPlaying.uri, calls[1].tracks[0].uri);
  assert.deepEqual(
    s.state.rows.map((track) => track.uri),
    [song(3).uri, song(7).uri, song(1).uri, song(2).uri],
  );
});
test("shuffle creates a separate permutation and handles singleton collections", () => {
  const tracks = [song(0), song(1), song(2)];
  assert.deepEqual(
    shuffleTracks(tracks, () => 0).map((track) => track.uri),
    [song(1).uri, song(2).uri, song(0).uri],
  );
  assert.deepEqual(
    tracks.map((track) => track.uri),
    [song(0).uri, song(1).uri, song(2).uri],
  );
  assert.deepEqual(shuffleTracks([song(0)]), [song(0)]);
  assert.deepEqual(shuffleTracks([]), []);
});
