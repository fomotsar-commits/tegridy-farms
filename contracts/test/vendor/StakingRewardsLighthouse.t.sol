// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {StakingRewards} from "../../src/vendor/synthetix-staking-rewards/StakingRewards.sol";

// The EVM lighthouse rail (WO-2): pins on the VENDORED Synthetix StakingRewards
// port. The provenance gate (D8) proves the code is canonical; these tests pin
// the PROPERTIES the island relies on, so a future deliberate re-pin that
// weakens one goes red here rather than shipping silently.
//
// The two pins that carry the plan's weight:
//  - ANTI-HOSTAGE: `withdraw()` moves principal only. The Solana lighthouse's
//    devnet-proven failure class (Streamflow 6012: while accrued > vault, claim
//    AND unstake-with-claim both revert, holding principal hostage) is
//    structurally impossible here - that is WHY this contract was chosen.
//  - SAME-TOKEN OVER-NOTIFY: the island stakes X to earn X, and the canonical
//    funding guard counts staked PRINCIPAL as fundable balance. An over-notify
//    therefore lets reward payouts spend other stakers' principal and strand
//    the last withdrawer. The contract stays verbatim (Rule 0); the funding
//    ceremony must bound `reward <= balanceOf(pool) - totalSupply()` - and the
//    hazard + the sufficiency of that bound are both stated here as tests.

contract IslandToken is ERC20 {
    constructor() ERC20("Island Token", "ISL") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract StakingRewardsLighthouseTest is Test {
    IslandToken token; //   same-token pools: stake ISL, earn ISL
    IslandToken other; //   distinct reward token, for the canonical-guard case
    StakingRewards pool; // stakingToken == rewardsToken == token
    address distribution = makeAddr("rewardsDistributionSafe");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant STAKE = 100e18;
    uint256 constant DURATION = 60 days; // canonical rewardsDuration, fixed

    function setUp() public {
        token = new IslandToken();
        other = new IslandToken();
        pool = new StakingRewards(distribution, address(token), address(token));
        token.mint(alice, STAKE);
        token.mint(bob, STAKE);
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        token.approve(address(pool), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        pool.stake(amount);
    }

    /// Fund-first, notify-exact - the ceremony's rule, used by the happy paths.
    function _fundAndNotify(uint256 reward) internal {
        token.mint(address(pool), reward);
        vm.prank(distribution);
        pool.notifyRewardAmount(reward);
    }

    // ------------------------------------------------------------------
    // The full cycle, funded correctly
    // ------------------------------------------------------------------

    function test_fullCycle_stakeEarnClaimWithdraw() public {
        // ABSOLUTE warp targets only: via_ir CSE-folds a re-read of
        // block.timestamp across vm.warp (reference_via_ir_timestamp_cse), so
        // `warp(block.timestamp + 30 days)` twice lands on day 30 twice and
        // the second half of the period silently never happens.
        uint256 t0 = block.timestamp;
        _stake(alice, STAKE);
        _fundAndNotify(60e18); // 1e18/day for 60 days, sole staker

        vm.warp(t0 + 30 days);
        uint256 midEarned = pool.earned(alice);
        assertApproxEqAbs(midEarned, 30e18, 1e15, "half the period earns half the reward");

        vm.prank(alice);
        pool.getReward();
        assertApproxEqAbs(token.balanceOf(alice), midEarned, 1e15, "claim pays what was earned");

        vm.warp(t0 + 60 days);
        vm.prank(alice);
        pool.exit();
        // Principal back in full, plus ~the whole 60e18 (integer rate rounds dust down).
        assertGe(token.balanceOf(alice), STAKE + 59e18, "exit returns principal + remaining rewards");
        assertEq(pool.totalSupply(), 0, "no stake left behind");
        assertEq(pool.balanceOf(alice), 0, "position closed");
    }

    // ------------------------------------------------------------------
    // ANTI-HOSTAGE - the property the Solana pool cannot offer
    // ------------------------------------------------------------------

    function test_antiHostage_withdrawSucceedsWithZeroFundedRewards() public {
        _stake(alice, STAKE);
        // Nothing funded, nothing notified: the pool holds ONLY principal.
        vm.warp(block.timestamp + 365 days);
        assertEq(pool.earned(alice), 0, "unfunded pool accrues nothing (rate 0 - an honest zero)");

        vm.prank(alice);
        pool.withdraw(STAKE);
        assertEq(token.balanceOf(alice), STAKE, "principal exits an unfunded pool in full");

        // And the claim path is a harmless no-op, not a revert (6012's opposite).
        vm.prank(alice);
        pool.getReward();
    }

    function test_antiHostage_exitWorksAfterPeriodWithExhaustedVault() public {
        _stake(alice, STAKE);
        _fundAndNotify(60e18);
        vm.warp(block.timestamp + DURATION + 1);
        // Vault exactly covers accrual (fund-first ceremony) - exit pays both legs.
        vm.prank(alice);
        pool.exit();
        assertGe(token.balanceOf(alice), STAKE, "principal is never the reward vault's hostage");
    }

    // ------------------------------------------------------------------
    // The canonical funding guard (distinct tokens - upstream's world)
    // ------------------------------------------------------------------

    function test_notifyGuard_rejectsUnfundedRate_distinctTokens() public {
        StakingRewards distinct = new StakingRewards(distribution, address(other), address(token));
        vm.prank(distribution);
        vm.expectRevert(bytes("Provided reward too high"));
        distinct.notifyRewardAmount(1e18); // nothing transferred in first
    }

    function test_notify_onlyDistribution() public {
        token.mint(address(pool), 1e18);
        vm.prank(alice);
        vm.expectRevert(bytes("Caller is not RewardsDistribution contract"));
        pool.notifyRewardAmount(1e18);
    }

    // ------------------------------------------------------------------
    // SAME-TOKEN OVER-NOTIFY - the hazard, and the ceremony bound that kills it
    // ------------------------------------------------------------------

    /// The hazard is REAL: this is the exact sequence the funding ceremony's
    /// `reward <= balanceOf(pool) - totalSupply()` bound exists to prevent.
    /// If a vendored-file re-pin ever made this test fail by *fixing* the
    /// guard, the divergence would need naming in PROVENANCE.md D8 - either
    /// way, nothing about this edge moves silently.
    function test_sameToken_overNotifySpendsPrincipal_strandsLastWithdrawer() public {
        _stake(alice, STAKE);
        _stake(bob, STAKE);
        // ZERO reward tokens funded. The canonical guard still accepts a
        // 200e18 notify because balanceOf(pool) == 200e18 of PRINCIPAL.
        vm.prank(distribution);
        pool.notifyRewardAmount(200e18);

        vm.warp(block.timestamp + DURATION + 1);

        // Alice exits first and is paid her "reward" out of Bob's principal.
        vm.prank(alice);
        pool.exit();
        assertGt(token.balanceOf(alice), STAKE + 90e18, "first-out is overpaid from principal");

        // Bob's PRINCIPAL withdraw now fails - the insolvency the ceremony bound prevents.
        vm.prank(bob);
        vm.expectRevert();
        pool.withdraw(STAKE);
    }

    /// The bound is SUFFICIENT: notify never exceeding (balance - totalSupply)
    /// keeps every principal whole through full exits, same-token included.
    function test_sameToken_ceremonyBound_keepsAllPrincipalWhole() public {
        _stake(alice, STAKE);
        _stake(bob, STAKE);
        uint256 reward = 50e18;
        token.mint(address(pool), reward);
        assertLe(reward, token.balanceOf(address(pool)) - pool.totalSupply(), "the ceremony precondition");
        vm.prank(distribution);
        pool.notifyRewardAmount(reward);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(alice);
        pool.exit();
        vm.prank(bob);
        pool.exit();
        assertGe(token.balanceOf(alice), STAKE, "alice keeps full principal");
        assertGe(token.balanceOf(bob), STAKE, "bob keeps full principal - nobody is stranded");
        // Split the reward roughly evenly (equal stakes, full period).
        assertApproxEqAbs(token.balanceOf(alice) - STAKE, 25e18, 1e15, "half the reward each");
        assertApproxEqAbs(token.balanceOf(bob) - STAKE, 25e18, 1e15, "half the reward each");
    }

    // ------------------------------------------------------------------
    // Runway surface the UI reads
    // ------------------------------------------------------------------

    function test_periodFinish_isTheExactRunway() public {
        _stake(alice, STAKE);
        uint256 t0 = block.timestamp;
        _fundAndNotify(60e18);
        assertEq(pool.periodFinish(), t0 + DURATION, "runway end is exact and on-chain");
        assertEq(pool.getRewardForDuration(), pool.rewardRate() * DURATION, "configured payout is derivable");
        // After the period, the paying rate is an honest zero...
        vm.warp(t0 + DURATION + 5 days);
        uint256 earnedAtEnd = pool.earned(alice);
        vm.warp(t0 + DURATION + 6 days);
        assertEq(pool.earned(alice), earnedAtEnd, "accrual stops at periodFinish");
    }
}
