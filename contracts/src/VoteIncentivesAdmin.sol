// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

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
    function MAX_MIN_BRIBE_AMOUNT() external view returns (uint256);
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
    /// @notice AUDIT FIX FRESH-2026: F-38-3 — `proposeEnableCommitReveal` previously
    ///         silently no-op'd when the flag was already on, suppressing
    ///         off-chain audit signal. Now reverts so a captured-owner probe
    ///         is observable.
    error CommitRevealAlreadyEnabled();
    /// @notice AUDIT FIX FRESH-2026: F-38-7 + F-84-2 — fail-fast on out-of-range
    ///         min-bribe at propose time (was: only enforced at execute time
    ///         after a 24h timelock had elapsed, costing a wasted cycle).
    error MinBribeTooLarge();
    /// @notice AUDIT FIX FRESH-2026: F-10-K-08 + F-84-3 — `amount == 0` would
    ///         silently restore `DEFAULT_MIN_TOKEN_BRIBE` (a 1e15 18-dec
    ///         literal that maps to 1000 USDC on a 6-dec token) for tokens
    ///         that previously had a per-token min configured. Fail at
    ///         propose time instead.
    error MinBribeAmountZero();

    // ─── Timelock keys (mirror what VoteIncentives previously held) ────
    bytes32 public constant FEE_CHANGE = keccak256("BRIBE_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("BRIBE_TREASURY_CHANGE");
    bytes32 public constant WHITELIST_CHANGE = keccak256("BRIBE_WHITELIST_CHANGE");
    bytes32 public constant MIN_BRIBE_CHANGE = keccak256("BRIBE_MIN_AMOUNT_CHANGE");
    bytes32 public constant COMMIT_REVEAL_ENABLE = keccak256("COMMIT_REVEAL_ENABLE");

    // ─── Delays (mirror what VoteIncentives previously enforced) ───────
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    /// @notice AUDIT FIX FRESH-2026: F-38-8 — bumped from 48h to 7 days. A
    ///         48h window let a captured owner siphon 48-72h of bribe fees +
    ///         drain `accumulatedTreasuryETH` retroactively after the
    ///         on-chain `TreasuryChangeProposed` event landed. Aerodrome,
    ///         Velodrome, Compound `Comp`, and Aave `Treasury` all use a
    ///         7d delay for treasury rotation specifically because of this
    ///         class of attack.
    uint256 public constant TREASURY_CHANGE_DELAY = 7 days;
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
    function executeFeeChange() external onlyOwner {
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
    function executeTreasuryChange() external onlyOwner {
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
    function executeWhitelistChange() external onlyOwner {
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
    /// @dev AUDIT FIX FRESH-2026: F-38-7 + F-10-K-08 + F-84-2 + F-84-3 —
    ///      validate amount at propose time so a wasted timelock cycle is
    ///      avoided AND zero amounts (which silently fall back to
    ///      `DEFAULT_MIN_TOKEN_BRIBE`'s 18-dec literal — wildly wrong for
    ///      6-dec stablecoins) are rejected loudly. Cap is also scaled by
    ///      the token's `decimals()` so the "1M tokens" comment on
    ///      `MAX_MIN_BRIBE_AMOUNT` actually means 1M of the token's
    ///      whole-units, not "1M only if the token happens to be 18-dec".
    ///      Mirrors the POLAccumulator / TegridyRestaking decimal-scaling
    ///      patterns (F-84-1 reference impl).
    function proposeMinBribeAmount(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert MinBribeAmountZero();
        // AUDIT FIX FRESH-2026: F-38-7 + F-84-2 — scale cap by decimals().
        // Falls back to 18-dec on legacy/non-standard tokens (matches the
        // TegridyRestaking F-84-1 fallback shape).
        uint256 unit;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            unit = d <= 36 ? 10 ** uint256(d) : 1e18;
        } catch {
            unit = 1e18;
        }
        // Scaled max = 1_000_000 * 10**decimals(). For 18-dec tokens that's
        // 1e24 (matches the legacy `MAX_MIN_BRIBE_AMOUNT` constant on the
        // VoteIncentives side); for 6-dec stablecoins it's 1e12 (= 1M USDC).
        uint256 scaledMax = 1_000_000 * unit;
        if (amount > scaledMax) revert MinBribeTooLarge();
        pendingMinBribeToken = token;
        pendingMinBribeAmount = amount;
        _propose(MIN_BRIBE_CHANGE, MIN_BRIBE_CHANGE_DELAY);
        emit MinBribeAmountChangeProposed(token, amount, _executeAfter[MIN_BRIBE_CHANGE]);
    }
    function executeMinBribeAmount() external onlyOwner {
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
    /// @dev    AUDIT FIX FRESH-2026: F-38-3 — revert (was: silent no-op) when
    ///         the flag is already on. Pre-fix, a captured-owner probe
    ///         produced no event, no revert, no `_executeAfter` write, so
    ///         off-chain monitors had no signal that owner credentials were
    ///         being exercised. Loud revert turns the probe into observable
    ///         intel.
    function proposeEnableCommitReveal() external onlyOwner {
        if (voteIncentives.commitRevealEnabled()) revert CommitRevealAlreadyEnabled();
        _propose(COMMIT_REVEAL_ENABLE, COMMIT_REVEAL_ENABLE_DELAY);
        emit EnableCommitRevealProposed(_executeAfter[COMMIT_REVEAL_ENABLE]);
    }
    function cancelEnableCommitReveal() external onlyOwner {
        _cancel(COMMIT_REVEAL_ENABLE);
        emit EnableCommitRevealCancelled();
    }
    /// @notice AUDIT FIX FRESH-2026: F-75-6 — restricted to `onlyOwner`. The
    ///         legacy permissionless execute let a mempool watcher front-run
    ///         the owner's `cancelEnableCommitReveal` after the delay
    ///         elapsed, locking the one-way flag forever even if the owner
    ///         had pending second thoughts. `cancel` was always
    ///         `onlyOwner`, so the asymmetric race only existed because
    ///         `execute` was open. Closing it preserves owner cancel-window
    ///         semantics. Apply-side is still idempotent (re-execution is a
    ///         no-op) so a delayed honest call is safe.
    function executeEnableCommitReveal() external onlyOwner {
        _execute(COMMIT_REVEAL_ENABLE);
        voteIncentives.applyEnableCommitReveal();
    }
    function commitRevealEnableTime() external view returns (uint256) {
        return _executeAfter[COMMIT_REVEAL_ENABLE];
    }
}
