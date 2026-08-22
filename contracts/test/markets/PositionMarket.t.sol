// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PositionMarketHarness.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TegridyPositionMarket — escrow, fill, cancel, custody
contract PositionMarketTest is PositionMarketFixture {
    // ═════════════════════════════════════════════════════════════════════════
    // Listing
    // ═════════════════════════════════════════════════════════════════════════

    function test_list_movesPositionIntoEscrowAndOpensOrder() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);

        assertEq(staking.ownerOf(tokenId), address(market), "market holds the position");
        assertEq(market.escrowedCount(), 1);
        assertEq(market.openOrderOfToken(tokenId), orderId);

        (address seller, uint96 price,,, TegridyPositionMarket.OrderStatus status,, uint256 tid) =
            market.orders(orderId);
        assertEq(seller, alice);
        assertEq(uint256(price), PRICE);
        assertEq(tid, tokenId);
        assertEq(uint8(status), uint8(TegridyPositionMarket.OrderStatus.Open));
    }

    function test_list_beforeStakeCooldown_isRefusedByStaking() public {
        uint256 tokenId = _stake(alice);
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.TransferCooldownActive.selector);
        market.list(tokenId, PRICE);
    }

    function test_list_rejectsZeroPrice() public {
        uint256 tokenId = _stake(alice);
        _passStakeCooldown();
        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.ZeroPrice.selector);
        market.list(tokenId, 0);
    }

    function test_list_rejectsPriceAboveUint96() public {
        uint256 tokenId = _stake(alice);
        _passStakeCooldown();
        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.PriceTooHigh.selector);
        market.list(tokenId, uint256(type(uint96).max) + 1);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Filling
    // ═════════════════════════════════════════════════════════════════════════

    function test_fill_atomicallySwapsPositionForPayment() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();

        (uint256 amtBefore,,, uint64 lockEndBefore, uint16 boostBefore,,,,,,) = staking.positions(tokenId);
        uint256 aliceEthBefore = alice.balance;

        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        assertEq(staking.ownerOf(tokenId), bob, "buyer owns the position");
        assertEq(alice.balance - aliceEthBefore, PRICE, "seller received the full price at zero fee");
        assertEq(address(market).balance, 0, "market keeps no ETH");
        assertEq(market.escrowedCount(), 0);
        assertEq(market.openOrderOfToken(tokenId), 0);

        // Lock state must survive the sale untouched — that is the whole product.
        (uint256 amtAfter,,, uint64 lockEndAfter, uint16 boostAfter,,,,,,) = staking.positions(tokenId);
        assertEq(amtAfter, amtBefore, "principal intact");
        assertEq(lockEndAfter, lockEndBefore, "lock end intact");
        assertEq(boostAfter, boostBefore, "boost intact");
        assertGt(staking.votingPowerOf(bob), 0, "buyer inherits voting power");
        assertEq(staking.votingPowerOf(alice), 0, "seller keeps none");
    }

    function test_fill_wrongPaymentIsRefused() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.WrongPayment.selector, PRICE, PRICE - 1));
        market.fill{value: PRICE - 1}(orderId, bob);

        // Overpayment is refused too: no change is made, so accepting it would keep it.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.WrongPayment.selector, PRICE, PRICE + 1));
        market.fill{value: PRICE + 1}(orderId, bob);
    }

    function test_fill_beforeRateLimitClears_refusesWithDeadline() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        uint64 releasableAt = uint64(block.timestamp + market.STAKING_TRANSFER_RATE_LIMIT());

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.PositionRateLimited.selector, releasableAt));
        market.fill{value: PRICE}(orderId, bob);

        // One second before the deadline is still refused; the deadline itself is not.
        vm.warp(releasableAt - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.PositionRateLimited.selector, releasableAt));
        market.fill{value: PRICE}(orderId, bob);

        vm.warp(releasableAt);
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // The single-position guard — the constraint the whole design turns on
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice A buyer who already holds a staking position is refused BEFORE any value
    ///         moves, with a reason naming the address at fault — not left to discover
    ///         it when TegridyStaking reverts underneath their payment.
    function test_fill_buyerAlreadyHoldingAPosition_isRefusedByName() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _stake(bob); // bob now has userTokenId != 0
        _passRateLimit();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.RecipientHoldsPosition.selector, bob));
        market.fill{value: PRICE}(orderId, bob);

        assertEq(uint8(_status(orderId)), uint8(TegridyPositionMarket.OrderStatus.Open), "order untouched");
        assertEq(market.escrowedCount(), 1);
    }

    /// @notice ...and the honest route out is a parameter, not a workaround: the same
    ///         buyer directs delivery at a fresh address and the fill goes through.
    function test_fill_buyerWithPositionCanDeliverToFreshAddress() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _stake(bob);
        _passRateLimit();

        address fresh = makeAddr("bobSecondWallet");
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, fresh);

        assertEq(staking.ownerOf(tokenId), fresh);
    }

    /// @notice A contract recipient is exempt from the EOA guard, so a buyer that IS a
    ///         contract may hold a second position.
    function test_fill_contractRecipientMayHoldASecondPosition() public {
        PlainPositionHolderPM holder = new PlainPositionHolderPM();

        (uint256 firstOrder, uint256 firstToken) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(bob);
        market.fill{value: PRICE}(firstOrder, address(holder));

        (uint256 secondOrder, uint256 secondToken) = _listReady(carol, PRICE);
        _passRateLimit();
        vm.prank(bob);
        market.fill{value: PRICE}(secondOrder, address(holder));

        assertEq(staking.ownerOf(firstToken), address(holder));
        assertEq(staking.ownerOf(secondToken), address(holder));
    }

    /// @notice The EIP-7702 shape. An EOA with a 23-byte delegation pointer is still an
    ///         EOA to the staking guard, so the market must treat it as one.
    function test_fill_eip7702DelegatedEoaIsTreatedAsAnEoa() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _stake(bob);
        // 0xef0100 ‖ 20-byte address == the canonical 23-byte delegation pointer.
        vm.etch(bob, hex"ef0100000000000000000000000000000000000000dead");
        assertEq(bob.code.length, 23, "fixture must produce the 7702 shape");
        _passRateLimit();

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.RecipientHoldsPosition.selector, bob));
        market.fill{value: PRICE}(orderId, bob);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // fillability — the honesty gate
    // ═════════════════════════════════════════════════════════════════════════

    function test_fillability_reportsEachBlockerAndItsDeadline() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        uint64 expectedAt = uint64(block.timestamp + market.STAKING_TRANSFER_RATE_LIMIT());

        (TegridyPositionMarket.Blocker b, bool certain, uint64 at) = market.fillability(orderId, bob);
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.RateLimited));
        assertTrue(certain);
        assertEq(at, expectedAt);

        _passRateLimit();
        (b, certain,) = market.fillability(orderId, bob);
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.None));
        assertTrue(certain, "an EOA recipient can be fully checked");

        _stake(bob);
        (b, certain,) = market.fillability(orderId, bob);
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.RecipientAlreadyHoldsPosition));
        assertTrue(certain);

        (b, certain,) = market.fillability(orderId, address(0));
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.ZeroRecipient));
        assertTrue(certain);
    }

    /// @notice The gate that matters: for a CONTRACT recipient the market cannot read
    ///         TegridyStaking's per-holder cap (`userPositionCount` is `internal`), so
    ///         it reports "nothing blocking found" together with `certain == false`.
    ///         A caller that renders that as "eligible" is claiming something the chain
    ///         was never asked.
    function test_fillability_contractRecipientIsNeverCertified() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();

        PlainPositionHolderPM holder = new PlainPositionHolderPM();
        (TegridyPositionMarket.Blocker b, bool certain,) = market.fillability(orderId, address(holder));
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.None));
        assertFalse(certain, "contract recipients must never be reported as certainly clear");
    }

    function test_fillability_closedOrderIsReportedAsSuch() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        (TegridyPositionMarket.Blocker b, bool certain,) = market.fillability(orderId, carol);
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.OrderNotOpenBlocker));
        assertTrue(certain);

        // A never-issued order id reads as closed rather than as fillable.
        (b, certain,) = market.fillability(9_999, carol);
        assertEq(uint8(b), uint8(TegridyPositionMarket.Blocker.OrderNotOpenBlocker));
        assertTrue(certain);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Cancelling
    // ═════════════════════════════════════════════════════════════════════════

    function test_cancel_returnsPositionToSeller() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();

        vm.prank(alice);
        market.cancel(orderId, alice);

        assertEq(staking.ownerOf(tokenId), alice);
        assertEq(market.escrowedCount(), 0);
        assertEq(uint8(_status(orderId)), uint8(TegridyPositionMarket.OrderStatus.Cancelled));
    }

    function test_cancel_onlySeller() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(bob);
        vm.expectRevert(TegridyPositionMarket.NotSeller.selector);
        market.cancel(orderId, bob);
    }

    /// @notice The trap that makes `cancel`'s recipient a parameter.
    ///
    ///         Escrowing zeroes `userTokenId[seller]` — the exact field `stake()`
    ///         checks — so a seller can list and then stake a brand-new position. Their
    ///         own address is now ineligible to receive the escrowed one back, and a
    ///         cancel hardcoded to the seller would leave the position stuck until they
    ///         unwound the new stake.
    function test_cancel_sellerWhoRestakedIsRefusedThenRoutedElsewhere() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        assertEq(staking.userTokenId(alice), 0, "escrow clears the single-position pointer");

        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK); // legal, precisely because the pointer was cleared
        _passRateLimit();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.RecipientHoldsPosition.selector, alice));
        market.cancel(orderId, alice);

        address second = makeAddr("aliceSecondWallet");
        vm.prank(alice);
        market.cancel(orderId, second);
        assertEq(staking.ownerOf(tokenId), second);
    }

    function test_cancel_beforeRateLimitClears_isRefused() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        uint64 releasableAt = uint64(block.timestamp + market.STAKING_TRANSFER_RATE_LIMIT());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.PositionRateLimited.selector, releasableAt));
        market.cancel(orderId, alice);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // A fill racing a cancel
    // ═════════════════════════════════════════════════════════════════════════

    function test_race_cancelLandsFirst_fillFindsNothing() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();

        vm.prank(alice);
        market.cancel(orderId, alice);

        uint256 bobEthBefore = bob.balance;
        vm.prank(bob);
        vm.expectRevert(TegridyPositionMarket.OrderNotOpen.selector);
        market.fill{value: PRICE}(orderId, bob);

        assertEq(bob.balance, bobEthBefore, "a losing buyer parts with nothing but gas");
        assertEq(staking.ownerOf(tokenId), alice);
    }

    function test_race_fillLandsFirst_cancelFindsNothing() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();

        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.OrderNotOpen.selector);
        market.cancel(orderId, alice);

        assertEq(staking.ownerOf(tokenId), bob, "the sale stands");
    }

    /// @notice The race compressed into a single transaction: the seller is a contract
    ///         that tries to cancel from inside the fill's ETH payout. The position has
    ///         already moved and the order is already Filled by then, and the guard
    ///         refuses the reentry outright.
    function test_race_sellerCancelsFromInsideItsOwnPayout() public {
        ReentrantSellerPM seller = new ReentrantSellerPM(market);
        token.transfer(address(seller), 2_000_000 ether);
        seller.stakeIt(address(staking), address(token), STAKE_AMT, LOCK);
        seller.approveAll(address(staking));
        uint256 tokenId = staking.userTokenId(address(seller));

        _passStakeCooldown();
        uint256 orderId = seller.listIt(tokenId, PRICE);
        _passRateLimit();

        seller.arm(orderId);
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        assertTrue(seller.receiveRan(), "payout leg must have reached the seller");
        assertTrue(seller.innerReverted(), "the reentrant cancel must have been refused");
        assertEq(staking.ownerOf(tokenId), bob);
        assertEq(uint8(_status(orderId)), uint8(TegridyPositionMarket.OrderStatus.Filled));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Reentrant ERC-721 receiver
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The buyer's `onERC721Received` fires while it holds the position and
    ///         before the seller has been paid. Reentering `fill` on the same order
    ///         must not buy it twice.
    function test_reentrantReceiver_cannotRefillTheSameOrder() public {
        ReentrantBuyerPM buyer = new ReentrantBuyerPM(market);
        vm.deal(address(buyer), 100 ether);

        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();

        buyer.arm(ReentrantBuyerPM.Mode.RefillSameOrder, orderId, PRICE);
        buyer.buy(orderId, PRICE);

        assertTrue(buyer.hookRan(), "receiver hook must have run");
        assertTrue(buyer.innerReverted(), "the reentrant fill must have been refused");
        assertEq(staking.ownerOf(tokenId), address(buyer));
        assertEq(address(buyer).balance, 100 ether - PRICE, "the buyer paid exactly once");
        assertEq(alice.balance, PRICE, "the seller was paid exactly once");
        assertEq(address(market).balance, 0);
    }

    /// @notice ...and it cannot reach a DIFFERENT open order either, in either
    ///         direction: neither draining a second listing nor cancelling one.
    function test_reentrantReceiver_cannotTouchAnotherOpenOrder() public {
        ReentrantBuyerPM buyer = new ReentrantBuyerPM(market);
        vm.deal(address(buyer), 100 ether);

        (uint256 orderA, uint256 tokenA) = _listReady(alice, PRICE);
        uint256 tokenB = _stake(carol);
        _passStakeCooldown();
        vm.prank(carol);
        uint256 orderB = market.list(tokenB, PRICE);
        _passRateLimit();

        buyer.arm(ReentrantBuyerPM.Mode.FillOtherOrder, orderB, PRICE);
        buyer.buy(orderA, PRICE);
        assertTrue(buyer.innerReverted(), "the cross-order reentrant fill must have been refused");
        assertEq(staking.ownerOf(tokenA), address(buyer));
        assertEq(staking.ownerOf(tokenB), address(market), "the second listing is untouched");
        assertEq(uint8(_status(orderB)), uint8(TegridyPositionMarket.OrderStatus.Open));

        // Same again, this time trying to cancel someone else's listing from the hook.
        (uint256 orderC, uint256 tokenC) = _listReady(alice, PRICE);
        _passRateLimit();
        buyer.arm(ReentrantBuyerPM.Mode.CancelOtherOrder, orderB, 0);
        vm.prank(bob);
        market.fill{value: PRICE}(orderC, address(buyer));
        assertTrue(buyer.innerReverted(), "the reentrant cancel must have been refused");
        assertEq(staking.ownerOf(tokenB), address(market));
        assertEq(staking.ownerOf(tokenC), address(buyer));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Unsolicited transfers and rescue
    // ═════════════════════════════════════════════════════════════════════════

    function test_receiver_refusesUnsolicitedSafeTransfer() public {
        uint256 tokenId = _stake(alice);
        _passStakeCooldown();
        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.UnexpectedPositionTransfer.selector);
        staking.safeTransferFrom(alice, address(market), tokenId);
    }

    function test_rescue_recoversAPushedPositionButNeverAnEscrowedOne() public {
        // A plain `transferFrom` has no hook to refuse with, so it can strand a
        // position here with no order behind it.
        uint256 stray = _stake(alice);
        _passStakeCooldown();
        vm.prank(alice);
        staking.transferFrom(alice, address(market), stray);
        assertEq(staking.ownerOf(stray), address(market));

        (uint256 orderId, uint256 escrowed) = _listReady(carol, PRICE);
        assertGt(orderId, 0);

        vm.expectRevert(TegridyPositionMarket.EscrowedPositionNotRescuable.selector);
        market.rescueUnlistedPosition(escrowed, address(this));

        _passRateLimit();
        market.rescueUnlistedPosition(stray, alice);
        assertEq(staking.ownerOf(stray), alice);
    }

    function test_rescue_isOwnerOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        market.rescueUnlistedPosition(1, bob);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Pausing
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice A pause stops new exposure. It must never hold user property: a seller
    ///         can still withdraw an unsold listing and still claim escrow yield.
    function test_pause_blocksListAndFillButNeverCancel() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        _passRateLimit();
        market.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.fill{value: PRICE}(orderId, bob);

        uint256 other = _stake(carol);
        _passStakeCooldown();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.list(other, PRICE);

        vm.prank(alice);
        market.cancel(orderId, alice);
        assertEq(staking.ownerOf(tokenId), alice, "a pause cannot trap an unsold position");
    }

    function test_pause_isOwnerOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        market.pause();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Helpers
    // ═════════════════════════════════════════════════════════════════════════

    function _status(uint256 orderId) internal view returns (TegridyPositionMarket.OrderStatus s) {
        (,,,, s,,) = market.orders(orderId);
    }
}
