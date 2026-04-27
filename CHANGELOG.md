# Changelog

All notable changes to Tegriddy Farms are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Ongoing investor-polish and audit-closure work. Lands on `main` as it ships;
a tagged release will cut from here once Wave 0 redeploys are complete.

### 2026-04-26 — Post-remediation audit campaign (3 Crit + 7 High + 5 Med + 2 EIP-170 splits)

#### Summary

A focused multi-pass audit + remediation campaign that discovered the prior
R017/R020/R023/R028 doc-claimed remediations had not actually shipped to
`main`, then closed those gaps plus 4 additional confirmed Mediums plus 2
EIP-170 deployability blockers (TegridyStaking + SwapFeeRouter both exceeded
the 24,576-byte mainnet limit). Reference
[`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md)
for the full per-finding breakdown.

#### Critical (3)

- **C-1** TegridyDropV2: legacy single-step `setMerkleRoot(bytes32)` replaced
  with timelocked `proposeMerkleRoot` / `executeMerkleRoot(bytes32)` /
  `cancelMerkleRoot` (24h delay, value-bound, phase-gated to CLOSED /
  CANCELLED / paused only). Replaces R023 H-01 doc-claimed-but-unshipped fix.
- **C-2** TegridyStaking: `MAX_POSITIONS_PER_HOLDER` lowered 100 → 50 to halve
  every external integrator's `votingPowerOf` gas cost (ReferralSplitter,
  RevenueDistributor checkpoint-fallback path, governance consumers).
- **C-4** VoteIncentives: zero-vote epoch bribes were permanently locked
  (refundOrphanedBribe required un-snapshotted epoch; claimBribes rejected
  on zero votes). Added `refundUnvotedBribe(epoch, pair, token)` —
  permissionless per-depositor pull, gated by 14-day grace after revealDeadline.
  Replaces R020 H-1.

#### High (7)

- **H-1 / H-1b** TegridyFactory: `setGuardian` was a 1-step setter with no
  validation. Replaced with `proposeGuardianChange` / `executeGuardianChange`
  (48h timelock); legacy `setGuardian` remains for the initial post-deploy
  set only (`guardian == address(0)` gate). Replaces R028 H-01.
- **H-2** TegridyFactory: `emergencyDisablePair` previously cancelled ANY
  pending PAIR_DISABLE_CHANGE proposal — including governance-queued disables.
  Now only cancels pending RE-ENABLE proposals; pending DISABLEs are
  preserved (governance audit trail intact, circuit-breaker still effective).
- **H-5** TegridyFeeHook: `executeSyncAccruedFees` legacy
  `if (actualCredit > old) revert SyncReductionTooLarge()` blocked all
  upward sync corrections, leaving no recovery path for accruedFees drifting
  below true PoolManager balance. Now allows upward sync bounded by
  `IPoolManager.balanceOf(this, currencyId)` (tamper-proof on-chain credit).
- **H-7** TegridyRestaking: `decayExpiredRestaker` reordered per R017 RETRY
  (settle → shrink `totalRestaked` → `_accrueBonus()` → re-anchor). Honest
  restakers no longer underearn during the lock-expiry window. CEI tightened
  (bonusDebt anchored before transfer). Replaces R017 H-3.
- **H-8** TegridyRestaking: per-restaker boost checkpoints via
  `Checkpoints.Trace208`. `boostedAmountAt(_user, _ts)` now returns the
  historical value at `_ts` (via `upperLookup`) instead of the current
  decayed cache. RevenueDistributor restakers no longer silently
  undercompensated post-decay.
- **H-12 / H-12b** VoteIncentives: ERC20 dust deposits (1 wei) could fill
  MAX_BRIBE_TOKENS slots and DoS legitimate bribes. Added
  `DEFAULT_MIN_TOKEN_BRIBE = 1e15` enforced when no per-token min is
  configured. Per-token override via timelocked
  `proposeMinBribeAmount` / `executeMinBribeAmount` (24h delay).
  Replaces R020 H-3.

#### Medium (5)

- **M-2** TegridyTWAP: `DeviationBypassed` event + `lastBypassUsed[pair]`
  mapping surface the rebootstrap-after-dormancy window so consumers (lending,
  POL accumulator, dutch-auction price) can cool-off / require a confirming
  observation.
- **M-16** POLAccumulator: `MIN_BACKSTOP_BPS` raised 5000 → 9000. Caps
  slippage at 10% on the addLiquidityETH leg (was effectively 50%, no
  protection against sandwich attacks).
- **M-24** TegridyStaking: `_splitPenalty` now uses ceiling division so
  sub-wei dust on small early-exit penalties favors stakers (recycle pool)
  rather than treasury.
- **M-28** MemeBountyBoard: `emergencyForceCancel` aggregate-votes branch
  (`totalBountyVotes >= 2x quorum`) now also requires
  `uniqueVoterCount >= MIN_UNIQUE_VOTERS`. Whales alone can no longer
  deadlock bounties.
- **M-30** PremiumAccess: `nonReentrant` added to `batchReconcileExpired`
  for parity with `cancelSubscription`.

#### Architectural fixes (2 EIP-170 splits)

- **TegridyStaking → TegridyStaking + TegridyStakingAdmin**: 29,461 → 22,492
  bytes (saved 6,953; +2,084 margin under EIP-170). All 7 timelocked admin
  triplets moved to the sister contract. Wired via `staking.setStakingAdmin(addr)`.
- **SwapFeeRouter → SwapFeeRouter + SwapFeeRouterAdmin**: 25,930 → 16,735
  bytes (saved 9,195; +7,841 margin). All 9 timelocked admin triplets moved.
  Wired via `router.setSwapFeeRouterAdmin(addr)`.

#### Frontend / indexer integrations

- Restored + extended `frontend/scripts/extract-missing-abis.mjs` to
  generate `TEGRIDY_STAKING_ADMIN_ABI` + `SWAP_FEE_ROUTER_ADMIN_ABI`
  alongside the 8 prior ABIs. Output written to
  `frontend/src/lib/abi-supplement.ts`.
- `frontend/src/lib/constants.ts`: added
  `TEGRIDY_STAKING_ADMIN_ADDRESS` + `SWAP_FEE_ROUTER_ADMIN_ADDRESS`
  placeholders (operators populate post-deploy).
- Indexer subscribes to both admin contracts via shared
  `TimelockAdminMinimalAbi`. ProposalCreated / Executed / Cancelled events
  written to existing `timelockProposal` table with discriminator. Addresses
  sourced from `TEGRIDY_STAKING_ADMIN_ADDRESS` /
  `SWAP_FEE_ROUTER_ADMIN_ADDRESS` env vars.
- `useLPFarming().refreshBoost(target)` action exposed.
  `useAutoRefreshBoost` hook detects boost-not-applied (holdsJBAC && stake &&
  effective < raw * 1.4) and surfaces / auto-fires refresh. Closes F-7.

#### Operator follow-ups

1. Deploy `TegridyStakingAdmin(staking)` + call
   `staking.setStakingAdmin(admin)` (one-shot).
2. Deploy `SwapFeeRouterAdmin(router)` + call
   `router.setSwapFeeRouterAdmin(admin)` (one-shot).
3. Update `frontend/src/lib/constants.ts` admin placeholders with deployed
   addresses.
4. Set indexer env vars `TEGRIDY_STAKING_ADMIN_ADDRESS` +
   `SWAP_FEE_ROUTER_ADMIN_ADDRESS` for production sync.
5. Update `contracts/script/ConfigureFeePolicy.s.sol`
   `SWAP_FEE_ROUTER_ADMIN` constant.

### 2026-04-25 — Wave 1–4 bulletproofing (~80 R-fixes)

#### Summary

Wave 1–4 bulletproofing — ~80 R-fixes; build green; tests pass. Reference
[`.audit_101/MASTER_REPORT.md`](./.audit_101/MASTER_REPORT.md) +
[`.audit_101/DETAILED_REPORT.md`](./.audit_101/DETAILED_REPORT.md) +
[`.audit_101/remediation/REMEDIATION_REPORT.md`](./.audit_101/remediation/REMEDIATION_REPORT.md).
Per-fix change logs at [`.audit_101/remediation/R001.md`](./.audit_101/remediation/R001.md)
through [`R076.md`](./.audit_101/remediation/R076.md).

#### Breaking constructor / behaviour changes (require redeploy)

- **R003** — `TegridyLending` constructor adds `_twap` arg (5→6 args). ETH
  collateral floor now reads `TegridyTWAP.consult()` instead of spot reserves.
- **R015** — `POLAccumulator` constructor adds `_twap` arg (4→5 args) +
  `LPMismatch` factory check that the LP token matches the pair the TWAP watches.
- **R020** — `VoteIncentives` constructor adds `_commitRevealFromGenesis`
  boolean (6→7 args); also adds `refundUnvotedBribe()` (closes Spartan TF-13).
- **R029** — `TegridyNFTLending` no longer auto-whitelists collections at
  construction. Post-deploy must call `proposeWhitelistCollection(addr)` →
  24h timelock → `executeWhitelistCollection(addr)` per collection
  (JBAC / Nakamigos / GNSS).

#### Wave 0 still pending

Per memory `project_wave0_pending.md`: `VoteIncentives` + `V3Features` +
`FeeHook-patch` redeploys plus multisig `acceptOwnership` on 3 contracts
(LP Farming, Gauge Controller, NFT Lending) by Safe
`0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`. Tracked in
[`docs/WAVE_0_TODO.md`](./docs/WAVE_0_TODO.md) §3.

#### Docs

R008 + R076 + RC3 doc-truth-up sweep across `FAQ.md`, `REVENUE_ANALYSIS.md`,
`SECURITY.md`, `README.md`, `FIX_STATUS.md`, `DEPLOY_RUNBOOK.md`,
`DEPLOY_CHEAT_SHEET.md`, `NEXT_SESSION.md`, `AUDITS.md` — removed fictional
claims (no `burn()` in `Toweli.sol`; no `SWAP_FEE_BPS = 50` constant on
`SwapFeeRouter`; no live Immunefi page; deleted `redeploy-patched-3.sh`),
flagged Wave-0 multisig migration as PENDING.

### 2026-04-19 — Batch 7d: ETH-denominated collateral floor on `TegridyLending`

#### Added

- **`LoanOffer.minPositionETHValue`** — optional ETH floor alongside the
  existing TOWELI floor (addresses audit critique 5.4). `createLoanOffer`
  takes a 5th arg; zero preserves the pre-batch behaviour. `acceptOffer`
  reads `TegridyPair.getReserves()` and reverts `InsufficientCollateralValue`
  when the borrower's position values below the threshold.
- **`ITegridyPair` interface + `pair` / `toweli` immutables** on
  `TegridyLending`. Constructor takes a 4th `_pair` arg; TOWELI orientation
  is resolved at deploy time.
- **`contracts/test/TegridyLending_ETHFloor.t.sol`** — zero-floor no-op,
  floor-met, floor-breached-reverts, same-block sandwich documentation test,
  and a token0/token1 orientation test.
- **`DeployV3Features.s.sol`** — reads `TOWELI_WETH_PAIR` env override for
  the new constructor arg.

#### Notes

- V3Features redeploy is still pending per `docs/WAVE_0_TODO.md`, so the
  breaking ABI change is acceptable and `docs/SECURITY_DEFERRED.md` now
  marks critique 5.4 as partially addressed (spot-reserve risk acknowledged,
  TWAP upgrade still pending).

### 2026-04-19 — Wave 0 status surfaced on /contracts + tracking issue

#### Added

- **Wave 0 status badges** on [`ContractsPage`](frontend/src/pages/ContractsPage.tsx).
  New `redeploy` (orange) and `multisig` (sky-blue) badge types alongside the
  existing `pending` (amber) / `deprecated` (grey) pills, each with a
  one-liner explaining what the user is looking at. A legend block at the
  top of the page mirrors the runbook.
  - **`pending deploy`** — `TegridyLaunchpadV2`. Not yet broadcast; placeholder
    `0x0…0` in `constants.ts`.
  - **`redeploy queued`** — `TegridyFeeHook` (owner stranded on Arachnid
    CREATE2 proxy; constructor patched to accept `_owner`),
    `VoteIncentives` (needs to partner the Wave 0 commit-reveal
    GaugeController), `TegridyLending`, `TegridyLaunchpad (V1)`,
    `TegridyNFTPoolFactory` (V3Features bundle with the H-10 refund-flow
    patch on the TegridyDrop template).
  - **`awaiting multisig`** — `LP Farming`, `Gauge Controller`, `NFT Lending`
    (Wave 0 redeploys live, but the multisig
    `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` still has to call
    `acceptOwnership()` on each).
- **`TegridyFeeHook`** now surfaced in the DEX group on `/contracts` (was
  previously only linked from MIGRATION_HISTORY). Constant
  `TEGRIDY_FEE_HOOK_ADDRESS` imported explicitly.
- **Wave 0 outstanding-work section** on MIGRATION_HISTORY.md with the same
  four-bucket breakdown (pending, redeploy-queued, multisig-accept, post-
  deploy wiring) so the UI and doc can't drift.
- **`docs/WAVE_0_TODO.md`** — tick-box checklist mirroring the contracts-
  page badges. Written in GitHub-flavoured Markdown so the body pastes
  straight into a tracking issue labelled `await-wave0` without
  reformatting. Referenced from the `/contracts` legend and from
  `WAVE_0_RUNBOOK.md`.

#### Changed

- `ContractEntry` status union extended from `'pending' | 'deprecated'` to
  `'pending' | 'deprecated' | 'redeploy' | 'multisig'`, plus an optional
  `note` rendered under the contract label for the two new states.

#### Fixed

- **Liquidity pool-stats card transparent** ([LiquidityTab.tsx](frontend/src/components/swap/LiquidityTab.tsx)) —
  removed the full-bleed `ArtImg` backdrop and the `rgba(16,185,129,0.05)`
  emerald tint from the "Your share / Rate / Your LP tokens" card. Border
  stays, card fill is now transparent so the page background shows through.
- **Token Lending tab bar** ([LendingSection.tsx `TabNav`](frontend/src/components/nftfinance/LendingSection.tsx)) —
  `Lend / Borrow / My Loans` were rendered as bare text over the mascot
  art, with the active tab using `text-black` that vanished against dark
  backgrounds. Rewrote to match the NFT Lending pattern: solid black
  container (`rgba(0,0,0,0.85)`), `flex-1` buttons, full-pill `var(--color-stan)`
  background on the active tab, white text on both states.
- **NFT Lending tab bar** ([NFTLendingSection.tsx](frontend/src/components/nftfinance/NFTLendingSection.tsx)) —
  container background bumped from `rgba(13,21,48,0.4)` to
  `rgba(0,0,0,0.85)` for the same reason.

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
