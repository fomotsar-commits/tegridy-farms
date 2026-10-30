// The one deployment record: null as shipped (nothing on chain), and never Minswap's.
import { describe, expect, it } from 'vitest';
import { OWN_POOLS_DEPLOYMENT } from '../../../../api/_lib/cardano-own-pools.js';
import { composeAddress } from '../address';
import { MINSWAP_V2 } from '../minswapV2';
import { OWN_POOLS, readOwnPoolsDeployment } from './deployment';
import { TEST_RECORD } from './testWorld.fixture';

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
});
