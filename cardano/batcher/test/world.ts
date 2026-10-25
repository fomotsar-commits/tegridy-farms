// A small made-up chain state for OUR compiled contracts (test/fixtures/test-deployment.json):
// the global setting naming a test batcher, the reference scripts, one ADA/TOKEN pool with the
// 1333 fee share and some share already accrued, traders' orders, and the batcher's UTxOs.
// Every hash and key here is made up; nothing exists on any network.
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams, ScriptRef } from '../src/build.ts';
import { MAINNET_TIME } from '../src/chain.ts';
import { mkBytes, mkConstr, mkInt, mkList, type PlutusData } from '../src/plutus.ts';
import type { Utxo } from '../src/plan.ts';
import { lpAssetName, type DexConstants } from '../src/verify.ts';

const deployment = JSON.parse(readFileSync(new URL('./fixtures/test-deployment.json', import.meta.url), 'utf8')) as {
  test: { poolStakeKeyHash: string };
  scripts: Record<'authen' | 'pool' | 'poolBatching' | 'order', { hash: string; compiledCode: string }>;
};
export const PP = JSON.parse(readFileSync(new URL('./fixtures/protocol-params.json', import.meta.url), 'utf8')) as ProtocolParams;
export const NETWORK = 1;
export const S = deployment.scripts;
export const DEX: DexConstants = { authenPolicy: S.authen.hash, poolScriptHash: S.pool.hash, time: MAINNET_TIME };

export const TOKEN = { policyId: '70'.repeat(28), assetName: '544f4b' }; // "TOK"
export const LP_NAME = lpAssetName({ policyId: '', assetName: '' }, TOKEN);
export const BATCHER_KEY = 'ba'.repeat(28);
export const ADMIN_KEY = 'ad'.repeat(28);
export const traderKey = (n: number) => (0x10 + n).toString(16).padStart(2, '0').repeat(28);

const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const keyCred = (h: string) => CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(h));
const scriptCred = (h: string) => CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(h));
export const traderAddress = (n: number) => CSL.BaseAddress.new(NETWORK, keyCred(traderKey(n)), keyCred(traderKey(n))).to_address();
export const BATCHER_ADDRESS = CSL.EnterpriseAddress.new(NETWORK, keyCred(BATCHER_KEY)).to_address();

function value(lovelace: bigint, tokens: [string, string, bigint][] = []): CSL.Value {
  if (!tokens.length) return CSL.Value.new(big(lovelace));
  const ma = CSL.MultiAsset.new();
  for (const [policy, name, q] of tokens) {
    const a = ma.get(CSL.ScriptHash.from_hex(policy)) ?? CSL.Assets.new();
    a.insert(CSL.AssetName.new(Buffer.from(name, 'hex')), big(q));
    ma.insert(CSL.ScriptHash.from_hex(policy), a);
  }
  return CSL.Value.new_with_assets(big(lovelace), ma);
}

function utxo(ref: string, address: CSL.Address, v: CSL.Value, datum?: PlutusData, scriptRef?: CSL.ScriptRef): Utxo {
  const o = CSL.TransactionOutput.new(address, v);
  if (datum) o.set_plutus_data(datum);
  if (scriptRef) o.set_script_ref(scriptRef);
  return { ref, outputHex: o.to_hex() };
}

// ---- Plutus data, as types.ak defines it ----
const TRUE = mkConstr(1, []);
const FALSE = mkConstr(0, []);
const NONE = mkConstr(1, []);
const some = (d: PlutusData) => mkConstr(0, [d]);
const asset = (policy: string, name: string) => mkConstr(0, [mkBytes(policy), mkBytes(name)]);
const keyAddressData = (n: number) => mkConstr(0, [mkConstr(0, [mkBytes(traderKey(n))]), some(mkConstr(0, [mkConstr(0, [mkBytes(traderKey(n))])]))]);
const EOD_NONE = mkConstr(0, []);
export const step = {
  swapIn: (aToB: boolean, amount: bigint, minimum: bigint, killable = true) => mkConstr(0, [aToB ? TRUE : FALSE, mkConstr(0, [mkInt(amount)]), mkInt(minimum), killable ? TRUE : FALSE]),
  swapOut: (aToB: boolean, maxIn: bigint, expected: bigint) => mkConstr(3, [aToB ? TRUE : FALSE, mkConstr(0, [mkInt(maxIn)]), mkInt(expected), TRUE]),
  deposit: (a: bigint, b: bigint, minLp: bigint) => mkConstr(4, [mkConstr(0, [mkInt(a), mkInt(b)]), mkInt(minLp), TRUE]),
  withdraw: (lp: bigint, minA: bigint, minB: bigint) => mkConstr(5, [mkConstr(0, [mkInt(lp)]), mkInt(minA), mkInt(minB), TRUE]),
  zapOut: () => mkConstr(6, [TRUE, mkConstr(0, [mkInt(1n)]), mkInt(1n), TRUE]),
};

export function orderDatum(trader: number, s: PlutusData, maxFee = 2_000_000n): PlutusData {
  return mkConstr(0, [
    mkConstr(0, [mkBytes(traderKey(trader))]), // canceller: OAMSignature
    keyAddressData(trader),
    EOD_NONE,
    keyAddressData(trader),
    EOD_NONE,
    asset(DEX.authenPolicy, LP_NAME),
    s,
    mkInt(maxFee),
    NONE,
  ]);
}

/** An order UTxO at our order script, with the trader's stake key. */
export function order(ref: string, trader: number, lovelace: bigint, tokens: [string, string, bigint][], s: PlutusData, opts: { byHash?: boolean } = {}): { utxo: Utxo; datum: PlutusData } {
  const datum = orderDatum(trader, s);
  const address = CSL.BaseAddress.new(NETWORK, scriptCred(S.order.hash), keyCred(traderKey(trader))).to_address();
  if (!opts.byHash) return { utxo: utxo(ref, address, value(lovelace, tokens), datum), datum };
  const o = CSL.TransactionOutput.new(address, value(lovelace, tokens));
  o.set_data_hash(CSL.hash_plutus_data(datum));
  return { utxo: { ref, outputHex: o.to_hex() }, datum };
}

export const POOL_RESERVE_A = 100_000_000_000n; // 100,000 ADA, as the datum counts it
export const POOL_RESERVE_B = 5_000_000_000_000n; // 5,000,000 TOK (6 decimals)
export const POOL_SHARE_ACCRUED = 1_234_567n; // fee share already held: value reserve A = datum + this
export const TOTAL_LIQUIDITY = 22_360_679_774n;
const MAX_LP = 9_223_372_036_854_775_807n;

export function world() {
  const authen = DEX.authenPolicy;
  const globalSetting = utxo(
    `${'a1'.repeat(32)}#0`,
    CSL.EnterpriseAddress.new(NETWORK, scriptCred(authen)).to_address(),
    value(5_000_000n, [[authen, '4d534753', 1n]]),
    mkConstr(0, [
      mkList([mkConstr(0, [mkBytes(BATCHER_KEY)])]), // batchers: [PAMSignature(batcher)]
      ...Array.from({ length: 5 }, () => mkConstr(0, [mkBytes(ADMIN_KEY)])),
    ]),
  );
  const scriptUtxo = (name: 'pool' | 'order' | 'poolBatching', ix: number): ScriptRef => {
    const plutus = CSL.PlutusScript.new_with_version(Buffer.from(S[name].compiledCode, 'hex'), CSL.Language.new_plutus_v2());
    return {
      utxo: utxo(`${'a2'.repeat(32)}#${ix}`, CSL.EnterpriseAddress.new(NETWORK, keyCred(ADMIN_KEY)).to_address(), value(100_000_000n), undefined, CSL.ScriptRef.new_plutus_script(plutus)),
      hash: S[name].hash,
      size: S[name].compiledCode.length / 2,
    };
  };
  const scripts = { pool: scriptUtxo('pool', 0), order: scriptUtxo('order', 1), poolBatching: scriptUtxo('poolBatching', 2) };
  const poolDatum = mkConstr(0, [
    mkConstr(0, [mkConstr(1, [mkBytes(S.poolBatching.hash)])]), // Inline(ScriptCredential(batching))
    asset('', ''),
    asset(TOKEN.policyId, TOKEN.assetName),
    mkInt(TOTAL_LIQUIDITY),
    mkInt(POOL_RESERVE_A),
    mkInt(POOL_RESERVE_B),
    mkInt(30n),
    mkInt(30n),
    some(mkInt(1333n)),
    FALSE,
  ]);
  const pool = utxo(
    `${'a3'.repeat(32)}#0`,
    CSL.BaseAddress.new(NETWORK, scriptCred(S.pool.hash), keyCred(deployment.test.poolStakeKeyHash)).to_address(),
    value(4_500_000n + POOL_RESERVE_A + POOL_SHARE_ACCRUED, [
      [authen, '4d5350', 1n],
      [TOKEN.policyId, TOKEN.assetName, POOL_RESERVE_B],
      [authen, LP_NAME, MAX_LP - TOTAL_LIQUIDITY],
    ]),
    poolDatum,
  );
  const feeUtxo = utxo(`${'b1'.repeat(32)}#0`, BATCHER_ADDRESS, value(20_000_000n));
  const collateral = utxo(`${'b1'.repeat(32)}#1`, BATCHER_ADDRESS, value(10_000_000n));
  const spent: Record<string, string> = {};
  for (const u of [globalSetting, scripts.pool.utxo, scripts.order.utxo, scripts.poolBatching.utxo, pool, feeUtxo, collateral]) spent[u.ref] = u.outputHex;
  return {
    globalSetting,
    scripts,
    pool,
    batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined), feeUtxos: [feeUtxo], collateral },
    spent,
  };
}

export { TOKEN as TOK };
