/**
 * Local React Native PS5 music view; importing this module mounts nothing.
 * Components come from the captured CC's module 1; React from module 2.
 * Provenance: docs/ARCHITECTURE.md.
 * No PSN, browser globals or native-player selection. This local test build
 * embeds the login defaults explicitly requested by the console owner.
 */
import { DEFAULT_SERVER_URL } from "./navidrome-catalog.mjs";

const PAGE_SIZE = 3;
// Survives screen remounts only while this audio owner and login session survive.
// Values contain display metadata and opaque catalog IDs, never artwork URLs.
const playingByAudio = new WeakMap();
const DEFAULT_USERNAME = "";
const DEFAULT_PASSWORD = "";
// Layout stays inside the captured Music card (~1040x810 at 1080p). Font sizes
// come exclusively from MESJr5x+ / FontSizePS; no guessed native font numbers.
const styles = {
  screen: { flex: 1, padding: 24, backgroundColor: "#0c1020" },
  row: { flexDirection: "row", alignItems: "center" },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  brand: { color: "#f4f5ff", flex: 1 },
  badge: { color: "#83e6de", marginLeft: 14 },
  title: { color: "#f4f5ff", marginBottom: 6 },
  note: { color: "#aeb9d2", marginBottom: 6 },
  accent: { color: "#83e6de", marginBottom: 6 },
  hero: { flexDirection: "row", alignItems: "center", padding: 14,
    backgroundColor: "#19203b", borderRadius: 12, marginBottom: 14 },
  heroCopy: { flex: 1, marginLeft: 18 },
  tabs: { flexDirection: "row", marginBottom: 14 },
  navigation: { flex: 1, height: 44, marginRight: 10 },
  button: { height: 44 },
  selectedTab: { backgroundColor: "#34446b", borderColor: "#83e6de", borderWidth: 2 },
  body: { flex: 1 },
  grid: { flexDirection: "row" },
  card: { flex: 1, padding: 12, marginRight: 10, backgroundColor: "#151d32",
    borderWidth: 2, borderColor: "#26314b", borderRadius: 12 },
  focused: { backgroundColor: "#243152", borderColor: "#83e6de" },
  art: { backgroundColor: "#2c3152", alignItems: "center", justifyContent: "center",
    overflow: "hidden", borderRadius: 8 },
  cover: { width: 132, height: 132, alignSelf: "center", marginBottom: 10 },
  coverText: { color: "#83e6de" },
  cardTitle: { color: "#f4f5ff", marginBottom: 4 },
  cardArtist: { color: "#aeb9d2", marginBottom: 8 },
  track: { flexDirection: "row", alignItems: "center", marginBottom: 6, padding: 8,
    backgroundColor: "#151d32", borderRadius: 10, borderWidth: 2, borderColor: "#26314b" },
  trackCopy: { flex: 1, marginLeft: 14, marginRight: 12 },
  trackAction: { width: 240, height: 44 },
  pages: { flexDirection: "row", alignItems: "center", marginTop: 12 },
  pageLabel: { color: "#aeb9d2", flex: 1, textAlign: "center" },
  pageButton: { width: 216, height: 40 },
  player: { backgroundColor: "#1b2240", padding: 12, borderRadius: 12, marginTop: 12 },
  playerCopy: { flex: 1, marginRight: 12 },
  playerButton: { width: 184, height: 44, marginLeft: 8 },
  progress: { height: 4, backgroundColor: "#343c59", marginTop: 10, marginBottom: 6 },
  progressFill: { height: 4, backgroundColor: "#83e6de" },
  notice: { color: "#e1d0fd", marginTop: 8 },
  login: { flex: 1, padding: 20, backgroundColor: "#151d32", borderRadius: 12 },
  input: { height: 48, marginBottom: 14, color: "#f4f5ff" },
};

function clockTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function controlUnavailable(playback) {
  return (["native-mediafw", "resident-mediafw"].includes(playback?.audioBackend) && playback.hostReachable === false) ||
    ["ND_AUDIO_HOST_UNAVAILABLE", "ND_AUDIO_CONTROL_TIMEOUT"].includes(playback?.errorCode);
}

function hasLibrary(library) {
  return !!library && ["albumSection", "playlistSection", "collectionTracks", "resolveStream"]
    .every(name => typeof library[name] === "function");
}

function canConnect(props) {
  return typeof props.onLogin === "function" || !!(props.client &&
    typeof props.client.login === "function" && typeof props.client.logout === "function" &&
    typeof props.client.serverUrl === "string" && hasLibrary(props.library));
}

function ready(connection) {
  return connection && connection.client && connection.client.state === "connected" &&
    Number.isSafeInteger(connection.client.sessionVersion) && typeof connection.client.serverUrl === "string" &&
    typeof connection.client.logout === "function" && hasLibrary(connection.library);
}

// Only display metadata/opaque identifiers enters React state; image URLs do not.
function row(item, index) {
  if (!item || typeof item.uri !== "string") throw new Error("Invalid catalog");
  return { uri: item.uri, name: typeof item.name === "string" ? item.name : "Sin título",
    artist: typeof item.artist === "string" ? item.artist : "", index,
    isPlayable: item.isPlayable === true };
}

/**
 * native: {View, Text, Button, TextInput, FocusLayerPS} from real CC module 1.
 * Props: client?, library?, onLogin?, onPlay?, renderStockMusic?, shellProps.
 * Without onLogin or a real client/library pair, connection controls are disabled.
 * onLogin({serverUrl,username,password,isCurrent}) must connect to Navidrome only;
 * returns {client,library}, or undefined when it connected the supplied client.
 * The callback must release credentials and honor isCurrent() after async work.
 * onPlay({track,client,library,resolveStream,isCurrent}) is optional; audio is disabled absent
 * this real binding. resolveStream generates a fresh URL when the player needs it.
 */
export function createLocalMusicScreen({ React, native } = {}) {
  if (!React || typeof React.Component !== "function" || typeof React.createElement !== "function") {
    throw new TypeError("React unavailable");
  }
  if (!native || ["View", "Text", "Button", "TextInput", "FocusLayerPS"].some(name => !native[name])) {
    throw new TypeError("Native components unavailable");
  }
  const { View, Text, Button, TextInput, FocusLayerPS, Image } = native;
  const h = React.createElement;
  const font = name => {
    const value = native.FontSizePS?.[name];
    return value === undefined ? {} : { fontSize: value };
  };

  return class LocalMusic extends React.Component {
    constructor(props) {
      super(props);
      this._connection = { client: props.client, library: props.library };
      const previous = playingByAudio.get(props.audio);
      const sameSession = previous && ready(this._connection) && previous.client === props.client &&
        previous.version === props.client.sessionVersion;
      if (previous && !sameSession) playingByAudio.delete(props.audio);
      this._alive = false;
      this._request = 0;
      this._busy = false;
      this._items = [];
      this._covers = new Map();
      this._pendingClient = undefined;
      // Keep the editable password outside React state and diagnostics. Only
      // the secure native TextInput receives its initial value for prefilling.
      let password = canConnect(props) ? DEFAULT_PASSWORD : "";
      this._passwordValue = () => password;
      this._passwordChanged = text => {
        if (!canConnect(this.props)) password = "";
        else if (!this._busy) password = typeof text === "string" ? text : "";
      };
      this._takePassword = () => { const value = password; password = ""; return value; };
      this.state = { serverUrl: props.client?.serverUrl || DEFAULT_SERVER_URL, username: DEFAULT_USERNAME,
        connected: ready(this._connection), view: "home", rows: [], page: 0, more: false,
        busy: false, error: "", passwordKey: 0,
        focused: "", collection: undefined, nowPlaying: sameSession ? previous.track : undefined,
        playback: props.audio && typeof props.audio.status === "function" ? props.audio.status() : undefined };
    }

    componentDidMount() {
      this._alive = true;
      if (ready(this._connection)) this.browse("albums");
      const audio = this.props.audio;
      if (audio && typeof audio.subscribe === "function") {
        this._unsubscribeAudio = audio.subscribe(playback => {
          if (this._alive) this.setState({ playback });
        });
        // Same session/owner on reopening; Status never claims or starts audio.
        audio.refresh().catch(() => undefined);
      }
    }

    componentDidUpdate(previousProps) {
      if (canConnect(previousProps) && !canConnect(this.props)) {
        this._takePassword();
        this.setState(state => ({ passwordKey: state.passwordKey + 1 }));
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
      // Cancel our pending login. An established externally owned session survives
      // closing Music; explicit Disconnect clears it. onLogin owns its async work.
      if (this._pendingClient) this._pendingClient.logout();
      this._pendingClient = undefined;
      this._connection = undefined;
    }

    _begin() {
      if (!this._alive || this._busy) return undefined;
      this._busy = true;
      const id = ++this._request;
      this.setState({ busy: true, error: "" });
      return id;
    }

    _finish(id, patch) {
      if (!this._alive || id !== this._request) return;
      this._busy = false;
      this.setState({ busy: false, ...patch });
    }

    _session() {
      if (!ready(this._connection)) throw new Error("Disconnected");
      return { ...this._connection, version: this._connection.client.sessionVersion };
    }

    _current(id, session) {
      return this._alive && id === this._request && this._connection?.client === session.client &&
        session.client.state === "connected" && session.client.sessionVersion === session.version;
    }

    _expire(id) {
      if (!this._alive || id !== this._request) return;
      playingByAudio.delete(this.props.audio);
      this._items = [];
      this._covers.clear();
      this._connection = undefined;
      this._finish(id, { connected: false, rows: [], view: "home",
        collection: undefined, nowPlaying: undefined,
        error: "Vuelve a conectar." });
    }

    _rememberCovers(items, collection) {
      const keep = new Set([this.state.nowPlaying?.uri, collection?.uri]);
      this._covers.forEach((url, key) => { if (!keep.has(key)) this._covers.delete(key); });
      items.forEach(item => {
        if (typeof item?.uri === "string" && typeof item.image_url === "string" && /^https?:\/\//i.test(item.image_url)) {
          this._covers.set(item.uri, item.image_url);
          if (item.uri === this.state.nowPlaying?.albumUri) this._covers.set(this.state.nowPlaying.uri, item.image_url);
        }
      });
    }

    async connect() {
      if (!canConnect(this.props)) {
        this._takePassword();
        if (this._alive) this.setState({ error: "Conexión no disponible." });
        return;
      }
      const id = this._begin();
      if (id === undefined) return;
      playingByAudio.delete(this.props.audio);
      const credentials = { serverUrl: typeof this.state.serverUrl === "string" ? this.state.serverUrl.trim() : "",
        username: this.state.username,
        password: this._passwordValue(), isCurrent: () => this._alive && id === this._request };
      this._items = [];
      this._covers.clear();
      this.setState({ rows: [], connected: false });
      try {
        let connection;
        if (typeof this.props.onLogin === "function") {
          connection = await this.props.onLogin(credentials);
        } else {
          const client = this.props.client;
          if (!client || typeof client.login !== "function" || typeof client.logout !== "function" ||
              typeof client.serverUrl !== "string" ||
              credentials.serverUrl.replace(/\/+$/, "") !== client.serverUrl.replace(/\/+$/, "")) {
            throw new Error("Invalid session");
          }
          this._pendingClient = client;
          await client.login({ username: credentials.username, password: credentials.password });
          connection = { client, library: this.props.library };
        }
        if (!credentials.isCurrent()) return;
        connection = connection || { client: this.props.client, library: this.props.library };
        if (!ready(connection)) throw new Error("Invalid session");
        this._connection = connection;
        this._takePassword();
        this._finish(id, { connected: true, view: "home", serverUrl: connection.client.serverUrl,
          rows: [], page: 0 });
        this.browse("albums");
      } catch (error) {
        if (credentials.isCurrent()) {
          const code = error && Object.getOwnPropertyDescriptor(error, "code");
          const authenticationRejected = code && "value" in code && code.value === "NDAUTH_40";
          this._finish(id, { connected: false,
            error: authenticationRejected ? "Usuario o contraseña incorrectos." :
              "No se pudo conectar." });
        }
      } finally {
        credentials.password = "";
        this._pendingClient = undefined;
      }
    }

    disconnect() {
      if (this._busy) return;
      playingByAudio.delete(this.props.audio);
      this._request++;
      this._takePassword();
      if (this._connection?.client && typeof this._connection.client.logout === "function") {
        this._connection.client.logout();
      }
      this._items = [];
      this._covers.clear();
      this.setState(state => ({ connected: false, view: "home", rows: [], error: "",
        passwordKey: state.passwordKey + 1, username: "", page: 0, more: false,
        collection: undefined, nowPlaying: undefined }));
    }

    async browse(kind, page = 0) {
      const id = this._begin();
      if (id === undefined) return;
      try {
        const session = this._session();
        const section = kind === "albums"
          ? await session.library.albumSection({ type: "alphabeticalByName", size: PAGE_SIZE, offset: page * PAGE_SIZE })
          : await session.library.playlistSection();
        if (!this._current(id, session)) { this._expire(id); return; }
        const items = section ? section.sections : [];
        if (!Array.isArray(items)) throw new Error("Invalid catalog");
        this._items = kind === "albums" ? [] : items;
        const visible = kind === "albums" ? items : items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const rows = visible.map((item, index) => row(item, page * PAGE_SIZE + index));
        this._rememberCovers(visible);
        this._finish(id, { view: kind, rows, page,
          collection: undefined, focused: "",
          more: kind === "albums" ? items.length === PAGE_SIZE : (page + 1) * PAGE_SIZE < items.length });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: "No se pudo cargar. Reintenta." });
      }
    }

    async openCollection(item) {
      const id = this._begin();
      if (id === undefined) return;
      try {
        const session = this._session();
        const result = await session.library.collectionTracks(item.uri);
        if (!this._current(id, session)) { this._expire(id); return; }
        if (!Array.isArray(result.tracks)) throw new Error("Invalid catalog");
        this._items = result.tracks;
        this._rememberCovers(result.tracks.slice(0, PAGE_SIZE), item);
        this._finish(id, { view: "tracks", page: 0,
          collection: item, focused: "",
          rows: result.tracks.slice(0, PAGE_SIZE).map(row), more: result.tracks.length > PAGE_SIZE });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: "No se pudo cargar. Reintenta." });
      }
    }

    changePage(page) {
      if (this._busy || page < 0) return;
      if (this.state.view === "albums") { this.browse("albums", page); return; }
      const offset = page * PAGE_SIZE;
      const visible = this._items.slice(offset, offset + PAGE_SIZE);
      const rows = visible.map((item, index) => row(item, offset + index));
      this._rememberCovers(visible, this.state.collection);
      this.setState({ rows, page, focused: "", more: offset + PAGE_SIZE < this._items.length });
    }

    async play(item) {
      if (typeof this.props.onPlay !== "function" || !item.isPlayable) return;
      const id = this._begin();
      if (id === undefined) return;
      try {
        const session = this._session();
        const track = this._items[item.index];
        if (!track || track.uri !== item.uri) throw new Error("Invalid catalog");
        await this.props.onPlay({ track, client: session.client, library: session.library,
          isCurrent: () => this._current(id, session),
          resolveStream: async () => {
            if (!this._current(id, session)) throw new Error("Stale request");
            const url = await session.library.resolveStream(track.uri);
            if (!this._current(id, session)) throw new Error("Stale request");
            return url;
          } });
        if (!this._current(id, session)) return;
        const nowPlaying = { ...row(track, item.index),
          albumUri: typeof track.context === "string" && track.context.startsWith("navidrome:album:") ? track.context : undefined };
        if (this.props.audio && ["object", "function"].includes(typeof this.props.audio)) {
          playingByAudio.set(this.props.audio, { client: session.client, version: session.version, track: nowPlaying });
        }
        this._finish(id, { nowPlaying });
      } catch {
        if (!ready(this._connection)) this._expire(id);
        else this._finish(id, { error: "No se pudo reproducir" });
      }
    }

    async audioControl(command) {
      const audio = this.props.audio;
      if (!audio || !["pause", "resume", "stopPlayback", "refresh"].includes(command)) return;
      if (command === "stopPlayback") {
        // Invalidate a URL resolution still awaiting the catalog/RNG before Stop.
        this._request++; this._busy = false;
        if (this._alive) this.setState({ busy: false });
      }
      try { await audio[command](); }
      catch (error) {
        if (this._alive) this.setState({ error: command === "stopPlayback" ?
          "Parada sin confirmar." :
          controlUnavailable({ errorCode: error?.code }) ? "Abre Navidrome para controlar." :
            "Control no disponible." });
      }
    }

    text(value, style = styles.note, size = "SizeSmall", lines = 1) {
      return h(Text, { style: [style, font(size)], numberOfLines: lines }, value);
    }

    artwork(item, size) {
      const uri = item && this._covers.get(item.uri);
      const image = Image && uri;
      const style = [styles.art, { width: size, height: size }];
      return h(View, { style }, image ? h(Image, {
        source: { uri }, resizeMode: "cover", style: { width: size, height: size },
        // The native error may contain the resource URL; deliberately ignore it.
        onError: () => {
          if (this._alive && this._covers.get(item.uri) === uri) {
            this._covers.delete(item.uri);
            this.setState(state => ({ artworkRevision: (state.artworkRevision || 0) + 1 }));
          }
        },
      }) : this.text("N", styles.coverText, "SizeXLarge"));
    }

    button(key, title, action, disabled = false, style = styles.button) {
      return h(Button, { key, name: key, title, style, disabled: this.state.busy || disabled,
        onFocus: () => { if (this._alive) this.setState({ focused: key }); },
        onPress: () => { if (!this._busy && !disabled) action(); } });
    }

    renderPlayback() {
      const playback = this.state.playback;
      if (!this.state.connected || !this.props.audio || !playback?.available) return null;
      const unavailable = controlUnavailable(playback);
      const blocked = ["native-mediafw", "resident-mediafw"].includes(playback.audioBackend) && playback.controlsAvailable === false;
      const labels = { idle: "Elige una canción", accepted: "Cargando canción…", opening: "Cargando canción…",
        playing: "Reproduciendo", paused: "En pausa", stopping: "Deteniendo…", error: "No se pudo reproducir" };
      const label = unavailable ? "Controles no disponibles" : playback.stopPending ? "Deteniendo…" :
        labels[playback.phase] || "Actualizando reproducción…";
      const control = (key, title, command, disabled) => h(Button, {
        key, name: key, title, style: styles.playerButton, disabled,
        onPress: () => { if (this._alive && !disabled) this.audioControl(command); },
      });
      const paused = playback.phase === "paused";
      const elapsed = playback.playbackSampleFresh === true ? clockTime(playback.currentTime) : "";
      const duration = playback.playbackSampleFresh === true ? clockTime(playback.duration) : "";
      const progress = elapsed && duration && playback.duration > 0 ?
        Math.max(0, Math.min(100, playback.currentTime / playback.duration * 100)) : undefined;
      return h(View, { style: styles.player },
        h(View, { style: styles.row },
          h(View, { style: styles.playerCopy },
            this.text(progress === undefined ? label : `${label} · ${elapsed} / ${duration}`, styles.accent),
            this.text(this.state.nowPlaying?.name || "Tu música", styles.title)),
          control("audio-pause", paused ? "Seguir" : "Pausa", paused ? "resume" : "pause",
            unavailable || blocked || playback.pending || !["playing", "paused"].includes(playback.phase)),
          control("audio-stop", "Parar", "stopPlayback", unavailable || blocked || (!playback.pending && !playback.stopPending &&
            playback.phase === "idle" && playback.closeConfirmed && playback.stopConfirmed)),
          control("audio-status", "Estado", "refresh", playback.pending)),
        progress === undefined ? null : h(View, { style: styles.progress },
          h(View, { style: [styles.progressFill, { width: `${progress}%` }] })));
    }

    renderHero() {
      const item = this.state.collection || this.state.nowPlaying || this.state.rows[0];
      const notice = this.state.error || (this.state.busy ? "Cargando…" : controlUnavailable(this.state.playback) ?
        "Abre Navidrome para controlar." : "");
      return h(View, { style: styles.hero },
        this.artwork(item, 64),
        h(View, { style: styles.heroCopy },
          this.text("TU BIBLIOTECA", styles.accent, "SizeXSmall"),
          this.text(item?.name || "Dale play", styles.title, "SizeLarge"),
          this.text(notice || item?.artist || "Tu biblioteca",
            notice ? [styles.note, { color: "#e1d0fd" }] : styles.note)));
    }

    renderCatalog() {
      const tracks = this.state.view === "tracks";
      const rows = this.state.rows.map(item => {
        const key = `item-${item.index}`, focused = this.state.focused === key;
        if (tracks) return h(View, { key: item.uri, style: [styles.track, focused ? styles.focused : {}] },
          this.artwork(item, 52),
          h(View, { style: styles.trackCopy },
            this.text(item.name, [styles.cardTitle, { marginBottom: 0 }]),
            this.text(item.artist || "Artista desconocido", [styles.cardArtist, { marginBottom: 0 }], "SizeXSmall")),
          this.button(key, "Reproducir", () => this.play(item),
            typeof this.props.onPlay !== "function" || !item.isPlayable, styles.trackAction));
        return h(View, { key: item.uri, style: [styles.card, focused ? styles.focused : {}] },
          h(View, { style: styles.cover }, this.artwork(item, 132)),
          this.text(item.name, styles.cardTitle),
          this.text(item.artist || "Tu colección", styles.cardArtist, "SizeXSmall"),
          this.button(key, "Abrir", () => this.openCollection(item)));
      });
      return h(View, { style: styles.body },
        !rows.length ? this.text(this.state.busy ? "Cargando tu biblioteca…" :
          tracks ? "Esta colección está vacía." : "Esta colección está vacía.", styles.note, "SizeNormal", 2) :
          h(View, { style: tracks ? {} : styles.grid }, rows),
        h(View, { style: styles.pages },
          this.button("previous", "Anterior", () => this.changePage(this.state.page - 1), this.state.page === 0, styles.pageButton),
          this.text(`Página ${this.state.page + 1}`, styles.pageLabel, "SizeXSmall"),
          this.button("next", "Siguiente", () => this.changePage(this.state.page + 1), !this.state.more, styles.pageButton)));
    }

    renderConnection() {
      const available = canConnect(this.props);
      const editable = available && !this.state.busy;
      // Omit autoCorrect entirely: Sony SetAutoCorrect (PUI 0x0600097c)
      // throws "Unsupported prop autoCorrect" even for false. Password flags
      // below have separate, implemented native setters.
      return [
        !available ? h(Text, { key: "connection-unavailable", style: styles.note }, "Conexión no disponible.") : null,
        h(Text, { key: "server-label", style: styles.note }, "Servidor"),
        h(TextInput, { key: "server", name: "navidrome-server", style: styles.input,
          defaultValue: this.state.serverUrl, autoCapitalize: "none",
          keyboardType: "url", editable,
          onChangeText: serverUrl => { if (canConnect(this.props) && !this._busy && typeof serverUrl === "string") this.setState({ serverUrl }); } }),
        h(Text, { key: "username-label", style: styles.note }, "Usuario"),
        h(TextInput, { key: "username", name: "navidrome-username", style: styles.input,
          defaultValue: this.state.username, autoCapitalize: "none",
          editable,
          onChangeText: username => { if (canConnect(this.props) && !this._busy && typeof username === "string") this.setState({ username }); } }),
        h(Text, { key: "password-label", style: styles.note }, "Contraseña"),
        h(TextInput, { key: `password-${this.state.passwordKey}`, name: "navidrome-password",
          style: styles.input, defaultValue: this._passwordValue(), secureTextEntry: true, autoCapitalize: "none",
          switchableSecureTextEntry: false, disableLearningOnKeyboard: true,
          disableAddSelectedTermOnKeyboard: true, disableVoiceInput: true, predictiveText: false,
          editable, onChangeText: this._passwordChanged }),
        this.button("connect", "Conectar", () => this.connect(), !available),
      ];
    }

    render() {
      const connected = this.state.connected;
      return h(FocusLayerPS, { style: styles.screen },
        h(View, { style: styles.header },
          this.text("navidrome", styles.brand, "SizeLarge"),
          this.text(connected ? "TU BIBLIOTECA" : "BIENVENIDO", styles.badge, "SizeXSmall")),
        this.renderHero(),
        connected ? h(View, { style: styles.tabs },
          this.button("albums", this.state.view === "tracks" ? "Volver a álbumes" : "Álbumes", () => this.browse("albums"), false,
            [styles.navigation, this.state.view === "albums" ? styles.selectedTab : {}]),
          this.button("playlists", "Listas", () => this.browse("playlists"), false,
            [styles.navigation, this.state.view === "playlists" ? styles.selectedTab : {}]),
          this.button("disconnect", "Desconectar", () => this.disconnect(), false, styles.navigation)) : null,
        connected ? this.renderCatalog() : h(View, { style: styles.login }, this.renderConnection()),
        !connected && this.state.error ? this.text(this.state.error, styles.notice, "SizeSmall", 2) : null,
        this.renderPlayback());
    }
  };
}
