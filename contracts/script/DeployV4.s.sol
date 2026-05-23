// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @title  DeployV4 — Phase 7.x V4 migration deploy script (SKELETON)
/// @notice Lives on `next-wave/v4-migration` branch.
///         Awaiting Phase 7.x trigger gate (see V4_MIGRATION_PLAN.md).
///
/// @dev    Will deploy:
///           1. TegridyV4Hook via CREATE2 with mined salt (7 permission flags)
///           2. TegridyV4HookAdmin
///           3. Initialize TOWELI/WETH V4 pool with dynamic-fee flag on
///              canonical PoolManager
///           4. Wire pauseGuardian on hook (same address as V2 PAUSE_GUARDIAN)
///           5. Transfer ownership to MULTISIG (same as V2)
///           6. Seed initial POL position from treasury
///
/// @dev    Same 3-multisig discipline as DeployMVP.s.sol:
///           - TREASURY env var (signs POL seed)
///           - MULTISIG env var (becomes hook + admin owner)
///           - PAUSE_GUARDIAN env var (hot multisig)
///           - Disjoint check enforced at deploy
contract DeployV4Script is Script {

    /// @notice Implementation status: skeleton only. Reverts on run().
    bool public constant IMPLEMENTATION_ACTIVE = false;

    error NotYetImplemented();

    function run() external pure {
        // Implementation outline (executed at Phase 7.x kickoff):
        //
        // 1. Read env: TREASURY, MULTISIG, PAUSE_GUARDIAN, POOL_MANAGER,
        //              POSITION_MANAGER, UNIVERSAL_ROUTER (canonical Uniswap addresses per chain)
        //
        // 2. Assert 3-multisig disjoint (same as DeployMVP.s.sol)
        //
        // 3. Mine TegridyV4Hook address via HookMiner.find(...) with expected flags:
        //      AFTER_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY
        //      | BEFORE_SWAP | AFTER_SWAP
        //      | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA
        //
        // 4. Deploy TegridyV4Hook via CREATE2 with mined salt
        //
        // 5. Validate Hooks.validateHookPermissions(hook, expectedFlags) — fail-loud
        //
        // 6. Deploy TegridyV4HookAdmin and wire onto hook (one-shot, pre-handover)
        //
        // 7. Set pauseGuardian on hook (one-shot, pre-handover)
        //
        // 8. Initialize TOWELI/WETH V4 pool:
        //      - currency0 = address(0) (native ETH) if WETH is currency1, else swap
        //      - dynamic-fee flag (LPFeeLibrary.DYNAMIC_FEE_FLAG) at pool init
        //      - hooks = address(hook)
        //      - tickSpacing = 60 (canonical for 0.3% pools)
        //
        // 9. Seed initial POL position from treasury via PositionManager
        //      - Full-range LP
        //      - Send PositionManager NFT to TREASURY multisig
        //
        // 10. Transfer ownership of hook + admin to MULTISIG (Ownable2Step)
        //
        // 11. Log deployment summary + next steps (acceptOwnership, V2 migration window)
        revert NotYetImplemented();
    }
}
