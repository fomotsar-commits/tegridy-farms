// The loop that runs a VWAP order (vwapOrder.ts) in the one tab holding its lock
// (components/solana/vwap/useVwapRunner.ts). Every read, the wallet and the clock come in
// through `RunEnv`, so what is written when, and what is never sent, is pinned by tests.
//
// THE RECORD FIRST. A slice is written "sending" (with what it is to pay) before anything is
// asked; its signature and its quote are written the moment the signature exists, before the
// first send. A page that closes mid-slice comes back knowing whether anything left. Every
// change is read-modify-write on the stored order, so a Stop pressed meanwhile, here or in
// another tab, is never undone.
//
// THE LAST WORD IS THE PERSON'S. A signature that comes back after Stop, after the order
// changed, or more than LATE_SIGN_MS after the wallet was asked (its price is stale) is not
// sent: the page only sends what the wallet signed, and here it sends nothing.

import type { VersionedTransaction } from '@solana/web3.js';
import { LATE_SIGN_MS, RETRY_MS, advance, nextAction, withSlice, type VwapOrder } from './vwapOrder';
import { settleSlice, trySlice, type SettleDeps, type SliceDeps } from './vwapSlice';
import type { WalletSwapEnd } from './walletSwapSend';

/** The longest the loop sleeps between looks: a Stop or a reopened page is picked up within this. */
export const LOOK_MS = 20_000;
/** A slice out is read again this often until the chain answers for it. */
export const SETTLE_MS = 15_000;

export const LATE_COPY = 'You approved it more than 45 seconds after it was asked, so its price was stale. Nothing was sent. It is asked again with a fresh price.';
export const WITHDRAWN_COPY = 'The order was stopped while your wallet was open. Nothing was sent.';
export const DECLINED_COPY = 'You said no in your wallet. This slice is skipped; its amount goes with the next one.';
export const UNCONFIRMED_COPY = 'Sent, not confirmed yet. Nothing else is sent until the chain answers for it.';
const REFUSED_COPY = 'The network refused this slice. Only the network fee was spent.';
export const NOT_KEPT_COPY ='This browser would not keep the order’s record, so nothing was sent.';

export interface RunEnv {
  /** The wallet's order as stored now. */
  read(): VwapOrder | null;
  /** Stores it. False: the browser would not keep it. */
  save(o: VwapOrder): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  aborted(): boolean;
  /** The wallet's own signature, nothing sent. */
  walletSign(tx: VersionedTransaction): Promise<VersionedTransaction>;
  /** What the wallet handed back: its first signature and the blockhash it carries (a wallet may swap in its own), read from its bytes. */
  signed(tx: VersionedTransaction): { signature: string | null; blockhash: string | null };
  /** Everything a slice reads, and the send: `sign` is the guarded signer, `onSent` runs once a signature exists. */
  slice: Omit<SliceDeps, 'send'> & {
    send(b64: string, words: string, sign: (tx: VersionedTransaction) => Promise<VersionedTransaction>, onSent: (signature: string) => void): Promise<WalletSwapEnd>;
  };
  settle: SettleDeps;
  /** What the wallet received in a landed transaction, read from the chain; null when it cannot say. */
  received(signature: string, o: VwapOrder): Promise<bigint | null>;
  /** The page's receipt and activity line for a landed slice. */
  onLanded(signature: string, o: VwapOrder, paid: bigint): void;
  /** Holds the page's own reload while a slice is out; returns its release. */
  holdReload(): () => void;
}

/** Read-modify-write on the stored order: nothing happens if it is gone or another order. */
function update(env: RunEnv, id: string, fn: (o: VwapOrder) => VwapOrder): VwapOrder | null {
  const o = env.read();
  if (!o || o.id !== id) return null;
  const next = fn(o);
  return env.save(next) ? next : null;
}

async function fill(env: RunEnv, o: VwapOrder, k: number, signature: string, paid: bigint, quoted: bigint): Promise<void> {
  const got = await env.received(signature, o).catch(() => null);
  const exact = got !== null && got > 0n;
  update(env, o.id, (x) =>
    withSlice(x, k, { state: 'filled', sig: signature, paid: paid.toString(), got: (exact ? got : quoted).toString(), gotExact: exact, why: undefined }),
  );
  env.onLanded(signature, o, paid);
}

export async function sendSlice(env: RunEnv, o: VwapOrder, k: number, amount: bigint): Promise<void> {
  const id = o.id;
  const startedAt = env.now();
  // Written before anything is asked: if it cannot be kept, nothing is sent.
  if (!update(env, id, (x) => withSlice(x, k, { state: 'sending', triedAt: startedAt, paid: amount.toString(), why: undefined }))) {
    update(env, id, (x) => withSlice(x, k, { state: 'waiting', paid: undefined, triedAt: startedAt, why: NOT_KEPT_COPY }));
    await env.sleep(RETRY_MS);
    return;
  }
  let late = false;
  let withdrawn = false;
  let unkept = false;
  const guardedSign = async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
    const asked = env.now();
    const signed = await env.walletSign(tx);
    if (env.now() - asked > LATE_SIGN_MS) {
      late = true;
      throw new Error('signed too late');
    }
    const fresh = env.read();
    if (!fresh || fresh.id !== id || fresh.stoppedAt !== undefined || fresh.slices[k]?.state !== 'sending') {
      withdrawn = true;
      throw new Error('order stopped');
    }
    // Its signature and the blockhash it carries are kept HERE, while throwing still stops the
    // send: a record written from `onSent` could fail and the slice would go anyway, to be
    // called "nothing was sent" later and asked again (audit 2026-11-24).
    const { signature, blockhash } = env.signed(signed);
    if (!signature) throw new Error('not signed');
    if (!update(env, id, (x) => withSlice(x, k, { state: 'unconfirmed', sig: signature, sentAt: env.now(), ...(blockhash ? { blockhash } : {}) }))) {
      unkept = true;
      throw new Error('record not kept');
    }
    return signed;
  };
  const release = env.holdReload();
  try {
    const r = await trySlice({ ...env.slice, send: (b64, words, onSent) => env.slice.send(b64, words, guardedSign, onSent) }, o, amount, (signature, quotedOut) => {
      // The signature is already kept (guardedSign); its note is written now: the quote's amount joins it.
      update(env, id, (x) => withSlice(x, k, { state: 'unconfirmed', sig: signature, sentAt: x.slices[k]?.sentAt ?? env.now(), got: quotedOut, gotExact: false }));
    });
    const at = env.now();
    const back = (patch: Parameters<typeof withSlice>[2]) =>
      update(env, id, (x) => withSlice(x, k, { state: 'waiting', paid: undefined, sig: undefined, sentAt: undefined, blockhash: undefined, got: undefined, gotExact: undefined, ...patch }));
    if (r.kind === 'wait') {
      back({ triedAt: at, why: r.why, vsAveragePct: r.vsAveragePct });
    } else if (r.kind === 'not-sent') {
      const why = late ? LATE_COPY : withdrawn ? WITHDRAWN_COPY : unkept ? NOT_KEPT_COPY : r.declined ? DECLINED_COPY : r.why;
      back({ triedAt: late ? at - RETRY_MS : at, why, vsAveragePct: r.vsAveragePct, ...(r.declined && !late && !withdrawn && !unkept ? { declined: true } : {}) });
    } else if (r.kind === 'lost') {
      update(env, id, (x) => ({ ...withSlice(x, k, { state: 'waiting', why: r.why }), stoppedAt: at }));
    } else if (r.outcome === 'reverted') {
      back({ triedAt: at, why: REFUSED_COPY, vsAveragePct: r.vsAveragePct });
    } else if (r.outcome === 'confirmed') {
      await fill(env, o, k, r.signature, amount, BigInt(r.quotedOut));
    } else {
      // Out and not confirmed: it stays "unconfirmed" and nothing else goes until the chain answers.
      update(env, id, (x) => withSlice(x, k, { why: UNCONFIRMED_COPY, vsAveragePct: r.vsAveragePct }));
    }
  } finally {
    release();
  }
}

export async function settleOut(env: RunEnv, o: VwapOrder, k: number): Promise<void> {
  const s = o.slices[k]!;
  const end = await settleSlice(env.settle, s, env.now());
  if (end.kind === 'open') {
    await env.sleep(SETTLE_MS);
    return;
  }
  if (end.kind === 'free') {
    update(env, o.id, (x) => withSlice(x, k, { state: 'waiting', paid: undefined, sig: undefined, sentAt: undefined, blockhash: undefined, got: undefined, gotExact: undefined, triedAt: env.now(), why: end.why }));
    return;
  }
  await fill(env, o, k, s.sig!, BigInt(s.paid ?? '0'), BigInt(s.got ?? '0'));
}

/** Runs order `id` until it is done, gone, replaced, or the loop is told to stop. */
export async function runOrder(env: RunEnv, id: string): Promise<void> {
  while (!env.aborted()) {
    let o = env.read();
    if (!o || o.id !== id) return;
    const now = env.now();
    const moved = advance(o, now);
    if (moved !== o) {
      if (!env.save(moved)) return;
      o = moved;
    }
    const act = nextAction(o, now);
    if (act.kind === 'done') return;
    if (act.kind === 'wait') await env.sleep(Math.min(act.until - now, LOOK_MS));
    else if (act.kind === 'resolve') await settleOut(env, o, act.index);
    else await sendSlice(env, o, act.index, act.amount);
  }
}

/** Whether a stored order still has anything for a runner to do: a slice out is settled even after a stop. */
export function needsRunner(o: VwapOrder | null): boolean {
  if (!o) return false;
  if (o.slices.some((s) => s.state === 'sending' || s.state === 'unconfirmed')) return true;
  return o.stoppedAt === undefined && o.slices.some((s) => s.state === 'waiting');
}
