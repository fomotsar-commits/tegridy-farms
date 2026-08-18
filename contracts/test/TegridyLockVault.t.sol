// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TegridyLockVault} from "../src/TegridyLockVault.sol";
import {OwnableNoRenounce} from "../src/base/OwnableNoRenounce.sol";
import {PauseGuardian} from "../src/base/PauseGuardian.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockLPToken is ERC20 {
    constructor() ERC20("LP", "LP") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockLockFoT is ERC20 {
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

contract MockLockReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;

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
            reentryAttempted = true;
            (bool ok,) = target.call(payload);
            reentrySucceeded = ok;
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

contract TegridyLockVaultTest is Test {
    TegridyLockVault vault;
    MockLPToken lp;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");

    uint256 constant AMOUNT = 1000 ether;
    uint64 constant LOCK_FOR = 90 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        vault = new TegridyLockVault(owner);
        lp = new MockLPToken();
        lp.transfer(creator, 500_000 ether);
    }

    function _warpToReady(bytes32 key) internal {
        uint256 readyAt = vault.proposalExecuteAfter(key);
        assertGt(readyAt, 0, "no pending proposal for key");
        vm.warp(readyAt);
    }

    function _lock(uint256 amount, uint64 unlockAt) internal returns (uint256 id) {
        vm.startPrank(creator);
        lp.approve(address(vault), amount);
        id = vault.lock(address(lp), amount, unlockAt);
        vm.stopPrank();
    }

    function _lock() internal returns (uint256 id) {
        return _lock(AMOUNT, uint64(block.timestamp) + LOCK_FOR);
    }

    function _armFee(uint256 fee, address sink) internal {
        vm.prank(owner);
        vault.proposeFeeSink(sink);
        _warpToReady(vault.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        vault.executeFeeSink(sink);
        vault.proposeLockFee(fee);
        vm.stopPrank();
        _warpToReady(vault.LOCK_FEE_CHANGE());
        vm.prank(owner);
        vault.executeLockFee(fee);
    }

    // ─── Happy path ──────────────────────────────────────────────────

    function test_HappyPath_LockThenWithdrawAfterMaturity() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();

        assertEq(id, 1, "ids must start at 1 so zero stays the 'no lock' sentinel");
        TegridyLockVault.LockView memory v = vault.lockView(id);
        assertEq(v.token, address(lp));
        assertEq(v.owner, creator);
        assertEq(v.amount, AMOUNT);
        assertEq(v.unlockAt, unlockAt);
        assertFalse(v.withdrawn);
        assertFalse(v.matured);
        assertEq(vault.totalLocked(address(lp)), AMOUNT);
        assertEq(lp.balanceOf(address(vault)), AMOUNT);

        vm.warp(unlockAt);
        assertTrue(vault.lockView(id).matured);
        uint256 before = lp.balanceOf(creator);
        vm.prank(creator);
        uint256 got = vault.withdraw(id);

        assertEq(got, AMOUNT);
        assertEq(lp.balanceOf(creator), before + AMOUNT);
        assertEq(vault.totalLocked(address(lp)), 0);
        assertTrue(vault.lockView(id).withdrawn);
    }

    // ─── Maturity boundary ───────────────────────────────────────────

    function test_Boundary_WithdrawOneSecondEarlyReverts() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.LockNotMatured.selector, unlockAt));
        vault.withdraw(id);
    }

    function test_Boundary_WithdrawAtExactUnlockSucceeds() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt);
        vm.prank(creator);
        vault.withdraw(id);
        assertEq(lp.balanceOf(address(vault)), 0);
    }

    function test_Boundary_LockDurationBoundsEnforced() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 min = vault.MIN_LOCK_DURATION();
        uint64 max = vault.MAX_LOCK_DURATION();
        vm.startPrank(creator);
        lp.approve(address(vault), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                TegridyLockVault.InvalidUnlockTime.selector, nowTs + min - 1, nowTs + min, nowTs + max
            )
        );
        vault.lock(address(lp), AMOUNT, nowTs + min - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                TegridyLockVault.InvalidUnlockTime.selector, nowTs + max + 1, nowTs + min, nowTs + max
            )
        );
        vault.lock(address(lp), AMOUNT, nowTs + max + 1);

        // Both endpoints inclusive.
        vault.lock(address(lp), AMOUNT, nowTs + min);
        vault.lock(address(lp), AMOUNT, nowTs + max);
        vm.stopPrank();
    }

    // ─── Access control ──────────────────────────────────────────────

    function test_Withdraw_OnlyLockOwner() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt);

        vm.prank(stranger);
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.withdraw(id);

        vm.prank(owner); // the protocol owner is not privileged here
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.withdraw(id);
    }

    function test_Withdraw_DoubleWithdrawReverts() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt);
        vm.startPrank(creator);
        vault.withdraw(id);
        vm.expectRevert(TegridyLockVault.LockAlreadyWithdrawn.selector);
        vault.withdraw(id);
        vm.stopPrank();
    }

    function test_UnknownLockIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.UnknownLock.selector, uint256(0)));
        vault.lockView(0);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.UnknownLock.selector, uint256(42)));
        vault.lockView(42);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.UnknownLock.selector, uint256(42)));
        vault.withdraw(42);
    }

    /// @dev The property that makes an "LP locked" badge honest: no owner-reachable path
    ///      touches a depositor's tokens at any pause state or fee setting.
    function test_ProtocolOwner_HasNoPathToDepositorFunds() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();

        vm.startPrank(owner);
        vault.pause();
        (bool a,) = address(vault).call(abi.encodeWithSignature("sweep(address)", address(lp)));
        (bool b,) = address(vault).call(abi.encodeWithSignature("rescue(address,uint256)", address(lp), AMOUNT));
        (bool c,) = address(vault).call(abi.encodeWithSignature("emergencyWithdraw(uint256)", id));
        (bool d,) = address(vault).call(abi.encodeWithSignature("setUnlockAt(uint256,uint64)", id, uint64(0)));
        vm.stopPrank();
        assertFalse(a || b || c || d, "an owner escape hatch exists");
        assertEq(lp.balanceOf(address(vault)), AMOUNT);

        // Matured locks still release while paused.
        vm.warp(unlockAt);
        vm.prank(creator);
        vault.withdraw(id);
        assertEq(lp.balanceOf(address(vault)), 0);
    }

    function test_Pause_BlocksNewLocksAndTopUpsOnly() public {
        uint256 id = _lock();
        vm.prank(owner);
        vault.pause();

        vm.startPrank(creator);
        lp.approve(address(vault), AMOUNT);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.lock(address(lp), AMOUNT, uint64(block.timestamp) + LOCK_FOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.increase(id, AMOUNT);

        // Extending and handing over a lock stay available: neither moves funds out.
        vault.extend(id, uint64(block.timestamp) + 200 days);
        vault.proposeLockOwner(id, stranger);
        vm.stopPrank();
    }

    function test_Pause_GuardianCanPauseNotUnpause() public {
        vm.prank(owner);
        vault.setPauseGuardian(guardian);
        vm.prank(stranger);
        vm.expectRevert(PauseGuardian.NotPauseGuardian.selector);
        vault.guardianPause();
        vm.prank(guardian);
        vault.guardianPause();
        assertTrue(vault.paused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.unpause();
    }

    function test_Vault_RenounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(OwnableNoRenounce.RenounceDisabled.selector);
        vault.renounceOwnership();
    }

    // ─── Extend / increase ───────────────────────────────────────────

    function test_Extend_IsMonotonicOnly() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();

        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.UnlockNotExtended.selector, unlockAt, unlockAt));
        vault.extend(id, unlockAt);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.UnlockNotExtended.selector, unlockAt, unlockAt - 1));
        vault.extend(id, unlockAt - 1);
        vault.extend(id, unlockAt + 1 days);
        vm.stopPrank();

        assertEq(vault.lockView(id).unlockAt, unlockAt + 1 days);
    }

    function test_Extend_OnlyOwnerAndBoundedByMaxDuration() public {
        uint256 id = _lock();
        vm.prank(stranger);
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.extend(id, uint64(block.timestamp) + 200 days);

        uint64 tooFar = uint64(block.timestamp) + vault.MAX_LOCK_DURATION() + 1;
        vm.prank(creator);
        vm.expectRevert();
        vault.extend(id, tooFar);
    }

    function test_Extend_WorksAfterMaturityToRenewACommitment() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt + 1 days);
        // Absolute target rather than `block.timestamp + 30 days`: solc hoists TIMESTAMP
        // within a function, so the relative form would compute against the pre-warp
        // instant and land in the past.
        uint64 renewedTo = unlockAt + 31 days;
        vm.prank(creator);
        vault.extend(id, renewedTo);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.LockNotMatured.selector, renewedTo));
        vault.withdraw(id);
    }

    function test_Increase_AddsToTheSameLock() public {
        uint256 id = _lock();
        vm.startPrank(creator);
        lp.approve(address(vault), 500 ether);
        vault.increase(id, 500 ether);
        vm.stopPrank();
        assertEq(vault.lockView(id).amount, AMOUNT + 500 ether);
        assertEq(vault.totalLocked(address(lp)), AMOUNT + 500 ether);
    }

    function test_Increase_OnlyOwnerAndNonZero() public {
        uint256 id = _lock();
        vm.prank(stranger);
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.increase(id, 1 ether);
        vm.prank(creator);
        vm.expectRevert(TegridyLockVault.ZeroAmount.selector);
        vault.increase(id, 0);
    }

    function test_Increase_AfterWithdrawReverts() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();
        vm.warp(unlockAt);
        vm.startPrank(creator);
        vault.withdraw(id);
        lp.approve(address(vault), 1 ether);
        vm.expectRevert(TegridyLockVault.LockAlreadyWithdrawn.selector);
        vault.increase(id, 1 ether);
        vm.stopPrank();
    }

    // ─── Lock ownership handover ─────────────────────────────────────

    function test_Handover_TwoStep() public {
        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        uint256 id = _lock();

        vm.prank(stranger);
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.proposeLockOwner(id, stranger);

        vm.prank(creator);
        vault.proposeLockOwner(id, stranger);
        assertEq(vault.lockView(id).owner, creator, "ownership must not move before acceptance");

        vm.prank(makeAddr("someoneElse"));
        vm.expectRevert(TegridyLockVault.NotPendingLockOwner.selector);
        vault.acceptLockOwner(id);

        vm.prank(stranger);
        vault.acceptLockOwner(id);
        assertEq(vault.lockView(id).owner, stranger);
        assertEq(vault.lockView(id).pendingOwner, address(0));

        vm.warp(unlockAt);
        vm.prank(creator);
        vm.expectRevert(TegridyLockVault.NotLockOwner.selector);
        vault.withdraw(id);
        vm.prank(stranger);
        vault.withdraw(id);
        assertEq(lp.balanceOf(stranger), AMOUNT);
    }

    function test_Handover_CancelAndZeroChecks() public {
        uint256 id = _lock();
        vm.startPrank(creator);
        vm.expectRevert(TegridyLockVault.ZeroAddress.selector);
        vault.proposeLockOwner(id, address(0));
        vm.expectRevert(TegridyLockVault.NoPendingLockOwner.selector);
        vault.cancelLockOwnerTransfer(id);
        vault.proposeLockOwner(id, stranger);
        vault.cancelLockOwnerTransfer(id);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(TegridyLockVault.NoPendingLockOwner.selector);
        vault.acceptLockOwner(id);
    }

    // ─── Zero / edge amounts ─────────────────────────────────────────

    function test_ZeroAmountAndZeroTokenRevert() public {
        vm.startPrank(creator);
        lp.approve(address(vault), AMOUNT);
        vm.expectRevert(TegridyLockVault.ZeroAmount.selector);
        vault.lock(address(lp), 0, uint64(block.timestamp) + LOCK_FOR);
        vm.expectRevert(TegridyLockVault.ZeroAddress.selector);
        vault.lock(address(0), AMOUNT, uint64(block.timestamp) + LOCK_FOR);
        vm.stopPrank();
    }

    function test_FeeOnTransferToken_AmountIsMeasured() public {
        MockLockFoT fot = new MockLockFoT(500);
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(vault), 1000 ether);
        uint256 id = vault.lock(address(fot), 1000 ether, uint64(block.timestamp) + LOCK_FOR);
        vm.stopPrank();
        assertEq(vault.lockView(id).amount, 950 ether, "lock must record what arrived");
        assertEq(vault.totalLocked(address(fot)), 950 ether);
    }

    function test_FullTakeToken_LockReverts() public {
        MockLockFoT fot = new MockLockFoT(10_000);
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(vault), 1000 ether);
        vm.expectRevert(TegridyLockVault.NoFundsReceived.selector);
        vault.lock(address(fot), 1000 ether, uint64(block.timestamp) + LOCK_FOR);
        vm.stopPrank();
    }

    // ─── Fee posture ─────────────────────────────────────────────────

    function test_Fee_ShipsAtZero() public view {
        assertEq(vault.lockFeeWei(), 0);
        assertEq(vault.feeSink(), address(0));
    }

    function test_Fee_CannotArmWithoutSink() public {
        vm.prank(owner);
        vm.expectRevert(TegridyLockVault.FeeSinkUnset.selector);
        vault.proposeLockFee(0.001 ether);
    }

    function test_Fee_CapEnforcedAndTimelocked() public {
        address sink = address(new PlainSink());
        vm.startPrank(owner);
        vault.proposeFeeSink(sink);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, vault.FEE_SINK_CHANGE()));
        vault.executeFeeSink(sink);
        vm.stopPrank();
        _warpToReady(vault.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        vault.executeFeeSink(sink);
        uint256 cap = vault.MAX_LOCK_FEE_WEI();
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.FeeAboveCap.selector, cap + 1, cap));
        vault.proposeLockFee(cap + 1);
        vm.stopPrank();
    }

    function test_Fee_ChargedForwardedAndExact() public {
        PlainSink sink = new PlainSink();
        _armFee(0.001 ether, address(sink));
        vm.deal(creator, 1 ether);

        vm.startPrank(creator);
        lp.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.IncorrectFee.selector, 0.001 ether, 0));
        vault.lock(address(lp), AMOUNT, uint64(block.timestamp) + LOCK_FOR);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.IncorrectFee.selector, 0.001 ether, 0.002 ether));
        vault.lock{value: 0.002 ether}(address(lp), AMOUNT, uint64(block.timestamp) + LOCK_FOR);
        uint256 id = vault.lock{value: 0.001 ether}(address(lp), AMOUNT, uint64(block.timestamp) + LOCK_FOR);

        // Top-ups are never charged again.
        vault.increase(id, 1 ether);
        vm.stopPrank();

        assertEq(address(sink).balance, 0.001 ether);
        assertEq(address(vault).balance, 0, "vault must not retain fee ETH");
    }

    function test_Fee_RevertingSinkFailsTheLock() public {
        _armFee(0.001 ether, address(new RevertingSink()));
        vm.deal(creator, 1 ether);
        vm.startPrank(creator);
        lp.approve(address(vault), AMOUNT);
        vm.expectRevert(TegridyLockVault.FeeForwardFailed.selector);
        vault.lock{value: 0.001 ether}(address(lp), AMOUNT, uint64(block.timestamp) + LOCK_FOR);
        vm.stopPrank();
    }

    function test_Fee_SinkCannotBeUnsetWhileFeeIsLive() public {
        _armFee(0.001 ether, address(new PlainSink()));
        vm.prank(owner);
        vm.expectRevert(TegridyLockVault.FeeSinkUnset.selector);
        vault.proposeFeeSink(address(0));
    }

    function test_Fee_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.proposeLockFee(0);
    }

    // ─── Reentrancy ──────────────────────────────────────────────────

    function test_Reentrancy_TokenCallbackCannotDoubleWithdraw() public {
        MockLockReentrantToken rt = new MockLockReentrantToken();
        rt.transfer(creator, 10_000 ether);

        uint64 unlockAt = uint64(block.timestamp) + LOCK_FOR;
        vm.startPrank(creator);
        rt.approve(address(vault), 1000 ether);
        uint256 id = vault.lock(address(rt), 1000 ether, unlockAt);
        vm.stopPrank();

        rt.arm(address(vault), abi.encodeWithSelector(vault.withdraw.selector, id));
        vm.warp(unlockAt);
        vm.prank(creator);
        vault.withdraw(id);

        // The mock records the re-entry rather than bubbling it, so the assertion is on
        // the effect: the callback fired, the guard rejected it, and the depositor was
        // paid exactly once.
        assertTrue(rt.reentryAttempted(), "callback never fired");
        assertFalse(rt.reentrySucceeded(), "re-entrant withdraw was allowed");
        assertEq(rt.balanceOf(creator), 10_000 ether, "double payout");
        assertEq(rt.balanceOf(address(vault)), 0);
        assertEq(vault.totalLocked(address(rt)), 0);
    }

    function test_Reentrancy_TokenCallbackCannotReenterLock() public {
        MockLockReentrantToken rt = new MockLockReentrantToken();
        rt.transfer(creator, 10_000 ether);
        rt.arm(
            address(vault),
            abi.encodeWithSelector(
                vault.lock.selector, address(rt), uint256(100 ether), uint64(block.timestamp) + LOCK_FOR
            )
        );
        vm.startPrank(creator);
        rt.approve(address(vault), 10_000 ether);
        uint256 id = vault.lock(address(rt), 1000 ether, uint64(block.timestamp) + LOCK_FOR);
        vm.stopPrank();

        assertTrue(rt.reentryAttempted(), "callback never fired");
        assertFalse(rt.reentrySucceeded(), "re-entrant lock was allowed");
        assertEq(id, 1, "a second lock id was minted by re-entry");
        assertEq(vault.nextLockId(), 2);
        assertEq(vault.totalLocked(address(rt)), 1000 ether);
        assertEq(rt.balanceOf(address(vault)), 1000 ether);
    }

    // ─── Scanner read surface ────────────────────────────────────────

    function test_TokenLockSummary_AggregatesActiveLocksOnly() public {
        uint64 t = uint64(block.timestamp);
        _lock(100 ether, t + 30 days);
        _lock(200 ether, t + 60 days);
        uint256 id3 = _lock(300 ether, t + 2 days);

        (uint256 amount, uint64 earliest, uint64 latest, uint256 active, uint256 next) =
            vault.tokenLockSummary(address(lp), 0, 100);
        assertEq(amount, 600 ether);
        assertEq(earliest, t + 2 days);
        assertEq(latest, t + 60 days);
        assertEq(active, 3);
        assertEq(next, 0, "complete scan must report zero");

        vm.warp(t + 2 days);
        vm.prank(creator);
        vault.withdraw(id3);

        (amount, earliest, latest, active, next) = vault.tokenLockSummary(address(lp), 0, 100);
        assertEq(amount, 300 ether, "withdrawn lock must leave the aggregate");
        assertEq(earliest, t + 30 days);
        assertEq(active, 2);
    }

    /// @dev A truncated scan must announce itself. A caller that publishes an expiry from
    ///      a partial page would understate real locks, which is the fabricated-data
    ///      failure pointing the other way.
    function test_TokenLockSummary_PartialScanReportsContinuation() public {
        uint64 t = uint64(block.timestamp);
        _lock(100 ether, t + 30 days);
        _lock(200 ether, t + 60 days);

        (uint256 amount,,, uint256 active, uint256 next) = vault.tokenLockSummary(address(lp), 0, 1);
        assertEq(amount, 100 ether);
        assertEq(active, 1);
        assertEq(next, 1, "partial scan must hand back a continuation offset");

        (amount,,, active, next) = vault.tokenLockSummary(address(lp), 1, 1);
        assertEq(amount, 200 ether);
        assertEq(next, 0);

        (amount,,, active, next) = vault.tokenLockSummary(address(lp), 99, 10);
        assertEq(amount, 0);
        assertEq(next, 0);
    }

    function test_TokenLockSummary_UnknownTokenReportsZeroNotRevert() public view {
        (uint256 amount, uint64 earliest, uint64 latest, uint256 active, uint256 next) =
            vault.tokenLockSummary(address(0xDEAD), 0, 100);
        assertEq(amount, 0);
        assertEq(earliest, 0);
        assertEq(latest, 0);
        assertEq(active, 0);
        assertEq(next, 0);
    }

    function test_LockIndexViews() public {
        uint256 id1 = _lock();
        _lock();
        assertEq(vault.lockCountForToken(address(lp)), 2);
        assertEq(vault.lockCountForOwner(creator), 2);
        assertEq(vault.lockIdsForOwner(creator)[0], id1);

        // After a handover the new owner is indexed too; the old index keeps a stale
        // entry by design, so callers must filter on `lockView(id).owner`.
        vm.prank(creator);
        vault.proposeLockOwner(id1, stranger);
        vm.prank(stranger);
        vault.acceptLockOwner(id1);
        assertEq(vault.lockCountForOwner(stranger), 1);
        assertEq(vault.lockCountForOwner(creator), 2, "index is append-only");
        assertEq(vault.lockView(id1).owner, stranger, "lockView is the authority on ownership");
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_WithdrawImpossibleBeforeUnlock(uint64 durationSeed, uint64 whenSeed) public {
        uint64 t = uint64(block.timestamp);
        uint64 duration = uint64(bound(uint256(durationSeed), vault.MIN_LOCK_DURATION(), 365 days));
        uint64 unlockAt = t + duration;
        uint256 id = _lock(AMOUNT, unlockAt);

        uint64 when = uint64(bound(uint256(whenSeed), t, unlockAt - 1));
        vm.warp(when);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyLockVault.LockNotMatured.selector, unlockAt));
        vault.withdraw(id);
        assertEq(lp.balanceOf(address(vault)), AMOUNT, "vault leaked before maturity");
    }

    function testFuzz_TotalLockedTracksTheVaultBalance(uint96 rawA, uint96 rawB) public {
        uint256 a = bound(uint256(rawA), 1, 100_000 ether);
        uint256 b = bound(uint256(rawB), 1, 100_000 ether);
        uint64 t = uint64(block.timestamp);
        _lock(a, t + 30 days);
        uint256 id2 = _lock(b, t + 30 days);

        assertEq(vault.totalLocked(address(lp)), a + b);
        assertEq(lp.balanceOf(address(vault)), a + b);

        vm.warp(t + 30 days);
        vm.prank(creator);
        vault.withdraw(id2);
        assertEq(vault.totalLocked(address(lp)), a);
        assertEq(lp.balanceOf(address(vault)), a);
    }
}
