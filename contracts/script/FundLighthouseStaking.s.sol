// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {StakingRewards} from "../src/vendor/synthetix-staking-rewards/StakingRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
}

/// @dev Probe interface for build identification. Every getter here is a
///      LighthouseLadder member that the vendored StakingRewards does NOT have,
///      so a staticcall that REVERTS is itself the answer.
interface ILadderProbe {
    function totalBoosted() external view returns (uint256);
    function MIN_STAKE() external view returns (uint256);
    function MIN_BOOST() external view returns (uint256);
    function MIN_BOOST_BPS() external view returns (uint256);
    function BPS() external view returns (uint256);
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
    /// @notice AUDIT FIX 2026-09-04 [LH-01]: refuse to fund a PRE-FIX ladder.
    ///
    /// @dev    `DeployLighthouseLadder` grew L-INV-11/L-INV-12 so a pre-fix BUILD
    ///         cannot be DEPLOYED unnoticed. This script — the step that actually
    ///         moves the money — had no equivalent gate, and it is typed to the
    ///         vendored `StakingRewards`, which has no `MIN_STAKE` to look at.
    ///         Until the registry is repointed after a redeploy, the only ladder
    ///         addresses written down anywhere in this repo are the SIX
    ///         VULNERABLE ones (`bungalows.ts`, `addresses.json`, all
    ///         `"status": "live"`), so the address an operator is most likely to
    ///         paste is exactly the one that must not be funded. The dust-divisor
    ///         theft needs only a funded pool and 3 wei.
    ///         (Same gap logged as C4 in docs/LIGHTHOUSE_AUDIT_2026_09_01.md:96
    ///         and never implemented.)
    ///
    /// @dev    WHY NOT "just require MIN_STAKE": this script funds BOTH families.
    ///         The `lighthouse-*` pools are the plain vendored StakingRewards and
    ///         legitimately have no `MIN_STAKE`, so an unconditional require would
    ///         break funding them. And a PRE-FIX LADDER reverts on `MIN_STAKE()`
    ///         exactly like a plain pool does — that one selector cannot tell the
    ///         dangerous case from the fine one.
    ///
    ///         `totalBoosted()` can. It exists on EVERY ladder build, pre-fix and
    ///         post-fix, and on no plain pool. So:
    ///           totalBoosted() reverts   -> plain StakingRewards       -> allow
    ///           totalBoosted() succeeds  -> a ladder; then MIN_STAKE must
    ///                                       be present and correct     -> else REFUSE
    ///         A pre-fix ladder answers `totalBoosted()` and reverts `MIN_STAKE()`,
    ///         which is precisely the cell this gate rejects.
    /// @return isLadder true when the pool is a (fixed) ladder build.
    function assertFundableBuild(address poolAddr) public view returns (bool isLadder) {
        // A typo'd address with no code would otherwise eat the transfer whole.
        require(poolAddr.code.length > 0, "POOL: not a contract");

        try ILadderProbe(poolAddr).totalBoosted() returns (uint256) {
            isLadder = true;
        } catch {
            return false; // plain vendored StakingRewards — nothing further to check
        }

        uint256 minStake;
        try ILadderProbe(poolAddr).MIN_STAKE() returns (uint256 v) {
            minStake = v;
        } catch {
            revert("POOL: PRE-FIX ladder build (no MIN_STAKE) - refusing to fund, redeploy first");
        }
        require(minStake == 100e18, "POOL: ladder MIN_STAKE moved - not the audited build");

        // Mirrors L-INV-12: the floor and its weight must stay one number.
        require(
            ILadderProbe(poolAddr).MIN_BOOST()
                == (minStake * ILadderProbe(poolAddr).MIN_BOOST_BPS()) / ILadderProbe(poolAddr).BPS(),
            "POOL: MIN_BOOST drifted from MIN_STAKE"
        );
    }

    function run() external {
        address poolAddr = vm.envAddress("POOL");
        uint256 amount = vm.envUint("AMOUNT");
        StakingRewards pool = StakingRewards(poolAddr);

        // Identify the build BEFORE reading anything else off it, and long
        // before the transfer at the bottom of this script.
        bool isLadder = assertFundableBuild(poolAddr);

        IERC20 token = pool.rewardsToken();

        require(amount > 0, "AMOUNT: zero");
        require(address(token) == address(pool.stakingToken()), "not a same-token lighthouse - wrong script");

        uint8 dec = IERC20MetadataLike(address(token)).decimals();
        uint256 duration = pool.rewardsDuration();

        // ---- print-before-sign ------------------------------------------------
        console.log("=== LIGHTHOUSE FUNDING PLAN ===");
        console.log("Pool:               ", poolAddr);
        // The build is the one thing an operator cannot see from the address,
        // and it is the difference between a funded pool and a funded theft.
        if (isLadder) {
            console.log("Build:               LADDER (post-fix: MIN_STAKE 100e18 verified on-chain)");
            console.log("Reminder:            STAKE AN HONEST POSITION BEFORE THIS NOTIFY.");
            console.log("                     MIN_STAKE stops a wei-scale divisor; it cannot stop");
            console.log("                     the first real staker earning the whole emission.");
        } else {
            console.log("Build:               PLAIN StakingRewards (no ladder, no MIN_STAKE)");
        }
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
