/**
 * Centralized copy for every action-button tooltip (P2-6 of the 30-day push).
 *
 * Each entry follows the pattern the brief specified:
 *   • What the action does (one sentence).
 *   • What it costs (gas + protocol fee where applicable).
 *   • Whether it's reversible.
 *
 * The shape is a typed map so call-sites can't typo a key. Tooltip text is
 * surfaced via the HTML `title` attribute on the underlying `<button>`
 * (free on desktop hover, free with screen readers via aria-describedby
 * pattern, zero JS cost on mobile). For richer per-button UI we already
 * have `InfoTooltip` in `components/ui/InfoTooltip.tsx`.
 *
 * KEEP this file the only source of action-button copy — auditing reads
 * each entry once instead of greping a hundred JSX nodes.
 */

export type TooltipKey =
  // ─── Swap / Trade ──────────────────────────────────────────────
  | 'swap.approve'
  | 'swap.execute'
  | 'swap.wrap'
  | 'swap.unwrap'
  | 'liquidity.add'
  | 'liquidity.remove'

  // ─── Staking ───────────────────────────────────────────────────
  | 'stake.approve'
  | 'stake.create'
  | 'stake.increase'
  | 'stake.extendLock'
  | 'stake.withdraw'
  | 'stake.earlyWithdraw'
  | 'stake.claim'
  | 'stake.autoMaxLock'

  // ─── Restaking ─────────────────────────────────────────────────
  | 'restake.deposit'
  | 'restake.withdraw'
  | 'restake.claimBase'
  | 'restake.claimBonus'
  | 'restake.claimAll'

  // ─── Revenue / Referrals ───────────────────────────────────────
  | 'revenue.register'
  | 'revenue.claim'
  | 'referral.setReferrer'
  | 'referral.claimRewards'

  // ─── NFT Launchpad ─────────────────────────────────────────────
  | 'launchpad.createCollection'
  | 'drop.mintPublic'
  | 'drop.mintAllowlist'
  | 'drop.mintDutch'
  | 'drop.refund'

  // ─── NFT Lending (P2P) ─────────────────────────────────────────
  | 'lending.createOffer'
  | 'lending.cancelOffer'
  | 'lending.acceptOffer'
  | 'lending.repay'
  | 'lending.claimDefault'

  // ─── NFT AMM ────────────────────────────────────────────────────
  | 'nftAmm.buyNFT'
  | 'nftAmm.sellNFT'
  | 'nftAmm.addLiquidity'
  | 'nftAmm.removeLiquidity'

  // ─── Governance + Gauges ───────────────────────────────────────
  | 'gauge.commitVote'
  | 'gauge.revealVote'
  | 'bribe.deposit'
  | 'bribe.claim'
  | 'grants.propose'
  | 'grants.vote'
  | 'bounty.create'
  | 'bounty.submit'
  | 'bounty.vote'

  // ─── Premium / Misc ────────────────────────────────────────────
  | 'premium.subscribe'
  | 'premium.claimNftAccess';

/**
 * The tooltip copy, single source of truth.
 *
 * Conventions:
 *   • "Gas only" → no protocol fee charged in-contract.
 *   • Specific protocol fees noted where they're material to the user's
 *     decision (e.g. the 25% staking early-exit penalty).
 *   • Reversibility line is always the LAST sentence so the user's eye
 *     lands on the safety bit.
 */
export const TOOLTIPS: Record<TooltipKey, string> = {
  // ─── Swap / Trade ──────────────────────────────────────────────
  'swap.approve':
    "Lets the router pull this token from your wallet for swaps. Gas only — no protocol fee. Reversible: revoke or re-approve any time.",
  'swap.execute':
    "Trades the input token for the output token at the displayed quote. Pays gas plus the DEX's 0.3% pool fee. NOT reversible once mined.",
  'swap.wrap':
    "Converts ETH 1:1 into WETH so it can flow through DEX paths. Gas only. Reverse with Unwrap any time.",
  'swap.unwrap':
    "Converts WETH 1:1 back to native ETH. Gas only. Reverse with Wrap any time.",
  'liquidity.add':
    "Deposits both tokens into the pool and mints LP tokens proportional to your share. Gas only — fees accrue inside the pool. Reverse by Removing liquidity.",
  'liquidity.remove':
    "Burns your LP tokens and returns the underlying pair plus accrued fees. Gas only. Reverse by Adding liquidity again.",

  // ─── Staking ───────────────────────────────────────────────────
  'stake.approve':
    "Lets the staking contract pull TOWELI from your wallet. Gas only — no protocol fee. Reversible: revoke or re-approve any time.",
  'stake.create':
    "Locks TOWELI for the chosen duration in exchange for a boosted voting position. Gas only. Lock cannot be shortened — early exit triggers a 25% penalty.",
  'stake.increase':
    "Adds more TOWELI to your existing lock without changing the unlock date. Gas only. The added amount is bound by the same lock you already accepted.",
  'stake.extendLock':
    "Pushes the unlock date further out to earn a bigger boost. Gas only. Cannot be undone — the new unlock date is final.",
  'stake.withdraw':
    "Returns your TOWELI after the lock expires. Gas only. Once withdrawn, the position is closed.",
  'stake.earlyWithdraw':
    "Closes the position before the unlock date. Forfeits 25% of the staked amount as a penalty plus gas. NOT reversible — once paid, the penalty is gone.",
  'stake.claim':
    "Pulls your share of pending TOWELI rewards into your wallet. Gas only. Reversible only by restaking the claimed amount.",
  'stake.autoMaxLock':
    "Toggles auto-renewal of your lock to the maximum duration each block. Gas only — flips a boolean on your position.",

  // ─── Restaking ─────────────────────────────────────────────────
  'restake.deposit':
    "Hands your staking NFT to the auto-compounder so future rewards are restaked automatically. Gas only. Reverse by withdrawing the NFT.",
  'restake.withdraw':
    "Returns the staking NFT to your wallet. Gas only. The compounder pauses for that position until you re-deposit.",
  'restake.claimBase':
    "Pulls the protocol-share TOWELI stream out of the compounder. Gas only.",
  'restake.claimBonus':
    "Pulls the boost-bonus TOWELI stream out of the compounder. Gas only.",
  'restake.claimAll':
    "Pulls every owed stream (base + bonus) in one tx. Gas only.",

  // ─── Revenue / Referrals ───────────────────────────────────────
  'revenue.register':
    "Registers your wallet with the revenue distributor so future fee splits include you. Gas only. One-time per wallet.",
  'revenue.claim':
    "Pulls your share of pending protocol-fee ETH into your wallet. Gas only — 100% of fees flow to stakers, no protocol cut here.",
  'referral.setReferrer':
    "Binds your wallet to a referrer so they earn the referral split on your future swaps. Gas only. Cannot be changed once set.",
  'referral.claimRewards':
    "Pulls earned referral rebates into your wallet. Gas only.",

  // ─── NFT Launchpad ─────────────────────────────────────────────
  'launchpad.createCollection':
    "Deploys a new ERC-721 collection from the V2 factory. Pays gas for the clone deploy. Collection is yours forever — transferable, not deletable.",
  'drop.mintPublic':
    "Mints from the public phase at the listed price. Pays the mint price + gas. NFT transfers to your wallet on confirm; not refundable once minted.",
  'drop.mintAllowlist':
    "Mints from the allowlist phase using your merkle proof. Pays the listed allowlist price + gas. Not refundable once minted.",
  'drop.mintDutch':
    "Mints at the current dutch-auction price (price decreases over time). Pays the live price + gas. Not refundable once minted.",
  'drop.refund':
    "Reclaims your ETH from a cancelled drop. Pays gas only. The mint price is fully refunded by the contract.",

  // ─── NFT Lending (P2P) ─────────────────────────────────────────
  'lending.createOffer':
    "Posts a loan offer against the specified NFT collection. Pays gas + locks your principal in escrow until accepted. Cancel the offer to recover the principal.",
  'lending.cancelOffer':
    "Withdraws an unaccepted loan offer. Returns your escrowed principal. Gas only.",
  'lending.acceptOffer':
    "Accepts a lender's offer, escrows your NFT as collateral, and credits you the principal. Gas only. Repay before deadline to recover the NFT.",
  'lending.repay':
    "Pays principal + accrued interest to redeem your NFT from collateral. Pays repayment + gas. Reverse only by re-borrowing.",
  'lending.claimDefault':
    "Lender claims the collateral NFT after the borrower misses the deadline. Gas only. Not reversible — collateral transfers permanently.",

  // ─── NFT AMM ────────────────────────────────────────────────────
  'nftAmm.buyNFT':
    "Buys the selected NFT(s) from the pool at the current spot price. Pays NFT price + pool fee (1–5%) + gas. Reverse only by selling back to the pool.",
  'nftAmm.sellNFT':
    "Sells the selected NFT(s) into the pool at the current bid. Receives pool payout minus the pool fee. Gas only.",
  'nftAmm.addLiquidity':
    "Deposits NFTs and/or ETH into the pool to earn pool fees on each trade. Gas only — your assets stay yours, just escrowed.",
  'nftAmm.removeLiquidity':
    "Withdraws your share of pool NFTs and ETH back to your wallet. Gas only.",

  // ─── Governance + Gauges ───────────────────────────────────────
  'gauge.commitVote':
    "Submits a sealed hash of your gauge weights for this epoch. Gas only. The actual weights stay hidden until you reveal them in the reveal window.",
  'gauge.revealVote':
    "Reveals your gauge weights during the reveal window so they count toward emissions. Gas only. Must match the committed hash exactly.",
  'bribe.deposit':
    "Adds a bribe to the gauge so voters this epoch earn it. Pays the bribe amount + gas. Unclaimed bribes can be refunded after the epoch closes.",
  'bribe.claim':
    "Pulls earned bribes for the gauges you voted on. Gas only.",
  'grants.propose':
    "Creates an on-chain grant proposal subject to veTOWELI voting. Gas only. Proposals can be cancelled before execution.",
  'grants.vote':
    "Casts your veTOWELI vote on a grant proposal. Gas only. Each wallet can vote once per proposal.",
  'bounty.create':
    "Posts a meme bounty with an attached reward pool. Pays the reward + gas. Unfilled bounties expire and refund.",
  'bounty.submit':
    "Submits an entry to a bounty. Gas only.",
  'bounty.vote':
    "Casts your veTOWELI vote on a bounty submission. Gas only.",

  // ─── Premium / Misc ────────────────────────────────────────────
  'premium.subscribe':
    "Buys a time-bounded premium-access subscription. Pays the subscription price + gas. Expires automatically — no recurring charge.",
  'premium.claimNftAccess':
    "Activates premium via JBAY Gold pass ownership. Gas only. Access lasts as long as you hold the NFT.",
};

/** Helper for call-sites: returns `TOOLTIPS[k]` typed as `string`. */
export function tooltip(key: TooltipKey): string {
  return TOOLTIPS[key];
}
