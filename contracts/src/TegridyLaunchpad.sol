// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyDrop} from "./TegridyDrop.sol";

/// @title TegridyLaunchpad — Factory for deploying TegridyDrop clones via CREATE2
/// @notice Allows anyone to create an NFT collection. Each collection is a minimal proxy
///         (EIP-1167) of a canonical TegridyDrop template. Uses CREATE2 for deterministic
///         addresses. Protocol fee changes are timelocked.
contract TegridyLaunchpad is OwnableNoRenounce, Pausable, TimelockAdmin {

    // ─── Custom Errors ───────────────────────────────────────────────
    error ZeroAddress();
    error InvalidFeeBps();
    error InvalidMaxSupply();
    error CollectionNotFound();
    error FeeUnchanged();

    // ─── Events ──────────────────────────────────────────────────────
    event CollectionCreated(
        uint256 indexed id,
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        uint256 maxSupply
    );
    event ProtocolFeeProposed(uint16 newFeeBps, uint256 executeAfter);
    event ProtocolFeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event ProtocolFeeCancelled();
    event ProtocolFeeRecipientProposed(address newRecipient, uint256 executeAfter);
    event ProtocolFeeRecipientChanged(address oldRecipient, address newRecipient);

    // ─── Timelock Keys ───────────────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("LAUNCHPAD_FEE_CHANGE");
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("LAUNCHPAD_FEE_RECIPIENT_CHANGE");
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;

    // ─── State ───────────────────────────────────────────────────────
    /// @notice Canonical TegridyDrop implementation that all clones point to
    address public immutable dropTemplate;

    /// @notice WETH address passed to each TegridyDrop clone
    address public immutable weth;

    /// @notice Protocol fee in basis points taken from each collection's revenue
    uint16 public protocolFeeBps;

    /// @notice Pending protocol fee for timelocked change
    uint16 public pendingProtocolFeeBps;

    /// @notice AUDIT TF-14 (Spartan LOW): hard cap on protocolFeeBps.
    ///         The prior 10000 (100%) limit allowed a future governance capture to
    ///         drain all collection revenue into protocol fees. 1000 (10%) is well
    ///         above any realistic marketplace fee and leaves headroom; anything
    ///         higher is a footgun.
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%

    /// @notice Pending fee recipient for timelocked change
    address public pendingProtocolFeeRecipient;

    /// @notice Address that receives the protocol fee share on withdraw
    address public protocolFeeRecipient;

    /// @notice Collection info struct
    struct CollectionInfo {
        uint256 id;
        address collection;
        address creator;
        string name;
        string symbol;
    }

    /// @notice Mapping from collection ID to info
    mapping(uint256 => CollectionInfo) public collections;

    /// @notice All deployed collection addresses
    address[] public allCollections;

    // ─── Constructor ─────────────────────────────────────────────────
    /// @param _owner              Admin / owner of the launchpad
    /// @param _protocolFeeBps     Initial protocol fee in basis points
    /// @param _protocolFeeRecipient Address that receives protocol fees
    /// @param _weth               WETH address passed to TegridyDrop clones
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

        // Deploy the canonical template once
        dropTemplate = address(new TegridyDrop());
    }

    // ─── Collection Factory ──────────────────────────────────────────
    /// @notice Deploy a new NFT collection as a CREATE2 clone of the template.
    /// @param _name         Collection name (ERC721 metadata)
    /// @param _symbol       Collection symbol (ERC721 metadata)
    /// @param _maxSupply    Maximum number of tokens in the collection
    /// @param _mintPrice    Price per token in wei
    /// @param _maxPerWallet Max tokens per wallet (0 = unlimited)
    /// @param _royaltyBps   ERC-2981 royalty in basis points
    /// @return id           The collection ID (0-indexed)
    /// @return collection   The deployed clone address
    function createCollection(
        string calldata _name,
        string calldata _symbol,
        uint256 _maxSupply,
        uint256 _mintPrice,
        uint256 _maxPerWallet,
        uint16 _royaltyBps
    ) external whenNotPaused returns (uint256 id, address collection) {
        require(bytes(_name).length > 0, "Empty name");
        require(bytes(_symbol).length > 0, "Empty symbol");
        if (_maxSupply == 0) revert InvalidMaxSupply();
        require(_maxSupply <= 100_000, "Max supply too large");
        require(_mintPrice <= 100 ether, "Mint price too high");

        // Deterministic salt: creator + collection count ensures uniqueness
        bytes32 salt = keccak256(
            abi.encodePacked(msg.sender, allCollections.length, _name, _symbol)
        );

        // Deploy EIP-1167 minimal proxy via CREATE2
        collection = Clones.cloneDeterministic(dropTemplate, salt);

        // Initialize the clone
        TegridyDrop(collection).initialize(
            _name,
            _symbol,
            _maxSupply,
            _mintPrice,
            _maxPerWallet,
            _royaltyBps,
            msg.sender,             // creator = caller
            protocolFeeRecipient,
            protocolFeeBps,
            weth
        );

        // Store collection info
        id = allCollections.length;
        collections[id] = CollectionInfo({
            id: id,
            collection: collection,
            creator: msg.sender,
            name: _name,
            symbol: _symbol
        });
        allCollections.push(collection);

        emit CollectionCreated(id, collection, msg.sender, _name, _symbol, _maxSupply);
    }

    // ─── Collection Queries ──────────────────────────────────────────
    /// @notice Get collection info by ID
    function getCollection(uint256 id) external view returns (CollectionInfo memory) {
        if (id >= allCollections.length) revert CollectionNotFound();
        return collections[id];
    }

    /// @notice Get the total number of collections deployed
    function getCollectionCount() external view returns (uint256) {
        return allCollections.length;
    }

    /// @notice Get all deployed collection addresses
    function getAllCollections() external view returns (address[] memory) {
        return allCollections;
    }

    // ─── Admin: Timelocked Fee Change ────────────────────────────────
    /// @notice Propose a protocol fee change (48h timelock)
    /// @param newFeeBps New fee in basis points
    function proposeProtocolFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();
        if (newFeeBps == protocolFeeBps) revert FeeUnchanged();
        pendingProtocolFeeBps = newFeeBps;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ProtocolFeeProposed(newFeeBps, _executeAfter[FEE_CHANGE]);
    }

    /// @notice Execute a previously proposed fee change after the timelock
    function executeProtocolFee() external onlyOwner {
        _execute(FEE_CHANGE);
        uint16 oldFee = protocolFeeBps;
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeChanged(oldFee, protocolFeeBps);
    }

    /// @notice Cancel a pending protocol fee change
    function cancelProtocolFee() external onlyOwner {
        _cancel(FEE_CHANGE);
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeCancelled();
    }

    // ─── Admin: Fee Recipient (Timelocked — MakerDAO DSPause pattern) ──
    /// SECURITY FIX: Added 48h timelock matching proposeProtocolFee.
    /// Previously instant — inconsistent with codebase security posture.

    /// @notice Propose a protocol fee recipient change (48h timelock)
    /// @param newRecipient The proposed new fee recipient
    function proposeProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingProtocolFeeRecipient = newRecipient;
        _propose(FEE_RECIPIENT_CHANGE, FEE_CHANGE_DELAY);
        emit ProtocolFeeRecipientProposed(newRecipient, _executeAfter[FEE_RECIPIENT_CHANGE]);
    }

    /// @notice Execute a previously proposed fee recipient change after timelock
    function executeProtocolFeeRecipient() external onlyOwner {
        _execute(FEE_RECIPIENT_CHANGE);
        address old = protocolFeeRecipient;
        protocolFeeRecipient = pendingProtocolFeeRecipient;
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientChanged(old, protocolFeeRecipient);
    }

    /// @notice Cancel a pending fee recipient change
    function cancelProtocolFeeRecipient() external onlyOwner {
        _cancel(FEE_RECIPIENT_CHANGE);
        pendingProtocolFeeRecipient = address(0);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────
    /// @notice Pause new collection creation
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause collection creation
    function unpause() external onlyOwner {
        _unpause();
    }
}
