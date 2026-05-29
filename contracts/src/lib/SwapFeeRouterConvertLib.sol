// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SequencerCheck} from "./SequencerCheck.sol";
import {IWETH} from "./WETHFallbackLib.sol";

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

/// @notice Per-token snapshot of the Uniswap V2 cumulative price (token → WETH
///         direction) captured at the most recent successful conversion. Relocated
///         to file level (from inside SwapFeeRouter) during the EIP-170 split so the
///         linked conversion library below can take a `mapping(address => PriceSnapshot)
///         storage` pointer. Layout is byte-identical to the original in-contract
///         struct — the `lastConversionSnapshot` public-getter ABI is unchanged.
struct PriceSnapshot {
    uint32 timestamp;
    uint256 cumulative;
}

/// @title  SwapFeeRouterConvertLib
/// @notice EIP-170 split: the TWAP-gated token→ETH fee-conversion cluster extracted
///         from SwapFeeRouter into a linked (delegatecall) library. PURE SIZE
///         REDUCTION — behaviour is byte-for-byte identical to the original
///         in-contract functions.
///
///         Because the library is invoked via `delegatecall` it executes in the
///         caller's storage context (`address(this)` == SwapFeeRouter), so:
///           * token approvals/transfers and `router.swap*` proceeds move to/from
///             the router contract's balance exactly as before;
///           * `IWETH(weth).withdraw(...)` sends ETH to the router (triggering its
///             empty `receive()`), exactly as before;
///           * events emitted here carry the router's address as emitter (indexers
///             see no change);
///           * `msg.sender` is the router's external caller (preserved through
///             delegatecall), so the owner-only bootstrap / multi-hop gates compare
///             against the passed-in `cfg.owner`.
///
///         Storage marshalling pattern (proven by StakingRewardLib):
///           * mappings (`accumulatedTokenFees`, `lastConvertedAt`,
///             `lastConversionSnapshot`) are passed by `storage` reference so the
///             library reads & writes the caller's storage directly;
///           * the standalone scalar `accumulatedETHFees` cannot be passed by storage
///             reference, so it is passed BY VALUE and the new value RETURNED — the
///             caller writes it back through the single `accumulatedETHFees = lib(...)`
///             choke-point so a write-back can never be silently dropped;
///           * immutables (`router`, `WETH`, `uniFactory`), the one-shot
///             `sequencerFeed`, and `owner()` are not reachable from a delegatecall
///             lib, so they are passed in via the `Cfg` struct.
///
///         Events / errors are re-declared here with identical signatures so the
///         emitted topics and revert selectors are byte-identical to the originals.
library SwapFeeRouterConvertLib {
    using SafeERC20 for IERC20;

    // ─── Mirrored constants (must equal SwapFeeRouter's values) ─────────
    uint256 internal constant BPS = 10000;
    uint256 internal constant MAX_DEADLINE = 2 hours;
    uint256 internal constant CONVERSION_COOLDOWN = 1 hours;
    uint256 internal constant MIN_TWAP_PERIOD = 30 minutes;
    uint256 internal constant SEQUENCER_GRACE_PERIOD = 1 hours;
    uint256 internal constant MIN_TOKEN_FEE_FOR_CONVERSION = 1e18;
    uint256 internal constant MAX_CONVERSION_PATH_LENGTH = 4;
    uint256 internal constant TWAP_SAFETY_BPS = 150;
    uint256 internal constant MIN_MULTIHOP_ETH_OUT_WEI = 1e14;
    uint256 internal constant Q112_SFR = 2 ** 112;

    // ─── Errors (selectors identical to SwapFeeRouter's) ────────────────
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineTooFar();
    error InsufficientOutput();
    error TWAPBootstrapRequired();
    error NoPairForToken();
    error InvalidConversionPath();
    error MultiHopOwnerOnly();
    error TokenFeesBelowMinimum();
    error ZeroMinOut();

    // ─── Events (topics identical to SwapFeeRouter's) ───────────────────
    event TokenFeesConverted(address indexed token, uint256 tokenAmount, uint256 ethReceived);
    event ConversionTWAPFloor(
        address indexed token,
        uint256 effectiveMinETHOut,
        uint256 callerMinETHOut,
        bool bootstrap
    );

    /// @notice Read-only inputs the library needs that are not reachable from a
    ///         delegatecall context: the WETH/router/factory immutables, the one-shot
    ///         `sequencerFeed`, and the host's current `owner()`.
    struct Cfg {
        address weth;
        IUniswapV2Router02 router;
        ISwapFeeRouterUniFactory uniFactory;
        address sequencerFeed;
        address owner;
    }

    /// @notice Body of `SwapFeeRouter.convertTokenFeesToETH`. See the host NatSpec for
    ///         the full path/MEV/TWAP semantics. Returns the updated `accumulatedETHFees`
    ///         for the host to write back through its single choke-point.
    function convertTokenFeesToETH(
        mapping(address => uint256) storage accumulatedTokenFees,
        mapping(address => uint256) storage lastConvertedAt,
        mapping(address => PriceSnapshot) storage lastConversionSnapshot,
        Cfg memory cfg,
        uint256 accumulatedETHFeesIn,
        address token,
        address[] calldata path,
        uint256 minETHOut,
        uint256 deadline
    ) public returns (uint256 newAccumulatedETHFees) {
        newAccumulatedETHFees = accumulatedETHFeesIn;
        if (token == address(0)) revert ZeroAddress();
        // AUDIT FIX 2026-05-20 M4-REVISED: WETH unwrap path. `accumulatedTokenFees[WETH]`
        // populates from WETH-input swaps (input-side fee accumulation in
        // `swapExactTokensForTokens` and variants). This branch unwraps the WETH balance
        // directly into `accumulatedETHFees` so it flows through the standard
        // `distributeFeesToStakers` split. No swap (1:1 unwrap), no TWAP (no price
        // discovery needed), no cooldown (no MEV/sandwich vector on a fixed 1:1).
        if (token == cfg.weth) {
            uint256 wethAmount = accumulatedTokenFees[cfg.weth];
            if (wethAmount < MIN_TOKEN_FEE_FOR_CONVERSION) revert TokenFeesBelowMinimum();
            // CEI: zero accounting BEFORE the external withdraw call (which triggers
            // our `receive()` via the WETH contract's `address(this).call`). The
            // outer `nonReentrant` blocks re-entry, but CEI is belt-and-suspenders.
            accumulatedTokenFees[cfg.weth] = 0;
            IWETH(cfg.weth).withdraw(wethAmount);
            newAccumulatedETHFees += wethAmount;
            emit TokenFeesConverted(cfg.weth, wethAmount, wethAmount);
            return newAccumulatedETHFees;
        }
        // AUDIT NEW-A4 (HIGH): the inner Uniswap router catches expired deadlines,
        // but only AFTER our fee accumulation state writes have already happened for
        // the transaction. Add the explicit lower-bound check so the whole call reverts
        // cleanly at the boundary instead of relying on the inner router's revert.
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT SFR-M-01: validate caller-supplied path and gate multi-hop on owner.
        _validateConversionPath(cfg, token, path);
        // AUDIT SFR-M-02: refuse conversions on dust accumulation BEFORE the cooldown
        // stamp is updated, so a 1-wei trigger cannot brick the keeper's conversion.
        uint256 amount = accumulatedTokenFees[token];
        if (amount < MIN_TOKEN_FEE_FOR_CONVERSION) revert TokenFeesBelowMinimum();
        // AUDIT NEW-A5 (HIGH): rate-limit per-token conversions so a sandwich attacker
        // cannot repeatedly manipulate the pool and unwind for free.
        _enforceConversionCooldown(lastConvertedAt, token);

        // CEI: zero accounting BEFORE the swap so a malicious token's transfer hook can't
        // re-enter and double-spend the same accumulated balance.
        accumulatedTokenFees[token] = 0;

        // AUDIT FIX: DEEP-R-H01 — Multi-hop conversion paths (length > 2) bypass the
        // direct-pair TWAP floor because the token/WETH direct pair may not exist.
        // Multi-hop is already gated to `msg.sender == owner()` in
        // `_validateConversionPath`, so the trust assumption justifies falling back
        // to the caller-supplied `minETHOut` (plus the absolute / optional-TWAP floor).
        uint256 effectiveMin;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 currentCum;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint32 currentTs;
        if (path.length > 2) {
            // AUDIT FIX 2026-05-26 [H-03]: sequencer-uptime gate on multi-hop path.
            SequencerCheck.checkSequencerUp(cfg.sequencerFeed, SEQUENCER_GRACE_PERIOD);

            // AUDIT FIX DEEP-R2-M01 / DEEP-R3-M01: anchor against the absolute floor
            // `MIN_MULTIHOP_ETH_OUT_WEI` to close the `minETHOut = {0,1}` drain bypass.
            // AUDIT FIX 2026-05-26 [H-02]: when a direct token/WETH pair exists, ALSO
            // derive the TWAP-based floor and require the MAX of (TWAP, absolute, caller).
            uint256 effectiveFloor = MIN_MULTIHOP_ETH_OUT_WEI;
            bool directPairExists = cfg.uniFactory.getPair(token, cfg.weth) != address(0);
            if (directPairExists) {
                (uint256 twapMin, uint256 hopCurCum, uint32 hopCurTs) =
                    _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, amount, minETHOut);
                if (twapMin > effectiveFloor) effectiveFloor = twapMin;
                // Capture the snapshot data — invalidation logic at end of fn still applies
                currentCum = hopCurCum;
                currentTs = hopCurTs;
            }
            if (minETHOut < effectiveFloor) revert ZeroMinOut();
            effectiveMin = minETHOut > effectiveFloor ? minETHOut : effectiveFloor;
            // SELF-AUDIT FIX 2026-05-26 [H-02 NEW-1]: only emit ConversionTWAPFloor
            // when _enforceTWAPMinETHOut did NOT already emit (no-direct-pair branch).
            if (!directPairExists) {
                emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
            }
        } else {
            // AUDIT SFR-H-01: derive the internal TWAP-floor minETHOut and pick the tighter of
            // (callerMinETHOut, twapMinETHOut). Bootstrap path is owner-only (see helper).
            (effectiveMin, currentCum, currentTs) =
                _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, amount, minETHOut);
        }

        IERC20(token).forceApprove(address(cfg.router), amount);

        uint256 ethBefore = address(this).balance;
        // SFR-H-01: forward `effectiveMin` (NOT the raw `minETHOut`) to the inner router so
        // the swap reverts at the Uniswap K-check boundary if the post-attack price would
        // produce less than the TWAP floor.
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft; intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line reentrancy-no-eth,unused-return
        cfg.router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(cfg.router), 0);

        // AUDIT FIX: DEEP-R-H01 / HIGH-4 — only snapshot for direct 2-hop swaps; on
        // multi-hop branches INVALIDATE any existing snapshot rather than leaving it
        // stale (a stale anchor over weeks of drift admits sandwich on the next 2-hop).
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
        newAccumulatedETHFees += ethReceived;
        emit TokenFeesConverted(token, amount, ethReceived);
    }

    /// @notice Body of `SwapFeeRouter.convertTokenFeesToETHFoT` — fee-on-transfer
    ///         variant. Uses the router's *SupportingFeeOnTransferTokens helper and
    ///         measures the actual received ETH delta. Returns the updated
    ///         `accumulatedETHFees` for the host to write back.
    function convertTokenFeesToETHFoT(
        mapping(address => uint256) storage accumulatedTokenFees,
        mapping(address => uint256) storage lastConvertedAt,
        mapping(address => PriceSnapshot) storage lastConversionSnapshot,
        Cfg memory cfg,
        uint256 accumulatedETHFeesIn,
        address token,
        address[] calldata path,
        uint256 minETHOut,
        uint256 deadline
    ) public returns (uint256 newAccumulatedETHFees) {
        newAccumulatedETHFees = accumulatedETHFeesIn;
        if (token == address(0) || token == cfg.weth) revert ZeroAddress();
        // AUDIT NEW-A4 (HIGH): see convertTokenFeesToETH above for rationale.
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT SFR-M-01: validate caller-supplied path and gate multi-hop on owner.
        _validateConversionPath(cfg, token, path);
        // AUDIT SFR-M-02: gate against accumulated bookkeeping rather than balanceOf so a
        // dust-laden balance from a malicious direct transfer cannot enter the cooldown.
        uint256 amount = accumulatedTokenFees[token];
        if (amount < MIN_TOKEN_FEE_FOR_CONVERSION) revert TokenFeesBelowMinimum();
        // AUDIT NEW-A5 (HIGH): shared cooldown across both variants so switching
        // between them doesn't bypass the rate limit.
        _enforceConversionCooldown(lastConvertedAt, token);

        accumulatedTokenFees[token] = 0;

        // For FoT tokens we approve the actual on-hand balance because the contract may
        // hold less than `amount` after the input-side FoT haircut on prior accumulation.
        uint256 actualOnHand = IERC20(token).balanceOf(address(this));
        uint256 swapAmount = amount > actualOnHand ? actualOnHand : amount;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (swapAmount == 0) revert ZeroAmount();

        // AUDIT FIX: DEEP-R-H01 — same multi-hop bypass as the non-FoT variant above.
        uint256 effectiveMin;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 currentCum;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint32 currentTs;
        if (path.length > 2) {
            // AUDIT FIX 2026-05-26 [H-03 / FoT]: sequencer gate parity with non-FoT variant.
            SequencerCheck.checkSequencerUp(cfg.sequencerFeed, SEQUENCER_GRACE_PERIOD);

            // AUDIT FIX DEEP-R2-M01 / DEEP-R3-M01 / H-02 [FoT]: same floors as non-FoT.
            uint256 effectiveFloor = MIN_MULTIHOP_ETH_OUT_WEI;
            bool directPairExists = cfg.uniFactory.getPair(token, cfg.weth) != address(0);
            if (directPairExists) {
                (uint256 twapMin, uint256 hopCurCum, uint32 hopCurTs) =
                    _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, swapAmount, minETHOut);
                if (twapMin > effectiveFloor) effectiveFloor = twapMin;
                currentCum = hopCurCum;
                currentTs = hopCurTs;
            }
            if (minETHOut < effectiveFloor) revert ZeroMinOut();
            effectiveMin = minETHOut > effectiveFloor ? minETHOut : effectiveFloor;
            // SELF-AUDIT FIX 2026-05-26 [H-02 NEW-1 / FoT]: single-emit parity.
            if (!directPairExists) {
                emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
            }
        } else {
            // AUDIT SFR-H-01: TWAP-floor minETHOut sized against the actual swap input. Caller
            // can only TIGHTEN the floor; bootstrap is owner-only (see helper).
            (effectiveMin, currentCum, currentTs) =
                _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, swapAmount, minETHOut);
        }

        IERC20(token).forceApprove(address(cfg.router), swapAmount);

        uint256 ethBefore = address(this).balance;
        // SLITHER 2026-05-18: FoT balance-delta pattern; nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-balance,reentrancy-no-eth
        cfg.router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            swapAmount, effectiveMin, path, address(this), deadline
        );
        uint256 ethReceived = address(this).balance - ethBefore;
        if (ethReceived < effectiveMin) revert InsufficientOutput();

        IERC20(token).forceApprove(address(cfg.router), 0);

        // AUDIT FIX: DEEP-R-H01 / HIGH-4 — only snapshot for direct 2-hop swaps; multi-hop
        // invalidates any prior snapshot. See convertTokenFeesToETH above for rationale.
        if (path.length == 2) {
            lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});
        } else {
            if (lastConversionSnapshot[token].timestamp != 0) {
                lastConversionSnapshot[token] = PriceSnapshot({timestamp: 0, cumulative: 0});
            }
        }

        newAccumulatedETHFees += ethReceived;
        emit TokenFeesConverted(token, swapAmount, ethReceived);
    }

    /// @dev AUDIT SFR-M-01: validate the caller-supplied conversion path. Rules:
    ///        - Length in [2, MAX_CONVERSION_PATH_LENGTH]
    ///        - path[0] == input `token`; path[length-1] == WETH
    ///        - no duplicate hops; no zero-address intermediate hops
    ///      Multi-hop paths (length > 2) are restricted to the contract owner because the
    ///      SFR-H-01 TWAP anchor is against the direct token/WETH pair only.
    function _validateConversionPath(Cfg memory cfg, address token, address[] calldata path) internal view {
        uint256 len = path.length;
        if (len < 2 || len > MAX_CONVERSION_PATH_LENGTH) revert InvalidConversionPath();
        if (path[0] != token) revert InvalidConversionPath();
        if (path[len - 1] != cfg.weth) revert InvalidConversionPath();
        // AUDIT FIX DEEP-R-M02 / DEEP-R2-L01: reject zero-address intermediate hops and
        // duplicates in a single walk of the index range.
        for (uint256 i = 0; i < len; i++) {
            if (i > 0 && i < len - 1 && path[i] == address(0)) revert InvalidConversionPath();
            for (uint256 j = i + 1; j < len; j++) {
                if (path[i] == path[j]) revert InvalidConversionPath();
            }
        }
        if (len > 2 && msg.sender != cfg.owner) revert MultiHopOwnerOnly();
    }

    /// @dev AUDIT NEW-A5: per-token conversion cooldown to price out sandwich MEV.
    function _enforceConversionCooldown(mapping(address => uint256) storage lastConvertedAt, address token) internal {
        uint256 last = lastConvertedAt[token];
        if (last != 0 && block.timestamp < last + CONVERSION_COOLDOWN) {
            revert("CONVERSION_COOLDOWN_ACTIVE");
        }
        lastConvertedAt[token] = block.timestamp;
    }

    /// @dev AUDIT SFR-H-01: read the Uniswap V2 pair's cumulative price (token → WETH
    ///      direction) and bridge with `spotPrice * elapsedSinceLastPairTouch` so the
    ///      cumulative is correct even when the pair has been idle. Mirrors the Uniswap
    ///      V2 OracleLibrary `currentCumulativePrices` pattern.
    function _readCurrentCumulative(Cfg memory cfg, address token)
        internal
        view
        returns (address pair, uint256 currentCum, uint32 currentTs)
    {
        pair = cfg.uniFactory.getPair(token, cfg.weth);
        if (pair == address(0)) revert NoPairForToken();

        ISwapFeeRouterUniPair p = ISwapFeeRouterUniPair(pair);
        (uint112 reserve0, uint112 reserve1, uint32 pairTs) = p.getReserves();
        // No-reserves pair would mean no swap is possible — let the inner router revert
        // there with a clearer reason. Defensive: if both are zero return zeros.
        if (reserve0 == 0 || reserve1 == 0) revert NoPairForToken();

        // SLITHER 2026-05-18: Uniswap V2 oracle-timestamp truncation; not used as randomness source
        // slither-disable-next-line weak-prng
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
            // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
            // slither-disable-next-line divide-before-multiply
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
    ///      snapshot OR snapshot too recent) is owner-only.
    function _enforceTWAPMinETHOut(
        mapping(address => PriceSnapshot) storage lastConversionSnapshot,
        Cfg memory cfg,
        address token,
        uint256 amountIn,
        uint256 callerMinETHOut
    )
        internal
        returns (uint256 effectiveMin, uint256 currentCum, uint32 currentTs)
    {
        // PASS7-SFR-05 FIX: refuse to compute a TWAP floor while an L2 sequencer outage is
        // in progress OR within the post-resume grace window. address(0) feed (mainnet) = no-op.
        SequencerCheck.checkSequencerUp(cfg.sequencerFeed, SEQUENCER_GRACE_PERIOD);

        // Resolve the pair + read the current cumulative (with idle-window bridge).
        (, currentCum, currentTs) = _readCurrentCumulative(cfg, token);

        PriceSnapshot memory prev = lastConversionSnapshot[token];

        // PASS7-SFR-05 FIX: even if the sequencer is currently up, refuse if the prior
        // snapshot predates resume + grace — the TWAP integral would cross the outage.
        if (cfg.sequencerFeed != address(0)) {
            uint256 resumeAt = SequencerCheck.getResumeTimestamp(cfg.sequencerFeed);
            // AUDIT FIX (sentinel short-circuit): typed revert on the stale-feed sentinel
            // (type(uint256).max) instead of a checked-math Panic. No-op on mainnet.
            if (resumeAt == type(uint256).max) revert TWAPBootstrapRequired();
            if (resumeAt != 0 && prev.timestamp != 0 && uint256(prev.timestamp) < resumeAt + SEQUENCER_GRACE_PERIOD) {
                revert TWAPBootstrapRequired();
            }
        }
        // Note: only the direct token/WETH 2-hop path reaches this function (multi-hop
        // paths are diverted in the callsites), so the TWAP anchor against
        // `uniFactory.getPair(token, WETH)` matches exactly what the swap will trade through.
        if (prev.timestamp == 0) {
            // Bootstrap: no prior snapshot. Owner-only so the first call can't be sandwiched.
            if (msg.sender != cfg.owner) revert TWAPBootstrapRequired();
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
            // Normally unreachable (1h cooldown), but guards against a lowered cooldown.
            if (msg.sender != cfg.owner) revert TWAPBootstrapRequired();
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
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        uint256 twapEthOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112_SFR);
        // Apply 1.5% safety margin — caller cannot relax below this floor.
        uint256 twapMin = (twapEthOut * (BPS - TWAP_SAFETY_BPS)) / BPS;

        // Caller can only TIGHTEN the floor (raise it).
        effectiveMin = callerMinETHOut > twapMin ? callerMinETHOut : twapMin;
        emit ConversionTWAPFloor(token, effectiveMin, callerMinETHOut, false);
    }
}
