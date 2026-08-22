// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PositionMarketHarness.sol";

/// @title  TegridyPositionMarket ⇄ TegridyStaking binding suite
///
/// @notice WHY THIS FILE EXISTS
///
///         `TegridyPositionMarket` mirrors two TegridyStaking constants it cannot read
///         (`TRANSFER_RATE_LIMIT` and `MAX_POSITIONS_PER_HOLDER` are both `internal`)
///         and calls five staking selectors it cannot compile against. Both are silent
///         couplings: a mirrored constant drifts without a compile error, and a
///         selector lowered `external → internal` vanishes from the ABI, at which point
///         calling it on a contract with no fallback reverts with empty returndata —
///         indistinguishable from a legitimate refusal.
///
///         That is not hypothetical here. On 2026-05-31 an EIP-170 golf pass lowered
///         `TegridyStaking.userPositionCount` to `internal` under a comment asserting
///         zero callers; it missed `CommunityGrants.sol:335` and every grant proposal
///         became un-creatable against a real deployment. The lesson that suite drew —
///         bind to the deployed contract, not to a mock's restatement of it — is what
///         this file applies to the position market.
///
///         Everything asserted below is a fact about TegridyStaking, checked by driving
///         TegridyStaking. If any of these fail, the market's constants or its interface
///         are stale and it must be redeployed, not patched around.
contract PositionMarketStakingBindingTest is PositionMarketFixture {
    // ═════════════════════════════════════════════════════════════════════════
    // Mirrored constants
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice `STAKING_TRANSFER_RATE_LIMIT` must be exactly the window TegridyStaking
    ///         enforces between two hops of the same position. The market's whole
    ///         "refuse before funds commit" promise rests on this number: too small and
    ///         a fill reverts underneath a buyer's payment; too large and sellers are
    ///         locked out of their own listings for longer than the chain requires.
    function test_mirror_rateLimit_matchesRealStaking() public {
        uint256 mirrored = market.STAKING_TRANSFER_RATE_LIMIT();

        PlainPositionHolderPM a = new PlainPositionHolderPM();
        PlainPositionHolderPM b = new PlainPositionHolderPM();

        uint256 tokenId = _stake(alice);
        _passStakeCooldown();
        vm.prank(alice);
        staking.transferFrom(alice, address(a), tokenId);
        uint256 stampedAt = block.timestamp;

        // One second short of the mirrored window: staking still refuses.
        vm.warp(stampedAt + mirrored - 1);
        vm.expectRevert(TegridyStaking.TransferRateLimited.selector);
        a.send(address(staking), address(b), tokenId);

        // Exactly the mirrored window: staking allows it. Both halves are needed —
        // either alone would pass for a merely-conservative mirror.
        vm.warp(stampedAt + mirrored);
        a.send(address(staking), address(b), tokenId);
        assertEq(staking.ownerOf(tokenId), address(b));
    }

    /// @notice `MAX_ESCROWED_POSITIONS` must be exactly TegridyStaking's per-holder cap.
    ///         The market is a plain contract holder with no escrow carve-out, so that
    ///         cap is a hard ceiling on simultaneously escrowed listings; `list` refuses
    ///         at it so the failure is named rather than a `TooManyPositions` revert
    ///         from inside the transfer.
    function test_mirror_positionCap_matchesRealStaking() public {
        uint256 cap = market.MAX_ESCROWED_POSITIONS();
        PlainPositionHolderPM holder = new PlainPositionHolderPM();

        uint256[] memory ids = new uint256[](cap + 1);
        for (uint256 i = 0; i < cap + 1; i++) {
            address staker = address(uint160(uint256(keccak256(abi.encode("capStaker", i)))));
            token.transfer(staker, 200_000 ether);
            vm.startPrank(staker);
            token.approve(address(staking), type(uint256).max);
            staking.stake(150_000 ether, LOCK);
            ids[i] = staking.userTokenId(staker);
            vm.stopPrank();
        }
        _passStakeCooldown();

        for (uint256 i = 0; i < cap; i++) {
            address staker = address(uint160(uint256(keccak256(abi.encode("capStaker", i)))));
            vm.prank(staker);
            staking.transferFrom(staker, address(holder), ids[i]);
        }

        address last = address(uint160(uint256(keccak256(abi.encode("capStaker", cap)))));
        vm.prank(last);
        vm.expectRevert(TegridyStaking.TooManyPositions.selector);
        staking.transferFrom(last, address(holder), ids[cap]);
    }

    /// @notice The market refuses at its own cap with a named error, rather than letting
    ///         the seller's listing revert inside the staking hop.
    function test_escrowCap_isRefusedByTheMarketFirst() public {
        uint256 cap = market.MAX_ESCROWED_POSITIONS();

        uint256[] memory ids = new uint256[](cap + 1);
        address[] memory sellers = new address[](cap + 1);
        for (uint256 i = 0; i < cap + 1; i++) {
            sellers[i] = address(uint160(uint256(keccak256(abi.encode("escrowSeller", i)))));
            token.transfer(sellers[i], 200_000 ether);
            vm.startPrank(sellers[i]);
            token.approve(address(staking), type(uint256).max);
            staking.setApprovalForAll(address(market), true);
            staking.stake(150_000 ether, LOCK);
            ids[i] = staking.userTokenId(sellers[i]);
            vm.stopPrank();
        }
        _passStakeCooldown();

        for (uint256 i = 0; i < cap; i++) {
            vm.prank(sellers[i]);
            market.list(ids[i], PRICE);
        }
        assertEq(market.escrowedCount(), cap);

        vm.prank(sellers[cap]);
        vm.expectRevert(TegridyPositionMarket.EscrowCapReached.selector);
        market.list(ids[cap], PRICE);

        // The cap is a live count, not a high-water mark: one release frees one slot.
        _passRateLimit();
        vm.prank(sellers[0]);
        market.cancel(1, sellers[0]);
        vm.prank(sellers[cap]);
        market.list(ids[cap], PRICE);
        assertEq(market.escrowedCount(), cap);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ABI surface — every selector the market calls on staking
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice A staticcall to each read selector this slice depends on — the three the
    ///         market itself calls, plus `positions` which the suite's lock-state
    ///         assertions read. An `external → internal` lowering removes the selector
    ///         from the ABI and this fails with empty returndata, which is the whole
    ///         point: the failure surfaces here instead of as a mysterious refusal on a
    ///         live money path.
    function test_abi_readSelectorsAreStillExported() public view {
        _requireSelector(abi.encodeWithSignature("userTokenId(address)", alice), "userTokenId(address)");
        _requireSelector(abi.encodeWithSignature("unsettledRewards(address)", alice), "unsettledRewards(address)");
        _requireSelector(abi.encodeWithSignature("rewardToken()"), "rewardToken()");
        _requireSelector(abi.encodeWithSignature("positions(uint256)", uint256(1)), "positions(uint256)");
    }

    /// @notice `claimUnsettled()` and `kick(uint256)` are the two write selectors the
    ///         market calls. Both are exercised for real elsewhere in the suite; here we
    ///         only prove they still exist, by observing that they revert for a
    ///         *semantic* reason rather than for an absent selector.
    function test_abi_writeSelectorsAreStillExported() public {
        // `kick` on a non-existent position reverts `NoPosition` — a typed revert, which
        // proves the selector resolved.
        vm.expectRevert(TegridyStaking.NoPosition.selector);
        staking.kick(999_999);

        // `claimUnsettled` with an empty bucket reverts `NothingToClaim`-class rather
        // than with empty returndata. Assert only that returndata is non-empty, so this
        // does not encode which error staking chooses today.
        (bool ok, bytes memory ret) = address(staking).call(abi.encodeWithSignature("claimUnsettled()"));
        assertFalse(ok, "fixture assumes an empty bucket reverts");
        assertGt(ret.length, 0, "claimUnsettled() must still resolve to a real function");
    }

    /// @notice The reward token the market denominates its escrow ledger in must be the
    ///         one staking actually pays out. It is read from staking at construction so
    ///         it cannot be mis-wired, and this pins that.
    function test_rewardToken_isReadFromStakingNotSupplied() public view {
        assertEq(address(market.rewardToken()), address(staking.rewardToken()));
        assertEq(address(market.rewardToken()), address(token));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // The guard itself
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The market's refusal must track the guard, not a remembered version of
    ///         it. This drives TegridyStaking directly into `AlreadyHasPosition` under
    ///         exactly the condition `fillability` reports, so the two cannot diverge
    ///         without one of them failing.
    function test_guard_marketRefusalMatchesStakingRevert() public {
        uint256 aliceToken = _stake(alice);
        _stake(bob);
        _passStakeCooldown();

        // Staking's own behaviour, straight at the contract.
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(alice, bob, aliceToken);

        // The market's report of that same condition.
        vm.prank(alice);
        uint256 orderId = market.list(aliceToken, PRICE);
        _passRateLimit();
        (TegridyPositionMarket.Blocker blocker, bool certain,) = market.fillability(orderId, bob);
        assertEq(uint8(blocker), uint8(TegridyPositionMarket.Blocker.RecipientAlreadyHoldsPosition));
        assertTrue(certain);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TegridyPositionMarket.RecipientHoldsPosition.selector, bob));
        market.fill{value: PRICE}(orderId, bob);
    }

    /// @notice The market is deliberately NOT registered as a lending contract. That
    ///         registration would carve it out of the cooldown and rate-limit guards it
    ///         has no business escaping, and would let a position land on a buyer who
    ///         already holds one. This pins the un-registered state.
    function test_guard_marketIsNotALendingContract() public view {
        assertFalse(staking.isLendingContract(address(market)), "the market must hold no escrow carve-out");
    }

    function _requireSelector(bytes memory callData, string memory what) private view {
        (bool ok, bytes memory ret) = address(staking).staticcall(callData);
        assertTrue(ok, string.concat("selector no longer exported: ", what));
        assertGt(ret.length, 0, string.concat("empty return from: ", what));
    }
}
