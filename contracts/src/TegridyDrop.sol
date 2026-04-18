// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

/// @title TegridyDrop — NFT Collection Template (EIP-1167 Clone)
/// @notice Cloned by TegridyLaunchpad via CREATE2. Uses initialize() instead of constructor.
///         Supports allowlist (Merkle), public mint, Dutch auction, delayed reveal,
///         revenue splitting, and ERC-2981 royalties.
contract TegridyDrop is ERC721("", ""), ERC2981, ReentrancyGuard, Pausable, Initializable {
    using Strings for uint256;

    // ─── Constructor (disable initializers on implementation) ────────
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Enums ───────────────────────────────────────────────────────
    enum MintPhase {
        CLOSED,
        ALLOWLIST,
        PUBLIC,
        DUTCH_AUCTION,
        /// @notice Terminal state. Minting blocked, creator withdraw blocked, minters may
        /// pull back their payments via refund(). Transition via cancelSale(); cannot undo.
        CANCELLED
    }

    // ─── Custom Errors ───────────────────────────────────────────────
    error NotOwner();
    error ZeroAddress();
    error MintClosed();
    error ExceedsMaxSupply();
    error ExceedsWalletLimit();
    error InsufficientPayment();
    error InvalidProof();
    error AlreadyRevealed();
    error NotRevealed();
    error WithdrawFailed();
    error ZeroQuantity();
    error InvalidMaxSupply();
    error InvalidFeeBps();
    error InvalidRoyaltyBps();
    error InvalidDutchAuctionConfig();
    error DutchAuctionNotActive();
    error InvalidMintPrice();
    error SaleCancelled();
    error SaleNotCancelled();
    error NothingToRefund();
    error RefundFailed();

    // ─── Events ──────────────────────────────────────────────────────
    event Initialized(
        string name,
        string symbol,
        uint256 maxSupply,
        uint256 mintPrice,
        uint256 maxPerWallet,
        address creator,
        address platformFeeRecipient,
        uint16 platformFeeBps
    );
    event MintPhaseChanged(MintPhase phase);
    event MerkleRootChanged(bytes32 root);
    event MintPriceChanged(uint256 price);
    event MaxPerWalletChanged(uint256 max);
    event BaseURIChanged(string uri);
    event Revealed(string revealURI);
    event DutchAuctionConfigured(
        uint256 startPrice,
        uint256 endPrice,
        uint256 startTime,
        uint256 duration
    );
    event Minted(address indexed to, uint256 startTokenId, uint256 quantity, uint256 paid);
    event Withdrawn(address indexed creator, uint256 creatorAmount, address indexed platform, uint256 platformAmount);
    event SaleCancelledEvent(uint256 mintedAtCancel, uint256 reservedForRefunds);
    event Refunded(address indexed minter, uint256 amount);

    // ─── State ───────────────────────────────────────────────────────
    // Manual owner (not OwnableNoRenounce — clone can't use constructor args)
    // 2-step ownership transfer for safety (mirrors Ownable2Step)
    address public owner;
    address public pendingOwner;

    string private _dropName;
    string private _dropSymbol;

    uint256 public maxSupply;
    uint256 public mintPrice;
    uint256 public maxPerWallet;
    uint256 public totalSupply;

    MintPhase public mintPhase;
    bytes32 public merkleRoot;

    // Delayed reveal
    string private _baseTokenURI;
    string private _revealURI;
    bool public revealed;

    // Dutch auction
    uint256 public dutchStartPrice;
    uint256 public dutchEndPrice;
    uint256 public dutchStartTime;
    uint256 public dutchDuration;

    // Revenue split
    address public creator;
    address public platformFeeRecipient;
    uint16 public platformFeeBps;

    // WETH address for safe withdrawal fallback
    address public weth;

    // Per-wallet mint tracking
    mapping(address => uint256) public mintedPerWallet;
    /// @notice Per-wallet cumulative ETH paid into the drop (net of instant refunds).
    ///         Used by refund() after cancelSale() so minters can recover exactly what
    ///         they paid. Because Dutch auction prices vary per mint, we cannot derive
    ///         this from quantity alone — the running total must be stored.
    mapping(address => uint256) public paidPerWallet;

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Initialize (replaces constructor for clones) ────────────────
    /// @notice Initialize the drop. Called once by the factory after cloning.
    /// @param _name          Collection name
    /// @param _symbol        Collection symbol
    /// @param _maxSupply     Maximum number of tokens
    /// @param _mintPrice     Price per token in wei (for PUBLIC / ALLOWLIST phases)
    /// @param _maxPerWallet  Max tokens any single wallet can mint
    /// @param _royaltyBps    ERC-2981 royalty in basis points (max 10000)
    /// @param _creator       Creator / collection owner address
    /// @param _platformFeeRecipient Address that receives the platform fee share
    /// @param _platformFeeBps Platform fee in basis points (max 10000)
    function initialize(
        string calldata _name,
        string calldata _symbol,
        uint256 _maxSupply,
        uint256 _mintPrice,
        uint256 _maxPerWallet,
        uint16 _royaltyBps,
        address _creator,
        address _platformFeeRecipient,
        uint16 _platformFeeBps,
        address _weth
    ) external initializer {
        if (_creator == address(0)) revert ZeroAddress();
        if (_platformFeeRecipient == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_maxSupply == 0) revert InvalidMaxSupply();
        if (_platformFeeBps > 10000) revert InvalidFeeBps();
        if (_royaltyBps > 10000) revert InvalidRoyaltyBps();

        _dropName = _name;
        _dropSymbol = _symbol;
        maxSupply = _maxSupply;
        mintPrice = _mintPrice;
        maxPerWallet = _maxPerWallet;
        creator = _creator;
        platformFeeRecipient = _platformFeeRecipient;
        platformFeeBps = _platformFeeBps;
        weth = _weth;
        owner = _creator;

        // ERC-2981: creator receives royalties
        _setDefaultRoyalty(_creator, _royaltyBps);

        emit Initialized(
            _name, _symbol, _maxSupply, _mintPrice,
            _maxPerWallet, _creator, _platformFeeRecipient, _platformFeeBps
        );
    }

    // ─── ERC721 Metadata Overrides ───────────────────────────────────
    /// @dev Override name() to return the clone-initialized name
    function name() public view override returns (string memory) {
        return _dropName;
    }

    /// @dev Override symbol() to return the clone-initialized symbol
    function symbol() public view override returns (string memory) {
        return _dropSymbol;
    }

    /// @dev Override tokenURI to support delayed reveal
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        if (revealed) {
            return bytes(_revealURI).length > 0
                ? string.concat(_revealURI, tokenId.toString())
                : "";
        }

        // Pre-reveal: all tokens share the same placeholder URI
        return _baseTokenURI;
    }

    // ─── ERC165 ──────────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ─── Mint ────────────────────────────────────────────────────────
    /// @notice Mint tokens. Handles ALLOWLIST, PUBLIC, and DUTCH_AUCTION phases.
    /// @param quantity Number of tokens to mint
    /// @param proof    Merkle proof (only required for ALLOWLIST phase, empty otherwise)
    function mint(uint256 quantity, bytes32[] calldata proof)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (quantity == 0) revert ZeroQuantity();
        if (mintPhase == MintPhase.CLOSED) revert MintClosed();
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        if (mintPhase == MintPhase.DUTCH_AUCTION && block.timestamp < dutchStartTime) {
            revert DutchAuctionNotActive();
        }
        if (totalSupply + quantity > maxSupply) revert ExceedsMaxSupply();
        if (maxPerWallet > 0 && mintedPerWallet[msg.sender] + quantity > maxPerWallet) {
            revert ExceedsWalletLimit();
        }

        uint256 price = currentPrice();
        uint256 totalCost = price * quantity;
        if (msg.value < totalCost) revert InsufficientPayment();

        // Allowlist verification
        // Audit H-11: domain-separate the Merkle leaf with address(this). The prior
        // `keccak256(abi.encodePacked(msg.sender))` produced a leaf that was identical
        // across every drop that used the same pattern, so a valid proof for wallet W
        // on drop A was also a valid proof for wallet W on drop B. Binding the leaf to
        // this contract's address makes each drop's allowlist cryptographically unique.
        // Off-chain generators must include address(this) when building the tree.
        if (mintPhase == MintPhase.ALLOWLIST) {
            bytes32 leaf = keccak256(abi.encodePacked(address(this), msg.sender));
            if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
        }

        // Mint tokens
        uint256 startId = totalSupply + 1; // Token IDs are 1-indexed
        for (uint256 i; i < quantity; ++i) {
            _safeMint(msg.sender, startId + i);
        }
        totalSupply += quantity;
        mintedPerWallet[msg.sender] += quantity;
        // Track net paid (excluding overpayment refund below) so refund() can reimburse if
        // the sale is later cancelled by the creator or platform.
        paidPerWallet[msg.sender] += totalCost;

        // SECURITY FIX: Use WETHFallbackLib for refund instead of full-gas .call{value}.
        // Full-gas call allows recipient to execute arbitrary code during callback.
        // WETHFallbackLib uses 10k gas stipend to prevent cross-contract reentrancy.
        if (msg.value > totalCost) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, msg.value - totalCost);
        }

        emit Minted(msg.sender, startId, quantity, totalCost);
    }

    // ─── Price Logic ─────────────────────────────────────────────────
    /// @notice Returns the current mint price based on the active phase.
    /// @return The price per token in wei
    function currentPrice() public view returns (uint256) {
        if (mintPhase == MintPhase.DUTCH_AUCTION) {
            return _dutchAuctionPrice();
        }
        return mintPrice;
    }

    /// @dev Linear decay: startPrice -> endPrice over duration
    function _dutchAuctionPrice() internal view returns (uint256) {
        if (block.timestamp < dutchStartTime) return dutchStartPrice;
        uint256 elapsed = block.timestamp - dutchStartTime;
        if (elapsed >= dutchDuration) return dutchEndPrice;

        uint256 priceDrop = dutchStartPrice - dutchEndPrice;
        uint256 decay = (priceDrop * elapsed) / dutchDuration;
        return dutchStartPrice - decay;
    }

    // ─── Admin: Phase & Config ───────────────────────────────────────
    /// @notice Set the current mint phase
    function setMintPhase(MintPhase phase) external onlyOwner {
        // Once cancelled, the sale is terminal — minters are owed refunds and cannot be
        // re-exposed to mint pressure or have their reserved balance rug-pulled.
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        // setMintPhase cannot be used to "cancel" (use cancelSale for semantic clarity +
        // event emission). Forces operators to use the explicit irrevocable entry point.
        if (phase == MintPhase.CANCELLED) revert SaleNotCancelled();
        if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
            revert DutchAuctionNotActive();
        }
        mintPhase = phase;
        emit MintPhaseChanged(phase);
    }

    /// @notice Set the Merkle root for the allowlist
    function setMerkleRoot(bytes32 root) external onlyOwner {
        merkleRoot = root;
        emit MerkleRootChanged(root);
    }

    /// @notice Set the mint price (for PUBLIC and ALLOWLIST phases)
    function setMintPrice(uint256 price) external onlyOwner {
        require(price > 0 || mintPhase == MintPhase.CLOSED, "ZERO_PRICE_ONLY_WHEN_CLOSED");
        mintPrice = price;
        emit MintPriceChanged(price);
    }

    /// @notice Set the max mints per wallet (0 = unlimited)
    function setMaxPerWallet(uint256 max) external onlyOwner {
        maxPerWallet = max;
        emit MaxPerWalletChanged(max);
    }

    // ─── Admin: URI & Reveal ─────────────────────────────────────────
    /// @notice Set the pre-reveal base URI (placeholder)
    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
        emit BaseURIChanged(uri);
    }

    /// @notice Reveal the collection. Sets the real base URI and locks reveal.
    /// @param revealURI The real base URI for revealed metadata (e.g. "ipfs://Qm.../")
    function reveal(string calldata revealURI) external onlyOwner {
        if (revealed) revert AlreadyRevealed();
        revealed = true;
        _revealURI = revealURI;
        emit Revealed(revealURI);
    }

    // ─── Admin: Dutch Auction ────────────────────────────────────────
    /// @notice Configure the Dutch auction parameters
    /// @param startPrice Starting price in wei (highest)
    /// @param endPrice   Ending price in wei (lowest, a.k.a. resting price)
    /// @param startTime  Unix timestamp when the auction begins
    /// @param duration   Duration in seconds over which price decays
    function configureDutchAuction(
        uint256 startPrice,
        uint256 endPrice,
        uint256 startTime,
        uint256 duration
    ) external onlyOwner {
        if (startPrice <= endPrice) revert InvalidDutchAuctionConfig();
        if (duration == 0) revert InvalidDutchAuctionConfig();
        if (startTime == 0) revert InvalidDutchAuctionConfig();
        // Audit H-10: decay = (priceDrop * elapsed) / duration. If priceDrop < duration,
        // integer division in _dutchAuctionPrice truncates early decay to 0, so the
        // price stays pinned at startPrice for a significant fraction of the auction.
        // Enforcing priceDrop >= duration guarantees at least 1 wei of decay per
        // elapsed second and monotone price decrease across every second.
        if (startPrice - endPrice < duration) revert InvalidDutchAuctionConfig();

        dutchStartPrice = startPrice;
        dutchEndPrice = endPrice;
        dutchStartTime = startTime;
        dutchDuration = duration;

        emit DutchAuctionConfigured(startPrice, endPrice, startTime, duration);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Withdraw ────────────────────────────────────────────────────
    /// @notice Withdraw contract balance. Splits between creator and platform.
    ///         Creator gets (100% - platformFeeBps), platform gets platformFeeBps.
    ///         Uses WETHFallbackLib to prevent DoS if a recipient reverts on ETH transfer.
    /// SECURITY FIX: Added onlyOwner. Previously anyone could trigger withdrawal,
    /// removing timing control from the creator (OZ Ownable pattern).
    function withdraw() external onlyOwner nonReentrant {
        // Cancelled sales reserve their balance for refunds. Creator/platform cannot drain.
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        uint256 balance = address(this).balance;
        if (balance == 0) revert WithdrawFailed();

        uint256 platformAmount = (balance * platformFeeBps) / 10000;
        uint256 creatorAmount = balance - platformAmount;

        if (platformAmount > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, platformFeeRecipient, platformAmount);
        }

        if (creatorAmount > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, creator, creatorAmount);
        }

        emit Withdrawn(creator, creatorAmount, platformFeeRecipient, platformAmount);
    }

    // ─── Cancel + Refund ─────────────────────────────────────────────
    /// @notice Irreversibly cancel the sale. Blocks further mints and blocks creator
    ///         withdraw; minters may call refund() to recover exactly what they paid.
    ///         Only callable by the owner (creator). Once CANCELLED, phase cannot change.
    function cancelSale() external onlyOwner {
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        mintPhase = MintPhase.CANCELLED;
        emit MintPhaseChanged(MintPhase.CANCELLED);
        emit SaleCancelledEvent(totalSupply, address(this).balance);
    }

    /// @notice Claim an ETH refund for the net amount you paid. Available only after
    ///         cancelSale(). Minter keeps their NFTs (ownership is not clawed back);
    ///         the assumption is that a cancelled drop's tokens are worthless metadata.
    ///         Uses WETHFallbackLib so a reverting receiver cannot trap refunds.
    function refund() external nonReentrant {
        if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
        uint256 owed = paidPerWallet[msg.sender];
        if (owed == 0) revert NothingToRefund();
        // CEI: clear credit before external call.
        paidPerWallet[msg.sender] = 0;
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed);
        emit Refunded(msg.sender, owed);
    }

    /// @notice Prevent `setMintPhase(...)` from re-activating a cancelled sale.
    ///         The owner's `setMintPhase` path still exists; this check bolts shut
    ///         the CANCELLED → anything-else edge.

    // ─── Owner Management (2-step, mirrors Ownable2Step) ─────────────
    /// @notice Begin ownership transfer. New owner must call acceptOwnership().
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    /// @notice Complete ownership transfer. Must be called by the pending owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Renounce ownership is disabled for safety.
    function renounceOwnership() external view onlyOwner {
        revert("RENOUNCE_DISABLED");
    }
}
