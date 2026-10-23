// Sending and reading on the local chain. Every transaction goes through `send`, which keeps
// it in `ledger`, so the end of a run can check every account every transaction touched.
import {
  Connection, Transaction, ComputeBudgetProgram, PublicKey, Keypair,
} from './deps.mjs';
import { RPC } from './config.mjs';

export const conn = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true });
export const ledger = [];

const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');

export async function clockNow() {
  const a = await conn.getAccountInfo(SYSVAR_CLOCK, 'confirmed');
  return Number(a.data.readBigInt64LE(32)); // Clock: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The failing program, Anchor's error name if it logged one, and the custom code. */
function readError(err, logs) {
  if (!err) return null;
  const failed = [...(logs || [])].reverse().find((l) => / failed: /.test(l));
  const program = failed ? failed.split(' ')[1] : null;
  const anchor = (logs || []).map((l) => /Error Code: (\w+)\. Error Number: (\d+)/.exec(l)).find(Boolean);
  const custom = err?.InstructionError?.[1]?.Custom;
  return {
    program, name: anchor ? anchor[1] : null, code: anchor ? Number(anchor[2]) : custom ?? null,
    account: (logs || []).map((l) => /AnchorError caused by account: (\w+)\./.exec(l)).find(Boolean)?.[1] ?? null,
    raw: JSON.stringify(err), index: err?.InstructionError?.[0] ?? null,
  };
}

/**
 * Sends one transaction and waits for it. Returns { sig, ok, error, logs, meta, cu }.
 * A failing transaction still lands (preflight is skipped), so a refusal is on the record.
 */
export async function send(label, ixs, signers, { cu = 1_400_000, expectFail = false } = {}) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
  for (let i = 0; ; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`${label}: blockhash expired before it landed`);
    await wait(250);
  }
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!t) await wait(250);
  }
  const logs = t.meta.logMessages || [];
  const keys = t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys;
  const rec = {
    label, sig, ok: !t.meta.err, error: readError(t.meta.err, logs), logs, meta: t.meta,
    keys: keys.map((k) => k.toBase58()), cu: t.meta.computeUnitsConsumed, bytes: raw.length, expectFail,
    blockTime: t.blockTime, slot: t.slot,
  };
  ledger.push(rec);
  return rec;
}

export async function airdrop(to, lamports) {
  const sig = await conn.requestAirdrop(to, lamports);
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await wait(250);
  }
}

export const kp = (secret) => Keypair.fromSecretKey(Uint8Array.from(secret));
export { wait };
