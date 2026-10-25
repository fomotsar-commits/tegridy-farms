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

import type {
  ExUnitPrices,
  FixedTransaction,
  Transaction,
  TransactionBuilderConfig,
  TransactionOutput,
  TransactionWitnessSet,
  Value,
} from '@emurgo/cardano-serialization-lib-browser';
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

/**
 * A leftover under this is not "burned": it is rounding between CSL's fee estimate and the
 * fee it sets. Above it, CSL found the change too small to be an output and paid it as fee.
 */
const BURN_TOLERANCE = 20_000n;

/** How many extra coins are tried, one more each time, to make a burned leftover into change. */
const EXTRA_INPUT_TRIES = 6;

/**
 * Builds the swap order transaction from the wallet's UTxOs.
 *
 * Inputs and change are CSL's own CIP-2 selection with change included
 * (add_inputs_from_and_change), so a wallet whose largest coin also holds tokens still gets
 * change that can carry them. One case CSL leaves: a leftover too small to be a change output
 * (under about 1 ADA) is paid as network fee, even when the wallet holds more coins. Then the
 * build is tried again with the wallet's next largest coins put in first, so the leftover
 * becomes change; if none helps, the cheapest build is kept, and the review says how much of
 * its network fee is that leftover (checkSwapTx `networkFeeExcess`).
 */
/** CSL's builder, priced by the chain's parameters; `exUnitPrices` for a transaction that runs a script. */
export function txBuilderConfig(csl: Csl, params: ProtocolParams, exUnitPrices?: ExUnitPrices): TransactionBuilderConfig {
  let b = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(csl.LinearFee.new(bn(csl, params.txFeePerByte), bn(csl, params.txFeeFixed)))
    .coins_per_utxo_byte(bn(csl, params.utxoCostPerByte))
    .pool_deposit(bn(csl, params.stakePoolDeposit))
    .key_deposit(bn(csl, params.stakeAddressDeposit))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .ref_script_coins_per_byte(csl.UnitInterval.new(bn(csl, params.minFeeRefScriptCostPerByte), bn(csl, 1)));
  if (exUnitPrices) b = b.ex_unit_prices(exUnitPrices);
  return b.build();
}

export function buildSwapTx(csl: Csl, params: ProtocolParams, utxos: WalletUtxo[], plan: SwapPlan): BuiltSwap {
  const datumHex = encodeSwapOrderDatum(csl, plan);
  const config = txBuilderConfig(csl, params);

  const lock = orderValue(plan);
  const orderOutput = () => {
    const o = csl.TransactionOutput.new(address(csl, orderAddressFor(plan.trader)), valueOf(csl, lock.lovelace, lock.token));
    o.set_plutus_data(csl.PlutusData.from_hex(datumHex));
    return o;
  };
  const orderMin = BigInt(csl.min_ada_for_output(orderOutput(), csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
  // Minswap's orders lock exactly the swap + 4 ADA. An order that would need more is not one
  // this rail knows how to write, so it is refused rather than written differently.
  if (lock.lovelace < orderMin) throw new SwapBuildError('This order needs more ADA than Minswap orders lock.');

  const parsed = utxos.map((u) => csl.TransactionUnspentOutput.from_hex(u.hex));
  // The coins tried first on a retry: the most ADA first.
  const byAda = [...parsed].sort((a, b) => {
    const d = BigInt(b.output().amount().coin().to_str()) - BigInt(a.output().amount().coin().to_str());
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });

  const attempt = (forced: number): { tx: Transaction | null; burned: bigint } => {
    const tb = csl.TransactionBuilder.new(config);
    tb.add_output(orderOutput());
    if (plan.venueFee.kind === 'charged') {
      tb.add_output(csl.TransactionOutput.new(address(csl, plan.venueFee.address), csl.Value.new(bn(csl, plan.venueFee.lovelace))));
    }
    tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));
    const rest = csl.TransactionUnspentOutputs.new();
    byAda.forEach((u, i) => {
      if (i < forced) tb.add_regular_input(u.output().address(), u.input(), u.output().amount());
      else rest.add(u);
    });
    try {
      tb.add_inputs_from_and_change(rest, csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset, csl.ChangeConfig.new(address(csl, plan.trader)));
      const tx = tb.build_tx();
      return { tx, burned: BigInt(tx.body().fee().to_str()) - BigInt(tb.min_fee().to_str()) };
    } catch {
      return { tx: null, burned: 0n };
    }
  };

  let best: { tx: Transaction; burned: bigint } | null = null;
  for (let forced = 0; forced <= Math.min(EXTRA_INPUT_TRIES, byAda.length); forced++) {
    const a = attempt(forced);
    if (!a.tx) continue;
    if (!best || BigInt(a.tx.body().fee().to_str()) < BigInt(best.tx.body().fee().to_str())) best = { tx: a.tx, burned: a.burned };
    if (a.burned <= BURN_TOLERANCE) break;
  }
  if (!best) throw new SwapBuildError('This wallet does not hold enough for the swap, its 4 ADA order lock, the fees and its change.');
  const fixed = csl.FixedTransaction.from_bytes(best.tx.to_bytes());
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

export type SwapCheck = { ok: true; swap: CheckedSwap } | { ok: false; problems: string[] };

export function tokenEntries(v: CslValue): { policyId: string; assetName: string; quantity: bigint }[] {
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
export function checkSwapTx(
  csl: Csl,
  txHex: string,
  plan: SwapPlan,
  walletUtxos: WalletUtxo[],
  fee: Pick<ProtocolParams, 'txFeePerByte' | 'txFeeFixed'>,
): SwapCheck {
  const feePerByte = fee.txFeePerByte;
  const feeFixed = fee.txFeeFixed;
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
  // What the signed transaction's size calls for (Shelley's linear fee), against what it pays.
  const signedSize = BigInt(tx.to_bytes().length + WITNESS_SET_OVERHEAD + VKEY_WITNESS_BYTES * Math.max(1, signers.size));
  const minFee = feePerByte * signedSize + feeFixed;
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
