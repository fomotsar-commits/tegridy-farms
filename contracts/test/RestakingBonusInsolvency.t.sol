// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import {RestakingMonitorView} from "../src/RestakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";
import "../src/TegridyRestaking.sol";
import {TegridyRestakingAdmin} from "../src/TegridyRestakingAdmin.sol";
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
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title  Restaking bonus-accrual solvency guard (regression for the fixed HIGH)
/// @notice REGRESSION TEST for AUDIT FIX 2026-08-27 [BONUS-SOLVENCY]. Before the
///         fix, `_accrueBonus` (TegridyRestaking.sol:2374) clamped each accrual
///         window's mint to the INSTANTANEOUS `available = balanceOf(this) -
///         totalUnforwardedBonus`. Accrual moves NO tokens (the balance only falls
///         on an actual claim), and the clamp subtracted only `totalUnforwardedBonus`
///         (crystallized FAILED transfers) — NOT already-accrued-but-unclaimed
///         liability. So every accrual that fired while unclaimed liability sat in
///         the balance re-distributed that same backing again; with no intervening
///         claims the over-mint COMPOUNDED one full pool per window into insolvency.
///
///         THE FIX caps against the full OUTSTANDING liability
///         (`totalBonusEmitted - totalBonusDistributed`) instead of just IOUs, so
///         cumulative emission can never exceed cumulative funding. This test proves
///         it: the pool is minted at most ONCE (W1), later windows mint zero, and the
///         total obligation never exceeds funding. Historical mechanism (pre-fix):
///         the accumulator ended up owing several times what was ever funded,
///         first claimers drained the pool and later claimers were stranded with
///         unbacked `unforwardedBonusRewards` IOUs (417k liability / 100k funded
///         over 4 windows, empirically).
///
///         STATUS: pre-deploy (TEGRIDY_RESTAKING_ADDRESS == address(0)); no live
///         funds. Fix chosen: the minimal cumulative-liability cap (a
///         `totalBonusEmitted` counter), preferred over a full Synthetix
///         funded-period rebase to minimize regression on the 17 audited restaking
///         suites. See docs/RESTAKING_BONUS_INSOLVENCY_2026_08_27.md.
///
///         METHOD NOTE: warps are driven off `vm.getBlockTimestamp()`, not
///         `block.timestamp`. Under this repo's optimizer+via_ir, solc CSEs
///         `block.timestamp` as tx-constant, so repeated `vm.warp(block.timestamp+W)`
///         does NOT compound — using it here masks the compounding entirely and
///         makes the bug look bounded. (Same footgun recorded in the v2-forfeit
///         refutation doc.)
contract RestakingBonusInsolvencyTest is Test {
    MockTOWELI toweli;
    MockJBAC jbac;
    MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyStakingJbacVault vault;
    TegridyRestaking restaking;
    TegridyRestakingAdmin restakingAdmin;
    RestakingMonitorView rMonitorView;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1e14;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant BONUS_FUNDING = 100_000 ether; // WETH funded into restaking
    uint256 constant ACC = 1e18;

    function setUp() public {
        toweli = new MockTOWELI();
        jbac = new MockJBAC();
        weth = new MockWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        restaking = new TegridyRestaking(address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE);
        restakingAdmin = new TegridyRestakingAdmin(address(restaking));
        restaking.setRestakingAdmin(address(restakingAdmin));
        rMonitorView = new RestakingMonitorView(address(restaking));

        toweli.approve(address(staking), 500_000 ether);
        staking.notifyRewardAmount(500_000 ether);

        weth.transfer(address(restaking), BONUS_FUNDING);

        toweli.transfer(alice, STAKE_AMOUNT);
        toweli.transfer(bob, STAKE_AMOUNT);
    }

    function _stakeAndRestake(address user) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 365 days); // long lock so boost stays flat across windows
        tokenId = staking.userTokenId(user);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    /// Isolated accrual tick: prank as the admin and re-apply the SAME rate.
    /// applyBonusRate runs `_accrueBonusChecked()` and changes nothing else that
    /// moves value or `totalRestaked` — a pure accrual with no claim. (In production
    /// this same accrual fires on every restake/unrestake/claim/refresh/decay, so
    /// "accrual without a claim" is the ordinary case, not a contrived one.)
    function _accrualTick() internal {
        vm.prank(address(restakingAdmin));
        restaking.applyBonusRate(BONUS_RATE);
    }

    function test_BonusAccrual_StaysSolvent_capBindsAcrossWindows() public {
        _stakeAndRestake(alice);
        _stakeAndRestake(bob);

        uint256 B0 = weth.balanceOf(address(restaking));
        // W chosen so each window's intended emission (W*rate) >= the whole funded
        // pool, so a broken clamp would (and pre-fix did) re-bind every window.
        uint256 W = 1_000_001;

        // Four accrual windows, NO claim and NO new funding between any of them.
        uint256 t = vm.getBlockTimestamp();
        uint256 prevAcc = restaking.accBonusPerShare();
        uint256 firstIncrement;
        for (uint256 i = 1; i <= 4; i++) {
            t += W;
            vm.warp(t);
            _accrualTick();
            uint256 acc = restaking.accBonusPerShare();
            uint256 increment = acc - prevAcc;

            // SOLVENCY PROOF: the pool is minted at most ONCE. The first window that
            // hits the cap emits the funded pool; every later window with no new
            // funding and no claims must emit ZERO (the re-mint the bug relied on).
            if (i == 1) {
                firstIncrement = increment;
                assertGt(increment, 0, "W1 should mint the funded pool once");
            } else {
                assertEq(increment, 0, "FIX: later windows must not re-mint the same backing");
            }

            // Accrual never moves tokens: the backing never shrinks (so the fix is
            // genuinely from the emitted-liability cap, not from a balance change).
            assertEq(weth.balanceOf(address(restaking)), B0, "balance unchanged by accrual");
            prevAcc = acc;
        }

        // INVARIANT: cumulative liability minted never exceeds cumulative funding.
        uint256 emitted = restaking.totalBonusEmitted();
        console2.log("totalBonusEmitted:", emitted);
        console2.log("funded B0        :", B0);
        assertLe(emitted, B0, "cumulative emission must never exceed funding");

        // Economic proof: total obligation (paid out + still-owed IOUs) is fully
        // backed by the funded pool — the contract is solvent.
        vm.prank(alice);
        restaking.claimAll();
        vm.prank(bob);
        restaking.claimAll();

        uint256 obligation = weth.balanceOf(alice) + weth.balanceOf(bob) + restaking.unforwardedBonusRewards(alice)
            + restaking.unforwardedBonusRewards(bob);
        console2.log("total obligation (paid + IOUs):", obligation);
        assertLe(obligation, B0, "obligation must never exceed funding (solvent)");
        // And the fix is non-vacuous: both stakers were genuinely paid the pool
        // (not starved) — the whole funded amount is accounted for, within rounding.
        assertApproxEqAbs(obligation, B0, 1e6, "the funded pool is fully distributed, no more no less");
    }

    /// The read-only sister duplicates the host's accrual cap. It must mirror the
    /// FIXED cap (bal - (emitted - distributed)), not the old (bal -
    /// totalUnforwardedBonus), or it over-reports pending bonus vs what claimAll pays.
    /// Long lock (setUp) => no boost decay/kick, so the only remaining divergence
    /// under test is the cap term this fix corrected.
    function test_MonitorPendingBonusMatchesHostCappedAccrual() public {
        _stakeAndRestake(alice);
        _stakeAndRestake(bob);

        // Warp so intended emission exceeds the funded pool -> the host cap binds.
        // Do NOT tick accrual, so the view must PROJECT the same capped accrual the
        // host will realize in claimAll (same block, same window).
        vm.warp(vm.getBlockTimestamp() + 1_000_001);

        uint256 pview = rMonitorView.pendingBonus(alice);
        assertGt(pview, 0, "view projects some pending bonus");

        uint256 aliceBefore = weth.balanceOf(alice);
        vm.prank(alice);
        restaking.claimAll();
        uint256 actualClaimable = (weth.balanceOf(alice) - aliceBefore) + restaking.unforwardedBonusRewards(alice);

        // The FIXED view mirrors the host's tight cap -> it does not over-report. The
        // old cap (bal - totalUnforwardedBonus) would project the full pool and exceed
        // what claimAll pays (part of the pool was already emitted pre-window).
        assertApproxEqAbs(pview, actualClaimable, 1e12, "monitor view diverges from host claimAll");
    }
}
