// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyTWAP.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";
import "../src/lib/SequencerCheck.sol";

/// @title R062 — L2 Sequencer Uptime gating regression suite
/// @notice Verifies that every oracle / grace-sensitive read in the protocol
///         refuses to serve when the configured Chainlink L2 Sequencer Uptime
///         feed reports the sequencer as down (answer == 1) or as having just
///         resumed within SEQUENCER_GRACE_PERIOD (1h, Aave V3 default).
///
///         Mainnet posture (sequencerFeed == address(0)) is exercised by every
///         pre-existing test in the suite; this file targets the L2 path.
///
/// Per-target: TegridyTWAP.consult() — a TWAP read is the canonical oracle
///             surface protected by SequencerCheck. Validating the library
///             behaviour through this caller proves the gate fires at the
///             contract boundary, not just inside the helper. The other four
///             call-sites (Lending._positionETHValue, POL.accumulate /
///             executeHarvestLP, DropV2 dutch-auction price) reuse the same
///             library and are covered structurally by the wrap discipline.
contract R062MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock Chainlink L2 Sequencer Uptime feed. Implements the minimum
///      AggregatorV3 surface that `SequencerCheck` reads.
///
///      Spec recap:
///        answer == 0 → sequencer up
///        answer == 1 → sequencer down (or recently transitioned to down)
///        startedAt   → timestamp at which the current `answer` was set; used
///                      by consumers to enforce a post-resume grace window.
contract MockSequencerFeed {
    int256 public answer;
    uint256 public startedAt;

    constructor(int256 _answer, uint256 _startedAt) {
        answer = _answer;
        startedAt = _startedAt;
    }

    function setStatus(int256 _answer, uint256 _startedAt) external {
        answer = _answer;
        startedAt = _startedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, answer, startedAt, block.timestamp, 1);
    }
}

contract R062SequencerCheckTest is Test {
    TegridyTWAP public twap;
    TegridyTWAP public twapNoFeed;
    TegridyFactory public factory;
    TegridyPair public pair;
    R062MockToken public tokenA;
    R062MockToken public tokenB;
    MockSequencerFeed public seq;

    address public alice = makeAddr("r062_alice");
    address public feeTo = makeAddr("r062_feeTo");

    /// @dev Mirrors `TegridyTWAP.SEQUENCER_GRACE_PERIOD` so test assertions
    ///      stay synced with the contract constant.
    uint256 internal constant GRACE = 1 hours;

    function setUp() public {
        // Set baseline timestamp well into the future so we have headroom for
        // both warps backwards (synthetic "outage started 3h ago") and forwards
        // (post-resume grace).
        vm.warp(10 days);

        factory = new TegridyFactory(address(this), address(this));
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        tokenA = new R062MockToken("Token A", "TKA");
        tokenB = new R062MockToken("Token B", "TKB");
        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pair = TegridyPair(pairAddr);

        // Seed 100 : 200 reserves (1 : 2 price ratio).
        tokenA.transfer(address(pair), 100 ether);
        tokenB.transfer(address(pair), 200 ether);
        pair.mint(address(this));

        // Sequencer is up, started long ago (well past the grace window).
        seq = new MockSequencerFeed(0, block.timestamp - 7 days);
        twap = new TegridyTWAP(address(seq));

        // No-feed twap to confirm address(0) → no-op (mainnet posture).
        twapNoFeed = new TegridyTWAP(address(0));

        // Bootstrap 2 observations on each TWAP so consult() is callable.
        _bootstrap(twap);
        _bootstrap(twapNoFeed);

        tokenA.transfer(alice, 1_000 ether);
        tokenB.transfer(alice, 1_000 ether);
    }

    function _bootstrap(TegridyTWAP _twap) internal {
        _twap.update(address(pair));
        vm.warp(block.timestamp + 16 minutes);
        _twap.update(address(pair));
    }

    // ─── Mainnet posture (no-op) ─────────────────────────────────────

    /// @notice On a chain with `sequencerFeed == address(0)` (mainnet, any
    ///         non-L2), `consult()` MUST behave identically to the pre-R062
    ///         baseline: returns the standard TWAP value, never reverts on
    ///         sequencer state because no feed is even read.
    function test_R062_mainnetNoFeed_consultPasses() public view {
        uint256 amountOut = twapNoFeed.consult(
            address(pair), address(tokenA), 1 ether, 15 minutes
        );
        assertGt(amountOut, 0, "consult on mainnet (no feed) must succeed");
        assertApproxEqRel(amountOut, 2 ether, 0.02e18,
            "TWAP must reflect 1:2 reserves regardless of R062");
    }

    // ─── Sequencer down (answer == 1) ────────────────────────────────

    /// @notice Sequencer reporting `answer == 1` (down) MUST cause every
    ///         oracle read to revert with `SequencerDown`. This is the core
    ///         R062 invariant: a TWAP based on stale pre-outage reserves
    ///         cannot be used to value collateral, quote dutch-auction prices,
    ///         or gate POL accumulation while the L2 is offline.
    function test_R062_sequencerDown_RevertsOracleRead() public {
        seq.setStatus(1, block.timestamp - 2 hours);

        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    /// @notice Even at the *exact moment* the sequencer transitions back to
    ///         up (startedAt == block.timestamp), the grace window is still
    ///         in effect: 0 < GRACE.
    function test_R062_sequencerJustResumed_WaitsGrace() public {
        seq.setStatus(0, block.timestamp);

        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    /// @notice Halfway through the grace window — still rejected.
    function test_R062_sequencerInGracePeriod_StillReverts() public {
        seq.setStatus(0, block.timestamp - (GRACE / 2));

        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    /// @notice One second before the grace window elapses — still rejected.
    ///         Boundary test: gate uses strict `<`, not `<=`.
    function test_R062_sequencerOneSecondBeforeGraceEnds_StillReverts() public {
        seq.setStatus(0, block.timestamp - (GRACE - 1));

        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    /// @notice Grace window has just elapsed (`block.timestamp - startedAt
    ///         == GRACE`). The library uses strict `<`, so equality passes.
    function test_R062_sequencerGracePeriodElapsed_consultPasses() public {
        seq.setStatus(0, block.timestamp - GRACE);

        uint256 amountOut = twap.consult(
            address(pair), address(tokenA), 1 ether, 15 minutes
        );
        assertGt(amountOut, 0, "consult must serve once grace has elapsed");
    }

    /// @notice Long-running healthy sequencer (started a day ago) — passes
    ///         the same way as a feed-less mainnet deploy. We use 1 day rather
    ///         than 30 days because `setUp()` only warps to 10 days, so a
    ///         30-day backwards subtraction would underflow.
    function test_R062_sequencerLongHealthy_consultPasses() public {
        seq.setStatus(0, block.timestamp - 1 days);

        uint256 amountOut = twap.consult(
            address(pair), address(tokenA), 1 ether, 15 minutes
        );
        assertGt(amountOut, 0);
        assertApproxEqRel(amountOut, 2 ether, 0.02e18);
    }

    // ─── Defensive: round-not-initialized ────────────────────────────

    /// @notice Chainlink convention: a `startedAt == 0` round means the feed
    ///         has not yet recorded a real status. `SequencerCheck` treats
    ///         this conservatively as "still in grace" rather than "we don't
    ///         know, allow it". Without this defence, a brand-new feed (or
    ///         a misconfigured one) would silently disable the gate.
    function test_R062_sequencerStartedAtZero_RevertsConservatively() public {
        seq.setStatus(0, 0);

        vm.expectRevert(SequencerCheck.SequencerGracePeriodNotOver.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    // ─── Library direct-call sanity ──────────────────────────────────

    /// @notice Sanity check on the library entry-point itself: passing
    ///         `address(0)` as the feed must short-circuit without ever
    ///         touching the feed contract. This is the mainnet no-op
    ///         posture that every R062-wired contract relies on.
    function test_R062_libraryDirect_zeroAddressNoOp() public view {
        // No revert.
        SequencerCheck.checkSequencerUp(address(0), GRACE);
    }
}
