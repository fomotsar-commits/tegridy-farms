// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyRestaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// ======================================================================
//  Mocks (mirrors the AuditR014_Restaking harness)
// ======================================================================

contract SRG_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
}

contract SRG_MockJBAC is ERC721 {
    constructor() ERC721("JBAC", "JBAC") {}
}

contract SRG_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 100_000_000 ether);
    }
}

/// @title Stranded-restake return guard: the restaking round-trip has an exit
///
/// @notice WHAT THIS PINS. `StakingRewardLib.afterTokenTransfer`
///         (src/lib/StakingRewardLib.sol:872-878) reverts `AlreadyHasPosition`
///         when an EOA that already holds a staking position receives another.
///         It relaxes for `isLendingContract[from]` but NOT for
///         `from == restakingContract`, even though the sibling `escrowHop`
///         computation twelve lines below (:880-884) DOES treat the restaking hop
///         as an escrow hop. The two guards disagree about the same hop.
///
///         That disagreement is reachable on the ordinary path, because `restake`
///         zeroes `userTokenId[user]` -- exactly the field `TegridyStaking.stake`
///         gates on -- so `stake -> restake -> stake` is permitted (and is
///         documented as permitted in v2/StreamingRevenueDistributor.sol:553,
///         whose two power legs are additive precisely to serve it). The return
///         hop then hits the guard and strands the NFT.
///
/// @dev    WHY THE FIX IS ON THE RESTAKING SIDE. `StakingRewardLib` is deployed at
///         0xb86A763a92A24e0951658E52d54CE50A5D52C1Ea and linked into the live
///         `TegridyStaking` (0xcaDc93E96De58EA554c71ca609974625615E046D), so the
///         guard cannot be changed without redeploying staking and migrating live
///         positions. `TegridyRestaking` is NOT deployed (`restakingContract()`
///         reads address(0) on mainnet), so the recovery path is free to change.
///         `claimStrandedRestakeNFT` therefore takes an explicit `recipient`,
///         mirroring `TegridyPositionMarket.cancel(orderId, recipient)` which
///         carries one for the identical trap.
///
/// @dev    MUTATION CHECK. `test_strandedNFT_recoversToAnAddressWithoutAPosition`
///         is the test that fails without the fix: pre-fix the function has no
///         `recipient` parameter and hardcodes `msg.sender`, so the retry re-runs
///         the same reverting transfer. Reverting the fix (transferring to `to`
///         instead of `recipient`) turns that test red while the three refusal
///         tests below stay green -- they are the anti-vacuity half, proving the
///         fix widened WHERE the NFT may land and not WHO may move it, and did not
///         weaken the EOA single-position guard.
contract RestakingStrandedReturnGuardTest is Test {
    SRG_MockTOWELI toweli;
    SRG_MockJBAC jbac;
    SRG_MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address aliceAlt = makeAddr("aliceAlt"); // fresh address, holds no position
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant LOCK = 7 days + 1;

    function setUp() public {
        toweli = new SRG_MockTOWELI();
        jbac = new SRG_MockJBAC();
        weth = new SRG_MockWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE
        );

        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        toweli.approve(address(staking), 500_000_000 ether);
        staking.notifyRewardAmount(500_000_000 ether);
        weth.transfer(address(restaking), 1_000_000 ether);

        toweli.transfer(alice, STAKE_AMOUNT * 4);
        toweli.transfer(bob, STAKE_AMOUNT * 4);
    }

    // --- helpers ------------------------------------------------------

    function _stake(address user, uint256 amount) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), amount);
        staking.stake(amount, LOCK);
        tokenId = staking.userTokenId(user);
        vm.stopPrank();
    }

    /// @dev Drives the real reachable flow all the way to the stranded state.
    function _driveToStrandedState() internal returns (uint256 restakedId, uint256 secondId) {
        restakedId = _stake(alice, STAKE_AMOUNT);

        // TRANSFER_COOLDOWN is 24h from stakeTimestamp; the restaking hop is exempt
        // from the 1h rate limit but not from the cooldown.
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), restakedId);
        restaking.restake(restakedId);
        vm.stopPrank();

        // restake zeroed userTokenId[alice], so stake() no longer sees a position.
        assertEq(staking.userTokenId(alice), 0, "restake should zero the legacy pointer");

        secondId = _stake(alice, STAKE_AMOUNT);
        assertTrue(secondId != 0 && secondId != restakedId, "second position should open");

        // The return hop now trips the EOA guard and is caught into the strand record.
        vm.prank(alice);
        restaking.unrestake();

        assertEq(
            staking.ownerOf(restakedId),
            address(restaking),
            "NFT should still be custodied after the failed return"
        );
        assertEq(
            restaking.strandedRestakeRecipient(restakedId), alice, "strand record should name alice"
        );
    }

    // --- characterization: the bug is reachable -----------------------

    /// @notice `stake -> restake -> stake` is a permitted flow. This pins the
    ///         premise the whole defect rests on; if this ever starts reverting,
    ///         the flow was closed elsewhere and this suite needs revisiting.
    function test_restakeThenStake_isAPermittedFlow() public {
        uint256 first = _stake(alice, STAKE_AMOUNT);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), first);
        restaking.restake(first);
        vm.stopPrank();

        assertEq(staking.userTokenId(alice), 0, "restake zeroes the pointer stake() gates on");

        uint256 second = _stake(alice, STAKE_AMOUNT);
        assertTrue(second != first, "a second position is openable while restaked");
        assertEq(staking.ownerOf(second), alice, "alice owns the second position");
    }

    /// @notice The return hop strands the NFT instead of delivering it. Passes both
    ///         pre- and post-fix: it characterizes the defect, it does not test the
    ///         fix. The `RestakeNFTStranded` event is the operator-visible symptom.
    function test_unrestakeWhileHoldingSecondPosition_strandsTheNFT() public {
        uint256 restakedId = _stake(alice, STAKE_AMOUNT);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), restakedId);
        restaking.restake(restakedId);
        vm.stopPrank();

        _stake(alice, STAKE_AMOUNT);

        vm.expectEmit(true, true, false, true, address(restaking));
        emit TegridyRestaking.RestakeNFTStranded(restakedId, alice);

        vm.prank(alice);
        restaking.unrestake();

        assertEq(staking.ownerOf(restakedId), address(restaking), "NFT stayed custodied");
    }

    // --- the fix ------------------------------------------------------

    /// @notice THE FIX. The entitled user recovers the stranded NFT to an address
    ///         that holds no position, WITHOUT unwinding their second position.
    ///         Fails pre-fix: the function hardcoded `msg.sender`, so the only
    ///         reachable destination was the one address the guard refuses.
    function test_strandedNFT_recoversToAnAddressWithoutAPosition() public {
        (uint256 restakedId, uint256 secondId) = _driveToStrandedState();

        vm.prank(alice);
        restaking.claimStrandedRestakeNFT(restakedId, aliceAlt);

        assertEq(staking.ownerOf(restakedId), aliceAlt, "stranded NFT delivered to the fresh address");
        assertEq(restaking.strandedRestakeRecipient(restakedId), address(0), "strand record cleared");
        // The second position is untouched -- recovery cost the user nothing.
        assertEq(staking.ownerOf(secondId), alice, "second position survived the recovery");
        assertEq(staking.userTokenId(aliceAlt), restakedId, "recipient pointer now names the returned NFT");
    }

    // --- anti-vacuity: the guard is NOT weakened ----------------------

    /// @notice The fix must not disable the EOA single-position guard. Redirecting
    ///         to an address that already holds a position is still refused, and the
    ///         strand record survives the reverted attempt.
    function test_redirectToAddressHoldingAPosition_isRefused() public {
        (uint256 restakedId,) = _driveToStrandedState();
        _stake(bob, STAKE_AMOUNT); // bob now holds a position

        vm.prank(alice);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        restaking.claimStrandedRestakeNFT(restakedId, bob);

        assertEq(
            restaking.strandedRestakeRecipient(restakedId),
            alice,
            "a reverted claim must roll the delete back and keep the record"
        );
        assertEq(staking.ownerOf(restakedId), address(restaking), "NFT not moved");
    }

    /// @notice Retrying to the SAME address is still blocked while the second
    ///         position is held. This is inherent to the deployed guard, not a
    ///         regression -- and it is precisely why the recipient parameter exists.
    function test_redirectToSelfWhileHoldingSecondPosition_stillReverts() public {
        (uint256 restakedId,) = _driveToStrandedState();

        vm.prank(alice);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        restaking.claimStrandedRestakeNFT(restakedId, alice);

        assertEq(restaking.strandedRestakeRecipient(restakedId), alice, "record survives");
    }

    /// @notice Entitlement is unchanged: the parameter widens WHERE the NFT may
    ///         land, never WHO may move it. A stranger cannot redirect it away.
    function test_onlyTheEntitledRecipientMayRedirect() public {
        (uint256 restakedId,) = _driveToStrandedState();

        vm.prank(bob);
        vm.expectRevert(TegridyRestaking.NotRestakedToken.selector);
        restaking.claimStrandedRestakeNFT(restakedId, bob);

        assertEq(staking.ownerOf(restakedId), address(restaking), "stranger moved nothing");
        assertEq(restaking.strandedRestakeRecipient(restakedId), alice, "record intact");
    }

    /// @notice A zero recipient would burn the position to address(0). Refused.
    function test_zeroRecipient_isRefused() public {
        (uint256 restakedId,) = _driveToStrandedState();

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.ZeroAddress.selector);
        restaking.claimStrandedRestakeNFT(restakedId, address(0));

        assertEq(restaking.strandedRestakeRecipient(restakedId), alice, "record intact");
    }

    // --- severity pin: recoverable, not permanent ---------------------

    /// @notice Pins the severity claim. Even without the recipient parameter the
    ///         NFT was never permanently lost -- exiting the second position clears
    ///         `userTokenId[alice]` and the same-address claim then succeeds. The
    ///         defect is a bad, confusing dead-end, not a fund loss. If this ever
    ///         goes red the severity assessment in the PR is wrong.
    function test_exitingTheSecondPosition_unblocksTheSameAddressClaim() public {
        (uint256 restakedId, uint256 secondId) = _driveToStrandedState();

        vm.warp(block.timestamp + LOCK + 1);
        vm.prank(alice);
        staking.withdraw(secondId);

        assertEq(staking.userTokenId(alice), 0, "exiting the second position clears the pointer");

        vm.prank(alice);
        restaking.claimStrandedRestakeNFT(restakedId, alice);

        assertEq(staking.ownerOf(restakedId), alice, "same-address claim works once unblocked");
    }
}
