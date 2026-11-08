// Our pools' deploy, in Minswap V2's order (docs/CARDANO_AUDIT_SCOPE.md section 4): the lock
// token (both owner keys sign), then DexInitialization (the authen seed spent, the factory and
// GlobalSetting NFTs minted), then the reference scripts, one per transaction, chained, to an
// address no key can spend (Minswap's own: payment key hash 28 zero bytes), then the batching and
// expired-cancel reward accounts registered with the LEGACY certificate (README "Run it": Conway's
// needs a Publish purpose the scripts refuse). Pure: chain reads and signing are scripts/deploy.ts's.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { builderConfig, type ProtocolParams } from './build.ts';
import { mkBytes, mkConstr, mkInt, mkList, type PlutusData } from './plutus.ts';
import { decodeAddress, decodeGlobalSetting } from './types.ts';
import { checkTreasury } from './sweep.ts';

export const NAMES = { factory: '4d5346', pool: '4d5350', globalSetting: '4d534753', lock: '726f6c652d74696d656c6f636b' };
/** Minswap's reference-script address: payment key hash 28 zero bytes (here without a stake part). */
export const burnAddress = (network: number) => CSL.EnterpriseAddress.new(network, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('00'.repeat(28)))).to_address().to_bech32(undefined);
/** The scripts published as reference scripts, in Minswap's order, then ours. */
export const REF_ORDER = ['order', 'expiredOrderCancel', 'factory', 'authen', 'pool', 'poolBatching', 'lock'] as const;
export type ScriptName = (typeof REF_ORDER)[number] | 'globalSetting';
export type Scripts = Record<ScriptName, { hash: string; compiledCode: string }>;

export interface DeployInputs {
  network: number;
  /** "txhash#index": spent by DexInitialization; fixes the authen policy and every hash after it. */
  seedTxIn: string;
  /** "txhash#index": spent by the lock token's mint. */
  lockSeedTxIn: string;
  ownerA: string;
  ownerB: string;
  batcherKeyHash: string;
  treasury: string;
  /** The treasury's spend (and stake) scripts' hashes, as the batcher's sweep reads them. */
  treasuryScript: string;
  treasuryStakeScript?: string;
  poolStake: { type: 'Key' | 'Script'; hash: string };
  openingFee: bigint;
}

const HASH = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#\d{1,4}$/;

/** Every input, checked before anything is compiled or built. */
export function checkInputs(i: DeployInputs): void {
  if (i.network !== 0 && i.network !== 1) throw new Error('network must be 0 (preprod) or 1 (mainnet)');
  for (const [k, v] of Object.entries({ seedTxIn: i.seedTxIn, lockSeedTxIn: i.lockSeedTxIn })) if (!REF.test(v)) throw new Error(`${k} is not "txhash#index"`);
  if (i.seedTxIn === i.lockSeedTxIn) throw new Error('the authen seed and the lock seed must be two different UTxOs');
  for (const [k, v] of Object.entries({ ownerA: i.ownerA, ownerB: i.ownerB, batcherKeyHash: i.batcherKeyHash, poolStake: i.poolStake.hash })) if (!HASH.test(v)) throw new Error(`${k} is not a 28-byte hash`);
  if (i.ownerA === i.ownerB) throw new Error('the lock needs two different owner keys');
  if (i.batcherKeyHash === i.ownerA || i.batcherKeyHash === i.ownerB) throw new Error("the batcher's hot key must not be an owner key");
  if (i.poolStake.type !== 'Key' && i.poolStake.type !== 'Script') throw new Error('poolStake.type must be Key or Script');
  if (i.openingFee < 0n) throw new Error('the opening fee cannot be negative');
  // The same rules the batcher's sweep holds the treasury to: two-key scripts on both parts.
  checkTreasury({ address: i.treasury, script: i.treasuryScript, stakeScript: i.treasuryStakeScript }, i.network, i.batcherKeyHash);
}

export function plutusAddress(bech32: string): PlutusData {
  const a = CSL.Address.from_bech32(bech32);
  const cred = (c: CSL.Credential) => (c.kind() === CSL.CredKind.Key ? mkConstr(0, [mkBytes(c.to_keyhash()!.to_hex())]) : mkConstr(1, [mkBytes(c.to_scripthash()!.to_hex())]));
  const base = CSL.BaseAddress.from_address(a);
  if (base) return mkConstr(0, [cred(base.payment_cred()), mkConstr(0, [mkConstr(0, [cred(base.stake_cred())])])]);
  const ent = CSL.EnterpriseAddress.from_address(a);
  if (ent) return mkConstr(0, [cred(ent.payment_cred()), mkConstr(1, [])]);
  throw new Error(`${bech32}: only a base or enterprise address can be named`);
}

/** The first GlobalSetting: our batcher; the five roles = PAMSpendScript(lock); the opening fee to the treasury. */
export function globalSetting(i: DeployInputs, lockHash: string): PlutusData {
  const spendScript = mkConstr(1, [mkBytes(lockHash)]);
  return mkConstr(0, [mkList([mkConstr(0, [mkBytes(i.batcherKeyHash)])]), spendScript, spendScript, spendScript, spendScript, spendScript, mkInt(i.openingFee), plutusAddress(i.treasury)]);
}

/**
 * DexInitialization checks neither field the patch added, so the deploy does: the setting it is
 * about to lock in pays exactly `openingFee` to exactly the lock's treasury, read back the way
 * the batcher reads it.
 */
export function assertSetting(d: PlutusData, i: DeployInputs, lockHash: string): void {
  const gs = decodeGlobalSetting(d, 'ours');
  if (gs.batchers.length !== 1 || gs.batchers[0]!.kind !== 'signature' || gs.batchers[0]!.hash !== i.batcherKeyHash) throw new Error('the setting does not name exactly our batcher key');
  if (gs.poolCreation?.fee !== i.openingFee) throw new Error(`the setting's opening fee is ${gs.poolCreation?.fee}, not ${i.openingFee}`);
  const want = decodeAddress(plutusAddress(i.treasury), 'treasury');
  if (JSON.stringify(gs.poolCreation.receiver) !== JSON.stringify(want)) throw new Error("the setting's opening-fee receiver is not the lock's treasury");
  const roles = CSL.PlutusData.from_hex(d.to_hex()).as_constr_plutus_data()!.data();
  for (let k = 1; k <= 5; k++) if (roles.get(k).to_hex() !== mkConstr(1, [mkBytes(lockHash)]).to_hex()) throw new Error(`role ${k} is not the lock`);
}

/** Minswap's empty linked list: head #"00", tail #"ff" x 32 then #"00". */
export const factoryDatum = (): PlutusData => mkConstr(0, [mkBytes('00'), mkBytes(`${'ff'.repeat(32)}00`)]);
/** The lock with nothing announced. */
export const lockState = (): PlutusData => mkConstr(0, [mkList([])]);
/** AuthenRedeemer: DexInitialization is its first constructor. */
export const dexInitialization = (): PlutusData => mkConstr(0, []);

export const scriptOf = (s: { compiledCode: string }) => CSL.PlutusScript.new_v2(Buffer.from(s.compiledCode, 'hex'));
export const scriptAddress = (network: number, hash: string, stake?: CSL.Credential) => {
  const pay = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(hash));
  return (stake ? CSL.BaseAddress.new(network, pay, stake).to_address() : CSL.EnterpriseAddress.new(network, pay).to_address()).to_bech32(undefined);
};
export const rewardAddress = (network: number, hash: string) => CSL.RewardAddress.new(network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(hash))).to_address().to_bech32(undefined);
const stakeCred = (s: DeployInputs['poolStake']) => (s.type === 'Key' ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(s.hash)) : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(s.hash)));

/** Every address the deploy makes or names. */
export function addresses(i: DeployInputs, s: Scripts) {
  return {
    globalSetting: scriptAddress(i.network, s.authen.hash),
    factory: scriptAddress(i.network, s.factory.hash),
    order: scriptAddress(i.network, s.order.hash),
    pool: scriptAddress(i.network, s.pool.hash, stakeCred(i.poolStake)),
    lock: scriptAddress(i.network, s.lock.hash),
    poolBatchingReward: rewardAddress(i.network, s.poolBatching.hash),
    expiredOrderCancelReward: rewardAddress(i.network, s.expiredOrderCancel.hash),
    references: burnAddress(i.network),
  };
}

export interface Utxo {
  ref: string;
  address: string;
  lovelace: bigint;
}

export interface Built {
  txHex: string;
  txId: string;
  fee: bigint;
  /** "txid#index" of each output the deploy keeps track of. */
  outputs: Record<string, string>;
  /** The lovelace each new output holds, by name (what the deploy locks up). */
  locked: Record<string, bigint>;
}

export interface TxPlan {
  pp: ProtocolParams;
  /** Key-locked UTxOs at `change`, spent whole: fees, min-ADA and collateral come from them. */
  funds: Utxo[];
  change: string;
  network: number;
  /** Evaluated budgets by "<Tag>:<index>" (Ogmios), or none for the first build. */
  budgets?: Map<string, { mem: bigint; steps: bigint }>;
}

const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const parseRef = (r: string) => {
  const [id, ix] = r.split('#') as [string, string];
  return CSL.TransactionInput.new(CSL.TransactionHash.from_hex(id), Number(ix));
};
const DRAFT = { mem: 14_000_000n, steps: 10_000_000_000n };

function costModels(pp: ProtocolParams): CSL.Costmdls {
  const all = CSL.Costmdls.new();
  const cm = CSL.CostModel.new();
  pp.costModelPlutusV2.forEach((v, k) => cm.set(k, v >= 0 ? CSL.Int.new(big(v)) : CSL.Int.new_negative(big(-v))));
  all.insert(CSL.Language.new_plutus_v2(), cm);
  return all;
}

interface Spec {
  mint?: { script: { hash: string; compiledCode: string }; names: string[]; redeemer: PlutusData };
  outputs: { name: string; address: string; asset?: { policy: string; name: string }; datum?: PlutusData; scriptRef?: { compiledCode: string } }[];
  requiredSigners?: string[];
  certs?: string[];
  /** Must be spent (a seed). */
  spend?: string;
}

function output(o: Spec['outputs'][number], pp: ProtocolParams): CSL.TransactionOutput {
  let b = CSL.TransactionOutputBuilder.new().with_address(CSL.Address.from_bech32(o.address));
  if (o.datum) b = b.with_plutus_data(o.datum);
  if (o.scriptRef) b = b.with_script_ref(CSL.ScriptRef.new_plutus_script(scriptOf(o.scriptRef)));
  const ma = CSL.MultiAsset.new();
  if (o.asset) {
    const a = CSL.Assets.new();
    a.insert(CSL.AssetName.new(Buffer.from(o.asset.name, 'hex')), big(1));
    ma.insert(CSL.ScriptHash.from_hex(o.asset.policy), a);
  }
  return b.next().with_asset_and_min_required_coin_by_utxo_cost(ma, CSL.DataCost.new_coins_per_byte(big(pp.utxoCostPerByte))).build();
}

function build(spec: Spec, plan: TxPlan): Built {
  const { pp } = plan;
  const tb = CSL.TransactionBuilder.new(builderConfig(pp));
  const ins = CSL.TxInputsBuilder.new();
  if (spec.spend && !plan.funds.some((u) => u.ref === spec.spend)) throw new Error(`the seed ${spec.spend} is not among the funding UTxOs: it must sit at the deployer's address, unspent`);
  for (const u of plan.funds) ins.add_regular_input(CSL.Address.from_bech32(u.address), parseRef(u.ref), CSL.Value.new(big(u.lovelace)));
  tb.set_inputs(ins);
  const outs = spec.outputs.map((o) => output(o, pp));
  for (const o of outs) tb.add_output(o);
  const isPlutus = !!spec.mint;
  if (spec.mint) {
    const m = spec.mint;
    const script = scriptOf(m.script);
    if (script.hash().to_hex() !== m.script.hash) throw new Error(`the minting script hashes to ${script.hash().to_hex()}, not ${m.script.hash}`);
    const u = plan.budgets?.get('Mint:0') ?? DRAFT;
    const mb = CSL.MintBuilder.new();
    for (const name of m.names) {
      const w = CSL.MintWitness.new_plutus_script(CSL.PlutusScriptSource.new(script), CSL.Redeemer.new(CSL.RedeemerTag.new_mint(), big(0), m.redeemer, CSL.ExUnits.new(big(u.mem), big(u.steps))));
      mb.add_asset(w, CSL.AssetName.new(Buffer.from(name, 'hex')), CSL.Int.new_i32(1));
    }
    tb.set_mint_builder(mb);
    // Collateral: the largest funding UTxO, its whole value returned but 5 ADA (fees here stay far below 3.3 ADA).
    const c = [...plan.funds].sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1))[0]!;
    const cb = CSL.TxInputsBuilder.new();
    cb.add_regular_input(CSL.Address.from_bech32(c.address), parseRef(c.ref), CSL.Value.new(big(c.lovelace)));
    tb.set_collateral(cb);
    tb.set_total_collateral_and_return(big(5_000_000), CSL.Address.from_bech32(plan.change));
  }
  for (const h of spec.requiredSigners ?? []) tb.add_required_signer(CSL.Ed25519KeyHash.from_hex(h));
  if (spec.certs?.length) {
    const cb = CSL.CertificatesBuilder.new();
    for (const h of spec.certs) cb.add(CSL.Certificate.new_stake_registration(CSL.StakeRegistration.new(CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(h)))));
    tb.set_certs_builder(cb);
  }
  if (isPlutus) tb.calc_script_data_hash(costModels(pp));
  tb.add_change_if_needed(CSL.Address.from_bech32(plan.change));
  const tx = tb.build_tx();
  const txHex = tx.to_hex();
  const txId = CSL.FixedTransaction.from_hex(txHex).transaction_hash().to_hex();
  const body = tx.body();
  const outputs: Record<string, string> = {};
  const locked: Record<string, bigint> = {};
  spec.outputs.forEach((o, k) => {
    outputs[o.name] = `${txId}#${k}`;
    locked[o.name] = BigInt(body.outputs().get(k).amount().coin().to_str());
  });
  const changeIx = body.outputs().len() - 1;
  if (changeIx >= spec.outputs.length) outputs.change = `${txId}#${changeIx}`;
  for (const h of spec.certs ?? []) locked[`deposit:${h}`] = BigInt(pp.stakeAddressDeposit);
  return { txHex, txId, fee: BigInt(body.fee().to_str()), outputs, locked };
}

/** 1. The lock token, minted into the lock with nothing announced. Both owner keys sign. */
export function lockTx(i: DeployInputs, s: Scripts, plan: TxPlan): Built {
  const a = addresses(i, s);
  return build(
    {
      spend: i.lockSeedTxIn,
      mint: { script: s.lock, names: [NAMES.lock], redeemer: mkConstr(0, []) },
      outputs: [{ name: 'lock', address: a.lock, asset: { policy: s.lock.hash, name: NAMES.lock }, datum: lockState() }],
      requiredSigners: [i.ownerA, i.ownerB],
    },
    plan,
  );
}

/** 2. DexInitialization: the authen seed spent, the factory and GlobalSetting NFTs minted. */
export function initTx(i: DeployInputs, s: Scripts, plan: TxPlan): Built {
  const a = addresses(i, s);
  const gs = globalSetting(i, s.lock.hash);
  assertSetting(gs, i, s.lock.hash);
  return build(
    {
      spend: i.seedTxIn,
      mint: { script: s.authen, names: [NAMES.factory, NAMES.globalSetting], redeemer: dexInitialization() },
      outputs: [
        { name: 'factory', address: a.factory, asset: { policy: s.authen.hash, name: NAMES.factory }, datum: factoryDatum() },
        { name: 'globalSetting', address: a.globalSetting, asset: { policy: s.authen.hash, name: NAMES.globalSetting }, datum: gs },
      ],
    },
    plan,
  );
}

/** 3. One reference script, to the address no key can spend. */
export function refTx(i: DeployInputs, name: (typeof REF_ORDER)[number], s: Scripts, plan: TxPlan): Built {
  return build({ outputs: [{ name, address: burnAddress(i.network), scriptRef: s[name] }] }, plan);
}

/**
 * 4. The pool batching reward account, registered with the legacy certificate. The expired-order
 * script takes no parameters: its hash is Minswap's, and its account is already registered on
 * mainnet and preprod (a second registration is refused), so the deploy checks it instead.
 */
export function registerTx(s: Scripts, plan: TxPlan): Built {
  return build({ outputs: [], certs: [s.poolBatching.hash] }, plan);
}

/** What the batcher's BATCHER_SETTINGS and the site's OwnPoolsDeploymentRecord read. */
export function records(i: DeployInputs, s: Scripts, refs: Record<string, string>, extra: { batcherFee: bigint; openPoolBudget?: { factory: { mem: number; steps: number }; authen: { mem: number; steps: number } }; refSizes: Record<string, number> }) {
  const a = addresses(i, s);
  const batcherAddress = CSL.EnterpriseAddress.new(i.network, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(i.batcherKeyHash))).to_address().to_bech32(undefined);
  return {
    batcherSettings: {
      network: i.network,
      deployment: { authenPolicy: s.authen.hash, poolScriptHash: s.pool.hash, orderScriptHash: s.order.hash, poolBatchingScriptHash: s.poolBatching.hash, scriptRefs: { pool: refs.pool, order: refs.order, poolBatching: refs.poolBatching } },
      batcherKeyHash: i.batcherKeyHash,
      batcherAddress,
      batcherFee: extra.batcherFee.toString(),
      sweep: { treasury: i.treasury, treasuryScript: i.treasuryScript, ...(i.treasuryStakeScript ? { treasuryStakeScript: i.treasuryStakeScript } : {}), keep: '20000000' },
    },
    siteRecord: {
      authenPolicy: s.authen.hash,
      poolScriptHash: s.pool.hash,
      poolBatchingScriptHash: s.poolBatching.hash,
      orderScriptHash: s.order.hash,
      factoryScriptHash: s.factory.hash,
      poolAddress: a.pool,
      factoryRef: { ref: refs.factory, scriptSize: extra.refSizes.factory },
      authenRef: { ref: refs.authen, scriptSize: extra.refSizes.authen },
      treasury: i.treasury,
      openingFeeLovelace: i.openingFee.toString(),
      batcherFeeLovelace: extra.batcherFee.toString(),
      ...(extra.openPoolBudget ? { openPoolBudget: extra.openPoolBudget } : {}),
    },
    addresses: a,
  };
}
