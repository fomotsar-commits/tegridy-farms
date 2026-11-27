// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../solanaPolyfill';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
// Harvest on Solana: what the wallet can claim in every Streamflow pool and in the lock
// ladder, and the claim for each. Loaded only once a Solana wallet is connected
// (components/farm/HarvestCard.tsx's dynamic import), like the dashboard's reads; the
// claims are signed by the page's one connection (lib/solanaSurface.ts `signer`).
//
// Every read and every claim is the pool card's own, wired the way that card wires it:
// Streamflow through readEntries/readPool and claimRewards (LighthousePoolLive), the
// ladder through readLadderPool/readLadderWallet/readVaultBalances + earnedNow and
// the claim and claim_carried instructions (SolanaLadderPoolLive). Each read is made once per
// load and shared with the dashboard's board (wallet/poolReads.ts). Each claim is its own
// transaction, test-run first, on its own wallet approval, sent by us
// (lib/solana/walletWrite.ts). Until 2026-11-17 several went on ONE approval
// (signAllTransactions); Phantom asked for one approval per transaction (ticket #467471).
// Since 2026-11-24 (owner: "you just have to claim once and confirm once") the claims go
// INSIDE one transaction instead, so one approval is still one transaction: a ladder's
// locks always (`ladderClaimAll`), and every sure claim of a run together (`solanaTogether`).
import { solanaRpcEndpoint } from '../solana';
import {
  claimBrokenByRateChange, claimRewards, claimRewardsInstructions,
  type PoolView, type StakeEntryView,
} from '../bungalowStaking';
import type { LadderWalletView } from '../ladder/read';
import { sharedEntries, sharedLadderPool, sharedLadderWallet, sharedPool, sharedVaultBalances } from '../wallet/poolReads';
import { ASSOCIATED_TOKEN_PROGRAM_ID, aprLabel, earnedNow, isLadderConfigured, ladderProgramId, perDayAtTodaysRate, sharePct, type LadderPoolView } from '../ladder/program';
import { basisBehindWrite, lastWriteFence } from '../ladder/writeFence';
import { LADDER_CLAIMS_PER_TX, ladderClaimAll, ladderClaimAllIxs, type WriteResult } from '../ladder/write';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { WALLET_GUARD_ROOM_BYTES, WRITE_COPY, sendOneWrite } from '../solana/walletWrite';
import { v1SignerOf } from '../solana/v1Signer';
import { MAX_LOADED_ACCOUNTS_DATA_SIZE, V1_TX_SIZE_LIMIT, assembleV1 } from '../launcher/solana/write/v1';
import { ladderRooms, type Bungalow } from '../bungalows';
import { clipReason, fmtAmount, solanaStakePools, type StakeTarget } from '../wallet/walletRows';
import type { SendTogether } from './run';
import type { ClaimResult, HarvestClaim, HarvestEarning, HarvestPlan, HarvestUnread } from './types';

export interface SolanaClaim extends HarvestClaim {
  chain: 'solana';
  /** This one claim, on its own wallet approval. */
  send: (signer: SignerWalletAdapter) => Promise<ClaimResult>;
  /**
   * This claim's instructions, unsent, to go beside the others in ONE transaction
   * (`solanaTogether`). Only on a claim with no caution: one that may not pay goes alone, so
   * it can never sink the rest. Null when they could not be built.
   */
  instructions?: (owner: PublicKey) => Promise<readonly TransactionInstruction[] | null>;
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
        ...(caution === null ? {
          instructions: async (owner: PublicKey) => {
            const built = await claimRewardsInstructions({ claimant: owner, pool, rewardPool: rp, entryNonce: e.nonce });
            return built.ok ? built.ixs : null;
          },
        } : {}),
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
 * What the wallet's lock-ladder positions come to: ONE claim for every open position with
 * something earned and any rewards carried from a closed position, on one transaction and
 * one wallet approval (owner, 2026-11-24: "claim once and confirm once"; lib/ladder/write.ts
 * `ladderClaimAll`). Past LADDER_CLAIMS_PER_TX of them, one more claim per that many. A
 * ladder claim pays `min(owed, reward vault)` and keeps the rest owed (invariant I-2), so
 * an empty vault is held and a short one is sent with a caution.
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
  // A position, by its nonce, or the carried rewards (null).
  const owed: { key: string; nonce: number | null; lockedRaw: bigint; amountRaw: bigint }[] = [];
  for (const p of wallet.open) {
    const earned = earnedNow(p, pool, nowSecs);
    if (earned > 0n) owed.push({ key: `ladder:${p.address}`, nonce: p.nonce, lockedRaw: p.amountRaw, amountRaw: earned });
  }
  if (stats.rewardsCarriedRaw > 0n) {
    owed.push({ key: `ladder:${stats.address}:carried`, nonce: null, lockedRaw: 0n, amountRaw: stats.rewardsCarriedRaw });
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
  for (let i = 0; i < owed.length; i += LADDER_CLAIMS_PER_TX) {
    const group = owed.slice(i, i + LADDER_CLAIMS_PER_TX);
    const positionNonces = group.flatMap((o) => (o.nonce === null ? [] : [o.nonce]));
    const carried = group.some((o) => o.nonce === null);
    const accounts = { programId: ladderProgramId(), pool: poolKey, poolAccounts: pool };
    plan.claims.push({
      key: group.length === 1 ? group[0]!.key : `ladder:${pool.address}:claims:${i}`,
      ...base, detail: ladderDetail(group, pool.decimals, sym), amountRaw: group.reduce((s, o) => s + o.amountRaw, 0n), caution,
      send: async (signer) =>
        ladderResult(await ladderClaimAll({ connection: connection(), invoker: signer, ...accounts }, { positionNonces, carried })),
      ...(caution === null ? { instructions: async (owner: PublicKey) => ladderClaimAllIxs(accounts, owner, { positionNonces, carried }) } : {}),
    });
  }
  return plan;
}

/** "on 1,000 BAYLA locked", "on 2,000 BAYLA in 2 locks", and "carried from a closed lock", alone or after either. */
function ladderDetail(group: readonly { nonce: number | null; lockedRaw: bigint }[], decimals: number, sym: string): string {
  const locks = group.filter((o) => o.nonce !== null);
  const locked = fmtAmount(locks.reduce((s, o) => s + o.lockedRaw, 0n), decimals);
  const on = locks.length === 0 ? null : locks.length === 1 ? `on ${locked} ${sym} locked` : `on ${locked} ${sym} in ${locks.length} locks`;
  const carried = locks.length < group.length ? 'carried from a closed lock' : null;
  return on && carried ? `${on}, and ${carried}` : (on ?? carried!);
}

/** Two equal idempotent token-account creates do one thing; the second only costs bytes. */
function onceEach(ixs: readonly TransactionInstruction[]): TransactionInstruction[] {
  const isCreate = (ix: TransactionInstruction) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.data.length === 1 && ix.data[0] === 1;
  const same = (a: TransactionInstruction, b: TransactionInstruction) =>
    a.programId.equals(b.programId) && a.data.equals(b.data) && a.keys.length === b.keys.length
    && a.keys.every((k, i) => k.pubkey.equals(b.keys[i]!.pubkey) && k.isSigner === b.keys[i]!.isSigner && k.isWritable === b.keys[i]!.isWritable);
  const out: TransactionInstruction[] = [];
  for (const ix of ixs) if (!(isCreate(ix) && out.some((o) => same(o, ix)))) out.push(ix);
  return out;
}

/**
 * Within Solana's size limit for what this wallet signs, less the room its own guards take:
 * measured as walletWrite.ts will build it, version 1 (4,096 bytes) for a wallet that signs
 * it, else version 0 (1,232; web3.js refuses to serialize past that, which is a no here).
 */
function fitsWithGuards(signer: SignerWalletAdapter, owner: PublicKey, ixs: readonly TransactionInstruction[]): boolean {
  const blockhash = PublicKey.default.toBase58();
  try {
    if (v1SignerOf(signer, owner)) {
      const budget = { computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE, priorityFeeLamports: 0n };
      return assembleV1(owner, blockhash, 0, budget, ixs).length + WALLET_GUARD_ROOM_BYTES <= V1_TX_SIZE_LIMIT;
    }
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [...ixs] }).compileToV0Message());
    return v0.serialize().length + WALLET_GUARD_ROOM_BYTES <= 1_232;
  } catch {
    return false;
  }
}

const PACK_REFUSED = 'The claims together did not pass their test run, so your wallet was not asked.';

/**
 * Every sure Solana claim of a run in ONE transaction, on ONE wallet approval (owner,
 * 2026-11-24: "you just have to claim once and confirm once"). It is still one transaction
 * per approval, as Phantom asks (ticket #467471): the claims sit side by side inside it, the
 * same instructions each would send alone, and it is test-run and its SOL checked before
 * the wallet is asked (lib/solana/walletWrite.ts).
 *
 * A claim with a caution, or with no instructions to pack, goes alone after the rest
 * (`{ alone }`), so one that may not pay can never sink the others. What says the pack
 * itself will not do (fewer than two to pack, too large with the wallet's guards, a test run
 * that refuses it, short of SOL, the wallet not signing it, the network refusing it) sends
 * every claim alone instead, as before. A network that could not be reached or a test run
 * that could not finish says so for them all, nothing sent, rather than turning a passing
 * blip into one approval per claim; Check again packs them again. A cancel in the wallet is
 * a cancel. One transaction lands whole or not at all, so every claim in it shares its answer.
 */
export function solanaTogether(signer: SignerWalletAdapter): SendTogether<SolanaClaim> {
  return async (claims, settle) => {
    const owner = signer.publicKey;
    const packed = claims.filter((c) => c.instructions && c.caution === null);
    if (!owner || packed.length < 2) return 'one-by-one';
    const alone = claims.filter((c) => !packed.includes(c));
    let built: (readonly TransactionInstruction[] | null)[];
    try {
      built = await Promise.all(packed.map((c) => c.instructions!(owner)));
    } catch {
      return 'one-by-one';
    }
    if (built.some((b) => !b || b.length === 0)) return 'one-by-one';
    const ixs = onceEach(built.flatMap((b) => b!));
    if (!fitsWithGuards(signer, owner, ixs)) return 'one-by-one';
    const end = await sendOneWrite(connection(), signer, owner, ixs, { refused: () => PACK_REFUSED, timeoutMs: 60_000 });
    const all = (r: ClaimResult) => packed.forEach((c) => settle(c.key, r));
    if (end.kind === 'not-sent') {
      if (end.stage === 'wallet' && end.declined) all({ kind: 'declined' });
      else if (end.stage === 'check' && end.reason !== WRITE_COPY.tooLarge) all({ kind: 'unconfirmed', reason: end.reason });
      else return 'one-by-one';
    } else if (end.outcome === 'confirmed') all({ kind: 'claimed', tx: end.signature });
    else if (end.outcome === 'reverted') all({ kind: 'reverted', reason: 'This landed on chain and reverted. Nothing moved, apart from the network fee.', tx: end.signature });
    else all({ kind: 'unconfirmed', reason: 'Sent, but not confirmed within a minute, so it may still land. Check the signature below before retrying.', tx: end.signature });
    return alone.length ? { alone } : 'done';
  };
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
