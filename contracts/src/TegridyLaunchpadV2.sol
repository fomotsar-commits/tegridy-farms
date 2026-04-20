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

    bytes32 public constant FEE_CHANGE = keccak256("LAUNCHPAD_FEE_CHANGE");
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("LAUNCHPAD_FEE_RECIPIENT_CHANGE");
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1000;

    /// @notice Canonical TegridyDropV2 implementation. New constructor call in the
    ///         factory deploys it; v1's `dropTemplate` is a separate address on the
    ///         v1 factory.
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

    constructor(
        address _owner,
        uint16 _protocolFeeBps,
        address _protocolFeeRecipient,
        address _weth
    ) OwnableNoRenounce(_owner) {
        if (_protocolFeeRecipient == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();

        protocolFeeBps = _protocolFeeBps;
        protocolFeeRecipient = _protocolFeeRecipient;
        weth = _weth;

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
        bytes32 salt = keccak256(
            abi.encode(msg.sender, allCollections.length, cfg.name, cfg.symbol)
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
                initialPhase: cfg.initialPhase
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

    function getAllCollections() external view returns (address[] memory) {
        return allCollections;
    }

    // ─── Admin: Timelocked Fee Change ────────────────────────────────
    function proposeProtocolFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();
        if (newFeeBps == protocolFeeBps) revert FeeUnchanged();
        pendingProtocolFeeBps = newFeeBps;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ProtocolFeeProposed(newFeeBps, _executeAfter[FEE_CHANGE]);
    }

    function executeProtocolFee() external onlyOwner {
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

    function executeProtocolFeeRecipient() external onlyOwner {
        _execute(FEE_RECIPIENT_CHANGE);
        address old = protocolFeeRecipient;
        protocolFeeRecipient = pendingProtocolFeeRecipient;
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientChanged(old, protocolFeeRecipient);
    }

    function cancelProtocolFeeRecipient() external onlyOwner {
        _cancel(FEE_RECIPIENT_CHANGE);
        pendingProtocolFeeRecipient = address(0);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
