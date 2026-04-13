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
    bytes32 public constant PROTOCOL_FEE_RECIPIENT_CHANGE = keccak256("NFT_PROTOCOL_FEE_RECIPIENT_CHANGE");

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

    /// @notice WETH address passed to each pool clone for safe ETH transfers
    address public immutable weth;

    /// @notice Pending protocol fee recipient (set during timelock proposal)
    address public pendingProtocolFeeRecipient;

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
    event ProtocolFeeRecipientChangeProposed(address indexed oldRecipient, address indexed newRecipient, uint256 executeAfter);
    event ProtocolFeeRecipientChangeExecuted(address indexed oldRecipient, address indexed newRecipient);
    event ProtocolFeeRecipientChangeCancelled(address indexed cancelledRecipient);

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
        address _protocolFeeRecipient,
        address _weth
    ) OwnableNoRenounce(_owner) {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        if (_protocolFeeRecipient == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();

        protocolFeeBps = _protocolFeeBps;
        protocolFeeRecipient = _protocolFeeRecipient;
        weth = _weth;

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
        require(msg.value >= 0.01 ether || initialTokenIds.length > 0, "MIN_DEPOSIT");

        // Deploy minimal proxy clone
        pool = poolImplementation.clone();

        // SECURITY FIX: Pass address(this) as factory so claimProtocolFees() works correctly.
        // Previously passed protocolFeeRecipient, which broke the fee claim mechanism if
        // protocolFeeRecipient was an EOA (couldn't call claimProtocolFees).
        // Pattern: Uniswap V3 Factory — factory is the authorized fee claimer.
        TegridyNFTPool(payable(pool)).initialize(
            nftCollection,
            _poolType,
            _spotPrice,
            _delta,
            _feeBps,
            msg.sender,
            protocolFeeBps,
            address(this),
            weth
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

    /// @notice Get pools for a collection with pagination
    /// @param collection The ERC-721 collection address
    /// @param offset Starting index
    /// @param limit Maximum number of pools to return
    /// @return pools Array of pool addresses in the requested range
    function getPoolsPaginated(
        address collection,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory pools) {
        address[] storage all = _poolsByCollection[collection];
        uint256 total = all.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        pools = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            pools[i] = all[offset + i];
        }
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

    // ─── Admin: Protocol Fee Recipient (Timelocked) ──────────────────────

    /// @notice Propose a protocol fee recipient change (48h timelock)
    /// @param newRecipient New address to receive protocol fees
    function proposeProtocolFeeRecipientChange(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingProtocolFeeRecipient = newRecipient;
        _propose(PROTOCOL_FEE_RECIPIENT_CHANGE, PROTOCOL_FEE_DELAY);
        emit ProtocolFeeRecipientChangeProposed(protocolFeeRecipient, newRecipient, _executeAfter[PROTOCOL_FEE_RECIPIENT_CHANGE]);
    }

    /// @notice Execute a previously proposed protocol fee recipient change after timelock
    function executeProtocolFeeRecipientChange() external onlyOwner {
        _execute(PROTOCOL_FEE_RECIPIENT_CHANGE);
        address oldRecipient = protocolFeeRecipient;
        protocolFeeRecipient = pendingProtocolFeeRecipient;
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientChangeExecuted(oldRecipient, protocolFeeRecipient);
    }

    /// @notice Cancel a pending protocol fee recipient change proposal
    function cancelProtocolFeeRecipientChange() external onlyOwner {
        address cancelled = pendingProtocolFeeRecipient;
        _cancel(PROTOCOL_FEE_RECIPIENT_CHANGE);
        pendingProtocolFeeRecipient = address(0);
        emit ProtocolFeeRecipientChangeCancelled(cancelled);
    }

    /// @notice View helper: get the execute-after timestamp for pending recipient change
    function protocolFeeRecipientChangeTime() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_RECIPIENT_CHANGE];
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

    // ─── Protocol Fee Collection ───────────────────────────────────────

    /// @notice Claim accumulated protocol fees from a specific pool.
    ///         SECURITY FIX: Factory is now the authorized fee claimer (not protocolFeeRecipient).
    ///         Anyone can trigger claims; fees accumulate in the factory then get forwarded.
    /// @param pool The pool address to claim fees from
    function claimPoolFees(address pool) external {
        TegridyNFTPool(payable(pool)).claimProtocolFees();
    }

    /// @notice Batch claim protocol fees from multiple pools.
    /// @param pools Array of pool addresses to claim from
    function claimPoolFeesBatch(address[] calldata pools) external {
        for (uint256 i = 0; i < pools.length; i++) {
            try TegridyNFTPool(payable(pools[i])).claimProtocolFees() {} catch {}
        }
    }

    /// @notice Withdraw accumulated protocol fees to the protocolFeeRecipient (owner only).
    function withdrawProtocolFees() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "NO_FEES");
        (bool ok,) = protocolFeeRecipient.call{value: balance}("");
        require(ok, "TRANSFER_FAILED");
    }

    /// @notice Accept ETH (protocol fees sent by pools)
    receive() external payable {}
}
