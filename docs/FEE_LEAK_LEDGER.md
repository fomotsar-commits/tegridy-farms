# Fee-leak ledger — every value flow to a third party, priced and classified

**Audited 2026-08-22** (owner directive: "ensure all code we have isn't leaking money to the
apps that built the code — protect our fees from anyone besides our consumers and us").
Method: 4 audit rails over every integration, **every non-trivial claim adversarially
verified against deployed source or a live chain read** — 30 agents, 21 confirmed flows,
22 flows verified landing at OUR addresses, 5 claims refuted as unreachable.

**Headline: ZERO bug-leaks.** Nothing accidentally pays a third party. Every outbound flow
is a priced, documented toll of infrastructure we chose — and the four "avoidable" findings
are all the opposite problem: **our own fee left uncollected**, three of which are now
wired (dark) in code.

---

## Our fee not collected (the real findings — all money ON the table, not leaking off it)

| # | Where | What was missing | Status |
|---|---|---|---|
| L-1 | **CoW order flow** (market swaps, limit, TWAP, DCA) | No partner fee on any CoW-routed order — solvers settle with zero venue carve | **Wired dark**: `COW_PARTNER_FEE_BPS = 0` in cowProtocol.ts builds `metadata.partnerFee` into the appData doc + hash ATOMICALLY when flipped; bps=0 is pinned byte-identical to every order ever shipped. Flip = pricing decision (fee-table policy) + CoW schema/canary check. |
| L-2 | **Collection/trait offers** (Tradermigos) | Item offers carry our 1% WETH line; criteria offers shipped OpenSea's build verbatim — 0% | **Wired dark**: `CRITERIA_OFFER_PLATFORM_FEE_ENABLED = false` in api-offers.js appends the identical 1% line to both criteria paths. Flip ONLY after one live canary offer round-trips (OpenSea's criteria endpoint accepting an extra consideration item is unproven — breaking live offers to collect 1% is a bad trade). |
| L-3 | **ParaSwap venue-fee leg** | The one frontend-ready aggregator fee leg was silently stripped by our own proxy allowlist | **Fixed**: `partnerAddress`/`partnerFeeBps` admitted in api/aggregator.js. Inert until the operator sets the frontend dials. |
| L-4 | **Jupiter Trigger** (Solana limit orders) | v1 ships FEE-OFF; our integrator fee needs Jupiter referral accounts that don't exist yet | **Operator item M.14**: create the referral accounts, then attach fee params to createOrder. Jupiter's keeper fill fee remains their toll. |

## Required tolls (the price of infrastructure — each verified unavoidable at source level)

| Toll | Exact cost | Why unavoidable |
|---|---|---|
| Doppler Airlock migrate-fee | `max(5% of auction fees, 0.1% of proceeds)` capped at **20% of fees** — we keep **80–95%** as integrator, both sides, verified in deployed `_handleFees` | Computed inside the Airlock before any migrator sees funds. The fee-escape memory's "20% caps Doppler" is now source-verified, not remembered. ⚠️ A ZERO integrator address donates our 80-95% to Whetstone — the guard at launchService.ts:565 is load-bearing. |
| Doppler ≥5% locker line | 5% of streamed LP fees on locker-held positions; **our default is exactly the legal minimum** (re-proven live: 4% reverts `InvalidProtocolOwnerShares`, 5% passes) | Enforced in the whitelisted migrator's bytecode; our own migrator mirrors it because a petition asking Whetstone to delete their own revenue is a dead petition. |
| Stock V4 migrator splits + dust | Community tier: 100% LP locked under OUR constitution; Flagship: constitution governs the locked 10%, the launch's own timelock owns 90%. Migration dust → Whetstone on noOp graduations | Stock-module behavior until our migrator is whitelisted — one more reason the petition matters. |
| Meteora DBC (Solana) | **20% Meteora / 48% creator / 32% us** per trade fee — read from the live config | Their curve, their carve. The own-curve restart keeps 100% (standing verdict). |
| Uniswap V2 fee switch (ON) | 1/6 of LP-fee growth on the **canonical TOWELI/WETH pair** accrues to Uniswap's collector (`feeTo` set; setter is Uniswap governance) | Their pair, their switch. Every dollar of depth moved to OUR factory pair escapes it — the deep-pool intention now has a fee argument, not just a strategic one. |
| Uniswap V4 latent protocol fee | Currently **zero**; max 0.1%/direction, skimmed BEFORE our hook's fee if ever enabled by Uniswap governance | Monitorable, not controllable. Worth a watch-line in monitoring when hooked pools go live. |
| OpenSea 1% | Only on OpenSea-routed orders (their orderbook, their fee); our 1% rides alongside on item offers | Toll of their liquidity. Native orderbook path carries no OpenSea line. |
| Royalties (ERC-2981) | Creator-set, counterparty-funded, capped 25% in our NFT AMM | Paid to CREATORS (our consumers), never to code authors. |
| CoW solver fee / MEV Blocker `/fast` / Irys / on-ramp spreads | Solver gas, builder margin, storage price, card processing — user-side service costs; **MEV Blocker refunds go to the USER**, no affiliate params anywhere (grepped) | Aligned with "consumers and us": users get the refunds; nobody upstream gets a referral cut. |

## Verified ours (22 flows) & refuted (5)

Every SwapFeeRouter/ReferralSplitter/RevenueDistributor/LockerClaimer hop, LaunchpadV2's 5%,
RugEscrow's venue fee, the hook's POL skim recipient, integrator fee address (matches
addresses.json), Tradermigos item-offer 1% — all land at registry-pinned OUR addresses.
Refuted as unreachable: V2-rail locker flows (no Tegridy value passes), TopUpDistributor
(never invoked by our flows), FeeExecutorRouter + NativeBuyRouter (not deployed / draft),
the stranded Wave-0 hook (holds zero).

## Standing rules this audit adds

1. **Never launch with a zero integrator** — the Airlock substitutes its owner and our
   80-95% becomes Whetstone's 100%. The guard exists; never remove it.
2. **appData doc and hash move together, or not at all** — the dark-invariant test pins
   bps=0 to the historical byte-exact doc.
3. **New integrations get a fee-param grep before merge**: `referrer|affiliate|partner|
   platformFee|feeRecipient` — set ours or document the toll in this ledger.
