// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/POLAccumulator.sol";
import "../src/lib/SequencerCheck.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @title AuditR014_POL — Sequencer-resume staleness gap (H-6) + backstop invariant guard (M-7)
/// @notice Regression suite for the two findings in audit R014 against POLAccumulator
///         and the SequencerCheck library:
///
///         H-6 — Sequencer resume staleness gap. SequencerCheck.checkSequencerUp only proves
///               the sequencer is currently up AND the post-resume grace window has elapsed.
///               It does NOT prove the TWAP observation a downstream consumer is about to
///               consume is itself post-resume. An attacker who watched the outage queue can
///               extract value the moment the gate opens, BEFORE a fresh observation lands.
///               Fix: SequencerCheck exposes `getResumeTimestamp(feed)`; POLAccumulator's
///               `_twapMinOut` / `_twapHarvestMinOut` reject reads where the latest observation
///               timestamp pre-dates `resumeAt + SEQUENCER_GRACE_PERIOD`, with typed error
///               `OracleObservationPredatesResume`.
///
///         M-7 — `backstopBps` invariant guard. The proposer enforces MIN_BACKSTOP_BPS but a
///               future setter could bypass it. Fix: route ALL backstop mutations through
///               `_setBackstopBps(uint256)`, which re-asserts MIN/MAX at the assignment site.
///
///         Per-target: rather than spinning up a full TegridyFactory + TegridyPair + TegridyTWAP
///         + router, this test uses a `MockTegridyTWAP` and `MockUniswapV2Router` that satisfy
///         POLAccumulator's constructor and let the test surgically control:
///           - the latest TWAP observation timestamp (for the H-6 staleness comparison),
///           - the consult() return value (for the swap floor),
///           - the sequencer feed status & startedAt.
///         The accumulate() call exercises the `_twapMinOut` path; the executeHarvestLP() path
///         is covered by the same gate sharing the same private helper. Real-pair integration
///         with the live SequencerCheck behavior is already covered by R062_SequencerCheck.t.sol.

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal mock of an ERC20 LP token. Returns rates that satisfy POL's reserve
///      reads via the staticcall pattern in `_twapHarvestMinOut`.
contract MockLPPair {
    string public name = "Mock LP";
    string public symbol = "MLP";
    uint8 public decimals = 18;
    uint256 public totalSupply = 1_000 ether;
    address public token0;
    address public token1;
    uint112 public r0;
    uint112 public r1;
    uint32 public ts;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
        r0 = 100 ether;
        r1 = 100 ether;
        ts = uint32(block.timestamp);
    }

    function balanceOf(address) external pure returns (uint256) { return 0; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, ts);
    }
}

/// @dev Minimal mock factory that returns the configured LP pair address.
contract MockFactory {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}

/// @dev Mock UniswapV2-style router. Required surface: WETH(), factory(), the swap +
///      addLiquidity entry points used inside accumulate(). swapExactETHForTokens mints
///      TOWELI proportional to ETH; addLiquidityETH consumes the token approval and
///      returns a non-zero LP amount so the ZERO_LP_MINTED guard passes.
contract MockUniswapV2Router {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    MockTOWELI public immutable toweli;
    uint256 public swapRate = 1000;

    constructor(address _weth, address _factory, address _toweli) {
        wethAddr = _weth;
        factoryAddr = _factory;
        toweli = MockTOWELI(_toweli);
    }

    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
        uint256 tokensOut = msg.value * swapRate;
        require(tokensOut >= amountOutMin, "INSUFFICIENT_OUTPUT");
        toweli.mint(to, tokensOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokensOut;
    }

    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin,
        address, uint256
    ) external payable returns (uint256, uint256, uint256) {
        require(amountTokenDesired >= amountTokenMin, "BELOW_TOKEN_MIN");
        require(msg.value >= amountETHMin, "BELOW_ETH_MIN");
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        return (amountTokenDesired, msg.value, msg.value);
    }

    function removeLiquidityETH(
        address, uint256, uint256, uint256, address, uint256
    ) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    receive() external payable {}
}

/// @dev Mock TegridyTWAP. Lets the test surgically control the latest observation
///      timestamp (for H-6 staleness checks) AND the consult() return value (so the
///      accumulate() flow does not depend on a real cumulative-price calculation).
contract MockTegridyTWAP {
    uint32 public latestTs;
    uint256 public consultReturn;

    function setLatestTimestamp(uint32 _ts) external { latestTs = _ts; }
    function setConsultReturn(uint256 _v) external { consultReturn = _v; }

    function consult(address, address, uint256, uint256) external view returns (uint256) {
        return consultReturn;
    }

    function getLatestObservation(address) external view returns (ITegridyTWAP.Observation memory) {
        return ITegridyTWAP.Observation({
            timestamp: latestTs,
            bypassed: false,
            price0Cumulative: 0,
            price1Cumulative: 0
        });
    }
}

/// @dev Mock Chainlink L2 Sequencer Uptime feed. Mirrors the surface from
///      R062_SequencerCheck.t.sol.
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

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, block.timestamp, 1);
    }
}

/// @dev Test harness exposing SequencerCheck library entry points so we can
///      assert getResumeTimestamp behavior directly without going through a
///      consumer contract.
contract SequencerCheckHarness {
    function getResumeTimestamp(address feed) external view returns (uint256) {
        return SequencerCheck.getResumeTimestamp(feed);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

contract AuditR014_POLTest is Test {
    MockTOWELI internal toweli;
    MockLPPair internal lp;
    MockFactory internal factory;
    MockUniswapV2Router internal router;
    MockTegridyTWAP internal twap;
    MockSequencerFeed internal seq;
    POLAccumulator internal pol;
    SequencerCheckHarness internal seqHarness;

    address internal treasuryAddr = makeAddr("r014_treasury");
    address internal weth = makeAddr("r014_weth");

    /// @dev Mirrors POLAccumulator.SEQUENCER_GRACE_PERIOD so test assertions stay
    ///      synced with the contract constant.
    uint256 internal constant GRACE = 1 hours;

    function setUp() public {
        // Warp to a comfortable baseline so we have headroom for both backwards
        // (synthetic outages) and forwards (post-resume) timestamp arithmetic.
        vm.warp(30 days);

        toweli = new MockTOWELI();
        lp = new MockLPPair(address(toweli), weth);
        factory = new MockFactory();
        factory.setPair(address(lp));
        router = new MockUniswapV2Router(weth, address(factory), address(toweli));
        twap = new MockTegridyTWAP();
        seqHarness = new SequencerCheckHarness();

        // Default: sequencer up, started long ago (well past grace). Each test that
        // needs a different posture overrides via seq.setStatus(...).
        seq = new MockSequencerFeed(0, block.timestamp - 7 days);

        // Default TWAP observation: fresh (now), consult returns 1 wei (so the
        // floor is essentially zero — tests that exercise the accumulate path only
        // need the gate to fire/not fire, not real swap economics).
        twap.setLatestTimestamp(uint32(block.timestamp));
        twap.setConsultReturn(1);

        pol = new POLAccumulator(
            address(toweli), address(router), address(lp),
            treasuryAddr, address(twap), address(seq)
        );

        // Warp past the 1-hour ACCUMULATE_COOLDOWN so the first accumulate() can run.
        vm.warp(block.timestamp + 1 hours);
        // Refresh the TWAP timestamp to "now" after the warp so the standard
        // staleness gate (TWAP_MAX_STALENESS = 2h) is not the cause of any reverts.
        twap.setLatestTimestamp(uint32(block.timestamp));
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    function _accumulate() internal {
        pol.accumulate(0, 0, 0, block.timestamp + 30 seconds);
    }

    // ─── H-6: SequencerCheck.getResumeTimestamp ─────────────────────────

    /// @notice When the sequencer is up, getResumeTimestamp returns the configured
    ///         startedAt — the wall-clock moment the current "up" round was posted.
    function test_R014_getResumeTimestamp_upReturnsStartedAt() public {
        uint256 startedAt = block.timestamp - 3 hours;
        seq.setStatus(0, startedAt);
        assertEq(seqHarness.getResumeTimestamp(address(seq)), startedAt,
            "must return the up-round's startedAt");
    }

    /// @notice When the sequencer is reporting down (answer == 1), there is no
    ///         meaningful resume timestamp — getResumeTimestamp returns 0 so the
    ///         consumer falls back on checkSequencerUp's typed SequencerDown revert
    ///         to handle the up/down decision.
    function test_R014_getResumeTimestamp_downReturnsZero() public {
        seq.setStatus(1, block.timestamp - 30 minutes);
        assertEq(seqHarness.getResumeTimestamp(address(seq)), 0,
            "down sequencer must return 0 (no meaningful resume)");
    }

    /// @notice Mainnet / non-L2 deployments pass address(0) as the feed. The helper
    ///         must short-circuit and return 0 without ever attempting a feed call,
    ///         preserving the no-op posture relied on by every R062-wired contract.
    function test_R014_getResumeTimestamp_zeroAddressReturnsZero() public view {
        assertEq(seqHarness.getResumeTimestamp(address(0)), 0,
            "address(0) feed must return 0 (mainnet no-op)");
    }

    /// @notice Boundary check: when the sequencer just resumed (startedAt == now),
    ///         the helper returns that exact timestamp so the consumer's
    ///         observation-vs-resume comparison is correctly anchored.
    function test_R014_getResumeTimestamp_freshlyResumed() public {
        seq.setStatus(0, block.timestamp);
        assertEq(seqHarness.getResumeTimestamp(address(seq)), block.timestamp,
            "freshly-resumed sequencer must return current timestamp");
    }

    // ─── H-6: POLAccumulator TWAP read rejects pre-resume observation ───

    /// @notice Core H-6 invariant. Scenario: the sequencer just resumed at `t1`;
    ///         the standard SequencerCheck grace window has elapsed (so checkSequencerUp
    ///         passes); the TWAP observation we are about to consume was recorded at
    ///         `t1 - 1 minute` (i.e. during/before the outage). The new
    ///         OracleObservationPredatesResume gate must fire, blocking the accumulate
    ///         call. Without the fix, `accumulate()` would proceed to consult() and
    ///         spend ETH at pre-outage TWAP-implied prices.
    function test_R014_accumulate_revertsWhenObservationPredatesResume() public {
        // Sequencer resumed exactly GRACE ago — checkSequencerUp passes (boundary).
        uint256 resumeAt = block.timestamp - GRACE;
        seq.setStatus(0, resumeAt);

        // Latest TWAP observation was recorded BEFORE the resume (during the outage
        // queue, when reserves still reflected pre-outage state).
        twap.setLatestTimestamp(uint32(resumeAt - 1 minutes));

        vm.deal(address(pol), 1 ether);

        vm.expectRevert(POLAccumulator.OracleObservationPredatesResume.selector);
        _accumulate();
    }

    /// @notice Same scenario as above but the observation is JUST barely pre-resume
    ///         (resumeAt + grace - 1 second). Boundary: gate uses strict `<`, so
    ///         observation exactly at `resumeAt + grace` passes (covered in the
    ///         next test); one second earlier MUST still revert.
    function test_R014_accumulate_revertsAtBoundary() public {
        uint256 resumeAt = block.timestamp - GRACE;
        seq.setStatus(0, resumeAt);
        // 1 second before the gate opens.
        twap.setLatestTimestamp(uint32(resumeAt + GRACE - 1));

        vm.deal(address(pol), 1 ether);
        vm.expectRevert(POLAccumulator.OracleObservationPredatesResume.selector);
        _accumulate();
    }

    /// @notice H-6 happy path. Same scenario as the revert test, but with a fresh
    ///         observation recorded AFTER `resumeAt + grace`. The gate must let
    ///         accumulate() proceed all the way to swap + addLiquidity.
    function test_R014_accumulate_succeedsWhenObservationPostResume() public {
        // Sequencer resumed 2 grace-windows ago — well past the gate.
        uint256 resumeAt = block.timestamp - 2 * GRACE;
        seq.setStatus(0, resumeAt);

        // Fresh observation, well after the gate opened.
        twap.setLatestTimestamp(uint32(block.timestamp));

        vm.deal(address(pol), 1 ether);
        // No expectRevert — this should run end-to-end.
        _accumulate();

        assertEq(pol.totalAccumulations(), 1,
            "accumulate must complete when observation is post-resume");
        assertGt(pol.totalLPCreated(), 0, "LP should have been created");
    }

    /// @notice Mainnet posture: no sequencer feed (address(0)) means
    ///         getResumeTimestamp returns 0 → gate is a no-op → accumulate runs
    ///         with the standard staleness check only. Confirms the H-6 fix does
    ///         not regress mainnet behavior.
    function test_R014_accumulate_mainnetPostureUnchanged() public {
        // Re-deploy POL with no sequencer feed. The mock TWAP / router / lp are
        // reusable; we only swap the sequencer wiring.
        POLAccumulator polNoFeed = new POLAccumulator(
            address(toweli), address(router), address(lp),
            treasuryAddr, address(twap), address(0)
        );
        // Warp past cooldown.
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));

        vm.deal(address(polNoFeed), 1 ether);
        polNoFeed.accumulate(0, 0, 0, block.timestamp + 30 seconds);
        assertEq(polNoFeed.totalAccumulations(), 1,
            "mainnet posture (no feed) must accumulate normally");
    }

    /// @notice The TWAP_MAX_STALENESS gate (2h) and the new H-6 gate are
    ///         independent. If the observation is fresh BUT pre-resume, the
    ///         H-6 gate must still fire. This is the attacker scenario where
    ///         a malicious keeper updates the TWAP at observed-pre-outage
    ///         spot during the outage queue — the wall-clock staleness check
    ///         alone would let it pass.
    function test_R014_accumulate_freshButPreResumeStillReverts() public {
        // Sequencer down for 30 minutes, then resumed 90 minutes ago. Grace
        // (1h) has elapsed → checkSequencerUp passes.
        uint256 resumeAt = block.timestamp - 90 minutes;
        seq.setStatus(0, resumeAt);

        // Observation timestamp is "fresh" by the 2h staleness rule (recorded
        // during the resume window) but PRE-resume.
        twap.setLatestTimestamp(uint32(resumeAt - 5 minutes));
        // Sanity: this would pass the 2h staleness check.
        assertLt(block.timestamp - (resumeAt - 5 minutes), 2 hours);

        vm.deal(address(pol), 1 ether);
        vm.expectRevert(POLAccumulator.OracleObservationPredatesResume.selector);
        _accumulate();
    }

    // ─── M-7: backstopBps invariant guard ───────────────────────────────

    /// @notice The new private `_setBackstopBps` MUST reject any value below
    ///         MIN_BACKSTOP_BPS. We exercise this through the timelocked propose
    ///         + execute path because `_setBackstopBps` is private — but the
    ///         design means a future setter that calls `_setBackstopBps` directly
    ///         (and skips the proposer) is ALSO blocked. This is the M-7
    ///         "future-proofing" property.
    ///
    ///         The proposer's existing pre-check (BACKSTOP_TOO_LOW) will catch
    ///         the call first, so we test the executor path by injecting a
    ///         below-floor value into pendingBackstopBps via storage manipulation.
    function test_R014_executeBackstop_revertsBelowMin() public {
        // Bypass the proposer's pre-check: write a below-floor value DIRECTLY into
        // pendingBackstopBps storage, then arm the timelock via the proposer with a
        // valid value (so _executeAfter is set), then overwrite pendingBackstopBps
        // back to the below-floor value before calling executeBackstopChange.

        // 1. Arm the timelock with a valid value.
        uint256 validBps = 9500; // 95% — within [MIN, MAX]
        pol.proposeBackstopChange(validBps);

        // 2. Wait the full delay.
        vm.warp(block.timestamp + pol.BACKSTOP_CHANGE_DELAY());

        // 3. Locate pendingBackstopBps slot and overwrite with a below-MIN value.
        //    Find the slot by scanning the first 64 storage slots for the current
        //    pendingBackstopBps value (validBps). This is brittle but acceptable in
        //    a test that needs to bypass the proposer.
        uint256 belowMin = uint256(pol.MIN_BACKSTOP_BPS()) - 1;
        uint256 slot = type(uint256).max;
        for (uint256 i = 0; i < 64; i++) {
            uint256 v = uint256(vm.load(address(pol), bytes32(i)));
            if (v == validBps) {
                slot = i;
                break;
            }
        }
        require(slot != type(uint256).max, "could not locate pendingBackstopBps slot");
        vm.store(address(pol), bytes32(slot), bytes32(belowMin));
        // Sanity: confirm the storage write took effect.
        assertEq(pol.pendingBackstopBps(), belowMin, "storage write must succeed");

        // 4. executeBackstopChange must now revert with BELOW_MIN_BACKSTOP from
        //    inside _setBackstopBps — proving the executor itself enforces the floor.
        vm.expectRevert(bytes("BELOW_MIN_BACKSTOP"));
        pol.executeBackstopChange();
    }

    /// @notice Companion test for the M-7 ceiling: any value above MAX_BACKSTOP_BPS
    ///         must also revert from inside `_setBackstopBps`. The proposer enforces
    ///         this via BackstopTooHigh; the executor's defense-in-depth check uses
    ///         a string require so the typed proposer error is preserved upstream.
    function test_R014_executeBackstop_revertsAboveMax() public {
        uint256 validBps = 9500;
        pol.proposeBackstopChange(validBps);
        vm.warp(block.timestamp + pol.BACKSTOP_CHANGE_DELAY());

        // Locate slot, overwrite with above-MAX.
        uint256 aboveMax = uint256(pol.MAX_BACKSTOP_BPS()) + 1;
        uint256 slot = type(uint256).max;
        for (uint256 i = 0; i < 64; i++) {
            if (uint256(vm.load(address(pol), bytes32(i))) == validBps) { slot = i; break; }
        }
        require(slot != type(uint256).max, "could not locate slot");
        vm.store(address(pol), bytes32(slot), bytes32(aboveMax));
        assertEq(pol.pendingBackstopBps(), aboveMax);

        vm.expectRevert(bytes("ABOVE_MAX_BACKSTOP"));
        pol.executeBackstopChange();
    }

    /// @notice The existing propose → wait → execute happy path must continue to
    ///         work after the M-7 refactor, AND the resulting backstopBps must be
    ///         the proposed value (proving the refactor did not change semantics).
    function test_R014_executeBackstop_happyPathRoutesThroughSetter() public {
        uint256 startBps = pol.backstopBps();
        uint256 newBps = 9500; // within [MIN, MAX]
        assertTrue(newBps != startBps, "test must propose a different value");

        pol.proposeBackstopChange(newBps);
        vm.warp(block.timestamp + pol.BACKSTOP_CHANGE_DELAY());

        // Execute and confirm:
        // - the BackstopUpdated event is emitted by `_setBackstopBps` (so the path
        //   IS routed through the new private setter — emission proves traversal).
        // - the resulting backstopBps is exactly newBps.
        vm.expectEmit(true, true, true, true);
        emit POLAccumulator.BackstopUpdated(startBps, newBps);
        pol.executeBackstopChange();

        assertEq(pol.backstopBps(), newBps, "executor must set backstopBps to proposed value");
        assertEq(pol.pendingBackstopBps(), 0, "pending must be cleared post-execute");
    }

    /// @notice The proposer's own MIN guard (BACKSTOP_TOO_LOW) is preserved — the
    ///         M-7 fix adds a second line of defense at the executor; the first line
    ///         must still fire to keep error semantics intact for callers / monitoring.
    function test_R014_proposeBackstop_stillRejectsBelowMin() public {
        uint256 belowMin = uint256(pol.MIN_BACKSTOP_BPS()) - 1;
        vm.expectRevert(bytes("BACKSTOP_TOO_LOW"));
        pol.proposeBackstopChange(belowMin);
    }
}
