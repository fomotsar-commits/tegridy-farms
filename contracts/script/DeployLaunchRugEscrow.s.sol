// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {LaunchRugEscrow} from "../src/LaunchRugEscrow.sol";

/// @title  DeployLaunchRugEscrow — build plan item #26, the rug-refund escrow
///
/// @notice The contract lands INERT. `openingsEnabled` is false, so no creator can open an
///         escrow and no launch can be described as insured until the multisig deliberately
///         calls `setOpeningsEnabled(true)`. The clean-release fee is zero and its sink is
///         the zero address, which pins the fee snapshotted into any early escrow at zero
///         even if the dial is touched before the sink is set.
///
/// @dev    Nothing this script does puts venue capital behind an escrow, and nothing it can
///         do later would: principal only ever arrives from a creator's own `open` call and
///         only ever leaves to that creator, to buyers named in a posted root, or to the
///         capped clean-release fee sink. There is no admin withdrawal to misconfigure.
///
/// @dev    Env: WETH (payout fallback only), MULTISIG (owner, 2-step).
contract DeployLaunchRugEscrowScript is Script {
    function run() external {
        address weth = vm.envAddress("WETH");
        address multisig = vm.envAddress("MULTISIG");
        require(weth != address(0), "set WETH");
        require(multisig != address(0), "set MULTISIG");
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(weth.code.length > 0, "WETH has no code");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        LaunchRugEscrow escrow = new LaunchRugEscrow(weth, msg.sender);
        console2.log("LaunchRugEscrow deployed:", address(escrow));
        escrow.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== STATE AT DEPLOY (verify before announcing anything) ===");
        console2.log("  openingsEnabled     :", escrow.openingsEnabled()); // false
        console2.log("  cleanReleaseFeeBps  :", escrow.cleanReleaseFeeBps()); // 0
        console2.log("  feeSink             :", escrow.feeSink()); // 0x0

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Leave openingsEnabled FALSE until the fact sheet renders, for each");
        console2.log("   escrow, (a) every covenant asset / holder set / minBps, (b) the");
        console2.log("   window end, and (c) the refundOracle address by name. The oracle is");
        console2.log("   the one trust assumption in the design; a launch that advertises");
        console2.log("   insurance without naming it is making a claim the chain does not back.");
        console2.log("3. setFeeSink(...) BEFORE setCleanReleaseFee(...) - a fee with a zero");
        console2.log("   sink is snapshotted as zero, so the reverse order silently ships");
        console2.log("   free escrows until the next one is opened.");
        console2.log("4. setOpeningsEnabled(true) last.");
        console2.log("");
        console2.log("Reminder: covenantStatus() returning readable == false is NO DATA.");
        console2.log("Render it as 'cannot read', never as 0% held and never as a green badge.");
    }
}
