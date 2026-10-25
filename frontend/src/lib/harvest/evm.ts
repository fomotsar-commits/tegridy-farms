// Harvest on Ethereum and Base: which island pools there are, and what one pool's reads
// come to. Pure, so the planner is tested without a chain; the card does the reads and
// the sends (components/farm/HarvestCard.tsx).
import { BUNGALOWS, type Bungalow } from '../bungalows';
import { fmtAmount } from '../wallet/walletRows';
import type { HarvestClaim, HarvestPlan } from './types';

export const EVM_CHAIN_IDS = { ethereum: 1, base: 8453 } as const;

export type EvmHarvestRoom = Bungalow & { chain: 'ethereum' | 'base'; stakePool: string; address: string };

/** Every live Ethereum and Base room with a pool: the lock ladders and any plain (no-lock) pool. */
export function evmHarvestRooms(bungalows: readonly Bungalow[] = BUNGALOWS): EvmHarvestRoom[] {
  return bungalows.filter(
    (b): b is EvmHarvestRoom =>
      b.live && (b.chain === 'ethereum' || b.chain === 'base') && Boolean(b.stakePool) && Boolean(b.address),
  );
}

export interface EvmClaim extends HarvestClaim {
  chain: 'ethereum' | 'base';
  chainId: number;
  pool: `0x${string}`;
}

/** One pool's reads for the connected account. `null` = that read did not answer. */
export interface EvmPoolRead {
  earnedRaw: bigint | null;
  stakingToken: string | null;
  rewardsToken: string | null;
  /** The ladder's own `rewardSurplus()`: what it can pay now. Undefined on a plain pool, which has none. */
  surplusRaw?: bigint | null;
  decimals: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What one Ethereum or Base pool comes to. Both pool kinds pay `min(owed, what the vault
 * holds)` from `getReward()` and keep the rest owed, so an empty vault is a claim that
 * pays nothing and costs gas: held, not sent. A vault short of the amount still pays
 * what it holds, and the row says so.
 */
export function planEvmPool(room: EvmHarvestRoom, read: EvmPoolRead): HarvestPlan<EvmClaim> {
  const sym = room.symbol;
  const chainId = EVM_CHAIN_IDS[room.chain];
  const key = `evm:${room.id}`;
  const where = 'lighthouse pool';
  if (read.earnedRaw === null) {
    return { claims: [], held: [], unread: [{ key, chain: room.chain, roomId: room.id, what: `your ${sym} rewards`, detail: `the ${sym} pool did not answer` }] };
  }
  if (read.earnedRaw === 0n) return { claims: [], held: [], unread: [] };
  const held = (reason: string, amountRaw: bigint | null = read.earnedRaw) =>
    ({ claims: [], unread: [], held: [{ key, chain: room.chain, roomId: room.id, symbol: sym, where, amountRaw, decimals: read.decimals, reason }] });
  // The card's identity check (EvmLadderPoolLive): a pool that does not stake this room's
  // coin is a registry error, and its figures are not this coin's.
  if (read.stakingToken !== null && !same(read.stakingToken, room.address)) {
    return held(`This pool does not stake ${sym}, so Harvest leaves it alone.`, null);
  }
  // What the claim actually pays. Every island pool pays its own coin; one that does not
  // is not named here, and is claimed on its page.
  if (read.rewardsToken !== null && !same(read.rewardsToken, room.address)) {
    return held(`This pool pays another coin, so Harvest leaves it alone. Claim it on its page.`, null);
  }
  if (read.surplusRaw === 0n) {
    return held('Its reward vault is empty right now, so a claim would pay nothing. Nothing is lost: it stays owed.');
  }
  const caution = read.surplusRaw != null && read.surplusRaw < read.earnedRaw
    ? `The vault holds ${fmtAmount(read.surplusRaw, read.decimals)} ${sym} now: a claim pays that and the rest stays owed.`
    : null;
  return {
    claims: [{
      key, chain: room.chain, chainId, pool: room.stakePool as `0x${string}`, roomId: room.id, symbol: sym,
      where, detail: null, amountRaw: read.earnedRaw, decimals: read.decimals, caution,
    }],
    held: [],
    unread: [],
  };
}
