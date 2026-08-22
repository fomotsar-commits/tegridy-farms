// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title TegridyPair — Constant Product AMM Pool
/// @notice Fork of Uniswap V2 Pair adapted for Solidity 0.8.26.
///         Each pair holds two tokens and facilitates swaps using x*y=k formula.
///
///         Fee structure:
///         - 0.3% total fee on every swap (3/1000)
///         - 5/6 (~0.25%) goes to LPs (via accumulated reserves)
///         - 1/6 (~0.05%) goes to protocol (feeTo address, ~16.7% of total fees)
///
///         LP tokens (this contract is also an ERC20) represent share of pool.
///
/// @dev AUDIT R014 (oracle layer, Wave-014): TWAP cumulative price accumulators are now
///      implemented in `_update()` using the canonical Uniswap V2 pattern (UQ112x112 fixed-point,
///      intentional unchecked overflow wrapping). `price0CumulativeLast` / `price1CumulativeLast`
///      are read by `TegridyTWAP.update()` so the oracle stops sampling spot reserves only at
///      observation cadence and instead receives the integral of price over wall-clock time.
///      This closes the "stale-pair drift" footgun where an idle pair's TWAP could lag the spot
///      price for an entire MIN_PERIOD between updates.
/// @dev AUDIT NOTE #65: EIP-2612 permit is not supported on LP tokens. Adding permit would require
///      inheriting ERC20Permit, which is deferred to a future version to avoid redeployment risk.
/// @dev AUDIT FIX C-01/C-02: Removed decimal normalization entirely. K-invariant now uses raw
///      reserves exactly like Uniswap V2, eliminating normalization inconsistency between swap()
///      and mint()/burn().
/// @dev AUDIT FIX (critique 5.6 / battle-tested): blockTimestampLast is now written on every
///      _update() for Uniswap V2 interface parity. Third-party integrators performing freshness
///      checks against this timestamp work correctly.
/// @dev SECURITY NOTE: ERC-777 tokens and tokens with transfer callbacks are NOT supported.
///      The swap() function follows the Uniswap V2 pattern of transferring tokens out before
///      updating reserves. While nonReentrant prevents re-entering THIS pair, tokens with
///      transfer hooks could callback into other protocol contracts (router, other pairs) using
///      stale reserve state. Only use standard ERC-20 tokens without transfer callbacks.
/// @dev SECURITY NOTE: Fee-on-transfer tokens are NOT supported. The router does not have
///      dedicated *SupportingFeeOnTransferTokens variants. Using FoT tokens will cause reverts
///      or silent value loss.
contract TegridyPair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bool private _initialized;

    address public factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    /// @dev AUDIT FIX (critique 5.6): tracks the last _update() timestamp for Uniswap V2
    ///      interface parity. Updated on every mint/burn/swap/sync.
    uint32 public blockTimestampLast;

    uint256 public kLast; // reserve0 * reserve1, as of immediately after the most recent liquidity event

    /// @notice AUDIT R014 (oracle layer, Wave-014): Uniswap V2-style cumulative price
    ///         accumulators. Each is the integral of the spot price (UQ112x112 fixed-point)
    ///         over wall-clock seconds since pair creation, with intentional uint256
    ///         overflow wrapping (the canonical V2 pattern — consumers compute differences,
    ///         which remain correct modulo 2^256). Read by `TegridyTWAP` to compute time-
    ///         weighted prices that include intra-update drift, so a long-idle pair cannot
    ///         carry a stale spot price into the oracle.
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    /// @notice AUDIT R016 M-1 (MEDIUM): wall-clock timestamp of the last successful
    ///         `harvest()` call, used to enforce the `HARVEST_INTERVAL` rate-limit gate
    ///         below. Permissionless `harvest()` would otherwise be MEV-front-runnable
    ///         (a searcher can sandwich the transaction to capture the protocol fee
    ///         dilution); the 5-minute cadence makes the resulting profit per attempt
    ///         smaller than the searcher's gas + priority fee in any realistic
    ///         block-space market while still letting keepers materialise the protocol
    ///         fee on a tight cadence on hot pairs. The 1/6th protocol-fee share also
    ///         caps the MEV upside structurally — see `harvest()` NatSpec.
    uint256 public lastHarvestAt;
    uint256 public constant HARVEST_INTERVAL = 5 minutes;

    /// @dev AUDIT R014: UQ112x112 scale factor matching Uniswap V2. Used inside `_update()`
    ///      to express `reserveOther / reserveThis` as a uint224 fixed-point number that
    ///      fits inside the uint256 cumulative slot when multiplied by `timeElapsed`.
    uint256 private constant Q112 = 2 ** 112;

    uint256 private constant MINIMUM_LIQUIDITY = 1000;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);
    event Skim(address indexed to, uint256 amount0, uint256 amount1);
    /// @dev AUDIT FIX L-04: Emit event from initialize() for off-chain indexers.
    event Initialize(address indexed token0, address indexed token1);
    /// @dev AUDIT FIX F-31-F (FRESH-EYES 2026-05): dedicated `harvest()` event so off-chain
    ///      monitoring can distinguish the harvest materialisation path from incidental
    ///      `_mintFee` accrual fired by `mint()`/`burn()`. `lpMinted` is the protocol-fee
    ///      LP minted on this call (zero for bootstrap/cleanup branches); `kLastNew` is
    ///      the post-call `kLast` value (zero on cleanup, non-zero on bootstrap or normal).
    event ProtocolFeeHarvested(address indexed caller, uint256 lpMinted, uint256 kLastNew);

    /// @dev AUDIT FIX F-31-E (FRESH-EYES 2026-05): explicit revert for the rebase-induced
    ///      empty-reserve state. Replaces silent panic-on-divide-by-zero in `mint()`.
    error ReservesZeroPostRebase();

    constructor() ERC20("Tegridy LP", "TGLP") {
        factory = msg.sender;
    }

    /// @dev AUDIT FIX L-04: Emits Initialize event.
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "FORBIDDEN");
        require(!_initialized, "ALREADY_INITIALIZED");
        require(_token0 != address(0) && _token1 != address(0), "ZERO_ADDRESS"); // AUDIT FIX L-38
        _initialized = true;
        token0 = _token0;
        token1 = _token1;
        emit Initialize(_token0, _token1);
    }

    /// @notice Returns the current reserve balances and last update timestamp.
    /// @dev AUDIT FIX (critique 5.6 / battle-tested): _blockTimestampLast is the timestamp of
    ///      the last _update() call (Uniswap V2 parity). Integrators performing freshness checks
    ///      against this value work correctly.
    /// @dev AUDIT R014: cumulative price accumulators are now exposed as
    ///      `price0CumulativeLast()` / `price1CumulativeLast()` and updated inside `_update()`.
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ─── Mint LP tokens ───────────────────────────────────────────────

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        // SECURITY FIX M-1: Block minting on disabled/blocked pairs (matching swap() lines 165-167).
        // Without this, users can add liquidity to dead pairs and lose their tokens.
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        // AUDIT NEW-A10 (MEDIUM): refuse mint-to-self. Historically Uniswap V2 left
        // this unchecked, creating a known footgun: a caller who passes the pair's
        // own address as `to` deposits LP tokens into the pair itself, which any
        // attacker can then drain via `burn(attacker)` (since `burn` reads the
        // pair's own LP balance). Router always supplies `to = msg.sender` or an
        // EOA, but direct-pair integrators can footgun themselves. Matches the
        // existing `burn(to)` INVALID_TO guard for symmetry.
        require(to != address(0) && to != address(this), "INVALID_TO");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();

        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (_totalSupply == 0) {
            require(amount0 >= 1000 && amount1 >= 1000, "MIN_INITIAL_TOKENS");
            // AUDIT FIX C-01: Use raw amounts (no normalization), exactly like Uniswap V2.
            uint256 rawLiquidity = FixedPointMathLib.sqrt(amount0 * amount1);
            // Require initial liquidity to be at least 1000x MINIMUM_LIQUIDITY to make
            // first-depositor inflation attacks economically infeasible.
            require(rawLiquidity > MINIMUM_LIQUIDITY * 1000, "INSUFFICIENT_INITIAL_LIQUIDITY");
            liquidity = rawLiquidity - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // Lock minimum liquidity
        } else {
            // AUDIT FIX F-31-E (FRESH-EYES 2026-05): rebase-token + sync() can drive
            // reserves to 0 while totalSupply > 0. Pre-fix the divisions below would
            // panic with division-by-zero. Reverting with a typed error makes the
            // off-chain monitoring path obvious and burn() remains available for exits.
            // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
            // slither-disable-next-line incorrect-equality
            if (_reserve0 == 0 || _reserve1 == 0) revert ReservesZeroPostRebase();
            uint256 liq0 = (amount0 * _totalSupply) / _reserve0;
            uint256 liq1 = (amount1 * _totalSupply) / _reserve1;
            liquidity = liq0 < liq1 ? liq0 : liq1;
        }

        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1);
        // AUDIT FIX C-02: kLast stores raw reserve0 * reserve1 (no normalization).
        // AUDIT FIX F-31-A / H-7 (FRESH-EYES 2026-05): only update `kLast` here when
        // it was already non-zero. Pre-fix, this line bootstrapped `kLast` from 0 on
        // any feeOn-enabled mint() — defeating the `harvest()` bootstrap-anchoring
        // gate (line 402) which restricts the FIRST `kLast` write to feeToSetter.
        // After the fix, `kLast` is bootstrapped EXCLUSIVELY through `harvest()`,
        // and mint()/burn() merely refresh the baseline on subsequent interactions.
        // AUDIT FIX F-31-B / M-23 (FRESH-EYES 2026-05): additionally skip the
        // refresh while the pair is `disabledPairs`-flagged. mint() already gates
        // disabledPairs at the top, so this guard is double-defence; burn() (which
        // intentionally does NOT gate disabledPairs to preserve LP exit) carries
        // the same skip below.
        if (feeOn && kLast != 0 && !ITegridyFactory(factory).disabledPairs(address(this))) {
            kLast = uint256(reserve0) * uint256(reserve1);
        }

        emit Mint(msg.sender, amount0, amount1);
    }

    // ─── Burn LP tokens ───────────────────────────────────────────────

    // AUDIT NOTE M-02: Read-only reentrancy window exists between token transfers and _update().
    // External contracts should not rely on getReserves() during callbacks.
    /// @dev AUDIT FIX L-01: Added `to` address validation.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(to != address(0) && to != address(this), "INVALID_TO");

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintFee(reserve0, reserve1);
        uint256 _totalSupply = totalSupply();

        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "INSUFFICIENT_LIQUIDITY_BURNED");

        _burn(address(this), liquidity);

        // AUDIT FIX M-02: Update reserves BEFORE outbound transfers (CEI pattern).
        // Prevents read-only reentrancy where a token callback reads stale getReserves().
        _update(balance0 - amount0, balance1 - amount1);
        // AUDIT FIX F-31-A / H-7 (FRESH-EYES 2026-05): only refresh `kLast` when
        // it was already non-zero. burn() must NEVER bootstrap `kLast` from 0 — the
        // sole bootstrap path is `harvest()` (gated to feeToSetter). Pre-fix, an
        // attacker holding minimal LP could donate tokens and call burn() to anchor
        // `kLast` at a manipulated K, suppressing protocol _mintFee accrual until
        // natural K growth caught up.
        // AUDIT FIX F-31-B / M-23 (FRESH-EYES 2026-05): additionally skip the
        // refresh while the pair is `disabledPairs`-flagged. burn() intentionally
        // remains callable on disabled pairs (LP exit), but the kLast refresh would
        // re-anchor protocol fee accounting at the post-disable (potentially
        // donation-skewed) reserves. Skipping the write keeps the pre-disable
        // baseline intact for re-enable.
        if (feeOn && kLast != 0 && !ITegridyFactory(factory).disabledPairs(address(this))) {
            kLast = uint256(reserve0) * uint256(reserve1);
        }

        // Transfer tokens AFTER reserves are updated
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);

        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ─── Swap ─────────────────────────────────────────────────────────

    /// @dev AUDIT FIX L-02: Added `to` address validation (address(0) and address(this)).
    /// @dev AUDIT NOTE M-04 (router): The `bytes calldata` param is unused but kept for
    ///      interface compatibility with Uniswap V2 (flash swap callback pattern).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external nonReentrant {
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        // AUDIT FIX L-05: Check blockedTokens at swap time, not just pair creation
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        // AUDIT FIX: Flash swaps are not supported — reject non-empty callback data
        require(data.length == 0, "NO_FLASH_SWAPS");
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        // AUDIT NEW-I4 (INFO): distinct error messages so off-chain indexers can tell
        // which branch tripped without pattern-matching revert data.
        require(to != address(0) && to != address(this), "INVALID_TO_ZERO_OR_SELF");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "INSUFFICIENT_LIQUIDITY");

        // SECURITY FIX H-01: Verify input tokens arrived BEFORE transferring output.
        // Read balances to compute amountIn from pre-transfer state, validate K-invariant,
        // and update reserves BEFORE any outbound transfers (checks-effects-interactions).
        // This prevents ERC-777 / callback tokens from reading stale reserves via getReserves().
        // AUDIT FIX F-31-D (FRESH-EYES 2026-05): only block `to` when it matches the OUTPUT
        // token. Pre-fix the check was unconditional, rejecting legitimate integrations
        // whose recipient address coincided with the INPUT token contract address (e.g.
        // a re-investment bot deployed at the input token's address). The defence-in-depth
        // intent (don't send a token to its own contract) only applies to the output side.
        if (amount0Out > 0) require(to != token0, "INVALID_TO_IS_TOKEN");
        if (amount1Out > 0) require(to != token1, "INVALID_TO_IS_TOKEN");

        // Compute expected post-swap balances to derive input amounts
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        uint256 amount0In = balance0 > _reserve0 ? balance0 - _reserve0 : 0;
        uint256 amount1In = balance1 > _reserve1 ? balance1 - _reserve1 : 0;
        require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");

        // Compute post-swap balances (after output is transferred)
        uint256 postBalance0 = balance0 - amount0Out;
        uint256 postBalance1 = balance1 - amount1Out;

        // AUDIT FIX C-01: K-invariant check uses raw reserves (no normalization),
        // exactly like Uniswap V2.
        {
            uint256 balance0Adjusted = postBalance0 * 1000 - amount0In * 3; // 0.3% = 3/1000
            uint256 balance1Adjusted = postBalance1 * 1000 - amount1In * 3;
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * uint256(_reserve1) * 1000000,
                "K"
            );
        }

        // SECURITY FIX H-01: Update reserves BEFORE transfers (CEI pattern).
        // Prevents cross-contract reentrancy via ERC-777 transfer callbacks
        // reading stale getReserves() on other pairs/router.
        _update(postBalance0, postBalance1);

        // Transfer output tokens AFTER reserves are updated
        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);

        // AUDIT NEW-A1 (CRITICAL): reject fee-on-transfer output tokens that would
        // desync reserves from actual balances. Prior to this check, an FoT output
        // token could deduct an extra internal fee during the safeTransfer above, so
        // actual balance < predicted reserve. Every subsequent swap would then compute
        // `amount_In = balance > reserve ? balance - reserve : 0 = 0` while the K-check
        // used the inflated `_reserve`, undercharging the input side and letting
        // arbitrage bots slow-drain the pair. Factory's _rejectERC777 is a best-effort
        // creation-time gate only; post-creation token upgrades can flip a token to FoT
        // mode. This per-swap balance check catches that case and reverts cleanly.
        // AUDIT FIX 2026-05-16 M13: loosen from strict equality `==` to `>=`. The
        // require catches the dangerous case — pair balance LESS than expected
        // (sender-side fee-on-transfer that silently consumed our reserves). It
        // no longer rejects the benign case — pair balance GREATER than expected
        // (concurrent-tx donation, selfdestruct force-feed, or atomic-routing
        // aggregator that legitimately top-ups the pair in the same tx). Pre-fix,
        // the strict equality blocked any composability flow that landed extra
        // tokens at the pair, without adding any FoT-detection value (sender-FoT
        // still underflows balance and trips the `>=`). K-invariant is
        // independently checked above using the post-balance, so donated dust
        // doesn't loosen swap accounting beyond the gift itself.
        require(IERC20(token0).balanceOf(address(this)) >= postBalance0, "FOT_OUTPUT_0");
        require(IERC20(token1).balanceOf(address(this)) >= postBalance1, "FOT_OUTPUT_1");

        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // ─── Skim & Sync ──────────────────────────────────────────────────

    /// @notice AUDIT FIX H-01: Force balances to match reserves by sending excess to `to`.
    /// @dev AUDIT NOTE M-05: skim() is permissionless (matches Uniswap V2). Tokens sent to the
    ///      pair in a separate transaction (not via Router) can be skimmed by anyone before mint().
    ///      Always use the Router for atomic transfers + mints. Direct pair interaction is unsafe.
    /// @dev AUDIT FIX D-AMM-H2: gate skim() behind `disabledPairs` / `blockedTokens`
    ///      checks. A permissionless skim against a disabled pair could be paired with
    ///      attacker-donated balances to set up the cumulative-poisoning attack
    ///      described in D-AMM-H2 (donation primitive — once the disabled pair is
    ///      re-enabled, the next TWAP update integrates the manipulated reserves).
    function skim(address to) external nonReentrant {
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        require(to != address(0) && to != address(this), "INVALID_TO");
        address _token0 = token0;
        address _token1 = token1;
        uint256 amount0 = IERC20(_token0).balanceOf(address(this)) - reserve0;
        uint256 amount1 = IERC20(_token1).balanceOf(address(this)) - reserve1;
        if (amount0 > 0) IERC20(_token0).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(_token1).safeTransfer(to, amount1);
        // AUDIT FIX H-16: Emit event for off-chain monitoring
        emit Skim(to, amount0, amount1);
    }

    /// @notice AUDIT FIX H-02: Force reserves to match balances.
    /// @dev AUDIT FIX D-AMM-H2: gate sync() behind `disabledPairs` / `blockedTokens`
    ///      checks. Without this, an attacker can donate tokens to a disabled pair,
    ///      call `sync()` to integrate the donation-skewed spot into the pair's
    ///      cumulative price accumulator, then wait for the pair to be re-enabled —
    ///      the very next TegridyTWAP.update() reads the poisoned cumulative as a
    ///      legitimate observation. Pattern: every Uniswap V2 fork with a "kill
    ///      switch" gates state-mutating sync paths behind the same circuit-breaker
    ///      as swap/mint/burn.
    function sync() external nonReentrant {
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    /// @notice AUDIT NEW-A7 (MEDIUM): permissionless mint-fee harvest. `_mintFee` runs
    ///         only inside `mint()` / `burn()`. On a hot pair with heavy swap volume
    ///         but no LP churn, the 1/6th mint-fee share accrues as K growth that
    ///         never materialises as protocol LP tokens — the treasury earns $0
    ///         despite the fee being built into the K-invariant. This permissionless
    ///         helper runs `_mintFee` + updates `kLast` so the protocol's LP share
    ///         materialises without waiting for a liquidity event. Balancer V2 /
    ///         Curve both use the same pattern (`claim_admin_fees()`).
    /// @dev    AUDIT R016 M-1 (MEDIUM): `harvest()` is permissionless and structurally
    ///         front-runnable for MEV — a searcher could sandwich the call to capture
    ///         the dilution from the protocol's freshly-minted LP tokens. The MEV upside
    ///         is bounded TWO ways:
    ///           1. The protocol fee is only 1/6th of the 0.3% swap fee (~0.05% of
    ///              swap volume), so the per-call dilution searcher can extract is tiny
    ///              relative to typical sandwich gas + priority-fee costs.
    ///           2. The `HARVEST_INTERVAL` gate (5 minutes) caps the call cadence, so
    ///              even if a searcher were profitable on a single call, the recurring
    ///              extraction surface is bounded to ~12 calls/hour per pair.
    ///         The combination makes harvest-MEV uneconomic on any realistic pair:
    ///         honest keepers (or the protocol itself) can simply call `harvest()` at
    ///         the gate cadence and capture the fee.
    /// @dev    Reverts `HARVEST_TOO_SOON` if called before `lastHarvestAt + HARVEST_INTERVAL`.
    function harvest() external nonReentrant {
        // AUDIT FIX V2-AMM-M4: parity with mint/swap/sync/skim — `harvest()`
        // is also a state-mutating path that calls into `_mintFee` and writes
        // `kLast`. Without these gates, a disabled / blocked-token pair could
        // still have its protocol-fee LP materialised, which (via feeTo)
        // re-introduces the disabled pair to the protocol's accounting. The
        // microscope's M-AMM1 explicitly required this gate; the prior
        // remediation report claimed it landed but the source did not contain
        // the check. Closes that persistent regression.
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
        // AUDIT FIX D-AMM-M2: only bump `lastHarvestAt` after a fee was actually
        // materialised (totalSupply increased). Previously the timestamp was bumped
        // unconditionally — a griefer could call harvest() exactly at the cadence
        // boundary on a pair where `_mintFee` mints zero (rootK == rootKLast, or
        // numerator/denominator rounds to zero between two close-cadence calls) and
        // permanently lock legitimate keepers out of the 5-minute window with
        // HARVEST_TOO_SOON. Pattern: Curve `claim_admin_fees()` aborts on zero-mint
        // without state mutation.
        // AUDIT FIX V3-AMM-INFO1: zero-reserve pair can't materialise any fee
        // and would loop in no-op harvests indefinitely. Reject early.
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(_reserve0 != 0 && _reserve1 != 0, "EMPTY_PAIR");
        uint256 supplyBefore = totalSupply();
        // AUDIT FIX V3-AMM-M1: capture kLast pre-mintFee so we can detect the
        // `feeOn = false && kLast was non-zero` cleanup path. `_mintFee` writes
        // `kLast = 0` in that case (Uniswap V2 cleanup semantic) — without
        // tracking the pre-state, the post-fix `NO_FEE_TO_MATERIALIZE` revert
        // unwinds the cleanup write.
        uint256 kLastBefore = kLast;
        bool feeOn = _mintFee(_reserve0, _reserve1);
        // AUDIT FIX V2-AMM-M2: allow the bootstrap-only path through.
        //
        // DELICATE DISTINCTION: `_mintFee` mints zero LP in two distinct cases:
        //   (a) Bootstrap: `feeOn == true` but `kLast == 0`. The inner
        //       `if (_kLast != 0)` guard short-circuits, no LP mints. This is
        //       the FIRST harvest after `feeTo` was enabled on a previously
        //       fee-disabled pair — `kLast` MUST be set here so subsequent
        //       harvests have a baseline to measure K-growth against.
        //   (b) No-growth: `feeOn == true` and `kLast != 0` and either
        //       `rootK <= rootKLast` (K shrunk or stayed flat) or
        //       `numerator / denominator` rounded to zero. No LP mints; no
        //       state change is needed (the prior `kLast` is still correct).
        //
        // The pre-D-AMM-M2 code conflated (a) and (b) and silently advanced
        // `lastHarvestAt` in both, which created the griefing surface. Strict
        // `totalSupply() > supplyBefore` (post-fix) blocked (b) correctly but
        // also blocked (a) — leaving the protocol unable to bootstrap `kLast`
        // via harvest. The `bootstrap` flag below distinguishes them: only (a)
        // bypasses the revert, and `kLast` is then written below to seed the
        // baseline. (b) still reverts as before.
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        bool bootstrap = (feeOn && kLast == 0);
        // FRESH-EYES M-2: bootstrap is the moment kLast is FIRST written (or re-written
        // after a fee-cleanup cycle). Public callers can flash-loan-manipulate reserves
        // immediately before harvest to anchor kLast at an inflated K, suppressing the
        // protocol's _mintFee accrual until natural K growth catches up. Restrict to
        // feeToSetter so only governance can establish the baseline. The `cleanup` and
        // normal-fee-mint paths remain permissionless: cleanup zeroes kLast (no manipulation
        // benefit), normal-fee-mint only increments LP if K actually grew.
        // Pattern: same authority that controls feeTo also controls bootstrap. No griefing
        // surface introduced — keepers continue to hit the normal path on every interval.
        if (bootstrap && msg.sender != ITegridyFactory(factory).feeToSetter()) {
            revert("HARVEST_BOOTSTRAP_GATED");
        }
        // AUDIT FIX V3-AMM-M1: also allow the cleanup path (feeOn went false
        // while kLast was non-zero — `_mintFee` already cleared kLast). Without
        // this, the require would unwind the cleanup write and the pair would
        // permanently retain a stale kLast through every subsequent
        // harvest-after-feeOn-disable.
        bool cleanup = (!feeOn && kLastBefore != 0);
        require(totalSupply() > supplyBefore || bootstrap || cleanup, "NO_FEE_TO_MATERIALIZE");
        lastHarvestAt = block.timestamp;
        uint256 supplyAfter = totalSupply();
        uint256 lpMinted = supplyAfter > supplyBefore ? supplyAfter - supplyBefore : 0;
        if (feeOn) {
            kLast = uint256(_reserve0) * uint256(_reserve1);
        }
        // AUDIT FIX F-31-F (FRESH-EYES 2026-05): dedicated harvest event so off-chain
        // monitoring can distinguish protocol-fee materialisation via this path from
        // incidental `_mintFee` accrual fired by mint()/burn(). `kLast` is read AFTER
        // any bootstrap/cleanup write so the event reports the post-call value.
        emit ProtocolFeeHarvested(msg.sender, lpMinted, kLast);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev Update reserves. Balances are truncated to uint112 (max ~5.19e33).
    ///      Tokens with supply exceeding uint112.max are not supported.
    /// @dev AUDIT FIX (critique 5.6 / battle-tested): blockTimestampLast is written on every
    ///      update for Uniswap V2 interface parity.
    /// @dev AUDIT R014 (oracle layer, Wave-014): cumulative price accumulators are integrated
    ///      using the PRE-update reserves × elapsed seconds. This is the canonical Uniswap V2
    ///      pattern — the cumulative records the time-weighted spot price *between the previous
    ///      _update() and now*, which is exactly the integrand TegridyTWAP needs to subtract
    ///      across two observations to derive the time-weighted average. Math performed in
    ///      `unchecked` so the uint256 cumulative wraps modulo 2^256, matching V2 semantics —
    ///      consumers always work with differences, which remain correct under modular wrap.
    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "OVERFLOW");

        // AUDIT R014: capture pre-update reserves and integrate cumulative prices.
        // `_reserveOther / _reserveThis` is the spot price at t = blockTimestampLast,
        // and we multiply by the elapsed seconds since that timestamp to add the
        // rectangular integral contribution to the cumulative.
        uint32 _blockTimestamp = uint32(block.timestamp);
        uint32 timeElapsed;
        unchecked {
            // uint32 modular subtraction (Uniswap V2 pattern) — wrap-safe across the
            // year-2106 timestamp rollover.
            timeElapsed = _blockTimestamp - blockTimestampLast;
        }
        uint112 _reserve0 = reserve0;
        uint112 _reserve1 = reserve1;
        if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
            unchecked {
                // Each `(uint256(other) * Q112) / this` fits in uint224 (≤ ~2^224 since
                // reserves are uint112). Multiplying by uint32 timeElapsed stays well
                // under uint256 for any realistic interval, but we keep the addition
                // `unchecked` to allow the canonical V2 wrapping accumulator semantics.
                // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
                // slither-disable-next-line divide-before-multiply
                price0CumulativeLast += (uint256(_reserve1) * Q112 / _reserve0) * timeElapsed;
                // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
                // slither-disable-next-line divide-before-multiply
                price1CumulativeLast += (uint256(_reserve0) * Q112 / _reserve1) * timeElapsed;
            }
        }

        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = _blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev Mint protocol fee: 1/6 (~16.7%) of total 0.3% fee goes to feeTo address.
    ///      LP providers keep 5/6 (~0.25%) of each swap fee.
    ///      Standard Uniswap V2 formula: numerator = totalSupply * (rootK - rootKLast),
    ///      denominator = rootK * 5 + rootKLast.
    /// @dev AUDIT FIX C-02: Uses raw reserves for rootK (no normalization).
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = ITegridyFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = FixedPointMathLib.sqrt(uint256(_reserve0) * uint256(_reserve1));
                uint256 rootKLast = FixedPointMathLib.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply() * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // Math: Solmate FixedPointMathLib.sqrt() — battle-tested in Uniswap V3/V4, Seaport
    // Transfers: OZ SafeERC20.safeTransfer() — industry standard
    // Min: inlined as ternary operator
}

interface ITegridyFactory {
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address); // FRESH-EYES M-2: gate harvest bootstrap
    function disabledPairs(address pair) external view returns (bool);
    function blockedTokens(address token) external view returns (bool); // AUDIT FIX L-05
}
