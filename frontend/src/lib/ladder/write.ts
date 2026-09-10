// Sending `bayla-ladder` transactions, and saying honestly what happened.
//
// The rule this file exists to hold, and the one the venue keeps relearning:
// ⚠️ A FAILURE AFTER BROADCAST IS NOT "NOTHING MOVED".
// web3.js throws the same shape of Error for "the RPC rejected this in preflight"
// and "we lost the connection while it was landing". Telling someone the second
// case moved nothing invites them to press the button again — and on `stake` that
// is a second lock of real money, for up to four years, that no button can undo.
// So the classifier below opens with the cases it can PROVE were pre-broadcast,
// and everything it cannot prove is reported as an unknown outcome carrying the
// signature, so the person can go and look before they retry.
//
// ── CONFIRMATION IS POLLED, NOT SUBSCRIBED ──────────────────────────────────
// `connection.confirmTransaction` opens a websocket subscription. The browser
// talks to `/api/solrpc`, which is HTTPS-only — there is no wss origin, and the
// CSP has no entry for one. So confirmation polls `getSignatureStatuses`, exactly
// as SolanaSwapPage.tsx:114 has done since the swap shipped; the proxy's own rate
// limit is written around that cadence (api/solrpc.js:172).
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import {
  claimCarriedIx, claimIx, createAtaIdempotentIx, emergencyWithdrawIx, exitIx, stakeIx,
  type PoolAccounts,
} from './ix';

/** Sent and confirmed, or an honest reason. Never a bare boolean. */
export type WriteResult =
  | { ok: true; signature: string }
  | { ok: false; reason: string; signature?: string };

/* ─────────────────────── the program's own error table ─────────────────────── */

/**
 * Anchor error code → what it means to the person who pressed the button.
 *
 * TAKEN FROM THE BUILT IDL (`solana/tegridy-amm/idl/bayla_ladder.json`), not
 * counted off the Rust enum by hand — the numbering is positional, so one inserted
 * variant shifts every code below it and a hand-count would silently mislabel every
 * error after the insertion point. `write.test.ts` re-derives this mapping from
 * `errors.rs` and fails if the two ever disagree.
 *
 * Only the variants a STAKER can actually reach get their own sentence. The
 * operator-only ones (timelock, cap-raise, authority) resolve to their name, which
 * is more useful than a wrong guess at what a user did.
 */
export const LADDER_ERRORS: Record<number, { name: string; human?: string }> = {
  6000: { name: 'Overflow', human: 'The amount overflowed the program’s arithmetic — nothing moved.' },
  6001: { name: 'ZeroAmount', human: 'That amount resolves to zero at this token’s precision — nothing moved.' },
  6002: { name: 'LockTooShort', human: 'The shortest lock this program allows is 7 days — nothing moved.' },
  6003: { name: 'LockTooLong', human: 'The longest lock this program allows is 4 years — nothing moved.' },
  // The message is load-bearing: the program measures what ARRIVED in the vault,
  // so a transfer-fee mint can fail this even when the amount you typed clears the
  // minimum. Saying "below the minimum" alone would send someone to re-type the
  // same number.
  6004: {
    name: 'BelowMinStake',
    human: 'This is below the pool’s minimum stake. The program measures what actually ARRIVES in the vault, so a token that charges a transfer fee needs a little more than the minimum. Nothing moved.',
  },
  6005: { name: 'TooManyPositions', human: 'You already hold the maximum number of open positions on this pool — close one first. Nothing moved.' },
  6006: { name: 'DepositCapExceeded', human: 'This would take the pool past its deposit cap — nothing moved.' },
  6007: { name: 'StillLocked', human: 'This position is still locked, so the no-penalty exit is refused until the lock ends. Early exit and the emergency hatch are both open, and both cost 25%. Nothing moved.' },
  6008: { name: 'UseWithdrawMatured', human: 'This position has already matured, so the program refused the penalty door and sent you to the free one. Nothing moved — and nothing was charged.' },
  6009: { name: 'Unauthorized', human: 'Only the pool’s authority can do that — nothing moved.' },
  6010: { name: 'NotDeployAuthority' },
  6011: { name: 'MintHasFreezeAuthority' },
  6012: { name: 'UnsupportedMintExtension' },
  6013: { name: 'WrongTokenProgram', human: 'The token program named does not own this mint — that is a configuration error, not a network problem. Nothing moved.' },
  6014: { name: 'RewardTooHigh' },
  6015: { name: 'CapCanOnlyRaise' },
  6016: { name: 'TimelockNotElapsed' },
  6017: { name: 'NoPendingChange' },
  6018: { name: 'InvalidParameter' },
  6019: { name: 'AlreadyDegraded' },
  6020: {
    name: 'EmissionExceedsFunding',
    human: 'The reward vault cannot cover this payout, so the program refused to pay rewards out of staked principal. Nothing moved, and nothing is lost — your rewards keep accruing and this clears once the vault is topped up.',
  },
  6021: {
    name: 'PrincipalInvariant',
    human: 'The program found its stake vault holding less than it has recorded, and stopped rather than proceed. Nothing moved. This is a condition for the operator, not something a retry fixes.',
  },
  6022: {
    name: 'WeightInvariant',
    human: 'The program found its position ledger out of step with itself and stopped rather than proceed. Nothing moved. This is a condition for the operator, not something a retry fixes.',
  },
  6023: { name: 'NothingToSweep' },
  6024: { name: 'RewardRateTooSmall' },
  6025: { name: 'MintHasMintAuthority' },
  6026: {
    name: 'PoolDegraded',
    human: 'This pool has been declared degraded: it takes no new stakes. Existing positions still exit, and while it is degraded they exit penalty-free. Nothing moved.',
  },
  6027: { name: 'WalletCapExceeded', human: 'This would take you past the per-wallet limit for this pool — nothing moved.' },
};

/**
 * The Anchor code in an error message, or null.
 *
 * BOTH FORMS ARE MATCHED because both are seen from the same button: Anchor's own
 * `AnchorError ... Error Number: 6007` when something parses the logs, and the bare
 * `custom program error: 0x1777` the RPC returns when nothing does. 0x1777 IS 6007,
 * and a classifier that reads only one of the two forms is silently half-dead.
 */
export function anchorCode(message: string): number | null {
  const dec = /Error Number:\s*(\d{4,5})/.exec(message);
  if (dec) return Number(dec[1]);
  const hex = /custom program error:\s*0x([0-9a-fA-F]+)/.exec(message);
  if (hex) return parseInt(hex[1]!, 16);
  return null;
}

/** True when the failure provably happened BEFORE anything was broadcast. */
function isPreBroadcast(message: string): boolean {
  // A simulation failure is the RPC refusing to forward the transaction at all.
  return /Transaction simulation failed|failed to simulate|preflight/i.test(message);
}

/**
 * Turn a thrown thing into a sentence — and, when it cannot be sure, into an
 * admission.
 *
 * `signature` is passed separately because the throw that matters most happens
 * AFTER `sendTransaction` returned one: at that point the transaction is on the
 * network, and the only honest answer is "go and look".
 */
export function classifyWriteError(err: unknown, signature?: string): WriteResult {
  const msg = err instanceof Error ? err.message : String(err ?? '');

  // A declined signature never reached the network. This is the one branch that
  // may say "nothing moved" without qualification.
  if (/reject|declin|denied|cancell?ed by user/i.test(msg)) {
    return { ok: false, reason: 'You declined the signature — nothing moved.' };
  }

  const code = anchorCode(msg);
  const known = code !== null ? LADDER_ERRORS[code] : undefined;
  if (known) {
    // A program error means the WHOLE transaction reverted. Whether it reverted in
    // preflight or on chain, no account changed — the only cost is the network fee
    // if it landed.
    return {
      ok: false,
      reason: known.human ?? `The program refused this (${known.name}) — nothing moved.`,
      ...(signature ? { signature } : {}),
    };
  }

  // Not enough SOL for rent + fee. A `stake` opens two accounts, so it costs more
  // than a claim does, and saying which action is expensive is the useful half.
  if (/insufficient (lamports|funds)|Attempt to debit an account but found no record/i.test(msg)) {
    return {
      ok: false,
      reason: 'Not enough SOL in this wallet to pay the rent and network fee — nothing moved. Opening a position creates two small accounts, so it costs a little more SOL than a claim does.',
    };
  }

  // Should be unreachable: every write here prepends an idempotent ATA create.
  if (/AccountNotInitialized|could not find account/i.test(msg)) {
    return {
      ok: false,
      reason: 'An account this transaction needs does not exist — nothing moved. If it persists, that is a configuration problem rather than something a retry fixes.',
      ...(signature ? { signature } : {}),
    };
  }

  if (!signature && isPreBroadcast(msg)) {
    return {
      ok: false,
      reason: `The network refused this transaction before sending it — nothing moved.${msg ? ` (${msg.slice(0, 160)})` : ''}`,
    };
  }

  // ⚠️ EVERYTHING ELSE IS UNKNOWN, and is reported as unknown.
  //
  // Once a signature exists the transaction is on the network; a timeout, a dropped
  // socket and an expired blockhash all fire AFTER broadcast, and it may still land.
  // Without a signature we still cannot prove the negative, so the wording stops
  // short of promising one.
  if (signature) {
    return {
      ok: false,
      reason: 'Outcome unknown — this was sent and may still land. Check your wallet or Solscan with the signature below before retrying.',
      signature,
    };
  }
  return {
    ok: false,
    reason: `This did not go through.${msg ? ` (${msg.slice(0, 160)})` : ''} If your wallet shows a pending transaction, check it before retrying.`,
  };
}

/* ─────────────────────────── submit ─────────────────────────── */

/**
 * Confirm by polling, never by subscribing — see the file header.
 *
 * Returns the outcome rather than throwing on a revert, so the caller can attach
 * the signature to whichever answer it gives.
 *
 * A FAILED POLL IS NOT A FAILED TRANSACTION. One RPC hiccup mid-flight must not be
 * reported as a revert; it keeps polling and the outcome is only unknown when the
 * clock runs out.
 */
async function pollConfirm(
  conn: Connection,
  signature: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<'confirmed' | 'reverted' | 'unknown'> {
  const start = now();
  for (;;) {
    const status = await (async () => {
      try {
        const r = await conn.getSignatureStatuses([signature]);
        return r?.value?.[0] ?? null;
      } catch {
        return null;
      }
    })();
    if (status) {
      if (status.err) return 'reverted';
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return 'confirmed';
      }
    }
    if (now() - start >= timeoutMs) return 'unknown';
    await sleep(2_000);
  }
}

export interface SubmitDeps {
  /** Injected so tests neither sleep nor depend on the wall clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Sign, send, and find out — the single place any ladder write leaves the browser.
 *
 * The signature is captured the instant `sendTransaction` returns and is threaded
 * into every answer after it, failures included. That is the whole point: a person
 * told "unknown" can only act on it if they are also told WHICH transaction to go
 * and look at.
 */
export async function submitLadder(
  conn: Connection,
  invoker: SignerWalletAdapter,
  instructions: TransactionInstruction[],
  deps: SubmitDeps = {},
): Promise<WriteResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const owner = invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };

  let signature: string | undefined;
  try {
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    tx.add(...instructions);
    signature = await invoker.sendTransaction(tx, conn);
    const outcome = await pollConfirm(conn, signature, timeoutMs, sleep, now);
    if (outcome === 'confirmed') return { ok: true, signature };
    if (outcome === 'reverted') {
      // It landed and reverted. ASK THE CHAIN WHY rather than guessing: the status
      // object carries an opaque InstructionError, while the transaction's own logs
      // carry the Anchor code the error table can name.
      let logs = '';
      try {
        const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        logs = (t?.meta?.logMessages ?? []).join('\n');
      } catch {
        /* the reason stays generic rather than becoming wrong */
      }
      if (logs && anchorCode(logs) !== null) return classifyWriteError(new Error(logs), signature);
      return {
        ok: false,
        reason: 'This landed on chain and reverted — nothing moved, apart from the network fee.',
        signature,
      };
    }
    return {
      ok: false,
      reason: 'Sent, but not confirmed within a minute — it may still land. Check the signature below before retrying.',
      signature,
    };
  } catch (err) {
    return classifyWriteError(err, signature);
  }
}

/* ─────────────────────────── the five doors ─────────────────────────── */

export interface LadderWriteCtx {
  connection: Connection;
  invoker: SignerWalletAdapter;
  programId: PublicKey;
  pool: PublicKey;
  poolAccounts: PoolAccounts;
  deps?: SubmitDeps;
}

/**
 * Every write prepends an idempotent ATA create — see `createAtaIdempotentIx`.
 *
 * On `stake` it is redundant by construction (the tokens being staked are already
 * in that account). On every other door it is the difference between a payout and
 * an `AccountNotInitialized` revert, for anyone whose token account was closed
 * while their position was locked.
 */
function withAta(ctx: LadderWriteCtx, owner: PublicKey, ix: TransactionInstruction): TransactionInstruction[] {
  return [
    createAtaIdempotentIx({
      payer: owner,
      owner,
      mint: new PublicKey(ctx.poolAccounts.mint),
      tokenProgram: new PublicKey(ctx.poolAccounts.tokenProgram),
    }),
    ix,
  ];
}

const common = (ctx: LadderWriteCtx, owner: PublicKey) => ({
  programId: ctx.programId,
  owner,
  pool: ctx.pool,
  poolAccounts: ctx.poolAccounts,
});

/**
 * Open a position.
 *
 * `positionNonce` MUST be a freshly read `UserStats.next_nonce`: the program
 * derives the position account from it, so a stale value addresses an account that
 * already exists and the transaction fails rather than overwriting it. That is the
 * safe direction, but it means two stakes must never be fired in parallel.
 */
export async function ladderStake(
  ctx: LadderWriteCtx,
  args: { positionNonce: number; amountRaw: bigint; lockSecs: number },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    withAta(ctx, owner, stakeIx({ ...common(ctx, owner), ...args })),
    ctx.deps,
  );
}

/** Pay accrued rewards on one position. Reward vault only (invariant I-12). */
export async function ladderClaim(
  ctx: LadderWriteCtx, args: { positionNonce: number },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    withAta(ctx, owner, claimIx({ ...common(ctx, owner), ...args })),
    ctx.deps,
  );
}

/**
 * Close a position through one of the two normal doors.
 *
 * The caller picks with `quoteExit()`, which is also what shows the price first.
 * Picking the wrong one is not dangerous — the program refuses it (6007/6008)
 * rather than charging a penalty by accident — but it wastes a fee.
 */
export async function ladderExit(
  ctx: LadderWriteCtx, args: { positionNonce: number; early: boolean },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    withAta(ctx, owner, exitIx({ ...common(ctx, owner), ...args })),
    ctx.deps,
  );
}

/**
 * The hatch: principal out, no reward accounting, so it cannot revert on an
 * accounting drift or a dry reward vault.
 *
 * ⚠️ NOT FREE WHILE LOCKED — it charges the same flat 25% as `early_exit` unless
 * the position has matured or the pool is degraded. Quote it with `quoteExit()`
 * and show the number before calling this.
 */
export async function ladderHatch(
  ctx: LadderWriteCtx, args: { positionNonce: number },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    withAta(ctx, owner, emergencyWithdrawIx({ ...common(ctx, owner), ...args })),
    ctx.deps,
  );
}

/** Pay out `rewards_carried` — the balance the hatch leaves behind. */
export async function ladderClaimCarried(ctx: LadderWriteCtx): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    withAta(ctx, owner, claimCarriedIx(common(ctx, owner))),
    ctx.deps,
  );
}
