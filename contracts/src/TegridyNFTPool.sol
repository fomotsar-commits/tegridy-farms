// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @title TegridyNFTPool — Sudoswap-inspired NFT AMM pool (clone template)
/// @notice Each pool trades a single ERC-721 collection against ETH using a linear bonding curve.
///         Deployed as a minimal proxy clone by TegridyNFTPoolFactory.
///
///         Pool types:
///         - BUY:   Pool holds ETH, buys NFTs from sellers
///         - SELL:  Pool holds NFTs, sells to buyers
///         - TRADE: Two-sided market with LP fee
///
///         Pricing (linear bonding curve):
///         - Buy N:  totalCost  = N * spotPrice + delta * N*(N-1)/2, then spotPrice += delta*N
///         - Sell N: totalPayout = N * spotPrice - delta * N*(N+1)/2, then spotPrice -= delta*N
contract TegridyNFTPool is IERC721Receiver, ReentrancyGuard, Pausable, Initializable {
    // ─── Enums ──────────────────────────────────────────────────────────
    enum PoolType { BUY, SELL, TRADE }

    // ─── State ──────────────────────────────────────────────────────────
    IERC721 public nftCollection;
    PoolType public poolType;
    uint256 public spotPrice;
    uint256 public delta;
    uint256 public feeBps;          // LP fee for TRADE pools (basis points, max 9000)
    uint256 public protocolFeeBps;  // Protocol fee (basis points, max 1000)
    address public owner;
    address public factory;
    address public weth;            // SECURITY FIX: WETH for safe ETH transfers (Solmate/Seaport pattern)

    /// @dev Held NFT token IDs — array for enumeration, mapping for O(1) lookup
    uint256[] internal _heldIds;
    mapping(uint256 => uint256) internal _idToIndex; // tokenId => index+1 (0 = not held)

    /// @dev Accumulated protocol fees (pull pattern — factory claims via claimProtocolFees)
    uint256 public accumulatedProtocolFees;

    // ─── Constants ──────────────────────────────────────────────────────
    uint256 public constant MAX_FEE_BPS = 9000;       // 90% max LP fee
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% max protocol fee
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DELTA = 100 ether;   // SECURITY FIX: Upper bound on delta (matches initialize cap)

    // ─── Errors (additional) ────────────────────────────────────────────
    error Expired();
    error MaxCostExceeded();
    error TooManyItems();
    error DeltaTooHigh();
    error NotFactory();

    // ─── Events ─────────────────────────────────────────────────────────
    event PoolInitialized(
        address indexed nftCollection,
        PoolType poolType,
        uint256 spotPrice,
        uint256 delta,
        uint256 feeBps,
        address indexed owner
    );
    event SwapETHForNFTs(address indexed buyer, uint256[] tokenIds, uint256 totalCost);
    event SwapNFTsForETH(address indexed seller, uint256[] tokenIds, uint256 totalPayout);
    event LiquidityAdded(address indexed provider, uint256[] tokenIds, uint256 ethAmount);
    event LiquidityRemoved(address indexed provider, uint256[] tokenIds, uint256 ethAmount);
    event SpotPriceChanged(uint256 oldPrice, uint256 newPrice);
    event DeltaChanged(uint256 oldDelta, uint256 newDelta);
    event FeeChanged(uint256 oldFee, uint256 newFee);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event NFTsWithdrawn(address indexed to, uint256[] tokenIds);
    event ProtocolFeePaid(address indexed factory, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────
    error NotOwner();
    error InvalidPoolType();
    error InvalidFee();
    error InvalidPrice();
    error InsufficientETH();
    error InsufficientPayout();
    error NFTNotHeld(uint256 tokenId);
    error NFTAlreadyHeld(uint256 tokenId);
    error PriceUnderflow();
    error PriceUnderflowMaxSellable(uint256 maxSellable);
    error EmptySwap();
    error ETHTransferFailed();
    error PoolTypeMismatch();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor (disable initializers on template) ──────────────────
    constructor() {
        _disableInitializers();
    }

    // ─── Initialization ─────────────────────────────────────────────────

    /// @notice Initialize the pool (called once by factory after clone deployment)
    /// @param _nftCollection The ERC-721 collection this pool trades
    /// @param _poolType BUY, SELL, or TRADE
    /// @param _spotPrice Initial price in wei for the first item
    /// @param _delta Price increment/decrement per item traded
    /// @param _feeBps LP fee in basis points (only used for TRADE pools)
    /// @param _owner Pool owner (liquidity provider)
    /// @param _protocolFeeBps Protocol fee in basis points
    /// @param _factory Factory address (receives protocol fees)
    function initialize(
        address _nftCollection,
        PoolType _poolType,
        uint256 _spotPrice,
        uint256 _delta,
        uint256 _feeBps,
        address _owner,
        uint256 _protocolFeeBps,
        address _factory,
        address _weth
    ) external initializer {
        require(_nftCollection != address(0), "ZERO_COLLECTION");
        require(_owner != address(0), "ZERO_OWNER");
        require(_factory != address(0), "ZERO_FACTORY");
        require(_weth != address(0), "ZERO_WETH");
        require(_spotPrice > 0, "ZERO_PRICE");
        if (_delta > MAX_DELTA) revert DeltaTooHigh();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();

        // Only TRADE pools may have a non-zero LP fee
        if (_poolType == PoolType.TRADE) {
            if (_feeBps > MAX_FEE_BPS) revert InvalidFee();
        } else {
            require(_feeBps == 0, "FEE_ONLY_FOR_TRADE");
        }

        nftCollection = IERC721(_nftCollection);
        poolType = _poolType;
        spotPrice = _spotPrice;
        delta = _delta;
        feeBps = _feeBps;
        owner = _owner;
        protocolFeeBps = _protocolFeeBps;
        factory = _factory;
        weth = _weth;

        emit PoolInitialized(_nftCollection, _poolType, _spotPrice, _delta, _feeBps, _owner);
    }

    // ─── Swap: Buy NFTs with ETH ────────────────────────────────────────

    /// @notice Buy specific NFTs from the pool by paying ETH
    /// @param tokenIds The NFT token IDs to purchase
    /// @param maxTotalCost Maximum ETH the buyer is willing to spend (slippage protection)
    /// @param deadline Timestamp by which the transaction must be mined
    /// @dev Excess ETH is refunded to the buyer
    function swapETHForNFTs(
        uint256[] calldata tokenIds,
        uint256 maxTotalCost,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        if (poolType == PoolType.BUY) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // Calculate cost using bonding curve
        (uint256 inputAmount, uint256 protocolFee) = _getBuyPrice(numItems);
        if (inputAmount > maxTotalCost) revert MaxCostExceeded();
        if (msg.value < inputAmount) revert InsufficientETH();

        // Update spot price
        spotPrice += delta * numItems;

        // Transfer NFTs to buyer
        for (uint256 i = 0; i < numItems; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }

        // Accumulate protocol fee (pull pattern)
        if (protocolFee > 0) {
            accumulatedProtocolFees += protocolFee;
            emit ProtocolFeePaid(factory, protocolFee);
        }

        // Refund excess ETH
        uint256 excess = msg.value - inputAmount;
        if (excess > 0) {
            _sendETH(msg.sender, excess);
        }

        emit SwapETHForNFTs(msg.sender, tokenIds, inputAmount);
    }

    // ─── Swap: Sell NFTs for ETH ────────────────────────────────────────

    /// @notice Sell NFTs to the pool and receive ETH
    /// @param tokenIds The NFT token IDs to sell
    /// @param minOutput Minimum ETH the seller expects to receive (slippage protection)
    /// @param deadline Timestamp by which the transaction must be mined
    function swapNFTsForETH(
        uint256[] calldata tokenIds,
        uint256 minOutput,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        if (poolType == PoolType.SELL) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // Calculate payout using bonding curve
        (uint256 outputAmount, uint256 protocolFee) = _getSellPrice(numItems);
        if (outputAmount < minOutput) revert InsufficientPayout();

        // Update spot price
        spotPrice -= delta * numItems;

        // Transfer NFTs from seller to pool (onERC721Received handles _addHeldId)
        for (uint256 i = 0; i < numItems; i++) {
            nftCollection.safeTransferFrom(msg.sender, address(this), tokenIds[i]);
        }

        // Accumulate protocol fee (pull pattern)
        if (protocolFee > 0) {
            accumulatedProtocolFees += protocolFee;
            emit ProtocolFeePaid(factory, protocolFee);
        }

        // Pay seller
        _sendETH(msg.sender, outputAmount);

        emit SwapNFTsForETH(msg.sender, tokenIds, outputAmount);
    }

    // ─── Liquidity Management ───────────────────────────────────────────

    /// @notice Add ETH and/or NFTs as liquidity (owner only)
    /// @param tokenIds NFT token IDs to deposit
    function addLiquidity(uint256[] calldata tokenIds) external payable onlyOwner nonReentrant {
        // Transfer NFTs from owner to pool (onERC721Received handles _addHeldId)
        for (uint256 i = 0; i < tokenIds.length; i++) {
            nftCollection.safeTransferFrom(msg.sender, address(this), tokenIds[i]);
        }

        emit LiquidityAdded(msg.sender, tokenIds, msg.value);
    }

    /// @notice Remove ETH and/or NFTs from the pool (owner only)
    /// @param tokenIds NFT token IDs to withdraw
    /// @param ethAmount Amount of ETH to withdraw
    function removeLiquidity(
        uint256[] calldata tokenIds,
        uint256 ethAmount
    ) external onlyOwner nonReentrant {
        // Withdraw NFTs
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }

        // Withdraw ETH — SECURITY FIX: exclude protocol fees from available balance (caught in re-audit)
        if (ethAmount > 0) {
            require(address(this).balance - accumulatedProtocolFees >= ethAmount, "INSUFFICIENT_ETH");
            _sendETH(msg.sender, ethAmount);
        }

        emit LiquidityRemoved(msg.sender, tokenIds, ethAmount);
    }

    // ─── Owner Parameter Changes ────────────────────────────────────────

    /// @notice Change the spot price (owner only)
    function changeSpotPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        uint256 oldPrice = spotPrice;
        spotPrice = newPrice;
        emit SpotPriceChanged(oldPrice, newPrice);
    }

    /// @notice Change the delta (price step) (owner only)
    /// SECURITY FIX: Added upper bound check matching initialize cap (Sudoswap V2 pattern)
    function changeDelta(uint256 newDelta) external onlyOwner {
        if (newDelta > MAX_DELTA) revert DeltaTooHigh();
        uint256 oldDelta = delta;
        delta = newDelta;
        emit DeltaChanged(oldDelta, newDelta);
    }

    /// @notice Change the LP fee (owner only, TRADE pools only)
    function changeFee(uint256 newFee) external onlyOwner {
        if (poolType != PoolType.TRADE) revert PoolTypeMismatch();
        if (newFee > MAX_FEE_BPS) revert InvalidFee();
        uint256 oldFee = feeBps;
        feeBps = newFee;
        emit FeeChanged(oldFee, newFee);
    }

    /// @notice Withdraw ETH from the pool (owner only)
    /// @dev Cannot withdraw ETH reserved for accumulated protocol fees
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0 && address(this).balance - accumulatedProtocolFees >= amount, "INVALID_AMOUNT");
        _sendETH(msg.sender, amount);
        emit ETHWithdrawn(msg.sender, amount);
    }

    /// @notice Withdraw specific NFTs from the pool (owner only)
    function withdrawNFTs(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }
        emit NFTsWithdrawn(msg.sender, tokenIds);
    }

    // ─── Pause (owner only) ─────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Protocol Fee Claim (pull pattern) ──────────────────────────────

    /// @notice Claim accumulated protocol fees (factory only)
    function claimProtocolFees() external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        uint256 amount = accumulatedProtocolFees;
        if (amount == 0) return;
        accumulatedProtocolFees = 0;
        _sendETH(factory, amount);
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get the total ETH cost to buy `numItems` NFTs from this pool
    /// @return inputAmount Total cost including all fees
    /// @return protocolFee Protocol fee portion
    function getBuyQuote(uint256 numItems) external view returns (uint256 inputAmount, uint256 protocolFee) {
        return _getBuyPrice(numItems);
    }

    /// @notice Get the total ETH payout for selling `numItems` NFTs to this pool
    /// @return outputAmount Net payout after all fees
    /// @return protocolFee Protocol fee portion
    function getSellQuote(uint256 numItems) external view returns (uint256 outputAmount, uint256 protocolFee) {
        return _getSellPrice(numItems);
    }

    /// @notice Get all NFT token IDs currently held by this pool
    function getHeldTokenIds() external view returns (uint256[] memory) {
        return _heldIds;
    }

    /// @notice Get the number of NFTs held by this pool
    function getHeldCount() external view returns (uint256) {
        return _heldIds.length;
    }

    /// @notice Check if a specific token ID is held by this pool
    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return _idToIndex[tokenId] != 0;
    }

    /// @notice Get comprehensive pool information
    function getPoolInfo()
        external
        view
        returns (
            address _nftCollection,
            PoolType _poolType,
            uint256 _spotPrice,
            uint256 _delta,
            uint256 _feeBps,
            uint256 _protocolFeeBps,
            address _owner,
            uint256 _numNFTs,
            uint256 _ethBalance
        )
    {
        return (
            address(nftCollection),
            poolType,
            spotPrice,
            delta,
            feeBps,
            protocolFeeBps,
            owner,
            _heldIds.length,
            address(this).balance
        );
    }

    /// @notice Get the maximum number of items that can be sold before hitting price underflow
    /// @return maxSellable Number of items sellable before spotPrice would go to zero or below
    function getMaxSellable() public view returns (uint256 maxSellable) {
        if (delta == 0) {
            // With zero delta, price never decreases — unlimited sells (capped at practical max)
            return type(uint256).max;
        }
        // We need: spotPrice > delta * numItems
        // => numItems < spotPrice / delta
        // => maxSellable = (spotPrice - 1) / delta  (integer division gives floor)
        maxSellable = (spotPrice - 1) / delta;
    }

    // ─── IERC721Receiver ────────────────────────────────────────────────

    /// @notice Handle ERC-721 safe transfers. Only accepts NFTs from the configured collection.
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        // Only accept NFTs from the configured collection
        require(msg.sender == address(nftCollection), "WRONG_COLLECTION");
        // Track the token if not already tracked (direct safeTransferFrom)
        if (_idToIndex[tokenId] == 0) {
            _addHeldId(tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Accept ETH deposits (for initial liquidity from factory)
    receive() external payable {}

    // ─── Internal: Bonding Curve Pricing ────────────────────────────────

    /// @dev Calculate the total cost to buy `numItems` NFTs
    ///      totalCost = N * spotPrice + delta * N * (N - 1) / 2
    ///      Then add LP fee (TRADE pools) and protocol fee
    function _getBuyPrice(uint256 numItems)
        internal
        view
        returns (uint256 inputAmount, uint256 protocolFee)
    {
        if (numItems == 0) revert EmptySwap();

        // Base cost from bonding curve
        uint256 baseCost = numItems * spotPrice + delta * numItems * (numItems - 1) / 2;

        // Verify no individual price is zero or negative
        // The last item price = spotPrice + delta * (numItems - 1)
        // For buys, prices increase, so the first price (spotPrice) is the minimum
        if (spotPrice == 0) revert PriceUnderflow();

        // LP fee (only for TRADE pools)
        uint256 lpFee = 0;
        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = baseCost * feeBps / BPS;
        }

        // Protocol fee
        protocolFee = baseCost * protocolFeeBps / BPS;

        inputAmount = baseCost + lpFee + protocolFee;
    }

    /// @dev Calculate the total payout for selling `numItems` NFTs
    ///      totalPayout = N * spotPrice - delta * N * (N + 1) / 2
    ///      Then subtract LP fee (TRADE pools) and protocol fee
    function _getSellPrice(uint256 numItems)
        internal
        view
        returns (uint256 outputAmount, uint256 protocolFee)
    {
        if (numItems == 0) revert EmptySwap();

        // Check that the last item price is positive
        // Last sell price = spotPrice - delta * numItems
        // (after selling numItems, the new spotPrice would be spotPrice - delta * numItems)
        // The lowest price paid is for the last item: spotPrice - delta * numItems
        // But in the sum formula: each item i (0-indexed) has price = spotPrice - delta * (i + 1)
        // So item 0 pays spotPrice - delta, item 1 pays spotPrice - 2*delta, ..., item N-1 pays spotPrice - N*delta
        // We need spotPrice - delta * numItems > 0 => spotPrice > delta * numItems
        if (delta * numItems >= spotPrice) {
            uint256 maxSellable = getMaxSellable();
            revert PriceUnderflowMaxSellable(maxSellable);
        }

        // Base payout from bonding curve
        // Sum = (spotPrice - delta) + (spotPrice - 2*delta) + ... + (spotPrice - N*delta)
        //     = N * spotPrice - delta * (1 + 2 + ... + N)
        //     = N * spotPrice - delta * N * (N + 1) / 2
        uint256 basePayout = numItems * spotPrice - delta * numItems * (numItems + 1) / 2;

        // LP fee (only for TRADE pools)
        uint256 lpFee = 0;
        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = basePayout * feeBps / BPS;
        }

        // Protocol fee
        protocolFee = basePayout * protocolFeeBps / BPS;

        outputAmount = basePayout - lpFee - protocolFee;

        // SECURITY FIX: Exclude accumulatedProtocolFees from available balance check.
        // Prevents protocol fee insolvency where sells drain ETH reserved for protocol fees.
        // Pattern: Uniswap V3 — separate accounting for protocol vs LP funds.
        uint256 availableETH = address(this).balance > accumulatedProtocolFees
            ? address(this).balance - accumulatedProtocolFees
            : 0;
        require(availableETH >= outputAmount + protocolFee, "POOL_INSUFFICIENT_ETH");
    }

    // ─── Internal: Held NFT Tracking ────────────────────────────────────

    /// @dev Add a token ID to the held set
    function _addHeldId(uint256 tokenId) internal {
        if (_idToIndex[tokenId] != 0) revert NFTAlreadyHeld(tokenId);
        _heldIds.push(tokenId);
        _idToIndex[tokenId] = _heldIds.length; // Store index+1
    }

    /// @dev Remove a token ID from the held set (swap-and-pop for O(1))
    function _removeHeldId(uint256 tokenId) internal {
        uint256 indexPlusOne = _idToIndex[tokenId];
        if (indexPlusOne == 0) revert NFTNotHeld(tokenId);

        uint256 lastIndex = _heldIds.length - 1;
        uint256 removeIndex = indexPlusOne - 1;

        if (removeIndex != lastIndex) {
            uint256 lastId = _heldIds[lastIndex];
            _heldIds[removeIndex] = lastId;
            _idToIndex[lastId] = indexPlusOne; // Update swapped element's index
        }

        _heldIds.pop();
        delete _idToIndex[tokenId];
    }

    // ─── Internal: ETH Transfer ─────────────────────────────────────────

    /// @dev SECURITY FIX: Replaced full-gas .call{value} with WETHFallbackLib.safeTransferETHOrWrap().
    ///      Uses 10000 gas stipend to prevent cross-contract reentrancy (Solmate/Seaport pattern).
    ///      If recipient can't receive ETH (contract without receive()), wraps as WETH (Aave V3 pattern).
    function _sendETH(address to, uint256 amount) internal {
        WETHFallbackLib.safeTransferETHOrWrap(weth, to, amount);
    }
}
