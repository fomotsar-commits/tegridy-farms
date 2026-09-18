// WAVE SEVEN, element O: three forms, each true on its own evidence.
//
// Ruling 10 said "started today" unless a warm reading says otherwise, which
// is a false public sentence for a holder whose reading is merely uncached -
// and on the five Solana rooms it is almost always uncached. Session nine
// answered with silence; the island overruled that too, because silence loses
// the moment on most of O's reach. The third fixture below is the one that
// matters: no cached reading renders "is running", which claims nothing about
// when the clock started.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { HeatReading } from '../lib/heat/heatOracle';

const peekHeat = vi.fn<(address: string) => HeatReading | null>();
vi.mock('../lib/heat/heatClient', () => ({ peekHeat: (a: string) => peekHeat(a) }));

const { ClockLine } = await import('./ClockLine');
const { setLastBuy, readLastBuy } = await import('../lib/heat/lastBuy');

const BUYER = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

function reading(rows: string[]): HeatReading {
  return {
    address: BUYER,
    degrees: 12,
    tier: 'Ember',
    isCold: false,
    heldSinceUnix: 1739235449,
    asOfUnix: 1786104024,
    tokenCount: rows.length,
    observedAt: 1786104024,
    xHandle: null,
    breakdown: rows.map((tokenAddress) => ({
      tokenAddress,
      chain: 'ethereum',
      name: 'PEPE',
      symbol: 'PEPE',
      degrees: 12,
      firstSeenAtUnix: 1739235449,
      lastTransferAtUnix: 1786102091,
      retired: false,
    })),
  } as unknown as HeatReading;
}

const buy = { hash: '0xabc', symbol: 'PEPE', tokenAddress: PEPE, chain: 'ethereum' as const, buyer: BUYER, atUnix: 1786104000 };

beforeEach(() => {
  localStorage.clear();
  peekHeat.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe('the commitment line', () => {
  it('says nothing when no buy is latched', () => {
    peekHeat.mockReturnValue(reading([PEPE]));
    const { container } = render(<ClockLine />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads "is running" when the venue has no reading for the buyer', () => {
    // THE FIXTURE THE ISLAND NAMED. A two-year holder can never be shown
    // "started today" on the strength of a cache miss, and the venue cannot
    // fetch here, so the line claims nothing about when the clock began.
    setLastBuy(buy);
    peekHeat.mockReturnValue(null);
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE is running. Held time counts here.')).toBeTruthy();
    expect(screen.queryByText(/started today/)).toBeNull();
    expect(peekHeat).toHaveBeenCalledWith(BUYER);
  });

  it('reads "started today" on a cached COLD reading', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue({ ...reading([]), isCold: true, tokenCount: 0 });
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE started today. Held time counts here.')).toBeTruthy();
  });

  it('reads "keeps running" when the reading already holds this token', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE keeps running. Held time counts here.')).toBeTruthy();
  });

  it('reads "started today" when the reading holds other tokens but not this one', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading(['0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca']));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE started today. Held time counts here.')).toBeTruthy();
  });

  it('matches the token however the address is cased', () => {
    setLastBuy({ ...buy, tokenAddress: PEPE.toUpperCase().replace('0X', '0x') });
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE keeps running. Held time counts here.')).toBeTruthy();
  });

  it('opens the composer with the sentence and the read link, then says Posted.', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);

    const door = screen.getByRole('link', { name: 'Post' }) as HTMLAnchorElement;
    const text = decodeURIComponent(new URL(door.href).searchParams.get('text') ?? '');
    // The sentence plus the buyer's own read link, which the island ruled
    // carries the real number in every form. Nothing else rides along.
    expect(text).toContain('My clock on PEPE keeps running. Held time counts here.');
    expect(text).toContain(`/read/${BUYER}`);
    expect(door.target).toBe('_blank');

    fireEvent.click(door);
    expect(screen.getByText('Posted.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Post' })).toBeNull();
    // And it is remembered, so a remount does not offer the door again.
    expect(readLastBuy()?.posted).toBe(true);
  });

  it('is gone once the visitor walks into another room', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading([PEPE]));
    localStorage.setItem('tegridy-bungalow', 'bobo');
    const { container } = render(<ClockLine />);
    expect(container).toBeEmptyDOMElement();
  });
});
