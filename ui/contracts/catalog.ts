/**
 * Catalog projection observed in Control Center, firmware 0x13200006.
 * HBC SHA256: 8a5ad941d8ca0dedad99df7c1f09c5fc36ce9752a5d0954b92401d24aad8990e
 * Sources: CC factory #14289 @ 0x34cb14; #14294, #14295, #14296; getArtists
 * #1472 @ 0x21e2f6. Raw functions: capture/music-ui-schema-evidence.json.
 *
 * This is the fields consumed/emitted by these functions, not the complete PSN
 * wire schema. `unknown` deliberately preserves fields only copied by code.
 * Optional source fields can become REQUIRED output properties with undefined
 * values, because the bytecode always creates the corresponding output key.
 * `cardType` and `cardSubType` are not closed enums in the observed code.
 */

import type { NativeServiceType } from "./music-services";

/** #1472 invokes artists.join(", ") when length is truthy, otherwise returns " ". */
export type CatalogArtists = readonly unknown[];

/** Only index zero is read; no search by partnerName is performed. */
export interface CatalogPartnerOffer {
  partnerName?: string | null;
  contextUri?: unknown;
  trackUri?: unknown;
  inLibrary?: unknown;
  explicit?: unknown;
  isPlayable?: unknown;
  partnerDeepLink?: unknown;
}

export interface CatalogCardMetadata {
  /** Mandatory if metadata is present: the code directly indexes this array. */
  partnerOffers: readonly (CatalogPartnerOffer | null | undefined)[];
  artists?: CatalogArtists | null;
  imagePrimary?: { url?: unknown } | null;
  releaseDate?: unknown;
  /** Units/representation are NOT established by these projection functions. */
  runLength?: unknown;
  isFullyPlayed?: unknown;
  resumePosition?: unknown;
  descriptionShort?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

/** Raw card read by #14294/#14295/#14296. */
export interface CatalogCard {
  id?: unknown;
  name?: unknown;
  cardType?: string | null;
  cardSubType?: string | null;
  providedName?: unknown;
  songCount?: unknown;
  total?: unknown;
  metadata?: CatalogCardMetadata | null;
}

/** Input to strandsToSections; empty/missing cards skip the strand. */
export interface CatalogHomeStrand {
  id?: unknown;
  name?: string | null;
  partnerName?: string | null;
  cards?: readonly CatalogCard[] | null;
}

/** Source data shape required by the BGS consumer and home projection. */
export interface CatalogHomeResponse {
  strands: readonly CatalogHomeStrand[];
}

/** Detail response read by getStrandCardsModel, #14295. */
export interface CatalogDetailResponse {
  cardType?: string | null;
  metadata?: {
    imagePrimary?: { url?: unknown } | null;
    /** Forwarded unchanged in the returned {srcInfo, tracks}. */
    srcInfo?: unknown;
  } | null;
  strands?: readonly { cards?: readonly CatalogCard[] | null }[] | null;
}

/**
 * Home/collection card emitted by #14294 +0x30b..0x354 and #14296
 * +0x1b4..0x1fd. `uri` is the OFFER'S CONTEXT URI, not its track URI.
 */
export interface MusicHomeCard {
  id: unknown;
  /** Lowercase cardType, or a single space if cardType is null/undefined. */
  type: string;
  cardType: string;
  name: unknown;
  artist: string;
  image_url: unknown;
  uri: unknown;
  trackUri: unknown;
  contextUri: unknown;
  inLibrary: unknown;
  explicit: unknown;
  deeplink: unknown;
  /** card.songCount || card.total, not necessarily a validated number. */
  total: unknown;
  providedName: unknown;
  serviceName: string | null | undefined;
  /** Undefined for an unrecognized partner in the unmodified shipped mapper. */
  serviceType: NativeServiceType | undefined;
  /** #14294 always assigns; #14296 assigns only for truthy cardSubType. */
  subType?: string;
}

/** #14294 +0x15f..0x186: one group per nonempty strand. */
export interface MusicHomeSection {
  name: string;
  /** `sections` contains CARDS; it is not another nested group of sections. */
  sections: MusicHomeCard[];
  serviceName: string | null | undefined;
  serviceType: NativeServiceType | undefined;
  strandId: unknown;
  /** 1-based index assigned as output.length + 1. */
  strandIndex: number;
  /** Original strand name, with " " fallback, before msgid_ translation. */
  strandName: string;
  strandRows: number;
}

/**
 * Track/detail row: all keys emitted by #14295 +0x353..0x3c1.
 * `type`/`strandType` use the DETAIL RESPONSE cardType; `itemType` uses the
 * child's cardType. These are not interchangeable with the home card fields.
 */
export interface MusicTrack {
  id: unknown;
  name: unknown;
  type: string | undefined;
  strandType: string | undefined;
  itemType: string | undefined;
  /** "albumtrack" for parent type album/single; otherwise itemType (#14290). */
  subType: string | undefined;
  artist: string;
  image_url: unknown;
  /** First offer's contextUri. */
  context: unknown;
  /** First offer's trackUri || "no-track-uri". */
  uri: unknown;
  explicit: unknown;
  inLibrary: unknown;
  isPlayable: unknown;
  deeplink: unknown;
  /** Comes from first offer.partnerName, not from the outer strand. */
  serviceName: string | null | undefined;
  serviceType: NativeServiceType | undefined;
  total: unknown;
  releaseDate: unknown;
  runLength: unknown;
  isFullyPlayed: unknown;
  resumePosition: unknown;
  /** Source metadata.descriptionShort. */
  description: unknown;
  startTime: unknown;
  endTime: unknown;
}

export interface MusicTrackList {
  srcInfo: unknown;
  tracks: MusicTrack[];
}

/**
 * Recovered export signatures, #14289. Argument two of getStrandCardsModel is
 * not read in #14295. Its caller-level semantic meaning is still unknown.
 * Argument three === "single" selects the detail response's cover for rows.
 */
export interface MusicCatalogProjectors {
  strandsToSections(
    strands: readonly CatalogHomeStrand[] | null | undefined,
    fallbackPartner: string,
  ): Promise<MusicHomeSection[]>;
  getStrandCardsModel(
    detail: CatalogDetailResponse | null | undefined,
    unusedArgument: unknown,
    coverMode: unknown,
  ): MusicTrackList;
  strandCardToViewItems(
    cards: readonly CatalogCard[],
    partner: string,
  ): MusicHomeCard[];
}

/**
 * Adapter output refinements: deliberate implementation choices, NOT observed
 * PSN constraints. They make a local Navidrome item usable without falsy IDs,
 * empty URI fallbacks or an unresolved provider name/type. Other copied fields
 * remain as above until their representation is established.
 */
export interface NavidromeHomeCard extends MusicHomeCard {
  id: string;
  name: string;
  serviceName: "navidrome";
  serviceType: NativeServiceType;
  uri: string;
  contextUri: string;
}

export interface NavidromeTrack extends MusicTrack {
  id: string;
  name: string;
  serviceName: "navidrome";
  serviceType: NativeServiceType;
  context: string;
  uri: string;
  isPlayable: boolean;
}

/**
 * Our local React screen's models, not a recovered native provider contract.
 * No serviceType property is emitted until native integration is established.
 * These types must not be passed as native descriptors or player selection.
 */
export type LocalNavidromeHomeCard = Omit<NavidromeHomeCard, "serviceType"> & {
  serviceType?: never;
};

export type LocalNavidromeTrack = Omit<NavidromeTrack, "serviceType"> & {
  serviceType?: never;
};

export type LocalNavidromeHomeSection = Omit<MusicHomeSection, "serviceType" | "sections"> & {
  serviceName: "navidrome";
  serviceType?: never;
  sections: LocalNavidromeHomeCard[];
};
