# Agent 50 — Unbounded Loops / Gas-DoS / DoS-via-Revert Audit

**Lens:** Every for/while loop. Bounded by user input? Can attacker grow the bound infinitely? Mappings → arrays of users/tokens that grow over time, iterated in claim/distribute. External call inside loop — single revert kills loop. Push payment pattern. Token transfer to a recipient that always reverts. Distribution function reverts at gas-out for last 5% of recipients. View functions that index into long arrays. `totalSupply` / aggregate unbounded reads.

**Scope:** All Solidity under `contracts/src/`.

**Date:** 2026-05-07.

---

## SUMMARY

The protocol is **broadly well-defended** against gas-DoS — every user-facing loop I inspected has either an explicit cap (`MAX_TOTAL_GAUGES = 50`, `MAX_GAUGES_PER_VOTER = 8`, `MAX_BRIBE_TOKENS = 20`, `MAX_CLAIM_EPOCHS = 250`, `MAX_POSITIONS_PER_HOLDER = 50`, `MAX_BATCH_ITERATIONS = 200`, `MAX_MINT_PER_TX = 50`, `MAX_POOLS_PER_COLLECTION = 200`, `CIRCULAR_DEPTH = 100`, `MAX_OBSERVATIONS = 48`, conversion-path 4-hop) or pagination support. External call sites that fan out to user-controlled recipients use Solmate-style 10k–50k gas stipends with pull-pattern fallback queues, so a single revert-on-receive recipient cannot brick a distribution.

That said, I found **one real long-tail bricking vector**, **one minor gas-meter inconsistency**, and several **owner-griefable but acceptable** patterns. Findings below.

---

## FINDINGS

### F-50-1 — `RevenueDistributor.reclaimEligibleAmount()` is `O(epochs.length)` with no internal page bound; long-term DoS for `proposeForfeitReclaim`

**File:** `contracts/src/RevenueDistributor.sol:961-998`

**Loop:**
```solidity
function reclaimEligibleAmount() public view returns (uint256 eligible) {
    uint256 cutoff = ...;
    uint256 len = epochs.length;
    uint256 extendedCutoff = ...;
    for (uint256 i = 0; i < len; i++) {
        Epoch memory ep = epochs[i];   // 3-slot SLOAD
        ...
        if (pendingRecoveryCount[i] > 0) continue;  // extra SLOAD
        uint256 unclaimed = ep.totalETH > epochClaimed[i]   // SLOAD
            ? ep.totalETH - epochClaimed[i] : 0;
        eligible += unclaimed;
    }
}
```

**Growth vector:** `epochs.length` is monotonic — `epochs.push(...)` at line 404 is the only writer, `distribute()` / `distributePermissionless()` add one entry per call. Minimum interval between pushes is `MIN_DISTRIBUTE_INTERVAL = 4 hours` (line 163). A live keeper distributing every 4h grows `epochs.length` by ~6/day = ~2200/year. After 5 years ≈ 11k entries.

**Per-iteration cost:** ~10–15k gas (3 cold storage slots for the `Epoch` struct + 1 cold SLOAD for `epochClaimed[i]` + 1 cold SLOAD for `pendingRecoveryCount[i]` + arithmetic). At 10k iterations × 12k gas ≈ 120M gas — well above the ~30M block limit and the typical 50M `eth_call` gas budget.

**DoS scenario:** `reclaimEligibleAmount()` is invoked by `proposeForfeitReclaim()` at line 1007:

```solidity
function proposeForfeitReclaim(uint256 _amount) external onlyOwner {
    ...
    if (_amount > reclaimEligibleAmount()) revert ForfeitExceedsEligibleDust();
    ...
}
```

Once `epochs.length` exceeds the gas envelope (years 4–5+), `proposeForfeitReclaim()` reverts with OOG. The owner permanently loses the ability to reclaim genuinely-forfeited dust (legitimate function, lifetime-capped at `MAX_LIFETIME_FORFEIT_BPS = 1%` of `totalDistributed`). Funds aren't lost — they just become permanently illiquid.

**Severity:** **MEDIUM** (long-tail; not a near-term risk; affects an admin function only). The `_pendingETH` view and `_calculateClaim` write-path already shipped paginated variants (`MAX_VIEW_EPOCHS = 250`, `MAX_CLAIM_EPOCHS = 250`); this view was missed in that pass.

**Suggested fix:** add a `reclaimEligibleAmountPaginated(uint256 startEpoch, uint256 endEpoch)` view, gate `proposeForfeitReclaim` on a paginated proposal-time call, or add a per-epoch cumulative-eligible accumulator updated atomically alongside `epochs.push` + `epochClaimed[i] += share`.

---

### F-50-2 — `VoteIncentives.claimBribesBatch` zero-share path is uncapped by `MAX_BATCH_ITERATIONS`; small voter can self-OOG

**File:** `contracts/src/VoteIncentives.sol:906-988`

**Loop:**
```solidity
for (uint256 e = epochStart; e < epochEnd; e++) {  // up to MAX_CLAIM_EPOCHS = 250
    ...
    address[] memory tokens = epochBribeTokens[e][pair];
    for (uint256 i = 0; i < tokens.length; i++) {  // up to MAX_BRIBE_TOKENS = 20
        ...
        uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
        if (share == 0) {
            claimed[msg.sender][e][pair][token] = true;  // 22k cold SSTORE
            anyClaimed = true;
            continue;                                     // <-- NOT counted by totalIterations
        }
        ...
        totalIterations++;
        require(totalIterations <= MAX_BATCH_ITERATIONS, "TOO_MANY_ITERATIONS");
    }
}
```

**Asymmetry:** the `MAX_BATCH_ITERATIONS = 200` gate (line 964) is incremented **only on the non-zero-share branch** (after line 945). The DEEP-GOV-02 fix correctly flips the `claimed[…] = true` bit on zero-share to defeat gas-grief-via-rollback, but the bookkeeping write itself counts ~26k gas (cold SSTORE 22k + 2× cold SLOAD 4k) and is uncapped.

**Worst case (theoretical):** 250 epochs × 20 tokens = 5000 iterations × ~26k gas = **~130M gas**, well above the 30M block limit.

**Realistic case:** for `share` to round to 0, the voter's gauge weight on this pair must be tiny vs. total — `userVoteForPair / totalVotesForPair < 1 / bribeAmount`. With `MIN_BRIBE_AMOUNT = 0.001 ether = 1e15 wei`, the victim's vote share has to be < 1e-15 of the pool's gauge votes for share to round to zero. Realistically only relevant for dust-voter accounts.

**DoS scenario:** a small voter who calls `claimBribesBatch(epochStart, epochEnd, pair)` covering many epochs (where they always rounded to 0 share) gets self-DoS'd if the range × token-count × ~26k exceeds gas budget. The `claimBribes` (single-epoch) entry-point has no equivalent risk (capped at 20 tokens). Workaround: caller chunks the range. Note that the caller has full control of `epochStart..epochEnd`, so this isn't an attacker-inflicted DoS — it's a "pagination required" UX issue.

**Severity:** **LOW** (caller-controlled range; not exploitable cross-user; only griefs the small-voter caller themselves; unrealistic in production parameter regime).

**Suggested fix:** increment `totalIterations++` on the zero-share branch too, before `continue`. Mirrors the M-08 gas-grief defense on the non-zero path uniformly.

---

### F-50-3 — `_pruneAndGetRollingDisbursed` while-loop walks ring buffer; bounded by MAX_DISBURSEMENTS

**File:** `contracts/src/CommunityGrants.sol:1033-1049, 1062-1069`

**Loop:** `while (head != tail)` walking `disbursementTimestamps`/`Amounts` ring buffer.

**Analysis:** The ring buffer is hard-capped at `MAX_DISBURSEMENTS` entries (line 1120 / 1133). The prune loop runs at most one full traversal (O(MAX_DISBURSEMENTS)) before `head` lands on a non-expired entry or catches up to `tail`. The `view` variant (`rollingDisbursedView` at line 1056) mirrors the same logic without state mutation.

**Status:** **NOT A FINDING.** Bounded; defended by `RollingBufferFull` revert (line 1128) when buffer fills with still-in-window entries.

---

### F-50-4 — `ReferralSplitter._checkCircularReferral` is O(N²) on `CIRCULAR_DEPTH`

**File:** `contracts/src/ReferralSplitter.sol:315-344`

**Loop shape:** outer for (depth ≤ 100) × inner for (visited ≤ 100) = up to 10,000 inner SLOAD/compare iterations.

**Cost bound:** the outer loop terminates early at `current == address(0)` (no upstream); each outer iteration does one storage SLOAD on `referrerOf[current]` (~2.1k cold) plus a memory walk of the visited array. Worst case (an honest 99-deep chain): 99 × ~3k storage + ~5k mem = ~300k gas. Acceptable but on the upper edge for a `setReferrer` call.

**Status:** **NOT A FINDING (acknowledged in code).** The R014 NatSpec (lines 297–313) explicitly chose this trade-off over cheaper but bypassable variants, and stake-gates referral payouts via `MIN_REFERRAL_STAKE_POWER` to bound the economic upside of any successful ring.

---

### F-50-5 — Owner-griefable but acceptable: `TegridyNFTPool.{addLiquidity, removeLiquidity, withdrawNFTs, syncNFTs}` unbounded `tokenIds`

**File:** `contracts/src/TegridyNFTPool.sol:383-388, 407-413, 679-688, 690-700`

**Loop shape:** all four functions iterate `tokenIds.length` with no internal cap; only the callers' (owner's) gas budget bounds them. `safeTransferFrom` to `address(this)` (addLiquidity) or `msg.sender` (removeLiquidity / withdrawNFTs) is sender-controlled, so a malicious receiver hook reverts only the owner's own tx.

**Status:** **NOT A FINDING.** Owner-only paths whose only victim is the owner. The `swapETHForNFTs` / `swapNFTsForETH` user-facing variants are correctly bounded at 100 (lines 339, 270 enforced via `numItems > 100`).

---

### F-50-6 — Owner-griefable but acceptable: `PremiumAccess.batchReconcileExpired` unbounded `_users` array

**File:** `contracts/src/PremiumAccess.sol:482-496`

**Loop shape:** `for (i=0; i<_users.length; i++)` with no internal cap. Permissionless caller, so anyone can pass a too-large array. But each iteration is pure storage mutation of caller-controlled targets — the worst case is the caller's own self-OOG.

**External-call risk:** none — no transfers, only storage writes (`userEscrow[user] = 0`, `totalRefundEscrow -=`, `isActiveSubscriber[user] = false`). Single revert by an external party is impossible (no external calls inside the loop).

**Status:** **NOT A FINDING.** Caller-bounded; permissionless; no external CALL inside the loop.

---

### F-50-7 — `RevenueDistributor.autoReconcileDust` capped at `MAX_AUTO_RECONCILE_EPOCHS = 10`, breaks early on grace/recovery

**File:** `contracts/src/RevenueDistributor.sol:1105-1170`

**Loop shape:** `for (i=cursor; i<endEpoch; i++)` with `endEpoch = min(cursor+10, destEpoch)`. Inner storage-only ops; no external calls. Pending-recovery epochs HALT the cursor (line 1146-1149) preserving residual dust.

**Status:** **NOT A FINDING.** Hard 10-epoch cap; permissionless; correctly bounded.

---

### F-50-8 — `RevenueDistributor._calculateClaim` external `_restakedPowerAt` inside loop is try/catch-wrapped

**File:** `contracts/src/RevenueDistributor.sol:704-788`

**Loop shape:** `for (i=startEpoch; i<endEpoch; i++)` with `endEpoch - startEpoch ≤ MAX_CLAIM_EPOCHS = 250`. Inside, `_restakedPowerAt(user, epoch.timestamp)` (line 767) does `try restakingContract.boostedAmountAt(...)` with no gas cap, but the catch-block (lines 545–547) returns 0 on revert/OOG.

**Risk:** if the restaking contract's `boostedAmountAt` is upgraded/captured to consume an unbounded amount of legitimate gas (not revert, just slow), 250 iterations × N-million gas could hit block-gas-limit. The user's mitigation is `claimUpTo(maxEpochs)` to chunk.

**Status:** **NOT A FINDING (but worth tracking).** The restaking contract is one-shot owner-set via `setRestakingContract` on RevenueDistributor — same trust boundary as `tegridyStaking` itself. The try/catch is best-effort. The base claim path (`votingEscrow.votingPowerAtTimestamp`) is a Trace208 lookup — O(log n) with bounded gas. Only the restaker fallback inside `if (isRestaker)` (line 766–768) is the surface area. Because `isRestaker` is cached outside the loop (line 718), non-restakers pay zero per-epoch cost on this path.

**Suggested defense-in-depth:** add an explicit gas cap (e.g., `boostedAmountAt{gas: 50_000}`) inside `_restakedPowerAt`, mirroring the SwapFeeRouter.recordFee 700k pattern. The function only does a Trace208 lookup, so 50k is generous.

---

### F-50-9 — `TegridyNFTPoolFactory.{getBestBuyPool, getBestSellPool}` unbounded view, acknowledged

**File:** `contracts/src/TegridyNFTPoolFactory.sol:333-352`

**Loop shape:** scans all pools for a collection (capped at `MAX_POOLS_PER_COLLECTION = 200`); each iteration makes 2–3 external CALLs into `pool.poolType()`, `pool.getHeldCount()`, `pool.getBuyQuote(numItems)` / `getSellQuote(numItems)`. Worst case ~200 pools × ~30k gas per CALL ≈ 6M gas.

**Frontend-DoS risk:** legitimately consumable within a 50M `eth_call` budget. The collection-pool cap was specifically chosen for this reason.

**Status:** **NOT A FINDING (R064 documented).** The `*Paginated` variants (lines 365–384) are the canonical API; the unbounded variants are kept for backward compatibility and explicitly warned in NatSpec.

---

### F-50-10 — `TegridyStaking.votingPowerOf` / `aggregateActiveBoostBps` per-user iteration of `_positionsByOwner`, capped at 50

**File:** `contracts/src/TegridyStaking.sol:528-547, 598-615`

**Loop shape:** iterates the user's `EnumerableSet.UintSet` of staking positions. Hard cap of `MAX_POSITIONS_PER_HOLDER = 50` enforced at `_afterTokenTransfer` line 1337 BEFORE the EOA `AlreadyHasPosition` guard.

**Cost bound:** ~8.4k gas per cold position lookup × 50 = ~420k. SwapFeeRouter forwards 700k gas to `referralSplitter.recordFee` (line 587) explicitly to absorb this worst case (see the DEEP-R3-H01 NatSpec on line 561–573).

**Status:** **NOT A FINDING.** Already deeply analyzed and accommodated by the 700k gas budget on the splitter call path; cap is enforced at every transfer entry point.

---

## OUT OF SCOPE / DEAD-ENDS

- **All single-NFT operations in `TegridyRestaking`** — `restake`, `unrestake`, `claimAll`, `refreshPosition`, `claimResidualForTokenId` — are loop-free per-tokenId mutations. No iteration over user sets.
- **`TegridyLending`, `TegridyNFTLending`, `TegridyLPFarming`** — no for/while loops. All single-position operations.
- **`Toweli`, `MemeBountyBoard`, `TegridyFeeHook`** — no for/while loops.
- **`TegridyPair`** — no for/while loops in mint/burn/swap (Uniswap V2 pattern).
- **`TegridyTWAP`** — single search loop bounded by `MAX_OBSERVATIONS = 48`. Each iteration is two storage SLOADs.
- **`TegridyDropV2.mint`** — `_safeMint` loop bounded by `MAX_MINT_PER_TX = 50`.
- **`TegridyLaunchpadV2`** — paginated `allCollectionsPaginated` only, bounded by `MAX_PAGINATED_LIMIT`.
- **`SwapFeeRouter._validateNoDuplicates` / `_validateConversionPath`** — O(n²) on user-supplied path, but path length capped at 10 (router) and 4 (SFR conversion).
- **`TegridyRouter.{getAmountsOut, getAmountsIn, _validatePathNoCycles, _swap, _swapSupportingFeeOnTransferTokens}`** — path bounded at 10.
- **`TegridyFactory.createPair` ERC-1820 introspection loop** — fixed 3 iterations.
- **`GaugeController.{vote, revealVote, executeRemoveGauge, executeRemoveGaugeFinalize}`** — gauge arrays capped at `MAX_GAUGES_PER_VOTER = 8` and `MAX_TOTAL_GAUGES = 50`.
- **All `proposals` / `bounties` / `epochs` / `epochBribeTokens` array-iterating views** — paginated where consumed on-chain; legacy non-paginated variants documented as off-chain-only.
- **Token transfers inside loops** — checked. NFT transfers in `swapETHForNFTs` (loop body, NFT receiver = msg.sender = buyer = signer of the tx → cannot self-DoS) and `addLiquidity` (owner-only, owner sends to self via `address(this)` → cannot self-DoS). ETH transfers in distribution paths use 10k–50k gas stipends with WETH-fallback or pull-pattern queue (RevenueDistributor.claim → 10k stipend → pendingWithdrawals; SwapFeeRouter.distributeFeesToStakers → 50k stipend → pendingDistribution; CommunityGrants → 10k stipend → WETH fallback → unwrap on fail; MemeBountyBoard.completeBounty → 50k stipend → pendingPayouts; VoteIncentives.claimBribes → 50k stipend → pendingETHWithdrawals + safeTransfer try/catch → pendingTokenWithdrawals).

---

## DELIVERABLE-AS-CODE: SUMMARY TABLE

| # | File | Lines | Severity | Type | Live? |
|---|---|---|---|---|---|
| F-50-1 | `RevenueDistributor.sol` | 961-998 | MEDIUM | Long-tail unbounded view | Yes (years 4–5+) |
| F-50-2 | `VoteIncentives.sol` | 906-988 | LOW | Gas-meter asymmetry | Theoretical |
| F-50-3 | `CommunityGrants.sol` | 1033-1069 | — | Bounded ring-buffer prune | Not a finding |
| F-50-4 | `ReferralSplitter.sol` | 315-344 | — | Acknowledged O(N²) bound | Not a finding |
| F-50-5 | `TegridyNFTPool.sol` | 383-413, 679-700 | — | Owner-griefable only | Not a finding |
| F-50-6 | `PremiumAccess.sol` | 482-496 | — | Caller-bounded; no ext calls | Not a finding |
| F-50-7 | `RevenueDistributor.sol` | 1105-1170 | — | Hard 10-cap | Not a finding |
| F-50-8 | `RevenueDistributor.sol` | 704-788 | INFO | Try/catch ext call in loop | Defense-in-depth suggested |
| F-50-9 | `TegridyNFTPoolFactory.sol` | 333-352 | — | Acknowledged R064 | Not a finding |
| F-50-10 | `TegridyStaking.sol` | 528-547, 598-615 | — | Capped at 50; budgeted | Not a finding |

**Two actionable findings (F-50-1 MEDIUM, F-50-2 LOW). Eight defended-or-acknowledged.**
