// The Cardano swap transaction: built with CSL, then read back out of its own bytes and checked
// before the wallet is asked to sign. The same model as the Solana own-pool path
// (launcher/solana/write/intent.ts): a transaction is sent only if every output that decides
// where value goes is exactly what the review shows.
//
// WHAT IT CONTAINS, IN THIS ORDER, AND NOTHING ELSE:
//   0. the order, at Minswap's order script, with the datum encodeSwapOrderDatum wrote;
//   1. the venue's fee, ADA only, to the registered fee address (only when one is charged);
//   2. onward: the trader's change, to the trader's own whole address.
// Inputs are the wallet's own UTxOs. No mint, no certificate, no withdrawal, no vote, no
// collateral, no required signer, no script, no metadata. A Cardano transaction can move a
// trader's stake or rewards as well as coins, so each of those is refused by name.

import type { FixedTransaction, TransactionOutput, TransactionWitnessSet, Value } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import type { ProtocolParams } from './chain';
import { bytesToHex, hexToBytes, type ParsedAddress } from './address';
import { encodeSwapOrderDatum, isAda, orderAddressFor, orderValue, type CardanoAsset, type PoolState } from './minswapV2';
import type { VenueFee } from './venueFee';

type CslTx = FixedTransaction;
type CslValue = Value;
type CslOutput = TransactionOutput;

/** The most network fee a swap order may carry. A real one costs about 0.2 ADA. */
export const MAX_NETWORK_FEE = 1_000_000n;

/** How long the transaction may wait to land: 15 minutes of slots (one slot is one second). */
export const TTL_SLOTS = 900;

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

export interface WalletUtxo {
  txHash: string;
  index: number;
  /** The UTxO's CBOR as CIP-30 getUtxos returned it. */
  hex: string;
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

function bn(csl: Csl, n: bigint | number) {
  return csl.BigNum.from_str(n.toString());
}

function valueOf(csl: Csl, lovelace: bigint, token: { asset: CardanoAsset; quantity: bigint } | null): CslValue {
  const v = csl.Value.new(bn(csl, lovelace));
  if (token) {
    const ma = csl.MultiAsset.new();
    ma.set_asset(csl.ScriptHash.from_hex(token.asset.policyId), csl.AssetName.new(hexToBytes(token.asset.assetName)), bn(csl, token.quantity));
    v.set_multiasset(ma);
  }
  return v;
}

function address(csl: Csl, a: ParsedAddress) {
  return csl.Address.from_bytes(hexToBytes(a.hex));
}

/** The least ADA an output paying `lovelace` alone to `to` must hold (Babbage: coinsPerUTxOByte). */
export function minAdaForPayment(csl: Csl, params: ProtocolParams, to: ParsedAddress): bigint {
  const out = csl.TransactionOutput.new(address(csl, to), csl.Value.new(bn(csl, 1_000_000n)));
  return BigInt(csl.min_ada_for_output(out, csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
}

export interface BuiltSwap {
  txHex: string;
  txHash: string;
  datumHex: string;
}

export class SwapBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapBuildError';
  }
}

/** Builds the swap order transaction from the wallet's UTxOs. CSL picks the inputs and makes the change. */
export function buildSwapTx(csl: Csl, params: ProtocolParams, utxos: WalletUtxo[], plan: SwapPlan): BuiltSwap {
  const datumHex = encodeSwapOrderDatum(csl, plan);
  const config = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(csl.LinearFee.new(bn(csl, params.txFeePerByte), bn(csl, params.txFeeFixed)))
    .coins_per_utxo_byte(bn(csl, params.utxoCostPerByte))
    .pool_deposit(bn(csl, params.stakePoolDeposit))
    .key_deposit(bn(csl, params.stakeAddressDeposit))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .ref_script_coins_per_byte(csl.UnitInterval.new(bn(csl, params.minFeeRefScriptCostPerByte), bn(csl, 1)))
    .build();
  const tb = csl.TransactionBuilder.new(config);

  const lock = orderValue(plan);
  const order = csl.TransactionOutput.new(address(csl, orderAddressFor(plan.trader)), valueOf(csl, lock.lovelace, lock.token));
  order.set_plutus_data(csl.PlutusData.from_hex(datumHex));
  const orderMin = BigInt(csl.min_ada_for_output(order, csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
  // Minswap's orders lock exactly the swap + 4 ADA. An order that would need more is not one
  // this rail knows how to write, so it is refused rather than written differently.
  if (lock.lovelace < orderMin) throw new SwapBuildError('This order needs more ADA than Minswap orders lock.');
  tb.add_output(order);
  if (plan.venueFee.kind === 'charged') {
    tb.add_output(csl.TransactionOutput.new(address(csl, plan.venueFee.address), csl.Value.new(bn(csl, plan.venueFee.lovelace))));
  }
  tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));

  const set = csl.TransactionUnspentOutputs.new();
  for (const u of utxos) set.add(csl.TransactionUnspentOutput.from_hex(u.hex));
  try {
    tb.add_inputs_from(set, csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
    tb.add_change_if_needed(address(csl, plan.trader));
  } catch {
    throw new SwapBuildError('This wallet does not hold enough for the swap, its 4 ADA order lock, the fees and its change.');
  }
  const tx = tb.build_tx();
  const fixed = csl.FixedTransaction.from_bytes(tx.to_bytes());
  return { txHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex(), datumHex };
}

export interface CheckedSwap {
  txHash: string;
  /** What leaves the wallet, all in: order lock + venue fee + network fee, and the token sold. */
  paidLovelace: bigint;
  paidToken: { asset: CardanoAsset; quantity: bigint } | null;
  orderLovelace: bigint;
  venueFeeLovelace: bigint;
  networkFee: bigint;
}

export type SwapCheck = { ok: true; swap: CheckedSwap } | { ok: false; problems: string[] };

function tokenEntries(v: CslValue): { policyId: string; assetName: string; quantity: bigint }[] {
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

function outputAddressHex(o: CslOutput): string {
  return bytesToHex(o.address().to_bytes());
}

/**
 * Reads the transaction back out of its bytes and refuses it unless it is exactly the plan.
 * Independent of how it was built: a different builder, a bug in ours, or a hooked library
 * that rewrote the bytes all fail here, before any wallet sees them.
 */
export function checkSwapTx(csl: Csl, txHex: string, plan: SwapPlan, walletUtxos: WalletUtxo[]): SwapCheck {
  const problems: string[] = [];
  let tx: CslTx;
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
    totalIn = totalIn.checked_add(csl.TransactionUnspentOutput.from_hex(u.hex).output().amount());
  }

  // Outputs, by position.
  const outs = body.outputs();
  const lock = orderValue(plan);
  const want = { lovelace: lock.lovelace, token: lock.token };
  const order = outs.len() > 0 ? outs.get(0) : null;
  if (!order) {
    problems.push('it has no order');
  } else {
    if (outputAddressHex(order) !== orderAddressFor(plan.trader).hex) problems.push('the order is not addressed to Minswap’s order script with your stake part');
    if (BigInt(order.amount().coin().to_str()) !== want.lovelace) problems.push('the order locks a different amount of ADA');
    const toks = tokenEntries(order.amount());
    const tokenOk = want.token
      ? toks.length === 1 && toks[0]!.policyId === want.token.asset.policyId && toks[0]!.assetName === want.token.asset.assetName && toks[0]!.quantity === want.token.quantity
      : toks.length === 0;
    if (!tokenOk) problems.push('the order locks different tokens');
    if (order.has_data_hash() || order.has_script_ref()) problems.push('the order carries a datum hash or a script');
    let expectedDatum: string | null = null;
    try {
      expectedDatum = encodeSwapOrderDatum(csl, plan);
    } catch {
      problems.push('the planned order is not one this site writes');
    }
    if (!order.has_plutus_data() || order.plutus_data()?.to_hex() !== expectedDatum) problems.push('the order’s terms (who is paid, how much, the minimum) are not the planned ones');
  }

  let next = 1;
  let venueFeeLovelace = 0n;
  if (plan.venueFee.kind === 'charged') {
    const fee = outs.len() > 1 ? outs.get(1) : null;
    if (!fee) problems.push('the venue fee line is missing');
    else {
      if (outputAddressHex(fee) !== plan.venueFee.address.hex) problems.push('the venue fee is not paid to the venue’s registered address');
      if (BigInt(fee.amount().coin().to_str()) !== plan.venueFee.lovelace || tokenEntries(fee.amount()).length > 0) problems.push('the venue fee is not the stated amount');
      if (fee.has_plutus_data() || fee.has_data_hash() || fee.has_script_ref()) problems.push('the venue fee line carries a datum or a script');
      venueFeeLovelace = plan.venueFee.lovelace;
    }
    next = 2;
  }

  let changeOut = csl.Value.zero();
  for (let i = next; i < outs.len(); i++) {
    const c = outs.get(i);
    if (outputAddressHex(c) !== plan.trader.hex) problems.push('a payment goes to an address that is not yours');
    if (c.has_plutus_data() || c.has_data_hash() || c.has_script_ref()) problems.push('your change carries a datum or a script');
    changeOut = changeOut.checked_add(c.amount());
  }

  const networkFee = BigInt(body.fee().to_str());
  if (networkFee > MAX_NETWORK_FEE) problems.push('the network fee is above 1 ADA');

  // Conservation: what went in is the outputs plus the fee, exactly. With nothing minted,
  // withdrawn or deposited, the ledger demands it; checking it here means "what you pay" below
  // is the whole story.
  let totalOut = csl.Value.new(body.fee());
  for (let i = 0; i < outs.len(); i++) totalOut = totalOut.checked_add(outs.get(i).amount());
  if (totalIn.compare(totalOut) !== 0) problems.push('what it spends does not add up to what it pays');

  if (problems.length > 0) return { ok: false, problems };
  const paid = totalIn.clamped_sub(changeOut);
  const paidTokens = tokenEntries(paid);
  return {
    ok: true,
    swap: {
      txHash: tx.transaction_hash().to_hex(),
      paidLovelace: BigInt(paid.coin().to_str()),
      paidToken: !isAda(plan.assetIn) && paidTokens[0] ? { asset: plan.assetIn, quantity: paidTokens[0].quantity } : null,
      orderLovelace: want.lovelace,
      venueFeeLovelace,
      networkFee,
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
  let ws: TransactionWitnessSet;
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
