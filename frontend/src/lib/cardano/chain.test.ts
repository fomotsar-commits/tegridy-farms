import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPoolCandidates, readUtxo } from './chain';
import { fixture } from './testkit.fixture';

/** Answers every read with `rows`. */
function stubPoolRows(rows: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })));
}

afterEach(() => vi.unstubAllGlobals());

describe('readPoolCandidates', () => {
  const real = fixture<Record<string, unknown>[]>('koios-asset-utxos-two-pools.json');

  it('drops a row without the pool NFT, even one it cannot parse: it can never be the pool', async () => {
    // Anyone can park a UTxO holding the LP token at the pool script, under a pointer address
    // this page does not parse. Before the review it made every quote for the pair "unread".
    const junk = { tx_hash: 'cd'.repeat(32), tx_index: 0, address: 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k', value: '1500000', inline_datum: null, asset_list: [{ policy_id: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c', asset_name: 'e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861', quantity: '1' }] };
    stubPoolRows([...real, junk]);
    const r = await readPoolCandidates('e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.map((u) => u.txHash)).not.toContain('cd'.repeat(32));
  });

  it('says unread when a row that does carry the pool NFT cannot be read', async () => {
    const broken = { ...real[1], value: 12.5 };
    stubPoolRows([broken]);
    expect((await readPoolCandidates('e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861')).status).toBe('unread');
  });
});

describe('readUtxo', () => {
  const real = fixture<Record<string, unknown>[]>('koios-utxo-info-open-order.json');
  const ref = { tx: '3d80ce685be79888a109400f1f65652039f383c978476f617c8760d8f3d1600c', index: 0 };

  it('reads a real open order whole: its coins, its datum, not spent', async () => {
    stubPoolRows(real);
    const r = await readUtxo(ref.tx, ref.index);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || !r.data) throw new Error('not read');
    expect(r.data.spent).toBe(false);
    expect(r.data.utxo.lovelace).toBe(2_700_000n);
    expect(r.data.utxo.assets).toEqual([{ policyId: '8fe8039d057c71fdfb1095e260f153f18a5834d85d9c868ddf7307bc', assetName: '0014df10414e47454c53', quantity: 6_075_011n }]);
    expect(r.data.utxo.inlineDatumHex).toBe((real[0]!.inline_datum as { bytes: string }).bytes);
  });

  it('says the chain does not know it when the answer is empty, and unread when the row is malformed', async () => {
    stubPoolRows([]);
    expect(await readUtxo(ref.tx, ref.index)).toEqual({ status: 'ok', data: null });
    stubPoolRows([{ ...real[0], is_spent: 'no' }]);
    expect((await readUtxo(ref.tx, ref.index)).status).toBe('unread');
    stubPoolRows([{ ...real[0], value: 2.7 }]);
    expect((await readUtxo(ref.tx, ref.index)).status).toBe('unread');
  });
});
