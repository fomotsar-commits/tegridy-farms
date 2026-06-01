// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";

contract MockTokenDeep is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBACDeep is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @title DEEP_2026_05_01 — TegridyStaking deep-audit regressions
/// @notice Covers DS-01 (Critical), DS-02 (High), DS-06 (Medium), DS-07 (Low),
///         DS-10 (Low), DS-12 (Low), DS-13 (Low) from
///         `.audit_101/DEEP_2026_05_01/03_staking_core.md`.
contract Deep_Staking_2026_05_01_Test is Test {
    TegridyStaking public staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin public admin;
    MockTokenDeep public token;
    MockJBACDeep public nft;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public kicker = makeAddr("kicker");

    function setUp() public {
        token = new MockTokenDeep();
        nft = new MockJBACDeep();
        // BATCH-J2 H8: kick reverts if pending rewards exceed unsettled cap
        // (100k ether). Drop reward rate from 1 ether/sec → 1e14/sec so
        // 5-7d accrual stays well under the cap regardless of stake size.
        staking = new TegridyStaking(address(token), address(nft), treasury, 1e14);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(1_000_000 ether);
    }

    // ─── DS-01 (Critical) — REGRESSION TEST ─────────────────────────────

    /// @notice DS-01 regression: users who let their lock expire and then call
    ///         `withdraw()` MUST receive their pre-expiry pending rewards.
    ///         Pre-fix, `withdraw` called `_decayIfExpired` BEFORE `_getReward`,
    ///         which short-circuited on `boostedAmount == 0` and silently paid
    ///         only principal. Post-fix, `_getReward` runs first (M-01 ordering
    ///         applies) and pre-expiry rewards are paid correctly.
    function test_withdraw_afterLockExpired_paysAccruedRewards() public {
        // Two stakers so totalBoostedStake > 0 across the elapsed window.
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(500_000 ether, 7 days);
        vm.prank(alice);
        staking.stake(500_000 ether, 365 days);

        uint256 bobTid = staking.userTokenId(bob);

        // Let some time pass while Bob is still inside his lock — rewards accrue.
        vm.warp(block.timestamp + 5 days);

        // earned() reports pre-expiry pending rewards.
        uint256 earnedBeforeExpiry = monitor.earned(bobTid);
        assertGt(earnedBeforeExpiry, 0, "earned() reports non-zero pre-expiry");

        // Advance past lockEnd. `earned()` should still report pre-expiry rewards
        // because _getReward in _accumulateRewards path captures pre-decay accrual.
        vm.warp(1000 + 7 days + 1);
        uint256 earnedAfterExpiry = monitor.earned(bobTid);
        // earned() should still be > 0 — at least the pre-expiry accrual is reachable.
        assertGt(earnedAfterExpiry, 0, "earned() still reports pre-expiry rewards post-expiry");

        // Now Bob withdraws — he MUST receive pre-expiry rewards + principal.
        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.withdraw(bobTid);
        uint256 balAfter = token.balanceOf(bob);
        uint256 received = balAfter - balBefore;

        // Bob must receive STRICTLY MORE than just principal.
        assertGt(received, 500_000 ether, "DS-01 fix: rewards paid alongside principal");
        // The reward portion must roughly match earnedAfterExpiry (within a couple seconds drift).
        uint256 rewardPortion = received - 500_000 ether;
        assertGt(rewardPortion, 0, "non-zero reward paid on post-expiry withdraw");
    }

    // ─── DS-02 (High) — kick settles pre-expiry rewards into unsettled ──

    /// @notice DS-02 regression: kicking an expired position MUST credit the
    ///         holder's pre-expiry rewards into `unsettledRewards[holder]` (or
    ///         pay them out via _getReward) BEFORE decay zeros boostedAmount.
    ///         Pre-fix, kick ran decay directly and the holder's pre-expiry
    ///         yield was permanently unreachable.
    /// @dev    BATCH-J2 H8: kick now reverts `KickWouldForfeit` if any portion
    ///         of pending rewards would not fit in the unsettledRewards cap.
    ///         Stake sized so accrued rewards stay under 100_000e18 cap; that
    ///         lets the kick succeed and we can assert unsettled was credited.
    function test_kick_settlesPreExpiryRewardsToUnsettled() public {
        vm.warp(1000);
        vm.prank(alice);
        staking.stake(50_000 ether, 7 days);
        vm.prank(bob);
        staking.stake(50_000 ether, 365 days); // keep totalBoostedStake non-zero post-decay

        uint256 aliceTid = staking.userTokenId(alice);

        // Some pre-expiry reward accrual.
        vm.warp(block.timestamp + 5 days);
        uint256 earnedBeforeKick = monitor.earned(aliceTid);
        assertGt(earnedBeforeKick, 0, "alice has pending pre-expiry rewards");

        // Advance past lockEnd.
        vm.warp(1000 + 7 days + 1);

        // Kick alice — expect pre-expiry rewards to land in unsettled, NOT lost.
        uint256 unsettledBefore = staking.unsettledRewards(alice);
        vm.prank(kicker);
        staking.kick(aliceTid);
        uint256 unsettledAfter = staking.unsettledRewards(alice);

        assertGt(unsettledAfter, unsettledBefore, "DS-02 fix: pre-expiry rewards routed to unsettled");
        // boostedAmount must now be zero (the decay still runs after settle).
        (, uint256 boostedAfter, , , , , , , , , ) = staking.positions(aliceTid);
        assertEq(boostedAfter, 0, "decay still runs after settle");

        // Alice can claim the unsettled rewards.
        uint256 aliceBalBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimUnsettled();
        assertGt(token.balanceOf(alice), aliceBalBefore, "alice reclaims pre-expiry rewards");
    }

    // ─── DS-07 (Low) — kick rejects no-op token IDs ──────────────────────

    function test_kick_revertsOnPhantomTokenId() public {
        vm.expectRevert(TegridyStaking.NoPosition.selector);
        vm.prank(kicker);
        staking.kick(99999); // never-minted
    }

    function test_kick_revertsOnUnexpiredLock() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 365 days);
        uint256 tid = staking.userTokenId(alice);

        vm.expectRevert(TegridyStaking.NoOpKick.selector);
        vm.prank(kicker);
        staking.kick(tid);
    }

    function test_kick_revertsOnAlreadyDecayed() public {
        // BATCH-J2 H8: smaller stake so accrued rewards fit unsettled cap and
        // kick succeeds the first time (otherwise it reverts KickWouldForfeit
        // and we never reach the second-kick NoOpKick assertion).
        vm.warp(1000);
        vm.prank(alice);
        staking.stake(50_000 ether, 7 days);
        vm.prank(bob);
        staking.stake(50_000 ether, 365 days);
        uint256 aliceTid = staking.userTokenId(alice);

        vm.warp(1000 + 7 days + 1);
        vm.prank(kicker);
        staking.kick(aliceTid);

        // Second kick: now boostedAmount == 0, must revert NoOpKick.
        vm.expectRevert(TegridyStaking.NoOpKick.selector);
        vm.prank(kicker);
        staking.kick(aliceTid);
    }

    // ─── DS-03 (High) — kick blocked while paused ──────────────────────

    function test_kick_revertsWhenPaused() public {
        vm.warp(1000);
        vm.prank(alice);
        staking.stake(500_000 ether, 7 days);
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);
        uint256 aliceTid = staking.userTokenId(alice);

        vm.warp(1000 + 7 days + 1);

        staking.pause();

        vm.expectRevert(); // EnforcedPause from OZ Pausable
        vm.prank(kicker);
        staking.kick(aliceTid);
    }

    // ─── DS-05 (Medium) — notifyRewardAmount blocked while paused ──────

    function test_notifyRewardAmount_revertsWhenPaused() public {
        staking.pause();
        vm.expectRevert();
        staking.notifyRewardAmount(1_000_000 ether);
    }

    // ─── DS-06 (Medium) — extendLock rejects expired position ──────────

    function test_extendLock_revertsOnExpiredPosition() public {
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);
        uint256 tid = staking.userTokenId(bob);

        vm.warp(1000 + 30 days + 1);

        vm.expectRevert(TegridyStaking.LockExpired.selector);
        vm.prank(bob);
        staking.extendLock(tid, 365 days);
    }

    // ─── DS-10 (Low) — applyLendingContract revoke blocked while NFT escrowed ──

    function test_applyLendingContract_revokeRevertsWhenNFTHeld() public {
        // Use absolute timestamps to avoid expression-ordering ambiguity.
        uint256 t0 = 1_000_000;
        vm.warp(t0);

        // Approve Bob as a lending contract first.
        admin.proposeLendingContract(bob, true);
        vm.warp(t0 + 48 hours + 1);
        admin.executeLendingContract();

        // Bob stakes (so the lending "contract" address Bob holds an NFT).
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);

        // Now try to revoke via admin — must revert because Bob (lending) holds an NFT.
        uint256 t1 = t0 + 48 hours + 2;
        vm.warp(t1);
        admin.proposeLendingContract(bob, false);
        vm.warp(t1 + 48 hours + 1);
        vm.expectRevert(TegridyStaking.PendingLendingPositions.selector);
        admin.executeLendingContract();
    }

    // ─── DS-12 (Low) — setStakingAdmin rejects EOA ───────────────────────

    function test_setStakingAdmin_revertsOnEOA() public {
        // Fresh staking instance (admin not yet set).
        TegridyStaking fresh = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        vm.expectRevert(TegridyStaking.NotAContract.selector);
        fresh.setStakingAdmin(alice); // alice is an EOA
    }

    // ─── DS-13 (Low) — _clearPosition preserves userTokenId for multi-NFT holders ──

    /// @notice DS-13: when the holder still owns OTHER staking NFTs after a clear,
    ///         `userTokenId[holder]` must re-point at one of them — not stay zero.
    /// @dev    Uses a contract holder + transferFrom to seed two positions on the
    ///         same address (EOA single-position guard does not apply to contracts).
    function test_clearPosition_repointsLegacyPointerForMultiPositionHolder() public {
        // Use absolute timestamps to avoid block.timestamp/expression ordering
        // confusion under forge's tracing of vm.warp.
        uint256 t0 = 1_000_000;
        vm.warp(t0);

        // Bob stakes at t0.
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);
        uint256 tidBob = staking.userTokenId(bob);

        MultiHolder holder = new MultiHolder(staking, token);

        // Bob transfers his NFT to the holder (past transfer cooldown).
        uint256 t1 = t0 + 24 hours + 1;
        vm.warp(t1);
        vm.prank(bob);
        staking.safeTransferFrom(bob, address(holder), tidBob);

        // Alice stakes 1 hour later.
        uint256 t2 = t1 + 1 hours;
        vm.warp(t2);
        vm.prank(alice);
        staking.stake(500_000 ether, 30 days);
        uint256 tidAlice = staking.userTokenId(alice);

        // Alice transfers to the holder past her own cooldown.
        uint256 t3 = t2 + 24 hours + 1;
        vm.warp(t3);
        vm.prank(alice);
        staking.safeTransferFrom(alice, address(holder), tidAlice);

        // Holder now owns 2 staking NFTs; userTokenId points at the most-recent.
        assertEq(staking.balanceOf(address(holder)), 2, "holder owns two positions");
        uint256 latest = staking.userTokenId(address(holder));
        assertTrue(latest == tidBob || latest == tidAlice);

        // Advance past lockEnd of both (longest is Alice's at t2 + 30 days).
        vm.warp(t2 + 30 days + 1);

        // Holder withdraws ONE position. Pointer must re-point at the other.
        holder.withdraw(latest);
        uint256 newPointer = staking.userTokenId(address(holder));
        assertGt(newPointer, 0, "DS-13 fix: pointer re-pointed to remaining position");
        assertEq(staking.balanceOf(address(holder)), 1, "one position remains");
    }
}

/// @notice Minimal contract holder used by DS-13 test.
contract MultiHolder is IERC721Receiver {
    TegridyStaking public immutable staking;
    IERC20 public immutable token;
    constructor(TegridyStaking _s, IERC20 _t) { staking = _s; token = _t; }
    function withdraw(uint256 tokenId) external { staking.withdraw(tokenId); }
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
