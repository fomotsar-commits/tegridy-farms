// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title  TegridyLockVault — time-locked ERC-20 / LP-token custody with a public read surface
/// @notice The other half of the lock rails. A creator deposits LP tokens (or any ERC-20)
///         against an unlock timestamp; nobody can move them out before that instant, and
///         after it only the lock's own owner can. The registry and the paginated views
///         exist so the launch scanner and the fact sheets can state a lock's size and
///         expiry from chain state rather than from a creator's claim.
///
/// @dev    Custody boundary, stated precisely because this contract does hold funds:
///           - `withdraw` is gated on `msg.sender == lock.owner` and
///             `block.timestamp >= lock.unlockAt`. Those are the only two conditions.
///           - `withdraw` is NOT `whenNotPaused`. Pausing this vault stops new deposits
///             and nothing else; a paused vault still releases every matured lock. A
///             pause that could trap a matured lock would be a seizure with extra steps.
///           - The protocol owner has no withdraw path, no rescue path, no sweep path and
///             no ability to shorten, lengthen or reassign any lock. Search this file for
///             `onlyOwner`: every occurrence is a fee/pause/guardian control.
///           - `extend` can only move `unlockAt` later. A lock's expiry is monotonic, so a
///             fact sheet that printed "locked until T" can never be made retroactively
///             false by the creator.
///
/// @dev    Fee posture. `lockFeeWei` ships at ZERO, `feeSink` at `address(0)`, both
///         48h-timelocked, sink required before a fee can be armed. Not enabled here.
///
/// @dev    Rebasing and fee-on-transfer assets. `amount` is the MEASURED balance delta at
///         deposit and is what `withdraw` pays out. For an asset whose balance moves on
///         its own, the vault's accounting and the token's reality diverge — deposits of
///         such assets are the depositor's risk and the views say what was measured, not
///         what the token is worth now. Standard Uniswap-V2-style LP tokens do not
///         rebase, which is the intended asset for this rail.
contract TegridyLockVault is OwnableNoRenounce, Pausable, PauseGuardian, TimelockAdmin, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Timelock operation keys ─────────────────────────────────────
    bytes32 public constant LOCK_FEE_CHANGE = keccak256("LOCK_VAULT_FEE_CHANGE");
    bytes32 public constant FEE_SINK_CHANGE = keccak256("LOCK_VAULT_FEE_SINK_CHANGE");

    uint256 public constant FEE_CHANGE_DELAY = 48 hours;

    // ─── Hard bounds ─────────────────────────────────────────────────

    /// @notice Ceiling on the flat per-lock creation fee, fixed for the contract's life.
    uint256 public constant MAX_LOCK_FEE_WEI = 0.02 ether;

    /// @notice Shortest lock. The launch scanner's Tier-L check asks for LP locked ≥ 30
    ///         days; anything under a day is not a lock, it is a delay.
    uint64 public constant MIN_LOCK_DURATION = 1 days;

    /// @notice Longest lock, ten years. Bounds the "locked forever by a typo" outcome.
    uint64 public constant MAX_LOCK_DURATION = 3650 days;

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error InvalidUnlockTime(uint64 supplied, uint64 earliest, uint64 latest);
    error NotLockOwner();
    error LockNotMatured(uint64 unlockAt);
    error LockAlreadyWithdrawn();
    error UnknownLock(uint256 id);
    /// @notice `extend` was called with a timestamp at or before the current one. Expiry
    ///         is monotonic by design.
    error UnlockNotExtended(uint64 current, uint64 supplied);
    error NoPendingLockOwner();
    error NotPendingLockOwner();
    error FeeAboveCap(uint256 supplied, uint256 cap);
    error FeeSinkUnset();
    error IncorrectFee(uint256 required, uint256 supplied);
    error FeeForwardFailed();
    error PendingValueMismatch();
    error ValueUnchanged();
    error NoFundsReceived();

    // ─── Events ──────────────────────────────────────────────────────

    /// @param amount Balance the vault ACTUALLY received, measured after transfer.
    event LockCreated(
        uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockAt
    );
    event LockIncreased(uint256 indexed id, uint256 addedAmount, uint256 newAmount);
    event LockExtended(uint256 indexed id, uint64 oldUnlockAt, uint64 newUnlockAt);
    event LockWithdrawn(uint256 indexed id, address indexed owner, uint256 amount);
    event LockOwnerTransferProposed(uint256 indexed id, address indexed currentOwner, address indexed pendingOwner);
    event LockOwnerTransferred(uint256 indexed id, address indexed oldOwner, address indexed newOwner);
    event LockOwnerTransferCancelled(uint256 indexed id, address indexed cancelledPendingOwner);
    event LockFeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeAfter);
    event LockFeeChanged(uint256 oldFee, uint256 newFee);
    event FeeSinkChangeProposed(address currentSink, address newSink, uint256 executeAfter);
    event FeeSinkChanged(address indexed oldSink, address indexed newSink);
    event LockFeePaid(address indexed payer, address indexed sink, uint256 amount);

    // ─── Storage ─────────────────────────────────────────────────────

    struct Lock {
        address token; //  slot 0, bytes 0-19
        uint64 unlockAt; // slot 0, bytes 20-27
        bool withdrawn; // slot 0, byte 28
        address owner; //  slot 1
        address pendingOwner; // slot 2 — two-step handover; zero when none is proposed
        uint256 amount; // slot 3
    }

    /// @notice Lock ids start at 1. Zero is reserved as "no lock", so a caller that reads
    ///         a zeroed id from a struct or a mapping cannot address lock #0 by accident.
    uint256 public nextLockId = 1;

    mapping(uint256 => Lock) internal _locks;
    mapping(address => uint256[]) internal _lockIdsByToken;
    mapping(address => uint256[]) internal _lockIdsByOwner;

    /// @notice Currently locked, per token: increased on deposit, decreased on withdraw.
    /// @dev    Unlike the vesting factory's cumulative inflow figure, this one is a live
    ///         balance and is safe to present as "currently locked in this vault". It is
    ///         still only THIS vault — never present it as the token's global locked
    ///         supply.
    mapping(address => uint256) public totalLocked;

    uint256 public lockFeeWei;
    address public feeSink;
    uint256 public pendingLockFeeWei;
    address public pendingFeeSink;

    constructor(address initialOwner) OwnableNoRenounce(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    // ─── Lock lifecycle ──────────────────────────────────────────────

    /// @notice Deposit `amount` of `token`, unlockable by the caller at `unlockAt`.
    /// @dev    Caller must have approved `amount` to this vault.
    /// @return id The new lock's id.
    function lock(address token, uint256 amount, uint64 unlockAt)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint64 nowTs = uint64(block.timestamp);
        uint64 earliest = nowTs + MIN_LOCK_DURATION;
        uint64 latest = nowTs + MAX_LOCK_DURATION;
        if (unlockAt < earliest || unlockAt > latest) revert InvalidUnlockTime(unlockAt, earliest, latest);

        uint256 fee = lockFeeWei;
        address sink = feeSink;
        if (fee != 0 && sink == address(0)) revert FeeSinkUnset();
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);

        id = nextLockId++;
        _lockIdsByToken[token].push(id);
        _lockIdsByOwner[msg.sender].push(id);

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        // SLITHER 2026-08-30: measured-delta sentinel, fail-closed under nonReentrant — the
        // delta (never the caller's `amount`) is what becomes the lock principal
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert NoFundsReceived();

        _locks[id] = Lock({
            token: token,
            unlockAt: unlockAt,
            withdrawn: false,
            owner: msg.sender,
            pendingOwner: address(0),
            amount: received
        });
        totalLocked[token] += received;

        emit LockCreated(id, msg.sender, token, received, unlockAt);

        if (fee != 0) {
            (bool ok,) = sink.call{value: fee}("");
            if (!ok) revert FeeForwardFailed();
            emit LockFeePaid(msg.sender, sink, fee);
        }
    }

    /// @notice Add to an existing lock. No fee: the fee is per-lock, and charging again
    ///         would push depositors toward opening many small locks instead, which is
    ///         worse for everyone reading the registry.
    /// @dev    Permitted after maturity as well as before — topping up a matured lock is
    ///         indistinguishable from withdrawing and re-locking at the same timestamp,
    ///         and refusing it would only cost gas.
    function increase(uint256 id, uint256 amount) external whenNotPaused nonReentrant {
        Lock storage l = _requireLock(id);
        if (msg.sender != l.owner) revert NotLockOwner();
        if (l.withdrawn) revert LockAlreadyWithdrawn();
        if (amount == 0) revert ZeroAmount();

        address token = l.token;
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        // SLITHER 2026-08-30: measured-delta sentinel, fail-closed under nonReentrant — same
        // shape as lock() above
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert NoFundsReceived();

        uint256 newAmount = l.amount + received;
        l.amount = newAmount;
        totalLocked[token] += received;
        emit LockIncreased(id, received, newAmount);
    }

    /// @notice Push a lock's unlock timestamp further out.
    /// @dev    Strictly monotonic and callable at any time, including after maturity —
    ///         re-locking matured LP without a withdraw round-trip is the common case
    ///         when a creator renews a commitment.
    function extend(uint256 id, uint64 newUnlockAt) external nonReentrant {
        Lock storage l = _requireLock(id);
        if (msg.sender != l.owner) revert NotLockOwner();
        if (l.withdrawn) revert LockAlreadyWithdrawn();
        uint64 current = l.unlockAt;
        if (newUnlockAt <= current) revert UnlockNotExtended(current, newUnlockAt);
        uint64 latest = uint64(block.timestamp) + MAX_LOCK_DURATION;
        if (newUnlockAt > latest) revert InvalidUnlockTime(newUnlockAt, current, latest);
        l.unlockAt = newUnlockAt;
        emit LockExtended(id, current, newUnlockAt);
    }

    /// @notice Withdraw a matured lock in full. Owner only.
    /// @dev    Not `whenNotPaused`. See the custody note at the top of this file: a pause
    ///         that could hold a matured lock would be a seizure.
    /// @return amount Tokens returned.
    function withdraw(uint256 id) external nonReentrant returns (uint256 amount) {
        Lock storage l = _requireLock(id);
        if (msg.sender != l.owner) revert NotLockOwner();
        if (l.withdrawn) revert LockAlreadyWithdrawn();
        uint64 unlockAt = l.unlockAt;
        if (block.timestamp < unlockAt) revert LockNotMatured(unlockAt);

        amount = l.amount;
        address token = l.token;
        l.withdrawn = true;
        l.amount = 0;
        totalLocked[token] -= amount;

        emit LockWithdrawn(id, msg.sender, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ─── Lock ownership handover (two-step) ──────────────────────────

    /// @notice Propose a new owner for a lock. Two-step, mirroring `Ownable2Step`: a
    ///         mistyped recipient on a single-step handover would permanently transfer
    ///         locked LP to an address nobody controls.
    function proposeLockOwner(uint256 id, address newOwner) external {
        Lock storage l = _requireLock(id);
        if (msg.sender != l.owner) revert NotLockOwner();
        if (l.withdrawn) revert LockAlreadyWithdrawn();
        if (newOwner == address(0)) revert ZeroAddress();
        l.pendingOwner = newOwner;
        emit LockOwnerTransferProposed(id, msg.sender, newOwner);
    }

    /// @notice Cancel a pending handover. Current owner only.
    function cancelLockOwnerTransfer(uint256 id) external {
        Lock storage l = _requireLock(id);
        if (msg.sender != l.owner) revert NotLockOwner();
        address pending = l.pendingOwner;
        if (pending == address(0)) revert NoPendingLockOwner();
        l.pendingOwner = address(0);
        emit LockOwnerTransferCancelled(id, pending);
    }

    /// @notice Accept a proposed handover. Pending owner only.
    function acceptLockOwner(uint256 id) external {
        Lock storage l = _requireLock(id);
        if (l.withdrawn) revert LockAlreadyWithdrawn();
        address pending = l.pendingOwner;
        if (pending == address(0)) revert NoPendingLockOwner();
        if (msg.sender != pending) revert NotPendingLockOwner();
        address old = l.owner;
        l.owner = pending;
        l.pendingOwner = address(0);
        // The new owner's index gains the lock; the old owner's index keeps it. Indices
        // are append-only so a historical entry is never rewritten — `lockView` is the
        // authority on who owns a lock today, and the per-owner lists are a superset that
        // callers must filter by `view.owner`.
        _lockIdsByOwner[pending].push(id);
        emit LockOwnerTransferred(id, old, pending);
    }

    // ─── Fee administration (48h timelock, value-bound execute) ──────

    function proposeLockFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_LOCK_FEE_WEI) revert FeeAboveCap(newFee, MAX_LOCK_FEE_WEI);
        if (newFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        if (newFee == lockFeeWei) revert ValueUnchanged();
        pendingLockFeeWei = newFee;
        _propose(LOCK_FEE_CHANGE, FEE_CHANGE_DELAY);
        emit LockFeeChangeProposed(lockFeeWei, newFee, _executeAfter[LOCK_FEE_CHANGE]);
    }

    function executeLockFee(uint256 expectedFee) external onlyOwner {
        if (expectedFee != pendingLockFeeWei) revert PendingValueMismatch();
        _execute(LOCK_FEE_CHANGE);
        if (expectedFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        uint256 old = lockFeeWei;
        lockFeeWei = expectedFee;
        pendingLockFeeWei = 0;
        emit LockFeeChanged(old, expectedFee);
    }

    function cancelLockFee() external onlyOwner {
        _cancel(LOCK_FEE_CHANGE);
        pendingLockFeeWei = 0;
    }

    function proposeFeeSink(address newSink) external onlyOwner {
        if (newSink == address(0) && lockFeeWei != 0) revert FeeSinkUnset();
        if (newSink == feeSink) revert ValueUnchanged();
        pendingFeeSink = newSink;
        _propose(FEE_SINK_CHANGE, FEE_CHANGE_DELAY);
        emit FeeSinkChangeProposed(feeSink, newSink, _executeAfter[FEE_SINK_CHANGE]);
    }

    function executeFeeSink(address expectedSink) external onlyOwner {
        if (expectedSink != pendingFeeSink) revert PendingValueMismatch();
        _execute(FEE_SINK_CHANGE);
        if (expectedSink == address(0) && lockFeeWei != 0) revert FeeSinkUnset();
        address old = feeSink;
        feeSink = expectedSink;
        pendingFeeSink = address(0);
        emit FeeSinkChanged(old, expectedSink);
    }

    function cancelFeeSink() external onlyOwner {
        _cancel(FEE_SINK_CHANGE);
        pendingFeeSink = address(0);
    }

    // ─── Pause surface ───────────────────────────────────────────────

    /// @notice Stops NEW locks and top-ups. Does not stop `withdraw`, `extend` or any
    ///         ownership handover.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function guardianPause() external onlyPauseGuardian {
        _pause();
    }

    function setPauseGuardian(address newGuardian) external onlyOwner {
        _setPauseGuardian(newGuardian);
    }

    // ─── Views ───────────────────────────────────────────────────────

    struct LockView {
        uint256 id;
        address token;
        address owner;
        address pendingOwner;
        uint256 amount;
        uint64 unlockAt;
        bool withdrawn;
        bool matured;
    }

    function lockView(uint256 id) public view returns (LockView memory) {
        Lock storage l = _locks[id];
        if (l.owner == address(0)) revert UnknownLock(id);
        return LockView({
            id: id,
            token: l.token,
            owner: l.owner,
            pendingOwner: l.pendingOwner,
            amount: l.amount,
            unlockAt: l.unlockAt,
            withdrawn: l.withdrawn,
            matured: block.timestamp >= l.unlockAt
        });
    }

    function lockCountForToken(address token) external view returns (uint256) {
        return _lockIdsByToken[token].length;
    }

    function lockCountForOwner(address owner_) external view returns (uint256) {
        return _lockIdsByOwner[owner_].length;
    }

    function lockIdsForOwner(address owner_) external view returns (uint256[] memory) {
        return _lockIdsByOwner[owner_];
    }

    /// @notice The read surface the launch scanner and the fact sheets consume: how much
    ///         of `token` is locked here and until when.
    /// @dev    Paginated because anyone can open a dust lock against any token, so the
    ///         per-token list is attacker-growable and an unbounded aggregation would be
    ///         a griefable view. A caller that stops before `next == 0` is holding a
    ///         PARTIAL answer and must render it as such — reporting a truncated scan as
    ///         the token's lock status would understate real locks, which is the
    ///         fabricated-data failure in the other direction.
    /// @param  token  Asset to aggregate.
    /// @param  offset Start index into the token's lock list.
    /// @param  limit  Maximum ids to visit this call.
    /// @return amountLocked  Sum of active (non-withdrawn) lock amounts in this page.
    /// @return earliestUnlock Smallest `unlockAt` among active locks in this page; 0 when
    ///                        the page contained no active lock.
    /// @return latestUnlock   Largest `unlockAt` among active locks in this page.
    /// @return activeCount    Active locks counted in this page.
    /// @return next           Offset for the following call, or 0 when the scan is
    ///                        complete.
    function tokenLockSummary(address token, uint256 offset, uint256 limit)
        external
        view
        returns (
            uint256 amountLocked,
            uint64 earliestUnlock,
            uint64 latestUnlock,
            uint256 activeCount,
            uint256 next
        )
    {
        uint256[] storage ids = _lockIdsByToken[token];
        uint256 total = ids.length;
        if (offset >= total || limit == 0) return (0, 0, 0, 0, 0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        for (uint256 i = offset; i < end; ++i) {
            Lock storage l = _locks[ids[i]];
            if (l.withdrawn) continue;
            amountLocked += l.amount;
            unchecked {
                ++activeCount;
            }
            uint64 u = l.unlockAt;
            if (earliestUnlock == 0 || u < earliestUnlock) earliestUnlock = u;
            if (u > latestUnlock) latestUnlock = u;
        }
        next = end == total ? 0 : end;
    }

    /// @notice The fee a lock created in this block would pay. Read immediately before
    ///         signing and print it; do not cache.
    function currentLockFee() external view returns (uint256 fee, address sink) {
        return (lockFeeWei, feeSink);
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _requireLock(uint256 id) internal view returns (Lock storage l) {
        l = _locks[id];
        // `owner` is set for every id the vault has ever issued and is never cleared, so
        // a zero owner means the id was never issued — distinct from a withdrawn lock,
        // which keeps its owner and reports `LockAlreadyWithdrawn`.
        if (l.owner == address(0)) revert UnknownLock(id);
    }
}
