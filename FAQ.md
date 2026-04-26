# Tegridy Farms FAQ

## What is TOWELI?
TOWELI is the native utility and governance token of the Tegridy Farms ecosystem. It powers staking, LP farming, NFT lending collateral, gauge voting, fee discounts, and access to creator features across the protocol.

## How do I get it?
TOWELI can be acquired by swapping on the native AMM, earned through LP farming rewards, staking boosts, creator royalties, or referral rebates. Airdrops and grant distributions also seed initial supply to early participants.

## Is it audited?
Yes. The core contracts (TegridyLPFarming, TegridyNFTLending, GaugeController, TegridyDropV2) have been reviewed internally and findings are tracked in AUDIT_FINDINGS.md and SPARTAN_AUDIT.txt. External audits are scheduled pre-mainnet with a public report release.

## How are fees distributed (70/20/10)?
Protocol fees split as: 70% to stakers and LP providers as real yield, 20% to the treasury multisig for operations and grants, and 10% reserved for future tokenomics decisions via governance — there is currently **no protocol burn mechanism**. `Toweli.sol` exposes no `burn()` entrypoint and supply is fixed at 1,000,000,000. Any future burn or buyback path would have to go through governance and a contract upgrade. See [TOKENOMICS.md](TOKENOMICS.md) for the canonical breakdown of where each fee surface routes today.

## What's the boost?
Stakers who lock TOWELI earn a 0.4×–4.0× boost on LP rewards depending on lock duration, plus an additional +0.5× if they hold a JBAC NFT (ceiling 4.5×). Boost magnitude scales with lock duration and veTOWELI balance, rewarding long-term aligned participants. See [TOKENOMICS.md](TOKENOMICS.md) for the full boost curve.

## What happens if I unstake early?
Early unstaking from locked positions incurs a linear penalty that decreases as your lock approaches maturity. Penalty tokens are redistributed to remaining stakers, preserving incentives for committed holders and discouraging short-term extraction.

## Is lending liquidation-free?
Tegridy NFT Lending uses fixed-term loans with no margin-call liquidations. If a borrower defaults at maturity, the NFT transfers to the lender — there are no surprise liquidations from oracle volatility mid-loan.

## Who controls the multisig?
Migration to a **4-of-7 Gnosis Safe is planned (Wave 0 incomplete as of 2026-04-25)**. Today the protocol is administered by an EOA with on-chain timelock delays gating every privileged action (24–48h depending on the contract — see `DEPLOY_RUNBOOK.md`). Once the multisig is live, signer rotations and threshold changes will require on-chain governance approval via the GaugeController voting system. Status of the migration is tracked in `NEXT_SESSION.md` and `FIX_STATUS.md`.

## Is there a mobile app?
Not yet. The web app is fully responsive and optimized for iPhone 14+ and iPad. A dedicated iOS and Android app is on the roadmap post-mainnet, with wallet-connect integration and push notifications for positions.

## Is there a Base L2 plan?
Yes. Base deployment is planned after Ethereum mainnet launch stabilizes. Canonical bridge support, native AMM liquidity, and cross-chain gauge voting are all in scope for the Base rollout phase.

## How do I become a creator?
Creators apply via the in-app creator portal with a sample collection, social links, and a short pitch. Approved creators can mint drops via the V2 launchpad (TegridyDropV2), earn royalties, and qualify for grant matching from the treasury.

## How do I refer?
Generate a referral link from your profile page. Referees who stake, farm, or mint earn you a share of protocol fees from their activity for a fixed term. Referral rebates are claimable weekly from the dashboard.

## What's the grant program?
The Tegridy Grants program allocates treasury funds quarterly to builders, creators, and community contributors. Apply via the governance forum with scope, milestones, and budget. Approved grants vest on milestone completion verified by the multisig.
