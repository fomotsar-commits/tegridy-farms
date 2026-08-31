// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {StakingRewards} from "../src/vendor/synthetix-staking-rewards/StakingRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
}

/// @title  FundLighthouseStaking - the funding ceremony for an EVM lighthouse.
/// @notice Transfer + notify in ONE broadcast, with the SAME-TOKEN LAW enforced
///         in code (VENDOR.md; pinned by StakingRewardsLighthouseTest): the
///         canonical notify guard counts staked principal as fundable balance,
///         so this script computes the true funded headroom
///             headroom = token.balanceOf(pool) - pool.totalSupply()
///         AFTER its own transfer and refuses to notify a reward above it.
///         Funding-last discipline: run this after the pool is registered and
///         announced, in public, and print-before-sign like the Solana ladder.
///
/// @dev    Broadcaster must be the pool's rewardsDistribution (the Safe) - for
///         a Safe, run with --sender and execute the printed calls through the
///         Safe UI instead of broadcasting an EOA transaction. The dry run
///         (no --broadcast) prints the exact plan either way.
///
/// @dev    Env vars:
///           POOL    - the StakingRewards lighthouse
///           AMOUNT  - reward amount in RAW base units (whole-token math is done
///                     off-chain against the printed decimals, the Solana
///                     ceremony's readVerifiedDecimals lesson)
contract FundLighthouseStakingScript is Script {
    function run() external {
        address poolAddr = vm.envAddress("POOL");
        uint256 amount = vm.envUint("AMOUNT");
        StakingRewards pool = StakingRewards(poolAddr);
        IERC20 token = pool.rewardsToken();

        require(amount > 0, "AMOUNT: zero");
        require(address(token) == address(pool.stakingToken()), "not a same-token lighthouse - wrong script");

        uint8 dec = IERC20MetadataLike(address(token)).decimals();
        uint256 duration = pool.rewardsDuration();

        // ---- print-before-sign ------------------------------------------------
        console.log("=== LIGHTHOUSE FUNDING PLAN ===");
        console.log("Pool:               ", poolAddr);
        console.log("Token:              ", address(token));
        console.log("Token decimals:     ", dec);
        console.log("Reward (raw):       ", amount);
        console.log("Staked principal:   ", pool.totalSupply());
        console.log("Pool balance now:   ", token.balanceOf(poolAddr));
        console.log("Rewards duration:   ", duration, "seconds");
        uint256 leftover = block.timestamp < pool.periodFinish()
            ? (pool.periodFinish() - block.timestamp) * pool.rewardRate()
            : 0;
        console.log("Leftover (rolls in):", leftover);
        console.log("Implied rate (raw/s):", (amount + leftover) / duration);
        console.log("Runway ends:        ", block.timestamp + duration, "(unix)");

        vm.startBroadcast();
        // Plain transfer: the broadcaster holds the reward tokens. (transferFrom
        // from self would demand a self-allowance most ERC20s don't grant.)
        require(token.transfer(poolAddr, amount), "reward transfer failed");

        // THE SAME-TOKEN LAW, enforced at the last possible moment before the
        // notify: the funded headroom must cover this reward AND any leftover
        // from a still-running period (the contract rolls leftover into the new
        // rate, and that leftover must remain backed by non-principal balance).
        uint256 headroom = token.balanceOf(poolAddr) - pool.totalSupply();
        require(
            amount + leftover <= headroom,
            "SAME-TOKEN LAW: reward + leftover exceeds balance - totalSupply; over-notifying spends stakers' principal"
        );

        pool.notifyRewardAmount(amount);
        vm.stopBroadcast();

        require(pool.rewardRate() > 0, "F-INV-1: rate still zero after notify");
        require(pool.periodFinish() > block.timestamp, "F-INV-2: no runway started");
        console.log("");
        console.log("FUNDED. periodFinish:", pool.periodFinish());
    }
}
