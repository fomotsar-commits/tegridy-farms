# User-Value Roadmap — Battle-Tested Enhancements

> **Status:** Research / strategy reference. Created 2026-06-01.
> **Purpose:** Catalogue every credible way to make Tegridy Farms more beneficial for users, with each idea grounded in an audited, billion-dollar-protocol precedent and graded against the project's **minimal-attack-surface mandate**.
> **Companion to:** [`ROADMAP.md`](../ROADMAP.md) (forward plan), [`REVENUE_ANALYSIS.md`](../REVENUE_ANALYSIS.md) (fee calibration), [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
> **Methodology:** One internal map of the live frontend / contracts / off-chain infra, plus six parallel web-research sweeps (automation, liquid lockers, lending pools, DEX intents/MEV, account abstraction, governance/retention) and one oracle feasibility spike. Sources inline per item.

This doc does **not** authorize implementation. It ranks options so the team can greenlight per batch (per the security-hardening check-in cadence). Nothing here changes a contract without a dedicated audit pass.

---

## TL;DR — two framing truths

1. **Most of the feature surface is built-but-dark.** Per [`frontend/src/lib/constants.ts`](../frontend/src/lib/constants.ts), the `isDeployed()` gate zeroes nine surfaces for the relaunch: **LP Farming, Gauge voting, Community Grants, Meme Bounty, Vote Incentives, Premium, ERC-20 Lending, NFT Lending, NFT-AMM/Launchpad**. What a user can do *today*: **buy TOWELI (swap), stake/lock, restake, claim ETH revenue, set a referrer.** Everything else is tested-but-staged for post-MVP waves, each needing its own audit pass before going live.
2. **The best net-new value-adds add ~zero attack surface.** They are wallet-standard adoption, protocol *integrations*, and surfacing data you already index — all of which fit minimal-surface cleanly. The on-chain additions worth doing are all "copy a canonical contract verbatim, opt-in, core untouched."

**Highest-leverage single move:** finish the two relaunch gates already on the roadmap — **multisig + a paid human audit** — then deploy the already-built contracts and un-zero their addresses. That re-lights ~9 features you already wrote and tested. You're switching them on, not building them. (Premium is already 100% wired in the UI — [`usePremiumAccess.ts`](../frontend/src/hooks/usePremiumAccess.ts), [`PremiumPage.tsx`](../frontend/src/pages/PremiumPage.tsx) — and only needs a deployed address.)

---

## Tier 1 — Ship now · frontend / integration · ~zero new attack surface

Every item is battle-tested, integration-or-frontend only, and respects minimal-surface. These can be built largely independent of the relaunch deploy state and light up as contracts go live.

### A. Transaction UX — collapse signatures and clicks

| Move | Battle-tested source | User value | New surface |
|---|---|---|---|
| **EIP-5792 batched tx** (wagmi [`useSendCalls`](https://wagmi.sh/react/api/hooks/useSendCalls) / `useCapabilities`) | [EIP-5792](https://eips.ethereum.org/EIPS/eip-5792); live on mainnet in MetaMask (via [EIP-7702](https://ethereum.org/roadmap/pectra/7702/)) + Coinbase Smart Wallet | approve+swap, approve+stake, claim+restake → **one click** vs up to 4 sigs | **None** — batches calls to existing contracts; feature-detect with graceful sequential fallback |
| **EIP-2612 permit single-sig** (TOWELI already implements it) | [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) | removes the standalone `approve` tx | **None** — fold `permit` into the batch |
| **One-click MEV-protection RPC** ([`wallet_addEthereumChain`](https://eips.ethereum.org/EIPS/eip-3085)) | [MEV Blocker](https://docs.mevblocker.io/) (CoW DAO + Beaver) 90/10 backrun rebate; [Flashbots Protect](https://docs.flashbots.net/flashbots-protect/overview) | kills sandwich attacks on swaps/stakes, can pay users a rebate | **None** — user-confirmed wallet prompt; pin canonical endpoint, never proxy |
| **Multicall3 read-batching** in wagmi/viem | [Multicall3](https://github.com/mds1/multicall3) (canonical `0xcA11…`) | fewer RPC round-trips → faster, fresher UI | **None** — client config. *Deferred:* the wagmi `batch` option couldn't be verified in-repo without risking the whole-app config; confirm the type, then enable. Reads only — never route writes through Multicall3 (`msg.sender` hijack). |

### B. Real limit orders / DCA / MEV — retire the browser-only hack

Today DCA and limit orders live only in browser `localStorage`, require the tab to stay open, and re-sign every fill ([`useLimitOrders.ts`](../frontend/src/hooks/useLimitOrders.ts), [`useDCA.ts`](../frontend/src/hooks/useDCA.ts)). **Integrate [CoW Protocol](https://docs.cow.fi/)** (widget first, then [`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk)):

- User **signs once**; orders rest server-side and execute **tab-closed**.
- Fills are **MEV-protected by design** (batch auctions, coincidence-of-wants); **unfilled orders cost nothing**.
- DCA/TWAP becomes a single [ComposableCoW](https://docs.cow.fi/cow-protocol/reference/contracts/periphery/composable-cow) conditional order — **you write zero keeper/orderbook code.**
- Your [`aggregator.ts`](../frontend/src/lib/aggregator.ts) already lists `cowswap` as a quote source.

Alternatives ([UniswapX](https://github.com/Uniswap/UniswapX), [1inch Fusion](https://help.1inch.com/en/articles/9842591-what-is-1inch-fusion-and-how-does-it-work)) are equivalent in spirit; CoW's widget/SDK + ERC-1271 + ComposableCoW give the cleanest no-keeper integration.

### C. Surface what you already built (cheapest wins of all)

- **The Ponder indexer tracks everything the UI never shows** — staking actions, revenue epochs, swaps, pair events, timelock proposals, pause events. Wire up: a **leaderboard**, **portfolio/transaction history**, **APR/yield-trend charts**, and a **governance-transparency page**. **⚠ Blocked on infra:** the frontend has no indexer URL wired and there is no publicly-queryable Ponder endpoint yet ([`LeaderboardPage.tsx`](../frontend/src/pages/LeaderboardPage.tsx) literally says ranking "goes live when the Ponder indexer is publicly queryable"). **Prerequisite:** deploy the Ponder GraphQL endpoint + add `VITE_PONDER_INDEXER_URL`. Until then this is unbuildable, not just unbuilt.
- **Push-notification infra exists but nothing dispatches** — Supabase `push_subscriptions` table, `/api/push/subscribe`, `/api/push/test`, and client-side alerts in [`usePriceAlerts.ts`](../frontend/src/hooks/usePriceAlerts.ts). Add a background trigger → real alerts for "yield ready to claim," price targets, whale moves, and (post-relaunch) loan-health / liquidation warnings.
- **Add the documented-but-missing `GET /api/price/toweli`** endpoint (referenced in [`docs/API.md`](API.md), never implemented) — wraps the existing triple-leg oracle in [`useToweliPrice.ts`](../frontend/src/hooks/useToweliPrice.ts) so external integrators can read TOWELI/USD.
- **Publish a [DefiLlama dimensions adapter](https://docs.llama.fi/list-your-project/other-dashboards) + Dune dashboard.** For a "real yield" protocol, third-party-verified fee/revenue numbers are the strongest trust signal you have. The DefiLlama adapter is off-chain TypeScript that reads existing events — no contract changes. (Best done once relaunch addresses + real volume exist.)

### D. Governance UX (frontend now; lights up when gauges redeploy)

- **[Snapshot delegation](https://help.snapshot.box/en/articles/9839125-erc-20-votes-eip-5805-voting-strategy)** (non-custodial, zero Solidity) **solves "restakers can't vote" AND gives auto-recurring "vote once" UX** in one move — restaker weight is read from the contract's balance view; the team/keeper executes the published outcome on-chain through the existing `GaugeController`. This is the canonical fix and the textbook answer to "my asset is custodied elsewhere but I still want a say."
- **"Max-APR" vote+bribe view** — index `VoteIncentives` deposits ÷ gauge votes → a sortable $/vote leaderboard (the [Votium](https://docs.votium.app/faq/vlcvx-faq) / [Hidden Hand](https://medium.com/@multifarm_fi/hidden-hand-by-redacted-cartel-516ba4b5ebc8) / [Paladin Quest](https://docs.paladin.vote/quest-v2/overview) pattern) + **bulk-claim** + a **commit-reveal reveal-reminder** to cut your 2-tx voting drop-off.

### E. Onboarding & misc

- **Embedded fiat on-ramp** ([Coinbase Onramp `<FundButton/>`](https://docs.base.org/onchainkit/fund/fund-button), MoonPay, Transak, or an aggregator) — card → funded wallet without leaving the app; provider is merchant-of-record so **no custody/KYC burden on Tegridy**.
- **Relock reminder + one-click "extend lock"** — watch positions nearing expiry and prompt before boost silently decays toward 0.4× (the chore Convex vlCVX is criticized for). Off-chain.
- **Zap-in via [Enso](https://docs.enso.build/) / 1inch API** (single asset → LP → farm in one tx). **Integrate, don't build** (see Avoid).

---

## Tier 2 — High value · opt-in · new-but-verbatim surface · needs the audit wave

| Move | Copy verbatim from | User value | Why it's contained |
|---|---|---|---|
| **Opt-in ERC-4626 auto-compounder over LP Farming** with permissionless `harvest()` + caller reward | [Yearn V3 `TokenizedStrategy`](https://github.com/yearn/tokenized-strategy/blob/master/SPECIFICATION.md) (preferred) or [Beefy](https://docs.beefy.finance/developer-documentation/strategy-contract) | turns manual-claim APR into **compounded APY — the single biggest yield uplift available**; bots self-harvest for the reward, so no team keeper | opt-in wrapper, **core contracts untouched**; the risky 4626 accounting is the shared, already-audited contract |
| **Gasless via a provider paymaster** (EIP-7702 + [Pimlico](https://docs.pimlico.io/guides/eip7702/external) / Alchemy / Coinbase CDP) | hosted ERC-4337/7702 paymasters | no ETH-for-gas; pay gas in TOWELI/USDC | **no Tegridy paymaster contract** — use the audited hosted one; never self-host |
| **Morpho Blue TOWELI/ETH lending market** (instant ERC-20 liquidity alongside P2P) | [Morpho Blue](https://morpho.org/blog/morpho-blue-and-how-it-enables-our-vision-for-defi-lending/) — ~650-line immutable singleton, formally verified | instant borrow against TOWELI/LP at an algorithmic rate vs P2P "wait for a counterparty" | **integrate the existing deployment, don't fork** — **gated on the oracle (see spike result below): currently DEFER** |

**Mandatory guardrails for the auto-compounder (verbatim, no improvising):** OZ virtual-shares [ERC-4626](https://docs.openzeppelin.com/contracts/5.x/erc4626) inflation-attack defense + dead-shares seed mint; `minAmountOut` slippage on the harvest swap routed through [Flashbots Protect](https://docs.flashbots.net/flashbots-protect/overview); Yearn's **profit-unlock buffer**; Beefy's **`harvestOnDeposit`**. Route any performance fee to `RevenueDistributor` as real yield (and fund the public-harvest caller reward from it).

---

## Tier 3 — Phase-later · protocol-sized surface · gate behind the V4 wall (mainnet V2 + TVL + dedicated audit)

- **Liquid locker / `stTOWELI`** ([Convex](https://docs.convexfinance.com/convexfinance/general-information/why-convex/understanding-cvxcrv.md) / [Aura](https://docs.aura.finance/developers/frequently-asked-questions) / [Stake DAO](https://docs.stakedao.org/liquidlockers) pattern) — the *correct, most-proven* cure for the lock-vs-liquidity-vs-governance trilemma: a fungible, composable, auto-compounding ERC-4626 wrapper over a max-locked position, with protocol-aggregated voting (and an optional Votium-style vote market). **But** it is a multi-contract subsystem and imports a **permanent, structural depeg risk** ([cvxCRV traded 50–70% under 2024 stress](https://geeogi.com/articles/cvxcrv-peg)) that makes the wrapper dangerous as naively-priced collateral. If pursued, use [Stake DAO's vote-replication](https://news.curve.finance/liquid-lockers-and-community-boosts/) variant so holders stay liquid *and* keep voting. Ship only with a funded peg pool + fee buyback + a peg-aware oracle. Gate exactly like your V4 migration.
- **Streaming `RevenueDistributor`** ([Synthetix `StakingRewards`](https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol) continuous accrual — math you already run in LP Farming) — strictly better than 4h epoch latency, but a core rewrite + re-audit of a currently-frozen contract. Defer to the next versioned upgrade; reuse the in-repo LP-Farming accumulator.
- **Embedded/social-login wallets** ([Privy](https://www.dynamic.xyz/blog/embedded-wallets-with-social-login-the-standard-for-web3-onboarding) / Dynamic, non-custodial) — widens the funnel to non-crypto users; additive RainbowKit connector, after batching lands. Preserve existing self-custody wallets.

---

## Explicitly AVOID (research flagged these as gimmicky or dangerous — all sourced)

- **Multiplier points (GMX-style).** GMX's own governance [**killed them in May 2024**](https://gov.gmx.io/t/reduce-apr-of-multiplier-points/3214) as disguised dilution that captured ~50% of fees and entrenched early stakers. Hard stop — especially for a fixed-supply token.
- **Points-as-implied-airdrop programs.** Off-brand for fixed-supply real-yield and reads as a Ponzi tell. Keep tiers (PremiumAccess) tied to *real* perks: fee discounts, access, capped fee-share referrals. ([Cointelegraph: real yield vs Ponzi](https://cointelegraph.com/magazine/defi-abandons-ponzinomics-real-yield/))
- **Custom zap router or self-hosted paymaster.** The [OpenZeppelin Beefy-zap audit](https://www.openzeppelin.com/news/beefy-zap-audit-1) found a CRITICAL arbitrary-call drain in exactly this pattern. **Integrate Enso/1inch and a provider paymaster instead.**
- **Oracle-pooled NFT lending (BendDAO-style).** BendDAO [nearly went insolvent in 2022](https://www.coindesk.com/business/2022/08/22/bank-run-at-nft-lender-benddao-prompts-attempt-to-avert-another-liquidity-crisis), and Chainlink's NFT floor feeds are being [**deprecated**](https://docs.chain.link/data-feeds/deprecating-feeds). The best NFT lenders ([Blur Blend](https://www.paradigm.xyz/2023/05/blend), [MetaStreet](https://docs.metastreet.xyz/liquidity-layer/overview), [Gondi](https://docs.gondi.xyz/)) are all deliberately oracle-free P2P — which **validates your current design**. Keep NFT lending P2P.
- **Permit2 for the core flow.** Redundant — TOWELI already has EIP-2612 — and it would add surface. Keep Permit2 in reserve only for arbitrary third-party tokens.

---

## Suggested sequencing

1. **Off-chain trust + surface-what-exists:** push-alert dispatch now; indexer-powered leaderboard/history/analytics *once the Ponder endpoint is deployed*; DefiLlama/Dune once relaunch addresses exist.
2. **Transaction UX:** EIP-5792 batching + EIP-2612 single-sig + MEV-protection button + Multicall3 reads.
3. **CoW integration** to retire the browser-only limit/DCA hack.
4. **Onboarding:** fiat on-ramp + relock reminder + Snapshot delegation (when governance re-lights).
5. **After the paid audit:** opt-in LP-Farming auto-compounder. (Morpho lending — see oracle spike: defer.)
6. **Phase 7.x, dedicated audit:** liquid locker, streaming revenue.

---

## Open questions / gating spikes

- **Is there a manipulation-resistant TOWELI price source?**
  **SPIKE RESULT (2026-06-01): CONDITIONAL → currently DEFER.** `TegridyTWAP` ([`contracts/src/TegridyTWAP.sol`](../contracts/src/TegridyTWAP.sol)) is a well-hardened Uniswap-V2-style oracle (≤12h observation window, **20%-per-step deviation gate**, **10-ETH reserve floor**, dormancy-bypass cooldowns, sequencer checks), and it already backs lending collateral valuation via a 60-min rebootstrap cooldown ([`TegridyLending`](../contracts/src/TegridyLending.sol) `_positionETHValue`). The frontend triple-leg oracle ([`useToweliPrice.ts`](../frontend/src/hooks/useToweliPrice.ts): spot + TWAP + Chainlink ETH/USD + GeckoTerminal) is **fine for display pricing**. For a **Morpho Blue lending market** (liquidation-grade), the oracle's safety rests entirely on TOWELI/WETH pool depth, which the README calls "thin-liquidity" and for which no on-chain TVL is documented. Morpho's `IOracle.price()` (1e36-scaled) could wrap `consult()` in a ~50–100-line adapter, **but only if** pool TVL ≥ ~$500k (≥ ~150 ETH reserves), the 10-ETH reserve floor is governance-locked, **LLTV ≤ 65%**, and loan duration ≤ 90 days. **Recommendation:** keep ERC-20 lending P2P (`TegridyLending`, no oracle) for now; revisit Morpho post-relaunch once organic volume grows the pool — or pursue LP-token / stablecoin collateral, which have cleaner oracle stories.
- **Is `ReferralSplitter` commission capped as a %-of-realized-fees** (vs a flat/inflationary payout)? That determines whether a referral push passes the non-Ponzi test. Quick code check before any growth campaign.
- **Do any contracts rely on `tx.origin == msg.sender` for auth?** EIP-7702 breaks that assumption; confirm clean before promoting batched/7702 flows. (Your minimal-surface mandate already discourages the pattern.)

---

## Build log

**2026-06-01 — Tier-1 batch #1 (branch `feat/user-value-tier1`):**
- ✅ **MEV-protection RPC opt-in** — `frontend/src/lib/mevProtection.ts` (pure, tested) + `frontend/src/hooks/useMevProtection.ts` + `frontend/src/components/swap/MevProtectionPanel.tsx`, wired into the swap settings in `TradePage.tsx` (additive; does **not** touch the audited approve/swap money path). One-tap `wallet_addEthereumChain` with an honest manual-setup fallback. **Pending: your browser+wallet QA** (some wallets refuse a programmatic add for the default mainnet chain — the manual fallback covers that) and a mobile visual pass.
- ✅ **EIP-5792 capability foundation** — `frontend/src/lib/eip5792.ts` (pure capability-parsing + provider wrappers, tested). Wiring it into the swap/stake/claim flows for true one-click batching is the **next reviewed batch** (touches money paths → needs live-wallet QA; do not retrofit blind).
- Verified: `tsc --noEmit` clean, ESLint clean, 16/16 new unit tests pass.
- ⚠ **Indexer-surfacing not started** — blocked on a deployed public Ponder endpoint (see Tier 1.C).
- ⚠ **Multicall3 batching deferred** — wagmi `batch` config option unverified in-repo (whole-app blast radius); confirm the type first.

---

### Source index (canonical references)

Automation: [Yearn V3](https://github.com/yearn/tokenized-strategy/blob/master/SPECIFICATION.md) · [Beefy](https://docs.beefy.finance/developer-documentation/strategy-contract) · [Gelato](https://www.gelato.network/web3-functions) · [Chainlink Automation](https://docs.chain.link/chainlink-automation/overview/automation-economics) · [Synthetix StakingRewards](https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol)
Liquid lockers: [Convex](https://docs.convexfinance.com/convexfinance/general-information/why-convex/understanding-cvxcrv.md) · [Aura](https://docs.aura.finance/developers/frequently-asked-questions) · [Yearn yCRV](https://docs.yearn.finance/getting-started/products/ylockers/ycrv/ycrv-faq) · [Stake DAO](https://docs.stakedao.org/liquidlockers) · [cvxCRV peg](https://geeogi.com/articles/cvxcrv-peg) · [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626) · [OZ ERC-4626](https://docs.openzeppelin.com/contracts/5.x/erc4626)
Lending: [Morpho Blue](https://morpho.org/blog/morpho-blue-and-how-it-enables-our-vision-for-defi-lending/) · [Aave V3](https://aave.com/docs/aave-v3/overview) · [Compound V3](https://rareskills.io/post/compound-v3-contracts-tutorial) · [Euler V2](https://www.euler.finance/blog/euler-v2-the-new-modular-age-of-defi) · [Blur Blend](https://www.paradigm.xyz/2023/05/blend) · [MetaStreet](https://docs.metastreet.xyz/liquidity-layer/overview) · [Gondi](https://docs.gondi.xyz/) · [BendDAO crisis](https://fortune.com/crypto/2022/08/24/subprimate-crisis-how-monkey-jpegs-pushed-a-crypto-lender-to-the-brink-of-insolvency/) · [Chainlink NFT feed deprecation](https://docs.chain.link/data-feeds/deprecating-feeds)
DEX/UX: [CoW Protocol](https://docs.cow.fi/) · [ComposableCoW](https://docs.cow.fi/cow-protocol/reference/contracts/periphery/composable-cow) · [UniswapX](https://github.com/Uniswap/UniswapX) · [1inch Fusion](https://help.1inch.com/en/articles/9842591-what-is-1inch-fusion-and-how-does-it-work) · [MEV Blocker](https://docs.mevblocker.io/) · [Flashbots Protect](https://docs.flashbots.net/flashbots-protect/overview) · [Permit2](https://github.com/Uniswap/permit2) · [Multicall3](https://github.com/mds1/multicall3) · [Enso](https://docs.enso.build/)
Account abstraction: [EIP-5792](https://eips.ethereum.org/EIPS/eip-5792) · [wagmi useSendCalls](https://wagmi.sh/react/api/hooks/useSendCalls) · [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) · [EIP-7702](https://ethereum.org/roadmap/pectra/7702/) · [Coinbase Smart Wallet](https://github.com/coinbase/smart-wallet) · [Coinbase Onramp](https://www.coinbase.com/developer-platform/products/onramp) · [LI.FI widget](https://github.com/lifinance/widget)
Governance/retention: [Votium](https://docs.votium.app/faq/vlcvx-faq) · [Paladin Quest](https://docs.paladin.vote/quest-v2/overview) · [Aerodrome SPEC](https://github.com/aerodrome-finance/contracts/blob/main/SPECIFICATION.md) · [Snapshot delegation](https://help.snapshot.box/en/articles/9839125-erc-20-votes-eip-5805-voting-strategy) · [ERC-5805](https://eips.ethereum.org/EIPS/eip-5805) · [GMX rewards](https://docs.gmx.io/docs/tokenomics/rewards/) · [GMX killed multiplier points](https://gov.gmx.io/t/reduce-apr-of-multiplier-points/3214) · [Gains real yield](https://medium.com/gains-network/gns-single-sided-staking-real-yield-and-decentralization-e66d1089b664) · [DefiLlama adapter](https://docs.llama.fi/list-your-project/other-dashboards)

*Not financial advice. Every on-chain item above is gated on the project's audit cadence; nothing ships to mainnet without a per-feature review.*
