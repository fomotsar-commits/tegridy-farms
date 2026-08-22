// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";
// TegridyRestaking import removed — deferred to Phase 7 (C1); not in the MVP verify set.
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
        // RESTAKING deferred to Phase 7 (C1) — not part of the MVP deploy/verify set.
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
        // AUDIT FIX 2026-05-26 [H-14]: assert ReferralSplitter setup finalized.
        // Without this, recordFee silently redirects to treasury and the entire
        // referral program is dead — INV-2/3 went green pre-fix even if the
        // operator skipped `splitter.completeSetup()` in DeployMVP.
        require(ReferralSplitter(payable(referralSplitter)).setupComplete(), "INV-3d: ReferralSplitter setup not completed");
        // AUDIT FIX 2026-05-26 [H-15]: assert SwapFeeRouter is on the approved-caller
        // allowlist. Pre-fix this could be silently missed and EVERY swap's referral
        // slice would land in the catch arm (try/catch fallback) instead of crediting
        // the legitimate referrer. Post-completeSetup the list is frozen, so this
        // check is permanent state.
        require(ReferralSplitter(payable(referralSplitter)).approvedCallers(swapFeeRouter), "INV-3e: ReferralSplitter has not approved SwapFeeRouter as caller");
        console.log("INV-3: one-shot setters wired .................... OK");

        // ─── INV-4: PauseGuardian wired on every Pausable MVP contract ──
        require(TegridyStaking(staking).pauseGuardian()                            == pauseGuardian, "INV-4a: staking.pauseGuardian unset");
        require(RevenueDistributor(payable(revDist)).pauseGuardian()               == pauseGuardian, "INV-4c: revDist.pauseGuardian unset");
        require(SwapFeeRouter(payable(swapFeeRouter)).pauseGuardian()              == pauseGuardian, "INV-4d: swapFeeRouter.pauseGuardian unset");
        require(POLAccumulator(payable(polAccumulator)).pauseGuardian()            == pauseGuardian, "INV-4e: polAccumulator.pauseGuardian unset");
        console.log("INV-4: pauseGuardian wired on 4 contracts ........ OK");

        // ─── INV-5: Stake caps set ────────────────────────────────────
        // Caps must be > 0 (zero is forbidden by the setter — defense in
        // depth checks the deployed state matches the constructor defaults
        // OR a sane post-deploy override).
        require(TegridyStaking(staking).maxStakePerUser() > 0, "INV-5a: maxStakePerUser is zero");
        require(TegridyStaking(staking).maxTotalStaked()  > 0, "INV-5b: maxTotalStaked is zero");
        console.log("INV-5: stake caps non-zero ....................... OK");
        console.log("       maxStakePerUser:", TegridyStaking(staking).maxStakePerUser());
        console.log("       maxTotalStaked :", TegridyStaking(staking).maxTotalStaked());

        // ─── INV-6: Restaking deferred to Phase 7 (C1) ────────────────
        // TegridyRestaking is not part of the MVP deploy set; its paused-at-launch
        // invariant moves to the Phase-7 verify script.

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

        // ─── INV-11: Factory rotation finalized (H-16) ────────────────
        // AUDIT FIX 2026-05-26 [H-16]: assert the three factory roles ended
        // up at multisig / revDist / pauseGuardian. Pre-fix, VerifyMVP went
        // green while the deployer EOA STILL controlled the factory because
        // the post-deploy timelock acceptances (steps 2 and 3 in the runbook)
        // are MANUAL. This INV catches "operator forgot the multisig
        // acceptance ceremony" before announce-live.
        //
        // INV-11c has no runbook step on a fresh deploy: DeployMVP constructs
        // TegridyFactory with PAUSE_GUARDIAN as `_guardian`, so this is true the
        // moment the factory exists. It used to name "runbook step 3b"
        // (`executeGuardianChange()`), which was UNREACHABLE — audit F-30-10 makes
        // `acceptFeeToSetter` (step 3) force-cancel the GUARDIAN_CHANGE the deploy
        // had queued, so step 3b always reverted NoPendingProposal and this
        // invariant could never go green by following the runbook it cited.
        require(TegridyFactory(factory).feeToSetter() == multisig, "INV-11a: factory.feeToSetter != multisig (runbook step 3 not run)");
        require(TegridyFactory(factory).feeTo() == revDist,        "INV-11b: factory.feeTo != revDist (runbook step 2 not run)");
        require(
            TegridyFactory(factory).guardian() == pauseGuardian,
            "INV-11c: factory.guardian != pauseGuardian (fresh deploys set it in the TegridyFactory constructor; on an already-deployed factory the multisig must call proposeGuardianChange AFTER acceptFeeToSetter, wait 48h, then executeGuardianChange - queuing it before the acceptance loses it to F-30-10)"
        );
        console.log("INV-11: factory rotation finalized ............... OK");

        // ─── INV-12: Pending-owner cleared on every owned contract (H-12) ──
        // AUDIT FIX 2026-05-26 [H-12]: assert that NO contract has a stale
        // `pendingOwner` slot. INV-2 catches owner == multisig but not
        // pendingOwner != address(0). A stale pendingOwner that the multisig
        // forgot to accept is silent-rot — recovery requires another transferOwnership
        // cycle and the 14-day expiry window. Loud check here per the OwnableNoRenounce
        // M-20 family.
        require(_pendingOwner(staking) == address(0),            "INV-12a: staking pendingOwner not cleared");
        require(_pendingOwner(stakingAdmin) == address(0),       "INV-12b: stakingAdmin pendingOwner not cleared");
        require(_pendingOwner(twap) == address(0),               "INV-12c: twap pendingOwner not cleared");
        require(_pendingOwner(revDist) == address(0),            "INV-12d: revDist pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouter) == address(0),      "INV-12e: swapFeeRouter pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouterAdmin) == address(0), "INV-12f: swapFeeRouterAdmin pendingOwner not cleared");
        require(_pendingOwner(polAccumulator) == address(0),     "INV-12g: polAccumulator pendingOwner not cleared");
        require(_pendingOwner(referralSplitter) == address(0),   "INV-12h: referralSplitter pendingOwner not cleared");
        console.log("INV-12: pending-owner cleared (no stale pending) . OK");

        // ─── INV-13: Sequencer feed wired on L2 SwapFeeRouter (H-13) ──────
        // AUDIT FIX 2026-05-26 [H-13]: on L2 deploys, `sequencerFeed` MUST
        // be set on SwapFeeRouter — the one-shot setter is silently missed
        // by DeployMVP otherwise. Mainnet (chainid == 1) is a no-op (feed
        // remains address(0) by design).
        if (block.chainid != 1) {
            require(SwapFeeRouter(payable(swapFeeRouter)).sequencerFeed() != address(0), "INV-13: L2 swapFeeRouter.sequencerFeed unset");
            console.log("INV-13: L2 sequencerFeed wired ................... OK");
        }

        // ─── INV-14: SFR revenueDistributor wired at construction (DEPLOY-H1) ──
        // AUDIT FIX 2026-05-27 [DEPLOY-H1]: revenueDistributor is now set in the
        // SwapFeeRouter constructor — governance rotation via applyRevenueDistributor
        // after an acceptOwnership flush was provably impossible. Assert the
        // constructor actually wired it to the expected RevenueDistributor.
        require(
            SwapFeeRouter(payable(swapFeeRouter)).revenueDistributor() == revDist,
            "INV-14: swapFeeRouter.revenueDistributor != revDist (constructor wiring failed)"
        );
        console.log("INV-14: SFR revenueDistributor wired at construction . OK");

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

    /// @dev AUDIT FIX 2026-05-26 [H-12]: read Ownable2Step pending owner via
    ///      staticcall so we can use the same helper across every owned
    ///      contract without importing OwnableNoRenounce. Returns address(0)
    ///      when the call reverts or returns garbage — fail-closed only when
    ///      the caller's `require` checks expect a non-zero address.
    function _pendingOwner(address c) internal view returns (address p) {
        (bool ok, bytes memory data) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!ok || data.length < 32) return address(0);
        p = abi.decode(data, (address));
    }
}
