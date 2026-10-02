# Tegridy Farms — Microscope Security Review (Senior Lead Pass)

**Date:** 2026-04-30
**Scope:** 27 Solidity contracts (~20k LOC) on `main` post-Batches A-J
**Method:** Seven specialized auditor agents, each calibrated to a billion-dollar reference protocol, reviewing in parallel
**Baseline:** All 14 already-shipped fixes (Batches A-J) and 4 deferred items (H-10, M-5, M-7, M-12) excluded — only NEW findings reported

---

## 0. Executive verdict

**The code is unusually mature.** Eight prior internal sweeps + Spartan have closed the obvious classes — re-entrancy, basic CEI, owner key separation, Synthetix-pattern reward math, Uniswap-V2-style k-invariant. What remains is **the kind of finding paid auditors typically catch in a 4-week engagement**: cross-contract semantic drift, lazy-state-update gaps, and "half-installed" mitigations where one entrypoint is hardened but a sibling isn't.

**Two findings stand out as architectural, not local:**

1. **Stale-voting-power root cause** spans 4 contracts (TegridyStaking, GaugeController, VoteIncentives, MemeBountyBoard). The single fix is a Curve-style `kick(user)` permissionless decay path. *One PR closes 4 vulns.*
2. **TWAP "bypassed" flag is published but no consumer reads it.** POLAccumulator, SwapFeeRouter, and any future lending oracle silently trust rebridged-from-manipulation observations.

**Total: 5 Critical, 22 High, 39 Medium, 19 Low, 4 Info** across the cluster set.

---

## 1. Headline findings table (Critical + High)

| ID | Sev | Cluster | Title | File : line |
|---|---|---|---|---|
| **C1** | Crit | Drop | Allowlist leaf has no `amount` baked in → `setMaxPerWallet` cap-raise drains supply | `TegridyDropV2.sol:354-365`, `:501` |
| **C2** | Crit | Gov | VoteIncentives multi-commit options arbitrage (flat 10-TOWELI bond per commit) | `VoteIncentives.sol:1234-1331` |
| **C3** | Crit | Gov + Stake | Snapshot-vs-possession decoupling — vote with NFTs you no longer hold | 4 contracts (root: `TegridyStaking.sol`) |
| **C4** | Crit | Stake | Stale checkpoint trace on expired locks — vote-warping (root cause of C3) | `TegridyStaking.sol:371-390`, `:1113-1119` |
| **C5** | Crit | Rev | `executeClaimRecovery` + normal `claim()` double-pay — single epoch drain | `RevenueDistributor.sol:1068-1113` × `:631-677` |
| H1 | High | AMM | TegridyFeeHook flag-bit check not exclusive — extra hook flags via salt mining | `TegridyFeeHook.sol:118` |
| H2 | High | AMM | TWAP keeps integrating frozen reserves on `disabledPairs` — oracle poisoning | `TegridyTWAP.sol:220-333` × `TegridyFactory.sol:474-489` |
| H3 | High | AMM | TWAP first-observation bootstrap is permissionless and unguarded | `TegridyTWAP.sol:267-319` |
| H4 | High | Stake | `_settleRewardsOnTransfer` doesn't decay → expired-boost dilutes pool forever | `TegridyStaking.sol:903-1011`, `:1076-1105` |
| H5 | High | Stake | `claimAll` over-credits bonus on cached-but-expired boost | `TegridyRestaking.sol:461-571` |
| H6 | High | Stake | Multi-position holders silently forfeit revenue on restaked NFTs (NEW-S1 fallback gap) | `RevenueDistributor.sol:649-657` |
| H7 | High | Stake | LP Farming has zero decay path — stale boost dilutes honest LPs | `TegridyLPFarming.sol:161-169` |
| H8 | High | Stake | `emergencyForceReturn` failure leaves NFT permanently bricked (rescueNFT blocked by preserved mapping) | `TegridyRestaking.sol:1015-1087` |
| H9 | High | Lend | R014 same-block guard missing on `withdrawETH` / `withdrawNFTs` (only on `removeLiquidity`) | `TegridyNFTPool.sol:441-456` |
| H10 | High | Lend | `effectiveDeadline` extends NEW loans by historical pause time | `TegridyLending.sol:1199-1207`, `TegridyNFTLending.sol:796-804` |
| H11 | High | Lend | Pause-asymmetry: interest accrues during pause but lender can't claim default | `TegridyLending.sol:681-688` |
| H12 | High | Gov | MemeBountyBoard: late-vote can flip top submission, no freeze period | `MemeBountyBoard.sol:380-416` |
| H13 | High | Gov | CommunityGrants proposer-suppression checks ONE tokenId; multi-NFT proposers route around it | `CommunityGrants.sol:295-338` |
| H14 | High | Gov | GaugeController has no quorum gate — single voter w/ 1 wei can direct 100% of emissions | `GaugeController.sol:528-541` |
| H15 | High | Rev | POL `_twapHarvestMinOut` reads SPOT reserves despite the name (sandwich-vulnerable) | `POLAccumulator.sol:788-829` |
| H16 | High | Rev | POL ignores TegridyTWAP `bypassed` flag — rebootstrap manipulation extracts via floors | `POLAccumulator.sol:761-773`, `:788-829` |
| H17 | High | Rev | Public `distribute()` bypasses M-12's `MIN_DISTRIBUTE_STAKE` check (only enforced on `distributePermissionless`) | `RevenueDistributor.sol:272-274` |
| H18 | High | Drop | `cancelSale()` callable AFTER sold-out → secondary-market rug primitive | `TegridyDropV2.sol:592-599` |
| H19 | High | Drop | `setMintPrice(0)` legal in CLOSED → toggle to PUBLIC mints free supply | `TegridyDropV2.sol:495-499` |
| H20 | High | Drop | Permanent post-cancel ETH lockout (no `rescueAfterCancellation`) | `TegridyDropV2.sol:601-608` |
| H21 | High | Lib | `WETHFallbackLib` silent ETH↔WETH switch — no event, no return flag, 5+ caller contracts affected | `lib/WETHFallbackLib.sol:40-53` |
| H22 | High | Lib | `TegridyTokenURIReader._buildJSON` no JSON escaping (forward-looking footgun) + time-dependent `view` | `TegridyTokenURIReader.sol:149-167` |

---

## 2. The architectural finding: stale voting power (C3 + C4 + 6 others)

### Root cause

`TegridyStaking._writeCheckpoint(user)` runs on stake / withdraw / transferFrom / `_decayIfExpired`. **It does NOT run automatically when a lock expires.** The expired position is decayed only when the user (or someone else) interacts.

`OZ Trace208 upperLookup(snapshot)` returns the most-recent checkpoint ≤ `snapshot`. For an expired-but-untouched user, that is the *pre-expiry* checkpoint with full inflated boost.

### Bugs this single root cause produces

| Surface | Effect |
|---|---|
| `RevenueDistributor.claim()` | User claims revenue at expired-position-inflated power |
| `GaugeController.vote()` | Votes with 4× boost weight after lock has expired |
| `VoteIncentives.commitVote/revealVote` | Same — directs bribes via stale weight |
| `CommunityGrants.voteOnProposal` | Same |
| `MemeBountyBoard.voteForSubmission` | Same |
| Multi-NFT divestiture (C3) | Snapshot at owner-address; transfer all but one NFT after snapshot; vote with full pre-divest aggregate |

### Fix (Curve protocol of record)

Curve's `LiquidityGaugeV4.kick(user)` is a **permissionless** poke that recomputes working_balance against current veCRV. No one needs special permission to clean up dilutive stale state.

Add to TegridyStaking:

```solidity
function kick(uint256 tokenId) external nonReentrant {
    Position storage p = _positions[tokenId];
    require(p.amount > 0 && block.timestamp >= p.lockEnd, "NOT_KICKABLE");
    address holder = ownerOf(tokenId);
    _accumulateRewards(holder);
    _decayIfExpired(tokenId, p);  // existing internal helper
    _writeCheckpoint(holder);     // CRUCIAL — current code doesn't reliably hit this
}
```

Plus, in every governance vote/reveal site, add a **current-power floor**:

```solidity
require(votingEscrow.votingPowerOf(msg.sender) > 0, "DIVESTED_POSITION");
```

Closes C3, C4, H4, H7 (LP farming dilution variant), and the stale-checkpoint angle of every governance contract in one PR.

---

## 3. The TWAP "bypassed flag" cluster (H2, H3, H16)

`TegridyTWAP` carefully publishes:
- `Observation.bypassed` (true if recorded under deviation-bypass after dormancy)
- `lastBypassUsed[pair]` (timestamp of last bypass admission)
- A NatSpec block telling consumers to inspect both before trusting `consult()`

**No consumer reads either field.** POLAccumulator is the canonical price-sensitive consumer; SwapFeeRouter's `_enforceTWAPMinETHOut` is the second; future lending oracles will likely be the third. They all just call `consult()` and trust the number.

Combined with H2 (TWAP continues recording on disabled pairs) and H3 (no anti-manipulation gate on first observation), this gives an attacker three paths to seed a manipulated-but-validly-signed TWAP price into the consumers.

**Fix pattern (Aave V3 PriceOracleSentinel + Chainlink L2 uptime feed):**

```solidity
function _safeConsult(address pair, ...) internal view returns (uint256) {
    if (factory.disabledPairs(pair)) revert PairDisabled();
    Observation memory latest = twap.getLatestObservation(pair);
    if (latest.bypassed) revert OracleRebootstrapping();
    uint256 lastBypass = twap.lastBypassUsed(pair);
    if (lastBypass != 0 && block.timestamp - lastBypass < TWAP_PERIOD) revert OracleRebootstrapping();
    return twap.consult(pair, tokenIn, amountIn, TWAP_PERIOD);
}
```

Applied at every consumer, not just one.

---

## 4. The "half-installed mitigation" pattern (H9, H17, M-30 variants)

Three findings share a shape: **an audit-fix was added to one entrypoint, but a sibling entrypoint with identical risk was missed.**

| Audit fix | Hardened | Missed sibling |
|---|---|---|
| R014 M-4 same-block guard | `TegridyNFTPool.removeLiquidity` | `withdrawETH`, `withdrawNFTs` |
| M-12 `MIN_DISTRIBUTE_STAKE` | `RevenueDistributor.distributePermissionless` | `distribute()` |
| M-30 `nonReentrant` | `PremiumAccess.batchReconcileExpired` | `reconcileExpired` (single) |
| M-P01 `WETHFallbackLib` | `POLAccumulator.executeHarvestLP` | `executeSweepETH` |

**Process fix:** every audit remediation should add a "sibling search" check — grep for other functions that read/write the same storage and apply the same modifier set.

---

## 5. Critical findings — full detail

### C1 · Drop allowlist leaf has no `amount` field → cap-raise drains supply
`TegridyDropV2.sol:354-365`, `:501-504`

Leaf is `keccak256(abi.encode(address(this), msg.sender))`. No amount, no claim index. Per-wallet cap is the only check, enforced via `mintedPerWallet[user] vs maxPerWallet`. `setMaxPerWallet(N)` is `onlyOwner` with NO timelock and NO phase gate. After allowlister mints 5/5, owner bumps cap to 50, allowlister mints 45 more on the same proof.

**Reference:** Manifold `ERC721LazyPayableClaim` bakes max into leaf: `keccak256(abi.encodePacked(recipient, mintIndex, maxAmount))`. Sound `MerkleDropMinter` same pattern.

**Fix:** redesign leaf to `keccak256(abi.encode(address(this), msg.sender, allowedAmount))`, track `allowlistClaimed[user]` independent of `maxPerWallet`, gate `setMaxPerWallet` to `phase == CLOSED`.

### C2 · VoteIncentives multi-commit options arbitrage
`VoteIncentives.sol:1234-1331`, `:154-155`

Flat 10-TOWELI `COMMIT_BOND` per commit, no cap on commits per (user, epoch). Voter commits hashes for every candidate pair, observes revealed bribes, reveals only the most lucrative subset. Forfeits 10 TOWELI each on the abandoned commits — trivially cheap relative to bribe value.

**Reference:** Hidden Hand v3, Convex Bribe.sol — single-commit-per-voter, OR power-proportional bond.

**Fix:** track `committedPower[user][epoch]` and revert if `committedPower + power > userPower` at COMMIT time (not reveal time); OR scale bond as `power * BOND_BPS`.

### C3 · Snapshot-vs-possession decoupling (gov)
`GaugeController.sol:222-290`, `VoteIncentives.sol:431-460`, `MemeBountyBoard.sol:380-416`, `CommunityGrants.sol:295-338`

`votingPowerAtTimestamp(user, snapshotTime)` is keyed by user **address**, not by NFT possession. After snapshot, divest all but one sentinel NFT to a confederate. Sentinel passes `ownerOf(tokenId) == msg.sender`, but historical lookup returns full pre-divest aggregate.

**Reference:** Curve veCRV is non-transferable specifically because of this. Convex vlCVX same.

**Fix:** add current-power floor at every vote site (one-line patch); long-term migrate to per-tokenId checkpoints.

### C4 · Stale checkpoint trace on expired locks (root cause)
`TegridyStaking.sol:371-390`, `:1113-1119`, `:821-842`

See §2 above. Single fix (permissionless `kick()`) closes C3, C4, H4, H7.

### C5 · Recovery + claim double-pay
`RevenueDistributor.sol:1068-1113` × `:631-677`

`executeClaimRecovery` checks only `recoveryClaimed[user][epoch]`. `_calculateClaim` checks only `lastClaimedEpoch[user]`. Neither cross-checks the other. With `power = epoch.totalLocked` (allowed by line 1036), a single recovery pays `epoch.totalETH`. Sequence claim → recover collects `2 × share`, capped only by remaining-pool guard.

**Reference:** Curve FeeDistributor — strictly monotonic `time_cursor[user]`, single accumulator path.

**Fix:** unified `claimedAtEpoch[user][epoch]` checked by both paths; bump `lastClaimedEpoch[user]` inside `executeClaimRecovery`; cap each recovery at `epoch.totalETH / 4` or by per-epoch budget.

---

## 6. Medium findings — by cluster

### AMM (5)
- **M-AMM1** `TegridyPair.harvest()` skips `disabledPairs` / `blockedTokens` checks → mints LP under circuit-broken state. `TegridyPair.sol:323-331`
- **M-AMM2** `_enforceTWAPMinETHOut` bootstrap path lets owner set the TWAP anchor without delay. `SwapFeeRouter.sol:1481-1534`
- **M-AMM3** Strict-equality FoT-output check in `swap()` reverts on legitimate donations (Uniswap V2 uses `>=`). `TegridyPair.sol:272-273`
- **M-AMM4** `consult()` doesn't surface `bypassed` flag in return value (relies entirely on consumer discipline). `TegridyTWAP.sol:336-398`
- **M-AMM5** `distributeFeesToStakers` `pendingDistribution` deadlock when `revenueDistributor == polAccumulator`. `SwapFeeRouter.sol:1009-1067`

### Staking (8)
- **M-S1** `emergencyWithdrawPosition` lacks `updateReward` modifier → over-credits next claimer post-unpause. `TegridyStaking.sol:1184-1196`
- **M-S2** `_decayIfExpired` doesn't notify `restakingContract` of cache invalidation. `TegridyStaking.sol:325-332`
- **M-S3** `revalidateBoostForRestaked` CEI violation — `info.bonusDebt` set after `safeTransfer`. `TegridyRestaking.sol:1101-1146`
- **M-S4** `claimAll` continues bonus accrual when staking is paused. `TegridyRestaking.sol:531-539`
- **M-S5** `notifyRewardAmount(amount, duration)` parameter lets caller bypass `proposeRewardsDurationChange` 24h timelock. `TegridyLPFarming.sol:386-410`
- **M-S6** `setRewardNotifier` instant grant — out-of-pattern with all other admin gates (48h timelock). `TegridyStaking.sol:1307-1310`
- **M-S7** `aggregateActiveBoostBps` floor-rounding biases against stakers (M-24's ceil pattern wasn't applied here). `TegridyStaking.sol:441-458`
- **M-S8** `safeTransferFrom` not `nonReentrant` at outer level → `onERC721Received` rapid-hop primitive. `TegridyStaking.sol:903-927`

### Lending (8)
- **M-L1** `pullEscrowRewards` proportional payout dilutes live claims with dormant ones. `TegridyLending.sol:1289-1335`
- **M-L2** No TOWELI sweep / rescue path → donations and dust permanently locked. `TegridyLending.sol`
- **M-L3** NFTLending: borrower + lender both abandoning indefinitely blocks `executeRemoveCollection`. `TegridyNFTLending.sol:672-684`
- **M-L4** `proposeSpotPrice` has no upper bound → owner can brick swaps via overflow setup. `TegridyNFTPool.sol:340-345`
- **M-L5** NFTPool `owner` field has no transfer setter → orphan-pool risk. `TegridyNFTPool.sol:34, 183`
- **M-L6** `NFTPoolFactory.createPool` lacks `nonReentrant` — malicious NFT collection can re-enter. `TegridyNFTPoolFactory.sol:132-197`
- **M-L7** NFTPool buy/sell math uses raw `*` instead of `Math.mulDiv` — precision-fragile. `TegridyNFTPool.sol:617, 662`
- **M-L8** Lending accepts `lockEnd == deadline` → reward attribution rounds to zero for the loan period. `TegridyLending.sol:611-612`

### Governance (5)
- **M-G1** CommunityGrants 10k gas stipend silently downgrades grants to WETH for many smart accounts. `CommunityGrants.sol:811-834`
- **M-G2** `sweepForfeitedBond` has no L2-sequencer-outage buffer (MemeBountyBoard has it). `VoteIncentives.sol:1339-1359`
- **M-G3** ReferralSplitter first `updateReferrer` bypasses 30-day cooldown (zero-init mapping). `ReferralSplitter.sol:189-211`
- **M-G4** MemeBountyBoard same snapshot/possession bug as C3. `MemeBountyBoard.sol:380-416`
- **M-G5** VoteIncentives `claimBribes` rounding-to-zero silently skips small voters AND doesn't mark claimed → gas griefing. `VoteIncentives.sol:601-611`

### Revenue / POL / Premium (6)
- **M-R1** Mixed restaker+normal-staker users undercredited (NEW-S1 fallback uses `if (==0)` instead of additive). `RevenueDistributor.sol:650-657`
- **M-R2** `executeClaimRecovery` permissionless executor + no per-recovery cap. `RevenueDistributor.sol:1103-1110`
- **M-R3** PremiumAccess R022 fix (extension forfeits `remainingEscrow`) creates wildly above-rate per-time cost — incentivizes lapse-and-resub gaming. `PremiumAccess.sol:250-282`
- **M-R4** `executeSweepETH` doesn't use `WETHFallbackLib` — asymmetric with M-P01 fix on harvest path. `POLAccumulator.sol:537-548`
- **M-R5** POL `accumulate` triple-mismatch between TWAP floor / slippage floor / router ratio — sandwich bleed even with floors active. `POLAccumulator.sol:367-372`
- **M-R6** `proposeClaimRecovery` permits `power = epoch.totalLocked` → single recovery drains epoch. `RevenueDistributor.sol:1023-1051`

### Drop (4)
- **M-D1** `proposeMerkleRoot` + `setMintPhase(ALLOWLIST)` smuggle in same block. `TegridyDropV2.sol:465-485, 417`
- **M-D2** `currentPrice` reverts during sequencer grace → indexers mark drops as broken. `TegridyDropV2.sol:392-414`
- **M-D3** `acceptOwnership` doesn't clear pending merkle proposal — incoming owner inherits hostile in-flight state. `TegridyDropV2.sol:611-620`
- **M-D4** Launchpad `cancelProtocolFeeRecipient` emits no event. `TegridyLaunchpadV2.sol:254-257`

### Lib (7)
- **M-Lib1** `TimelockAdmin` no `MAX_DELAY` cap (Compound has 30 days). `base/TimelockAdmin.sol:48-53`
- **M-Lib2** `SequencerCheck` missing Chainlink staleness check on `updatedAt` / `answeredInRound`. `lib/SequencerCheck.sol:64-88, 121-141`
- **M-Lib3** `SequencerCheck` uses `answer == 1` (down) instead of canonical `answer != 0` (up) — direction-fragile. `lib/SequencerCheck.sol:77`
- **M-Lib4** `Toweli` constructor sends entire 1B supply to single recipient with no contract-presence check. `Toweli.sol:50-59`
- **M-Lib5** `TimelockAdmin` no proposer/canceller/executor role split — same Safe controls all three. `base/TimelockAdmin.sol:48-75`
- **M-Lib6** Timelock key not bound to value commitment — child must self-discipline (load-bearing, fragile). `base/TimelockAdmin.sol:40`
- **M-Lib7** `OwnableNoRenounce` allows `transferOwnership` to EOA without contract-only override option. `base/OwnableNoRenounce.sol:14-16`

---

## 7. Low / Info — abbreviated

19 Low + 4 Info findings, including: NFTPool same-block guard fires on dust swaps; allPairsPaginated overflow in view function; Drop CREATE2 salt missing config hash; `setBaseURI` mutability allows reveal-front-run trait sniping; Toweli permit-domain casing mismatch; `tokenURI(nonexistent)` doesn't revert; emission budget allows 0 (silent freeze); ReferralSplitter `referrerRegisteredAt` orphaned; `cancelOffer` non-refund of origination fee. Full lists in agent transcripts.

---

## 8. Defensive observations (things they got right)

1. **Pair-authenticity factory check** (R014) in TegridyTWAP correctly closes pair-forgery oracle poisoning
2. **FoT-output strict equality** in TegridyPair.swap is the right detection primitive
3. **TWAP-floor minETHOut "tighten only, never relax"** matches Olympus/Tokemak treasury-ops
4. **Storage-append discipline** in TegridyFactory (`pendingGuardian` appended at end with explicit comment)
5. **Permissionless `harvest()` rate-limit** (5-min interval) is well-reasoned and bounded
6. **CEI ordering in TegridyPair.swap and burn** correctly closes read-only reentrancy
7. **OZ v5 ECDSA malleability protection, EIP-712 chainID rebind on fork, `nonces()` public** all correctly inherited
8. **R017 RETRY pattern in `decayExpiredRestaker`** (decay → shrink total → accrue → re-anchor → transfer) is the textbook ordering — should be replicated in `claimAll` / `refreshPosition` / `unrestake`

---

## 9. Recommended deploy gating

**Block mainnet-additional-TVL until fixed:**
- C1, C2, C3, C4, C5 — all 5 Critical
- H1 (hook flag bits), H2 + H3 (TWAP poisoning surfaces), H4 + H7 (boost dilution), H9 (R014 sibling miss), H17 (M-12 sibling miss), H18 (DropV2 cancel-after-sellout), H21 (WETHFallback signal)

**Single-PR closures (high leverage):**
1. `kick(tokenId)` permissionless decay → closes C3 / C4 / H4 / H7
2. `_safeConsult` wrapper at every TWAP consumer → closes H2 / H3 / H16
3. Sibling-search audit pass → closes H9 / H17 + the 4 M-30-style misses
4. Curve-style `claimedAtEpoch[user][epoch]` unified check in RevenueDistributor → closes C5 / M-R2 / M-R6

**Process recommendations:**
- Adopt the 4 unified storage-key invariants as forge-test invariants (echidna or invariant tests), not just unit tests
- Move `setRewardNotifier`, `setMintPrice`, `setMaxPerWallet`, `setBaseURI` behind the same timelock contract that already protects the rest of the surface — instant-mutation setters are the #1 finding pattern across this audit
- Resist deploy until a paid human firm review (OpenZeppelin / Trail of Bits / Spearbit / Cyfrin) — the AI sweeps + Spartan have plateaued, and the remaining surface is exactly the kind of cross-contract semantic drift a single-week-engagement firm catches in their first pass

---

**Total tally:** 5 Critical · 22 High · ~39 Medium · ~19 Low · 4 Info — across 27 contracts.

The protocol has done genuinely thorough work. What's left is the long tail that requires either fresh eyes (this pass), invariant fuzzing, or a paid firm. The Critical findings are tightly clustered around two architectural roots (stale-checkpoint + TWAP bypass-flag) — fixable in two PRs.
