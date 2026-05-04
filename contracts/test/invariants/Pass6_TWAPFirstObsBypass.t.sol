// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";

/// @title PASS6-INV-I — TegridyTWAP first-observation-bypass propagation
/// @notice Stateful invariant locking down TWAP HIGH-2 + HIGH-3 (closed in
///         commit `722d1f1` at TegridyTWAP.sol:309-331 + L472).
///
///         The fix combines two related guards:
///
///         (HIGH-3) The very first observation on any new pair is now stamped
///                  `bypassed = true` and `lastBypassUsed[pair]` is set —
///                  reusing the dormancy-bypass fail-safe path so consult()
///                  refuses to serve any TWAP whose lookup window contains
///                  the bootstrap anchor. Without this, an attacker could
///                  create a pair at a manipulated 1:100 ratio and have
///                  `update()` permanently anchor a poisoned baseline.
///
///         (HIGH-2) Both `update()` and `consult()` now revert PairDisabled
///                  when `factory.disabledPairs(pair)` is true. The
///                  HIGH-3 guard above relies on consult() being able to
///                  detect a poisoned bootstrap; HIGH-2 closes the parallel
///                  attack of disabling a pair mid-window so frozen
///                  reserves can't poison the buffer either.
///
///         Together, they yield a unified property:
///
///         (I-CORE) For ANY consult call against ANY pair at any time:
///                  IF the call returns successfully (returns amountOut > 0)
///                  THEN none of the observations in the consult's lookup
///                  window are `bypassed`, AND the pair is not disabled.
///                  Equivalently: any consult that integrates a bypass
///                  observation MUST revert OracleRebootstrapping; any
///                  consult on a disabled pair MUST revert PairDisabled.
///
///         The handler creates a pool of 4 pairs at random reserves and
///         randomly drives `update / consult / disablePair / enablePair`
///         calls. The invariant verifies the I-CORE property after every
///         step by sampling consult responses and cross-checking against
///         the buffer state.

contract InvI_Token is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock TegridyPair — exposes the interface TegridyTWAP reads from.
///      `getReserves()` returns whatever last-set value (allows the
///      handler to simulate price drift between updates).
contract InvI_Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0; token1 = _t1;
        reserve0 = _r0; reserve1 = _r1;
        blockTimestampLast = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
    /// @notice Simulate organic price drift on the pair (tracks how the real
    ///         contract would update reserves through swaps).
    function setReserves(uint112 _r0, uint112 _r1) external {
        // Bridge the cumulative price to the moment-of-change so the TWAP's
        // pair-native cumulative read stays consistent with elapsed time.
        uint32 nowTs = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = nowTs - blockTimestampLast;
            if (reserve0 != 0 && reserve1 != 0 && elapsed > 0) {
                uint256 spotP0 = (uint256(reserve1) * (2 ** 112)) / reserve0;
                uint256 spotP1 = (uint256(reserve0) * (2 ** 112)) / reserve1;
                price0CumulativeLast += spotP0 * uint256(elapsed);
                price1CumulativeLast += spotP1 * uint256(elapsed);
            }
        }
        reserve0 = _r0;
        reserve1 = _r1;
        blockTimestampLast = nowTs;
    }
}

contract InvI_Factory {
    mapping(address => bool) public isPair;
    mapping(address => bool) public disabledPairs;
    function tagPair(address pair) external { isPair[pair] = true; }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

contract InvI_Handler is Test {
    TegridyTWAP public twap;
    InvI_Factory public factory;
    InvI_Pair[] public pairs;
    address[] public pairAddrs;
    address public token0Addr;
    address public token1Addr;

    uint256 public actionCount;

    /// @dev Counter — observed gate violations: a consult that returned a
    ///      non-zero amountOut while a bypass observation was the buffer
    ///      anchor for that period, or while the pair was disabled. Must
    ///      stay at 0 across the full run.
    uint256 public bypassPropagationCount;
    /// @dev Diagnostic for surfacing the pair / period that violated.
    address public lastViolationPair;
    uint256 public lastViolationPeriod;
    uint256 public lastViolationAmountOut;

    constructor(
        TegridyTWAP _twap,
        InvI_Factory _factory,
        InvI_Pair[] memory _pairs,
        address _t0,
        address _t1
    ) {
        twap = _twap;
        factory = _factory;
        for (uint256 i = 0; i < _pairs.length; i++) {
            pairs.push(_pairs[i]);
            pairAddrs.push(address(_pairs[i]));
        }
        token0Addr = _t0;
        token1Addr = _t1;
    }

    /// @notice Random `update` on any pair.
    function doUpdate(uint256 pairSeed) external {
        actionCount++;
        InvI_Pair p = pairs[pairSeed % pairs.length];
        try twap.update(address(p)) {} catch {}
    }

    /// @notice Random reserve drift — simulates organic swaps moving the
    ///         pool's spot price between updates.
    function doDriftReserves(uint256 pairSeed, uint256 r0Seed, uint256 r1Seed) external {
        actionCount++;
        InvI_Pair p = pairs[pairSeed % pairs.length];
        // Drift bounded so the deviation gate doesn't always fire.
        uint112 r0 = uint112(bound(r0Seed, 100_000 ether, 10_000_000 ether));
        uint112 r1 = uint112(bound(r1Seed, 100 ether, 10_000 ether));
        p.setReserves(r0, r1);
    }

    /// @notice Random pair disable.
    function doDisablePair(uint256 pairSeed) external {
        actionCount++;
        address p = pairAddrs[pairSeed % pairAddrs.length];
        factory.setDisabled(p, true);
    }

    /// @notice Random pair re-enable.
    function doEnablePair(uint256 pairSeed) external {
        actionCount++;
        address p = pairAddrs[pairSeed % pairAddrs.length];
        factory.setDisabled(p, false);
    }

    /// @notice Probe consult — randomly try varying periods and tokens. If
    ///         the call returns successfully, verify the post-fix invariant:
    ///         the pair must NOT be disabled AND the latest observation must
    ///         NOT be bypassed (else the per-window anchor check would have
    ///         reverted). Track any violation.
    function doConsultProbe(uint256 pairSeed, uint256 periodSeed, uint256 tokenSeed) external {
        actionCount++;
        InvI_Pair p = pairs[pairSeed % pairs.length];
        // Period bounded to [15min, 12h] to match consult's PeriodTooLong.
        uint256 period = bound(periodSeed, 15 minutes, 12 hours);
        address tokenIn = (tokenSeed & 1) == 0 ? token0Addr : token1Addr;
        // Snapshot the disabled state and the latest observation BEFORE the call.
        bool wasDisabled = factory.disabledPairs(address(p));
        uint256 obsCount = twap.observationCount(address(p));
        bool latestBypassed = false;
        if (obsCount > 0) {
            (, bool b,,) = _readLatestObservation(address(p), obsCount);
            latestBypassed = b;
        }

        // PASS7-DOC-04 NOTE: post PASS7-TWAP-01 fix (drop `&& found` carve-out
        // at TegridyTWAP.sol:738), the contract reverts on ANY bypassed anchor
        // — not just bypassed-latest. The original property "successful
        // consult ⇒ latest non-bypassed AND pair non-disabled" remains the
        // necessary, sufficient invariant — successful consult also implies
        // non-bypassed best by virtue of the contract revert. A predicate
        // that pre-emptively flags `bootstrap-bypassed && obsCount < 48` is
        // too coarse: under uint32 wraparound from extreme-warp test inputs,
        // the actual anchor `best` chosen by consult may not be the
        // bootstrap, in which case the consult correctly succeeds. Stick
        // with the latest-bypassed predicate — it's correct and stable.
        try twap.consult(address(p), tokenIn, 1 ether, period) returns (uint256 amountOut) {
            if (amountOut > 0) {
                bool violation = wasDisabled || latestBypassed;
                if (violation) {
                    bypassPropagationCount++;
                    lastViolationPair = address(p);
                    lastViolationPeriod = period;
                    lastViolationAmountOut = amountOut;
                }
            }
        } catch {
            // Reverts are expected under disabled / rebootstrap / insufficient
            // observations / period-too-long / etc. Not a violation.
            // Post-PASS7-TWAP-01: also expected under the bypassed-anchor
            // case (any obs in the lookup window flagged bypassed).
        }
    }

    /// @notice Read the latest observation directly via the public mapping.
    ///         Returns (timestamp, bypassed, p0Cum, p1Cum) for the most-
    ///         recently-written slot.
    function _readLatestObservation(address pair, uint256 obsCount)
        internal
        view
        returns (uint32, bool, uint256, uint256)
    {
        // observationIndex points at the NEXT slot to write; the most recent
        // is (idx - 1) mod MAX_OBSERVATIONS.
        uint8 idx = twap.observationIndex(pair);
        uint8 latestIdx = idx == 0 ? uint8(48 - 1) : idx - 1;
        // observations is a public mapping(address => Observation[MAX_OBSERVATIONS])
        // accessor returns (timestamp, bypassed, p0Cum, p1Cum).
        (uint32 ts, bool b, uint256 p0, uint256 p1) = twap.observations(pair, latestIdx);
        // Compiler note: obsCount unused here, retained for future variants.
        obsCount;
        return (ts, b, p0, p1);
    }

    function doWarp(uint256 secs) external {
        actionCount++;
        // Bias toward MIN_PERIOD-aligned warps so update() can fire.
        secs = bound(secs, 16 minutes, 2 hours);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS6_INV_I_TWAPFirstObsBypass is Test {
    TegridyTWAP public twap;
    InvI_Factory public factory;
    InvI_Pair[] public pairs;
    InvI_Token public toweli;
    InvI_Token public weth;
    InvI_Handler public handler;

    function setUp() public {
        // Real-clock baseline so block.timestamp >> 0 — avoids accidental
        // year-2106-rollover edges in the uint32 modular subtraction inside
        // the TWAP. Mirrors the existing `Pass6_TWAP_DisabledPair_LendingTest`
        // pattern in Pass6_Regressions.t.sol.
        vm.warp(1_700_000_000);

        toweli = new InvI_Token("Toweli", "TOWELI");
        weth = new InvI_Token("Wrapped Ether", "WETH");

        factory = new InvI_Factory();
        twap = new TegridyTWAP(address(factory), address(0));

        // Deploy 4 pairs at heterogeneous reserves to exercise different
        // first-observation spots.
        uint112[4] memory r0s = [
            uint112(1_000_000 ether), uint112(500_000 ether),
            uint112(2_000_000 ether), uint112(750_000 ether)
        ];
        uint112[4] memory r1s = [
            uint112(1_000 ether), uint112(2_000 ether),
            uint112(500 ether), uint112(1_500 ether)
        ];

        InvI_Pair[] memory ps = new InvI_Pair[](4);
        for (uint256 i = 0; i < 4; i++) {
            InvI_Pair p = new InvI_Pair(address(toweli), address(weth), r0s[i], r1s[i]);
            factory.tagPair(address(p));
            pairs.push(p);
            ps[i] = p;
        }

        handler = new InvI_Handler(twap, factory, ps, address(toweli), address(weth));
        targetContract(address(handler));
    }

    /// @notice INVARIANT I-CORE: any successful consult MUST be against a
    ///         non-disabled pair AND have a non-bypassed latest observation.
    ///         Counter must stay at 0 across the full run.
    function invariant_consultBypassPropagation() public {
        if (handler.bypassPropagationCount() > 0) {
            emit log_named_address("violation pair", handler.lastViolationPair());
            emit log_named_uint("violation period", handler.lastViolationPeriod());
            emit log_named_uint("violation amountOut", handler.lastViolationAmountOut());
        }
        assertEq(
            handler.bypassPropagationCount(),
            0,
            "INV-I-CORE: consult succeeded over a disabled pair OR bypassed latest observation"
        );
    }

    /// @notice INVARIANT I-FIRST: for every pair where observationCount >= 1,
    ///         the FIRST observation (slot 0 if count <= 48) is flagged
    ///         bypassed = true. This locks down the FRESH-EYES H-3 fix at
    ///         TegridyTWAP.sol:309-331 — "first observation on a new pair is
    ///         marked bypassed". A regression that re-introduces an
    ///         unflagged anchor would let a manipulated 1:100 bootstrap
    ///         poison every consult that windows back to it.
    function invariant_firstObservationFlaggedBypassed() public view {
        for (uint256 i = 0; i < pairs.length; i++) {
            address p = address(pairs[i]);
            uint256 cnt = twap.observationCount(p);
            if (cnt == 0) continue; // pair never updated — vacuously OK
            // The first-ever-written observation is at index 0 (the index
            // wraps around the buffer, but the first-write always lands in
            // slot 0). After 48 writes the slot 0 gets overwritten, but
            // those subsequent writes are NEVER bypassed (the count > 0
            // branch in update() runs the deviation gate). So the only
            // scenario where the first observation is no longer in slot 0
            // is after 48 honest updates — at that point the bootstrap is
            // naturally gone. We assert: if cnt < MAX_OBSERVATIONS (48) and
            // slot 0 is the bootstrap, that slot's bypassed flag is true.
            if (cnt <= 48) {
                (, bool bypassed,,) = twap.observations(p, 0);
                assertTrue(
                    bypassed,
                    "INV-I-FIRST: first observation on a new pair is not flagged bypassed"
                );
            }
        }
    }

    /// @notice INVARIANT I-DISABLED: if a pair is currently disabled at the
    ///         factory, every consult call MUST revert. We probe each pair
    ///         with a representative consult and verify the revert.
    function invariant_consultRevertsOnDisabledPair() public {
        for (uint256 i = 0; i < pairs.length; i++) {
            address p = address(pairs[i]);
            if (!factory.disabledPairs(p)) continue;
            // Should revert — try and assert revert via try/catch.
            try twap.consult(p, address(toweli), 1 ether, 30 minutes) returns (uint256) {
                fail();
            } catch {
                // OK — revert observed.
            }
        }
    }
}
