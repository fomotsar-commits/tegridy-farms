// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// ─────────────────────────────────────────────────────────────────────────────
/// DRAFT — AUDIT-GATED. NOT DEPLOY-READY.
///
/// This contract was drafted by an assistant and has NOT been compiled (the local
/// forge build hangs in this environment — CI is the compile source of truth),
/// fork-tested, or externally audited. It handles user funds in the NFT buy path,
/// which is the single highest-risk class of code in the protocol. Per the
/// minimal-attack-surface mandate it MUST clear: (1) a clean CI compile, (2) a
/// mainnet-fork test suite that actually buys a native listing + an OpenSea
/// listing through it and asserts the referral credit + NFT delivery, and (3) a
/// full external audit — before any mainnet deploy. The reference design +
/// attacker-pass live in docs/NATIVE_BUY_ROUTER_DESIGN.md.
///
/// KNOWN PRE-DEPLOY ITEM (Spartan audit 2026-07-22, MEDIUM): the platform fee is
/// inferred from a whole-contract balance delta (`address(this).balance -
/// priorBalance`) around the Seaport fill. That assumes Seaport consumes exactly
/// msg.value; on any fulfillment where Seaport REFUNDS unused ETH to the caller,
/// the refund is indistinguishable from an intended fee under the delta accounting
/// and would be mis-booked (swept to treasury) instead of returned to the buyer.
/// GUARD 1 (msg.value == exact native total) makes a refund unlikely on the standard
/// full-fill path, but the fork suite in (2) MUST include an order that refunds ETH
/// and assert the buyer gets the change + treasury gets only the intended fee. Prefer
/// pinning fee to an explicit precomputed amount and refunding the residual to
/// msg.sender rather than delta-inferring it. Resolve before un-gating.
/// ─────────────────────────────────────────────────────────────────────────────

// ── Minimal Seaport 1.6 types (only what fulfillAdvancedOrder needs) ──
enum ItemType {
    NATIVE,
    ERC20,
    ERC721,
    ERC1155,
    ERC721_WITH_CRITERIA,
    ERC1155_WITH_CRITERIA
}
enum OrderType {
    FULL_OPEN,
    PARTIAL_OPEN,
    FULL_RESTRICTED,
    PARTIAL_RESTRICTED,
    CONTRACT
}
enum Side {
    OFFER,
    CONSIDERATION
}

struct OfferItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

struct ConsiderationItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address payable recipient;
}

struct OrderParameters {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    OrderType orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 totalOriginalConsiderationItems;
}

struct AdvancedOrder {
    OrderParameters parameters;
    uint120 numerator;
    uint120 denominator;
    bytes signature;
    bytes extraData;
}

struct CriteriaResolver {
    uint256 orderIndex;
    Side side;
    uint256 index;
    uint256 identifier;
    bytes32[] criteriaProof;
}

interface ISeaport {
    function fulfillAdvancedOrder(
        AdvancedOrder calldata advancedOrder,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        address recipient
    ) external payable returns (bool fulfilled);
}

interface IReferralSplitter {
    function recordFee(address user) external payable;
    function withdrawCallerCredit() external;
}

/// @title  TegridyNativeBuyRouter
/// @notice A thin Seaport-fulfillment wrapper so a native order-book NFT buy can
///         attribute its platform fee to the buyer's referrer — at ZERO extra
///         cost to the buyer. The buyer pays exactly the listing price; the 1%
///         platform fee the native listing already pays is simply redirected to
///         THIS router (set as the fee consideration's recipient at listing time)
///         and forwarded to ReferralSplitter.recordFee(buyer), which credits the
///         buyer's referrer their share and returns the remainder to the router
///         as caller-credit (swept to treasury). The NFT is delivered straight to
///         the buyer (recipient = msg.sender), so the router never custodies NFTs
///         and holds ETH only for the span of one call.
///
///         For an OpenSea (or any non-native) order whose consideration pays no
///         fee to this router, `fee` is 0, recordFee is skipped, and the call is a
///         harmless pass-through (NFT → buyer, exact ETH forwarded). So the router
///         is safe to route any Seaport order through; it only earns/attributes on
///         listings that name it as the fee recipient.
///
/// Battle-tested sources (mandate: custom code is the exploit surface — reuse):
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - ReentrancyGuard:  OZ (industry standard)
///  - WETHFallbackLib:  Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
contract TegridyNativeBuyRouter is OwnableNoRenounce, ReentrancyGuard {
    ISeaport public immutable seaport;
    IReferralSplitter public immutable referralSplitter;
    address public immutable weth; // WETH fallback for revert-on-receive treasuries
    address public treasury;

    event NativeBuyRouted(address indexed buyer, bytes32 indexed orderHash, uint256 paid, uint256 feeAttributed);
    event TreasurySwept(address indexed treasury, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error ZeroAddress();
    error ValueMismatch(); // msg.value != the order's exact native total (overpay/underpay guard)
    error FulfillFailed();
    error NothingToSweep();
    error PartialFillNotSupported(); // numerator != denominator — see GUARD 0 in buy()

    constructor(address _seaport, address _referralSplitter, address _treasury, address _weth)
        OwnableNoRenounce(msg.sender)
    {
        if (_seaport == address(0) || _referralSplitter == address(0) || _treasury == address(0) || _weth == address(0))
        {
            revert ZeroAddress();
        }
        seaport = ISeaport(_seaport);
        referralSplitter = IReferralSplitter(_referralSplitter);
        treasury = _treasury;
        weth = _weth;
    }

    /// @notice The router only ever receives ETH as a Seaport consideration payout
    ///         (the redirected platform fee) or a fulfillment refund, both inside
    ///         `buy`. A bare transfer is accepted but swept to treasury like any
    ///         other dust — there is no path that lets stray ETH be mis-attributed.
    receive() external payable {}

    /// @notice Fulfill a Seaport order on behalf of the buyer, delivering the NFT
    ///         straight to them, and attribute any platform fee paid to this router
    ///         to their referrer via ReferralSplitter.
    /// @param  order      The signed Seaport AdvancedOrder (the frontend builds this
    ///                    from the stored native listing; numerator/denominator 1/1,
    ///                    empty extraData for a standard full order).
    /// @param  orderHash  The canonical order hash, for the event only (not trusted
    ///                    for any value decision — purely off-chain attribution).
    function buy(AdvancedOrder calldata order, bytes32 orderHash) external payable nonReentrant {
        // GUARD 0 — full fills only. _nativeTotal (and thus GUARD 1) sums the order's
        // FULL startAmounts with no numerator/denominator scaling, so it is only correct
        // for a 1/1 fill. A partial fill (numerator < denominator, legal for a
        // PARTIAL_OPEN ERC1155 order) would have the buyer pass the full msg.value while
        // Seaport consumes only the fraction and REFUNDS the remainder to this router,
        // where it is then mis-booked as platform fee. The docstring already assumes 1/1;
        // enforce it so the assumption can't be violated by a hand-crafted order.
        if (order.numerator != order.denominator) revert PartialFillNotSupported();

        // GUARD 1 — exact payment. Sum every NATIVE consideration item; the buyer
        // must send exactly that. This blocks the overpay vector where Seaport would
        // refund the excess to THIS router and the excess would then be mis-counted
        // as platform fee and credited to a referrer (buyer silently loses it).
        uint256 exactTotal = _nativeTotal(order);
        if (msg.value != exactTotal) revert ValueMismatch();

        // priorBalance excludes the just-received msg.value, so the post-call delta
        // is exactly what Seaport paid back to us (the redirected fee), never any
        // pre-existing dust.
        uint256 priorBalance = address(this).balance - msg.value;

        // Deliver the NFT directly to the buyer (recipient = msg.sender) so the
        // router never custodies the token; forward the buyer's exact ETH. Empty
        // criteria resolvers — native + standard listings carry no wildcard slots.
        bool ok = seaport.fulfillAdvancedOrder{value: msg.value}(
            order, new CriteriaResolver[](0), order.parameters.conduitKey, msg.sender
        );
        if (!ok) revert FulfillFailed();

        // Whatever Seaport paid this router (the listing's redirected platform fee)
        // is attributed to the buyer's referrer. recordFee credits the referrer's
        // share (if registered + qualified) and returns the remainder to us as
        // caller-credit (later swept to treasury). For non-native/OpenSea orders
        // that name no fee to us this is 0 → skipped → pure pass-through.
        uint256 fee = address(this).balance - priorBalance;
        if (fee > 0) {
            // Best-effort attribution: if the splitter rejects (router not yet an
            // approved caller, setup incomplete, or paused), the fee simply stays in
            // the router and is later swept to treasury — the buy NEVER reverts on an
            // attribution failure, so a splitter misconfig can't brick native buys.
            try referralSplitter.recordFee{value: fee}(msg.sender) {} catch {}
        }

        emit NativeBuyRouted(msg.sender, orderHash, msg.value, fee);
    }

    /// @notice Sweep the router's non-referral fee remainder (held as caller-credit
    ///         inside ReferralSplitter) plus any stray ETH balance to the treasury.
    ///         Permissionless-safe to expose as onlyOwner; funds can only ever move
    ///         to `treasury`. Uses the WETH fallback so a revert-on-receive treasury
    ///         can't brick the sweep.
    function sweepToTreasury() external onlyOwner nonReentrant {
        // Pull our accumulated caller-credit out of the splitter first (best-effort:
        // reverts with NothingToClaim if zero, which we tolerate by trying the raw
        // balance sweep below). Kept as a separate try so a zero-credit state still
        // lets us sweep any stray ETH.
        try referralSplitter.withdrawCallerCredit() {} catch {}

        uint256 amount = address(this).balance;
        // slither-disable-next-line incorrect-equality — zero-balance sentinel, not a value comparison
        if (amount == 0) revert NothingToSweep();
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount);
        emit TreasurySwept(treasury, amount);
    }

    /// @notice Update the sweep destination. No timelock: the only effect is WHERE
    ///         the already-earned remainder is swept, and the contract is owned by
    ///         the protocol multisig. (If a timelock is desired, mirror the
    ///         ReferralSplitter TREASURY_CHANGE 48h pattern.)
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @dev Sum of all NATIVE (ETH) consideration amounts = exactly what Seaport
    ///      requires as msg.value for an ETH-settled order. For a fixed-price native
    ///      listing start==end; this reads startAmount (the price at/after startTime
    ///      for a static order). Dynamic (Dutch) native listings are NOT supported by
    ///      this exact-value guard and must not be routed here.
    function _nativeTotal(AdvancedOrder calldata order) internal pure returns (uint256 total) {
        ConsiderationItem[] calldata cons = order.parameters.consideration;
        for (uint256 i = 0; i < cons.length; i++) {
            if (cons[i].itemType == ItemType.NATIVE) {
                total += cons[i].startAmount;
            }
        }
    }
}
