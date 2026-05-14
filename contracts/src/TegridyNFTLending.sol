// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";
import {SafeERC721Call} from "./lib/SafeERC721Call.sol";

/// @title TegridyNFTLending — P2P Generic NFT-Collateralized Lending Protocol
/// @notice Peer-to-peer lending where lenders create ETH loan offers
///         and borrowers accept by escrowing any whitelisted ERC-721 NFT.
contract TegridyNFTLending is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("PROTOCOL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant WHITELIST_ADD = keccak256("WHITELIST_ADD");
    bytes32 public constant WHITELIST_REMOVE = keccak256("WHITELIST_REMOVE");
    bytes32 public constant ORIGINATION_FEE_CHANGE = keccak256("NFT_LENDING_ORIGINATION_FEE_CHANGE"); // AUDIT C7
    bytes32 public constant MIN_APR_CHANGE = keccak256("NFT_LENDING_MIN_APR_CHANGE"); // AUDIT H5
    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — timelock key for the
    ///         owner-only `sweepUnsolicitedNFT` (24h delay).
    bytes32 public constant SWEEP_UNSOLICITED_NFT = keccak256("NFT_LENDING_SWEEP_UNSOLICITED");

    // ─── Safety Caps ─────────────────────────────────────────────────
    /// @notice AUDIT FIX FRESH-2026: H-8 [F-71-1, F-78-C, F-74-10] —
    ///         pause-asymmetry bound on lender liquidation. Mirrors
    ///         TegridyLending's 7d cap. Pre-fix `claimDefault` was
    ///         `whenNotPaused` with NO cap; a captured-owner key could
    ///         pause indefinitely and block every lender's seize forever
    ///         while `repayLoan` stayed open. Now the lender's claim
    ///         unblocks once cumulative pause time crosses 7 days.
    uint256 public constant MAX_PAUSE_BLOCK_LIQUIDATION = 7 days;
    /// @notice AUDIT FIX FRESH-2026: F-71-9 — cumulative pause window.
    ///         Pre-fix the cap was measured from `pauseStartTime` (resets
    ///         on every pause), so cycle-pause evaded the cap indefinitely.
    ///         Now we sum pause durations within a rolling 30-day window.
    uint256 public constant CUMULATIVE_PAUSE_WINDOW = 30 days;
    /// @notice AUDIT FIX FRESH-2026: F-95-K-2 — global cap on offers list.
    uint256 public constant MAX_TOTAL_OFFERS = 10000;
    /// @notice AUDIT FIX FRESH-2026: F-95-K-2 — per-lender offer cap.
    uint256 public constant MAX_OFFERS_PER_LENDER = 100;
    uint256 public constant MAX_PRINCIPAL = 1000 ether;
    /// @notice Minimum principal floor.
    /// @dev    AUDIT FIX: LD-04 — without a floor, sub-2000-wei principals make
    ///         both `MIN_INTEREST_PRINCIPAL_BPS` and the duration-based interest
    ///         floor round to 0, enabling free same-block flash-loans against
    ///         dust offers. Mirrors `TegridyLending.minPrincipal=0.001 ether`.
    ///         Constant rather than mutable: the parent (TegridyLending) uses a
    ///         48h-timelocked setter, but a constant is sufficient — we never
    ///         want to lower this below 0.001 ETH (no economic case for it),
    ///         and raising it can be done at contract redeploy.
    uint256 public constant MIN_PRINCIPAL = 0.001 ether;
    uint256 public constant MAX_APR_BPS = 50000;        // 500% APR
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    /// @notice Post-deadline window in which the borrower may still repay.
    uint256 public constant GRACE_PERIOD = 1 hours;

    // ─── AUDIT FIX: DEEP-LD-M6 — minimum interest floor ──────────────
    /// @notice Minimum interest charged on any repayment. Sub-1-day repayments
    ///         priced at one full day. Defeats same-block flash-loan vector.
    uint256 public constant MIN_INTEREST_DURATION = 1 days;

    // ─── AUDIT FIX: DEEP-LD2-H2 — APR-independent interest floor ─────
    /// @notice Flat principal-percentage interest floor (5 bps = 0.05%) that
    ///         activates regardless of the offer's `aprBps`. Defeats the 0% APR
    ///         loophole in DEEP-LD-M6 where `principal * 0 == 0` made the
    ///         duration-based floor evaluate to zero, leaving same-block flash-
    ///         borrows free against any 0-APR offer. The 5-bps level is
    ///         conservatively small for honest 1-day repayments (0.05% of
    ///         principal per loan, fixed) but enough to make sub-block flash
    ///         attacks uneconomical when stacked against gas + slippage.
    uint256 public constant MIN_INTEREST_PRINCIPAL_BPS = 5;

    // ─── WETH Fallback ──────────────────────────────────────────────
    address public immutable weth;

    // ─── AUDIT FIX: DEEP-LD-M10 — L2 Sequencer feed ──────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet / non-L2 (no-op). Used in repayLoan to extend the
    ///         deadline grace if the sequencer recently came back up.
    /// @dev    AUDIT FIX (BATCH-D H13): one-shot post-deploy setter via
    ///         setSequencerFeed(). Pre-fix this field was `immutable` and
    ///         baked to address(0) in constructor (DEEP-LD-M10) — meaning
    ///         L2 deploys had ZERO sequencer-up protection because there
    ///         was no setter. Aave V3 PriceOracleSentinel uses a replaceable
    ///         setter; we use ONE-SHOT (set once, never replace) since this
    ///         is a single-purpose lending pool, not a multi-market protocol.
    address public sequencerFeed;
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    // ─── Timelock Delays ─────────────────────────────────────────────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;
    uint256 public constant WHITELIST_TIMELOCK = 24 hours;
    uint256 public constant ECONOMICS_TIMELOCK = 48 hours;       // AUDIT C7 / H5

    // ─── AUDIT C7: origination fee charged on createOffer ────────────
    uint256 public originationFeeBps;
    uint256 public constant MAX_ORIGINATION_FEE_BPS = 200;
    uint256 public pendingOriginationFeeBps;

    // ─── AUDIT H5: minimum APR enforced on createOffer ───────────────
    uint256 public minAprBps;
    uint256 public constant MAX_MIN_APR_BPS = 1000;
    uint256 public pendingMinAprBps;

    // ─── AUDIT FIX: DEEP-LD-L2 — removal cancel-rate-limit ───────────
    /// @notice Tracks how many times an admin has cancelled a removal proposal
    ///         for a given collection. Prevents loop-DoS of cancel-and-re-propose
    ///         used to keep a flagged collection alive indefinitely.
    mapping(address => uint256) public removalRetryCount;
    uint256 public constant REMOVAL_MAX_CANCELLATIONS = 3;

    // ─── Structs ─────────────────────────────────────────────────────

    struct Offer {
        address lender;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        address collateralContract;
        uint256 tokenId;
        bool active;
        /// @dev AUDIT FIX: DEEP-LD-M8 — origination fee held in escrow on the
        ///      offer until acceptance. cancelOffer refunds the lender (gross
        ///      principal), acceptOffer forwards to treasury.
        uint256 originationFee;
        /// @dev AUDIT FIX: DEEP-LD2-M3 — snapshot of `treasury` at offer creation.
        ///      acceptOffer forwards the held origination fee to THIS address
        ///      rather than the live treasury, so a treasury change between
        ///      create and accept cannot silently redirect a lender's fee.
        ///      Closes the audit-trail-asymmetry and front-running surface.
        address treasuryAtCreate;
        /// @dev AUDIT FIX (BATCH-I M10, mirrors TegridyLending Phase 3.5 LD-EXP-1):
        ///      Offer expiry timestamp. Pre-fix, an NFT-lending offer with stale
        ///      market terms could be accepted indefinitely until the lender
        ///      remembered to cancelOffer. With NFT collateral particularly, a
        ///      crash in floor price would let a borrower take a loan against
        ///      worthless collateral at obsolete favorable terms. Pattern: same
        ///      shape as TegridyLending's `uint64 expiry` — bounded between
        ///      MIN_OFFER_VALIDITY and MAX_OFFER_VALIDITY at create-time, and
        ///      acceptOffer reverts OfferExpired once block.timestamp > expiry.
        uint64 expiry;
        /// @dev AUDIT FIX 2026-05-13 — H-LEND-1 — mirrors TegridyLending BATCH-D H9
        ///      / M-8 / F-07-01: snapshot of `protocolFeeBps` at offer creation,
        ///      used at repay-time instead of live `protocolFeeBps`. Without this,
        ///      a captured admin can ramp the fee to MAX (1000 bps = 10%) via the
        ///      48h timelock and siphon up to 10% of every in-flight lender's
        ///      interest on next repay.
        ///
        ///      Stored as `int16` (range -32768..32767, fee range 0..1000 bps).
        ///      A NEGATIVE value is the explicit "unset sentinel" — at repay we
        ///      fall back to live `protocolFeeBps`. Solidity zero-init of `int16`
        ///      is `0` (not negative), so post-relaunch every offer carries the
        ///      true at-create snapshot; the sentinel branch is dead code on a
        ///      fresh deploy but kept for upgrade-shape parity with TegridyLending.
        int16 protocolFeeBpsAtCreate;
    }
    uint256 public constant MIN_OFFER_VALIDITY = 1 hours;
    uint256 public constant MAX_OFFER_VALIDITY = 90 days;
    error OfferExpired();
    error InvalidOfferValidity();

    struct Loan {
        address borrower;
        address lender;
        uint256 offerId;
        uint256 tokenId;
        address collateralContract;
        uint256 principal;
        uint256 aprBps;
        uint256 startTime;
        uint256 deadline;
        /// @dev AUDIT FIX: LD3-M4 (LD2-L3) — gas-pack: snapshot widened
        ///      from uint256 to uint64 and moved adjacent to the bools so the
        ///      compiler can pack all three into a single storage slot. Saves
        ///      ~20k gas per loan creation, ~5k per loan read. uint64 holds
        ///      ~584 billion years of seconds — far past any realistic
        ///      cumulative pause window. Storage-layout change is safe because
        ///      this contract has not yet been deployed (pre-deploy hardening
        ///      pass).
        uint64 pausedDurationAtStart;
        bool repaid;
        bool defaultClaimed;
    }

    // ─── State ───────────────────────────────────────────────────────

    Offer[] public offers;
    Loan[] public loans;

    uint256 public protocolFeeBps;    // Fee on interest earned (default 500 = 5%)
    address public treasury;

    mapping(address => bool) public whitelistedCollections;

    /// @notice AUDIT NEW-L3 (HIGH): active-loan count per collection.
    mapping(address => uint256) public activeLoansOfCollection;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingProtocolFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistAdd;
    address public pendingWhitelistRemove;

    // ─── AUDIT R014: Pause-aware deadlines ───────────────────────────
    uint256 public pauseStartTime;
    uint256 public totalPausedDuration;

    // ─── AUDIT FIX FRESH-2026: F-71-9 — cumulative pause history ─────
    /// @notice Append-only log of completed pause windows used by
    ///         `_cumulativePausedInWindow` to compute the rolling 30-day
    ///         cumulative pause budget. Each entry packs pause start +
    ///         end into one storage slot.
    struct PauseEpisode {
        uint128 startedAt;
        uint128 endedAt;
    }
    PauseEpisode[] public pauseHistory;

    // ─── AUDIT FIX FRESH-2026: F-95-K-2 — per-lender offer count ─────
    /// @notice Running count of OPEN (active) offers per lender.
    ///         Decremented when an offer flips inactive (cancel or accept).
    mapping(address => uint256) public openOffersOfLender;

    // ─── AUDIT FIX FRESH-2026: F-95-K-7 — stranded-NFT queue ─────────
    /// @notice Composite-key queue of unsolicited NFTs swept by
    ///         `executeSweepUnsolicitedNFT`. Recipient claims via
    ///         `claimStrandedNFT`. Key = keccak(collection, tokenId).
    mapping(bytes32 => address) public strandedNFTRecipient;

    // ─── AUDIT FIX FRESH-2026: F-95-K-7 — pending sweep proposal ─────
    address public pendingSweepCollection;
    uint256 public pendingSweepTokenId;
    address public pendingSweepRecipient;

    /// @notice AUDIT FIX L-2: per-loanId recipient for collateral whose
    ///         transferFrom() reverted during repayLoan / claimDefault.
    ///
    ///         The whitelisted ERC721's `transferFrom` is normally a safe
    ///         OZ-shaped call, but a hostile or buggy whitelisted collection
    ///         can revert deterministically (e.g. revert when `to == X`,
    ///         revert when paused, etc). Pre-fix, that revert bubbled up
    ///         and locked BOTH legs of the loan: borrower couldn't repay
    ///         (revert in the NFT-return leg), lender couldn't claim default
    ///         (revert in the NFT-payout leg). Money + NFT both stuck.
    ///
    ///         Now: repayLoan / claimDefault wrap the transferFrom in a
    ///         try/catch. On revert, the loan's status flag (`repaid` /
    ///         `defaultClaimed`) still flips and money still flows correctly,
    ///         but the NFT stays in the contract and `stuckCollateralRecipient[loanId]`
    ///         is set to the rightful recipient (borrower for repay,
    ///         lender for default). They can later call
    ///         `claimStuckCollateral(loanId)` once the collection's
    ///         transferFrom is fixed.
    mapping(uint256 => address) public stuckCollateralRecipient;

    // ─── Events ──────────────────────────────────────────────────────

    event LoanOfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 tokenId
    );
    event LoanOfferCancelled(uint256 indexed offerId, address indexed lender);
    event LoanAccepted(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed borrower,
        address lender,
        uint256 tokenId,
        address collateralContract,
        uint256 principal,
        uint256 deadline
    );
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 interest,
        uint256 protocolFee
    );
    event DefaultClaimed(
        uint256 indexed loanId,
        address indexed lender,
        uint256 tokenId
    );
    /// @notice AUDIT FIX L-2: emitted when an NFT transferFrom reverts during
    ///         repayLoan or claimDefault. The recipient can recover via
    ///         claimStuckCollateral(loanId) once the collection is healthy.
    event CollateralStuck(uint256 indexed loanId, address indexed recipient, uint256 tokenId, address collateralContract);
    /// @notice AUDIT FIX L-2: emitted when stuck collateral is finally recovered.
    event StuckCollateralClaimed(uint256 indexed loanId, address indexed recipient, uint256 tokenId);
    event CollectionWhitelisted(address indexed collection);
    event CollectionRemoved(address indexed collection);
    event CollectionWhitelistProposed(address indexed collection, uint256 readyAt);
    event CollectionRemovalProposed(address indexed collection, uint256 readyAt);
    event CollectionWhitelistCancelled(address indexed collection);
    event CollectionRemovalCancelled(address indexed collection);
    event ProtocolFeeChangeProposed(uint256 currentBps, uint256 proposedBps, uint256 readyAt);
    event ProtocolFeeChanged(uint256 oldBps, uint256 newBps);
    event ProtocolFeeChangeCancelled(uint256 cancelledBps);
    event TreasuryChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryChangeCancelled(address indexed cancelled);
    event OriginationFeeProposed(uint256 newBps, uint256 readyAt);
    event OriginationFeeChanged(uint256 oldBps, uint256 newBps);
    event OriginationFeeCollected(address indexed lender, uint256 amount);
    event MinAprProposed(uint256 newBps, uint256 readyAt);
    event MinAprChanged(uint256 oldBps, uint256 newBps);
    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — sweep events for the
    ///         stranded-NFT recovery flow.
    event SweepUnsolicitedNFTProposed(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed recipient,
        uint256 readyAt
    );
    event SweepUnsolicitedNFTExecuted(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed recipient
    );
    event StrandedNFTClaimed(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed recipient
    );

    // ─── Errors ──────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrincipal();
    error PrincipalTooLarge();
    /// @dev AUDIT FIX: LD-04 — principal below `MIN_PRINCIPAL` floor.
    error PrincipalTooSmall();
    error AprTooHigh();
    error AprTooLow();
    error OriginationFeeTooHigh();
    error MinAprTooHigh();
    error DurationTooShort();
    error DurationTooLong();
    error FeeTooHigh();
    error OfferNotActive();
    error NotOfferLender();
    error NotNFTOwner();
    error LoanAlreadyRepaid();
    error LoanTooRecent();
    error LoanAlreadyDefaultClaimed();
    /// @notice AUDIT FIX L-2: caller is not the recorded recipient for this
    ///         stuck collateral.
    error NotStuckCollateralRecipient();
    /// @notice AUDIT FIX L-2: nothing stuck for this loan.
    error NoStuckCollateral();
    /// @notice PASS7-NFTLENDING-01 FIX: collection still no-ops on retry.
    ///         The recovery right is preserved (mapping not cleared) so the
    ///         recipient can retry once the collection becomes honest.
    error StuckCollateralStillStuck();
    error NotBorrower();
    error NotLoanLender();
    error LoanNotDefaulted();
    error InsufficientRepayment();
    error ETHTransferFailed();
    error InvalidLoanId();
    error InvalidOfferId();
    error MsgValueMismatch();
    error CollectionNotWhitelisted();
    error CollectionAlreadyWhitelisted();
    error CollectionNotCurrentlyWhitelisted();
    error CollectionPendingRemoval();
    error CollateralBurnedSinceOffer();
    /// @dev AUDIT FIX: DEEP-LD-L2 — removal-cancel rate-limit reached.
    error RemovalCancelLimitReached();
    /// @dev AUDIT FIX: LD3-L2 — typed error for the active-loans-present revert
    ///      previously emitted as `revert("ACTIVE_LOANS_PRESENT")`. Off-chain
    ///      monitoring can now select on the 4-byte selector and decode the
    ///      collection + count without ABI string handling.
    error ActiveLoansPresent(address collection, uint256 count);
    /// @dev AUDIT FIX: LD3-M4 (LD2-L2) — fail-loud on the pause-bookkeeping
    ///      invariant `loan.pausedDurationAtStart <= totalPausedDuration`.
    ///      The pause counter is monotonically non-decreasing under correct
    ///      operation, so any inversion implies storage corruption (or a
    ///      future code path that mis-orders the snapshot/accumulator). Pre-fix
    ///      the silent `... ? ... : 0` clamp would hide the violation; now we
    ///      revert so forensics surface the regression immediately.
    error PauseInvariantViolated();
    /// @dev FRESH-EYES H-3: ERC-721 `transferFrom` returned without moving the NFT into
    ///      this contract. Catches a no-op transferFrom on a malicious-or-upgradeable
    ///      whitelisted collection. Without this, a borrower could pocket the principal
    ///      while keeping the NFT.
    error CollateralNotEscrowed();
    /// @dev AUDIT FIX FRESH-2026: H-8 [F-71-1] — `claimDefault` called while
    ///      paused and within the cumulative MAX_PAUSE_BLOCK_LIQUIDATION cap.
    ///      Mirrors TegridyLending's `PausedShortOfBound`.
    error PausedShortOfBound();
    /// @dev AUDIT FIX FRESH-2026: F-95-K-2 — global / per-lender offer caps.
    error TooManyOffers();
    error TooManyOffersPerLender();
    /// @dev AUDIT FIX FRESH-2026: F-95-K-7 — `sweepUnsolicitedNFT` would
    ///      seize an NFT recorded as active collateral.
    error NFTIsActiveCollateral();
    /// @dev AUDIT FIX FRESH-2026: F-95-K-7 — `claimStrandedNFT` caller is
    ///      not the recorded recipient (or no entry).
    error NotStrandedRecipient();
    error NoStrandedNFT();
    // ─── Legacy View Helpers (for test compatibility) ────────────────
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Constructor ─────────────────────────────────────────────────

    /// @notice AUDIT FIX FRESH-2026: F-14-1 — constructor now requires the
    ///         L2 sequencer feed up-front so a deploy that forgets to wire
    ///         it is detected at deploy time, not silently shipped with
    ///         protection inert. Mainnet (chainid 1) may pass address(0)
    ///         since the feed is no-op there.
    /// @dev    The post-deploy `setSequencerFeed` setter remains as an
    ///         escape hatch for re-rotation if the feed implementation
    ///         changes after deployment.
    /// @dev    Origination-fee policy (F-14-3 NOTE): the fee bucket on
    ///         `createOffer` is held in escrow on the offer until
    ///         acceptance. `cancelOffer` refunds it. `acceptOffer` honors a
    ///         LOWER live rate (re-computes and refunds the delta to the
    ///         borrower's principal) but does NOT penalize the lender if
    ///         the rate has been RAISED — snapshot wins on increases, live
    ///         rate wins on cuts. min-APR uses snapshot semantics in both
    ///         directions: an offer created at the old `minAprBps` remains
    ///         acceptable even if `minAprBps` is later raised. These are
    ///         deliberate fairness asymmetries.
    /// @dev    Interest-during-outage (F-14-4 NOTE): `pauseAdjustedElapsed`
    ///         credits ADMIN PAUSE time but NOT sequencer-outage time
    ///         against accrued interest. Aave V3 takes the same stance —
    ///         outages are external events; interest continues to accrue
    ///         while the borrower could not transact. Compensation is via
    ///         the symmetric `getSequencerOutageBuffer` deadline extension
    ///         on both repay and claim, NOT via interest pause.
    constructor(
        address _treasury,
        uint256 _protocolFeeBps,
        address _weth,
        address _sequencerFeed
    ) OwnableNoRenounce(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        // AUDIT FIX FRESH-2026: F-14-1 — L2 deploys must wire a non-zero
        // sequencer feed at deploy time. Mainnet (chainid 1) may pass
        // address(0) since the feed is documented no-op there.
        require(
            block.chainid == 1 || _sequencerFeed != address(0),
            "L2_SEQUENCER_FEED_REQUIRED"
        );

        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        weth = _weth;
        // AUDIT FIX FRESH-2026: F-60-2 — reject EIP-7702 delegated EOAs
        // (code.length == 23) at constructor wiring. Mainnet path
        // (chainid 1 with address(0)) skips both checks (no-op feed).
        if (_sequencerFeed != address(0)) {
            uint256 feedLen = _sequencerFeed.code.length;
            if (feedLen == 0 || feedLen == 23) revert SequencerFeedNotContract();
            sequencerFeed = _sequencerFeed;
            emit SequencerFeedSet(_sequencerFeed);
        } else {
            sequencerFeed = address(0);
        }

        // Whitelist initial collections
        whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
        whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
        whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art

        emit CollectionWhitelisted(0xd37264c71e9af940e49795F0d3a8336afAaFDdA9);
        emit CollectionWhitelisted(0xd774557b647330C91Bf44cfEAB205095f7E6c367);
        emit CollectionWhitelisted(0xa1De9f93c56C290C48849B1393b09eB616D55dbb);
    }

    // AUDIT FIX (BATCH-D H13): events + errors for the one-shot setSequencerFeed.
    event SequencerFeedSet(address indexed feed);
    error SequencerFeedAlreadySet();
    error SequencerFeedNotContract();

    /// @notice AUDIT FIX (BATCH-D H13, Aave V3 PriceOracleSentinel pattern):
    ///         One-shot post-deploy wire of the L2 Chainlink Sequencer Uptime feed.
    ///         Pre-fix the field was `immutable address(0)` with NO setter — meaning
    ///         every L2 deploy (Arbitrum / Optimism / Base) had ZERO sequencer-up
    ///         protection. After a sequencer outage, attackers could re-open the
    ///         repay/claim grace window at stale collateral values.
    /// @dev    One-shot (vs Aave V3's replaceable) is appropriate here because this is
    ///         a single-purpose lending pool, not a multi-market protocol that needs
    ///         to rotate per-feed. Once set, the deploy is committed; key rotation
    ///         is via OwnableNoRenounce (Ownable2Step + RenounceDisabled).
    /// @dev    Validation: address must be a contract (rejects EOAs and EIP-7702
    ///         delegations whose code length == 23 indicates a delegation pointer
    ///         rather than a real Chainlink feed implementation). Mainnet deploys
    ///         simply skip this call → field stays address(0) → SequencerCheck
    ///         no-ops (which is the documented mainnet path).
    /// @param  _sequencerFeed  Chainlink L2 Sequencer Uptime feed address.
    function setSequencerFeed(address _sequencerFeed) external onlyOwner {
        if (sequencerFeed != address(0)) revert SequencerFeedAlreadySet();
        if (_sequencerFeed == address(0)) revert ZeroAddress();
        // AUDIT FIX FRESH-2026: F-60-2 — reject EIP-7702 delegated EOAs.
        // Pre-fix `code.length == 0` accepted any address with code,
        // including a 7702-delegated EOA whose code length is exactly 23
        // (the canonical `0xef0100‖addr` delegation pointer). Mirrors
        // OwnableNoRenounce reference pattern.
        uint256 feedLen = _sequencerFeed.code.length;
        if (feedLen == 0 || feedLen == 23) revert SequencerFeedNotContract();
        sequencerFeed = _sequencerFeed;
        emit SequencerFeedSet(_sequencerFeed);
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    function createOffer(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _tokenId,
        uint64 _expiry
    ) external payable nonReentrant whenNotPaused returns (uint256 offerId) {
        // AUDIT FIX (BATCH-I M10): bound expiry between MIN/MAX_OFFER_VALIDITY.
        if (_expiry < block.timestamp + MIN_OFFER_VALIDITY ||
            _expiry > block.timestamp + MAX_OFFER_VALIDITY) revert InvalidOfferValidity();
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value != _principal) revert MsgValueMismatch();
        // AUDIT FIX: LD-04 — reject sub-MIN_PRINCIPAL offers. Without this,
        // dust-principal offers escape both interest floors (MIN_INTEREST_DURATION
        // and MIN_INTEREST_PRINCIPAL_BPS) since they round to zero, allowing
        // free same-block flash-loan round-trips.
        if (_principal < MIN_PRINCIPAL) revert PrincipalTooSmall();
        if (_principal > MAX_PRINCIPAL) revert PrincipalTooLarge();
        if (_aprBps > MAX_APR_BPS) revert AprTooHigh();
        if (_aprBps < minAprBps) revert AprTooLow();
        if (_duration < MIN_DURATION) revert DurationTooShort();
        if (_duration > MAX_DURATION) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();
        if (!whitelistedCollections[_collateralContract]) revert CollectionNotWhitelisted();
        if (_isWhitelistRemovalPending(_collateralContract)) {
            revert CollectionPendingRemoval();
        }
        // AUDIT FIX FRESH-2026: F-95-K-2 — global + per-lender offer caps.
        if (offers.length >= MAX_TOTAL_OFFERS) revert TooManyOffers();
        if (openOffersOfLender[msg.sender] >= MAX_OFFERS_PER_LENDER) {
            revert TooManyOffersPerLender();
        }

        IERC721(_collateralContract).ownerOf(_tokenId);

        // AUDIT FIX: DEEP-LD-M8 — origination fee held in escrow until acceptance.
        uint256 originationFee = (msg.value * originationFeeBps) / BPS;
        uint256 effectivePrincipal = _principal - originationFee;

        offerId = offers.length;
        offers.push(Offer({
            lender: msg.sender,
            principal: effectivePrincipal,
            aprBps: _aprBps,
            duration: _duration,
            collateralContract: _collateralContract,
            tokenId: _tokenId,
            active: true,
            originationFee: originationFee,
            // AUDIT FIX: DEEP-LD2-M3 — snapshot the live treasury at offer creation.
            treasuryAtCreate: treasury,
            expiry: _expiry, // BATCH-I M10
            // AUDIT FIX 2026-05-13 — H-LEND-1 — snapshot live protocolFeeBps so
            // a post-creation fee bump cannot retroactively tax this lender.
            // Mirrors TegridyLending BATCH-D H9 / M-8 / F-07-01.
            protocolFeeBpsAtCreate: int16(uint16(protocolFeeBps))
        }));
        // AUDIT FIX FRESH-2026: F-95-K-2 — increment per-lender open count.
        openOffersOfLender[msg.sender] += 1;

        emit LoanOfferCreated(
            offerId,
            msg.sender,
            effectivePrincipal,
            _aprBps,
            _duration,
            _collateralContract,
            _tokenId
        );
    }

    /// @notice Cancel an active loan offer and refund ETH to lender.
    /// @dev    AUDIT FIX: DEEP-LD-M8 — refund includes the originationFee
    ///         held on the offer (deferred-fee model).
    function cancelOffer(uint256 _offerId) external nonReentrant {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        if (offer.lender != msg.sender) revert NotOfferLender();

        // CEI: state change before external call
        offer.active = false;
        // AUDIT FIX FRESH-2026: F-95-K-2 — decrement per-lender open count.
        if (openOffersOfLender[msg.sender] > 0) {
            openOffersOfLender[msg.sender] -= 1;
        }
        // AUDIT FIX: DEEP-LD-M8 — refund principal + held origination fee.
        uint256 refundAmount = offer.principal + offer.originationFee;
        offer.originationFee = 0;

        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, refundAmount);

        emit LoanOfferCancelled(_offerId, msg.sender);
    }

    // ─── Borrowing ───────────────────────────────────────────────────

    function acceptOffer(
        uint256 _offerId
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        // AUDIT FIX (BATCH-I M10): reject expired offers. Mirrors TegridyLending
        // Phase 3.5 / batch-15 fix that closed the same stale-quote vector.
        // AUDIT FIX FRESH-2026 (post-fix scan7 DC-1): drop pre-M10 `expiry == 0`
        // backward-compat shim. `createOffer` enforces `_expiry >= block.timestamp
        // + MIN_OFFER_VALIDITY (1h)`, so post-relaunch every offer has expiry > 0.
        // Sibling-canonical with TegridyLending.acceptOffer (no shim there).
        if (block.timestamp > offer.expiry) revert OfferExpired();

        uint256 principal = offer.principal;
        uint256 aprBps = offer.aprBps;
        address lender = offer.lender;
        uint256 duration = offer.duration;
        address collateralContract = offer.collateralContract;
        uint256 _tokenId = offer.tokenId;
        uint256 originationFee = offer.originationFee;
        // AUDIT FIX: DEEP-LD2-M3 — use the snapshotted treasury for fee routing
        // so a treasury change between create and accept cannot redirect the fee.
        // AUDIT FIX FRESH-2026 (post-fix scan7 DC-2): drop pre-LD2-M3
        // `treasuryAtCreate == 0` fallback. Constructor + setter enforce
        // `treasury != address(0)` and `createOffer` always writes
        // `treasuryAtCreate: treasury`, so post-relaunch every offer has a
        // non-zero snapshot.
        address feeRecipient = offer.treasuryAtCreate;
        // AUDIT FIX: LD3-M4 (LD2-L1) — apply live rate when it has DROPPED
        // since offer creation. Pre-fix: lenders paid yesterday's rate after
        // a fee cut, harming UX fairness. Now: re-compute fee from the offer's
        // *gross* (principal + originationFee) using the lower of (snapshot,
        // live) bps. The delta refunds extra principal to the borrower's loan.
        // Asymmetric design: a fee INCREASE between create and accept does NOT
        // raise the lender's cost (snapshot wins) — only fee CUTS are honored.
        if (originationFee > 0) {
            uint256 grossDeposit = principal + originationFee;
            uint256 liveFee = (grossDeposit * originationFeeBps) / BPS;
            if (liveFee < originationFee) {
                // Fee cut between create and accept — honor the lower rate.
                // Surplus rejoins the principal flow to the borrower.
                principal = grossDeposit - liveFee;
                originationFee = liveFee;
            }
        }

        if (!whitelistedCollections[collateralContract]) revert CollectionNotWhitelisted();
        // AUDIT FIX L-3: also reject acceptance during the 24h whitelist-removal
        // timelock. Pre-fix, `createOffer` already rejected new offers in this
        // window but `acceptOffer` accepted EXISTING offers — so an attacker
        // could rug-prepare a collection, watch admin propose removal, and
        // accept a pre-existing legitimate-looking offer using a freshly-rugged
        // token to drain the lender's principal. Mirrors the createOffer guard
        // at line 311-316.
        if (_isWhitelistRemovalPending(collateralContract)) {
            revert CollectionPendingRemoval();
        }

        // AUDIT FIX FRESH-2026 (post-fix scan4 DOS-01): use SafeERC721Call's
        //         bounded ownerOf (returndata-cap via inline assembly) to defeat
        //         the returndata-bomb DoS where a hostile collateral contract
        //         returns 16MB+ from ownerOf and OOGs the borrower's accept path.
        //         Sister paths (line 1049) already use this; the borrower-side
        //         here was the missing twin.
        (bool ownerOk, address currentOwner) = SafeERC721Call.safeOwnerOfBounded(collateralContract, _tokenId);
        if (!ownerOk) revert CollateralBurnedSinceOffer();
        if (currentOwner != msg.sender) revert NotNFTOwner();

        // CEI: state changes before external calls
        offer.active = false;
        // AUDIT FIX FRESH-2026: F-95-K-2 — decrement per-lender open count
        // when an offer flips inactive via acceptance.
        if (openOffersOfLender[lender] > 0) {
            openOffersOfLender[lender] -= 1;
        }
        // AUDIT FIX: DEEP-LD-M8 — clear escrowed origination fee.
        offer.originationFee = 0;

        uint256 deadline = block.timestamp + duration;

        loanId = loans.length;
        loans.push(Loan({
            borrower: msg.sender,
            lender: lender,
            offerId: _offerId,
            tokenId: _tokenId,
            collateralContract: collateralContract,
            principal: principal,
            aprBps: aprBps,
            startTime: block.timestamp,
            deadline: deadline,
            // AUDIT FIX: DEEP-LD-H2 — snapshot pause budget at loan-create.
            // AUDIT FIX: LD3-M4 (LD2-L3) — uint64 cast (gas-pack). uint64
            // overflow safety: 2^64 seconds is >584 billion years, beyond any
            // realistic accumulated pause window. Cast is unchecked at the
            // compiler level (uint256 → uint64) but always correct here.
            pausedDurationAtStart: uint64(totalPausedDuration),
            repaid: false,
            defaultClaimed: false
        }));

        // Transfer NFT from borrower to this contract (collateral escrow)
        IERC721(collateralContract).transferFrom(msg.sender, address(this), _tokenId);
        // FRESH-EYES H-3: assert the transfer actually moved ownership to this contract.
        // A whitelisted-but-malicious or upgradeable ERC-721 could implement `transferFrom`
        // as a silent no-op (no revert, no transfer) — leaving the borrower with both the
        // NFT AND the principal we're about to send. Mirrors Uniswap V2 / Sudoswap's
        // post-transfer balance-of-self pattern. The whitelist is timelocked but this is
        // belt-and-suspenders against a future compromised admin or a collection that
        // becomes upgradable post-whitelist.
        if (IERC721(collateralContract).ownerOf(_tokenId) != address(this)) {
            revert CollateralNotEscrowed();
        }

        // AUDIT NEW-L3: register this loan against the collection.
        activeLoansOfCollection[collateralContract] += 1;

        // AUDIT FIX: DEEP-LD-M8 — forward origination fee at acceptance.
        // AUDIT FIX: DEEP-LD2-M3 — route to the snapshotted feeRecipient.
        if (originationFee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, feeRecipient, originationFee);
            emit OriginationFeeCollected(lender, originationFee);
        }

        // Send principal ETH to borrower (WETH fallback for contract borrowers)
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, principal);

        emit LoanAccepted(
            loanId,
            _offerId,
            msg.sender,
            lender,
            _tokenId,
            collateralContract,
            principal,
            deadline
        );
    }

    // ─── Repayment ───────────────────────────────────────────────────

    /// @notice Repay a loan. Borrower sends principal + interest.
    /// @dev    AUDIT FIX: DEEP-LD-M10 — sequencer-grace check so a borrower whose
    ///         repayLoan tx queued during an L2 outage can't be defaulted
    ///         immediately on resume. Cluster 10 owns the sister addition to
    ///         claimDefault — only the repay path is added here.
    function repayLoan(uint256 _loanId) external payable nonReentrant {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        address borrower = loan.borrower;
        address lender = loan.lender;
        uint256 principal = loan.principal;
        uint256 aprBps = loan.aprBps;
        uint256 startTime = loan.startTime;
        uint256 tokenId = loan.tokenId;
        address collateralContract = loan.collateralContract;

        if (msg.sender != borrower) revert NotBorrower();
        if (block.timestamp == startTime) revert LoanTooRecent();

        // AUDIT FIX: DEEP-LD2-H1 — replace blocking checkSequencerUp on the repay
        // path with a deadline EXTENSION using getSequencerOutageBuffer. Pre-fix the
        // borrower's repay window was nullified during sequencer recovery (the gate
        // reverted while the deadline elapsed). Now an in-flight outage extends
        // BOTH the borrower's repay window AND the lender's claim window
        // symmetrically by the buffer (matching value used in claimDefault below).
        // AUDIT FIX FRESH-2026: F-71-3 — pass 4h staleness to match the
        // 4h staleness used by `checkSequencerUp` on the claim path. Pre-fix
        // the 2-arg overload defaulted to 24h, so during a 4h-24h Chainlink
        // keeper-lapse window the lender's claim was hard-blocked while the
        // borrower's repay window was NOT extended.
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD,
            4 hours
        );
        // AUDIT FIX FRESH-2026: F-71-2 — pause-extended grace. Pre-fix a
        // pause that lands MID-GRACE compressed the borrower's wall-clock
        // repay window. Now the grace is extended by any pause time
        // overlapping the [base_deadline, base_deadline + GRACE_PERIOD]
        // interval — restoring full GRACE_PERIOD of usable wall-clock once
        // the chain resumes.
        // AUDIT FIX FRESH-2026: F-72-6 — strict variant on state-changing path.
        if (block.timestamp > _effectiveDeadlineStrict(_loanId) + _graceWithPauseExtension(_loanId) + outageBuffer) {
            revert LoanNotDefaulted();
        }

        // AUDIT FIX: DEEP-LD-H1 (mirror H11) — pause-adjusted interest so admin
        // pauses don't tax the borrower while simultaneously blocking the
        // lender's claimDefault path.
        uint256 interest = calculateLoanInterest(_loanId);
        // AUDIT FIX: DEEP-LD2-M2 — skip the floor entirely when the loan was 100%
        // paused since start (pause-adjusted elapsed == 0). Pre-fix the floor was
        // taxing borrowers who repaid during a long admin-pause where they had no
        // chance to use the principal productively.
        // AUDIT FIX FRESH-2026: F-72-6 — strict variant on state-changing path.
        uint256 elapsed = _pauseAdjustedElapsedStrict(_loanId);
        if (elapsed > 0) {
            // AUDIT FIX: DEEP-LD-M6 — minimum interest floor (1-day APR equivalent).
            uint256 minInterest = Math.mulDiv(
                principal * aprBps,
                MIN_INTEREST_DURATION,
                BPS * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
            // AUDIT FIX: DEEP-LD2-H2 — APR-independent flat floor (5 bps of principal).
            // Defeats the 0% APR loophole where the LD-M6 floor evaluates to zero.
            uint256 flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
            if (minInterest < flatFloor) minInterest = flatFloor;
            if (interest < minInterest) interest = minInterest;
        }
        uint256 totalRepayment = principal + interest;
        if (msg.value < totalRepayment) revert InsufficientRepayment();

        // CEI: state change before external calls
        loan.repaid = true;
        if (activeLoansOfCollection[collateralContract] > 0) {
            activeLoansOfCollection[collateralContract] -= 1;
        }

        // AUDIT FIX 2026-05-13 — H-LEND-1 — use the protocolFeeBps snapshot
        // from offer creation, not live `protocolFeeBps`. Mirrors TegridyLending
        // BATCH-D H9 / M-8 / F-07-01. Sentinel: negative = unset (legacy/upgrade),
        // fall back to live rate. On fresh deploy every offer has a valid 0..1000
        // snapshot so the negative branch is dead code.
        int16 snapBps = offers[loan.offerId].protocolFeeBpsAtCreate;
        uint256 effectiveFeeBps = snapBps < 0
            ? protocolFeeBps
            : uint256(uint16(snapBps));
        uint256 fee = (interest * effectiveFeeBps) / BPS;
        uint256 lenderAmount = principal + interest - fee;

        // AUDIT FIX L-2: wrap the NFT return in try/catch. A hostile or buggy
        // whitelisted collection that reverts in transferFrom must not lock
        // the loan settlement — the borrower has paid and the lender is owed
        // their money. Money flows below run unconditionally; if the NFT
        // transfer fails, the recipient (borrower) recovers later via
        // claimStuckCollateral once the collection is healthy.
        //
        // AUDIT FIX LD-NEW-H2: also verify the post-transfer ownership. A malicious
        // or buggy collection can implement `transferFrom` to no-op (return
        // without revert AND without moving the token) — the try/catch happy path
        // would then run, money would flow, and the NFT would stay stuck here
        // forever with NO `stuckCollateralRecipient` entry, blocking
        // claimStuckCollateral. Mirror the FRESH-EYES H-3 inbound post-condition
        // check on the outbound leg: if we still own the token after the call
        // succeeded, treat it as stuck.
        bool nftMoved = _safeOutboundTransfer(collateralContract, address(this), borrower, tokenId);
        if (!nftMoved) {
            stuckCollateralRecipient[_loanId] = borrower;
            emit CollateralStuck(_loanId, borrower, tokenId, collateralContract);
        }

        WETHFallbackLib.safeTransferETHOrWrap(weth, lender, lenderAmount);

        if (fee > 0) {
            // AUDIT FIX 2026-05-13 — M-LEND-3 — route protocol fee to the
            // `treasuryAtCreate` snapshot from offer creation, not live
            // `treasury`. Symmetric with the origination-fee leg (DEEP-LD2-M3)
            // and mirrors TegridyLending LD3-H3. Without this, a captured admin
            // rotating treasury via the 48h timelock can redirect every
            // subsequent in-flight protocol-fee payment.
            WETHFallbackLib.safeTransferETHOrWrap(weth, offers[loan.offerId].treasuryAtCreate, fee);
        }

        uint256 overpayment = msg.value - totalRepayment;
        if (overpayment > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, overpayment);
        }

        emit LoanRepaid(_loanId, borrower, principal, interest, fee);
    }

    // ─── Default ─────────────────────────────────────────────────────

    /// @notice Claim the collateral NFT after a loan defaults.
    /// @dev    AUDIT FIX FRESH-2026: H-8 [F-71-1, F-78-C, F-74-10] — pause
    ///         cannot indefinitely block lender claims. Mirrors
    ///         `TegridyLending.MAX_PAUSE_BLOCK_LIQUIDATION = 7 days`.
    ///         `whenNotPaused` is REMOVED; reverts with `PausedShortOfBound`
    ///         if currently paused AND the CUMULATIVE pause time within the
    ///         rolling 30-day window has not yet reached 7 days. Beyond
    ///         the cap the lender's claim proceeds regardless of pause.
    /// @dev    AUDIT FIX FRESH-2026: F-71-9 — cap is measured CUMULATIVELY
    ///         within a 30-day rolling window rather than as the
    ///         consecutive interval since the last `_pause()`. Closes the
    ///         cycle-pause bypass.
    function claimDefault(uint256 _loanId) external nonReentrant {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // AUDIT FIX FRESH-2026: H-8 [F-71-1, F-78-C, F-74-10] + F-71-9 —
        // cumulative pause cap. Pre-fix `whenNotPaused` was an infinite
        // weapon; this gate caps the pause-blockable window at 7 days
        // CUMULATIVE within a 30-day rolling window.
        if (paused()) {
            uint256 cumulative = _cumulativePausedInWindow();
            if (cumulative <= MAX_PAUSE_BLOCK_LIQUIDATION) {
                revert PausedShortOfBound();
            }
        }

        // AUDIT FIX: DEEP-LIB-H3 — sequencer-uptime gate at the top of the
        // liquidation entrypoint. Pre-fix the lender could call claimDefault
        // the instant `block.timestamp > effectiveDeadline + GRACE_PERIOD`
        // even when a sequencer outage had consumed the entire grace
        // window, leaving the borrower zero usable repay time. The gate
        // mirrors the symmetric fix in TegridyLending.claimDefaultedCollateral
        // and the existing acceptOffer guard above.
        // AUDIT FIX (BATCH-L3 M4): 4h staleness on price-sensitive path.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);

        address lender = loan.lender;
        uint256 tokenId = loan.tokenId;
        address collateralContract = loan.collateralContract;

        if (msg.sender != lender) revert NotLoanLender();
        // AUDIT FIX: DEEP-LD2-H1 — symmetric outage-buffer deadline extension so
        // both repay and claim see the same effectiveDeadline + grace + outage.
        // checkSequencerUp above already enforces "sequencer is currently up AND
        // grace fully elapsed" — getSequencerOutageBuffer here returns 0 in steady
        // state and only contributes when an outage is actively detected (e.g. a
        // racy in-flight transition between the two reads, or future buffer-window
        // adjustments). Keeps the symmetry with repayLoan above intact.
        // AUDIT FIX FRESH-2026: F-71-3 — 4h staleness on the buffer overload
        // mirrors `checkSequencerUp` above for consistent semantics.
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD,
            4 hours
        );
        // AUDIT FIX FRESH-2026: F-71-2 — boundary uses pause-extended grace.
        // AUDIT FIX FRESH-2026: F-72-6 — strict variant on state-changing path.
        if (block.timestamp <= _effectiveDeadlineStrict(_loanId) + _graceWithPauseExtension(_loanId) + outageBuffer) {
            revert LoanNotDefaulted();
        }

        // CEI: state change before external call
        loan.defaultClaimed = true;
        if (activeLoansOfCollection[collateralContract] > 0) {
            activeLoansOfCollection[collateralContract] -= 1;
        }

        // AUDIT FIX L-2: wrap the NFT payout in try/catch. Same rationale as
        // repayLoan — if a hostile/buggy collection reverts, the lender's
        // claim still flips defaultClaimed (preventing double-claim) and the
        // NFT is reserved for them via stuckCollateralRecipient. Recover via
        // claimStuckCollateral once the collection is healthy.
        //
        // AUDIT FIX LD-NEW-H2: see repayLoan above for the silent-no-op rationale.
        bool nftMoved = _safeOutboundTransfer(collateralContract, address(this), lender, tokenId);
        if (!nftMoved) {
            stuckCollateralRecipient[_loanId] = lender;
            emit CollateralStuck(_loanId, lender, tokenId, collateralContract);
        }

        emit DefaultClaimed(_loanId, lender, tokenId);
    }

    // ─── Stuck collateral recovery (AUDIT FIX L-2) ───────────────────

    /// @notice Recover an NFT whose `transferFrom` reverted during repayLoan
    ///         or claimDefault. Callable by the recipient recorded at the
    ///         time the original call's NFT-transfer leg failed.
    /// @dev    The collection's `transferFrom` is retried unconditionally;
    ///         if it still reverts (collection still hostile), this call
    ///         reverts and the NFT stays stuck for another retry. On
    ///         success, the recipient mapping is cleared so a future
    ///         attacker who somehow becomes the recipient cannot replay.
    ///
    ///         No nonReentrant on this path because there is no value
    ///         out-flow — the NFT is the only asset moved, and ERC721
    ///         transfer cannot itself trigger reentrant state mutation
    ///         on this contract (no balance reads, no callbacks). The
    ///         `whenNotPaused` modifier is intentionally OMITTED so users
    ///         can recover their NFT even during a contract pause.
    function claimStuckCollateral(uint256 _loanId) external {
        if (_loanId >= loans.length) revert InvalidLoanId();
        address recipient = stuckCollateralRecipient[_loanId];
        if (recipient == address(0)) revert NoStuckCollateral();
        if (msg.sender != recipient) revert NotStuckCollateralRecipient();

        Loan storage loan = loans[_loanId];
        address collateralContract = loan.collateralContract;
        uint256 tokenId = loan.tokenId;

        // PASS7-NFTLENDING-01 FIX: retry under the same `_safeOutboundTransfer`
        // detector that initially recorded the stuck recipient. Pre-fix, the
        // function deleted the mapping BEFORE issuing a raw `transferFrom`,
        // so a still-malicious collection that no-op'd the retry would
        // silently consume the recovery right (mapping zero, NFT stuck).
        // Now: only delete on confirmed success. If the collection is still
        // hostile, `moved == false` → revert so the recipient retains the
        // claim and can retry once the collection becomes honest. CEI is
        // preserved by `revert` rolling back the (un-issued) delete.
        bool moved = _safeOutboundTransfer(collateralContract, address(this), recipient, tokenId);
        if (!moved) revert StuckCollateralStillStuck();

        delete stuckCollateralRecipient[_loanId];
        emit StuckCollateralClaimed(_loanId, recipient, tokenId);
    }

    /// @notice AUDIT FIX LD-NEW-H2: outbound NFT transfer with both revert AND
    ///         silent-no-op detection. A whitelisted ERC-721 implementation that
    ///         no-ops `transferFrom` (returns without revert AND without moving
    ///         the token) would silently let a loan settle while leaving the NFT
    ///         escrowed forever. Returns `true` only when the post-call ownership
    ///         confirms the transfer landed at `to`. Both ownerOf and transferFrom
    ///         calls are wrapped to handle hostile collections that revert from
    ///         either entrypoint. False return triggers the caller's stuck-collateral
    ///         path.
    /// @dev    Internal helper kept here (not in WETHFallbackLib) because the
    ///         fix is collateral-specific and pairs tightly with this contract's
    ///         stuckCollateralRecipient bookkeeping.
    function _safeOutboundTransfer(
        address collection,
        address from,
        address to,
        uint256 tokenId
    ) internal returns (bool moved) {
        // AUDIT FIX (pass-8): GAS-01 — bounded-returndata transferFrom + ownerOf.
        // Solidity's `try/catch` ALWAYS copies returndata before the catch fires,
        // so a malicious whitelisted collection returning 16 MB of returndata
        // OOG-griefs every call to this function — bricking lender's
        // `claimDefault` and the `claimStuckCollateral` recovery permanently.
        // SafeERC721Call uses inline assembly to cap the returndata copy at 0
        // bytes (transferFrom — return value unused) and 32 bytes (ownerOf —
        // single address), neutralizing the gas bomb.
        bool ok = SafeERC721Call.safeTransferFromBounded(collection, from, to, tokenId);
        if (!ok) {
            return false;
        }
        // happy path — verify post-condition with bounded ownerOf.
        (bool ownerOk, address newOwner) = SafeERC721Call.safeOwnerOfBounded(collection, tokenId);
        if (!ownerOk) {
            // ownerOf reverted or returned malformed data — token likely burned
            // during transfer or collection is broken. Treat as not-moved
            // (caller marks stuck); recovery may not be possible.
            return false;
        }
        moved = (newOwner == to);
        // If newOwner is some unexpected third party (malicious collection
        // that redirected the transfer), we ALSO return false — the loan
        // settlement above stands but the NFT is unrecoverable through
        // this contract's stuck path. Emit a forensic warning event so
        // off-chain monitoring can flag the malicious collection.
        if (!moved && newOwner != from) {
            emit CollateralRedirected(tokenId, collection, to, newOwner);
        }
    }

    /// @notice AUDIT FIX LD-NEW-H2: emitted when a malicious whitelisted collection
    ///         redirects an outbound transfer to a third party instead of the
    ///         intended recipient. Loan settlement still completes; this event
    ///         flags the collection for off-chain monitoring + delisting.
    event CollateralRedirected(
        uint256 indexed tokenId,
        address indexed collection,
        address indexed intendedRecipient,
        address actualOwner
    );

    // ─── View Functions ──────────────────────────────────────────────

    function getOffer(uint256 _offerId) external view returns (
        address lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 tokenId,
        bool active
    ) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer memory o = offers[_offerId];
        return (o.lender, o.principal, o.aprBps, o.duration, o.collateralContract, o.tokenId, o.active);
    }

    function getLoan(uint256 _loanId) external view returns (
        address borrower,
        address lender,
        uint256 offerId,
        uint256 tokenId,
        address collateralContract,
        uint256 principal,
        uint256 aprBps,
        uint256 startTime,
        uint256 deadline,
        bool repaid,
        bool defaultClaimed
    ) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return (l.borrower, l.lender, l.offerId, l.tokenId, l.collateralContract, l.principal, l.aprBps, l.startTime, l.deadline, l.repaid, l.defaultClaimed);
    }

    function calculateInterest(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _startTime,
        uint256 _currentTime
    ) public pure returns (uint256 interest) {
        if (_currentTime <= _startTime) return 0;
        uint256 elapsed = _currentTime - _startTime;
        interest = Math.mulDiv(
            _principal * _aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
    }

    /// @notice AUDIT FIX: DEEP-LD-H1 (mirror H11) — pause-adjusted interest for a loan.
    function calculateLoanInterest(uint256 _loanId) public view returns (uint256 interest) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
        if (elapsed == 0) return 0;
        interest = Math.mulDiv(
            loan.principal * loan.aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
    }

    /// @notice AUDIT FIX: DEEP-LD-H1 (mirror H11) — total elapsed excluding pauses.
    /// @dev    AUDIT FIX FRESH-2026: F-72-6 — VIEW path now silent-clamps on
    ///         the pause invariant. Pre-fix, an invariant inversion would
    ///         brick `getRepaymentAmount`, `isDefaulted`, and any frontend
    ///         view that traverses this function. Mirrors
    ///         `TegridyLending.sol:1502` silent-clamp pattern. The strict
    ///         revert is preserved on state-changing paths via the internal
    ///         `_pauseAdjustedElapsedStrict` helper.
    function pauseAdjustedElapsed(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        if (block.timestamp <= loan.startTime) return 0;
        uint256 raw = block.timestamp - loan.startTime;
        // AUDIT FIX FRESH-2026: F-72-6 — silent-clamp ternary instead of revert.
        uint256 pausedSinceStart = totalPausedDuration > loan.pausedDurationAtStart
            ? totalPausedDuration - loan.pausedDurationAtStart
            : 0;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pausedSinceStart += block.timestamp - pauseStartTime;
        }
        return pausedSinceStart >= raw ? 0 : raw - pausedSinceStart;
    }

    /// @notice AUDIT FIX FRESH-2026: F-72-6 — strict variant for
    ///         state-changing paths. Fails loud on pause-bookkeeping
    ///         invariant inversion while view paths silently clamp.
    function _pauseAdjustedElapsedStrict(uint256 _loanId) internal view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        if (block.timestamp <= loan.startTime) return 0;
        uint256 raw = block.timestamp - loan.startTime;
        if (loan.pausedDurationAtStart > totalPausedDuration) revert PauseInvariantViolated();
        uint256 pausedSinceStart = totalPausedDuration - loan.pausedDurationAtStart;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pausedSinceStart += block.timestamp - pauseStartTime;
        }
        return pausedSinceStart >= raw ? 0 : raw - pausedSinceStart;
    }

    /// @notice Get the total repayment amount for a loan at the current time.
    /// @dev    AUDIT FIX: DEEP-LD-H1 — pause-adjusted interest. AUDIT FIX:
    ///         DEEP-LD-M6 — apply minimum interest floor for view parity.
    ///         AUDIT FIX: DEEP-LD2-H2 — APR-independent flat floor mirrors repayLoan.
    ///         AUDIT FIX: DEEP-LD2-M2 — skip the floor when loan was 100% paused.
    function getRepaymentAmount(uint256 _loanId) external view returns (uint256 total) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        uint256 interest = calculateLoanInterest(_loanId);
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
        if (elapsed > 0) {
            uint256 minInterest = Math.mulDiv(
                l.principal * l.aprBps,
                MIN_INTEREST_DURATION,
                BPS * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
            uint256 flatFloor = (l.principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
            if (minInterest < flatFloor) minInterest = flatFloor;
            if (interest < minInterest) interest = minInterest;
        }
        total = l.principal + interest;
    }

    /// @notice Check whether a loan has defaulted.
    /// @dev    AUDIT FIX: DEEP-LD-M3 — read effectiveDeadline + GRACE_PERIOD.
    function isDefaulted(uint256 _loanId) external view returns (bool) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return !l.repaid
            && !l.defaultClaimed
            && block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD;
    }

    function offerCount() external view returns (uint256) {
        return offers.length;
    }

    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    // ─── Admin: Collection Whitelist Timelock ────────────────────────

    function proposeWhitelistCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (whitelistedCollections[_collection]) revert CollectionAlreadyWhitelisted();
        // AUDIT FIX (pass-8): NFTLEND-WL-1 — ERC165 preflight. Reject EOAs and
        // contracts that don't claim ERC721 support so a typo / malicious-paste
        // can't whitelist a non-ERC721 contract that would silently no-op
        // `transferFrom` (collateral never escrowed) or trap the lender's
        // principal in a contract that can't release the NFT. Pattern matches
        // OZ's standard ERC165 detection. Wrapped in try/catch because some
        // legitimate ERC721s (e.g. CryptoPunks v1, Sandbox v1) predate ERC165
        // — if the call reverts we conservatively fall through and let the
        // 24h timelock + execute-side check block obvious mistakes.
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): length-23
        //         carve-out — sibling-canonical of TegridyNFTPoolFactory.createPool.
        //         A 7702-delegated EOA (canonical `0xef0100‖addr` pointer, code.length
        //         == 23) whose delegate REVERTS on `supportsInterface` would fall
        //         through the catch below and pass the gate as a "pre-ERC165 ERC721".
        uint256 codeLen = _collection.code.length;
        require(codeLen > 0 && codeLen != 23, "NOT_CONTRACT");
        try IERC165(_collection).supportsInterface(0x80ac58cd) returns (bool ok) {
            require(ok, "NOT_ERC721");
        } catch {
            // Pre-ERC165 ERC721 — allow but operator should know.
        }

        pendingWhitelistAdd = _collection;
        _propose(WHITELIST_ADD, WHITELIST_TIMELOCK);

        emit CollectionWhitelistProposed(_collection, _executeAfter[WHITELIST_ADD]);
    }

    function executeWhitelistCollection() external onlyOwner {
        _execute(WHITELIST_ADD);

        address collection = pendingWhitelistAdd;
        whitelistedCollections[collection] = true;
        pendingWhitelistAdd = address(0);

        emit CollectionWhitelisted(collection);
    }

    function cancelWhitelistCollection() external onlyOwner {
        _cancel(WHITELIST_ADD);

        address cancelled = pendingWhitelistAdd;
        pendingWhitelistAdd = address(0);

        emit CollectionWhitelistCancelled(cancelled);
    }

    /// @notice AUDIT FIX 2026-05-13 — H-LEND-2 — validity-aware "is this
    ///         collection's removal proposal still live?" view. Mirrors
    ///         `TegridyLendingAdmin.acceptedCollateralRemovalPending` (M-27 /
    ///         F-33-3). Pre-fix, `createOffer` and `acceptOffer` checked only
    ///         `pendingWhitelistRemove == X && _executeAfter[KEY] != 0`,
    ///         which auto-clears never. Once a proposal expired past
    ///         `readyAt + _proposalValidity()` the timelock library refused
    ///         to execute AND the cancel rate-limit (3/collection) eventually
    ///         exhausted, leaving the collection PERMA-BRICKED from new
    ///         offers and acceptance even after legitimate-good behavior. The
    ///         expiry-aware read auto-clears once the proposal expires,
    ///         bounding the captured-admin DoS to the documented validity
    ///         window.
    /// @param  _collection Collateral collection address.
    /// @return             True iff a non-expired removal proposal exists for
    ///                     this collection.
    function _isWhitelistRemovalPending(address _collection) internal view returns (bool) {
        if (pendingWhitelistRemove != _collection) return false;
        uint256 readyAt = _executeAfter[WHITELIST_REMOVE];
        if (readyAt == 0) return false;
        if (block.timestamp > readyAt + _proposalValidity()) return false;
        return true;
    }

    function proposeRemoveCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (!whitelistedCollections[_collection]) revert CollectionNotCurrentlyWhitelisted();

        pendingWhitelistRemove = _collection;
        _propose(WHITELIST_REMOVE, WHITELIST_TIMELOCK);

        emit CollectionRemovalProposed(_collection, _executeAfter[WHITELIST_REMOVE]);
    }

    /// @dev AUDIT FIX: LD3-M5 — pre-flight active-loan gate BEFORE `_execute`.
    ///      Pre-fix: `_execute` cleared `_executeAfter[KEY] = 0`, then the
    ///      ACTIVE_LOANS_PRESENT revert rolled the entire tx back. Combined
    ///      with the LD3-M1 cancel-rate-limit, this could permanently brick
    ///      the WHITELIST_REMOVE slot. Now: gate before `_execute` so admin
    ///      can retry the moment loans clear.
    /// @dev AUDIT FIX: LD3-L2 — typed `ActiveLoansPresent` error.
    function executeRemoveCollection() external onlyOwner {
        address collection = pendingWhitelistRemove;
        // AUDIT FIX: LD3-M5 — gate BEFORE `_execute` consumes the proposal slot.
        if (activeLoansOfCollection[collection] > 0) {
            // AUDIT FIX: LD3-L2 — typed error replaces string revert.
            revert ActiveLoansPresent(collection, activeLoansOfCollection[collection]);
        }
        _execute(WHITELIST_REMOVE);
        whitelistedCollections[collection] = false;
        pendingWhitelistRemove = address(0);
        // AUDIT FIX: DEEP-LD-L2 — reset the cancel-counter on a successful
        // execution so a future legitimate removal cycle can use the full
        // budget again.
        removalRetryCount[collection] = 0;

        emit CollectionRemoved(collection);
    }

    /// @notice Cancel a pending whitelist removal.
    /// @dev    AUDIT FIX: DEEP-LD-L2 — rate-limited at REMOVAL_MAX_CANCELLATIONS
    ///         consecutive cancels per collection so a captured-owner cannot
    ///         loop cancel-and-re-propose to keep a flagged collection alive
    ///         indefinitely. Counter resets on a successful execution.
    /// @dev    AUDIT FIX: LD3-M1 — gate-then-cancel order: pre-fix the cancel
    ///         was executed first, then the post-bump revert rolled BACK the
    ///         _cancel via tx revert, so `_executeAfter[WHITELIST_REMOVE]`
    ///         stayed non-zero AND the proposal stayed pending forever (since
    ///         `_propose` rejects an existing pending). Now we check the gate
    ///         BEFORE _cancel — over-budget cancels revert without leaving
    ///         the slot in a stuck state.
    function cancelRemoveCollection() external onlyOwner {
        address cancelled = pendingWhitelistRemove;
        // AUDIT FIX: LD3-M1 — gate first, THEN cancel; over-limit revert no
        // longer rolls back a cancel that already cleared the slot.
        // PASS7-NFTLENDING-02 FIX: mirror TegridyLending FRESH-EYES L still-live
        // carve-out (TegridyLending.sol:1817-1826). Without this, a captured (or
        // honest-but-slow) admin can `propose → wait for expiry → cancel` 3 times
        // to consume the REMOVAL_MAX_CANCELLATIONS budget on a flagged collection
        // without ever cancelling a live removal — bricking legitimate future
        // removals of that collection. Only count cancels of STILL-LIVE proposals.
        if (cancelled != address(0)) {
            uint256 readyAt = _executeAfter[WHITELIST_REMOVE];
            bool stillLive = readyAt != 0 && block.timestamp <= readyAt + _proposalValidity();
            if (stillLive) {
                if (removalRetryCount[cancelled] >= REMOVAL_MAX_CANCELLATIONS) {
                    revert RemovalCancelLimitReached();
                }
                removalRetryCount[cancelled] += 1;
            }
        }

        _cancel(WHITELIST_REMOVE);
        pendingWhitelistRemove = address(0);

        emit CollectionRemovalCancelled(cancelled);
    }

    // ─── Admin: Protocol Fee Timelock ────────────────────────────────

    function proposeProtocolFeeChange(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();

        pendingProtocolFeeBps = _newFeeBps;
        _propose(PROTOCOL_FEE_CHANGE, PROTOCOL_FEE_TIMELOCK);

        emit ProtocolFeeChangeProposed(protocolFeeBps, _newFeeBps, _executeAfter[PROTOCOL_FEE_CHANGE]);
    }

    function executeProtocolFeeChange() external onlyOwner {
        _execute(PROTOCOL_FEE_CHANGE);

        uint256 oldBps = protocolFeeBps;
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;

        emit ProtocolFeeChanged(oldBps, protocolFeeBps);
    }

    function cancelProtocolFeeChange() external onlyOwner {
        _cancel(PROTOCOL_FEE_CHANGE);

        uint256 cancelled = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;

        emit ProtocolFeeChangeCancelled(cancelled);
    }

    // ─── Admin: Treasury Timelock ────────────────────────────────────

    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();

        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_TIMELOCK);

        emit TreasuryChangeProposed(treasury, _newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);

        address oldTreasury = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);

        emit TreasuryChanged(oldTreasury, treasury);
    }

    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);

        address cancelled = pendingTreasury;
        pendingTreasury = address(0);

        emit TreasuryChangeCancelled(cancelled);
    }

    // ─── Pausable ────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _pause() internal override {
        super._pause();
        pauseStartTime = block.timestamp;
    }

    function _unpause() internal override {
        uint256 start = pauseStartTime;
        if (start != 0 && block.timestamp > start) {
            totalPausedDuration += block.timestamp - start;
            // AUDIT FIX FRESH-2026: F-71-9 — append pause window so cumulative
            // pause time within a 30-day rolling window can be summed by
            // `_cumulativePausedInWindow`. Closes cycle-pause bypass of the
            // MAX_PAUSE_BLOCK_LIQUIDATION cap.
            pauseHistory.push(PauseEpisode({
                startedAt: uint128(start),
                endedAt: uint128(block.timestamp)
            }));
        }
        pauseStartTime = 0;
        super._unpause();
    }

    /// @notice Pause-extended deadline for a loan.
    /// @dev    AUDIT FIX FRESH-2026: F-72-6 — VIEW path now silent-clamps on
    ///         the pause invariant. Strict revert preserved on
    ///         state-changing paths via `_effectiveDeadlineStrict`.
    function effectiveDeadline(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 base = loan.deadline;
        // AUDIT FIX FRESH-2026: F-72-6 — silent-clamp ternary instead of revert.
        uint256 pauseExt = totalPausedDuration > loan.pausedDurationAtStart
            ? totalPausedDuration - loan.pausedDurationAtStart
            : 0;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pauseExt += block.timestamp - pauseStartTime;
        }
        return base + pauseExt;
    }

    /// @notice AUDIT FIX FRESH-2026: F-72-6 — strict variant for
    ///         state-changing paths.
    function _effectiveDeadlineStrict(uint256 _loanId) internal view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 base = loan.deadline;
        if (loan.pausedDurationAtStart > totalPausedDuration) revert PauseInvariantViolated();
        uint256 pauseExt = totalPausedDuration - loan.pausedDurationAtStart;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pauseExt += block.timestamp - pauseStartTime;
        }
        return base + pauseExt;
    }

    /// @notice AUDIT FIX FRESH-2026: F-71-2 — pause-extended grace.
    ///         Pre-fix the GRACE_PERIOD term added on top of
    ///         `effectiveDeadline` was a fixed constant, so a pause that
    ///         lands MID-GRACE compressed the borrower's wall-clock repay
    ///         window. Now the grace is extended by any pause time
    ///         overlapping the [base_deadline, base_deadline + GRACE_PERIOD]
    ///         interval.
    function _graceWithPauseExtension(uint256 _loanId) internal view returns (uint256) {
        Loan storage loan = loans[_loanId];
        uint256 baseDeadline = loan.deadline;
        uint256 graceStart = baseDeadline;
        uint256 graceEnd = baseDeadline + GRACE_PERIOD;
        uint256 graceExt = 0;

        // Sum overlap from completed pause episodes within [graceStart, graceEnd).
        // Bounded loop: PauseEpisode is appended only on _unpause; realistic
        // upper bound is a few dozen entries before the rolling 30-day cap
        // kicks in.
        uint256 len = pauseHistory.length;
        for (uint256 i = 0; i < len; i++) {
            PauseEpisode storage ep = pauseHistory[i];
            uint256 epStart = uint256(ep.startedAt);
            uint256 epEnd = uint256(ep.endedAt);
            if (epEnd <= graceStart) continue;
            if (epStart >= graceEnd) break; // append-only, time-ordered
            uint256 lo = epStart > graceStart ? epStart : graceStart;
            uint256 hi = epEnd < graceEnd ? epEnd : graceEnd;
            if (hi > lo) graceExt += (hi - lo);
        }

        // Live (in-flight) pause overlap.
        if (paused() && pauseStartTime != 0 && pauseStartTime < graceEnd) {
            uint256 livEnd = block.timestamp < graceEnd ? block.timestamp : graceEnd;
            uint256 livStart = pauseStartTime > graceStart ? pauseStartTime : graceStart;
            if (livEnd > livStart) graceExt += (livEnd - livStart);
        }

        return GRACE_PERIOD + graceExt;
    }

    /// @notice AUDIT FIX FRESH-2026: F-71-9 — sum of pause durations
    ///         intersecting the rolling 30-day window. Includes the
    ///         in-flight pause if currently paused. Used by `claimDefault`
    ///         to enforce the MAX_PAUSE_BLOCK_LIQUIDATION cap CUMULATIVELY
    ///         rather than consecutively.
    function _cumulativePausedInWindow() internal view returns (uint256 total) {
        uint256 windowStart = block.timestamp > CUMULATIVE_PAUSE_WINDOW
            ? block.timestamp - CUMULATIVE_PAUSE_WINDOW
            : 0;
        uint256 len = pauseHistory.length;
        for (uint256 i = 0; i < len; i++) {
            PauseEpisode storage ep = pauseHistory[i];
            uint256 epEnd = uint256(ep.endedAt);
            if (epEnd <= windowStart) continue;
            uint256 epStart = uint256(ep.startedAt);
            uint256 lo = epStart > windowStart ? epStart : windowStart;
            if (epEnd > lo) total += (epEnd - lo);
        }
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            uint256 lo = pauseStartTime > windowStart ? pauseStartTime : windowStart;
            total += (block.timestamp - lo);
        }
    }

    // ─── AUDIT C7: Timelocked Origination Fee ────────────────────────
    function proposeOriginationFee(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_ORIGINATION_FEE_BPS) revert OriginationFeeTooHigh();
        pendingOriginationFeeBps = _newBps;
        _propose(ORIGINATION_FEE_CHANGE, ECONOMICS_TIMELOCK);
        emit OriginationFeeProposed(_newBps, _executeAfter[ORIGINATION_FEE_CHANGE]);
    }

    function executeOriginationFeeChange() external onlyOwner {
        _execute(ORIGINATION_FEE_CHANGE);
        uint256 old = originationFeeBps;
        originationFeeBps = pendingOriginationFeeBps;
        pendingOriginationFeeBps = 0;
        emit OriginationFeeChanged(old, originationFeeBps);
    }

    function cancelOriginationFeeChange() external onlyOwner {
        _cancel(ORIGINATION_FEE_CHANGE);
        pendingOriginationFeeBps = 0;
    }

    function originationFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[ORIGINATION_FEE_CHANGE];
    }

    // ─── AUDIT H5: Timelocked Min APR ────────────────────────────────
    function proposeMinApr(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_MIN_APR_BPS) revert MinAprTooHigh();
        require(_newBps <= MAX_APR_BPS, "MIN_EXCEEDS_MAX");
        pendingMinAprBps = _newBps;
        _propose(MIN_APR_CHANGE, ECONOMICS_TIMELOCK);
        emit MinAprProposed(_newBps, _executeAfter[MIN_APR_CHANGE]);
    }

    function executeMinAprChange() external onlyOwner {
        _execute(MIN_APR_CHANGE);
        uint256 old = minAprBps;
        minAprBps = pendingMinAprBps;
        pendingMinAprBps = 0;
        emit MinAprChanged(old, minAprBps);
    }

    function cancelMinAprChange() external onlyOwner {
        _cancel(MIN_APR_CHANGE);
        pendingMinAprBps = 0;
    }

    function minAprChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_APR_CHANGE];
    }

    // ─── AUDIT FIX FRESH-2026: F-95-K-7 — stranded-NFT sweep ────────
    //
    // Pre-fix, an attacker could call `nftCollection.transferFrom(attacker,
    // address(this), tokenId)` for any whitelisted collection and orphan
    // the NFT here permanently — `claimStuckCollateral` only handles NFTs
    // tied to a `loanId`, so unsolicited NFTs not associated with any loan
    // were stuck forever. Now: owner-only, 24h-timelocked sweep that
    // refuses to seize an NFT recorded as active collateral, then
    // escrows the token under a stranded-recipient queue for the rightful
    // owner to claim via `claimStrandedNFT`.

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — propose owner-only sweep
    ///         of an unsolicited NFT into the stranded-recipient queue.
    ///         24h timelock matches WHITELIST_TIMELOCK.
    /// @dev    Reverts if the (collection, tokenId) pair is recorded as
    ///         active collateral via any non-settled loan or via the
    ///         `stuckCollateralRecipient` mapping.
    function proposeSweepUnsolicitedNFT(
        address _collection,
        uint256 _tokenId,
        address _recipient
    ) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (_recipient == address(0)) revert ZeroAddress();
        // Refuse to seize active collateral.
        uint256 lenLoans = loans.length;
        for (uint256 i = 0; i < lenLoans; i++) {
            Loan storage l = loans[i];
            if (
                l.collateralContract == _collection &&
                l.tokenId == _tokenId &&
                !l.repaid &&
                !l.defaultClaimed
            ) revert NFTIsActiveCollateral();
        }
        // Refuse if a stuck-collateral entry references this NFT —
        // claimStuckCollateral is the right path for that case.
        for (uint256 i = 0; i < lenLoans; i++) {
            if (stuckCollateralRecipient[i] != address(0)) {
                Loan storage l = loans[i];
                if (l.collateralContract == _collection && l.tokenId == _tokenId) {
                    revert NFTIsActiveCollateral();
                }
            }
        }

        pendingSweepCollection = _collection;
        pendingSweepTokenId = _tokenId;
        pendingSweepRecipient = _recipient;
        _propose(SWEEP_UNSOLICITED_NFT, WHITELIST_TIMELOCK);

        emit SweepUnsolicitedNFTProposed(
            _collection,
            _tokenId,
            _recipient,
            _executeAfter[SWEEP_UNSOLICITED_NFT]
        );
    }

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — execute the proposed sweep
    ///         after the 24h timelock has elapsed. Re-runs the
    ///         active-collateral guard since loans may have been created
    ///         during the timelock window. Pull-based: actual ERC721
    ///         transfer is deferred to `claimStrandedNFT` to neutralize
    ///         hostile collection re-entry.
    function executeSweepUnsolicitedNFT() external onlyOwner {
        address collection = pendingSweepCollection;
        uint256 tokenId = pendingSweepTokenId;
        address recipient = pendingSweepRecipient;

        // Re-check active-collateral state.
        uint256 lenLoans = loans.length;
        for (uint256 i = 0; i < lenLoans; i++) {
            Loan storage l = loans[i];
            if (
                l.collateralContract == collection &&
                l.tokenId == tokenId &&
                !l.repaid &&
                !l.defaultClaimed
            ) revert NFTIsActiveCollateral();
        }

        _execute(SWEEP_UNSOLICITED_NFT);

        bytes32 key = keccak256(abi.encode(collection, tokenId));
        strandedNFTRecipient[key] = recipient;

        pendingSweepCollection = address(0);
        pendingSweepTokenId = 0;
        pendingSweepRecipient = address(0);

        emit SweepUnsolicitedNFTExecuted(collection, tokenId, recipient);
    }

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — cancel a pending sweep.
    function cancelSweepUnsolicitedNFT() external onlyOwner {
        _cancel(SWEEP_UNSOLICITED_NFT);
        pendingSweepCollection = address(0);
        pendingSweepTokenId = 0;
        pendingSweepRecipient = address(0);
    }

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — pull-based claim of a
    ///         stranded NFT. Only the recipient recorded by
    ///         `executeSweepUnsolicitedNFT` may call.
    /// @dev    `whenNotPaused` intentionally OMITTED — recipient's right to
    ///         recover their NFT is independent of pause state.
    function claimStrandedNFT(address _collection, uint256 _tokenId) external nonReentrant {
        bytes32 key = keccak256(abi.encode(_collection, _tokenId));
        address recipient = strandedNFTRecipient[key];
        if (recipient == address(0)) revert NoStrandedNFT();
        if (msg.sender != recipient) revert NotStrandedRecipient();

        bool moved = _safeOutboundTransfer(_collection, address(this), recipient, _tokenId);
        if (!moved) revert StuckCollateralStillStuck();

        delete strandedNFTRecipient[key];
        emit StrandedNFTClaimed(_collection, _tokenId, recipient);
    }
}
