// Base58 (Bitcoin alphabet) decode, enough to tell a real Solana pubkey from a
// string that merely looks like one.
//
// The rest of this repo validates Solana addresses with the shape regex
// `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/` (dbc.ts, heatClient.ts, scanner.ts). That
// regex accepts strings that decode to 31, 33 or 35 bytes, and the repo has
// already been bitten by exactly that: on 2026-08-08 a session INVENTED an
// operator address to fit a truncated note, 45 characters decoding to 33 bytes,
// and it sat next to the real one looking completely plausible (the incident is
// recorded in .github/workflows/ci.yml). An indexer keyed by pool address must
// not accept such a value — every signature it fetched would come back empty
// and the pool would read as a market with no trades.
//
// So the check here decodes and counts bytes. Length only; no checksum exists
// on a raw pubkey to verify beyond that.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX = (() => {
  const m = new Map();
  for (let i = 0; i < ALPHABET.length; i++) m.set(ALPHABET[i], i);
  return m;
})();

/**
 * @param {string} s
 * @returns {Uint8Array | null} decoded bytes, or null when `s` is not base58.
 */
export function base58Decode(s) {
  if (typeof s !== "string" || s.length === 0) return null;

  const bytes = [];
  for (const ch of s) {
    const value = INDEX.get(ch);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' is a leading zero byte that the arithmetic above cannot
  // represent — it multiplies by 58 and stays 0.
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);

  return new Uint8Array(bytes.reverse());
}

/** A Solana public key is exactly 32 bytes. Anything else is not an address. */
export function isSolanaAddress(s) {
  const decoded = base58Decode(s);
  return decoded !== null && decoded.length === 32;
}

/** A transaction signature is exactly 64 bytes. */
export function isSolanaSignature(s) {
  const decoded = base58Decode(s);
  return decoded !== null && decoded.length === 64;
}
