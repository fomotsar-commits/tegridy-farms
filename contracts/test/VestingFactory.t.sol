// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";
import {VestingFactory} from "../src/VestingFactory.sol";
import {TegridyVestingWallet} from "../src/TegridyVestingWallet.sol";
import {OwnableNoRenounce} from "../src/base/OwnableNoRenounce.sol";
import {PauseGuardian} from "../src/base/PauseGuardian.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockVestToken is ERC20 {
    constructor() ERC20("Vest", "VST") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockVestFoT is ERC20 {
    uint256 public feeBps;

    constructor(uint256 _feeBps) ERC20("FoT", "FOT") {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockVestReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("Reenter", "RNT") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && target != address(0)) {
            armed = false;
            (bool ok, bytes memory err) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(err, 0x20), mload(err))
                }
            }
        }
    }
}

contract PlainSink {
    receive() external payable {}
}

contract RevertingSink {
    receive() external payable {
        revert("no eth");
    }
}

contract VestingFactoryTest is Test {
    VestingFactory factory;
    MockVestToken token;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address creator = makeAddr("creator");
    address teamMember = makeAddr("teamMember");
    address stranger = makeAddr("stranger");

    uint64 constant DURATION = 365 days;
    uint64 constant CLIFF = 90 days;
    uint256 constant GRANT = 1000 ether;

    function setUp() public {
        // Start well clear of the epoch so `MAX_BACKDATE` arithmetic is exercised in its
        // normal regime rather than against a near-zero timestamp.
        vm.warp(1_700_000_000);
        factory = new VestingFactory(owner);
        token = new MockVestToken();
        token.transfer(creator, 500_000 ether);
    }

    function _warpToReady(bytes32 key) internal {
        uint256 readyAt = factory.proposalExecuteAfter(key);
        assertGt(readyAt, 0, "no pending proposal for key");
        vm.warp(readyAt);
    }

    function _create() internal returns (TegridyVestingWallet w) {
        return _create(uint64(block.timestamp), DURATION, CLIFF, GRANT);
    }

    function _create(uint64 start, uint64 duration, uint64 cliff, uint256 amount)
        internal
        returns (TegridyVestingWallet w)
    {
        vm.startPrank(creator);
        token.approve(address(factory), amount);
        w = TegridyVestingWallet(
            payable(factory.createVesting(address(token), teamMember, amount, start, duration, cliff))
        );
        vm.stopPrank();
    }

    function _armFee(uint256 fee, address sink) internal {
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        factory.executeFeeSink(sink);
        factory.proposeCreateFee(fee);
        vm.stopPrank();
        _warpToReady(factory.CREATE_FEE_CHANGE());
        vm.prank(owner);
        factory.executeCreateFee(fee);
    }

    // ─── Happy path ──────────────────────────────────────────────────

    function test_HappyPath_CliffThenLinearThenFull() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();

        assertEq(w.owner(), teamMember);
        assertEq(w.creator(), creator);
        assertEq(w.factory(), address(factory));
        assertEq(w.declaredToken(), address(token));
        assertEq(w.start(), start);
        assertEq(w.cliff(), start + CLIFF);
        assertEq(w.end(), start + DURATION);
        assertEq(token.balanceOf(address(w)), GRANT);

        // Before the cliff: nothing, however far into the schedule.
        vm.warp(start + CLIFF - 1);
        assertEq(w.releasable(address(token)), 0, "released before cliff");
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), 0);

        // At the cliff: the whole elapsed linear portion unlocks at once.
        vm.warp(start + CLIFF);
        assertEq(w.releasable(address(token)), (GRANT * CLIFF) / DURATION);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), (GRANT * CLIFF) / DURATION);

        // Halfway.
        vm.warp(start + DURATION / 2);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), (GRANT * (DURATION / 2)) / DURATION);

        // End.
        vm.warp(start + DURATION);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), GRANT);
        assertEq(token.balanceOf(address(w)), 0);
        assertTrue(w.vestingInfo().fullyVested);
    }

    function test_ZeroCliffIsLinearFromStart() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create(start, DURATION, 0, GRANT);
        vm.warp(start + DURATION / 4);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), GRANT / 4);
    }

    function test_CliffEqualToDurationIsACliffOnlyUnlock() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create(start, DURATION, DURATION, GRANT);
        vm.warp(start + DURATION - 1);
        assertEq(w.releasable(address(token)), 0);
        vm.warp(start + DURATION);
        assertEq(w.releasable(address(token)), GRANT);
    }

    function test_VestingInfo_ReadSurface() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();
        TegridyVestingWallet.VestingInfo memory info = w.vestingInfo();
        assertEq(info.beneficiary, teamMember);
        assertEq(info.token, address(token));
        assertEq(info.creator, creator);
        assertEq(info.balance, GRANT);
        assertEq(info.locked, GRANT, "everything locked before cliff");
        assertFalse(info.cliffReached);
        assertFalse(info.fullyVested);

        vm.warp(start + CLIFF);
        info = w.vestingInfo();
        assertTrue(info.cliffReached);
        assertEq(info.locked, GRANT - info.releasable);
    }

    // ─── Custody: nobody but the beneficiary is paid ─────────────────

    function test_Release_IsPermissionlessButAlwaysPaysTheBeneficiary() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();
        vm.warp(start + DURATION);

        vm.prank(stranger); // anyone may crank
        w.release(address(token));

        assertEq(token.balanceOf(teamMember), GRANT, "crank must pay the beneficiary");
        assertEq(token.balanceOf(stranger), 0, "crank must not pay the caller");
    }

    function test_Creator_HasNoClawback() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();
        vm.warp(start + 1 days);

        // A revocable vest is not a vest. There is no path at all.
        vm.startPrank(creator);
        (bool a,) = address(w).call(abi.encodeWithSignature("revoke()"));
        (bool b,) = address(w).call(abi.encodeWithSignature("clawback()"));
        (bool c,) = address(w).call(abi.encodeWithSignature("reclaim()"));
        (bool d,) = address(w).call(abi.encodeWithSignature("sweep(address)", address(token)));
        vm.stopPrank();
        assertFalse(a || b || c || d, "a clawback path exists");
        assertEq(token.balanceOf(address(w)), GRANT);
    }

    function test_ProtocolOwner_CannotSeizeOrStall() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();

        vm.startPrank(owner);
        factory.pause();
        (bool a,) = address(factory).call(abi.encodeWithSignature("sweep(address)", address(token)));
        (bool b,) = address(factory).call(abi.encodeWithSignature("rescue(address,uint256)", address(token), GRANT));
        vm.stopPrank();
        assertFalse(a || b, "factory exposes a token escape hatch");

        // A paused factory does not delay the beneficiary by one second.
        vm.warp(start + DURATION);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), GRANT);
    }

    function test_Wallet_RenounceDisabled() public {
        TegridyVestingWallet w = _create();
        vm.prank(teamMember);
        vm.expectRevert(TegridyVestingWallet.RenounceDisabled.selector);
        w.renounceOwnership();
        assertEq(w.owner(), teamMember);
    }

    function test_Wallet_OwnershipTransferMovesFutureReleases() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();
        address newBeneficiary = makeAddr("newBeneficiary");
        vm.prank(teamMember);
        w.transferOwnership(newBeneficiary);
        vm.warp(start + DURATION);
        w.release(address(token));
        assertEq(token.balanceOf(newBeneficiary), GRANT);
        assertEq(token.balanceOf(teamMember), 0);
    }

    // ─── Schedule bounds ─────────────────────────────────────────────

    function test_Bounds_DurationTooShortOrLongReverts() public {
        uint64 min = factory.MIN_DURATION();
        uint64 max = factory.MAX_DURATION();
        vm.startPrank(creator);
        token.approve(address(factory), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidDuration.selector, min - 1, min, max));
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), min - 1, 0);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidDuration.selector, max + 1, min, max));
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), max + 1, 0);
        // Both endpoints inclusive.
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), min, 0);
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), max, 0);
        vm.stopPrank();
    }

    function test_Bounds_CliffLongerThanDurationReverts() public {
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidCliff.selector, DURATION + 1, DURATION));
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), DURATION, DURATION + 1);
        vm.stopPrank();
    }

    function test_Bounds_StartTooFarForwardOrBackReverts() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 tooLate = nowTs + factory.MAX_START_DELAY() + 1;
        uint64 tooEarly = nowTs - factory.MAX_BACKDATE() - 1;
        vm.startPrank(creator);
        token.approve(address(factory), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidStart.selector, tooLate));
        factory.createVesting(address(token), teamMember, GRANT, tooLate, DURATION, 0);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidStart.selector, tooEarly));
        factory.createVesting(address(token), teamMember, GRANT, tooEarly, DURATION, 0);
        vm.stopPrank();
    }

    /// @dev A `type(uint64).max` start must produce the typed error, not an arithmetic
    ///      panic — a panic in a user-facing create path reads as a contract bug.
    function test_Bounds_MaxUint64StartRevertsTyped() public {
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.InvalidStart.selector, type(uint64).max));
        factory.createVesting(address(token), teamMember, GRANT, type(uint64).max, DURATION, 0);
        vm.stopPrank();
    }

    function test_Bounds_BackdatedStartVestsImmediately() public {
        uint64 start = uint64(block.timestamp) - 10 days;
        TegridyVestingWallet w = _create(start, DURATION, 0, GRANT);
        assertGt(w.releasable(address(token)), 0, "back-dated schedule must be partly vested");
    }

    function test_ZeroAddressAndAmountRevert() public {
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(VestingFactory.ZeroAddress.selector);
        factory.createVesting(address(0), teamMember, GRANT, uint64(block.timestamp), DURATION, 0);
        vm.expectRevert(VestingFactory.ZeroAddress.selector);
        factory.createVesting(address(token), address(0), GRANT, uint64(block.timestamp), DURATION, 0);
        vm.expectRevert(VestingFactory.ZeroAmount.selector);
        factory.createVesting(address(token), teamMember, 0, uint64(block.timestamp), DURATION, 0);
        vm.stopPrank();
    }

    function test_FeeOnTransferToken_FundedIsMeasured() public {
        MockVestFoT fot = new MockVestFoT(500);
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(factory), 1000 ether);
        address w = factory.createVesting(address(fot), teamMember, 1000 ether, uint64(block.timestamp), DURATION, 0);
        vm.stopPrank();
        assertEq(fot.balanceOf(w), 950 ether);
        assertEq(factory.totalVestedInflow(address(fot)), 950 ether, "registry must record measured inflow");
    }

    function test_FullTakeToken_CreateReverts() public {
        MockVestFoT fot = new MockVestFoT(10_000);
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(factory), 1000 ether);
        vm.expectRevert(VestingFactory.NoFundsReceived.selector);
        factory.createVesting(address(fot), teamMember, 1000 ether, uint64(block.timestamp), DURATION, 0);
        vm.stopPrank();
    }

    // ─── Fee posture ─────────────────────────────────────────────────

    function test_Fee_ShipsAtZero() public view {
        assertEq(factory.createFeeWei(), 0);
        assertEq(factory.feeSink(), address(0));
    }

    function test_Fee_CannotArmWithoutSink() public {
        vm.prank(owner);
        vm.expectRevert(VestingFactory.FeeSinkUnset.selector);
        factory.proposeCreateFee(0.001 ether);
    }

    function test_Fee_CapEnforced() public {
        address sink = address(new PlainSink());
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        factory.executeFeeSink(sink);
        uint256 cap = factory.MAX_CREATE_FEE_WEI();
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.FeeAboveCap.selector, cap + 1, cap));
        factory.proposeCreateFee(cap + 1);
        vm.stopPrank();
    }

    function test_Fee_TimelockRequired() public {
        address sink = address(new PlainSink());
        vm.startPrank(owner);
        factory.proposeFeeSink(sink);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, factory.FEE_SINK_CHANGE()));
        factory.executeFeeSink(sink);
        vm.stopPrank();
    }

    function test_Fee_ChargedAndForwarded() public {
        PlainSink sink = new PlainSink();
        _armFee(0.001 ether, address(sink));

        vm.deal(creator, 1 ether);
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.IncorrectFee.selector, 0.001 ether, 0));
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), DURATION, 0);

        address w = factory.createVesting{value: 0.001 ether}(
            address(token), teamMember, GRANT, uint64(block.timestamp), DURATION, 0
        );
        vm.stopPrank();

        assertEq(address(sink).balance, 0.001 ether);
        assertEq(address(factory).balance, 0, "factory must not retain fee ETH");
        assertEq(token.balanceOf(w), GRANT);
    }

    function test_Fee_RevertingSinkFailsCreation() public {
        _armFee(0.001 ether, address(new RevertingSink()));
        vm.deal(creator, 1 ether);
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(VestingFactory.FeeForwardFailed.selector);
        factory.createVesting{value: 0.001 ether}(
            address(token), teamMember, GRANT, uint64(block.timestamp), DURATION, 0
        );
        vm.stopPrank();
        assertEq(factory.vestingCount(), 0, "failed fee forward must not leave a registry row");
    }

    function test_Fee_OnlyOwnerAndValueBound() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.proposeFeeSink(address(0xBEEF));

        address sink = address(new PlainSink());
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.prank(owner);
        vm.expectRevert(VestingFactory.PendingValueMismatch.selector);
        factory.executeFeeSink(address(0xBEEF));
    }

    // ─── Pause / guardian ────────────────────────────────────────────

    function test_Pause_BlocksCreationOnly() public {
        vm.prank(owner);
        factory.pause();
        vm.startPrank(creator);
        token.approve(address(factory), GRANT);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createVesting(address(token), teamMember, GRANT, uint64(block.timestamp), DURATION, 0);
        vm.stopPrank();
    }

    function test_Pause_GuardianCanPauseNotUnpause() public {
        vm.prank(owner);
        factory.setPauseGuardian(guardian);
        vm.prank(guardian);
        factory.guardianPause();
        assertTrue(factory.paused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.unpause();
    }

    function test_Factory_RenounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(OwnableNoRenounce.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    // ─── Reentrancy ──────────────────────────────────────────────────

    function test_Reentrancy_TokenCallbackCannotReenterCreate() public {
        MockVestReentrantToken rt = new MockVestReentrantToken();
        rt.transfer(creator, 10_000 ether);
        rt.arm(
            address(factory),
            abi.encodeWithSelector(
                factory.createVesting.selector,
                address(rt),
                teamMember,
                uint256(100 ether),
                uint64(block.timestamp),
                DURATION,
                uint64(0)
            )
        );
        vm.startPrank(creator);
        rt.approve(address(factory), 10_000 ether);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        factory.createVesting(address(rt), teamMember, 200 ether, uint64(block.timestamp), DURATION, 0);
        vm.stopPrank();
    }

    // ─── Registry ────────────────────────────────────────────────────

    function test_Registry_Views() public {
        TegridyVestingWallet w1 = _create();
        TegridyVestingWallet w2 = _create();

        assertEq(factory.vestingCount(), 2);
        assertTrue(factory.isVesting(address(w1)));
        assertTrue(factory.isVesting(address(w2)));
        assertFalse(factory.isVesting(address(0xDEAD)));
        assertEq(factory.vestingsForBeneficiary(teamMember).length, 2);
        assertEq(factory.vestingsForCreator(creator).length, 2);
        assertEq(factory.vestingCountForToken(address(token)), 2);
        assertEq(factory.totalVestedInflow(address(token)), GRANT * 2);

        (address[] memory page, uint256 next) = factory.vestingsForTokenSlice(address(token), 0, 1);
        assertEq(page.length, 1);
        assertEq(page[0], address(w1));
        assertEq(next, 1, "partial scan must report a continuation offset");

        (page, next) = factory.vestingsForTokenSlice(address(token), 1, 5);
        assertEq(page[0], address(w2));
        assertEq(next, 0);

        (page, next) = factory.vestingsForTokenSlice(address(token), 9, 5);
        assertEq(page.length, 0);
        assertEq(next, 0);
    }

    /// @dev Cumulative inflow does NOT fall as the beneficiary releases. Asserted so the
    ///      field's meaning stays pinned: it is "total ever vested through this factory",
    ///      never "currently locked".
    function test_Registry_InflowIsCumulativeNotCurrent() public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create();
        vm.warp(start + DURATION);
        w.release(address(token));
        assertEq(token.balanceOf(address(w)), 0);
        assertEq(factory.totalVestedInflow(address(token)), GRANT, "inflow must not decay on release");
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_ReleasableNeverExceedsFundedAndIsMonotonic(uint64 t1, uint64 t2, uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, 100_000 ether);
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create(start, DURATION, CLIFF, amount);

        uint64 a = uint64(bound(uint256(t1), start, start + 2 * DURATION));
        uint64 b = uint64(bound(uint256(t2), a, start + 2 * DURATION));

        vm.warp(a);
        uint256 vestedA = w.vestedAmount(address(token), a);
        assertLe(vestedA, amount, "vested exceeded the funded amount");

        vm.warp(b);
        uint256 vestedB = w.vestedAmount(address(token), b);
        assertGe(vestedB, vestedA, "vesting went backwards");
        assertLe(vestedB, amount);
    }

    function testFuzz_NothingReleasableBeforeCliff(uint64 t) public {
        uint64 start = uint64(block.timestamp);
        TegridyVestingWallet w = _create(start, DURATION, CLIFF, GRANT);
        uint64 when = uint64(bound(uint256(t), start, start + CLIFF - 1));
        vm.warp(when);
        assertEq(w.releasable(address(token)), 0);
        w.release(address(token));
        assertEq(token.balanceOf(teamMember), 0);
    }
}
