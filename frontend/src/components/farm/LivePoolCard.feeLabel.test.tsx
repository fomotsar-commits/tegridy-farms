import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LivePoolCard } from './LivePoolCard';
import type { usePoolTVL } from '../../hooks/usePoolTVL';

/**
 * T32 — the figure this card printed as a headline stat is `usePoolTVL().apr`,
 * which is `SwapFeeRouter.totalETHFees()` (the VENUE's platform fee, skimmed off
 * `msg.value` before the swap ever reaches the pair) annualised against pool
 * TVL. It is not an LP's income — the LP's income is the pair's own 0.3%,
 * 5/6 accruing into the reserves and 1/6 to `feeTo` (TegridyPair.sol:16-17).
 * /liquidity already refused to print it under an APR head (see the block
 * comment at the top of VenuePoolTable.tsx); this suite is what keeps /farm
 * from drifting back.
 *
 * WHAT IS PINNED, AND WHAT IS NOT. These tests do not assert a wording. They
 * assert two properties:
 *   1. whatever tile carries the router-fee number is labelled as a FEE, and
 *      its label does not promise a return (APR / yield / earnings);
 *   2. when a read has not landed and the card is showing dashes, no copy on
 *      the card claims the figures are estimates — an unreadable value must
 *      never read as a number that exists.
 * A rename of the component, the hook, the tile or the surrounding copy leaves
 * both intact; putting the platform fee back under an APR head fails both.
 */

// CountUpText springs the numeric part of a stat up from 0, so a tile's DOM text
// is mid-animation at assert time. Rendering the value verbatim is what lets the
// label -> value binding below be asserted at all; nothing here is concerned
// with the animation itself.
vi.mock('../motion', () => ({
  CountUpText: ({ value }: { value: string }) => <span>{value}</span>,
}));

type PoolData = ReturnType<typeof usePoolTVL>;

const LOADED: PoolData = {
  tvl: 412_000,
  tvlFormatted: '$412.0K',
  toweliReserve: 1n,
  wethReserve: 1n,
  lpSupply: 1n,
  apr: '12.5%',
  aprNum: 12.5,
  vol24hFormatted: '$88.1K',
  aprIsEstimated: false,
  volIsEstimated: false,
  isLoaded: true,
  stakerSharePct: 100,
  stakerShareLoaded: true,
  referralFeeBps: 0,
  feesReadOk: true,
};

/** Every figure unreadable — the state the two *IsEstimated flags actually mean. */
const UNREADABLE: PoolData = {
  ...LOADED,
  tvl: 0,
  tvlFormatted: '–',
  apr: '–',
  aprNum: 0,
  vol24hFormatted: '–',
  aprIsEstimated: true,
  volIsEstimated: true,
  isLoaded: false,
  feesReadOk: true,
};

function renderCard(poolData: PoolData) {
  return render(
    <MemoryRouter>
      <LivePoolCard poolData={poolData} />
    </MemoryRouter>,
  );
}

/** The stat tile that carries a given figure, found by the value, not by copy. */
function tileCarrying(value: string): HTMLElement {
  const node = screen.getByText(value);
  const tile = node.closest('div');
  expect(tile).not.toBeNull();
  return tile as HTMLElement;
}

describe('LivePoolCard - the router fee is not advertised as an LP return', () => {
  it('labels the platform-fee figure as a fee, not as an APR/yield/earnings', () => {
    renderCard(LOADED);

    const label = tileCarrying('12.5%').textContent ?? '';
    // The label has to say what the number IS.
    expect(label).toMatch(/fee/i);
    // ...and must not promise the reader a return on it.
    expect(label).not.toMatch(/\bAPR\b|\byield\b|\bearn/i);
  });

  it('does not put an APR/yield promise anywhere on the card', () => {
    renderCard(LOADED);
    // /liquidity's standing decision, mirrored: no APR head on this surface
    // while the only fee figure readable on chain is the protocol's own.
    //
    // Asserted ELEMENT-BY-ELEMENT, not against `container.textContent`. The
    // concatenated form of this card reads "...Vol$88.1KAPR & volume..." — the
    // `K` runs straight into the `A`, so a `\bAPR\b` over the whole string does
    // not match and the assertion passes on the very markup it exists to catch.
    // (Measured: that spelling passed against the pre-fix card.)
    expect(screen.queryAllByText(/APR|yield/i)).toHaveLength(0);
  });

  it('says whose income the fee figure is', () => {
    const { container } = renderCard(LOADED);
    const text = container.textContent ?? '';
    expect(text).toMatch(/protocol|venue|router/i);
    // The disclaimer that separates the two parties has to be present in some
    // form: this number is not what supplying liquidity pays.
    expect(text).toMatch(/not what|rather than yours|not your|not the liquidity provider/i);
  });
});

describe('LivePoolCard - an unreadable figure must not read as an estimate', () => {
  it('claims no estimate while every figure is dashed', () => {
    const { container } = renderCard(UNREADABLE);
    const text = container.textContent ?? '';
    // aprIsEstimated/volIsEstimated are TRUE here and mean "the read did not
    // land, showing a dash" — copy that calls the dashes estimates asserts a
    // number exists when none was ever computed.
    expect(text).not.toMatch(/estimat/i);
  });

  it('explains that a dash is an unread value, not a zero', () => {
    const { container } = renderCard(UNREADABLE);
    expect(container.textContent ?? '').toMatch(/dash/i);
  });
});
