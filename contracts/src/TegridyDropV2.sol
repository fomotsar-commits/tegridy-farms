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

/// @title TegridyDropV2 — Click-Deploy NFT Collection Template
/// @notice Drop-in successor to TegridyDrop. Adds OpenSea contractURI (ERC-7572),
///         consolidates all init params into one struct so a factory can wire
///         placeholder URI, contractURI, merkleRoot, and dutch auction config in
///         a single transaction — no half-initialized clones.
///         v1 clones remain untouched; this is a new template deployed alongside.
contract TegridyDropV2 is ERC721("", ""), ERC2981, ReentrancyGuard, Pausable, Initializable {
    using Strings for uint256;

    constructor() {
        _disableInitializers();
    }

    enum MintPhase {
        CLOSED,
        ALLOWLIST,
        PUBLIC,
        DUTCH_AUCTION,
        CANCELLED
    }

    error NotOwner();
    error ZeroAddress();
    error MintClosed();
    error ExceedsMaxSupply();
    error ExceedsWalletLimit();
    error InsufficientPayment();
    error InvalidProof();
    error AlreadyRevealed();
    error WithdrawFailed();
    error ZeroQuantity();
    error InvalidMaxSupply();
    error InvalidFeeBps();
    error InvalidRoyaltyBps();
    error InvalidDutchAuctionConfig();
    error DutchAuctionNotActive();
    error SaleCancelled();
    error SaleNotCancelled();
    error NothingToRefund();
    error InvalidInitialPhase();

    event InitializedV2(
        address indexed creator,
        string name,
        bytes32 merkleRoot,
        bool dutchConfigured,
        MintPhase initialPhase
    );
    event MintPhaseChanged(MintPhase phase);
    event MerkleRootChanged(bytes32 root);
    event MintPriceChanged(uint256 price);
    event MaxPerWalletChanged(uint256 max);
    event BaseURIChanged(string uri);
    event Revealed(string revealURI);
    /// @dev ERC-7572 — marketplaces listen for this to re-index collection metadata.
    event ContractURIUpdated();
    event ContractURIChanged(string uri);
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

    string private _baseTokenURI;
    string private _revealURI;
    bool public revealed;

    /// @notice ERC-7572 collection-level metadata URI. Marketplaces read this for
    ///         banner / description / external_link / royalty fallbacks.
    string private _contractURI;

    uint256 public dutchStartPrice;
    uint256 public dutchEndPrice;
    uint256 public dutchStartTime;
    uint256 public dutchDuration;

    address public creator;
    address public platformFeeRecipient;
    uint16 public platformFeeBps;

    address public weth;

    mapping(address => uint256) public mintedPerWallet;
    mapping(address => uint256) public paidPerWallet;

    /// @notice AUDIT H9: one-way flag set by withdraw(). Once funds have been withdrawn,
    ///         cancelSale() is disabled — the creator has committed to delivery and minters
    ///         can no longer be refunded. Conversely, a sale that is cancelled before
    ///         withdraw() runs guarantees every minter their refund.
    bool public withdrawn;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Init (one-shot, factory-friendly) ───────────────────────────
    /// @notice All initialization parameters in a single struct. The factory builds
    ///         one of these from its own CollectionConfig and passes it here.
    ///         Optional fields: merkleRoot (pass bytes32(0) to skip), any dutch*
    ///         field of 0 skips dutch config, placeholderURI / contractURI_ may be
    ///         empty strings.
    struct InitParams {
        string name;
        string symbol;
        uint256 maxSupply;
        uint256 mintPrice;
        uint256 maxPerWallet;
        uint16 royaltyBps;
        address creator;
        address platformFeeRecipient;
        uint16 platformFeeBps;
        address weth;
        string placeholderURI;
        string contractURI_;
        bytes32 merkleRoot;
        uint256 dutchStartPrice;
        uint256 dutchEndPrice;
        uint256 dutchStartTime;
        uint256 dutchDuration;
        MintPhase initialPhase;
    }

    /// @notice AUDIT M8: cap platform fee at 10% to match LaunchpadV2.MAX_PROTOCOL_FEE_BPS.
    ///         The prior 100% cap allowed direct-clone deployments to siphon all creator share.
    uint16 public constant MAX_PLATFORM_FEE_BPS = 1000;
    /// @notice AUDIT NEW-L7 (LOW): cap ERC-2981 royalty at 10%. Prior code accepted up
    ///         to 100%, which is a marketplace-relations landmine: OpenSea/Blur/LooksRare
    ///         either refuse to list or clip at 2-7.5%, and users seeing a 100% royalty
    ///         signal would lose confidence in the collection. 10% matches the EIP-2981
    ///         norm across mature platforms.
    uint16 public constant MAX_ROYALTY_BPS = 1000;

    function initialize(InitParams calldata p) external initializer {
        if (p.creator == address(0)) revert ZeroAddress();
        if (p.platformFeeRecipient == address(0)) revert ZeroAddress();
        if (p.weth == address(0)) revert ZeroAddress();
        if (p.maxSupply == 0) revert InvalidMaxSupply();
        // AUDIT M8: tightened from 10000 (100%) to MAX_PLATFORM_FEE_BPS (10%).
        if (p.platformFeeBps > MAX_PLATFORM_FEE_BPS) revert InvalidFeeBps();
        // AUDIT NEW-L7: royalty cap tightened from 100% to 10% (see MAX_ROYALTY_BPS).
        if (p.royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyaltyBps();
        if (uint8(p.initialPhase) > uint8(MintPhase.DUTCH_AUCTION)) revert InvalidInitialPhase();

        _dropName = p.name;
        _dropSymbol = p.symbol;
        maxSupply = p.maxSupply;
        mintPrice = p.mintPrice;
        maxPerWallet = p.maxPerWallet;
        creator = p.creator;
        platformFeeRecipient = p.platformFeeRecipient;
        platformFeeBps = p.platformFeeBps;
        weth = p.weth;
        owner = p.creator;

        _setDefaultRoyalty(p.creator, p.royaltyBps);

        if (bytes(p.placeholderURI).length > 0) {
            _baseTokenURI = p.placeholderURI;
            emit BaseURIChanged(p.placeholderURI);
        }

        if (bytes(p.contractURI_).length > 0) {
            _contractURI = p.contractURI_;
            emit ContractURIChanged(p.contractURI_);
            emit ContractURIUpdated();
        }

        if (p.merkleRoot != bytes32(0)) {
            merkleRoot = p.merkleRoot;
            emit MerkleRootChanged(p.merkleRoot);
        }

        // Dutch auction fields are all-or-nothing. Any non-zero field requires the
        // full, valid set and gets validated via the same rules as configureDutchAuction.
        bool dutchConfigured = p.dutchStartPrice != 0 || p.dutchEndPrice != 0 ||
                               p.dutchStartTime != 0 || p.dutchDuration != 0;
        if (dutchConfigured) {
            if (p.dutchStartPrice <= p.dutchEndPrice) revert InvalidDutchAuctionConfig();
            if (p.dutchDuration == 0) revert InvalidDutchAuctionConfig();
            if (p.dutchStartTime == 0) revert InvalidDutchAuctionConfig();
            if (p.dutchStartPrice - p.dutchEndPrice < p.dutchDuration) revert InvalidDutchAuctionConfig();
            dutchStartPrice = p.dutchStartPrice;
            dutchEndPrice = p.dutchEndPrice;
            dutchStartTime = p.dutchStartTime;
            dutchDuration = p.dutchDuration;
            emit DutchAuctionConfigured(p.dutchStartPrice, p.dutchEndPrice, p.dutchStartTime, p.dutchDuration);
        }

        if (p.initialPhase == MintPhase.DUTCH_AUCTION && !dutchConfigured) {
            revert DutchAuctionNotActive();
        }
        if (p.initialPhase == MintPhase.ALLOWLIST && p.merkleRoot == bytes32(0)) {
            revert InvalidProof();
        }
        if (p.initialPhase != MintPhase.CLOSED) {
            mintPhase = p.initialPhase;
            emit MintPhaseChanged(p.initialPhase);
        }

        emit InitializedV2(p.creator, p.name, p.merkleRoot, dutchConfigured, p.initialPhase);
    }

    // ─── ERC721 Metadata ─────────────────────────────────────────────
    function name() public view override returns (string memory) { return _dropName; }
    function symbol() public view override returns (string memory) { return _dropSymbol; }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (revealed) {
            return bytes(_revealURI).length > 0
                ? string.concat(_revealURI, tokenId.toString())
                : "";
        }
        return _baseTokenURI;
    }

    /// @notice ERC-7572 collection-level metadata JSON URI. Empty until set.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ─── Mint ────────────────────────────────────────────────────────
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

        if (mintPhase == MintPhase.ALLOWLIST) {
            // AUDIT NEW-L5 (MEDIUM): double-hashed leaf per OpenZeppelin MerkleTree
            // recommendation (since OZ v4.9). The single-hash variant is vulnerable to
            // the "second preimage attack" where an attacker presents an intermediate
            // Merkle node as a leaf-proof. Double hashing makes leaf and internal-node
            // hash domains disjoint. Off-chain tree construction must apply the same
            // double-hash shape:
            //   leaf = keccak256( bytes.concat( keccak256( abi.encode(drop, minter) ) ) )
            bytes32 leaf = keccak256(
                bytes.concat(keccak256(abi.encode(address(this), msg.sender)))
            );
            if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
        }

        uint256 startId = totalSupply + 1;
        for (uint256 i; i < quantity; ++i) {
            _safeMint(msg.sender, startId + i);
        }
        totalSupply += quantity;
        mintedPerWallet[msg.sender] += quantity;
        paidPerWallet[msg.sender] += totalCost;

        if (msg.value > totalCost) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, msg.value - totalCost);
        }

        emit Minted(msg.sender, startId, quantity, totalCost);
    }

    function currentPrice() public view returns (uint256) {
        if (mintPhase == MintPhase.DUTCH_AUCTION) {
            return _dutchAuctionPrice();
        }
        return mintPrice;
    }

    function _dutchAuctionPrice() internal view returns (uint256) {
        if (block.timestamp < dutchStartTime) return dutchStartPrice;
        uint256 elapsed = block.timestamp - dutchStartTime;
        if (elapsed >= dutchDuration) return dutchEndPrice;
        uint256 priceDrop = dutchStartPrice - dutchEndPrice;
        uint256 decay = (priceDrop * elapsed) / dutchDuration;
        return dutchStartPrice - decay;
    }

    // ─── Admin ───────────────────────────────────────────────────────
    function setMintPhase(MintPhase phase) external onlyOwner {
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        if (phase == MintPhase.CANCELLED) revert SaleNotCancelled();
        // AUDIT NEW-L1: once withdraw has run, the creator has committed to delivery
        // on current minters. Re-opening to ALLOWLIST/PUBLIC/DUTCH would accept fresh
        // mints whose cancel path is already permanently blocked by `withdrawn=true`,
        // reproducing the H9 bypass. Lock phase to CLOSED after withdraw.
        if (withdrawn && phase != MintPhase.CLOSED) revert WithdrawFailed();
        if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
            revert DutchAuctionNotActive();
        }
        mintPhase = phase;
        emit MintPhaseChanged(phase);
    }

    function setMerkleRoot(bytes32 root) external onlyOwner {
        merkleRoot = root;
        emit MerkleRootChanged(root);
    }

    function setMintPrice(uint256 price) external onlyOwner {
        require(price > 0 || mintPhase == MintPhase.CLOSED, "ZERO_PRICE_ONLY_WHEN_CLOSED");
        mintPrice = price;
        emit MintPriceChanged(price);
    }

    function setMaxPerWallet(uint256 max) external onlyOwner {
        maxPerWallet = max;
        emit MaxPerWalletChanged(max);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
        emit BaseURIChanged(uri);
    }

    /// @notice Update the collection-level metadata URI. Emits ERC-7572
    ///         ContractURIUpdated so OpenSea/marketplaces re-index without a manual step.
    function setContractURI(string calldata uri) external onlyOwner {
        _contractURI = uri;
        emit ContractURIChanged(uri);
        emit ContractURIUpdated();
    }

    function reveal(string calldata revealURI) external onlyOwner {
        if (revealed) revert AlreadyRevealed();
        revealed = true;
        _revealURI = revealURI;
        emit Revealed(revealURI);
    }

    function configureDutchAuction(
        uint256 startPrice,
        uint256 endPrice,
        uint256 startTime,
        uint256 duration
    ) external onlyOwner {
        if (startPrice <= endPrice) revert InvalidDutchAuctionConfig();
        if (duration == 0) revert InvalidDutchAuctionConfig();
        if (startTime == 0) revert InvalidDutchAuctionConfig();
        if (startPrice - endPrice < duration) revert InvalidDutchAuctionConfig();

        dutchStartPrice = startPrice;
        dutchEndPrice = endPrice;
        dutchStartTime = startTime;
        dutchDuration = duration;

        emit DutchAuctionConfigured(startPrice, endPrice, startTime, duration);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Withdraw mint proceeds to creator + platform.
    ///         AUDIT H9: sets `withdrawn = true` (one-way) which permanently disables
    ///         cancelSale(). The creator/platform commit to delivery the moment they
    ///         take funds — minters can no longer be refunded after withdraw runs.
    ///         Counterpart guarantee: a sale that is cancelled BEFORE withdraw is called
    ///         still has its full ETH balance available for refund().
    ///
    ///         AUDIT NEW-L1 (CRITICAL): the H9 design assumed withdraw runs once, after
    ///         the creator commits. But the prior code was callable repeatedly during an
    ///         active mint — creator could drain batch 1, accept batch 2 mints (cancel
    ///         now blocked by `withdrawn=true`), drain batch 2, and leave batch-2 minters
    ///         with no refund path. This now requires the sale to be explicitly ended
    ///         (mintPhase == CLOSED) OR sold out (totalSupply == maxSupply) before any
    ///         withdraw is allowed, matching the Thirdweb / Manifold drop pattern.
    function withdraw() external onlyOwner nonReentrant {
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        // AUDIT NEW-L1: only permit withdraw after the sale is formally ended.
        // `mintPhase == CLOSED` is the owner's explicit commit-to-delivery signal;
        // sold-out (totalSupply == maxSupply) is the same signal implied by supply.
        bool soldOut = maxSupply > 0 && totalSupply >= maxSupply;
        if (mintPhase != MintPhase.CLOSED && !soldOut) revert WithdrawFailed();

        uint256 balance = address(this).balance;
        if (balance == 0) revert WithdrawFailed();

        // AUDIT H9: lock out cancelSale() going forward.
        withdrawn = true;

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

    /// @notice Cancel the sale and enable refund() for all minters.
    ///         AUDIT H9: blocked once withdraw() has run — the creator can no longer
    ///         "cancel after extracting funds" to leave minters unable to refund.
    function cancelSale() external onlyOwner {
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        // AUDIT H9: cancellation must precede withdraw, never follow it.
        if (withdrawn) revert WithdrawFailed();
        mintPhase = MintPhase.CANCELLED;
        emit MintPhaseChanged(MintPhase.CANCELLED);
        emit SaleCancelledEvent(totalSupply, address(this).balance);
    }

    function refund() external nonReentrant {
        if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
        uint256 owed = paidPerWallet[msg.sender];
        if (owed == 0) revert NothingToRefund();
        paidPerWallet[msg.sender] = 0;
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed);
        emit Refunded(msg.sender, owed);
    }

    // ─── Owner Management (2-step) ───────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function renounceOwnership() external view onlyOwner {
        revert("RENOUNCE_DISABLED");
    }
}
