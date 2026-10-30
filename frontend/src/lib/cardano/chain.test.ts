import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFingerprint, readPolicyCoins, readPoolCandidates } from './chain';
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

describe('readPolicyCoins', () => {
  const ft = (asset_name: string, total_supply: unknown, extra: Record<string, unknown> = {}) => ({ asset_name, asset_name_ascii: null, total_supply, ticker: null, ...extra });

  it('lists the coins under a policy, by ticker, and leaves its NFTs (and CIP-68 reference tokens) out', async () => {
    stubPoolRows([
      ft('000643b0415343454e44', '1'),
      ft('0014df10415343454e44', '1000000000000'),
      ft('536e656b436f696e', '76715880000', { asset_name_ascii: 'SnekCoin', ticker: 'SNEK' }),
      ft('4e4654303031', '1', { asset_name_ascii: 'NFT001' }),
      ft('6275726e74', '0', { asset_name_ascii: 'burnt' }),
    ]);
    const r = await readPolicyCoins('ab'.repeat(28));
    expect(r).toEqual({
      status: 'ok',
      data: { cut: false, coins: [{ assetName: '0014df10415343454e44', label: 'ASCEND' }, { assetName: '536e656b436f696e', label: 'SNEK' }] },
    });
  });

  it('cuts a long label by characters, never through an emoji', async () => {
    stubPoolRows([ft('4c4f4e47', '1000', { ticker: `${'a'.repeat(31)}😀tail` })]);
    const r = await readPolicyCoins('ab'.repeat(28));
    expect(r.status === 'ok' && r.data.coins[0]?.label).toBe(`${'a'.repeat(31)}😀`);
  });

  it('says the list is cut when the policy holds more than one read lists', async () => {
    stubPoolRows(Array.from({ length: 51 }, (_, i) => ft(i.toString(16).padStart(4, '0'), '1')));
    const r = await readPolicyCoins('ab'.repeat(28));
    expect(r).toEqual({ status: 'ok', data: { cut: true, coins: [] } });
  });

  it('says unread, never a shorter list, when a row cannot be read', async () => {
    stubPoolRows([ft('69555344', '1343336181479'), ft('69555344', 12)]);
    expect((await readPolicyCoins('ab'.repeat(28))).status).toBe('unread');
    stubPoolRows([ft('6', '100')]);
    expect((await readPolicyCoins('ab'.repeat(28))).status).toBe('unread');
  });
});

describe('readFingerprint', () => {
  const fp = 'asset108xu02ckwrfc8qs9d97mgyh4kn8gdu9w8f5sxk';
  const row = { policy_id: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', asset_name: '534e454b', fingerprint: fp };

  it('names the coin the fingerprint stands for, and null when none has it', async () => {
    stubPoolRows([row]);
    expect(await readFingerprint(fp)).toEqual({ status: 'ok', data: { policyId: row.policy_id, assetName: row.asset_name } });
    stubPoolRows([]);
    expect(await readFingerprint(fp)).toEqual({ status: 'ok', data: null });
  });

  it('refuses an answer about another fingerprint, or a malformed one', async () => {
    stubPoolRows([{ ...row, fingerprint: 'asset1kfw6plmuzggq7uv90hhvky5p6xycax3l4mru58' }]);
    expect((await readFingerprint(fp)).status).toBe('unread');
    stubPoolRows([{ ...row, policy_id: 'zz' }]);
    expect((await readFingerprint(fp)).status).toBe('unread');
    stubPoolRows([row, row]);
    expect((await readFingerprint(fp)).status).toBe('unread');
  });
});
