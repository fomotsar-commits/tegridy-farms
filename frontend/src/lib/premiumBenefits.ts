/**
 * Gold Card benefit copy, conditioned on what the ETH fee rail has actually paid.
 *
 * HONESTY PASS 2026-07-31: the "Real ETH yield" card was a flat literal that read
 * "Gold Card holders earn ETH from protocol swap fees — real revenue, not emissions"
 * on a page charging a real monthly TOWELI fee, while RevenueDistributor's
 * `totalDistributed` was still 0 — i.e. the rail had never paid anyone, ever. The
 * mechanism is real and wired; the past-tense "earn" was not yet true.
 *
 * So the claim now follows the chain: once a distribution lands it reads as the plain
 * benefit it is, and until then it says the rail exists and has not paid yet. Same
 * self-gating rule as <RealYieldProof/>, which renders nothing until totalDistributed > 0.
 * While the read is still in flight we do NOT assert either way.
 */
export interface GoldCardBenefit {
  icon: string;
  title: string;
  desc: string;
}

export interface EthYieldState {
  /** Cumulative ETH distributed by RevenueDistributor. */
  ethDistributed: number;
  /** True while the on-chain read is still in flight — assert nothing yet. */
  isLoading: boolean;
}

// The fee discount is not in the contract, "priority gas" is not a real mechanic, and
// Smart Alerts + Advanced Analytics ship free to every wallet (2026-07-18 honesty pass).
// Only the two genuinely real mechanics live here.
const JBAC_BENEFIT: GoldCardBenefit = {
  icon: '\u{1F451}',
  title: 'JBAC Lifetime Access',
  desc: 'Jungle Bay Ape Club holders get permanent Gold Card access — no subscription needed.',
};

export function goldCardBenefits({ ethDistributed, isLoading }: EthYieldState): GoldCardBenefit[] {
  const paid = Number.isFinite(ethDistributed) && ethDistributed > 0;
  const ethYield: GoldCardBenefit = {
    icon: '\u{1F4B0}',
    title: paid ? 'Real ETH yield' : 'ETH yield — not yet paid',
    desc: isLoading
      ? 'Like every staker, Gold Card holders share the protocol’s ETH swap-fee revenue. Reading the distributor…'
      : paid
        ? 'Like every staker, Gold Card holders earn ETH from protocol swap fees — real revenue, not emissions.'
        : 'The rail is live and every protocol swap fee routes to it on-chain, but it has distributed 0 ETH so far — the Gold Card buys you no yield today. Verify the cumulative on Etherscan before you subscribe.',
  };
  return [ethYield, JBAC_BENEFIT];
}
