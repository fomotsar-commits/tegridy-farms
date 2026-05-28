// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Position, StakingViewLib} from "./StakingViewLib.sol";

/// @title StakingRewardLib
/// @notice EIP-170 split (C1): the LIVE reward-accounting cluster extracted from
///         TegridyStaking into a linked (delegatecall) library. PURE SIZE REDUCTION —
///         behaviour is byte-for-byte identical to the original in-contract functions.
///
///         Because the library is invoked via `delegatecall` it executes in the
///         caller's storage context (`address(this)` == TegridyStaking), so reward
///         tokens transferred by `rewardToken.safeTransfer(...)` move from the staking
///         contract's balance exactly as before, and events emitted here carry the
///         staking contract's address as emitter (off-chain indexers see no change).
///
///         Storage marshalling pattern (proven by StakingViewLib):
///           * mappings / OZ Checkpoints traces are passed by `storage` reference so
///             the library reads & writes the caller's storage directly;
///           * standalone scalar state vars cannot be passed by storage reference in
///             Solidity, so they are passed BY VALUE and the new value RETURNED — the
///             caller writes it back through a single choke-point helper
///             (`_storeRewardState`) so a write-back can never be silently dropped;
///           * immutables (`rewardToken`) and `paused()` are not in storage, so they
///             are passed in by the caller.
///
///         Events / errors are re-declared here with identical signatures so the
///         emitted topics and revert selectors are byte-identical to the originals.
library StakingRewardLib {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using EnumerableSet for EnumerableSet.UintSet;

    // Mirror of TegridyStaking's reward-math constant (must equal the contract's value).
    uint256 internal constant ACC_PRECISION = 1e18;
    // Mirror of TegridyStaking.MAX_POSITIONS_PER_HOLDER (must equal the contract's value).
    uint256 internal constant MAX_POSITIONS_PER_HOLDER = 50;

    // ─── Errors (selectors identical to TegridyStaking's) ───────────────
    error ZeroAmount();
    error IntOverflow();
    error KickWouldForfeit();
    error TooManyPositions();
    error AlreadyHasPosition();

    // ─── Events (topics identical to TegridyStaking's) ──────────────────
    event UnsettledClaimed(address indexed user, uint256 amount);
    event UnsettledClaimedForTokenId(uint256 indexed tokenId, address indexed recipient, uint256 amount);
    event RewardPaid(address indexed user, uint256 indexed tokenId, uint256 reward);
    event RewardsForfeited(address indexed user, uint256 amount);
    event TransferRewardPoolShortfall(address indexed holder, uint256 expected, uint256 available);
    event RewardSettledToUnsettled(address indexed holder, uint256 indexed tokenId, uint256 amount);
    event KickRewardPoolShortfall(address indexed holder, uint256 expected, uint256 available);
    event PositionKicked(uint256 indexed tokenId, address indexed kicker, uint256 boostDecayed);
    event MultipleNFTsAtAddress(address indexed holder, uint256 newTokenId, uint256 priorTokenId);

    /// @notice Mutable reward scalars marshalled across the host↔library delegatecall
    ///         boundary. Standalone scalar state vars cannot be passed by storage
    ///         reference, so they are loaded into this struct, mutated in the library,
    ///         and written back by the host through the single `_storeRewardState`
    ///         choke-point (so a write-back can never be silently dropped).
    struct RewardState {
        uint256 rewardPerTokenStored;
        uint256 lastUpdateTime;
        uint256 totalBoostedStake;
        uint256 totalUnsettledRewards;
    }

    /// @notice Read-only inputs the library needs: scalars it never mutates, the
    ///         reward-token immutable, the restaking-contract pointer, and the live
    ///         `paused()` flag (none of which are reachable from a delegatecall lib
    ///         except by being passed in).
    struct Cfg {
        uint256 totalStaked;
        uint256 maxUnsettledRewards;
        uint256 rewardRate;
        IERC20 rewardToken;
        address restakingContract;
        bool isPaused;
    }

    // ════════════════════════════════════════════════════════════════════
    //  Unsettled-reward claim family (Increment A)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Body of `TegridyStaking._claimUnsettledInternal`. Pays a user their
    ///         unsettled-reward balance, capped to the unreserved reward pool
    ///         (`balance - totalStaked - other users' unsettled`), retaining any
    ///         un-payable remainder as claimable (AUDIT FIX M-04 / v2 semantics).
    /// @return newTotalUnsettledRewards updated `totalUnsettledRewards` to write back.
    function claimUnsettledInternal(
        mapping(address => uint256) storage unsettledRewards,
        address user,
        uint256 totalUnsettledRewards,
        uint256 totalStaked,
        IERC20 rewardToken
    ) public returns (uint256 newTotalUnsettledRewards) {
        uint256 amount = unsettledRewards[user];
        // SLITHER: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert ZeroAmount();
        // Cap to available reward pool: reserve totalStaked + other users' unsettled rewards
        // (this user's unsettled amount is being claimed, so exclude it from reserved).
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 otherUnsettled = totalUnsettledRewards > amount ? totalUnsettledRewards - amount : 0;
        uint256 otherReserved = totalStaked + otherUnsettled;
        uint256 rewardPool = available > otherReserved ? available - otherReserved : 0;
        uint256 payout = amount > rewardPool ? rewardPool : amount;
        // AUDIT FIX v2: Only deduct what's actually paid; remainder stays claimable.
        unsettledRewards[user] = amount - payout;
        // SECURITY FIX: Decrease totalUnsettledRewards as rewards are claimed.
        newTotalUnsettledRewards = totalUnsettledRewards > payout ? totalUnsettledRewards - payout : 0;
        if (payout > 0) {
            rewardToken.safeTransfer(user, payout);
            emit UnsettledClaimed(user, payout);
        }
    }

    /// @notice Body of `TegridyStaking.claimUnsettledForTokenId`. The caller-side
    ///         guards (`_isTrackedHolder(msg.sender)`, `recipient != 0`) remain in the
    ///         host wrapper; `holder` is the host's `msg.sender` (a tracked holder).
    ///         Pulls `min(per-tokenId credit, holder bucket, reward pool)` and transfers
    ///         it to `recipient`, decrementing the per-tokenId mapping, the holder
    ///         bucket, and `totalUnsettledRewards` in lockstep (AUDIT FIX C-1 / D-LD-H1).
    /// @return paid the amount transferred to `recipient` (0 if nothing claimable / pool dry).
    /// @return newTotalUnsettledRewards updated `totalUnsettledRewards` to write back.
    function claimUnsettledForTokenId(
        mapping(uint256 => uint256) storage unsettledRewardsByTokenId,
        mapping(address => uint256) storage unsettledRewards,
        uint256 tokenId,
        address holder,
        address recipient,
        uint256 totalUnsettledRewards,
        uint256 totalStaked,
        IERC20 rewardToken
    ) public returns (uint256 paid, uint256 newTotalUnsettledRewards) {
        newTotalUnsettledRewards = totalUnsettledRewards;

        uint256 amount = unsettledRewardsByTokenId[tokenId];
        if (amount == 0) return (0, newTotalUnsettledRewards);

        // Defensive cap: holder bucket must be at least `amount`. Under normal
        // accounting the per-tokenId mapping is always <= holder bucket because
        // every per-tokenId credit was paired with a holder-bucket credit.
        uint256 holderUnsettled = unsettledRewards[holder];
        // AUDIT FIX 2026-05-26 [L-16]: if the per-tokenId mapping is non-zero
        // but the holder bucket is fully drained (invariant break — should not
        // happen in normal flow; defensive cleanup path), zero the slot so it
        // doesn't persist as a perma-zombie. No value lost (paid stays 0).
        if (amount > 0 && holderUnsettled == 0) {
            unsettledRewardsByTokenId[tokenId] = 0;
            return (0, newTotalUnsettledRewards);
        }
        if (amount > holderUnsettled) amount = holderUnsettled;

        // Same reward-pool cap as `claimUnsettledInternal`: reserve totalStaked +
        // other users' unsettled (everything except this claim).
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 otherUnsettled = totalUnsettledRewards > amount ? totalUnsettledRewards - amount : 0;
        uint256 otherReserved = totalStaked + otherUnsettled;
        uint256 rewardPool = available > otherReserved ? available - otherReserved : 0;
        paid = amount > rewardPool ? rewardPool : amount;

        if (paid > 0) {
            unsettledRewardsByTokenId[tokenId] -= paid;
            unsettledRewards[holder] = holderUnsettled - paid;
            newTotalUnsettledRewards = totalUnsettledRewards > paid ? totalUnsettledRewards - paid : 0;
            rewardToken.safeTransfer(recipient, paid);
            emit UnsettledClaimedForTokenId(tokenId, recipient, paid);
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Shared internal helpers (Increment B) — copies of the host helpers,
    //  inlined into the library's own bytecode. The host keeps its originals
    //  for the non-cluster lifecycle paths (stake/withdraw/_update/_clearPosition)
    //  and the still-resident kick / _settleRewardsOnTransfer (Inc C/D).
    // ════════════════════════════════════════════════════════════════════

    /// @dev Mirror of `TegridyStaking._safeInt256`.
    function _safeInt256(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert IntOverflow();
        return int256(value);
    }

    /// @dev Mirror of `TegridyStaking._isTrackedHolder`.
    function _isTrackedHolder(
        address holder,
        address restakingContract,
        mapping(address => bool) storage isLendingContract
    ) internal view returns (bool) {
        if (holder == address(0)) return false;
        if (holder == restakingContract && restakingContract != address(0)) return true;
        return isLendingContract[holder];
    }

    /// @dev Mirror of `TegridyStaking.votingPowerOf(address)` — restaking/lending
    ///      carve-out then the per-position summation delegated to StakingViewLib.
    function _votingPowerOf(
        address user,
        mapping(address => EnumerableSet.UintSet) storage positionsByOwner,
        mapping(uint256 => Position) storage positions,
        mapping(address => bool) storage isLendingContract,
        address restakingContract
    ) internal view returns (uint256) {
        if (user == restakingContract || isLendingContract[user]) return 0;
        return StakingViewLib.votingPowerOf(positionsByOwner[user], positions);
    }

    /// @dev Mirror of `TegridyStaking._writeCheckpoint` (AUDIT NEW-S7 no-op skip).
    function _writeCheckpoint(
        address user,
        mapping(address => Checkpoints.Trace208) storage checkpoints,
        mapping(address => EnumerableSet.UintSet) storage positionsByOwner,
        mapping(uint256 => Position) storage positions,
        mapping(address => bool) storage isLendingContract,
        address restakingContract
    ) internal {
        uint256 power = _votingPowerOf(user, positionsByOwner, positions, isLendingContract, restakingContract);
        uint208 newPower = SafeCast.toUint208(power);
        uint208 last = checkpoints[user].latest();
        // slither-disable-next-line incorrect-equality
        if (last == newPower) return;
        // slither-disable-next-line unused-return
        checkpoints[user].push(SafeCast.toUint48(block.timestamp), newPower);
    }

    /// @dev Mirror of `TegridyStaking._writeTotalBoostedStakeCheckpoint` (AUDIT REV-M-01).
    function _writeTotalBoostedStakeCheckpoint(
        uint256 totalBoostedStake,
        Checkpoints.Trace208 storage totalBoostedStakeCheckpoints
    ) internal {
        uint208 newTotal = SafeCast.toUint208(totalBoostedStake);
        uint208 last = totalBoostedStakeCheckpoints.latest();
        // slither-disable-next-line incorrect-equality
        if (last == newTotal) return;
        // slither-disable-next-line unused-return
        totalBoostedStakeCheckpoints.push(SafeCast.toUint48(block.timestamp), newTotal);
    }

    /// @dev Mirror of `TegridyStaking._decayIfExpired`. `owner` is the resolved
    ///      `ownerOf(tokenId)` passed in by the caller (the host resolves it before
    ///      delegating; cluster call sites already hold it).
    function _decayIfExpired(
        RewardState memory rs,
        Position storage p,
        address owner,
        mapping(address => Checkpoints.Trace208) storage checkpoints,
        Checkpoints.Trace208 storage totalBoostedStakeCheckpoints,
        mapping(address => EnumerableSet.UintSet) storage positionsByOwner,
        mapping(uint256 => Position) storage positions,
        mapping(address => bool) storage isLendingContract,
        address restakingContract
    ) internal returns (RewardState memory) {
        if (p.boostedAmount > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
            rs.totalBoostedStake -= p.boostedAmount;
            p.boostedAmount = 0;
            _writeCheckpoint(owner, checkpoints, positionsByOwner, positions, isLendingContract, restakingContract);
            _writeTotalBoostedStakeCheckpoint(rs.totalBoostedStake, totalBoostedStakeCheckpoints); // AUDIT REV-M-01
        }
        return rs;
    }

    /// @dev Mirror of `TegridyStaking._settleUnsettled` (AUDIT FIX L-06 cap; M-3
    ///      forfeit-to-treasury redirect removed). Returns updated state + the actual
    ///      amount credited (may be < requested if the cap was hit).
    function _settleUnsettled(
        RewardState memory rs,
        mapping(address => uint256) storage unsettledRewards,
        address user,
        uint256 amount,
        uint256 maxUnsettledRewards
    ) internal returns (RewardState memory, uint256 settled) {
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return (rs, 0);
        uint256 unsettledRoom = rs.totalUnsettledRewards < maxUnsettledRewards
            ? maxUnsettledRewards - rs.totalUnsettledRewards : 0;
        settled = amount > unsettledRoom ? unsettledRoom : amount;
        if (settled > 0) {
            unsettledRewards[user] += settled;
            rs.totalUnsettledRewards += settled;
        }
        return (rs, settled);
    }

    // ════════════════════════════════════════════════════════════════════
    //  Reward accumulation + per-position claim (Increment B)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Body of `TegridyStaking._accumulateRewards` (AUDIT FIX DS2-04
    ///         pause-aware accumulator). Bakes elapsed emission into
    ///         `rewardPerTokenStored` (capped to the unreserved pool) and advances
    ///         `lastUpdateTime` to now — even while paused, so the pause window's
    ///         emission is skipped rather than credited to the first post-unpause caller.
    function accumulateRewards(RewardState memory rs, Cfg memory cfg)
        public
        view
        returns (RewardState memory)
    {
        uint256 totalBoosted = rs.totalBoostedStake;
        if (block.timestamp > rs.lastUpdateTime && totalBoosted > 0 && !cfg.isPaused) {
            uint256 elapsed = block.timestamp - rs.lastUpdateTime;
            uint256 reward = elapsed * cfg.rewardRate;
            uint256 available = cfg.rewardToken.balanceOf(address(this));
            uint256 reserved = cfg.totalStaked + rs.totalUnsettledRewards;
            if (available > reserved) {
                uint256 rewardPool = available - reserved;
                if (reward > rewardPool) reward = rewardPool;
            } else {
                reward = 0;
            }
            if (reward > 0) {
                rs.rewardPerTokenStored += (reward * ACC_PRECISION) / totalBoosted;
            }
        }
        // Advance even while paused (Compound "skip pause-window emission" half).
        rs.lastUpdateTime = block.timestamp;
        return rs;
    }

    /// @notice Body of `TegridyStaking._getReward`. `recipient` is the resolved
    ///         `ownerOf(tokenId)` (host resolves before delegating). Computes pending
    ///         BEFORE decay (AUDIT FIX M-01), pays out capped to the unreserved pool,
    ///         routes any shortfall through `_settleUnsettled` with per-tokenId
    ///         attribution for tracked holders (AUDIT FIX critique-5.1 / L1), and
    ///         emits the same `RewardPaid` / `RewardsForfeited` events.
    /// @return claimedAmt the amount actually transferred to `recipient`.
    function getReward(
        RewardState memory rs,
        Position storage p,
        uint256 tokenId,
        address recipient,
        mapping(address => uint256) storage unsettledRewards,
        mapping(uint256 => uint256) storage unsettledRewardsByTokenId,
        mapping(address => Checkpoints.Trace208) storage checkpoints,
        Checkpoints.Trace208 storage totalBoostedStakeCheckpoints,
        mapping(address => EnumerableSet.UintSet) storage positionsByOwner,
        mapping(uint256 => Position) storage positions,
        mapping(address => bool) storage isLendingContract,
        Cfg memory cfg
    ) public returns (uint256 claimedAmt, RewardState memory) {
        if (p.boostedAmount == 0) return (0, rs);
        // AUDIT FIX M-01: compute rewards BEFORE decay zeroes boostedAmount.
        int256 accumulated = _safeInt256((p.boostedAmount * rs.rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        // AUDIT FIX 2026-05-26 [H-05 / L-15]: do NOT advance `rewardDebt = accumulated`
        // unconditionally. Pre-fix, when the unsettled cap or reward-pool saturated,
        // the function silently forfeited (line 374 emitted but rewardDebt was already
        // advanced), so the holder permanently lost the un-paid slice. `kick` (line
        // 527) reverts on this condition; `getReward` must at least preserve recovery
        // by advancing `rewardDebt` by ONLY the actually-credited amount. Now the next
        // claim sees the same `diff` and can re-credit when pool/cap clears. Mirrors
        // kick line 530 (`p.rewardDebt += totalSettled`) instead of full overwrite.

        // AUDIT FIX 2026-05-27 [M5]: _decayIfExpired is no longer called from this
        // library function. The host's `_getReward` wrapper calls `_decayIfExpired`
        // AFTER this returns — identical to the `kick` pattern (TegridyStaking.sol line
        // ~1448). This frees the stack-depth budget so the M5 expiry-residual
        // force-settle can live inline in _creditGetReward without a Yul stack fault.
        // Pre-M5 order was: decay → credit. Residual stranded if pool/cap was exhausted
        // because the next call early-returned on the boostedAmount==0 guard.
        // New order: credit (including force-settle) → host decays. Same behavior on
        // the non-expiring path; expiring path now routes residual to unsettledRewards.
        if (diff > 0) {
            uint256 cappedPending;
            (cappedPending, rs) = _creditGetReward(
                rs, p, tokenId, recipient,
                uint256(diff),
                unsettledRewards,
                unsettledRewardsByTokenId,
                isLendingContract,
                cfg
            );
            // NOTE: _decayIfExpired runs HOST-side after this returns (mirrors kick).
            return (cappedPending, rs);
        }
        // diff <= 0: nothing to credit. Host decays regardless.
        return (0, rs);
    }

    /// @dev AUDIT FIX 2026-05-27 [M5]: reward-credit body for `getReward`, extracted
    ///      to a dedicated function so the parent stays under the EVM 16-slot stack
    ///      limit. Handles pool-cap, shortfall→unsettled routing (critique 5.1 / L1),
    ///      and expiry-residual force-settle (M5). All local variables live here.
    ///
    ///      M5 force-settle: when the position is expiring (`p.lockEnd <= now`) and
    ///      `_settleUnsettled` cannot credit the full shortfall (cap saturated), the
    ///      uncredited "forfeited" slice is force-routed to `unsettledRewards[recipient]`
    ///      — bypassing the cap — rather than being permanently stranded in the inert
    ///      post-decay slot. Cap bypass is intentional: these are already-earned tokens;
    ///      `maxUnsettledRewards` is a flow-control guard, not a loss gate. Synthetix
    ///      "no silent forfeiture" pattern.
    function _creditGetReward(
        RewardState memory rs,
        Position storage p,
        uint256 tokenId,
        address recipient,
        uint256 pending,
        mapping(address => uint256) storage unsettledRewards,
        mapping(uint256 => uint256) storage unsettledRewardsByTokenId,
        mapping(address => bool) storage isLendingContract,
        Cfg memory cfg
    ) internal returns (uint256 cappedPending, RewardState memory) {
        // AUDIT FIX M-03: cap reward to available balance excluding reserved tokens.
        uint256 available = cfg.rewardToken.balanceOf(address(this));
        uint256 reserved = cfg.totalStaked + rs.totalUnsettledRewards;
        uint256 rewardPool = available > reserved ? available - reserved : 0;
        cappedPending = pending > rewardPool ? rewardPool : pending;

        uint256 totalCredited;
        if (cappedPending > 0) {
            cfg.rewardToken.safeTransfer(recipient, cappedPending);
            emit RewardPaid(recipient, tokenId, cappedPending);
            totalCredited = cappedPending;
        }

        // AUDIT FIX (critique 5.1): route shortfall through _settleUnsettled.
        uint256 shortfall = pending - cappedPending;
        if (shortfall > 0) {
            uint256 actualSettled;
            (rs, actualSettled) = _settleUnsettled(rs, unsettledRewards, recipient, shortfall, cfg.maxUnsettledRewards);
            // AUDIT FIX L1: per-tokenId attribution for tracked holders.
            if (actualSettled > 0 && _isTrackedHolder(recipient, cfg.restakingContract, isLendingContract)) {
                unsettledRewardsByTokenId[tokenId] += actualSettled;
            }
            totalCredited += actualSettled;
            uint256 forfeited = shortfall - actualSettled;
            if (forfeited > 0) {
                // [M5] If the position is expiring, force-settle the residual instead of
                // forfeiting it. After decay, boostedAmount==0 makes the slot inert and
                // the residual permanently inaccessible via the normal getReward path.
                if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
                    unsettledRewards[recipient] += forfeited;
                    rs.totalUnsettledRewards += forfeited;
                    emit RewardSettledToUnsettled(recipient, tokenId, forfeited);
                    if (_isTrackedHolder(recipient, cfg.restakingContract, isLendingContract)) {
                        unsettledRewardsByTokenId[tokenId] += forfeited;
                    }
                    totalCredited += forfeited;
                } else {
                    emit RewardsForfeited(recipient, forfeited);
                }
            }
        }

        // AUDIT FIX 2026-05-26 [H-05]: advance rewardDebt by ONLY the credited
        // amount so the user can re-claim the residual slice when pool/cap clears.
        if (totalCredited > 0) {
            p.rewardDebt = p.rewardDebt + _safeInt256(totalCredited);
        }
        return (cappedPending, rs);
    }

    // ════════════════════════════════════════════════════════════════════
    //  Settle-on-transfer (Increment C)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Body of `TegridyStaking._settleRewardsOnTransfer` (AUDIT FIX C-04).
    ///         Crystallises the outgoing owner `from`'s pending rewards into the
    ///         unsettled mapping on NFT transfer (capped to the unreserved pool, with
    ///         the rewardPool-shortfall slice ALSO routed to unsettled per FRESH-2026
    ///         M-1), with per-tokenId attribution for tracked holders, then resets the
    ///         position's `rewardDebt` for the new owner.
    function settleRewardsOnTransfer(
        RewardState memory rs,
        Position storage p,
        uint256 tokenId,
        address from,
        mapping(address => uint256) storage unsettledRewards,
        mapping(uint256 => uint256) storage unsettledRewardsByTokenId,
        mapping(address => bool) storage isLendingContract,
        mapping(address => uint256) storage lastActivityAt,
        Cfg memory cfg
    ) public returns (RewardState memory) {
        // Accumulate pending rewards (same logic as updateReward modifier).
        rs = accumulateRewards(rs, cfg);

        int256 accumulated = _safeInt256((p.boostedAmount * rs.rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = cfg.rewardToken.balanceOf(address(this));
            uint256 reserved = cfg.totalStaked + rs.totalUnsettledRewards;
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            // AUDIT FIX DS3-01 / DS3-05: shortfall observability on the transfer path.
            if (pending > rewardPool) {
                emit TransferRewardPoolShortfall(from, pending, rewardPool);
            }
            uint256 actualSettled;
            (rs, actualSettled) = _settleUnsettled(rs, unsettledRewards, from, cappedPending, cfg.maxUnsettledRewards);
            // AUDIT FIX 2026-05-26 [L-14]: emit main-slice event + per-tokenId
            // credit BEFORE the shortfall block. Pre-fix order was inverted —
            // off-chain indexers reconstructing per-tokenId unsettled credit
            // history saw shortfall before main, even though main accrues
            // first in time. Pure event/credit reorder; no semantic change.
            // AUDIT FIX C-02: forfeiture event when the cap blocks settlement.
            uint256 forfeited = cappedPending - actualSettled;
            if (forfeited > 0) {
                emit RewardsForfeited(from, forfeited);
            }
            // AUDIT FIX DS3-03: distinct settled-to-unsettled event + C-1/D-LD-H1
            // per-tokenId attribution for tracked holders.
            if (actualSettled > 0) {
                emit RewardSettledToUnsettled(from, tokenId, actualSettled);
                if (_isTrackedHolder(from, cfg.restakingContract, isLendingContract)) {
                    unsettledRewardsByTokenId[tokenId] += actualSettled;
                }
            }
            // AUDIT FIX FRESH-2026 M-1 [F-02-K-02]: route the rewardPool shortfall
            // through _settleUnsettled too (parity with _getReward / kick).
            uint256 shortfall = pending - cappedPending;
            uint256 shortfallSettled;
            if (shortfall > 0) {
                (rs, shortfallSettled) = _settleUnsettled(rs, unsettledRewards, from, shortfall, cfg.maxUnsettledRewards);
                if (shortfallSettled > 0) {
                    emit RewardSettledToUnsettled(from, tokenId, shortfallSettled);
                    if (_isTrackedHolder(from, cfg.restakingContract, isLendingContract)) {
                        unsettledRewardsByTokenId[tokenId] += shortfallSettled;
                    }
                }
                uint256 shortfallForfeited = shortfall - shortfallSettled;
                if (shortfallForfeited > 0) {
                    emit RewardsForfeited(from, shortfallForfeited);
                }
            }
            // AUDIT FIX DEEP-DS-04 / M16-REVISED: refresh `from`'s activity timestamp
            // from this non-claim path, but NOT while paused (closes the bounce-attack
            // half that relied on the FROM-side touch firing during pause).
            if (!cfg.isPaused && from != address(0)) lastActivityAt[from] = block.timestamp;

            // AUDIT FIX 2026-05-26 [L-15]: advance `rewardDebt` by ONLY the
            // actually-credited amount, mirroring the `kick` (line 530) and
            // `getReward` (H-05 fix) pattern. Pre-fix, `p.rewardDebt =
            // accumulated` unconditionally advanced to FULL pre-decay accrual
            // even when the unsettled cap or reward-pool saturated, silently
            // forfeiting the uncredited slice (the new owner inherited the
            // position with no recovery path). The kick-class fix preserves
            // recovery: the next `kick`/`getReward` cycle sees the same
            // `diff` and re-credits when pool/cap clears.
            uint256 totalCredited = actualSettled + shortfallSettled;
            if (totalCredited > 0) {
                p.rewardDebt = p.rewardDebt + _safeInt256(totalCredited);
            }
        } else {
            // No pending — keep historical behavior: rewardDebt advances to
            // current accumulated (no-op when diff == 0; preserves reset on
            // newly-zero positions).
            p.rewardDebt = accumulated;
        }
        return rs;
    }

    // ════════════════════════════════════════════════════════════════════
    //  Permissionless expired-position decay (Increment D)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Body of `TegridyStaking.kick` (AUDIT MICROSCOPE C3/C4 + DEEP-DS /
    ///         DS2 / DS3 hardening). The host wrapper keeps the `nonReentrant` /
    ///         `whenNotPaused` modifiers and the NoPosition/NoOpKick guards, capturing
    ///         `prior` (the pre-decay boostedAmount) and `holder` (= ownerOf(tokenId)).
    ///         Settles the holder's pre-expiry rewards to `unsettled` BEFORE decay
    ///         (DEEP-DS-02), reverts `KickWouldForfeit` if any pending slice cannot be
    ///         fully credited (BATCH-J2 H8 — never destroy user value silently), then
    ///         decays the boost and writes the post-state checkpoint.
    function kick(
        RewardState memory rs,
        Position storage p,
        uint256 tokenId,
        address holder,
        uint256 prior,
        mapping(address => uint256) storage unsettledRewards,
        mapping(uint256 => uint256) storage unsettledRewardsByTokenId,
        mapping(address => bool) storage isLendingContract,
        mapping(address => uint256) storage lastActivityAt,
        Cfg memory cfg
    ) public returns (RewardState memory) {
        rs = accumulateRewards(rs, cfg);
        // DEEP-DS-02: capture and settle pre-expiry rewards BEFORE decay.
        int256 accumulated = _safeInt256((prior * rs.rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        // DS2-01: do NOT advance p.rewardDebt yet; need the actually-credited amount.
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = cfg.rewardToken.balanceOf(address(this));
            uint256 reserved = cfg.totalStaked + rs.totalUnsettledRewards;
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            // DS2-02: rewardPool shortfall observability.
            if (pending > cappedPending) {
                emit KickRewardPoolShortfall(holder, pending, cappedPending);
            }
            uint256 totalSettled;
            if (cappedPending > 0) {
                uint256 actualSettled;
                (rs, actualSettled) = _settleUnsettled(rs, unsettledRewards, holder, cappedPending, cfg.maxUnsettledRewards);
                if (actualSettled > 0) {
                    // AUDIT FIX 2026-05-26 [L-13]: `kick` credits to unsettled bucket
                    // (NOT a wallet transfer), so emitting `RewardPaid` here was
                    // semantically wrong — `RewardPaid` documents wallet-side transfers.
                    // Switch to `RewardSettledToUnsettled` which exists precisely for
                    // the credit-to-bucket case (DS3-03 fix's distinct event).
                    emit RewardSettledToUnsettled(holder, tokenId, actualSettled);
                    totalSettled += actualSettled;
                    // C-1 / D-LD-H1: per-tokenId attribution for tracked holders.
                    if (_isTrackedHolder(holder, cfg.restakingContract, isLendingContract)) {
                        unsettledRewardsByTokenId[tokenId] += actualSettled;
                    }
                }
            }
            // DS2-02: route the rewardPool shortfall through _settleUnsettled too.
            uint256 shortfall = pending - cappedPending;
            if (shortfall > 0) {
                uint256 actualSettledShortfall;
                (rs, actualSettledShortfall) = _settleUnsettled(rs, unsettledRewards, holder, shortfall, cfg.maxUnsettledRewards);
                if (actualSettledShortfall > 0) {
                    totalSettled += actualSettledShortfall;
                    if (_isTrackedHolder(holder, cfg.restakingContract, isLendingContract)) {
                        unsettledRewardsByTokenId[tokenId] += actualSettledShortfall;
                    }
                }
            }
            // BATCH-J2 H8: never forfeit silently — abort if any pending slice is uncredited.
            if (totalSettled < pending) revert KickWouldForfeit();
            // DS2-01: advance p.rewardDebt by ONLY the actually-credited slice.
            if (totalSettled > 0) {
                p.rewardDebt = p.rewardDebt + _safeInt256(totalSettled);
                // DS2-03: refresh holder activity (non-claim, holder != msg.sender path).
                if (holder != address(0)) lastActivityAt[holder] = block.timestamp;
            }
        }
        // NOTE: the decay (`_decayIfExpired`), the post-decay `_writeCheckpoint`, and the
        // `PositionKicked` emit run HOST-side in the `kick` wrapper after this returns —
        // see TegridyStaking.kick. Splitting them out keeps this function under the
        // via-IR stack-depth limit; ordering (settle → decay → checkpoint) is preserved.
        return rs;
    }

    // ════════════════════════════════════════════════════════════════════
    //  ERC721 post-transition bookkeeping (Increment E)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Body of `TegridyStaking._afterTokenTransfer` — the shared post-transition
    ///         bookkeeping for transferFrom + _mint + _burn. Touches NO reward scalars,
    ///         so it needs no RewardState marshalling. Maintains the per-owner position
    ///         set (M-5), enforces the per-holder cap (FRESH-2026 escrow carve-out) and
    ///         the AlreadyHasPosition EOA guard (incl. EIP-7702 F-60-3), resets
    ///         autoMaxLock on genuine ownership change (TF-07), clears emergency-exit
    ///         requests, updates `userTokenId`, writes voting-power checkpoints, and
    ///         refreshes `lastActivityAt` (paused-conditional, M16-REVISED).
    function afterTokenTransfer(
        address from,
        address to,
        uint256 id,
        mapping(address => EnumerableSet.UintSet) storage positionsByOwner,
        mapping(uint256 => Position) storage positions,
        mapping(address => uint256) storage userTokenId,
        mapping(uint256 => uint256) storage emergencyExitRequests,
        mapping(address => bool) storage isLendingContract,
        address restakingContract
    ) public {
        // NOTE: the two `_writeCheckpoint` calls and the paused-conditional
        // `_touch(to)` run HOST-side after this returns (see TegridyStaking
        // ._afterTokenTransfer) — they sit after BOTH per-owner set updates so the
        // recorded voting power is identical, and splitting them out keeps this
        // function under the via-IR stack-depth limit.

        // AUDIT FIX M-5: maintain the per-owner position set (source of truth for votingPowerOf).
        if (from != address(0)) {
            // slither-disable-next-line unused-return
            positionsByOwner[from].remove(id);
        }
        if (to != address(0)) {
            // FRESH-2026 STAKING-MAX-POS-ESCROW-CARVE-OUT: cap bounds votingPowerOf O(n);
            // restaking + lending escrows short-circuit those views, so carve them out.
            bool isEscrowTo = (to == restakingContract) || isLendingContract[to];
            if (!isEscrowTo && positionsByOwner[to].length() >= MAX_POSITIONS_PER_HOLDER) {
                revert TooManyPositions();
            }
            // slither-disable-next-line unused-return
            positionsByOwner[to].add(id);
        }

        // AUDIT FIX #2 + NEW-L2 + FRESH-2026 F-60-3: EOA single-position guard (incl.
        // EIP-7702 delegated EOAs, code.length == 23), relaxed on lending round-trip.
        uint256 toCodeLen = to.code.length;
        if (
            to != address(0) &&
            userTokenId[to] != 0 &&
            (toCodeLen == 0 || toCodeLen == 23) &&
            !isLendingContract[from]
        ) revert AlreadyHasPosition();

        // AUDIT TF-07: only reset autoMaxLock on a genuine ownership change; round-trips
        // through whitelisted lending / restaking preserve the user's preference.
        bool escrowHop =
            isLendingContract[from] || isLendingContract[to] ||
            from == restakingContract || to == restakingContract;
        if (from != address(0)) {
            if (!escrowHop) {
                positions[id].autoMaxLock = false;
            }
            delete emergencyExitRequests[id];
            userTokenId[from] = 0;
        }
        if (to != address(0)) {
            // AUDIT FIX M-5: signal multi-NFT receipt at a non-restaking contract.
            if (to.code.length > 0 && to != restakingContract && userTokenId[to] != 0) {
                emit MultipleNFTsAtAddress(to, id, userTokenId[to]);
            }
            userTokenId[to] = id;
        }
    }
}
