// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to VoteIncentives used by the admin's apply hooks
///         and validation reads. Each `apply*` setter on VoteIncentives is
///         `onlyAdmin`.
interface IVoteIncentivesApply {
    // ─── apply* setters (each `onlyAdmin` on the VoteIncentives side) ─
    function applyFeeChange(uint256 newFee) external;
    function applyTreasuryChange(address newTreasury) external;
    function applyWhitelistChange(address token, bool add) external;
    function applyMinBribeAmountChange(address token, uint256 amount) external;
    function applyEnableCommitReveal() external;

    // ─── view-side reads required for validation ──────────────────────
    function MAX_FEE_BPS() external view returns (uint256);
    function bribeFeeBps() external view returns (uint256);
    function commitRevealEnabled() external view returns (bool);
}

/// @title VoteIncentivesAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on VoteIncentives. Dispatches the actual writes
///         to VoteIncentives via its `applyXxx` setters (onlyAdmin gated).
/// @dev    AUDIT FIX (pass-8): EIP170-03 — created during the Phase 0.3 split
///         to bring VoteIncentives under the 24,576-byte EIP-170 limit.
///         Pre-fix bytecode was 26,350 bytes (1,774 over). Mirrors the exact
///         pattern used for `SwapFeeRouterAdmin` (Wave-1 sprint 2026-04-26)
///         and `TegridyLendingAdmin` (Phase 0.1, 2026-05-05).
contract VoteIncentivesAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error FeeCannotBeZero();
    /// @notice AUDIT FIX (Wave-2 2026-05-20): caller's expected pending value did
    ///         not match the currently-stored value. Closes the
    ///         cancel-and-re-propose race where a captured-key attacker swaps the
    ///         queued value between propose and the multisig's signed execute.
    ///         Mirrors TegridyLaunchpadV2's FeeMismatch / RecipientMismatch
    ///         pattern (V2-LP-01) and TegridyDropV2.executeMerkleRoot(bytes32).
    error FeeMismatch();
    error TreasuryMismatch();
    error WhitelistMismatch();
    error MinBribeMismatch();
    /// @notice AUDIT FIX (Wave-2 2026-05-20, mirrors V2-LP-01):
    ///         `expectedExecuteAfter` did not match the currently-stored
    ///         `_executeAfter[KEY]`. Closes the cancel → re-propose with same
    ///         value but different ETA race where the original signer could
    ///         have unwittingly executed the second proposal because the
    ///         value-binding alone matched.
    error ExecuteAfterMismatch();

    // ─── Timelock keys (mirror what VoteIncentives previously held) ────
    bytes32 public constant FEE_CHANGE = keccak256("BRIBE_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("BRIBE_TREASURY_CHANGE");
    bytes32 public constant WHITELIST_CHANGE = keccak256("BRIBE_WHITELIST_CHANGE");
    bytes32 public constant MIN_BRIBE_CHANGE = keccak256("BRIBE_MIN_AMOUNT_CHANGE");
    bytes32 public constant COMMIT_REVEAL_ENABLE = keccak256("COMMIT_REVEAL_ENABLE");

    // ─── Delays (mirror what VoteIncentives previously enforced) ───────
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant WHITELIST_CHANGE_DELAY = 24 hours;
    uint256 public constant MIN_BRIBE_CHANGE_DELAY = 24 hours;
    uint256 public constant COMMIT_REVEAL_ENABLE_DELAY = 24 hours;

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistToken;
    bool public pendingWhitelistAction; // true = add, false = remove
    address public pendingMinBribeToken;
    uint256 public pendingMinBribeAmount;

    // ─── Wired VoteIncentives contract ────────────────────────────────
    IVoteIncentivesApply public immutable voteIncentives;

    // ─── Events (proposed/cancelled — "happened" events stay on incentives) ─
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);
    event WhitelistChangeProposed(address indexed token, bool add, uint256 executeAfter);
    event WhitelistChangeCancelled(address indexed token);
    event MinBribeAmountChangeProposed(address indexed token, uint256 amount, uint256 executeAfter);
    event MinBribeAmountChangeCancelled(address indexed token, uint256 amount);
    event EnableCommitRevealProposed(uint256 executeAfter);
    event EnableCommitRevealCancelled();

    constructor(address _voteIncentives) OwnableNoRenounce(msg.sender) {
        if (_voteIncentives == address(0)) revert ZeroAddress();
        voteIncentives = IVoteIncentivesApply(_voteIncentives);
    }

    // ─── Fee ──────────────────────────────────────────────────────────
    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > voteIncentives.MAX_FEE_BPS()) revert FeeTooHigh();
        if (newFee == 0) revert FeeCannotBeZero(); // M-08 FIX preserved
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(voteIncentives.bribeFeeBps(), newFee, _executeAfter[FEE_CHANGE]);
    }
    /// @notice Execute a previously-proposed fee change.
    /// @dev    AUDIT FIX (Wave-2 2026-05-20): caller MUST bind both the
    ///         pending value AND the pending executeAfter at sign time.
    ///         Closes the cancel-and-re-propose race (see FeeMismatch /
    ///         ExecuteAfterMismatch natspec).
    function executeFeeChange(uint256 expectedFee, uint256 expectedExecuteAfter) external onlyOwner {
        if (pendingFeeBps != expectedFee) revert FeeMismatch();
        if (_executeAfter[FEE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(FEE_CHANGE);
        uint256 v = pendingFeeBps;
        pendingFeeBps = 0;
        voteIncentives.applyFeeChange(v);
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
    function executeTreasuryChange(address expectedTreasury, uint256 expectedExecuteAfter) external onlyOwner {
        if (pendingTreasury != expectedTreasury) revert TreasuryMismatch();
        if (_executeAfter[TREASURY_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(TREASURY_CHANGE);
        address v = pendingTreasury;
        pendingTreasury = address(0);
        voteIncentives.applyTreasuryChange(v);
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

    // ─── Whitelist ────────────────────────────────────────────────────
    function proposeWhitelistChange(address token, bool add) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingWhitelistToken = token;
        pendingWhitelistAction = add;
        _propose(WHITELIST_CHANGE, WHITELIST_CHANGE_DELAY);
        emit WhitelistChangeProposed(token, add, _executeAfter[WHITELIST_CHANGE]);
    }
    function executeWhitelistChange(
        address expectedToken,
        bool expectedAdd,
        uint256 expectedExecuteAfter
    ) external onlyOwner {
        if (pendingWhitelistToken != expectedToken || pendingWhitelistAction != expectedAdd) {
            revert WhitelistMismatch();
        }
        if (_executeAfter[WHITELIST_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(WHITELIST_CHANGE);
        address token = pendingWhitelistToken;
        bool add = pendingWhitelistAction;
        pendingWhitelistToken = address(0);
        pendingWhitelistAction = false; // DEEP-GOV-16 hygiene parity preserved
        voteIncentives.applyWhitelistChange(token, add);
    }
    function cancelWhitelistChange() external onlyOwner {
        _cancel(WHITELIST_CHANGE);
        address cancelled = pendingWhitelistToken;
        pendingWhitelistToken = address(0);
        pendingWhitelistAction = false;
        emit WhitelistChangeCancelled(cancelled);
    }
    function whitelistChangeTime() external view returns (uint256) {
        return _executeAfter[WHITELIST_CHANGE];
    }

    // ─── Min bribe amount ─────────────────────────────────────────────
    function proposeMinBribeAmount(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingMinBribeToken = token;
        pendingMinBribeAmount = amount;
        _propose(MIN_BRIBE_CHANGE, MIN_BRIBE_CHANGE_DELAY);
        emit MinBribeAmountChangeProposed(token, amount, _executeAfter[MIN_BRIBE_CHANGE]);
    }
    function executeMinBribeAmount(
        address expectedToken,
        uint256 expectedAmount,
        uint256 expectedExecuteAfter
    ) external onlyOwner {
        if (pendingMinBribeToken != expectedToken || pendingMinBribeAmount != expectedAmount) {
            revert MinBribeMismatch();
        }
        if (_executeAfter[MIN_BRIBE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(MIN_BRIBE_CHANGE);
        address token = pendingMinBribeToken;
        uint256 amount = pendingMinBribeAmount;
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        voteIncentives.applyMinBribeAmountChange(token, amount);
    }
    function cancelMinBribeAmount() external onlyOwner {
        address token = pendingMinBribeToken;
        uint256 amount = pendingMinBribeAmount;
        _cancel(MIN_BRIBE_CHANGE);
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        emit MinBribeAmountChangeCancelled(token, amount);
    }
    function minBribeChangeTime() external view returns (uint256) {
        return _executeAfter[MIN_BRIBE_CHANGE];
    }

    // ─── Commit-reveal enable ─────────────────────────────────────────
    /// @notice One-way switch: once enabled there is no path to disable.
    ///         Forward-only by design — flipping back would let an attacker
    ///         race the toggle.
    function proposeEnableCommitReveal() external onlyOwner {
        if (voteIncentives.commitRevealEnabled()) return; // idempotent
        _propose(COMMIT_REVEAL_ENABLE, COMMIT_REVEAL_ENABLE_DELAY);
        emit EnableCommitRevealProposed(_executeAfter[COMMIT_REVEAL_ENABLE]);
    }
    function cancelEnableCommitReveal() external onlyOwner {
        _cancel(COMMIT_REVEAL_ENABLE);
        emit EnableCommitRevealCancelled();
    }
    /// @notice Permissionless execute (NOT onlyOwner) — preserves the original
    ///         contract's behavior where any party could fire the timelocked
    ///         enable once the delay had elapsed. The target is itself onlyAdmin
    ///         on the VoteIncentives side, so flow remains gated end-to-end:
    ///         only this admin contract (immutable wired post-deploy) can toggle.
    function executeEnableCommitReveal() external {
        _execute(COMMIT_REVEAL_ENABLE);
        voteIncentives.applyEnableCommitReveal();
    }
    function commitRevealEnableTime() external view returns (uint256) {
        return _executeAfter[COMMIT_REVEAL_ENABLE];
    }

    // ─── Ownership handoff ────────────────────────────────────────────
    /// @notice 2026-06-11 audit (acceptOwnership pending-proposal-flush): flush every
    ///         in-flight timelock proposal on ownership handoff so the incoming owner
    ///         inherits a clean queue. This also clears any queued COMMIT_REVEAL_ENABLE —
    ///         whose execute is permissionless — so no pre-handoff proposal can fire
    ///         post-handoff without the new owner's involvement. Mirrors the pattern
    ///         already shipped in PremiumAccess / TegridyStakingAdmin.
    ///         super.acceptOwnership() runs first so the pendingOwner→owner promotion
    ///         (and the OwnableNoRenounce expiry guard) happens before the flush.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[FEE_CHANGE] != 0) {
            uint256 cancelledFee = pendingFeeBps;
            _cancel(FEE_CHANGE);
            pendingFeeBps = 0;
            emit FeeChangeCancelled(cancelledFee);
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelledTreasury = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelledTreasury);
        }
        if (_executeAfter[WHITELIST_CHANGE] != 0) {
            address cancelledToken = pendingWhitelistToken;
            _cancel(WHITELIST_CHANGE);
            pendingWhitelistToken = address(0);
            pendingWhitelistAction = false;
            emit WhitelistChangeCancelled(cancelledToken);
        }
        if (_executeAfter[MIN_BRIBE_CHANGE] != 0) {
            address cancelledMinToken = pendingMinBribeToken;
            uint256 cancelledMinAmount = pendingMinBribeAmount;
            _cancel(MIN_BRIBE_CHANGE);
            pendingMinBribeToken = address(0);
            pendingMinBribeAmount = 0;
            emit MinBribeAmountChangeCancelled(cancelledMinToken, cancelledMinAmount);
        }
        if (_executeAfter[COMMIT_REVEAL_ENABLE] != 0) {
            _cancel(COMMIT_REVEAL_ENABLE);
            emit EnableCommitRevealCancelled();
        }
    }
}
