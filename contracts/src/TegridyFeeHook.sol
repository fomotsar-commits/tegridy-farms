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

        // C-04: Fee denomination depends on swap type.
        // For exact-input swaps (amountSpecified < 0), fee is on the OUTPUT token delta (negative delta).
        // For exact-output swaps (amountSpecified > 0), fee is on the INPUT token delta (positive delta).

        int128 feeAmount = 0;

        if (params.amountSpecified < 0) {
            // Exact-input swap: fee on the output (negative delta = user received)
            if (amount0 < 0) {
                uint256 absAmount = uint256(int256(-amount0));
                uint256 feeUint = (absAmount * feeBps) / 10000;
                require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");
                feeAmount = int128(uint128(feeUint));
            } else if (amount1 < 0) {
                uint256 absAmount = uint256(int256(-amount1));
                uint256 feeUint = (absAmount * feeBps) / 10000;
                require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");
                feeAmount = int128(uint128(feeUint));
            }
        } else {
            // Exact-output swap (amountSpecified > 0): fee on the input (positive delta = user paid)
            if (amount0 > 0) {
                uint256 absAmount = uint256(int256(amount0));
                uint256 feeUint = (absAmount * feeBps) / 10000;
                require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");
                feeAmount = int128(uint128(feeUint));
            } else if (amount1 > 0) {
                uint256 absAmount = uint256(int256(amount1));
                uint256 feeUint = (absAmount * feeBps) / 10000;
                require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");
                feeAmount = int128(uint128(feeUint));
            }
        }

        // Enforce minimum fee of 1 unit when feeBps > 0 (relevant amount > 1 to avoid dust)
        if (feeAmount == 0 && feeBps > 0) {
            uint256 absRelevant;
            if (params.amountSpecified < 0) {
                // Exact-input: minimum fee on output
                absRelevant = amount0 < 0 ? uint256(int256(-amount0)) : (amount1 < 0 ? uint256(int256(-amount1)) : 0);
            } else {
                // Exact-output: minimum fee on input
                absRelevant = amount0 > 0 ? uint256(int256(amount0)) : (amount1 > 0 ? uint256(int256(amount1)) : 0);
            }
            if (absRelevant > 1) {
                feeAmount = 1;
            }
        }

        // AUDIT FIX: Track accrued fees against the UNSPECIFIED currency — this is the
        // currency the V4 PoolManager will credit to the hook via hookDeltaUnspecified.
        // For exact-input (amountSpecified < 0): unspecified = output token
        // For exact-output (amountSpecified > 0): unspecified = input token
        // The mapping: (amountSpecified < 0 == zeroForOne) ? currency1 is unspecified : currency0 is unspecified
        if (feeAmount > 0) {
            bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
            Currency creditCurrency = specifiedIsZero ? key.currency1 : key.currency0;
            address creditToken = Currency.unwrap(creditCurrency);
            accruedFees[creditToken] += uint256(int256(feeAmount));
            emit FeeCollected(creditToken, uint256(int256(feeAmount)));
        }

        // The fee is returned as the hook's delta — it reduces what the user receives
        // The PoolManager will hold this fee, and we can claim it later
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
        // NOTE: If poolManager.take reverts (insufficient credits), the entire tx reverts,
        // restoring accruedFees. This prevents accounting drift from causing fund loss.
        poolManager.take(Currency.wrap(currency), revenueDistributor, amount);
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
