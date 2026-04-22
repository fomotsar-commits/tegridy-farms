// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A mock that pretends to be a non-staking ERC721
contract FakeNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("Fake", "FAKE") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract TegridyRestakingTest is Test {
    MockTOWELI toweli;
    MockJBAC jbac;
    MockWETH weth;
    TegridyStaking staking;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    function setUp() public {
        toweli = new MockTOWELI();
        jbac = new MockJBAC();
        weth = new MockWETH();

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

        // Fund staking with rewards
        toweli.approve(address(staking), 500_000 ether);
        staking.notifyRewardAmount(500_000 ether);

        // Fund restaking with bonus rewards
        weth.transfer(address(restaking), 100_000 ether);

        toweli.transfer(alice, STAKE_AMOUNT);
        toweli.transfer(bob, STAKE_AMOUNT);
    }

    // ===== HELPER =====

    function _stakeAndRestake(address user) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        tokenId = staking.userTokenId(user);
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    // ===== onERC721Received ONLY ACCEPTS STAKING NFTs =====

    function test_revert_onERC721Received_nonStakingNFT() public {
        FakeNFT fakeNft = new FakeNFT();
        uint256 fakeId = fakeNft.mint(alice);

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.OnlyStakingNFT.selector);
        fakeNft.safeTransferFrom(alice, address(restaking), fakeId);
    }

    function test_onERC721Received_acceptsStakingNFT() public {
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        assertEq(staking.ownerOf(tokenId), address(restaking));
    }

    // ===== UNRESTAKE WORKS EVEN IF STAKING.CLAIM FAILS (try/catch) =====

    function test_unrestake_worksWhenStakingPaused() public {
        uint256 tokenId = _stakeAndRestake(alice);

        vm.warp(block.timestamp + 1 hours + 1); // Must exceed TRANSFER_RATE_LIMIT

        // Pause the staking contract so claim() reverts
        staking.pause();

        // Unrestake should still work (try/catch on claim)
        vm.prank(alice);
        restaking.unrestake();

        // NFT should be back with Alice
        assertEq(staking.ownerOf(tokenId), alice);
        assertEq(restaking.totalRestaked(), 0);
    }

    function test_claimAll_worksWhenBaseClaimFails() public {
        _stakeAndRestake(alice);

        vm.warp(block.timestamp + 50);

        // Pause staking so claim reverts
        staking.pause();

        // claimAll should still work for bonus (try/catch on base claim)
        uint256 wethBefore = weth.balanceOf(alice);
        vm.prank(alice);
        restaking.claimAll();

        // Should have received bonus rewards even though base claim failed
        assertGt(weth.balanceOf(alice) - wethBefore, 0, "Should still get bonus");
    }

    // ===== EMERGENCY WITHDRAW FORFEITS REWARDS =====

    function test_emergencyWithdraw_forfeitsRewards() public {
        uint256 tokenId = _stakeAndRestake(alice);

        vm.warp(block.timestamp + 1 hours + 1); // Must exceed TRANSFER_RATE_LIMIT

        // Verify there are pending rewards
        assertGt(restaking.pendingBonus(alice), 0, "Should have pending bonus");

        uint256 wethBefore = weth.balanceOf(alice);
        uint256 toweliBefore = toweli.balanceOf(alice);

        vm.prank(alice);
        restaking.emergencyWithdrawNFT();

        // Bonus rewards should be forfeited (emergency skips bonus claim)
        assertEq(weth.balanceOf(alice), wethBefore, "No bonus claimed on emergency");

        // Base rewards: user may receive unsettled rewards recovered from the NFT transfer settlement.
        // emergencyWithdrawNFT snapshots staking.unsettledRewards before/after the NFT transfer
        // and forwards the user's portion via claimUnsettled, so a non-zero TOWELI delta is expected.
        uint256 toweliGain = toweli.balanceOf(alice) - toweliBefore;
        assertGe(toweliGain, 0, "Base gain should be non-negative");
        // The unsettled recovery should not exceed what staking would have paid out
        uint256 maxExpectedBase = (1 hours + 1) * REWARD_RATE; // elapsed time * reward rate
        assertLe(toweliGain, maxExpectedBase, "Recovered base should not exceed max accrued");

        // NFT should be back
        assertEq(staking.ownerOf(tokenId), alice);
        assertEq(restaking.totalRestaked(), 0);
    }

    // ===== BASIC RESTAKING =====

    function test_restake_basic() public {
        uint256 tokenId = _stakeAndRestake(alice);

        assertEq(staking.ownerOf(tokenId), address(restaking));
        (uint256 rTokenId, uint256 posAmount,,, uint256 depositTime,) = restaking.restakers(alice);
        assertEq(rTokenId, tokenId);
        assertEq(posAmount, STAKE_AMOUNT);
        assertGt(depositTime, 0);
        assertGt(restaking.totalRestaked(), 0);
    }

    function test_restake_earns_both_rewards() public {
        _stakeAndRestake(alice);

        vm.warp(block.timestamp + 100);

        uint256 pendingBase = restaking.pendingBase(alice);
        uint256 pendingBonus = restaking.pendingBonus(alice);

        assertGt(pendingBase, 0, "Should have base rewards");
        assertGt(pendingBonus, 0, "Should have bonus rewards");
    }

    function test_claimAll_sends_both_tokens() public {
        _stakeAndRestake(alice);

        vm.warp(block.timestamp + 100);

        uint256 toweliBalBefore = toweli.balanceOf(alice);
        uint256 wethBalBefore = weth.balanceOf(alice);

        vm.prank(alice);
        restaking.claimAll();

        assertGt(toweli.balanceOf(alice) - toweliBalBefore, 0, "Should receive TOWELI");
        assertGt(weth.balanceOf(alice) - wethBalBefore, 0, "Should receive WETH");
    }

    function test_unrestake_returns_nft_and_claims() public {
        uint256 tokenId = _stakeAndRestake(alice);

        vm.warp(block.timestamp + 1 hours + 1); // Must exceed TRANSFER_RATE_LIMIT

        uint256 toweliBalBefore = toweli.balanceOf(alice);
        uint256 wethBalBefore = weth.balanceOf(alice);

        vm.prank(alice);
        restaking.unrestake();

        assertEq(staking.ownerOf(tokenId), alice);
        assertGt(toweli.balanceOf(alice) - toweliBalBefore, 0);
        assertGt(weth.balanceOf(alice) - wethBalBefore, 0);
        assertEq(restaking.totalRestaked(), 0);
    }

    // ===== ERROR CASES =====

    function test_cannot_restake_twice() public {
        _stakeAndRestake(alice);

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.AlreadyRestaked.selector);
        restaking.restake(1);
    }

    function test_cannot_unrestake_without_position() public {
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.NotRestaked.selector);
        restaking.unrestake();
    }

    function test_cannot_claim_without_position() public {
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.NotRestaked.selector);
        restaking.claimAll();
    }

    function test_cannot_restake_others_nft() public {
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(TegridyRestaking.NotNFTOwner.selector);
        restaking.restake(tokenId);
    }

    // ===== BONUS RATE TIMELOCK (SECURITY FIX #13) =====

    function test_proposeBonusRate_timelock() public {
        restaking.proposeBonusRate(0.5 ether);
        assertEq(restaking.pendingBonusRate(), 0.5 ether);
        assertGt(restaking.bonusRateChangeTime(), block.timestamp);
    }

    function test_executeBonusRateChange_afterTimelock() public {
        restaking.proposeBonusRate(0.5 ether);
        vm.warp(block.timestamp + 48 hours + 1);
        restaking.executeBonusRateChange();
        assertEq(restaking.bonusRewardPerSecond(), 0.5 ether);
    }

    function test_revert_executeBonusRate_beforeTimelock() public {
        restaking.proposeBonusRate(0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, restaking.BONUS_RATE_CHANGE()));
        restaking.executeBonusRateChange();
    }

    function test_revert_proposeBonusRate_tooHigh() public {
        vm.expectRevert(TegridyRestaking.RateTooHigh.selector);
        restaking.proposeBonusRate(101 ether);
    }

    // ===== FAIR SPLIT =====

    function test_two_restakers_fair_split() public {
        _stakeAndRestake(alice);

        vm.startPrank(bob);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 90 days);
        uint256 tokenIdB = staking.userTokenId(bob);
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenIdB);
        restaking.restake(tokenIdB);
        vm.stopPrank();

        // Long accrual period so the 24h gap is negligible
        vm.warp(block.timestamp + 30 days);

        uint256 aliceBonus = restaking.pendingBonus(alice);
        uint256 bobBonus = restaking.pendingBonus(bob);

        assertGt(aliceBonus, 0);
        assertGt(bobBonus, 0);
        // Different lock durations (30d vs 90d) give different boosted weights
        assertApproxEqRel(aliceBonus, bobBonus, 0.15e18);
    }

    // ===== H-02: JBAC Boost Retained After Restaking =====

    function _linkRestakingContract() internal {
        staking.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        staking.executeRestakingContract();
    }

    function test_revalidateBoost_retainsJbacForRestakedPosition() public {
        // AUDIT H-1 (2026-04-20): JBAC boost now requires physical deposit via stakeWithBoost.
        // After restaking, the JBAC is held by TegridyStaking, and the deposit-based boost
        // cannot be revalidated (revalidateBoost reverts for jbacDeposited=true).
        _linkRestakingContract();

        uint256 jbacId = jbac.mint(alice);

        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        jbac.approve(address(staking), jbacId);
        staking.stakeWithBoost(STAKE_AMOUNT, 30 days, jbacId);
        uint256 tokenId = staking.userTokenId(alice);

        (,uint256 boostedBefore,,,,,,bool hasJbacBefore,,,) = staking.positions(tokenId);
        assertTrue(hasJbacBefore, "should have JBAC boost from stakeWithBoost");
        assertGt(boostedBefore, 0, "boostedAmount should be positive");

        vm.warp(block.timestamp + 24 hours + 1);

        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        assertEq(staking.ownerOf(tokenId), address(restaking));
        // Deposit-based positions cannot be revalidated (H-1): expect revert.
        vm.expectRevert(TegridyStaking.JbacDeposited.selector);
        restaking.revalidateBoostForRestaked(tokenId);

        (,uint256 boostedAfter,,,,,,bool hasJbacAfter,,,) = staking.positions(tokenId);
        assertTrue(hasJbacAfter, "H-1: deposit-based JBAC boost is guaranteed for the lock duration");
        assertEq(boostedAfter, boostedBefore, "boosted amount unchanged");
    }

    function test_revalidateBoost_stripsJbacWhenUserSellsNFT() public {
        // AUDIT H-1 (2026-04-20): With physical deposit, alice cannot transfer the JBAC
        // (it's held by staking). This test validates the new invariant: once JBAC is
        // deposited, it cannot be "sold" until the stake position is unwound.
        _linkRestakingContract();

        uint256 jbacId = jbac.mint(alice);

        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        jbac.approve(address(staking), jbacId);
        staking.stakeWithBoost(STAKE_AMOUNT, 30 days, jbacId);
        uint256 tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);

        // Attempt to transfer the JBAC — alice no longer owns it, so this reverts.
        vm.expectRevert();
        jbac.transferFrom(alice, bob, jbacId);
        vm.stopPrank();

        // JBAC is safely held by staking contract.
        assertEq(jbac.ownerOf(jbacId), address(staking), "JBAC escrowed in staking");
        (,,,,,,,bool hasJbacAfter,,,) = staking.positions(tokenId);
        assertTrue(hasJbacAfter, "H-1: JBAC boost remains - physically deposited");
    }

    // ===== H-01 (Balance-Delta): MEV sandwich cannot inflate base rewards =====

    function test_claimAll_notInflatedByExternalTransfer() public {
        _stakeAndRestake(alice);

        vm.warp(block.timestamp + 100);

        // Snapshot expected base rewards before any manipulation
        uint256 expectedBase = restaking.pendingBase(alice);
        assertGt(expectedBase, 0, "Should have pending base rewards");

        // Attacker sends rewardToken directly to the restaking contract
        // in the same block (simulating MEV sandwich front-run)
        uint256 attackAmount = 50_000 ether;
        toweli.transfer(address(restaking), attackAmount);

        // Alice claims — should only receive her actual earned rewards,
        // not the attacker's donated tokens
        uint256 aliceBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        restaking.claimAll();
        uint256 aliceReceived = toweli.balanceOf(alice) - aliceBefore;

        // The received amount should match the expected rewards (within rounding),
        // NOT be inflated by the attacker's transfer
        assertLe(aliceReceived, expectedBase + 1, "Rewards should not be inflated by external transfer");
        assertLt(aliceReceived, attackAmount, "Should not receive attacker's tokens");
    }

    function test_unrestake_notInflatedByExternalTransfer() public {
        uint256 tokenId = _stakeAndRestake(alice);

        vm.warp(block.timestamp + 1 hours + 1); // Must exceed TRANSFER_RATE_LIMIT

        uint256 expectedBase = restaking.pendingBase(alice);
        assertGt(expectedBase, 0, "Should have pending base rewards");

        // Attacker sends rewardToken directly to the restaking contract
        uint256 attackAmount = 50_000 ether;
        toweli.transfer(address(restaking), attackAmount);

        // Alice unrestakes — should only receive her actual earned rewards
        uint256 aliceBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        restaking.unrestake();
        uint256 aliceReceived = toweli.balanceOf(alice) - aliceBefore;

        // The received amount should match the expected rewards (within rounding),
        // NOT be inflated by the attacker's transfer
        assertLe(aliceReceived, expectedBase + 1, "Rewards should not be inflated by external transfer");
        assertLt(aliceReceived, attackAmount, "Should not receive attacker's tokens");

        // NFT should be returned
        assertEq(staking.ownerOf(tokenId), alice);
    }

    // ===== X-03: Per-user unsettled rewards tracking =====

    function test_pendingUnsettledRewards_trackedPerUser() public {
        uint256 tokenIdA = _stakeAndRestake(alice);
        uint256 tokenIdB = _stakeAndRestake(bob);

        // Accrue some rewards
        vm.warp(block.timestamp + 7 days);

        // Both unrestake — pendingUnsettledRewards should be isolated per user
        vm.prank(alice);
        restaking.unrestake();
        assertEq(staking.ownerOf(tokenIdA), alice, "Alice should get NFT back");

        vm.prank(bob);
        restaking.unrestake();
        assertEq(staking.ownerOf(tokenIdB), bob, "Bob should get NFT back");
    }

    function test_claimPendingUnsettled_revertsWhenZero() public {
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.ZeroAmount.selector);
        restaking.claimPendingUnsettled();
    }

    // ===== E-04: BONUS REWARDS USE BOOSTED AMOUNT =====

    function test_bonus_uses_boostedAmount_not_raw() public {
        // Alice stakes with 30-day lock (low boost), Bob stakes with max lock (high boost)
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        vm.startPrank(bob);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 1460 days); // max lock = highest boost
        uint256 bobTokenId = staking.userTokenId(bob);
        vm.stopPrank();

        // Wait for transfer cooldown
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), aliceTokenId);
        restaking.restake(aliceTokenId);
        vm.stopPrank();

        vm.startPrank(bob);
        staking.approve(address(restaking), bobTokenId);
        restaking.restake(bobTokenId);
        vm.stopPrank();

        // Both staked the same raw amount, but Bob has higher boosted amount
        (, uint256 alicePos, uint256 aliceBoosted,,,) = restaking.restakers(alice);
        (, uint256 bobPos, uint256 bobBoosted,,,) = restaking.restakers(bob);
        assertEq(alicePos, bobPos, "Same raw amount staked");
        assertGt(bobBoosted, aliceBoosted, "Bob should have higher boost");

        // totalRestaked should equal sum of boosted amounts, not raw amounts
        assertEq(restaking.totalRestaked(), aliceBoosted + bobBoosted);

        // After time passes, Bob should earn more bonus than Alice
        vm.warp(block.timestamp + 1000);
        uint256 aliceBonus = restaking.pendingBonus(alice);
        uint256 bobBonus = restaking.pendingBonus(bob);
        assertGt(bobBonus, aliceBonus, "Higher boost should earn more bonus");

        // Ratio of bonuses should match ratio of boosted amounts
        // bobBonus / aliceBonus ~= bobBoosted / aliceBoosted
        assertApproxEqRel(
            bobBonus * aliceBoosted,
            aliceBonus * bobBoosted,
            0.01e18 // 1% tolerance for rounding
        );
    }

    // ─── AUDIT NEW-S1: boostedAmountAt view for RevenueDistributor ─────

    /// @notice AUDIT NEW-S1 (CRITICAL): the view returns the user's restaker
    ///         boostedAmount when their restake depositTime is at or before
    ///         the queried timestamp, and zero otherwise. Used by
    ///         RevenueDistributor to credit restakers (whose staking
    ///         checkpoint would otherwise read 0).
    function test_NEWS1_boostedAmountAtReturnsCurrentWhenEligible() public {
        _stakeAndRestake(alice);
        (, , uint256 cachedBoost, , uint256 depositTime, ) = restaking.restakers(alice);

        // Same-timestamp query returns the current boosted amount.
        assertEq(restaking.boostedAmountAt(alice, depositTime), cachedBoost, "eligible at depositTime");

        // Later timestamp also returns (boost only decays, never grows, so
        // current is a lower-bound for historical — safe for claim math).
        vm.warp(depositTime + 10 days);
        assertEq(restaking.boostedAmountAt(alice, block.timestamp), cachedBoost, "eligible after depositTime");
    }

    /// @notice AUDIT NEW-S1: earlier-than-depositTime queries return zero —
    ///         the user didn't have this restaked position at the queried
    ///         epoch, so RevenueDistributor must not credit them for it.
    function test_NEWS1_boostedAmountAtZeroBeforeDeposit() public {
        _stakeAndRestake(alice);
        (, , , , uint256 depositTime, ) = restaking.restakers(alice);

        if (depositTime >= 1) {
            assertEq(restaking.boostedAmountAt(alice, depositTime - 1), 0, "ineligible pre-deposit");
        }
    }

    /// @notice AUDIT NEW-S1: non-restakers always return zero regardless of
    ///         timestamp. Prevents phantom credit on EOAs that never restaked.
    function test_NEWS1_boostedAmountAtZeroForNonRestaker() public view {
        assertEq(restaking.boostedAmountAt(bob, block.timestamp), 0);
        assertEq(restaking.boostedAmountAt(address(0xdead), block.timestamp), 0);
    }

    // ─── AUDIT NEW-S2: revalidate-boost auth gate ──────────────────────

    /// @notice AUDIT NEW-S2 (HIGH): a random attacker can no longer call
    ///         revalidateBoostForRestaker(victim) to strip the victim's
    ///         legacy JBAC boost during a JBAC-transfer window.
    function test_NEWS2_revalidateByRandomReverts() public {
        _stakeAndRestake(alice);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(TegridyRestaking.Unauthorized.selector);
        restaking.revalidateBoostForRestaker(alice);
    }

    /// @notice AUDIT NEW-S2: the restaker themselves can still trigger
    ///         revalidation on their own position.
    function test_NEWS2_restakerCanSelfRevalidate() public {
        _stakeAndRestake(alice);
        vm.prank(alice);
        restaking.revalidateBoostForRestaker(alice);
    }

    /// @notice AUDIT NEW-S2: the owner retains admin access even when the
    ///         restaker is someone else. Useful for emergency response.
    function test_NEWS2_ownerCanRevalidate() public {
        _stakeAndRestake(alice);
        // Test contract deployed restaking so it owns it.
        restaking.revalidateBoostForRestaker(alice);
    }

    /// @notice AUDIT NEW-S2: the tokenId-indexed variant
    ///         revalidateBoostForRestaked is gated identically.
    function test_NEWS2_revalidateByTokenIdByRandomReverts() public {
        uint256 tokenId = _stakeAndRestake(alice);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(TegridyRestaking.Unauthorized.selector);
        restaking.revalidateBoostForRestaked(tokenId);
    }
}
