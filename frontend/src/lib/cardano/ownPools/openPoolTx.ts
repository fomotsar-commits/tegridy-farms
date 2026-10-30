// Opening a pool in the venue's own deployment: the factory's Pool Creation Transaction
// (cardano/minswap-dex-v2 factory_validator.ak, with #1016's opening fee). Unlike an order, the
// opener's own transaction runs two of our scripts, from our reference UTxOs: the factory spend
// and the authen mint. Built with CSL, then read back and refused unless it is exactly the plan.
//
// WHAT IT CONTAINS, IN THIS ORDER:
//   0. the pool, at our pool address: both coins, the 4.5 ADA every pool keeps, the unminted
//      LP supply and our pool NFT, with its datum (0.3% both ways, venue share off, as the
//      factory demands of a new pool);
//   1, 2. the factory entry split in two around the new pool's LP name (the one-pool-per-pair list);
//   3. the opening fee, exactly the global setting's, to exactly its receiver, the treasury;
//   4. the opener's LP tokens, to the opener;
//   5. onward: the opener's change.
// Inputs: the opener's coins and the one factory entry. Reference inputs: our global setting
// and our two scripts, nothing else. A collateral of the opener's plain ADA, with its return to
// the opener: the network takes it only if the scripts fail on chain, which a node refuses to
// relay. No certificate, withdrawal, vote, metadata or extra signer.
//
// THE SCRIPT BUDGET comes from the deployment record, measured with the node's evaluator at the
// deploy with headroom. Too small, and the node refuses the transaction before it is relayed.

import type { PlutusData, Transaction, TransactionWitnessSet } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import type { ProtocolParams } from '../chain';
import { bytesToHex, hexToBytes, type ParsedAddress } from '../address';
import { ADA, lpAssetName, MINSWAP_V2, poolOrder, type CardanoAsset } from '../minswapV2';
import {
  bn,
  byMostAda,
  cslAddress,
  outputAddressHex,
  sameTokens,
  tokenEntries,
  TTL_SLOTS,
  txBuilderConfig,
  valueOf,
  VKEY_WITNESS_BYTES,
  WITNESS_SET_OVERHEAD,
  type TokenAmount,
  type WalletUtxo,
} from '../orderTx';
import type { OwnPools } from './deployment';
import { FACTORY_NFT_NAME, type FactoryEntry, type PlutusParams } from './chainReads';
import { MAX_LP_SUPPLY, MIN_POOL_ADA, quoteOpen } from './lpMath';

/** The trading fee of every pool the site opens: 30 / 10000 both ways (owner's ruling, 2026-10-24). */
export const OPEN_POOL_FEE_NUMERATOR = 30n;
/** The most network fee a pool opening may carry. Two scripts run; a real one costs well under 1 ADA. */
export const MAX_OPEN_NETWORK_FEE = 2_000_000n;
/** The least a plain-ADA coin must hold to stand as collateral (the pledge, with its return). */
export const MIN_COLLATERAL_COIN = 5_000_000n;

export interface OpenPoolPlan {
  opener: ParsedAddress;
  token: CardanoAsset;
  /** Into the reserves: ADA (lovelace) and the coin. */
  amountAda: bigint;
  amountToken: bigint;
  factory: FactoryEntry;
  /** The global setting UTxO, read as a reference input. */
  setting: { txHash: string; index: number };
  /** The opening fee the global setting names (prepare holds it equal to the record's). */
  openingFee: bigint;
  tipSlot: number;
}

export class OpenPoolBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenPoolBuildError';
  }
}

// ---- Plutus data, as types.ak defines it ----
function constr(csl: Csl, alt: number, fs: PlutusData[]): PlutusData {
  const l = csl.PlutusList.new();
  for (const f of fs) l.add(f);
  return csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(bn(csl, alt), l));
}
const bytes = (csl: Csl, hex: string) => csl.PlutusData.new_bytes(hexToBytes(hex));
const int = (csl: Csl, n: bigint) => csl.PlutusData.new_integer(csl.BigInt.from_str(n.toString()));
const assetData = (csl: Csl, a: CardanoAsset) => constr(csl, 0, [bytes(csl, a.policyId), bytes(csl, a.assetName)]);

/** The pair in the pool's order: ADA first (utils.ak sorted_asset). */
function pairOf(plan: Pick<OpenPoolPlan, 'token'>): [CardanoAsset, CardanoAsset] {
  return poolOrder(ADA, plan.token);
}

export function poolDatumHex(csl: Csl, dep: OwnPools, plan: OpenPoolPlan, totalLiquidity: bigint): string {
  const [a, b] = pairOf(plan);
  return constr(csl, 0, [
    constr(csl, 0, [constr(csl, 1, [bytes(csl, dep.poolBatchingScriptHash)])]), // Inline(ScriptCredential(batching))
    assetData(csl, a),
    assetData(csl, b),
    int(csl, totalLiquidity),
    int(csl, plan.amountAda),
    int(csl, plan.amountToken),
    int(csl, OPEN_POOL_FEE_NUMERATOR),
    int(csl, OPEN_POOL_FEE_NUMERATOR),
    constr(csl, 1, []), // fee_sharing_numerator_opt: None (the factory requires it)
    constr(csl, 0, []), // allow_dynamic_fee: False (the factory requires it)
  ]).to_hex();
}

export const factoryDatumHex = (csl: Csl, head: string, tail: string) => constr(csl, 0, [bytes(csl, head), bytes(csl, tail)]).to_hex();
export const factoryRedeemerHex = (csl: Csl, plan: Pick<OpenPoolPlan, 'token'>) => constr(csl, 0, pairOf(plan).map((x) => assetData(csl, x))).to_hex();
/** AuthenRedeemer.CreatePool. */
export const createPoolRedeemerHex = (csl: Csl) => constr(csl, 1, []).to_hex();

/** Everything the plan decides, outputs in order: what the build writes and the check holds it to. */
export interface OpenPoolLayout {
  lpName: string;
  lp: CardanoAsset;
  totalLiquidity: bigint;
  openerLp: bigint;
  pool: { address: ParsedAddress; lovelace: bigint; tokens: TokenAmount[]; datumHex: string };
  factoryOuts: { addressHex: string; lovelace: bigint; datumHex: string }[];
  fee: { address: ParsedAddress; lovelace: bigint };
  lpOut: { address: ParsedAddress; lovelace: bigint; tokens: TokenAmount[] };
}

function minAda(csl: Csl, params: ProtocolParams, o: ReturnType<Csl['TransactionOutput']['new']>): bigint {
  return BigInt(csl.min_ada_for_output(o, csl.DataCost.new_coins_per_byte(bn(csl, params.utxoCostPerByte))).to_str());
}

export function openPoolLayout(csl: Csl, dep: OwnPools, params: ProtocolParams, plan: OpenPoolPlan): OpenPoolLayout {
  if (plan.opener.payment.kind !== 'key') throw new OpenPoolBuildError('A script wallet cannot open a pool here.');
  const q = quoteOpen(plan.amountAda, plan.amountToken);
  if ('refused' in q) throw new OpenPoolBuildError(q.refused);
  const [a, b] = pairOf(plan);
  const lpName = lpAssetName(a, b);
  if (!(plan.factory.head < lpName && lpName < plan.factory.tail)) throw new OpenPoolBuildError('The factory entry does not hold this pair’s place.');
  const lp: CardanoAsset = { policyId: dep.authenPolicy, assetName: lpName };
  const nft: CardanoAsset = { policyId: dep.authenPolicy, assetName: MINSWAP_V2.poolNftName };
  const factoryNft: CardanoAsset = { policyId: dep.authenPolicy, assetName: FACTORY_NFT_NAME };

  const factoryAddressHex = plan.factory.utxo.addressHex;
  const factoryOut = (head: string, tail: string, floor: bigint) => {
    const datumHex = factoryDatumHex(csl, head, tail);
    const o = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(factoryAddressHex)), valueOf(csl, 1_000_000n, [{ asset: factoryNft, quantity: 1n }]));
    o.set_plutus_data(csl.PlutusData.from_hex(datumHex));
    const need = minAda(csl, params, o);
    return { addressHex: factoryAddressHex, lovelace: need > floor ? need : floor, datumHex };
  };
  // The first keeps the entry's own ADA; the second is new, at the least it may hold.
  const factoryOuts = [factoryOut(plan.factory.head, lpName, plan.factory.utxo.lovelace), factoryOut(lpName, plan.factory.tail, 0n)];

  const lpTokens = [{ asset: lp, quantity: q.openerLp }];
  const lpProbe = csl.TransactionOutput.new(cslAddress(csl, plan.opener), valueOf(csl, 1_000_000n, lpTokens));
  return {
    lpName,
    lp,
    totalLiquidity: q.totalLiquidity,
    openerLp: q.openerLp,
    pool: {
      address: dep.poolAddress,
      lovelace: MIN_POOL_ADA + plan.amountAda,
      tokens: [
        { asset: b, quantity: plan.amountToken },
        { asset: lp, quantity: q.poolLpRemaining },
        { asset: nft, quantity: 1n },
      ],
      datumHex: poolDatumHex(csl, dep, plan, q.totalLiquidity),
    },
    factoryOuts,
    fee: { address: dep.treasury, lovelace: plan.openingFee },
    lpOut: { address: plan.opener, lovelace: minAda(csl, params, lpProbe), tokens: lpTokens },
  };
}

export function costModels(csl: Csl, plutus: PlutusParams) {
  const cm = csl.CostModel.new();
  plutus.costModelV2.forEach((v, i) => cm.set(i, v >= 0 ? csl.Int.new(bn(csl, v)) : csl.Int.new_negative(bn(csl, -v))));
  const all = csl.Costmdls.new();
  all.insert(csl.Language.new_plutus_v2(), cm);
  return all;
}

const input = (csl: Csl, txHash: string, index: number) => csl.TransactionInput.new(csl.TransactionHash.from_hex(txHash), index);

/** A plain-ADA coin at the opener's own key that can stand as collateral, or null. */
export function pickCollateral(csl: Csl, opener: ParsedAddress, utxos: WalletUtxo[]): WalletUtxo | null {
  const fits = utxos.filter((u) => {
    const o = csl.TransactionUnspentOutput.from_hex(u.hex).output();
    return outputAddressHex(o) === opener.hex && !o.amount().multiasset() && !o.has_plutus_data() && !o.has_data_hash() && !o.has_script_ref() && BigInt(o.amount().coin().to_str()) >= MIN_COLLATERAL_COIN;
  });
  // The smallest that fits: the least ADA tied up as a pledge.
  return fits.sort((x, y) => {
    const d = BigInt(csl.TransactionUnspentOutput.from_hex(x.hex).output().amount().coin().to_str()) - BigInt(csl.TransactionUnspentOutput.from_hex(y.hex).output().amount().coin().to_str());
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  })[0] ?? null;
}

/** The pledge: the share of the largest fee allowed that the network asks, rounded up. */
export function collateralTotal(plutus: Pick<PlutusParams, 'collateralPercentage'>): bigint {
  return (MAX_OPEN_NETWORK_FEE * BigInt(plutus.collateralPercentage) + 99n) / 100n;
}

export interface BuiltOpenPool {
  txHex: string;
  txHash: string;
  layout: OpenPoolLayout;
  collateral: WalletUtxo;
}

export function buildOpenPoolTx(csl: Csl, dep: OwnPools, params: ProtocolParams, plutus: PlutusParams, utxos: WalletUtxo[], plan: OpenPoolPlan): BuiltOpenPool {
  const layout = openPoolLayout(csl, dep, params, plan);
  const collateral = pickCollateral(csl, plan.opener, utxos);
  if (!collateral) throw new OpenPoolBuildError('Opening a pool runs the pool’s scripts, which needs a coin of at least 5 ADA, ADA only, as a pledge. Send yourself 5 ADA, then try again.');
  const config = txBuilderConfig(csl, params)
    .ex_unit_prices(csl.ExUnitPrices.new(csl.UnitInterval.new(bn(csl, plutus.priceMem.n), bn(csl, plutus.priceMem.d)), csl.UnitInterval.new(bn(csl, plutus.priceSteps.n), bn(csl, plutus.priceSteps.d))))
    .build();
  const tb = csl.TransactionBuilder.new(config);
  const v2 = csl.Language.new_plutus_v2();
  const exUnits = (b: { mem: bigint; steps: bigint }) => csl.ExUnits.new(bn(csl, b.mem), bn(csl, b.steps));

  // The factory entry, spent by our factory script from its reference UTxO.
  const factoryIn = plan.factory.utxo;
  const factoryScript = csl.PlutusScriptSource.new_ref_input(csl.ScriptHash.from_hex(dep.factoryScriptHash), input(csl, dep.factoryRef.txHash, dep.factoryRef.index), v2, dep.factoryRef.scriptSize);
  const spend = csl.Redeemer.new(csl.RedeemerTag.new_spend(), bn(csl, 0), csl.PlutusData.from_hex(factoryRedeemerHex(csl, plan)), exUnits(dep.openPoolBudget.factory));
  const scriptInputs = csl.TxInputsBuilder.new();
  scriptInputs.add_plutus_script_input(
    csl.PlutusWitness.new_with_ref_without_datum(factoryScript, spend),
    input(csl, factoryIn.txHash, factoryIn.index),
    valueOf(csl, factoryIn.lovelace, factoryIn.assets.map((x) => ({ asset: { policyId: x.policyId, assetName: x.assetName }, quantity: x.quantity }))),
  );
  tb.set_inputs(scriptInputs);

  // The mint: factory NFT, pool NFT, the whole LP supply, by our authen policy.
  const authenScript = csl.PlutusScriptSource.new_ref_input(csl.ScriptHash.from_hex(dep.authenPolicy), input(csl, dep.authenRef.txHash, dep.authenRef.index), v2, dep.authenRef.scriptSize);
  const mintRedeemer = csl.Redeemer.new(csl.RedeemerTag.new_mint(), bn(csl, 0), csl.PlutusData.from_hex(createPoolRedeemerHex(csl)), exUnits(dep.openPoolBudget.authen));
  const mint = csl.MintBuilder.new();
  const witness = csl.MintWitness.new_plutus_script(authenScript, mintRedeemer);
  for (const [name, q] of [[FACTORY_NFT_NAME, 1n], [MINSWAP_V2.poolNftName, 1n], [layout.lpName, MAX_LP_SUPPLY]] as const) {
    mint.add_asset(witness, csl.AssetName.new(hexToBytes(name)), csl.Int.new(bn(csl, q)));
  }
  tb.set_mint_builder(mint);
  tb.add_reference_input(input(csl, plan.setting.txHash, plan.setting.index));

  // Outputs, in the order the check reads them.
  const pool = csl.TransactionOutput.new(cslAddress(csl, layout.pool.address), valueOf(csl, layout.pool.lovelace, layout.pool.tokens));
  pool.set_plutus_data(csl.PlutusData.from_hex(layout.pool.datumHex));
  tb.add_output(pool);
  for (const f of layout.factoryOuts) {
    const o = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(f.addressHex)), valueOf(csl, f.lovelace, [{ asset: { policyId: dep.authenPolicy, assetName: FACTORY_NFT_NAME }, quantity: 1n }]));
    o.set_plutus_data(csl.PlutusData.from_hex(f.datumHex));
    tb.add_output(o);
  }
  tb.add_output(csl.TransactionOutput.new(cslAddress(csl, layout.fee.address), csl.Value.new(bn(csl, layout.fee.lovelace))));
  tb.add_output(csl.TransactionOutput.new(cslAddress(csl, layout.lpOut.address), valueOf(csl, layout.lpOut.lovelace, layout.lpOut.tokens)));
  tb.set_ttl_bignum(bn(csl, plan.tipSlot + TTL_SLOTS));

  // The pledge, with all of it but the network's share coming back.
  const col = csl.TransactionUnspentOutput.from_hex(collateral.hex);
  const colInputs = csl.TxInputsBuilder.new();
  colInputs.add_regular_input(col.output().address(), col.input(), col.output().amount());
  tb.set_collateral(colInputs);
  tb.set_total_collateral_and_return(bn(csl, collateralTotal(plutus)), cslAddress(csl, plan.opener));

  // The opener's coins, the most ADA first. The pledge coin among them: the ledger lets one coin
  // be both, and a wallet whose plain ADA is one big coin needs it for the deposit too.
  const rest = csl.TransactionUnspentOutputs.new();
  for (const u of byMostAda(csl, utxos)) rest.add(u);
  let tx: Transaction;
  try {
    // The script data hash before the change, so the fee the change is cut from counts its 32
    // bytes; and again after, because the factory's redeemer index is its place among ALL the
    // inputs, known only once the opener's coins are in. Same size, so the fee still holds.
    tb.calc_script_data_hash(costModels(csl, plutus));
    tb.add_inputs_from_and_change(rest, csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset, csl.ChangeConfig.new(cslAddress(csl, plan.opener)));
    tb.calc_script_data_hash(costModels(csl, plutus));
    tx = tb.build_tx();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // CSL's coin selection says "Insufficient input" when the wallet is short; anything else is not about money.
    if (/insufficient/i.test(why)) throw new OpenPoolBuildError('This wallet does not hold enough for both coins, the opening fee, the pool’s own 4.5 ADA, the network fee and its change.');
    throw new OpenPoolBuildError(`The pool opening could not be built (${why.slice(0, 160)}).`);
  }
  const fixed = csl.FixedTransaction.from_bytes(tx.to_bytes());
  return { txHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex(), layout, collateral };
}

export interface CheckedOpenPool {
  txHash: string;
  /** What leaves the wallet for good: both coins, the pool's 4.5 ADA, the new factory entry's ADA, the fee, the network fee. */
  paidLovelace: bigint;
  paidToken: bigint;
  openerLp: bigint;
  openingFee: bigint;
  /** ADA the new factory entry keeps, for good, beyond what the old entry held. */
  factoryLovelace: bigint;
  networkFee: bigint;
  /** Of the network fee, a leftover too small to come back as change (0 when it is only rounding). */
  networkFeeExcess: bigint;
  collateralPledged: bigint;
}

export type OpenPoolCheck = { ok: true; open: CheckedOpenPool } | { ok: false; problems: string[] };

function refKey(i: { transaction_id(): { to_hex(): string }; index(): number }) {
  return `${i.transaction_id().to_hex()}#${i.index()}`;
}

/**
 * Reads the pool-opening transaction back out of its bytes and refuses it unless it is exactly
 * the plan: our scripts, our setting, our pool address, the fee to the treasury at the
 * setting's amount, and nothing paid anywhere else.
 */
export function checkOpenPoolTx(
  csl: Csl,
  dep: OwnPools,
  txHex: string,
  plan: OpenPoolPlan,
  walletUtxos: WalletUtxo[],
  params: ProtocolParams,
  plutus: PlutusParams,
): OpenPoolCheck {
  const problems: string[] = [];
  let tx;
  let layout: OpenPoolLayout;
  try {
    tx = csl.FixedTransaction.from_hex(txHex);
    layout = openPoolLayout(csl, dep, params, plan);
  } catch {
    return { ok: false, problems: ['the transaction or its plan is not readable'] };
  }
  const body = csl.TransactionBody.from_bytes(tx.raw_body());

  if (body.certs()) problems.push('it carries a certificate (it could move your stake or vote)');
  if (body.withdrawals()) problems.push('it withdraws rewards');
  if (body.required_signers()) problems.push('it asks for extra signers');
  if (body.voting_procedures() || body.voting_proposals()) problems.push('it votes or proposes');
  if (body.donation() || body.current_treasury_value()) problems.push('it pays Cardano’s treasury');
  if (body.auxiliary_data_hash() || tx.raw_auxiliary_data()) problems.push('it carries metadata');
  if (body.validity_start_interval_bignum()) problems.push('it sets a start time');
  const net = body.network_id();
  if (net && net.kind() !== csl.NetworkIdKind.Mainnet) problems.push('it is for another network');
  const ttl = body.ttl_bignum();
  if (!ttl || Number(ttl.to_str()) !== plan.tipSlot + TTL_SLOTS) problems.push('its expiry is not the planned one');

  // Inputs: the wallet's own coins and exactly the one factory entry.
  const own = new Map(walletUtxos.map((u) => [`${u.txHash}#${u.index}`, u]));
  const factoryKey = `${plan.factory.utxo.txHash}#${plan.factory.utxo.index}`;
  const signers = new Set<string>();
  let walletIn = csl.Value.zero();
  let factorySeen = 0;
  const inputs = body.inputs();
  for (let i = 0; i < inputs.len(); i++) {
    const k = refKey(inputs.get(i));
    if (k === factoryKey) {
      factorySeen++;
      continue;
    }
    const u = own.get(k);
    if (!u) {
      problems.push('it spends a coin that is not in this wallet');
      continue;
    }
    const o = csl.TransactionUnspentOutput.from_hex(u.hex).output();
    walletIn = walletIn.checked_add(o.amount());
    signers.add(outputAddressHex(o).slice(2, 58));
  }
  if (factorySeen !== 1) problems.push('it does not spend the factory entry exactly once');

  // Reference inputs: our setting and our two scripts, and nothing else.
  const refs = body.reference_inputs();
  const want = new Set([`${plan.setting.txHash}#${plan.setting.index}`, `${dep.factoryRef.txHash}#${dep.factoryRef.index}`, `${dep.authenRef.txHash}#${dep.authenRef.index}`]);
  const got = new Set(Array.from({ length: refs?.len() ?? 0 }, (_, i) => refKey(refs!.get(i))));
  if (got.size !== want.size || [...want].some((k) => !got.has(k))) problems.push('it reads other contracts than the venue’s setting and scripts');

  // The pledge: the wallet's own plain ADA, all but the network's share coming back to it.
  const col = body.collateral();
  const colTotal = body.total_collateral();
  const colReturn = body.collateral_return();
  let pledged = 0n;
  if (!col || col.len() !== 1 || !colTotal || !colReturn) problems.push('its pledge is not one coin with its return');
  else {
    const u = own.get(refKey(col.get(0)));
    const o = u ? csl.TransactionUnspentOutput.from_hex(u.hex).output() : null;
    if (!o || o.amount().multiasset()) problems.push('its pledge is not a plain ADA coin of this wallet');
    pledged = BigInt(colTotal.to_str());
    if (pledged > collateralTotal(plutus)) problems.push('it pledges more than the network asks');
    if (outputAddressHex(colReturn) !== plan.opener.hex || colReturn.amount().multiasset() || colReturn.has_plutus_data() || colReturn.has_script_ref()) problems.push('its pledge does not come back to you');
    if (o && BigInt(o.amount().coin().to_str()) !== pledged + BigInt(colReturn.amount().coin().to_str())) problems.push('its pledge does not add up');
    if (o) signers.add(outputAddressHex(o).slice(2, 58));
  }

  // The mint: exactly the factory NFT, the pool NFT and the whole LP supply, under our policy.
  const mint = body.mint();
  const minted: { policy: string; name: string; q: bigint }[] = [];
  if (mint) {
    const ps = mint.keys();
    for (let i = 0; i < ps.len(); i++) {
      const list = mint.get(ps.get(i));
      for (let j = 0; j < (list?.len() ?? 0); j++) {
        const assets = list!.get(j)!;
        const names = assets.keys();
        for (let k = 0; k < names.len(); k++) minted.push({ policy: ps.get(i).to_hex(), name: bytesToHex(names.get(k).name()), q: BigInt(assets.get(names.get(k))!.to_str()) });
      }
    }
  }
  const wantMint = [[FACTORY_NFT_NAME, 1n], [MINSWAP_V2.poolNftName, 1n], [layout.lpName, MAX_LP_SUPPLY]] as const;
  if (minted.length !== 3 || !wantMint.every(([n, q]) => minted.filter((m) => m.policy === dep.authenPolicy && m.name === n && m.q === q).length === 1)) {
    problems.push('it mints something other than the new pool’s tokens');
  }

  // Outputs, by position.
  const outs = body.outputs();
  const at = (i: number) => (outs.len() > i ? outs.get(i) : null);
  const exact = (i: number, addressHex: string, lovelace: bigint, tokens: readonly TokenAmount[], datumHex: string | null, what: string) => {
    const o = at(i);
    if (!o) return problems.push(`${what} is missing`);
    if (outputAddressHex(o) !== addressHex) problems.push(`${what} is not paid to ${what === 'the opening fee' ? 'the venue’s treasury' : 'its planned address'}`);
    if (BigInt(o.amount().coin().to_str()) !== lovelace || !sameTokens(tokenEntries(o.amount()), tokens)) problems.push(`${what} is not the planned amount`);
    if (o.has_data_hash() || o.has_script_ref()) problems.push(`${what} carries a datum hash or a script`);
    if (datumHex === null ? o.has_plutus_data() : o.plutus_data()?.to_hex() !== datumHex) problems.push(`${what}’s terms are not the planned ones`);
  };
  exact(0, layout.pool.address.hex, layout.pool.lovelace, layout.pool.tokens, layout.pool.datumHex, 'the pool');
  const fnft = [{ asset: { policyId: dep.authenPolicy, assetName: FACTORY_NFT_NAME }, quantity: 1n }];
  layout.factoryOuts.forEach((f, i) => exact(1 + i, f.addressHex, f.lovelace, fnft, f.datumHex, 'a factory entry'));
  exact(3, layout.fee.address.hex, layout.fee.lovelace, [], null, 'the opening fee');
  exact(4, layout.lpOut.address.hex, layout.lpOut.lovelace, layout.lpOut.tokens, null, 'your LP tokens');
  let changeOut = csl.Value.zero();
  for (let i = 5; i < outs.len(); i++) {
    const c = outs.get(i);
    if (outputAddressHex(c) !== plan.opener.hex) problems.push('a payment goes to an address that is not yours');
    if (c.has_plutus_data() || c.has_data_hash() || c.has_script_ref()) problems.push('your change carries a datum or a script');
    changeOut = changeOut.checked_add(c.amount());
  }

  // The witnesses: no signature yet, no script carried, exactly our two redeemers at our budget.
  const ws: TransactionWitnessSet = tx.witness_set();
  if (ws.vkeys() || ws.native_scripts() || ws.plutus_scripts() || ws.plutus_data() || ws.bootstraps()) problems.push('it arrived already signed or carrying scripts');
  const rs = ws.redeemers();
  const sortedInputs = Array.from({ length: inputs.len() }, (_, i) => refKey(inputs.get(i))).sort((x, y) => {
    const [hx, ix] = x.split('#');
    const [hy, iy] = y.split('#');
    return hx! < hy! ? -1 : hx! > hy! ? 1 : Number(ix) - Number(iy);
  });
  const spendIx = BigInt(sortedInputs.indexOf(factoryKey));
  const red = Array.from({ length: rs?.len() ?? 0 }, (_, i) => rs!.get(i));
  const is = (r: (typeof red)[number], tag: number, ix: bigint, dataHex: string, b: { mem: bigint; steps: bigint }) =>
    r.tag().kind() === tag && BigInt(r.index().to_str()) === ix && r.data().to_hex() === dataHex && BigInt(r.ex_units().mem().to_str()) === b.mem && BigInt(r.ex_units().steps().to_str()) === b.steps;
  const spendOk = red.filter((r) => is(r, csl.RedeemerTagKind.Spend, spendIx, factoryRedeemerHex(csl, plan), dep.openPoolBudget.factory)).length === 1;
  const mintOk = red.filter((r) => is(r, csl.RedeemerTagKind.Mint, 0n, createPoolRedeemerHex(csl), dep.openPoolBudget.authen)).length === 1;
  if (red.length !== 2 || !spendOk || !mintOk) problems.push('its script instructions are not the planned ones');
  const sdh = body.script_data_hash();
  if (!rs || !sdh || sdh.to_hex() !== csl.hash_script_data(rs, costModels(csl, plutus)).to_hex()) problems.push('its script data does not match its own instructions');

  // The network fee: under the cap, and at least what its size and its scripts call for.
  const networkFee = BigInt(body.fee().to_str());
  if (networkFee > MAX_OPEN_NETWORK_FEE) problems.push('the network fee is above 2 ADA');
  const signedSize = BigInt(tx.to_bytes().length + WITNESS_SET_OVERHEAD + VKEY_WITNESS_BYTES * Math.max(1, signers.size));
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const scriptFee =
    ceil((dep.openPoolBudget.factory.mem + dep.openPoolBudget.authen.mem) * plutus.priceMem.n, plutus.priceMem.d) +
    ceil((dep.openPoolBudget.factory.steps + dep.openPoolBudget.authen.steps) * plutus.priceSteps.n, plutus.priceSteps.d);
  // The two reference scripts are priced by their size too (Conway; ours are far under the 25 KiB tier).
  const refScriptFee = BigInt(params.minFeeRefScriptCostPerByte) * BigInt(dep.factoryRef.scriptSize + dep.authenRef.scriptSize);
  const minFee = params.txFeePerByte * signedSize + params.txFeeFixed + scriptFee + refScriptFee;
  if (networkFee < minFee - 1_000n) problems.push('the network fee is below what the network accepts');
  const networkFeeExcess = networkFee - minFee > 20_000n ? networkFee - minFee : 0n;

  // Conservation: the wallet's coins, the factory entry and the mint are the outputs and the fee.
  const factoryValue = valueOf(csl, plan.factory.utxo.lovelace, plan.factory.utxo.assets.map((x) => ({ asset: { policyId: x.policyId, assetName: x.assetName }, quantity: x.quantity })));
  const mintValue = valueOf(csl, 0n, wantMint.map(([n, q]) => ({ asset: { policyId: dep.authenPolicy, assetName: n }, quantity: q })));
  const totalIn = walletIn.checked_add(factoryValue).checked_add(mintValue);
  let totalOut = csl.Value.new(body.fee());
  for (let i = 0; i < outs.len(); i++) totalOut = totalOut.checked_add(outs.get(i).amount());
  if (totalIn.compare(totalOut) !== 0) problems.push('what it spends does not add up to what it pays');

  if (problems.length > 0) return { ok: false, problems };
  const lpBack = layout.lpOut.lovelace;
  const changeLovelace = BigInt(changeOut.coin().to_str());
  const changeToken = tokenEntries(changeOut).find((t) => t.policyId === plan.token.policyId && t.assetName === plan.token.assetName)?.quantity ?? 0n;
  const walletToken = tokenEntries(walletIn).find((t) => t.policyId === plan.token.policyId && t.assetName === plan.token.assetName)?.quantity ?? 0n;
  return {
    ok: true,
    open: {
      txHash: tx.transaction_hash().to_hex(),
      paidLovelace: BigInt(walletIn.coin().to_str()) - changeLovelace - lpBack,
      paidToken: walletToken - changeToken,
      openerLp: layout.openerLp,
      openingFee: layout.fee.lovelace,
      factoryLovelace: layout.factoryOuts.reduce((s, f) => s + f.lovelace, 0n) - plan.factory.utxo.lovelace,
      networkFee,
      networkFeeExcess,
      collateralPledged: pledged,
    },
  };
}

export type AssembleOpenResult = { ok: true; signedHex: string; txHash: string } | { ok: false; reason: string };

/**
 * The checked transaction with the wallet's signatures added to ITS witness set (the
 * redeemers stay as checked). Only plain key signatures are taken from the wallet, and the
 * body, its hash and its script data are held unchanged.
 */
export function assembleSignedOpen(csl: Csl, checkedTxHex: string, walletWitnessHex: string, checkedTxHash: string): AssembleOpenResult {
  let wallet;
  try {
    wallet = csl.TransactionWitnessSet.from_hex(walletWitnessHex);
  } catch {
    return { ok: false, reason: 'The wallet answered with something that is not a signature.' };
  }
  const keys = wallet.vkeys();
  if (!keys || keys.len() === 0) return { ok: false, reason: 'The wallet did not sign.' };
  if (wallet.native_scripts() || wallet.plutus_scripts() || wallet.plutus_data() || wallet.redeemers() || wallet.bootstraps()) {
    return { ok: false, reason: 'The wallet added something besides its signature.' };
  }
  const tx = csl.FixedTransaction.from_hex(checkedTxHex);
  const ws = tx.witness_set();
  const redeemersBefore = ws.redeemers()?.to_hex() ?? null;
  ws.set_vkeys(keys);
  tx.set_witness_set(ws.to_bytes());
  const txHash = tx.transaction_hash().to_hex();
  if (txHash !== checkedTxHash) return { ok: false, reason: 'The signed transaction is not the one that was checked.' };
  if ((tx.witness_set().redeemers()?.to_hex() ?? null) !== redeemersBefore) return { ok: false, reason: 'The signed transaction’s script instructions changed.' };
  return { ok: true, signedHex: tx.to_hex(), txHash };
}
