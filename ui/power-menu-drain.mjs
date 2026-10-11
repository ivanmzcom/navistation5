// Hermes virtual offsets sum every preceding function size, including deduplicated
// functions. They are not file offsets. See the captured Control Center bundle.
const OFFSETS = { suspend: 0x3dde85, shutdown: 0x3dded3, reboot: 0x3ddf21 };
const own = Object.getOwnPropertyDescriptor;
const value = (object, key) => {
  if (!object || (typeof object !== "object" && typeof object !== "function"))
    return undefined;
  const descriptor = own(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
function clone(object, replacements) {
  const copy = Object.create(Object.getPrototypeOf(object));
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = own(object, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Power menu accessor");
    Object.defineProperty(copy, key, {
      ...descriptor,
      ...(Object.prototype.hasOwnProperty.call(replacements, key)
        ? { value: replacements[key] }
        : {}),
    });
  }
  return copy;
}

export function createPowerMenuDrain({
  matchesLocation,
  isRuntimeCurrent,
  beforePower,
  scheduleTimer,
  cancelTimer,
  onState,
} = {}) {
  if (
    [
      matchesLocation,
      isRuntimeCurrent,
      beforePower,
      scheduleTimer,
      cancelTimer,
    ].some((fn) => typeof fn !== "function")
  ) {
    throw new Error("Power menu bindings unavailable");
  }
  const wrappers = new WeakMap();
  let menus = 0,
    pending = false,
    requests = 0,
    lastAction = "",
    drain = "not-requested";
  const status = () => ({ menus, pending, requests, lastAction, drain });
  function notify() {
    try {
      onState?.();
    } catch {}
  }
  function wrap(callback, action) {
    if (wrappers.has(callback)) return wrappers.get(callback);
    function powerRequest(...args) {
      // Captured Sony callbacks return undefined. Preserve that contract and
      // forward their receiver/arguments exactly once after the bounded drain.
      if (pending) return;
      let current = false;
      try {
        current = isRuntimeCurrent() === true;
      } catch {}
      if (!current) return Reflect.apply(callback, this, args);
      pending = true;
      requests++;
      lastAction = action;
      drain = "pending";
      notify();
      const receiver = this;
      let forwarded = false,
        timer;
      function forward(result) {
        if (forwarded) return;
        forwarded = true;
        if (timer !== undefined) {
          try {
            cancelTimer(timer);
          } catch {}
        }
        drain = result;
        // A failed Stop must never prevent the user's normal power action.
        try {
          Reflect.apply(callback, receiver, args);
        } catch {
          drain = "forward-failed";
        }
        pending = false;
        notify();
      }
      try {
        timer = scheduleTimer(() => forward("timeout"), 10000);
        Promise.resolve(beforePower()).then(
          () => forward("confirmed"),
          () => forward("failed"),
        );
      } catch {
        forward("failed");
      }
    }
    wrappers.set(callback, powerRequest);
    return powerRequest;
  }
  function decorate(props) {
    try {
      const items = value(props, "listItems");
      if (!Array.isArray(items) || items.length !== 3 || !isRuntimeCurrent())
        return props;
      const ids = ["suspend", "shutdown", "reboot"];
      for (let index = 0; index < 3; index++) {
        const item = value(items, String(index)),
          id = ids[index],
          callback = value(item, "onPress");
        if (
          value(item, "id") !== id ||
          typeof callback !== "function" ||
          callback.length !== 0 ||
          !matchesLocation(callback, OFFSETS[id])
        )
          return props;
      }
      const replaced = ids.map((id, index) => {
        const item = value(items, String(index));
        return index === 0
          ? item
          : clone(item, { onPress: wrap(value(item, "onPress"), id) });
      });
      const result = clone(props, { listItems: replaced });
      menus++;
      notify();
      return result;
    } catch {
      return props;
    }
  }
  return Object.freeze({ decorate, status });
}
