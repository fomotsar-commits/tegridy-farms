/**
 * Room in a Jupiter swap for the wallet's own safety check (2026-11-15).
 *
 * Phantom adds its safety check (Lighthouse) to every swap it signs: instructions after
 * the swap that read the wallet's accounts. They run on whatever compute the swap leaves.
 * Jupiter's limit leaves about 24% of the swap's own use. Phantom raises the limit to
 * leave 10,600 when there is less, and keeps it when there is more (mainnet sample of
 * 11-15: other sites' limits of 40,000 and 300,000, kept as set).
 *
 * One of those checks proves the coin account is the wallet's own by deriving its
 * address: about 1,950 units plus 1,500 for every bump it tries. That is 3,450 for half
 * of all wallets, but 13,950 for a wallet whose account took 8 tries. A small swap gets
 * the floor: a BIG BRAIN buy through Raydium uses ~38,000 units, so the check had
 * 10,600 - 1,818 (the wallet's SOL check) = 8,782, too little from 5 tries on (1 wallet
 * in 16). Every BIG BRAIN buy from such a wallet failed, every time, at any price: on chain until
 * 11-15 (4otzk3uW…, 4rCFtH1C…: "Computational budget exceeded" in the check, network
 * fee lost), refused by the page's own first send after.
 *
 * So the page asks for 30,000 more units on every Jupiter swap. That is room for a
 * check that tries 23 bumps on one account, or 11 on each of two. The price per unit is
 * cut when the total would pass the disclosed priority-fee cap, so the cap still holds.
 * At 11-15 prices the extra room costs 200 to 64,000 lamports (under 0.0001 SOL).
 *
 * Bytes are patched in place: the transaction is unsigned, and no web3.js encoder runs
 * (it fails under jsdom, where page tests build swaps).
 */

/** Units added to Jupiter's compute limit. */
export const WALLET_GUARD_ROOM = 30_000;

/** Solana's per-transaction ceiling. */
const MAX_COMPUTE_UNITS = 1_400_000;

/** ComputeBudget111111111111111111111111111111 as bytes. */
const COMPUTE_BUDGET = Uint8Array.from([
  3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187, 197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
]);

/**
 * The swap with WALLET_GUARD_ROOM more compute, and its price cut to keep the priority
 * fee within `maxPriorityLamports`. Anything it cannot read, or that is already signed,
 * comes back unchanged: the transaction guard reads what it returns either way.
 */
export function withWalletGuardRoom(b64: string, maxPriorityLamports: number): string {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return b64;
  }
  const out = padded(bytes, maxPriorityLamports);
  if (!out) return b64;
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}

/** Solana's compact length: 1 to 3 bytes, 7 bits each. */
function shortvec(b: Uint8Array, at: number): [value: number, next: number] | null {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  return null;
}

function padded(b: Uint8Array, maxPriorityLamports: number): Uint8Array | null {
  const sigs = shortvec(b, 0);
  if (!sigs) return null;
  // Signed already: a changed message would void the signature.
  if (b.subarray(sigs[1], sigs[1] + 64 * sigs[0]).some((x) => x !== 0)) return null;
  let at = sigs[1] + 64 * sigs[0];
  const prefix = b[at];
  if (prefix === undefined) return null;
  if (prefix & 0x80) {
    if ((prefix & 0x7f) !== 0) return null; // only v0 and legacy are read
    at += 1;
  }
  at += 3; // header
  const keys = shortvec(b, at);
  if (!keys) return null;
  const keysAt = keys[1];
  at = keysAt + 32 * keys[0] + 32; // keys, then the blockhash
  const ixs = shortvec(b, at);
  if (!ixs) return null;
  at = ixs[1];
  let limitAt = -1;
  let priceAt = -1;
  for (let k = 0; k < ixs[0]; k++) {
    const program = b[at];
    if (program === undefined) return null;
    const accounts = shortvec(b, at + 1);
    if (!accounts) return null;
    const len = shortvec(b, accounts[1] + accounts[0]);
    if (!len) return null;
    const dataAt = len[1];
    at = dataAt + len[0];
    if (at > b.length) return null;
    if (program < keys[0] && sameKey(b, keysAt + 32 * program)) {
      if (len[0] === 5 && b[dataAt] === 2) limitAt = dataAt + 1;
      if (len[0] === 9 && b[dataAt] === 3) priceAt = dataAt + 1;
    }
  }
  // No limit set: every call gets 200,000 and the check has room already.
  if (limitAt < 0) return null;
  const out = b.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const limit = Math.min(view.getUint32(limitAt, true) + WALLET_GUARD_ROOM, MAX_COMPUTE_UNITS);
  view.setUint32(limitAt, limit, true);
  if (priceAt >= 0) {
    const most = (BigInt(maxPriorityLamports) * 1_000_000n) / BigInt(limit);
    if (view.getBigUint64(priceAt, true) > most) view.setBigUint64(priceAt, most, true);
  }
  return out;
}

function sameKey(b: Uint8Array, at: number): boolean {
  for (let i = 0; i < 32; i++) if (b[at + i] !== COMPUTE_BUDGET[i]) return false;
  return true;
}
