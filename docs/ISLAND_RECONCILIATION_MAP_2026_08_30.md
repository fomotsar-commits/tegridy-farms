# WO-0 companion — the `claude/bungalow-buildout` (#341) reconciliation map

**2026-08-30, against trunk `da8f05d4` vs PR branch `3ed95a6a` (merge-base `6d16ce31`).**
This is the file-by-file instruction set for `ISLAND_BUILDOUT_MASTER_PLAN_2026_08_30.md`
§WO-0. Trunk moved 65 commits; 21 of the PR's 43 files overlap; the other 22 rebase clean.
Law: **trunk's rebuilt files are the base; the PR contributes only still-novel deltas.**

## Rebase order (minimizes pain; dependencies first)

1. Base scanner block (PR-only) → unblocks every `&chain=base` link elsewhere.
2. DOORS ×10 unfurls + harness/e2e/test updates (PR-only) → unblocks sitemap lines.
3. `bungalows.ts` → 4. `bungalowStaking.ts` → 5. `LighthousePoolLive.tsx` → 6. the rest.

## Per-file verdicts

**KEEP** = re-apply the PR's delta on trunk's version · **DROP** = trunk shipped it
(sometimes better) · **REDESIGN** = trunk rebuilt the file; port only the named pieces.

| File | Verdict | Instructions |
|---|---|---|
| `components/bungalow/BungalowDoor.tsx` | SPLIT | **DROP** the PR's reload-loop fix — trunk `5ab31a37` is a superset (verified persist + `bungalow-door-entering` sessionStorage one-shot + `entryBlocked` render). **KEEP** (a) the `?bungalow=` param strip before deciding — trunk still ping-pongs on `/bayla?bungalow=toweli`, its marker only bounds the loop; (b) the `!live → <BungalowDoorLanding>` branch + lazy import. |
| `components/bungalow/BungalowFarmPanel.tsx` | SPLIT | **DROP** the venue-swap-fee bullet rewrite — trunk `5abe5abb` gates it on `isSolanaFeeConfigured()` (live-state-driven beats static hedge). **KEEP** the pump-mint gate on the creator-fee bullet + `bungalowScanRoute()` + `kind==='chart'` labels. Adopt trunk's rename `isSolanaConfigured → isSolanaSwapLive`. |
| `components/bungalow/BungalowDashboardPanel.tsx` | mostly DROP | Trunk rebuilt it (+367: live position card, market/holders mounts, rate+vault pairing). **DROP** our copy + decimals hunks; **take trunk's `decimals = poolRead?.decimals ?? 6`** but keep the registry `decimals` field as the pre-read fallback (`?? bungalow.decimals ?? 6`). **KEEP** `bungalowScanRoute()` + chart label. |
| `public/sitemap.xml` | SPLIT | **DROP** `/solana-launch` removal (trunk did it + a never-re-add comment + `/eth-curve`). **KEEP** the ten settled-door URLs, placed after `/eth-curve`, and only once DOORS ×10 is in. |
| `components/bungalow/LighthousePoolLive.tsx` | REDESIGN — the file that justifies the rebase | Base = trunk's 605-line rebuild (it already has vault headline, empty banner, outage≠zero, paying-now vs configured, runway prose). **Port in the four absentees:** (1) `stakeBlocked` — pause NEW stakes while the vault is materially empty (the devnet-6012 exit-safety gate; trunk's stake button ignores the vault); (2) the dust-proof materiality predicate (trunk tests `=== 0n` only — 1 raw unit defeats the banner); (3) `entriesKnown` — a failed `readEntries` must not render as "you have nothing staked"; (4) same-mint vault filter (trunk sums ALL reward pools into the headline). Plus "Nothing claimable yet" labels + 6012 explanation text. |
| `lib/bungalows.ts` | LAYER | Keep trunk's `market` field + pool repin (`EFWpSpH9…`) + `bungalowArtContext`. Layer the PR's: `community` field + 7 entries, `decimals` field (+ Bayla 6 + verified-extensions comment), `bungalowTradeRoute → {href, kind}` with host-anchored `isDexscreenerUrl` (CodeQL fix), `bungalowScanRoute()`, storage-key eviction comment. Hero copy: keep the PR's "the pool is live on-chain" line — true of the NEW pool. |
| `components/launcher/CurveTradePanel.tsx` | REDESIGN | Trunk added receipts/refetch/deferred-graduation/finalize UI/UnknownLaunch state. **KEEP** the PR's on-chain `name()`/`symbol()` fallback (2 ABI entries + 2 gated reads + `fallbackName` through `IdentityHeader`) and the graduated card's `/swap` Link. Re-anchor all four conflicted regions. |
| `pages/EthCurvePage.tsx` | SEMANTIC | Trunk renamed "survival reserve" → "**ecosystem reserve** (not enforced on-chain)" and "audited" → "**internally reviewed**". **KEEP** the PR's creator-share bullet + the stack-packaging block, **re-worded to trunk's vocabulary** — never re-introduce the old words. Links all still valid. |
| `pages/EthCurvePage.economics.test.tsx` | SPLIT | Take trunk's assertions (`ecosystem reserve`, `not enforced on-chain`). Keep ONLY the PR's `MemoryRouter` wrap (needed once the block has `<Link>`s). |
| `components/launcher/CurveTradePanel.test.tsx` | BOTH | Keep trunk's deferred-graduation describe block AND the PR's `MemoryRouter` in the shared `view()` helper. Append-order conflict only. |
| `pages/CurveTokenPage.tsx` | LAYER | Trunk added receipt-status to `CurveCreatorClaim`. **KEEP** the PR's: `EvmCurveChart` mount + `graduationEth` in the launch cast (trunk's cast lacks it), graduated aftermarket card, trust strip (CA/explorer/scan-with-chain/deployer/trust). The `&chain=base` link depends on the Base scanner landing first. |
| `pages/HomePage.tsx` | ONE HUNK | Trunk rewrote much (isSolanaSwapLive ×4, BungalowMarket/Holders mounts). **KEEP** only the PR's `!bungalowIdentity` gate on `WrongChainBanner` — still absent on trunk. |
| `pages/TradePage.tsx` | BOTH | Trunk added `ChainSwitch` + touch floors. **KEEP** the PR's swap-tab strip (`RealYieldProof` + creator-share line) — but re-read the "deepest creator share… we know of" superlative against trunk's honesty-vocabulary bar before shipping. |
| `scripts/bayla-lighthouse-ceremony.mjs` | KEEP WHOLE | The PR's 144-line `--dry-vault` mode is entirely inside `rehearse()`; trunk touched only the mainnet path (ladder print, 7d ceiling). Zero hunk overlap. |
| `lib/bungalowStaking.ts` | REDESIGN | **DROP** `maxWeightRaw` (trunk shipped the superset: `min/maxWeightScaled` bigints + `stakeWeightScaled/lockPresets/defaultLockDays/configuredAnnualRate/vaultRunwaySecs`). **KEEP** the three honesty fixes trunk lacks: 6012 mapping in `writeFailure`; post-broadcast-timeout "Outcome unknown + signature" guard; `readPool` account-not-found ≠ outage. Ship ONE runway helper: port `vaultIsMateriallyEmpty` onto trunk's `vaultRunwaySecs`; drop our `runwayDays`. |
| `lib/bungalowStaking.test.ts` | SPLIT | **DROP** `maxWeight` fixture additions + `maxWeightRaw` assertion. **KEEP** the timeout + 6012 mapping tests; keep display-helper tests only for whichever helpers survive. |
| `lib/bungalows.test.ts` | KEEP | All three new tests (chart kind, scan route chain param, decimals) + imports; nothing collides with trunk's repin assertions. |
| `docs/BAYLA_BUNGALOW.md` | RENUMBER | Trunk's §6f is now the RETIRED first ceremony; **renumber the PR's dry-vault section to §6h**. Content stays — it is the proof-of-record for 6012. |
| `components/bungalow/BungalowHero.tsx` | KEEP | Adopt `isSolanaSwapLive`; keep `bungalowScanRoute`, chart label, "The lighthouse" no-pool CTA fallback. |
| `pages/ArtStudioPage.tsx` | RE-TARGET | Trunk extracted 825 lines — verify `SURFACES` still lives here; rename the PR's labels `BD1/BD2` → `ID1/ID2` (BD collides with Dashboard). |
| `pages/CurveLaunchPage.tsx` | KEEP | The dead-end escape links in `DeploymentBanner`; trunk only touched explainer copy. Three-chain phrasing already consistent with trunk's HomePage. |
| `pages/ScannerPage.tsx` + `lib/scanner/*` + `api/_lib/scannerApi.js` + `api/v1/index.js` + their tests | KEEP (PR-only in effect) | Trunk has zero Base scanner content. Land first. |
| `components/bungalow/BungalowDoorLanding.tsx`, `components/launcher/EvmCurveChart.tsx`, `scripts/render-bungalow-doors.mjs`, `e2e/bungalow-doors.spec.ts`, `lib/bungalowDoors.test.ts`, `scripts/verify-bungalows.mjs` (+4), `lib/storage.ts` + test (EVICTION_PROTECTED_KEYS — real fix, trunk lacks it), `api/solrpc.js` filters gate + test (re-read against trunk's :66 branch, likely additive), `pages/GalleryPage.tsx` community render, `docs/JUNGLE_BAY_ISLAND_PLAN.md` edits (restate against trunk's /pools + repin first) | KEEP | Clean-rebase set. |

## Drop-entirely list (trunk's versions won)

Door reload-loop mechanism · farm-panel swap-fee copy · dashboard copy+decimals hunks ·
sitemap `/solana-launch` removal · `maxWeightRaw` + its fixtures · the `survival reserve`
test assertion · our `runwayDays` (superseded by `vaultRunwaySecs` + ported predicate).

## Acceptance for the reconciled branch

Full unit suite + `tsc -b` app&test + eslint 0 errors + doors/a11y e2e (chromium +
mobile-chrome; webkit via CI) + `verify-bungalows.mjs` 37/37 + built-bundle chunk check
(no vendor-solana in entry preloads; landing chunk solana-free) — then merge #341.
