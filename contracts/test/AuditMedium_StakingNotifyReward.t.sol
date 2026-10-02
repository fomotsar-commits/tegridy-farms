// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";

contract MockTOWELI_NotifyReward is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockJBAC_NotifyReward is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) { _mint(to, _id); return _id++; }
}

/// @title AUDIT M-AUDIT-2026-2 — notifyRewardAmount updateReward hardening
/// @notice Verifies notifyRewardAmount now crystallises the prior accrual
///         interval (advances lastUpdateTime to block.timestamp) before the
///         new tokens land. Without `updateReward`, a notifier-driven
///         funding event recorded against the OLD lastUpdateTime could
///         distort the next _accumulateRewards cycle's per-second rate.
/// @dev    Ported 2026-09-17 from commit 7e8505b0 (branch
///         worktree-agent-aff47b955ab78a378), which never reached trunk; the fix
///         itself did (TegridyStaking.notifyRewardAmount carries `updateReward`).
///         Two changes from the original:
///         - Time is read with `vm.getBlockTimestamp()`. `via_ir = true` folds
///           `block.timestamp` across `vm.warp`, so a bare read after a warp can
///           return the pre-warp value.
///         - Added the reward-pool test below. The two lastUpdateTime tests pin
///           the modifier's side effect, not the property the audit cared about:
///           an edit that only advanced `lastUpdateTime` would pass them while
///           discarding the pre-funding interval's emission.
contract AuditMediumStakingNotifyRewardTest is Test {
    MockTOWELI_NotifyReward token;
    MockJBAC_NotifyReward nft;
    TegridyStaking staking;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    uint256 constant STAKE_AMT = 500_000 ether;
    uint256 constant LOCK_4Y = 4 * 365 days;
    uint256 constant INITIAL_FUNDING = 50_000_000 ether;

    function setUp() public {
        token = new MockTOWELI_NotifyReward();
        nft = new MockJBAC_NotifyReward();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        token.transfer(alice, 5_000_000 ether);
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        // Fund initial rewards.
        staking.notifyRewardAmount(INITIAL_FUNDING);
    }

    /// @dev notifyRewardAmount must crystallise the prior accrual interval —
    ///      lastUpdateTime must equal block.timestamp after the call. Without
    ///      updateReward, lastUpdateTime would stay stale and the next
    ///      _accumulateRewards would over- or under-credit depending on the
    ///      delta between the stale and current timestamp.
    function test_M2026_2_notifyRewardAmount_advances_lastUpdateTime() public {
        // Stake so totalBoostedStake > 0 (otherwise _accumulateRewards short-circuits).
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_4Y);

        uint256 lastBefore = staking.lastUpdateTime();
        // Skip forward to give the prior interval a non-trivial elapsed window.
        vm.warp(vm.getBlockTimestamp() + 1 days);

        // Fund. With updateReward, lastUpdateTime must become block.timestamp.
        staking.notifyRewardAmount(1000 ether);

        assertEq(
            staking.lastUpdateTime(),
            vm.getBlockTimestamp(),
            "AUDIT M-AUDIT-2026-2: lastUpdateTime must be refreshed by updateReward"
        );
        assertGt(staking.lastUpdateTime(), lastBefore, "lastUpdateTime must have advanced");
    }

    /// @dev With totalBoostedStake == 0, updateReward is a no-op for
    ///      rewardPerTokenStored but lastUpdateTime still advances.
    function test_M2026_2_notifyRewardAmount_advances_time_even_with_no_stakers() public {
        uint256 lastBefore = staking.lastUpdateTime();
        vm.warp(vm.getBlockTimestamp() + 1 days);

        staking.notifyRewardAmount(1000 ether);

        assertEq(
            staking.lastUpdateTime(),
            vm.getBlockTimestamp(),
            "lastUpdateTime advances even with no stakers"
        );
        assertGt(staking.lastUpdateTime(), lastBefore, "advanced from lastBefore");
    }

    /// @dev The property itself: emission for the interval BEFORE a funding event is
    ///      capped by the pool that existed during that interval. Without the modifier,
    ///      a claim landing after the notify measures the whole elapsed window against
    ///      the post-funding balance, so the notifier can back-run its own funding.
    function test_M2026_2_notifyRewardAmount_capsPriorIntervalAtPreFundingPool() public {
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_4Y);
        uint256 tokenId = staking.userTokenId(alice);

        // Let emission outrun the funded pool, so the pool cap is what bounds accrual.
        vm.warp(vm.getBlockTimestamp() + 600 days);

        uint256 prePool =
            token.balanceOf(address(staking)) - staking.totalStaked() - staking.totalUnsettledRewards();
        uint256 owed = (vm.getBlockTimestamp() - staking.lastUpdateTime()) * staking.rewardRate();
        // Rig check: if the cap does not bind, the fixed and unfixed contracts pay the same.
        assertGt(owed, prePool, "rig: elapsed emission must exceed the pre-funding pool");
        assertLe(owed, prePool + INITIAL_FUNDING, "rig: the new funding must be able to cover it");

        staking.notifyRewardAmount(INITIAL_FUNDING);

        // Same block: a claim right behind the funding.
        uint256 balBefore = token.balanceOf(alice);
        vm.prank(alice); uint256 claimed = staking.getReward(tokenId);
        assertEq(token.balanceOf(alice) - balBefore, claimed, "claim return matches transfer");

        assertLe(claimed, prePool, "AUDIT M-AUDIT-2026-2: pre-funding interval paid beyond the pre-funding pool");
        // Rounding in rewardPerTokenStored loses at most a few wei per unit of boosted stake.
        assertApproxEqAbs(claimed, prePool, 1e9, "pre-funding interval's capped emission must still be paid");
    }
}
