# Changelog

All notable changes to Tegriddy Farms are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
