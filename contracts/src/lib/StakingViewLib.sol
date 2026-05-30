// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// EIP-170 split (2026-05-30): swapped to Solady EnumerableSetLib (API-identical for
// UintSet → Uint256Set; smaller bytecode; verbatim battle-tested).
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Minimal restaking-view surface used by `resolveJbac`. Mirrors the
///      ITegridyRestakingView.tokenIdToRestaker selector in TegridyStaking.
interface ITegridyRestakingView {
    function tokenIdToRestaker(uint256 tokenId) external view returns (address);
}

/// @notice Staking position struct. Relocated to file level (from inside
///         TegridyStaking) during the EIP-170 split so the linked view library
///         below can operate on `positions` storage. Layout is byte-identical to
///         the original in-contract struct — the `positions` public-getter ABI is
///         unchanged.
struct Position {
    uint256 amount;
    uint256 boostedAmount;
    int256 rewardDebt;
    uint64 lockEnd;
    uint16 boostBps;
    uint32 lockDuration;
    bool autoMaxLock;
    bool hasJbacBoost;
    uint64 stakeTimestamp;
    uint256 jbacTokenId;
    bool jbacDeposited;
}

/// @title StakingViewLib
/// @notice EIP-170 split (C1): read-only view/math extracted from TegridyStaking
///         into a linked (delegatecall) library. PURE SIZE REDUCTION — behaviour is
///         byte-for-byte identical to the original in-contract functions. Every
///         function here is read-only (view/pure); because the library is invoked
///         via delegatecall it shares the caller's storage, but holding zero write
///         paths means it cannot corrupt staking state. The caller (TegridyStaking)
///         keeps thin wrappers that apply the restaking/lending carve-out guards
///         then delegate the iteration/math here.
library StakingViewLib {
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;

    // Mirror of the TegridyStaking constants used by the extracted math. These are
    // universal protocol constants (must equal the contract's values).
    uint256 internal constant BOOST_PRECISION = 10000;
    uint256 internal constant ACC_PRECISION = 1e18;

    /// @dev EIP-170 split + DRY: the JBAC re-validation block that was copy-pasted inline
    ///      in `getReward`, `toggleAutoMaxLock`, and `extendLock`. Behaviour byte-identical
    ///      to the three inline copies (F3-PERMA-STRIP preserved: transient lookup failure
    ///      leaves the cached flag intact). Collapsing 3 copies of security-critical code
    ///      to 1 body reduces attack surface AND removes drift risk between sites.
    ///      Caller pattern: if (jbacValid) newBoost += JBAC_BONUS_BPS;
    ///                      else if (clearStaleFlag) p.hasJbacBoost = false;
    /// @dev Visibility intentionally `internal`: the 3 callsites in TegridyStaking get
    ///      inlined at each callsite (same bytecode shape as the pre-refactor inline
    ///      copies), so the DRY consolidation is a SOURCE-LEVEL win for audit / review
    ///      without paying the ~250 B per-callsite delegatecall wrapper overhead that
    ///      `public` visibility would incur. Verified against measured sizes 2026-05-30.
    function resolveJbac(
        Position storage p,
        uint256 tokenId,
        address caller,
        address restakingContract,
        IERC721 jbacNFT
    ) internal view returns (bool jbacValid, bool clearStaleFlag) {
        address jbacHolder = caller;
        bool lookupOk = true;
        if (caller == restakingContract && restakingContract != address(0)) {
            try ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId) returns (address depositor) {
                if (depositor != address(0)) jbacHolder = depositor;
            } catch {
                lookupOk = false;
            }
        }
        jbacValid = p.jbacDeposited || (p.hasJbacBoost && lookupOk && jbacNFT.balanceOf(jbacHolder) > 0);
        clearStaleFlag = !jbacValid && p.hasJbacBoost && lookupOk;
    }

    /// @dev Aggregated active voting power across every position in `set`.
    ///      Equivalent to the original TegridyStaking.votingPowerOf loop (post
    ///      restaking/lending carve-out, which the caller applies before delegating).
    /// @dev Visibility kept `public`: the for-loop body (~300 B inlined) is LARGER
    ///      than the ~250 B delegatecall wrapper it would replace. Measured 2026-05-30:
    ///      flipping to internal added +104 B to TegridyStaking. The trick only works
    ///      for cheaply-bodied functions (see resolveJbac).
    function votingPowerOf(
        EnumerableSetLib.Uint256Set storage set,
        mapping(uint256 => Position) storage positions
    ) public view returns (uint256 total) {
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        for (uint256 i; i < len; ++i) {
            Position storage p = positions[set.at(i)];
            uint256 amount = p.amount;
            if (amount == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            total += (amount * p.boostBps) / BOOST_PRECISION;
        }
    }

    /// @dev Amount-weighted average active boostBps. Mirrors
    ///      TegridyStaking.aggregateActiveBoostBps (post carve-out).
    /// @dev Visibility kept `public` — same for-loop-too-big trade-off as votingPowerOf.
    function aggregateActiveBoostBps(
        EnumerableSetLib.Uint256Set storage set,
        mapping(uint256 => Position) storage positions
    ) public view returns (uint256 weightedBps) {
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        uint256 totalAmount;
        uint256 totalBoosted;
        for (uint256 i; i < len; ++i) {
            Position storage p = positions[set.at(i)];
            uint256 amt = p.amount;
            if (amt == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            totalAmount += amt;
            totalBoosted += amt * p.boostBps;
        }
        if (totalAmount == 0) return 0;
        weightedBps = totalBoosted / totalAmount;
    }

    /// @dev Memory variant of `earned` for off-chain callers (external contracts) that
    ///      cannot pass `storage` pointers. Body byte-identical to the storage variant
    ///      below — kept side-by-side so any future audit fix to one MUST land in the
    ///      other (compiler enforces no shared body, so this comment is the discipline).
    ///      Caller pattern: read `positions(tokenId)` tuple from the staking contract,
    ///      pack into Position memory, pass here with the relevant scalar reads.
    function earnedFromMem(
        Position memory p,
        uint256 rewardPerTokenStored,
        uint256 lastUpdateTime,
        uint256 rewardRate,
        uint256 totalBoostedStake,
        uint256 available,
        uint256 totalStaked,
        uint256 totalUnsettledRewards
    ) internal view returns (uint256) {
        if (p.boostedAmount == 0) return 0;
        uint256 currentAcc = rewardPerTokenStored;
        if (block.timestamp > lastUpdateTime && totalBoostedStake > 0) {
            uint256 reward = (block.timestamp - lastUpdateTime) * rewardRate;
            uint256 reserved = totalStaked + totalUnsettledRewards;
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            if (reward > rewardPool) reward = rewardPool;
            if (reward > 0) {
                currentAcc += (reward * ACC_PRECISION) / totalBoostedStake;
            }
        }
        uint256 v = (p.boostedAmount * currentAcc) / ACC_PRECISION;
        if (v > uint256(type(int256).max)) return 0;
        int256 diff = int256(v) - p.rewardDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    /// @dev Pending rewards for a position. Mirrors TegridyStaking.earned, including
    ///      the AUDIT FIX M-01 expired-position accrual semantics.
    function earned(
        Position storage p,
        uint256 rewardPerTokenStored,
        uint256 lastUpdateTime,
        uint256 rewardRate,
        uint256 totalBoostedStake,
        uint256 available,
        uint256 totalStaked,
        uint256 totalUnsettledRewards
    ) public view returns (uint256) {
        if (p.boostedAmount == 0) return 0;
        uint256 currentAcc = rewardPerTokenStored;
        if (block.timestamp > lastUpdateTime && totalBoostedStake > 0) {
            // AUDIT FIX (earned pool-cap): mirror StakingRewardLib.accumulateRewards —
            // the live accrual caps the elapsed reward to the unreserved pool
            // (balance - totalStaked - totalUnsettledRewards). Pre-fix this view advanced
            // currentAcc by the full `elapsed * rewardRate` with NO cap, over-reporting
            // claimable vs what `getReward` actually pays whenever the pool is under-funded.
            uint256 reward = (block.timestamp - lastUpdateTime) * rewardRate;
            uint256 reserved = totalStaked + totalUnsettledRewards;
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            if (reward > rewardPool) reward = rewardPool;
            if (reward > 0) {
                currentAcc += (reward * ACC_PRECISION) / totalBoostedStake;
            }
        }
        // AUDIT FIX 2026-05-26 [M-18]: guard the int256 cast against the
        // `_safeInt256` invariant. Pre-fix, this view used a raw `int256(...)`
        // cast — at extreme reward-pool inputs (boostedAmount × currentAcc above
        // 2^255), the cast wraps to a large negative and `diff > 0` returns 0
        // (UI lies "no pending"). Practical caps make this unreachable today,
        // but the view violated the contract's own SafeCast discipline. Fix:
        // bail to 0 when the product exceeds int256.max — matches the host's
        // intent (view should never return >= int256.max as positive).
        uint256 v = (p.boostedAmount * currentAcc) / ACC_PRECISION;
        if (v > uint256(type(int256).max)) return 0;
        int256 diff = int256(v) - p.rewardDebt;
        return diff > 0 ? uint256(diff) : 0;
    }
}
