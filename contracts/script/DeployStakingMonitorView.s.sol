// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";

/// @title  DeployStakingMonitorView — redeploy the staking read sister, pause-aware
/// @notice The live view (`staking-monitor-view` in frontend/scripts/addresses.json) keeps
///         projecting emission while staking is paused, which `getReward` never pays
///         (test/StakingMonitorViewPause_2026_09_17.t.sol). The view is stateless, holds
///         nothing, has no owner, and nothing on-chain calls it, so the fix is a fresh deploy
///         plus a frontend address swap. TegridyStaking is untouched.
///
///         Before anything is sent, the simulation proves the new view is a drop-in against
///         live state: every read it serves must return byte-for-byte what the live view
///         returns, for the first PARITY_IDS token ids. The one exception is `earned` while
///         staking is paused, where the new view must be <= the live one (the live view adds
///         the pause-window projection; that is the bug). Any mismatch aborts the run and
///         nothing is broadcast.
///
/// @dev    No env: both addresses are pinned, because the view's staking reference is
///         immutable and a wrong one is permanent.
///         forge script script/DeployStakingMonitorView.s.sol --rpc-url <mainnet> --account <deployer> --broadcast --verify
contract DeployStakingMonitorViewScript is Script {
    address constant STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D; // addresses.json tegridy-staking
    address constant LIVE_VIEW = 0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC; // addresses.json staking-monitor-view
    uint256 constant PARITY_IDS = 32;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        require(STAKING.code.length > 0, "STAKING has no code");
        require(LIVE_VIEW.code.length > 0, "LIVE_VIEW has no code");

        vm.startBroadcast();
        StakingMonitorView fresh = new StakingMonitorView(STAKING);
        vm.stopBroadcast();

        require(address(fresh.staking()) == STAKING, "wired to the wrong staking contract");
        bool paused = fresh.staking().paused();

        _same(address(fresh), abi.encodeCall(StakingMonitorView.stakeCapUtilizationBps, ()));
        _same(address(fresh), abi.encodeCall(StakingMonitorView.stakeCapHeadroom, ()));
        uint256 withRewards;
        for (uint256 id = 1; id <= PARITY_IDS; ++id) {
            _same(address(fresh), abi.encodeCall(StakingMonitorView.getPosition, (id)));
            uint256 shown = fresh.earned(id);
            uint256 live = StakingMonitorView(LIVE_VIEW).earned(id);
            if (paused) require(shown <= live, "paused: new view shows MORE than the live one");
            else require(shown == live, "running: new view disagrees with the live one");
            if (shown > 0) ++withRewards;
        }
        // A parity check over positions that all read zero proves nothing.
        require(withRewards > 0, "parity covered no position with pending rewards");

        console2.log("StakingMonitorView deployed:", address(fresh));
        console2.log("  staking:", STAKING);
        console2.log("  staking paused at deploy:", paused);
        console2.log("  ids checked against the live view:", PARITY_IDS);
        console2.log("  of which with pending rewards:", withRewards);
        console2.log("");
        console2.log("=== NEXT (operator / agent) ===");
        console2.log("1. STAKING_MONITOR_VIEW_ADDRESS in frontend/src/lib/constants.ts ->", address(fresh));
        console2.log("2. addresses.json staking-monitor-view: new address + this broadcast as evidence;");
        console2.log("   keep the old one as a retired entry. CONTRACTS.md and README.md rows too.");
        console2.log("3. Future TegridyRestaking deploys take this address as STAKING_MONITOR_VIEW.");
    }

    function _same(address fresh, bytes memory call) internal view {
        (bool okNew, bytes memory a) = fresh.staticcall(call);
        (bool okOld, bytes memory b) = LIVE_VIEW.staticcall(call);
        require(okNew && okOld, "a view read reverted");
        require(keccak256(a) == keccak256(b), "new view disagrees with the live one");
    }
}
