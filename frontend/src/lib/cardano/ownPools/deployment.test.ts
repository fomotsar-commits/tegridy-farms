// The one deployment record: null as shipped (nothing on chain), never Minswap's, and its
// opening fee paid to the venue's proven two-key treasury and nowhere else.
import { describe, expect, it, vi } from 'vitest';
import { OWN_POOLS_DEPLOYMENT } from '../../../../api/_lib/cardano-own-pools.js';
import { composeAddress } from '../address';
import { MINSWAP_V2 } from '../minswapV2';
import { CARDANO_VENUE_FEE_ADDRESS } from '../venueFee';
import { OWN_POOLS, readOwnPoolsDeployment } from './deployment';
import { TEST_RECORD, VENUE_TREASURY } from './testWorld.fixture';

describe('the own-pools deployment record', () => {
  it('is null as shipped: no pool is open, and the screens build nothing', () => {
    expect(OWN_POOLS_DEPLOYMENT).toBeNull();
    expect(OWN_POOLS).toEqual({ kind: 'not-deployed' });
  });

  it('reads the test world whole', () => {
    const r = readOwnPoolsDeployment(TEST_RECORD);
    expect(r.kind).toBe('deployed');
    if (r.kind !== 'deployed') return;
    expect(r.pools.openingFee).toBe(73_000_000n);
    expect(r.pools.poolAddress.payment.hash).toBe(TEST_RECORD.poolScriptHash);
  });

  it.each([
    ['order script', { orderScriptHash: MINSWAP_V2.orderScriptHash }],
    ['pool script', { poolScriptHash: MINSWAP_V2.poolScriptHash }],
    ['authen policy', { authenPolicy: MINSWAP_V2.authenPolicy }],
    ['factory', { factoryScriptHash: '7bc5fbd41a95f561be84369631e0e35895efb0b73e0a7480bb9ed730' }],
    ['pool-batching script', { poolBatchingScriptHash: '1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a' }],
  ])('refuses a record carrying Minswap’s %s', (_what, patch) => {
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, ...patch }).kind).toBe('refused');
  });

  it('refuses Minswap’s pool stake key and its reference-script UTxOs', () => {
    const minswapStaked = composeAddress({ kind: 'script', hash: TEST_RECORD.poolScriptHash }, { kind: 'key', hash: '52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c2' });
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, poolAddress: minswapStaked.bech32 })).toEqual({ kind: 'refused', reason: 'the pool address carries Minswap’s stake key' });
    const ref = { ref: 'dbc1498500a6e79baa0f34d10de55cdb4289ca6c722bd70e1e1b78a858f136b9#0', scriptSize: 4699 };
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, authenRef: ref })).toEqual({ kind: 'refused', reason: 'a reference script is one of Minswap’s' });
  });

  it('refuses a pool address off the pool script, a testnet treasury, a typo’d fee and an impossible budget', () => {
    const elsewhere = composeAddress({ kind: 'script', hash: TEST_RECORD.orderScriptHash }, null);
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, poolAddress: elsewhere.bech32 }).kind).toBe('refused');
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, treasury: composeAddress({ kind: 'key', hash: '7e'.repeat(28) }, null, 0).bech32 }).kind).toBe('refused');
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, openingFeeLovelace: '73000000000' }).kind).toBe('refused');
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, batcherFeeLovelace: '0' }).kind).toBe('refused');
    expect(readOwnPoolsDeployment({ ...TEST_RECORD, openPoolBudget: { factory: { mem: 14_000_000, steps: 1 }, authen: { mem: 14_000_000, steps: 1 } } }).kind).toBe('refused');
  });

  it('pays the opening fee only to the venue’s two-key treasury, and refuses a record naming any other', () => {
    expect(TEST_RECORD.treasury).toBe(CARDANO_VENUE_FEE_ADDRESS);
    const r = readOwnPoolsDeployment(TEST_RECORD);
    expect(r.kind === 'deployed' && r.pools.treasury.bech32).toBe(CARDANO_VENUE_FEE_ADDRESS);
    const others = [
      composeAddress({ kind: 'script', hash: '7e'.repeat(28) }, null), // a made-up treasury
      composeAddress(VENUE_TREASURY.payment, null), // our spending script without our staking script
      composeAddress(VENUE_TREASURY.payment, { kind: 'key', hash: '01'.repeat(28) }), // someone else's staking key
      composeAddress({ kind: 'key', hash: VENUE_TREASURY.payment.hash }, VENUE_TREASURY.stake), // the same hash as a key
    ];
    for (const other of others) {
      expect(readOwnPoolsDeployment({ ...TEST_RECORD, treasury: other.bech32 })).toEqual({ kind: 'refused', reason: 'the treasury is not the venue’s two-key treasury' });
    }
  });

  it('refuses every record while the venue names no treasury', async () => {
    vi.resetModules();
    vi.doMock('../venueFee', async (original) => ({ ...(await original<typeof import('../venueFee')>()), CARDANO_VENUE_FEE_ADDRESS: null }));
    try {
      const { readOwnPoolsDeployment: readWithNoTreasury } = await import('./deployment');
      expect(readWithNoTreasury(TEST_RECORD)).toEqual({ kind: 'refused', reason: 'the treasury is not the venue’s two-key treasury' });
    } finally {
      vi.doUnmock('../venueFee');
      vi.resetModules();
    }
  });
});
