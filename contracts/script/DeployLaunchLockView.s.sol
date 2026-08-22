// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {LaunchLockView} from "../src/LaunchLockView.sol";

/// @title  DeployLaunchLockView — the read sister for build plan item #28
/// @notice Deploys `LaunchLockView`, the single call the launch scanner and the fact
///         sheets use to read vest + lock status for a token.
///
///         The view has no owner and no setters: both rail addresses are `immutable`.
///         A wrong address here is not a misconfiguration to fix later, it is a permanent
///         read pointed at the wrong contract — and because the view degrades a failed
///         call to `available == false` rather than reverting, a wrong address would
///         present as a permanent, silent "no data" that looks like an ordinary outage.
///         Checking the two constructor args is the whole audit of this contract.
///
/// @dev    Env: VESTING_FACTORY, LOCK_VAULT. Either may be `address(0)` if that rail is
///         not deployed yet, but not both. Deploy this LAST, after both rails exist —
///         a view deployed against a zero address can never be pointed at the rail later.
contract DeployLaunchLockViewScript is Script {
    function run() external {
        address vestingFactory = vm.envOr("VESTING_FACTORY", address(0));
        address lockVault = vm.envOr("LOCK_VAULT", address(0));

        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(vestingFactory != address(0) || lockVault != address(0), "set VESTING_FACTORY and/or LOCK_VAULT");
        // A rail address with no code is the failure this check exists for: the view
        // would deploy happily and then report "unavailable" forever.
        if (vestingFactory != address(0)) {
            require(vestingFactory.code.length > 0, "VESTING_FACTORY has no code");
        }
        if (lockVault != address(0)) {
            require(lockVault.code.length > 0, "LOCK_VAULT has no code");
        }

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        LaunchLockView view_ = new LaunchLockView(vestingFactory, lockVault);
        console2.log("LaunchLockView deployed:", address(view_));
        console2.log("  vestingFactory:", vestingFactory);
        console2.log("  lockVault:", lockVault);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (operator) ===");
        console2.log("1. Set LAUNCH_LOCK_VIEW_ADDRESS in frontend/src/lib/constants.ts ->", address(view_));
        console2.log("2. Consumer contract: a snapshot with vestingSourceAvailable == false");
        console2.log("   or lockSourceAvailable == false is NO DATA. It must render as");
        console2.log("   'unavailable'. NEVER as '0 locked', never as a green badge.");
        if (vestingFactory == address(0)) {
            console2.log("WARNING: vesting rail is address(0). Every snapshot will report");
            console2.log("         vestingSourceAvailable == false, permanently.");
        }
        if (lockVault == address(0)) {
            console2.log("WARNING: lock rail is address(0). Every snapshot will report");
            console2.log("         lockSourceAvailable == false, permanently.");
        }
    }
}
