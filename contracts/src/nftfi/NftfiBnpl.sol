// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {SafeERC721Call} from "../lib/SafeERC721Call.sol";
import {NftfiPooledLendingVault} from "./NftfiPooledLendingVault.sol";

/// @title  NftfiBnpl — instalments at the point of sale
/// @notice A buyer puts a deposit down, the pool fronts the rest, the seller is
///         paid in full immediately, and the token sits in escrow until the
///         plan is cleared.
///
/// @dev THIS IS NOT A SEAPORT FILL AND MUST NEVER BECOME ONE.
///      The marketplace's buy paths bind the paying wallet to the connected
///      wallet on every route, which is correct and is not something a flag
///      should be able to switch off. A financed purchase has a genuinely
///      different shape — a contract pays, a buyer signs — so it gets its own
///      settlement path here instead of an exemption over there. There is no
///      order struct, no signature, no conduit and no `call` to an external
///      exchange anywhere in this file: the seller states an on-chain intent,
///      the buyer accepts it, and the two legs move against approvals granted
///      to this address alone. That also means the listing approval a seller
///      grants the marketplace can never be spent here.
///
/// @dev ESCROW LIVES IN THE VAULT, NOT HERE. This contract borrows from
///      `NftfiPooledLendingVault` in its own name and the vault holds the
///      token exactly as it holds any other borrower's collateral. One escrow,
///      one liquidation path, one place to audit — rather than a second copy of
///      the same machinery that could drift from it.
///
/// @dev THE BUYER IS THE SURPLUS RECIPIENT ON THE VAULT LOAN. If a plan is
///      forfeited, the vault sells the token, takes what it is owed, and pays
///      anything left DIRECTLY to the buyer without this contract touching it.
///      Instalments already paid reduce the vault debt, so a buyer's equity is
///      inside the surplus rather than lost ahead of it.
///
/// @dev NO KEEPER RUNS ANYWHERE IN THIS REPO. `forfeit` is permissionless and
///      unscheduled. A missed instalment does not do anything by itself; it
///      only makes `forfeit` callable. Nothing sweeps overdue plans on a timer
///      and no surface may imply that something will.
///
/// @dev NOT DEPLOYED. `saleFeeBps` is zero and cannot be raised while
///      `feeRecipient` is the zero address.
contract NftfiBnpl is OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeTransferLib for address;

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error NotContract();
    error VaultCollectionMismatch();
    error UnknownListing();
    error ListingInactive();
    error ListingExpired();
    error NotSeller();
    error PriceTooSmall();
    error BadExpiry();
    error SellerNoLongerOwns();
    error CollateralTransferFailed();
    error UnknownPlan();
    error PlanClosed();
    error PlanCurrent();
    error VaultTermTooShort();
    error ParamOutOfRange();
    error FeeRecipientUnset();
    error SelfPurchase();
    error RepayShortApplied();

    // ─── Immutables ──────────────────────────────────────────────────

    address internal immutable _weth;
    /// @notice The pool that fronts the financed leg. Immutable: a BNPL desk
    ///         that could be re-pointed at another pool after sellers had
    ///         approved it would be a different product each week.
    NftfiPooledLendingVault public immutable vault;
    /// @notice The one collection this desk finances — the vault's collection,
    ///         read at construction so the two can never disagree.
    address public immutable collection;
    address public immutable feeRecipient;

    // ─── Schedule ────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;
    /// @notice Deposit, then this many further payments.
    uint256 public constant INSTALMENTS = 3;
    uint256 public constant INSTALMENT_INTERVAL = 30 days;
    /// @notice Total plan length. The vault loan must outlast it.
    uint256 public constant PLAN_DURATION = INSTALMENTS * INSTALMENT_INTERVAL;
    /// @notice Slack after a due date before the plan can be forfeited.
    uint256 public constant PAYMENT_GRACE = 3 days;
    uint256 public constant MIN_DEPOSIT_BPS = 2_000;
    uint256 public constant MAX_DEPOSIT_BPS = 8_000;
    uint256 public constant MAX_SALE_FEE_BPS = 100;
    uint256 public constant MIN_PRICE = 0.05 ether;
    uint256 public constant MAX_LISTING_VALIDITY = 30 days;

    // ─── Dials ───────────────────────────────────────────────────────

    uint256 public depositBps = 2_500;
    /// @notice Venue fee on a financed sale, paid out of the seller's proceeds.
    ///         Ships at zero.
    uint256 public saleFeeBps;

    // ─── Books ───────────────────────────────────────────────────────

    struct Listing {
        address seller;
        uint256 tokenId;
        uint256 priceWei;
        uint64 expiry;
        bool active;
    }

    struct Plan {
        address buyer;
        address seller;
        uint256 tokenId;
        uint256 priceWei;
        /// @notice The slice of `priceWei` the pool fronted.
        uint256 financedWei;
        /// @notice Principal each of the `INSTALMENTS` payments retires.
        uint256 principalPerInstalment;
        uint256 loanId;
        uint64 startedAt;
        /// @notice How many of the `INSTALMENTS` have been paid.
        uint8 instalmentsPaid;
        bool settled;
        bool forfeited;
    }

    Listing[] public listings;
    Plan[] public plans;

    // ─── Events ──────────────────────────────────────────────────────

    event Listed(uint256 indexed listingId, address indexed seller, uint256 tokenId, uint256 priceWei, uint64 expiry);
    event ListingCancelled(uint256 indexed listingId);
    event PlanOpened(
        uint256 indexed planId,
        uint256 indexed listingId,
        address indexed buyer,
        uint256 loanId,
        uint256 depositWei,
        uint256 financedWei,
        uint256 saleFee
    );
    event InstalmentPaid(uint256 indexed planId, uint8 instalmentNumber, uint256 amountWei);
    event PlanSettled(uint256 indexed planId, address indexed buyer);
    event PlanForfeited(uint256 indexed planId, address indexed buyer);
    event DepositBpsSet(uint256 depositBps);
    event SaleFeeSet(uint256 saleFeeBps);

    // ─── Construction ────────────────────────────────────────────────

    constructor(address weth_, address vault_, address feeRecipient_, address owner_) OwnableNoRenounce(owner_) {
        if (weth_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        if (weth_.code.length == 0 || vault_.code.length == 0) revert NotContract();
        _weth = weth_;
        vault = NftfiPooledLendingVault(vault_);
        collection = NftfiPooledLendingVault(vault_).collection();
        if (NftfiPooledLendingVault(vault_).asset() != weth_) revert VaultCollectionMismatch();
        feeRecipient = feeRecipient_;
    }

    // ─── Seller side ─────────────────────────────────────────────────

    /// @notice Offer one token for instalment purchase at a fixed price.
    /// @dev    The seller must approve THIS address for the token. That
    ///         approval is granted for this purpose and spendable only by the
    ///         `openPlan` below, which pays the seller in the same transaction
    ///         it takes the token.
    function list(uint256 tokenId, uint256 priceWei, uint64 expiry)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 listingId)
    {
        if (priceWei < MIN_PRICE) revert PriceTooSmall();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_LISTING_VALIDITY) revert BadExpiry();
        (bool ok, address holder) = SafeERC721Call.safeOwnerOfBounded(collection, tokenId);
        if (!ok || holder != msg.sender) revert NotSeller();

        listingId = listings.length;
        listings.push(Listing({seller: msg.sender, tokenId: tokenId, priceWei: priceWei, expiry: expiry, active: true}));
        emit Listed(listingId, msg.sender, tokenId, priceWei, expiry);
    }

    function cancelListing(uint256 listingId) external nonReentrant {
        if (listingId >= listings.length) revert UnknownListing();
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingInactive();
        if (l.seller != msg.sender) revert NotSeller();
        l.active = false;
        emit ListingCancelled(listingId);
    }

    // ─── Buyer side ──────────────────────────────────────────────────

    /// @notice Everything a buyer owes, before they sign anything.
    /// @dev    Exists so no surface has to reconstruct this arithmetic to show
    ///         it. `interestWei` is what the pool's current APR would charge if
    ///         every instalment lands exactly on its due date; a buyer who pays
    ///         late pays more, and one who pays early pays less, because the
    ///         vault accrues against elapsed time rather than against the
    ///         schedule. It is an estimate of a future cost and the only
    ///         honest way to label it is as one.
    /// @return depositWei    Paid now, part of the price.
    /// @return financedWei   Fronted by the pool.
    /// @return originationWei The pool's origination fee, also paid now.
    /// @return interestWei   Interest across the schedule at today's APR.
    /// @return totalWei      Everything the buyer pays across the whole plan.
    function quote(uint256 priceWei)
        public
        view
        returns (
            uint256 depositWei,
            uint256 financedWei,
            uint256 originationWei,
            uint256 interestWei,
            uint256 totalWei
        )
    {
        depositWei = (priceWei * depositBps) / BPS;
        financedWei = priceWei - depositWei;
        originationWei = (financedWei * vault.originationFeeBps()) / BPS;

        // Straight-line amortisation: the k-th instalment carries principal
        // `financed/INSTALMENTS` and rides for `k * INSTALMENT_INTERVAL`.
        uint256 apr = vault.aprBps();
        uint256 slice = financedWei / INSTALMENTS;
        uint256 acc;
        for (uint256 k = 1; k <= INSTALMENTS; k++) {
            uint256 principalForLeg = k == INSTALMENTS ? financedWei - slice * (INSTALMENTS - 1) : slice;
            acc += (principalForLeg * apr * (k * INSTALMENT_INTERVAL)) / (365 days * BPS);
        }
        interestWei = acc;
        totalWei = depositWei + originationWei + financedWei + interestWei;
    }

    /// @notice Buy on instalments. The buyer pays the deposit plus the pool's
    ///         origination fee up front; the seller is paid the full price
    ///         (less any venue fee) in this same transaction.
    /// @param listingId    The seller's standing offer.
    /// @param maxUpfrontWei Ceiling on what leaves the buyer's wallet now, so a
    ///                      dial moved between quote and signature cannot cost
    ///                      them more than they agreed to.
    function openPlan(uint256 listingId, uint256 maxUpfrontWei)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 planId)
    {
        if (listingId >= listings.length) revert UnknownListing();
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingInactive();
        if (block.timestamp > l.expiry) revert ListingExpired();
        if (l.seller == msg.sender) revert SelfPurchase();
        // The plan must finish inside the vault loan it rides on; otherwise the
        // loan matures mid-schedule and a buyer who is paying on time loses the
        // token to a seizure they did nothing to earn.
        if (vault.loanDuration() < PLAN_DURATION + PAYMENT_GRACE) revert VaultTermTooShort();

        uint256 priceWei = l.priceWei;
        (uint256 depositWei, uint256 financedWei, uint256 originationWei,,) = quote(priceWei);
        uint256 upfront = depositWei + originationWei;
        if (upfront > maxUpfrontWei) revert ParamOutOfRange();

        (bool ok, address holder) = SafeERC721Call.safeOwnerOfBounded(collection, l.tokenId);
        if (!ok || holder != l.seller) revert SellerNoLongerOwns();

        l.active = false;

        // 1. Buyer's money in.
        _weth.safeTransferFrom(msg.sender, address(this), upfront);

        // 2. Token in, from the seller's approval to THIS address.
        bool moved = SafeERC721Call.safeTransferFromBounded(collection, l.seller, address(this), l.tokenId);
        if (!moved) revert CollateralTransferFailed();
        (bool okAfter, address nowHolder) = SafeERC721Call.safeOwnerOfBounded(collection, l.tokenId);
        if (!okAfter || nowHolder != address(this)) revert CollateralTransferFailed();

        // 3. Borrow the financed leg against it. The buyer — not this contract
        //    — is named as the surplus recipient, so a forfeited plan pays them
        //    back without a hop through here.
        IERC721(collection).approve(address(vault), l.tokenId);
        uint256 loanId = vault.borrow(l.tokenId, financedWei, msg.sender);

        // 4. Seller out, in full, now.
        uint256 saleFee = (priceWei * saleFeeBps) / BPS;
        if (saleFee != 0) _weth.safeTransfer(feeRecipient, saleFee);
        _weth.safeTransfer(l.seller, priceWei - saleFee);

        planId = plans.length;
        plans.push(
            Plan({
                buyer: msg.sender,
                seller: l.seller,
                tokenId: l.tokenId,
                priceWei: priceWei,
                financedWei: financedWei,
                principalPerInstalment: financedWei / INSTALMENTS,
                loanId: loanId,
                startedAt: uint64(block.timestamp),
                instalmentsPaid: 0,
                settled: false,
                forfeited: false
            })
        );

        emit PlanOpened(planId, listingId, msg.sender, loanId, depositWei, financedWei, saleFee);
    }

    /// @notice Pay the next instalment: one principal slice plus whatever
    ///         interest the pool has accrued since the last payment.
    /// @dev    Anyone may pay on a buyer's behalf; the token still only ever
    ///         goes to `plan.buyer`.
    function payInstalment(uint256 planId, uint256 maxPaymentWei) external nonReentrant returns (uint256 paid) {
        Plan storage p = _livePlan(planId);
        (uint256 principalDue, uint256 interestDue) = vault.quoteRepay(p.loanId);
        // AUDIT FIX TF-002: `vault.repay` is permissionless by design — it takes
        // whoever pays and never checks the borrower — so a third party, or the
        // buyer settling at the vault directly to save interest, can clear this
        // plan's loan out from under it. The vault then releases the collateral
        // to its borrower, which is THIS contract. Before this branch existed,
        // every remaining path was closed: `payInstalment` reverted PlanClosed
        // here, and `forfeit` reverts inside `vault.surrender` because the loan
        // is no longer live. The token sat in this desk permanently, and this
        // desk has no sweep, no rescue and no owner escape.
        //
        // So treat "already clear" as "deliver", not as an error. The token can
        // only ever go to `p.buyer`, so whoever paid gains nothing by it — the
        // grief costs them the whole outstanding debt and hands the buyer their
        // NFT early.
        if (principalDue == 0 && interestDue == 0) {
            _settle(planId, p);
            return 0;
        }

        uint8 next = p.instalmentsPaid + 1;
        uint256 principalLeg = next >= INSTALMENTS ? principalDue : p.principalPerInstalment;
        if (principalLeg > principalDue) principalLeg = principalDue;
        paid = principalLeg + interestDue;
        if (paid > maxPaymentWei) revert ParamOutOfRange();

        _weth.safeTransferFrom(msg.sender, address(this), paid);
        _weth.safeApprove(address(vault), paid);
        // The vault CLAMPS rather than reverts: `repay` applies at most what it
        // believes is due, and its return value is the only signal that it took
        // less than it was handed. Today `paid` never exceeds the vault's due —
        // quoteRepay and repay fold in identical pending interest at the same
        // timestamp — but that is two contracts' arithmetic agreeing, not an
        // enforced check, and this desk has no sweep or rescue path: a partial
        // application would strand the difference here permanently. Refuse it.
        if (vault.repay(p.loanId, paid) != paid) revert RepayShortApplied();
        _weth.safeApprove(address(vault), 0);

        p.instalmentsPaid = next;
        emit InstalmentPaid(planId, next, paid);

        (uint256 principalLeft, uint256 interestLeft) = vault.quoteRepay(p.loanId);
        // The vault released the token to this contract when the loan cleared;
        // hand it straight to the buyer.
        if (principalLeft == 0 && interestLeft == 0) _settle(planId, p);
    }

    /// @notice When the next instalment is due, and whether it is late enough
    ///         to forfeit.
    function scheduleStatus(uint256 planId) public view returns (uint64 nextDueAt, bool forfeitable) {
        Plan storage p = plans[planId];
        if (p.settled || p.forfeited) return (0, false);
        uint256 due = uint256(p.startedAt) + (uint256(p.instalmentsPaid) + 1) * INSTALMENT_INTERVAL;
        nextDueAt = uint64(due);
        forfeitable = block.timestamp > due + PAYMENT_GRACE;
    }

    /// @notice Wind up a plan whose next payment is past its grace period.
    /// @dev    Permissionless and unscheduled — see the NO KEEPER note in the
    ///         contract header. Hands the token to the vault's liquidation
    ///         sink; the buyer is already the vault loan's surplus recipient,
    ///         so any proceeds above the debt reach them from the vault
    ///         directly when the sink settles.
    function forfeit(uint256 planId) external nonReentrant {
        Plan storage p = _livePlan(planId);
        (, bool forfeitable) = scheduleStatus(planId);
        if (!forfeitable) revert PlanCurrent();
        p.forfeited = true;
        vault.surrender(p.loanId);
        emit PlanForfeited(planId, p.buyer);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function listingCount() external view returns (uint256) {
        return listings.length;
    }

    function planCount() external view returns (uint256) {
        return plans.length;
    }

    // ─── Admin dials ─────────────────────────────────────────────────

    function setDepositBps(uint256 newDepositBps) external onlyOwner {
        if (newDepositBps < MIN_DEPOSIT_BPS || newDepositBps > MAX_DEPOSIT_BPS) revert ParamOutOfRange();
        depositBps = newDepositBps;
        emit DepositBpsSet(newDepositBps);
    }

    function setSaleFee(uint256 newSaleFeeBps) external onlyOwner {
        if (newSaleFeeBps > MAX_SALE_FEE_BPS) revert ParamOutOfRange();
        if (newSaleFeeBps != 0 && feeRecipient == address(0)) revert FeeRecipientUnset();
        saleFeeBps = newSaleFeeBps;
        emit SaleFeeSet(newSaleFeeBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internals ───────────────────────────────────────────────────

    /// @dev The one place a plan ends happily: mark it settled and put the
    ///      collateral in the buyer's hands. Hoisted out of `payInstalment` by
    ///      AUDIT FIX TF-002 so the last-instalment path and the
    ///      externally-cleared path cannot drift apart — the second was added
    ///      precisely because it had no way to reach the first.
    function _settle(uint256 planId, Plan storage p) private {
        p.settled = true;
        bool moved = SafeERC721Call.safeTransferFromBounded(collection, address(this), p.buyer, p.tokenId);
        if (!moved) revert CollateralTransferFailed();
        emit PlanSettled(planId, p.buyer);
    }

    function _livePlan(uint256 planId) private view returns (Plan storage p) {
        if (planId >= plans.length) revert UnknownPlan();
        p = plans[planId];
        if (p.settled || p.forfeited) revert PlanClosed();
    }
}
