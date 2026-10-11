import { createTranslator } from "./i18n.mjs";
import { DEFAULT_SERVER_URL } from "./navidrome-catalog.mjs";

const TRACK_HEIGHT = 80;
const COLLECTION_PAGE_SIZE = 30;
const GRID_COLUMNS = 5;
const TILE_SIZE = 180;
const ROW_HEIGHT = TILE_SIZE + 12;
// Survives screen remounts only while this audio owner and login session survive.
// Values contain display metadata and opaque catalog IDs, never artwork URLs.
const playingByAudio = new WeakMap();
// Layout stays inside the captured Music card (~1040x810 at 1080p). Font sizes
// come exclusively from MESJr5x+ / FontSizePS; no guessed native font numbers.
const styles = {
  screen: { flex: 1, padding: 24, backgroundColor: "#111111" },
  row: { flexDirection: "row", alignItems: "center" },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  brand: { color: "#ffffff", flex: 1 },
  accountButton: { width: 220, height: 40 },
  title: { color: "#ffffff", marginBottom: 4 },
  note: { color: "#a7a7a7" },
  hero: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  heroCopy: { flex: 1, marginLeft: 24 },
  albumActions: { flexDirection: "row", marginTop: 12 },
  albumPlay: { width: 240, height: 44, marginRight: 12 },
  track: {
    height: TRACK_HEIGHT,
    marginBottom: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
  trackContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
  },
  trackNumber: { width: 40, color: "#a7a7a7" },
  trackCopy: { flex: 1, marginRight: 16 },
  trackTime: { color: "#a7a7a7", width: 64, textAlign: "right" },
  tabs: { flexDirection: "row", marginBottom: 16 },
  navigation: { width: 240, height: 44, marginRight: 12 },
  button: { height: 44 },
  selectedTab: {
    backgroundColor: "#303030",
    borderColor: "#ffffff",
    borderWidth: 2,
  },
  body: { flex: 1 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: "#111111",
    borderRadius: 8,
  },
  coverButton: {
    position: "absolute",
    top: 0,
    left: 0,
    width: TILE_SIZE - 4,
    height: TILE_SIZE - 4,
  },
  selection: { color: "#ffffff", marginBottom: 12 },
  focused: { backgroundColor: "#292929", borderColor: "#ffffff" },
  art: {
    backgroundColor: "#303030",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 6,
  },
  coverText: { color: "#a7a7a7" },
  player: {
    backgroundColor: "#252525",
    padding: 14,
    borderRadius: 8,
    marginTop: 12,
  },
  playerCopy: { flex: 1, marginLeft: 14, marginRight: 16 },
  playerButton: { width: 240, height: 44, marginLeft: 8 },
  progress: { height: 3, backgroundColor: "#505050", marginTop: 12 },
  progressFill: { height: 3, backgroundColor: "#ffffff" },
  time: { color: "#a7a7a7", marginTop: 6 },
  notice: { color: "#ffb5b5", marginBottom: 10 },
  login: { flex: 1, padding: 20, backgroundColor: "#191919", borderRadius: 8 },
  input: { height: 48, marginBottom: 14, color: "#ffffff" },
  account: { flex: 1, paddingTop: 24 },
  accountAction: { width: 280, height: 44, marginTop: 20 },
};

function clockTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
    return "";
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function shuffleTracks(tracks, random = Math.random) {
  const shuffled = tracks.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const saved = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = saved;
  }
  return shuffled;
}

function controlUnavailable(playback) {
  return (
    (["native-mediafw", "resident-mediafw"].includes(playback?.audioBackend) &&
      playback.hostReachable === false) ||
    ["ND_AUDIO_HOST_UNAVAILABLE", "ND_AUDIO_CONTROL_TIMEOUT"].includes(
      playback?.errorCode,
    )
  );
}

function hasLibrary(library) {
  return (
    !!library &&
    [
      "albumSection",
      "playlistSection",
      "collectionTracks",
      "resolveStream",
    ].every((name) => typeof library[name] === "function")
  );
}

function canConnect(props) {
  return (
    typeof props.onLogin === "function" ||
    !!(
      props.client &&
      typeof props.client.login === "function" &&
      typeof props.client.logout === "function" &&
      typeof props.client.serverUrl === "string" &&
      hasLibrary(props.library)
    )
  );
}

function ready(connection) {
  return (
    connection &&
    connection.client &&
    connection.client.state === "connected" &&
    Number.isSafeInteger(connection.client.sessionVersion) &&
    typeof connection.client.serverUrl === "string" &&
    typeof connection.client.logout === "function" &&
    hasLibrary(connection.library)
  );
}

// React state holds display metadata and catalog IDs; artwork URLs stay in the cache.
function row(item, index, untitled = "Sin título") {
  if (!item || typeof item.uri !== "string") throw new Error("Invalid catalog");
  return {
    uri: item.uri,
    name: typeof item.name === "string" ? item.name : untitled,
    artist: typeof item.artist === "string" ? item.artist : "",
    index,
    isPlayable: item.isPlayable === true,
    durationSeconds:
      typeof item.durationSeconds === "number" &&
      Number.isFinite(item.durationSeconds) &&
      item.durationSeconds >= 0
        ? item.durationSeconds
        : undefined,
  };
}

// Login callbacks must discard credentials and honor isCurrent() after awaits.
// Playback resolves the stream URL only when the player is ready to use it.
export function createLocalMusicScreen({ React, native } = {}) {
  if (
    !React ||
    typeof React.Component !== "function" ||
    typeof React.createElement !== "function"
  ) {
    throw new TypeError("React unavailable");
  }
  if (
    !native ||
    ["View", "Text", "Button", "TextInput", "FocusLayerPS"].some(
      (name) => !native[name],
    )
  ) {
    throw new TypeError("Native components unavailable");
  }
  const { View, Text, Button, TextInput, FocusLayerPS, Image, ScrollView } =
    native;
  const h = React.createElement;
  const font = (name) => {
    const value = native.FontSizePS?.[name];
    return value === undefined ? {} : { fontSize: value };
  };

  return class LocalMusic extends React.Component {
    constructor(props) {
      super(props);
      this.t = createTranslator(props.locale);
      this._togglePlayback = () => {
        const playback = this.state.playback;
        if (
          !this._alive ||
          !this.state.connected ||
          !this.props.audio ||
          !playback?.available ||
          !["playing", "paused"].includes(playback.phase)
        )
          return false;
        if (
          this._togglePending ||
          Date.now() - (this._lastToggle || 0) < 300 ||
          playback.pending ||
          playback.stopPending ||
          controlUnavailable(playback) ||
          playback.controlsAvailable === false
        )
          return true;
        this._lastToggle = Date.now();
        this._togglePending = true;
        this.audioControl(
          playback.phase === "paused" ? "resume" : "pause",
        ).finally(() => {
          this._togglePending = false;
        });
        return true;
      };
      this._openAccount = () => {
        if (!this._alive || !this.state.connected) return false;
        if (!this._busy && !this.state.accountOpen)
          this.setState({ accountOpen: true });
        return true;
      };
      this._stopPlayback = () => {
        const playback = this.state.playback;
        if (
          !this._alive ||
          !this.state.connected ||
          !this.props.audio ||
          !playback?.available ||
          (playback.phase === "idle" &&
            !playback.pending &&
            !playback.stopPending)
        )
          return false;
        if (
          this._stopPending ||
          Date.now() - (this._lastStop || 0) < 300 ||
          playback.stopPending ||
          controlUnavailable(playback) ||
          playback.controlsAvailable === false
        )
          return true;
        this._lastStop = Date.now();
        this._stopPending = true;
        this.audioControl("stopPlayback").finally(() => {
          this._stopPending = false;
        });
        return true;
      };
      this.catalogRow = (item, index) => row(item, index, this.t("untitled"));
      this._connection = { client: props.client, library: props.library };
      const previous = playingByAudio.get(props.audio);
      const sameSession =
        previous &&
        ready(this._connection) &&
        previous.client === props.client &&
        previous.version === props.client.sessionVersion;
      if (previous && !sameSession) playingByAudio.delete(props.audio);
      this._alive = false;
      this._request = 0;
      this._busy = false;
      this._items = [];
      this._covers = new Map();
      this._catalogs = new Map();
      this._coverRefs = new Map();
      this._coverRefCallbacks = new Map();
      this._scrollY = 0;
      this._gridHeight = 0;
      this._bindGrid = (ref) => {
        this._grid = ref;
      };
      this._bindTracks = (ref) => {
        this._trackList = ref;
      };
      this._trackY = 0;
      this._trackHeight = 0;
      this._pendingClient = undefined;
      // Keep the editable password outside React state and diagnostics.
      let password = "";
      this._passwordValue = () => password;
      this._passwordChanged = (text) => {
        if (!canConnect(this.props)) password = "";
        else if (!this._busy) password = typeof text === "string" ? text : "";
      };
      this._takePassword = () => {
        const value = password;
        password = "";
        return value;
      };
      this.state = {
        serverUrl: props.client?.serverUrl || DEFAULT_SERVER_URL,
        username: "",
        connected: ready(this._connection),
        view: "home",
        rows: [],
        more: false,
        busy: false,
        loadingMore: false,
        loadMoreError: false,
        error: "",
        credentialWarning: "",
        passwordKey: 0,
        focused: "",
        gridRow: 0,
        accountOpen: false,
        collection: undefined,
        nowPlaying: sameSession ? previous.track : undefined,
        playback:
          props.audio && typeof props.audio.status === "function"
            ? props.audio.status()
            : undefined,
      };
    }

    componentDidMount() {
      this._alive = true;
      if (ready(this._connection)) this.browse("albums");
      else if (typeof this.props.onRestore === "function") this.connect(true);
      const audio = this.props.audio;
      if (audio && typeof audio.subscribe === "function") {
        this._unsubscribeAudio = audio.subscribe((playback) => {
          if (this._alive) {
            const nowPlaying = playback.currentTrack;
            if (nowPlaying && ready(this._connection))
              playingByAudio.set(this.props.audio, {
                client: this._connection.client,
                version: this._connection.client.sessionVersion,
                track: nowPlaying,
              });
            this.setState({ playback, ...(nowPlaying ? { nowPlaying } : {}) });
          }
        });
        // Same session/owner on reopening; Status never claims or starts audio.
        audio.refresh().catch(() => undefined);
      }
    }

    componentDidUpdate(previousProps) {
      if (canConnect(previousProps) && !canConnect(this.props)) {
        this._takePassword();
        this.setState((state) => ({ passwordKey: state.passwordKey + 1 }));
      }
    }

    componentWillUnmount() {
      this._alive = false;
      if (this._unsubscribeAudio) this._unsubscribeAudio();
      this._unsubscribeAudio = undefined;
      this._request++;
      this._takePassword();
      this._items = [];
      this._covers.clear();
      this._catalogs.clear();
      // Cancel our pending login. An established externally owned session survives
      // closing Music; explicit Disconnect clears it. onLogin owns its async work.
      if (this._pendingClient) this._pendingClient.logout();
      this._pendingClient = undefined;
      this._connection = undefined;
    }

    _begin() {
      if (!this._alive || this._busy) return undefined;
      this._busy = true;
      this._loadMoreToken = undefined;
      const id = ++this._request;
      this.setState({
        busy: true,
        loadingMore: false,
        loadMoreError: false,
        error: "",
      });
      return id;
    }

    _finish(id, patch) {
      if (!this._alive || id !== this._request) return;
      this._busy = false;
      this.setState({ busy: false, ...patch });
    }

    _session() {
      if (!ready(this._connection)) throw new Error("Disconnected");
      return {
        ...this._connection,
        version: this._connection.client.sessionVersion,
      };
    }

    _current(id, session) {
      return (
        this._alive &&
        id === this._request &&
        this._connection?.client === session.client &&
        session.client.state === "connected" &&
        session.client.sessionVersion === session.version
      );
    }

    _expire(id) {
      if (!this._alive || id !== this._request) return;
      playingByAudio.delete(this.props.audio);
      this._items = [];
      this._covers.clear();
      this._catalogs.clear();
      this._connection = undefined;
      this._finish(id, {
        connected: false,
        rows: [],
        view: "home",
        collection: undefined,
        nowPlaying: undefined,
        error: this.t("reconnect"),
      });
    }

    _rememberCovers(items, collection, preserve = false) {
      const keep = new Set([this.state.nowPlaying?.uri, collection?.uri]);
      if (!preserve)
        this._covers.forEach((url, key) => {
          if (!keep.has(key)) this._covers.delete(key);
        });
      items.forEach((item) => {
        if (
          typeof item?.uri === "string" &&
          typeof item.image_url === "string" &&
          /^https?:\/\//i.test(item.image_url)
        ) {
          this._covers.set(item.uri, item.image_url);
          if (item.uri === this.state.nowPlaying?.albumUri)
            this._covers.set(this.state.nowPlaying.uri, item.image_url);
        }
      });
    }

    async connect(restore = false) {
      if (!canConnect(this.props)) {
        this._takePassword();
        if (this._alive)
          this.setState({ error: this.t("connectionUnavailable") });
        return;
      }
      const id = this._begin();
      if (id === undefined) return;
      playingByAudio.delete(this.props.audio);
      const credentials = {
        serverUrl:
          typeof this.state.serverUrl === "string"
            ? this.state.serverUrl.trim()
            : "",
        username: this.state.username,
        password: this._passwordValue(),
        isCurrent: () => this._alive && id === this._request,
      };
      this._items = [];
      this._covers.clear();
      this._catalogs.clear();
      this.setState({ rows: [], connected: false });
      try {
        let connection;
        if (restore) {
          connection = await this.props.onRestore({
            isCurrent: credentials.isCurrent,
          });
          if (!connection) {
            this._finish(id, { connected: false });
            return;
          }
        } else if (typeof this.props.onLogin === "function") {
          connection = await this.props.onLogin(credentials);
        } else {
          const client = this.props.client;
          if (
            !client ||
            typeof client.login !== "function" ||
            typeof client.logout !== "function" ||
            typeof client.serverUrl !== "string" ||
            credentials.serverUrl.replace(/\/+$/, "") !==
              client.serverUrl.replace(/\/+$/, "")
          ) {
            throw new Error("Invalid session");
          }
          this._pendingClient = client;
          await client.login({
            username: credentials.username,
            password: credentials.password,
          });
          connection = { client, library: this.props.library };
        }
        if (!credentials.isCurrent()) return;
        connection = connection || {
          client: this.props.client,
          library: this.props.library,
        };
        if (!ready(connection)) throw new Error("Invalid session");
        this._connection = connection;
        this._takePassword();
        this._finish(id, {
          connected: true,
          view: "home",
          serverUrl: connection.client.serverUrl,
          rows: [],
          credentialWarning: connection.rememberFailed
            ? this.t("saveFailed")
            : "",
        });
        this.browse("albums");
      } catch (error) {
        if (credentials.isCurrent()) {
          const code = error && Object.getOwnPropertyDescriptor(error, "code");
          const authenticationRejected =
            code && "value" in code && code.value === "NDAUTH_40";
          this._finish(id, {
            connected: false,
            error: authenticationRejected
              ? this.t("credentialsRejected")
              : this.t("connectFailed"),
          });
        }
      } finally {
        credentials.password = "";
        this._pendingClient = undefined;
      }
    }

    async disconnect() {
      const id = this._begin();
      if (id === undefined) return;
      try {
        if (typeof this.props.onDisconnect === "function")
          await this.props.onDisconnect();
        else this._connection?.client?.logout();
      } catch {
        this._finish(id, { error: this.t("forgetFailed") });
        return;
      }
      playingByAudio.delete(this.props.audio);
      this._takePassword();
      this._items = [];
      this._covers.clear();
      this._catalogs.clear();
      this._finish(id, {
        connected: false,
        accountOpen: false,
        view: "home",
        rows: [],
        error: "",
        credentialWarning: "",
        passwordKey: this.state.passwordKey + 1,
        username: "",
        more: false,
        collection: undefined,
        nowPlaying: undefined,
      });
    }

    async browse(kind) {
      const id = this._begin();
      if (id === undefined) return;
      this._loadMoreToken = undefined;
      try {
        const session = this._session();
        let catalog = this._catalogs.get(kind);
        if (
          !catalog ||
          catalog.client !== session.client ||
          catalog.version !== session.version
        ) {
          const section =
            kind === "albums"
              ? await session.library.albumSection({
                  type: "alphabeticalByName",
                  size: COLLECTION_PAGE_SIZE,
                  offset: 0,
                })
              : await session.library.playlistSection();
          if (!this._current(id, session)) return;
          const items = section ? section.sections : [];
          if (!Array.isArray(items)) throw new Error("Invalid catalog");
          catalog = {
            client: session.client,
            version: session.version,
            items,
            offset: items.length,
            more: kind === "albums" && items.length === COLLECTION_PAGE_SIZE,
            scrollY: 0,
            focused: "",
          };
          this._catalogs.set(kind, catalog);
        }
        this._scrollY = catalog.scrollY;
        this._restoreGridY = catalog.scrollY;
        this._restoreFocusKey = catalog.focused || undefined;
        this._rememberCovers(catalog.items);
        this._finish(id, {
          view: kind,
          rows: catalog.items.map(this.catalogRow),
          collection: undefined,
          focused: catalog.focused,
          gridRow: Math.floor(catalog.scrollY / ROW_HEIGHT),
          more: catalog.more,
          loadingMore: false,
          loadMoreError: false,
        });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: this.t("loadFailed") });
      }
    }

    async loadMore() {
      const kind = this.state.view,
        catalog = this._catalogs.get(kind);
      if (
        !this._alive ||
        this._busy ||
        this._loadMoreToken ||
        kind !== "albums" ||
        !catalog?.more
      )
        return;
      const token = {},
        id = this._request;
      this._loadMoreToken = token;
      this.setState({ loadingMore: true, loadMoreError: false });
      try {
        const session = this._session();
        const section = await session.library.albumSection({
          type: "alphabeticalByName",
          size: COLLECTION_PAGE_SIZE,
          offset: catalog.offset,
        });
        if (
          !this._current(id, session) ||
          this._loadMoreToken !== token ||
          this.state.view !== kind
        )
          return;
        const items = section ? section.sections : [];
        if (!Array.isArray(items)) throw new Error("Invalid catalog");
        const known = new Set(catalog.items.map((item) => item.uri));
        const added = items.filter((item) => {
          row(item, 0);
          if (known.has(item.uri)) return false;
          known.add(item.uri);
          return true;
        });
        catalog.items = catalog.items.concat(added);
        catalog.offset += items.length;
        catalog.more = items.length === COLLECTION_PAGE_SIZE;
        this._rememberCovers(catalog.items);
        this.setState({
          rows: catalog.items.map(this.catalogRow),
          more: catalog.more,
          loadingMore: false,
        });
      } catch {
        if (
          this._alive &&
          id === this._request &&
          this._loadMoreToken === token
        ) {
          if (!ready(this._connection)) this._expire(id);
          else this.setState({ loadingMore: false, loadMoreError: true });
        }
      } finally {
        if (this._loadMoreToken === token) this._loadMoreToken = undefined;
      }
    }

    coverRef(key) {
      if (!this._coverRefCallbacks.has(key))
        this._coverRefCallbacks.set(key, (ref) => {
          if (ref) this._coverRefs.set(key, ref);
          else this._coverRefs.delete(key);
        });
      return this._coverRefCallbacks.get(key);
    }

    gridLayout(event) {
      const height = event?.nativeEvent?.layout?.height;
      if (typeof height === "number" && Number.isFinite(height) && height > 0)
        this._gridHeight = height;
      if (this._restoreGridY !== undefined && this._grid) {
        const y = this._restoreGridY;
        this._restoreGridY = undefined;
        this._grid.scrollTo({ y, animated: false });
      }
      if (this._restoreFocusKey) {
        const ref = this._coverRefs.get(this._restoreFocusKey);
        this._restoreFocusKey = undefined;
        if (typeof ref?.focus === "function") ref.focus();
      }
    }

    moveCollection(direction, index) {
      if (
        !this._alive ||
        this._busy ||
        !["albums", "playlists"].includes(this.state.view)
      )
        return false;
      let next = index + direction * GRID_COLUMNS;
      if (next < 0) return false;
      if (next >= this.state.rows.length) {
        if (this.state.more) this.loadMore();
        const rowStart = (Math.floor(index / GRID_COLUMNS) + 1) * GRID_COLUMNS;
        if (rowStart >= this.state.rows.length) return true;
        next = this.state.rows.length - 1;
      }
      const item = this.state.rows[next],
        ref = this._coverRefs.get(`item-${next}`);
      if (typeof ref?.focus !== "function") return true;
      this.focusCollection(item);
      ref.focus();
      return true;
    }

    focusCollection(item) {
      if (!this._alive) return;
      const key = `item-${item.index}`,
        catalog = this._catalogs.get(this.state.view);
      this.setState({ focused: key });
      if (catalog) catalog.focused = key;
      const top = Math.floor(item.index / GRID_COLUMNS) * ROW_HEIGHT;
      if (
        this._gridHeight > 0 &&
        this._grid &&
        typeof this._grid.scrollTo === "function"
      ) {
        const y =
          top < this._scrollY
            ? top
            : top + TILE_SIZE > this._scrollY + this._gridHeight
              ? top + TILE_SIZE - this._gridHeight
              : this._scrollY;
        if (y !== this._scrollY) {
          this._scrollY = y;
          this._grid.scrollTo({ y, animated: false });
        }
        if (catalog) catalog.scrollY = this._scrollY;
        const gridRow = Math.floor(this._scrollY / ROW_HEIGHT);
        if (gridRow !== this.state.gridRow) this.setState({ gridRow });
      }
      if (item.index >= this.state.rows.length - GRID_COLUMNS * 2)
        this.loadMore();
    }

    gridScroll(event) {
      const detail = event?.nativeEvent,
        y = detail?.contentOffset?.y;
      if (typeof y !== "number" || !Number.isFinite(y)) return;
      this._scrollY = Math.max(0, y);
      const catalog = this._catalogs.get(this.state.view);
      if (catalog) catalog.scrollY = this._scrollY;
      const gridRow = Math.floor(this._scrollY / ROW_HEIGHT);
      if (gridRow !== this.state.gridRow) this.setState({ gridRow });
      const height = detail.contentSize?.height,
        viewport = detail.layoutMeasurement?.height;
      if (
        typeof height === "number" &&
        typeof viewport === "number" &&
        height - y - viewport < ROW_HEIGHT * 2
      )
        this.loadMore();
    }

    async openCollection(item) {
      const id = this._begin();
      if (id === undefined) return;
      try {
        const session = this._session();
        const result = await session.library.collectionTracks(item.uri);
        if (!this._current(id, session)) {
          this._expire(id);
          return;
        }
        if (!Array.isArray(result.tracks)) throw new Error("Invalid catalog");
        if (
          item.uri.startsWith("navidrome:album:") &&
          result.tracks.length === 1 &&
          result.tracks[0].isPlayable === true &&
          typeof this.props.onPlay === "function"
        ) {
          this._rememberCovers(result.tracks, item, true);
          await this._playTrack(result.tracks[0], 0, id, session);
          return;
        }
        this._rememberCovers(result.tracks, item);
        this._items = result.tracks;
        this._trackY = 0;
        const first = result.tracks.findIndex(
          (track) => track.isPlayable === true,
        );
        this._restoreTrackFocus = first < 0 ? undefined : `track-${first}`;
        this._finish(id, {
          view: "tracks",
          collection: item,
          focused: "",
          rows: result.tracks.map(this.catalogRow),
          more: false,
        });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: this.t("loadFailed") });
      }
    }

    async play(item, wholeCollection = false) {
      if (typeof this.props.onPlay !== "function" || !item.isPlayable) return;
      const id = this._begin();
      if (id === undefined) return;
      let session;
      try {
        session = this._session();
      } catch {
        this._expire(id);
        return;
      }
      let tracks = wholeCollection
        ? this._items.map(this.catalogRow).filter((track) => track.isPlayable)
        : undefined;
      if (wholeCollection === "shuffle") tracks = shuffleTracks(tracks);
      const first = tracks?.[0] || item;
      const track = this._items[first.index];
      if (!track || track.uri !== first.uri) {
        this._finish(id, { error: this.t("playFailed") });
        return;
      }
      return this._playTrack(track, first.index, id, session, tracks);
    }

    async _playTrack(track, index, id, session, tracks) {
      try {
        await this.props.onPlay({
          track,
          ...(tracks ? { tracks } : {}),
          client: session.client,
          library: session.library,
          isCurrent: () => this._current(id, session),
          resolveStream: async () => {
            if (!this._current(id, session)) throw new Error("Stale request");
            const url = await session.library.resolveStream(track.uri);
            if (!this._current(id, session)) throw new Error("Stale request");
            return url;
          },
        });
        if (!this._current(id, session)) return;
        const nowPlaying = {
          ...this.catalogRow(track, index),
          albumUri:
            typeof track.context === "string" &&
            track.context.startsWith("navidrome:album:")
              ? track.context
              : undefined,
        };
        if (
          this.props.audio &&
          ["object", "function"].includes(typeof this.props.audio)
        ) {
          playingByAudio.set(this.props.audio, {
            client: session.client,
            version: session.version,
            track: nowPlaying,
          });
        }
        this._finish(id, { nowPlaying });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: this.t("playFailed") });
      }
    }

    async audioControl(command) {
      const audio = this.props.audio;
      if (
        !audio ||
        !["pause", "resume", "stopPlayback", "refresh"].includes(command)
      )
        return;
      if (command === "stopPlayback") {
        // Invalidate a URL resolution still awaiting the catalog/RNG before Stop.
        this._request++;
        this._busy = false;
        if (this._alive) this.setState({ busy: false });
      }
      try {
        await audio[command]();
        if (this._alive) this.setState({ error: "" });
      } catch (error) {
        if (this._alive)
          this.setState({
            error:
              command === "stopPlayback"
                ? this.t("stopUnconfirmed")
                : controlUnavailable({ errorCode: error?.code })
                  ? this.t("openForControls")
                  : this.t("controlsUnavailable"),
          });
      }
    }

    text(value, style = styles.note, size = "SizeSmall", lines = 1) {
      return h(
        Text,
        { style: [style, font(size)], numberOfLines: lines },
        value,
      );
    }

    artwork(item, size, visible = true) {
      const uri = item && this._covers.get(item.uri);
      const image = visible && Image && uri;
      const style = [styles.art, { width: size, height: size }];
      return h(
        View,
        { style },
        image
          ? h(Image, {
              source: { uri },
              resizeMode: "cover",
              style: { width: size, height: size },
              // The native error may contain the resource URL; deliberately ignore it.
              onError: () => {
                if (this._alive && this._covers.get(item.uri) === uri) {
                  this._covers.delete(item.uri);
                  this.setState((state) => ({
                    artworkRevision: (state.artworkRevision || 0) + 1,
                  }));
                }
              },
            })
          : this.text("N", styles.coverText, "SizeXLarge"),
      );
    }

    button(key, title, action, disabled = false, style = styles.button) {
      return h(Button, {
        key,
        name: key,
        ref: this.coverRef(key),
        title,
        style,
        shortcutKeyGuide:
          key === "albums"
            ? "l1"
            : key === "playlists"
              ? "r1"
              : key === "account"
                ? "r2"
                : undefined,
        disabled: this.state.busy || disabled,
        onSquareKeyDown: this._togglePlayback,
        onTriangleKeyDown: this._stopPlayback,
        onR2KeyDown: this._openAccount,
        onLKeyDown: () => this.switchTab("albums"),
        onRKeyDown: () => this.switchTab("playlists"),
        onDownKeyDown: ["album-play", "album-shuffle"].includes(key)
          ? () => this.moveTrack(1, -1)
          : undefined,
        onFocus: () => {
          if (this._alive) this.setState({ focused: key });
        },
        onPress: () => {
          if (!this._busy && !disabled) action();
        },
      });
    }

    renderPlayback() {
      const playback = this.state.playback;
      if (
        !this.state.connected ||
        !this.props.audio ||
        !playback?.available ||
        (playback.phase === "idle" &&
          !playback.pending &&
          !playback.stopPending)
      )
        return null;
      const unavailable = controlUnavailable(playback);
      const blocked =
        ["native-mediafw", "resident-mediafw"].includes(
          playback.audioBackend,
        ) && playback.controlsAvailable === false;
      const paused = playback.phase === "paused";
      const elapsed =
        playback.playbackSampleFresh === true
          ? clockTime(playback.currentTime)
          : "";
      const duration =
        playback.playbackSampleFresh === true
          ? clockTime(playback.duration)
          : "";
      const progress =
        elapsed && duration && playback.duration > 0
          ? Math.max(
              0,
              Math.min(100, (playback.currentTime / playback.duration) * 100),
            )
          : undefined;
      const pendingLabel = unavailable
        ? this.t("controlsUnavailable")
        : playback.stopPending || playback.phase === "stopping"
          ? this.t("stopping")
          : ["accepted", "opening"].includes(playback.phase)
            ? this.t("loading")
            : playback.phase === "error"
              ? this.t("playFailed")
              : "";
      const control = (key, title, command, disabled) =>
        h(Button, {
          key,
          name: key,
          ref: this.coverRef(key),
          title,
          style: styles.playerButton,
          shortcutKeyGuide:
            key === "audio-pause"
              ? "square"
              : key === "audio-stop"
                ? "triangle"
                : undefined,
          disabled,
          onSquareKeyDown: this._togglePlayback,
          onTriangleKeyDown: this._stopPlayback,
          onR2KeyDown: this._openAccount,
          onLKeyDown: () => this.switchTab("albums"),
          onRKeyDown: () => this.switchTab("playlists"),
          onPress: () => {
            if (this._alive && !disabled) {
              if (key === "audio-pause") this._togglePlayback();
              else if (key === "audio-stop") this._stopPlayback();
              else this.audioControl(command);
            }
          },
        });
      return h(
        View,
        { style: styles.player },
        h(
          View,
          { style: styles.row },
          this.artwork(this.state.nowPlaying, 56),
          h(
            View,
            { style: styles.playerCopy },
            this.text(
              this.state.nowPlaying?.name || this.t("yourMusic"),
              styles.title,
            ),
            this.text(
              pendingLabel || this.state.nowPlaying?.artist || "",
              styles.note,
              "SizeXSmall",
            ),
          ),
          control(
            "audio-pause",
            paused ? this.t("resume") : this.t("pause"),
            paused ? "resume" : "pause",
            unavailable ||
              blocked ||
              playback.pending ||
              !["playing", "paused"].includes(playback.phase),
          ),
          control(
            "audio-stop",
            this.t("stop"),
            "stopPlayback",
            unavailable ||
              blocked ||
              (!playback.pending &&
                !playback.stopPending &&
                playback.phase === "idle" &&
                playback.closeConfirmed &&
                playback.stopConfirmed),
          ),
        ),
        progress === undefined
          ? null
          : h(
              View,
              { style: styles.progress },
              h(View, {
                style: [styles.progressFill, { width: `${progress}%` }],
              }),
            ),
        progress === undefined
          ? null
          : h(
              View,
              { style: styles.row },
              this.text(elapsed, [styles.time, { flex: 1 }], "SizeXSmall"),
              this.text(duration, styles.time, "SizeXSmall"),
            ),
      );
    }

    renderHero() {
      if (this.state.view !== "tracks" || !this.state.collection) return null;
      const item = this.state.collection;
      const first = this.state.rows.find((track) => track.isPlayable);
      const duration = this.state.rows.every(
        (track) => track.durationSeconds !== undefined,
      )
        ? clockTime(
            this.state.rows.reduce(
              (total, track) => total + track.durationSeconds,
              0,
            ),
          )
        : "";
      return h(
        View,
        { key: "collection", style: styles.hero },
        this.artwork(item, 136),
        h(
          View,
          { style: styles.heroCopy },
          this.text(item.name, styles.title, "SizeLarge", 2),
          this.text(item.artist || "", styles.note, "SizeSmall"),
          this.text(
            `${this.state.rows.length} ${this.state.rows.length === 1 ? this.t("song") : this.t("songs")}${duration ? " · " + duration : ""}`,
            styles.note,
            "SizeXSmall",
          ),
          h(
            View,
            { style: styles.albumActions },
            this.button(
              "album-play",
              this.t("play"),
              () => this.play(first, true),
              !first || typeof this.props.onPlay !== "function",
              styles.albumPlay,
            ),
            this.button(
              "album-shuffle",
              this.t("shuffle"),
              () => this.play(first, "shuffle"),
              !first || typeof this.props.onPlay !== "function",
              styles.albumPlay,
            ),
          ),
        ),
      );
    }

    focusTrack(item) {
      if (!this._alive) return;
      this.setState({ focused: `item-${item.index}` });
      const top = item.index * (TRACK_HEIGHT + 4);
      if (this._trackHeight > 0 && this._trackList) {
        const y =
          top < this._trackY + 72
            ? Math.max(0, top - 72)
            : top + TRACK_HEIGHT + 72 > this._trackY + this._trackHeight
              ? top + TRACK_HEIGHT + 72 - this._trackHeight
              : this._trackY;
        if (y !== this._trackY) {
          this._trackY = y;
          this._trackList.scrollTo({ y, animated: false });
        }
      }
    }

    switchTab(kind) {
      if (!this._alive || !this.state.connected || this.state.accountOpen)
        return false;
      if (!this._busy && this.state.view !== kind) this.browse(kind);
      return true;
    }

    moveTrack(direction, index) {
      if (!this._alive || this.state.view !== "tracks" || this._busy)
        return false;
      const selected =
        index === undefined
          ? this.state.rows.findIndex(
              (item) => `item-${item.index}` === this.state.focused,
            )
          : index;
      let next =
        selected < 0
          ? direction > 0
            ? 0
            : this.state.rows.length - 1
          : selected + direction;
      while (
        next >= 0 &&
        next < this.state.rows.length &&
        !this.state.rows[next].isPlayable
      )
        next += direction;
      const item = this.state.rows[next];
      const ref = this._coverRefs.get(
        item
          ? `track-${item.index}`
          : direction < 0
            ? "album-play"
            : "audio-pause",
      );
      if (typeof ref?.focus !== "function") return false;
      if (item) this.focusTrack(item);
      ref.focus();
      return true;
    }

    renderTracks() {
      const rows = this.state.rows.map((item) => {
        const key = `item-${item.index}`,
          focused = this.state.focused === key;
        const playing =
          this.state.nowPlaying?.uri === item.uri &&
          ["playing", "paused"].includes(this.state.playback?.phase);
        const color = focused ? "#111111" : "#ffffff";
        const enabled =
          !this.state.busy &&
          item.isPlayable &&
          typeof this.props.onPlay === "function";
        return h(
          View,
          {
            key: item.uri,
            name: key,
            ref: this.coverRef(`track-${item.index}`),
            focusable: enabled,
            accessibilityLabel: item.name,
            style: [
              styles.track,
              focused ? { backgroundColor: "#ffffff" } : {},
            ],
            onFocus: () => this.focusTrack(item),
            onUpKeyDown: () => this.moveTrack(-1, item.index),
            onDownKeyDown: () => this.moveTrack(1, item.index),
            onSquareKeyDown: this._togglePlayback,
            onTriangleKeyDown: this._stopPlayback,
            onR2KeyDown: this._openAccount,
            onLKeyDown: () => this.switchTab("albums"),
            onRKeyDown: () => this.switchTab("playlists"),
            onPress: enabled
              ? () => {
                  if (!this._busy) this.play(item);
                }
              : undefined,
          },
          h(
            View,
            { hideTagFromFocus: true, style: styles.trackContent },
            this.text(
              playing ? "♪" : String(item.index + 1),
              [styles.trackNumber, { color }],
              "SizeSmall",
            ),
            h(
              View,
              { hideTagFromFocus: true, style: styles.trackCopy },
              this.text(item.name, [styles.title, { color }]),
              this.text(
                item.artist || "",
                [styles.note, { color: focused ? "#303030" : "#a7a7a7" }],
                "SizeXSmall",
              ),
            ),
            this.text(
              clockTime(item.durationSeconds),
              [styles.trackTime, { color }],
              "SizeXSmall",
            ),
          ),
        );
      });
      const list = ScrollView
        ? h(
            ScrollView,
            {
              ref: this._bindTracks,
              style: styles.body,
              hideTagFromFocus: true,
              showsVerticalScrollIndicator: false,
              focusable: false,
              onUpKeyDown: () => this.moveTrack(-1),
              onDownKeyDown: () => this.moveTrack(1),
              onLayout: (event) => {
                this._trackHeight = event?.nativeEvent?.layout?.height || 0;
                const focused = this.state.rows.find(
                  (item) => `item-${item.index}` === this.state.focused,
                );
                if (focused) this.focusTrack(focused);
                if (this._restoreTrackFocus) {
                  const ref = this._coverRefs.get(this._restoreTrackFocus);
                  if (typeof ref?.focus === "function") {
                    this._restoreTrackFocus = undefined;
                    ref.focus();
                  }
                }
              },
              onScroll: (event) => {
                this._trackY = event?.nativeEvent?.contentOffset?.y || 0;
              },
            },
            rows.length ? rows : this.text(this.t("noSongs"), styles.note),
          )
        : h(View, { hideTagFromFocus: true, style: styles.body }, rows);
      return h(
        FocusLayerPS,
        {
          key: this.state.collection.uri,
          style: styles.body,
          selfFocusable: false,
          focusInBehavior: { type: "nearestItem" },
          focusOutBehavior: "normal",
          onUpKeyDown: () => this.moveTrack(-1),
          onDownKeyDown: () => this.moveTrack(1),
        },
        list,
      );
    }

    renderCatalog() {
      if (this.state.view === "tracks") return this.renderTracks();
      const rows = this.state.rows.map((item) => {
        const key = `item-${item.index}`,
          focused = this.state.focused === key;
        // Transparent native buttons receive focus but drop activation.
        return h(
          View,
          {
            key: item.uri,
            style: [styles.tile, focused ? styles.focused : {}],
          },
          h(Button, {
            name: key,
            title: item.name,
            accessibilityLabel: item.name,
            ref: this.coverRef(key),
            style: styles.coverButton,
            disabled: this.state.busy,
            onSquareKeyDown: this._togglePlayback,
            onTriangleKeyDown: this._stopPlayback,
            onR2KeyDown: this._openAccount,
            onLKeyDown: () => this.switchTab("albums"),
            onRKeyDown: () => this.switchTab("playlists"),
            onUpKeyDown: () => this.moveCollection(-1, item.index),
            onDownKeyDown: () => this.moveCollection(1, item.index),
            onFocus: () => this.focusCollection(item),
            onPress: () => {
              if (!this._busy) this.openCollection(item);
            },
          }),
          this.artwork(
            item,
            TILE_SIZE - 4,
            Math.floor(item.index / GRID_COLUMNS) >= this.state.gridRow - 2 &&
              Math.floor(item.index / GRID_COLUMNS) <=
                this.state.gridRow +
                  Math.ceil(this._gridHeight / ROW_HEIGHT) +
                  2,
          ),
        );
      });
      const selected =
        this.state.rows.find(
          (item) => `item-${item.index}` === this.state.focused,
        ) || this.state.rows[0];
      const groups = [];
      for (let index = 0; index < rows.length; index += GRID_COLUMNS)
        groups.push(
          h(
            View,
            { key: `cover-row-${index}`, style: styles.grid },
            rows.slice(index, index + GRID_COLUMNS),
          ),
        );
      return h(
        View,
        { key: "catalog", style: styles.body },
        selected ? this.text(selected.name, styles.selection) : null,
        !rows.length
          ? this.text(
              this.state.busy ? this.t("loading") : this.t("emptyLibrary"),
              styles.note,
            )
          : ScrollView
            ? h(
                ScrollView,
                {
                  ref: this._bindGrid,
                  style: styles.body,
                  showsVerticalScrollIndicator: false,
                  onLayout: (event) => this.gridLayout(event),
                  onScroll: (event) => this.gridScroll(event),
                },
                groups,
              )
            : h(View, null, groups),
        this.state.loadingMore
          ? this.text(this.t("loading"), styles.note, "SizeXSmall")
          : null,
        this.state.loadMoreError
          ? this.button("retry-more", this.t("retry"), () => this.loadMore())
          : null,
      );
    }

    renderAccount() {
      return h(
        View,
        { style: styles.account },
        this.text(this.t("account"), styles.title, "SizeLarge"),
        this.button(
          "account-back",
          this.t("back"),
          () => this.setState({ accountOpen: false }),
          false,
          styles.accountAction,
        ),
        this.button(
          "disconnect",
          this.t("logout"),
          () => this.disconnect(),
          false,
          styles.accountAction,
        ),
      );
    }

    renderConnection() {
      const available = canConnect(this.props);
      const editable = available && !this.state.busy;
      // Omit autoCorrect entirely: Sony SetAutoCorrect (PUI 0x0600097c)
      // throws "Unsupported prop autoCorrect" even for false. Password flags
      // below have separate, implemented native setters.
      return [
        !available
          ? h(
              Text,
              { key: "connection-unavailable", style: styles.note },
              this.t("connectionUnavailable"),
            )
          : null,
        h(Text, { key: "server-label", style: styles.note }, this.t("server")),
        h(TextInput, {
          key: "server",
          name: "navidrome-server",
          style: styles.input,
          defaultValue: this.state.serverUrl,
          autoCapitalize: "none",
          keyboardType: "url",
          editable,
          onChangeText: (serverUrl) => {
            if (
              canConnect(this.props) &&
              !this._busy &&
              typeof serverUrl === "string"
            )
              this.setState({ serverUrl });
          },
        }),
        h(
          Text,
          { key: "username-label", style: styles.note },
          this.t("username"),
        ),
        h(TextInput, {
          key: "username",
          name: "navidrome-username",
          style: styles.input,
          defaultValue: this.state.username,
          autoCapitalize: "none",
          editable,
          onChangeText: (username) => {
            if (
              canConnect(this.props) &&
              !this._busy &&
              typeof username === "string"
            )
              this.setState({ username });
          },
        }),
        h(
          Text,
          { key: "password-label", style: styles.note },
          this.t("password"),
        ),
        h(TextInput, {
          key: `password-${this.state.passwordKey}`,
          name: "navidrome-password",
          style: styles.input,
          defaultValue: this._passwordValue(),
          secureTextEntry: true,
          autoCapitalize: "none",
          switchableSecureTextEntry: false,
          disableLearningOnKeyboard: true,
          disableAddSelectedTermOnKeyboard: true,
          disableVoiceInput: true,
          predictiveText: false,
          editable,
          onChangeText: this._passwordChanged,
        }),
        this.button(
          "connect",
          this.t("connect"),
          () => this.connect(),
          !available,
        ),
      ];
    }

    render() {
      const connected = this.state.connected;
      const notice = this.state.error || this.state.credentialWarning;
      return h(
        FocusLayerPS,
        {
          style: styles.screen,
          onSquareKeyDown: this._togglePlayback,
          onTriangleKeyDown: this._stopPlayback,
          onR2KeyDown: this._openAccount,
          onLKeyDown: () => this.switchTab("albums"),
          onRKeyDown: () => this.switchTab("playlists"),
        },
        h(
          View,
          { style: styles.header },
          this.text("NaviStation", styles.brand, "SizeLarge"),
          connected && !this.state.accountOpen
            ? this.button(
                "account",
                this.t("account"),
                this._openAccount,
                false,
                styles.accountButton,
              )
            : null,
        ),
        notice ? this.text(notice, styles.notice, "SizeSmall", 2) : null,
        connected && this.state.accountOpen
          ? this.renderAccount()
          : connected
            ? [
                h(
                  View,
                  { key: "navigation", style: styles.tabs },
                  this.button(
                    "albums",
                    this.state.view === "tracks"
                      ? "‹ " + this.t("albums")
                      : this.t("albums"),
                    () => this.browse("albums"),
                    false,
                    [
                      styles.navigation,
                      this.state.view === "albums" ? styles.selectedTab : {},
                    ],
                  ),
                  this.button(
                    "playlists",
                    this.t("playlists"),
                    () => this.browse("playlists"),
                    false,
                    [
                      styles.navigation,
                      this.state.view === "playlists" ? styles.selectedTab : {},
                    ],
                  ),
                ),
                this.renderHero(),
                this.renderCatalog(),
              ]
            : h(View, { style: styles.login }, this.renderConnection()),
        this.renderPlayback(),
      );
    }
  };
}
