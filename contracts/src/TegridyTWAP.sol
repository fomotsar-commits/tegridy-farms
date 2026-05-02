// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title ITegridyPair — Minimal interface for TegridyPair reserve + cumulative queries
/// @dev   AUDIT R014 (oracle layer, Wave-014): extended with `price0CumulativeLast` and
///        `price1CumulativeLast` so the oracle reads the pair's own time-integrated price
///        rather than re-deriving it from spot reserves at observation cadence.
interface ITegridyPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// @title ITegridyFactory — Minimal interface for pair authenticity lookups
/// @dev   AUDIT R014: read-only `isPair(address)` used to reject `update(forgedPair)` calls.
interface ITegridyFactoryForTWAP {
    function isPair(address pair) external view returns (bool);
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

/// @dev AUDIT FIX D-AMM-L3: inherit ReentrancyGuard for defense-in-depth on
///      `update()` (refunds excess ETH) and `withdrawFees()` (sends fees to
///      recipient). CEI is preserved; nonReentrant is belt-and-suspenders.
/// @dev AUDIT FIX D-AMM-H3: inherit TimelockAdmin for the new
///      `adminResetPair(pair)` recovery primitive (24h timelocked).
contract TegridyTWAP is TWAPAdmin, ReentrancyGuard, TimelockAdmin {
    // ─── Types ───────────────────────────────────────────────────────

    /// @notice AUDIT R014 (oracle layer, Wave-014): widened cumulative slots from
    ///         uint224 → uint256 to eliminate truncation risk on extreme-imbalance pairs
    ///         where a single integration step could exceed 2^224 (e.g. an 18-decimal /
    ///         8-decimal pair holding billions of units, integrated over the maximum
    ///         allowed gap). The pair-native cumulatives feed in as uint256 already, so
    ///         we no longer narrow the value before storing it.
    /// @dev    `bypassed == true` flags an observation that was admitted with the
    ///         deviation gate skipped because the pair had been dormant for longer than
    ///         `DEVIATION_BYPASS_AFTER`. Downstream consumers can treat such an
    ///         observation as a "rebootstrap" data point and require a confirming
    ///         follow-up before trusting the new baseline.
    struct Observation {
        uint32 timestamp;
        bool bypassed;
        uint256 price0Cumulative; // token1/token0 cumulative (UQ112x112 * seconds)
        uint256 price1Cumulative; // token0/token1 cumulative (UQ112x112 * seconds)
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

    /// @notice AUDIT FIX D-AMM-H3: timelock key + delay for the pair-reset
    ///         emergency recovery primitive. 24h matches Compound governance.
    bytes32 public constant PAIR_RESET = keccak256("PAIR_RESET");
    uint256 public constant PAIR_RESET_DELAY = 24 hours;

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

    /// @notice AUDIT M-2: timestamp of the most recent rebootstrap (deviation gate
    ///         bypassed because elapsed > DEVIATION_BYPASS_AFTER). Consumers reading
    ///         the TWAP can compare against this to detect that a single dormant-then-
    ///         updated observation is feeding into the cumulative — useful for
    ///         lending oracles that may want to require a second confirming
    ///         observation before trusting the new baseline. Zero means the pair
    ///         has never had its deviation gate bypassed.
    mapping(address => uint256) public lastBypassUsed;
    event DeviationBypassed(address indexed pair, uint32 elapsed, uint256 spotPrice0, uint256 spotPrice1);

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

    // ─── AUDIT R014: pair-authenticity factory ──────────────────────
    /// @notice Immutable reference to the TegridyFactory whose pairs this oracle will
    ///         observe. `update(pair)` reverts `UnknownPair()` when
    ///         `factory.isPair(pair) == false`, which prevents an attacker from
    ///         instantiating a malicious "pair-shaped" contract that returns crafted
    ///         cumulative prices and poisons the oracle for any consumer that doesn't
    ///         rigorously cross-check pair provenance themselves.
    /// @dev    Stored immutable so the factory cannot be hot-swapped post-deploy.
    ITegridyFactoryForTWAP public immutable factory;

    // ─── Constructor ─────────────────────────────────────────────────
    /// @param _factory       AUDIT R014 — TegridyFactory whose pairs this oracle observes.
    ///                       Must be non-zero; revert otherwise.
    /// @param _sequencerFeed AUDIT R062 — Chainlink L2 Sequencer Uptime feed; pass
    ///                       `address(0)` for mainnet / non-L2 deployments to disable
    ///                       gating (no-op).
    constructor(address _factory, address _sequencerFeed) {
        if (_factory == address(0)) revert TWAPZeroAddress();
        factory = ITegridyFactoryForTWAP(_factory);
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = _sequencerFeed;
    }

    // ─── Events ──────────────────────────────────────────────────────

    event Updated(address indexed pair, uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp);
    event UpdateFeeChanged(uint256 oldFee, uint256 newFee);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeesWithdrawn(address indexed to, uint256 amount);
    /// @notice AUDIT FIX D-AMM-H3: pair-reset lifecycle events.
    event PairResetProposed(address indexed pair, uint256 executeAfter);
    event PairResetExecuted(address indexed pair);
    event PairResetCancelled(address indexed pair);
    event PairReset(address indexed pair);

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
    /// @notice AUDIT R014: caller passed a `pair` that the bound TegridyFactory does
    ///         not recognise. Prevents oracle poisoning from forged "pair-shaped" contracts.
    error UnknownPair();
    /// @notice AUDIT FIX D-AMM-H1: dormancy-bypass observation is owner-only.
    error BypassObservationOwnerOnly();
    /// @notice AUDIT FIX D-AMM-M5: `consult()` refuses to serve a price derived from
    ///         a buffer where the latest observation was admitted under bypass.
    error OracleRebootstrapping();
    /// @notice AUDIT FIX D-AMM-H3: zero-address parameter on `proposeAdminResetPair`.
    error PairResetZeroAddress();

    // ─── External ────────────────────────────────────────────────────

    /// @notice Record a new price observation for a pair.
    /// @dev    AUDIT L7: when updateFee > 0, the caller must send at least updateFee wei.
    ///         Excess is refunded to caller. Fees accumulate in the contract for owner withdrawal.
    /// @dev    AUDIT R014 (oracle layer, Wave-014): three structural changes vs. the prior
    ///         implementation:
    ///           1. `factory.isPair(pair)` is checked first. A forged pair contract can no
    ///              longer poison the oracle by returning crafted cumulatives.
    ///           2. The cumulative price written into the observation is the pair's own
    ///              `price{0,1}CumulativeLast` — *plus* an extra `spotPrice * elapsedSinceLastPairTouch`
    ///              term to integrate the price across the idle window between the pair's last
    ///              swap/mint/burn and now. Without that bridging term, an idle pair would
    ///              report a cumulative that lags the spot price by up to MAX_STALENESS.
    ///           3. The Observation now carries a `bypassed` flag set whenever the deviation
    ///              gate is skipped (DEVIATION_BYPASS_AFTER path), so consumers can detect
    ///              rebootstrap windows.
    function update(address pair) external payable nonReentrant {
        // AUDIT R014: factory authentication MUST run before any storage writes or external
        // reads against the (possibly malicious) pair address.
        if (!factory.isPair(pair)) revert UnknownPair();

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

        (uint112 reserve0, uint112 reserve1, uint32 pairBlockTs) = ITegridyPair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();

        uint32 blockTs = uint32(block.timestamp % 2 ** 32);
        uint256 spotPrice0 = (uint256(reserve1) * Q112) / reserve0;
        uint256 spotPrice1 = (uint256(reserve0) * Q112) / reserve1;

        // AUDIT R014: pair-native cumulatives + idle-window bridge.
        // The pair stops integrating between mint/burn/swap/sync calls. If the oracle
        // observes the pair while it is sitting idle, we must extend the integral up to
        // `block.timestamp` ourselves using the current spot price (which is exactly what
        // the pair's _update() would write next). This matches the canonical Uniswap V2
        // OracleLibrary pattern (`currentCumulativePrices`).
        uint32 elapsedSinceLastPairTouch;
        unchecked {
            elapsedSinceLastPairTouch = blockTs - pairBlockTs;
        }
        uint256 pairCum0 = ITegridyPair(pair).price0CumulativeLast();
        uint256 pairCum1 = ITegridyPair(pair).price1CumulativeLast();
        uint256 price0Cumulative;
        uint256 price1Cumulative;
        unchecked {
            // Modular addition matches Uniswap V2 wrapping accumulator semantics.
            price0Cumulative = pairCum0 + (spotPrice0 * uint256(elapsedSinceLastPairTouch));
            price1Cumulative = pairCum1 + (spotPrice1 * uint256(elapsedSinceLastPairTouch));
        }

        bool bypassed = false;
        uint256 count = observationCount[pair];
        if (count > 0) {
            uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
            Observation memory last = observations[pair][lastIdx];

            // R012 (audit 013 H-1 + H-2): Deviation gate fires from observation #2 onward
            // using the spot prices stored at the previous update (lastSpot{0,1}). This is
            // direction-symmetric and gates the second observation as well as later ones.
            //
            // Wrap-safe elapsed: `blockTs - last.timestamp` is uint32 modular subtraction
            // (Uniswap V2 pattern). Equivalent to (block.timestamp - last.timestamp) for
            // gaps < 2^32 seconds, resilient to the year-2106 uint32 rollover.
            uint32 elapsed;
            unchecked {
                elapsed = blockTs - last.timestamp;
            }

            // M-2 (audit 013): dormancy-bypass — if the pair has been dormant for longer
            // than DEVIATION_BYPASS_AFTER, skip the deviation gate so a stale baseline
            // cannot self-brick the oracle when real price has drifted >50%. The deviation
            // gate is defense-in-depth on top of the new pair-native accumulator: the
            // accumulator itself already integrates price across the entire idle period,
            // so the gate should not block legitimate post-dormancy refreshes.
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
            } else {
                // AUDIT M-2 / R014: rebootstrap path — gate skipped after dormancy.
                // AUDIT FIX D-AMM-H1: gate the dormancy-bypass branch behind onlyOwner.
                // Pre-fix this path was permissionless and overwrote `lastSpot{0,1}`
                // a few lines down — making it a flash-loan-anchored bootstrap
                // primitive. An attacker could push reserves to a manipulated state,
                // call `update()` after the pair had been dormant for >1 day to
                // admit the observation under a skipped deviation gate, then brick
                // every subsequent honest observation against the manipulated
                // baseline. Permissionless updates resume immediately afterward
                // since the next observation's `elapsed` will be < DEVIATION_BYPASS_AFTER.
                //
                // AUDIT FIX V2-AMM-L1 (NatSpec only — trust assumption):
                // The bypass branch is owner-trusted. The bypass observation is
                // marked `bypassed = true` and `consult()` (combined with the
                // V2-AMM-H1 `best.bypassed` guard inside
                // `_getCumulativePricesOverPeriod`) refuses to serve any TWAP
                // whose lookup window contains a bypass observation. A
                // compromised owner who can wait DEVIATION_BYPASS_AFTER (1 day)
                // of dormancy COULD admit a manipulated rebootstrap observation,
                // but it cannot be consumed via `consult()` until at least one
                // non-bypass observation has overwritten the slot AND the bypass
                // anchor has rolled out of the MAX_OBSERVATIONS * MIN_PERIOD
                // window (~12 h). Owners SHOULD be a multisig (Wave 0
                // hardening) and the bypass branch's only legitimate use is
                // post-dormancy rebootstrap on tokens whose real price has
                // drifted >50% during dormancy — see DEVIATION_BYPASS_AFTER.
                if (msg.sender != owner) revert BypassObservationOwnerOnly();
                bypassed = true;
                lastBypassUsed[pair] = block.timestamp;
                emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
            }
        }

        // R012: capture the spot prices for the next deviation gate (H-1/H-2).
        lastSpot0[pair] = spotPrice0;
        lastSpot1[pair] = spotPrice1;

        uint8 idx = observationIndex[pair];
        observations[pair][idx] = Observation({
            timestamp: blockTs,
            bypassed: bypassed,
            price0Cumulative: price0Cumulative,
            price1Cumulative: price1Cumulative
        });

        observationIndex[pair] = (idx + 1) % MAX_OBSERVATIONS;
        observationCount[pair] = count + 1;

        emit Updated(pair, price0Cumulative, price1Cumulative, blockTs);
    }

    /// @notice Query the TWAP-adjusted output amount for a given input over a time period.
    ///
    /// @notice AUDIT R016 M-1 (MEDIUM, DOCUMENTATION): post-bypass observations participate
    ///         in the cumulative immediately. When the deviation gate is skipped because the
    ///         pair has been dormant for longer than `DEVIATION_BYPASS_AFTER` (1 day), the
    ///         resulting Observation is flagged with `bypassed == true` and
    ///         `lastBypassUsed[pair]` is updated to the wall-clock time of the bypass. The
    ///         observation itself uses the freshly-bridged cumulative (pair-native cumulative
    ///         + spot * elapsed-since-pair-touch), so the new baseline becomes the TWAP's
    ///         baseline as soon as a `consult()` call references it.
    ///
    /// @notice CONSUMER REQUIREMENT: integrators that price based on `consult()` MUST treat a
    ///         post-bypass cumulative as PROVISIONAL, not authoritative:
    ///           1. Read `getLatestObservation(pair).bypassed` and `lastBypassUsed[pair]`.
    ///           2. If `lastBypassUsed[pair]` is non-zero and within the consumer's risk
    ///              tolerance window (typical: at least one full MIN_PERIOD must have elapsed
    ///              AND a non-bypassed observation must be the most recent one), treat the
    ///              feed as "rebootstrapping" and either:
    ///                 a) reject the price entirely (lending oracles, Dutch auctions);
    ///                 b) widen slippage / haircut by your protocol's tolerance; or
    ///                 c) require an off-chain confirmation feed.
    ///         Trusting a post-bypass cumulative blindly re-introduces the very gap the
    ///         deviation gate exists to prevent — the bypass is a controlled rebootstrap, not
    ///         a "now safe" signal.
    ///
    /// @notice We deliberately keep this as a CONSUMER-side invariant rather than building it
    ///         into the contract: every consumer's risk tolerance for post-dormancy reads is
    ///         different (a stablecoin lender wants stricter handling than an LP analytics
    ///         dashboard), and forcing one policy here would either over-restrict legitimate
    ///         integrations or under-protect cautious ones. Both signals (`bypassed` flag +
    ///         `lastBypassUsed`) are surfaced verbatim so any consumer can implement its own
    ///         policy.
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

        // AUDIT FIX D-AMM-M5: refuse to serve a price derived from a buffer whose
        // latest observation was admitted under the dormancy-bypass path. Even
        // after the H1 owner-only gate, a legitimately-bypassed observation is
        // provisional — it lacks a deviation-gate confirmation. Consumers must
        // wait for the next non-bypass observation before trusting the new
        // cumulative. Pattern: Aave V3 PriceOracleSentinel.
        // AUDIT FIX V2-AMM-H1 / V2-AMM-INFO1: tightened to require `_count >= 2`
        // to match the downstream `_getCumulativePricesOverPeriod` minimum and
        // elide a dead-code `count == 1` branch. The per-window `best.bypassed`
        // check below in `_getCumulativePricesOverPeriod` closes the gap where a
        // buffer's *anchor* observation was bypassed even though `latest` was
        // not — a captured-owner could otherwise stage one bypass observation
        // and let honest keepers backfill subsequent slots, returning a TWAP
        // whose cumulative integrates a manipulated start anchor.
        {
            uint256 _count = observationCount[pair];
            if (_count >= 2) {
                uint8 _latestIdx =
                    observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
                if (observations[pair][_latestIdx].bypassed) revert OracleRebootstrapping();
            }
        }

        address token0 = ITegridyPair(pair).token0();
        address token1 = ITegridyPair(pair).token1();

        bool isToken0 = tokenIn == token0;
        if (!isToken0 && tokenIn != token1) revert InvalidToken();

        (uint256 priceCumStart, uint256 priceCumEnd, uint32 elapsed) =
            _getCumulativePricesOverPeriod(pair, isToken0, period);

        // AUDIT R014 / FIX: unchecked subtraction for correct modular arithmetic on wrapped
        // cumulatives. Both operands are uint256 now (widened from uint224) so consumers
        // never lose precision to truncation on extreme-imbalance pairs.
        uint256 priceDiff;
        unchecked {
            priceDiff = priceCumEnd - priceCumStart;
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
    /// @dev AUDIT FIX D-AMM-L3: nonReentrant for defense-in-depth.
    function withdrawFees() external nonReentrant {
        uint256 amount = accumulatedFees;
        if (amount == 0) revert NoFees();
        accumulatedFees = 0;
        address to = feeRecipient == address(0) ? owner : feeRecipient;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
        emit FeesWithdrawn(to, amount);
    }

    // ─── AUDIT FIX D-AMM-H3: emergency pair reset (24h timelock) ─────

    /// @notice AUDIT FIX D-AMM-H3: propose a timelocked reset of a pair's TWAP
    ///         observation state. Used when a poisoning event has left the buffer
    ///         permanently bricked. Owner-only; 24h timelock so the reset can be
    ///         observed and contested within the validity window.
    function proposeAdminResetPair(address pair) external onlyOwner {
        if (pair == address(0)) revert PairResetZeroAddress();
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        _propose(key, PAIR_RESET_DELAY);
        emit PairResetProposed(pair, _proposalReadyAt(key));
    }

    /// @notice AUDIT FIX D-AMM-H3: execute a previously proposed pair reset after
    ///         the 24h timelock. Clears `observationIndex`, `observationCount`,
    ///         `lastSpot{0,1}`, `lastBypassUsed` for the pair. The next observation
    ///         goes through the deviation gate against a freshly-zeroed baseline.
    function executeAdminResetPair(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        _execute(key);
        delete observationIndex[pair];
        delete observationCount[pair];
        delete lastSpot0[pair];
        delete lastSpot1[pair];
        delete lastBypassUsed[pair];
        emit PairResetExecuted(pair);
        emit PairReset(pair);
    }

    /// @notice AUDIT FIX D-AMM-H3: cancel a pending pair-reset proposal.
    function cancelAdminResetPair(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        _cancel(key);
        emit PairResetCancelled(pair);
    }

    /// @notice Legacy view helper for pair-reset proposal timestamp.
    function pairResetTime(address pair) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        return _proposalReadyAt(key);
    }

    /// @dev AUDIT R014 (oracle layer, Wave-014): widened cumulative returns from uint224 → uint256
    ///      and made the "is observation before target" comparison wrap-aware. The previous
    ///      `obs.timestamp <= targetTimestamp` direct comparison broke once `targetTimestamp`
    ///      itself wrapped past zero (year-2106 rollover): every observation that lived BEFORE
    ///      the wrap had `timestamp` of order 2^32 and would compare *greater* than a
    ///      post-wrap `targetTimestamp`, so the lookup found nothing and fell back to the
    ///      oldest entry — silently widening the TWAP window past `period`.
    ///
    ///      Wrap-aware definition (Uniswap V2 / V3 oracle pattern): an observation is
    ///      "before" the target iff the unsigned-mod-2^32 distance from `obs.timestamp` to
    ///      `targetTimestamp` is less than 2^31 (half the modulus). This treats time as a
    ///      cyclic group and works correctly across the rollover, provided the period is
    ///      itself less than 2^31 seconds (~68 years) — see CONSTRAINT below.
    ///
    /// @dev CONSTRAINT: `period` MUST be < 2^31 seconds. The constructor / consult()
    ///      validation already enforces a much tighter bound (MAX_OBSERVATIONS *
    ///      MIN_PERIOD = 12h), so this is an architectural invariant rather than a runtime
    ///      check.
    function _getCumulativePricesOverPeriod(address pair, bool isToken0, uint256 period)
        internal
        view
        returns (uint256 priceCumStart, uint256 priceCumEnd, uint32 elapsed)
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

        uint32 targetTimestamp;
        unchecked {
            // uint32 modular subtraction — safe across the year-2106 rollover.
            targetTimestamp = latest.timestamp - uint32(period);
        }
        Observation memory best;
        bool found = false;
        uint32 bestDiff = type(uint32).max;

        for (uint256 i = 1; i < effectiveCount; i++) {
            uint8 checkIdx = latestIdx >= uint8(i)
                ? latestIdx - uint8(i)
                : MAX_OBSERVATIONS - uint8(i - latestIdx);

            Observation memory obs = observations[pair][checkIdx];
            if (obs.timestamp == 0) continue;

            // AUDIT R014: wrap-aware "before" test. `targetTimestamp - obs.timestamp` is
            // computed unchecked in uint32 (modular). If the modular result is < 2^31 we
            // are in the half-circle where `obs` precedes the target, which is the
            // canonical cyclic-time ordering used by Uniswap V2/V3 oracles. Constraint:
            // `period < 2^31 seconds` — already enforced by PeriodTooLong (12h ceiling).
            uint32 diff;
            unchecked {
                diff = targetTimestamp - obs.timestamp;
            }
            if (diff < (uint32(1) << 31)) {
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

        // AUDIT FIX V2-AMM-H1: per-window bypass guard. The upstream `consult`
        // already refuses to serve when `latest.bypassed`, but that does not
        // protect against a bypass observation sitting at the START of the
        // lookup window (the cumulative anchor). If `best` (the anchor) was
        // admitted under bypass, the returned `priceCumEnd - priceCumStart`
        // integrates across a manipulated reference point. Reverting here
        // matches the master-report `_safeConsult` recommendation and prevents
        // a captured-owner-staged bypass from poisoning every consult() whose
        // window crosses the bypass slot. The bypass observation falls out of
        // the consultable range at most MAX_OBSERVATIONS * MIN_PERIOD = 12h
        // later — until then, downstream consumers (lending oracles, Dutch
        // auctions) get a clean revert instead of a manipulated TWAP.
        //
        // AUDIT FIX V3-AMM-L1: fail-open if we ARE in the !found fallback (best
        // was forced to the oldest slot because no observation satisfies the
        // requested period) AND that fallback slot is bypassed. If we revert
        // here, the entire pair's TWAP becomes unconsultable for up to 12h with
        // no graceful degradation path. The fallback slot is by construction
        // the LEAST relevant data point we could anchor against, but it's the
        // only one we have; consumers that explicitly chose to consult on a
        // sparse pair should accept the diluted result rather than a hard
        // revert. The honest-anchor case (`found == true`) still reverts.
        if (best.bypassed && found) revert OracleRebootstrapping();

        unchecked {
            elapsed = latest.timestamp - best.timestamp;
        }
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
