// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TegridyStakingJbacVault — JBAC custody sister contract for TegridyStaking
/// @notice Holds physically-deposited JBAC NFTs while their owner has an active
///         staking position with the JBAC boost on TegridyStaking. Also tracks
///         stranded-JBAC reclaim state when the JBAC return transfer reverts
///         (e.g., JBAC contract paused) at exit time.
///
///         AUDIT FIX (pass-8 batch-14): Phase 0.2 finish — extracted from
///         TegridyStaking.sol to bring TegridyStaking under the EIP-170
///         24,576-byte runtime bytecode limit. Mirrors the
///         `*Admin` sister-contract pattern used for SwapFeeRouter / TegridyStaking
///         / TegridyLending / VoteIncentives splits in earlier batches.
///
/// @dev Trust model:
///       - `jbacNFT` and `staking` are immutable, set at deploy time.
///       - `returnJbac` is gated `onlyStaking`. Only the wired TegridyStaking
///         instance can release a custodied JBAC back to the user.
///       - JBAC INBOUND: TegridyStaking calls `jbacNFT.safeTransferFrom(user, vault, id)`
///         from inside `stakeWithBoost`. The user keeps the existing
///         "approve TegridyStaking" UX (no separate vault approval), and
///         the JBAC lands at the vault via `onERC721Received` (gated to the
///         configured jbacNFT sender so no other ERC721 can be dumped here).
///       - `claimStrandedJbac` is gated by the per-tokenId `strandedJbacOwner`
///         record — only the address that held the staking position at close
///         time can reclaim. Wrapped in `nonReentrant`.
///
/// @dev AUDIT FIX FRESH-2026: F-39-3 — DIRECT-TRANSFER STRAND WARNING.
///      The vault's `onERC721Received` only checks `msg.sender == jbacNFT`.
///      It does NOT verify that the inbound transfer originated from
///      `TegridyStaking.stakeWithBoost`. A user who mistakenly calls
///      `jbacNFT.safeTransferFrom(user, vault, tokenId)` directly (instead of
///      going through `staking.stakeWithBoost`) will have their JBAC accepted
///      by the vault with NO position record. The NFT is then PERMANENTLY
///      STRANDED — there is no admin / rescue / recovery surface, by design.
///      This is an intentional tradeoff: an admin recovery hook would
///      reintroduce centralization risk (owner could rugpull custodied JBACs).
///      Front-end / docs MUST surface: "JBACs may only be deposited via
///      `staking.stakeWithBoost`. Direct transfers to the vault are permanent."
///
/// @dev AUDIT FIX FRESH-2026: F-39-4 — IMMUTABLE-STAKING DESIGN.
///      `staking` is `immutable` and there is NO `setStaking()`, `pause()`,
///      `Ownable`, or rescue surface on this vault. If the wired TegridyStaking
///      instance is ever redeployed (V2 fix), the vault remains hard-wired to
///      V1 — only V1 can call `returnJbac`. Operationally this means: the
///      staking-redeploy runbook MUST drain all active positions THROUGH V1
///      (so each `withdraw` path returns its JBAC to the user) BEFORE V2 is
///      switched on. If V1 ever has a bug that blocks `withdraw`, custodied
///      JBACs become unrecoverable. A timelocked `emergencyClaim` escape hatch
///      was deliberately deferred at this batch — adding governance now would
///      reintroduce admin trust and contradict the "no admin surface" promise
///      of the relaunch contract set. Re-evaluate if/when the protocol adopts
///      a timelock + multisig governance layer (full timelock rotation deferred).
contract TegridyStakingJbacVault is ReentrancyGuard, IERC721Receiver {
    /// @notice The JBAC ERC721 collection this vault custodies.
    IERC721 public immutable jbacNFT;

    /// @notice The TegridyStaking instance allowed to `pullJbac` / `returnJbac`.
    address public immutable staking;

    /// @notice Stranded-JBAC reclaim bookkeeping. If the JBAC return transfer
    ///         in `returnJbac` reverts (e.g., JBAC contract paused), we record
    ///         who is entitled to reclaim it via `claimStrandedJbac(stakingTokenId)`.
    mapping(uint256 => address) public strandedJbacOwner;
    mapping(uint256 => uint256) public strandedJbacTokenId;

    error NotStaking();
    error OnlyJbacNFT();
    error Unauthorized();
    error ZeroAmount();
    error ZeroAddress();
    // AUDIT FIX FRESH-2026: F-39-5 — surfaced when `returnJbac`'s gas budget is
    //   too tight to safely run the try/catch + stranded-bookkeeping fallback
    //   on the `catch` branch, so callers (front-ends, AA wallets) can retry
    //   with a higher gas limit instead of silently locking the principal.
    error InsufficientCatchGas();

    event JbacReturned(uint256 indexed stakingTokenId, address indexed to, uint256 jbacTokenId);
    event JbacStranded(uint256 indexed stakingTokenId, address indexed to, uint256 jbacTokenId);

    modifier onlyStaking() {
        if (msg.sender != staking) revert NotStaking();
        _;
    }

    constructor(address _jbacNFT, address _staking) {
        if (_jbacNFT == address(0) || _staking == address(0)) revert ZeroAddress();
        jbacNFT = IERC721(_jbacNFT);
        staking = _staking;
    }

    /// @notice Combined view of the stranded-JBAC reclaim record. Returns
    ///         `(0, 0)` when no stranded record exists. Mirrors the
    ///         convenience getter that lived on TegridyStaking pre-split.
    function getStrandedJbac(uint256 stakingTokenId)
        external
        view
        returns (address owner, uint256 jbacTokenId)
    {
        owner = strandedJbacOwner[stakingTokenId];
        jbacTokenId = strandedJbacTokenId[stakingTokenId];
    }

    /// @notice Called by TegridyStaking from inside `_clearPosition` to return
    ///         a deposited JBAC to its rightful owner. Try-transfer; on revert,
    ///         stranded bookkeeping captures the entitlement so the prior owner
    ///         can later reclaim via `claimStrandedJbac`.
    /// @dev    AUDIT FIX (pass-8 batch-9 / batch-14): CCR-01 invariant — the
    ///         caller (`TegridyStaking._clearPosition`) calls this AFTER `_burn`
    ///         has cleared the staking NFT's `_ownerOf` slot. Any reentrant
    ///         `transferFrom` from inside the JBAC `safeTransferFrom` callback
    ///         reverts on the now-empty staking-side ownership, closing both
    ///         CCR-01 (lending re-escrow) and CCR-02 (ghost restake).
    /// @dev    AUDIT FIX FRESH-2026: F-39-1 — `nonReentrant` added for symmetry
    ///         with `claimStrandedJbac` and to seal cross-call concerns. The
    ///         caller (`_clearPosition`) is single-entry per top-level tx and
    ///         already wrapped, so the modifier is effectively idempotent here
    ///         but eliminates the "asymmetric guard" footgun for any future
    ///         refactor that adds post-transfer state writes.
    /// @dev    AUDIT FIX FRESH-2026: F-39-5 — pre-check that enough gas remains
    ///         for the catch branch's stranded bookkeeping (3 SSTOREs + 1 event,
    ///         ≈ 25k gas), so that a tight metatx / 4337 gas budget can't
    ///         absorb an OOG mid-catch and revert the entire `_clearPosition`,
    ///         locking the staker's principal. Front-ends auto-budget; this
    ///         floor protects contract-mediated callers (Safe modules, AA).
    function returnJbac(uint256 stakingTokenId, uint256 jbacTokenId, address to)
        external
        onlyStaking
        nonReentrant
    {
        if (jbacTokenId == 0) return;
        if (gasleft() < 50_000) revert InsufficientCatchGas();
        try jbacNFT.safeTransferFrom(address(this), to, jbacTokenId) {
            emit JbacReturned(stakingTokenId, to, jbacTokenId);
        } catch {
            strandedJbacOwner[stakingTokenId] = to;
            strandedJbacTokenId[stakingTokenId] = jbacTokenId;
            emit JbacStranded(stakingTokenId, to, jbacTokenId);
        }
    }

    /// @notice Reclaim a JBAC that was stranded when its position was closed
    ///         because the JBAC contract reverted the return transfer (e.g.,
    ///         during JBAC-contract pause). Only the recorded prior owner —
    ///         the address that held the staking position at close time —
    ///         can reclaim. `nonReentrant` guard preserved from prior surface.
    /// @dev    AUDIT L-AUDIT-2026-2 carried over: defensive `jId == 0` check
    ///         prevents the (zero-record, non-zero-`to`) edge from being
    ///         misinterpreted as a valid claim, even on a future JBAC-equivalent
    ///         collection that mints token id 0.
    function claimStrandedJbac(uint256 stakingTokenId) external nonReentrant {
        address to = strandedJbacOwner[stakingTokenId];
        uint256 jId = strandedJbacTokenId[stakingTokenId];
        if (to == address(0) || msg.sender != to) revert Unauthorized();
        if (jId == 0) revert ZeroAmount();
        delete strandedJbacOwner[stakingTokenId];
        delete strandedJbacTokenId[stakingTokenId];
        jbacNFT.safeTransferFrom(address(this), to, jId);
        emit JbacReturned(stakingTokenId, to, jId);
    }

    /// @notice IERC721Receiver — only accepts inbound transfers from the
    ///         configured JBAC collection. Any other ERC721 reverts.
    /// @dev    AUDIT H-1 FIX preserved verbatim from the pre-split surface.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(jbacNFT)) revert OnlyJbacNFT();
        return IERC721Receiver.onERC721Received.selector;
    }
}
