# Changelog

All notable changes to Tegriddy Farms are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Ongoing investor-polish and audit-closure work. Lands on `main` as it ships;
a tagged release will cut from here once Wave 0 redeploys are complete.

### 2026-04-18 — Wave 0 deploys + V2 launchpad build-out

#### Added

- **Wave 0 mainnet redeploys (6 of 8 contracts)**:
  - `TegridyLPFarming` `0xa7EF711Be3662B9557634502032F98944eC69ec1` — C-01 `MAX_BOOST_BPS_CEILING=45000` live.
  - `TegridyNFTLending` `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` — C-02 1h grace period live.
  - `GaugeController` `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` — H-2 commit-reveal live on-chain.
  - `TegridyTokenURIReader` `0xfec9aea42ea966c9382eeb03f63a784579841eb2` — points at v2 staking.
  - `TegridyTWAP` `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` — new 30-min oracle.
  - `TegridyFeeHook` `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` — B7 closed; address ends `0x0044` for V4 `AFTER_SWAP`+`AFTER_SWAP_RETURNS_DELTA` permissions. **Caveat:** initial deploy via Arachnid CREATE2 proxy stranded ownership; constructor patched to accept `_owner` (see Fixed). Redeploy pending.
  - Pending: `VoteIncentives` + `V3Features` (5 contracts) — blocked on deployer ETH top-up.
- **V2 Launchpad contracts (compiled + tested, deploy pending)**:
  - [TegridyDropV2.sol](contracts/src/TegridyDropV2.sol) — ERC-7572 `contractURI()`, single `InitParams` struct for atomic clone-init, `ContractURIUpdated` event, `setContractURI` setter.
  - [TegridyLaunchpadV2.sol](contracts/src/TegridyLaunchpadV2.sol) — click-deploy factory. `createCollection(CollectionConfig)` wires name/symbol/supply/royalty/placeholderURI/contractURI/merkleRoot/dutch-auction/initialPhase in one tx. Preserves legacy `CollectionCreated` event topic + emits `CollectionCreatedV2`.
  - [DeployLaunchpadV2.s.sol](contracts/script/DeployLaunchpadV2.s.sol) + [TegridyLaunchpadV2.t.sol](contracts/test/TegridyLaunchpadV2.t.sol) (11 tests pass).
- **NFT Launchpad creator wizard** under `frontend/src/components/launchpad/wizard/` — 5 steps (Connect → Upload → Preview → Fund+Arweave → Deploy), single-reducer state machine, virtualized preview grid via `@tanstack/react-virtual`, per-token `TraitEditor` modal, responsive `WizardStepper`. 45 Vitest reducer tests.
- **Arweave integration via Irys** — permanent storage, artist pays ETH in one session:
  - [irysClient.ts](frontend/src/lib/irysClient.ts) — `WebUploader(WebEthereum).withProvider(window.ethereum)`.
  - [useIrysUpload.ts](frontend/src/hooks/useIrysUpload.ts) — `quote`, `fund`, `uploadFolder`, `uploadJsonFolder` with progress + retry-friendly errors.
  - [useWizardPersist.ts](frontend/src/hooks/useWizardPersist.ts) — throttled localStorage draft; partial-upload resume (re-funding skipped, completed sub-uploads skipped).
  - [nftMetadata.ts](frontend/src/lib/nftMetadata.ts) — CSV parser (Thirdweb headers, 16-attribute pairs), OpenSea token + contractURI builders, validators (25 Vitest tests).
  - [frontend/public/sample-collection.csv](frontend/public/sample-collection.csv) + "Download template" link in Step 2.
  - npm: `@irys/web-upload`, `@irys/web-upload-ethereum`, `@tanstack/react-virtual`, `papaparse`.
- **V2 detail + admin surfaces**:
  - [useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts) — parallel v1 hook with Arweave `contractURI()` fetch, 8s AbortController timeout, graceful fallback.
  - [CollectionDetailV2.tsx](frontend/src/components/launchpad/CollectionDetailV2.tsx) — banner hero from Arweave JSON, phase indicator, paused banner, mint panel with allowlist proof, owner-only admin.
  - [OwnerAdminPanelV2.tsx](frontend/src/components/launchpad/OwnerAdminPanelV2.tsx) — setContractURI, Dutch auction builder, pause/unpause, ownership transfer.
- **Tabbed pages** (TradePage pattern):
  - [LearnPage.tsx](frontend/src/pages/LearnPage.tsx) — Tokenomics / Lore / Security / FAQ under one route.
  - [ActivityPage.tsx](frontend/src/pages/ActivityPage.tsx) — Points / Gold Card / History / Changelog under one route.
- **V2 wagmi hooks** — [wagmi.config.ts](frontend/wagmi.config.ts) includes `TegridyLaunchpadV2` + `TegridyDropV2`. `TEGRIDY_LAUNCHPAD_V2_ABI` + `TEGRIDY_DROP_V2_ABI` exported. `TEGRIDY_LAUNCHPAD_V2_ADDRESS` placeholder until broadcast; frontend gates reads on `isDeployed()` so no reads fire at zero address.
- **Docs**: [LAUNCHPAD_GUIDE.md](docs/LAUNCHPAD_GUIDE.md) (creator walkthrough), [LAUNCHPAD_V2_ARCHITECTURE.md](docs/LAUNCHPAD_V2_ARCHITECTURE.md) (dev reference), [LAUNCHPAD_V2_NOTES.md](docs/LAUNCHPAD_V2_NOTES.md) (post-deploy flip checklist).

#### Changed

- **Nav IA**: Top nav "Lending" → "NFT Finance". "More" dropdown pruned to Gallery / Tokenomics / Changelog (Points, Gold Card, History, FAQ, Lore, Security still URL-reachable via their tabbed host pages).
- **Top bar theme**: Black in dark mode (default), orange in light mode. Artwork covers full viewport behind the bar.
- **Collateral filter pills** in NFT Lending Borrow tab — resized to aspect-square cards with name + symbol labels, matching the Lend-tab selector.
- **LaunchpadSection** — lists v1 + v2 collections from both factories, `V1`/`V2` chips, detail routing by version tag.
- **Tabbed page hosts** — top padding bumped to `pt-32` on TokenomicsPage, SecurityPage, FAQPage, LeaderboardPage, PremiumPage, HistoryPage, ChangelogPage so content headings clear the sticky tab bar.
- **CONTRACTS.md / README.md / MIGRATION_HISTORY.md** — Wave 0 addresses updated with deprecated→canonical pairs and FeeHook ownership caveat.
- **indexer/ponder.config.ts** — `LPFarming` address swapped to Wave 0 redeploy.

#### Fixed

- **TegridyFeeHook constructor** now accepts `address _owner` instead of `msg.sender` from `OwnableNoRenounce`. Prevents CREATE2-proxy deploys from stranding ownership on the Arachnid factory (which was the failure mode of the 2026-04-18 broadcast at `0xB6cfeaCf…0044`). Tests + 3 audit-t files updated.
- **DeployTegridyFeeHook.s.sol** — rewritten to consume pre-computed `CREATE2_SALT` mined off-chain via `cast create2 --ends-with 0044`, bypassing the in-EVM miner's `MemoryOOG` at ~180k iterations. Runs in milliseconds; includes `require(hook.owner() == hookOwner)` post-deploy check.
- **LaunchpadSection `CARD_BG` undefined** — referenced in two JSX blocks but never declared; crashed the Launchpad tab. Added `const CARD_BG = 'rgba(6, 12, 26, 0.80)'`.

### Added
- **Commit-reveal voting at the contract layer** ([GaugeController.sol](contracts/src/GaugeController.sol)) —
  `commitVote`, `revealVote`, `computeCommitment`, `isRevealWindowOpen` with
  24h reveal window. Hash binds voter + tokenId + gauges + weights + salt +
  epoch; only the committer can reveal; NFT transfer forfeits vote. 14 new
  tests in [GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol).
  Closes audit H-2.
- **Commit-reveal UI** in [GaugeVoting.tsx](frontend/src/components/GaugeVoting.tsx)
  with mode toggle, localStorage salt persistence, pending-reveal banner,
  missing-salt warning.
- **Drop refund UI** on [CollectionDetail.tsx](frontend/src/components/launchpad/CollectionDetail.tsx)
  when sale is cancelled. Red banner + Claim Refund button bound to
  `paidByUser > 0`. Closes H10.
- **TegridyTWAP third-oracle leg** in [useToweliPrice](frontend/src/hooks/useToweliPrice.ts) —
  30-minute TWAP cross-checks pair-reserve spot price; divergence beyond 2%
  flips to TWAP (manipulation-resistant). `twapOverrideActive` signal exposed
  to consumers.
- **GitHub surface:** LICENSE (MIT), NOTICE.md (third-party attributions +
  South Park fair-use statement), HALL_OF_FAME.md, .gitattributes, .nvmrc,
  FUNDING.yml, dependabot.yml, CodeQL workflow, Slither workflow, contracts-ci
  workflow, release workflow.
- **Docs:** MIGRATION_HISTORY.md (canonical vs deprecated addresses),
  DEPRECATED_CONTRACTS.md (orphans: TegridyFarm, FeeDistributor, WithdrawalFee),
  TOKEN_DEPLOY.md (how TOWELI was deployed + CREATE2 vanity notes),
  GOVERNANCE.md (admin-key threat model + multisig roadmap), DEVELOPING.md,
  DEPLOYMENT.md, API.md, SOCIAL_PREVIEW_SPEC.md (tracked).
- **Toweli.sol source** ([contracts/src/Toweli.sol](contracts/src/Toweli.sol)) +
  reference [DeployToweli.s.sol](contracts/script/DeployToweli.s.sol). Closes
  the biggest audit-trail gap: the live token at `0x420698…78F9D` now has a
  verifiable source in-repo.
- **ConnectPrompt** primitive for wallet-gated empty states on Farm / Lending /
  Trade / Governance surfaces.
- **YieldCalculator** — wallet-less estimator on HomePage so first-time
  visitors see expected yield before committing.
- **Icon primitive** under `components/ui/Icon.tsx` with locked stroke-width.
- **copy.ts** — centralises every character-named string (Randy / Towelie /
  DEA / Cartman) so a rebrand is a single-file diff.
- **Social preview banner** at [docs/banner.svg](docs/banner.svg) +
  `frontend/public/og.svg`; README renders it as hero.
- **README badges:** CI / CodeQL / Slither / License / Solidity / Chain.
- **Scripts:** `redeploy-patched-3.sh`, `diff-addresses.ts`,
  `extract-missing-abis.mjs`.
- **ABI supplement** ([frontend/src/lib/abi-supplement.ts](frontend/src/lib/abi-supplement.ts)) —
  8 missing contracts extracted from forge artifacts.
- **txErrors helper** with viem `UserRejectedRequestError` handling +
  `shortMessage` extraction.
- **Vercel security headers:** HSTS → 2y + preload, X-Permitted-Cross-Domain-
  Policies, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy,
  extended Permissions-Policy opt-out.

### Changed
- **Nav IA:** top nav cut from 21 routes to 5 primary (Dashboard / Farm /
  Trade / Lending / Governance); mobile mirrors desktop; Footer organised
  into Product / Resources / Community / Legal columns.
- **Meme voice shipped across product** via copy.ts: receipt labels
  ("LOCKED DOWN, WITH TEGRIDY", "HARVEST COMPLETE", "TEGRIDY REGISTERED"),
  lock durations ("The Taste Test" → "Till Death Do Us Farm"), penalty
  reframe ("DEA Raid Tax — for the kids' college fund"),
  [VoteIncentives](frontend/src/components/community/VoteIncentivesSection.tsx)
  section → "Cartman's Market — Totally Not Bribes", FAQ opener rewritten.
- **Nav link contrast** fixed: `#d4a843` (2.8:1, fails WCAG AA) →
  `#f5e4b8` (13.5:1, AAA). Light mode → `#4c1d95` (10.4:1, AAA).
- **Mobile tables → cards** below 480px on BoostScheduleTable and
  ContractsPage with 44×44 tap targets.
- **TransactionReceipt** labels re-sourced from [copy.ts](frontend/src/lib/copy.ts).
- **HomePage audit badge** with link to `/security`.
- **iPhone 14 Pro safe-area:** new `.pb-safe` utility using
  `env(safe-area-inset-bottom)`.
- **isPending guards** on AMMSection (3 buttons); NFTLendingSection already
  had them.
- **useToweliPrice** silent `.catch(() => {})` replaced with scoped
  `console.warn` (ignoring expected AbortError).
- **README rewritten** as an investor-grade reference with elevator pitch,
  TOC, user flow, dev flow, honest audit status.
- **FAQ boost claim** corrected from stale "2.5×" to accurate "0.4×–4.0× +
  0.5× JBAC = 4.5× ceiling".
- **Manifest icon** fixed: broken `skeleton.jpg` refs replaced with existing
  `/splash/icon-192.png` + `/splash/icon-512.png` (added `any maskable`).
- **Sitemap.xml** gets `lastmod` + `changefreq` on every URL; `/contracts`
  and `/treasury` added.
- **usePageTitle** extended with canonical `<link>`, `og:url`, `twitter:url`,
  `twitter:title`, `twitter:description`, and per-page `og:image` override
  (backward-compatible signature).
- **TegridyDrop ABI fix:** `currentPhase` → `mintPhase` (contract-canonical;
  the prior entry reverted on-chain). Added `cancelSale`, `refund`,
  `paidPerWallet`.
- **Indexer TegridyStaking address** fixed from stale v1 `0x65D8…a421` to
  canonical v2 `0x6266…4819` in [ponder.config.ts](indexer/ponder.config.ts).
- **Frontend package.json + indexer/package.json:** added `"license": "MIT"`
  and `"engines": { "node": ">=20.0.0" }`.
- **OwnerAdminPanel Danger Zone** — `cancelSale()` wired with
  `window.confirm` double-prompt.

### Fixed
- Stale contract addresses in 4 deploy scripts (Gap A sed — `0x65D8…` →
  `0x6266…`).
- `TegridyLPFarming.exit()` added — frontend's existing `useLPFarming.exit()`
  call no longer reverts.
- `TegridyNFTLending` added `GRACE_PERIOD = 1 hours` to `repayLoan` +
  `claimDefault`.
- `TegridyDrop`: added `MintPhase.CANCELLED`, `cancelSale()`, `refund()`,
  `paidPerWallet` tracking, `SaleCancelledEvent` + `Refunded` events.
- `ConstantsPage` navigation link routes corrected to SPA `<Link>`.
- `HistoryPage`: fetch cap raised 50 → 500, added 25-per-page pagination,
  resets on wallet change.
- `SecurityPage`: removed the inflated "5C/13H/26M/38L — all resolved"
  block; replaced with honest links to audit files.
- `ChangelogPage`: softened "Fixed all v4 audit findings" claim.
- `useLPFarming`: chain-id guard + proactive allowance check.
- `useSwapQuote`: `useChainId` wired so quotes don't fire on non-mainnet.
- Supabase migration 002: creates `native_orders`, `trade_offers`,
  `push_subscriptions` (tables were referenced but never created).

### Deferred
- **Indexer expansion** (GaugeController events, bounty submissions/votes,
  grants cancel/lapse/refund, restaking tombstone fix) — blocked by
  pre-existing Ponder `Virtual.Registry` TypeScript inference ceiling.
  Comment-form scaffolding retained for future re-enable. Consumers query
  contract state directly via wagmi until then.
- **Full nonce-based CSP** — requires Vite plugin tooling to inject nonces
  per inline script. Deferred in favour of additional security headers that
  don't break the build.
- **OG banner PNG export** — SVG ships now for modern social crawlers;
  PNG conversion for legacy compatibility is a follow-up.

### Removed
- `contracts/src/LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol`
  (superseded by `TegridyLPFarming`).
- `frontend/src/assets/{hero.png, react.svg, vite.svg}` (Vite starter
  cruft).
- `frontend/src/components/PageTransition.tsx` (unimported).

## [v3.0.0-pre] - 2026-04-17

Scope: fee split + NFT lending grace + drop refund + Gap-A sed sweep + Gap-B
LP farming selection + H-2 commit-reveal voting + Upstash rate limiting.

### Added
- Commit-reveal voting implementation (H-2) in contracts (a2cdcad).
- Real per-IP API rate limiting via Upstash Redis (API-M1) (dd1cf22).
- `DeployTegridyLPFarming` script for C-01 fixed farm (batch 23) (2e0eeae).
- `DeployTokenURIReader` folded into Gap A sed sweep (4f323fe).
- Paste-ready deploy cheat sheet (batch 22) (9c1d713).
- Pre-deploy runbook for audit remediation (batch 17) (414f489).
- TradePage E2E spec and overlay dismiss fixture (batch 16) (25014a0).
- E2E wallet-integrated test foundation (C-05) (d4967ad).
- H-2 commit-reveal design spike and API/indexer audit docs (895bd86).

### Changed
- Gap B locked to B2 — `TegridyLPFarming` selected as canonical farm (fca56a6).
- Gap A locked to A1 — `TokenURIReader` folded into the sed sweep (4f323fe).
- `framer-motion` refactored to `LazyMotion` across 45 files for bundle size
  reduction (batch 19) (a1f6afe).
- `ParticleBackground` and `GlitchTransition` lazy-loaded (batch 15) (3741cf2).
- Lending safety caps moved to timelocked state (TF-06 + H-05) (c0be03d).
- NFT Finance tab added to mobile nav; dashboard outstanding loans surfaced
  (9e8d667).

### Deprecated
- Legacy `LPFarming.sol` deprecated in favor of `TegridyLPFarming.sol`
  (Gap B decision, fca56a6).

### Removed
- `LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol` removed during
  Gap B consolidation (working tree).
- Inner `Suspense` that broke CSS preload on Nakamigos page (85eda15).
- `modulePreload` polyfill disabled to fix CSS preload crash (1c2ad9d).

### Fixed
- API batch 18: M2 filter regex + M8 SameSite cookie tightening (adcf5d4).
- Indexer batch 14: INDEXER-H1/M1/M2 fixes (3f2dac1).
- API batch 13: six API fixes from `API_INDEXER_AUDIT.md` (4859a4d).
- Frontend batch 12: E2E foundation runs (2 baseline + 1 new-spec) (a200130).
- Frontend batch 10: Spartan TF-03 claim-before-withdraw + contrast sweep
  (45a353d).
- Contracts batch 9: lending safety caps timelocked (TF-06 + H-05) (c0be03d).
- Contracts batch 8: five Spartan MEDIUM/LOW quick-win fixes (6e818e9).
- Contracts batch 7: six HIGH/MEDIUM fixes across Restaking, Factory, Lending,
  Routers (c782293).
- Contracts batch 6: cleared all 16 pre-existing test failures, 1 real bug
  fix (6ed299a).
- Contracts batch 5: lending transfer-gate whitelist (H-01), drop hardening
  (H-10/H-11) (3a6c198).
- Frontend batch 4: Privacy Policy accuracy (C-03) + SecurityPage audit
  links (2cf5135).
- Frontend batch 3: modal aria, tooltip keyboard, mint re-entry, targeted
  contrast (e30df41).
- Contracts batch 2: `TegridyLPFarming` ABI mismatch (C-01), `createOffer`
  guard (ab16308).
- Frontend batch 1: chain-aware explorer, validation, a11y, focus trap
  (434a4ab).
- Step-circle centering and dashboard outstanding loans fixed (9e8d667).
- Nakamigos CSS preload crash: CSS import moved to main bundle (714d839).
- `CommunityPage` crash: missing `Suspense` import (ed93506).
- Browser QA: Suspense tag, loader cleanup, text visibility (ae690eb).
- Seven broken lazy imports from deleted pages — `TradePage` swap UI
  rebuilt (bc9cc6b).

### Security
- All security audit findings cleared: C-01, H-01, H-02, M-01–M-04, L-01
  (2f06f84).
- `TegridyRestaking` and `ReferralSplitter` wired up (eab6e4b).
- 100-agent security scan remediation (1493904).
- `GaugeController` deployed to mainnet at
  `0xb6E4CFCb83D846af159b9c653240426841AEB414` (f217b13).
- Immunefi bounty program added alongside Vitest and deploy scripts (d0ac056).

## [v2.x] - earlier

### Added
- Major UX overhaul, security hardening, new contracts, and full audit fixes
  (3d8799b).
- Full NFT Lending UI with 3-tab interface (d578069).
- `NFTLending` + TWAP deployed; audit M-02 WETH fallback on `acceptOffer`
  fixed (629721a).
- Dark/light mode, 138 frontend tests, mobile responsive fixes (fefa250).
- Gauge voting, CSV export, Immunefi bounty, Vitest, deploy scripts (d0ac056).
- Art backgrounds on NFT Finance intro cards (ed0da44).
- Ten strategic recommendations for conversion optimization (5fdcdd4).

### Changed
- Restake combined into Token Lending tab (0f33c02).
- Marketplace splash renamed from Nakamigos to Tradermigos (7fc4bd5).
- Full audit remediation: 17 issues fixed, CI/CD added, wagmi codegen, new
  community UI (8cd9234).

### Fixed
- NFT Lending mobile responsiveness (050e27b).
- Mobile grid layouts collapse to single column on small screens (5f18a96).
- All v4 audit findings: C-02, C-03, C-04, H-01, H-03, M-01, M-04 (4b4d5d3).

[v3.0.0-pre]: https://github.com/fomotsar-commits/tegriddy-farms/tree/main
[v2.x]: https://github.com/fomotsar-commits/tegriddy-farms/commits/main
