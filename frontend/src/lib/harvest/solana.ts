// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../solanaPolyfill';
import { Connection, PublicKey } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
// Harvest on Solana: what the wallet can claim in every Streamflow pool and in the lock
// ladder, and the claim for each. Loaded only once a Solana wallet is connected
// (components/farm/HarvestCard.tsx's dynamic import), like the dashboard's reads; the
// claims are signed by the page's one connection (lib/solanaSurface.ts `signer`).
//
// Every read and every claim is the pool card's own, wired the way that card wires it:
// Streamflow through readEntries/readPool and claimRewards (LighthousePoolLive), the
// ladder through readLadderPool/readLadderWallet/readVaultBalances + earnedNow and
// ladderClaim/ladderClaimCarried (SolanaLadderPoolLive). Each read is made once per load and
// shared with the dashboard's board (wallet/poolReads.ts). Each claim is one of those
// calls: its own transaction, test-run first, on its own wallet approval, sent by us
// (lib/solana/walletWrite.ts). Until 2026-11-17 several went on ONE approval
// (signAllTransactions); Phantom asked for one approval per transaction (ticket #467471).
import { solanaRpcEndpoint } from '../solana';
import {
  claimBrokenByRateChange, claimRewards,
  type PoolView, type StakeEntryView,
} from '../bungalowStaking';
import type { LadderWalletView } from '../ladder/read';
import { sharedEntries, sharedLadderPool, sharedLadderWallet, sharedPool, sharedVaultBalances } from '../wallet/poolReads';
import { aprLabel, earnedNow, isLadderConfigured, ladderProgramId, perDayAtTodaysRate, sharePct, type LadderPoolView } from '../ladder/program';
import { basisBehindWrite, lastWriteFence } from '../ladder/writeFence';
import { ladderClaim, ladderClaimCarried, type LadderWriteCtx, type WriteResult } from '../ladder/write';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { ladderRooms, type Bungalow } from '../bungalows';
import { clipReason, fmtAmount, solanaStakePools, type StakeTarget } from '../wallet/walletRows';
import type { ClaimResult, HarvestClaim, HarvestEarning, HarvestPlan, HarvestUnread } from './types';

export interface SolanaClaim extends HarvestClaim {
  chain: 'solana';
  /** This one claim, on its own wallet approval. */
  send: (signer: SignerWalletAdapter) => Promise<ClaimResult>;
}

type Plan = HarvestPlan<SolanaClaim>;

// The endpoint and commitment SolanaProviders' ConnectionProvider uses, so a claim here
// reads and sends exactly as the pool card's would.
let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(solanaRpcEndpoint(), 'confirmed'));

const empty = (): Plan => ({ claims: [], held: [], unread: [] });

/** A Streamflow claim's answer. Its reason already says whether the outcome is unknown. */
export function streamflowResult(r: { ok: true; txId: string } | { ok: false; reason: string }): ClaimResult {
  if (r.ok) return { kind: 'claimed', tx: r.txId };
  if (r.reason === DECLINED_IN_WALLET) return { kind: 'declined' };
  return { kind: 'unconfirmed', reason: r.reason };
}

/** A ladder claim's answer. A signature means it was sent; the reason says what is known. */
export function ladderResult(r: WriteResult): ClaimResult {
  if (r.ok) return { kind: 'claimed', tx: r.signature };
  if (r.reason === DECLINED_IN_WALLET) return { kind: 'declined' };
  return { kind: 'unconfirmed', reason: r.reason, ...(r.signature ? { tx: r.signature } : {}) };
}

/**
 * What the wallet's open stakes in one Streamflow pool come to: one claim per stake and
 * reward pool, as the pool card offers them, gated the way its buttons are.
 *
 *  - A reward the read did not price is not read, never nothing to claim.
 *  - A claim past what that reward pool's vault holds reverts (6012) until a top-up:
 *    held, not sent. Nothing is lost; it keeps accruing.
 *  - A stake from before the pool's rate change may not pay (claimBrokenByRateChange).
 *    That is a warning on the card, never a gate, so it is sent, last, and says so.
 *  - A reward pool paying another mint is not named here: held, for its page.
 */
export function planStreamflow(target: StakeTarget, pool: PoolView, entries: readonly StakeEntryView[]): Plan {
  const room = target.room;
  const sym = room.symbol;
  const where = target.retired ? 'old lighthouse pool' : 'lighthouse pool';
  const plan = empty();
  const base = { chain: 'solana' as const, roomId: room.id, symbol: sym, where };
  // TF-035, as the card checks it: a pool that does not stake this room's mint is not this coin's.
  if (pool.mint !== (room.address ?? '')) {
    plan.held.push({ key: `sf:${pool.address}`, ...base, amountRaw: null, decimals: pool.decimals, reason: `This pool does not stake ${sym}, so Harvest leaves it alone.` });
    return plan;
  }
  let unpriced = false;
  for (const e of entries) {
    if (e.closedTs !== 0) continue;
    if (e.pendingUnread) {
      unpriced = true;
      continue;
    }
    const detail = `on ${fmtAmount(e.amountRaw, pool.decimals)} ${sym} staked`;
    for (const rp of pool.rewardPools) {
      const key = `sf:${pool.address}:${e.nonce}:${rp.kind}:${rp.nonce}`;
      const pending = e.pendingRaw[rp.nonce];
      if (pending === undefined || pending === null) {
        unpriced = true;
        continue;
      }
      if (pending === 0n) continue;
      if (rp.mint !== pool.mint) {
        plan.held.push({ key, ...base, amountRaw: null, decimals: rp.decimals, reason: 'This reward pays another coin, so Harvest leaves it alone. Claim it on its page.' });
        continue;
      }
      if (rp.fundedRaw !== null && pending > rp.fundedRaw) {
        plan.held.push({ key, ...base, amountRaw: pending, decimals: rp.decimals, reason: 'The reward vault cannot cover this yet, so a claim would fail. Nothing is lost: it stays owed.' });
        continue;
      }
      const caution = claimBrokenByRateChange(e, rp)
        ? 'This stake was made before the pool changed its reward rate, so this claim may not pay. If it does not, nothing is claimed.'
        : null;
      plan.claims.push({
        key, ...base, detail, amountRaw: pending, decimals: rp.decimals, caution,
        send: async (signer) => streamflowResult(await claimRewards({ invoker: signer, pool, rewardPool: rp, entryNonce: e.nonce })),
      });
    }
  }
  if (unpriced) {
    plan.unread.push({ key: `sf:${pool.address}`, chain: 'solana', roomId: room.id, what: `your ${sym} rewards in the ${where}`, detail: 'some of your stakes could not be priced just now' });
  }
  return plan;
}

/**
 * What the wallet's open locks in one ladder earn a day at today's rate, and that as a yearly
 * rate on the stake behind them: the two figures the ladder's own card prints under "You earn
 * per day" (SolanaLadderPoolLive.tsx), worked out by the card's own rule, so Earn and the pool's
 * page can never state two different numbers for one wallet.
 *
 *  - The share's two inputs come from ONE slot (`shareBasis`), and the separately read pool
 *    total only bounds it: of the two readings the LOWER share is used, so the larger total
 *    and the smaller daily figure. Either reading refused (a partial list, your weight above
 *    the total, a zero total) is no figure.
 *  - A read that may predate the wallet's own confirmed write (`stale`) is no figure.
 *  - Each position's figure is its own weight's; the wallet's is their sum. One that cannot
 *    be stated (no reward window, one that has ended, a pool under its weight floor) is no
 *    figure for the wallet at all: a part left out would understate the rest.
 * Null is "not stated", and the card draws nothing for it. Never a zero.
 */
export function ladderEarning(room: Bungalow, pool: LadderPoolView, wallet: LadderWalletView, nowSecs: number, stale = false): HarvestEarning | null {
  const stats = wallet.stats;
  const basis = wallet.shareBasis;
  if (!stats || !basis || stale || wallet.open.length === 0) return null;
  if (pool.mint !== (room.address ?? '')) return null;
  const partial = wallet.truncated || wallet.slots.some((s) => s.state === 'unreadable') || stats.openPositions > wallet.open.length;
  const own = sharePct({ mineWeight: basis.mineWeight, totalWeighted: basis.totalWeighted, truncated: partial });
  const bound = sharePct({ mineWeight: basis.mineWeight, totalWeighted: pool.totalWeighted, truncated: partial });
  if (!own || !bound) return null;
  const total = own.pct <= bound.pct ? basis.totalWeighted : pool.totalWeighted;
  let perDayRaw = 0n;
  let principalRaw = 0n;
  for (const p of wallet.open) {
    const day = perDayAtTodaysRate(p.weight, total, pool, nowSecs);
    if (day === null) return null;
    perDayRaw += day;
    principalRaw += p.amountRaw;
  }
  const apr = aprLabel(perDayRaw, principalRaw);
  if (apr === null) return null;
  return {
    key: `ladder:${pool.address}`, chain: 'solana', roomId: room.id, symbol: room.symbol, where: 'lock ladder',
    decimals: pool.decimals, principalRaw, perDayRaw, apr, fundedToSecs: Number(pool.periodFinish),
  };
}

/**
 * What the wallet's lock-ladder positions come to: one claim per open position with
 * something earned, plus one for rewards carried from a closed position. A ladder claim
 * pays `min(owed, reward vault)` and keeps the rest owed (invariant I-2), so an empty
 * vault is held and a short one is sent with a caution.
 */
export function planLadder(room: Bungalow, pool: LadderPoolView, wallet: LadderWalletView, vaultRewardRaw: bigint | null, nowSecs: number, stale = false): Plan {
  const sym = room.symbol;
  const where = 'lock ladder';
  const plan = empty();
  const base = { chain: 'solana' as const, roomId: room.id, symbol: sym, where, decimals: pool.decimals };
  if (pool.mint !== (room.address ?? '')) {
    plan.held.push({ key: `ladder:${pool.address}`, ...base, amountRaw: null, reason: `This pool does not stake ${sym}, so Harvest leaves it alone.` });
    return plan;
  }
  const stats = wallet.stats;
  if (!stats) return plan;
  // What the open locks earn a day, whether or not anything is claimable right now.
  const earning = ladderEarning(room, pool, wallet, nowSecs, stale);
  if (earning) plan.earning = [earning];
  else if (stale && wallet.open.length > 0) plan.settling = true;
  // A read can succeed and still be partial (read.ts): the positions it found are claimed,
  // and the rest are named as not read.
  if (wallet.truncated || wallet.slots.some((s) => s.state === 'unreadable') || stats.openPositions > wallet.open.length) {
    plan.unread.push({ key: `ladder:${pool.address}`, chain: 'solana', roomId: room.id, what: `some of your ${sym} locks`, detail: 'not every lock could be read just now' });
  }
  const owed: {
    key: string; detail: string; amountRaw: bigint;
    claim: (ctx: LadderWriteCtx) => Promise<WriteResult>;
  }[] = [];
  for (const p of wallet.open) {
    const earned = earnedNow(p, pool, nowSecs);
    if (earned > 0n) {
      owed.push({
        key: `ladder:${p.address}`, detail: `on ${fmtAmount(p.amountRaw, pool.decimals)} ${sym} locked`, amountRaw: earned,
        claim: (ctx) => ladderClaim(ctx, { positionNonce: p.nonce }),
      });
    }
  }
  if (stats.rewardsCarriedRaw > 0n) {
    owed.push({
      key: `ladder:${stats.address}:carried`, detail: 'carried from a closed lock', amountRaw: stats.rewardsCarriedRaw,
      claim: (ctx) => ladderClaimCarried(ctx),
    });
  }
  if (!owed.length) return plan;
  if (vaultRewardRaw === 0n) {
    for (const o of owed) {
      plan.held.push({ key: o.key, ...base, amountRaw: o.amountRaw, reason: 'The reward vault is empty right now, so a claim would pay nothing. Nothing is lost: it stays owed.' });
    }
    return plan;
  }
  const total = owed.reduce((s, o) => s + o.amountRaw, 0n);
  const caution = vaultRewardRaw !== null && vaultRewardRaw < total
    ? `The vault holds ${fmtAmount(vaultRewardRaw, pool.decimals)} ${sym} now: claims pay up to that and the rest stays owed.`
    : null;
  const poolKey = new PublicKey(pool.address);
  for (const o of owed) {
    plan.claims.push({
      key: o.key, ...base, detail: o.detail, amountRaw: o.amountRaw, caution,
      send: async (signer) =>
        ladderResult(await o.claim({ connection: connection(), invoker: signer, programId: ladderProgramId(), pool: poolKey, poolAccounts: pool })),
    });
  }
  return plan;
}

function merge(plans: readonly Plan[]): Plan {
  const earning = plans.flatMap((p) => p.earning ?? []);
  return {
    claims: plans.flatMap((p) => p.claims),
    held: plans.flatMap((p) => p.held),
    unread: plans.flatMap((p) => p.unread),
    ...(earning.length ? { earning } : {}),
    ...(plans.some((p) => p.settling) ? { settling: true as const } : {}),
  };
}

const unreadPlan = (u: HarvestUnread): Plan => ({ claims: [], held: [], unread: [u] });

async function readStreamflowHarvest(owner: string, target: StakeTarget): Promise<Plan> {
  const sym = target.room.symbol;
  const what = target.retired ? `your ${sym} stakes in its old pool` : `your ${sym} stakes`;
  const unread = (detail: string) => unreadPlan({ key: `sf:${target.pool}`, chain: 'solana', roomId: target.room.id, what, detail });
  try {
    const entries = await sharedEntries(target.pool, owner);
    if (!entries.ok) return unread(entries.reason);
    const open = entries.entries.filter((e) => e.closedTs === 0);
    if (!open.length) return empty();
    // The pool only for a pool the wallet is in, as the dashboard reads it.
    const pool = await sharedPool(target.pool);
    if (!pool.ok) return unread(pool.reason);
    return planStreamflow(target, pool.pool, open);
  } catch (e) {
    return unread(clipReason(e));
  }
}

async function readLadderHarvest(owner: string, room: Bungalow & { ladderPool: string }, nowSecs: number): Promise<Plan> {
  if (!isLadderConfigured()) return empty();
  const unread = (detail: string) => unreadPlan({ key: `ladder:${room.ladderPool}`, chain: 'solana', roomId: room.id, what: `your ${room.symbol} locks`, detail });
  try {
    const [p, w] = await Promise.all([sharedLadderPool(room.ladderPool), sharedLadderWallet(room.ladderPool, owner)]);
    if (!w.ok) return unread(w.reason);
    if (!w.value.stats) return empty();
    if (!p.ok) return unread(p.reason);
    const vaults = await sharedVaultBalances(p.value);
    // The wallet's own write on a ladder card fences the daily figure, as it does the card's share.
    const stale = w.value.shareBasis !== null && basisBehindWrite(lastWriteFence(), owner, w.value.shareBasis.slot);
    return planLadder(room, p.value, w.value, vaults.rewardRaw, nowSecs, stale);
  } catch (e) {
    return unread(clipReason(e));
  }
}

/**
 * Every Solana pool's harvest for this wallet. Each pool is read on its own; one that fails
 * is named, never zero.
 *
 * The Streamflow pools go ONE AT A TIME. Each is several program-account searches, and all
 * of them at once was a burst the RPC throttled: walked on 2026-10-24 against the keyless
 * public endpoint, 43 of 83 calls came back 429 and a wallet's two lighthouse stakes read
 * as not read. A ladder is a handful of plain account reads, so the ladders run alongside,
 * one room after another.
 */
export async function readSolanaHarvest(owner: string, nowSecs = Math.floor(Date.now() / 1000)): Promise<Plan> {
  const ladders = (async () => {
    const plans: Plan[] = [];
    for (const room of ladderRooms()) plans.push(await readLadderHarvest(owner, room, nowSecs));
    return plans;
  })();
  const stakes: Plan[] = [];
  for (const t of solanaStakePools()) stakes.push(await readStreamflowHarvest(owner, t));
  return merge([...stakes, ...(await ladders)]);
}
