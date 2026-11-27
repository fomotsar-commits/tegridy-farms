// The "Fee tier" row on Open a pool and on both LP reviews (pre-merge read at 390 px, 2026-11-14):
// its value opened with a bare "1:" and wrapped to leave "trade" alone on a right-aligned second
// line. It now says "Tier 1:" and is two whole phrases, so a phone breaks it between them.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { Row } from './ui';
import { FeeTierValue } from './TxFlowView';

const TIER1: AmmConfigView = {
  address: 'tier1', index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 104_000n,
  fundFeeRate: 56_000n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'vault', fundOwner: 'workshop',
};

function value(config: AmmConfigView | null, enableCreatorFee = false) {
  const { container } = render(<Row label="Fee tier" value={<FeeTierValue config={config} enableCreatorFee={enableCreatorFee} />} mono={false} />);
  return container.querySelector('[data-review-line], div')!.children[1] as HTMLElement;
}

describe('the fee tier row', () => {
  it('names the tier in words, and holds each phrase whole', () => {
    const v = value(TIER1);
    expect(v.textContent).toBe('Tier 1: traders pay 1% a trade; LPs keep 0.840% of each trade, the venue 0.160%');
    expect(v.textContent).not.toMatch(/^\d+:/);
    const phrases = [...v.querySelectorAll(':scope > span.inline-block')].map((s) => s.textContent);
    expect(phrases).toEqual(['Tier 1: traders pay 1% a trade;', 'LPs keep 0.840% of each trade, the venue 0.160%']);
  });

  it('keeps the creator fee inside the first phrase, on a tier that charges one', () => {
    const v = value({ ...TIER1, index: 0, tradeFeeRate: 2_500n, creatorFeeRate: 500n }, true);
    expect([...v.querySelectorAll(':scope > span.inline-block')].map((s) => s.textContent)).toEqual([
      'Tier 0: traders pay 0.3% a trade (0.25% trade fee, 0.05% creator fee);',
      expect.stringMatching(/^LPs keep \d+\.\d{3}% of each trade, the venue \d+\.\d{3}%$/),
    ]);
  });

  it('says not read when the tier was not read', () => {
    expect(value(null).textContent).toBe('not read');
  });
});
