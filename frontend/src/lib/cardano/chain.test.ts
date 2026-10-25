import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPoolCandidates } from './chain';
import { fixture } from './testkit.fixture';

function stubPoolRows(rows: unknown[]) {
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
