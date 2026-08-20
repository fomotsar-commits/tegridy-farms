// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {DeployBaseMVPScript} from "../../script/base/DeployBaseMVP.s.sol";
import {VerifyBaseMVPScript} from "../../script/base/VerifyBaseMVP.s.sol";
import {BaseChainConfig} from "../../script/base/BaseChainConfig.sol";
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

/// @dev Minimal Chainlink L2 Sequencer Uptime feed reporting "up, long ago", which
///      is the healthy steady state for an event-driven feed.
contract MockSequencerFeed {
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, 0, block.timestamp - 30 days, block.timestamp - 30 days, 1);
    }
}

contract DeployBaseMVPTest is Test {
    DeployBaseMVPScript internal script;
    VerifyBaseMVPScript internal verifier;

    DummySafe internal treasury;
    DummySafe internal multisig;
    DummySafe internal pauseGuardian;
    DummySafe internal feeRemittance;

    function setUp() public {
        vm.chainId(BaseChainConfig.CHAIN_ID);

        script = new DeployBaseMVPScript();
        verifier = new VerifyBaseMVPScript();

        treasury = new DummySafe();
        multisig = new DummySafe();
        pauseGuardian = new DummySafe();
        feeRemittance = new DummySafe();

        // The canonical Base feed address has to carry code for the config check and
        // for any gated read the deployed contracts make.
        vm.etch(BaseChainConfig.SEQUENCER_UPTIME_FEED, address(new MockSequencerFeed()).code);
    }

    function _cfg() internal view returns (DeployBaseMVPScript.Config memory) {
        return DeployBaseMVPScript.Config({
            treasury: address(treasury),
            multisig: address(multisig),
            pauseGuardian: address(pauseGuardian),
            feeRemittance: address(feeRemittance),
            sequencerFeed: BaseChainConfig.SEQUENCER_UPTIME_FEED
        });
    }

    // ─── The guard that makes a mainnet misfire impossible ───────────

    function test_RefusesToRunOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(BaseChainConfig.NotBaseChain.selector, uint256(1)));
        script.runForTest(_cfg());
    }

    function test_RefusesEveryOtherChain() public {
        uint256[4] memory wrongChains = [uint256(10), 42161, 56, 84532];
        for (uint256 i = 0; i < wrongChains.length; i++) {
            vm.chainId(wrongChains[i]);
            vm.expectRevert(
                abi.encodeWithSelector(BaseChainConfig.NotBaseChain.selector, wrongChains[i])
            );
            script.runForTest(_cfg());
        }
    }

    // ─── Role checks ─────────────────────────────────────────────────

    function test_RefusesAnEOAInACustodyRole() public {
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.multisig = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(BaseChainConfig.NotAContract.selector, "MULTISIG", cfg.multisig)
        );
        script.runForTest(cfg);
    }

    function test_RefusesAnEIP7702DelegatedEOA() public {
        // 23 bytes: 0xef0100 followed by a 20-byte delegate. It has code and it is
        // still one key, which is exactly what a Safe is not.
        address delegated = makeAddr("delegated");
        vm.etch(delegated, hex"ef0100000000000000000000000000000000000000dead");
        assertEq(delegated.code.length, 23, "fixture must be a 23-byte designator");

        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.pauseGuardian = delegated;
        vm.expectRevert(
            abi.encodeWithSelector(BaseChainConfig.DelegatedEOA.selector, "PAUSE_GUARDIAN", delegated)
        );
        script.runForTest(cfg);
    }

    function test_RefusesZeroInACustodyRole() public {
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.feeRemittance = address(0);
        vm.expectRevert(abi.encodeWithSelector(BaseChainConfig.ZeroRole.selector, "FEE_REMITTANCE"));
        script.runForTest(cfg);
    }

    function test_RefusesNonDisjointOwnerAndGuardian() public {
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.pauseGuardian = cfg.multisig;
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseChainConfig.RolesNotDisjoint.selector, "MULTISIG", "PAUSE_GUARDIAN", cfg.multisig
            )
        );
        script.runForTest(cfg);
    }

    function test_RefusesRemittanceSharedWithTreasury() public {
        // The remitted balance is what a published bridge cadence is reconciled
        // against; a balance the treasury also spends from cannot be reconciled.
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.feeRemittance = cfg.treasury;
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseChainConfig.RolesNotDisjoint.selector, "FEE_REMITTANCE", "TREASURY", cfg.treasury
            )
        );
        script.runForTest(cfg);
    }

    function test_RefusesASequencerFeedWithNoCode() public {
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.sequencerFeed = makeAddr("typo");
        vm.expectRevert(
            abi.encodeWithSelector(BaseChainConfig.NotAContract.selector, "SEQUENCER_FEED", cfg.sequencerFeed)
        );
        script.runForTest(cfg);
    }

    function test_RefusesAZeroSequencerFeed() public {
        // On any chain but mainnet a zero feed is not a no-op: SequencerCheck reverts
        // SequencerFeedNotConfigured() at the first gated read, in production.
        DeployBaseMVPScript.Config memory cfg = _cfg();
        cfg.sequencerFeed = address(0);
        vm.expectRevert(abi.encodeWithSelector(BaseChainConfig.ZeroRole.selector, "SEQUENCER_FEED"));
        script.runForTest(cfg);
    }

    // ─── The deployment itself ───────────────────────────────────────

    function test_DeploysTheFiveContractsAndWiresThem() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());

        assertTrue(d.factory != address(0), "factory");
        assertTrue(d.router != address(0), "router");
        assertTrue(d.twap != address(0), "twap");
        assertTrue(d.swapFeeRouter != address(0), "swapFeeRouter");
        assertTrue(d.swapFeeRouterAdmin != address(0), "swapFeeRouterAdmin");

        assertEq(TegridyRouter(payable(d.router)).WETH(), BaseChainConfig.WETH, "Base WETH9");
        assertEq(TegridyRouter(payable(d.router)).factory(), d.factory, "router -> factory");
        assertEq(address(TegridyTWAP(payable(d.twap)).factory()), d.factory, "twap -> factory");
    }

    function test_SequencerFeedIsWiredOnBothOracleConsumers() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        assertEq(
            TegridyTWAP(payable(d.twap)).sequencerFeed(),
            BaseChainConfig.SEQUENCER_UPTIME_FEED,
            "twap feed"
        );
        // Audit H-13: this one is a post-construction one-shot and is the wire whose
        // omission stays invisible until the first fee conversion.
        assertEq(
            SwapFeeRouter(payable(d.swapFeeRouter)).sequencerFeed(),
            BaseChainConfig.SEQUENCER_UPTIME_FEED,
            "swapFeeRouter feed"
        );
    }

    function test_FeeSinkIsTheRemittanceSafeAndNothingElse() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        assertEq(
            SwapFeeRouter(payable(d.swapFeeRouter)).revenueDistributor(),
            address(feeRemittance),
            "sink is the remittance Safe"
        );
        assertEq(TegridyFactory(d.factory).feeTo(), address(feeRemittance), "factory feeTo");
    }

    function test_LeavesReferralAndPOLUnwiredBecauseThisChainHasNeither() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        SwapFeeRouter sfr = SwapFeeRouter(payable(d.swapFeeRouter));

        // A splitter pointed at a non-staking address would read votingPowerOf through
        // its catch arm and silently base-tier every referrer: a rail that looks live
        // and pays nobody. Absent is the honest state on a chain with no veTOWELI.
        assertEq(address(sfr.referralSplitter()), address(0), "no referral splitter");
        assertEq(sfr.polAccumulator(), address(0), "no POL accumulator");
    }

    function test_HoldsMainnetFeeParity() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        assertEq(SwapFeeRouter(payable(d.swapFeeRouter)).feeBps(), 50, "0.5% as on mainnet");
    }

    function test_GuardianIsTheSafeFromBlockOneWithNoRotationQueued() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        TegridyFactory factory = TegridyFactory(d.factory);

        assertEq(factory.guardian(), address(pauseGuardian), "guardian set at construction");
        // Audit F-30-10 makes acceptFeeToSetter force-cancel a pending GUARDIAN_CHANGE.
        // Queueing one at deploy would guarantee it dies at step 2 of the ceremony, so
        // nothing may be pending here.
        assertEq(factory.pendingGuardian(), address(0), "no rotation left to lose");
    }

    function test_OwnershipIsOfferedTwoStepAndNotYetHeld() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());

        // transferOwnership only OFFERS. Until the Safe accepts, the deployer still
        // owns these, which is the whole point of the two-step.
        assertEq(TegridyTWAP(payable(d.twap)).pendingOwner(), address(multisig), "twap offered");
        assertEq(SwapFeeRouter(payable(d.swapFeeRouter)).pendingOwner(), address(multisig), "sfr offered");
        assertEq(
            SwapFeeRouterAdmin(d.swapFeeRouterAdmin).pendingOwner(), address(multisig), "sfrAdmin offered"
        );
        assertTrue(TegridyTWAP(payable(d.twap)).owner() != address(multisig), "not yet held");

        assertEq(TegridyFactory(d.factory).pendingFeeToSetter(), address(multisig), "setter offered");
    }

    // ─── Verify, after the ceremony ──────────────────────────────────

    function test_VerifyIsGreenOnlyAfterTheSafeCompletesTheCeremony() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());

        // Before acceptance, verification must fail — a half-finished ceremony is not
        // a deployment anyone may point a surface at.
        vm.expectRevert(bytes("B-INV-3a: twap owner != multisig"));
        _verify(d);

        _completeCeremony(d);
        _verify(d);
    }

    function test_VerifyRefusesAChainThatIsNotBase() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        vm.chainId(1);
        vm.expectRevert(bytes("B-INV-0: not Base (8453)"));
        _verify(d);
    }

    function test_VerifyRejectsALaterReferralSplitterWiring() public {
        DeployBaseMVPScript.Deployed memory d = script.runForTest(_cfg());
        _completeCeremony(d);

        // The absence is load-bearing, so guard it rather than trusting that nobody
        // will helpfully fill it in. Simulated by writing the slot directly: the point
        // is that verification catches the state, whatever road it arrived by.
        vm.mockCall(
            d.swapFeeRouter,
            abi.encodeWithSignature("referralSplitter()"),
            abi.encode(address(0xBEEF))
        );
        vm.expectRevert(
            bytes("B-INV-10: referral splitter wired on a chain with no veTOWELI to tier against")
        );
        _verify(d);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _verify(DeployBaseMVPScript.Deployed memory d) internal view {
        verifier.check(
            address(treasury),
            address(multisig),
            address(pauseGuardian),
            address(feeRemittance),
            d.factory,
            d.router,
            d.twap,
            d.swapFeeRouter,
            d.swapFeeRouterAdmin
        );
    }

    /// @dev What the operator runbook asks of the Safe: accept the three ownerships,
    ///      then accept feeToSetter once the factory's 48h delay has elapsed.
    function _completeCeremony(DeployBaseMVPScript.Deployed memory d) internal {
        vm.startPrank(address(multisig));
        TegridyTWAP(payable(d.twap)).acceptOwnership();
        SwapFeeRouter(payable(d.swapFeeRouter)).acceptOwnership();
        SwapFeeRouterAdmin(d.swapFeeRouterAdmin).acceptOwnership();
        vm.stopPrank();

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(address(multisig));
        TegridyFactory(d.factory).acceptFeeToSetter();
    }
}
