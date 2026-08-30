// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {NftfiPooledLendingVault} from "../../src/nftfi/NftfiPooledLendingVault.sol";
import {MockWethNftfi, MockCollection} from "./NftfiMocks.sol";

/// @title  NftfiPooledLendingVault — seizure-race regression (freeze-on-seizable)
/// @notice REGRESSION TEST for AUDIT FIX 2026-08-27 [SEIZURE-RACE].
///
///         Before the fix, `totalAssets = idle + principalOutstanding` valued a
///         defaulted loan at FULL PAR until `seize` was called, and `maxWithdraw`/
///         `maxRedeem` were bounded only by idle cash. An informed LP could redeem
///         at the stale par NAV during the window between default and seizure and
///         dump the entire writedown on the LPs who stayed (reproduced pre-fix: the
///         early exiter took 50 ETH of a fair 35, the stayer got 20 — the whole
///         30 ETH loss on one party).
///
///         THE FIX freezes deposits and withdrawals (via the `max*` ceilings)
///         whenever any open loan is past `deadline + SEIZE_GRACE` and unseized —
///         i.e. a default whose writedown `totalAssets` has not recognized. Nobody
///         can transact at the stale par NAV. The permissionless `seize` clears the
///         freeze by recognizing the loss, after which everyone exits at the
///         correct, shared price. See docs/NFTFI_VAULT_SEIZURE_RACE_2026_08_27.md.
///
///         STATUS: pre-deploy (not in addresses.json / constants.ts); no live funds.
contract NftfiVaultSeizureRaceTest is Test {
    MockWethNftfi weth;
    MockCollection nft;
    NftfiPooledLendingVault vault;

    address owner = address(0xA11CE);
    address lpEarly = address(0xB0B); // would-be front-runner of the seizure
    address lpStayer = address(0xCA11);
    address borrower = address(0xD00D);
    address sink = address(0x51AC);
    address treasury = address(0x7EA5);

    uint256 constant FLOOR = 100 ether; // ltv 30% -> 30 ETH max loan
    uint256 constant CAP = 10_000 ether;

    function setUp() public {
        weth = new MockWethNftfi();
        nft = new MockCollection("Jungle", "JBAC");
        vault = new NftfiPooledLendingVault(address(weth), address(nft), treasury, CAP, owner);

        vm.startPrank(owner);
        vault.setLiquidationSink(sink);
        vault.setFees(0, 0);
        vault.pushFloor(FLOOR);
        vm.stopPrank();

        weth.mint(lpEarly, 1_000 ether);
        weth.mint(lpStayer, 1_000 ether);
        weth.mint(borrower, 1_000 ether);
        weth.mint(sink, 1_000 ether);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        weth.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _borrow(address who, uint256 amount) internal returns (uint256 loanId) {
        uint256 tokenId = nft.mint(who);
        vm.startPrank(who);
        nft.approve(address(vault), tokenId);
        loanId = vault.borrow(tokenId, amount, address(0));
        vm.stopPrank();
    }

    function test_seizureFreezeSharesLossEqually() public {
        _deposit(lpEarly, 50 ether);
        _deposit(lpStayer, 50 ether);

        uint256 loanId = _borrow(borrower, 30 ether);
        assertEq(vault.totalAssets(), 100 ether, "loan counts at par while performing");
        assertFalse(vault.hasSeizableLoan(), "no default yet");

        // Borrower DEFAULTS; time passes past the seizable line.
        vm.warp(vm.getBlockTimestamp() + 30 days + 1 hours + 1);

        // FIX: the pool is now frozen — the stale par NAV cannot be transacted on.
        assertTrue(vault.hasSeizableLoan(), "default is now recognized as a freeze trigger");
        assertEq(vault.maxRedeem(lpEarly), 0, "withdrawals frozen while a default is unresolved");
        assertEq(vault.maxWithdraw(lpEarly), 0, "withdrawals frozen (asset units too)");
        assertEq(vault.maxDeposit(lpStayer), 0, "deposits frozen too (no entry at stale par)");

        // The informed LP's attempt to front-run the seizure REVERTS.
        uint256 earlyShares = vault.balanceOf(lpEarly);
        vm.prank(lpEarly);
        vm.expectRevert(); // RedeemMoreThanMax
        vault.redeem(earlyShares, lpEarly, lpEarly);

        // Anyone (permissionless) seizes the overdue loan, recognizing the loss.
        vault.seize(loanId);
        assertFalse(vault.hasSeizableLoan(), "freeze cleared once the loss is recognized");
        assertEq(vault.totalAssets(), 70 ether, "writedown recognized: 100 - 30 principal = 70");

        // Now both LPs exit — at the corrected, shared NAV.
        uint256 esh = vault.balanceOf(lpEarly);
        uint256 emax = vault.maxRedeem(lpEarly);
        vm.prank(lpEarly);
        vault.redeem(emax < esh ? emax : esh, lpEarly, lpEarly);
        uint256 gotEarly = weth.balanceOf(lpEarly) - 950 ether;

        uint256 ssh = vault.balanceOf(lpStayer);
        uint256 smax = vault.maxRedeem(lpStayer);
        vm.prank(lpStayer);
        vault.redeem(smax < ssh ? smax : ssh, lpStayer, lpStayer);
        uint256 gotStayer = weth.balanceOf(lpStayer) - 950 ether;

        console2.log("lpEarly recovered :", gotEarly);
        console2.log("lpStayer recovered:", gotStayer);

        // FAIR: the 30 ETH loss is split evenly; neither can dump it on the other.
        assertApproxEqAbs(gotEarly, gotStayer, 1e6, "loss shared equally, not dumped");
        assertApproxEqAbs(gotEarly, 35 ether, 0.01 ether, "each LP bears half the writedown");
    }

    /// The freeze must be NARROW: a healthy (performing, not-yet-due) loan must not
    /// block ordinary deposits and withdrawals. Guards against an over-broad fix.
    function test_healthyLoanDoesNotFreeze() public {
        _deposit(lpEarly, 50 ether);
        _deposit(lpStayer, 50 ether);
        _borrow(borrower, 30 ether);

        // Well before the deadline: performing loan, no freeze.
        vm.warp(vm.getBlockTimestamp() + 10 days);
        assertFalse(vault.hasSeizableLoan(), "performing loan must not trip the freeze");
        assertGt(vault.maxRedeem(lpEarly), 0, "LPs can still exit against idle cash");
        assertGt(vault.maxDeposit(lpStayer), 0, "deposits still open");

        // An LP withdraws their idle-cash share normally.
        uint256 sh = vault.balanceOf(lpEarly);
        uint256 mx = vault.maxRedeem(lpEarly);
        vm.prank(lpEarly);
        vault.redeem(mx < sh ? mx : sh, lpEarly, lpEarly);
        assertGt(weth.balanceOf(lpEarly), 950 ether, "normal withdrawal succeeded");
    }

    /// Even inside the SEIZE_GRACE cure window (past deadline, not yet seizable) the
    /// loan may still be repaid, so the pool is NOT frozen yet — matching the point
    /// at which `seize` itself becomes callable.
    function test_graceWindowDoesNotFreeze() public {
        _deposit(lpEarly, 50 ether);
        _borrow(borrower, 30 ether);

        vm.warp(vm.getBlockTimestamp() + 30 days + 30 minutes); // past deadline, inside grace
        assertFalse(vault.hasSeizableLoan(), "grace window is a cure window, not a freeze");
        assertGt(vault.maxRedeem(lpEarly), 0, "still liquid during grace");
    }
}
