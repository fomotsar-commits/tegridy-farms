// What a Jupiter route delivers, from its own events in a transaction's inner instructions:
// the browser's twin of scripts/lib/fill-scoreboard-chain.mjs (jupiterEvents.test.ts holds
// the two to the same answers on real swaps). Used on the pre-sign test run.
import { PublicKey } from '@solana/web3.js';
import { base58Decode } from '../../copytrade/base58';

export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const EVENT_TAG = 'e445a52e51cb9a1d'; // Anchor's self-CPI event instruction
const SWAP_EVENT = '40c6cde8260871e2';
const FEE_EVENT = '494f4e7fb8d50ddc';
// V2's one event: a u32 hop count, then per hop in mint, in amount, out mint, out amount
// (before a fee taken from it) and AMM, 112 bytes. V2 emits no FeeEvent.
const SWAPS_EVENT = '982f4eebc0606e6a';
const SWAPS_HOP = 112;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const key = (b: Uint8Array) => new PublicKey(b).toBase58();
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);

type ParsedIx = { programId?: unknown; data?: unknown; program?: unknown; parsed?: { type?: unknown; info?: Record<string, unknown> } };

/** A token transfer's destination and raw amount, as the RPC parsed it; null for anything else. */
function transferOf(ix: ParsedIx): { to: string; amount: bigint } | null {
  if (ix.program !== 'spl-token' && ix.program !== 'spl-token-2022') return null;
  const info = ix.parsed?.info;
  const raw = ix.parsed?.type === 'transfer' ? info?.amount : ix.parsed?.type === 'transferChecked' ? (info?.tokenAmount as { amount?: unknown })?.amount : null;
  return typeof info?.destination === 'string' && typeof raw === 'string' && /^\d+$/.test(raw) ? { to: info.destination, amount: BigInt(raw) } : null;
}

/**
 * The one mint the route delivered and how much reached the trader, net of a fee taken from
 * it: V1's FeeEvent, or under V2 the transfers into `feeAccounts` (address to mint). Null when
 * the events cannot say: none, an undecodable one, or more than one mint in or out. Null is
 * no figure, never zero.
 */
export function deliveredByRoute(innerInstructions: unknown, feeAccounts: Readonly<Record<string, string>> = {}): { mint: string; amount: bigint } | null {
  if (!Array.isArray(innerInstructions)) return null;
  const net = new Map<string, bigint>();
  const fee: { mint?: string; amount: bigint } = { amount: 0n };
  const paidIn = new Map<string, bigint>();
  const hop = (inMint: string, inAmount: bigint, outMint: string, outAmount: bigint) => {
    net.set(inMint, (net.get(inMint) ?? 0n) - inAmount);
    net.set(outMint, (net.get(outMint) ?? 0n) + outAmount);
  };
  for (const group of innerInstructions) {
    const list = (group as { instructions?: unknown })?.instructions;
    if (!Array.isArray(list)) continue;
    for (const ix of list as ParsedIx[]) {
      const t = ix ? transferOf(ix) : null;
      const feeMint = t ? feeAccounts[t.to] : undefined;
      if (t && feeMint) paidIn.set(feeMint, (paidIn.get(feeMint) ?? 0n) + t.amount);
      if (ix?.programId !== JUPITER_PROGRAM || typeof ix.data !== 'string') continue;
      const d = base58Decode(ix.data);
      if (!d || d.length < 16 || hex(d.subarray(0, 8)) !== EVENT_TAG) continue;
      const kind = hex(d.subarray(8, 16));
      if (kind === FEE_EVENT && d.length >= 88) {
        fee.mint = key(d.subarray(48, 80));
        fee.amount = u64(d, 80);
      } else if (kind === SWAP_EVENT && d.length >= 128) {
        hop(key(d.subarray(48, 80)), u64(d, 80), key(d.subarray(88, 120)), u64(d, 120));
      } else if (kind === SWAPS_EVENT && d.length >= 20) {
        const count = u32(d, 16);
        if (d.length < 20 + count * SWAPS_HOP) return null;
        for (let h = 0; h < count; h++) {
          const o = 20 + h * SWAPS_HOP;
          hop(key(d.subarray(o, o + 32)), u64(d, o + 32), key(d.subarray(o + 40, o + 72)), u64(d, o + 72));
        }
      }
    }
  }
  const got = [...net].filter(([, v]) => v > 0n);
  const spent = [...net].filter(([, v]) => v < 0n);
  if (got.length !== 1 || spent.length !== 1) return null;
  const [mint, gross] = got[0]!;
  const taken = fee.mint !== undefined ? (fee.mint === mint ? fee.amount : 0n) : (paidIn.get(mint) ?? 0n);
  const amount = gross - taken;
  return amount >= 0n ? { mint, amount } : null;
}
