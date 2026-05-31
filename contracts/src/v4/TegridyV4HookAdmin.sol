// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  TegridyV4HookAdmin — timelocked param governance for TegridyV4Hook
/// @notice **SKELETON ONLY** — companion to TegridyV4Hook.sol. Lives on the
///         `next-wave/v4-migration` branch awaiting Phase 7.x kickoff.
///
/// @dev    Mirrors the V2 sister-contract pattern (TegridyStakingAdmin,
///         SwapFeeRouterAdmin): owner proposes a change, 48h timelock, then
///         executes. All mutable hook parameters live behind this admin:
///         - protocol fee bps
///         - POL skim fraction
///         - POL mint threshold
///         - JIT `blockNumberOffset` (OZ LiquidityPenaltyHook param)
///         - TWAP truncation cap
///         - oracle observation cardinality
///
/// @dev    The hook itself is IMMUTABLE — no setter on TegridyV4Hook. All
///         param mutations go through `apply*` selectors on the hook gated
///         by `onlyAdmin == this contract`. Same pattern as
///         SwapFeeRouterAdmin → SwapFeeRouter on the V2 side.
contract TegridyV4HookAdmin {
    bool public constant IMPLEMENTATION_ACTIVE = false;
    error SkeletonOnly();

    constructor() {
        revert SkeletonOnly();
    }

    // Param categories (to be implemented at kickoff):
    //
    // 1. Fee parameters
    //    - proposeFeeBps / executeFeeBps / cancelFeeBps
    //    - proposeFeeSplit / execute / cancel (treasury vs stakers vs POL)
    //
    // 2. POL parameters
    //    - proposePOLSkimBps / execute / cancel
    //    - proposePOLMintThreshold / execute / cancel
    //    - proposeJITBlockNumberOffset / execute / cancel (OZ LiquidityPenaltyHook)
    //
    // 3. Oracle parameters
    //    - proposeTruncationCapBps / execute / cancel
    //    - proposeObservationCardinality / execute / cancel
    //
    // 4. Pool-key allowlist
    //    - proposePoolKeyAdd / execute / cancel (whitelist token0/token1/tickSpacing)
    //    - proposePoolKeyRemove / execute / cancel
    //
    // 5. Pause guardian rotation
    //    - setPauseGuardian (instant, owner-only — Aave-style for hot-key compromise)
    //
    // All timelocked entries use the same 48h TimelockAdmin base from
    // contracts/src/base/TimelockAdmin.sol — reuse, don't reinvent.
}
