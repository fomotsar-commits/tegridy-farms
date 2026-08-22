// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../../src/SwapFeeRouterAdmin.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseChainConfig} from "./BaseChainConfig.sol";

/// @title  VerifyBaseMVP — post-ceremony invariant check for the Base deployment.
/// @notice Runs after DeployBaseMVP and after the Safe has accepted every role.
///         Any single failed B-INV-* halts the script; partial-green is not a
///         result. Mirrors VerifyMVP.s.sol for the contracts Base actually has.
///
/// @dev    Two invariants here exist only on this chain, and they are the ones
///         worth reading twice:
///           B-INV-10 asserts the referral splitter is NOT wired, and
///           B-INV-11 asserts the POL accumulator is NOT wired.
///         Both are absences that a well-meaning later change would "fix" by
///         pointing them at something. On a chain with no veTOWELI and no TOWELI
///         pair, wiring either produces a rail that reads as working and pays
///         nobody, which is worse than the gap it closed.
///
/// @dev    Env vars:
///           TREASURY, MULTISIG, PAUSE_GUARDIAN, FEE_REMITTANCE
///           FACTORY, ROUTER, TWAP, SWAP_FEE_ROUTER, SWAP_FEE_ROUTER_ADMIN
///
/// @dev    Run: forge script script/base/VerifyBaseMVP.s.sol --rpc-url $BASE_RPC -vvv
contract VerifyBaseMVPScript is Script {
    function run() external view {
        address treasury = vm.envAddress("TREASURY");
        address multisig = vm.envAddress("MULTISIG");
        address pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        address feeRemittance = vm.envAddress("FEE_REMITTANCE");

        address factory = vm.envAddress("FACTORY");
        address router = vm.envAddress("ROUTER");
        address twap = vm.envAddress("TWAP");
        address swapFeeRouter = vm.envAddress("SWAP_FEE_ROUTER");
        address swapFeeRouterAdmin = vm.envAddress("SWAP_FEE_ROUTER_ADMIN");

        check(
            treasury,
            multisig,
            pauseGuardian,
            feeRemittance,
            factory,
            router,
            twap,
            swapFeeRouter,
            swapFeeRouterAdmin
        );
    }

    struct Roles {
        address treasury;
        address multisig;
        address pauseGuardian;
        address feeRemittance;
    }

    /// @notice Same checks as `run()` with the inventory passed in, so a forge test
    ///         can assert every invariant against a freshly-deployed set without
    ///         env-var state bleeding between cases.
    function check(
        address treasury,
        address multisig,
        address pauseGuardian,
        address feeRemittance,
        address factory,
        address router,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) public view {
        Roles memory r = Roles(treasury, multisig, pauseGuardian, feeRemittance);

        // ─── B-INV-0: right chain ─────────────────────────────────────
        require(block.chainid == BaseChainConfig.CHAIN_ID, "B-INV-0: not Base (8453)");
        console.log("B-INV-0:  chain is Base (8453) ................... OK");

        _checkRoles(r);
        _checkOwnership(r, twap, swapFeeRouter, swapFeeRouterAdmin);
        _checkWiring(r, factory, router, twap, swapFeeRouter, swapFeeRouterAdmin);

        console.log("");
        console.log("=== ALL BASE INVARIANTS GREEN ===");
        console.log("Owner Safe:      ", r.multisig);
        console.log("Pause Guardian:  ", r.pauseGuardian);
        console.log("Fee remittance:  ", r.feeRemittance);
        console.log("");
        console.log("Green here means the Base deployment is WIRED, not that Base fees have");
        console.log("reached a staker. That happens only when a bridge cycle lands at the");
        console.log("mainnet RevenueDistributor and reconciles. Surfaces must say so.");
    }

    function _checkRoles(Roles memory r) internal view {
        require(r.treasury != r.multisig, "B-INV-1a: TREASURY == MULTISIG");
        require(r.treasury != r.pauseGuardian, "B-INV-1b: TREASURY == PAUSE_GUARDIAN");
        require(r.multisig != r.pauseGuardian, "B-INV-1c: MULTISIG == PAUSE_GUARDIAN");
        require(r.feeRemittance != r.treasury, "B-INV-1d: FEE_REMITTANCE == TREASURY");
        require(r.feeRemittance != r.multisig, "B-INV-1e: FEE_REMITTANCE == MULTISIG");
        require(r.feeRemittance != r.pauseGuardian, "B-INV-1f: FEE_REMITTANCE == PAUSE_GUARDIAN");
        console.log("B-INV-1:  four roles disjoint .................... OK");

        // An EOA in any of these slots is the failure mode the Squads loss and the
        // 0xA360 signer-set finding both share. Code presence is the half a script
        // can prove; proven signers is the operator's half.
        _requireSafeRole(r.multisig, "B-INV-2a: MULTISIG");
        _requireSafeRole(r.pauseGuardian, "B-INV-2b: PAUSE_GUARDIAN");
        _requireSafeRole(r.treasury, "B-INV-2c: TREASURY");
        _requireSafeRole(r.feeRemittance, "B-INV-2d: FEE_REMITTANCE");
        console.log("B-INV-2:  all four roles are contracts (Safes) ... OK");
    }

    function _checkOwnership(
        Roles memory r,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) internal view {
        require(Ownable(twap).owner() == r.multisig, "B-INV-3a: twap owner != multisig");
        require(Ownable(swapFeeRouter).owner() == r.multisig, "B-INV-3b: swapFeeRouter owner != multisig");
        require(Ownable(swapFeeRouterAdmin).owner() == r.multisig, "B-INV-3c: swapFeeRouterAdmin owner != multisig");
        console.log("B-INV-3:  ownership accepted by the Safe ......... OK");

        // A pendingOwner the Safe never accepted rots silently: INV-3 can pass on a
        // re-transferred contract while a stale offer still sits in the slot.
        require(_pendingOwner(twap) == address(0), "B-INV-4a: twap pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouter) == address(0), "B-INV-4b: swapFeeRouter pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouterAdmin) == address(0), "B-INV-4c: swapFeeRouterAdmin pendingOwner not cleared");
        console.log("B-INV-4:  no stale pending-owner ................. OK");
    }

    function _checkWiring(
        Roles memory r,
        address factory,
        address router,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) internal view {
        SwapFeeRouter sfr = SwapFeeRouter(payable(swapFeeRouter));

        require(TegridyRouter(payable(router)).WETH() == BaseChainConfig.WETH, "B-INV-5a: router WETH != Base WETH9");
        require(TegridyRouter(payable(router)).factory() == factory, "B-INV-5b: router factory mismatch");
        require(sfr.WETH() == BaseChainConfig.WETH, "B-INV-5c: swapFeeRouter WETH != Base WETH9");
        console.log("B-INV-5:  canonical Base WETH9 everywhere ........ OK");

        require(address(TegridyTWAP(payable(twap)).factory()) == factory, "B-INV-6: twap factory mismatch");
        console.log("B-INV-6:  twap bound to the factory .............. OK");

        // On any chain other than mainnet a zero feed is not a no-op — SequencerCheck
        // reverts SequencerFeedNotConfigured() rather than silently skipping.
        require(
            TegridyTWAP(payable(twap)).sequencerFeed() == BaseChainConfig.SEQUENCER_UPTIME_FEED,
            "B-INV-7a: twap sequencerFeed != canonical Base feed"
        );
        require(
            sfr.sequencerFeed() == BaseChainConfig.SEQUENCER_UPTIME_FEED,
            "B-INV-7b: swapFeeRouter sequencerFeed != canonical Base feed (H-13)"
        );
        console.log("B-INV-7:  Base sequencer feed wired on both ...... OK");

        require(sfr.swapFeeRouterAdmin() == swapFeeRouterAdmin, "B-INV-8a: swapFeeRouterAdmin unwired");
        require(sfr.pauseGuardian() == r.pauseGuardian, "B-INV-8b: swapFeeRouter pauseGuardian unwired");
        require(sfr.treasury() == r.treasury, "B-INV-8c: swapFeeRouter treasury mismatch");
        require(sfr.feeBps() == BaseChainConfig.SWAP_FEE_BPS, "B-INV-8d: feeBps != mainnet parity");
        console.log("B-INV-8:  swapFeeRouter wiring ................... OK");

        require(sfr.revenueDistributor() == r.feeRemittance, "B-INV-9: fee sink != FEE_REMITTANCE");
        console.log("B-INV-9:  fee sink is the remittance Safe ........ OK");
        console.log("          (a Safe, not a distributor - nothing on Base pays stakers)");

        require(
            address(sfr.referralSplitter()) == address(0),
            "B-INV-10: referral splitter wired on a chain with no veTOWELI to tier against"
        );
        console.log("B-INV-10: no referral splitter, as intended ...... OK");

        require(
            sfr.polAccumulator() == address(0),
            "B-INV-11: POL accumulator wired on a chain with no TOWELI pair to buy"
        );
        console.log("B-INV-11: no POL accumulator, as intended ........ OK");

        require(TegridyFactory(factory).feeTo() == r.feeRemittance, "B-INV-12a: factory feeTo != FEE_REMITTANCE");
        require(TegridyFactory(factory).feeToSetter() == r.multisig, "B-INV-12b: factory feeToSetter != multisig (step 2 not run)");
        // Set at construction, not rotated: audit F-30-10 makes `acceptFeeToSetter`
        // force-cancel a pending GUARDIAN_CHANGE, so a deploy-time proposal would be
        // destroyed by the Safe's own acceptance in step 2.
        require(TegridyFactory(factory).guardian() == r.pauseGuardian, "B-INV-12c: factory guardian != pauseGuardian");
        console.log("B-INV-12: factory roles held by the Safe set ..... OK");
    }

    /// @dev A role with 23 bytes of code is an EIP-7702 delegation designator: it has
    ///      code and it is still one key. TegridyFactory already refuses one as a
    ///      guardian (`codeLen != 23`); a custody role deserves the same test.
    function _requireSafeRole(address account, string memory label) internal view {
        uint256 codeLen = account.code.length;
        require(codeLen > 0, string.concat(label, " is not a contract"));
        require(codeLen != 23, string.concat(label, " is an EIP-7702 delegated EOA, not a Safe"));
    }

    /// @dev Staticcall so one helper covers every OwnableNoRenounce contract without
    ///      importing each one. A revert or short return reads as address(0), which
    ///      is only ever the passing value here.
    function _pendingOwner(address c) internal view returns (address p) {
        (bool ok, bytes memory data) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!ok || data.length < 32) return address(0);
        p = abi.decode(data, (address));
    }
}
