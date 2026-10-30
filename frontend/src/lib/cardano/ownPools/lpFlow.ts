// Add, remove and open, step by step, in the order the swap's press runs its guards
// (swapFlow.ts): a fresh read of the pool and the chain, the quote held against the one on
// screen, the build, the check of the built bytes, the wallet's signature spliced on, a note
// written before anything leaves, then the send.

import type { Csl } from '../csl';
import { readProtocolParams, readTip } from '../chain';
import { MAINNET_NETWORK_ID, type ParsedAddress } from '../address';
import { sortWalletError, type Cip30Api } from '../cip30';
import { ADA, lpAsset, lpAssetName, type CardanoAsset, type PoolState } from '../minswapV2';
import { assembleSigned, parseWalletUtxos, TTL_SLOTS, type CheckedOrder, type WalletUtxo } from '../orderTx';
import type { CoinLabel } from '../orderWatch';
import type { OwnPools } from './deployment';
import { factorySlotFor, findOwnPool, readFactoryEntries, readGlobalSetting, readPlutusParams, receiverIs } from './chainReads';
import { quoteDeposit, quoteWithdraw, type DepositQuote, type WithdrawQuote } from './lpMath';
import { buildLpOrderTx, checkLpOrderTx, type LpOrderPlan } from './lpTx';
import { assembleSignedOpen, buildOpenPoolTx, checkOpenPoolTx, type CheckedOpenPool, type OpenPoolPlan } from './openPoolTx';
import { markLpSubmitted, writeLpNote, type LpOrderNote } from './lpWatch';

export type LpPrepared =
  | { kind: 'review'; action: 'deposit'; plan: Extract<LpOrderPlan, { kind: 'deposit' }>; quote: DepositQuote; txHex: string; checked: CheckedOrder }
  | { kind: 'review'; action: 'withdraw'; plan: Extract<LpOrderPlan, { kind: 'withdraw' }>; quote: WithdrawQuote; txHex: string; checked: CheckedOrder }
  | { kind: 'review'; action: 'open'; plan: OpenPoolPlan; txHex: string; checked: CheckedOpenPool }
  | { kind: 'moved' }
  | { kind: 'stop'; message: string; problems?: string[] };

type Reviewed = Extract<LpPrepared, { kind: 'review' }>;

const stop = (message: string, problems?: string[]): LpPrepared => ({ kind: 'stop', message, problems });

/** The wallet's coins, read now, with its network and its account held to the ones it connected with. */
async function walletCoins(csl: Csl, api: Cip30Api, trader: ParsedAddress): Promise<{ ok: true; utxos: WalletUtxo[] } | { ok: false; message: string }> {
  let raw: unknown;
  try {
    if ((await api.getNetworkId()) !== MAINNET_NETWORK_ID) return { ok: false, message: 'The wallet is no longer on Cardano mainnet. Nothing was built.' };
    if ((await api.getChangeAddress()) !== trader.hex) return { ok: false, message: 'The wallet switched to another account since it connected. Reconnect it to use that account. Nothing was built.' };
    raw = await api.getUtxos();
  } catch {
    return { ok: false, message: 'The wallet did not share its coins. Nothing was built.' };
  }
  const utxos = parseWalletUtxos(csl, raw ?? []);
  return utxos ? { ok: true, utxos } : { ok: false, message: 'The wallet answered with something that is not a list of coins. Nothing was built.' };
}

/** The pool, the parameters and the clock, read fresh; or why not. */
async function freshPool(csl: Csl, dep: OwnPools, token: CardanoAsset): Promise<{ ok: true; pool: PoolState } | { ok: false; message: string }> {
  const pool = await findOwnPool(csl, dep, token);
  if (pool.status !== 'ok') return { ok: false, message: `The pool could not be read just now (${pool.reason}). Nothing was built.` };
  if (!pool.data) return { ok: false, message: 'No venue pool holds ADA and this coin. Nothing was built.' };
  return { ok: true, pool: pool.data };
}

async function paramsAndTip() {
  const [params, tip] = await Promise.all([readProtocolParams(), readTip()]);
  if (params.status !== 'ok') return { ok: false as const, message: `The chain’s parameters could not be read (${params.reason}). Nothing was built.` };
  if (tip.status !== 'ok') return { ok: false as const, message: `The chain’s clock could not be read (${tip.reason}). Nothing was built.` };
  return { ok: true as const, params: params.data, tipSlot: tip.data.slot };
}

export async function prepareDeposit(
  csl: Csl,
  dep: OwnPools,
  api: Cip30Api,
  trader: ParsedAddress,
  token: CardanoAsset,
  amountAda: bigint,
  amountToken: bigint,
  slippageBps: number,
  shown: DepositQuote,
): Promise<LpPrepared> {
  const p = await freshPool(csl, dep, token);
  if (!p.ok) return stop(p.message);
  const fresh = quoteDeposit(p.pool, amountAda, amountToken, slippageBps);
  if ('refused' in fresh) return stop(fresh.refused);
  // Price-moved guard: the fresh quote must still mint at least the minimum on screen.
  if (fresh.expectedLp < shown.minimumLp) return { kind: 'moved' };
  const env = await paramsAndTip();
  if (!env.ok) return stop(env.message);
  const w = await walletCoins(csl, api, trader);
  if (!w.ok) return stop(w.message);
  const plan: Extract<LpOrderPlan, { kind: 'deposit' }> = {
    kind: 'deposit',
    trader,
    pool: p.pool,
    amountA: amountAda,
    amountB: amountToken,
    // Never below the minimum shown, and never below the fresh quote's own.
    minimumLp: fresh.minimumLp > shown.minimumLp ? fresh.minimumLp : shown.minimumLp,
    tipSlot: env.tipSlot,
  };
  let built;
  try {
    built = buildLpOrderTx(csl, dep, env.params, w.utxos, plan);
  } catch (err) {
    return stop(err instanceof Error ? err.message : 'The deposit could not be built.');
  }
  const check = checkLpOrderTx(csl, dep, built.txHex, plan, w.utxos, env.params);
  if (!check.ok) return stop('The built transaction is not the one planned, so it was not offered for signing.', check.problems);
  return { kind: 'review', action: 'deposit', plan, quote: fresh, txHex: built.txHex, checked: check.order };
}

export async function prepareWithdraw(
  csl: Csl,
  dep: OwnPools,
  api: Cip30Api,
  trader: ParsedAddress,
  token: CardanoAsset,
  lp: bigint,
  slippageBps: number,
  shown: WithdrawQuote,
): Promise<LpPrepared> {
  const p = await freshPool(csl, dep, token);
  if (!p.ok) return stop(p.message);
  const fresh = quoteWithdraw(p.pool, lp, slippageBps);
  if ('refused' in fresh) return stop(fresh.refused);
  if (fresh.expectedA < shown.minimumA || fresh.expectedB < shown.minimumB) return { kind: 'moved' };
  const env = await paramsAndTip();
  if (!env.ok) return stop(env.message);
  const w = await walletCoins(csl, api, trader);
  if (!w.ok) return stop(w.message);
  const plan: Extract<LpOrderPlan, { kind: 'withdraw' }> = {
    kind: 'withdraw',
    trader,
    pool: p.pool,
    lp,
    minimumA: fresh.minimumA > shown.minimumA ? fresh.minimumA : shown.minimumA,
    minimumB: fresh.minimumB > shown.minimumB ? fresh.minimumB : shown.minimumB,
    tipSlot: env.tipSlot,
  };
  let built;
  try {
    built = buildLpOrderTx(csl, dep, env.params, w.utxos, plan);
  } catch (err) {
    return stop(err instanceof Error ? err.message : 'The withdrawal could not be built.');
  }
  const check = checkLpOrderTx(csl, dep, built.txHex, plan, w.utxos, env.params);
  if (!check.ok) return stop('The built transaction is not the one planned, so it was not offered for signing.', check.problems);
  return { kind: 'review', action: 'withdraw', plan, quote: fresh, txHex: built.txHex, checked: check.order };
}

export async function prepareOpen(csl: Csl, dep: OwnPools, api: Cip30Api, opener: ParsedAddress, token: CardanoAsset, amountAda: bigint, amountToken: bigint): Promise<LpPrepared> {
  const [setting, existing, factory, plutus] = await Promise.all([readGlobalSetting(csl, dep), findOwnPool(csl, dep, token), readFactoryEntries(csl, dep), readPlutusParams()]);
  if (setting.status !== 'ok') return stop(`The venue’s pool settings could not be read (${setting.reason}). Nothing was built.`);
  // The chain decides the fee; this page states the record's. They must be the same fee to the same treasury.
  if (setting.data.openingFee !== dep.openingFee || !receiverIs(setting.data.receiver, dep.treasury)) {
    return stop('The chain’s opening fee or its receiver is not the one this page states. Nothing was built.');
  }
  if (existing.status !== 'ok') return stop(`The pool list could not be read (${existing.reason}). Nothing was built.`);
  if (existing.data) return stop('A venue pool for ADA and this coin is already open. Add to it instead.');
  if (factory.status !== 'ok') return stop(`The pool list could not be read (${factory.reason}). Nothing was built.`);
  const slot = factorySlotFor(factory.data, lpAssetName(ADA, token));
  if (slot.kind === 'exists') return stop('A venue pool for ADA and this coin is already open. Add to it instead.');
  if (slot.kind === 'none') return stop('The pool list could not be read whole. Nothing was built.');
  if (plutus.status !== 'ok') return stop(`The chain’s script prices could not be read (${plutus.reason}). Nothing was built.`);
  const env = await paramsAndTip();
  if (!env.ok) return stop(env.message);
  const w = await walletCoins(csl, api, opener);
  if (!w.ok) return stop(w.message);
  const plan: OpenPoolPlan = {
    opener,
    token,
    amountAda,
    amountToken,
    factory: slot.entry,
    setting: { txHash: setting.data.utxo.txHash, index: setting.data.utxo.index },
    openingFee: setting.data.openingFee,
    tipSlot: env.tipSlot,
  };
  let built;
  try {
    built = buildOpenPoolTx(csl, dep, env.params, plutus.data, w.utxos, plan);
  } catch (err) {
    return stop(err instanceof Error ? err.message : 'The pool opening could not be built.');
  }
  const check = checkOpenPoolTx(csl, dep, built.txHex, plan, w.utxos, env.params, plutus.data);
  if (!check.ok) return stop('The built transaction is not the one planned, so it was not offered for signing.', check.problems);
  return { kind: 'review', action: 'open', plan, txHex: built.txHex, checked: check.open };
}

export type LpSendResult =
  | { kind: 'sent'; note: LpOrderNote; kept: boolean }
  | { kind: 'declined' }
  | { kind: 'not-sent'; message: string }
  /** The wallet errored while sending: it may or may not be on its way. Followed, never called failed. */
  | { kind: 'unsure'; note: LpOrderNote; message: string; kept: boolean };

function noteFor(dep: OwnPools, p: Reviewed, txHash: string, tokenLabel: CoinLabel): LpOrderNote {
  const trader = p.action === 'open' ? p.plan.opener : p.plan.trader;
  const token = p.action === 'open' ? p.plan.token : p.plan.pool.assetB;
  const base = {
    txHash,
    orderIndex: 0 as const,
    traderHex: trader.hex,
    traderPaymentHash: trader.payment.hash,
    token,
    lp: lpAsset(ADA, token, dep),
    tokenLabel,
    ttlSlot: p.plan.tipSlot + TTL_SLOTS,
    submitted: false,
    placedAt: Date.now(),
  };
  if (p.action === 'deposit') return { ...base, kind: 'deposit', amountAda: p.plan.amountA.toString(), amountToken: p.plan.amountB.toString(), lpAmount: p.plan.minimumLp.toString() };
  if (p.action === 'withdraw') return { ...base, kind: 'withdraw', amountAda: p.plan.minimumA.toString(), amountToken: p.plan.minimumB.toString(), lpAmount: p.plan.lp.toString() };
  return {
    ...base,
    kind: 'open',
    amountAda: p.plan.amountAda.toString(),
    amountToken: p.plan.amountToken.toString(),
    lpAmount: p.checked.openerLp.toString(),
    totalLiquidity: (p.checked.openerLp + 10n).toString(),
  };
}

export async function signAndSendLp(csl: Csl, dep: OwnPools, api: Cip30Api, prepared: Reviewed, tokenLabel: CoinLabel): Promise<LpSendResult> {
  let witnessHex: string;
  try {
    witnessHex = await api.signTx(prepared.txHex, true);
  } catch (err) {
    return sortWalletError(err, 'sign') === 'declined' ? { kind: 'declined' } : { kind: 'not-sent', message: 'The wallet did not sign. Nothing was sent.' };
  }
  const assembled =
    prepared.action === 'open' ? assembleSignedOpen(csl, prepared.txHex, witnessHex, prepared.checked.txHash) : assembleSigned(csl, prepared.txHex, witnessHex, prepared.checked.txHash);
  if (!assembled.ok) return { kind: 'not-sent', message: `${assembled.reason} Nothing was sent.` };
  const note = noteFor(dep, prepared, assembled.txHash, tokenLabel);
  // Written before the first byte leaves: a reload mid-send still knows it exists.
  const kept = writeLpNote(note);
  try {
    await api.submitTx(assembled.signedHex);
    markLpSubmitted(note.txHash);
    return { kind: 'sent', note: { ...note, submitted: true }, kept };
  } catch {
    return {
      kind: 'unsure',
      note,
      kept,
      message: 'The wallet reported a problem sending it. It may still have gone through: this page follows it until it shows, or until well past its expiry, when it never can.',
    };
  }
}
