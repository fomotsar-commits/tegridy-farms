// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyNFTPool} from "./TegridyNFTPool.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";
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
contract TegridyNFTPoolFactory is OwnableNoRenounce, Pausable, TimelockAdmin, ReentrancyGuard {
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

    /// @notice R064 (MEDIUM): O(1) membership check for pools created by this
    ///         factory. Set to true atomically with `_allPools.push` in
    ///         `createPool`. Used by `claimPoolFeesBatch` to reject arbitrary
    ///         caller-supplied addresses (preventing accidental routing of
    ///         fee claims through pools the factory does not control).
    ///         Storage-stable: appended after existing slots.
    mapping(address => bool) public isPool;

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
    /// @notice R064 (MEDIUM): caller passed an address to `claimPoolFeesBatch`
    ///         that was not deployed by this factory.
    error NotAPool(address pool);

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
        // AUDIT NEW-L8 (LOW): reject zero-fee deployments. Pools snapshot the factory
        // fee at init and never update, so deploying with fee=0 ships a whole
        // factory where every pool earns the protocol $0 forever. Keep this as an
        // explicit deploy-time guard; the ops team can raise fees via the timelocked
        // propose path later if they want to change the default.
        if (_protocolFeeBps == 0) revert InvalidFee();
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

        // AUDIT H-08: deploy via CREATE2 with a deterministic salt that includes the
        // caller, the pool counter, and the target collection. The prior Clones.clone()
        // path made the pool address nonce-dependent, which let a front-runner observing
        // a pending createPool() deploy their own pool at a predictable-to-them address
        // ahead of the victim and siphon router discovery / first-liquidity advantage.
        // Salt components:
        //   msg.sender      — binds the address to the creator (no cross-user collision)
        //   _allPools.length — makes repeated calls by the same user produce distinct addresses
        //   nftCollection   — ties the pool address to the specific collection
        //   _poolType       — ties the address to the chosen pool type
        // initialize() runs in the same transaction so there's no separable hijack window.
        bytes32 salt = keccak256(
            abi.encodePacked(msg.sender, _allPools.length, nftCollection, uint8(_poolType))
        );
        pool = poolImplementation.cloneDeterministic(salt);

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
        // R064 (MEDIUM): mark for O(1) membership lookups in claimPoolFeesBatch.
        isPool[pool] = true;

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
    /// @dev R064 (LOW): UNBOUNDED enumeration of `_poolsByCollection`. Each
    ///      pool incurs external CALLs into `pool.poolType()`,
    ///      `pool.getHeldCount()`, and `pool.getBuyQuote(numItems)`, so this
    ///      view CAN exceed the eth_call gas limit on collections with many
    ///      pools. Routers / frontends that need bounded gas MUST use
    ///      `getBestBuyPoolPaginated` and aggregate the best across pages
    ///      off-chain. Kept for backwards compatibility.
    function getBestBuyPool(
        address collection,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestCost) {
        return _bestBuyIn(collection, 0, _poolsByCollection[collection].length, numItems);
    }

    /// @notice Find the highest-paying pool to sell `numItems` NFTs to a collection
    /// @param collection The ERC-721 collection address
    /// @param numItems Number of items to sell
    /// @return bestPool Address of the best-paying pool (address(0) if none found)
    /// @return bestPayout Total payout at the best pool
    /// @dev R064 (LOW): UNBOUNDED enumeration — see warning on
    ///      `getBestBuyPool`. Use `getBestSellPoolPaginated` for bounded gas.
    function getBestSellPool(
        address collection,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestPayout) {
        return _bestSellIn(collection, 0, _poolsByCollection[collection].length, numItems);
    }

    /// @notice R064 (LOW): paginated cheapest-buy-pool finder. Scans
    ///         `_poolsByCollection[collection][startIdx .. startIdx+count)`
    ///         and returns the best within that window. Off-chain callers
    ///         iterate pages and pick the global best across pages.
    /// @param collection The ERC-721 collection address
    /// @param startIdx Starting index into `_poolsByCollection[collection]` (inclusive)
    /// @param count Maximum number of pools to scan from `startIdx`
    /// @param numItems Number of items to buy
    /// @return bestPool Address of the cheapest pool in the window (address(0) if none)
    /// @return bestCost Total cost at the best pool in the window;
    ///         `type(uint256).max` when no pool quoted (matches legacy contract).
    function getBestBuyPoolPaginated(
        address collection,
        uint256 startIdx,
        uint256 count,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestCost) {
        return _bestBuyIn(collection, startIdx, count, numItems);
    }

    /// @notice R064 (LOW): paginated highest-paying-sell-pool finder. Same
    ///         shape as `getBestBuyPoolPaginated`. Returns `(address(0), 0)`
    ///         when no pool quoted.
    function getBestSellPoolPaginated(
        address collection,
        uint256 startIdx,
        uint256 count,
        uint256 numItems
    ) external view returns (address bestPool, uint256 bestPayout) {
        return _bestSellIn(collection, startIdx, count, numItems);
    }

    /// @dev Shared internal: scan window `[startIdx, startIdx+count)` for cheapest buy.
    ///      Preserves the legacy `getBestBuyPool` return contract:
    ///      `bestCost = type(uint256).max` and `bestPool = address(0)` when
    ///      no quote lands. Callers that aggregate across pages should treat
    ///      `bestPool == address(0)` as the empty signal.
    function _bestBuyIn(
        address collection,
        uint256 startIdx,
        uint256 count,
        uint256 numItems
    ) internal view returns (address bestPool, uint256 bestCost) {
        bestCost = type(uint256).max;
        address[] storage pools = _poolsByCollection[collection];
        uint256 total = pools.length;
        if (startIdx >= total) return (bestPool, bestCost);
        uint256 end = startIdx + count;
        if (end > total) end = total;

        for (uint256 i = startIdx; i < end; i++) {
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

    /// @dev Shared internal: scan window `[startIdx, startIdx+count)` for highest-paying sell.
    function _bestSellIn(
        address collection,
        uint256 startIdx,
        uint256 count,
        uint256 numItems
    ) internal view returns (address bestPool, uint256 bestPayout) {
        address[] storage pools = _poolsByCollection[collection];
        uint256 total = pools.length;
        if (startIdx >= total) return (address(0), 0);
        uint256 end = startIdx + count;
        if (end > total) end = total;

        for (uint256 i = startIdx; i < end; i++) {
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
    /// @dev R064 (MEDIUM): the prior version accepted ARBITRARY caller-supplied
    ///      addresses and swallowed every error. An attacker could pass a
    ///      hostile contract that gas-griefs (`assert(false)` style) the
    ///      loop, or simply pollute the success path by routing the call
    ///      through a pool-shaped address the factory never deployed. We
    ///      now:
    ///        1. assert membership via `isPool[pool]` — only pools created by
    ///           THIS factory can be batch-claimed.
    ///        2. continue swallowing per-pool failures (so one stuck pool
    ///           doesn't DoS the whole batch) but ONLY for pools we ourselves
    ///           deployed.
    ///        3. add `nonReentrant` so a malicious pool implementation (in a
    ///           future upgrade) cannot re-enter through `claimProtocolFees`
    ///           to double-claim.
    function claimPoolFeesBatch(address[] calldata pools) external nonReentrant {
        for (uint256 i = 0; i < pools.length; i++) {
            address pool = pools[i];
            if (!isPool[pool]) revert NotAPool(pool);
            try TegridyNFTPool(payable(pool)).claimProtocolFees() {} catch {}
        }
    }

    /// @notice Withdraw accumulated protocol fees to the protocolFeeRecipient (owner only).
    /// SECURITY FIX: Use WETHFallbackLib to prevent fees getting stuck if recipient can't receive ETH.
    /// Previously used raw .call{value, gas: 10000} which would revert permanently if recipient
    /// is a multisig or contract that needs more than 10k gas for receive().
    function withdrawProtocolFees() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "NO_FEES");
        WETHFallbackLib.safeTransferETHOrWrap(weth, protocolFeeRecipient, balance);
    }

    /// @notice Accept ETH (protocol fees sent by pools)
    receive() external payable {}
}
