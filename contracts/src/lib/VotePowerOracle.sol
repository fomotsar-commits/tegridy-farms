// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Internal interface — consumers do not need to import or use this
///      directly. Library functions accept raw `address` parameters so any
///      consumer with its own typed staking/restaking interface can call
///      without rewriting their interface declarations or storage layout.
///      Both staking-side and restaking-side contracts expose this exact
///      shape (TegridyStaking natively; TegridyRestaking via the
///      `votingPowerOf` / `votingPowerAtTimestamp` aliases added in pass-8
///      batch 1 that delegate to the existing `_boostedAmountAt`).
interface IVoteSource {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
}

/// @title VotePowerOracle
/// @notice Single source of truth for veTOWELI voting power across all
///         governance consumers (GaugeController, VoteIncentives,
///         MemeBountyBoard, CommunityGrants, RevenueDistributor,
///         ReferralSplitter).
///
///         AUDIT FIX: GOV-ECON-01 (a.k.a. C10 in the master report) —
///         depositing a staking NFT into TegridyRestaking moves custody of
///         the NFT to the restaking contract. The user's per-owner enumerable
///         set in TegridyStaking goes to zero AND a 0-checkpoint is written
///         at deposit time. After that:
///
///           staking.votingPowerOf(user)              → 0
///           staking.votingPowerAtTimestamp(user, ts) → 0  (post-deposit)
///           staking.votingPowerOf(restakingContract) → 0  (hard-coded)
///
///         Result: ANY user who restakes is silently disenfranchised across
///         every governance consumer that reads only the staking-side view.
///         RevenueDistributor was already patched (it reads
///         `restaking.boostedAmountAt(user, ts)` as a fallback) but the
///         other four consumers were not.
///
///         This library wraps both reads and returns the additive sum, so
///         consumers calling `VotePowerOracle.powerOf(user, staking, restaking)`
///         get the user's TOTAL voting power across both contracts.
///
/// @dev Pattern reference:
///        - Frax veFXS + Convex veFXSStrategy: wrapper exposes vote-power view
///          consumers query in addition to the underlying.
///        - Curve veCRV + veBoost system: aggregates boost from multiple
///          sources via a delegation-aware oracle.
///
/// @dev Library is intentionally `pure` of state and `internal` of linkage so
///      every consumer inlines it with no extra deploy footprint or storage
///      slot. No upgrade surface; future changes are source-only and require
///      consumer recompilation (acceptable for a governance-critical primitive).
///
/// @dev AUDIT FIX FRESH-2026: H-10 [F-40-VPO-1] — `powerOf` is a LIVE read
///      that can be amplified by flash-stake patterns (stake → vote → unstake
///      in one tx). The lib retains `powerOf` as a deprecated compile-
///      compatible alias for `powerOfLiveUnsafe`. The `LiveUnsafe` suffix
///      surfaces the footgun at every call site.
///
/// @dev AUDIT FIX 2026-05-13 — H-LIB-1 [VPO-DoS] — both reads now:
///        1. Cap inner gas at `RESTAKING_CALL_GAS_BUDGET` (50_000 — matches
///           the in-tree precedent at `RevenueDistributor._restakedPowerAt`).
///           Prevents a malicious or buggy restaking contract from burning
///           the caller's full gas budget (loop-revert grief).
///        2. Use saturating addition. Solidity 0.8 checked arithmetic causes
///           `power + r` to revert with `Panic(0x11)` if `r` is large enough
///           to overflow — and the revert PROPAGATES out of the `try` block
///           (it does NOT fall to `catch`). Saturating to `type(uint256).max`
///           preserves the fail-closed semantics: a hostile return value
///           silently saturates rather than DoS'ing every governance read.
///
///        Without these guards, a captured-admin path could install a
///        malicious restaking contract that bricks `GaugeController.vote`,
///        `VoteIncentives.commitVote/revealVote`, `MemeBountyBoard.*`, and
///        `CommunityGrants.castVote` system-wide.
library VotePowerOracle {
    /// @notice Gas budget for the restaking-side call. Mirrors the in-tree
    ///         `RevenueDistributor._restakedPowerAt` precedent (50k). Sized
    ///         for a single SLOAD + checkpoint lookup + ABI return — generous
    ///         enough for an upgradeable restaking contract with deep proxy
    ///         hops, tight enough that a malicious callee burning gas in a
    ///         loop reverts via OOG without consuming the caller's full budget.
    uint256 internal constant RESTAKING_CALL_GAS_BUDGET = 50_000;
    /// @notice DEPRECATED — compile-compatible alias for `powerOfLiveUnsafe`.
    /// @param user      Address whose voting power to read.
    /// @param staking   TegridyStaking contract address.
    /// @param restaking TegridyRestaking contract address; pass `address(0)` if a
    ///                  consumer was deployed before restaking existed (additive
    ///                  read silently degrades to staking-only — fail closed).
    /// @return power    Sum of staking-side and restaking-side voting power.
    function powerOf(address user, address staking, address restaking)
        internal
        view
        returns (uint256 power)
    {
        return powerOfLiveUnsafe(user, staking, restaking);
    }

    /// @notice AUDIT FIX FRESH-2026: H-10 [F-40-VPO-1] — explicitly-named
    ///         live read. The `LiveUnsafe` suffix surfaces the flash-stake
    ///         amplification footgun at every consumer call site, forcing
    ///         developers to acknowledge the risk before using it.
    ///         Governance-class amount decisions MUST use `powerAt(_, ts)`
    ///         for explicit epoch-pinned reads.
    /// @dev    Both reads pull live state — `block.timestamp` snapshots
    ///         see same-block stakes.
    function powerOfLiveUnsafe(address user, address staking, address restaking)
        internal
        view
        returns (uint256 power)
    {
        power = IVoteSource(staking).votingPowerOf(user);
        // AUDIT FIX 2026-05-14 — regression-scan follow-up (theoretical) —
        // clamp the staking-side baseline at type(uint128).max for symmetry
        // with the restaking-side clamp below. Honest TegridyStaking can't
        // exceed this (Trace208 checkpoints bounded by supply × boost ≈ 5e27
        // << uint128.max ≈ 3.4e38), but if `restaking == address(0)` OR
        // restaking reverts AND staking is ever upgraded/compromised, an
        // unclamped uint128.max+ value would reach consumers and overflow
        // their `votesFor += power` checked arithmetic. Symmetric clamp
        // closes that theoretical path.
        if (power > type(uint128).max) power = type(uint128).max;
        if (restaking != address(0)) {
            // try/catch to remain robust if restaking is mid-upgrade or
            // intentionally absent on a particular deployment chain.
            // `{gas: RESTAKING_CALL_GAS_BUDGET}` bounds inner gas (H-LIB-1).
            try IVoteSource(restaking).votingPowerOf{gas: RESTAKING_CALL_GAS_BUDGET}(user) returns (uint256 r) {
                // Saturating add: a hostile `r` near type(uint256).max would
                // otherwise revert the checked addition and propagate out of
                // the try block, bricking every governance read.
                unchecked {
                    uint256 sum = power + r;
                    // AUDIT FIX 2026-05-14 — regression scan follow-up — saturate
                    // at type(uint128).max rather than type(uint256).max. The
                    // prior ceiling (uint256.max) defeated the read-side DoS in
                    // VotePowerOracle but moved the failure mode downstream:
                    // consumers do `votesFor += power` in CHECKED arithmetic
                    // (CommunityGrants.sol:468, MemeBountyBoard.sol:490-491,
                    // VoteIncentives.sol:712-714). With power == uint256.max,
                    // the SECOND vote overflows and bricks the proposal /
                    // bounty / epoch entirely.
                    //
                    // uint128.max (~3.4e38) is far above any realistic TOWELI
                    // supply (1B × 1e18 = 1e27) so legitimate values are
                    // never clamped. Hostile saturation yields ~uint128.max
                    // per vote, which lets ~uint128 votes accumulate before
                    // overflow — practically impossible (~3.4e38 voters).
                    // Sibling-canonical: Curve veCRV stores `bias` as int128;
                    // Aave V3 `_accruedToTreasury` is uint128 — same ceiling.
                    if (sum < power) {
                        power = type(uint128).max;
                    } else if (sum > type(uint128).max) {
                        power = type(uint128).max;
                    } else {
                        power = sum;
                    }
                }
            } catch {
                // Fail closed: if restaking misbehaves, the staking-side value
                // is still a valid lower bound for governance.
            }
        }
    }

    /// @notice Historical (epoch-pinned) total voting power for `user` at `ts`.
    /// @param user      Address whose voting power to read.
    /// @param ts        Snapshot timestamp (typically epochStart - 1 to exclude
    ///                  same-block stakes per OZ Trace208 upperLookup semantics).
    /// @param staking   TegridyStaking contract address.
    /// @param restaking TegridyRestaking contract address; pass `address(0)` to skip.
    /// @return power    Sum of staking-side and restaking-side historical power.
    function powerAt(
        address user,
        uint256 ts,
        address staking,
        address restaking
    ) internal view returns (uint256 power) {
        power = IVoteSource(staking).votingPowerAtTimestamp(user, ts);
        // AUDIT FIX 2026-05-14 — 3rd-pass regression scan — symmetric clamp
        // with `powerOfLiveUnsafe` above. Initial batch-16 attempted to apply
        // this via `replace_all` but only matched the live-read site. Now
        // both `powerOf` paths clamp the staking baseline identically.
        if (power > type(uint128).max) power = type(uint128).max;
        if (restaking != address(0)) {
            // AUDIT FIX 2026-05-13 — H-LIB-1 — gas-capped + saturating add.
            // Same defense as `powerOfLiveUnsafe`.
            try IVoteSource(restaking).votingPowerAtTimestamp{gas: RESTAKING_CALL_GAS_BUDGET}(user, ts) returns (uint256 r) {
                unchecked {
                    uint256 sum = power + r;
                    // AUDIT FIX 2026-05-14 — regression scan follow-up — saturate
                    // at type(uint128).max rather than type(uint256).max. The
                    // prior ceiling (uint256.max) defeated the read-side DoS in
                    // VotePowerOracle but moved the failure mode downstream:
                    // consumers do `votesFor += power` in CHECKED arithmetic
                    // (CommunityGrants.sol:468, MemeBountyBoard.sol:490-491,
                    // VoteIncentives.sol:712-714). With power == uint256.max,
                    // the SECOND vote overflows and bricks the proposal /
                    // bounty / epoch entirely.
                    //
                    // uint128.max (~3.4e38) is far above any realistic TOWELI
                    // supply (1B × 1e18 = 1e27) so legitimate values are
                    // never clamped. Hostile saturation yields ~uint128.max
                    // per vote, which lets ~uint128 votes accumulate before
                    // overflow — practically impossible (~3.4e38 voters).
                    // Sibling-canonical: Curve veCRV stores `bias` as int128;
                    // Aave V3 `_accruedToTreasury` is uint128 — same ceiling.
                    if (sum < power) {
                        power = type(uint128).max;
                    } else if (sum > type(uint128).max) {
                        power = type(uint128).max;
                    } else {
                        power = sum;
                    }
                }
            } catch {
                // Fail closed: silent degradation.
            }
        }
    }
}
