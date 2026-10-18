// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";

/// @title  FundStakingRelease1 — put TOWELI rewards into the NEW (75%) staking contract
/// @notice Approves exactly the amount and calls `notifyRewardAmount`. The contract then sets
///         its own rate (owner ruling 2026-10-18): this amount plus whatever is still scheduled,
///         spread over a fresh four years. Nothing is paid before the first funding. The same
///         script is every later top-up: each one re-spreads the remainder over four years.
/// @dev    Env (both required, no defaults):
///             NEW_STAKING             the address printed by DeployStakingRelease1
///             STAKING_FUND_TOWELI_WEI amount in TOWELI-wei (1 TOWELI = 1e18), at least 1,000 TOWELI
///         forge script script/FundStakingRelease1.s.sol --rpc-url mainnet \
///           --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E --interactive --broadcast --slow
contract FundStakingRelease1Script is Script {
    address constant OWNER = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant OLD_STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        TegridyStaking staking = TegridyStaking(vm.envAddress("NEW_STAKING"));
        uint256 amount = vm.envUint("STAKING_FUND_TOWELI_WEI");
        require(address(staking) != OLD_STAKING, "that is the OLD staking contract");
        require(staking.EARLY_WITHDRAWAL_PENALTY_BPS() == 7500, "not the 75% staking");
        require(staking.owner() == OWNER, "not owned by the owner");
        require(address(staking.rewardToken()) == TOWELI, "reward token is not TOWELI");
        require(amount >= 1_000e18, "notifyRewardAmount needs at least 1,000 TOWELI");
        require(IERC20(TOWELI).balanceOf(OWNER) >= amount, "owner wallet holds less TOWELI than that");

        vm.startBroadcast();
        require(msg.sender == OWNER, "sender must be the owner 0x14898258122C0740106391E6e8E4F17F3b6d456E");
        IERC20(TOWELI).approve(address(staking), amount);
        staking.notifyRewardAmount(amount);
        vm.stopBroadcast();

        uint256 rate = staking.rewardRate();
        require(staking.periodFinish() == block.timestamp + staking.REWARDS_DURATION(), "schedule not reset to 4 years");
        console2.log("funded (TOWELI):", amount / 1e18);
        console2.log("totalRewardsFunded (TOWELI):", staking.totalRewardsFunded() / 1e18);
        console2.log("reward rate (wei/s):", rate);
        console2.log("paid out per day, to all stakers together (TOWELI):", (rate * 1 days) / 1e18);
        console2.log("schedule ends (unix):", staking.periodFinish());
    }
}
