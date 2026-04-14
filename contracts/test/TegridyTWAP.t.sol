// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyTWAP.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";

contract MockERC20TWAP is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TegridyTWAPTest is Test {
    TegridyTWAP public twap;
    TegridyFactory public factory;
    TegridyPair public pair;
    MockERC20TWAP public tokenA;
    MockERC20TWAP public tokenB;

    address public feeTo = makeAddr("feeTo");
    address public alice = makeAddr("alice");

    function setUp() public {
        // Deploy factory
        factory = new TegridyFactory(address(this), address(this));
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        // Deploy tokens
        tokenA = new MockERC20TWAP("Token A", "TKA");
        tokenB = new MockERC20TWAP("Token B", "TKB");

        // Sort tokens (factory expects token0 < token1)
        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        // Create pair
        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pair = TegridyPair(pairAddr);

        // Add initial liquidity: 100 TKA : 200 TKB (price ratio 1:2)
        tokenA.transfer(address(pair), 100 ether);
        tokenB.transfer(address(pair), 200 ether);
        pair.mint(address(this));

        // Deploy TWAP oracle
        twap = new TegridyTWAP();

        // Give alice tokens for swaps
        tokenA.transfer(alice, 10_000 ether);
        tokenB.transfer(alice, 10_000 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _swapAForB(uint256 amountIn) internal {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amountOut = (amountIn * 997 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 997);

        vm.startPrank(alice);
        tokenA.transfer(address(pair), amountIn);
        pair.swap(0, amountOut, alice, "");
        vm.stopPrank();
    }

    function _seedObservations(uint256 count, uint256 interval) internal {
        for (uint256 i = 0; i < count; i++) {
            twap.update(address(pair));
            if (i < count - 1) {
                vm.warp(block.timestamp + interval);
            }
        }
    }

    // ─── update() tests ──────────────────────────────────────────────

    function test_update_recordsFirstObservation() public {
        twap.update(address(pair));

        assertEq(twap.observationCount(address(pair)), 1);

        TegridyTWAP.Observation memory obs = twap.getLatestObservation(address(pair));
        assertEq(obs.timestamp, uint32(block.timestamp));
        // First observation has zero cumulative prices
        assertEq(obs.price0Cumulative, 0);
        assertEq(obs.price1Cumulative, 0);
    }

    function test_update_recordsSecondObservation() public {
        twap.update(address(pair));

        vm.warp(block.timestamp + 5 minutes);
        twap.update(address(pair));

        assertEq(twap.observationCount(address(pair)), 2);

        TegridyTWAP.Observation memory obs = twap.getLatestObservation(address(pair));
        assertGt(obs.price0Cumulative, 0, "price0Cumulative should be non-zero after 2nd update");
        assertGt(obs.price1Cumulative, 0, "price1Cumulative should be non-zero after 2nd update");
    }

    function test_update_multipleObservations() public {
        // Record 5 observations at 5-minute intervals
        _seedObservations(5, 5 minutes);

        assertEq(twap.observationCount(address(pair)), 5);
    }

    function test_update_revertsIfTooSoon() public {
        twap.update(address(pair));

        // Try to update again immediately — should revert
        vm.expectRevert(TegridyTWAP.PeriodNotElapsed.selector);
        twap.update(address(pair));
    }

    function test_update_revertsIfNoReserves() public {
        // Create a pair with no liquidity
        MockERC20TWAP tokenC = new MockERC20TWAP("Token C", "TKC");
        MockERC20TWAP tokenD = new MockERC20TWAP("Token D", "TKD");
        if (address(tokenC) > address(tokenD)) {
            (tokenC, tokenD) = (tokenD, tokenC);
        }
        address emptyPair = factory.createPair(address(tokenC), address(tokenD));

        vm.expectRevert(TegridyTWAP.NoReserves.selector);
        twap.update(emptyPair);
    }

    // ─── canUpdate() tests ───────────────────────────────────────────

    function test_canUpdate_trueWhenNoObservations() public view {
        assertTrue(twap.canUpdate(address(pair)));
    }

    function test_canUpdate_falseWhenTooSoon() public {
        twap.update(address(pair));
        assertFalse(twap.canUpdate(address(pair)));
    }

    function test_canUpdate_trueAfterMinPeriod() public {
        twap.update(address(pair));
        vm.warp(block.timestamp + 5 minutes);
        assertTrue(twap.canUpdate(address(pair)));
    }

    // ─── consult() tests ─────────────────────────────────────────────

    function test_consult_returnsCorrectTWAP() public {
        // Seed 2 observations at stable 1:2 price ratio
        twap.update(address(pair));
        vm.warp(block.timestamp + 10 minutes);
        twap.update(address(pair));

        // Consult: 1 tokenA should give ~2 tokenB (price ratio is 1:2)
        uint256 amountOut = twap.consult(address(pair), address(tokenA), 1 ether, 10 minutes);

        // Allow 1% tolerance for rounding
        assertApproxEqRel(amountOut, 2 ether, 0.01e18, "TWAP should reflect 1:2 price ratio");
    }

    function test_consult_revertsWithInvalidToken() public {
        _seedObservations(3, 5 minutes);

        address fakeToken = makeAddr("fakeToken");
        vm.expectRevert(TegridyTWAP.InvalidToken.selector);
        twap.consult(address(pair), fakeToken, 1 ether, 10 minutes);
    }

    function test_consult_revertsWithZeroAmount() public {
        _seedObservations(3, 5 minutes);

        vm.expectRevert(TegridyTWAP.InvalidAmount.selector);
        twap.consult(address(pair), address(tokenA), 0, 10 minutes);
    }

    function test_consult_revertsWithInsufficientObservations() public {
        // Only 1 observation — need at least 2
        twap.update(address(pair));

        vm.expectRevert(TegridyTWAP.InsufficientObservations.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 5 minutes);
    }

    function test_consult_reverseDirection() public {
        // Seed observations
        twap.update(address(pair));
        vm.warp(block.timestamp + 10 minutes);
        twap.update(address(pair));

        // Consult: 1 tokenB should give ~0.5 tokenA (price ratio is 2:1 from B's perspective)
        uint256 amountOut = twap.consult(address(pair), address(tokenB), 1 ether, 10 minutes);
        assertApproxEqRel(amountOut, 0.5 ether, 0.01e18, "TWAP should reflect 2:1 reverse ratio");
    }

    // ─── Flash loan manipulation resistance ──────────────────────────

    function test_twap_resistsFlashLoanManipulation() public {
        // Seed several observations at normal 1:2 price ratio
        _seedObservations(6, 5 minutes);

        // Record pre-manipulation TWAP
        uint256 normalTWAP = twap.consult(address(pair), address(tokenA), 1 ether, 25 minutes);

        // Simulate a large swap that distorts the spot price (flash loan attack)
        // Swap 50 tokenA in (50% of reserves) — massive price impact
        vm.warp(block.timestamp + 5 minutes);
        _swapAForB(50 ether);

        // Record a new observation after the manipulation
        twap.update(address(pair));

        // The TWAP over 25 minutes should still be close to the normal price
        // because 5 of the 6 observations reflect the normal price
        uint256 manipulatedTWAP = twap.consult(address(pair), address(tokenA), 1 ether, 25 minutes);

        // The manipulated TWAP should be within 30% of normal
        // (the single manipulated observation is diluted by the other 5)
        uint256 deviation;
        if (manipulatedTWAP > normalTWAP) {
            deviation = ((manipulatedTWAP - normalTWAP) * 1e18) / normalTWAP;
        } else {
            deviation = ((normalTWAP - manipulatedTWAP) * 1e18) / normalTWAP;
        }

        assertLt(deviation, 0.30e18, "TWAP should resist single-block manipulation (< 30% deviation)");
    }

    function test_twap_singleBlockManipulationMinimal() public {
        // Seed observations over 30 minutes
        _seedObservations(7, 5 minutes);

        uint256 normalTWAP = twap.consult(address(pair), address(tokenA), 1 ether, 30 minutes);

        // Attacker manipulates price in a single block (no time warp)
        // This simulates what would happen in a flash loan — same block as update
        _swapAForB(30 ether);

        // Even if attacker calls update immediately (won't work due to MIN_PERIOD),
        // the TWAP wouldn't change because no new observation can be recorded
        assertFalse(twap.canUpdate(address(pair)), "Should not be updatable within MIN_PERIOD");

        // TWAP is unchanged
        uint256 postAttackTWAP = twap.consult(address(pair), address(tokenA), 1 ether, 30 minutes);
        assertEq(postAttackTWAP, normalTWAP, "TWAP should be unchanged when no new observation recorded");
    }

    // ─── Circular buffer tests ───────────────────────────────────────

    function test_circularBuffer_wrapsCorrectly() public {
        // Fill the entire buffer (MAX_OBSERVATIONS = 48) + 1 to wrap
        _seedObservations(49, 5 minutes);

        assertEq(twap.observationCount(address(pair)), 49);
        assertEq(twap.getObservationCount(address(pair)), 48); // Capped display

        // consult should still work after buffer wrap
        uint256 amountOut = twap.consult(address(pair), address(tokenA), 1 ether, 30 minutes);
        assertGt(amountOut, 0, "consult should work after buffer wrap");
    }

    // ─── getLatestObservation() tests ────────────────────────────────

    function test_getLatestObservation_revertsWhenEmpty() public {
        vm.expectRevert(TegridyTWAP.InsufficientObservations.selector);
        twap.getLatestObservation(address(pair));
    }

    function test_getLatestObservation_returnsNewest() public {
        twap.update(address(pair));

        vm.warp(block.timestamp + 10 minutes);
        uint32 secondTs = uint32(block.timestamp);
        twap.update(address(pair));

        TegridyTWAP.Observation memory obs = twap.getLatestObservation(address(pair));
        assertEq(obs.timestamp, secondTs, "Should return the most recent observation");
    }
}
