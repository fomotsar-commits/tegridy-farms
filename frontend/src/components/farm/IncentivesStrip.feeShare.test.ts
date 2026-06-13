import { describe, it, expect } from 'vitest';
import { feeShareLabel } from './IncentivesStrip';

// F109 (T3): the "Fee Share" chip must derive from the live on-chain staker
// share (SwapFeeRouter.stakerShareBps) so it can't drift if governance retunes
// the split — while never rendering an empty/stale literal before the read lands.
describe('feeShareLabel (F109)', () => {
  it('falls back to the honest current default when the share is not yet loaded', () => {
    expect(feeShareLabel(undefined)).toBe('100% to stakers');
  });

  it('renders the live 100% share without a trailing ".00"', () => {
    // stakerShareBps = 10000 → 100
    expect(feeShareLabel(100)).toBe('100% to stakers');
  });

  it('reflects a retuned split read from chain (no frontend change needed)', () => {
    // stakerShareBps = 5000 → 50
    expect(feeShareLabel(50)).toBe('50% to stakers');
  });

  it('keeps two decimals for a non-integer share', () => {
    // stakerShareBps = 3333 → 33.33
    expect(feeShareLabel(33.33)).toBe('33.33% to stakers');
  });

  it('renders a real zero share distinctly (not as "no data")', () => {
    expect(feeShareLabel(0)).toBe('0% to stakers');
  });
});
