// The swap form's one line about the 24h average: what it says in each state, that it says
// "above" or "below" and never a judgement, and that a read that failed is said as that.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SOL_MINT, USDC_MINT } from '../../lib/solana';
import { PairAverageLine, aboveBelowText, averageLineText, averagePriceText, type PairAverageTrade } from './PairAverageLine';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/solana/swap/pairAverage', async (orig) => ({
  ...(await orig<typeof import('../../lib/solana/swap/pairAverage')>()),
  fetchPairAverage: h.fetch,
}));

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const buyBayla: PairAverageTrade = { payMint: SOL_MINT, buyMint: BAYLA, paySymbol: 'SOL', buySymbol: 'BAYLA', payAmount: 0.0055, buyAmount: 1000 };
const baylaInSol = { kind: 'ok' as const, baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.000005 };

describe('averageLineText', () => {
  it('the average, then this trade above or below it', () => {
    expect(averageLineText(baylaInSol, buyBayla)).toBe('BAYLA 24h average: 0.000005 SOL · this trade 10.0% above');
    expect(averageLineText(baylaInSol, { ...buyBayla, payMint: BAYLA, buyMint: SOL_MINT, paySymbol: 'BAYLA', buySymbol: 'SOL', payAmount: 1000, buyAmount: 0.0049 }))
      .toBe('BAYLA 24h average: 0.000005 SOL · this trade 2.0% below');
  });
  it('the average alone when no trade is on the form', () => {
    expect(averageLineText(baylaInSol, { ...buyBayla, payAmount: null, buyAmount: null })).toBe('BAYLA 24h average: 0.000005 SOL');
  });
  it('SOL/USDC is said as SOL in USDC whichever way the trade goes', () => {
    const solInUsdc = { kind: 'ok' as const, baseMint: SOL_MINT, quoteMint: USDC_MINT, price: 107.61 };
    const buySol: PairAverageTrade = { payMint: USDC_MINT, buyMint: SOL_MINT, paySymbol: 'USDC', buySymbol: 'SOL', payAmount: 107.5, buyAmount: 1 };
    expect(averageLineText(solInUsdc, buySol)).toBe('SOL 24h average: 107.61 USDC · this trade 0.10% below');
  });
  it('each state that has no number says why, never a 0', () => {
    expect(averageLineText({ kind: 'thin' }, buyBayla)).toBe('BAYLA 24h average: not enough trading to average');
    expect(averageLineText({ kind: 'unread' }, buyBayla)).toBe('BAYLA 24h average: could not be read');
    expect(averageLineText({ kind: 'none' }, buyBayla)).toBe('BAYLA 24h average: no pool found for this pair');
    expect(averageLineText('loading', buyBayla)).toBe('BAYLA 24h average: …');
  });
  it('words and figures', () => {
    expect(aboveBelowText(0.001)).toBe('at the average');
    expect(aboveBelowText(-12.34)).toBe('12.3% below');
    expect(averagePriceText(0.0000052566)).toBe('0.000005257');
    expect(averagePriceText(107.6123)).toBe('107.61');
  });
});

describe('PairAverageLine', () => {
  // A block body: a function returned from beforeEach is run as its teardown.
  beforeEach(() => {
    h.fetch.mockReset();
  });

  it('shows the read average and keeps how it is worked out in a closed drop-down', async () => {
    h.fetch.mockResolvedValue(baylaInSol);
    render(<PairAverageLine trade={buyBayla} />);
    expect(await screen.findByText('BAYLA 24h average: 0.000005 SOL · this trade 10.0% above')).toBeInTheDocument();
    const box = screen.getByTestId('pair-average');
    expect(box.tagName).toBe('DETAILS');
    expect(box).not.toHaveAttribute('open');
    expect(box).toHaveTextContent(/at least 20 trades and \$1,000 of trading in 24 hours/);
    expect(box).toHaveTextContent(/never stops or changes a trade/);
    expect(box.textContent ?? '').not.toMatch(/fair|good|—/i);
  });

  it('a read that failed is tried again after 30 seconds; a number, after 2 minutes', async () => {
    vi.useFakeTimers();
    try {
      h.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(baylaInSol);
      render(<PairAverageLine trade={buyBayla} />);
      const line = () => screen.getByTestId('pair-average-line').textContent;
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(line()).toBe('BAYLA 24h average: could not be read');
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(line()).toBe('BAYLA 24h average: 0.000005 SOL · this trade 10.0% above');
      await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(h.fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read that threw is "could not be read"', async () => {
    h.fetch.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    render(<PairAverageLine trade={buyBayla} />);
    expect(await screen.findByText('BAYLA 24h average: could not be read')).toBeInTheDocument();
  });
});
