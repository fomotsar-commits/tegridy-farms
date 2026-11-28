// Bytes, hex and whole numbers, parsed strictly.
//
// Every value that ends up inside a signature passes through these helpers, so they refuse
// anything that is not exactly the expected shape: no hex where a decimal is expected, no
// leading zeros, no floats, no negative numbers, no silent truncation. "Close enough"
// parsing is how a firewall grows a hole.
//
// This file must not import @noble (preflight.mjs uses it before the noble check has run).

export const UINT256_MAX = (1n << 256n) - 1n;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isBytes32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isHexData(value) {
  return typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

/** Same address in any casing. False for anything that is not 0x + 40 hex. */
export function eqAddr(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** True when the object has exactly these keys, no more and no fewer. */
export function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const have = Object.keys(value).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

/**
 * A non-negative whole number from a decimal string ("0", "123") or a safe integer number.
 * Returns a bigint, or null for anything else (hex, floats, "01", "-1", "1e3", > max).
 */
export function parseUint(value, max = UINT256_MAX) {
  let n;
  if (typeof value === 'string') {
    if (value.length > 78 || !DECIMAL.test(value)) return null;
    n = BigInt(value);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    n = BigInt(value);
  } else if (typeof value === 'bigint') {
    n = value;
  } else {
    return null;
  }
  if (n < 0n || n > max) return null;
  return n;
}

/** A wei amount, which must arrive as a decimal string (a JSON number cannot hold it exactly). */
export function parseWeiString(value) {
  if (typeof value !== 'string') return null;
  return parseUint(value);
}

/** A safe non-negative integer as a JS number (times, quantities), or null. */
export function parseSafeInt(value) {
  const n = parseUint(value, BigInt(Number.MAX_SAFE_INTEGER));
  return n === null ? null : Number(n);
}

/**
 * Gwei given as a JSON number or decimal string ("0.05", 20) -> exact wei bigint.
 * At most 9 decimal places (1 wei); anything else (exponents, negatives) is null.
 */
export function gweiToWei(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return null;
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,9}))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]) * 1_000_000_000n;
  const frac = m[2] ? BigInt(m[2].padEnd(9, '0')) : 0n;
  return whole + frac;
}

export function hexToBytes(hex) {
  if (!isHexData(hex)) throw new Error('not 0x-prefixed whole-byte hex');
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Plain hex (no 0x) of bytes; used where a file format wants it bare. */
export function bytesToPlainHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesToHex(bytes) {
  return `0x${bytesToPlainHex(bytes)}`;
}

export function plainHexToBytes(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('not whole-byte hex');
  return hexToBytes(`0x${hex}`);
}

export function concatBytes(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(text);
}

/** Big-endian, exactly `length` bytes. Throws on a negative number or one that does not fit. */
export function bigintToBytes(value, length = 32) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('expected a non-negative bigint');
  if (value >> BigInt(length * 8) !== 0n) throw new Error(`number does not fit in ${length} bytes`);
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Big-endian, no leading zero bytes (0 -> empty), the form RLP integers use. */
export function bigintToMinimalBytes(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('expected a non-negative bigint');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(`0x${hex}`);
}

export function bytesToBigint(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export function hexToBigint(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('not a hex quantity');
  return BigInt(hex);
}

export function toQuantityHex(value) {
  return `0x${value.toString(16)}`;
}

export function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}
