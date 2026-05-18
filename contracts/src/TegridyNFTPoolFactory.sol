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

    /// @notice AUDIT FIX: DEEP-NFTPOOL-12: minimum delay between successive
    ///         calls to `setEmergencyPaused`. Caps the rate at which the
    ///         factory owner can flip the global circuit breaker.
    uint256 public constant EMERGENCY_PAUSE_COOLDOWN = 6 hours;

    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: per-day rate limit on withdrawals
    ///         from the protocol-fee accumulator. Hard cap above which
    ///         partial withdrawals must wait for the next 24h window.
    uint256 public constant MAX_DAILY_WITHDRAWAL = 1000 ether;

    /// @notice Hard cap on pools per collection.
    /// @dev    AUDIT FIX (pass-8): C5 / LOOP-01 — without a cap, an attacker can
    ///         spam `createPool` for a target collection (≤0.05 ETH each — see
    ///         MIN_DEPOSIT raise below) until `_poolsByCollection[c].length`
    ///         exceeds the eth_call gas budget, bricking router discovery
    ///         (`getBestBuyPool` / `getBestSellPool`) and any aggregator that
    ///         depends on enumeration. 200 is the practical Sudoswap-derived
    ///         ceiling: 200 × ~80k gas/iter ≈ 16M gas — fits in eth_call,
    ///         leaves headroom for try/catch overhead, and is well above any
    ///         legitimate per-collection liquidity profile.
    uint256 public constant MAX_POOLS_PER_COLLECTION = 200;

    /// @notice Floor on the MIN_DEPOSIT spam-deterrent used in createPool.
    /// @dev    AUDIT FIX (pass-8): C5 / LOOP-01 — raised from 0.01 ETH to
    ///         0.05 ETH. At 0.01 ETH per spam pool, 200 pools = 2 ETH (~$5k at
    ///         current prices) which is cheap enough to attack. At 0.05 ETH, the
    ///         200-pool cap costs 10 ETH (~$25k) — still attackable but at a
    ///         level the protocol can detect and rate-limit at the operator
    ///         layer. Combined with MAX_POOLS_PER_COLLECTION the spam vector is
    ///         doubly closed.
    uint256 public constant MIN_DEPOSIT = 0.05 ether;

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

    /// @notice AUDIT FIX: DEEP-NFTPOOL-12: factory-level emergency pause that
    ///         CASCADES to every pool. Each pool reads this flag at swap entry
    ///         and reverts when true. Independent of the factory's
    ///         OZ Pausable (which only stops `createPool`).
    bool public emergencyPaused;
    /// @notice AUDIT FIX: DEEP-NFTPOOL-12: timestamp of the last
    ///         `setEmergencyPaused` call (rate-limit cooldown).
    uint256 public lastEmergencyAt;

    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: daily withdrawal accounting for
    ///         protocol fees. `dayStart` is the timestamp of the start of
    ///         the current 24h window; `withdrawnToday` is the sum withdrawn
    ///         within that window. Both reset on the first withdrawal after
    ///         24h has elapsed.
    uint256 public dayStart;
    uint256 public withdrawnToday;

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
    event ProtocolFeeRecipientChangeProposed(address indexed oldRecipient, address indexed newRecipient, uint256 executeAfter);
    event ProtocolFeeRecipientChangeExecuted(address indexed oldRecipient, address indexed newRecipient);
    event ProtocolFeeRecipientChangeCancelled(address indexed cancelledRecipient);
    /// @notice AUDIT FIX: DEEP-NFTPOOL-11: per-pool fee-claim observability events.
    event PoolFeesClaimed(address indexed pool, uint256 amount);
    event PoolFeesClaimFailed(address indexed pool, bytes reason);
    /// @notice AUDIT FIX: DEEP-NFTPOOL-12: factory-level emergency-pause toggle event.
    event EmergencyPauseSet(bool paused, address indexed by);
    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: per-call cap on protocol-fee withdrawals.
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount, uint256 windowTotal);

    // ─── Errors ─────────────────────────────────────────────────────────
    error InvalidFee();
    error ZeroAddress();
    /// @notice R064 (MEDIUM): caller passed an address to `claimPoolFeesBatch`
    ///         that was not deployed by this factory.
    error NotAPool(address pool);
    /// @notice AUDIT FIX: DEEP-NFTPOOL-12: emergency-pause cooldown not elapsed.
    error EmergencyCooldown();
    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: daily-withdrawal cap exceeded.
    error DailyCapExceeded();
    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: zero-amount withdrawal request.
    error ZeroAmount();

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
    ) external payable whenNotPaused nonReentrant returns (address pool) {
        // AUDIT FIX (BATCH-H M9): added `nonReentrant`. Pre-fix, a malicious
        // `nftCollection` whose `safeTransferFrom` reentered `createPool` could
        // bypass MAX_POOLS_PER_COLLECTION (the cap is read at re-entry before
        // outer push) and deploy multiple pools in one tx. Defense-in-depth.
        if (nftCollection == address(0)) revert ZeroAddress();
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): length-23 carve-out.
        uint256 _ncLen = nftCollection.code.length;
        require(_ncLen > 0 && _ncLen != 23, "NOT_CONTRACT");
        // AUDIT FIX (pass-8): C5 / LOOP-01 — MIN_DEPOSIT raised to 0.05 ETH
        // and per-collection pool count capped at MAX_POOLS_PER_COLLECTION
        // to defeat storage-bloat DoS on router discovery.
        require(msg.value >= MIN_DEPOSIT || initialTokenIds.length > 0, "MIN_DEPOSIT");
        require(_poolsByCollection[nftCollection].length < MAX_POOLS_PER_COLLECTION, "MAX_POOLS_PER_COLLECTION");

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
        // AUDIT FIX: DEEP-NFTPOOL-09: include `block.chainid` and
        // `address(this)` in the salt so cross-chain CREATE2 addresses do not
        // collide between factories deployed at the same address on different
        // chains. Closes 009 M-1 (still-open pre-DEEP).
        bytes32 salt = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                msg.sender,
                _allPools.length,
                nftCollection,
                uint8(_poolType)
            )
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
        // SLITHER 2026-05-18 (MEDIUM, auto): reentrancy-no-eth — `nonReentrant`-gated; state-writes-after-call cannot be exploited
        // slither-disable-next-line reentrancy-no-eth
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
    // SLITHER 2026-05-18 (MEDIUM, auto): unused-return — tuple destructure intentionally binds only needed fields
    // slither-disable-next-line unused-return
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
    // SLITHER 2026-05-18 (MEDIUM, auto): unused-return — tuple destructure intentionally binds only needed fields
    // slither-disable-next-line unused-return
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
    /// @dev AUDIT NFT-CL-M3: brought into parity with `claimPoolFeesBatch`. Pre-fix
    ///      this single-pool variant accepted ANY caller-supplied address and had no
    ///      reentrancy guard. The membership check (`isPool[pool]`) blocks fee-claim
    ///      routing through pools the factory never deployed (a hostile clone of
    ///      the pool surface could be passed here to siphon factory ETH on the next
    ///      `withdrawProtocolFees`). The `nonReentrant` modifier matches the batch
    ///      variant and guards against any future malicious-pool implementation
    ///      that re-enters via the `claimProtocolFees` callback.
    function claimPoolFees(address pool) external nonReentrant {
        if (!isPool[pool]) revert NotAPool(pool);
        // AUDIT FIX: DEEP-NFTPOOL-11: emit a factory-level event for observability.
        uint256 before = address(this).balance;
        TegridyNFTPool(payable(pool)).claimProtocolFees();
        uint256 received = address(this).balance - before;
        emit PoolFeesClaimed(pool, received);
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
            // AUDIT FIX: DEEP-NFTPOOL-11: emit success/failure events per pool
            // so silent failures become observable.
            uint256 before = address(this).balance;
            try TegridyNFTPool(payable(pool)).claimProtocolFees() {
                uint256 received = address(this).balance - before;
                emit PoolFeesClaimed(pool, received);
            } catch (bytes memory reason) {
                emit PoolFeesClaimFailed(pool, reason);
            }
        }
    }

    /// @notice Withdraw accumulated protocol fees to the protocolFeeRecipient (owner only).
    /// @dev    AUDIT FIX: DEEP-NFTPOOL-10: legacy "withdraw all" path now feeds
    ///         through the rate-limited overload so a compromised recipient
    ///         cannot drain everything in a single transaction.
    function withdrawProtocolFees() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "NO_FEES");
        // AUDIT FIX: V2-NFTPOOL-03: cap to `min(balance, MAX_DAILY_WITHDRAWAL
        // - withdrawnToday)` rather than the absolute `MAX_DAILY_WITHDRAWAL`.
        // The prior implementation reverted with `DailyCapExceeded` whenever
        // the day's cap had been partially used (e.g., keeper drained 500 ETH
        // earlier the same day, balance is now 800 ETH, function tried to
        // pass 800 to the rate-limiter and overflowed the cap). The legacy
        // no-arg path is intended as "withdraw what's available" — this fix
        // restores that behavior by computing the remaining-cap on-chain.
        uint256 remainingCap;
        if (block.timestamp >= dayStart + 1 days) {
            // Window will roll inside `_withdrawWithRateLimit`; full cap is
            // available for this transaction.
            remainingCap = MAX_DAILY_WITHDRAWAL;
        } else {
            // Within the same window — only the unused portion is withdrawable.
            remainingCap = MAX_DAILY_WITHDRAWAL - withdrawnToday;
        }
        if (remainingCap == 0) revert DailyCapExceeded();
        uint256 amt = balance < remainingCap ? balance : remainingCap;
        _withdrawWithRateLimit(amt);
    }

    /// @notice AUDIT FIX: DEEP-NFTPOOL-10: rate-limited per-call withdraw.
    ///         Hard caps the cumulative protocol-fee outflow within a 24h
    ///         rolling window to `MAX_DAILY_WITHDRAWAL`.
    function withdrawProtocolFees(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        require(address(this).balance >= amount, "NO_FEES");
        _withdrawWithRateLimit(amount);
    }

    /// @dev AUDIT FIX: DEEP-NFTPOOL-10: shared rate-limit + transfer routine.
    function _withdrawWithRateLimit(uint256 amount) internal {
        // Roll the 24h window if elapsed.
        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            withdrawnToday = 0;
        // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
        // slither-disable-next-line incorrect-equality
        } else if (dayStart == 0) {
            dayStart = block.timestamp;
        }

        if (withdrawnToday + amount > MAX_DAILY_WITHDRAWAL) revert DailyCapExceeded();
        withdrawnToday += amount;

        WETHFallbackLib.safeTransferETHOrWrap(weth, protocolFeeRecipient, amount);
        emit ProtocolFeesWithdrawn(protocolFeeRecipient, amount, withdrawnToday);
    }

    // ─── AUDIT FIX: DEEP-NFTPOOL-12: factory emergency pause cascade ─────

    /// @notice Toggle the global emergency-pause flag that cascades to every
    ///         pool. Each pool reads `factory.emergencyPaused()` at swap entry
    ///         and reverts when true. Rate-limited via a 6-hour cooldown
    ///         between successive flips so a captured owner key cannot grief
    ///         pause/unpause-spam against legitimate users.
    function setEmergencyPaused(bool paused) external onlyOwner {
        // AUDIT FIX: V2-NFTPOOL-02: cooldown applies only when ENTERING the
        // paused state (false -> true). Corrective unpause (true -> false) is
        // always allowed at any time so a hasty / mistaken pause can be
        // reverted immediately. Anti-grief still holds: an attacker who flips
        // pause cannot re-pause within the cooldown window. Pattern matches
        // Compound's PauseGuardian / Aave's emergency admin (instant unpause,
        // rate-limited pause).
        if (paused && lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
            revert EmergencyCooldown();
        }
        emergencyPaused = paused;
        // AUDIT FIX V3-NFTPOOL-02: only update `lastEmergencyAt` when ENTERING
        // the paused state. Pre-fix the timestamp was updated unconditionally
        // (including on unpause), which armed the pause-cooldown for 6 hours
        // every time the legitimate operator unpaused — letting an attacker
        // who briefly captures the key call `setEmergencyPaused(false)` on an
        // already-unpaused pool just to lock the legitimate owner out of any
        // future protective pause. The asymmetric pattern matches Compound's
        // PauseGuardian (instant unpause, rate-limited pause).
        if (paused) lastEmergencyAt = block.timestamp;
        emit EmergencyPauseSet(paused, msg.sender);
    }

    /// @notice AUDIT FIX 2026-05-16 M19: override `acceptOwnership` so that any
    ///         pending PROTOCOL_FEE_CHANGE / PROTOCOL_FEE_RECIPIENT_CHANGE proposals
    ///         seeded by the outgoing owner are CANCELLED automatically on handoff.
    ///         Mirrors the canonical DEEP-LP-01 pattern from TegridyLaunchpadV2
    ///         (acceptOwnership override at TegridyLaunchpadV2.sol:424-436). Without
    ///         this override, an outgoing/compromised owner could `proposeProtocolFeeChange`
    ///         (or recipient) immediately before `transferOwnership`, and the 48h timer
    ///         would silently keep running under the new owner. A new-owner deploy/keeper
    ///         script reading `pendingProtocolFeeBps()` could then execute the hostile
    ///         change without realizing it.
    /// @dev    Calls `super.acceptOwnership()` first so the pendingOwner→owner promotion
    ///         happens before the cancellations; the typed cancellation events emit under
    ///         the NEW owner's authority for clean audit trail.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[PROTOCOL_FEE_CHANGE] != 0) {
            uint256 cancelled = pendingProtocolFeeBps;
            _cancel(PROTOCOL_FEE_CHANGE);
            pendingProtocolFeeBps = 0;
            emit ProtocolFeeChangeCancelled(cancelled);
        }
        if (_executeAfter[PROTOCOL_FEE_RECIPIENT_CHANGE] != 0) {
            address cancelled = pendingProtocolFeeRecipient;
            _cancel(PROTOCOL_FEE_RECIPIENT_CHANGE);
            pendingProtocolFeeRecipient = address(0);
            emit ProtocolFeeRecipientChangeCancelled(cancelled);
        }
    }

    /// @notice Accept ETH (protocol fees sent by pools)
    receive() external payable {}
}
