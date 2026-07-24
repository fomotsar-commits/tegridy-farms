// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
// AUDIT FIX 2026-05-26 [H-07] — EnumerableSet for tracking pending per-pair
// PAIR_RESET timelock keys so `acceptOwnership` can flush them when a new
// owner takes the seat (closes the cross-owner replay vector).
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";

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
    /// @notice FRESH-EYES H-2: surfaced so update() can refuse to record observations
    /// against pairs that governance has disabled. Without this guard, a flash-loan-funded
    /// front-run of `emergencyDisablePair` can freeze manipulated reserves into the pair's
    /// state — and any subsequent caller of update() integrates that manipulated spot into
    /// the cumulative buffer until re-enable, poisoning every consult() consumer (lending,
    /// POL accumulator, etc.) for the lifetime of the buffer.
    function disabledPairs(address pair) external view returns (bool);
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
///   - Price deviation check rejects observations that deviate >=MAX_DEVIATION_BPS from
///     the previous, mitigating flash-loan manipulation of reserves.
// AUDIT FIX (2026-05-25 2nd pass): the bespoke `TWAPAdmin` (a minimal Ownable2Step that
// LACKED the protocol-standard 14-day transfer expiry, `cancelOwnershipTransfer`, and
// EIP-7702 reject) was removed in favour of the shared `OwnableNoRenounce` base used by
// every other admin contract. `TegridyTWAP` now inherits it directly (see below), bringing
// the oracle's ownership-transfer surface in line with the rest of the protocol.
//
// AUDIT FIX 2026-05-26 [H-07]: per-pair `PAIR_RESET` timelock keys are now tracked via the
// `_pendingResetPairs` enumerable set, and `acceptOwnership` is overridden to flush every
// pending reset on owner rotation. Previous behaviour (manual `cancelAdminResetPair` per
// pair after handoff) was vulnerable to a captured outgoing owner queueing dozens of
// resets that the incoming owner had no on-chain enumeration of — a missed cancel meant
// the outgoing owner's reset would execute under the new owner's timelock.

/// @dev AUDIT FIX D-AMM-L3: inherit ReentrancyGuard for defense-in-depth on
///      `update()` (refunds excess ETH) and `withdrawFees()` (sends fees to
///      recipient). CEI is preserved; nonReentrant is belt-and-suspenders.
/// @dev AUDIT FIX D-AMM-H3: inherit TimelockAdmin for the new
///      `adminResetPair(pair)` recovery primitive (24h timelocked).
contract TegridyTWAP is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin {
    using EnumerableSet for EnumerableSet.AddressSet;

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
    /// @dev Maximum allowed price deviation from previous observation.
    ///      AUDIT FIX F-46-1 (2026-05): tightened from 5000 to 2000 bps (20%).
    ///      Pre-fix the 50% per-observation cap allowed a multi-block grind to
    ///      compound: 4 successive 50% steps move TWAP ~5x within 1h on a
    ///      low-TVL pair (F-89-I cost analysis: ~$200-800 to bend a $15K
    ///      pool 5x). At 20% the same compounding takes 9+ steps and the
    ///      per-step swap-cost rises non-linearly, raising the multi-block
    ///      grind floor ~6x — into the range arbitrageurs reliably defend
    ///      against. The boundary is enforced as `>=` below so an exact
    ///      2000-bps step also reverts.
    uint256 public constant MAX_DEVIATION_BPS = 2000;
    /// @dev Minimum interval between successive update() calls (DoS / drift gate).
    ///      Equal to MIN_PERIOD; named explicitly per R012 (audit 013 H-1) so consumers can rely on it.
    uint256 public constant MIN_UPDATE_INTERVAL = MIN_PERIOD;
    /// @dev If a pair has been dormant for longer than this, the deviation gate is bypassed
    ///      to allow re-bootstrapping. Prevents permanent self-bricking when real price has
    ///      drifted >50% during dormancy. (audit 013 M-2)
    uint256 public constant DEVIATION_BYPASS_AFTER = 1 days;
    /// @dev AUDIT FIX F-24-1 (2026-05) — post-resume / long-idle reserve
    ///      poisoning guard. If the pair's last touch
    ///      (`pair.blockTimestampLast`) is more than MAX_BRIDGING_GAP behind
    ///      `block.timestamp` at observation time, the bridging math
    ///      integrates `currentSpot * elapsedSinceLastPairTouch` across an
    ///      idle window we cannot trust (frozen disable interval, multi-day
    ///      dormancy without arbitrage corrections, etc.). The resulting
    ///      observation is forced `bypassed = true` so consult() fail-closes
    ///      via the existing `best.bypassed`/`latest.bypassed` guards until
    ///      honest activity refreshes the buffer. 2 hours = MAX_STALENESS:
    ///      anything beyond that already breaks the staleness contract for
    ///      `consult()`, so admitting the observation as a non-bypass anchor
    ///      would only widen the manipulation surface without expanding what
    ///      consumers can rely on.
    uint256 public constant MAX_BRIDGING_GAP = 2 hours;
    uint256 private constant Q112 = 2 ** 112;
    uint256 private constant BPS = 10000;

    /// @notice AUDIT FIX D-AMM-H3: timelock key + delay for the pair-reset
    ///         emergency recovery primitive. 24h matches Compound governance.
    bytes32 public constant PAIR_RESET = keccak256("PAIR_RESET");
    uint256 public constant PAIR_RESET_DELAY = 24 hours;

    // AUDIT FIX 2026-05-26 [M-10] — per-pair reserve-floor timelock keys.
    // Mirrors PAIR_RESET shape (per-pair, propose/execute/cancel). 24h delay.
    bytes32 public constant MIN_RESERVE_FLOOR_0 = keccak256("MIN_RESERVE_FLOOR_0");
    bytes32 public constant MIN_RESERVE_FLOOR_1 = keccak256("MIN_RESERVE_FLOOR_1");
    uint256 public constant MIN_RESERVE_FLOOR_DELAY = 24 hours;

    // AUDIT FIX 2026-05-26 [M-11] — fee-recipient change timelock. 24h matches
    // the protocol-standard delay used across all other admin-rotation paths.
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("FEE_RECIPIENT_CHANGE");
    uint256 public constant FEE_RECIPIENT_CHANGE_DELAY = 24 hours;

    // ─── Storage ─────────────────────────────────────────────────────

    // AUDIT FIX 2026-05-26 [H-07] — enumerable set of pairs with a pending
    // PAIR_RESET timelock proposal. `proposeAdminResetPair` adds; execute /
    // cancel / acceptOwnership-flush remove. Lets a newly-accepted owner
    // atomically purge every pending reset the outgoing owner queued.
    EnumerableSet.AddressSet private _pendingResetPairs;

    // AUDIT FIX 2026-05-26 [M-10] — pending values for the per-pair floor
    // timelocks. Stored at propose time, applied at execute time, cleared on
    // execute/cancel so a stale slot can never silently replay.
    mapping(address => uint256) public pendingMinReserveFloor0;
    mapping(address => uint256) public pendingMinReserveFloor1;

    // AUDIT FIX 2026-05-26 [M-11] — pending value for the global fee-recipient
    // timelock. Cleared on execute/cancel.
    address public pendingFeeRecipient;

    mapping(address => Observation[MAX_OBSERVATIONS]) public observations;
    mapping(address => uint8) public observationIndex;
    mapping(address => uint256) public observationCount;
    /// @dev R012 (audit 013 H-1/H-2): per-pair last spot prices, captured at the
    ///      most recent successful update(). Used by the deviation gate so it can fire
    ///      from observation #2 (count == 1 at gate entry) and so the reverse-direction
    ///      (spotPrice1) is gated symmetrically with the forward direction.
    mapping(address => uint256) public lastSpot0;
    mapping(address => uint256) public lastSpot1;
    /// AUDIT FIX (BATCH-N3 H6): per-pair minimum reserve floor for `update()`
    /// to admit observations. 0 = no floor (default, backward-compat).
    /// Owner-set; gates against single-trader manipulation on low-TVL pairs.
    /// AUDIT FIX F-31-C / M-24 (FRESH-EYES 2026-05): the per-pair mapping defaults
    /// to 0, which was effectively "no floor" — a permissive default that left
    /// every newly-registered pair vulnerable to single-trader TWAP grind until
    /// the owner manually called `setMinReserveFloor`. The new
    /// `DEFAULT_MIN_RESERVE_FLOOR_WEI` constant supplies a non-zero floor when
    /// the per-pair value is unset, so the safe default is "gated" and the owner
    /// must EXPLICITLY lower it (via `setMinReserveFloor` to a non-zero value
    /// below the constant) on pairs that legitimately operate at smaller depth.
    /// 10 ether matches the typical ETH-side liquidity floor below which a lone
    /// trader could move spot beyond MAX_DEVIATION_BPS in a single block on an
    /// 18:18 equal-decimal pair.
    uint256 public constant DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether;
    /// @dev AUDIT FIX F-24-2 (2026-05) — per-side floor.
    ///      `minReserveFloor` (the legacy mapping) is the side-0 floor and
    ///      remains the default applied to BOTH reserves on equal-decimal
    ///      pairs (the protocol's current TOWELI/WETH 18:18 case). When a
    ///      cross-decimal pair is registered the owner can set
    ///      `minReserveFloor1` independently so the side-1 reserve is gated
    ///      against its own decimal-appropriate threshold, eliminating the
    ///      single-threshold misconfiguration footgun documented in F-24-2.
    ///      A side-1 value of 0 means "fall back to side-0 effective floor"
    ///      (backward compatible).
    mapping(address => uint256) public minReserveFloor;
    mapping(address => uint256) public minReserveFloor1;
    error ReservesBelowFloor();
    event MinReserveFloorSet(address indexed pair, uint256 floor);
    /// @dev AUDIT FIX F-24-2 — distinct event for the side-1 setter so
    ///      off-chain monitoring sees per-side configuration changes.
    event MinReserveFloor1Set(address indexed pair, uint256 floor);

    // AUDIT FIX 2026-05-26 [M-10] — lifecycle events for the per-pair floor
    // timelocks. Mirrors PAIR_RESET propose/execute/cancel shape.
    event MinReserveFloor0Proposed(address indexed pair, uint256 floor, uint256 executeAfter);
    event MinReserveFloor0Cancelled(address indexed pair);
    event MinReserveFloor1Proposed(address indexed pair, uint256 floor, uint256 executeAfter);
    event MinReserveFloor1Cancelled(address indexed pair);

    /// @notice AUDIT FIX 2026-05-26 [M-10] — DEPRECATED. Use
    ///         `proposeAdminMinReserveFloor` / `executeAdminMinReserveFloor`.
    /// @dev    Pre-fix the immediate setter gave a captured owner an instant
    ///         primitive to disable the reserve-floor gate on a pair they
    ///         intended to grind via low-TVL TWAP manipulation. The 24h
    ///         timelock window restores observability/contestability.
    ///         Deprecation pattern mirrors TegridyFactory.setTokenBlocked.
    function setMinReserveFloor(address, uint256) external pure {
        revert("Use proposeAdminMinReserveFloor()");
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — DEPRECATED. Use
    ///         `proposeAdminMinReserveFloor1` / `executeAdminMinReserveFloor1`.
    function setMinReserveFloor1(address, uint256) external pure {
        revert("Use proposeAdminMinReserveFloor1()");
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — propose a 24h-timelocked change
    ///         to the per-pair side-0 reserve floor.
    function proposeAdminMinReserveFloor(address pair, uint256 floor) external onlyOwner {
        if (!factory.isPair(pair)) revert UnknownPair();
        // AUDIT FIX FRESH-2026 [M-TWAP-FLOOR-MIN]: enforce a hard minimum on
        // the override so a captured-key (or honest mis-typed) owner cannot
        // set per-pair `minReserveFloor[pair] = 1` (1 wei). For 6-decimal
        // pairs (USDC), 1 wei means reserve0 can drop to 1 USDC-base-unit
        // while spotPrice0 = reserve1 * 2^112 — the deviation-gate's BPS
        // math becomes meaningless when the denominator is dominated by a
        // 2^112 factor. UniV2's MINIMUM_LIQUIDITY = 1000 is the natural
        // floor here; reject anything below that for both decimal-6 and
        // decimal-18 pairs. Floor must be either explicitly 0 (use default)
        // or >= 1000.
        if (floor != 0 && floor < 1000) revert FloorTooLow();
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_0, pair));
        pendingMinReserveFloor0[pair] = floor;
        _propose(key, MIN_RESERVE_FLOOR_DELAY);
        emit MinReserveFloor0Proposed(pair, floor, _proposalReadyAt(key));
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — execute a previously proposed
    ///         side-0 reserve-floor change after the 24h timelock.
    function executeAdminMinReserveFloor(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_0, pair));
        _execute(key);
        uint256 floor = pendingMinReserveFloor0[pair];
        minReserveFloor[pair] = floor;
        delete pendingMinReserveFloor0[pair];
        emit MinReserveFloorSet(pair, floor);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — cancel a pending side-0 floor proposal.
    function cancelAdminMinReserveFloor(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_0, pair));
        _cancel(key);
        delete pendingMinReserveFloor0[pair];
        emit MinReserveFloor0Cancelled(pair);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — propose a 24h-timelocked change
    ///         to the per-pair side-1 reserve floor. A non-zero value unbinds
    ///         reserve-1 from the side-0 floor (F-24-2). Setting back to 0
    ///         restores side-0 fallback.
    function proposeAdminMinReserveFloor1(address pair, uint256 floor) external onlyOwner {
        if (!factory.isPair(pair)) revert UnknownPair();
        // AUDIT FIX FRESH-2026 [M-TWAP-FLOOR-MIN]: sibling-port of side-0 floor minimum.
        if (floor != 0 && floor < 1000) revert FloorTooLow();
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_1, pair));
        pendingMinReserveFloor1[pair] = floor;
        _propose(key, MIN_RESERVE_FLOOR_DELAY);
        emit MinReserveFloor1Proposed(pair, floor, _proposalReadyAt(key));
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — execute a previously proposed
    ///         side-1 reserve-floor change after the 24h timelock.
    function executeAdminMinReserveFloor1(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_1, pair));
        _execute(key);
        uint256 floor = pendingMinReserveFloor1[pair];
        minReserveFloor1[pair] = floor;
        delete pendingMinReserveFloor1[pair];
        emit MinReserveFloor1Set(pair, floor);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-10] — cancel a pending side-1 floor proposal.
    function cancelAdminMinReserveFloor1(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(MIN_RESERVE_FLOOR_1, pair));
        _cancel(key);
        delete pendingMinReserveFloor1[pair];
        emit MinReserveFloor1Cancelled(pair);
    }

    /// @notice AUDIT FIX F-31-C / M-24 (FRESH-EYES 2026-05): effective floor used
    ///         by `update()`. Returns the per-pair override when set (`!= 0`),
    ///         else falls back to `DEFAULT_MIN_RESERVE_FLOOR_WEI`. Exposed as a
    ///         public view so consumers and integrators can read the same value
    ///         the gate enforces.
    function effectiveMinReserveFloor(address pair) public view returns (uint256) {
        uint256 override_ = minReserveFloor[pair];
        return override_ == 0 ? DEFAULT_MIN_RESERVE_FLOOR_WEI : override_;
    }

    /// @notice AUDIT FIX F-24-2 (2026-05): side-1 effective floor. Falls back
    ///         to the side-0 effective floor when the override is unset, so
    ///         18:18 equal-decimal pairs continue to behave as before.
    function effectiveMinReserveFloor1(address pair) public view returns (uint256) {
        uint256 override_ = minReserveFloor1[pair];
        return override_ == 0 ? effectiveMinReserveFloor(pair) : override_;
    }

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
    /// @notice AUDIT FIX F-95-K-4 (2026-05): default minimum update-fee floor
    ///         applied when the owner has NOT explicitly set `updateFee`.
    ///         Pre-fix the default of 0 made `update()` callable for ~80k gas,
    ///         enabling a permanent keeper-race grief on every authentic pair
    ///         (an attacker front-runs honest keepers at every MIN_PERIOD
    ///         boundary). 1e14 wei (~$0.30 at 3000 USD/ETH) prices the grief
    ///         out of practicality while staying affordable for honest keepers.
    ///         Owners can override to ANY value in `[0, MAX_UPDATE_FEE]` via
    ///         `setUpdateFee` (including back to zero on chains where the
    ///         keeper-grief threat does not apply).
    uint256 public constant MIN_UPDATE_FEE = 1e14;
    uint256 public accumulatedFees;
    address public feeRecipient;
    /// @notice AUDIT FIX F-95-K-4 (2026-05): tracks whether the owner has
    ///         explicitly configured `updateFee`. While false, `update()`
    ///         enforces `MIN_UPDATE_FEE` as the effective floor. Once the
    ///         owner calls `setUpdateFee` (with ANY value, including 0) the
    ///         flag flips and the explicit value applies. This preserves the
    ///         "owner can opt out of fees entirely" intent without leaving
    ///         fresh deployments wide-open to keeper-race griefing.
    bool public updateFeeConfigured;

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
    constructor(address _factory, address _sequencerFeed) OwnableNoRenounce(msg.sender) {
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
    /// @notice AUDIT FIX FRESH-2026: TWAP-REFUND-BANK-EVENT [MEDIUM] —
    ///         emitted when an overpayment refund fails (broken receive(),
    ///         OOG within 30k stipend) and the excess is banked into
    ///         `accumulatedFees`. Pre-fix the silent absorption was
    ///         invisible to off-chain monitoring; legitimate keepers
    ///         couldn't distinguish "tip" from "broken-recipient" mode.
    event RefundBanked(address indexed caller, uint256 amount);
    /// @notice AUDIT FIX D-AMM-H3: pair-reset lifecycle events.
    event PairResetProposed(address indexed pair, uint256 executeAfter);
    event PairResetExecuted(address indexed pair);
    event PairResetCancelled(address indexed pair);
    event PairReset(address indexed pair);

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice AUDIT FIX (2026-05-25 2nd pass): relocated here from the removed TWAPAdmin.
    error TWAPZeroAddress();
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
    /// @dev AUDIT FIX FRESH-2026 [M-TWAP-FLOOR-MIN]: floor < 1000 wei rejected.
    ///      Mirrors UniV2's MINIMUM_LIQUIDITY so a captured-key cannot set
    ///      a 1-wei floor that effectively disables the deviation gate.
    error FloorTooLow();
    /// @notice FRESH-EYES H-2: factory has disabled this pair. Refusing observations during
    ///         the disabled window prevents manipulated frozen-reserve poisoning of the buffer.
    error PairDisabled();
    /// @notice AUDIT FIX D-AMM-H1: dormancy-bypass observation is owner-only.
    error BypassObservationOwnerOnly();
    /// @notice AUDIT FIX D-AMM-M5: `consult()` refuses to serve a price derived from
    ///         a buffer where the latest observation was admitted under bypass.
    error OracleRebootstrapping();
    /// @notice AUDIT FIX D-AMM-H3: zero-address parameter on `proposeAdminResetPair`.
    error PairResetZeroAddress();
    // AUDIT FIX 2026-05-26 [M-13] — typed revert for the no-op `setUpdateFee`
    // call (caller submitted the same value already in storage).
    error SameValue();

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
        // FRESH-EYES H-2: refuse to record observations against disabled pairs. Disabled-pair
        // reserves are frozen at the moment of disable (swap/mint/burn/sync are all blocked),
        // so any cumulative we'd integrate from this point forward is `frozenSpot * elapsed` —
        // and `frozenSpot` may itself be a flash-loan-manipulated value the guardian's disable
        // tx pinned in place. Reject here so the buffer is not poisoned during the disabled
        // window. Once governance re-enables the pair, organic swaps will restore an honest
        // cumulative before the next observation lands.
        if (factory.disabledPairs(pair)) revert PairDisabled();

        // AUDIT FIX 2026-05-16 M17: move `canUpdate` check BEFORE fee accounting and
        // reserve reads. Pre-fix, losing-race keepers paid for storage writes
        // (accumulatedFees increment, refund attempt) and reserve reads before the
        // period check rejected them — wasted gas on every loss. Reverting early
        // saves contending keepers gas without changing any success-path behavior.
        // Tx revert still rolls back the value transfer, so callers lose nothing
        // but unused gas (parity with any other early revert).
        if (!canUpdate(pair)) revert PeriodNotElapsed();

        // AUDIT FIX F-95-K-4 (2026-05): when the owner has not explicitly
        // configured `updateFee`, enforce a `MIN_UPDATE_FEE` floor so the
        // permissionless `update()` cannot be cheap-grief-spammed at every
        // MIN_PERIOD boundary. Once the owner calls `setUpdateFee` (with ANY
        // value, including 0) the explicit configuration applies and the
        // default floor no longer engages.
        uint256 effectiveFee = updateFeeConfigured ? updateFee : MIN_UPDATE_FEE;
        if (effectiveFee > 0) {
            if (msg.value < effectiveFee) revert InsufficientFee();
            accumulatedFees += effectiveFee;
            // Refund overpayment.
            // AUDIT FIX M-44 / F-55-8 (2026-05): bound the gas stipend on the
            // refund leg and divert overflow into `accumulatedFees` on
            // failure rather than reverting. Pre-fix, an unbounded raw call
            // with `require(ok)` let any contract caller whose receive() is
            // gas-heavy (or hostile) brick the entire `update()` path —
            // freezing TWAP advancement until the keeper rotates wallets.
            // The 30k stipend is enough for an EOA refund and a typical
            // Safe/SCW receive() while preventing the recipient from running
            // arbitrary code that would justify reverting. If the stipend is
            // insufficient (or the recipient deliberately reverts), the
            // excess stays in `accumulatedFees` — the caller effectively
            // tipped the protocol. This matches the F-55-8 recommendation
            // ("on failure, accumulate the excess into accumulatedFees").
            uint256 excess = msg.value - effectiveFee;
            if (excess > 0) {
                // SLITHER 2026-05-18: nonReentrant on entrypoint; CEI verified in audit
                // slither-disable-next-line reentrancy-eth
                (bool ok,) = msg.sender.call{value: excess, gas: 30000}("");
                if (!ok) {
                    // Failed refund -> bank as fee tip. Cannot revert because
                    // doing so re-opens the F-55-8 brick vector.
                    // AUDIT FIX FRESH-2026: TWAP-REFUND-BANK-EVENT [MEDIUM] —
                    //         emit observability event so off-chain monitors
                    //         distinguish "tip" from "broken-recipient" mode.
                    accumulatedFees += excess;
                    emit RefundBanked(msg.sender, excess);
                }
            }
        } else {
            // Owner has explicitly opted into a zero fee; reject any sent
            // value to prevent accidental ETH lock-in. (Cannot reach this
            // branch on a fresh deploy because MIN_UPDATE_FEE > 0 applies
            // until `setUpdateFee` flips `updateFeeConfigured`.)
            require(msg.value == 0, "FEE_NOT_SET");
        }
        // AUDIT FIX 2026-05-16 M17: canUpdate moved above (pre-fee). Original check
        // location kept in comment for code-archeology reference.

        (uint112 reserve0, uint112 reserve1, uint32 pairBlockTs) = ITegridyPair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();
        // AUDIT FIX (BATCH-N3 H6): per-pair minimum reserve floor. Pre-fix,
        // any pair the factory recognized could be observed regardless of
        // liquidity depth — a low-TVL pair is single-trader-manipulable
        // within the deviation gate. Owner can set a per-pair floor
        // (denominated in reserve units) that gates `update()`.
        // AUDIT FIX F-31-C / M-24 (FRESH-EYES 2026-05): use the effective floor
        // (per-pair override OR `DEFAULT_MIN_RESERVE_FLOOR_WEI` fallback) so newly
        // registered pairs ship with a non-zero floor by default. Owner can lower
        // explicitly via `setMinReserveFloor` for legitimate small-depth pairs.
        // AUDIT FIX F-24-2 (2026-05): per-side floor — side-0 floor gates
        // reserve0; side-1 effective floor (with side-0 fallback) gates
        // reserve1, eliminating the cross-decimal misconfiguration footgun.
        uint256 floor0 = effectiveMinReserveFloor(pair);
        uint256 floor1 = effectiveMinReserveFloor1(pair);
        if (uint256(reserve0) < floor0 || uint256(reserve1) < floor1) {
            revert ReservesBelowFloor();
        }

        // SLITHER 2026-05-18: Uniswap V2 oracle-timestamp truncation; not used as randomness source
        // slither-disable-next-line weak-prng
        uint32 blockTs = uint32(block.timestamp % 2 ** 32);
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        uint256 spotPrice0 = (uint256(reserve1) * Q112) / reserve0;
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
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

        // AUDIT FIX 2026-07-23 [L-4] — deviation-baseline ratchet (Spartan M1 /
        // 1000-agent L-4). `lastSpot{0,1}` is the baseline the deviation gate measures
        // the NEXT observation against. It used to be written from the raw instantaneous
        // `spotPrice`, which made the baseline a free-running ratchet: every accepted
        // observation may move up to MAX_DEVIATION_BPS (20%), and because the write took
        // the instantaneous reserve ratio, a single-block move — a flash-loan swing, or
        // simply a large honest trade landing in the same block as the keeper's update —
        // latched as the anchor for the next comparison. Repeated at the 15-min
        // MIN_UPDATE_INTERVAL cadence that walks the baseline arbitrarily far from real
        // price, after which honest observations trip `PriceDeviationTooLarge` and the
        // buffer stalls until the 1-day dormancy bypass or the 24h `proposeAdminResetPair`
        // heals it. Liveness DoS only — the served TWAP is computed from the pair-native
        // cumulative and was never affected.
        //
        // Fix: seed the baseline from the cumulative-derived TWAP over the interval since
        // the previous observation instead of from the instantaneous spot. Moving the
        // baseline now costs holding the price for the whole interval rather than for one
        // block, which is exactly the manipulation-cost property the accumulator exists to
        // provide. Falls back to spot when no interval is available (`elapsed == 0`) or the
        // integral degenerates to zero — never leaving the baseline unseeded, which would
        // re-open the H-TWAP-OBS4-UNGATED skip at the `prev0 > 0` checks below.
        //
        // Note for operators: the gate now compares the current spot against the previous
        // interval's TIME-AVERAGE, so a fast trending market reads slightly wider than the
        // old spot-vs-spot comparison. A real ~20% move inside one 15-min interval tripped
        // the old gate too; the gate remains defense-in-depth over the accumulator, with
        // the documented dormancy/admin-reset recovery paths unchanged.
        // Pattern of record: Uniswap V2's oracle deliberately ignores intra-block price
        // (the accumulator only advances on the first touch of each block) for the same
        // reason this baseline now does.
        uint256 baseline0 = spotPrice0;
        uint256 baseline1 = spotPrice1;

        // AUDIT FIX F-24-1 (2026-05) — post-resume / long-idle reserve
        // poisoning. If the pair's last touch is more than MAX_BRIDGING_GAP
        // behind the current block, the bridging math integrates
        // `currentSpot * elapsedSinceLastPairTouch` across an idle window we
        // cannot trust (frozen disable interval, multi-day dormancy without
        // arbitrage corrections, etc.). Force `bypassed = true` so consult
        // fail-closes via `best.bypassed` / `latest.bypassed` until honest
        // activity refreshes the buffer. Stamp `lastBypassUsed[pair]` so
        // consumer-side cooldowns (TegridyLending._positionETHValue,
        // POL._twapMinOut) also refuse the read for `TWAP_PERIOD * 2`. We
        // only trip this for `count > 0` because the very first observation
        // already has its own bypass path with no prior pair-touch baseline
        // to compare against.
        bool bridgingGapTrip = (count > 0) && (uint256(elapsedSinceLastPairTouch) > MAX_BRIDGING_GAP);

        // AUDIT FIX F-74-11 (2026-05) — sequencer-outage observation. By
        // design, `update()` is callable during outages so the buffer can
        // refresh while the chain is unavailable; but observations recorded
        // during the outage integrate against frozen reserves a malicious
        // keeper could have pre-positioned. Mark such observations
        // `bypassed = true` so the existing `best.bypassed` /
        // `latest.bypassed` guards in `_getCumulativePricesOverPeriod`
        // discard them. address(0) sequencerFeed (mainnet) is a no-op via
        // `tryCheckSequencerUp`. Use a 4h staleness window to mirror the
        // tighter price-sensitive cadence used by the lending and POL
        // consumers (DEEP-LIB-M3 / F-74-4).
        bool sequencerOutage = false;
        if (sequencerFeed != address(0)) {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            (bool seqOk,) =
                SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);
            sequencerOutage = !seqOk;
        }

        if (count == 0) {
            // FRESH-EYES H-3 (first-observation manipulation): mark the very first
            // observation as `bypassed = true` so consult() refuses to serve any
            // TWAP whose lookup window includes it — until at least one non-bypass
            // observation has overwritten the bootstrap slot AND the bootstrap has
            // rolled out of the lookup window. Pre-fix, ANY spot price was accepted
            // as the anchor for a brand-new pair (no prior `lastSpot` to gate
            // against), letting an attacker create a pool at a manipulated 1:100
            // ratio, fund it asymmetrically, and call `update()` to permanently
            // anchor a poisoned baseline. The deviation gate then accepts subsequent
            // observations within the deviation cap of the manipulated anchor — and
            // any downstream consumer (lending oracle, POL harvest) silently reads
            // the lie. By marking bypassed=true here, we reuse the same fail-safe
            // path that already guards the dormancy-bypass case (D-AMM-M5 +
            // V2-AMM-H1 + the `best.bypassed` check inside
            // `_getCumulativePricesOverPeriod`). The next non-bypass observation
            // (which DOES enforce deviation against `lastSpot`) restores trust
            // once two clean observations are present.
            // AUDIT FIX FRESH-2026: TWAP-FIRST-OBS-OWNER-GATE [HIGH] — restrict
            //         the count==0 bootstrap to `owner` only, mirroring the
            //         existing D-AMM-H1 dormancy-bypass gate at line 640.
            //         Pre-fix, `bypassed=true + best.bypassed` revert pair
            //         made the OBSERVED price unconsultable, BUT `lastSpot{0,1}`
            //         was set unconditionally at lines 669-670 from the
            //         attacker's manipulated reserves. Subsequent obs #4 then
            //         tripped the deviation gate against the poisoned
            //         baseline, bricking the buffer for ~24h until adminResetPair.
            //         Owner-only bootstrap forces an honest baseline at the
            //         single inflection point where there is no prior
            //         `lastSpot` to gate against.
            if (msg.sender != owner()) revert BypassObservationOwnerOnly();
            bypassed = true;
            lastBypassUsed[pair] = block.timestamp;
            emit DeviationBypassed(pair, 0, spotPrice0, spotPrice1);
        } else {
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

            // AUDIT FIX 2026-07-23 [L-4]: derive the next deviation baseline from the
            // interval TWAP `(currentCum - lastCum) / elapsed`. Subtraction is unchecked
            // to match Uniswap V2's wrapping-accumulator semantics (same convention as
            // the bridged cumulative above). See the rationale block at the `baseline0`
            // declaration. Zero-elapsed or degenerate integrals keep the spot fallback.
            if (elapsed > 0) {
                unchecked {
                    baseline0 = (price0Cumulative - last.price0Cumulative) / uint256(elapsed);
                    baseline1 = (price1Cumulative - last.price1Cumulative) / uint256(elapsed);
                }
                // SLITHER: sentinel comparison (zero/uninitialized check)
                // slither-disable-next-line incorrect-equality
                if (baseline0 == 0) baseline0 = spotPrice0;
                // slither-disable-next-line incorrect-equality
                if (baseline1 == 0) baseline1 = spotPrice1;
            }

            // M-2 (audit 013): dormancy-bypass — if the pair has been dormant for longer
            // than DEVIATION_BYPASS_AFTER, skip the deviation gate so a stale baseline
            // cannot self-brick the oracle when real price has drifted past the deviation
            // cap during dormancy. The deviation gate is defense-in-depth on top of the
            // new pair-native accumulator: the accumulator itself already integrates price
            // across the entire idle period, so the gate should not block legitimate
            // post-dormancy refreshes.
            // AUDIT FIX (BATCH-M3 H7): self-bootstrap grace. Observations 2 and 3
            // are admitted with `bypassed = true` (skip deviation gate). Pre-fix,
            // observation #2 was deviation-gated against #1's lastSpot — if #1 was
            // bootstrapped at a manipulated/non-real ratio, every subsequent honest
            // observation tripped the gate and bricked the pair for 24-48h until
            // owner ran proposeAdminResetPair. Allowing 3 self-correction observations
            // before deviation enforcement kicks in lets the oracle recover from a
            // bad bootstrap without admin intervention. Observation #4 onwards
            // enforces normal deviation. The 3-observation grace is bounded by
            // MIN_UPDATE_INTERVAL = 15min.
            if (count <= 2) {
                // AUDIT FIX H-13 / F-89-K / F-46-2 / F-24-3 (2026-05): stamp
                // `lastBypassUsed[pair]` here so consumer cooldowns
                // (TegridyLending._positionETHValue, POL._twapMinOut) fire
                // for the BATCH-M3 H7 self-bootstrap grace observations
                // (#2 and #3) as well as the count==0 bootstrap and the
                // owner-only dormancy-bypass branch. Pre-fix the
                // `lastBypassUsed` cooldown was silent on obs #2/#3 even
                // though those observations were admitted with the
                // deviation gate skipped — the `best.bypassed` revert in
                // consult masked the gap, but the lender's typed
                // `OracleStale` revert was bypassed in favour of the inner
                // `OracleRebootstrapping` revert. Off-chain monitoring that
                // keys off typed errors missed the rebootstrap signal.
                // AUDIT FIX FRESH-2026: TWAP-FIRST-OBS-OWNER-GATE [HIGH] —
                //         restrict the self-bootstrap grace (count <= 2)
                //         to `owner` only, mirroring the count==0 gate
                //         and the D-AMM-H1 dormancy-bypass gate. Pre-fix,
                //         each of obs #2/#3 admitted bypassed=true while
                //         simultaneously OVERWRITING `lastSpot{0,1}` from
                //         the attacker's manipulated reserves at lines
                //         669-670. By the time obs #4 (deviation-gated)
                //         landed, `lastSpot` had been pinned at the
                //         manipulated value — the honest #4 then tripped
                //         the deviation gate. Closing the 3-obs window to
                //         owner-only writes ensures the baseline is honest
                //         all the way through the bootstrap-to-enforcement
                //         transition. Once count > 2 the path is
                //         permissionless again.
                if (msg.sender != owner()) revert BypassObservationOwnerOnly();
                bypassed = true;
                lastBypassUsed[pair] = block.timestamp;
                emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
            } else if (uint256(elapsed) <= DEVIATION_BYPASS_AFTER) {
                uint256 prev0 = lastSpot0[pair];
                uint256 prev1 = lastSpot1[pair];
                // AUDIT FIX FRESH-2026 [H-TWAP-OBS4-UNGATED]: when the lastSpot
                // baseline has never been seeded (count<=2 bypass paths under
                // the H-Z `count > 2` write-gate did NOT write lastSpot, so
                // prev0/prev1 are zero through observation #3), the `if (prev0
                // > 0)` checks below SKIP — leaving obs #4 (the first
                // permissionless observation) with NO deviation enforcement.
                // An attacker who races the first permissionless update at
                // the MIN_PERIOD boundary post-bootstrap with flash-loan
                // distorted reserves pins lastSpot at their value; subsequent
                // honest obs #5+ either fit within a 20% bend of the lie or
                // trip PriceDeviationTooLarge — bricking the buffer for 24h
                // until proposeAdminResetPair. Restrict the unseeded transition
                // to owner-only so the baseline is anchored under owner
                // verification, the same trust assumption as count<=2 grace.
                // Once prev0 > 0 (i.e. obs #5+), the path is permissionless
                // again and the 20%-per-step deviation gate provides the
                // ongoing manipulation cap.
                if ((prev0 == 0 || prev1 == 0) && msg.sender != owner()) revert BypassObservationOwnerOnly();
                if (prev0 > 0) {
                    uint256 deviation0 = spotPrice0 > prev0
                        ? ((spotPrice0 - prev0) * BPS) / prev0
                        : ((prev0 - spotPrice0) * BPS) / prev0;
                    // AUDIT FIX F-46-1 (2026-05): tighten boundary to `>=` so
                    // an exact `MAX_DEVIATION_BPS` step also reverts. Pre-fix
                    // the strict `>` allowed an exact-2000-bps step to slide
                    // through, giving manipulators a free deviation-cap bend
                    // per observation on low-TVL pairs.
                    if (deviation0 >= MAX_DEVIATION_BPS) revert PriceDeviationTooLarge();
                }
                if (prev1 > 0) {
                    uint256 deviation1 = spotPrice1 > prev1
                        ? ((spotPrice1 - prev1) * BPS) / prev1
                        : ((prev1 - spotPrice1) * BPS) / prev1;
                    // AUDIT FIX F-46-1 (2026-05): inclusive boundary; see
                    // `deviation0` comment above.
                    if (deviation1 >= MAX_DEVIATION_BPS) revert PriceDeviationTooLarge();
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
                // drifted past the deviation cap during dormancy — see
                // DEVIATION_BYPASS_AFTER.
                if (msg.sender != owner()) revert BypassObservationOwnerOnly();
                bypassed = true;
                lastBypassUsed[pair] = block.timestamp;
                emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
            }
        }

        // AUDIT FIX F-24-1 / F-74-11 (2026-05): apply the post-resume
        // bridging-gap and sequencer-outage flags *after* the deviation
        // branches so they OR with whatever decision the deviation gate
        // produced. If either trip fires we force `bypassed = true` and
        // stamp `lastBypassUsed[pair]` so consumer cooldowns engage. Both
        // tripwires are no-ops on the count==0 bootstrap path (which
        // already set bypassed=true) and the count==2/3 self-bootstrap
        // grace; their value comes from gating the count>=4 honest path
        // when the underlying conditions for that honest cumulative are
        // not met (frozen disable interval / unrefreshed reserves during
        // a sequencer outage).
        // AUDIT FIX L5: track whether THIS observation's bypass was FORCED by an
        // outage / bridging-gap trip (the permissionless path) so the honest
        // deviation baseline can be preserved below.
        //
        // AUDIT FIX FRESH-2026 [H-TWAP-COMBINED-DORMANCY-OUTAGE]: compute
        // `forcedBypass` UNCONDITIONALLY (decoupled from `bypassed`). The
        // prior `if (!bypassed && ...)` guard meant the flag was only set
        // when no other branch had already raised `bypassed` — but the
        // dormancy-bypass branch (count>2 + elapsed>DEVIATION_BYPASS_AFTER)
        // pre-empts that condition. In the combined case (dormancy + outage
        // or dormancy + multi-MAX_BRIDGING_GAP idle), `forcedBypass` stayed
        // false, and the L5 lastSpot-write gate at L863 (`!forcedBypass &&
        // count > 2`) silently admitted writes from frozen/unrefreshed
        // reserves — violating the L5 invariant comment immediately below.
        // Decoupled computation closes the combined-event case while
        // preserving all single-event semantics: bypassed is OR'd from
        // both sources; forcedBypass is a pure function of the
        // outage/bridging trips and reflects the physical untrustworthiness
        // of the spot regardless of which branch raised bypassed.
        bool forcedBypass = (bridgingGapTrip || sequencerOutage);
        if (forcedBypass && !bypassed) {
            bypassed = true;
            lastBypassUsed[pair] = block.timestamp;
            uint32 elapsedForEvent;
            unchecked {
                elapsedForEvent = blockTs - pairBlockTs;
            }
            emit DeviationBypassed(pair, elapsedForEvent, spotPrice0, spotPrice1);
        }

        // R012: capture the spot prices for the next deviation gate (H-1/H-2).
        // AUDIT FIX L5: do NOT overwrite the baseline when the bypass was FORCED by a
        // sequencer outage / bridging-gap trip. During an outage the spot is derived
        // from frozen/unrefreshed reserves; writing it would let a post-resume attacker
        // (first in the queue) pin a manipulated baseline and brick honest updates via
        // the deviation gate until the dormancy/admin-reset path heals.
        //
        // AUDIT FIX FRESH-2026 [H-TWAP-BYPASS-LASTSPOT] (REVISED): the
        // earlier `!bypassed` gate over-restricted writes — closing the
        // bootstrap-sandwich attack at count<=2 but ALSO blocking the
        // dormancy-bypass branch (count>2 + elapsed>DEVIATION_BYPASS_AFTER)
        // from reseeding `lastSpot`. After a legitimate dormancy-bypass, the
        // pre-dormancy `lastSpot` is by definition stale (real market price
        // has drifted >20% during the dormant window — that's exactly why
        // owner invoked the bypass), so the next deviation-gated observation
        // would compare current honest spot to stale lastSpot, trip
        // `PriceDeviationTooLarge`, and require the 24h `proposeAdminResetPair`
        // path to recover. Revised gate: refuse the write only on the
        // bootstrap-and-grace paths (count<=2) AND on the forced-bypass
        // (outage/bridging-gap) path; ALLOW the write on the dormancy-bypass
        // and honest paths (both count>2). Justifications by branch:
        //   - count<=2 (bootstrap + grace): owner-only, but sandwichable
        //     across multi-block grind; refusing the write closes that surface.
        //   - count>2 + dormancy-bypass: owner-only, fires only after >1day
        //     of dormancy; reseeding is REQUIRED for recovery (this is the
        //     branch's entire purpose). Manipulation cost is the inventory
        //     carry across 1+ day of dormancy, far higher than the bootstrap
        //     case. The bypass observation itself is consult-side rejected
        //     via `best.bypassed`, so a manipulated reseed only affects the
        //     deviation-gate baseline (bounded next-step bend at 20%).
        //   - forcedBypass: spot is from frozen/unrefreshed reserves under
        //     outage/long-bridging; refusing the write is the L5 invariant.
        //   - count>2 honest: unchanged write-through.
        // Pattern of record: Uniswap V3's observation.tick is sourced from
        // the last accepted swap in the block — symmetric here for the honest
        // and dormancy-recovery paths.
        // AUDIT FIX 2026-07-23 [L-4]: write the interval-TWAP-derived baseline rather than
        // the raw spot. Branch conditions are unchanged — only the VALUE written differs.
        if (!forcedBypass && count > 2) {
            lastSpot0[pair] = baseline0;
            lastSpot1[pair] = baseline1;
        }

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
    /// @notice AUDIT FIX F-46-3 (2026-05) — bootstrap timeline. After a fresh
    ///         pair is registered, observations #1, #2, and #3 are admitted
    ///         with `bypassed = true` (the count==0 fail-closed bootstrap
    ///         and the count<=2 self-bootstrap grace). Observation #4 is the
    ///         first non-bypass anchor candidate. For a 30-min `consult()`
    ///         period at the canonical 15-min cadence, the lookback target
    ///         lands on the bypassed slots at observations #4 and #5 — both
    ///         of those calls revert `OracleRebootstrapping` via the
    ///         `best.bypassed` guard. Only at observation #6 (~75 min after
    ///         pair creation) does `consult(period=30 min)` first return a
    ///         non-revert price. Integrators bootstrapping new pairs MUST
    ///         account for this ~6-observation warm-up window.
    ///
    /// @notice AUDIT FIX 2026-05-26 [L-22] — Fresh pair warm-up window is
    ///         ~105 min (45 min owner-bootstrap of obs #1/#2/#3/#4 at the
    ///         15-min MIN_PERIOD cadence + 60 min consumer cooldown). Consumer
    ///         harvest reverts during this window — by design (fail-closed).
    ///         The 60-min cooldown is the lender's / POL's `lastBypassUsed`
    ///         gate (TegridyLending._positionETHValue, POL._twapMinOut);
    ///         the 45-min on-chain part is the four sequential owner
    ///         observations at MIN_PERIOD apart.
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
    ///
    /// @notice CONSUMER REQUIREMENT (idle-pair bridging — 2026-05-25 audit): the
    ///         per-observation cumulative includes a `spot * elapsedSinceLastPairTouch`
    ///         bridge term (R014 stale-pair freshness fix), bounded by MAX_BRIDGING_GAP
    ///         and the per-step MAX_DEVIATION_BPS gate. On a pair that is idle between
    ///         observations, a single gate-passing endpoint can weight the consult average
    ///         toward a recently-manipulated spot. The manipulation must PERSIST across the
    ///         idle gap (arbitrage-resisted) and the pair must clear the per-pair reserve
    ///         floor, but `consult()` ALONE is NOT a manipulation-proof price. Every
    ///         consumer MUST therefore (a) reject pairs below a meaningful reserve floor
    ///         (see `effectiveMinReserveFloor`) AND (b) gate the read against live spot with
    ///         a deviation bound — exactly the `_assertSpotNearTWAP` pattern POLAccumulator
    ///         already applies (50 bps; the only in-tree consult() consumer). Do NOT consume
    ///         `consult()` as a sole price oracle (e.g. lending valuation / liquidation)
    ///         without that spot-vs-TWAP sanity gate. The bridge is intentionally NOT
    ///         removed here: dropping it reintroduces the R014 stale-pair drift, and the
    ///         spot-gate is the correct, battle-tested place to bound the residual.
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external
        view
        returns (uint256 amountOut)
    {
        // R062 (HIGH): refuse to serve TWAP reads when the L2 sequencer is
        // currently down or has just resumed within SEQUENCER_GRACE_PERIOD.
        // address(0) sequencerFeed is a no-op (mainnet / non-L2 deployments).
        // AUDIT FIX M-48 / F-74-4 (2026-05): pass an explicit 4h staleness
        // window via the 3-arg overload, matching the price-sensitive
        // cadence used by TegridyLending and POLAccumulator. The lib's
        // 24h default would otherwise let a Chainlink keeper that has not
        // pushed for >4h-but-<=24h pass the gate, even though the cached
        // "up" answer may no longer reflect reality.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);

        // FRESH-EYES H-5 (companion to FRESH-EYES H-2 on update): refuse to serve
        // a TWAP read for a pair that is currently disabled at the factory. Even
        // if every observation in the buffer was admitted while the pair was live,
        // the most recent few may have been recorded against reserves that the
        // factory disabled mid-window — meaning the pair's price{0,1}CumulativeLast
        // is now frozen at a manipulated spot. Refusing here forces consumers
        // (POL harvest, lending ETH-floor) to fall back to their fail-closed
        // paths until governance re-enables and an honest post-resume observation
        // anchors the next consult. Mirrors the SequencerCheck-style gate.
        if (factory.disabledPairs(pair)) revert PairDisabled();

        if (amountIn == 0) revert InvalidAmount();
        if (period == 0) revert InvalidAmount();
        if (period > uint256(MAX_OBSERVATIONS) * MIN_PERIOD) revert PeriodTooLong();

        // AUDIT FIX 2026-05-16 M15: re-verify pair reserves meet the floor at
        // CONSULT time, not just at update() time. Pre-fix, a pair that was
        // well-funded when observations were recorded could have been drained to
        // below the floor between then and now — `update()` rejects new
        // observations (ReservesBelowFloor) so the buffer freezes, and `consult()`
        // would happily serve the stale-but-honest TWAP from a now-thin pool for
        // up to MAX_STALENESS (2h). Within that window, downstream consumers
        // (lending oracle, POL accumulator) over-valued positions on a pool that
        // any small swap could move 90%+. Re-checking here closes the window
        // structurally — the same floor applied at update() applies at consult().
        {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            (uint112 _r0, uint112 _r1,) = ITegridyPair(pair).getReserves();
            uint256 _f0 = effectiveMinReserveFloor(pair);
            uint256 _f1 = effectiveMinReserveFloor1(pair);
            if (uint256(_r0) < _f0 || uint256(_r1) < _f1) revert ReservesBelowFloor();
        }

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
        // AUDIT FIX F-24-4 / F-42-2 (2026-05): use OZ Math.mulDiv to compute
        // `(amountIn * priceDiff) / (uint256(elapsed) * Q112)` without
        // requiring the intermediate product to fit in 256 bits. Pre-fix,
        // an extreme-imbalance pair (large 18-decimal reserve paired with
        // a tiny low-decimal reserve) could push `priceDiff` near 2^200,
        // and at `amountIn` near 2^60 (~ 1e18) the checked multiplication
        // panicked with `Panic(0x11)` — turning `consult()` into an
        // unconditional revert for any meaningfully-sized `amountIn`. The
        // V3 OracleLibrary pattern uses the same 512-bit mulDiv to
        // sidestep the overflow without changing observable semantics.
        amountOut = Math.mulDiv(amountIn, priceDiff, uint256(elapsed) * Q112);
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

        // SLITHER 2026-05-18: Uniswap V2 oracle-timestamp truncation; not used as randomness source
        // slither-disable-next-line weak-prng
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

    /// @notice AUDIT FIX M-45 / F-72-5 (2026-05): non-reverting sister of
    ///         `getLatestObservation`. Returns `(zero-init, false)` when no
    ///         observation has been recorded for `pair` instead of reverting
    ///         `InsufficientObservations()`. This lets view-path consumers
    ///         (POLAccumulator harvest dashboards, TegridyLending
    ///         dust-eligibility frontends) degrade gracefully on brand-new
    ///         pairs that have not yet been bootstrapped, rather than
    ///         showing an opaque revert. The reverting variant remains for
    ///         callers that want fail-loud semantics. Mirrors the
    ///         `tryCheckSequencerUp` pattern in `lib/SequencerCheck.sol`.
    function tryGetLatestObservation(address pair)
        external
        view
        returns (Observation memory obs, bool exists)
    {
        uint256 count = observationCount[pair];
        if (count == 0) return (obs, false);
        uint8 lastIdx = observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
        obs = observations[pair][lastIdx];
        exists = true;
    }

    /// @notice Get the number of usable observations stored for a pair.
    function getObservationCount(address pair) external view returns (uint256) {
        uint256 count = observationCount[pair];
        return count > MAX_OBSERVATIONS ? MAX_OBSERVATIONS : count;
    }

    // ─── Internal ────────────────────────────────────────────────────

    // ─── AUDIT L7: Fee admin ─────────────────────────────────────────

    /// @notice Set the per-update fee. Capped at MAX_UPDATE_FEE.
    /// @dev    AUDIT FIX F-95-K-4 (2026-05): flipping `updateFeeConfigured`
    ///         here disengages the `MIN_UPDATE_FEE` floor and lets the
    ///         caller-supplied value (including 0) apply on subsequent
    ///         `update()` calls. Pre-fix the default of 0 made the
    ///         permissionless `update()` cheap-grief-spammable.
    function setUpdateFee(uint256 _newFee) external onlyOwner {
        if (_newFee > MAX_UPDATE_FEE) revert FeeTooHigh();
        // AUDIT FIX 2026-05-26 [M-13] — no-op guard. Owner-trust surface is
        // bounded by MAX_UPDATE_FEE so we use a SameValue revert rather than
        // a 24h timelock. The guard requires BOTH `_newFee == updateFee`
        // AND `updateFeeConfigured == true` so the first ever call to
        // `setUpdateFee(0)` (test/deploy path that explicitly opts out of
        // fees) still succeeds — pre-call `updateFee == 0` but
        // `updateFeeConfigured == false`, so the configuration flip is
        // necessary.
        if (_newFee == updateFee && updateFeeConfigured) revert SameValue();
        uint256 old = updateFee;
        updateFee = _newFee;
        updateFeeConfigured = true;
        emit UpdateFeeChanged(old, _newFee);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-11] — DEPRECATED. Use
    ///         `proposeFeeRecipient` / `executeFeeRecipient`.
    /// @dev    Per user decision 2026-05-26 ("fix conservatively where
    ///         battle-tested patterns exist") the immediate setter is
    ///         replaced with the 24h propose/execute/cancel shape.
    function setFeeRecipient(address) external pure {
        revert("Use proposeFeeRecipient()");
    }

    // AUDIT FIX 2026-05-26 [M-11] — lifecycle events for the fee-recipient
    // timelock. Mirrors PAIR_RESET propose/execute/cancel shape.
    event FeeRecipientProposed(address indexed newRecipient, uint256 executeAfter);
    event FeeRecipientCancelled(address indexed previousPending);

    /// @notice AUDIT FIX 2026-05-26 [M-11] — propose a 24h-timelocked change
    ///         to the fee recipient.
    function proposeFeeRecipient(address _recipient) external onlyOwner {
        if (_recipient == address(0)) revert TWAPZeroAddress();
        pendingFeeRecipient = _recipient;
        _propose(FEE_RECIPIENT_CHANGE, FEE_RECIPIENT_CHANGE_DELAY);
        emit FeeRecipientProposed(_recipient, _proposalReadyAt(FEE_RECIPIENT_CHANGE));
    }

    /// @notice AUDIT FIX 2026-05-26 [M-11] — execute the proposed fee-recipient
    ///         change after the 24h timelock.
    function executeFeeRecipient() external onlyOwner {
        _execute(FEE_RECIPIENT_CHANGE);
        address newRecipient = pendingFeeRecipient;
        address old = feeRecipient;
        feeRecipient = newRecipient;
        delete pendingFeeRecipient;
        emit FeeRecipientChanged(old, newRecipient);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-11] — cancel a pending fee-recipient proposal.
    function cancelFeeRecipient() external onlyOwner {
        address prev = pendingFeeRecipient;
        _cancel(FEE_RECIPIENT_CHANGE);
        delete pendingFeeRecipient;
        emit FeeRecipientCancelled(prev);
    }

    /// @notice Withdraw accumulated update fees to feeRecipient (or owner if unset).
    /// @dev AUDIT FIX D-AMM-L3: nonReentrant for defense-in-depth.
    /// @dev AUDIT FIX F-95-K-8 (2026-05): gated to `onlyOwner`. Pre-fix
    ///      this was permissionless — funds always flowed to the
    ///      `feeRecipient`/`owner` so it was not a theft vector, but ANY
    ///      caller could force the recipient (typically a multisig) to
    ///      handle many small inbound transfers, burning their gas budget.
    ///      Sweep timing should be admin-controlled.
    /// @dev AUDIT FIX 2026-05-26 [L-47] — feeRecipient must accept raw ETH
    ///      with >30k gas headroom; use a treasury contract not an
    ///      EOA-with-revert. The raw `.call{value: amount}("")` here is
    ///      retained instead of `WETHFallbackLib.safeTransferETHOrWrap`
    ///      because wiring `address public immutable weth;` requires a
    ///      constructor-signature change that would break the deploy
    ///      script. Mitigation: deployers MUST configure `feeRecipient`
    ///      to a multisig / treasury whose receive() is gas-cheap (Safe,
    ///      Sablier-style escrow) — never an EOA whose forwarder reverts
    ///      above 30k. A misconfigured recipient just makes the call fail
    ///      loudly until the recipient is fixed; no funds can be stuck
    ///      because the timelocked `proposeFeeRecipient` path (M-11) lets
    ///      the owner rotate to a working recipient.
    function withdrawFees() external nonReentrant onlyOwner {
        // [L11] Use address(this).balance rather than accumulatedFees so any
        //       ETH stranded by direct sends or update() refunds is included
        //       in the sweep and cannot accumulate indefinitely. accumulatedFees
        //       is still zeroed for accounting consistency.
        uint256 amount = address(this).balance;
        // AUDIT 2026-05-31 [slither incorrect-equality FP]: zero-sentinel check — `0`
        // balance means nothing to withdraw. Standard sentinel pattern.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NoFees();
        accumulatedFees = 0;
        address to = feeRecipient == address(0) ? owner() : feeRecipient;
        // AUDIT FIX FRESH-2026 [H-TWAP-WITHDRAW-GAS]: bound the gas stipend on
        // the recipient call to 50_000. Pre-fix, the unbounded `to.call{value:
        // amount}("")` forwarded ALL gas (millions) to the fee recipient. The
        // recipient is settable via the 24h-timelocked `proposeFeeRecipient`
        // path; a captured owner key could install a malicious recipient
        // whose receive() executes arbitrary code with `amount` ETH and full
        // gas in the call frame — most importantly enabling cross-contract
        // reentry into OTHER protocol contracts (TWAP itself is nonReentrant-
        // protected here, but the recipient's frame can call out to
        // RevenueDistributor, POLAccumulator, etc.). 50k is sufficient for
        // a Gnosis Safe v1.4 receive() with one or two modules running on the
        // ingress path (Safe's bare receive() is ~6k; a module-running variant
        // ~30k-45k) and is the same envelope Aave V3's PoolAddressesProvider
        // uses for treasury sweeps. Legitimate recipients fit comfortably;
        // hostile recipients cannot execute arbitrary downstream calls.
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
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
        // AUDIT FIX 2026-05-26 [H-07] — track pair in pending-reset set so
        // acceptOwnership() can flush it on owner rotation.
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.add returns a
        // was-added bool; idempotent add — propose key uniqueness makes
        // in-set invariant deterministic. Matches repo convention.
        // slither-disable-next-line unused-return
        _pendingResetPairs.add(pair);
        emit PairResetProposed(pair, _proposalReadyAt(key));
    }

    /// @notice AUDIT FIX D-AMM-H3: execute a previously proposed pair reset after
    ///         the 24h timelock. Clears `observationIndex`, `observationCount`,
    ///         `lastSpot{0,1}`, `lastBypassUsed` for the pair. The next observation
    ///         goes through the deviation gate against a freshly-zeroed baseline.
    /// @dev    AUDIT FIX 2026-05-26 [L-21] — WARN: Calling reset on a pair
    ///         POLAccumulator depends on requires the owner to immediately
    ///         re-bootstrap 4 observations or harvest will revert for 45+
    ///         minutes (the count==0 fail-closed bootstrap, the count<=2
    ///         self-bootstrap grace, and the consumer-side
    ///         `_assertSpotNearTWAP` cooldown all sit in front of the first
    ///         usable consult).
    function executeAdminResetPair(address pair) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        _execute(key);
        // AUDIT FIX 2026-05-26 [H-07] — clear pending-reset tracking slot.
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored — proposeAdminResetPair added it; matching pair, presence
        // implied. Matches repo convention.
        // slither-disable-next-line unused-return
        _pendingResetPairs.remove(pair);
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
        // AUDIT FIX 2026-05-26 [H-07] — clear pending-reset tracking slot.
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored — cancel path mirrors execute; presence implied by prior
        // propose. Matches repo convention.
        // slither-disable-next-line unused-return
        _pendingResetPairs.remove(pair);
        emit PairResetCancelled(pair);
    }

    /// @notice Legacy view helper for pair-reset proposal timestamp.
    function pairResetTime(address pair) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(PAIR_RESET, pair));
        return _proposalReadyAt(key);
    }

    // AUDIT FIX 2026-05-26 [H-07] — pending-reset flush event.
    event AdminResetPairCancelled(address indexed pair);

    /// @notice AUDIT FIX 2026-05-26 [H-07] — override `acceptOwnership` to
    ///         flush every pending per-pair PAIR_RESET timelock queued by
    ///         the outgoing owner. Pre-fix, an outgoing-or-compromised owner
    ///         could queue dozens of `proposeAdminResetPair` calls and rely
    ///         on the incoming owner to manually `cancelAdminResetPair` each
    ///         one within the 7-day proposal validity window. The new owner
    ///         had no on-chain enumeration of which pairs were pending — a
    ///         missed cancel meant the outgoing owner's reset would execute
    ///         under the new owner's timelock. Flushing on acceptance
    ///         closes that cross-owner replay vector atomically.
    function acceptOwnership() public override {
        super.acceptOwnership();
        // Drain in reverse so each `remove` swaps the tail into the just-
        // processed slot — O(n) total instead of O(n^2) from forward-iterating.
        uint256 len = _pendingResetPairs.length();
        for (uint256 i = len; i > 0; --i) {
            address p = _pendingResetPairs.at(i - 1);
            _forceCancel(keccak256(abi.encodePacked(PAIR_RESET, p)));
            // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove
            // return ignored — `.at(i-1)` above guarantees the element exists.
            // Matches repo convention.
            // slither-disable-next-line unused-return
            _pendingResetPairs.remove(p);
            emit AdminResetPairCancelled(p);
        }
    }

    /// @notice AUDIT FIX 2026-05-26 [H-07] — number of pairs with a pending
    ///         `PAIR_RESET` proposal. Off-chain monitors / multisig signers
    ///         can read this before accepting a pending ownership transfer.
    function pendingResetPairsLength() external view returns (uint256) {
        return _pendingResetPairs.length();
    }

    /// @notice AUDIT FIX 2026-05-26 [H-07] — view accessor for the
    ///         enumerable pending-reset set.
    function pendingResetPairAt(uint256 i) external view returns (address) {
        return _pendingResetPairs.at(i);
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
        // year-2106 rollover. Previously the uint32->uint256 implicit upcast made the
        // staleness diff explode at the wrap, bricking every consult() consumer.
        // SLITHER 2026-05-18: Uniswap V2 oracle-timestamp truncation; not used as randomness source
        // slither-disable-next-line weak-prng
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
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
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
        // PASS7-TWAP-01 FIX: removed the V3-AMM-L1 `&& found` carve-out. The
        // pre-fix logic `if (best.bypassed && found) revert` reverted only on
        // the honest-anchor path; the !found fallback (sparse pair, `period >
        // available window`) still anchored on the bypassed bootstrap slot
        // and returned a poisoned price derived from the manipulated initial
        // reserves. PoC `PASS7_TWAP_01_consultReturnsPoisonedPriceFromBypassedBootstrap`
        // demonstrated POL's TWAP_PERIOD = 30 min consult returning the
        // manipulated bootstrap baseline within 1 wei.
        //
        // Failing closed on a bypassed-anchor !found fallback restores the
        // FRESH-EYES H-3 invariant: NO consult that returns > 0 may anchor on
        // a `bypassed` observation. Consumers that genuinely want graceful
        // degradation on sparse pairs should consult `lastBypassUsed[pair]`
        // explicitly and choose their own fallback policy (as TegridyLending
        // does at L1255-1259) — the single TWAP entrypoint cannot be both
        // fail-open and fail-closed.
        if (best.bypassed) revert OracleRebootstrapping();

        // FRESH-EYES M-1: even if `best` is non-bypassed, it may have been recorded DURING
        // an L2 sequencer outage. `update()` is permitted during outages so the buffer can
        // refresh, but those observations integrate against potentially stale/manipulated
        // reserves frozen by the outage. A flash-loaned arb at the front of the resumed
        // queue can push reserves before any honest swap lands; an `update()` call right
        // after captures that manipulated spot. Once the 1h grace lifts, `consult()` would
        // happily anchor at the poisoned slot. Reject any `best` whose timestamp predates
        // the post-resume grace window. Mirrors the latest-side guard already enforced via
        // `SequencerCheck.checkSequencerUp` at the consult() entry, but applied to the
        // anchor end of the window. address(0) sequencerFeed (mainnet) is a no-op.
        if (sequencerFeed != address(0)) {
            uint256 resumeAt = SequencerCheck.getResumeTimestamp(sequencerFeed);
            // AUDIT FIX FRESH-2026: F-TWAP-SENTINEL — short-circuit on
            //         `type(uint256).max` (the M-34 fail-closed sentinel for stale
            //         feed paths) before adding `SEQUENCER_GRACE_PERIOD`, otherwise
            //         the addition overflows checked-math and surfaces `Panic(0x11)`
            //         instead of the typed `OracleRebootstrapping` selector that
            //         off-chain decoders branch on. Aave V3 PriceOracleSentinel
            //         uses the same short-circuit pattern.
            if (resumeAt == type(uint256).max) revert OracleRebootstrapping();
            // AUDIT FIX 2026-05-26 [M-12] — Year-2106 wrap concern; current
            //   arithmetic safe until then because resumeAt is bounded by
            //   Unix timestamps (~1.8e9, well under uint32 wrap horizon of
            //   4.29e9). At year-2106 `best.timestamp` wraps modulo 2^32
            //   while `resumeAt` continues to grow linearly, breaking the
            //   comparison. A correct fix requires either widening
            //   `Observation.timestamp` (storage-layout change) or
            //   rewriting the gate in uint32 modular semantics like the
            //   `targetTimestamp` pattern at lines ~1093-1099 (which would
            //   require narrowing `resumeAt + GRACE` to uint32 and losing
            //   the ability to distinguish pre/post-wrap resume timestamps).
            //   Both need coordinated work with the SequencerCheck lib.
            //   Documented as a known limitation rather than papered over
            //   with a partial fix (see project_2026_05_26_swarm doc).
            if (resumeAt != 0 && uint256(best.timestamp) < resumeAt + SEQUENCER_GRACE_PERIOD) {
                revert OracleRebootstrapping();
            }
        }

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
