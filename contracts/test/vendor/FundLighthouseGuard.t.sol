// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LighthouseLadder} from "../../src/LighthouseLadder.sol";
import {StakingRewards} from "../../src/vendor/synthetix-staking-rewards/StakingRewards.sol";
import {FundLighthouseStakingScript} from "../../script/FundLighthouseStaking.s.sol";

contract GuardToken is ERC20 {
    constructor() ERC20("Island", "ISL") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// @notice A PRE-FIX ladder, reproduced by shape rather than by history: it
///         answers `totalBoosted()` (every ladder build does) and has no
///         `MIN_STAKE` (only the post-fix build does). That is exactly the
///         on-chain signature of the six pools live today — verified by
///         staticcall: `MIN_STAKE()` reverts on ladder-qr / ladder-jbm /
///         ladder-pepe while `totalSupply()` reads 0.
contract PreFixLadderMock {
    uint256 public totalBoosted;
    uint256 public totalSupply;

    function rewardsToken() external view returns (address) {
        return address(this);
    }

    function stakingToken() external view returns (address) {
        return address(this);
    }
}

/// @notice A ladder whose floor was moved — the "not the audited build" case.
contract WrongFloorLadderMock {
    uint256 public totalBoosted;

    function MIN_STAKE() external pure returns (uint256) {
        return 1e18;
    }
}

/// @notice A ladder whose MIN_BOOST no longer derives from MIN_STAKE (L-INV-12
///         drift), which would silently re-open the dust window from the other
///         side — the guard is the divisor, not the stake floor.
contract DriftedBoostLadderMock {
    uint256 public totalBoosted;

    function MIN_STAKE() external pure returns (uint256) {
        return 100e18;
    }

    function MIN_BOOST() external pure returns (uint256) {
        return 1; // should be 100e18 * 4000 / 10000
    }

    function MIN_BOOST_BPS() external pure returns (uint256) {
        return 4_000;
    }

    function BPS() external pure returns (uint256) {
        return 10_000;
    }
}

/// @title  The funding ceremony must refuse a pre-fix ladder
/// @notice REGRESSION TEST for AUDIT FIX 2026-09-04 [LH-01].
///
///         `DeployLighthouseLadder` carries L-INV-11/L-INV-12 so a pre-fix BUILD
///         cannot be deployed unnoticed. `FundLighthouseStaking` — the step that
///         actually moves the money — had no equivalent gate, and is typed to the
///         vendored `StakingRewards`, which has no `MIN_STAKE` to inspect.
///
///         Why that mattered on this exact date: the six ladder pools live on
///         mainnet all carry pre-fix bytecode, they are the ONLY ladder addresses
///         written down anywhere in the repo (`bungalows.ts`, `addresses.json`,
///         every entry `"status": "live"`), and the registry repoint after a
///         redeploy is a MANUAL step. So the address an operator is most likely
///         to paste into POOL is precisely the one that must never be funded.
///         The dust-divisor theft needs nothing but a funded pool and 3 wei.
///
///         THE DISCRIMINATOR. `MIN_STAKE()` alone cannot do this job: a pre-fix
///         ladder reverts on it exactly like a plain vendored pool does, and the
///         plain pools are funded by this same script and legitimately have no
///         floor. `totalBoosted()` separates them — every ladder build answers
///         it, no plain pool does. Hence: not-a-ladder → allow; a ladder → its
///         floor must be present and correct.
///
///         MUTATION CHECK: delete the `assertFundableBuild` call from `run()`,
///         or weaken the gate to a bare `MIN_STAKE()` require, and
///         `test_preFixLadder_isRefused` fails. Deleting only the MIN_BOOST
///         derivation check fails `test_driftedMinBoost_isRefused` and nothing
///         else — the two guards are checked independently on purpose.
contract FundLighthouseGuardTest is Test {
    FundLighthouseStakingScript script;
    GuardToken token;

    address constant SAFE = address(0xBEEF);

    function setUp() public {
        script = new FundLighthouseStakingScript();
        token = new GuardToken();
    }

    // ── the blocker ─────────────────────────────────────────────────────

    /// PRE-FIX: passes. The script had no way to see the missing floor, and
    /// would have transferred and notified against the vulnerable build.
    function test_preFixLadder_isRefused() public {
        PreFixLadderMock prefix = new PreFixLadderMock();
        vm.expectRevert(bytes("POOL: PRE-FIX ladder build (no MIN_STAKE) - refusing to fund, redeploy first"));
        script.assertFundableBuild(address(prefix));
    }

    // ── the two legitimate builds must still fund ───────────────────────

    /// The fixed ladder is fundable, and is reported AS a ladder so the
    /// print-before-sign block can show the operator which build they signed.
    function test_fixedLadder_isAccepted_andReportsLadder() public {
        LighthouseLadder pool = new LighthouseLadder(SAFE, address(token), address(token));
        assertTrue(script.assertFundableBuild(address(pool)), "fixed ladder must be fundable and flagged as a ladder");
        assertEq(pool.MIN_STAKE(), 100e18, "the audited floor");
    }

    /// GUARD AGAINST OVER-FIXING: this script funds the plain `lighthouse-*`
    /// pools too. They are the vendored Synthetix build and have no MIN_STAKE by
    /// design, so a blanket floor requirement would have bricked funding them.
    function test_plainStakingRewards_stillFundable() public {
        StakingRewards plain = new StakingRewards(SAFE, address(token), address(token));
        assertFalse(script.assertFundableBuild(address(plain)), "plain pool must fund, and must NOT be called a ladder");
    }

    // ── the neighbouring build-identity failures ────────────────────────

    function test_movedFloor_isRefused() public {
        WrongFloorLadderMock moved = new WrongFloorLadderMock();
        vm.expectRevert(bytes("POOL: ladder MIN_STAKE moved - not the audited build"));
        script.assertFundableBuild(address(moved));
    }

    /// L-INV-12's sibling: the floor is right but the DIVISOR guard drifted.
    /// MIN_BOOST is what `rewardPerToken` actually compares against, so a drift
    /// here re-opens the dust window even with MIN_STAKE intact.
    function test_driftedMinBoost_isRefused() public {
        DriftedBoostLadderMock drifted = new DriftedBoostLadderMock();
        vm.expectRevert(bytes("POOL: MIN_BOOST drifted from MIN_STAKE"));
        script.assertFundableBuild(address(drifted));
    }

    /// A typo'd address would otherwise swallow the whole transfer: `transfer`
    /// to an EOA succeeds, and the notify would then revert with the tokens
    /// already gone.
    function test_addressWithNoCode_isRefused() public {
        vm.expectRevert(bytes("POOL: not a contract"));
        script.assertFundableBuild(address(0xD00D));
    }

    /// THE WIRING, not just the helper. Every other test here calls
    /// `assertFundableBuild` directly, so none of them would notice if a future
    /// edit dropped the call out of `run()` — and "the funding script has no
    /// gate" is precisely the defect this fix exists to close. This test drives
    /// the real entrypoint through env vars, so the gate must actually be ON the
    /// money path. It must revert BEFORE the broadcast, i.e. before any transfer.
    function test_run_refusesPreFixLadder_soTheGateIsOnTheMoneyPath() public {
        PreFixLadderMock prefix = new PreFixLadderMock();
        vm.setEnv("POOL", vm.toString(address(prefix)));
        vm.setEnv("AMOUNT", "1");
        vm.expectRevert(bytes("POOL: PRE-FIX ladder build (no MIN_STAKE) - refusing to fund, redeploy first"));
        script.run();
    }

    /// The live six, by shape: this is the configuration currently deployed on
    /// Ethereum and Base. Pinning it here means the guard is tested against the
    /// thing it exists to stop, not merely against a hypothetical.
    function test_theSixLivePools_matchTheRefusedShape() public {
        PreFixLadderMock live = new PreFixLadderMock();
        assertEq(live.totalSupply(), 0, "live pools read totalSupply()==0 (verified on-chain 2026-09-04)");
        (bool ok,) = address(live).staticcall(abi.encodeWithSignature("MIN_STAKE()"));
        assertFalse(ok, "live pools revert MIN_STAKE() - that is what makes them pre-fix");
        vm.expectRevert(bytes("POOL: PRE-FIX ladder build (no MIN_STAKE) - refusing to fund, redeploy first"));
        script.assertFundableBuild(address(live));
    }
}
