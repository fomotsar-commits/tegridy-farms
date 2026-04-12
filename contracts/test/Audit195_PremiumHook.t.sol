// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/PremiumAccess.sol";
import "../src/TegridyFeeHook.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

// ────────────────────── Mocks ──────────────────────

contract MockToweli195 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBAC195 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockPoolManager195 {}

// ═══════════════════════════════════════════════════════════════════
// PremiumAccess Deep Audit Tests
// ═══════════════════════════════════════════════════════════════════

contract Audit195PremiumHookTest is Test {
    PremiumAccess public premium;
    MockToweli195 public token;
    MockJBAC195 public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");

    uint256 public constant MONTHLY_FEE = 1000 ether;
    uint256 public constant MONTH = 30 days;

    // TegridyFeeHook
    TegridyFeeHook public hook;
    MockPoolManager195 public poolManager;
    address public distributor = makeAddr("distributor");
    uint256 public constant INITIAL_FEE = 30;

    function setUp() public {
        // --- PremiumAccess ---
        token = new MockToweli195();
        nft = new MockJBAC195();
        premium = new PremiumAccess(address(token), address(nft), treasury, MONTHLY_FEE);

        token.transfer(alice, 500_000 ether);
        token.transfer(bob, 500_000 ether);

        vm.prank(alice);
        token.approve(address(premium), type(uint256).max);
        vm.prank(bob);
        token.approve(address(premium), type(uint256).max);

        // --- TegridyFeeHook ---
        poolManager = new MockPoolManager195();
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolManager)), distributor, INITIAL_FEE);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    // ═══════════════════════════════════════════════════════════════
    // P-01: subscribe() -- totalRefundEscrow consistency
    // ═══════════════════════════════════════════════════════════════

    function test_P01_subscribeEscrowConsistency_newSub() public {
        vm.prank(alice);
        premium.subscribe(3, type(uint256).max);
        uint256 cost = MONTHLY_FEE * 3;
        assertEq(premium.userEscrow(alice), cost);
        assertEq(premium.totalRefundEscrow(), cost);
        assertEq(premium.totalRevenue(), cost);
    }

    function test_P01_subscribeEscrowConsistency_extension() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);

        // Advance 15 days (half the month), then extend
        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // After extension: remaining escrow from first period + new cost
        // First period: 15 days consumed of 30 days => ~500 remaining escrow
        // Plus new 1000 => ~1500
        assertApproxEqAbs(premium.userEscrow(alice), 1500 ether, 5 ether);
        assertApproxEqAbs(premium.totalRefundEscrow(), 1500 ether, 5 ether);
    }

    function test_P01_subscribeEscrowConsistency_multiUser() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);
        vm.prank(bob);
        premium.subscribe(3, type(uint256).max);

        assertEq(premium.totalRefundEscrow(), 2000 ether + 3000 ether);
        assertEq(premium.userEscrow(alice), 2000 ether);
        assertEq(premium.userEscrow(bob), 3000 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-02: subscribe() -- expired re-subscription clears stale escrow
    // ═══════════════════════════════════════════════════════════════

    function test_P02_resubscribeAfterExpiry_clearsStaleEscrow() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);

        // Let it expire WITHOUT reconciling
        vm.warp(block.timestamp + 31 days);

        // Re-subscribe: the old escrow was stale, should be cleaned up
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // totalRefundEscrow should be only the new subscription, not old+new
        assertEq(premium.userEscrow(alice), MONTHLY_FEE);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-03: SAME_BLOCK_CANCEL protection
    // ═══════════════════════════════════════════════════════════════

    function test_P03_sameBlockCancelBlocked() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // Try cancel in same block
        vm.prank(alice);
        vm.expectRevert("SAME_BLOCK_CANCEL");
        premium.cancelSubscription();
    }

    function test_P03_cancelAllowedNextTimestamp() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        vm.warp(block.timestamp + 1);

        vm.prank(alice);
        premium.cancelSubscription(); // should succeed
        assertEq(premium.userEscrow(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-04: ALREADY_SUBSCRIBED_THIS_BLOCK on extension
    // ═══════════════════════════════════════════════════════════════

    function test_P04_doubleSubscribeSameBlockBlocked() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // Try to extend in the same block (NOT a new sub, same block startedAt)
        vm.prank(alice);
        vm.expectRevert("ALREADY_SUBSCRIBED_THIS_BLOCK");
        premium.subscribe(1, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-05: cancelSubscription() -- totalRevenue accuracy after fix
    // ═══════════════════════════════════════════════════════════════

    function test_P05_totalRevenueDecreasedOnCancel() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);
        assertEq(premium.totalRevenue(), 2000 ether);

        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        premium.cancelSubscription();

        // totalRevenue should be reduced by refund amount
        // 15d consumed of 60d => refund ~75% of 2000 = ~1500
        // totalRevenue = 2000 - ~1500 = ~500
        assertApproxEqAbs(premium.totalRevenue(), 500 ether, 10 ether);
    }

    function test_P05_totalRevenueIncreasesOnExtension() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        uint256 rev1 = premium.totalRevenue();
        assertEq(rev1, MONTHLY_FEE);

        vm.warp(block.timestamp + 1);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max); // extension
        // M-06: totalRevenue always increments by cost, including on extensions
        assertEq(premium.totalRevenue(), 2 * MONTHLY_FEE);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-06: reconcileExpired() and batchReconcileExpired()
    // ═══════════════════════════════════════════════════════════════

    function test_P06_reconcileClearsStaleEscrow() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);

        vm.warp(block.timestamp + 31 days);

        premium.reconcileExpired(alice);
        assertEq(premium.userEscrow(alice), 0);
        assertEq(premium.totalRefundEscrow(), 0);
        assertFalse(premium.isActiveSubscriber(alice));
    }

    function test_P06_reconcileNoOpForActiveSubscription() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        premium.reconcileExpired(alice); // still active
        // Nothing should change
        assertEq(premium.userEscrow(alice), MONTHLY_FEE);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);
    }

    function test_P06_batchReconcileMultipleUsers() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        assertEq(premium.totalRefundEscrow(), 2 * MONTHLY_FEE);
        assertEq(premium.totalSubscribers(), 2);

        vm.warp(block.timestamp + 31 days);

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;
        premium.batchReconcileExpired(users);

        assertEq(premium.totalRefundEscrow(), 0);
        assertEq(premium.totalSubscribers(), 0);
    }

    function test_P06_reconcileIdempotent() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.warp(block.timestamp + 31 days);

        premium.reconcileExpired(alice);
        uint256 escrowAfter1 = premium.totalRefundEscrow();

        premium.reconcileExpired(alice); // second call
        assertEq(premium.totalRefundEscrow(), escrowAfter1); // no change
    }

    // ═══════════════════════════════════════════════════════════════
    // P-07: NFT activation 15-second delay
    // ═══════════════════════════════════════════════════════════════

    function test_P07_nftActivationDelay_sameTimestamp() public {
        vm.warp(5000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // Same timestamp: should NOT have premium
        assertFalse(premium.hasPremium(alice));
    }

    function test_P07_nftActivationDelay_exactBoundary() public {
        vm.warp(5000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // At exactly +15s: block.timestamp == activation + 15, but check is >
        vm.warp(5015);
        assertFalse(premium.hasPremium(alice));
    }

    function test_P07_nftActivationDelay_pastBoundary() public {
        vm.warp(5000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        vm.warp(5016);
        assertTrue(premium.hasPremium(alice));
    }

    function test_P07_nftActivation_requiresOwnership() public {
        // Alice does NOT hold an NFT
        vm.prank(alice);
        vm.expectRevert("NO_JBAC_NFT");
        premium.activateNFTPremium();
    }

    // ═══════════════════════════════════════════════════════════════
    // P-08: deactivateNFTPremium() -- stale activation cleanup
    // ═══════════════════════════════════════════════════════════════

    function test_P08_deactivateAfterTransfer() public {
        vm.warp(1000);
        uint256 id = nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();

        // Transfer NFT away
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);

        // Wait > 10 minutes grace period
        vm.warp(1000 + 11 minutes);

        // Anyone can deactivate alice
        premium.deactivateNFTPremium(alice);
        assertEq(premium.nftActivationBlock(alice), 0);
    }

    function test_P08_deactivateBlockedDuringGrace() public {
        vm.warp(1000);
        uint256 id = nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();

        vm.prank(alice);
        nft.transferFrom(alice, bob, id);

        // Within 10 minute grace: deactivate should be no-op
        vm.warp(1000 + 5 minutes);
        premium.deactivateNFTPremium(alice);
        assertEq(premium.nftActivationBlock(alice), 1000); // not cleared
    }

    function test_P08_deactivateNoOpIfStillHoldsNFT() public {
        vm.warp(1000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();

        vm.warp(1000 + 11 minutes);
        premium.deactivateNFTPremium(alice);
        // Alice still holds NFT, so deactivate is no-op
        assertEq(premium.nftActivationBlock(alice), 1000);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-09: hasPremiumSecure() -- only subscription-based
    // ═══════════════════════════════════════════════════════════════

    function test_P09_hasPremiumSecure_subscriptionOnly() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertTrue(premium.hasPremiumSecure(alice));
    }

    function test_P09_hasPremiumSecure_nftHolderReturnsFalse() public {
        vm.warp(1000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        vm.warp(1020); // past delay
        // hasPremium returns true for NFT holders
        assertTrue(premium.hasPremium(alice));
        // hasPremiumSecure returns false for pure NFT holders
        assertFalse(premium.hasPremiumSecure(alice));
    }

    // ═══════════════════════════════════════════════════════════════
    // P-10: withdrawToTreasury respects totalRefundEscrow
    // ═══════════════════════════════════════════════════════════════

    function test_P10_withdrawOnlyNonEscrowed() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max); // 2000 escrowed

        // Half consumed
        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        premium.cancelSubscription();
        // Refund ~1000, contract keeps ~1000 consumed, totalRefundEscrow = 0

        uint256 contractBal = token.balanceOf(address(premium));
        premium.withdrawToTreasury();
        assertEq(token.balanceOf(address(premium)), 0);
        assertEq(token.balanceOf(treasury), contractBal);
    }

    function test_P10_withdrawZeroWhenFullyEscrowed() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);

        // All funds are escrowed
        uint256 treasuryBefore = token.balanceOf(treasury);
        premium.withdrawToTreasury();
        assertEq(token.balanceOf(treasury), treasuryBefore);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-11: Fee change timelock (propose/execute/cancel)
    // ═══════════════════════════════════════════════════════════════

    function test_P11_feeChangeTimelock() public {
        premium.proposeFeeChange(2000 ether);
        assertEq(premium.pendingMonthlyFee(), 2000 ether);

        // Too early
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, premium.FEE_CHANGE()));
        premium.executeFeeChange();

        vm.warp(block.timestamp + 24 hours);
        premium.executeFeeChange();
        assertEq(premium.monthlyFeeToweli(), 2000 ether);
    }

    function test_P11_feeChangeExpires() public {
        premium.proposeFeeChange(2000 ether);
        // Warp past 7-day validity
        vm.warp(block.timestamp + 24 hours + 7 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, premium.FEE_CHANGE()));
        premium.executeFeeChange();
    }

    function test_P11_feeChangeCancel() public {
        premium.proposeFeeChange(2000 ether);
        premium.cancelFeeChange();
        assertEq(premium.pendingMonthlyFee(), 0);
        assertEq(premium.feeChangeTime(), 0);
    }

    function test_P11_feeChangeZeroBlocked() public {
        vm.expectRevert(PremiumAccess.ZeroFee.selector);
        premium.proposeFeeChange(0);
    }

    function test_P11_feeChangeMustCancelExisting() public {
        premium.proposeFeeChange(2000 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, premium.FEE_CHANGE()));
        premium.proposeFeeChange(3000 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // P-12: Treasury change timelock (propose/execute/cancel)
    // ═══════════════════════════════════════════════════════════════

    function test_P12_treasuryChangeTimelock() public {
        address newT = makeAddr("newTreasury");
        premium.proposeTreasuryChange(newT);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, premium.TREASURY_CHANGE()));
        premium.executeTreasuryChange();

        vm.warp(block.timestamp + 48 hours);
        premium.executeTreasuryChange();
        assertEq(premium.treasury(), newT);
    }

    function test_P12_treasuryChangeExpires() public {
        premium.proposeTreasuryChange(makeAddr("newT"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, premium.TREASURY_CHANGE()));
        premium.executeTreasuryChange();
    }

    function test_P12_treasuryChangeCancelAndRePropose() public {
        address first = makeAddr("first");
        address second = makeAddr("second");

        premium.proposeTreasuryChange(first);
        premium.cancelTreasuryChange();

        premium.proposeTreasuryChange(second);
        vm.warp(block.timestamp + 48 hours);
        premium.executeTreasuryChange();
        assertEq(premium.treasury(), second);
    }

    function test_P12_treasuryChangeZeroBlocked() public {
        vm.expectRevert(PremiumAccess.ZeroAddress.selector);
        premium.proposeTreasuryChange(address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // P-13: totalSubscribers accurate tracking
    // ═══════════════════════════════════════════════════════════════

    function test_P13_totalSubscribersAccurate() public {
        assertEq(premium.totalSubscribers(), 0);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);

        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 2);

        vm.warp(block.timestamp + 1);

        vm.prank(alice);
        premium.cancelSubscription();
        assertEq(premium.totalSubscribers(), 1);

        // Bob's subscription expires
        vm.warp(block.timestamp + 31 days);
        premium.reconcileExpired(bob);
        assertEq(premium.totalSubscribers(), 0);
    }

    function test_P13_extensionDoesNotDoubleCount() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);

        vm.warp(block.timestamp + 1);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max); // extension
        assertEq(premium.totalSubscribers(), 1); // still 1
    }

    // ═══════════════════════════════════════════════════════════════
    // P-14: Edge case -- subscribe with maxCost front-run protection
    // ═══════════════════════════════════════════════════════════════

    function test_P14_maxCostProtection() public {
        // If fee is raised right before subscribe, maxCost protects user
        vm.prank(alice);
        vm.expectRevert("COST_EXCEEDS_MAX");
        premium.subscribe(2, MONTHLY_FEE); // maxCost = 1 month, but wants 2 months
    }

    // ═══════════════════════════════════════════════════════════════
    // P-15: Escrow invariant: sum(userEscrow) == totalRefundEscrow
    // ═══════════════════════════════════════════════════════════════

    function test_P15_escrowInvariantAfterOperations() public {
        // Alice subscribes
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);

        // Bob subscribes
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        assertEq(
            premium.userEscrow(alice) + premium.userEscrow(bob),
            premium.totalRefundEscrow()
        );

        // Half-time cancel by alice
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        premium.cancelSubscription();

        assertEq(
            premium.userEscrow(alice) + premium.userEscrow(bob),
            premium.totalRefundEscrow()
        );

        // Bob expires, reconcile
        vm.warp(block.timestamp + 31 days);
        premium.reconcileExpired(bob);

        assertEq(
            premium.userEscrow(alice) + premium.userEscrow(bob),
            premium.totalRefundEscrow()
        );
        assertEq(premium.totalRefundEscrow(), 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // H-01: TegridyFeeHook -- afterSwap onlyPoolManager guard
    // ═══════════════════════════════════════════════════════════════

    function test_H01_afterSwapOnlyPoolManager() public {
        PoolKey memory key;
        IPoolManager.SwapParams memory params;
        BalanceDelta delta = BalanceDelta.wrap(0);

        vm.prank(alice); // not pool manager
        vm.expectRevert(TegridyFeeHook.OnlyPoolManager.selector);
        hook.afterSwap(alice, key, params, delta, "");
    }

    // ═══════════════════════════════════════════════════════════════
    // H-02: TegridyFeeHook -- paused afterSwap returns zero, not revert
    // ═══════════════════════════════════════════════════════════════

    function test_H02_pausedAfterSwapReturnsZero() public {
        hook.pause();

        PoolKey memory key;
        IPoolManager.SwapParams memory params;
        BalanceDelta delta = BalanceDelta.wrap(0);

        vm.prank(address(poolManager));
        (bytes4 sel, int128 feeAmt) = hook.afterSwap(address(poolManager), key, params, delta, "");
        assertEq(sel, IHooks.afterSwap.selector);
        assertEq(feeAmt, int128(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // H-03: TegridyFeeHook -- claimFees reverts on over-claim
    // ═══════════════════════════════════════════════════════════════

    function test_H03_claimFeesExceedsAccrued() public {
        address tok = makeAddr("tok");
        // accruedFees[tok] == 0
        vm.expectRevert(TegridyFeeHook.ExceedsAccrued.selector);
        hook.claimFees(tok, 1);
    }

    // ═══════════════════════════════════════════════════════════════
    // H-04: TegridyFeeHook -- fee change timelock
    // ═══════════════════════════════════════════════════════════════

    function test_H04_feeChangeFullCycle() public {
        hook.proposeFeeChange(50);
        assertEq(hook.pendingFee(), 50);

        // Cannot execute before delay
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();

        vm.warp(block.timestamp + 24 hours);
        hook.executeFeeChange();
        assertEq(hook.feeBps(), 50);
        assertEq(hook.pendingFee(), 0);
        assertEq(hook.feeChangeTime(), 0);
    }

    function test_H04_feeChangeExpired() public {
        hook.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_H04_feeChangeCancel() public {
        hook.proposeFeeChange(50);
        hook.cancelFeeChange();
        assertEq(hook.pendingFee(), 0);
        assertEq(hook.feeChangeTime(), 0);
    }

    function test_H04_cannotProposeTwice() public {
        hook.proposeFeeChange(50);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, hook.FEE_CHANGE()));
        hook.proposeFeeChange(60);
    }

    function test_H04_maxFeeEnforced() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        hook.proposeFeeChange(101);
    }

    function test_H04_zeroFeeAllowed() public {
        hook.proposeFeeChange(0); // zero fee is allowed for hook (unlike PremiumAccess)
        vm.warp(block.timestamp + 24 hours);
        hook.executeFeeChange();
        assertEq(hook.feeBps(), 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // H-05: TegridyFeeHook -- distributor change timelock
    // ═══════════════════════════════════════════════════════════════

    function test_H05_distributorChangeFullCycle() public {
        address newDist = makeAddr("newDist");
        hook.proposeDistributorChange(newDist);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();

        vm.warp(block.timestamp + 48 hours);
        hook.executeDistributorChange();
        assertEq(hook.revenueDistributor(), newDist);
        assertEq(hook.pendingDistributor(), address(0));
        assertEq(hook.distributorChangeTime(), 0);
    }

    function test_H05_distributorChangeExpired() public {
        hook.proposeDistributorChange(makeAddr("newDist"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    function test_H05_distributorChangeCancel() public {
        hook.proposeDistributorChange(makeAddr("newDist"));
        hook.cancelDistributorChange();
        assertEq(hook.pendingDistributor(), address(0));
        assertEq(hook.distributorChangeTime(), 0);
    }

    function test_H05_distributorZeroAddressBlocked() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        hook.proposeDistributorChange(address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // H-06: TegridyFeeHook -- syncAccruedFees with 50% cap + 7d cooldown
    // ═══════════════════════════════════════════════════════════════

    function _setAccruedFees(address tok, uint256 amount) internal {
        // accruedFees is mapping(address => uint256) at slot 7 (shifted after base contract refactor)
        bytes32 slot = keccak256(abi.encode(tok, uint256(7)));
        vm.store(address(hook), slot, bytes32(amount));
    }

    function test_H06_syncFullCycle() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        hook.proposeSyncAccruedFees(tok, 700);
        vm.warp(block.timestamp + 7 days); // satisfies 24h + 7d cooldown

        hook.executeSyncAccruedFees(tok);
        assertEq(hook.accruedFees(tok), 700);
        assertEq(hook.syncTime(tok), 0);
        assertEq(hook.pendingSyncCredit(tok), 0);
    }

    function test_H06_syncRejectsOver50Pct() public {
        // H-01 audit fix: 50% cap was removed. Sync now succeeds with >50% reduction
        // as long as 24h timelock and 7-day cooldown are respected.
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        hook.proposeSyncAccruedFees(tok, 499); // 50.1% reduction — now allowed
        vm.warp(block.timestamp + 7 days);

        hook.executeSyncAccruedFees(tok);
        assertEq(hook.accruedFees(tok), 499, ">50% reduction allowed after H-01 fix");
    }

    function test_H06_syncRejectsIncrease() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        hook.proposeSyncAccruedFees(tok, 1500);
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(TegridyFeeHook.SyncReductionTooLarge.selector);
        hook.executeSyncAccruedFees(tok);
    }

    function test_H06_sync7DayCooldown() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        // First sync
        hook.proposeSyncAccruedFees(tok, 600);
        vm.warp(block.timestamp + 7 days);
        hook.executeSyncAccruedFees(tok);
        assertEq(hook.accruedFees(tok), 600);

        // Try another sync immediately
        hook.proposeSyncAccruedFees(tok, 400);
        vm.warp(block.timestamp + 24 hours + 1); // past timelock but NOT past cooldown

        vm.expectRevert("SYNC_COOLDOWN");
        hook.executeSyncAccruedFees(tok);
    }

    function test_H06_syncCooldownRespected() public {
        vm.warp(1);
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        // First sync
        hook.proposeSyncAccruedFees(tok, 600);
        vm.warp(604801); // 1 + 7 days
        hook.executeSyncAccruedFees(tok);
        // lastSyncExecuted = 604801

        // Second sync: wait 7 days for cooldown, propose, then wait 24h for timelock
        uint256 t2 = 604801 + 604800 + 1; // 7 days + 1 second past first execution
        vm.warp(t2); // t2 = 1209602
        _setAccruedFees(tok, 600); // reset value
        hook.proposeSyncAccruedFees(tok, 400);
        // syncTime = t2 + 86400 = 1296002

        uint256 t3 = t2 + 86401; // 24h + 1s past proposal = 1296003
        vm.warp(t3);

        // Verify: cooldown: 1296003 >= 604801 + 604800 = 1209601 (YES)
        // Timelock: 1296003 >= 1296002 (YES)
        // Not expired: 1296003 <= 1296002 + 604800 = 1900802 (YES)
        hook.executeSyncAccruedFees(tok);
        assertEq(hook.accruedFees(tok), 400);
    }

    function test_H06_syncCancel() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        hook.proposeSyncAccruedFees(tok, 800);
        hook.cancelSyncAccruedFees(tok);

        assertEq(hook.syncTime(tok), 0);
        assertEq(hook.pendingSyncCredit(tok), 0);
        assertEq(hook.accruedFees(tok), 1000); // unchanged
    }

    function test_H06_syncExpired() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 1000);

        hook.proposeSyncAccruedFees(tok, 800);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);

        bytes32 syncKey = keccak256(abi.encodePacked(hook.SYNC_CHANGE(), tok));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, syncKey));
        hook.executeSyncAccruedFees(tok);
    }

    // ═══════════════════════════════════════════════════════════════
    // H-07: TegridyFeeHook -- sweepETH always to distributor
    // ═══════════════════════════════════════════════════════════════

    function test_H07_sweepETHToDistributor() public {
        vm.deal(address(hook), 1 ether);
        hook.sweepETH();
        assertEq(address(hook).balance, 0);
        assertEq(distributor.balance, 1 ether);
    }

    function test_H07_sweepETHOnlyOwner() public {
        vm.deal(address(hook), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        hook.sweepETH();
    }

    // ═══════════════════════════════════════════════════════════════
    // H-08: TegridyFeeHook -- pause/unpause
    // ═══════════════════════════════════════════════════════════════

    function test_H08_pauseUnpause() public {
        assertFalse(hook.paused());
        hook.pause();
        assertTrue(hook.paused());
        hook.unpause();
        assertFalse(hook.paused());
    }

    function test_H08_pauseOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.pause();
    }

    // ═══════════════════════════════════════════════════════════════
    // H-09: accruedFees mapping tracks correct currency
    //        (test via direct storage write + claimFees revert)
    // ═══════════════════════════════════════════════════════════════

    function test_H09_accruedFeesStorageAndClaim() public {
        address tok = makeAddr("tok");
        _setAccruedFees(tok, 500);
        assertEq(hook.accruedFees(tok), 500);

        // Claim more than accrued reverts
        vm.expectRevert(TegridyFeeHook.ExceedsAccrued.selector);
        hook.claimFees(tok, 501);

        // Different token has zero
        assertEq(hook.accruedFees(makeAddr("other")), 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // Cross-check: PremiumAccess constructor validations
    // ═══════════════════════════════════════════════════════════════

    function test_constructorZeroAddressReverts() public {
        vm.expectRevert(PremiumAccess.ZeroAddress.selector);
        new PremiumAccess(address(0), address(nft), treasury, MONTHLY_FEE);

        vm.expectRevert(PremiumAccess.ZeroAddress.selector);
        new PremiumAccess(address(token), address(0), treasury, MONTHLY_FEE);

        vm.expectRevert(PremiumAccess.ZeroAddress.selector);
        new PremiumAccess(address(token), address(nft), address(0), MONTHLY_FEE);
    }

    function test_constructorZeroFeeReverts() public {
        vm.expectRevert(PremiumAccess.ZeroFee.selector);
        new PremiumAccess(address(token), address(nft), treasury, 0);
    }

    receive() external payable {}
}
