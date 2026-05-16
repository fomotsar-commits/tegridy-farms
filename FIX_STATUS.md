# Fix Status — Rolling tracker

Running log of what's landed on `main` across the full 8-pass internal
audit lineage: 100→200→300→40-agent passes (Mar 2026), the 101-agent
canonical pass (`.audit_101/MASTER_REPORT.md` + remediation R001–R076,
Apr 25), microscope (Apr 30), DEEP_2026_05_01 v1/v2/v3 (May 1), pass-5
adversarial cross-contract (May 2), pass-6 fresh-eyes meta-audit
(May 3), pass-7 adversarial multi-agent audit + remediation
(May 3 → May 4), and pass-8 adversarial 100-agent audit + 18-batch
remediation (May 4 → May 6) — plus the [SPARTAN_AUDIT](SPARTAN_AUDIT.txt)
third-party review, the [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) ledger,
the 35-detective audit, and the 300-agent internal review. Per the
[`AUDITS.md`](AUDITS.md#honest-tldr) Honest TL;DR: 2 third-party reviews
+ 14 internal AI-agent passes; not a substitute for a paid human audit.
See [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) for the fee-lever
calibration.

**Cumulative current state (pass-8 closure count, 2026-05-06):** 418
findings carried through pass-7 + ~275 unique findings (after dedup
from ~675 raw) closed in pass-8 across 18 remediation batches
(10 Critical + ~140 High + ~165 Medium + ~110 Low + ~250 Info, with
owner-trust subset deferred to a dedicated multisig-policy phase) =
**~693 audit-tracked findings total** across the 8-pass lineage. Test
posture: **2,574 unit tests pass / 0 fail** on the active scope.
Contract surface bounded by the regression suites at
[`contracts/test/Pass6_Regressions.t.sol`](contracts/test/Pass6_Regressions.t.sol),
the pass-7 PoCs at
[`contracts/test/PASS7_*.t.sol`](contracts/test/) (9 files, 15 tests),
and the pass-8 PoCs at
[`contracts/test/PASS8_*.t.sol`](contracts/test/) (6 files: GOV_INT_01,
PHASE_1_6, PHASE_3_5, HOOK_ALLOWLIST, ROYALTY, ETH_COUNTERS = 46 tests
total). Source-of-truth master reports:
[`.audit_101/PASS8_2026_05_04.md`](.audit_101/PASS8_2026_05_04.md) (audit) +
[`.audit_101/PASS7_2026_05_03.md`](.audit_101/PASS7_2026_05_03.md) (prior pass) +
[`.audit_101/PASS6_2026_05_03.md`](.audit_101/PASS6_2026_05_03.md).

Last refreshed 2026-05-06 after the pass-8 18-batch remediation
landed all closure-eligible items using battle-tested patterns:
Solady ERC721 swap, Aerodrome/Velodrome bribe model, BendDAO offer-
expiry pattern, Synthetix checkpoint-at-interaction, Uniswap V4 hook
reference. For a richer Keep-a-Changelog view see
[CHANGELOG.md](CHANGELOG.md).

## 🔬 Pre-deploy deep-dive (2026-05-14 → 2026-05-16)

Honest single-reviewer pass on the four highest-blast-radius contracts
(`TegridyLending`, `TegridyLendingAdmin`, `TegridyNFTLending`,
`TegridyStaking`, `TegridyStakingAdmin`) before the fresh-wallet
relaunch — verified against current code, not transcript. Outcome:
**2 real fixes landed, 2 prior agent flags confirmed FALSE POSITIVES.**

### Real findings (fixed)

- **F-MIN-MAX-PRINCIPAL** (LOW) — `TegridyLending.applyMinPrincipalChange` /
  `TegridyLendingAdmin.proposeMinPrincipal` lacked paired-bound symmetry
  vs. the existing APR pair (DEEP-LD-L4). A captured admin could set
  `minPrincipal > maxPrincipal`, soft-bricking new-loan creation.
  Mirror-port the L4 pattern: revert when `newValue > maxPrincipal` at
  both propose-time and apply-time.
  [TegridyLending.sol:2273](contracts/src/TegridyLending.sol#L2273),
  [TegridyLendingAdmin.sol:391](contracts/src/TegridyLendingAdmin.sol#L391).
  Adversarial test:
  `test_minPrincipal_cannotExceedMaxPrincipal_paired` in
  [contracts/test/AuditR014_Lending.t.sol](contracts/test/AuditR014_Lending.t.sol)
  covers propose-time rejection, apply-time race, cancel+re-propose
  recovery path, boundary equality, and the default `maxPrincipal =
  1000 ether` non-impact case. Note: tests required swapping
  `vm.warp(block.timestamp + 48 hours + 1)` → `skip(48 hours + 1)` to
  work around a Solidity 0.8.26 + `via_ir` CSE bug where consecutive
  `vm.warp` calls in one function cached `block.timestamp` to the same
  pre-warp value.
- **F-LEND-PROPOSE-CONTRACT-CHECK** (LOW) —
  `TegridyStakingAdmin.proposeLendingContract` was missing the
  EOA / EIP-7702 (`code.length == 0 || == 23`) reject that
  `proposeRestakingContract` already enforces (F-43-C / F-60-2). An
  owner-typo (or captured owner) grants an EOA `isLendingContract = true`,
  which on the staking side promotes it to `_isTrackedHolder` —
  enabling (1) NFT cooldown / rate-limit bypass for any staking NFT
  transferred to or from the EOA, and (2) per-tokenId reward drain via
  `claimUnsettledForTokenId(tokenId, recipient)` for credits booked into
  the EOA's `unsettledRewards` bucket. Gated by 48h timelock, but
  defense-in-depth fix mirrors the restaking-side check. Approve=true
  branch only — revoke=false stays a free recovery path.
  [TegridyStakingAdmin.sol:245-267](contracts/src/TegridyStakingAdmin.sol#L245).
  Adversarial tests (4):
  `test_dd2026_05_16_proposeLendingContract_rejectsEOA_onApprove`,
  `_rejects7702_onApprove`, `_allowsEOA_onRevoke`,
  `_acceptsContract_onApprove` — all in
  [contracts/test/AuditR014_StakingAdmin.t.sol](contracts/test/AuditR014_StakingAdmin.t.sol).

### False positives (verified clean, documented to prevent re-flagging)

- **C-02 — TegridyNFTLending deadline boundary race** (FALSE POSITIVE).
  A prior agent flagged a race between `acceptOffer` and `cancelOffer`
  at the exact `block.timestamp == offer.deadline` boundary. Verified
  by reading the live partition: `acceptOffer` uses
  `if (block.timestamp > offer.deadline) revert OfferExpired();`
  (strict `>`, accept allowed AT deadline) at line 814; `cancelOffer`
  uses `if (block.timestamp <= offer.deadline)` (cancel allowed AFTER
  deadline) at line 952. Clean partition — accept and cancel cannot
  both succeed at the exact deadline instant. No fix needed.
- **TegridyNFTLending sequencer-staleness asymmetry** (FALSE POSITIVE).
  A prior agent flagged that `claimDefaultedCollateral` uses the
  2-arg `getSequencerOutageBuffer` (24h default) while `repayLoan`
  uses the 3-arg variant (4h). Verified that
  `checkSequencerUp(..., 4 hours)` at line 1465 fires BEFORE the
  buffer call, masking the asymmetry. No fix needed.

### Surfaces audited (no findings)

`TegridyLending` lifecycle (propose/accept/repay/default + ETH-counter
invariants); `TegridyNFTLending` collection-whitelist + escrow paths;
all 18+ admin-side propose/execute/cancel triplets across
`TegridyLendingAdmin`; full `TegridyStaking` surface — stake /
stakeWithBoost (JBAC vault deposit), withdraw / earlyWithdraw /
emergencyExit (CCR-01 ordering), `getReward` autoMaxLock JBAC restorer
(F3-PERMA-STRIP preserved), `kick` (KickWouldForfeit revert,
DS2-01/02/03 anti-griefing), `_settleRewardsOnTransfer` (DS3-01/03
shortfall observability), `_decayIfExpired` boundary (`>=` partition
clean), `notifyRewardAmount` (Synthetix pre-funding crystallization),
admin-replacement flow (48h timelock + 7d validity, EOA + 7702 reject),
`applyLendingContract` / `applyRestakingContract` balance gates
(DEEP-DS-10 / M-28); full `TegridyStakingAdmin` propose/execute/cancel
surface — only the lending-contract propose was missing the contract
check.

### Deferred (UX / INFO, not security-critical)

- **F-USER-TOKEN-ID-MULTI-TRANSFER** (INFO) — `_afterTokenTransfer`
  zeros `userTokenId[from]` unconditionally even when `from` (typically
  a contract / Safe / vault with >1 staking NFT) has remaining
  positions. The DEEP-DS-13 re-pointing fix runs on `_clearPosition`
  (burn path) but not on `_afterTokenTransfer` (transfer path).
  Legacy integrators reading `userTokenId(holder)` get a transient
  "no position" signal until the holder triggers a position-clearing
  action. Mitigation: use `holdsToken(user, tokenId)`,
  `userPositionCount(user)`, or `votingPowerOf(user)` for multi-NFT
  holders — all documented in M-5 NatSpec. Fix would be a 1-line
  port of the DS-13 pattern into the `from != address(0)` branch of
  `_afterTokenTransfer`.
- **F-INCREASE-DOWNGRADE-UX** (INFO) — `increaseAmount`'s F-02-K-04
  clamp uses `min(cachedBoost, remainingBoost)`, which can silently
  DOWNGRADE the cached boost on a top-up when remaining lock time
  is short. By design (prevents whale dribbling additional stake at
  MAX boost in the final days of a long lock) and acknowledged in
  the code comment, but a frontend warning at top-up time would
  improve UX — or users can `extendLock` first to refresh
  `remainingBoost` before topping up.

## ✅ Monster Audit (2026-05-09 → 2026-05-10)

7-cluster adversarial sweep on the post-scan6 codebase (Lending, DEX/AMM,
Staking, Revenue+Governance, NFT/Misc+base/lib, Cross-cutting, Frontend+
Indexer). Surfaced **13 NEW findings** atop the ~693 cumulative-pass closures
(3 HIGH + 5 MEDIUM + 3 LOW + 1 INFO on-chain; 3 HIGH + 2 MEDIUM off-chain).
Plus a follow-on post-fix adversarial sweep (5 parallel agents on the new
code) which caught **3 fresh regressions in the just-shipped fixes** (1 MED
contract + 2 MED frontend). Total **16/16 findings closed** across 5 batch
commits on `claude/festive-hofstadter-92bccd`.

Per the minimal-surface mandate: every fix is sibling-canonical or
deletion-only. Custom additions: ~6 LoC (DeltaTooLarge typed error,
isRevocationRequired helper, lookupOk flag). All other fixes are
straight ports from canonical patterns.

### Batch 1 — sibling-canonical fixes (`ad0042e`)

- **F1** (HIGH) — RevenueDistributor silent past-epoch loss for ex-restakers,
  sealed by `claimedAtEpoch`. DROPPED the `_isRestaker` short-circuit (was
  cache + skip-on-current-state, broke ex-restakers' historical claims);
  GATED the seal on `userPower > 0` so zero-power epochs stay eligible for
  `proposeClaimRecovery`. Pattern of record: Curve `FeeDistributor.claim`.
  Same fix applied symmetrically in the `_pendingETH` view path.
  [RevenueDistributor.sol:813-826, 846-883, 1671-1683](contracts/src/RevenueDistributor.sol#L813).
- **F2** (MED) — TegridyLending constructor F-S4-INCOMPLETE: scan2 S-4
  added a `chainid` require but missed the EOA / EIP-7702 reject.
  Sibling-port the `feedLen == 0 || feedLen == 23 → revert` from
  TegridyNFTLending.sol:468-470 verbatim.
  [TegridyLending.sol:836-846](contracts/src/TegridyLending.sol#L836).
- **F3** (MED) — TegridyStaking.getReward autoMaxLock JBAC restaker-aware
  lookup. When TegridyRestaking calls `getReward(tokenId)`, msg.sender is
  the restaking contract (which never holds JBAC). Sibling-port the
  `tokenIdToRestaker(tokenId)` resolution from `revalidateBoost` lines
  1303-1309.
  [TegridyStaking.sol:1077-1099](contracts/src/TegridyStaking.sol#L1077).
- **F4** (MED) — TegridyStaking.increaseAmount autoMaxLock ordering.
  F-02-K-04's `effectiveBoost` clamp computed `remaining` BEFORE the lockEnd
  extension to MAX, silently downgrading autoMaxLock users. Mirror
  `extendLock`'s order (lockEnd FIRST, then boost).
  [TegridyStaking.sol:961-986](contracts/src/TegridyStaking.sol#L961).
- **F6** (LOW) — TegridyFeeHook int128.min negation overflow. Typed
  `DeltaTooLarge()` guard before negation preserves typed-revert symmetry.
  [TegridyFeeHook.sol:103-111, 369-374](contracts/src/TegridyFeeHook.sol#L103).
- **F7** (INFO) — TegridyTWAP `consult()` Panic(0x11) on stale sequencer
  sentinel. Short-circuit on `type(uint256).max` before adding
  `SEQUENCER_GRACE_PERIOD`. Aave V3 `PriceOracleSentinel` pattern.
  [TegridyTWAP.sol:1066-1075](contracts/src/TegridyTWAP.sol#L1066).

### Batch 2 — F-LD + frontend HIGH/MED/LOW (`2deb259`)

- **F-LD** (HIGH) — TegridyLending.pullEscrowRewards cross-loan drain.
  Sequential A→B loans on the same tokenId both pause-deferred saw the
  first claimant walk away with both slices. Aave V3 pull-then-cap pattern:
  pull to lending, transfer `min(received, escrowRewardsOwed[loanId])` to
  recipient, excess feeds the legacy pro-rata path for sibling claims.
  [TegridyLending.sol:2102-2153](contracts/src/TegridyLending.sol#L2102).
- **F8** (HIGH) — `frontend/api/etherscan.js` stale `tegridyfarms.com`
  CORS allowlist — removed. Every other API proxy uses `tegridyfarms.xyz`.
- **F9** (HIGH) — JWT revocation fail-open if `SUPABASE_SERVICE_KEY` unset
  in production. Both `me.js` and `supabase-proxy.js` now return 503 in
  prod/preview when the service client is null.
- **F11** (MED) — `etherscan.js` missing `nakamigos.gallery` — added.
- **F12** (LOW) — `siwe.js` cookie-clear `Secure` flag asymmetric vs
  issuance — fixed.

### F10 — orderbook Seaport fill verification (`29d7095`)

- **F10** (MED) — `topic[1] === orderHash` matched the indexed offerer
  address (not the orderHash); the application's stored `order_hash`
  was sha256(JSON(params)) (unrelated to Seaport's EIP-712). NO legitimate
  Seaport fill ever satisfied verification. Added migration
  `005_add_seaport_order_hash.sql` storing the canonical EIP-712
  order-hash; replaced the topic check with ABI-decode of OrderFulfilled's
  `data` field (first bytes32 = orderHash). Helper:
  [`frontend/api/_lib/seaportHash.js`](frontend/api/_lib/seaportHash.js).
  22-test regression suite at
  [`frontend/api/__tests__/orderbook.fill.test.js`](frontend/api/__tests__/orderbook.fill.test.js).

### Batch 3 — sweep follow-ons + 4 PoC tests (`dd1a1e6`)

Adversarial post-fix sweep on batches 1+2 (5 parallel agents) caught 3
fresh issues in the just-shipped code, plus 4 Foundry regression PoCs
locking in F1 / F-LD / F3 / F4 closures.

- **F3-PERMA-STRIP** (MED) — batch-1's F3 try/catch fell through to
  msg.sender on lookup failure. Combined with the subsequent
  `else if (p.hasJbacBoost) { p.hasJbacBoost = false; }` strip, a transient
  lookup revert (restaking upgrade, paused view) PERMANENTLY zeroed the
  cached flag. Fix: `lookupOk` flag guards the strip-on-fail branch.
  [TegridyStaking.sol:1095-1117](contracts/src/TegridyStaking.sol#L1095).
- **F-FRESH-1** (LOW) — `me.js` module-load capture vs supabase-proxy.js
  per-request read asymmetry — unified per-request reads.
- **F-FRESH-2** (MED) — F9's production-only gate missed Vercel preview
  deploys (NODE_ENV may != "production" while VERCEL_ENV is "preview").
  OR-gated `VERCEL_ENV === "preview" || VERCEL_ENV === "production"`.

PoCs at:
- [`FRESH2026_F1_RevDistExRestakerRecovery.t.sol`](contracts/test/FRESH2026_F1_RevDistExRestakerRecovery.t.sol)
- [`FRESH2026_F_LD_CrossLoanPullThenCap.t.sol`](contracts/test/FRESH2026_F_LD_CrossLoanPullThenCap.t.sol)
- [`FRESH2026_F3_StakingJbacRestakerLookup.t.sol`](contracts/test/FRESH2026_F3_StakingJbacRestakerLookup.t.sol)
- [`FRESH2026_F4_StakingIncreaseAutoMaxLockOrder.t.sol`](contracts/test/FRESH2026_F4_StakingIncreaseAutoMaxLockOrder.t.sol)

### Batch 4 — minimal-surface frontend hardening (`808abc8`)

The post-fix sweep flagged 3 pre-existing items the agent put out-of-batch
scope. Closed all 3 with battle-tested patterns:

- **F-FRESH-5** (MED) — `_lib/aggregator-proxy.js` `*.vercel.app` wildcard
  regex admitted any tenant's preview. **DELETED the regex branch**;
  preview deploys use explicit `ALLOWED_ORIGINS` env. Pattern of record:
  Vercel next-cors, AWS API Gateway, Cloudflare CORS — all explicit
  allowlists. Net surface reduction: −5 LoC.
- **F-FRESH-3** (MED) — `supabase-proxy.js` legacy no-jti tokens silently
  skipped revocation. Force re-auth on missing jti in prod/preview.
  Pattern: Auth0 / Okta require jti for prod tokens.
- **F-FRESH-4** (LOW) — `siwe.js` + `me.js` inlined separate cookie
  builders with divergent flag gates. Extracted shared
  [`frontend/api/_lib/authCookie.js`](frontend/api/_lib/authCookie.js)
  source-of-truth. Pattern: Express `res.clearCookie()` mirrors issuance
  flags exactly. Net: ~30 LoC inline → 1 shared module + 2 imports.

### F5 — already closed elsewhere

- **F5** (LOW) — TegridyNFTLending:1236 EIP-7702 sibling-miss in
  `proposeWhitelistCollection` — already independently identified and
  fixed on sister branch `claude/naughty-rhodes-b0017b` (commit `b4cfd2f`,
  scan7). Merge that branch forward to land on `main`.

### Tests landed in monster-audit lineage

- 4 new Foundry PoC tests (6 test functions, all passing)
- 22-test vitest regression suite for F10 orderbook
- Total contracts test posture: **2593 / 2593 passing** across 149 suites
  (3 independent sweeps, all identical)
- Frontend vitest posture: **191 / 191 passing** across 14 files

### Sign-off (monster audit)

5 commits on `claude/festive-hofstadter-92bccd`:

| SHA | Title |
|---|---|
| `ad0042e` | batch 1 — 6 sibling-canonical fixes |
| `2deb259` | batch 2 — F-LD pull-then-cap + 4 frontend |
| `29d7095` | F10 — orderbook Seaport hash + ABI-decode |
| `dd1a1e6` | batch 3 — sweep follow-ons + 4 PoCs |
| `808abc8` | batch 4 — minimal-surface frontend hardening |

**Post-fix adversarial sweep verdict: 2 clean (Lending + DEX + FeeHook+TWAP
+ RevDist + NFT/Misc); 1 MED + 2 MED surfaced + closed; final state clean
across all 9 attack surfaces (frontend) + 8 surfaces (Staking F3).**

Custom code traces entirely to canonical billion-dollar patterns: OZ
(Ownable2Step, Pausable, ReentrancyGuard, Math.mulDiv, SignatureChecker),
Uniswap V2 (pair / router / factory), Uniswap V4 (IHooks, FeeTakingHook),
Synthetix (StakingRewards), Aave V3 (PriceOracleSentinel, pull-then-cap),
Curve (veCRV, FeeDistributor, GaugeController), Gondi (MultiSourceLoan),
Solady (ERC721, SafeCastLib), Auth0 / Okta (jti for prod tokens), Vercel
next-cors / AWS API Gateway / Cloudflare CORS (explicit allowlists),
Express `res.clearCookie()` (flag-mirror).

Per `AUDITS.md` honest TL;DR, the next genuine security ROI is a paid
human audit firm (OpenZeppelin / Trail of Bits / Spearbit / Cyfrin /
Code4rena) — in-house adversarial budget has reached saturation across
8 prior passes + scan2-scan8 + this monster-audit lineage.

---

## ✅ Pass-8 (2026-05-04 → 2026-05-06)

100-agent fresh-eye adversarial pass (5 waves: 30 per-contract deep +
40 vulnerability-class + 15 cross-contract integration + 10 economic /
MEV / game-theory + 5 specialized compiler/toolchain/size/test-coverage/
2026-exploit research). Surfaced **~675 raw → ~275 unique findings after
dedup**, with **10 Critical + ~140 High + ~165 Medium + ~110 Low +
~250 Info**. Master report:
[`.audit_101/PASS8_2026_05_04.md`](.audit_101/PASS8_2026_05_04.md).
**All in-scope items closed across 18 batches** (commits adfa452 →
1d058e2). Owner-trust subset (admin treasury rotation, captured-key
drain paths, single-key pause, etc.) deferred to a dedicated
multisig-policy phase per scope decision.

### Phase 0 — Deployability (EIP-170 blockers)

- **Phase 0.1** — `TegridyLending` 27,242 → 18,292 B (6,284 B headroom).
  Split into `TegridyLending` + `TegridyLendingAdmin` sister contract.
  Closed in batch 4 (commit 895a183 family).
- **Phase 0.2** — `TegridyStaking` 26,912 → 24,544 B (32 B headroom).
  Composite reduction: Solady ERC721 swap (−621 B), JBAC vault split
  (−712 B), inline `_clearPosition` (−80 B), drop `supportsInterface`
  (−27 B), `optimizer_runs` 10→1 (−15 B), 11 constants public→internal
  (−280 B). New sister: `TegridyStakingJbacVault` (1,615 B).
  Closed at
  [TegridyStaking.sol:2033](contracts/src/TegridyStaking.sol#L2033) +
  [TegridyStakingJbacVault.sol](contracts/src/TegridyStakingJbacVault.sol).
- **Phase 0.3** — `VoteIncentives` 25,977 → 22,447 B (2,129 B headroom).
  Split into `VoteIncentives` + `VoteIncentivesAdmin` sister.
  Closed in batch 5 (commit 895a183 family).
- **Phase 0.4** — `TegridyRestaking` 24,011 B (665 B headroom).
  Closed in batch 6.

### Phase 1 — Core staking / rewards correctness

- **CCR-01** (cross-contract reentrancy via JBAC return callback) —
  all 5 staking exit paths reordered so `_clearPosition` (which
  `_burn`s) runs **before** the JBAC return callback. Post-burn,
  Solady's `_ownerOf[id] == 0` causes any reentrant
  `transferFrom` / `acceptOffer` to revert. Same defense closes
  **CCR-02** on `TegridyRestaking`. Closed at
  [TegridyStaking.sol:2033-2059](contracts/src/TegridyStaking.sol#L2033).
- **JBAC custody** moved to `TegridyStakingJbacVault` sister contract:
  `returnJbac` / `claimStrandedJbac` / `getStrandedJbac` /
  `onERC721Received`. Closed at
  [TegridyStakingJbacVault.sol](contracts/src/TegridyStakingJbacVault.sol).
- **Phase 1.6** — VoteIncentives self-bribe arbitrage + sub-quorum claim.
  Added `depositedOnPair[user][epoch][pair]` tracking,
  `MIN_BRIBE_CLAIM_QUORUM = 100e18`, errors `BribePoolBelowQuorum` and
  `SelfBribeClaimForbidden` in both `claimBribes` and `claimBribesBatch`.
  Closed at
  [VoteIncentives.sol:441,447,767-771,888-889](contracts/src/VoteIncentives.sol#L441).
- **Phase 1.7** — governance VP "double-spend" — investigated and
  **confirmed not a real finding**. Each consumer (RevenueDistributor,
  VoteIncentives, MemeBountyBoard, CommunityGrants) operates an
  independent reward pool; VP is a per-pool claim, not a fungible spent
  budget. Documented per-contract.

### Phase 2 — Lending offer-expiry

- **LD-PHASE3.5** — `TegridyLending.LoanOffer` adds `uint64 expiry`.
  Constants `MIN_OFFER_VALIDITY = 1 hours` /
  `MAX_OFFER_VALIDITY = 90 days`, errors `InvalidOfferExpiry` /
  `OfferExpired`. Backward-compat 5-arg `createLoanOffer` (auto-defaults
  to MAX) plus new 6-arg `createLoanOfferWithExpiry`. Acceptance gate
  at
  [TegridyLending.sol:848](contracts/src/TegridyLending.sol#L848).
  Pattern reference: BendDAO/NFTfi/ParaSpace.

### Phase 3 — Hook / Pool / NFT

- **HOOK-ALLOWLIST** — `TegridyFeeHook` PoolKey allowlist via
  `mapping(bytes32 => bool) approvedPools` + `approvePool` /
  `revokePool`. Gate at top of `afterSwap` returns zero-fee for
  unapproved pools (does not revert — non-griefable). Closed at
  [TegridyFeeHook.sol:161,259-275,333-335](contracts/src/TegridyFeeHook.sol#L161).
- **TF-INT-02** — `TegridyFeeHook.claimFees` and
  `convertERC20FeesToETH` now WETH-unwrap to ETH (no ERC20 stranding).
  Closed at
  [TegridyFeeHook.sol:512-513,594](contracts/src/TegridyFeeHook.sol#L512).
- **NFT-ROYALTY** — `TegridyNFTPool` ERC-2981 royalty enforcement.
  `IERC2981` interface, `_settleRoyalty` helper using
  `safeTransferETHOrWrapNoRevert`, royalty deduction in BUY (from spot
  revenue) and SELL (from seller payout), `RoyaltyPaid` /
  `RoyaltyFallbackToWETH` events. Closed at
  [TegridyNFTPool.sol:299-300,359-361,957-983](contracts/src/TegridyNFTPool.sol#L299).

### Phase 4 — Governance / Gauge

- **GOV-INT-01** — `GaugeController` ↔ pair binding mandatory.
  `pairToGauge` / `gaugeToPair` / `pendingPairForAdd` mappings,
  mandatory `pair` arg on `proposeAddGauge`, errors `InvalidPair` /
  `PairAlreadyMapped`. Closed at
  [GaugeController.sol:107-108,202,247-248,796](contracts/src/GaugeController.sol#L107).
- **GOV-ECON-01** — `lib/VotePowerOracle` library (no deploy footprint)
  sums staking-side + restaking-side VP into a single read. Wired into
  every governance / fee-eligibility consumer so a user who restakes
  their staking NFT no longer disenfranchised. Pattern reference:
  Frax veFXS + Convex `veFXSStrategy`.

### Phase 5 — Monitoring / misc

- **ETH-INGRESS-COUNTERS** — `POLAccumulator` and `SwapFeeRouter` add
  `uint256 public totalETHReceived` + `ETHReceived(sender, amount)`
  event in `receive()`. Monotonic, one-way ingress witness for
  off-chain reconciliation against contract balance. MemeBountyBoard
  intentionally has no `receive()` (donated ETH cannot land), so out
  of scope. Closed at
  [POLAccumulator.sol:181,308-318](contracts/src/POLAccumulator.sol#L181)
  +
  [SwapFeeRouter.sol:2058-2061](contracts/src/SwapFeeRouter.sol#L2058).
- **DROP-REVEAL-FORCE-RESOLVE** — investigated and **confirmed not a
  finding**. `TegridyDropV2` is mint-then-reveal (not commit-reveal
  raffle); reveal is optional one-shot owner action; cancellation is
  pre-mint only (DEEP-DROP-05); under-reveal cannot brick the drop.

### Tests landed in pass-8

- **6 PASS8 PoC files** (`contracts/test/PASS8_*.t.sol`):
  GOV_INT_01 (12), PHASE_1_6 (9), PHASE_3_5 (10), HOOK_ALLOWLIST (6),
  ROYALTY (5), ETH_COUNTERS (4) = 46 tests total. Run:
  `forge test --match-path "test/PASS8_*.t.sol"`.
- **~25 legacy tests** updated for vault wiring, admin migration,
  ERC721 import alias, and hardcoded constants after public→internal
  trimming.

### Sign-off (pass-8)

- **$1M TVL** — ACCEPTABLE with operational guardrails. All in-scope
  fixes shipped to `main` (redeploy still pending — Wave 0 superseded
  by full-relaunch decision per project memory).
- **$10M TVL** — Need paid-firm engagement (Spearbit / OpenZeppelin /
  ChainSecurity caliber) targeting the architectural cluster
  (per-tokenId attribution, V4 hook semantics, boost-cache lifetime,
  multisig-key model).
- **$100M TVL** — Above PLUS post-firm invariant-suite re-run with
  targets ≥ 5M calls per surface.

## ✅ Pass-7 (2026-05-03 → 2026-05-04)

Three parallel worktree agents (oracle/AMM/fees, staking/governance,
lending/NFT) attacked everything claimed closed by the 6 prior internal
passes + Spartan, plus the pass-6 invariant suite (13 props × 1.664M
calls). Surfaced **1 CRITICAL + 6 HIGH + 4 MEDIUM + 1 LOW + 1 INFO** =
13 NEW findings, all with runnable Foundry PoCs. **All 13 closed in
same-week remediation.** Master report:
[`.audit_101/PASS7_2026_05_03.md`](.audit_101/PASS7_2026_05_03.md).

### Contracts — closed in this pass

- **PASS7-HOOK-01** (CRITICAL) — `TegridyFeeHook.afterSwap` now calls
  `poolManager.take(feeCurrency, address(this), feeUint)` inside the
  unlock context to settle the hook's positive `hookDelta`. Pre-fix,
  every V4 swap routed through the hook would have reverted
  `CurrencyNotSettled`. Hook was undeployed (latent), but
  `script/DeployTegridyFeeHook.s.sol` would have bricked all V4 pools
  on day one. Pattern: `lib/v4-core/src/test/FeeTakingHook.sol:48`.
  Closed at [TegridyFeeHook.sol:282-302](contracts/src/TegridyFeeHook.sol#L282).
- **PASS7-TWAP-01** (HIGH) — dropped V3-AMM-L1 `&& found` carve-out at
  [TegridyTWAP.sol:738](contracts/src/TegridyTWAP.sol#L738). The
  `!found` fallback path on sparse pairs no longer anchors on the
  bypassed bootstrap; ANY bypassed anchor reverts
  `OracleRebootstrapping`. Closes the FRESH-EYES H-3 invariant gap.
- **PASS7-GAUGE-H1** (HIGH) — `proposeAddGauge` reverts
  `GaugeRemovePending` while `pendingGaugeRemove == gauge`, blocking
  the `executeRemoveNextEpoch → proposeAddGauge → executeAddGauge`
  cycle that previously stranded `pendingGaugeRemove` and
  permanently bricked all future gauge removals. Closed at
  [GaugeController.sol:743-765](contracts/src/GaugeController.sol#L743).
- **PASS7-LENDING-01** (HIGH) — `TegridyLending.acceptOffer` now
  post-condition-checks `staking.ownerOf(_tokenId) == address(this)`
  after the inbound `transferFrom` and reverts `CollateralNotEscrowed`
  if the staking contract no-op'd. Sister to NFTLending L506-508.
  Closed at
  [TegridyLending.sol:824-834](contracts/src/TegridyLending.sol#L824).
- **PASS7-LENDING-02** (HIGH) — `TegridyLending.repayLoan` /
  `claimDefaultedCollateral` now wrap outbound `staking.transferFrom`
  in `_safeOutboundTransferStaking` + new `stuckCollateralRecipient`
  map + new `claimStuckCollateral(loanId)` recovery function — full
  mirror of NFTLending's L743-L793 + L721-L741 pattern. Closed across
  [TegridyLending.sol:993-1163](contracts/src/TegridyLending.sol#L993).
- **PASS7-LENDING-03** (HIGH) — settled-vs-settled cross-loan drain
  closed via snapshot-and-delta. `acceptOffer` snapshots
  `unsettledRewardsByTokenId[tokenId]` into
  `loanRewardsSnapshot[loanId]`. Settlements drain to LENDING (not
  recipient) and split into priorShare (snapshot, stays in lending
  balance for prior-holder recovery) + myShare (delta, forwarded to
  recipient). On try/catch deferral, the un-claimable slice records
  into `escrowRewardsOwed[loanId]`. Closes the cross-loan attribution
  gap that pass-6 LD-NEW-H1 only defended on the active-vs-settled
  axis. Closed across
  [TegridyLending.sol:840-851 + L955-L1028 + L1108-L1149](contracts/src/TegridyLending.sol#L840).
- **PASS7-NFTLENDING-01** (HIGH) —
  `TegridyNFTLending.claimStuckCollateral` retries the transfer under
  `_safeOutboundTransfer` and reverts `StuckCollateralStillStuck` if
  the collection still no-ops. Pre-fix, the function deleted the
  recovery mapping BEFORE the raw `transferFrom`, silently consuming
  the recovery right on a still-malicious collection. Closed at
  [TegridyNFTLending.sol:721-744](contracts/src/TegridyNFTLending.sol#L721).
- **PASS7-POL-02** (MED) — `POLAccumulator._twapMinOut` and
  `_twapHarvestMinOut` mirror TegridyLending's bypass-cooldown defense:
  refuse any TWAP read for `TWAP_PERIOD * 2 = 60 minutes` after a
  bypass observation. Closed at
  [POLAccumulator.sol:813-822 + L838-L847](contracts/src/POLAccumulator.sol#L813).
- **PASS7-HOOK-03** (MED) — `TegridyFeeHook.claimFees` no longer
  calls `poolManager.take()` (always reverted ManagerLocked outside
  unlock); now does plain `IERC20.safeTransfer` against the hook's
  own ERC20 balance — works in any tx context. Auto-resolved by the
  PASS7-HOOK-01 fix. Closed at
  [TegridyFeeHook.sol:354-366](contracts/src/TegridyFeeHook.sol#L354).
- **PASS7-LPFARM-M1** (MED) — `TegridyLPFarming.updateReward`
  modifier re-derives `effectiveBalanceOf[account]` from the live
  staking-side boost on every interaction. Pattern of record:
  Synthetix `StakingRewards` checkpoint-at-every-interaction. Closed at
  [TegridyLPFarming.sol:204-241](contracts/src/TegridyLPFarming.sol#L204).
- **PASS7-NFTLENDING-02** (MED) —
  `TegridyNFTLending.cancelRemoveCollection` mirrors TegridyLending's
  FRESH-EYES L still-live carve-out: only count cancels of STILL-LIVE
  proposals against the retry budget. Closed at
  [TegridyNFTLending.sol:996-1018](contracts/src/TegridyNFTLending.sol#L996).
- **PASS7-DOC-04** (LOW) — `Pass6_TWAPFirstObsBypass.t.sol` updated
  to reflect the post-PASS7-TWAP-01 contract-level guard;
  `FIX_STATUS.md` (this doc) narrows the TWAP HIGH-3 closure
  description below to acknowledge the V3-AMM-L1 carve-out gap pass-7
  closed.
- **PASS7-SFR-05** (INFO) — `SwapFeeRouter` declares
  `address public sequencerFeed` + `SEQUENCER_GRACE_PERIOD = 1 hours`
  + one-shot `setSequencerFeed(address)` owner setter.
  `_enforceTWAPMinETHOut` calls `SequencerCheck.checkSequencerUp` +
  post-resume freshness gate. Mainnet zero-impact (defaults to
  address(0), all helpers no-op); L2 deploys call setter once. Closed
  at
  [SwapFeeRouter.sol:172-201 + L494-L515 + L1923-L1946](contracts/src/SwapFeeRouter.sol#L172).
- **PASS7-LENDING-04** (HIGH, post-pass-7 surface — surfaced 2026-05-04
  by the new `Pass7_LendingExtSolvency` invariant suite, closed same day)
  — directPaid + legacy double-claim regression introduced by
  PASS7-LENDING-03's deferred-slice tracker. `pullEscrowRewards` now
  reconciles `escrowRewardsOwed[loanId]` and `totalEscrowRewardsOwed`
  against the `directPaid` payout (decrement both by
  `min(directPaid, owed)`) so the legacy pro-rata branch and the
  per-tokenId direct branch can never double-pay the same accrued slice.
  Trigger preconditions are operational, not adversarial: any admin pause
  on staking that coincides with a loan settlement auto-arms the
  desync. Closed at
  [TegridyLending.sol:1845-1869](contracts/src/TegridyLending.sol#L1845).
  See [`.audit_101/PASS7_LENDING_04.md`](.audit_101/PASS7_LENDING_04.md)
  for full root-cause + PoC + fix-shape rationale.

### Tests landed in pass-7

- **9 PASS7 PoC files** (`contracts/test/PASS7_*.t.sol`) covering all
  13 findings with 15 tests; converted from "asserts exploit" →
  "asserts fix" (`vm.expectRevert(NewError.selector)` or correct
  recovery semantics). Run: `forge test --match-path "test/PASS7_*.t.sol"`.
- **6 mock TWAPs patched** (POLAccumulator.t.sol, Audit195_POL.t.sol,
  AuditR014_POL.t.sol, FinalAudit_POLPremium.t.sol,
  RedTeam_POLPremium.t.sol, invariants/LendingInvariants.t.sol) with
  `lastBypassUsed(address)` getter required by the new POL gate.
- **2 PoC mocks patched** (PASS7_LENDING_01.t.sol,
  PASS7_LENDING_02.t.sol) with `unsettledRewardsByTokenId(uint256)`
  getter required by the acceptOffer snapshot.
- **`test_consult_succeedsAtMaxPeriod`** updated for fail-closed
  bypassed-anchor semantics (seeds 49 observations to overwrite the
  bootstrap before max-period consult).

### Sign-off (PASS7 §6)

- **$1M TVL** — ACCEPTABLE with operational guardrails. All 13 fixes
  shipped to `main` (redeploy still pending — see "Patched contracts
  not yet redeployed" risk).
- **$10M TVL** — Need paid-firm engagement (Spearbit / OpenZeppelin /
  ChainSecurity caliber) targeting the architectural cluster
  (per-tokenId attribution, V4 hook semantics, boost-cache lifetime).
- **$100M TVL** — Above PLUS post-firm invariant-suite re-run with
  targets ≥ 5M calls per surface.

## ✅ Pass-6 (2026-05-03)

Fresh-eyes meta-audit informed by 2024-2026 DeFi exploit retrospectives
(Curve / Euler / Conic / KyberSwap Elastic / Onyx / Penpie / Jimbos / Radiant /
BonqDAO / Hundred / Velocore / Atlantis / Munchables / BlueBerry / Pendle /
Sturdy / Inverse / Platypus / Poly Network). Re-aimed deep-microscope agents
through the exploit-retrospective lens against the cumulative 388-finding
history of passes 1–5. Surfaced **5 new contract HIGHs + 5 new contract MEDs +
1 frontend CRIT + 5 frontend HIGHs + 1 frontend LOW**, all closed. Master report:
[`.audit_101/PASS6_2026_05_03.md`](.audit_101/PASS6_2026_05_03.md).

### Contracts — closed in this pass

- **LD-NEW-H1** (HIGH) — `TegridyLending.pullEscrowRewards` no longer drains
  the per-tokenId rewards of an active loan via a stale `loanId`. Closed by
  `staking.ownerOf(loan.tokenId) == address(this)` gate at
  [TegridyLending.sol:1620-1633](contracts/src/TegridyLending.sol#L1620). Commit `722d1f1`.
- **LD-NEW-H1 mirror** (HIGH) — `TegridyRestaking.claimResidualForTokenId`
  now refuses to drain `unsettledRewardsByTokenId` while the NFT is held by
  another tracked holder (lending). Returns 0 paid + emits
  `ResidualPullDeferredCrossHolder`. Closed at
  [TegridyRestaking.sol:1163-1195](contracts/src/TegridyRestaking.sol#L1163). Commit `8266289`.
- **LD-NEW-H2** (HIGH) — `TegridyNFTLending.repayLoan` / `claimDefault`
  outbound NFT leg now verifies the NFT actually moved post-`transferFrom` via
  the new `_safeOutboundTransfer` helper. Silent no-op malicious collections
  trigger `stuckCollateralRecipient` + `CollateralRedirected` event so the
  borrower can recover. Closed at
  [TegridyNFTLending.sol:620-697,755-771](contracts/src/TegridyNFTLending.sol#L620). Commit `722d1f1`.
- **TWAP HIGH-2** (HIGH) — `consult()` now reverts `PairDisabled` when the
  factory has flipped `disabledPairs[pair] = true`. Closed at
  [TegridyTWAP.sol:472](contracts/src/TegridyTWAP.sol#L472). Commit `722d1f1`.
- **TWAP HIGH-3** (HIGH) — first observation on a new pair is now stamped
  `bypassed = true` so the bootstrap rolls out of any consult lookup window
  before consumers trust it. Closed at
  [TegridyTWAP.sol:309-331](contracts/src/TegridyTWAP.sol#L309). Commit `722d1f1`.
- **SwapFeeRouter HIGH-4** (HIGH) — multi-hop branches now invalidate
  `lastConversionSnapshot[token]` so the next 2-hop call falls into the
  bootstrap (owner-only) path instead of integrating across weeks of price
  drift. Closed at
  [SwapFeeRouter.sol:1554-1563](contracts/src/SwapFeeRouter.sol#L1554) and
  [SwapFeeRouter.sol:1652-1660](contracts/src/SwapFeeRouter.sol#L1652). Commit `722d1f1`.
- **PASS5-PA-L1** (MEDIUM, promoted from pass-5 LOW) —
  `PremiumAccess.subscribe` extension no longer double-counts `consumedEscrow`
  into `totalRevenue`. Closed at
  [PremiumAccess.sol:309-330](contracts/src/PremiumAccess.sol#L309). Commit `722d1f1`.
- **N-1 GaugeController orphan** (MEDIUM) — `proposeRemoveGauge` now reverts
  with `GaugeRemovePending` if a prior `executeRemoveGaugeNextEpoch` left
  `pendingGaugeRemove != 0`. Closed at
  [GaugeController.sol:201,788](contracts/src/GaugeController.sol#L201). Commit `722d1f1`.
- **F-1 Restaking under-credit** (MEDIUM) — `_boostedAmountAt` historical
  lookups for `_timestamp < liveLockEnd` now return `cached` directly instead
  of `min(cached, current=0)`. Restores honest historical accounting in the
  kick-window without reopening DR-04 over-credit. Closed at
  [TegridyRestaking.sol:486-512](contracts/src/TegridyRestaking.sol#L486). Commit `722d1f1`.
- **F-2 Restaking attribute-cap** (MEDIUM) — `executeAttributeStuckRewards`
  now subtracts both `totalActivePrincipal` and `totalPendingUnsettled` from
  the unattributed pool, not just `totalUnforwardedBase`. Closed at
  [TegridyRestaking.sol:1389-1408](contracts/src/TegridyRestaking.sol#L1389). Commit `722d1f1`.
- **LD-NEW-M4** (MEDIUM) — `TegridyLending` TWAP staleness gate adds a
  directional pre-check (`latest.timestamp > block.timestamp` → typed
  `OracleStale`) so a clock-skewed feed does not underflow Solidity 0.8
  checked-math. Closed at
  [TegridyLending.sol:1245,1256](contracts/src/TegridyLending.sol#L1245). Commit `722d1f1`.
- **MEDIUM-5** (MEDIUM) — `POLAccumulator.HARVEST_TWAP_DEVIATION_BPS`
  narrowed from 200 bps to 50 bps so the deviation gate aligns with the
  per-leg `TWAP_SAFETY_BPS` margin. Closed at
  [POLAccumulator.sol:131](contracts/src/POLAccumulator.sol#L131). Commit `722d1f1`.

### Frontend — closed in this pass

- **FE-HIGH-01** (HIGH) — `TegridyDropV2` `mint()` ABI extended from
  2-arg (`mint(uint256,bytes32[])`) to the correct 3-arg
  (`mint(uint256 quantity, uint256 allowedAmount, bytes32[] proof)`).
  `useNFTDropV2.mint()` accepts an optional `allowedAmount` (default 0
  preserves PUBLIC-mint compatibility). Closed in
  [frontend/src/lib/contracts.ts:420-421](frontend/src/lib/contracts.ts#L420)
  and [frontend/src/hooks/useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts). Commit `b1fb6d4`.
- **FE-HIGH-02** (HIGH) — SIWE client now sets `expirationTime` (5-min
  window aligned to server's `MAX_MESSAGE_TTL_MS`) and `notBefore` (30s
  clock-skew tolerance). Closed in
  [frontend/src/nakamigos/lib/siweAuth.js:41-60](frontend/src/nakamigos/lib/siweAuth.js#L41). Commit `b1fb6d4`.
- **FE-LOW-04** (LOW) — `useLPFarming` and `useNFTDropV2`
  `useWaitForTransactionReceipt` now pin `chainId: CHAIN_ID`. Closed in
  [frontend/src/hooks/useLPFarming.ts:24](frontend/src/hooks/useLPFarming.ts#L24)
  and [frontend/src/hooks/useNFTDropV2.ts:43](frontend/src/hooks/useNFTDropV2.ts#L43). Commit `b1fb6d4`.
- **FE-CRIT-01** (CRITICAL) — Seven `vercel.json` open-proxy rewrites
  (`/api/{odos,cow,lifi,kyber,openocean,paraswap,swapapi}/*`) replaced by
  Vercel serverless wrappers under `frontend/api/{provider}/[...path].js`
  with shared infra at `frontend/api/_lib/aggregator-proxy.js`. Seven gates:
  method allowlist, origin allowlist (fail-closed in prod), Upstash sliding
  rate limit (60/min/IP), exact-prefix path allowlist with decode-then-check,
  32 KB body cap + 5 MB response cap, query allowlist (no apiKey/cookie/auth
  forward), response cleanup (no Set-Cookie/Authorization echo, opaque 502 on
  upstream non-2xx). 53 NEW tests in
  `frontend/api/__tests__/aggregator-proxy.test.js`. Commit `975e5af`.
- **FE-HIGH-03** (HIGH) — SwapAPI quote routed through same-origin
  `/api/swapapi/*` proxy so the third party no longer sees user wallet/IP/
  referer. Closed in
  [frontend/src/lib/aggregator.ts:86](frontend/src/lib/aggregator.ts#L86). Commit `4b3a47f`.
- **FE-HIGH-04** (HIGH) — DCA hardcoded 5% slippage replaced by per-schedule
  `slippageBps` field bounded to `[10, 300]` bps (0.1%-3%) and defaulted to
  50 bps. UI presets+custom input added; storage validator updated. Closed
  in [frontend/src/hooks/useDCA.ts](frontend/src/hooks/useDCA.ts) and
  [frontend/src/components/swap/DCATab.tsx](frontend/src/components/swap/DCATab.tsx). Commit `4b3a47f`.
- **FE-HIGH-05** (HIGH) — Limit-order minOut now derived from on-chain
  `getAmountsOut` re-quote at execute-time:
  `minOut = min(targetDerivedMinOut, onChainOut * (1 - slippage))`. Stale-
  target gate aborts unsatisfiable orders. Default slippage lowered 5% → 1%.
  Closed in
  [frontend/src/hooks/useLimitOrders.ts:284](frontend/src/hooks/useLimitOrders.ts#L284). Commit `4b3a47f`.
- **FE-HIGH-06** (HIGH) — Custom-token decimals/symbol verified via
  `publicClient.readContract` on hydration + add; mismatches evicted with
  toast. `useSwapAllowance` refuses `approve(MAX_UINT256)` for tokens NOT in
  `DEFAULT_TOKENS` (falls back to exact-amount approval). Permanent
  unverified-token banner above swap form. Closed in
  [frontend/src/hooks/useSwap.ts](frontend/src/hooks/useSwap.ts),
  [frontend/src/hooks/useSwapAllowance.ts](frontend/src/hooks/useSwapAllowance.ts),
  [frontend/src/pages/TradePage.tsx](frontend/src/pages/TradePage.tsx). Commit `4b3a47f`.

### Regression suite

- [`contracts/test/Pass6_Regressions.t.sol`](contracts/test/Pass6_Regressions.t.sol) —
  4 NEW unit-style PoCs covering the 3 NEW HIGHs:
  - `test_LD_NEW_H1_oldLoanCannotDrainNewLoanCredits`
  - `test_LD_NEW_H1_mirror_residualClaimantBlockedByLendingEscrow`
  - `test_LD_NEW_H2_silentNoOpRepay_marksStuck`
  - `test_TWAP_HIGH_2_consultRevertsWhenPairDisabled`
- [`contracts/test/invariants/Pass6_*.t.sol`](contracts/test/invariants/) (commit
  `7889f25`) — 4 NEW stateful-invariant suites locking down the pass-6 fix
  surfaces under randomized adversarial sequences (256 runs × 500 calls each):
  - `Pass6_LendingSolvency.t.sol` — INV-E (3 invariants)
  - `Pass6_DropV2SupplyConservation.t.sol` — INV-G (5 invariants)
  - `Pass6_RestakingResidualCrossProto.t.sol` — INV-H (2 invariants)
  - `Pass6_TWAPFirstObsBypass.t.sol` — INV-I (3 invariants)
  - 13 invariants total · **1.664M stateful calls · 0 reverts · ~210s wall clock**
- Existing affected suites realigned:
  - [`contracts/test/PremiumAccess.t.sol`](contracts/test/PremiumAccess.t.sol) — exact-2x revenue trajectory
  - [`contracts/test/TegridyTWAP.t.sol`](contracts/test/TegridyTWAP.t.sol) — bypass-aware ≥3-obs seeding
  - [`contracts/test/TegridyLending_ETHFloor.t.sol`](contracts/test/TegridyLending_ETHFloor.t.sol) — `disabledPairs` mock surface
- 198 tests pass across the affected scope (Lending / NFTLending / TWAP /
  Restaking) per commit `21db70b`.

### Polish / cleanup (commits `378d70d`, `eed1c65`)

- **`378d70d`** — `AUDITS.md` "Internal AI-agent reviews" count bumped `8 → 10`
  (pass-5 + pass-6); lineage line enumerates the 6 modern passes.
- **`eed1c65`** polish batch:
  - Deleted two confirmed dead-code helpers (`CommunityGrants._countActiveProposals`,
    `RevenueDistributor._getRestakedAmount`) per `contracts/src/.slither.deadcode-suppress.md`'s
    own "delete it, do not suppress" guidance. Verified zero callers via repo-wide
    `Grep`. Suppress doc updated with deletion-date + grep-confirmation notes.
  - `slither.config.json` schema cleaned — stripped 7 documentary `_*` keys + an inert
    43-entry `detectors_to_run` array that Slither v0.11.5 rejects as "unknown key" on
    every CI run. Rationale moved verbatim to a new `slither.config.notes.md`
    audit-trail doc.
  - `FIX_STATUS.md` (this file) framing refreshed to acknowledge the 6-pass audit
    lineage and surface the cumulative 405-finding closure count near the top.

### Deferred

None — all initially-deferred items (FE-CRIT-01, FE-HIGH-3/4/5/6) landed
during the same pass via parallel-agent commits `975e5af` and `4b3a47f`.

## ✅ Sessions 3–6 (2026-04-18)

### Contracts — shipped on `main`, **still need mainnet redeploy**

- **[GaugeController.sol](contracts/src/GaugeController.sol)** — commit-reveal
  voting implemented at the contract layer. `commitVote`, `revealVote`,
  `computeCommitment`, `isRevealWindowOpen`, `commitmentOf`, `committerOf`.
  Closes **audit H-2** (bribe arbitrage). 14/14 new tests pass in
  [GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol).
  All 1921 existing forge tests continue to pass.
- **[Toweli.sol](contracts/src/Toweli.sol)** — canonical TOWELI source in-repo
  for the first time. OpenZeppelin ERC-20 + ERC-2612 permit, 1B fixed
  supply, no admin surface. Closes the "no token source" audit-trail gap.
  Reference deploy script at
  [DeployToweli.s.sol](contracts/script/DeployToweli.s.sol); mainnet uses
  CREATE2 vanity per [docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md).
- **[DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)**
  — **closes audit B7**. Self-contained CREATE2 salt-miner that finds a
  deployment address satisfying the Uniswap V4 hook flag bitmask (0x0044).
  Runs inline inside `forge script` — no external tooling required.

### Frontend — commit-reveal + refund loop shipped

- **[GaugeVoting.tsx](frontend/src/components/GaugeVoting.tsx)** — two-step
  commit-reveal UI with localStorage salt persistence, mode toggle
  (commit-reveal default, legacy emergency path), pending-reveal banner,
  missing-salt warning when on-chain commitment exists but local data is
  absent. Closes H-2 end-to-end.
- **[CollectionDetail.tsx](frontend/src/components/launchpad/CollectionDetail.tsx)**
  — red refund banner when sale is `CANCELLED` with a Claim Refund button
  bound to `paidByUser > 0`. Closes **H10** user-facing loop.
- **[OwnerAdminPanel.tsx](frontend/src/components/launchpad/OwnerAdminPanel.tsx)**
  — new on-chain `mintPhase` read + "Cancelled" chip in the panel header.
  Phase / MerkleRoot / Reveal / Withdraw / CancelSale buttons disable with
  clear labels once the sale is in the CANCELLED terminal state.
- **TegridyDrop ABI fix** ([contracts.ts](frontend/src/lib/contracts.ts)) —
  pre-existing bug: `currentPhase()` doesn't exist on the contract (it's
  `mintPhase()`). Every ABI call was reverting. Fixed + added
  `cancelSale`/`refund`/`paidPerWallet`. (V1 TEGRIDY_DROP_ABI block was later
  deleted 2026-04-19 and all readers migrated to TEGRIDY_DROP_V2_ABI, which
  carries the same surface as a strict superset.)
- **[useToweliPrice](frontend/src/hooks/useToweliPrice.ts)** — `TegridyTWAP`
  wired as third oracle leg. 30-minute TWAP cross-checks pair-reserve spot
  price; divergence > 2% flips to TWAP for manipulation-resistant pricing.
  `twapOverrideActive` signal exposed.
- **Indexer `TegridyStaking` address** corrected from paused v1
  `0x65D8…a421` to canonical v2 `0x6266…4819`
  ([ponder.config.ts](indexer/ponder.config.ts)).
- **Silent catches replaced** across the nakamigos sub-app (Listings,
  MyCollection, MakeOfferModal, OnChainProfile, useSmartAlerts) with
  scoped `console.warn` logging. Closes audit M8.
- **[usePageTitle](frontend/src/hooks/usePageTitle.ts)** extended: canonical
  `<link>`, `og:url`, `twitter:*`, per-page `og:image` override.
- **E2E Playwright specs** extended in
  [e2e/trust-pages.spec.ts](frontend/e2e/trust-pages.spec.ts): security,
  contracts, treasury, tokenomics, changelog, risks, history pages +
  sitemap/manifest/robots/og.svg asset served checks + SEO metadata checks.

### Docs & repo hygiene

- **[LICENSE](LICENSE)** (MIT) — was 404 despite README link.
- **[NOTICE.md](NOTICE.md)** — third-party attributions (OZ, Synthetix,
  Curve, Uniswap V2) + South Park fair-use / parody statement.
- **[HALL_OF_FAME.md](HALL_OF_FAME.md)** — fixes the SECURITY.md broken ref.
- **[docs/MIGRATION_HISTORY.md](docs/MIGRATION_HISTORY.md)** — canonical vs
  deprecated addresses across every contract with multiple live versions.
- **[docs/DEPRECATED_CONTRACTS.md](docs/DEPRECATED_CONTRACTS.md)** — ghost
  addresses (TegridyFarm, FeeDistributor, WithdrawalFee) documented.
- **[docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md)** — how TOWELI was
  deployed, CREATE2 vanity notes, testnet redeploy reference.
- **[docs/GOVERNANCE.md](docs/GOVERNANCE.md)** — admin-key model, timelock
  windows per contract, honest threat model ("single EOA; multisig
  migration is a priority"), what admin CAN and CANNOT do.
- **[docs/DEVELOPING.md](docs/DEVELOPING.md)**,
  **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**,
  **[docs/API.md](docs/API.md)** — developer, deploy, and API references.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — expanded from 2.7KB
  outline to full reference with mermaid diagrams for every surface.
- **[docs/banner.svg](docs/banner.svg)** + `frontend/public/og.svg` —
  purpose-built 1280×640 social preview. Rendered as README hero + wired
  into `index.html` as `og:image` + `twitter:image`.
- **[README.md](README.md)** — rewritten with elevator pitch + badges
  (Contracts CI / CodeQL / Slither / License / Solidity / Chain) + TOC
  + repo layout + honest security section.
- **[CHANGELOG.md](CHANGELOG.md)** — comprehensive `[Unreleased]` section
  covering sessions 3–6 per Keep a Changelog.
- **GitHub workflows:** new
  [contracts-ci.yml](.github/workflows/contracts-ci.yml),
  [codeql.yml](.github/workflows/codeql.yml),
  [slither.yml](.github/workflows/slither.yml),
  [release.yml](.github/workflows/release.yml).
- **[.github/dependabot.yml](.github/dependabot.yml)** + FUNDING.yml
  + [.gitattributes](.gitattributes) + [.nvmrc](.nvmrc).
- **Vercel security headers** hardened: HSTS 2y + preload, COOP, CORP,
  X-Permitted-Cross-Domain-Policies, extended Permissions-Policy
  ([vercel.json](frontend/vercel.json)).
- **[frontend/public/sitemap.xml](frontend/public/sitemap.xml)** —
  `lastmod` + `changefreq` on every URL; added `/contracts` + `/treasury`.
- **[frontend/public/manifest.json](frontend/public/manifest.json)** —
  replaced broken `skeleton.jpg` icon refs with actual `icon-192.png` +
  `icon-512.png`; added `any maskable` purpose.
- **package.json `license: "MIT"`** + `engines.node ≥20` on both
  `frontend/` and `indexer/`.

## ⚠️ Status of original 2026-04-17 session work

All original-session fixes below are still in place on `main` (re-verified
at the session-6 HEAD). Addresses still need the mainnet redeploy to take
effect on-chain.

## ✅ Originally done (2026-04-17)

### Contracts (need rebuild + redeploy to take effect)
- `contracts/src/TegridyLPFarming.sol` — added `exit()` convenience function so the
  frontend's existing `useLPFarming.exit()` call no longer reverts. Stake now auto-refreshes
  the caller's boost against the latest TegridyStaking NFT (JBAC holders no longer need a
  separate `refreshBoost` step).
- `contracts/src/TegridyNFTLending.sol` — added `GRACE_PERIOD = 1 hours` and gated
  `repayLoan` (`deadline + GRACE_PERIOD`) and `claimDefault` (`deadline + GRACE_PERIOD`) so
  NFT borrowers get the same safety buffer as ERC-20 borrowers.
- ~~`contracts/src/TegridyDrop.sol`~~ — H-10 refund-flow (`MintPhase.CANCELLED`,
  `paidPerWallet` tracking, `cancelSale()` irreversible owner-only, pull-pattern
  `refund()`, events `SaleCancelledEvent` + `Refunded`, `withdraw()` blocked when
  CANCELLED, `setMintPhase()` cannot enter/exit CANCELLED). **V1 source deleted
  2026-04-19**; the same surface lives on `contracts/src/TegridyDropV2.sol`,
  which is the canonical drop template going forward.
- `contracts/script/DeployGaugeController.s.sol`,
  `contracts/script/DeployTokenURIReader.s.sol`,
  ~~`contracts/script/DeployV3Features.s.sol`~~ (deleted 2026-04-19),
  `contracts/script/WireV2.s.sol` — replaced stale staking address
  `0x65D8...` with the new `0x6266...` (Gap A sed).

### Deleted dead code
- `contracts/src/LPFarming.sol` (was the duplicate non-boosted farm — `TegridyLPFarming` is
  the only one deployed).
- `contracts/script/DeployLPFarming.s.sol`, `contracts/test/LPFarming.t.sol` — orphaned
  after the above.
- `frontend/src/assets/hero.png`, `react.svg`, `vite.svg` — Vite starter leftovers.
- `frontend/src/components/PageTransition.tsx` — imported nowhere.
- Empty dirs: `frontend/src/components/characters/`, `frontend/src/components/dashboard/`,
  `frontend/src/assets/textures/`.

### Frontend fixes (hot-reloadable)
- `frontend/src/lib/constants.ts` — `TEGRIDY_STAKING_ADDRESS` swapped to new `0x6266...`.
  Dated comment explaining the C-01 migration. `TOWELI_TOTAL_SUPPLY` comment explains why
  the hardcode is safe.
- `frontend/src/pages/SecurityPage.tsx` — removed the inflated "5 Critical / 13 High / 26
  Medium / 38 Low — all resolved" block. Replaced with a neutral "read the audit files"
  card with three links.
- `frontend/src/pages/ChangelogPage.tsx` — softened "Fixed all v4 audit findings" →
  "Applied fixes for several v4 audit findings" with pointer to the audit file.
- `frontend/src/hooks/useLPFarming.ts` — added `chainId` guard + proactive allowance check
  in `stake()`; imports `CHAIN_ID`. (parseEther is correct for Uniswap V2 LP tokens; added
  comment explaining.)
- `frontend/src/hooks/useSwapQuote.ts` — wired `useChainId()` into the master `pairsEnabled`
  flag so quotes don't fire on non-mainnet (prevents silent garbage reads).
- `frontend/src/components/nftfinance/LendingSection.tsx`,
  `frontend/src/components/nftfinance/AMMSection.tsx` — converted `<a href="/security">` to
  `<Link to="/security">` so clicks stay in SPA routing.
- `frontend/src/pages/HistoryPage.tsx` — fetch cap raised from 50 → 500, added 25/row
  pagination with Prev/Next + page indicator, resets to page 0 when the wallet changes.

### Supabase migrations
- `frontend/supabase/migrations/002_native_orders_trades_push.sql` — creates the three
  tables referenced by API endpoints / RLS policies but never backed by a CREATE TABLE:
  `native_orders`, `trade_offers`, `push_subscriptions`. Also backfills explicit SELECT
  policies on `messages`, `user_profiles`, `user_favorites`, `user_watchlist`, `votes`.

### Env / docs
- `contracts/.env.example` — added `TEGRIDY_STAKING`, `TEGRIDY_LP`, `LP_TOKEN`.
- `frontend/.env.example` — added `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `ALLOWED_ORIGIN`.
- `REVENUE_ANALYSIS.md` — full fee-lever map, peer benchmarks, calibration recommendations,
  revenue-quick-win decision tree.

### What I did NOT touch per your instructions
- `.env` files — you said "private key is scrubbed, API keys whatever". Left as-is.
  They were never committed to git (verified via `git log --all --full-history`). Rotate
  at your pace.

## 🟡 Deferred — remaining work

Scope cut from the current work to keep changes reviewable. Each can be picked up later.

1. ✅ ~~Commit-reveal gauge voting UI~~ — **done in session 4-5**; `GaugeController.sol`
   now has `commitVote`/`revealVote`, ABI is in `contracts.ts`, `GaugeVoting.tsx`
   ships the two-step flow with localStorage salt persistence.
2. ✅ ~~Launchpad admin UI (cancelSale, refund, reveal)~~ — **done in sessions 4-6**;
   OwnerAdminPanel has Danger Zone + cancelSale confirm, CollectionDetail has
   buyer-side refund banner, all gated on on-chain `mintPhase` reads.
3. **Rewire ghost hooks** — `useBribes`, `useReferralRewards`, `useAddLiquidity` are
   feature-complete but unimported. `VoteIncentivesSection.tsx` reimplements bribe
   logic inline. Not blocking but is technical debt.
4. **Indexer expansion — BLOCKED by Ponder type ceiling**. Register `GaugeController`
   events, add `MemeBountyBoard` submission/vote/dispute/refund handlers, add
   `CommunityGrants` lapse/cancel/refund/execution-failed handlers, fix
   `restaking_position` tombstone (`depositTime=0` on Unrestaked breaks active-
   positions queries). Attempted in session 5 — Ponder's `Virtual.Registry`
   TypeScript inference ceiling trips when total contract count or per-ABI event
   count crosses a threshold. Session 5 established the ceiling was pre-existing
   (broken already in committed state), not a regression.
5. **Wire Leaderboard + History to Ponder** — blocks on #4.
6. ✅ ~~Wire `TegridyTWAP.consult()` into `useToweliPrice`~~ — **done in session 5**;
   30-min TWAP cross-checks spot; > 2% divergence triggers fallback.
7. ✅ ~~`TegridyFeeHook` deploy~~ — **salt-mining script shipped in session 6**
   ([DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)).
   Self-contained CREATE2 miner for the `0x0044` hook-flag prefix. Needs
   operational run + V4 pool wiring to close B7 fully.
8. ✅ ~~Regenerate `frontend/src/generated.ts`~~ — **done in session 3** via
   [scripts/extract-missing-abis.mjs](scripts/extract-missing-abis.mjs). 8 missing
   ABIs now in [abi-supplement.ts](frontend/src/lib/abi-supplement.ts).
9. **Test backfill** — 29 hooks with no unit tests. Session 5-6 added the
   Playwright E2E scaffolding and extended smoke.spec.ts + wrote
   `trust-pages.spec.ts`; significant frontend unit-test coverage is still owed.
10. ✅ ~~Silent `.catch(() => {})` in nakamigos components~~ — **done in session 6**.
    MakeOfferModal, MyCollection, Listings, OnChainProfile, useSmartAlerts all get
    scoped `console.warn` logging. useSound AudioContext.close() left silent with
    an explanatory comment (browser-owned lifecycle; errors not actionable).
11. ✅ ~~isPending guards on AMMSection/NFTLendingSection~~ — **done in session 3**.

## 🔴 Needs YOU (not something an agent can do)

- **Rotate committed API keys + private key** out of `.env` working files. Never pushed
  to git per earlier `git log --all --full-history` check, but rotate anyway.
- **Wave-0 multisig `acceptOwnership` STILL OPEN** on 3 contracts (LP Farming,
  Gauge Controller, NFT Lending) — Safe `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`
  must call `acceptOwnership()` on each. See [`docs/WAVE_0_TODO.md`](docs/WAVE_0_TODO.md) §3.
- **Per-contract constructor-arg deltas** from Wave 1–4 bulletproofing — read
  the change logs in `.audit_101/remediation/` before broadcasting:
  - **R003** — `TegridyLending` constructor now **5 args** (was 4); new `_twap`
    arg passes the `TegridyTWAP` address for ETH-denominated collateral floor.
  - **R015** — `POLAccumulator` constructor now **5 args**; new `_twap` arg +
    `LPMismatch` factory check on the LP token vs. the pair the TWAP watches.
  - **R020** — `VoteIncentives` constructor now **7 args**; new
    `_commitRevealFromGenesis` (boolean) tells the bribe contract whether to
    treat epoch 0 as commit-reveal-active or legacy.
  - **R029** — `TegridyNFTLending` no longer auto-whitelists collections at
    construction. Post-deploy you must call `proposeWhitelistCollection(addr)`
    → wait 24h → `executeWhitelistCollection(addr)` for each of JBAC,
    Nakamigos, GNSS (recipe in [`DEPLOY_CHEAT_SHEET.md`](DEPLOY_CHEAT_SHEET.md) §3 Step 5).
- **After rebuilding contracts:** run the per-contract `forge script` invocations
  documented in [`DEPLOY_CHEAT_SHEET.md`](DEPLOY_CHEAT_SHEET.md) (the previous
  one-shot helper `scripts/redeploy-patched-3.sh` was deleted 2026-04-19 with the
  V1 `TegridyDrop` source — use per-contract scripts now). Then run
  [`scripts/diff-addresses.ts`](scripts/diff-addresses.ts) → apply the constants.ts
  patch + README address-table updates in one commit. Current on-chain versions
  still do **not** have every patch — see [`NEXT_SESSION.md`](NEXT_SESSION.md)
  for the live Wave 0 status.
- **Apply Supabase migration 002** in the SQL editor.
- **Run `DeployTegridyFeeHook.s.sol`** (CREATE2 miner) once POOL_MANAGER +
  REVENUE_DIST env vars are set. Mining typically 10k–200k iterations.
- **Transfer ownership to a Safe multisig** — biggest trust-model improvement still
  outstanding. See [docs/GOVERNANCE.md](docs/GOVERNANCE.md).
- **Finalise [TOKENOMICS.md](TOKENOMICS.md) allocation** — still "TBD placeholder"
  on mainnet.
- **Publish a community surface** — Discord / Twitter / governance forum. Until
  then GitHub Issues / Discussions are the canonical channel per README.
- **Decide on the revenue calibration moves in
  [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) §4** — each one is a 24–48h timelock
  proposal that needs a multisig signer set (blocks on multisig migration).
