// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title TegridyFeeHook
/// @notice Uniswap V4 hook that captures a portion of swap fees and sends them
///         to the RevenueDistributor for ETH yield distribution to veTOWELI holders.
///
///         This hook implements `afterSwap` to skim a fee from each swap.
///         The fee is configurable by the owner.
///
///         DEPLOYMENT NOTE: V4 hooks must be deployed to addresses with specific bit patterns.
///         The address must encode which hooks are active. For afterSwap only, the address
///         must have the AFTER_SWAP_FLAG bit set. Use CREATE2 with salt mining to find
///         a valid deployment address.
///
///         Hook flags needed: afterSwap (0x0040) | afterSwapReturnsDelta (0x0004)
///         => combined deploy-address bitmask 0x0044
contract TegridyFeeHook is IHooks, OwnableNoRenounce, Pausable, ReentrancyGuard, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("FEE_CHANGE");
    bytes32 public constant DISTRIBUTOR_CHANGE = keccak256("DISTRIBUTOR_CHANGE");
    bytes32 public constant SYNC_CHANGE = keccak256("SYNC_CHANGE");

    IPoolManager public immutable poolManager;
    address public revenueDistributor;
    uint256 public feeBps; // Fee in basis points (e.g., 30 = 0.3%)
    uint256 public constant MAX_FEE_BPS = 100; // Max 1% (H-09: reduced from 500 to match SwapFeeRouter)

    // SECURITY FIX: Timelock for fee changes
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public pendingFee;

    // SECURITY FIX: Timelock for distributor changes
    uint256 public constant DISTRIBUTOR_CHANGE_DELAY = 48 hours;
    address public pendingDistributor;

    event FeeCollected(address indexed token, uint256 amount);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event DistributorUpdated(address indexed oldDist, address indexed newDist);
    event FeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeTime);
    event DistributorChangeProposed(address currentDistributor, address newDistributor, uint256 executeTime);
    event ETHSwept(address indexed to, uint256 amount);

    error OnlyPoolManager();
    error FeeTooHigh();
    error ZeroAddress();
    // Legacy error declarations (kept for test compat — TimelockAdmin errors are thrown instead)
    error NoPendingFeeChange();
    error FeeChangeNotReady();
    error NoPendingDistributorChange();
    error DistributorChangeNotReady();
    // ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32)
    error ExceedsAccrued();
    error FeeOverflow();
    error SweepFailed();
    error NoPendingSync();
    error SyncNotReady();
    error SyncReductionTooLarge();
    error AboveOnChainCredit();
    error SyncIncreaseTooLarge(); // AUDIT R014: per-step upward sync ceiling exceeded
    /// @notice AUDIT FIX V2-AMM-M3: typed error for the restored M-32 recipient
    ///         allowlist on `sweepETH`. Reverts when the owner-supplied recipient
    ///         is neither `revenueDistributor` nor `owner()`.
    error InvalidSweepRecipient();

    // SECURITY FIX: Track fees actually earned per token to prevent over-claiming
    mapping(address => uint256) public accruedFees;

    // AUDIT FIX: Timelock for syncAccruedFees to prevent instant fee destruction
    uint256 public constant SYNC_DELAY = 24 hours;
    uint256 public constant SYNC_COOLDOWN = 7 days;
    mapping(address => uint256) public lastSyncExecuted;
    mapping(address => uint256) public pendingSyncCredit;

    // AUDIT R014 (MEDIUM, upward-sync ceiling): cap each successful upward
    // sync at 10% of the prior accruedFees value. Combined with the existing
    // 24h proposal timelock + 7d cooldown, raising the value 10× now requires
    // ~24 successful proposals over ~24 weeks — making rapid fee inflation by
    // a compromised owner economically and operationally infeasible while
    // leaving legitimate drift recovery achievable across multiple cycles.
    // Bypass for the bootstrap case (currentAccruedFees == 0): we allow
    // setting any value bounded by the on-chain PoolManager credit, since
    // 10% of 0 is 0 and the contract would otherwise be unrecoverable.
    uint256 public constant MAX_SYNC_INCREASE_BPS = 1000; // 10%

    /// @notice AUDIT FIX D-AMM-M4: snapshot of `poolManager.balanceOf(this, currency)`
    ///         captured at `proposeSyncAccruedFees` time. Pre-fix, the on-chain credit
    ///         was read at execute time, which let a permissionless `claimFees` race
    ///         drain the credit balance during the 24h timelock — the legitimate
    ///         drift-correction proposal would then revert AboveOnChainCredit.
    mapping(address => uint256) public pendingSyncCreditSnapshot;

    // Legacy constant kept for test compatibility
    uint256 public constant MAX_PROPOSAL_VALIDITY = 7 days;

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    /// @dev M-15: The hook address must have the correct bit pattern (0x0044) encoding
    ///      afterSwap (0x0040) + afterSwapReturnsDelta (0x0004). This is enforced by the
    ///      PoolManager during pool initialization — if the address does not match, the
    ///      PoolManager will revert. Use CREATE2 with salt mining to deploy to a valid address.
    /// @dev Wave 0 redeploy: takes `_owner` as an explicit constructor arg so CREATE2
    ///      deploys via Arachnid's proxy don't strand ownership on the proxy address.
    ///      Pass the creator EOA (or multisig) directly; msg.sender is only the proxy
    ///      when reached through the canonical deterministic deployer.
    constructor(IPoolManager _poolManager, address _revenueDistributor, uint256 _feeBps, address _owner)
        OwnableNoRenounce(_owner)
    {
        // OwnableNoRenounce(_owner) above already reverts with OwnableInvalidOwner
        // if _owner is address(0), so we don't duplicate the check here.
        if (address(_poolManager) == address(0) || _revenueDistributor == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        // AUDIT FIX D-AMM-INFO1 (NatSpec only): mask 0x3FFF covers the lower 14 bits
        // matching V4's current 14 hook permission flags. The exclusive equality
        // `& 0x3FFF == 0x0044` requires *exactly* afterSwap (0x0040) +
        // afterSwapReturnsDelta (0x0004), rejecting all other flags. We do NOT
        // widen the mask to 0xFFFF because V4 currently only assigns 14 hook-flag
        // bits; if V4 ever adds bits 14+, this constant must be revised in tandem
        // with v4-core's `Hooks.permissionsToFlags` to keep this constructor
        // exclusive over the new flag space. Pattern: v4-periphery's
        // `Hooks.validateHookPermissions` in BaseHook.
        require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");

        poolManager = _poolManager;
        revenueDistributor = _revenueDistributor;
        feeBps = _feeBps;
    }

    // ─── Pausable Admin ──────────────────────────────────────────────

    /// @notice Pause the hook, preventing afterSwap from collecting fees (L-05)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the hook (L-05)
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Hook Implementations ─────────────────────────────────────────

    // We only use afterSwap — all other hooks return the selector to indicate "no-op"

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta)
    {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta)
    {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external pure returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Called after every swap. Captures a fee and sends to revenue distributor.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // AUDIT FIX: When paused, return zero fee instead of reverting — reverting would block ALL pool swaps
        if (paused()) {
            return (IHooks.afterSwap.selector, int128(0));
        }
        // AUDIT FIX L-04: Early return on zero-delta swaps to prevent phantom fee accounting
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        if (amount0 == 0 && amount1 == 0) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        // AUDIT FIX C-2: V4 BalanceDelta is from the SWAPPER's perspective:
        //   negative delta = swapper paid (input)
        //   positive delta = swapper received (output)
        //
        // The hook fee is taken from the UNSPECIFIED currency (the side the
        // PoolManager solves for during the swap — opposite to amountSpecified).
        //
        //   Exact-input  (amountSpecified < 0): fee on OUTPUT (positive unspecified-side delta)
        //     - zeroForOne   → specified = currency0, unspecified = currency1
        //     - !zeroForOne  → specified = currency1, unspecified = currency0
        //
        //   Exact-output (amountSpecified > 0): fee on INPUT (negative unspecified-side delta)
        //     - zeroForOne   → specified = currency1, unspecified = currency0
        //     - !zeroForOne  → specified = currency0, unspecified = currency1
        //
        // Identical structure to the canonical Uniswap V4 FeeTakingHook
        // (lib/v4-core/src/test/FeeTakingHook.sol:33-51). The earlier version
        // of this function inverted the convention and computed the fee from
        // the INPUT raw units while crediting it as OUTPUT raw units — a
        // decimals-mismatched pair (e.g. WETH↔USDC) DoS'd in one direction
        // (user owed billions of USDC) and under-collected by ~12 orders of
        // magnitude in the other.
        bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
        Currency feeCurrency;
        int128 swapAmount;
        if (specifiedIsZero) {
            feeCurrency = key.currency1;
            swapAmount = amount1;
        } else {
            feeCurrency = key.currency0;
            swapAmount = amount0;
        }
        // Take absolute value of the unspecified-side delta so feeBps applies
        // correctly whether the unspecified side is positive (output, exact-input
        // case) or negative (input, exact-output case).
        if (swapAmount < 0) swapAmount = -swapAmount;

        if (swapAmount == 0) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        uint256 absAmount = uint256(uint128(swapAmount));
        uint256 feeUint = (absAmount * feeBps) / 10000;

        // Minimum fee of 1 unit when feeBps > 0 and the swap amount is large
        // enough that integer-division-down rounded the fee to zero. The
        // absRelevant > 1 guard avoids charging a fee on a 1-wei dust swap.
        if (feeUint == 0 && feeBps > 0 && absAmount > 1) {
            feeUint = 1;
        }

        if (feeUint == 0) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");
        int128 feeAmount = int128(uint128(feeUint));

        address creditToken = Currency.unwrap(feeCurrency);
        accruedFees[creditToken] += feeUint;
        emit FeeCollected(creditToken, feeUint);

        // PASS7-HOOK-01 FIX: settle the hook's positive delta WITHIN the unlock
        // context by taking the fee from the PoolManager directly into this
        // hook's contract balance. Pre-fix, returning `feeAmount` registered a
        // positive hook delta but no `poolManager.take()` was called to settle
        // it — the swap router's `unlockCallback` only settles the CALLER's
        // delta, leaving the hook's delta non-zero, and PoolManager's
        // `unlock()` close fired `CurrencyNotSettled` and reverted the entire
        // swap. Result: 100% of swaps on every V4 pool with this hook attached
        // would have reverted.
        //
        // Pattern of record: lib/v4-core/src/test/FeeTakingHook.sol:48 — the
        // canonical V4 fee-skim reference. The `take()` call drains the fee
        // into the hook's ERC20 balance AND registers a negative hook delta
        // that exactly cancels the positive delta from the returned
        // `feeAmount`, so the net hook delta at unlock-close is zero.
        //
        // PASS7-HOOK-03 also fixed by this change: `claimFees` no longer
        // needs to call `poolManager.take()` (which would revert
        // ManagerLocked outside an unlock context) — the fees are already in
        // this contract's ERC20 balance, so claimFees becomes a plain
        // IERC20.safeTransfer to revenueDistributor.
        poolManager.take(feeCurrency, address(this), feeUint);

        // Returned to PoolManager as hookDeltaUnspecified — applied as
        // `swapDelta -= toBalanceDelta(0, feeAmount)` (or amount0 leg for
        // !specifiedIsZero), correctly reducing what the user receives /
        // increasing what the user pays by exactly `feeUint` unspecified-side units.
        // Net hook delta after take() + return: zero — no CurrencyNotSettled.
        return (IHooks.afterSwap.selector, feeAmount);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }

    // ─── Fee Claiming ─────────────────────────────────────────────────

    /// @notice H-06: Claim accumulated fee credits from the PoolManager.
    ///         Permissionless — fees are always sent to revenueDistributor, so anyone
    ///         can trigger the claim without risk.
    ///         If accruedFees drifts above the PoolManager's actual credit (e.g., due to
    ///         rounding), poolManager.take will revert, which atomically rolls back the
    ///         accruedFees decrement. This provides natural protection against over-claiming.
    /// @param currency The token address to claim fees for
    /// @param amount The amount of fees to claim
    /// @dev AUDIT FIX H-05: Added nonReentrant to prevent reentrancy during PoolManager interaction
    /// @dev AUDIT FIX D-AMM-M3: respect `paused()`. The pre-fix pause modifier only
    ///      halted afterSwap-time fee accrual; permissionless `claimFees` could
    ///      continue draining `accruedFees` while a distributor-rotation timelock
    ///      was pending. Pause is a circuit breaker.
    /// @dev AUDIT FIX D-AMM-M1: while a sync proposal for `currency` is pending,
    ///      revert `SYNC_PENDING`. Pre-fix a permissionless drain race could push
    ///      `accruedFees[currency]` to 0 during the 24h sync timelock.
    /// @dev AUDIT FIX V2-AMM-M1: an EXPIRED sync proposal (one whose
    ///      `_executeAfter[key] + PROPOSAL_VALIDITY < block.timestamp`) no longer
    ///      blocks `claimFees`. Pre-fix the gate was a raw `_proposalReadyAt(key)
    ///      == 0` check; an owner who forgot (or was prevented) from cancelling a
    ///      stale proposal would have permanently bricked claimFees because
    ///      `_executeAfter[key]` is only cleared by `_execute` or `_cancel`. After
    ///      the proposal validity window has elapsed, the proposal can no longer
    ///      be executed (TimelockAdmin._execute would revert ProposalExpired), so
    ///      treating it as effectively cancelled is safe. The 24h propose-side
    ///      DoS surface remains: an active malicious owner can re-propose every
    ///      block and indefinitely block claimFees, but that is the originally-
    ///      intended timelock semantics — fixing it requires moving the owner to
    ///      a multisig. Pattern of record: Compound Timelock allows anyone to
    ///      observe expiration once `eta + GRACE_PERIOD < block.timestamp`.
    function claimFees(address currency, uint256 amount) external nonReentrant whenNotPaused {
        bytes32 syncKey = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        uint256 readyAt = _proposalReadyAt(syncKey);
        require(
            readyAt == 0 || block.timestamp > readyAt + _proposalValidity(),
            "SYNC_PENDING"
        );
        if (amount > accruedFees[currency]) revert ExceedsAccrued();
        accruedFees[currency] -= amount;
        // PASS7-HOOK-03 FIX: forward the hook's ERC20 balance directly to the
        // revenue distributor. Pre-fix, this called `poolManager.take(...)`
        // outside any unlock context, which always reverted `ManagerLocked`
        // because `take` is `onlyWhenUnlocked`. Now that `afterSwap` uses
        // `poolManager.take(feeCurrency, address(this), feeUint)` to settle
        // the hook's delta inside the unlock, the fees live in this hook's
        // own ERC20 balance — a plain SafeERC20.safeTransfer is sufficient
        // and works in any tx context (no V4 unlock dependency).
        IERC20(currency).safeTransfer(revenueDistributor, amount);
        emit FeeCollected(currency, amount);
    }

    /// @notice AUDIT FIX: Propose syncing accruedFees downward (24h timelock).
    ///         Prevents instant fee destruction by a compromised owner.
    /// @param currency The token address to sync
    /// @param actualCredit The actual credit balance from the PoolManager (verified off-chain)
    /// @dev AUDIT FIX D-AMM-L1: reject same-value no-op proposals (mirrors SAME_VALUE).
    /// @dev AUDIT FIX D-AMM-M4: snapshot `poolManager.balanceOf(this, currency)` at
    ///      propose time. At execute time the upward bound is checked against the
    ///      snapshot rather than a live read, so a permissionless `claimFees` race
    ///      cannot DoS legitimate drift-correction by draining the on-chain credit
    ///      between propose and execute.
    function proposeSyncAccruedFees(address currency, uint256 actualCredit) external onlyOwner {
        require(actualCredit != accruedFees[currency], "SAME_VALUE");
        bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        pendingSyncCredit[currency] = actualCredit;
        // AUDIT FIX D-AMM-M4: snapshot on-chain credit at propose time.
        pendingSyncCreditSnapshot[currency] = poolManager.balanceOf(
            address(this),
            CurrencyLibrary.toId(Currency.wrap(currency))
        );
        _propose(key, SYNC_DELAY);
        emit SyncProposed(currency, actualCredit, _executeAfter[key]);
    }

    /// @notice Execute a previously proposed fee sync after the timelock expires.
    ///         AUDIT FIX H-01: Removed the 50% max reduction cap. The cap prevented recovery
    ///         when accruedFees drifted significantly from PoolManager credits (e.g., after
    ///         millions of swaps with rounding). The 24h timelock + 7-day cooldown provide
    ///         sufficient protection against misuse by a compromised owner.
    /// @dev    AUDIT H-5 (HIGH): allow upward syncs (recovery from under-counting drift)
    ///         but bound the proposed value by the on-chain PoolManager credit balance,
    ///         which is tamper-proof. The hook's claimable balance in the PoolManager is
    ///         tracked via ERC6909Claims; reading balanceOf(address(this), Currency.toId)
    ///         gives the maximum the hook is allowed to claim. accruedFees is internal
    ///         accounting and may legitimately drift below the on-chain balance over
    ///         millions of swaps — this lets the owner correct it without trusting their
    ///         input alone. The error name is also clarified — the legacy
    ///         "SyncReductionTooLarge" was misleading (it actually fired on increases,
    ///         which are now allowed if bounded by on-chain truth).
    /// @dev AUDIT FIX D-AMM-M3: gate execute on `whenNotPaused`. Pause is a circuit
    ///      breaker; sync executes during a halt are unsafe.
    /// @dev AUDIT FIX D-AMM-M4: read the upward-sync cap from the propose-time
    ///      snapshot, not a live `poolManager.balanceOf` read.
    function executeSyncAccruedFees(address currency) external onlyOwner whenNotPaused {
        bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        _execute(key);
        require(block.timestamp >= lastSyncExecuted[currency] + SYNC_COOLDOWN, "SYNC_COOLDOWN");
        uint256 actualCredit = pendingSyncCredit[currency];
        uint256 old = accruedFees[currency];

        // H-5: upward syncs are allowed but capped by the propose-time snapshot
        // of the PoolManager credit balance (race-free per D-AMM-M4).
        if (actualCredit > old) {
            uint256 onChainCreditSnapshot = pendingSyncCreditSnapshot[currency];
            if (actualCredit > onChainCreditSnapshot) revert AboveOnChainCredit();
            // AUDIT R014 (MEDIUM, upward-sync ceiling): bound the per-step
            // increase to MAX_SYNC_INCREASE_BPS of the prior value. Bootstrap
            // case (old == 0): the snapshotted on-chain-credit cap above is the
            // only bound, since 10% of 0 would lock the contract permanently.
            if (old > 0) {
                uint256 increase = actualCredit - old;
                uint256 maxIncrease = (old * MAX_SYNC_INCREASE_BPS) / 10000;
                if (increase > maxIncrease) revert SyncIncreaseTooLarge();
            }
        }

        accruedFees[currency] = actualCredit;
        pendingSyncCredit[currency] = 0;
        // AUDIT FIX D-AMM-M4: clear snapshot for fresh capture on next propose.
        pendingSyncCreditSnapshot[currency] = 0;
        lastSyncExecuted[currency] = block.timestamp;
        emit SyncExecuted(currency, old, accruedFees[currency]);
    }

    /// @notice Cancel a pending sync proposal.
    /// @dev AUDIT FIX D-AMM-M4: clear `pendingSyncCreditSnapshot` so the next
    ///      propose freshly captures the on-chain credit balance.
    function cancelSyncAccruedFees(address currency) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        _cancel(key);
        pendingSyncCredit[currency] = 0;
        pendingSyncCreditSnapshot[currency] = 0;
        emit SyncCancelled(currency);
    }

    /// @notice AUDIT FIX V3-AMM-M2: permissionless cleanup of an expired sync
    ///         proposal. The pre-fix V2-AMM-M1 design correctly UNGATED claimFees
    ///         when a proposal expired, but the `_executeAfter[key]`,
    ///         `pendingSyncCredit`, and `pendingSyncCreditSnapshot` slots stay
    ///         set forever — meaning the owner can't re-propose without first
    ///         calling `cancelSyncAccruedFees`, AND any onlooker watching
    ///         `pendingSyncCredit` sees stale data forever. This function lets
    ///         anyone clean up the expired state once the proposal validity
    ///         window has lapsed.
    /// @param  currency The currency to expire.
    function expireSyncAccruedFees(address currency) external {
        bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        uint256 readyAt = _proposalReadyAt(key);
        require(readyAt != 0, "NO_PENDING_SYNC");
        require(block.timestamp > readyAt + _proposalValidity(), "NOT_EXPIRED");
        // Clear timelock slot + pending values + snapshot.
        _cancel(key);
        pendingSyncCredit[currency] = 0;
        pendingSyncCreditSnapshot[currency] = 0;
        emit SyncCancelled(currency);
    }

    /// @notice Legacy view helper for test compatibility
    function syncTime(address currency) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
        return _executeAfter[key];
    }

    // ─── Admin (Timelocked) ─────────────────────────────────────────

    /// @notice SECURITY FIX: setFee now reverts — use proposeFeeChange() + executeFeeChange()
    function setFee(uint256) external pure {
        revert("Use proposeFeeChange() + executeFeeChange()");
    }

    /// @notice Propose a fee change. Takes effect after FEE_CHANGE_DELAY.
    function proposeFeeChange(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        pendingFee = _newFeeBps;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(feeBps, _newFeeBps, _executeAfter[FEE_CHANGE]);
    }

    /// @notice Execute a previously proposed fee change after the timelock expires.
    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = feeBps;
        feeBps = pendingFee;
        pendingFee = 0; // L-02: Reset pending state after execution
        emit FeeUpdated(old, feeBps);
    }

    /// @notice SECURITY FIX: setRevenueDistributor now reverts — use proposeDistributorChange() + executeDistributorChange()
    function setRevenueDistributor(address) external pure {
        revert("Use proposeDistributorChange() + executeDistributorChange()");
    }

    /// @notice Propose a revenue distributor change. Takes effect after DISTRIBUTOR_CHANGE_DELAY.
    function proposeDistributorChange(address _newDistributor) external onlyOwner {
        if (_newDistributor == address(0)) revert ZeroAddress();
        pendingDistributor = _newDistributor;
        _propose(DISTRIBUTOR_CHANGE, DISTRIBUTOR_CHANGE_DELAY);
        emit DistributorChangeProposed(revenueDistributor, _newDistributor, _executeAfter[DISTRIBUTOR_CHANGE]);
    }

    /// @notice Execute a previously proposed distributor change after the timelock expires.
    function executeDistributorChange() external onlyOwner {
        _execute(DISTRIBUTOR_CHANGE);
        address old = revenueDistributor;
        revenueDistributor = pendingDistributor;
        pendingDistributor = address(0); // L-02: Reset pending state after execution
        emit DistributorUpdated(old, revenueDistributor);
    }

    event FeeChangeCancelled(uint256 cancelledFee);
    event DistributorChangeCancelled(address cancelledDistributor);
    event SyncProposed(address indexed currency, uint256 actualCredit, uint256 executeAfter);
    event SyncExecuted(address indexed currency, uint256 oldAccrued, uint256 newAccrued);
    event SyncCancelled(address indexed currency);

    /// @notice AUDIT FIX: Cancel a pending fee change proposal
    /// @dev AUDIT FIX v2: Emit cancellation events for off-chain monitoring
    function cancelFeeChange() external onlyOwner {
        uint256 cancelled = pendingFee;
        _cancel(FEE_CHANGE);
        pendingFee = 0;
        emit FeeChangeCancelled(cancelled);
    }

    /// @notice AUDIT FIX: Cancel a pending distributor change proposal
    /// @dev AUDIT FIX v2: Emit cancellation events for off-chain monitoring
    function cancelDistributorChange() external onlyOwner {
        address cancelled = pendingDistributor;
        _cancel(DISTRIBUTOR_CHANGE);
        pendingDistributor = address(0);
        emit DistributorChangeCancelled(cancelled);
    }

    /// @notice Legacy view helpers for test compatibility
    function feeChangeTime() external view returns (uint256) {
        return _executeAfter[FEE_CHANGE];
    }

    function distributorChangeTime() external view returns (uint256) {
        return _executeAfter[DISTRIBUTOR_CHANGE];
    }

    // ─── ETH Recovery ───────────────────────────────────────────────

    /// @notice M-32: Recover accidentally sent ETH. Recipient is constrained to
    ///         `revenueDistributor` or `owner()` so a compromised owner cannot
    ///         instantly drain the ETH balance to an arbitrary attacker address.
    /// @dev    AUDIT FIX D-AMM-L4: accept an owner-specified recipient parameter so
    ///         that if `revenueDistributor` becomes a reverting contract,
    ///         `sweepETH` is not permanently bricked waiting for the 48h
    ///         distributor-rotation timelock. Owner gating prevents misuse.
    /// @dev    AUDIT FIX V2-AMM-M3: restore M-32's protection — the prior
    ///         D-AMM-L4 fix overcorrected by accepting any owner-specified `to`
    ///         address, which erased the original "instant-drain prevention"
    ///         design.
    /// @dev    AUDIT FIX V3-AMM-H1: REMOVE `owner()` from the allowlist. `owner()`
    ///         IS the compromised principal in M-32's threat model — adding
    ///         it to the allowlist defeated the very protection M-32 was meant
    ///         to provide. A captured owner key can sweep directly to themselves
    ///         (the attacker's address-of-control), bypassing the 48h
    ///         `proposeDistributorChange` timelock entirely. The fix narrows
    ///         the allowlist to ONLY `revenueDistributor`. If the distributor
    ///         is broken/reverting, the owner must first
    ///         `proposeDistributorChange` (48h timelock) to a recoverable
    ///         destination, then sweep — which is exactly the M-32 design
    ///         intent.
    /// @param  to Recipient of the swept ETH. Must be `revenueDistributor`;
    ///            reverts `InvalidSweepRecipient` otherwise.
    function sweepETH(address to) external onlyOwner {
        // AUDIT FIX V3-AMM-H1: only `revenueDistributor` is a valid sweep
        // target. Owner-as-sink defeats the M-32 threat model.
        if (to != revenueDistributor) revert InvalidSweepRecipient();
        uint256 balance = address(this).balance;
        require(balance > 0, "NO_ETH"); // L-10: Prevent zero-value transfer
        (bool success,) = payable(to).call{value: balance}("");
        if (!success) revert SweepFailed();
        emit ETHSwept(to, balance);
    }

    // Accept ETH
    receive() external payable {}
}
