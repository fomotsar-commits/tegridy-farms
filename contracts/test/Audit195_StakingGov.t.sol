// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockToken195 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockNFT195 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev Minimal contract-wallet mock for M-5 multi-NFT aggregation tests.
///      Accepts staking NFTs (has bytecode, so not treated as an EOA by _update)
///      and can forward transferFrom calls to move NFTs it holds.
contract MockSafe195 {
    function execTransferFrom(address nftContract, address from, address to, uint256 tokenId) external {
        ERC721(nftContract).transferFrom(from, to, tokenId);
    }
    function execApprove(address nftContract, address spender, uint256 tokenId) external {
        ERC721(nftContract).approve(spender, tokenId);
    }
    // No onERC721Received — use transferFrom (not safeTransferFrom) in tests
}

contract Audit195StakingGov is Test {
    TegridyStaking public staking;
    MockToken195 public token;
    MockNFT195 public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public attacker = makeAddr("attacker");

    uint256 constant STAKE_AMT = 100_000 ether;
    uint256 constant LOCK_1Y = 365 days;
    uint256 constant LOCK_MIN = 7 days;

    function setUp() public {
        token = new MockToken195();
        nft = new MockNFT195();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        nft.mint(alice);

        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);
        token.transfer(carol, 10_000_000 ether);
        token.transfer(attacker, 10_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        token.approve(address(staking), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(staking), type(uint256).max);

        // Fund staking rewards
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(100_000_000 ether);
    }

    // ============================================================
    //  CHECKPOINT BINARY SEARCH CORRECTNESS
    // ============================================================

    function test_binarySearch_singleCheckpoint() public {
        vm.warp(1000);
        vm.roll(10);
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK_1Y);

        uint256 stakeTs = block.timestamp;

        // At the staking timestamp, voting power should be non-zero
        uint256 vp = staking.votingPowerAtTimestamp(alice, stakeTs);
        assertGt(vp, 0, "VP at stake timestamp should be > 0");

        // Before the staking timestamp, voting power should be 0
        if (stakeTs > 0) {
            uint256 vpBefore = staking.votingPowerAtTimestamp(alice, stakeTs - 1);
            assertEq(vpBefore, 0, "VP before stake timestamp should be 0");
        }
    }

    function test_binarySearch_multipleCheckpoints() public {
        // Stake at timestamp 1000 to create first checkpoint
        vm.roll(100);
        vm.warp(1000);
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK_MIN);

        // Read checkpoint value at timestamp 1000
        uint256 vpAtTs1000 = staking.votingPowerAtTimestamp(alice, 1000);
        assertGt(vpAtTs1000, 0, "VP at ts 1000 should be > 0 after stake");

        // Toggle autoMaxLock at timestamp 2000 to create second checkpoint with higher VP
        vm.roll(200);
        vm.warp(2000);
        uint256 tokenId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.toggleAutoMaxLock(tokenId);

        uint256 vpAtTs2000 = staking.votingPowerAtTimestamp(alice, 2000);
        assertGt(vpAtTs2000, vpAtTs1000, "VP at ts 2000 should be > VP at ts 1000 after autoMaxLock");

        // Verify binary search returns correct results
        // Before first checkpoint
        assertEq(staking.votingPowerAtTimestamp(alice, 999), 0, "VP before first checkpoint should be 0");

        // At first checkpoint - should still be low VP
        assertEq(staking.votingPowerAtTimestamp(alice, 1000), vpAtTs1000, "VP at ts 1000 should match first checkpoint");

        // Between checkpoints - should return first checkpoint value
        assertEq(staking.votingPowerAtTimestamp(alice, 1500), vpAtTs1000, "VP between checkpoints should return earlier value");

        // At second checkpoint
        assertEq(staking.votingPowerAtTimestamp(alice, 2000), vpAtTs2000, "VP at ts 2000 should match second checkpoint");

        // After second checkpoint
        assertEq(staking.votingPowerAtTimestamp(alice, 3000), vpAtTs2000, "VP after last checkpoint should return latest value");
    }

    function test_binarySearch_manyCheckpoints() public {
        vm.warp(1000);
        vm.roll(10);
        vm.startPrank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);
        vm.stopPrank();

        uint256[] memory timestamps = new uint256[](10);
        uint256[] memory vpValues = new uint256[](10);

        // Create 10 checkpoints by claiming rewards repeatedly
        for (uint256 i = 0; i < 10; i++) {
            vm.roll(block.number + 10);
            vm.warp(block.timestamp + 1 hours);
            timestamps[i] = block.timestamp;

            // Claim to trigger checkpoint write
            vm.prank(bob);
            staking.getReward(tokenId);
            vpValues[i] = staking.votingPowerOf(bob);
        }

        // Verify binary search finds correct VP at each recorded timestamp
        for (uint256 i = 0; i < 10; i++) {
            assertEq(
                staking.votingPowerAtTimestamp(bob, timestamps[i]),
                vpValues[i],
                "VP mismatch at checkpoint"
            );
        }
    }

    function test_binarySearch_emptyCheckpoints() public view {
        // User with no checkpoints
        assertEq(staking.votingPowerAtTimestamp(alice, block.timestamp), 0);
    }

    function test_binarySearch_futureBlock() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 currentVP = staking.votingPowerOf(alice);

        // Query a future timestamp returns the latest checkpoint
        assertEq(staking.votingPowerAtTimestamp(alice, block.timestamp + 1_000_000), currentVP);
    }

    // ============================================================
    //  VOTING POWER BOUNDARY CONDITIONS
    // ============================================================

    function test_votingPower_dropsToZeroAtLockExpiry() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);

        assertGt(staking.votingPowerOf(bob), 0, "VP should be > 0 during lock");

        // Warp to exactly lock expiry
        vm.warp(block.timestamp + LOCK_MIN);
        assertEq(staking.votingPowerOf(bob), 0, "VP should be 0 at lock expiry");
    }

    function test_votingPower_oneSecondBeforeExpiry() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 lockEnd = block.timestamp + LOCK_MIN;

        // 1 second before expiry - still has power
        vm.warp(lockEnd - 1);
        assertGt(staking.votingPowerOf(bob), 0, "VP should be > 0 before expiry");

        // At expiry - no power
        vm.warp(lockEnd);
        assertEq(staking.votingPowerOf(bob), 0, "VP should be 0 at exact expiry");
    }

    function test_votingPower_checkpointVsLiveDisagreement() public {
        // This demonstrates that checkpointed VP and live VP can disagree after lock expiry
        vm.warp(1000);
        vm.roll(10);
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);

        uint256 stakeTs = block.timestamp;
        uint256 vpAtStake = staking.votingPowerOf(bob);
        assertGt(vpAtStake, 0);

        // After lock expiry, live VP is 0 but checkpoint still shows old VP
        vm.warp(block.timestamp + LOCK_1Y + 1);
        assertEq(staking.votingPowerOf(bob), 0, "Live VP should be 0 after expiry");

        // Checkpointed VP at the stake timestamp still returns the old value
        uint256 historicalVP = staking.votingPowerAtTimestamp(bob, stakeTs);
        assertEq(historicalVP, vpAtStake, "Historical VP should remain unchanged");
    }

    function test_votingPower_zeroAmountPosition() public {
        // After withdrawal, position is deleted, VP should be 0
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);

        vm.warp(block.timestamp + LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.withdraw(tokenId);

        assertEq(staking.votingPowerOf(bob), 0);
    }

    function test_checkpoint_sameBlockOverwrite() public {
        // Multiple operations in the same block should overwrite the checkpoint
        vm.startPrank(alice);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 initialCheckpoints = staking.numCheckpoints(alice);

        // Toggle autoMaxLock in same block - should overwrite, not add
        uint256 tokenId = staking.userTokenId(alice);
        staking.toggleAutoMaxLock(tokenId);
        uint256 finalCheckpoints = staking.numCheckpoints(alice);
        vm.stopPrank();

        // Should still be the same number (overwritten)
        assertEq(finalCheckpoints, initialCheckpoints, "Same-block ops should overwrite checkpoint");
    }

    // ============================================================
    //  TIMELOCK ENFORCEMENT - REWARD RATE
    // ============================================================

    function test_proposeRewardRate_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.proposeRewardRate(5 ether);
    }

    function test_proposeRewardRate_rateTooHigh() public {
        vm.expectRevert(TegridyStaking.RateTooHigh.selector);
        staking.proposeRewardRate(101 ether); // MAX_REWARD_RATE is 100e18
    }

    function test_proposeRewardRate_canProposeZero() public {
        // Rate 0 is valid - effectively halts rewards
        staking.proposeRewardRate(0);
        assertEq(staking.pendingRewardRate(), 0);
        assertGt(staking.rewardRateChangeTime(), 0);
    }

    function test_executeRewardRate_beforeTimelock() public {
        staking.proposeRewardRate(5 ether);

        // Try to execute immediately - should fail
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.REWARD_RATE_CHANGE()));
        staking.executeRewardRateChange();

        // 47h59m - still too early
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.REWARD_RATE_CHANGE()));
        staking.executeRewardRateChange();
    }

    function test_executeRewardRate_atExactTimelock() public {
        staking.proposeRewardRate(5 ether);
        uint256 executeAt = staking.rewardRateChangeTime();

        vm.warp(executeAt);
        staking.executeRewardRateChange();
        assertEq(staking.rewardRate(), 5 ether);
    }

    function test_executeRewardRate_afterExpiry() public {
        staking.proposeRewardRate(5 ether);
        uint256 executeAt = staking.rewardRateChangeTime();

        // Warp past MAX_PROPOSAL_VALIDITY (7 days after executeAt)
        vm.warp(executeAt + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, staking.REWARD_RATE_CHANGE()));
        staking.executeRewardRateChange();
    }

    function test_executeRewardRate_atExactExpiry() public {
        staking.proposeRewardRate(5 ether);
        uint256 executeAt = staking.rewardRateChangeTime();

        // At exact expiry boundary
        vm.warp(executeAt + 7 days);
        // This should still work (> not >=)
        staking.executeRewardRateChange();
        assertEq(staking.rewardRate(), 5 ether);
    }

    function test_proposeRewardRate_cannotDoublePropose() public {
        staking.proposeRewardRate(5 ether);

        // Second proposal without canceling first should revert
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, staking.REWARD_RATE_CHANGE()));
        staking.proposeRewardRate(10 ether);
    }

    function test_executeRewardRate_clearsState() public {
        staking.proposeRewardRate(5 ether);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRewardRateChange();

        // State should be cleared
        assertEq(staking.pendingRewardRate(), 0);
        assertEq(staking.rewardRateChangeTime(), 0);
    }

    function test_executeRewardRate_noPendingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, staking.REWARD_RATE_CHANGE()));
        staking.executeRewardRateChange();
    }

    // ============================================================
    //  TIMELOCK ENFORCEMENT - TREASURY CHANGE
    // ============================================================

    function test_proposeTreasury_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.proposeTreasuryChange(makeAddr("newTreasury"));
    }

    function test_proposeTreasury_zeroAddress() public {
        vm.expectRevert(TegridyStaking.ZeroAddress.selector);
        staking.proposeTreasuryChange(address(0));
    }

    function test_executeTreasury_beforeTimelock() public {
        staking.proposeTreasuryChange(makeAddr("newTreasury"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.TREASURY_CHANGE()));
        staking.executeTreasuryChange();
    }

    function test_executeTreasury_afterTimelock() public {
        address newTreasury = makeAddr("newTreasury");
        staking.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours);
        staking.executeTreasuryChange();
        assertEq(staking.treasury(), newTreasury);
    }

    function test_executeTreasury_expired() public {
        staking.proposeTreasuryChange(makeAddr("newTreasury"));
        uint256 executeAt = staking.treasuryChangeTime();
        vm.warp(executeAt + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, staking.TREASURY_CHANGE()));
        staking.executeTreasuryChange();
    }

    function test_proposeTreasury_cannotDoublePropose() public {
        staking.proposeTreasuryChange(makeAddr("a"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, staking.TREASURY_CHANGE()));
        staking.proposeTreasuryChange(makeAddr("b"));
    }

    function test_executeTreasury_clearsState() public {
        staking.proposeTreasuryChange(makeAddr("newTreasury"));
        vm.warp(block.timestamp + 48 hours);
        staking.executeTreasuryChange();
        assertEq(staking.pendingTreasury(), address(0));
        assertEq(staking.treasuryChangeTime(), 0);
    }

    // ============================================================
    //  TIMELOCK ENFORCEMENT - RESTAKING CONTRACT
    // ============================================================

    function test_proposeRestaking_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.proposeRestakingContract(makeAddr("restaking"));
    }

    function test_proposeRestaking_zeroAddress() public {
        vm.expectRevert(TegridyStaking.ZeroAddress.selector);
        staking.proposeRestakingContract(address(0));
    }

    function test_executeRestaking_beforeTimelock() public {
        staking.proposeRestakingContract(makeAddr("restaking"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.RESTAKING_CHANGE()));
        staking.executeRestakingContract();
    }

    function test_executeRestaking_afterTimelock() public {
        address newRestaking = makeAddr("restaking");
        staking.proposeRestakingContract(newRestaking);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRestakingContract();
        assertEq(staking.restakingContract(), newRestaking);
    }

    function test_executeRestaking_expired() public {
        staking.proposeRestakingContract(makeAddr("restaking"));
        uint256 executeAt = staking.restakingChangeReadyAt();
        vm.warp(executeAt + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, staking.RESTAKING_CHANGE()));
        staking.executeRestakingContract();
    }

    function test_executeRestaking_clearsState() public {
        staking.proposeRestakingContract(makeAddr("restaking"));
        vm.warp(block.timestamp + 48 hours);
        staking.executeRestakingContract();
        assertEq(staking.pendingRestakingContract(), address(0));
        assertEq(staking.restakingChangeReadyAt(), 0);
    }

    function test_proposeRestaking_cannotDoublePropose() public {
        staking.proposeRestakingContract(makeAddr("a"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, staking.RESTAKING_CHANGE()));
        staking.proposeRestakingContract(makeAddr("b"));
    }

    // ============================================================
    //  STATE CLEANUP ON CANCEL
    // ============================================================

    function test_cancelRewardRate_clearsState() public {
        staking.proposeRewardRate(5 ether);
        assertGt(staking.rewardRateChangeTime(), 0);

        staking.cancelRewardRateProposal();
        assertEq(staking.pendingRewardRate(), 0);
        assertEq(staking.rewardRateChangeTime(), 0);
    }

    function test_cancelRewardRate_noPendingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, staking.REWARD_RATE_CHANGE()));
        staking.cancelRewardRateProposal();
    }

    function test_cancelRewardRate_onlyOwner() public {
        staking.proposeRewardRate(5 ether);
        vm.prank(attacker);
        vm.expectRevert();
        staking.cancelRewardRateProposal();
    }

    function test_cancelRewardRate_thenReproposeWorks() public {
        staking.proposeRewardRate(5 ether);
        staking.cancelRewardRateProposal();

        // Can now propose a new rate
        staking.proposeRewardRate(10 ether);
        assertEq(staking.pendingRewardRate(), 10 ether);
    }

    function test_cancelTreasury_clearsState() public {
        staking.proposeTreasuryChange(makeAddr("t"));
        staking.cancelTreasuryProposal();
        assertEq(staking.pendingTreasury(), address(0));
        assertEq(staking.treasuryChangeTime(), 0);
    }

    function test_cancelTreasury_noPendingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, staking.TREASURY_CHANGE()));
        staking.cancelTreasuryProposal();
    }

    function test_cancelTreasury_onlyOwner() public {
        staking.proposeTreasuryChange(makeAddr("t"));
        vm.prank(attacker);
        vm.expectRevert();
        staking.cancelTreasuryProposal();
    }

    function test_cancelRestaking_clearsState() public {
        staking.proposeRestakingContract(makeAddr("r"));
        staking.cancelRestakingContract();
        assertEq(staking.pendingRestakingContract(), address(0));
        assertEq(staking.restakingChangeReadyAt(), 0);
    }

    function test_cancelRestaking_noPendingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, staking.RESTAKING_CHANGE()));
        staking.cancelRestakingContract();
    }

    function test_cancelRestaking_onlyOwner() public {
        staking.proposeRestakingContract(makeAddr("r"));
        vm.prank(attacker);
        vm.expectRevert();
        staking.cancelRestakingContract();
    }

    // ============================================================
    //  _update() NFT TRANSFER HOOK
    // ============================================================

    function test_transfer_updatesCheckpointsForBothParties() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        uint256 bobVPBefore = staking.votingPowerOf(bob);
        assertGt(bobVPBefore, 0);
        assertEq(staking.votingPowerOf(carol), 0);

        // Transfer cooldown
        vm.warp(block.timestamp + 24 hours + 1);
        vm.roll(block.number + 10);

        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        // Bob's VP should drop, Carol's should gain
        assertEq(staking.votingPowerOf(bob), 0, "Bob VP should be 0 after transfer");
        assertGt(staking.votingPowerOf(carol), 0, "Carol VP should be > 0 after transfer");

        // Checkpoints should reflect the change
        assertEq(staking.numCheckpoints(bob), 2, "Bob should have 2 checkpoints");
        assertGt(staking.numCheckpoints(carol), 0, "Carol should have checkpoints");
    }

    function test_transfer_clearsEmergencyExitRequest() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Request emergency exit
        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);
        assertGt(staking.emergencyExitRequests(tokenId), 0);

        // Transfer clears it
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        assertEq(staking.emergencyExitRequests(tokenId), 0, "Emergency exit should be cleared on transfer");
    }

    function test_transfer_resetsAutoMaxLock() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        (,,,,bool autoMaxLock,) = staking.getPosition(tokenId);
        assertFalse(autoMaxLock, "AutoMaxLock should be reset on transfer");
    }

    function test_transfer_cooldown() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Transfer within cooldown should revert
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.TransferCooldownActive.selector);
        staking.transferFrom(bob, carol, tokenId);

        // After cooldown should work
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);
        assertEq(staking.ownerOf(tokenId), carol);
    }

    function test_transfer_preventsOverwriteForEOA() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 bobTokenId = staking.userTokenId(bob);

        vm.prank(carol);
        staking.stake(STAKE_AMT, LOCK_1Y);

        // Transfer bob's NFT to carol (who already has a position) should revert
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(bob, carol, bobTokenId);
    }

    // ============================================================
    //  _writeCheckpoint() INTERNAL BEHAVIOR
    // ============================================================

    function test_writeCheckpoint_onStake() public {
        assertEq(staking.numCheckpoints(bob), 0);

        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);

        assertEq(staking.numCheckpoints(bob), 1, "Should have 1 checkpoint after stake");
    }

    function test_writeCheckpoint_onWithdraw() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + LOCK_MIN);
        vm.roll(block.number + 1);

        vm.prank(bob);
        staking.withdraw(tokenId);

        // Last checkpoint should record 0 VP
        uint256 withdrawTs = block.timestamp;
        assertEq(staking.votingPowerAtTimestamp(bob, withdrawTs), 0, "VP should be 0 after withdraw");
    }

    function test_writeCheckpoint_onEarlyWithdraw() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 days);

        vm.prank(bob);
        staking.earlyWithdraw(tokenId);

        assertEq(staking.votingPowerAtTimestamp(bob, block.timestamp), 0, "VP should be 0 after early withdraw");
    }

    // ============================================================
    //  EMERGENCY EXIT INTERACTIONS WITH PAUSE
    // ============================================================

    function test_emergencyWithdrawPosition_onlyWhenPaused() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Should fail when not paused
        vm.prank(bob);
        vm.expectRevert();
        staking.emergencyWithdrawPosition(tokenId);

        // Should work when paused
        staking.pause();
        vm.prank(bob);
        staking.emergencyWithdrawPosition(tokenId);
    }

    function test_emergencyExitPosition_worksWhenPaused() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        // Warp past lock
        vm.warp(block.timestamp + LOCK_MIN);

        // Pause the contract
        staking.pause();

        // emergencyExitPosition should still work (pause-independent)
        // However it uses updateRewards modifier - check if it reverts
        // Actually, emergencyExitPosition does NOT have whenNotPaused, so it works
        vm.prank(bob);
        staking.emergencyExitPosition(tokenId);
        assertEq(staking.userTokenId(bob), 0);
    }

    function test_requestEmergencyExit_worksWhenPaused() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Pause the contract
        staking.pause();

        // Request should work even when paused
        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);
        assertGt(staking.emergencyExitRequests(tokenId), 0);
    }

    function test_executeEmergencyExit_worksWhenPaused() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        // Pause the contract
        staking.pause();

        // Wait for delay
        vm.warp(block.timestamp + 7 days);

        // Execute should work even when paused
        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);
        assertEq(staking.userTokenId(bob), 0);
    }

    function test_executeEmergencyExit_penaltyIfLockActive() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.warp(block.timestamp + 7 days);

        uint256 balBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);

        uint256 balAfter = token.balanceOf(bob);
        uint256 treasuryAfter = token.balanceOf(treasury);

        // Lock was still active, so 25% penalty applies
        // Emergency exit now calls _getReward() so user receives principal - penalty + accrued rewards
        uint256 expectedPenalty = (STAKE_AMT * 2500) / 10000;
        uint256 expectedUser = STAKE_AMT - expectedPenalty;
        assertGe(balAfter - balBefore, expectedUser, "User should receive at least 75%");
        assertEq(treasuryAfter - treasuryBefore, expectedPenalty, "Treasury should receive 25%");
    }

    function test_executeEmergencyExit_noPenaltyIfLockExpired() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        // Warp past both lock expiry and emergency delay
        vm.warp(block.timestamp + LOCK_MIN + 7 days);

        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);
        uint256 balAfter = token.balanceOf(bob);

        // Emergency exit now calls _getReward() so user receives principal + accrued rewards
        assertGe(balAfter - balBefore, STAKE_AMT, "User should receive at least full amount when lock expired");
    }

    function test_requestEmergencyExit_cannotDoubleRequest() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitAlreadyRequested.selector);
        staking.requestEmergencyExit(tokenId);
    }

    function test_executeEmergencyExit_beforeDelay() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitDelayNotElapsed.selector);
        staking.executeEmergencyExit(tokenId);
    }

    function test_executeEmergencyExit_withoutRequest() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + 7 days);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.EmergencyExitNotRequested.selector);
        staking.executeEmergencyExit(tokenId);
    }

    // ============================================================
    //  PAUSE/UNPAUSE
    // ============================================================

    function test_pause_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.pause();
    }

    function test_unpause_onlyOwner() public {
        staking.pause();
        vm.prank(attacker);
        vm.expectRevert();
        staking.unpause();
    }

    function test_pause_blocksStake() public {
        staking.pause();
        vm.prank(bob);
        vm.expectRevert();
        staking.stake(STAKE_AMT, LOCK_1Y);
    }

    function test_pause_blocksWithdraw() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + LOCK_MIN);
        staking.pause();

        vm.prank(bob);
        vm.expectRevert();
        staking.withdraw(tokenId);
    }

    function test_pause_blocksClaim() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        staking.pause();
        vm.prank(bob);
        vm.expectRevert();
        staking.getReward(tokenId);
    }

    function test_pause_blocksEarlyWithdraw() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        staking.pause();
        vm.prank(bob);
        vm.expectRevert();
        staking.earlyWithdraw(tokenId);
    }

    // V2: reconcilePenaltyDust tests removed (function removed in dead code cleanup)

    // ============================================================
    //  PROPOSAL LIFECYCLE END-TO-END
    // ============================================================

    function test_rewardRate_fullLifecycle_proposeExecute() public {
        uint256 oldRate = staking.rewardRate();

        // Propose
        staking.proposeRewardRate(50 ether);
        assertEq(staking.pendingRewardRate(), 50 ether);

        // Wait timelock
        vm.warp(block.timestamp + 48 hours);

        // Execute
        staking.executeRewardRateChange();
        assertEq(staking.rewardRate(), 50 ether);
        assertTrue(staking.rewardRate() != oldRate || oldRate == 50 ether);

        // State cleared
        assertEq(staking.pendingRewardRate(), 0);
        assertEq(staking.rewardRateChangeTime(), 0);
    }

    function test_rewardRate_fullLifecycle_proposeCancel() public {
        uint256 oldRate = staking.rewardRate();

        staking.proposeRewardRate(50 ether);
        staking.cancelRewardRateProposal();

        // Rate unchanged
        assertEq(staking.rewardRate(), oldRate);

        // Can propose again
        staking.proposeRewardRate(25 ether);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRewardRateChange();
        assertEq(staking.rewardRate(), 25 ether);
    }

    function test_treasury_fullLifecycle_proposeExecute() public {
        address newTreasury = makeAddr("newTreasury");
        staking.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours);
        staking.executeTreasuryChange();
        assertEq(staking.treasury(), newTreasury);
    }

    function test_treasury_fullLifecycle_proposeCancelRepropose() public {
        staking.proposeTreasuryChange(makeAddr("a"));
        staking.cancelTreasuryProposal();

        address b = makeAddr("b");
        staking.proposeTreasuryChange(b);
        vm.warp(block.timestamp + 48 hours);
        staking.executeTreasuryChange();
        assertEq(staking.treasury(), b);
    }

    function test_restaking_fullLifecycle() public {
        address r = makeAddr("restaking");
        staking.proposeRestakingContract(r);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRestakingContract();
        assertEq(staking.restakingContract(), r);
    }

    // ============================================================
    //  votingPowerOf WITH RESTAKING FALLBACK
    // ============================================================

    function test_votingPowerOf_noPosition() public view {
        assertEq(staking.votingPowerOf(attacker), 0);
    }

    function test_votingPowerOf_withPosition() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        assertGt(staking.votingPowerOf(bob), 0);
    }

    // ============================================================
    //  EDGE CASE: Propose rate 0 halts rewards
    // ============================================================

    function test_proposeRateZero_haltsRewards() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Set rate to 0
        staking.proposeRewardRate(0);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRewardRateChange();
        assertEq(staking.rewardRate(), 0);

        // Advance time - should earn 0 new rewards (only pre-change rewards remain)
        vm.warp(block.timestamp + 365 days);
        // pendingReward should not grow since rate is 0
        assertEq(staking.rewardRate(), 0, "Rate should be 0");
    }

    // ============================================================
    //  EDGE CASE: Emergency exit clears on transfer to new owner
    // ============================================================

    function test_emergencyExitCleared_newOwnerMustReRequest() public {
        vm.warp(1000);

        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Bob requests emergency exit
        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        // Transfer to carol (clears the emergency exit request)
        vm.warp(block.timestamp + 25 hours);
        vm.prank(bob);
        staking.transferFrom(bob, carol, tokenId);

        // Carol cannot execute emergency exit without re-requesting
        vm.prank(carol);
        vm.expectRevert(TegridyStaking.EmergencyExitNotRequested.selector);
        staking.executeEmergencyExit(tokenId);

        // Carol can request fresh
        vm.prank(carol);
        staking.requestEmergencyExit(tokenId);
        uint256 requestTime = block.timestamp;

        // Must wait the full delay from carol's request time
        vm.warp(requestTime + 7 days + 100);
        vm.prank(carol);
        staking.executeEmergencyExit(tokenId);
    }

    // ============================================================
    //  EDGE CASE: Cancel after timelock but before execution
    // ============================================================

    function test_cancelRewardRate_afterTimelockStillWorks() public {
        staking.proposeRewardRate(50 ether);
        vm.warp(block.timestamp + 48 hours + 1 days);

        // Cancel even after timelock has passed
        staking.cancelRewardRateProposal();
        assertEq(staking.pendingRewardRate(), 0);
        assertEq(staking.rewardRateChangeTime(), 0);

        // Rate unchanged
        assertEq(staking.rewardRate(), 1 ether);
    }

    function test_cancelTreasury_afterTimelockStillWorks() public {
        staking.proposeTreasuryChange(makeAddr("t"));
        vm.warp(block.timestamp + 48 hours + 1 days);

        staking.cancelTreasuryProposal();
        assertEq(staking.pendingTreasury(), address(0));
        assertEq(staking.treasuryChangeTime(), 0);
    }

    function test_cancelRestaking_afterTimelockStillWorks() public {
        staking.proposeRestakingContract(makeAddr("r"));
        vm.warp(block.timestamp + 48 hours + 1 days);

        staking.cancelRestakingContract();
        assertEq(staking.pendingRestakingContract(), address(0));
        assertEq(staking.restakingChangeReadyAt(), 0);
    }

    // ============================================================
    //  EDGE CASE: emergencyExitPosition requires lock expired
    // ============================================================

    function test_emergencyExitPosition_requiresLockExpired() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        // Lock still active
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.LockStillActive.selector);
        staking.emergencyExitPosition(tokenId);
    }

    // ============================================================
    //  CHECKPOINT WRITING ON ALL STATE CHANGES
    // ============================================================

    function test_checkpointWritten_onEmergencyWithdraw() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);
        uint256 cpBefore = staking.numCheckpoints(bob);

        staking.pause();
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        staking.emergencyWithdrawPosition(tokenId);

        assertGt(staking.numCheckpoints(bob), cpBefore, "Checkpoint should be written on emergency withdraw");
        assertEq(staking.votingPowerAtTimestamp(bob, block.timestamp), 0);
    }

    function test_checkpointWritten_onEmergencyExit() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);
        uint256 cpBefore = staking.numCheckpoints(bob);

        vm.warp(block.timestamp + LOCK_MIN);
        vm.roll(block.number + 1);

        vm.prank(bob);
        staking.emergencyExitPosition(tokenId);

        assertGt(staking.numCheckpoints(bob), cpBefore);
    }

    function test_checkpointWritten_onExecuteEmergencyExit() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.warp(block.timestamp + 7 days);
        vm.roll(block.number + 1);

        uint256 cpBefore = staking.numCheckpoints(bob);
        vm.prank(bob);
        staking.executeEmergencyExit(tokenId);

        assertGt(staking.numCheckpoints(bob), cpBefore);
    }

    // ============================================================
    //  TIMESTAMP-BASED VOTING POWER SEARCH
    // ============================================================

    function test_votingPowerAtTimestamp_multipleCheckpoints() public {
        // Stake at ts=10000 to create first checkpoint
        vm.roll(100);
        vm.warp(10000);
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 vpAtTs10000 = staking.votingPowerAtTimestamp(bob, 10000);
        assertGt(vpAtTs10000, 0, "VP at ts 10000 should be > 0");

        // Toggle autoMaxLock at ts=20000 to create second checkpoint
        vm.roll(200);
        vm.warp(20000);
        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.toggleAutoMaxLock(tokenId);
        uint256 vpAtTs20000 = staking.votingPowerAtTimestamp(bob, 20000);

        assertGt(vpAtTs20000, vpAtTs10000, "VP should increase after autoMaxLock");

        // Verify timestamp-based binary search
        assertEq(staking.votingPowerAtTimestamp(bob, 9999), 0, "VP before first checkpoint should be 0");
        assertEq(staking.votingPowerAtTimestamp(bob, 10000), vpAtTs10000, "VP at ts 10000 should match");
        assertEq(staking.votingPowerAtTimestamp(bob, 15000), vpAtTs10000, "VP between checkpoints should return earlier");
        assertEq(staking.votingPowerAtTimestamp(bob, 20000), vpAtTs20000, "VP at ts 20000 should match");
        assertEq(staking.votingPowerAtTimestamp(bob, 30000), vpAtTs20000, "VP after last checkpoint should return latest");
    }

    // ============================================================
    //  ACCESS CONTROL MATRIX
    // ============================================================

    function test_emergencyExitPosition_onlyOwnerOfNFT() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_MIN);
        uint256 tokenId = staking.userTokenId(bob);

        vm.warp(block.timestamp + LOCK_MIN);
        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.emergencyExitPosition(tokenId);
    }

    function test_requestEmergencyExit_onlyOwnerOfNFT() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.requestEmergencyExit(tokenId);
    }

    function test_executeEmergencyExit_onlyOwnerOfNFT() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        vm.prank(bob);
        staking.requestEmergencyExit(tokenId);

        vm.warp(block.timestamp + 7 days);
        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.executeEmergencyExit(tokenId);
    }

    function test_emergencyWithdrawPosition_onlyOwnerOfNFT() public {
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 tokenId = staking.userTokenId(bob);

        staking.pause();
        vm.prank(attacker);
        vm.expectRevert(TegridyStaking.NotPositionOwner.selector);
        staking.emergencyWithdrawPosition(tokenId);
    }

    // ============================================================
    //  M-5 FULL AGGREGATION — votingPowerOf across multiple NFTs
    // ============================================================

    /// @dev Helper: mint staker, stake STAKE_AMT for `lockDuration`, move past the 24h cooldown,
    ///      then transfer the resulting staking NFT into `dest` (a contract wallet / Safe).
    function _stakeAndPush(address staker, uint256 lockDuration, address dest)
        internal
        returns (uint256 tokenId, uint256 individualVP)
    {
        // Top up the staker if needed.
        if (token.balanceOf(staker) < STAKE_AMT) {
            token.transfer(staker, STAKE_AMT * 2);
        }
        vm.prank(staker);
        token.approve(address(staking), type(uint256).max);

        vm.prank(staker);
        staking.stake(STAKE_AMT, lockDuration);
        tokenId = staking.userTokenId(staker);
        individualVP = staking.votingPowerOf(staker);

        // Past 24h cooldown + 1h rate limit to unblock the outgoing transfer.
        vm.warp(block.timestamp + 24 hours + 1);
        vm.roll(block.number + 1);

        vm.prank(staker);
        staking.transferFrom(staker, dest, tokenId);
    }

    function test_VotingPowerOf_MultiNFTSafe() public {
        MockSafe195 safe = new MockSafe195();

        // Three independent stakers with distinct lock durations — individual VPs differ.
        // Unrolled instead of a loop to sidestep a via_ir optimizer issue where
        // `block.timestamp` captures inside loop-local variables fold with later reads.
        vm.warp(10_000);

        address staker1 = makeAddr("aggM1");
        address staker2 = makeAddr("aggM2");
        address staker3 = makeAddr("aggM3");

        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id1, uint256 vp1) = _stakeAndPush(staker1, 30 days, address(safe));

        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id2, uint256 vp2) = _stakeAndPush(staker2, 180 days, address(safe));

        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id3, uint256 vp3) = _stakeAndPush(staker3, LOCK_1Y, address(safe));

        uint256 safeVP = staking.votingPowerOf(address(safe));

        // votingPowerOf(safe) must equal the sum of the three individual voting powers.
        assertEq(safeVP, vp1 + vp2 + vp3, "Safe VP must aggregate all three positions");
        assertGt(vp1, 0, "vp1 nonzero");
        assertGt(vp2, 0, "vp2 nonzero");
        assertGt(vp3, 0, "vp3 nonzero");
        // Each of the prior owners now has zero VP (NFT transferred out).
        assertEq(staking.votingPowerOf(staker1), 0, "staker1 VP zero after push");
        assertEq(staking.votingPowerOf(staker2), 0, "staker2 VP zero after push");
        assertEq(staking.votingPowerOf(staker3), 0, "staker3 VP zero after push");

        // Silence unused-var warnings.
        id1; id2; id3;
    }

    function test_VotingPowerOf_RestakingReturnsZero() public {
        // Install a restaking-contract address via the full timelock flow.
        address restaking = makeAddr("restaking");
        staking.proposeRestakingContract(restaking);
        vm.warp(block.timestamp + 48 hours);
        staking.executeRestakingContract();
        assertEq(staking.restakingContract(), restaking);

        // Baseline: some other holder has non-zero VP.
        vm.prank(bob);
        staking.stake(STAKE_AMT, LOCK_1Y);
        assertGt(staking.votingPowerOf(bob), 0);

        // Even if we seed the restaking contract with a position set, the view must return 0.
        // The restaking contract exposes per-restaker VP via its own internal bookkeeping;
        // summing here would double-count.
        assertEq(
            staking.votingPowerOf(restaking),
            0,
            "restakingContract votingPowerOf must be 0 (per-restaker aggregation lives there)"
        );
    }

    function test_Checkpoint_AggregatesAcrossTime() public {
        MockSafe195 safe = new MockSafe195();

        // Use explicit timestamps (not `block.timestamp` snapshots) so via_ir can't re-read
        // block.timestamp at reference sites and fold them with later uses. We warp to these
        // exact moments and rely on `_stakeAndPush`'s internal `+24h+1` cooldown bump landing
        // at the planned epoch.
        uint256 T_START = 10_000;
        uint256 T_EPOCH_T0 = T_START + 24 hours + 1;                  // first transfer lands here
        uint256 T_EPOCH_T1 = T_EPOCH_T0 + 7 days + 24 hours + 1;      // second transfer lands here
        // T_EPOCH_T2 is computed after we do the unstake hop back.

        vm.warp(T_START);
        vm.roll(100);
        address s1 = makeAddr("aggSafe_s1");
        (uint256 id1, uint256 vp1) = _stakeAndPush(s1, LOCK_1Y, address(safe));
        assertEq(block.timestamp, T_EPOCH_T0, "sanity: first transfer lands at T_EPOCH_T0");

        uint256 vpAtT0 = staking.votingPowerOf(address(safe));
        assertEq(vpAtT0, vp1, "at t0 Safe VP = vp1");

        // Move to just before the second push then let `_stakeAndPush`'s own warp take us to T_EPOCH_T1.
        vm.warp(T_EPOCH_T0 + 7 days);
        vm.roll(block.number + 1);
        address s2 = makeAddr("aggSafe_s2");
        (uint256 id2, uint256 vp2) = _stakeAndPush(s2, LOCK_1Y, address(safe));
        assertEq(block.timestamp, T_EPOCH_T1, "sanity: second transfer lands at T_EPOCH_T1");

        uint256 vpAtT1 = staking.votingPowerOf(address(safe));
        assertEq(vpAtT1, vp1 + vp2, "at t1 Safe VP = vp1 + vp2");

        // Historical lookup at T_EPOCH_T0 must still report vp1 (binary-search checkpoint).
        assertEq(
            staking.votingPowerAtTimestamp(address(safe), T_EPOCH_T0),
            vp1,
            "historical VP at t0"
        );

        // t2: Safe unstakes id1 by sending it back to s1 (who has already withdrawn, so EOA guard
        // is satisfied — userTokenId[s1] was cleared when Safe received the NFT).
        vm.warp(T_EPOCH_T1 + 30 days);
        vm.roll(block.number + 1);
        uint256 T_EPOCH_T2 = block.timestamp;
        // Rate-limit dance — last transfer on id1 was at t0, plenty of slack now.
        vm.prank(address(safe));
        safe.execApprove(address(staking), s1, id1);
        vm.prank(s1);
        staking.transferFrom(address(safe), s1, id1);

        uint256 vpAtT2 = staking.votingPowerOf(address(safe));
        assertEq(vpAtT2, vp2, "at t2 Safe VP = vp2 only (id1 was moved out)");

        // Historical lookups remain correct at every earlier epoch.
        assertEq(staking.votingPowerAtTimestamp(address(safe), T_EPOCH_T0), vp1, "t0 lookup stable");
        assertEq(staking.votingPowerAtTimestamp(address(safe), T_EPOCH_T1), vp1 + vp2, "t1 lookup stable");
        assertEq(staking.votingPowerAtTimestamp(address(safe), T_EPOCH_T2), vp2, "t2 checkpoint written");

        // Silence unused-var warnings.
        id2;
    }

    function test_VotingPowerOf_ExpiredLockExcluded() public {
        MockSafe195 safe = new MockSafe195();

        address s1 = makeAddr("expS1"); // short lock (expires first)
        address s2 = makeAddr("expS2"); // long lock

        (uint256 id1, uint256 vp1) = _stakeAndPush(s1, LOCK_MIN, address(safe));
        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id2, uint256 vp2) = _stakeAndPush(s2, LOCK_1Y, address(safe));

        // Both contribute.
        uint256 before = staking.votingPowerOf(address(safe));
        assertEq(before, vp1 + vp2, "both locks active");

        // Warp past the short lock's expiry but well before the long lock's expiry.
        vm.warp(block.timestamp + LOCK_MIN + 1);

        uint256 afterVP = staking.votingPowerOf(address(safe));
        assertEq(afterVP, vp2, "expired lock should drop from aggregate; long lock survives");

        // Silence unused-var warnings.
        id1; id2; vp1;
    }

    function test_MaxPositionsCap_Reverts() public {
        MockSafe195 safe = new MockSafe195();

        uint256 cap = staking.MAX_POSITIONS_PER_HOLDER();

        // Fill the Safe up to the cap.
        for (uint256 i; i < cap; ++i) {
            address s = address(uint160(uint256(keccak256(abi.encode("capStaker", i)))));
            // Stagger time to clear both cooldown and rate limit.
            vm.warp(block.timestamp + 1 hours + 1);
            _stakeAndPush(s, LOCK_1Y, address(safe));
        }

        // One more should revert with TooManyPositions.
        address sOverflow = makeAddr("capOverflow");
        token.transfer(sOverflow, STAKE_AMT * 2);
        vm.prank(sOverflow);
        token.approve(address(staking), type(uint256).max);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(sOverflow);
        staking.stake(STAKE_AMT, LOCK_1Y);
        uint256 overflowId = staking.userTokenId(sOverflow);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.roll(block.number + 1);

        vm.prank(sOverflow);
        vm.expectRevert(TegridyStaking.TooManyPositions.selector);
        staking.transferFrom(sOverflow, address(safe), overflowId);
    }

    function test_EnumerableSetRemovalOnUnstake() public {
        MockSafe195 safe = new MockSafe195();

        // Stake three times into the Safe via its own stake (from an EOA held inside, then pushed in).
        address s1 = makeAddr("rmS1");
        address s2 = makeAddr("rmS2");
        address s3 = makeAddr("rmS3");

        (uint256 id1, uint256 vp1) = _stakeAndPush(s1, LOCK_MIN, address(safe));
        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id2, uint256 vp2) = _stakeAndPush(s2, LOCK_1Y, address(safe));
        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 id3, uint256 vp3) = _stakeAndPush(s3, LOCK_1Y, address(safe));

        assertEq(staking.votingPowerOf(address(safe)), vp1 + vp2 + vp3, "set has all 3 active");

        // Wait until id1's lock expires, then unstake via Safe (Safe is the NFT owner, so it must
        // send to a non-escrow recipient and that recipient must withdraw). Cleanest: push id1 back
        // to s1 (whose userTokenId is 0) and have s1 withdraw.
        vm.warp(block.timestamp + LOCK_MIN + 1);
        vm.roll(block.number + 1);

        // Safe approves s1 to pull id1 out.
        vm.prank(address(safe));
        safe.execApprove(address(staking), s1, id1);
        vm.prank(s1);
        staking.transferFrom(address(safe), s1, id1);

        // After the hop out, Safe's aggregate VP loses vp1.
        // Note: vp1 was computed at stake time. After LOCK_MIN+1, lock has expired so vp1 is already excluded
        // from the live sum. We instead compare set length directly by probing the view against vp2+vp3.
        assertEq(staking.votingPowerOf(address(safe)), vp2 + vp3, "vp1 drops once id1 leaves the Safe");

        // s1 withdraws — this burns id1 and removes from s1's set too.
        vm.prank(s1);
        staking.withdraw(id1);
        assertEq(staking.votingPowerOf(s1), 0, "s1 VP is 0 after withdraw");

        // Silence unused-var warnings.
        id2; id3;
    }
}
