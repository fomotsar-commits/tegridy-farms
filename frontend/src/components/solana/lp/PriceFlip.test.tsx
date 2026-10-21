// Owner, 2026-10-17: "i want to be able to click on the bayla and have it switch to 1 sol and
// give me the appropriate bayla for that 1 sol across the pools". A press on any pool's price
// turns every pool's price round, on every card and in the All pools list, and the card's
// Difference is worked out the same way round so it matches the two numbers above it.
// The BAYLA/SOL pool is the venue's as mainnet held it at slot 455093758 (PoolCard.recut.test).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PoolCard } from './PoolCard';
import { setPriceSide } from './priceSide';
import { VenuePoolList } from './VenuePoolList';
import type { LpReaders } from './readers';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { formatSolPrice, perCoinText, turnedDiff } from '../../../lib/solana/lp/format';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { quoteCoin } from '../../../lib/solana/lp/quotes';
import { buildPool, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const Rc = 25_647_606_321n;
const Rt = 5_414_845_326_496n;
const NOW = 1_791_599_460n;
// A mint the site's registry does not list.
const UNLISTED = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const SOL = quoteCoin('So11111111111111111111111111111111111111112')!;
// SOL a BAYLA in the pool, and BAYLA a SOL: 25.647606321 SOL against 5,414,845.326496 BAYLA.
const POOL_PRICE = Number(Rc) / 1e9 / (Number(Rt) / 1e6);
const BAYLA_PER_SOL = Math.round(1 / POOL_PRICE);

function view(mint: string): PoolView {
  const b = buildPool({ plain: true, mint: new PublicKey(mint), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: 372_631_821_673n });
  return viewOf(b, { sol: Rc, tok: Rt, origin: 'standard', config: recordedTier(1) });
}
const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});
function card(v: PoolView, solPerToken: number) {
  const safety = token(v.tokenMint);
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside: { kind: 'ok', solPerToken, source: 'Jupiter' }, safety });
  return <PoolCard key={v.address} view={v} health={health} tokenDecimals={6} safety={safety} chainNow={NOW} />;
}
const rowValue = (el: HTMLElement, label: string) => within(el).getByText(label, { exact: true }).nextElementSibling?.textContent;

afterEach(() => {
  cleanup();
  act(() => setPriceSide('token'));
});

describe('the price said the other way round', () => {
  it('is what one pairing coin buys at it, and nothing for a price that cannot be turned round', () => {
    expect(perCoinText(0.000006354, SOL, 'BAYLA')).toBe('1 SOL = 157,381 BAYLA');
    expect(perCoinText(0.0012, SOL)).toBe('1 SOL = 833.3 tokens');
    // Mainnet, 2026-10-17: the BAYLA/USDC pool at 0.0006022 USDC a BAYLA.
    expect(perCoinText(0.0006022, SOL, 'BAYLA')).toBe('1 SOL = 1,661 BAYLA');
    expect(perCoinText(0, SOL, 'BAYLA')).toBeNull();
    expect(perCoinText(Number.NaN, SOL, 'BAYLA')).toBeNull();
  });

  it('turns a difference round with it: 1.3% below in SOL a BAYLA is 1.3% more BAYLA a SOL', () => {
    const pool = 0.000006354;
    const outside = 0.000006439;
    const diff = pool / outside - 1;
    expect(turnedDiff(diff)).toBeCloseTo(outside / pool - 1, 12);
    expect(turnedDiff(diff)).toBeGreaterThan(0);
    expect(turnedDiff(turnedDiff(diff))).toBeCloseTo(diff, 12);
  });
});

describe('a press on any pool price turns every pool price round', () => {
  it('on every card and in the All pools list, and a second press turns them back', async () => {
    const bayla = view(BAYLA_MINT);
    const other = view(UNLISTED);
    const listPools = vi.fn(async () => ({ kind: 'ok' as const, list: { pools: [bayla, other], unread: 0, truncated: false, chainNow: null } }));
    render(
      <>
        <ul>
          {card(bayla, 0.000006)}
          {card(other, 0.000006)}
        </ul>
        <VenuePoolList readers={{ listPools } as unknown as LpReaders} onView={() => {}} />
      </>,
    );
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    const [first, second] = screen.getAllByTestId('lp-pool');

    // As it was: per one token, in SOL. 21% below the outside price, said in the warning colour.
    expect(rowValue(first, 'Price here')).toBe(`1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL`);
    expect(rowValue(first, 'Outside price (Jupiter)')).toBe('1 BAYLA = 0.000006 SOL');
    expect(rowValue(first, 'Difference')).toBe(`${(Math.abs(POOL_PRICE / 0.000006 - 1) * 100).toFixed(1)}% below the outside price`);
    expect(rows[0]).toHaveTextContent(`1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL`);

    // One press, on the first card's price.
    fireEvent.click(within(first).getAllByTestId('lp-price-flip')[0]);

    const turned = `1 SOL = ${BAYLA_PER_SOL.toLocaleString('en-US')} BAYLA`;
    expect(rowValue(first, 'Price here')).toBe(turned);
    expect(rowValue(first, 'Outside price (Jupiter)')).toBe('1 SOL = 166,667 BAYLA');
    // Here a SOL buys more BAYLA than outside, so the pool reads ABOVE, by the turned figure.
    const above = rowValue(first, 'Difference')!;
    expect(above).toBe(`${((0.000006 / POOL_PRICE - 1) * 100).toFixed(1)}% above the outside price`);
    expect(within(first).getByText('Difference', { exact: true }).nextElementSibling).toHaveClass('text-amber-300/90');
    // The other card and both list rows turned with it; a token the site does not list stays "tokens".
    expect(rowValue(second, 'Price here')).toBe(`1 SOL = ${BAYLA_PER_SOL.toLocaleString('en-US')} tokens`);
    expect(rows[0]).toHaveTextContent(turned);
    expect(rows[1]).toHaveTextContent(`1 SOL = ${BAYLA_PER_SOL.toLocaleString('en-US')} tokens`);

    // A press anywhere else, here a list row, turns them all back.
    fireEvent.click(within(rows[1]).getByTestId('lp-price-flip'));
    expect(rowValue(first, 'Price here')).toBe(`1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL`);
    expect(rowValue(second, 'Price here')).toBe(`1 token = ${formatSolPrice(POOL_PRICE)} SOL`);
    expect(rows[0]).toHaveTextContent(`1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL`);
  });

  it('is a button named by the price it shows, that says what a press does', () => {
    const bayla = view(BAYLA_MINT);
    render(<ul>{card(bayla, 0.0000047)}</ul>);
    const flip = screen.getByRole('button', { name: `1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL` });
    expect(flip).toHaveAttribute('title', 'Show every pool’s price per 1 SOL');
    fireEvent.click(flip);
    expect(screen.getByRole('button', { name: `1 SOL = ${BAYLA_PER_SOL.toLocaleString('en-US')} BAYLA` })).toHaveAttribute('title', 'Show every pool’s price per 1 BAYLA');
  });

  // Owner, 2026-10-20: the press area grows to 44px and the price looks the same. The LP
  // section's 44px rule is checked in a browser only by e2e-solana, which no CI job runs.
  it('is pressed over 44px of height on any line of 16px or more, and moves nothing round it', () => {
    render(<ul>{card(view(BAYLA_MINT), 0.0000047)}</ul>);
    const [flip] = screen.getAllByTestId('lp-price-flip');
    // 14px of padding above and below, taken back by the same negative margin, painted
    // above the rows after it (in a browser they took a press on its lower 6 to 7px otherwise).
    expect(flip).toHaveClass('inline-block', 'py-3.5', '-my-3.5', 'relative');
    // The ring goes round the words, not round the area over the rows beside it (index.css).
    expect(flip).toHaveClass('ring-on-words');
    expect(flip.querySelector('.ring-words')).toHaveTextContent(`1 BAYLA = ${formatSolPrice(POOL_PRICE)} SOL`);
  });
});
