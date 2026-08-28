// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {NftfiPooledLendingVault} from "../../src/nftfi/NftfiPooledLendingVault.sol";
import {MockWethNftfi, MockCollection} from "./NftfiMocks.sol";

/// @title  NftfiPooledLendingVault — stale-NAV seizure race (characterization)
/// @notice CONFIRMED pre-deploy finding. `totalAssets() = idle cash +
///         principalOutstanding` values every live loan at FULL PAR until `seize`
///         is called, and `seize` is only possible at `deadline + SEIZE_GRACE`
///         (1h) and then only once someone actually calls it. A loan is publicly
///         known-defaulted the moment `block.timestamp > loan.deadline` (it is
///         past due and unrepaid), yet the share price keeps counting it at par
///         for the whole window until seizure lands.
///
///         Because `maxWithdraw`/`maxRedeem` are bounded by idle cash (not by the
///         bad loan), an INFORMED LP can redeem at the inflated par NAV during
///         that window and exit whole, concentrating the entire writedown on the
///         LPs who remain when `seize` finally runs. This violates the core
///         ERC-4626 promise that share price reflects true NAV and that no holder
///         can exit at others' expense.
///
///         STATUS: pre-deploy (not in addresses.json / constants.ts); no live
///         funds. This test PINS the current (unfair) behavior. The fix is a
///         design choice (impair seizable loans in `totalAssets`, or freeze
///         redemptions while any loan is seizable) — see the writeup. When a fix
///         lands, flip the marked assertion to the fair-outcome form.
contract NftfiVaultSeizureRaceTest is Test {
    MockWethNftfi weth;
    MockCollection nft;
    NftfiPooledLendingVault vault;

    address owner = address(0xA11CE);
    address lpEarly = address(0xB0B); // informed LP who front-runs the seizure
    address lpStayer = address(0xCA11); // honest LP who eats the loss
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
        vault.setFees(0, 0); // zero fees for clean par arithmetic
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

    function test_staleNavLetsInformedLpDumpDefaultOnStayer_KNOWN_DEFECT() public {
        // Two equal LPs; equal shares, equal risk.
        _deposit(lpEarly, 50 ether);
        _deposit(lpStayer, 50 ether);

        // A borrower draws the max loan against the floor.
        uint256 loanId = _borrow(borrower, 30 ether);
        assertEq(vault.totalAssets(), 100 ether, "loan counts at par, NAV unchanged by lending");

        // Borrower DEFAULTS: never repays; time passes past the seizable line.
        vm.warp(vm.getBlockTimestamp() + 30 days + 1 hours + 1);

        // ROOT CAUSE: the loan is seizable now, yet NAV still values it at par.
        uint256 earlyShares = vault.balanceOf(lpEarly);
        uint256 stalePreview = vault.previewRedeem(earlyShares);
        console2.log("previewRedeem for lpEarly while loan is seizable-but-unseized:", stalePreview);
        assertApproxEqAbs(stalePreview, 50 ether, 1, "NAV still prices the bad loan at par");

        // Informed LP front-runs the seizure and redeems at the inflated par NAV.
        vm.prank(lpEarly);
        vault.redeem(earlyShares, lpEarly, lpEarly);
        uint256 gotEarly = weth.balanceOf(lpEarly) - 950 ether; // started at 1000, deposited 50
        console2.log("lpEarly extracted (should be ~fair 35):", gotEarly);

        // Now seizure finally lands; `seize` alone writes the principal down to 0
        // in totalAssets (recovery, if any, would come later via settleSeizure).
        vault.seize(loanId);

        // The stayer redeems whatever is left. (Compute the amount BEFORE the
        // prank — a vault call inside the redeem args would otherwise consume it.)
        uint256 stayerShares = vault.balanceOf(lpStayer);
        uint256 rmax = vault.maxRedeem(lpStayer);
        uint256 toRedeem = rmax < stayerShares ? rmax : stayerShares;
        vm.prank(lpStayer);
        vault.redeem(toRedeem, lpStayer, lpStayer);
        uint256 gotStayer = weth.balanceOf(lpStayer) - 950 ether;
        console2.log("lpStayer recovered (should be ~fair 35):", gotStayer);

        // The pool truly held 70 ETH of cash after lending 30; with zero recovery
        // the fair split of the 30 writedown is 15 each -> 35 each.
        // CURRENT (defective): the early exiter escapes near par and the stayer
        // absorbs almost the entire writedown.
        console2.log("unfair gap (early - stayer):", gotEarly - gotStayer);

        // ── ASSERTION TO FLIP AFTER THE FIX ────────────────────────────────────
        // POST-FIX (fair): assertApproxEqAbs(gotEarly, gotStayer, 0.5 ether, "loss shared equally");
        assertGt(gotEarly, gotStayer + 20 ether, "KNOWN DEFECT: early exiter dumps the loss on the stayer");
    }
}
