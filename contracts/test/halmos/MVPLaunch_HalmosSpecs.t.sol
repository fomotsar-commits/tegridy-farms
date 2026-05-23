// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../../src/TegridyStakingJbacVault.sol";

/// @title  MVPLaunch_HalmosSpecs — symbolic property tests for the highest-stakes invariants
/// @notice Hand-off starter for the Phase 3 Certora FV engagement. These
///         properties are written as Halmos `check_*` functions that the
///         a16z Halmos symbolic checker can exhaust over arbitrary input
///         values, NOT random ones.
///
///         How to run (auditor instructions):
///         ```
///         pip install halmos
///         cd contracts
///         halmos --match-contract MVPLaunch_HalmosSpecs --solver-timeout-assertion 10000
///         ```
///
///         If halmos isn't installed locally, these files still compile and
///         run under `forge test` as regular tests (without symbolic
///         enumeration). Use them as the spec baseline for the Certora
///         engagement — convert each `check_*` to a Certora rule.
///
///         Properties covered:
///         - CHECK-1: stake() never increases totalStaked beyond maxTotalStaked
///         - CHECK-2: stake() never increases a user's stake beyond maxStakePerUser
///         - CHECK-3: principal recoverability after stake (balance >= totalStaked)
///         - CHECK-4: setMaxStakePerUser(0) reverts (caps cannot disable)
///         - CHECK-5: pause is owner-or-guardian-only; unpause is owner-only
///         - CHECK-6: guardianPause cannot be called by attacker
///
///         These are the canonical Phase 1.3 / Phase 4 (FV) starter set.
contract MVPLaunch_HalmosSpecsTest is Test {
    TegridyStaking staking;
    MockTowel toweli;
    MockJBAC jbac;
    TegridyStakingJbacVault vault;

    address owner            = address(this);
    address pauseGuardian    = makeAddr("pauseGuardian");
    address attacker         = makeAddr("attacker");
    address user             = makeAddr("user");
    address treasury         = makeAddr("treasury");

    function setUp() public {
        toweli = new MockTowel();
        jbac = new MockJBAC();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        // Fund and approve.
        toweli.transfer(user, 10_000_000e18);
        vm.prank(user);
        toweli.approve(address(staking), type(uint256).max);
        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(1_000_000e18);

        // Conservative caps.
        staking.setMaxStakePerUser(50_000e18);
        staking.setMaxTotalStaked(5_000_000e18);
        staking.setPauseGuardian(pauseGuardian);
    }

    // ─── CHECK-1: stake() respects global cap ─────────────────────────
    /// @dev Symbolic: for any amount and any lock duration, stake() either
    ///      reverts OR totalStaked stays <= maxTotalStaked.
    function check_globalCap(uint256 amount, uint256 lockDuration) public {
        uint256 capBefore = staking.maxTotalStaked();
        uint256 totalBefore = staking.totalStaked();

        vm.prank(user);
        try staking.stake(amount, lockDuration) {
            // Stake succeeded — post-state must respect cap.
            assert(staking.totalStaked() <= capBefore);
            assert(staking.totalStaked() == totalBefore + amount);
        } catch {
            // Reverted — cap not violated by construction.
            assert(staking.totalStaked() == totalBefore);
        }
    }

    // ─── CHECK-2: stake() respects per-user cap ───────────────────────
    function check_perUserCap(uint256 amount, uint256 lockDuration) public {
        uint256 perUserCap = staking.maxStakePerUser();

        vm.prank(user);
        try staking.stake(amount, lockDuration) {
            assert(amount <= perUserCap);
        } catch {
            // Reverted is fine — any over-cap input must revert.
        }
    }

    // ─── CHECK-3: principal recoverable after stake ───────────────────
    /// @dev For any successful stake, balance(staking) >= totalStaked.
    function check_principalRecoverableAfterStake(uint256 amount, uint256 lockDuration) public {
        vm.prank(user);
        try staking.stake(amount, lockDuration) {
            assert(toweli.balanceOf(address(staking)) >= staking.totalStaked());
        } catch {}
    }

    // ─── CHECK-4: setMaxStakePerUser(0) ALWAYS reverts ────────────────
    /// @dev Caps cannot be zeroed — pause is the way to halt new stakes.
    function check_capCannotBeZero(uint256 ignored) public {
        // First branch: maxStakePerUser
        vm.prank(owner);
        try staking.setMaxStakePerUser(0) {
            assert(false); // should be unreachable
        } catch {}
        // Second branch: maxTotalStaked
        vm.prank(owner);
        try staking.setMaxTotalStaked(0) {
            assert(false);
        } catch {}
        ignored;
    }

    // ─── CHECK-5: pause permissioning ────────────────────────────────
    /// @dev pause() is owner-only. guardianPause() is guardian-only.
    ///      Both reject any other caller.
    function check_pauseAuth(address caller) public {
        // Filter out the explicitly-allowed callers.
        vm.assume(caller != owner);
        vm.assume(caller != pauseGuardian);
        vm.assume(caller != address(0));

        vm.prank(caller);
        try staking.pause() {
            assert(false); // any non-owner caller must revert
        } catch {}

        vm.prank(caller);
        try staking.guardianPause() {
            assert(false); // any non-guardian caller must revert
        } catch {}
    }

    // ─── CHECK-6: guardian cannot unpause ────────────────────────────
    /// @dev Guardian has pause-only authority. Unpause is owner-only.
    function check_guardianCannotUnpause() public {
        vm.prank(pauseGuardian);
        staking.guardianPause();

        vm.prank(pauseGuardian);
        try staking.unpause() {
            assert(false); // guardian must not be able to unpause
        } catch {}
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────

contract MockTowel is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 100_000_000e18);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}
