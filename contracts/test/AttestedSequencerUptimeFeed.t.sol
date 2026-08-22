// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {AttestedSequencerUptimeFeed, IAggregatorV3Minimal} from "../src/AttestedSequencerUptimeFeed.sol";
import {SequencerCheck} from "../src/lib/SequencerCheck.sol";

/// @dev Multisig-class stand-in: any non-trivial bytecode passes codeLen ∉ {0, 23}.
contract DummySafe {
    fallback() external {}
}

/// @dev A fake Chainlink uptime feed for the forwarding path.
contract FakeChainlinkUptimeFeed {
    int256 public answer;
    uint256 public startedAt;

    function set(int256 _answer, uint256 _startedAt) external {
        answer = _answer;
        startedAt = _startedAt;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (7, answer, startedAt, startedAt, 7);
    }
}

/// @dev A contract that is NOT an uptime feed (latestRoundData answers 42) —
///      forwardTo must reject it.
contract NotAnUptimeFeed {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 42, 0, 0, 1);
    }
}

/// @dev Harness so the library's reverts surface as external-call reverts.
contract SequencerCheckHarness {
    function check(address feed, uint256 grace, uint256 maxStale) external view {
        SequencerCheck.checkSequencerUp(feed, grace, maxStale);
    }
}

/// @title AttestedSequencerUptimeFeed tests — the contract exists so chains
///        without Chainlink (Robinhood, 4663) can run SequencerCheck-gated code.
///        The load-bearing property is therefore CONSUMER parity: SequencerCheck
///        itself, pointed at this feed, must behave exactly as it does against a
///        real Chainlink uptime feed through down/up/grace transitions.
contract AttestedSequencerUptimeFeedTest is Test {
    AttestedSequencerUptimeFeed feed;
    SequencerCheckHarness harness;
    DummySafe attestor;
    DummySafe otherSafe;

    uint256 constant GRACE = 1 hours;
    uint256 constant MAX_STALE = 4 hours;

    function setUp() public {
        // SequencerCheck's zero-feed carve-out is chainid==1 only; run everything
        // on the Robinhood chain id so the tests exercise the L2 code path.
        vm.chainId(4663);
        attestor = new DummySafe();
        otherSafe = new DummySafe();
        feed = new AttestedSequencerUptimeFeed(address(attestor));
        harness = new SequencerCheckHarness();
    }

    // ─── Constructor ──────────────────────────────────────────────────

    function test_constructor_startsUp_asOfDeploy() public view {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(answer, 0, "must start up");
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
        assertEq(roundId, 1);
        assertEq(answeredInRound, 1);
    }

    function test_constructor_rejectsEOAAttestor() public {
        vm.expectRevert(
            abi.encodeWithSelector(AttestedSequencerUptimeFeed.NotMultisigClass.selector, makeAddr("eoa"))
        );
        new AttestedSequencerUptimeFeed(makeAddr("eoa"));
    }

    function test_constructor_rejects7702Attestor() public {
        address delegated = makeAddr("delegated");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", bytes20(address(0xBEEF)))); // 23 bytes
        vm.expectRevert(
            abi.encodeWithSelector(AttestedSequencerUptimeFeed.NotMultisigClass.selector, delegated)
        );
        new AttestedSequencerUptimeFeed(delegated);
    }

    // ─── Consumer parity: SequencerCheck against this feed ────────────

    // via_ir folds `block.timestamp` across vm.warp() — and it folds THROUGH
    // locals: `uint256 t0 = block.timestamp` is re-materialized as a live
    // TIMESTAMP opcode at every use site, so warp targets derived from t0 drift
    // with each warp (observed here: an intended warp(10800) landed at 18000).
    // See reference_via_ir_timestamp_cse. The only safe clock in a multi-warp
    // via_ir test is LITERAL absolute times. setUp deploys at t = 1.
    uint256 constant T_DEPLOY = 1;
    uint256 constant T_OUTAGE = 50_000; // comfortably past the deploy grace
    uint256 constant T_RESUME = T_OUTAGE + 1 hours;

    function test_consumer_deployGrace_thenClean() public {
        // Within GRACE of deploy: post-resume settling → rejected.
        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        harness.check(address(feed), GRACE, MAX_STALE);

        // After the grace: clean read.
        vm.warp(T_DEPLOY + GRACE);
        harness.check(address(feed), GRACE, MAX_STALE);
    }

    function test_consumer_downBlocks_resumeGates_thenClean() public {
        // Attested down → SequencerDown.
        vm.warp(T_OUTAGE);
        vm.prank(address(attestor));
        feed.setStatus(true);
        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        harness.check(address(feed), GRACE, MAX_STALE);

        // Still down an hour later.
        vm.warp(T_RESUME);
        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        harness.check(address(feed), GRACE, MAX_STALE);

        // Attested back up at T_RESUME → grace runs from the flip, not from the
        // outage start.
        vm.prank(address(attestor));
        feed.setStatus(false);
        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        harness.check(address(feed), GRACE, MAX_STALE);

        vm.warp(T_RESUME + GRACE - 1);
        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        harness.check(address(feed), GRACE, MAX_STALE);

        vm.warp(T_RESUME + GRACE);
        harness.check(address(feed), GRACE, MAX_STALE);
    }

    // ─── setStatus auth + semantics ───────────────────────────────────

    function test_setStatus_attestorOnly() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(AttestedSequencerUptimeFeed.NotAttestor.selector);
        feed.setStatus(true);

        // The owner is NOT the attestor: role split is deliberate.
        vm.expectRevert(AttestedSequencerUptimeFeed.NotAttestor.selector);
        feed.setStatus(true);
    }

    function test_setStatus_sameValueRejected_graceCannotBeRestarted() public {
        // Re-attesting "up" would reset startedAt and re-arm every consumer's
        // grace window — the same-value reject closes that griefing lever.
        vm.prank(address(attestor));
        vm.expectRevert(AttestedSequencerUptimeFeed.SameStatus.selector);
        feed.setStatus(false);
    }

    function test_setStatus_bumpsRoundAndTimestamps() public {
        vm.warp(T_OUTAGE);
        vm.prank(address(attestor));
        feed.setStatus(true);
        (uint80 roundId, int256 answer, uint256 startedAt,,) = feed.latestRoundData();
        assertEq(answer, 1);
        assertEq(startedAt, T_OUTAGE);
        assertEq(roundId, 2);
    }

    // ─── Attestor rotation ────────────────────────────────────────────

    function test_setAttestor_ownerOnly_multisigClass_takesEffect() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(); // OZ Ownable revert
        feed.setAttestor(address(otherSafe));

        vm.expectRevert(
            abi.encodeWithSelector(AttestedSequencerUptimeFeed.NotMultisigClass.selector, makeAddr("eoa"))
        );
        feed.setAttestor(makeAddr("eoa"));

        vm.expectRevert(AttestedSequencerUptimeFeed.SameAttestor.selector);
        feed.setAttestor(address(attestor));

        feed.setAttestor(address(otherSafe));
        assertEq(feed.attestor(), address(otherSafe));

        // Old attestor is dead, new one works.
        vm.prank(address(attestor));
        vm.expectRevert(AttestedSequencerUptimeFeed.NotAttestor.selector);
        feed.setStatus(true);
        vm.prank(address(otherSafe));
        feed.setStatus(true);
    }

    // ─── One-shot forwarding to a real Chainlink feed ─────────────────

    function test_forwardTo_passthrough_manualControlsDead() public {
        FakeChainlinkUptimeFeed cl = new FakeChainlinkUptimeFeed();
        cl.set(0, block.timestamp);

        feed.forwardTo(address(cl));
        assertEq(feed.chainlinkFeed(), address(cl));

        // Reads now come from the Chainlink feed verbatim.
        cl.set(1, 12345);
        (uint80 roundId, int256 answer, uint256 startedAt,,) = feed.latestRoundData();
        assertEq(answer, 1);
        assertEq(startedAt, 12345);
        assertEq(roundId, 7);

        // Attestation is dead forever.
        vm.prank(address(attestor));
        vm.expectRevert(AttestedSequencerUptimeFeed.AlreadyForwarded.selector);
        feed.setStatus(false);

        // And forwarding is one-shot.
        vm.expectRevert(AttestedSequencerUptimeFeed.AlreadyForwarded.selector);
        feed.forwardTo(address(cl));
    }

    function test_forwardTo_rejectsNonFeed_andEOA_andOwnerGate() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(); // OZ Ownable revert
        feed.forwardTo(address(otherSafe));

        vm.expectRevert(
            abi.encodeWithSelector(AttestedSequencerUptimeFeed.NotMultisigClass.selector, makeAddr("eoa"))
        );
        feed.forwardTo(makeAddr("eoa"));

        // Has code, answers latestRoundData, but with a non-uptime answer → rejected.
        NotAnUptimeFeed impostor = new NotAnUptimeFeed();
        vm.expectRevert(
            abi.encodeWithSelector(AttestedSequencerUptimeFeed.ForwardTargetInvalid.selector, address(impostor))
        );
        feed.forwardTo(address(impostor));

        // Has code but no latestRoundData at all → the validation call reverts.
        vm.expectRevert();
        feed.forwardTo(address(otherSafe));
    }

    // ─── The reason this contract exists ──────────────────────────────

    function test_zeroFeed_stillRevertsOnL2_provingTheGap() public {
        // Without this contract, an L2 consumer has no legal configuration:
        // SequencerCheck refuses feed == 0 anywhere but mainnet (audit H-9).
        vm.expectRevert(SequencerCheck.SequencerFeedNotConfigured.selector);
        harness.check(address(0), GRACE, MAX_STALE);
    }
}
