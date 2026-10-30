// The own-pool reads: the factory's list and its gaps, the global setting's opening fee and
// receiver, the script prices, each answered or called unread, never guessed.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlutusData } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { composeAddress } from '../address';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import {
  factorySlotFor,
  readFactoryEntries,
  readGlobalSetting,
  readGlobalSettingDatum,
  readPlutusParams,
  rational,
  receiverIs,
  type FactoryEntry,
} from './chainReads';
import { factoryDatumHex } from './openPoolTx';
import { TEST_RECORD, TEST_TREASURY } from './testWorld.fixture';

let csl: Csl;
let dep: OwnPools;

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error('test record refused');
  dep = r.pools;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

const constr = (alt: number, fs: PlutusData[]) => {
  const l = csl.PlutusList.new();
  for (const f of fs) l.add(f);
  return csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str(String(alt)), l));
};
const bytes = (h: string) => csl.PlutusData.new_bytes(Uint8Array.from(Buffer.from(h, 'hex')));
const cred = (kind: 'key' | 'script', h: string) => constr(kind === 'key' ? 0 : 1, [bytes(h)]);

/** GlobalSetting with #1016's two fields: batchers, five roles, the fee, its receiver. */
function settingDatum(fee: bigint, receiver: PlutusData): string {
  const pam = constr(1, [bytes('ad'.repeat(28))]);
  const list = csl.PlutusList.new();
  list.add(constr(0, [bytes('ba'.repeat(28))]));
  return constr(0, [csl.PlutusData.new_list(list), pam, pam, pam, pam, pam, csl.PlutusData.new_integer(csl.BigInt.from_str(fee.toString())), receiver]).to_hex();
}

const entry = (head: string, tail: string): FactoryEntry => ({ head, tail, utxo: { txHash: 'fe'.repeat(32), index: 0, addressHex: '', lovelace: 2_000_000n, assets: [], inlineDatumHex: null } });

describe('the factory’s list', () => {
  it('a new pool goes in the one entry whose gap holds its LP name', () => {
    const list = [entry('00', '40'.repeat(32)), entry('40'.repeat(32), 'ff'.repeat(33))];
    expect(factorySlotFor(list, '41'.repeat(32))).toEqual({ kind: 'slot', entry: list[1] });
    expect(factorySlotFor(list, '40'.repeat(32))).toEqual({ kind: 'exists' });
    expect(factorySlotFor([list[0]!], '41'.repeat(32))).toEqual({ kind: 'none' });
  });

  it('reads rows at our factory holding one MSF, and calls a list as long as a page unread', async () => {
    const factory = composeAddress({ kind: 'script', hash: dep.factoryScriptHash }, null);
    const row = {
      tx_hash: 'fe'.repeat(32),
      tx_index: 0,
      address: factory.bech32,
      value: '2000000',
      asset_list: [{ policy_id: dep.authenPolicy, asset_name: '4d5346', quantity: '1' }],
      inline_datum: { bytes: factoryDatumHex(csl, '00', 'ff'.repeat(33)) },
    };
    answer([row]);
    const r = await readFactoryEntries(csl, dep);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.map((e) => [e.head, e.tail])).toEqual([['00', 'ff'.repeat(33)]]);
    answer(Array.from({ length: 1000 }, () => row));
    expect(await readFactoryEntries(csl, dep)).toEqual({ status: 'unread', reason: 'the factory list is longer than one read' });
    // An MSF row somewhere else is not the factory: the whole read is unread, never one row short.
    answer([{ ...row, address: composeAddress({ kind: 'script', hash: '99'.repeat(28) }, null).bech32 }]);
    expect((await readFactoryEntries(csl, dep)).status).toBe('unread');
  });
});

describe('the global setting', () => {
  it('reads the opening fee and the receiver’s two credentials', () => {
    const d = readGlobalSettingDatum(csl, settingDatum(73_000_000n, constr(0, [cred('script', '7e'.repeat(28)), constr(1, [])])));
    expect(d).toEqual({ openingFee: 73_000_000n, receiver: { payment: { kind: 'script', hash: '7e'.repeat(28) }, stake: null } });
    expect(receiverIs(d!.receiver, TEST_TREASURY)).toBe(true);
    // Same hash as a key, or with a stake part: another address.
    expect(receiverIs({ payment: { kind: 'key', hash: '7e'.repeat(28) }, stake: null }, TEST_TREASURY)).toBe(false);
    expect(receiverIs({ payment: { kind: 'script', hash: '7e'.repeat(28) }, stake: { kind: 'key', hash: '01'.repeat(28) } }, TEST_TREASURY)).toBe(false);
  });

  it('refuses Minswap’s own six-field setting (no opening fee) and a pointer stake part', () => {
    const pam = constr(1, [bytes('ad'.repeat(28))]);
    expect(readGlobalSettingDatum(csl, constr(0, [csl.PlutusData.new_list(csl.PlutusList.new()), pam, pam, pam, pam, pam]).to_hex())).toBeNull();
    const pointer = constr(0, [cred('script', '7e'.repeat(28)), constr(0, [constr(1, [bytes('01'), bytes('02'), bytes('03')])])]);
    expect(readGlobalSettingDatum(csl, settingDatum(73_000_000n, pointer))).toBeNull();
  });

  it('wants exactly one settings token at the authen policy’s own script', async () => {
    const at = composeAddress({ kind: 'script', hash: dep.authenPolicy }, null);
    const row = {
      tx_hash: 'a1'.repeat(32),
      tx_index: 0,
      address: at.bech32,
      value: '5000000',
      asset_list: [{ policy_id: dep.authenPolicy, asset_name: '4d534753', quantity: '1' }],
      inline_datum: { bytes: settingDatum(73_000_000n, constr(0, [cred('script', '7e'.repeat(28)), constr(1, [])])) },
    };
    answer([row]);
    const r = await readGlobalSetting(csl, dep);
    expect(r.status === 'ok' && r.data.openingFee).toBe(73_000_000n);
    answer([row, row]);
    expect((await readGlobalSetting(csl, dep)).status).toBe('unread');
    answer([]);
    expect((await readGlobalSetting(csl, dep)).status).toBe('unread');
    answer({}, 502);
    expect((await readGlobalSetting(csl, dep)).status).toBe('unread');
  });
});

describe('the script prices', () => {
  it('reads cardano-cli’s rates exactly', () => {
    expect(rational(0.0577)).toEqual({ n: 577n, d: 10_000n });
    expect(rational(7.21e-5)).toEqual({ n: 721n, d: 10_000_000n });
    expect(rational('abc')).toBeNull();
  });

  it('takes the Plutus V2 cost model and prices, or calls them unread', async () => {
    answer({ costModels: { PlutusV2: Array.from({ length: 175 }, (_, i) => i) }, executionUnitPrices: { priceMemory: 0.0577, priceSteps: 7.21e-5 }, collateralPercentage: 150, maxCollateralInputs: 3 });
    const r = await readPlutusParams();
    expect(r.status === 'ok' && r.data.collateralPercentage).toBe(150);
    answer({ costModels: {}, executionUnitPrices: { priceMemory: 0.0577, priceSteps: 7.21e-5 }, collateralPercentage: 150, maxCollateralInputs: 3 });
    expect((await readPlutusParams()).status).toBe('unread');
  });
});
