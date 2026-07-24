// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";

/// @title FRESH-2026 F4 — TegridyStaking.increaseAmount autoMaxLock ordering
/// @notice POST-FIX REGRESSION (commit ad0042e).
///
///         BUG (pre-fix):
///         `increaseAmount` computed the boost clamp from `remaining =
///         lockEnd - block.timestamp` BEFORE extending `lockEnd` to
///         `now + MAX_LOCK_DURATION` for autoMaxLock users. So a user
///         who didn't refresh `getReward` recently had `remaining` <
///         MAX_LOCK_DURATION, `remainingBoost = calculateBoost(remaining)`
///         < MAX_BOOST_BPS, and `effectiveBoost = min(remainingBoost,
///         cachedBoost) = remainingBoost`. The user's `boostBps` was
///         silently downgraded from 4.0x (MAX_BOOST_BPS=40000) to the
///         linearly-interpolated value for the decayed remaining time
///         (e.g. ~22000 for 2y remaining), even though the position is
///         autoMaxLock and the lockEnd was just refreshed to MAX in the
///         very same call. Recovery required either:
///           (a) `toggleAutoMaxLock` off→on (pays `extendFeeBps` on full
///               position), OR
///           (b) waiting for the position to fully decay so `getReward`'s
///               `boostedAmount == 0` decay-restore branch could rebuild
///               from scratch (locks the user out of claims until then).
///
///         FIX (TegridyStaking.sol:961-986):
///         Swap the order — extend lockEnd FIRST for autoMaxLock users,
///         then compute `remaining`/`remainingBoost`/`effectiveBoost`
///         against the new MAX horizon. Mirrors the canonical pattern in
///         `extendLock` (line 927 updates lockEnd before line 929 derives
///         the new boost).
///
///         POST-FIX VALIDATION (this test):
///         (1) Alice stakes 10k TOWELI for MAX_LOCK_DURATION (4y).
///             boostBps = MAX_BOOST_BPS = 40000.
///         (2) Enable autoMaxLock.
///         (3) Skip 2 years WITHOUT calling getReward. lockEnd is now
///             effectively ~2y away; the user has not refreshed.
///         (4) Alice calls `increaseAmount(500e18)`.
///         (5) Assert:
///             - p.boostBps == MAX_BOOST_BPS (40000) — no silent downgrade
///             - p.lockEnd ≈ block.timestamp + MAX_LOCK_DURATION — extended
///             - p.lockDuration == MAX_LOCK_DURATION — kept in lockstep
///         Pre-fix, p.boostBps would be ~22000 (`calculateBoost(2y)`).

contract F4_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract F4_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract FRESH2026_F4_StakingIncreaseAutoMaxLockOrderTest is Test {
    F4_Toweli toweli;
    F4_JBAC jbac;
    TegridyStaking staking;
    // EIP-170 golf (2026-07-23): lock/boost bounds re-exposed on the sibling.
    StakingMonitorView monitor;
    TegridyStakingAdmin admin;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    uint256 aliceTokenId;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        toweli = new F4_Toweli();
        jbac = new F4_JBAC();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        // Fund staking with reward token + notify so rewardPerTokenStored ticks.
        toweli.mint(address(staking), 10_000_000 ether);
        toweli.approve(address(staking), 1_000_000 ether);
        staking.notifyRewardAmount(1_000_000 ether);

        toweli.transfer(alice, 1_000_000 ether);
    }

    /// @notice POST-FIX REGRESSION: increaseAmount with autoMaxLock no
    ///         longer silently downgrades the boost when the user hasn't
    ///         refreshed `getReward` recently.
    function test_F4_increaseAmount_autoMaxLock_preserves_MAX_boost() public {
        // ── PHASE 1: Alice stakes 10k TOWELI for MAX_LOCK_DURATION (4y). ──
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, monitor.MAX_LOCK_DURATION());
        aliceTokenId = staking.userTokenId(alice);
        staking.toggleAutoMaxLock(aliceTokenId);
        vm.stopPrank();

        // Sanity: max-lock + autoMaxLock = MAX_BOOST_BPS (40000) (no JBAC).
        (
            ,, , uint64 lockEnd0,
            uint16 boostBps0, , bool autoMaxLock0, ,
            , ,
        ) = staking.positions(aliceTokenId);
        assertEq(boostBps0, monitor.MAX_BOOST_BPS(), "phase 1: MAX_BOOST_BPS at fresh max-lock");
        assertTrue(autoMaxLock0, "phase 1: autoMaxLock enabled");
        emit log_named_uint("phase 1 boostBps", boostBps0);
        emit log_named_uint("phase 1 lockEnd", lockEnd0);

        // ── PHASE 2: Skip 2 years WITHOUT touching getReward. ──────────
        // Real-world reachable: a user who set-and-forgot autoMaxLock.
        // lockEnd was set at PHASE 1 stake; we skip 2y so `remaining =
        // lockEnd - block.timestamp` is now ~MAX/2 — the boost clamp
        // would silently downgrade pre-fix.
        skip(2 * 365 days);

        // ── PHASE 3: Alice tops up via increaseAmount. ─────────────────
        // Pre-fix: boost clamp computes `remaining` against the
        // pre-extend lockEnd (~2y), `remainingBoost = calculateBoost(2y)`
        // ≈ MIN + range/2 ≈ 22000. `effectiveBoost = min(22000, 40000) =
        // 22000`. `_applyNewBoost(p, 22000)` silently downgrades. lockEnd
        // is then extended to MAX afterward — too late for the boost.
        // Post-fix: lockEnd extended FIRST, so `remaining = MAX_LOCK_DURATION`,
        // `remainingBoost = MAX_BOOST_BPS`, `effectiveBoost = MAX_BOOST_BPS`.
        vm.prank(alice);
        staking.increaseAmount(aliceTokenId, 500 ether);

        // ── PHASE 4: POST-FIX assertions. ──────────────────────────────
        (
            uint256 amountAfter,, , uint64 lockEndAfter,
            uint16 boostBpsAfter,
            uint32 lockDurationAfter,
            bool autoMaxLockAfter, ,
            , ,
        ) = staking.positions(aliceTokenId);

        assertEq(amountAfter, 10_000 ether + 500 ether, "amount: original + top-up");
        assertTrue(autoMaxLockAfter, "autoMaxLock preserved");

        // The headline assertion: boost is still MAX, not silently downgraded.
        assertEq(
            boostBpsAfter,
            monitor.MAX_BOOST_BPS(),
            "FIX: boostBps preserved at MAX_BOOST_BPS (pre-fix would be ~22000)"
        );

        // The lockEnd was extended to MAX in the same call.
        assertApproxEqAbs(
            lockEndAfter,
            block.timestamp + monitor.MAX_LOCK_DURATION(),
            5, // tolerance for 1-block drift between extends
            "lockEnd extended to now + MAX_LOCK_DURATION"
        );

        // The lockDuration is kept in lockstep with lockEnd.
        assertEq(
            lockDurationAfter,
            uint32(monitor.MAX_LOCK_DURATION()),
            "lockDuration == MAX_LOCK_DURATION"
        );

        emit log_named_uint("post-fix boostBps", boostBpsAfter);
        emit log_named_uint("post-fix lockEnd", lockEndAfter);
        emit log_named_uint("post-fix lockDuration", lockDurationAfter);
        emit log_string("F4 FIX VALIDATED: autoMaxLock + increaseAmount preserves MAX boost");
    }
}
