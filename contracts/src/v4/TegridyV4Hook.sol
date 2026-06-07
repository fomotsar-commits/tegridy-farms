// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// External imports (Uniswap V4 core)
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
// Battle-tested verbatim bases / utils (OpenZeppelin/uniswap-hooks v1.1.1, pinned)
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/src/general/LiquidityPenaltyHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {PauseGuardian} from "../base/PauseGuardian.sol";

/// @dev Minimal interface to PremiumAccess (Gold Card). Deferred contract — read
///      by address (settable), never imported, so this stays MVP-branch-clean.
interface IPremiumAccess {
    function hasPremium(address user) external view returns (bool);
}

/// @title  TegridyV4Hook — bundled Uniswap V4 hook for the TOWELI pool
/// @notice Modules (all on ONE pool — see V4_MIGRATION_PLAN.md "Architecture correction"):
///           • JIT          — OZ `LiquidityPenaltyHook` (VERBATIM, inherited)
///           • FeeModule    — verbatim `BaseOverrideFee` copy + admin-bounded fee
///                            + OPTIONAL premium discount (Gold Card "Reduced Fees")
///           • Allowlist    — pool-key allowlist in `_beforeInitialize` (Cork defense)
///           • POL + split  — `_afterSwap` skim (ERC-6909 claims) then redeem & route
///                            to stakers (RevenueDistributor) / treasury / POL
///           • Pause        — PauseGuardian emergency stop (swaps halt, exit open)
///
/// @dev    PREMIUM DISCOUNT (V4 caveat): a hook's `_beforeSwap` `sender` is the
///         ROUTER, not the end user, so a per-user discount needs the user from
///         `hookData`. To stop anyone spoofing a premium holder's address through a
///         raw UniversalRouter, the discount applies ONLY when `sender ==
///         trustedRouter` (a Tegridy router that authenticates the user before
///         forwarding it). Disabled by default (trustedRouter / premiumAccess == 0).
///         A try/catch isolates a misbehaving PremiumAccess so swaps never brick.
///
/// @dev    FEE SPLIT: defaults to 100% POL (staker/treasury shares 0) = prior
///         behavior. paramAdmin can shift shares; `distributeFees` redeems the
///         hook's claims and routes REAL currency (native ETH for the staker sink,
///         which is RevenueDistributor) in a single unlock.
///
/// @dev    NOT YET DEPLOYABLE (HookMiner deploy + audit pending). AntiSandwich /
///         LimitOrder / TWAMM-DCA cannot share this pool (they drive `_beforeSwap`)
///         — separate pools. Boosted-LP incentive accrual = separate design doc.
contract TegridyV4Hook is LiquidityPenaltyHook, IUnlockCallback, PauseGuardian {
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @dev Basis-points denominator.
    uint16 private constant BPS = 10_000;
    /// @dev Hard cap on the premium discount (50% of the fee). Immutable policy.
    uint16 private constant MAX_DISCOUNT_BPS = 5_000;

    // ─── Errors ───────────────────────────────────────────────────────
    error NotDynamicFee();
    error PoolNotAllowed();
    error NotParamAdmin();
    error FeeOutOfBounds();
    error InvalidFeeBounds();
    error SkimOutOfBounds();
    error ZeroAddress();
    error NotAContract();
    error NotPoolManagerUnlock();
    error TradingPaused();
    error DiscountTooHigh();
    error InvalidSplit();

    // ─── Events ───────────────────────────────────────────────────────
    event PoolAllowed(PoolId indexed id, bool allowed);
    event BaseFeeSet(uint24 oldFeePips, uint24 newFeePips);
    event PolSkimSet(uint16 oldBps, uint16 newBps);
    event PolRecipientSet(address indexed recipient);
    event PolAccrued(Currency indexed currency, uint256 amount);
    event PolSwept(Currency indexed currency, address indexed to, uint256 amount);
    event FeesDistributed(Currency indexed currency, uint256 stakerAmt, uint256 treasuryAmt, uint256 polAmt);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event DiscountConfigSet(address premiumAccess, address trustedRouter, uint16 discountBps);
    event FeeSplitSet(uint16 stakerShareBps, uint16 treasuryShareBps);
    event FeeSinksSet(address stakerSink, address treasury);

    // ─── Params (mutated only by paramAdmin; hook code itself is immutable) ──
    address public immutable paramAdmin;

    /// @notice Immutable fee bounds (hundredths of a bip). Even a compromised
    ///         paramAdmin cannot push the fee outside these.
    uint24 public immutable minFeePips;
    uint24 public immutable maxFeePips;
    /// @notice Immutable POL skim ceiling (bps of swap output). Hard upper bound.
    uint16 public immutable maxPolSkimBps;

    uint24 public baseFeePips;
    uint16 public polSkimBps;
    address public polRecipient;

    /// @notice Premium discount config (#2). Disabled while any is zero.
    address public premiumAccess;
    address public trustedRouter;
    uint16 public discountBps;

    /// @notice Fee split (#1). polShare = BPS - staker - treasury (implicit).
    uint16 public stakerShareBps;
    uint16 public treasuryShareBps;
    address public stakerSink; // RevenueDistributor (native ETH); 0 => folds to POL
    address public treasury; // 0 => folds to POL

    mapping(PoolId => bool) public allowedPools;

    /// @notice Emergency stop. `_beforeSwap` reverts; liquidity removal stays open.
    bool public paused;

    modifier onlyParamAdmin() {
        if (msg.sender != paramAdmin) revert NotParamAdmin();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        uint48 blockNumberOffset_,
        address paramAdmin_,
        uint24 minFeePips_,
        uint24 maxFeePips_,
        uint24 baseFeePips_,
        uint16 maxPolSkimBps_,
        uint16 polSkimBps_,
        address polRecipient_
    ) LiquidityPenaltyHook(poolManager_, blockNumberOffset_) {
        if (paramAdmin_ == address(0) || polRecipient_ == address(0)) revert ZeroAddress();
        if (minFeePips_ > maxFeePips_ || maxFeePips_ > LPFeeLibrary.MAX_LP_FEE) revert InvalidFeeBounds();
        if (baseFeePips_ < minFeePips_ || baseFeePips_ > maxFeePips_) revert FeeOutOfBounds();
        if (maxPolSkimBps_ > BPS || polSkimBps_ > maxPolSkimBps_) revert SkimOutOfBounds();
        paramAdmin = paramAdmin_;
        minFeePips = minFeePips_;
        maxFeePips = maxFeePips_;
        baseFeePips = baseFeePips_;
        maxPolSkimBps = maxPolSkimBps_;
        polSkimBps = polSkimBps_;
        polRecipient = polRecipient_;
    }

    // ─── Allowlist (Cork defense) ─────────────────────────────────────

    function setPoolAllowed(PoolKey calldata key, bool allowed) external onlyParamAdmin {
        PoolId id = key.toId();
        allowedPools[id] = allowed;
        emit PoolAllowed(id, allowed);
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal virtual override returns (bytes4) {
        if (!allowedPools[key.toId()]) revert PoolNotAllowed();
        return this.beforeInitialize.selector;
    }

    // ─── FeeModule (verbatim BaseOverrideFee + optional premium discount) ──

    function setBaseFee(uint24 newFeePips) external onlyParamAdmin {
        if (newFeePips < minFeePips || newFeePips > maxFeePips) revert FeeOutOfBounds();
        emit BaseFeeSet(baseFeePips, newFeePips);
        baseFeePips = newFeePips;
    }

    /// @notice Configure the premium (Gold Card) swap-fee discount. Pass any zero
    ///         to disable. `discountBps_` is a fraction of the fee, capped at 50%.
    function setDiscountConfig(address premiumAccess_, address trustedRouter_, uint16 discountBps_)
        external
        onlyParamAdmin
    {
        if (discountBps_ > MAX_DISCOUNT_BPS) revert DiscountTooHigh();
        // AUDIT FIX (2026-06-07): `premiumAccess` is *called* (`hasPremium`) inside
        // `_discountedFee`. Reject an EOA / EIP-7702-delegated EOA (code.length 0
        // or 23) so a captured paramAdmin can't point it at an attacker-controlled
        // responder that returns `true` to grant the (≤50%) fee discount. Mirrors
        // SwapFeeRouter.applyPremiumAccess; address(0) stays the explicit disable
        // path. trustedRouter is only ever compared (never called), so it needs no
        // such check.
        if (premiumAccess_ != address(0)) {
            uint256 codeLen = premiumAccess_.code.length;
            if (codeLen == 0 || codeLen == 23) revert NotAContract();
        }
        premiumAccess = premiumAccess_;
        trustedRouter = trustedRouter_;
        discountBps = discountBps_;
        emit DiscountConfigSet(premiumAccess_, trustedRouter_, discountBps_);
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal virtual override returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();
        return this.afterInitialize.selector;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        virtual
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (paused) revert TradingPaused(); // emergency stop halts swaps; liquidity exit stays open
        uint24 fee = _getFee(sender, key, params, hookData);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Base fee, minus the premium discount when the swap is forwarded by the
    ///      trusted router carrying a premium holder's address in `hookData`.
    ///      Floored at `minFeePips`. try/catch isolates PremiumAccess failures.
    function _getFee(address sender, PoolKey calldata, SwapParams calldata, bytes calldata hookData)
        internal
        virtual
        returns (uint24)
    {
        return _discountedFee(sender, hookData);
    }

    /// @dev Base fee minus the premium discount, but ONLY when the swap is
    ///      forwarded by `trustedRouter` carrying a premium holder's address in
    ///      `hookData`. Floored at `minFeePips`. try/catch isolates PremiumAccess.
    function _discountedFee(address sender, bytes calldata hookData) internal view returns (uint24) {
        uint24 fee = baseFeePips;
        address pa = premiumAccess;
        address tr = trustedRouter;
        uint16 disc = discountBps;
        if (disc != 0 && pa != address(0) && tr != address(0) && sender == tr && hookData.length >= 32) {
            address user = abi.decode(hookData, (address));
            try IPremiumAccess(pa).hasPremium(user) returns (bool ok) {
                if (ok) {
                    uint256 reduced = uint256(fee) - (uint256(fee) * disc) / BPS;
                    fee = reduced < minFeePips ? minFeePips : uint24(reduced);
                }
            } catch {}
        }
        return fee;
    }

    /// @notice Quote the effective fee for `(sender, hookData)` — exposes the
    ///         discount path for off-chain quoting and tests.
    function quoteFee(address sender, bytes calldata hookData) external view returns (uint24) {
        return _discountedFee(sender, hookData);
    }

    // ─── POL skim (afterSwap) ─────────────────────────────────────────

    function setPolSkimBps(uint16 newBps) external onlyParamAdmin {
        if (newBps > maxPolSkimBps) revert SkimOutOfBounds();
        emit PolSkimSet(polSkimBps, newBps);
        polSkimBps = newBps;
    }

    function setPolRecipient(address newRecipient) external onlyParamAdmin {
        if (newRecipient == address(0)) revert ZeroAddress();
        polRecipient = newRecipient;
        emit PolRecipientSet(newRecipient);
    }

    /// @notice Set the fee split (#1). staker + treasury <= BPS; POL gets the rest.
    function setFeeSplit(uint16 stakerShareBps_, uint16 treasuryShareBps_) external onlyParamAdmin {
        if (uint256(stakerShareBps_) + treasuryShareBps_ > BPS) revert InvalidSplit();
        stakerShareBps = stakerShareBps_;
        treasuryShareBps = treasuryShareBps_;
        emit FeeSplitSet(stakerShareBps_, treasuryShareBps_);
    }

    /// @notice Set the staker (RevenueDistributor) + treasury sinks. Either zero
    ///         folds that share back into POL (`polRecipient`).
    function setFeeSinks(address stakerSink_, address treasury_) external onlyParamAdmin {
        stakerSink = stakerSink_;
        treasury = treasury_;
        emit FeeSinksSet(stakerSink_, treasury_);
    }


    // ─── Emergency pause (PauseGuardian mixin) ─────────────────────────

    function guardianPause() external onlyPauseGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    function setPaused(bool p) external onlyParamAdmin {
        paused = p;
        if (p) emit Paused(msg.sender);
        else emit Unpaused(msg.sender);
    }

    function setPauseGuardian(address newGuardian) external onlyParamAdmin {
        _setPauseGuardian(newGuardian);
    }

    /// @dev Skim `polSkimBps` of the swap's unspecified currency as a protocol fee,
    ///      accrued as ERC-6909 claims. Mechanics copied verbatim from OZ
    ///      `BaseDynamicAfterFee._afterSwap`.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        virtual
        override
        returns (bytes4, int128)
    {
        uint16 bps = polSkimBps;
        if (bps == 0) return (this.afterSwap.selector, 0);

        (Currency unspecified, int128 unspecifiedAmount) = (params.amountSpecified < 0 == params.zeroForOne)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());
        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;

        uint256 feeAmount = (uint256(uint128(unspecifiedAmount)) * bps) / BPS;
        if (feeAmount == 0) return (this.afterSwap.selector, 0);

        unspecified.take(poolManager, address(this), feeAmount, true);
        emit PolAccrued(unspecified, feeAmount);
        return (this.afterSwap.selector, feeAmount.toInt256().toInt128());
    }

    /// @notice Emergency rescue: sweep accrued claims of `currency` to `polRecipient`
    ///         (ERC-6909 claims, no redeem — call-free, so it cannot be bricked by an
    ///         ETH-rejecting sink). Routes the FULL balance to `polRecipient`, IGNORING
    ///         the staker/treasury split, so it is `onlyParamAdmin` (governance), NOT
    ///         permissionless. AUDIT FIX 2026-05-31 [LOW-4]: pre-fix this was
    ///         permissionless — once a non-100%-POL split is configured, anyone could
    ///         front-run `distributeFees` with `sweepPOL` to divert the staker/treasury
    ///         shares to POL (griefing). Normal fee routing uses the permissionless
    ///         `distributeFees`, which honours the split.
    function sweepPOL(Currency currency) external onlyParamAdmin {
        uint256 id = currency.toId();
        uint256 bal = poolManager.balanceOf(address(this), id);
        if (bal == 0) return;
        // AUDIT 2026-05-31 [slither unused-return FP]: Uniswap V4 PoolManager.transfer reverts
        // on failure (it does not return a falsifiable success bool to act on); the ERC-6909
        // claim transfer either moves the balance or reverts the whole call.
        // slither-disable-next-line unused-return
        poolManager.transfer(polRecipient, id, bal);
        emit PolSwept(currency, polRecipient, bal);
    }

    /// @notice Redeem accrued claims of `currency` into the REAL underlying and route
    ///         by the fee split: staker share → stakerSink (RevenueDistributor; native
    ///         ETH works via its receive()), treasury share → treasury, rest → POL.
    ///         Permissionless (destinations are admin-set). Re-entrancy impossible:
    ///         opens a PoolManager lock; a nested unlock reverts while locked.
    function distributeFees(Currency currency) public {
        uint256 bal = poolManager.balanceOf(address(this), currency.toId());
        if (bal == 0) return;
        uint256 stakerAmt = (bal * stakerShareBps) / BPS;
        uint256 treasuryAmt = (bal * treasuryShareBps) / BPS;
        uint256 polAmt = bal - stakerAmt - treasuryAmt;
        address sTo = stakerSink == address(0) ? polRecipient : stakerSink;
        address tTo = treasury == address(0) ? polRecipient : treasury;
        // AUDIT 2026-05-31 [slither unused-return FP]: PoolManager.unlock returns the
        // unlockCallback's encoded return data, which this flow has no use for — the side
        // effects (settle/take to staker/treasury/POL) happen inside the callback.
        // slither-disable-next-line unused-return
        poolManager.unlock(abi.encode(currency, stakerAmt, sTo, treasuryAmt, tTo, polAmt, polRecipient));
    }

    /// @notice Back-compat alias — redeem the full balance under the current split.
    function redeemPOL(Currency currency) external {
        distributeFees(currency);
    }

    /// @dev Unlock callback: burn the hook's claims and take REAL currency to the
    ///      three sinks. onlyPoolManager.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManagerUnlock();
        (Currency currency, uint256 sAmt, address sTo, uint256 tAmt, address tTo, uint256 pAmt, address pTo) =
            abi.decode(data, (Currency, uint256, address, uint256, address, uint256, address));
        poolManager.burn(address(this), currency.toId(), sAmt + tAmt + pAmt);
        if (sAmt > 0) poolManager.take(currency, sTo, sAmt);
        if (tAmt > 0) poolManager.take(currency, tTo, tAmt);
        if (pAmt > 0) poolManager.take(currency, pTo, pAmt);
        emit FeesDistributed(currency, sAmt, tAmt, pAmt);
        return "";
    }

    // Boosted-LP rewards are handled OUT of band by TegridyBoostedLPStaker (the
    // NFT-staker, the canonical #3 path). The hook deliberately does NOT call any
    // reward module from its liquidity callbacks — this removes the double-count
    // foot-gun (M-3) and the module-revert DoS surface (H-1) entirely. The hook
    // inherits LiquidityPenaltyHook's afterAdd/afterRemove (JIT) unchanged.

    // ─── Permissions ──────────────────────────────────────────────────

    function getHookPermissions() public pure virtual override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true; // pool-key allowlist (Cork defense)
        permissions.afterInitialize = true; // fee override: dynamic-fee assertion
        permissions.beforeSwap = true; // fee override + discount
        permissions.afterSwap = true; // POL skim
        permissions.afterSwapReturnDelta = true; // POL skim takes a delta
        permissions.afterAddLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterAddLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
    }
}
