// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";

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
    /// @notice AUDIT FIX: DEEP-R3-M02 — used by `applyReferralSplitter(address(0))` to
    ///         enforce the same propose-time guard pattern as DEEP-R-M04 on
    ///         `applyPolAccumulator`: governance must zero the splitter's referral
    ///         share via the splitter's own timelocked `proposeReferralFeeChange`
    ///         flow before the splitter address itself can be unset on the router.
    function referralFeeBps() external view returns (uint256);
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

    /// @notice PASS7-SFR-05 FIX: L2 sequencer-uptime grace window. Mirrors the
    ///         identical constant on TegridyTWAP / TegridyLending /
    ///         POLAccumulator. After a sequencer outage resumes, every TWAP-
    ///         consuming consumer must wait 1h before trusting the integrated
    ///         price (the chain needs time for arb to correct any reserves
    ///         frozen during the outage). Constant matches the sister contracts;
    ///         changing it requires a sister-contract redeploy (architectural,
    ///         not timelock).
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    /// @notice PASS7-SFR-05 FIX: L2 sequencer-uptime feed (Chainlink). On
    ///         mainnet (chainId 1) this is `address(0)` and all
    ///         `SequencerCheck.*` helpers no-op, preserving exact mainnet
    ///         semantics. On L2s (Arbitrum, Optimism, Base) the feed is the
    ///         Chainlink L2 sequencer-uptime feed for that chain. Without this
    ///         gate, the per-token TWAP snapshot would integrate across the
    ///         outage window — the post-resume conversion call would set the
    ///         minETHOut floor against pre-outage manipulated reserves.
    ///
    ///         NOT immutable so existing deploy scripts and the 17 in-tree
    ///         test instantiations don't need a constructor-arg update.
    ///         Default `address(0)` (mainnet semantics) is in effect until
    ///         the owner calls `setSequencerFeed(feed)` ONCE on an L2 deploy.
    ///         The setter is one-shot — once set, the value cannot be changed
    ///         (mirrors the immutable-by-construction guarantee but defers the
    ///         set to deploy-time configuration). Pattern of record: Aave V3
    ///         L2-deploy `ACLManager.grantSequencerOracleRole` is also a
    ///         post-deploy one-shot setter.
    address public sequencerFeed;

    /// @notice AUDIT SFR-M-02 (MEDIUM, 2026-04-28): minimum accumulated token-fee balance
    ///         required to enter the per-token conversion cooldown. Without this gate, an
    ///         attacker could trigger the 1h cooldown on a target token with 1-wei worth of
    ///         accumulated fees, bricking the keeper bot's legitimately-sized conversion
    ///         until the cooldown lapses.
    ///
    ///         1e18 picks a generous floor: for 18-decimal tokens (~$0.50 to $5,000 per
    ///         token-unit) this is one full token — meaningful but not gas-prohibitive
    ///         to accumulate. For 6-decimal tokens like USDC/USDT, 1e18 corresponds to
    ///         ~$1 trillion, which is intentionally restrictive — operators should set a
    ///         per-token policy (e.g., separate convertTokenFeesToETHFor6Decimal() helper
    ///         in a future patch) for stablecoin fee conversions, or simply withdraw via
    ///         the owner-only `withdrawTokenFees` path (which routes 100% to treasury).
    ///
    ///         Storage layout: this is a `constant` (no slot consumed). If we need a
    ///         per-token override later, that lands as a new mapping APPENDED to state.
    uint256 public constant MIN_TOKEN_FEE_FOR_CONVERSION = 1e18;

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
    /// @notice AUDIT FIX: DEEP-R3-M01 — absolute floor (in wei) on the caller-supplied
    ///         `minETHOut` for owner-only multi-hop conversions. The pass-2 fix only
    ///         rejected the literal value `0`, leaving the trivial bypass `minETHOut = 1`
    ///         that admitted the same `accumulatedTokenFees[token]` drain under owner-key
    ///         compromise (any positive integer satisfies a `> 0` check; `ethReceived ≥ 1`
    ///         is true for almost every non-degenerate swap). Anchoring to a meaningful
    ///         absolute floor (1e14 wei = 0.0001 ETH ≈ ~$0.30) turns the trivial bypass
    ///         into a noisy revert without rejecting legitimate small-balance conversions
    ///         (real conversions accumulate `MIN_TOKEN_FEE_FOR_CONVERSION = 1e18` of token
    ///         and produce orders of magnitude more ETH on any liquid path).
    /// @dev    Multi-hop is `_validateConversionPath`-gated to `msg.sender == owner()`,
    ///         so this floor is defence-in-depth against owner-key compromise / honest
    ///         operator-script error pasting `1` as a bypass value.
    uint256 public constant MIN_MULTIHOP_ETH_OUT_WEI = 1e14;
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

    /// @notice AUDIT FIX: DEEP-R-L03 — per-caller timestamp of the last
    ///         `recoverCallerCredit()` invocation. Combined with
    ///         `RECOVER_CALLER_CREDIT_COOLDOWN`, prevents permissionless gas-griefing
    ///         loops where a hostile caller spams the function (and its zero-amount
    ///         events) at the floor cost of ~2.5k gas per call.
    /// @dev    AUDIT FIX: DEEP-R3-L02 — REMOVED dead `lastCallerCreditPullAt` mapping.
    ///         The pass-2 fix retained it "for storage-layout stability across the
    ///         upgrade", but SwapFeeRouter is constructor-deployed standalone (no UUPS /
    ///         proxy / Initializable pattern), so storage layout is not a constraint here.
    ///         Leaving the mapping in place produced a misleading public ABI: the auto-
    ///         generated `lastCallerCreditPullAt(address)` getter always returned 0, which
    ///         confused indexers and front-end code that subscribed to it. The
    ///         authoritative cooldown slot is `lastCallerCreditAt` below.
    /// @notice AUDIT FIX: DEEP-R2-M03 — single-slot global cooldown timestamp for
    ///         `recoverCallerCredit()`. Replaces the per-msg.sender mapping above so an
    ///         attacker spawning N EOAs cannot run N calls per block: every block-level
    ///         grief loop now pays the same `RECOVER_CALLER_CREDIT_COOLDOWN` window
    ///         regardless of EOA count. Honest keeper cadence is unaffected (30s ≪ any
    ///         realistic distribution interval).
    uint256 public lastCallerCreditAt;
    /// @notice AUDIT FIX: DEEP-R-L03 — minimum gap between successive
    ///         `recoverCallerCredit()` calls. 30 seconds matches the typical block
    ///         window for L1; small enough not to interfere with legitimate keeper
    ///         bots, large enough to make tight grief loops meaningfully more
    ///         expensive than the per-call SLOAD floor.
    /// @dev    AUDIT FIX: DEEP-R2-M03 — semantics changed from per-caller to global;
    ///         constant value unchanged.
    uint256 public constant RECOVER_CALLER_CREDIT_COOLDOWN = 30;

    // ─── AUDIT FIX: DEEP-R-M06 — TWAP snapshot reset (timelocked) ────────
    /// @notice Token whose `lastConversionSnapshot` will be deleted on execute.
    address public pendingResetToken;
    /// @notice Earliest timestamp at which `executeResetTWAPSnapshot` is callable.
    ///         Zero when no proposal is pending.
    uint256 public twapSnapshotResetReadyAt;
    /// @notice 7-day timelock on the TWAP snapshot reset, parity with admin replacement.
    uint256 public constant TWAP_SNAPSHOT_RESET_TIMELOCK = 7 days;
    /// @notice Timelock key (informational only — flow lives inline on this contract).
    bytes32 public constant TWAP_SNAPSHOT_RESET = keccak256("TWAP_SNAPSHOT_RESET");

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
    /// @notice AUDIT R-014 M-1: emitted whenever the legacy `applyPairFee` alias was
    ///         invoked. Retained on the ABI for indexer compatibility but no longer
    ///         emitted — the alias now reverts with `DeprecatedUseInputTokenFee`
    ///         (SFR-M-03, 2026-04-28).
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
    /// @notice AUDIT FIX: DEEP-R-M06 — emitted when the owner proposes a TWAP snapshot
    ///         reset. Off-chain monitors can alert on the 7-day window before execute.
    event TWAPSnapshotResetProposed(address indexed token, uint256 executeAfter);
    /// @notice AUDIT FIX: DEEP-R-M06 — emitted when the snapshot is actually deleted.
    ///         Re-bootstrapping is required (owner-only) on the next conversion.
    event TWAPSnapshotResetExecuted(address indexed token);
    /// @notice AUDIT FIX: DEEP-R-M06 — emitted on cancel.
    event TWAPSnapshotResetCancelled(address indexed token);

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
    /// @notice AUDIT SFR-M-02 (MEDIUM, 2026-04-28): accumulated token fees for `token` are
    ///         below `MIN_TOKEN_FEE_FOR_CONVERSION`. Conversion is refused so a 1-wei
    ///         dust trigger cannot brick legitimate keeper-sized conversions for the
    ///         duration of the per-token cooldown.
    error TokenFeesBelowMinimum();
    /// @notice AUDIT SFR-M-03 (MEDIUM, 2026-04-28): legacy mutative aliases that previously
    ///         routed through to `applyInputTokenFee` are now ABI-bait reverters. Callers
    ///         must migrate to the canonical `applyInputTokenFee` selector (router) and
    ///         `proposeInputTokenFeeChange` / `executeInputTokenFeeChange` (admin).
    error DeprecatedUseInputTokenFee();
    /// @notice AUDIT SFR-M-04 (MEDIUM, 2026-04-28): no admin-replacement proposal pending,
    ///         OR the proposal is still inside its 7-day timelock window.
    error AdminReplacementUnavailable();
    /// @notice AUDIT FIX: DEEP-R-M04 — `applyPolAccumulator(address(0))` was attempted
    ///         while `polShareBps > 0`, which would silently re-route the POL slice to
    ///         treasury and break the timelocked fee-split invariant. Governance must
    ///         first explicitly zero the POL share via the proper `feeSplit` timelock.
    error PolShareNonZero();
    /// @notice AUDIT FIX: DEEP-R3-M02 — `applyReferralSplitter(address(0))` was attempted
    ///         while the splitter's `referralFeeBps > 0`, which would silently terminate
    ///         every existing referral relationship (referrer slice would silently fold
    ///         into `accumulatedETHFees` instead of routing to `pendingETH[referrer]` on
    ///         the splitter). Governance must first zero the splitter's referral share via
    ///         the splitter's own timelocked `proposeReferralFeeChange`/`executeReferralFeeChange`
    ///         flow before the splitter address itself can be unset here. Mirrors the
    ///         DEEP-R-M04 pattern on `applyPolAccumulator`.
    error ReferralFeeNonZero();
    /// @notice AUDIT FIX: DEEP-R-L03 — caller invoked `recoverCallerCredit` inside
    ///         the per-caller cooldown window. Soft rate-limit against gas griefing.
    error RecoverCallerCreditCooldown();
    /// @notice AUDIT FIX: DEEP-R-M06 — no pending TWAP snapshot reset proposal,
    ///         the proposal isn't ready yet, or the proposal expired.
    error TWAPSnapshotResetUnavailable();
    /// @notice AUDIT FIX: DEEP-R2-M01 — multi-hop owner-only conversion path skips the
    ///         direct-pair TWAP anchor and trusts caller-supplied `minETHOut`. The
    ///         pre-regression code accepted `0` as a valid floor, which under an
    ///         owner-key-compromise scenario would let an attacker drain the entire
    ///         accumulated balance for whatever ETH the (sandwich-controllable) multi-hop
    ///         produces. The explicit non-zero check turns that drain into a noisy revert.
    /// @notice AUDIT FIX: DEEP-R3-M01 — also reverts when caller-supplied `minETHOut`
    ///         is below `MIN_MULTIHOP_ETH_OUT_WEI` (1e14). The pass-2 `> 0` check was a
    ///         trivial bypass: `minETHOut = 1` satisfied it and admitted the same drain.
    error ZeroMinOut();

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
        // PASS7-SFR-05 FIX: `sequencerFeed` defaults to address(0) (mainnet
        // semantics — SequencerCheck helpers no-op). On an L2 deploy, owner
        // must call `setSequencerFeed(feed)` once before the first conversion.
    }

    /// @notice PASS7-SFR-05 FIX: one-shot owner setter for the L2 sequencer-
    ///         uptime feed. Reverts after the feed is set so a captured-key
    ///         attacker cannot swap a benign feed for a controlled one. On
    ///         mainnet this is never called (feed stays address(0), all
    ///         SequencerCheck helpers no-op). On an L2 deploy, the owner
    ///         calls this ONCE in the deployment script.
    /// @dev    Pattern of record: Aave V3 L2-deploy ACLManager grant pattern —
    ///         a one-shot post-deploy setter is the standard alternative to a
    ///         constructor arg when constructor-signature stability is desired.
    function setSequencerFeed(address _feed) external onlyOwner {
        if (sequencerFeed != address(0)) revert ZeroAddress(); // already set, can't change
        if (_feed == address(0)) revert ZeroAddress();
        sequencerFeed = _feed;
        emit SequencerFeedSet(_feed);
    }

    /// @notice Emitted once when the owner sets the L2 sequencer-uptime feed
    ///         post-deploy. After this fires, `setSequencerFeed` cannot be
    ///         called again.
    event SequencerFeedSet(address indexed feed);

    // ─── Internal Helpers ────────────────────────────────────────────

    /// @dev Forward fee ETH to referral splitter. Returns true if ETH was forwarded.
    /// @dev AUDIT FIX: DEEP-R-M03 — cap forwarded gas to bound griefing from a buggy/malicious
    ///      referralSplitter while leaving comfortable slack for the splitter's own write
    ///      footprint and the inner `votingPowerOf` lookup over a multi-position staker.
    /// @dev AUDIT FIX: DEEP-R2-H01 — raise the gas cap from 50_000 to 200_000.
    ///      The 50k cap was wrongly transplanted from `distributeFeesToStakers` (where the
    ///      receivers are minimal `receive()` shims); `recordFee` itself spends ~38k on cold
    ///      writes BEFORE entering `votingPowerOf(referrer)`, which then iterates the
    ///      referrer's staking-position set at ~8.4k cold gas per position. With the 50k
    ///      cap, any referrer holding ≥2 cold staking positions silently OOG'd inside the
    ///      splitter's try/catch — splitter returned success, the referrer's slice was
    ///      redirected to `accumulatedTreasuryETH`, and SwapFeeRouter never emitted
    ///      `ReferralFeeRedirectedToTreasury`. 200_000 covers ~10 cold positions plus the
    ///      splitter's own state mutation and event with safe headroom (well below the
    ///      protocol's observed real-world max of ~120k).
    /// @dev AUDIT FIX: DEEP-R3-H01 — raise the gas cap further from 200_000 to 700_000.
    ///      The 200k cap covered ~16 cold positions worst-case (200k − ~62k splitter pre-work
    ///      = 138k for `votingPowerOf`, ÷ 8.4k per position ≈ 16). But TegridyStaking's
    ///      `MAX_POSITIONS_PER_HOLDER = 50` means a long-tenured whale referrer can legitimately
    ///      accumulate up to 50 positions, requiring ~420k for the inner `votingPowerOf`
    ///      staticcall. Any referrer holding ≥17 cold positions silently OOG'd inside the
    ///      splitter's try/catch under the 200k cap (same shape as pre-DEEP-R2-H01: splitter
    ///      returned success, referrer slice silently redirected to treasury, no router-side
    ///      `ReferralFeeRedirectedToTreasury` event). 700_000 covers ~76 cold positions
    ///      (700k − ~62k = 638k, ÷ 8.4k ≈ 76), giving 50%+ headroom over `MAX_POSITIONS_PER_HOLDER`.
    ///      The cap is still bounded against a buggy/malicious splitter, but generously
    ///      above the worst-case legitimate referrer; the 48 h `applyReferralSplitter`
    ///      timelock remains the primary trust boundary for the splitter address itself.
    /// @dev AUDIT FIX: DEEP-R2-H01 — emit `ReferralFeeRedirectedToTreasury` even on the
    ///      out-of-gas / silent-demotion path (`recordFee` returned success but the splitter
    ///      internally redirected to treasury). The router cannot directly observe that
    ///      branch, but raising the gas cap means we never reach the silent path; if the
    ///      explicit catch fires we still emit, matching pre-regression observability.
    /// @dev AUDIT FIX: DEEP-R-I01 — narrow the catch so an asserted invariant violation
    ///      is at least distinguishable on-chain from a normal revert. Behaviour remains
    ///      fail-open (per the documented intent) — we still redirect to treasury — but
    ///      the explicit branches keep the door open for a future "alarm on Panic" hook.
    function _recordReferralFee(address _user, uint256 _feeAmount) internal returns (bool) {
        if (address(referralSplitter) == address(0) || _feeAmount == 0) return false;
        // AUDIT FIX: DEEP-R3-H01 — gas cap raised 200_000 → 700_000 to cover whale referrers
        // up to TegridyStaking.MAX_POSITIONS_PER_HOLDER = 50.
        try referralSplitter.recordFee{value: _feeAmount, gas: 700_000}(_user) {
            return true;
        } catch Error(string memory) {
            emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
            return false;
        } catch Panic(uint256) {
            emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
            return false;
        } catch (bytes memory) {
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
        // AUDIT FIX: DEEP-R-M03 — cap forwarded gas at 50k. `hasPremiumSecure` is
        // a view (~15k gas budget) so 50k is a generous ceiling. Without the cap, a
        // buggy `premiumAccess` upgrade could OOG-grief every swap surface.
        // AUDIT FIX: DEEP-R-I01 — narrow catches as in `_recordReferralFee`. Same
        // fail-open behaviour, but Panic is now distinguishable from normal revert.
        // Note: `try` blocks must declare `gas:` in their `gas:` modifier, but the
        // expression `premiumAccess.hasPremiumSecure(user)` is a view call. Solidity
        // 0.8 lets us pass `gas:` only on external function calls — so we wrap the
        // call inside try with the gas modifier on the function call itself.
        if (baseFee > 0 && address(premiumAccess) != address(0)) {
            try premiumAccess.hasPremiumSecure{gas: 50_000}(user) returns (bool isPremium) {
                if (isPremium && premiumDiscountBps > 0) {
                    uint256 discount = (baseFee * premiumDiscountBps) / BPS;
                    baseFee = baseFee > discount ? baseFee - discount : 0;
                }
            } catch Error(string memory) {
                // Fail-open: user pays base fee without the discount. No revert.
            } catch Panic(uint256) {
                // Fail-open on assertion / overflow / OOG.
            } catch (bytes memory) {
                // Fail-open on low-level revert.
            }
        }

        return baseFee;
    }

    /// @notice AUDIT M-2: off-chain health probe for the premiumAccess integration.
    /// @dev    AUDIT FIX: DEEP-R3-I01 — `address(0)` (premium discount disabled / unset) now
    ///         returns `false` instead of `true`. The pre-fix behaviour reported "unset" as
    ///         "healthy", which contradicted the function's intent: an unset registry means
    ///         every premium user is silently paying full base fees, which IS a degraded
    ///         state from the protocol's perspective even though it's fail-OPEN for the user.
    ///         Off-chain monitors that watch this view as a liveness signal can now alert on
    ///         the address-zero case as a degraded state, distinct from the "registry set
    ///         but call reverts" outage signalled by the catch branch.
    /// @return healthy true ONLY if premiumAccess is set AND the call to hasPremiumSecure
    ///         completed without reverting. false signals either:
    ///         (a) `premiumAccess == address(0)` — discount feature is currently disabled;
    ///             premium users pay full fees and this is observable as a degraded state.
    ///         (b) `premiumAccess` reverts on probe — silent outage (paused, broken, or
    ///             upgraded mid-swap). Same fee impact as (a) but a distinct root cause.
    function isPremiumAccessHealthy() external view returns (bool healthy) {
        // AUDIT FIX: DEEP-R3-I01 — unset registry is now reported as `false` (degraded)
        // so the `apply*(address)` family follows a consistent "unset == not healthy" pattern.
        if (address(premiumAccess) == address(0)) return false;
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

    /// @notice First-time setter for the sister SwapFeeRouterAdmin contract (where the
    ///         timelocked propose/execute/cancel flow lives). Callable exactly once by
    ///         the owner — only when `swapFeeRouterAdmin == address(0)`. Subsequent
    ///         replacements MUST go through the timelocked propose/execute path
    ///         (`proposeAdminReplacement` → `executeAdminReplacement`).
    /// @dev    AUDIT SFR-M-04 (MEDIUM, 2026-04-28): prior version was permanently
    ///         one-shot, so a buggy or compromised admin contract could never be
    ///         rotated without redeploying SwapFeeRouter and migrating every
    ///         downstream consumer. Mirrors the TegridyStaking R014 H-2 fix:
    ///         replaceability behind the same timelocked propose/execute flow used
    ///         for every other admin parameter, with the propose/execute state
    ///         held INLINE on the router (not on the admin) so a broken admin
    ///         cannot block its own removal.
    function setSwapFeeRouterAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        if (swapFeeRouterAdmin != address(0)) revert Unauthorized();
        swapFeeRouterAdmin = _admin;
        emit SwapFeeRouterAdminSet(_admin);
        emit SwapFeeRouterAdminReplaced(address(0), _admin);
    }

    // ─── AUDIT SFR-M-04: Admin contract replaceability ──────────────────
    /// @notice Timelock key for the admin replacement flow.
    bytes32 public constant ADMIN_REPLACEMENT = keccak256("SFR_ADMIN_REPLACEMENT");
    /// @notice Mandatory delay between propose and execute for an admin swap.
    ///         7 days matches the TegridyStaking pattern's intent (rotate carefully)
    ///         while giving downstream consumers and monitors time to react. Longer
    ///         than the per-parameter 24-48h timelocks because rotating the entire
    ///         admin is a much larger change than tweaking a single parameter.
    uint256 public constant ADMIN_REPLACEMENT_TIMELOCK = 7 days;

    /// @notice Pending replacement admin address. Zero when no proposal is pending.
    address public pendingSwapFeeRouterAdmin;
    /// @notice block.timestamp after which `executeAdminReplacement` is callable.
    ///         Zero when no proposal is pending.
    uint256 public adminReplacementReadyAt;

    event SwapFeeRouterAdminReplaced(address indexed oldAdmin, address indexed newAdmin);
    event SwapFeeRouterAdminReplacementProposed(address indexed newAdmin, uint256 executeAfter);
    event SwapFeeRouterAdminReplacementCancelled(address indexed proposed);

    /// @notice Propose a replacement SwapFeeRouterAdmin. Reverts if no admin is set
    ///         yet — the first-time installation path is `setSwapFeeRouterAdmin`.
    /// @dev    AUDIT SFR-M-04: Mirrors the propose/execute/cancel pattern used by
    ///         every other timelocked parameter on SwapFeeRouterAdmin. Held inline
    ///         on the router (rather than on the admin contract) so a broken or
    ///         compromised admin cannot block its own removal.
    function proposeAdminReplacement(address _newAdmin) external onlyOwner {
        if (_newAdmin == address(0)) revert ZeroAddress();
        if (swapFeeRouterAdmin == address(0)) revert Unauthorized(); // use setSwapFeeRouterAdmin first
        if (adminReplacementReadyAt != 0) revert AdminReplacementUnavailable(); // existing proposal pending
        pendingSwapFeeRouterAdmin = _newAdmin;
        adminReplacementReadyAt = block.timestamp + ADMIN_REPLACEMENT_TIMELOCK;
        emit SwapFeeRouterAdminReplacementProposed(_newAdmin, adminReplacementReadyAt);
    }

    /// @notice Execute a previously proposed admin replacement after the 7-day delay.
    /// @dev    AUDIT FIX: DEEP-R-M01 — mirror TimelockAdmin's PROPOSAL_VALIDITY by
    ///         enforcing a 7-day expiry window after `readyAt`. Without this, a
    ///         years-old stale proposal stays live forever — and a forgotten
    ///         candidate address could be co-opted (CREATE2 redeploy, abandoned
    ///         multisig, expired-key custody) to install a hostile admin.
    function executeAdminReplacement() external onlyOwner {
        uint256 readyAt = adminReplacementReadyAt;
        if (readyAt == 0) revert AdminReplacementUnavailable(); // no pending proposal
        if (block.timestamp < readyAt) revert AdminReplacementUnavailable(); // delay not elapsed
        // AUDIT FIX: DEEP-R-M01 — 7-day validity window after readyAt.
        if (block.timestamp > readyAt + 7 days) revert AdminReplacementUnavailable();
        address newAdmin = pendingSwapFeeRouterAdmin;
        if (newAdmin == address(0)) revert ZeroAddress(); // defensive
        address oldAdmin = swapFeeRouterAdmin;
        swapFeeRouterAdmin = newAdmin;
        pendingSwapFeeRouterAdmin = address(0);
        adminReplacementReadyAt = 0;
        emit SwapFeeRouterAdminReplaced(oldAdmin, newAdmin);
    }

    /// @notice Cancel a pending admin replacement proposal.
    function cancelAdminReplacement() external onlyOwner {
        if (adminReplacementReadyAt == 0) revert AdminReplacementUnavailable();
        address proposed = pendingSwapFeeRouterAdmin;
        pendingSwapFeeRouterAdmin = address(0);
        adminReplacementReadyAt = 0;
        emit SwapFeeRouterAdminReplacementCancelled(proposed);
    }

    // ─── AUDIT FIX: DEEP-R-M06 — TWAP snapshot reset (timelocked) ──────
    /// @notice Propose a reset of `lastConversionSnapshot[token]`. Required when a
    ///         token's snapshot was bootstrapped against a pool in an anomalous state
    ///         (low-liquidity sandwich, mid-attack reserves) — every subsequent
    ///         permissionless conversion would then read TWAP against the poisoned
    ///         baseline, slowly bleeding value through the 1.5% safety margin.
    /// @dev    7-day timelock parity with admin replacement so this rare admin path
    ///         cannot be quietly fired by a temporarily-compromised owner key.
    ///         Stored INLINE rather than on SwapFeeRouterAdmin so the reset path
    ///         remains operable even if the admin contract itself is compromised.
    /// @dev    AUDIT FIX: DEEP-R2-L02 — UX note: this state machine uses a single
    ///         global `pendingResetToken` slot, so if you propose a reset for token A
    ///         and then realise token B is the one that needs resetting, you MUST
    ///         call `cancelResetTWAPSnapshot` first before re-proposing for B. Mirrors
    ///         the cancel-before-replace shape of `proposeAdminReplacement`. A token-
    ///         keyed mapping was considered but deferred — concurrent per-token resets
    ///         are not a real workflow today (snapshot poisoning is rare).
    function proposeResetTWAPSnapshot(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (twapSnapshotResetReadyAt != 0) revert TWAPSnapshotResetUnavailable();
        pendingResetToken = token;
        twapSnapshotResetReadyAt = block.timestamp + TWAP_SNAPSHOT_RESET_TIMELOCK;
        emit TWAPSnapshotResetProposed(token, twapSnapshotResetReadyAt);
    }

    /// @notice Execute a previously proposed TWAP snapshot reset after the 7-day delay.
    /// @dev    Mirrors the admin-replacement validity window — proposals expire 7 days
    ///         after they become executable to bound the worst-case stale-proposal window.
    function executeResetTWAPSnapshot() external onlyOwner {
        uint256 readyAt = twapSnapshotResetReadyAt;
        if (readyAt == 0) revert TWAPSnapshotResetUnavailable();
        if (block.timestamp < readyAt) revert TWAPSnapshotResetUnavailable();
        if (block.timestamp > readyAt + 7 days) revert TWAPSnapshotResetUnavailable();
        address token = pendingResetToken;
        if (token == address(0)) revert ZeroAddress(); // defensive
        delete lastConversionSnapshot[token];
        pendingResetToken = address(0);
        twapSnapshotResetReadyAt = 0;
        emit TWAPSnapshotResetExecuted(token);
    }

    /// @notice Cancel a pending TWAP snapshot reset.
    function cancelResetTWAPSnapshot() external onlyOwner {
        if (twapSnapshotResetReadyAt == 0) revert TWAPSnapshotResetUnavailable();
        address cancelled = pendingResetToken;
        pendingResetToken = address(0);
        twapSnapshotResetReadyAt = 0;
        emit TWAPSnapshotResetCancelled(cancelled);
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
    /// @dev    AUDIT FIX: DEEP-R3-M02 — reject `address(0)` whenever the CURRENT splitter's
    ///         `referralFeeBps > 0`. Previously, unsetting the splitter while a non-zero
    ///         referral share was active silently terminated every existing referral
    ///         relationship: `_recordReferralFee` short-circuits when
    ///         `referralSplitter == address(0)`, the referrer's slice silently folds into
    ///         `accumulatedETHFees` instead of routing to `pendingETH[referrer]` on the
    ///         splitter, and no router-side event distinguishes this fail-mode from
    ///         "ordinary unregistered referee". Governance must first zero the splitter's
    ///         `referralFeeBps` via the splitter's own timelocked flow before the splitter
    ///         address itself can be unset here. Mirrors the DEEP-R-M04 pattern on
    ///         `applyPolAccumulator`.
    function applyReferralSplitter(address _newSplitter) external onlyAdmin {
        address old = address(referralSplitter);
        // AUDIT FIX: DEEP-R3-M02 — sibling-miss closure for the DEEP-R-M04 pattern.
        // Only check when transitioning a live splitter to address(0). The current splitter
        // must already be set (otherwise there is no `referralFeeBps()` to read) AND the
        // new splitter must be the zero address.
        if (_newSplitter == address(0) && old != address(0)) {
            if (IReferralSplitter(old).referralFeeBps() > 0) revert ReferralFeeNonZero();
        }
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

    /// @notice DEPRECATED — was a thin alias for `applyInputTokenFee`. The `pair`
    ///         parameter was actually the input-token address (`path[0]`); the misleading
    ///         legacy name caused the AUDIT R-014 M-1 finding.
    /// @dev    AUDIT SFR-M-03 (MEDIUM, 2026-04-28): the alias is now a HARD revert. The
    ///         selector is preserved on the ABI so any in-flight automation that still
    ///         calls this function fails LOUDLY with `DeprecatedUseInputTokenFee` instead
    ///         of silently inheriting the canonical behaviour. Migrate to
    ///         `applyInputTokenFee` (router) or
    ///         `proposeInputTokenFeeChange`/`executeInputTokenFeeChange` (admin).
    ///         Pre-fix this function was an ABI bait — admins who saw `pair` in the
    ///         signature assumed per-pair scoping, then accidentally registered a
    ///         GLOBAL override on every WETH-input swap when calling with `path[0] == WETH`.
    function applyPairFee(address, uint256, bool) external pure {
        revert DeprecatedUseInputTokenFee();
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
    // AUDIT FIX: DEEP-R-H02 — pause must freeze every state-mutating ETH-flow primitive,
    // not just the user-trade entrypoints. Without `whenNotPaused`, an MEV searcher could
    // front-run the pause and shovel queued ETH at a downstream destination flagged as
    // compromised mid-incident.
    function distributeFeesToStakers() external nonReentrant whenNotPaused {
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
    /// @dev    AUDIT FIX: DEEP-R-M04 — reject `address(0)` whenever `polShareBps > 0`.
    ///         Previously, setting the accumulator to zero silently re-routed the entire
    ///         POL slice to treasury at distribute-time, breaking the timelocked fee-split
    ///         invariant without any propose-time check on the share BPS itself.
    ///         Governance must now explicitly zero the POL share via `applyFeeSplit`
    ///         (behind its own 48 h timelock) before unsetting the accumulator.
    function applyPolAccumulator(address _newAccumulator) external onlyAdmin {
        if (_newAccumulator == address(0) && polShareBps > 0) revert PolShareNonZero();
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
    /// @dev    AUDIT FIX: DEEP-R2-I01 — DEPLOYER NOTE (multi-hop-only tokens). For
    ///         tokens whose only liquid route to WETH is via an intermediate pool (no
    ///         direct token/WETH pair exists on the AMM), this contract NEVER writes
    ///         `lastConversionSnapshot[token]` (the snapshot anchor is the direct pair
    ///         and there is no direct pair to read). As a result, every subsequent
    ///         attempt to call `convertTokenFeesToETH(token, [token, WETH], …)` from
    ///         a non-owner caller will revert `NoPairForToken`. The permissionless
    ///         conversion path is permanently CLOSED for these tokens — they are
    ///         FOREVER owner-only. Keeper bots for ALT-only tokens MUST run from the
    ///         owner address (or an authorised privileged-keeper role if added later).
    /// @dev    AUDIT FIX: DEEP-R2-M01 — multi-hop branch now requires `minETHOut > 0`.
    ///         The owner-only gate is a TRUST boundary, not a substitute for defence in
    ///         depth: an owner-key-compromise (or a stale-quote operator script) calling
    ///         with `minETHOut = 0` would otherwise silently drain the entire accumulated
    ///         token balance. The non-zero floor turns that drain into a noisy revert.
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
        // AUDIT SFR-M-02 (MEDIUM, 2026-04-28): refuse conversions on dust accumulation
        // BEFORE the cooldown stamp is updated. Without this gate, an attacker could
        // trigger the 1h cooldown timer with 1-wei worth of accumulated fees, bricking
        // the keeper bot's legitimate-sized conversion until the cooldown lapses.
        uint256 amount = accumulatedTokenFees[token];
        if (amount < MIN_TOKEN_FEE_FOR_CONVERSION) revert TokenFeesBelowMinimum();
        // AUDIT NEW-A5 (HIGH): rate-limit per-token conversions so a sandwich attacker
        // cannot repeatedly manipulate the pool, call convertTokenFeesToETH with a
        // MEV-favorable minETHOut, and unwind. With CONVERSION_COOLDOWN per token,
        // each sandwich costs the cooldown-window delay — economically unfavorable
        // against an attacker who can only profit on a small accumulated balance.
        // Keeper bots still get a wide window (1h is long enough for most fills).
        _enforceConversionCooldown(token);

        // CEI: zero accounting BEFORE the swap so a malicious token's transfer hook can't
        // re-enter and double-spend the same accumulated balance.
        accumulatedTokenFees[token] = 0;

        // AUDIT FIX: DEEP-R-H01 — Multi-hop conversion paths (length > 2) bypass the
        // direct-pair TWAP floor because `_readCurrentCumulative(token)` requires the
        // token/WETH direct pair to exist (NoPairForToken otherwise), which defeats
        // the entire purpose of the multi-hop feature for tokens that lack a direct
        // pair. Multi-hop is already gated to `msg.sender == owner()` in
        // `_validateConversionPath`, so the trust assumption justifies falling back
        // to the caller-supplied `minETHOut` only (no on-chain TWAP anchor) for those
        // paths. The 2-hop direct path retains the full SFR-H-01 TWAP enforcement.
        uint256 effectiveMin;
        uint256 currentCum;
        uint32 currentTs;
        if (path.length > 2) {
            // Owner-only branch: no direct-pair TWAP anchor; trust the operator's minETHOut.
            // AUDIT FIX: DEEP-R2-M01 — require a non-zero minETHOut floor on the multi-hop
            // path. The owner-only gate is a TRUST boundary, not a substitute for defence
            // in depth. A `0` floor admits a full-balance drain under owner-key compromise
            // OR honest operator-script error (stale quote pasted as `0`). This single
            // check turns a silent drain into a revert that off-chain monitoring catches.
            // AUDIT FIX: DEEP-R3-M01 — `> 0` was a trivial bypass: `minETHOut = 1` satisfied
            // the check but admitted the same drain because `ethReceived >= 1` is always
            // true for any non-degenerate swap. Anchor against the absolute floor
            // `MIN_MULTIHOP_ETH_OUT_WEI` (1e14 wei = 0.0001 ETH) so the floor is
            // parameter-meaningful. Realistic conversions accumulate ≥1e18 of token first
            // (`MIN_TOKEN_FEE_FOR_CONVERSION`) and produce orders of magnitude more ETH
            // on any liquid path, so legitimate flows are unaffected.
            if (minETHOut < MIN_MULTIHOP_ETH_OUT_WEI) revert ZeroMinOut();
            effectiveMin = minETHOut;
            // currentCum/currentTs left zero — we only update the snapshot on direct
            // 2-hop conversions (otherwise we'd seed a meaningless zero baseline).
            emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
        } else {
            // AUDIT SFR-H-01: derive the internal TWAP-floor minETHOut and pick the tighter of
            // (callerMinETHOut, twapMinETHOut). Bootstrap path is owner-only (see helper).
            (effectiveMin, currentCum, currentTs) =
                _enforceTWAPMinETHOut(token, amount, minETHOut);
        }

        IERC20(token).forceApprove(address(router), amount);

        uint256 ethBefore = address(this).balance;
        // SFR-H-01: forward `effectiveMin` (NOT the raw `minETHOut`) to the inner router so
        // the swap reverts at the Uniswap K-check boundary if the post-attack price would
        // produce less than the TWAP floor.
        router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(router), 0);

        // AUDIT FIX: DEEP-R-H01 — only snapshot for direct 2-hop swaps; multi-hop has
        // no direct-pair anchor so we leave any prior snapshot untouched.
        //
        // AUDIT FIX HIGH-4 (multi-hop snapshot drift): on multi-hop branches, INVALIDATE
        // any existing snapshot rather than silently leaving it stale. Pre-fix, repeated
        // owner multi-hop calls bumped `lastConvertedAt[token]` (cooldown) but left
        // `lastConversionSnapshot[token]` frozen. Days later, the next permissionless
        // 2-hop call's `_enforceTWAPMinETHOut` computed `elapsed = currentTs - prev.timestamp`
        // over weeks of price drift — the time-averaged TWAP price between the stale
        // anchor and now diverges sharply from current spot, producing a `twapMin` that
        // admits sandwich at near-current spot. Setting timestamp=0 forces the next
        // direct 2-hop call into the bootstrap branch (owner-only with explicit
        // off-chain minETHOut policy).
        if (path.length == 2) {
            // SFR-H-01: snapshot the current cumulative AFTER the swap so the next conversion
            // computes the TWAP across the full intervening period.
            lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});
        } else {
            // HIGH-4: invalidate any prior snapshot to force bootstrap on next 2-hop.
            if (lastConversionSnapshot[token].timestamp != 0) {
                lastConversionSnapshot[token] = PriceSnapshot({timestamp: 0, cumulative: 0});
            }
        }

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
        // AUDIT SFR-M-02 (MEDIUM, 2026-04-28): see convertTokenFeesToETH above. Note we
        // gate against accumulated bookkeeping rather than balanceOf to keep the rule
        // consistent across both variants — a dust-laden balance triggered by a malicious
        // direct transfer is NOT enough to enter the cooldown either way.
        uint256 amount = accumulatedTokenFees[token];
        if (amount < MIN_TOKEN_FEE_FOR_CONVERSION) revert TokenFeesBelowMinimum();
        // AUDIT NEW-A5 (HIGH): shared cooldown across both variants so switching
        // between them doesn't bypass the rate limit.
        _enforceConversionCooldown(token);

        accumulatedTokenFees[token] = 0;

        // For FoT tokens we approve the actual on-hand balance because the contract may
        // hold less than `amount` after the input-side FoT haircut on prior accumulation.
        uint256 actualOnHand = IERC20(token).balanceOf(address(this));
        uint256 swapAmount = amount > actualOnHand ? actualOnHand : amount;
        if (swapAmount == 0) revert ZeroAmount();

        // AUDIT FIX: DEEP-R-H01 — same multi-hop bypass as the non-FoT variant above.
        // Multi-hop is owner-only via `_validateConversionPath`, so we trust the
        // caller-supplied `minETHOut` for those paths. Direct 2-hop retains TWAP.
        uint256 effectiveMin;
        uint256 currentCum;
        uint32 currentTs;
        if (path.length > 2) {
            // AUDIT FIX: DEEP-R2-M01 — same non-zero floor as the standard variant. See
            // convertTokenFeesToETH above for the full rationale; both entry points must
            // enforce identical multi-hop guards or an attacker can pick the unlocked door.
            // AUDIT FIX: DEEP-R3-M01 — anchor against `MIN_MULTIHOP_ETH_OUT_WEI` to close
            // the `minETHOut = 1` bypass (mirrors convertTokenFeesToETH above).
            if (minETHOut < MIN_MULTIHOP_ETH_OUT_WEI) revert ZeroMinOut();
            effectiveMin = minETHOut;
            emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
        } else {
            // AUDIT SFR-H-01: TWAP-floor minETHOut sized against the actual swap input. Caller
            // can only TIGHTEN the floor; bootstrap is owner-only (see helper).
            (effectiveMin, currentCum, currentTs) =
                _enforceTWAPMinETHOut(token, swapAmount, minETHOut);
        }

        IERC20(token).forceApprove(address(router), swapAmount);

        uint256 ethBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            swapAmount, effectiveMin, path, address(this), deadline
        );
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(router), 0);

        // AUDIT FIX: DEEP-R-H01 — only snapshot for direct 2-hop swaps; multi-hop
        // has no direct-pair anchor so leave any prior snapshot untouched.
        // AUDIT FIX HIGH-4: see convertTokenFeesToETH above for the multi-hop drift
        // rationale. Mirroring the same invalidation here keeps both variants in lockstep.
        if (path.length == 2) {
            // SFR-H-01: snapshot the current cumulative AFTER the swap so the next conversion
            // (either variant) computes the TWAP across the full intervening period.
            lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});
        } else {
            if (lastConversionSnapshot[token].timestamp != 0) {
                lastConversionSnapshot[token] = PriceSnapshot({timestamp: 0, cumulative: 0});
            }
        }

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
    /// @dev    AUDIT FIX: DEEP-R-H02 — pause coverage was added in 1bcbb72 to keep
    ///         downstream contracts safe during incident response.
    /// @dev    AUDIT FIX: DEEP-R2-M02 — pause coverage REMOVED from this function only.
    ///         The H02 vector ("MEV searcher front-runs pause to push ETH at a
    ///         mid-incident downstream contract") applies to `distributeFeesToStakers`,
    ///         which steers fresh ETH at chosen destinations and DOES retain
    ///         `whenNotPaused`. This function only sends ALREADY-QUEUED ETH back to the
    ///         ORIGINAL queued recipient — the destination was chosen at queue time,
    ///         before the incident, so there is no mid-incident attacker steering. Adding
    ///         pause coverage here turned the queue into an owner-key-compromise weapon:
    ///         a captured key calling `pause()` indefinitely could freeze every queued
    ///         slice (stakers, POL, ...) for the entire 7-day admin-rotation window. The
    ///         pull pattern's value is exactly that the queue clears WITHOUT needing a
    ///         privileged action — restore that property.
    /// @dev    DEFERRED: DEEP-R-L01 — codehash-binding the queue entry would defend
    ///         against a CREATE2-redeployed successor at the same address, but the
    ///         finding's own conclusion is "low priority unless CREATE2 metaproxies
    ///         are introduced." Adding the storage layout change now would force a
    ///         migration on every existing pendingDistribution entry; deferring until
    ///         a real CREATE2 metaproxy use case lands.
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
    /// @dev AUDIT FIX: DEEP-R-H02 — `whenNotPaused` so a paused router cannot pull
    ///      callerCredit during incident response on a downstream splitter.
    /// @dev AUDIT FIX: DEEP-R-L03 — cooldown blocks tight grief loops that would
    ///      otherwise spam zero-amount events at ~2.5k gas per call. 30 s cap is
    ///      well below any realistic keeper cadence; an honest caller will never hit it.
    /// @dev AUDIT FIX: DEEP-R2-M03 — gate on the GLOBAL `lastCallerCreditAt` slot, not
    ///      the per-msg.sender mapping. Per-caller keying was bypassable by spawning N
    ///      EOAs and calling once each — the original grief loop survived. The single
    ///      global slot ensures every block-level loop costs the full cooldown window
    ///      regardless of how many sender keys the attacker controls.
    /// @dev AUDIT FIX: DEEP-R3-L01 — **DESIGN NOTE on the global cooldown trade-off.**
    ///      The global slot makes this a strict first-caller-wins per cooldown window.
    ///      An attacker who repeatedly wins the race can prevent honest keepers from being
    ///      the address recorded as `puller` in the `CallerCreditRecovered` event. CRITICAL
    ///      FACTS that bound this grief vector:
    ///        1. The recovered ETH ALWAYS flows to `accumulatedETHFees` (this contract),
    ///           regardless of `msg.sender`. The protocol's funds are never at risk.
    ///        2. The cooldown only sticks on a SUCCESSFUL pull. If the splitter has no
    ///           credit to release (`NothingToClaim`), the entire transaction reverts AND
    ///           `lastCallerCreditAt` is rolled back — so the attacker cannot even trigger
    ///           the cooldown without paying the full pull cost (~62k gas).
    ///        3. There is no economic incentive: the attacker spends gas to be named in
    ///           the event but receives no ETH. Pure griefing intent only.
    ///      The trade-off vs the per-caller mapping: per-caller allows multiple honest
    ///      keepers to operate independent windows but is bypassable by N-EOA spam (the
    ///      pre-DEEP-R2-M03 behaviour). The global slot is strictly less keeper-friendly
    ///      but provides a hard rate-limit that no key-spam can defeat. The architecturally
    ///      cleaner alternative — a `pendingCallerCredit(address) view` probe on the splitter
    ///      so callers can short-circuit when there's nothing to pull — is deferred as an
    ///      out-of-cluster change (see audit DEEP-R3-L01 recommendation (a)).
    function recoverCallerCredit() external nonReentrant whenNotPaused {
        require(address(referralSplitter) != address(0), "NO_SPLITTER");
        uint256 lastPull = lastCallerCreditAt;
        if (lastPull != 0 && block.timestamp < lastPull + RECOVER_CALLER_CREDIT_COOLDOWN) {
            revert RecoverCallerCreditCooldown();
        }
        lastCallerCreditAt = block.timestamp;
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
    /// @dev    AUDIT SFR-L-02 (2026-04-28): the trust bound for this admin-only
    ///         pull is THREE-FOLD — (1) `onlyOwner` gates the caller, (2)
    ///         `nonReentrant` blocks re-entry from the splitter callback, (3)
    ///         the only state-affecting effect on this contract's accounting
    ///         is `accumulatedETHFees += recovered`, which is the same accounting
    ///         lane every other ETH-ingress path (legitimate fees, conversion
    ///         refunds, dust sweeps) already feeds. Even if a malicious owner
    ///         called this against a hostile splitter, the worst outcome is
    ///         that the splitter returns less ETH than expected — never that
    ///         it can siphon out of this contract.
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
        // AUDIT FIX: DEEP-R-M02 — reject zero-address intermediate hops. A path like
        // `[token, address(0), WETH]` would otherwise pass duplicate checks; the
        // inner Uniswap router would compute `pairFor(token, address(0))` which
        // resolves to a deterministic empty address. For the FoT variant the
        // resulting zero output would silently zero the accumulated fee balance.
        // Owner-only multi-hop already implies trust, but this defends against
        // owner script errors / off-chain interpolation bugs.
        // AUDIT FIX: DEEP-R2-L01 — fold the zero-address-hop check into the same
        // outer loop as the duplicate check so 4-hop owner-only paths walk the
        // index range once instead of twice. Equivalent semantics, ~600 gas saved
        // per call (twice per `convertTokenFeesToETH{,FoT}` workflow).
        for (uint256 i = 0; i < len; i++) {
            if (i > 0 && i < len - 1 && path[i] == address(0)) revert InvalidConversionPath();
            // Reject duplicates (also catches `[token, WETH, WETH]` and similar shapes).
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
        // PASS7-SFR-05 FIX: refuse to compute a TWAP floor while an L2
        // sequencer outage is in progress OR within the post-resume grace
        // window. The 1h CONVERSION_COOLDOWN is NOT sufficient on its own —
        // the per-token TWAP integrates `prev.timestamp → currentTs` which
        // can straddle an outage even if both endpoints are post-resume.
        // Without this gate, the first post-resume conversion call would
        // anchor `effectiveMin` against pre-outage manipulated reserves.
        // address(0) sequencerFeed (mainnet) = no-op. Mirrors the gate at
        // POLAccumulator._twapMinOut.
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);

        // Resolve the pair + read the current cumulative (with idle-window bridge).
        (, currentCum, currentTs) = _readCurrentCumulative(token);

        PriceSnapshot memory prev = lastConversionSnapshot[token];

        // PASS7-SFR-05 FIX: even if the sequencer is currently up, refuse if
        // the prior snapshot's timestamp predates the resume + grace — the
        // TWAP integral would still cross the outage window. resumeAt == 0
        // (mainnet, address(0) feed) short-circuits this comparison.
        if (sequencerFeed != address(0)) {
            uint256 resumeAt = SequencerCheck.getResumeTimestamp(sequencerFeed);
            if (resumeAt != 0 && prev.timestamp != 0 && uint256(prev.timestamp) < resumeAt + SEQUENCER_GRACE_PERIOD) {
                revert TWAPBootstrapRequired();
            }
        }
        // Note: only the direct token/WETH 2-hop path reaches this function
        // (multi-hop paths are diverted in the callsites — see DEEP-R-H01).
        // So the TWAP anchor against `uniFactory.getPair(token, WETH)` matches
        // exactly what the swap will trade through.
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

    /// @dev AUDIT SFR-L-01 (2026-04-28): bare `receive()` accepts ETH from any
    ///      sender without any per-transfer accounting (no `accumulatedETHFees`
    ///      bump here). The TRUST BOUND is that the legitimate ingress paths
    ///      —`distribute()` callers, the WETH unwrap inside conversion, the
    ///      Uniswap V2 router refund — already account for what they push into
    ///      `accumulatedETHFees` themselves. Anything else that lands here
    ///      (donations, accidental sends, mistransferred refunds) becomes
    ///      "unaccounted" balance that gets distributed proportionally on the
    ///      next `distribute()` along with the legitimate fee balance. The
    ///      forward-distribute flow itself is `nonReentrant` and only callable
    ///      after a 24-hour cooldown, which is the actual safety bound.
    /// @dev AUDIT FIX (pass-8 batch-18): track cumulative ETH ingress so
    ///      off-chain monitoring can reconcile `address(this).balance`
    ///      against `accumulatedETHFees`. Any drift between
    ///      `totalETHReceived` and the sum of accounted fee categories is
    ///      "donated" / accidental ETH that the next `distribute()` will
    ///      sweep proportionally. Counter is monotonic and never decremented
    ///      — distribution outflows are tracked separately on the receiving
    ///      contracts (RevenueDistributor / ReferralSplitter / POLAccumulator).
    uint256 public totalETHReceived;
    event ETHReceived(address indexed sender, uint256 amount);
    receive() external payable {
        totalETHReceived += msg.value;
        emit ETHReceived(msg.sender, msg.value);
    }
}
