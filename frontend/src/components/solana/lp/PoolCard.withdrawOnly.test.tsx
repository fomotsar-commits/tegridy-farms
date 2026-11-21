// Spec 2026-11-14: a pool priced in a delisted coin is withdraw-only. Its card says so in one
// line among the deposit checks, and why (the coin's ticker and whole address) in the small
// print under it. A pool of a listed coin says neither.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PoolCard } from './PoolCard';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { SOL_QUOTE, WITHDRAW_ONLY_LINE, withdrawOnlyWhy } from '../../../lib/solana/lp/quotes';
import { whileDelisted } from '../../../lib/solana/lp/delisted.fixture';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const NOW = 1_791_599_460n;

function mount() {
  const b = buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 25n * 10n ** 9n, tokenReserve: 5_000_000n * 10n ** 6n, openTime: 1_791_055_084n });
  const v = viewOf(b, { sol: 25n * 10n ** 9n, tok: 5_000_000n * 10n ** 6n, origin: 'standard', config: recordedTier(1) });
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside: null, safety: null });
  render(
    <MemoryRouter>
      <ul>
        <PoolCard view={v} health={health} tokenDecimals={6} safety={null} chainNow={NOW} />
      </ul>
    </MemoryRouter>,
  );
  return screen.getByTestId('lp-pool');
}

describe('a pool card for a pool priced in a delisted coin', () => {
  afterEach(cleanup);

  it('says withdraw-only in one line under Deposits, and why in the small print', async () => {
    await whileDelisted(SOL_QUOTE, () => {
      const deposits = within(mount()).getByTestId('lp-pool-deposits');
      const line = within(deposits).getByText(WITHDRAW_ONLY_LINE);
      expect(line.closest('details')).toBeNull();
      const why = within(deposits).getByTestId('lp-pool-withdraw-only-why');
      expect(why.tagName).toBe('DETAILS');
      expect(why).toHaveTextContent(withdrawOnlyWhy(SOL_QUOTE));
      expect(why).toHaveTextContent(SOL_QUOTE.mint);
    });
  });

  it('a pool of a listed coin says neither', () => {
    const card = mount();
    expect(within(card).queryByText(WITHDRAW_ONLY_LINE)).toBeNull();
    expect(within(card).queryByTestId('lp-pool-withdraw-only-why')).toBeNull();
  });
});
