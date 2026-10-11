/**
 * Recovered structural contract, PS5 firmware 0x13200006; static analysis only.
 * Origin: observed Control Center interoperability interfaces on firmware 13.20
 * SHA256: 8a5ad941d8ca0dedad99df7c1f09c5fc36ce9752a5d0954b92401d24aad8990e
 * See docs/ARCHITECTURE.md; console captures are not distributed.
 *
 * CC module 325, factory #4507 @ 0x264c56, +0x437..0x5b1 creates
 * the 21 keys below for Apple and Spotify. This is a descriptor shape, not a
 * provider-registration API. String/boolean annotations describe the intended
 * values observed in those descriptors; they are not a runtime JSON validator.
 * No service slot, title ID, icon resource or native registration is invented.
 */

/** Values supplied by the native Media facade; a number is not registration. */
export type NativeServiceType = number;

/** Exact account-state literals exported by module 325, #4507 +0x405..0x431. */
export type ServiceAccountState =
  | "unknown"
  | "not_linked"
  | "linked"
  | "notavailable"
  | "ready";

export interface MusicServiceDescriptor {
  name: string;
  /** Resource identifier; a Navidrome icon must actually be supplied/resolved. */
  iconId: string;
  strandType: "service";
  type: "service";
  kind: "streaming";
  installedTitleId: string;
  serviceType: NativeServiceType;
  serviceName: string;
  /** Imported constants in the source; their value representation is unresolved. */
  installDeeplink: unknown;
  linkDeeplink: unknown;
  playDeeplink: unknown;
  browseServiceString: string;
  installed: boolean;
  linked: ServiceAccountState;
  ready: boolean;
  compatible: boolean;
  explicitDisabled: boolean;
  /** Apple initially "allowed", Spotify initially ""; no closed enum established. */
  explicitContentPolicy: string;
  musicVideosDisabled: boolean;
  serviceRequiresProfile: boolean;
  telemetryName: string;
}

/**
 * Public getter/setter shape in #4555..#4582. Constructor #4556 stores the
 * descriptor at _serviceData; it does not clone descriptor fields onto `this`.
 * `browseString` is the getter name, `browseServiceString` is its backing key.
 * No getter for serviceRequiresProfile/telemetryName is declared in this class.
 */
export interface MusicServiceModel {
  readonly serviceData: MusicServiceDescriptor;
  readonly name: string;
  readonly kind: "streaming";
  readonly iconId: string;
  readonly serviceType: NativeServiceType;
  readonly serviceName: string;
  readonly browseString: string;
  readonly installDeeplink: unknown;
  readonly linkDeeplink: unknown;
  readonly playDeeplink: unknown;
  installed: boolean;
  installedTitleId: string;
  linked: ServiceAccountState;
  ready: boolean;
  compatible: boolean;
  explicitDisabled: boolean;
  explicitContentPolicy: string;
  musicVideosDisabled: boolean;
}

/** #4583 methods; only signatures directly needed by provider selection. */
export interface MusicServicesSelection {
  getServiceItems(): MusicServiceModel[];
  getServiceByName(name?: string): MusicServiceModel | null | undefined;
  getServiceByType(type?: NativeServiceType): MusicServiceModel | null | undefined;
  isServiceReady(name?: string): boolean | undefined;
  isServiceInstalled(name?: string): boolean | undefined;
  /** #4604 compares the service's linked field with the literal "linked". */
  isServiceLinked(name?: string): boolean;
}

/**
 * Extension design constraint, NOT a shipped PS5 type or observed provider.
 * Append a third descriptor and retain the existing objects and their order.
 * The local serviceType/title/icon/deeplinks must be provided by an established
 * integration route; this contract deliberately supplies no numeric default.
 */
export interface NavidromeServiceDescriptor extends MusicServiceDescriptor {
  serviceName: "navidrome";
  /** Local server account state replaces PSN partner-profile discovery. */
  serviceRequiresProfile: false;
}

export type OriginalBuiltInServiceOrder = readonly [
  MusicServiceDescriptor & { serviceName: "apple" },
  MusicServiceDescriptor & { serviceName: "spotify" },
];

/** Intended extension order; not yet installed or wired into ShellUI. */
export type MusicServiceOrderWithNavidrome = readonly [
  ...OriginalBuiltInServiceOrder,
  NavidromeServiceDescriptor,
];
