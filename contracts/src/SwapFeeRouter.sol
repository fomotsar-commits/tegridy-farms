// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

interface IUniswapV2Router02 {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external payable returns (uint256[] memory amounts);
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    // AUDIT M-6: Fee-on-transfer variants. Mirrors Uniswap V2 Router02 signatures exactly.
    // These return no amounts array — the canonical Uniswap impl relies on balance deltas
    // measured by the caller. We do the same in the wrapper below.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function WETH() external pure returns (address);
    /// @dev AUDIT SFR-H-01: read at construction so we can resolve the token/WETH pair
    ///      and derive a TWAP-based minETHOut floor for `convertTokenFeesToETH{,FoT}`.
    function factory() external view returns (address);
}

/// @dev AUDIT SFR-H-01: minimal Uniswap V2 factory surface — just `getPair`.
///      Lets us look up the token/WETH pair address at conversion time without
///      requiring the caller to supply it (and risk being lied to).
///      Suffix `_SFR` to avoid name clashes with other UniV2 factory interfaces in the repo.
interface ISwapFeeRouterUniFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

/// @dev AUDIT SFR-H-01: minimal Uniswap V2 pair surface — token0/token1, reserves,
///      and the cumulative-price accumulators used to derive a TWAP. Identical
///      shape to Uniswap V2 mainnet pairs and TegridyPair, so the same code reads
///      both. Suffix `_SFR` to avoid name clashes with other UniV2 pair interfaces.
interface ISwapFeeRouterUniPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

interface IReferralSplitter {
    function recordFee(address _user) external payable;
    function withdrawCallerCredit() external;
}

interface IPremiumAccess {
    function hasPremiumSecure(address user) external view returns (bool);
}

/// @title SwapFeeRouter
/// @notice Wraps Uniswap V2 swaps with a protocol fee.
///         Users swap through this contract instead of directly on Uniswap.
///         A small fee (default 0.3%) is taken from the input before swapping.
///
///         Revenue: fees accumulate in this contract and can be withdrawn by owner.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
///  - Fee wrapper pattern: 1inch/Paraswap aggregator fee model
///  - Timelocked admin (propose/execute/cancel) lives on SwapFeeRouterAdmin sister
///    contract using the MakerDAO DSPause pattern.
contract SwapFeeRouter is OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Admin sister contract ───────────────────────────────────────
    // NOTE (size-reduction sprint 2026-04-26): timelock keys, propose/execute/cancel
    // flow, pending state, and the `*ChangeTime` view helpers all live on the sister
    // `SwapFeeRouterAdmin` contract. SwapFeeRouter exposes `applyXxx` setters guarded
    // by `onlyAdmin` for the admin contract to call.
    address public swapFeeRouterAdmin;

    // ─── Immutables ──────────────────────────────────────────────────
    IUniswapV2Router02 public immutable router;
    address public immutable WETH;
    /// @notice AUDIT SFR-H-01: Uniswap V2 factory cached at construction so the
    ///         contract can resolve the token/WETH pair address inside
    ///         `convertTokenFeesToETH{,FoT}` and read its cumulative-price
    ///         accumulators for an internal TWAP-derived minETHOut floor.
    ///         Caller-supplied minETHOut can only TIGHTEN the floor.
    ISwapFeeRouterUniFactory public immutable uniFactory;

    // ─── State ───────────────────────────────────────────────────────
    IReferralSplitter public referralSplitter;
    address public treasury;
    uint256 public feeBps; // Fee in basis points (30 = 0.3%)

    uint256 public constant MAX_FEE_BPS = 100; // Max 1%
    uint256 public constant BPS = 10000;
    // Per-key timelock delays now live on SwapFeeRouterAdmin.
    // AUDIT L-1: raised from 30 minutes to 2 hours. 30m bricks swaps during normal
    // Ethereum congestion (post-merge average 12s blocks, but fees can spike base-fee
    // beyond the user's maxPriorityFee for far longer than 30m on busy days).
    // 2h is a standard Uniswap UI default and still defends against very stale intents.
    uint256 public constant MAX_DEADLINE = 2 hours;
    uint256 public constant MAX_PREMIUM_DISCOUNT_BPS = 7500; // Max 75% discount

    uint256 public totalETHFees;
    mapping(address => uint256) public totalTokenFees;
    mapping(address => uint256) public accumulatedTokenFees;
    uint256 public accumulatedETHFees;

    /// @notice AUDIT NEW-A5 (HIGH): per-token timestamp of the last successful
    ///         convertTokenFeesToETH{,FoT} call. Sandwich-MEV amplification required
    ///         repeated rapid-fire conversions to compound profit against a small
    ///         accumulated balance. With CONVERSION_COOLDOWN between calls per token,
    ///         an attacker pays the cooldown-window delay per attempt — economically
    ///         unfavourable.
    mapping(address => uint256) public lastConvertedAt;
    uint256 public constant CONVERSION_COOLDOWN = 1 hours;

    /// @notice AUDIT SFR-H-01 (HIGH): per-token snapshot of the Uniswap V2 cumulative
    ///         price (token → WETH direction) captured at the most recent successful
    ///         conversion. The next conversion derives a TWAP from `(curCum - prev.cum) / dt`
    ///         and uses it as an internal minETHOut floor — caller-supplied minETHOut
    ///         can only tighten the floor, never relax it. This closes the sandwich-MEV
    ///         gap where the 1h cooldown alone could not prevent a single MEV bundle
    ///         from manipulating the pool right before the keeper's conversion landed.
    /// @dev    `cumulative` is the integral of the spot price (UQ112x112 fixed-point) over
    ///         seconds since pair creation, with intentional uint256 wrapping. We store the
    ///         pair-NATIVE cumulative *plus* a spot×elapsed bridge term (Uniswap V2
    ///         OracleLibrary `currentCumulativePrices` pattern) so the TWAP correctly
    ///         integrates over the idle window since the pair's last swap/mint/burn.
    /// @dev    `timestamp == 0` flags an unset snapshot (first conversion). The first
    ///         conversion is restricted to the contract owner so the contract can establish
    ///         a baseline without relying on a permissionless caller picking minETHOut.
    struct PriceSnapshot {
        uint32 timestamp;
        uint256 cumulative;
    }
    mapping(address => PriceSnapshot) public lastConversionSnapshot;

    /// @notice AUDIT SFR-H-01: minimum elapsed time between snapshots before a TWAP
    ///         is trusted as a slippage floor. 30 minutes matches the Olympus / Tokemak
    ///         treasury-ops / POLAccumulator (R015) convention — long enough to dilute
    ///         single-block reserve manipulation, short enough that the 1h cooldown
    ///         comfortably guarantees we always have ≥30 min of integral on the second
    ///         and subsequent calls.
    uint256 public constant MIN_TWAP_PERIOD = 30 minutes;

    /// @notice AUDIT SFR-M-01 (MEDIUM, 2026-04-28): hard cap on caller-supplied
    ///         conversion paths. 4 hops covers the realistic universe (token → MID0 →
    ///         MID1 → WETH on the rare deeply-routed token) while bounding the gas
    ///         + sandwich surface. Above 4 hops, multi-hop slippage compounds badly
    ///         and the owner-only gate becomes a usability footgun anyway.
    uint256 public constant MAX_CONVERSION_PATH_LENGTH = 4;
    /// @notice AUDIT SFR-H-01: 1.5% safety margin applied to the TWAP-derived minETHOut.
    ///         Tighter than the legacy MEV bleed (1-3% per cycle on accumulated balance)
    ///         while still tolerating realistic price moves over the 30 min averaging
    ///         window on liquid pairs. The cap is governance-immutable for the same
    ///         reason POLAccumulator's `TWAP_SAFETY_BPS` is hardcoded — changing it
    ///         requires a contract upgrade, not a one-line owner setter.
    uint256 public constant TWAP_SAFETY_BPS = 150;
    /// @dev AUDIT SFR-H-01: UQ112x112 fixed-point scale factor, mirrored from Uniswap V2
    ///      / TegridyPair for the cumulative-price math.
    uint256 private constant Q112_SFR = 2 ** 112;

    // ─── Dynamic Fee Tiers (per-input-token overrides) ───────────────
    /// @notice AUDIT R-014 M-1: canonical storage keyed on the swap path's input
    ///         token (`path[0]`), NOT a pair address. Every `swapXxx` flow reads
    ///         `_getEffectiveFeeBps(path[0], …)`, so an override registered here
    ///         applies to every swap that begins with this token, across every
    ///         pair. Renamed from the legacy `pairFeeBps`/`hasPairFeeOverride`
    ///         to eliminate the misreading risk where admins assumed per-pair
    ///         scoping (the legacy name caused a global override for every
    ///         WETH-input swap when admins meant to scope to one pair).
    ///
    ///         The legacy public getters `pairFeeBps(address)` and
    ///         `hasPairFeeOverride(address)` below proxy to this storage so the
    ///         pre-existing public ABI continues to resolve.
    mapping(address => uint256) public inputTokenFeeBps;
    mapping(address => bool) public hasInputTokenFeeOverride;

    // ─── Premium Discount (Gold Card holders get reduced fees) ────────
    IPremiumAccess public premiumAccess;
    uint256 public premiumDiscountBps; // e.g. 5000 = 50% off fees

    // V2: Revenue pipeline — direct fee routing to RevenueDistributor
    address public revenueDistributor;

    // ─── V3: Three-way fee split (stakers / treasury / POL) ──────────
    /// @notice BPS of each distribution that flows to RevenueDistributor → stakers.
    ///         Remainder = (BPS - stakerShareBps - polShareBps) goes to treasury.
    ///         Initialised to 10000 (100% stakers) to preserve existing behaviour on
    ///         upgrade. Owner must propose a split change via timelock to start
    ///         funding treasury / POL.
    uint256 public stakerShareBps = 10_000;
    /// @notice BPS of each distribution that flows to polAccumulator for permanent
    ///         protocol-owned liquidity. Default 0. Combined with stakerShareBps
    ///         must total <= 10000.
    uint256 public polShareBps = 0;
    /// @notice Destination for the POL slice. Can be the POLAccumulator contract.
    address public polAccumulator;

    /// @notice Guardrails: stakers get no less than 50% and POL no more than 25%.
    ///         Protects the "stakers earn fees" marketing story through any future
    ///         governance mis-step. Enforced at propose-time on SwapFeeRouterAdmin
    ///         and re-enforced at apply-time below.
    uint256 public constant MIN_STAKER_SHARE_BPS = 5_000;
    uint256 public constant MAX_POL_SHARE_BPS = 2_500;

    /// @notice AUDIT C4: pull-pattern queue for distributeFeesToStakers legs that fail
    ///         the direct .call (recipient out of gas, paused, mid-upgrade, etc).
    ///         Without this queue, a failing staker or POL receiver would brick the
    ///         entire distribute() call via require(), trapping ETH in
    ///         accumulatedETHFees and blocking all subsequent distributions until the
    ///         destination recovered. With this queue, the slice is parked here and the
    ///         recipient (or anyone, on their behalf) can pull it later.
    mapping(address => uint256) public pendingDistribution;
    /// @notice AUDIT C4: aggregate of all pendingDistribution entries. sweepETH must
    ///         exclude this so the queued ETH cannot be swept to treasury.
    uint256 public totalPendingDistribution;

    // ─── Events ──────────────────────────────────────────────────────
    event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ReferralFeeRedirectedToTreasury(address indexed user, uint256 amount);
    event ReferralSplitterUpdated(address indexed oldSplitter, address indexed newSplitter);
    event CallerCreditRecovered(address indexed splitter, uint256 amount);
    /// @notice AUDIT R-014 M-1: canonical event for the per-input-token override
    ///         write. `inputToken` is the swap path's `path[0]`, NOT a pair address.
    ///         Indexers should subscribe to this event going forward; `PairFeeUpdated`
    ///         is emitted alongside for ABI compatibility but uses the legacy `pair`
    ///         field name.
    event InputTokenFeeApplied(address indexed inputToken, uint256 newFeeBps, bool removal);
    /// @dev DEPRECATED — emitted alongside `InputTokenFeeApplied` for ABI compatibility.
    ///      The `pair` field name is misleading; the value is the input-token address.
    event PairFeeUpdated(address indexed pair, uint256 feeBps, bool removed);
    /// @notice AUDIT R-014 M-1: emitted whenever the legacy `applyPairFee` alias is
    ///         invoked. Off-chain monitors should alert so callers (admin contracts,
    ///         scripts) can migrate to `applyInputTokenFee`.
    event ApplyPairFeeDeprecated();
    event PremiumDiscountUpdated(uint256 oldDiscount, uint256 newDiscount);
    event PremiumAccessUpdated(address indexed oldAccess, address indexed newAccess);
    event FeesDistributed(address indexed distributor, uint256 amount);
    event RevenueDistributorUpdated(address indexed oldDistributor, address indexed newDistributor);
    event FeeSplitUpdated(uint256 stakerShareBps, uint256 polShareBps, uint256 treasuryShareBps);
    event PolAccumulatorUpdated(address indexed oldAccumulator, address indexed newAccumulator);
    event FeesDistributedSplit(uint256 stakerAmount, uint256 treasuryAmount, uint256 polAmount);
    event SwapFeeRouterAdminSet(address indexed admin);
    /// @notice AUDIT C4: emitted when a staker or POL transfer fails the direct .call and
    ///         is parked in pendingDistribution for later pull. Off-chain monitors should
    ///         alert so the recipient (or owner) can drain via withdrawPendingDistribution.
    event DistributionDeferred(address indexed recipient, uint256 amount);
    event PendingDistributionWithdrawn(address indexed recipient, uint256 amount);
    /// @notice AUDIT C1: emitted when accumulated token fees are converted to ETH and folded
    ///         into accumulatedETHFees so they flow through the timelocked staker/POL/treasury
    ///         split. Without this conversion path, token-only swap fees (USDC↔TOWELI etc)
    ///         silently bypassed the staker share and went 100% to treasury via withdrawTokenFees.
    event TokenFeesConverted(address indexed token, uint256 tokenAmount, uint256 ethReceived);
    /// @notice AUDIT SFR-H-01: emitted whenever a conversion records a new TWAP snapshot
    ///         for `token`. `effectiveMinETHOut` is the on-chain floor derived from the
    ///         pair's cumulative-price accumulator (or the bootstrap call's caller-supplied
    ///         floor if no prior snapshot existed). Off-chain monitors can compare against
    ///         the actual ethReceived (in TokenFeesConverted) to alert on persistent
    ///         floor-vs-actual divergence.
    event ConversionTWAPFloor(
        address indexed token,
        uint256 effectiveMinETHOut,
        uint256 callerMinETHOut,
        bool bootstrap
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error FeeTooHigh();
    error ZeroAddress();
    error ZeroAmount();
    error SlippageExceeded();
    error InvalidPath();
    error InvalidRecipient();
    error DeadlineTooFar();
    error FeeExceedsMax();
    error AdjustedMinOverflow();
    error PathStartMismatch();
    error PathEndMismatch();
    error InsufficientOutput();
    error DuplicateTokenInPath();
    error SplitInvalid();
    error StakerShareTooLow();
    error PolShareTooHigh();
    error Unauthorized();
    /// @notice AUDIT SFR-H-01: caller's `minETHOut` is below the contract's TWAP-derived
    ///         floor. Bumping the slippage tolerance higher (i.e. tightening the floor) is
    ///         allowed; loosening it below the TWAP floor is the MEV-sandwich foothold this
    ///         finding patches and is rejected here.
    error TWAPFloorViolated();
    /// @notice AUDIT SFR-H-01: no prior conversion snapshot exists for this token. The first
    ///         conversion bootstraps the snapshot and is restricted to the contract owner so
    ///         the slippage floor can be checked off-chain by a trusted operator before any
    ///         permissionless caller can use `convertTokenFeesToETH{,FoT}`. Subsequent
    ///         conversions are permissionless — the on-chain TWAP gates the minETHOut.
    error TWAPBootstrapRequired();
    /// @notice AUDIT SFR-H-01: the Uniswap V2 factory does not have a pair for `token/WETH`.
    ///         No swap path means no fee conversion to ETH is possible — `withdrawTokenFees`
    ///         remains as the owner-only escape hatch for tokens without a liquid WETH pair.
    error NoPairForToken();
    /// @notice AUDIT SFR-M-01 (MEDIUM, 2026-04-28): caller-supplied conversion path is malformed
    ///         (length out of bounds, doesn't start at `token`, doesn't end at WETH, or
    ///         contains a duplicate hop).
    error InvalidConversionPath();
    /// @notice AUDIT SFR-M-01: caller attempted a multi-hop conversion path (length > 2)
    ///         while not the contract owner. Multi-hop paths are owner-restricted because
    ///         the TWAP floor anchors against the direct token/WETH pair only.
    error MultiHopOwnerOnly();

    // Legacy error aliases (kept for test compatibility during V2 migration)
    error UseProposeFeeChange();
    error UseProposeTreasuryChange();

    constructor(address _router, address _treasury, uint256 _feeBps, address _referralSplitter)
        OwnableNoRenounce(msg.sender)
    {
        if (_router == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        router = IUniswapV2Router02(_router);
        WETH = IUniswapV2Router02(_router).WETH();
        // AUDIT SFR-H-01: cache the Uniswap V2 factory at construction so
        // `convertTokenFeesToETH{,FoT}` can resolve the token/WETH pair at call time
        // and read its cumulative-price accumulators for the TWAP-floor minETHOut.
        // Reverts ZeroAddress if the router exposes a zero factory (mis-wired router).
        address _factory = IUniswapV2Router02(_router).factory();
        if (_factory == address(0)) revert ZeroAddress();
        uniFactory = ISwapFeeRouterUniFactory(_factory);
        treasury = _treasury;
        feeBps = _feeBps;
        if (_referralSplitter != address(0)) {
            referralSplitter = IReferralSplitter(_referralSplitter);
        }
    }

    // ─── Internal Helpers ────────────────────────────────────────────

    /// @dev Forward fee ETH to referral splitter. Returns true if ETH was forwarded.
    function _recordReferralFee(address _user, uint256 _feeAmount) internal returns (bool) {
        if (address(referralSplitter) == address(0) || _feeAmount == 0) return false;
        try referralSplitter.recordFee{value: _feeAmount}(_user) {
            return true;
        } catch {
            emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
            return false;
        }
    }

    /// @dev Get the effective fee for a swap path and user, considering:
    ///      1. Per-input-token fee override (keyed on `path[0]` — see AUDIT R-014 M-1
    ///         note on `inputTokenFeeBps`). Applies to every swap starting with that
    ///         token, irrespective of which pair the path resolves to.
    ///      2. Premium discount (if user has Gold Card subscription).
    ///      Falls back to the global `feeBps` if no override exists for the input token.
    function _getEffectiveFeeBps(address inputToken, address user) internal view returns (uint256) {
        // Step 1: Determine base fee (per-input-token override or global default)
        uint256 baseFee;
        if (hasInputTokenFeeOverride[inputToken]) {
            baseFee = inputTokenFeeBps[inputToken];
        } else {
            baseFee = feeBps;
        }

        // Step 2: Apply premium discount if user has active premium subscription.
        // AUDIT M-2: this is a deliberate fail-open — if premiumAccess reverts (paused,
        // broken, upgraded mid-swap) the swap MUST still complete rather than brick the
        // DEX. Off-chain monitoring should poll isPremiumAccessHealthy() below so a
        // silent premium outage raises an alert even though we can't emit from here
        // (this function is view — events aren't allowed).
        if (baseFee > 0 && address(premiumAccess) != address(0)) {
            try premiumAccess.hasPremiumSecure(user) returns (bool isPremium) {
                if (isPremium && premiumDiscountBps > 0) {
                    uint256 discount = (baseFee * premiumDiscountBps) / BPS;
                    baseFee = baseFee > discount ? baseFee - discount : 0;
                }
            } catch {
                // Fail-open: user pays base fee without the discount. No revert.
            }
        }

        return baseFee;
    }

    /// @notice AUDIT M-2: off-chain health probe for the premiumAccess integration.
    /// @return healthy true if premiumAccess is unset (discount feature disabled) OR
    ///         the call to hasPremiumSecure completed without reverting. false signals a
    ///         silent outage — premium users are currently paying full fees.
    function isPremiumAccessHealthy() external view returns (bool healthy) {
        if (address(premiumAccess) == address(0)) return true;
        try premiumAccess.hasPremiumSecure(address(0)) returns (bool) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice View function for frontend: get effective fee for an input token and user.
    /// @dev    AUDIT R-014 M-1: parameter is the swap-path's input token (`path[0]`),
    ///         not a pair address. The legacy `pairOrToken` name is preserved at the
    ///         public ABI; new integrations should think of it as `inputToken`.
    function getEffectiveFeeBps(address pairOrToken, address user) external view returns (uint256) {
        return _getEffectiveFeeBps(pairOrToken, user);
    }

    // ─── Swap Functions ──────────────────────────────────────────────

    /// @notice Swap ETH for tokens with protocol fee deducted from input ETH
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external payable nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (msg.value == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[0] != router.WETH()) revert PathStartMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 fee = (msg.value * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 amountAfterFee = msg.value - fee;

        if (fee > 0) {
            totalETHFees += fee;
            if (!_recordReferralFee(msg.sender, fee)) {
                accumulatedETHFees += fee;
            }
        }

        amounts = router.swapExactETHForTokens{value: amountAfterFee}(amountOutMin, path, to, deadline);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutput();

        emit SwapExecuted(msg.sender, address(0), path[path.length - 1], msg.value, fee);
    }

    /// @notice Swap tokens for ETH with protocol fee deducted from output ETH
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[path.length - 1] != router.WETH()) revert PathEndMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - balBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        uint256 adjustedMin;
        if (effectiveFee >= BPS) {
            revert AdjustedMinOverflow();
        } else if (amountOutMin <= type(uint256).max / BPS) {
            adjustedMin = (amountOutMin * BPS + BPS - effectiveFee - 1) / (BPS - effectiveFee);
        } else {
            // SECURITY FIX M-4: Revert instead of silently weakening slippage protection.
            // Previously fell through to unadjusted amountOutMin, defeating fee compensation.
            revert AdjustedMinOverflow();
        }

        uint256 ethBefore = address(this).balance;
        amounts = router.swapExactTokensForETH(actualReceived, adjustedMin, path, address(this), deadline);
        uint256 ethReceived = address(this).balance - ethBefore;

        IERC20(path[0]).forceApprove(address(router), 0);

        uint256 fee = (ethReceived * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = ethReceived - fee;

        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            totalETHFees += fee;
            if (!_recordReferralFee(msg.sender, fee)) {
                accumulatedETHFees += fee;
            }
        }

        // WETHFallbackLib: Safe ETH transfer with WETH fallback for contracts without receive()
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, userAmount);

        emit SwapExecuted(msg.sender, path[0], address(0), amountIn, fee);
    }

    /// @notice Swap tokens for tokens with protocol fee deducted from input tokens
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - balBefore;

        uint256 fee = (actualReceived * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 amountAfterFee = actualReceived - fee;

        if (fee > 0) {
            accumulatedTokenFees[path[0]] += fee;
            totalTokenFees[path[0]] += fee;
        }

        IERC20(path[0]).forceApprove(address(router), amountAfterFee);
        amounts = router.swapExactTokensForTokens(amountAfterFee, amountOutMin, path, to, deadline);

        IERC20(path[0]).forceApprove(address(router), 0);

        emit SwapExecuted(msg.sender, path[0], path[path.length - 1], amountIn, fee);
    }

    // ─── Fee-on-Transfer Swap Variants (AUDIT M-6) ────────────────────
    //
    // These mirror Uniswap V2 Router02's *SupportingFeeOnTransferTokens helpers so users can
    // trade tokens with internal transfer fees (rebase / reflection / deflationary tokens).
    //
    // Pattern: pull input -> measure balance delta -> approve router -> have the router send
    // output back to THIS contract -> measure output delta -> take protocol fee from the
    // output side -> forward net to `to`.
    //
    // Why output-side fee on the FoT variants:
    //   With FoT input tokens, a fee on the input side gets hit twice by the FoT transfer
    //   (once when the user transfers in, again when we transfer to the router) which is both
    //   lossy and hard to account for. Taking the fee from the output delta is cleaner and
    //   avoids the critique 5.8 double-accounting concern. NOTE: this is an intentional
    //   asymmetry with the legacy non-FoT variants above, which keep their existing input-side
    //   (for token->token) or output-side (for token->ETH) fee treatment. Do NOT unify without
    //   a dedicated migration — that would change fee accounting mid-flight for all users.

    /// @notice ETH -> FoT token swap with protocol fee deducted from output tokens.
    /// @dev    Calls router.swapExactETHForTokensSupportingFeeOnTransferTokens with amountOutMin=0
    ///         internally; our own slippage check compares (received - fee) >= amountOutMin.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[0] != router.WETH()) revert PathStartMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        address outToken = path[path.length - 1];

        // Route output to THIS contract so we can measure the actual received amount
        // after the FoT token's internal transfer hook and take the protocol fee from it.
        uint256 balBefore = IERC20(outToken).balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0, path, address(this), deadline
        );
        uint256 received = IERC20(outToken).balanceOf(address(this)) - balBefore;

        uint256 fee = (received * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = received - fee;

        // Slippage check on the post-fee user amount (Uniswap's internal check was disabled
        // by passing 0 above; we do the real check here with full knowledge of fee + FoT haircut).
        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            // AUDIT M-6: book the fee on the OUTPUT token — that's what accumulated in this
            // contract. Using path[0] (WETH) here would misaccount against WETH balances the
            // contract never received, which was critique 5.8's concern.
            accumulatedTokenFees[outToken] += fee;
            totalTokenFees[outToken] += fee;
        }

        // Forward the user's share. Uses safeTransfer — outToken may apply its own
        // FoT haircut again here; the user receives the post-haircut amount which is
        // the expected behaviour for FoT tokens. (Uniswap's own Router02 has the same
        // observable behaviour.)
        IERC20(outToken).safeTransfer(to, userAmount);

        emit SwapExecuted(msg.sender, address(0), outToken, msg.value, fee);
    }

    /// @notice FoT token -> ETH swap with protocol fee deducted from output ETH.
    /// @dev    Pulls input, measures the actual-received delta (so FoT input is handled
    ///         correctly), has the router send unwrapped ETH back to us, takes fee in ETH,
    ///         forwards the remainder via WETHFallbackLib.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[path.length - 1] != router.WETH()) revert PathEndMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        // Pull input, measure balance delta to handle FoT input tokens correctly.
        uint256 tokenBalBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - tokenBalBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        uint256 ethBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            actualReceived, 0, path, address(this), deadline
        );
        uint256 ethReceived = address(this).balance - ethBefore;

        IERC20(path[0]).forceApprove(address(router), 0);

        uint256 fee = (ethReceived * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = ethReceived - fee;

        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            totalETHFees += fee;
            if (!_recordReferralFee(msg.sender, fee)) {
                accumulatedETHFees += fee;
            }
        }

        // Safe ETH transfer with WETH fallback for contract recipients.
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, userAmount);

        emit SwapExecuted(msg.sender, path[0], address(0), amountIn, fee);
    }

    /// @notice FoT token -> FoT token (or any token) swap with protocol fee deducted from output.
    /// @dev    Routes output to this contract so we can meter the received delta, take fee,
    ///         then forward remainder to `to`.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        address outToken = path[path.length - 1];

        // Pull input, measure delta (handles FoT on the input side).
        uint256 inBalBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - inBalBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        // Route output to this contract so we can measure the delta after any FoT
        // hooks fire along the swap path.
        uint256 outBalBefore = IERC20(outToken).balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            actualReceived, 0, path, address(this), deadline
        );
        uint256 received = IERC20(outToken).balanceOf(address(this)) - outBalBefore;

        IERC20(path[0]).forceApprove(address(router), 0);

        uint256 fee = (received * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = received - fee;

        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            accumulatedTokenFees[outToken] += fee;
            totalTokenFees[outToken] += fee;
        }

        IERC20(outToken).safeTransfer(to, userAmount);

        emit SwapExecuted(msg.sender, path[0], outToken, amountIn, fee);
    }

    // ─── Deprecated Stubs (revert with helpful error) ─────────────
    function setFee(uint256) external pure { revert UseProposeFeeChange(); }
    function setTreasury(address) external pure { revert UseProposeTreasuryChange(); }

    // ─── Admin wiring + apply* setters (called by SwapFeeRouterAdmin) ──

    modifier onlyAdmin() {
        if (msg.sender != swapFeeRouterAdmin) revert Unauthorized();
        _;
    }

    /// @notice One-shot setter for the sister SwapFeeRouterAdmin contract (where the
    ///         timelocked propose/execute/cancel flow lives). Callable once by owner;
    ///         after that the address is immutable. Set during deployment after the
    ///         admin contract is constructed.
    function setSwapFeeRouterAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        if (swapFeeRouterAdmin != address(0)) revert Unauthorized();
        swapFeeRouterAdmin = _admin;
        emit SwapFeeRouterAdminSet(_admin);
    }

    /// @notice Apply a new global fee. Caller must be the wired admin contract.
    function applyFee(uint256 newFee) external onlyAdmin {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 old = feeBps;
        feeBps = newFee;
        emit FeeUpdated(old, newFee);
    }

    /// @notice Apply a treasury change. Caller must be the wired admin contract.
    function applyTreasury(address _newTreasury) external onlyAdmin {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    /// @notice Apply a referral splitter change. address(0) disables referral routing.
    function applyReferralSplitter(address _newSplitter) external onlyAdmin {
        address old = address(referralSplitter);
        referralSplitter = IReferralSplitter(_newSplitter);
        emit ReferralSplitterUpdated(old, _newSplitter);
    }

    /// @notice Apply a per-input-token fee override (or removal). Caller must be the wired admin.
    /// @dev    AUDIT R-014 M-1: the `inputToken` parameter is the swap path's `path[0]`.
    ///         Every swap starting with this token will pay `newFeeBps` instead of the
    ///         global `feeBps`. Replaces the legacy `applyPairFee` whose name caused
    ///         admins to assume per-pair scoping. Emits both `InputTokenFeeApplied`
    ///         (canonical) and `PairFeeUpdated` (legacy, for ABI compatibility).
    function applyInputTokenFee(address inputToken, uint256 newFeeBps, bool removal) public onlyAdmin {
        if (inputToken == address(0)) revert ZeroAddress();
        if (removal) {
            delete inputTokenFeeBps[inputToken];
            delete hasInputTokenFeeOverride[inputToken];
            emit InputTokenFeeApplied(inputToken, 0, true);
            emit PairFeeUpdated(inputToken, 0, true);
        } else {
            if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
            inputTokenFeeBps[inputToken] = newFeeBps;
            hasInputTokenFeeOverride[inputToken] = true;
            emit InputTokenFeeApplied(inputToken, newFeeBps, false);
            emit PairFeeUpdated(inputToken, newFeeBps, false);
        }
    }

    /// @notice DEPRECATED — thin alias for `applyInputTokenFee`. The `pair` parameter
    ///         is actually the input-token address (`path[0]`); the misleading legacy
    ///         name caused the AUDIT R-014 M-1 finding. Emits `ApplyPairFeeDeprecated`
    ///         alongside the canonical event so off-chain monitors can detect callers
    ///         still using the legacy name.
    /// @dev    Kept callable by the wired admin contract (`SwapFeeRouterAdmin`'s legacy
    ///         `executePairFeeChange` still routes through this name) for backward
    ///         compatibility. Prefer `applyInputTokenFee` for new integrations.
    function applyPairFee(address pair, uint256 newFeeBps, bool removal) external onlyAdmin {
        emit ApplyPairFeeDeprecated();
        applyInputTokenFee(pair, newFeeBps, removal);
    }

    /// @notice DEPRECATED — ABI-compatible getter that proxies to `inputTokenFeeBps`.
    /// @dev    AUDIT R-014 M-1: storage was renamed but this getter is preserved so
    ///         the pre-existing public ABI continues to resolve. New integrations
    ///         should read `inputTokenFeeBps(inputToken)` directly.
    function pairFeeBps(address pair) external view returns (uint256) {
        return inputTokenFeeBps[pair];
    }

    /// @notice DEPRECATED — ABI-compatible getter that proxies to `hasInputTokenFeeOverride`.
    /// @dev    AUDIT R-014 M-1: see `pairFeeBps` above.
    function hasPairFeeOverride(address pair) external view returns (bool) {
        return hasInputTokenFeeOverride[pair];
    }

    /// @notice Apply a premium discount change. Caller must be the wired admin contract.
    function applyPremiumDiscount(uint256 newDiscountBps) external onlyAdmin {
        require(newDiscountBps <= MAX_PREMIUM_DISCOUNT_BPS, "DISCOUNT_TOO_HIGH");
        uint256 old = premiumDiscountBps;
        premiumDiscountBps = newDiscountBps;
        emit PremiumDiscountUpdated(old, newDiscountBps);
    }

    /// @notice Apply a premium-access registry change. address(0) disables the discount.
    function applyPremiumAccess(address _newAccess) external onlyAdmin {
        address old = address(premiumAccess);
        premiumAccess = IPremiumAccess(_newAccess);
        emit PremiumAccessUpdated(old, _newAccess);
    }

    // ─── V2: Revenue Pipeline (Permissionless Fee Distribution) ─────

    /// @notice Permissionless: anyone can trigger fee distribution.
    ///         Pattern: Curve FeeDistributor — keeper/bot/user pushes accumulated fees forward.
    ///         Splits accumulatedETHFees across stakers (revenueDistributor), POL
    ///         (polAccumulator), and treasury based on the timelocked fee-split BPS.
    ///
    ///         Invariants enforced at propose-time:
    ///           stakerShareBps >= MIN_STAKER_SHARE_BPS (50%)
    ///           polShareBps    <= MAX_POL_SHARE_BPS    (25%)
    ///           staker + pol   <= BPS (treasury gets the remainder)
    ///
    ///         Backward compatibility: on upgrade, stakerShareBps defaults to 10000
    ///         which means pol/treasury slices are zero and behaviour is identical
    ///         to V2 (100% to stakers). Owner must propose a split change explicitly.
    function distributeFeesToStakers() external nonReentrant {
        if (revenueDistributor == address(0)) revert ZeroAddress();
        uint256 amount = accumulatedETHFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedETHFees = 0;

        // Compute slices. Treasury is the remainder so the three slices always sum
        // to exactly `amount` — no dust can be lost or double-spent.
        uint256 stakerAmount = (amount * stakerShareBps) / BPS;
        uint256 polAmount = (amount * polShareBps) / BPS;
        uint256 treasuryAmount = amount - stakerAmount - polAmount;

        // AUDIT FIX M-4 (battle-tested): bound the gas forwarded to protocol-internal
        // destinations at 50_000. Unlimited `.call{}` gas widened the cross-contract
        // reentrancy surface for no benefit — both RevenueDistributor.receive() and
        // POLAccumulator.receive() are minimal (event emission) and fit comfortably under
        // 50k. Full WETHFallbackLib would switch to a 10k ETH stipend + WETH wrap, but a
        // WETH wrap on RevenueDistributor would strand the slice (distribute() reads
        // address(this).balance), so the middle-ground 50k stipend is the correct choice.
        // AUDIT C4: on failure, queue the slice in pendingDistribution instead of
        // reverting the whole distribute() call. A failing destination (paused, OOG,
        // mid-upgrade) used to brick all subsequent distributions; now it's a pull.
        if (stakerAmount > 0) {
            (bool okStaker,) = revenueDistributor.call{value: stakerAmount, gas: 50_000}("");
            if (!okStaker) {
                pendingDistribution[revenueDistributor] += stakerAmount;
                totalPendingDistribution += stakerAmount;
                emit DistributionDeferred(revenueDistributor, stakerAmount);
            }
        }

        // POL path: only run if we have a configured accumulator AND a non-zero slice.
        // If polShareBps > 0 but polAccumulator is unset, we fold the POL slice into
        // treasury rather than revert, so governance can't brick distribution by
        // forgetting to set the address.
        if (polAmount > 0) {
            if (polAccumulator != address(0)) {
                (bool okPol,) = polAccumulator.call{value: polAmount, gas: 50_000}("");
                if (!okPol) {
                    // AUDIT C4: same pull-pattern fallback for the POL leg.
                    pendingDistribution[polAccumulator] += polAmount;
                    totalPendingDistribution += polAmount;
                    emit DistributionDeferred(polAccumulator, polAmount);
                }
            } else {
                treasuryAmount += polAmount;
                polAmount = 0;
            }
        }

        // Treasury path: WETH fallback in case treasury is a contract that reverts on
        // plain ETH receive (consistent with other treasury flows in this contract).
        if (treasuryAmount > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, treasuryAmount);
        }

        emit FeesDistributed(revenueDistributor, stakerAmount);
        emit FeesDistributedSplit(stakerAmount, treasuryAmount, polAmount);
    }

    /// @notice Apply a new staker/POL split. Caller must be the wired admin contract.
    ///         Bounds re-checked here as defence-in-depth (admin enforces at propose-time).
    function applyFeeSplit(uint256 _stakerShareBps, uint256 _polShareBps) external onlyAdmin {
        if (_stakerShareBps < MIN_STAKER_SHARE_BPS) revert StakerShareTooLow();
        if (_polShareBps > MAX_POL_SHARE_BPS) revert PolShareTooHigh();
        if (_stakerShareBps + _polShareBps > BPS) revert SplitInvalid();
        stakerShareBps = _stakerShareBps;
        polShareBps = _polShareBps;
        emit FeeSplitUpdated(_stakerShareBps, _polShareBps, BPS - _stakerShareBps - _polShareBps);
    }

    /// @notice Apply a POL accumulator change. address(0) re-routes POL to treasury.
    function applyPolAccumulator(address _newAccumulator) external onlyAdmin {
        address old = polAccumulator;
        polAccumulator = _newAccumulator;
        emit PolAccumulatorUpdated(old, _newAccumulator);
    }

    /// @notice Apply a revenue distributor change. Caller must be the wired admin contract.
    function applyRevenueDistributor(address _newDistributor) external onlyAdmin {
        if (_newDistributor == address(0)) revert ZeroAddress();
        address old = revenueDistributor;
        revenueDistributor = _newDistributor;
        emit RevenueDistributorUpdated(old, _newDistributor);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Admin: Fee Withdrawal ───────────────────────────────────────

    // AUDIT H-3 (battle-tested fix): withdrawFees() removed. Previously it bypassed the
    // MIN_STAKER_SHARE_BPS guardrail (enforced only at propose-time), allowing the owner to
    // redirect 100% of accumulated fees to treasury regardless of the governance-set split.
    // All fee outflow now routes through distributeFeesToStakers(), which applies the
    // timelocked staker/POL/treasury split atomically.

    /// @notice Sweep any stuck ETH to treasury (non-fee dust)
    /// SECURITY FIX H6: Use WETHFallbackLib for same reason
    /// AUDIT C4: also reserve totalPendingDistribution so the deferred-distribution queue
    ///          cannot be swept to treasury before recipients pull their slices.
    function sweepETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert ZeroAmount();
        uint256 reserved = accumulatedETHFees + totalPendingDistribution;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, sweepable);
        emit FeesWithdrawn(treasury, sweepable);
    }

    /// @notice Withdraw accumulated token fees to treasury (pull-pattern)
    ///         AUDIT FIX M-04: Zero out accounting before transfer to prevent phantom balance
    ///         with fee-on-transfer tokens. Previous approach left permanent non-zero dust
    ///         in accumulatedTokenFees when transfer fee caused actualTransferred < amount.
    /// @dev    AUDIT C1: this remains an owner-only path that sends 100% to treasury for
    ///         tokens that cannot be swapped to ETH (no liquid pair, exotic FoT mechanics
    ///         that defeat both convertTokenFeesToETH variants, etc). For routine token
    ///         fees, the keeper should call convertTokenFeesToETH so the value flows through
    ///         the timelocked staker/POL/treasury split.
    function withdrawTokenFees(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 amount = accumulatedTokenFees[token];
        if (amount == 0) revert ZeroAmount();
        // AUDIT FIX M-04: Zero before transfer (CEI pattern). If token has transfer fee,
        // treasury receives less, but accounting is clean — no phantom dust remains.
        accumulatedTokenFees[token] = 0;
        IERC20(token).safeTransfer(treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    /// @notice AUDIT C1 (CRITICAL silent-killer fix): convert accumulated token fees to ETH
    ///         via the underlying Uniswap V2 router so they flow into accumulatedETHFees.
    ///         Without this path, token-only swaps (USDC↔TOWELI, USDT↔WBTC, …) accumulated
    ///         fees per-token that could only exit via withdrawTokenFees → 100% treasury.
    ///         Stakers and POL earned 0% on every token-only swap.
    ///
    ///         Permissionless so any keeper or staker can trigger the conversion (after
    ///         the owner has bootstrapped the per-token TWAP snapshot — see SFR-H-01 below).
    ///         The resulting ETH is added to accumulatedETHFees and distributed by the next
    ///         distributeFeesToStakers() call under the same timelocked split.
    ///
    ///         For fee-on-transfer tokens, use convertTokenFeesToETHFoT instead — this
    ///         variant uses the standard router path which reverts on FoT mismatch.
    ///
    /// @dev    AUDIT SFR-H-01 (HIGH): the caller-supplied `minETHOut` used to be the only
    ///         slippage gate — a permissionless caller could pick `minETHOut = 1 wei` and
    ///         bundle a sandwich (front-run sell → conversion at attacker-set bad price →
    ///         back-run buy) inside a single block. The 1h CONVERSION_COOLDOWN throttles
    ///         repetition but does NOT defend a single bundle. We now derive an internal
    ///         `twapMinETHOut` from the Uniswap V2 pair's cumulative-price accumulator
    ///         (Uniswap V2 OracleLibrary `currentCumulativePrices` pattern) over the
    ///         elapsed time since the previous conversion's snapshot, apply a 1.5% safety
    ///         margin (`TWAP_SAFETY_BPS`), then enforce
    ///         `effectiveMin = max(callerMinETHOut, twapMinETHOut)`. Caller can only
    ///         TIGHTEN the floor, never relax it. Bootstrap path (no prior snapshot for
    ///         `token`) is owner-restricted so the first conversion can't be exploited;
    ///         thereafter the path is permissionless again.
    /// @dev    AUDIT SFR-M-01 (MEDIUM, 2026-04-28): caller now supplies the swap path so
    ///         tokens that lack a direct token/WETH pair can still be converted via a
    ///         multi-hop route (e.g., `[ALT, USDC, WETH]`). The path is validated:
    ///           - `path[0] == token` and `path[length-1] == WETH`
    ///           - `2 <= length <= MAX_CONVERSION_PATH_LENGTH (4)`
    ///           - no duplicate tokens
    ///         Multi-hop paths (length > 2) are RESTRICTED TO THE OWNER because they
    ///         are price-anchored against an EXTERNAL pair the contract does not
    ///         continuously TWAP. The 2-hop direct path (`[token, WETH]`) remains
    ///         permissionless after the SFR-H-01 bootstrap as before.
    /// @param  token        ERC20 token to convert (the input token; must equal `path[0]`)
    /// @param  path         Caller-supplied swap path. Must start at `token` and end at
    ///                      WETH. Length 2 = direct pair (permissionless after bootstrap);
    ///                      length 3 or 4 = multi-hop (owner-only).
    /// @param  minETHOut    Caller-supplied minimum ETH (acts as a TIGHTER floor than
    ///                      the contract's TWAP-derived floor; cannot relax below it).
    /// @param  deadline     Standard Uniswap deadline (capped at MAX_DEADLINE)
    function convertTokenFeesToETH(
        address token,
        address[] calldata path,
        uint256 minETHOut,
        uint256 deadline
    )
        external nonReentrant whenNotPaused
    {
        if (token == address(0) || token == WETH) revert ZeroAddress();
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert to
        // propagate. Defence-in-depth against any future path where fee write lands
        // before the inner call (e.g., alternate router integrations).
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT SFR-M-01: validate caller-supplied path and gate multi-hop on owner.
        _validateConversionPath(token, path);
        // AUDIT NEW-A5 (HIGH): rate-limit per-token conversions so a sandwich attacker
        // cannot repeatedly manipulate the pool, call convertTokenFeesToETH with a
        // MEV-favorable minETHOut, and unwind. With CONVERSION_COOLDOWN per token,
        // each sandwich costs the cooldown-window delay — economically unfavorable
        // against an attacker who can only profit on a small accumulated balance.
        // Keeper bots still get a wide window (1h is long enough for most fills).
        _enforceConversionCooldown(token);

        uint256 amount = accumulatedTokenFees[token];
        if (amount == 0) revert ZeroAmount();
        // CEI: zero accounting BEFORE the swap so a malicious token's transfer hook can't
        // re-enter and double-spend the same accumulated balance.
        accumulatedTokenFees[token] = 0;

        // AUDIT SFR-H-01: derive the internal TWAP-floor minETHOut and pick the tighter of
        // (callerMinETHOut, twapMinETHOut). Bootstrap path is owner-only (see helper).
        // NB: the TWAP floor is anchored against the DIRECT token/WETH pair regardless of
        // how many hops the caller chose. For multi-hop paths the owner-only gate above
        // already restricts callers to a trusted operator.
        (uint256 effectiveMin, uint256 currentCum, uint32 currentTs) =
            _enforceTWAPMinETHOut(token, amount, minETHOut);

        IERC20(token).forceApprove(address(router), amount);

        uint256 ethBefore = address(this).balance;
        // SFR-H-01: forward `effectiveMin` (NOT the raw `minETHOut`) to the inner router so
        // the swap reverts at the Uniswap K-check boundary if the post-attack price would
        // produce less than the TWAP floor.
        router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(router), 0);

        // SFR-H-01: snapshot the current cumulative AFTER the swap so the next conversion
        // computes the TWAP across the full intervening period.
        lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});

        // Fold the converted ETH into the staker/POL/treasury fee pool.
        accumulatedETHFees += ethReceived;
        emit TokenFeesConverted(token, amount, ethReceived);
    }

    /// @notice AUDIT C1: fee-on-transfer variant of convertTokenFeesToETH.
    ///         Uses the router's *SupportingFeeOnTransferTokens helper so FoT-token
    ///         conversions don't revert on the K-invariant check. Measures the actual
    ///         received ETH delta and folds it into accumulatedETHFees.
    /// @dev    AUDIT SFR-H-01 (HIGH): same TWAP-floor minETHOut treatment as the standard
    ///         variant — the inner FoT router accepts caller-supplied minETHOut and would
    ///         otherwise admit a sandwich for the same reason. We size the floor against
    ///         `swapAmount` (the actual on-hand balance) since FoT haircut already reduced
    ///         what we hold; the TWAP gives an upper-bound estimate of expected ETH out
    ///         and the 1.5% safety margin tolerates additional FoT-leg + swap-leg slippage.
    /// @dev    AUDIT SFR-M-01 (MEDIUM, 2026-04-28): caller-supplied path with the same
    ///         validation + multi-hop owner gate as the standard variant. See the
    ///         convertTokenFeesToETH NatSpec above for the path semantics.
    function convertTokenFeesToETHFoT(
        address token,
        address[] calldata path,
        uint256 minETHOut,
        uint256 deadline
    )
        external nonReentrant whenNotPaused
    {
        if (token == address(0) || token == WETH) revert ZeroAddress();
        // AUDIT NEW-A4 (HIGH): see convertTokenFeesToETH above for rationale.
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT SFR-M-01: validate caller-supplied path and gate multi-hop on owner.
        _validateConversionPath(token, path);
        // AUDIT NEW-A5 (HIGH): shared cooldown across both variants so switching
        // between them doesn't bypass the rate limit.
        _enforceConversionCooldown(token);

        uint256 amount = accumulatedTokenFees[token];
        if (amount == 0) revert ZeroAmount();
        accumulatedTokenFees[token] = 0;

        // For FoT tokens we approve the actual on-hand balance because the contract may
        // hold less than `amount` after the input-side FoT haircut on prior accumulation.
        uint256 actualOnHand = IERC20(token).balanceOf(address(this));
        uint256 swapAmount = amount > actualOnHand ? actualOnHand : amount;
        if (swapAmount == 0) revert ZeroAmount();

        // AUDIT SFR-H-01: TWAP-floor minETHOut sized against the actual swap input. Caller
        // can only TIGHTEN the floor; bootstrap is owner-only (see helper).
        (uint256 effectiveMin, uint256 currentCum, uint32 currentTs) =
            _enforceTWAPMinETHOut(token, swapAmount, minETHOut);

        IERC20(token).forceApprove(address(router), swapAmount);

        uint256 ethBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            swapAmount, effectiveMin, path, address(this), deadline
        );
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(router), 0);

        // SFR-H-01: snapshot the current cumulative AFTER the swap so the next conversion
        // (either variant) computes the TWAP across the full intervening period.
        lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});

        accumulatedETHFees += ethReceived;
        emit TokenFeesConverted(token, swapAmount, ethReceived);
    }

    /// @notice Sweep any stuck ERC20 tokens to treasury (non-fee dust)
    function sweepTokens(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = accumulatedTokenFees[token];
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, sweepable);
    }

    /// @notice AUDIT C4: Pull deferred distribution slice. Permissionless — anyone can
    ///         drain a recipient's queue back to that recipient, so a buggy receiver can't
    ///         hold the slice hostage. ETH is sent via WETHFallbackLib so even a contract
    ///         that reverts on raw ETH receive (the original failure cause) gets WETH
    ///         instead — guaranteed delivery on the second hop.
    /// @param  recipient The original distribution destination whose queue to drain.
    function withdrawPendingDistribution(address recipient) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = pendingDistribution[recipient];
        if (amount == 0) revert ZeroAmount();
        pendingDistribution[recipient] = 0;
        totalPendingDistribution -= amount;
        WETHFallbackLib.safeTransferETHOrWrap(WETH, recipient, amount);
        emit PendingDistributionWithdrawn(recipient, amount);
    }

    /// @notice Recover stranded callerCredit ETH from the current ReferralSplitter.
    ///         AUDIT L2 / C1-extended: now permissionless and folds the recovered ETH
    ///         into accumulatedETHFees so it flows through the timelocked staker/POL/treasury
    ///         split via distributeFeesToStakers. Previously the recovered ETH landed as
    ///         orphan balance that only sweepETH (treasury-only) could move.
    function recoverCallerCredit() external nonReentrant {
        require(address(referralSplitter) != address(0), "NO_SPLITTER");
        uint256 balBefore = address(this).balance;
        referralSplitter.withdrawCallerCredit();
        uint256 recovered = address(this).balance - balBefore;
        if (recovered > 0) {
            accumulatedETHFees += recovered;
        }
        emit CallerCreditRecovered(address(referralSplitter), recovered);
    }

    /// @notice Recover stranded callerCredit ETH from an old ReferralSplitter.
    ///         AUDIT L2 / C1-extended: same accumulator routing as recoverCallerCredit.
    ///         Kept onlyOwner because the caller specifies an arbitrary external splitter
    ///         address — the pull is a trusted external call and we don't want a malicious
    ///         caller to direct the contract at arbitrary addresses for griefing.
    function recoverCallerCreditFrom(address oldSplitter) external onlyOwner nonReentrant {
        if (oldSplitter == address(0)) revert ZeroAddress();
        uint256 balBefore = address(this).balance;
        IReferralSplitter(oldSplitter).withdrawCallerCredit();
        uint256 recovered = address(this).balance - balBefore;
        if (recovered > 0) {
            accumulatedETHFees += recovered;
        }
        emit CallerCreditRecovered(oldSplitter, recovered);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Validate that a swap path contains no duplicate tokens (cycles)
    function _validateNoDuplicates(address[] calldata path) internal pure {
        for (uint256 i = 0; i < path.length; i++) {
            for (uint256 j = i + 1; j < path.length; j++) {
                if (path[i] == path[j]) revert DuplicateTokenInPath();
            }
        }
    }

    /// @dev AUDIT SFR-M-01 (MEDIUM, 2026-04-28): validate the caller-supplied conversion
    ///      path used by `convertTokenFeesToETH{,FoT}`. Rules:
    ///        - Length in [2, MAX_CONVERSION_PATH_LENGTH] (caller can pass at most 4 hops)
    ///        - path[0] must equal the input `token` (no spoofing the input)
    ///        - path[length-1] must equal WETH (we ALWAYS exit to WETH so the proceeds
    ///          flow into accumulatedETHFees)
    ///        - No duplicate hops (rejects cycles, e.g., `[A, B, A, WETH]`)
    ///      Multi-hop paths (length > 2) are restricted to the contract owner because
    ///      the SFR-H-01 TWAP anchor is against the direct token/WETH pair only — a
    ///      permissionless multi-hop call could route through an attacker-controlled
    ///      pool whose price the TWAP cannot bound.
    function _validateConversionPath(address token, address[] calldata path) internal view {
        uint256 len = path.length;
        if (len < 2 || len > MAX_CONVERSION_PATH_LENGTH) revert InvalidConversionPath();
        if (path[0] != token) revert InvalidConversionPath();
        if (path[len - 1] != WETH) revert InvalidConversionPath();
        // Reject duplicates (also catches `[token, WETH, WETH]` and similar shapes).
        for (uint256 i = 0; i < len; i++) {
            for (uint256 j = i + 1; j < len; j++) {
                if (path[i] == path[j]) revert InvalidConversionPath();
            }
        }
        if (len > 2 && msg.sender != owner()) revert MultiHopOwnerOnly();
    }

    /// @dev AUDIT NEW-A5: per-token conversion cooldown to price out sandwich MEV.
    function _enforceConversionCooldown(address token) internal {
        uint256 last = lastConvertedAt[token];
        if (last != 0 && block.timestamp < last + CONVERSION_COOLDOWN) {
            revert("CONVERSION_COOLDOWN_ACTIVE");
        }
        lastConvertedAt[token] = block.timestamp;
    }

    /// @dev AUDIT SFR-H-01: read the Uniswap V2 pair's cumulative price (token → WETH
    ///      direction) and bridge with `spotPrice * elapsedSinceLastPairTouch` so the
    ///      cumulative is correct even when the pair has been idle since its last
    ///      swap/mint/burn. Mirrors the Uniswap V2 OracleLibrary `currentCumulativePrices`
    ///      pattern (also used inside TegridyTWAP.update at R014).
    /// @return pair       The Uniswap V2 pair address. Reverts `NoPairForToken` if absent.
    /// @return currentCum The token→WETH cumulative at the current block (UQ112x112 * sec).
    /// @return currentTs  uint32 block.timestamp (modular, Uniswap V2 convention).
    function _readCurrentCumulative(address token)
        internal
        view
        returns (address pair, uint256 currentCum, uint32 currentTs)
    {
        pair = uniFactory.getPair(token, WETH);
        if (pair == address(0)) revert NoPairForToken();

        ISwapFeeRouterUniPair p = ISwapFeeRouterUniPair(pair);
        (uint112 reserve0, uint112 reserve1, uint32 pairTs) = p.getReserves();
        // No-reserves pair would mean no swap is possible — let the inner router revert
        // there with a clearer reason. Defensive: if both are zero return zeros.
        if (reserve0 == 0 || reserve1 == 0) revert NoPairForToken();

        currentTs = uint32(block.timestamp % 2 ** 32);
        // Spot price token→WETH = reserveWETH / reserveToken (in UQ112x112).
        // Determine which side `token` is on.
        bool tokenIsToken0 = p.token0() == token;
        uint256 cumBase = tokenIsToken0 ? p.price0CumulativeLast() : p.price1CumulativeLast();

        // Bridge the integral across the idle window. spot is `reserveOther / reserveThis`
        // where `this` is the token side and `other` is the WETH side.
        uint256 spot;
        if (tokenIsToken0) {
            spot = (uint256(reserve1) * Q112_SFR) / reserve0;
        } else {
            spot = (uint256(reserve0) * Q112_SFR) / reserve1;
        }
        uint32 bridgeElapsed;
        unchecked {
            // uint32 modular subtraction — safe across the year-2106 rollover.
            bridgeElapsed = currentTs - pairTs;
        }
        unchecked {
            // Modular addition matches Uniswap V2 wrapping accumulator semantics.
            currentCum = cumBase + (spot * uint256(bridgeElapsed));
        }
    }

    /// @dev AUDIT SFR-H-01: derive the internal TWAP-floor minETHOut from the snapshot
    ///      taken at the previous successful conversion, apply a 1.5% safety margin, then
    ///      pick `effectiveMin = max(callerMinETHOut, twapMin)`. Bootstrap path (no prior
    ///      snapshot OR snapshot too recent) is owner-only — see TWAPBootstrapRequired.
    /// @param token             Token being converted (path[0])
    /// @param amountIn          Token amount fed into the swap (post any FoT haircut)
    /// @param callerMinETHOut   The minETHOut the caller passed in (additive tightening)
    /// @return effectiveMin     The minETHOut that will be enforced against the swap.
    /// @return currentCum       The token→WETH cumulative at the current block (for snapshot).
    /// @return currentTs        uint32 block.timestamp (for snapshot).
    function _enforceTWAPMinETHOut(address token, uint256 amountIn, uint256 callerMinETHOut)
        internal
        returns (uint256 effectiveMin, uint256 currentCum, uint32 currentTs)
    {
        // Resolve the pair + read the current cumulative (with idle-window bridge).
        (, currentCum, currentTs) = _readCurrentCumulative(token);

        PriceSnapshot memory prev = lastConversionSnapshot[token];
        if (prev.timestamp == 0) {
            // Bootstrap: no prior snapshot. Owner-only so the first call can't be sandwiched.
            // The owner is expected to set a sane minETHOut off-chain (treasury policy);
            // subsequent permissionless calls inherit the on-chain TWAP floor.
            if (msg.sender != owner()) revert TWAPBootstrapRequired();
            // First call still respects the caller's floor.
            effectiveMin = callerMinETHOut;
            emit ConversionTWAPFloor(token, effectiveMin, callerMinETHOut, true);
            return (effectiveMin, currentCum, currentTs);
        }

        // Compute elapsed using uint32 modular subtraction (Uniswap V2 wrap-safe).
        uint32 elapsed;
        unchecked {
            elapsed = currentTs - prev.timestamp;
        }
        if (uint256(elapsed) < MIN_TWAP_PERIOD) {
            // Snapshot exists but the integral is too short to trust as a slippage floor.
            // This should normally be unreachable because the 1h CONVERSION_COOLDOWN
            // guarantees ≥1h between calls, but governance could lower CONVERSION_COOLDOWN
            // in a future patch — the explicit check guards against that and against any
            // edge where lastConvertedAt was zeroed independently of the snapshot.
            if (msg.sender != owner()) revert TWAPBootstrapRequired();
            effectiveMin = callerMinETHOut;
            emit ConversionTWAPFloor(token, effectiveMin, callerMinETHOut, true);
            return (effectiveMin, currentCum, currentTs);
        }

        // TWAP price = (currentCum - prev.cum) / elapsed, in UQ112x112 (token→WETH).
        // ETH amount = amountIn * twapPrice / Q112.
        uint256 priceDiff;
        unchecked {
            priceDiff = currentCum - prev.cumulative;
        }
        // amountIn * priceDiff fits comfortably for any reasonable token amount + sane Q112
        // values. Solidity 0.8 reverts on overflow which is the safe fail-mode here.
        uint256 twapEthOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112_SFR);
        // Apply 1.5% safety margin — caller cannot relax below this floor.
        uint256 twapMin = (twapEthOut * (BPS - TWAP_SAFETY_BPS)) / BPS;

        // Caller can only TIGHTEN the floor (raise it). If they pass a lower minETHOut we
        // ignore their value and enforce the TWAP floor; if they pass a higher value we
        // enforce theirs (more conservative slippage policy).
        effectiveMin = callerMinETHOut > twapMin ? callerMinETHOut : twapMin;
        emit ConversionTWAPFloor(token, effectiveMin, callerMinETHOut, false);
    }

    receive() external payable {}
}
