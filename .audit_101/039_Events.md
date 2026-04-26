# Agent 039 — Events Audit (AUDIT-ONLY)

**Mission:** Forensic events audit across `contracts/src/` (24 contracts).
Cross-checked against `indexer/src/index.ts` (Ponder, 9 contracts subscribed).

## Summary Counts

- Total `event` declarations across `contracts/src/`: **263**
- Contracts with events: **24** (all checked)
- Indexer-subscribed contracts: **9** (TegridyStaking, TegridyRestaking, RevenueDistributor, VoteIncentives, LPFarming, TegridyLending, SwapFeeRouter, CommunityGrants, MemeBountyBoard)
- Indexed event types in Ponder: **23** total
- Pause/Unpause: **13** contracts. All inherit OZ `PausableUpgradeable`/`Pausable` which auto-emits `Paused(address)`/`Unpaused(address)` — **NOT** declared in contract source but ARE emitted on-chain. None subscribed by indexer.

---

## Top Findings (severity-ordered)

### HIGH — Indexer Coverage Gaps (state changes affecting users, NOT indexed)

#### H-EVT-01 — `Paused` / `Unpaused` not subscribed for ANY contract
- **Affected:** 13 contracts (Staking, Restaking, RevenueDist, LPFarming, Lending, SwapFeeRouter, MemeBountyBoard, CommunityGrants, GaugeController, VoteIncentives, NFTPool, NFTLending, NFTPoolFactory, FeeHook, Launchpad, DropV2, POLAccumulator, PremiumAccess)
- **Impact:** Frontend has NO way to render "protocol paused" banner from indexed data. Users hit `EnforcedPause()` reverts blind. Direct on-chain calls to `paused()` view fn required, defeating the indexer.
- **Fix:** Add `Paused`/`Unpaused` event subscriptions in `ponder.config.ts` (OZ emits them at `PausableUpgradeable`).

#### H-EVT-02 — `TegridyPair` (V2 LP) entirely unindexed
- **Affected:** `TegridyPair.sol` events `Mint`, `Burn`, `Swap`, `Sync`, `Skim`, `Initialize`
- **Impact:** No DEX volume / TVL / per-pool history reconstructable from indexer. Frontend pricing & analytics fall back to RPC reads or rely on `SwapFeeRouter:SwapExecuted` (which only covers fee-routed swaps, NOT direct router swaps).
- **Note:** `TegridyRouter.sol` `Swap`, `LiquidityAdded`, `LiquidityRemoved` also not indexed.

#### H-EVT-03 — `TegridyRestaking:EmergencyForceReturn` / `BoostRevalidated` / `PositionRefreshed` not indexed
- **Affected:** `restakingPosition` table can desync with chain reality after emergency owner action.
- **Impact:** User UI shows stale boosted amount / NFT-still-locked when chain has returned it.

#### H-EVT-04 — `TegridyStaking` admin events not indexed
- **Affected:** `TreasuryChangeProposed/Executed`, `RewardRateProposed/Executed`, `LendingContractUpdated`, `RestakingContractChanged`, `MaxUnsettledRewardsUpdated`, `EmergencyExitRequested/Position/Cancelled`, `JbacReturned/Stranded`, `BoostRevalidated`, `RewardNotifierSet`, `ExtendFee*`, `PenaltyRecycle*`, `PenaltySplit`, `RewardsForfeited`, `UnsettledClaimed`.
- **Impact:** Frontend cannot show timelock countdowns for proposals; cannot warn users of pending parameter changes.

#### H-EVT-05 — `GaugeController` ENTIRELY unindexed (commented out: "deferred")
- **Affected:** `Voted`, `VoteCommitted`, `VoteRevealed`, `GaugeAdded/Removed`, `EmissionBudgetUpdated`.
- **Note:** `ponder.config.ts` line 419: "MemeBountyBoardExtras + CommunityGrantsExtras + GaugeController registrations deferred". Voters' vote history irrecoverable from indexer.

---

### MEDIUM — Indexed Args Quality

#### M-EVT-01 — `SwapFeeRouter:SwapExecuted` — `tokenIn`/`tokenOut` NOT indexed
```solidity
event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee);
```
- `user` is high-cardinality (good as indexed). `tokenIn`/`tokenOut` are LOW-cardinality (~20 tokens) and high-filter-value (e.g. "all WETH→TOWELI swaps") — should be indexed. Currently you cannot eth_getLogs filter by token without indexer post-processing.

#### M-EVT-02 — `TegridyLending:LoanAccepted` — `lender` NOT indexed (only borrower & offerId & loanId)
- `lender` field present (5th arg) but missing `indexed`. Lender dashboards must scan-and-filter all Accepted events.

#### M-EVT-03 — `TegridyRouter:Swap` — `path[]` array can't be indexed; no per-token indexed field
- `event Swap(address indexed sender, address[] path, uint256 amountIn, uint256 amountOut, address indexed to)` — no way to filter by tokenIn/tokenOut at log level.

#### M-EVT-04 — `setReferrer` (`ReferralSplitter:171`) emits actor-correctly but lifecycle missing
- `emit ReferrerSet(msg.sender, _referrer)` is direct-call (not router-relayed), so `msg.sender` is correct.
- However `totalReferred[_referrer]` increment, `referrerRegisteredAt` set — no event captures the count change for analytics.

#### M-EVT-05 — `RevenueDistributor:Claimed` — missing diff/totalClaimed cumulative field
- Only emits `(user, ethAmount, fromEpoch, toEpoch)` — frontend cannot compute lifetime-claimed without scanning all logs.

#### M-EVT-06 — `TegridyFactory:setFeeTo` (line 129) is `pure`/disabled; instead the propose/execute path emits `FeeToChangeProposed`/no executed event (only `FeeToUpdated` from older instant path — check execution emits).
- Verify `executeFeeToChange` actually emits `FeeToUpdated(old,new)` — grep didn't show it from current file, requires manual confirm.

---

### LOW — Setter/Diff Pair Patterns

#### L-EVT-01 — `RewardRateExecuted(uint256 newRate)` — emits NEW only, no OLD
- `TegridyStaking.sol:323`. Setters with no old-vs-new pair: frontend cannot show diff.
- Same pattern: `BonusRateExecuted`, `MintPriceChanged`, `MaxPerWalletChanged`, `MerkleRootChanged`, `BaseURIChanged`, `Revealed`, `MintPhaseChanged`, `BonusRateUpdated`, `BonusFunded`, `EnableCommitRevealProposed`.

#### L-EVT-02 — `TegridyDropV2.setMintPhase` family — emits ONLY new value
- `MintPhaseChanged(MintPhase)`, `MerkleRootChanged(bytes32)`, `MintPriceChanged(uint256)`, `MaxPerWalletChanged(uint256)`, `BaseURIChanged(string)`. No old→new pair.

#### L-EVT-03 — `TegridyTWAP:UpdateFeeChanged(oldFee,newFee)` — has both, GOOD pattern. `FeeRecipientChanged(oldRecipient,newRecipient)` — also GOOD.

#### L-EVT-04 — `ReferralSplitter.sol` — file contains literal `\` characters (lines 175, 247, 249, 253, 257, 260, 261, 263) where `//` was intended. Likely COMPILES (Solidity parses `\` as start of inline assembly... actually NO, this would be a parse error). FILE MAY NOT COMPILE. **Cross-flag with Agent 030 (compile/lint).**

#### L-EVT-05 — Owner-change events
- Most contracts use OZ `Ownable2Step` which emits `OwnershipTransferStarted` and `OwnershipTransferred` — covered automatically.
- `TegridyTWAP.sol:28-29` declares `OwnershipTransferStarted` / `OwnershipTransferred` directly — verifies pattern.
- `Toweli.sol`: NO owner — fixed-supply ERC20Permit only. Clean.

---

### INFO — Emit-Before-State Concerns (read-by-event indexers see stale state)

#### I-EVT-01 — `TegridyFactory:executeRemoveGauge` style reads MAY have ordering issues
- Spot check: `TegridyFactory.sol:320-322`:
  ```solidity
  disabledPairs[pair] = pendingPairDisableValue[pair];
  delete pendingPairDisableValue[pair];
  emit PairDisableExecuted(pair, disabledPairs[pair]);
  ```
  State written BEFORE emit. SAFE pattern.

#### I-EVT-02 — `TegridyRouter` `emit Swap(msg.sender, ...)` — sender IS msg.sender (router is direct entrypoint, not behind a relayer). Correct.

#### I-EVT-03 — `SwapFeeRouter:SwapExecuted` — `user` is `msg.sender` (router-relayed via TegridyRouter would be a CONCERN, but SwapFeeRouter is itself the entrypoint). Correct.

#### I-EVT-04 — `ReferralSplitter:recordFee(address _user)` — receives `_user` from caller (SwapFeeRouter), emits `FeeRecorded(_user, referrer, ...)` — **CORRECT** actor (not msg.sender).

---

## Per-Contract Checklist

| Contract | Events | Indexed? | Notes |
|---|---|---|---|
| TegridyPair | 6 | NO | H-EVT-02 |
| TegridyRouter | 3 | NO | H-EVT-02 |
| TegridyFactory | 13 | NO | admin-only events |
| TegridyFeeHook | 12 | NO | needs subscription for fee history |
| TegridyStaking | 35+ | partial | core 6 indexed; admin gaps H-EVT-04 |
| TegridyRestaking | 18 | partial | base+bonus claims OK; emergency events missing H-EVT-03 |
| RevenueDistributor | 26 | partial | epoch+claim OK; treasury changes not indexed |
| VoteIncentives | 25 | partial | Bribes+Vote OK; commit/reveal flow MISSING |
| GaugeController | 9 | NONE | H-EVT-05 (deferred) |
| LPFarming | 11 | partial | core 3 indexed; boost/duration missing |
| TegridyLending | 22 | partial | lifecycle 4 indexed; admin gaps; M-EVT-02 |
| TegridyNFTLending | 21 | NO | duplicate w/ TegridyLending; not indexed |
| TegridyNFTPool | 15 | NO | NFT AMM unindexed |
| TegridyNFTPoolFactory | 7 | NO | pool creation unindexed |
| SwapFeeRouter | 35+ | partial | only `SwapExecuted` indexed; M-EVT-01 |
| ReferralSplitter | 23 | NO | L-EVT-04 file has bad escape chars |
| POLAccumulator | 18 | NO | accumulation/treasury changes unindexed |
| RevenueDistributor | (above) | partial | |
| PremiumAccess | 11 | NO | subscription state unindexed |
| TegridyDropV2 | 12 | NO | NFT drop minting unindexed |
| TegridyLaunchpadV2 | 6 | NO | collection creation unindexed |
| TegridyTWAP | 4 | NO | TWAP updates unindexed |
| MemeBountyBoard | 11 | partial | created+completed indexed; submissions/votes/payouts NO |
| CommunityGrants | 14 | partial | created+executed+voted indexed; cancellations/refunds NO |
| Toweli | 0 | N/A | fixed-supply, owner-less, clean |
| base/TimelockAdmin | 3 | NO | governance proposal lifecycle untracked |
| base/OwnableNoRenounce | (Ownable2Step) | NO | OwnershipTransferred unindexed |

---

## Top-5 MISSING Events (most user-impacting)

1. **`TegridyPair:Swap`** — DEX trades unindexed; volumes & charts can't be reconstructed.
2. **`Paused/Unpaused`** for all 13 pausable contracts — UI can't show "protocol paused" banner.
3. **`GaugeController` entire surface** — votes & gauge changes unindexed; voter dashboard impossible.
4. **`VoteIncentives:VoteCommitted/Revealed/BondRefunded/BondForfeited`** — commit-reveal voting flow invisible to indexer.
5. **`TegridyRestaking:PositionRefreshed/BoostRevalidated/EmergencyForceReturn`** — admin-side stake reconciliation desync between chain & indexer.

---

## Cross-flags

- **Agent 030 (compile/lint):** `ReferralSplitter.sol` contains `\` chars where `//` was intended (lines 175, 247, 249, 253, 257, 260, 261, 263). May break compilation.
- **Agent 102 (state-coverage):** Check that `TegridyFactory.executeFeeToChange` actually emits `FeeToUpdated` on state write.
