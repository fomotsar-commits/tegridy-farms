// WAVE SEVEN, element O: the commitment line, and the one claim it must never make.
//
// The island ruled the default "started today". A cache MISS is not a cold
// wallet, though - it is the venue not having read the buyer - and on the five
// Solana rooms it misses almost always, because the room's card reads the
// connected EVM address and never the Solana pubkey. So the miss renders
// nothing, and the test that says so is the point of this file.

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

  it('says NOTHING when the venue has not read the buyer', () => {
    // The ruled default would print "started today" here. The venue does not
    // know that: it has no reading. A holder of two years would be told their
    // clock started today, in a sentence built to be posted.
    setLastBuy(buy);
    peekHeat.mockReturnValue(null);
    const { container } = render(<ClockLine />);
    expect(container).toBeEmptyDOMElement();
    expect(peekHeat).toHaveBeenCalledWith(BUYER);
  });

  it('reads "keeps running" when the reading already holds this token', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE keeps running.')).toBeTruthy();
  });

  it('reads "started today" when the reading holds other tokens but not this one', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading(['0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca']));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE started today.')).toBeTruthy();
  });

  it('matches the token however the address is cased', () => {
    setLastBuy({ ...buy, tokenAddress: PEPE.toUpperCase().replace('0X', '0x') });
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);
    expect(screen.getByText('My clock on PEPE keeps running.')).toBeTruthy();
  });

  it('opens the composer with the sentence and nothing else, then says Posted.', () => {
    setLastBuy(buy);
    peekHeat.mockReturnValue(reading([PEPE]));
    render(<ClockLine />);

    const door = screen.getByRole('link', { name: 'Post' }) as HTMLAnchorElement;
    const text = decodeURIComponent(new URL(door.href).searchParams.get('text') ?? '');
    expect(text).toBe('My clock on PEPE keeps running.');
    // The buyer's address is theirs to hand over, and this never does it.
    expect(door.href).not.toContain(BUYER);
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
