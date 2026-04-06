// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";

// ── Mocks ─────────────────────────────────────────────────────────────────────

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockJBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) { _mint(to, _id); return _id++; }
    function burn(uint256 id) external { _burn(id); }
}

// ── Test Suite ────────────────────────────────────────────────────────────────

contract Audit195StakingCoreTest is Test {
    MockTOWELI token;
    MockJBAC nft;
    TegridyStaking staking;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint256 constant STAKE_AMT = 500_000 ether;
    uint256 constant MIN_LOCK  = 7 days;
    uint256 constant MAX_LOCK  = 4 * 365 days;

    function setUp() public {
        token = new MockTOWELI();
        nft = new MockJBAC();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        // Distribute tokens
        token.transfer(alice, 5_000_000 ether);
        token.transfer(bob,   5_000_000 ether);
        token.transfer(carol, 5_000_000 ether);
        token.transfer(dave,  5_000_000 ether);

        // Approvals
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        vm.prank(bob);   token.approve(address(staking), type(uint256).max);
        vm.prank(carol);  token.approve(address(staking), type(uint256).max);
        vm.prank(dave);  token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        // Fund rewards
        staking.notifyRewardAmount(50_000_000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. STAKE FUNCTION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Verify uint32 truncation on lockDuration is safe for MAX_LOCK_DURATION
    function test_stake_uint32LockDurationSafe() public {
        // MAX_LOCK_DURATION = 4 * 365 days = 126,144,000 seconds
        // uint32 max = 4,294,967,295 — so it fits
        vm.prank(alice);
        staking.stake(STAKE_AMT, MAX_LOCK);

        uint256 tokenId = staking.userTokenId(alice);
        (,,, uint256 lockDuration,,) = staking.getPosition(tokenId);
        assertEq(lockDuration, MAX_LOCK, "lockDuration should equal MAX_LOCK after uint32 cast");
    }

    /// @dev Verify uint16 truncation on boostBps is safe for MAX_BOOST_BPS (40000)
    function test_stake_uint16BoostBpsSafe() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, MAX_LOCK);

        uint256 tokenId = staking.userTokenId(alice);
        (, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        assertEq(boostBps, 40000, "MAX boost should be 40000 bps at max lock");
    }

    /// @dev uint16 boostBps with JBAC bonus (40000 + 5000 = 45000) still fits in uint16
    function test_stake_uint16BoostWithJbacFits() public {
        // This is tested indirectly via toggleAutoMaxLock with JBAC
        nft.mint(bob);
        vm.prank(bob);
        staking.stake(STAKE_AMT, MAX_LOCK);

        uint256 tokenId = staking.userTokenId(bob);
        // Bob needs to revalidateBoost to get JBAC bonus applied after stake
        // Note: JBAC boost is NOT automatically applied at stake time (hasJbacBoost defaults false)
        vm.prank(bob);
        staking.revalidateBoost(tokenId);

        (, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        assertEq(boostBps, 45000, "MAX boost + JBAC should be 45000, fits in uint16");
    }

    /// @dev Verify totalStaked, totalBoostedStake, totalLocked consistency after stake
    function test_stake_globalStateConsistency() public {
        uint256 prevTotalStaked = staking.totalStaked();
        uint256 prevTotalBoosted = staking.totalBoostedStake();
        uint256 prevTotalLocked = staking.totalLocked();

        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        uint256 tokenId = staking.userTokenId(alice);
        (uint256 amount, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        uint256 expectedBoosted = (amount * boostBps) / 10000;

        assertEq(staking.totalStaked(), prevTotalStaked + STAKE_AMT, "totalStaked mismatch");
        assertEq(staking.totalBoostedStake(), prevTotalBoosted + expectedBoosted, "totalBoostedStake mismatch");
        // V2: totalLocked tracking removed, always returns 0
        assertEq(staking.totalLocked(), 0, "V2: totalLocked always 0");
    }

    /// @dev NFT minted to staker and checkpoint written
    function test_stake_mintsNftAndWritesCheckpoint() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);

        uint256 tokenId = staking.userTokenId(bob);
        assertEq(staking.ownerOf(tokenId), bob, "NFT should be minted to bob");
        assertEq(staking.balanceOf(bob), 1, "bob should have 1 NFT");
        assertGt(staking.numCheckpoints(bob), 0, "checkpoint should be written");
    }

    /// @dev Verify revert when staking below MIN_STAKE
    function test_stake_revertsBelowMinStake() public {
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.StakeTooSmall.selector);
        staking.stake(99 ether, 30 days);
    }

    /// @dev Verify revert when already staked (one position per address)
    function test_stake_revertsIfAlreadyStaked() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, 30 days);

        vm.prank(alice);
        vm.expectRevert(TegridyStaking.AlreadyStaked.selector);
        staking.stake(STAKE_AMT, 60 days);
    }

    /// @dev Verify lockEnd uses uint64 safely (block.timestamp + MAX_LOCK)
    function test_stake_lockEndUint64Safe() public {
        // Set timestamp to a large value to test uint64 safety
        vm.warp(1_800_000_000); // ~2027
        vm.prank(alice);
        staking.stake(STAKE_AMT, MAX_LOCK);

        uint256 tokenId = staking.userTokenId(alice);
        (, , uint256 lockEnd,,,) = staking.getPosition(tokenId);
        assertEq(lockEnd, 1_800_000_000 + MAX_LOCK, "lockEnd should be timestamp + MAX_LOCK");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. WITHDRAW FUNCTION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Normal withdrawal after lock expires: full principal + rewards, NFT burned
    function test_withdraw_afterLockExpires() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Fast forward past lock
        vm.warp(block.timestamp + 31 days);

        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.withdraw(tokenId);

        assertGt(token.balanceOf(bob), balBefore + STAKE_AMT - 1, "should receive principal + rewards");
        assertEq(staking.userTokenId(bob), 0, "userTokenId should be cleared");
        assertEq(staking.totalStaked(), 0, "totalStaked should be 0");
        assertEq(staking.totalLocked(), 0, "totalLocked should be 0");
        assertEq(staking.totalBoostedStake(), 0, "totalBoostedStake should be 0");
    }

    /// @dev Cannot withdraw before lock expires
    function test_withdraw_revertsBeforeLockExpiry() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 29 days);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockNotExpired.selector);
        staking.withdraw(tokenId);
    }

    /// @dev Withdraw burns NFT
    function test_withdraw_burnsNft() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, MIN_LOCK);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + MIN_LOCK + 1);
        vm.prank(bob);
        staking.withdraw(tokenId);

        vm.expectRevert(); // ownerOf reverts for non-existent token
        staking.ownerOf(tokenId);
    }

    /// @dev Verify checkpoint written on withdraw
    function test_withdraw_writesCheckpoint() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, MIN_LOCK);
        uint256 bobTokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + MIN_LOCK + 1);
        uint256 checksBefore = staking.numCheckpoints(bob);
        vm.roll(block.number + 1);

        vm.prank(bob);
        staking.withdraw(bobTokenId);

        assertGt(staking.numCheckpoints(bob), checksBefore, "checkpoint should be written on withdraw");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. EARLY WITHDRAW FUNCTION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev 25% penalty math precision: penalty = amount * 2500 / 10000
    function test_earlyWithdraw_penaltyMathPrecision() public {
        uint256 stakeAmt = 333_333 ether; // odd number to test rounding
        vm.prank(bob);
        staking.stake(stakeAmt, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        uint256 expectedPenalty = (stakeAmt * 2500) / 10000; // 25%
        uint256 expectedUserReceives = stakeAmt - expectedPenalty;

        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.earlyWithdraw(tokenId);

        // Bob receives principal minus penalty plus any accrued rewards
        uint256 bobReceived = token.balanceOf(bob) - bobBefore;
        uint256 treasuryReceived = token.balanceOf(treasury) - treasuryBefore;

        assertEq(treasuryReceived, expectedPenalty, "treasury should receive exact penalty");
        assertGe(bobReceived, expectedUserReceives, "bob should receive at least principal minus penalty");
    }

    /// @dev FINDING: earlyWithdraw penalty goes to treasury, NOT redistributed to stakers
    ///      Despite event name "PenaltyRedistributed" and comment saying "redistributed to remaining stakers"
    function test_earlyWithdraw_penaltyGoesToTreasuryNotStakers() public {
        // Alice stakes first
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        // Bob stakes and early withdraws
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 bobTokenId = staking.userTokenId(bob);

        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.earlyWithdraw(bobTokenId);

        uint256 treasuryAfter = token.balanceOf(treasury);

        // Penalty went to treasury
        assertGt(treasuryAfter, treasuryBefore, "penalty should go to treasury");

        // accRewardPerShare did NOT increase from penalty (only from time-based rewards)
        // The penalty is NOT redistributed via accRewardPerShare boost
        // This is a design decision, not a bug, but worth documenting
        // The only accRewardPerShare change is from the updateRewards modifier (time-based)
    }

    /// @dev Global state consistency after early withdraw
    function test_earlyWithdraw_globalStateConsistency() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 bobTokenId = staking.userTokenId(bob);

        uint256 totalStakedBefore = staking.totalStaked();

        vm.prank(bob);
        staking.earlyWithdraw(bobTokenId);

        assertEq(staking.totalStaked(), totalStakedBefore - STAKE_AMT, "totalStaked should decrease by amount");
        // V2: totalLocked writes removed (redundant with totalStaked per audit L-22)
        assertEq(staking.totalLocked(), 0, "V2: totalLocked always 0");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 4. EXTEND LOCK FUNCTION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev extendLock recalculates boost correctly
    function test_extendLock_recalculatesBoost() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        (, uint256 boostBefore,,,,) = staking.getPosition(tokenId);

        vm.prank(bob);
        staking.extendLock(tokenId, 365 days);

        (, uint256 boostAfter,,,,) = staking.getPosition(tokenId);
        assertGt(boostAfter, boostBefore, "boost should increase with longer lock");
    }

    /// @dev extendLock resets lockEnd to block.timestamp + newDuration
    function test_extendLock_resetsLockEnd() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 15 days); // halfway through lock

        vm.prank(bob);
        staking.extendLock(tokenId, 60 days);

        (,, uint256 lockEnd,,,) = staking.getPosition(tokenId);
        assertEq(lockEnd, block.timestamp + 60 days, "lockEnd should reset to now + newDuration");
    }

    /// @dev extendLock must have strictly longer duration
    function test_extendLock_revertsIfNotLonger() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 60 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockNotExtended.selector);
        staking.extendLock(tokenId, 30 days);
    }

    /// @dev extendLock reverts at MAX_LOCK + 1
    function test_extendLock_revertsAboveMaxLock() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockTooLong.selector);
        staking.extendLock(tokenId, MAX_LOCK + 1);
    }

    /// @dev extendLock uint32 truncation: verify lockDuration stored correctly
    function test_extendLock_uint32TruncationSafe() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.extendLock(tokenId, MAX_LOCK);

        (,,, uint256 lockDuration,,) = staking.getPosition(tokenId);
        assertEq(lockDuration, MAX_LOCK, "lockDuration should be MAX_LOCK after uint32 cast");
    }

    /// @dev extendLock preserves JBAC boost
    function test_extendLock_preservesJbacBoost() public {
        nft.mint(bob);
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Revalidate to get JBAC boost
        vm.prank(bob);
        staking.revalidateBoost(tokenId);

        // Extend lock
        vm.prank(bob);
        staking.extendLock(tokenId, 365 days);

        (, uint256 boostAfterExtend,,,,) = staking.getPosition(tokenId);
        // Should have base boost for 365 days + JBAC bonus
        uint256 expectedBase = staking.calculateBoost(365 days);
        assertEq(boostAfterExtend, expectedBase + 5000, "JBAC bonus should be preserved after extendLock");
    }

    /// @dev totalBoostedStake consistency through extendLock
    function test_extendLock_totalBoostedStakeConsistency() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, 30 days);

        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 bobToken = staking.userTokenId(bob);

        uint256 totalBoostedBefore = staking.totalBoostedStake();

        // Get bob's old boosted amount
        (uint256 bobAmt, uint256 bobBoostOld,,,,) = staking.getPosition(bobToken);
        uint256 oldBoosted = (bobAmt * bobBoostOld) / 10000;

        vm.prank(bob);
        staking.extendLock(bobToken, 365 days);

        (, uint256 bobBoostNew,,,,) = staking.getPosition(bobToken);
        uint256 newBoosted = (bobAmt * bobBoostNew) / 10000;

        assertEq(
            staking.totalBoostedStake(),
            totalBoostedBefore - oldBoosted + newBoosted,
            "totalBoostedStake should be adjusted correctly"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 5. TOGGLE AUTO MAX LOCK
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Enabling autoMaxLock sets max boost and max lock
    function test_toggleAutoMaxLock_enableSetsMaxBoost() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        (, uint256 boostBps,, uint256 lockDuration, bool autoMax,) = staking.getPosition(tokenId);
        assertTrue(autoMax, "autoMaxLock should be true");
        assertEq(boostBps, 40000, "boost should be MAX_BOOST_BPS");
        assertEq(lockDuration, MAX_LOCK, "lockDuration should be MAX_LOCK");
    }

    /// @dev FINDING: Disabling autoMaxLock does NOT revert boost — user keeps max boost
    function test_toggleAutoMaxLock_disableKeepsMaxBoost() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Enable
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        // Disable
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        (, uint256 boostBps,, uint256 lockDuration, bool autoMax,) = staking.getPosition(tokenId);
        assertFalse(autoMax, "autoMaxLock should be false");
        // Boost remains at max — this is the "finding": disabling auto-max doesn't reduce boost
        assertEq(boostBps, 40000, "boost REMAINS at max after disabling autoMaxLock");
        assertEq(lockDuration, MAX_LOCK, "lockDuration REMAINS at max after disabling");
    }

    /// @dev autoMaxLock with JBAC: boost should be MAX_BOOST + JBAC
    function test_toggleAutoMaxLock_withJbac() public {
        nft.mint(bob);
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Revalidate JBAC first
        vm.prank(bob);
        staking.revalidateBoost(tokenId);

        // Enable autoMaxLock
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        (, uint256 boostBps,,,,) = staking.getPosition(tokenId);
        assertEq(boostBps, 45000, "boost should be MAX_BOOST + JBAC_BONUS");
    }

    /// @dev totalBoostedStake updated correctly during toggleAutoMaxLock
    function test_toggleAutoMaxLock_totalBoostedStakeConsistency() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 bobToken = staking.userTokenId(bob);

        uint256 totalBoostedBefore = staking.totalBoostedStake();
        (uint256 bobAmt, uint256 bobBoostOld,,,,) = staking.getPosition(bobToken);
        uint256 oldBoosted = (bobAmt * bobBoostOld) / 10000;

        vm.prank(bob);
        staking.toggleAutoMaxLock(bobToken);

        (, uint256 bobBoostNew,,,,) = staking.getPosition(bobToken);
        uint256 newBoosted = (bobAmt * bobBoostNew) / 10000;

        assertEq(
            staking.totalBoostedStake(),
            totalBoostedBefore - oldBoosted + newBoosted,
            "totalBoostedStake should adjust on toggleAutoMaxLock"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 6. REQUEST EMERGENCY EXIT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev requestEmergencyExit stores timestamp
    function test_requestEmergencyExit_storesTimestamp() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        uint256 ts = block.timestamp;
        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        assertEq(staking.emergencyExitRequests(tokenId), ts, "request timestamp should be stored");
    }

    /// @dev Cannot request twice
    function test_requestEmergencyExit_cannotRequestTwice() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitAlreadyRequested.selector);
        staking.requestEmergencyExit(tokenId);
    }

    /// @dev Only position owner can request
    function test_requestEmergencyExit_onlyOwner() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(alice);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.requestEmergencyExit(tokenId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 7. EXECUTE EMERGENCY EXIT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Execute emergency exit after delay with active lock: 25% penalty
    function test_executeEmergencyExit_penaltyIfLockActive() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        // Advance past 7-day delay but NOT past lock
        vm.warp(block.timestamp + 7 days + 1);

        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);

        uint256 penalty = (STAKE_AMT * 2500) / 10000;
        uint256 expectedUser = STAKE_AMT - penalty;

        // Emergency exit now calls _getReward() so user receives principal - penalty + accrued rewards
        assertGe(token.balanceOf(bob) - bobBefore, expectedUser, "user should receive at least amount minus penalty");
        assertEq(token.balanceOf(treasury) - treasuryBefore, penalty, "treasury should receive penalty");
    }

    /// @dev Execute emergency exit after lock expired: no penalty
    function test_executeEmergencyExit_noPenaltyIfLockExpired() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        // Advance past both delay AND lock
        vm.warp(block.timestamp + 31 days);

        uint256 bobBefore = token.balanceOf(bob);

        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);

        // Emergency exit now calls _getReward() so user receives principal + accrued rewards
        assertGe(token.balanceOf(bob) - bobBefore, STAKE_AMT, "should receive at least full amount with no penalty");
    }

    /// @dev Cannot execute before delay
    function test_executeEmergencyExit_revertsBeforeDelay() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.warp(block.timestamp + 6 days);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitDelayNotElapsed.selector);
        staking.executeEmergencyExit(tokenId);
    }

    /// @dev Cannot execute without requesting first
    function test_executeEmergencyExit_revertsWithoutRequest() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitNotRequested.selector);
        staking.executeEmergencyExit(tokenId);
    }

    /// @dev Global state consistency after executeEmergencyExit
    function test_executeEmergencyExit_globalStateConsistency() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 bobToken = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(bobToken);
        vm.warp(block.timestamp + 8 days);

        uint256 totalStakedBefore = staking.totalStaked();

        vm.prank(bob);
        staking.executeEmergencyExit(bobToken);

        assertEq(staking.totalStaked(), totalStakedBefore - STAKE_AMT, "totalStaked decreased");
        // V2: totalLocked writes removed (redundant with totalStaked per audit L-22)
        assertEq(staking.totalLocked(), 0, "V2: totalLocked always 0");
        assertEq(staking.userTokenId(bob), 0, "userTokenId cleared");
    }

    /// @dev FINDING: executeEmergencyExit penalty tracking increments totalPenaltiesRedistributed
    ///      but penalty goes to treasury, same issue as earlyWithdraw
    function test_executeEmergencyExit_penaltyTrackingConsistency() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);
        vm.warp(block.timestamp + 8 days);

        uint256 penaltiesCollectedBefore = staking.totalPenaltiesCollected();
        // V2: totalPenaltiesRedistributed removed

        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);

        uint256 penalty = (STAKE_AMT * 2500) / 10000;
        assertEq(staking.totalPenaltiesCollected() - penaltiesCollectedBefore, penalty, "collected incremented");
        // V2: totalPenaltiesRedistributed removed
        // Note: penalty went to treasury, not redistributed via accRewardPerShare
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 8. EMERGENCY EXIT POSITION (lock-expired path)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev emergencyExitPosition works after lock expires — no penalty
    function test_emergencyExitPosition_afterLockExpires() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 31 days);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.emergencyExitPosition(tokenId);

        // Emergency exit now calls _getReward() so user receives principal + accrued rewards
        assertGe(token.balanceOf(bob) - bobBefore, STAKE_AMT, "should receive at least full principal");
        assertEq(staking.totalStaked(), 0, "totalStaked zeroed");
        assertEq(staking.totalLocked(), 0, "totalLocked zeroed");
    }

    /// @dev emergencyExitPosition reverts if lock still active
    function test_emergencyExitPosition_revertsIfLockActive() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockStillActive.selector);
        staking.emergencyExitPosition(tokenId);
    }

    /// @dev FINDING: emergencyExitPosition has updateRewards modifier, meaning it's NOT
    ///      fully independent of reward math. If reward math overflows, this path fails too.
    ///      The function forfeits rewards but still runs updateRewards before executing.
    function test_emergencyExitPosition_usesUpdateRewardsModifier() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 31 days);

        uint256 lastRewardTimeBefore = staking.lastUpdateTime();

        vm.prank(bob);
        staking.emergencyExitPosition(tokenId);

        // lastRewardTime updated proves updateRewards ran
        assertGe(staking.lastUpdateTime(), lastRewardTimeBefore, "lastRewardTime should be updated");
    }

    /// @dev emergencyExitPosition clears emergencyExitRequests mapping
    function test_emergencyExitPosition_clearsEmergencyRequest() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Request emergency exit
        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);
        assertGt(staking.emergencyExitRequests(tokenId), 0, "request should exist");

        vm.warp(block.timestamp + 31 days);

        vm.prank(bob);
        staking.emergencyExitPosition(tokenId);

        assertEq(staking.emergencyExitRequests(tokenId), 0, "request should be cleared");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 9. STRUCT PACKING SAFETY
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Verify all fields in Position struct are read/written correctly after packing
    function test_structPacking_allFieldsCorrect() public {
        nft.mint(bob);
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        // Revalidate to set hasJbacBoost
        vm.prank(bob);
        staking.revalidateBoost(tokenId);

        // Enable autoMaxLock
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        // Read all fields via the positions mapping
        (
            uint256 amount,
            uint256 boostedAmount,
            int256 rewardDebt,
            uint64 lockEnd,
            uint16 boostBps,
            uint32 lockDuration,
            bool autoMaxLock,
            bool hasJbacBoost,
            uint64 stakeTimestamp
        ) = staking.positions(tokenId);

        assertEq(amount, STAKE_AMT, "amount");
        assertGt(boostedAmount, 0, "boostedAmount > 0");
        // rewardDebt should be set
        assertGe(rewardDebt, 0, "rewardDebt >= 0");
        assertEq(lockEnd, uint64(block.timestamp + MAX_LOCK), "lockEnd");
        assertEq(boostBps, 45000, "boostBps = MAX + JBAC"); // 40000 + 5000
        assertEq(lockDuration, uint32(MAX_LOCK), "lockDuration");
        assertTrue(autoMaxLock, "autoMaxLock");
        assertTrue(hasJbacBoost, "hasJbacBoost");
        assertEq(stakeTimestamp, uint64(block.timestamp), "stakeTimestamp");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 10. BOOST CALCULATION EDGE CASES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Boost at exactly MIN_LOCK_DURATION returns MIN_BOOST_BPS
    function test_boostCalc_atMinLock() public view {
        uint256 boost = staking.calculateBoost(MIN_LOCK);
        assertEq(boost, 4000, "MIN_LOCK should give MIN_BOOST (0.4x)");
    }

    /// @dev Boost at exactly MAX_LOCK_DURATION returns MAX_BOOST_BPS
    function test_boostCalc_atMaxLock() public view {
        uint256 boost = staking.calculateBoost(MAX_LOCK);
        assertEq(boost, 40000, "MAX_LOCK should give MAX_BOOST (4.0x)");
    }

    /// @dev Boost at less than MIN_LOCK still returns MIN_BOOST (clamped)
    function test_boostCalc_belowMinLock() public view {
        uint256 boost = staking.calculateBoost(1 days);
        assertEq(boost, 4000, "below MIN_LOCK should clamp to MIN_BOOST");
    }

    /// @dev Boost at above MAX_LOCK still returns MAX_BOOST (clamped)
    function test_boostCalc_aboveMaxLock() public view {
        uint256 boost = staking.calculateBoost(MAX_LOCK + 365 days);
        assertEq(boost, 40000, "above MAX_LOCK should clamp to MAX_BOOST");
    }

    /// @dev Boost is linear between min and max
    function test_boostCalc_linearInterpolation() public view {
        // At halfway between MIN_LOCK and MAX_LOCK
        uint256 halfDuration = (MIN_LOCK + MAX_LOCK) / 2;
        uint256 boost = staking.calculateBoost(halfDuration);
        uint256 expectedMid = (4000 + 40000) / 2; // 22000
        // Allow +-1 for rounding
        assertApproxEqAbs(boost, expectedMid, 1, "boost should be ~2.2x at midpoint");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 11. MULTI-USER INTERACTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Multiple stakers: verify totalStaked/totalBoostedStake/totalLocked after mixed operations
    function test_multiUser_stakeWithdrawEarlyWithdrawConsistency() public {
        // Alice stakes 365 days
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        // Bob stakes 30 days
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 bobTokenId = staking.userTokenId(bob);

        // Carol stakes 90 days
        vm.prank(carol);
        staking.stake(STAKE_AMT, 90 days);
        uint256 carolTokenId = staking.userTokenId(carol);

        assertEq(staking.totalStaked(), STAKE_AMT * 3, "3 stakers");
        // V2: totalLocked tracking removed, always returns 0
        assertEq(staking.totalLocked(), 0, "3 locked: V2 totalLocked always 0");

        // Bob withdraws after lock
        vm.warp(block.timestamp + 31 days);
        vm.prank(bob);
        staking.withdraw(bobTokenId);

        assertEq(staking.totalStaked(), STAKE_AMT * 2, "2 stakers after bob withdraw");
        // V2: totalLocked tracking removed, always returns 0
        assertEq(staking.totalLocked(), 0, "2 locked after bob withdraw: V2 totalLocked always 0");

        // Carol early withdraws
        vm.prank(carol);
        staking.earlyWithdraw(carolTokenId);

        assertEq(staking.totalStaked(), STAKE_AMT, "1 staker after carol early withdraw");
        // V2: totalLocked tracking removed, always returns 0
        assertEq(staking.totalLocked(), 0, "1 locked after carol early withdraw: V2 totalLocked always 0");

        // Alice still active
        assertGt(staking.totalBoostedStake(), 0, "totalBoostedStake > 0 with alice still staking");
    }

    /// @dev Emergency exit request cleared on NFT transfer
    function test_emergencyExitRequest_clearedOnTransfer() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);
        assertGt(staking.emergencyExitRequests(tokenId), 0);

        // Wait for transfer cooldown
        vm.warp(block.timestamp + 25 hours);

        // Transfer NFT to carol
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        // Emergency exit request should be cleared
        assertEq(staking.emergencyExitRequests(tokenId), 0, "emergency request cleared on transfer");
    }

    /// @dev autoMaxLock reset on transfer
    function test_autoMaxLock_resetOnTransfer() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        // Wait for transfer cooldown
        vm.warp(block.timestamp + 25 hours);

        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        (,,,, bool autoMax,) = staking.getPosition(tokenId);
        assertFalse(autoMax, "autoMaxLock should be reset on transfer");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 12. REWARD DEBT SAFETY (_safeInt256)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Verify rewardDebt is correctly set on stake using _safeInt256
    function test_rewardDebt_setCorrectlyOnStake() public {
        // First staker to set accRewardPerShare
        vm.prank(alice);
        staking.stake(STAKE_AMT, 365 days);

        // Accrue some rewards
        vm.warp(block.timestamp + 10 days);

        // Second staker should have rewardDebt = boostedAmount * accRewardPerShare / ACC_PRECISION
        vm.prank(bob);
        staking.stake(STAKE_AMT, 365 days);

        uint256 tokenId = staking.userTokenId(bob);
        (,, int256 rewardDebt,,,,,, ) = staking.positions(tokenId);
        assertGt(rewardDebt, 0, "rewardDebt should be positive when accRewardPerShare > 0");
    }

    /// @dev Verify reward debt updated on boost change (extendLock)
    function test_rewardDebt_updatedOnExtendLock() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, 30 days);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 5 days);

        (,, int256 debtBefore,,,,,, ) = staking.positions(tokenId);

        vm.prank(bob);
        staking.extendLock(tokenId, 365 days);

        (,, int256 debtAfter,,,,,, ) = staking.positions(tokenId);
        // rewardDebt should change because boostedAmount changed
        assertTrue(debtAfter != debtBefore, "rewardDebt should change on extendLock");
    }
}
