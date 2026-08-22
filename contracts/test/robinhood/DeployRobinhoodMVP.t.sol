// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {DeployRobinhoodMVPScript} from "../../script/robinhood/DeployRobinhoodMVP.s.sol";
import {VerifyRobinhoodMVPScript} from "../../script/robinhood/VerifyRobinhoodMVP.s.sol";
import {RobinhoodChainConfig} from "../../script/robinhood/RobinhoodChainConfig.sol";
import {AttestedSequencerUptimeFeed} from "../../src/AttestedSequencerUptimeFeed.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../../src/SwapFeeRouterAdmin.sol";

/// @dev Stand-in for a Gnosis Safe: needs code, and needs to accept plain ETH
///      within the 50k stipend SwapFeeRouter forwards to the fee sink.
contract DummySafe {
    receive() external payable {}
}

/// @dev Minimal Chainlink L2 Sequencer Uptime feed reporting "up, long ago" — the
///      healthy steady state for an event-driven feed. Used for the
///      operator-supplied-Chainlink path.
contract MockSequencerFeed {
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, 0, block.timestamp - 30 days, block.timestamp - 30 days, 1);
    }
}

contract DeployRobinhoodMVPTest is Test {
    DeployRobinhoodMVPScript internal script;
    VerifyRobinhoodMVPScript internal verifier;

    DummySafe internal treasury;
    DummySafe internal multisig;
    DummySafe internal pauseGuardian;
    DummySafe internal feeRemittance;

    function setUp() public {
        vm.chainId(RobinhoodChainConfig.CHAIN_ID);

        script = new DeployRobinhoodMVPScript();
        verifier = new VerifyRobinhoodMVPScript();

        treasury = new DummySafe();
        multisig = new DummySafe();
        pauseGuardian = new DummySafe();
        feeRemittance = new DummySafe();
    }

    /// @dev The expected path today: no Chainlink feed exists on 4663, so the
    ///      script deploys the attested stand-in.
    function _cfg() internal view returns (DeployRobinhoodMVPScript.Config memory) {
        return DeployRobinhoodMVPScript.Config({
            treasury: address(treasury),
            multisig: address(multisig),
            pauseGuardian: address(pauseGuardian),
            feeRemittance: address(feeRemittance),
            sequencerFeed: address(0)
        });
    }

    // ─── The guard that makes a mainnet misfire impossible ───────────

    function test_RefusesToRunOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChainConfig.NotRobinhoodChain.selector, uint256(1))
        );
        script.runForTest(_cfg());
    }

    function test_RefusesEveryOtherChain_IncludingTheTestnet() public {
        // 46630 is the Robinhood TESTNET — one digit away from a very expensive
        // "wrong universe" broadcast; it gets its own slot in the fixture.
        uint256[5] memory wrongChains = [uint256(10), 8453, 42161, 46630, 84532];
        for (uint256 i = 0; i < wrongChains.length; i++) {
            vm.chainId(wrongChains[i]);
            vm.expectRevert(
                abi.encodeWithSelector(RobinhoodChainConfig.NotRobinhoodChain.selector, wrongChains[i])
            );
            script.runForTest(_cfg());
        }
    }

    // ─── Role checks ─────────────────────────────────────────────────

    function test_RefusesAnEOAInACustodyRole() public {
        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.multisig = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChainConfig.NotAContract.selector, "MULTISIG", cfg.multisig)
        );
        script.runForTest(cfg);
    }

    function test_RefusesAnEIP7702DelegatedEOA() public {
        address delegated = makeAddr("delegated");
        vm.etch(delegated, hex"ef0100000000000000000000000000000000000000dead");
        assertEq(delegated.code.length, 23, "fixture must be a 23-byte designator");

        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.pauseGuardian = delegated;
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChainConfig.DelegatedEOA.selector, "PAUSE_GUARDIAN", delegated)
        );
        script.runForTest(cfg);
    }

    function test_RefusesZeroInACustodyRole() public {
        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.feeRemittance = address(0);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodChainConfig.ZeroRole.selector, "FEE_REMITTANCE"));
        script.runForTest(cfg);
    }

    function test_RefusesNonDisjointRoles() public {
        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.pauseGuardian = cfg.multisig;
        vm.expectRevert(
            abi.encodeWithSelector(
                RobinhoodChainConfig.RolesNotDisjoint.selector, "MULTISIG", "PAUSE_GUARDIAN", cfg.multisig
            )
        );
        script.runForTest(cfg);
    }

    function test_RefusesAClaimedChainlinkFeedWithNoCode() public {
        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.sequencerFeed = makeAddr("typo");
        vm.expectRevert(
            abi.encodeWithSelector(
                RobinhoodChainConfig.NotAContract.selector, "SEQUENCER_FEED", cfg.sequencerFeed
            )
        );
        script.runForTest(cfg);
    }

    // ─── The chain-specific piece: the attested uptime feed ──────────

    function test_DeploysTheAttestedFeedWhenChainlinkHasNone() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());

        assertTrue(d.uptimeFeedIsAttested, "stand-in path");
        AttestedSequencerUptimeFeed feed = AttestedSequencerUptimeFeed(d.uptimeFeed);
        assertEq(feed.attestor(), address(pauseGuardian), "attestor is the guardian Safe");
        assertEq(feed.chainlinkFeed(), address(0), "not forwarded at birth");
        assertEq(feed.pendingOwner(), address(multisig), "ownership offered to the Safe");

        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 0, "reports up from deploy");
    }

    function test_BothOracleConsumersPointAtTheAttestedFeed() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        assertEq(TegridyTWAP(payable(d.twap)).sequencerFeed(), d.uptimeFeed, "twap feed");
        assertEq(SwapFeeRouter(payable(d.swapFeeRouter)).sequencerFeed(), d.uptimeFeed, "sfr feed (H-13)");
    }

    function test_UsesTheOperatorFeedWhenOneIsSupplied() public {
        MockSequencerFeed chainlink = new MockSequencerFeed();
        DeployRobinhoodMVPScript.Config memory cfg = _cfg();
        cfg.sequencerFeed = address(chainlink);

        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(cfg);
        assertFalse(d.uptimeFeedIsAttested, "no stand-in deployed");
        assertEq(d.uptimeFeed, address(chainlink), "consumers wired to the real feed");
        assertEq(TegridyTWAP(payable(d.twap)).sequencerFeed(), address(chainlink));
    }

    // ─── The spine, same shape as Base ───────────────────────────────

    function test_DeploysTheSpineAndWiresIt() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());

        assertEq(TegridyRouter(payable(d.router)).WETH(), RobinhoodChainConfig.WETH, "Robinhood WETH");
        assertEq(TegridyRouter(payable(d.router)).factory(), d.factory, "router -> factory");
        assertEq(address(TegridyTWAP(payable(d.twap)).factory()), d.factory, "twap -> factory");
        assertEq(SwapFeeRouter(payable(d.swapFeeRouter)).feeBps(), 50, "0.5% as on mainnet");
    }

    function test_FeeSinkIsTheRemittanceSafe_NoReferral_NoPOL() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        SwapFeeRouter sfr = SwapFeeRouter(payable(d.swapFeeRouter));

        assertEq(sfr.revenueDistributor(), address(feeRemittance), "sink is the remittance Safe");
        assertEq(TegridyFactory(d.factory).feeTo(), address(feeRemittance), "factory feeTo");
        assertEq(address(sfr.referralSplitter()), address(0), "no referral splitter");
        assertEq(sfr.polAccumulator(), address(0), "no POL accumulator");
    }

    function test_GuardianIsTheSafeFromBlockOneWithNoRotationQueued() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        TegridyFactory factory = TegridyFactory(d.factory);

        assertEq(factory.guardian(), address(pauseGuardian), "guardian set at construction");
        // Audit F-30-10: a deploy-time GUARDIAN_CHANGE would be destroyed by the
        // Safe's own acceptFeeToSetter. Nothing may be pending here.
        assertEq(factory.pendingGuardian(), address(0), "no rotation left to lose");
    }

    function test_OwnershipIsOfferedTwoStepAndNotYetHeld() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());

        assertEq(TegridyTWAP(payable(d.twap)).pendingOwner(), address(multisig), "twap offered");
        assertEq(SwapFeeRouter(payable(d.swapFeeRouter)).pendingOwner(), address(multisig), "sfr offered");
        assertEq(SwapFeeRouterAdmin(d.swapFeeRouterAdmin).pendingOwner(), address(multisig), "sfrAdmin offered");
        assertEq(
            AttestedSequencerUptimeFeed(d.uptimeFeed).pendingOwner(), address(multisig), "feed offered"
        );
        assertTrue(TegridyTWAP(payable(d.twap)).owner() != address(multisig), "not yet held");
        assertEq(TegridyFactory(d.factory).pendingFeeToSetter(), address(multisig), "setter offered");
    }

    // ─── Verify, after the ceremony ──────────────────────────────────

    function test_VerifyIsGreenOnlyAfterTheSafeCompletesTheCeremony() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());

        vm.expectRevert(bytes("R-INV-3a: twap owner != multisig"));
        _verify(d);

        _completeCeremony(d);
        _verify(d);
    }

    function test_VerifyRefusesAChainThatIsNotRobinhood() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        vm.chainId(8453);
        vm.expectRevert(bytes("R-INV-0: not Robinhood Chain (4663)"));
        _verify(d);
    }

    function test_VerifyCatchesAWrongAttestor() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        // A later setAttestor to something outside the Safe set must fail verify:
        // whoever attests holds a guardian-class DoS lever over every gated path.
        DummySafe stranger = new DummySafe();
        vm.prank(address(multisig));
        AttestedSequencerUptimeFeed(d.uptimeFeed).setAttestor(address(stranger));

        vm.expectRevert(bytes("R-INV-13b: feed attestor != PAUSE_GUARDIAN"));
        _verify(d);
    }

    function test_VerifyAcceptsAForwardedFeed() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        // The day Chainlink ships: multisig forwards, verify stays green.
        // Absolute literal warp: the mock answers `block.timestamp - 30 days`,
        // which underflows on foundry's small default clock (and via_ir folds
        // relative warps — see reference_via_ir_timestamp_cse).
        vm.warp(100 days);
        MockSequencerFeed chainlink = new MockSequencerFeed();
        vm.prank(address(multisig));
        AttestedSequencerUptimeFeed(d.uptimeFeed).forwardTo(address(chainlink));

        _verify(d);
    }

    function test_VerifyRejectsALaterReferralSplitterWiring() public {
        DeployRobinhoodMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        vm.mockCall(
            d.swapFeeRouter,
            abi.encodeWithSignature("referralSplitter()"),
            abi.encode(address(0xBEEF))
        );
        vm.expectRevert(
            bytes("R-INV-10: referral splitter wired on a chain with no veTOWELI to tier against")
        );
        _verify(d);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _verify(DeployRobinhoodMVPScript.Deployed memory d) internal view {
        verifier.check(
            address(treasury),
            address(multisig),
            address(pauseGuardian),
            address(feeRemittance),
            d.uptimeFeed,
            d.factory,
            d.router,
            d.twap,
            d.swapFeeRouter,
            d.swapFeeRouterAdmin
        );
    }

    /// @dev What the operator runbook asks of the Safe: accept the four ownerships
    ///      (three spine contracts + the uptime feed), then accept feeToSetter once
    ///      the factory's delay has elapsed.
    function _completeCeremony(DeployRobinhoodMVPScript.Deployed memory d) internal {
        vm.startPrank(address(multisig));
        TegridyTWAP(payable(d.twap)).acceptOwnership();
        SwapFeeRouter(payable(d.swapFeeRouter)).acceptOwnership();
        SwapFeeRouterAdmin(d.swapFeeRouterAdmin).acceptOwnership();
        AttestedSequencerUptimeFeed(d.uptimeFeed).acceptOwnership();
        vm.stopPrank();

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(address(multisig));
        TegridyFactory(d.factory).acceptFeeToSetter();
    }
}
