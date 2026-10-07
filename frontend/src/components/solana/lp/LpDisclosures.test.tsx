// The Add panel says each risk once (Wave 1, C4). The fork and vault lines stay in the panel
// and are said again on the review; the price-moves and routing lines are the notice card's
// now; one impermanent-loss sentence prints its percentages from impermanentLossPct, so the
// words cannot drift from the arithmetic. Nothing here touches a chain.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LpBeforeYouAdd, LpReviewDisclosure } from './LpDisclosures';
import { tier1Config } from './fakeLpWriteApi.fixture';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { impermanentLossPctText } from '../../../lib/solana/lp/impermanentLoss';

// The committed switch, steerable here so its "off" branch is proven without editing the source.
const il = vi.hoisted(() => ({ shown: true }));
vi.mock('../../../lib/solana/lp/impermanentLoss', async (orig) => {
  const mod = await orig<typeof import('../../../lib/solana/lp/impermanentLoss')>();
  return {
    ...mod,
    get IL_LINE_SHOWN() {
      return il.shown;
    },
  };
});

const FORK = "Our pool program is Raydium's, with only its admin keys changed.";
const VAULT =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change its fee rates at once";
// The two lines the panel no longer says: the notice card at the top of the page says them.
const PRICE_MOVES = 'less than if you had just held both tokens';
const ROUTING = 'Jupiter does not send trades to these pools yet';
const IL_FIGURES =
  'a share is worth about 5.7% less than holding both; at four times or a quarter, about 20% less, before any fees it earns.';

const count = (text: string, needle: string) => text.split(needle).length - 1;

function panel(props: Partial<Parameters<typeof LpBeforeYouAdd>[0]> = {}) {
  render(<LpBeforeYouAdd launchPool={false} config={tier1Config()} enableCreatorFee={false} {...props} />);
  return screen.getByTestId('lp-before-you-add');
}

afterEach(() => {
  il.shown = true;
});

describe('LpBeforeYouAdd: each risk once', () => {
  it('says the fork line and the vault line once each', () => {
    const text = panel().textContent ?? '';
    expect(count(text, FORK)).toBe(1);
    expect(count(text, VAULT)).toBe(1);
  });

  it('no longer repeats the price-moves and routing lines the notice card carries', () => {
    const p = panel();
    expect(p).not.toHaveTextContent(PRICE_MOVES);
    expect(p).not.toHaveTextContent(ROUTING);
  });

  it('says the impermanent-loss sentence once, its percentages printed from the function', () => {
    const p = panel();
    expect(impermanentLossPctText(2)).toBe('5.7%');
    expect(impermanentLossPctText(4)).toBe('20%');
    expect(count(p.textContent ?? '', IL_FIGURES)).toBe(1);
    expect(p).toHaveTextContent('When the price moves, bots trade against the pool.');
    expect(p).toHaveTextContent('Jupiter does not send trades here yet, so fees come mostly from arbitrage.');
  });

  it('names the pairing coin when the caller gives it', () => {
    expect(panel({ coin: USDC_QUOTE })).toHaveTextContent('If the token’s price doubles or halves against USDC, a share is worth about 5.7% less');
  });

  it('without a coin it says "the coin it is paired with", never a guessed SOL', () => {
    const p = panel();
    expect(p).toHaveTextContent('If the token’s price doubles or halves against the coin it is paired with, a share is worth about 5.7% less');
    expect(p).not.toHaveTextContent('against SOL');
  });

  it('no forecast word, on a standard pool and on a launch pool', () => {
    expect(panel()).not.toHaveTextContent(FORECAST_WORDS);
    il.shown = true;
    render(<LpBeforeYouAdd launchPool config={null} enableCreatorFee={false} />);
    for (const p of screen.getAllByTestId('lp-before-you-add')) expect(p).not.toHaveTextContent(FORECAST_WORDS);
  });

  it('with IL_LINE_SHOWN false the panel carries no percentage and keeps the rest', () => {
    il.shown = false;
    const p = panel({ config: null });
    expect(p).not.toHaveTextContent('%');
    expect(p).toHaveTextContent(FORK);
    expect(p).toHaveTextContent(VAULT);
    expect(p).toHaveTextContent("This pool's fee settings could not be read");
  });
});

describe('LpReviewDisclosure: the fork line again, once', () => {
  it('a deposit review says the fork line and the vault line once each, and no percentage', () => {
    render(<LpReviewDisclosure kind="add" origin="standard" />);
    const r = screen.getByTestId('lp-review-disclosure');
    const text = r.textContent ?? '';
    expect(count(text, FORK)).toBe(1);
    expect(count(text, VAULT)).toBe(1);
    expect(r).not.toHaveTextContent('%');
  });
});
