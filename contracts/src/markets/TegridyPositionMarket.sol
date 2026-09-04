// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {WETHFallbackLib} from "../lib/WETHFallbackLib.sol";

/// @notice The exact slice of TegridyStaking this market depends on. Kept as small as
///         the design allows: every selector here is a live coupling that a future
///         EIP-170 golf pass could silently lower to `internal` and delete from the
///         ABI. That has happened in this repo before (`userPositionCount`, 2026-05-31),
///         and a missing selector on a contract with no fallback reverts with empty
///         returndata — indistinguishable from a legitimate refusal. Every selector
///         below is bound against a REAL TegridyStaking in
///         `test/markets/PositionMarketStakingBinding.t.sol`; do not add one without
///         adding its binding assertion.
interface IStakingPositionMarketView {
    function userTokenId(address user) external view returns (uint256);
    function unsettledRewards(address holder) external view returns (uint256);
    function rewardToken() external view returns (address);
    function claimUnsettled() external;
    function kick(uint256 tokenId) external;
}

/// @title  TegridyPositionMarket — escrowed order book for veTOWELI staking positions
///
/// @notice veTOWELI locks are ERC-721 positions with no pre-maturity exit. This is the
///         exit: a seller escrows the position, a buyer pays, and the position moves to
///         the buyer against payment in one transaction. Escrow only. No
///         fractionalisation, no lending against positions, no oracle. Price discovery
///         is the participants' problem; custody safety is ours.
///
/// @dev    THE THREE STAKING CONSTRAINTS THIS CONTRACT IS SHAPED BY
///
///         TegridyStaking's transfer path is guarded, and every guard fires on OUR
///         hops, not just on user-to-user hops. WORKORDER_V2 E.21 records one of the
///         three (the EOA guard) and parks a relaxation in the redeploy batch; this
///         contract is built to be correct against the LIVE contract, unrelaxed, so it
///         needs no redeploy to be safe.
///
///         (1) SINGLE POSITION PER EOA. `StakingRewardLib.afterTokenTransfer` reverts
///             `AlreadyHasPosition` when the receiver has `userTokenId != 0` and is an
///             EOA — including an EIP-7702 delegated EOA, whose runtime code is exactly
///             23 bytes. The carve-out is `isLendingContract[from]`, and this market is
///             deliberately NOT registered as a lending contract (registration is a
///             timelocked staking-admin action and would hand this contract cooldown
///             and rate-limit exemptions it has no business holding). So: a buyer who
///             already holds a position CANNOT receive one here. `fill` refuses such a
///             buyer up front with `RecipientHoldsPosition` instead of letting the
///             staking guard revert underneath a committed payment, and `fill` takes a
///             `recipient` so that buyer's honest route — a fresh address or a contract
///             wallet — is a parameter rather than a workaround.
///
///         (2) TRANSFER RATE LIMIT. `lastTransferTime[id] + 1 hours` gates every
///             non-lending, non-restaking hop. The listing hop stamps it, so a position
///             is un-releasable — un-fillable AND un-cancellable — for one hour after
///             it is escrowed. `lastTransferTime` is `internal` with no getter, so this
///             cannot be read back; instead the market records `escrowedAt` at the hop
///             it performs itself, which is the same instant the staking contract
///             stamps. `STAKING_TRANSFER_RATE_LIMIT` below is a MIRROR of a constant we
///             cannot read, and is asserted against real staking behaviour in the
///             binding suite.
///
///         (3) PER-HOLDER POSITION CAP. A non-carve-out holder reverts
///             `TooManyPositions` at 50 positions. This market is a plain contract
///             holder, so the number of simultaneously escrowed listings is capped at
///             50 protocol-wide. `list` refuses at the cap with `EscrowCapReached`
///             rather than reverting inside the staking hop. The same cap applies to a
///             CONTRACT buyer, and `userPositionCount` is `internal` — so for a
///             contract recipient this market cannot certify eligibility, and
///             `fillability` says so explicitly rather than returning a green light it
///             did not earn.
///
///             KNOWN BOUND, not a bug to be patched here: 50 slots protocol-wide is
///             also a book-filling grief. The cost is 50 genuine positions — each
///             above MIN_STAKE, locked at least 7 days, and un-listable for 24h after
///             staking — held across as many addresses as the griefer likes, so a
///             per-seller listing cap would not raise it. Nothing this contract can do
///             lifts a cap that lives in TegridyStaking; the levers are the E.21
///             redeploy that relaxes the holder cap, or a second immutable market
///             instance. `escrowedCount` and `MAX_ESCROWED_POSITIONS` are public so
///             the condition is observable rather than presenting as a mystery revert.
///
///             `escrowedCount` counts ORDERS, and a stray `transferFrom` push can put
///             a position here with no order behind it (see `rescueUnlistedPosition`),
///             at which point staking's count of what this contract holds runs ahead of
///             `escrowedCount` and a listing near the cap can still take the staking
///             revert. That degrades a named refusal into a raw one on a path where
///             nothing but gas is committed; it never affects a fill.
///
/// @dev    ESCROW-PERIOD REWARDS. Every staking transfer settles the sender's accrued
///         rewards into `unsettledRewards[sender]`. On the release hop the sender is
///         this market, so rewards that accrued while a position sat in escrow land in
///         a bucket owned by this contract and would otherwise be stranded — the
///         protocol would be holding yield it did not earn. `_release` measures the
///         bucket delta ACROSS the release hop, which is exactly this position's
///         escrow-period accrual, and credits it to the seller: the seller's capital
///         was the thing locked for that window. See `rescueSurplusRewards` for the one
///         path that can put unattributable value in the bucket.
///
/// @dev    IMMUTABLE, no proxy, no upgrade path. Ownership is 2-step and
///         non-renounceable. The owner can pause `list`/`fill` and can configure the
///         fee; the owner can NEVER move an escrowed position, cancel someone's
///         listing, or touch owed escrow rewards. `cancel` and `claimEscrowRewards` are
///         deliberately NOT pausable, so a pause can trap neither a seller's NFT nor a
///         seller's yield.
///
/// @dev    FEE DIAL SHIPS AT ZERO WITH NO SINK. `feeBps` is 0 and `feeRecipient` is
///         `address(0)` at construction and cannot be raised without a sink being wired
///         first. Each order snapshots the fee in force when it was listed, so a fee
///         change can never be applied retroactively to a listing a seller already
///         signed.
contract TegridyPositionMarket is OwnableNoRenounce, ReentrancyGuard, Pausable, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The staking contract, which is also the position NFT.
    IERC721 public immutable positionNFT;
    IStakingPositionMarketView public immutable staking;
    /// @notice Reward token, read from staking at construction so it cannot drift.
    IERC20 public immutable rewardToken;
    /// @notice WETH, for the ETH-send fallback when a payee rejects a raw transfer.
    address public immutable weth;

    // ─── Mirrored staking constants ───────────────────────────────────

    /// @dev MIRROR of `TegridyStaking.TRANSFER_RATE_LIMIT` (`internal`, no getter).
    ///      If the redeployed staking contract changes this value, this market must be
    ///      redeployed with it. Bound to real behaviour by
    ///      `test_mirror_rateLimit_matchesRealStaking`.
    uint256 public constant STAKING_TRANSFER_RATE_LIMIT = 1 hours;

    /// @dev MIRROR of `TegridyStaking.MAX_POSITIONS_PER_HOLDER` (`internal`, no getter).
    ///      Bound by `test_mirror_positionCap_matchesRealStaking`.
    uint256 public constant MAX_ESCROWED_POSITIONS = 50;

    /// @notice Hard ceiling on the sale fee, fixed at deploy. 2.5%.
    uint16 public constant MAX_FEE_BPS = 250;
    uint256 private constant BPS = 10_000;

    // ─── Orders ───────────────────────────────────────────────────────

    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        address seller;
        /// @dev uint96 caps a listing at ~7.9e28 wei. Packs the order into 3 slots.
        uint96 price;
        uint64 escrowedAt;
        /// @dev Snapshot: the fee in force when the seller listed, not when a buyer fills.
        uint16 feeBps;
        OrderStatus status;
        address feeRecipient;
        uint256 tokenId;
    }

    /// @notice Order id 0 is never issued; it is the "no order" sentinel.
    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;
    /// @notice tokenId => the open order escrowing it, 0 when none.
    mapping(uint256 => uint256) public openOrderOfToken;
    /// @notice Number of positions currently escrowed. Bounded by MAX_ESCROWED_POSITIONS.
    uint256 public escrowedCount;

    // ─── Escrow-period reward ledger ──────────────────────────────────

    /// @notice Reward-token owed to each seller for the window their position sat in
    ///         escrow. Denominated in `rewardToken`; claimed via `claimEscrowRewards`.
    mapping(address => uint256) public escrowRewardsOwed;
    /// @notice Sum of `escrowRewardsOwed`. The floor below which `rescueSurplusRewards`
    ///         may never draw the contract's reward-token balance.
    uint256 public totalEscrowRewardsOwed;

    // ─── Fee dial ─────────────────────────────────────────────────────

    uint16 public feeBps;
    address public feeRecipient;

    // ─── Receiver guard ───────────────────────────────────────────────

    /// @dev `tokenId + 1` while a `list` call is mid-hop, 0 otherwise. Makes
    ///      `onERC721Received` accept exactly the one inbound transfer this contract
    ///      asked for, so no one can push a position into escrow with no order behind it.
    uint256 private _inboundTokenId;

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrice();
    error PriceTooHigh();
    error EscrowCapReached();
    error OrderNotOpen();
    error NotSeller();
    error WrongPayment(uint256 expected, uint256 sent);
    /// @param availableAt Unix seconds at which the staking rate limit clears.
    error PositionRateLimited(uint64 availableAt);
    /// @notice The recipient is an EOA (or EIP-7702 delegated EOA) that already holds a
    ///         staking position, so `TegridyStaking` will refuse the inbound transfer.
    ///         Direct the purchase at a fresh address or a contract wallet.
    error RecipientHoldsPosition(address recipient);
    error UnexpectedPositionTransfer();
    error EscrowedPositionNotRescuable();
    error NothingOwed();
    error RewardsNotYetClaimable();
    error FeeTooHigh();
    error FeeWithoutSink();
    error NoSurplus();

    // ─── Events ───────────────────────────────────────────────────────

    event PositionListed(
        uint256 indexed orderId,
        address indexed seller,
        uint256 indexed tokenId,
        uint256 price,
        uint64 releasableAt,
        uint16 feeBps,
        address feeRecipient
    );
    event PositionSold(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed recipient,
        uint256 price,
        uint256 fee
    );
    event ListingCancelled(uint256 indexed orderId, address indexed recipient);
    event EscrowRewardsAccrued(uint256 indexed orderId, address indexed seller, uint256 amount);
    event EscrowRewardsClaimed(address indexed seller, uint256 amount);
    event FeeConfigured(uint16 feeBps, address feeRecipient);
    event UnlistedPositionRescued(uint256 indexed tokenId, address indexed to);
    event SurplusRewardsRescued(address indexed to, uint256 amount);

    // ─── Construction ─────────────────────────────────────────────────

    /// @param _staking TegridyStaking — both the position NFT and the reward source.
    /// @param _weth    Canonical WETH, used only as the payout fallback when a payee
    ///                 rejects a raw ETH send.
    /// @param _owner   Multisig. 2-step: `_owner` must call `acceptOwnership`.
    constructor(address _staking, address _weth, address _owner) OwnableNoRenounce(_owner) {
        if (_staking == address(0) || _weth == address(0)) revert ZeroAddress();
        positionNFT = IERC721(_staking);
        staking = IStakingPositionMarketView(_staking);
        weth = _weth;
        // Read rather than accept as a parameter: a mismatch here would send escrow
        // rewards to a ledger denominated in the wrong token.
        address rt = IStakingPositionMarketView(_staking).rewardToken();
        if (rt == address(0)) revert ZeroAddress();
        rewardToken = IERC20(rt);
        // feeBps and feeRecipient stay at their zero values: dial off, no sink.
    }

    // ─── Seller side ──────────────────────────────────────────────────

    /// @notice Escrow `tokenId` and open an order at `price` wei.
    /// @dev    The inbound hop is subject to TegridyStaking's own 24h post-stake
    ///         cooldown and 1h rate limit. Those are checked by staking, not mirrored
    ///         here: a revert at listing time commits nothing but gas, so refusing early
    ///         would buy nothing and would add a second copy of staking's rules to keep
    ///         in sync. The buyer-facing checks are mirrored precisely because there a
    ///         revert lands underneath committed funds.
    /// @return orderId The new order's id.
    function list(uint256 tokenId, uint256 price)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        if (price == 0) revert ZeroPrice();
        if (price > type(uint96).max) revert PriceTooHigh();
        if (escrowedCount >= MAX_ESCROWED_POSITIONS) revert EscrowCapReached();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            seller: msg.sender,
            price: uint96(price),
            escrowedAt: uint64(block.timestamp),
            feeBps: feeBps,
            status: OrderStatus.Open,
            feeRecipient: feeRecipient,
            tokenId: tokenId
        });
        openOrderOfToken[tokenId] = orderId;
        unchecked {
            escrowedCount += 1; // bounded by MAX_ESCROWED_POSITIONS above
        }

        _inboundTokenId = tokenId + 1;
        positionNFT.safeTransferFrom(msg.sender, address(this), tokenId);
        _inboundTokenId = 0;

        emit PositionListed(
            orderId,
            msg.sender,
            tokenId,
            price,
            uint64(block.timestamp + STAKING_TRANSFER_RATE_LIMIT),
            orders[orderId].feeBps,
            orders[orderId].feeRecipient
        );
    }

    /// @notice Withdraw an unsold listing to `recipient`.
    /// @dev    Not pausable: a pause must never trap a seller's position.
    ///
    ///         `recipient` is a parameter, not hardcoded to the seller, because of a
    ///         trap in the staking guard. Escrowing zeroes `userTokenId[seller]`, which
    ///         is exactly the field `stake()` checks — so a seller can list, then stake
    ///         a brand-new position, and their own address is now ineligible to receive
    ///         the escrowed one back. Without a recipient parameter that position would
    ///         be stuck until they exited the new stake. The same
    ///         `RecipientHoldsPosition` refusal applies here as on the buy side.
    function cancel(uint256 orderId, address recipient) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.Open) revert OrderNotOpen();
        if (msg.sender != o.seller) revert NotSeller();
        if (recipient == address(0)) revert ZeroAddress();
        _requireReleasable(o, recipient);

        o.status = OrderStatus.Cancelled;
        openOrderOfToken[o.tokenId] = 0;
        unchecked {
            escrowedCount -= 1;
        }

        _release(orderId, o.seller, o.tokenId, recipient);
        emit ListingCancelled(orderId, recipient);
    }

    // ─── Buy side ─────────────────────────────────────────────────────

    /// @notice Buy the position escrowed by `orderId`, delivering it to `recipient`.
    /// @dev    `msg.value` must equal the listed price exactly — no change is made, so a
    ///         fat-fingered overpayment is refused rather than pocketed.
    ///
    ///         `recipient` may differ from `msg.sender`. That is the documented route
    ///         for a buyer who already holds a staking position: TegridyStaking will not
    ///         let a second position land on an EOA, so such a buyer names a fresh
    ///         address or a contract wallet. `_requireReleasable` refuses the fill
    ///         BEFORE any value moves if the recipient is one the staking guard will
    ///         reject, so the failure is a named reason and not a revert underneath a
    ///         committed payment.
    function fill(uint256 orderId, address recipient) external payable nonReentrant whenNotPaused {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.Open) revert OrderNotOpen();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 price = o.price;
        if (msg.value != price) revert WrongPayment(price, msg.value);
        _requireReleasable(o, recipient);

        address seller = o.seller;
        uint256 tokenId = o.tokenId;
        // Snapshotted at list time so a fee change cannot be applied to a listing that
        // was already standing. A zero sink forces a zero fee even if bps were somehow
        // non-zero — the dial and the sink must both be live for value to leave.
        address sink = o.feeRecipient;
        uint256 fee = sink == address(0) ? 0 : (price * o.feeBps) / BPS;

        // Effects before any external call. The NFT release below hands control to a
        // contract recipient's `onERC721Received`; by then this order is Filled and
        // `nonReentrant` holds, so a reentrant fill or cancel finds nothing to take.
        o.status = OrderStatus.Filled;
        openOrderOfToken[tokenId] = 0;
        unchecked {
            escrowedCount -= 1;
        }

        _release(orderId, seller, tokenId, recipient);

        if (fee > 0) WETHFallbackLib.safeTransferETHOrWrap(weth, sink, fee);
        WETHFallbackLib.safeTransferETHOrWrap(weth, seller, price - fee);

        emit PositionSold(orderId, msg.sender, recipient, price, fee);
    }

    // ─── Honesty-gated pre-check ──────────────────────────────────────

    /// @notice What, if anything, blocks releasing `orderId` to `recipient`.
    enum Blocker {
        None,
        OrderNotOpenBlocker,
        ZeroRecipient,
        RateLimited,
        RecipientAlreadyHoldsPosition
    }

    /// @notice Pre-flight for a fill or a cancel.
    ///
    /// @dev    `certain` is the honesty gate and callers MUST branch on it. When the
    ///         recipient is a contract, TegridyStaking's per-holder cap of 50 still
    ///         applies to it, and `userPositionCount` is `internal` — there is no way to
    ///         read whether that recipient is at the cap. This function therefore
    ///         returns `certain == false` for every contract recipient: it is reporting
    ///         that it could not complete the check, NOT that the fill will succeed. A
    ///         UI that renders `blocker == None` as "eligible" while ignoring `certain`
    ///         is claiming something this contract did not read.
    ///
    /// @return blocker      The first blocking condition found, or `None`.
    /// @return certain      True only when every applicable condition was actually read.
    /// @return releasableAt Unix seconds at which the staking rate limit clears.
    function fillability(uint256 orderId, address recipient)
        external
        view
        returns (Blocker blocker, bool certain, uint64 releasableAt)
    {
        Order storage o = orders[orderId];
        releasableAt = o.escrowedAt == 0 ? 0 : uint64(o.escrowedAt + STAKING_TRANSFER_RATE_LIMIT);

        if (o.status != OrderStatus.Open) return (Blocker.OrderNotOpenBlocker, true, releasableAt);
        if (recipient == address(0)) return (Blocker.ZeroRecipient, true, releasableAt);
        if (block.timestamp < releasableAt) return (Blocker.RateLimited, true, releasableAt);

        uint256 codeLen = recipient.code.length;
        // 23 bytes is an EIP-7702 delegation pointer (0xef0100 ‖ address) — still an EOA
        // as far as the staking guard is concerned. This mirrors
        // StakingRewardLib.afterTokenTransfer exactly.
        bool isEoa = codeLen == 0 || codeLen == 23;
        if (isEoa) {
            if (staking.userTokenId(recipient) != 0) {
                return (Blocker.RecipientAlreadyHoldsPosition, true, releasableAt);
            }
            return (Blocker.None, true, releasableAt);
        }
        // Contract recipient: the EOA guard does not apply, but the 50-position cap
        // does and is unreadable. Nothing blocking was found; that is not the same as
        // clear.
        return (Blocker.None, false, releasableAt);
    }

    /// @dev The enforcement half of `fillability`, sharing its exact conditions.
    function _requireReleasable(Order storage o, address recipient) private view {
        uint64 releasableAt = uint64(o.escrowedAt + STAKING_TRANSFER_RATE_LIMIT);
        if (block.timestamp < releasableAt) revert PositionRateLimited(releasableAt);
        uint256 codeLen = recipient.code.length;
        if (codeLen == 0 || codeLen == 23) {
            if (staking.userTokenId(recipient) != 0) revert RecipientHoldsPosition(recipient);
        }
    }

    // ─── Escrow-period rewards ────────────────────────────────────────

    /// @dev Release the escrowed position and book the escrow-period yield.
    ///
    ///      The bucket delta measured across the hop is precisely this position's
    ///      accrual: `unsettledRewards[address(this)]` only ever grows, and on this hop
    ///      it grows by what `_settleRewardsOnTransfer` credited for this token. Reading
    ///      it either side of the transfer keeps attribution per-position even though
    ///      the staking bucket itself is a single commingled per-address balance.
    ///
    ///      Deliberately no `claimUnsettled` call here: that function is
    ///      `whenNotPaused` on staking, and a paused staking contract must not be able
    ///      to block a cancel or a fill. Sellers pull via `claimEscrowRewards`.
    function _release(uint256 orderId, address seller, uint256 tokenId, address recipient) private {
        uint256 bucketBefore = staking.unsettledRewards(address(this));
        positionNFT.safeTransferFrom(address(this), recipient, tokenId);
        uint256 credited = staking.unsettledRewards(address(this)) - bucketBefore;
        if (credited > 0) {
            escrowRewardsOwed[seller] += credited;
            totalEscrowRewardsOwed += credited;
            emit EscrowRewardsAccrued(orderId, seller, credited);
        }
    }

    /// @notice Pull the reward-token yield that accrued while your position was escrowed.
    /// @dev    Not pausable, for the same reason `cancel` is not.
    ///
    ///         Pays out at most the balance actually on hand. TegridyStaking's
    ///         `claimUnsettled` can pay partially when its reward pool is short, and can
    ///         revert outright while staking is paused; neither case may zero a ledger
    ///         entry that was not paid, so the unpaid remainder stays owed.
    function claimEscrowRewards() external nonReentrant returns (uint256 paid) {
        uint256 owed = escrowRewardsOwed[msg.sender];
        if (owed == 0) revert NothingOwed();

        // SLITHER 2026-08-30: guarded pull from the trusted protocol staking contract; every
        // writer of the ledger is nonReentrant, and the write below is RELATIVE (-=) so even a
        // hypothetical re-entrant credit could not be clobbered by a stale absolute value
        // slither-disable-next-line reentrancy-no-eth
        _pullUnsettled();

        uint256 bal = rewardToken.balanceOf(address(this));
        paid = owed > bal ? bal : owed;
        // SLITHER 2026-08-30: fail-closed — the partial-pay ledger keeps the unpaid remainder
        // owed; zero payable must revert, never zero a ledger entry that was not paid
        // slither-disable-next-line incorrect-equality
        if (paid == 0) revert RewardsNotYetClaimable();

        // Relative form on purpose (2026-08-30, per the 08-22 refutation review): equivalent to
        // `owed - paid` under the guard, and safe against clobbering a concurrent credit even
        // without it — the safety no longer rests on the modifier set staying exactly as-is.
        escrowRewardsOwed[msg.sender] -= paid;
        totalEscrowRewardsOwed -= paid;
        rewardToken.safeTransfer(msg.sender, paid);
        emit EscrowRewardsClaimed(msg.sender, paid);
    }

    /// @dev Best-effort drain of this contract's unsettled bucket. Swallowed on failure
    ///      because a paused staking contract, or a claim that reverts for any other
    ///      reason, must degrade to "nothing new arrived" and not to "your claim
    ///      reverted". The caller then pays from whatever balance is genuinely present.
    function _pullUnsettled() private {
        if (staking.unsettledRewards(address(this)) == 0) return;
        // slither-disable-next-line unused-return
        try staking.claimUnsettled() {} catch {}
    }

    /// @notice Decay an escrowed position whose lock has expired, attributing the
    ///         rewards the decay settles to that position's seller.
    /// @dev    `TegridyStaking.kick` is permissionless and settles the HOLDER's pending
    ///         rewards — and while a position is escrowed, the holder is this contract.
    ///         A kick called directly on staking therefore drops value into this
    ///         contract's bucket with no order attached to it. Routing the kick through
    ///         here keeps the attribution exact. The direct route still exists and
    ///         cannot be closed; `rescueSurplusRewards` is the accounting for it.
    function kickEscrowed(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.Open) revert OrderNotOpen();
        address seller = o.seller;
        uint256 bucketBefore = staking.unsettledRewards(address(this));
        staking.kick(o.tokenId);
        uint256 credited = staking.unsettledRewards(address(this)) - bucketBefore;
        if (credited > 0) {
            escrowRewardsOwed[seller] += credited;
            totalEscrowRewardsOwed += credited;
            emit EscrowRewardsAccrued(orderId, seller, credited);
        }
    }

    /// @notice Reward-token held here beyond what is owed to sellers.
    /// @dev    Non-zero only when someone called `TegridyStaking.kick` directly on an
    ///         escrowed position (see `kickEscrowed`) and a later `claimEscrowRewards`
    ///         drained the resulting unattributed credit into this contract along with
    ///         an attributed one. It is real yield with no identifiable owner.
    function surplusRewards() public view returns (uint256) {
        uint256 bal = rewardToken.balanceOf(address(this));
        return bal > totalEscrowRewardsOwed ? bal - totalEscrowRewardsOwed : 0;
    }

    // ─── Owner surface ────────────────────────────────────────────────

    /// @notice Set the sale fee and its sink.
    /// @dev    Ships at 0 / `address(0)` and stays there until the operator wires a
    ///         real sink. Both halves move together so there is no window in which a
    ///         non-zero rate points at nowhere, and `fill` independently forces the fee
    ///         to zero whenever the snapshotted sink is zero.
    ///
    ///         A change here does NOT reach standing orders — each order carries the
    ///         rate and sink that were in force when its seller listed.
    function setFee(uint16 _feeBps, address _feeRecipient) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_feeBps > 0 && _feeRecipient == address(0)) revert FeeWithoutSink();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeConfigured(_feeBps, _feeRecipient);
    }

    /// @notice Halt new listings and new fills.
    /// @dev    `cancel` and `claimEscrowRewards` stay open by design — a pause is for
    ///         stopping new exposure, never for holding user property.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Return a position that reached this contract without an order behind it.
    /// @dev    `onERC721Received` refuses unsolicited `safeTransferFrom`, but a plain
    ///         `transferFrom` has no hook to refuse with and would otherwise strand the
    ///         position forever. The `openOrderOfToken` guard means this can never touch
    ///         an escrowed listing, so it is a recovery path and not a custody power.
    function rescueUnlistedPosition(uint256 tokenId, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (openOrderOfToken[tokenId] != 0) revert EscrowedPositionNotRescuable();
        positionNFT.safeTransferFrom(address(this), to, tokenId);
        emit UnlistedPositionRescued(tokenId, to);
    }

    /// @notice Sweep reward-token that is provably owed to nobody.
    /// @dev    Bounded by `surplusRewards()`, which subtracts every seller's outstanding
    ///         ledger entry first, so this cannot reach owed yield no matter what the
    ///         owner passes.
    function rescueSurplusRewards(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _pullUnsettled();
        uint256 amount = surplusRewards();
        // SLITHER 2026-08-30: bounded-sweep sentinel — surplusRewards() already subtracts every
        // seller's outstanding ledger entry, so owed yield is unreachable; zero fail-closes
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NoSurplus();
        rewardToken.safeTransfer(to, amount);
        emit SurplusRewardsRescued(to, amount);
    }

    // ─── ERC-721 receiver ─────────────────────────────────────────────

    /// @dev Accepts exactly the one inbound transfer `list` is mid-way through, from the
    ///      position NFT and no other collection. Anything else is unsolicited and is
    ///      refused rather than escrowed with no order behind it.
    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionNFT)) revert UnexpectedPositionTransfer();
        if (_inboundTokenId != tokenId + 1) revert UnexpectedPositionTransfer();
        return IERC721Receiver.onERC721Received.selector;
    }
}
