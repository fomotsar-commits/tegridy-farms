// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _n = 1;
    constructor() ERC721("JBAC", "JBAC") {}

    function mint(address to) external returns (uint256 id) {
        id = _n++;
        _mint(to, id);
    }
}

/// @title  TegridyStaking base-reward over-mint PoC (LIVE contract)
/// @notice Same class as the restaking bonus insolvency, on the LIVE staking core.
///         StakingRewardLib.accumulateRewards caps each accrual to
///         `rewardPool = balanceOf - totalStaked - totalUnsettledRewards`. Accrual
///         moves no tokens, and that cap subtracts crystallized SHORTFALLS
///         (totalUnsettledRewards) — NOT already-accrued-but-unclaimed liability.
///         So successive accruals with no intervening claim re-use the same
///         rewardPool and rewardPerTokenStored OVER-MINTS beyond what was funded.
///
///         The shortfall→`unsettledRewards` booking is capped at `maxUnsettledRewards`
///         (a flow-control guard), NOT at balance (see StakingRewardLib:506-556, whose
///         own comment concedes "earned-but-unbacked debt ... the operator commits to
///         backfilling"). So the over-mint inflates operator reward liability to ~2x
///         funded: the first claimer extracts more than their funded share, and the
///         remainder becomes UNBACKED `unsettledRewards` — the cash invariant the
///         red-team suite asserts (balance >= totalStaked + totalUnsettledRewards,
///         RedTeam_Staking.t.sol:452-465) is VIOLATED in this depletion path, which
///         that test never exercises (it funds 5M so the cap never binds).
///
///         Fix (audit remediation #2): rebase on the Synthetix funded-period model
///         (TegridyLPFarming) — rewardRate = funded/duration + periodFinish, so
///         cumulative emission == funded by construction. This is a LIVE contract
///         (0xcaDc93E96De58EA554c71ca609974625615E046D); the fix is a migration.
contract StakingRewardOverMintTest is Test {
    MockTOWELI toweli;
    MockJBAC jbac;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyStakingJbacVault vault;
    StakingMonitorView monitor;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address poker = makeAddr("poker");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1e18; // MAX_REWARD_RATE — emission outruns a small pool fast
    uint256 constant R = 1_000 ether; // MIN_NOTIFY_AMOUNT — the entire funded reward pool
    uint256 constant STAKE = 100_000 ether;

    function setUp() public {
        toweli = new MockTOWELI();
        jbac = new MockJBAC();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));
        monitor = new StakingMonitorView(address(staking));

        toweli.transfer(alice, STAKE);
        toweli.transfer(bob, STAKE);
        toweli.transfer(poker, MIN_STAKE());

        _approve(alice);
        _approve(bob);
        _approve(poker);
    }

    function MIN_STAKE() internal pure returns (uint256) {
        return 100 ether;
    }

    function _approve(address who) internal {
        vm.prank(who);
        toweli.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amt) internal returns (uint256 tokenId) {
        vm.prank(who);
        staking.stake(amt, 365 days);
        tokenId = staking.userTokenId(who);
    }

    function _poke(uint256 pokerToken) internal {
        // getReward runs updateReward (global accrual) then pays the caller. poker's
        // boosted amount is ~0.05% of the pool, so the accrual fires while the pool
        // is drained only negligibly and the alice/bob denominator is unchanged.
        vm.prank(poker);
        staking.getReward(pokerToken);
    }

    /// @notice FIXED 2026-10-18 by the remediation this file names: the new contract pays its
    ///         pot out on the Synthetix funded-period model (rate = funded / four years, nothing
    ///         after periodFinish). The same rig as the old PoC (two big stakers, a 1,000-TOWELI
    ///         pot, a poker settling between windows) now never owes more than it was funded,
    ///         claims split fairly, and the cash invariant holds. This was the KNOWN_DEFECT test;
    ///         on the first contract (0xcaDc93E96De58EA554c71ca609974625615E046D) the defect stays.
    function test_baseReward_neverOverMints_fundedPeriodModel_FIXED() public {
        uint256 at = _stake(alice, STAKE);
        uint256 bt = _stake(bob, STAKE);
        uint256 pt = _stake(poker, MIN_STAKE());

        // Fund the reward pool with exactly R (on top of the staked principal).
        toweli.approve(address(staking), R);
        staking.notifyRewardAmount(R);
        assertEq(staking.totalRewardsFunded(), R, "funded R");

        // Settle repeatedly, then run past the end of the schedule.
        for (uint256 i = 1; i <= 2; i++) {
            vm.warp(vm.getBlockTimestamp() + 2_000);
            _poke(pt);
        }
        vm.warp(vm.getBlockTimestamp() + 4 * 365 days + 1);
        _poke(pt);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        _poke(pt);

        uint256 owed = monitor.earned(at) + monitor.earned(bt);
        assertLe(owed, R, "never owes more than was funded");

        uint256 aliceGot = staking.getReward(_asAlice(at));
        uint256 bobGot = staking.getReward(_asBob(bt));
        assertApproxEqAbs(aliceGot, bobGot, 1e6, "equal stakes, equal shares: no first-claimer grab");
        assertEq(staking.totalUnsettledRewards(), 0, "no shortfall IOU booked");

        uint256 bal = toweli.balanceOf(address(staking));
        uint256 obligations = staking.totalStaked() + staking.totalUnsettledRewards();
        assertGe(bal, obligations, "cash invariant holds: balance >= principal + unsettled");
    }

    function _asAlice(uint256 t) internal returns (uint256) {
        vm.prank(alice);
        return t;
    }

    function _asBob(uint256 t) internal returns (uint256) {
        vm.prank(bob);
        return t;
    }
}
