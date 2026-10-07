// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_OWN_PRIORITY_LAMPORTS } from '../../launcher/solana/write/budget';
import { OWN_POOL_SWAPS, OWN_PRIORITY_CAP_LAMPORTS } from './ownPoolSwaps';

describe('ownPoolSwaps', () => {
  it('the cap the swap page states is the cap the write layer pays to', () => {
    expect(OWN_PRIORITY_CAP_LAMPORTS).toBe(MAX_OWN_PRIORITY_LAMPORTS);
  });

  it('is on: the owner asked for trades to reach our pool when it pays more (2026-10-07)', () => {
    expect(OWN_POOL_SWAPS).toBe(true);
  });
});
