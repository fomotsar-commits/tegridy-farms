// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/lib/SequencerCheck.sol";

/// @title AUDIT FIX 2026-07-12 — L2 Sequencer Uptime feed must NOT be
///        heartbeat/staleness-checked.
/// @notice The Chainlink L2 Sequencer Uptime Feed is EVENT-DRIVEN: a new round
///         is written ONLY on an up→down / down→up transition. During healthy
///         continuous uptime `updatedAt` legitimately stays hours-to-weeks old.
///         The pre-fix `block.timestamp - updatedAt > staleness` reject therefore
///         reverted every gated read a few hours after any L2 deploy.
///
///         These tests configure the mock feed as UP, with the post-resume grace
///         window long elapsed, but with a legitimately-OLD `updatedAt`. Under
///         the OLD behaviour every helper here fails closed (revert / outage /
///         fail-closed sentinel). Under the FIX they all report "healthy".
contract MockUptimeFeedControllableUpdatedAt {
    uint80 public roundId = 1;
    int256 public answer; // 0 = up, 1 = down
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    function set(int256 _answer, uint256 _startedAt, uint256 _updatedAt) external {
        answer = _answer;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

/// @dev Thin external harness: SequencerCheck's functions are `internal`, so we
///      wrap each one to make it callable from the test (and to let
///      `vm.expectRevert` observe the typed revert at the call boundary).
contract SequencerCheckHarness {
    function check(address feed, uint256 grace, uint256 staleness) external view {
        SequencerCheck.checkSequencerUp(feed, grace, staleness);
    }

    function tryCheck(address feed, uint256 grace, uint256 staleness) external view returns (bool ok, uint8 reason) {
        return SequencerCheck.tryCheckSequencerUp(feed, grace, staleness);
    }

    function outageBuffer(address feed, uint256 buffer, uint256 staleness) external view returns (uint256) {
        return SequencerCheck.getSequencerOutageBuffer(feed, buffer, staleness);
    }

    function resumeTimestamp(address feed) external view returns (uint256) {
        return SequencerCheck.getResumeTimestamp(feed);
    }
}

contract Audit20260712_SequencerUptimeStalenessTest is Test {
    SequencerCheckHarness internal harness;
    MockUptimeFeedControllableUpdatedAt internal feed;

    uint256 internal constant GRACE = 1 hours;
    uint256 internal constant STALENESS = 4 hours; // a tight per-consumer window

    function setUp() public {
        // Baseline far enough forward that we can subtract days without underflow.
        vm.warp(30 days);
        harness = new SequencerCheckHarness();
        feed = new MockUptimeFeedControllableUpdatedAt();
    }

    /// @notice CORE REGRESSION. Sequencer UP, resumed 2 days ago (grace long
    ///         elapsed), but `updatedAt` is legitimately 8h old — older than the
    ///         4h `staleness` window. This is the exact healthy-uptime state of a
    ///         real event-driven uptime feed. Pre-fix: `checkSequencerUp` reverted
    ///         `SequencerDown`. Post-fix: it returns normally (no revert).
    function test_healthyUptime_staleUpdatedAt_doesNotRevert() public {
        // startedAt = 2 days ago, updatedAt = 8h ago (> 4h STALENESS).
        feed_set(0, block.timestamp - 2 days, block.timestamp - 8 hours);
        // No expectRevert: this MUST NOT revert under the fix. It reverted pre-fix.
        harness.check(address(feed), GRACE, STALENESS);
    }

    /// @notice Same state, default 24h staleness overload path — updatedAt 25h old.
    function test_healthyUptime_staleUpdatedAt_default24h_doesNotRevert() public {
        feed_set(0, block.timestamp - 2 days, block.timestamp - 25 hours);
        // Exercises the 2-arg → 3-arg(MAX_FEED_STALENESS) default path.
        SequencerCheckHarness h = harness;
        // Use the 3-arg with the library default explicitly to keep it view.
        h.check(address(feed), GRACE, SequencerCheck.MAX_FEED_STALENESS);
    }

    /// @notice tryCheckSequencerUp: healthy uptime with old updatedAt must report
    ///         OK, not TRY_KEEPER_LAPSED (reason 3).
    function test_try_healthyUptime_staleUpdatedAt_reportsOk() public {
        feed_set(0, block.timestamp - 2 days, block.timestamp - 8 hours);
        (bool ok, uint8 reason) = harness.tryCheck(address(feed), GRACE, STALENESS);
        assertTrue(ok, "healthy uptime must report ok despite old updatedAt");
        assertEq(uint256(reason), uint256(SequencerCheck.TRY_OK), "reason must be TRY_OK");
    }

    /// @notice getSequencerOutageBuffer: healthy uptime with old updatedAt must
    ///         return 0 (no outage), not `buffer`.
    function test_outageBuffer_healthyUptime_staleUpdatedAt_returnsZero() public {
        feed_set(0, block.timestamp - 2 days, block.timestamp - 8 hours);
        uint256 buf = harness.outageBuffer(address(feed), GRACE, STALENESS);
        assertEq(buf, 0, "no outage buffer when sequencer is healthily up");
    }

    /// @notice getResumeTimestamp: healthy uptime with old updatedAt must return
    ///         the real `startedAt`, not the fail-closed `type(uint256).max`
    ///         sentinel that the removed staleness branch produced.
    /// @dev    updatedAt is 25h old — OLDER than the hardcoded 24h
    ///         MAX_FEED_STALENESS that the removed branch used (getResumeTimestamp
    ///         takes no `staleness` param). So PRE-fix this tripped the stale
    ///         branch → returned type(uint256).max; POST-fix it returns startedAt.
    ///         (An 8h value would be < 24h and pass on BOTH old and new — no
    ///         fail-on-old — which is why we use 25h here.)
    function test_resumeTimestamp_healthyUptime_staleUpdatedAt_returnsStartedAt() public {
        uint256 resumedAt = block.timestamp - 2 days;
        feed_set(0, resumedAt, block.timestamp - 25 hours);
        uint256 got = harness.resumeTimestamp(address(feed));
        assertEq(got, resumedAt, "must return real startedAt, not fail-closed max sentinel");
    }

    // ─── Guards that MUST still fire (unchanged behaviour) ──────────────────

    /// @notice answer == 1 (down) still reverts SequencerDown.
    function test_stillReverts_whenSequencerDown() public {
        feed_set(1, block.timestamp - 2 days, block.timestamp - 8 hours);
        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        harness.check(address(feed), GRACE, STALENESS);
    }

    /// @notice updatedAt == 0 (round uninitialized) still reverts.
    function test_stillReverts_whenRoundUninitialized() public {
        feed_set(0, block.timestamp - 2 days, 0);
        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        harness.check(address(feed), GRACE, STALENESS);
    }

    /// @notice Future-dated updatedAt (clock skew) still fails closed → SequencerDown.
    function test_stillReverts_whenUpdatedAtInFuture() public {
        feed_set(0, block.timestamp - 2 days, block.timestamp + 1 hours);
        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        harness.check(address(feed), GRACE, STALENESS);
    }

    /// @notice Within the post-resume grace window still reverts (grace guard intact).
    function test_stillReverts_whenInGracePeriod() public {
        // Resumed 10 min ago (< 1h grace), updatedAt fresh — grace must still gate.
        feed_set(0, block.timestamp - 10 minutes, block.timestamp - 10 minutes);
        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        harness.check(address(feed), GRACE, STALENESS);
    }

    /// @notice Mainnet posture unchanged: feed == address(0) on chainid 1 no-ops.
    function test_mainnetNoFeed_unchanged() public {
        vm.chainId(1);
        harness.check(address(0), GRACE, STALENESS); // must not revert
    }

    // ─── helpers ───────────────────────────────────────────────────────────

    function feed_set(int256 answer, uint256 startedAt, uint256 updatedAt) internal {
        feed.set(answer, startedAt, updatedAt);
    }
}
