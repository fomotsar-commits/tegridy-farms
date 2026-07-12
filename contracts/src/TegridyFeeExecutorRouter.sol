// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// @title  TegridyFeeExecutorRouter — fee-skimming executor for LlamaSwap-routed swaps
/// @notice Lets users swap via a route the DefiLlama/LlamaSwap API selected (best execution
///         across all aggregators) while the protocol skims a small, disclosed fee that flows
///         into the existing staker / POL / treasury split. The contract is a THIN, DUMB
///         skim-and-forward shell: it pulls the input, skims the fee, executes the
///         externally-supplied swap calldata against an ALLOWLISTED aggregator router, enforces
///         the caller's minOut on the ACTUAL output it receives, and forwards the output.
///
/// @dev    SECURITY — this is the most exploit-prone contract class in DeFi (Li.Fi 2024 ~$11.6M,
///         Socket/Bungee 2024, multiple 0x-clones). Those drains all share two ingredients:
///         (a) an arbitrary call the attacker can shape, and (b) value the contract can reach
///         (its own balance or STANDING approvals others granted it). This design removes both:
///
///         INVARIANT-1 (zero residual allowance): the contract NEVER carries a non-zero ERC20
///           allowance to any spender between calls. The allowlisted spender is approved for the
///           exact net amount immediately before the swap and reset to 0 immediately after —
///           inside one `nonReentrant` call. Modeled on the 0x Settler/AllowanceHolder principle
///           ("never set an allowance on this contract"). Even a later-compromised spender finds
///           no live allowance to abuse.
///         ALLOWLIST (primary gate): the execution `target` AND the approval `spender` must each
///           be on a timelocked allowlist of known aggregator routers (1inch/0x/Paraswap/Kyber/
///           Odos). `target` may never equal an ERC20 (`tokenIn`/`tokenOut`), this contract, or
///           any protocol address — so the Li.Fi `target = USDC, data = transferFrom(victim,…)`
///           vector is structurally impossible.
///         BALANCE-DELTA minOut: the output floor is enforced on the real balance delta this
///           contract receives, NEVER on a number parsed from `swapData`. `swapData` is treated
///           as opaque bytes — no assembly, no offset trust (the z0r0z router $42k class).
///         The router only ever pulls input from `msg.sender` (not arbitrary victims), so a
///           user's approval to this router cannot be turned against a third party.
///
/// @dev    Fee routing reuses this protocol's audited patterns verbatim: native-swap fees accrue
///         in ETH and `distributeFees()` runs the same staker/POL/treasury split as
///         `SwapFeeRouter.distributeFeesToStakers()`; ERC20-swap fees accrue per-token and
///         `sweepTokenFee()` forwards them to the treasury (v1 — no in-contract oracle/conversion).
///
/// @dev    Ships behind the frontend `isDeployed` address gate and the protocol's per-feature
///         audit gate. `revenueDistributor`/`treasury` are immutable to shrink the captured-key
///         surface; there is deliberately NO arbitrary withdraw/rescue hatch — the contract's
///         security rests on having nothing to drain.
///
/// Battle-tested sources: 0x Settler/AllowanceHolder (zero-residual posture); in-repo
///   SwapFeeRouter (FoT balance-delta accounting, dust rule, deadline guards, fee-split,
///   return-data-bomb-safe external call); OZ Ownable2Step/Pausable/ReentrancyGuard/SafeERC20.
contract TegridyFeeExecutorRouter is OwnableNoRenounce, ReentrancyGuard, Pausable, PauseGuardian, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Immutables ──────────────────────────────────────────────────
    address public immutable WETH;
    address public immutable revenueDistributor;
    address public immutable treasury;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS = 10_000;
    /// @notice Hard ceiling on the protocol fee. Matches SwapFeeRouter.MAX_FEE_BPS (1%).
    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice Upper bound on the caller-supplied deadline (anti stale-intent). Matches
    ///         SwapFeeRouter / TegridyRouter (AUDIT L-1).
    uint256 public constant MAX_DEADLINE = 2 hours;
    /// @notice Native-asset sentinel (LlamaSwap / 0x convention) used for `tokenOut`.
    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    /// @notice Timelock on ADDING an aggregator to the allowlist. Removals are instant.
    uint256 public constant TARGET_ALLOWLIST_DELAY = 48 hours;
    bytes32 public constant ALLOW_TARGET = keccak256("ALLOW_TARGET");

    /// @notice Fee-split guardrails (identical to SwapFeeRouter): stakers ≥ 50%, POL ≤ 25%.
    uint256 public constant MIN_STAKER_SHARE_BPS = 5_000;
    uint256 public constant MAX_POL_SHARE_BPS = 2_500;
    bytes32 public constant FEE_SPLIT_CHANGE = keccak256("FEE_SPLIT_CHANGE");
    bytes32 public constant POL_ACCUMULATOR_CHANGE = keccak256("POL_ACCUMULATOR_CHANGE");
    uint256 public constant SPLIT_CHANGE_DELAY = 48 hours;

    // ─── State ───────────────────────────────────────────────────────
    /// @notice Protocol fee in bps (default 25 = 0.25%). Owner-settable, bounded by MAX_FEE_BPS.
    uint256 public feeBps;

    /// @notice Execution-target allowlist (the address `swapData` is sent to).
    mapping(address => bool) public allowedTarget;
    /// @notice Approval-spender allowlist (where the input token is approved — may differ from
    ///         the execution target, e.g. Permit2 / Paraswap TokenTransferProxy / 0x AllowanceHolder).
    mapping(address => bool) public allowedSpender;

    // Pending allowlist proposal (single in-flight, keyed by ALLOW_TARGET).
    address public pendingAllowTarget;
    address public pendingAllowSpender;

    // Fee accounting.
    uint256 public accumulatedETHFees;
    mapping(address => uint256) public accumulatedTokenFees;

    // Three-way split (verbatim SwapFeeRouter semantics). Default 100% stakers.
    uint256 public stakerShareBps = 10_000;
    uint256 public polShareBps = 0;
    address public polAccumulator;
    uint256 public pendingStakerShareBps;
    uint256 public pendingPolShareBps;
    address public pendingPolAccumulator;

    // Pull-pattern queue for a failed staker/POL push (matches SwapFeeRouter AUDIT C4).
    mapping(address => uint256) public pendingDistribution;
    uint256 public totalPendingDistribution;

    // ─── Events ──────────────────────────────────────────────────────
    event SwapExecuted(
        address indexed user,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut,
        address target
    );
    event FeeAccruedETH(uint256 amount);
    event FeeAccruedToken(address indexed token, uint256 amount);
    event FeesDistributed(uint256 stakerAmount, uint256 treasuryAmount, uint256 polAmount);
    event DistributionDeferred(address indexed recipient, uint256 amount);
    event PendingDistributionWithdrawn(address indexed recipient, uint256 amount);
    event TokenFeeSwept(address indexed token, uint256 amount);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TargetAllowProposed(address indexed target, address indexed spender, uint256 executeAfter);
    event TargetAllowed(address indexed target, address indexed spender);
    event TargetAllowCancelled(address indexed target, address indexed spender);
    event TargetRemoved(address indexed target);
    event SpenderRemoved(address indexed spender);
    event FeeSplitProposed(uint256 stakerShareBps, uint256 polShareBps, uint256 executeAfter);
    event FeeSplitUpdated(uint256 stakerShareBps, uint256 polShareBps, uint256 treasuryShareBps);
    event PolAccumulatorProposed(address indexed accumulator, uint256 executeAfter);
    event PolAccumulatorUpdated(address indexed oldAccumulator, address indexed newAccumulator);
    event PauseGuardianSetEvt(address indexed guardian);

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error FeeExceedsMax();
    error DeadlineExpired();
    error DeadlineTooFar();
    error InvalidRecipient();
    error TargetNotAllowed();
    error SpenderNotAllowed();
    error SelfTargetForbidden();
    error TokenIsTarget();
    error NativeOutputUnsupported();
    error InsufficientOutput();
    error SwapCallFailed();
    error ResidualAllowance();
    error SplitInvalid();
    error StakerShareTooLow();
    error PolShareTooHigh();
    error PolShareNonZero();
    error NotAContract();
    error ProtectedAddress();
    error NothingPending();
    error NothingToWithdraw();

    /// @param _weth               Canonical WETH (verified to have code at deploy).
    /// @param _revenueDistributor Push-ETH staker sink (immutable).
    /// @param _treasury           Token-fee + treasury-slice sink (immutable).
    /// @param _feeBps             Initial fee (<= MAX_FEE_BPS).
    /// @param _initialTargets     Genesis execution-target allowlist (the deploy script's
    ///                            operator-verified aggregator routers). Seeded here because
    ///                            post-deploy additions are 48h-timelocked — same genesis
    ///                            bootstrap pattern as SwapFeeRouter's constructor-wired
    ///                            revenueDistributor (DEPLOY-H1). Each is `_assertAllowable`-gated.
    /// @param _initialSpenders    Genesis approval-spender allowlist (TokenTransferProxy /
    ///                            AllowanceHolder / Permit2 / router, per aggregator).
    constructor(
        address _weth,
        address _revenueDistributor,
        address _treasury,
        uint256 _feeBps,
        address[] memory _initialTargets,
        address[] memory _initialSpenders
    ) OwnableNoRenounce(msg.sender) {
        if (_weth == address(0) || _revenueDistributor == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        WETH = _weth;
        revenueDistributor = _revenueDistributor;
        treasury = _treasury;
        feeBps = _feeBps;
        for (uint256 i = 0; i < _initialTargets.length; i++) {
            _assertAllowable(_initialTargets[i]);
            allowedTarget[_initialTargets[i]] = true;
            emit TargetAllowed(_initialTargets[i], address(0));
        }
        for (uint256 i = 0; i < _initialSpenders.length; i++) {
            _assertAllowable(_initialSpenders[i]);
            allowedSpender[_initialSpenders[i]] = true;
            emit TargetAllowed(address(0), _initialSpenders[i]);
        }
    }

    /// @dev Permissive by necessity: ERC20→ETH routes deliver the output ETH to this contract,
    ///      and aggregators vary in which inner address performs that send (router, settler, or
    ///      WETH on unwrap), so a sender-allowlist here would break legitimate routes. This is
    ///      SAFE because fee accounting never reads `address(this).balance`: ETH fees are added to
    ///      `accumulatedETHFees` ONLY by the explicit skim in `swapNative`, and `distributeFees()`
    ///      pays out that counter (not the raw balance). A stray donation is therefore inert
    ///      (and, with no withdraw hatch, simply locked — consistent with "nothing to drain").
    receive() external payable {}

    // ─── Swap: ERC20 input ───────────────────────────────────────────

    /// @notice Swap an ERC20 input via a LlamaSwap-selected route, skimming the protocol fee.
    /// @param tokenIn   Input ERC20 (must be approved to this router by msg.sender).
    /// @param amountIn  Gross input amount (fee is skimmed from this).
    /// @param tokenOut  Output token, or the ETH sentinel for a native-out swap.
    /// @param minOut    Minimum output enforced on the ACTUAL balance delta received.
    /// @param feeBpsMax Caller's accepted fee ceiling (binds the fee at signing time).
    /// @param target    Execution target from the LlamaSwap API `tx.to` (must be allowlisted).
    /// @param spender   Approval target from the API `tokenApprovalAddress` (must be allowlisted).
    /// @param swapData  Opaque swap calldata from the API (built for the NET, post-fee amount).
    /// @param recipient Output recipient (defaults to msg.sender if zero).
    /// @param deadline  Swap deadline (bounded by MAX_DEADLINE).
    function swapERC20(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        uint256 feeBpsMax,
        address target,
        address spender,
        bytes calldata swapData,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        address to = recipient == address(0) ? msg.sender : recipient;
        _preflight(amountIn, to, feeBpsMax, target, tokenIn, tokenOut, deadline);
        if (!allowedSpender[spender]) revert SpenderNotAllowed();

        // Pull input with balance-delta accounting (FoT-safe — use `received`, never `amountIn`).
        uint256 balBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - balBefore;

        // Skim fee in the input token (dust rule mirrors SwapFeeRouter).
        uint256 fee = (received * feeBps) / BPS;
        if (fee == 0 && feeBps > 0) fee = 1;
        uint256 net = received - fee;
        if (fee > 0) {
            accumulatedTokenFees[tokenIn] += fee;
            emit FeeAccruedToken(tokenIn, fee);
        }

        // Measure output on OUR balance delta; output must route through this contract.
        uint256 outBefore = _selfBalance(tokenOut);

        // Scoped approval (exact net) → execute → reset to 0 (INVARIANT-1).
        IERC20(tokenIn).forceApprove(spender, net);
        _execSwap(target, 0, swapData);
        IERC20(tokenIn).forceApprove(spender, 0);
        if (IERC20(tokenIn).allowance(address(this), spender) != 0) revert ResidualAllowance();

        amountOut = _selfBalance(tokenOut) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput();

        _payout(tokenOut, to, amountOut);
        emit SwapExecuted(msg.sender, to, tokenIn, tokenOut, amountIn, fee, amountOut, target);
    }

    // ─── Swap: native (ETH) input ────────────────────────────────────

    /// @notice Swap native ETH via a LlamaSwap-selected route, skimming the protocol fee.
    /// @dev    No approval needed for native input, so there is no `spender`. `tokenOut` must be
    ///         an ERC20 (native→native is nonsensical and rejected).
    function swapNative(
        address tokenOut,
        uint256 minOut,
        uint256 feeBpsMax,
        address target,
        bytes calldata swapData,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        address to = recipient == address(0) ? msg.sender : recipient;
        // tokenIn is native; reuse preflight with tokenIn = ETH sentinel for the guards.
        _preflight(msg.value, to, feeBpsMax, target, ETH, tokenOut, deadline);
        if (tokenOut == ETH) revert NativeOutputUnsupported();

        uint256 fee = (msg.value * feeBps) / BPS;
        if (fee == 0 && feeBps > 0) fee = 1;
        uint256 net = msg.value - fee;
        if (fee > 0) {
            accumulatedETHFees += fee;
            emit FeeAccruedETH(fee);
        }

        uint256 outBefore = _selfBalance(tokenOut);
        // Native input: forward `net` as value to the allowlisted target. No approval/spender.
        _execSwap(target, net, swapData);

        amountOut = _selfBalance(tokenOut) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput();

        _payout(tokenOut, to, amountOut);
        emit SwapExecuted(msg.sender, to, ETH, tokenOut, msg.value, fee, amountOut, target);
    }

    // ─── Internal swap helpers ───────────────────────────────────────

    /// @dev Shared swap preflight: ordered hard checks. Reverts on any violation.
    function _preflight(
        uint256 amountIn,
        address to,
        uint256 feeBpsMax,
        address target,
        address tokenIn,
        address tokenOut,
        uint256 deadline
    ) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(this)) revert InvalidRecipient();
        if (!allowedTarget[target]) revert TargetNotAllowed();
        // Defense-in-depth over the allowlist: target may never be this contract or an ERC20
        // involved in the swap (the Li.Fi `target = token, data = transferFrom(...)` vector).
        if (target == address(this)) revert SelfTargetForbidden();
        if (target == tokenIn || target == tokenOut) revert TokenIsTarget();
        if (feeBps > feeBpsMax || feeBps > MAX_FEE_BPS) revert FeeExceedsMax();
    }

    /// @dev The ONLY external call to a route target. Return data is intentionally NOT captured
    ///      (no `returndatacopy`) — defeats the return-data-bomb griefing vector and forces us to
    ///      trust only the measured balance delta, never the target's claimed output.
    function _execSwap(address target, uint256 value, bytes calldata swapData) internal {
        // slither-disable-next-line low-level-calls,arbitrary-send-eth
        (bool ok,) = target.call{value: value}(swapData);
        if (!ok) revert SwapCallFailed();
    }

    function _selfBalance(address token) internal view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    /// @dev Forward output to the recipient. ETH uses WETHFallbackLib (handles non-receiving
    ///      contracts); ERC20 uses SafeERC20.
    function _payout(address tokenOut, address to, uint256 amountOut) internal {
        if (amountOut == 0) return;
        if (tokenOut == ETH) {
            WETHFallbackLib.safeTransferETHOrWrap(WETH, to, amountOut);
        } else {
            IERC20(tokenOut).safeTransfer(to, amountOut);
        }
    }

    // ─── Fee distribution (verbatim SwapFeeRouter split) ─────────────

    /// @notice Permissionless: split accumulated ETH fees stakers / POL / treasury.
    ///         Verbatim port of SwapFeeRouter.distributeFeesToStakers() incl. the 50k-gas-capped
    ///         pushes and the pendingDistribution pull-fallback (AUDIT C4 / M-4).
    function distributeFees() external nonReentrant whenNotPaused {
        uint256 amount = accumulatedETHFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedETHFees = 0;

        uint256 stakerAmount = (amount * stakerShareBps) / BPS;
        uint256 polAmount = (amount * polShareBps) / BPS;
        uint256 treasuryAmount = amount - stakerAmount - polAmount;

        if (stakerAmount > 0) {
            (bool okStaker,) = revenueDistributor.call{value: stakerAmount, gas: 50_000}("");
            if (!okStaker) {
                pendingDistribution[revenueDistributor] += stakerAmount;
                totalPendingDistribution += stakerAmount;
                emit DistributionDeferred(revenueDistributor, stakerAmount);
            }
        }

        if (polAmount > 0) {
            if (polAccumulator != address(0)) {
                (bool okPol,) = polAccumulator.call{value: polAmount, gas: 50_000}("");
                if (!okPol) {
                    pendingDistribution[polAccumulator] += polAmount;
                    totalPendingDistribution += polAmount;
                    emit DistributionDeferred(polAccumulator, polAmount);
                }
            } else {
                treasuryAmount += polAmount;
                polAmount = 0;
            }
        }

        if (treasuryAmount > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, treasuryAmount);
        }

        emit FeesDistributed(stakerAmount, treasuryAmount, polAmount);
    }

    /// @notice Pull queued ETH for a recipient whose push failed in distributeFees().
    function withdrawPendingDistribution(address recipient) external nonReentrant {
        uint256 amount = pendingDistribution[recipient];
        if (amount == 0) revert NothingToWithdraw();
        pendingDistribution[recipient] = 0;
        totalPendingDistribution -= amount;
        WETHFallbackLib.safeTransferETHOrWrap(WETH, recipient, amount);
        emit PendingDistributionWithdrawn(recipient, amount);
    }

    /// @notice Permissionless: forward accrued token fees to the treasury (v1 — no in-contract
    ///         conversion). Treasury converts to ETH off-chain or via SwapFeeRouter's TWAP-gated path.
    function sweepTokenFee(address token) external nonReentrant {
        uint256 amount = accumulatedTokenFees[token];
        if (amount == 0) revert ZeroAmount();
        accumulatedTokenFees[token] = 0;
        IERC20(token).safeTransfer(treasury, amount);
        emit TokenFeeSwept(token, amount);
    }

    // ─── Admin: fee ──────────────────────────────────────────────────

    /// @notice Set the protocol fee. Instant but hard-bounded by MAX_FEE_BPS (max harm = 1%,
    ///         recoverable; pause/guardian available). The dangerous lever (adding a swap target)
    ///         is timelocked instead — see proposeAllowTarget.
    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    // ─── Admin: allowlist (add = 48h timelock; remove = instant) ─────

    /// @notice Propose adding an aggregator (execution target + approval spender). 48h timelock.
    function proposeAllowTarget(address target, address spender) external onlyOwner {
        _assertAllowable(target);
        _assertAllowable(spender);
        pendingAllowTarget = target;
        pendingAllowSpender = spender;
        _propose(ALLOW_TARGET, TARGET_ALLOWLIST_DELAY);
        emit TargetAllowProposed(target, spender, _proposalReadyAt(ALLOW_TARGET));
    }

    function executeAllowTarget() external onlyOwner {
        _execute(ALLOW_TARGET);
        address target = pendingAllowTarget;
        address spender = pendingAllowSpender;
        // Re-assert at execute time (the address could have self-destructed since propose).
        _assertAllowable(target);
        _assertAllowable(spender);
        allowedTarget[target] = true;
        allowedSpender[spender] = true;
        pendingAllowTarget = address(0);
        pendingAllowSpender = address(0);
        emit TargetAllowed(target, spender);
    }

    function cancelAllowTarget() external onlyOwner {
        _cancel(ALLOW_TARGET);
        emit TargetAllowCancelled(pendingAllowTarget, pendingAllowSpender);
        pendingAllowTarget = address(0);
        pendingAllowSpender = address(0);
    }

    /// @notice Instantly remove an execution target (fail-safe — yank a compromised aggregator).
    function removeTarget(address target) external onlyOwner {
        allowedTarget[target] = false;
        emit TargetRemoved(target);
    }

    /// @notice Instantly remove an approval spender (fail-safe).
    function removeSpender(address spender) external onlyOwner {
        allowedSpender[spender] = false;
        emit SpenderRemoved(spender);
    }

    /// @dev Allowlist-entry guard: non-zero, has contract code (EIP-7702 length-23 carve-out
    ///      per the repo's OwnableNoRenounce pattern), and never a protocol/asset address.
    function _assertAllowable(address a) internal view {
        if (a == address(0)) revert ZeroAddress();
        uint256 codeLen = a.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        if (a == address(this) || a == WETH || a == revenueDistributor || a == treasury || a == polAccumulator) {
            revert ProtectedAddress();
        }
    }

    // ─── Admin: fee split (48h timelock, verbatim SwapFeeRouter bounds) ─

    function proposeFeeSplit(uint256 _stakerShareBps, uint256 _polShareBps) external onlyOwner {
        if (_stakerShareBps < MIN_STAKER_SHARE_BPS) revert StakerShareTooLow();
        if (_polShareBps > MAX_POL_SHARE_BPS) revert PolShareTooHigh();
        if (_stakerShareBps + _polShareBps > BPS) revert SplitInvalid();
        pendingStakerShareBps = _stakerShareBps;
        pendingPolShareBps = _polShareBps;
        _propose(FEE_SPLIT_CHANGE, SPLIT_CHANGE_DELAY);
        emit FeeSplitProposed(_stakerShareBps, _polShareBps, _proposalReadyAt(FEE_SPLIT_CHANGE));
    }

    function executeFeeSplit() external onlyOwner {
        _execute(FEE_SPLIT_CHANGE);
        uint256 s = pendingStakerShareBps;
        uint256 p = pendingPolShareBps;
        // Re-assert bounds at execute (defense-in-depth).
        if (s < MIN_STAKER_SHARE_BPS) revert StakerShareTooLow();
        if (p > MAX_POL_SHARE_BPS) revert PolShareTooHigh();
        if (s + p > BPS) revert SplitInvalid();
        stakerShareBps = s;
        polShareBps = p;
        emit FeeSplitUpdated(s, p, BPS - s - p);
    }

    function cancelFeeSplit() external onlyOwner {
        _cancel(FEE_SPLIT_CHANGE);
    }

    function proposePolAccumulator(address _accumulator) external onlyOwner {
        // address(0) only allowed when polShareBps == 0 (mirrors SwapFeeRouter DEEP-R-M04).
        if (_accumulator == address(0) && polShareBps > 0) revert PolShareNonZero();
        if (_accumulator != address(0)) _assertAllowable(_accumulator);
        pendingPolAccumulator = _accumulator;
        _propose(POL_ACCUMULATOR_CHANGE, SPLIT_CHANGE_DELAY);
        emit PolAccumulatorProposed(_accumulator, _proposalReadyAt(POL_ACCUMULATOR_CHANGE));
    }

    function executePolAccumulator() external onlyOwner {
        _execute(POL_ACCUMULATOR_CHANGE);
        address a = pendingPolAccumulator;
        if (a == address(0) && polShareBps > 0) revert PolShareNonZero();
        address old = polAccumulator;
        polAccumulator = a;
        pendingPolAccumulator = address(0);
        emit PolAccumulatorUpdated(old, a);
    }

    function cancelPolAccumulator() external onlyOwner {
        _cancel(POL_ACCUMULATOR_CHANGE);
        pendingPolAccumulator = address(0);
    }

    // ─── Admin: pause ────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setPauseGuardian(address _newGuardian) external onlyOwner {
        _setPauseGuardian(_newGuardian);
        emit PauseGuardianSetEvt(_newGuardian);
    }

    function guardianPause() external onlyPauseGuardian {
        _pause();
    }

    // ─── Ownership handoff (M19-PORT pending-proposal flush) ──────────
    /// @notice AUDIT FIX 2026-07-12 (due-diligence follow-up): flush every in-flight
    ///         timelock proposal on ownership handoff so a proposal queued by an
    ///         outgoing/compromised owner cannot survive the handoff and mature under
    ///         the incoming owner. Restores the M19-PORT invariant honored by the
    ///         sister admin contracts — replicates each `cancelX` body verbatim under
    ///         an `_executeAfter` guard (`_cancel` reverts when nothing is pending).
    /// @dev    `super.acceptOwnership()` runs first (pendingOwner->owner promotion +
    ///         the OwnableNoRenounce expiry guard) before the flush.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[ALLOW_TARGET] != 0) {
            _cancel(ALLOW_TARGET);
            emit TargetAllowCancelled(pendingAllowTarget, pendingAllowSpender);
            pendingAllowTarget = address(0);
            pendingAllowSpender = address(0);
        }
        if (_executeAfter[FEE_SPLIT_CHANGE] != 0) {
            _cancel(FEE_SPLIT_CHANGE);
        }
        if (_executeAfter[POL_ACCUMULATOR_CHANGE] != 0) {
            _cancel(POL_ACCUMULATOR_CHANGE);
            pendingPolAccumulator = address(0);
        }
    }
}
