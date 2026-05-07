// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title PremiumAccess
/// @notice Subscription-based premium features. JBAC NFT holders get free access.
///         Everyone else pays a monthly fee in TOWELI.
///
///         Premium benefits (enforced off-chain or by other contracts checking hasPremium):
///         - Priority harvest execution
///         - Advanced analytics dashboard
///         - Exclusive pool access
///         - Reduced withdrawal fees
///         - Custom alerts
///
///         Revenue: subscription fees go to treasury in TOWELI.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
contract PremiumAccess is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");

    IERC20 public immutable toweli;
    IERC721 public immutable jbacNFT;
    address public treasury;

    uint256 public monthlyFeeToweli; // TOWELI per month
    uint256 public constant MONTH = 30 days;
    /// @dev AUDIT R014 (MEDIUM, same-block subscribe-then-cancel): require a
    ///      24h minimum holding period before cancellation is allowed. The
    ///      pre-existing SAME_BLOCK_CANCEL guard only blocked the same-block
    ///      attack (and was bypassed by waiting one block). 1 day is short
    ///      enough not to hurt legitimate cancel UX (most users either commit
    ///      or refund within minutes of a misclick) but long enough to make
    ///      the flash-premium attack uneconomical.
    uint256 public constant MIN_HOLDING_PERIOD = 1 days;

    struct Subscription {
        uint256 expiresAt;
        bool _deprecated_lifetime; // DEPRECATED: NFT access now checked at query time, not granted permanently
        uint256 startedAt; // CRITICAL FIX: when the current subscription period started
    }

    mapping(address => Subscription) public subscriptions;
    mapping(address => uint256) public totalPaidByUser; // SECURITY FIX #17: track payments for pro-rata refund
    /// @dev AUDIT PA-M-02 (2026-04-29): `paidFeeRate` was the M-43 "snapshot fee at
    ///      subscribe time" mitigation — but the refund path (`cancelSubscription`)
    ///      always read `userEscrow` (the actually-paid TOWELI), never `paidFeeRate`.
    ///      The slot was written on subscribe and cleared on cancel and never read.
    ///      Removed. The slot is preserved as `_deprecated_paidFeeRate_slot` to keep
    ///      storage layout stable for any deployed instance — DO NOT reuse this slot.
    mapping(address => uint256) private _deprecated_paidFeeRate_slot;
    mapping(address => uint256) public userEscrow; // CRITICAL FIX: actual TOWELI escrowed per user
    mapping(address => bool) public isActiveSubscriber; // AUDIT FIX L-04: track active status for accurate counter
    uint256 public totalSubscribers; // Currently active subscribers
    uint256 public totalRevenue;
    // SECURITY FIX #3: Track total refund escrow so withdrawToTreasury doesn't drain refundable funds
    uint256 public totalRefundEscrow;
    // A4-C-02: NFT activation timestamp — prevents flash-loan NFT borrow attacks.
    // Users must call activateNFTPremium() in a prior block/timestamp before hasPremium() returns true.
    // AUDIT FIX M-36: Changed from block.number to block.timestamp for L2 compatibility
    // (block.number on Arbitrum returns L1 block number, making block-based checks unreliable)
    mapping(address => uint256) public nftActivationBlock; // kept name for storage compat, stores timestamp now
    uint256 public constant MIN_ACTIVATION_DELAY = 15 seconds;

    /// @notice AUDIT FIX: DEEP-DR-M-05 — track refund shortfalls when contractBalance
    ///         caps the cancelSubscription refund. Without this, the user's userEscrow
    ///         is fully zeroed but they only receive `contractBalance` — silently
    ///         losing the difference. Now the difference is recorded as a claim
    ///         against future contract balance via `claimShortfall()`.
    mapping(address => uint256) public shortfallOwed;
    /// @notice Aggregate of all outstanding shortfall claims. Reserved against the
    ///         contract's TOWELI balance so `withdrawToTreasury()` cannot drain
    ///         funds owed to shortfall claimants.
    uint256 public totalShortfallOwed;

    // ─── Timelock Constants ──────────────────────────────────────────
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    address public pendingTreasury;
    uint256 public pendingMonthlyFee;

    event Subscribed(address indexed user, uint256 months, uint256 paid, uint256 expiresAt);
    event NFTAccessGranted(address indexed user);
    event NFTAccessRevoked(address indexed user);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event SubscriptionCancelled(address indexed user, uint256 refundAmount, uint256 remainingTime); // SECURITY FIX #17
    /// @notice AUDIT FIX: DEEP-DR-M-05 — emitted when cancelSubscription's
    ///         contractBalance cap fires. Off-chain monitoring should alert on this.
    event RefundShorted(address indexed user, uint256 expected, uint256 actual);
    /// @notice AUDIT FIX: DEEP-DR-M-05 — emitted when a user claims a previously
    ///         shorted refund via `claimShortfall()`.
    event ShortfallClaimed(address indexed user, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury); // SECURITY FIX #19
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter); // AUDIT FIX #68
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury); // AUDIT FIX #68
    event TreasuryChangeCancelled(address cancelledTreasury);
    event FeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);

    error ZeroAddress();
    error ZeroMonths();
    error InsufficientPayment();
    error NoActiveSubscription(); // SECURITY FIX #17
    error RefundFailed(); // SECURITY FIX #17
    error UseProposeTreasuryChange(); // AUDIT FIX #68
    error ZeroFee(); // AUDIT FIX H-06
    error MinHoldingNotMet(); // AUDIT R014: cancel before MIN_HOLDING_PERIOD
    error NothingToClaim(); // AUDIT FIX: DEEP-DR-M-05 — claimShortfall called with no balance available

    // Legacy error aliases (kept for test compatibility)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error NoPendingTreasuryChange();
    error TreasuryChangeNotReady();
    error NoPendingFeeChange();
    error FeeChangeNotReady();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function feeChangeTime() external view returns (uint256) { return _executeAfter[FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }

    constructor(address _toweli, address _jbacNFT, address _treasury, uint256 _monthlyFee) OwnableNoRenounce(msg.sender) {
        if (_toweli == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        // AUDIT FIX: Prevent zero fee in constructor (proposeFeeChange already blocks zero)
        if (_monthlyFee == 0) revert ZeroFee();
        toweli = IERC20(_toweli);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        monthlyFeeToweli = _monthlyFee;
    }

    /// @notice Check if a user has premium access (current NFT holder OR active subscription)
    /// @dev NFT ownership is checked at query time to prevent flash loan exploits.
    ///      User must currently hold the NFT — previous ownership does not grant access.
    ///      SECURITY FIX M-13: Downstream contracts should use hasPremiumSecure() if flash loan
    ///      resistance is needed. This view function alone cannot prevent same-block flash borrow.
    /// @notice ⚠️ DEPRECATED FOR ON-CHAIN GATING — use hasPremiumSecure() instead.
    /// @dev This function returns `true` for any address that currently holds a JBAC NFT
    ///      AND has an `activateNFTPremium()` timestamp >= MIN_ACTIVATION_DELAY (15s) ago.
    ///      An attacker can:
    ///        1. Hold a JBAC NFT legitimately, call activateNFTPremium(), wait 15s.
    ///        2. Sell or transfer the NFT.
    ///        3. Within the next 10 minutes (deactivateNFTPremium grace window),
    ///           flash-loan-borrow the NFT in a single tx.
    ///        4. hasPremium() returns true for the duration of that tx.
    ///      THIS IS A KNOWN, ACCEPTED LIMITATION OF ERC-721 (no historical balance query).
    ///      hasPremiumSecure() returns true ONLY for subscription-based access, which
    ///      requires upfront TOWELI escrow and is inherently multi-block — flash-loan
    ///      resistant. Pure JBAC holders without an active subscription are NOT covered
    ///      by hasPremiumSecure().
    ///
    ///      Internal consumers (SwapFeeRouter) correctly use hasPremiumSecure(). External
    ///      integrators MUST do the same for any valuable on-chain gating.
    ///
    ///      AUDIT H-10 (post-batch-J reaffirmed): the flash-loan vector is real but
    ///      mitigated within this protocol. This NatSpec is the single point of
    ///      enforcement — DO NOT remove it without re-evaluating every consumer.
    // WARNING TO INTEGRATORS: Do NOT use hasPremium() for on-chain gating of valuable actions.
    // Use hasPremiumSecure() instead to prevent flash-loan NFT borrow attacks.
    function hasPremium(address user) external view returns (bool) {
        // A4-C-02: JBAC NFT holders must have activated in a PRIOR block to prevent flash-loan attacks.
        // Activation persists — only needs to be done once while holding the NFT.
        // AUDIT FIX M-36: Use timestamp comparison for L2 compatibility
        if (jbacNFT.balanceOf(user) > 0 && nftActivationBlock[user] != 0 && block.timestamp > nftActivationBlock[user] + MIN_ACTIVATION_DELAY) {
            return true;
        }
        // Check time-based subscription
        Subscription memory sub = subscriptions[user];
        return sub.expiresAt > block.timestamp;
    }

    /// @notice Flash-loan-resistant premium check for subscription-based access.
    ///         NFT-based access is NOT flash-loan resistant — standard ERC721 has no
    ///         historical balance query. For on-chain gating requiring flash-loan resistance,
    ///         only subscription-based premium is considered secure.
    ///         A3-H-02 FIX: Removed false proofBlock check that gave false sense of security.
    /// @param user The address to check
    function hasPremiumSecure(address user) external view returns (bool) {
        // Subscription-based: always safe (multi-block by design, requires upfront TOWELI payment)
        Subscription memory sub = subscriptions[user];
        if (sub.expiresAt > block.timestamp) return true;
        // NFT-based: NOT flash-loan resistant. Only return true if subscription started
        // at least 1 block ago (subscription is multi-block by nature). For NFT holders
        // who also have an active subscription, the subscription check above covers them.
        // Pure NFT holders without a subscription are NOT covered by hasPremiumSecure.
        return false;
    }

    /// @notice A4-C-02: Activate NFT-based premium. Must be called while holding a JBAC NFT.
    ///         Premium takes effect in the NEXT block to prevent flash-loan exploits.
    ///         Only needs to be called once — activation persists across blocks.
    /// @notice Activate NFT-based premium. Automatically called in hasPremium if user holds JBAC.
    ///         AUDIT FIX M-37: Can also be called automatically by frontend on wallet connect.
    function activateNFTPremium() external {
        require(jbacNFT.balanceOf(msg.sender) > 0, "NO_JBAC_NFT");
        // AUDIT FIX M-36: Store timestamp instead of block.number for L2 compatibility
        nftActivationBlock[msg.sender] = block.timestamp;
        emit NFTAccessGranted(msg.sender);
    }

    /// @notice AUDIT FIX: Clear stale NFT activation for users who no longer hold a JBAC NFT.
    ///         Prevents flash-loan bypass by returning holders who activated in a prior session.
    ///         Requires activation to be at least 10 blocks old to prevent griefing during
    ///         temporary NFT transfers (marketplace listings, bridges, etc.)
    /// @dev    AUDIT PA-L-02 (2026-04-28): the 10-minute grace window is INTENTIONAL to
    ///         smooth normal NFT-marketplace flows (list, brief settlement, hold).
    ///         During those 10 minutes after the user no longer holds the NFT,
    ///         `hasPremium(user)` will still report true if their `nftActivationBlock`
    ///         is past `MIN_ACTIVATION_DELAY`. Downstream integrators MUST use
    ///         `hasPremiumSecure(user)` for any flash-loan-sensitive on-chain
    ///         gating — that variant is subscription-only and is multi-block by
    ///         construction. The grace window's economic risk is bounded to
    ///         non-valuable UI gating where the 10-minute window is a feature
    ///         (don't yank a user's premium UX during an in-flight marketplace
    ///         transaction).
    /// @param user The address to deactivate
    function deactivateNFTPremium(address user) external {
        uint256 activationBlock = nftActivationBlock[user];
        // AUDIT FIX M-36: Use timestamp comparison (10 minutes grace period instead of 10 blocks)
        if (activationBlock != 0 && jbacNFT.balanceOf(user) == 0 && block.timestamp > activationBlock + 10 minutes) {
            nftActivationBlock[user] = 0;
            emit NFTAccessRevoked(user);
        }
    }

    /// @notice Subscribe for X months by paying TOWELI
    ///         SECURITY FIX #17: Funds held in contract (not sent to treasury immediately)
    ///         to enable pro-rata refunds on cancellation.
    /// @param months Number of months to subscribe
    /// @param maxCost Maximum TOWELI the caller is willing to pay (front-running protection)
    function subscribe(uint256 months, uint256 maxCost) external nonReentrant whenNotPaused {
        if (months == 0) revert ZeroMonths();
        // AUDIT FIX (BATCH-I M23): cap `months` at 120 (10 years). Pre-fix,
        // unbounded `months` enabled (a) overflow grief on `monthlyFeeToweli * months`
        // when months ≈ type(uint256).max, and (b) post-extension `expiresAt`
        // landing near year-9999, making cancel-refund pro-rata round to zero.
        // 120 covers any realistic prepayment horizon.
        require(months <= 120, "MONTHS_TOO_HIGH");

        uint256 cost = monthlyFeeToweli * months;
        // AUDIT FIX M-11: Protect against fee front-running
        require(cost <= maxCost, "COST_EXCEEDS_MAX");
        // SECURITY FIX #17: Hold funds in contract for potential refund
        toweli.safeTransferFrom(msg.sender, address(this), cost);

        Subscription storage sub = subscriptions[msg.sender];
        bool isNewSub = sub.expiresAt <= block.timestamp;
        // AUDIT FIX M-18: Prevent same-block subscribe+cancel for free premium window
        require(sub.startedAt != block.timestamp || isNewSub, "ALREADY_SUBSCRIBED_THIS_BLOCK");
        // AUDIT FIX: DEEP-DR-L-05 — extensions must respect MIN_HOLDING_PERIOD.
        // `cancelSubscription` enforces it; `subscribe`'s extension branch did not.
        // The asymmetry let an attacker subscribe at fee rate F0, immediately extend
        // (locking F0 into a fresh per-period escrow) just before a `proposeFeeChange
        // → executeFeeChange` cycle, then cancel at the new rate. Closes the
        // rate-lock arbitrage by forcing extensions to wait the same 24h.
        require(isNewSub || block.timestamp >= sub.startedAt + MIN_HOLDING_PERIOD, "TOO_SOON_TO_EXTEND");
        uint256 startFrom = isNewSub ? block.timestamp : sub.expiresAt;

        // AUDIT PA-M-01 / R022 (2026-04-29): on extension, reset BOTH `startedAt`
        // AND `userEscrow` to a fresh per-period anchor. The old behavior kept
        // `startedAt` from the original subscription and rolled `remainingEscrow`
        // (the unconsumed pro-rata of the original period) into the new
        // `userEscrow`, so a user who extended early then cancelled immediately
        // recovered MORE than per-period pro-rata for the new period — drifting
        // the refund formula off the actual paid-cost-per-time invariant.
        //
        // Fix:
        //  1. Compute `remainingEscrow` from the OLD period the same way as before.
        //  2. Forfeit the unconsumed remainder into earned revenue (credit it to
        //     `totalRevenue`, drop it from `totalRefundEscrow`). This is the
        //     "user paid for it, the protocol earned it on extension" treatment
        //     — matches the user-mental-model of "I am committing to a fresh
        //     period now, the previous period's leftover is non-refundable".
        //  3. Reset `startedAt = block.timestamp` and `userEscrow = cost`. The
        //     refund formula then uses a clean (cost, startedAt, expiresAt)
        //     triple identical to a brand-new subscription.
        // CRITICAL: Calculate remaining escrow BEFORE updating expiresAt to avoid using stale values
        if (!isNewSub) {
            // Calculate remaining escrow from current period using OLD expiresAt.
            uint256 remainingTime = sub.expiresAt - block.timestamp;
            uint256 totalDuration = sub.expiresAt - sub.startedAt;
            // SECURITY FIX M-14: Explicit handling for totalDuration == 0 (extension in same block).
            // If subscribed and extended in the same block, no time has elapsed so full escrow remains.
            uint256 remainingEscrow = totalDuration > 0 ? (userEscrow[msg.sender] * remainingTime) / totalDuration : userEscrow[msg.sender];

            // AUDIT FIX: DEEP-DR-M-06 — pro-rate extension fairly. The unconsumed portion
            // of the OLD escrow is credited BACK to the user via the new `userEscrow`
            // anchor — NOT forfeit to `totalRevenue`. PA-M-01 originally forfeit it, but
            // that converted user funds into ungated owner revenue with no rate-limit
            // (the owner could pull it via `withdrawToTreasury` in the same block).
            //
            // The "consumed" portion (escrow * elapsed / oldDuration) IS revenue — the
            // subscriber received the service for that time. The "unconsumed" portion
            // remains the user's escrow against a future cancellation/refund.
            //
            // New per-period anchor:
            //   userEscrow[msg.sender] = cost + remainingEscrow
            //   totalRevenue           += consumedEscrow (only)
            //   totalRefundEscrow      drops oldEscrow, adds (cost + remainingEscrow)
            uint256 oldEscrow = userEscrow[msg.sender];
            // AUDIT FIX PASS5-PA-L1: `consumedEscrow` no longer needed (the previous
            // `totalRevenue += consumedEscrow;` is removed below — the original cost
            // was already counted at first subscribe). Drop the local to avoid an
            // unused-variable warning.
            if (oldEscrow > 0) {
                totalRefundEscrow = totalRefundEscrow > oldEscrow
                    ? totalRefundEscrow - oldEscrow
                    : 0;
            }
            // AUDIT FIX PASS5-PA-L1: do NOT add `consumedEscrow` to `totalRevenue` here.
            // The original `cost1` paid at first-subscribe was already counted in
            // `totalRevenue` (line 345 below ran on the original subscribe). Adding
            // `consumedEscrow` again at extension would double-count: the consumed slice
            // was already attributed at the original subscribe's `totalRevenue += cost1`.
            // Trace: subscribe(cost1) → totalRevenue=cost1; extend(cost2) at half-period →
            // pre-fix would add consumedEscrow=cost1/2 here, then `cost2` at line 345,
            // for totalRevenue=cost1 + cost1/2 + cost2; correct value is cost1+cost2.
            // The drift was upward (LOW severity — refund cap stays satisfied), but
            // off-chain dashboards / governance proposals citing `totalRevenue` were over-
            // reporting. Removing the increment makes the high-water-mark semantic
            // consistent: every sat that ever entered the contract is counted exactly
            // once at first ingress.

            // Anchor the fresh per-period state — credit unconsumed back to user.
            sub.expiresAt = startFrom + (months * MONTH);
            sub.startedAt = block.timestamp;
            userEscrow[msg.sender] = cost + remainingEscrow;
            totalRefundEscrow += cost + remainingEscrow;
        } else {
            // AUDIT FIX H-04: Clear expired escrow from totalRefundEscrow before adding new
            uint256 oldEscrow = userEscrow[msg.sender];
            if (oldEscrow > 0) {
                totalRefundEscrow = totalRefundEscrow > oldEscrow ? totalRefundEscrow - oldEscrow : 0;
            }
            sub.expiresAt = startFrom + (months * MONTH);
            sub.startedAt = block.timestamp;
            userEscrow[msg.sender] = cost;
            totalRefundEscrow += cost;
        }

        totalPaidByUser[msg.sender] += cost;
        // AUDIT PA-M-02 (2026-04-29): paidFeeRate write removed — was never read in refund.
        // AUDIT FIX L-04: Only increment when transitioning from inactive to active
        if (!isActiveSubscriber[msg.sender]) {
            isActiveSubscriber[msg.sender] = true;
            totalSubscribers++;
        }
        // M-06: Always increment totalRevenue, including on extensions
        totalRevenue += cost;

        emit Subscribed(msg.sender, months, cost, sub.expiresAt);
    }

    /// @notice SECURITY FIX #17: Cancel subscription and receive pro-rata refund for unused time.
    ///         AUDIT FIX M-43: Refund uses userEscrow (actual amount paid at subscription-time fee rate),
    ///         not the current monthlyFeeToweli, so fee changes after subscription don't affect refunds.
    /// @notice AUDIT M10: cancelSubscription is intentionally callable while paused so
    ///         subscribers can always recover their pro-rata refund during emergencies.
    function cancelSubscription() external nonReentrant {
        Subscription storage sub = subscriptions[msg.sender];
        if (sub.expiresAt <= block.timestamp) revert NoActiveSubscription();
        // AUDIT FIX M-18: Prevent same-block subscribe+cancel to avoid free premium window exploit
        require(block.timestamp > sub.startedAt, "SAME_BLOCK_CANCEL");
        // AUDIT R014 (MEDIUM): minimum 24h holding period — closes the
        // "subscribe in block N, gain premium gating, cancel in block N+1
        // for ~full refund" window that SAME_BLOCK_CANCEL alone left open.
        if (block.timestamp < sub.startedAt + MIN_HOLDING_PERIOD) revert MinHoldingNotMet();

        uint256 remainingTime = sub.expiresAt - block.timestamp;
        uint256 totalDuration = sub.expiresAt - sub.startedAt;

        // CRITICAL FIX: Proportional refund based on actual escrowed amount and remaining time
        uint256 escrowed = userEscrow[msg.sender];
        // AUDIT FIX v3: If cancelled in same block as subscription, refund full escrow (totalDuration == 0)
        uint256 refundAmount = totalDuration == 0 ? escrowed : (escrowed * remainingTime) / totalDuration;

        // Cap refund at userEscrow (can't refund more than deposited)
        if (refundAmount > escrowed) {
            refundAmount = escrowed;
        }

        // Cap refund to contract balance to be safe
        // AUDIT FIX: DEEP-DR-M-05 — when the contractBalance cap fires, record the
        // shortfall in `shortfallOwed[user]` so the user retains an on-chain claim
        // against future contract balance. Without this, userEscrow is fully zeroed
        // below but the user silently loses the missing portion. Add a loud event
        // so off-chain monitoring detects insolvency immediately.
        uint256 contractBalance = toweli.balanceOf(address(this));
        if (refundAmount > contractBalance) {
            uint256 shortfall = refundAmount - contractBalance;
            refundAmount = contractBalance;
            shortfallOwed[msg.sender] += shortfall;
            totalShortfallOwed += shortfall;
            emit RefundShorted(msg.sender, refundAmount + shortfall, refundAmount);
        }

        // End subscription immediately
        sub.expiresAt = block.timestamp;
        // AUDIT FIX L-04: Only decrement when transitioning from active to inactive
        if (isActiveSubscriber[msg.sender]) {
            isActiveSubscriber[msg.sender] = false;
            totalSubscribers--;
        }

        // CRITICAL FIX: Decrease totalRefundEscrow by the actual refund amount + consumed portion
        // The entire user escrow is no longer refundable (subscription is cancelled)
        if (escrowed <= totalRefundEscrow) {
            totalRefundEscrow -= escrowed;
        } else {
            totalRefundEscrow = 0;
        }
        userEscrow[msg.sender] = 0;
        // AUDIT PA-M-02 (2026-04-29): paidFeeRate clear removed — was never read in refund.

        if (refundAmount > 0) {
            // AUDIT FIX: V2-DR-L-03 — decrement `totalRevenue` by the FULL
            // pro-rata refundable portion (immediate refund + recorded
            // shortfall) rather than just the immediately-paid `refundAmount`.
            // The contract is committed to honor the shortfall via
            // `claimShortfall`, so the shortfall portion is no longer "earned"
            // revenue from the protocol's perspective. Without this,
            // `totalRevenue` drifts as a high-water-mark counter (claimShortfall
            // now also decrements). Reconstruct the full pre-cap refundable
            // amount from the original formula. Cap the decrement at
            // `totalRevenue` to avoid underflow on edge cases (e.g. revenue
            // already drawn down by a prior withdrawToTreasury sequence).
            uint256 fullRefundable = totalDuration == 0
                ? escrowed
                : (escrowed * remainingTime) / totalDuration;
            if (fullRefundable > escrowed) fullRefundable = escrowed;
            if (fullRefundable <= totalRevenue) {
                totalRevenue -= fullRefundable;
            } else {
                totalRevenue = 0;
            }
            toweli.safeTransfer(msg.sender, refundAmount);
        }

        emit SubscriptionCancelled(msg.sender, refundAmount, remainingTime);
    }

    /// @notice AUDIT FIX H-04: Reconcile expired subscriptions to free locked totalRefundEscrow.
    ///         Anyone can call this for any user whose subscription has expired.
    /// @dev    AUDIT PA-L-01 (2026-04-28): nonReentrant added for parity with the sister
    ///         `batchReconcileExpired` and `cancelSubscription`, both of which mutate the same
    ///         `totalRefundEscrow` / `userEscrow` state under nonReentrant. Pure defense-in-depth
    ///         (no token transfer happens in this function today), but guards against any
    ///         future code path that adds an external interaction here.
    function reconcileExpired(address _user) external nonReentrant {
        Subscription memory sub = subscriptions[_user];
        if (sub.expiresAt > block.timestamp) return; // Still active, nothing to do
        uint256 escrow = userEscrow[_user];
        if (escrow == 0) return; // Already reconciled
        totalRefundEscrow = totalRefundEscrow > escrow ? totalRefundEscrow - escrow : 0;
        userEscrow[_user] = 0;
        // Clean up active subscriber tracking
        if (isActiveSubscriber[_user]) {
            isActiveSubscriber[_user] = false;
            if (totalSubscribers > 0) totalSubscribers--;
        }
    }

    /// @notice A4-H-08: Batch reconcile multiple expired subscriptions in one call.
    ///         Prevents totalRefundEscrow from permanently inflating and locking treasury funds.
    /// @dev    AUDIT M-30: nonReentrant added for parity with cancelSubscription, which
    ///         mutates the same totalRefundEscrow / userEscrow state. Defense-in-depth
    ///         against any future caller that gains control during a state-modifying tx.
    function batchReconcileExpired(address[] calldata _users) external nonReentrant {
        for (uint256 i = 0; i < _users.length; i++) {
            address user = _users[i];
            Subscription memory sub = subscriptions[user];
            if (sub.expiresAt > block.timestamp) continue; // Still active
            uint256 escrow = userEscrow[user];
            if (escrow == 0) continue; // Already reconciled
            totalRefundEscrow = totalRefundEscrow > escrow ? totalRefundEscrow - escrow : 0;
            userEscrow[user] = 0;
            if (isActiveSubscriber[user]) {
                isActiveSubscriber[user] = false;
                if (totalSubscribers > 0) totalSubscribers--;
            }
        }
    }

    /// @notice Owner can withdraw earned (non-refundable) subscription fees to treasury
    ///         SECURITY FIX #3: Only withdraws balance minus escrowed refund amounts
    // AUDIT FIX: Added nonReentrant for defense-in-depth
    function withdrawToTreasury() external onlyOwner nonReentrant {
        uint256 balance = toweli.balanceOf(address(this));
        // AUDIT FIX: DEEP-DR-M-05 — reserve `totalShortfallOwed` so users with a
        // shorted refund can still claim from the contract balance. Otherwise, the
        // owner could pull the recovered balance straight to treasury and leave
        // shortfall claimants with no funds to claim against.
        uint256 reserved = totalRefundEscrow + totalShortfallOwed;
        uint256 withdrawable = balance > reserved ? balance - reserved : 0;
        if (withdrawable > 0) {
            toweli.safeTransfer(treasury, withdrawable);
        }
    }

    /// @notice AUDIT FIX: DEEP-DR-M-05 — claim a previously-shorted refund once
    ///         contract balance has been restored (e.g. via revenue accrual).
    ///         The claim is capped by current balance; if balance is still
    ///         insufficient the unpaid remainder stays recorded for a future call.
    function claimShortfall() external nonReentrant {
        uint256 owed = shortfallOwed[msg.sender];
        if (owed == 0) revert NothingToClaim();
        uint256 balance = toweli.balanceOf(address(this));
        // Reserve other obligations so this claim cannot starve them.
        uint256 reserved = totalRefundEscrow + totalShortfallOwed - owed;
        uint256 available = balance > reserved ? balance - reserved : 0;
        if (available == 0) revert NothingToClaim();
        uint256 payout = owed > available ? available : owed;
        shortfallOwed[msg.sender] = owed - payout;
        totalShortfallOwed -= payout;
        // AUDIT FIX V3-DR3-M-02: REMOVED the `totalRevenue` decrement here.
        // V2-DR-L-03 added it for "accounting parity" but `cancelSubscription`
        // ALREADY decrements `totalRevenue` by the full refundable amount —
        // including the slice that's being shortfall-deferred. Decrementing
        // again on `claimShortfall` was a double-decrement: an aggressive
        // pattern of cancel + shortfall + later claim drove `totalRevenue`
        // toward 0 below the true unspent revenue. With V3 in place,
        // `totalRevenue` is decremented exactly once per refund-cycle (at
        // cancelSubscription time); the shortfall claim is a deferred payout
        // that doesn't touch the counter.
        // V3-DR3-M-02: do NOT decrement totalRevenue (cancelSubscription owns it).
        toweli.safeTransfer(msg.sender, payout);
        emit ShortfallClaimed(msg.sender, payout);
    }

    /// @notice DEPRECATED: NFT access is now checked dynamically at query time.
    ///         Users holding a JBAC NFT automatically have premium — no claim needed.
    ///         Use hasPremium() or subscribe() instead.
    function claimNFTAccess() external pure {
        // AUDIT FIX: Updated deprecation message to reference hasPremiumSecure() for on-chain use
        revert("DEPRECATED: Use hasPremiumSecure() for on-chain or hasPremium() for off-chain");
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice DEPRECATED: Use proposeFeeChange() + executeFeeChange()
    function setMonthlyFee(uint256) external pure {
        revert("Use proposeFeeChange()");
    }

    // SECURITY FIX M-3: Emergency pause/unpause (OpenZeppelin Pausable pattern).
    // Halts subscribe() and cancelSubscription() during security incidents.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice AUDIT FIX v2: Propose a monthly fee change (takes effect after 24h delay)
    function proposeFeeChange(uint256 _fee) external onlyOwner {
        if (_fee == 0) revert ZeroFee();
        pendingMonthlyFee = _fee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(monthlyFeeToweli, _fee, _executeAfter[FEE_CHANGE]);
    }

    /// @notice AUDIT FIX v2: Execute a previously proposed fee change after the timelock
    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = monthlyFeeToweli;
        monthlyFeeToweli = pendingMonthlyFee;
        pendingMonthlyFee = 0;
        emit FeeUpdated(old, monthlyFeeToweli);
    }

    /// @notice Cancel a pending fee change
    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingMonthlyFee;
        pendingMonthlyFee = 0;
        emit FeeChangeCancelled(cancelled);
    }

    /// @notice DEPRECATED: Use proposeTreasuryChange() + executeTreasuryChange() instead.
    ///         AUDIT FIX #68: Single-step treasury change replaced with 48h timelocked 2-step pattern.
    function setTreasury(address) external pure {
        revert UseProposeTreasuryChange();
    }

    /// @notice AUDIT FIX #68: Propose a treasury change (takes effect after 48h delay)
    /// @param _treasury The proposed new treasury address
    function proposeTreasuryChange(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_treasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Cancel a pending treasury change proposal
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice AUDIT FIX #68: Execute a previously proposed treasury change after the timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeExecuted(old, treasury);
    }

    // ─── View ─────────────────────────────────────────────────────────

    function getSubscription(address user) external view returns (uint256 expiresAt, bool lifetime, bool active) {
        Subscription memory sub = subscriptions[user];
        bool nftHolder = jbacNFT.balanceOf(user) > 0;
        // lifetime is true only if user currently holds NFT (checked at query time)
        return (sub.expiresAt, nftHolder, nftHolder || sub.expiresAt > block.timestamp);
    }

    /// @notice AUDIT FIX: DEEP-DR-L-01 — read-only view onto the orphaned
    ///         `_deprecated_paidFeeRate_slot` (PA-M-02 made the mapping private but
    ///         left existing on-chain state inaccessible). Off-chain analytics can
    ///         use this to recover historical fee-rate data for legacy subscribers.
    /// @param user The address whose deprecated paidFeeRate slot to read
    /// @return The deprecated paidFeeRate value (zero for fresh deployments / new users)
    function getDeprecatedPaidFeeRate(address user) external view returns (uint256) {
        return _deprecated_paidFeeRate_slot[user];
    }
}
