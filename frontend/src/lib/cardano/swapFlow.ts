// The Cardano swap, step by step, in the order the Solana swap's press runs its guards
// (SolanaSwapPage handleSwap): a fresh read of the pool and the chain, the quote held against
// the one on screen, the build, the check of the built bytes, the wallet's signature spliced
// onto those bytes, a note written before anything leaves, then the send.

import type { Csl } from './csl';
import { readPoolCandidates, readProtocolParams, readTip, type ProtocolParams, type Read } from './chain';
import { lpAssetName, readPool, ADA, type CardanoAsset, type PoolState } from './minswapV2';
import { quoteSwap, type SwapQuote } from './quote';
import { minAdaForPayment, buildSwapTx, checkSwapTx, assembleSigned, parseWalletUtxos, TTL_SLOTS, type CheckedSwap, type SwapPlan } from './swapTx';
import { venueFeeAddress } from './venueFee';
import { sortWalletError, type Cip30Api } from './cip30';
import type { ParsedAddress } from './address';
import { markOrderSubmitted, writeOrderNote, type CoinLabel, type PendingOrder } from './orderWatch';
import { MAINNET_NETWORK_ID } from './address';

/** The one Minswap V2 pool for ADA and `token`. null: the chain answered, and there is none. */
export async function findAdaPool(csl: Csl, token: CardanoAsset, signal?: AbortSignal): Promise<Read<PoolState | null>> {
  const candidates = await readPoolCandidates(lpAssetName(ADA, token), signal);
  if (candidates.status !== 'ok') return candidates;
  const pools = candidates.data.map((u) => readPool(csl, u, [ADA, token])).filter((r) => r.kind === 'pool');
  // Minswap's factory keeps one pool per pair; two passing every check is not a state this
  // page can price, so it refuses rather than picking one.
  if (pools.length > 1) return { status: 'unread', reason: 'two pools claim this pair' };
  return { status: 'ok', data: pools[0]?.kind === 'pool' ? pools[0].pool : null };
}

/** The least ADA a payment to the venue's fee address must hold; the fee is not charged below it. */
export function venueFeeFloor(csl: Csl, params: ProtocolParams): bigint {
  const address = venueFeeAddress();
  // With no address registered no fee is charged anyway; any positive floor says so.
  return address ? minAdaForPayment(csl, params, address) : 1n;
}

export async function quoteNow(
  csl: Csl,
  token: CardanoAsset,
  assetIn: CardanoAsset,
  amountIn: bigint,
  slippageBps: number,
  signal?: AbortSignal,
): Promise<{ kind: 'quote'; quote: SwapQuote; params: ProtocolParams } | { kind: 'no-pool' } | { kind: 'refused'; reason: string } | { kind: 'unread'; reason: string }> {
  const [pool, params] = await Promise.all([findAdaPool(csl, token, signal), readProtocolParams(signal)]);
  if (pool.status !== 'ok') return { kind: 'unread', reason: pool.reason };
  if (params.status !== 'ok') return { kind: 'unread', reason: params.reason };
  if (pool.data === null) return { kind: 'no-pool' };
  const q = quoteSwap(pool.data, assetIn, amountIn, slippageBps, venueFeeFloor(csl, params.data));
  return q.kind === 'quote' ? { kind: 'quote', quote: q.quote, params: params.data } : q;
}

export type Prepared =
  | { kind: 'review'; plan: SwapPlan; txHex: string; checked: CheckedSwap; quote: SwapQuote }
  | { kind: 'moved'; quote: SwapQuote }
  | { kind: 'stop'; message: string; problems?: string[] };

/**
 * Re-reads everything, rebuilds, and checks. Stops (nothing to sign) when the pool now pays
 * less than the minimum the trader saw, or when the built transaction is not exactly the plan.
 */
export async function prepareSwap(
  csl: Csl,
  api: Cip30Api,
  trader: ParsedAddress,
  token: CardanoAsset,
  assetIn: CardanoAsset,
  amountIn: bigint,
  slippageBps: number,
  shown: SwapQuote,
): Promise<Prepared> {
  const fresh = await quoteNow(csl, token, assetIn, amountIn, slippageBps);
  if (fresh.kind === 'unread') return { kind: 'stop', message: `The chain could not be read just now (${fresh.reason}). Nothing was built.` };
  if (fresh.kind === 'no-pool') return { kind: 'stop', message: 'The pool is gone. Nothing was built.' };
  if (fresh.kind === 'refused') return { kind: 'stop', message: fresh.reason };
  // Price-moved guard: the fresh quote must still pay at least the minimum on screen.
  if (fresh.quote.expectedOut < shown.minimumReceive) return { kind: 'moved', quote: fresh.quote };
  const tip = await readTip();
  if (tip.status !== 'ok') return { kind: 'stop', message: `The chain's clock could not be read (${tip.reason}). Nothing was built.` };
  // The wallet may have switched account or network since it connected, without saying so
  // (Lace follows its active account). Its coins are read now, so its address is too: an order
  // paying the old account from the new one's coins is never built.
  let utxosHex: unknown;
  try {
    if ((await api.getNetworkId()) !== MAINNET_NETWORK_ID) return { kind: 'stop', message: 'The wallet is no longer on Cardano mainnet. Nothing was built.' };
    if ((await api.getChangeAddress()) !== trader.hex) {
      return { kind: 'stop', message: 'The wallet switched to another account since it connected. Reconnect it to swap from that account. Nothing was built.' };
    }
    utxosHex = await api.getUtxos();
  } catch {
    return { kind: 'stop', message: 'The wallet did not share its coins. Nothing was built.' };
  }
  const utxos = parseWalletUtxos(csl, utxosHex ?? []);
  if (!utxos) return { kind: 'stop', message: 'The wallet answered with something that is not a list of coins. Nothing was built.' };
  const plan: SwapPlan = {
    trader,
    pool: fresh.quote.pool,
    assetIn,
    swapAmount: amountIn,
    // Never below the minimum the trader was shown, and never below the fresh quote's own:
    // a pool that moved in the trader's favour keeps their slippage, not the old figure.
    minimumReceive: fresh.quote.minimumReceive > shown.minimumReceive ? fresh.quote.minimumReceive : shown.minimumReceive,
    venueFee: fresh.quote.venueFee,
    tipSlot: tip.data.slot,
  };
  let built;
  try {
    built = buildSwapTx(csl, fresh.params, utxos, plan);
  } catch (err) {
    return { kind: 'stop', message: err instanceof Error ? err.message : 'The swap could not be built.' };
  }
  const check = checkSwapTx(csl, built.txHex, plan, utxos, fresh.params);
  if (!check.ok) return { kind: 'stop', message: 'The built transaction is not the one planned, so it was not offered for signing.', problems: check.problems };
  return { kind: 'review', plan, txHex: built.txHex, checked: check.swap, quote: fresh.quote };
}

export type SendResult =
  /** `kept`: false when this browser would not keep the order's note, so a reload loses it. */
  | { kind: 'sent'; order: PendingOrder; kept: boolean }
  | { kind: 'declined' }
  | { kind: 'not-sent'; message: string }
  /** The wallet errored while sending: the order may or may not be on its way. It is followed, never called failed. */
  | { kind: 'unsure'; order: PendingOrder; message: string; kept: boolean };

export async function signAndSend(
  csl: Csl,
  api: Cip30Api,
  prepared: Extract<Prepared, { kind: 'review' }>,
  labels: { inLabel: CoinLabel; outLabel: CoinLabel },
): Promise<SendResult> {
  let witnessHex: string;
  try {
    witnessHex = await api.signTx(prepared.txHex, true);
  } catch (err) {
    return sortWalletError(err, 'sign') === 'declined' ? { kind: 'declined' } : { kind: 'not-sent', message: 'The wallet did not sign. Nothing was sent.' };
  }
  const assembled = assembleSigned(csl, prepared.txHex, witnessHex, prepared.checked.txHash);
  if (!assembled.ok) return { kind: 'not-sent', message: `${assembled.reason} Nothing was sent.` };
  const order: PendingOrder = {
    txHash: assembled.txHash,
    orderIndex: 0,
    traderHex: prepared.plan.trader.hex,
    traderPaymentHash: prepared.plan.trader.payment.hash,
    assetIn: prepared.plan.assetIn,
    assetOut: prepared.quote.assetOut,
    amountIn: prepared.plan.swapAmount.toString(),
    minimumReceive: prepared.plan.minimumReceive.toString(),
    inLabel: labels.inLabel,
    outLabel: labels.outLabel,
    ttlSlot: prepared.plan.tipSlot + TTL_SLOTS,
    submitted: false,
    placedAt: Date.now(),
  };
  // Written before the first byte leaves: a reload mid-send still knows this order exists.
  const kept = writeOrderNote(order);
  try {
    await api.submitTx(assembled.signedHex);
    markOrderSubmitted(order.txHash);
    return { kind: 'sent', order: { ...order, submitted: true }, kept };
  } catch {
    return {
      kind: 'unsure',
      order,
      kept,
      message: 'The wallet reported a problem sending it. It may still have gone through: this page follows it until it shows, or until well past its expiry, when it never can.',
    };
  }
}
