// Base58 identity checks for the Solana half of the island tape.
//
// WHY A DECODER AND NOT JUST THE REGEX. `SOL_ADDRESS_RE` (lib/scanner/scanner.ts)
// accepts 32–44 base58 characters, which is the right pre-filter and the wrong
// verdict: a 44-character base58 string can decode to 33 bytes, and a 33-byte
// value is not a Solana address at all. That matters here because a leader
// address a reader pastes is untrusted input that ends up compared against a
// tape sender and interpolated into an explorer URL. The length in BYTES is the
// only thing that separates a key from a plausible-looking string, so it is what
// gets checked.
//
// The decoder is copied from scripts/verify-addresses.mjs, which is the repo's
// existing, already-reasoned implementation — including the `n === 0n` branch
// that keeps the all-'1' System Program key at 32 bytes instead of 33. Node's
// Buffer is not available in the browser, so the hex→bytes step is done by hand;
// nothing else about the algorithm changes.

/** Bitcoin/Solana base58 alphabet: no 0, O, I or l. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 string → bytes, or null when the string is not base58.
 *
 * Returns null rather than throwing: every caller here is asking a yes/no
 * question about untrusted input, and an exception on a typo would take a render
 * down.
 */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null; // includes '0', 'O', 'I', 'l', '…' and any whitespace
    n = n * 58n + BigInt(i);
  }

  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;

  // `n === 0n`, NOT `hex === '0'`. The odd-length pad above rewrites "0" to "00"
  // BEFORE the test, so a naive zero branch is unreachable and every all-'1'
  // address picks up a spurious trailing zero byte — the System Program key
  // would decode to 33 bytes and be rejected as "not a Solana address", which is
  // the exact verdict this function exists to reserve for a fabricated key.
  const body: number[] = [];
  if (n !== 0n) {
    for (let i = 0; i < hex.length; i += 2) {
      body.push(Number.parseInt(hex.slice(i, i + 2), 16));
    }
  }

  let leading = 0;
  for (const ch of s) {
    if (ch === '1') leading += 1;
    else break;
  }

  const out = new Uint8Array(leading + body.length);
  out.set(body, leading); // the leading zero bytes are already 0 from the fill
  return out;
}

/**
 * Exactly 32 bytes of base58 — a Solana public key (wallet, mint or pool).
 *
 * The regex pre-filter is deliberate and cheap: it rejects the shapes that are
 * obviously wrong before the BigInt loop runs over attacker-controlled length.
 */
export function isSolanaPubkey(value: string): boolean {
  const s = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  return base58Decode(s)?.length === 32;
}

/**
 * Exactly 64 bytes of base58 — a Solana transaction signature.
 *
 * A signature is twice a pubkey, so the two checks are NOT interchangeable: a
 * signature passed where a pubkey belongs would be interpolated into an address
 * URL and a pubkey passed where a signature belongs would produce a transaction
 * link to nothing.
 */
export function isSolanaSignature(value: string): boolean {
  const s = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) return false;
  return base58Decode(s)?.length === 64;
}
