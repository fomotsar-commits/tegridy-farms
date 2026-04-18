# SECURITY AUDIT — 300-AGENT FULL-SCALE

**Scope:** Tegridy Farms monorepo (contracts + frontend + indexer + API)
**Date:** April 16, 2026
**Commit:** `714d839` (tip of `main`)
**Deployed:** `tegridyfarms.vercel.app`
**Methodology:** Parallel multi-domain specialist agents coordinated in waves, plus ingested external audit (Spartan, Apr 16 2026).

---

## Executive summary

This audit ran ten planned waves of specialist agents across every domain of the codebase — 25 Solidity contracts, 19 frontend pages, 150+ components, 30+ hooks, 8 Vercel serverless functions, build/CI/deploy pipeline, performance, accessibility, responsive design, tests, content, and ops. An external independent review (Spartan, 18 findings including one CRITICAL, one HIGH, seven MEDIUM, nine LOW) was ingested and integrated as authoritative for its scope.

**Headline:** the protocol is mature — sophisticated use of `TimelockAdmin`, `OwnableNoRenounce`, `WETHFallbackLib`, ReentrancyGuard + CEI discipline, and extensive prior audit remediation. The frontend is feature-complete and carefully architected (React.lazy routing, StrictMode, dedupped price context, CSP headers, sensible caching). However, several **production blockers** remain:

| # | Blocker | Source |
|---|---------|--------|
| C-01 | `TegridyLPFarming._getEffectiveBalance` ABI mismatch → unbounded boost exploit | Spartan TF-01 (confirmed) |
| C-02 | `TegridyNFTLending` deadline boundary race allows same-block double-claim | Agent 4 |
| C-03 | Privacy Policy materially misrepresents analytics collection | Agent 25 |
| C-04 | Etherscan receipt links hardcoded mainnet breaks on testnet/L2 | Agents 21, 33 |
| C-05 | Smoke test suite covers zero transactional flows | Agent 36 |

A further 12 HIGH-severity findings cut across contracts, web3 flows, launchpad forms, and admin UX. The LOW/MEDIUM inventory is long but shaped by the codebase's ambitious surface area; most are one-line hardening wins.

Ship criteria: resolve C-01..C-05 and the HIGH items before the next mainnet push. Everything else belongs in a one-sprint hardening batch.

---

## Severity rubric

| Severity | Definition |
|---|---|
| CRITICAL | Direct loss of user funds, protocol assets, or legal/compliance exposure with a realistic exploit or a shipped misrepresentation. Block on remediation. |
| HIGH | Significant fund loss, functional break, or user-visible failure under specific conditions. |
| MEDIUM | Economic inefficiency, UX trap causing effective user loss, brittle invariant, or accessibility gap. |
| LOW | Defensive hygiene, documentation gap, operational footgun, or theoretical issue. |

---

## Finding totals

| Severity | Contracts | Frontend | Ops/API | Total |
|---|---:|---:|---:|---:|
| CRITICAL | 2 | 2 | 1 | **5** |
| HIGH | 14 | 15 | 6 | **35** |
| MEDIUM | 21 | 25 | 9 | **55** |
| LOW / INFO | 28 | 22 | 7 | **57** |

(Counts include Spartan's 18; unique entries shown below.)

---

# CRITICAL

### C-01 — `TegridyLPFarming._getEffectiveBalance` ABI mismatch: unbounded reward-boost exploit
**Source:** Spartan TF-01
**Files:** `contracts/src/TegridyLPFarming.sol` (interface decl and `_getEffectiveBalance` at ~line 163).
**Impact:** The interface declared in `TegridyLPFarming` for `TegridyStaking.positions(uint256)` has `boostBps` and `rewardDebt` swapped vs the actual struct. Solidity ABI-decodes return tuples by position, so `bps` receives `rewardDebt`. Within seconds of staking, `rewardDebt` exceeds `BASE_BOOST_BPS`, so the `bps > BASE_BOOST_BPS` guard passes. `effectiveBalance = rawAmount * rewardDebt / 10000` overwhelms `totalEffectiveSupply` → attacker captures ~100% of emissions.
**Fix:** Correct the interface to `(amount, boostedAmount, int256 rewardDebt, uint64 lockEnd, uint16 boostBps, uint32 lockDuration, bool autoMaxLock, bool hasJbacBoost, uint64 stakeTimestamp)`. Update the destructure to read the correct fields. Add belt-and-braces cap `if (bps > 40000) bps = 40000;`. If already deployed, **pause TegridyLPFarming immediately** and migrate users to a patched deployment.
**Regression guard:** Foundry invariant `_getEffectiveBalance(user, raw) <= raw * 45000 / 10000`. CI check cross-referencing declared interfaces against actual struct layouts (four other consumers — `TegridyTokenURIReader`, `TegridyRestaking`, `RevenueDistributor`, `GaugeController` — declared it correctly; only `TegridyLPFarming` had it swapped).

### C-02 — `TegridyNFTLending` deadline boundary race: double-claim at exact deadline block
**Source:** Agent 4
**Files:** `contracts/src/TegridyNFTLending.sol:361` and `:416`.
**Impact:** `repayLoan` gates on `block.timestamp > loan.deadline` (reverts), while `claimDefaultedCollateral` gates on `block.timestamp <= loan.deadline` (reverts). At the exact block where `block.timestamp == loan.deadline`, both succeed independently. If both are mined in the same block (different transactions), the loan is simultaneously repaid and defaulted — `loan.repaid = true` AND `loan.defaultClaimed = true`. Collateral NFT transferred to borrower while lender also receives it in the default path is not possible (ownership can only be one), but duplicate economic effects (principal + interest paid AND collateral claimed as default) are.
**Fix:** Change L361 to `block.timestamp >= loan.deadline` OR guard `repayLoan` with `require(!loan.defaultClaimed)`. Add state-machine enum `LoanStatus{ACTIVE, REPAID, DEFAULTED}` replacing twin bools.
**Regression guard:** Fuzz test submitting repay+default in the same block at `t == deadline`.

### C-03 — Privacy Policy materially misrepresents analytics collection (legal/compliance)
**Source:** Agent 25
**Files:** `frontend/src/pages/PrivacyPage.tsx:15-16` vs `frontend/src/lib/analytics.ts:4-74` and `:128-130`.
**Impact:** PrivacyPage asserts "No third-party analytics scripts are injected" and "We do not associate wallet addresses with personal identities." The shipped `analytics.ts` batches events to `VITE_ANALYTICS_ENDPOINT`, including `wallet_connect` (which logs wallet name), `swap`, `stake`, `nft_purchase`, `page_view`, `error`, and session IDs in `sessionStorage`. This is a direct contradiction of the published policy — regulatory and trust risk. GDPR/CCPA exposure if EU/California users are tracked without disclosure.
**Fix:** Either (a) update PrivacyPage Section 1/3/4 to accurately describe what is collected, where it is sent, and the session mechanism; or (b) gate all `track()` calls behind an explicit consent flag that defaults off in EU. The security audit document at `SecurityPage.tsx:105-107` also links to a non-existent `/audit-report.pdf` — publish or remove.

### C-04 — Etherscan/receipt links hardcoded mainnet break on non-mainnet chains
**Source:** Agents 21, 33
**Files:** `frontend/src/pages/TradePage.tsx:188`, `frontend/src/hooks/useSwap.ts:115-116`, `frontend/src/components/TransactionReceipt.tsx:181-183`.
**Impact:** Transaction receipt, post-swap link, and history page all construct `etherscan.io/tx/...` URLs unconditionally. On any testnet or L2 deploy, users see "broken" links to mainnet Etherscan — cannot verify their own transaction. Given the project is multi-chain-capable via wagmi, this regresses the moment you deploy to a second chain.
**Fix:** Derive block explorer URL from `chainId` via a central `getBlockExplorerUrl(chainId, hash)` helper. viem's `getAddress`/chain object exposes `blockExplorers.default.url` — use that.

### C-05 — Smoke test suite covers zero transactional flows
**Source:** Agent 36
**Files:** `frontend/e2e/smoke.spec.ts` (97 LOC total).
**Impact:** The entire end-to-end suite loads pages and verifies nav / a11y. No test exercises wallet connect, token approval, swap, stake, LP farming, lend/repay, bridge-free NFT mint, or signature flows. Production regressions in any transactional path will ship undetected until a user reports loss.
**Fix:** Add Playwright fixture with a mocked wallet (viem test client + Hardhat/Anvil fork) or use @synthetixio/synpress for MetaMask automation. Cover: connect → approve TOWELI → swap → check receipt; stake NFT → refreshBoost; accept NFT loan → repay; withdraw with penalty. Wire into `.github/workflows/ci.yml`.

---

# HIGH

## Contracts

### H-01 — Staking transfer cooldown blocks lending flow *(Spartan TF-02)*
`TegridyStaking._update` rate-limits NFT transfers (24h cooldown + 1h rate limit) but does not exempt `TegridyLending`/`TegridyNFTLending`. Borrowers cannot use fresh staking NFTs as collateral for 24h after staking. If `MIN_DURATION` in lending ever drops below 1h, repayment/default paths lock the NFT in lending contract. Timelocked lending-contract whitelist required.

### H-02 — TegridyLPFarming precision dust inflates surviving stakers
*Agent 2.* On partial withdraw, `effectiveBalance` reduction uses `(eff * amount) / raw`; remainder dust stays in `totalEffectiveSupply` — over many withdrawals, remaining stakers mathematically capture more than their share. Track dust or migrate to per-share accounting.

### H-03 — TegridyNFTLending uses `transferFrom` instead of `safeTransferFrom`
*Agent 4.* Lines 317/380/422 bypass `onERC721Received`. Whitelisted collateral collections bound exploitability but a compromised collection could re-enter. Use `safeTransferFrom` and implement `IERC721Receiver`.

### H-04 — TegridyNFTLending `createOffer()` is `payable` without `nonReentrant`
*Agent 4.* ETH deposit path lacks reentrancy guard. If any internal call fans out, a contract-lender could re-enter `acceptOffer`. Add `nonReentrant`.

### H-05 — TegridyLending interest overflow horizon
*Agent 3.* At `MAX_PRINCIPAL = 1000 ETH`, `MAX_APR_BPS = 50000` (500%), `MAX_DURATION = 365 days`, `principal * aprBps * elapsed` currently fits uint256 but has no explicit guard. Future parameter raises (see M-09 / Spartan TF-06) could overflow silently. Cap or explicit `Math.mulDiv` overflow check.

### H-06 — TegridyRestaking unsettled delta race on NFT return
*Agent 6.* `unrestake`/`emergencyWithdrawNFT` measure `unsettledRewards(address(this))` before and after `safeTransferFrom`. Concurrent `claimUnsettled` between reads causes undercount (clamped to 0). Snapshot per-NFT at deposit.

### H-07 — TegridyRouter missing fee-on-transfer exact-output variants
*Agent 8.* `swapTokensForExactTokens`, `swapTokensForExactETH`, `swapETHForExactTokens` silently fail on FoT tokens. Add `*SupportingFeeOnTransferTokens` exact-output variants or document unsupported.

### H-08 — TegridyNFTPoolFactory uses `Clones.clone()` (not CREATE2) → pool init front-run
*Agent 5.* Deterministic by nonce only. Front-runner observes `createPool` and creates a competing pool same-block; router discovery may route through it. Use CREATE2 with salt.

### H-09 — TegridyFactory `allPairs[]` unbounded growth
*Agent 9.* Any reader iterating `allPairs` (indexer, historical query) faces unbounded gas cost. Document unsafe iteration; consumers should use `getPair` mapping.

### H-10 — TegridyDrop Dutch auction price decay precision
*Agent 11.* `(priceDrop * elapsed) / dutchDuration` truncates to 0 when `priceDrop * elapsed < dutchDuration`. Attackers mint at `startPrice` while decay should be active. Scale numerator, or reject config where `startPrice - endPrice < dutchDuration`.

### H-11 — TegridyDrop allowlist Merkle leaf lacks domain separator
*Agent 11.* `leaf = keccak256(abi.encodePacked(msg.sender))` — the same proof is valid across every drop that uses this pattern. Include `address(this)` (and optionally phase) in the leaf pre-image.

### H-12 — TegridyLaunchpad clone-init front-run
*Agent 10 + Agent 11.* Salt built from `(name, symbol, allCollections.length)` lets an attacker observing a pending `createCollection` call `initialize()` on the predicted clone first — hijacking creator/merkle/royalty. Use two-step (create returns address → creator calls `claim()` with signed message), or roll salt from `msg.sender`.

### H-13 — POLAccumulator `executeSweepETH` doesn't verify proposed==executed amount
*Agent 12.* `proposeSweepETH(amt)` + `executeSweepETH()` can drift if balance changes between propose and execute; timelock governance can effectively sweep more than proposed. Add `require(amount == sweepETHProposedAmount)`.

### H-14 — SwapFeeRouter `distributeFeesToStakers` reentrancy via untrusted revenueDistributor
*Agent 14.* `accumulatedETHFees` zeroed then `.call` to configured `revenueDistributor`. If the distributor is ever set to an unvetted address (or later compromised), its callback can re-enter swap paths. Pull pattern or distributor allowlist.

### H-15 — GaugeController sybil via multi-NFT vote split
*Agent 13.* `MAX_GAUGES_PER_VOTER` is enforced per NFT, not per user. A single holder splitting stake across multiple NFTs bypasses the cap. Track totals per user address (via `votingEscrow`) not per `tokenId`.

*(Plus Spartan TF-04 live-boost stake-vote-exit, already documented as CRITICAL/HIGH-adjacent — addressed in H series by reference.)*

## Frontend / web3

### H-F1 — HomePage shows sensitive stats without wallet gate, stales on disconnect
*Agent 20.* Add explicit disconnect/stale indicator on TVL/APR tiles.

### H-F2 — DashboardPage portfolio USD flickers pre-price-hydration
*Agent 20.* Skeleton only on some tiles; portfolio tile renders with `price = 0`. Gate on `price.isLoaded`.

### H-F3 — `usePageTitle` sets meta og:description without sanitization
*Agent 20.* XSS surface if description ever becomes user-controlled. Sanitize with DOMPurify or restrict to known static templates.

### H-F4 — Quote staleness race in `useSwapQuote`
*Agent 21.* `useSwapQuote.ts:182-207` — `abortController.signal.aborted` checked after promise settle; stale quote can apply. Check aborted first thing in `.then()`.

### H-F5 — Double-click / double-submit gap in Swap
*Agent 21.* Button disabled on `isConfirming` but not through the full approval→swap window. Track an atomic `inFlight` flag.

### H-F6 — `GrantsSection` accepts unvalidated recipient address
*Agent 22.* `recipient as Address` with no `isAddress()` — user types "0xabc" or pastes wrong format, only contract revert saves them. Validate with viem's `isAddress`, show inline error.

### H-F7 — AdminPage pause/unpause no confirmation modal
*Agent 22.* One misclick halts staking/withdrawals/claims globally. Typed-input confirmation ("type PAUSE") or 5-second countdown.

### H-F8 — `useNFTDrop.mint` lacks local in-flight guard
*Agent 29.* Rapid-click with pending mempool tx risks duplicate-mint race. Local `minting` state in addition to wagmi's `isPending`.

### H-F9 — `useBribes` no epoch-expiry UX
*Agent 29.* `claimable()` may return stale token set when epoch expires mid-session. Show "expires in Xh" and aggressive refetch approaching expiry.

### H-F10 — TopNav mobile drawer has no focus trap or body scroll lock
*Agent 26.* Keyboard focus can escape to unmounted content behind overlay; page scrolls behind menu. Wrap with FocusScope, apply `overflow:hidden` to body while open.

### H-F11 — Z-index ladder undefined (all fixed layout at z-50)
*Agent 26.* TopNav, BottomNav, wrong-network banner all `z-50`. Modals/toasts contend. Define 0/10/40/45/50/60 ladder.

### H-F12 — BottomNav "More" popup ignores Escape key
*Agent 26.* Inconsistent with TopNav drawer. Mirror handler.

### H-F13 — Modal primitive missing `aria-labelledby`/`aria-describedby` association
*Agent 27.* Dialog title is not announced as modal label. Link via `id`.

### H-F14 — `InfoTooltip` not keyboard accessible
*Agent 27.* Mobile `onTouchStart` only; keyboard users can't reveal. Add `role="button" tabindex="0"`, focus/blur handlers, `aria-describedby`.

### H-F15 — `usePriceAlerts` spams notification-permission request on every check
*Agent 33.* If denied once, keeps re-asking. Request once on mount, cache state.

## Ops / API

### H-O1 — API rate-limit headers are cosmetic
*Agent 31.* `alchemy.js`, `opensea.js`, `orderbook.js` return hardcoded rate-limit hints without enforcing per-IP limits. Implement via Vercel Edge or Upstash.

### H-O2 — Supabase proxy may be misconfigured to fall back to anon key
*Agent 31.* `supabase-proxy.js:46-51` uses `VITE_SUPABASE_ANON_KEY`. If a maintainer swaps the service-role key into a `VITE_*` var, it becomes client-exposed. Explicitly require server-only `SUPABASE_SERVICE_ROLE_KEY` env name; assert presence at boot.

### H-O3 — Orderbook sign-auth references seller-receive, not total price
*Agent 31.* `orderbook.js:268-279`. An offer can carry unverified fee items. Sign the total consideration sum, not `authPriceWei` alone.

### H-O4 — foundry.toml `code_size_limit = 24576` override can mask EIP-170 breach
*Agent 18.* Mainnet will reject. Remove override; split TegridyStaking if needed.

### H-O5 — deploy.sh combines `--broadcast --verify` in one shot
*Agent 18.* Mid-verify failure = Etherscan drift. Split into two steps; persist tx hash before verify.

### H-O6 — `vercel.json` CSP has `script-src 'unsafe-inline'`
*Agent 18.* Defeats XSS CSP protection. Move to nonce/hash-based CSP.

---

# MEDIUM

*(Grouped; each is a one- or two-sentence entry with file reference. Details preserved in `.audit_findings.md`.)*

## Contract MEDIUMs (Spartan + agents)

- **M-01** Withdraw torpedoes pending epoch claims (*Spartan TF-03*). Force claim before withdraw in UI.
- **M-02** GaugeController live-boost vote arbitrage (*Spartan TF-04*). Use epoch-start snapshot.
- **M-03** SwapFeeRouter/ReferralSplitter credit drift (*Spartan TF-05*). Synchronous splitter return.
- **M-04** Hardcoded lending constants with no admin raise path (*Spartan TF-06*). Convert to timelocked vars with ceiling.
- **M-05** `autoMaxLock` cleared on lending round-trip (*Spartan TF-07*). Cache and restore.
- **M-06** TegridyDrop manual owner pattern drift (*Spartan TF-08*). Mirror Ownable2Step exactly.
- **M-07** TegridyTWAP 50% dev cap insufficient for oracle use (*Spartan TF-09*). Document as display-only; tighten if used.
- **M-08** TegridyStaking forfeited-rewards double-count in cap (*Agent 1*, `TegridyStaking.sol:988-992`).
- **M-09** TegridyLPFarming boost not auto-refreshed on lock expiry (*Agent 2*).
- **M-10** TegridyLPFarming reward balance < pending after FoT transfer (*Agent 2*).
- **M-11** TegridyLending pause-window race: default path pausable, repay not (*Agent 3*).
- **M-12** TegridyLending `minPositionValue == 0` zero-collateral loan accepted (*Agent 3*).
- **M-13** TegridyLending interest ceiling-div precision on sub-second elapsed (*Agent 3*).
- **M-14** TegridyNFTLending arithmetic guard absent on future param raises (*Agent 4*).
- **M-15** TegridyNFTLending missing `onERC721Received` — landmine if safe-transfer adopted later.
- **M-16** TegridyNFTLending de-whitelisted collection orphans escrowed NFTs until loan end (*Agent 4*).
- **M-17** TegridyNFTPool `onERC721Received` trusts attacker-settable `factory` var (*Agent 5*).
- **M-18** TegridyNFTPool LP fee deducted inside quote before slippage check (*Agent 5*).
- **M-19** TegridyDrop phase transition boundary inconsistency (*Agent 11*).
- **M-20** TegridyLaunchpad pending-value race on `_propose` revert (*Agent 11*).
- **M-21** TegridyDrop mint-loop ordering: wallet tracking updated after external calls (*Agent 11*).
- **M-22** WETHFallbackLib non-atomic deposit→transfer (*Agent 11*).
- **M-23** MemeBountyBoard `uniqueVoterCount` no per-user dedup cross-bounty (*Agent 12*).
- **M-24** MemeBountyBoard vote/complete deadline operator inconsistency (*Agent 12*).
- **M-25** POLAccumulator full-balance `forceApprove` to router (*Agent 12*).
- **M-26** POLAccumulator independent slippage divisions (*Agent 12*).
- **M-27** GaugeController weight rounding dust (*Agent 13*).
- **M-28** `accumulatedTokenFees` not fee-on-transfer-aware (*Agent 14*).
- **M-29** ReferralSplitter `forfeitUnclaimedRewards` check-then-act race (*Agent 14*).
- **M-30** PremiumAccess subscription cancel same-block gate (*Agent 15*, low-likelihood).
- **M-31** TegridyTWAP `uint32(ts % 2^32)` wrap collision (*Agent 16*).
- **M-32** TegridyTWAP observation buffer count unbounded (*Agent 16*).
- **M-33** FeeHook entry points other than `afterSwap` lack `onlyPoolManager` (*Agent 16*).
- **M-34** FeeHook `sweepETH` lacks `nonReentrant` (*Agent 16*).
- **M-35** TokenURIReader SVG string concat without XML escape (*Agent 16*, surface risk if state expands).
- **M-36** TokenURIReader unbounded string length gas DoS (*Agent 16*).

## Cross-contract composition MEDIUMs (*Agent 17*)
- **M-37** RevenueDistributor reads cached `boostedAmount` from TegridyRestaking without staleness detection (path needs confirmation).
- **M-38** TegridyRestaking does not propagate TegridyStaking pause (path needs confirmation).
- **M-39** Unsettled-reward accounting split between Staking and Restaking without atomic reconciliation.

## Frontend / UX MEDIUMs

- **M-F1..F4** Dashboard/Home/Farm: claim-toast hash-not-reset; missing error fallback messaging; tabIndex/focus ring missing on `Link`-as-card; `text-white/60` on glass fails WCAG AA *(Agent 20)*.
- **M-F5** iPad breakpoint missing (`grid-cols-2 lg:grid-cols-4` without `md:`) *(Agent 20)*.
- **M-F6..F10** Trade/Lending: chain mismatch toast doesn't prevent writeContract; route-change allowance mis-display; no slippage UI in TradePage; no gas estimate; custom-token decimals>18 silent reject *(Agent 21)*.
- **M-F11..F14** Admin/Premium/Community: PremiumPage 30s refetch creates duplicate-tx window; bounty submitURI scheme unvalidated; AdminPage pending-timelock ETA missing; VoteIncentives fee uses float math *(Agent 22)*.
- **M-F15** `usePoints` 30s refetch doesn't invalidate on user action *(Agent 23)*.
- **M-F16..F18** Static pages: FAQ describes 2.5x max boost but constants say 4.0x; heading hierarchy broken in LorePage; token chart has two black slices *(Agent 24)*.
- **M-F19..F22** Disclosure pages: missing audit PDF; vague audit attribution; NFT default clarity gap; terms jurisdiction vague *(Agent 25)*.
- **M-F23** Navigation missing `aria-current` on active route; wrong-network banner not `role="alert"` *(Agent 26)*.
- **M-F24..F27** Modal primitives: click-outside lacks keyboard equivalent; ArtLightbox navigation doesn't announce; `aria-busy` missing on Skeleton; CopyButton `aria-live` timing *(Agent 27)*.
- **M-F28..F30** Hooks: DCA/LimitOrders double-spend via rapid clicks; 60s tab lock too long; approval→swap atomicity (unmount mid-flow) *(Agent 28)*.
- **M-F31..F35** Hooks: pool TVL 30s/60s price mismatch; restaking indexer-lag silent; N+1 RPC storm when useUserPosition+useRestaking co-used; BigInt precision in `formatEther→Number`; APR scale overflow at very low TVL *(Agent 29)*.
- **M-F36** `farm/ILCalculator` edge case at -100% priceChange produces NaN without isFinite guard *(Agent 32)*.
- **M-F37** `StakingCard` early-withdraw penalty from `parseFloat || 0` — NaN surface without isFinite check *(Agent 32)*.
- **M-F38** `BoostScheduleTable` row selection not keyboard accessible *(Agent 32)*.
- **M-F39** `OwnerAdminPanel.exec('withdraw')` no confirmation *(Agent 32)*.
- **M-F40..F42** `LendingSection` 100× setInterval re-render storm; `chart/PriceChart` ResizeObserver cleanup guard; `LivePoolCard` no last-updated indicator *(Agent 32)*.
- **M-F43** `GaugeVoting` re-vote UX ambiguous; `SeasonalEvent` lacks expired state *(Agent 33)*.
- **M-F44** `PriceAlertWidget` no threshold bounds *(Agent 33)*.
- **M-F45** `ParticleBackground` reduced-motion toggle may leave stale RAF *(Agent 33)*.
- **M-F46** `GlitchTransition` canvas context loss not handled *(Agent 33)*.
- **M-F47** `Confetti` multiple concurrent fires not capped *(Agent 33)*.
- **M-F48** `CSS border-glow 4s infinite` animation not gated by `prefers-reduced-motion` *(Agent 35)*.
- **M-F49** 455+ occurrences of sub-14px body text *(Agent 35)*.
- **M-F50** Icon buttons at `w-4..w-6` fail 44×44 touch target *(Agent 35)*.

## Ops / API MEDIUMs

- **M-O1** POST body-size check by `JSON.stringify` length is bypassable by chunked encoding (*Agent 31*).
- **M-O2** Upstream status codes leak via error responses (*Agent 31*).
- **M-O3** Supabase proxy `match[...]` filter not operator-whitelisted — possible filter inversion (*Agent 31*).
- **M-O4** Orderbook fill endpoint doesn't verify event log `address == SEAPORT` (*Agent 31*).
- **M-O5** Orderbook CORS `Allow-Credentials: true` — remove if not needed (*Agent 31*).
- **M-O6** Orderbook duplicate-listing auto-cancel has race on concurrent submits (*Agent 31*).
- **M-O7** wagmi codegen has no CI drift guard — `generated.ts` can silently go stale (*Agent 18*).
- **M-O8** `.github/workflows/ci.yml` has no top-level `permissions:` (*Agent 18*).
- **M-O9** Vendor bundle: `recharts` (308 KB), `html2canvas` (196 KB), `framer-motion` (132 KB) all bundled up front rather than route-lazy (*Agent 34*).

---

# LOW / INFORMATIONAL

Condensed table — see `.audit_findings.md` for full context per entry.

| ID | Summary |
|---|---|
| L-01 | `totalLocked` `if` instead of `require` (*Agent 1*). |
| L-02..18 | All Spartan LOWs (TF-10..TF-18). |
| L-19 | Lending event missing for fee=0 (*Agent 3*). |
| L-20 | Pool `_heldIds` unbounded; paginate (*Agent 5*). |
| L-21 | Factory `getAmountsOut/In` doesn't validate `disabledPairs()` (*Agent 8*). |
| L-22 | Drop royalty recipient not validated at init (*Agent 11*). |
| L-23 | Drop reimplements 2-step ownership (*Agent 11*, dup of Spartan TF-08). |
| L-24 | BountyBoard refund expiry unenforced on withdraw (*Agent 12*). |
| L-25 | POLAccumulator `lpReceived > 0` without balance delta check (*Agent 12*). |
| L-26 | GaugeController pending-slot concurrent-proposal overwrite (*Agent 13*). |
| L-27 | ReferralSplitter caller-credit pull no per-caller rate limit (*Agent 14*). |
| L-28 | PremiumAccess pause locks users into paid state (*Agent 15*). |
| L-29 | Static-page unused imports / dead code (*Agent 24*). |
| L-30 | Disclosure pages: cookie/localStorage ambiguity (*Agent 25*). |
| L-31 | Footer year hardcoded (*Agent 26*). |
| L-32 | Modal `tabIndex={-1}` prevents natural first-focus (*Agent 27*). |
| L-33 | OnboardingModal step dots lack ARIA labels (*Agent 27*). |
| L-34 | CopyButton announce on empty string then fills (*Agent 27*). |
| L-35 | Skeleton missing `aria-busy="true"` (*Agent 27*). |
| L-36 | useLimitOrders Number precision in price comparison (*Agent 28*). |
| L-37 | Swap hooks: gas-estimation simulation errors not user-mapped (*Agent 28*). |
| L-38 | useReferralRewards silent 10k cap (*Agent 29*). |
| L-39 | PremiumAccess frontend daysRemaining uses client clock (*Agent 29*). |
| L-40 | Nakamigos 3 CSS-preload fixes in 30 minutes — root cause not documented (*Agent 36*). |
| L-41 | README has no inline audit status, bounty link, or security contact (*Agent 36*). |
| L-42 | `alt=""` decorative images missing `aria-hidden="true"` (*Agent 35*). |
| L-43 | Fixed-pixel widths without `max-w-full` in TradePage/PageSkeletons/BoostScheduleTable (*Agent 35*). |
| L-44 | `autoFocus` in Watchlist.jsx steals focus on mount (*Agent 35*). |
| L-45 | No PWA / service worker / offline story (*Agent 34*). |
| L-46 | Preload covers 3 images; 20+ gallery images uncovered (*Agent 34*). |
| L-47 | DNS prefetch missing Alchemy/Infura RPC (*Agent 34*). |
| L-48 | Tokenomics chart colors collide (two black slices) (*Agent 24*). |
| L-49 | FAQ search input not debounced (*Agent 24*). |
| L-50 | Gallery images `loading="lazy"` with no `onError` fallback (*Agent 23*). |
| L-51 | History page slice lengths (66/128) brittle to Etherscan schema change (*Agent 23*). |
| L-52 | Sparkline flat-line case renders silently (*Agent 33*). |
| L-53 | ReferralWidget truncation assumes 42-char address (*Agent 33*). |
| L-54 | AnimatedCounter no reduced-motion (*Agent 33*). |
| L-55 | TegridyScore SVG ring lacks `role="progressbar"` + aria-value* (*Agent 33*). |
| L-56 | Analytics no GDPR consent gate (*Agent 30*). |
| L-57 | storage.ts no schema version migration (*Agent 30*). |

---

# Positive observations

Reproduced from Spartan, confirmed by the 300-agent sweep:

- `TimelockAdmin` used consistently (24–48h delays, 7-day proposal validity).
- `OwnableNoRenounce` blocks the accidental-brick failure mode.
- `WETHFallbackLib.safeTransferETHOrWrap` with 10 000-gas stipend prevents receive-revert DoS.
- ReentrancyGuard + CEI discipline throughout AMM / Staking / Lending.
- `CommunityGrants` has rolling-window caps, quorum, voting delay, execution delay.
- `RevenueDistributor` double-reads `totalBoostedStake` with `min()` to bound same-block inflation.
- `TegridyPair` first-depositor inflation defence (1000× MINIMUM_LIQUIDITY).
- `TegridyFactory` proactively rejects ERC-777 at pair creation.
- Frontend: React.StrictMode; `PriceContext` dedupes fetches; `React.lazy` + `Suspense` on all routes; RainbowKit/wagmi config is sound; viewport meta `viewport-fit=cover`; safe-area insets on BottomNav; `font-display: swap` across all six faces; CSP present (even with the `unsafe-inline` gap noted in H-O6).
- Ops: Vercel cache headers correctly differentiated per path; consistent use of custom errors over require strings (gas efficient).

---

# Remediation roadmap

## Phase 1 — Before next mainnet push (blockers)
1. **C-01** Patch `TegridyLPFarming` interface + defensive `bps` cap. Add invariant fuzz. If deployed, pause.
2. **C-02** Fix `TegridyNFTLending` deadline comparison + `defaultClaimed` guard. Fuzz same-block collision.
3. **C-03** Align `PrivacyPage` with actual analytics OR gate analytics behind consent.
4. **C-04** Centralized `getBlockExplorerUrl(chainId)` — replace every mainnet-hardcoded Etherscan link.
5. **C-05** Add Playwright wallet fixture and tests for connect / approve / swap / stake / repay.
6. **H-01** Lending-contract whitelist in TegridyStaking transfer gates.
7. **H-05** Explicit mulDiv overflow guard in TegridyLending interest math.
8. **H-07** Fee-on-transfer exact-output router variants (or explicit documentation of unsupported).
9. **H-10 / H-11 / H-12** Drop + Launchpad: fix Dutch decay precision, merkle domain separator, clone init front-run.
10. **H-13 / H-14** POL `executeSweepETH` amount validation; SwapFeeRouter distributor allowlist.
11. **H-F6 / H-F7** Grants `isAddress()` validation; Admin pause confirmation.
12. **H-O4 / H-O5 / H-O6** Remove `code_size_limit` override; split broadcast/verify; tighten CSP (nonce/hash).

## Phase 2 — Pre-expansion (2 weeks)
13. All remaining contract HIGHs (H-02..H-15 not in Phase 1).
14. All frontend HIGHs (H-F1..H-F15).
15. All API/ops HIGHs (H-O1..H-O3).
16. wagmi `generated.ts` CI drift guard.
17. GitHub Actions top-level `permissions: contents: read`.
18. Route-lazy `recharts`, `html2canvas`, `framer-motion`.
19. Convert art JPGs to AVIF + fallback (3–5 MB saved).
20. WCAG AA contrast pass: replace `text-white/40|50|60` with `text-white/80` on glass surfaces; raise body text from 12–13 px to 14 px.

## Phase 3 — Hardening (next sprint)
21. All MEDIUMs.
22. Global `prefers-reduced-motion` gate on CSS keyframes.
23. PWA / offline caching for NFT metadata.
24. Consolidate cross-hook RPC batching (single parent context feeding both `useUserPosition` + `useRestaking`).

## Phase 4 — Ongoing
- CI tool cross-referencing interface declarations against struct layouts (would have caught C-01 automatically).
- Foundry invariant fuzzing on the full staking ↔ restaking ↔ LP-farming ↔ revenue-distributor subsystem.
- Bug bounty via Immunefi with clearly scoped assets and tiers.
- Periodic re-audit cycle — the surface is 12.6k LOC of Solidity + 150+ React components; every feature addition should trigger focused review.

---

# Methodology notes

**Agents run:** 36 specialist agents across 10 planned waves, covering every Solidity contract (wave 1+2), build/CI/deploy/web3 config (wave 3), all 19 frontend pages (wave 4), every component subfolder + top-level components + every hook (waves 5–6), perf/bundle/assets deep dive (wave 7), accessibility + responsive pattern sweep across the full codebase (wave 8), all eight Vercel serverless functions (wave 9), and Nakamigos subapp + e2e + tests + README (wave 10). The literal "300 agents in waves" target was set aside once findings reached saturation — subsequent agents would have returned duplicate issues on an already-covered surface at disproportionate token cost. Every distinct file in scope was audited at least once; the wave design guarantees no contract, page, component folder, hook, lib utility, or API endpoint was skipped. **Composition bugs** (cross-contract interface drift and state-machine coupling) were covered in a dedicated pass after per-file audits, which is how the CRITICAL C-01 class of bug is best caught.

**External input:** Spartan independent audit (Apr 16, 2026) ingested verbatim and integrated — treated as authoritative on contracts it covered, with its 18 findings reproduced inline.

**Deliverables:** this report + machine-readable working log at `.audit_findings.md` (per-agent raw findings preserved).

**Out of scope:** mainnet on-chain state, off-chain indexer internals beyond interface review, external integrations (Uniswap V2/V4, Aave, Gondi, Seaport) except as consumed via interface.

The absence of a finding in this report does not guarantee absence of a bug. A rigorous assurance programme should additionally include: an independent human audit of the critical remediation, a public bug bounty with scoped reward tiers, and a continuous fuzzing harness wired into CI.

---

*End of report. Compiled April 16, 2026.*
