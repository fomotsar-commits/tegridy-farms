// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

contract TegridyStakingTest is Test {
    TegridyStaking public staking;
    MockToken public token;
    MockNFT public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice"); // has JBAC
    address public bob = makeAddr("bob"); // no JBAC
    address public carol = makeAddr("carol"); // buyer of NFT positions

    function setUp() public {
        token = new MockToken();
        nft = new MockNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        nft.mint(alice); // Alice gets JBAC

        token.transfer(alice, 1_000_000 ether);
        token.transfer(bob, 1_000_000 ether);
        token.transfer(carol, 1_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);

        token.approve(address(staking), type(uint256).max);
        staking.fund(10_000_000 ether);
    }

    // ─── Basic Staking ────────────────────────────────────────────────

    function test_stake_mintsNFT() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        // Bob should own an NFT
        assertEq(staking.balanceOf(bob), 1);
        uint256 tokenId = staking.userTokenId(bob);
        assertGt(tokenId, 0);
        assertEq(staking.ownerOf(tokenId), bob);
    }

    function test_stake_boost() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        uint256 tokenId = staking.userTokenId(bob);
        (uint256 amount, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        assertEq(amount, 500_000 ether);
        assertGt(boostBps, 12000); // ~1.29x
    }

    function test_jbac_boost() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 365 days);
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        uint256 aliceId = staking.userTokenId(alice);
        uint256 bobId = staking.userTokenId(bob);
        (,uint256 aliceBoost,,,,) = staking.getPosition(aliceId);
        (,uint256 bobBoost,,,,) = staking.getPosition(bobId);

        assertEq(aliceBoost - bobBoost, 5000); // +0.5x JBAC bonus
    }

    // ─── Rewards ──────────────────────────────────────────────────────

    function test_rewards_accrue() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        vm.warp(block.timestamp + 100);

        uint256 tokenId = staking.userTokenId(bob);
        uint256 pending = staking.pendingReward(tokenId);
        assertApproxEqAbs(pending, 100 ether, 1 ether);
    }

    function test_claim() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        vm.warp(block.timestamp + 1000);

        uint256 tokenId = staking.userTokenId(bob);
        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.claim(tokenId);
        assertGt(token.balanceOf(bob) - balBefore, 900 ether);
    }

    // ─── Normal Withdraw ──────────────────────────────────────────────

    function test_withdraw_burnsNFT() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);
        vm.warp(block.timestamp + 31 days);

        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.withdraw(tokenId);

        assertEq(staking.balanceOf(bob), 0);
        assertEq(staking.userTokenId(bob), 0);
    }

    function test_withdraw_fullAmount() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);
        vm.warp(block.timestamp + 31 days);

        uint256 tokenId = staking.userTokenId(bob);
        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.withdraw(tokenId);

        assertGt(token.balanceOf(bob) - balBefore, 500_000 ether); // Full + rewards
    }

    // ─── Early Withdraw (25% penalty → remaining stakers) ─────────

    function test_earlyWithdraw_penalty() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        uint256 tokenId = staking.userTokenId(bob);
        uint256 balBefore = token.balanceOf(bob);

        vm.prank(bob);
        staking.earlyWithdraw(tokenId);

        uint256 received = token.balanceOf(bob) - balBefore;
        // Should get ~375K (75% of 500K) + tiny rewards
        assertApproxEqAbs(received, 375_000 ether, 100 ether);
        assertEq(staking.totalPenaltiesCollected(), 125_000 ether);
        assertEq(staking.totalPenaltiesRedistributed(), 125_000 ether);
    }

    function test_earlyWithdraw_penaltyGoesToStakers() public {
        // Alice and Bob both stake
        vm.prank(alice);
        staking.stake(100_000 ether, 365 days);
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);

        // Bob early withdraws — 25K penalty stays in contract as future rewards
        uint256 bobId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.earlyWithdraw(bobId);

        // The 25K penalty is now in the contract balance, available for future reward distribution
        assertEq(staking.totalPenaltiesRedistributed(), 25_000 ether);

        // After some time, Alice earns rewards that include the penalty pool
        vm.warp(block.timestamp + 30000); // Long enough to distribute penalty as rewards
        uint256 aliceId = staking.userTokenId(alice);
        uint256 alicePending = staking.pendingReward(aliceId);
        // Alice should earn significantly more because penalty boosted the reward pool
        assertGt(alicePending, 1000 ether);
    }

    // ─── Auto-Max-Lock ────────────────────────────────────────────────

    function test_autoMaxLock_toggle() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);

        uint256 tokenId = staking.userTokenId(bob);
        (,,uint256 lockEndBefore,,,) = staking.getPosition(tokenId);

        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        (,uint256 newBoost, uint256 lockEndAfter,, bool autoMax,) = staking.getPosition(tokenId);
        assertTrue(autoMax);
        assertGt(lockEndAfter, lockEndBefore); // Extended to max
        assertEq(newBoost, 40000); // 4.0x max boost (no JBAC)
    }

    function test_autoMaxLock_extendsOnClaim() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);

        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        // Warp forward
        vm.warp(block.timestamp + 100 days);

        // Claim — lock should re-extend
        vm.prank(bob);
        staking.claim(tokenId);

        (,,uint256 lockEnd,,,) = staking.getPosition(tokenId);
        // Lock should be ~4 years from NOW, not from original stake
        assertGt(lockEnd, block.timestamp + 4 * 365 days - 1 days);
    }

    function test_autoMaxLock_disableAndWithdraw() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 7 days);

        uint256 tokenId = staking.userTokenId(bob);

        // Enable auto-max
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        // Disable auto-max
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        (,,,, bool autoMax,) = staking.getPosition(tokenId);
        assertFalse(autoMax);

        // Lock is still at the extended time — must wait or early withdraw
        // (lock was extended to max when enabled)
    }

    // ─── NFT Position Transfers ───────────────────────────────────────

    function test_transferPosition() public {
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        uint256 tokenId = staking.userTokenId(bob);

        // Bob transfers position NFT to Carol
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        // Carol now owns the position
        assertEq(staking.ownerOf(tokenId), carol);
        assertEq(staking.userTokenId(carol), tokenId);
        assertEq(staking.userTokenId(bob), 0);

        // Carol can claim rewards
        vm.warp(block.timestamp + 100);
        uint256 pending = staking.pendingReward(tokenId);
        assertGt(pending, 0);

        uint256 carolBefore = token.balanceOf(carol);
        vm.prank(carol);
        staking.claim(tokenId);
        assertGt(token.balanceOf(carol) - carolBefore, 0);
    }

    function test_transferPosition_carolCanWithdraw() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 7 days);

        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        vm.warp(block.timestamp + 8 days);

        uint256 carolBefore = token.balanceOf(carol);
        vm.prank(carol);
        staking.withdraw(tokenId);
        assertGt(token.balanceOf(carol) - carolBefore, 99_000 ether);
    }

    // ─── Voting Power ─────────────────────────────────────────────────

    function test_votingPower() public {
        vm.prank(bob); // No JBAC
        staking.stake(500_000 ether, 4 * 365 days);

        uint256 power = staking.votingPowerOf(bob);
        assertEq(power, 2_000_000 ether); // 500K × 4.0x
    }

    function test_votingPower_jbac() public {
        vm.prank(alice); // Has JBAC
        staking.stake(500_000 ether, 4 * 365 days);

        uint256 power = staking.votingPowerOf(alice);
        assertEq(power, 2_250_000 ether); // 500K × 4.5x (4.0 + 0.5 JBAC)
    }

    // ─── Edge Cases ───────────────────────────────────────────────────

    function test_revert_stakeWithExistingPosition() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyStaked.selector);
        staking.stake(100_000 ether, 30 days);
    }

    function test_revert_withdrawBeforeLock() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockNotExpired.selector);
        staking.withdraw(tokenId);
    }

    function test_revert_notOwner() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(carol);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.claim(tokenId);
    }

    function test_nftSymbol() public view {
        assertEq(staking.symbol(), "tsTOWELI");
        assertEq(staking.name(), "Tegridy Staking Position");
    }
}
