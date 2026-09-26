// Sign, send, and find out, without ever telling someone a transaction failed
// when we only failed to hear back.
//
// The four endings, and the evidence each one needs:
//
//   confirmed  the network reports it confirmed.
//   reverted   the network reports it landed with an error AT 'confirmed' or
//              'finalized'. We read its logs to say which program refused and why.
//              Only the network fee was spent. An error seen only at 'processed'
//              is in a block that can still be dropped, and the same signed bytes
//              can then land and succeed, so it is NOT an ending: we keep watching.
//   expired    the FINALIZED block height has passed the transaction's last valid
//              height and the network has NO record of the signature (history
//              searched, twice). A transaction past that height can never land,
//              and every block it could have landed in is final, so trying again
//              is safe, and we say so.
//   unknown    anything short of those proofs, e.g. we could not read the block
//              height, or the watch hit its hard time limit. Said as "sent, not
//              confirmed yet", with the signature, NEVER as "failed": someone told
//              "failed" presses the button again and pays twice.
//
// HOW IT IS SENT: the wallet only SIGNS (`signTransaction`). We broadcast through
// our own RPC proxy, because a wallet's own send goes through the wallet's RPC and
// chain choice. The signature is taken from the signed bytes BEFORE broadcast, so
// every ending after signing carries it. The same signed bytes are re-sent every
// couple of seconds until one of the endings above is proven. Same bytes, same
// signature, so a re-send can never make it run twice.
//
// IF THE WALLET CHANGES THE TRANSACTION: we re-check what came back with the same
// rules as before signing. A wallet may append its own assertion-only guard
// instructions; anything else that differs (a different fee payer, blockhash,
// signer set, or any of our instructions) is refused and nothing is sent. A changed
// message is also simulated again and its balance effect re-checked.

import { base58 } from '@scure/base';
import { Transaction } from '@solana/web3.js';
import { clipDetail } from '../curve/read';
import { explainFailure } from './errors';
import { computeUnitLimit, decodeIntent } from './intent';
import { baseFeeLamports, checkEffect, serializeBody, simulate, simulatedEffect } from './prepare';
import { priorityLamports } from './budget';
import type { NotSent, PreparedTx, SubmitDeps, TxOutcome, TxSigner, WriteRpc } from './types';

const notSent = (stage: NotSent['stage'], message: string, logs?: string[]): NotSent => ({
  status: 'not-sent',
  stage,
  message,
  ...(logs && logs.length ? { logs } : {}),
});

const UNKNOWN_COPY =
  'Sent, not confirmed yet. It may still go through. Do not try again until you have checked it.';
const EXPIRED_COPY = 'This did not go through, and it can no longer go through. Nothing was charged. It is safe to try again.';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isDecline(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '');
  return /reject|declin|denied|cancel|WalletSignTransactionError|User rejected/i.test(msg);
}

/**
 * Check a transaction the wallet handed back that is not byte-identical to the one
 * we gave it. Returns a reason to refuse, or null.
 */
async function checkWalletChanges(rpc: WriteRpc, p: PreparedTx, signed: Transaction): Promise<string | null> {
  const ours = p.tx;
  if (!signed.feePayer || !ours.feePayer || !signed.feePayer.equals(ours.feePayer)) {
    return 'Your wallet changed who pays for this transaction, so nothing was sent.';
  }
  if (signed.recentBlockhash !== ours.recentBlockhash) {
    return 'Your wallet changed this transaction in a way this page cannot check, so nothing was sent.';
  }
  const decoded = decodeIntent(signed.instructions, p.check.intent, { allowWalletGuards: true });
  if (!decoded.ok) return `Your wallet changed this transaction. ${decoded.reason} Nothing was sent.`;

  // Every one of our instructions must still be there, unchanged and in order.
  const want = p.check.body;
  const got = serializeBody(signed.instructions);
  let j = 0;
  for (const g of got) {
    const w = want[j];
    if (!w) break;
    if (
      g.programId === w.programId &&
      g.data === w.data &&
      g.keys.length === w.keys.length &&
      g.keys.every((k, i) => k[0] === w.keys[i]![0])
    ) {
      j++;
    }
  }
  if (j !== want.length) return 'Your wallet removed or changed part of this transaction, so nothing was sent.';

  // The signer set must not grow: no one else may be asked to sign for this.
  const signersOf = (tx: Transaction) =>
    new Set(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58()));
  const before = signersOf(ours);
  const after = signersOf(signed);
  if (before.size !== after.size || [...after].some((k) => !before.has(k))) {
    return 'Your wallet changed who has to sign this transaction, so nothing was sent.';
  }

  // Simulate what the wallet returned and hold it to the same balance limits.
  try {
    const sim = await simulate(rpc, signed, p.check.watch);
    if (!sim.ok) {
      return `After your wallet changed it, this transaction no longer works: ${explainFailure(sim.err, sim.logs, p.check.intent.cfg).message} Nothing was sent.`;
    }
    const effect = simulatedEffect(p.check.watch, p.check.pre, sim.accounts);
    if (typeof effect === 'string') return `The safety check could not confirm your wallet’s version: ${effect}. Nothing was sent.`;
    const price = decoded.steps.find((s) => s.kind === 'compute-price');
    const fees =
      baseFeeLamports(signed) +
      priorityLamports(
        price && price.kind === 'compute-price' ? price.microLamports : 0n,
        computeUnitLimit(signed.instructions, decoded.steps),
      );
    const mismatch = checkEffect(effect, p.check.expect, fees);
    if (mismatch) return `Blocked after your wallet changed it: ${mismatch}. Nothing was sent.`;
  } catch (e) {
    return `Could not re-check the transaction your wallet returned (${clipDetail(e)}), so nothing was sent.`;
  }
  return null;
}

/** Read the reason out of a landed-and-reverted transaction's logs. */
async function revertedOutcome(rpc: WriteRpc, p: PreparedTx, signature: string, err: unknown): Promise<TxOutcome> {
  let logs: string[] = [];
  try {
    const t = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    logs = t?.meta?.logMessages ?? [];
  } catch {
    /* the reason stays general rather than becoming wrong */
  }
  const why = explainFailure(err, logs, p.check.intent.cfg);
  return {
    status: 'reverted',
    signature,
    program: why.program,
    code: why.code,
    message: `${why.message} It reached the network and was refused, so only the network fee was spent.`,
  };
}

type Status = { err: unknown; confirmationStatus?: string | null; slot?: number } | null;

/** A status the network will not take back: in a confirmed or finalized block. */
function settled(st: NonNullable<Status>): boolean {
  return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
}

/** The FINALIZED block height, or null. Past it, every block the transaction could land in is final. */
async function finalizedHeight(rpc: WriteRpc): Promise<number | null> {
  try {
    const h = await rpc.getBlockHeight('finalized');
    return typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Past the last valid height: is there really no record? Two history reads, both
 * empty, before "nothing happened". A single read through a proxy can reach a
 * server that is behind the one that saw the block.
 */
async function recordAfterExpiry(rpc: WriteRpc, signature: string): Promise<Status | 'unread'> {
  const first = await readStatus(rpc, signature, true);
  if (first !== null) return first;
  return readStatus(rpc, signature, true);
}

async function readStatus(rpc: WriteRpc, signature: string, history: boolean): Promise<Status | 'unread'> {
  try {
    const r = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: history });
    const v = r?.value;
    if (!Array.isArray(v)) return 'unread';
    return (v[0] as Status) ?? null;
  } catch {
    return 'unread';
  }
}

/**
 * Sign with the wallet, add the extra signers, check, broadcast, and watch.
 * Never throws.
 */
export async function submitPrepared(
  rpc: WriteRpc,
  signer: TxSigner,
  p: PreparedTx,
  deps: SubmitDeps = {},
): Promise<TxOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const intervalMs = deps.intervalMs ?? 2_000;

  if (!signer.publicKey || !p.tx.feePayer || !signer.publicKey.equals(p.tx.feePayer)) {
    return notSent('sign', 'The connected wallet is not the one this transaction was prepared for. Prepare it again.');
  }

  const expected = p.tx.serializeMessage();

  // 1. The wallet signs. It never broadcasts.
  let signed: Transaction;
  try {
    signed = await signer.signTransaction(p.tx);
  } catch (e) {
    return notSent(
      'sign',
      isDecline(e)
        ? 'You cancelled in your wallet. Nothing was sent.'
        : `Your wallet did not sign this (${clipDetail(e)}). Nothing was sent.`,
    );
  }
  if (!(signed instanceof Transaction)) {
    // A wallet library bundling its own copy of web3.js returns a lookalike class.
    // Re-read it from its bytes so every check below runs on a real Transaction.
    try {
      const bytes = (signed as unknown as { serialize(c: object): Uint8Array }).serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      signed = Transaction.from(bytes);
    } catch {
      return notSent('sign', 'Your wallet returned something this page cannot check. Nothing was sent.');
    }
  }

  // 2. Anything the wallet changed is held to the same rules.
  if (!sameBytes(signed.serializeMessage(), expected)) {
    const refusal = await checkWalletChanges(rpc, p, signed);
    if (refusal) return notSent('sign', refusal);
  }

  // 3. Our extra signers sign AFTER the wallet (Phantom's rule for multi-signer transactions).
  try {
    if (p.extraSigners.length) signed.partialSign(...p.extraSigners);
  } catch (e) {
    return notSent('sign', `The transaction could not be completed (${clipDetail(e)}). Nothing was sent.`);
  }
  if (!signed.verifySignatures()) {
    return notSent('sign', 'A signature on this transaction does not check out. Nothing was sent.');
  }

  // 4. The signature is known before anything leaves the browser.
  const sigBytes = signed.signature;
  if (!sigBytes) return notSent('sign', 'The transaction has no signature. Nothing was sent.');
  const signature = base58.encode(sigBytes);
  let raw: Buffer;
  try {
    raw = signed.serialize();
  } catch (e) {
    return notSent('sign', `The signed transaction could not be put together (${clipDetail(e)}). Nothing was sent.`);
  }

  // 5. First send WITH preflight: a rejection here provably never reached the network.
  try {
    await rpc.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  } catch (e) {
    const logs = extractLogs(e);
    const msg = e instanceof Error ? e.message : String(e ?? '');
    if (/simulation failed|preflight|Blockhash not found|already been processed/i.test(msg) || logs) {
      if (/already been processed/i.test(msg)) {
        // It is already on chain: fall through to the watch.
      } else {
        const why = explainFailure(null, logs ?? [], p.check.intent.cfg);
        return notSent('send', `The network refused this before sending it: ${why.message} Nothing was sent.`, logs ?? undefined);
      }
    }
    // Any other error (a dropped connection, a timeout) may have happened after the
    // RPC forwarded it. Fall through and watch; never report it as not sent.
  }

  // 6. Watch, re-sending the same bytes, until a proven ending.
  const start = now();
  for (;;) {
    const st = await readStatus(rpc, signature, false);
    if (st !== 'unread' && st && settled(st)) {
      if (st.err) return revertedOutcome(rpc, p, signature, st.err);
      return { status: 'confirmed', signature, slot: typeof st.slot === 'number' ? st.slot : null };
    }
    // Seen only at 'processed' (with or without an error): not an ending yet.

    const height = await finalizedHeight(rpc);
    if (height !== null && height > p.lastValidBlockHeight) {
      // Past its last valid height, by the FINALIZED chain: it can never land, and
      // any block it did land in is final. Did it land before that?
      const final = await recordAfterExpiry(rpc, signature);
      if (final === 'unread') return { status: 'unknown', signature, message: UNKNOWN_COPY };
      if (final === null) return { status: 'expired', signature, message: EXPIRED_COPY };
      if (!settled(final)) return { status: 'unknown', signature, message: UNKNOWN_COPY };
      if (final.err) return revertedOutcome(rpc, p, signature, final.err);
      return { status: 'confirmed', signature, slot: typeof final.slot === 'number' ? final.slot : null };
    }

    if (now() - start >= timeoutMs) return { status: 'unknown', signature, message: UNKNOWN_COPY };

    try {
      await rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    } catch {
      /* a failed re-send is not a failed transaction */
    }
    await sleep(intervalMs);
  }
}

function extractLogs(e: unknown): string[] | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { logs?: unknown; transactionLogs?: unknown };
  const l = Array.isArray(o.logs) ? o.logs : Array.isArray(o.transactionLogs) ? o.transactionLogs : null;
  return l ? l.filter((x): x is string => typeof x === 'string') : null;
}

/**
 * Look again. Searches history, so an old signature is still found.
 *
 * With `lastValidBlockHeight`, a signature the network has no record of AND whose
 * height has passed is `expired` (safe to retry). Without it, or when the height
 * cannot be read, no record is `unknown`, never "failed".
 */
export async function recheckOutcome(
  rpc: WriteRpc,
  signature: string,
  opts: { lastValidBlockHeight?: number; cfg?: PreparedTx['check']['intent']['cfg'] } = {},
): Promise<TxOutcome> {
  const st = await readStatus(rpc, signature, true);
  if (st === 'unread') return { status: 'unknown', signature, message: 'Could not check right now. Try again in a moment.' };
  if (st) {
    if (!settled(st)) {
      // Only 'processed': a failure there can still be undone, and so can a success.
      return { status: 'unknown', signature, message: 'The network has seen it but has not confirmed it yet.' };
    }
    if (st.err) {
      let logs: string[] = [];
      try {
        const t = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        logs = t?.meta?.logMessages ?? [];
      } catch {
        /* keep it general */
      }
      const why = opts.cfg
        ? explainFailure(st.err, logs, opts.cfg)
        : { program: 'other' as const, code: null, message: 'A program refused this transaction.' };
      return {
        status: 'reverted',
        signature,
        program: why.program,
        code: why.code,
        message: `${why.message} It reached the network and was refused, so only the network fee was spent.`,
      };
    }
    return { status: 'confirmed', signature, slot: typeof st.slot === 'number' ? st.slot : null };
  }
  if (opts.lastValidBlockHeight !== undefined) {
    const h = await finalizedHeight(rpc);
    if (h !== null && h > opts.lastValidBlockHeight) {
      // Same proof as the watch: finalized past the window AND a second empty read.
      const again = await readStatus(rpc, signature, true);
      if (again === null) return { status: 'expired', signature, message: EXPIRED_COPY };
      if (again !== 'unread' && settled(again)) return recheckOutcome(rpc, signature, { cfg: opts.cfg });
    }
  }
  return { status: 'unknown', signature, message: 'The network has no record of it yet. It may still be landing.' };
}
