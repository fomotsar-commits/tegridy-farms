// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @notice AUDIT FIX: DEEP-NFTPOOL-12: minimal interface used by pools to read
///         the factory's emergency-pause flag. Defined externally to keep the
///         pool clone agnostic of the full factory ABI.
interface ITegridyNFTPoolFactoryView {
    function emergencyPaused() external view returns (bool);
}

/// @title TegridyNFTPool — Sudoswap-inspired NFT AMM pool (clone template)
contract TegridyNFTPool is IERC721Receiver, ReentrancyGuard, Pausable, Initializable {
    enum PoolType { BUY, SELL, TRADE }

    // ─── State ──────────────────────────────────────────────────────────
    IERC721 public nftCollection;
    PoolType public poolType;
    uint256 public spotPrice;
    uint256 public delta;
    uint256 public feeBps;
    uint256 public protocolFeeBps;
    address public owner;
    address public factory;
    address public weth;

    uint256[] internal _heldIds;
    mapping(uint256 => uint256) internal _idToIndex;

    uint256 public accumulatedProtocolFees;

    uint256 public pendingSpotPrice;
    uint256 public pendingSpotPriceExecuteAfter;
    uint256 public pendingDelta;
    uint256 public pendingDeltaExecuteAfter;
    uint256 public pendingFeeBps;
    uint256 public pendingFeeBpsExecuteAfter;

    uint256 public lastSwapBlock;

    // AUDIT FIX: DEEP-NFTPOOL-01: forward-direction same-block guard.
    uint256 public lastWithdrawBlock;

    // AUDIT FIX: DEEP-NFTPOOL-05: explicit LP-fee accounting.
    uint256 public accumulatedLPFees;
    mapping(address => uint256) public priorOwnerOwed;

    // AUDIT FIX: DEEP-NFTPOOL-03: 48-hour timelock for owner change.
    address public pendingOwner;
    uint256 public pendingOwnerExecuteAfter;
    uint256 public constant OWNER_TIMELOCK = 48 hours;

    // AUDIT FIX: DEEP-NFTPOOL-06: transient flag during swap execution.
    bool internal _swapInFlight;

    uint256 public constant MAX_FEE_BPS = 9000;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DELTA = 10 ether;
    uint256 public constant PARAMETER_TIMELOCK = 24 hours;

    // ─── Errors ─────────────────────────────────────────────────────────
    error Expired();
    error MaxCostExceeded();
    error TooManyItems();
    error DeltaTooHigh();
    error NotFactory();
    error TimelockNotElapsed();
    error NoPendingChange();
    error WaitOneBlock();
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
    /// AUDIT FIX: DEEP-NFTPOOL-01
    error WithdrawalLandedThisBlock();
    /// AUDIT FIX: DEEP-NFTPOOL-02
    error ExistingProposalPending();
    /// AUDIT FIX: DEEP-NFTPOOL-04
    error ZeroAddress();
    /// AUDIT FIX: DEEP-NFTPOOL-04
    error NoPendingOwnerChange();
    /// AUDIT FIX: DEEP-NFTPOOL-04 / 03
    error NotPendingOwner();
    /// AUDIT FIX: DEEP-NFTPOOL-05
    error NoPriorOwnerCredit();
    /// AUDIT FIX: DEEP-NFTPOOL-07
    error MinLiquidityBuffer();
    /// AUDIT FIX: DEEP-NFTPOOL-08
    error OnlyFactoryReceive();
    /// AUDIT FIX: DEEP-NFTPOOL-12
    error EmergencyPaused();

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
    event SpotPriceChangeProposed(uint256 currentPrice, uint256 proposedPrice, uint256 executeAfter);
    event SpotPriceChanged(uint256 oldPrice, uint256 newPrice);
    event SpotPriceChangeCancelled(uint256 cancelledPrice);
    event DeltaChangeProposed(uint256 currentDelta, uint256 proposedDelta, uint256 executeAfter);
    event DeltaChanged(uint256 oldDelta, uint256 newDelta);
    event DeltaChangeCancelled(uint256 cancelledDelta);
    event FeeChanged(uint256 oldFee, uint256 newFee);
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event NFTsWithdrawn(address indexed to, uint256[] tokenIds);
    event ProtocolFeePaid(address indexed factory, uint256 amount);
    /// AUDIT FIX: DEEP-NFTPOOL-03
    event OwnerChangeProposed(address indexed oldOwner, address indexed newOwner, uint256 executeAfter);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    /// AUDIT FIX: DEEP-NFTPOOL-04
    event OwnerChangeCancelled(address indexed cancelledPendingOwner);
    /// AUDIT FIX: DEEP-NFTPOOL-05
    event LPFeesAccrued(uint256 amount, uint256 totalAccumulated);
    event LPFeesClaimed(address indexed claimer, uint256 amount);
    event PriorOwnerLPFeesSnapshotted(address indexed priorOwner, uint256 amount);
    event PriorOwnerLPFeesClaimed(address indexed priorOwner, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

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

    function swapETHForNFTs(
        uint256[] calldata tokenIds,
        uint256 maxTotalCost,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX: DEEP-NFTPOOL-01: forward-direction same-block guard.
        if (block.number == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
        // AUDIT FIX: DEEP-NFTPOOL-12: factory emergency-pause cascade.
        if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
        if (poolType == PoolType.BUY) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // AUDIT FIX: DEEP-NFTPOOL-06
        _swapInFlight = true;

        (uint256 inputAmount, uint256 protocolFee, uint256 lpFee) = _getBuyPriceFull(numItems);
        if (inputAmount > maxTotalCost) revert MaxCostExceeded();
        if (msg.value < inputAmount) revert InsufficientETH();

        spotPrice += delta * numItems;

        for (uint256 i = 0; i < numItems; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }

        if (protocolFee > 0) {
            accumulatedProtocolFees += protocolFee;
            emit ProtocolFeePaid(factory, protocolFee);
        }

        // AUDIT FIX: DEEP-NFTPOOL-05
        if (lpFee > 0) {
            accumulatedLPFees += lpFee;
            emit LPFeesAccrued(lpFee, accumulatedLPFees);
        }

        uint256 excess = msg.value - inputAmount;
        if (excess > 0) {
            _sendETH(msg.sender, excess);
        }

        lastSwapBlock = block.number;
        _swapInFlight = false;

        emit SwapETHForNFTs(msg.sender, tokenIds, inputAmount);
    }

    function swapNFTsForETH(
        uint256[] calldata tokenIds,
        uint256 minOutput,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX: DEEP-NFTPOOL-01
        if (block.number == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
        // AUDIT FIX: DEEP-NFTPOOL-12
        if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
        if (poolType == PoolType.SELL) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // AUDIT FIX: DEEP-NFTPOOL-06
        _swapInFlight = true;

        (uint256 outputAmount, uint256 protocolFee, uint256 lpFee) = _getSellPriceFull(numItems);
        if (outputAmount < minOutput) revert InsufficientPayout();

        spotPrice -= delta * numItems;

        for (uint256 i = 0; i < numItems; i++) {
            nftCollection.safeTransferFrom(msg.sender, address(this), tokenIds[i]);
        }

        if (protocolFee > 0) {
            accumulatedProtocolFees += protocolFee;
            emit ProtocolFeePaid(factory, protocolFee);
        }

        // AUDIT FIX: DEEP-NFTPOOL-05
        if (lpFee > 0) {
            accumulatedLPFees += lpFee;
            emit LPFeesAccrued(lpFee, accumulatedLPFees);
        }

        _sendETH(msg.sender, outputAmount);

        lastSwapBlock = block.number;
        _swapInFlight = false;

        emit SwapNFTsForETH(msg.sender, tokenIds, outputAmount);
    }

    function addLiquidity(uint256[] calldata tokenIds) external payable onlyOwner nonReentrant {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            nftCollection.safeTransferFrom(msg.sender, address(this), tokenIds[i]);
        }
        emit LiquidityAdded(msg.sender, tokenIds, msg.value);
    }

    function removeLiquidity(
        uint256[] calldata tokenIds,
        uint256 ethAmount
    ) external onlyOwner nonReentrant {
        if (block.number <= lastSwapBlock) revert WaitOneBlock();

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }

        if (ethAmount > 0) {
            // AUDIT FIX: DEEP-NFTPOOL-07
            uint256 lpAvailable = _lpAvailableETH();
            uint256 minBuffer = lpAvailable / 10;
            if (ethAmount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
            _sendETH(msg.sender, ethAmount);
        }

        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.number;

        emit LiquidityRemoved(msg.sender, tokenIds, ethAmount);
    }

    // ─── Owner Parameter Changes ────────────────────────────────────────

    function proposeSpotPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        // AUDIT FIX: DEEP-NFTPOOL-02
        if (pendingSpotPriceExecuteAfter != 0) revert ExistingProposalPending();
        pendingSpotPrice = newPrice;
        pendingSpotPriceExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
        emit SpotPriceChangeProposed(spotPrice, newPrice, pendingSpotPriceExecuteAfter);
    }

    function executeSpotPriceChange() external onlyOwner {
        if (pendingSpotPriceExecuteAfter == 0) revert NoPendingChange();
        if (block.timestamp < pendingSpotPriceExecuteAfter) revert TimelockNotElapsed();
        uint256 oldPrice = spotPrice;
        spotPrice = pendingSpotPrice;
        pendingSpotPrice = 0;
        pendingSpotPriceExecuteAfter = 0;
        emit SpotPriceChanged(oldPrice, spotPrice);
    }

    function cancelSpotPriceChange() external onlyOwner {
        if (pendingSpotPriceExecuteAfter == 0) revert NoPendingChange();
        uint256 cancelled = pendingSpotPrice;
        pendingSpotPrice = 0;
        pendingSpotPriceExecuteAfter = 0;
        emit SpotPriceChangeCancelled(cancelled);
    }

    function proposeDelta(uint256 newDelta) external onlyOwner {
        if (newDelta > MAX_DELTA) revert DeltaTooHigh();
        // AUDIT FIX: DEEP-NFTPOOL-02
        if (pendingDeltaExecuteAfter != 0) revert ExistingProposalPending();
        pendingDelta = newDelta;
        pendingDeltaExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
        emit DeltaChangeProposed(delta, newDelta, pendingDeltaExecuteAfter);
    }

    function executeDeltaChange() external onlyOwner {
        if (pendingDeltaExecuteAfter == 0) revert NoPendingChange();
        if (block.timestamp < pendingDeltaExecuteAfter) revert TimelockNotElapsed();
        uint256 oldDelta = delta;
        delta = pendingDelta;
        pendingDelta = 0;
        pendingDeltaExecuteAfter = 0;
        emit DeltaChanged(oldDelta, delta);
    }

    function cancelDeltaChange() external onlyOwner {
        if (pendingDeltaExecuteAfter == 0) revert NoPendingChange();
        uint256 cancelled = pendingDelta;
        pendingDelta = 0;
        pendingDeltaExecuteAfter = 0;
        emit DeltaChangeCancelled(cancelled);
    }

    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (poolType != PoolType.TRADE) revert PoolTypeMismatch();
        if (newFee > MAX_FEE_BPS) revert InvalidFee();
        // AUDIT FIX: DEEP-NFTPOOL-02
        if (pendingFeeBpsExecuteAfter != 0) revert ExistingProposalPending();
        pendingFeeBps = newFee;
        pendingFeeBpsExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
        emit FeeChangeProposed(feeBps, newFee, pendingFeeBpsExecuteAfter);
    }

    function executeFeeChange() external onlyOwner {
        if (pendingFeeBpsExecuteAfter == 0) revert NoPendingChange();
        if (block.timestamp < pendingFeeBpsExecuteAfter) revert TimelockNotElapsed();
        uint256 oldFee = feeBps;
        feeBps = pendingFeeBps;
        pendingFeeBps = 0;
        pendingFeeBpsExecuteAfter = 0;
        emit FeeChanged(oldFee, feeBps);
    }

    function cancelFeeChange() external onlyOwner {
        if (pendingFeeBpsExecuteAfter == 0) revert NoPendingChange();
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        pendingFeeBpsExecuteAfter = 0;
        emit FeeChangeCancelled(cancelled);
    }

    function changeFee(uint256) external pure {
        revert("USE_PROPOSE_FEE_CHANGE");
    }

    // ─── AUDIT FIX: DEEP-NFTPOOL-03 / 04 / 05: timelocked owner change ───

    function proposeOwnerChange(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (pendingOwnerExecuteAfter != 0) revert ExistingProposalPending();
        pendingOwner = newOwner;
        pendingOwnerExecuteAfter = block.timestamp + OWNER_TIMELOCK;
        emit OwnerChangeProposed(owner, newOwner, pendingOwnerExecuteAfter);
    }

    function cancelOwnerChange() external onlyOwner {
        if (pendingOwnerExecuteAfter == 0) revert NoPendingOwnerChange();
        address cancelled = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerExecuteAfter = 0;
        emit OwnerChangeCancelled(cancelled);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        if (pendingOwnerExecuteAfter == 0 || block.timestamp < pendingOwnerExecuteAfter) {
            revert TimelockNotElapsed();
        }
        address oldOwner = owner;

        // AUDIT FIX: DEEP-NFTPOOL-05
        uint256 snapshot = accumulatedLPFees;
        if (snapshot > 0) {
            priorOwnerOwed[oldOwner] += snapshot;
            accumulatedLPFees = 0;
            emit PriorOwnerLPFeesSnapshotted(oldOwner, snapshot);
        }

        owner = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerExecuteAfter = 0;
        emit OwnerChanged(oldOwner, owner);
    }

    function claimLPFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedLPFees;
        if (amount == 0) return;
        accumulatedLPFees = 0;
        _sendETH(owner, amount);
        emit LPFeesClaimed(owner, amount);
    }

    function claimPriorOwnerLPFees() external nonReentrant {
        uint256 amount = priorOwnerOwed[msg.sender];
        if (amount == 0) revert NoPriorOwnerCredit();
        priorOwnerOwed[msg.sender] = 0;
        _sendETH(msg.sender, amount);
        emit PriorOwnerLPFeesClaimed(msg.sender, amount);
    }

    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        if (block.number <= lastSwapBlock) revert WaitOneBlock();
        require(amount > 0, "INVALID_AMOUNT");
        // AUDIT FIX: DEEP-NFTPOOL-07
        uint256 lpAvailable = _lpAvailableETH();
        uint256 minBuffer = lpAvailable / 10;
        if (amount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
        _sendETH(msg.sender, amount);
        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.number;
        emit ETHWithdrawn(msg.sender, amount);
    }

    function withdrawNFTs(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
        if (block.number <= lastSwapBlock) revert WaitOneBlock();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }
        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.number;
        emit NFTsWithdrawn(msg.sender, tokenIds);
    }

    function syncNFTs(uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] != 0) continue;
            try nftCollection.ownerOf(tokenId) returns (address current) {
                if (current == address(this)) {
                    _addHeldId(tokenId);
                }
            } catch {}
        }
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function claimProtocolFees() external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        uint256 amount = accumulatedProtocolFees;
        if (amount == 0) return;
        accumulatedProtocolFees = 0;
        _sendETH(factory, amount);
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getBuyQuote(uint256 numItems) external view returns (uint256 inputAmount, uint256 protocolFee) {
        return _getBuyPrice(numItems);
    }

    function getSellQuote(uint256 numItems) external view returns (uint256 outputAmount, uint256 protocolFee) {
        return _getSellPrice(numItems);
    }

    function getHeldTokenIds() external view returns (uint256[] memory) {
        return _heldIds;
    }

    function getHeldCount() external view returns (uint256) {
        return _heldIds.length;
    }

    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return _idToIndex[tokenId] != 0;
    }

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

    function getMaxSellable() public view returns (uint256 maxSellable) {
        if (delta == 0) {
            return type(uint256).max;
        }
        maxSellable = (spotPrice - 1) / delta;
    }

    // ─── IERC721Receiver ────────────────────────────────────────────────

    function onERC721Received(
        address operator,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        require(msg.sender == address(nftCollection), "WRONG_COLLECTION");
        // AUDIT FIX: DEEP-NFTPOOL-06: also accept deposits when a swap is in flight
        require(
            operator == owner ||
                operator == address(this) ||
                operator == factory ||
                _swapInFlight,
            "UNAUTHORIZED_DEPOSIT"
        );
        if (_idToIndex[tokenId] == 0) {
            _addHeldId(tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /// AUDIT FIX: DEEP-NFTPOOL-08: restrict ETH ingress to the factory.
    receive() external payable {
        if (msg.sender != factory) revert OnlyFactoryReceive();
    }

    // ─── Internal: Bonding Curve Pricing ────────────────────────────────

    function _getBuyPrice(uint256 numItems)
        internal
        view
        returns (uint256 inputAmount, uint256 protocolFee)
    {
        (inputAmount, protocolFee, ) = _getBuyPriceFull(numItems);
    }

    function _getBuyPriceFull(uint256 numItems)
        internal
        view
        returns (uint256 inputAmount, uint256 protocolFee, uint256 lpFee)
    {
        if (numItems == 0) revert EmptySwap();

        uint256 baseCost = numItems * spotPrice + delta * numItems * (numItems - 1) / 2;

        if (spotPrice == 0) revert PriceUnderflow();

        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = baseCost * feeBps / BPS;
        }

        protocolFee = baseCost * protocolFeeBps / BPS;
        inputAmount = baseCost + lpFee + protocolFee;
    }

    function _getSellPrice(uint256 numItems)
        internal
        view
        returns (uint256 outputAmount, uint256 protocolFee)
    {
        (outputAmount, protocolFee, ) = _getSellPriceFull(numItems);
    }

    function _getSellPriceFull(uint256 numItems)
        internal
        view
        returns (uint256 outputAmount, uint256 protocolFee, uint256 lpFee)
    {
        if (numItems == 0) revert EmptySwap();

        if (delta * numItems >= spotPrice) {
            uint256 maxSellable = getMaxSellable();
            revert PriceUnderflowMaxSellable(maxSellable);
        }

        uint256 basePayout = numItems * spotPrice - delta * numItems * (numItems + 1) / 2;

        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = basePayout * feeBps / BPS;
        }

        protocolFee = basePayout * protocolFeeBps / BPS;
        outputAmount = basePayout - lpFee - protocolFee;

        // AUDIT FIX: DEEP-NFTPOOL-05/07: subtract LP-fee accumulator from solvency.
        uint256 availableETH = _lpAvailableETH();
        require(availableETH >= outputAmount + protocolFee, "POOL_INSUFFICIENT_ETH");
    }

    function _lpAvailableETH() internal view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 reserved = accumulatedProtocolFees + accumulatedLPFees;
        if (bal <= reserved) return 0;
        return bal - reserved;
    }

    // ─── Internal: Held NFT Tracking ────────────────────────────────────

    function _addHeldId(uint256 tokenId) internal {
        if (_idToIndex[tokenId] != 0) revert NFTAlreadyHeld(tokenId);
        _heldIds.push(tokenId);
        _idToIndex[tokenId] = _heldIds.length;
    }

    function _removeHeldId(uint256 tokenId) internal {
        uint256 indexPlusOne = _idToIndex[tokenId];
        if (indexPlusOne == 0) revert NFTNotHeld(tokenId);

        uint256 lastIndex = _heldIds.length - 1;
        uint256 removeIndex = indexPlusOne - 1;

        if (removeIndex != lastIndex) {
            uint256 lastId = _heldIds[lastIndex];
            _heldIds[removeIndex] = lastId;
            _idToIndex[lastId] = indexPlusOne;
        }

        _heldIds.pop();
        delete _idToIndex[tokenId];
    }

    // ─── Internal: ETH Transfer ─────────────────────────────────────────

    function _sendETH(address to, uint256 amount) internal {
        WETHFallbackLib.safeTransferETHOrWrap(weth, to, amount);
    }
}
