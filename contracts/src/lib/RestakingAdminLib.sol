// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title  RestakingAdminLib
/// @notice EIP-170 split (2026-06-04): the cold owner-only admin/governance bodies
///         (residual-claimant clear, stuck-reward attribution + sweep, NFT rescue)
///         extracted from TegridyRestaking into a linked (delegatecall) library.
///         PURE SIZE REDUCTION — behaviour byte-identical to the inlined originals.
///
/// @dev    Every function is `public` and is invoked via DELEGATECALL from
///         TegridyRestaking, so it executes in the restaking contract's context:
///         `address(this)`, `msg.sender`, storage slots and token/NFT balances all
///         belong to TegridyRestaking. The library declares NO state of its own —
///         it reaches the host's storage exclusively through the `storage`-reference
///         parameters the host passes in (the canonical OZ "library operating on a
///         caller's storage struct" shape, here delegatecall-linked rather than
///         inlined so the bytecode lives in the library). Pattern of record:
///         `TegridyFactoryLib` (deployPair / assertNotERC777), already live in this
///         codebase. The structs are declared HERE and re-used by the host so the
///         storage-reference types match across the seam.
///
/// @dev    Events are re-declared here with the SAME signatures the host uses, so
///         the topic hashes are identical and off-chain consumers (and the existing
///         test `expectEmit` sites that reference the host's events) match the
///         delegatecall-emitted logs unchanged (a delegatecall emits from the host
///         address). The host retains its own copies of these event declarations for
///         ABI/back-compat; only the EMIT site relocates here.
library RestakingAdminLib {
    using SafeERC20 for IERC20;

    // ─── Shared pending-state structs (host stores these; lib reads/writes them) ──
    /// @dev AUDIT FIX FRESH-2026: F-04-3 — per-tokenId abandoned-residual-clear proposal.
    struct PendingResidualClear {
        address newClaimant;
        uint256 executeAfter;
    }
    /// @dev AUDIT FIX FRESH-2026: M-4 [F-04-2] — pending owner-rescue of a stuck NFT.
    struct PendingRescueNFT {
        uint256 tokenId;
        address to;
    }
    /// @dev SECURITY FIX: 24h-timelocked retro-attribution of stuck base rewards.
    struct PendingAttribution {
        address restaker;
        uint256 amount;
    }

    // ─── Timelock windows (verbatim from the host) ───────────────────────────────
    uint256 internal constant CLEAR_RESIDUAL_TIMELOCK = 7 days;
    uint256 internal constant CLEAR_RESIDUAL_VALIDITY = 7 days;

    // ─── Errors (verbatim signatures from the host) ──────────────────────────────
    error BadParam();
    error ZeroAddress();
    error ExistingProposalPending(bytes32 key);
    error NoPendingResidualClear();
    error ResidualClearTimelockNotElapsed();
    error ResidualClearExpired();
    error NotRestaked();
    error ZeroAmount();
    error CannotSweepBonusToken();
    error CannotSweepRewardToken();

    // ─── Events (same signatures/topics as the host) ─────────────────────────────
    event ResidualClearProposed(uint256 indexed tokenId, address indexed newClaimant, uint256 executeAfter);
    event ResidualClearExecuted(uint256 indexed tokenId, address indexed oldClaimant, address indexed newClaimant);
    event ResidualClearCancelled(uint256 indexed tokenId);
    // EIP-170 split (2026-06-04, part 2d): attribution / sweep-stuck / rescue-NFT
    // execute (+ propose/cancel) bodies relocated here. Events re-declared with the
    // SAME signatures/topics so delegatecall-emitted logs match the host's ABI and
    // the existing expectEmit test sites unchanged.
    event StuckBaseRewardsAttributed(address indexed restaker, uint256 amount);
    event AttributionProposed(address indexed restaker, uint256 amount, uint256 executeAfter);
    event AttributionCancelled(address indexed restaker, uint256 amount);
    event SweepStuckExecuted(address indexed token, uint256 amount);
    event RescueNFTExecuted(uint256 indexed tokenId, address indexed to);

    // ════════════════════════════════════════════════════════════════════════════
    //  Residual-claimant clear (F-04-3) — inline 7-day timelock, no fund movement
    // ════════════════════════════════════════════════════════════════════════════

    /// @notice Verbatim move of `TegridyRestaking.proposeClearResidualClaimant`.
    /// @dev Caller (host wrapper) is `onlyOwner`-gated. Forces a non-zero successor
    ///      (H-RESTAKE-CLEAR-ABANDONS-RESIDUE) and rejects a pending re-proposal
    ///      (M-03) to stop a captured key resetting the 7-day clock.
    function proposeClearResidualClaimant(
        mapping(uint256 => address) storage residualClaimant_,
        mapping(uint256 => PendingResidualClear) storage pendingClears,
        uint256 tokenId,
        address newClaimant
    ) public {
        if (residualClaimant_[tokenId] == address(0)) revert BadParam();
        // H-RESTAKE-CLEAR-ABANDONS-RESIDUE: refuse the "fully abandon" path so the
        // staking-side residue can never silently leak to the next restaker.
        if (newClaimant == address(0)) revert ZeroAddress();
        // M-03: reject when a proposal is already pending (tokenId as the disambiguator).
        if (pendingClears[tokenId].executeAfter != 0) {
            revert ExistingProposalPending(bytes32(tokenId));
        }
        pendingClears[tokenId] = PendingResidualClear({
            newClaimant: newClaimant,
            executeAfter: block.timestamp + CLEAR_RESIDUAL_TIMELOCK
        });
        emit ResidualClearProposed(tokenId, newClaimant, block.timestamp + CLEAR_RESIDUAL_TIMELOCK);
    }

    /// @notice Verbatim move of `TegridyRestaking.executeClearResidualClaimant`.
    function executeClearResidualClaimant(
        mapping(uint256 => address) storage residualClaimant_,
        mapping(uint256 => PendingResidualClear) storage pendingClears,
        uint256 tokenId
    ) public {
        PendingResidualClear memory p = pendingClears[tokenId];
        if (p.executeAfter == 0) revert NoPendingResidualClear();
        if (block.timestamp < p.executeAfter) revert ResidualClearTimelockNotElapsed();
        // 7-day validity so a since-rotated/compromised owner key cannot execute later.
        if (block.timestamp > p.executeAfter + CLEAR_RESIDUAL_VALIDITY) revert ResidualClearExpired();
        address oldClaimant = residualClaimant_[tokenId];
        // propose() rejects newClaimant==0, but keep the defensive branch verbatim.
        if (p.newClaimant == address(0)) {
            delete residualClaimant_[tokenId];
        } else {
            residualClaimant_[tokenId] = p.newClaimant;
        }
        delete pendingClears[tokenId];
        emit ResidualClearExecuted(tokenId, oldClaimant, p.newClaimant);
    }

    /// @notice Verbatim move of `TegridyRestaking.cancelClearResidualClaimant`.
    function cancelClearResidualClaimant(
        mapping(uint256 => PendingResidualClear) storage pendingClears,
        uint256 tokenId
    ) public {
        if (pendingClears[tokenId].executeAfter == 0) revert NoPendingResidualClear();
        delete pendingClears[tokenId];
        emit ResidualClearCancelled(tokenId);
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Stuck-base-reward retro-attribution (24h timelock) — execute body
    // ════════════════════════════════════════════════════════════════════════════

    /// @notice Verbatim move of the post-`_execute` body of
    ///         `TegridyRestaking.executeAttributeStuckRewards`. The host runs the
    ///         TimelockAdmin `_execute(ATTRIBUTION_CHANGE)` gate FIRST (internal base
    ///         fn the lib cannot reach), then calls this for the rest.
    /// @dev    F-2 cap math, NotRestaked re-check, credit + delete + emit — byte-for-byte.
    ///         `restakerTokenId` is `restakers[pendingAttribution.restaker].tokenId`
    ///         read by the host wrapper AFTER `_execute` (host keeps its own RestakeInfo
    ///         struct type; `_execute` does not touch `restakers`, so reading the tokenId
    ///         host-side then passing it preserves the original ordering exactly).
    ///         `totalUnforwardedBase` is a host scalar (value types cannot be storage-ref
    ///         params), so it is passed in and the post-increment value RETURNED for the
    ///         host to re-assign — same SSTORE, same value, same ordering.
    function executeAttributeStuckRewards(
        PendingAttribution storage pendingAttribution,
        uint256 restakerTokenId,
        address rewardToken,
        uint256 totalUnforwardedBase,
        uint256 totalActivePrincipal,
        uint256 totalPendingUnsettled,
        mapping(address => uint256) storage unforwardedBaseRewards
    ) public returns (uint256 newTotalUnforwardedBase) {
        PendingAttribution memory p = pendingAttribution;
        if (restakerTokenId == 0) revert NotRestaked();
        // Cap attribution to actual unattributed rewardToken balance.
        // AUDIT FIX F-2: subtract `totalActivePrincipal` AND `totalPendingUnsettled`
        // from the unattributed pool. Pre-fix, the cap only excluded `totalUnforwardedBase`,
        // letting a captured-or-colluding owner credit a chosen restaker with rewards
        // that were actually backing OTHER users' principal reservations or pending
        // unsettled deferral. The colluder's subsequent `claimAll`/`unrestake` then
        // pulled funds that legitimate restakers needed for their `recoverStuckPrincipal`
        // path — driving honest recoveries to revert with NO_RECOVERABLE_BALANCE.
        // Three-line subtract keeps the cap honest: only TRULY unbacked balance can
        // be retro-attributed.
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        uint256 reserved = totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled;
        // AUDIT 2026-05-30 [slither timestamp FP]: detector misfires on these two
        // comparisons — both are token-balance/amount comparisons, no block.timestamp
        // involved. The `timestamp` detector over-flags any non-trivial > comparison.
        // slither-disable-next-line timestamp
        uint256 unattributed = balance > reserved ? balance - reserved : 0;
        // slither-disable-next-line timestamp
        if (p.amount > unattributed) revert BadParam();
        unforwardedBaseRewards[p.restaker] += p.amount;
        newTotalUnforwardedBase = totalUnforwardedBase + p.amount;
        // `delete pendingAttribution` (host idiom) on a {address;uint256} struct zeroes
        // both fields; replicated field-wise here because `delete` on a storage-pointer
        // PARAMETER is rejected by the compiler (vs. `delete map[key]` in clearResidual).
        // Behaviour-identical: same two slots cleared.
        pendingAttribution.restaker = address(0);
        pendingAttribution.amount = 0;
        emit StuckBaseRewardsAttributed(p.restaker, p.amount);
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Sweep-stuck-token (24h timelock) — execute body
    // ════════════════════════════════════════════════════════════════════════════

    /// @notice Verbatim move of the post-`_execute` body of
    ///         `TegridyRestaking.executeSweepStuckRewards`. Host runs
    ///         `_execute(SWEEP_STUCK_CHANGE)` + clears `pendingSweepStuckToken` FIRST,
    ///         then passes the cached token. Execute-time re-checks + transfer + emit
    ///         move here byte-for-byte.
    function executeSweepStuckRewards(
        address token,
        address bonusRewardToken,
        address rewardToken,
        address staking
    ) public {
        // Re-check guards at execute time — defends against a token classification
        // changing during the 24h window (e.g., rewardToken rotated on staking side
        // via that contract's 48h timelock).
        if (token == bonusRewardToken) revert CannotSweepBonusToken();
        if (token == rewardToken) revert CannotSweepRewardToken();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            // Route to address(staking) (immutable) — see BATCH-J1 H17 rationale.
            IERC20(token).safeTransfer(staking, balance);
            emit SweepStuckExecuted(token, balance);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Rescue-NFT (48h timelock) — execute body
    // ════════════════════════════════════════════════════════════════════════════

    /// @notice Verbatim move of the post-`_execute` body of
    ///         `TegridyRestaking.executeRescueNFT`. Host runs
    ///         `_execute(RESCUE_NFT_CHANGE)` FIRST, then calls this. The three
    ///         execute-time re-checks (tokenIdToRestaker / strandedRestakeRecipient /
    ///         _residualClaimant all == 0) + `delete pendingRescueNFT` + the
    ///         `safeTransferFrom(this, to, tokenId)` + emit move here byte-for-byte.
    function executeRescueNFT(
        PendingRescueNFT storage pendingRescueNFT,
        mapping(uint256 => address) storage tokenIdToRestaker,
        mapping(uint256 => address) storage strandedRestakeRecipient,
        mapping(uint256 => address) storage residualClaimant_,
        address stakingNFT
    ) public {
        PendingRescueNFT memory p = pendingRescueNFT;
        // Re-check at execute (proposal could go stale during 48h window —
        // tokenId re-restaked, user filed stranded claim, etc).
        if (tokenIdToRestaker[p.tokenId] != address(0)) revert BadParam();
        if (strandedRestakeRecipient[p.tokenId] != address(0)) revert BadParam();
        // SELF-AUDIT FIX 2026-05-26 [M-06 SYMMETRIC RECHECK]: also re-check
        // residual claimant at execute time. Pre-fix the propose-time check
        // (M-06) was asymmetric — a residue claim materializing during the 48h
        // window (currently unreachable but defense-in-depth) would let rescue
        // strand the residue. Mirrors the propose-time guard at line ~2199.
        if (residualClaimant_[p.tokenId] != address(0)) revert BadParam();
        // `delete pendingRescueNFT` (host idiom) zeroes both fields; replicated
        // field-wise because `delete` on a storage-pointer PARAMETER is rejected by
        // the compiler. Behaviour-identical: same two slots cleared, BEFORE the
        // external safeTransferFrom (CEI preserved exactly as the host had it).
        pendingRescueNFT.tokenId = 0;
        pendingRescueNFT.to = address(0);
        IERC721(stakingNFT).safeTransferFrom(address(this), p.to, p.tokenId); // M-16
        emit RescueNFTExecuted(p.tokenId, p.to);
    }
}
