// A Minswap V2 order transaction, any step (a swap, a deposit, a withdrawal): built with CSL,
// then read back out of its own bytes and refused unless it is exactly the plan. swapTx.ts and
// ownPools/lpTx.ts are this with their own order and lines; the checks live here once.
//
// WHAT IT CONTAINS, IN THIS ORDER, AND NOTHING ELSE:
//   0. the order, at the plan's order script with the trader's stake part, its datum exact;
//   1. each fixed ADA payment the plan names (the swap's venue fee), exact address and amount;
//   2. onward: the trader's change, to the trader's own whole address.
// Inputs are the wallet's own UTxOs. No mint, certificate, withdrawal, vote, collateral,
// required signer, script or metadata: each could move stake or rewards, so each is named.

import type { FixedTransaction, Transaction, TransactionOutput, Value } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import type { ProtocolParams } from './chain';
import { bytesToHex, hexToBytes, type ParsedAddress } from './address';
import type { CardanoAsset } from './minswapV2';

/** The most network fee an order may carry. A real one costs about 0.2 ADA. */
export const MAX_NETWORK_FEE = 1_000_000n;

/** How long the transaction may wait to land: 15 minutes of slots (one slot is one second). */
export const TTL_SLOTS = 900;

export interface WalletUtxo {
  txHash: string;
  index: number;
  /** The UTxO's CBOR as CIP-30 getUtxos returned it. */
  hex: string;
}

export interface TokenAmount {
  asset: CardanoAsset;
  quantity: bigint;
}

export interface OrderTxPlan {
  /** The wallet's change address: receives the change, and is the order's receiver. */
  trader: ParsedAddress;
  order: { address: ParsedAddress; lovelace: bigint; tokens: TokenAmount[]; datumHex: string };
  /** ADA-only payments after the order, in this order. */
  payments: { address: ParsedAddress; lovelace: bigint }[];
  /** The chain's slot when the plan was made; the transaction expires TTL_SLOTS later. */
  tipSlot: number;
}

/** The words the check and the build use for this kind of order (the swap keeps its own). */
export interface OrderTxWords {
  /** "Minswap’s order script with your stake part". */
  orderTarget: string;
  /** Per payment, by position: what it is and whom it must pay. */
  payments: { label: string; toWhom: string }[];
  /** The order would need more ADA than this kind of order locks. */
  belowMinAda: string;
  /** No selection of the wallet's coins covers the order, the payments, the fee and change. */
  notEnough: string;
}

export class OrderBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderBuildError';
  }
}

/** CIP-30 getUtxos, read. Null when any entry is not a UTxO: the wallet's answer is used whole or not at all. */
export function parseWalletUtxos(csl: Csl, hexes: unknown): WalletUtxo[] | null {
  if (!Array.isArray(hexes)) return null;
  const out: WalletUtxo[] = [];
  for (const h of hexes) {
    if (typeof h !== 'string') return null;
    try {
      const u = csl.TransactionUnspentOutput.from_hex(h);
      out.push({ txHash: u.input().transaction_id().to_hex(), index: u.input().index(), hex: h });
    } catch {
      return null;
    }
  }
  return out;
}

export function bn(csl: Csl, n: bigint | number) {
  return csl.BigNum.from_str(n.toString());
}

export function valueOf(csl: Csl, lovelace: bigint, tokens: readonly TokenAmount[]): Value {
  const v = csl.Value.new(bn(csl, lovelace));
  if (tokens.length > 0) {
    const ma = csl.MultiAsset.new();
    for (const t of tokens) ma.set_asset(csl.ScriptHash.from_hex(t.asset.policyId), csl.AssetName.new(hexToBytes(t.asset.assetName)), bn(csl, t.quantity));
    v.set_multiasset(ma);
  }
  return v;
}

export function cslAddress(csl: Csl, a: ParsedAddress) {
  return csl.Address.from_bytes(hexToBytes(a.hex));
}

/** The least ADA an output paying `lovelace` alone to `to` must hold (Babbage: coinsPerUTxOByte). */
export function minAdaForPayment(csl: Csl, params: ProtocolParams, to: ParsedAddress): bigint {
  const out = csl.TransactionOutput.new(cslAddress(csl, to), csl.Value.new(bn(csl, 1_000_000n)));
  return BigInt(csl.min_ada_for_output(out, csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
}

export function txBuilderConfig(csl: Csl, params: ProtocolParams) {
  return csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(csl.LinearFee.new(bn(csl, params.txFeePerByte), bn(csl, params.txFeeFixed)))
    .coins_per_utxo_byte(bn(csl, params.utxoCostPerByte))
    .pool_deposit(bn(csl, params.stakePoolDeposit))
    .key_deposit(bn(csl, params.stakeAddressDeposit))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .ref_script_coins_per_byte(csl.UnitInterval.new(bn(csl, params.minFeeRefScriptCostPerByte), bn(csl, 1)));
}

/** The wallet's coins, the most ADA first: the order a retry puts them in. */
export function byMostAda(csl: Csl, utxos: readonly WalletUtxo[]) {
  return utxos
    .map((u) => csl.TransactionUnspentOutput.from_hex(u.hex))
    .sort((a, b) => {
      const d = BigInt(b.output().amount().coin().to_str()) - BigInt(a.output().amount().coin().to_str());
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
}

export interface BuiltOrder {
  txHex: string;
  txHash: string;
}

/**
 * A leftover under this is not "burned": it is rounding between CSL's fee estimate and the
 * fee it sets. Above it, CSL found the change too small to be an output and paid it as fee.
 */
const BURN_TOLERANCE = 20_000n;

/** How many extra coins are tried, one more each time, to make a burned leftover into change. */
const EXTRA_INPUT_TRIES = 6;

/**
 * Builds the order transaction from the wallet's UTxOs.
 *
 * Inputs and change are CSL's own CIP-2 selection with change included
 * (add_inputs_from_and_change), so a wallet whose largest coin also holds tokens still gets
 * change that can carry them. One case CSL leaves: a leftover too small to be a change output
 * (under about 1 ADA) is paid as network fee, even when the wallet holds more coins. Then the
 * build is tried again with the wallet's next largest coins put in first, so the leftover
 * becomes change; if none helps, the cheapest build is kept, and the review says how much of
 * its network fee is that leftover (checkOrderTx `networkFeeExcess`).
 */
export function buildOrderTx(csl: Csl, params: ProtocolParams, utxos: WalletUtxo[], plan: OrderTxPlan, words: OrderTxWords): BuiltOrder {
  const config = txBuilderConfig(csl, params).build();
  const orderOutput = () => {
    const o = csl.TransactionOutput.new(cslAddress(csl, plan.order.address), valueOf(csl, plan.order.lovelace, plan.order.tokens));
    o.set_plutus_data(csl.PlutusData.from_hex(plan.order.datumHex));
    return o;
  };
  const orderMin = BigInt(csl.min_ada_for_output(orderOutput(), csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
  // Minswap's orders lock a fixed ADA amount. An order that would need more is not one this
  // rail knows how to write, so it is refused rather than written differently.
  if (plan.order.lovelace < orderMin) throw new OrderBuildError(words.belowMinAda);

  const ordered = byMostAda(csl, utxos);
  const attempt = (forced: number): { tx: Transaction | null; burned: bigint } => {
    const tb = csl.TransactionBuilder.new(config);
    tb.add_output(orderOutput());
    for (const p of plan.payments) tb.add_output(csl.TransactionOutput.new(cslAddress(csl, p.address), csl.Value.new(bn(csl, p.lovelace))));
    tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));
    const rest = csl.TransactionUnspentOutputs.new();
    ordered.forEach((u, i) => {
      if (i < forced) tb.add_regular_input(u.output().address(), u.input(), u.output().amount());
      else rest.add(u);
    });
    try {
      tb.add_inputs_from_and_change(rest, csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset, csl.ChangeConfig.new(cslAddress(csl, plan.trader)));
      const tx = tb.build_tx();
      return { tx, burned: BigInt(tx.body().fee().to_str()) - BigInt(tb.min_fee().to_str()) };
    } catch {
      return { tx: null, burned: 0n };
    }
  };

  let best: { tx: Transaction; burned: bigint } | null = null;
  for (let forced = 0; forced <= Math.min(EXTRA_INPUT_TRIES, ordered.length); forced++) {
    const a = attempt(forced);
    if (!a.tx) continue;
    if (!best || BigInt(a.tx.body().fee().to_str()) < BigInt(best.tx.body().fee().to_str())) best = { tx: a.tx, burned: a.burned };
    if (a.burned <= BURN_TOLERANCE) break;
  }
  if (!best) throw new OrderBuildError(words.notEnough);
  const fixed = csl.FixedTransaction.from_bytes(best.tx.to_bytes());
  return { txHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex() };
}

export interface CheckedOrder {
  txHash: string;
  /** What leaves the wallet, all in: order lock + payments + network fee, ADA and each token. */
  paidLovelace: bigint;
  paidTokens: { policyId: string; assetName: string; quantity: bigint }[];
  orderLovelace: bigint;
  paymentsLovelace: bigint;
  networkFee: bigint;
  /**
   * How much of the network fee is more than the transaction's size calls for: a leftover CSL
   * paid as fee because it was too small to come back as change. 0 when it is only rounding.
   */
  networkFeeExcess: bigint;
}

/** A vkey witness in the signed transaction: [vkey (2+32 bytes), signature (2+64 bytes)] plus its array header. */
export const VKEY_WITNESS_BYTES = 101;
/** The signed witness set's map and list headers, over the unsigned one's empty map. */
export const WITNESS_SET_OVERHEAD = 3;

export type OrderCheck = { ok: true; order: CheckedOrder } | { ok: false; problems: string[] };

export function tokenEntries(v: Value): { policyId: string; assetName: string; quantity: bigint }[] {
  const out: { policyId: string; assetName: string; quantity: bigint }[] = [];
  const ma = v.multiasset();
  if (!ma) return out;
  const policies = ma.keys();
  for (let i = 0; i < policies.len(); i++) {
    const p = policies.get(i);
    const assets = ma.get(p);
    if (!assets) continue;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) {
      const n = names.get(j);
      const q = assets.get(n);
      if (q) out.push({ policyId: p.to_hex(), assetName: bytesToHex(n.name()), quantity: BigInt(q.to_str()) });
    }
  }
  return out.filter((e) => e.quantity !== 0n);
}

export function outputAddressHex(o: TransactionOutput): string {
  return bytesToHex(o.address().to_bytes());
}

/** Exactly these tokens, each once, each at exactly this quantity, and no other. */
export function sameTokens(have: readonly { policyId: string; assetName: string; quantity: bigint }[], want: readonly TokenAmount[]): boolean {
  if (have.length !== want.length) return false;
  return want.every((w) => have.filter((h) => h.policyId === w.asset.policyId && h.assetName === w.asset.assetName && h.quantity === w.quantity).length === 1);
}

/**
 * Reads the transaction back out of its bytes and refuses it unless it is exactly the plan.
 * Independent of how it was built: a different builder, a bug in ours, or a hooked library
 * that rewrote the bytes all fail here, before any wallet sees them.
 */
export function checkOrderTx(
  csl: Csl,
  txHex: string,
  plan: OrderTxPlan,
  walletUtxos: WalletUtxo[],
  fee: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed'>,
  words: Pick<OrderTxWords, 'orderTarget' | 'payments'>,
): OrderCheck {
  const problems: string[] = [];
  let tx: FixedTransaction;
  try {
    tx = csl.FixedTransaction.from_hex(txHex);
  } catch {
    return { ok: false, problems: ['the transaction is not readable'] };
  }
  const body = csl.TransactionBody.from_bytes(tx.raw_body());

  // Nothing but coins may move: each of these could hand away stake, rewards, a vote or more.
  if (body.certs()) problems.push('it carries a certificate (it could move your stake or vote)');
  if (body.withdrawals()) problems.push('it withdraws rewards');
  if (body.mint()) problems.push('it mints or burns tokens');
  if (body.collateral() || body.collateral_return() || body.total_collateral()) problems.push('it puts up collateral');
  if (body.required_signers()) problems.push('it asks for extra signers');
  if (body.reference_inputs()) problems.push('it reads reference inputs');
  if (body.script_data_hash()) problems.push('it runs a script');
  if (body.voting_procedures() || body.voting_proposals()) problems.push('it votes or proposes');
  if (body.donation() || body.current_treasury_value()) problems.push('it pays the treasury');
  if (body.auxiliary_data_hash() || tx.raw_auxiliary_data()) problems.push('it carries metadata');
  if (body.validity_start_interval_bignum()) problems.push('it sets a start time');
  const net = body.network_id();
  if (net && net.kind() !== csl.NetworkIdKind.Mainnet) problems.push('it is for another network');
  const ws = tx.witness_set();
  if (ws.vkeys() || ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data() || ws.redeemers() || ws.bootstraps()) {
    problems.push('it arrived already signed or with scripts');
  }

  // The validity window: exactly the planned one, so a retry after it passes is provably safe.
  const ttl = body.ttl_bignum();
  const ttlSlot = ttl ? Number(ttl.to_str()) : null;
  if (ttlSlot !== plan.tipSlot + TTL_SLOTS) problems.push('its expiry is not the planned one');

  // Inputs: only the wallet's own UTxOs, and the total they hold.
  const own = new Map(walletUtxos.map((u) => [`${u.txHash}#${u.index}`, u]));
  const signers = new Set<string>();
  const inputs = body.inputs();
  let totalIn = csl.Value.zero();
  if (inputs.len() === 0) problems.push('it spends nothing');
  for (let i = 0; i < inputs.len(); i++) {
    const inp = inputs.get(i);
    const u = own.get(`${inp.transaction_id().to_hex()}#${inp.index()}`);
    if (!u) {
      problems.push('it spends a coin that is not in this wallet');
      continue;
    }
    const spent = csl.TransactionUnspentOutput.from_hex(u.hex).output();
    totalIn = totalIn.checked_add(spent.amount());
    // One signature per payment key spent from: the signed size, for the fee check below.
    signers.add(bytesToHex(spent.address().to_bytes()).slice(2, 58));
  }

  // Outputs, by position.
  const outs = body.outputs();
  const order = outs.len() > 0 ? outs.get(0) : null;
  if (!order) {
    problems.push('it has no order');
  } else {
    if (outputAddressHex(order) !== plan.order.address.hex) problems.push(`the order is not addressed to ${words.orderTarget}`);
    if (BigInt(order.amount().coin().to_str()) !== plan.order.lovelace) problems.push('the order locks a different amount of ADA');
    if (!sameTokens(tokenEntries(order.amount()), plan.order.tokens)) problems.push('the order locks different tokens');
    if (order.has_data_hash() || order.has_script_ref()) problems.push('the order carries a datum hash or a script');
    if (!order.has_plutus_data() || order.plutus_data()?.to_hex() !== plan.order.datumHex) problems.push('the order’s terms (who is paid, how much, the minimum) are not the planned ones');
  }

  let paymentsLovelace = 0n;
  plan.payments.forEach((p, i) => {
    const w = words.payments[i] ?? { label: 'payment', toWhom: 'its stated address' };
    const o = outs.len() > 1 + i ? outs.get(1 + i) : null;
    if (!o) {
      problems.push(`the ${w.label} line is missing`);
      return;
    }
    if (outputAddressHex(o) !== p.address.hex) problems.push(`the ${w.label} is not paid to ${w.toWhom}`);
    if (BigInt(o.amount().coin().to_str()) !== p.lovelace || tokenEntries(o.amount()).length > 0) problems.push(`the ${w.label} is not the stated amount`);
    if (o.has_plutus_data() || o.has_data_hash() || o.has_script_ref()) problems.push(`the ${w.label} line carries a datum or a script`);
    paymentsLovelace += p.lovelace;
  });

  let changeOut = csl.Value.zero();
  for (let i = 1 + plan.payments.length; i < outs.len(); i++) {
    const c = outs.get(i);
    if (outputAddressHex(c) !== plan.trader.hex) problems.push('a payment goes to an address that is not yours');
    if (c.has_plutus_data() || c.has_data_hash() || c.has_script_ref()) problems.push('your change carries a datum or a script');
    changeOut = changeOut.checked_add(c.amount());
  }

  const networkFee = BigInt(body.fee().to_str());
  if (networkFee > MAX_NETWORK_FEE) problems.push('the network fee is above 1 ADA');
  // What the signed transaction's size calls for (Shelley's linear fee), against what it pays.
  const signedSize = BigInt(tx.to_bytes().length + WITNESS_SET_OVERHEAD + VKEY_WITNESS_BYTES * Math.max(1, signers.size));
  const minFee = fee.txFeePerByte * signedSize + fee.txFeeFixed;
  if (networkFee < minFee - 1_000n) problems.push('the network fee is below what the network accepts');
  const excess = networkFee - minFee;
  const networkFeeExcess = excess > 20_000n ? excess : 0n;

  // Conservation: what went in is the outputs plus the fee, exactly. With nothing minted,
  // withdrawn or deposited, the ledger demands it; checking it here means "what you pay" below
  // is the whole story.
  let totalOut = csl.Value.new(body.fee());
  for (let i = 0; i < outs.len(); i++) totalOut = totalOut.checked_add(outs.get(i).amount());
  if (totalIn.compare(totalOut) !== 0) problems.push('what it spends does not add up to what it pays');

  if (problems.length > 0) return { ok: false, problems };
  const paid = totalIn.clamped_sub(changeOut);
  return {
    ok: true,
    order: {
      txHash: tx.transaction_hash().to_hex(),
      paidLovelace: BigInt(paid.coin().to_str()),
      paidTokens: tokenEntries(paid),
      orderLovelace: plan.order.lovelace,
      paymentsLovelace,
      networkFee,
      networkFeeExcess,
    },
  };
}

export type AssembleResult = { ok: true; signedHex: string; txHash: string } | { ok: false; reason: string };

/**
 * The checked body with the wallet's signatures. CIP-30 signTx returns only a witness set, so
 * the wallet cannot change what was checked; this splices its witnesses onto the ORIGINAL body
 * bytes (FixedTransaction keeps them), and refuses anything but plain key signatures.
 */
export function assembleSigned(csl: Csl, checkedTxHex: string, witnessSetHex: string, checkedTxHash: string): AssembleResult {
  let ws;
  try {
    ws = csl.TransactionWitnessSet.from_hex(witnessSetHex);
  } catch {
    return { ok: false, reason: 'The wallet answered with something that is not a signature.' };
  }
  const keys = ws.vkeys();
  if (!keys || keys.len() === 0) return { ok: false, reason: 'The wallet did not sign.' };
  if (ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data() || ws.redeemers() || ws.bootstraps()) {
    return { ok: false, reason: 'The wallet added something besides its signature.' };
  }
  const tx = csl.FixedTransaction.from_hex(checkedTxHex);
  tx.set_witness_set(hexToBytes(witnessSetHex));
  const txHash = tx.transaction_hash().to_hex();
  if (txHash !== checkedTxHash) return { ok: false, reason: 'The signed transaction is not the one that was checked.' };
  return { ok: true, signedHex: tx.to_hex(), txHash };
}
