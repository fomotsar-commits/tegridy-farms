// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/TegridyTWAP.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";

/// @title AuditR014_OracleTest — coverage for the R014 / Wave-014 oracle layer hardening
/// @notice One test per item in the remediation plan:
///           1. TegridyPair cumulative price accumulators (Uniswap V2 pattern, unchecked wrap).
///           2. TegridyFactory `isPair` registry.
///           3. TegridyTWAP factory validation + pair-native cumulative reads + bypassed flag.
///           4. TegridyTWAP Observation widened to uint256 cumulatives (anti-truncation).
///           5. TegridyTWAP `_getCumulativePricesOverPeriod` wrap-aware "before" comparison.
///
///         Each test exercises behavior the prior oracle could not safely demonstrate.
contract AuditR014OracleTest is Test {
    TegridyFactory public factory;
    TegridyPair public pair;
    TegridyTWAP public twap;

    MockToken public tokenA;
    MockToken public tokenB;

    address public owner = address(this);
    address public alice = makeAddr("alice");
    address public feeTo = makeAddr("feeTo");

    function setUp() public {
        factory = new TegridyFactory(address(this), address(this));
        // Promote feeTo through the timelock so the pair fee logic engages later if needed.
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        tokenA = new MockToken("Token A", "TKA");
        tokenB = new MockToken("Token B", "TKB");
        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pair = TegridyPair(pairAddr);

        // Seed an asymmetric pool so spotPrice0 != spotPrice1 (avoids degenerate
        // cancellation in the cumulative integral).
        tokenA.transfer(address(pair), 100 ether);
        tokenB.transfer(address(pair), 200 ether);
        pair.mint(address(this));

        twap = new TegridyTWAP(address(factory), address(0));

        // Fund alice so swap helpers can move reserves around.
        tokenA.transfer(alice, 10_000 ether);
        tokenB.transfer(alice, 10_000 ether);
    }

    // ────────────────────────────────────────────────────────────────────
    // Item 1: TegridyPair cumulative price accumulators
    // ────────────────────────────────────────────────────────────────────

    /// @notice After a non-zero `timeElapsed` between two `_update()` calls (driven here
    ///         by a swap), `price0CumulativeLast` and `price1CumulativeLast` must advance
    ///         by exactly `(otherReserve * 2^112 / thisReserve) * timeElapsed` based on
    ///         the PRE-update reserves. Confirms the Uniswap V2 integration formula.
    function test_R014_pair_cumulativeAdvancesOnUpdate() public {
        // First touch happened during initial mint() in setUp; at that time reserves
        // were 0 → no cumulative was integrated. Capture the baseline.
        uint256 cum0Before = pair.price0CumulativeLast();
        uint256 cum1Before = pair.price1CumulativeLast();
        assertEq(cum0Before, 0, "baseline cum0 should be zero (first mint had no prior reserves)");
        assertEq(cum1Before, 0, "baseline cum1 should be zero");

        (uint112 r0Pre, uint112 r1Pre, uint32 tsPre) = pair.getReserves();

        // Warp + perform a swap that triggers _update() with non-zero pre-reserves.
        uint32 elapsed = 1 hours;
        vm.warp(block.timestamp + elapsed);
        _swapAForB(1 ether);

        uint256 cum0After = pair.price0CumulativeLast();
        uint256 cum1After = pair.price1CumulativeLast();
        (, , uint32 tsPost) = pair.getReserves();
        assertEq(uint256(tsPost - tsPre), uint256(elapsed), "blockTimestampLast advanced by elapsed");

        // Expected integration uses the PRE-update reserves and exactly `elapsed`.
        uint256 Q112 = 2 ** 112;
        uint256 expectedDelta0 = (uint256(r1Pre) * Q112 / r0Pre) * uint256(elapsed);
        uint256 expectedDelta1 = (uint256(r0Pre) * Q112 / r1Pre) * uint256(elapsed);

        assertEq(cum0After - cum0Before, expectedDelta0, "price0CumulativeLast = (r1_pre * 2^112 / r0_pre) * elapsed");
        assertEq(cum1After - cum1Before, expectedDelta1, "price1CumulativeLast = (r0_pre * 2^112 / r1_pre) * elapsed");

        // Sync with timeElapsed=0 must NOT advance the cumulative (skip-on-zero-elapsed branch).
        uint256 cum0Snapshot = pair.price0CumulativeLast();
        pair.sync();
        assertEq(pair.price0CumulativeLast(), cum0Snapshot, "sync at the same block must not double-integrate");
    }

    // ────────────────────────────────────────────────────────────────────
    // Item 2: TegridyFactory isPair registry
    // ────────────────────────────────────────────────────────────────────

    /// @notice `isPair[pair]` must be true for every pair the factory created and false
    ///         for everything else (including LP token contracts that look pair-shaped).
    function test_R014_factory_isPairRegistry() public {
        assertTrue(factory.isPair(address(pair)), "freshly-created pair is registered");

        // Fresh deploy of an unrelated contract must NOT register.
        MockToken outsider = new MockToken("Outsider", "OUT");
        assertFalse(factory.isPair(address(outsider)), "outsider contract is not in the registry");
        assertFalse(factory.isPair(address(0)), "zero address is not in the registry");

        // Spinning up another legitimate pair via the factory MUST also register.
        MockToken tokenC = new MockToken("Token C", "TKC");
        MockToken tokenD = new MockToken("Token D", "TKD");
        if (address(tokenC) > address(tokenD)) (tokenC, tokenD) = (tokenD, tokenC);
        address newPair = factory.createPair(address(tokenC), address(tokenD));
        assertTrue(factory.isPair(newPair), "second factory-created pair is registered");
    }

    // ────────────────────────────────────────────────────────────────────
    // Item 3: TegridyTWAP factory validation + pair-native reads + bypassed flag
    // ────────────────────────────────────────────────────────────────────

    /// @notice `update(forgedPair)` reverts UnknownPair when the address is not in
    ///         the bound factory's registry, even if the contract returns a sane
    ///         (reserves, cumulative) shape.
    function test_R014_twap_rejectsForgedPair() public {
        ForgedPair forged = new ForgedPair(address(tokenA), address(tokenB));
        vm.expectRevert(TegridyTWAP.UnknownPair.selector);
        twap.update(address(forged));
    }

    /// @notice Pair-native cumulative read: when the pair has been idle for some
    ///         period before TWAP.update(), the observation must reflect the spot
    ///         price integrated over the idle window — not just the post-update
    ///         spot price. Verifies the (pairCum + spotPrice * elapsedSinceLastPairTouch)
    ///         bridge term.
    function test_R014_twap_pairNativeWithIdleBridge() public {
        // First observation (t0) — pair was just minted, cumulative is 0, idle = 0.
        twap.update(address(pair));
        TegridyTWAP.Observation memory obs0 = twap.getLatestObservation(address(pair));
        assertEq(obs0.price0Cumulative, 0, "first observation captures zero pair cumulative + zero bridge");
        // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): TWAP HIGH-3 — first observation now
        // intentionally sets bypassed=true so consult() refuses any lookup window that
        // anchors on the bootstrap (pre-fix, an attacker could anchor a poisoned 1:N
        // baseline because there was no prior lastSpot to gate against).
        assertTrue(obs0.bypassed, "first observation now flags bypassed (TWAP HIGH-3)");

        // Now warp WITHOUT touching the pair. The pair's own cumulative stays frozen
        // (no _update() ran), so any growth in the TWAP observation's cumulative
        // must come from the bridge term (spotPrice * elapsedSinceLastPairTouch).
        uint32 elapsed = 1 hours;
        vm.warp(block.timestamp + elapsed);

        // Confirm pair did NOT integrate during the idle window.
        assertEq(pair.price0CumulativeLast(), 0, "idle pair cumulative remains zero");

        twap.update(address(pair));
        TegridyTWAP.Observation memory obs1 = twap.getLatestObservation(address(pair));

        (uint112 r0, uint112 r1, ) = pair.getReserves();
        uint256 spotPrice0 = (uint256(r1) * (2 ** 112)) / r0;
        uint256 expected = spotPrice0 * uint256(elapsed);
        assertEq(obs1.price0Cumulative, expected, "TWAP integrated the idle window via the bridge term");
        // BATCH-M3 H7: obs 2 is now self-bootstrap-bypassed (count <= 2 grace window).
        // The bypassed flag is orthogonal to the bridge-cumulative semantics this test
        // exercises, but observation #2 is now `bypassed = true` regardless of the gap.
        assertTrue(obs1.bypassed, "obs#2 is in the self-bootstrap grace window");
    }

    /// @notice After a long dormancy (> DEVIATION_BYPASS_AFTER), the next update
    ///         skips the deviation gate AND records `bypassed = true` on the
    ///         observation so consumers can see the rebootstrap window.
    function test_R014_twap_bypassedFlagOnDormancyRebootstrap() public {
        // Seed two observations to populate lastSpot{0,1} so the deviation gate is armed.
        twap.update(address(pair));
        vm.warp(block.timestamp + 16 minutes);
        twap.update(address(pair));

        // Move price *substantially* (>50%) on the pair, then sleep past
        // DEVIATION_BYPASS_AFTER (1 day). After dormancy the deviation gate must be
        // bypassed and the observation must carry `bypassed = true`.
        _swapAForB(40 ether); // ~40% reserves shift → spot moves > 50% in deviation terms
        vm.warp(block.timestamp + 2 days);

        twap.update(address(pair));
        TegridyTWAP.Observation memory obs = twap.getLatestObservation(address(pair));
        assertTrue(obs.bypassed, "post-dormancy observation must be flagged bypassed");
        assertGt(twap.lastBypassUsed(address(pair)), 0, "bypass is also stamped on the per-pair record");
    }

    // ────────────────────────────────────────────────────────────────────
    // Item 4: Observation cumulative widened to uint256
    // ────────────────────────────────────────────────────────────────────

    /// @notice Storing a cumulative value that would have truncated under the prior
    ///         uint224 layout must survive intact under uint256. We compare the stored
    ///         observation to the canonical uint256 spotPrice * elapsed product and to
    ///         a synthetic value > 2^224 (which the prior layout could not have held).
    function test_R014_twap_uint256CumulativePreservesHighBits() public {
        // Seed a normal first observation.
        twap.update(address(pair));

        vm.warp(block.timestamp + 2 days);
        twap.update(address(pair));

        TegridyTWAP.Observation memory obs = twap.getLatestObservation(address(pair));
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        uint256 spotPrice0 = (uint256(r1) * (2 ** 112)) / r0;
        // Round-trip equality against the canonical product. The pair did not move
        // between updates, so its own cumulative is still 0 and the stored value
        // equals `spotPrice0 * elapsedSinceLastPairTouch`.
        uint256 expected = spotPrice0 * uint256(2 days);
        assertEq(obs.price0Cumulative, expected, "uint256 cumulative round-trips the canonical product");

        // Direct truncation probe: simulate writing a synthetic Observation whose
        // cumulative exceeds the prior uint224 ceiling (2^224 - 1). The struct we
        // declare in tests must hold the full uint256 — if Observation's layout had
        // remained uint224, this assignment would not even compile.
        TegridyTWAP.Observation memory synth = TegridyTWAP.Observation({
            timestamp: uint32(block.timestamp),
            bypassed: false,
            price0Cumulative: uint256(type(uint224).max) + 1, // unrepresentable in uint224
            price1Cumulative: uint256(type(uint224).max) + 12345
        });
        assertEq(synth.price0Cumulative, uint256(type(uint224).max) + 1, "uint256 layout holds 2^224");
        assertGt(synth.price0Cumulative, uint256(type(uint224).max), "value strictly above prior uint224 cap");
    }

    // ────────────────────────────────────────────────────────────────────
    // Item 5: Wrap-aware binary search in _getCumulativePricesOverPeriod
    // ────────────────────────────────────────────────────────────────────

    /// @notice Across the year-2106 uint32 timestamp wrap, consult() must continue
    ///         to find observations using cyclic-time ordering (modular distance <
    ///         2^31). The plain-comparison version of the search would silently
    ///         degrade once `targetTimestamp` wrapped past zero.
    function test_R014_twap_consultWrapAwareAcrossYear2106() public {
        // BATCH-M3 H7: obs 1, 2, 3 are now self-bootstrap-bypassed. Need ≥6 obs
        // so the 30-min consult anchor can land on a non-bypass slot.
        // Park ourselves further before the uint32 rollover so all 6 spaced-out
        // observations straddle the wrap. Each step is 16 min (MIN_PERIOD = 15).
        uint256 max32 = uint256(type(uint32).max);
        uint256 wrapAt = max32 - 200 minutes;
        vm.warp(wrapAt);

        twap.update(address(pair));                                 // #1 bypass at wrapAt
        vm.warp(wrapAt + 16 minutes);
        twap.update(address(pair));                                 // #2 bypass
        vm.warp(wrapAt + 32 minutes);
        twap.update(address(pair));                                 // #3 bypass

        // Cross the rollover with later, post-wrap observations.
        vm.warp(max32 + 16 minutes);                                // ~16 sec past wrap
        twap.update(address(pair));                                 // #4 non-bypass
        vm.warp(max32 + 32 minutes);
        twap.update(address(pair));                                 // #5 non-bypass
        vm.warp(max32 + 48 minutes);
        twap.update(address(pair));                                 // #6 non-bypass (latest)

        // Confirm consult resolves to a legitimate (non-zero) TWAP across the wrap
        // — the canonical regression here is that the pre-wrap observations would
        // appear "after" the post-wrap target under the old non-wrap-aware test
        // and the lookup would fall back to the oldest entry, mis-sizing the window.
        uint256 amountOut = twap.consult(address(pair), address(tokenA), 1 ether, 30 minutes);
        assertGt(amountOut, 0, "consult succeeds over a wrap-spanning window");
    }

    // ────────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────────

    function _swapAForB(uint256 amountIn) internal {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        uint256 amountOut = (amountIn * 997 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 997);
        vm.startPrank(alice);
        tokenA.transfer(address(pair), amountIn);
        pair.swap(0, amountOut, alice, "");
        vm.stopPrank();
    }
}

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @dev Pair-shaped impostor used to verify the factory.isPair gate. Returns plausible
///      reserves + cumulatives so the only thing rejecting it is the registry check.
contract ForgedPair {
    address public token0;
    address public token1;
    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (1e18, 2e18, uint32(block.timestamp));
    }
    function price0CumulativeLast() external pure returns (uint256) { return 12345; }
    function price1CumulativeLast() external pure returns (uint256) { return 67890; }
}
