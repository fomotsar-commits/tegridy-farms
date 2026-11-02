// Island answer twenty-four, build 1c: the check fails open on age, closed on absence. A
// pool whose outside price is five minutes old offers the Add form and says when the price
// was read; a pool with no price for eleven minutes is held by one row, not a paragraph.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { MemoryRouter } from 'react-router-dom';
import { PoolCard } from './PoolCard';
import { depositOffer } from './offers';
import type { LpReaders } from './readers';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { __resetSharedPrices, fromShared } from '../../../lib/solana/lp/outsidePrice';
import { lpOpenGate } from './fakeLpWriteApi.fixture';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, observationBytes, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const Rc = 25_647_606_321n;
const Rt = 5_414_845_326_496n;
const S = 372_631_821_673n;
const NOW = 1_791_599_460n;
const MIN = 60_000;

function view(): PoolView {
  const obs = decodeObservationState(observationBytes({ pool: new PublicKey(BAYLA_MINT), index: 2, lastUpdate: 1_791_514_249n }));
  if (!obs) throw new Error('the test bytes do not decode as a price record');
  const b = buildPool({ plain: true, mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S, protocolFeesSol: 801_600n, openTime: 1_791_055_084n });
  return viewOf(b, { sol: Rc, tok: Rt, origin: 'standard', history: { kind: 'ok', obs }, config: recordedTier(1) });
}
const safety: TokenSafety = {
  kind: 'read', mint: BAYLA_MINT, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

afterEach(cleanup);
beforeEach(() => __resetSharedPrices());

const OPEN = lpOpenGate();

/** The card, with the outside price as the shared list gives it at `nowMs`. */
function mount(entry: Parameters<typeof fromShared>[0], nowMs: number) {
  const v = view();
  const outside = fromShared(entry, BAYLA_MINT, nowMs);
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside, safety });
  const poolPast = vi.fn<NonNullable<LpReaders['poolPast']>>();
  render(
    <MemoryRouter>
      <ul>
        <PoolCard view={v} health={health} tokenDecimals={6} safety={safety} chainNow={NOW} readers={{ poolPast }} />
      </ul>
    </MemoryRouter>,
  );
  return { card: screen.getByTestId('lp-pool'), health };
}
const rowValue = (el: HTMLElement, label: string) => within(el).getByText(label, { exact: true }).nextElementSibling?.textContent;

describe('the door stays open on age', () => {
  it('a price read five minutes ago passes the deposit check, the form is offered, and the row says when it was read', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_762_000_000_000);
    const now = Date.now();
    const { card, health } = mount({ state: 'ok', sol_per_token: 0.0000047, read_at: now - 5 * MIN }, now);
    expect(health.deposits.verdict).toBe('allowed');
    expect(depositOffer({ mode: 'on', gate: OPEN, health, held: false })).toBe('offer');
    expect(within(card).getByText('Deposits: the checks pass')).toBeInTheDocument();
    expect(rowValue(card, 'Outside price (Jupiter)')).toMatch(/^1 BAYLA = [\d.]+ SOL, read 5 min ago$/);
    expect(card).not.toHaveTextContent('adding waits');
    expect(card).not.toHaveTextContent('Adding is off');
    vi.restoreAllMocks();
  });

  it('a price the loop could not read, with a last good read four minutes old, still passes', () => {
    const now = 1_762_000_000_000;
    const { health } = mount({ state: 'unread', detail: 'HTTP 429', last: { sol_per_token: 0.0000047, read_at: now - 4 * MIN } }, now);
    expect(health.deposits.verdict).toBe('allowed');
  });
});

describe('the door closes on absence, in one row', () => {
  it('no price for eleven minutes holds the form with one row, and no paragraph', () => {
    const now = 1_762_000_000_000;
    const { card, health } = mount({ state: 'unread', detail: 'HTTP 429', last: { sol_per_token: 0.0000047, read_at: now - 11 * MIN } }, now);
    expect(health.deposits.verdict).toBe('unchecked');
    expect(depositOffer({ mode: 'on', gate: OPEN, health, held: false })).toBe('checks');
    expect(rowValue(card, 'Outside price')).toBe('not read for 11 min; adding waits');
    expect(within(card).getByText('Deposits: not checked')).toBeInTheDocument();
    // Said once: not again as a notice under the heading, and no "Adding is off" paragraph.
    expect(within(card).getAllByText(/adding waits/)).toHaveLength(1);
    expect(card).not.toHaveTextContent('We could not check its price');
    expect(card).not.toHaveTextContent('Adding is off');
    expect(card).not.toHaveTextContent('could not be run just now');
  });

  it('the pool’s own reserves stay the one hard stop: an empty side refuses whatever the list says', () => {
    const now = 1_762_000_000_000;
    const b = buildPool({ plain: true, mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: 0n, tokenReserve: Rt, lpSupply: S, protocolFeesSol: 0n, openTime: 1_791_055_084n });
    const v = viewOf(b, { sol: 0n, tok: Rt, origin: 'standard', config: recordedTier(1) });
    const outside = fromShared({ state: 'ok', sol_per_token: 0.0000047, read_at: now }, BAYLA_MINT, now);
    const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside, safety });
    expect(health.deposits.verdict).toBe('refused');
  });
});
