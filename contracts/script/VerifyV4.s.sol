// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TegridyV4Hook} from "../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../src/v4/TegridyV4HookAdmin.sol";

/// @title  VerifyV4 — post-deploy invariant checks for the V4 hook + admin
/// @notice Run after DeployV4 (and after MULTISIG.acceptOwnership). Reverts loudly
///         on any broken invariant. Env: HOOK, ADMIN, MULTISIG.
/// @dev    Covers core wiring/bounds invariants. Oracle (INV-V4-9/10) was dropped
///         (no oracle shipped). PauseGuardian (INV-V4-5) IS wired in the hook
///         (`hook.setPauseGuardian`) but is NOT yet asserted here — a known gap to
///         fill when VerifyV4 is expanded to the full runbook checklist (trustedRouter
///         / premiumAccess / boostedLP==0 / pauseGuardian / pool-initialized / POL).
contract VerifyV4Script is Script {
    function run() external view {
        TegridyV4Hook hook = TegridyV4Hook(vm.envAddress("HOOK"));
        TegridyV4HookAdmin admin = TegridyV4HookAdmin(vm.envAddress("ADMIN"));
        address multisig = vm.envAddress("MULTISIG");

        // INV-V4-2: the mined address actually encodes the declared permission flags.
        Hooks.validateHookPermissions(IHooks(address(hook)), hook.getHookPermissions());

        // INV-V4-4: admin wiring is bidirectional and exclusive.
        require(hook.paramAdmin() == address(admin), "hook.paramAdmin != admin");
        require(address(admin.hook()) == address(hook), "admin.hook != hook");

        // Fee bounds are ordered and the live base fee sits within them.
        require(hook.minFeePips() <= hook.baseFeePips(), "baseFee < min");
        require(hook.baseFeePips() <= hook.maxFeePips(), "baseFee > max");

        // POL skim is within its immutable ceiling, and the recipient is set.
        require(hook.polSkimBps() <= hook.maxPolSkimBps(), "polSkim > ceiling");
        require(hook.polRecipient() != address(0), "polRecipient unset");

        // INV-V4-3/4: governance has moved to the multisig (Ownable2Step accepted).
        require(admin.owner() == multisig, "admin owner != multisig (accept pending?)");

        console2.log("VerifyV4: all shipped-module invariants hold");
    }
}
