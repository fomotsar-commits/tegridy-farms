// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PositionMarketHarness.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TegridyPositionMarket — the fee dial, and the yield that accrues in escrow
contract PositionMarketFeeAndRewardsTest is PositionMarketFixture {
    // ═════════════════════════════════════════════════════════════════════════
    // Fee dial: ships at zero, with no sink
    // ═════════════════════════════════════════════════════════════════════════

    function test_fee_shipsAtZeroWithNoSink() public view {
        assertEq(market.feeBps(), 0);
        assertEq(market.feeRecipient(), address(0));
    }

    function test_fee_cannotBeRaisedWithoutASink() public {
        vm.expectRevert(TegridyPositionMarket.FeeWithoutSink.selector);
        market.setFee(100, address(0));
    }

    function test_fee_cannotExceedItsHardCeiling() public {
        // Read the ceiling first: `vm.expectRevert` arms the very next call, and an
        // inline `market.MAX_FEE_BPS()` would consume it.
        uint16 overCeiling = market.MAX_FEE_BPS() + 1;
        vm.expectRevert(TegridyPositionMarket.FeeTooHigh.selector);
        market.setFee(overCeiling, sink);
    }

    function test_fee_isOwnerOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        market.setFee(100, sink);
    }

    function test_fee_atZero_sellerReceivesTheWholePrice() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);
        assertEq(alice.balance, PRICE);
        assertEq(sink.balance, 0);
    }

    function test_fee_whenWiredIsPaidBySellerOutOfProceeds() public {
        market.setFee(100, sink); // 1%
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();

        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        uint256 expectedFee = PRICE / 100;
        assertEq(sink.balance, expectedFee);
        assertEq(alice.balance, PRICE - expectedFee);
        assertEq(address(market).balance, 0, "the market keeps nothing");
    }

    /// @notice A listing carries the fee that was in force when its seller signed it.
    ///         Raising the dial afterwards must not reach back into standing orders.
    function test_fee_changeIsNotRetroactiveToStandingOrders() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        market.setFee(market.MAX_FEE_BPS(), sink);
        _passRateLimit();

        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        assertEq(sink.balance, 0, "the standing order was listed at a zero fee");
        assertEq(alice.balance, PRICE);
    }

    /// @notice Turning the dial back off leaves no sink and takes no cut.
    function test_fee_canBeReturnedToZeroAndNoSink() public {
        market.setFee(250, sink);
        market.setFee(0, address(0));
        assertEq(market.feeBps(), 0);
        assertEq(market.feeRecipient(), address(0));

        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);
        assertEq(sink.balance, 0);
        assertEq(alice.balance, PRICE);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Escrow-period yield
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Every staking transfer settles the SENDER's accrued rewards. On the
    ///         release hop the sender is the market, so a naive escrow would strand the
    ///         yield that accrued while the position was listed. It is credited to the
    ///         seller instead, whose capital was the thing locked for that window.
    function test_escrowYield_isCreditedToTheSellerAndClaimable() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        vm.warp(block.timestamp + 3 days);

        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        uint256 owed = market.escrowRewardsOwed(alice);
        assertGt(owed, 0, "escrow-period yield must be attributed, not stranded");
        assertEq(market.totalEscrowRewardsOwed(), owed);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = market.claimEscrowRewards();

        assertEq(paid, owed);
        assertEq(token.balanceOf(alice) - before, owed);
        assertEq(market.escrowRewardsOwed(alice), 0);
        assertEq(market.totalEscrowRewardsOwed(), 0);
        assertEq(token.balanceOf(address(market)), 0, "nothing left behind");
    }

    function test_escrowYield_isCreditedOnCancelToo() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        vm.warp(block.timestamp + 3 days);

        vm.prank(alice);
        market.cancel(orderId, alice);

        assertGt(market.escrowRewardsOwed(alice), 0);
    }

    /// @notice Two sellers escrowing at once must not draw on each other. The staking
    ///         bucket this market drains is a single commingled per-address balance, so
    ///         attribution is measured across each release hop rather than read off it.
    function test_escrowYield_doesNotCommingleBetweenSellers() public {
        (uint256 orderA,) = _listReady(alice, PRICE);
        uint256 tokenB = _stake(carol, STAKE_AMT, LOCK);
        _passStakeCooldown();
        vm.prank(carol);
        uint256 orderB = market.list(tokenB, PRICE);

        // Alice's position sits in escrow far longer than Carol's.
        vm.warp(block.timestamp + 5 days);
        vm.prank(carol);
        market.cancel(orderB, carol);
        uint256 carolOwed = market.escrowRewardsOwed(carol);

        vm.warp(block.timestamp + 5 days);
        vm.prank(bob);
        market.fill{value: PRICE}(orderA, bob);
        uint256 aliceOwed = market.escrowRewardsOwed(alice);

        assertGt(carolOwed, 0);
        assertGt(aliceOwed, carolOwed, "the longer escrow earned more");
        assertEq(market.totalEscrowRewardsOwed(), aliceOwed + carolOwed);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 carolBefore = token.balanceOf(carol);
        vm.prank(alice);
        market.claimEscrowRewards();
        vm.prank(carol);
        market.claimEscrowRewards();

        assertEq(token.balanceOf(alice) - aliceBefore, aliceOwed);
        assertEq(token.balanceOf(carol) - carolBefore, carolOwed, "the first claimer did not drain the second");
        assertEq(market.totalEscrowRewardsOwed(), 0);
    }

    function test_escrowYield_claimRevertsWhenNothingIsOwed() public {
        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.NothingOwed.selector);
        market.claimEscrowRewards();
    }

    /// @notice A paused staking contract must degrade to "nothing arrived", never to a
    ///         reverting fill or a reverting cancel — and never to a silently zeroed
    ///         ledger entry.
    function test_escrowYield_survivesAPausedStakingContract() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        uint256 owed = market.escrowRewardsOwed(alice);
        assertGt(owed, 0);

        staking.pause();
        vm.prank(alice);
        vm.expectRevert(TegridyPositionMarket.RewardsNotYetClaimable.selector);
        market.claimEscrowRewards();
        assertEq(market.escrowRewardsOwed(alice), owed, "an unpaid claim leaves the debt standing");

        staking.unpause();
        vm.prank(alice);
        assertEq(market.claimEscrowRewards(), owed);
    }

    /// @notice A pause on THIS market must not block a seller's yield either.
    function test_escrowYield_claimIsNotPausable() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        market.fill{value: PRICE}(orderId, bob);

        market.pause();
        vm.prank(alice);
        assertGt(market.claimEscrowRewards(), 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Kicks against an escrowed position
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice `TegridyStaking.kick` is permissionless and settles the HOLDER's pending
    ///         rewards; while a position is escrowed the holder is this market. Routed
    ///         through `kickEscrowed`, that settlement is attributed to the seller.
    function test_kickEscrowed_attributesTheDecaySettlementToTheSeller() public {
        (uint256 orderId, uint256 tokenId) = _listReady(alice, PRICE);
        vm.warp(block.timestamp + LOCK + 1); // lock expires while escrowed

        market.kickEscrowed(orderId);

        uint256 owed = market.escrowRewardsOwed(alice);
        assertGt(owed, 0, "the kick's settlement belongs to the seller, not to the market");

        (uint256 amount, uint256 boostedAfter,,,,,,,,,) = staking.positions(tokenId);
        assertEq(boostedAfter, 0, "an expired position's boosted weight is decayed away");
        assertEq(amount, STAKE_AMT, "principal is untouched by the decay");
    }

    function test_kickEscrowed_requiresAnOpenOrder() public {
        (uint256 orderId,) = _listReady(alice, PRICE);
        _passRateLimit();
        vm.prank(alice);
        market.cancel(orderId, alice);

        vm.expectRevert(TegridyPositionMarket.OrderNotOpen.selector);
        market.kickEscrowed(orderId);
    }

    /// @notice The direct route cannot be closed: anyone may call `staking.kick` on an
    ///         escrowed position, which drops value into this contract's bucket with no
    ///         order attached. That value is real yield with no identifiable owner, and
    ///         `surplusRewards` is what names it. The bound that matters is that the
    ///         sweep can never reach what sellers are owed.
    function test_surplus_fromADirectKickIsSweepableButNeverReachesOwedYield() public {
        // Alice's lock is short enough to expire while escrowed, so it is kickable.
        // Carol's is not, so her escrow yield accrues normally alongside it.
        uint256 aliceToken = _stake(alice, STAKE_AMT, 7 days);
        uint256 carolToken = _stake(carol, STAKE_AMT, LOCK);
        _passStakeCooldown();
        vm.prank(alice);
        uint256 aliceOrder = market.list(aliceToken, PRICE);
        vm.prank(carol);
        uint256 carolOrder = market.list(carolToken, PRICE);

        vm.warp(block.timestamp + 7 days);
        staking.kick(aliceToken); // straight at staking, bypassing kickEscrowed
        assertEq(market.escrowRewardsOwed(alice), 0, "a direct kick attributes to nobody");
        assertGt(market.surplusRewards() + staking.unsettledRewards(address(market)), 0);

        vm.warp(block.timestamp + 2 days);
        vm.prank(carol);
        market.cancel(carolOrder, carol);
        uint256 carolOwed = market.escrowRewardsOwed(carol);
        assertGt(carolOwed, 0, "the untouched escrow still earns for its seller");

        vm.prank(bob);
        market.fill{value: PRICE}(aliceOrder, bob);

        address collector = makeAddr("collector");
        market.rescueSurplusRewards(collector);

        assertGt(token.balanceOf(collector), 0, "the unattributed slice is recoverable");
        assertEq(market.escrowRewardsOwed(carol), carolOwed, "the seller's ledger is untouched");
        assertEq(token.balanceOf(address(market)), market.totalEscrowRewardsOwed(), "owed yield stays fully backed");

        uint256 before = token.balanceOf(carol);
        vm.prank(carol);
        assertEq(market.claimEscrowRewards(), carolOwed);
        assertEq(token.balanceOf(carol) - before, carolOwed);
    }

    function test_surplus_revertsWhenThereIsNone() public {
        assertEq(market.surplusRewards(), 0);
        vm.expectRevert(TegridyPositionMarket.NoSurplus.selector);
        market.rescueSurplusRewards(makeAddr("collector"));
    }

    function test_surplus_sweepIsOwnerOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        market.rescueSurplusRewards(bob);
    }
}
