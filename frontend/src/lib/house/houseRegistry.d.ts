// Types for houseRegistry.js. The runtime is plain JS so the marketplace's .jsx and the
// lending desk's .ts read the same list (houseRegistryCore.js holds the logic).

/** The parsed houseRegistry.json (version 1). */
export interface HouseRegistryJson {
  version: number;
  note?: string;
  wallets: readonly {
    /** 0x + 40 hex, checksummed in the file. */
    address: string;
    label: string;
    /** OpenSea slugs the wallet bids on, e.g. "junglebay", "gnssart". */
    collections: readonly string[];
    /** YYYY-MM-DD. */
    since: string;
  }[];
}

/** What a collection bid still buys, and the collection's chip ("JBAC", "GNSS"). */
export interface HouseBid {
  remaining?: number | string | null;
  chip?: string | null;
}

export interface HouseRegistry {
  houseWallets(): string[];
  isHouseWallet(address: string | null | undefined): boolean;
  houseLabel(address: string | null | undefined): string | null;
  houseBidLabel(address: string | null | undefined, bid?: HouseBid): string | null;
}

export declare const HOUSE_LABEL: 'House';
export declare function createHouseRegistry(json: unknown): HouseRegistry;

/** The house wallets, lowercase. A new array on every call. */
export declare function houseWallets(): string[];
/** True for a registered house wallet in any letter case; false for anything not 0x + 40 hex. */
export declare function isHouseWallet(address: string | null | undefined): boolean;
/** "House" for a house wallet, else null. */
export declare function houseLabel(address: string | null | undefined): string | null;
/** "House · buys N (any TICKER)" for a house collection bid, "House" when N or the ticker is unknown, else null. */
export declare function houseBidLabel(address: string | null | undefined, bid?: HouseBid): string | null;
