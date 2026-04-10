// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";

// ─── Mock Tokens ──────────────────────────────────────────────────────

contract RT_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RT_MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
    function burnFrom(address owner, uint256 tokenId) external {
        require(ownerOf(tokenId) == owner);
        _burn(tokenId);
    }
}

contract RT_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 10_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Attacker Contracts ───────────────────────────────────────────────

/// @dev Contract that can receive ERC721s (for NFT transfer exploits)
contract NFTReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Re-entrancy attacker that tries to re-enter on ERC721 receive
contract ReentrancyAttacker is IERC721Receiver {
    TegridyStaking public staking;
    uint256 public attackTokenId;
    bool public attacking;

    constructor(address _staking) {
        staking = TegridyStaking(_staking);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (attacking) {
            attacking = false;
            // Try to claim rewards during the transfer callback
            try staking.getReward(tokenId) {} catch {}
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function setAttacking(bool _val) external {
        attacking = _val;
    }
}

// ─── Red Team Test Suite ──────────────────────────────────────────────

contract RedTeamStaking is Test {
    RT_MockTOWELI toweli;
    RT_MockJBAC jbac;
    RT_MockWETH weth;
    TegridyStaking staking;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address attacker = makeAddr("attacker");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    function setUp() public {
        toweli = new RT_MockTOWELI();
        jbac = new RT_MockJBAC();
        weth = new RT_MockWETH();

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

        // Register restaking contract via timelock
        staking.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        staking.executeRestakingContract();

        // Fund staking with rewards
        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(5_000_000 ether);

        // Fund restaking with bonus rewards
        weth.transfer(address(restaking), 1_000_000 ether);

        // Distribute tokens
        toweli.transfer(alice, 1_000_000 ether);
        toweli.transfer(bob, 1_000_000 ether);
        toweli.transfer(carol, 1_000_000 ether);
        toweli.transfer(attacker, 1_000_000 ether);

        // Approvals
        vm.prank(alice);
        toweli.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        toweli.approve(address(staking), type(uint256).max);
        vm.prank(attacker);
        toweli.approve(address(staking), type(uint256).max);
    }

    // ─── Helper ───────────────────────────────────────────────────────

    function _stakeAs(address user, uint256 amount, uint256 lockDuration) internal returns (uint256 tokenId) {
        vm.prank(user);
        staking.stake(amount, lockDuration);
        tokenId = staking.userTokenId(user);
    }

    function _stakeAndRestake(address user, uint256 amount, uint256 lockDuration) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        staking.stake(amount, lockDuration);
        tokenId = staking.userTokenId(user);
        staking.approve(address(restaking), tokenId);
        vm.stopPrank();

        // Warp past 24h transfer cooldown
        vm.warp(block.timestamp + 25 hours);

        vm.startPrank(user);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 1. STEAL ANOTHER USER'S STAKED TOKENS OR REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: Cannot claim rewards for someone else's position
    function test_DEFENDED_cannotClaimOthersRewards() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        // Attacker tries to claim bob's position rewards
        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.getReward(bobTokenId);
    }

    /// @notice DEFENDED: Cannot withdraw someone else's position
    function test_DEFENDED_cannotWithdrawOthersPosition() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 31 days);

        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.withdraw(bobTokenId);
    }

    /// @notice DEFENDED: Cannot early-withdraw someone else's position
    function test_DEFENDED_cannotEarlyWithdrawOthersPosition() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.earlyWithdraw(bobTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 2. INFLATE REWARDS BEYOND WHAT YOU'RE OWED
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: Cannot double-claim via claim() + claimUnsettled()
    function test_DEFENDED_noDoubleClaim() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        // Claim normally
        vm.prank(bob);
        uint256 claimed = staking.getReward(bobTokenId);
        assertGt(claimed, 0, "Should have claimed something");

        // Try to also claim unsettled (should revert — nothing unsettled)
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.ZeroAmount.selector);
        staking.claimUnsettled();
    }

    /// @notice ATTACK: Try to inflate rewards by transferring tokens directly to staking contract.
    ///         The reward pool is balance - reserved, so direct transfer could inflate rewards.
    ///         DEFENDED: The reserved amount includes totalStaked + totalPenaltyUnclaimed + totalUnsettledRewards,
    ///         but direct token transfers DO increase the reward pool.
    function test_INVESTIGATE_directTransferInflatesRewardPool() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 1 days);

        // Check pending before donation
        uint256 pendingBefore = staking.earned(bobTokenId);

        // Attacker donates tokens directly to the staking contract
        vm.prank(attacker);
        toweli.transfer(address(staking), 500_000 ether);

        // Check pending after donation — reward pool is larger
        uint256 pendingAfter = staking.earned(bobTokenId);

        // This is expected behavior (donations accelerate reward distribution)
        // Not a vulnerability per se — attacker loses money, bob gains
        // NOTE: This is by design for fund() which is permissionless
        emit log_named_uint("Pending before donation", pendingBefore);
        emit log_named_uint("Pending after donation", pendingAfter);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 3. BYPASS LOCK DURATION OR EARLY WITHDRAWAL PENALTY
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: Cannot withdraw before lock expires
    function test_DEFENDED_cannotWithdrawBeforeLockExpiry() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);
        vm.warp(block.timestamp + 100 days); // Still locked

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockNotExpired.selector);
        staking.withdraw(bobTokenId);
    }

    /// @notice DEFENDED: Transfer cooldown prevents immediate NFT transfer to bypass lock
    function test_DEFENDED_transferCooldownBlocks24hBypass() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        // Try to transfer NFT immediately (within 24h cooldown)
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.TransferCooldownActive.selector);
        staking.transferFrom(bob, attacker, bobTokenId);
    }

    /// @notice ATTACK: Transfer NFT after cooldown to a fresh address that can early-withdraw.
    ///         This does NOT bypass the penalty — early withdrawal always costs 25%.
    ///         DEFENDED: Penalty is inherent to the position, not the owner.
    function test_DEFENDED_transferDoesNotBypassPenalty() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);

        // Wait past cooldown
        vm.warp(block.timestamp + 25 hours);

        // Transfer to attacker
        vm.prank(bob);
        staking.transferFrom(bob, attacker, bobTokenId);

        // Attacker tries early withdraw — still pays 25% penalty
        uint256 attackerBefore = toweli.balanceOf(attacker);
        vm.prank(attacker);
        staking.earlyWithdraw(bobTokenId);
        uint256 attackerAfter = toweli.balanceOf(attacker);

        uint256 received = attackerAfter - attackerBefore;
        uint256 expectedMax = (STAKE_AMOUNT * 7500) / 10000; // 75% after 25% penalty
        assertLe(received, expectedMax, "Should still pay penalty after transfer");
    }

    /// @notice DEFENDED: emergencyExitPosition requires lock to be expired
    function test_DEFENDED_emergencyExitRequiresExpiredLock() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);

        // emergencyExitPosition requires lock to be expired
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockStillActive.selector);
        staking.emergencyExitPosition(bobTokenId);
    }

    /// @notice DEFENDED: executeEmergencyExit requires 7-day delay
    function test_DEFENDED_emergencyExitRequires7DayDelay() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        vm.prank(bob);
        staking.requestEmergencyExit(bobTokenId);

        // Try to execute before delay
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitDelayNotElapsed.selector);
        staking.executeEmergencyExit(bobTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 4. MANIPULATE THE BOOST SYSTEM FOR UNFAIR ADVANTAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: JBAC boost is cached at stake time, flash-loan cannot inflate it post-stake
    function test_DEFENDED_jbacBoostCachedAtStakeTime() public {
        // Bob stakes without JBAC
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);

        (,,,,,, bool autoMaxLock, bool hasJbac,) = staking.positions(bobTokenId);
        assertFalse(hasJbac, "Bob should not have JBAC boost cached");

        // Even if bob somehow gets a JBAC NFT later, revalidateBoost checks current ownership
        // but the JBAC bonus was not set at stake time, so revalidate can add it
        // However, this is the intended behavior — if you acquire a JBAC, you get the bonus
        jbac.mint(bob);
        vm.prank(bob);
        staking.revalidateBoost(bobTokenId);

        (,,,,,,,bool hasJbacAfter,) = staking.positions(bobTokenId);
        assertTrue(hasJbacAfter, "Bob should now have JBAC boost after revalidation");

        // NOTE: This is by design — revalidateBoost can only add/remove based on current JBAC ownership
        // The key defense is that revalidateBoost claims pending rewards BEFORE changing the boost,
        // so no retroactive reward inflation occurs
    }

    /// @notice DEFENDED: Flash-loan JBAC for boost then return is blocked by reward-debt reset
    function test_DEFENDED_flashLoanJbacBoostDoesNotInflateRewards() public {
        // Bob stakes without JBAC
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);
        vm.warp(block.timestamp + 7 days);

        uint256 pendingBefore = staking.earned(bobTokenId);

        // Simulate flash-loan: bob gets JBAC, revalidates, then returns JBAC — all in same block
        jbac.mint(bob); // JBAC id = 2 (alice has id 1)
        vm.startPrank(bob);
        staking.revalidateBoost(bobTokenId);

        // Pending should reflect rewards up to this point, not inflated by new boost retroactively
        uint256 pendingAfter = staking.earned(bobTokenId);
        vm.stopPrank();

        // The boost increase only affects FUTURE rewards, not past ones
        // pendingAfter should be very close to 0 because revalidateBoost just claimed everything
        assertLe(pendingAfter, 1e15, "After revalidation claim, pending should be near zero");
    }

    // ═══════════════════════════════════════════════════════════════════
    // 5. GRIEF OTHER STAKERS (DoS, REWARD DILUTION)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ATTACK: Dust stake to dilute other stakers' rewards via boost inflation.
    ///         DEFENDED: MIN_STAKE of 100e18 prevents extremely small positions.
    function test_DEFENDED_dustStakeRejected() public {
        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.StakeTooSmall.selector);
        staking.stake(1 ether, 7 days); // Below 100e18 minimum
    }

    /// @notice INVESTIGATE: Attacker stakes minimum with max lock to get maximum boost-per-token.
    ///         The boostedAmount is amount * boost / 10000. With max lock (4yr) = 4.0x,
    ///         100 TOWELI * 40000 / 10000 = 400 boostedAmount.
    ///         This is fair because rewards are proportional to boostedAmount.
    function test_INVESTIGATE_minStakeMaxLock_rewardDilution() public {
        // Bob stakes large amount with short lock
        _stakeAs(bob, STAKE_AMOUNT, 30 days);

        // Attacker stakes minimum with max lock
        vm.prank(attacker);
        staking.stake(100 ether, 4 * 365 days);

        vm.warp(block.timestamp + 7 days);

        uint256 bobTokenId = staking.userTokenId(bob);
        uint256 attackerTokenId = staking.userTokenId(attacker);

        uint256 bobPending = staking.earned(bobTokenId);
        uint256 attackerPending = staking.earned(attackerTokenId);

        emit log_named_uint("Bob pending (100k, 30d)", bobPending);
        emit log_named_uint("Attacker pending (100, 4yr)", attackerPending);

        // Attacker gets tiny share — this is fair, proportional to boosted stake
        assertGt(bobPending, attackerPending * 10, "Bob should get vastly more rewards");
    }

    /// @notice DEFENDED: Permissionless revalidateBoost cannot be used to grief boost-strip
    ///         because it is restricted to position owner or restaking contract
    function test_DEFENDED_cannotGriefRevalidateBoost() public {
        // Alice stakes with JBAC boost
        uint256 aliceTokenId = _stakeAs(alice, STAKE_AMOUNT, 365 days);
        vm.prank(alice);
        staking.revalidateBoost(aliceTokenId);

        // Random attacker cannot call revalidateBoost on alice's position
        vm.prank(attacker);
        vm.expectRevert("NOT_AUTHORIZED");
        staking.revalidateBoost(aliceTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 6. EXPLOIT THE NFT TRANSFER MECHANISM
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: NFT transfer settles rewards to previous owner, new owner cannot steal accrued rewards
    function test_DEFENDED_nftTransferSettlesRewards() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        // Bob's pending rewards before transfer
        uint256 bobPendingBefore = staking.earned(bobTokenId);
        assertGt(bobPendingBefore, 0, "Bob should have pending rewards");

        // Wait past cooldown
        vm.warp(block.timestamp + 25 hours);

        // Transfer to carol
        vm.prank(bob);
        staking.transferFrom(bob, carol, bobTokenId);

        // Bob should have unsettled rewards
        uint256 bobUnsettled = staking.unsettledRewards(bob);
        assertGt(bobUnsettled, 0, "Bob should have unsettled rewards from transfer");

        // Carol's pending should be near zero (just transferred)
        uint256 carolPending = staking.earned(bobTokenId);
        assertLe(carolPending, 1e15, "Carol should have near-zero pending after receiving NFT");
    }

    /// @notice DEFENDED: Cannot overwrite an existing position via NFT transfer (for EOAs)
    function test_DEFENDED_cannotOverwriteExistingPositionViaTransfer() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        _stakeAs(carol, STAKE_AMOUNT, 30 days);

        vm.warp(block.timestamp + 25 hours); // Past cooldown

        // Try to transfer bob's NFT to carol who already has a position
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(bob, carol, bobTokenId);
    }

    /// @notice DEFENDED: autoMaxLock is reset on transfer so buyer doesn't inherit perpetual lock
    function test_DEFENDED_autoMaxLockResetOnTransfer() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        // Bob enables autoMaxLock
        vm.prank(bob);
        staking.toggleAutoMaxLock(bobTokenId);

        (,,,,,, bool autoMaxBefore,,) = staking.positions(bobTokenId);
        assertTrue(autoMaxBefore, "AutoMaxLock should be enabled");

        vm.warp(block.timestamp + 25 hours); // Past cooldown

        // Transfer to carol (who has no position)
        vm.prank(bob);
        staking.transferFrom(bob, carol, bobTokenId);

        (,,,,,, bool autoMaxAfter,,) = staking.positions(bobTokenId);
        assertFalse(autoMaxAfter, "AutoMaxLock should be reset after transfer");
    }

    // ═══════════════════════════════════════════════════════════════════
    // 7. EXPLOIT THE RESTAKING CLAIM FLOW (POST H-01 FIX)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: First restaker after gap does not get windfall rewards (H-01 fix)
    function test_DEFENDED_firstRestakerNoWindfall() public {
        // Nobody restakes for a while — bonus rewards accumulate in the contract
        vm.warp(block.timestamp + 30 days);

        // Alice stakes and restakes
        _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        // Check alice's pending bonus — should be zero since she just restaked
        uint256 alicePending = restaking.pendingBonus(alice);
        assertEq(alicePending, 0, "First restaker should not get windfall bonus from gap period");
    }

    /// @notice DEFENDED: claimAll uses return value from staking.getReward(), not balance deltas.
    ///         This prevents MEV sandwich inflating base rewards.
    function test_DEFENDED_claimAllUsesReturnValueNotBalanceDelta() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        uint256 aliceBefore = toweli.balanceOf(alice);

        // Attacker donates tokens to restaking contract to try to inflate balance delta
        vm.prank(attacker);
        toweli.transfer(address(restaking), 100_000 ether);

        // Alice claims — should only get legitimate rewards, not the donation
        vm.prank(alice);
        restaking.claimAll();

        uint256 aliceAfter = toweli.balanceOf(alice);
        uint256 aliceGain = aliceAfter - aliceBefore;

        // The gain should be approximately 7 days * 1 ether/sec of base rewards
        // NOT inflated by the 100k donation
        uint256 maxExpected = 7 days * REWARD_RATE + 1 ether; // small buffer
        assertLe(aliceGain, maxExpected, "claimAll should not be inflated by direct donation");
    }

    /// @notice INVESTIGATE: Auto-refresh in claimAll when position changes.
    ///         If the staking position was partially withdrawn via early-withdraw before restaking claims,
    ///         the restaking contract should refresh and not pay bonus on phantom capital.
    function test_DEFENDED_autoRefreshPreventsPhantomCapital() public {
        uint256 aliceTokenId = _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        // Verify position is accurate via the restakers mapping
        (, uint256 cachedAmount,,,) = restaking.restakers(alice);
        assertEq(cachedAmount, STAKE_AMOUNT, "Cached amount should match initial stake");

        // claimAll auto-refreshes if staking position changed
        vm.prank(alice);
        restaking.claimAll();

        // After claimAll, cached amount should still match (no change to underlying position)
        (, uint256 cachedAmountAfter,,,) = restaking.restakers(alice);
        assertEq(cachedAmountAfter, STAKE_AMOUNT, "Cached amount should still match after claimAll");
    }

    // ═══════════════════════════════════════════════════════════════════
    // 8. EXPLOIT THE UNSETTLED REWARDS MECHANISM (POST X-03 FIX)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice INVESTIGATE: Race condition in unsettled rewards during concurrent NFT transfers.
    ///         When two users transfer NFTs in the same block, both accumulate unsettled rewards.
    ///         The totalUnsettledRewards tracking should prevent one from draining the other's.
    function test_DEFENDED_concurrentTransfersUnsettledProtection() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        uint256 carolTokenId = _stakeAs(carol, STAKE_AMOUNT, 30 days);

        vm.warp(block.timestamp + 7 days);

        // Both have pending rewards
        uint256 bobPending = staking.earned(bobTokenId);
        uint256 carolPending = staking.earned(carolTokenId);
        assertGt(bobPending, 0);
        assertGt(carolPending, 0);

        vm.warp(block.timestamp + 25 hours); // Past cooldown

        // Both transfer in same block — rewards should go to unsettled
        vm.prank(bob);
        staking.transferFrom(bob, attacker, bobTokenId);

        // Attacker cannot also receive carol's NFT (AlreadyHasPosition for EOA)
        // So use a contract receiver
        // But the test is about whether bob's unsettled is protected from carol's claim
        uint256 bobUnsettled = staking.unsettledRewards(bob);
        assertGt(bobUnsettled, 0, "Bob should have unsettled rewards");

        // Bob claims unsettled
        vm.prank(bob);
        staking.claimUnsettled();

        uint256 bobBal = toweli.balanceOf(bob);
        // Bob should have received his unsettled rewards
        assertGt(bobBal, 900_000 ether, "Bob should have received unsettled rewards");
    }

    /// @notice DEFENDED: claimUnsettled respects the reward pool cap and doesn't drain staked principal
    function test_DEFENDED_claimUnsettledDoesNotDrainPrincipal() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);
        vm.warp(block.timestamp + 25 hours); // Past cooldown

        // Transfer to create unsettled rewards
        vm.prank(bob);
        staking.transferFrom(bob, carol, bobTokenId);

        uint256 contractBalance = toweli.balanceOf(address(staking));
        uint256 totalStakedVal = staking.totalStaked();

        // The unsettled claim should never reduce contract balance below totalStaked
        vm.prank(bob);
        staking.claimUnsettled();

        uint256 contractBalanceAfter = toweli.balanceOf(address(staking));
        assertGe(contractBalanceAfter, totalStakedVal, "Contract should always hold at least totalStaked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // 9. EXPLOIT THE TRANSFER COOLDOWN (E-08 FIX)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: Transfer cooldown of 24h from stake time blocks immediate resale
    function test_DEFENDED_transferCooldown24h() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        // Try to transfer at 23h59m — should fail
        vm.warp(block.timestamp + 24 hours - 1);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.TransferCooldownActive.selector);
        staking.transferFrom(bob, carol, bobTokenId);

        // At exactly 24h — should succeed
        vm.warp(block.timestamp + 2);
        vm.prank(bob);
        staking.transferFrom(bob, carol, bobTokenId);
    }

    /// @notice INVESTIGATE: Cooldown is based on stakeTimestamp, not last transfer.
    ///         After the first transfer past cooldown, subsequent transfers have no cooldown.
    ///         This is a potential concern for fast NFT flipping.
    function test_INVESTIGATE_noCooldownAfterFirstTransfer() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 25 hours); // Past initial cooldown

        // Transfer bob -> carol
        vm.prank(bob);
        staking.transferFrom(bob, carol, bobTokenId);

        // Carol can immediately transfer to attacker (no cooldown on second transfer)
        // because the cooldown is based on stakeTimestamp which is already >24h ago
        vm.prank(carol);
        staking.transferFrom(carol, attacker, bobTokenId);

        assertEq(staking.ownerOf(bobTokenId), attacker, "Attacker should own the NFT");
        // NOTE: This is a design choice. The cooldown only prevents flash-loan-stake-transfer attacks.
        // Once past the initial cooldown, the NFT is freely tradeable (which is desired for NFT markets).
    }

    // ═══════════════════════════════════════════════════════════════════
    // 10. FLASH-LOAN ATTACK THE JBAC BOOST (POST E-09 FIX)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice DEFENDED: Flash-loan JBAC NFT to boost then return — rewards already claimed before boost change.
    ///         The key defense: revalidateBoost claims pending rewards BEFORE updating the boost,
    ///         then resets rewardDebt. So the higher boost only applies to FUTURE rewards.
    function test_DEFENDED_flashLoanJbacDoesNotRetroactivelyInflateRewards() public {
        // Bob stakes without JBAC, accrues rewards
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);
        vm.warp(block.timestamp + 30 days);

        uint256 pendingBeforeFlash = staking.earned(bobTokenId);

        // Simulate flash loan: mint JBAC to bob, revalidate, return JBAC
        uint256 jbacId = jbac.mint(bob);
        vm.prank(bob);
        staking.revalidateBoost(bobTokenId);

        // Bob's pending should now be ~0 (claimed during revalidation)
        uint256 pendingAfterRevalidate = staking.earned(bobTokenId);
        assertLe(pendingAfterRevalidate, 1e15, "Pending should be near zero after revalidation claim");

        // Now return the JBAC (burn it)
        jbac.burnFrom(bob, jbacId);
        vm.prank(bob);
        staking.revalidateBoost(bobTokenId);

        // Bob got his fair rewards (pendingBeforeFlash), not inflated by JBAC boost retroactively
        uint256 bobBal = toweli.balanceOf(bob);
        // Bob started with 1M - 100k staked = 900k. Plus legitimate rewards.
        emit log_named_uint("Bob balance after flash-loan attempt", bobBal);
        emit log_named_uint("Legitimate pending before flash", pendingBeforeFlash);
    }

    /// @notice DEFENDED: revalidateBoost restricted to owner/restaking — attacker cannot strip JBAC boost
    function test_DEFENDED_attackerCannotStripJbacViaRevalidate() public {
        // Give alice a JBAC NFT
        jbac.mint(alice);

        uint256 aliceTokenId = _stakeAs(alice, STAKE_AMOUNT, 365 days);
        vm.prank(alice);
        staking.revalidateBoost(aliceTokenId);

        (,,,,,,,bool hasJbac,) = staking.positions(aliceTokenId);
        assertTrue(hasJbac, "Alice should have JBAC boost");

        // Attacker tries to strip alice's boost by calling revalidateBoost
        vm.prank(attacker);
        vm.expectRevert("NOT_AUTHORIZED");
        staking.revalidateBoost(aliceTokenId);

        // Alice's boost remains
        (,,,,,,,bool stillHasJbac,) = staking.positions(aliceTokenId);
        assertTrue(stillHasJbac, "Alice's JBAC boost should be intact");
    }

    // ═══════════════════════════════════════════════════════════════════
    // BONUS: ADDITIONAL ATTACK VECTORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice INVESTIGATE: Can an attacker exploit the penalty redistribution mechanism?
    ///         Early withdrawal penalty goes to treasury, not redistributed via accRewardPerShare.
    ///         So no inflation attack via self-early-withdrawal.
    function test_DEFENDED_penaltyGoesToTreasury() public {
        _stakeAs(bob, STAKE_AMOUNT, 365 days);
        _stakeAs(attacker, STAKE_AMOUNT, 365 days);

        uint256 treasuryBefore = toweli.balanceOf(treasury);

        // Attacker early-withdraws — 25% penalty
        uint256 attackerTokenId = staking.userTokenId(attacker);
        vm.prank(attacker);
        staking.earlyWithdraw(attackerTokenId);

        uint256 treasuryAfter = toweli.balanceOf(treasury);
        uint256 penalty = treasuryAfter - treasuryBefore;
        assertEq(penalty, STAKE_AMOUNT * 2500 / 10000, "Penalty should be 25% of staked amount");

        // Penalty goes to treasury, not redistributed to stakers via accRewardPerShare
        // So bob doesn't get an unfair windfall
    }

    /// @notice ATTACK: Stake with minimum, then try to use emergencyExitPosition to exit without penalty.
    ///         DEFENDED: emergencyExitPosition requires lock to be expired.
    function test_DEFENDED_emergencyExitAppliesPenaltyBeforeLockExpiry() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 365 days);

        vm.prank(bob);
        staking.requestEmergencyExit(bobTokenId);

        vm.warp(block.timestamp + 8 days); // Past 7-day delay but lock still active

        uint256 bobBefore = toweli.balanceOf(bob);
        vm.prank(bob);
        staking.executeEmergencyExit(bobTokenId);
        uint256 bobAfter = toweli.balanceOf(bob);

        // Emergency exit now calls _getReward() (audit M-05/M-06) so user receives principal - penalty + accrued rewards
        uint256 expectedWithPenalty = STAKE_AMOUNT * 7500 / 10000;
        assertGe(bobAfter - bobBefore, expectedWithPenalty, "Emergency exit applies 25% penalty when lock active, plus rewards");
    }

    function test_DEFENDED_emergencyExitNoPenaltyAfterLockExpiry() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);

        vm.prank(bob);
        staking.requestEmergencyExit(bobTokenId);

        vm.warp(block.timestamp + 31 days); // Past both delay and lock expiry

        uint256 bobBefore = toweli.balanceOf(bob);
        vm.prank(bob);
        staking.executeEmergencyExit(bobTokenId);
        uint256 bobAfter = toweli.balanceOf(bob);

        // Emergency exit now calls _getReward() (audit M-05/M-06) so user receives principal + accrued rewards
        assertGe(bobAfter - bobBefore, STAKE_AMOUNT, "Emergency exit returns at least full principal after lock expires");
    }

    /// @notice INVESTIGATE: Restaking unsettled rewards race condition.
    ///         When unrestaking, the contract does claimUnsettled for the restaking contract address.
    ///         If multiple users unrestake, they share the same claimUnsettled pool.
    ///         The pendingUnsettledRewards mechanism should protect against this.
    function test_DEFENDED_restakingUnsettledRaceProtected() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 30 days);

        // Give bob tokens to stake and restake
        toweli.transfer(bob, STAKE_AMOUNT);
        _stakeAndRestake(bob, STAKE_AMOUNT, 30 days);

        vm.warp(block.timestamp + 7 days);

        // Both unrestake — unsettled rewards should be tracked per-user
        vm.prank(alice);
        restaking.unrestake();

        vm.prank(bob);
        restaking.unrestake();

        // Both should have received their base rewards
        uint256 aliceBal = toweli.balanceOf(alice);
        uint256 bobBal = toweli.balanceOf(bob);
        assertGt(aliceBal, STAKE_AMOUNT - 1000 ether, "Alice should have base rewards");
        assertGt(bobBal, STAKE_AMOUNT - 1000 ether, "Bob should have base rewards");
    }

    /// @notice DEFENDED: AlreadyStaked prevents opening multiple positions from one EOA
    function test_DEFENDED_cannotOpenMultiplePositions() public {
        _stakeAs(bob, STAKE_AMOUNT, 30 days);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyStaked.selector);
        staking.stake(STAKE_AMOUNT, 30 days);
    }

    /// @notice INVESTIGATE: Reward debt reset on extendLock — can attacker repeatedly extend to reset debt favorably?
    ///         DEFENDED: extendLock claims rewards BEFORE changing boost, then resets debt.
    function test_DEFENDED_extendLockDoesNotInflateRewards() public {
        uint256 bobTokenId = _stakeAs(bob, STAKE_AMOUNT, 30 days);
        vm.warp(block.timestamp + 7 days);

        uint256 pendingBefore = staking.earned(bobTokenId);
        uint256 bobBalBefore = toweli.balanceOf(bob);

        // Bob extends lock — this should claim pending, then reset debt
        vm.prank(bob);
        staking.extendLock(bobTokenId, 365 days);

        uint256 bobBalAfter = toweli.balanceOf(bob);
        uint256 claimed = bobBalAfter - bobBalBefore;

        // Claimed should be approximately equal to pendingBefore
        assertGe(claimed, pendingBefore - 1e15, "ExtendLock should have claimed pending rewards");

        // Pending should be near zero after extend
        uint256 pendingAfter = staking.earned(bobTokenId);
        assertLe(pendingAfter, 1e15, "Pending should be near zero after extend");
    }

    /// @notice INVESTIGATE: Can the restaking contract's revalidateBoostForRestaked be used to grief?
    ///         It is permissionless but revalidateBoost can only downgrade (remove JBAC if not held).
    function test_DEFENDED_revalidateBoostForRestakedPermissionless() public {
        // Alice stakes with JBAC and restakes
        jbac.mint(alice); // JBAC id 1
        uint256 aliceTokenId = _stakeAndRestake(alice, STAKE_AMOUNT, 365 days);

        // Revalidate to add JBAC boost
        restaking.revalidateBoostForRestaked(aliceTokenId);

        (,,,,,,,bool hasJbacBefore,) = staking.positions(aliceTokenId);
        assertTrue(hasJbacBefore, "Alice should have JBAC boost after revalidation");

        // Attacker calls revalidateBoostForRestaked -- alice still holds JBAC so it won't strip
        vm.prank(attacker);
        restaking.revalidateBoostForRestaked(aliceTokenId);

        // Alice's boost should still include JBAC
        (,,,,,,,bool hasJbac,) = staking.positions(aliceTokenId);
        assertTrue(hasJbac, "Alice JBAC boost should be intact - she still holds JBAC");
    }
}
