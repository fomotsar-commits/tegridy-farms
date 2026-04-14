// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// @title TegridyNFTLending — P2P Generic NFT-Collateralized Lending Protocol
/// @notice Peer-to-peer lending where lenders create ETH loan offers
///         and borrowers accept by escrowing any whitelisted ERC-721 NFT.
///
///         How it works:
///         1. Lender creates a loan offer by depositing ETH (specifies APR, duration, collection)
///         2. Borrower accepts an offer by transferring their NFT to this contract
///         3. Contract sends the principal ETH to the borrower
///         4. Borrower repays principal + pro-rata interest before deadline -> NFT returned
///         5. If borrower defaults (misses deadline) -> lender claims the NFT
///
///         Key design: NO oracle — lender evaluates risk themselves (Gondi pattern).
///         Interest: pro-rata fixed APR = principal * aprBps * elapsed / 10000 / 365 days
///         Protocol fee: percentage of interest earned (default 500 bps = 5%)
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - ReentrancyGuard + Pausable: OpenZeppelin 5.6.1
contract TegridyNFTLending is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("PROTOCOL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant WHITELIST_ADD = keccak256("WHITELIST_ADD");
    bytes32 public constant WHITELIST_REMOVE = keccak256("WHITELIST_REMOVE");

    // ─── Safety Caps ─────────────────────────────────────────────────
    uint256 public constant MAX_PRINCIPAL = 1000 ether;
    uint256 public constant MAX_APR_BPS = 50000;        // 500% APR
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ─── WETH Fallback ──────────────────────────────────────────────
    address public immutable weth;

    // ─── Timelock Delays ─────────────────────────────────────────────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;
    uint256 public constant WHITELIST_TIMELOCK = 24 hours;

    // ─── Structs ─────────────────────────────────────────────────────

    struct Offer {
        address lender;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        address collateralContract;
        bool active;
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
        bool repaid;
        bool defaultClaimed;
    }

    // ─── State ───────────────────────────────────────────────────────

    Offer[] public offers;
    Loan[] public loans;

    uint256 public protocolFeeBps;    // Fee on interest earned (default 500 = 5%)
    address public treasury;

    mapping(address => bool) public whitelistedCollections;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingProtocolFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistAdd;
    address public pendingWhitelistRemove;

    // ─── Events ──────────────────────────────────────────────────────

    event LoanOfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract
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
    error NotNFTOwner();
    error LoanAlreadyRepaid();
    error LoanTooRecent();
    error LoanAlreadyDefaultClaimed();
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

    // ─── Legacy View Helpers (for test compatibility) ────────────────
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Constructor ─────────────────────────────────────────────────

    /// @notice Deploy the NFT lending protocol.
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

        // Whitelist initial collections
        whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
        whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
        whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art

        emit CollectionWhitelisted(0xd37264c71e9af940e49795F0d3a8336afAaFDdA9);
        emit CollectionWhitelisted(0xd774557b647330C91Bf44cfEAB205095f7E6c367);
        emit CollectionWhitelisted(0xa1De9f93c56C290C48849B1393b09eB616D55dbb);
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    /// @notice Create a loan offer by depositing ETH. Lender specifies terms.
    /// @param _principal The ETH principal (must match msg.value)
    /// @param _aprBps Annual percentage rate in basis points
    /// @param _duration Loan duration in seconds
    /// @param _collateralContract Address of the whitelisted ERC-721 collection
    /// @return offerId The ID of the created offer
    function createOffer(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract
    ) external payable whenNotPaused returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value != _principal) revert MsgValueMismatch();
        if (_principal > MAX_PRINCIPAL) revert PrincipalTooLarge();
        if (_aprBps > MAX_APR_BPS) revert AprTooHigh();
        if (_duration < MIN_DURATION) revert DurationTooShort();
        if (_duration > MAX_DURATION) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();
        if (!whitelistedCollections[_collateralContract]) revert CollectionNotWhitelisted();

        offerId = offers.length;
        offers.push(Offer({
            lender: msg.sender,
            principal: _principal,
            aprBps: _aprBps,
            duration: _duration,
            collateralContract: _collateralContract,
            active: true
        }));

        emit LoanOfferCreated(
            offerId,
            msg.sender,
            _principal,
            _aprBps,
            _duration,
            _collateralContract
        );
    }

    /// @notice Cancel an active loan offer and refund ETH to lender.
    /// @param _offerId The ID of the offer to cancel
    function cancelOffer(uint256 _offerId) external nonReentrant {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        if (offer.lender != msg.sender) revert NotOfferLender();

        // CEI: state change before external call
        offer.active = false;
        uint256 refundAmount = offer.principal;

        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, refundAmount);

        emit LoanOfferCancelled(_offerId, msg.sender);
    }

    // ─── Borrowing ───────────────────────────────────────────────────

    /// @notice Accept a loan offer by escrowing a whitelisted ERC-721 NFT.
    ///         The borrower receives the principal ETH. NFT is held by this contract.
    /// @param _offerId The ID of the offer to accept
    /// @param _tokenId The NFT token ID to use as collateral
    /// @return loanId The ID of the created loan
    function acceptOffer(
        uint256 _offerId,
        uint256 _tokenId
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();

        // GAS: Cache storage reads into local variables
        uint256 principal = offer.principal;
        uint256 aprBps = offer.aprBps;
        address lender = offer.lender;
        uint256 duration = offer.duration;
        address collateralContract = offer.collateralContract;

        // Verify collection is still whitelisted
        if (!whitelistedCollections[collateralContract]) revert CollectionNotWhitelisted();

        // Verify borrower owns the NFT
        if (IERC721(collateralContract).ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();

        // CEI: state changes before external calls
        offer.active = false;

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
            repaid: false,
            defaultClaimed: false
        }));

        // Transfer NFT from borrower to this contract (collateral escrow)
        IERC721(collateralContract).transferFrom(msg.sender, address(this), _tokenId);

        // Send principal ETH to borrower
        (bool success,) = msg.sender.call{value: principal}("");
        if (!success) revert ETHTransferFailed();

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
    ///         NFT is returned to borrower. Interest goes to lender (minus protocol fee).
    ///         Callable even when paused — prevents forced defaults during pause.
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
        address collateralContract = loan.collateralContract;

        if (msg.sender != borrower) revert NotBorrower();
        // Prevent same-block zero-interest repayment
        if (block.timestamp == startTime) revert LoanTooRecent();

        // Enforce deadline — borrower cannot repay after deadline
        if (block.timestamp > loan.deadline) revert LoanNotDefaulted();

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

        // Calculate protocol fee on interest
        uint256 fee = (interest * protocolFeeBps) / BPS;
        uint256 lenderAmount = principal + interest - fee;

        // Return NFT to borrower
        IERC721(collateralContract).transferFrom(address(this), borrower, tokenId);

        // WETH fallback prevents DoS by revert-on-receive lender contracts
        WETHFallbackLib.safeTransferETHOrWrap(weth, lender, lenderAmount);

        // Send protocol fee to treasury
        if (fee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, fee);
        }

        // Refund overpayment to borrower
        uint256 overpayment = msg.value - totalRepayment;
        if (overpayment > 0) {
            WETHFallbackLib.safeTransferETH(msg.sender, overpayment);
        }

        emit LoanRepaid(_loanId, borrower, principal, interest, fee);
    }

    // ─── Default ─────────────────────────────────────────────────────

    /// @notice Claim the collateral NFT after a loan defaults (borrower missed deadline).
    /// @param _loanId The ID of the defaulted loan
    function claimDefault(uint256 _loanId) external nonReentrant whenNotPaused {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // GAS: Cache storage reads into local variables
        address lender = loan.lender;
        uint256 tokenId = loan.tokenId;
        address collateralContract = loan.collateralContract;

        if (msg.sender != lender) revert NotLoanLender();
        if (block.timestamp <= loan.deadline) revert LoanNotDefaulted();

        // CEI: state change before external call
        loan.defaultClaimed = true;

        // Transfer NFT to lender
        IERC721(collateralContract).transferFrom(address(this), lender, tokenId);

        emit DefaultClaimed(_loanId, lender, tokenId);
    }

    // ─── View Functions ──────────────────────────────────────────────

    /// @notice Get a loan offer by ID.
    function getOffer(uint256 _offerId) external view returns (
        address lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        bool active
    ) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        Offer memory o = offers[_offerId];
        return (o.lender, o.principal, o.aprBps, o.duration, o.collateralContract, o.active);
    }

    /// @notice Get a loan by ID.
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

    /// @notice Calculate pro-rata interest accrued (rounds up to protect protocol).
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
    function getRepaymentAmount(uint256 _loanId) external view returns (uint256 total) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        uint256 interest = calculateInterest(l.principal, l.aprBps, l.startTime, block.timestamp);
        total = l.principal + interest;
    }

    /// @notice Check whether a loan has defaulted (deadline passed and not repaid).
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

    // ─── Admin: Collection Whitelist Timelock ────────────────────────

    /// @notice Propose adding a collection to the whitelist. Takes effect after 24-hour timelock.
    function proposeWhitelistCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (whitelistedCollections[_collection]) revert CollectionAlreadyWhitelisted();

        pendingWhitelistAdd = _collection;
        _propose(WHITELIST_ADD, WHITELIST_TIMELOCK);

        emit CollectionWhitelistProposed(_collection, _executeAfter[WHITELIST_ADD]);
    }

    /// @notice Execute the pending whitelist addition after timelock has elapsed.
    function executeWhitelistCollection() external onlyOwner {
        _execute(WHITELIST_ADD);

        address collection = pendingWhitelistAdd;
        whitelistedCollections[collection] = true;
        pendingWhitelistAdd = address(0);

        emit CollectionWhitelisted(collection);
    }

    /// @notice Cancel a pending whitelist addition.
    function cancelWhitelistCollection() external onlyOwner {
        _cancel(WHITELIST_ADD);

        address cancelled = pendingWhitelistAdd;
        pendingWhitelistAdd = address(0);

        emit CollectionWhitelistCancelled(cancelled);
    }

    /// @notice Propose removing a collection from the whitelist. Takes effect after 24-hour timelock.
    function proposeRemoveCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (!whitelistedCollections[_collection]) revert CollectionNotCurrentlyWhitelisted();

        pendingWhitelistRemove = _collection;
        _propose(WHITELIST_REMOVE, WHITELIST_TIMELOCK);

        emit CollectionRemovalProposed(_collection, _executeAfter[WHITELIST_REMOVE]);
    }

    /// @notice Execute the pending whitelist removal after timelock has elapsed.
    function executeRemoveCollection() external onlyOwner {
        _execute(WHITELIST_REMOVE);

        address collection = pendingWhitelistRemove;
        whitelistedCollections[collection] = false;
        pendingWhitelistRemove = address(0);

        emit CollectionRemoved(collection);
    }

    /// @notice Cancel a pending whitelist removal.
    function cancelRemoveCollection() external onlyOwner {
        _cancel(WHITELIST_REMOVE);

        address cancelled = pendingWhitelistRemove;
        pendingWhitelistRemove = address(0);

        emit CollectionRemovalCancelled(cancelled);
    }

    // ─── Admin: Protocol Fee Timelock ────────────────────────────────

    /// @notice Propose a new protocol fee. Takes effect after 48-hour timelock.
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
