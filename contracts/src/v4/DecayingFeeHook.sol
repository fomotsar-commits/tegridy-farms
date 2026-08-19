// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
// Verbatim battle-tested base: OpenZeppelin uniswap-hooks v1.1.1 (pinned submodule),
// src/fee/BaseOverrideFee.sol. Inherited unmodified — the override-fee plumbing and the
// dynamic-fee guard are theirs; only the schedule below is ours.
import {BaseOverrideFee} from "@openzeppelin/uniswap-hooks/src/fee/BaseOverrideFee.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";

/// @title  DecayingFeeHook — anti-snipe launch mode as a pool fee that decays to baseline
///
/// @notice A sniper's edge is that block zero is worth more than block one. This hook
///         prices that difference away: the pool opens at a near-confiscatory fee and
///         decays linearly to the launch's real baseline over a published span (~90
///         minutes is the reference). Buying first stops being an advantage, so the
///         extraction that would otherwise be paid to bots is instead paid, as an ordinary
///         LP fee, to whoever is providing the liquidity being taken — which at t≈0 is the
///         launch position itself.
///
/// ─── WHY THIS IS A POOL FEE AND NOT A TOKEN TAX ──────────────────────────────
/// @dev    The distinction is load-bearing, not cosmetic. A tax written into the token
///         contract follows the token everywhere forever, is invisible to anyone reading
///         a transfer, and is what `frontend/src/lib/launcher/gate.ts` disqualifies. This
///         schedule lives in the POOL: the token stays a plain ERC-20 with no transfer
///         hook, no allowlist and no owner switch, and the elevated fee applies only to
///         swaps against this one pool, only for the published span. Anyone can read the
///         whole schedule from `decaySchedule` before trading.
///
/// ─── THIS HOOK NEVER HOLDS FUNDS ─────────────────────────────────────────────
/// @dev    There is no skim, no custody, no ERC-6909 accounting, no transfer of any kind
///         in this contract — the fee is returned to the PoolManager through the standard
///         override flag and is credited by v4 to in-range liquidity. That is deliberate:
///         a routing leg here would mean a second copy of settlement logic and a
///         reentrancy surface, when the existing fee rails already do that job on the
///         pool's fee stream. Where the anti-snipe proceeds go is therefore a question
///         about who holds the liquidity, which is public, rather than a question about
///         what this contract decides to do with them.
///
/// ─── IMMUTABILITY OF A LIVE SCHEDULE ─────────────────────────────────────────
/// @dev    A pool's schedule is written once by `configurePool` BEFORE the pool exists and
///         can never be edited, not by the owner and not by anyone. There is no proxy and
///         no upgrade path. `_afterInitialize` stamps the start time and from that instant
///         the fee for every future block is already determined; the owner cannot raise
///         it, extend it, or stop it. If a schedule is wrong, the pool is wrong, and the
///         fix is a different pool.
///
/// @dev    The hook is inert on deploy: no pool has a schedule, and any attempt to
///         initialize a pool against it reverts with `PoolNotConfigured` until the
///         operator publishes one. Nothing about a launch changes by this contract merely
///         existing on chain.
///
/// @dev    Decay reads `block.timestamp`, which a proposer can nudge by a few seconds. Over
///         a span measured in tens of minutes that moves the fee by far less than one
///         basis point, and the schedule is monotonically non-increasing, so there is no
///         moment where waiting one block costs a trader more than trading now.
contract DecayingFeeHook is BaseOverrideFee, OwnableNoRenounce {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    // ─── Bounds ───────────────────────────────────────────────────────

    /// @notice Ceiling on the opening fee, in hundredths of a bip. 99%, deliberately short
    ///         of v4's 100% maximum: a swap must always return something, or the pool is a
    ///         confiscation device rather than a price.
    uint24 public constant MAX_START_FEE_PIPS = 990_000;

    /// @notice Ceiling on the fee the schedule settles at. Matches the 3% cap the sibling
    ///         v4 hook enforces on its own fee dial.
    uint24 public constant MAX_BASELINE_FEE_PIPS = 30_000;

    uint32 public constant MIN_DECAY_SECONDS = 5 minutes;
    uint32 public constant MAX_DECAY_SECONDS = 24 hours;

    /// @notice The span the anti-snipe mode is designed around; published as a reference
    ///         so a fact sheet can say how far a given launch departs from it.
    uint32 public constant REFERENCE_DECAY_SECONDS = 90 minutes;

    // ─── Types ────────────────────────────────────────────────────────

    struct Schedule {
        /// @notice Fee at the instant the pool is initialized.
        uint24 startFeePips;
        /// @notice Fee from `startedAt + decaySeconds` onward, forever.
        uint24 baselineFeePips;
        /// @notice Length of the decay.
        uint32 decaySeconds;
        /// @notice Set once by `_afterInitialize`. Zero means the pool does not exist yet,
        ///         so no fee has been quoted and none can be.
        uint64 startedAt;
        bool configured;
    }

    mapping(PoolId => Schedule) private _schedules;

    // ─── Errors ───────────────────────────────────────────────────────

    error PoolNotConfigured(PoolId poolId);
    error PoolAlreadyConfigured(PoolId poolId);
    error PoolAlreadyStarted(PoolId poolId);
    error StartFeeTooHigh(uint24 startFeePips);
    error BaselineFeeTooHigh(uint24 baselineFeePips);
    error StartFeeBelowBaseline(uint24 startFeePips, uint24 baselineFeePips);
    error DecayOutOfRange(uint32 decaySeconds);
    error NotDynamicFeeKey();

    // ─── Events ───────────────────────────────────────────────────────

    event ScheduleConfigured(
        PoolId indexed poolId, uint24 startFeePips, uint24 baselineFeePips, uint32 decaySeconds
    );
    event ScheduleStarted(PoolId indexed poolId, uint64 startedAt, uint64 endsAt);

    // ─── Construction ─────────────────────────────────────────────────

    constructor(IPoolManager poolManager_, address initialOwner)
        BaseOverrideFee(poolManager_)
        OwnableNoRenounce(initialOwner)
    {}

    // ─── Configuration (once, before the pool exists) ─────────────────

    /// @notice Publish the immutable fee schedule for a pool that has not been initialized.
    /// @dev    Owner-gated because the key alone does not say who the launch belongs to,
    ///         and an open call would let anyone front-run a creator's configuration with
    ///         a schedule that opens at baseline — an anti-snipe mode a sniper is allowed
    ///         to switch off is not one. Gating writes rather than reads keeps the read
    ///         side permissionless: once published, the schedule is public and fixed.
    /// @param  key              The exact pool key that will be initialized. Must carry
    ///                          v4's dynamic-fee flag; a static-fee key cannot be
    ///                          overridden and would silently ignore this schedule.
    /// @param  startFeePips     Opening fee, hundredths of a bip.
    /// @param  baselineFeePips  Fee the pool settles at. May be zero.
    /// @param  decaySeconds     Span from initialization to baseline.
    function configurePool(PoolKey calldata key, uint24 startFeePips, uint24 baselineFeePips, uint32 decaySeconds)
        external
        onlyOwner
    {
        if (!key.fee.isDynamicFee()) revert NotDynamicFeeKey();
        if (startFeePips > MAX_START_FEE_PIPS) revert StartFeeTooHigh(startFeePips);
        if (baselineFeePips > MAX_BASELINE_FEE_PIPS) revert BaselineFeeTooHigh(baselineFeePips);
        // An "anti-snipe" schedule that rises would penalise the honest late buyer and
        // reward the block-zero one, which is the behaviour this contract exists to remove.
        if (startFeePips < baselineFeePips) revert StartFeeBelowBaseline(startFeePips, baselineFeePips);
        if (decaySeconds < MIN_DECAY_SECONDS || decaySeconds > MAX_DECAY_SECONDS) {
            revert DecayOutOfRange(decaySeconds);
        }

        PoolId poolId = key.toId();
        Schedule storage s = _schedules[poolId];
        if (s.configured) revert PoolAlreadyConfigured(poolId);

        s.startFeePips = startFeePips;
        s.baselineFeePips = baselineFeePips;
        s.decaySeconds = decaySeconds;
        s.configured = true;
        emit ScheduleConfigured(poolId, startFeePips, baselineFeePips, decaySeconds);
    }

    // ─── Hook entry points ────────────────────────────────────────────

    /// @dev Reverting here reverts the whole `initialize` call, so a pool with no published
    ///      schedule can never come into existence behind this hook. That is what lets the
    ///      read side promise that every pool using it has terms anyone can look up.
    function _afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        internal
        override
        returns (bytes4)
    {
        // Verbatim base first: it is the dynamic-fee guard, and it must run before this
        // hook commits a start time it could not honour.
        bytes4 selector = super._afterInitialize(sender, key, sqrtPriceX96, tick);

        PoolId poolId = key.toId();
        Schedule storage s = _schedules[poolId];
        if (!s.configured) revert PoolNotConfigured(poolId);
        if (s.startedAt != 0) revert PoolAlreadyStarted(poolId);

        s.startedAt = uint64(block.timestamp);
        emit ScheduleStarted(poolId, s.startedAt, s.startedAt + s.decaySeconds);
        return selector;
    }

    /// @dev The fee every swap pays, evaluated fresh from the schedule. No caller, sender,
    ///      or `hookData` input reaches this number — there is no allowlist, no discount
    ///      and no exemption, so no address can be routed around the decay.
    function _getFee(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (uint24)
    {
        Schedule storage s = _schedules[key.toId()];
        // Unreachable through the PoolManager (initialization is gated above); kept as the
        // explicit answer for any future call path that reaches a scheduleless pool, so it
        // fails rather than quoting a fee it has no basis for.
        if (!s.configured || s.startedAt == 0) revert PoolNotConfigured(key.toId());
        return _feeAt(s, block.timestamp);
    }

    // ─── Reads ────────────────────────────────────────────────────────

    /// @notice The published schedule and, when the pool is live, the exact fee the next
    ///         swap in this block will pay.
    ///
    /// @return configured  False means NO SCHEDULE for this key: every field below is zero
    ///                     because nothing was published, not because the fee is zero. A
    ///                     surface must render this as "no anti-snipe schedule", never as
    ///                     a 0% fee and never as a passing check.
    /// @return live        False means the pool has not been initialized, so no fee has
    ///                     ever been quoted for it. `quotedFeePips` is zero for that reason
    ///                     alone and must NOT be shown as the current fee — show
    ///                     `startFeePips` and say the pool opens there.
    /// @return quotedFeePips The fee a swap pays right now, in hundredths of a bip.
    ///                     Meaningful only when `live` is true. A trade surface that
    ///                     renders `baselineFeePips` while `decaying` is true is quoting a
    ///                     price the pool will not honour.
    /// @return startFeePips The published opening fee. Meaningful whenever `configured`.
    /// @return baselineFeePips The published fee the schedule settles at.
    /// @return decaySeconds The published span from initialization to baseline.
    /// @return startedAt   When the pool was initialized; zero while `live` is false.
    /// @return endsAt      `startedAt + decaySeconds`; zero while `live` is false.
    /// @return decaying    True while the fee is still above baseline.
    function decaySchedule(PoolKey calldata key)
        external
        view
        returns (
            bool configured,
            bool live,
            uint24 quotedFeePips,
            uint24 startFeePips,
            uint24 baselineFeePips,
            uint32 decaySeconds,
            uint64 startedAt,
            uint64 endsAt,
            bool decaying
        )
    {
        Schedule storage s = _schedules[key.toId()];
        if (!s.configured) return (false, false, 0, 0, 0, 0, 0, 0, false);

        configured = true;
        startFeePips = s.startFeePips;
        baselineFeePips = s.baselineFeePips;
        decaySeconds = s.decaySeconds;
        startedAt = s.startedAt;
        if (startedAt == 0) return (true, false, 0, startFeePips, baselineFeePips, decaySeconds, 0, 0, false);

        live = true;
        endsAt = startedAt + decaySeconds;
        quotedFeePips = _feeAt(s, block.timestamp);
        decaying = block.timestamp < endsAt;
    }

    // ─── Core math ────────────────────────────────────────────────────

    /// @dev Linear interpolation from `startFeePips` down to `baselineFeePips`, clamped at
    ///      both ends: exactly `startFeePips` in the initialization block, exactly
    ///      `baselineFeePips` from `startedAt + decaySeconds` onward, and non-increasing in
    ///      between. The truncating division rounds the deducted amount DOWN, so any
    ///      rounding error leaves the fee marginally higher — in favour of the liquidity
    ///      being taken and never in favour of the trader taking it early.
    function _feeAt(Schedule storage s, uint256 nowTs) private view returns (uint24) {
        uint256 span = nowTs - uint256(s.startedAt);
        uint32 duration = s.decaySeconds;
        if (span >= duration) return s.baselineFeePips;
        uint256 drop = uint256(s.startFeePips) - uint256(s.baselineFeePips);
        return uint24(uint256(s.startFeePips) - (drop * span) / duration);
    }
}
