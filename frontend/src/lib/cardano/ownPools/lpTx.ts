// Add and remove liquidity in the venue's own pools: each is an ORDER at the venue's own order
// script (never Minswap's), filled by the venue's own batcher a few blocks later. Built and
// checked by orderTx.ts, the swap's core, so the same read-back refuses anything but the order
// and the trader's change.
//
// HOW MONEY MOVES. The order locks the coins, up to the venue batcher's fee (the record's
// batcherFee, kept by the batcher, which is the venue's) and a 2 ADA deposit that comes back
// with the LP tokens or the coins. No venue fee line: the venue earns inside the pool, its
// 1333 / 10000 share of each trade's fee, once switched on for the pool.

import type { Csl } from '../csl';
import type { ProtocolParams } from '../chain';
import type { ParsedAddress } from '../address';
import { encodeDepositStep, encodeOrderDatum, encodeWithdrawStep, isAda, orderAddressFor, type CardanoAsset, type PoolState } from '../minswapV2';
import { buildOrderTx, checkOrderTx, type CheckedOrder, type OrderTxPlan, type OrderTxWords, type TokenAmount, type WalletUtxo } from '../orderTx';
import type { OwnPools } from './deployment';

/** ADA locked in the order beside the batcher fee, returned with what the order pays out (as Minswap's own orders). */
export const ORDER_DEPOSIT = 2_000_000n;

export type LpOrderPlan =
  | { kind: 'deposit'; trader: ParsedAddress; pool: PoolState; amountA: bigint; amountB: bigint; minimumLp: bigint; tipSlot: number }
  | { kind: 'withdraw'; trader: ParsedAddress; pool: PoolState; lp: bigint; minimumA: bigint; minimumB: bigint; tipSlot: number };

function words(kind: LpOrderPlan['kind']): OrderTxWords {
  return {
    orderTarget: 'the venue’s own order script with your stake part',
    payments: [],
    belowMinAda: 'This order needs more ADA than the venue’s orders lock.',
    notEnough:
      kind === 'deposit'
        ? 'This wallet does not hold enough for the deposit, the order lock (batcher fee and 2 ADA deposit), the network fee and its change.'
        : 'This wallet does not hold enough ADA for the order lock (batcher fee and 2 ADA deposit), the network fee and its change.',
  };
}

/** The order's datum, for our pool's LP token and our batcher's fee. */
export function lpOrderDatum(csl: Csl, dep: OwnPools, plan: LpOrderPlan): string {
  if (plan.pool.lp.policyId !== dep.authenPolicy) throw new Error('This pool is not one of the venue’s.');
  const step =
    plan.kind === 'deposit' ? encodeDepositStep(csl, plan.amountA, plan.amountB, plan.minimumLp) : encodeWithdrawStep(csl, plan.lp, plan.minimumA, plan.minimumB);
  return encodeOrderDatum(csl, { trader: plan.trader, lp: plan.pool.lp, step, maxBatcherFee: dep.batcherFee });
}

/** What the order locks: the coins in, the batcher fee and the deposit. */
export function lpOrderValue(dep: OwnPools, plan: LpOrderPlan): { lovelace: bigint; tokens: TokenAmount[] } {
  const ada = dep.batcherFee + ORDER_DEPOSIT;
  if (plan.kind === 'withdraw') return { lovelace: ada, tokens: [{ asset: plan.pool.lp, quantity: plan.lp }] };
  const put = (asset: CardanoAsset, quantity: bigint) => (isAda(asset) || quantity === 0n ? [] : [{ asset, quantity }]);
  const lovelace = ada + (isAda(plan.pool.assetA) ? plan.amountA : 0n) + (isAda(plan.pool.assetB) ? plan.amountB : 0n);
  return { lovelace, tokens: [...put(plan.pool.assetA, plan.amountA), ...put(plan.pool.assetB, plan.amountB)] };
}

function orderTxPlan(csl: Csl, dep: OwnPools, plan: LpOrderPlan): OrderTxPlan {
  const lock = lpOrderValue(dep, plan);
  return {
    trader: plan.trader,
    order: { address: orderAddressFor(plan.trader, dep), lovelace: lock.lovelace, tokens: lock.tokens, datumHex: lpOrderDatum(csl, dep, plan) },
    payments: [],
    tipSlot: plan.tipSlot,
  };
}

export function buildLpOrderTx(csl: Csl, dep: OwnPools, params: ProtocolParams, utxos: WalletUtxo[], plan: LpOrderPlan) {
  return buildOrderTx(csl, params, utxos, orderTxPlan(csl, dep, plan), words(plan.kind));
}

export type LpOrderCheck = { ok: true; order: CheckedOrder } | { ok: false; problems: string[] };

export function checkLpOrderTx(
  csl: Csl,
  dep: OwnPools,
  txHex: string,
  plan: LpOrderPlan,
  walletUtxos: WalletUtxo[],
  fee: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed'>,
): LpOrderCheck {
  let p: OrderTxPlan;
  try {
    p = orderTxPlan(csl, dep, plan);
  } catch {
    return { ok: false, problems: ['the planned order is not one this site writes'] };
  }
  return checkOrderTx(csl, txHex, p, walletUtxos, fee, words(plan.kind));
}
