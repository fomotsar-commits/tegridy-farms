// The pool card, top to bottom (DESIGN 2.C1): what a liquidity provider weighs (the depth,
// the price, the trade record, the fees) sits above the Add button, the venue's own waiting
// fees are folded out of the LP's way, and no line reads as a return. Red on e33a42ed: the
// deposits block (the Add form) sat above "In the pool" and the price, so a phone read the
// form before the depth (MAP 3.33), and "Fees waiting: venue's share" sat in the open card
// and read like the LP's fees (MAP 3.66).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { PoolCard } from './PoolCard';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const SOL = 10n * 10n ** 9n;
const TOK = 1_000n * 10n ** 6n;

/** A pool nobody has traded: the program's own price record is not initialized. */
const untraded = (): PoolView['history'] => ({ kind: 'ok', obs: { initialized: false, index: 0, poolId: new Uint8Array(32), observations: [], lastUpdate: 0n } });

/** 10 SOL and 1,000 tokens on tier 1 at the standard address, open since the start. */
function view(): PoolView {
  const b = buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: SOL, tokenReserve: TOK, openTime: 1n });
  return viewOf(b, { sol: SOL, tok: TOK, origin: 'standard', history: untraded() });
}

const okToken = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Order', symbol: 'ORDER', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

/** The same check the page runs: the pool's price agrees with Jupiter's, every check passes. */
const healthOf = (v: PoolView) => assessPool({ view: v, tokenDecimals: 6, chainNow: 1_000n, outside: { kind: 'ok', solPerToken: 0.01, source: 'Jupiter' }, safety: okToken(v.tokenMint) });

afterEach(cleanup);

/** True when `b` comes after `a` in the document. */
const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function mount(v = view()) {
  render(
    <ul>
      <PoolCard view={v} health={healthOf(v)} tokenDecimals={6} safety={okToken(v.tokenMint)} readAt={Date.now()} chainNow={1_000n} />
    </ul>,
  );
  return screen.getByTestId('lp-pool');
}

describe('the card, top to bottom', () => {
  it('heading, sub-line, status, In the pool, price rows, trade record, fee rows, stamp, then the deposits block, then the fold', () => {
    const card = mount();
    const c = within(card);
    const order: [string, Element][] = [
      ['heading', c.getByRole('heading', { level: 3 })],
      ['sub-line (the pool address)', c.getByRole('group', { name: 'Pool address' })],
      ['status', c.getByTestId('lp-pool-status')],
      ['In the pool', c.getByText('In the pool')],
      ['price rows', c.getByText('Price here')],
      ['trade record', c.getByTestId('lp-pool-trade')],
      ['fee rows', c.getByText('Fee tier 1')],
      ['stamp', c.getByTestId('lp-read-at')],
      ['deposits block', c.getByTestId('lp-pool-deposits')],
      ['fold', c.getByTestId('lp-pool-more')],
    ];
    for (let i = 1; i < order.length; i++) {
      const [prevName, prev] = order[i - 1]!;
      const [name, el] = order[i]!;
      expect(follows(prev, el), `${name} should come after ${prevName}`).toBe(true);
    }
  });

  it('the deposits block (the Add button and its form) is below In the pool and the price', () => {
    const card = mount();
    const c = within(card);
    const deposits = c.getByTestId('lp-pool-deposits');
    expect(follows(c.getByText('In the pool'), deposits), 'In the pool should be above the deposits block').toBe(true);
    expect(follows(c.getByText('Price here'), deposits), 'the price should be above the deposits block').toBe(true);
  });

  it('both open: one status line, Swaps: open · Withdrawals: open', () => {
    const card = mount();
    expect(within(card).getByTestId('lp-pool-status')).toHaveTextContent(/^Swaps: open · Withdrawals: open$/);
    expect(within(card).queryByText('Withdrawals')).toBeNull();
  });

  it('the fees waiting on the pool are inside the closed fold, and never read as the LP’s', () => {
    const card = mount();
    const c = within(card);
    const more = c.getByTestId('lp-pool-more');
    expect(more.tagName).toBe('DETAILS');
    expect(more).not.toHaveAttribute('open');
    const waiting = c.getAllByText(/fees waiting/i);
    expect(waiting.length).toBeGreaterThan(0);
    for (const el of waiting) expect(more.contains(el), `"${el.textContent}" should sit inside the fold`).toBe(true);
    expect(c.getByText('Venue’s share of fees waiting')).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/Fees waiting: venue/);
    // Outside the fold, "fees" is never followed by a number: nothing reads as fees earned.
    const outside = (card.textContent ?? '').replace(more.textContent ?? '', '');
    expect(outside).not.toMatch(/\bfees\b[^.]*\d/i);
    expect(card).not.toHaveTextContent(/\bfees (earned|so far)\b/i);
    expect(card).not.toHaveTextContent(FORECAST_WORDS);
  });

  it('the compounding line is said once, in the fold, in its short form', () => {
    const card = mount();
    const more = within(card).getByTestId('lp-pool-more');
    const line = within(card).getAllByText('Fees stay in the pool, so each share is worth a little more after every trade. There is nothing to claim.');
    expect(line).toHaveLength(1);
    expect(more.contains(line[0]!)).toBe(true);
    expect(card).not.toHaveTextContent('LPs’ share of fees is not paid out separately');
  });
});
