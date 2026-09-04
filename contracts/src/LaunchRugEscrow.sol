// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// @title  LaunchRugEscrow — creator-funded launch insurance with a chain-provable trigger
///
/// @notice A creator locks their OWN ETH for a fixed window and publishes, at the same
///         instant and immutably, the exact on-chain condition under which that ETH stops
///         being theirs and becomes a pro-rata refund pool for buyers. Nothing else in
///         this contract can move the money.
///
/// ─── WHOSE CAPITAL IS AT RISK ────────────────────────────────────────────────
/// @dev    The venue never underwrites an escrow and holds no position in one. The only
///         ETH that can ever be paid out of an escrow is the ETH the creator sent to
///         `open`. There is no pooled reserve, no cross-subsidy between escrows, and no
///         owner function that can move principal. A venue fee exists on ONE path only —
///         clean expiry, where the creator is being paid — is capped at
///         `MAX_CLEAN_RELEASE_FEE_BPS`, defaults to zero, and is snapshotted into each
///         escrow at `open` so a later dial change cannot reach a live escrow. On every
///         path where buyers are refunded the venue takes zero.
///
/// ─── WHAT COUNTS AS A RUG ────────────────────────────────────────────────────
/// @dev    The EVM cannot read history and cannot form an opinion, so the trigger is
///         narrowed to something it can prove from present state: a covenant, published
///         at `open` and immutable thereafter, of the form
///
///             "these named addresses will together hold at least `minBps` of this
///              asset's supply until `windowEnd`"
///
///         An escrow carries one or more such covenants. Two are expected in practice:
///         the launched token against the deployer/team address set (a dump reduces the
///         numerator), and the LP token against the address set that holds it (pulling
///         liquidity reduces the numerator). Both are the same check, so there is one
///         code path to audit rather than a "dump detector" and a separate "LP detector".
///
///         Deliberately NOT triggers: price falling, volume drying up, the creator going
///         quiet, an off-chain accusation, a signed attestation from any party including
///         the venue. Those are judgements. A judgement-based trigger would make this
///         contract a discretionary seizure tool wearing insurance clothes, which is
///         worse for buyers than no product at all — it would invite the venue to be
///         lobbied, and it would let a creator be robbed by whoever holds the pen.
///
/// ─── THE DENOMINATOR IS CHOSEN TO FAVOUR THE CREATOR ─────────────────────────
/// @dev    Held share is measured against `min(liveTotalSupply, snapshotSupplyAtOpen)`.
///         Taking the minimum makes both supply directions harmless to an honest
///         creator: proportional deflation shrinks numerator and denominator together,
///         non-proportional burns by third parties shrink only the denominator and so
///         RAISE the measured share, and inflation is pinned at the open-time snapshot so
///         dilution by minting cannot dilute the creator into a breach. Only the tracked
///         addresses actually parting with the asset moves the measurement toward the
///         floor. Every ambiguity in this contract resolves the same way, on purpose:
///         toward the creator keeping their own money.
///
/// @dev    Tokens burned by a tracked address leave that address's balance exactly like a
///         sale does, and the chain cannot tell the two apart. A creator who intends to
///         burn must list the burn address (`0x…dEaD`, or `address(0)`) in the covenant's
///         holder set at `open`, where it is published with everything else. This
///         contract will not silently assume it.
///
/// ─── AN OUTAGE IS NOT A BREACH ───────────────────────────────────────────────
/// @dev    If the asset cannot be read — no code at the address, a reverting or paused
///         `balanceOf`, a `totalSupply` that reverts — the covenant reads as UNAVAILABLE,
///         never as zero held. `flagCovenantBreach` and `confirmCovenantBreach` both
///         revert with `CovenantUnreadable` in that state, and `covenantStatus` returns
///         `readable == false` so a fact sheet renders "cannot read" rather than a green
///         badge or a 0% holding. A read failure that seized an escrow would turn every
///         token upgrade, pause, or RPC-visible hiccup into a confiscation trigger.
///
/// ─── THE TWO-PHASE TRIGGER ───────────────────────────────────────────────────
/// @dev    A breach must be flagged inside the window and then CONFIRMED after
///         `BREACH_CURE_WINDOW` has elapsed, with the condition re-read at confirmation.
///         The gap is what makes the trigger un-grievable: a flash loan, an atomic
///         sandwich, or any single-transaction manipulation cannot hold a manufactured
///         state across three days, so it cannot produce a confirmable breach. The same
///         gap is the creator's cure window — restoring the covenanted holding before
///         confirmation clears the flag, and restoring it is exactly the behaviour buyers
///         wanted. A flag nobody confirms within `CONFIRM_DEADLINE_AFTER_FLAG` goes stale
///         and is cleared by anyone, so a flag cannot be parked to block a clean release.
///
/// ─── THE PART THAT IS TRUSTED, STATED PLAINLY ────────────────────────────────
/// @dev    The chain proves the breach. It cannot prove who bought, or how much, so the
///         pro-rata split across buyers arrives as a Merkle root posted by the
///         `refundOracle` named at `open` and published with the rest of the terms. That
///         address is the single trust assumption in this contract and consumers MUST
///         print it — "refunds are apportioned by <address>" — beside any claim that a
///         launch is insured. If it stays silent past `REFUND_ROOT_WINDOW` the principal
///         returns to the CREATOR, not to the oracle, not to the venue, and not to
///         whoever shouts loudest; so a silent or captured oracle can withhold the refund
///         but can never redirect a wei of it, and stalling buys the staller nothing.
///         Buyers of a launch whose oracle they do not trust should treat the escrow as
///         uninsured. That is a real limit of the design and it is better said here than
///         discovered later.
///
/// @dev    Immutable and unowned in every respect that touches money: no proxy, no
///         upgrade path, no pause that traps funds, no admin withdrawal, no way to edit a
///         live escrow's terms. The owner may only enable/disable NEW openings and move
///         the clean-release fee dial and sink for FUTURE escrows.
contract LaunchRugEscrow is OwnableNoRenounce, ReentrancyGuard {
    using WETHFallbackLib for address;

    // ─── Constants ────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;

    /// @notice Gap between flagging a breach and being allowed to confirm it. Doubles as
    ///         the creator's cure window; see the two-phase trigger note above.
    uint64 public constant BREACH_CURE_WINDOW = 3 days;

    /// @notice A flag that is neither confirmed nor cured within this period of being
    ///         raised is stale and clearable by anyone. Without an expiry a flag raised on
    ///         a momentary condition would block `releaseToCreator` forever.
    uint64 public constant CONFIRM_DEADLINE_AFTER_FLAG = 10 days;

    /// @notice Time the `refundOracle` has to publish the buyer split after a confirmed
    ///         breach. Past it, principal returns to the creator.
    uint64 public constant REFUND_ROOT_WINDOW = 14 days;

    /// @notice Time buyers have to claim once a root is posted. Unclaimed remainder
    ///         returns to the creator; it does not accrue to the venue.
    uint64 public constant REFUND_CLAIM_WINDOW = 60 days;

    /// @notice Bounds on the covenant window. The floor exists because a window shorter
    ///         than the cure window could expire before any breach could be confirmed,
    ///         which would sell buyers a guarantee that cannot fire.
    uint64 public constant MIN_WINDOW = 7 days;
    uint64 public constant MAX_WINDOW = 365 days;

    /// @notice Ceiling on the venue's clean-release fee. The live dial defaults to zero.
    uint16 public constant MAX_CLEAN_RELEASE_FEE_BPS = 1_000;

    uint256 public constant MAX_COVENANTS = 8;
    uint256 public constant MAX_HOLDERS_PER_COVENANT = 20;

    /// @notice The trust assumption, in one line, for surfaces that must disclose it.
    string public constant TRUST_MODEL =
        "Breach is proven on-chain from present balances. The pro-rata split across buyers is"
        " posted by the escrow's named refundOracle; if it never posts, principal returns to"
        " the creator. The venue never underwrites and never funds a refund.";

    // ─── Types ────────────────────────────────────────────────────────

    enum Status {
        None,
        Active,
        Breached,
        Refunding,
        Closed
    }

    struct CovenantInput {
        /// @notice Asset whose supply share is covenanted: the launched token, the LP
        ///         token, or any other ERC-20 the creator wants to bind.
        address asset;
        /// @notice Floor, in bps of the supply denominator, that `holders` must keep.
        uint16 minBps;
        /// @notice Addresses whose balances are summed. Naming an address the creator
        ///         does not control hands that address a breach button; the set is
        ///         published so buyers can check it is the deployer/team set it claims.
        address[] holders;
    }

    struct Covenant {
        address asset;
        uint16 minBps;
        uint256 snapshotSupply;
        address[] holders;
    }

    struct Escrow {
        address creator;
        /// @notice The launched token this escrow is advertised against. Disclosure only;
        ///         the covenants are what the trigger reads.
        address token;
        address refundOracle;
        /// @notice Destination of the clean-release fee, snapshotted at `open`.
        address feeSink;
        uint128 principal;
        uint128 claimed;
        uint64 openedAt;
        uint64 windowEnd;
        /// @notice Root-posting deadline while `Breached`, claim deadline while
        ///         `Refunding`. Meaningless in other states.
        uint64 deadline;
        uint32 pendingFlags;
        /// @notice Venue fee on clean release, snapshotted at `open` and immutable after.
        uint16 cleanFeeBps;
        Status status;
        uint256 refundTotalWeight;
        bytes32 refundRoot;
    }

    // ─── State ────────────────────────────────────────────────────────

    /// @notice WETH, for the payout fallback when a recipient rejects raw ETH.
    address public immutable weth;

    /// @notice New escrows are refused until the operator flips this. Shipping the
    ///         feature inert is the point: no launch can be advertised as insured before
    ///         someone with the keys has deliberately turned it on.
    bool public openingsEnabled;

    /// @notice Clean-release fee applied to escrows opened FROM NOW ON. Zero at deploy.
    uint16 public cleanReleaseFeeBps;

    /// @notice Sink for the clean-release fee of escrows opened FROM NOW ON. Zero at
    ///         deploy, which also forces the snapshotted fee to zero.
    address public feeSink;

    uint256 public nextEscrowId;

    mapping(uint256 => Escrow) private _escrows;
    mapping(uint256 => Covenant[]) private _covenants;

    /// @notice When covenant `i` of escrow `id` was flagged; 0 when not flagged.
    mapping(uint256 => mapping(uint256 => uint64)) public covenantFlaggedAt;

    mapping(uint256 => mapping(uint256 => uint256)) private _refundClaimed;

    // ─── Errors ───────────────────────────────────────────────────────

    error OpeningsDisabled();
    error ZeroAddress();
    error ZeroPrincipal();
    error PrincipalTooLarge();
    error WindowOutOfRange();
    error CovenantCountOutOfRange();
    error HolderCountOutOfRange();
    error DuplicateHolder(address holder);
    error MinBpsOutOfRange();
    error AssetHasNoCode(address asset);
    error CovenantUnreadable(uint256 escrowId, uint256 covenantIndex);
    error CovenantBornBreached(uint256 covenantIndex);
    error UnknownEscrow(uint256 escrowId);
    error WrongStatus(Status expected, Status actual);
    error WindowClosed();
    error WindowStillOpen();
    error AlreadyFlagged();
    error NotFlagged();
    error CovenantSatisfied();
    error CureWindowOpen();
    error FlagExpired();
    error FlagNotStale();
    error FlagsPending();
    error NotRefundOracle();
    error DeadlinePassed();
    error DeadlineNotReached();
    error ZeroRoot();
    error ZeroWeight();
    error AlreadyClaimed();
    error InvalidProof();
    error NothingToClaim();
    error FeeTooHigh();
    error CovenantIndexOutOfRange();
    error DirectPaymentRejected();

    // ─── Events ───────────────────────────────────────────────────────

    event EscrowOpened(
        uint256 indexed escrowId,
        address indexed creator,
        address indexed token,
        uint256 principal,
        uint64 windowEnd,
        address refundOracle,
        uint16 cleanFeeBps,
        address feeSink
    );
    event CovenantPublished(
        uint256 indexed escrowId,
        uint256 indexed covenantIndex,
        address indexed asset,
        uint16 minBps,
        uint256 snapshotSupply,
        uint256 openBps,
        address[] holders
    );
    event BreachFlagged(uint256 indexed escrowId, uint256 indexed covenantIndex, address flagger, uint256 observedBps);
    event BreachCured(uint256 indexed escrowId, uint256 indexed covenantIndex, uint256 observedBps);
    event BreachConfirmed(uint256 indexed escrowId, uint256 indexed covenantIndex, uint256 observedBps);
    event StaleFlagCleared(uint256 indexed escrowId, uint256 indexed covenantIndex);
    event ReleasedToCreator(uint256 indexed escrowId, address indexed creator, uint256 toCreator, uint256 venueFee);
    event RefundRootPosted(uint256 indexed escrowId, bytes32 root, uint256 totalWeight, uint64 claimDeadline);
    event RefundClaimed(uint256 indexed escrowId, uint256 indexed index, address indexed account, uint256 amount);
    event ReclaimedOnOracleSilence(uint256 indexed escrowId, address indexed creator, uint256 amount);
    event RemainderSwept(uint256 indexed escrowId, address indexed creator, uint256 amount);
    event OpeningsEnabledSet(bool enabled);
    event CleanReleaseFeeSet(uint16 bps);
    event FeeSinkSet(address sink);

    // ─── Construction ─────────────────────────────────────────────────

    /// @param weth_        Canonical WETH, used only as the payout fallback.
    /// @param initialOwner Owner of the two forward-looking dials. Owns no principal.
    constructor(address weth_, address initialOwner) OwnableNoRenounce(initialOwner) {
        if (weth_ == address(0)) revert ZeroAddress();
        if (weth_.code.length == 0) revert AssetHasNoCode(weth_);
        weth = weth_;
    }

    /// @dev Principal arrives through `open` and nowhere else. A bare transfer would sit
    ///      in the contract belonging to no escrow, so it is refused rather than silently
    ///      swelling a balance that no accounting path can pay out.
    receive() external payable {
        revert DirectPaymentRejected();
    }

    // ─── Opening ──────────────────────────────────────────────────────

    /// @notice Escrow `msg.value` against a set of published covenants.
    /// @dev    Every term of the escrow is fixed here and nothing below can edit it. The
    ///         fee dial and sink are read once, at this moment, into the escrow.
    /// @param  token         The launched token, for disclosure.
    /// @param  windowSeconds Covenant lifetime from now.
    /// @param  refundOracle  Address permitted to post the buyer split after a confirmed
    ///                       breach. Named here so buyers can judge it before they buy.
    /// @param  covenantInputs At least one covenant; each must already hold at open time.
    function open(
        address token,
        uint64 windowSeconds,
        address refundOracle,
        CovenantInput[] calldata covenantInputs
    ) external payable nonReentrant returns (uint256 escrowId) {
        if (!openingsEnabled) revert OpeningsDisabled();
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value > type(uint128).max) revert PrincipalTooLarge();
        if (token == address(0)) revert ZeroAddress();
        // A zero oracle would make refunds structurally unpayable while still letting the
        // launch advertise insurance. That is the one shape of this product that is a lie.
        if (refundOracle == address(0)) revert ZeroAddress();
        if (windowSeconds < MIN_WINDOW || windowSeconds > MAX_WINDOW) revert WindowOutOfRange();
        uint256 n = covenantInputs.length;
        if (n == 0 || n > MAX_COVENANTS) revert CovenantCountOutOfRange();

        escrowId = nextEscrowId++;

        address sink = feeSink;
        // A fee with nowhere to go is recorded as no fee rather than as a claim on the
        // creator that later resolves to a burn.
        uint16 feeBps = sink == address(0) ? 0 : cleanReleaseFeeBps;

        Escrow storage e = _escrows[escrowId];
        e.creator = msg.sender;
        e.token = token;
        e.refundOracle = refundOracle;
        e.feeSink = sink;
        e.principal = uint128(msg.value);
        e.openedAt = uint64(block.timestamp);
        e.windowEnd = uint64(block.timestamp) + windowSeconds;
        e.cleanFeeBps = feeBps;
        e.status = Status.Active;

        for (uint256 i; i < n; ++i) {
            _publishCovenant(escrowId, i, covenantInputs[i]);
        }

        emit EscrowOpened(
            escrowId, msg.sender, token, msg.value, e.windowEnd, refundOracle, feeBps, sink
        );
    }

    function _publishCovenant(uint256 escrowId, uint256 index, CovenantInput calldata input) private {
        if (input.minBps == 0 || input.minBps > BPS) revert MinBpsOutOfRange();
        if (input.asset == address(0)) revert ZeroAddress();
        if (input.asset.code.length == 0) revert AssetHasNoCode(input.asset);
        uint256 h = input.holders.length;
        if (h == 0 || h > MAX_HOLDERS_PER_COVENANT) revert HolderCountOutOfRange();

        Covenant storage c = _covenants[escrowId].push();
        c.asset = input.asset;
        c.minBps = input.minBps;
        // Read hard here, not softly: an asset that cannot answer at open time must not
        // become an escrow at all. The soft "unavailable" path exists for later, when a
        // read failure would otherwise be mistaken for an empty wallet.
        c.snapshotSupply = IERC20(input.asset).totalSupply();

        for (uint256 i; i < h; ++i) {
            address holder = input.holders[i];
            if (holder == address(0)) revert ZeroAddress();
            // A repeated holder would be counted twice, inflating the measured share and
            // silently loosening the floor the creator published.
            for (uint256 j; j < i; ++j) {
                if (input.holders[j] == holder) revert DuplicateHolder(holder);
            }
            c.holders.push(holder);
        }

        (bool readable, uint256 bps) = _readCovenantBps(c);
        if (!readable) revert CovenantUnreadable(escrowId, index);
        // An escrow that is already in breach the moment it opens is not insurance, it is
        // a trap with a countdown on it.
        if (bps < input.minBps) revert CovenantBornBreached(index);

        emit CovenantPublished(escrowId, index, input.asset, input.minBps, c.snapshotSupply, bps, input.holders);
    }

    // ─── Trigger ──────────────────────────────────────────────────────

    /// @notice Record that covenant `covenantIndex` is in breach right now. Permissionless.
    /// @dev    Reverts unless the breach is real at this instant, so the call cannot be
    ///         used to harass a compliant creator: there is no state a third party can
    ///         push a covenanted holder into, since reducing a holder's balance requires
    ///         that holder's own authorisation.
    function flagCovenantBreach(uint256 escrowId, uint256 covenantIndex) external {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Active) revert WrongStatus(Status.Active, e.status);
        // The covenant promises conduct until `windowEnd`. Conduct after it is out of scope.
        if (block.timestamp > e.windowEnd) revert WindowClosed();
        if (covenantIndex >= _covenants[escrowId].length) revert CovenantIndexOutOfRange();
        if (covenantFlaggedAt[escrowId][covenantIndex] != 0) revert AlreadyFlagged();

        Covenant storage c = _covenants[escrowId][covenantIndex];
        (bool readable, uint256 bps) = _readCovenantBps(c);
        if (!readable) revert CovenantUnreadable(escrowId, covenantIndex);
        if (bps >= c.minBps) revert CovenantSatisfied();

        covenantFlaggedAt[escrowId][covenantIndex] = uint64(block.timestamp);
        unchecked {
            e.pendingFlags += 1;
        }
        emit BreachFlagged(escrowId, covenantIndex, msg.sender, bps);
    }

    /// @notice Re-read a flagged covenant after the cure window and settle it: still in
    ///         breach seizes the escrow for buyers, restored clears the flag.
    /// @dev    Confirmation re-reads live state rather than trusting the flag. This is
    ///         what makes single-transaction manipulation useless — a flash loan cannot
    ///         hold a position across `BREACH_CURE_WINDOW`.
    function confirmCovenantBreach(uint256 escrowId, uint256 covenantIndex) external {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Active) revert WrongStatus(Status.Active, e.status);
        if (covenantIndex >= _covenants[escrowId].length) revert CovenantIndexOutOfRange();
        uint64 flaggedAt = covenantFlaggedAt[escrowId][covenantIndex];
        if (flaggedAt == 0) revert NotFlagged();
        if (block.timestamp < flaggedAt + BREACH_CURE_WINDOW) revert CureWindowOpen();
        if (block.timestamp > flaggedAt + CONFIRM_DEADLINE_AFTER_FLAG) revert FlagExpired();

        Covenant storage c = _covenants[escrowId][covenantIndex];
        (bool readable, uint256 bps) = _readCovenantBps(c);
        // Seizing on an unreadable asset would convert a token outage into a confiscation.
        if (!readable) revert CovenantUnreadable(escrowId, covenantIndex);

        if (bps >= c.minBps) {
            covenantFlaggedAt[escrowId][covenantIndex] = 0;
            unchecked {
                e.pendingFlags -= 1;
            }
            emit BreachCured(escrowId, covenantIndex, bps);
            return;
        }

        e.status = Status.Breached;
        e.deadline = uint64(block.timestamp) + REFUND_ROOT_WINDOW;
        emit BreachConfirmed(escrowId, covenantIndex, bps);
    }

    /// @notice Clear a flag nobody confirmed in time, so a clean release is not blocked.
    function clearStaleFlag(uint256 escrowId, uint256 covenantIndex) external {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Active) revert WrongStatus(Status.Active, e.status);
        uint64 flaggedAt = covenantFlaggedAt[escrowId][covenantIndex];
        if (flaggedAt == 0) revert NotFlagged();
        if (block.timestamp <= flaggedAt + CONFIRM_DEADLINE_AFTER_FLAG) revert FlagNotStale();

        covenantFlaggedAt[escrowId][covenantIndex] = 0;
        unchecked {
            e.pendingFlags -= 1;
        }
        emit StaleFlagCleared(escrowId, covenantIndex);
    }

    // ─── Settlement ───────────────────────────────────────────────────

    /// @notice Return the principal to the creator after a window that ended with no
    ///         confirmed breach, less the fee snapshotted at `open`. Permissionless.
    function releaseToCreator(uint256 escrowId) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Active) revert WrongStatus(Status.Active, e.status);
        if (block.timestamp <= e.windowEnd) revert WindowStillOpen();
        // An unresolved flag means a breach raised inside the window is still awaiting its
        // re-read. Releasing now would let a last-minute rug walk past the trigger.
        if (e.pendingFlags != 0) revert FlagsPending();

        uint256 principal = e.principal;
        uint256 fee = (principal * e.cleanFeeBps) / BPS;
        uint256 toCreator = principal - fee;
        address creator = e.creator;
        address sink = e.feeSink;

        e.status = Status.Closed;
        e.claimed = uint128(principal);

        if (fee != 0) weth.safeTransferETHOrWrap(sink, fee);
        weth.safeTransferETHOrWrap(creator, toCreator);
        emit ReleasedToCreator(escrowId, creator, toCreator, fee);
    }

    /// @notice Publish the buyer split for a seized escrow.
    /// @dev    Leaves are `keccak256(bytes.concat(keccak256(abi.encode(index, account,
    ///         weight))))` — the double hash is the standard defence against a leaf being
    ///         reinterpreted as an internal node. `totalWeight` is the denominator the
    ///         payouts divide by and is fixed here alongside the root.
    function postRefundRoot(uint256 escrowId, bytes32 root, uint256 totalWeight) external {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Breached) revert WrongStatus(Status.Breached, e.status);
        if (msg.sender != e.refundOracle) revert NotRefundOracle();
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        if (root == bytes32(0)) revert ZeroRoot();
        if (totalWeight == 0) revert ZeroWeight();

        e.refundRoot = root;
        e.refundTotalWeight = totalWeight;
        e.status = Status.Refunding;
        e.deadline = uint64(block.timestamp) + REFUND_CLAIM_WINDOW;
        emit RefundRootPosted(escrowId, root, totalWeight, e.deadline);
    }

    /// @notice Claim one buyer's pro-rata share. Anyone may submit on a buyer's behalf;
    ///         funds always go to the `account` in the leaf.
    function claimRefund(
        uint256 escrowId,
        uint256 index,
        address account,
        uint256 weight,
        bytes32[] calldata proof
    ) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Refunding) revert WrongStatus(Status.Refunding, e.status);
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        if (_isRefundClaimed(escrowId, index)) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, weight))));
        if (!MerkleProof.verify(proof, e.refundRoot, leaf)) revert InvalidProof();

        uint256 amount = (uint256(e.principal) * weight) / e.refundTotalWeight;
        uint256 remaining = uint256(e.principal) - uint256(e.claimed);
        // The oracle's weights are not trusted to sum correctly. The pool is the ceiling:
        // an over-allocating root pays out until the principal is gone and no further, and
        // can never reach into another escrow's money.
        if (amount > remaining) amount = remaining;
        if (amount == 0) revert NothingToClaim();

        _setRefundClaimed(escrowId, index);
        e.claimed = uint128(uint256(e.claimed) + amount);

        weth.safeTransferETHOrWrap(account, amount);
        emit RefundClaimed(escrowId, index, account, amount);
    }

    /// @notice Return principal to the creator when the named oracle never published a
    ///         split. Permissionless.
    /// @dev    The deliberate asymmetry of this contract: a proven breach with no
    ///         apportionment is resolved in the creator's favour rather than left for the
    ///         venue, burned, or handed to a claimant of convenience. It also removes any
    ///         leverage a captured oracle would otherwise hold — silence pays it nothing.
    function reclaimOnOracleSilence(uint256 escrowId) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Breached) revert WrongStatus(Status.Breached, e.status);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached();

        uint256 amount = uint256(e.principal) - uint256(e.claimed);
        address creator = e.creator;
        e.status = Status.Closed;
        e.claimed = e.principal;

        // No venue fee on any path that began with a breach.
        weth.safeTransferETHOrWrap(creator, amount);
        emit ReclaimedOnOracleSilence(escrowId, creator, amount);
    }

    /// @notice Return whatever buyers left unclaimed after the claim window. Permissionless.
    function sweepRemainderToCreator(uint256 escrowId) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.status != Status.Refunding) revert WrongStatus(Status.Refunding, e.status);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached();

        uint256 amount = uint256(e.principal) - uint256(e.claimed);
        address creator = e.creator;
        e.status = Status.Closed;
        e.claimed = e.principal;

        if (amount != 0) weth.safeTransferETHOrWrap(creator, amount);
        emit RemainderSwept(escrowId, creator, amount);
    }

    // ─── Reads ────────────────────────────────────────────────────────

    /// @notice Live state of one covenant.
    /// @return readable False means the asset could not be read — NO DATA. `currentBps`
    ///                  is zero because nothing was measured, not because nothing is
    ///                  held, and `breachedNow` is false because no breach was observed,
    ///                  not because the covenant is intact. Render this case as "cannot
    ///                  read", never as a holding of 0% and never as a passing check.
    function covenantStatus(uint256 escrowId, uint256 covenantIndex)
        external
        view
        returns (bool readable, uint256 currentBps, uint16 minBps, bool breachedNow, uint64 flaggedAt)
    {
        if (covenantIndex >= _covenants[escrowId].length) revert CovenantIndexOutOfRange();
        Covenant storage c = _covenants[escrowId][covenantIndex];
        minBps = c.minBps;
        flaggedAt = covenantFlaggedAt[escrowId][covenantIndex];
        (readable, currentBps) = _readCovenantBps(c);
        breachedNow = readable && currentBps < minBps;
    }

    function covenantCount(uint256 escrowId) external view returns (uint256) {
        return _covenants[escrowId].length;
    }

    /// @notice The published, immutable terms of one covenant.
    function covenantAt(uint256 escrowId, uint256 covenantIndex)
        external
        view
        returns (address asset, uint16 minBps, uint256 snapshotSupply, address[] memory holders)
    {
        if (covenantIndex >= _covenants[escrowId].length) revert CovenantIndexOutOfRange();
        Covenant storage c = _covenants[escrowId][covenantIndex];
        return (c.asset, c.minBps, c.snapshotSupply, c.holders);
    }

    function escrowTerms(uint256 escrowId) external view returns (Escrow memory) {
        return _escrows[escrowId];
    }

    function isRefundClaimed(uint256 escrowId, uint256 index) external view returns (bool) {
        return _isRefundClaimed(escrowId, index);
    }

    // ─── Owner dials (forward-looking only) ───────────────────────────

    function setOpeningsEnabled(bool enabled) external onlyOwner {
        openingsEnabled = enabled;
        emit OpeningsEnabledSet(enabled);
    }

    /// @dev Applies to escrows opened after this call. Live escrows carry the fee they
    ///      published at `open`.
    function setCleanReleaseFee(uint16 bps) external onlyOwner {
        if (bps > MAX_CLEAN_RELEASE_FEE_BPS) revert FeeTooHigh();
        cleanReleaseFeeBps = bps;
        emit CleanReleaseFeeSet(bps);
    }

    /// @dev Applies to escrows opened after this call.
    function setFeeSink(address sink) external onlyOwner {
        feeSink = sink;
        emit FeeSinkSet(sink);
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _requireEscrow(uint256 escrowId) private view returns (Escrow storage e) {
        e = _escrows[escrowId];
        if (e.status == Status.None) revert UnknownEscrow(escrowId);
    }

    /// @dev Present-state measurement of a covenant. Returns `(false, 0)` for every read
    ///      failure so callers can distinguish "no data" from a genuine zero holding; see
    ///      the outage note in the contract header for why that distinction is the whole
    ///      safety property here.
    function _readCovenantBps(Covenant storage c) private view returns (bool readable, uint256 bps) {
        address asset = c.asset;
        // A call to an address with no code returns empty data and succeeds; the decode
        // that follows reverts in a way `try` cannot catch, so it must be checked first.
        if (asset.code.length == 0) return (false, 0);

        uint256 live = 0;
        try IERC20(asset).totalSupply() returns (uint256 supply) {
            live = supply;
        } catch {
            return (false, 0);
        }

        uint256 snapshot = c.snapshotSupply;
        // See the header: the smaller denominator is the creator-favouring one in both
        // supply directions.
        uint256 denom = live < snapshot ? live : snapshot;
        if (denom == 0) return (false, 0);

        uint256 held = 0;
        uint256 n = c.holders.length;
        for (uint256 i; i < n; ++i) {
            try IERC20(asset).balanceOf(c.holders[i]) returns (uint256 bal) {
                held += bal;
            } catch {
                return (false, 0);
            }
        }
        return (true, (held * BPS) / denom);
    }

    function _isRefundClaimed(uint256 escrowId, uint256 index) private view returns (bool) {
        uint256 word = index >> 8;
        uint256 bit = 1 << (index & 0xff);
        return _refundClaimed[escrowId][word] & bit != 0;
    }

    function _setRefundClaimed(uint256 escrowId, uint256 index) private {
        uint256 word = index >> 8;
        uint256 bit = 1 << (index & 0xff);
        _refundClaimed[escrowId][word] |= bit;
    }
}
