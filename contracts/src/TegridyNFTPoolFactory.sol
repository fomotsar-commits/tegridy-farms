// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyNFTPool} from "./TegridyNFTPool.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title TegridyNFTPoolFactory — Deploys and indexes TegridyNFTPool clones
/// @notice Factory for creating sudoswap-style NFT AMM pools using minimal proxy clones.
///         Each pool trades a single ERC-721 collection against ETH with linear bonding curves.
///
///         Features:
///         - Deploy pools with initial ETH + NFT liquidity in one transaction
///         - Per-collection pool indexing for discovery
///         - Best-price pool finders for routers
///         - Timelocked protocol fee changes (admin safety)
contract TegridyNFTPoolFactory is OwnableNoRenounce, Pausable, TimelockAdmin {
    using Clones for address;

    // ─── Timelock Keys ──────────────────────────────────────────────────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("NFT_PROTOCOL_FEE_CHANGE");

    // ─── Constants ──────────────────────────────────────────────────────
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%
    uint256 public constant PROTOCOL_FEE_DELAY = 48 hours;

    // ─── State ──────────────────────────────────────────────────────────
    /// @notice Implementation contract used as the clone template
    address public immutable poolImplementation;

    /// @notice Protocol fee in basis points, applied to every swap
    uint256 public protocolFeeBps;

    /// @notice Pending protocol fee (set during timelock proposal)
    uint256 public pendingProtocolFeeBps;

    /// @notice Address that receives protocol fees from all pools
    address public protocolFeeRecipient;

    /// @notice All pools ever created
    address[] internal _allPools;

    /// @notice Pools indexed by NFT collection address
    mapping(address => address[]) internal _poolsByCollection;

    // ─── Events ─────────────────────────────────────────────────────────
    event PoolCreated(
        address indexed pool,
        address indexed nftCollection,
        TegridyNFTPool.PoolType poolType,
        uint256 spotPrice,
        uint256 delta,
        uint256 feeBps,
        address indexed owner
    );
    event ProtocolFeeChangeProposed(uint256 oldFee, uint256 newFee, uint256 executeAfter);
    event ProtocolFeeChangeExecuted(uint256 oldFee, uint256 newFee);
    event ProtocolFeeChangeCancelled(uint256 cancelledFee);
    event ProtocolFeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // ─── Errors ─────────────────────────────────────────────────────────
    error InvalidFee();
    error ZeroAddress();
    error NoPoolsFound();
    error InsufficientLiquidity();

    // ─── Constructor ────────────────────────────────────────────────────

    /// @param _owner Factory owner (can change protocol fee, pause)
    /// @param _protocolFeeBps Initial protocol fee in basis points
    /// @param _protocolFeeRecipient Address receiving protocol fees
    constructor(
        address _owner,
        uint256 _protocolFeeBps,
        address _protocolFeeRecipient
    ) OwnableNoRenounce(_owner) {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        if (_protocolFeeRecipient == address(0)) revert ZeroAddress();

        protocolFeeBps = _protocolFeeBps;
        protocolFeeRecipient = _protocolFeeRecipient;

        // Deploy the implementation contract (used as clone template)
        poolImplementation = address(new TegridyNFTPool());
    }

    // ─── Pool Creation ──────────────────────────────────────────────────

    /// @notice Create a new NFT AMM pool with optional initial liquidity
    /// @param nftCollection The ERC-721 collection to trade
    /// @param _poolType BUY, SELL, or TRADE
    /// @param _spotPrice Initial spot price in wei
    /// @param _delta Price step per item in wei
    /// @param _feeBps LP fee in basis points (only for TRADE pools)
    /// @param initialTokenIds NFT token IDs to deposit as initial liquidity
    /// @return pool Address of the newly created pool
    function createPool(
        address nftCollection,
        TegridyNFTPool.PoolType _poolType,
        uint256 _spotPrice,
        uint256 _delta,
        uint256 _feeBps,
        uint256[] calldata initialTokenIds
    ) external payable whenNotPaused returns (address pool) {
        if (nftCollection == address(0)) revert ZeroAddress();
        require(nftCollection.code.length > 0, "NOT_CONTRACT");

        // Deploy minimal proxy clone
        pool = poolImplementation.clone();

        // Initialize the pool
        TegridyNFTPool(payable(pool)).initialize(
            nftCollection,
            _poolType,
            _spotPrice,
            _delta,
            _feeBps,
            msg.sender,
            protocolFeeBps,
            protocolFeeRecipient
        );

        // Index the pool
        _allPools.push(pool);
        _poolsByCollection[nftCollection].push(pool);

        // Deposit initial ETH liquidity
        if (msg.value > 0) {
            (bool success,) = pool.call{value: msg.value}("");
            require(success, "ETH_TRANSFER_FAILED");
        }

        // Deposit initial NFT liquidity
        if (initialTokenIds.length > 0) {
            IERC721 nft = IERC721(nftCollection);
            for (uint256 i = 0; i < initialTokenIds.length; i++) {
                nft.safeTransferFrom(msg.sender, pool, initialTokenIds[i]);
            }
        }

        emit PoolCreated(pool, nftCollection, _poolType, _spotPrice, _delta, _feeBps, msg.sender);
    }

    // ─── View: Pool Discovery ───────────────────────────────────────────

    /// @notice Get all pools for a specific NFT collection
    function getPoolsForCollection(address collection) external view returns (address[] memory) {
        return _poolsByCollection[collection];
    }

    /// @notice Get all pools ever created
    function getAllPools() external view returns (address[] memory) {
        return _allPools;
    }

    /// @notice Get the total number of pools created
    function getPoolCount() external view returns (uint256) {
        return _allPools.length;
    }

    /// @notice Find the cheapest pool to buy `numItems` NFTs from a collection
    /// @param collection The ERC-721 collection address
    /// @param numItems Number of items to buy
    /// @return bestPool Address of the cheapest pool (address(0) if none found)
    /// @return bestCost Total cost at the best pool
    function getBestBuyPool(
        address collection,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestCost) {
        address[] storage pools = _poolsByCollection[collection];
        bestCost = type(uint256).max;

        for (uint256 i = 0; i < pools.length; i++) {
            TegridyNFTPool pool = TegridyNFTPool(payable(pools[i]));

            // Skip BUY pools (they buy NFTs, don't sell them)
            if (pool.poolType() == TegridyNFTPool.PoolType.BUY) continue;

            // Skip pools without enough NFTs
            if (pool.getHeldCount() < numItems) continue;

            // Try to get a quote (may revert if price underflows)
            try pool.getBuyQuote(numItems) returns (uint256 cost, uint256) {
                if (cost < bestCost) {
                    bestCost = cost;
                    bestPool = pools[i];
                }
            } catch {
                continue;
            }
        }
    }

    /// @notice Find the highest-paying pool to sell `numItems` NFTs to a collection
    /// @param collection The ERC-721 collection address
    /// @param numItems Number of items to sell
    /// @return bestPool Address of the best-paying pool (address(0) if none found)
    /// @return bestPayout Total payout at the best pool
    function getBestSellPool(
        address collection,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestPayout) {
        address[] storage pools = _poolsByCollection[collection];

        for (uint256 i = 0; i < pools.length; i++) {
            TegridyNFTPool pool = TegridyNFTPool(payable(pools[i]));

            // Skip SELL pools (they sell NFTs, don't buy them)
            if (pool.poolType() == TegridyNFTPool.PoolType.SELL) continue;

            // Try to get a quote (may revert if insufficient ETH or price underflows)
            try pool.getSellQuote(numItems) returns (uint256 payout, uint256) {
                if (payout > bestPayout) {
                    bestPayout = payout;
                    bestPool = pools[i];
                }
            } catch {
                continue;
            }
        }
    }

    // ─── Admin: Protocol Fee (Timelocked) ───────────────────────────────

    /// @notice Propose a protocol fee change (48h timelock)
    /// @param newFeeBps New protocol fee in basis points
    function proposeProtocolFeeChange(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        pendingProtocolFeeBps = newFeeBps;
        _propose(PROTOCOL_FEE_CHANGE, PROTOCOL_FEE_DELAY);
        emit ProtocolFeeChangeProposed(protocolFeeBps, newFeeBps, _executeAfter[PROTOCOL_FEE_CHANGE]);
    }

    /// @notice Execute a previously proposed protocol fee change after timelock
    function executeProtocolFeeChange() external onlyOwner {
        _execute(PROTOCOL_FEE_CHANGE);
        uint256 oldFee = protocolFeeBps;
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeChangeExecuted(oldFee, protocolFeeBps);
    }

    /// @notice Cancel a pending protocol fee change proposal
    function cancelProtocolFeeChange() external onlyOwner {
        uint256 cancelled = pendingProtocolFeeBps;
        _cancel(PROTOCOL_FEE_CHANGE);
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeChangeCancelled(cancelled);
    }

    /// @notice View helper: get the execute-after timestamp for pending fee change
    function protocolFeeChangeTime() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }

    // ─── Admin: Protocol Fee Recipient ──────────────────────────────────

    /// @notice Update the protocol fee recipient address (owner only, immediate)
    /// @param newRecipient New address to receive protocol fees
    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = protocolFeeRecipient;
        protocolFeeRecipient = newRecipient;
        emit ProtocolFeeRecipientUpdated(oldRecipient, newRecipient);
    }

    // ─── Admin: Pause ───────────────────────────────────────────────────

    /// @notice Pause pool creation (emergency)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause pool creation
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Accept protocol fees from pools ────────────────────────────────

    /// @notice Accept ETH (protocol fees sent by pools)
    receive() external payable {}
}
