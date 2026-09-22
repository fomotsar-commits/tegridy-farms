# Agent 72 — View / Getter Function DoS Audit

**Lens:** memory bombs in returned arrays, unbounded mapping iteration, OOB reverts on `[0]`/array index, getters that throw on stale state, underflow in arithmetic views, aggregate-across-all-users views, missing pagination caps.

**Scope:** `contracts/src/*.sol` (and `contracts/src/lib/*.sol`, `contracts/src/base/*.sol`).
**Methodology:** grep all `external/public view`, follow callers, verify cap constants, look for revert paths that brick frontend.

---

## F-72-1 — `CommunityGrants.getProposalsInRange(start, end)` has no per-call page-size cap (MEDIUM)

- **File:** `contracts/src/CommunityGrants.sol:1194`
- **View:** `getProposalsInRange(uint256 start, uint256 end) external view returns (Proposal[] memory page)`
- **Vector:** caller passes `start = 0, end = type(uint256).max`. Function clamps `end → proposals.length` (line 1196), then allocates `Proposal[](end-start)` and copies the FULL historical proposal log to memory in a single eth_call. Each `Proposal` struct embeds a `string description` (capped 2000 bytes — line 309) plus 11 fixed-size fields, so each entry is ≥ 2.1 KB. With N=10k proposals, the function returns ≥ 21 MB to the JSON-RPC, exceeding every public RPC's response-size ceiling (Infura 10 MB, Alchemy 200 MB-ish but very slow), and locally the memory expansion gas cost is quadratic.
- **No on-chain cap:** there is no `MAX_PAGE_SIZE` ceiling, no equivalent of `TegridyLaunchpadV2.MAX_PAGINATED_LIMIT = 1000` (used at `TegridyLaunchpadV2.sol:299`). The natspec (lines 1183-1190) explicitly admits this is off-chain only ("There is no economic reason for an on-chain consumer to read the full historical proposal log") but the gate is purely advisory.
- **Frontend impact:** a frontend integrator that mistakenly omits pagination, or a malicious indexer query, will gas-bomb every public RPC reading this view → governance UI permanently shows "Loading proposals…" once the array passes ~1000 entries. Cost to amplify is zero (anyone can `createProposal` with valid input — it costs ~5 ETH treasury but the proposer doesn't pay a fee; only msg.sender voting power is checked).
- **Fix:** mirror `TegridyLaunchpadV2.getCollectionsPaginated`'s `if (limit > MAX_PAGINATED_LIMIT) revert PageLimitExceeded();` guard. Add a `MAX_PROPOSAL_PAGE` constant (e.g., 200) and revert when `end - start > MAX_PROPOSAL_PAGE`.

---

## F-72-2 — `CommunityGrants.getProposalsByStatus(status, startIdx, limit)` first-pass scan is unbounded (LOW)

- **File:** `contracts/src/CommunityGrants.sol:1217`
- **View:** `getProposalsByStatus(ProposalStatus, uint256, uint256) external view returns (uint256[], Proposal[], uint256)`
- **Vector:** the first counting loop (line 1230) is `for (; cursor < len && found < limit; ++cursor)`. Caller passes `limit = type(uint256).max` → the loop scans the ENTIRE `proposals` array. Allocation is bounded by `found` so memory is fine — but the SLOAD per iteration is not bounded.
- **Why secondary to F-72-1:** the second loop (line 1242) only writes `found` entries and the return is properly sized. The bug is purely the SLOAD-cost grief: O(proposals.length) gas per call, on a path advertised as paginated.
- **Frontend impact:** indexers polling for "latest Approved proposals" in batches — if the integrator passes `type(uint256).max` as a "no limit" sentinel (a common misreading of the natspec line "Maximum number of matching entries"), the call costs O(N) gas instead of O(limit) and can timeout on RPCs that enforce eth_call gas caps (~50M).
- **Fix:** clamp `limit` at function entry: `if (limit > MAX_STATUS_SCAN) limit = MAX_STATUS_SCAN;` (e.g., 500). Same shape as `RevenueDistributor.claimUpTo` line 647.

---

## F-72-3 — `TegridyNFTPoolFactory.getAllPools()` returns unbounded array (LOW)

- **File:** `contracts/src/TegridyNFTPoolFactory.sol:288`
- **View:** `getAllPools() external view returns (address[] memory)`
- **Vector:** returns the FULL `_allPools` storage array. There is a `MAX_POOLS_PER_COLLECTION = 200` cap (line 53), but `_allPools` aggregates across ALL collections, so total = (200 × number-of-collections). With 100 collections that's 20k addresses (640 KB) — within RPC limits but slow; with 1k collections (deployable spam-cheaply via `MIN_DEPOSIT = 0.05 ETH × 1k pools = 50 ETH economic floor) it's 6.4 MB, which trips Cloudflare/Infura body-size guards.
- **Companion paginated:** `getPoolsPaginated(collection, offset, limit)` exists at line 302 — but it is per-collection only. There is no `getAllPoolsPaginated`.
- **Frontend impact:** discovery/explorer pages that list all pools across all collections must call `getAllPools()` (no alternative). Once the protocol grows past a few hundred collections, the list page bricks.
- **Fix:** add `getAllPoolsPaginated(uint256 offset, uint256 limit)` mirroring `TegridyLaunchpadV2.getCollectionsPaginated` shape. The legacy `getAllPools()` can stay for backwards compatibility but should be marked scaling-limited in NatSpec (matches the LP-03 pattern at `TegridyLaunchpadV2.sol:274-279`).

---

## F-72-4 — `TegridyNFTPool.getHeldTokenIds()` returns unbounded array (LOW)

- **File:** `contracts/src/TegridyNFTPool.sol:728`
- **View:** `getHeldTokenIds() external view returns (uint256[] memory)`
- **Vector:** returns full `_heldIds` array. There is no cap on `_heldIds.push` (`_addHeldId` at line 919 is callable from `addLiquidity`, `syncNFTs`, and the `swapETHForNFTs` deposit path). A pool owner can deposit thousands of NFTs (legitimate large-collection liquidity provision), and the per-NFT-ID is uint256 so each entry is 32 bytes — 100k NFTs ≈ 3.2 MB.
- **Frontend impact:** marketplace UIs that list "all NFTs in this pool" rely on this view. For a whale-LP pool with 50k+ NFTs the call chokes.
- **Fix:** add `getHeldTokenIdsPaginated(uint256 offset, uint256 limit)` matching the existing `getPoolsPaginated` (line 302). Keep `getHeldTokenIds()` for backwards compatibility, document the scaling limit.

---

## F-72-5 — `TegridyTWAP.getLatestObservation(pair)` reverts when no observation exists, breaking POL/Lending floor reads (MEDIUM)

- **File:** `contracts/src/TegridyTWAP.sol:577`
- **View:** `getLatestObservation(address pair) external view returns (Observation memory obs)`
- **Vector:** `if (count == 0) revert InsufficientObservations();` (line 579). Two consumers call this directly inside `view` chains:
  - `POLAccumulator.sol:820` and `:861` — used by harvest valuation views that the keeper/frontend reads to size next harvest.
  - `TegridyLending.sol:1606` — wrapped inside `_positionETHValue` (internal) which is called from offer-creation/acceptance write paths AND from the dust-eligibility path that frontends hit.
- **Frontend impact:** when a brand-new pair is created and the TWAP has not yet been bootstrapped (first `update()` not called), every read that goes through `getLatestObservation` reverts. The lending UI cannot compute `getRepaymentAmount` paths that depend on collateral valuation, and POL harvest dashboards show an opaque revert. There's no soft-fail variant (`tryGetLatestObservation`) to return `(false, …)`.
- **Fix:** add a sister non-reverting view: `function tryGetLatestObservation(address pair) external view returns (bool ok, Observation memory obs)` that returns `(false, zero-init)` when count == 0. Same pattern that the SequencerCheck library uses (`tryCheckSequencerUp` at `lib/SequencerCheck.sol:182`).

---

## F-72-6 — `TegridyNFTLending.effectiveDeadline / pauseAdjustedElapsed` reverts on pause-invariant violation (MEDIUM)

- **File:** `contracts/src/TegridyNFTLending.sol:1222` and `:958`
- **View:** `effectiveDeadline(uint256) public view` and `pauseAdjustedElapsed(uint256) public view`
- **Vector:** both views contain `if (loan.pausedDurationAtStart > totalPausedDuration) revert PauseInvariantViolated();` (lines 1227, 964). The natspec says "fail-loud on the pause invariant", which is correct for write paths, but `effectiveDeadline` and `pauseAdjustedElapsed` are also exposed externally and called by `getRepaymentAmount` (line 977) and `isDefaulted` (line 998). Once an admin-driven invariant violation lands (e.g., a future code path that decrements `totalPausedDuration` or a storage-layout migration), every loan view bricks for that loanId — frontend cannot show the loan card at all.
- **Same pattern in:** `TegridyLending.sol:1502` and `:1725` — but those use the silent-clamp ternary (`return pausedSinceStart >= raw ? 0 : raw - pausedSinceStart;`) which DOES NOT revert. So the NFT-lending fork (LD3-M4) chose the strict variant, while the ERC-20 lending fork chose the soft variant. The asymmetry means the NFT-lending UI is more brittle.
- **Frontend impact:** if the invariant ever trips (recovery path bug, storage-migration fence), every `getLoan`/`getRepaymentAmount`/`isDefaulted` call for affected loans reverts. The NFT-lending positions disappear from the UI permanently until governance ships a fix.
- **Fix:** the strict-fail behavior is correct for write paths but should soft-fail in views. Either (a) split into `_effectiveDeadlineView` (silent-clamp) and `_effectiveDeadlineWrite` (revert-on-violation), or (b) emit a `PauseInvariantViolated` event off-chain and return clamped zeros in the view path.

---

## F-72-7 — `RevenueDistributor.reclaimEligibleAmount()` is unbounded over `epochs.length` (LOW-INFO)

- **File:** `contracts/src/RevenueDistributor.sol:961`
- **View:** `reclaimEligibleAmount() public view returns (uint256 eligible)`
- **Vector:** scans EVERY epoch (loop at line 972: `for (uint256 i = 0; i < len; i++)`), calls `Epoch memory ep = epochs[i]` (full struct copy per iter), reads `pendingRecoveryCount[i]` and `epochClaimed[i]`. With `MIN_DISTRIBUTE_INTERVAL = 4 hours` (line 163), the protocol creates at most 6 epochs/day — so 5 years = ~10k epochs. Each iter is a few SLOADs + struct copy, ~3k gas → 30M gas at 10k epochs, just inside the eth_call ceiling but past the wallet/RPC simulator default of 12.5M.
- **Why is this not caught by `MAX_VIEW_EPOCHS = 250`:** that cap applies to `_pendingETH` (line 1373), NOT to `reclaimEligibleAmount`. The natspec admits "Bounded loop scanning every epoch — O(epochs.length)" (line 959) — so it's KNOWN, just not capped.
- **Frontend impact:** the propose-forfeit UI calls this view to size the proposal. After ~5 years of operation it gets slow; after ~10y it can't be called from a wallet. The owner-only `proposeForfeitReclaim` (line 1000) calls this internally too — so eventually the propose path itself bricks (line 1007: `if (_amount > reclaimEligibleAmount()) revert`), permanently locking forfeit-reclaim.
- **Fix:** introduce `reclaimEligibleAmountPaginated(uint256 startEpoch, uint256 maxEpochs)` matching the `claimUpTo`/`pendingETHPaginated` shape, plus a cursor-tracked `proposeForfeitReclaimWindowed(uint256 startEpoch, uint256 maxEpochs, uint256 amount)`. Same approach the contract already uses for `autoReconcileDust` (line 1082, `MAX_AUTO_RECONCILE_EPOCHS = 10`).

---

## F-72-8 — `RevenueDistributor.getEpoch(epochId)` reverts with raw OOB Panic (INFO)

- **File:** `contracts/src/RevenueDistributor.sol:1425`
- **View:** `getEpoch(uint256 epochId) external view returns (uint256, uint256, uint256)`
- **Vector:** `Epoch memory epoch = epochs[epochId];` — no bound check. Passing `epochId >= epochs.length` reverts with `Panic(0x32)` (array OOB) instead of a typed error.
- **Frontend impact:** UIs querying with stale epoch IDs (e.g., race between `epochCount()` read and `getEpoch(count-1)` read in two separate eth_calls) get an opaque panic. Wagmi/ethers loggers can't distinguish "stale state" from "contract bug".
- **Fix:** prepend `if (epochId >= epochs.length) revert InvalidEpoch();` (matches the pattern in `TegridyLaunchpadV2.getCollection` line 266, `TegridyLending.getOffer` line 1413, `VoteIncentives.commitDeadline` line 1460, etc.).

---

## F-72-9 — `MemeBountyBoard.getBounty / getSubmission` revert on raw OOB Panic (INFO)

- **File:** `contracts/src/MemeBountyBoard.sol:832` and `:846`
- **Views:** `getBounty(uint256 _id)` and `getSubmission(uint256 _bountyId, uint256 _submissionId)`
- **Vector:** identical to F-72-8 — direct `bounties[_id]` and `submissions[_bountyId][_submissionId]` reads with no bound check, panicking on invalid ids.
- **Frontend impact:** same as F-72-8; harder to distinguish "deleted" from "never existed" from "race condition".
- **Fix:** add `if (_id >= bounties.length) revert InvalidBountyId();` and equivalent for submission. Mirrors the rest of the codebase.

---

## F-72-10 — `VoteIncentives.getWhitelistedTokens()` is unbounded (LOW)

- **File:** `contracts/src/VoteIncentives.sol:1077`
- **View:** `getWhitelistedTokens() external view returns (address[] memory)`
- **Vector:** returns full `whitelistedTokenList`. `applyWhitelistChange(token, true)` (line 1101) is `onlyAdmin`, so the attack-economic vector is NIL — owner can't grief themselves. But there is NO hard cap on the list, so over the protocol lifetime this can accumulate and become slow. Also, the REMOVAL path (line 1112-1119) is O(N) — a pure swap-and-pop scan inside an `applyWhitelistChange` admin call. A 1000-token whitelist would take ~3M gas to remove an entry near the start.
- **Why does it matter:** the same array is iterated inside `_processBribeClaim` at line 1113 — so unbounded growth eventually degrades the per-claim gas, not just the view. (This is a corner case — admin-controlled and reasonable bounds in practice — but the absent cap is a footgun.)
- **Fix:** add `MAX_WHITELISTED_TOKENS = 200` (matches `MAX_BRIBE_TOKENS = 20` × 10 typical pairs); revert in `applyWhitelistChange` if cap reached. Mirror the `TegridyFactory.MAX_PAIRS = 10000` shape at line 167.

---

## F-72-11 — `TegridyStaking.votingPowerOf` and `aggregateActiveBoostBps` re-enumerate on every call (INFO)

- **File:** `contracts/src/TegridyStaking.sol:528` and `:598`
- **Views:** both iterate `_positionsByOwner[user]` via `set.length()`/`set.at(i)`.
- **Bound:** `MAX_POSITIONS_PER_HOLDER = 50` (line 218), enforced at `:1337`. So worst case per-call is 50 SLOADs — bounded, manageable.
- **Why I'm flagging it:** these views are hot-path — called by `RevenueDistributor._calculateClaim`, `TegridyLPFarming._getEffectiveBalance`, `VotePowerOracle.powerOf` — every claim, every farming reward refresh, every governance read. At 50 positions × 4-5 SLOAD per iter = 200-250 SLOADs per call, repeated multiple times per user-facing transaction. There is no cache layer. Marking as INFO because the cap exists, but worth noting that 50 is generous; halving to 25 would tighten the worst-case while still covering the multi-position-Safe use case the cap was added for.
- **Frontend impact:** none directly (call succeeds), but at MAX_POSITIONS the wallet RPC simulator can mispredict gas on bundled txs by 1-2M. Users see "out of gas" estimates from MetaMask that don't reflect actual on-chain cost.

---

## F-72-12 — `GaugeController.getTokenVotes(tokenId)` returns up to MAX_GAUGES_PER_VOTER (INFO — bounded)

- **File:** `contracts/src/GaugeController.sol:807`
- **View:** `getTokenVotes(uint256 tokenId) external view returns (VoteAllocation[] memory)`
- **Bound:** vote-time enforcement at line 313: `if (gauges.length > MAX_GAUGES_PER_VOTER) revert TooManyGauges();` with `MAX_GAUGES_PER_VOTER = 8` (line 43).
- **Status:** properly bounded. No issue. Logged for audit-trail completeness.

---

## F-72-13 — `TegridyLaunchpadV2.getAllCollections()` is unbounded but documented (INFO)

- **File:** `contracts/src/TegridyLaunchpadV2.sol:280`
- **View:** `getAllCollections() external view returns (address[] memory)`
- **Vector:** returns full `allCollections`. NatSpec at line 274-279 explicitly admits "Past a few thousand collections this view will exceed RPC response-size ceilings and effectively become uncallable" (DEEP-LP-03 audit comment).
- **Companion paginated:** `getCollectionsPaginated(offset, limit)` at line 294, capped at `MAX_PAGINATED_LIMIT = 1000`.
- **Status:** known + documented; legacy view kept for subgraph compatibility. No fix recommended (the pattern is intentional and documented).

---

## Notes / dead-ends

- `TegridyRouter.getAmountsOut/In` (lines 415, 427) — bounded at `path.length > 10` (line 417).
- `TegridyFactory.allPairsPaginated` (line 144) — bounded by `MAX_PAIRS = 10000` (line 73).
- `RevenueDistributor.pendingETH/pendingETHPaginated` (lines 1357, 1362) — bounded by `MAX_VIEW_EPOCHS = 250` (line 160).
- `VoteIncentives.claimable` (line 1027) — bounded by `MAX_BRIBE_TOKENS = 20` (line 159).
- `TegridyNFTPoolFactory.getBestBuyPool / getBestSellPool` (lines 333, 347) — explicitly DOCUMENTED as unbounded (R064 LOW), with paginated alternatives (`*Paginated`). Status: known, documented, accepted.
- `TegridyTWAP.consult` (line 489) — `period > MAX_OBSERVATIONS * MIN_PERIOD` (line 512). Bounded.
- `TegridyStaking.votingPowerAtTimestamp` (line 555) and friends — O(log(checkpoints)) via OZ Trace208.upperLookup. Bounded.
- `SequencerCheck` library — well-defended, all reverts typed and tryXxx soft-fail variants exist.
- No view has a `block.timestamp - past_time` underflow without a directional guard — Solidity 0.8 checked math + explicit `if (… > block.timestamp) return …` patterns are present everywhere I checked (`TegridyLending.sol:1606-1608`, `RevenueDistributor.sol:962`, `TegridyTWAP.sol:570`, `TegridyLPFarming.sol:248`).
- No view has `[0]` access on an array known to be empty — array-zero-access exists (e.g., `TegridyNFTPool.sol:371` `tokenIds[0]`) but always after an explicit length check.
- No aggregate-across-all-users view exists (no `totalSubscribersList`, `everyClaimer`, etc.) — protocol architecture is per-user pull, which is the right pattern.

## Severity summary

| Finding | Severity | Reason |
|---|---|---|
| F-72-1 `getProposalsInRange` no page cap | MEDIUM | governance UI breaks once proposals.length grows; trivially abusable as the cap is purely natspec |
| F-72-5 `getLatestObservation` reverts | MEDIUM | bricks lending/POL UI for un-bootstrapped pairs; no soft-fail variant |
| F-72-6 NFT-lending pause-invariant reverts in views | MEDIUM | brittle if invariant ever trips; asymmetric with ERC-20 lending fork |
| F-72-2 `getProposalsByStatus` first-pass | LOW | O(N) SLOAD grief on advertised-paginated path |
| F-72-3 `getAllPools` unbounded | LOW | discovery view bricks past ~1k pools, no paginated alternative |
| F-72-4 `getHeldTokenIds` unbounded | LOW | marketplace listing bricks for whale-LP pools |
| F-72-7 `reclaimEligibleAmount` unbounded | LOW-INFO | known O(N), gates owner-only proposal path; locks forfeit after ~10y |
| F-72-10 `getWhitelistedTokens` no cap | LOW | admin-only growth, but same array used in claim hot-path |
| F-72-8 `getEpoch` raw OOB | INFO | UX nit (Panic vs typed revert) |
| F-72-9 `getBounty/getSubmission` raw OOB | INFO | same UX nit |
| F-72-11 `votingPowerOf` 50-position cap | INFO | properly bounded but worth tightening to 25 |
| F-72-12 `getTokenVotes` 8-gauge cap | INFO | bounded, no action |
| F-72-13 `getAllCollections` documented unbounded | INFO | accepted tradeoff |
