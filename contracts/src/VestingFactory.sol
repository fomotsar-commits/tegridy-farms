// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyVestingWallet} from "./TegridyVestingWallet.sol";

/// @title  VestingFactory — self-serve team-vesting streams with a public registry
/// @notice Deploys `TegridyVestingWallet` instances (OpenZeppelin `VestingWalletCliff`,
///         imported from the pinned v5.6.1 submodule, math untouched) and emits the
///         registry events the indexer and the launch scanner read. The factory is the
///         thin part; the schedule is OZ's.
///
/// @dev    The factory has no custody. It pulls the creator's tokens straight through to
///         the freshly deployed wallet inside one transaction and holds no ERC-20 balance
///         between transactions. It has no token sweep path, so there is nothing here for
///         an owner to take.
///
/// @dev    What the owner CAN do: stop NEW streams being created (pause), and change the
///         flat creation fee for FUTURE streams. What the owner CANNOT do: reach any
///         existing stream. Wallets hold no reference to factory state; pausing this
///         factory does not delay a single beneficiary's release by one second. That
///         separation is what lets a fact sheet claim a vest is real.
///
/// @dev    Fee posture. `createFeeWei` ships at ZERO and `feeSink` at `address(0)`.
///         Creation reverts if a fee is somehow live without a sink, and the fee cannot
///         be armed before a sink is wired. Both moves are 48h-timelocked owner
///         ceremonies and neither is performed here.
///
/// @dev    Fee shape boundary. The build note specifies "0.25% of streamed value" as the
///         fee. Percent-of-value in ETH terms requires a price for an arbitrary,
///         frequently brand-new ERC-20 — an oracle dependency, on exactly the assets with
///         the thinnest and most manipulable markets. This contract deliberately carries
///         no oracle: the fee it implements is a FLAT ETH amount per stream. Converting
///         to percent-of-value is an operator/product decision that would need a price
///         source chosen and defended first.
contract VestingFactory is OwnableNoRenounce, Pausable, PauseGuardian, TimelockAdmin, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Timelock operation keys ─────────────────────────────────────
    bytes32 public constant CREATE_FEE_CHANGE = keccak256("VESTING_CREATE_FEE_CHANGE");
    bytes32 public constant FEE_SINK_CHANGE = keccak256("VESTING_FEE_SINK_CHANGE");

    /// @notice 48h, matching the fleet's treasury/fee-rotation window.
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;

    // ─── Hard bounds ─────────────────────────────────────────────────

    /// @notice Ceiling on the flat creation fee, fixed for the life of the contract.
    uint256 public constant MAX_CREATE_FEE_WEI = 0.02 ether;

    /// @notice Shortest schedule. Below this a "vest" is theatre — it would satisfy an
    ///         on-chain-vested badge while unlocking before anyone could read the badge.
    uint64 public constant MIN_DURATION = 1 days;

    /// @notice Longest schedule, ten years.
    uint64 public constant MAX_DURATION = 3650 days;

    /// @notice How far in the future a schedule may be dated. A start further out than
    ///         this is far more likely a units mistake (milliseconds, or a block number
    ///         pasted into a timestamp field) than an intention.
    uint64 public constant MAX_START_DELAY = 365 days;

    /// @notice How far in the PAST a schedule may be back-dated. Back-dating makes part
    ///         of the allocation immediately releasable, so it is bounded rather than
    ///         forbidden: a launch that vests from its own launch block is legitimate,
    ///         a launch that back-dates a year to unlock everything at once is not.
    uint64 public constant MAX_BACKDATE = 30 days;

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error InvalidDuration(uint64 supplied, uint64 min, uint64 max);
    error InvalidStart(uint64 supplied);
    /// @notice OZ rejects a cliff longer than the duration; this is the same rule stated
    ///         at the factory boundary so the caller gets a typed error before deploy.
    error InvalidCliff(uint64 cliffSeconds, uint64 durationSeconds);
    error FeeAboveCap(uint256 supplied, uint256 cap);
    error FeeSinkUnset();
    error IncorrectFee(uint256 required, uint256 supplied);
    error FeeForwardFailed();
    error PendingValueMismatch();
    error ValueUnchanged();
    error NoFundsReceived();

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice The registry event the indexer's `vesting_stream` table is built from.
    /// @param  funded Balance the wallet ACTUALLY received, measured after transfer.
    event VestingCreated(
        address indexed wallet,
        address indexed beneficiary,
        address indexed token,
        address creator,
        uint64 start,
        uint64 cliff,
        uint64 end,
        uint256 funded
    );
    event CreateFeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeAfter);
    event CreateFeeChanged(uint256 oldFee, uint256 newFee);
    event FeeSinkChangeProposed(address currentSink, address newSink, uint256 executeAfter);
    event FeeSinkChanged(address indexed oldSink, address indexed newSink);
    event CreateFeePaid(address indexed payer, address indexed sink, uint256 amount);

    // ─── State ───────────────────────────────────────────────────────

    uint256 public createFeeWei;
    address public feeSink;
    uint256 public pendingCreateFeeWei;
    address public pendingFeeSink;

    address[] public vestings;
    /// @notice Provenance check. A wallet absent from this mapping was not created here
    ///         and its schedule bounds were never enforced by this contract — a scanner
    ///         must not treat it as a factory-vouched vest.
    mapping(address => bool) public isVesting;

    mapping(address => address[]) internal _vestingsByBeneficiary;
    mapping(address => address[]) internal _vestingsByToken;
    mapping(address => address[]) internal _vestingsByCreator;

    /// @notice Sum of measured deposits into wallets created here, per token.
    /// @dev    A cumulative INFLOW figure, not a current-locked figure: it never
    ///         decreases as beneficiaries release. Presenting it as "currently locked"
    ///         would overstate the lock. `LaunchLockView` labels it as declared inflow.
    mapping(address => uint256) public totalVestedInflow;

    constructor(address initialOwner) OwnableNoRenounce(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    // ─── Stream creation ─────────────────────────────────────────────

    /// @notice Deploy and fund a linear-with-cliff vesting wallet.
    /// @dev    Caller must have approved `amount` of `token` to this factory.
    /// @param  token           Asset to vest.
    /// @param  beneficiary     Sole recipient of every release.
    /// @param  amount          Amount pulled from the caller into the new wallet.
    /// @param  startTimestamp  Schedule start; bounded by `MAX_BACKDATE`/`MAX_START_DELAY`.
    /// @param  durationSeconds Schedule length.
    /// @param  cliffSeconds    Cliff measured from `startTimestamp`; may be zero.
    /// @return wallet          The new vesting wallet.
    function createVesting(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds
    ) external payable whenNotPaused nonReentrant returns (address wallet) {
        if (token == address(0) || beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (durationSeconds < MIN_DURATION || durationSeconds > MAX_DURATION) {
            revert InvalidDuration(durationSeconds, MIN_DURATION, MAX_DURATION);
        }
        if (cliffSeconds > durationSeconds) revert InvalidCliff(cliffSeconds, durationSeconds);
        uint64 nowTs = uint64(block.timestamp);
        // Split into two comparisons that cannot overflow uint64 rather than the compact
        // `start + MAX_BACKDATE < now` form: a caller passing `type(uint64).max` would
        // otherwise trip a checked-math panic instead of the typed error, and a panic in
        // a user-facing create path is indistinguishable from a contract bug.
        if (startTimestamp > nowTs + MAX_START_DELAY) revert InvalidStart(startTimestamp);
        if (nowTs > MAX_BACKDATE && startTimestamp < nowTs - MAX_BACKDATE) revert InvalidStart(startTimestamp);

        uint256 fee = createFeeWei;
        address sink = feeSink;
        if (fee != 0 && sink == address(0)) revert FeeSinkUnset();
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);

        wallet = address(
            new TegridyVestingWallet(beneficiary, startTimestamp, durationSeconds, cliffSeconds, token, msg.sender)
        );

        vestings.push(wallet);
        isVesting[wallet] = true;
        _vestingsByBeneficiary[beneficiary].push(wallet);
        _vestingsByToken[token].push(wallet);
        _vestingsByCreator[msg.sender].push(wallet);

        uint256 balanceBefore = IERC20(token).balanceOf(wallet);
        IERC20(token).safeTransferFrom(msg.sender, wallet, amount);
        uint256 funded = IERC20(token).balanceOf(wallet) - balanceBefore;
        if (funded == 0) revert NoFundsReceived();
        totalVestedInflow[token] += funded;

        emit VestingCreated(
            wallet,
            beneficiary,
            token,
            msg.sender,
            startTimestamp,
            startTimestamp + cliffSeconds,
            startTimestamp + durationSeconds,
            funded
        );

        if (fee != 0) {
            (bool ok,) = sink.call{value: fee}("");
            if (!ok) revert FeeForwardFailed();
            emit CreateFeePaid(msg.sender, sink, fee);
        }
    }

    // ─── Fee administration (48h timelock, value-bound execute) ──────

    function proposeCreateFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_CREATE_FEE_WEI) revert FeeAboveCap(newFee, MAX_CREATE_FEE_WEI);
        if (newFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        if (newFee == createFeeWei) revert ValueUnchanged();
        pendingCreateFeeWei = newFee;
        _propose(CREATE_FEE_CHANGE, FEE_CHANGE_DELAY);
        emit CreateFeeChangeProposed(createFeeWei, newFee, _executeAfter[CREATE_FEE_CHANGE]);
    }

    function executeCreateFee(uint256 expectedFee) external onlyOwner {
        if (expectedFee != pendingCreateFeeWei) revert PendingValueMismatch();
        _execute(CREATE_FEE_CHANGE);
        if (expectedFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        uint256 old = createFeeWei;
        createFeeWei = expectedFee;
        pendingCreateFeeWei = 0;
        emit CreateFeeChanged(old, expectedFee);
    }

    function cancelCreateFee() external onlyOwner {
        _cancel(CREATE_FEE_CHANGE);
        pendingCreateFeeWei = 0;
    }

    function proposeFeeSink(address newSink) external onlyOwner {
        if (newSink == address(0) && createFeeWei != 0) revert FeeSinkUnset();
        if (newSink == feeSink) revert ValueUnchanged();
        pendingFeeSink = newSink;
        _propose(FEE_SINK_CHANGE, FEE_CHANGE_DELAY);
        emit FeeSinkChangeProposed(feeSink, newSink, _executeAfter[FEE_SINK_CHANGE]);
    }

    function executeFeeSink(address expectedSink) external onlyOwner {
        if (expectedSink != pendingFeeSink) revert PendingValueMismatch();
        _execute(FEE_SINK_CHANGE);
        if (expectedSink == address(0) && createFeeWei != 0) revert FeeSinkUnset();
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

    /// @notice Stops NEW streams. Existing wallets are unaffected: `release` lives on the
    ///         wallet, which never reads this contract.
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

    function vestingCount() external view returns (uint256) {
        return vestings.length;
    }

    function vestingsForBeneficiary(address beneficiary) external view returns (address[] memory) {
        return _vestingsByBeneficiary[beneficiary];
    }

    function vestingsForToken(address token) external view returns (address[] memory) {
        return _vestingsByToken[token];
    }

    function vestingsForCreator(address creator) external view returns (address[] memory) {
        return _vestingsByCreator[creator];
    }

    function vestingCountForToken(address token) external view returns (uint256) {
        return _vestingsByToken[token].length;
    }

    /// @notice Paginated slice of a token's vesting wallets.
    /// @return page Slice of vesting wallet addresses.
    /// @return next Offset for the following call, or 0 when complete. Non-zero means the
    ///              caller holds a PARTIAL view and must not present it as the total.
    function vestingsForTokenSlice(address token, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 next)
    {
        address[] storage list = _vestingsByToken[token];
        uint256 total = list.length;
        if (offset >= total || limit == 0) return (new address[](0), 0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = list[i];
        }
        next = end == total ? 0 : end;
    }

    /// @notice The fee a stream created in this block would pay. Read immediately before
    ///         signing and print it; do not cache.
    function currentCreateFee() external view returns (uint256 fee, address sink) {
        return (createFeeWei, feeSink);
    }
}
