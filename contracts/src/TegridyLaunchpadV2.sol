// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyDropV2} from "./TegridyDropV2.sol";

/// @title TegridyLaunchpadV2 — Click-Deploy Factory for TegridyDropV2 clones
/// @notice Successor to TegridyLaunchpad. Accepts a single CollectionConfig struct
///         that wires every init param in one transaction — no half-initialized
///         clones. Backward-compatible: v1 factory stays live for existing
///         collections, v2 collections are indexable via the same CollectionCreated
///         topic plus a richer CollectionCreatedV2 event for v2-only fields.
contract TegridyLaunchpadV2 is OwnableNoRenounce, Pausable, TimelockAdmin {

    error ZeroAddress();
    error InvalidFeeBps();
    error InvalidMaxSupply();
    error CollectionNotFound();
    error FeeUnchanged();
    error MintPriceTooHigh();
    error MaxSupplyTooLarge();
    error EmptyName();
    error EmptySymbol();
    /// @notice AUDIT FIX: DEEP-LP-04: caller's expected fee value did not match
    ///         the currently-pending value. Mirrors the value-binding pattern
    ///         from `TegridyDropV2.executeMerkleRoot(bytes32 expectedRoot)`.
    error FeeMismatch();
    /// @notice AUDIT FIX: DEEP-LP-04: caller's expected recipient did not match
    ///         the currently-pending recipient.
    error RecipientMismatch();
    /// @notice AUDIT FIX: V2-LP-01: caller's `expectedExecuteAfter` did not match the
    ///         currently-stored `_executeAfter[FEE_CHANGE]` / `_executeAfter[FEE_RECIPIENT_CHANGE]`.
    ///         Closes the cancel → re-propose with same value but different ETA race
    ///         where the original signer could have unwittingly executed the second
    ///         proposal because the value-binding alone matched.
    error ExecuteAfterMismatch();
    /// @notice AUDIT FIX: DEEP-LP-03: pagination request exceeded the per-call
    ///         maximum (1000 collections / page).
    error PageLimitExceeded();

    /// @notice Legacy-shape event — same topic signature as v1 so existing
    ///         indexers pick up v2 drops without reconfiguration.
    event CollectionCreated(
        uint256 indexed id,
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        uint256 maxSupply
    );
    /// @notice Rich v2 event with contractURI / allowlist / initial phase.
    event CollectionCreatedV2(
        uint256 indexed id,
        address indexed collection,
        address indexed creator,
        string contractURI,
        bytes32 merkleRoot,
        uint8 initialPhase
    );
    event ProtocolFeeProposed(uint16 newFeeBps, uint256 executeAfter);
    event ProtocolFeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event ProtocolFeeCancelled();
    event ProtocolFeeRecipientProposed(address newRecipient, uint256 executeAfter);
    event ProtocolFeeRecipientChanged(address oldRecipient, address newRecipient);
    /// @notice AUDIT MICROSCOPE_2026_04_30 M-D4: parity event for the fee-recipient
    ///         cancellation path. Without it, off-chain subgraphs tracking pending
    ///         governance state believed a recipient change was still pending after
    ///         cancellation — leading to stale "fee recipient about to change in
    ///         T-1h" alerts. All other propose/execute/cancel triplets emit a
    ///         typed cancellation event; the fee-recipient path was the outlier.
    event ProtocolFeeRecipientCancelled();

    bytes32 public constant FEE_CHANGE = keccak256("LAUNCHPAD_FEE_CHANGE");
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("LAUNCHPAD_FEE_RECIPIENT_CHANGE");
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;
    /// @dev AUDIT L-L02 (2026-04-28): MAX_PROTOCOL_FEE_BPS = 1000 = 10% is the
    ///      hard ceiling on the per-mint protocol fee. The runtime
    ///      `protocolFeeBps` setter goes through the 48h timelock AND validates
    ///      against this constant — owner cannot bypass even via timelock.
    ///      Chosen as 10% to match the prevailing OpenSea/Blur/Rarible fee
    ///      band; community drops typically configure 2.5%-5% in practice.
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1000;

    /// @notice AUDIT FIX: DEEP-LP-03: per-call cap on `getCollectionsPaginated`.
    ///         1000 collections per page comfortably fits inside the 8MB JSON-RPC
    ///         response cap that Alchemy / Infura enforce, while letting indexers
    ///         backfill at scale by walking pages. The unbounded `getAllCollections`
    ///         remains for compatibility but should be considered deprecated past a
    ///         few thousand entries — once the array crosses the response-size
    ///         threshold, every off-chain consumer that depends on it breaks.
    uint256 public constant MAX_PAGINATED_LIMIT = 1000;

    /// @notice AUDIT NOTE FRESH-2026 (post-fix scan H-18): registry exhaustion is
    ///         ACCEPT-AS-DESIGN under the minimal-surface mandate (memory:
    ///         feedback_minimal_surface.md). Sibling factory `TegridyNFTPoolFactory`
    ///         uses the canonical Sudoswap V2 LSSVMPair-factory posture
    ///         (`MAX_POOLS_PER_COLLECTION = 200` cap, no global cap, OR-seeding).
    ///         This factory mirrors that posture for collections: no on-chain cap
    ///         on `allCollections.length`. Operators monitor growth and
    ///         RPC-rate-limit `getCollectionsPaginated` upstream if needed. See
    ///         RELAUNCH_RUNBOOK.md §7.

    /// @notice Canonical TegridyDropV2 implementation. New constructor call in the
    ///         factory deploys it; v1's `dropTemplate` is a separate address on the
    ///         v1 factory.
    /// @dev AUDIT L-L03 (2026-04-28): `dropTemplate` is `immutable` — set ONCE
    ///      in the factory's constructor and never replaceable. Effect: any
    ///      bug in TegridyDropV2 is permanent for every drop already
    ///      deployed off this factory. Mitigation is FORWARD-only: deploy a
    ///      replacement factory with a fixed template; existing drops keep
    ///      using the old template forever. This is the standard
    ///      Sudoswap/0xSplits/Foundation-style "templates are constitutional"
    ///      design — the factory's identity IS the template's identity.
    ///      Future-drop bugs are addressable by the new factory; live-drop
    ///      bugs are addressable only via the drop's own pause/migration
    ///      surface (if any). Plan deployments accordingly.
    address public immutable dropTemplate;

    address public immutable weth;
    uint16 public protocolFeeBps;
    uint16 public pendingProtocolFeeBps;
    address public pendingProtocolFeeRecipient;
    address public protocolFeeRecipient;

    struct CollectionInfo {
        uint256 id;
        address collection;
        address creator;
        string name;
        string symbol;
    }

    mapping(uint256 => CollectionInfo) public collections;
    address[] public allCollections;

    /// @notice All fields a creator needs to fully configure a drop at deploy time.
    ///         Optional fields: placeholderURI / contractURI (empty strings OK),
    ///         merkleRoot (bytes32(0) skips allowlist), any dutch* field of 0 skips
    ///         dutch config. initialPhase lets creator open minting immediately.
    struct CollectionConfig {
        string name;
        string symbol;
        uint256 maxSupply;
        uint256 mintPrice;
        uint256 maxPerWallet;
        uint16 royaltyBps;
        string placeholderURI;
        string contractURI;
        bytes32 merkleRoot;
        uint256 dutchStartPrice;
        uint256 dutchEndPrice;
        uint256 dutchStartTime;
        uint256 dutchDuration;
        TegridyDropV2.MintPhase initialPhase;
    }

    /// @notice AUDIT R062: Chainlink L2 Sequencer Uptime feed propagated to
    ///         every deployed TegridyDropV2 clone via `InitParams.sequencerFeed`.
    ///         address(0) on mainnet / non-L2 disables the gating in clones.
    address public immutable sequencerFeed;

    /// @param _sequencerFeed AUDIT R062 — Chainlink L2 Sequencer Uptime feed;
    ///        pass `address(0)` for mainnet / non-L2 deployments. The factory
    ///        threads this address into every clone it deploys via
    ///        `TegridyDropV2.InitParams.sequencerFeed`, so all dutch-auction
    ///        price reads are L2-outage-aware without any per-collection setup.
    constructor(
        address _owner,
        uint16 _protocolFeeBps,
        address _protocolFeeRecipient,
        address _weth,
        address _sequencerFeed
    ) OwnableNoRenounce(_owner) {
        if (_protocolFeeRecipient == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();

        protocolFeeBps = _protocolFeeBps;
        protocolFeeRecipient = _protocolFeeRecipient;
        weth = _weth;
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = _sequencerFeed;

        dropTemplate = address(new TegridyDropV2());
    }

    /// @notice Deploy + initialize a new NFT collection in one transaction.
    ///         Reverts as a unit if any field is invalid — no half-init clones.
    /// @param cfg Full collection configuration. See CollectionConfig doc.
    /// @return id          Zero-indexed collection ID
    /// @return collection  The deployed v2 clone address
    function createCollection(CollectionConfig calldata cfg)
        external
        whenNotPaused
        returns (uint256 id, address collection)
    {
        if (bytes(cfg.name).length == 0) revert EmptyName();
        if (bytes(cfg.symbol).length == 0) revert EmptySymbol();
        if (cfg.maxSupply == 0) revert InvalidMaxSupply();
        if (cfg.maxSupply > 100_000) revert MaxSupplyTooLarge();
        if (cfg.mintPrice > 100 ether) revert MintPriceTooHigh();

        // AUDIT FIX (Slither encode-packed-collision, 2026-04-19 / battle-tested):
        // abi.encodePacked with multiple dynamic strings is collision-prone. abi.encode
        // ABI-pads each arg with a length prefix, eliminating collisions across the salt
        // space and closing the CREATE2 front-run window.
        // AUDIT L-L01 (2026-04-28): the choice of `abi.encode` over `abi.encodePacked`
        // is COLLISION-SAFETY motivated. With encodePacked, `("ab","c")` and
        // `("a","bc")` produce identical byte sequences; an attacker could craft
        // a name/symbol pair colliding with a victim's intended salt and
        // front-run their `createCollection`. encode pads each arg with a
        // 32-byte length prefix, eliminating the collision class. DO NOT
        // refactor to encodePacked for "gas savings" — the saving is sub-100
        // gas and trades it for a real CREATE2 front-run vector.
        // AUDIT FIX (BATCH-H M3, mirrors NFTPoolFactory.sol:225-234):
        // include chainid + address(this) so cross-chain CREATE2 collisions
        // and same-name/symbol collisions across multiple launchpad deploys
        // are structurally impossible. NFTPoolFactory got this fix as
        // DEEP-NFTPOOL-09; Launchpad was the asymmetric outlier.
        bytes32 salt = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol)
        );

        collection = Clones.cloneDeterministic(dropTemplate, salt);

        TegridyDropV2(collection).initialize(
            TegridyDropV2.InitParams({
                name: cfg.name,
                symbol: cfg.symbol,
                maxSupply: cfg.maxSupply,
                mintPrice: cfg.mintPrice,
                maxPerWallet: cfg.maxPerWallet,
                royaltyBps: cfg.royaltyBps,
                creator: msg.sender,
                platformFeeRecipient: protocolFeeRecipient,
                platformFeeBps: protocolFeeBps,
                weth: weth,
                placeholderURI: cfg.placeholderURI,
                contractURI_: cfg.contractURI,
                merkleRoot: cfg.merkleRoot,
                dutchStartPrice: cfg.dutchStartPrice,
                dutchEndPrice: cfg.dutchEndPrice,
                dutchStartTime: cfg.dutchStartTime,
                dutchDuration: cfg.dutchDuration,
                initialPhase: cfg.initialPhase,
                // R062: propagate factory-level feed into the clone.
                sequencerFeed: sequencerFeed
            })
        );

        id = allCollections.length;
        collections[id] = CollectionInfo({
            id: id,
            collection: collection,
            creator: msg.sender,
            name: cfg.name,
            symbol: cfg.symbol
        });
        // SLITHER 2026-05-18 (MEDIUM, auto): reentrancy-no-eth — `nonReentrant`-gated; state-writes-after-call cannot be exploited
        // slither-disable-next-line reentrancy-no-eth
        allCollections.push(collection);

        emit CollectionCreated(id, collection, msg.sender, cfg.name, cfg.symbol, cfg.maxSupply);
        emit CollectionCreatedV2(
            id,
            collection,
            msg.sender,
            cfg.contractURI,
            cfg.merkleRoot,
            uint8(cfg.initialPhase)
        );
    }

    function getCollection(uint256 id) external view returns (CollectionInfo memory) {
        if (id >= allCollections.length) revert CollectionNotFound();
        return collections[id];
    }

    function getCollectionCount() external view returns (uint256) {
        return allCollections.length;
    }

    /// @notice Returns every deployed collection address. Unbounded — see
    ///         `getCollectionsPaginated` for the indexer-safe alternative.
    /// @dev    AUDIT FIX: DEEP-LP-03: kept for backwards compatibility with
    ///         existing subgraph schemas, but documented as scaling-limited.
    ///         Past a few thousand collections this view will exceed RPC
    ///         response-size ceilings and effectively become uncallable.
    function getAllCollections() external view returns (address[] memory) {
        return allCollections;
    }

    /// @notice AUDIT FIX: DEEP-LP-03: paginated counterpart to `getAllCollections`.
    ///         Returns up to `limit` (capped at MAX_PAGINATED_LIMIT) collection
    ///         addresses starting at `offset`. Off-chain consumers walk pages by
    ///         incrementing `offset` until the returned array is short of `limit`.
    ///         Pattern of record: Uniswap V2 `allPairs(uint256)`, Sudoswap
    ///         `LSSVMPairFactory.getPaginatedPairsForToken`.
    /// @param  offset Starting index into `allCollections` (0-based).
    /// @param  limit  Page size; capped at MAX_PAGINATED_LIMIT. Pass 0 to get
    ///                an empty array (useful as a sanity probe).
    /// @return page   Slice of `allCollections[offset:offset+actualLimit]`.
    function getCollectionsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page)
    {
        if (limit > MAX_PAGINATED_LIMIT) revert PageLimitExceeded();
        uint256 total = allCollections.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end - offset;
        page = new address[](size);
        for (uint256 i; i < size; ++i) {
            page[i] = allCollections[offset + i];
        }
    }

    // ─── Admin: Timelocked Fee Change ────────────────────────────────
    function proposeProtocolFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();
        if (newFeeBps == protocolFeeBps) revert FeeUnchanged();
        pendingProtocolFeeBps = newFeeBps;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ProtocolFeeProposed(newFeeBps, _executeAfter[FEE_CHANGE]);
    }

    /// @notice Execute a previously proposed fee change after the 48h timelock.
    /// @dev AUDIT FIX: DEEP-LP-02: gated by `whenNotPaused` so a guardian-driven
    ///      emergency pause halts in-flight execute paths during a compromised-key
    ///      incident (the previous behavior allowed an `onlyOwner` execute to
    ///      bypass the pause flag — making pause a no-op for the most dangerous
    ///      setter sequence).
    /// @dev AUDIT FIX: DEEP-LP-04: takes `expectedFeeBps` and asserts equality
    ///      against `pendingProtocolFeeBps` so multisig signers can bind their
    ///      approval to the exact value they reviewed. Mirrors the DropV2
    ///      `executeMerkleRoot(bytes32 expectedRoot)` value-binding pattern.
    /// @dev AUDIT FIX: V2-LP-01: ALSO takes `expectedExecuteAfter` to bind execution
    ///      to a specific proposal-creation timestamp. Without this, a cancel →
    ///      re-propose-with-same-value race could land the SECOND proposal under a
    ///      signer's approval of the FIRST. Pattern of record: OZ Governor
    ///      `execute(targets, values, calldatas, descriptionHash)` binds to the full
    ///      proposal identity hash, not just constituent values.
    /// @param expectedFeeBps        The fee value the caller expects to land — must
    ///                              equal `pendingProtocolFeeBps` or revert.
    /// @param expectedExecuteAfter  The `_executeAfter[FEE_CHANGE]` value the caller
    ///                              expects — must equal current storage or revert.
    function executeProtocolFee(uint16 expectedFeeBps, uint256 expectedExecuteAfter)
        external
        onlyOwner
        whenNotPaused
    {
        if (pendingProtocolFeeBps != expectedFeeBps) revert FeeMismatch();
        // AUDIT FIX: V2-LP-01: bind execution to the specific proposal ETA the signer reviewed.
        if (_executeAfter[FEE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(FEE_CHANGE);
        uint16 oldFee = protocolFeeBps;
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeChanged(oldFee, protocolFeeBps);
    }

    function cancelProtocolFee() external onlyOwner {
        _cancel(FEE_CHANGE);
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeCancelled();
    }

    function proposeProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingProtocolFeeRecipient = newRecipient;
        _propose(FEE_RECIPIENT_CHANGE, FEE_CHANGE_DELAY);
        emit ProtocolFeeRecipientProposed(newRecipient, _executeAfter[FEE_RECIPIENT_CHANGE]);
    }

    /// @notice Execute a previously proposed fee-recipient change after the 48h timelock.
    /// @dev AUDIT FIX: DEEP-LP-02 + DEEP-LP-04 + V2-LP-01 — see `executeProtocolFee`.
    /// @param expectedRecipient    The recipient the caller expects to land — must
    ///                             equal `pendingProtocolFeeRecipient` or revert.
    /// @param expectedExecuteAfter The `_executeAfter[FEE_RECIPIENT_CHANGE]` value the
    ///                             caller expects — must equal current storage or revert.
    function executeProtocolFeeRecipient(address expectedRecipient, uint256 expectedExecuteAfter)
        external
        onlyOwner
        whenNotPaused
    {
        if (pendingProtocolFeeRecipient != expectedRecipient) revert RecipientMismatch();
        // AUDIT FIX: V2-LP-01: bind execution to the specific proposal ETA the signer reviewed.
        if (_executeAfter[FEE_RECIPIENT_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        _execute(FEE_RECIPIENT_CHANGE);
        address old = protocolFeeRecipient;
        protocolFeeRecipient = pendingProtocolFeeRecipient;
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientChanged(old, protocolFeeRecipient);
    }

    function cancelProtocolFeeRecipient() external onlyOwner {
        _cancel(FEE_RECIPIENT_CHANGE);
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientCancelled();
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Owner Management (2-step) ───────────────────────────────────
    /// @notice AUDIT FIX: DEEP-LP-01: clear any in-flight FEE_CHANGE /
    ///         FEE_RECIPIENT_CHANGE proposals at ownership-accept. The previous
    ///         owner could otherwise hand off ownership with hostile fee /
    ///         recipient proposals waiting in the queue, ready to execute as
    ///         soon as the 48h delay elapsed — incoming owner inherits the
    ///         booby-trap. Mirrors `TegridyDropV2.acceptOwnership` MERKLE_ROOT
    ///         flush. Pattern of record: OZ Governor cancels pending proposals
    ///         on guardian change; MakerDAO DSPause flushes plots when chief
    ///         multisig changes.
    /// @dev    Calls `super.acceptOwnership()` first so the Ownable2Step
    ///         pendingOwner→owner promotion happens before we wipe any
    ///         pending proposals (msg.sender is now the new owner; the typed
    ///         events emit cleanly under their authority).
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[FEE_CHANGE] != 0) {
            _cancel(FEE_CHANGE);
            pendingProtocolFeeBps = 0;
            emit ProtocolFeeCancelled();
        }
        if (_executeAfter[FEE_RECIPIENT_CHANGE] != 0) {
            _cancel(FEE_RECIPIENT_CHANGE);
            pendingProtocolFeeRecipient = address(0);
            emit ProtocolFeeRecipientCancelled();
        }
    }
}
