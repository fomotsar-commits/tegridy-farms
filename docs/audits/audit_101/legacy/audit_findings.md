# 300-Agent Audit — Findings In Progress

Cross-references to Spartan audit (SPARTAN_AUDIT.txt, Apr 16 2026). Spartan = external independent review, treated as authoritative on items it covered.

## Spartan imported (contracts only)
- TF-01 CRITICAL TegridyLPFarming ABI mismatch → unbounded boost
- TF-02 HIGH Staking transfer cooldown blocks lending flow
- TF-03 MEDIUM Withdraw torpedoes pending epoch claims
- TF-04 MEDIUM GaugeController live-boost vote arbitrage
- TF-05 MEDIUM SwapFeeRouter ↔ ReferralSplitter credit drift
- TF-06 MEDIUM TegridyLending constants not admin-raisable
- TF-07 MEDIUM autoMaxLock cleared on lending round-trip
- TF-08 MEDIUM TegridyDrop manual owner pattern drift risk
- TF-09 MEDIUM TegridyTWAP 50% dev cap insufficient for oracle use
- TF-10..18 LOW (see SPARTAN_AUDIT.txt for details)

## 300-agent wave 1 (agents 1-10) raw output

### Agent 1 — TegridyStaking.sol
- MEDIUM: Forfeited rewards double-counted in totalUnsettledRewards cap (TegridyStaking.sol:988-992).
- LOW: totalLocked underflow protection loose (L968) — change `if` to `require`.
- INFO: Test gap for forfeited rewards redirect to treasury.

### Agent 2 — TegridyLPFarming.sol / LPFarming.sol
- NOTE: Spartan found CRITICAL ABI mismatch in same contract; this agent MISSED it. Include TF-01 in final.
- HIGH: Precision loss in proportional effective balance on partial withdraw (L206). Dust retained in totalEffectiveSupply inflates rewards for remaining stakers.
- MEDIUM: Boost not auto-refreshed on lock expiry (L159-170) — user holds 4x boost past expiry until someone calls refreshBoost().
- MEDIUM: Reward balance < pending reward after FoT transfer (L268).
- LOW: External call into TegridyStaking without try/catch — can brick farming if Staking ABI breaks.
- LOW: No massUpdatePools DoS (clean, Synthetix pattern).

### Agent 4 — TegridyNFTLending.sol
- CRITICAL: Deadline boundary race (L361 `>`, L416 `<=`). At `block.timestamp == deadline`, both borrower repay AND lender claimDefault succeed in same block if ordered separately. Fix: change L361 to `>=` OR guard `repayLoan` with `!defaultClaimed`.
- HIGH: ERC721 `transferFrom` instead of `safeTransferFrom` (L317, L380, L422). No onERC721Received validation; malicious NFT hooks can re-enter. NOTE: lending contract is whitelisted collections only, which bounds exploitability but doesn't eliminate.
- HIGH: `createOffer()` accepts ETH (payable) but has no `nonReentrant` guard (L214). Verify guard presence — agent may have missed it.
- MEDIUM: `_ceilDiv` multiplication without explicit overflow check (L471). Safe today, fragile for future param changes.
- MEDIUM: No `onERC721Received` handler — landmine if repo switches to safe transfers.
- MEDIUM: De-whitelisted collection orphans escrowed NFTs (L550-557). 48h timelock < loan MAX_DURATION 90d.
- LOW: Overpayment/fee refund via WETH fallback may fail silently on malicious receive().

### Agent 6 — TegridyRestaking.sol
- HIGH: Unsettled rewards delta race (L492-496 before/after reads across external transfer). Concurrent claim between before/after reads mis-accounts per-user unsettled. Fix: track unsettled per-NFT at deposit time.

### Agent 7 — TegridyPair.sol
- MEDIUM (doc only): K-invariant fee formula correct but lacks derivation comment (L200-203).
- Notably: first-liquidity inflation defended by 1000× MINIMUM_LIQUIDITY requirement; flash swaps disabled explicitly; skim permissionless (documented); ERC-777 rejected at factory. Clean.

### Agent 8 — TegridyRouter.sol
- HIGH: No fee-on-transfer exact-output swap variants (`swapTokensForExactTokensSupportingFeeOnTransferTokens` etc) — exact-output swaps silently fail on FoT tokens.
- MEDIUM: Router transfers tokens to pairs before mint/burn; guard protects router, not pair callback-window state. Acceptable under trusted-pair assumption but document.
- LOW: `getAmountsOut`/`getAmountsIn` don't validate `disabledPairs()` — misleads off-chain aggregators.

### Agent 10 — TegridyLaunchpad.sol (NFT factory, not ICO)
- HIGH: Salt uses mutable `allCollections.length` — state reset or db reorg changes deterministic addresses.
- HIGH: `createCollection()` missing `nonReentrant`; clone initialize could re-enter.
- MEDIUM: No emergency withdraw for stuck ETH/tokens on launchpad itself (TegridyDrop has withdraw).
- MEDIUM: Constructor sets protocolFeeRecipient without timelock (only subsequent changes are timelocked).
- LOW: Dutch auction price decay precision edge (TegridyDrop.sol:268-276).

### Agent 3 retry — TegridyLending.sol
- HIGH: Interest overflow risk for 365d × 500% APR loans at MAX_PRINCIPAL (L507).
- MEDIUM: Pause-window race — `claimDefaultedCollateral` is `whenNotPaused` but `repayLoan` is not (L341, L376, L412).
- MEDIUM: `acceptOffer` accepts `minPositionValue == 0` (L285-286).
- MEDIUM: Short-loan interest precision: ceilDiv loss + truncation on sub-second elapsed (L507-513).
- LOW: Offer struct never deleted after acceptance (L299) — `getOffer` exposes ghost offers.

### Agent 5 retry — TegridyNFTPool + Factory
- HIGH: Clones.clone() (non-CREATE2) pool init front-runnable (Factory L115-165).
- MEDIUM: `onERC721Received` trusts `factory` var set at init (Pool L484-500).
- MEDIUM: LP fee deducted inside `_getSellPrice` before slippage check (L527, L567).
- MEDIUM: Spotprice revert on `delta*numItems == spotPrice` edge (L554).
- LOW: `_heldIds` unbounded; `getHeldTokenIds` full-array read.
- LOW: No `weth.code.length > 0` validation at init.

### Agent 9 retry — TegridyFactory.sol
- HIGH: `allPairs[]` unbounded growth → off-chain indexer + historical query gas DoS.
- Otherwise clean: token ordering, dup prevention, 2-step feeToSetter, disabledPairs, events.

### Agent 11 — TegridyDrop + base/
- HIGH: Dutch auction price decay precision (L274).
- HIGH: Allowlist Merkle leaf no domain separator (L235).
- HIGH: Launchpad clone init front-run salt = name+symbol+length (L110-143).
- MEDIUM: Phase transition boundary strict `<` inconsistency (L221, L269).
- MEDIUM: Timelock `pendingValue` overwrite-on-revert race (L183, L212).
- MEDIUM: `totalSupply` / `mintedPerWallet` updated after mint loop (L244-245).
- MEDIUM: WETHFallbackLib deposit→transfer not atomic (L50-51).
- LOW: Royalty recipient not validated at init (L166).
- LOW: TegridyDrop reimplements 2-step ownership (duplicates Spartan TF-08).

### Agent 12 — MemeBountyBoard + POLAccumulator
- MEDIUM: BountyBoard `uniqueVoterCount` increments without dedup cross-bounty (L272).
- MEDIUM: BountyBoard deadline comparison inconsistent vote/complete (L272/L298).
- MEDIUM: BountyBoard snapshotTimestamp=`block.timestamp-1` race (L212).
- LOW: BountyBoard refund expiry not enforced on `withdrawRefund` (L378).
- HIGH: POLAccumulator `executeSweepETH` no validation executed==proposed amount (L381-391).
- MEDIUM: POLAccumulator slippage min computed with independent divisions (L265-276).
- MEDIUM: POLAccumulator `forceApprove` full balance to router (L289).
- LOW: `lpReceived > 0` doesn't verify LP actually received.

### Agent 13 — VoteIncentives + GaugeController
- HIGH: GaugeController sybil via multi-NFT vote split bypasses MAX_GAUGES_PER_VOTER (L139-183).
- MEDIUM: Epoch-boundary timestamp drift vs strict-`<` deadline (VI L262, GC L152).
- MEDIUM: Integer rounding on weight division (GC L176, L200, L208).
- LOW: `pendingGaugeAdd`/`pendingGaugeRemove` single-slot overwrite race (L237-284).

### Agent 14 — SwapFeeRouter + ReferralSplitter + RevenueDistributor
- HIGH: `distributeFeesToStakers` could re-enter via untrusted revenueDistributor callback (~L539).
- MEDIUM: `accumulatedTokenFees[token]` not fee-on-transfer-aware (L347, L606-610).
- MEDIUM: ReferralSplitter `forfeitUnclaimedRewards` check-then-act race (L467-492).
- LOW: Caller-credit pull has no per-caller rate limit (L232-250).

### Agent 15 — CommunityGrants + PremiumAccess
- (boundary off-by-one) PremiumAccess `cancelSubscription` strict `>` vs same-block subscribe (L249-251). Severity LOW-MED pending confirmation.
- (boundary off-by-one) `hasPremium` strict `>` vs MIN_ACTIVATION_DELAY (L130). LOW.
- MEDIUM: Grant disbursement WETH fallback guarded only by `nonReentrant` on executeProposal (L606-623).
- LOW: PremiumAccess pause blocks `cancelSubscription` — users locked into paid state during emergency.

### Agent 16 — TWAP + FeeHook + TokenURIReader
- MEDIUM: TegridyTWAP `uint32(block.timestamp % 2**32)` wrap collision (L73).
- MEDIUM: Observation buffer overflow count unbounded (L126-181).
- MEDIUM: FeeHook non-afterSwap hooks lack `onlyPoolManager` (L122-158).
- MEDIUM: FeeHook `sweepETH` lacks `nonReentrant` (L405-411).
- MEDIUM: TokenURIReader SVG string concat without XML escaping (L88-107).
- MEDIUM: Unbounded string length tokenURI gas DoS.
- LOW: No try/catch around staking.positions().

### Agent 17 — Cross-contract composition
- HIGH: RevenueDistributor reads cached `boostedAmount` from TegridyRestaking without staleness detection — possible inflated-reward path. NEEDS CONFIRMATION.
- HIGH: TegridyRestaking does NOT propagate TegridyStaking pause. Emergency pause on Staking still permits Restaking unrestake. NEEDS CONFIRMATION against current `paused()` checks.
- MEDIUM: Split unsettled-reward accounting TegridyStaking ↔ TegridyRestaking lacks atomic reconciliation.

## Wave 3 — Build/CI/Deploy/Web3 config (agents 18-19)

### Agent 18 — Build/CI/Deploy
- HIGH: foundry.toml `code_size_limit=24576` override could mask contract-size-limit deployment failures.
- HIGH: deploy.sh/deploy-v2.sh combine `--broadcast --verify` in one shot; mid-verify failures leave Etherscan drift.
- MEDIUM: vercel.json CSP has `script-src 'unsafe-inline'` — defeats script XSS mitigation. Move to nonce/hash based CSP.
- MEDIUM: wagmi.config.ts has no CI guard that generated.ts matches committed ABI (drift risk on redeploy).
- MEDIUM: .github/workflows/ci.yml has no top-level `permissions:` block (defaults to read-write GITHUB_TOKEN).
- LOW: vite sourcemap='hidden' still emits .map in dist (1yr CDN cache). Exclude .map from deploy.
- LOW: deploy-vote-incentives.sh lacks simulate/confirm gate that peers have.

### Agent 19 — wagmi/contracts/constants/token list
- MEDIUM: constants.ts has hardcoded addresses without chainId indirection — if deployed on wrong chain, writes silently hit wrong addresses. Use `CONTRACTS[chainId]` map and throw in write hooks.
- MEDIUM: QueryClient retry=2 on top of wagmi fallback RPC retries → amplifies rate-limit pressure on public nodes.
- LOW: WalletConnect project ID exposure (safe for v2 but document).
- LOW: tokenList.ts hardcoded USDC/USDT decimals=6 without on-chain confirm for custom tokens.
- LOW: RouteErrorBoundary covers lazy routes only; WagmiProvider/QueryClientProvider init errors not boundary-caught.
- Positive: React.StrictMode present; PriceContext dedupes price fetches.

## Wave 4 — Frontend pages

### Agent 20 — HomePage + DashboardPage + FarmPage
- HIGH: HomePage shows sensitive stats (TVL, price, APR) without wallet gate; drops to stale on disconnect.
- HIGH: DashboardPage portfolio USD flickers pre-price-hydration (no skeleton on that specific stat).
- HIGH: usePageTitle sets meta og:description without sanitization — XSS surface if description becomes user-controlled.
- MEDIUM: DashboardPage claim-success toast doesn't reset `hash` — stale re-trigger on rapid claims.
- MEDIUM: No error fallback message for failed useReadContract balance queries — cryptic error dot only.
- MEDIUM: Link-as-card elements missing tabIndex/focus ring on keyboard nav.
- MEDIUM: text-white/60 over glass fails WCAG AA contrast (HomePage L170/152, Dashboard L188/194).
- MEDIUM: iPad (768px) grid collapse — `grid-cols-2 lg:grid-cols-4` with no md:grid-cols-3 breakpoint.
- LOW: "FAFO" tone inconsistent (FarmPage L183).
- LOW: Decorative `<img alt="">` missing `aria-hidden="true"`.
- LOW: No `<link rel="canonical">` via usePageTitle.
- LOW: ErrorBoundary lacks `resetKeys={[address]}` — stuck on wallet change.

### Agent 21 — TradePage + LendingPage + swap/nftfinance components
- HIGH: Etherscan receipt link hardcoded mainnet (TradePage L188, useSwap.ts L115-116). Derive from chainId.
- MEDIUM: Quote staleness race — `useSwapQuote.ts:182-200` applies aggregator result without validating request-id matches current amount.
- MEDIUM: Double-click protection incomplete — button disabled on isConfirming but not isPending mid-approval→swap transition (TradePage L178).
- MEDIUM: Chain mismatch toast fires but writeContract still queues (useSwap.ts L154-170). Make preventive.
- MEDIUM: Allowance-per-route: if only one router approved, route change mis-displays "needs approval" (useSwapAllowance.ts L33-49).
- LOW: No slippage UI in TradePage (setSlippage exists in hook but not surfaced).
- LOW: No gas estimate display pre-swap.
- LOW: Custom token import silently rejects decimals>18 (TokenSelectModal L208).
- LOW: Slippage clamp to [0,20] is silent (useSwap.ts L39-41).
- LOW: Virtualized token list estimateSize=52 unverified against real DOM.

### Agent 22 — AdminPage + PremiumPage + CommunityPage + community/
- HIGH: GrantsSection recipient address coerced to Address type without `isAddress()` validation (L85). Contract revert is only safety net.
- HIGH: AdminPage pause/unpause toggles without confirmation modal (L79-115). Single misclick halts protocol.
- MEDIUM: PremiumPage 30s refetch lag causes duplicate-tx risk post-activation (usePremiumAccess L50). Immediate refetch on isActionSuccess.
- MEDIUM: Grant proposal submit has no typed-input confirmation (GrantsSection L81-88).
- MEDIUM: Bounty submitURI not validated for scheme (javascript:, data:) (BountiesSection L68-75).
- MEDIUM: AdminPage lacks pending-timelock ETA display (L65-68).
- LOW: Textarea descriptions XSS-safe today but fragile if rendered as markdown later.
- LOW: VoteIncentives fee displayed via Number*Number — precision loss at size. Use BigInt.

### Agent 23 — LeaderboardPage + HistoryPage + GalleryPage
- MEDIUM: usePoints 30s refetch misses post-tx action feedback — no invalidate on recordAction.
- LOW: HistoryPage arbitrary slice lengths (hash→66, functionName→128) — brittle if Etherscan schema changes.
- LOW: Gallery images have `loading="lazy"` but no `onError` fallback → blank spot on 404/IPFS timeout.
- LOW: Future pagination gap — no virtualization if leaderboard/gallery grow past 50 items.
- Positive: Etherscan links use `rel="noopener noreferrer"` correctly.
- Positive: Gallery metadata strictly plain text, no XSS surface.

