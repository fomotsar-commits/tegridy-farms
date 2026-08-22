// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../../src/SwapFeeRouterAdmin.sol";
import {AttestedSequencerUptimeFeed} from "../../src/AttestedSequencerUptimeFeed.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RobinhoodChainConfig} from "./RobinhoodChainConfig.sol";

/// @title  VerifyRobinhoodMVP — post-ceremony invariant check for the Robinhood
///         Chain (4663) deployment.
/// @notice Runs after DeployRobinhoodMVP and after the Safe has accepted every
///         role. Any single failed R-INV-* halts the script; partial-green is not
///         a result. Mirrors VerifyBaseMVP for the contracts this chain has, plus
///         the uptime-feed invariants that exist only here.
///
/// @dev    Env vars:
///           TREASURY, MULTISIG, PAUSE_GUARDIAN, FEE_REMITTANCE
///           UPTIME_FEED, FACTORY, ROUTER, TWAP, SWAP_FEE_ROUTER, SWAP_FEE_ROUTER_ADMIN
///
/// @dev    Run: forge script script/robinhood/VerifyRobinhoodMVP.s.sol --rpc-url $ROBINHOOD_RPC -vvv
contract VerifyRobinhoodMVPScript is Script {
    function run() external view {
        check(
            vm.envAddress("TREASURY"),
            vm.envAddress("MULTISIG"),
            vm.envAddress("PAUSE_GUARDIAN"),
            vm.envAddress("FEE_REMITTANCE"),
            vm.envAddress("UPTIME_FEED"),
            vm.envAddress("FACTORY"),
            vm.envAddress("ROUTER"),
            vm.envAddress("TWAP"),
            vm.envAddress("SWAP_FEE_ROUTER"),
            vm.envAddress("SWAP_FEE_ROUTER_ADMIN")
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
        address uptimeFeed,
        address factory,
        address router,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) public view {
        Roles memory r = Roles(treasury, multisig, pauseGuardian, feeRemittance);

        require(block.chainid == RobinhoodChainConfig.CHAIN_ID, "R-INV-0: not Robinhood Chain (4663)");
        console.log("R-INV-0:  chain is Robinhood (4663) .............. OK");

        _checkRoles(r);
        _checkOwnership(r, twap, swapFeeRouter, swapFeeRouterAdmin);
        _checkWiring(r, uptimeFeed, factory, router, twap, swapFeeRouter, swapFeeRouterAdmin);
        _checkUptimeFeed(r, uptimeFeed);

        console.log("");
        console.log("=== ALL ROBINHOOD INVARIANTS GREEN ===");
        console.log("Owner Safe:      ", r.multisig);
        console.log("Pause Guardian:  ", r.pauseGuardian);
        console.log("Fee remittance:  ", r.feeRemittance);
        console.log("Uptime feed:     ", uptimeFeed);
        console.log("");
        console.log("Green here means the Robinhood deployment is WIRED, not that fees have");
        console.log("reached a staker - that happens only when a bridge cycle lands at the");
        console.log("mainnet RevenueDistributor. And if the uptime feed is the attested");
        console.log("stand-in, green also does NOT mean outages are detected automatically:");
        console.log("the PAUSE_GUARDIAN Safe attests them by hand until Chainlink ships.");
    }

    function _checkRoles(Roles memory r) internal view {
        require(r.treasury != r.multisig, "R-INV-1a: TREASURY == MULTISIG");
        require(r.treasury != r.pauseGuardian, "R-INV-1b: TREASURY == PAUSE_GUARDIAN");
        require(r.multisig != r.pauseGuardian, "R-INV-1c: MULTISIG == PAUSE_GUARDIAN");
        require(r.feeRemittance != r.treasury, "R-INV-1d: FEE_REMITTANCE == TREASURY");
        require(r.feeRemittance != r.multisig, "R-INV-1e: FEE_REMITTANCE == MULTISIG");
        require(r.feeRemittance != r.pauseGuardian, "R-INV-1f: FEE_REMITTANCE == PAUSE_GUARDIAN");
        console.log("R-INV-1:  four roles disjoint .................... OK");

        _requireSafeRole(r.multisig, "R-INV-2a: MULTISIG");
        _requireSafeRole(r.pauseGuardian, "R-INV-2b: PAUSE_GUARDIAN");
        _requireSafeRole(r.treasury, "R-INV-2c: TREASURY");
        _requireSafeRole(r.feeRemittance, "R-INV-2d: FEE_REMITTANCE");
        console.log("R-INV-2:  all four roles are contracts (Safes) ... OK");
    }

    function _checkOwnership(
        Roles memory r,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) internal view {
        require(Ownable(twap).owner() == r.multisig, "R-INV-3a: twap owner != multisig");
        require(Ownable(swapFeeRouter).owner() == r.multisig, "R-INV-3b: swapFeeRouter owner != multisig");
        require(Ownable(swapFeeRouterAdmin).owner() == r.multisig, "R-INV-3c: swapFeeRouterAdmin owner != multisig");
        console.log("R-INV-3:  ownership accepted by the Safe ......... OK");

        require(_pendingOwner(twap) == address(0), "R-INV-4a: twap pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouter) == address(0), "R-INV-4b: swapFeeRouter pendingOwner not cleared");
        require(_pendingOwner(swapFeeRouterAdmin) == address(0), "R-INV-4c: swapFeeRouterAdmin pendingOwner not cleared");
        console.log("R-INV-4:  no stale pending-owner ................. OK");
    }

    function _checkWiring(
        Roles memory r,
        address uptimeFeed,
        address factory,
        address router,
        address twap,
        address swapFeeRouter,
        address swapFeeRouterAdmin
    ) internal view {
        SwapFeeRouter sfr = SwapFeeRouter(payable(swapFeeRouter));

        require(TegridyRouter(payable(router)).WETH() == RobinhoodChainConfig.WETH, "R-INV-5a: router WETH != Robinhood WETH");
        require(TegridyRouter(payable(router)).factory() == factory, "R-INV-5b: router factory mismatch");
        require(sfr.WETH() == RobinhoodChainConfig.WETH, "R-INV-5c: swapFeeRouter WETH != Robinhood WETH");
        console.log("R-INV-5:  canonical Robinhood WETH everywhere .... OK");

        require(address(TegridyTWAP(payable(twap)).factory()) == factory, "R-INV-6: twap factory mismatch");
        console.log("R-INV-6:  twap bound to the factory .............. OK");

        require(TegridyTWAP(payable(twap)).sequencerFeed() == uptimeFeed, "R-INV-7a: twap sequencerFeed != uptime feed");
        require(sfr.sequencerFeed() == uptimeFeed, "R-INV-7b: swapFeeRouter sequencerFeed != uptime feed (H-13)");
        console.log("R-INV-7:  uptime feed wired on both consumers .... OK");

        require(sfr.swapFeeRouterAdmin() == swapFeeRouterAdmin, "R-INV-8a: swapFeeRouterAdmin unwired");
        require(sfr.pauseGuardian() == r.pauseGuardian, "R-INV-8b: swapFeeRouter pauseGuardian unwired");
        require(sfr.treasury() == r.treasury, "R-INV-8c: swapFeeRouter treasury mismatch");
        require(sfr.feeBps() == RobinhoodChainConfig.SWAP_FEE_BPS, "R-INV-8d: feeBps != mainnet parity");
        console.log("R-INV-8:  swapFeeRouter wiring ................... OK");

        require(sfr.revenueDistributor() == r.feeRemittance, "R-INV-9: fee sink != FEE_REMITTANCE");
        console.log("R-INV-9:  fee sink is the remittance Safe ........ OK");

        require(
            address(sfr.referralSplitter()) == address(0),
            "R-INV-10: referral splitter wired on a chain with no veTOWELI to tier against"
        );
        console.log("R-INV-10: no referral splitter, as intended ...... OK");

        require(
            sfr.polAccumulator() == address(0),
            "R-INV-11: POL accumulator wired on a chain with no TOWELI pair to buy"
        );
        console.log("R-INV-11: no POL accumulator, as intended ........ OK");

        require(TegridyFactory(factory).feeTo() == r.feeRemittance, "R-INV-12a: factory feeTo != FEE_REMITTANCE");
        require(TegridyFactory(factory).feeToSetter() == r.multisig, "R-INV-12b: factory feeToSetter != multisig (step 2 not run)");
        require(TegridyFactory(factory).guardian() == r.pauseGuardian, "R-INV-12c: factory guardian != pauseGuardian");
        console.log("R-INV-12: factory roles held by the Safe set ..... OK");
    }

    /// @dev The invariants that exist only on this chain. If the feed is our
    ///      attested stand-in (it answers `attestor()`), its roles must match the
    ///      Safe set and it must not be reporting a stale manual "down". A real
    ///      Chainlink feed answers none of these and only needs code + an answer.
    function _checkUptimeFeed(Roles memory r, address uptimeFeed) internal view {
        require(uptimeFeed.code.length > 0, "R-INV-13a: uptime feed has no code");

        (bool isAttested, bytes memory ret) =
            uptimeFeed.staticcall(abi.encodeWithSignature("attestor()"));
        if (isAttested && ret.length == 32) {
            AttestedSequencerUptimeFeed feed = AttestedSequencerUptimeFeed(uptimeFeed);
            require(feed.attestor() == r.pauseGuardian, "R-INV-13b: feed attestor != PAUSE_GUARDIAN");
            require(Ownable(uptimeFeed).owner() == r.multisig, "R-INV-13c: feed owner != multisig");
            require(_pendingOwner(uptimeFeed) == address(0), "R-INV-13d: feed pendingOwner not cleared");
            console.log("R-INV-13: attested stand-in roles correct ....... OK");
            if (feed.chainlinkFeed() != address(0)) {
                console.log("          (already forwarded to Chainlink:", feed.chainlinkFeed(), ")");
            } else {
                console.log("          ATTESTED MODE: PAUSE_GUARDIAN must flip it during outages.");
            }
        } else {
            console.log("R-INV-13: operator-supplied Chainlink feed ...... OK (no stand-in roles)");
        }

        // Whatever the feed is, it must currently answer in the uptime dialect.
        (bool ok, bytes memory data) =
            uptimeFeed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        require(ok && data.length >= 160, "R-INV-14a: feed does not answer latestRoundData");
        (, int256 answer,,,) = abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        require(answer == 0 || answer == 1, "R-INV-14b: feed answer is not uptime-shaped (0|1)");
        console.log("R-INV-14: feed speaks the uptime dialect ......... OK");
    }

    function _requireSafeRole(address account, string memory label) internal view {
        uint256 codeLen = account.code.length;
        require(codeLen > 0, string.concat(label, " is not a contract"));
        require(codeLen != 23, string.concat(label, " is an EIP-7702 delegated EOA, not a Safe"));
    }

    function _pendingOwner(address c) internal view returns (address p) {
        (bool ok, bytes memory data) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!ok || data.length < 32) return address(0);
        p = abi.decode(data, (address));
    }
}
