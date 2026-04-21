// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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

/// @dev Minimal interface for TegridyPair reserve queries (used by the ETH-floor check).
interface ITegridyPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
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
    // AUDIT TF-06 / Spartan MEDIUM: keys for the previously-constant safety caps
    // that are now timelocked state.
    bytes32 public constant MAX_PRINCIPAL_CHANGE = keccak256("LENDING_MAX_PRINCIPAL_CHANGE");
    bytes32 public constant MAX_APR_CHANGE = keccak256("LENDING_MAX_APR_CHANGE");
    bytes32 public constant MIN_DURATION_CHANGE = keccak256("LENDING_MIN_DURATION_CHANGE");
    bytes32 public constant MAX_DURATION_CHANGE = keccak256("LENDING_MAX_DURATION_CHANGE");
    bytes32 public constant ORIGINATION_FEE_CHANGE = keccak256("LENDING_ORIGINATION_FEE_CHANGE"); // AUDIT C7
    bytes32 public constant MIN_APR_CHANGE = keccak256("LENDING_MIN_APR_CHANGE"); // AUDIT H14

    // ─── Safety Caps ─────────────────────────────────────────────────
    // AUDIT TF-06 (Spartan MEDIUM): lending caps were compile-time constants with
    // no way to adjust as ETH price / market demand evolves. They are now timelocked
    // state variables (48h delay) with absolute *_CEILING hard caps no admin can
    // exceed. MAX_PROTOCOL_FEE_BPS remains a constant — 10% is already a ceiling
    // nobody should exceed.
    // AUDIT H-05: overflow risk on `principal * aprBps * elapsed` is addressed in
    // calculateInterest via OpenZeppelin's Math.mulDiv (512-bit intermediate,
    // overflow-safe even if the caps are raised up to their ceilings).
    uint256 public maxPrincipal = 1000 ether;
    uint256 public maxAprBps = 50000;        // 500% APR
    uint256 public minDuration = 1 days;
    uint256 public maxDuration = 365 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% — hard-cap constant
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice Absolute ceilings. Admin can adjust cap values below these but never above.
    /// @dev Chosen to leave substantial headroom while bounding the worst-case damage from
    ///      a compromised owner key or a mispriced proposal.
    uint256 public constant MAX_PRINCIPAL_CEILING = 100_000 ether;
    uint256 public constant MAX_APR_BPS_CEILING = 100_000;      // 1000% APR hard cap
    uint256 public constant MIN_DURATION_FLOOR = 1 hours;       // never lower than 1h
    uint256 public constant MIN_DURATION_CEILING = 7 days;      // never higher than 7d
    uint256 public constant MAX_DURATION_CEILING = 3650 days;   // 10-year hard cap

    uint256 public constant CAP_CHANGE_TIMELOCK = 48 hours;

    // ─── AUDIT C7: origination fee charged on createLoanOffer ────────────
    /// @notice Fee in BPS deducted from the lender's deposited principal at offer creation.
    ///         Sent to treasury immediately. The borrower receives (msg.value - origination fee).
    ///         Default 0 — backward-compatible. Capped at MAX_ORIGINATION_FEE_BPS (200 = 2%).
    ///         48h timelocked setter. Closes the "lender uses protocol as free escrow"
    ///         silent killer: now every accepted offer pays a fee, regardless of repay/default.
    uint256 public originationFeeBps;
    uint256 public constant MAX_ORIGINATION_FEE_BPS = 200;

    // ─── AUDIT H14: minimum APR enforced on createLoanOffer ──────────────
    /// @notice Minimum acceptable APR in BPS. Default 0 — backward-compatible. Capped at
    ///         MAX_MIN_APR_BPS (1000 = 10%). Closes the 0-APR free-NFT-acquisition channel.
    uint256 public minAprBps;
    uint256 public constant MAX_MIN_APR_BPS = 1000;

    uint256 public pendingOriginationFeeBps;
    uint256 public pendingMinAprBps;

    // Pending proposal storage
    uint256 public pendingMaxPrincipal;
    uint256 public pendingMaxAprBps;
    uint256 public pendingMinDuration;
    uint256 public pendingMaxDuration;
    /// @notice AUDIT M-1: post-deadline grace window during which a borrower can still
    ///         repay before the lender is allowed to claim default. Buffer against
    ///         transient failures (gas spikes, provider outages, wallet delays). Interest
    ///         still accrues through the grace period so the lender isn't penalised.
    uint256 public constant GRACE_PERIOD = 1 hours;

    // ─── WETH Fallback ──────────────────────────────────────────────
    address public immutable weth; // WETH for fallback payout to revert-on-receive lenders

    // ─── Pair / TOWELI references (ETH-floor oracle) ────────────────
    // AUDIT critique 5.4: TegridyPair provides the spot reserves used by the optional
    // ETH-denominated collateral floor (see `_positionETHValue`). The `toweli` address
    // is snapshotted at construction so `_positionETHValue` knows which reserve slot
    // represents TOWELI and which represents WETH.
    address public immutable pair;
    address public immutable toweli;

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
        /// @notice AUDIT critique 5.4: Optional ETH-denominated collateral floor. When
        ///         non-zero, `acceptOffer` additionally requires that the position's TOWELI
        ///         amount valued at the current TegridyPair spot reserves >= this threshold.
        ///         Zero = disabled (backward-compatible default — no ETH-floor check applied).
        uint256 minPositionETHValue;
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
        uint256 minPositionValue,
        uint256 minPositionETHValue
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

    // AUDIT TF-06: cap-change events (48h timelock observability)
    event MaxPrincipalProposed(uint256 newCap, uint256 readyAt);
    event MaxPrincipalChanged(uint256 oldCap, uint256 newCap);
    event MaxAprBpsProposed(uint256 newCap, uint256 readyAt);
    event MaxAprBpsChanged(uint256 oldCap, uint256 newCap);
    event MinDurationProposed(uint256 newValue, uint256 readyAt);
    event MinDurationChanged(uint256 oldValue, uint256 newValue);
    event MaxDurationProposed(uint256 newValue, uint256 readyAt);
    event MaxDurationChanged(uint256 oldValue, uint256 newValue);
    // AUDIT C7 / H14
    event OriginationFeeProposed(uint256 newBps, uint256 readyAt);
    event OriginationFeeChanged(uint256 oldBps, uint256 newBps);
    event OriginationFeeCollected(address indexed lender, uint256 amount);
    event MinAprProposed(uint256 newBps, uint256 readyAt);
    event MinAprChanged(uint256 oldBps, uint256 newBps);

    // ─── Errors ──────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrincipal();
    error ZeroAmount();             // AUDIT TF-06 — cap-propose value is zero
    error InvalidCapValue();        // AUDIT TF-06 — cap-propose outside the [*_FLOOR, *_CEILING] window
    error PrincipalTooLarge();
    error AprTooHigh();
    error AprTooLow();                  // AUDIT H14
    error OriginationFeeTooHigh();      // AUDIT C7
    error MinAprTooHigh();              // AUDIT H14
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
    /// @param _pair TegridyPair (TOWELI/WETH) used by the optional ETH-denominated
    ///              collateral floor in `acceptOffer`. Reserve-slot orientation is resolved
    ///              at deploy time via `token0()` / `token1()`.
    constructor(
        address _treasury,
        uint256 _protocolFeeBps,
        address _weth,
        address _pair
    ) OwnableNoRenounce(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_pair == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();

        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        weth = _weth;
        pair = _pair;

        // Snapshot the TOWELI side of the pair at construction so we don't depend
        // on an externally passed address later. Whichever slot isn't WETH is TOWELI.
        address t0 = ITegridyPair(_pair).token0();
        address t1 = ITegridyPair(_pair).token1();
        if (t0 == _weth) {
            toweli = t1;
        } else if (t1 == _weth) {
            toweli = t0;
        } else {
            // Pair does not contain WETH — misconfiguration.
            revert ZeroAddress();
        }
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    /// @notice Create a loan offer by depositing ETH. Lender specifies terms.
    /// @param _aprBps Annual percentage rate in basis points
    /// @param _duration Loan duration in seconds
    /// @param _collateralContract Address of the TegridyStaking contract (ERC721)
    /// @param _minPositionValue Minimum staked TOWELI amount in the NFT position
    /// @param _minPositionETHValue Optional ETH-denominated collateral floor. Zero disables
    ///        the check (backward-compatible default); non-zero enforces the floor inside
    ///        `acceptOffer` using current TegridyPair spot reserves. See `_positionETHValue`
    ///        for the caveats on spot-reserve reliance.
    /// @return offerId The ID of the created offer
    function createLoanOffer(
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _minPositionValue,
        uint256 _minPositionETHValue
    ) external payable whenNotPaused returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value > maxPrincipal) revert PrincipalTooLarge();
        if (_aprBps > maxAprBps) revert AprTooHigh();
        // AUDIT H14: enforce minimum APR. Closes the 0% APR free-collateral channel.
        if (_aprBps < minAprBps) revert AprTooLow();
        if (_duration < minDuration) revert DurationTooShort();
        if (_duration > maxDuration) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();

        // AUDIT C7: deduct origination fee from lender's deposit and forward to treasury.
        // The borrower receives (msg.value - origination fee) at acceptOffer time, so the
        // protocol always captures revenue on every accepted offer regardless of repay/default.
        uint256 originationFee = (msg.value * originationFeeBps) / BPS;
        uint256 effectivePrincipal = msg.value - originationFee;
        if (originationFee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, originationFee);
            emit OriginationFeeCollected(msg.sender, originationFee);
        }

        offerId = offers.length;
        offers.push(LoanOffer({
            lender: msg.sender,
            principal: effectivePrincipal,
            aprBps: _aprBps,
            duration: _duration,
            collateralContract: _collateralContract,
            minPositionValue: _minPositionValue,
            minPositionETHValue: _minPositionETHValue,
            active: true
        }));

        emit LoanOfferCreated(
            offerId,
            msg.sender,
            effectivePrincipal,
            _aprBps,
            _duration,
            _collateralContract,
            _minPositionValue,
            _minPositionETHValue
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
        uint256 minPositionETHValue = offer.minPositionETHValue;

        // Validate collateral: check position value meets minimum
        ITegridyStaking staking = ITegridyStaking(collateralContract);
        (uint256 positionAmount,, uint256 lockEnd,,,) = staking.getPosition(_tokenId);
        if (positionAmount < minPositionValue) revert InsufficientCollateralValue();

        // AUDIT critique 5.4: Optional ETH-denominated collateral floor. Only applied
        // when the lender opts in (non-zero threshold). Uses TegridyPair spot reserves
        // — see `_positionETHValue` for the sandwich-manipulation caveat.
        if (minPositionETHValue > 0) {
            uint256 ethValue = _positionETHValue(positionAmount);
            if (ethValue < minPositionETHValue) revert InsufficientCollateralValue();
        }

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

        // AUDIT FIX M-7 (battle-tested): unlimited-gas .call replaced with WETHFallbackLib
        // (10k stipend + WETH wrap). Matches TegridyNFTLending.acceptOffer pattern and closes
        // the asymmetric reentrancy surface.
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, principal);

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
    /// @return minPositionValue The minimum collateral position value (TOWELI)
    /// @return minPositionETHValue Optional ETH-denominated collateral floor (0 = disabled)
    /// @return active Whether the offer is still active
    function getOffer(uint256 _offerId) external view returns (
        address lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue,
        uint256 minPositionETHValue,
        bool active
    ) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer memory o = offers[_offerId];
        return (
            o.lender,
            o.principal,
            o.aprBps,
            o.duration,
            o.collateralContract,
            o.minPositionValue,
            o.minPositionETHValue,
            o.active
        );
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
        // AUDIT FIX (300-agent #3 / battle-tested): OZ Math.mulDiv with Ceil rounding.
        // 512-bit intermediate removes the cap-ceiling overflow constraint that the
        // prior naive multiplication relied on. Ceil rounding preserves the
        // protocol-favoring invariant for ragged sub-second pro-rata fractions.
        interest = Math.mulDiv(
            _principal * _aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
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

    /// @notice Value a TOWELI amount in ETH at the TegridyPair's current spot reserves.
    /// @dev AUDIT critique 5.4 / SECURITY_DEFERRED: this reads instantaneous AMM
    ///      reserves — it IS sandwich-manipulable inside the same transaction. The
    ///      primary mitigations are the 2-hour min-loan-duration bound on how long
    ///      a manipulated price can persist before the position unlock matures, plus
    ///      the fact that the floor is lender-elected (zero = disabled). We will
    ///      replace this with a TWAP read once the V3 pool / oracle is live (see
    ///      docs/SECURITY_DEFERRED.md).
    /// @param toweliAmount Amount of TOWELI to value (18-decimal fixed-point).
    /// @return ETH-equivalent value, computed via `mulDiv(toweliAmount, wethReserve, toweliReserve)`.
    ///         Returns 0 if the TOWELI reserve is 0 (avoid division-by-zero).
    function _positionETHValue(uint256 toweliAmount) internal view returns (uint256) {
        (uint112 reserve0, uint112 reserve1, ) = ITegridyPair(pair).getReserves();
        // Resolve which reserve corresponds to TOWELI vs WETH. Orientation was fixed
        // at deploy time via `toweli` / `weth` immutables.
        (uint256 toweliReserve, uint256 wethReserve) = ITegridyPair(pair).token0() == toweli
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
        if (toweliReserve == 0) return 0;
        return Math.mulDiv(toweliAmount, wethReserve, toweliReserve);
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

    // ─── AUDIT TF-06: Timelocked Safety-Cap Adjustments ──────────────
    //
    // maxPrincipal / maxAprBps / minDuration / maxDuration are now admin-tunable
    // (via 48h timelock) so the protocol can scale with ETH price and market demand
    // without a full redeploy. Each has an absolute *_CEILING / *_FLOOR hard cap
    // declared at contract level — no admin can exceed it. Each setter uses the
    // existing TimelockAdmin pattern (propose → wait → execute).

    // maxPrincipal ------------------------------------------------------
    function proposeMaxPrincipal(uint256 _new) external onlyOwner {
        if (_new == 0) revert ZeroAmount();
        if (_new > MAX_PRINCIPAL_CEILING) revert InvalidCapValue();
        pendingMaxPrincipal = _new;
        _propose(MAX_PRINCIPAL_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxPrincipalProposed(_new, _executeAfter[MAX_PRINCIPAL_CHANGE]);
    }

    function executeMaxPrincipal() external onlyOwner {
        _execute(MAX_PRINCIPAL_CHANGE);
        uint256 old = maxPrincipal;
        maxPrincipal = pendingMaxPrincipal;
        pendingMaxPrincipal = 0;
        emit MaxPrincipalChanged(old, maxPrincipal);
    }

    function cancelMaxPrincipal() external onlyOwner {
        _cancel(MAX_PRINCIPAL_CHANGE);
        pendingMaxPrincipal = 0;
    }

    function maxPrincipalChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_PRINCIPAL_CHANGE];
    }

    // maxAprBps ---------------------------------------------------------
    function proposeMaxAprBps(uint256 _new) external onlyOwner {
        if (_new == 0) revert ZeroAmount();
        if (_new > MAX_APR_BPS_CEILING) revert InvalidCapValue();
        pendingMaxAprBps = _new;
        _propose(MAX_APR_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxAprBpsProposed(_new, _executeAfter[MAX_APR_CHANGE]);
    }

    function executeMaxAprBps() external onlyOwner {
        _execute(MAX_APR_CHANGE);
        uint256 old = maxAprBps;
        maxAprBps = pendingMaxAprBps;
        pendingMaxAprBps = 0;
        emit MaxAprBpsChanged(old, maxAprBps);
    }

    function cancelMaxAprBps() external onlyOwner {
        _cancel(MAX_APR_CHANGE);
        pendingMaxAprBps = 0;
    }

    function maxAprBpsChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_APR_CHANGE];
    }

    // minDuration -------------------------------------------------------
    function proposeMinDuration(uint256 _new) external onlyOwner {
        if (_new < MIN_DURATION_FLOOR || _new > MIN_DURATION_CEILING) revert InvalidCapValue();
        if (_new >= maxDuration) revert InvalidCapValue();
        pendingMinDuration = _new;
        _propose(MIN_DURATION_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MinDurationProposed(_new, _executeAfter[MIN_DURATION_CHANGE]);
    }

    function executeMinDuration() external onlyOwner {
        _execute(MIN_DURATION_CHANGE);
        uint256 old = minDuration;
        minDuration = pendingMinDuration;
        pendingMinDuration = 0;
        emit MinDurationChanged(old, minDuration);
    }

    function cancelMinDuration() external onlyOwner {
        _cancel(MIN_DURATION_CHANGE);
        pendingMinDuration = 0;
    }

    function minDurationChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_DURATION_CHANGE];
    }

    // maxDuration -------------------------------------------------------
    function proposeMaxDuration(uint256 _new) external onlyOwner {
        if (_new > MAX_DURATION_CEILING) revert InvalidCapValue();
        if (_new <= minDuration) revert InvalidCapValue();
        pendingMaxDuration = _new;
        _propose(MAX_DURATION_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxDurationProposed(_new, _executeAfter[MAX_DURATION_CHANGE]);
    }

    function executeMaxDuration() external onlyOwner {
        _execute(MAX_DURATION_CHANGE);
        uint256 old = maxDuration;
        maxDuration = pendingMaxDuration;
        pendingMaxDuration = 0;
        emit MaxDurationChanged(old, maxDuration);
    }

    function cancelMaxDuration() external onlyOwner {
        _cancel(MAX_DURATION_CHANGE);
        pendingMaxDuration = 0;
    }

    function maxDurationChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_DURATION_CHANGE];
    }

    // ─── Pausable ────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── AUDIT C7: Timelocked Origination Fee ────────────────────────
    function proposeOriginationFee(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_ORIGINATION_FEE_BPS) revert OriginationFeeTooHigh();
        pendingOriginationFeeBps = _newBps;
        _propose(ORIGINATION_FEE_CHANGE, CAP_CHANGE_TIMELOCK);
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

    // ─── AUDIT H14: Timelocked Min APR ───────────────────────────────
    function proposeMinApr(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_MIN_APR_BPS) revert MinAprTooHigh();
        // Don't allow min > max — would brick createLoanOffer.
        require(_newBps <= maxAprBps, "MIN_EXCEEDS_MAX");
        pendingMinAprBps = _newBps;
        _propose(MIN_APR_CHANGE, CAP_CHANGE_TIMELOCK);
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
