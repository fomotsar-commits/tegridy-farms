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
}
