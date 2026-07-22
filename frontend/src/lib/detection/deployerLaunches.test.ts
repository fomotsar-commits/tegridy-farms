import { describe, it, expect } from 'vitest';
import {
  parseCreatedContracts,
  toBaselines,
  isDeployerAddress,
  type CreatedContract,
} from './deployerLaunches';

const DEPLOYER = '0x1489AbCDef0123456789012345678901234567AB';
const A = '0x000000000000000000000000000000000000000a';
const B = '0x000000000000000000000000000000000000000b';
const C = '0x000000000000000000000000000000000000000c';

/** One Etherscan txlist row. `to:''` + a contractAddress marks a creation. */
function creationRow(contractAddress: string, timeStamp: number, extra: Record<string, unknown> = {}) {
  return { to: '', contractAddress, timeStamp: String(timeStamp), hash: `0xhash${timeStamp}`, isError: '0', ...extra };
}
function normalRow(to: string, timeStamp: number) {
  return { to, contractAddress: '', timeStamp: String(timeStamp), hash: `0xn${timeStamp}`, isError: '0' };
}

describe('parseCreatedContracts', () => {
  it('keeps only contract-creation rows (empty `to` + valid contractAddress)', () => {
    const res = parseCreatedContracts({
      result: [creationRow(A, 100), normalRow('0xdead000000000000000000000000000000000000', 200), creationRow(B, 300)],
    });
    const addrs = res.created.map((c) => c.address).sort();
    expect(addrs).toEqual([A, B].sort());
  });

  it('rejects reverted creations (isError === "1" or txreceipt_status === "0")', () => {
    const res = parseCreatedContracts({
      result: [creationRow(A, 100, { isError: '1' }), creationRow(B, 200, { txreceipt_status: '0' }), creationRow(C, 300)],
    });
    expect(res.created.map((c) => c.address)).toEqual([C]);
  });

  it('treats null `to` as a creation but a present `to` as a plain call', () => {
    const created = parseCreatedContracts({ result: [{ to: null, contractAddress: A, timeStamp: '5', isError: '0' }] });
    expect(created.created).toHaveLength(1);
    const notCreated = parseCreatedContracts({ result: [{ to: B, contractAddress: A, timeStamp: '5', isError: '0' }] });
    expect(notCreated.created).toHaveLength(0);
  });

  it('sorts newest-first and parses createdAt/txHash', () => {
    const res = parseCreatedContracts({ result: [creationRow(A, 100), creationRow(B, 300), creationRow(C, 200)] });
    expect(res.created.map((c) => c.address)).toEqual([B, C, A]);
    expect(res.created[0]).toMatchObject({ address: B, createdAt: 300, txHash: '0xhash300' });
  });

  it('de-dupes by address, keeping the newest occurrence', () => {
    const res = parseCreatedContracts({ result: [creationRow(A, 100), creationRow(A, 500)] });
    expect(res.created).toHaveLength(1);
    expect(res.created[0].createdAt).toBe(500);
  });

  it('caps at maxCreations and flags truncated', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      creationRow(`0x${(i + 1).toString(16).padStart(40, '0')}`, 1000 + i),
    );
    const res = parseCreatedContracts({ result: rows }, { maxCreations: 3 });
    expect(res.created).toHaveLength(3);
    expect(res.truncated).toBe(true);
    // The 3 kept are the newest (highest timestamps).
    expect(res.created.map((c) => c.createdAt)).toEqual([1004, 1003, 1002]);
  });

  it('flags truncated when the raw row count hits the explorer ceiling', () => {
    const rows = [creationRow(A, 1)];
    const res = parseCreatedContracts({ result: rows }, { txRowCeiling: 1 });
    expect(res.truncated).toBe(true);
    expect(res.totalTxScanned).toBe(1);
  });

  it('does not flag truncated for a small, fully-read history', () => {
    const res = parseCreatedContracts({ result: [creationRow(A, 1), normalRow(B, 2)] }, { maxCreations: 50, txRowCeiling: 10000 });
    expect(res.truncated).toBe(false);
  });

  it('accepts a bare array as well as the {result} envelope', () => {
    const bare = parseCreatedContracts([creationRow(A, 1)]);
    expect(bare.created).toHaveLength(1);
  });

  it('degrades safely on garbage / empty / non-array result', () => {
    expect(parseCreatedContracts(null).created).toEqual([]);
    expect(parseCreatedContracts({ result: 'Max rate limit reached' }).created).toEqual([]);
    expect(parseCreatedContracts({ result: [] }).created).toEqual([]);
    expect(parseCreatedContracts({ result: [{ nonsense: true }] }).created).toEqual([]);
  });

  it('drops a malformed contractAddress', () => {
    const res = parseCreatedContracts({ result: [creationRow('0xnothex', 1), creationRow(A, 2)] });
    expect(res.created.map((c) => c.address)).toEqual([A]);
  });
});

describe('toBaselines', () => {
  it('maps creations to baselines with the deployer as creator and zeroed launch facts', () => {
    const created: CreatedContract[] = [{ address: A, createdAt: 123, txHash: '0xt' }];
    const [b] = toBaselines(created, DEPLOYER);
    expect(b.token).toBe(A);
    expect(b.creator).toBe(DEPLOYER.toLowerCase());
    expect(b.tier).toBe('none');
    expect(b.launchedAt).toBe(123);
    // Launch-time baselines are unknown → 0, so enrichment returns CURRENT market
    // only and never fabricates a drain.
    expect(b.launchPriceEth).toBe(0);
    expect(b.launchLiquidityEth).toBe(0);
  });

  it('sets creator to null for a malformed deployer', () => {
    const [b] = toBaselines([{ address: A, createdAt: 1, txHash: null }], 'not-an-address');
    expect(b.creator).toBeNull();
  });
});

describe('isDeployerAddress', () => {
  it('accepts a well-formed EVM address and rejects everything else', () => {
    expect(isDeployerAddress(DEPLOYER)).toBe(true);
    expect(isDeployerAddress('  ' + A + '  ')).toBe(true);
    expect(isDeployerAddress('0x123')).toBe(false);
    expect(isDeployerAddress('')).toBe(false);
    expect(isDeployerAddress('deadbeef')).toBe(false);
  });
});
