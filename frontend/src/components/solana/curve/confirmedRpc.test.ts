import { describe, expect, it, vi } from 'vitest';
import { withReadCommitment } from './confirmedRpc';

describe('withReadCommitment', () => {
  it('reads accounts at confirmed, so a page sees the trade it just confirmed', async () => {
    const inner = vi.fn(async () => null);
    const rpc = withReadCommitment(inner);
    await rpc('getAccountInfo', ['Addr', { encoding: 'base64' }]);
    await rpc('getMultipleAccounts', [['A', 'B']]);
    expect(inner).toHaveBeenNthCalledWith(1, 'getAccountInfo', ['Addr', { commitment: 'confirmed', encoding: 'base64' }]);
    expect(inner).toHaveBeenNthCalledWith(2, 'getMultipleAccounts', [['A', 'B'], { commitment: 'confirmed' }]);
  });

  it('keeps a commitment the caller chose, and leaves other methods alone', async () => {
    const inner = vi.fn(async () => null);
    const rpc = withReadCommitment(inner);
    await rpc('getAccountInfo', ['Addr', { encoding: 'base64', commitment: 'finalized' }]);
    await rpc('getSignaturesForAddress', ['Addr', { limit: 5 }]);
    await rpc('getGenesisHash', []);
    expect(inner).toHaveBeenNthCalledWith(1, 'getAccountInfo', ['Addr', { commitment: 'finalized', encoding: 'base64' }]);
    expect(inner).toHaveBeenNthCalledWith(2, 'getSignaturesForAddress', ['Addr', { limit: 5 }]);
    expect(inner).toHaveBeenNthCalledWith(3, 'getGenesisHash', []);
  });
});
