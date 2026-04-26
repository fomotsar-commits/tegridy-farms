# Agent 060 — TreasuryPage Forensic Audit

**Targets:**
- `frontend/src/pages/TreasuryPage.tsx`
- `frontend/src/hooks/useRevenueStats.ts`
- `frontend/src/lib/contracts.ts` (treasury / SwapFeeRouter ABI surfaces)
- `frontend/src/lib/constants.ts` (treasury addresses)

**Cross-refs:** `REVENUE_ANALYSIS.md`, `contracts/src/SwapFeeRouter.sol`, `contracts/script/Deploy*.s.sol`, `docs/TOKEN_DEPLOY.md`.

Scope: AUDIT-ONLY. No code changes.

---

## A. Treasury address drift (docs ↔ on-chain ↔ frontend)

| Source | Address | Match? |
|---|---|---|
| `frontend/src/lib/constants.ts:67` `TREASURY_ADDRESS` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | ref |
| `contracts/script/DeployFinal.s.sol:24` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployAuditFixes.s.sol:20` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeploySwapFeeRouterV2.s.sol:11` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployLaunchpadV2.s.sol:14` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployNFTLending.s.sol:12` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployRemaining.s.sol:31` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployTegridyLPFarming.s.sol:16` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `contracts/script/DeployTegridyRouter.s.sol:14` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `docs/TOKEN_DEPLOY.md:57` | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | OK |
| `DEPLOY_CHEAT_SHEET.md` (line 223 reference) | unchanged note | OK (no value mismatch) |

`SWAP_FEE_ROUTER_ADDRESS` (`0xea13Cd47…7A0`) and `POL_ACCUMULATOR_ADDRESS` (`0x17215f0d…7Ca`) also match `ConfigureFeePolicy.s.sol:34-35`. **No drift detected.**

However: page does NOT verify that the displayed `TREASURY_ADDRESS` equals `SwapFeeRouter.treasury()`. Owner can rotate via timelock (`SwapFeeRouter.sol:71,729-737`) without the frontend noticing. `POLAccumulator.sol:138-151,315-323` exposes the same risk. **No live `treasury()` cross-check is rendered to the user, even though the contract supports rotation.**

---

## B. Revenue split percentages — contract ↔ UI

`SwapFeeRouter.sol` (state on chain):
- Line 135: `stakerShareBps = 10_000` (100% default).
- Line 139: `polShareBps = 0` (0% default).
- Line 150: `MIN_STAKER_SHARE_BPS = 5_000` (cap floor).
- Lines 887-888: distribution math uses these bps.
- `treasuryShareBps` is implicit: `BPS - stakerShareBps - polShareBps` → currently 0%.

`TreasuryPage.tsx`:
- Lines 92-106: reads `stakerShareBps` and `polShareBps` live, computes treasury as remainder. **CORRECT.**
- Lines 27-30: comment correctly notes "currently 100/0/0 per SwapFeeRouter.sol; the 50/25/25 ceilings are policy bounds, not the active numbers." Honest.

But `REVENUE_ANALYSIS.md` line 14 still claims **"Current rate 0.50% (`SWAP_FEE_BPS = 50`) … 100% → RevenueDistributor → stakers"**, while line 91 of the same doc proposes "Treasury take-rate on swap fees: 0% → 15%" as a future move. Doc is internally consistent (current = 100% stakers) but the page shows zero context that this is the *active* policy and may change post-vote. No "as-of block" indicator.

**Mismatch with REVENUE_ANALYSIS.md §1 row 4 — Referral split:** doc says "20% (REFERRAL_FEE_BPS=2000 in Final) **or** 10% (V2/AuditFixes). Which actually deployed depends on broadcast — confirm." TreasuryPage **does not display the referral cut at all**, even though it is part of revenue distribution. Stakers/POL/Treasury bar omits referral entirely.

---

## C. USD valuation / staleness

| Number | Source | Staleness shown? |
|---|---|---|
| `Total Value Locked` | `usePoolTVL()` (Uniswap reserves × ETH-USD × TOWELI-USD) | NO |
| `Lifetime Fees` USD | `lifetimeFeesEth * price.ethUsd` (line 114) | NO |
| `Treasury Balance` USD | `parseFloat(formatEther(treasuryBal.value)) * price.ethUsd` (line 117) | NO |
| `POL Holdings` USD | `polShare * pool.tvl` (line 124) | NO |

`PriceContext.tsx` exposes `oracleStale`, `displayPriceStale`, `apiPriceDiscrepant`, `priceDiscrepancy`, `priceUnavailable` — **none are read or rendered on TreasuryPage**. If the Chainlink ETH/USD feed goes stale, every USD figure on the treasury page silently uses a frozen/zero price with no warning. Same for the TOWELI price discrepancy banner — never surfaced here.

`pool.isLoaded` and `treasuryBal === undefined` flow into `'–'` strings without an explicit "loading" / "data unavailable" affordance — visually indistinguishable from a real $0.

---

## D. Source attribution on numbers

- TVL: no caption like "Source: Uniswap V2 reserves".
- Lifetime Fees: caption `${lifetimeFeesEth.toFixed(4)} ETH routed` is decent but **doesn't say where (`SwapFeeRouter.totalETHFees`)**.
- Treasury Balance: just an ETH balance — no note that `PremiumAccess` revenue, `TegridyLending`/`NFTLending` fees, `NFTPool` protocol fees, `VoteIncentives` bribe fees all flow here too.
- POL Holdings: caption says `% of LP supply`, but doesn't say "estimated via `TOWELI_WETH_LP_ADDRESS.balanceOf(POL_ACCUMULATOR_ADDRESS) / totalSupply`" — the user has no way to reproduce the number.
- "All figures are read directly from Ethereum mainnet" (line 154) is accurate but no block number / RPC source / "as of" timestamp.

**Reproducibility verdict:** A user with Etherscan can replicate `treasuryBal`, `totalETHFees`, `polLpBal`. They CANNOT replicate `lifetimeFeesUsd` or `polUsd` because the ETH/USD price source isn't disclosed. Same for the *split* — no link to `SwapFeeRouter.stakerShareBps()`.

---

## E. Client-side computation vs. server reproducibility

**All four stat tiles compute USD on the client with a context-cached price.** No server-side endpoint or signed snapshot. Implications:

1. Two visitors at the same block height see different USD figures if their `useToweliPrice` resolves differently (Chainlink round vs. CoinGecko fallback paths exist in `useToweliPrice`).
2. `polShare = Number(polLpBal) / Number(pool.lpSupply)` (lines 121-123) downcasts `bigint → number`. For `lpSupply` < 2^53 this is fine, but the pattern is brittle and undocumented.
3. `formatUsd` thresholding ($1M / $1k / nothing) means a user can't tell `$1.05K` apart from `$1.05K + $0.49` — no exact-value tooltip.
4. No CSV / JSON export. Auditors cannot snapshot.

---

## F. Pause / holiday note

- `SwapFeeRouter.sol:1028-1029`: `pause()` / `unpause()` exist; almost every entrypoint is `whenNotPaused`. If paused, `totalETHFees` stops growing and `distributeFeesToStakers` does not run.
- TreasuryPage **never reads `paused()`** on `SwapFeeRouter`, `RevenueDistributor`, `ReferralSplitter`, or `POLAccumulator`. If the protocol is paused, the page will continue to display "Lifetime Fees" / "Treasury Balance" with zero indication that fees are not currently being collected or distributed.
- No timezone / business-day caveat ("epoch end is Friday 00:00 UTC"). RevenueDistributor is epoch-based (`epochCount` exposed in `useRevenueStats.ts:42`) but TreasuryPage doesn't use it; useRevenueStats does, but the value is not surfaced on TreasuryPage either.

---

## G. Donation address — QR / checksum

- The "Treasury" row (lines 220-244) uses `CopyButton` and an Etherscan link. **No QR code.** `CopyButton` displays `shortenAddress(row.addr, 6)` only.
- The full address `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` is mixed-case and matches the EIP-55 checksummed form everywhere it appears (`constants.ts:67`, all deploy scripts, docs). **EIP-55 OK.**
- However, the page never explicitly labels this as a "donation address" — it's just "Treasury." That's defensible (people don't usually donate to a treasury), but `REVENUE_ANALYSIS.md` doesn't bless donations either, so it's neutral.
- `CopyButton` copies the full address (`text={row.addr}`). Verified in `frontend/src/components/ui/CopyButton.tsx` invocation.
- **Risk:** a user copying via screenshot OCR would scan the *truncated* `0xE9B7…3e` string from the visual. No QR fallback compounds that risk.

---

## H. Accessibility

Positives:
- Line 192-197: stacked split bar has `role="img"` and `aria-label` enumerating segments. Good.
- Lines 234-242: Etherscan links have `aria-label` and `target="_blank" rel="noopener noreferrer"`.

Issues:
- Line 137, 163, 178, 216, 253: `<ArtImg ... alt="">` — five decorative images. Empty alt is correct for decorative, **BUT** the inline `aria-hidden` on the wrapper is missing. Screen readers may still attempt to announce.
- Lines 199-208: the colored dot legend uses `style={{ background: s.color }}` only — color is the sole differentiator next to label text. With label text it's marginally OK, but inactive state (line 201, `opacity: 0.45`) is announced as "Treasury 0% (0 bps) · inactive" only as plain text — fine.
- The split bar's filtered render (line 194: `split.filter(s => s.bps > 0)`) means a 100/0/0 chart shows ONE green bar with `aria-label="Revenue distribution split: 100% Stakers"`. That's accurate but a sighted user sees a solid green bar and may not realize the other two categories exist. Legend below redeems this, but the inactive items could collapse if not carefully styled.
- Lines 167-169, 219, 256: `textShadow` is used pervasively to ensure contrast against a dark scrim. Contrast was not measured — `text-white/65` on a 0.78-opacity navy gradient may fail WCAG AA on the lightest gradient stops (top of page, line 138 says `0.50` opacity). At idx0 hero, white-65 may dip below 4.5:1.
- No `<h1>` → `<h2>` ordering issue, but `<section>` is wrapped in a `<div>` parent without landmark role. Page has no `<main>` (App-level routing concern, not this file).
- The numeric stat values (line 168) use `heading-luxury` class — a custom typography class. Without `aria-live="polite"` on the stat tiles, screen readers won't announce when `treasuryBal` updates from `'–'` to a real value.
- The fee-router fee-split bar `aria-label` regenerates each render. Frequent updates (every 60s for treasury balance, every 5min for split bps) won't be announced; bar updates silently. Not strictly an a11y violation, just a missed opportunity (a polite live region on the entire dashboard would help).

---

## I. Responsive

- Stat grid: `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4` — 4 stats × 4 cols at lg, 2×2 at sm. Good.
- Address row: `flex-col sm:flex-row` — stacks correctly on iPhone 14 width (390px). Good.
- Page max-width 1100px (line 142). On iPad landscape (1024-1180) the content sits comfortably; on iPad portrait (768) the `md:grid-cols-3` gives a 3-up that pushes "POL Holdings" onto its own row — minor visual orphan but not broken.
- `pt-28` (line 142) accounts for fixed nav. Verified consistent with sibling pages.
- Fixed inset background `<ArtImg pageId="treasury" idx={0}>` at z-0 with z-10 content — no scroll-jank on iOS Safari that I could detect from static read.
- The fee-split bar `flex h-3 rounded-full overflow-hidden mb-5` with rounded ends + segment widths via `style={{ width: '${s.bps / 100}%' }}` — at 100/0/0 the single green segment fills the rounded container. Confirmed via the `filter(s => s.bps > 0)` skip on line 194. **OK.**
- Sub-text on stat tiles (`text-[11px]`) at iPhone DPR 3 viewports is borderline-readable; not WCAG-violating but tight.
- Long Etherscan address strings on the address row use `font-mono text-[12px]` and rely on `shortenAddress(addr, 6)` — never overflow.

No broken responsive behavior detected.

---

## J. Other

- `useRevenueStats.ts:10`: `userAddr = address ?? '0x0...0000'` — the eight contract reads (lines 21-37) include user-scoped reads. With the zero address, `pendingETH` and `getReferralInfo` will return zero — fine, except `getReferralInfo` may revert on some implementations. Not a TreasuryPage concern (TreasuryPage doesn't import this hook).
- Line 36: `query: { enabled: !!address, ... }` — gates correctly.
- Line 89-90: `setTimeout(resetClaim, 0)` defers reset by a tick — fine, but ESLint exhaustive-deps doesn't flag the closure on `refetch`/`resetClaim` because both are stable. OK.
- TreasuryPage **does not import `useRevenueStats`** — the audit target list pairs them but they don't currently interact. The page silently ignores `RevenueDistributor.totalDistributed` / `totalClaimed` / `epochCount`, which would be highly relevant for "where the money goes." **Missed integration.** REVENUE_ANALYSIS.md §2 explicitly lists 100% of swap fees → stakers via RevenueDistributor — but the Treasury page never queries RevenueDistributor at all.
- Line 86 of TreasuryPage: `totalETHFees` shows lifetime ETH routed through SwapFeeRouter, but does NOT distinguish staker portion vs treasury portion (currently 100/0). Once the split changes via `proposeFeeSplit` (SwapFeeRouter.sol:943-959), the same `totalETHFees` number will conflate destinations until the page math is updated.
- POL value math (line 124) silently shows $0 if `pool.tvl === 0`, even when LP balance is non-zero — confusing during pool warm-up. No "warming up" copy.
- `polLpBal` is `unknown` from wagmi; cast as `bigint` on line 122. If RPC returns null, downstream divide produces NaN — `Number(NaN)` becomes `0` after `formatUsd`, so it degrades gracefully. OK in practice.

---

## K. Summary table

| Severity | Finding |
|---|---|
| INFO | Treasury address consistent across docs, scripts, frontend (EIP-55 OK). |
| LOW | No live `SwapFeeRouter.treasury()` cross-check; rotation invisible to users. |
| MEDIUM | USD figures lack staleness indicator despite `oracleStale`/`displayPriceStale` available in PriceContext. |
| MEDIUM | No source attribution / "as of block" / RPC origin caption — figures not server-reproducible. |
| MEDIUM | TreasuryPage never reads `paused()` — paused protocol shows stale fees as if live. |
| LOW | No QR code on treasury address; truncated visual display invites OCR misreads. |
| LOW | Referral cut (10–20% of swap fee, REVENUE_ANALYSIS §1 row 4) absent from the distribution chart. |
| LOW | TreasuryPage never queries RevenueDistributor (`totalDistributed`/`totalClaimed`/`epochCount`) — missed transparency layer. |
| LOW | A11y: decorative ArtImg lacks `aria-hidden`; stat tiles lack `aria-live`. |
| INFO | Responsive layout passes desktop / iPhone 14+ / iPad (no overflow / wrap issues found). |
| INFO | Split-bar `aria-label` correct but updates not announced (no live region). |
| LOW | `formatUsd` thresholding hides exact values; no tooltip. |
| LOW | `polShare` does `Number(bigint)` downcast — fine for current LP supply, brittle long-term. |
| LOW | "Coming soon" indexer placeholder (lines 257-269) — informational, not a bug. |

**Counts:** INFO 3, LOW 8, MEDIUM 3, HIGH 0, CRITICAL 0.

---

## L. Top-3 (priority)

1. **MEDIUM — Missing pause / staleness handling.** TreasuryPage shows fee/balance numbers without checking `SwapFeeRouter.paused()`, `RevenueDistributor.paused()`, or `priceContext.oracleStale`. During an emergency pause or oracle outage, the page lies by omission.
2. **MEDIUM — Numbers are not server-reproducible.** No "as of block N at HH:MM UTC", no RPC source disclosure, no link to the on-chain function for each stat. `lifetimeFeesUsd` and `polUsd` cannot be verified by an outsider with Etherscan alone.
3. **MEDIUM — Live-rotation / `treasury()` divergence risk.** `SwapFeeRouter` and `POLAccumulator` allow timelocked treasury rotation; the frontend hardcodes `TREASURY_ADDRESS` and never compares against `SwapFeeRouter.treasury()`. A successful timelock execution will silently mislead users until a frontend redeploy.

_End of agent 060 report._
