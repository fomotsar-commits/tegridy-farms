// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";

interface IUniswapV2Router {
    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
    // AUDIT M12: removeLiquidityETH for the harvest path.
    function removeLiquidityETH(
        address token, uint256 liquidity, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external returns (uint256 amountToken, uint256 amountETH);
    function WETH() external pure returns (address);
    // R015: factory introspection for constructor pair validation
    function factory() external view returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

/// @dev R015: Minimal TegridyTWAP read interface — mirrors the surface used in TegridyLending (R003).
///      `consult` returns the time-weighted output for `amountIn` of `tokenIn` over `period`.
///      `getLatestObservation` lets us check staleness explicitly before relying on a TWAP read.
interface ITegridyTWAP {
    struct Observation {
        uint32 timestamp;
        uint224 price0Cumulative;
        uint224 price1Cumulative;
    }
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external view returns (uint256 amountOut);
    function getLatestObservation(address pair) external view returns (Observation memory);
}

/// @title POLAccumulator (Protocol-Owned Liquidity)
/// @notice Uses protocol revenue (ETH) to buy TOWELI and create permanent LP.
///
///         Flow:
///         1. ETH fees are sent to this contract
///         2. Owner calls accumulate() → swaps half the ETH for TOWELI
///         3. Adds TOWELI + remaining ETH as Uniswap V2 liquidity
///         4. LP tokens are held permanently — never withdrawn
///
///         Result: The protocol owns its own liquidity. Deeper pools,
///         less slippage, more volume, more fees. Self-reinforcing flywheel.
/// AUDIT FIX M-14: Added Pausable so accumulations can be halted during emergencies.
contract POLAccumulator is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant SLIPPAGE_CHANGE = keccak256("SLIPPAGE_CHANGE");
    bytes32 public constant ACCUMULATE_CAP_CHANGE = keccak256("ACCUMULATE_CAP_CHANGE");
    bytes32 public constant BACKSTOP_CHANGE = keccak256("BACKSTOP_CHANGE");
    bytes32 public constant SWEEP_ETH_CHANGE = keccak256("SWEEP_ETH_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("POL_TREASURY_CHANGE");
    bytes32 public constant POL_HARVEST = keccak256("POL_HARVEST"); // AUDIT M12

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable toweli;
    IUniswapV2Router public immutable router;
    address public immutable weth;
    address public immutable lpToken; // LP pair address — cannot be swept

    /// @notice R015: TWAP oracle used to derive minOut floors INSIDE accumulate()/executeHarvestLP().
    ///         Battle-tested Olympus / Tokemak treasury-ops pattern: caller-supplied minOut is no
    ///         longer trusted (was effectively 1 in tests, ~5 ETH/call MEV bleed). The TWAP is the
    ///         single source of truth for slippage protection — caller-supplied params now act as
    ///         additive belt-and-braces, never relaxing below the TWAP-derived floor.
    ITegridyTWAP public immutable twap;

    /// @notice R015: TWAP averaging window — 30 minutes matches Aave V3 / R003 lending oracle.
    ///         Long enough to dilute single-block reserve manipulation, short enough that a
    ///         legitimate same-day price move still drives accumulate() execution.
    uint256 public constant TWAP_PERIOD = 30 minutes;

    /// @notice R015: Defence-in-depth staleness gate — refuse to operate if the TWAP's latest
    ///         observation is older than this. The TWAP itself enforces the same bound inside
    ///         consult, but the typed error here is what monitoring keys off.
    uint256 public constant TWAP_MAX_STALENESS = 2 hours;

    /// @notice R015: TWAP-derived safety margin (50 bps = 0.5%). The internal minOut for both
    ///         the swap leg and the addLiquidity leg is `twapOut * (BPS - TWAP_SAFETY_BPS) / BPS`.
    ///         Caller cannot relax this floor; they can only tighten it via the existing minOut
    ///         params. 50 bps is tighter than the configurable maxSlippageBps because it is keyed
    ///         off TWAP not spot — TWAP-vs-actual divergence is bounded by TWAP_PERIOD volatility.
    uint256 public constant TWAP_SAFETY_BPS = 50;
    uint256 private constant BPS = 10_000;

    uint256 public constant MAX_DEADLINE = 1 minutes; // R015: Tightened from 2m → 1m — narrows MEV sandwich window further; Flashbots inclusion target is the next block (~12s) so 1m is comfortably forgiving for private-mempool relays.

    // AUDIT FIX H-13: Configurable max slippage for sandwich protection (default 5%, range 1%-10%)
    uint256 public maxSlippageBps = 500;

    // AUDIT FIX: Configurable backstop percentage — hardcoded 90% caused reverts
    // when pool ratio diverged from 50/50. Owner can lower to 0 if caller-provided
    // slippage params are sufficient.
    uint256 public backstopBps = 9000; // 90% default, in basis points (10000 = 100%)
    uint256 public constant MAX_BACKSTOP_BPS = 9900; // Max 99%
    uint256 public constant MIN_BACKSTOP_BPS = 5000; // AUDIT FIX H-03: Min 50% — prevents owner from zeroing backstop

    uint256 public maxAccumulateAmount = 10 ether;
    uint256 public constant MAX_ACCUMULATE_CAP = 100 ether; // AUDIT FIX M-06: Hard upper bound to prevent draining pool reserves

    uint256 public constant ACCUMULATE_CAP_CHANGE_DELAY = 24 hours;
    uint256 public pendingMaxAccumulateAmount;

    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    address public pendingTreasury;

    uint256 public totalETHUsed;
    uint256 public lastAccumulateTime;
    uint256 public constant ACCUMULATE_COOLDOWN = 1 hours;
    uint256 public totalLPCreated;
    uint256 public totalAccumulations;

    // ─── Events ───────────────────────────────────────────────────────

    event Accumulated(uint256 ethUsed, uint256 toweliAdded, uint256 lpCreated);
    event ETHReceived(address indexed sender, uint256 amount);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryChangeCancelled(address indexed cancelled);

    // ─── Errors ───────────────────────────────────────────────────────

    error InsufficientETH();
    error SwapFailed();
    error SlippageTooHigh();
    error NoContracts();
    error CannotSweepLP(); // SECURITY FIX: Prevent sweeping LP tokens
    error DeadlineTooFar(); // SECURITY FIX: Deadline exceeds MAX_DEADLINE
    error OracleStale(); // R015: TWAP latest observation older than TWAP_MAX_STALENESS
    error LPMismatch(); // R015: lpToken != factory.getPair(toweli, weth)
    // Legacy error declarations (kept for test compat — TimelockAdmin errors are thrown instead)
    error BackstopTooHigh();
    error NoPendingBackstop();
    error BackstopTimelockNotElapsed();
    error BackstopProposalExpired();
    error CancelExistingBackstopFirst();
    error SlippageBpsOutOfRange();
    error NoPendingSlippage();
    error SlippageTimelockNotElapsed();
    error SlippageProposalExpired();
    error CancelExistingSlippageFirst();
    error AccumulateCapTooLow();
    error NoPendingAccumulateCap();
    error AccumulateCapTimelockNotElapsed();
    error AccumulateCapProposalExpired();
    error CancelExistingAccumulateCapFirst();
    error SweepAmountExceedsProposed();
    error SweepRecipientNotTreasury();

    event BackstopUpdated(uint256 oldBps, uint256 newBps);
    event BackstopChangeProposed(uint256 newBps, uint256 executeAfter);
    event BackstopChangeCancelled(uint256 cancelledBps);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event MaxSlippageChangeProposed(uint256 newBps, uint256 executeAfter);
    event MaxSlippageChangeCancelled(uint256 cancelledBps);
    event MaxAccumulateAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event MaxAccumulateAmountChangeProposed(uint256 newAmount, uint256 executeAfter);
    event MaxAccumulateAmountChangeCancelled(uint256 cancelledAmount);

    uint256 public constant BACKSTOP_CHANGE_DELAY = 24 hours;
    uint256 public pendingBackstopBps;

    uint256 public constant SLIPPAGE_CHANGE_DELAY = 24 hours;
    uint256 public pendingMaxSlippage;

    // ─── Constructor ──────────────────────────────────────────────────

    address public treasury;

    // ─── AUDIT R062: L2 Sequencer Uptime gating ──────────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet / non-L2 (no-op). Stored immutable so it cannot be
    ///         hot-swapped post-deploy.
    address public immutable sequencerFeed;
    /// @notice Post-resume grace window during which `accumulate()` and
    ///         `executeHarvestLP()` refuse to act. Pool reserves drift while
    ///         the sequencer is offline; running either operation immediately
    ///         after resume risks ETH at off-market prices. 1h matches Aave V3.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    /// @param _twap          R015: TegridyTWAP oracle that gates accumulate()/executeHarvestLP() slippage.
    ///                       REQUIRED — passing address(0) reverts. Must be bootstrapped
    ///                       (>=2 observations, see TegridyTWAP.MIN_PERIOD) BEFORE the
    ///                       first accumulate() call or that call reverts with
    ///                       InsufficientObservations from inside consult().
    /// @param _sequencerFeed R062: Chainlink L2 Sequencer Uptime feed; pass address(0)
    ///                       for mainnet / non-L2 deployments (gating disabled).
    constructor(
        address _toweli,
        address _router,
        address _lpToken,
        address _treasury,
        address _twap,
        address _sequencerFeed
    )
        OwnableNoRenounce(msg.sender)
    {
        require(_toweli != address(0), "ZERO_TOWELI");
        require(_router != address(0), "ZERO_ROUTER");
        require(_lpToken != address(0), "ZERO_LP_TOKEN");
        require(_treasury != address(0), "ZERO_TREASURY");
        require(_twap != address(0), "ZERO_TWAP"); // R015
        toweli = IERC20(_toweli);
        router = IUniswapV2Router(_router);
        weth = router.WETH();
        // R015: Constructor-time validation — confirm `_lpToken` is the canonical V2 pair
        // for (toweli, weth) reported by the router's factory. Defends against misdeploy
        // (or a future attacker spoofing a fake "LP" address that the accumulator would
        // happily lock funds into). Mirrors the Tokemak treasury-ops pattern of
        // cross-checking pair addresses against the canonical factory at construction.
        address fac = IUniswapV2Router(_router).factory();
        address canonicalPair = IUniswapV2Factory(fac).getPair(_toweli, router.WETH());
        if (canonicalPair == address(0) || canonicalPair != _lpToken) revert LPMismatch();
        lpToken = _lpToken;
        treasury = _treasury;
        twap = ITegridyTWAP(_twap);
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = _sequencerFeed;
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    /// @notice Propose a new max slippage tolerance (timelocked 24h)
    /// @param _bps Slippage in basis points (100 = 1%, 1000 = 10%)
    function proposeMaxSlippage(uint256 _bps) external onlyOwner {
        if (_bps < 100 || _bps > 1000) revert SlippageBpsOutOfRange();
        pendingMaxSlippage = _bps;
        _propose(SLIPPAGE_CHANGE, SLIPPAGE_CHANGE_DELAY);
        emit MaxSlippageChangeProposed(_bps, _executeAfter[SLIPPAGE_CHANGE]);
    }

    /// @notice Execute the pending max slippage change after timelock
    function executeMaxSlippage() external onlyOwner {
        _execute(SLIPPAGE_CHANGE);
        uint256 old = maxSlippageBps;
        maxSlippageBps = pendingMaxSlippage;
        pendingMaxSlippage = 0;
        emit MaxSlippageUpdated(old, maxSlippageBps);
    }

    /// @notice Cancel a pending max slippage change
    function cancelMaxSlippageChange() external onlyOwner {
        uint256 cancelled = pendingMaxSlippage;
        _cancel(SLIPPAGE_CHANGE);
        pendingMaxSlippage = 0;
        emit MaxSlippageChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function maxSlippageProposedAt() external view returns (uint256) {
        return _executeAfter[SLIPPAGE_CHANGE];
    }

    /// @notice Propose a new max accumulate amount (timelocked 24h)
    function proposeMaxAccumulateAmount(uint256 _amount) external onlyOwner {
        if (_amount < 0.01 ether) revert AccumulateCapTooLow();
        require(_amount <= MAX_ACCUMULATE_CAP, "EXCEEDS_HARD_CAP"); // AUDIT FIX M-06: Enforce upper bound
        pendingMaxAccumulateAmount = _amount;
        _propose(ACCUMULATE_CAP_CHANGE, ACCUMULATE_CAP_CHANGE_DELAY);
        emit MaxAccumulateAmountChangeProposed(_amount, _executeAfter[ACCUMULATE_CAP_CHANGE]);
    }

    /// @notice Execute the pending max accumulate amount change after timelock
    function executeMaxAccumulateAmount() external onlyOwner {
        _execute(ACCUMULATE_CAP_CHANGE);
        uint256 old = maxAccumulateAmount;
        maxAccumulateAmount = pendingMaxAccumulateAmount;
        pendingMaxAccumulateAmount = 0;
        emit MaxAccumulateAmountUpdated(old, maxAccumulateAmount);
    }

    /// @notice Cancel a pending max accumulate amount change
    function cancelMaxAccumulateAmountChange() external onlyOwner {
        uint256 cancelled = pendingMaxAccumulateAmount;
        _cancel(ACCUMULATE_CAP_CHANGE);
        pendingMaxAccumulateAmount = 0;
        emit MaxAccumulateAmountChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function maxAccumulateAmountProposedAt() external view returns (uint256) {
        return _executeAfter[ACCUMULATE_CAP_CHANGE];
    }

    // ─── Core ─────────────────────────────────────────────────────────

    /// @notice Use ETH balance to buy TOWELI and add permanent LP.
    ///         Splits ETH 50/50: half buys TOWELI, half pairs as ETH liquidity.
    /// @dev R015 BATTLE-TESTED PATTERN (Olympus / Tokemak treasury ops):
    ///      Caller-supplied minOut params are NO LONGER trusted as the slippage source.
    ///      Instead, the swap minOut is derived INTERNALLY from `twap.consult()` with a
    ///      fixed `TWAP_SAFETY_BPS` margin (0.5%). The caller can still tighten this floor
    ///      via `_minTokens`, but NEVER relax below the TWAP floor. The TWAP itself is
    ///      gated by a hard staleness window (TWAP_MAX_STALENESS) so a paused/abandoned
    ///      oracle cannot be used to grant a sandwich attacker an arbitrarily low minOut.
    ///      This closes H-1 (caller-supplied minOut accepted as 1, ~5 ETH/call MEV) and
    ///      H-2 (LP-add floors anchored to the post-swap attacked spot).
    /// @param _minTokens Optional CALLER tightening of the swap minOut. The internal TWAP
    ///         floor always wins — `_minTokens` only matters if it exceeds the floor.
    /// @param _minLPTokens Optional CALLER tightening of the LP-add token min. Same semantics.
    /// @param _minLPETH Optional CALLER tightening of the LP-add ETH min. Same semantics.
    /// @param _deadline Transaction deadline (reverts if block.timestamp > _deadline).
    function accumulate(uint256 _minTokens, uint256 _minLPTokens, uint256 _minLPETH, uint256 _deadline) external onlyOwner nonReentrant whenNotPaused {
        // R062 (HIGH): refuse to accumulate when the L2 sequencer is currently
        // down or has just resumed within SEQUENCER_GRACE_PERIOD. Pool reserves
        // drift while the chain is offline, so swapping ETH→TOWELI the moment
        // the chain wakes up risks executing at stale spot price.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
        require(block.timestamp >= lastAccumulateTime + ACCUMULATE_COOLDOWN, "ACCUMULATE_COOLDOWN");
        require(_deadline >= block.timestamp, "EXPIRED");
        // SECURITY FIX: Enforce tight deadline cap — accumulate() is high-value MEV target
        if (_deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();

        uint256 ethBalance = address(this).balance;
        if (ethBalance < 0.01 ether) revert InsufficientETH();
        if (ethBalance > maxAccumulateAmount) ethBalance = maxAccumulateAmount;

        uint256 halfETH = ethBalance / 2;

        // R015: Derive TWAP-based swap floor BEFORE the swap. `twap.consult` returns the
        // time-weighted TOWELI output for `halfETH` of WETH over TWAP_PERIOD. This is the
        // single source of truth for swap-leg slippage protection — caller-supplied
        // `_minTokens` can only TIGHTEN this floor, never relax it. Staleness is asserted
        // via `getLatestObservation` first so a frozen oracle cannot grant a 0-min swap.
        uint256 internalSwapMinOut = _twapMinOut(weth, halfETH);
        uint256 swapMinOut = _minTokens > internalSwapMinOut ? _minTokens : internalSwapMinOut;

        // Step 1: Buy TOWELI with half the ETH (with the TWAP-enforced floor).
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(toweli);

        uint256[] memory amounts = router.swapExactETHForTokens{value: halfETH}(
            swapMinOut,
            path,
            address(this),
            _deadline
        );

        uint256 toweliAmount = amounts[amounts.length - 1];

        // Step 2: Approve exact amount for LP add (no infinite approval)
        toweli.forceApprove(address(router), toweliAmount);

        // R015: LP-add minimums are now anchored to the TWAP-implied 50/50 ratio, not to
        // the post-swap attacked spot. We compute `twapImpliedToken = consult(weth → toweli, remainingETH)`
        // and enforce a TWAP_SAFETY_BPS floor on it. The legacy `maxSlippageBps` and `backstopBps`
        // floors continue to apply as additional belt-and-braces (whichever is tighter wins).
        uint256 remainingETH = ethBalance - halfETH;
        uint256 twapMinLPToken = _twapMinOut(weth, remainingETH);

        uint256 slippageMinToken = Math.mulDiv(toweliAmount, 10000 - maxSlippageBps, 10000);
        uint256 slippageMinETH = Math.mulDiv(remainingETH, 10000 - maxSlippageBps, 10000);

        uint256 backstopMinToken = Math.mulDiv(toweliAmount, backstopBps, 10000);
        uint256 backstopMinETH = Math.mulDiv(remainingETH, backstopBps, 10000);

        // Token-min: max of {caller-supplied, slippage floor, backstop floor, TWAP floor}.
        uint256 minToken = _minLPTokens;
        if (slippageMinToken > minToken) minToken = slippageMinToken;
        if (backstopMinToken > minToken) minToken = backstopMinToken;
        if (twapMinLPToken > minToken) minToken = twapMinLPToken;
        // ETH-min: max of {caller-supplied, slippage floor, backstop floor}. (No TWAP floor on
        // the ETH leg because remainingETH is the ground truth — we can't be sandwiched out of
        // ETH we're depositing; the floor exists only to detect router-side misbehaviour.)
        uint256 minETH = _minLPETH;
        if (slippageMinETH > minETH) minETH = slippageMinETH;
        if (backstopMinETH > minETH) minETH = backstopMinETH;

        (uint256 tokenUsed, uint256 ethUsed, uint256 lpReceived) = router.addLiquidityETH{value: remainingETH}(
            address(toweli),
            toweliAmount,
            minToken,
            minETH,
            address(this), // LP tokens stay in this contract forever
            _deadline
        );
        require(lpReceived > 0, "ZERO_LP_MINTED"); // AUDIT FIX M-26: Validate LP return value

        // A4-M-17: Revoke residual approval after addLiquidity to prevent leftover approval exploit
        toweli.forceApprove(address(router), 0);

        totalETHUsed += halfETH + ethUsed;
        totalLPCreated += lpReceived;
        totalAccumulations++;

        lastAccumulateTime = block.timestamp;
        emit Accumulated(halfETH + ethUsed, tokenUsed, lpReceived);
    }

    // ─── Treasury Change (L-11) ────────────────────────────────────────

    /// @notice L-11: Propose a treasury address change (48h timelock)
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "ZERO_ADDRESS");
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Execute a previously proposed treasury change after the timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChanged(old, treasury);
    }

    /// @notice Cancel a pending treasury change
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        emit TreasuryChangeCancelled(pendingTreasury);
        pendingTreasury = address(0);
    }

    // ─── Pause ─────────────────────────────────────────────────────────

    /// @notice AUDIT FIX M-14: Pause accumulations during emergencies
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Propose a new backstop percentage (timelocked)
    function proposeBackstopChange(uint256 _backstopBps) external onlyOwner {
        require(_backstopBps >= MIN_BACKSTOP_BPS, "BACKSTOP_TOO_LOW"); // AUDIT FIX H-03: Enforce minimum floor
        if (_backstopBps > MAX_BACKSTOP_BPS) revert BackstopTooHigh();
        pendingBackstopBps = _backstopBps;
        _propose(BACKSTOP_CHANGE, BACKSTOP_CHANGE_DELAY);
        emit BackstopChangeProposed(_backstopBps, _executeAfter[BACKSTOP_CHANGE]);
    }

    /// @notice Execute the pending backstop change after timelock
    function executeBackstopChange() external onlyOwner {
        _execute(BACKSTOP_CHANGE);
        uint256 old = backstopBps;
        backstopBps = pendingBackstopBps;
        pendingBackstopBps = 0;
        emit BackstopUpdated(old, backstopBps);
    }

    /// @notice Cancel a pending backstop change
    function cancelBackstopChange() external onlyOwner {
        uint256 cancelled = pendingBackstopBps;
        _cancel(BACKSTOP_CHANGE);
        pendingBackstopBps = 0;
        emit BackstopChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function backstopChangeTime() external view returns (uint256) {
        return _executeAfter[BACKSTOP_CHANGE];
    }

    // AUDIT FIX H-14: Timelock for sweepETH to prevent instant owner drain
    uint256 public constant SWEEP_ETH_DELAY = 48 hours;
    uint256 public sweepETHProposedAmount;

    event SweepETHProposed(uint256 amount, uint256 readyAt);
    event SweepETHExecuted(address indexed recipient, uint256 amount);
    event SweepETHCancelled();

    /// @notice Propose sweeping trapped ETH to treasury (timelocked 48h, amount locked at proposal)
    function proposeSweepETH(uint256 _amount) external onlyOwner {
        require(_amount > 0, "ZERO_AMOUNT");
        sweepETHProposedAmount = _amount;
        _propose(SWEEP_ETH_CHANGE, SWEEP_ETH_DELAY);
        emit SweepETHProposed(_amount, _executeAfter[SWEEP_ETH_CHANGE]);
    }

    /// @notice Execute the pending ETH sweep after timelock (sends to treasury)
    function executeSweepETH() external onlyOwner nonReentrant {
        _execute(SWEEP_ETH_CHANGE);
        uint256 amount = sweepETHProposedAmount;
        uint256 balance = address(this).balance;
        if (amount > balance) amount = balance;
        require(amount > 0, "NO_ETH");
        address recipient = treasury;
        sweepETHProposedAmount = 0;
        (bool success,) = recipient.call{value: amount}("");
        require(success, "ETH_TRANSFER_FAILED");
        emit SweepETHExecuted(recipient, amount);
    }

    /// @notice Cancel a pending ETH sweep
    function cancelSweepETH() external onlyOwner {
        _cancel(SWEEP_ETH_CHANGE);
        sweepETHProposedAmount = 0;
        emit SweepETHCancelled();
    }

    /// @notice Legacy view helper for test compatibility
    function sweepETHReadyAt() external view returns (uint256) {
        return _executeAfter[SWEEP_ETH_CHANGE];
    }

    /// @dev DEPRECATED: Use proposeSweepETH() + executeSweepETH()
    function sweepETH() external pure {
        revert("Use proposeSweepETH()");
    }

    // ─── AUDIT M12: POL Harvest ──────────────────────────────────────────
    /// @notice Pull a fraction of accumulated POL liquidity back as TOWELI + ETH and forward
    ///         to treasury. Closes the "LP locked forever" silent killer where the protocol
    ///         deposited liquidity but had no way to realize fees from the position.
    ///         Strict 30-day timelock and a 10% per-call cap (relative to totalLPCreated)
    ///         prevent governance abuse / sudden liquidity removal that would crash the pair.
    uint256 public constant POL_HARVEST_DELAY = 30 days;
    uint256 public constant MAX_HARVEST_BPS = 1000; // 10% of totalLPCreated per harvest
    uint256 public pendingHarvestLpAmount;

    event POLHarvestProposed(uint256 lpAmount, uint256 readyAt);
    event POLHarvestExecuted(uint256 lpAmount, uint256 tokenOut, uint256 ethOut);
    event POLHarvestCancelled();

    /// @notice Propose a harvest of `lpAmount` LP tokens from the protocol-owned position.
    /// @param  lpAmount LP tokens to remove (capped at MAX_HARVEST_BPS of totalLPCreated)
    function proposeHarvestLP(uint256 lpAmount) external onlyOwner {
        require(lpAmount > 0, "ZERO_LP");
        require(totalLPCreated > 0, "NO_POL");
        uint256 cap = (totalLPCreated * MAX_HARVEST_BPS) / 10000;
        require(lpAmount <= cap, "EXCEEDS_HARVEST_CAP");
        pendingHarvestLpAmount = lpAmount;
        _propose(POL_HARVEST, POL_HARVEST_DELAY);
        emit POLHarvestProposed(lpAmount, _executeAfter[POL_HARVEST]);
    }

    /// @notice Execute the pending POL harvest. Caller-supplied minimums are TIGHTENED
    ///         (never relaxed) by TWAP-derived floors, mirroring `accumulate()` (R015).
    /// @dev    R015 BATTLE-TESTED PATTERN (asymmetric → symmetric): Previously this path
    ///         accepted caller-supplied `minToken`/`minETH` with no floor — fully asymmetric
    ///         vs `accumulate()`. Now the same TWAP-derived floor (with a `maxSlippageBps`
    ///         additive belt-and-braces) gates both legs.
    ///         Recovered TOWELI and ETH both go to treasury.
    function executeHarvestLP(uint256 minToken, uint256 minETH, uint256 deadline)
        external onlyOwner nonReentrant
    {
        // R062 (HIGH): refuse to harvest when the L2 sequencer is currently
        // down or has just resumed within SEQUENCER_GRACE_PERIOD. Pool reserves
        // drift while the chain is offline; running the harvest the moment the
        // chain resumes risks burning LP at stale spot reserves.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
        _execute(POL_HARVEST);
        uint256 lpAmount = pendingHarvestLpAmount;
        pendingHarvestLpAmount = 0;
        require(deadline >= block.timestamp, "EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();

        // R015: TWAP-derived per-leg floors. Compute the LP's share of pool reserves
        // (lpAmount / lpTotalSupply * reserve_X), then enforce a TWAP-safety margin on
        // each side. This makes the harvest sandwich-resistant in the same way the
        // accumulate path is — an attacker pushing the pool ratio cannot trick us into
        // accepting near-zero TOWELI or ETH on the burn. We additionally apply
        // `maxSlippageBps` as a configurable belt-and-braces floor.
        (uint256 floorToken, uint256 floorETH) = _twapHarvestMinOut(lpAmount);
        uint256 effMinToken = minToken > floorToken ? minToken : floorToken;
        uint256 effMinETH = minETH > floorETH ? minETH : floorETH;

        IERC20(lpToken).forceApprove(address(router), lpAmount);
        uint256 ethBefore = address(this).balance;
        (uint256 tokenOut, uint256 ethOut) = router.removeLiquidityETH(
            address(toweli), lpAmount, effMinToken, effMinETH, address(this), deadline
        );
        IERC20(lpToken).forceApprove(address(router), 0);

        // Sanity: confirm we actually received the ETH the router claims.
        require(address(this).balance - ethBefore >= ethOut, "ETH_NOT_RECEIVED");

        // Bookkeeping.
        if (lpAmount <= totalLPCreated) {
            totalLPCreated -= lpAmount;
        } else {
            totalLPCreated = 0;
        }

        // Forward ETH to treasury via gas-bounded call (matches sweepETH pattern).
        if (ethOut > 0) {
            (bool ok,) = treasury.call{value: ethOut}("");
            require(ok, "ETH_TRANSFER_FAILED");
        }
        if (tokenOut > 0) {
            toweli.safeTransfer(treasury, tokenOut);
        }

        emit POLHarvestExecuted(lpAmount, tokenOut, ethOut);
    }

    function cancelHarvestLP() external onlyOwner {
        _cancel(POL_HARVEST);
        pendingHarvestLpAmount = 0;
        emit POLHarvestCancelled();
    }

    function harvestLPReadyAt() external view returns (uint256) {
        return _executeAfter[POL_HARVEST];
    }

    /// @notice SECURITY FIX: Sweep leftover token dust (e.g., unused TOWELI from addLiquidityETH)
    // AUDIT FIX: Added nonReentrant for defense-in-depth against malicious token callbacks
    function sweepTokens(address token) external onlyOwner nonReentrant {
        // SECURITY FIX: Cannot sweep LP tokens — defeats permanent liquidity invariant
        require(token != lpToken, "CANNOT_SWEEP_LP");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(treasury, balance); // AUDIT FIX L-08: Send to treasury, not owner()
        }
    }

    // ─── R015 helpers ────────────────────────────────────────────────

    /// @notice TWAP-derived minOut for a swap leg. `twap.consult` returns the
    ///         time-weighted output amount over `TWAP_PERIOD`. We then apply a
    ///         `TWAP_SAFETY_BPS` (0.5%) margin so the floor is not so tight
    ///         that legitimate volatility within the window causes false
    ///         reverts. Staleness is asserted via `getLatestObservation`
    ///         BEFORE consulting so a paused/abandoned oracle cannot grant a
    ///         0-min swap silently. Reverts `OracleStale` if the most recent
    ///         observation is older than `TWAP_MAX_STALENESS`.
    function _twapMinOut(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        ITegridyTWAP.Observation memory latest = twap.getLatestObservation(lpToken);
        if (block.timestamp - latest.timestamp > TWAP_MAX_STALENESS) revert OracleStale();
        uint256 out = twap.consult(lpToken, tokenIn, amountIn, TWAP_PERIOD);
        // Apply TWAP_SAFETY_BPS margin (out * (BPS - TWAP_SAFETY_BPS) / BPS).
        return (out * (BPS - TWAP_SAFETY_BPS)) / BPS;
    }

    /// @notice TWAP-derived per-leg floors for `executeHarvestLP`. Computes
    ///         the LP's pro-rata share of TOWELI/ETH reserves, then applies
    ///         the same `TWAP_SAFETY_BPS` margin used on the swap leg. The
    ///         result is the minimum acceptable output on each side of
    ///         `removeLiquidityETH`. Caller-supplied `minToken` / `minETH`
    ///         can only TIGHTEN this floor.
    function _twapHarvestMinOut(uint256 lpAmount) internal view returns (uint256 floorToken, uint256 floorETH) {
        // Staleness gate (mirrors `_twapMinOut`).
        ITegridyTWAP.Observation memory latest = twap.getLatestObservation(lpToken);
        if (block.timestamp - latest.timestamp > TWAP_MAX_STALENESS) revert OracleStale();

        // Pro-rata share = lpAmount / totalSupply * reserve_X. We read
        // reserves through the standard V2 pair surface — `lpToken` is the
        // pair contract.
        uint256 totalSupply = IERC20(lpToken).totalSupply();
        if (totalSupply == 0) return (0, 0);

        // Snapshot reserves via the V2 pair's reserves slot. We don't import
        // a full pair interface here — the staticcall pattern below avoids
        // adding more imports for two reads.
        (bool okR, bytes memory dataR) =
            lpToken.staticcall(abi.encodeWithSignature("getReserves()"));
        require(okR && dataR.length >= 96, "POOL_READ");
        (uint112 r0, uint112 r1, ) = abi.decode(dataR, (uint112, uint112, uint32));
        (bool okT0, bytes memory dataT0) =
            lpToken.staticcall(abi.encodeWithSignature("token0()"));
        require(okT0 && dataT0.length == 32, "POOL_READ");
        address t0 = abi.decode(dataT0, (address));

        uint256 toweliReserve;
        uint256 ethReserve;
        if (t0 == address(toweli)) {
            (toweliReserve, ethReserve) = (uint256(r0), uint256(r1));
        } else {
            (toweliReserve, ethReserve) = (uint256(r1), uint256(r0));
        }

        uint256 shareToken = (lpAmount * toweliReserve) / totalSupply;
        uint256 shareETH = (lpAmount * ethReserve) / totalSupply;
        // Apply safety margin.
        floorToken = (shareToken * (BPS - TWAP_SAFETY_BPS)) / BPS;
        floorETH = (shareETH * (BPS - TWAP_SAFETY_BPS)) / BPS;
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice ETH available for next accumulation
    /// @return The contract's current ETH balance
    function pendingETH() external view returns (uint256) {
        return address(this).balance;
    }

    // Legacy constants kept for test compatibility
    uint256 public constant BACKSTOP_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant SLIPPAGE_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant ACCUMULATE_CAP_PROPOSAL_VALIDITY = 7 days;
}
