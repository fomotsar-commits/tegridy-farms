# Agent 055 — Static Page Content Drift Audit

**Scope:** `frontend/src/pages/` static / informational pages, audit-only.
**Source-of-truth refs:** `TOKENOMICS.md` (2026-04-18), `CONTRACTS.md` (2026-04-17), `REVENUE_ANALYSIS.md` (2026-04-17), `frontend/src/lib/constants.ts`, `contracts/src/TegridyStaking.sol`, `contracts/src/SwapFeeRouter.sol`, `contracts/src/TegridyLPFarming.sol`.
**Method:** read each page, diff every numeric / address / percentage / date claim against authoritative sources. No fetches; broken-link candidates flagged only.

---

## Summary counts

| Severity | Drifts |
|---|---|
| HIGH (deployed-address or fee mismatch) | 7 |
| MEDIUM (tokenomics %, boost, lock range) | 9 |
| LOW (date / methodology / unverifiable static numbers) | 6 |
| INFO (broken-link candidates, mailto) | 8 |
| `dangerouslySetInnerHTML` instances | 0 |
| **Total findings** | **30** |

---

## TokenomicsPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 22-27 | `SUPPLY_DATA` distribution buckets | Circulating 65 / Staking Rewards 20 / LP Rewards 10 / Treasury 5 | TOKENOMICS.md L26-33: LP seed 30 / Treasury 10 / Community 10 / Team 5 / Circulating 45 | HIGH |
| 38 | `POL_ACCUMULATOR` marked `live: false` | shows "Pending" / "Not yet deployed" badge | CONTRACTS.md L28 + constants.ts L17: live at `0x17215f0d…87B7Ca` | HIGH |
| 159 | "Rewards split: LP Pool (60%) + Staking Pool (40%). 100% of protocol revenue goes to stakers." | static text claims 60/40 emission split | TOKENOMICS.md L41-66: 100% of swap fees → stakers; emissions are owner-funded notify epochs (no fixed 60/40); GaugeController distributes per-vote, not 60/40 | MEDIUM |
| 181 | "100% of protocol revenue is distributed to stakers." inside *Community Treasury* card | conflates revenue (ETH) with farm contract holdings | TOKENOMICS.md confirms 100% revenue→stakers but `usePoolData` here is LP-farming TOWELI emissions, not revenue. Mixed framing. | LOW |

## ChangelogPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 19 | "April 18, 2026 — Visual Identity Refresh" | newest entry | TOKENOMICS.md last-updated 2026-04-18; OK. But CONTRACTS.md notes Wave 0 redeploys 2026-04-18 are absent from changelog | LOW |
| 51-56 | "Deployed TegridyNFTLending contract … April 14, 2026" | claims April 14 deploy | CONTRACTS.md L60: NFTLending Wave 0 redeploy 2026-04-18 (post-C-02). Initial deploy date not contradicted but redeploy not logged. | LOW |
| 60 | "Applied fixes for several v4 audit findings (C-02, C-03, H-01, H-03, M-02)" | references SECURITY_AUDIT_300_AGENT.md | SecurityPage links the same file; consistent. | INFO |
| 79-87 | "February 2026 — Core Protocol Launch — Deployed TegridyFactory…" | implies Feb 2026 first deploy | TOKENOMICS.md L17 says token has been live "~2 years" / deployed ~2024. Token vs. DEX deploy dates conflict if reader assumes "Core Protocol Launch" includes TOWELI. | LOW |
| — | No mention of Wave 0 (2026-04-18 — TWAP / FeeHook / LPFarming / GaugeController / NFTLending / TokenURIReader) | omitted | CONTRACTS.md L29-62 explicitly tags 2026-04-18 redeploys | MEDIUM |

## FAQPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 31 | Lock duration "1 to 52 months" | range stated | TOKENOMICS.md L114-118 + TegridyStaking.sol: 7 days → 4 years (1460 days). 52 months ≈ 4.3y; near but mislabelled in months | HIGH |
| 33 | "1 month lock = 1x multiplier, scaling up to 2.5x at 52 months" | boost curve | TOKENOMICS.md L104-107: 0.4× (7d) → 4.0× (4y) linear, +0.5× JBAC, ceiling 4.5× (`MAX_BOOST_BPS_CEILING=45000`). 2.5× appears at 1-year only. | HIGH |
| 35 | "Holders of JBAC, Nakamigos, or GNSS NFTs receive an additional 10-20% yield boost" | three collections, 10-20% | TegridyStaking.sol uses JBAC only (`+0.5x flat = +50%` of base, not 10-20%). Nakamigos/GNSS are NFT-lending whitelisted only (Changelog L53), no staking boost. | HIGH |
| 35 | "10-20% yield boost" magnitude | low-balls | +0.5× absolute boost = +12.5% relative at 4y lock, +125% relative at 7d lock. Range is wrong direction of explanation. | MEDIUM |
| 41 | "100% of swap fees … distributed to TOWELI stakers as ETH" | ETH payout | TOKENOMICS.md L66-68 confirms ETH today (lever set to 100%); REVENUE_ANALYSIS.md proposes 80-90% reroute. Currently accurate. | INFO |
| 43 | "Tegridy Score … points system based on your on-chain activity" | undocumented in TOKENOMICS / CONTRACTS | No source-of-truth document — candidate static-only feature claim | LOW |
| 49 | "Borrow ETH by locking your NFTs (JBAC, Nakamigos, GNSS) as collateral" | ETH-denominated loans | TegridyNFTLending source: P2P loans denominated in lender's chosen ERC-20 (TOWELI/WETH). "ETH" oversimplifies. | MEDIUM |
| 59 | "all admin parameter changes are enforced through a timelock of 24-48 hours" | claims universal timelock | RisksPage L17 echoes 24-48h. SwapFeeRouter `proposeFeeChange` is 24h fixed; not all admin actions are uniformly delayed. Statement is approximately correct but absolute claim "always have time" risky. | LOW |
| 66 | "Gold Card … paid monthly in ETH" | monthly ETH | REVENUE_ANALYSIS.md L18: `PREMIUM_MONTHLY_FEE = 0.01 ETH/month` (Final) **or 10 000 TOWELI/month** (older). Single-currency framing wrong. | MEDIUM |
| 67 | "JBAC NFT holders receive lifetime Gold Card access at no cost" | lifetime, free | PremiumAccess.sol behavior: JBAC holders get *discount via Gold Card discount* in REVENUE_ANALYSIS L16 (50% off), not lifetime free. Needs source verification. | MEDIUM |

## PrivacyPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 117 | "Last updated: April 19, 2026" | recent | currentDate 2026-04-25; OK | INFO |
| 35, 55 | `mailto:security@tegridyfarms.xyz` | hardcoded mailto | not contradicted but unaudited domain ownership | INFO |
| 25 | Lists Odos, 0x, 1inch, CoW Swap, LiFi, KyberSwap, OpenOcean, Paraswap | 8 aggregators | not in CONTRACTS.md; static claim, requires audit by network agents | LOW |
| — | No `dangerouslySetInnerHTML` | uses safe React text rendering | OK | INFO |

## TermsPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 32 | "0.3% fee on all token swaps executed through the AMM" | 0.3% | REVENUE_ANALYSIS.md L14: `SWAP_FEE_BPS = 50` = **0.50%**. TermsPage understates by 40%. | HIGH |
| 32 | "25% early withdrawal penalty" | 25% | TegridyStaking.sol L56: `EARLY_WITHDRAWAL_PENALTY_BPS = 2500` (25%). Correct. | INFO |
| 108 | "Last updated: April 2026" | non-specific | weaker than PrivacyPage's day-precise stamp | LOW |
| 12 | "yield farming and liquidity provision through automated market maker pools; token swapping via integrated DEX functionality; TOWELI token staking with vote-escrow mechanics" | feature list | aligns with CONTRACTS.md | INFO |

## RisksPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 16 | "Administrative functions are held by one EOA today" | single-EOA admin | ContractsPage banner mentions multisig `0x0c41…8bfe` for Wave 0 acceptOwnership. Inconsistent: one page says single EOA, other implies multisig is queued. | MEDIUM |
| 21 | Lists VoteIncentives, TegridyLending, TegridyNFTPool (template + factory), TegridyFeeHook, TegridyLaunchpadV2 as "patched but not yet redeployed" | redeploy-pending list | CONTRACTS.md L29-62: TWAP, LPFarming, GaugeController, NFTLending, TokenURIReader **already** redeployed 2026-04-18. RisksPage list is stale by ~7 days. | HIGH |
| 25 | "one external review (Spartan, April 2026)" | Spartan + March 2026 doc | unverified file `.spartan_unpacked/` is referenced; SecurityPage doesn't mention Spartan. Cross-page inconsistency. | MEDIUM |
| 65 | "25% early withdrawal penalty" | matches | TegridyStaking.sol confirms | INFO |
| 81 | "24-48 hour timelock to allow community review" | matches Privacy/FAQ | consistent | INFO |
| 292 | "Last updated: April 2026" | imprecise | LOW | LOW |
| 228, 237 | `https://github.com/fomotsar-commits/tegridy-farms/blob/main/FIX_STATUS.md` and `AUDITS.md` | external links | candidate broken-link (no fetch) | INFO |

## SecurityPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 10 | `TegridyStaking = 0x65D8b87917c59a0B33009493fB236bCccF1Ea421` | hardcoded | CONTRACTS.md L16: that address is the **deprecated v1** (paused). Live v2 is `0x626644523d34B84818df602c991B4a06789C4819` (constants.ts L6). **Surfaces deprecated contract as live.** | HIGH |
| 14 | `TegridyNFTLending = 0x63baD13f89186E0769F636D4Cd736eB26E2968aD` | hardcoded | constants.ts L40: `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139`. Wrong address entirely. | HIGH |
| 11-15 | Other 4 addresses (Factory/Router/Lending/PoolFactory) | hardcoded | match constants.ts (Factory L10, Router L11, Lending L33, PoolFactory L36). | INFO |
| 9-16 | Hardcoded addresses (not imported from `constants.ts`) | architectural drift | ContractsPage and TokenomicsPage import — SecurityPage does not. Single source-of-truth violation. | HIGH |
| 28-32 | `BOUNTY_TIERS`: Critical $10k / High $5k / Medium $1k / Low $500 | bounty amounts | not documented in any audit MD; static claim | LOW |
| 126 | "38,794 lines of test code across 34 test files" | exact line count | unverifiable; static figure goes stale on every test commit | LOW |
| 244 | "100% of swap fees distributed to TOWELI stakers" | matches TOKENOMICS.md | INFO | INFO |
| 246 | "No proxy contracts — all code is immutable after deployment" | claim | not verified across all 21 contracts in CONTRACTS.md; needs sweep | MEDIUM |
| 260 | `https://immunefi.com/bug-bounty/tegridyfarms/` | external link | broken-link candidate (no fetch) | INFO |
| 259, 280 | `https://twitter.com/junglebayac` and `mailto:security@tegridyfarms.xyz` | external links / mailto | broken-link / mailto candidates | INFO |
| 290 | "Protocol admin controlled by team multisig" | claim | RisksPage L16 says single EOA. Direct contradiction. | HIGH |
| 291 | "All parameter changes require 24-48h timelock" | universal | matches FAQ/Risks framing; not strictly true (e.g., NFT pool spike-protection is per-pair) | LOW |

## LearnPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| — | Pure tab host re-exporting Tokenomics/Lore/Security/FAQ | no static content of its own | Inherits drifts from children. | INFO |

## LorePage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 24 | "5,555 apes" | JBAC supply | not contradicted by CONTRACTS.md (JBAC is external `0xd37264c7…`). External claim, candidate verify-on-OpenSea. | INFO |
| 34 | "100% of protocol revenue goes to stakers. No VC money. No insider allocations." | matches TOKENOMICS L31 ("Investors 0%") + L41 (100% to stakers) | OK | INFO |
| — | "Vote-escrow tokenomics. Cross-chain expansion." (Phase 07) | speculative roadmap | not in CONTRACTS.md; aspirational | LOW |

## ContractsPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| 41 | `GITHUB_BASE = 'https://github.com/tegridyfarms/tegridy-farms/blob/main'` | org `tegridyfarms` | RisksPage L228 + Security L139/166/173 use `fomotsar-commits/tegridy-farms`. **Org mismatch — half the GitHub links 404.** | HIGH |
| 360 | `https://github.com/fomotsar-commits/tegriddy-farms/issues?…` | typo "tegriddy" | constants.ts and CONTRACTS.md repo is "tegridy-farms" (single d). Other references use "tegridy-farms". Typo. | MEDIUM |
| 305-307 | `${GITHUB_BASE}/CONTRACTS.md` | uses `tegridyfarms` org | likely broken | MEDIUM |
| 344, 351 | `${GITHUB_BASE}/docs/WAVE_0_TODO.md` and `WAVE_0_RUNBOOK.md` | exists in CONTRACTS.md? | only `docs/TOKEN_DEPLOY.md` referenced in TOKENOMICS L15; runbook is referenced by ContractsPage but its existence not cross-confirmed in any source-of-truth file. | LOW |
| 65-71 | Core group addresses | imported | match constants.ts | INFO |
| 88-94 | `TegridyFeeHook` address `0xB6cfeaCf…0044` | imported | matches CONTRACTS.md L30 | INFO |
| 145 | TegridyLaunchpadV2 — `pending` if zero address | conditional | constants.ts L53 = `0x0…0`; status correctly flagged | INFO |

## InfoPage.tsx

| Line | Drift | Page says | Source-of-truth | Severity |
|---|---|---|---|---|
| — | Pure tab host (Treasury/Contracts/Risks/Terms/Privacy) | no static content claims | Inherits child drifts. | INFO |

---

## Critical wiring observations

1. **SecurityPage hardcodes addresses instead of importing from `constants.ts`** — directly causes drifts SP-1 (deprecated v1 staking) and SP-2 (wrong NFT lending address). This is the single highest-leverage fix: import from `constants.ts` and the addresses can never re-drift.
2. **GitHub org mismatch**: ContractsPage uses `tegridyfarms/tegridy-farms`; SecurityPage + RisksPage use `fomotsar-commits/tegridy-farms`. Pick one (gitconfig says `fomotsar-commits` is the user) and replace-all.
3. **Repo name typo `tegriddy-farms`** in ContractsPage L360 — single-character bug breaks the issues link.
4. **Tokenomics distribution chart is fictional** — pie chart shows 65/20/10/5 but TOKENOMICS.md authoritative is 30/10/10/5/45. The chart's labels also do not include "LP seed" or "Team" buckets.
5. **TermsPage swap fee 0.3%** is the single most legally-exposed drift (a Terms-of-Service number that contradicts on-chain reality).
6. **FAQ lock duration "1-52 months"** is mechanically wrong; min is 7 days and max is 4 years (1460 days).
7. **No `dangerouslySetInnerHTML` calls** anywhere in the audited pages — FAQPage uses `script.textContent = JSON.stringify(...)` for FAQPage JSON-LD which is safe.

## Broken-link candidates (do NOT fetch)

- `https://immunefi.com/bug-bounty/tegridyfarms/` (SecurityPage L260)
- `https://twitter.com/junglebayac` (SecurityPage L259)
- `https://github.com/tegridyfarms/tegridy-farms/blob/main/...` (any link from ContractsPage; org likely doesn't exist)
- `https://github.com/fomotsar-commits/tegriddy-farms/issues?...` (ContractsPage L360, typo)
- `mailto:security@tegridyfarms.xyz` (PrivacyPage L35/55, SecurityPage L280)

---

*End of agent 055 report. AUDIT-ONLY — no code changed.*
