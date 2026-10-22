// What a Jupiter route delivers, from its own events in a transaction's inner instructions:
// the browser's twin of scripts/lib/fill-scoreboard-chain.mjs (jupiterEvents.test.ts holds
// the two to the same answers on real swaps). Used on the pre-sign test run.
import { PublicKey } from '@solana/web3.js';
import { base58Decode } from '../../copytrade/base58';

export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const EVENT_TAG = 'e445a52e51cb9a1d'; // Anchor's self-CPI event instruction
const SWAP_EVENT = '40c6cde8260871e2';
const FEE_EVENT = '494f4e7fb8d50ddc';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const key = (b: Uint8Array) => new PublicKey(b).toBase58();
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);

/**
 * The one mint the route delivered and how much reached the trader, net of a fee taken from
 * it. Null when the events cannot say: none, an undecodable one, or more than one mint in or
 * out. Null is no figure, never zero.
 */
export function deliveredByRoute(innerInstructions: unknown): { mint: string; amount: bigint } | null {
  if (!Array.isArray(innerInstructions)) return null;
  const net = new Map<string, bigint>();
  const fee: { mint?: string; amount: bigint } = { amount: 0n };
  for (const group of innerInstructions) {
    const list = (group as { instructions?: unknown })?.instructions;
    if (!Array.isArray(list)) continue;
    for (const ix of list as Array<{ programId?: unknown; data?: unknown }>) {
      if (ix?.programId !== JUPITER_PROGRAM || typeof ix.data !== 'string') continue;
      const d = base58Decode(ix.data);
      if (!d || d.length < 16 || hex(d.subarray(0, 8)) !== EVENT_TAG) continue;
      const kind = hex(d.subarray(8, 16));
      if (kind === FEE_EVENT && d.length >= 88) {
        fee.mint = key(d.subarray(48, 80));
        fee.amount = u64(d, 80);
      } else if (kind === SWAP_EVENT && d.length >= 128) {
        const inMint = key(d.subarray(48, 80));
        const outMint = key(d.subarray(88, 120));
        net.set(inMint, (net.get(inMint) ?? 0n) - u64(d, 80));
        net.set(outMint, (net.get(outMint) ?? 0n) + u64(d, 120));
      }
    }
  }
  const got = [...net].filter(([, v]) => v > 0n);
  const spent = [...net].filter(([, v]) => v < 0n);
  if (got.length !== 1 || spent.length !== 1) return null;
  const [mint, gross] = got[0]!;
  const amount = gross - (fee.mint === mint ? fee.amount : 0n);
  return amount >= 0n ? { mint, amount } : null;
}
