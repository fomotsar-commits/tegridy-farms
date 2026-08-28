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

/// @title  Restaking bonus-accrual insolvency — CONFIRMED pre-deploy HIGH (characterization)
/// @notice `_accrueBonus` (TegridyRestaking.sol:2374) computes each accrual window's
///         mint as `elapsed * bonusRewardPerSecond`, clamped to the INSTANTANEOUS
///         `available = balanceOf(this) - totalUnforwardedBonus`. But accrual moves
///         NO tokens (the balance only falls on an actual claim), and the clamp
///         subtracts only `totalUnforwardedBonus` (crystallized FAILED transfers) —
///         NOT the already-accrued-but-unclaimed liability. So every accrual that
///         fires while unclaimed liability sits in the balance re-distributes that
///         same backing again. With no intervening claims the over-mint COMPOUNDS
///         linearly, one full pool per window: `accBonusPerShare` climbs without
///         bound, the accumulator ends up owing several times what was ever funded,
///         first claimers drain the pool and later claimers are stranded with
///         unbacked `unforwardedBonusRewards` IOUs.
///
///         There is NO `periodFinish` and `totalBonusFunded`/`totalBonusDistributed`
///         are write-only (never gate accrual), so nothing bounds cumulative
///         emission to cumulative funding. The Synthetix funded-period model
///         (`rate = funded/duration`, stop accrual at `periodFinish`) makes
///         cumulative emission ≡ cumulative funded by construction and closes this.
///
///         STATUS: pre-deploy (TEGRIDY_RESTAKING_ADDRESS == address(0)); no live
///         funds. This test PINS the current defect (asserts it EXISTS) so it is
///         captured executably; when the funded-period fix lands, flip the two
///         marked assertions to their post-fix (solvency) form and the test proves
///         the fix. See docs/RESTAKING_BONUS_INSOLVENCY_2026_08_27.md.
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

    function test_BonusAccrual_CompoundingOverMint_KNOWN_DEFECT() public {
        _stakeAndRestake(alice);
        _stakeAndRestake(bob);

        uint256 B0 = weth.balanceOf(address(restaking));
        // W chosen so each window's intended emission (W*rate) >= the whole funded
        // pool, so the clamp binds to `available` every window.
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

            // COMPOUNDING PROOF: every window mints a fresh, non-zero increment even
            // though nothing new was funded and nothing was claimed. (A correct
            // funded-period model would mint the pool ONCE and then 0.)
            assertGt(increment, 0, "DEFECT: each window re-mints against the same backing");
            if (i == 1) {
                firstIncrement = increment;
            } else {
                assertApproxEqRel(
                    increment, firstIncrement, 1e15, "DEFECT: over-mint compounds at a constant per-window rate"
                );
            }

            // Accrual never moves tokens: the backing the clamp trusts never shrinks.
            assertEq(weth.balanceOf(address(restaking)), B0, "balance unchanged by accrual");
            assertEq(restaking.totalUnforwardedBonus(), 0, "no failed transfers yet");
            prevAcc = acc;
        }

        // The accumulator now implies far more liability than was ever funded.
        uint256 grossLiability = restaking.accBonusPerShare() * restaking.totalRestaked() / ACC;
        console2.log("gross accumulator liability:", grossLiability);
        console2.log("funded B0                 :", B0);
        assertGt(grossLiability, 3 * B0, "DEFECT: 4 windows imply >3x the funded liability");

        // Economic consequence: total obligation (paid out + still-owed IOUs) exceeds
        // what was ever funded — the pool is insolvent.
        vm.prank(alice);
        restaking.claimAll();
        vm.prank(bob);
        restaking.claimAll();

        uint256 obligation = weth.balanceOf(alice) + weth.balanceOf(bob) + restaking.unforwardedBonusRewards(alice)
            + restaking.unforwardedBonusRewards(bob);
        console2.log("total obligation (paid + IOUs):", obligation);

        // ── ASSERTION TO FLIP AFTER THE FUNDED-PERIOD FIX ──────────────────────
        // CURRENT (defective): obligation > funding.  POST-FIX (solvent):
        //   assertLe(obligation, B0, "cumulative emission must never exceed funding");
        assertGt(obligation, B0, "KNOWN DEFECT: obligation exceeds funding (insolvent)");
    }
}
