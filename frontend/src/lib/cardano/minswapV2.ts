// Minswap V2 on Cardano mainnet: the pool and order formats this rail reads and writes.
//
// SOURCE. Every constant and every field order below is copied from Minswap's own audited
// code at minswap-dex-v2 main @ c3293ad43 (2024-07-10, the commit CertiK's re-audit covers):
// deployed/mainnet/script.json for the addresses and lib/amm_dex_v2/types.ak for the datums,
// with the MIT @minswap/sdk for how an order is built (src/dex-v2.ts createBulkOrdersTx).
// minswapV2.test.ts holds each one against real mainnet transactions, byte for byte.
//
// WHY MINSWAP V2. The owner's rule is never-hacked code (owner, 2026-10-24: Minswap V1's 2022
// critical, found and fixed before anyone used it, does not count as a hack). Minswap V2 is the
// largest Cardano DEX, audited by CertiK and Anastasia Labs, with no exploit on record.
//
// HOW A SWAP WORKS HERE. The trader's transaction does not trade. It locks the coins in an
// ORDER at Minswap's order script, with a datum saying which pool, how much, the least the
// trader accepts, and who is paid. Minswap's batcher then spends the order against the pool a
// few blocks later, and the order script lets it do so only if it pays the datum's receiver
// at least the minimum. So "confirmed" means "order placed", never "swapped" (orderWatch.ts).

import { sha3_256 } from '@noble/hashes/sha3';
import type { PlutusData } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import { bytesToHex, composeAddress, hexToBytes, type Credential, type ParsedAddress } from './address';
import { FEE_DENOMINATOR } from './math';

export const MINSWAP_V2 = {
  /** deployed/mainnet/script.json `orderEnterpriseAddress` (addr1w8p79rpk…), its payment hash. */
  orderScriptHash: 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c',
  /** `poolEnterpriseAddress` (addr1w84q0den…), its payment hash. Every pool sits under it. */
  poolScriptHash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b',
  /** The authen policy: it mints the pool NFT and every pool's LP token (`lpPolicyId`). */
  authenPolicy: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c',
  /** `poolAuthenAsset` name, "MSP". Only the authen policy can mint it, only into a real pool. */
  poolNftName: '4d5350',
  /**
   * The most the batcher may keep per order (`max_batcher_fee`), paid in ADA from the order.
   * The SDK's BATCHER_FEE_DEX_V2 for every step, and what Minswap's own front end writes
   * (2,000,000 in every order read on 2026-10-24). It goes to Minswap's batcher.
   */
  maxBatcherFee: 2_000_000n,
  /**
   * ADA locked in the order on top of the swap and the batcher fee, returned to the trader
   * with the coins bought, so that output can carry them (every output needs ADA on Cardano).
   * Minswap's own orders lock exactly 2 ADA batcher fee + 2 ADA deposit (read on chain).
   */
  orderDeposit: 2_000_000n,
  /** utils.ak bounds on a pool's trading fee, in FEE_DENOMINATOR parts: 0.05% to 20%. */
  minTradingFee: 5n,
  maxTradingFee: 2000n,
  /**
   * deployed/mainnet/references.json `orderTxId`: Minswap's UTxO holding the order script as a
   * reference script, at an address no key can spend. A cancel reads the script from here.
   */
  orderScriptRef: { txHash: 'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776', index: 0 },
  /** That script's size in bytes, which the cancel's network fee is priced by (references.json, and on chain). */
  orderScriptSize: 2659,
} as const;

export interface CardanoAsset {
  /** 28 bytes hex; '' for ADA. */
  policyId: string;
  /** 0 to 32 bytes hex; '' for ADA. */
  assetName: string;
}

export const ADA: CardanoAsset = { policyId: '', assetName: '' };

export function isAda(a: CardanoAsset): boolean {
  return a.policyId === '' && a.assetName === '';
}

/** The asset's full identity: policy id then name, hex. What every comparison uses. */
export function assetUnit(a: CardanoAsset): string {
  return a.policyId + a.assetName;
}

export function sameAsset(a: CardanoAsset, b: CardanoAsset): boolean {
  return a.policyId === b.policyId && a.assetName === b.assetName;
}

/** A well-formed native token id: a 28-byte policy and a name of at most 32 bytes. */
export function isTokenId(a: CardanoAsset): boolean {
  return /^[0-9a-f]{56}$/.test(a.policyId) && /^(?:[0-9a-f]{2}){0,32}$/.test(a.assetName);
}

/** The pool's order of its two assets: ADA first, else by policy-and-name (SDK normalizeAssets). */
export function poolOrder(a: CardanoAsset, b: CardanoAsset): [CardanoAsset, CardanoAsset] {
  if (isAda(a)) return [a, b];
  if (isAda(b)) return [b, a];
  return assetUnit(a) < assetUnit(b) ? [a, b] : [b, a];
}

function sha3Hex(hex: string): string {
  return bytesToHex(sha3_256(hexToBytes(hex)));
}

/**
 * The pool's LP token name: sha3(sha3(A) ++ sha3(B)) over the pool-ordered pair (SDK
 * PoolV2.computeLPAssetName). The pool's own UTxO holds the unminted LP supply, so this name
 * finds the pool on chain without anyone's pool list.
 */
export function lpAssetName(a: CardanoAsset, b: CardanoAsset): string {
  const [x, y] = poolOrder(a, b);
  return sha3Hex(sha3Hex(assetUnit(x)) + sha3Hex(assetUnit(y)));
}

export function lpAsset(a: CardanoAsset, b: CardanoAsset): CardanoAsset {
  return { policyId: MINSWAP_V2.authenPolicy, assetName: lpAssetName(a, b) };
}

/** A UTxO as the chain-data proxy returns it: amounts as decimal strings, never numbers. */
export interface ChainUtxo {
  txHash: string;
  index: number;
  /** The whole address, hex. */
  addressHex: string;
  lovelace: bigint;
  assets: { policyId: string; assetName: string; quantity: bigint }[];
  /** The inline datum's CBOR, hex; null when the output carries none. */
  inlineDatumHex: string | null;
}

export interface PoolState {
  ref: { txHash: string; index: number };
  assetA: CardanoAsset;
  assetB: CardanoAsset;
  lp: CardanoAsset;
  /** The datum's reserves: what the swap maths uses (order_validation.ak). */
  reserveA: bigint;
  reserveB: bigint;
  totalLiquidity: bigint;
  /** Trading fee in FEE_DENOMINATOR parts, charged on the input: A side for A→B, B side for B→A. */
  feeANumerator: bigint;
  feeBNumerator: bigint;
  /** The share of the trading fee Minswap takes for itself, in FEE_DENOMINATOR parts; null when off. */
  feeSharingNumerator: bigint | null;
  /** The batcher may add a volatility fee per batch. This rail does not route to such a pool. */
  allowDynamicFee: boolean;
}

export type PoolRead = { kind: 'pool'; pool: PoolState } | { kind: 'not-a-pool'; reason: string };

function constrOf(d: PlutusData, alternative: number, fields: number): PlutusData[] | null {
  const c = d.as_constr_plutus_data();
  if (!c || c.alternative().to_str() !== String(alternative)) return null;
  const list = c.data();
  if (list.len() !== fields) return null;
  const out: PlutusData[] = [];
  for (let i = 0; i < list.len(); i++) out.push(list.get(i));
  return out;
}

function intOf(d: PlutusData | undefined): bigint | null {
  const i = d?.as_integer();
  if (!i) return null;
  try {
    return BigInt(i.to_str());
  } catch {
    return null;
  }
}

function bytesOf(d: PlutusData | undefined): string | null {
  const b = d?.as_bytes();
  return b ? bytesToHex(b) : null;
}

function boolOf(d: PlutusData | undefined): boolean | null {
  const c = d?.as_constr_plutus_data();
  if (!c || c.data().len() !== 0) return null;
  const alt = c.alternative().to_str();
  return alt === '0' ? false : alt === '1' ? true : null;
}

function assetOf(d: PlutusData | undefined): CardanoAsset | null {
  if (!d) return null;
  const f = constrOf(d, 0, 2);
  if (!f) return null;
  const policyId = bytesOf(f[0]);
  const assetName = bytesOf(f[1]);
  if (policyId === null || assetName === null) return null;
  const a = { policyId, assetName };
  return isAda(a) || isTokenId(a) ? a : null;
}

function quantityOf(u: ChainUtxo, a: CardanoAsset): bigint {
  if (isAda(a)) return u.lovelace;
  return u.assets.filter((x) => x.policyId === a.policyId && x.assetName === a.assetName).reduce((s, x) => s + x.quantity, 0n);
}

/**
 * Reads a UTxO as the Minswap V2 pool for `pair`, or says why it is not one.
 *
 * What makes it the pool, in the order the validator trusts them: it sits at the pool script,
 * it holds exactly one pool NFT (minted only into a real pool), it holds the pair's LP token,
 * and its datum names the pair. A pool that fails any of these is not a pool, whatever
 * anyone's list says.
 */
export function readPool(csl: Csl, u: ChainUtxo, pair: [CardanoAsset, CardanoAsset]): PoolRead {
  const no = (reason: string): PoolRead => ({ kind: 'not-a-pool', reason });
  const header = parseInt(u.addressHex.slice(0, 2), 16);
  const paymentIsScript = (header >> 4) % 2 === 1;
  if (!paymentIsScript || u.addressHex.slice(2, 58) !== MINSWAP_V2.poolScriptHash) return no('not at the Minswap V2 pool script');
  if (quantityOf(u, { policyId: MINSWAP_V2.authenPolicy, assetName: MINSWAP_V2.poolNftName }) !== 1n) return no('no pool NFT');
  const [want0, want1] = poolOrder(pair[0], pair[1]);
  const lp = lpAsset(want0, want1);
  if (quantityOf(u, lp) <= 0n) return no("does not hold this pair's LP token");
  if (u.inlineDatumHex === null) return no('no datum');
  let datum: PlutusData;
  try {
    datum = csl.PlutusData.from_hex(u.inlineDatumHex);
  } catch {
    return no('datum is not Plutus data');
  }
  const f = constrOf(datum, 0, 10);
  if (!f) return no('datum is not a pool datum');
  const assetA = assetOf(f[1]);
  const assetB = assetOf(f[2]);
  const totalLiquidity = intOf(f[3]);
  const reserveA = intOf(f[4]);
  const reserveB = intOf(f[5]);
  const feeANumerator = intOf(f[6]);
  const feeBNumerator = intOf(f[7]);
  const allowDynamicFee = boolOf(f[9]);
  if (!assetA || !assetB || totalLiquidity === null || reserveA === null || reserveB === null) return no('datum fields unreadable');
  if (feeANumerator === null || feeBNumerator === null || allowDynamicFee === null) return no('datum fee fields unreadable');
  if (!sameAsset(assetA, want0) || !sameAsset(assetB, want1)) return no('datum names another pair');
  // fee_sharing_numerator_opt: Some(n) = Constr 0 [n], None = Constr 1 [].
  let feeSharingNumerator: bigint | null = null;
  const fsOpt = f[8];
  const some = fsOpt ? constrOf(fsOpt, 0, 1) : null;
  if (some) {
    feeSharingNumerator = intOf(some[0]);
    if (feeSharingNumerator === null) return no('fee sharing unreadable');
  } else if (!fsOpt || !constrOf(fsOpt, 1, 0)) {
    return no('fee sharing unreadable');
  }
  const inRange = (n: bigint) => n >= MINSWAP_V2.minTradingFee && n <= MINSWAP_V2.maxTradingFee;
  if (!inRange(feeANumerator) || !inRange(feeBNumerator)) return no('trading fee outside what the validator allows');
  if (reserveA <= 0n || reserveB <= 0n || totalLiquidity <= 0n) return no('an empty pool');
  // The value must hold at least what the datum says the LPs own (the rest is fee sharing and,
  // on the ADA side, the pool's own ADA). A datum claiming more than the value holds is wrong.
  if (quantityOf(u, assetA) < reserveA || quantityOf(u, assetB) < reserveB) return no('datum reserves exceed what the pool holds');
  return {
    kind: 'pool',
    pool: {
      ref: { txHash: u.txHash, index: u.index },
      assetA,
      assetB,
      lp,
      reserveA,
      reserveB,
      totalLiquidity,
      feeANumerator,
      feeBNumerator,
      feeSharingNumerator,
      allowDynamicFee,
    },
  };
}

/** The pool's fee on an input of `assetIn`, in FEE_DENOMINATOR parts. */
export function tradingFeeFor(pool: PoolState, assetIn: CardanoAsset): bigint {
  return sameAsset(assetIn, pool.assetA) ? pool.feeANumerator : pool.feeBNumerator;
}

/** The fee as a percent string, e.g. 100 → "1%", 30 → "0.3%". */
export function feePercentText(numerator: bigint): string {
  const pct = Number(numerator) / Number(FEE_DENOMINATOR / 100n);
  return `${Number(pct.toFixed(3))}%`;
}

/** The order's address: Minswap's order script, with the trader's own stake part (SDK buildOrderAddress). */
export function orderAddressFor(trader: ParsedAddress): ParsedAddress {
  return composeAddress({ kind: 'script', hash: MINSWAP_V2.orderScriptHash }, trader.stake, trader.network);
}

export interface SwapOrderTerms {
  /** The trader: canceller, success receiver and refund receiver, all three. */
  trader: ParsedAddress;
  pool: PoolState;
  assetIn: CardanoAsset;
  swapAmount: bigint;
  minimumReceive: bigint;
}

function credentialData(csl: Csl, c: Credential): PlutusData {
  // types.ak via aiken stdlib: VerificationKeyCredential = Constr 0, ScriptCredential = Constr 1.
  return constr(csl, c.kind === 'key' ? 0 : 1, [csl.PlutusData.new_bytes(hexToBytes(c.hash))]);
}

function constr(csl: Csl, alternative: number, fields: PlutusData[]): PlutusData {
  const list = csl.PlutusList.new();
  for (const f of fields) list.add(f);
  return csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str(String(alternative)), list));
}

function addressData(csl: Csl, a: ParsedAddress): PlutusData {
  // Address { payment_credential, stake_credential: Option<Referenced<Credential>> }:
  // Some(Inline(cred)) = Constr 0 [Constr 0 [cred]], None = Constr 1 [].
  const stake = a.stake ? constr(csl, 0, [constr(csl, 0, [credentialData(csl, a.stake)])]) : constr(csl, 1, []);
  return constr(csl, 0, [credentialData(csl, a.payment), stake]);
}

function int(csl: Csl, n: bigint): PlutusData {
  return csl.PlutusData.new_integer(csl.BigInt.from_str(n.toString()));
}

/**
 * The order's datum (types.ak OrderDatum), for a SwapExactIn with a specific amount.
 *
 * - canceller: the trader's payment key (OAMSignature), so only the trader can cancel.
 * - refund and success receiver: the trader's own whole address, with no extra datum.
 * - killable: TRUE. If the pool has moved past the minimum by the time the batcher reaches the
 *   order, the batcher must return the order (less the batcher fee) instead of leaving it open.
 *   Minswap's own front end writes false and leaves such orders open until cancelled; this
 *   rail never leaves one open on a moved price (an order the batcher skips is cancelTx.ts's).
 * - no expiry setting (None), as Minswap's own front end writes.
 */
export function encodeSwapOrderDatum(csl: Csl, t: SwapOrderTerms): string {
  if (t.trader.payment.kind !== 'key') throw new Error('A script wallet cannot sign an order cancel here.');
  if (t.swapAmount <= 0n || t.minimumReceive <= 0n) throw new Error('An order needs a positive amount and minimum.');
  const aToB = sameAsset(t.assetIn, t.pool.assetA);
  if (!aToB && !sameAsset(t.assetIn, t.pool.assetB)) throw new Error('The coin paid in is not in this pool.');
  const noDatum = constr(csl, 0, []); // EODNoDatum
  const step = constr(csl, 0, [
    constr(csl, aToB ? 1 : 0, []), // a_to_b_direction: Bool
    constr(csl, 0, [int(csl, t.swapAmount)]), // SAOSpecificAmount
    int(csl, t.minimumReceive),
    constr(csl, 1, []), // killable: True
  ]);
  const datum = constr(csl, 0, [
    constr(csl, 0, [csl.PlutusData.new_bytes(hexToBytes(t.trader.payment.hash))]), // OAMSignature
    addressData(csl, t.trader), // refund_receiver
    noDatum,
    addressData(csl, t.trader), // success_receiver
    noDatum,
    constr(csl, 0, [csl.PlutusData.new_bytes(hexToBytes(t.pool.lp.policyId)), csl.PlutusData.new_bytes(hexToBytes(t.pool.lp.assetName))]),
    step,
    int(csl, MINSWAP_V2.maxBatcherFee),
    constr(csl, 1, []), // expiry_setting_opt: None
  ]);
  return datum.to_hex();
}

/**
 * The spend that hands an order back to its owner. types.ak OrderRedeemer is ApplyOrder,
 * CancelOrderByOwner, CancelExpiredOrderByAnyone, so this is Constr 1 [] (d87a80), as in every
 * owner cancel read on mainnet. order_validator.ak passes it when the datum's canceller
 * authorises the transaction (utils.ak authorize_order_license): OAMSignature(h) when h signs.
 */
export function cancelRedeemer(csl: Csl): PlutusData {
  return constr(csl, 1, []);
}

function credentialOf(d: PlutusData | undefined): Credential | null {
  if (!d) return null;
  for (const [alternative, kind] of [[0, 'key'], [1, 'script']] as const) {
    const f = constrOf(d, alternative, 1);
    const hash = f ? bytesOf(f[0]) : null;
    if (hash !== null) return /^[0-9a-f]{56}$/.test(hash) ? { kind, hash } : null;
  }
  return null;
}

/** An Address as Plutus data (addressData's reverse); null for a pointer stake part or anything malformed. */
function addressOf(d: PlutusData | undefined): { payment: Credential; stake: Credential | null } | null {
  const f = d ? constrOf(d, 0, 2) : null;
  const payment = credentialOf(f?.[0]);
  if (!f || !payment) return null;
  if (constrOf(f[1]!, 1, 0)) return { payment, stake: null };
  const some = constrOf(f[1]!, 0, 1);
  const inline = some ? constrOf(some[0]!, 0, 1) : null;
  const stake = credentialOf(inline?.[0]);
  return stake ? { payment, stake } : null;
}

export interface OrderOwner {
  /** OAMSignature's key hash; null when another method (a script) may cancel. */
  cancellerKeyHash: string | null;
  refundTo: { payment: Credential; stake: Credential | null };
  /** Whether the refund is paid with a datum of its own (anything but EODNoDatum). */
  refundHasDatum: boolean;
}

/** Who may cancel the order and whom its refund pays, read off its datum; null when it is not an order datum. */
export function readOrderOwner(csl: Csl, datumHex: string): OrderOwner | null {
  let datum: PlutusData;
  try {
    datum = csl.PlutusData.from_hex(datumHex);
  } catch {
    return null;
  }
  const f = constrOf(datum, 0, 9);
  const refundTo = f ? addressOf(f[1]) : null;
  if (!f || !refundTo) return null;
  const sig = constrOf(f[0]!, 0, 1);
  const key = sig ? bytesOf(sig[0]) : null;
  return { cancellerKeyHash: key !== null && /^[0-9a-f]{56}$/.test(key) ? key : null, refundTo, refundHasDatum: constrOf(f[2]!, 0, 0) === null };
}

/** What the order locks: the swap, the batcher fee, and the deposit that comes back. */
export function orderValue(t: Pick<SwapOrderTerms, 'assetIn' | 'swapAmount'>): { lovelace: bigint; token: { asset: CardanoAsset; quantity: bigint } | null } {
  const ada = MINSWAP_V2.maxBatcherFee + MINSWAP_V2.orderDeposit;
  return isAda(t.assetIn)
    ? { lovelace: t.swapAmount + ada, token: null }
    : { lovelace: ada, token: { asset: t.assetIn, quantity: t.swapAmount } };
}
