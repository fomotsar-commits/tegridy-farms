// Island answer twenty-four, §4: a pool card names its token and its pairing coin as presses that
// copy their whole addresses, under the heading, whose words stay the pair's name. A copy of one
// of our tickers is named "fake" there too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { MemoryRouter } from 'react-router-dom';
import { PoolCard } from './PoolCard';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { BAYLA_MINT, WSOL_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const NOW = 1_791_599_460n;

function view(mint: PublicKey): PoolView {
  const b = buildPool({ plain: true, mint, configIndex: 1, quoteReserve: 25n * 10n ** 9n, tokenReserve: 5_000_000n * 10n ** 6n, openTime: 1_791_055_084n });
  return viewOf(b, { sol: 25n * 10n ** 9n, tok: 5_000_000n * 10n ** 6n, origin: 'standard', config: recordedTier(1) });
}
const calls = (mint: string, symbol: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: symbol, symbol, metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function mount(mint: PublicKey, safety: TokenSafety) {
  const v = view(mint);
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside: null, safety });
  render(
    <MemoryRouter>
      <ul>
        <PoolCard view={v} health={health} tokenDecimals={6} safety={safety} chainNow={NOW} />
      </ul>
    </MemoryRouter>,
  );
  return screen.getByTestId('lp-pool');
}
const names = (card: HTMLElement) => within(card).getAllByTestId('coin-name').map((n) => n.getAttribute('aria-label'));

describe('a pool card’s two coins', () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(cleanup);

  it('are presses under the heading, each copying its whole address; the heading keeps its words', async () => {
    const card = mount(new PublicKey(BAYLA_MINT), calls(BAYLA_MINT, 'BAYLA'));
    const heading = within(card).getByRole('heading', { level: 3 });
    expect(heading.textContent).toMatch(/^BAYLA \/ SOL · .+ tier$/);
    expect(within(heading).queryByTestId('coin-name')).toBeNull();
    expect(names(card)).toEqual([`BAYLA: copy its address ${BAYLA_MINT}`, `SOL: copy its address ${WSOL_MINT}`]);
    const [bayla] = within(card).getAllByTestId('coin-name');
    expect(bayla).toHaveTextContent('7hmV … pump');
    expect(bayla!.className).toContain('min-h-[44px]');
    await act(async () => {
      fireEvent.click(bayla!);
    });
    expect(writeText).toHaveBeenCalledWith(BAYLA_MINT);
  });

  it('names a copy of one of our tickers “fake”, and copies the copy’s own address', () => {
    const copy = key();
    const card = mount(copy, calls(copy.toBase58(), 'BAYLA'));
    expect(names(card)).toEqual([`fake BAYLA: copy its address ${copy.toBase58()}`, `SOL: copy its address ${WSOL_MINT}`]);
  });
});
