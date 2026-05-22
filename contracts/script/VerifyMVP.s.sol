// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {POLAccumulator} from "../src/POLAccumulator.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  VerifyMVP — Post-deploy invariant check
/// @notice Runs after the operator has executed DeployMVP and the multisig has
///         called acceptOwnership(). Asserts every wire is correct so we do
///         NOT announce live with a silent-brick configuration.
///
///         Set the env vars below before running. Any single failed INV-* halts
///         the entire script — partial-green is not acceptable for mainnet.
///
/// @dev    Env vars:
///         TREASURY, MULTISIG, PAUSE_GUARDIAN
///         STAKING, JBAC_VAULT, STAKING_ADMIN, FACTORY, ROUTER, PAIR, TWAP,
///         RESTAKING, REVENUE_DISTRIBUTOR, REFERRAL_SPLITTER, SWAP_FEE_ROUTER,
///         SWAP_FEE_ROUTER_ADMIN, POL_ACCUMULATOR
contract VerifyMVPScript is Script {

    function run() external view {
        // ─── Load env vars ────────────────────────────────────────────
        address treasury       = vm.envAddress("TREASURY");
        address multisig       = vm.envAddress("MULTISIG");
        address pauseGuardian  = vm.envAddress("PAUSE_GUARDIAN");

        address staking            = vm.envAddress("STAKING");
        address jbacVault          = vm.envAddress("JBAC_VAULT");
        address stakingAdmin       = vm.envAddress("STAKING_ADMIN");
        address factory            = vm.envAddress("FACTORY");
        address router             = vm.envAddress("ROUTER");
        address pair               = vm.envAddress("PAIR");
        address twap               = vm.envAddress("TWAP");
        address restaking          = vm.envAddress("RESTAKING");
        address revDist            = vm.envAddress("REVENUE_DISTRIBUTOR");
        address referralSplitter   = vm.envAddress("REFERRAL_SPLITTER");
        address swapFeeRouter      = vm.envAddress("SWAP_FEE_ROUTER");
        address swapFeeRouterAdmin = vm.envAddress("SWAP_FEE_ROUTER_ADMIN");
        address polAccumulator     = vm.envAddress("POL_ACCUMULATOR");

        // ─── INV-1: Three-multisig disjoint ───────────────────────────
        require(treasury != multisig,      "INV-1a: TREASURY == MULTISIG");
        require(treasury != pauseGuardian, "INV-1b: TREASURY == PAUSE_GUARDIAN");
        require(multisig != pauseGuardian, "INV-1c: MULTISIG == PAUSE_GUARDIAN");
        console.log("INV-1: three-multisig disjoint .................. OK");

        // ─── INV-2: Ownership transferred to multisig on every owned contract ─
        // Pending acceptance is allowed during the 14-day window; this check
        // asserts the FINAL state — multisig has accepted.
        require(Ownable(staking).owner()             == multisig, "INV-2a: staking owner != multisig");
        require(Ownable(stakingAdmin).owner()        == multisig, "INV-2b: stakingAdmin owner != multisig");
        require(Ownable(restaking).owner()           == multisig, "INV-2c: restaking owner != multisig");
        require(TegridyTWAP(payable(twap)).owner()   == multisig, "INV-2d: twap owner != multisig");
        require(Ownable(revDist).owner()             == multisig, "INV-2e: revDist owner != multisig");
        require(Ownable(swapFeeRouter).owner()       == multisig, "INV-2f: swapFeeRouter owner != multisig");
        require(Ownable(swapFeeRouterAdmin).owner()  == multisig, "INV-2g: swapFeeRouterAdmin owner != multisig");
        require(Ownable(polAccumulator).owner()      == multisig, "INV-2h: polAccumulator owner != multisig");
        require(Ownable(referralSplitter).owner()    == multisig, "INV-2i: referralSplitter owner != multisig");
        console.log("INV-2: ownership transferred to multisig ......... OK");

        // ─── INV-3: One-shot setters wired ────────────────────────────
        require(TegridyStaking(staking).jbacVault()     == jbacVault,    "INV-3a: staking.jbacVault unset");
        require(TegridyStaking(staking).stakingAdmin()  == stakingAdmin, "INV-3b: staking.stakingAdmin unset");
        require(SwapFeeRouter(payable(swapFeeRouter)).swapFeeRouterAdmin() == swapFeeRouterAdmin, "INV-3c: swapFeeRouter.swapFeeRouterAdmin unset");
        console.log("INV-3: one-shot setters wired .................... OK");

        // ─── INV-4: PauseGuardian wired on every Pausable MVP contract ──
        require(TegridyStaking(staking).pauseGuardian()                            == pauseGuardian, "INV-4a: staking.pauseGuardian unset");
        require(TegridyRestaking(restaking).pauseGuardian()                        == pauseGuardian, "INV-4b: restaking.pauseGuardian unset");
        require(RevenueDistributor(payable(revDist)).pauseGuardian()               == pauseGuardian, "INV-4c: revDist.pauseGuardian unset");
        require(SwapFeeRouter(payable(swapFeeRouter)).pauseGuardian()              == pauseGuardian, "INV-4d: swapFeeRouter.pauseGuardian unset");
        require(POLAccumulator(payable(polAccumulator)).pauseGuardian()            == pauseGuardian, "INV-4e: polAccumulator.pauseGuardian unset");
        console.log("INV-4: pauseGuardian wired on 5 contracts ........ OK");

        // ─── INV-5: Stake caps set ────────────────────────────────────
        // Caps must be > 0 (zero is forbidden by the setter — defense in
        // depth checks the deployed state matches the constructor defaults
        // OR a sane post-deploy override).
        require(TegridyStaking(staking).maxStakePerUser() > 0, "INV-5a: maxStakePerUser is zero");
        require(TegridyStaking(staking).maxTotalStaked()  > 0, "INV-5b: maxTotalStaked is zero");
        console.log("INV-5: stake caps non-zero ....................... OK");
        console.log("       maxStakePerUser:", TegridyStaking(staking).maxStakePerUser());
        console.log("       maxTotalStaked :", TegridyStaking(staking).maxTotalStaked());

        // ─── INV-6: Restaking paused at launch ────────────────────────
        // Phase 6: restaking deployed paused; opens at Phase 7.0.
        require(Pausable(restaking).paused(), "INV-6: restaking should be paused at launch");
        console.log("INV-6: restaking paused (opens Phase 7.0) ........ OK");

        // ─── INV-7: JBAC vault bound to staking ───────────────────────
        require(TegridyStakingJbacVault(jbacVault).staking() == staking, "INV-7: jbacVault not bound to staking");
        console.log("INV-7: jbacVault bound to staking ................ OK");

        // ─── INV-8: TWAP factory wired ────────────────────────────────
        require(address(TegridyTWAP(payable(twap)).factory()) == factory, "INV-8: twap.factory != factory");
        console.log("INV-8: twap factory wired ........................ OK");

        // ─── INV-9: TOWELI/WETH pair created ──────────────────────────
        require(pair != address(0), "INV-9: pair unset");
        console.log("INV-9: TOWELI/WETH pair set ...................... OK");

        // ─── INV-10: Pause-guardian distinct from owners (sanity) ─────
        // Already enforced by INV-1, repeated here so a guardian rotation
        // post-deploy that violates disjointness gets flagged loud.
        require(pauseGuardian != Ownable(staking).owner(), "INV-10: pauseGuardian == staking owner - disjoint violated");
        console.log("INV-10: pauseGuardian remains disjoint ........... OK");

        console.log("");
        console.log("=== ALL INVARIANTS GREEN ===");
        console.log("Treasury:        ", treasury);
        console.log("Multisig owner:  ", multisig);
        console.log("Pause Guardian:  ", pauseGuardian);
        console.log("");
        console.log("Safe to announce live. Monitor on Forta + Defender before TVL ramp.");
        // Silence unused-var lint
        router; referralSplitter;
    }
}
