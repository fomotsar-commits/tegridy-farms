// Reading `bayla-ladder` state, and classifying what came back.
//
// THIS IS A TRUST SURFACE, and it inherits `curve/read.ts`'s rule verbatim: three
// things look alike and must stay strictly apart —
//
//   1. read it, the answer is NO       — a real negative finding
//   2. read it, the answer is YES      — a real positive finding
//   3. COULD NOT READ IT               — not a finding about the pool at all
//
// So nothing below returns a number on failure. No `?? 0`, no `catch { return 0 }`.
// An RPC error is an RPC error, and it renders as an outage, never as an empty pool.
//
// ── WHY THERE IS NO ENUMERATION ─────────────────────────────────────────────
// `getProgramAccounts` is deliberately OFF the proxy's allowlist (api/solrpc.js) as
// an unbounded scan, so there is no way to list a pool's stakers from the browser
// and there never should be. Positions are found the way the program itself assigns
// them: read `UserStats.next_nonce`, then derive each position PDA newest-first and
// stop once `open_positions` live ones are accounted for. Bounded, and no scan.
//
// A CLOSED POSITION LEAVES NO ACCOUNT. Anchor's `close` drains the account, so an
// absent position at a nonce below `next_nonce` means CLOSED — not missing, and not
// an error. That distinction is load-bearing: rendering a closed position as an
// outage, or an outage as closed, are both wrong in ways a user would act on.
import { Connection, PublicKey } from '@solana/web3.js';
import {
  decodeLadderPool,
  decodeLadderPosition,
  decodeLadderUserStats,
  positionPda,
  userStatsPda,
  type LadderPoolView,
  type LadderPositionView,
  type LadderUserStatsView,
} from './program';

/** A read either produced a value, or says why it could not. */
export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; unreadable: true; reason: string };

const unreadable = (reason: string) => ({ ok: false as const, unreadable: true as const, reason });

/**
 * The pool, or an honest reason.
 *
 * Checks the OWNER before decoding: an account that exists at this address but
 * belongs to another program is a configuration error, not a malformed pool, and
 * saying so is the difference between "check your config" and "the pool is broken".
 */
export async function readLadderPool(
  conn: Connection, programId: PublicKey, pool: PublicKey,
): Promise<ReadResult<LadderPoolView>> {
  let info;
  try {
    info = await conn.getAccountInfo(pool, 'confirmed');
  } catch (e) {
    return unreadable(`the pool could not be read: ${(e as Error).message}`);
  }
  if (!info) return unreadable('there is no account at this pool address');
  if (!info.owner.equals(programId)) {
    return unreadable(
      `that address belongs to ${info.owner.toBase58()}, not the ladder program — check the configured pool`,
    );
  }
  const d = decodeLadderPool(pool.toBase58(), info.data);
  if (!d.ok) return unreadable(`the pool account did not decode (${d.reason})`);
  return { ok: true, value: d.value };
}

/** Both vault balances, each independently readable or not. */
export async function readVaultBalances(
  conn: Connection, pool: Pick<LadderPoolView, 'stakeVault' | 'rewardVault'>,
): Promise<{ stakeRaw: bigint | null; rewardRaw: bigint | null }> {
  const one = async (addr: string): Promise<bigint | null> => {
    try {
      const r = await conn.getTokenAccountBalance(new PublicKey(addr), 'confirmed');
      // A balance that does not parse is UNREADABLE, not zero.
      const a = r?.value?.amount;
      return typeof a === 'string' && /^\d+$/.test(a) ? BigInt(a) : null;
    } catch {
      return null;
    }
  };
  const [stakeRaw, rewardRaw] = await Promise.all([one(pool.stakeVault), one(pool.rewardVault)]);
  return { stakeRaw, rewardRaw };
}

export type PositionSlot =
  | { nonce: number; state: 'open'; position: LadderPositionView }
  | { nonce: number; state: 'closed' }
  | { nonce: number; state: 'unreadable'; reason: string };

export interface LadderWalletView {
  stats: LadderUserStatsView | null;
  /** The nonces this read actually looked at, classified. Newest-first scan, re-sorted. */
  slots: PositionSlot[];
  open: LadderPositionView[];
  /**
   * TRUE when the scan hit its bound before accounting for every open position.
   * The caller MUST surface this: a partial list presented as complete is the
   * "unreadable renders as fine" defect wearing a different hat.
   */
  truncated: boolean;
}

/**
 * Everything one wallet holds in one pool.
 *
 * `stats === null` means this wallet has never staked here — a real negative, not a
 * failure. Anything that could not be read is reported per-slot rather than
 * collapsing the whole view, so one bad account does not blank a page.
 */
export async function readLadderWallet(
  conn: Connection, programId: PublicKey, pool: PublicKey, owner: PublicKey,
): Promise<ReadResult<LadderWalletView>> {
  const statsAddr = userStatsPda(programId, pool, owner);
  let statsInfo;
  try {
    statsInfo = await conn.getAccountInfo(statsAddr, 'confirmed');
  } catch (e) {
    return unreadable(`your position could not be read: ${(e as Error).message}`);
  }
  // No UserStats at all = never staked in this pool. That is a fact, not an outage.
  if (!statsInfo) return { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };

  const s = decodeLadderUserStats(statsAddr.toBase58(), statsInfo.data);
  if (!s.ok) return unreadable(`your position account did not decode (${s.reason})`);

  // ── FINDING THE OPEN POSITIONS ──────────────────────────────────────────
  //
  // `next_nonce` is LIFETIME-CUMULATIVE and monotonic (state.rs:164; its
  // monotonicity is what prevents position revival, lib.rs's L-9 note).
  // `MAX_POSITIONS` bounds `open_positions`, NOT `next_nonce` — lib.rs:411 gates
  // `open_positions < MAX_POSITIONS`. So a wallet that has staked 25 times and
  // closed 24 of them has `next_nonce = 25`, `open_positions = 1`, and its one live
  // position sits at nonce 24.
  //
  // An earlier version of this function clamped the scan to `MAX_POSITIONS` and
  // would have shown that wallet NOTHING — the worst possible answer, since a
  // staker checking on their own money would be told they have none.
  //
  // So: scan NEWEST FIRST and stop once `open_positions` live ones are found. Newest
  // first because a closed position never reopens, so the live ones cluster at the
  // top. Batched, bounded, and honest when the bound is hit.
  const total = s.value.nextNonce;
  const wanted = s.value.openPositions;
  const BATCH = 100;          // getMultipleAccounts takes up to 100 addresses in ONE call
  const MAX_SCAN = 1_000;     // ~10 calls; past this we say so rather than guess

  const slots: PositionSlot[] = [];
  let found = 0;
  let scanned = 0;
  let truncated = false;

  for (let hi = total; hi > 0 && scanned < MAX_SCAN; hi -= BATCH) {
    // Stop as soon as every open position is accounted for. A wallet with one live
    // position out of a thousand lifetime nonces costs a single call.
    if (found >= wanted) break;
    const lo = Math.max(0, hi - BATCH);
    const nonces = Array.from({ length: hi - lo }, (_, i) => hi - 1 - i); // newest first
    const addrs = nonces.map((n) => positionPda(programId, pool, owner, n));
    let infos: (Awaited<ReturnType<Connection['getAccountInfo']>>)[];
    try {
      infos = await conn.getMultipleAccountsInfo(addrs, 'confirmed');
    } catch (e) {
      return unreadable(`your positions could not be read: ${(e as Error).message}`);
    }
    nonces.forEach((n, i) => {
      const info = infos[i];
      // ABSENT MEANS CLOSED. Anchor's `close` drains the account, and every nonce
      // below next_nonce was issued at some point — so nothing here is "missing".
      if (!info) { slots.push({ nonce: n, state: 'closed' }); return; }
      const d = decodeLadderPosition(addrs[i]!.toBase58(), info.data);
      if (d.ok) { found += 1; slots.push({ nonce: n, state: 'open', position: d.value }); }
      else slots.push({ nonce: n, state: 'unreadable', reason: d.reason });
    });
    scanned += nonces.length;
  }
  if (found < wanted && scanned >= MAX_SCAN) truncated = true;

  slots.sort((a, b) => a.nonce - b.nonce);
  return {
    ok: true,
    value: {
      stats: s.value,
      slots,
      open: slots.flatMap((x) => (x.state === 'open' ? [x.position] : [])),
      // NOT a silent cap. The caller must be able to say "there are more" rather
      // than presenting a partial list as complete.
      truncated,
    },
  };
}

/**
 * The next position nonce this wallet would be assigned.
 *
 * The position address for a NEW stake is program-assigned from `next_nonce`, so it
 * has to be read before the instruction can be addressed at all. Two stakes fired in
 * parallel from one wallet would collide on the same address; the second fails rather
 * than overwriting, which is the safe direction, but a UI must not fire them at once.
 */
export function nextPositionNonce(wallet: LadderWalletView): number {
  return wallet.stats?.nextNonce ?? 0;
}

/** This wallet's current principal in this pool — what the per-wallet cap counts. */
export function walletPrincipalRaw(wallet: LadderWalletView): bigint {
  return wallet.stats?.principalRaw ?? 0n;
}
