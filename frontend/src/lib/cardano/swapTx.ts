// The Cardano swap transaction: a swap order at Minswap's order script, and the venue fee line
// when one is charged. Built and checked by orderTx.ts, the same core the venue's own LP
// orders use (ownPools/lpTx.ts): a transaction is sent only if every output that decides
// where value goes is exactly what the review shows.

import type { Csl } from './csl';
import type { ProtocolParams } from './chain';
import type { ParsedAddress } from './address';
import { encodeSwapOrderDatum, isAda, orderAddressFor, orderValue, type CardanoAsset, type PoolState } from './minswapV2';
import type { VenueFee } from './venueFee';
import { buildOrderTx, checkOrderTx, type OrderTxPlan, type OrderTxWords, type WalletUtxo } from './orderTx';

export { MAX_NETWORK_FEE, TTL_SLOTS, assembleSigned, minAdaForPayment, parseWalletUtxos, OrderBuildError as SwapBuildError } from './orderTx';
export type { AssembleResult, WalletUtxo } from './orderTx';

export interface SwapPlan {
  /** The wallet's change address: it receives the swap, any refund, and the change. */
  trader: ParsedAddress;
  pool: PoolState;
  assetIn: CardanoAsset;
  swapAmount: bigint;
  minimumReceive: bigint;
  venueFee: VenueFee;
  /** The chain's slot when the plan was made; the transaction expires TTL_SLOTS later. */
  tipSlot: number;
}

export interface BuiltSwap {
  txHex: string;
  txHash: string;
  datumHex: string;
}

const SWAP_WORDS: OrderTxWords = {
  orderTarget: 'Minswap’s order script with your stake part',
  payments: [{ label: 'venue fee', toWhom: 'the venue’s registered address' }],
  belowMinAda: 'This order needs more ADA than Minswap orders lock.',
  notEnough: 'This wallet does not hold enough for the swap, its 4 ADA order lock, the fees and its change.',
};

function orderPlan(plan: SwapPlan, datumHex: string): OrderTxPlan {
  const lock = orderValue(plan);
  return {
    trader: plan.trader,
    order: { address: orderAddressFor(plan.trader), lovelace: lock.lovelace, tokens: lock.token ? [lock.token] : [], datumHex },
    payments: plan.venueFee.kind === 'charged' ? [{ address: plan.venueFee.address, lovelace: plan.venueFee.lovelace }] : [],
    tipSlot: plan.tipSlot,
  };
}

/** Builds the swap order transaction from the wallet's UTxOs (orderTx.ts buildOrderTx). */
export function buildSwapTx(csl: Csl, params: ProtocolParams, utxos: WalletUtxo[], plan: SwapPlan): BuiltSwap {
  const datumHex = encodeSwapOrderDatum(csl, plan);
  const built = buildOrderTx(csl, params, utxos, orderPlan(plan, datumHex), SWAP_WORDS);
  return { ...built, datumHex };
}

export interface CheckedSwap {
  txHash: string;
  /** What leaves the wallet, all in: order lock + venue fee + network fee, and the token sold. */
  paidLovelace: bigint;
  paidToken: { asset: CardanoAsset; quantity: bigint } | null;
  orderLovelace: bigint;
  venueFeeLovelace: bigint;
  networkFee: bigint;
  /**
   * How much of the network fee is more than the transaction's size calls for: a leftover CSL
   * paid as fee because it was too small to come back as change. 0 when it is only rounding.
   */
  networkFeeExcess: bigint;
}

export type SwapCheck = { ok: true; swap: CheckedSwap } | { ok: false; problems: string[] };

/** Reads the transaction back out of its bytes and refuses it unless it is exactly the plan. */
export function checkSwapTx(
  csl: Csl,
  txHex: string,
  plan: SwapPlan,
  walletUtxos: WalletUtxo[],
  fee: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed'>,
): SwapCheck {
  let datumHex: string;
  try {
    datumHex = encodeSwapOrderDatum(csl, plan);
  } catch {
    // The planned order is not one this site writes: nothing built from it can be checked.
    return { ok: false, problems: ['the planned order is not one this site writes'] };
  }
  const r = checkOrderTx(csl, txHex, orderPlan(plan, datumHex), walletUtxos, fee, SWAP_WORDS);
  if (!r.ok) return r;
  const o = r.order;
  return {
    ok: true,
    swap: {
      txHash: o.txHash,
      paidLovelace: o.paidLovelace,
      paidToken: !isAda(plan.assetIn) && o.paidTokens[0] ? { asset: plan.assetIn, quantity: o.paidTokens[0].quantity } : null,
      orderLovelace: o.orderLovelace,
      venueFeeLovelace: o.paymentsLovelace,
      networkFee: o.networkFee,
      networkFeeExcess: o.networkFeeExcess,
    },
  };
}
