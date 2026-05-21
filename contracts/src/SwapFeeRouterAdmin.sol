// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to SwapFeeRouter for the admin's apply hooks.
///         Each `apply*` setter is `onlyAdmin` on the router side.
interface ISwapFeeRouterApply {
    function applyFee(uint256 newFee) external;
    function applyTreasury(address newTreasury) external;
    function applyReferralSplitter(address newSplitter) external;
    /// @dev AUDIT R-014 M-1: canonical per-input-token override hook.
    function applyInputTokenFee(address inputToken, uint256 newFeeBps, bool removal) external;
    /// @dev AUDIT SFR-M-03 (MEDIUM, 2026-04-28): the legacy `applyPairFee` alias on the
    ///      router is now a hard revert (DeprecatedUseInputTokenFee). The interface
    ///      reference is removed so the admin cannot accidentally route through it
    ///      and brick a pending pair-fee change at execute time.
    function applyPremiumDiscount(uint256 newDiscountBps) external;
    function applyPremiumAccess(address newAccess) external;
    function applyFeeSplit(uint256 stakerShareBps_, uint256 polShareBps_) external;
    function applyPolAccumulator(address newAccumulator) external;
    function applyRevenueDistributor(address newDistributor) external;
    function MAX_FEE_BPS() external view returns (uint256);
    function MAX_PREMIUM_DISCOUNT_BPS() external view returns (uint256);
    function MIN_STAKER_SHARE_BPS() external view returns (uint256);
    function MAX_POL_SHARE_BPS() external view returns (uint256);
    function BPS() external view returns (uint256);
    function feeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function referralSplitter() external view returns (address);
    function premiumDiscountBps() external view returns (uint256);
    function premiumAccess() external view returns (address);
    function stakerShareBps() external view returns (uint256);
    function polShareBps() external view returns (uint256);
    function polAccumulator() external view returns (address);
    function revenueDistributor() external view returns (address);
}

/// @title SwapFeeRouterAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on SwapFeeRouter. Dispatches the actual writes
///         to SwapFeeRouter via its `applyXxx` setters (onlyAdmin gated).
/// @dev    Created during the Wave-1 size-reduction sprint (2026-04-26) to bring
///         SwapFeeRouter under the 24,576-byte EIP-170 limit. Functional
///         semantics (delays, ceilings, validity windows) are unchanged.
contract SwapFeeRouterAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error SplitInvalid();
    error StakerShareTooLow();
    error PolShareTooHigh();
    /// @notice AUDIT SFR-M-03 (MEDIUM, 2026-04-28): deprecated mutative aliases (the
    ///         legacy `proposePairFeeChange` / `executePairFeeChange` /
    ///         `cancelPairFeeChange` triplet) revert with this so callers migrate to
    ///         the canonical `proposeInputTokenFeeChange` / `executeInputTokenFeeChange`
    ///         / `cancelInputTokenFeeChange` flow. Selectors preserved on the ABI.
    error DeprecatedUseInputTokenFee();

    // ─── Timelock keys ────────────────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant REFERRAL_CHANGE = keccak256("REFERRAL_CHANGE");
    bytes32 public constant PAIR_FEE_CHANGE = keccak256("PAIR_FEE_CHANGE");
    bytes32 public constant PREMIUM_DISCOUNT_CHANGE = keccak256("PREMIUM_DISCOUNT_CHANGE");
    bytes32 public constant PREMIUM_ACCESS_CHANGE = keccak256("PREMIUM_ACCESS_CHANGE");
    bytes32 public constant REV_DIST_CHANGE = keccak256("REV_DIST_CHANGE");
    bytes32 public constant FEE_SPLIT_CHANGE = keccak256("FEE_SPLIT_CHANGE");
    bytes32 public constant POL_ACCUMULATOR_CHANGE = keccak256("POL_ACCUMULATOR_CHANGE");

    // ─── Delays (mirror what SwapFeeRouter previously enforced) ───────
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant REFERRAL_CHANGE_DELAY = 48 hours;
    uint256 public constant PAIR_FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant PREMIUM_DISCOUNT_CHANGE_DELAY = 24 hours;
    uint256 public constant PREMIUM_ACCESS_CHANGE_DELAY = 48 hours;
    uint256 public constant REV_DIST_CHANGE_DELAY = 48 hours;
    uint256 public constant FEE_SPLIT_CHANGE_DELAY = 48 hours;
    uint256 public constant POL_ACCUMULATOR_CHANGE_DELAY = 48 hours;

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingReferralSplitter;
    address public pendingPairFeeAddress;
    uint256 public pendingPairFeeBps;
    bool public pendingPairFeeRemoval;
    uint256 public pendingPremiumDiscountBps;
    address public pendingPremiumAccess;
    address public pendingRevenueDistributor;
    uint256 public pendingStakerShareBps;
    uint256 public pendingPolShareBps;
    address public pendingPolAccumulator;

    // ─── Wired router ─────────────────────────────────────────────────
    ISwapFeeRouterApply public immutable router;

    // ─── Events (mirror those previously emitted by SwapFeeRouter) ────
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address cancelledTreasury);
    event ReferralSplitterChangeProposed(address indexed newSplitter, uint256 executeAfter);
    event ReferralSplitterChangeCancelled(address indexed cancelled);
    /// @notice AUDIT R-014 M-1: canonical event for the per-input-token override
    ///         proposal. Indexers should subscribe to this event going forward; the
    ///         legacy `PairFeeChangeProposed` is emitted alongside for ABI compat.
    event InputTokenFeeChangeProposed(address indexed inputToken, uint256 feeBps, bool removal, uint256 executeAfter);
    /// @dev DEPRECATED — emitted alongside `InputTokenFeeChangeProposed`.
    event PairFeeChangeProposed(address indexed pair, uint256 feeBps, bool removal, uint256 executeAfter);
    /// @notice AUDIT R-014 M-1: canonical cancellation event.
    event InputTokenFeeChangeCancelled(address indexed inputToken);
    /// @dev DEPRECATED — emitted alongside `InputTokenFeeChangeCancelled`.
    event PairFeeChangeCancelled(address indexed pair);
    event PremiumDiscountChangeProposed(uint256 newDiscount, uint256 executeAfter);
    event PremiumDiscountChangeCancelled(uint256 cancelledDiscount);
    event PremiumAccessChangeProposed(address indexed newAccess, uint256 executeAfter);
    event PremiumAccessChangeCancelled(address indexed cancelledAccess);
    event RevenueDistributorChangeProposed(address indexed newDistributor, uint256 executeAfter);
    event RevenueDistributorChangeCancelled(address indexed cancelledDistributor);
    event FeeSplitChangeProposed(uint256 stakerShareBps, uint256 polShareBps, uint256 executeAfter);
    event FeeSplitChangeCancelled();
    event PolAccumulatorChangeProposed(address indexed newAccumulator, uint256 executeAfter);
    event PolAccumulatorChangeCancelled(address indexed cancelled);

    constructor(address _router) OwnableNoRenounce(msg.sender) {
        if (_router == address(0)) revert ZeroAddress();
        router = ISwapFeeRouterApply(_router);
    }

    // ─── Fee ──────────────────────────────────────────────────────────
    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > router.MAX_FEE_BPS()) revert FeeTooHigh();
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(router.feeBps(), newFee, _executeAfter[FEE_CHANGE]);
    }

    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 v = pendingFeeBps;
        pendingFeeBps = 0;
        router.applyFee(v);
    }

    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeChangeCancelled(cancelled);
    }

    function feeChangeTime() external view returns (uint256) {
        return _executeAfter[FEE_CHANGE];
    }

    // ─── Treasury ─────────────────────────────────────────────────────
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address v = pendingTreasury;
        pendingTreasury = address(0);
        router.applyTreasury(v);
    }

    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    function treasuryChangeTime() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Referral splitter ────────────────────────────────────────────
    function proposeReferralSplitterChange(address _newSplitter) external onlyOwner {
        // address(0) allowed to disable
        pendingReferralSplitter = _newSplitter;
        _propose(REFERRAL_CHANGE, REFERRAL_CHANGE_DELAY);
        emit ReferralSplitterChangeProposed(_newSplitter, _executeAfter[REFERRAL_CHANGE]);
    }

    function executeReferralSplitterChange() external onlyOwner {
        _execute(REFERRAL_CHANGE);
        address v = pendingReferralSplitter;
        pendingReferralSplitter = address(0);
        router.applyReferralSplitter(v);
    }

    function cancelReferralSplitterChange() external onlyOwner {
        _cancel(REFERRAL_CHANGE);
        address cancelled = pendingReferralSplitter;
        pendingReferralSplitter = address(0);
        emit ReferralSplitterChangeCancelled(cancelled);
    }

    function referralSplitterChangeTime() external view returns (uint256) {
        return _executeAfter[REFERRAL_CHANGE];
    }

    // ─── Per-input-token fee override ─────────────────────────────────
    /// @notice AUDIT R-014 M-1: canonical propose entry-point. The `inputToken`
    ///         argument is the swap path's `path[0]` — every swap that begins with
    ///         this token will pay `newFeeBps` instead of the global fee. Replaces
    ///         the legacy `proposePairFeeChange` whose name caused admins to
    ///         assume per-pair scoping. Emits both `InputTokenFeeChangeProposed`
    ///         (canonical) and `PairFeeChangeProposed` (legacy, ABI-compat).
    function proposeInputTokenFeeChange(address inputToken, uint256 newFeeBps, bool removal) public onlyOwner {
        if (inputToken == address(0)) revert ZeroAddress();
        if (!removal && newFeeBps > router.MAX_FEE_BPS()) revert FeeTooHigh();
        pendingPairFeeAddress = inputToken;
        pendingPairFeeBps = newFeeBps;
        pendingPairFeeRemoval = removal;
        _propose(PAIR_FEE_CHANGE, PAIR_FEE_CHANGE_DELAY);
        emit InputTokenFeeChangeProposed(inputToken, newFeeBps, removal, _executeAfter[PAIR_FEE_CHANGE]);
        emit PairFeeChangeProposed(inputToken, newFeeBps, removal, _executeAfter[PAIR_FEE_CHANGE]);
    }

    /// @notice DEPRECATED — was a thin alias for `proposeInputTokenFeeChange`. The
    ///         `pair` parameter was actually the input-token address (`path[0]`); the
    ///         misleading legacy name caused the AUDIT R-014 M-1 finding.
    /// @dev    AUDIT SFR-M-03 (MEDIUM, 2026-04-28): the alias is now a HARD revert.
    ///         Selectors are preserved on the ABI so any in-flight automation that
    ///         still calls this function fails LOUDLY with `DeprecatedUseInputTokenFee`
    ///         instead of silently inheriting the canonical behaviour. Migrate to
    ///         `proposeInputTokenFeeChange`.
    function proposePairFeeChange(address, uint256, bool) external pure {
        revert DeprecatedUseInputTokenFee();
    }

    /// @notice AUDIT R-014 M-1: canonical execute entry-point. Routes through the
    ///         router's new `applyInputTokenFee` setter so on-chain monitors see
    ///         the canonical event without the deprecation chirp.
    function executeInputTokenFeeChange() public onlyOwner {
        _execute(PAIR_FEE_CHANGE);
        address inputToken = pendingPairFeeAddress;
        uint256 bps = pendingPairFeeBps;
        bool removal = pendingPairFeeRemoval;
        pendingPairFeeAddress = address(0);
        pendingPairFeeBps = 0;
        pendingPairFeeRemoval = false;
        router.applyInputTokenFee(inputToken, bps, removal);
    }

    /// @notice DEPRECATED — was an alias for `executeInputTokenFeeChange`.
    /// @dev    AUDIT SFR-M-03 (MEDIUM, 2026-04-28): hard revert; see
    ///         `proposePairFeeChange` above. Use `executeInputTokenFeeChange`.
    function executePairFeeChange() external pure {
        revert DeprecatedUseInputTokenFee();
    }

    /// @notice AUDIT R-014 M-1: canonical cancel entry-point.
    function cancelInputTokenFeeChange() public onlyOwner {
        _cancel(PAIR_FEE_CHANGE);
        address cancelled = pendingPairFeeAddress;
        pendingPairFeeAddress = address(0);
        pendingPairFeeBps = 0;
        pendingPairFeeRemoval = false;
        emit InputTokenFeeChangeCancelled(cancelled);
        emit PairFeeChangeCancelled(cancelled);
    }

    /// @notice DEPRECATED — was an alias for `cancelInputTokenFeeChange`.
    /// @dev    AUDIT SFR-M-03 (MEDIUM, 2026-04-28): hard revert; see
    ///         `proposePairFeeChange` above. Use `cancelInputTokenFeeChange`.
    function cancelPairFeeChange() external pure {
        revert DeprecatedUseInputTokenFee();
    }

    function pairFeeChangeTime() external view returns (uint256) {
        return _executeAfter[PAIR_FEE_CHANGE];
    }

    /// @notice AUDIT R-014 M-1: canonical view-helper alias.
    function inputTokenFeeChangeTime() external view returns (uint256) {
        return _executeAfter[PAIR_FEE_CHANGE];
    }

    // ─── Premium discount ─────────────────────────────────────────────
    function proposePremiumDiscountChange(uint256 newDiscountBps) external onlyOwner {
        require(newDiscountBps <= router.MAX_PREMIUM_DISCOUNT_BPS(), "DISCOUNT_TOO_HIGH");
        pendingPremiumDiscountBps = newDiscountBps;
        _propose(PREMIUM_DISCOUNT_CHANGE, PREMIUM_DISCOUNT_CHANGE_DELAY);
        emit PremiumDiscountChangeProposed(newDiscountBps, _executeAfter[PREMIUM_DISCOUNT_CHANGE]);
    }

    function executePremiumDiscountChange() external onlyOwner {
        _execute(PREMIUM_DISCOUNT_CHANGE);
        uint256 v = pendingPremiumDiscountBps;
        pendingPremiumDiscountBps = 0;
        router.applyPremiumDiscount(v);
    }

    function cancelPremiumDiscountChange() external onlyOwner {
        _cancel(PREMIUM_DISCOUNT_CHANGE);
        uint256 cancelled = pendingPremiumDiscountBps;
        pendingPremiumDiscountBps = 0;
        emit PremiumDiscountChangeCancelled(cancelled);
    }

    function premiumDiscountChangeTime() external view returns (uint256) {
        return _executeAfter[PREMIUM_DISCOUNT_CHANGE];
    }

    // ─── Premium access ───────────────────────────────────────────────
    function proposePremiumAccessChange(address _newAccess) external onlyOwner {
        // address(0) allowed to disable
        pendingPremiumAccess = _newAccess;
        _propose(PREMIUM_ACCESS_CHANGE, PREMIUM_ACCESS_CHANGE_DELAY);
        emit PremiumAccessChangeProposed(_newAccess, _executeAfter[PREMIUM_ACCESS_CHANGE]);
    }

    function executePremiumAccessChange() external onlyOwner {
        _execute(PREMIUM_ACCESS_CHANGE);
        address v = pendingPremiumAccess;
        pendingPremiumAccess = address(0);
        router.applyPremiumAccess(v);
    }

    function cancelPremiumAccessChange() external onlyOwner {
        _cancel(PREMIUM_ACCESS_CHANGE);
        address cancelled = pendingPremiumAccess;
        pendingPremiumAccess = address(0);
        emit PremiumAccessChangeCancelled(cancelled);
    }

    function premiumAccessChangeTime() external view returns (uint256) {
        return _executeAfter[PREMIUM_ACCESS_CHANGE];
    }

    // ─── Revenue distributor ──────────────────────────────────────────
    function proposeRevenueDistributor(address _newDistributor) external onlyOwner {
        if (_newDistributor == address(0)) revert ZeroAddress();
        pendingRevenueDistributor = _newDistributor;
        _propose(REV_DIST_CHANGE, REV_DIST_CHANGE_DELAY);
        emit RevenueDistributorChangeProposed(_newDistributor, _executeAfter[REV_DIST_CHANGE]);
    }

    function executeRevenueDistributor() external onlyOwner {
        _execute(REV_DIST_CHANGE);
        address v = pendingRevenueDistributor;
        pendingRevenueDistributor = address(0);
        router.applyRevenueDistributor(v);
    }

    function cancelRevenueDistributor() external onlyOwner {
        _cancel(REV_DIST_CHANGE);
        address cancelled = pendingRevenueDistributor;
        pendingRevenueDistributor = address(0);
        emit RevenueDistributorChangeCancelled(cancelled);
    }

    function revenueDistributorChangeTime() external view returns (uint256) {
        return _executeAfter[REV_DIST_CHANGE];
    }

    // ─── Fee split ────────────────────────────────────────────────────
    function proposeFeeSplit(uint256 _stakerShareBps, uint256 _polShareBps) external onlyOwner {
        uint256 minStaker = router.MIN_STAKER_SHARE_BPS();
        uint256 maxPol = router.MAX_POL_SHARE_BPS();
        uint256 bps = router.BPS();
        if (_stakerShareBps < minStaker) revert StakerShareTooLow();
        if (_polShareBps > maxPol) revert PolShareTooHigh();
        if (_stakerShareBps + _polShareBps > bps) revert SplitInvalid();
        pendingStakerShareBps = _stakerShareBps;
        pendingPolShareBps = _polShareBps;
        _propose(FEE_SPLIT_CHANGE, FEE_SPLIT_CHANGE_DELAY);
        emit FeeSplitChangeProposed(_stakerShareBps, _polShareBps, _executeAfter[FEE_SPLIT_CHANGE]);
    }

    function executeFeeSplit() external onlyOwner {
        _execute(FEE_SPLIT_CHANGE);
        uint256 s = pendingStakerShareBps;
        uint256 p = pendingPolShareBps;
        pendingStakerShareBps = 0;
        pendingPolShareBps = 0;
        router.applyFeeSplit(s, p);
    }

    function cancelFeeSplit() external onlyOwner {
        _cancel(FEE_SPLIT_CHANGE);
        pendingStakerShareBps = 0;
        pendingPolShareBps = 0;
        emit FeeSplitChangeCancelled();
    }

    function feeSplitChangeTime() external view returns (uint256) {
        return _executeAfter[FEE_SPLIT_CHANGE];
    }

    // ─── POL accumulator ──────────────────────────────────────────────
    function proposePolAccumulator(address _newAccumulator) external onlyOwner {
        // Zero address allowed — re-routes POL slice to treasury without changing BPS
        pendingPolAccumulator = _newAccumulator;
        _propose(POL_ACCUMULATOR_CHANGE, POL_ACCUMULATOR_CHANGE_DELAY);
        emit PolAccumulatorChangeProposed(_newAccumulator, _executeAfter[POL_ACCUMULATOR_CHANGE]);
    }

    function executePolAccumulator() external onlyOwner {
        _execute(POL_ACCUMULATOR_CHANGE);
        address v = pendingPolAccumulator;
        pendingPolAccumulator = address(0);
        router.applyPolAccumulator(v);
    }

    function cancelPolAccumulator() external onlyOwner {
        _cancel(POL_ACCUMULATOR_CHANGE);
        address cancelled = pendingPolAccumulator;
        pendingPolAccumulator = address(0);
        emit PolAccumulatorChangeCancelled(cancelled);
    }

    function polAccumulatorChangeTime() external view returns (uint256) {
        return _executeAfter[POL_ACCUMULATOR_CHANGE];
    }

    /// @notice AUDIT FIX 2026-05-21 M19-CLUSTER: override `acceptOwnership` so any
    ///         pending TIMELOCK_KEY proposals seeded by the outgoing owner are
    ///         CANCELLED automatically on handoff. Mirrors the canonical
    ///         TegridyNFTPoolFactory pattern (M19 fix, commit 0a08bff). Without
    ///         this override, a captured outgoing owner could `propose...`
    ///         immediately before `transferOwnership`, and the timer would silently
    ///         keep running under the new owner. A new-owner deploy/keeper script
    ///         reading `pending...()` could then execute the hostile change.
    /// @dev    Calls `super.acceptOwnership()` first so the pendingOwner→owner
    ///         promotion happens before the cancellations. PAIR_FEE_CHANGE emits
    ///         both canonical (`InputTokenFeeChangeCancelled`) and legacy
    ///         (`PairFeeChangeCancelled`) events for ABI-compat with R-014 M-1.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[FEE_CHANGE] != 0) {
            uint256 cancelled = pendingFeeBps;
            _cancel(FEE_CHANGE);
            pendingFeeBps = 0;
            emit FeeChangeCancelled(cancelled);
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelled = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelled);
        }
        if (_executeAfter[REFERRAL_CHANGE] != 0) {
            address cancelled = pendingReferralSplitter;
            _cancel(REFERRAL_CHANGE);
            pendingReferralSplitter = address(0);
            emit ReferralSplitterChangeCancelled(cancelled);
        }
        if (_executeAfter[PAIR_FEE_CHANGE] != 0) {
            address cancelled = pendingPairFeeAddress;
            _cancel(PAIR_FEE_CHANGE);
            pendingPairFeeAddress = address(0);
            pendingPairFeeBps = 0;
            pendingPairFeeRemoval = false;
            emit InputTokenFeeChangeCancelled(cancelled);
            emit PairFeeChangeCancelled(cancelled);
        }
        if (_executeAfter[PREMIUM_DISCOUNT_CHANGE] != 0) {
            uint256 cancelled = pendingPremiumDiscountBps;
            _cancel(PREMIUM_DISCOUNT_CHANGE);
            pendingPremiumDiscountBps = 0;
            emit PremiumDiscountChangeCancelled(cancelled);
        }
        if (_executeAfter[PREMIUM_ACCESS_CHANGE] != 0) {
            address cancelled = pendingPremiumAccess;
            _cancel(PREMIUM_ACCESS_CHANGE);
            pendingPremiumAccess = address(0);
            emit PremiumAccessChangeCancelled(cancelled);
        }
        if (_executeAfter[REV_DIST_CHANGE] != 0) {
            address cancelled = pendingRevenueDistributor;
            _cancel(REV_DIST_CHANGE);
            pendingRevenueDistributor = address(0);
            emit RevenueDistributorChangeCancelled(cancelled);
        }
        if (_executeAfter[FEE_SPLIT_CHANGE] != 0) {
            _cancel(FEE_SPLIT_CHANGE);
            pendingStakerShareBps = 0;
            pendingPolShareBps = 0;
            emit FeeSplitChangeCancelled();
        }
        if (_executeAfter[POL_ACCUMULATOR_CHANGE] != 0) {
            address cancelled = pendingPolAccumulator;
            _cancel(POL_ACCUMULATOR_CHANGE);
            pendingPolAccumulator = address(0);
            emit PolAccumulatorChangeCancelled(cancelled);
        }
    }
}
