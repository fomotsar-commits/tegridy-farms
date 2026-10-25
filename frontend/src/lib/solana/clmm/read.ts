import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { getMultipleAccounts, getTokenAccountsByOwner, type RawAccount } from '../lp/accounts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { decodeMintAccount } from '../lp/tokenSafety';
import { getArrayStartIndex, initializedTickArrayStarts, isOverflowDefaultTickarrayBitmap } from './bitmap';
import { ClmmMathError, calculateLatestTokenFees, getDeltaAmountsSigned, getFeeGrowthInside } from './math';
import { tiersOffered } from '../lp/tierOffer';
import {
  decodeAmmConfig,
  decodeBitmapExtension,
  decodePersonalPosition,
  decodePoolState,
  decodeTickArray,
  deriveAmmConfig,
  deriveBitmapExtension,
  derivePersonalPosition,
  derivePool,
  deriveTickArray,
  sortMints,
  type AmmConfigView,
  type BitmapExtensionView,
  type PersonalPositionView,
  type PoolStateView,
  type TickArrayView,
} from './program';

/**
 * What the site reads of the range program, over the browser's proxy (`/api/solrpc`),
 * which refuses program-wide scans. So nothing here lists by program: fee tiers are found
 * at the addresses their indexes derive, a pair's pools at the addresses their tier and
 * mints derive, and a wallet's positions through its own Token-2022 accounts.
 *
 * Every read is `ok` or `unread`. An account that should be the program's and does not
 * decode as one is `unread`, never skipped: a missing pool or position is only ever said
 * when the chain answered that nothing is there.
 */

export type Read<T> = { kind: 'ok'; value: T } | { kind: 'unread'; detail: string };

/** Fee tiers are looked for at indexes 0 to 15: the vault makes them one at a time, from 0. */
export const FEE_TIER_INDEXES = 16;

/** The bands read on each side of a pool's price, for its liquidity and a swap's walk. */
export const BANDS_EACH_SIDE = 4;

const owned = (a: RawAccount | null, programId: PublicKey) => a !== null && a.owner === programId.toBase58();

/**
 * An empty account the System program owns, at an address the program never used: what
 * anyone makes by sending SOL there. It is the chain's answer that nothing was created, so
 * it reads as absent; without this, a sub-cent transfer would break the Range tab for good.
 */
const neverCreated = (a: RawAccount | null) => a === null || (a.owner === SYSTEM_PROGRAM && a.data.length === 0);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

function unreadable(what: string): never {
  throw new Error(what);
}

async function guard<T>(f: () => Promise<T>): Promise<Read<T>> {
  try {
    return { kind: 'ok', value: await f() };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}

/** Every fee tier the program has, lowest index first. */
export function readFeeTiers(rpc: SolanaRpc, programId: PublicKey): Promise<Read<AmmConfigView[]>> {
  return guard(async () => {
    const addresses = Array.from({ length: FEE_TIER_INDEXES }, (_, i) => deriveAmmConfig(programId, i).toBase58());
    const accounts = await getMultipleAccounts(rpc, addresses);
    const tiers: AmmConfigView[] = [];
    accounts.forEach((a, i) => {
      if (neverCreated(a)) return;
      if (!owned(a, programId)) unreadable(`fee tier ${i}'s address holds an account the program does not own`);
      const t = decodeAmmConfig(addresses[i]!, a!.data);
      if (!t || t.index !== i) unreadable(`fee tier ${i} did not decode`);
      tiers.push(t!);
    });
    return tiers;
  });
}

/** A pool with the tier it was opened on. */
export interface RangePool {
  pool: PoolStateView;
  config: AmmConfigView;
}

/**
 * The pools of one pair, one per tier that has one, on the tiers this site offers the pair
 * (lp/tierOffer.ts): a BAYLA pool on the 0.25% tier is never read, so never listed or routed
 * through. The Range tab and the swap route both find their pools here.
 */
export function readPairPools(rpc: SolanaRpc, programId: PublicKey, mintA: string, mintB: string, allTiers: AmmConfigView[]): Promise<Read<RangePool[]>> {
  return guard(async () => {
    const tiers = tiersOffered(allTiers, mintA, mintB);
    const { token0, token1 } = sortMints(new PublicKey(mintA), new PublicKey(mintB));
    const addresses = tiers.map((t) => derivePool(programId, new PublicKey(t.address), token0, token1).toBase58());
    const accounts = await getMultipleAccounts(rpc, addresses);
    const out: RangePool[] = [];
    accounts.forEach((a, i) => {
      if (neverCreated(a)) return;
      if (!owned(a, programId)) unreadable('a pool address holds an account the program does not own');
      const pool = decodePoolState(addresses[i]!, a!.data);
      if (!pool || pool.ammConfig !== tiers[i]!.address) unreadable('a pool did not decode');
      out.push({ pool: pool!, config: tiers[i]! });
    });
    return out;
  });
}

/** A pool's far-band map, when its spacing can reach past the pool's own map. */
export async function readExtension(rpc: SolanaRpc, programId: PublicKey, pool: PoolStateView): Promise<BitmapExtensionView | null> {
  if (pool.tickSpacing >= 15) return null;
  const address = deriveBitmapExtension(programId, new PublicKey(pool.address)).toBase58();
  const a = (await getMultipleAccounts(rpc, [address]))[0] ?? null;
  if (a === null || neverCreated(a)) return null;
  if (!owned(a, programId)) unreadable('the far-band map is not the program’s');
  const ext = decodeBitmapExtension(address, a.data);
  if (!ext || ext.poolId !== pool.address) unreadable('the far-band map did not decode');
  return ext;
}

/**
 * The used bands nearest a pool's price, `each` on each side, decoded and keyed by start.
 * A band the map marks that comes back missing or wrong is `unread`, never "no liquidity".
 */
export async function readBandsNear(
  rpc: SolanaRpc,
  programId: PublicKey,
  pool: PoolStateView,
  ext: BitmapExtensionView | null,
  each = BANDS_EACH_SIDE,
): Promise<Map<number, TickArrayView>> {
  const here = getArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
  const starts = initializedTickArrayStarts(pool, ext);
  const below = starts.filter((s) => s <= here).slice(-(each + 1));
  const above = starts.filter((s) => s > here).slice(0, each);
  const want = [...below, ...above];
  const addresses = want.map((s) => deriveTickArray(programId, new PublicKey(pool.address), s).toBase58());
  const accounts = await getMultipleAccounts(rpc, addresses);
  const out = new Map<number, TickArrayView>();
  accounts.forEach((a, i) => {
    if (!owned(a, programId)) unreadable(`band ${want[i]} the pool marks did not read`);
    const band = decodeTickArray(addresses[i]!, a!.data);
    if (!band || band.poolId !== pool.address || band.startTickIndex !== want[i]) unreadable(`band ${want[i]} did not decode`);
    out.set(want[i]!, band!);
  });
  return out;
}

/** Where the price is against a position's range. */
export type RangeStatus = 'in-range' | 'below' | 'above';

export function rangeStatus(pool: Pick<PoolStateView, 'tickCurrent'>, p: Pick<PersonalPositionView, 'tickLowerIndex' | 'tickUpperIndex'>): RangeStatus {
  if (pool.tickCurrent < p.tickLowerIndex) return 'below';
  if (pool.tickCurrent < p.tickUpperIndex) return 'in-range';
  return 'above';
}

/** One position, as the Range tab shows it. A figure that could not be worked out is null. */
export interface WalletPosition {
  position: PersonalPositionView;
  /** The wallet's account holding the position's NFT. */
  nftAccount: string;
  /**
   * The NFT's token program. The range program opens positions with either kind of NFT;
   * this site opens Token-2022 ones and takes out only those.
   */
  nftProgram: 'token-2022' | 'token';
  pool: PoolStateView;
  config: AmmConfigView;
  status: RangeStatus;
  /** What taking all of it out would return now, before fees. */
  amounts: { amount0: bigint; amount1: bigint } | null;
  /** Fees the position could collect now: owed as of its last update, plus what built up since. */
  fees: { fee0: bigint; fee1: bigint } | null;
  /** Rewards the pool pays that this position is owed. Any above zero must be collected before closing. */
  rewardsOwed: bigint[];
}

export interface WalletPositionsRead {
  positions: WalletPosition[];
  /** Positions found in the wallet whose pool, tier or bands did not read. Never shown as empty. */
  unread: { position: string; detail: string }[];
}

/** Every range position the wallet holds, with its pool, status, amounts and fees. */
export function readWalletPositions(rpc: SolanaRpc, programId: PublicKey, owner: PublicKey): Promise<Read<WalletPositionsRead>> {
  return guard(async () => {
    const toBase58 = (b: Uint8Array) => new PublicKey(b).toBase58();
    // Both token programs: a position opened elsewhere can carry a classic SPL-Token NFT.
    const kinds = [
      { program: TOKEN_2022_PROGRAM_ID, nftProgram: 'token-2022' as const },
      { program: TOKEN_PROGRAM_ID, nftProgram: 'token' as const },
    ];
    const lists = await Promise.all(kinds.map((k) => getTokenAccountsByOwner(rpc, owner.toBase58(), k.program.toBase58(), toBase58)));
    const held = lists.flatMap((l, i) => l.filter((t) => t.amount === 1n).map((t) => ({ ...t, nftProgram: kinds[i]!.nftProgram })));
    if (held.length === 0) return { positions: [], unread: [] };
    const records = held.map((t) => derivePersonalPosition(programId, new PublicKey(t.mint)).toBase58());
    const recAccounts = await getMultipleAccounts(rpc, records);
    const found: { position: PersonalPositionView; nftAccount: string; nftProgram: WalletPosition['nftProgram'] }[] = [];
    recAccounts.forEach((a, i) => {
      // Most coins a wallet holds one of are not positions: no record at that address.
      if (a === null || !owned(a, programId)) return;
      const position = decodePersonalPosition(records[i]!, a.data);
      if (!position || position.nftMint !== held[i]!.mint) unreadable('a position record did not decode');
      found.push({ position: position!, nftAccount: held[i]!.address, nftProgram: held[i]!.nftProgram });
    });
    if (found.length === 0) return { positions: [], unread: [] };

    const poolIds = [...new Set(found.map((f) => f.position.poolId))];
    const poolAccounts = await getMultipleAccounts(rpc, poolIds);
    const pools = new Map<string, PoolStateView>();
    poolAccounts.forEach((a, i) => {
      if (!owned(a, programId)) return;
      const p = decodePoolState(poolIds[i]!, a!.data);
      if (p) pools.set(p.address, p);
    });
    const configIds = [...new Set([...pools.values()].map((p) => p.ammConfig))];
    const configs = new Map<string, AmmConfigView>();
    (await getMultipleAccounts(rpc, configIds)).forEach((a, i) => {
      if (!owned(a, programId)) return;
      const c = decodeAmmConfig(configIds[i]!, a!.data);
      if (c) configs.set(c.address, c);
    });

    // The bands holding each position's two ends: their fee records say what it earned since.
    const bandKey = (pool: string, start: number) => `${pool}:${start}`;
    const bandAddresses = new Map<string, string>();
    for (const { position } of found) {
      const pool = pools.get(position.poolId);
      if (!pool) continue;
      for (const t of [position.tickLowerIndex, position.tickUpperIndex]) {
        const start = getArrayStartIndex(t, pool.tickSpacing);
        bandAddresses.set(bandKey(pool.address, start), deriveTickArray(programId, new PublicKey(pool.address), start).toBase58());
      }
    }
    const keys = [...bandAddresses.keys()];
    const bandAccounts = await getMultipleAccounts(rpc, keys.map((k) => bandAddresses.get(k)!));
    const bands = new Map<string, TickArrayView>();
    bandAccounts.forEach((a, i) => {
      if (!owned(a, programId)) return;
      const b = decodeTickArray(bandAddresses.get(keys[i]!)!, a!.data);
      if (b) bands.set(keys[i]!, b);
    });

    const positions: WalletPosition[] = [];
    const unread: WalletPositionsRead['unread'] = [];
    for (const { position, nftAccount, nftProgram } of found) {
      const pool = pools.get(position.poolId);
      const config = pool ? configs.get(pool.ammConfig) : undefined;
      if (!pool || !config) {
        unread.push({ position: position.address, detail: 'its pool or the pool’s fee tier did not read' });
        continue;
      }
      const tickOf = (t: number) => {
        const band = bands.get(bandKey(pool.address, getArrayStartIndex(t, pool.tickSpacing)));
        return band?.ticks[(t - band.startTickIndex) / pool.tickSpacing] ?? null;
      };
      let amounts: WalletPosition['amounts'] = null;
      let fees: WalletPosition['fees'] = null;
      try {
        const [a0, a1] = position.liquidity > 0n ? getDeltaAmountsSigned(pool.tickCurrent, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex, -position.liquidity) : [0n, 0n];
        amounts = { amount0: a0, amount1: a1 };
        if (position.liquidity === 0n) {
          fees = { fee0: position.tokenFeesOwed0, fee1: position.tokenFeesOwed1 };
        } else {
          const lower = tickOf(position.tickLowerIndex);
          const upper = tickOf(position.tickUpperIndex);
          if (lower && upper && lower.tick === position.tickLowerIndex && upper.tick === position.tickUpperIndex) {
            const [g0, g1] = getFeeGrowthInside(lower, upper, pool.tickCurrent, pool.feeGrowthGlobal0X64, pool.feeGrowthGlobal1X64);
            fees = {
              fee0: calculateLatestTokenFees(position.tokenFeesOwed0, position.feeGrowthInside0LastX64, g0, position.liquidity),
              fee1: calculateLatestTokenFees(position.tokenFeesOwed1, position.feeGrowthInside1LastX64, g1, position.liquidity),
            };
          }
        }
      } catch (e) {
        if (!(e instanceof ClmmMathError)) throw e;
      }
      positions.push({
        position,
        nftAccount,
        nftProgram,
        pool,
        config,
        status: rangeStatus(pool, position),
        amounts,
        fees,
        rewardsOwed: position.rewardInfos.map((r) => r.rewardAmountOwed),
      });
    }
    return { positions, unread };
  });
}

/** A mint's freeze authority (null for none), or why the address is not a token mint at all. */
export type MintFreeze = { kind: 'mint'; freezeAuthority: string | null } | { kind: 'not-a-mint'; detail: string };

/**
 * A token's freeze authority as the chain has it: what the LP deposit's token check reads.
 * An address with no account, or one that is not a mint, is `not-a-mint`; a read that failed
 * is `unread`. Neither is ever "cannot be frozen".
 */
export function readFreezeAuthority(rpc: SolanaRpc, mint: string): Promise<Read<MintFreeze>> {
  return guard(async (): Promise<MintFreeze> => {
    const [a] = await getMultipleAccounts(rpc, [mint]);
    if (!a) return { kind: 'not-a-mint', detail: 'there is no account at this address' };
    const d = decodeMintAccount(a.owner, a.data);
    return d.ok ? { kind: 'mint', freezeAuthority: d.value.freezeAuthority } : { kind: 'not-a-mint', detail: d.reason };
  });
}

/** True when changing this position needs the pool's far-band map passed. */
export function positionNeedsExtension(pool: Pick<PoolStateView, 'tickSpacing'>, p: Pick<PersonalPositionView, 'tickLowerIndex' | 'tickUpperIndex'>): boolean {
  return isOverflowDefaultTickarrayBitmap(pool.tickSpacing, [p.tickLowerIndex, p.tickUpperIndex]);
}
