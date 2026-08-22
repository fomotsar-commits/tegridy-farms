# Tegridy Farms FAQ

## What is TOWELI?
TOWELI is the native utility and governance token of the Tegridy Farms ecosystem. It powers staking, LP farming, NFT lending collateral, gauge voting, fee discounts, and access to creator features across the protocol.

## How do I get it?
TOWELI can be acquired by swapping on the native AMM, earned through LP farming rewards, staking boosts, creator royalties, or referral rebates. Airdrops and grant distributions also seed initial supply to early participants.

## Is it audited?
Internally, not externally. The core contracts (TegridyLPFarming, TegridyNFTLending, GaugeController, TegridyDropV2) have been reviewed in-house and findings are tracked in AUDIT_FINDINGS.md and SPARTAN_AUDIT.txt. **No third-party audit has been commissioned or completed.** The contracts are live on Ethereum mainnet today, so treat that as an unaudited deployment, not as an audit that is still pending.

## How are fees distributed?
Swap fees are aimed at veTOWELI stakers, but **not the whole fee, and not yet.** On the live `SwapFeeRouter`, `stakerShareBps` is `10000` and `polShareBps` is `0`, so nothing is split off to the treasury or to protocol-owned liquidity *at that step*. Those levers are timelocked and would need a governance change to move; the floor is `MIN_STAKER_SHARE_BPS = 5000`, so the staker share can never drop below 50%.

The step before it is the one that matters. `_recordReferralFee` hands the **entire** fee to `ReferralSplitter` at swap time, and the splitter keeps `referralFeeBps` — **20% today** — for the swapper's referrer, or for the treasury when there is no qualified referrer. Either way that slice is not staker yield, and it is not a knob that can be turned off: `proposeReferralFee` rejects `0` (`FEE_CANNOT_BE_ZERO`) and `SwapFeeRouter.applyReferralSplitter(address(0))` reverts `ReferralFeeNonZero()` while the share is above zero, so the splitter cannot be unwired either. The other ~80% is credited back to the router as `callerCredit` and moves only when someone calls the **permissionless** `recoverCallerCredit()`.

Two things to be clear about. First, **the rail has collected and has still distributed nothing**: fees have accrued, the whole balance is sitting in `ReferralSplitter` because `recoverCallerCredit()` has never been called, and `RevenueDistributor.totalDistributed()` reads `0`. No staker has ever been paid. (That is a statement about the mechanism on purpose — a wei figure would be stale after the next swap.) Second, **the protocol burns nothing** — but the live token *can* be burned: `burn(uint256)` and `burnFrom(address,uint256)` are both present in the deployed bytecode, so any holder may destroy their own TOWELI. 1,000,000,000 is the ceiling, not a constant. A *protocol* burn or buyback path would still need governance and new code. See [TOKENOMICS.md](TOKENOMICS.md) for the canonical breakdown of where each fee surface routes today.

## What's the boost?
Stakers who lock TOWELI earn a 0.4×–4.0× boost on LP rewards depending on lock duration, plus an additional +0.5× if they hold a JBAC NFT (ceiling 4.5×). Boost magnitude scales with lock duration and veTOWELI balance, rewarding long-term aligned participants. See [TOKENOMICS.md](TOKENOMICS.md) for the full boost curve.

## What happens if I unstake early?
You pay a **flat 25% penalty on the principal you withdraw**, and the full penalty is transferred to the protocol treasury. It does not shrink as your lock approaches maturity, and it is not recycled to the stakers who stayed. Source: `EARLY_WITHDRAWAL_PENALTY_BPS = 2500` in `contracts/src/TegridyStaking.sol`, with the penalty sent by `safeTransfer(treasury, penalty)`. If your lock has already expired, use `withdraw()` instead — that path charges nothing.

## Is lending liquidation-free?
Tegridy NFT Lending uses fixed-term loans with no margin-call liquidations. If a borrower defaults at maturity, the NFT transfers to the lender — there are no surprise liquidations from oracle volatility mid-loan.

## Who controls the multisig?
It depends on the contract, and it is not one multisig. Read back on-chain 2026-08-06:

- **Treasury** `0x7D26…Bd7d` is a Safe with `getThreshold() == 2` over **2 owners** — a 2-of-2, not a 4-of-7. It is what `SwapFeeRouter.treasury()` and `TegridyStaking.treasury()` both point at.
- **Most protocol contracts** (staking, LP farming, gauge controller, vote incentives, NFT lending, launchpad, premium access) are owned by `0x1489…456E`, which has **no code** — it is a plain EOA, not a Safe. On-chain timelock delays gate the privileged actions on those contracts (24–48h depending on the contract — see `DEPLOY_RUNBOOK.md`), but a single key can still initiate all of them.
- **TegridyNFTPoolFactory** is the exception: owner `0xA360…b7F8` is a 2-of-3 Safe.

Migrating the remaining EOA-owned contracts to a Safe is outstanding work tracked in `NEXT_SESSION.md` and `FIX_STATUS.md`. Note that Safe signer rotations and threshold changes are Safe-internal operations — the GaugeController does not and cannot gate them.

## Is there a mobile app?
No. The web app is fully responsive and optimized for iPhone 14+ and iPad. A dedicated iOS and Android app is an aspiration on the roadmap — no work has started on one.

## Is there a Base L2 plan?
Nothing is deployed on Base today. The only chains this repo has ever broadcast to are Ethereum mainnet (chainId 1) and Sepolia — there is no Base contract, no bridge and no cross-chain gauge voting, and no dated commitment to build them.

## How do I become a creator?
Creators apply via the in-app creator portal with a sample collection, social links, and a short pitch. Approved creators can mint drops via the V2 launchpad (TegridyDropV2), earn royalties, and qualify for grant matching from the treasury.

## How do I refer?
Generate a referral link from your profile page. Referees who stake, farm, or mint earn you a share of protocol fees from their activity for a fixed term. Referral rebates are claimable weekly from the dashboard.

## What's the grant program?
The Tegridy Grants program allocates treasury funds quarterly to builders, creators, and community contributors. Apply via the governance forum with scope, milestones, and budget. Approved grants vest on milestone completion verified by the multisig.
