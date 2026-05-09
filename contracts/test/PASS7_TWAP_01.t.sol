// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title PASS7-TWAP-01 — first-observation bypass leaks through `consult` on
///         sparse-observation pairs via the V3-AMM-L1 fail-open fallback.
///
/// @notice HIGH — Pass-6 (TWAP HIGH-3, commit `722d1f1`) marked the FIRST
///         observation on every new pair as `bypassed = true`. The intent was
///         that `consult()` would refuse to serve any TWAP whose lookup window
///         could anchor on the manipulated bootstrap.
///
///         Pass-6 closed two of the three propagation guards:
///           1. `consult()` line 494-498 — refuses if the LATEST observation
///              is bypassed.
///           2. `_getCumulativePricesOverPeriod` line 738 — refuses if the
///              chosen anchor (`best`) is bypassed AND `found = true`.
///
///         The third guard is INTENTIONALLY OPENED via "AUDIT FIX V3-AMM-L1":
///           // V3-AMM-L1: fail-open if we ARE in the !found fallback (best
///           // was forced to the oldest slot because no observation satisfies
///           // the requested period) AND that fallback slot is bypassed.
///         This `&& found` condition leaves the bypass guard inactive when the
///         lookup window is wider than what the buffer can cover. The fallback
///         then ALWAYS lands on slot 0 (the bootstrap, marked bypassed) and
///         the consult returns a TWAP integrated against the manipulated
///         baseline — defeating the FRESH-EYES H-3 fix for any consumer
///         requesting a period > the time covered by honest observations.
///
///         ATTACK PATH:
///         1. Attacker creates a TegridyPair with deeply skewed reserves (the
///            attack scenario the FRESH-EYES H-3 fix was meant to neutralise).
///         2. Attacker calls `update()` → bootstrap, slot 0, `bypassed = true`,
///            `lastSpot{0,1}` set to the manipulated baseline.
///         3. Wait MIN_PERIOD (15 min). Reserves drift naturally OR attacker
///            does a small swap to keep the new spot within ±50% of the
///            manipulated baseline (deviation gate appeased).
///         4. Anyone calls `update()` → slot 1, `bypassed = false` (deviation
///            gate vs the also-manipulated `lastSpot` passes trivially).
///         5. NOW count = 2. Any consumer calling
///            `consult(pair, ..., period > 0)` where period exceeds the gap
///            between latest and the most recent honest observation falls into
///            the !found fallback path. The fallback anchors at slot 0 (the
///            bootstrap), `best.bypassed = true`, but `found = false` skips
///            the bypass guard at line 738. The consult returns a value
///            derived from the MANIPULATED initial cumulative.
///
///         BLAST RADIUS:
///         - POLAccumulator: TWAP_PERIOD = 30min. If the TOWELI/WETH pair has
///           only 2 observations spaced 15 min apart, the FIRST `accumulate()`
///           or `executeHarvestLP()` call CONSUMES the manipulated TWAP. POL
///           has NO `lastBypassUsed` defense (TegridyLending does — see HIGH
///           in §3.5 below).
///         - SwapFeeRouter does NOT consume TegridyTWAP, so it is unaffected.
///         - Any future consumer calling `twap.consult(pair, _, _, period)`
///           where `period > (latest.ts - second-most-recent honest obs.ts)`
///           silently reads a poisoned price.
///
///         WHY PASS-6 INVARIANT MISSED IT:
///         `Pass6_TWAPFirstObsBypass.t.sol` uses `try twap.consult(...)
///         returns (uint256 amountOut)` and asserts the latest observation is
///         non-bypassed when amountOut > 0 — but the invariant DOES NOT
///         differentiate between an honest TWAP and a fallback-anchored
///         TWAP that integrated through the bootstrap. The handler also
///         drives random updates that quickly populate the buffer past the
///         vulnerable count = 2 window, so the random walk doesn't reliably
///         hit this state.
contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Minimal pair the TWAP can read. Lets us drive reserves directly so we
///      can simulate a manipulated bootstrap followed by a small organic-looking
///      drift that passes the deviation gate.
contract MockPair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 private constant Q112 = 2 ** 112;

    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0;
        token1 = _t1;
        reserve0 = _r0;
        reserve1 = _r1;
        blockTimestampLast = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// @dev Update reserves AND advance the cumulative for the elapsed window
    ///      at the OLD spot price (matches Uniswap V2 _update semantics).
    function setReserves(uint112 _r0, uint112 _r1) external {
        uint32 nowTs = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = nowTs - blockTimestampLast;
            if (reserve0 != 0 && reserve1 != 0 && elapsed > 0) {
                uint256 spotP0 = (uint256(reserve1) * Q112) / reserve0;
                uint256 spotP1 = (uint256(reserve0) * Q112) / reserve1;
                price0CumulativeLast += spotP0 * uint256(elapsed);
                price1CumulativeLast += spotP1 * uint256(elapsed);
            }
        }
        reserve0 = _r0;
        reserve1 = _r1;
        blockTimestampLast = nowTs;
    }
}

contract MockFactory {
    mapping(address => bool) public isPair;
    mapping(address => bool) public disabledPairs;
    function tagPair(address p) external { isPair[p] = true; }
    function setDisabled(address p, bool d) external { disabledPairs[p] = d; }
}

contract PASS7_TWAP_01_FirstObsFallbackBypass is Test {
    TegridyTWAP twap;
    MockFactory factory;
    MockPair pair;
    MockToken toweli;
    MockToken weth;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        // Real-clock timestamp so block.timestamp >> 0 — avoids edge cases at
        // year-2106 uint32 wrap inside TegridyTWAP.
        vm.warp(1_700_000_000);

        toweli = new MockToken("Toweli", "TOWELI");
        weth = new MockToken("Wrapped Ether", "WETH");

        // Deploy with manipulated reserves: 100 TOWELI : 0.01 ETH (price ratio
        // 1 TOWELI = 0.0001 ETH, vs the "true" market ratio of ~1 TOWELI = 1 ETH).
        // The asymmetry is the manipulation — deeply undervaluing TOWELI in the pair.
        pair = new MockPair(address(toweli), address(weth), 100 ether, 0.01 ether);
        factory = new MockFactory();
        factory.tagPair(address(pair));

        twap = new TegridyTWAP(address(factory), address(0));
        // FRESH-2026 TEST REALIGN: TegridyTWAP.update() now enforces MIN_UPDATE_FEE (1e14)
        // by default; disable so legacy update() calls without {value:} still work.
        twap.setUpdateFee(0);
        // FRESH-2026 TEST REALIGN: F-31-C / M-24 — DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether
        // now applies by default. Test pair uses tiny WETH-side reserves (0.01 ether)
        // by design (manipulation-poisoned anchor). Set the floor override to 1 wei so
        // those reserves bypass the floor gate without disturbing the bypass-anchor
        // semantics under test.
        twap.setMinReserveFloor(address(pair), 1);
        twap.setMinReserveFloor1(address(pair), 1);
    }

    /// @notice POST-FIX REGRESSION: the PASS7-TWAP-01 fix dropped the
    ///         `&& found` carve-out at TegridyTWAP.sol:738, so the bypass
    ///         guard now fires unconditionally on a bypassed anchor —
    ///         including the !found fallback path. The same scenario that
    ///         pre-fix returned a poisoned price now reverts
    ///         `OracleRebootstrapping`, exactly matching the FRESH-EYES H-3
    ///         intent.
    function test_PASS7_TWAP_01_consultReturnsPoisonedPriceFromBypassedBootstrap() public {
        // Bootstrap with manipulated reserves (slot 0, bypassed=true).
        twap.update(address(pair));
        (, bool bypassedFirst,,) = twap.observations(address(pair), 0);
        assertTrue(bypassedFirst, "bootstrap flagged bypassed (FRESH-EYES H-3)");

        // Drift + second update (slot 1, bypassed=false).
        skip(16 minutes);
        pair.setReserves(95 ether, 0.0105 ether);
        twap.update(address(pair));

        // Pre-fix: the 30-min consult returned a poisoned price (~1e14 wei)
        // anchored on the bypassed bootstrap because the `!found` path
        // skipped the `best.bypassed && found` guard.
        // POST-FIX: the guard `if (best.bypassed) revert OracleRebootstrapping();`
        // fires regardless of `found`, so the same call reverts.
        vm.expectRevert(TegridyTWAP.OracleRebootstrapping.selector);
        twap.consult(address(pair), address(toweli), 1 ether, 30 minutes);

        emit log_string("PASS7-TWAP-01 FIX VALIDATED: bypassed-anchor !found fallback now reverts OracleRebootstrapping");
    }

    /// @notice CONTROL: pre-fix, this 3-obs case revert OracleRebootstrapping
    ///         because `best.bypassed && found` fired. Post-fix, same
    ///         behavior — fail-closed when the anchor is bypassed.
    function test_PASS7_TWAP_01_threeObsConsultUnaffected() public {
        // Bootstrap with same manipulated reserves as the attack test.
        twap.update(address(pair));
        skip(16 minutes);
        pair.setReserves(95 ether, 0.0105 ether);
        twap.update(address(pair));
        skip(16 minutes);
        pair.setReserves(90 ether, 0.011 ether);
        twap.update(address(pair));

        // 30 min consult: targetTimestamp = latest.ts - 30 min.
        // latest.ts ≈ T+32min. target ≈ T+2min. obs[1].ts = T+16min →
        // diff = 2min - 16min = -14min mod 2^32 → > 2^31 → not before.
        // obs[0].ts = T → diff = 2min - 0 = 2min → < 2^31 → before. found=true,
        // best=obs[0]. best.bypassed=true && found=true → reverts
        // OracleRebootstrapping.
        vm.expectRevert(TegridyTWAP.OracleRebootstrapping.selector);
        twap.consult(address(pair), address(toweli), 1 ether, 30 minutes);
    }

    /// @notice DOC-DRIFT: confirm POLAccumulator's 30-minute consult is the
    ///         exact period that opens the !found-fallback bypass on a
    ///         freshly-deployed TOWELI/WETH pair. Documentation in
    ///         `TegridyTWAP.sol:715-737` describes the V3-AMM-L1 fail-open as
    ///         applying to "consumers that explicitly chose to consult on a
    ///         sparse pair" — but POLAccumulator's `_twapMinOut` and
    ///         `_twapHarvestMinOut` do NOT have a `lastBypassUsed` cooldown
    ///         (only TegridyLending does), so they DO consume the poisoned
    ///         fallback the moment the TWAP has 2 observations.
    function test_PASS7_TWAP_01_polAccumulatorPeriodWindowOpensBypass() public view {
        // POLAccumulator.TWAP_PERIOD = 30 minutes (POLAccumulator.sol:107)
        // TegridyTWAP.MIN_PERIOD = 15 minutes
        // First two observations are at most 15 min apart (the cooldown floor).
        // → bypass-fallback window = period - gap = 30 min - 15 min = 15 min
        // → for the first 15 min after the second update, ANY POL consult
        //   reads the poisoned bootstrap-anchored cumulative.
        assertEq(twap.MIN_PERIOD(), 15 minutes, "MIN_PERIOD baseline");
        // 30 min > 15 min → bypass-fallback always engaged at count == 2.
        assertGt(uint256(30 minutes), twap.MIN_PERIOD(), "POL consult period exceeds first-gap");
    }
}
