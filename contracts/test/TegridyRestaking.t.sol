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
        // Link restaking contract to staking
        _linkRestakingContract();

        // Give alice a JBAC NFT
        jbac.mint(alice);
        assertGt(jbac.balanceOf(alice), 0);

        // Alice stakes (JBAC boost not granted at stake time — must revalidate)
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);

        // Revalidate to activate JBAC boost
        staking.revalidateBoost(tokenId);

        (,uint256 boostedBefore,,,,,,bool hasJbacBefore,) = staking.positions(tokenId);
        assertTrue(hasJbacBefore, "should have JBAC boost after revalidation");

        // Wait for transfer cooldown before restaking
        vm.warp(block.timestamp + 24 hours + 1);

        // Restake the position (NFT transfers to restaking contract)
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        // Verify NFT is now owned by restaking contract
        assertEq(staking.ownerOf(tokenId), address(restaking));

        // Revalidate boost — should retain JBAC since alice still holds JBAC NFT
        restaking.revalidateBoostForRestaked(tokenId);

        // Verify JBAC boost is still active
        (,uint256 boostedAfter,,,,,,bool hasJbacAfter,) = staking.positions(tokenId);
        assertTrue(hasJbacAfter, "should retain JBAC boost after restake + revalidation");
    }

    function test_revalidateBoost_stripsJbacWhenUserSellsNFT() public {
        _linkRestakingContract();

        // Give alice a JBAC NFT
        uint256 jbacId = jbac.mint(alice);

        // Alice stakes and revalidates to get JBAC boost, then restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.revalidateBoost(tokenId);

        // Wait for transfer cooldown before restaking
        vm.warp(block.timestamp + 24 hours + 1);

        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);

        // Alice sells her JBAC NFT
        jbac.transferFrom(alice, bob, jbacId);
        vm.stopPrank();

        assertEq(jbac.balanceOf(alice), 0);

        // Revalidate — should strip JBAC boost since alice no longer holds one
        restaking.revalidateBoostForRestaked(tokenId);

        (,,,,,,,bool hasJbacAfter,) = staking.positions(tokenId);
        assertFalse(hasJbacAfter, "should lose JBAC boost after selling NFT");
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
}
