// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to TegridyRestaking for the admin's apply hooks and
///         the propose-time pre-checks. Every `apply*` setter is `onlyAdmin` on
///         the restaking side, so this contract is the ONLY caller that can reach
///         them once `setRestakingAdmin` has wired it.
interface ITegridyRestakingApply {
    function applyBonusRate(uint256 _rate) external;
    function applyAttributeStuckRewards(address _restaker, uint256 _amount) external;
    function applySweepStuckRewards(address _token) external;
    function applyRescueNFT(uint256 _tokenId, address _to) external;
    function applyResidualClaimant(uint256 _tokenId, address _newClaimant) external;

    function maxBonusRewardRate() external view returns (uint256);
    function bonusRewardToken() external view returns (address);
    function rewardToken() external view returns (address);
    function tokenIdToRestaker(uint256 _tokenId) external view returns (address);
    function strandedRestakeRecipient(uint256 _tokenId) external view returns (address);
    function residualClaimant(uint256 _tokenId) external view returns (address);
    function restakers(address _user)
        external
        view
        returns (
            uint256 tokenId,
            uint256 positionAmount,
            uint256 boostedAmount,
            int256 bonusDebt,
            uint256 depositTime,
            uint256 unsettledSnapshot
        );
}

/// @title TegridyRestakingAdmin — Sister contract holding TegridyRestaking's timelocked admin flow
/// @notice Holds every propose/execute/cancel triplet, all pending state, the
///         timelock keys and delays, the anti-churn cooldown and the per-tokenId
///         residual-clear proposals for TegridyRestaking. The actual state writes
///         and every fund movement stay on the host behind its `applyXxx`
///         (`onlyAdmin`) setters — this contract only gates the delay.
/// @dev    EIP-170 split: TegridyRestaking measured 26,784 B against the 24,576-byte
///         ceiling and was therefore undeployable. Mirrors the split already proven
///         on this codebase by `TegridyStakingAdmin` / `SwapFeeRouterAdmin`.
///         Functional semantics (delays, ceilings, validity windows, check order,
///         error types) are unchanged from the pre-split host.
///
/// @dev    TRUST BOUNDARY: this contract owns no funds, has no pausable surface and
///         receives no callback, so it needs neither `PauseGuardian` nor
///         `ReentrancyGuard`. Calls are one-way (sister → host); the host's
///         `applyXxx` never calls back. The multisig is expected to own BOTH this
///         contract and the host: `onlyOwner` here means "the multisig", `onlyAdmin`
///         on the host means "the wired sister". Net authority at the multisig level
///         is identical to the pre-split contract.
///
/// @dev    EVENT RELOCATION: `*Proposed` / `*Cancelled` governance events now emit
///         from THIS address instead of the host. Topic hashes are unchanged (same
///         signatures), so an indexer filtering by topic still matches — but one
///         filtering by the host ADDRESS must add this address. The `*Executed`
///         events stay on the host, emitted at the site that actually moves the
///         value, so a log-level reader can never see an execution that did not
///         happen. Every fund event (Restaked / BonusClaimed / …) is untouched.
contract TegridyRestakingAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors (same names — therefore the same selectors — as the pre-split host) ──
    error ZeroAddress();
    error ZeroAmount();
    error BadParam();
    error RateTooHigh();
    error NotRestaked();
    error CannotSweepBonusToken();
    error CannotSweepRewardToken();
    error BonusRateActionCooldown();
    error NoPendingResidualClear();
    error ResidualClearTimelockNotElapsed();
    error ResidualClearExpired();

    // ─── Timelock keys (verbatim pre-images — the on-chain key values are unchanged) ──
    bytes32 public constant BONUS_RATE_CHANGE = keccak256("BONUS_RATE_CHANGE");
    bytes32 public constant ATTRIBUTION_CHANGE = keccak256("ATTRIBUTION_CHANGE");
    bytes32 public constant RESCUE_NFT_CHANGE = keccak256("RESCUE_NFT_CHANGE");
    bytes32 public constant SWEEP_STUCK_CHANGE = keccak256("RESTAKING_SWEEP_STUCK_REWARDS");

    // ─── Delays (verbatim from the pre-split host) ────────────────────────────
    uint256 public constant BONUS_RATE_TIMELOCK = 48 hours;
    uint256 public constant ATTRIBUTE_TIMELOCK = 24 hours;
    uint256 public constant SWEEP_STUCK_TIMELOCK = 24 hours;
    uint256 public constant RESCUE_NFT_TIMELOCK = 48 hours;
    /// @notice The residual-clear flow is NOT keyed through TimelockAdmin: it is
    ///         per-tokenId, so a single `bytes32` key could not hold more than one
    ///         live proposal. It keeps its own inline 7-day delay + 7-day validity.
    uint256 public constant CLEAR_RESIDUAL_TIMELOCK = 7 days;
    uint256 public constant CLEAR_RESIDUAL_VALIDITY = 7 days;
    /// @notice DEEP-DR-07: a captured signer must not be able to churn bonus-rate
    ///         state at sub-daily cadence. Gates propose only — DR2-05 leaves the
    ///         defensive cancel ungated so a multisig can always kill a hostile
    ///         proposal on sight.
    uint256 public constant BONUS_RATE_ACTION_COOLDOWN = 24 hours;

    // ─── Pending state ────────────────────────────────────────────────────────
    /// @dev F-04-3 — per-tokenId abandoned-residual-clear proposal.
    struct PendingResidualClear {
        address newClaimant;
        uint256 executeAfter;
    }

    /// @dev M-4 [F-04-2] — pending owner-rescue of a stuck NFT.
    struct PendingRescueNFT {
        uint256 tokenId;
        address to;
    }

    /// @dev 24h-timelocked retro-attribution of stuck base rewards.
    struct PendingAttribution {
        address restaker;
        uint256 amount;
    }

    uint256 public pendingBonusRate;
    uint256 public lastBonusRateActionAt;
    PendingAttribution public pendingAttribution;
    address public pendingSweepStuckToken;
    PendingRescueNFT public pendingRescueNFT;
    mapping(uint256 => PendingResidualClear) public pendingResidualClears;

    // ─── Wired host ───────────────────────────────────────────────────────────
    ITegridyRestakingApply public immutable restaking;

    // ─── Events (same signatures/topics as the pre-split host) ────────────────
    event BonusRateProposed(uint256 newRate, uint256 executeAfter);
    event BonusRateCancelled(uint256 cancelledRate);
    event AttributionProposed(address indexed restaker, uint256 amount, uint256 executeAfter);
    event AttributionCancelled(address indexed restaker, uint256 amount);
    event SweepStuckProposed(address indexed token, uint256 executeAfter);
    event SweepStuckCancelled(address indexed token);
    event RescueNFTProposed(uint256 indexed tokenId, address indexed to, uint256 executeAfter);
    event RescueNFTCancelled(uint256 indexed tokenId);
    event ResidualClearProposed(uint256 indexed tokenId, address indexed newClaimant, uint256 executeAfter);
    event ResidualClearCancelled(uint256 indexed tokenId);

    constructor(address _restaking) OwnableNoRenounce(msg.sender) {
        if (_restaking == address(0)) revert ZeroAddress();
        restaking = ITegridyRestakingApply(_restaking);
    }

    // ═══ Bonus rate (48h) ═════════════════════════════════════════════════════

    /// @notice SECURITY FIX #13: propose a new bonus reward rate (48h timelock).
    /// @dev Check ORDER is load-bearing and must not be reshuffled:
    ///        1. RateTooHigh (input validation)
    ///        2. `_propose`'s ExistingProposalPending
    ///        3. DEEP-DR-07 cooldown (only bites after a prior propose/cancel)
    ///      The cooldown is evaluated before `_propose` runs but only when no
    ///      proposal is pending, which reproduces the pre-split ordering exactly.
    ///      `lastBonusRateActionAt` is zero at deploy so the first propose is free.
    /// @dev The pre-split host ran `updateBonus` here. Accrual is deliberately NOT
    ///      run at propose time: the sister cannot accrue (the accumulator, the
    ///      restake total and the bonus balance all live on the host), and it does
    ///      not need to — the rate does not change until execute, and
    ///      `host.applyBonusRate` accrues at the OLD rate immediately before the
    ///      switch. Accrual is segmented at every `totalRestaked` mutation by the
    ///      host's own paths, so dropping a segmentation point that coincides with
    ///      no state change leaves every restaker's entitlement identical.
    function proposeBonusRate(uint256 _rate) external onlyOwner {
        if (_rate > restaking.maxBonusRewardRate()) revert RateTooHigh();
        if (
            lastBonusRateActionAt != 0 && _executeAfter[BONUS_RATE_CHANGE] == 0
                && block.timestamp < lastBonusRateActionAt + BONUS_RATE_ACTION_COOLDOWN
        ) {
            revert BonusRateActionCooldown();
        }
        pendingBonusRate = _rate;
        lastBonusRateActionAt = block.timestamp;
        _propose(BONUS_RATE_CHANGE, BONUS_RATE_TIMELOCK);
        emit BonusRateProposed(_rate, _executeAfter[BONUS_RATE_CHANGE]);
    }

    /// @notice SECURITY FIX #13: execute the pending bonus rate change after 48h.
    /// @dev `BonusRateExecuted` is emitted by the host, at the site that actually
    ///      writes `bonusRewardPerSecond`.
    function executeBonusRateChange() external onlyOwner {
        _execute(BONUS_RATE_CHANGE);
        uint256 r = pendingBonusRate;
        pendingBonusRate = 0;
        restaking.applyBonusRate(r);
    }

    /// @notice M-03: cancel a pending bonus rate proposal.
    /// @dev DR2-05: no cooldown gate on cancel — defensive cancel is exactly the
    ///      action a multisig must be able to take the instant it spots a hostile
    ///      proposal. The timestamp is still stamped so the propose-side anti-churn
    ///      window observes this cancel.
    function cancelBonusRateProposal() external onlyOwner {
        _cancel(BONUS_RATE_CHANGE);
        uint256 cancelledRate = pendingBonusRate;
        pendingBonusRate = 0;
        lastBonusRateActionAt = block.timestamp;
        emit BonusRateCancelled(cancelledRate);
    }

    function bonusRateChangeTime() external view returns (uint256) {
        return _executeAfter[BONUS_RATE_CHANGE];
    }

    // ═══ Stuck-base-reward retro-attribution (24h) ════════════════════════════

    /// @notice Propose crediting `_amount` of stranded base rewards to `_restaker`.
    /// @dev The tokenId pre-check here is advisory only — the 24h window can make
    ///      it stale. `host.applyAttributeStuckRewards` re-checks it and recomputes
    ///      the F-2 unattributed cap against LIVE host balances at execute time; the
    ///      sister must never compute that cap off getters.
    function proposeAttributeStuckRewards(address _restaker, uint256 _amount) external onlyOwner {
        (uint256 tokenId,,,,,) = restaking.restakers(_restaker);
        if (tokenId == 0) revert NotRestaked();
        if (_amount == 0) revert ZeroAmount();
        pendingAttribution = PendingAttribution({restaker: _restaker, amount: _amount});
        _propose(ATTRIBUTION_CHANGE, ATTRIBUTE_TIMELOCK);
        emit AttributionProposed(_restaker, _amount, _executeAfter[ATTRIBUTION_CHANGE]);
    }

    function executeAttributeStuckRewards() external onlyOwner {
        _execute(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        delete pendingAttribution;
        restaking.applyAttributeStuckRewards(p.restaker, p.amount);
    }

    function cancelAttributeStuckRewards() external onlyOwner {
        _cancel(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        delete pendingAttribution;
        emit AttributionCancelled(p.restaker, p.amount);
    }

    function attributionExecuteAfter() external view returns (uint256) {
        return _executeAfter[ATTRIBUTION_CHANGE];
    }

    // ═══ Sweep stuck tokens (24h) ═════════════════════════════════════════════

    /// @notice AUDIT FIX 2026-05-26 [M-09]: 24h-timelocked sweep of a foreign token
    ///         that landed on the restaking contract. The destination is hard-pinned
    ///         to `address(staking)` host-side (BATCH-J1 H17) and is not a parameter.
    function proposeSweepStuckRewards(address _token) external onlyOwner {
        if (_token == restaking.bonusRewardToken()) revert CannotSweepBonusToken();
        if (_token == restaking.rewardToken()) revert CannotSweepRewardToken();
        if (_token == address(0)) revert ZeroAddress();
        pendingSweepStuckToken = _token;
        _propose(SWEEP_STUCK_CHANGE, SWEEP_STUCK_TIMELOCK);
        emit SweepStuckProposed(_token, _executeAfter[SWEEP_STUCK_CHANGE]);
    }

    function executeSweepStuckRewards() external onlyOwner {
        _execute(SWEEP_STUCK_CHANGE);
        address _token = pendingSweepStuckToken;
        pendingSweepStuckToken = address(0);
        restaking.applySweepStuckRewards(_token);
    }

    function cancelSweepStuckRewards() external onlyOwner {
        address cancelled = pendingSweepStuckToken;
        pendingSweepStuckToken = address(0);
        _cancel(SWEEP_STUCK_CHANGE);
        emit SweepStuckCancelled(cancelled);
    }

    // ═══ Rescue NFT (48h) ═════════════════════════════════════════════════════

    /// @notice M-3 [F-03-K3] + M-4 [F-04-2] + M-06: owner rescue of an NFT that
    ///         reached the restaking contract outside `restake()`.
    /// @dev All three live-claim guards are re-checked host-side at execute; the
    ///      copies here fail the proposal fast rather than burning the 48h wait.
    function proposeRescueNFT(uint256 _tokenId, address _to) external onlyOwner {
        if (restaking.tokenIdToRestaker(_tokenId) != address(0)) revert BadParam();
        if (restaking.strandedRestakeRecipient(_tokenId) != address(0)) revert BadParam();
        if (restaking.residualClaimant(_tokenId) != address(0)) revert BadParam();
        if (_to == address(0)) revert ZeroAddress();
        pendingRescueNFT = PendingRescueNFT({tokenId: _tokenId, to: _to});
        _propose(RESCUE_NFT_CHANGE, RESCUE_NFT_TIMELOCK);
        emit RescueNFTProposed(_tokenId, _to, _executeAfter[RESCUE_NFT_CHANGE]);
    }

    /// @dev CEI across the split seam: the proposal is cleared HERE before the host
    ///      call, so the `onERC721Received` hook on a hostile `_to` re-entering this
    ///      contract finds no executable proposal.
    function executeRescueNFT() external onlyOwner {
        _execute(RESCUE_NFT_CHANGE);
        PendingRescueNFT memory p = pendingRescueNFT;
        delete pendingRescueNFT;
        restaking.applyRescueNFT(p.tokenId, p.to);
    }

    function cancelRescueNFT() external onlyOwner {
        _cancel(RESCUE_NFT_CHANGE);
        uint256 tid = pendingRescueNFT.tokenId;
        delete pendingRescueNFT;
        emit RescueNFTCancelled(tid);
    }

    // ═══ Abandoned residual claimant (7d + 7d validity, per tokenId) ══════════

    /// @notice F-04-3: clear/retarget a residual claimant whose keys are lost, so a
    ///         perma-blocked tokenId can be restaked again.
    /// @dev H-RESTAKE-CLEAR-ABANDONS-RESIDUE: `newClaimant == 0` is refused. A full
    ///      abandon would leave the staking-side residue silently claimable by
    ///      whoever next acquires the NFT.
    function proposeClearResidualClaimant(uint256 tokenId, address newClaimant) external onlyOwner {
        if (restaking.residualClaimant(tokenId) == address(0)) revert BadParam();
        if (newClaimant == address(0)) revert ZeroAddress();
        // M-03: a captured key must not be able to reset the 7-day clock.
        if (pendingResidualClears[tokenId].executeAfter != 0) {
            revert ExistingProposalPending(bytes32(tokenId));
        }
        uint256 readyAt = block.timestamp + CLEAR_RESIDUAL_TIMELOCK;
        pendingResidualClears[tokenId] = PendingResidualClear({newClaimant: newClaimant, executeAfter: readyAt});
        emit ResidualClearProposed(tokenId, newClaimant, readyAt);
    }

    function executeClearResidualClaimant(uint256 tokenId) external onlyOwner {
        PendingResidualClear memory p = pendingResidualClears[tokenId];
        if (p.executeAfter == 0) revert NoPendingResidualClear();
        if (block.timestamp < p.executeAfter) revert ResidualClearTimelockNotElapsed();
        // Validity window so a since-rotated/compromised owner key cannot execute later.
        if (block.timestamp > p.executeAfter + CLEAR_RESIDUAL_VALIDITY) revert ResidualClearExpired();
        delete pendingResidualClears[tokenId];
        restaking.applyResidualClaimant(tokenId, p.newClaimant);
    }

    function cancelClearResidualClaimant(uint256 tokenId) external onlyOwner {
        if (pendingResidualClears[tokenId].executeAfter == 0) revert NoPendingResidualClear();
        delete pendingResidualClears[tokenId];
        emit ResidualClearCancelled(tokenId);
    }

    // ═══ Handoff ══════════════════════════════════════════════════════════════

    /// @notice AUDIT FIX 2026-05-21 M19-PORT: cancel every proposal queued by the
    ///         outgoing owner on handoff, so a compromised key cannot leave an
    ///         executable booby-trap running against the incoming owner.
    /// @dev    F-2: `lastBonusRateActionAt` is reset to zero so the incoming owner's
    ///         first propose is not gated by up to 24h of the outgoing owner's
    ///         inherited anti-churn cooldown.
    /// @dev    Per-tokenId residual-clear proposals are NOT enumerable on-chain and
    ///         therefore cannot be swept here; the incoming owner triages them
    ///         individually via `cancelClearResidualClaimant(tokenId)`.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[BONUS_RATE_CHANGE] != 0) {
            uint256 cancelledRate = pendingBonusRate;
            _cancel(BONUS_RATE_CHANGE);
            pendingBonusRate = 0;
            lastBonusRateActionAt = 0;
            emit BonusRateCancelled(cancelledRate);
        }
        if (_executeAfter[ATTRIBUTION_CHANGE] != 0) {
            PendingAttribution memory p = pendingAttribution;
            _cancel(ATTRIBUTION_CHANGE);
            delete pendingAttribution;
            emit AttributionCancelled(p.restaker, p.amount);
        }
        if (_executeAfter[RESCUE_NFT_CHANGE] != 0) {
            uint256 tid = pendingRescueNFT.tokenId;
            _cancel(RESCUE_NFT_CHANGE);
            delete pendingRescueNFT;
            emit RescueNFTCancelled(tid);
        }
        // H-RESTAKE-ACCEPT-OWNERSHIP-SWEEP-STUCK: the sweep destination is pinned to
        // the staking contract, but an inherited live proposal would still move
        // tokens the incoming owner never chose to relocate.
        if (_executeAfter[SWEEP_STUCK_CHANGE] != 0) {
            address cancelledToken = pendingSweepStuckToken;
            pendingSweepStuckToken = address(0);
            _cancel(SWEEP_STUCK_CHANGE);
            emit SweepStuckCancelled(cancelledToken);
        }
    }
}
