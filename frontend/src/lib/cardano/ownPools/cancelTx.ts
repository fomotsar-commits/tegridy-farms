// Taking back an unfilled add or remove order at the venue's OWN order script: its owner spends
// it with CancelOrderByOwner, and everything it holds comes back less the network fee. Built
// with CSL, then read back out of its own bytes before the wallet signs (openPoolTx.ts).
// order_validator.ak lets the owner cancel when the datum's canceller key signs, and puts no
// limit on where the coins go: the check below is what holds them to the owner. Every hash and
// the script's reference UTxO come from the deployment record, never from Minswap.

import type { FixedTransaction, Transaction } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import type { ProtocolParams } from '../chain';
import { type ParsedAddress } from '../address';
import { cancelRedeemer, orderAddressFor, readOrderOwner, type ChainUtxo } from '../minswapV2';
import {
  bn,
  cslAddress,
  MAX_NETWORK_FEE,
  outputAddressHex,
  sameTokens,
  tokenEntries,
  TTL_SLOTS,
  txBuilderConfig,
  valueOf,
  VKEY_WITNESS_BYTES,
  WITNESS_SET_OVERHEAD,
  type WalletUtxo,
} from '../orderTx';
import type { OwnPools } from './deployment';
import type { PlutusParams } from './chainReads';
import { assembleSignedOpen, costModels, pickCollateral, type AssembleOpenResult } from './openPoolTx';

/**
 * The owner-cancel's script budget, pinned, so nothing the wallet sees can raise it: our order
 * script's own run of this cancel (Aiken 1.0.24 `tx simulate`, the batcher's evaluator; at most
 * 159,156 memory and 57,006,463 steps, cancelTx.test.ts) with headroom. Re-measure if the order
 * script's code changes: a budget too small is refused by the node before it is relayed.
 */
export const LP_CANCEL_EX_UNITS = { mem: 260_000n, steps: 80_000_000n } as const;

export interface LpCancelPlan {
  /** The order's owner, connected now: its key cancels, and everything comes back to this whole address. */
  trader: ParsedAddress;
  /** The order as the chain holds it now: what it holds is what comes back. */
  order: ChainUtxo;
  /** The chain's slot when the plan was made; the transaction expires TTL_SLOTS later. */
  tipSlot: number;
}

export interface BuiltLpCancel {
  txHex: string;
  txHash: string;
}

export class LpCancelBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LpCancelBuildError';
  }
}

/** The pledge: the share of the largest fee allowed that the network asks, rounded up. */
export function cancelPledge(plutus: Pick<PlutusParams, 'collateralPercentage'>): bigint {
  return (MAX_NETWORK_FEE * BigInt(plutus.collateralPercentage) + 99n) / 100n;
}

const inputOf = (csl: Csl, r: { txHash: string; index: number }) => csl.TransactionInput.new(csl.TransactionHash.from_hex(r.txHash), r.index);

/** The network fee comes out of the order itself: the wallet's coins are not spent, one is only pledged. */
export function buildLpCancelTx(csl: Csl, dep: OwnPools, params: ProtocolParams, plutus: PlutusParams, utxos: WalletUtxo[], plan: LpCancelPlan): BuiltLpCancel {
  if (plan.trader.payment.kind !== 'key') throw new LpCancelBuildError('A script wallet cannot sign a cancel here.');
  const collateral = pickCollateral(csl, plan.trader, utxos);
  if (!collateral) {
    throw new LpCancelBuildError('A cancel runs the order contract, which needs a coin of at least 5 ADA, ADA only, at this address, as a pledge. Send yourself 5 ADA, then try again.');
  }
  const prices = csl.ExUnitPrices.new(csl.UnitInterval.new(bn(csl, plutus.priceMem.n), bn(csl, plutus.priceMem.d)), csl.UnitInterval.new(bn(csl, plutus.priceSteps.n), bn(csl, plutus.priceSteps.d)));
  const tb = csl.TransactionBuilder.new(txBuilderConfig(csl, params).ex_unit_prices(prices).build());
  const owner = cslAddress(csl, plan.trader);

  const source = csl.PlutusScriptSource.new_ref_input(csl.ScriptHash.from_hex(dep.orderScriptHash), inputOf(csl, dep.orderRef), csl.Language.new_plutus_v2(), dep.orderRef.scriptSize);
  const budget = csl.ExUnits.new(bn(csl, LP_CANCEL_EX_UNITS.mem), bn(csl, LP_CANCEL_EX_UNITS.steps));
  const redeemer = csl.Redeemer.new(csl.RedeemerTag.new_spend(), bn(csl, 0), cancelRedeemer(csl), budget);
  const order = plan.order;
  const inputs = csl.TxInputsBuilder.new();
  inputs.add_plutus_script_input(
    csl.PlutusWitness.new_with_ref_without_datum(source, redeemer),
    inputOf(csl, order),
    valueOf(csl, order.lovelace, order.assets.map((a) => ({ asset: { policyId: a.policyId, assetName: a.assetName }, quantity: a.quantity }))),
  );
  tb.set_inputs(inputs);

  const col = csl.TransactionUnspentOutput.from_hex(collateral.hex);
  const colInputs = csl.TxInputsBuilder.new();
  colInputs.add_regular_input(col.output().address(), col.input(), col.output().amount());
  tb.set_collateral(colInputs);
  tb.set_total_collateral_and_return(bn(csl, cancelPledge(plutus)), owner);
  tb.add_required_signer(csl.Ed25519KeyHash.from_hex(plan.trader.payment.hash));
  tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));

  let tx: Transaction;
  try {
    // One input and no coin selection: the redeemer's index is 0 before and after the change.
    tb.calc_script_data_hash(costModels(csl, plutus));
    tb.add_change_if_needed(owner);
    tx = tb.build_tx();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new LpCancelBuildError(`The cancel could not be built (${why.slice(0, 160)}).`);
  }
  const fixed = csl.FixedTransaction.from_bytes(tx.to_bytes());
  return { txHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex() };
}

export interface CheckedLpCancel {
  txHash: string;
  /** Everything the order holds, less the network fee: what comes back. */
  backLovelace: bigint;
  backTokens: { policyId: string; assetName: string; quantity: bigint }[];
  networkFee: bigint;
  /** Pledged, and kept by the network only if the order contract fails on chain. */
  collateralPledged: bigint;
}

export type LpCancelCheck = { ok: true; cancel: CheckedLpCancel } | { ok: false; problems: string[] };

/** How far the fee may sit above this file's reckoning of what the network asks: rounding, never a leftover. */
const FEE_SLACK = 20_000n;

const refKey = (i: { transaction_id(): { to_hex(): string }; index(): number }) => `${i.transaction_id().to_hex()}#${i.index()}`;

/**
 * Refused unless it is exactly this: the one order in, spent with the owner cancel at the pinned
 * budget, our order script read from the record's reference UTxO and nothing else, the owner's
 * key the only required signer, one output paying the owner all of the order less the fee, and
 * one plain-ADA coin of the owner's pledged with its return. Independent of how it was built.
 */
export function checkLpCancelTx(
  csl: Csl,
  dep: OwnPools,
  txHex: string,
  plan: LpCancelPlan,
  walletUtxos: WalletUtxo[],
  params: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed' | 'minFeeRefScriptCostPerByte'>,
  plutus: PlutusParams,
): LpCancelCheck {
  const problems: string[] = [];
  let tx: FixedTransaction;
  try {
    tx = csl.FixedTransaction.from_hex(txHex);
  } catch {
    return { ok: false, problems: ['the transaction is not readable'] };
  }
  const body = csl.TransactionBody.from_bytes(tx.raw_body());
  const trader = plan.trader;

  // The order itself: at OUR order script with the owner's stake part, cancellable by the
  // owner's key alone, its refund naming the owner's own whole address.
  if (plan.order.addressHex !== orderAddressFor(trader, dep).hex) problems.push('the coin it spends is not an order of yours at the venue’s order script');
  const owner = plan.order.inlineDatumHex === null ? null : readOrderOwner(csl, plan.order.inlineDatumHex);
  if (!owner) problems.push('the order’s terms could not be read');
  else {
    if (owner.cancellerKeyHash !== trader.payment.hash) problems.push('the order does not name your key as the one that may cancel it');
    const r = owner.refundTo;
    const stakeSame = r.stake === null ? trader.stake === null : trader.stake !== null && r.stake.kind === trader.stake.kind && r.stake.hash === trader.stake.hash;
    if (r.payment.kind !== trader.payment.kind || r.payment.hash !== trader.payment.hash || !stakeSame || owner.refundHasDatum) problems.push('the order’s refund is not to your own address');
  }

  // Nothing but this order may move: each of these could hand away stake, rewards, a vote or more.
  if (body.certs()) problems.push('it carries a certificate (it could move your stake or vote)');
  if (body.withdrawals()) problems.push('it withdraws rewards');
  if (body.mint()) problems.push('it mints or burns tokens');
  if (body.voting_procedures() || body.voting_proposals()) problems.push('it votes or proposes');
  if (body.donation() || body.current_treasury_value()) problems.push('it pays Cardano’s treasury');
  if (body.auxiliary_data_hash() || tx.raw_auxiliary_data()) problems.push('it carries metadata');
  if (body.validity_start_interval_bignum()) problems.push('it sets a start time');
  const net = body.network_id();
  if (net && net.kind() !== csl.NetworkIdKind.Mainnet) problems.push('it is for another network');
  const ttl = body.ttl_bignum();
  if (!ttl || Number(ttl.to_str()) !== plan.tipSlot + TTL_SLOTS) problems.push('its expiry is not the planned one');

  const inputs = body.inputs();
  if (inputs.len() !== 1 || refKey(inputs.get(0)) !== `${plan.order.txHash}#${plan.order.index}`) problems.push('it spends something other than this one order');
  const refs = body.reference_inputs();
  if (!refs || refs.len() !== 1 || refKey(refs.get(0)) !== `${dep.orderRef.txHash}#${dep.orderRef.index}`) problems.push('it does not read the order script from the venue’s own copy');
  const signers = body.required_signers();
  if (!signers || signers.len() !== 1 || signers.get(0).to_hex() !== trader.payment.hash) problems.push('it asks for a signer other than your own key');

  // The witnesses: no signature yet, no script carried, one owner cancel on input 0 at the pinned budget.
  const ws = tx.witness_set();
  if (ws.vkeys() || ws.bootstraps() || ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data()) problems.push('it arrived already signed or carrying scripts');
  const rs = ws.redeemers();
  const r = rs && rs.len() === 1 ? rs.get(0) : null;
  const redeemerOk =
    r !== null &&
    r.tag().kind() === csl.RedeemerTagKind.Spend &&
    r.index().to_str() === '0' &&
    r.data().to_hex() === cancelRedeemer(csl).to_hex() &&
    BigInt(r.ex_units().mem().to_str()) === LP_CANCEL_EX_UNITS.mem &&
    BigInt(r.ex_units().steps().to_str()) === LP_CANCEL_EX_UNITS.steps;
  if (!redeemerOk) problems.push('it does not spend the order with the owner’s cancel');
  const sdh = body.script_data_hash();
  if (!rs || !sdh || sdh.to_hex() !== csl.hash_script_data(rs, costModels(csl, plutus)).to_hex()) problems.push('its script data does not match its own instructions');

  // The one output: everything the order holds, less the fee, to the owner.
  const networkFee = BigInt(body.fee().to_str());
  const backLovelace = plan.order.lovelace - networkFee;
  const backTokens = plan.order.assets.filter((a) => a.quantity !== 0n).map((a) => ({ ...a }));
  const outs = body.outputs();
  const out = outs.len() === 1 ? outs.get(0) : null;
  if (!out) problems.push(outs.len() === 0 ? 'it pays nothing back' : 'it pays more than one output');
  else {
    if (outputAddressHex(out) !== trader.hex) problems.push('it pays an address that is not yours');
    if (out.has_plutus_data() || out.has_data_hash() || out.has_script_ref()) problems.push('what comes back carries a datum or a script');
    const want = backTokens.map((t) => ({ asset: { policyId: t.policyId, assetName: t.assetName }, quantity: t.quantity }));
    if (BigInt(out.amount().coin().to_str()) !== backLovelace || !sameTokens(tokenEntries(out.amount()), want)) problems.push('it does not give back everything the order holds, less the network fee');
  }

  // The pledge: one plain-ADA coin of this wallet at the owner's own address, all but the network's share coming back.
  const own = new Map(walletUtxos.map((u) => [`${u.txHash}#${u.index}`, u]));
  const col = body.collateral();
  const colTotal = body.total_collateral();
  const colReturn = body.collateral_return();
  let pledged = 0n;
  if (!col || col.len() !== 1 || !colTotal || !colReturn) problems.push('its pledge is not one coin with its return');
  else {
    const u = own.get(refKey(col.get(0)));
    const o = u ? csl.TransactionUnspentOutput.from_hex(u.hex).output() : null;
    if (!o || outputAddressHex(o) !== trader.hex || o.amount().multiasset()) problems.push('its pledge is not a plain ADA coin of this wallet at your address');
    pledged = BigInt(colTotal.to_str());
    if (pledged > cancelPledge(plutus)) problems.push('it pledges more than the network asks');
    if (pledged * 100n < networkFee * BigInt(plutus.collateralPercentage)) problems.push('it pledges less than the network asks');
    if (outputAddressHex(colReturn) !== trader.hex || colReturn.amount().multiasset() || colReturn.has_plutus_data() || colReturn.has_data_hash() || colReturn.has_script_ref()) {
      problems.push('its pledge does not come back to you');
    }
    if (o && BigInt(o.amount().coin().to_str()) !== pledged + BigInt(colReturn.amount().coin().to_str())) problems.push('its pledge does not add up');
  }

  // The fee comes out of what comes back: above what the network asks is the owner's loss.
  if (networkFee > MAX_NETWORK_FEE) problems.push('the network fee is above 1 ADA');
  const signedSize = BigInt(tx.to_bytes().length + WITNESS_SET_OVERHEAD + VKEY_WITNESS_BYTES);
  const { priceMem: pm, priceSteps: ps } = plutus;
  const scriptFee = (LP_CANCEL_EX_UNITS.mem * pm.n * ps.d + LP_CANCEL_EX_UNITS.steps * ps.n * pm.d + pm.d * ps.d - 1n) / (pm.d * ps.d);
  const refScriptFee = BigInt(params.minFeeRefScriptCostPerByte) * BigInt(dep.orderRef.scriptSize);
  const minFee = params.txFeePerByte * signedSize + params.txFeeFixed + scriptFee + refScriptFee;
  if (networkFee < minFee - 1_000n) problems.push('the network fee is below what the network accepts');
  if (networkFee > minFee + FEE_SLACK) problems.push('the network fee is more than this cancel needs');

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, cancel: { txHash: tx.transaction_hash().to_hex(), backLovelace, backTokens, networkFee, collateralPledged: pledged } };
}

/** The checked cancel with the wallet's signatures added (assembleSignedOpen), refused unless the order's own key signed. */
export function assembleSignedLpCancel(csl: Csl, checkedTxHex: string, witnessSetHex: string, checkedTxHash: string, traderKeyHash: string): AssembleOpenResult {
  const r = assembleSignedOpen(csl, checkedTxHex, witnessSetHex, checkedTxHash);
  if (!r.ok) return r;
  const keys = csl.FixedTransaction.from_hex(r.signedHex).witness_set().vkeys();
  const signedBy = Array.from({ length: keys?.len() ?? 0 }, (_, i) => keys!.get(i).vkey().public_key().hash().to_hex());
  return signedBy.includes(traderKeyHash) ? r : { ok: false, reason: 'The wallet did not sign with the key that placed this order.' };
}
