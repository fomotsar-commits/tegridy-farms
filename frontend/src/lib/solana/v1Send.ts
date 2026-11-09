// A version 1 transaction (SIMD-0385) the site built itself, for a wallet that signs one:
// the steps between "these instructions" and "these signed bytes may be sent", shared by
// the BAYLA staking card (lib/ladder/write.ts) and Claim all (lib/harvest/solana.ts).
//
// Phantom's answer on ticket #455104 (2026-11-05), and its recipe "Send a Solana v1
// transaction": the compute and loaded-account-data limits in the message's config, a
// test run first with signature checks off, the wallet asked only to SIGN, and our own
// send with preflight on. The pool writes do the same through their own layer
// (launcher/solana/write/prepare.ts and submit.ts); this is the small version for writes
// with no review screen, and it builds with the same builder (launcher/solana/write/v1.ts).
import type { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@scure/base';
import {
  MAX_LOADED_ACCOUNTS_DATA_SIZE, V1_TX_SIZE_LIMIT, assembleV1, decodeV1, loadedDataLimitFromSimulation, verifyV1Signatures,
  type V1Wire,
} from '../launcher/solana/write/v1';

/** Solana's per-transaction compute ceiling: what the sizing run asks for. */
const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The most priority fee a wallet may put on one of these when it hands the message back:
 * 0.001 SOL, the pool writes' cap (write/budget.ts `MAX_OWN_PRIORITY_LAMPORTS`). These
 * writes ask for none themselves.
 */
export const MAX_WALLET_PRIORITY_LAMPORTS = 1_000_000n;

/**
 * Units the test run used + 15%, at least 1,000 more, never above the ceiling: the pool
 * writes' rule (write/budget.ts `computeLimitFromSimulation`), kept here so a staking card
 * does not load the whole pool write layer. lib/ladder/write.test.ts holds the two equal.
 */
export function v1ComputeLimit(unitsConsumed: number | undefined): number {
  const used = typeof unitsConsumed === 'number' && Number.isFinite(unitsConsumed) && unitsConsumed > 0 ? Math.ceil(unitsConsumed) : MAX_COMPUTE_UNITS;
  return Math.min(Math.max(Math.ceil((used * 115) / 100), used + 1_000), MAX_COMPUTE_UNITS);
}

/** The sizing run's budget: the compute ceiling, legacy's default for loaded data, no priority fee. */
const CEILING = { computeUnitLimit: MAX_COMPUTE_UNITS, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE, priorityFeeLamports: 0n };

/** A wallet's own guards (Phantom's Lighthouse assertions) and ComputeBudget steps, which a version 1 message runs as no-ops. */
const WALLET_ADDITIONS = new Set(['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', 'ComputeBudget111111111111111111111111111111']);

type SimConn = Pick<Connection, 'simulateTransaction'>;

export type TestRun = { ok: boolean; err: unknown; logs: string[]; unitsConsumed?: number; loadedAccountsDataSize?: number };

/**
 * A test run of version 1 bytes, signature checks off, the blockhash as given. web3.js 1.98
 * cannot parse a version 1 message, so it gets the same stand-in the pool writes give it
 * (write/prepare.ts `asWire`): off anything with a `message` it reads only `serialize()`.
 * Throws when the node did not answer: that is no verdict.
 */
async function testRun(conn: SimConn, bytes: Uint8Array): Promise<TestRun> {
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

/**
 * The unsigned bytes to put to the wallet, or why not. Pass 1 measures the units and the
 * bytes loaded at the ceiling; pass 2 test-runs the final bytes. `refusedRun`: a test run
 * refused it, so no wallet is asked; the caller says why in its own words. A run the node
 * did not answer is no verdict: the bytes go at what is known (the ceiling, untested), and
 * the first send's preflight is the network's own check, as it was before these writes
 * had test runs of their own.
 */
export async function prepareV1(
  conn: SimConn,
  owner: PublicKey,
  instructions: readonly TransactionInstruction[],
  lifetime: { blockhash: string; lastValidBlockHeight: number },
): Promise<{ bytes: Uint8Array; tested: boolean } | { refusedRun: TestRun } | { tooLarge: true }> {
  const build = (config: typeof CEILING) => assembleV1(owner, lifetime.blockhash, lifetime.lastValidBlockHeight, config, instructions);
  const fits = (bytes: Uint8Array, tested: boolean) => (bytes.length > V1_TX_SIZE_LIMIT ? { tooLarge: true as const } : { bytes, tested });
  const sizingBytes = build(CEILING);
  let sizing: TestRun;
  try {
    sizing = await testRun(conn, sizingBytes);
  } catch {
    return fits(sizingBytes, false);
  }
  if (!sizing.ok) return { refusedRun: sizing };
  const bytes = build({
    computeUnitLimit: v1ComputeLimit(sizing.unitsConsumed),
    loadedAccountsDataSizeLimit: loadedDataLimitFromSimulation(sizing.loadedAccountsDataSize),
    priorityFeeLamports: 0n,
  });
  if (bytes.length > V1_TX_SIZE_LIMIT) return { tooLarge: true };
  try {
    const final = await testRun(conn, bytes);
    if (!final.ok) return { refusedRun: final };
  } catch {
    return { bytes, tested: false };
  }
  return { bytes, tested: true };
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
 * What the wallet signed, held to the rules: the bytes to send and their signature, or
 * why nothing may be sent. A changed message must pass `walletChangeRefusal` and its own
 * test run; every signature must check out.
 */
export async function acceptSignedV1(
  conn: SimConn,
  ours: Uint8Array,
  returned: Uint8Array,
  owner: PublicKey,
): Promise<{ signature: string; raw: Uint8Array } | { refusal: string }> {
  let signed: V1Wire;
  try {
    signed = decodeV1(returned);
  } catch {
    return { refusal: 'Your wallet returned something this page cannot check. Nothing was sent.' };
  }
  const expected = decodeV1(ours);
  if (!Buffer.from(signed.messageBytes).equals(Buffer.from(expected.messageBytes))) {
    const refusal = walletChangeRefusal(expected, signed);
    if (refusal) return { refusal };
    // What the wallet changed must still pass its own test run.
    try {
      const again = await testRun(conn, returned);
      if (!again.ok) return { refusal: 'After your wallet changed it, this transaction no longer passes its test run. Nothing was sent.' };
    } catch {
      return { refusal: 'Could not test the transaction your wallet returned, so nothing was sent.' };
    }
  }
  if (!verifyV1Signatures(signed)) return { refusal: 'A signature on this transaction does not check out. Nothing was sent.' };
  const sigBytes = signed.signatures.get(owner.toBase58());
  if (!sigBytes) return { refusal: 'The transaction has no signature. Nothing was sent.' };
  return { signature: base58.encode(sigBytes), raw: returned };
}
