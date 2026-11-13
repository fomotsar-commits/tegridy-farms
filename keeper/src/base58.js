// Base58 (the Bitcoin alphabet Solana uses), with no dependency. The keeper ships
// zero npm packages, so it carries this instead of @solana/web3.js.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

/** Bytes to base58. Leading zero bytes become leading '1's. */
export function encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/** Base58 to bytes, or null if a character is outside the alphabet. */
export function decode(str) {
  if (typeof str !== 'string') return null;
  let n = 0n;
  for (const c of str) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/**
 * A Solana address: decodes to exactly 32 bytes and re-encodes to the same text.
 * Decoding, not eyeballing: a wrong address looks exactly like a right one.
 */
export function isAddress(str) {
  if (typeof str !== 'string' || str.length < 32 || str.length > 44) return false;
  const bytes = decode(str);
  return bytes !== null && bytes.length === 32 && encode(bytes) === str;
}
