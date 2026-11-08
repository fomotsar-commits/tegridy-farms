import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { getMultipleAccounts, type RawAccount } from '../lp/accounts';
import { WSOL_MINT } from '../lp/tokenSafety';

/**
 * The outside market's price, kept current from the chain: no Jupiter call. Where a coin's
 * deepest pool outside the venue is a PumpSwap SOL pool, the ratio of its two vaults moves as
 * that pool trades. That ratio is NOT the pool's price for every coin: Jupiter's quote through
 * the very same pool was 6% off it for BAYLA and 18% for SOY, and within 1% for BOBO, OGDOGE,
 * BRAINLET and APE (walked 2026-11-05). So Jupiter's listed price sets the level, and the
 * vaults say only how far the pool has moved since (`screenUsd`). That screens the gap;
 * Jupiter is asked for the trip itself only once the screen says a gap is there. Every trip
 * is still test-run against the chain before it is sent: the screen decides only what is
 * worth asking about.
 */

export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/**
 * Each coin's deepest outside pool, where that is a PumpSwap SOL pool (DexScreener's list of
 * each coin's pools, each pool's program read on chain, 2026-11-05). The other coins' deepest
 * outside pools are elsewhere (Raydium AMM v4, Orca, Meteora) and are screened at Jupiter's price.
 */
export const OUTSIDE_POOLS: readonly string[] = [
  '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', // BAYLA (7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump) / SOL
  '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX', // BOBO (4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump) / SOL
  'H8yiDq5XaNkiT6J3QXDeBVfsFHNaVwTRNicbWZnibexi', // SOY (8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump) / SOL
  '6wgSaJRFy9FXGxkZrfNS3RnT2YRgmHrs1XAfpMKr8yKd', // OGDOGE (utLyQQCPvjuCc6zeaXdsFeEC3JNdxKS3vxaZWoGdoge) / SOL
  '3whYbw26asxFG5Qh9emHA6Mi6uizvduYg1cVKLQ1eetq', // BRAINLET (4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump) / SOL
  'GiV7bAkQ6dipyPd5rFuoQeLLBJCNrRwP57dETVe6ourc', // APE (2Wkip2U5x93mjaAvoq8zaedweP73GgRtbaQhNcwXpump) / SOL
];

export interface OutsidePool {
  pool: string;
  tokenMint: string;
  tokenVault: string;
  solVault: string;
}

/** PumpSwap's pool account: 8-byte tag, bump, index, creator, then these, 32 bytes each. */
const AT = { baseMint: 43, quoteMint: 75, baseVault: 139, quoteVault: 171 } as const;
const POOL_MIN_LEN = AT.quoteVault + 32;

/** A PumpSwap pool of a token against SOL, or why it is not one. */
export function decodePumpPool(address: string, a: RawAccount | null, toBase58: (b: Uint8Array) => string): OutsidePool | string {
  if (!a) return `${address}: not found`;
  if (a.owner !== PUMPSWAP_PROGRAM) return `${address}: not a PumpSwap pool`;
  if (a.data.length < POOL_MIN_LEN) return `${address}: too short for a PumpSwap pool`;
  const key = (at: number) => toBase58(a.data.subarray(at, at + 32));
  if (key(AT.quoteMint) !== WSOL_MINT) return `${address}: not priced in SOL`;
  return { pool: address, tokenMint: key(AT.baseMint), tokenVault: key(AT.baseVault), solVault: key(AT.quoteVault) };
}

/**
 * The price in USD of a whole token in each outside pool: its SOL vault over its token vault,
 * at SOL's price. A pool with an empty side, or one whose vaults were not read, gives none.
 */
export function outsideUsd(
  pools: readonly OutsidePool[],
  amounts: ReadonlyMap<string, bigint>,
  decimalsOf: (mint: string) => number | null,
  solUsd: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!(solUsd > 0)) return out;
  for (const p of pools) {
    const sol = amounts.get(p.solVault);
    const tok = amounts.get(p.tokenVault);
    const decimals = decimalsOf(p.tokenMint);
    if (sol === undefined || tok === undefined || decimals === null || sol <= 0n || tok <= 0n) continue;
    const usd = ((Number(sol) / 1e9) / (Number(tok) / 10 ** decimals)) * solUsd;
    if (Number.isFinite(usd) && usd > 0) out.set(p.tokenMint, usd);
  }
  return out;
}

/** Per coin: Jupiter's listed price when it was last seen to change, and the vault price at that moment. */
export type Anchors = Map<string, { listed: number; vault: number }>;

/**
 * The screen's price for each outside pool's coin: Jupiter's listed price, moved by as much as
 * the pool's vault price has moved since Jupiter's price last changed. A new listed price is
 * the new anchor, taken as it is. A coin Jupiter lists no price for gets none: a vault ratio
 * alone is no price (see above).
 */
export function screenUsd(listed: ReadonlyMap<string, number>, vault: ReadonlyMap<string, number>, anchors: Anchors): Map<string, number> {
  const out = new Map<string, number>();
  for (const [mint, v] of vault) {
    const l = listed.get(mint);
    if (l === undefined || !(v > 0)) continue;
    const a = anchors.get(mint);
    if (!a || a.listed !== l) {
      anchors.set(mint, { listed: l, vault: v });
      out.set(mint, l);
    } else {
      out.set(mint, l * (v / a.vault));
    }
  }
  return out;
}

/** The outside pools' accounts never move: read once a run, by address. */
const decoded = new Map<string, OutsidePool>();

/**
 * The outside pools, read once a run. A pool that is not a PumpSwap SOL pool is said once
 * and left out; the coin is then screened at Jupiter's price, as before.
 */
export async function readOutsidePools(rpc: SolanaRpc, addresses: readonly string[], toBase58: (b: Uint8Array) => string, log: (line: string) => void): Promise<OutsidePool[]> {
  const unread = addresses.filter((a) => !decoded.has(a));
  if (unread.length) {
    const got = await getMultipleAccounts(rpc, unread);
    unread.forEach((address, i) => {
      const p = decodePumpPool(address, got[i] ?? null, toBase58);
      if (typeof p === 'string') log(`Outside pool left out: ${p}`);
      else decoded.set(address, p);
    });
  }
  return addresses.flatMap((a) => (decoded.has(a) ? [decoded.get(a)!] : []));
}
