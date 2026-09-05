// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SequencerCheck} from "./SequencerCheck.sol";
import {IWETH} from "./WETHFallbackLib.sol";
// AUDIT ROW-8 RE-ANCHOR (docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md): the cumulative-
// price counterfactual is no longer hand-derived here — it comes from the 0.8 port of
// canonical UniswapV2OracleLibrary, which the v2-provenance CI gate pins byte-for-byte
// (modulo the named allowlist) against the vendored upstream source.
import {UniswapV2OracleLibrary} from "./UniswapV2OracleLibrary.sol";

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
    uint256 internal constant MAX_CONVERSION_PATH_LENGTH = 4;
    uint256 internal constant TWAP_SAFETY_BPS = 150;
    /// @dev AUDIT TF-015: mirror of SwapFeeRouter.MAX_FOT_FLOOR_HAIRCUT_BPS. Enforced here
    ///      too so `BPS - fotFloorHaircutBps` is a typed revert rather than a Panic(0x11)
    ///      if this library is ever linked against a host that forgets the cap.
    uint256 internal constant MAX_FOT_FLOOR_HAIRCUT_BPS = 1000;
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
    error HaircutTooHigh();

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
            // AUDIT TF-010: floor re-denominated from RAW TOKEN UNITS into WEI OF ETH.
            // WETH is 1:1 with ETH wei, so the comparison keeps its shape and only the
            // number changes: 1e18 raw was 1 WHOLE ETH, stranding every WETH-input swap
            // fee below that (withdrawTokenFees and sweepTokens both reject WETH by name,
            // so this branch is the ONLY exit). This branch RETURNS below without calling
            // _enforceConversionCooldown, so it stamps no cooldown and the SFR-M-02
            // anti-grief rationale never applied here - the floor is gas-dust hygiene and
            // 1e14 wei is its right size.
            if (wethAmount < MIN_MULTIHOP_ETH_OUT_WEI) revert TokenFeesBelowMinimum();
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
        uint256 amount = accumulatedTokenFees[token];
        // AUDIT TF-010 (was SFR-M-02): the dust gate moved DOWN to the 2-hop call site,
        // where the pile can finally be PRICED - see `_enforceMinETHValue`. The anti-grief
        // property is unchanged in strength, only in shape: it was ORDERED before the
        // cooldown stamp, it is now ATOMIC with it, because a revert anywhere in this call
        // unwinds the `lastConvertedAt[token] = block.timestamp` write. The repo already
        // proves that empirically - R028_SwapFeeRouter_M_Findings.t.sol reverts on dust and
        // then converts legitimately IN THE SAME BLOCK. This holds only while no caller
        // wraps the delegatecall in try/catch; SwapFeeRouter.convertTokenFeesToETH does not,
        // and must not.
        //
        // Parity with the FoT twin's `swapAmount == 0` reject: without this, a zero pile
        // would reach the swap and, for the owner (exempt from the value gate), would stamp
        // the cooldown and rewrite the snapshot for nothing.
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert ZeroAmount();
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
            // AUDIT TF-010: the value floor, in WEI OF ETH. AT THE CALL SITE, NEVER INSIDE
            // THE HELPER - see `_enforceMinETHValue`.
            _enforceMinETHValue(cfg, effectiveMin);
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
        uint256 deadline,
        /// @dev AUDIT TF-015: SwapFeeRouter.fotFloorHaircutBps[token]. Host-set, host-capped,
        ///      timelocked, 0 by default.
        uint256 fotFloorHaircutBps
    ) public returns (uint256 newAccumulatedETHFees) {
        newAccumulatedETHFees = accumulatedETHFeesIn;
        if (token == address(0) || token == cfg.weth) revert ZeroAddress();
        // AUDIT NEW-A4 (HIGH): see convertTokenFeesToETH above for rationale.
        if (deadline < block.timestamp) revert("DEADLINE_EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT SFR-M-01: validate caller-supplied path and gate multi-hop on owner.
        _validateConversionPath(cfg, token, path);
        // AUDIT TF-010 (was SFR-M-02): raw-unit gate deleted; the ETH-value gate lives at
        // the 2-hop call site below. `amount == 0` needs no explicit reject here - it
        // collapses into `swapAmount == 0` two statements down, because swapAmount is
        // min(amount, on-hand). The bookkeeping-vs-balanceOf property SFR-M-02 named is
        // unchanged: `amount` is still the booked figure, not `balanceOf`.
        uint256 amount = accumulatedTokenFees[token];
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

        // AUDIT TF-015: an FoT token delivers `swapAmount * (BPS - haircut) / BPS` to the
        // first hop, so THAT - not the gross balance - is what the TWAP floor must be sized
        // on. Sizing on gross made the floor unreachable for any FoT fee above
        // TWAP_SAFETY_BPS (1.5%), and real FoT tokens are 2-10%.
        //   * applied to the INPUT, not to the returned floor: `twapMin` is exactly linear
        //     in `amountIn`, so this scales the floor by the same factor and composes
        //     MULTIPLICATIVELY with TWAP_SAFETY_BPS for free - while leaving
        //     `callerMinETHOut` un-haircut, so "the caller can only TIGHTEN" still holds;
        //   * `_enforceTWAPMinETHOut` is NOT modified, so the non-FoT path and both
        //     owner-only early returns (which never read `amountIn`) are byte-identical;
        //   * haircut 0 is an EXACT identity: Math.mulDiv(x, BPS, BPS) == x.
        // `swapAmount` - NOT this value - is still what gets approved and swapped below.
        if (fotFloorHaircutBps > MAX_FOT_FLOOR_HAIRCUT_BPS) revert HaircutTooHigh();
        uint256 floorAmountIn = Math.mulDiv(swapAmount, BPS - fotFloorHaircutBps, BPS);

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
                    _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, floorAmountIn, minETHOut);
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
                _enforceTWAPMinETHOut(lastConversionSnapshot, cfg, token, floorAmountIn, minETHOut);
            // AUDIT TF-010: same value floor as the non-FoT twin.
            _enforceMinETHValue(cfg, effectiveMin);
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

    /// @dev AUDIT TF-010: the conversion entry gate, expressed in WEI OF ETH - the
    ///      dimension this contract already owns (MIN_MULTIHOP_ETH_OUT_WEI, and the
    ///      TWAP-derived floor). It replaces a RAW-TOKEN-UNIT gate of 1e18, which was
    ///      ~1e12 USDC and ~1e10 WBTC: unreachable, while `withdrawTokenFees` and
    ///      `sweepTokens` reject every token with a WETH pair, so those fees had no exit.
    ///
    ///      WHY THE GATE READS `effectiveMin` AND NOT A SEPARATE FIGURE: `effectiveMin` is
    ///      max(callerMinETHOut, twapMin) and the swap must actually DELIVER it - it is
    ///      forwarded to the inner router AND re-checked as `ethReceived < effectiveMin`.
    ///      So a caller cannot buy past this gate on a dust pile by inflating `minETHOut`:
    ///      the gate passes, the swap reverts, the whole call unwinds and `lastConvertedAt`
    ///      is never stamped.
    ///
    ///      WHY THE OWNER CONJUNCT IS LOAD-BEARING - this is the whole fix, do not remove
    ///      it: `_enforceTWAPMinETHOut` has TWO owner-only early returns (`prev.timestamp
    ///      == 0`, and `elapsed < MIN_TWAP_PERIOD`) that hand back `callerMinETHOut`
    ///      UNTOUCHED, before any price exists. An unconditional floor here reverts the
    ///      owner's first-ever conversion of a token - you could never establish the
    ///      snapshot for a token whose fees you cannot yet price. Both early returns are
    ///      gated `msg.sender != cfg.owner`, so this single conjunct exempts exactly them
    ///      and nothing else. It is also the honest statement of the property: the gate
    ///      exists so a STRANGER cannot stamp the 1h cooldown on a worthless pile, and a
    ///      stranger can never reach either early return.
    ///
    ///      NOT placed inside the helper for the same reason, and NOT at the multi-hop call
    ///      sites where the helper's return is only a CANDIDATE floor and a low value is
    ///      deliberately tolerated.
    function _enforceMinETHValue(Cfg memory cfg, uint256 effectiveMin) internal view {
        if (msg.sender != cfg.owner && effectiveMin < MIN_MULTIHOP_ETH_OUT_WEI) {
            revert TokenFeesBelowMinimum();
        }
    }

    /// @dev AUDIT SFR-H-01: read the Uniswap V2 pair's cumulative price (token → WETH
    ///      direction), bridged across any idle window so the integral is current.
    /// @dev AUDIT ROW-8 RE-ANCHOR: the counterfactual bridge (`spot × elapsed` on top of
    ///      the stored accumulator, wrap-preserving) is now the provenance-pinned
    ///      canonical `UniswapV2OracleLibrary.currentCumulativePrices` instead of a
    ///      hand-derived equivalent. This wrapper keeps only what is OURS on purpose:
    ///        * pair resolution via the factory (caller cannot lie about the pair);
    ///        * the typed `NoPairForToken` guards, including the empty-reserves reject
    ///          the canonical library does not have (an empty pair cannot be swapped
    ///          through, and rejecting here beats an opaque inner-router revert).
    ///          ⚠ The guard and the canonical library each call getReserves() — the
    ///          2026-08-28 blind equivalence proof holds for CANONICAL pairs whose
    ///          reserves are stable within a call; a non-canonical pair answering the
    ///          two reads differently could pass this guard yet DIV_BY_ZERO inside
    ///          fraction(). Never point this at a non-canonical pair;
    ///        * side selection — the canonical helper returns BOTH cumulatives; the
    ///          token→WETH direction is picked from `token0()`.
    ///      Behaviour is equivalence-tested against the pre-refactor formula in
    ///      test/Audit_SFR_H01.t.sol (ROW8 suite), including the same-block no-bridge
    ///      case and uint256 accumulator wrap.
    function _readCurrentCumulative(Cfg memory cfg, address token)
        internal
        view
        returns (address pair, uint256 currentCum, uint32 currentTs)
    {
        pair = cfg.uniFactory.getPair(token, cfg.weth);
        if (pair == address(0)) revert NoPairForToken();

        ISwapFeeRouterUniPair p = ISwapFeeRouterUniPair(pair);
        (uint112 reserve0, uint112 reserve1,) = p.getReserves();
        // No-reserves pair would mean no swap is possible — reject with the typed error
        // (and keep the canonical library's fraction() from a bare DIV_BY_ZERO revert).
        if (reserve0 == 0 || reserve1 == 0) revert NoPairForToken();

        (uint256 price0Cumulative, uint256 price1Cumulative, uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(pair);
        currentTs = blockTimestamp;
        // Spot/cumulative direction token→WETH: price0 is token0-denominated.
        currentCum = p.token0() == token ? price0Cumulative : price1Cumulative;
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
        // AUDIT FIX FRESH-2026 [M-SFRCL-MULDIV-OVERFLOW]: route through
        // Math.mulDiv (512-bit intermediate) to handle high-price tokens.
        // Pre-fix `(amountIn * priceDiff) / (uint64(elapsed) * Q112)` used
        // Solidity 0.8 checked math — for tokens with high WETH-relative
        // reserve ratio (e.g. WBTC, low-supply ERC20s), `priceDiff = spot *
        // elapsed_seconds` can reach 1e46+ and the numerator approaches/
        // exceeds uint256.max (~1.16e77), triggering Panic(0x11) that DoS's
        // owner-only multi-hop conversions silently from off-chain ops view.
        // Pattern of record: Uniswap V3 OracleLibrary + UniswapV2-OracleLibrary
        // consumers (FullMath.mulDiv) use this exact 512-bit pattern.
        uint256 twapEthOut = Math.mulDiv(amountIn, priceDiff, uint256(elapsed) * Q112_SFR);
        // Apply 1.5% safety margin — caller cannot relax below this floor.
        uint256 twapMin = (twapEthOut * (BPS - TWAP_SAFETY_BPS)) / BPS;

        // Caller can only TIGHTEN the floor (raise it).
        effectiveMin = callerMinETHOut > twapMin ? callerMinETHOut : twapMin;
        emit ConversionTWAPFloor(token, effectiveMin, callerMinETHOut, false);
    }
}
