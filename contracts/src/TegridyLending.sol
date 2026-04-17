// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// @dev Minimal interface for TegridyStaking NFT position queries and transfers.
interface ITegridyStaking {
    function getPosition(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostBps,
        uint256 lockEnd,
        uint256 lockDuration,
        bool autoMaxLock,
        bool canWithdraw
    );
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title TegridyLending — P2P NFT-Collateralized Lending Protocol
/// @notice Gondi-inspired peer-to-peer lending where lenders create ETH loan offers
///         and borrowers accept by escrowing their TegridyStaking NFT position (ERC721).
///
///         How it works:
///         1. Lender creates a loan offer by depositing ETH (specifies APR, duration, min collateral value)
///         2. Borrower accepts an offer by transferring their staking NFT to this contract
///         3. Contract sends the principal ETH to the borrower
///         4. Borrower repays principal + pro-rata interest before deadline → NFT returned
///         5. If borrower defaults (misses deadline) → lender claims the NFT
///
///         Key design: NO oracle — lender evaluates risk themselves (Gondi pattern).
///         Interest: pro-rata fixed APR = principal * aprBps * elapsed / 10000 / 365 days
///         Protocol fee: percentage of interest earned (default 500 bps = 5%)
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - ReentrancyGuard + Pausable: OpenZeppelin 5.6.1
contract TegridyLending is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("PROTOCOL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");

    // ─── Safety Caps ─────────────────────────────────────────────────
    uint256 public constant MAX_PRINCIPAL = 1000 ether;
    uint256 public constant MAX_APR_BPS = 50000;        // 500% APR
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    /// @notice AUDIT M-1: post-deadline grace window during which a borrower can still
    ///         repay before the lender is allowed to claim default. Buffer against
    ///         transient failures (gas spikes, provider outages, wallet delays). Interest
    ///         still accrues through the grace period so the lender isn't penalised.
    uint256 public constant GRACE_PERIOD = 1 hours;

    // ─── WETH Fallback ──────────────────────────────────────────────
    address public immutable weth; // WETH for fallback payout to revert-on-receive lenders

    // ─── Timelock Delays ─────────────────────────────────────────────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;

    // ─── Structs ─────────────────────────────────────────────────────

    struct LoanOffer {
        address lender;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        address collateralContract;
        uint256 minPositionValue;
        bool active;
    }

    struct Loan {
        address borrower;
        address lender;
        uint256 offerId;
        uint256 tokenId;
        uint256 principal;
        uint256 aprBps;
        uint256 startTime;
        uint256 deadline;
        bool repaid;
        bool defaultClaimed;
    }

    // ─── State ───────────────────────────────────────────────────────

    LoanOffer[] public offers;
    Loan[] public loans;

    uint256 public protocolFeeBps;    // Fee on interest earned (default 500 = 5%)
    address public treasury;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingProtocolFeeBps;
    address public pendingTreasury;

    // ─── Events ──────────────────────────────────────────────────────

    event LoanOfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue
    );
    event LoanOfferCancelled(uint256 indexed offerId, address indexed lender);
    event LoanAccepted(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed borrower,
        address lender,
        uint256 tokenId,
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
    event ProtocolFeeChangeProposed(uint256 currentBps, uint256 proposedBps, uint256 readyAt);
    event ProtocolFeeChanged(uint256 oldBps, uint256 newBps);
    event ProtocolFeeChangeCancelled(uint256 cancelledBps);
    event TreasuryChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryChangeCancelled(address indexed cancelled);

    // ─── Errors ──────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrincipal();
    error PrincipalTooLarge();
    error AprTooHigh();
    error DurationTooShort();
    error DurationTooLong();
    error FeeTooHigh();
    error OfferNotActive();
    error NotOfferLender();
    error InsufficientCollateralValue();
    error NotNFTOwner();
    error LoanAlreadyRepaid();
    error LoanTooRecent();
    error LockExpiresBeforeDeadline();
    error LoanAlreadyDefaultClaimed();
    error NotBorrower();
    error NotLoanLender();
    error DeadlineNotReached();
    error DeadlineExpired(); // AUDIT FIX C-04: Renamed from LoanNotDefaulted — borrower missed the deadline
    error InsufficientRepayment();
    error ETHTransferFailed();
    error InvalidLoanId();
    error InvalidOfferId();
    error MsgValueMismatch();

    // ─── Legacy View Helpers (for test compatibility) ────────────────
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Constructor ─────────────────────────────────────────────────

    /// @notice Deploy the lending protocol.
    /// @param _treasury Address to receive protocol fees
    /// @param _protocolFeeBps Initial protocol fee in basis points (applied to interest)
    /// @param _weth Canonical WETH address (e.g., 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on mainnet)
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
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    /// @notice Create a loan offer by depositing ETH. Lender specifies terms.
    /// @param _aprBps Annual percentage rate in basis points
    /// @param _duration Loan duration in seconds
    /// @param _collateralContract Address of the TegridyStaking contract (ERC721)
    /// @param _minPositionValue Minimum staked amount in the NFT position
    /// @return offerId The ID of the created offer
    function createLoanOffer(
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _minPositionValue
    ) external payable whenNotPaused returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value > MAX_PRINCIPAL) revert PrincipalTooLarge();
        if (_aprBps > MAX_APR_BPS) revert AprTooHigh();
        if (_duration < MIN_DURATION) revert DurationTooShort();
        if (_duration > MAX_DURATION) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();

        offerId = offers.length;
        offers.push(LoanOffer({
            lender: msg.sender,
            principal: msg.value,
            aprBps: _aprBps,
            duration: _duration,
            collateralContract: _collateralContract,
            minPositionValue: _minPositionValue,
            active: true
        }));

        emit LoanOfferCreated(
            offerId,
            msg.sender,
            msg.value,
            _aprBps,
            _duration,
            _collateralContract,
            _minPositionValue
        );
    }

    /// @notice Cancel an active loan offer and refund ETH to lender.
    /// @param _offerId The ID of the offer to cancel
    function cancelOffer(uint256 _offerId) external nonReentrant {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        if (offer.lender != msg.sender) revert NotOfferLender();

        // CEI: state change before external call
        offer.active = false;
        uint256 refundAmount = offer.principal;

        // SECURITY FIX: Use WETHFallbackLib to prevent DoS if lender is a contract that reverts on receive
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, refundAmount);

        emit LoanOfferCancelled(_offerId, msg.sender);
    }

    // ─── Borrowing ───────────────────────────────────────────────────

    /// @notice Accept a loan offer by escrowing a TegridyStaking NFT position.
    ///         The borrower receives the principal ETH. NFT is held by this contract.
    /// @param _offerId The ID of the offer to accept
    /// @param _tokenId The TegridyStaking NFT token ID to use as collateral
    /// @return loanId The ID of the created loan
    function acceptOffer(
        uint256 _offerId,
        uint256 _tokenId
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();

        // GAS: Cache storage reads into local variables
        uint256 principal = offer.principal;
        uint256 aprBps = offer.aprBps;
        address lender = offer.lender;
        uint256 duration = offer.duration;
        address collateralContract = offer.collateralContract;
        uint256 minPositionValue = offer.minPositionValue;

        // Validate collateral: check position value meets minimum
        ITegridyStaking staking = ITegridyStaking(collateralContract);
        (uint256 positionAmount,, uint256 lockEnd,,,) = staking.getPosition(_tokenId);
        if (positionAmount < minPositionValue) revert InsufficientCollateralValue();

        // Ensure position lock doesn't expire before loan deadline
        // Prevents lender from receiving worthless unlocked collateral on default
        // SECURITY FIX: Also reject lockEnd == 0 (unlocked positions) — an unlocked position
        // could have its underlying tokens withdrawn, leaving the collateral worthless.
        uint256 deadline = block.timestamp + duration;
        if (lockEnd == 0 || lockEnd < deadline) revert LockExpiresBeforeDeadline();

        // Verify borrower owns the NFT
        if (staking.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();

        // CEI: state changes before external calls
        offer.active = false;

        loanId = loans.length;
        loans.push(Loan({
            borrower: msg.sender,
            lender: lender,
            offerId: _offerId,
            tokenId: _tokenId,
            principal: principal,
            aprBps: aprBps,
            startTime: block.timestamp,
            deadline: deadline,
            repaid: false,
            defaultClaimed: false
        }));

        // Transfer NFT from borrower to this contract (collateral escrow)
        staking.transferFrom(msg.sender, address(this), _tokenId);

        // Send principal ETH to borrower
        (bool success,) = msg.sender.call{value: principal}("");
        if (!success) revert ETHTransferFailed();

        emit LoanAccepted(
            loanId,
            _offerId,
            msg.sender,
            lender,
            _tokenId,
            principal,
            deadline
        );
    }

    // ─── Repayment ───────────────────────────────────────────────────

    /// @notice Repay a loan. Borrower sends principal + interest.
    ///         NFT is returned to borrower. Interest goes to lender (minus protocol fee).
    ///         SECURITY FIX: Callable even when paused — prevents forced defaults during pause.
    ///         If repayLoan were paused, deadlines would still expire, letting lenders claim
    ///         collateral on loans that borrowers intended to repay (griefing vector).
    /// @param _loanId The ID of the loan to repay
    function repayLoan(uint256 _loanId) external payable nonReentrant {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // GAS: Cache storage reads into local variables
        address borrower = loan.borrower;
        address lender = loan.lender;
        uint256 principal = loan.principal;
        uint256 aprBps = loan.aprBps;
        uint256 startTime = loan.startTime;
        uint256 tokenId = loan.tokenId;
        uint256 offerId = loan.offerId;

        if (msg.sender != borrower) revert NotBorrower();
        // Prevent same-block zero-interest repayment
        if (block.timestamp == startTime) revert LoanTooRecent();

        uint256 interest = calculateInterest(
            principal,
            aprBps,
            startTime,
            block.timestamp
        );
        uint256 totalRepayment = principal + interest;
        if (msg.value < totalRepayment) revert InsufficientRepayment();

        // CEI: state change before external calls
        loan.repaid = true;

        // SECURITY FIX: Enforce deadline + 1h grace period (AUDIT M-1). Borrower can
        // repay up to and including deadline + GRACE_PERIOD. Past that window, the
        // lender's claimDefaultedCollateral path opens. Interest continues to accrue
        // through the grace window so the lender isn't penalised by the cushion.
        if (block.timestamp > loan.deadline + GRACE_PERIOD) revert DeadlineExpired();

        // Calculate protocol fee on interest
        uint256 fee = (interest * protocolFeeBps) / BPS;
        uint256 lenderAmount = principal + interest - fee;

        // Return NFT to borrower
        ITegridyStaking staking = ITegridyStaking(
            offers[offerId].collateralContract
        );
        staking.transferFrom(address(this), borrower, tokenId);

        // SECURITY FIX: Use WETHFallbackLib to prevent DoS by revert-on-receive lender contracts.
        // A malicious lender could deploy a contract that reverts on ETH receive, permanently blocking
        // repayment and stealing the NFT collateral via claimDefaultedCollateral(). With WETH fallback,
        // if the raw ETH send fails, funds are wrapped as WETH and sent as ERC-20 instead.
        WETHFallbackLib.safeTransferETHOrWrap(weth, lender, lenderAmount);

        // Send protocol fee to treasury (also uses WETH fallback for robustness)
        if (fee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, fee);
        }

        // Refund overpayment to borrower (borrower is msg.sender, use plain transfer)
        uint256 overpayment = msg.value - totalRepayment;
        if (overpayment > 0) {
            WETHFallbackLib.safeTransferETH(msg.sender, overpayment);
        }

        emit LoanRepaid(_loanId, borrower, principal, interest, fee);
    }

    // ─── Default ─────────────────────────────────────────────────────

    /// @notice Claim the collateral NFT after a loan defaults (borrower missed deadline).
    /// @param _loanId The ID of the defaulted loan
    function claimDefaultedCollateral(uint256 _loanId) external nonReentrant whenNotPaused {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // GAS: Cache storage reads into local variables
        address lender = loan.lender;
        uint256 tokenId = loan.tokenId;
        uint256 offerId = loan.offerId;

        if (msg.sender != lender) revert NotLoanLender();
        // AUDIT M-1: lender must wait for the post-deadline grace period to expire
        // before claiming the collateral, giving the borrower a 1h cushion to repay.
        if (block.timestamp <= loan.deadline + GRACE_PERIOD) revert DeadlineNotReached();

        // CEI: state change before external call
        loan.defaultClaimed = true;

        // Transfer NFT to lender
        ITegridyStaking staking = ITegridyStaking(
            offers[offerId].collateralContract
        );
        staking.transferFrom(address(this), lender, tokenId);

        emit DefaultClaimed(_loanId, lender, tokenId);
    }

    // ─── View Functions ──────────────────────────────────────────────

    /// @notice Get a loan offer by ID.
    /// @param _offerId The offer ID to query
    /// @return lender The address of the lender
    /// @return principal The ETH principal amount
    /// @return aprBps The annual percentage rate in basis points
    /// @return duration The loan duration in seconds
    /// @return collateralContract The TegridyStaking contract address
    /// @return minPositionValue The minimum collateral position value
    /// @return active Whether the offer is still active
    function getOffer(uint256 _offerId) external view returns (
        address lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue,
        bool active
    ) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer memory o = offers[_offerId];
        return (o.lender, o.principal, o.aprBps, o.duration, o.collateralContract, o.minPositionValue, o.active);
    }

    /// @notice Get a loan by ID.
    /// @param _loanId The loan ID to query
    /// @return borrower The borrower address
    /// @return lender The lender address
    /// @return offerId The associated offer ID
    /// @return tokenId The escrowed NFT token ID
    /// @return principal The ETH principal amount
    /// @return aprBps The annual percentage rate in basis points
    /// @return startTime The loan start timestamp
    /// @return deadline The repayment deadline timestamp
    /// @return repaid Whether the loan has been repaid
    /// @return defaultClaimed Whether the lender has claimed the defaulted collateral
    function getLoan(uint256 _loanId) external view returns (
        address borrower,
        address lender,
        uint256 offerId,
        uint256 tokenId,
        uint256 principal,
        uint256 aprBps,
        uint256 startTime,
        uint256 deadline,
        bool repaid,
        bool defaultClaimed
    ) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return (l.borrower, l.lender, l.offerId, l.tokenId, l.principal, l.aprBps, l.startTime, l.deadline, l.repaid, l.defaultClaimed);
    }

    /// @notice Calculate pro-rata interest accrued (rounds up to protect protocol).
    /// @param _principal The loan principal
    /// @param _aprBps The annual percentage rate in basis points
    /// @param _startTime The loan start time
    /// @param _currentTime The current time (or repayment time)
    /// @return interest The interest amount in wei
    function calculateInterest(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _startTime,
        uint256 _currentTime
    ) public pure returns (uint256 interest) {
        if (_currentTime <= _startTime) return 0;
        uint256 elapsed = _currentTime - _startTime;
        interest = _ceilDiv(_principal * _aprBps * elapsed, BPS * SECONDS_PER_YEAR);
    }

    /// @dev Ceiling division: returns ceil(a / b) for positive a, b.
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// @notice Get the total repayment amount for a loan at the current time.
    /// @param _loanId The loan ID to query
    /// @return total The total amount due (principal + interest)
    function getRepaymentAmount(uint256 _loanId) external view returns (uint256 total) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        uint256 interest = calculateInterest(l.principal, l.aprBps, l.startTime, block.timestamp);
        total = l.principal + interest;
    }

    /// @notice Check whether a loan has defaulted (deadline passed and not repaid).
    /// @param _loanId The loan ID to check
    /// @return Whether the loan is in default
    function isDefaulted(uint256 _loanId) external view returns (bool) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return !l.repaid && !l.defaultClaimed && block.timestamp > l.deadline;
    }

    /// @notice Get the total number of offers created.
    function offerCount() external view returns (uint256) {
        return offers.length;
    }

    /// @notice Get the total number of loans created.
    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    // ─── Admin: Protocol Fee Timelock ────────────────────────────────

    /// @notice Propose a new protocol fee. Takes effect after 48-hour timelock.
    /// @param _newFeeBps The proposed protocol fee in basis points
    function proposeProtocolFeeChange(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();

        pendingProtocolFeeBps = _newFeeBps;
        _propose(PROTOCOL_FEE_CHANGE, PROTOCOL_FEE_TIMELOCK);

        emit ProtocolFeeChangeProposed(protocolFeeBps, _newFeeBps, _executeAfter[PROTOCOL_FEE_CHANGE]);
    }

    /// @notice Execute the pending protocol fee change after timelock has elapsed.
    function executeProtocolFeeChange() external onlyOwner {
        _execute(PROTOCOL_FEE_CHANGE);

        uint256 oldBps = protocolFeeBps;
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;

        emit ProtocolFeeChanged(oldBps, protocolFeeBps);
    }

    /// @notice Cancel a pending protocol fee change.
    function cancelProtocolFeeChange() external onlyOwner {
        _cancel(PROTOCOL_FEE_CHANGE);

        uint256 cancelled = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;

        emit ProtocolFeeChangeCancelled(cancelled);
    }

    // ─── Admin: Treasury Timelock ────────────────────────────────────

    /// @notice Propose a new treasury address. Takes effect after 48-hour timelock.
    /// @param _newTreasury The proposed new treasury address
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();

        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_TIMELOCK);

        emit TreasuryChangeProposed(treasury, _newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Execute the pending treasury change after timelock has elapsed.
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);

        address oldTreasury = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);

        emit TreasuryChanged(oldTreasury, treasury);
    }

    /// @notice Cancel a pending treasury change.
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
}
