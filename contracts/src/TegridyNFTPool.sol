// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @dev AUDIT FIX (pass-8 batch-17): minimal ERC-2981 interface for royalty
///      enforcement on swaps. Collections that don't implement ERC-2981 will
///      revert in the try-call wrapper and pay zero royalty (preserves current
///      behavior for non-royalty collections; new behavior is additive).
interface IERC2981 {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external view returns (address receiver, uint256 royaltyAmount);
}

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

    /// @notice Timestamp (seconds) of the most recent swap on this pool.
    /// @dev    AUDIT FIX (pass-8): CLK-02 — was `block.number`-based but
    ///         `block.number` semantics differ across L1/L2 (Optimism/Base
    ///         block.number is the L2 block number ~2s/block, Arbitrum is the
    ///         L1 block number ~12s/block). A "50-block cooldown" intended as
    ///         ~10 minutes on mainnet degrades to ~100 seconds on OP-stack
    ///         chains. Storage slot name retained for ABI continuity but
    ///         semantically now stores `block.timestamp`.
    uint256 public lastSwapBlock;

    // AUDIT FIX: DEEP-NFTPOOL-01: forward-direction same-block guard.
    /// @dev    AUDIT FIX (pass-8): CLK-02 — same migration as above. Now stores
    ///         `block.timestamp`. The same-tx guard becomes a 1-second guard
    ///         (effectively still same-tx in practice — block intervals all >0s).
    uint256 public lastWithdrawBlock;

    // AUDIT FIX: DEEP-NFTPOOL-05: explicit LP-fee accounting.
    uint256 public accumulatedLPFees;
    mapping(address => uint256) public priorOwnerOwed;

    // AUDIT FIX: DEEP-NFTPOOL-03: 48-hour timelock for owner change.
    address public pendingOwner;
    uint256 public pendingOwnerExecuteAfter;
    uint256 public constant OWNER_TIMELOCK = 48 hours;

    // AUDIT FIX L-4: extend NFT-inventory withdraw cooldown beyond 1 block so
    // traders get a meaningful window between recent swap activity and an
    // owner-initiated inventory drain. 10 minutes — meaningful trader-reaction
    // window across all chains.
    // The owner can bypass this by `pause()`-ing the pool first — pause is the
    // explicit closure signal, so traders can react to the on-chain event.
    //
    // AUDIT FIX (pass-8): CLK-02 — switched from `block.number`-based to
    // `block.timestamp`-based. The constant value changed from `50 blocks` to
    // `10 minutes` (= 600 seconds). The constant NAME is preserved for ABI
    // continuity; consumers reading `WITHDRAW_NFT_COOLDOWN_BLOCKS` now receive
    // a value in seconds. To be renamed in the next major version.
    uint256 public constant WITHDRAW_NFT_COOLDOWN_BLOCKS = 10 minutes;

    // AUDIT FIX: DEEP-NFTPOOL-06: transient flag during swap execution.
    bool internal _swapInFlight;

    // AUDIT FIX: V2-NFTPOOL-01: tracks the active swap's caller so that the
    // `onERC721Received` deposit gate can restrict open-window deposits to the
    // intended seller's inflow only (not arbitrary attacker-deposits during the
    // buyer's `onERC721Received` callback in `swapETHForNFTs`).
    address internal _swapCaller;

    uint256 public constant MAX_FEE_BPS = 9000;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DELTA = 10 ether;
    // AUDIT FIX V3-NFTPOOL-05: cap spotPrice to prevent
    // `_minLiquidityBuffer`'s `100 * spotPrice` from overflowing Solidity
    // 0.8.26 checked arithmetic and bricking every withdrawal/swap path.
    uint256 public constant MAX_SPOT_PRICE = 1_000_000 ether;
    uint256 public constant PARAMETER_TIMELOCK = 24 hours;
    // AUDIT FIX (Wave-B re-run, F-63-1): cap caller-supplied deadline to bound
    // mempool-warehousing exposure. Mirrors TegridyRouter / SwapFeeRouter
    // MAX_DEADLINE = 2 hours. A wallet that signs `deadline = type(uint256).max`
    // ("set and forget") would otherwise be exposed to indefinite warehousing
    // until on-pool flow drifted spotPrice toward maxTotalCost / minOutput.
    uint256 public constant MAX_DEADLINE = 2 hours;

    // AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): per-receiver pull-
    // pattern credits for stranded royalty WETH. Populated when
    // `_settleRoyalty` falls into mode==2 (deposit succeeded, transfer to
    // receiver failed — caller now holds stranded WETH). Receivers self-claim
    // via `claimStrandedRoyaltyWETH` instead of waiting for owner discretion.
    // The aggregate `totalPendingStrandedWETH` is a reserved-balance counter
    // that `rescueStrandedRoyalty` subtracts so the owner can never touch the
    // receiver-owed portion.
    mapping(address => uint256) public pendingStrandedWETH;
    uint256 public totalPendingStrandedWETH;

    // ─── Errors ─────────────────────────────────────────────────────────
    using SafeERC20 for IERC20; // AUDIT FIX (BATCH-B H3): for rescueStrandedRoyalty WETH transfer
    error Expired();
    error MaxCostExceeded();
    /// AUDIT FIX (BATCH-B H3): rescueStrandedRoyalty when WETH balance == 0
    error NoStrandedRoyalty();
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
    error SpotPriceTooHigh(); // AUDIT FIX V3-NFTPOOL-05
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
    /// AUDIT FIX L-4
    error WaitForNFTWithdrawCooldown();
    /// AUDIT FIX (Wave-B re-run, F-63-1): caller-supplied `deadline` exceeds
    /// `block.timestamp + MAX_DEADLINE` — bound mempool warehousing.
    error DeadlineTooFar();
    /// AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): receiver has no
    /// pull-credit to claim from stranded WETH.
    error NoStrandedCredit();
    /// AUDIT FIX (Wave-B re-run, F-54-2): explicit reverting ERC1155 receiver.
    error ERC1155NotSupported();

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
    /// @notice AUDIT FIX (pass-8 batch-17): emitted when ERC-2981 royalty is paid
    ///         to the collection's royalty receiver during a swap.
    /// @dev    AUDIT FIX (Wave-B re-run, F-19-1 / M-18): the indexed `tokenId`
    ///         is the SPECIFIC tokenId whose royalty rate was settled (one
    ///         event per token in a batch). Pre-fix this was always
    ///         `tokenIds[0]`; per-token iteration emits one event per ID.
    event RoyaltyPaid(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    event RoyaltyFallbackToWETH(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    /// AUDIT FIX (BATCH-B H3): emitted when both ETH leg AND WETH leg of royalty
    /// payment fail (mode == 2). The royalty is silently skipped at swap time;
    /// off-chain monitoring can flag the receiver for `rescueStrandedRoyalty`.
    event RoyaltyOrphaned(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    /// AUDIT FIX (BATCH-B H3): emitted when owner sweeps stranded WETH that
    /// accumulated from one or more `RoyaltyOrphaned` events.
    event RoyaltyRescued(address indexed to, uint256 amount);
    /// AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): emitted when a
    /// receiver self-claims their pending stranded-royalty WETH credit.
    event StrandedRoyaltyClaimed(address indexed receiver, uint256 amount);
    /// AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): emitted when the
    /// receiver-owed pull-credit is recorded on a mode==2 royalty failure.
    event StrandedRoyaltyCredited(address indexed receiver, uint256 amount, uint256 indexed tokenId);
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
        // AUDIT FIX (Wave-B re-run, F-62-1): mirror MAX_SPOT_PRICE check at
        // init. Pre-fix `proposeSpotPrice` enforced `<= MAX_SPOT_PRICE` but
        // `initialize` only required `> 0`, so a creator could ship a pool
        // with `spotPrice ≈ uint256.max / 50` that bricks every withdraw/swap
        // path on its first call (`_minLiquidityBuffer` overflows the
        // `100 * spotPrice` multiplication under Solidity 0.8.26 checked math).
        if (_spotPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();
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

    /// @notice Buy NFTs from the pool by paying ETH along the bonding curve.
    /// @dev    AUDIT FIX (Wave-B re-run, F-19-3): NatSpec note — the buyer
    ///         specifies the EXACT tokenIds they want; `inputAmount` is purely
    ///         a function of `numItems`, NOT per-token rarity. Sudoswap-style
    ///         pools assume LPs deposit fungible-rarity inventory; LPs that
    ///         mix a rare 1/1 with floor commons risk losing the 1/1 to a
    ///         single-item buy at floor price (multi-rarity cherry-pick).
    ///         Frontends should warn LPs creating pools with mixed-rarity
    ///         inventory.
    /// @dev    AUDIT FIX (Wave-B re-run, F-67-3): NatSpec note — the
    ///         `lastWithdrawBlock == block.timestamp` guard fires only within
    ///         the SAME block on Ethereum L1 (block intervals are 12s and
    ///         strictly monotonic), and within the same SECOND on L2 chains
    ///         (Optimism/Base/Arbitrum block timestamps strictly increase by
    ///         >=1s). Effectively still same-tx in practice.
    function swapETHForNFTs(
        uint256[] calldata tokenIds,
        uint256 maxTotalCost,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX (Wave-B re-run, F-63-1): bound the user-supplied deadline
        // upper limit to MAX_DEADLINE (2h) so a "set and forget"
        // `deadline = type(uint256).max` cannot be warehoused indefinitely
        // by a searcher. Mirrors TegridyRouter / SwapFeeRouter policy.
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT FIX: DEEP-NFTPOOL-01: forward-direction same-block guard.
        if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
        // AUDIT FIX: DEEP-NFTPOOL-12: factory emergency-pause cascade.
        if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
        if (poolType == PoolType.BUY) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // AUDIT FIX: DEEP-NFTPOOL-06
        _swapInFlight = true;
        // AUDIT FIX V3-NFTPOOL-01: do NOT set `_swapCaller` in the BUY direction.
        // V2-NFTPOOL-01's intent was to gate `onERC721Received` deposit inflows
        // to the SELLER during a `swapNFTsForETH` swap. Setting it here for the
        // BUYER too lets a buyer's `onERC721Received` callback (fired when the
        // pool transfers NFTs to them) re-enter via the NFT-collection bridge
        // and stuff arbitrary tokenIds into `_heldIds` — exactly the V2-fix
        // exploit shape we tried to close.

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

        // AUDIT FIX (pass-8 batch-17): ERC-2981 royalty on the spot-revenue
        // (the pool's NET retained piece after protocol/LP fees). Royalty is
        // paid out of the pool's revenue, NOT out of the buyer's payment —
        // the buyer pays `inputAmount` regardless of royalty rate. Pool's
        // captured revenue = inputAmount − protocolFee − lpFee − royalty.
        // AUDIT FIX (Wave-B re-run, F-19-1 / M-18): per-token royalty
        // iteration so per-tokenId-rate collections (Manifold registry,
        // Foundation curated, Async Art) are not bypassed via tokenIds[0]
        // anchoring. Each token contributes its own royalty rate against its
        // pro-rata share of the sale.
        uint256 spotRevenue = inputAmount - protocolFee - lpFee;
        _settleRoyaltyBatch(spotRevenue, tokenIds);

        uint256 excess = msg.value - inputAmount;
        if (excess > 0) {
            _sendETH(msg.sender, excess);
        }

        lastSwapBlock = block.timestamp;
        _swapInFlight = false;
        // AUDIT FIX V3-NFTPOOL-01: no `_swapCaller` clear needed — we never set it.

        emit SwapETHForNFTs(msg.sender, tokenIds, inputAmount);
    }

    /// @notice Sell NFTs to the pool, receiving ETH along the bonding curve.
    /// @dev    AUDIT FIX (Wave-B re-run, F-67-3): NatSpec — same-tx-in-practice
    ///         guard semantics as `swapETHForNFTs`.
    function swapNFTsForETH(
        uint256[] calldata tokenIds,
        uint256 minOutput,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX (Wave-B re-run, F-63-1): cap deadline at MAX_DEADLINE.
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // AUDIT FIX: DEEP-NFTPOOL-01
        if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
        // AUDIT FIX: DEEP-NFTPOOL-12
        if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
        if (poolType == PoolType.SELL) revert PoolTypeMismatch();
        uint256 numItems = tokenIds.length;
        if (numItems == 0) revert EmptySwap();
        if (numItems > 100) revert TooManyItems();

        // AUDIT FIX: DEEP-NFTPOOL-06
        _swapInFlight = true;
        // AUDIT FIX: V2-NFTPOOL-01
        _swapCaller = msg.sender;

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

        // AUDIT FIX (pass-8 batch-17): ERC-2981 royalty on the user's payout.
        // Royalty is computed against `outputAmount` (gross seller proceeds
        // before royalty deduction) and forwarded to the receiver; seller
        // gets `outputAmount − royalty`. Failed receiver = silent skip
        // (royalty receiver cannot brick the sale; mirror Sudoswap V2 / OS).
        // AUDIT FIX (Wave-B re-run, F-19-1 / M-18): per-token iteration —
        // see swapETHForNFTs comment.
        uint256 royalty = _settleRoyaltyBatch(outputAmount, tokenIds);

        _sendETH(msg.sender, outputAmount - royalty);

        lastSwapBlock = block.timestamp;
        _swapInFlight = false;
        // AUDIT FIX: V2-NFTPOOL-01
        _swapCaller = address(0);

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
        // AUDIT FIX D-NFTPOOL-H1: same 50-block cooldown as withdrawETH /
        // withdrawNFTs. Pre-fix this path inherited only the legacy 1-block
        // gate, so an owner could remove BOTH an NFT and ETH the next block
        // after a swap — wider blast radius than withdrawETH alone. paused()
        // and lastSwapBlock==0 carve-outs match the sibling paths.
        if (
            lastSwapBlock != 0 &&
            !paused() &&
            block.timestamp <= lastSwapBlock + WITHDRAW_NFT_COOLDOWN_BLOCKS
        ) {
            revert WaitForNFTWithdrawCooldown();
        }

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }

        if (ethAmount > 0) {
            // AUDIT FIX: DEEP-NFTPOOL-07 / V2-NFTPOOL-04: replace heuristic
            // 10%-of-balance buffer with a solvency-derived floor tied to the
            // actual bonding-curve worst-case payout. We require the post-
            // withdraw `lpAvailable` to still cover one full max-batch sell
            // at the current spot price (100 items = swap maximum). This
            // ensures the next sell cannot revert on `POOL_INSUFFICIENT_ETH`
            // due to the owner front-running with a withdrawal.
            uint256 lpAvailable = _lpAvailableETH();
            uint256 minBuffer = _minLiquidityBuffer();
            if (ethAmount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
            _sendETH(msg.sender, ethAmount);
        }

        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.timestamp;

        emit LiquidityRemoved(msg.sender, tokenIds, ethAmount);
    }

    // ─── Owner Parameter Changes ────────────────────────────────────────

    function proposeSpotPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        // AUDIT FIX V3-NFTPOOL-05: enforce a maximum spot price. Pre-fix the
        // setter accepted arbitrary uint256 values; `_minLiquidityBuffer`
        // computes `100 * spotPrice` (overflows under Solidity 0.8.26 checked
        // arithmetic at extreme spotPrices), bricking every withdraw / swap
        // path on the pool. Cap chosen to allow up to 1M ETH per NFT
        // (well above any realistic floor) while leaving headroom against
        // the buffer multiplication.
        if (newPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();
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
        // AUDIT FIX V3-NFTPOOL-04: REMOVE `whenNotPaused` from acceptOwnership.
        // The pool's own pause + the factory's emergencyPaused gate were both
        // added by V2-NFTPOOL-05, but combined they brick legitimate
        // key-loss recovery: if the owner pauses then loses their key, the
        // pendingOwner cannot rescue via `acceptOwnership` while paused. The
        // defended threat (attacker-as-current-owner queuing a malicious
        // pendingOwner) is already mitigated by the existing `cancelOwnerChange`
        // path (the legitimate owner can always cancel a hostile proposal).
        // The factory emergencyPaused cascade is also dropped here for the
        // same reason — it created a permanent ownership-lock vector under
        // factory-side incidents combined with pool-key loss.
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        if (pendingOwnerExecuteAfter == 0 || block.timestamp < pendingOwnerExecuteAfter) {
            revert TimelockNotElapsed();
        }
        address oldOwner = owner;

        // AUDIT FIX: DEEP-NFTPOOL-05
        // AUDIT FIX V3-NFTPOOL-06: skip the priorOwner snapshot when the
        // ownership "transfer" is a self-no-op (pendingOwner == oldOwner).
        // Pre-fix the snapshot moved accumulatedLPFees → priorOwnerOwed[self]
        // forcing the owner onto a different claim path with no signal.
        uint256 snapshot = accumulatedLPFees;
        if (snapshot > 0 && pendingOwner != oldOwner) {
            priorOwnerOwed[oldOwner] += snapshot;
            accumulatedLPFees = 0;
            emit PriorOwnerLPFeesSnapshotted(oldOwner, snapshot);
        }

        owner = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerExecuteAfter = 0;

        // AUDIT FIX: V2-NFTPOOL-07: clear ALL other pending governance
        // proposals on ownership transition so the new owner does not inherit
        // a "time-bomb" parameter change (spotPrice/delta/feeBps) queued by
        // the prior owner. The new owner can re-propose if needed, paying the
        // 24h timelock again — this is intentional friction to surface the
        // change to whoever now controls the pool.
        if (pendingSpotPriceExecuteAfter != 0) {
            uint256 cancelledSpot = pendingSpotPrice;
            pendingSpotPrice = 0;
            pendingSpotPriceExecuteAfter = 0;
            emit SpotPriceChangeCancelled(cancelledSpot);
        }
        if (pendingDeltaExecuteAfter != 0) {
            uint256 cancelledDelta = pendingDelta;
            pendingDelta = 0;
            pendingDeltaExecuteAfter = 0;
            emit DeltaChangeCancelled(cancelledDelta);
        }
        if (pendingFeeBpsExecuteAfter != 0) {
            uint256 cancelledFee = pendingFeeBps;
            pendingFeeBps = 0;
            pendingFeeBpsExecuteAfter = 0;
            emit FeeChangeCancelled(cancelledFee);
        }

        emit OwnerChanged(oldOwner, owner);
    }

    function claimLPFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedLPFees;
        if (amount == 0) return;
        accumulatedLPFees = 0;
        // AUDIT FIX: V2-NFTPOOL-06: send to msg.sender (the address that
        // actually passed the `onlyOwner` check this transaction), not to the
        // live `owner` storage slot. Eliminates the same-block MEV race where
        // a freshly-`acceptOwnership`d new owner could front-run the prior
        // owner's `claimLPFees` and redirect those fees to themselves. After
        // `acceptOwnership` the prior owner can still recover their share via
        // `claimPriorOwnerLPFees` from the snapshot.
        _sendETH(msg.sender, amount);
        emit LPFeesClaimed(msg.sender, amount);
    }

    function claimPriorOwnerLPFees() external nonReentrant {
        uint256 amount = priorOwnerOwed[msg.sender];
        if (amount == 0) revert NoPriorOwnerCredit();
        priorOwnerOwed[msg.sender] = 0;
        _sendETH(msg.sender, amount);
        emit PriorOwnerLPFeesClaimed(msg.sender, amount);
    }

    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        // AUDIT FIX D-NFTPOOL-H1: extend the 50-block cooldown (mirroring
        // withdrawNFTs / DEEP-NFTPOOL-L4) to the ETH-withdraw path. Pre-fix,
        // an owner who saw a profitable buyer's pending swapETHForNFTs could
        // let the swap land then drain ETH proceeds in the very next block,
        // leaving the next seller's payout floored at _minLiquidityBuffer.
        // The asymmetry (50-block cooldown on NFT side, 1-block on ETH side)
        // reopened the same MEV window L-4 deliberately closed. Same paused()
        // bypass + lastSwapBlock==0 carve-out as withdrawNFTs so on-chain
        // closure signal and pre-trade owner setup remain unblocked.
        if (
            lastSwapBlock != 0 &&
            !paused() &&
            block.timestamp <= lastSwapBlock + WITHDRAW_NFT_COOLDOWN_BLOCKS
        ) {
            revert WaitForNFTWithdrawCooldown();
        }
        require(amount > 0, "INVALID_AMOUNT");
        // AUDIT FIX: DEEP-NFTPOOL-07 / V2-NFTPOOL-04: solvency-derived
        // buffer (see `_minLiquidityBuffer`). Replaces the prior 10%-of-
        // balance heuristic that scaled disconnected from the actual sell
        // payout the curve could permit on the next swap.
        uint256 lpAvailable = _lpAvailableETH();
        uint256 minBuffer = _minLiquidityBuffer();
        if (amount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
        _sendETH(msg.sender, amount);
        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.timestamp;
        emit ETHWithdrawn(msg.sender, amount);
    }

    function withdrawNFTs(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
        // AUDIT FIX L-4: 1-block cooldown allowed an owner to drain NFT inventory
        // immediately after seeing trader activity. Extended to ~10 min on mainnet
        // so traders get meaningful warning. Bypass when paused — `pause()` is the
        // on-chain closure signal traders monitor, so once paused the cooldown
        // adds no additional protection. Skip when no swap has ever happened
        // (lastSwapBlock == 0): the cooldown protects active traders only, and
        // pre-trade owner setup needs no warning window.
        if (
            lastSwapBlock != 0 &&
            !paused() &&
            block.timestamp <= lastSwapBlock + WITHDRAW_NFT_COOLDOWN_BLOCKS
        ) {
            revert WaitForNFTWithdrawCooldown();
        }
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        }
        // AUDIT FIX: DEEP-NFTPOOL-01
        lastWithdrawBlock = block.timestamp;
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
        address from,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        require(msg.sender == address(nftCollection), "WRONG_COLLECTION");
        // AUDIT FIX: V2-NFTPOOL-01: tighten the in-flight gate. When a swap is
        // active we accept deposits ONLY from the swap caller's address (the
        // intended seller's inflow). This blocks the buyer-callback re-entry
        // vector where `safeTransferFrom(address(this), buyer, tokenId)` fires
        // the buyer's `onERC721Received` while `_swapInFlight == true` and the
        // buyer's hook deposits arbitrary tokenIds back into the pool. The
        // legacy authorized-operator branch still accepts owner/factory/self
        // deposits regardless of swap state.
        bool authorizedOperator = operator == owner ||
            operator == address(this) ||
            operator == factory;
        bool authorizedSwapInflow = _swapInFlight && from == _swapCaller;
        require(authorizedOperator || authorizedSwapInflow, "UNAUTHORIZED_DEPOSIT");
        if (_idToIndex[tokenId] == 0) {
            _addHeldId(tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /// AUDIT FIX: DEEP-NFTPOOL-08: restrict ETH ingress to the factory.
    receive() external payable {
        if (msg.sender != factory) revert OnlyFactoryReceive();
    }

    // ─── AUDIT FIX (Wave-B re-run, F-54-2): explicit ERC1155 receiver reverts.
    // The pool is ERC721-only; an inbound `safeTransferFrom`/`safeBatchTransferFrom`
    // from any ERC1155 collection (or a hostile hybrid 721+1155 collection
    // attempting to inject phantom tokenIds) MUST revert loudly so off-chain
    // monitors classify it correctly. Without these, a well-behaved ERC1155
    // sender's `safeTransferFrom` would revert with an unhelpful "no receiver"
    // error from the sender side; explicit reverts here surface the intent
    // and harden the standard-conflation surface.

    /// @notice Always reverts — the pool does not support ERC1155 deposits.
    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        revert ERC1155NotSupported();
    }

    /// @notice Always reverts — the pool does not support ERC1155 batch deposits.
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert ERC1155NotSupported();
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

        // AUDIT FIX (Wave-B re-run, F-61-2): round fees UP via mulDiv-Ceil so
        // the rounding bias is in the protocol's favor (and away from the
        // user's free-shave on small splits). On L2s with sub-cent gas, a
        // user could otherwise split a single trade into many 1-wei-savings
        // micro-trades.
        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = Math.mulDiv(baseCost, feeBps, BPS, Math.Rounding.Ceil);
        }

        protocolFee = Math.mulDiv(baseCost, protocolFeeBps, BPS, Math.Rounding.Ceil);
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

        // AUDIT FIX (Wave-B re-run, F-61-2): round fees UP. On the sell path
        // this REDUCES `outputAmount` by 1 wei in the worst case, biasing the
        // rounding into the protocol's favor (mirror of the buy-path fix).
        if (poolType == PoolType.TRADE && feeBps > 0) {
            lpFee = Math.mulDiv(basePayout, feeBps, BPS, Math.Rounding.Ceil);
        }

        protocolFee = Math.mulDiv(basePayout, protocolFeeBps, BPS, Math.Rounding.Ceil);
        outputAmount = basePayout - lpFee - protocolFee;

        // AUDIT FIX: DEEP-NFTPOOL-05/07: subtract LP-fee accumulator from solvency.
        // AUDIT FIX M-1 (LP-fee solvency): include `lpFee` in the required threshold.
        // Pre-fix the check was `availableETH >= outputAmount + protocolFee` which
        // omits `lpFee`, so after the swap `accumulatedLPFees` would grow by `lpFee`
        // even when the pool's ETH cannot cover it — `claimLPFees()` would later
        // revert (insufficient balance for the safeTransfer). Including `lpFee`
        // here makes the post-swap invariant `available' >= 0` (the pool can
        // ALWAYS pay every LP fee it has booked). Tightens the per-sell
        // liquidity requirement by `lpFee`, which is the correct conservative
        // posture for a TRADE pool with a non-zero `feeBps`.
        uint256 availableETH = _lpAvailableETH();
        require(availableETH >= outputAmount + protocolFee + lpFee, "POOL_INSUFFICIENT_ETH");
    }

    function _lpAvailableETH() internal view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 reserved = accumulatedProtocolFees + accumulatedLPFees;
        if (bal <= reserved) return 0;
        return bal - reserved;
    }

    /// @dev AUDIT FIX: V2-NFTPOOL-04: derive the post-withdraw liquidity floor
    ///      from the bonding-curve worst-case sell payout instead of the prior
    ///      heuristic 10%-of-balance slice. The worst-case sell payout is
    ///      `min(getMaxSellable(), 100) * spotPrice` — bounded above by both
    ///      the per-swap cap of 100 items AND the curve's `getMaxSellable()`
    ///      (beyond which the curve underflows and reverts). This is an upper
    ///      bound on the next sell's gross payout (LP/protocol fees in TRADE
    ///      pools further reduce the net outflow, so the floor is intentionally
    ///      conservative). SELL pools cannot accept sells (`PoolTypeMismatch`
    ///      revert in `swapNFTsForETH`) so they need no floor. The buffer is
    ///      capped at `_lpAvailableETH()` so an already-depleted pool can
    ///      still let the owner withdraw remaining dust without an impossible-
    ///      to-satisfy floor.
    function _minLiquidityBuffer() internal view returns (uint256) {
        if (poolType == PoolType.SELL) return 0;
        uint256 maxItems = getMaxSellable();
        if (maxItems == 0) return 0;
        if (maxItems > 100) maxItems = 100;
        uint256 floorAmt = maxItems * spotPrice;
        uint256 lpAvailable = _lpAvailableETH();
        // AUDIT FIX V3-NFTPOOL-03: when `floorAmt > lpAvailable` the pool is
        // already underwater for the requested floor — capping to lpAvailable
        // (pre-fix) would force `withdrawETH(amount)` checks like
        // `amount + lpAvailable > lpAvailable` to revert for ANY non-zero
        // amount. That blocked dust recovery entirely. Returning 0 instead
        // means the buffer simply doesn't apply when the pool can't cover it
        // (the underwater state is already a no-op for sells, by design).
        return floorAmt > lpAvailable ? 0 : floorAmt;
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

    // ─── AUDIT FIX (pass-8 batch-17): ERC-2981 royalty enforcement ──────

    /// @dev AUDIT FIX (Wave-B re-run, F-19-1 / F-19-2 / F-55-7 / M-18):
    ///      Per-token-iterating royalty settler. Pre-fix the settler queried
    ///      `royaltyInfo(tokenIds[0], totalSale)` once and applied that single
    ///      rate to the entire batch — bypassed by collections that ship
    ///      per-tokenId royalty rates (Manifold registry, Foundation curated,
    ///      Async Art). The new path computes a per-token sale share
    ///      (`totalSale / n`) and queries `royaltyInfo(tokenId, perTokenSale)`
    ///      per tokenId, summing the routed royalties.
    /// @dev Per-token royalty cap (25% of per-token sale) defends against a
    ///      pathological/registry-compromised collection — same Sudoswap V2
    ///      pattern as the prior single-anchor implementation.
    /// @dev Failure modes per tokenId:
    ///      mode==0 -> ETH delivered, RoyaltyPaid emitted
    ///      mode==1 -> WETH-fallback delivered, RoyaltyFallbackToWETH emitted
    ///      mode==2 -> stranded WETH in pool — credit
    ///                 `pendingStrandedWETH[receiver]` and emit
    ///                 RoyaltyOrphaned + StrandedRoyaltyCredited; receiver
    ///                 self-claims via `claimStrandedRoyaltyWETH`.
    ///      mode==3 -> total failure (deposit failed, ETH untouched);
    ///                 silently skip — RoyaltyOrphaned emitted with the
    ///                 same shape as legacy for monitor parity.
    /// @param  totalSale Aggregate sale value in ETH for the batch.
    /// @param  tokenIds Tokens in the batch — each contributes a pro-rata
    ///                  share to the per-token royalty calculation.
    /// @return royaltyPaid Total amount (ETH or WETH-delivered, plus
    ///                     mode==2 stranded credits which are accounted as
    ///                     paid since they have left the pool's ETH balance)
    ///                     summed across all tokens.
    function _settleRoyaltyBatch(uint256 totalSale, uint256[] calldata tokenIds)
        internal
        returns (uint256 royaltyPaid)
    {
        uint256 n = tokenIds.length;
        if (totalSale == 0 || n == 0) return 0;
        // Per-token sale share. Floor division: dust (totalSale mod n) stays
        // in the pool and is captured by spot revenue / outputAmount math.
        uint256 perTokenSale = totalSale / n;
        if (perTokenSale == 0) return 0;
        for (uint256 i = 0; i < n; i++) {
            royaltyPaid += _settleSingleTokenRoyalty(perTokenSale, tokenIds[i]);
        }
    }

    /// @dev AUDIT FIX (Wave-B re-run, F-19-1 / F-19-2 / F-55-7 / M-18):
    ///      single-token royalty settlement extracted for clarity.
    function _settleSingleTokenRoyalty(uint256 perTokenSale, uint256 tokenId)
        internal
        returns (uint256 paid)
    {
        if (perTokenSale == 0) return 0;
        try IERC2981(address(nftCollection)).royaltyInfo(tokenId, perTokenSale)
            returns (address receiver, uint256 amount)
        {
            if (receiver == address(0) || amount == 0) return 0;
            // AUDIT FIX (BATCH-B H1, Sudoswap V2 LSSVMPair pattern): cap at
            // 25% of per-token sale.
            if (amount > perTokenSale >> 2) return 0;
            if (amount >= perTokenSale) return 0;
            (bool success, uint8 mode) =
                WETHFallbackLib.safeTransferETHOrWrapNoRevert(weth, receiver, amount);
            if (success) {
                paid = amount;
                if (mode == 1) {
                    emit RoyaltyFallbackToWETH(receiver, amount, tokenId);
                } else {
                    emit RoyaltyPaid(receiver, amount, tokenId);
                }
            } else if (mode == 2) {
                // AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18):
                // mode==2 — deposit succeeded but WETH transfer failed; the
                // pool now holds stranded WETH. Credit the receiver's pull
                // slot so they (and only they) can self-claim. Aggregate
                // counter `totalPendingStrandedWETH` reserves the balance
                // so the owner-only `rescueStrandedRoyalty` cannot touch
                // receiver-owed funds. The pool's accounting still treats
                // this as "royalty paid" (the funds left the pool's ETH
                // bucket) so the seller's net is unchanged.
                pendingStrandedWETH[receiver] += amount;
                totalPendingStrandedWETH += amount;
                paid = amount;
                emit RoyaltyOrphaned(receiver, amount, tokenId);
                emit StrandedRoyaltyCredited(receiver, amount, tokenId);
            } else {
                // mode==3: deposit itself failed — ETH is untouched in the
                // pool. Silently skip the royalty for this token (mirror
                // legacy "silent skip" behavior for non-paying collections).
                emit RoyaltyOrphaned(receiver, amount, tokenId);
            }
        } catch {
            // Collection doesn't implement ERC-2981 (or reverted). Pay zero.
        }
    }

    /// @notice AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): receiver
    ///         self-claim path for WETH that got stranded by mode==2 royalty
    ///         delivery failures. Bypasses the owner — receivers own their
    ///         credit and pull at will.
    /// @dev    Routes through SafeERC20.safeTransfer so non-standard WETHs
    ///         that return false (rather than revert) are handled correctly.
    function claimStrandedRoyaltyWETH() external nonReentrant {
        uint256 amount = pendingStrandedWETH[msg.sender];
        if (amount == 0) revert NoStrandedCredit();
        pendingStrandedWETH[msg.sender] = 0;
        totalPendingStrandedWETH -= amount;
        IERC20(weth).safeTransfer(msg.sender, amount);
        emit StrandedRoyaltyClaimed(msg.sender, amount);
    }

    /// @notice AUDIT FIX (BATCH-B H3, Sudoswap V2 withdrawERC20 + Aave V3 rescueTokens pattern):
    ///         Recover stranded WETH that piled up from royalty receiver dual-revert.
    /// @dev    AUDIT FIX (Wave-B re-run, F-19-2 / F-55-7 / M-18): owner can
    ///         only sweep the portion of WETH NOT owed to specific receivers
    ///         (mode==2 events credit `pendingStrandedWETH[receiver]`). The
    ///         owner-rescuable amount is `wethBalance − totalPendingStrandedWETH`.
    ///         Pre-fix the owner could sweep the entire WETH balance,
    ///         silently appropriating receiver-owed credits. Receivers must
    ///         use `claimStrandedRoyaltyWETH` for their own pull credits.
    /// @dev    Recipient is the pool owner (same trust boundary that already
    ///         controls withdrawNFTs / withdrawETH / claimLPFees). No
    ///         timelock — these funds were never supposed to be in the pool.
    function rescueStrandedRoyalty() external onlyOwner nonReentrant {
        IERC20 wethToken = IERC20(weth);
        uint256 totalWeth = wethToken.balanceOf(address(this));
        uint256 reserved = totalPendingStrandedWETH;
        if (totalWeth <= reserved) revert NoStrandedRoyalty();
        uint256 sweepable = totalWeth - reserved;
        wethToken.safeTransfer(msg.sender, sweepable);
        emit RoyaltyRescued(msg.sender, sweepable);
    }
}
