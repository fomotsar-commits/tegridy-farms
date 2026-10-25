// Cancelling an open Minswap V2 order: the trader takes back everything it holds. Built with
// CSL, then read back out of its own bytes and checked before the wallet is asked to sign, as
// the swap is (swapTx.ts checkSwapTx).
//
// SOURCE. minswap-dex-v2 @ c3293ad43: order_validator.ak lets an order be spent with
// CancelOrderByOwner when the datum's canceller authorises it, and this rail's orders name the
// trader's payment key (minswapV2.ts encodeSwapOrderDatum, OAMSignature). The script is read
// from Minswap's own published reference UTxO, never sent inline.
//
// WHAT IT CONTAINS, AND NOTHING ELSE (the shape of the owner cancels read on mainnet):
//   input:            the order, spent with CancelOrderByOwner;
//   reference input:  Minswap's order script;
//   output:           everything the order holds, less the network fee, to the trader's whole address;
//   required signer:  the trader's payment key;
//   collateral:       one coin of the trader's wallet, with its return to the trader. The network
//                     takes the stated part only if the script fails on chain.
// No batcher is involved, so no batcher fee. No mint, certificate, withdrawal, vote or metadata.

import type { FixedTransaction, Transaction, TransactionUnspentOutput } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import type { ProtocolParams, Ratio, ScriptParams } from './chain';
import { bytesToHex, hexToBytes, type ParsedAddress } from './address';
import { cancelRedeemer, MINSWAP_V2, orderAddressFor, readOrderOwner, type ChainUtxo } from './minswapV2';
import { MAX_NETWORK_FEE, TTL_SLOTS, VKEY_WITNESS_BYTES, WITNESS_SET_OVERHEAD, tokenEntries, txBuilderConfig, type WalletUtxo } from './swapTx';

/**
 * The script budget the cancel carries, pinned: the order script's owner-cancel path measured on
 * mainnet (Ogmios evaluateTransaction, cancelTx.test.ts names the figures), with headroom. The
 * check holds every cancel to exactly this, so nothing the wallet sees can raise it.
 */
export const CANCEL_EX_UNITS = { mem: 260_000n, steps: 75_000_000n } as const;

export interface CancelPlan {
  /** The order's owner: its canceller and refund receiver, and where everything comes back. */
  trader: ParsedAddress;
  /** The order UTxO as the chain held it when the plan was made: what it holds is what comes back. */
  order: ChainUtxo;
  /** The chain's slot when the plan was made; the transaction expires TTL_SLOTS later. */
  tipSlot: number;
}

export interface BuiltCancel {
  txHex: string;
  txHash: string;
}

export class CancelBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelBuildError';
  }
}

function bn(csl: Csl, n: bigint | number) {
  return csl.BigNum.from_str(n.toString());
}

function unitInterval(csl: Csl, r: Ratio) {
  return csl.UnitInterval.new(bn(csl, r.numerator), bn(csl, r.denominator));
}

/** The order UTxO's whole value: its ADA and every token in it. */
function orderValue(csl: Csl, u: ChainUtxo) {
  const v = csl.Value.new(bn(csl, u.lovelace));
  if (u.assets.length > 0) {
    const ma = csl.MultiAsset.new();
    for (const a of u.assets) ma.set_asset(csl.ScriptHash.from_hex(a.policyId), csl.AssetName.new(hexToBytes(a.assetName)), bn(csl, a.quantity));
    v.set_multiasset(ma);
  }
  return v;
}

/** The cost models the script data hash commits to: Plutus V2 only, as the chain states it. */
export function v2CostModels(csl: Csl, script: Pick<ScriptParams, 'plutusV2CostModel'>) {
  const model = csl.CostModel.new();
  script.plutusV2CostModel.forEach((n, i) => model.set(i, csl.Int.from_str(String(n))));
  const models = csl.Costmdls.new();
  models.insert(csl.Language.new_plutus_v2(), model);
  return models;
}

/** The least collateral the ledger accepts for `fee`: collateralPercent of it, rounded up. */
export function collateralFor(fee: bigint, percent: number): bigint {
  return (fee * BigInt(percent) + 99n) / 100n;
}

/** A payment-key address (base or enterprise): a coin there can be collateral. Not a script, Byron or pointer address. */
function paymentKeyHash(addressHex: string): string | null {
  const type = parseInt(addressHex.slice(0, 2), 16) >> 4;
  return type === 0 || type === 2 || type === 6 ? addressHex.slice(2, 58) : null;
}

/** How many of the wallet's coins are tried as collateral before the build gives up. */
const COLLATERAL_TRIES = 8;

/**
 * Builds the cancel. The network fee comes out of the order itself, so the wallet's own coins are
 * not spent; one is put up as collateral. Coins at the trader's own payment key are tried first
 * (one signature), then plain-ADA coins, then the smallest.
 */
export function buildCancelTx(csl: Csl, params: ProtocolParams, script: ScriptParams, walletUtxos: WalletUtxo[], plan: CancelPlan): BuiltCancel {
  const config = txBuilderConfig(csl, params, csl.ExUnitPrices.new(unitInterval(csl, script.priceMem), unitInterval(csl, script.priceStep)));
  const traderAddress = csl.Address.from_bytes(hexToBytes(plan.trader.hex));
  const orderInput = csl.TransactionInput.new(csl.TransactionHash.from_hex(plan.order.txHash), plan.order.index);
  const ref = csl.TransactionInput.new(csl.TransactionHash.from_hex(MINSWAP_V2.orderScriptRef.txHash), MINSWAP_V2.orderScriptRef.index);

  const attempt = (coin: TransactionUnspentOutput, totalCollateral: bigint): Transaction | null => {
    try {
      const tb = csl.TransactionBuilder.new(config);
      const source = csl.PlutusScriptSource.new_ref_input(csl.ScriptHash.from_hex(MINSWAP_V2.orderScriptHash), ref, csl.Language.new_plutus_v2(), MINSWAP_V2.orderScriptSize);
      const redeemer = csl.Redeemer.new(csl.RedeemerTag.new_spend(), bn(csl, 0), cancelRedeemer(csl), csl.ExUnits.new(bn(csl, CANCEL_EX_UNITS.mem), bn(csl, CANCEL_EX_UNITS.steps)));
      const inputs = csl.TxInputsBuilder.new();
      inputs.add_plutus_script_input(csl.PlutusWitness.new_with_ref_without_datum(source, redeemer), orderInput, orderValue(csl, plan.order));
      tb.set_inputs(inputs);
      const collateral = csl.TxInputsBuilder.new();
      collateral.add_regular_input(coin.output().address(), coin.input(), coin.output().amount());
      tb.set_collateral(collateral);
      tb.set_total_collateral_and_return(bn(csl, totalCollateral), traderAddress);
      tb.add_required_signer(csl.Ed25519KeyHash.from_hex(plan.trader.payment.hash));
      tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));
      tb.calc_script_data_hash(v2CostModels(csl, script));
      tb.add_change_if_needed(traderAddress);
      return tb.build_tx();
    } catch {
      return null;
    }
  };
  const feeOf = (tx: Transaction) => BigInt(tx.body().fee().to_str());

  const coins = walletUtxos
    .map((u) => csl.TransactionUnspentOutput.from_hex(u.hex))
    .filter((u) => paymentKeyHash(bytesToHex(u.output().address().to_bytes())) !== null);
  const rank = (u: TransactionUnspentOutput) => [
    paymentKeyHash(bytesToHex(u.output().address().to_bytes())) === plan.trader.payment.hash ? 0 : 1,
    u.output().amount().multiasset() ? 1 : 0,
  ];
  coins.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    if (ra[0] !== rb[0]) return ra[0]! - rb[0]!;
    if (ra[1] !== rb[1]) return ra[1]! - rb[1]!;
    const d = BigInt(a.output().amount().coin().to_str()) - BigInt(b.output().amount().coin().to_str());
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });

  for (const coin of coins.slice(0, COLLATERAL_TRIES)) {
    // The collateral is sized to the fee, and the fee by the transaction's size: settle both.
    let total = collateralFor(300_000n, script.collateralPercent);
    let tx = attempt(coin, total);
    for (let i = 0; tx && i < 3 && collateralFor(feeOf(tx), script.collateralPercent) !== total; i++) {
      total = collateralFor(feeOf(tx), script.collateralPercent);
      tx = attempt(coin, total);
    }
    if (!tx || collateralFor(feeOf(tx), script.collateralPercent) !== total) continue;
    const fixed = csl.FixedTransaction.from_bytes(tx.to_bytes());
    return { txHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex() };
  }
  throw new CancelBuildError('A cancel puts up one coin of your wallet as collateral (about 1.5 ADA or more, returned unless the cancel fails on chain), and none of its coins could be used.');
}

export interface CheckedCancel {
  txHash: string;
  /** Everything the order holds, less the network fee: what comes back. */
  backLovelace: bigint;
  backTokens: { policyId: string; assetName: string; quantity: bigint }[];
  networkFee: bigint;
  /** What the network takes from the collateral coin if the cancel fails on chain; the rest of that coin always comes back. */
  collateralAtRisk: bigint;
}

export type CancelCheck = { ok: true; cancel: CheckedCancel } | { ok: false; problems: string[] };

/** How far the fee may sit above this file's own reckoning of what the network asks: rounding, never a leftover. */
const FEE_SLACK = 20_000n;

const sameTokens = (a: { policyId: string; assetName: string; quantity: bigint }[], b: { policyId: string; assetName: string; quantity: bigint }[]) => {
  const key = (t: { policyId: string; assetName: string; quantity: bigint }) => `${t.policyId}.${t.assetName}:${t.quantity}`;
  return a.length === b.length && a.map(key).sort().join() === b.map(key).sort().join();
};

/**
 * Reads the cancel back out of its bytes and refuses it unless it is exactly the plan: it spends
 * only that order, with Minswap's owner-cancel and Minswap's published script, and pays only
 * the trader. Independent of how it was built.
 */
export function checkCancelTx(
  csl: Csl,
  txHex: string,
  plan: CancelPlan,
  walletUtxos: WalletUtxo[],
  params: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed' | 'minFeeRefScriptCostPerByte'>,
  script: ScriptParams,
): CancelCheck {
  const problems: string[] = [];
  let tx: FixedTransaction;
  try {
    tx = csl.FixedTransaction.from_hex(txHex);
  } catch {
    return { ok: false, problems: ['the transaction is not readable'] };
  }
  const body = csl.TransactionBody.from_bytes(tx.raw_body());

  // The order itself: at Minswap's order script with the trader's stake part, cancellable by
  // the trader's key alone, refunding the trader's own whole address.
  if (plan.order.addressHex !== orderAddressFor(plan.trader).hex) problems.push('the coin it spends is not an order of yours at Minswap’s order script');
  const owner = plan.order.inlineDatumHex === null ? null : readOrderOwner(csl, plan.order.inlineDatumHex);
  if (!owner) problems.push('the order’s terms could not be read');
  else {
    if (owner.cancellerKeyHash !== plan.trader.payment.hash) problems.push('the order does not name your key as the one that may cancel it');
    const t = plan.trader;
    const stakeSame = owner.refundTo.stake === null ? t.stake === null : t.stake !== null && owner.refundTo.stake.kind === t.stake.kind && owner.refundTo.stake.hash === t.stake.hash;
    if (owner.refundTo.payment.kind !== t.payment.kind || owner.refundTo.payment.hash !== t.payment.hash || !stakeSame || owner.refundHasDatum) {
      problems.push('the order’s refund is not to your own address');
    }
  }

  // Nothing but this order may move: each of these could hand away stake, rewards, a vote or more.
  if (body.certs()) problems.push('it carries a certificate (it could move your stake or vote)');
  if (body.withdrawals()) problems.push('it withdraws rewards');
  if (body.mint()) problems.push('it mints or burns tokens');
  if (body.voting_procedures() || body.voting_proposals()) problems.push('it votes or proposes');
  if (body.donation() || body.current_treasury_value()) problems.push('it pays the treasury');
  if (body.auxiliary_data_hash() || tx.raw_auxiliary_data()) problems.push('it carries metadata');
  if (body.validity_start_interval_bignum()) problems.push('it sets a start time');
  const net = body.network_id();
  if (net && net.kind() !== csl.NetworkIdKind.Mainnet) problems.push('it is for another network');
  const ttl = body.ttl_bignum();
  if ((ttl ? Number(ttl.to_str()) : null) !== plan.tipSlot + TTL_SLOTS) problems.push('its expiry is not the planned one');

  const inputs = body.inputs();
  const only = inputs.len() === 1 ? inputs.get(0) : null;
  if (!only || only.transaction_id().to_hex() !== plan.order.txHash || only.index() !== plan.order.index) problems.push('it spends something other than this one order');

  const refs = body.reference_inputs();
  const ref = refs && refs.len() === 1 ? refs.get(0) : null;
  if (!ref || ref.transaction_id().to_hex() !== MINSWAP_V2.orderScriptRef.txHash || ref.index() !== MINSWAP_V2.orderScriptRef.index) {
    problems.push('it does not read the order script from Minswap’s own published copy');
  }

  const signers = body.required_signers();
  if (!signers || signers.len() !== 1 || signers.get(0).to_hex() !== plan.trader.payment.hash) problems.push('it asks for a signer other than your own key');

  // The witnesses: one redeemer, Minswap's owner-cancel on input 0 at the pinned budget; no
  // signature yet, no inline script, no datum.
  const ws = tx.witness_set();
  if (ws.vkeys() || ws.bootstraps() || ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data()) problems.push('it arrived already signed or with scripts');
  const redeemers = ws.redeemers();
  const r = redeemers && redeemers.len() === 1 ? redeemers.get(0) : null;
  const redeemerOk =
    r !== null &&
    r.tag().kind() === csl.RedeemerTagKind.Spend &&
    r.index().to_str() === '0' &&
    r.data().to_hex() === cancelRedeemer(csl).to_hex() &&
    r.ex_units().mem().to_str() === CANCEL_EX_UNITS.mem.toString() &&
    r.ex_units().steps().to_str() === CANCEL_EX_UNITS.steps.toString();
  if (!redeemerOk) problems.push('it does not spend the order with Minswap’s owner cancel');
  const dataHash = body.script_data_hash();
  if (!redeemers || !dataHash || dataHash.to_hex() !== csl.hash_script_data(redeemers, v2CostModels(csl, script)).to_hex()) {
    problems.push('its script data hash is not the one for this cancel');
  }

  // The one output: everything the order holds, less the fee, to the trader.
  const networkFee = BigInt(body.fee().to_str());
  const outs = body.outputs();
  const out = outs.len() === 1 ? outs.get(0) : null;
  const backLovelace = plan.order.lovelace - networkFee;
  const backTokens = plan.order.assets.filter((a) => a.quantity !== 0n).map((a) => ({ ...a }));
  if (!out) problems.push(outs.len() === 0 ? 'it pays nothing back' : 'it pays more than one output');
  else {
    if (bytesToHex(out.address().to_bytes()) !== plan.trader.hex) problems.push('it pays an address that is not yours');
    if (out.has_plutus_data() || out.has_data_hash() || out.has_script_ref()) problems.push('what comes back carries a datum or a script');
    if (BigInt(out.amount().coin().to_str()) !== backLovelace || !sameTokens(tokenEntries(out.amount()), backTokens)) {
      problems.push('it does not give back everything the order holds, less the network fee');
    }
  }

  // Collateral: coins of this wallet at a payment key, returned to the trader but for exactly
  // the share of the fee the ledger asks for.
  const own = new Map(walletUtxos.map((u) => [`${u.txHash}#${u.index}`, u]));
  const keys = new Set<string>([plan.trader.payment.hash]);
  const coll = body.collateral();
  let collIn = csl.Value.zero();
  if (!coll || coll.len() === 0 || coll.len() > script.maxCollateralInputs) problems.push(`its collateral is not 1 to ${script.maxCollateralInputs} coins of this wallet`);
  for (let i = 0; coll && i < coll.len(); i++) {
    const c = coll.get(i);
    const u = own.get(`${c.transaction_id().to_hex()}#${c.index()}`);
    const spent = u ? csl.TransactionUnspentOutput.from_hex(u.hex).output() : null;
    const keyHash = spent ? paymentKeyHash(bytesToHex(spent.address().to_bytes())) : null;
    if (!spent || !keyHash) {
      problems.push('its collateral is not a coin of this wallet');
      continue;
    }
    keys.add(keyHash);
    collIn = collIn.checked_add(spent.amount());
  }
  const back = body.collateral_return();
  const total = body.total_collateral();
  const atRisk = total ? BigInt(total.to_str()) : null;
  if (!back || bytesToHex(back.address().to_bytes()) !== plan.trader.hex || back.has_plutus_data() || back.has_data_hash() || back.has_script_ref()) {
    problems.push('its collateral does not come back to your own address');
  } else if (atRisk === null || collIn.compare(back.amount().checked_add(csl.Value.new(bn(csl, atRisk)))) !== 0) {
    problems.push('its collateral does not add up');
  }
  if (atRisk === null || atRisk !== collateralFor(networkFee, script.collateralPercent)) problems.push('it puts up more collateral than the network asks');

  if (networkFee > MAX_NETWORK_FEE) problems.push('the network fee is above 1 ADA');
  // What the network asks: the signed size, the script budget, and the reference script's bytes.
  const signedSize = BigInt(tx.to_bytes().length + WITNESS_SET_OVERHEAD + VKEY_WITNESS_BYTES * keys.size);
  const prices = csl.ExUnitPrices.new(unitInterval(csl, script.priceMem), unitInterval(csl, script.priceStep));
  const scriptFee = r ? BigInt(csl.min_script_fee(csl.Transaction.from_bytes(tx.to_bytes()), prices).to_str()) : 0n;
  const refFee = BigInt(csl.min_ref_script_fee(MINSWAP_V2.orderScriptSize, csl.UnitInterval.new(bn(csl, params.minFeeRefScriptCostPerByte), bn(csl, 1))).to_str());
  const minFee = params.txFeePerByte * signedSize + params.txFeeFixed + scriptFee + refFee;
  if (networkFee < minFee - 1_000n) problems.push('the network fee is below what the network accepts');
  // The fee comes out of what comes back, so a fee above what the network asks is the trader's loss.
  if (networkFee > minFee + FEE_SLACK) problems.push('the network fee is more than this cancel needs');

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, cancel: { txHash: tx.transaction_hash().to_hex(), backLovelace, backTokens, networkFee, collateralAtRisk: atRisk! } };
}

export type AssembleCancelResult = { ok: true; signedHex: string; txHash: string } | { ok: false; reason: string };

/**
 * The checked cancel with the wallet's signatures added. CIP-30 signTx returns a witness set of
 * signatures only; they are added to the checked bytes, whose redeemer CSL keeps byte for byte
 * (the script data hash commits to it; cancelTx.test.ts holds it). Refused unless the trader's
 * own key is among the signers.
 */
export function assembleCancelSigned(csl: Csl, checkedTxHex: string, witnessSetHex: string, checkedTxHash: string, traderKeyHash: string): AssembleCancelResult {
  let keys;
  try {
    const ws = csl.TransactionWitnessSet.from_hex(witnessSetHex);
    if (ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data() || ws.redeemers() || ws.bootstraps()) {
      return { ok: false, reason: 'The wallet added something besides its signature.' };
    }
    keys = ws.vkeys();
  } catch {
    return { ok: false, reason: 'The wallet answered with something that is not a signature.' };
  }
  if (!keys || keys.len() === 0) return { ok: false, reason: 'The wallet did not sign.' };
  const signedBy = new Set<string>();
  for (let i = 0; i < keys.len(); i++) signedBy.add(keys.get(i).vkey().public_key().hash().to_hex());
  if (!signedBy.has(traderKeyHash)) return { ok: false, reason: 'The wallet did not sign with the key that placed this order.' };
  const tx = csl.FixedTransaction.from_hex(checkedTxHex);
  for (let i = 0; i < keys.len(); i++) tx.add_vkey_witness(keys.get(i));
  const txHash = tx.transaction_hash().to_hex();
  if (txHash !== checkedTxHash) return { ok: false, reason: 'The signed transaction is not the one that was checked.' };
  return { ok: true, signedHex: tx.to_hex(), txHash };
}
