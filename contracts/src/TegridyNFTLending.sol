// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";

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

    // ─── Safety Caps ─────────────────────────────────────────────────
    uint256 public constant MAX_PRINCIPAL = 1000 ether;
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
    address public immutable sequencerFeed;
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
    }

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

    // ─── Errors ──────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrincipal();
    error PrincipalTooLarge();
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

    // ─── Legacy View Helpers (for test compatibility) ────────────────
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address _treasury,
        uint256 _protocolFeeBps,
        address _weth
    ) OwnableNoRenounce(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();

        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        weth = _weth;
        // AUDIT FIX: DEEP-LD-M10 — sequencerFeed defaults to address(0). Zero
        // means non-L2 / mainnet (no-op). Constructor stays backward-compatible
        // with existing test deployments.
        sequencerFeed = address(0);

        // Whitelist initial collections
        whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
        whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
        whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art

        emit CollectionWhitelisted(0xd37264c71e9af940e49795F0d3a8336afAaFDdA9);
        emit CollectionWhitelisted(0xd774557b647330C91Bf44cfEAB205095f7E6c367);
        emit CollectionWhitelisted(0xa1De9f93c56C290C48849B1393b09eB616D55dbb);
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    function createOffer(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _tokenId
    ) external payable nonReentrant whenNotPaused returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value != _principal) revert MsgValueMismatch();
        if (_principal > MAX_PRINCIPAL) revert PrincipalTooLarge();
        if (_aprBps > MAX_APR_BPS) revert AprTooHigh();
        if (_aprBps < minAprBps) revert AprTooLow();
        if (_duration < MIN_DURATION) revert DurationTooShort();
        if (_duration > MAX_DURATION) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();
        if (!whitelistedCollections[_collateralContract]) revert CollectionNotWhitelisted();
        if (
            pendingWhitelistRemove == _collateralContract
            && _executeAfter[WHITELIST_REMOVE] != 0
        ) {
            revert CollectionPendingRemoval();
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
            treasuryAtCreate: treasury
        }));

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

        uint256 principal = offer.principal;
        uint256 aprBps = offer.aprBps;
        address lender = offer.lender;
        uint256 duration = offer.duration;
        address collateralContract = offer.collateralContract;
        uint256 _tokenId = offer.tokenId;
        uint256 originationFee = offer.originationFee;
        // AUDIT FIX: DEEP-LD2-M3 — use the snapshotted treasury for fee routing
        // so a treasury change between create and accept cannot redirect the fee.
        // Migration safety: pre-LD2-M3 offers default to address(0); fall back to
        // the live treasury so legacy offers remain payable.
        address feeRecipient = offer.treasuryAtCreate;
        if (feeRecipient == address(0)) feeRecipient = treasury;
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
        if (
            pendingWhitelistRemove == collateralContract
            && _executeAfter[WHITELIST_REMOVE] != 0
        ) {
            revert CollectionPendingRemoval();
        }

        try IERC721(collateralContract).ownerOf(_tokenId) returns (address currentOwner) {
            if (currentOwner != msg.sender) revert NotNFTOwner();
        } catch {
            revert CollateralBurnedSinceOffer();
        }

        // CEI: state changes before external calls
        offer.active = false;
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
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD
        );
        if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
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
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
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

        uint256 fee = (interest * protocolFeeBps) / BPS;
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
            WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, fee);
        }

        uint256 overpayment = msg.value - totalRepayment;
        if (overpayment > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, overpayment);
        }

        emit LoanRepaid(_loanId, borrower, principal, interest, fee);
    }

    // ─── Default ─────────────────────────────────────────────────────

    function claimDefault(uint256 _loanId) external nonReentrant whenNotPaused {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // AUDIT FIX: DEEP-LIB-H3 — sequencer-uptime gate at the top of the
        // liquidation entrypoint. Pre-fix the lender could call claimDefault
        // the instant `block.timestamp > effectiveDeadline + GRACE_PERIOD`
        // even when a sequencer outage had consumed the entire grace
        // window, leaving the borrower zero usable repay time. The gate
        // mirrors the symmetric fix in TegridyLending.claimDefaultedCollateral
        // and the existing acceptOffer guard above.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);

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
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD
        );
        if (block.timestamp <= effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
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

        // Clear BEFORE the external call (CEI) so a re-entry via a hostile
        // collection's transferFrom callback cannot double-pay.
        delete stuckCollateralRecipient[_loanId];

        // Retry the transfer. If it still reverts, the whole tx reverts and
        // the mapping rollback restores the recipient claim — they can try
        // again later.
        IERC721(collateralContract).transferFrom(address(this), recipient, tokenId);

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
        try IERC721(collection).transferFrom(from, to, tokenId) {
            // happy path — verify post-condition.
            try IERC721(collection).ownerOf(tokenId) returns (address newOwner) {
                moved = (newOwner == to);
                // If newOwner is some unexpected third party (malicious collection
                // that redirected the transfer), we ALSO return false — the loan
                // settlement above stands but the NFT is unrecoverable through
                // this contract's stuck path. Emit a forensic warning event so
                // off-chain monitoring can flag the malicious collection.
                if (!moved && newOwner != from) {
                    emit CollateralRedirected(tokenId, collection, to, newOwner);
                }
            } catch {
                // ownerOf reverted — token likely burned during transfer or the
                // collection contract is broken. Treat as not-moved (caller will
                // mark stuck), but recovery may not be possible.
                moved = false;
            }
        } catch {
            moved = false;
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
    /// @dev    AUDIT FIX: LD3-M4 (LD2-L2) — fail-loud on the pause invariant
    ///         instead of the prior silent ternary clamp. See `PauseInvariantViolated`.
    function pauseAdjustedElapsed(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        if (block.timestamp <= loan.startTime) return 0;
        uint256 raw = block.timestamp - loan.startTime;
        // AUDIT FIX: LD3-M4 (LD2-L2) — invariant check.
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
        if (cancelled != address(0)) {
            if (removalRetryCount[cancelled] >= REMOVAL_MAX_CANCELLATIONS) {
                revert RemovalCancelLimitReached();
            }
            removalRetryCount[cancelled] += 1;
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
        }
        pauseStartTime = 0;
        super._unpause();
    }

    /// @notice Pause-extended deadline for a loan.
    /// @dev    AUDIT FIX: DEEP-LD-H2 (mirror H10) — only count pause-time
    ///         that occurred AFTER this loan started.
    /// @dev    AUDIT FIX: LD3-M4 (LD2-L2) — fail-loud on the pause invariant.
    function effectiveDeadline(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 base = loan.deadline;
        // AUDIT FIX: LD3-M4 (LD2-L2) — invariant check.
        if (loan.pausedDurationAtStart > totalPausedDuration) revert PauseInvariantViolated();
        uint256 pauseExt = totalPausedDuration - loan.pausedDurationAtStart;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pauseExt += block.timestamp - pauseStartTime;
        }
        return base + pauseExt;
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
}
