// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {NftfiPooledLendingVault} from "../../src/nftfi/NftfiPooledLendingVault.sol";
import {MockWethNftfi, MockCollection, NoOpTransferCollection} from "./NftfiMocks.sol";

contract NftfiPooledLendingVaultTest is Test {
    MockWethNftfi weth;
    MockCollection nft;
    NftfiPooledLendingVault vault;

    address owner = address(0xA11CE);
    address lp1 = address(0xB0B);
    address lp2 = address(0xCA11);
    address borrower = address(0xD00D);
    address sink = address(0x51AC);
    address treasury = address(0x7EA5);

    uint256 constant FLOOR = 10 ether;
    uint256 constant CAP = 1_000 ether;

    function setUp() public {
        weth = new MockWethNftfi();
        nft = new MockCollection("Jungle", "JBAC");
        vault = new NftfiPooledLendingVault(address(weth), address(nft), treasury, CAP, owner);

        vm.startPrank(owner);
        vault.setLiquidationSink(sink);
        vault.pushFloor(FLOOR);
        vm.stopPrank();

        weth.mint(lp1, 500 ether);
        weth.mint(lp2, 500 ether);
        weth.mint(borrower, 100 ether);
        weth.mint(sink, 500 ether);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        weth.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _borrow(address who, uint256 amount) internal returns (uint256 loanId, uint256 tokenId) {
        tokenId = nft.mint(who);
        vm.startPrank(who);
        nft.approve(address(vault), tokenId);
        loanId = vault.borrow(tokenId, amount, address(0));
        vm.stopPrank();
    }

    // ─── The pool ────────────────────────────────────────────────────

    function test_depositMintsSharesAndCountsAsAssets() public {
        _deposit(lp1, 100 ether);
        assertEq(vault.totalAssets(), 100 ether);
        assertGt(vault.balanceOf(lp1), 0);
        assertEq(vault.maxWithdraw(lp1), 100 ether);
    }

    function test_depositCapIsEnforcedByTheStandardCeiling() public {
        vm.prank(owner);
        vault.setDepositCap(10 ether);
        assertEq(vault.maxDeposit(lp1), 10 ether);

        vm.startPrank(lp1);
        weth.approve(address(vault), 11 ether);
        vm.expectRevert();
        vault.deposit(11 ether, lp1);
        vault.deposit(10 ether, lp1);
        vm.stopPrank();
        assertEq(vault.maxDeposit(lp1), 0);
    }

    // ─── Valuation ───────────────────────────────────────────────────

    function test_borrowIsCappedByLtvAgainstThePushedFloor() public {
        _deposit(lp1, 100 ether);
        uint256 tokenId = nft.mint(borrower);
        vm.startPrank(borrower);
        nft.approve(address(vault), tokenId);
        // ltvBps default 3000 → 3 ETH against a 10 ETH floor.
        vm.expectRevert(NftfiPooledLendingVault.PrincipalAboveMax.selector);
        vault.borrow(tokenId, 3 ether + 1, address(0));
        vault.borrow(tokenId, 3 ether, address(0));
        vm.stopPrank();
        assertEq(vault.principalOutstanding(), 3 ether);
    }

    function test_staleFloorClosesBorrowingRatherThanShrinkingIt() public {
        _deposit(lp1, 100 ether);
        skip(vault.FLOOR_MAX_AGE() + 1);

        (, bool fresh,) = vault.floorStatus();
        assertFalse(fresh);
        assertEq(vault.maxPrincipal(), 0, "a stale floor must quote no loan at all");

        uint256 tokenId = nft.mint(borrower);
        vm.startPrank(borrower);
        nft.approve(address(vault), tokenId);
        vm.expectRevert(NftfiPooledLendingVault.FloorStale.selector);
        vault.borrow(tokenId, 1 ether, address(0));
        vm.stopPrank();
    }

    function test_floorStatusSeparatesNeverPushedFromStale() public {
        NftfiPooledLendingVault fresh =
            new NftfiPooledLendingVault(address(weth), address(nft), treasury, CAP, owner);
        (bool hasFloor,,) = fresh.floorStatus();
        assertFalse(hasFloor, "a pool that was never told a floor must not read as one with a zero floor");
        assertEq(fresh.maxPrincipal(), 0);

        (bool has2, bool fresh2,) = vault.floorStatus();
        assertTrue(has2);
        assertTrue(fresh2);
    }

    // ─── Collateral ──────────────────────────────────────────────────

    function test_borrowRefusesCollateralThatDidNotActuallyMove() public {
        NoOpTransferCollection hostile = new NoOpTransferCollection();
        NftfiPooledLendingVault v =
            new NftfiPooledLendingVault(address(weth), address(hostile), treasury, CAP, owner);
        vm.prank(owner);
        v.pushFloor(FLOOR);

        vm.startPrank(lp1);
        weth.approve(address(v), 50 ether);
        v.deposit(50 ether, lp1);
        vm.stopPrank();

        uint256 tokenId = hostile.mint(borrower);
        vm.startPrank(borrower);
        hostile.approve(address(v), tokenId);
        vm.expectRevert(NftfiPooledLendingVault.CollateralTransferFailed.selector);
        v.borrow(tokenId, 1 ether, address(0));
        vm.stopPrank();
    }

    function test_borrowRefusesATokenTheCallerDoesNotOwn() public {
        _deposit(lp1, 100 ether);
        uint256 tokenId = nft.mint(lp2);
        vm.prank(borrower);
        vm.expectRevert(NftfiPooledLendingVault.NotCollateralOwner.selector);
        vault.borrow(tokenId, 1 ether, address(0));
    }

    function test_borrowCannotExceedIdleLiquidity() public {
        _deposit(lp1, 1 ether);
        uint256 tokenId = nft.mint(borrower);
        vm.startPrank(borrower);
        nft.approve(address(vault), tokenId);
        vm.expectRevert(NftfiPooledLendingVault.InsufficientLiquidity.selector);
        vault.borrow(tokenId, 2 ether, address(0));
        vm.stopPrank();
    }

    // ─── Round trip ──────────────────────────────────────────────────

    function test_repayInFullReturnsCollateralAndPaysInterestToThePool() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId, uint256 tokenId) = _borrow(borrower, 3 ether);
        assertEq(nft.ownerOf(tokenId), address(vault));

        skip(365 days / 2);
        (uint256 principal, uint256 interest) = vault.quoteRepay(loanId);
        assertEq(principal, 3 ether);
        // 15% APR over half a year on 3 ETH.
        assertApproxEqAbs(interest, (3 ether * 1500 * (365 days / 2)) / (365 days * 10_000), 1);

        vm.startPrank(borrower);
        weth.approve(address(vault), principal + interest);
        vault.repay(loanId, principal + interest);
        vm.stopPrank();

        assertEq(nft.ownerOf(tokenId), borrower);
        assertEq(vault.principalOutstanding(), 0);
        assertEq(vault.totalAssets(), 100 ether + interest, "realized interest is the only thing that moves NAV");
    }

    function test_partialRepaymentRetiresInterestBeforePrincipal() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);
        skip(30 days);

        (, uint256 interest) = vault.quoteRepay(loanId);
        assertGt(interest, 0);

        vm.startPrank(borrower);
        weth.approve(address(vault), interest + 1 ether);
        vault.repay(loanId, interest + 1 ether);
        vm.stopPrank();

        (uint256 principalLeft, uint256 interestLeft) = vault.quoteRepay(loanId);
        assertEq(interestLeft, 0);
        assertEq(principalLeft, 2 ether);
    }

    function test_accruedInterestIsNotInNavUntilItIsPaid() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);
        uint256 navAtDraw = vault.totalAssets();
        skip(200 days);

        (, uint256 interest) = vault.quoteRepay(loanId);
        assertGt(interest, 0, "the loan is accruing");
        assertEq(
            vault.totalAssets(),
            navAtDraw,
            "unpaid interest must never lift the share price - that is spending money the pool has not earned"
        );
    }

    // ─── Liquidity ceiling ───────────────────────────────────────────

    function test_withdrawalIsBoundedByCashNotByLentPrincipal() public {
        _deposit(lp1, 100 ether);
        _borrow(borrower, 3 ether);
        assertEq(vault.maxWithdraw(lp1), 97 ether, "lent principal is not withdrawable");

        vm.prank(lp1);
        vm.expectRevert();
        vault.withdraw(98 ether, lp1, lp1);
    }

    // ─── Default ─────────────────────────────────────────────────────

    function test_seizeRequiresTheDeadlineAndTheGraceToHavePassed() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);

        vm.expectRevert(NftfiPooledLendingVault.LoanNotSeizable.selector);
        vault.seize(loanId);

        skip(vault.loanDuration() + vault.SEIZE_GRACE() + 1);
        vault.seize(loanId);
    }

    function test_seizureWritesThePrincipalOffTheBalanceSheet() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId, uint256 tokenId) = _borrow(borrower, 3 ether);
        skip(vault.loanDuration() + vault.SEIZE_GRACE() + 1);

        vault.seize(loanId);
        assertEq(nft.ownerOf(tokenId), sink);
        assertEq(vault.principalOutstanding(), 0);
        assertEq(vault.seizedPrincipal(), 3 ether);
        assertEq(
            vault.totalAssets(),
            97 ether,
            "an NFT sitting at the sink is not an asset - NAV must show the hole until it is sold"
        );
    }

    function test_settlementRepaysThePoolFirstAndRefundsSurplusToTheNamedRecipient() public {
        _deposit(lp1, 100 ether);
        uint256 tokenId = nft.mint(borrower);
        address surplusTo = address(0xFEED);
        vm.startPrank(borrower);
        nft.approve(address(vault), tokenId);
        uint256 loanId = vault.borrow(tokenId, 3 ether, surplusTo);
        vm.stopPrank();

        skip(vault.loanDuration() + vault.SEIZE_GRACE() + 1);
        vault.seize(loanId);

        (uint256 principal, uint256 interest) = vault.quoteRepay(loanId);
        uint256 debt = principal + interest;
        uint256 proceeds = debt + 2 ether;

        vm.startPrank(sink);
        weth.approve(address(vault), proceeds);
        vault.settleSeizure(loanId, proceeds);
        vm.stopPrank();

        assertEq(weth.balanceOf(surplusTo), 2 ether, "everything above the debt belongs to the collateral's owner");
        assertEq(vault.seizedPrincipal(), 0);
        assertEq(vault.totalAssets(), 100 ether + interest);
    }

    function test_settlementBelowTheDebtLeavesTheLossWithDepositors() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);
        skip(vault.loanDuration() + vault.SEIZE_GRACE() + 1);
        vault.seize(loanId);

        vm.startPrank(sink);
        weth.approve(address(vault), 1 ether);
        vault.settleSeizure(loanId, 1 ether);
        vm.stopPrank();

        assertEq(weth.balanceOf(borrower), 100 ether + 3 ether, "a shortfall refunds nothing");
        assertEq(vault.totalAssets(), 98 ether);
    }

    function test_onlyTheSinkMayReportProceeds() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);
        skip(vault.loanDuration() + vault.SEIZE_GRACE() + 1);
        vault.seize(loanId);

        vm.startPrank(borrower);
        weth.approve(address(vault), 5 ether);
        vm.expectRevert(NftfiPooledLendingVault.NotLiquidationSink.selector);
        vault.settleSeizure(loanId, 5 ether);
        vm.stopPrank();
    }

    function test_noSinkMeansNoCollateralCanLeaveExceptByRepayment() public {
        NftfiPooledLendingVault v =
            new NftfiPooledLendingVault(address(weth), address(nft), treasury, CAP, owner);
        vm.prank(owner);
        v.pushFloor(FLOOR);
        vm.startPrank(lp1);
        weth.approve(address(v), 50 ether);
        v.deposit(50 ether, lp1);
        vm.stopPrank();

        uint256 tokenId = nft.mint(borrower);
        vm.startPrank(borrower);
        nft.approve(address(v), tokenId);
        uint256 loanId = v.borrow(tokenId, 3 ether, address(0));
        vm.stopPrank();

        skip(v.loanDuration() + v.SEIZE_GRACE() + 1);
        vm.expectRevert(NftfiPooledLendingVault.NotLiquidationSink.selector);
        v.seize(loanId);
        assertEq(nft.ownerOf(tokenId), address(v));
    }

    function test_surrenderIsForTheBorrowerAndNobodyElse() public {
        _deposit(lp1, 100 ether);
        (uint256 loanId, uint256 tokenId) = _borrow(borrower, 3 ether);

        vm.prank(lp2);
        vm.expectRevert(NftfiPooledLendingVault.NotBorrower.selector);
        vault.surrender(loanId);

        vm.prank(borrower);
        vault.surrender(loanId);
        assertEq(nft.ownerOf(tokenId), sink);
    }

    // ─── Fee dials ───────────────────────────────────────────────────

    function test_feeDialsShipAtZero() public view {
        assertEq(vault.originationFeeBps(), 0);
        assertEq(vault.interestFeeBps(), 0);
    }

    function test_aFeeCannotBeRaisedWithoutARecipientChosenAtDeploy() public {
        NftfiPooledLendingVault noRecipient =
            new NftfiPooledLendingVault(address(weth), address(nft), address(0), CAP, owner);
        vm.prank(owner);
        vm.expectRevert(NftfiPooledLendingVault.FeeRecipientUnset.selector);
        noRecipient.setFees(50, 0);

        // And the zero-fee call still works, so the dial is reachable and stuck.
        vm.prank(owner);
        noRecipient.setFees(0, 0);
    }

    function test_originationAndInterestFeesReachTheRecipientWhenTurnedOn() public {
        vm.prank(owner);
        vault.setFees(50, 1000); // 0.5% origination, 10% of interest

        _deposit(lp1, 100 ether);
        (uint256 loanId,) = _borrow(borrower, 3 ether);
        assertEq(weth.balanceOf(treasury), 0.015 ether);

        skip(365 days / 4);
        (uint256 principal, uint256 interest) = vault.quoteRepay(loanId);
        vm.startPrank(borrower);
        weth.approve(address(vault), principal + interest);
        vault.repay(loanId, principal + interest);
        vm.stopPrank();

        assertEq(weth.balanceOf(treasury), 0.015 ether + interest / 10);
    }

    function test_feeDialsAreBounded() public {
        // Read the ceilings BEFORE arming expectRevert: an argument expression
        // that is itself an external call would consume the expectation.
        uint256 maxOrig = vault.MAX_ORIGINATION_FEE_BPS();
        uint256 maxInterest = vault.MAX_INTEREST_FEE_BPS();
        uint256 maxLtv = vault.MAX_LTV_BPS();

        vm.startPrank(owner);
        vm.expectRevert(NftfiPooledLendingVault.ParamOutOfRange.selector);
        vault.setFees(maxOrig + 1, 0);
        vm.expectRevert(NftfiPooledLendingVault.ParamOutOfRange.selector);
        vault.setFees(0, maxInterest + 1);
        vm.expectRevert(NftfiPooledLendingVault.ParamOutOfRange.selector);
        vault.setTerms(maxLtv + 1, 100, 30 days);
        vm.stopPrank();
    }

    // ─── Access ──────────────────────────────────────────────────────

    function test_dialsAreOwnerOnly() public {
        vm.startPrank(borrower);
        vm.expectRevert();
        vault.pushFloor(1 ether);
        vm.expectRevert();
        vault.setFees(10, 10);
        vm.expectRevert();
        vault.setLiquidationSink(borrower);
        vm.stopPrank();
    }

    function test_ownershipCannotBeRenounced() public {
        vm.prank(owner);
        vm.expectRevert();
        vault.renounceOwnership();
    }
}
