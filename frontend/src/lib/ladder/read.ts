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
  associatedTokenAddress,
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
  /**
   * The wallet's weight and the pool's `total_weighted`, READ IN ONE getMultipleAccounts
   * CALL — so both come from the same slot by construction. Null when that could not be
   * established (a partial scan, a pool account missing from the call, nothing staked).
   *
   * ⚠️ THE ONLY HONEST INPUT TO A SHARE. The pool and the wallet used to be read in
   * separate requests. On a stake BOTH the wallet's weight and `total_weighted` rise, so a
   * wallet read carrying the NEW weight over a pool read still carrying the OLD total
   * printed a share better than the truth: pool 100, you hold 10, you stake +10 — you
   * hold 20 of 110 (18.2%), and the stale pair printed 20/100 = 20%. The `mine > total`
   * guard cannot see it, because 20 < 100.
   *
   * WHY ONE CALL AND NOT SLOT ORDERING. Recording each read's `context.slot` and trusting
   * the pair when the pool is the fresher one covers a STAKE (any weight the wallet read
   * holds is already in a later total, so the share can only under-read) — but not an
   * EXIT: a wallet read from before your exit still counts the closed position, a later
   * pool total no longer does, and the share over-reads while the order check passes.
   * The card's own re-read after an exit lands exactly that pair whenever the pool
   * answers first. Same-slot has no ordering to get wrong.
   */
  shareBasis: { mineWeight: bigint; totalWeighted: bigint } | null;
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
  if (!statsInfo) return { ok: true, value: { stats: null, slots: [], open: [], truncated: false, shareBasis: null } };

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
  // getMultipleAccounts takes up to 100 addresses in ONE call: 99 positions + the pool,
  // which rides along so a share can be computed from a single slot (`shareBasis`).
  const BATCH = 99;
  const MAX_SCAN = 10 * BATCH; // 10 calls; past this we say so rather than guess

  // The pool's `total_weighted` out of one call's result, or null. Same checks as
  // readLadderPool: the owner first, then a decode — never a number from a stranger.
  const totalFrom = (info: Awaited<ReturnType<Connection['getAccountInfo']>> | undefined): bigint | null => {
    // No `instanceof PublicKey`: the adapter's Connection may come from another copy of
    // web3.js, and a class check would then refuse every real pool.
    try {
      if (!info || !info.owner.equals(programId)) return null;
      const d = decodeLadderPool(pool.toBase58(), info.data);
      return d.ok ? d.value.totalWeighted : null;
    } catch {
      return null;
    }
  };
  let lastCallTotal: bigint | null = null;
  let callsWithOpen = 0;

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
      infos = await conn.getMultipleAccountsInfo([...addrs, pool], 'confirmed');
    } catch (e) {
      return unreadable(`your positions could not be read: ${(e as Error).message}`);
    }
    lastCallTotal = totalFrom(infos[addrs.length]);
    const foundBefore = found;
    nonces.forEach((n, i) => {
      const info = infos[i];
      // ABSENT MEANS CLOSED. Anchor's `close` drains the account, and every nonce
      // below next_nonce was issued at some point — so nothing here is "missing".
      if (!info) { slots.push({ nonce: n, state: 'closed' }); return; }
      const d = decodeLadderPosition(addrs[i]!.toBase58(), info.data);
      if (d.ok) { found += 1; slots.push({ nonce: n, state: 'open', position: d.value }); }
      else slots.push({ nonce: n, state: 'unreadable', reason: d.reason });
    });
    if (found > foundBefore) callsWithOpen += 1;
    scanned += nonces.length;
  }
  if (found < wanted && scanned >= MAX_SCAN) truncated = true;

  slots.sort((a, b) => a.nonce - b.nonce);
  const open = slots.flatMap((x) => (x.state === 'open' ? [x.position] : []));

  // ── THE SHARE BASIS ─────────────────────────────────────────────────────
  // A partial list is a partial sum: no basis. Otherwise, if every open position came
  // back in ONE call, that call's own pool snapshot is the basis. The scan stops right
  // after the call that completed the count, so that call is the last one, and a
  // position absent from an earlier call is CLOSED for good — nonces never reopen.
  //
  // Open positions spread over SEVERAL calls are several slots: one found early may
  // have closed by the last call, whose total would then no longer include it. So they
  // are read again, all together with the pool, in ONE more call (at most MAX_POSITIONS
  // + 1 addresses). One that vanished in between closed, and is out of both sides; one
  // that no longer decodes, or a missing pool, is no basis at all.
  let shareBasis: LadderWalletView['shareBasis'] = null;
  if (!truncated && found >= wanted && open.length > 0) {
    if (callsWithOpen === 1) {
      if (lastCallTotal !== null) {
        shareBasis = { mineWeight: open.reduce((a, p) => a + p.weight, 0n), totalWeighted: lastCallTotal };
      }
    } else {
      try {
        const addrs = open.map((p) => positionPda(programId, pool, owner, p.nonce));
        const infos = await conn.getMultipleAccountsInfo([...addrs, pool], 'confirmed');
        const total = totalFrom(infos[addrs.length]);
        let mine = 0n;
        let undecodable = false;
        for (let i = 0; i < addrs.length; i++) {
          const info = infos[i];
          if (!info) continue;                           // closed since: out of both sides
          const d = decodeLadderPosition(addrs[i]!.toBase58(), info.data);
          if (d.ok) mine += d.value.weight;
          else undecodable = true;
        }
        if (total !== null && !undecodable) shareBasis = { mineWeight: mine, totalWeighted: total };
      } catch {
        // No basis — the positions themselves were read, so the view still stands.
      }
    }
  }

  return {
    ok: true,
    value: {
      stats: s.value,
      slots,
      open,
      // NOT a silent cap. The caller must be able to say "there are more" rather
      // than presenting a partial list as complete.
      truncated,
      shareBasis,
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

/**
 * How much of the pool's mint this wallet actually holds.
 *
 * ONE call, and it distinguishes the two zeros. `getTokenAccountBalance` throws on a
 * missing account, which makes "this wallet holds none" and "the RPC did not answer"
 * the same exception — and this venue's rule is that those must never be the same
 * answer. So it reads the account directly:
 *
 *   - no account            -> 0n. A wallet with no token account holds no tokens.
 *                             That is a fact, and a real zero.
 *   - the account is there  -> the `amount` field, at offset 64.
 *   - the read threw        -> null. An outage, which the caller must render as one.
 *
 * Offset 64 is the `amount` u64 in the SPL token-account layout (mint 32, owner 32,
 * amount 8), and Token-2022 keeps that base layout ahead of its extensions — which is
 * why this works for BAYLA without branching on the token program.
 */
export async function readOwnerTokenBalance(
  conn: Connection, mint: string, owner: PublicKey, tokenProgram: string,
): Promise<bigint | null> {
  let ata: PublicKey;
  try {
    ata = associatedTokenAddress(new PublicKey(mint), owner, new PublicKey(tokenProgram));
  } catch {
    return null;
  }
  try {
    const info = await conn.getAccountInfo(ata, 'confirmed');
    if (!info) return 0n;
    if (info.data.length < 72) return null;   // not a token account; do not guess
    const v = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    return v.getBigUint64(64, true);
  } catch {
    return null;
  }
}
