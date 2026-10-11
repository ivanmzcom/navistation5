/**
 * Explicit, reversible bindings for the captured PS5 0x13200006 CC bundle.
 * See docs/ARCHITECTURE.md. Importing this file installs nothing.
 * The loader supplies the real webpack require and a real local RN component.
 * This does not obtain require, register a native service, or implement audio.
 */
export const CONTROL_CENTER_HBC_SHA256 =
  "8a5ad941d8ca0dedad99df7c1f09c5fc36ce9752a5d0954b92401d24aad8990e";

const owners = new WeakMap();
const SERVICE = "navidrome";

function cachedExports(require, id) {
  if (typeof require !== "function") {
    throw new TypeError("The loader must supply the captured CC webpack require");
  }
  const cache = Object.getOwnPropertyDescriptor(require, "c");
  const factories = Object.getOwnPropertyDescriptor(require, "m");
  if (!cache || !("value" in cache) || !cache.value || typeof cache.value !== "object" ||
      !factories || !("value" in factories) || !Array.isArray(factories.value)) {
    throw new Error("CC webpack cache/factory shape does not match the capture");
  }
  const factory = Object.getOwnPropertyDescriptor(factories.value, String(id));
  if (!factory || typeof factory.value !== "function") throw new Error(`Missing CC factory ${id}`);
  const record = Object.getOwnPropertyDescriptor(cache.value, String(id));
  const module = record && "value" in record ? record.value : undefined;
  const index = module && Object.getOwnPropertyDescriptor(module, "i");
  const loaded = module && Object.getOwnPropertyDescriptor(module, "l");
  const exported = module && Object.getOwnPropertyDescriptor(module, "exports");
  if (!index || index.value !== id || !loaded || loaded.value !== true ||
      !exported || !("value" in exported) || !exported.value) {
    throw new Error(`CC module ${id} must already be loaded; installation does not execute factories`);
  }
  return exported.value;
}

function assertIdentity({ firmware, bundleSha256 }) {
  if (firmware !== 0x13200006 || bundleSha256 !== CONTROL_CENTER_HBC_SHA256) {
    throw new Error("This binding requires the captured firmware and CC bundle identity");
  }
}

function sameDescriptor(a, b) {
  return a && b && a.value === b.value && a.get === b.get && a.set === b.set &&
    a.writable === b.writable && a.enumerable === b.enumerable &&
    a.configurable === b.configurable;
}

function installPatches(patches) {
  for (const patch of patches) {
    patch.before = Object.getOwnPropertyDescriptor(patch.target, patch.key);
    if (!patch.before || !("value" in patch.before) ||
        typeof patch.before.value !== "function" ||
        (!patch.before.configurable && !patch.before.writable)) {
      throw new Error(`Unsupported writable method descriptor: ${patch.key}`);
    }
    if (owners.get(patch.target)?.has(patch.key)) {
      throw new Error(`A Navidrome binding already owns ${patch.key}`);
    }
    patch.after = { ...patch.before, value: patch.wrap(patch.before.value) };
  }
  const applied = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.target, patch.key, patch.after);
      let owned = owners.get(patch.target);
      if (!owned) owners.set(patch.target, owned = new Map());
      owned.set(patch.key, patch);
      applied.push(patch);
    }
  } catch (error) {
    for (const patch of applied.reverse()) {
      Object.defineProperty(patch.target, patch.key, patch.before);
      owners.get(patch.target).delete(patch.key);
    }
    throw error;
  }
  let removed = false;
  return Object.freeze({
    uninstall() {
      if (removed) return { restored: [], conflicts: [] };
      const restored = [], conflicts = [];
      for (const patch of [...applied].reverse()) {
        const current = Object.getOwnPropertyDescriptor(patch.target, patch.key);
        if (sameDescriptor(current, patch.after)) {
          Object.defineProperty(patch.target, patch.key, patch.before);
          restored.push(patch.key);
        } else {
          conflicts.push(patch.key);
        }
        if (owners.get(patch.target)?.get(patch.key) === patch) {
          owners.get(patch.target).delete(patch.key);
        }
      }
      removed = true;
      return { restored, conflicts };
    },
  });
}

/**
 * CC #29698 reads require(2814).default on every menu opening.
 * LocalMusic is a supplied React component, rendered inside that native menu.
 * It receives the untouched shellProps and explicit client/library/callbacks.
 * renderStockMusic only creates the original React element when requested.
 * The local branch does not mount the Sony container or its BGS subscriptions.
 * Existing mounted trees are not remounted; close and reopen Music after install.
 */
export function installLocalMusicEntry({ require, firmware, bundleSha256,
  LocalMusic, client, library, onLogin, onPlay } = {}) {
  assertIdentity({ firmware, bundleSha256 });
  if (typeof LocalMusic !== "function" ||
      (onLogin !== undefined && typeof onLogin !== "function") ||
      (onPlay !== undefined && typeof onPlay !== "function")) {
    throw new TypeError("A real local React component and optional real callbacks are required");
  }
  const musicMenu = cachedExports(require, 2814);
  const jsx = cachedExports(require, 3).jsx;
  if (typeof jsx !== "function") throw new Error("CC JSX runtime is unavailable");
  return installPatches([{
    target: musicMenu, key: "default",
    wrap: StockMusic => function NavidromeMusicEntry(shellProps) {
      return jsx(LocalMusic, {
        shellProps, client, library, onLogin, onPlay,
        renderStockMusic: () => jsx(StockMusic, shellProps),
      });
    },
  }]);
}

/**
 * Earlier entry: module 2813 is the music button in the CC registry (#19977).
 * Its memoized render #29697 creates module 74 with a getMenu callback. Changing
 * the memo object's type preserves the registry's existing object reference.
 * The original function still runs only when React normally renders it, keeping
 * useConnectionStatus hook order. The local getMenu never requires module 2814.
 * Login/client/library may be absent; the renderer must show that capability as
 * unavailable. Nothing supplies a dummy connection or a native service type.
 */
export function installLocalMusicMenu({ require, firmware, bundleSha256,
  LocalMusic, View, client, library, onLogin, onPlay } = {}) {
  assertIdentity({ firmware, bundleSha256 });
  if (typeof LocalMusic !== "function" || !View ||
      (onLogin !== undefined && typeof onLogin !== "function") ||
      (onPlay !== undefined && typeof onPlay !== "function")) {
    throw new TypeError("Real local React/View components and optional real callbacks are required");
  }
  const value = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
  const music = value(cachedExports(require, 2813), "default");
  const jsx = value(cachedExports(require, 3), "jsx");
  const Menu = value(cachedExports(require, 74), "default");
  if (!music || typeof music !== "object" ||
      value(music, "$$typeof") !== Symbol.for("react.memo") ||
      typeof value(music, "type") !== "function" || typeof jsx !== "function" || !Menu) {
    throw new Error("The cached CC music memo/JSX/menu shape is unsupported");
  }
  return installPatches([{
    target: music, key: "type",
    wrap: original => function NavidromeMusicMenu(...args) {
      const element = Reflect.apply(original, this, args);
      const props = element && value(element, "props");
      const stockGetMenu = props && value(props, "getMenu");
      if (!props || value(element, "type") !== Menu ||
          value(props, "icon") !== "music" || value(props, "menuWidth") !== 1040 ||
          typeof stockGetMenu !== "function" || value(element, "ref") != null) {
        throw new Error("CC music render no longer matches the captured menu contract");
      }
      const key = value(element, "key");
      return jsx(Menu, {
        ...props,
        getMenu: function (...menuArgs) {
          const menuThis = this;
          const local = jsx(LocalMusic, {
            shellProps: menuArgs[0], client, library, onLogin, onPlay,
            // The original lazy module load occurs only on explicit stock choice.
            renderStockMusic: () => Reflect.apply(stockGetMenu, menuThis, menuArgs),
          });
          return jsx(View, { style: { height: 810 }, children: local });
        },
      }, key == null ? undefined : key);
    },
  }]);
}

const READ_FIELDS = ["name", "kind", "iconId", "serviceType", "serviceName",
  "installDeeplink", "linkDeeplink", "playDeeplink"];
const STATE_FIELDS = ["installed", "installedTitleId", "linked", "ready",
  "compatible", "explicitDisabled", "explicitContentPolicy", "musicVideosDisabled"];

function validateDescriptor(descriptor) {
  if (!descriptor || descriptor.serviceName !== SERVICE ||
      descriptor.serviceRequiresProfile !== false ||
      descriptor.kind !== "streaming" || descriptor.type !== "service" ||
      descriptor.strandType !== "service") {
    throw new TypeError("An explicit Navidrome service descriptor is required");
  }
  if (!Number.isInteger(descriptor.serviceType) || descriptor.serviceType < 4 ||
      descriptor.serviceType > 20) {
    throw new TypeError("Supply an established distinct native service type; there is no default");
  }
  for (const key of ["name", "iconId", "installedTitleId", "browseServiceString"]) {
    if (typeof descriptor[key] !== "string" || descriptor[key].length === 0) {
      throw new TypeError(`Missing service descriptor field: ${key}`);
    }
  }
  for (const key of ["installed", "ready", "compatible", "explicitDisabled", "musicVideosDisabled"]) {
    if (typeof descriptor[key] !== "boolean") throw new TypeError(`Expected boolean: ${key}`);
  }
  if (!["unknown", "not_linked", "linked", "notavailable", "ready"].includes(descriptor.linked)) {
    throw new TypeError("Invalid local account state");
  }
  if (descriptor.ready && (!descriptor.installed || !descriptor.compatible || descriptor.linked !== "linked")) {
    throw new TypeError("Ready requires the supplied installed, compatible and connected state");
  }
}

/**
 * Optional model binding; it is not needed for the independent local entry.
 * Keeps _services unchanged, so Sony's initialize/linkServices discovery never
 * receives the local descriptor. No account/ready flag is synthesized here.
 * Descriptor identity (name/type) remains fixed until uninstall; state stays live.
 */
export function installMusicServicesModel({ require, firmware, bundleSha256, descriptor } = {}) {
  assertIdentity({ firmware, bundleSha256 });
  validateDescriptor(descriptor);
  const type = descriptor.serviceType;
  const Model = cachedExports(require, 325).MusicServices;
  if (typeof Model !== "function" || !Model.prototype) throw new Error("MusicServices is unavailable");
  const prototype = Model.prototype;
  const originals = {};
  for (const key of ["getServiceItems", "getServiceByName", "getServiceByType"]) {
    const method = Object.getOwnPropertyDescriptor(prototype, key);
    if (!method || typeof method.value !== "function") throw new Error(`Missing MusicServices.${key}`);
    originals[key] = method.value;
  }
  const wrappers = new WeakMap();
  function local(model) {
    if (descriptor.serviceName !== SERVICE || descriptor.serviceType !== type) {
      throw new Error("Navidrome identity changed; uninstall before changing it");
    }
    const existing = originals.getServiceItems.call(model);
    if (!Array.isArray(existing) || existing.some(item =>
      item && (item.serviceName === SERVICE || item.serviceType === type))) {
      throw new Error("Navidrome conflicts with an existing MusicServices entry");
    }
    let wrapper = wrappers.get(model);
    if (!wrapper) {
      wrapper = {};
      Object.defineProperty(wrapper, "serviceData", { enumerable: true, get: () => descriptor });
      Object.defineProperty(wrapper, "browseString", { enumerable: true, get: () => descriptor.browseServiceString });
      for (const key of READ_FIELDS) {
        Object.defineProperty(wrapper, key, { enumerable: true, get: () => descriptor[key] });
      }
      for (const key of STATE_FIELDS) {
        Object.defineProperty(wrapper, key, {
          enumerable: true, get: () => descriptor[key], set: value => { descriptor[key] = value; },
        });
      }
      wrappers.set(model, wrapper);
    }
    return wrapper;
  }
  return installPatches([
    { target: prototype, key: "getServiceItems", wrap: original => function (...args) {
      const items = original.apply(this, args);
      return [...items, local(this)];
    } },
    { target: prototype, key: "getServiceByName", wrap: original => function (name, ...rest) {
      return name === SERVICE ? local(this) : original.call(this, name, ...rest);
    } },
    { target: prototype, key: "getServiceByType", wrap: original => function (serviceType, ...rest) {
      return serviceType === type ? local(this) : original.call(this, serviceType, ...rest);
    } },
    { target: prototype, key: "getProductNameByServiceName", wrap: original => function (name, ...rest) {
      return name === SERVICE ? local(this).name : original.call(this, name, ...rest);
    } },
    { target: prototype, key: "hasInstalledStreamingServices", wrap: original => function (...args) {
      return original.apply(this, args) || local(this).installed;
    } },
    { target: prototype, key: "hasCompatibleStreamingServices", wrap: original => function (...args) {
      return original.apply(this, args) || local(this).compatible;
    } },
  ]);
}
