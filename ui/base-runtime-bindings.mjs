import { FIRMWARE, BASE_DLL_HBC_SHA256 } from "./firmware-profile.mjs";
// Binds RNPS secure random bytes through Q9AKMtOM and ZUfSJvzB.

function own(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function"))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// Stable, credential-free diagnostics. Do not copy native exception messages,
// return values, or generated random bytes into an Error or status object.
function rngError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

// The caller verifies the realm. randomBytes(16) has no fallback RNG.
export function createBaseRandomBytes({
  baseRequire,
  firmware,
  baseBundleSha256,
  isRuntimeCurrent,
} = {}) {
  if (firmware !== FIRMWARE)
    throw rngError("NDRNG_FIRMWARE", "Unexpected RNPS firmware");
  if (baseBundleSha256 !== BASE_DLL_HBC_SHA256)
    throw rngError("NDRNG_BUNDLE", "Unexpected shared RNPS bundle");
  if (typeof baseRequire !== "function")
    throw rngError("NDRNG_REQUIRE", "Shared RNPS require is unavailable");
  if (typeof isRuntimeCurrent !== "function")
    throw rngError(
      "NDRNG_CURRENT_GUARD",
      "The RNPS current guard is unavailable",
    );
  if (
    typeof Reflect !== "object" ||
    !Reflect ||
    typeof Reflect.apply !== "function"
  ) {
    throw rngError("NDRNG_REFLECT", "Reflect.apply is unavailable");
  }
  function runtimeCurrent() {
    try {
      return isRuntimeCurrent();
    } catch {
      throw rngError("NDRNG_CURRENT_QUERY", "The RNPS current guard failed");
    }
  }
  if (!runtimeCurrent())
    throw rngError("NDRNG_RUNTIME_CHANGED", "The shared RNPS runtime changed");
  const factories = own(baseRequire, "m"),
    cache = own(baseRequire, "c");
  const registryFactory = own(factories, "Q9AKMtOM"),
    decoderFactory = own(factories, "ZUfSJvzB");
  if (!cache)
    throw rngError("NDRNG_CACHE", "The shared RNPS cache is unavailable");
  if (typeof registryFactory !== "function")
    throw rngError(
      "NDRNG_REGISTRY_FACTORY",
      "The RNPS registry factory is unavailable",
    );
  if (typeof decoderFactory !== "function")
    throw rngError(
      "NDRNG_DECODER_FACTORY",
      "The RNPS base64 factory is unavailable",
    );
  const modules = [];
  function current() {
    return (
      runtimeCurrent() &&
      own(baseRequire, "m") === factories &&
      own(baseRequire, "c") === cache &&
      own(factories, "Q9AKMtOM") === registryFactory &&
      own(factories, "ZUfSJvzB") === decoderFactory &&
      modules.every(
        ({ id, record, exported, factory }) =>
          own(cache, id) === record &&
          own(record, "i") === id &&
          own(record, "l") === true &&
          own(record, "exports") === exported &&
          own(factories, id) === factory,
      )
    );
  }
  function module(id, allowInitialize) {
    const label =
      id === "Q9AKMtOM"
        ? "REGISTRY"
        : id === "ZUfSJvzB"
          ? "DECODER"
          : "NATIVE_MODULES";
    if (!current())
      throw rngError(
        "NDRNG_RUNTIME_CHANGED",
        "The shared RNPS runtime changed",
      );
    const factory = own(factories, id);
    if (typeof factory !== "function")
      throw rngError(
        "NDRNG_" + label + "_FACTORY",
        "A shared RNPS factory is unavailable",
      );
    let record = own(cache, id),
      returned;
    if (record === undefined && allowInitialize) {
      try {
        returned = Reflect.apply(baseRequire, undefined, [id]);
      } catch {
        throw rngError(
          "NDRNG_" + label + "_INITIALIZE",
          "A shared RNPS module could not initialize",
        );
      }
      record = own(cache, id);
    }
    const exported = own(record, "exports");
    if (
      !record ||
      own(record, "i") !== id ||
      own(record, "l") !== true ||
      exported === undefined ||
      (returned !== undefined && returned !== exported)
    ) {
      throw rngError(
        "NDRNG_" + label + "_CACHE",
        "A shared RNPS module did not finish initialization",
      );
    }
    modules.push({ id, record, exported, factory });
    if (!current())
      throw rngError(
        "NDRNG_RUNTIME_CHANGED",
        "The shared RNPS runtime changed",
      );
    return exported;
  }
  const registry = module("Q9AKMtOM", true);
  // Q9AKMtOM already imports NativeModules. Preserve that export identity too.
  module("bX5JscBE", false);
  const decoder = module("ZUfSJvzB", true);
  const get = own(registry, "get"),
    decode = own(decoder, "toByteArray");
  if (typeof get !== "function")
    throw rngError(
      "NDRNG_REGISTRY_EXPORT",
      "The RNPS registry export is unavailable",
    );
  if (typeof decode !== "function")
    throw rngError(
      "NDRNG_DECODER_EXPORT",
      "The RNPS base64 export is unavailable",
    );
  if (!current())
    throw rngError("NDRNG_RUNTIME_CHANGED", "The shared RNPS runtime changed");
  let native;
  try {
    native = Reflect.apply(get, registry, ["VshTmSystemRandomModule"]);
  } catch {
    throw rngError(
      "NDRNG_NATIVE_LOOKUP",
      "The secure random module lookup failed",
    );
  }
  if (!native)
    throw rngError(
      "NDRNG_NATIVE_MISSING",
      "The PS5 secure random native module is unavailable",
    );
  // The native module may be a host object/proxy. Use the observed property get;
  // do not require JS data descriptors that the native bridge need not expose.
  let generate;
  try {
    generate = native.GenerateSecureRandom;
  } catch {
    throw rngError(
      "NDRNG_METHOD_LOOKUP",
      "The secure random method lookup failed",
    );
  }
  if (typeof generate !== "function")
    throw rngError(
      "NDRNG_METHOD_MISSING",
      "The PS5 secure random method is unavailable",
    );
  if (!current())
    throw rngError("NDRNG_RUNTIME_CHANGED", "The shared RNPS runtime changed");
  function assertCurrent() {
    if (
      !current() ||
      own(registry, "get") !== get ||
      own(decoder, "toByteArray") !== decode
    ) {
      throw rngError(
        "NDRNG_RUNTIME_CHANGED",
        "The shared RNPS random runtime changed",
      );
    }
  }
  return async function randomBytes(length) {
    if (length !== 16)
      throw rngError("NDRNG_LENGTH", "OpenSubsonic requires a 16-byte salt");
    let encoded, decoded;
    try {
      assertCurrent();
      let pending;
      try {
        pending = Reflect.apply(generate, native, [length]);
      } catch {
        throw rngError("NDRNG_NATIVE_CALL", "The secure random call failed");
      }
      if (!pending || typeof pending.then !== "function")
        throw rngError("NDRNG_PROMISE", "Missing native random promise");
      try {
        encoded = await pending;
      } catch {
        throw rngError(
          "NDRNG_NATIVE_REJECTED",
          "The secure random request failed",
        );
      }
      assertCurrent();
      // Exactly 16 bytes in padded base64, including canonical trailing bits.
      // The audited shared decoder also accepts the URL-safe alphabet.
      if (
        typeof encoded !== "string" ||
        !/^[A-Za-z0-9+/_-]{21}[AQgw]==$/.test(encoded)
      ) {
        throw rngError("NDRNG_ENCODING", "Invalid native random encoding");
      }
      try {
        decoded = Reflect.apply(decode, undefined, [encoded]);
      } catch {
        throw rngError("NDRNG_DECODE", "Native random decoding failed");
      }
      if (!decoded || decoded.length !== length)
        throw rngError("NDRNG_DECODED_LENGTH", "Invalid native random length");
      const bytes = [];
      for (let index = 0; index < length; index++) {
        const value = decoded[index];
        if (!Number.isInteger(value) || value < 0 || value > 255)
          throw rngError("NDRNG_BYTE", "Invalid random byte");
        bytes.push(value);
      }
      assertCurrent();
      return bytes;
    } catch (error) {
      const code = own(error, "code");
      if (typeof code === "string" && /^NDRNG_[A-Z_]+$/.test(code)) throw error;
      throw rngError("NDRNG_GENERATION", "PS5 secure random generation failed");
    } finally {
      encoded = decoded = undefined;
    }
  };
}
