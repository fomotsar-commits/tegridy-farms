// The pool and order data the contracts hold, as cardano/minswap-dex-v2/lib/amm_dex_v2/types.ak
// defines them, decoded from Plutus data. Field order and constructor numbers are the contract's.
import { DecodeError, bool, bytes, constr, fieldsOf, int, list, option, type PlutusData } from './plutus.ts';

export interface Asset {
  /** Hex; '' for ADA. */
  policyId: string;
  /** Hex; '' for ADA. */
  assetName: string;
}

export const ADA: Asset = { policyId: '', assetName: '' };
export const isAda = (a: Asset): boolean => a.policyId === '' && a.assetName === '';
export const sameAsset = (a: Asset, b: Asset): boolean => a.policyId === b.policyId && a.assetName === b.assetName;

export type Credential = { kind: 'key' | 'script'; hash: string };
export type StakeCredential =
  | { kind: 'inline'; credential: Credential }
  | { kind: 'pointer'; slot: bigint; txIndex: bigint; certIndex: bigint };
export interface Address {
  payment: Credential;
  stake: StakeCredential | null;
}

/** A stable text key for comparing two addresses exactly. */
export function addressKey(a: Address): string {
  const cred = (c: Credential) => `${c.kind}:${c.hash}`;
  const stake = a.stake === null ? 'none' : a.stake.kind === 'inline' ? `inline:${cred(a.stake.credential)}` : `pointer:${a.stake.slot}.${a.stake.txIndex}.${a.stake.certIndex}`;
  return `${cred(a.payment)}|${stake}`;
}

export type ExtraOrderDatum = { kind: 'none' } | { kind: 'hash'; hash: string } | { kind: 'inline'; hash: string };

export type AmountOption = { kind: 'specific'; amount: bigint } | { kind: 'all'; deducted: bigint };

export type OrderStep =
  | { kind: 'SwapExactIn'; aToB: boolean; swapAmount: AmountOption; minimumReceive: bigint; killable: boolean }
  | { kind: 'SwapExactOut'; aToB: boolean; maximumSwapAmount: AmountOption; expectedReceive: bigint; killable: boolean }
  | { kind: 'Deposit'; amount: { kind: 'specific'; a: bigint; b: bigint } | { kind: 'all'; deductedA: bigint; deductedB: bigint }; minimumLp: bigint; killable: boolean }
  | { kind: 'Withdraw'; lpAmount: AmountOption; minimumA: bigint; minimumB: bigint; killable: boolean }
  /** A type this batcher does not build: never decoded further, never applied. */
  | { kind: 'Unsupported'; name: string };

export interface OrderDatum {
  refundReceiver: Address;
  refundReceiverDatum: ExtraOrderDatum;
  successReceiver: Address;
  successReceiverDatum: ExtraOrderDatum;
  lpAsset: Asset;
  step: OrderStep;
  maxBatcherFee: bigint;
  /** (expired time in POSIX ms, max tip), or null. */
  expiry: { expiredTime: bigint; maxTip: bigint } | null;
}

export interface PoolDatum {
  /** Kept as data: it is copied unchanged into the pool output. */
  batchingStakeCredential: PlutusData;
  assetA: Asset;
  assetB: Asset;
  totalLiquidity: bigint;
  reserveA: bigint;
  reserveB: bigint;
  baseFeeA: bigint;
  baseFeeB: bigint;
  feeSharing: bigint | null;
  allowDynamicFee: boolean;
}

export type AuthorizationMethod = { kind: 'signature' | 'spendScript' | 'withdrawScript'; hash: string };

export interface GlobalSetting {
  batchers: AuthorizationMethod[];
}

export interface PoolBatchingRedeemer {
  batcherIndex: bigint;
  ordersFee: bigint[];
  /** Byte i: the position, among the order inputs in ledger order, of the i-th order to process. */
  inputIndexes: number[];
  poolInputIndexes: number[] | null;
  volFees: (bigint | null)[];
}

const ORDER_STEP_NAMES = ['SwapExactIn', 'StopLoss', 'OCO', 'SwapExactOut', 'Deposit', 'Withdraw', 'ZapOut', 'PartialSwap', 'WithdrawImbalance', 'SwapMultiRouting', 'Donation'];

export function decodeAsset(d: PlutusData, what: string): Asset {
  const [p, n] = fieldsOf(d, 0, 2, what);
  return { policyId: bytes(p!, `${what}.policy_id`), assetName: bytes(n!, `${what}.asset_name`) };
}

function decodeCredential(d: PlutusData, what: string): Credential {
  const c = constr(d, what);
  if (c.fields.length !== 1 || c.alt > 1) throw new DecodeError(`${what} is not a Credential`);
  return { kind: c.alt === 0 ? 'key' : 'script', hash: bytes(c.fields[0]!, `${what}.hash`) };
}

function decodeStakeCredential(d: PlutusData, what: string): StakeCredential {
  const c = constr(d, what);
  if (c.alt === 0 && c.fields.length === 1) return { kind: 'inline', credential: decodeCredential(c.fields[0]!, what) };
  if (c.alt === 1 && c.fields.length === 3) {
    return { kind: 'pointer', slot: int(c.fields[0]!, what), txIndex: int(c.fields[1]!, what), certIndex: int(c.fields[2]!, what) };
  }
  throw new DecodeError(`${what} is not a StakeCredential`);
}

export function decodeAddress(d: PlutusData, what: string): Address {
  const [payment, stake] = fieldsOf(d, 0, 2, what);
  return { payment: decodeCredential(payment!, `${what}.payment`), stake: option(stake!, `${what}.stake`, (s) => decodeStakeCredential(s, `${what}.stake`)) };
}

function decodeExtraOrderDatum(d: PlutusData, what: string): ExtraOrderDatum {
  const c = constr(d, what);
  if (c.alt === 0 && c.fields.length === 0) return { kind: 'none' };
  if (c.alt === 1 && c.fields.length === 1) return { kind: 'hash', hash: bytes(c.fields[0]!, what) };
  if (c.alt === 2 && c.fields.length === 1) return { kind: 'inline', hash: bytes(c.fields[0]!, what) };
  throw new DecodeError(`${what} is not an ExtraOrderDatum`);
}

function decodeAmountOption(d: PlutusData, what: string): AmountOption {
  const c = constr(d, what);
  if (c.fields.length !== 1 || c.alt > 1) throw new DecodeError(`${what} is not an amount option`);
  const n = int(c.fields[0]!, what);
  return c.alt === 0 ? { kind: 'specific', amount: n } : { kind: 'all', deducted: n };
}

function decodeStep(d: PlutusData): OrderStep {
  const c = constr(d, 'step');
  const f = c.fields;
  const need = (n: number) => {
    if (f.length !== n) throw new DecodeError(`step ${ORDER_STEP_NAMES[c.alt] ?? c.alt}: expected ${n} fields, got ${f.length}`);
  };
  switch (c.alt) {
    case 0:
      need(4);
      return { kind: 'SwapExactIn', aToB: bool(f[0]!, 'a_to_b'), swapAmount: decodeAmountOption(f[1]!, 'swap_amount_option'), minimumReceive: int(f[2]!, 'minimum_receive'), killable: bool(f[3]!, 'killable') };
    case 3:
      need(4);
      return { kind: 'SwapExactOut', aToB: bool(f[0]!, 'a_to_b'), maximumSwapAmount: decodeAmountOption(f[1]!, 'maximum_swap_amount_option'), expectedReceive: int(f[2]!, 'expected_receive'), killable: bool(f[3]!, 'killable') };
    case 4: {
      need(3);
      const a = constr(f[0]!, 'deposit_amount_option');
      if (a.fields.length !== 2 || a.alt > 1) throw new DecodeError('deposit_amount_option');
      const x = int(a.fields[0]!, 'deposit a');
      const y = int(a.fields[1]!, 'deposit b');
      return { kind: 'Deposit', amount: a.alt === 0 ? { kind: 'specific', a: x, b: y } : { kind: 'all', deductedA: x, deductedB: y }, minimumLp: int(f[1]!, 'minimum_lp'), killable: bool(f[2]!, 'killable') };
    }
    case 5:
      need(4);
      return { kind: 'Withdraw', lpAmount: decodeAmountOption(f[0]!, 'withdrawal_amount_option'), minimumA: int(f[1]!, 'minimum_asset_a'), minimumB: int(f[2]!, 'minimum_asset_b'), killable: bool(f[3]!, 'killable') };
    default: {
      const name = ORDER_STEP_NAMES[c.alt];
      if (name === undefined) throw new DecodeError(`unknown order step ${c.alt}`);
      return { kind: 'Unsupported', name };
    }
  }
}

export function decodeOrderDatum(d: PlutusData): OrderDatum {
  const f = fieldsOf(d, 0, 9, 'OrderDatum');
  constr(f[0]!, 'canceller'); // read by cancels only; its shape is still checked
  const expiry = option(f[8]!, 'expiry_setting_opt', (e) => {
    // A 2-tuple is encoded as a list of two items.
    const pair = list(e, 'expiry pair');
    if (pair.length !== 2) throw new DecodeError('expiry pair');
    return { expiredTime: int(pair[0]!, 'expired_time'), maxTip: int(pair[1]!, 'max_tip') };
  });
  return {
    refundReceiver: decodeAddress(f[1]!, 'refund_receiver'),
    refundReceiverDatum: decodeExtraOrderDatum(f[2]!, 'refund_receiver_datum'),
    successReceiver: decodeAddress(f[3]!, 'success_receiver'),
    successReceiverDatum: decodeExtraOrderDatum(f[4]!, 'success_receiver_datum'),
    lpAsset: decodeAsset(f[5]!, 'lp_asset'),
    step: decodeStep(f[6]!),
    maxBatcherFee: int(f[7]!, 'max_batcher_fee'),
    expiry,
  };
}

export function decodePoolDatum(d: PlutusData): PoolDatum {
  const f = fieldsOf(d, 0, 10, 'PoolDatum');
  return {
    batchingStakeCredential: f[0]!,
    assetA: decodeAsset(f[1]!, 'asset_a'),
    assetB: decodeAsset(f[2]!, 'asset_b'),
    totalLiquidity: int(f[3]!, 'total_liquidity'),
    reserveA: int(f[4]!, 'reserve_a'),
    reserveB: int(f[5]!, 'reserve_b'),
    baseFeeA: int(f[6]!, 'base_fee_a_numerator'),
    baseFeeB: int(f[7]!, 'base_fee_b_numerator'),
    feeSharing: option(f[8]!, 'fee_sharing_numerator_opt', (x) => int(x, 'fee_sharing')),
    allowDynamicFee: bool(f[9]!, 'allow_dynamic_fee'),
  };
}

function decodeAuthorization(d: PlutusData, what: string): AuthorizationMethod {
  const c = constr(d, what);
  if (c.fields.length !== 1 || c.alt > 2) throw new DecodeError(`${what} is not a PoolAuthorizationMethod`);
  return { kind: (['signature', 'spendScript', 'withdrawScript'] as const)[c.alt]!, hash: bytes(c.fields[0]!, what) };
}

export function decodeGlobalSetting(d: PlutusData): GlobalSetting {
  const f = fieldsOf(d, 0, 6, 'GlobalSetting');
  return { batchers: list(f[0]!, 'batchers').map((b, i) => decodeAuthorization(b, `batchers[${i}]`)) };
}

export function decodeBatchingRedeemer(d: PlutusData): PoolBatchingRedeemer {
  const f = fieldsOf(d, 0, 5, 'PoolBatchingRedeemer');
  const indexes = (hex: string) => [...Buffer.from(hex, 'hex')];
  return {
    batcherIndex: int(f[0]!, 'batcher_index'),
    ordersFee: list(f[1]!, 'orders_fee').map((x) => int(x, 'orders_fee[]')),
    inputIndexes: indexes(bytes(f[2]!, 'input_indexes')),
    poolInputIndexes: option(f[3]!, 'pool_input_indexes_opt', (x) => indexes(bytes(x, 'pool_input_indexes'))),
    volFees: list(f[4]!, 'vol_fees').map((x) => option(x, 'vol_fee', (v) => int(v, 'vol_fee'))),
  };
}
