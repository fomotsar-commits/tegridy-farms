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
// CSP has no entry for one. So confirmation polls `getSignatureStatuses`
// (lib/solana/confirm.ts, shared with the swap page); the proxy's own rate limit is
// written around that cadence (api/solrpc.js:172).
//
// ── VERSION 1 FOR A WALLET THAT SIGNS IT (2026-11-09) ───────────────────────
// Phantom's red "could be malicious" sheet on a staking claim is its transaction-
// simulation warning, and its answer on ticket #455104 names the cure: a SIMD-0385
// version 1 message with the compute and loaded-account-data limits in its config,
// a test run first with signature checks off, the wallet asked only to SIGN, and our
// own send with preflight on. The pool writes do this since #1154; `submitV1` below
// does it here, with the same builder (launcher/solana/write/v1.ts). A wallet that
// does not advertise version 1 keeps the legacy path, unchanged.
import { Connection, PublicKey, Transaction, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { base58 } from '@scure/base';
import { createSolanaRpc, signature as kitSignature } from '@solana/kit';
import {
  claimCarriedIx, claimIx, createAtaIdempotentIx, emergencyWithdrawIx, exitIx, extendLockIx, stakeIx,
  type PoolAccounts,
} from './ix';
import { MAX_EARLY_EXIT_PENALTY_BPS } from './program';
import { holdReload } from '../reloadHold';
import { pollConfirm } from '../solana/confirm';
import { readSendThrow, signThrowCopy } from '../solana/walletThrow';
import { lostAnswerCopy } from '../solana/swap/walletCopy';
import { v1SignerOf } from '../solana/v1Signer';
import {
  MAX_LOADED_ACCOUNTS_DATA_SIZE, V1_TX_SIZE_LIMIT, assembleV1, decodeV1, loadedDataLimitFromSimulation, verifyV1Signatures,
  type V1Wire,
} from '../launcher/solana/write/v1';

/**
 * Sent and confirmed, or an honest reason. Never a bare boolean.
 *
 * `slot` is the slot the transaction CONFIRMED at (getSignatureStatuses'
 * `value[0].slot`), or null when the status did not carry one. The card fences its
 * share on it: a read taken at an earlier slot predates this write, however recently it
 * arrived — an RPC node can still be behind it. Null is not "no fence"; the card treats
 * a missing slot as stale (fail closed).
 */
export type WriteResult =
  | { ok: true; signature: string; slot: number | null }
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
  6000: { name: 'Overflow', human: 'The amount overflowed the program’s arithmetic. Nothing moved.' },
  6001: { name: 'ZeroAmount', human: 'That amount resolves to zero at this token’s precision. Nothing moved.' },
  6002: { name: 'LockTooShort', human: 'The shortest lock this program allows is 7 days. Nothing moved.' },
  6003: { name: 'LockTooLong', human: 'The longest lock this program allows is 4 years. Nothing moved.' },
  // The message is load-bearing: the program measures what ARRIVED in the vault,
  // so a transfer-fee mint can fail this even when the amount you typed clears the
  // minimum. Saying "below the minimum" alone would send someone to re-type the
  // same number.
  6004: {
    name: 'BelowMinStake',
    human: 'This is below the pool’s minimum stake. The program measures what actually ARRIVES in the vault, so a token that charges a transfer fee needs a little more than the minimum. Nothing moved.',
  },
  6005: { name: 'TooManyPositions', human: 'You already hold the maximum number of open positions on this pool, so close one first. Nothing moved.' },
  6006: { name: 'DepositCapExceeded', human: 'This would take the pool past its deposit cap. Nothing moved.' },
  6007: { name: 'StillLocked', human: `This position is still locked, so the no-penalty exit is refused until the lock ends. Early exit and the emergency hatch are both open, and both cost the same share of principal: the time left on the lock over four years, capped at ${MAX_EARLY_EXIT_PENALTY_BPS / 100}%. Nothing moved.` },
  6008: { name: 'UseWithdrawMatured', human: 'This position has already matured, so the program refused the penalty door and sent you to the free one. Nothing moved, and nothing was charged.' },
  6009: { name: 'Unauthorized', human: 'Only the pool’s authority can do that. Nothing moved.' },
  6010: { name: 'NotDeployAuthority' },
  6011: { name: 'MintHasFreezeAuthority' },
  6012: { name: 'UnsupportedMintExtension' },
  6013: { name: 'WrongTokenProgram', human: 'The token program named does not own this mint. That is a configuration error, not a network problem. Nothing moved.' },
  6014: { name: 'RewardTooHigh' },
  6015: { name: 'CapCanOnlyRaise' },
  6016: { name: 'TimelockNotElapsed' },
  6017: { name: 'NoPendingChange' },
  6018: { name: 'InvalidParameter' },
  6019: { name: 'AlreadyDegraded' },
  6020: {
    name: 'EmissionExceedsFunding',
    human: 'The reward vault cannot cover this payout, so the program refused to pay rewards out of staked principal. Nothing moved, and nothing is lost: your rewards keep accruing and this clears once the vault is topped up.',
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
  6027: { name: 'WalletCapExceeded', human: 'This would take you past the per-wallet limit for this pool. Nothing moved.' },
  // Operator-only: `notify_reward` refusing to lower the rate inside a live window.
  6028: { name: 'RewardRateWouldDecrease' },
  // `extend_lock`, added 2026-10-29.
  6029: { name: 'LockExpired', human: 'This lock has already ended, so it cannot be extended. Withdraw it (no penalty), then stake again for a new lock. Nothing moved.' },
  6030: { name: 'LockNotExtended', human: 'The new lock must end later than the one you have. Nothing moved.' },
  6031: { name: 'BoostWouldDrop', human: 'That lock would lower this position’s boost, so the program refused it. Pick a lock at least as long as the one you opened it with. Nothing moved.' },
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

/** The program's own sentence for the Anchor code in `message`, or null when the table has none. */
function knownRefusal(message: string): string | null {
  const code = anchorCode(message);
  const known = code !== null ? LADDER_ERRORS[code] : undefined;
  return known ? known.human ?? `The program refused this (${known.name}). Nothing moved.` : null;
}

/** A write its test run refused, from the run's logs: the program's sentence when the table names it. */
export function refusalReason(logs: readonly string[]): string {
  return knownRefusal(logs.join('\n')) ?? 'Its test run was refused, so nothing was sent. Nothing moved.';
}

/** Not enough SOL for the rent and the fee, in the words a send, a preflight or a test run uses. */
const SOL_SHORT = /insufficient (lamports|funds)|InsufficientFundsForRent|Attempt to debit an account but found no record/i;
const SOL_SHORT_COPY =
  'Not enough SOL in this wallet to pay the rent and network fee. Nothing moved. Opening a position creates two small accounts, so it costs a little more SOL than a claim does.';

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

  // With no signature yet, the wallet's throw is read as every Solana write reads it
  // (lib/solana/walletThrow.ts): a cancel by code 4001 or by words, or a wallet that
  // never signed, with its reason. Anything else may have been sent: read on.
  const t = signature ? null : readSendThrow(err);
  if (t && t.kind !== 'unsure') return { ok: false, reason: t.message };

  const known = knownRefusal(msg);
  if (known) {
    // A program error means the WHOLE transaction reverted. Whether it reverted in
    // preflight or on chain, no account changed — the only cost is the network fee
    // if it landed.
    return { ok: false, reason: known, ...(signature ? { signature } : {}) };
  }

  // Not enough SOL for rent + fee. A `stake` opens two accounts, so it costs more
  // than a claim does, and saying which action is expensive is the useful half.
  if (SOL_SHORT.test(msg)) return { ok: false, reason: SOL_SHORT_COPY };

  // Should be unreachable: every write here prepends an idempotent ATA create.
  if (/AccountNotInitialized|could not find account/i.test(msg)) {
    return {
      ok: false,
      reason: 'An account this transaction needs does not exist. Nothing moved. If it persists, that is a configuration problem rather than something a retry fixes.',
      ...(signature ? { signature } : {}),
    };
  }

  if (!signature && isPreBroadcast(msg)) {
    return {
      ok: false,
      reason: `The network refused this transaction before sending it. Nothing moved.${msg ? ` (${msg.slice(0, 160)})` : ''}`,
    };
  }

  // The wallet's sign-and-send threw after it may have signed: the words every Solana
  // write uses for that, never "did not go through".
  if (t?.kind === 'unsure' && t.byWallet) return { ok: false, reason: lostAnswerCopy(t.reason, 'it was sent') };

  // ⚠️ EVERYTHING ELSE IS UNKNOWN, and is reported as unknown.
  //
  // Once a signature exists the transaction is on the network; a timeout, a dropped
  // socket and an expired blockhash all fire AFTER broadcast, and it may still land.
  // Without a signature we still cannot prove the negative, so the wording stops
  // short of promising one.
  if (signature) {
    return {
      ok: false,
      reason: 'Outcome unknown: this was sent and may still land. Check your wallet or Solscan with the signature below before retrying.',
      signature,
    };
  }
  return {
    ok: false,
    reason: `This did not go through.${msg ? ` (${msg.slice(0, 160)})` : ''} If your wallet shows a pending transaction, check it before retrying.`,
  };
}

/* ─────────────────── version 1, for a wallet that signs it ─────────────────── */

/** The ladder program is on mainnet only (program.ts `MAINNET_LADDER_PROGRAM_ID`): the chain the wallet signs for. */
const LADDER_CHAIN = 'solana:mainnet' as const;

/** Solana's per-transaction compute ceiling: what the sizing run asks for. */
const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The most priority fee a wallet may put on a ladder write when it hands the message back:
 * 0.001 SOL, the pool writes' cap (write/budget.ts `MAX_OWN_PRIORITY_LAMPORTS`). The ladder
 * itself asks for none, as it never has.
 */
export const MAX_WALLET_PRIORITY_LAMPORTS = 1_000_000n;

/**
 * Units the test run used + 15%, at least 1,000 more, never above the ceiling: the pool
 * writes' rule (write/budget.ts `computeLimitFromSimulation`), kept here so the staking
 * card does not load the whole pool write layer. write.test.ts holds the two equal.
 */
export function ladderComputeLimit(unitsConsumed: number | undefined): number {
  const used = typeof unitsConsumed === 'number' && Number.isFinite(unitsConsumed) && unitsConsumed > 0 ? Math.ceil(unitsConsumed) : MAX_COMPUTE_UNITS;
  return Math.min(Math.max(Math.ceil((used * 115) / 100), used + 1_000), MAX_COMPUTE_UNITS);
}

/** The sizing run's budget: the compute ceiling, legacy's default for loaded data, no priority fee. */
const CEILING = { computeUnitLimit: MAX_COMPUTE_UNITS, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE, priorityFeeLamports: 0n };

/** A wallet's own guards (Phantom's Lighthouse assertions) and ComputeBudget steps, which a version 1 message runs as no-ops. */
const WALLET_ADDITIONS = new Set(['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', 'ComputeBudget111111111111111111111111111111']);

type TestRun = { ok: boolean; err: unknown; logs: string[]; unitsConsumed?: number; loadedAccountsDataSize?: number };

/**
 * A test run of version 1 bytes, signature checks off, the blockhash as given. web3.js 1.98
 * cannot parse a version 1 message, so it gets the same stand-in the pool writes give it
 * (write/prepare.ts `asWire`): off anything with a `message` it reads only `serialize()`.
 */
async function testRun(conn: Connection, bytes: Uint8Array): Promise<TestRun> {
  const wire = { message: null, serialize: () => bytes } as unknown as VersionedTransaction;
  const r = await conn.simulateTransaction(wire, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });
  const v = r?.value as (typeof r.value & { loadedAccountsDataSize?: unknown }) | undefined;
  if (!v || typeof v !== 'object') throw new Error('the test run returned nothing');
  return {
    ok: v.err === null || v.err === undefined,
    err: v.err ?? null,
    logs: Array.isArray(v.logs) ? v.logs : [],
    unitsConsumed: typeof v.unitsConsumed === 'number' ? v.unitsConsumed : undefined,
    loadedAccountsDataSize: typeof v.loadedAccountsDataSize === 'number' ? v.loadedAccountsDataSize : undefined,
  };
}

/** Why a test run refused this, before any wallet was asked: the program's sentence, a SOL shortfall, or the general one. */
function testRunRefusal(run: TestRun): WriteResult {
  if (run.err === 'BlockhashNotFound') {
    return { ok: false, reason: 'The network node was behind, so the test run could not run. Nothing was sent. Try again.' };
  }
  const text = `${run.logs.join('\n')}\n${JSON.stringify(run.err)}`;
  if (!knownRefusal(text) && SOL_SHORT.test(text)) return { ok: false, reason: SOL_SHORT_COPY };
  return { ok: false, reason: refusalReason(run.logs) };
}

/** Our instructions, by program, accounts and data, in order: what a wallet may not change. */
const sameIx = (a: TransactionInstruction, b: TransactionInstruction): boolean =>
  a.programId.equals(b.programId) &&
  Buffer.from(a.data).equals(Buffer.from(b.data)) &&
  a.keys.length === b.keys.length &&
  // Accounts by address only: a version 1 message keeps one role per account, so an
  // account the wallet's guard writes reads back writable in ours too.
  a.keys.every((k, i) => k.pubkey.equals(b.keys[i]!.pubkey));

/**
 * The message the wallet handed back, when it is not the one we gave it. A wallet may add
 * its guards and raise the limits; it may not change the payer, the blockhash, who signs,
 * any of our instructions, or put more than the cap on the priority fee. Null = acceptable.
 */
export function walletChangeRefusal(ours: V1Wire, signed: V1Wire): string | null {
  if (!signed.payer.equals(ours.payer)) return 'Your wallet changed who pays for this transaction, so nothing was sent.';
  // A new blockhash is a new transaction, and not the one the test run cleared.
  if (signed.blockhash !== ours.blockhash) return 'Your wallet changed this transaction in a way this page cannot check, so nothing was sent.';
  const before = new Set(ours.signers.map((k) => k.toBase58()));
  const after = signed.signers.map((k) => k.toBase58());
  if (before.size !== after.length || after.some((k) => !before.has(k))) return 'Your wallet changed who has to sign this transaction, so nothing was sent.';
  if (signed.config.priorityFeeLamports > MAX_WALLET_PRIORITY_LAMPORTS) return 'Your wallet raised the priority fee above what this page allows, so nothing was sent.';
  let j = 0;
  for (const ix of signed.instructions) {
    const want = ours.instructions[j];
    if (want && sameIx(ix, want)) j++;
    else if (!WALLET_ADDITIONS.has(ix.programId.toBase58())) return 'Your wallet added something to this transaction that this page cannot check, so nothing was sent.';
  }
  if (j !== ours.instructions.length) return 'Your wallet removed or changed part of this transaction, so nothing was sent.';
  return null;
}

/**
 * Build, test-run, have the wallet SIGN, check, and send ourselves with preflight on.
 * `refused`: it ended before anything left the browser, provably. `signature`: it was
 * sent, or may have been (a dropped answer), so the caller watches it.
 */
async function submitV1(
  conn: Connection,
  owner: PublicKey,
  signV1: NonNullable<ReturnType<typeof v1SignerOf>>,
  instructions: TransactionInstruction[],
): Promise<{ refused: WriteResult } | { signature: string }> {
  let ours: Uint8Array;
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    // Pass 1: the units and the bytes loaded, at the ceiling.
    const sizing = await testRun(conn, assembleV1(owner, blockhash, lastValidBlockHeight, CEILING, instructions));
    if (!sizing.ok) return { refused: testRunRefusal(sizing) };
    ours = assembleV1(owner, blockhash, lastValidBlockHeight, {
      computeUnitLimit: ladderComputeLimit(sizing.unitsConsumed),
      loadedAccountsDataSizeLimit: loadedDataLimitFromSimulation(sizing.loadedAccountsDataSize),
      priorityFeeLamports: 0n,
    }, instructions);
    if (ours.length > V1_TX_SIZE_LIMIT) return { refused: { ok: false, reason: 'This transaction is too large for Solana. Nothing was sent.' } };
    // Pass 2: the final bytes, the ones the wallet is asked to sign.
    const final = await testRun(conn, ours);
    if (!final.ok) return { refused: testRunRefusal(final) };
  } catch (e) {
    return { refused: { ok: false, reason: `Could not run the test run, so nothing was sent. Nothing moved. (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})` } };
  }

  // The wallet signs; it never sends. A throw here means nothing left the page.
  let returned: Uint8Array;
  try {
    returned = await signV1(ours, LADDER_CHAIN);
  } catch (e) {
    return { refused: { ok: false, reason: signThrowCopy(e) } };
  }
  let signed: V1Wire;
  try {
    signed = decodeV1(returned);
  } catch {
    return { refused: { ok: false, reason: 'Your wallet returned something this page cannot check. Nothing was sent.' } };
  }
  const expected = decodeV1(ours);
  if (!Buffer.from(signed.messageBytes).equals(Buffer.from(expected.messageBytes))) {
    const refusal = walletChangeRefusal(expected, signed);
    if (refusal) return { refused: { ok: false, reason: refusal } };
    // What the wallet changed must still pass its own test run.
    try {
      const again = await testRun(conn, returned);
      if (!again.ok) return { refused: { ok: false, reason: 'After your wallet changed it, this transaction no longer passes its test run. Nothing was sent.' } };
    } catch {
      return { refused: { ok: false, reason: 'Could not test the transaction your wallet returned, so nothing was sent.' } };
    }
  }
  if (!verifyV1Signatures(signed)) return { refused: { ok: false, reason: 'A signature on this transaction does not check out. Nothing was sent.' } };
  const sigBytes = signed.signatures.get(owner.toBase58());
  if (!sigBytes) return { refused: { ok: false, reason: 'The transaction has no signature. Nothing was sent.' } };
  const signature = base58.encode(sigBytes);

  // Our own send, preflight on: a refusal here provably never reached the network.
  try {
    await conn.sendRawTransaction(returned, { skipPreflight: false, preflightCommitment: 'confirmed' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    const logs = (e as { logs?: unknown })?.logs;
    const logText = Array.isArray(logs) ? logs.filter((x): x is string => typeof x === 'string').join('\n') : '';
    if (/already been processed/i.test(msg)) return { signature };
    if (/simulation failed|preflight|Blockhash not found/i.test(msg) || logText) {
      return { refused: classifyWriteError(new Error(`Transaction simulation failed: ${msg}\n${logText}`)) };
    }
    // Anything else (a dropped connection, a timeout) may have come after the node took
    // it: watch the signature, never "did not go through".
  }
  return { signature };
}

/**
 * A landed transaction's logs. web3.js 1.98 refuses a version 1 answer, so one we sent as
 * version 1 is read through kit at the same endpoint (write/submit.ts `readLogs`). Empty
 * when no read could run: the reason then stays general rather than wrong.
 */
async function readLogs(conn: Connection, signature: string, version: 0 | 1): Promise<string[]> {
  try {
    if (version === 0) {
      const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      return [...(t?.meta?.logMessages ?? [])];
    }
    if (typeof conn.rpcEndpoint !== 'string') return [];
    const t = await createSolanaRpc(conn.rpcEndpoint)
      .getTransaction(kitSignature(signature), { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 })
      .send();
    return [...(t?.meta?.logMessages ?? [])];
  } catch {
    return [];
  }
}

/* ─────────────────────────── submit ─────────────────────────── */

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

  // A wallet that signs version 1 bytes gets version 1, signed only and sent by us.
  const signV1 = v1SignerOf(invoker, owner);

  let signature: string | undefined;
  // Until this write is answered the page does not reload itself (lib/staleBuild.ts).
  const release = holdReload();
  try {
    if (signV1) {
      const sent = await submitV1(conn, owner, signV1, instructions);
      if ('refused' in sent) return sent.refused;
      signature = sent.signature;
    } else {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction();
      tx.feePayer = owner;
      tx.recentBlockhash = blockhash;
      tx.add(...instructions);
      signature = await invoker.sendTransaction(tx, conn);
    }
    const { outcome, slot } = await pollConfirm(conn, signature, timeoutMs, sleep, now);
    if (outcome === 'confirmed') return { ok: true, signature, slot };
    if (outcome === 'reverted') {
      // It landed and reverted. ASK THE CHAIN WHY rather than guessing: the status
      // object carries an opaque InstructionError, while the transaction's own logs
      // carry the Anchor code the error table can name.
      const logs = (await readLogs(conn, signature, signV1 ? 1 : 0)).join('\n');
      if (logs && anchorCode(logs) !== null) return classifyWriteError(new Error(logs), signature);
      return {
        ok: false,
        reason: 'This landed on chain and reverted. Nothing moved, apart from the network fee.',
        signature,
      };
    }
    return {
      ok: false,
      reason: 'Sent, but not confirmed within a minute, so it may still land. Check the signature below before retrying.',
      signature,
    };
  } catch (err) {
    return classifyWriteError(err, signature);
  } finally {
    release();
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

type LadderAccounts = Pick<LadderWriteCtx, 'programId' | 'pool' | 'poolAccounts'>;

/**
 * Every write prepends an idempotent ATA create — see `createAtaIdempotentIx`.
 *
 * On `stake` it is redundant by construction (the tokens being staked are already
 * in that account). On every other door it is the difference between a payout and
 * an `AccountNotInitialized` revert, for anyone whose token account was closed
 * while their position was locked.
 */
function withAta(ctx: LadderAccounts, owner: PublicKey, ix: TransactionInstruction): TransactionInstruction[] {
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

const common = (ctx: LadderAccounts, owner: PublicKey) => ({
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

/**
 * A claim's instructions, unsent: what `ladderClaim` and `ladderClaimCarried` send. For
 * Harvest, which signs several claims on one wallet prompt (lib/harvest/solana.ts).
 */
export const ladderClaimIxs = (ctx: LadderAccounts, owner: PublicKey, args: { positionNonce: number }) =>
  withAta(ctx, owner, claimIx({ ...common(ctx, owner), ...args }));
export const ladderClaimCarriedIxs = (ctx: LadderAccounts, owner: PublicKey) =>
  withAta(ctx, owner, claimCarriedIx(common(ctx, owner)));

/** Pay accrued rewards on one position. Reward vault only (invariant I-12). */
export async function ladderClaim(
  ctx: LadderWriteCtx, args: { positionNonce: number },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(ctx.connection, ctx.invoker, ladderClaimIxs(ctx, owner, args), ctx.deps);
}

/**
 * Lengthen a still-locked position's lock, counted from now. No ATA create: it pays
 * nothing out, and moves no tokens at all. Check it with `quoteExtend()` first.
 */
export async function ladderExtendLock(
  ctx: LadderWriteCtx, args: { positionNonce: number; lockSecs: number },
): Promise<WriteResult> {
  const owner = ctx.invoker.publicKey;
  if (!owner) return { ok: false, reason: 'Connect a wallet first.' };
  return submitLadder(
    ctx.connection, ctx.invoker,
    [extendLockIx({ programId: ctx.programId, owner, pool: ctx.pool, ...args })],
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
 * ⚠️ NOT FREE WHILE LOCKED — it charges the same time-left penalty as `early_exit` unless
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
  return submitLadder(ctx.connection, ctx.invoker, ladderClaimCarriedIxs(ctx, owner), ctx.deps);
}
