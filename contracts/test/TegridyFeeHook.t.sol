// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyFeeHook.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @dev Minimal mock PoolManager — most admin/timelock tests just need a
///      non-zero address. The H-5 sync-direction tests also exercise the
///      on-chain credit check, so we expose a configurable `balanceOf`
///      stub matching the IERC6909Claims surface.
contract MockPoolManager {
    mapping(address => mapping(uint256 => uint256)) internal _credit;

    function setCredit(address holder, uint256 id, uint256 amount) external {
        _credit[holder][id] = amount;
    }

    function balanceOf(address holder, uint256 id) external view returns (uint256) {
        return _credit[holder][id];
    }
}

contract TegridyFeeHookTest is Test {
    TegridyFeeHook public hook;
    MockPoolManager public poolManager;

    address public owner;
    address public alice = makeAddr("alice");
    address public distributor = makeAddr("distributor");
    address public newDistributor = makeAddr("newDistributor");

    uint256 public constant INITIAL_FEE = 30; // 0.3%

    function setUp() public {
        owner = address(this);
        poolManager = new MockPoolManager();

        // The TegridyFeeHook constructor requires: uint160(address(this)) & 0x0044 == 0x0044
        // Use deployCodeTo to place the contract at a valid hook address.
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolManager)), distributor, INITIAL_FEE, owner);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    // ─── Constructor validation ─────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(hook.poolManager()), address(poolManager));
        assertEq(hook.revenueDistributor(), distributor);
        assertEq(hook.feeBps(), INITIAL_FEE);
    }

    function test_constructor_revert_zeroPoolManager() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        new TegridyFeeHook(IPoolManager(address(0)), distributor, INITIAL_FEE, owner);
    }

    function test_constructor_revert_zeroDistributor() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        new TegridyFeeHook(IPoolManager(address(poolManager)), address(0), INITIAL_FEE, owner);
    }

    function test_constructor_revert_zeroOwner() public {
        // OwnableNoRenounce(address(0)) reverts with OwnableInvalidOwner — we don't
        // duplicate the zero check in TegridyFeeHook's own body.
        vm.expectRevert(
            abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0))
        );
        new TegridyFeeHook(IPoolManager(address(poolManager)), distributor, INITIAL_FEE, address(0));
    }

    function test_constructor_revert_feeTooHigh() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        new TegridyFeeHook(IPoolManager(address(poolManager)), distributor, 101, owner);
    }

    // ─── Deprecated setFee() reverts ────────────────────────────────

    function test_setFee_reverts() public {
        vm.expectRevert("Use proposeFeeChange() + executeFeeChange()");
        hook.setFee(50);
    }

    // ─── Deprecated setRevenueDistributor() reverts ─────────────────

    function test_setRevenueDistributor_reverts() public {
        vm.expectRevert("Use proposeDistributorChange() + executeDistributorChange()");
        hook.setRevenueDistributor(alice);
    }

    // ═══════════════════════════════════════════════════════════════
    // Fee Timelock (24h)
    // ═══════════════════════════════════════════════════════════════

    function test_proposeFeeChange_setsState() public {
        hook.proposeFeeChange(100);
        assertEq(hook.pendingFee(), 100);
        assertEq(hook.feeChangeTime(), block.timestamp + 24 hours);
    }

    function test_proposeFeeChange_revertWhen_feeTooHigh() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        hook.proposeFeeChange(101);
    }

    function test_proposeFeeChange_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.proposeFeeChange(100);
    }

    function test_executeFeeChange_happyPath() public {
        uint256 newFee = 100;
        hook.proposeFeeChange(newFee);

        // Warp past timelock
        vm.warp(block.timestamp + 24 hours);

        hook.executeFeeChange();
        assertEq(hook.feeBps(), newFee);
        assertEq(hook.feeChangeTime(), 0, "feeChangeTime should be reset");
    }

    function test_executeFeeChange_emitsEvent() public {
        hook.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours);

        vm.expectEmit(false, false, false, true);
        emit TegridyFeeHook.FeeUpdated(INITIAL_FEE, 50);
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_timelockNotExpired() public {
        hook.proposeFeeChange(100);

        // Warp to just before expiry
        vm.warp(block.timestamp + 24 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_notOwner() public {
        hook.proposeFeeChange(100);
        vm.warp(block.timestamp + 24 hours);

        vm.prank(alice);
        vm.expectRevert();
        hook.executeFeeChange();
    }

    // ═══════════════════════════════════════════════════════════════
    // Distributor Timelock (48h)
    // ═══════════════════════════════════════════════════════════════

    function test_proposeDistributorChange_setsState() public {
        hook.proposeDistributorChange(newDistributor);
        assertEq(hook.pendingDistributor(), newDistributor);
        assertEq(hook.distributorChangeTime(), block.timestamp + 48 hours);
    }

    function test_proposeDistributorChange_revertWhen_zeroAddress() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        hook.proposeDistributorChange(address(0));
    }

    function test_proposeDistributorChange_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.proposeDistributorChange(newDistributor);
    }

    function test_executeDistributorChange_happyPath() public {
        hook.proposeDistributorChange(newDistributor);

        vm.warp(block.timestamp + 48 hours);

        hook.executeDistributorChange();
        assertEq(hook.revenueDistributor(), newDistributor);
        assertEq(hook.distributorChangeTime(), 0, "distributorChangeTime should be reset");
    }

    function test_executeDistributorChange_emitsEvent() public {
        hook.proposeDistributorChange(newDistributor);
        vm.warp(block.timestamp + 48 hours);

        vm.expectEmit(true, true, false, false);
        emit TegridyFeeHook.DistributorUpdated(distributor, newDistributor);
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_timelockNotExpired() public {
        hook.proposeDistributorChange(newDistributor);

        vm.warp(block.timestamp + 48 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_notOwner() public {
        hook.proposeDistributorChange(newDistributor);
        vm.warp(block.timestamp + 48 hours);

        vm.prank(alice);
        vm.expectRevert();
        hook.executeDistributorChange();
    }

    // ─── Execute without proposal should revert ─────────────────────

    function test_executeFeeChange_withoutProposal_reverts() public {
        // feeChangeTime is 0 by default (no proposal)
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeDistributorChange_withoutProposal_reverts() public {
        // distributorChangeTime is 0 by default (no proposal)
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    // ─── Receive ETH ────────────────────────────────────────────────

    function test_receiveETH() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(hook).call{value: 0.5 ether}("");
        assertTrue(ok, "Hook should accept ETH");
    }

    // ─── MAX_FEE_BPS boundary ───────────────────────────────────────

    function test_proposeFeeChange_atMaxFee() public {
        hook.proposeFeeChange(100); // Exactly MAX_FEE_BPS (1%)
        assertEq(hook.pendingFee(), 100);
    }

    function test_proposeFeeChange_aboveMaxFee() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        hook.proposeFeeChange(101);
    }

    // ═══════════════════════════════════════════════════════════════
    // X-05: Sync Accrued Fees Bounded Reduction
    // ═══════════════════════════════════════════════════════════════

    function test_syncAccruedFees_rejectsReductionOver50Percent() public {
        // H-01 audit fix: 50% cap was removed. Sync now succeeds with >50% reduction
        // as long as 24h timelock and 7-day cooldown are respected.
        address token = makeAddr("token");
        // Simulate accrued fees by writing to storage directly
        bytes32 slot = keccak256(abi.encode(token, uint256(7))); // accruedFees mapping slot
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        assertEq(hook.accruedFees(token), 1000);

        // Propose syncing down to 400 (60% reduction — now allowed after H-01 fix)
        hook.proposeSyncAccruedFees(token, 400);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 400, "60% reduction allowed after H-01 fix");
    }

    function test_syncAccruedFees_allowsReductionAtExactly50Percent() public {
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(7)));
        vm.store(address(hook), slot, bytes32(uint256(1000)));

        // Propose syncing down to 500 (exactly 50% reduction — should succeed)
        hook.proposeSyncAccruedFees(token, 500);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 500);
    }

    function test_syncAccruedFees_rejectsIncrease_aboveOnChainCredit() public {
        // H-5 update: upward syncs are now ALLOWED, but bounded by the
        // on-chain PoolManager credit. With on-chain credit = 0, any
        // upward sync (1500 > 1000) reverts with AboveOnChainCredit.
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(7)));
        vm.store(address(hook), slot, bytes32(uint256(1000)));

        hook.proposeSyncAccruedFees(token, 1500);
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(TegridyFeeHook.AboveOnChainCredit.selector);
        hook.executeSyncAccruedFees(token);
    }

    function test_syncAccruedFees_allowsIncrease_withinOnChainCredit() public {
        // H-5: upward sync is allowed up to the on-chain PoolManager credit.
        // Set on-chain credit to 1500 → sync from 1000 to 1500 succeeds.
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(7)));
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        // Stub the PoolManager credit at the V4 currency-id (uint256(uint160(token)))
        poolManager.setCredit(address(hook), uint256(uint160(token)), 1500);

        hook.proposeSyncAccruedFees(token, 1500);
        vm.warp(block.timestamp + 7 days);
        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 1500);
    }

    function test_syncAccruedFees_allowsSmallReduction() public {
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(7)));
        vm.store(address(hook), slot, bytes32(uint256(1000)));

        // Propose syncing down to 900 (10% reduction — should succeed)
        hook.proposeSyncAccruedFees(token, 900);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 900);
    }
}
