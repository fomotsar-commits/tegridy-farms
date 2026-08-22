// Minimal ABI return-value decoders for serverless routes.
//
// There is no server-side ABI decoder anywhere under frontend/api — `ethcall.js` returns
// raw hex and its two existing callers slice it by hand. This adds the four decoders a
// token read needs, with ONE rule that is the whole reason the file exists:
//
//   EVERY DECODER RETURNS `null` (or `{ ok: false }`) ON ANYTHING IT CANNOT READ.
//   Never `''`. Never `0n`. Never `false`.
//
// A decoder that returns a zero-value for unreadable input is how "we could not ask"
// becomes "the answer is nothing", and downstream that becomes a birth record asserting
// a token has no name, no supply and no insider allocation. This repo has shipped that
// class of bug twice. The caller translates every `null` into an `unread` entry.
//
// Note on `eth_call` semantics: a call to a selector a contract does not implement does
// NOT reliably throw — a contract with a fallback returns `0x`. So `0x` must decode to
// `null`, not to a default, or a missing function looks like a real zero.

/** Longest string we will accept from a token. A 5 MB "name" is an attack, not a name. */
const MAX_STR_BYTES = 256;
/** Longest decoded string, in code units, after UTF-8 decoding. */
const MAX_STR_CHARS = 128;

const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Decode an ABI-encoded `string` return.
 *
 * Handles both the canonical dynamic encoding (offset, length, bytes) and the legacy
 * `bytes32` form that pre-ABI tokens (MKR and friends) return for name()/symbol().
 *
 * Returns `{ ok: true, value }` or `{ ok: false }` — never a partial string.
 */
export function decodeAbiString(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return { ok: false };
  const body = hex.slice(2);
  if (body.length === 0) return { ok: false };

  let bytesHex;
  if (body.length === 64) {
    // Legacy bytes32: right-padded with NULs. Strip them; anything left is the string.
    bytesHex = body.replace(/(00)+$/, '');
    if (bytesHex.length === 0) return { ok: false };
  } else {
    if (body.length < 128) return { ok: false };
    // Only the canonical offset of 32. A non-canonical offset is a malformed or hostile
    // encoding, and following it would be reading attacker-chosen bytes.
    if (BigInt('0x' + body.slice(0, 64)) !== 32n) return { ok: false };
    const len = BigInt('0x' + body.slice(64, 128));
    if (len === 0n || len > BigInt(MAX_STR_BYTES)) return { ok: false };
    const need = 128 + Number(len) * 2;
    if (body.length < need) return { ok: false };
    bytesHex = body.slice(128, need);
  }

  const value = Buffer.from(bytesHex, 'hex').toString('utf8');
  // U+FFFD means the bytes were not valid UTF-8. Publishing the replacement character
  // into a JSON document consumed by machines is worse than declaring the field unread.
  if (value.includes('\uFFFD')) return { ok: false };
  // Control characters and NULs: a name containing them is either broken or an attempt
  // to smuggle something through a consumer's renderer.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return { ok: false };
  if (value.length === 0 || value.length > MAX_STR_CHARS) return { ok: false };
  return { ok: true, value };
}

/** Decode a uint256 word. Null on `0x`, malformed hex, or a short word. */
export function decodeUint(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  if (hex.length < 3) return null; // '0x' — the contract answered nothing
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/**
 * Decode an address word. Null unless the word is a properly left-padded address.
 *
 * The left-padding check matters: a contract returning a full 32 bytes of data that is
 * not an address (because the selector hit a fallback) would otherwise yield a plausible
 * address made of the low 20 bytes of something else.
 */
export function decodeAddress(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  const body = hex.slice(2);
  if (body.length < 64) return null;
  const word = body.slice(0, 64).toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) return null;
  return '0x' + word.slice(24);
}

/** Decode a bool word. Null when unreadable — NOT false. */
export function decodeBool(hex) {
  const n = decodeUint(hex);
  if (n === null) return null;
  return n !== 0n;
}

/** Decode a uint8 word into a JS number, or null. */
export function decodeUint8(hex) {
  const n = decodeUint(hex);
  if (n === null || n < 0n || n > 255n) return null;
  return Number(n);
}

/**
 * Slice word `i` out of a static-tuple return and hand it back as a 32-byte hex word.
 * Null when the payload is too short to contain it — a truncated return must not be
 * silently read as zeros.
 */
export function wordAt(hex, i) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  const body = hex.slice(2);
  const start = i * 64;
  if (body.length < start + 64) return null;
  return '0x' + body.slice(start, start + 64);
}
