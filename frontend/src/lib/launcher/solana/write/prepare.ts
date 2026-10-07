// The one path every write takes from "instructions" to "ready to sign".
//
// Six kinds of transaction are built here (create, curve buy, curve sell,
// graduate, pool buy, pool sell) and all of them pass through
// `buildAndSimulate`, so every protection is structural rather than remembered per
// button:
//
//   1. a fresh blockhash and its last valid block height;
//   2. the signer's balances read BEFORE anything runs;
//   3. a first simulation at the maximum compute limit and no priority fee. Any
//      error stops here with the failing program's own reason, and no wallet is
//      asked for anything;
//   4. the final transaction: compute limit from that simulation, a capped
//      priority fee;
//   5. every instruction decoded back out of the final transaction and checked
//      against the shapes this site builds (`intent.ts`);
//   6. a second simulation, of the FINAL bytes, whose effect on the signer's own
//      SOL and token balances must fall inside what the review screen says. If it
//      does not, the action is blocked;
//   7. the summary the review renders is built from the decoded instructions.
//
// Nothing here signs or sends.

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import { clipDetail, type CurveRpc } from '../curve/read';
import {
  LAMPORTS_PER_SIGNATURE,
  MAX_COMPUTE_UNITS,
  choosePriorityPrice,
  computeBudgetIxs,
  computeLimitFromSimulation,
  priorityLamports,
} from './budget';
import { explainFailure } from './errors';
import { decodeIntent } from './intent';
import type {
  Expectation,
  IntentContext,
  IntentStep,
  NotSent,
  Prepared,
  PreparedCheck,
  PreparedTx,
  PreState,
  PreToken,
  SimulatedEffect,
  TxKind,
  TxSummary,
  WatchList,
  WriteRpc,
} from './types';
import { opened } from './wsol';

/** Account reads at 'confirmed', the level the write path confirms at. */
export function confirmedReads(rpc: WriteRpc): CurveRpc {
  return {
    getAccountInfo: (k) => rpc.getAccountInfo(k, 'confirmed'),
    getMinimumBalanceForRentExemption: (n) => rpc.getMinimumBalanceForRentExemption(n),
  };
}

/** Solana's packet limit for a serialized transaction. */
export const TX_SIZE_LIMIT = 1_232;

/** An SPL token account's size, for its rent. */
export const TOKEN_ACCOUNT_SIZE = 165;

export type { PreState };

export interface Rents {
  tokenAccount: bigint;
}

export interface BuildSpec {
  kind: TxKind;
  body: TransactionInstruction[];
  extraSigners: Keypair[];
  intent: IntentContext;
  watch: WatchList;
  expect: (pre: PreState, rents: Rents) => Expectation;
  newAccountRent: (pre: PreState, rents: Rents) => bigint;
  /** Migrate: never ask for fewer units than this, whatever the simulation used. */
  computeFloor?: number;
  /** Build the review summary from the decoded steps, or return why they disagree with the intent. */
  summarize: (steps: IntentStep[]) => TxSummary | string;
}

const notSent = (stage: NotSent['stage'], message: string, logs?: string[]): { ok: false; outcome: NotSent } => ({
  ok: false,
  outcome: { status: 'not-sent', stage, message, ...(logs && logs.length ? { logs } : {}) },
});

/** Not sent because a read or a check could not run: no verdict on the transaction. */
const notRead = (stage: NotSent['stage'], message: string): { ok: false; outcome: NotSent } => ({
  ok: false,
  outcome: { status: 'not-sent', stage, message, retry: true },
});

function tokenAmount(data: Uint8Array | null | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/** A native (wrapped-SOL) account's stored rent reserve: `is_native`, bytes 109-120. Null when it is not native. */
export function nativeReserve(data: Uint8Array | null | undefined): bigint | null {
  if (!data || data.length < 121) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return v.getUint32(109, true) === 1 ? v.getBigUint64(113, true) : null;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readPreState(rpc: WriteRpc, watch: WatchList): Promise<PreState> {
  const keys = [watch.signer, ...watch.tokenAccounts.map((t) => t.account)];
  const infos = await rpc.getMultipleAccountsInfo(keys, 'confirmed');
  if (!Array.isArray(infos) || infos.length !== keys.length) {
    throw new Error('the balance read returned the wrong number of accounts');
  }
  const tokens = new Map<string, PreToken>();
  watch.tokenAccounts.forEach((t, i) => {
    // An address that only holds SOL someone sent it is no token account yet (`opened`):
    // it has no balance, and `lamports` says what already sits there.
    const info = opened(infos[i + 1]);
    if (!info) {
      tokens.set(t.account.toBase58(), { exists: false, amount: 0n, lamports: BigInt(infos[i + 1]?.lamports ?? 0), nativeReserve: null });
      return;
    }
    const amt = tokenAmount(info.data);
    if (amt === null) throw new Error(`${t.account.toBase58()} is not a token account`);
    tokens.set(t.account.toBase58(), { exists: true, amount: amt, lamports: BigInt(info.lamports), nativeReserve: nativeReserve(info.data) });
  });
  return { signerLamports: BigInt(infos[0]?.lamports ?? 0), tokens };
}

interface SimOutcome {
  ok: boolean;
  err: unknown;
  logs: string[];
  unitsConsumed: number | undefined;
  accounts: Array<{ lamports: number; data: string[] } | null> | null;
}

/** Simulate with signature checks off and the blockhash as given. Returns post-state for `watch`. */
export async function simulate(rpc: WriteRpc, tx: Transaction, watch: WatchList | null): Promise<SimOutcome> {
  const vtx = new VersionedTransaction(tx.compileMessage());
  const addresses = watch ? [watch.signer, ...watch.tokenAccounts.map((t) => t.account)].map((k) => k.toBase58()) : [];
  const r = await rpc.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    ...(watch ? { accounts: { encoding: 'base64' as const, addresses } } : {}),
  });
  const v = r?.value;
  if (!v || typeof v !== 'object') throw new Error('the simulation returned nothing');
  const logs = Array.isArray(v.logs) ? v.logs : [];
  return {
    ok: v.err === null || v.err === undefined,
    err: v.err ?? null,
    logs,
    unitsConsumed: typeof v.unitsConsumed === 'number' ? v.unitsConsumed : undefined,
    accounts: Array.isArray(v.accounts) ? (v.accounts as SimOutcome['accounts']) : null,
  };
}

/** The signer's balance changes, from pre-state and simulated post-state. */
export function simulatedEffect(watch: WatchList, pre: PreState, post: SimOutcome['accounts']): SimulatedEffect | string {
  if (!post || post.length !== 1 + watch.tokenAccounts.length) {
    return 'the simulation did not report the balances it was asked for';
  }
  const signerPost = post[0];
  const signerLamportsDelta = BigInt(signerPost?.lamports ?? 0) - pre.signerLamports;
  const tokenDeltas: SimulatedEffect['tokenDeltas'] = [];
  for (let i = 0; i < watch.tokenAccounts.length; i++) {
    const t = watch.tokenAccounts[i]!;
    const p = post[i + 1];
    let after = 0n;
    if (p && p.lamports > 0) {
      const raw = Array.isArray(p.data) ? p.data[0] : undefined;
      if (typeof raw !== 'string') return 'the simulation returned a token account with no data';
      const amt = tokenAmount(b64ToBytes(raw));
      if (amt === null) return 'the simulation returned a token account that does not decode';
      after = amt;
    }
    const before = pre.tokens.get(t.account.toBase58())?.amount ?? 0n;
    tokenDeltas.push({
      mint: t.mint,
      account: t.account,
      delta: after - before,
      ...(t.role ? { role: t.role } : {}),
      ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
    });
  }
  return { signerLamportsDelta, tokenDeltas };
}

/** Does the simulated effect fall inside the expectation? `null` = yes, else the reason. */
export function checkEffect(effect: SimulatedEffect, expect: Expectation, networkFees: bigint): string | null {
  const loss = -effect.signerLamportsDelta;
  if (loss > expect.maxSolOut + networkFees) {
    return 'the simulation shows more SOL leaving your wallet than this screen says';
  }
  if (expect.minSolIn !== undefined && effect.signerLamportsDelta + networkFees < expect.minSolIn) {
    return 'the simulation shows less SOL arriving than this screen says';
  }
  for (const t of expect.tokens) {
    const got = effect.tokenDeltas.find((d) => d.account.equals(t.account));
    // An account the simulation was never asked about has no known change. Counting
    // it as 0 would pass any band that holds 0, so it is refused instead.
    if (!got) return 'the check was asked about an account it did not watch';
    const delta = got.delta;
    if (delta < t.minDelta || delta > t.maxDelta) {
      return 'the simulation shows a different token amount than this screen says';
    }
  }
  return null;
}

/** Base fee: 5,000 lamports for each required signature. */
export function baseFeeLamports(tx: Transaction): bigint {
  const signers = new Set<string>();
  if (tx.feePayer) signers.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isSigner) signers.add(k.pubkey.toBase58());
  return BigInt(signers.size) * LAMPORTS_PER_SIGNATURE;
}

function writableKeys(ixs: TransactionInstruction[]): PublicKey[] {
  const seen = new Map<string, PublicKey>();
  for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) seen.set(k.pubkey.toBase58(), k.pubkey);
  return [...seen.values()];
}

export function serializeBody(body: TransactionInstruction[]): PreparedCheck['body'] {
  return body.map((ix) => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable] as [string, boolean, boolean]),
    data: Array.from(ix.data, (b) => b.toString(16).padStart(2, '0')).join(''),
  }));
}

function assemble(signer: PublicKey, blockhash: string, lastValidBlockHeight: number, limit: number, price: bigint, body: TransactionInstruction[]): Transaction {
  const tx = new Transaction({ feePayer: signer, blockhash, lastValidBlockHeight });
  tx.add(...computeBudgetIxs(limit, price), ...body);
  return tx;
}

export async function buildAndSimulate(rpc: WriteRpc, spec: BuildSpec): Promise<Prepared> {
  const signer = spec.intent.signer;
  if (!spec.watch.signer.equals(signer)) return notSent('build', 'Internal check failed: the watched wallet is not the signer.');

  let blockhash: string;
  let lastValidBlockHeight: number;
  let pre: PreState;
  let rents: Rents;
  try {
    const [bh, preState, tokenRent] = await Promise.all([
      rpc.getLatestBlockhash('confirmed'),
      readPreState(rpc, spec.watch),
      rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
    ]);
    blockhash = bh.blockhash;
    lastValidBlockHeight = bh.lastValidBlockHeight;
    pre = preState;
    rents = { tokenAccount: BigInt(tokenRent) };
  } catch (e) {
    return notRead('build', `Could not read the network to prepare this: ${clipDetail(e)}`);
  }

  // Pass 1: find the units, at the ceiling and no priority fee.
  let first: SimOutcome;
  try {
    first = await simulate(rpc, assemble(signer, blockhash, lastValidBlockHeight, MAX_COMPUTE_UNITS, 0n, spec.body), null);
  } catch (e) {
    return notRead('simulate', `Could not run the safety check: ${clipDetail(e)}`);
  }
  if (!first.ok) {
    const why = explainFailure(first.err, first.logs, spec.intent.cfg, spec.kind);
    return notSent('simulate', why.message, first.logs);
  }

  const limit = computeLimitFromSimulation(first.unitsConsumed, spec.computeFloor ?? 0);
  const priority = await choosePriorityPrice(rpc, writableKeys(spec.body), limit, spec.intent.maxPriorityLamports);
  const tx = assemble(signer, blockhash, lastValidBlockHeight, limit, priority.microLamports, spec.body);

  const decoded = decodeIntent(tx.instructions, spec.intent);
  if (!decoded.ok) return notSent('build', decoded.reason);

  let sizeBytes: number;
  try {
    sizeBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch (e) {
    return notSent('build', `This transaction could not be put together: ${clipDetail(e)}`);
  }
  if (sizeBytes > TX_SIZE_LIMIT) {
    return notSent('build', `This transaction is too large for Solana (${sizeBytes} of ${TX_SIZE_LIMIT} bytes). Try a shorter name or link.`);
  }

  // Pass 2: the FINAL bytes, with the balance read-back.
  let second: SimOutcome;
  try {
    second = await simulate(rpc, tx, spec.watch);
  } catch (e) {
    return notRead('simulate', `Could not run the safety check: ${clipDetail(e)}`);
  }
  if (!second.ok) {
    const why = explainFailure(second.err, second.logs, spec.intent.cfg, spec.kind);
    return notSent('simulate', why.message, second.logs);
  }

  const effect = simulatedEffect(spec.watch, pre, second.accounts);
  if (typeof effect === 'string') return notSent('simulate', `The safety check could not confirm this: ${effect}.`);

  const baseLamports = baseFeeLamports(tx);
  const priorityFee = priorityLamports(priority.microLamports, limit);
  const expect = spec.expect(pre, rents);
  const mismatch = checkEffect(effect, expect, baseLamports + priorityFee);
  if (mismatch) return notSent('simulate', `Blocked: ${mismatch}.`, second.logs);

  const summary = spec.summarize(decoded.steps);
  if (typeof summary === 'string') return notSent('build', summary);

  const prepared: PreparedTx = {
    kind: spec.kind,
    tx,
    extraSigners: spec.extraSigners,
    blockhash,
    lastValidBlockHeight,
    sizeBytes,
    simulation: { unitsConsumed: second.unitsConsumed ?? limit, logs: second.logs },
    fees: {
      baseLamports,
      priorityLamports: priorityFee,
      priorityFeeRead: priority.read,
      newAccountRentLamports: spec.newAccountRent(pre, rents),
    },
    steps: decoded.steps,
    simulated: effect,
    summary,
    check: { intent: spec.intent, expect, body: serializeBody(spec.body), watch: spec.watch, pre },
  };
  return { ok: true, prepared };
}

/** Steps without the two compute-budget ones, which every transaction carries. */
export function bodySteps(steps: IntentStep[]): IntentStep[] {
  return steps.filter((s) => s.kind !== 'compute-limit' && s.kind !== 'compute-price');
}

export { notSent, notRead };
