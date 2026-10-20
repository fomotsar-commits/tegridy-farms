// THE VAULT'S 48-HOUR WAIT. Since Squads #14 (2026-10-19) the multisig's time lock is 172,800 s
// (read on chain 2026-10-20, finalized slot 459,251,370), so every vault action runs 48 hours
// after its second approval at the earliest. Every Risks list that says what the vault can do
// says the wait, and none still says it acts at once.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { LpBeforeYouAdd, LpBeforeYouOpen, LpReviewDisclosure, RISK_SHORT } from './LpDisclosures';

const TIER: AmmConfigView = {
  address: 'tier', index: 1, disableCreatePool: false, tradeFeeRate: 2500n, protocolFeeRate: 104_000n,
  fundFeeRate: 56_000n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'vault', fundOwner: 'workshop',
};
const SAYS_NO_WAIT = /at once|no waiting period|time lock of 0/i;
const VAULT_WAIT = 'Each change waits 48 hours after both have signed.';

const SURFACES = {
  'the Add liquidity form': () => <LpBeforeYouAdd launchPool config={TIER} enableCreatorFee={false} />,
  'the Open a pool form': () => <LpBeforeYouOpen fee={150_000_000n} neverRefunded={null} />,
  'the review of an add': () => <LpReviewDisclosure kind="add" origin="launch-pool" />,
  'the review of an opening': () => <LpReviewDisclosure kind="create" />,
};

describe('the vault waits 48 hours, and every Risks list says so', () => {
  it('the short sentence says what the vault can do, and when', () => {
    expect(RISK_SHORT).toContain('can pause removing, change fees or replace the program, 48 hours after both its keys approve.');
    expect(RISK_SHORT).not.toMatch(SAYS_NO_WAIT);
  });

  for (const [where, draw] of Object.entries(SURFACES)) {
    it(`on ${where}`, () => {
      const text = render(draw()).container.textContent ?? '';
      expect(text).toContain(VAULT_WAIT);
      expect(text).not.toMatch(SAYS_NO_WAIT);
    });
  }

  it('the fee-tier line says a change to the rates waits too, then reaches what is already in', () => {
    const text = render(<LpBeforeYouAdd launchPool={false} config={TIER} enableCreatorFee={false} />).container.textContent ?? '';
    expect(text).toContain("The vault can change that tier's rates. A change waits 48 hours after both its keys approve, then applies to what you put in too.");
  });
});
