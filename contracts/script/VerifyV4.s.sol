// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TegridyV4Hook} from "../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../src/v4/TegridyV4HookAdmin.sol";
import {TegridyV4SwapRouter} from "../src/v4/TegridyV4SwapRouter.sol";
import {TegridyBoostedLPStaker} from "../src/v4/TegridyBoostedLPStaker.sol";

/// @title  VerifyV4 — post-deploy invariant checks for the V4 contract set
/// @notice Run at runbook step 14 (after acceptOwnership + feature wiring). Reverts
///         loudly on any broken invariant.
/// @dev    Env: HOOK, ADMIN, MULTISIG, PAUSE_GUARDIAN, SWAP_ROUTER, STAKER,
///         CURRENCY0, CURRENCY1.
/// @dev    Asserts the DETERMINISTIC contract-wiring invariants. Oracle
///         (INV-V4-9/10) was dropped (no oracle shipped). The hook-callback
///         boosted-LP path was DELETED (M-3) — there is no `hook.boostedLP` to check.
///         Pool-initialized + POL-position-owned-by-treasury stay on the MANUAL
///         checklist (they read live PoolManager/PositionManager state); a tiny test
///         swap + test staker deposit are also manual (state-changing).
contract VerifyV4Script is Script {
    using PoolIdLibrary for PoolKey;

    function run() external view {
        TegridyV4Hook hook = TegridyV4Hook(vm.envAddress("HOOK"));
        TegridyV4HookAdmin admin = TegridyV4HookAdmin(vm.envAddress("ADMIN"));
        address multisig = vm.envAddress("MULTISIG");
        address pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        address swapRouter = vm.envAddress("SWAP_ROUTER");
        TegridyBoostedLPStaker staker = TegridyBoostedLPStaker(vm.envAddress("STAKER"));
        address currency0 = vm.envAddress("CURRENCY0");
        address currency1 = vm.envAddress("CURRENCY1");

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

        // INV-V4-5: the pause guardian is wired to the hot multisig.
        require(hook.pauseGuardian() == pauseGuardian, "pauseGuardian != PAUSE_GUARDIAN");

        // #2 discount wiring: both-or-neither (premiumAccess <-> trustedRouter); when
        // enabled the trusted router is exactly the deployed TegridyV4SwapRouter. The
        // discount may be intentionally OFF at launch (both zero) per the runbook.
        bool premiumSet = hook.premiumAccess() != address(0);
        bool routerSet = hook.trustedRouter() != address(0);
        require(premiumSet == routerSet, "discount half-wired (premiumAccess xor trustedRouter)");
        if (routerSet) {
            require(hook.trustedRouter() == swapRouter, "trustedRouter != SWAP_ROUTER");
            require(hook.discountBps() != 0, "discount enabled but discountBps==0");
        }

        // Router is bound to the same PoolManager as the hook.
        require(
            address(TegridyV4SwapRouter(payable(swapRouter)).poolManager()) == address(hook.poolManager()),
            "router PM != hook PM"
        );

        // #3 staker: owner is the multisig, and its IMMUTABLE allowedPoolId matches the
        // canonical pool key — so it can never be a bricked / wrong-pool staker (C-1).
        require(staker.owner() == multisig, "staker owner != multisig");
        (address lo, address hi) = currency0 < currency1 ? (currency0, currency1) : (currency1, currency0);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: int24(60),
            hooks: IHooks(address(hook))
        });
        require(staker.allowedPoolId() == PoolId.unwrap(key.toId()), "staker allowedPoolId != canonical pool");

        console2.log("VerifyV4: deterministic wiring invariants hold (pool-init + POL-seed + test swap = manual checklist)");
    }
}
