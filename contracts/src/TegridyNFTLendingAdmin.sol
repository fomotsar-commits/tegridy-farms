// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to TegridyNFTLending used by the admin's apply
///         hooks and validation reads. Each `apply*` setter on the lending
///         side is `onlyAdmin` (gated on `msg.sender == nftLendingAdmin`).
interface ITegridyNFTLendingApply {
    // ─── apply* setters (each `onlyAdmin` on the lending side) ────────
    function applyProtocolFeeChange(uint256 newFee) external;
    function applyTreasuryChange(address newTreasury) external;
    function applyWhitelistCollection(address collection) external;
    function applyRemoveCollection(address collection) external;
    function applyOriginationFeeChange(uint256 newBps) external;
    function applyMinAprChange(uint256 newBps) external;
    function applySweepUnsolicitedNFT(address collection, uint256 tokenId, address recipient) external;
    function bumpRemovalRetryCount(address collection) external;

    // ─── view-side reads required for validation ──────────────────────
    function MAX_PROTOCOL_FEE_BPS() external view returns (uint256);
    function MAX_ORIGINATION_FEE_BPS() external view returns (uint256);
    function MAX_MIN_APR_BPS() external view returns (uint256);
    function MAX_APR_BPS() external view returns (uint256);
    function REMOVAL_MAX_CANCELLATIONS() external view returns (uint256);

    function protocolFeeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function whitelistedCollections(address collection) external view returns (bool);
    function activeLoansOfCollection(address collection) external view returns (uint256);
    function removalRetryCount(address collection) external view returns (uint256);
}

/// @title TegridyNFTLendingAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on TegridyNFTLending. Dispatches the actual
///         writes to TegridyNFTLending via its `applyXxx` setters (onlyAdmin
///         gated).
/// @dev    AUDIT FIX: EIP170-01 — created during the EIP-170 size-reduction
///         split to bring TegridyNFTLending under the 24,576-byte limit. The
///         pre-fix bytecode was over the EIP-170 ceiling. Functional semantics
///         (delays, ceilings, validity windows, gates, cancel-rate limits) are
///         preserved BYTE-FOR-BYTE; the only behavioural change is that the
///         propose/execute/cancel call sites now live on this sister contract.
///         Mirrors the exact pattern used for `TegridyLendingAdmin` and
///         `SwapFeeRouterAdmin`.
contract TegridyNFTLendingAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors (signatures identical to the pre-split TegridyNFTLending) ─
    error ZeroAddress();
    error FeeTooHigh();
    error OriginationFeeTooHigh();
    error MinAprTooHigh();
    error CollectionAlreadyWhitelisted();
    error CollectionNotCurrentlyWhitelisted();
    error RemovalCancelLimitReached();
    /// @dev AUDIT FIX: LD3-L2 — typed error for the active-loans-present revert.
    error ActiveLoansPresent(address collection, uint256 count);
    /// @dev AUDIT FIX FRESH-2026: F-95-K-7 — `proposeSweepUnsolicitedNFT` would
    ///      seize an NFT recorded as active collateral.
    error NFTIsActiveCollateral();

    // ─── Timelock Operation Keys (verbatim from TegridyNFTLending) ─────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("PROTOCOL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant WHITELIST_ADD = keccak256("WHITELIST_ADD");
    bytes32 public constant WHITELIST_REMOVE = keccak256("WHITELIST_REMOVE");
    bytes32 public constant ORIGINATION_FEE_CHANGE = keccak256("NFT_LENDING_ORIGINATION_FEE_CHANGE"); // AUDIT C7
    bytes32 public constant MIN_APR_CHANGE = keccak256("NFT_LENDING_MIN_APR_CHANGE"); // AUDIT H5
    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — timelock key for the
    ///         owner-only `sweepUnsolicitedNFT` (24h delay).
    bytes32 public constant SWEEP_UNSOLICITED_NFT = keccak256("NFT_LENDING_SWEEP_UNSOLICITED");

    // ─── Timelock Delays (verbatim from TegridyNFTLending) ────────────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;
    uint256 public constant WHITELIST_TIMELOCK = 24 hours;
    uint256 public constant ECONOMICS_TIMELOCK = 48 hours;       // AUDIT C7 / H5

    uint256 public constant MAX_ORIGINATION_FEE_BPS = 200;
    uint256 public constant MAX_MIN_APR_BPS = 1000;

    // ─── Pending Values (for timelocked changes) ──────────────────────
    uint256 public pendingProtocolFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistAdd;
    address public pendingWhitelistRemove;
    uint256 public pendingOriginationFeeBps;
    uint256 public pendingMinAprBps;
    // AUDIT FIX FRESH-2026: F-95-K-7 — pending sweep proposal.
    address public pendingSweepCollection;
    uint256 public pendingSweepTokenId;
    address public pendingSweepRecipient;

    // ─── Wired lending contract ───────────────────────────────────────
    ITegridyNFTLendingApply public immutable lending;

    // ─── Events (proposed/cancelled — "happened" events stay on lending) ─
    event CollectionWhitelistProposed(address indexed collection, uint256 readyAt);
    event CollectionRemovalProposed(address indexed collection, uint256 readyAt);
    event CollectionWhitelistCancelled(address indexed collection);
    event CollectionRemovalCancelled(address indexed collection);
    event ProtocolFeeChangeProposed(uint256 currentBps, uint256 proposedBps, uint256 readyAt);
    event ProtocolFeeChangeCancelled(uint256 cancelledBps);
    event TreasuryChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event TreasuryChangeCancelled(address indexed cancelled);
    event OriginationFeeProposed(uint256 newBps, uint256 readyAt);
    event MinAprProposed(uint256 newBps, uint256 readyAt);
    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — sweep proposal/cancel events.
    event SweepUnsolicitedNFTProposed(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed recipient,
        uint256 readyAt
    );

    constructor(address _lending) OwnableNoRenounce(msg.sender) {
        if (_lending == address(0)) revert ZeroAddress();
        lending = ITegridyNFTLendingApply(_lending);
    }

    // ─── Legacy View Helpers (for test compatibility) ────────────────
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Admin: Collection Whitelist Timelock ────────────────────────

    function proposeWhitelistCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (lending.whitelistedCollections(_collection)) revert CollectionAlreadyWhitelisted();
        // AUDIT FIX (pass-8): NFTLEND-WL-1 — ERC165 preflight. Reject EOAs and
        // contracts that don't claim ERC721 support so a typo / malicious-paste
        // can't whitelist a non-ERC721 contract that would silently no-op
        // `transferFrom` (collateral never escrowed) or trap the lender's
        // principal in a contract that can't release the NFT. Pattern matches
        // OZ's standard ERC165 detection. Wrapped in try/catch because some
        // legitimate ERC721s (e.g. CryptoPunks v1, Sandbox v1) predate ERC165
        // — if the call reverts we conservatively fall through and let the
        // 24h timelock + execute-side check block obvious mistakes.
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): length-23
        //         carve-out — sibling-canonical of TegridyNFTPoolFactory.createPool.
        //         A 7702-delegated EOA (canonical `0xef0100‖addr` pointer, code.length
        //         == 23) whose delegate REVERTS on `supportsInterface` would fall
        //         through the catch below and pass the gate as a "pre-ERC165 ERC721".
        uint256 codeLen = _collection.code.length;
        require(codeLen > 0 && codeLen != 23, "NOT_CONTRACT");
        try IERC165Check(_collection).supportsInterface(0x80ac58cd) returns (bool ok) {
            require(ok, "NOT_ERC721");
        } catch {
            // Pre-ERC165 ERC721 — allow but operator should know.
        }

        pendingWhitelistAdd = _collection;
        _propose(WHITELIST_ADD, WHITELIST_TIMELOCK);

        emit CollectionWhitelistProposed(_collection, _executeAfter[WHITELIST_ADD]);
    }

    function executeWhitelistCollection() external onlyOwner {
        _execute(WHITELIST_ADD);

        address collection = pendingWhitelistAdd;
        pendingWhitelistAdd = address(0);
        // The `CollectionWhitelisted` event is emitted on the lending side.
        lending.applyWhitelistCollection(collection);
    }

    function cancelWhitelistCollection() external onlyOwner {
        _cancel(WHITELIST_ADD);

        address cancelled = pendingWhitelistAdd;
        pendingWhitelistAdd = address(0);

        emit CollectionWhitelistCancelled(cancelled);
    }

    function proposeRemoveCollection(address _collection) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (!lending.whitelistedCollections(_collection)) revert CollectionNotCurrentlyWhitelisted();

        pendingWhitelistRemove = _collection;
        _propose(WHITELIST_REMOVE, WHITELIST_TIMELOCK);

        emit CollectionRemovalProposed(_collection, _executeAfter[WHITELIST_REMOVE]);
    }

    /// @dev AUDIT FIX: LD3-M5 — pre-flight active-loan gate BEFORE `_execute`.
    ///      Pre-fix: `_execute` cleared `_executeAfter[KEY] = 0`, then the
    ///      ACTIVE_LOANS_PRESENT revert rolled the entire tx back. Combined
    ///      with the LD3-M1 cancel-rate-limit, this could permanently brick
    ///      the WHITELIST_REMOVE slot. Now: gate before `_execute` so admin
    ///      can retry the moment loans clear.
    /// @dev AUDIT FIX: LD3-L2 — typed `ActiveLoansPresent` error.
    function executeRemoveCollection() external onlyOwner {
        address collection = pendingWhitelistRemove;
        // AUDIT FIX: LD3-M5 — gate BEFORE `_execute` consumes the proposal slot.
        uint256 active = lending.activeLoansOfCollection(collection);
        if (active > 0) {
            // AUDIT FIX: LD3-L2 — typed error replaces string revert.
            revert ActiveLoansPresent(collection, active);
        }
        _execute(WHITELIST_REMOVE);
        pendingWhitelistRemove = address(0);
        // AUDIT FIX: DEEP-LD-L2 — the cancel-counter reset on a successful
        // execution happens inside lending.applyRemoveCollection so a future
        // legitimate removal cycle can use the full budget again. The
        // `CollectionRemoved` event is emitted on the lending side.
        lending.applyRemoveCollection(collection);
    }

    /// @notice Cancel a pending whitelist removal.
    /// @dev    AUDIT FIX: DEEP-LD-L2 — rate-limited at REMOVAL_MAX_CANCELLATIONS
    ///         consecutive cancels per collection so a captured-owner cannot
    ///         loop cancel-and-re-propose to keep a flagged collection alive
    ///         indefinitely. Counter resets on a successful execution.
    /// @dev    AUDIT FIX: LD3-M1 — gate-then-cancel order: pre-fix the cancel
    ///         was executed first, then the post-bump revert rolled BACK the
    ///         _cancel via tx revert, so `_executeAfter[WHITELIST_REMOVE]`
    ///         stayed non-zero AND the proposal stayed pending forever (since
    ///         `_propose` rejects an existing pending). Now we check the gate
    ///         BEFORE _cancel — over-budget cancels revert without leaving
    ///         the slot in a stuck state.
    function cancelRemoveCollection() external onlyOwner {
        address cancelled = pendingWhitelistRemove;
        // AUDIT FIX: LD3-M1 — gate first, THEN cancel; over-limit revert no
        // longer rolls back a cancel that already cleared the slot.
        // PASS7-NFTLENDING-02 FIX: mirror TegridyLending FRESH-EYES L still-live
        // carve-out. Without this, a captured (or honest-but-slow) admin can
        // `propose → wait for expiry → cancel` 3 times to consume the
        // REMOVAL_MAX_CANCELLATIONS budget on a flagged collection without ever
        // cancelling a live removal — bricking legitimate future removals of
        // that collection. Only count cancels of STILL-LIVE proposals.
        if (cancelled != address(0)) {
            uint256 readyAt = _executeAfter[WHITELIST_REMOVE];
            bool stillLive = readyAt != 0 && block.timestamp <= readyAt + _proposalValidity();
            if (stillLive) {
                if (lending.removalRetryCount(cancelled) >= lending.REMOVAL_MAX_CANCELLATIONS()) {
                    revert RemovalCancelLimitReached();
                }
                // SLITHER: reentrancy-no-eth FP — onlyOwner timelock-admin fn; the only
                // external call is to the trusted `lending` contract, and the state
                // written after (`_cancel` clears `_executeAfter`/`pendingWhitelistRemove`)
                // is only readable by other onlyOwner timelock fns. No theft vector.
                // Mirrors the canonical TegridyLendingAdmin.cancelAcceptedCollateral.
                // slither-disable-next-line reentrancy-no-eth
                lending.bumpRemovalRetryCount(cancelled);
            }
        }

        _cancel(WHITELIST_REMOVE);
        pendingWhitelistRemove = address(0);

        emit CollectionRemovalCancelled(cancelled);
    }

    /// @notice Returns true iff `_collection` has a STILL-LIVE pending
    ///         WHITELIST_REMOVE proposal (i.e., proposed AND not past its
    ///         24h delay + 7d validity window). Consulted by
    ///         TegridyNFTLending.createOffer / acceptOffer.
    /// @dev    AUDIT FIX 2026-05-21 M7-REVISED: consolidated gate. Both
    ///         createOffer and acceptOffer consult one source of truth so a
    ///         captured/forgetful owner can't brick acceptOffer by letting the
    ///         timelock window expire without cancel.
    function collectionPendingRemoval(address _collection) external view returns (bool) {
        if (pendingWhitelistRemove != _collection) return false;
        uint256 _ra = _executeAfter[WHITELIST_REMOVE];
        if (_ra == 0) return false;
        // Past validity window → TimelockAdmin._execute would revert
        // ProposalExpired, so treat as already-cancelled.
        if (block.timestamp > _ra + _proposalValidity()) return false;
        return true;
    }

    // ─── Admin: Protocol Fee Timelock ────────────────────────────────

    function proposeProtocolFeeChange(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > lending.MAX_PROTOCOL_FEE_BPS()) revert FeeTooHigh();

        pendingProtocolFeeBps = _newFeeBps;
        _propose(PROTOCOL_FEE_CHANGE, PROTOCOL_FEE_TIMELOCK);

        emit ProtocolFeeChangeProposed(lending.protocolFeeBps(), _newFeeBps, _executeAfter[PROTOCOL_FEE_CHANGE]);
    }

    function executeProtocolFeeChange() external onlyOwner {
        _execute(PROTOCOL_FEE_CHANGE);

        uint256 v = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        lending.applyProtocolFeeChange(v);
    }

    function cancelProtocolFeeChange() external onlyOwner {
        _cancel(PROTOCOL_FEE_CHANGE);

        uint256 cancelled = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;

        emit ProtocolFeeChangeCancelled(cancelled);
    }

    // ─── Admin: Treasury Timelock ────────────────────────────────────

    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();

        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_TIMELOCK);

        emit TreasuryChangeProposed(lending.treasury(), _newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);

        address v = pendingTreasury;
        pendingTreasury = address(0);
        lending.applyTreasuryChange(v);
    }

    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);

        address cancelled = pendingTreasury;
        pendingTreasury = address(0);

        emit TreasuryChangeCancelled(cancelled);
    }

    // ─── AUDIT C7: Timelocked Origination Fee ────────────────────────
    function proposeOriginationFee(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_ORIGINATION_FEE_BPS) revert OriginationFeeTooHigh();
        pendingOriginationFeeBps = _newBps;
        _propose(ORIGINATION_FEE_CHANGE, ECONOMICS_TIMELOCK);
        emit OriginationFeeProposed(_newBps, _executeAfter[ORIGINATION_FEE_CHANGE]);
    }

    function executeOriginationFeeChange() external onlyOwner {
        _execute(ORIGINATION_FEE_CHANGE);
        uint256 v = pendingOriginationFeeBps;
        pendingOriginationFeeBps = 0;
        lending.applyOriginationFeeChange(v);
    }

    function cancelOriginationFeeChange() external onlyOwner {
        _cancel(ORIGINATION_FEE_CHANGE);
        pendingOriginationFeeBps = 0;
    }

    function originationFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[ORIGINATION_FEE_CHANGE];
    }

    // ─── AUDIT H5: Timelocked Min APR ────────────────────────────────
    function proposeMinApr(uint256 _newBps) external onlyOwner {
        if (_newBps > MAX_MIN_APR_BPS) revert MinAprTooHigh();
        require(_newBps <= lending.MAX_APR_BPS(), "MIN_EXCEEDS_MAX");
        pendingMinAprBps = _newBps;
        _propose(MIN_APR_CHANGE, ECONOMICS_TIMELOCK);
        emit MinAprProposed(_newBps, _executeAfter[MIN_APR_CHANGE]);
    }

    function executeMinAprChange() external onlyOwner {
        _execute(MIN_APR_CHANGE);
        uint256 v = pendingMinAprBps;
        pendingMinAprBps = 0;
        lending.applyMinAprChange(v);
    }

    function cancelMinAprChange() external onlyOwner {
        _cancel(MIN_APR_CHANGE);
        pendingMinAprBps = 0;
    }

    function minAprChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_APR_CHANGE];
    }

    // ─── AUDIT FIX FRESH-2026: F-95-K-7 — stranded-NFT sweep ────────
    //
    // Owner-only, 24h-timelocked sweep that refuses to seize an NFT recorded
    // as active collateral. The propose/execute active-collateral guard runs
    // here (reading loan state via the lending contract); the actual escrow
    // bookkeeping (strandedNFTRecipient) is written on the lending side via
    // applySweepUnsolicitedNFT.

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — propose owner-only sweep
    ///         of an unsolicited NFT into the stranded-recipient queue.
    ///         24h timelock matches WHITELIST_TIMELOCK.
    function proposeSweepUnsolicitedNFT(
        address _collection,
        uint256 _tokenId,
        address _recipient
    ) external onlyOwner {
        if (_collection == address(0)) revert ZeroAddress();
        if (_recipient == address(0)) revert ZeroAddress();
        // Refuse to seize active collateral / stuck-collateral. The lending
        // contract performs the bounded loans[] scan and reverts
        // NFTIsActiveCollateral if the (collection, tokenId) pair is in use.
        // SLITHER: reentrancy-no-eth FP — onlyOwner timelock-admin fn; the only
        // external call is the trusted `lending` pre-check (address(0) recipient =
        // validate-only, no state write), and the pendingSweep*/_propose writes after
        // are only readable by other onlyOwner timelock fns. No theft vector.
        // slither-disable-next-line reentrancy-no-eth
        lending.applySweepUnsolicitedNFT(_collection, _tokenId, address(0));

        pendingSweepCollection = _collection;
        pendingSweepTokenId = _tokenId;
        pendingSweepRecipient = _recipient;
        _propose(SWEEP_UNSOLICITED_NFT, WHITELIST_TIMELOCK);

        emit SweepUnsolicitedNFTProposed(
            _collection,
            _tokenId,
            _recipient,
            _executeAfter[SWEEP_UNSOLICITED_NFT]
        );
    }

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — execute the proposed sweep
    ///         after the 24h timelock has elapsed. The lending side re-runs
    ///         the active-collateral guard (loans may have been created during
    ///         the timelock window) and records strandedNFTRecipient. The
    ///         `SweepUnsolicitedNFTExecuted` event is emitted on the lending
    ///         side. Pull-based: actual ERC721 transfer is deferred to
    ///         `claimStrandedNFT`.
    function executeSweepUnsolicitedNFT() external onlyOwner {
        address collection = pendingSweepCollection;
        uint256 tokenId = pendingSweepTokenId;
        address recipient = pendingSweepRecipient;

        _execute(SWEEP_UNSOLICITED_NFT);

        pendingSweepCollection = address(0);
        pendingSweepTokenId = 0;
        pendingSweepRecipient = address(0);

        lending.applySweepUnsolicitedNFT(collection, tokenId, recipient);
    }

    /// @notice AUDIT FIX FRESH-2026: F-95-K-7 — cancel a pending sweep.
    function cancelSweepUnsolicitedNFT() external onlyOwner {
        _cancel(SWEEP_UNSOLICITED_NFT);
        pendingSweepCollection = address(0);
        pendingSweepTokenId = 0;
        pendingSweepRecipient = address(0);
    }

    /// @notice AUDIT FIX 2026-05-21 M19-PORT: override `acceptOwnership` so that
    ///         any pending proposals queued by the outgoing owner are CANCELLED
    ///         on handoff. Mirrors `TegridyLendingAdmin.acceptOwnership` /
    ///         `SwapFeeRouterAdmin.acceptOwnership`. Without this override, an
    ///         outgoing/compromised owner could queue hostile proposals
    ///         immediately before `transferOwnership`; the timelock would
    ///         silently keep running and the new owner inherits an executable
    ///         booby-trap.
    /// @dev    Calls `super.acceptOwnership()` first so the Ownable2Step
    ///         pendingOwner→owner promotion happens before the cancellations.
    ///         Base `ProposalCancelled(KEY)` events from `_cancel` provide the
    ///         audit trail.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[PROTOCOL_FEE_CHANGE] != 0) {
            uint256 cancelled = pendingProtocolFeeBps;
            _cancel(PROTOCOL_FEE_CHANGE);
            pendingProtocolFeeBps = 0;
            emit ProtocolFeeChangeCancelled(cancelled);
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelled = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelled);
        }
        if (_executeAfter[WHITELIST_ADD] != 0) {
            address cancelled = pendingWhitelistAdd;
            _cancel(WHITELIST_ADD);
            pendingWhitelistAdd = address(0);
            emit CollectionWhitelistCancelled(cancelled);
        }
        if (_executeAfter[WHITELIST_REMOVE] != 0) {
            address cancelled = pendingWhitelistRemove;
            _cancel(WHITELIST_REMOVE);
            pendingWhitelistRemove = address(0);
            emit CollectionRemovalCancelled(cancelled);
        }
        if (_executeAfter[ORIGINATION_FEE_CHANGE] != 0) {
            _cancel(ORIGINATION_FEE_CHANGE);
            pendingOriginationFeeBps = 0;
        }
        if (_executeAfter[MIN_APR_CHANGE] != 0) {
            _cancel(MIN_APR_CHANGE);
            pendingMinAprBps = 0;
        }
        if (_executeAfter[SWEEP_UNSOLICITED_NFT] != 0) {
            _cancel(SWEEP_UNSOLICITED_NFT);
            pendingSweepCollection = address(0);
            pendingSweepTokenId = 0;
            pendingSweepRecipient = address(0);
        }
    }
}

/// @dev Minimal ERC165 interface for the collection preflight check.
interface IERC165Check {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
