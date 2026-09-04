// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DeployBaseGraduationStackScript} from "../../script/base/DeployBaseGraduationStack.s.sol";
import {BaseChainConfig} from "../../script/base/BaseChainConfig.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../../src/v4/TegridyV4HookAdmin.sol";
import {TegridyFeeLocker} from "../../src/v4/TegridyFeeLocker.sol";
import {TegridyLiquidityMigrator} from "../../src/v4/TegridyLiquidityMigrator.sol";

contract DummySafe {
    receive() external payable {}
}

/// @title Shape A on Base — the graduation-stack deploy script.
/// @notice The five contracts themselves carry 77 tests of their own
///         (test/v4/*); what THIS suite pins is the per-chain script: the chain
///         gate, the role checks, the admin-mediated guardian wire (calling the
///         hook directly reverts NotParamAdmin — the bug this script shipped
///         with for one commit), the mined hook flags, the locker binding
///         order, and the immutable rescueRecipient landing on the multisig.
contract DeployBaseGraduationStackTest is Test {
    DeployBaseGraduationStackScript internal script;

    DummySafe internal multisig;
    DummySafe internal treasury;
    DummySafe internal pauseGuardian;

    // Substrate stand-ins: the stack's constructors only null-check these, and
    // the script's broadcast path (never taken here) is what pins the verified
    // BaseChainConfig constants.
    address internal poolManager = makeAddr("poolManager");
    address internal positionManager = makeAddr("positionManager");
    address internal permit2 = makeAddr("permit2");
    address internal airlock = makeAddr("airlock");

    function setUp() public {
        vm.chainId(BaseChainConfig.CHAIN_ID);
        vm.warp(100 days);
        script = new DeployBaseGraduationStackScript();
        multisig = new DummySafe();
        treasury = new DummySafe();
        pauseGuardian = new DummySafe();
    }

    function _cfg() internal view returns (DeployBaseGraduationStackScript.Config memory) {
        return DeployBaseGraduationStackScript.Config({
            multisig: address(multisig),
            treasury: address(treasury),
            pauseGuardian: address(pauseGuardian)
        });
    }

    function _run() internal returns (DeployBaseGraduationStackScript.Deployed memory) {
        return script.runForTest(_cfg(), poolManager, positionManager, permit2, airlock);
    }

    // ─── Gates ───────────────────────────────────────────────────────

    function test_RefusesEveryOtherChain_IncludingTheTestnet() public {
        uint256[3] memory wrong = [uint256(1), 4663, 84532];
        for (uint256 i = 0; i < wrong.length; i++) {
            vm.chainId(wrong[i]);
            vm.expectRevert(
                abi.encodeWithSelector(BaseChainConfig.NotBaseChain.selector, wrong[i])
            );
            _run();
        }
    }

    function test_RefusesAnEOAMultisig() public {
        DeployBaseGraduationStackScript.Config memory cfg = _cfg();
        cfg.multisig = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(BaseChainConfig.NotAContract.selector, "MULTISIG", cfg.multisig)
        );
        script.runForTest(cfg, poolManager, positionManager, permit2, airlock);
    }

    function test_RefusesNonDisjointRoles() public {
        DeployBaseGraduationStackScript.Config memory cfg = _cfg();
        cfg.treasury = cfg.multisig;
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseChainConfig.RolesNotDisjoint.selector, "MULTISIG", "TREASURY", cfg.multisig
            )
        );
        script.runForTest(cfg, poolManager, positionManager, permit2, airlock);
    }

    // ─── The stack ───────────────────────────────────────────────────

    function test_DeploysTheStackFullyWired() public {
        DeployBaseGraduationStackScript.Deployed memory d = _run();

        // The hook's mined address actually carries the permission flags — a
        // wrong-flag hook is rejected by the PoolManager at initialize, in
        // production, on the first graduation.
        uint160 expectedFlags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        assertEq(uint160(uint160(d.hook)) & Hooks.ALL_HOOK_MASK, expectedFlags, "mined flags");

        TegridyV4Hook hook = TegridyV4Hook(payable(d.hook));
        assertEq(hook.paramAdmin(), d.hookAdmin, "hook governed by the admin");
        assertEq(hook.pauseGuardian(), address(pauseGuardian), "guardian wired through the admin");

        TegridyLiquidityMigrator migrator = TegridyLiquidityMigrator(payable(d.migrator));
        assertEq(migrator.airlock(), airlock, "airlock bound");
        assertEq(address(migrator.poolManager()), poolManager, "poolManager bound");
        assertEq(address(migrator.positionManager()), positionManager, "posm bound");
        assertEq(address(migrator.hook()), d.hook, "graduates into OUR hooked pool");
        assertEq(migrator.rescueRecipient(), address(multisig), "rescue is the Safe, never the deployer");
        assertEq(address(migrator.feeLocker()), d.feeLocker, "locker bound");

        assertEq(TegridyFeeLocker(payable(d.feeLocker)).locker(), d.migrator, "locker bound back to migrator");
        assertEq(TegridyV4HookAdmin(d.hookAdmin).pendingOwner(), address(multisig), "admin offered two-step");
    }

    // AUDIT TF-018. `acceptOwnership` promises a CLEAN queue on handoff, and it
    // flushed seven timelock keys while missing the eighth — INITIALIZER_ALLOW_
    // CHANGE, which is the broadest key the queue can hold: an allowed
    // initializer opens pools behind this hook with no per-pool approval. An
    // outgoing owner could arm it, hand over, and the grant would survive into
    // the new owner's tenure, executable inside its validity window, with the
    // new owner told the queue was clean.
    function test_HandoffFlushesTheStandingInitializerGrant() public {
        DeployBaseGraduationStackScript.Deployed memory d = _run();
        TegridyV4HookAdmin admin = TegridyV4HookAdmin(d.hookAdmin);

        // The outgoing owner (the deploy script contract) arms the broadest
        // grant there is.
        address attacker = address(0xBADBEEF);
        vm.prank(admin.owner());
        admin.proposeInitializerAllowed(attacker, true);
        assertEq(admin.pendingInitializer(), attacker, "setup: grant is armed");

        vm.prank(address(multisig));
        admin.acceptOwnership();

        // THE INVARIANT: nothing armed survives the handoff.
        assertEq(admin.pendingInitializer(), address(0), "a standing initializer grant survived the handoff");
        assertEq(admin.pendingInitializerAllowed(), false, "the grant's flag survived the handoff");

        // And it is not merely un-named — it is un-executable.
        vm.warp(block.timestamp + 365 days);
        vm.prank(address(multisig));
        vm.expectRevert();
        admin.executeInitializerAllowed();
    }

    function test_AdminCeremonyCompletes() public {
        DeployBaseGraduationStackScript.Deployed memory d = _run();

        vm.prank(address(multisig));
        TegridyV4HookAdmin(d.hookAdmin).acceptOwnership();
        assertEq(TegridyV4HookAdmin(d.hookAdmin).owner(), address(multisig));

        // Post-ceremony, the deployer-era path is dead: only the Safe drives the
        // admin's instant pass-throughs.
        DummySafe newGuardian = new DummySafe();
        vm.expectRevert(); // OZ Ownable revert — the script contract no longer owns it
        TegridyV4HookAdmin(d.hookAdmin).hookSetPauseGuardian(address(newGuardian));

        vm.prank(address(multisig));
        TegridyV4HookAdmin(d.hookAdmin).hookSetPauseGuardian(address(newGuardian));
        assertEq(TegridyV4Hook(payable(d.hook)).pauseGuardian(), address(newGuardian));
    }

    function test_DirectHookGuardianCallReverts_TheBugThisScriptShippedWith() public {
        DeployBaseGraduationStackScript.Deployed memory d = _run();
        // The hook's setter is paramAdmin-gated; a deploy script calling it
        // directly (as this one did for exactly one commit) would revert the
        // whole broadcast at wiring time.
        vm.expectRevert(TegridyV4Hook.NotParamAdmin.selector);
        TegridyV4Hook(payable(d.hook)).setPauseGuardian(makeAddr("whoever"));
    }
}
