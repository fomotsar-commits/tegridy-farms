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

/**
 * The hero subhead, conditioned on the same read as the benefit card below.
 *
 * The 2026-07-31 pass conditioned the benefit CARD and left the hero line — the first
 * sentence on the page — as the flat literal "Back the protocol in TOWELI — and earn
 * real ETH from swap fees, like every staker." Verified on-chain 2026-08-01:
 * `SwapFeeRouter.totalETHFees()` is 0 and always has been, so on a page charging
 * 10,000 TOWELI/month the headline promise was the one thing a visitor read first and
 * the one thing that had never happened. Conditioning the card while the headline
 * still promised it is not a fix, so both now follow the same chain.
 */
export function goldCardSubhead({ ethDistributed, isLoading }: EthYieldState): string {
  if (isLoading) return 'Back the protocol in TOWELI. Reading what the ETH fee rail has distributed…';
  const paid = Number.isFinite(ethDistributed) && ethDistributed > 0;
  return paid
    ? 'Back the protocol in TOWELI — and earn real ETH from swap fees, like every staker.'
    : 'Back the protocol in TOWELI. The ETH swap-fee rail is live on-chain but has distributed nothing yet — today this buys access, not yield.';
}

/**
 * The "Revenue Sharing" section subhead on /premium.
 *
 * The 2026-08-01 pass conditioned the hero and the benefit card and left this one:
 * a flat "100% of protocol fees distributed to stakers", rendered DIRECTLY ABOVE the
 * live figures it contradicts — `0.0000 ETH` and `0 epochs`. Verified on-chain
 * 2026-08-04: `RevenueDistributor` holds 0 wei and `SwapFeeRouter.totalETHFees()` is
 * 0, as it always has been.
 *
 * The split itself is real and on-chain; what has never happened is a distribution.
 * So this states the policy in the tense that is true — a rule that governs fees when
 * they arrive — rather than a history that does not exist.
 */
export function revenueSharingSubhead({ ethDistributed, isLoading }: EthYieldState): string {
  if (isLoading) return 'Reading what the fee rail has distributed…';
  const paid = Number.isFinite(ethDistributed) && ethDistributed > 0;
  return paid
    ? '100% of protocol fees are distributed to stakers'
    : '100% of protocol fees are routed to stakers — none have been distributed yet';
}

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
