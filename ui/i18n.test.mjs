import test from "node:test";
import assert from "node:assert/strict";
import {
  createTranslator,
  readSystemLocale,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from "./i18n.mjs";
import { createLocalMusicScreen } from "./local-music-screen.mjs";

test("regional console locales resolve to supported languages, with English fallback", () => {
  for (const [locale, language] of [
    ["es-ES", "es"],
    ["en-US", "en"],
    ["en-GB", "en"],
    ["fr-CA", "fr"],
    ["de-DE", "de"],
    ["it-IT", "it"],
    ["pt-BR", "pt"],
    ["pt_PT", "pt"],
    [" EN-us ", "en"],
  ]) {
    assert.equal(resolveLanguage(locale), language);
  }
  for (const locale of [
    undefined,
    null,
    1,
    "",
    "ja-JP",
    "__proto__",
    "constructor",
  ]) {
    assert.equal(resolveLanguage(locale), "en");
    assert.equal(createTranslator(locale)("play"), "Play");
  }
});

test("all languages have every UI message and readable collection controls", () => {
  const keys = [
    "untitled",
    "reconnect",
    "connectionUnavailable",
    "saveFailed",
    "credentialsRejected",
    "connectFailed",
    "forgetFailed",
    "loadFailed",
    "playFailed",
    "stopUnconfirmed",
    "openForControls",
    "controlsUnavailable",
    "stopping",
    "loading",
    "yourMusic",
    "resume",
    "pause",
    "stop",
    "song",
    "songs",
    "play",
    "shuffle",
    "noSongs",
    "emptyLibrary",
    "retry",
    "account",
    "back",
    "logout",
    "server",
    "username",
    "password",
    "connect",
    "albums",
    "playlists",
  ];
  assert.deepEqual(SUPPORTED_LANGUAGES, ["es", "en", "fr", "de", "it", "pt"]);
  for (const language of SUPPORTED_LANGUAGES) {
    const t = createTranslator(language);
    for (const key of keys)
      assert.ok(
        typeof t(key) === "string" &&
          t(key).length > 0 &&
          (["song", "songs"].includes(key) || t(key) !== key),
        `${language}: ${key}`,
      );
    assert.ok(t("play").length <= 16);
    assert.ok(t("shuffle").length <= 16);
  }
  assert.equal(createTranslator("en")("song"), "song");
  assert.equal(createTranslator("en")("songs"), "songs");
});

test("locale reads the cached ShellUI StringResource without initializing modules", () => {
  const base = () => {
    throw new Error("Must not initialize native modules");
  };
  base.c = {
    bX5JscBE: { exports: { StringResource: { defaultLocale: "fr-FR" } } },
  };
  assert.equal(readSystemLocale(base), "fr-FR");
  assert.equal(readSystemLocale({}), undefined);
  Object.defineProperty(
    base.c.bX5JscBE.exports.StringResource,
    "defaultLocale",
    {
      get() {
        throw new Error("Unavailable");
      },
    },
  );
  assert.equal(readSystemLocale(base), undefined);
});

test("localized screen renders login, album, playlist and errors without translating metadata", async () => {
  class Component {
    constructor(props) {
      this.props = props;
    }
    setState(patch) {
      this.state = { ...this.state, ...patch };
    }
  }
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter(Boolean),
  });
  const Screen = createLocalMusicScreen({
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
  const collect = (node) =>
    !node || typeof node !== "object"
      ? []
      : [node, ...node.children.flatMap(collect)];
  for (const locale of SUPPORTED_LANGUAGES) {
    const t = createTranslator(locale);
    const s = new Screen({ locale });
    const login = collect(s.render());
    assert.ok(login.some((node) => node.children.includes(t("password"))));
    assert.ok(
      login.some(
        (node) =>
          node.props.name === "connect" && node.props.title === t("connect"),
      ),
    );
    const client = {
      state: "connected",
      sessionVersion: 1,
      serverUrl: "http://server",
      logout() {},
    };
    s.props.onPlay = async () => {
      throw new Error("Private stream URL");
    };
    s._connection = {
      client,
      library: {
        albumSection() {},
        playlistSection() {},
        collectionTracks() {},
        resolveStream() {},
      },
    };
    s._alive = true;
    s._items = [
      {
        uri: "opaque-song",
        name: "Canción sin traducir",
        artist: "Artista",
        isPlayable: true,
      },
    ];
    s.state = {
      ...s.state,
      connected: true,
      view: "tracks",
      collection: { uri: "opaque-album", name: "Álbum sin traducir" },
      rows: s._items.map(s.catalogRow),
    };
    s.props.audio = {};
    s.state.playback = { available: true, phase: "paused" };
    const details = collect(s.render());
    const resume = details.find((node) => node.props.name === "audio-pause");
    assert.equal(resume.props.title, t("resume"));
    assert.equal(resume.props.shortcutKeyGuide, "square");
    for (const [name, shortcut] of [
      ["albums", "l1"],
      ["playlists", "r1"],
      ["account", "r2"],
      ["audio-stop", "triangle"],
    ]) {
      assert.equal(
        details.find((node) => node.props.name === name).props.shortcutKeyGuide,
        shortcut,
      );
    }
    assert.ok(
      details.some(
        (node) =>
          node.props.name === "album-shuffle" &&
          node.props.title === t("shuffle"),
      ),
    );
    assert.ok(
      details.some((node) => node.children.includes("Álbum sin traducir")),
    );
    assert.ok(
      details.some(
        (node) =>
          node.props.name === "playlists" &&
          node.props.title === t("playlists"),
      ),
    );
    assert.equal(s.catalogRow({ uri: "untitled" }, 0).name, t("untitled"));
    await s.play(s.state.rows[0]);
    assert.equal(s.state.error, t("playFailed"));
    assert.ok(!s.state.error.includes("Private"));
  }
});
