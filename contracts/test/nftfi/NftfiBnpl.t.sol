// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {NftfiBnpl} from "../../src/nftfi/NftfiBnpl.sol";
import {NftfiPooledLendingVault} from "../../src/nftfi/NftfiPooledLendingVault.sol";
import {MockWethNftfi, MockCollection} from "./NftfiMocks.sol";

contract NftfiBnplTest is Test {
    MockWethNftfi weth;
    MockCollection nft;
    NftfiPooledLendingVault vault;
    NftfiBnpl desk;

    address owner = address(0xA11CE);
    address lp = address(0xB0B);
    address seller = address(0x5E11);
    address buyer = address(0xB0E4);
    address sink = address(0x51AC);
    address treasury = address(0x7EA5);

    uint256 constant FLOOR = 10 ether;
    uint256 constant PRICE = 4 ether;

    function setUp() public {
        weth = new MockWethNftfi();
        nft = new MockCollection("Jungle", "JBAC");
        vault = new NftfiPooledLendingVault(address(weth), address(nft), treasury, 1_000 ether, owner);

        vm.startPrank(owner);
        vault.setLiquidationSink(sink);
        vault.pushFloor(FLOOR);
        // The instalment schedule is 90 days; the loan it rides on has to outlast it.
        vault.setTerms(3_000, 1_500, 120 days);
        vm.stopPrank();

        desk = new NftfiBnpl(address(weth), address(vault), treasury, owner);

        weth.mint(lp, 500 ether);
        weth.mint(buyer, 100 ether);
        weth.mint(sink, 500 ether);

        vm.startPrank(lp);
        weth.approve(address(vault), 500 ether);
        vault.deposit(200 ether, lp);
        vm.stopPrank();
    }

    function _list() internal returns (uint256 listingId, uint256 tokenId) {
        tokenId = nft.mint(seller);
        vm.startPrank(seller);
        nft.approve(address(desk), tokenId);
        listingId = desk.list(tokenId, PRICE, uint64(block.timestamp + 7 days));
        vm.stopPrank();
    }

    function _open() internal returns (uint256 planId, uint256 tokenId) {
        uint256 listingId;
        (listingId, tokenId) = _list();
        (uint256 depositWei,, uint256 originationWei,,) = desk.quote(PRICE);
        vm.startPrank(buyer);
        weth.approve(address(desk), depositWei + originationWei);
        planId = desk.openPlan(listingId, depositWei + originationWei);
        vm.stopPrank();
    }

    // ─── Quote ───────────────────────────────────────────────────────

    function test_quoteNamesEveryComponentOfTheCostOfCredit() public view {
        (uint256 depositWei, uint256 financedWei, uint256 originationWei, uint256 interestWei, uint256 totalWei) =
            desk.quote(PRICE);
        assertEq(depositWei, 1 ether, "25% of 4 ETH");
        assertEq(financedWei, 3 ether);
        assertEq(originationWei, 0, "origination dial ships at zero");
        assertGt(interestWei, 0, "a financed purchase costs interest and the quote must say so");
        assertEq(totalWei, depositWei + originationWei + financedWei + interestWei);
        assertGt(totalWei, PRICE, "the total cost of credit is above the sticker price");
    }

    /// @dev The other half of the cross-implementation pin. The browser computes
    ///      the same schedule in frontend/src/hooks/useBnplQuote.ts, and these
    ///      exact numbers are asserted there too. Either side drifting reddens
    ///      one of the two suites, which is the only reason a second
    ///      implementation of this arithmetic is tolerable at all.
    function test_quoteMatchesTheBrowsersPinnedVectors() public view {
        (uint256 dep, uint256 fin, uint256 orig, uint256 interest, uint256 total) = desk.quote(4 ether);
        assertEq(dep, 1_000000000000000000);
        assertEq(fin, 3_000000000000000000);
        assertEq(orig, 0);
        assertEq(interest, 73972602739726026);
        assertEq(total, 4073972602739726026);
    }

    function test_quoteMatchesTheBrowsersPinnedVectorsWithAnOriginationFee() public {
        vm.prank(owner);
        vault.setFees(50, 0);
        (uint256 dep, uint256 fin, uint256 orig, uint256 interest, uint256 total) = desk.quote(3 ether);
        assertEq(dep, 750000000000000000);
        assertEq(fin, 2250000000000000000);
        assertEq(orig, 11250000000000000);
        assertEq(interest, 55479452054794519);
        assertEq(total, 3066729452054794519);
    }

    function test_quoteInterestMatchesWhatAnOnScheduleBuyerActuallyPays() public {
        (,,, uint256 quotedInterest,) = desk.quote(PRICE);
        (uint256 planId,) = _open();

        uint256 spent;
        for (uint256 k = 0; k < desk.INSTALMENTS(); k++) {
            skip(desk.INSTALMENT_INTERVAL());
            vm.startPrank(buyer);
            weth.approve(address(desk), 10 ether);
            spent += desk.payInstalment(planId, 10 ether);
            vm.stopPrank();
        }
        // Everything above the financed principal is interest.
        assertApproxEqAbs(spent - 3 ether, quotedInterest, 3, "the pre-signature quote must be the real number");
    }

    // ─── Purchase ────────────────────────────────────────────────────

    function test_sellerIsPaidInFullImmediatelyAndTheTokenSitsInEscrow() public {
        (, uint256 tokenId) = _open();
        assertEq(weth.balanceOf(seller), PRICE);
        assertEq(nft.ownerOf(tokenId), address(vault), "escrow is the pool, not the desk");
        assertEq(weth.balanceOf(buyer), 100 ether - 1 ether);
    }

    function test_theBuyerIsTheSurplusRecipientOnTheVaultLoan() public {
        (uint256 planId,) = _open();
        assertEq(
            _surplusRecipient(planId),
            buyer,
            "a forfeited plan must pay the buyer without a hop through the desk"
        );
    }

    function test_upfrontCeilingProtectsTheBuyerFromADialMovedMidFlight() public {
        (uint256 listingId,) = _list();
        vm.prank(owner);
        desk.setDepositBps(8_000);

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.ParamOutOfRange.selector);
        desk.openPlan(listingId, 1 ether);
        vm.stopPrank();
    }

    function test_aPlanCannotOutliveTheLoanItRidesOn() public {
        vm.prank(owner);
        vault.setTerms(3_000, 1_500, 30 days);
        (uint256 listingId,) = _list();

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.VaultTermTooShort.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();
    }

    /// @dev The financed leg is an ordinary draw from the pool, so it meets the
    ///      pool's LTV ceiling like any other. That makes the sale price a
    ///      financed purchase can reach a function of the floor and the dials,
    ///      not of what a seller feels like asking — and the refusal has to come
    ///      from the vault rather than from a check the desk could drift out of
    ///      sync with. `PRICE` of 4 ETH finances 3 ETH, which is exactly the
    ///      ceiling at a 10 ETH floor and 30% LTV; one wei more is refused.
    function test_aPriceThePoolWouldNotLendAgainstIsRefusedByTheVault() public {
        uint256 tokenId = nft.mint(seller);
        vm.startPrank(seller);
        nft.approve(address(desk), tokenId);
        // 4 ETH + 4 wei finances 3 ETH + 3 wei against a 3 ETH ceiling.
        uint256 listingId = desk.list(tokenId, PRICE + 4, uint64(block.timestamp + 7 days));
        vm.stopPrank();

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiPooledLendingVault.PrincipalAboveMax.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();

        // Raising the deposit shrinks the financed leg under the ceiling, which
        // is the only lever that makes a higher sticker price financeable.
        vm.prank(owner);
        desk.setDepositBps(5_000);
        (uint256 depositWei,, uint256 originationWei,,) = desk.quote(PRICE + 4);
        vm.startPrank(buyer);
        desk.openPlan(listingId, depositWei + originationWei);
        vm.stopPrank();
        assertEq(desk.planCount(), 1, "the same listing opens once the financed leg fits");
    }

    /// @dev A stale floor closes the vault's borrow path, and the desk inherits
    ///      that rather than routing around it. Nothing republishes the floor on
    ///      a timer, so this is the resting state of an unattended pool.
    function test_aStaleFloorInThePoolStopsNewPlansFromOpening() public {
        (uint256 listingId,) = _list();
        skip(vault.FLOOR_MAX_AGE() + 1);

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiPooledLendingVault.FloorStale.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();
    }

    function test_sellerCannotBuyTheirOwnListing() public {
        (uint256 listingId,) = _list();
        weth.mint(seller, 10 ether);
        vm.startPrank(seller);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.SelfPurchase.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();
    }

    function test_aCancelledListingCannotBeBought() public {
        (uint256 listingId,) = _list();
        vm.prank(seller);
        desk.cancelListing(listingId);

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.ListingInactive.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();
    }

    function test_aListingWhoseSellerMovedOnCannotBeBought() public {
        (uint256 listingId, uint256 tokenId) = _list();
        vm.prank(seller);
        nft.transferFrom(seller, lp, tokenId);

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.SellerNoLongerOwns.selector);
        desk.openPlan(listingId, 10 ether);
        vm.stopPrank();
    }

    // ─── Instalments ─────────────────────────────────────────────────

    function test_payingEveryInstalmentReleasesTheTokenToTheBuyer() public {
        (uint256 planId, uint256 tokenId) = _open();
        for (uint256 k = 0; k < desk.INSTALMENTS(); k++) {
            skip(desk.INSTALMENT_INTERVAL());
            vm.startPrank(buyer);
            weth.approve(address(desk), 10 ether);
            desk.payInstalment(planId, 10 ether);
            vm.stopPrank();
        }
        assertEq(nft.ownerOf(tokenId), buyer);
        assertTrue(_settled(planId));
    }

    function test_instalmentsReduceTheDebtSoBuyerEquityIsRealNotNominal() public {
        (uint256 planId,) = _open();
        skip(desk.INSTALMENT_INTERVAL());
        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        desk.payInstalment(planId, 10 ether);
        vm.stopPrank();

        (uint256 principalLeft,) = vault.quoteRepay(_loanId(planId));
        assertEq(principalLeft, 2 ether, "one third of the financed leg is retired");
    }

    function test_aPaymentCeilingRefusesAnUnexpectedlyLargeInstalment() public {
        (uint256 planId,) = _open();
        skip(desk.INSTALMENT_INTERVAL());
        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.ParamOutOfRange.selector);
        desk.payInstalment(planId, 0.5 ether);
        vm.stopPrank();
    }

    // ─── Forfeit ─────────────────────────────────────────────────────

    function test_aCurrentPlanCannotBeForfeited() public {
        (uint256 planId,) = _open();
        skip(desk.INSTALMENT_INTERVAL());
        vm.expectRevert(NftfiBnpl.PlanCurrent.selector);
        desk.forfeit(planId);
    }

    function test_forfeitIsPermissionlessAndOnlyAfterTheGrace() public {
        (uint256 planId, uint256 tokenId) = _open();
        (uint64 due, bool forfeitable) = desk.scheduleStatus(planId);
        assertFalse(forfeitable);
        assertEq(due, uint64(block.timestamp + desk.INSTALMENT_INTERVAL()));

        skip(desk.INSTALMENT_INTERVAL() + desk.PAYMENT_GRACE() + 1);
        (, forfeitable) = desk.scheduleStatus(planId);
        assertTrue(forfeitable);

        // Anybody at all — there is no keeper, so this only ever happens
        // because a human or a bot chose to call it.
        vm.prank(lp);
        desk.forfeit(planId);
        assertEq(nft.ownerOf(tokenId), sink);
    }

    function test_aForfeitedPlanRefundsSurplusToTheBuyerFromTheVault() public {
        (uint256 planId,) = _open();
        // The buyer paid one instalment before falling behind — that equity has
        // to survive into the surplus.
        skip(desk.INSTALMENT_INTERVAL());
        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        desk.payInstalment(planId, 10 ether);
        vm.stopPrank();

        skip(desk.INSTALMENT_INTERVAL() + desk.PAYMENT_GRACE() + 1);
        desk.forfeit(planId);

        uint256 loanId = _loanId(planId);
        (uint256 principal, uint256 interest) = vault.quoteRepay(loanId);
        uint256 debt = principal + interest;
        assertEq(principal, 2 ether, "the instalment already paid is inside the debt, not lost ahead of it");

        uint256 buyerBefore = weth.balanceOf(buyer);
        uint256 proceeds = debt + 1.5 ether;
        vm.startPrank(sink);
        weth.approve(address(vault), proceeds);
        vault.settleSeizure(loanId, proceeds);
        vm.stopPrank();

        assertEq(weth.balanceOf(buyer) - buyerBefore, 1.5 ether);
    }

    function test_aForfeitedPlanCannotBePaidOrForfeitedAgain() public {
        (uint256 planId,) = _open();
        skip(desk.INSTALMENT_INTERVAL() + desk.PAYMENT_GRACE() + 1);
        desk.forfeit(planId);

        vm.expectRevert(NftfiBnpl.PlanClosed.selector);
        desk.forfeit(planId);

        vm.startPrank(buyer);
        weth.approve(address(desk), 10 ether);
        vm.expectRevert(NftfiBnpl.PlanClosed.selector);
        desk.payInstalment(planId, 10 ether);
        vm.stopPrank();
    }

    // ─── Fee dial ────────────────────────────────────────────────────

    function test_saleFeeShipsAtZeroAndNeedsARecipientToLeaveIt() public {
        assertEq(desk.saleFeeBps(), 0);

        NftfiBnpl noRecipient = new NftfiBnpl(address(weth), address(vault), address(0), owner);
        vm.prank(owner);
        vm.expectRevert(NftfiBnpl.FeeRecipientUnset.selector);
        noRecipient.setSaleFee(100);
    }

    function test_saleFeeComesOutOfTheSellersProceedsNotTheBuyersUpfront() public {
        vm.prank(owner);
        desk.setSaleFee(100); // 1%

        (uint256 depositWei,, uint256 originationWei,,) = desk.quote(PRICE);
        (uint256 listingId,) = _list();

        vm.startPrank(buyer);
        weth.approve(address(desk), depositWei + originationWei);
        desk.openPlan(listingId, depositWei + originationWei);
        vm.stopPrank();

        assertEq(weth.balanceOf(treasury), 0.04 ether);
        assertEq(weth.balanceOf(seller), PRICE - 0.04 ether);
        assertEq(weth.balanceOf(buyer), 100 ether - depositWei - originationWei);
    }

    function test_depositBpsIsBounded() public {
        // Read the bounds BEFORE arming expectRevert: an argument expression
        // that is itself an external call would consume the expectation.
        uint256 minBps = desk.MIN_DEPOSIT_BPS();
        uint256 maxBps = desk.MAX_DEPOSIT_BPS();

        vm.startPrank(owner);
        vm.expectRevert(NftfiBnpl.ParamOutOfRange.selector);
        desk.setDepositBps(minBps - 1);
        vm.expectRevert(NftfiBnpl.ParamOutOfRange.selector);
        desk.setDepositBps(maxBps + 1);
        vm.stopPrank();
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _loanId(uint256 planId) internal view returns (uint256 loanId) {
        (,,,,,, loanId,,,,) = desk.plans(planId);
    }

    function _settled(uint256 planId) internal view returns (bool settled) {
        (,,,,,,,,, settled,) = desk.plans(planId);
    }

    function _surplusRecipient(uint256 planId) internal view returns (address surplusRecipient) {
        (, surplusRecipient,,,,,,,,) = vault.loans(_loanId(planId));
    }
}
