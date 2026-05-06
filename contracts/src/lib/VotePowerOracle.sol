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
library VotePowerOracle {
    /// @notice Live total voting power for `user` summed across staking + restaking.
    /// @param user      Address whose voting power to read.
    /// @param staking   TegridyStaking contract address.
    /// @param restaking TegridyRestaking contract address; pass `address(0)` if a
    ///                  consumer was deployed before restaking existed (additive
    ///                  read silently degrades to staking-only — fail closed).
    /// @return power    Sum of staking-side and restaking-side voting power.
    /// @dev    Defends against staleness: both reads pull live state. For epoch-
    ///         pinned snapshots use `powerAt` instead. Internal — inlined into
    ///         every consumer with no extra deploy footprint.
    function powerOf(address user, address staking, address restaking)
        internal
        view
        returns (uint256 power)
    {
        power = IVoteSource(staking).votingPowerOf(user);
        if (restaking != address(0)) {
            // try/catch to remain robust if restaking is mid-upgrade or
            // intentionally absent on a particular deployment chain.
            try IVoteSource(restaking).votingPowerOf(user) returns (uint256 r) {
                power += r;
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
        if (restaking != address(0)) {
            try IVoteSource(restaking).votingPowerAtTimestamp(user, ts) returns (uint256 r) {
                power += r;
            } catch {}
        }
    }
}
