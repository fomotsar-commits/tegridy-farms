// Every slider an instrument lays over its picture carries 16px text.
//
// A slider is not typed in, so a phone does not zoom on it. But the LP pages' own phone guard
// (e2e-solana/fixtures/ui.ts, expectPressableAtSizes) measures every input that is not a
// radio or a checkbox and refuses one under 16px, and it runs only on the local-validator
// job, 40 minutes in. The first dial inherited its card's 11px and failed there. This pins
// it where a unit run sees it.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseEther } from 'viem';
import { PriceMoveDial } from './PriceMoveDial';
import { PoolTradeDial } from './PoolTradeDial';
import { RangeDrag } from '../range/RangeDrag';
import { LoanTimeline } from '../../nftfinance/LoanTimeline';
import { FloorBar } from '../../nftfinance/FloorBar';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';

const view = { config: { tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n }, quote: SOL_QUOTE, quoteReserve: 100_000_000_000n, tokenReserve: 1_000_000n } as unknown as PoolView;
const cost = () => ({ total: parseEther('1'), interest: 0n, toVenue: 0n, toLenders: parseEther('1') });

describe('instrument sliders are 16px, as the phone guard requires of every input', () => {
  it.each([
    ['PriceMoveDial', <PriceMoveDial quoteSymbol="SOL" />],
    ['PoolTradeDial', <PoolTradeDial view={view} creatorFeeRate={0n} />],
    ['RangeDrag', <RangeDrag now={0.0004} lo={0.0002} hi={0.0008} at="this pool’s price" setMin={() => {}} setMax={() => {}} />],
    ['LoanTimeline', <LoanTimeline side="borrower" start={1_800_000_000} duration={30 * 86_400} costAt={cost} nft="NAKA #1" />],
    ['FloorBar', <FloorBar symbol="NAKA" principal={0.07} floor={0.08} bestBid={0.075} setPrincipal={() => {}} />],
  ])('%s', (_name, element) => {
    render(element);
    const sliders = screen.getAllByRole('slider') as HTMLInputElement[];
    expect(sliders.length).toBeGreaterThan(0);
    for (const s of sliders) expect(s.style.fontSize).toBe('16px');
  });
});
