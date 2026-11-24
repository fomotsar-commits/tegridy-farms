// The chain a fee-share withdrawal follows, built from PR #1148's real preprod rehearsal
// (test/fixtures/lock-preprod.json and withdraw-preprod.json, every output its producing
// transaction's own bytes): the lock's Execute of announcement #0 (venue share off to 1333),
// dated after ready_at, then the batcher's own planBatch and buildBatchTx filling a second swap
// against the pool that Execute leaves. The pool after is what a real swap leaves once the share
// is on: its value holds the venue's share above its datum's reserves. The second swap is made
// as `scripts/rehearse.ts order` makes it (the real order's bytes, 10 tADA for MEMETEST, its
// minimum 1% under the quote against the pool now: the real order itself, filled already, would
// now be refunded). A third, the same order flipped (MEMETEST for tADA), puts a share in the coin
// too. Nothing here is sent; with AIKEN set, each transaction is judged by Aiken.
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { buildBatchTx, type ProtocolParams } from '../src/build.ts';
import { PREPROD_TIME, slotToPosixMs } from '../src/chain.ts';
import { executeSpec, executeWindow, lockTx, type LockDeployment, type LockRefs } from '../src/lock.ts';
import { planBatch, type Utxo } from '../src/plan.ts';
import { mkConstr, mkInt, type PlutusData } from '../src/plutus.ts';
import { simulate } from '../src/simulate.ts';
import { decodePoolDatum } from '../src/types.ts';
import type { DexConstants } from '../src/verify.ts';

export const FX = JSON.parse(readFileSync(new URL('./fixtures/lock-preprod.json', import.meta.url), 'utf8')) as {
  refs: Record<'lock' | 'pool' | 'globalSetting' | 'lockScript' | 'poolScript' | 'funds' | 'authenScript', string>;
  refsState: Record<string, string>;
  outputs: Record<string, string>;
  pp: ProtocolParams;
  inputs: Record<string, unknown> & { deployer: string; ownerA: string; ownerB: string; treasury: string };
  deployment: { lock: string; policy: string; pool: string; ownerA: string; ownerB: string; treasury: string; deployer: string };
};
export const WX = JSON.parse(readFileSync(new URL('./fixtures/withdraw-preprod.json', import.meta.url), 'utf8')) as {
  fillTx: string;
  refs: Record<'opened' | 'order' | 'orderScript' | 'batchingScript' | 'batcher', string>;
  outputs: Record<string, string>;
};
export const D: LockDeployment = { network: 0, lock: FX.deployment.lock, authen: FX.deployment.policy, pool: FX.deployment.pool, ownerA: FX.deployment.ownerA, ownerB: FX.deployment.ownerB, treasury: FX.deployment.treasury };
const all: Record<string, string> = { ...FX.outputs, ...WX.outputs };
const real = (ref: string): Utxo => ({ ref, outputHex: all[ref]! });
export const REFS: LockRefs = { lockScript: real(FX.refs.lockScript), poolScript: real(FX.refs.poolScript), settingScript: real(FX.refs.authenScript) };
export const LOCK = real(FX.refs.lock);
export const POOL = real(FX.refs.pool);
export const GS = real(FX.refs.globalSetting);
export const FUNDS = real(FX.refs.funds);
export const ORDER = real(WX.refs.order);
export const COIN = { policyId: '1ac2931c06a56bbab07c21ab7fde8eb6cac7cf427a49b03f00aa234b', assetName: '4d454d4554455354' }; // MEMETEST
export const READY = 1_794_278_064_000n; // 2026-11-10T02:34:24Z, the real announcement's ready_at
export const slotOf = (ms: bigint) => PREPROD_TIME.zeroSlot + (ms - PREPROD_TIME.zeroTimeMs) / PREPROD_TIME.slotLengthMs;
export const DEX: DexConstants = { authenPolicy: D.authen, poolScriptHash: D.pool, time: PREPROD_TIME, setting: 'ours' };
/** The rehearsal's batcher (the GlobalSetting's batcher #0), by its address: its key hash is the address's payment part. */
const BATCHER_ADDRESS = 'addr_test1vry5k5h6dcvnjte9twkdpj07r5764dsjs5th5yvpp9k6x0sn5t2f7';
const BATCHER = { keyHash: CSL.Address.from_bech32(BATCHER_ADDRESS).payment_cred()!.to_keyhash()!.to_hex(), address: BATCHER_ADDRESS };
const outputOf = (txHex: string, ix: number): Utxo => ({ ref: `${CSL.FixedTransaction.from_hex(txHex).transaction_hash().to_hex()}#${ix}`, outputHex: CSL.FixedTransaction.from_hex(txHex).body().outputs().get(ix).to_hex() });

/** The Execute of the real announcement, dated ten minutes after ready_at: the lock it leaves (#0, nothing announced), the pool (#1, share 1333), the deployer's change (#2). */
export const EXECUTE = lockTx(executeSpec(D, REFS, LOCK, 0, POOL, GS, FX.pp), { pp: FX.pp, funds: [FUNDS], change: FX.deployment.deployer, validity: executeWindow(slotOf(READY + 600_000n), 0, READY, 600n) });
export const LOCK_AFTER = outputOf(EXECUTE.txHex, 0);
export const POOL_AFTER = outputOf(EXECUTE.txHex, 1);
export const CHANGE_AFTER = outputOf(EXECUTE.txHex, 2);

/** The real order's bytes with its step replaced, holding `value`, at a reference no chain holds. */
function orderLike(ref: string, step: PlutusData, value: CSL.Value): Utxo {
  const o = CSL.TransactionOutput.from_hex(ORDER.outputHex);
  const f = o.plutus_data()!.as_constr_plutus_data()!.data();
  const fields = Array.from({ length: f.len() }, (_, i) => f.get(i));
  fields[6] = step;
  const b = CSL.TransactionOutput.new(o.address(), value);
  b.set_plutus_data(mkConstr(0, fields));
  return { ref, outputHex: b.to_hex() };
}
const TRUE = mkConstr(1, []);
const FALSE = mkConstr(0, []);
/** The second swap, as rehearse.ts makes it: 10 tADA for MEMETEST, minimum 1% under the quote against the pool the Execute leaves. */
export const ORDER_A: Utxo = (() => {
  const p = decodePoolDatum(CSL.TransactionOutput.from_hex(POOL_AFTER.outputHex).plutus_data()!);
  const swap = 10_000_000n;
  const quote = (swap * 9970n * p.reserveB) / (p.reserveA * 10000n + swap * 9970n);
  return orderLike(`${'0a'.repeat(32)}#0`, mkConstr(0, [TRUE, mkConstr(0, [mkInt(swap)]), mkInt((quote * 99n) / 100n), TRUE]), CSL.Value.new(CSL.BigNum.from_str((swap + 4_000_000n).toString())));
})();
/** The same order flipped: 2,000,000,000 MEMETEST for tADA, at least 1 lovelace back, the same trader, fee and deposit. */
export const ORDER_B: Utxo = (() => {
  const ma = CSL.MultiAsset.new();
  ma.set_asset(CSL.ScriptHash.from_hex(COIN.policyId), CSL.AssetName.new(Buffer.from(COIN.assetName, 'hex')), CSL.BigNum.from_str('2000000000'));
  return orderLike(`${'0b'.repeat(32)}#0`, mkConstr(0, [FALSE, mkConstr(0, [mkInt(2_000_000_000n)]), mkInt(1n), TRUE]), CSL.Value.new_with_assets(CSL.BigNum.from_str('4000000'), ma));
})();

/** One batch by the batcher's own code against `pool`, ten minutes after the Execute: its pool output, as it leaves it. */
export function batch(pool: Utxo, orders: Utxo[]): { txHex: string; pool: Utxo; spent: Record<string, string> } {
  const from = slotOf(READY + 1_200_000n);
  const to = from + 300n;
  const nowMs = (slotToPosixMs(from, PREPROD_TIME) + slotToPosixMs(to, PREPROD_TIME)) / 2n;
  const fees = orders.map(() => 2_000_000n);
  const plan = planBatch(DEX, pool, orders, fees, nowMs, null);
  const batcher = real(WX.refs.batcher);
  const { txHex } = buildBatchTx(
    {
      network: 0,
      plan,
      pool,
      orders,
      fees,
      globalSetting: GS,
      scripts: { pool: REFS.poolScript!, order: real(WX.refs.orderScript), poolBatching: real(WX.refs.batchingScript) },
      batchingRewardBalance: 0n,
      batcher: { ...BATCHER, feeUtxos: [batcher], collateral: batcher },
      batcherIndex: 0,
      volFee: null,
      validFromSlot: from,
      validToSlot: to,
      budgets: new Map(),
    },
    FX.pp,
  );
  const spent: Record<string, string> = {};
  for (const u of [pool, ...orders, batcher, GS, REFS.poolScript!, real(WX.refs.orderScript), real(WX.refs.batchingScript)]) spent[u.ref] = u.outputHex;
  return { txHex, pool: outputOf(txHex, orders.length), spent };
}
/** After the second swap: the share accrued in tADA. */
export const SWAPPED = batch(POOL_AFTER, [ORDER_A]);
/** After it and the flipped one: a share in tADA and in MEMETEST. */
export const BOTH = batch(POOL_AFTER, [ORDER_A, ORDER_B]);
/** A big swap instead, 3,000 tADA in (at least 1 MEMETEST back): a share above the min-ADA an output must hold. */
export const ORDER_BIG = orderLike(`${'0c'.repeat(32)}#0`, mkConstr(0, [TRUE, mkConstr(0, [mkInt(3_000_000_000n)]), mkInt(1n), TRUE]), CSL.Value.new(CSL.BigNum.from_str('3004000000')));
export const BIG = batch(POOL_AFTER, [ORDER_BIG]);

/** Every output the chain above makes or reads, by reference. */
export const outputs = (extra: Utxo[] = []) => {
  const known: Record<string, string> = { ...all };
  for (const u of [LOCK_AFTER, POOL_AFTER, CHANGE_AFTER, SWAPPED.pool, BOTH.pool, BIG.pool, ORDER_A, ORDER_B, ORDER_BIG, ...extra]) known[u.ref] = u.outputHex;
  return (ref: string) => known[ref];
};
/** Aiken 1.0.24 on `txHex`, every input, reference input and collateral resolved from `look`. */
export function judge(aiken: string, txHex: string, look: (ref: string) => string | undefined) {
  const body = CSL.FixedTransaction.from_hex(txHex).body();
  const m: Record<string, string> = {};
  for (const l of [body.inputs(), body.reference_inputs(), body.collateral()]) {
    for (let i = 0; i < (l?.len() ?? 0); i++) {
      const r = `${l!.get(i).transaction_id().to_hex()}#${l!.get(i).index()}`;
      m[r] = look(r) ?? (() => { throw new Error(`${r} is not known`); })();
    }
  }
  return simulate(aiken, txHex, m, PREPROD_TIME);
}
