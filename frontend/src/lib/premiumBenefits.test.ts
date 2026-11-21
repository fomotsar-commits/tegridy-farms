import { describe, it, expect } from 'vitest';
import { GOLD_CARD_BENEFITS, GOLD_CARD_SUBHEAD, REVENUE_SHARING_SUBHEAD } from './premiumBenefits';

// Owner ruling 2026-11-15: every venue fee goes to the treasury Safe, so the Gold Card, which
// charges a real monthly TOWELI fee, has no share of swap fees to promise. Each Gold Card line
// says where the fee goes, and none says a holder or staker earns ETH from it.
const ALL = [GOLD_CARD_SUBHEAD, REVENUE_SHARING_SUBHEAD, ...GOLD_CARD_BENEFITS.flatMap((b) => [b.title, b.desc])];

describe('Gold Card copy', () => {
  it('the hero says swap fees go to the treasury and the card buys access, not yield', () => {
    expect(GOLD_CARD_SUBHEAD).toMatch(/swap fees go to the venue's treasury/i);
    expect(GOLD_CARD_SUBHEAD).toMatch(/access, not yield/i);
  });

  it('the Revenue Sharing line sends swap fees to the treasury, not to stakers', () => {
    expect(REVENUE_SHARING_SUBHEAD).toMatch(/treasury, not to stakers/i);
  });

  it('the card where ETH yield stood says the card pays no ETH', () => {
    expect(GOLD_CARD_BENEFITS[0]!.title).toBe('No share of swap fees');
    expect(GOLD_CARD_BENEFITS[0]!.desc).toMatch(/pays no ETH/);
  });

  it('keeps the JBAC lifetime-access benefit', () => {
    expect(GOLD_CARD_BENEFITS.map((b) => b.title)).toContain('JBAC Lifetime Access');
  });

  it('no line promises ETH income or a share of swap fees', () => {
    for (const line of ALL) {
      expect(line).not.toMatch(/earns? (?:real )?ETH|real ETH yield|in line for ETH|earmarked for stakers|distributed to stakers/i);
    }
  });
});
