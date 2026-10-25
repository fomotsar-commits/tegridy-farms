// Cancelling an order, step by step, as the swap runs (swapFlow.ts): a fresh read of the order
// and the chain, the build, the check of the built bytes, the wallet's signatures added to
// those bytes, a note written before anything leaves, then the send.

import type { Csl } from './csl';
import { readScriptParams, readTip, readUtxo } from './chain';
import { sortWalletError, type Cip30Api } from './cip30';
import { MAINNET_NETWORK_ID, type ParsedAddress } from './address';
import { TTL_SLOTS, parseWalletUtxos } from './swapTx';
import { assembleCancelSigned, buildCancelTx, checkCancelTx, type CancelPlan, type CheckedCancel } from './cancelTx';
import { markOrderCancelSent, type CancelNote, type PendingOrder } from './orderWatch';

export type PreparedCancel = { kind: 'review'; plan: CancelPlan; txHex: string; checked: CheckedCancel } | { kind: 'stop'; message: string; problems?: string[] };

/** Reads the order as it stands now, builds its cancel, and checks it. Stops, with nothing to sign, on any doubt. */
export async function prepareCancel(csl: Csl, api: Cip30Api, trader: ParsedAddress, note: PendingOrder): Promise<PreparedCancel> {
  const stop = (message: string, problems?: string[]): PreparedCancel => ({ kind: 'stop', message, problems });
  if (note.traderHex !== trader.hex) return stop('This order was placed from another account. Connect that one to cancel it. Nothing was built.');
  const [order, chain, tip] = await Promise.all([readUtxo(note.txHash, note.orderIndex), readScriptParams(), readTip()]);
  if (order.status !== 'ok') return stop(`The order could not be read just now (${order.reason}). Nothing was built.`);
  if (order.data === null) return stop('The chain does not show this order yet. Nothing was built.');
  if (order.data.spent) return stop('The order is no longer open: Minswap’s batcher filled or returned it. Nothing was built.');
  if (chain.status !== 'ok') return stop(`The chain could not be read just now (${chain.reason}). Nothing was built.`);
  if (tip.status !== 'ok') return stop(`The chain’s clock could not be read (${tip.reason}). Nothing was built.`);
  let utxosHex: unknown;
  try {
    if ((await api.getNetworkId()) !== MAINNET_NETWORK_ID) return stop('The wallet is no longer on Cardano mainnet. Nothing was built.');
    if ((await api.getChangeAddress()) !== trader.hex) return stop('The wallet switched to another account since it connected. Reconnect it to cancel from the account that placed the order. Nothing was built.');
    utxosHex = await api.getUtxos();
  } catch {
    return stop('The wallet did not share its coins. Nothing was built.');
  }
  const utxos = parseWalletUtxos(csl, utxosHex ?? []);
  if (!utxos) return stop('The wallet answered with something that is not a list of coins. Nothing was built.');
  const plan: CancelPlan = { trader, order: order.data.utxo, tipSlot: tip.data.slot };
  let built;
  try {
    built = buildCancelTx(csl, chain.data.params, chain.data.script, utxos, plan);
  } catch (err) {
    return stop(err instanceof Error ? err.message : 'The cancel could not be built.');
  }
  const check = checkCancelTx(csl, built.txHex, plan, utxos, chain.data.params, chain.data.script);
  if (!check.ok) return stop('The built cancel is not the one planned, so it was not offered for signing.', check.problems);
  return { kind: 'review', plan, txHex: built.txHex, checked: check.cancel };
}

export type CancelSendResult =
  | { kind: 'sent'; cancel: CancelNote }
  | { kind: 'declined' }
  | { kind: 'not-sent'; message: string }
  /** The wallet errored while sending: the cancel may or may not be on its way. */
  | { kind: 'unsure'; cancel: CancelNote; message: string };

export async function signAndSendCancel(csl: Csl, api: Cip30Api, orderTx: string, prepared: Extract<PreparedCancel, { kind: 'review' }>): Promise<CancelSendResult> {
  let witnessHex: string;
  try {
    witnessHex = await api.signTx(prepared.txHex, true);
  } catch (err) {
    return sortWalletError(err, 'sign') === 'declined' ? { kind: 'declined' } : { kind: 'not-sent', message: 'The wallet did not sign. Nothing was sent.' };
  }
  const assembled = assembleCancelSigned(csl, prepared.txHex, witnessHex, prepared.checked.txHash, prepared.plan.trader.payment.hash);
  if (!assembled.ok) return { kind: 'not-sent', message: `${assembled.reason} Nothing was sent.` };
  // Noted before the first byte leaves: a reload mid-send still knows a cancel is on its way.
  const cancel: CancelNote = { txHash: assembled.txHash, sentAt: Date.now(), ttlSlot: prepared.plan.tipSlot + TTL_SLOTS };
  markOrderCancelSent(orderTx, cancel);
  try {
    await api.submitTx(assembled.signedHex);
    return { kind: 'sent', cancel };
  } catch {
    return { kind: 'unsure', cancel, message: 'The wallet reported a problem sending the cancel. It may still have gone through: the order shows Returned once it lands.' };
  }
}
