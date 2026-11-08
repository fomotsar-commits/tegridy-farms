// Changes through the 48-hour role lock (cardano/role-timelock: types.ak, lock.ak): Announce,
// Execute and Cancel of a SetPool or SetGlobalSetting, built unsigned, and read back from their
// own bytes. readLockTx is the one reading: scripts/lock.ts runs it on every transaction it
// builds before writing it, and the co-signing page (cosign/review.ts) shows it to the owner.
// Pure: chain reads, evaluation and the envelope are scripts/lock.ts's. Refused, by name:
//   - an Execute whose lower bound is before ready_at, or whose upper bound is past the window;
//   - an Execute whose pool or GlobalSetting output is not exactly the announced change;
//   - a SetPool whose pool value changes (its earned fee share leaving the pool), or whose fee
//     share could be taken by anyone but the lock (which pays only the treasury);
//   - a pool's stake credential moved unasked (poolChange keeps the pool's own);
//   - a GlobalSetting moving a role off the lock, or the opening fee off the treasury;
//   - any lock, pool or setting on another network than the run's.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { builderConfig, referenceScriptOf, type ExUnits, type ProtocolParams } from './build.ts';
import { ledgerOrder, MAINNET_TIME, plutusSerialise, PREPROD_TIME, refKey, slotToPosixMs, type NetworkTime } from './chain.ts';
import { NAMES, plutusAddress } from './deploy.ts';
import { ledgerMinFee } from './fee.ts';
import { bool, bytes, constr, DecodeError, fieldsOf, int, list, mkBytes, mkConstr, mkInt, mkList, option, type PlutusData } from './plutus.ts';
import type { Utxo } from './plan.ts';
import { lpAssetName } from './verify.ts';
import { decodeAddress, decodeAsset, decodePoolDatum, type Address, type Asset, type AuthorizationMethod, type Credential } from './types.ts';

export class LockRefused extends Error {}

/** lock.ak: 48 hours of notice, then 14 days to make the change; at most 16 announced. */
export const DELAY_MS = 172_800_000n;
export const GRACE_MS = 1_209_600_000n;
export const MAX_ANNOUNCED = 16;
/** A lower bound this far behind the chain's tip: a PC clock about 90 s slow still sees it passed. */
export const SLACK_MS = 120_000n;
/** Minswap's bounds (utils.ak): base fee 5..2000 of 10000, fee share 1333..5000 of 10000. */
export const BASE_FEE = { min: 5n, max: 2000n };
export const FEE_SHARE = { min: 1333n, max: 5000n };

/** The run's deployment, as the lock and Minswap's pool see it. */
export interface LockDeployment {
  network: 0 | 1;
  /** The lock's script hash (also its token's policy). */
  lock: string;
  /** Our authen policy: the pool and GlobalSetting tokens, and the GlobalSetting's script. */
  authen: string;
  /** The pool script's hash. */
  pool: string;
  ownerA: string;
  ownerB: string;
  /** The lock's treasury (bech32): the only fee-share and opening-fee receiver. */
  treasury: string;
}

/** SetPool: the pool trading assetA for assetB, stated as the parameters it leaves. */
export interface PoolChange {
  kind: 'SetPool';
  assetA: Asset;
  assetB: Asset;
  baseFeeA: bigint;
  baseFeeB: bigint;
  feeSharing: bigint | null;
  allowDynamicFee: boolean;
  /** The pool address's stake credential (Inline), or none. */
  stake: Credential | null;
}
/** Minswap V2's GlobalSetting, ours (eight fields). */
export interface Setting {
  batchers: AuthorizationMethod[];
  poolFeeUpdater: AuthorizationMethod;
  feeSharingTaker: AuthorizationMethod;
  poolStakeKeyUpdater: AuthorizationMethod;
  poolDynamicFeeUpdater: AuthorizationMethod;
  admin: AuthorizationMethod;
  openingFee: bigint;
  receiver: Address;
}
export type Change = PoolChange | { kind: 'SetGlobalSetting'; setting: Setting };
export interface Announcement {
  change: Change;
  readyAt: bigint;
}
export type Action = { kind: 'Announce'; announcement: Announcement } | { kind: 'Cancel'; index: number } | { kind: 'Execute'; index: number } | { kind: 'WithdrawFeeSharing' };

export const timeOf = (network: number): NetworkTime => {
  if (network !== 0 && network !== 1) throw new LockRefused(`network ${network} is neither preprod (0) nor mainnet (1)`);
  return network === 1 ? MAINNET_TIME : PREPROD_TIME;
};
const netName = (n: number) => (n === 1 ? 'mainnet' : n === 0 ? 'preprod' : `network ${n}`);
const same = (a: PlutusData, b: PlutusData) => Buffer.from(plutusSerialise(a)).equals(Buffer.from(plutusSerialise(b)));
const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const out = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex);
const fields = (l: CSL.PlutusList) => Array.from({ length: l.len() }, (_, i) => l.get(i));

// ---- Plutus data, as types.ak and Minswap's types.ak define it ----

const encCred = (c: Credential) => mkConstr(c.kind === 'key' ? 0 : 1, [mkBytes(c.hash)]);
const encAsset = (a: Asset) => mkConstr(0, [mkBytes(a.policyId), mkBytes(a.assetName)]);
const encOpt = (x: PlutusData | null) => (x === null ? mkConstr(1, []) : mkConstr(0, [x]));
const encBool = (b: boolean) => mkConstr(b ? 1 : 0, []);
const encAuth = (a: AuthorizationMethod) => mkConstr(['signature', 'spendScript', 'withdrawScript'].indexOf(a.kind), [mkBytes(a.hash)]);
function encAddress(a: Address): PlutusData {
  if (a.stake?.kind === 'pointer') throw new LockRefused('an address with a pointer stake: this tool names none');
  return mkConstr(0, [encCred(a.payment), encOpt(a.stake ? mkConstr(0, [encCred(a.stake.credential)]) : null)]);
}
function decCred(d: PlutusData, what: string): Credential {
  const c = constr(d, what);
  if (c.fields.length !== 1 || c.alt > 1) throw new DecodeError(`${what} is not a Credential`);
  const hash = bytes(c.fields[0]!, what);
  if (hash.length !== 56) throw new DecodeError(`${what} is not 28 bytes`);
  return { kind: c.alt === 0 ? 'key' : 'script', hash };
}
function decAuth(d: PlutusData, what: string): AuthorizationMethod {
  const c = constr(d, what);
  if (c.fields.length !== 1 || c.alt > 2) throw new DecodeError(`${what} is not a PoolAuthorizationMethod`);
  return { kind: (['signature', 'spendScript', 'withdrawScript'] as const)[c.alt]!, hash: bytes(c.fields[0]!, what) };
}
/** Option<StakeCredential>, Inline only. */
function decStake(d: PlutusData, what: string): Credential | null {
  return option(d, what, (s) => {
    const c = constr(s, what);
    if (c.alt !== 0 || c.fields.length !== 1) throw new DecodeError(`${what}: a pointer stake credential, which this tool never states`);
    return decCred(c.fields[0]!, what);
  });
}

export function encodeSetting(s: Setting): PlutusData {
  return mkConstr(0, [mkList(s.batchers.map(encAuth)), encAuth(s.poolFeeUpdater), encAuth(s.feeSharingTaker), encAuth(s.poolStakeKeyUpdater), encAuth(s.poolDynamicFeeUpdater), encAuth(s.admin), mkInt(s.openingFee), encAddress(s.receiver)]);
}
export function decodeSetting(d: PlutusData): Setting {
  const f = fieldsOf(d, 0, 8, 'GlobalSetting');
  return {
    batchers: list(f[0]!, 'batchers').map((b, i) => decAuth(b, `batchers[${i}]`)),
    poolFeeUpdater: decAuth(f[1]!, 'pool_fee_updater'),
    feeSharingTaker: decAuth(f[2]!, 'fee_sharing_taker'),
    poolStakeKeyUpdater: decAuth(f[3]!, 'pool_stake_key_updater'),
    poolDynamicFeeUpdater: decAuth(f[4]!, 'pool_dynamic_fee_updater'),
    admin: decAuth(f[5]!, 'admin'),
    openingFee: int(f[6]!, 'pool_creation_fee'),
    receiver: decodeAddress(f[7]!, 'pool_creation_fee_receiver'),
  };
}

export function encodeChange(c: Change): PlutusData {
  if (c.kind === 'SetGlobalSetting') return mkConstr(0, [encodeSetting(c.setting)]);
  return mkConstr(1, [encAsset(c.assetA), encAsset(c.assetB), mkInt(c.baseFeeA), mkInt(c.baseFeeB), encOpt(c.feeSharing === null ? null : mkInt(c.feeSharing)), encBool(c.allowDynamicFee), encOpt(c.stake ? mkConstr(0, [encCred(c.stake)]) : null)]);
}
export function decodeChange(d: PlutusData): Change {
  const c = constr(d, 'Change');
  if (c.alt === 0 && c.fields.length === 1) return { kind: 'SetGlobalSetting', setting: decodeSetting(c.fields[0]!) };
  if (c.alt !== 1 || c.fields.length !== 7) throw new DecodeError('Change is neither SetGlobalSetting nor SetPool');
  const f = c.fields;
  return {
    kind: 'SetPool',
    assetA: decodeAsset(f[0]!, 'asset_a'),
    assetB: decodeAsset(f[1]!, 'asset_b'),
    baseFeeA: int(f[2]!, 'base_fee_a_numerator'),
    baseFeeB: int(f[3]!, 'base_fee_b_numerator'),
    feeSharing: option(f[4]!, 'fee_sharing_numerator_opt', (x) => int(x, 'fee_sharing')),
    allowDynamicFee: bool(f[5]!, 'allow_dynamic_fee'),
    stake: decStake(f[6]!, 'stake_credential'),
  };
}
export const encodeState = (a: Announcement[]): PlutusData => mkConstr(0, [mkList(a.map((x) => mkConstr(0, [encodeChange(x.change), mkInt(x.readyAt)])))]);
export function decodeState(d: PlutusData): Announcement[] {
  const [l] = fieldsOf(d, 0, 1, 'the lock State');
  return list(l!, 'announced').map((a, i) => {
    const [change, readyAt] = fieldsOf(a, 0, 2, `announcement #${i}`);
    return { change: decodeChange(change!), readyAt: int(readyAt!, 'ready_at') };
  });
}
/** The lock's spend redeemer: Aiken 1.0.24 wraps a multi-validator's spend redeemer, constr 1 [action]. */
export function lockRedeemer(a: Action): PlutusData {
  const action = a.kind === 'Announce' ? mkConstr(0, [mkConstr(0, [encodeChange(a.announcement.change), mkInt(a.announcement.readyAt)])]) : a.kind === 'Cancel' ? mkConstr(1, [mkInt(BigInt(a.index))]) : a.kind === 'Execute' ? mkConstr(2, [mkInt(BigInt(a.index))]) : mkConstr(3, []);
  return mkConstr(1, [action]);
}
export function decodeLockRedeemer(d: PlutusData): Action {
  const [a] = fieldsOf(d, 1, 1, 'the lock redeemer (RedeemerWrapper)');
  const c = constr(a!, 'Action');
  if (c.alt === 0 && c.fields.length === 1) {
    const [change, readyAt] = fieldsOf(c.fields[0]!, 0, 2, 'Announcement');
    return { kind: 'Announce', announcement: { change: decodeChange(change!), readyAt: int(readyAt!, 'ready_at') } };
  }
  const index = () => {
    const n = int(c.fields[0]!, 'index');
    if (n < 0n || n >= BigInt(MAX_ANNOUNCED)) throw new LockRefused(`announcement index ${n} is out of the lock's range`);
    return Number(n);
  };
  if (c.alt === 1 && c.fields.length === 1) return { kind: 'Cancel', index: index() };
  if (c.alt === 2 && c.fields.length === 1) return { kind: 'Execute', index: index() };
  if (c.alt === 3 && c.fields.length === 0) return { kind: 'WithdrawFeeSharing' };
  throw new DecodeError('Action is not Announce, Cancel, Execute or WithdrawFeeSharing');
}
/** Minswap's pool spend redeemer: UpdatePoolParameters { UpdatePoolFee | UpdateDynamicFee | UpdatePoolStakeCredential }. */
const POOL_ACTIONS = ['UpdatePoolFee', 'UpdateDynamicFee', 'UpdatePoolStakeCredential'] as const;
type PoolAction = (typeof POOL_ACTIONS)[number];

// ---- what the chain holds now ----

function onNetwork(a: CSL.Address, network: number, what: string): void {
  if (a.network_id() !== network) throw new LockRefused(`${what} ${a.to_bech32(undefined)} is a ${netName(a.network_id())} address, and this run says ${netName(network)}`);
}
const holds = (o: CSL.TransactionOutput, policy: string, name: string) => BigInt(o.amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(Buffer.from(name, 'hex')))?.to_str() ?? '0') > 0n;
const scriptOf = (o: CSL.TransactionOutput) => o.address().payment_cred()?.to_scripthash()?.to_hex();
function stakeOf(a: CSL.Address): Credential | null {
  const base = CSL.BaseAddress.from_address(a);
  if (base) {
    const s = base.stake_cred();
    return s.kind() === CSL.CredKind.Key ? { kind: 'key', hash: s.to_keyhash()!.to_hex() } : { kind: 'script', hash: s.to_scripthash()!.to_hex() };
  }
  if (CSL.EnterpriseAddress.from_address(a)) return null;
  throw new LockRefused(`${a.to_bech32(undefined)}: a pool address with a pointer stake, which this tool never states`);
}

/** The pool's parameters now, as a SetPool would state them. */
export function poolNow(outputHex: string): PoolChange {
  const o = CSL.TransactionOutput.from_hex(outputHex);
  const d = o.plutus_data();
  if (!d) throw new LockRefused('the pool holds no inline datum');
  const p = decodePoolDatum(d);
  return { kind: 'SetPool', assetA: p.assetA, assetB: p.assetB, baseFeeA: p.baseFeeA, baseFeeB: p.baseFeeB, feeSharing: p.feeSharing, allowDynamicFee: p.allowDynamicFee, stake: stakeOf(o.address()) };
}
/** The GlobalSetting now. */
export function settingNow(outputHex: string): Setting {
  const d = CSL.TransactionOutput.from_hex(outputHex).plutus_data();
  if (!d) throw new LockRefused('the GlobalSetting holds no inline datum');
  return decodeSetting(d);
}

/** Which of the pool's admin paths a change takes: it changes the fees, the dynamic-fee switch or the stake, one at a time. */
function poolAction(before: PoolChange, after: PoolChange): PoolAction {
  const fees = before.baseFeeA !== after.baseFeeA || before.baseFeeB !== after.baseFeeB || before.feeSharing !== after.feeSharing;
  const dynamic = before.allowDynamicFee !== after.allowDynamicFee;
  const stake = JSON.stringify(before.stake) !== JSON.stringify(after.stake);
  if ([fees, dynamic, stake].filter(Boolean).length > 1) throw new LockRefused("the pool's own admin path changes its fees, its dynamic-fee switch or its stake one at a time: announce them apart");
  return dynamic ? 'UpdateDynamicFee' : stake ? 'UpdatePoolStakeCredential' : 'UpdatePoolFee';
}
function checkPoolBounds(c: PoolChange): void {
  for (const f of [c.baseFeeA, c.baseFeeB]) if (f < BASE_FEE.min || f > BASE_FEE.max) throw new LockRefused(`a base fee of ${f}/10000: Minswap's pool takes 5 to 2000`);
  if (c.feeSharing !== null && (c.feeSharing < FEE_SHARE.min || c.feeSharing > FEE_SHARE.max)) throw new LockRefused(`a fee share of ${c.feeSharing}/10000: Minswap's pool takes 1333 to 5000, or off`);
}

export interface PoolAsk {
  /** null turns the venue's share off. */
  feeSharing?: bigint | null;
  baseFee?: [bigint, bigint];
  allowDynamicFee?: boolean;
  /** Moves the pool's stake: only ever when asked. */
  stake?: Credential | null;
}
/** The SetPool the owner asks for: what the pool holds now, with only what is asked changed. */
export function poolChange(now: PoolChange, ask: PoolAsk): PoolChange {
  const c: PoolChange = {
    ...now,
    ...(ask.feeSharing !== undefined ? { feeSharing: ask.feeSharing } : {}),
    ...(ask.baseFee ? { baseFeeA: ask.baseFee[0], baseFeeB: ask.baseFee[1] } : {}),
    ...(ask.allowDynamicFee !== undefined ? { allowDynamicFee: ask.allowDynamicFee } : {}),
    stake: ask.stake !== undefined ? ask.stake : now.stake,
  };
  if (same(encodeChange(c), encodeChange(now))) throw new LockRefused('the change changes nothing: the pool already holds it');
  checkPoolBounds(c);
  poolAction(now, c);
  return c;
}

const isLock = (a: AuthorizationMethod, d: LockDeployment) => a.kind === 'spendScript' && a.hash === d.lock;
const treasuryData = (d: LockDeployment) => plutusAddress(d.treasury);
const ROLES = [
  ['poolFeeUpdater', 'pool-fee updater'],
  ['feeSharingTaker', 'fee-share taker'],
  ['poolStakeKeyUpdater', 'stake-key updater'],
  ['poolDynamicFeeUpdater', 'dynamic-fee updater'],
  ['admin', 'admin'],
] as const;
/** A GlobalSetting the lock may leave: every role the lock, the opening fee to the treasury. */
export function checkSetting(s: Setting, d: LockDeployment): void {
  for (const [k, name] of ROLES) if (!isLock(s[k], d)) throw new LockRefused(`the setting's ${name} is not the lock: a role off the lock is a new deploy, never a lock change`);
  if (!same(encAddress(s.receiver), treasuryData(d))) throw new LockRefused("the setting pays the opening fee to an address that is not the treasury");
  if (s.openingFee < 0n) throw new LockRefused('a negative opening fee');
  if (!s.batchers.length) throw new LockRefused('a setting with no batcher: no pool could ever move');
}
export interface SettingAsk {
  openingFee?: bigint;
  batchers?: AuthorizationMethod[];
}
/** The SetGlobalSetting the owner asks for: the setting now, with only what is asked changed. */
export function settingChange(now: Setting, ask: SettingAsk, d: LockDeployment): Setting {
  const s: Setting = { ...now, ...(ask.openingFee !== undefined ? { openingFee: ask.openingFee } : {}), ...(ask.batchers ? { batchers: ask.batchers } : {}) };
  if (same(encodeSetting(s), encodeSetting(now))) throw new LockRefused('the change changes nothing: the setting already holds it');
  checkSetting(s, d);
  return s;
}
/** The fee share leaves a pool only through the setting's fee-share taker: it must be the lock, which pays only the treasury. */
function checkShareTaker(s: Setting, d: LockDeployment): void {
  if (!isLock(s.feeSharingTaker, d)) throw new LockRefused(`the fee share would be taken by ${s.feeSharingTaker.kind} ${s.feeSharingTaker.hash}, not the lock: only the lock's WithdrawFeeSharing pays the treasury`);
}

/** The Execute must make exactly the announced change. */
export function matchesAnnounced(announced: Change, wanted: Change): void {
  if (!same(encodeChange(announced), encodeChange(wanted))) throw new LockRefused(`the change asked for differs from the announced one: announced ${summary(announced)}; asked ${summary(wanted)}`);
}

// ---- when ----

const floorSlot = (ms: bigint, t: NetworkTime) => t.zeroSlot + (ms - t.zeroTimeMs) / t.slotLengthMs;
export const utc = (ms: bigint) => new Date(Number(ms)).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

/** An Announce's validity: from the slack behind the tip to `validFor` slots on; ready 48 hours after its upper bound. */
export function announceWindow(tipSlot: bigint, network: 0 | 1, validFor: bigint): { start: bigint; ttl: bigint; readyAt: bigint } {
  const t = timeOf(network);
  const ttl = tipSlot + validFor;
  return { start: tipSlot - SLACK_MS / t.slotLengthMs, ttl, readyAt: slotToPosixMs(ttl, t) + DELAY_MS };
}
/**
 * An Execute's validity, from the chain's tip (never this PC's clock): refused until the tip is the
 * slack past ready_at, so the lower bound (at ready_at or later, the slack behind the tip) has
 * passed even for a clock 90 s slow; the upper bound stays inside the 14-day window.
 */
export function executeWindow(tipSlot: bigint, network: 0 | 1, readyAt: bigint, validFor: bigint): { start: bigint; ttl: bigint } {
  const t = timeOf(network);
  const now = slotToPosixMs(tipSlot, t);
  if (now < readyAt + SLACK_MS) throw new LockRefused(`not ready: the chain's time is ${utc(now)}, ready_at ${utc(readyAt)}, and the Execute waits until ${utc(readyAt + SLACK_MS)}`);
  const closes = readyAt + GRACE_MS;
  const ttl = tipSlot + validFor < floorSlot(closes, t) ? tipSlot + validFor : floorSlot(closes, t);
  // At or after ready_at: the tip is the slack past it.
  const start = tipSlot - SLACK_MS / t.slotLengthMs;
  if (ttl <= tipSlot) throw new LockRefused(`the window closed at ${utc(closes)}: cancel the announcement and announce again`);
  return { start, ttl };
}

// ---- building ----

/** The lock's, the pool's and the GlobalSetting's scripts, each as a reference script UTxO. */
export interface LockRefs {
  lockScript: Utxo;
  poolScript?: Utxo;
  settingScript?: Utxo;
}
export interface LockSpec {
  spends: { utxo: Utxo; script: Utxo; redeemer: PlutusData }[];
  reads: Utxo[];
  /** In order: a GlobalSetting output goes first (Minswap reads the head). */
  outputs: CSL.TransactionOutput[];
  signers: string[];
}
export interface LockPlan {
  pp: ProtocolParams;
  /** Plain-ADA UTxOs at `change`: they pay the fee and min-ADA; the largest is pledged as collateral. */
  funds: Utxo[];
  change: string;
  validity: { start: bigint; ttl: bigint };
  /** Measured budgets by "Spend:<index>" (Ogmios), or a generous draft. */
  budgets?: Map<string, ExUnits>;
}
const DRAFT: ExUnits = { mem: 5_000_000n, steps: 2_000_000_000n };

function minAda(o: CSL.TransactionOutput, pp: ProtocolParams): bigint {
  return BigInt(CSL.min_ada_for_output(o, CSL.DataCost.new_coins_per_byte(big(pp.utxoCostPerByte))).to_str());
}
/** `o` holding at least `floor` lovelace and its min-ADA. */
function topped(o: CSL.TransactionOutput, floor: bigint, pp: ProtocolParams): CSL.TransactionOutput {
  const need = minAda(o, pp) > floor ? minAda(o, pp) : floor;
  const v = o.amount();
  const ma = v.multiasset();
  const p = CSL.TransactionOutput.new(o.address(), ma ? CSL.Value.new_with_assets(big(need), ma) : CSL.Value.new(big(need)));
  const d = o.plutus_data();
  if (d) p.set_plutus_data(d);
  return p;
}

/** The lock UTxO: at the lock's address on the run's network, holding its token, its state read. */
function lockInput(d: LockDeployment, lock: Utxo): { o: CSL.TransactionOutput; announced: Announcement[] } {
  const o = out(lock);
  onNetwork(o.address(), d.network, `the lock ${lock.ref} is at`);
  if (scriptOf(o) !== d.lock || !holds(o, d.lock, NAMES.lock)) throw new LockRefused(`${lock.ref} is not the lock: no lock token at the lock's address`);
  const datum = o.plutus_data();
  if (!datum) throw new LockRefused(`the lock ${lock.ref} holds no inline datum`);
  return { o, announced: decodeState(datum) };
}
function lockOutput(d: LockDeployment, o: CSL.TransactionOutput, announced: Announcement[], pp: ProtocolParams): CSL.TransactionOutput {
  const ma = CSL.MultiAsset.new();
  const a = CSL.Assets.new();
  a.insert(CSL.AssetName.new(Buffer.from(NAMES.lock, 'hex')), big(1));
  ma.insert(CSL.ScriptHash.from_hex(d.lock), a);
  const next = CSL.TransactionOutput.new(CSL.EnterpriseAddress.new(d.network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(d.lock))).to_address(), CSL.Value.new_with_assets(big(0), ma));
  next.set_plutus_data(encodeState(announced));
  return topped(next, BigInt(o.amount().coin().to_str()), pp);
}
const remove = <T>(l: T[], i: number) => [...l.slice(0, i), ...l.slice(i + 1)];

/** Announce: the change added to the lock's list, ready no sooner than 48 hours after the upper bound. */
export function announceSpec(d: LockDeployment, refs: LockRefs, lock: Utxo, change: Change, readyAt: bigint, pp: ProtocolParams): LockSpec {
  const { o, announced } = lockInput(d, lock);
  if (announced.length >= MAX_ANNOUNCED) throw new LockRefused(`the lock already holds ${announced.length} announcements, its most (16): cancel one first`);
  if (change.kind === 'SetPool') checkPoolBounds(change);
  else checkSetting(change.setting, d);
  const announcement = { change, readyAt };
  return { spends: [{ utxo: lock, script: refs.lockScript, redeemer: lockRedeemer({ kind: 'Announce', announcement }) }], reads: [], outputs: [lockOutput(d, o, [...announced, announcement], pp)], signers: [d.ownerA, d.ownerB] };
}
/** Cancel: one announcement removed, unmade. */
export function cancelSpec(d: LockDeployment, refs: LockRefs, lock: Utxo, index: number, pp: ProtocolParams): LockSpec {
  const { o, announced } = lockInput(d, lock);
  if (!Number.isInteger(index) || index < 0 || index >= announced.length) throw new LockRefused(`no announcement #${index}: the lock holds ${announced.length}`);
  return { spends: [{ utxo: lock, script: refs.lockScript, redeemer: lockRedeemer({ kind: 'Cancel', index }) }], reads: [], outputs: [lockOutput(d, o, remove(announced, index), pp)], signers: [d.ownerA, d.ownerB] };
}
/**
 * Execute: the announced change made, and removed from the list. A SetPool spends the pool
 * through its own admin path (the pool script by reference, the GlobalSetting read); a
 * SetGlobalSetting spends the GlobalSetting (`target` = `setting` = the GlobalSetting UTxO).
 */
export function executeSpec(d: LockDeployment, refs: LockRefs, lock: Utxo, index: number, target: Utxo, setting: Utxo, pp: ProtocolParams): LockSpec {
  const { o, announced } = lockInput(d, lock);
  const ann = announced[index];
  if (!ann) throw new LockRefused(`no announcement #${index}: the lock holds ${announced.length}`);
  const lockOut = lockOutput(d, o, remove(announced, index), pp);
  const lockSpend = { utxo: lock, script: refs.lockScript, redeemer: lockRedeemer({ kind: 'Execute', index }) };
  const gs = out(setting);
  onNetwork(gs.address(), d.network, `the GlobalSetting ${setting.ref} is at`);
  if (scriptOf(gs) !== d.authen || !holds(gs, d.authen, NAMES.globalSetting)) throw new LockRefused(`${setting.ref} is not our GlobalSetting`);
  const c = ann.change;
  if (c.kind === 'SetPool') {
    if (!refs.poolScript) throw new LockRefused("the pool script's reference UTxO is needed");
    const p = out(target);
    onNetwork(p.address(), d.network, `the pool ${target.ref} is at`);
    if (scriptOf(p) !== d.pool || !holds(p, d.authen, NAMES.pool)) throw new LockRefused(`${target.ref} is not one of our pools`);
    const now = poolNow(target.outputHex);
    if (!same(encAsset(now.assetA), encAsset(c.assetA)) || !same(encAsset(now.assetB), encAsset(c.assetB))) throw new LockRefused(`${target.ref} is not the pool the announcement names`);
    const action = poolAction(now, c);
    if (c.feeSharing !== null) checkShareTaker(settingNow(setting.outputHex), d);
    const f = fields(p.plutus_data()!.as_constr_plutus_data()!.data());
    f[6] = mkInt(c.baseFeeA);
    f[7] = mkInt(c.baseFeeB);
    f[8] = encOpt(c.feeSharing === null ? null : mkInt(c.feeSharing));
    f[9] = encBool(c.allowDynamicFee);
    const pay = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(d.pool));
    const stake = c.stake ? (c.stake.kind === 'key' ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(c.stake.hash)) : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(c.stake.hash))) : null;
    const poolOut = CSL.TransactionOutput.new(stake ? CSL.BaseAddress.new(d.network, pay, stake).to_address() : CSL.EnterpriseAddress.new(d.network, pay).to_address(), p.amount());
    poolOut.set_plutus_data(mkConstr(0, f));
    const poolSpend = { utxo: target, script: refs.poolScript, redeemer: mkConstr(1, [mkConstr(POOL_ACTIONS.indexOf(action), [])]) };
    return { spends: [lockSpend, poolSpend], reads: [setting], outputs: [lockOut, poolOut], signers: [d.ownerA, d.ownerB] };
  }
  if (!refs.settingScript) throw new LockRefused("the GlobalSetting script's reference UTxO is needed");
  if (target.ref !== setting.ref) throw new LockRefused('a SetGlobalSetting spends the GlobalSetting itself');
  checkSetting(c.setting, d);
  const next = CSL.TransactionOutput.new(gs.address(), gs.amount());
  next.set_plutus_data(encodeSetting(c.setting));
  const gsSpend = { utxo: setting, script: refs.settingScript, redeemer: mkConstr(1, [mkConstr(0, [])]) };
  return { spends: [lockSpend, gsSpend], reads: [], outputs: [topped(next, BigInt(gs.amount().coin().to_str()), pp), lockOut], signers: [d.ownerA, d.ownerB] };
}

const parseRef = (r: string) => {
  const [id, ix] = r.split('#') as [string, string];
  return CSL.TransactionInput.new(CSL.TransactionHash.from_hex(id), Number(ix));
};
const cmpRef = (x: string, y: string) => {
  const [hx, ix] = x.split('#') as [string, string];
  const [hy, iy] = y.split('#') as [string, string];
  return hx < hy ? -1 : hx > hy ? 1 : Number(ix) - Number(iy);
};
function costModels(pp: ProtocolParams): CSL.Costmdls {
  const all = CSL.Costmdls.new();
  const cm = CSL.CostModel.new();
  pp.costModelPlutusV2.forEach((v, k) => cm.set(k, v >= 0 ? CSL.Int.new(big(v)) : CSL.Int.new_negative(big(-v))));
  all.insert(CSL.Language.new_plutus_v2(), cm);
  return all;
}
function assemble(spec: LockSpec, plan: LockPlan, minFee: bigint): CSL.Transaction {
  const { pp } = plan;
  if (!plan.funds.length) throw new LockRefused('no plain-ADA UTxO to pay the fee from');
  const tb = CSL.TransactionBuilder.new(builderConfig(pp));
  const order = [...spec.spends.map((s) => s.utxo.ref), ...plan.funds.map((u) => u.ref)].sort(cmpRef);
  const ins = CSL.TxInputsBuilder.new();
  for (const s of spec.spends) {
    const ix = order.indexOf(s.utxo.ref);
    const b = plan.budgets?.get(`Spend:${ix}`) ?? DRAFT;
    const r = referenceScriptOf(s.script);
    const source = CSL.PlutusScriptSource.new_ref_input(CSL.ScriptHash.from_hex(r.hash), parseRef(s.script.ref), r.language, r.size);
    const red = CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(ix), s.redeemer, CSL.ExUnits.new(big(b.mem), big(b.steps)));
    ins.add_plutus_script_input(CSL.PlutusWitness.new_with_ref_without_datum(source, red), parseRef(s.utxo.ref), out(s.utxo).amount());
  }
  for (const u of plan.funds) ins.add_regular_input(out(u).address(), parseRef(u.ref), out(u).amount());
  tb.set_inputs(ins);
  for (const r of spec.reads) tb.add_reference_input(parseRef(r.ref));
  for (const o of spec.outputs) tb.add_output(o);
  for (const h of spec.signers) tb.add_required_signer(CSL.Ed25519KeyHash.from_hex(h));
  tb.set_validity_start_interval_bignum(big(plan.validity.start));
  if (plan.validity.ttl > 0n) tb.set_ttl_bignum(big(plan.validity.ttl));
  const c = [...plan.funds].sort((x, y) => (BigInt(out(x).amount().coin().to_str()) > BigInt(out(y).amount().coin().to_str()) ? -1 : 1))[0]!;
  const cb = CSL.TxInputsBuilder.new();
  cb.add_regular_input(out(c).address(), parseRef(c.ref), out(c).amount());
  tb.set_collateral(cb);
  tb.set_total_collateral_and_return(big(5_000_000n), CSL.Address.from_bech32(plan.change));
  tb.calc_script_data_hash(costModels(pp));
  if (minFee > 0n) tb.set_min_fee(big(minFee));
  tb.add_change_if_needed(CSL.Address.from_bech32(plan.change));
  return tb.build_tx();
}
/** The unsigned transaction, its fee raised to the ledger's own formula (reference scripts counted). */
export function lockTx(spec: LockSpec, plan: LockPlan): { txHex: string; txId: string; fee: bigint } {
  const known: Record<string, string> = {};
  for (const u of [...spec.spends.flatMap((s) => [s.utxo, s.script]), ...spec.reads, ...plan.funds]) known[u.ref] = u.outputHex;
  let floor = 0n;
  for (let pass = 0; pass < 4; pass++) {
    const tx = assemble(spec, plan, floor);
    const fee = BigInt(tx.body().fee().to_str());
    const min = ledgerMinFee(tx.to_hex(), known, plan.pp);
    if (fee >= min) return { txHex: tx.to_hex(), txId: CSL.FixedTransaction.from_hex(tx.to_hex()).transaction_hash().to_hex(), fee };
    floor = min;
  }
  throw new LockRefused('the fee did not settle');
}

// ---- words ----

const hexText = (hex: string) => {
  const s = Buffer.from(hex, 'hex').toString('utf8');
  return /^[\x20-\x7e]+$/.test(s) ? s : undefined;
};
const assetWords = (a: Asset) => (a.policyId === '' ? 'ADA' : `${hexText(a.assetName) ?? 'token'} (${a.policyId}.${a.assetName})`);
const credWords = (c: Credential | null) => (c ? `${c.kind} ${c.hash}` : 'none');
const shareWords = (s: bigint | null) => (s === null ? 'off' : `${s}/10000 of the trade fee`);
const pct = (n: bigint) => `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}%`;
const feeWords = (a: bigint, b: bigint) => `${a}/${b} (${a === b ? `${pct(a)} each way` : `${pct(a)} selling A, ${pct(b)} selling B`})`;
const adaWords = (l: bigint) => `${l / 1_000_000n}${l % 1_000_000n ? `.${(l % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')}` : ''} ADA`;
const authWords = (a: AuthorizationMethod, d?: LockDeployment) => (d && isLock(a, d) ? 'the lock' : `${a.kind} ${a.hash}`);
const line = (name: string, before: string | undefined, after: string) => (before === undefined ? `${name}: ${after}` : before === after ? `${name}: ${after}, unchanged` : `${name}: ${before} → ${after}`);

/** One line naming a change. */
export function summary(c: Change): string {
  if (c.kind === 'SetPool') return `pool ${assetWords(c.assetA)} / ${assetWords(c.assetB)}: venue share ${shareWords(c.feeSharing)}; base fee ${feeWords(c.baseFeeA, c.baseFeeB)}; dynamic fee ${c.allowDynamicFee ? 'on' : 'off'}; stake ${credWords(c.stake)}`;
  return `GlobalSetting: opening fee ${adaWords(c.setting.openingFee)}; ${c.setting.batchers.length} batcher(s)`;
}
/** What a change does, line by line, against what the chain holds before it (when known). */
export function changeWords(c: Change, before: PoolChange | Setting | null, d: LockDeployment): string[] {
  if (c.kind === 'SetPool') {
    const b = before as PoolChange | null;
    const stake = !b ? `stake: ${credWords(c.stake)}` : JSON.stringify(b.stake) === JSON.stringify(c.stake) ? `stake: kept, ${credWords(c.stake)}` : `stake: MOVES from ${credWords(b.stake)} to ${credWords(c.stake)}`;
    return [
      `pool ${assetWords(c.assetA)} / ${assetWords(c.assetB)}${b ? '' : ' (not read from the chain: its values now are not shown)'}`,
      line('venue share', b ? shareWords(b.feeSharing) : undefined, shareWords(c.feeSharing)),
      line('base fee', b ? feeWords(b.baseFeeA, b.baseFeeB) : undefined, feeWords(c.baseFeeA, c.baseFeeB)),
      line('dynamic fee', b ? (b.allowDynamicFee ? 'on' : 'off') : undefined, c.allowDynamicFee ? 'on' : 'off'),
      stake,
    ];
  }
  const b = before as Setting | null;
  const s = c.setting;
  const batchers = (x: Setting) => x.batchers.map((a) => authWords(a)).join(', ');
  return [
    `GlobalSetting${b ? '' : ' (not read from the chain: its values now are not shown)'}`,
    line('opening fee', b ? `${adaWords(b.openingFee)}` : undefined, `${adaWords(s.openingFee)}`) + (same(encAddress(s.receiver), treasuryData(d)) ? ', paid to the treasury' : ', paid to an address that is NOT the treasury'),
    line('batchers', b ? batchers(b) : undefined, batchers(s)),
    ...ROLES.map(([k, name]) => line(name, b ? authWords(b[k], d) : undefined, authWords(s[k], d))),
  ];
}

// ---- reading a lock transaction from its own bytes ----

const lpOf = (c: Change) => (c.kind === 'SetPool' ? { lp: lpAssetName(c.assetA, c.assetB) } : {});

export interface LockReading {
  action: 'Announce' | 'Cancel' | 'Execute';
  index: number;
  /** The change added, removed or made, in plain words. */
  words: string[];
  /** When the change can run, in UTC. */
  when: string;
  readyAt: string;
  closesAt: string;
  /** The lock's list after this transaction. */
  announced: { summary: string; readyAt: string }[];
  /** A SetPool's pool, by its LP token's name (the page reads the pool now by it); a SetGlobalSetting's none. */
  lp?: string;
}

/**
 * A lock transaction read from its bytes and the outputs it spends and reads (`output`):
 * undefined when nothing it spends is the lock. Every rule of lock.ak is checked again, and the
 * money rules above; `current` gives the pool's and the setting's outputs now (for an Announce
 * or a Cancel, which touch neither), to say what the change changes.
 */
export function readLockTx(txHex: string, output: (ref: string) => string | undefined, d: LockDeployment, current: { pool?: string; setting?: string } = {}): LockReading | undefined {
  const t = timeOf(d.network);
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const body = tx.body();
  const outOf = (i: CSL.TransactionInput) => {
    const h = output(refKey(i));
    if (!h) throw new LockRefused(`${refKey(i)} cannot be read: the reading needs every output the transaction spends and reads`);
    return CSL.TransactionOutput.from_hex(h);
  };
  const ins = ledgerOrder(body.inputs());
  const spent = ins.map((i, ix) => ({ i, o: outOf(i), ix }));
  const at = spent.filter((s) => scriptOf(s.o) === d.lock);
  if (!at.length) return undefined;
  if (at.length > 1) throw new LockRefused('the transaction spends two UTxOs at the lock: only the one holding its token is the lock');
  const lockIn = at[0]!;
  onNetwork(lockIn.o.address(), d.network, 'the lock is at');
  if (!holds(lockIn.o, d.lock, NAMES.lock)) throw new LockRefused('the UTxO spent at the lock does not hold its token: it is not the lock');
  const before = decodeState(lockIn.o.plutus_data() ?? (() => { throw new LockRefused('the lock holds no inline datum'); })());
  if (body.mint()?.len() || body.withdrawals()?.len() || body.certs()?.len()) throw new LockRefused('a lock transaction mints, withdraws or certifies nothing');

  const rs = tx.witness_set().redeemers();
  const redeemerOf = (ix: number) => {
    for (let k = 0; k < (rs?.len() ?? 0); k++) {
      const r = rs!.get(k);
      if (r.tag().kind() === CSL.RedeemerTagKind.Spend && Number(r.index().to_str()) === ix) return r.data();
    }
    throw new LockRefused(`no spend redeemer for input #${ix}`);
  };
  const action = decodeLockRedeemer(redeemerOf(lockIn.ix));
  if (action.kind === 'WithdrawFeeSharing') throw new LockRefused('a fee-share withdrawal: this tool reads Announce, Execute and Cancel only');

  const signers = Array.from({ length: body.required_signers()?.len() ?? 0 }, (_, i) => body.required_signers()!.get(i).to_hex());
  if (!signers.includes(d.ownerA) || !signers.includes(d.ownerB)) throw new LockRefused('the lock needs both owners as required signers: the transaction names fewer');

  const outs = Array.from({ length: body.outputs().len() }, (_, i) => body.outputs().get(i));
  for (const [k, o] of outs.entries()) onNetwork(o.address(), d.network, `output #${k} pays`);
  const lockOuts = outs.filter((o) => holds(o, d.lock, NAMES.lock));
  if (lockOuts.length !== 1) throw new LockRefused(`${lockOuts.length} outputs hold the lock token, not one`);
  const lockOut = lockOuts[0]!;
  const lockAddress = CSL.EnterpriseAddress.new(d.network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(d.lock))).to_address().to_bech32(undefined);
  if (lockOut.address().to_bech32(undefined) !== lockAddress) throw new LockRefused("the lock token leaves the lock's address");
  const ma = lockOut.amount().multiasset();
  if (ma?.len() !== 1 || ma.get(CSL.ScriptHash.from_hex(d.lock))?.len() !== 1 || lockOut.has_script_ref()) throw new LockRefused('the lock output holds more than its token, or a script');
  const afterDatum = lockOut.plutus_data();
  if (!afterDatum) throw new LockRefused('the lock output holds no inline datum');
  const after = decodeState(afterDatum);

  const moved = spent.filter((s) => holds(s.o, d.authen, NAMES.pool) || holds(s.o, d.authen, NAMES.globalSetting));
  const start = body.validity_start_interval_bignum();
  const ttl = body.ttl_bignum();
  const lower = start ? slotToPosixMs(BigInt(start.to_str()), t) : undefined;
  const upper = ttl ? slotToPosixMs(BigInt(ttl.to_str()), t) : undefined;
  const sameList = (x: Announcement[], y: Announcement[]) => same(encodeState(x), encodeState(y));
  const listAfter = after.map((a) => ({ summary: summary(a.change), readyAt: utc(a.readyAt) }));
  const beforeOf = (c: Change): PoolChange | Setting | null => {
    if (c.kind === 'SetPool') {
      if (!current.pool) return null;
      const p = poolNow(current.pool);
      if (!same(encAsset(p.assetA), encAsset(c.assetA)) || !same(encAsset(p.assetB), encAsset(c.assetB))) return null;
      return p;
    }
    return current.setting ? settingNow(current.setting) : null;
  };
  /** The rules an announced change must meet, wherever it is read. */
  const checkChange = (c: Change) => {
    if (c.kind === 'SetPool') {
      checkPoolBounds(c);
      if (c.feeSharing !== null && current.setting) checkShareTaker(settingNow(current.setting), d);
      const b = beforeOf(c);
      if (b) poolAction(b as PoolChange, c);
    } else checkSetting(c.setting, d);
  };

  if (action.kind === 'Announce') {
    const ann = action.announcement;
    if (moved.length) throw new LockRefused('an Announce moves no pool and no GlobalSetting');
    if (lower === undefined || upper === undefined) throw new LockRefused('an Announce needs both ends of its validity range set');
    if (ann.readyAt < upper + DELAY_MS) throw new LockRefused(`ready_at ${utc(ann.readyAt)} is less than 48 hours after the transaction's upper bound ${utc(upper)}`);
    if (before.length >= MAX_ANNOUNCED) throw new LockRefused('the lock already holds 16 announcements');
    if (!sameList(after, [...before, ann])) throw new LockRefused("the lock's new list is not its old one with this announcement added");
    checkChange(ann.change);
    return {
      action: 'Announce',
      ...lpOf(ann.change),
      index: before.length,
      words: [`announces #${before.length}:`, ...changeWords(ann.change, beforeOf(ann.change), d)],
      when: `can run from ${utc(ann.readyAt)} until ${utc(ann.readyAt + GRACE_MS)}, by an Execute both owners sign`,
      readyAt: utc(ann.readyAt),
      closesAt: utc(ann.readyAt + GRACE_MS),
      announced: listAfter,
    };
  }
  const ann = before[action.index];
  if (!ann) throw new LockRefused(`no announcement #${action.index}: the lock holds ${before.length}`);
  if (!sameList(after, remove(before, action.index))) throw new LockRefused(`the lock's new list is not its old one with #${action.index} removed`);
  const common = { ...lpOf(ann.change), index: action.index, readyAt: utc(ann.readyAt), closesAt: utc(ann.readyAt + GRACE_MS), announced: listAfter };
  if (action.kind === 'Cancel') {
    if (moved.length) throw new LockRefused('a Cancel moves no pool and no GlobalSetting');
    return { action: 'Cancel', ...common, words: [`removes announcement #${action.index}, unmade:`, ...changeWords(ann.change, beforeOf(ann.change), d)], when: `it could have run from ${utc(ann.readyAt)} until ${utc(ann.readyAt + GRACE_MS)}` };
  }

  if (lower === undefined || upper === undefined) throw new LockRefused('an Execute needs both ends of its validity range set');
  if (lower < ann.readyAt) throw new LockRefused(`the Execute could run before ready_at: its lower bound is ${utc(lower)}, ready_at ${utc(ann.readyAt)}`);
  if (upper > ann.readyAt + GRACE_MS) throw new LockRefused(`the Execute's upper bound ${utc(upper)} is past the window, which closes ${utc(ann.readyAt + GRACE_MS)}`);
  if (moved.length !== 1) throw new LockRefused(`an Execute moves exactly one pool or GlobalSetting; this one moves ${moved.length}`);
  const m = moved[0]!;
  const c = ann.change;
  let words: string[];
  if (c.kind === 'SetPool') {
    if (scriptOf(m.o) !== d.pool || !holds(m.o, d.authen, NAMES.pool)) throw new LockRefused('the Execute moves no pool of ours');
    const poolOuts = outs.filter((o) => holds(o, d.authen, NAMES.pool));
    if (poolOuts.length !== 1) throw new LockRefused(`${poolOuts.length} outputs hold the pool token, not one`);
    const po = poolOuts[0]!;
    if (scriptOf(po) !== d.pool) throw new LockRefused("the pool token leaves the pool's script");
    if (po.amount().to_hex() !== m.o.amount().to_hex()) throw new LockRefused("the pool's value changes: its earned fee share would leave the pool, and only the lock's WithdrawFeeSharing, paying the treasury, may take it");
    const was = poolNow(m.o.to_hex());
    const now = poolNow(po.to_hex());
    if (!same(encodeChange(now), encodeChange(c))) throw new LockRefused(`the pool after differs from the announced change: announced ${summary(c)}; the output holds ${summary(now)}`);
    const a = decodePoolDatum(m.o.plutus_data()!);
    const b = decodePoolDatum(po.plutus_data()!);
    if (!same(a.batchingStakeCredential, b.batchingStakeCredential) || a.totalLiquidity !== b.totalLiquidity || a.reserveA !== b.reserveA || a.reserveB !== b.reserveB) throw new LockRefused("the pool's reserves, liquidity or batching credential change");
    const pr = constr(redeemerOf(m.ix), 'the pool redeemer');
    const want = poolAction(was, c);
    if (pr.alt !== 1 || pr.fields.length !== 1 || constr(pr.fields[0]!, 'UpdatePoolParametersAction').alt !== POOL_ACTIONS.indexOf(want)) throw new LockRefused(`the pool is spent other than by ${want}`);
    const reads = ledgerOrder(body.reference_inputs()).map(outOf).filter((o) => holds(o, d.authen, NAMES.globalSetting));
    if (reads.length !== 1 || scriptOf(reads[0]!) !== d.authen) throw new LockRefused('the Execute reads no GlobalSetting of ours');
    if (c.feeSharing !== null) checkShareTaker(settingNow(reads[0]!.to_hex()), d);
    checkPoolBounds(c);
    words = [`makes announcement #${action.index}:`, ...changeWords(c, was, d)];
  } else {
    if (scriptOf(m.o) !== d.authen || !holds(m.o, d.authen, NAMES.globalSetting)) throw new LockRefused('the Execute moves no GlobalSetting of ours');
    const first = outs[0]!;
    if (!holds(first, d.authen, NAMES.globalSetting) || scriptOf(first) !== d.authen) throw new LockRefused('the new GlobalSetting must be output #0 (Minswap reads the head)');
    const fd = first.plutus_data();
    if (!fd || !same(fd, encodeSetting(c.setting))) throw new LockRefused('the GlobalSetting after differs from the announced change');
    checkSetting(c.setting, d);
    words = [`makes announcement #${action.index}:`, ...changeWords(c, settingNow(m.o.to_hex()), d)];
  }
  return { action: 'Execute', ...common, words, when: `makes it now: valid from ${utc(lower)} until ${utc(upper)} (ready_at ${utc(ann.readyAt)}, the window closes ${utc(ann.readyAt + GRACE_MS)})` };
}
