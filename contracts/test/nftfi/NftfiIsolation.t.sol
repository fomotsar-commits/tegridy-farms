// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {NftfiPooledLendingVault} from "../../src/nftfi/NftfiPooledLendingVault.sol";
import {MockWethNftfi, MockCollection} from "./NftfiMocks.sol";

/// @dev The claim the product makes is that a loss on one collection reaches
///      only the depositors who chose that collection. These are the tests that
///      claim has to survive; if any of them can be made to fail, the sentence
///      has to come off the surface before the code is touched.
contract NftfiIsolationTest is Test {
    MockWethNftfi weth;
    MockCollection alpha;
    MockCollection beta;
    NftfiPooledLendingVault vaultA;
    NftfiPooledLendingVault vaultB;

    address owner = address(0xA11CE);
    address lpA = address(0xAAAA);
    address lpB = address(0xBBBB);
    address borrower = address(0xD00D);
    address sink = address(0x51AC);
    address treasury = address(0x7EA5);

    function setUp() public {
        weth = new MockWethNftfi();
        alpha = new MockCollection("Alpha", "A");
        beta = new MockCollection("Beta", "B");
        vaultA = new NftfiPooledLendingVault(address(weth), address(alpha), treasury, 1_000 ether, owner);
        vaultB = new NftfiPooledLendingVault(address(weth), address(beta), treasury, 1_000 ether, owner);

        vm.startPrank(owner);
        vaultA.setLiquidationSink(sink);
        vaultB.setLiquidationSink(sink);
        vaultA.pushFloor(10 ether);
        vaultB.pushFloor(10 ether);
        vm.stopPrank();

        weth.mint(lpA, 200 ether);
        weth.mint(lpB, 200 ether);

        vm.startPrank(lpA);
        weth.approve(address(vaultA), 200 ether);
        vaultA.deposit(100 ether, lpA);
        vm.stopPrank();

        vm.startPrank(lpB);
        weth.approve(address(vaultB), 200 ether);
        vaultB.deposit(100 ether, lpB);
        vm.stopPrank();
    }

    function test_aPoolWillNotAcceptAnotherCollectionsToken() public {
        uint256 betaToken = beta.mint(borrower);
        vm.startPrank(borrower);
        beta.approve(address(vaultA), betaToken);
        // vaultA asks `alpha` who owns this id; alpha has never minted it, so
        // the ownership read fails and the draw never happens.
        vm.expectRevert(NftfiPooledLendingVault.NotCollateralOwner.selector);
        vaultA.borrow(betaToken, 1 ether, address(0));
        vm.stopPrank();
    }

    function test_aTotalLossOnOnePoolLeavesTheOtherUntouched() public {
        // Drain vault A the honest way: borrow to the LTV ceiling against a
        // pile of alpha tokens, then never repay.
        uint256 drawn;
        for (uint256 i = 0; i < 10; i++) {
            uint256 id = alpha.mint(borrower);
            vm.startPrank(borrower);
            alpha.approve(address(vaultA), id);
            vaultA.borrow(id, 3 ether, address(0));
            vm.stopPrank();
            drawn += 3 ether;
        }
        assertEq(vaultA.principalOutstanding(), drawn);

        skip(vaultA.loanDuration() + vaultA.SEIZE_GRACE() + 1);
        for (uint256 i = 0; i < 10; i++) {
            vaultA.seize(i);
        }

        // A took the whole hit; B never moved.
        assertEq(vaultA.totalAssets(), 100 ether - drawn);
        assertEq(vaultB.totalAssets(), 100 ether);
        assertEq(vaultB.maxWithdraw(lpB), 100 ether);
        assertEq(vaultB.convertToAssets(vaultB.balanceOf(lpB)), 100 ether);
    }

    function test_theTwoPoolsShareNoStorageAndNoAddress() public view {
        assertTrue(address(vaultA) != address(vaultB));
        assertEq(vaultA.collection(), address(alpha));
        assertEq(vaultB.collection(), address(beta));
        // There is no registry, no router and no shared accounting contract for
        // one pool to reach the other through: the only address either of them
        // holds in common is the ERC20 they are both denominated in, and an
        // ERC20 balance is per-holder.
        assertEq(vaultA.asset(), vaultB.asset());
    }
}
