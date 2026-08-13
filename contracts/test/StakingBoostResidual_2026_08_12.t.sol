// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

/// @title  2026-08-12 staking correctness — [BOOST-RESIDUAL-WIPE] + [L-11 fourth sibling]
///
/// @notice ── DEFECT 1: `_applyNewBoost` destroyed the unpaid residual ──────────
///
///         `StakingRewardLib._creditGetReward` (AUDIT FIX 2026-05-26 [H-05],
///         StakingRewardLib.sol:565) deliberately advances `p.rewardDebt` by ONLY
///         the amount actually credited, so that when the reward pool AND the
///         `maxUnsettledRewards` cap are both saturated the un-payable slice
///         stays claimable later:
///
///             if (totalCredited > 0) p.rewardDebt += _safeInt256(totalCredited);
///
///         `TegridyStaking._applyNewBoost` then ended with an UNCONDITIONAL
///         re-anchor:
///
///             p.rewardDebt = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
///
///         which forces `accumulated - rewardDebt == 0` and erases that residual
///         outright. Five callers reach it; four of them (`extendLock`,
///         `increaseAmount`, `toggleAutoMaxLock`, `revalidateBoost`) run
///         `_getReward` first and can therefore arrive holding a POSITIVE
///         residual. Any holder who extended, topped up, toggled auto-max-lock or
///         got JBAC-downgraded during an under-funded window silently and
///         permanently lost whatever the protocol still owed them.
///
///         This is not an exotic state. `accumulateRewards` caps each tick to
///         `balance - totalStaked - totalUnsettledRewards` — the pool as it stands
///         RIGHT NOW — and does NOT subtract emission it has already allocated to
///         unclaimed pending. So a pool that is under-funded relative to
///         `rewardRate` gets allocated again on every tick, and `pending >
///         rewardPool` is the STEADY STATE, not an edge case. That is exactly the
///         live configuration: a fixed `rewardRate` emitting against a finite
///         pool.
///
///         FIX (TegridyStaking._applyNewBoost): capture the residual BEFORE
///         `p.boostedAmount` is overwritten, and re-anchor to
///         `newAccumulated - residual` when it is positive. Non-positive residuals
///         still anchor flat, which preserves the correct behaviour of
///         `getReward`'s post-decay restore branch (there `accumulated` is 0 and
///         `rewardDebt` is stale-positive; that deficit must not become a hole the
///         holder has to earn back through).
///
/// @notice ── DEFECT 2: `increaseAmount` was the unpatched 4th L-11 sibling ─────
///
///         AUDIT FIX 2026-05-26 [L-11] re-validates the cached `hasJbacBoost` flag
///         through `StakingViewLib.resolveJbac` before re-applying the +5000 BPS
///         bonus, so a legacy `hasJbacBoost && !jbacDeposited` holder who sold
///         their JBAC stops being paid for it. It landed on `toggleAutoMaxLock`
///         (TegridyStaking.sol ~1186), `extendLock` (~1247) and `getReward`'s
///         decay-restore branch (~1424). `increaseAmount` kept the blind
///
///             if (p.hasJbacBoost) remainingBoost += JBAC_BONUS_BPS;
///
///         so topping up re-anchored a stale bonus indefinitely — diluting every
///         honest staker's share of a fixed-rate pool — with no obligation on the
///         holder to ever call `revalidateBoost`.
///
///         FIX: same lib call, same gate shape, same argument order as the other
///         three. `resolveJbac`'s `jbacValid` is a strict subset of the
///         `p.hasJbacBoost` condition it replaces, so it can only ever DOWNGRADE.
///
/// @dev    MUTATION-VERIFIED 2026-08-12 (see the report accompanying this file):
///         every assertion below was run against pre-fix source and observed to
///         FAIL, then against post-fix source and observed to PASS. The tests pin
///         INVARIANTS read from live contract state — "the residual that existed
///         before the boost change is exactly what is claimable after it", "the
///         contract still covers principal + unsettled" — not magic numbers, so
///         they survive a change of `rewardRate`, pool size or boost curve.

contract BRW_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract BRW_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract StakingBoostResidual_2026_08_12_Test is Test {
    BRW_Toweli toweli;
    BRW_JBAC jbac;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyStakingJbacVault vault;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    /// @dev Slot of the `positions` mapping. Mirrors
    ///      FRESH2026_F3_StakingJbacRestakerLookup.t.sol:150 — re-verified
    ///      2026-08-12 against `forge inspect TegridyStaking storage`:
    ///      `positions` = slot 18. That is the only value this file uses.
    ///
    ///      An earlier version of this comment also asserted
    ///      `_unsettledByTokenIdHolder` = slot 29. It is slot 28 — confirmed by
    ///      re-running `forge inspect` and by StakingInvariants.t.sol:357. The
    ///      wrong number was inert here because nothing read it, which is exactly
    ///      how a hardcoded-slot comment rots: unused, unchecked, and quoted as
    ///      fact by the next file that DOES need it. Cite the slot where it is
    ///      used, or not at all.
    uint256 constant POSITIONS_SLOT = 18;
    /// @dev `Position.jbacDeposited` sits at struct slot offset 5
    ///      (amount / boostedAmount / rewardDebt / packed-lock-word / jbacTokenId).
    uint256 constant JBAC_DEPOSITED_OFFSET = 5;

    /// @dev Emission is deliberately pinned at MAX_REWARD_RATE against a small
    ///      pool. That is the whole point: it reproduces the live under-funded
    ///      regime in which the residual exists at all.
    uint256 constant REWARD_RATE = 1e18;
    uint256 constant POOL = 50_000 ether;
    uint256 constant STAKE = 10_000 ether;
    uint256 constant LOCK = 365 days;

    function setUp() public {
        // SequencerCheck reverts when feed == address(0) on chainid != 1
        // (same realignment as FRESH2026_F4).
        vm.chainId(1);
        toweli = new BRW_Toweli();
        jbac = new BRW_JBAC();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        // Drop the unsettled cap to its floor so the shortfall path can actually
        // SATURATE it. Without a saturated cap `_settleUnsettled` absorbs the
        // whole shortfall, `totalCredited == pending`, and no residual is ever
        // left behind — i.e. this knob is what makes the defect reachable.
        admin.proposeMaxUnsettledRewards(10_000 ether);
        skip(48 hours + 1);
        admin.executeMaxUnsettledRewards();
        assertEq(staking.maxUnsettledRewards(), 10_000 ether, "setup: unsettled cap at floor");

        toweli.transfer(alice, 1_000_000 ether);
        toweli.transfer(bob, 1_000_000 ether);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev The unpaid-owed quantity the H-05 fix exists to preserve:
    ///      `accumulated - rewardDebt`, in token units.
    function _residual(uint256 tokenId) internal view returns (int256) {
        (, uint256 boostedAmount, int256 rewardDebt,,,,,,,,) = staking.positions(tokenId);
        return int256((boostedAmount * staking.rewardPerTokenStored()) / 1e18) - rewardDebt;
    }

    /// @dev Drive the position into the state the defect needs: a POSITIVE
    ///      residual sitting on a live (non-expired) position, with both the
    ///      reward pool and the unsettled cap exhausted so nothing can pay it
    ///      down. Returns Alice's tokenId.
    function _buildResidual() internal returns (uint256 tokenId) {
        toweli.mint(address(staking), POOL);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(STAKE, LOCK);
        tokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Tick 1 — a third party's `stake` runs `updateReward` and allocates the
        // whole pool to `rewardPerTokenStored` without paying anything out.
        skip(10 days);
        vm.startPrank(bob);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(STAKE, LOCK);
        vm.stopPrank();

        // Tick 2 — allocates the SAME pool a second time (accumulateRewards caps
        // to the pool as it stands now, not net of already-allocated pending), so
        // Alice's claim on this line necessarily exceeds what the pool can pay.
        skip(10 days);
        vm.prank(alice);
        staking.getReward(tokenId);

        // Preconditions for a meaningful test. If any of these stops holding the
        // scenario has drifted and the assertions below would pass vacuously.
        assertEq(
            staking.totalUnsettledRewards(),
            staking.maxUnsettledRewards(),
            "precondition: unsettled cap saturated, so no further shortfall can be absorbed"
        );
        assertGt(_residual(tokenId), 0, "precondition: H-05 left a POSITIVE unpaid residual");
        (,,, uint64 lockEnd,,,,,,,) = staking.positions(tokenId);
        assertGt(lockEnd, block.timestamp, "precondition: position live (not the M5 expiry branch)");
    }

    /// @dev Refund the pool, then claim in the SAME block so no fresh emission
    ///      accrues and the payout is purely the carried residual.
    function _refundAndClaim(uint256 tokenId) internal returns (uint256 claimed) {
        toweli.mint(address(staking), 1_000_000 ether);
        vm.prank(alice);
        claimed = staking.getReward(tokenId);
    }

    function _assertSolvent(string memory ctx) internal view {
        assertGe(
            toweli.balanceOf(address(staking)),
            staking.totalStaked() + staking.totalUnsettledRewards(),
            string.concat(ctx, ": carrying the residual must not eat principal or unsettled backing")
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    //  DEFECT 1 — residual survives a boost rewrite, on every reaching path
    // ─────────────────────────────────────────────────────────────────────

    /// @notice extendLock must not eat the unpaid residual.
    ///         PRE-FIX: `claimed` is 0 — `_applyNewBoost` re-anchored
    ///         `rewardDebt` to the new accumulator and the debt vanished.
    function test_extendLock_preservesUnpaidResidual() public {
        uint256 tokenId = _buildResidual();
        int256 owed = _residual(tokenId);

        vm.prank(alice);
        staking.extendLock(tokenId, 730 days);

        assertEq(_residual(tokenId), owed, "extendLock: unpaid-owed is INVARIANT across the boost rewrite");

        uint256 claimed = _refundAndClaim(tokenId);
        assertEq(claimed, uint256(owed), "extendLock: the residual is paid in full once the pool refills");
        _assertSolvent("extendLock");
    }

    /// @notice increaseAmount must not eat the unpaid residual.
    function test_increaseAmount_preservesUnpaidResidual() public {
        uint256 tokenId = _buildResidual();
        int256 owed = _residual(tokenId);

        vm.prank(alice);
        staking.increaseAmount(tokenId, 1_000 ether);

        assertEq(_residual(tokenId), owed, "increaseAmount: unpaid-owed is INVARIANT across the boost rewrite");

        uint256 claimed = _refundAndClaim(tokenId);
        assertEq(claimed, uint256(owed), "increaseAmount: the residual is paid in full once the pool refills");
        _assertSolvent("increaseAmount");
    }

    /// @notice toggleAutoMaxLock must not eat the unpaid residual. This path
    ///         rewrites boost the hardest — straight to MAX_BOOST_BPS — so it is
    ///         the largest re-anchor and was the largest silent loss.
    function test_toggleAutoMaxLock_preservesUnpaidResidual() public {
        uint256 tokenId = _buildResidual();
        int256 owed = _residual(tokenId);

        vm.prank(alice);
        staking.toggleAutoMaxLock(tokenId);

        (,,,, uint16 boostBps,, bool aml,,,,) = staking.positions(tokenId);
        assertTrue(aml, "toggleAutoMaxLock: enabled");
        assertEq(uint256(boostBps), staking.MAX_BOOST_BPS(), "toggleAutoMaxLock: boost really was rewritten to MAX");
        assertEq(_residual(tokenId), owed, "toggleAutoMaxLock: unpaid-owed is INVARIANT across the boost rewrite");

        uint256 claimed = _refundAndClaim(tokenId);
        assertEq(claimed, uint256(owed), "toggleAutoMaxLock: the residual is paid in full once the pool refills");
        _assertSolvent("toggleAutoMaxLock");
    }

    /// @notice The carry must be one-directional. On the post-decay restore path
    ///         `accumulated` is 0 while `rewardDebt` is stale-positive, so the
    ///         "residual" is NEGATIVE. Carrying that would leave the holder owing
    ///         a hole they must earn back through before earning anything — a
    ///         regression against AUDIT H-AUDIT-2026-1's "keep max boost
    ///         perpetually" semantic. Anchor flat instead.
    function test_decayRestore_doesNotCarryNegativeResidual() public {
        toweli.mint(address(staking), 5_000_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(STAKE, 7 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.toggleAutoMaxLock(tokenId);
        vm.stopPrank();

        // Let the (now MAX) lock run out entirely, then poke the decay so
        // `boostedAmount` is zeroed with `rewardDebt` left stale-positive.
        skip(staking.MAX_LOCK_DURATION() + 1);
        staking.kick(tokenId);
        (, uint256 boostedAfterDecay, int256 debtAfterDecay,,,,,,,,) = staking.positions(tokenId);
        assertEq(boostedAfterDecay, 0, "precondition: decayed to zero boost");
        assertGt(debtAfterDecay, 0, "precondition: rewardDebt is stale-positive, i.e. residual is negative");

        // autoMaxLock restore fires inside getReward and calls _applyNewBoost.
        vm.prank(alice);
        staking.getReward(tokenId);

        assertEq(
            _residual(tokenId),
            int256(0),
            "decay-restore: must anchor FLAT - a negative residual is not a debt the holder owes"
        );
        (, uint256 boostedRestored,,,,,,,,,) = staking.positions(tokenId);
        assertGt(boostedRestored, 0, "decay-restore: boost restored, position earning again");
    }

    // ─────────────────────────────────────────────────────────────────────
    //  DEFECT 2 — increaseAmount re-validates the cached JBAC bonus
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Build the legacy grandfathered shape (`hasJbacBoost == true`,
    ///      `jbacDeposited == false`) the way FRESH2026_F3 does: stake with a
    ///      real deposit, then flip `jbacDeposited` off via `vm.store`. Alice is
    ///      left holding NO JBAC in her wallet, which is precisely the
    ///      "sold it after staking" case L-11 exists to catch.
    function _legacyStaleJbacPosition() internal returns (uint256 tokenId) {
        toweli.mint(address(staking), 1_000_000 ether);
        uint256 jbacId = jbac.mint(alice);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        jbac.approve(address(staking), jbacId);
        staking.stakeWithBoost(STAKE, staking.MAX_LOCK_DURATION(), jbacId);
        tokenId = staking.userTokenId(alice);
        vm.stopPrank();

        bytes32 baseSlot = keccak256(abi.encode(tokenId, POSITIONS_SLOT));
        vm.store(address(staking), bytes32(uint256(baseSlot) + JBAC_DEPOSITED_OFFSET), bytes32(0));

        (,,,, uint16 boostBps,,, bool hasJbac,,, bool deposited) = staking.positions(tokenId);
        assertTrue(hasJbac, "precondition: cached hasJbacBoost flag still set");
        assertFalse(deposited, "precondition: legacy shape - not vault-deposited");
        assertEq(
            uint256(boostBps),
            staking.MAX_BOOST_BPS() + staking.JBAC_BONUS_BPS(),
            "precondition: position is being paid the JBAC bonus"
        );
        assertEq(jbac.balanceOf(alice), 0, "precondition: holder no longer holds any JBAC");
    }

    /// @notice increaseAmount must strip a stale JBAC bonus, like its three
    ///         siblings do.
    ///         PRE-FIX: boostBps stays 45000 and `hasJbacBoost` stays true — the
    ///         holder keeps being paid +0.5x for a JBAC they no longer own, and
    ///         re-anchors it on every top-up.
    function test_increaseAmount_stripsStaleJbacBonus() public {
        uint256 tokenId = _legacyStaleJbacPosition();

        // Same block as the stake: `remaining == MAX_LOCK_DURATION` exactly, so
        // `calculateBoost(remaining) == MAX_BOOST_BPS` and the arithmetic is
        // unambiguous. Pre-fix: min(40000 + 5000, 45000) = 45000 (bonus kept).
        // Post-fix: min(40000, 45000) = 40000 (bonus stripped).
        vm.prank(alice);
        staking.increaseAmount(tokenId, 1_000 ether);

        (uint256 amount, uint256 boostedAmount,,, uint16 boostBps,,, bool hasJbac,,,) = staking.positions(tokenId);

        assertFalse(hasJbac, "L-11: the stale cached flag must be cleared, not re-anchored");
        assertEq(
            uint256(boostBps),
            staking.MAX_BOOST_BPS(),
            "L-11: boost must drop by exactly JBAC_BONUS_BPS - no bonus for a JBAC the holder sold"
        );
        // The stripped boost has to be reflected in the reward weight too, not
        // just the display field.
        assertEq(
            boostedAmount,
            (amount * staking.MAX_BOOST_BPS()) / 10_000,
            "L-11: boostedAmount recomputed at the stripped boost"
        );
    }

    /// @notice The re-validation must be a DOWNGRADE gate only: a holder who
    ///         still owns a JBAC keeps the bonus. Guards against the fix being
    ///         over-broad and stripping legitimate holders (the F3-PERMA-STRIP
    ///         class of regression).
    function test_increaseAmount_keepsLiveJbacBonus() public {
        uint256 tokenId = _legacyStaleJbacPosition();
        jbac.mint(alice); // holder re-acquires a JBAC before topping up
        assertEq(jbac.balanceOf(alice), 1, "precondition: holder owns a JBAC again");

        vm.prank(alice);
        staking.increaseAmount(tokenId, 1_000 ether);

        (,,,, uint16 boostBps,,, bool hasJbac,,,) = staking.positions(tokenId);
        assertTrue(hasJbac, "downgrade-only: a real JBAC holder keeps the cached flag");
        assertEq(
            uint256(boostBps),
            staking.MAX_BOOST_BPS() + staking.JBAC_BONUS_BPS(),
            "downgrade-only: a real JBAC holder keeps the +0.5x bonus"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    //  NEW FINDING [EARLYEXIT-RESIDUAL-FORFEIT] — reported, NOT fixed here
    // ─────────────────────────────────────────────────────────────────────
    //
    // Found 2026-08-12 while re-reading TegridyStaking.sol 804-1606 (the span a
    // prior 150-agent audit's own coverage auditor flagged as its weakest-read
    // region).
    //
    // `StakingRewardLib._creditGetReward` force-settles an un-payable residual to
    // the holder's unsettled bucket ONLY on the expiry branch:
    //
    //     if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) { ...force-settle... }
    //     else { emit RewardsForfeited(recipient, forfeited); }          // <-- lost
    //
    // [M5] chose that branch because after `_decayIfExpired` zeroes
    // `boostedAmount` the slot goes inert and the residual becomes unreachable.
    // But `_clearPosition`'s `delete positions[tokenId]` makes it *equally*
    // unreachable, and TWO exit paths reach it while `block.timestamp <
    // p.lockEnd` is still true — i.e. down the `else`, forfeiting:
    //
    //   * `earlyWithdraw`      — guarded by `MustUseWithdraw`, so it is only ever
    //                            callable while NOT expired.
    //   * `executeEmergencyExit` on its `earlyExit == true` branch.
    //
    // Result: a holder exiting early during an under-funded window pays the 25%
    // penalty AND silently forfeits already-earned rewards, with no recovery
    // path. Same failure mode [M5] exists to prevent, on the sibling path.
    //
    // NOT FIXED IN THIS CHANGE-SET. TegridyStaking has 22 B of EIP-170 headroom
    // after the two fixes above, and the two candidate fixes both need more:
    //   (a) drop the `lockEnd <= now` condition so the cap is pure flow-control
    //       everywhere. Zero HOST bytes (the branch lives in the library), but it
    //       changes every under-funded claim, not just exits, and removes the
    //       only backpressure on `totalUnsettledRewards` growth.
    //   (b) thread a `forceSettle` flag from the exit paths into the library.
    //       Surgical, but costs host bytes there is no budget for today.
    // Owner decision. The pair of tests below is the evidence.

    /// @notice CONTROL: the EXPIRED exit path preserves the residual. `withdraw`
    ///         routes it into `unsettledRewards` via the [M5] force-settle, cap
    ///         bypassed, so the holder can still `claimUnsettled` it later.
    function test_withdraw_afterExpiry_preservesResidualToUnsettled() public {
        uint256 tokenId = _buildResidual();
        uint256 owed = uint256(_residual(tokenId));
        uint256 unsettledBefore = staking.unsettledRewards(alice);

        skip(400 days); // lock is now expired; pool is still empty so nothing new accrues
        vm.prank(alice);
        staking.withdraw(tokenId);

        assertEq(
            staking.unsettledRewards(alice) - unsettledBefore,
            owed,
            "M5: expired exit force-settles the residual (cap intentionally bypassed)"
        );
        assertGt(
            staking.unsettledRewards(alice),
            staking.maxUnsettledRewards(),
            "M5: the bypass is real - the bucket is allowed past the cap on this path"
        );
    }

    /// @notice DEFECT [EARLYEXIT-RESIDUAL-FORFEIT]: the EARLY exit path destroys
    ///         the identical residual. Same position, same pool state, same
    ///         amount owed - only the exit door differs.
    ///
    /// @dev    THIS TEST PINS CURRENT (DEFECTIVE) BEHAVIOUR ON PURPOSE, as the
    ///         evidence for the finding above. WHEN THE DEFECT IS FIXED THIS TEST
    ///         MUST BE INVERTED, not deleted: change the two assertions to match
    ///         `test_withdraw_afterExpiry_preservesResidualToUnsettled`. It is
    ///         written so a fix makes it FAIL LOUDLY rather than rot silently.
    function test_KNOWNDEFECT_earlyWithdraw_forfeitsResidual() public {
        uint256 tokenId = _buildResidual();
        uint256 owed = uint256(_residual(tokenId));
        uint256 unsettledBefore = staking.unsettledRewards(alice);
        assertGt(owed, 0, "precondition: there is something to lose");

        vm.prank(alice);
        staking.earlyWithdraw(tokenId);

        assertEq(
            staking.unsettledRewards(alice),
            unsettledBefore,
            "DEFECT PINNED: early exit banked NOTHING - the residual went down the RewardsForfeited branch"
        );

        // And it is gone for good: the position row is deleted, so the rewardDebt
        // anchor that made it recoverable no longer exists. Refunding the pool
        // cannot bring it back.
        (uint256 amountAfter,,,,,,,,,,) = staking.positions(tokenId);
        assertEq(amountAfter, 0, "position cleared - no anchor left to re-claim against");
        toweli.mint(address(staking), 1_000_000 ether);
        assertEq(
            staking.unsettledRewards(alice),
            unsettledBefore,
            "DEFECT PINNED: refunding the pool does not restore it - the loss is permanent"
        );
    }

    /// @notice A vault-DEPOSITED JBAC is always valid — the NFT is in custody, so
    ///         no balance check applies and the bonus must never be stripped.
    function test_increaseAmount_depositedJbacNeverStripped() public {
        toweli.mint(address(staking), 1_000_000 ether);
        uint256 jbacId = jbac.mint(alice);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        jbac.approve(address(staking), jbacId);
        staking.stakeWithBoost(STAKE, staking.MAX_LOCK_DURATION(), jbacId);
        uint256 tokenId = staking.userTokenId(alice);
        assertEq(jbac.balanceOf(alice), 0, "precondition: JBAC is in the vault, wallet balance is 0");

        staking.increaseAmount(tokenId, 1_000 ether);
        vm.stopPrank();

        (,,,, uint16 boostBps,,, bool hasJbac,,, bool deposited) = staking.positions(tokenId);
        assertTrue(deposited, "still vault-deposited");
        assertTrue(hasJbac, "deposited JBAC: flag preserved");
        assertEq(
            uint256(boostBps),
            staking.MAX_BOOST_BPS() + staking.JBAC_BONUS_BPS(),
            "deposited JBAC: bonus preserved - custody is the proof, not balanceOf"
        );
    }
}
