// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyTWAP.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";

/// @title 1000-agent audit (2026-07-22) — L-4: TegridyTWAP deviation-baseline ratchet
/// @notice `lastSpot{0,1}` is the baseline the deviation gate measures the NEXT
///         observation against. It used to be written from the raw INSTANTANEOUS
///         reserve ratio, which made it a free-running ratchet:
///
///           * each accepted observation may move the baseline up to
///             `MAX_DEVIATION_BPS` (20%);
///           * the value latched is a single-block price, so a swap landing in the
///             same block as the keeper's `update()` pins the anchor even though it
///             contributed ~0 seconds to the price integral;
///           * the NEXT honest observation is then measured against that transient
///             value, trips `PriceDeviationTooLarge`, and the buffer stalls until the
///             1-day dormancy bypass or the 24h `proposeAdminResetPair`.
///
///         Liveness DoS only — the SERVED TWAP is computed from the pair-native
///         cumulative and was never affected. The fix seeds the baseline from the
///         cumulative-derived interval TWAP, so moving it costs holding the price for
///         the whole interval rather than for one block.
///
///         Harness note: this suite drives a REAL `TegridyPair` + `TegridyFactory`
///         (not a stub) so the cumulative accumulators advance with true Uniswap-V2
///         semantics — the property under test is exactly about how the integral
///         relates to spot, so a stub that fakes the integral would prove nothing.
contract MockERC20_1kT is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract Audit_1000Agent_TWAP is Test {
    TegridyTWAP internal twap;
    TegridyFactory internal factory;
    TegridyPair internal pair;
    MockERC20_1kT internal tokenA;
    MockERC20_1kT internal tokenB;

    address internal attacker = makeAddr("attacker");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant Q112 = 2 ** 112;

    function setUp() public {
        vm.chainId(1);
        factory = new TegridyFactory(address(this), address(this), address(this));

        tokenA = new MockERC20_1kT("Token A", "TKA");
        tokenB = new MockERC20_1kT("Token B", "TKB");
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        pair = TegridyPair(factory.createPair(address(tokenA), address(tokenB)));

        // 100 TKA : 200 TKB → spot0 (token1 per token0) = 2.
        tokenA.transfer(address(pair), 100 ether);
        tokenB.transfer(address(pair), 200 ether);
        pair.mint(address(this));

        twap = new TegridyTWAP(address(factory), address(0));
        twap.setUpdateFee(0);

        tokenA.transfer(attacker, 100_000 ether);
        tokenB.transfer(attacker, 100_000 ether);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    function _warp(uint256 dt) internal {
        // `block.timestamp` is CSE'd across cheatcodes under `via_ir = true`;
        // always re-read it through the cheatcode.
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _spot0() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return (uint256(r1) * Q112) / uint256(r0);
    }

    function _swapAForB(uint256 amountIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        out = (amountIn * 997 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 997);
        vm.startPrank(attacker);
        tokenA.transfer(address(pair), amountIn);
        pair.swap(0, out, attacker, "");
        vm.stopPrank();
    }

    function _swapBForA(uint256 amountIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        out = (amountIn * 997 * uint256(r0)) / (uint256(r1) * 1000 + amountIn * 997);
        vm.startPrank(attacker);
        tokenB.transfer(address(pair), amountIn);
        pair.swap(out, 0, attacker, "");
        vm.stopPrank();
    }

    /// @dev Drive the oracle past the bootstrap (#1) + self-bootstrap grace (#2/#3)
    ///      + unseeded-transition (#4) window so `lastSpot` is seeded and subsequent
    ///      observations are deviation-gated. All owner-only by design.
    function _warmUp() internal {
        for (uint256 i = 0; i < 5; i++) {
            pair.sync();
            twap.update(address(pair));
            _warp(twap.MIN_PERIOD() + 1);
        }
        assertGt(twap.lastSpot0(address(pair)), 0, "baseline not seeded by warm-up");
    }

    /// @dev Largest A→B input whose resulting move passes the deviation gate on BOTH
    ///      sides. The gate is asymmetric in effect: a −d move on `spot0` is a
    ///      +d/(1−d) move on `spot1`, so the binding constraint is the side-1 rise.
    ///      8e18 lands at ~1424 bps on side 0 / ~1660 bps on side 1 — comfortably
    ///      inside `MAX_DEVIATION_BPS = 2000` and therefore ACCEPTED by the gate.
    uint256 internal constant SPIKE_WITHIN_CAP = 8 ether;

    // ══════════════════════════════════════════════════════════════════════
    //  L-4
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Direct assertion of the fix: after an in-block price spike, the baseline
    ///      written must be the INTERVAL AVERAGE (≈ the pre-spike price), not the
    ///      spiked instantaneous spot that existed for ~0 seconds of the interval.
    function test_L4_baselineTracksIntervalTWAP_notInstantSpot() public {
        _warmUp();
        uint256 priceBefore = _spot0();

        // Same-block spike, then the keeper's observation lands. The spiked price
        // has existed for ZERO seconds of the elapsed interval, so it contributes
        // nothing to the integral — yet pre-fix it was what got latched.
        _swapAForB(SPIKE_WITHIN_CAP);
        uint256 spikedSpot = _spot0();
        assertLt(spikedSpot, priceBefore, "spike did not move spot");

        twap.update(address(pair));
        uint256 baseline = twap.lastSpot0(address(pair));

        // The spike must not be what got latched...
        assertGt(baseline, spikedSpot, "baseline latched the in-block spike");
        // ...it must be the interval average, i.e. the pre-spike price.
        assertApproxEqRel(baseline, priceBefore, 0.01e18, "baseline is not the interval TWAP");
    }

    /// @dev THE ratchet, and the behavioural regression.
    ///
    ///      The deviation gate is symmetric — a −d move on side 0 is a +d/(1−d) move
    ///      on side 1 — so no SINGLE spike can both pass the gate and push the return
    ///      trip past it. Walking the baseline therefore takes successive steps, each
    ///      measured against the anchor the previous step just moved.
    ///
    ///      Step 1 spikes within the cap. PRE-FIX that latches the spiked price, so
    ///      step 2 gets to spike much further and still measure < 20% against the
    ///      walked anchor — the ratchet turning. POST-FIX the anchor never moved off
    ///      the interval TWAP, so step 2 is measured against REAL price and the gate
    ///      refuses it. Asserting the refusal pins that the ratchet cannot turn.
    function test_L4_ratchetSecondStep_isRefused() public {
        _warmUp();

        // Step 1: spike inside the cap, observe, unwind — all in one block.
        uint256 got = _swapAForB(SPIKE_WITHIN_CAP);
        twap.update(address(pair));
        _swapBForA(got);

        _warp(twap.MIN_PERIOD() + 1);
        pair.sync();

        // Step 2: a deeper spike. Against a WALKED anchor this reads as a small
        // step and is admitted; against the true interval TWAP it is ~28% and must
        // be rejected.
        _swapAForB(18 ether);
        vm.expectRevert(TegridyTWAP.PriceDeviationTooLarge.selector);
        twap.update(address(pair));
    }

    /// @dev The other half of the same property: after an in-block spike + observation,
    ///      an HONEST observation at the real price must still be accepted. Pre-fix the
    ///      anchor sat at the spiked value and honest updates measured against it.
    function test_L4_afterSpike_honestObservationStillAccepted() public {
        _warmUp();

        uint256 got = _swapAForB(SPIKE_WITHIN_CAP);
        twap.update(address(pair));
        _swapBForA(got); // price restored, same block

        _warp(twap.MIN_PERIOD() + 1);
        pair.sync();

        uint256 countBefore = twap.observationCount(address(pair));
        twap.update(address(pair));
        assertEq(twap.observationCount(address(pair)), countBefore + 1, "honest observation rejected");
    }

    /// @dev NO-REGRESSION: the gate must not become inert. A price move that is
    ///      genuinely SUSTAINED across the interval does move the baseline, so the
    ///      oracle still tracks real markets rather than freezing at its first anchor.
    function test_L4_sustainedMove_stillMovesBaseline() public {
        _warmUp();
        uint256 baselineBefore = twap.lastSpot0(address(pair));

        // Move the price and let it HOLD for a full interval so the integral absorbs it.
        _swapAForB(SPIKE_WITHIN_CAP);
        _warp(twap.MIN_PERIOD() + 1);
        pair.sync();
        twap.update(address(pair));

        uint256 baselineAfter = twap.lastSpot0(address(pair));
        assertLt(baselineAfter, baselineBefore, "sustained move did not move the baseline");
    }

    /// @dev The deviation gate itself is unchanged: a move beyond MAX_DEVIATION_BPS
    ///      that is sustained across the interval is still rejected. This pins that
    ///      L-4 changed only the VALUE written as the baseline, not the enforcement.
    function test_L4_deviationGate_stillRejectsLargeSustainedMove() public {
        _warmUp();

        // ~45% price move, held for the full interval.
        _swapAForB(40 ether);
        _warp(twap.MIN_PERIOD() + 1);
        pair.sync();

        vm.prank(keeper);
        vm.expectRevert(TegridyTWAP.PriceDeviationTooLarge.selector);
        twap.update(address(pair));
    }

    /// @dev Baseline must never be left at zero — a zero `prev0` makes the gate's
    ///      `if (prev0 > 0)` check skip entirely, which is the H-TWAP-OBS4-UNGATED
    ///      hole. The interval-TWAP derivation falls back to spot rather than 0.
    function test_L4_baselineNeverZero() public {
        _warmUp();
        assertGt(twap.lastSpot0(address(pair)), 0, "side-0 baseline zeroed");
        assertGt(twap.lastSpot1(address(pair)), 0, "side-1 baseline zeroed");

        _swapAForB(SPIKE_WITHIN_CAP);
        twap.update(address(pair));
        assertGt(twap.lastSpot0(address(pair)), 0, "side-0 baseline zeroed after update");
        assertGt(twap.lastSpot1(address(pair)), 0, "side-1 baseline zeroed after update");
    }
}
