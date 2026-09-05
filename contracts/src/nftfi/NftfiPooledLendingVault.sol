// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC4626} from "solady/tokens/ERC4626.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {SafeERC721Call} from "../lib/SafeERC721Call.sol";

/// @title  NftfiPooledLendingVault — one ERC-4626 WETH pool per NFT collection
/// @notice Pooled lending against a single collection, sitting alongside the
///         existing peer-to-peer desk rather than replacing it.
///
/// @dev ISOLATION IS THE ARCHITECTURE, NOT A SETTING.
///      `collection` is immutable and one vault holds one collection's book.
///      There is no cross-vault call, no shared accounting contract and no
///      registry a vault reads at runtime, so a total loss on one collection
///      can reach exactly the depositors who chose that collection. Anything
///      that made two collections share a balance sheet would have to add a
///      contract that does not exist here.
///
/// @dev SHARE MATH IS NOT OURS. Deposit / mint / withdraw / redeem / preview
///      and the virtual-share inflation defence are Solady's `ERC4626`,
///      vendored at pinned commit acd959aa4bd04720d640bf4e6a5c71037510cc4b
///      (v0.1.26) under contracts/lib/solady and unmodified. Only `totalAssets`,
///      the two `max*` liquidity ceilings and the deposit cap are overridden,
///      and each override narrows what the base would allow — none widens it.
///
/// @dev ⚠ BESPOKE CORE MATH ON A MONEY PATH — READ BEFORE ANY DEPLOY.
///      `_accrue` is written here, not forked: simple (non-compounding)
///      interest, `principal × aprBps × elapsed / (365 days × 10_000)`,
///      checkpointed on every balance-changing touch of a loan. Nothing in
///      this repo's vendored set implements a per-loan accrual clock, so
///      there was nothing to fork. It is the one piece of arithmetic on this
///      contract's money path that has not been battle-tested elsewhere and
///      it must carry its own adversarial audit wave before an address for
///      this contract is written anywhere.
///
/// @dev COLLATERAL IS PULLED WITH THIS VAULT'S OWN APPROVAL AND NOTHING ELSE.
///      The marketplace's Seaport conduit approval MUST NOT be reachable from
///      here. A listing approval is a standing permission to move a token in
///      exchange for a price the owner signed; a collateral approval is a
///      standing permission to move it for no price at all. This contract
///      takes no conduit, no operator and no order parameters — it calls
///      `transferFrom` on `collection` directly, so the only approval it can
///      spend is one the owner granted to this address.
///
/// @dev VALUATION IS PUSHED, AND STALE MEANS CLOSED. `floorWei` is the
///      sanitized native floor (price-capped, ETH-only, bundles excluded) as
///      published by the operator. There is no keeper and no on-chain oracle,
///      so the floor goes stale on its own and `borrow` fails closed the
///      moment it does. A stale floor never quotes a smaller loan — it quotes
///      no loan.
///
/// @dev NOT DEPLOYED. No address for this contract exists in any constants
///      file, the fee dials below start at zero, and `feeRecipient` being the
///      zero address makes raising them revert.
contract NftfiPooledLendingVault is ERC4626, OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeTransferLib for address;
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: too many concurrent loans would make
    // the seizable-loan scan (which gates deposit/withdraw) unbounded.
    error TooManyActiveLoans();
    error NotContract();
    error NotBorrower();
    error UnknownLoan();
    error LoanClosed();
    error LoanNotSeizable();
    error LoanNotSeized();
    error FloorStale();
    error FloorUnset();
    error PrincipalTooSmall();
    error PrincipalAboveMax();
    error InsufficientLiquidity();
    error NotCollateralOwner();
    error CollateralTransferFailed();
    error TokenAlreadyEscrowed();
    error FeeRecipientUnset();
    error ParamOutOfRange();
    error NothingToRepay();
    error NotLiquidationSink();

    // ─── Immutables ──────────────────────────────────────────────────

    /// @notice The WETH-shaped ERC20 every loan, repayment and fee is denominated in.
    address internal immutable _asset;

    /// @notice The one ERC721 this pool will ever accept. See ISOLATION above.
    address public immutable collection;

    /// @notice Where the origination and interest fees go. Zero disables both
    ///         dials permanently for this deployment — see `setFees`.
    address public immutable feeRecipient;

    // ─── Bounds ──────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;
    /// @dev A pool that lends more than half of a pushed floor against an
    ///      asset with this liquidity profile is not a lending product.
    uint256 public constant MAX_LTV_BPS = 5_000;
    uint256 public constant MAX_APR_BPS = 20_000;
    uint256 public constant MAX_ORIGINATION_FEE_BPS = 100;
    uint256 public constant MAX_INTEREST_FEE_BPS = 2_000;
    uint256 public constant MIN_LOAN_DURATION = 1 days;
    uint256 public constant MAX_LOAN_DURATION = 365 days;
    /// @dev Dust loans round their interest to zero and turn the pool into a
    ///      free flash-loan of its own collateral escrow.
    uint256 public constant MIN_PRINCIPAL = 0.01 ether;
    /// @dev How long a pushed floor is allowed to be believed. Past this the
    ///      borrow path is closed, not merely conservative.
    uint256 public constant FLOOR_MAX_AGE = 6 hours;
    /// @dev Breathing room between a missed deadline and an irreversible
    ///      seizure, matching the P2P desk's grace posture.
    uint256 public constant SEIZE_GRACE = 1 hours;
    /// @dev AUDIT FIX 2026-08-27 [SEIZURE-RACE]: hard bound on concurrent active
    ///      loans. The deposit/withdraw freeze scans active loans for any that are
    ///      seizable-but-unseized; this caps that scan so the gate can never be
    ///      griefed into an out-of-gas DoS. Generous for a single-collection pool.
    uint256 public constant MAX_ACTIVE_LOANS = 256;

    // ─── Loan book ───────────────────────────────────────────────────

    struct Loan {
        address borrower;
        /// @notice Who receives anything left after a liquidation clears the
        ///         debt. Set at draw time; for a financed purchase this is the
        ///         buyer, never the contract that fronted the draw.
        address surplusRecipient;
        uint256 tokenId;
        /// @notice Outstanding principal. Falls as repayments land.
        uint256 principal;
        /// @notice Interest accrued and not yet paid, as of `lastAccrualAt`.
        uint256 accruedInterest;
        uint256 aprBps;
        uint64 lastAccrualAt;
        uint64 deadline;
        bool closed;
        bool seized;
    }

    Loan[] public loans;

    /// @notice tokenId → loanId+1 while the token sits in escrow. The +1 keeps
    ///         loan 0 distinguishable from "not escrowed" without a second map.
    mapping(uint256 => uint256) public escrowedLoanIdPlus1;

    /// @notice Principal the pool believes it will get back. Counted in
    ///         `totalAssets`.
    uint256 public principalOutstanding;

    /// @notice AUDIT FIX 2026-08-27 [SEIZURE-RACE]: the set of loanIds that are
    ///         open (neither closed nor seized). Bounded by `MAX_ACTIVE_LOANS`.
    ///         `_hasSeizableLoan` scans this to freeze deposit/withdraw while any
    ///         loan is past `deadline + SEIZE_GRACE` and unseized — otherwise
    ///         `totalAssets` still counts that defaulted loan at par and an
    ///         informed LP could redeem at the stale price, dumping the pending
    ///         writedown on the LPs who stay. `seize` (permissionless once
    ///         seizable) removes the loan here and recognizes the loss in
    ///         `totalAssets`, clearing the freeze. See
    ///         docs/NFTFI_VAULT_SEIZURE_RACE_2026_08_27.md.
    EnumerableSetLib.Uint256Set private _activeLoans;

    /// @notice Principal behind seized collateral. Written OFF the balance
    ///         sheet at seizure and written back only by realized proceeds:
    ///         a share price must never include an NFT nobody has sold.
    uint256 public seizedPrincipal;

    // ─── Dials ───────────────────────────────────────────────────────

    uint256 public ltvBps = 3_000;
    uint256 public aprBps = 1_500;
    uint256 public loanDuration = 30 days;
    /// @notice Zero at construction and not raisable while `feeRecipient` is
    ///         the zero address.
    uint256 public originationFeeBps;
    /// @notice Share of paid interest taken as venue revenue. Zero at
    ///         construction, same gate as above.
    uint256 public interestFeeBps;

    /// @notice Ceiling on pool size while this collection has no liquidation
    ///         history. Not a promise about demand — a cap on exposure.
    uint256 public depositCapWei;

    /// @notice The address seized collateral is handed to for sale, and the
    ///         only address allowed to report proceeds back. Zero means
    ///         seizure is closed: nothing can be taken that has nowhere to go.
    address public liquidationSink;

    // ─── Pushed valuation ────────────────────────────────────────────

    uint256 public floorWei;
    uint64 public floorUpdatedAt;

    // ─── Events ──────────────────────────────────────────────────────

    event FloorPushed(uint256 floorWei, uint64 at);
    event Borrowed(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 tokenId,
        uint256 principal,
        uint256 originationFee,
        uint64 deadline
    );
    event Repaid(uint256 indexed loanId, uint256 interestPaid, uint256 principalPaid, uint256 interestFee);
    event LoanClosedOut(uint256 indexed loanId, address indexed collateralTo);
    event Seized(uint256 indexed loanId, address indexed sink, uint256 writtenDown);
    event SeizureSettled(uint256 indexed loanId, uint256 proceeds, uint256 recovered, uint256 surplus);
    event FeesSet(uint256 originationFeeBps, uint256 interestFeeBps);
    event TermsSet(uint256 ltvBps, uint256 aprBps, uint256 loanDuration);
    event DepositCapSet(uint256 capWei);
    event LiquidationSinkSet(address indexed sink);

    // ─── Construction ────────────────────────────────────────────────

    constructor(
        address weth_,
        address collection_,
        address feeRecipient_,
        uint256 depositCapWei_,
        address owner_
    ) OwnableNoRenounce(owner_) {
        if (weth_ == address(0) || collection_ == address(0)) revert ZeroAddress();
        if (weth_.code.length == 0 || collection_.code.length == 0) revert NotContract();
        _asset = weth_;
        collection = collection_;
        // Deliberately allowed to be zero: a deployment with no fee recipient
        // is a deployment whose fee dials can never leave zero.
        feeRecipient = feeRecipient_;
        depositCapWei = depositCapWei_;
        emit DepositCapSet(depositCapWei_);
    }

    // ─── ERC-4626 surface ────────────────────────────────────────────

    function asset() public view override returns (address) {
        return _asset;
    }

    function name() public pure override returns (string memory) {
        return "Tegridy Pooled NFT Lending";
    }

    function symbol() public pure override returns (string memory) {
        return "tPOOL";
    }

    /// @dev Solady's documented inflation-attack mitigation. Six is the offset
    ///      OpenZeppelin v5 and Solady both use as the reference value.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @notice Idle WETH plus principal the pool still expects back.
    /// @dev    Three things are deliberately NOT in here, and each omission is
    ///         the honest reading rather than a conservative one:
    ///         accrued-but-unpaid interest (the pool has not earned it until a
    ///         borrower pays it), `seizedPrincipal` (there is an NFT, not an
    ///         asset, until someone sells it), and any notion of collateral
    ///         value (this contract cannot price an NFT and does not pretend
    ///         to). The share price therefore moves only on realized cash.
    function totalAssets() public view override returns (uint256) {
        return _asset.balanceOf(address(this)) + principalOutstanding;
    }

    /// @dev Withdrawals are bounded by cash actually sitting here. Lent-out
    ///      principal is not withdrawable and the ceiling says so rather than
    ///      letting the base contract revert on a transfer that cannot settle.
    /// @notice AUDIT FIX 2026-08-27 [SEIZURE-RACE]: true iff some open loan is past
    ///         `deadline + SEIZE_GRACE` and not yet seized — a default whose
    ///         writedown `totalAssets` has NOT recognized (it still counts the loan
    ///         at par). While true, deposits and withdrawals are frozen so nobody
    ///         transacts at the stale par NAV: an informed LP could otherwise redeem
    ///         at par and dump the pending loss on the LPs who stay. Anyone can clear
    ///         the freeze by calling the permissionless `seize` on the overdue
    ///         loan(s), which recognizes the loss and lets everyone exit at the
    ///         correct, shared price. Scan is O(active loans), bounded by
    ///         MAX_ACTIVE_LOANS. See docs/NFTFI_VAULT_SEIZURE_RACE_2026_08_27.md.
    function hasSeizableLoan() public view returns (bool) {
        uint256[] memory ids = _activeLoans.values();
        uint256 n = ids.length;
        for (uint256 i; i < n; ++i) {
            Loan storage loan = loans[ids[i]];
            if (!loan.seized && !loan.closed && block.timestamp > uint256(loan.deadline) + SEIZE_GRACE) {
                return true;
            }
        }
        return false;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: no exit at the stale par NAV.
        if (hasSeizableLoan()) return 0;
        uint256 byShares = super.maxWithdraw(owner_);
        uint256 idle = _asset.balanceOf(address(this));
        return byShares < idle ? byShares : idle;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: no exit at the stale par NAV.
        if (hasSeizableLoan()) return 0;
        uint256 byShares = super.maxRedeem(owner_);
        uint256 idleAsShares = convertToShares(_asset.balanceOf(address(this)));
        return byShares < idleAsShares ? byShares : idleAsShares;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: no entry at the stale par NAV either
        // (a depositor would overpay into an unrecognized loss). Cleared by `seize`.
        if (hasSeizableLoan()) return 0;
        uint256 assets = totalAssets();
        return assets >= depositCapWei ? 0 : depositCapWei - assets;
    }

    function maxMint(address to) public view override returns (uint256) {
        return convertToShares(maxDeposit(to));
    }

    // ─── Valuation push ──────────────────────────────────────────────

    /// @notice Publish the sanitized native floor for this collection.
    /// @dev    The value is expected to come from the venue's own order book
    ///         (price-capped, ETH-only, bundles excluded), never from raw
    ///         third-party marketplace data. Nothing on-chain can verify that
    ///         provenance, which is exactly why the freshness window exists:
    ///         the worst an unattended pool can do is stop lending.
    function pushFloor(uint256 newFloorWei) external onlyOwner {
        floorWei = newFloorWei;
        floorUpdatedAt = uint64(block.timestamp);
        emit FloorPushed(newFloorWei, uint64(block.timestamp));
    }

    /// @notice The largest principal the pool would lend right now, or zero.
    /// @dev    Zero is returned for every closed-path reason — stale floor,
    ///         unset floor, paused, no liquidity. A caller rendering this must
    ///         not read zero as "the floor is zero"; ask `floorStatus`.
    function maxPrincipal() public view returns (uint256) {
        if (paused()) return 0;
        if (floorWei == 0 || floorUpdatedAt == 0) return 0;
        if (block.timestamp > uint256(floorUpdatedAt) + FLOOR_MAX_AGE) return 0;
        uint256 byFloor = (floorWei * ltvBps) / BPS;
        uint256 idle = _asset.balanceOf(address(this));
        return byFloor < idle ? byFloor : idle;
    }

    /// @notice Why `maxPrincipal` is what it is, so a surface can say which.
    /// @return hasFloor       A floor has ever been pushed.
    /// @return fresh          That floor is inside `FLOOR_MAX_AGE`.
    /// @return ageSeconds     How old it is; meaningless when `hasFloor` is false.
    function floorStatus() external view returns (bool hasFloor, bool fresh, uint256 ageSeconds) {
        hasFloor = floorUpdatedAt != 0;
        if (!hasFloor) return (false, false, 0);
        ageSeconds = block.timestamp - uint256(floorUpdatedAt);
        fresh = ageSeconds <= FLOOR_MAX_AGE;
    }

    // ─── Borrow ──────────────────────────────────────────────────────

    /// @notice Escrow one token from this collection and draw WETH against it.
    /// @param tokenId          The collateral. Caller must own it and must have
    ///                         approved THIS address — see the conduit note in
    ///                         the contract header.
    /// @param requestedWei     Principal wanted, before the origination fee.
    /// @param surplusRecipient Who gets anything above the debt if this loan is
    ///                         ever liquidated. Zero defaults to the borrower.
    function borrow(uint256 tokenId, uint256 requestedWei, address surplusRecipient)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        if (floorUpdatedAt == 0 || floorWei == 0) revert FloorUnset();
        if (block.timestamp > uint256(floorUpdatedAt) + FLOOR_MAX_AGE) revert FloorStale();
        if (escrowedLoanIdPlus1[tokenId] != 0) revert TokenAlreadyEscrowed();

        uint256 ceiling = (floorWei * ltvBps) / BPS;
        if (requestedWei > ceiling) revert PrincipalAboveMax();
        if (requestedWei < MIN_PRINCIPAL) revert PrincipalTooSmall();
        if (requestedWei > _asset.balanceOf(address(this))) revert InsufficientLiquidity();

        (bool okOwner, address holder) = SafeERC721Call.safeOwnerOfBounded(collection, tokenId);
        if (!okOwner || holder != msg.sender) revert NotCollateralOwner();

        loanId = loans.length;
        uint64 deadline = uint64(block.timestamp + loanDuration);
        loans.push(
            Loan({
                borrower: msg.sender,
                surplusRecipient: surplusRecipient == address(0) ? msg.sender : surplusRecipient,
                tokenId: tokenId,
                principal: requestedWei,
                accruedInterest: 0,
                aprBps: aprBps,
                lastAccrualAt: uint64(block.timestamp),
                deadline: deadline,
                closed: false,
                seized: false
            })
        );
        escrowedLoanIdPlus1[tokenId] = loanId + 1;
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: record the open loan (bounded) so
        // the deposit/withdraw freeze can scan for seizable defaults in O(active).
        if (_activeLoans.length() >= MAX_ACTIVE_LOANS) revert TooManyActiveLoans();
        // SLITHER 2026-08-30: loanId = loans.length is monotonically fresh, so add() cannot
        // return false; the bool is deliberately ignored
        // slither-disable-next-line unused-return
        _activeLoans.add(loanId);
        principalOutstanding += requestedWei;

        // Pull collateral BEFORE paying out, and verify the pull actually moved
        // the token: a collection that no-ops `transferFrom` would otherwise
        // hand out an unsecured loan.
        bool moved = SafeERC721Call.safeTransferFromBounded(collection, msg.sender, address(this), tokenId);
        if (!moved) revert CollateralTransferFailed();
        (bool okAfter, address nowHolder) = SafeERC721Call.safeOwnerOfBounded(collection, tokenId);
        if (!okAfter || nowHolder != address(this)) revert CollateralTransferFailed();

        uint256 fee = (requestedWei * originationFeeBps) / BPS;
        if (fee != 0) _asset.safeTransfer(feeRecipient, fee);
        _asset.safeTransfer(msg.sender, requestedWei - fee);

        emit Borrowed(loanId, msg.sender, tokenId, requestedWei, fee, deadline);
    }

    // ─── Repay ───────────────────────────────────────────────────────

    /// @notice Pay down a loan. Interest first, then principal.
    /// @dev    Anyone may pay — a financed-purchase contract paying on a
    ///         buyer's behalf is the intended second caller — but only the
    ///         borrower's own record is credited, and the collateral only ever
    ///         returns to `loan.borrower`.
    /// @dev    CLAMPS, DOES NOT REVERT. `amount` above the debt is trimmed to
    ///         the debt and only the trimmed `paid` is pulled, so this function
    ///         can silently apply less than it was handed and `paid` is the
    ///         only signal that it did. A caller that sized an exact payment
    ///         MUST compare `paid` against what it sent — as
    ///         `NftfiBnpl.payInstalment` does — rather than discard it.
    function repay(uint256 loanId, uint256 amount) external nonReentrant returns (uint256 paid) {
        Loan storage loan = _liveLoan(loanId);
        if (amount == 0) revert NothingToRepay();
        _accrue(loan);

        uint256 due = loan.accruedInterest + loan.principal;
        paid = amount > due ? due : amount;
        _asset.safeTransferFrom(msg.sender, address(this), paid);

        uint256 interestPaid = paid > loan.accruedInterest ? loan.accruedInterest : paid;
        uint256 principalPaid = paid - interestPaid;
        loan.accruedInterest -= interestPaid;
        loan.principal -= principalPaid;
        principalOutstanding -= principalPaid;

        uint256 interestFee = (interestPaid * interestFeeBps) / BPS;
        if (interestFee != 0) _asset.safeTransfer(feeRecipient, interestFee);

        emit Repaid(loanId, interestPaid, principalPaid, interestFee);

        if (loan.principal == 0 && loan.accruedInterest == 0) {
            _closeAndRelease(loanId, loan, loan.borrower);
        }
    }

    /// @notice What clearing this loan costs at this moment.
    /// @return principal Outstanding principal.
    /// @return interest  Interest accrued through now, including the unposted
    ///                   slice since the last checkpoint.
    function quoteRepay(uint256 loanId) public view returns (uint256 principal, uint256 interest) {
        Loan storage loan = loans[loanId];
        principal = loan.principal;
        interest = loan.accruedInterest + _pendingInterest(loan);
    }

    // ─── Seizure and settlement ──────────────────────────────────────

    /// @notice Hand defaulted collateral to the liquidation sink.
    /// @dev    NO KEEPER RUNS HERE. This is permissionless and it is also
    ///         entirely unscheduled: if nobody calls it, an overdue loan stays
    ///         overdue and the pool keeps carrying it. Nothing in this repo
    ///         will call it on a timer, and any surface that implies otherwise
    ///         is lying about the venue's operations.
    function seize(uint256 loanId) external nonReentrant {
        Loan storage loan = _liveLoan(loanId);
        if (block.timestamp <= uint256(loan.deadline) + SEIZE_GRACE) revert LoanNotSeizable();
        _seize(loanId, loan);
    }

    /// @notice The borrower hands the collateral over instead of repaying.
    /// @dev    The one path that does not wait for `deadline`, because it needs
    ///         no judgement about whether a default happened: only the borrower
    ///         can call it, and only about their own collateral. It exists so a
    ///         contract that borrows on someone's behalf can wind a position
    ///         down on its own schedule without this vault having to learn what
    ///         that schedule is. Surplus still goes to `surplusRecipient`.
    function surrender(uint256 loanId) external nonReentrant {
        Loan storage loan = _liveLoan(loanId);
        if (msg.sender != loan.borrower) revert NotBorrower();
        _seize(loanId, loan);
    }

    /// @notice Report what the seized collateral actually sold for.
    /// @dev    The sink pushes WETH and this splits it: the pool is made whole
    ///         first, and every wei above the debt goes to the loan's
    ///         `surplusRecipient`. The pool keeping the upside on someone
    ///         else's collateral would be the dishonest version of this
    ///         function, and there is no dial that turns it into that.
    ///         A shortfall is simply a loss the depositors already took at
    ///         seizure — nothing here writes it back.
    function settleSeizure(uint256 loanId, uint256 proceeds) external nonReentrant {
        if (loanId >= loans.length) revert UnknownLoan();
        Loan storage loan = loans[loanId];
        if (!loan.seized) revert LoanNotSeized();
        if (loan.closed) revert LoanClosed();
        if (msg.sender != liquidationSink) revert NotLiquidationSink();

        _asset.safeTransferFrom(msg.sender, address(this), proceeds);

        uint256 debt = loan.principal + loan.accruedInterest;
        uint256 recovered = proceeds > debt ? debt : proceeds;
        uint256 surplus = proceeds - recovered;

        seizedPrincipal -= loan.principal;
        loan.principal = 0;
        loan.accruedInterest = 0;
        loan.closed = true;

        if (surplus != 0) _asset.safeTransfer(loan.surplusRecipient, surplus);

        emit SeizureSettled(loanId, proceeds, recovered, surplus);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    /// @notice Utilisation in bps, or zero when the pool is empty.
    function utilisationBps() external view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        return (principalOutstanding * BPS) / assets;
    }

    // ─── Admin dials ─────────────────────────────────────────────────

    function setTerms(uint256 newLtvBps, uint256 newAprBps, uint256 newDuration) external onlyOwner {
        if (newLtvBps > MAX_LTV_BPS) revert ParamOutOfRange();
        if (newAprBps > MAX_APR_BPS) revert ParamOutOfRange();
        if (newDuration < MIN_LOAN_DURATION || newDuration > MAX_LOAN_DURATION) revert ParamOutOfRange();
        ltvBps = newLtvBps;
        aprBps = newAprBps;
        loanDuration = newDuration;
        emit TermsSet(newLtvBps, newAprBps, newDuration);
    }

    /// @dev Both dials ship at zero. Raising either requires a `feeRecipient`
    ///      chosen at construction and never changeable, so a fee can only
    ///      ever go to the address the deploy transaction named.
    function setFees(uint256 newOriginationFeeBps, uint256 newInterestFeeBps) external onlyOwner {
        if (newOriginationFeeBps > MAX_ORIGINATION_FEE_BPS) revert ParamOutOfRange();
        if (newInterestFeeBps > MAX_INTEREST_FEE_BPS) revert ParamOutOfRange();
        if ((newOriginationFeeBps != 0 || newInterestFeeBps != 0) && feeRecipient == address(0)) {
            revert FeeRecipientUnset();
        }
        originationFeeBps = newOriginationFeeBps;
        interestFeeBps = newInterestFeeBps;
        emit FeesSet(newOriginationFeeBps, newInterestFeeBps);
    }

    function setDepositCap(uint256 capWei) external onlyOwner {
        depositCapWei = capWei;
        emit DepositCapSet(capWei);
    }

    function setLiquidationSink(address sink) external onlyOwner {
        liquidationSink = sink;
        emit LiquidationSinkSet(sink);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internals ───────────────────────────────────────────────────

    function _liveLoan(uint256 loanId) private view returns (Loan storage loan) {
        if (loanId >= loans.length) revert UnknownLoan();
        loan = loans[loanId];
        if (loan.closed || loan.seized) revert LoanClosed();
    }

    /// @dev See the BESPOKE CORE MATH warning in the contract header.
    function _pendingInterest(Loan storage loan) private view returns (uint256) {
        if (loan.principal == 0) return 0;
        uint256 elapsed = block.timestamp - uint256(loan.lastAccrualAt);
        // SLITHER 2026-08-30: same-block short-circuit; the interest term is exactly zero at
        // elapsed == 0 either way, this only skips the math
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return 0;
        return (loan.principal * loan.aprBps * elapsed) / (365 days * BPS);
    }

    function _seize(uint256 loanId, Loan storage loan) private {
        if (liquidationSink == address(0)) revert NotLiquidationSink();
        _accrue(loan);
        uint256 writtenDown = loan.principal;
        loan.seized = true;
        principalOutstanding -= writtenDown;
        seizedPrincipal += writtenDown;
        escrowedLoanIdPlus1[loan.tokenId] = 0;
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: the loss is now recognized in
        // totalAssets (principalOutstanding fell); drop it from the active set so
        // it no longer freezes deposit/withdraw.
        // SLITHER 2026-08-30: one-shot transition — the seized flag + _liveLoan gate make a
        // second seize unreachable, so membership is guaranteed and the bool carries no signal
        // slither-disable-next-line unused-return
        _activeLoans.remove(loanId);

        bool moved = SafeERC721Call.safeTransferFromBounded(collection, address(this), liquidationSink, loan.tokenId);
        if (!moved) revert CollateralTransferFailed();

        emit Seized(loanId, liquidationSink, writtenDown);
    }

    function _accrue(Loan storage loan) private {
        uint256 pending = _pendingInterest(loan);
        if (pending != 0) loan.accruedInterest += pending;
        loan.lastAccrualAt = uint64(block.timestamp);
    }

    function _closeAndRelease(uint256 loanId, Loan storage loan, address to) private {
        loan.closed = true;
        escrowedLoanIdPlus1[loan.tokenId] = 0;
        // AUDIT FIX 2026-08-27 [SEIZURE-RACE]: fully repaid — drop from the active
        // set so a late-but-cured loan stops freezing deposit/withdraw.
        // SLITHER 2026-08-30: one-shot transition — the closed flag + _liveLoan gate make a
        // second close unreachable, so membership is guaranteed and the bool carries no signal
        // slither-disable-next-line unused-return
        _activeLoans.remove(loanId);
        bool moved = SafeERC721Call.safeTransferFromBounded(collection, address(this), to, loan.tokenId);
        if (!moved) revert CollateralTransferFailed();
        emit LoanClosedOut(loanId, to);
    }
}
