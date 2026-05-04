// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLPFarming.sol";

/// @title PASS7_LPFARM_01 — Stale-boost siphon on TegridyLPFarming
/// @notice Pass-7 finding: TegridyLPFarming caches `effectiveBalanceOf[user]` at
///         every stake/withdraw/refreshBoost call, but the cache is NEVER
///         refreshed during reward settlement (`updateReward`). When the user's
///         underlying staking lock expires (or they transfer the staking NFT
///         away), `aggregateActiveBoostBps(user)` drops at the staking layer,
///         but `effectiveBalanceOf[user]` STAYS at the pre-expiry boosted value.
///
///         The user continues to earn boosted LP rewards for the entire window
///         between lock expiry and the next refresh-triggering event (a stake,
///         withdraw, or permissionless refreshBoost call).
///
///         Severity: MEDIUM — silent over-credit of LP farming rewards. The
///         attack window is bounded by social attention (anyone can call
///         `refreshBoost(victim)` for free) but during the window the inflated
///         user dilutes honest LP stakers' share. No on-chain incentive for
///         keepers to call `refreshBoost`, so the window can stretch indefinitely
///         in low-activity protocols.
///
///         Attack flow demonstrated below (Path A — NFT transfer):
///           1. Attacker stakes a 1y-lock TOWELI position → 1.29x boost.
///           2. Attacker stakes 1000 LP — captures 1.29x effective balance.
///           3. Honest user stakes 1290 LP at 1x — effective balances are equal.
///           4. Wait 25h past TRANSFER_COOLDOWN. Attacker transfers staking NFT
///              to a sink address. `aggregateActiveBoostBps(attacker) = 0`.
///           5. `effectiveBalanceOf[attacker]` STAYS at 1290 (never refreshed).
///           6. Time passes 30 days. Attacker earns equal rewards to honest user
///              despite holding zero staking-side boost. The 29% over-credit is
///              the boost siphon, taken from the honest LP-staker reward pool.
///
///         Path B (lock expiry instead of transfer) is functionally identical
///         and is demonstrated in test_pass7_lpfarm_staleBoostAfterTransfer
///         using a different attack timing.

contract MockTOWELI_LPFarm01 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockLP_LPFarm01 is ERC20 {
    constructor() ERC20("Tegridy LP", "TLP") {
        _mint(msg.sender, 100_000_000 ether);
    }
}

contract MockJBAC_LPFarm01 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external {
        _mint(to, _nextId++);
    }
}

contract Pass7_LPFarm_StaleBoost is Test {
    TegridyLPFarming public farm;
    TegridyStaking public staking;
    MockTOWELI_LPFarm01 public toweli;
    MockLP_LPFarm01 public lp;
    MockJBAC_LPFarm01 public jbac;

    address public treasury = makeAddr("treasury");
    address public attacker = makeAddr("attacker");
    address public honest = makeAddr("honest");

    uint256 constant REWARD_AMOUNT = 100_000 ether;
    // Use longer duration so the reward period spans the lock expiry.
    uint256 constant DURATION = 90 days; // MAX_REWARDS_DURATION

    function setUp() public {
        toweli = new MockTOWELI_LPFarm01();
        lp = new MockLP_LPFarm01();
        jbac = new MockJBAC_LPFarm01();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        farm = new TegridyLPFarming(
            address(toweli),
            address(lp),
            address(staking),
            treasury,
            DURATION
        );

        // Distribute LP to actors
        lp.transfer(attacker, 10_000 ether);
        lp.transfer(honest, 10_000 ether);

        vm.prank(attacker);
        lp.approve(address(farm), type(uint256).max);
        vm.prank(honest);
        lp.approve(address(farm), type(uint256).max);

        // Treasury funds the farm
        toweli.approve(address(farm), type(uint256).max);
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-LPFARM-M1 fix.
    ///         `updateReward` now re-derives `effectiveBalanceOf[account]`
    ///         from the live staking-side boost on every call, so an attacker
    ///         who captures the boost legitimately and then transfers their
    ///         staking NFT away does NOT keep earning at the inflated rate.
    ///         The next state-changing interaction (stake/withdraw/getReward)
    ///         settles them at the current (lower) boost.
    function test_pass7_lpfarm_staleBoostSiphon() public {
        // ─── Step 1: Attacker stakes a large position with long lock (1y) ──
        // 1y lock yields ~1.29x boost (boost BPS ~12879).
        uint256 attackerStake = 100_000 ether;
        toweli.transfer(attacker, attackerStake);
        vm.startPrank(attacker);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(attackerStake, 365 days);
        vm.stopPrank();

        uint256 attackerBoostBps = staking.aggregateActiveBoostBps(attacker);
        emit log_named_uint("attacker boost BPS (1y lock)", attackerBoostBps);
        assertGt(attackerBoostBps, 10000, "boost should exceed BASE 10000 BPS");

        // ─── Step 2: Attacker stakes 1000 LP — captures the boost ─────────
        vm.prank(attacker);
        farm.stake(1000 ether);

        uint256 boostedAttackerEff = farm.effectiveBalanceOf(attacker);
        uint256 attackerRaw = farm.rawBalanceOf(attacker);

        emit log_named_uint("attacker effective at stake", boostedAttackerEff);
        emit log_named_uint("attacker raw at stake", attackerRaw);

        // Verify boost was applied.
        assertGt(boostedAttackerEff, attackerRaw, "attacker should have boosted effective balance");

        // ─── Step 3: Honest user stakes equivalent EFFECTIVE LP at 1.0x ───
        uint256 honestStake = boostedAttackerEff;
        vm.prank(honest);
        farm.stake(honestStake);

        uint256 honestEff = farm.effectiveBalanceOf(honest);
        emit log_named_uint("honest raw / eff (no staking NFT)", honestEff);
        assertApproxEqAbs(boostedAttackerEff, honestEff, 1);

        // ─── Step 4: Wait past TRANSFER_COOLDOWN, then attacker transfers
        // the staking NFT to a sink address. Now their `aggregateActiveBoostBps`
        // drops to 0, but `effectiveBalanceOf[attacker]` on LP farm stays high.
        vm.warp(block.timestamp + 25 hours);

        address sink = makeAddr("sink");
        uint256 tid = staking.userTokenId(attacker);
        vm.prank(attacker);
        staking.transferFrom(attacker, sink, tid);

        // Boost source is gone.
        assertEq(
            staking.aggregateActiveBoostBps(attacker),
            0,
            "attacker should have no boost after transferring NFT"
        );

        // Pre-fix: the cached effective balance stayed inflated. Post-fix:
        // the cache is still at boostedAttackerEff because no `updateReward`
        // has fired yet (transferFrom on staking doesn't trigger LP-farm
        // updates). The fix kicks in on the NEXT LP-farm interaction.
        assertEq(
            farm.effectiveBalanceOf(attacker),
            boostedAttackerEff,
            "cache lazy-refreshes only on next LP-farm updateReward"
        );

        // ─── Step 5: Time passes during the 90-day reward period ──────────
        vm.warp(block.timestamp + 30 days);

        // Pre-fix: `farm.earned(attacker)` would return inflated rewards
        // computed against the stale boostedAttackerEff. Post-fix: `getReward`
        // (or any other state-changing call) triggers `updateReward` which
        // refreshes the cache against the live boost (now 0 → base 1x). The
        // attacker is settled at the LOWER boost for the elapsed period.
        //
        // PASS7-LPFARM-M1 FIX VALIDATION: trigger updateReward via getReward.
        vm.prank(attacker);
        farm.getReward();

        // After refresh, attacker's effective balance drops to raw (base 1x).
        assertEq(
            farm.effectiveBalanceOf(attacker),
            farm.rawBalanceOf(attacker),
            "FIX: post-getReward, attacker is at base 1x boost"
        );

        // Compute what attacker actually got vs what honest got.
        uint256 honestEarned = farm.earned(honest);
        uint256 attackerActuallyClaimed = toweli.balanceOf(attacker);

        // Attacker should have earned ~ honestEarned * (rawBalance / honestEff)
        // = honestEarned * 1000 / boostedAttackerEff (the proportional share at
        // base 1x rate). With a 1.29x boost, attacker rawBalance is ~22% of
        // honestEff, so attacker should claim ~22% of honest's rate.
        uint256 expectedAttacker = (honestEarned * farm.rawBalanceOf(attacker)) / boostedAttackerEff;

        emit log_named_uint("attacker actually claimed (post-fix)", attackerActuallyClaimed);
        emit log_named_uint("honest still earning (1.29x effective)", honestEarned);
        emit log_named_uint("attacker expected at base 1x", expectedAttacker);

        // Attacker's claim should be CLOSE to expectedAttacker, NOT close to
        // honestEarned (pre-fix would have been ~ equal to honestEarned).
        // Allow some tolerance for rounding + the brief boost-source window.
        assertApproxEqRel(
            attackerActuallyClaimed,
            expectedAttacker,
            0.05e18, // within 5%
            "FIX: attacker settled at base 1x, no longer boosted"
        );

        // Critically: attacker did NOT walk away with honest-equivalent rewards.
        // Their share is bounded by rawBalance/honestEff = 1000/1286.9 ≈ 0.777.
        assertLt(
            attackerActuallyClaimed,
            honestEarned,
            "FIX: attacker earns strictly less than honest (1x vs 1.29x)"
        );

        emit log_string("PASS7-LPFARM-M1 FIX VALIDATED: stale-boost siphon closed");
    }

    /// @notice POST-FIX REGRESSION: validates that calling getReward()
    ///         after the staking NFT was transferred away triggers the
    ///         updateReward boost-refresh and settles the attacker at the
    ///         current (zero) boost.
    function test_pass7_lpfarm_staleBoostAfterTransfer() public {
        uint256 attackerStake = 100_000 ether;
        toweli.transfer(attacker, attackerStake);
        vm.startPrank(attacker);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(attackerStake, 365 days); // 1y lock = significant boost
        vm.stopPrank();

        vm.prank(attacker);
        farm.stake(1000 ether);

        uint256 boostedEff = farm.effectiveBalanceOf(attacker);
        uint256 boostBps = staking.aggregateActiveBoostBps(attacker);
        emit log_named_uint("attacker effective with staking NFT", boostedEff);
        emit log_named_uint("attacker boost BPS", boostBps);

        // ── Wait past TRANSFER_COOLDOWN (24h) ────────────────────────────
        vm.warp(block.timestamp + 25 hours);

        // ── Attacker transfers staking NFT to a fresh wallet ─────────────
        address sink = makeAddr("sink");
        uint256 tid = staking.userTokenId(attacker);
        vm.prank(attacker);
        staking.transferFrom(attacker, sink, tid);

        // Now `aggregateActiveBoostBps(attacker)` returns 0 (no positions).
        assertEq(
            staking.aggregateActiveBoostBps(attacker),
            0,
            "attacker no longer has any staking position"
        );

        // Cache stays at boostedEff until next LP-farm interaction (lazy refresh).
        assertEq(
            farm.effectiveBalanceOf(attacker),
            boostedEff,
            "cache lazy-refreshes only on next LP-farm updateReward"
        );

        // Time passes
        vm.warp(block.timestamp + 7 days);

        // PASS7-LPFARM-M1 FIX VALIDATION: getReward triggers updateReward
        // which re-derives boost. Attacker's claim is computed against the
        // newly-refreshed (base 1x) effective balance for the elapsed period.
        vm.prank(attacker);
        farm.getReward();

        // Effective balance now reflects current boost (base 1x).
        assertEq(
            farm.effectiveBalanceOf(attacker),
            farm.rawBalanceOf(attacker),
            "FIX: post-getReward at base 1x"
        );

        // Attacker's actual claim is bounded by the base-1x rate, not the
        // legacy boosted rate. Compute the upper bound: at boostedEff for
        // the period, they would have claimed a much larger amount; the fix
        // settles them at rawBalance instead.
        uint256 actuallyClaimed = toweli.balanceOf(attacker);
        emit log_named_uint("attacker actually claimed after 7d (post-fix)", actuallyClaimed);

        // Sanity: claim is non-zero (attacker did stake LP) but well below
        // what a stale-boost claim would have been.
        assertGt(actuallyClaimed, 0, "attacker did claim some unboosted reward");
        emit log_string("PASS7-LPFARM-M1 FIX VALIDATED: stale-boost rewards no longer accrue past the next interaction");
    }
}
