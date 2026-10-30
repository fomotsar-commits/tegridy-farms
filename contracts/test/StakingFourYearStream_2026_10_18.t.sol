// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

contract FYSToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract FYSNft is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @title  The reward pot is paid out over four years (owner ruling 2026-10-18)
/// @notice The owner: "the reward rate should follow total amount in reward pool/(365x4yrs) for
///         a per day emission that way even if new rewards are added to the pool they are
///         distributed with long term in mind". Implemented as Synthetix
///         StakingRewards.notifyRewardAmount with a fixed 4 x 365-day duration:
///           - nothing is paid before the first funding (no constructor rate);
///           - a funding sets rate = (funds + still-scheduled) / REWARDS_DURATION and restarts
///             the four years;
///           - nothing accrues after periodFinish, so the contract never promises more than
///             it was given (R018 M-005-01, deferred until now);
///           - a stretch that pays nobody (nothing staked, or paused) moves periodFinish back,
///             so that stretch's rewards are paid later, not stranded;
///           - there is no hand-set rate any more (no applyRewardRate, no proposeRewardRate).
contract StakingFourYearStreamTest is Test {
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin admin;
    FYSToken token;
    FYSNft nft;

    address treasury = makeAddr("treasury");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant DURATION = 4 * 365 days;
    uint256 constant POT = 1_460_000 ether; // 1,000 TOWELI a day for four years
    uint256 constant STAKE = 10_000 ether;

    function setUp() public {
        token = new FYSToken();
        nft = new FYSNft();
        staking = new TegridyStaking(address(token), address(nft), treasury);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        staking.setJbacVault(address(new TegridyStakingJbacVault(address(nft), address(staking))));

        token.transfer(bob, 1_000_000 ether);
        token.transfer(carol, 1_000_000 ether);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);
    }

    function _now() internal view returns (uint256) {
        // via_ir folds block.timestamp across warps; read the cheatcode clock instead.
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 secs) internal {
        vm.warp(_now() + secs);
    }

    function _stake(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        staking.stake(amount, 4 * 365 days);
        id = staking.userTokenId(who);
    }

    function _claim(address who, uint256 id) internal returns (uint256 got) {
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        staking.getReward(id);
        got = token.balanceOf(who) - before;
    }

    // ─── The rule ─────────────────────────────────────────────────────

    function test_durationIsFourTimes365Days() public view {
        assertEq(staking.REWARDS_DURATION(), 1460 days, "4 x 365 days");
    }

    function test_paysNothingBeforeTheFirstFunding() public {
        assertEq(staking.rewardRate(), 0, "no constructor rate");
        assertEq(staking.periodFinish(), 0, "no schedule");
        uint256 id = _stake(bob, STAKE);
        _warp(30 days);
        assertEq(monitor.earned(id), 0, "nothing accrues on an unfunded pool");
    }

    function test_funding_setsRateToPotOver1460Days_andStartsFourYears() public {
        staking.notifyRewardAmount(POT);
        assertEq(staking.rewardRate(), POT / DURATION, "rate = pot / 4 years");
        assertEq(staking.periodFinish(), _now() + DURATION, "four years from now");
        // 1,460,000 over 1,460 days is 1,000 a day (to the wei, less integer rounding).
        assertApproxEqAbs(staking.rewardRate() * 1 days, 1_000 ether, 1e12, "1,000 TOWELI a day");
    }

    function test_topUp_respreadsWhatIsLeftPlusTheNewFundsOverAFreshFourYears() public {
        // Someone is staked, so the year below really pays out (an empty pool would move the
        // end back instead, and the top-up would then re-spread the whole pot: see below).
        _stake(bob, STAKE);
        staking.notifyRewardAmount(POT);
        uint256 rate1 = staking.rewardRate();
        _warp(365 days);
        uint256 leftover = (staking.periodFinish() - _now()) * rate1;
        staking.notifyRewardAmount(500_000 ether);
        assertEq(staking.rewardRate(), (500_000 ether + leftover) / DURATION, "(new + left) / 4 years");
        assertEq(staking.periodFinish(), _now() + DURATION, "the four years restart");
        assertLt(staking.rewardRate(), rate1 + (500_000 ether / DURATION) + 1, "spread long, not dumped");
    }

    function test_rateCap_stillRefusesAnImpossibleRate() public {
        // MAX_REWARD_RATE (1 TOWELI/s) x four years = 126,144,000 TOWELI.
        uint256 tooMuch = 1e18 * DURATION + DURATION;
        vm.expectRevert(TegridyStaking.RateTooHigh.selector);
        staking.notifyRewardAmount(tooMuch);
    }

    // ─── R018 M-005-01: streaming, finally ───────────────────────────

    /// A funder who is also the only staker cannot take the pot back in one block: the same
    /// funds pay out over four years, so one second later they have earned one second's worth.
    function test_R018_fundThenClaim_paysOneSecondNotThePot() public {
        uint256 id = _stake(bob, STAKE);
        staking.notifyRewardAmount(POT);
        _warp(1);
        uint256 got = _claim(bob, id);
        assertLe(got, POT / DURATION + 1, "one second of emission, at most");
    }

    /// After periodFinish nothing more accrues until the next funding, and what was paid out is
    /// the funded amount, never more.
    function test_R018_haltsAtPeriodFinish_andNeverPaysMoreThanFunded() public {
        uint256 id = _stake(bob, STAKE);
        staking.notifyRewardAmount(POT);
        _warp(DURATION + 10 days);
        uint256 atEnd = monitor.earned(id);
        _warp(100 days);
        assertEq(monitor.earned(id), atEnd, "no accrual after periodFinish");
        uint256 got = _claim(bob, id);
        assertEq(got, atEnd, "the view and the claim agree after the end");
        assertLe(got, POT, "never more than funded");
        assertApproxEqAbs(got, POT, 1e9, "and all of it, less rounding dust");
    }

    // ─── Nothing stranded ────────────────────────────────────────────

    /// The launch gap: funded before anyone stakes. Those days pay nobody, so the schedule
    /// moves back by them and the whole pot is still paid out.
    function test_emptyPool_movesTheEndBack_soTheWholePotIsStillPaid() public {
        staking.notifyRewardAmount(POT);
        uint256 end0 = staking.periodFinish();
        _warp(10 days);
        uint256 id = _stake(bob, STAKE);
        assertEq(staking.periodFinish(), end0 + 10 days, "end moved back by the empty stretch");
        _warp(DURATION + 1 days);
        uint256 got = _claim(bob, id);
        assertApproxEqAbs(got, POT, 1e9, "the whole pot, not pot minus ten days");
    }

    /// A pause pays nobody, so the schedule moves back by the paused time too.
    function test_pause_movesTheEndBack_soThePausedRewardsAreStillPaid() public {
        uint256 id = _stake(bob, STAKE);
        staking.notifyRewardAmount(POT);
        uint256 end0 = staking.periodFinish();
        _warp(30 days);
        staking.pause();
        uint256 beforePause = monitor.earned(id);
        _warp(20 days);
        assertEq(monitor.earned(id), beforePause, "nothing accrues while paused");
        staking.unpause();
        assertEq(staking.periodFinish(), end0 + 20 days, "end moved back by the pause");
        _warp(DURATION);
        uint256 got = _claim(bob, id);
        assertApproxEqAbs(got, POT, 1e9, "the whole pot, pause included");
    }

    // ─── No hand-set rate ────────────────────────────────────────────

    function test_noRateOrDurationSetter_onStakingOrAdmin() public {
        (bool okApply,) = address(staking).call(abi.encodeWithSignature("applyRewardRate(uint256)", 1 ether));
        assertFalse(okApply, "staking has no applyRewardRate");
        (bool okPropose,) = address(admin).call(abi.encodeWithSignature("proposeRewardRate(uint256)", 1 ether));
        assertFalse(okPropose, "admin has no proposeRewardRate");
        (bool okDuration,) = address(staking).call(abi.encodeWithSignature("setRewardsDuration(uint256)", 1 days));
        assertFalse(okDuration, "the four years cannot be changed");
        (bool okPropDuration,) = address(admin).call(abi.encodeWithSignature("proposeRewardsDuration(uint256)", 1 days));
        assertFalse(okPropDuration, "not through the admin either");
    }

    // ─── Two stakers, two fundings: shares and the total ─────────────

    function testFuzz_twoFundings_paysExactlyWhatWasFunded(uint32 rawGap, uint96 rawTopUp) public {
        uint256 gap = bound(uint256(rawGap), 1 days, 3 * 365 days);
        uint256 topUp = bound(uint256(rawTopUp), 1_000 ether, 5_000_000 ether);
        uint256 idB = _stake(bob, STAKE);
        uint256 idC = _stake(carol, 3 * STAKE);
        staking.notifyRewardAmount(POT);
        _warp(gap);
        staking.notifyRewardAmount(topUp);
        _warp(DURATION + 1);
        uint256 paid = _claim(bob, idB) + _claim(carol, idC);
        assertLe(paid, POT + topUp, "never more than funded");
        assertApproxEqAbs(paid, POT + topUp, 1e10, "all of it, less rounding dust");
    }
}
