// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
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
    /// @notice AUDIT FIX FRESH-2026 (post-fix scan5 INV-1): aggregate of all
    ///         outstanding `priorOwnerOwed[]` claims. Reserved against the
    ///         pool's ETH balance so `_lpAvailableETH` correctly excludes
    ///         these obligations. Sibling-canonical of `totalCommitBonds`
    ///         (VoteIncentives) and `totalPendingETH` (ReferralSplitter).
    ///         Without this, the new owner's `withdrawETH` / `removeLiquidity`
    ///         / sell paths could drain ETH that the prior owner is still
    ///         entitled to claim.
    uint256 public totalPriorOwnerOwed;

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
    error NotOwner();
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
    ///         to the collection's royalty receiver during a swap. `tokenId` is
    ///         the first NFT in the batch (used as the royalty-rate anchor —
    ///         most ERC-2981 implementations use a single rate per collection).
    event RoyaltyPaid(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    event RoyaltyFallbackToWETH(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    /// AUDIT FIX (BATCH-B H3): emitted when both ETH leg AND WETH leg of royalty
    /// payment fail (mode == 2). The royalty is silently skipped at swap time;
    /// off-chain monitoring can flag the receiver for `rescueStrandedRoyalty`.
    event RoyaltyOrphaned(address indexed receiver, uint256 amount, uint256 indexed tokenId);
    /// AUDIT FIX (BATCH-B H3): emitted when owner sweeps stranded WETH that
    /// accumulated from one or more `RoyaltyOrphaned` events.
    event RoyaltyRescued(address indexed to, uint256 amount);
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
        // AUDIT FIX FRESH-2026 (post-fix scan F-62-1): mirror the proposeSpotPrice cap
        //         at init so a hostile creator cannot ship a pool with `_spotPrice ≈
        //         uint256.max / 50` that overflows `_minLiquidityBuffer`'s
        //         `100 * spotPrice` math. Cap is the same MAX_SPOT_PRICE = 1M ether
        //         enforced by the post-deploy `proposeSpotPrice` path.
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

    function swapETHForNFTs(
        uint256[] calldata tokenIds,
        uint256 maxTotalCost,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX: DEEP-NFTPOOL-01: forward-direction same-block guard.
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
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

        // AUDIT FIX FRESH-2026: NFTPOOL-SPOT-CAP-POSTSWAP [MEDIUM] — enforce
        //         the `MAX_SPOT_PRICE` ceiling on the post-swap value, not
        //         just at construction / `proposeSpotPrice`. A long enough
        //         run of buys with no intervening sells could otherwise push
        //         `spotPrice` past the cap silently, then permanently brick
        //         `proposeSpotPrice` for the operator (line 468 rejects any
        //         `newPrice > MAX_SPOT_PRICE`, including legitimate
        //         downward repricings that are still above the cap). With
        //         the cap enforced here, the curve clamps to "no more buys
        //         once cap is hit" — sellers must clear inventory to bring
        //         `spotPrice` back under the ceiling, restoring the price-
        //         management primitive. Sudoswap V2 enforces the same
        //         per-swap ceiling on LinearCurve.
        spotPrice += delta * numItems;
        if (spotPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();

        for (uint256 i = 0; i < numItems; i++) {
            uint256 tokenId = tokenIds[i];
            if (_idToIndex[tokenId] == 0) revert NFTNotHeld(tokenId);
            _removeHeldId(tokenId);
            // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
            // slither-disable-next-line reentrancy-no-eth
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
        uint256 spotRevenue = inputAmount - protocolFee - lpFee;
        _settleRoyalty(spotRevenue, tokenIds[0]);

        uint256 excess = msg.value - inputAmount;
        if (excess > 0) {
            _sendETH(msg.sender, excess);
        }

        lastSwapBlock = block.timestamp;
        _swapInFlight = false;
        // AUDIT FIX V3-NFTPOOL-01: no `_swapCaller` clear needed — we never set it.

        emit SwapETHForNFTs(msg.sender, tokenIds, inputAmount);
    }

    function swapNFTsForETH(
        uint256[] calldata tokenIds,
        uint256 minOutput,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        // AUDIT FIX: DEEP-NFTPOOL-01
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
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

        // AUDIT FIX 2026-07-12: the slippage floor is enforced later against the
        // NET proceeds the seller actually receives (gross curve payout minus the
        // ERC-2981 royalty), NOT the gross `outputAmount` here. Pre-fix the check
        // sat on this line against the pre-royalty gross, so a collection with up
        // to a 25% royalty could pay the seller strictly LESS than the `minOutput`
        // they specified. Canonical Sudoswap V2 (LSSVMPair) subtracts royalty
        // BEFORE the `minExpectedTokenOutput` comparison; we mirror that. See the
        // net-output check just before `_sendETH` below.
        (uint256 outputAmount, uint256 protocolFee, uint256 lpFee) = _getSellPriceFull(numItems);

        spotPrice -= delta * numItems;

        for (uint256 i = 0; i < numItems; i++) {
            // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
            // slither-disable-next-line reentrancy-no-eth
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
        uint256 royalty = _settleRoyalty(outputAmount, tokenIds[0]);

        // AUDIT FIX 2026-07-12: enforce the slippage floor against the NET amount
        // the seller actually receives (`outputAmount - royalty`). Reverting here
        // rolls back the NFT inflow, fee accrual and the royalty payment above, so
        // the seller is never forced to accept less than `minOutput`.
        uint256 netOutput = outputAmount - royalty;
        if (netOutput < minOutput) revert InsufficientPayout();

        // AUDIT FIX V4-NFTPOOL-01 (FRESH-2026 H2): clear `_swapCaller` BEFORE
        // the ETH payout. `_sendETH` reaches the seller's `receive()` (or a
        // malicious collection's `safeTransferFrom` hook earlier in the
        // batch), which can call back into `nftCollection.safeTransferFrom(
        // seller, address(this), bogusTokenId)` and stuff arbitrary tokenIds
        // into `_heldIds` via `onERC721Received` because the
        // `authorizedSwapInflow = _swapInFlight && from == _swapCaller`
        // gate is still open. Clearing `_swapCaller` first closes the
        // window. Same exploit shape that V3-NFTPOOL-01 already fixed in
        // the BUY direction; the SELL direction was missed.
        _swapCaller = address(0);
        _sendETH(msg.sender, netOutput);

        lastSwapBlock = block.timestamp;
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
            // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
            // slither-disable-next-line reentrancy-no-eth
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
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
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
            // AUDIT FIX FRESH-2026 (post-fix scan5 INV-1): track aggregate
            //         so `_lpAvailableETH` reserves the prior-owner claim.
            totalPriorOwnerOwed += snapshot;
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
        // AUDIT FIX FRESH-2026 (post-fix scan5 INV-1): decrement aggregate
        //         alongside the per-recipient slot to keep `_lpAvailableETH`
        //         reservation in sync.
        totalPriorOwnerOwed -= amount;
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
            // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
            // slither-disable-next-line reentrancy-no-eth
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
        // AUDIT FIX FRESH-2026 (post-fix scan5 INV-1): include outstanding
        //         prior-owner claims in the reservation. Pre-fix the new
        //         owner's withdrawal paths could drain ETH the prior owner
        //         is still owed; sibling-canonical of `totalCommitBonds` /
        //         `totalPendingETH` reservation patterns elsewhere.
        uint256 reserved = accumulatedProtocolFees + accumulatedLPFees + totalPriorOwnerOwed;
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

    /// @dev Settle ERC-2981 royalties on a swap. Queries the collection's
    ///      `royaltyInfo(firstTokenId, totalSale)`; if the collection
    ///      implements ERC-2981 (try-call succeeds), forwards the royalty
    ///      amount to the receiver via WETHFallbackLib (10k-gas-stipend
    ///      ETH leg, falls back to WETH wrap on receiver-revert). Returns
    ///      the amount actually paid out so the caller can deduct it from
    ///      their swap proceeds.
    /// @dev    Most ERC-2981 implementations use a single rate per
    ///         collection (BPS of sale price), so anchoring on the first
    ///         tokenId is faithful. Bounded sanity checks on the returned
    ///         tuple defend against pathological royalty curves
    ///         (`amount >= totalSale` would zero out the seller — refuse).
    /// @param  totalSale Aggregate sale value in ETH for the batch.
    /// @param  firstTokenId First token in the batch — used as the royalty
    ///         rate anchor.
    /// @return royaltyPaid Amount of ETH (or WETH-fallback) sent to the
    ///         royalty receiver. Zero if collection doesn't implement
    ///         ERC-2981, or if the response is invalid (zero receiver,
    ///         zero amount, or amount ≥ totalSale).
    function _settleRoyalty(uint256 totalSale, uint256 firstTokenId)
        internal
        returns (uint256 royaltyPaid)
    {
        if (totalSale == 0) return 0;
        // AUDIT FIX 2026-05-16 LOW: gas cap on the external royaltyInfo call.
        // Pre-fix, `try IERC2981(...).royaltyInfo(...)` forwarded `gasleft()*63/64`.
        // A hostile collection's royaltyInfo that burns all forwarded gas (infinite
        // loop, `assert(false)` after slow path) reverted every swap OOG because
        // the catch only has 1/64 of original gas — insufficient to finish the
        // post-call NFT transfers + spotPrice update + _sendETH + event emit.
        // 50k matches SafeERC721Call.DEFAULT_OWNER_OF_GAS_BUDGET (sufficient for
        // upgradeable collections with deep proxy chains; insufficient for
        // adversaries running arbitrary code).
        try IERC2981(address(nftCollection)).royaltyInfo{gas: 50_000}(firstTokenId, totalSale)
            returns (address receiver, uint256 amount)
        {
            if (receiver == address(0) || amount == 0) return 0;
            // AUDIT FIX (BATCH-B H1, Sudoswap V2 LSSVMPair pattern):
            // Cap royalty at 25% of sale. Without a cap, a malicious or
            // collection-author-compromised ERC-2981 implementation could
            // return amount = totalSale - 1 (≈99.999% royalty), draining
            // sellers down to 1 wei. Sudoswap V2 enforces exactly this with
            // the bit-shift `saleAmount >> 2` for gas efficiency; we mirror
            // it. The pre-existing `amount >= totalSale` revert remains as
            // a redundant outer guard. Refs: sudoswap/lssvm2 LSSVMPair.sol
            // `_calculateRoyaltiesLogic` — "defends against a rogue Manifold
            // registry that charges extremely high royalties".
            if (amount > totalSale >> 2) return 0;
            // (defensive — the cap above already implies this, but keeps the
            // explicit invariant readable for downstream auditors)
            if (amount >= totalSale) return 0;
            (bool success, uint8 mode) =
                WETHFallbackLib.safeTransferETHOrWrapNoRevert(weth, receiver, amount);
            if (success) {
                royaltyPaid = amount;
                if (mode == 1) {
                    emit RoyaltyFallbackToWETH(receiver, amount, firstTokenId);
                } else {
                    emit RoyaltyPaid(receiver, amount, firstTokenId);
                }
            } else {
                // AUDIT FIX (BATCH-B H3): mode == 2 means BOTH the ETH leg AND
                // the WETH-deposit leg failed (or the WETH-transfer leg failed
                // AFTER deposit succeeded — leaving WETH stranded in this pool).
                // Pre-fix this was silently skipped. Now we emit an event so
                // off-chain monitoring can flag the orphaned receiver and
                // governance can use `rescueStrandedRoyalty` (below) to push
                // the funds to the right place after manual investigation.
                emit RoyaltyOrphaned(receiver, amount, firstTokenId);
            }
        } catch {
            // Collection doesn't implement ERC-2981 (or reverted). Pay zero.
        }
    }

    /// @notice AUDIT FIX (BATCH-B H3, Sudoswap V2 withdrawERC20 + Aave V3 rescueTokens pattern):
    ///         Recover stranded WETH that piled up from royalty receiver dual-revert
    ///         (mode == 2) — the only path by which non-trivial WETH can sit in this
    ///         contract without being attributable to LP/protocol fees (which are
    ///         tracked in `accumulatedLPFees` / `accumulatedProtocolFees` ETH).
    /// @dev    Reservation: forwards ONLY the WETH balance — pool ETH balance and
    ///         accumulated fee accounting are not touched. Recipient is the pool
    ///         owner (same trust boundary that already controls withdrawNFTs /
    ///         withdrawETH / claimLPFees). No timelock — these funds were never
    ///         supposed to be in the pool, and routing them out same-day matches
    ///         Sudoswap V2's owner-can-withdraw-anytime model.
    /// @dev    Emits `RoyaltyRescued` for indexer observability so anyone tracking
    ///         the orphaned RoyaltyOrphaned event chain can confirm settlement.
    function rescueStrandedRoyalty() external onlyOwner nonReentrant {
        IERC20 wethToken = IERC20(weth);
        uint256 stranded = wethToken.balanceOf(address(this));
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (stranded == 0) revert NoStrandedRoyalty();
        wethToken.safeTransfer(msg.sender, stranded);
        emit RoyaltyRescued(msg.sender, stranded);
    }
}
