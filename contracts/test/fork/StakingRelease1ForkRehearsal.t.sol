// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {TegridyStaking} from "../../src/TegridyStaking.sol";
import {TegridyStakingAdmin} from "../../src/TegridyStakingAdmin.sol";
import {StakingMonitorView} from "../../src/StakingMonitorView.sol";
import {TegridyLPFarming} from "../../src/TegridyLPFarming.sol";
import {RevenueDistributor} from "../../src/RevenueDistributor.sol";
import {ReferralSplitter} from "../../src/ReferralSplitter.sol";

interface IRouterView {
    function referralSplitter() external view returns (address);
    function revenueDistributor() external view returns (address);
}

/// A contract holder: the only kind of account that can hold several staking positions.
contract ForkMultiHolder is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @title  Staking release 1 — mainnet-fork rehearsal, run AFTER the deploy scripts
/// @notice FORK-ONLY. Self-skips unless STAKING_RELEASE_FORK_URL points at an anvil mainnet fork
///         on which these were broadcast, impersonating the owner:
///           1. DeployStakingRelease1.s.sol      (new stack + the two router proposals)
///           2. FundStakingRelease1.s.sol        (rewards into the new staking)
///           3. anvil: time moved past 48 hours
///           4. ExecuteStakingRelease1Repoint.s.sol (router re-pointed)
///         It reads the new addresses from env (NEW_STAKING, NEW_STAKING_ADMIN, NEW_MONITOR_VIEW,
///         NEW_LP_FARM, NEW_REVENUE_DISTRIBUTOR, NEW_REFERRAL_SPLITTER) and proves, on that state:
///           - new stake + early exit: rewards in full + 25% back, 75% to the treasury Safe
///             (both early-exit paths), and no fee after the lock ends;
///           - the OLD contract still charges 25% on a real existing position;
///           - M-S6, M-S7 and M-G3: present on the old stack, fixed on the new one (same checks
///             as test/AuditMicroscope_MS6_*, _MS7_*, _MG3_*, run against both deployments);
///           - the live SwapFeeRouter now feeds the new distributor and splitter.
///         The fork test runs in memory: it never changes the anvil node's state.
contract StakingRelease1ForkRehearsal is Test {
    address constant OWNER = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant TREASURY_SAFE = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;
    address constant OLD_STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D;
    address constant OLD_MONITOR_VIEW = 0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC;
    address constant OLD_REF_SPLITTER = 0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c;
    address constant SWAP_FEE_ROUTER = 0x6d5791A660e79175F74C6D639584C98422d5956E;

    bool forked;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    StakingMonitorView monitor;
    TegridyLPFarming farm;
    RevenueDistributor revDist;
    ReferralSplitter splitter;
    TegridyStaking oldStaking = TegridyStaking(OLD_STAKING);

    address alice = makeAddr("fork-alice");
    address bob = makeAddr("fork-bob");
    address carol = makeAddr("fork-carol");

    function setUp() public {
        string memory url = vm.envOr("STAKING_RELEASE_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        staking = TegridyStaking(vm.envAddress("NEW_STAKING"));
        admin = TegridyStakingAdmin(vm.envAddress("NEW_STAKING_ADMIN"));
        monitor = StakingMonitorView(vm.envAddress("NEW_MONITOR_VIEW"));
        farm = TegridyLPFarming(vm.envAddress("NEW_LP_FARM"));
        revDist = RevenueDistributor(payable(vm.envAddress("NEW_REVENUE_DISTRIBUTOR")));
        splitter = ReferralSplitter(payable(vm.envAddress("NEW_REFERRAL_SPLITTER")));
        // Fresh wallets only; their TOWELI comes from the owner's wallet (a real holder).
        for (uint256 i; i < 3; ++i) {
            address u = i == 0 ? alice : (i == 1 ? bob : carol);
            vm.prank(OWNER);
            IERC20(TOWELI).transfer(u, 20_000 ether);
            vm.startPrank(u);
            IERC20(TOWELI).approve(address(staking), type(uint256).max);
            IERC20(TOWELI).approve(OLD_STAKING, type(uint256).max);
            vm.stopPrank();
        }
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _stake(TegridyStaking s, address who, uint256 amount, uint256 lock) internal returns (uint256 id) {
        vm.prank(who);
        s.stake(amount, lock);
        id = s.userTokenId(who);
    }

    // ─── Wiring ────────────────────────────────────────────────────────────

    function test_fork_newStack_isWiredOwnedAndFunded() public onlyFork {
        assertEq(staking.EARLY_WITHDRAWAL_PENALTY_BPS(), 7500, "new staking is 75%");
        assertEq(oldStaking.EARLY_WITHDRAWAL_PENALTY_BPS(), 2500, "old staking still 25%");
        assertEq(staking.owner(), OWNER);
        assertEq(admin.owner(), OWNER);
        assertEq(farm.owner(), OWNER);
        assertEq(revDist.owner(), OWNER);
        assertEq(splitter.owner(), OWNER);
        assertEq(staking.treasury(), TREASURY_SAFE);
        assertEq(staking.stakingAdmin(), address(admin));
        assertEq(address(monitor.staking()), address(staking));
        assertEq(address(farm.tegridyStaking()), address(staking));
        assertEq(address(revDist.votingEscrow()), address(staking));
        assertEq(address(splitter.stakingContract()), address(staking));
        assertGt(staking.totalRewardsFunded(), 0, "rehearsal funded the new pool");
        assertEq(IRouterView(SWAP_FEE_ROUTER).revenueDistributor(), address(revDist), "router -> new distributor");
        assertEq(IRouterView(SWAP_FEE_ROUTER).referralSplitter(), address(splitter), "router -> new splitter");
        // The router can still record fees into the new splitter (it is an approved caller).
        vm.deal(SWAP_FEE_ROUTER, 1 ether);
        vm.prank(SWAP_FEE_ROUTER);
        splitter.recordFee{value: 0.01 ether}(alice);
    }

    // ─── The product change: 75% on the new contract ──────────────────────

    function test_fork_new_earlyWithdraw_rewardsInFull_25back_75toTreasurySafe() public onlyFork {
        _stake(staking, carol, 5_000 ether, 365 days);
        uint256 id = _stake(staking, bob, 10_000 ether, 365 days);
        vm.warp(_now() + 30 days);

        uint256 owed = monitor.earned(id);
        assertGt(owed, 0, "rewards accrued");
        uint256 bobBefore = IERC20(TOWELI).balanceOf(bob);
        uint256 safeBefore = IERC20(TOWELI).balanceOf(TREASURY_SAFE);
        vm.prank(bob);
        staking.earlyWithdraw(id);

        uint256 toSafe = IERC20(TOWELI).balanceOf(TREASURY_SAFE) - safeBefore;
        uint256 toBob = IERC20(TOWELI).balanceOf(bob) - bobBefore;
        emit log_named_decimal_uint("new: rewards owed before exit", owed, 18);
        emit log_named_decimal_uint("new: holder received", toBob, 18);
        emit log_named_decimal_uint("new: treasury Safe received", toSafe, 18);
        assertEq(toSafe, 7_500 ether, "75% of principal to the treasury Safe");
        assertEq(toBob, owed + 2_500 ether, "rewards in full + 25% of principal");
    }

    function test_fork_new_executeEmergencyExit_beforeLockEnd_75toTreasurySafe() public onlyFork {
        _stake(staking, carol, 5_000 ether, 365 days);
        uint256 id = _stake(staking, bob, 10_000 ether, 365 days);
        vm.prank(bob);
        staking.requestEmergencyExit(id);
        vm.warp(_now() + 7 days + 1);

        uint256 owed = monitor.earned(id);
        uint256 bobBefore = IERC20(TOWELI).balanceOf(bob);
        uint256 safeBefore = IERC20(TOWELI).balanceOf(TREASURY_SAFE);
        vm.prank(bob);
        staking.executeEmergencyExit(id);

        assertEq(IERC20(TOWELI).balanceOf(TREASURY_SAFE) - safeBefore, 7_500 ether, "75% to the Safe");
        assertEq(IERC20(TOWELI).balanceOf(bob) - bobBefore, owed + 2_500 ether, "rewards + 25%");
    }

    /// Owner 2026-10-18: the new contract pays its pot out over four years, and has no
    /// whole-pool cap. The rehearsal funded it once (step 2), so the rate is that funding over
    /// 4 x 365 days, and the schedule ends four years after it (48 h have passed since).
    function test_fork_new_paysThePotOverFourYears_noPoolCap() public onlyFork {
        uint256 funded = staking.totalRewardsFunded();
        assertEq(staking.rewardRate(), funded / (4 * 365 days), "rate = pot / four years");
        assertGt(staking.periodFinish(), _now() + 4 * 365 days - 3 days, "ends about four years out");
        assertLe(staking.periodFinish(), _now() + 4 * 365 days, "and not later");
        assertEq(staking.maxTotalStaked(), type(uint256).max, "no whole-pool cap");
        assertEq(oldStaking.maxTotalStaked(), 5_000_000 ether, "the old contract keeps its 5M");
    }

    /// The owner's cap (2026-10-30; it was 1,000,000 from 2026-10-18): one wallet can stake
    /// 10,000,000 TOWELI on the new contract, and not one wei more. The old contract keeps its 50,000.
    function test_fork_new_perWalletCap_tenMillion_old50k() public onlyFork {
        assertEq(staking.maxStakePerUser(), 10_000_000 ether, "new cap 10M");
        assertEq(oldStaking.maxStakePerUser(), 50_000 ether, "old cap untouched");
        address whale = makeAddr("fork-whale");
        address over = makeAddr("fork-over");
        deal(TOWELI, whale, 10_000_000 ether);
        deal(TOWELI, over, 10_000_000 ether + 1);
        vm.prank(whale);
        IERC20(TOWELI).approve(address(staking), type(uint256).max);
        vm.prank(over);
        IERC20(TOWELI).approve(address(staking), type(uint256).max);

        vm.prank(over);
        vm.expectRevert(TegridyStaking.PerUserStakeCapExceeded.selector);
        staking.stake(10_000_000 ether + 1, 365 days);

        uint256 id = _stake(staking, whale, 10_000_000 ether, 365 days);
        (uint256 amount,,,,,,,,,,) = staking.positions(id);
        assertEq(amount, 10_000_000 ether, "a full 10M position");
    }

    function test_fork_new_afterLockEnd_noFee() public onlyFork {
        _stake(staking, carol, 5_000 ether, 365 days);
        uint256 id = _stake(staking, bob, 10_000 ether, 7 days);
        vm.warp(_now() + 7 days + 1);
        uint256 owed = monitor.earned(id);
        uint256 bobBefore = IERC20(TOWELI).balanceOf(bob);
        uint256 safeBefore = IERC20(TOWELI).balanceOf(TREASURY_SAFE);
        vm.prank(bob);
        staking.withdraw(id);
        assertEq(IERC20(TOWELI).balanceOf(TREASURY_SAFE), safeBefore, "no fee after lock end");
        assertEq(IERC20(TOWELI).balanceOf(bob) - bobBefore, owed + 10_000 ether, "rewards + all principal");
    }

    // ─── The old contract is untouched: still 25% on a real position ──────

    function test_fork_old_existingPosition_earlyExitStill25() public onlyFork {
        (uint256 id, address holder, uint256 amount) = _firstLockedOldPosition();
        assertGt(id, 0, "found a live, still-locked position on the old contract");
        uint256 owedShown = StakingMonitorView(OLD_MONITOR_VIEW).earned(id);
        uint256 holderBefore = IERC20(TOWELI).balanceOf(holder);
        uint256 safeBefore = IERC20(TOWELI).balanceOf(TREASURY_SAFE);
        vm.prank(holder);
        oldStaking.earlyWithdraw(id);

        uint256 toSafe = IERC20(TOWELI).balanceOf(TREASURY_SAFE) - safeBefore;
        uint256 toHolder = IERC20(TOWELI).balanceOf(holder) - holderBefore;
        uint256 fee = (amount * 2500) / 10000;
        emit log_named_uint("old: position id", id);
        emit log_named_decimal_uint("old: principal", amount, 18);
        emit log_named_decimal_uint("old: rewards shown before exit", owedShown, 18);
        emit log_named_decimal_uint("old: holder received", toHolder, 18);
        emit log_named_decimal_uint("old: treasury Safe received", toSafe, 18);
        assertEq(toSafe, fee, "old contract: 25% of principal to the Safe");
        assertGe(toHolder, amount - fee, "old contract: holder keeps 75% of principal");
        assertLe(toHolder, amount - fee + owedShown, "old contract: no more than principal share + shown rewards");
    }

    function _firstLockedOldPosition() internal view returns (uint256, address, uint256) {
        for (uint256 id = 1; id <= 64; ++id) {
            try oldStaking.ownerOf(id) returns (address holder) {
                (uint256 amount,,, uint64 lockEnd,,,,,,,) = oldStaking.positions(id);
                if (amount > 0 && lockEnd > _now() && holder.code.length == 0) return (id, holder, amount);
            } catch {}
        }
        return (0, address(0), 0);
    }

    // ─── M-S6: a reward funder needs 48 hours' notice ─────────────────────

    function test_fork_MS6_oldInstant_newTimelocked() public onlyFork {
        address notifier = makeAddr("fork-notifier");
        // Old stack: the owner grants a funder in one transaction (the finding).
        vm.prank(OWNER);
        (bool oldGranted,) = OLD_STAKING.call(abi.encodeWithSignature("setRewardNotifier(address,bool)", notifier, true));
        assertTrue(oldGranted, "old stack still has the one-step grant (M-S6 present)");
        // New stack: the one-step setter is gone ...
        vm.prank(OWNER);
        (bool newGranted,) = address(staking).call(abi.encodeWithSignature("setRewardNotifier(address,bool)", notifier, true));
        assertFalse(newGranted, "new stack: one-step grant must not exist");
        // ... and the admin path waits the full 48 hours.
        vm.prank(OWNER);
        admin.proposeRewardNotifier(notifier, true);
        uint256 readyAt = admin.rewardNotifierChangeReadyAt();
        assertEq(readyAt, _now() + 48 hours);
        vm.warp(readyAt - 1);
        vm.prank(OWNER);
        vm.expectRevert();
        admin.executeRewardNotifier();
        vm.warp(readyAt);
        vm.prank(OWNER);
        admin.executeRewardNotifier();
    }

    // ─── M-S7: a multi-position holder's average boost rounds UP ──────────

    function test_fork_MS7_oldRoundsDown_newRoundsUp() public onlyFork {
        assertEq(_twoPositionAverage(oldStaking), 16_079, "old stack floors the average (M-S7 present)");
        assertEq(_twoPositionAverage(staking), 16_080, "new stack rounds the average up");
    }

    function _twoPositionAverage(TegridyStaking s) internal returns (uint256 avg) {
        uint256 snap = vm.snapshotState();
        ForkMultiHolder holder = new ForkMultiHolder();
        uint256 idLong = _stake(s, alice, 101 ether, s.MAX_LOCK_DURATION());
        uint256 idShort = _stake(s, bob, 200 ether, s.MIN_LOCK_DURATION());
        vm.warp(_now() + 1 days + 1);
        vm.prank(alice);
        s.transferFrom(alice, address(holder), idLong);
        vm.prank(bob);
        s.transferFrom(bob, address(holder), idShort);
        avg = s.aggregateActiveBoostBps(address(holder));
        vm.revertToState(snap);
    }

    // ─── M-G3: picking a referrer starts the 30-day clock ─────────────────

    function test_fork_MG3_oldFirstChangeInstant_newWaits30Days() public onlyFork {
        ReferralSplitter old = ReferralSplitter(payable(OLD_REF_SPLITTER));
        uint256 t0 = _now();
        vm.prank(alice);
        old.setReferrer(bob);
        vm.prank(alice);
        splitter.setReferrer(bob);
        vm.warp(t0 + 1 days);

        vm.prank(alice);
        old.updateReferrer(carol); // the finding: first change goes through at once
        assertEq(old.referrerOf(alice), carol, "old stack: first change was instant (M-G3 present)");

        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        splitter.updateReferrer(carol);
        vm.warp(t0 + 30 days);
        vm.prank(alice);
        splitter.updateReferrer(carol);
        assertEq(splitter.referrerOf(alice), carol, "new stack: change allowed after 30 days");
    }
}
