// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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

    function setMinReserveFloor(address pair, uint256 floor) external onlyOwner {
        if (!factory.isPair(pair)) revert UnknownPair();
        minReserveFloor[pair] = floor;
        emit MinReserveFloorSet(pair, floor);
    }

    /// @notice AUDIT FIX F-24-2 (2026-05): per-side override for the reserve-1
    ///         floor. Owner-only. A non-zero value here unbinds reserve-1 from
    ///         the side-0 floor, which is the correct behaviour on any
    ///         cross-decimal pair. Setting back to 0 restores fallback.
    function setMinReserveFloor1(address pair, uint256 floor) external onlyOwner {
        if (!factory.isPair(pair)) revert UnknownPair();
        minReserveFloor1[pair] = floor;
        emit MinReserveFloor1Set(pair, floor);
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
                    accumulatedFees += excess;
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
                bypassed = true;
                lastBypassUsed[pair] = block.timestamp;
                emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
            } else if (uint256(elapsed) <= DEVIATION_BYPASS_AFTER) {
                uint256 prev0 = lastSpot0[pair];
                uint256 prev1 = lastSpot1[pair];
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
                if (msg.sender != owner) revert BypassObservationOwnerOnly();
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
        if (!bypassed && (bridgingGapTrip || sequencerOutage)) {
            bypassed = true;
            lastBypassUsed[pair] = block.timestamp;
            uint32 elapsedForEvent;
            unchecked {
                elapsedForEvent = blockTs - pairBlockTs;
            }
            emit DeviationBypassed(pair, elapsedForEvent, spotPrice0, spotPrice1);
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
        uint256 old = updateFee;
        updateFee = _newFee;
        updateFeeConfigured = true;
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
    /// @dev AUDIT FIX F-95-K-8 (2026-05): gated to `onlyOwner`. Pre-fix
    ///      this was permissionless — funds always flowed to the
    ///      `feeRecipient`/`owner` so it was not a theft vector, but ANY
    ///      caller could force the recipient (typically a multisig) to
    ///      handle many small inbound transfers, burning their gas budget.
    ///      Sweep timing should be admin-controlled.
    function withdrawFees() external nonReentrant onlyOwner {
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
