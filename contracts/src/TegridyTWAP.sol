// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";

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
/// @dev Minimal Ownable2Step + timelock-style admin for the optional update fee.
abstract contract TWAPAdmin {
    address public owner;
    address public pendingOwner;
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    error NotOwner();
    error TWAPZeroAddress();
    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert TWAPZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }
    function renounceOwnership() external pure {
        revert("RENOUNCE_DISABLED");
    }
}

contract TegridyTWAP is TWAPAdmin {
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
    /// @dev Minimum interval between successive update() calls (DoS / drift gate).
    ///      Equal to MIN_PERIOD; named explicitly per R012 (audit 013 H-1) so consumers can rely on it.
    uint256 public constant MIN_UPDATE_INTERVAL = MIN_PERIOD;
    /// @dev If a pair has been dormant for longer than this, the deviation gate is bypassed
    ///      to allow re-bootstrapping. Prevents permanent self-bricking when real price has
    ///      drifted >50% during dormancy. (audit 013 M-2)
    uint256 public constant DEVIATION_BYPASS_AFTER = 1 days;
    uint256 private constant Q112 = 2 ** 112;
    uint256 private constant BPS = 10000;

    // ─── Storage ─────────────────────────────────────────────────────

    mapping(address => Observation[MAX_OBSERVATIONS]) public observations;
    mapping(address => uint8) public observationIndex;
    mapping(address => uint256) public observationCount;
    /// @dev R012 (audit 013 H-1/H-2): per-pair last spot prices, captured at the
    ///      most recent successful update(). Used by the deviation gate so it can fire
    ///      from observation #2 (count == 1 at gate entry) and so the reverse-direction
    ///      (spotPrice1) is gated symmetrically with the forward direction.
    mapping(address => uint256) public lastSpot0;
    mapping(address => uint256) public lastSpot1;

    // ─── AUDIT L7: optional update fee ───────────────────────────────
    /// @notice Fee in wei required from the caller of update(). Default 0 (free,
    ///         backward-compatible). Owner can set non-zero to capture revenue from
    ///         oracle consumers — protocol pays gas to record TWAP, fee offsets that.
    ///         Capped at MAX_UPDATE_FEE (0.01 ETH) to prevent griefing.
    uint256 public updateFee;
    uint256 public constant MAX_UPDATE_FEE = 0.01 ether;
    uint256 public accumulatedFees;
    address public feeRecipient;

    // ─── AUDIT R062: L2 Sequencer Uptime gating ──────────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet and any chain without a sequencer concept (no-op).
    ///         Stored immutable so it cannot be hot-swapped post-deploy. See
    ///         `lib/SequencerCheck.sol` for canonical Arbitrum / OP / Base
    ///         feed addresses. Read by `consult()` only — `update()` is
    ///         always callable so observations can refresh while the
    ///         sequencer is up but mid-grace.
    address public immutable sequencerFeed;
    /// @notice Post-resume grace window. After the sequencer transitions
    ///         back to "up", consult() still reverts for
    ///         `SEQUENCER_GRACE_PERIOD` seconds so AMM reserves and TWAP
    ///         observations have time to refresh before downstream consumers
    ///         (lending oracle, POL accumulator, dutch-auction price) trust
    ///         the read. 1h matches Aave V3's default grace for stable assets.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    // ─── Constructor ─────────────────────────────────────────────────
    /// @param _sequencerFeed AUDIT R062 — Chainlink L2 Sequencer Uptime
    ///        feed; pass `address(0)` for mainnet / non-L2 deployments
    ///        to disable gating (no-op).
    constructor(address _sequencerFeed) {
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = _sequencerFeed;
    }

    // ─── Events ──────────────────────────────────────────────────────

    event Updated(address indexed pair, uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp);
    event UpdateFeeChanged(uint256 oldFee, uint256 newFee);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeesWithdrawn(address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────

    error PeriodNotElapsed();
    error NoReserves();
    error InsufficientObservations();
    error InvalidToken();
    error InvalidAmount();
    error PeriodTooLong();
    error StaleOracle();
    error PriceDeviationTooLarge();
    error InsufficientFee();           // AUDIT L7
    error FeeTooHigh();                // AUDIT L7
    error NoFees();                    // AUDIT L7

    // ─── External ────────────────────────────────────────────────────

    /// @notice Record a new price observation for a pair.
    /// @dev    AUDIT L7: when updateFee > 0, the caller must send at least updateFee wei.
    ///         Excess is refunded to caller. Fees accumulate in the contract for owner withdrawal.
    function update(address pair) external payable {
        if (updateFee > 0) {
            if (msg.value < updateFee) revert InsufficientFee();
            accumulatedFees += updateFee;
            // Refund overpayment
            uint256 excess = msg.value - updateFee;
            if (excess > 0) {
                (bool ok,) = msg.sender.call{value: excess}("");
                if (!ok) revert InsufficientFee(); // refund must succeed
            }
        } else {
            // No fee → reject any sent value to prevent accidental ETH lock-in.
            require(msg.value == 0, "FEE_NOT_SET");
        }
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

            // R012 (audit 013 H-1 + H-2): Deviation gate fires from observation #2 onward
            // (i.e. when count >= 1). The previous implementation gated from #3 (count >= 2)
            // by deriving `prevSpot0` from cumulatives, which left the *second* observation
            // unguarded — a flash-loan-controlled second update poisoned the baseline.
            //
            // Battle-tested fix: compare incoming spot directly against the lastSpot{0,1}
            // captured at the prior update (Uniswap V3 OracleLibrary applies its checks
            // from the very first transformation; we follow the same direction-by-direction
            // discipline). This also closes H-2: spotPrice1 vs lastSpot1 is checked
            // symmetrically with spotPrice0 vs lastSpot0.
            //
            // Wrap-safe elapsed: `blockTs - last.timestamp` is uint32 modular subtraction
            // (Uniswap V2 pattern). Equivalent to (block.timestamp - last.timestamp) for
            // gaps < 2^32 seconds, but resilient to the year-2106 uint32 rollover.
            uint32 elapsed;
            unchecked {
                elapsed = blockTs - last.timestamp;
            }

            // M-2 (audit 013): if the pair has been dormant for > DEVIATION_BYPASS_AFTER,
            // skip the deviation gate so a stale baseline cannot self-brick the oracle.
            // Anything shorter is treated as a normal cadence and gated.
            if (uint256(elapsed) <= DEVIATION_BYPASS_AFTER) {
                uint256 prev0 = lastSpot0[pair];
                uint256 prev1 = lastSpot1[pair];
                if (prev0 > 0) {
                    uint256 deviation0 = spotPrice0 > prev0
                        ? ((spotPrice0 - prev0) * BPS) / prev0
                        : ((prev0 - spotPrice0) * BPS) / prev0;
                    if (deviation0 > MAX_DEVIATION_BPS) revert PriceDeviationTooLarge();
                }
                if (prev1 > 0) {
                    uint256 deviation1 = spotPrice1 > prev1
                        ? ((spotPrice1 - prev1) * BPS) / prev1
                        : ((prev1 - spotPrice1) * BPS) / prev1;
                    if (deviation1 > MAX_DEVIATION_BPS) revert PriceDeviationTooLarge();
                }
            }

            // Unchecked accumulation — intentional overflow wrapping (Uniswap V2 pattern).
            // Feeding a wrap-safe `elapsed` maintains correctness across the uint32 rollover.
            unchecked {
                price0Cumulative = last.price0Cumulative + uint224(spotPrice0 * elapsed);
                price1Cumulative = last.price1Cumulative + uint224(spotPrice1 * elapsed);
            }
        } else {
            price0Cumulative = 0;
            price1Cumulative = 0;
        }

        // R012: capture the spot prices for the next deviation gate (H-1/H-2).
        lastSpot0[pair] = spotPrice0;
        lastSpot1[pair] = spotPrice1;

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
        // R062 (HIGH): refuse to serve TWAP reads when the L2 sequencer is
        // currently down or has just resumed within SEQUENCER_GRACE_PERIOD.
        // address(0) sequencerFeed is a no-op (mainnet / non-L2 deployments).
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);

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
    /// @dev R012 (audit 013 H-3 / M-1): wrap-safe elapsed using uint32 modular subtraction.
    ///      Casting `block.timestamp` to uint32 BEFORE subtraction avoids the
    ///      uint256 - uint32 mismatch that produces enormous diffs across the
    ///      year-2106 wrap, which had previously bricked update() at the rollover.
    function canUpdate(address pair) public view returns (bool) {
        uint256 count = observationCount[pair];
        if (count == 0) return true;

        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        Observation memory last = observations[pair][lastIdx];

        uint32 nowTs = uint32(block.timestamp % 2 ** 32);
        uint32 elapsed;
        unchecked {
            elapsed = nowTs - last.timestamp;
        }
        return uint256(elapsed) >= MIN_UPDATE_INTERVAL;
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

    // ─── AUDIT L7: Fee admin ─────────────────────────────────────────

    /// @notice Set the per-update fee. Capped at MAX_UPDATE_FEE.
    function setUpdateFee(uint256 _newFee) external onlyOwner {
        if (_newFee > MAX_UPDATE_FEE) revert FeeTooHigh();
        uint256 old = updateFee;
        updateFee = _newFee;
        emit UpdateFeeChanged(old, _newFee);
    }

    /// @notice Set the fee recipient. Defaults to owner if unset.
    function setFeeRecipient(address _recipient) external onlyOwner {
        if (_recipient == address(0)) revert TWAPZeroAddress();
        address old = feeRecipient;
        feeRecipient = _recipient;
        emit FeeRecipientChanged(old, _recipient);
    }

    /// @notice Withdraw accumulated update fees to feeRecipient (or owner if unset).
    function withdrawFees() external {
        uint256 amount = accumulatedFees;
        if (amount == 0) revert NoFees();
        accumulatedFees = 0;
        address to = feeRecipient == address(0) ? owner : feeRecipient;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
        emit FeesWithdrawn(to, amount);
    }

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

        // R012 (audit 013 H-3): wrap-safe staleness check. Cast block.timestamp to
        // uint32 BEFORE subtraction so modular arithmetic correctly handles the
        // year-2106 rollover. Previously the uint32→uint256 implicit upcast made the
        // staleness diff explode at the wrap, bricking every consult() consumer.
        uint32 nowTs = uint32(block.timestamp % 2 ** 32);
        uint32 staleness;
        unchecked {
            staleness = nowTs - latest.timestamp;
        }
        if (uint256(staleness) > MAX_STALENESS) revert StaleOracle();

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
