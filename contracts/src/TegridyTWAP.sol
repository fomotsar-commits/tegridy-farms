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
/// @notice On-chain TWAP oracle for TegridyPair AMM pools.
///
/// @dev SECURITY NOTES:
///   - Uses unchecked math for cumulative price accumulation (intentional overflow wrapping,
///     matching Uniswap V2 design). Subtraction in consult() is also unchecked so that
///     wrapped values produce correct differences.
///   - MIN_PERIOD of 15 minutes between observations prevents rapid buffer filling.
///   - MAX_STALENESS of 2 hours ensures consult() rejects stale data.
///   - Price deviation check rejects observations that deviate >50% from the previous,
///     mitigating flash-loan manipulation of reserves.
contract TegridyTWAP {
    // ─── Types ───────────────────────────────────────────────────────

    struct Observation {
        uint32 timestamp;
        uint224 price0Cumulative; // token1/token0 cumulative (UQ112x112 * seconds)
        uint224 price1Cumulative; // token0/token1 cumulative (UQ112x112 * seconds)
    }

    // ─── Constants ───────────────────────────────────────────────────

    uint256 public constant MIN_PERIOD = 15 minutes;
    uint8 public constant MAX_OBSERVATIONS = 48;
    uint256 public constant MAX_STALENESS = 2 hours;
    /// @dev Maximum allowed price deviation from previous observation (50% = 5000 bps)
    uint256 public constant MAX_DEVIATION_BPS = 5000;
    uint256 private constant Q112 = 2 ** 112;
    uint256 private constant BPS = 10000;

    // ─── Storage ─────────────────────────────────────────────────────

    mapping(address => Observation[MAX_OBSERVATIONS]) public observations;
    mapping(address => uint8) public observationIndex;
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
    error StaleOracle();
    error PriceDeviationTooLarge();

    // ─── External ────────────────────────────────────────────────────

    /// @notice Record a new price observation for a pair.
    function update(address pair) external {
        if (!canUpdate(pair)) revert PeriodNotElapsed();

        (uint112 reserve0, uint112 reserve1,) = ITegridyPair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();

        uint32 blockTs = uint32(block.timestamp % 2 ** 32);
        uint256 spotPrice0 = (uint256(reserve1) * Q112) / reserve0;
        uint256 spotPrice1 = (uint256(reserve0) * Q112) / reserve1;

        // Compute cumulative prices with unchecked math (intentional overflow wrapping)
        uint224 price0Cumulative;
        uint224 price1Cumulative;

        uint256 count = observationCount[pair];
        if (count > 0) {
            uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
            Observation memory last = observations[pair][lastIdx];

            // AUDIT FIX: Price deviation check — reject observations that deviate >50% from
            // the previous spot price. Mitigates flash-loan reserve manipulation.
            if (count >= 2) {
                uint8 prevIdx = lastIdx == 0 ? MAX_OBSERVATIONS - 1 : lastIdx - 1;
                Observation memory prev = observations[pair][prevIdx];
                if (prev.timestamp > 0 && last.timestamp > prev.timestamp) {
                    uint32 prevElapsed = last.timestamp - prev.timestamp;
                    // Reconstruct previous spot price from cumulative difference
                    uint256 prevSpot0;
                    unchecked {
                        prevSpot0 = uint256(last.price0Cumulative - prev.price0Cumulative) / prevElapsed;
                    }
                    if (prevSpot0 > 0) {
                        uint256 deviation = spotPrice0 > prevSpot0
                            ? ((spotPrice0 - prevSpot0) * BPS) / prevSpot0
                            : ((prevSpot0 - spotPrice0) * BPS) / prevSpot0;
                        if (deviation > MAX_DEVIATION_BPS) revert PriceDeviationTooLarge();
                    }
                }
            }

            uint32 elapsed = blockTs - last.timestamp;

            // AUDIT FIX: unchecked accumulation — intentional overflow wrapping (Uniswap V2 pattern)
            unchecked {
                price0Cumulative = last.price0Cumulative + uint224(spotPrice0 * elapsed);
                price1Cumulative = last.price1Cumulative + uint224(spotPrice1 * elapsed);
            }
        } else {
            price0Cumulative = 0;
            price1Cumulative = 0;
        }

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
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();
        if (period == 0) revert InvalidAmount();
        if (period > uint256(MAX_OBSERVATIONS) * MIN_PERIOD) revert PeriodTooLong();

        address token0 = ITegridyPair(pair).token0();
        address token1 = ITegridyPair(pair).token1();

        bool isToken0 = tokenIn == token0;
        if (!isToken0 && tokenIn != token1) revert InvalidToken();

        (uint224 priceCumStart, uint224 priceCumEnd, uint32 elapsed) =
            _getCumulativePricesOverPeriod(pair, isToken0, period);

        // AUDIT FIX: unchecked subtraction for correct modular arithmetic on wrapped cumulatives
        uint256 priceDiff;
        unchecked {
            priceDiff = uint256(uint224(priceCumEnd - priceCumStart));
        }
        amountOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112);
    }

    /// @notice Check whether enough time has passed to record a new observation.
    function canUpdate(address pair) public view returns (bool) {
        uint256 count = observationCount[pair];
        if (count == 0) return true;

        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        Observation memory last = observations[pair][lastIdx];

        return (block.timestamp - last.timestamp) >= MIN_PERIOD;
    }

    /// @notice Get the latest observation for a pair.
    function getLatestObservation(address pair) external view returns (Observation memory obs) {
        uint256 count = observationCount[pair];
        if (count == 0) revert InsufficientObservations();
        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        obs = observations[pair][lastIdx];
    }

    /// @notice Get the number of usable observations stored for a pair.
    function getObservationCount(address pair) external view returns (uint256) {
        uint256 count = observationCount[pair];
        return count > MAX_OBSERVATIONS ? MAX_OBSERVATIONS : count;
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _getCumulativePricesOverPeriod(address pair, bool isToken0, uint256 period)
        internal
        view
        returns (uint224 priceCumStart, uint224 priceCumEnd, uint32 elapsed)
    {
        uint256 count = observationCount[pair];
        if (count < 2) revert InsufficientObservations();

        uint256 effectiveCount = count > MAX_OBSERVATIONS ? MAX_OBSERVATIONS : count;

        uint8 latestIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        Observation memory latest = observations[pair][latestIdx];

        // AUDIT FIX: staleness check — reject if oracle data is too old
        if (block.timestamp - latest.timestamp > MAX_STALENESS) revert StaleOracle();

        uint32 targetTimestamp = latest.timestamp - uint32(period);
        Observation memory best;
        bool found = false;
        uint32 bestDiff = type(uint32).max;

        for (uint256 i = 1; i < effectiveCount; i++) {
            uint8 checkIdx = latestIdx >= uint8(i)
                ? latestIdx - uint8(i)
                : MAX_OBSERVATIONS - uint8(i - latestIdx);

            Observation memory obs = observations[pair][checkIdx];
            if (obs.timestamp == 0) continue;

            if (obs.timestamp <= targetTimestamp) {
                uint32 diff = targetTimestamp - obs.timestamp;
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = obs;
                    found = true;
                }
            }
        }

        if (!found) {
            uint8 oldestIdx;
            if (count >= MAX_OBSERVATIONS) {
                oldestIdx = observationIndex[pair];
            } else {
                oldestIdx = 0;
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
