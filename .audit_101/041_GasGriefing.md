# Audit 041 — Gas-Griefing / Unbounded-Loop DoS

**Agent:** 041 (full-force)
**Scope:** `contracts/src/**`
**Methodology:** Enumerated every `for(...)` loop, every dynamic `address[]` with on-chain iteration, every `.call{}` to user-controlled targets, and every public batch entrypoint. Cross-referenced with explicit caps (`MAX_*` constants) and bounded-by-construction patterns.
**Verdict:** Posture is **strong**. Unbounded growth surfaces are mostly view-only or carry hard caps. No critical findings; one MEDIUM (state-modifying view), one LOW (unbounded factory enumeration in helper views), several INFO.

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 0     |
| MEDIUM   | 1     |
| LOW      | 2     |
| INFO     | 5     |

---

## MEDIUM

### M-041-1: `RevenueDistributor._calculateClaim` — state-mutating "view-like" loop (acceptable, but worth noting)
**File:** `contracts/src/RevenueDistributor.sol:526` (also referenced from `claim()`/`claimUpTo()`)
**Worst-case n:** `MAX_CLAIM_EPOCHS = 500` per call. Inner per-iteration cost includes `votingPowerAtTimestamp` (binary-searched checkpoint lookup, O(log k)) plus a fallback `_restakedPowerAt` (~external CALL), and SSTORE to `epochClaimed[i]`. Estimated upper bound: ~500 × (cold-SLOAD + binary-search + maybe-CALL + SSTORE) ≈ ~9-15M gas.
**Why MEDIUM not HIGH:** the cap is enforced (`MAX_CLAIM_EPOCHS = 500`), and `claimUpTo(maxEpochs)` lets users segment. However, a passive long-locker who never drops by could face >500 epochs accumulated and **must** call `claimUpTo` (claim() reverts with `TooManyUnclaimedEpochs`). UI must surface this. Not exploitable, but discoverability matters.
**Recommendation:** Document explicitly in `claim()` natspec that >500 epochs requires `claimUpTo` (already partially done at line 422). Consider lowering `MAX_CLAIM_EPOCHS` to 200-250 for headroom against future opcode price hikes.

---

## LOW

### L-041-1: `TegridyFactory.allPairs` — push-only with no on-chain cap
**File:** `contracts/src/TegridyFactory.sol:42, 122`
**Worst-case n:** unbounded. Every `createPair` call appends.
**Risk:** No on-chain code iterates `allPairs` (verified — only `allPairsLength()` reads `.length`). External integrators (subgraph, frontend) iterate off-chain. **Not exploitable on-chain.** Flagged for completeness because spec mentions it.
**Recommendation:** No action required. Optionally add a defensive `MAX_PAIRS` (e.g. 10_000) just to prevent state bloat.

### L-041-2: `TegridyNFTPoolFactory._poolsByCollection` — unbounded view enumeration
**File:** `contracts/src/TegridyNFTPoolFactory.sol:236, 269`
**Worst-case n:** unbounded number of pools per collection.
**Risk:** `getBestBuyPool` / `getBestSellPool` are `external view` so callers eat their own gas. However, each iteration does `try pool.getBuyQuote(...)` which is an external call — a malicious pool factory deployment could create griefing pools that consume gas in `getBuyQuote`. Since pool deployment is permissionless, a griefer could spam pools per collection.
**Mitigation present:** `try/catch` swallows revert, but a pool returning a quote that loops/burns gas before returning would still consume the caller's gas. Pool code is the canonical `TegridyNFTPool` (deployed via factory CREATE2 from fixed bytecode), so quote logic is trusted — no actual exploit, but worth noting that off-chain frontends should paginate.
**Recommendation:** Add a paginated variant `getBestBuyPoolPaged(collection, offset, limit)` for very-large collections.

---

## INFO

### I-041-1: `GaugeController.removeGauge` linear scan — bounded by `MAX_TOTAL_GAUGES = 50`
**File:** `contracts/src/GaugeController.sol:493`
**Worst-case n:** 50. ~50 SLOAD = ~110k gas. Acceptable.

### I-041-2: `VoteIncentives.removeWhitelistedToken` — bounded by `MAX_BRIBE_TOKENS = 20`
**File:** `contracts/src/VoteIncentives.sol:817`
**Worst-case n:** 20. Trivial.

### I-041-3: `claimBribesBatch` nested loop — bounded by both `MAX_CLAIM_EPOCHS = 500` and `MAX_BATCH_ITERATIONS = 200`
**File:** `contracts/src/VoteIncentives.sol:605, 615`
**Worst-case n:** 200 (outer × inner combined). `totalIterations` enforces global cap with hard revert. Excellent defensive design.

### I-041-4: `SwapFeeRouter._validateNoDuplicates` — O(n²) but `path.length ≤ 10`
**File:** `contracts/src/SwapFeeRouter.sol:1237-1241`
**Worst-case n:** 10 → 45 comparisons. Trivial.

### I-041-5: `TegridyStaking.votingPowerOf` / `aggregateActiveBoostBps` — bounded by `MAX_POSITIONS_PER_HOLDER = 100`
**File:** `contracts/src/TegridyStaking.sol:362, 399`
**Worst-case n:** 100 positions. ~250k gas worst-case for `votingPowerOf` (storage-per-field reads). Cap is enforced in `_update` (line 874).

---

## Bounded by Construction (no findings)

- **`TegridyTWAP`** — observation array fixed-size 48, all loops bounded by `MAX_OBSERVATIONS`.
- **`TegridyDropV2._safeMint` loop** — bounded by `maxSupply` and per-wallet cap; user pays own gas.
- **`TegridyNFTPool._heldIds`** — swap-and-pop O(1) for add/remove; user-supplied `tokenIds[]` arrays mean caller pays.
- **`MemeBountyBoard.submissions`** — capped at `MAX_SUBMISSIONS_PER_BOUNTY = 100`, no claimants list.
- **`PremiumAccess.batchReconcileExpired`** — caller-supplied array, caller pays.
- **`ReferralSplitter._checkCircularReferral`** — fixed `CIRCULAR_DEPTH = 25`.
- **`TegridyLPFarming`** — single-pool Synthetix-style; no `massUpdatePools`, no per-user array iteration.
- **`CommunityGrants` / `TegridyLending` / `TegridyNFTLending` / `POLAccumulator`** — no on-chain loops.
- **`GaugeController.vote` / `revealVote`** — bounded by `MAX_GAUGES_PER_VOTER = 8`.
- **`TegridyRouter.swap*` paths** — capped at `path.length > 10 → revert PathTooLong`.

---

## `.call{}` / Return-Data Bomb Surface

All ETH-forwarding `.call{}` to potentially-malicious recipients use **explicit gas stipends**:
- `RevenueDistributor.claim/claimUpTo` → `gas: 10000` ✅
- `MemeBountyBoard.*` → `gas: 10000` ✅
- `CommunityGrants` → `gas: 10_000` ✅
- `VoteIncentives.claim*` → `gas: 50000` (smart-account compat, with pending-fallback) ✅
- `SwapFeeRouter` → `gas: 50_000` ✅
- `WETHFallbackLib.safeTransferETHOrWrap` → `gas: 10000` then WETH wrap fallback ✅

Three trusted-treasury-only calls (`POLAccumulator:399,478`, `RevenueDistributor:276,303,649`, `VoteIncentives:930`, `TegridyTWAP:299`, `TegridyFeeHook:414`) use unmetered gas — these are owner-controlled treasury sends, acceptable trust model.

**No return-data bomb surface found** — Solidity's high-level `.call{}` returns memory-bounded `(bool, bytes memory)`, and all instances either ignore the bytes (`(bool success,)`) or never inspect them. Pre-Solidity-0.8.0 inline-assembly returndatacopy bombs not present.

---

## Top-3 Items to Action

1. **M-041-1** — Document `MAX_CLAIM_EPOCHS = 500` constraint in `RevenueDistributor.claim()` UI/UX so long-locked users always reach for `claimUpTo`. Consider lowering to ~250 for opcode-cost headroom.
2. **L-041-2** — Add paginated variant of `getBestBuyPool` / `getBestSellPool` for large NFT collections (off-chain reliability concern, not exploit).
3. **L-041-1** — Optional: add `MAX_PAIRS` to `TegridyFactory` as defense-in-depth state-bloat ceiling.

---

**Conclusion:** Codebase exhibits strong, consistent application of explicit caps (`MAX_*`), gas stipends, and pull-pattern fallbacks. Defensive batching limits (e.g. `MAX_BATCH_ITERATIONS`) show awareness of block-gas-limit DoS. No exploitable gas-griefing vector identified.
