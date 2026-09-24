# Agent 67/100 — Timestamp / Blockhash Manipulation Audit

**Date:** 2026-05-07
**Lens:** Block-timestamp / blockhash manipulation across the protocol
**Scope:** All Solidity files in `contracts/src/`

## Method

1. Enumerated all `block.timestamp`, `blockhash`, `block.chainid`, `block.number` uses (439 total `block.timestamp` references across 27 files).
2. For each occurrence, classified by attack class: lock boundary, auction decay, reward rate change, cooldown bypass, blockhash randomness, same-block atomicity, chainId.
3. Compared each window/threshold to the validator skew bound (~±15s on Ethereum L1, monotonic-+1s on L2 sequencers).
4. Surfaced findings where the threshold is the same magnitude as the skew, where the threshold protects an economically valuable invariant, or where comments mis-describe behaviour.

## Headline result

**No exploitable timestamp manipulation found.** The protocol's design philosophy — "all economically-relevant windows >= hours, all timestamps T-1 reads on Trace208 checkpoints, all randomness derived off-chain or signed" — holds end-to-end. There is no `blockhash(...)` use anywhere in the codebase (verified by grep — zero matches), so blockhash-randomness attacks are structurally impossible.

`block.chainid` is used correctly (CREATE2 salts in `TegridyFactory.sol:194`, `TegridyLaunchpadV2.sol:214`, `TegridyNFTPoolFactory.sol:231`; commit hashes in `GaugeController.sol:447`, `VoteIncentives.sol:1487`).

The findings below are LOW-severity observations on either documentation accuracy or threshold tightness; none enable a profitable attack.

---

## F-67-1 (LOW / Informational) — `RECOVER_CALLER_CREDIT_COOLDOWN = 30 seconds` is comparable to validator skew

**File:** `contracts/src/SwapFeeRouter.sol:336`
**Code:**
```solidity
uint256 public constant RECOVER_CALLER_CREDIT_COOLDOWN = 30;
// ...
function recoverCallerCredit() external nonReentrant whenNotPaused {
    if (lastPull != 0 && block.timestamp < lastPull + RECOVER_CALLER_CREDIT_COOLDOWN) {
        revert RecoverCallerCreditCooldown();
    }
    lastCallerCreditAt = block.timestamp;  // line 1808
    ...
}
```

**Manipulation window:** A validator could shift `block.timestamp` by ~12s per slot (Ethereum proposer max). Two adjacent blocks could show a delta of `block.timestamp[N+1] - block.timestamp[N]` larger than the wall-clock delta, allowing bypass of the 30s cooldown after as little as ~16-18s of real time on Ethereum, or as little as 1 block on fast L2s where the cooldown is enforced strictly.

**Exploit:** The function only routes ETH from `referralSplitter.callerCredit` back into `accumulatedETHFees`. The attacker pays gas (~62k per pull) but receives no ETH; the slot's grief value is event-spam only. Per the in-code natspec (lines 1786-1801), the cooldown is positioned as a rate-limiter, not a security boundary. Authentication via `nonReentrant` + the no-economic-payoff property closes the only useful exploit path.

**Severity:** Informational. The cooldown is acknowledged as best-effort grief throttle; no value at risk. Bumping to >= 60s would tighten this further but is not required.

---

## F-67-2 (LOW / Informational) — `MIN_ACTIVATION_DELAY = 15 seconds` matches the worst-case validator skew

**File:** `contracts/src/PremiumAccess.sol:76`, used at line 178
**Code:**
```solidity
uint256 public constant MIN_ACTIVATION_DELAY = 15 seconds;
// ...
if (jbacNFT.balanceOf(user) > 0 && nftActivationBlock[user] != 0 &&
    block.timestamp > nftActivationBlock[user] + MIN_ACTIVATION_DELAY) {
    return true;
}
```

**Manipulation window:** On Ethereum L1, a single proposer can push `block.timestamp` forward by up to ~12s (slot duration) without consensus rejection. Block N at honest time T sets `nftActivationBlock[user] = T`. Block N+1 at honest time T+12 could land at `block.timestamp = T+24` if the proposer is hostile. Strict `>` then admits the activation immediately at the next block — same-actor flash-borrow window from 1 block to 0 blocks of separation in the worst case.

**Exploit:** `hasPremium()` (the deprecated check) would return true after a single block on a hostile-proposer Ethereum block. The contract documents this risk extensively (lines 152-173): `hasPremium()` is **deprecated for on-chain gating** and `hasPremiumSecure()` is the value-routing path. Confirmed via grep: `SwapFeeRouter.sol:632` uses `hasPremiumSecure` exclusively. `hasPremiumSecure()` does NOT honor NFT-activation at all (line 200 returns false for the NFT branch), so the 15s window is irrelevant to any value-bearing path.

**Severity:** Informational, fully documented. The contract acknowledges the flash-loan gap as a known limitation of ERC-721 (no historical balance), and routes value through subscription-only `hasPremiumSecure()`. External integrators are warned (lines 172-173).

---

## F-67-3 (INFO) — NFTPool `block.timestamp == lastWithdrawBlock` same-second guard documentation drift

**File:** `contracts/src/TegridyNFTPool.sol:264, 333`
**Code:**
```solidity
if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
```

**Issue:** The CLK-02 migration comment (lines 67-69) claims the guard is "effectively still same-tx in practice — block intervals all >0s". This is correct for L2s (Optimism/Base/Arbitrum where blocks tick ~1-2s with strictly monotonic timestamps) but **not strictly accurate for Ethereum L1**, where blocks are 12s apart. The guard fires only within the SAME block on L1 (since the next block has `block.timestamp >= prev + 1`), which is precisely what the original `block.number == lastWithdrawBlock` semantic enforced. So no behaviour drift — but the comment "still same-tx in practice" should read "same-tx, plus same-second on chains with sub-second blocks." Cosmetic only.

**No exploit.** The guard's intent (block same-tx flash-sandwich removeLiquidity → swap manipulation) is preserved.

---

## F-67-4 (INFO) — Drop Dutch-auction has no `MIN_DUTCH_DURATION`

**File:** `contracts/src/TegridyDropV2.sol:425, 427`
**Code:**
```solidity
if (p.dutchDuration == 0) revert InvalidDutchAuctionConfig();
if (p.dutchStartPrice - p.dutchEndPrice < p.dutchDuration) revert InvalidDutchAuctionConfig();
```

**Observation:** The only floor on `dutchDuration` is `> 0`. An owner deploying with `dutchDuration = 30 seconds` and `priceDrop = 30 wei` would create an auction where ±15s validator skew is 50% of the decay window. This is amplified by the `decay = (priceDrop * elapsed) / dutchDuration` math.

**Exploit:** None against an honest owner. A malicious owner could front-run their own auction by colluding with a validator, but a malicious owner has many richer attack paths (parameters are `onlyOwner`-set). For any reasonable `dutchDuration` (≥ 1 hour), validator skew is < 0.5% of the decay window — well within the noise floor of mint MEV.

**Recommendation (not required):** Add a `MIN_DUTCH_DURATION = 5 minutes` constant matched against `dutchDuration` in `_validateDutchConfig`. Battle-tested precedent: Sudoswap LSSVMPair has analogous floors on `delta` granularity.

---

## F-67-5 (INFO) — `LoanTooRecent` cross-block boundary on hostile-proposer L1

**File:** `contracts/src/TegridyLending.sol:1023`, `contracts/src/TegridyNFTLending.sol:641`
**Code:**
```solidity
if (block.timestamp == startTime) revert LoanTooRecent();
```

**Observation:** `startTime = block.timestamp` is set at acceptOffer; the guard prevents repay in the same block. On Ethereum L1 with strictly monotonic block timestamps, this functions as a perfect same-block guard (next block has `block.timestamp >= startTime + 1`). On L2 sequencers (Optimism/Base/Arbitrum) timestamps also strictly increase by ≥ 1s per block, so cross-block bypass is impossible.

**Verdict:** No exploit. This is correct behaviour, just worth noting that it relies on EVM-spec-mandated monotonic timestamps. If a future fork or a non-Ethereum-shape L2 ever allowed equal timestamps across blocks, this guard would degrade to per-tx-only — but no current target chain has that property.

---

## F-67-6 (INFO) — Same-block stake/distribute closure verified

**Files:** `contracts/src/RevenueDistributor.sol:368`, `contracts/src/TegridyStaking.sol:225-228, 567-569, 581-590`

**Observation:** The protocol pins all per-user and aggregate epoch reads to `block.timestamp - 1` via OZ `Checkpoints.Trace208.upperLookup`, with a same-block stake (Trace208 key == T) being EXCLUDED from the read. This closes the same-block dilution race that REV C-01 documented.

**Hostile-proposer test:** Could a validator set `block.timestamp = T` for two adjacent blocks to inflate `_totalBoostedStakeCheckpoints`? No — Ethereum requires strictly monotonic timestamps, and `_totalBoostedStakeCheckpoints.push` checks `last == newTotal` to no-op redundant writes. Even if a write succeeded with key=T while the previous key was T-1, `upperLookup(T-1)` still returns the pre-T-1 entry. **The model is robust to the validator-skew worst case.**

---

## F-67-7 (INFO) — Commit/reveal window borderlines explicitly grace-buffered

**File:** `contracts/src/GaugeController.sol:467, 522, 589, 590`

**Observation:** The protocol uses a `REVEAL_GRACE` (5 min) buffer on both sides of the reveal window:
- Commit closes `REVEAL_GRACE` BEFORE reveal opens (line 467)
- Cancel closes `2 * REVEAL_GRACE` BEFORE reveal opens (line 522)
- Reveal admits from `revealOpens - REVEAL_GRACE` (line 589) until `revealCloses + REVEAL_GRACE` (line 590)

The R016 M-1 fix documents the see-then-cancel race that motivated the double-grace cancel boundary. Validator drift of ±15s is dwarfed by 5min grace × 2.

**Verdict:** Correctly hardened. All boundaries are non-overlapping by design, and the trailing-grace lookback in `revealVote` (line 549-579) correctly handles the epoch-resolution edge.

---

## F-67-8 (INFO) — TWAP first-observation bypass closure

**File:** `contracts/src/TegridyTWAP.sol:332-354`

**Observation:** Fresh-eyes H-3 marks the very first observation as `bypassed = true`, and the deviation gate is bypassed for observations 2 and 3 (BATCH-M3 H7 self-bootstrap grace). Observation #4+ enforces ±50% deviation from `lastSpot`. Combined with `MIN_PERIOD = 15 minutes` between observations, a manipulator must sustain a manipulated reserve ratio for 30+ minutes before a single un-bypassed observation lands. Validator timestamp drift cannot accelerate this — `MIN_PERIOD` is enforced in `canUpdate()` via `uint256(elapsed) >= MIN_UPDATE_INTERVAL`.

**Verdict:** Correctly bounded. Validator skew is irrelevant against a 15-minute floor enforced via Trace208 checkpoint semantics.

---

## Dead-ends (investigated, no finding)

- **`block.number` migrations to `block.timestamp` (CLK-02, M-36):** All deliberate, well-documented, semantically equivalent or stricter than the originals.
- **Lending/NFTLending `block.timestamp == startTime` guards:** Solid; rely on monotonic-timestamp invariant guaranteed by Ethereum + all targeted L2s.
- **Revenue distribution T-1 snapshot:** Verified safe against hostile-proposer scenarios via Trace208 `upperLookup` semantics.
- **`block.chainid` in CREATE2 salts and EIP-712 commits:** All bind correctly to deployment chain, blocking cross-chain replay. Matches Curve / Aave / Aerodrome patterns.
- **All cooldowns >= 1 hour are immune to validator skew:** TRANSFER_COOLDOWN (24h), TRANSFER_RATE_LIMIT (1h), CONVERSION_COOLDOWN (1h), ACCUMULATE_COOLDOWN (1h), SYNC_COOLDOWN (7d), FORCE_RETURN_COOLDOWN (1h), BONUS_RATE_ACTION_COOLDOWN (24h), MIN_HOLDING_PERIOD (24h), REFERRER_COOLDOWN (30d), PROPOSAL_COOLDOWN (1d), BRIBE_RESCUE_DELAY (30d), DUST_RECLAIM_GRACE (14d), CLAIM_RECOVERY_DELAY (48h), CLAIM_GRACE_PERIOD (7d), all timelock delays (>= 1h via `MIN_DELAY`).
- **EIP-2612 permit `deadline`:** Standard pattern. Off-chain signer chooses the deadline; ±15s skew at most causes a benign revert.
- **Deadline params on swap paths (`MAX_DEADLINE = 2 hours` Router, `MAX_DEADLINE = 1 minutes` POL):** Same-class — caller-supplied; skew can only cause revert, not over-execution.
- **Sequencer-uptime feed staleness math:** Has explicit clock-skew guards (V2-LIB-M1 / V3-LIB-M1) — `if (updatedAt > block.timestamp)` directional check before subtraction precludes future-dated-feed underflow.
- **`blockhash(...)`:** ZERO matches. Protocol does not derive randomness from block data.

## Summary

8 informational notes, 0 medium+, 0 exploits. Block-timestamp surface area is correctly hardened. The two findings (F-67-1 and F-67-2) where thresholds are within an order of magnitude of validator skew are acknowledged as either pure rate-limiters (no value flow) or formally deprecated paths with a battle-tested replacement on the value-bearing surface.
