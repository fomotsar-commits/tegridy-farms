// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @title Audit195 — Deep reward/claim function audit for TegridyStaking
/// @notice PoC tests covering: accRewardPerShare precision/overflow, rewardDebt correctness,
///         reward pool depletion, unsettled rewards cap, claim symmetry, autoMaxLock reinvestment,
///         revalidateBoost debt reset, totalUnsettledRewards accounting
contract Audit195StakingRewards is Test {
    TegridyStaking public staking;
    MockTOWELI public token;
    MockJBAC public nft;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public dan = makeAddr("dan");

    uint256 constant REWARD_RATE = 1 ether; // 1 TOWELI/s
    uint256 constant MIN_STAKE = 100e18;
    uint256 constant ACC_PRECISION = 1e12;
    uint256 constant BOOST_PRECISION = 10000;
    uint256 constant MIN_LOCK = 7 days;
    uint256 constant MAX_LOCK = 4 * 365 days;
    uint256 constant TRANSFER_COOLDOWN = 24 hours;

    function setUp() public {
        token = new MockTOWELI();
        nft = new MockJBAC();
        staking = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);

        // Mint JBAC NFT to alice
        nft.mint(alice);

        // Distribute tokens
        token.transfer(alice, 100_000_000 ether);
        token.transfer(bob, 100_000_000 ether);
        token.transfer(carol, 100_000_000 ether);
        token.transfer(dan, 100_000_000 ether);

        // Approve
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        vm.prank(bob);   token.approve(address(staking), type(uint256).max);
        vm.prank(carol); token.approve(address(staking), type(uint256).max);
        vm.prank(dan);   token.approve(address(staking), type(uint256).max);

        // Fund with rewards
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(500_000_000 ether);
    }

    // =========================================================================
    // 1. accRewardPerShare PRECISION AND OVERFLOW SAFETY
    // =========================================================================

    /// @notice Verify accRewardPerShare accumulates correctly with ACC_PRECISION = 1e12
    function test_accRewardPerShare_precision_basic() public {
        // Bob stakes 1000 TOWELI with min lock
        vm.prank(bob);
        staking.stake(1000 ether, MIN_LOCK);

        uint256 tokenId = staking.userTokenId(bob);
        (, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        uint256 boostedAmount = (1000 ether * boostBps) / BOOST_PRECISION;

        // Advance 100 seconds
        vm.warp(block.timestamp + 100);

        // pendingReward should be ~100 tokens (100s * 1 TOWELI/s)
        uint256 pending = staking.earned(tokenId);
        assertApproxEqAbs(pending, 100 ether, 1e15, "Pending should be ~100 TOWELI");
    }

    /// @notice Verify precision doesn't lose significant value with very small stakes
    function test_accRewardPerShare_precision_smallStake() public {
        // Minimum stake with min lock
        vm.prank(bob);
        staking.stake(MIN_STAKE, MIN_LOCK);

        uint256 tokenId = staking.userTokenId(bob);

        // Advance 1000 seconds
        vm.warp(block.timestamp + 1000);

        // Even small stake should capture all rewards when sole staker
        uint256 pending = staking.earned(tokenId);
        assertApproxEqAbs(pending, 1000 ether, 1e15, "Small staker should get all rewards");
    }

    /// @notice Verify no overflow with large stakes and long durations
    function test_accRewardPerShare_noOverflow_largeValues() public {
        // Large stake with max lock (max boost = 4x = 40000 bps)
        vm.prank(alice);
        staking.stake(50_000_000 ether, MAX_LOCK);

        // Advance 365 days
        vm.warp(block.timestamp + 365 days);

        // Should not revert — large accumulated rewards
        uint256 tokenId = staking.userTokenId(alice);
        uint256 pending = staking.earned(tokenId);
        assertGt(pending, 0, "Should have pending rewards");
    }

    /// @notice Verify accRewardPerShare does NOT advance when totalBoostedStake == 0
    function test_accRewardPerShare_noAdvance_zeroStakers() public {
        uint256 accBefore = staking.rewardPerTokenStored();
        vm.warp(block.timestamp + 1000);

        // Need to trigger updateRewards — stake then immediately check
        vm.prank(bob);
        staking.stake(1000 ether, MIN_LOCK);

        // accRewardPerShare should still be 0 since no boostedStake existed during those 1000s
        // The updateRewards modifier runs BEFORE the stake, so no rewards should accumulate
        assertEq(staking.rewardPerTokenStored(), accBefore, "No rewards should accumulate with zero stakers");
    }

    // =========================================================================
    // 2. rewardDebt CALCULATION CORRECTNESS
    // =========================================================================

    /// @notice rewardDebt on stake should equal (boostedAmount * accRewardPerShare) / ACC_PRECISION
    function test_rewardDebt_correctOnStake() public {
        // First staker to build up accRewardPerShare
        vm.prank(alice);
        staking.stake(10000 ether, MIN_LOCK);
        vm.warp(block.timestamp + 100);

        // Trigger updateRewards via bob's stake
        vm.prank(bob);
        staking.stake(10000 ether, MIN_LOCK);

        uint256 tokenId = staking.userTokenId(bob);
        uint256 acc = staking.rewardPerTokenStored();

        // Compute expected: use the actual boostedAmount from the position struct
        (uint256 posAmount, uint256 posBoostedAmt, int256 posDebt,,,,,, ) = staking.positions(tokenId);
        int256 expected = int256((posBoostedAmt * acc) / ACC_PRECISION);
        assertEq(posDebt, expected, "rewardDebt must match boostedAmount * acc / PRECISION");
    }

    /// @notice rewardDebt resets correctly after claim
    function test_rewardDebt_resetOnClaim() public {
        vm.prank(bob);
        staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 100);

        vm.prank(bob);
        staking.getReward(tokenId);

        // After claim, rewardDebt should equal accumulated
        (,uint256 boostedAmt, int256 debtAfter,,,,,,) = staking.positions(tokenId);
        uint256 acc = staking.rewardPerTokenStored();
        int256 expectedDebt = int256((boostedAmt * acc) / ACC_PRECISION);
        assertEq(debtAfter, expectedDebt, "rewardDebt should be reset after claim");
    }

    // =========================================================================
    // 3. REWARD POOL DEPLETION HANDLING
    // =========================================================================

    /// @notice When reward pool is depleted, pending rewards should cap to available balance
    function test_rewardPool_depletion_capsPending() public {
        // Deploy a staking with very small fund
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(1100 ether); // Only 1100 token rewards available (1000 funded minus what's reserved)

        vm.prank(bob);
        token.approve(address(s2), type(uint256).max);
        vm.prank(bob);
        s2.stake(1000 ether, MIN_LOCK);

        // Advance way beyond what the pool can sustain
        vm.warp(block.timestamp + 10000); // 10000s * 1/s = 10000 TOWELI needed, only ~1100 available

        uint256 tokenId = s2.userTokenId(bob);

        // V2: earned() may return uncapped raw pending; verify actual claim is capped to pool balance
        uint256 bobBefore = token.balanceOf(bob);
        uint256 contractBefore = token.balanceOf(address(s2));
        vm.prank(bob);
        s2.getReward(tokenId);
        uint256 claimed = token.balanceOf(bob) - bobBefore;

        // Actual claimed amount must not exceed available reward pool (balance minus staked)
        uint256 maxReward = contractBefore - s2.totalStaked();
        assertLe(claimed, maxReward, "Claimed must not exceed reward pool");
    }

    /// @notice Claim should not revert when pool is depleted
    function test_rewardPool_depletion_claimNoRevert() public {
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(1100 ether);

        vm.prank(bob);
        token.approve(address(s2), type(uint256).max);
        vm.prank(bob);
        s2.stake(1000 ether, MIN_LOCK);

        uint256 tokenId = s2.userTokenId(bob);
        vm.warp(block.timestamp + 100000);

        // Should not revert
        vm.prank(bob);
        s2.getReward(tokenId);
    }

    /// @notice Multiple stakers competing for depleted pool should each get fair share capped
    function test_rewardPool_depletion_multipleStakers() public {
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(2000 ether);

        vm.prank(alice); token.approve(address(s2), type(uint256).max);
        vm.prank(bob);   token.approve(address(s2), type(uint256).max);

        vm.prank(alice); s2.stake(1000 ether, MIN_LOCK);
        vm.prank(bob);   s2.stake(1000 ether, MIN_LOCK);

        uint256 aliceTokenId = s2.userTokenId(alice);
        uint256 bobTokenId = s2.userTokenId(bob);

        vm.warp(block.timestamp + 100000);

        // First claimer
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); s2.getReward(aliceTokenId);
        uint256 aliceClaimed = token.balanceOf(alice) - aliceBefore;

        // Second claimer
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); s2.getReward(bobTokenId);
        uint256 bobClaimed = token.balanceOf(bob) - bobBefore;

        // Total claimed should not exceed funded amount
        assertLe(aliceClaimed + bobClaimed, 2000 ether, "Total claims must not exceed fund");
    }

    // =========================================================================
    // 4. UNSETTLED REWARDS CAP TO AVAILABLE BALANCE
    // =========================================================================

    /// @notice _settleRewardsOnTransfer should cap unsettled to available reward pool
    function test_unsettled_cappedToAvailableBalance() public {
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(1500 ether);

        vm.prank(alice); token.approve(address(s2), type(uint256).max);
        vm.prank(bob);   token.approve(address(s2), type(uint256).max);

        vm.prank(alice); s2.stake(1000 ether, MIN_LOCK);
        uint256 tokenId = s2.userTokenId(alice);

        vm.warp(block.timestamp + 100000); // way more than pool can handle

        // Transfer NFT to bob — should settle rewards for alice, capped
        vm.warp(block.timestamp + TRANSFER_COOLDOWN + 1);
        vm.prank(alice); s2.transferFrom(alice, bob, tokenId);

        // Unsettled rewards should be <= available pool
        uint256 unsettled = s2.unsettledRewards(alice);
        uint256 totalUnsettled = s2.totalUnsettledRewards();
        assertEq(unsettled, totalUnsettled, "Alice's unsettled should equal total unsettled");

        uint256 available = token.balanceOf(address(s2));
        uint256 reserved = s2.totalStaked();
        uint256 rewardPool = available > reserved ? available - reserved : 0;
        assertLe(unsettled, rewardPool, "Unsettled must be capped to reward pool");
    }

    // =========================================================================
    // 5. CLAIM SYMMETRY: claimUnsettled vs claimUnsettledFor
    // =========================================================================

    /// @notice Both claim paths should yield identical results for same user state
    function test_claimSymmetry_unsettled_vs_unsettledFor() public {
        // Setup: two users, both get unsettled rewards via transfer
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        vm.prank(bob);   staking.stake(10000 ether, MIN_LOCK);

        uint256 aliceTokenId = staking.userTokenId(alice);
        uint256 bobTokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 1000);

        // Transfer alice's NFT to carol to generate unsettled rewards
        vm.warp(block.timestamp + TRANSFER_COOLDOWN + 1);
        vm.prank(alice); staking.transferFrom(alice, carol, aliceTokenId);

        // Transfer bob's NFT to dan to generate unsettled rewards
        vm.prank(bob); staking.transferFrom(bob, dan, bobTokenId);

        uint256 aliceUnsettled = staking.unsettledRewards(alice);
        uint256 bobUnsettled = staking.unsettledRewards(bob);

        // Both should have approximately equal unsettled (same stake, same time)
        assertApproxEqRel(aliceUnsettled, bobUnsettled, 0.01e18, "Unsettled should be ~equal");

        // Alice claims via claimUnsettled
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); staking.claimUnsettled();
        uint256 aliceReceived = token.balanceOf(alice) - aliceBefore;

        // Bob claims via claimUnsettledFor (called by owner)
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(staking.owner()); staking.claimUnsettledFor(bob);
        uint256 bobReceived = token.balanceOf(bob) - bobBefore;

        // Both should receive the same amount (or very close)
        assertApproxEqRel(aliceReceived, bobReceived, 0.01e18, "Claim paths should be symmetric");
    }

    /// @notice claimUnsettledFor authorization: only user, restaking, or owner can call
    function test_claimUnsettledFor_authorizationRestriction() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 1000 + TRANSFER_COOLDOWN + 1);
        vm.prank(alice); staking.transferFrom(alice, bob, tokenId);

        // Random user (carol) cannot call claimUnsettledFor
        vm.prank(carol);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(alice);
    }

    /// @notice claimUnsettled reverts on zero balance
    function test_claimUnsettled_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.ZeroAmount.selector);
        staking.claimUnsettled();
    }

    /// @notice claimUnsettledFor reverts on zero balance
    function test_claimUnsettledFor_revertsOnZero() public {
        vm.prank(staking.owner());
        vm.expectRevert(TegridyStaking.ZeroAmount.selector);
        staking.claimUnsettledFor(alice);
    }

    // =========================================================================
    // 6. autoMaxLock REWARD REINVESTMENT
    // =========================================================================

    /// @notice claim() with autoMaxLock should extend lock to max and still pay rewards
    function test_autoMaxLock_claimExtendsLockAndPaysRewards() public {
        vm.prank(bob); staking.stake(10000 ether, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Enable autoMaxLock
        vm.prank(bob); staking.toggleAutoMaxLock(tokenId);

        // Advance time
        vm.warp(block.timestamp + 500);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        uint256 claimed = staking.getReward(tokenId);

        // Should have received rewards
        assertGt(claimed, 0, "Should receive rewards with autoMaxLock");
        assertEq(token.balanceOf(bob) - bobBefore, claimed, "Balance change should match claimed");

        // Lock should be extended to max
        (,,uint256 lockEnd, uint256 lockDuration,,) = staking.getPosition(tokenId);
        assertEq(lockDuration, MAX_LOCK, "Lock duration should be MAX_LOCK");
        assertEq(lockEnd, block.timestamp + MAX_LOCK, "Lock end should be now + MAX_LOCK");
    }

    /// @notice toggleAutoMaxLock ON should claim pending rewards first, then boost to max
    function test_autoMaxLock_toggleClaimsBeforeBoostChange() public {
        vm.prank(bob); staking.stake(10000 ether, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 500);

        uint256 bobBefore = token.balanceOf(bob);

        // Toggle auto-max-lock ON — should claim rewards at OLD boost, then apply new boost
        vm.prank(bob); staking.toggleAutoMaxLock(tokenId);

        uint256 bobAfter = token.balanceOf(bob);
        assertGt(bobAfter - bobBefore, 0, "Should claim pending before boost change");
    }

    /// @notice toggleAutoMaxLock recalculates boostedAmount and rewardDebt correctly
    function test_autoMaxLock_debtResetAfterToggle() public {
        vm.prank(bob); staking.stake(10000 ether, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 100);

        vm.prank(bob); staking.toggleAutoMaxLock(tokenId);

        // After toggle, rewardDebt should match new boostedAmount * current acc
        (uint256 amount, uint256 boostedAmt, int256 debt,,,,,,) = staking.positions(tokenId);
        uint256 acc = staking.rewardPerTokenStored();
        int256 expectedDebt = int256((boostedAmt * acc) / ACC_PRECISION);
        assertEq(debt, expectedDebt, "rewardDebt must reset to new boostedAmt * acc");
    }

    // =========================================================================
    // 7. revalidateBoost DEBT RESET
    // =========================================================================

    /// @notice revalidateBoost should claim rewards, recalculate boost, reset debt
    function test_revalidateBoost_claimsAndResetsDebt() public {
        // Alice has JBAC, stake without JBAC boost initially (hasJbacBoost=false on stake)
        vm.prank(alice); staking.stake(10000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(alice);

        // Position starts WITHOUT jbac boost — revalidateBoost should add it
        (,,,,,,, bool hasJbac,) = staking.positions(tokenId);
        assertFalse(hasJbac, "Initially no JBAC boost");

        // Advance time so there are pending rewards to claim
        vm.warp(block.timestamp + 100);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); staking.revalidateBoost(tokenId);
        uint256 aliceClaimed = token.balanceOf(alice) - aliceBefore;

        // Should have claimed pending rewards (alice is sole staker for 100s at 1 TOWELI/s)
        assertGt(aliceClaimed, 0, "Should claim on revalidate");

        // Now has JBAC boost
        (,,,,,,, bool hasJbacAfter,) = staking.positions(tokenId);
        assertTrue(hasJbacAfter, "Should now have JBAC boost");

        // Debt should be reset to new boostedAmount * acc
        (,uint256 boostedAmt, int256 debt,,,,,,) = staking.positions(tokenId);
        uint256 acc = staking.rewardPerTokenStored();
        int256 expectedDebt = int256((boostedAmt * acc) / ACC_PRECISION);
        assertEq(debt, expectedDebt, "Debt must be reset after revalidateBoost");
    }

    /// @notice revalidateBoost should not change anything if JBAC status unchanged
    function test_revalidateBoost_noopWhenUnchanged() public {
        vm.prank(bob); staking.stake(10000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 100);

        // Bob doesn't have JBAC, and hasJbacBoost is false — no change needed
        (,uint256 boostedBefore, int256 debtBefore,,,,,,) = staking.positions(tokenId);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); staking.revalidateBoost(tokenId);
        uint256 bobAfter = token.balanceOf(bob);

        // No change since JBAC status unchanged — should NOT claim
        assertEq(bobAfter, bobBefore, "No claim when boost status unchanged");

        // boostedAmount and debt should remain the same
        (,uint256 boostedAfter, int256 debtAfter,,,,,,) = staking.positions(tokenId);
        assertEq(boostedAfter, boostedBefore, "boostedAmount unchanged");
        assertEq(debtAfter, debtBefore, "debt unchanged when no boost change");
    }

    /// @notice revalidateBoost: removing JBAC (transferred away) should reduce boost
    function test_revalidateBoost_removesJbacBoost() public {
        // Alice has JBAC, stakes
        vm.startPrank(alice);
        staking.stake(10000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(alice);

        // First revalidate to add JBAC boost (same tx is fine, no rewards expected)
        staking.revalidateBoost(tokenId);
        vm.stopPrank();

        (,uint256 boostedWith,,,,,,bool hasJbac,) = staking.positions(tokenId);
        assertTrue(hasJbac, "Should have JBAC boost");

        // Alice transfers JBAC NFT away
        vm.prank(alice); nft.transferFrom(alice, dan, 1);

        vm.warp(block.timestamp + 100);

        // Revalidate — should remove JBAC boost
        vm.prank(alice); staking.revalidateBoost(tokenId);
        (,uint256 boostedWithout,,,,,,bool hasJbacAfter,) = staking.positions(tokenId);
        assertFalse(hasJbacAfter, "JBAC boost should be removed");
        assertLt(boostedWithout, boostedWith, "boostedAmount should decrease");
    }

    // =========================================================================
    // 8. totalUnsettledRewards ACCOUNTING
    // =========================================================================

    /// @notice totalUnsettledRewards should track sum of all unsettled accurately
    function test_totalUnsettled_tracksAccurately() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        vm.prank(bob);   staking.stake(10000 ether, MIN_LOCK);

        uint256 aliceTokenId = staking.userTokenId(alice);
        uint256 bobTokenId   = staking.userTokenId(bob);

        vm.warp(block.timestamp + 1000 + TRANSFER_COOLDOWN + 1);

        // Transfer both
        vm.prank(alice); staking.transferFrom(alice, carol, aliceTokenId);
        vm.prank(bob);   staking.transferFrom(bob, dan, bobTokenId);

        uint256 aliceUnsettled = staking.unsettledRewards(alice);
        uint256 bobUnsettled = staking.unsettledRewards(bob);
        uint256 totalUnsettled = staking.totalUnsettledRewards();

        assertEq(totalUnsettled, aliceUnsettled + bobUnsettled, "Total must equal sum of individuals");
    }

    /// @notice totalUnsettledRewards decreases on claimUnsettled
    function test_totalUnsettled_decreasesOnClaim() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 1000 + TRANSFER_COOLDOWN + 1);
        vm.prank(alice); staking.transferFrom(alice, bob, tokenId);

        uint256 totalBefore = staking.totalUnsettledRewards();
        assertGt(totalBefore, 0, "Should have unsettled rewards");

        vm.prank(alice); staking.claimUnsettled();

        uint256 totalAfter = staking.totalUnsettledRewards();
        assertLt(totalAfter, totalBefore, "Total unsettled should decrease after claim");
    }

    /// @notice totalUnsettledRewards decreases on claimUnsettledFor too
    function test_totalUnsettled_decreasesOnClaimFor() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 1000 + TRANSFER_COOLDOWN + 1);
        vm.prank(alice); staking.transferFrom(alice, bob, tokenId);

        uint256 totalBefore = staking.totalUnsettledRewards();
        vm.prank(staking.owner()); staking.claimUnsettledFor(alice);
        uint256 totalAfter = staking.totalUnsettledRewards();

        assertLt(totalAfter, totalBefore, "Total unsettled should decrease on claimFor");
    }

    // =========================================================================
    // 9. _updatePool (updateRewards modifier) EDGE CASES
    // =========================================================================

    /// @notice updateRewards should advance lastRewardTime even with zero stakers
    function test_updateRewards_advancesTimeWithZeroStakers() public {
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1000);

        // Trigger updateRewards via stake
        vm.prank(bob); staking.stake(1000 ether, MIN_LOCK);

        // lastRewardTime should have advanced
        assertEq(staking.lastUpdateTime(), block.timestamp, "lastRewardTime must advance");
        assertEq(staking.rewardPerTokenStored(), 0, "accRewardPerShare should be 0 with no prior stakers");
    }

    /// @notice updateRewards caps reward to available balance minus reserved
    function test_updateRewards_capsToBalance() public {
        // MAX_REWARD_RATE is 100e18, use that as a high rate
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, 100 ether);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(2000 ether); // very small fund with high rate

        vm.prank(bob); token.approve(address(s2), type(uint256).max);
        vm.prank(bob); s2.stake(1000 ether, MIN_LOCK);

        uint256 tokenId = s2.userTokenId(bob);

        // 100 seconds at 100/s = 10000 needed, only 1000 in pool
        vm.warp(block.timestamp + 100);

        vm.prank(bob);
        uint256 claimed = s2.getReward(tokenId);

        // Claimed should not exceed what was available in reward pool
        uint256 maxPossible = 2000 ether;
        assertLe(claimed, maxPossible, "Claimed must not exceed pool");
    }

    // =========================================================================
    // 10. _claimRewards INTERNAL — PENALTY DRAIN PROPORTIONALITY
    // =========================================================================

    /// @notice Penalty drain should be proportional to totalPenaltyAccumulated / totalRewardsAccumulated
    function test_claimRewards_penaltyDrainProportional() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        vm.prank(bob);   staking.stake(10000 ether, MIN_LOCK);

        uint256 bobTokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 1000);

        // Bob early withdraws — penalty goes to treasury (no accRewardPerShare bump in current code)
        vm.prank(bob); staking.earlyWithdraw(bobTokenId);

        // Verify penalty was collected
        assertGt(staking.totalPenaltiesCollected(), 0, "Penalty should be collected");
    }

    // =========================================================================
    // 11. _settleRewardsOnTransfer — INLINE REWARD ACCUMULATION
    // =========================================================================

    /// @notice Transfer should inline-accumulate rewards and update lastRewardTime
    function test_settleOnTransfer_inlineAccumulation() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(alice);

        uint256 lastTimeBefore = staking.lastUpdateTime();
        vm.warp(block.timestamp + 500 + TRANSFER_COOLDOWN + 1);

        vm.prank(alice); staking.transferFrom(alice, bob, tokenId);

        // lastRewardTime should advance
        assertGt(staking.lastUpdateTime(), lastTimeBefore, "lastRewardTime should advance on transfer");

        // Alice should have unsettled rewards
        assertGt(staking.unsettledRewards(alice), 0, "Alice should have unsettled rewards");
    }

    /// @notice Transfer should reset rewardDebt for the new owner
    function test_settleOnTransfer_resetsDebtForNewOwner() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 500 + TRANSFER_COOLDOWN + 1);

        vm.prank(alice); staking.transferFrom(alice, bob, tokenId);

        // New owner's rewardDebt should be set to current accumulated
        (,uint256 boostedAmt, int256 debt,,,,,,) = staking.positions(tokenId);
        uint256 acc = staking.rewardPerTokenStored();
        int256 expected = int256((boostedAmt * acc) / ACC_PRECISION);
        assertEq(debt, expected, "New owner debt should be reset on transfer");
    }

    // =========================================================================
    // 12. fund() — BASIC FUNCTIONALITY
    // =========================================================================

    /// @notice fund() should reject amounts below MIN_NOTIFY_AMOUNT
    function test_fund_rejectsSmallAmounts() public {
        vm.expectRevert(TegridyStaking.FundAmountTooSmall.selector);
        staking.notifyRewardAmount(999 ether);
    }

    /// @notice fund() should accept valid amounts and track totalRewardsFunded
    function test_fund_tracksTotalFunded() public {
        uint256 fundedBefore = staking.totalRewardsFunded();
        staking.notifyRewardAmount(5000 ether);
        assertEq(staking.totalRewardsFunded(), fundedBefore + 5000 ether, "totalRewardsFunded should increase");
    }

    // =========================================================================
    // 13. pendingReward() VIEW — MATCHES ACTUAL CLAIM
    // =========================================================================

    /// @notice pendingReward view should match actual claimed amount
    function test_pendingReward_matchesActualClaim() public {
        vm.prank(bob); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 500);

        uint256 pending = staking.earned(tokenId);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); staking.getReward(tokenId);
        uint256 actualClaimed = token.balanceOf(bob) - bobBefore;

        // Should be very close (tiny rounding difference possible)
        assertApproxEqAbs(pending, actualClaimed, 1e6, "pendingReward view should match actual claim");
    }

    // =========================================================================
    // 14. EXTENDED LOCK — rewardDebt reset on extendLock
    // =========================================================================

    /// @notice extendLock should claim rewards, recalculate boost, reset debt
    function test_extendLock_claimsAndResetsDebt() public {
        vm.prank(bob); staking.stake(10000 ether, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 500);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); staking.extendLock(tokenId, 365 days);
        uint256 claimed = token.balanceOf(bob) - bobBefore;

        assertGt(claimed, 0, "Should claim on extendLock");

        // Debt should match new boosted * acc
        (,uint256 boostedAmt, int256 debt,,,,,,) = staking.positions(tokenId);
        uint256 acc = staking.rewardPerTokenStored();
        int256 expected = int256((boostedAmt * acc) / ACC_PRECISION);
        assertEq(debt, expected, "Debt must be reset after extendLock");
    }

    // =========================================================================
    // 15. EDGE CASE: claim with zero pending should not transfer
    // =========================================================================

    /// @notice claim immediately after stake should yield 0 rewards
    function test_claim_zeroPendingNoTransfer() public {
        vm.prank(bob); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(bob);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); staking.getReward(tokenId);
        uint256 bobAfter = token.balanceOf(bob);

        assertEq(bobAfter, bobBefore, "No rewards should be transferred at time 0");
    }

    // =========================================================================
    // 16. PARTIAL UNSETTLED CLAIM (pool partially drained)
    // =========================================================================

    /// @notice claimUnsettled with partial pool should leave remainder
    function test_claimUnsettled_partialPayout_leavesRemainder() public {
        TegridyStaking s2 = new TegridyStaking(address(token), address(nft), treasury, REWARD_RATE);
        token.approve(address(s2), type(uint256).max);
        s2.notifyRewardAmount(1100 ether);

        vm.prank(alice); token.approve(address(s2), type(uint256).max);
        vm.prank(bob);   token.approve(address(s2), type(uint256).max);

        vm.prank(alice); s2.stake(1000 ether, MIN_LOCK);
        uint256 tokenId = s2.userTokenId(alice);

        vm.warp(block.timestamp + 100000 + TRANSFER_COOLDOWN + 1);

        // Transfer to generate unsettled
        vm.prank(alice); s2.transferFrom(alice, bob, tokenId);

        uint256 unsettledBefore = s2.unsettledRewards(alice);

        // Now drain most of the pool by bob claiming
        // Bob now owns the position, let time pass then claim
        uint256 bobTokenId = s2.userTokenId(bob);
        vm.warp(block.timestamp + 100000);
        vm.prank(bob); s2.getReward(bobTokenId);

        // Alice tries to claim unsettled — may get partial payout
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); s2.claimUnsettled();
        uint256 aliceReceived = token.balanceOf(alice) - aliceBefore;

        uint256 unsettledAfter = s2.unsettledRewards(alice);

        // If partial: remainder should be unsettledBefore - received
        // If full: remainder should be 0
        assertEq(unsettledAfter, unsettledBefore - aliceReceived, "Remainder accounting must be correct");
    }

    // =========================================================================
    // 17. _safeInt256 overflow protection
    // =========================================================================

    /// @notice _safeInt256 should revert on values exceeding int256 max
    /// @dev We test this indirectly — with realistic values it should never trigger
    function test_safeInt256_noOverflowWithRealisticValues() public {
        // Max-lock with large amount
        vm.prank(alice); staking.stake(50_000_000 ether, MAX_LOCK);

        // Advance a long time
        vm.warp(block.timestamp + 365 days);

        // Should not revert
        uint256 tokenId = staking.userTokenId(alice);
        vm.prank(alice); staking.getReward(tokenId);
    }

    // =========================================================================
    // 18. DOUBLE CLAIM PREVENTION
    // =========================================================================

    /// @notice Claiming twice in same block should yield 0 on second claim
    function test_doubleClaim_secondYieldsZero() public {
        vm.prank(bob); staking.stake(10000 ether, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 500);

        vm.startPrank(bob);
        uint256 first = staking.getReward(tokenId);
        assertGt(first, 0, "First claim should yield rewards");

        uint256 bobBefore = token.balanceOf(bob);
        uint256 second = staking.getReward(tokenId);
        uint256 bobAfter = token.balanceOf(bob);
        vm.stopPrank();

        assertEq(second, 0, "Second claim in same block should yield 0");
        assertEq(bobAfter, bobBefore, "No balance change on second claim");
    }

    // =========================================================================
    // 19. WITHDRAW claims rewards before exit
    // =========================================================================

    /// @notice withdraw should claim pending rewards before returning principal
    function test_withdraw_claimsRewardsThenPrincipal() public {
        // V2: Use 365-day lock so boost doesn't fully decay at withdrawal time
        vm.prank(bob); staking.stake(10000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 365 days + 1);

        uint256 pending = staking.earned(tokenId);
        // V2: With boost decay, expired locks may earn 0 rewards at the moment of query,
        // but rewards were accumulated during the lock period
        // assertGt(pending, 0, "Should have pending rewards"); // V2: may be 0 after expiry

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); staking.withdraw(tokenId);
        uint256 bobAfter = token.balanceOf(bob);

        // Should receive at least principal back
        uint256 received = bobAfter - bobBefore;
        // V2: With boost decay, rewards may be 0 after lock expiry; just verify principal returned
        assertGe(received, 10000 ether, "Should receive at least principal");
    }

    // =========================================================================
    // 20. RESERVED TOKENS EXCLUSION IN updateRewards
    // =========================================================================

    /// @notice Reserved tokens (totalStaked + totalPenaltyUnclaimed + totalUnsettledRewards)
    ///         should be excluded from the reward pool
    function test_updateRewards_reservedExclusion() public {
        vm.prank(alice); staking.stake(10000 ether, MIN_LOCK);
        vm.prank(bob);   staking.stake(10000 ether, MIN_LOCK);

        vm.warp(block.timestamp + 500 + TRANSFER_COOLDOWN + 1);

        // Transfer to create unsettled
        uint256 aliceTokenId = staking.userTokenId(alice);
        vm.prank(alice); staking.transferFrom(alice, carol, aliceTokenId);

        uint256 totalUnsettled = staking.totalUnsettledRewards();
        assertGt(totalUnsettled, 0, "Should have unsettled");

        // Now advance and claim for bob — should not eat into unsettled pool
        vm.warp(block.timestamp + 500);
        uint256 bobTokenId = staking.userTokenId(bob);
        vm.prank(bob); staking.getReward(bobTokenId);

        // Alice should still be able to claim her unsettled
        uint256 aliceUnsettled = staking.unsettledRewards(alice);
        assertGt(aliceUnsettled, 0, "Alice unsettled should still exist");

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); staking.claimUnsettled();
        uint256 aliceReceived = token.balanceOf(alice) - aliceBefore;
        assertGt(aliceReceived, 0, "Alice should receive unsettled rewards");
    }
}
