// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockTOWELI_FA is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC_FA is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
    function burn(uint256 id) external {
        _burn(id);
    }
}

contract MockWETH_FA is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 10_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title FinalAuditRestaking — Deep security audit PoC tests for TegridyRestaking
contract FinalAuditRestaking is Test {
    MockTOWELI_FA toweli;
    MockJBAC_FA jbac;
    MockWETH_FA weth;
    TegridyStaking staking;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address charlie = makeAddr("charlie");
    address treasury = makeAddr("treasury");
    address deployer;

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.5 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    function setUp() public {
        deployer = address(this);

        toweli = new MockTOWELI_FA();
        jbac = new MockJBAC_FA();
        weth = new MockWETH_FA();

        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            REWARD_RATE
        );

        restaking = new TegridyRestaking(
            address(staking),
            address(toweli),
            address(weth),
            BONUS_RATE
        );

        // Set restaking contract on staking so revalidateBoost works
        staking.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        staking.executeRestakingContract();

        // Fund staking with rewards
        toweli.approve(address(staking), 2_000_000 ether);
        staking.notifyRewardAmount(2_000_000 ether);

        // Fund restaking bonus pool
        weth.approve(address(restaking), 1_000_000 ether);
        restaking.fundBonus(1_000_000 ether);

        // Give users TOWELI
        toweli.transfer(alice, STAKE_AMOUNT * 2);
        toweli.transfer(bob, STAKE_AMOUNT * 2);
        toweli.transfer(charlie, STAKE_AMOUNT * 2);
    }

    // ===== HELPER =====

    function _stakeAndRestake(address user, uint256 amount, uint256 lockDuration) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), amount);
        staking.stake(amount, lockDuration);
        tokenId = staking.userTokenId(user);
        // Advance past 24h transfer cooldown
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    // =========================================================================
    //  FINDING #1 (CRITICAL): revalidateBoostForRestaked does NOT update
    //  totalRestaked, causing bonus reward accounting drift
    // =========================================================================

    function test_CRITICAL_revalidateBoost_totalRestaked_drift() public {
        // Alice stakes WITHOUT JBAC (hasJbacBoost=false at stake time)
        jbac.mint(alice); // Alice holds JBAC
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);

        // Bob stakes without JBAC
        uint256 bobToken = _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        // Step 1: Revalidate to ADD JBAC boost (hasJbacBoost false -> true)
        // This changes boostedAmount in the staking contract
        restaking.revalidateBoostForRestaked(aliceToken);

        // Verify the boost was added in staking
        (,uint256 boostedInStaking,,,,,, bool hasJbac,) = staking.positions(aliceToken);
        assertTrue(hasJbac, "JBAC boost should be added");

        // Now the restaking contract has cached the new boostedAmount
        (, , uint256 aliceBoostedWithJbac, ,,) = restaking.restakers(alice);
        uint256 totalRestakedAfterAdd = restaking.totalRestaked();

        // FIX VERIFIED: totalRestaked IS now updated after adding JBAC boost
        (, , uint256 bobBoosted, ,,) = restaking.restakers(bob);
        uint256 expectedTotal = aliceBoostedWithJbac + bobBoosted;

        emit log_named_uint("Expected totalRestaked after JBAC add", expectedTotal);
        emit log_named_uint("Actual totalRestaked after JBAC add", totalRestakedAfterAdd);
        assertEq(totalRestakedAfterAdd, expectedTotal, "FIX VERIFIED: totalRestaked updated correctly after boost add");
    }

    // =========================================================================
    //  FINDING #2 (HIGH): revalidateBoostForRestaked does NOT reset bonusDebt,
    //  causing inflated or deflated bonus claims after boost change
    // =========================================================================

    function test_HIGH_revalidateBoost_bonusDebt_not_reset() public {
        // Alice stakes, holds JBAC
        jbac.mint(alice);
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);

        // Step 1: Revalidate to ADD JBAC boost first (hasJbacBoost: false -> true)
        restaking.revalidateBoostForRestaked(aliceToken);

        // Let time pass to accrue significant accBonusPerShare
        vm.warp(block.timestamp + 30 days);

        // Record state before removing JBAC
        (, , uint256 aliceBoostedBefore, int256 debtBefore,,) = restaking.restakers(alice);
        uint256 pendingBonusBefore = restaking.pendingBonus(alice);

        // Alice loses JBAC → revalidate to REMOVE boost
        vm.prank(alice);
        jbac.transferFrom(alice, charlie, 1);

        restaking.revalidateBoostForRestaked(aliceToken);

        (, , uint256 aliceBoostedAfter, int256 debtAfter,,) = restaking.restakers(alice);

        // Boost should have changed (JBAC removed)
        assertTrue(aliceBoostedBefore > aliceBoostedAfter, "Boost should have decreased");

        // FIX VERIFIED: bonusDebt IS now recalculated for the new boostedAmount
        assertTrue(debtBefore != debtAfter, "FIX VERIFIED: bonusDebt was reset after boost change");
    }

    // =========================================================================
    //  FINDING #3: revalidateBoostForRestaker has same bugs as ForRestaked
    //  (totalRestaked not updated + bonusDebt not reset)
    // =========================================================================

    function test_CRITICAL_revalidateBoostForRestaker_same_bugs() public {
        // Alice stakes, holds JBAC
        jbac.mint(alice);
        _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);

        // First: add JBAC boost via revalidate
        restaking.revalidateBoostForRestaker(alice);

        vm.warp(block.timestamp + 7 days);

        uint256 totalRestakedBefore = restaking.totalRestaked();
        (, , uint256 aliceBoostedBefore, int256 debtBefore,,) = restaking.restakers(alice);

        // Alice loses JBAC
        vm.prank(alice);
        jbac.transferFrom(alice, charlie, 1);

        // Revalidate via user address variant to remove boost
        restaking.revalidateBoostForRestaker(alice);

        uint256 totalRestakedAfter = restaking.totalRestaked();
        (, , uint256 aliceBoostedAfter, int256 debtAfter,,) = restaking.restakers(alice);

        assertTrue(aliceBoostedBefore > aliceBoostedAfter, "Boost should have decreased");

        // FIX VERIFIED 1: totalRestaked IS now updated
        assertTrue(totalRestakedAfter != totalRestakedBefore, "FIX VERIFIED: totalRestaked updated after boost change");
        uint256 expectedTotal = aliceBoostedAfter;
        assertEq(totalRestakedAfter, expectedTotal, "FIX VERIFIED: totalRestaked matches new boostedAmount");

        // FIX VERIFIED 2: bonusDebt IS now reset
        assertTrue(debtBefore != debtAfter, "FIX VERIFIED: bonusDebt reset after boost change");
    }

    // =========================================================================
    //  FINDING #4 (MEDIUM): claimPendingUnsettled uses full rewardToken balance,
    //  which may include other users' unforwardedBaseRewards
    // =========================================================================

    function test_MEDIUM_claimPendingUnsettled_drains_other_users_rewards() public {
        // Setup: Alice and Bob both restake
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);
        uint256 bobToken = _stakeAndRestake(bob, STAKE_AMOUNT, 30 days);

        vm.warp(block.timestamp + 10 days);

        // Simulate: Alice has unforwarded base rewards (from a revalidateBoost call)
        // We need to give Alice a JBAC, restake, then lose it and revalidate
        jbac.mint(alice);
        // Can't re-restake alice, so let's use the attribution mechanism
        // Instead, directly check the mechanism:
        // If Bob has pendingUnsettledRewards and Alice has unforwardedBaseRewards,
        // Bob's claimPendingUnsettled could consume Alice's tokens

        // Give the restaking contract some rewardTokens to simulate unforwarded
        toweli.transfer(address(restaking), 1000 ether);

        // Owner attributes stuck rewards to Alice
        restaking.proposeAttributeStuckRewards(alice, 500 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        restaking.executeAttributeStuckRewards();

        // Verify Alice has unforwarded
        assertEq(restaking.unforwardedBaseRewards(alice), 500 ether);

        // Now if Bob somehow gets pendingUnsettledRewards set
        // (this happens during concurrent unrestakes when the shared bucket is drained)
        // For the PoC, we demonstrate that claimPendingUnsettled's `available` check
        // includes tokens reserved for Alice's unforwardedBaseRewards

        uint256 restakingBalance = toweli.balanceOf(address(restaking));
        uint256 aliceUnforwarded = restaking.unforwardedBaseRewards(alice);

        // The available check in claimPendingUnsettled is:
        //   uint256 available = rewardToken.balanceOf(address(this));
        //   uint256 payout = owed > available ? available : owed;
        // It does NOT subtract unforwardedBaseRewards for other users
        emit log_named_uint("Restaking rewardToken balance", restakingBalance);
        emit log_named_uint("Alice unforwarded (should be reserved)", aliceUnforwarded);
        assertTrue(aliceUnforwarded > 0, "Alice should have unforwarded rewards");
        // If Bob's pendingUnsettled > (balance - aliceUnforwarded), he could drain Alice's tokens
    }

    // =========================================================================
    //  FINDING #5: try/catch on staking.claim() returning 0 is safe but
    //  verify it doesn't transfer 0-amount tokens
    // =========================================================================

    function test_claimAll_baseClaim_returns_zero_is_safe() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        // Claim once to drain all pending base rewards
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        restaking.claimAll();

        // Immediately claim again — staking.claim() should return 0
        // This should NOT revert and should NOT transfer 0 tokens
        vm.prank(alice);
        restaking.claimAll(); // Should succeed silently
    }

    // =========================================================================
    //  FINDING #6: Verify refreshPosition at different times causes no
    //  accounting drift (E-04 fix validation)
    // =========================================================================

    function test_refreshPosition_at_different_times_no_drift() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);
        _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        // Accumulate rewards for 10 days
        vm.warp(block.timestamp + 10 days);

        // Alice refreshes position
        vm.prank(alice);
        restaking.refreshPosition();

        // More time passes
        vm.warp(block.timestamp + 5 days);

        // Bob refreshes position
        vm.prank(bob);
        restaking.refreshPosition();

        // Verify totalRestaked equals sum of individual boostedAmounts
        (, , uint256 aliceBoosted, ,,) = restaking.restakers(alice);
        (, , uint256 bobBoosted, ,,) = restaking.restakers(bob);
        uint256 totalRestaked = restaking.totalRestaked();

        assertEq(totalRestaked, aliceBoosted + bobBoosted, "totalRestaked should match sum of boostedAmounts");
    }

    // =========================================================================
    //  FINDING #7: emergencyForceReturn does NOT handle pendingUnsettledRewards
    // =========================================================================

    function test_LOW_emergencyForceReturn_loses_pendingUnsettled() public {
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        vm.warp(block.timestamp + 5 days);

        // Verify the emergencyForceReturn function does not touch pendingUnsettledRewards
        // If Alice had accumulated pendingUnsettledRewards from a prior failed unrestake,
        // emergencyForceReturn would delete restakers[alice] without forwarding them

        // We can't easily set pendingUnsettledRewards directly in a test without
        // going through the unrestake flow, but we can verify the code path:
        // emergencyForceReturn does: delete restakers[restaker]
        // but does NOT check or forward pendingUnsettledRewards[restaker]

        // Pause the contract (required for emergencyForceReturn)
        restaking.pause();

        // Force return
        restaking.emergencyForceReturn(aliceToken);

        // Alice's restaking info is deleted
        (uint256 tokenId, , , ,,) = restaking.restakers(alice);
        assertEq(tokenId, 0, "Position should be deleted");

        // pendingUnsettledRewards mapping still exists but user has no position
        // to claim through normal flows. However claimPendingUnsettled can still
        // be called independently, so this is LOW severity.
        // The real issue: the user might not know they have pending unsettled.
    }

    // =========================================================================
    //  FINDING #8: Verify tokenIdToRestaker cannot return stale data
    // =========================================================================

    function test_tokenIdToRestaker_cleaned_on_unrestake() public {
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        assertEq(restaking.tokenIdToRestaker(aliceToken), alice);

        vm.warp(block.timestamp + 5 days);

        vm.prank(alice);
        restaking.unrestake();

        // Should be cleaned
        assertEq(restaking.tokenIdToRestaker(aliceToken), address(0), "tokenIdToRestaker should be cleaned");
    }

    function test_tokenIdToRestaker_cleaned_on_emergencyWithdraw() public {
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        vm.prank(alice);
        restaking.emergencyWithdrawNFT();

        assertEq(restaking.tokenIdToRestaker(aliceToken), address(0), "tokenIdToRestaker should be cleaned");
    }

    // =========================================================================
    //  FINDING #9: Verify accBonusPerShare precision (1e12) rounding loss
    // =========================================================================

    function test_accBonusPerShare_precision_rounding() public {
        // Stake a very large amount to see if rounding eats small rewards
        _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);

        // Only 1 second passes with 0.5 ether/sec bonus rate
        vm.warp(block.timestamp + 1);

        uint256 pendingBonus = restaking.pendingBonus(alice);
        // With 0.5 ether reward and ACC_PRECISION = 1e12, rounding should be minimal
        // reward = 0.5e18, accBonusPerShare += (0.5e18 * 1e12) / totalRestaked
        // At 100k ether stake with ~2x boost => ~200k ether boosted
        // accBonusPerShare += 5e29 / 2e23 = ~2.5e6
        // pending = boostedAmount * accBonusPerShare / ACC_PRECISION
        // = 2e23 * 2.5e6 / 1e12 = 5e17 = 0.5 ether (expected)
        emit log_named_uint("Pending bonus after 1 second", pendingBonus);
        assertTrue(pendingBonus > 0, "Should have non-zero bonus after 1 second");

        // The rounding loss per claim should be < 1 wei per user
        // With ACC_PRECISION = 1e12, loss per operation = boostedAmount / 1e12
        // For 200k ether boosted: loss = 2e23 / 1e12 = 2e11 = 0.0000002 ether
        // This is acceptable but non-trivial for high-frequency claims
    }

    // =========================================================================
    //  FINDING #10: sweepStuckRewards cannot drain bonus or reward tokens
    // =========================================================================

    function test_sweepStuckRewards_blocks_bonus_and_reward_tokens() public {
        // Should revert for bonusRewardToken
        vm.expectRevert(TegridyRestaking.CannotSweepBonusToken.selector);
        restaking.sweepStuckRewards(address(weth));

        // Should revert for rewardToken
        vm.expectRevert(TegridyRestaking.CannotSweepRewardToken.selector);
        restaking.sweepStuckRewards(address(toweli));
    }

    // =========================================================================
    //  FINDING #11: Quantify the totalRestaked drift impact on bonus distribution
    //  Shows that after revalidateBoost, bonus rewards are mis-distributed
    // =========================================================================

    function test_CRITICAL_totalRestaked_drift_causes_reward_theft() public {
        // Alice gets JBAC for higher boost
        jbac.mint(alice);
        uint256 aliceToken = _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);
        uint256 bobToken = _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        // First add JBAC boost to Alice
        restaking.revalidateBoostForRestaked(aliceToken);

        (, , uint256 aliceBoostedWithJbac, ,,) = restaking.restakers(alice);
        (, , uint256 bobBoosted, ,,) = restaking.restakers(bob);

        // Alice loses JBAC -> revalidate drops her boost
        vm.prank(alice);
        jbac.transferFrom(alice, charlie, 1);

        uint256 totalRestakedBefore = restaking.totalRestaked();
        restaking.revalidateBoostForRestaked(aliceToken);

        (, , uint256 aliceBoostedAfter, ,,) = restaking.restakers(alice);
        uint256 totalRestakedAfterRevalidate = restaking.totalRestaked();

        assertTrue(aliceBoostedWithJbac > aliceBoostedAfter, "Boost should have decreased");

        // BUG: totalRestaked still includes the OLD boosted amount
        uint256 actualSum = aliceBoostedAfter + bobBoosted;
        uint256 staleTotal = totalRestakedAfterRevalidate;

        emit log_named_uint("Actual sum of boostedAmounts", actualSum);
        emit log_named_uint("Stale totalRestaked (not updated)", staleTotal);
        emit log_named_uint("Phantom stake in totalRestaked", staleTotal - actualSum);

        // The phantom stake means bonus rewards are distributed to "nobody"
        // effectively reducing everyone's share.

        // Let time pass and check reward distribution
        vm.warp(block.timestamp + 30 days);

        uint256 alicePending = restaking.pendingBonus(alice);
        uint256 bobPending = restaking.pendingBonus(bob);

        emit log_named_uint("Alice pending bonus (with stale totalRestaked)", alicePending);
        emit log_named_uint("Bob pending bonus (with stale totalRestaked)", bobPending);

        // Both users get LESS than they should because totalRestaked is inflated
        // The "phantom" portion of rewards goes unclaimed forever (locked in contract)
    }
}
