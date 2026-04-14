// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ITegridyPair — Minimal interface for TegridyPair reserve queries
interface ITegridyPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @title TegridyTWAP — Time-Weighted Average Price Oracle
/// @notice On-chain TWAP oracle for TegridyPair AMM pools. Provides manipulation-resistant
///         price feeds by averaging spot prices over a configurable time window.
///
///         Design:
///         - Stores periodic price observations in a fixed-size circular buffer (gas-efficient)
///         - Anyone can call update() to record a new price snapshot (permissionless)
///         - consult() returns the TWAP-adjusted output amount for a given input
///         - Resistant to flash loan manipulation since TWAP spans multiple blocks
///
///         Integration:
///         - POLAccumulator can query this oracle for safe slippage bounds
///         - Replaces dependency on Flashbots Protect for sandwich protection
///
/// @dev Since TegridyPair does NOT have Uniswap V2-style cumulative price accumulators
///      (removed per AUDIT NOTE #64 / L-03), this oracle computes its own cumulative
///      prices from reserve snapshots taken at update() time. The TWAP between two
///      observations is: (cumulativePrice_new - cumulativePrice_old) / (time_new - time_old).
///
/// @dev SECURITY: This oracle requires at least 2 observations spanning the requested
///      period before returning a price. A single stale observation cannot be used.
///      The MIN_PERIOD between updates prevents an attacker from filling the buffer
///      in a single block to manipulate the TWAP.
contract TegridyTWAP {
    // ─── Types ───────────────────────────────────────────────────────

    struct Observation {
        uint32 timestamp;
        uint224 price0Cumulative; // token1/token0 cumulative (UQ112x112 * seconds)
        uint224 price1Cumulative; // token0/token1 cumulative (UQ112x112 * seconds)
    }

    // ─── Constants ───────────────────────────────────────────────────

    /// @notice Minimum time between observations for a given pair
    uint256 public constant MIN_PERIOD = 5 minutes;

    /// @notice Maximum number of observations stored per pair (circular buffer)
    uint8 public constant MAX_OBSERVATIONS = 48;

    /// @dev UQ112x112 fixed-point resolution (2^112)
    uint256 private constant Q112 = 2 ** 112;

    // ─── Storage ─────────────────────────────────────────────────────

    /// @notice Circular buffer of observations per pair
    mapping(address => Observation[MAX_OBSERVATIONS]) public observations;

    /// @notice Index of the next write position in the circular buffer
    mapping(address => uint8) public observationIndex;

    /// @notice Total number of observations recorded (capped display at MAX_OBSERVATIONS)
    mapping(address => uint256) public observationCount;

    // ─── Events ──────────────────────────────────────────────────────

    event Updated(address indexed pair, uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp);

    // ─── Errors ──────────────────────────────────────────────────────

    error PeriodNotElapsed();
    error NoReserves();
    error InsufficientObservations();
    error InvalidToken();
    error InvalidAmount();
    error PeriodTooLong();

    // ─── External ────────────────────────────────────────────────────

    /// @notice Record a new price observation for a pair.
    ///         Permissionless — anyone can call. Reverts if MIN_PERIOD has not elapsed
    ///         since the last observation.
    /// @param pair Address of the TegridyPair contract
    function update(address pair) external {
        if (!canUpdate(pair)) revert PeriodNotElapsed();

        (uint112 reserve0, uint112 reserve1,) = ITegridyPair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();

        uint32 blockTs = uint32(block.timestamp % 2 ** 32);

        // Compute cumulative prices extending from the last observation
        uint224 price0Cumulative;
        uint224 price1Cumulative;

        uint256 count = observationCount[pair];
        if (count > 0) {
            // Get the most recent observation
            uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
            Observation memory last = observations[pair][lastIdx];

            uint32 elapsed = blockTs - last.timestamp;

            // Accumulate: lastCumulative + (currentSpotPrice * timeElapsed)
            // Spot price in UQ112x112: (reserve1 * Q112) / reserve0 for price0
            price0Cumulative = last.price0Cumulative + uint224((uint256(reserve1) * Q112 / reserve0) * elapsed);
            price1Cumulative = last.price1Cumulative + uint224((uint256(reserve0) * Q112 / reserve1) * elapsed);
        } else {
            // First observation — cumulative starts at 0
            price0Cumulative = 0;
            price1Cumulative = 0;
        }

        // Write to circular buffer
        uint8 idx = observationIndex[pair];
        observations[pair][idx] = Observation({
            timestamp: blockTs,
            price0Cumulative: price0Cumulative,
            price1Cumulative: price1Cumulative
        });

        observationIndex[pair] = (idx + 1) % MAX_OBSERVATIONS;
        observationCount[pair] = count + 1;

        emit Updated(pair, price0Cumulative, price1Cumulative, blockTs);
    }

    /// @notice Query the TWAP-adjusted output amount for a given input over a time period.
    /// @param pair Address of the TegridyPair
    /// @param tokenIn Address of the input token (must be token0 or token1 of the pair)
    /// @param amountIn Amount of input token
    /// @param period Time window in seconds to compute TWAP over (e.g., 1800 for 30 min)
    /// @return amountOut The TWAP-adjusted output amount
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();

        address token0 = ITegridyPair(pair).token0();
        address token1 = ITegridyPair(pair).token1();

        bool isToken0 = tokenIn == token0;
        if (!isToken0 && tokenIn != token1) revert InvalidToken();

        (uint224 priceCumStart, uint224 priceCumEnd, uint32 elapsed) =
            _getCumulativePricesOverPeriod(pair, isToken0, period);

        // TWAP = (cumulativeEnd - cumulativeStart) / elapsed
        // amountOut = amountIn * TWAP / Q112
        uint256 priceDiff = uint256(priceCumEnd) - uint256(priceCumStart);
        amountOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112);
    }

    /// @notice Check whether enough time has passed to record a new observation.
    /// @param pair Address of the TegridyPair
    /// @return True if update() can be called
    function canUpdate(address pair) public view returns (bool) {
        uint256 count = observationCount[pair];
        if (count == 0) return true;

        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        Observation memory last = observations[pair][lastIdx];

        return (block.timestamp - last.timestamp) >= MIN_PERIOD;
    }

    /// @notice Get the latest observation for a pair.
    /// @param pair Address of the TegridyPair
    /// @return obs The most recent Observation
    function getLatestObservation(address pair) external view returns (Observation memory obs) {
        uint256 count = observationCount[pair];
        if (count == 0) revert InsufficientObservations();
        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        obs = observations[pair][lastIdx];
    }

    /// @notice Get the number of usable observations stored for a pair.
    /// @param pair Address of the TegridyPair
    /// @return The number of observations (capped at MAX_OBSERVATIONS)
    function getObservationCount(address pair) external view returns (uint256) {
        uint256 count = observationCount[pair];
        return count > MAX_OBSERVATIONS ? MAX_OBSERVATIONS : count;
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Find two observations spanning the requested period and return their
    ///      cumulative prices and the time elapsed between them.
    function _getCumulativePricesOverPeriod(address pair, bool isToken0, uint256 period)
        internal
        view
        returns (uint224 priceCumStart, uint224 priceCumEnd, uint32 elapsed)
    {
        uint256 count = observationCount[pair];
        if (count < 2) revert InsufficientObservations();

        uint256 effectiveCount = count > MAX_OBSERVATIONS ? MAX_OBSERVATIONS : count;

        // Latest observation
        uint8 latestIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        Observation memory latest = observations[pair][latestIdx];

        // Search backwards for the oldest observation that is at least `period` seconds old
        // relative to the latest observation
        uint32 targetTimestamp = latest.timestamp - uint32(period);
        Observation memory best;
        bool found = false;
        uint32 bestDiff = type(uint32).max;

        for (uint256 i = 1; i < effectiveCount; i++) {
            uint8 checkIdx = latestIdx >= uint8(i)
                ? latestIdx - uint8(i)
                : MAX_OBSERVATIONS - uint8(i - latestIdx);

            Observation memory obs = observations[pair][checkIdx];
            if (obs.timestamp == 0) continue; // Uninitialized slot

            // We want the observation closest to (but not after) targetTimestamp
            if (obs.timestamp <= targetTimestamp) {
                uint32 diff = targetTimestamp - obs.timestamp;
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = obs;
                    found = true;
                }
            }
        }

        // If no observation old enough, use the oldest available observation
        if (!found) {
            // Find the oldest observation in the buffer
            uint8 oldestIdx;
            if (count >= MAX_OBSERVATIONS) {
                oldestIdx = observationIndex[pair]; // Oldest is at current write position (about to be overwritten)
            } else {
                oldestIdx = 0; // Buffer hasn't wrapped yet
            }
            best = observations[pair][oldestIdx];
            if (best.timestamp == 0 || best.timestamp == latest.timestamp) revert InsufficientObservations();
        }

        elapsed = latest.timestamp - best.timestamp;
        if (elapsed == 0) revert InsufficientObservations();

        if (isToken0) {
            priceCumStart = best.price0Cumulative;
            priceCumEnd = latest.price0Cumulative;
        } else {
            priceCumStart = best.price1Cumulative;
            priceCumEnd = latest.price1Cumulative;
        }
    }
}
