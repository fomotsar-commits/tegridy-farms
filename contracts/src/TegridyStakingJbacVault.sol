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
    function returnJbac(uint256 stakingTokenId, uint256 jbacTokenId, address to)
        external
        onlyStaking
    {
        if (jbacTokenId == 0) return;
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
