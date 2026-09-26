// Launch metadata: the ONE set of rules for a token's name, symbol, description,
// links and picture, shared by the browser form and by api/launch-upload.js.
//
// Why plain JS with a sibling .d.ts: a Vercel lambda cannot import a .ts module,
// and a second copy of these rules on the server is how the two sides drift until
// the form accepts something the server refuses, or the server accepts something
// the form never would. src/lib/merkle/core.js is the precedent for this layout.
//
// What these rules protect against. The name, symbol and picture are written into
// a Metaplex metadata account that the launch LOCKS (is_mutable = false), and the
// files sit on IPFS under content addresses, so nothing here can be corrected
// after the fact. And every wallet, explorer and aggregator renders them. So:
//   * no control, bidi, zero-width or invisible characters (a name that renders as
//     "USDC" in one client and as something else in another, or as nothing at all);
//   * the symbol is plain ASCII A-Z and 0-9, so it cannot use lookalike letters;
//   * our own brand words, the chain's native tickers and the big stablecoins are
//     refused, including their lookalike spellings (S0L, ЅOL, U5DC);
//   * links are https only, on hosts a reader can check;
//   * the picture is PNG, JPEG, WebP or GIF by its BYTES (never its file name or
//     declared type), never SVG (which can carry script), bounded in size and in
//     pixel count, and carries no embedded camera data (a phone photo's EXIF block
//     includes where it was taken, and IPFS keeps it forever).
//
// Text another client wrote (a launch made outside this site) goes through
// `displaySafe` and `checkLink` on READ. The upload-side checks do not protect
// that path, because nothing forced that creator through them.

import { base58 } from "@scure/base";

export const LIMITS = Object.freeze({
  /** Metaplex MAX_NAME_LENGTH, in UTF-8 bytes. */
  nameBytes: 32,
  symbolMin: 2,
  /** Metaplex MAX_SYMBOL_LENGTH, in bytes (the symbol is ASCII, so also characters). */
  symbolMax: 10,
  descriptionChars: 280,
  linkBytes: 120,
  /** The uploaded picture, after the browser has shrunk it. */
  imageBytes: 1048576,
  /**
   * The metadata URI. Metaplex allows 200, but the launch transaction sits close to
   * the 1,232-byte packet limit, and every allowed URI form fits in 80.
   */
  uriBytes: 100,
  /** Widest or tallest picture accepted. A small file can still decode to a huge bitmap. */
  maxImageSide: 4096,
  /** What the browser shrinks a picture to before upload. */
  targetImageSide: 1024,
  /** Largest metadata JSON we will read from IPFS or Arweave. */
  metadataJsonBytes: 65536,
});

/** How long a signed upload request stays valid. */
export const UPLOAD_SIGNATURE_TTL_MS = 10 * 60 * 1000;

/** Where a launch made on this site says it was made. */
export const CREATED_ON = "https://memetic.fun";

// ── reserved words ──────────────────────────────────────────────────────────

/** Tickers nobody may launch under, and which read as a warning on any launch. */
export const RESERVED_SYMBOLS = Object.freeze([
  // the chain and its wrapped form
  "SOL", "WSOL",
  // dollars
  "USD", "USDC", "USDT", "PYUSD", "USDS", "USDE", "DAI",
  // other chains' majors, as bridged onto Solana
  "ETH", "WETH", "BTC", "WBTC", "CBBTC",
  // the largest Solana tokens, the usual targets of copies
  "JUP", "BONK", "WIF", "PYTH", "JTO", "RAY",
  // ours
  "TOWELI", "TEGRIDY", "BAYLA", "MEMETIC", "MEMETICS",
]);

/** Names nobody may launch under (compared after folding lookalikes). */
export const RESERVED_NAMES = Object.freeze([
  "SOLANA", "WRAPPED SOL", "USD COIN", "TETHER", "TETHER USD", "PAYPAL USD",
  "ETHEREUM", "WRAPPED ETHER", "BITCOIN", "WRAPPED BITCOIN", "JUPITER", "BONK",
  "DOGWIFHAT", "PYTH NETWORK", "JITO", "RAYDIUM",
]);

/** Our own brand words: refused ANYWHERE in a name or symbol, not only as the whole. */
export const BRAND_WORDS = Object.freeze(["TEGRIDY", "TOWELI", "BAYLA", "MEMETIC"]);

// Letters from other scripts that render like Latin capitals, and the digit and
// symbol swaps people use for the same trick. Folded to one skeleton on BOTH sides
// of every comparison, so "S0L" and "SOL" compare equal.
const CONFUSABLES = new Map(Object.entries({
  // Cyrillic
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P",
  "С": "C", "Т": "T", "Х": "X", "У": "Y", "Ѕ": "S", "І": "I", "Ј": "J", "Ԛ": "Q", "Ԝ": "W",
  // Greek
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M",
  "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  // digits and symbols
  "0": "O", "1": "I", "3": "E", "5": "S", "$": "S", "8": "B", "|": "I", "!": "I",
  // lower-case L folds with I and 1 (after upper-casing it is "L")
  "L": "I",
}));

/**
 * The comparison skeleton: compatibility-normalised, upper-cased, lookalikes
 * folded, everything that is not A-Z or 0-9 removed.
 */
export function foldForCompare(s) {
  if (typeof s !== "string") return "";
  const upper = s.normalize("NFKC").toUpperCase();
  let out = "";
  for (const ch of upper) {
    const mapped = CONFUSABLES.get(ch) ?? ch;
    if (/^[A-Z0-9]$/.test(mapped)) out += mapped;
  }
  return out;
}

const FOLDED_SYMBOLS = new Map(RESERVED_SYMBOLS.map((s) => [foldForCompare(s), s]));
const FOLDED_NAMES = new Map(RESERVED_NAMES.map((s) => [foldForCompare(s), s]));
const FOLDED_BRANDS = BRAND_WORDS.map((s) => [foldForCompare(s), s]);

/**
 * A brand word inside a longer name. Long brand words are searched for anywhere
 * ("TegridyFarms", "Official Toweli"); a short one only at the start of a word, or
 * "Bay Lagoon" (folded BAYIAGOON) would read as BAYLA.
 */
function containsBrand(text) {
  const whole = foldForCompare(text);
  const words = String(text).normalize("NFKC").split(/[^\p{L}\p{N}$|!]+/u).map(foldForCompare).filter(Boolean);
  for (const [folded, word] of FOLDED_BRANDS) {
    if (whole === folded) return word;
    if (folded.length >= 6 ? whole.includes(folded) : words.some((w) => w.startsWith(folded))) return word;
  }
  return null;
}

/**
 * What a name or symbol would be mistaken for, or null. Used on upload (to refuse)
 * and on read (to warn about a launch made anywhere).
 */
export function impersonates(text) {
  const f = foldForCompare(text);
  if (!f) return null;
  if (FOLDED_SYMBOLS.has(f)) return FOLDED_SYMBOLS.get(f);
  if (FOLDED_NAMES.has(f)) return FOLDED_NAMES.get(f);
  return containsBrand(text);
}

/** Plain-English warning for a launch's name and symbol, or null when neither copies anything. */
export function impersonationWarning({ name, symbol }) {
  const hit = impersonates(symbol ?? "") ?? impersonates(name ?? "");
  return hit ? `This looks like ${hit}. It is not ${hit}: check the full mint address.` : null;
}

// ── text ────────────────────────────────────────────────────────────────────

const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/**
 * Characters that render as nothing but are LETTERS or symbols by category, so a
 * category check misses them: Hangul fillers, the braille blank, the Mongolian
 * vowel separator. They are how a "blank" name gets made.
 */
const INVISIBLE_LETTERS = /\u115F|\u1160|\u3164|\uFFA0|\u2800|\u180E|\u17B4|\u17B5/u;
const INVISIBLE_LETTERS_ALL = new RegExp(INVISIBLE_LETTERS.source, "gu");

/** C0 and C1 controls, DEL, and the Unicode line/paragraph separators. */
const isControl = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
const hasControl = (s) => [...s].some((ch) => isControl(ch.codePointAt(0)));
const controlsToSpace = (s) => [...s].map((ch) => (isControl(ch.codePointAt(0)) ? " " : ch)).join("");

/** A zero-width joiner is only allowed INSIDE an emoji sequence (a family, a flag with a person). */
const LONE_ZWJ = /(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/u;
const LONE_ZWJ_ALL = new RegExp(LONE_ZWJ.source, "gu");

/** The shared refusals for any single-line text a creator types. Returns a reason or null. */
function lineProblem(s) {
  if (hasControl(s)) return "It has a control character or line break in it.";
  if (INVISIBLE_LETTERS.test(s)) return "It has an invisible character in it.";
  // Format characters: bidi overrides and isolates, zero-width space and joiners,
  // soft hyphen, tag characters. Everything in the class except a ZWJ inside emoji.
  const withoutEmojiJoins = s.replace(/(?<=\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu, "");
  if (/\p{Cf}/u.test(withoutEmojiJoins) || LONE_ZWJ.test(s)) {
    return "It has a hidden formatting character in it (text direction or zero width).";
  }
  if (/\p{Cs}|\p{Cn}|\p{Co}/u.test(s)) return "It has a character that is not a real, assigned character.";
  if (/[^\S ]|\p{Zs}/u.test(s.replace(/ /g, ""))) return "Use ordinary spaces only.";
  if (/\p{M}{3,}/u.test(s)) return "Too many accent marks stacked on one letter.";
  return null;
}

export function checkName(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a name." };
  const value = raw.normalize("NFC").trim();
  if (!value) return { ok: false, reason: "Enter a name." };
  const problem = lineProblem(value);
  if (problem) return { ok: false, reason: problem };
  if (/ {2,}/.test(value)) return { ok: false, reason: "Use single spaces between words." };
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(value)) {
    return { ok: false, reason: "The name needs at least one letter, number or emoji." };
  }
  if (utf8Bytes(value) > LIMITS.nameBytes) {
    return { ok: false, reason: `Too long: at most ${LIMITS.nameBytes} bytes (emoji and accented letters count as more than one).` };
  }
  const copies = impersonates(value);
  if (copies) return { ok: false, reason: `This name can be mistaken for ${copies}, so it is not allowed.` };
  return { ok: true, value };
}

export function checkSymbol(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a symbol." };
  const value = raw.trim().replace(/^\$/, "").toUpperCase();
  if (!value) return { ok: false, reason: "Enter a symbol." };
  if (!/^[A-Z0-9]+$/.test(value)) {
    return { ok: false, reason: "Use only the letters A to Z and the digits 0 to 9." };
  }
  if (value.length < LIMITS.symbolMin || value.length > LIMITS.symbolMax) {
    return { ok: false, reason: `Use ${LIMITS.symbolMin} to ${LIMITS.symbolMax} characters.` };
  }
  const copies = impersonates(value);
  if (copies) return { ok: false, reason: `This symbol can be mistaken for ${copies}, so it is not allowed.` };
  return { ok: true, value };
}

export function checkDescription(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, reason: "The description must be text." };
  const value = raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim().replace(/\n{3,}/g, "\n\n");
  const problem = value.split("\n").map(lineProblem).find(Boolean);
  if (problem) return { ok: false, reason: problem };
  if ([...value].length > LIMITS.descriptionChars) {
    return { ok: false, reason: `Too long: at most ${LIMITS.descriptionChars} characters.` };
  }
  return { ok: true, value };
}

/**
 * Make text that someone else wrote safe to put on screen: strips control, bidi,
 * zero-width and invisible characters, caps stacked accents, collapses whitespace,
 * and cuts to `maxChars` characters. It never throws and always returns a string.
 */
export function displaySafe(s, maxChars) {
  if (typeof s !== "string") return "";
  let t = controlsToSpace(s.normalize("NFC"))
    .replace(INVISIBLE_LETTERS_ALL, "")
    // Every format character except a joiner; then every joiner not inside an emoji.
    .replace(/(?!\u200D)\p{Cf}|\p{Cs}|\p{Cn}|\p{Co}/gu, "")
    .replace(LONE_ZWJ_ALL, "")
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const max = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 64;
  const chars = [...t];
  if (chars.length > max) t = chars.slice(0, Math.max(1, max - 1)).join("") + "…";
  return t;
}

// ── links ───────────────────────────────────────────────────────────────────

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const TG_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TG_NAME = /^(?:[A-Za-z][A-Za-z0-9_]{3,31}|\+[A-Za-z0-9_-]{10,40})$/;

function parseHttps(raw) {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u;
}

/**
 * One link, by kind. Empty input means "no link" and is fine. Returns the
 * canonical https URL to store and to render.
 */
export function checkLink(kind, raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, reason: "A link must be text." };
  const s = raw.trim();
  if (!s) return { ok: true, value: undefined };
  if (utf8Bytes(s) > LIMITS.linkBytes) return { ok: false, reason: `Too long: at most ${LIMITS.linkBytes} characters.` };
  if (/[\s<>"'`\\]/.test(s) || lineProblem(s)) return { ok: false, reason: "This link has characters a link cannot have." };

  if (kind === "twitter") {
    const handle = s.startsWith("@") ? s.slice(1) : null;
    if (handle !== null || X_HANDLE.test(s)) {
      const h = handle ?? s;
      return X_HANDLE.test(h) ? { ok: true, value: `https://x.com/${h}` } : { ok: false, reason: "That is not an X handle." };
    }
    const u = parseHttps(s);
    if (!u || u.protocol !== "https:" || !X_HOSTS.has(u.hostname) || u.username || u.password || u.port || u.search || u.hash) {
      return { ok: false, reason: "Use an x.com link or an @handle." };
    }
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return m ? { ok: true, value: `https://x.com/${m[1]}` } : { ok: false, reason: "Link to a profile, like x.com/yourname." };
  }

  if (kind === "telegram") {
    if (s.startsWith("@") || TG_NAME.test(s)) {
      const n = s.startsWith("@") ? s.slice(1) : s;
      return TG_NAME.test(n) ? { ok: true, value: `https://t.me/${n}` } : { ok: false, reason: "That is not a Telegram name." };
    }
    const u = parseHttps(s);
    if (!u || u.protocol !== "https:" || !TG_HOSTS.has(u.hostname) || u.username || u.password || u.port || u.search || u.hash) {
      return { ok: false, reason: "Use a t.me link or an @name." };
    }
    const m = u.pathname.match(/^\/((?:joinchat\/)?[^/]+)\/?$/);
    const name = m ? m[1].replace(/^joinchat\//, "+") : null;
    return name && TG_NAME.test(name) ? { ok: true, value: `https://t.me/${name}` } : { ok: false, reason: "Link to a group or channel, like t.me/yourgroup." };
  }

  if (kind === "website") {
    const u = parseHttps(s);
    if (!u || u.protocol !== "https:") return { ok: false, reason: "Use an https:// link." };
    if (u.username || u.password) return { ok: false, reason: "A link cannot carry a user name or password." };
    if (u.port) return { ok: false, reason: "Use a link without a port number." };
    const host = u.hostname;
    if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
      return { ok: false, reason: "Use a normal website address, not a number or a local name." };
    }
    // The URL parser turns a non-Latin host into xn-- form. Those are how a lookalike
    // of a real site is spelled (phantοm.app with a Greek o), so they are refused.
    if (host.split(".").some((label) => label.startsWith("xn--"))) {
      return { ok: false, reason: "Use a website address in plain Latin letters." };
    }
    if (utf8Bytes(u.href) > LIMITS.linkBytes) return { ok: false, reason: `Too long: at most ${LIMITS.linkBytes} characters.` };
    return { ok: true, value: u.href };
  }

  return { ok: false, reason: "Unknown kind of link." };
}

export function checkLinks(l) {
  const src = l && typeof l === "object" ? l : {};
  const value = {};
  for (const field of ["website", "twitter", "telegram"]) {
    const r = checkLink(field, src[field]);
    if (!r.ok) return { ok: false, field, reason: r.reason };
    if (r.value !== undefined) value[field] = r.value;
  }
  return { ok: true, value };
}

// ── picture ─────────────────────────────────────────────────────────────────

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function sniffMime(b) {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 20 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

/** Walk JPEG segments up to the image data. Calls `visit(marker, start, length)`; stops when it returns a value. */
function walkJpeg(b, visit) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i += 1; m = b[i + 1]; }
    if (m === 0xd9 || m === 0xda) return null; // end of image, or start of scan: no more headers
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const r = visit(m, i + 4, len - 2);
    if (r !== undefined) return r;
    i += 2 + len;
  }
  return null;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function dimensions(b, mime) {
  if (mime === "image/png") {
    if (ascii(b, 12, 4) !== "IHDR") return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (mime === "image/gif") return { width: u16le(b, 6), height: u16le(b, 8) };
  if (mime === "image/webp") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") {
      if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      if (b.length < 30) return null;
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    return walkJpeg(b, (m, start, len) => (JPEG_SOF.has(m) && len >= 5 ? { width: u16be(b, start + 3), height: u16be(b, start + 1) } : undefined));
  }
  return null;
}

/**
 * What the file IS, by its first bytes, and how big it decodes to. SVG, HTML and
 * anything else is refused whatever it is called.
 */
export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "No picture was given." };
  if (bytes.length === 0) return { ok: false, reason: "The picture is empty." };
  if (bytes.length > LIMITS.imageBytes) return { ok: false, reason: "The picture is larger than 1 MB." };
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, reason: "Use a PNG, JPEG, WebP or GIF picture." };
  const dim = dimensions(bytes, mime);
  if (!dim || !(dim.width > 0) || !(dim.height > 0)) return { ok: false, reason: "The picture looks damaged: its size could not be read." };
  if (dim.width > LIMITS.maxImageSide || dim.height > LIMITS.maxImageSide) {
    return { ok: false, reason: `The picture is too big: at most ${LIMITS.maxImageSide} by ${LIMITS.maxImageSide} pixels.` };
  }
  return { ok: true, mime, width: dim.width, height: dim.height };
}

/**
 * True when the file carries an embedded metadata block (EXIF, XMP, IPTC, text
 * chunks). A phone photo's EXIF includes the GPS position it was taken at, and a
 * pinned file cannot be taken back. The browser re-draws every picture, which drops
 * these blocks; the server refuses one that still has them.
 */
export function hasEmbeddedMetadata(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return false;
  if (mime === "image/jpeg") {
    return walkJpeg(bytes, (m, start, len) => {
      if (m === 0xe1 && len >= 6) {
        const head = ascii(bytes, start, Math.min(len, 29));
        if (head.startsWith("Exif") || head.startsWith("http://ns.adobe.com/xap")) return true;
      }
      if (m === 0xed) return true; // APP13: Photoshop / IPTC
      return undefined;
    }) === true;
  }
  if (mime === "image/png") {
    let i = 8;
    while (i + 12 <= bytes.length) {
      const len = u32be(bytes, i);
      const type = ascii(bytes, i + 4, 4);
      if (type === "eXIf" || type === "tEXt" || type === "iTXt" || type === "zTXt") return true;
      if (type === "IEND") return false;
      i += 12 + len;
    }
    return false;
  }
  if (mime === "image/webp") {
    let i = 12;
    while (i + 8 <= bytes.length) {
      const type = ascii(bytes, i, 4);
      const len = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
      if (type === "EXIF" || type === "XMP ") return true;
      i += 8 + len + (len & 1);
    }
    return false;
  }
  if (mime === "image/gif") {
    // XMP rides in an application extension named "XMP DataXMP".
    const needle = "XMP DataXMP";
    for (let i = 0; i + needle.length <= bytes.length; i++) {
      if (bytes[i] === 0x58 && ascii(bytes, i, needle.length) === needle) return true;
    }
    return false;
  }
  return false;
}

// ── content addresses ───────────────────────────────────────────────────────

// An IPFS content id: v0 (Qm…) or lower-case base32 v1 (b…).
const CID = "(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,70})";
const IPFS_SCHEME_URI = new RegExp(`^ipfs://(?:ipfs/)?${CID}$`);
// Any https gateway, path form (https://host/ipfs/<cid>) or subdomain form
// (https://<cid v1>.ipfs.host/). Only the content id is kept: the host is never
// contacted, so a gateway that shuts down cannot take the link with it.
const IPFS_GATEWAY_URI = new RegExp(`^https://[a-z0-9-]+(?:\\.[a-z0-9-]+)+/ipfs/${CID}$`);
const IPFS_SUBDOMAIN_URI = /^https:\/\/(b[a-z2-7]{50,70})\.ipfs\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?$/;
const ARWEAVE_URI = /^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/;

/**
 * Only content-addressed locations are accepted for a picture or metadata file: the
 * bytes behind them cannot be swapped after people have seen them. Matched as an
 * exact string (no URL parsing, so no normalisation tricks), no query, no fragment.
 *
 * Every IPFS form comes back as `ipfs://<cid>`, the one form that names no gateway.
 * The metadata link is written on chain forever, and gateways do not last: ipfs.io
 * and dweb.link were retired on 2026-09-21. Reads go through the site's gateway
 * list (src/lib/ipfsGateways.ts).
 */
export function checkContentUri(uri) {
  if (typeof uri !== "string") return { ok: false, reason: "No link was given." };
  const s = uri.trim();
  if (utf8Bytes(s) > LIMITS.uriBytes) return { ok: false, reason: `Too long: at most ${LIMITS.uriBytes} characters.` };
  const cid = (IPFS_SCHEME_URI.exec(s) ?? IPFS_GATEWAY_URI.exec(s) ?? IPFS_SUBDOMAIN_URI.exec(s))?.[1];
  if (cid) return { ok: true, value: `ipfs://${cid}` };
  if (ARWEAVE_URI.test(s)) return { ok: true, value: s };
  return { ok: false, reason: "Use an ipfs://… link, an https link that has /ipfs/ and then the file's id, or an https://arweave.net/… link." };
}

/** The IPFS link for a content id (`ipfs://<cid>`), or null if the id is not one we accept. */
export function ipfsUri(cid) {
  const uri = `ipfs://${cid}`;
  return typeof cid === "string" && IPFS_SCHEME_URI.test(uri) ? uri : null;
}

// ── keys ────────────────────────────────────────────────────────────────────

/** A base58 Solana address that decodes to exactly 32 bytes. */
export function isPubkeyString(s) {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return base58.decode(s).length === 32; } catch { return false; }
}

export function pubkeyBytes(s) {
  if (!isPubkeyString(s)) return null;
  return base58.decode(s);
}

// ── the metadata file ───────────────────────────────────────────────────────

export function buildMetadataJson(i) {
  const json = {
    name: i.name,
    symbol: i.symbol,
    description: i.description ?? "",
    image: i.imageUri,
  };
  const links = i.links ?? {};
  if (links.website) json.website = links.website;
  if (links.twitter) json.twitter = links.twitter;
  if (links.telegram) json.telegram = links.telegram;
  json.mint = i.mint;
  json.createdOn = CREATED_ON;
  return json;
}

/**
 * Parse a metadata file that ANY client may have written. Nothing in it is trusted:
 * text goes through displaySafe, the picture must be a content address, every link
 * is re-checked and dropped if it fails. Returns `invalid` only when the file is not
 * a JSON object at all.
 */
export function parseLaunchMetadataJson(text, expectedMint) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { kind: "invalid", reason: "The details file is not valid JSON." }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "The details file is not a JSON object." };
  const issues = [];
  const str = (v) => (typeof v === "string" ? v : "");
  const json = {
    name: displaySafe(str(raw.name), 32),
    symbol: displaySafe(str(raw.symbol), 10),
    description: displaySafe(str(raw.description), LIMITS.descriptionChars),
    image: null,
    mint: isPubkeyString(raw.mint) ? raw.mint : null,
  };
  if (raw.image !== undefined) {
    const img = checkContentUri(raw.image);
    if (img.ok) json.image = img.value;
    else issues.push("The picture is not stored at a content address, so it is not shown.");
  }
  for (const field of ["website", "twitter", "telegram"]) {
    if (raw[field] === undefined || raw[field] === "") continue;
    const r = checkLink(field, raw[field]);
    if (r.ok && r.value) json[field] = r.value;
    else issues.push(`The ${field === "twitter" ? "X" : field} link was not safe to show, so it is hidden.`);
  }
  const warning = impersonationWarning({ name: json.name, symbol: json.symbol });
  if (warning) issues.push(warning);
  return { kind: "ok", json, mintMatches: json.mint !== null && json.mint === expectedMint, issues };
}

// ── the signed upload request ───────────────────────────────────────────────

/** The exact string whose SHA-256 is signed as "Details". Fixed order, fixed version tag. */
export function detailsDigestInput(d) {
  const l = d.links ?? {};
  return JSON.stringify(["tegridy-launch-details-v1", d.name, d.symbol, d.description ?? "", l.website ?? "", l.twitter ?? "", l.telegram ?? ""]);
}

/**
 * The message the creator's wallet signs before anything is pinned. The server
 * rebuilds it from the fields it received and verifies the signature over the
 * rebuilt bytes, so nothing is parsed out of it. Name and symbol cannot contain a
 * line break (checkName, checkSymbol), so they cannot fake a line below them.
 */
export function uploadAuthMessage(m) {
  return [
    "Tegridy launch upload v1",
    "Sign to put your token's picture and details on IPFS. This is not a transaction and costs nothing.",
    "",
    `Name: ${m.name}`,
    `Symbol: ${m.symbol}`,
    `Mint: ${m.mint}`,
    `Creator: ${m.creator}`,
    `Details: ${m.detailsSha256}`,
    `Image: ${m.imageSha256}`,
    `Expires: ${m.expiresAt}`,
  ].join("\n");
}

/** Lower-case hex SHA-256 of bytes or a UTF-8 string, via WebCrypto (browser and Node alike). */
export async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
