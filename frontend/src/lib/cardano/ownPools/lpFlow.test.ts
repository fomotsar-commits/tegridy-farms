// Opening a pool, start to finish, with the chain and the wallet stubbed: the page states the
// record's fee and treasury, so nothing is built unless the chain's global setting names the
// same fee to the same receiver; a pair already open, or a list read short, builds nothing.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlutusData, PrivateKey } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { composeAddress, type ParsedAddress } from '../address';
import { ADA, lpAssetName } from '../minswapV2';
import type { Cip30Api } from '../cip30';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import { factoryDatumHex } from './openPoolTx';
import { prepareOpen } from './lpFlow';
import { PLUTUS, TEST_RECORD, walletUtxo } from './testWorld.fixture';

const NEW_TOKEN = { policyId: '42'.repeat(28), assetName: '4e4557' };
const PARAMS = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, maxTxSize: 16384, maxValueSize: 5000, stakeAddressDeposit: 2000000, stakePoolDeposit: 500000000, minFeeRefScriptCostPerByte: 15 };

let csl: Csl;
let dep: OwnPools;
let key: PrivateKey;
let opener: ParsedAddress;
let api: Cip30Api;

const constr = (alt: number, fs: PlutusData[]) => {
  const l = csl.PlutusList.new();
  for (const f of fs) l.add(f);
  return csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str(String(alt)), l));
};
const bytes = (h: string) => csl.PlutusData.new_bytes(Uint8Array.from(Buffer.from(h, 'hex')));

function settingRow(fee: bigint, receiverHash: string) {
  const pam = constr(1, [bytes('ad'.repeat(28))]);
  const batchers = csl.PlutusList.new();
  batchers.add(constr(0, [bytes('ba'.repeat(28))]));
  const receiver = constr(0, [constr(1, [bytes(receiverHash)]), constr(1, [])]);
  const datum = constr(0, [csl.PlutusData.new_list(batchers), pam, pam, pam, pam, pam, csl.PlutusData.new_integer(csl.BigInt.from_str(fee.toString())), receiver]);
  return {
    tx_hash: 'a1'.repeat(32),
    tx_index: 0,
    address: composeAddress({ kind: 'script', hash: dep.authenPolicy }, null).bech32,
    value: '5000000',
    asset_list: [{ policy_id: dep.authenPolicy, asset_name: '4d534753', quantity: '1' }],
    inline_datum: { bytes: datum.to_hex() },
  };
}

function factoryRow(head: string, tail: string) {
  return {
    tx_hash: 'fe'.repeat(32),
    tx_index: 0,
    address: composeAddress({ kind: 'script', hash: dep.factoryScriptHash }, null).bech32,
    value: '2000000',
    asset_list: [{ policy_id: dep.authenPolicy, asset_name: '4d5346', quantity: '1' }],
    inline_datum: { bytes: factoryDatumHex(csl, head, tail) },
  };
}

function chain(over: Partial<Record<string, unknown>> = {}) {
  const table: Record<string, unknown> = {
    ownsetting: [settingRow(73_000_000n, '7e'.repeat(28))],
    ownpool: [],
    ownfactory: [factoryRow('00', 'ff'.repeat(33))],
    params: { ...PARAMS, costModels: { PlutusV2: PLUTUS.costModelV2 }, executionUnitPrices: { priceMemory: 0.0577, priceSteps: 7.21e-5 }, collateralPercentage: 150, maxCollateralInputs: 3 },
    tip: [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }],
    ...over,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const op = new URL(url, 'https://site.test').pathname.replace('/api/cardano/', '');
      return op in table ? new Response(JSON.stringify(table[op]), { status: 200 }) : new Response('no', { status: 500 });
    }),
  );
}

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error('test record refused');
  dep = r.pools;
  key = csl.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(0x41));
  opener = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, { kind: 'key', hash: '73'.repeat(28) });
  const utxos = [walletUtxo(csl, 1, opener, 700_000_000n), walletUtxo(csl, 2, opener, 3_000_000n, [[NEW_TOKEN.policyId, NEW_TOKEN.assetName, 2_000_000_000n]]), walletUtxo(csl, 3, opener, 8_000_000n)];
  api = {
    getNetworkId: async () => 1,
    getChangeAddress: async () => opener.hex,
    getUtxos: async () => utxos.map((u) => u.hex),
    signTx: async () => '',
    submitTx: async () => '',
  } as unknown as Cip30Api;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareOpen', () => {
  it('builds and checks the opening when the chain names the record’s fee and treasury', async () => {
    chain();
    const p = await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n);
    expect(p.kind === 'stop' ? p : 'review').toBe('review');
    if (p.kind === 'review' && p.action === 'open') {
      expect(p.checked.openingFee).toBe(73_000_000n);
      expect(p.plan.setting).toEqual({ txHash: 'a1'.repeat(32), index: 0 });
    }
  });

  it('builds nothing when the chain’s opening fee is not the record’s', async () => {
    chain({ ownsetting: [settingRow(50_000_000n, '7e'.repeat(28))] });
    const p = await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n);
    expect(p).toEqual({ kind: 'stop', message: 'The chain’s opening fee or its receiver is not the one this page states. Nothing was built.', problems: undefined });
  });

  it('builds nothing when the chain pays the fee to another receiver', async () => {
    chain({ ownsetting: [settingRow(73_000_000n, '99'.repeat(28))] });
    const p = await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n);
    expect(p.kind).toBe('stop');
  });

  it('builds nothing when the pair is already in the factory’s list', async () => {
    const lp = lpAssetName(ADA, NEW_TOKEN);
    chain({ ownfactory: [factoryRow('00', lp), factoryRow(lp, 'ff'.repeat(33))] });
    const p = await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n);
    expect(p.kind === 'stop' && p.message).toMatch(/already open/);
  });

  it('builds nothing when no entry’s gap holds the pair, or the list cannot be read: never "no pool"', async () => {
    chain({ ownfactory: [factoryRow('00', '01')] });
    expect(await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n)).toEqual({ kind: 'stop', message: 'The pool list could not be read whole. Nothing was built.', problems: undefined });
    chain({ ownfactory: 'not a list' });
    const p = await prepareOpen(csl, dep, api, opener, NEW_TOKEN, 500_000_000n, 1_000_000_000n);
    expect(p.kind === 'stop' && p.message).toMatch(/could not be read/);
  });
});
