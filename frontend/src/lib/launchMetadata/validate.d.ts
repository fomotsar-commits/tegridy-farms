// Types for validate.js, the launch-metadata rules shared by the browser form and
// api/launch-upload.js. The runtime is plain JS so the Vercel lambda can import it
// (see validate.js's header and src/lib/merkle/core.d.ts for the same layout).

export declare const LIMITS: Readonly<{
  nameBytes: 32;
  symbolMin: 2;
  symbolMax: 10;
  descriptionChars: 280;
  linkBytes: 120;
  imageBytes: 1048576;
  uriBytes: 100;
  maxImageSide: 4096;
  targetImageSide: 1024;
  metadataJsonBytes: 65536;
}>;

export declare const UPLOAD_SIGNATURE_TTL_MS: number;
export declare const CREATED_ON: string;
export declare const RESERVED_SYMBOLS: readonly string[];
export declare const RESERVED_NAMES: readonly string[];
export declare const BRAND_WORDS: readonly string[];

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface LaunchLinks {
  website?: string;
  twitter?: string;
  telegram?: string;
}
export type LinkKind = keyof LaunchLinks;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** The metadata file a launch made on this site pins, field for field. */
export interface LaunchMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  mint: string;
  createdOn: string;
}

/**
 * A metadata file read back from IPFS/Arweave, written by ANY client. Every string is
 * already display-safe; `image` is null when it is not a content address; a link that
 * failed its check is absent; `mint` is null when the file does not name a valid one.
 */
export interface ReadLaunchMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string | null;
  website?: string;
  twitter?: string;
  telegram?: string;
  mint: string | null;
}

export type ParsedMetadata =
  | { kind: 'ok'; json: ReadLaunchMetadata; mintMatches: boolean; issues: string[] }
  | { kind: 'invalid'; reason: string };

export declare function foldForCompare(s: string): string;
/** What a name or symbol would be mistaken for (e.g. "SOL", "TEGRIDY"), or null. */
export declare function impersonates(text: string): string | null;
export declare function impersonationWarning(t: { name?: string | null; symbol?: string | null }): string | null;

/** NFC, trimmed, no control/bidi/zero-width/invisible characters, at most 32 UTF-8 bytes, not a reserved name. */
export declare function checkName(raw: unknown): Checked<string>;
/** Upper-cased; ASCII A-Z0-9 only, 2-10 characters, not a reserved ticker or a lookalike of one. */
export declare function checkSymbol(raw: unknown): Checked<string>;
/** Optional (empty is fine); line breaks allowed, at most 280 characters. */
export declare function checkDescription(raw: unknown): Checked<string>;
/** One link. Empty means "none" and gives `value: undefined`. Returns the canonical https URL. */
export declare function checkLink(kind: LinkKind, raw: unknown): Checked<string | undefined>;
export declare function checkLinks(l: LaunchLinks | null | undefined):
  | { ok: true; value: LaunchLinks }
  | { ok: false; field: LinkKind; reason: string };

/** For ANY on-chain or off-chain text another client could have written. Never throws. */
export declare function displaySafe(s: unknown, maxChars: number): string;

/** By magic bytes. SVG and everything else is refused. Also bounds the decoded size. */
export declare function sniffImage(bytes: Uint8Array):
  | { ok: true; mime: ImageMime; width: number; height: number }
  | { ok: false; reason: string };
/** EXIF / XMP / IPTC / PNG text chunks present. */
export declare function hasEmbeddedMetadata(bytes: Uint8Array, mime: ImageMime): boolean;

/** Exactly https://ipfs.io/ipfs/<cid> or https://arweave.net/<43-char id>, at most 100 bytes. */
export declare function checkContentUri(uri: unknown): Checked<string>;
export declare function ipfsUri(cid: string): string | null;

export declare function isPubkeyString(s: unknown): s is string;
export declare function pubkeyBytes(s: unknown): Uint8Array | null;

export declare function buildMetadataJson(i: {
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  links: LaunchLinks;
  mint: string;
}): LaunchMetadataJson;
export declare function parseLaunchMetadataJson(text: string, expectedMint: string): ParsedMetadata;

export interface UploadAuthFields {
  name: string;
  symbol: string;
  mint: string;
  creator: string;
  detailsSha256: string;
  imageSha256: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
}
export declare function detailsDigestInput(d: { name: string; symbol: string; description: string; links: LaunchLinks }): string;
export declare function uploadAuthMessage(m: UploadAuthFields): string;
export declare function sha256Hex(input: Uint8Array | string): Promise<string>;
