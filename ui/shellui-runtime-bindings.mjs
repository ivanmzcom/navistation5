/** Offline-recovered CC bindings; importing this file invokes no native method. */
import { CONTROL_CENTER_HBC_SHA256 } from "./shellui-provider-hook.mjs";

function ownValue(object, key) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function randomExport(require) {
  const cache = ownValue(require, "c");
  const record = ownValue(cache, "1406");
  if (ownValue(record, "l") !== true) return undefined;
  return ownValue(ownValue(record, "exports"), "Random");
}

/**
 * CC module 1406 / factory #17190 -> Random.generateSecureRandom(length).
 * #17193 calls VshTmSystemRandomModule.GenerateSecureRandom; #17194 decodes
 * its base64 result with module 344.toByteArray. See docs/ARCHITECTURE.md.
 * The caller measures firmware/bundle identity; supplied values are not proof
 * of context identity. Missing/unloaded modules fail; require() is never called.
 * This supplies randomBytes(16) for OpenSubsonic, not a complete network client.
 */
export function createCCRandomBytes({ require, firmware, bundleSha256 } = {}) {
  if (firmware !== 0x13200006 || bundleSha256 !== CONTROL_CENTER_HBC_SHA256 ||
      typeof require !== "function") {
    throw new TypeError("The captured Control Center runtime is required");
  }
  const random = randomExport(require);
  const generate = ownValue(random, "generateSecureRandom");
  if (typeof generate !== "function") {
    throw new Error("CC secure random module 1406 must already be loaded");
  }
  return async function randomBytes(length) {
    if (length !== 16) throw new RangeError("OpenSubsonic requires a 16-byte salt");
    try {
      if (randomExport(require) !== random || ownValue(random, "generateSecureRandom") !== generate) {
        throw new Error("Runtime changed");
      }
      const result = await generate.call(random, length);
      if (!result || result.length !== length || randomExport(require) !== random ||
          ownValue(random, "generateSecureRandom") !== generate) throw new Error("Invalid random result");
      const bytes = [];
      for (let index = 0; index < length; index++) {
        const value = result[index];
        if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Invalid byte");
        bytes.push(value);
      }
      return bytes;
    } catch {
      // Native errors are deliberately not retained as a cause or log field.
      throw new Error("PS5 secure random generation failed");
    }
  };
}
