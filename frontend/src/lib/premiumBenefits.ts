/**
 * Gold Card copy. The card carries no share of swap fees: every venue fee goes to the treasury
 * Safe (owner ruling 2026-11-15). The Revenue Sharing section on /premium still reads, live,
 * what the stakers' payout contract has paid and what a referrer is owed.
 */
export interface GoldCardBenefit {
  icon: string;
  title: string;
  desc: string;
}

// The fee discount is not in the contract, "priority gas" is not a real mechanic, and
// Smart Alerts + Advanced Analytics ship free to every wallet (2026-07-18 honesty pass).
const JBAC_BENEFIT: GoldCardBenefit = {
  icon: '\u{1F451}',
  title: 'JBAC Lifetime Access',
  desc: 'Jungle Bay Ape Club holders get permanent Gold Card access — no subscription needed.',
};

// Where the ETH-yield card stood, so a subscriber reads what the card does not pay.
const NO_FEE_SHARE: GoldCardBenefit = {
  icon: '\u{1F4B0}',
  title: 'No share of swap fees',
  desc: "Swap fees go to the venue's treasury, so the Gold Card pays no ETH.",
};

/** The /premium hero line. */
export const GOLD_CARD_SUBHEAD =
  "Back the protocol in TOWELI. Swap fees go to the venue's treasury, so the Gold Card buys access, not yield.";

/** The "Revenue Sharing" section's line, above the live payout and referral figures. */
export const REVENUE_SHARING_SUBHEAD =
  "Swap fees go to the venue's treasury, not to stakers. Referrers still earn their share.";

export const GOLD_CARD_BENEFITS: readonly GoldCardBenefit[] = Object.freeze([NO_FEE_SHARE, JBAC_BENEFIT]);
