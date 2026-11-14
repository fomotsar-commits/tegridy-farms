// ONE THING, ONCE, IN ONE WORDING (two pre-merge reads, 2026-11-14). The LP Risks lists said the
// afford-to-lose warning and "no outside review" in lines 1 and 2 both, the 48-hour wait three
// times on Add liquidity, and one power in two wordings ("pause removing", "switch off
// withdrawals"; "keys approve", "have signed"). The first line's "our changes" also pointed at
// nothing: a stranger read it as the vault's own changes to the fees and the program.
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { LpBeforeYouAdd, LpBeforeYouOpen, LpReviewDisclosure, RISK_SHORT } from './LpDisclosures';
import { LpDisclosure } from './SolanaLpSection';

const TIER: AmmConfigView = {
  address: 'tier', index: 1, disableCreatePool: false, tradeFeeRate: 2500n, protocolFeeRate: 104_000n,
  fundFeeRate: 56_000n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'vault', fundOwner: 'workshop',
};
const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';

const LISTS = {
  'the Add liquidity form': () => <LpBeforeYouAdd launchPool config={TIER} enableCreatorFee={false} />,
  'the Open a pool form': () => <LpBeforeYouOpen fee={150_000_000n} neverRefunded={null} />,
  'the review of an add': () => <LpReviewDisclosure kind="add" origin="launch-pool" />,
  'the review of an opening': () => <LpReviewDisclosure kind="create" />,
  "the section's full notice": () => <LpDisclosure programId={PROGRAM} mode="on" bare />,
};
const said = (text: string, phrase: RegExp) => (text.match(new RegExp(phrase.source, `g${phrase.flags}`)) ?? []).length;
/** Every way the lists have said that no one outside checked the changes. */
const NO_REVIEW = /unaudited|independent review|outside firm/i;

describe('the first line says whose changes no outside firm has checked', () => {
  it('names them as our changes to Raydium\'s program, within 40 words', () => {
    expect(RISK_SHORT).toContain("Our changes to Raydium's program are unaudited.");
    expect(RISK_SHORT).not.toMatch(/checked our changes\./);
    expect(RISK_SHORT.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(RISK_SHORT).not.toContain('—');
  });
});

describe('each Risks list says each thing once, in one wording', () => {
  for (const [where, draw] of Object.entries(LISTS)) {
    it(`${where}: one afford-to-lose, one no-review, one wait`, () => {
      const text = render(draw()).container.textContent ?? '';
      expect(said(text, /afford to lose/)).toBe(1);
      expect(said(text, NO_REVIEW)).toBe(1);
      expect(text).toContain(RISK_SHORT);
      // The power to stop withdrawals has one name, and so does the vault's approval.
      expect(text).toContain('switch off withdrawals');
      expect(text).not.toMatch(/pause removing|switched? off removing|switched removing|adding, removing or trading/);
      expect(text).not.toMatch(/have signed|two signatures/);
      expect(text).not.toMatch(/upgrade the program/);
    });
  }

  it('the form lists keep the facts the repeats carried: the multisig, the other switch-offs, the fee to open, where a rate change lands', () => {
    const add = render(<LpBeforeYouAdd launchPool={false} config={TIER} enableCreatorFee={false} />).container.textContent ?? '';
    expect(add).toContain("The team's vault is a Squads multisig. It can also switch off deposits or swaps on this pool, and every action it takes has the same wait.");
    expect(add).toContain('If it switched off withdrawals, you could not take your money out until it switched them back on.');
    expect(add).toContain("If the vault changes that tier's rates, the change applies to what you put in too.");
    const open = render(<LpBeforeYouOpen fee={150_000_000n} neverRefunded={null} />).container.textContent ?? '';
    expect(open).toContain("It can also switch off deposits or swaps on this pool, or change the public fee tier's fee to open a pool; every action it takes has the same wait.");
  });

  it('the Open a pool list says once that anyone can open other pools, in its own words', () => {
    const view = render(<LpBeforeYouOpen fee={150_000_000n} neverRefunded={null} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain("Anyone can open other pools for this token, at any price. Yours will not be 'the' pool.");
    expect(said(text, /Anyone can open/)).toBe(1);
    expect(text).not.toContain('being listed here');
    view.unmount();
    // The Add list keeps the list's own line.
    const add = render(<LpBeforeYouAdd launchPool={false} config={TIER} enableCreatorFee={false} />).container.textContent ?? '';
    expect(add).toContain('Anyone can open a pool for any token, at any price, so being listed here does not make it "the" pool.');
  });
});

describe('a closed Risks box on the forms says it opens', () => {
  it('its summary draws the small print\'s arrow, and hides the browser\'s own marker', () => {
    for (const draw of [LISTS['the Add liquidity form'], LISTS['the Open a pool form']]) {
      const view = render(draw());
      const summary = within(view.container).getByText('Risks');
      expect(summary.tagName).toBe('SUMMARY');
      expect(summary.querySelector('svg[aria-hidden="true"] path')).toHaveAttribute('d', 'M9 6l6 6-6 6');
      expect(summary.className).toMatch(/\blist-none\b/);
      expect(summary.className).toContain('[&::-webkit-details-marker]:hidden');
      view.unmount();
    }
  });
});
