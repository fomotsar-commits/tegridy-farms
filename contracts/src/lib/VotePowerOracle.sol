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
///      compatible alias for `powerOfLiveUnsafe`; new consumers MUST use
///      `powerAtNow` (snapshot-based). The `LiveUnsafe` suffix surfaces
///      the footgun at every call site.
/// @dev AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — the catch path on
///      restaking lookup failure previously degraded silently to the
///      staking-only value. The non-view sister functions
///      `powerOfWithEvent` / `powerAtWithEvent` emit
///      `RestakingPowerLookupFailed` so off-chain monitors can distinguish
///      "user hasn't restaked" from "restaking is broken / paused /
///      mid-upgrade". The view variants stay silent for binary-compat
///      with consumer view-paths (Solidity disallows `emit` from `view`).
library VotePowerOracle {
    /// @notice AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — emitted whenever a
    ///         restaking-side lookup reverts on the catch path of the
    ///         non-view variants `powerOfWithEvent` / `powerAtWithEvent`.
    ///         Pre-fix the lib silently degraded to the staking-only value
    ///         with no on-chain trace; off-chain monitors could not
    ///         distinguish "user hasn't restaked" from "restaking is
    ///         broken / paused / mid-upgrade".
    /// @dev    The legacy `powerOf` / `powerAt` / `powerOfLiveUnsafe` /
    ///         `powerAtNow` entry points stay `view` for binary-compat with
    ///         consumer call sites — they CANNOT emit (Solidity rejects
    ///         `emit` and assembly `log*` from `view`). Consumers that
    ///         want the breadcrumb MUST migrate to the non-view variants
    ///         which carry the same semantics plus the event emission.
    event RestakingPowerLookupFailed(address indexed user, uint256 indexed timestamp);

    /// @notice DEPRECATED — compile-compatible alias for `powerOfLiveUnsafe`.
    /// @custom:deprecated AUDIT FIX FRESH-2026: H-10 [F-40-VPO-1] — the
    ///         `powerOf` symbol is retained as a thin alias so consumers
    ///         continue to compile while they migrate. The "LiveUnsafe"
    ///         suffix on the canonical name surfaces the flash-stake
    ///         amplification footgun at every consumer call site. New
    ///         consumers MUST use `powerAtNow(user, staking, restaking)`
    ///         (snapshot-based) for governance-class amount decisions; the
    ///         live read is still appropriate for tie-breaker / min-clamp
    ///         patterns where `min(historical, current)` is the actual
    ///         amount applied.
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
    ///         Governance-class amount decisions MUST use `powerAtNow` (or
    ///         `powerAt(_, ts)` for explicit epoch-pinned reads).
    /// @dev    Both reads pull live state — `block.timestamp` snapshots
    ///         see same-block stakes. For snapshot-safe behavior, use
    ///         `powerAtNow` instead.
    /// @dev    AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — `view` cannot emit;
    ///         consumers that want the silent-fail breadcrumb should use
    ///         the non-view sister `powerOfWithEvent` instead.
    function powerOfLiveUnsafe(address user, address staking, address restaking)
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

    /// @notice AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — non-view sister of
    ///         `powerOfLiveUnsafe` that emits `RestakingPowerLookupFailed`
    ///         on the catch path. Use this from non-view consumer paths
    ///         (vote, claim, participate) where the breadcrumb matters.
    /// @dev    Same semantics as `powerOfLiveUnsafe`; only difference is
    ///         the event emission. Function is non-view because emitting
    ///         an event is technically a state-write per the EVM `LOG*`
    ///         opcode taxonomy; logs are output-only and don't touch
    ///         storage / balances / code.
    function powerOfWithEvent(address user, address staking, address restaking)
        internal
        returns (uint256 power)
    {
        power = IVoteSource(staking).votingPowerOf(user);
        if (restaking != address(0)) {
            try IVoteSource(restaking).votingPowerOf(user) returns (uint256 r) {
                power += r;
            } catch {
                // AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — emit on
                // restaking lookup failure so off-chain monitors can alert.
                emit RestakingPowerLookupFailed(user, block.timestamp);
            }
        }
    }

    /// @notice AUDIT FIX FRESH-2026: H-10 [F-40-VPO-1] — snapshot-based read
    ///         using `block.timestamp - 1` to exclude same-block stakes.
    ///         Matches the OZ Trace208 `upperLookup` convention: a deposit
    ///         at `block.timestamp` is NOT counted because the snapshot is
    ///         pinned just before. This closes the flash-stake amplification
    ///         vector at the lib level — consumers using `powerAtNow` get
    ///         the snapshot-safe read by default.
    /// @param  user      Address whose voting power to read.
    /// @param  staking   TegridyStaking contract address.
    /// @param  restaking TegridyRestaking contract address; pass `address(0)` to skip.
    /// @return power     Sum of staking-side and restaking-side power at
    ///                   `block.timestamp - 1`.
    function powerAtNow(address user, address staking, address restaking)
        internal
        view
        returns (uint256 power)
    {
        // Underflow-safe: every live chain has block.timestamp >= 1 at any
        // post-genesis block, so `block.timestamp - 1` is well-defined.
        return powerAt(user, block.timestamp - 1, staking, restaking);
    }

    /// @notice Historical (epoch-pinned) total voting power for `user` at `ts`.
    /// @param user      Address whose voting power to read.
    /// @param ts        Snapshot timestamp (typically epochStart - 1 to exclude
    ///                  same-block stakes per OZ Trace208 upperLookup semantics).
    /// @param staking   TegridyStaking contract address.
    /// @param restaking TegridyRestaking contract address; pass `address(0)` to skip.
    /// @return power    Sum of staking-side and restaking-side historical power.
    /// @dev    AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — `view` cannot emit;
    ///         consumers that want the silent-fail breadcrumb should use
    ///         the non-view sister `powerAtWithEvent` instead.
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
            } catch {
                // Fail closed: silent degradation. Consumers that need the
                // event should call `powerAtWithEvent`.
            }
        }
    }

    /// @notice AUDIT FIX FRESH-2026: M-35 [F-40-VPO-2] — non-view sister of
    ///         `powerAt` that emits `RestakingPowerLookupFailed` on the
    ///         catch path. Same semantics as `powerAt`; differs only in
    ///         the event emission and the resulting non-view declaration.
    function powerAtWithEvent(
        address user,
        uint256 ts,
        address staking,
        address restaking
    ) internal returns (uint256 power) {
        power = IVoteSource(staking).votingPowerAtTimestamp(user, ts);
        if (restaking != address(0)) {
            try IVoteSource(restaking).votingPowerAtTimestamp(user, ts) returns (uint256 r) {
                power += r;
            } catch {
                emit RestakingPowerLookupFailed(user, ts);
            }
        }
    }
}
