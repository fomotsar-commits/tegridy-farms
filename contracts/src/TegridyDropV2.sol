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
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";

/// @title TegridyDropV2 — Click-Deploy NFT Collection Template
/// @notice Drop-in successor to TegridyDrop. Adds OpenSea contractURI (ERC-7572),
///         consolidates all init params into one struct so a factory can wire
///         placeholder URI, contractURI, merkleRoot, and dutch auction config in
///         a single transaction — no half-initialized clones.
///         v1 clones remain untouched; this is a new template deployed alongside.
contract TegridyDropV2 is ERC721("", ""), ERC2981, ReentrancyGuard, Pausable, Initializable, TimelockAdmin {
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
    /// @notice AUDIT FIX 2026-05-16 LOW: empty `revealURI` passed to `reveal()`.
    ///         Mirrors `BaseURIEmpty` for `freezeBaseURI` (consistent guard surface).
    error RevealURIEmpty();
    error WithdrawFailed();
    error ZeroQuantity();
    /// AUDIT FIX (BATCH-H M8): per-tx mint quantity cap.
    error ExceedsMintBatchCap();
    uint256 internal constant MAX_MINT_PER_TX = 50;
    error InvalidMaxSupply();
    error InvalidFeeBps();
    error InvalidRoyaltyBps();
    error InvalidDutchAuctionConfig();
    error DutchAuctionNotActive();
    error ExecuteAfterMismatch(); // AUDIT FIX V3-DROP-02
    error SaleCancelled();
    error SaleNotCancelled();
    error NothingToRefund();
    error InvalidInitialPhase();
    /// @notice AUDIT R023 / H-01: setMerkleRoot is now phase-gated and timelocked.
    ///         Reverts when called outside CLOSED phase (prevents mid-ALLOWLIST
    ///         exclusion of pending claimers and atomic swap-mint-swap by the owner).
    error RootRotationBlocked();
    /// @notice AUDIT R014 H-8: thrown by `setMintPhase` while a merkle-root
    ///         rotation proposal is pending. The propose/execute window for
    ///         the root must remain in a non-active phase (CLOSED / CANCELLED
    ///         / paused) for its full 24h timelock — letting the owner toggle
    ///         the phase to ALLOWLIST mid-window enables a smuggle path where
    ///         pending rotation lands inside an active mint.
    error MerkleRotationPending();
    /// @notice AUDIT MICROSCOPE_2026_04_30 C1: allowlist allocation fully consumed.
    error AllowlistAllocationExceeded();
    /// @notice AUDIT MICROSCOPE_2026_04_30 H19: zero-price changes are gated to the
    ///         pre-mint window. Once any tokens have been minted, mintPrice is
    ///         monotonically non-zero to block the toggle-to-free attack.
    error ZeroPricePostMint();
    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: rescueAfterCancellation() called too soon.
    error RescueWindowActive();
    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: rescueAfterCancellation() with nothing left to sweep.
    error NothingToRescue();
    /// @notice AUDIT FIX: DEEP-DROP-01: configureDutchAuction must run while CLOSED so the
    ///         decay curve can never be reset out from under in-flight bidders.
    error DutchConfigPhaseLocked();
    /// @notice AUDIT FIX: DEEP-DROP-02: setMintPrice (any value) must run while CLOSED so
    ///         the owner can never front-run pending mint txs with a price hike.
    error PriceChangePhaseLocked();
    /// @notice AUDIT FIX: DEEP-DROP-05: cancelSale is permitted only before any token has
    ///         been minted. Once any mint has occurred, secondary buyers exist and a cancel
    ///         would enable a refund-arbitrage rug; refund route is unavailable post-mint.
    error CancelAfterFirstMint();
    /// @notice AUDIT FIX: DEEP-DROP-06: setBaseURI is blocked after `freezeBaseURI()` has
    ///         been called OR after `reveal()` has run. Either path produces a one-shot
    ///         immutability commitment for the (placeholder | reveal) URI surface.
    error BaseURIFrozen();
    /// @notice AUDIT FIX: V2-DROP-06: `freezeBaseURI()` rejects a freeze on an empty
    ///         placeholder. Without the guard, a fat-fingered freeze before `setBaseURI`
    ///         would commit the drop to permanent empty `tokenURI()` returns pre-reveal.
    error BaseURIEmpty();
    /// @notice AUDIT FIX: V2-DROP-01 / V2-DROP-03: caller's expected value did not match
    ///         the currently-pending value for a price / dutch-config execute call.
    ///         Mirrors `executeMerkleRoot(bytes32 expectedRoot)` value-binding pattern.
    error MintPriceMismatch();
    error DutchConfigMismatch();
    /// @notice AUDIT FIX: V2-DROP-01: setMintPrice is now obsolete (replaced by
    ///         proposeMintPrice / executeMintPrice). Direct calls revert.
    error UseProposeMintPrice();
    /// @notice AUDIT FIX: V2-DROP-03: configureDutchAuction is now obsolete (replaced by
    ///         proposeDutchAuction / executeDutchAuction). Direct calls revert.
    error UseProposeDutchAuction();
    /// @notice AUDIT FIX: V2-DROP-04: `initialize()` with `initialPhase == DUTCH_AUCTION`
    ///         must not be called with a curve whose decay window has already fully elapsed
    ///         (`dutchStartTime + dutchDuration <= block.timestamp`). Otherwise the drop
    ///         silently launches at the floor price.
    error DutchAuctionAlreadyEnded();

    event InitializedV2(
        address indexed creator,
        string name,
        bytes32 merkleRoot,
        bool dutchConfigured,
        MintPhase initialPhase
    );
    event MintPhaseChanged(MintPhase phase);
    event MerkleRootChanged(bytes32 root);
    /// @notice AUDIT R023 / H-01: emitted by `executeMerkleRoot()` so off-chain
    ///         indexers and prospective allowlist claimers can observe the
    ///         old → new transition explicitly. Pure `MerkleRootChanged` events
    ///         are still emitted at initialize-time (factory wiring path) but
    ///         every owner-initiated rotation now also emits this richer event.
    event MerkleRootRotated(bytes32 indexed oldRoot, bytes32 indexed newRoot);
    /// @notice AUDIT R023 / H-01: lifecycle events for the new propose/execute
    ///         flow on `setMerkleRoot`. Mirrors the propose/execute event shape
    ///         already used by `TegridyLaunchpadV2.proposeProtocolFee`.
    event MerkleRootProposed(bytes32 newRoot, uint256 executeAfter);
    event MerkleRootCancelled(bytes32 newRoot);
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
    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: emitted when the creator sweeps residual
    ///         post-cancellation ETH after the 1-year refund window has elapsed.
    event PostCancellationRescued(address indexed creator, uint256 amount);
    /// @notice AUDIT FIX: DEEP-DROP-06: one-shot freeze on `_baseTokenURI`. After this
    ///         fires, every subsequent `setBaseURI` reverts with `BaseURIFrozen`.
    event BaseURIFrozenEvent();
    /// @notice AUDIT FIX: V2-DROP-01: lifecycle events for the propose/execute flow on
    ///         `setMintPrice`. The 24h-timelocked rotation lets pending buyers observe a
    ///         queued price change and drop their unconfirmed mints if they disagree.
    event MintPriceProposed(uint256 newPrice, uint256 executeAfter);
    event MintPriceCancelled(uint256 newPrice);
    /// @notice AUDIT FIX: V2-DROP-03: lifecycle events for the propose/execute flow on
    ///         `configureDutchAuction`. Mirrors the merkle-root rotation event shape.
    event DutchAuctionProposed(
        uint256 startPrice,
        uint256 endPrice,
        uint256 startTime,
        uint256 duration,
        uint256 executeAfter
    );
    event DutchAuctionCancelled(uint256 startPrice, uint256 endPrice, uint256 startTime, uint256 duration);

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

    /// @notice WETH9 address used by `WETHFallbackLib.safeTransferETHOrWrap`
    ///         for refunds, withdraw splits, and refund payouts.
    /// @dev    AUDIT R014 L-4 (single-write invariant): `weth` is set exactly
    ///         once inside `initialize()` (gated by the OZ Initializable
    ///         `initializer` modifier — re-init reverts) and is never mutated
    ///         elsewhere in this contract. There is intentionally NO setter:
    ///         the address is the WETH9 the factory wired at clone-time and a
    ///         post-init swap would silently break refund/withdraw routing
    ///         (potentially diverting ETH to an attacker-controlled fake-WETH
    ///         that consumes deposits but blocks withdraw). Clones cannot use
    ///         the `immutable` keyword; this comment is the equivalent
    ///         security guarantee. Anyone adding a setter must justify it
    ///         under audit, since doing so reopens this attack surface.
    address public weth;

    mapping(address => uint256) public mintedPerWallet;
    mapping(address => uint256) public paidPerWallet;

    /// @notice AUDIT FIX M-7 (Drop-withdraw includes donations): tracks the
    ///         aggregate sum of all `paidPerWallet[*]` contributions so
    ///         `withdraw()` can pay only legitimate sale revenue and ignore
    ///         any ETH that arrived via `selfdestruct` or coinbase set
    ///         (neither triggers `receive()`). Pre-fix, `withdraw()` used
    ///         `address(this).balance` which could over-pay platformFeeBps
    ///         on donated dust and let a front-running donor inflate the
    ///         platform's take.
    uint256 public totalProceeds;

    /// @notice AUDIT MICROSCOPE_2026_04_30 C1: per-claimer allowlist consumption tracked
    ///         independently of `mintedPerWallet` so a `setMaxPerWallet` bump cannot
    ///         retroactively reopen an allowlister's allocation. Each leaf encodes the
    ///         maximum claimable; this mapping enforces it. Pattern of record: Manifold
    ///         `ERC721LazyPayableClaim` stores per-leaf consumption keyed by `(recipient,
    ///         claimIndex)` against the leaf-encoded amount.
    mapping(address => uint256) public allowlistClaimed;

    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: timestamp at which `cancelSale()` ran.
    ///         Anchors the 1-year refund window after which residual unrefunded ETH
    ///         (lost-keys / dead-contract minters) can be rescued by the creator.
    uint256 public cancelledAt;

    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: window during which `refund()` is the
    ///         only path to extract ETH after cancellation. After it elapses, the
    ///         creator may sweep residuals via `rescueAfterCancellation()`.
    uint256 public constant POST_CANCEL_RESCUE_DELAY = 365 days;

    /// @notice AUDIT H9: one-way flag set by withdraw(). Once funds have been withdrawn,
    ///         cancelSale() is disabled — the creator has committed to delivery and minters
    ///         can no longer be refunded. Conversely, a sale that is cancelled before
    ///         withdraw() runs guarantees every minter their refund.
    bool public withdrawn;

    /// @notice AUDIT FIX: DEEP-DROP-04 (HISTORICAL — see V2-DROP-02): originally a running
    ///         counter of unclaimed refund obligations. Post-DEEP-DROP-05 the counter is
    ///         dead-state — `cancelSale()` is gated to `totalSupply == 0`, so the
    ///         accumulator can never be incremented along a code path where it would later
    ///         be read.
    /// @dev    AUDIT FIX: V2-DROP-02: DEPRECATED — kept ONLY for storage-layout / ABI
    ///         backward compatibility with existing clones and external indexers. The
    ///         `mint()` increment was removed; `refund()` and `rescueAfterCancellation()`
    ///         continue to read the slot but it is permanently zero on any new clone (see
    ///         the rescue-path NatSpec for why the rescue path is now only meaningful for
    ///         raw ETH donations to a pre-mint cancelled drop). DO NOT add a new write
    ///         path here — all reasoning relies on this slot being zero.
    // SLITHER 2026-05-18: intentional default-zero storage slot — see in-file NatSpec
    // slither-disable-next-line uninitialized-state
    uint256 public unclaimedRefundPool;

    /// @notice AUDIT FIX: DEEP-DROP-06: one-shot flag set by `freezeBaseURI()`. Once set,
    ///         `setBaseURI` reverts permanently — the placeholder is committed and cannot
    ///         be soft-rugged by a swap to a different image post-mint.
    bool public baseURIFrozen;

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
        // R062: optional Chainlink L2 Sequencer Uptime feed. address(0) is a
        // no-op (mainnet / non-L2). Set once at clone init, never mutated.
        address sequencerFeed;
    }

    // ─── AUDIT R062: L2 Sequencer Uptime gating ──────────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet / non-L2 (no-op). Read by `_dutchAuctionPrice` only —
    ///         a stale post-outage decay quote is the attack surface here.
    /// @dev    Cannot be `immutable` — this contract is deployed as a clone
    ///         via OZ `Clones.clone()` and clones cannot inherit immutable
    ///         values from the implementation. Single-write in `initialize()`
    ///         and never touched again gives the same security posture.
    address public sequencerFeed;
    /// @notice Post-resume grace window. After the sequencer transitions back
    ///         to "up", `currentPrice()` still reverts during the dutch-auction
    ///         phase for SEQUENCER_GRACE_PERIOD seconds so a buyer who waited
    ///         out an outage cannot benefit from a decayed post-outage price
    ///         on a mint they could not have submitted during the outage.
    /// @dev    AUDIT FIX FRESH-2026: DROP-SEQ-GRACE-OUTAGE-LENGTH [MEDIUM] —
    ///         bumped 1h → 4h. The 1h window was shorter than realistic L2
    ///         sequencer outages (Arbitrum 2024 outage was ~80 min, Base
    ///         outages have stretched to multiple hours). Snipers benefited
    ///         from an "outage discount" on dutch auctions because the
    ///         decay clock keeps ticking while honest buyers cannot submit
    ///         mints. 4h matches the post-resume freshness gate other
    ///         price-sensitive paths use (POL `TWAP_MAX_STALENESS`,
    ///         SwapFeeRouter L2 conversion path) and exceeds typical L2
    ///         outage durations. Pattern of record: Chainlink V3 feed staleness
    ///         conventions for L2-resident price consumers.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 4 hours;

    /// @notice AUDIT M8: cap platform fee at 10% to match LaunchpadV2.MAX_PROTOCOL_FEE_BPS.
    ///         The prior 100% cap allowed direct-clone deployments to siphon all creator share.
    uint16 public constant MAX_PLATFORM_FEE_BPS = 1000;
    /// @notice AUDIT NEW-L7 (LOW): cap ERC-2981 royalty at 10%. Prior code accepted up
    ///         to 100%, which is a marketplace-relations landmine: OpenSea/Blur/LooksRare
    ///         either refuse to list or clip at 2-7.5%, and users seeing a 100% royalty
    ///         signal would lose confidence in the collection. 10% matches the EIP-2981
    ///         norm across mature platforms.
    uint16 public constant MAX_ROYALTY_BPS = 1000;

    /// @notice AUDIT R023 / H-01: merkle-root rotations now traverse propose →
    ///         execute, with a 24h delay. Matches the Compound Timelock pattern
    ///         (see TimelockAdmin._proposeWithValue) so the queued root is bound
    ///         to the proposed VALUE — owner cannot silently swap the root
    ///         between propose and execute. 24h is enough lead time for an
    ///         in-flight allowlist claimer to observe a hostile rotation and
    ///         finalize before it lands.
    bytes32 public constant MERKLE_ROOT_CHANGE = keccak256("DROP_MERKLE_ROOT_CHANGE_VB");
    uint256 public constant MERKLE_ROOT_DELAY = 24 hours;

    /// @notice AUDIT FIX: V2-DROP-01: 24h propose/execute timelock for `setMintPrice`,
    ///         closing the `setMintPhase(CLOSED) → setMintPrice → setMintPhase(PUBLIC)`
    ///         round-trip bypass that re-opened the original DEEP-DROP-02 attack via an
    ///         MEV bundle. Pending buyers observe `MintPriceProposed(newPrice, executeAfter)`
    ///         and have a full day to drop their unconfirmed mint txs before the new price
    ///         lands. Same shape as MERKLE_ROOT_CHANGE.
    bytes32 public constant MINT_PRICE_CHANGE = keccak256("DROP_MINT_PRICE_CHANGE_V2");
    uint256 public constant MINT_PRICE_DELAY = 24 hours;
    /// @notice AUDIT FIX: V2-DROP-01: pending mint price for the timelocked rotation flow.
    uint256 public pendingMintPrice;

    /// @notice AUDIT FIX: V2-DROP-03: 24h propose/execute timelock for `configureDutchAuction`,
    ///         closing the same round-trip bypass on the dutch-curve setter that previously
    ///         re-opened DEEP-DROP-01.
    bytes32 public constant DUTCH_CONFIG_CHANGE = keccak256("DROP_DUTCH_CONFIG_CHANGE_V2");
    uint256 public constant DUTCH_CONFIG_DELAY = 24 hours;
    /// @notice AUDIT FIX: V2-DROP-03: pending dutch-auction config for the timelocked
    ///         rotation flow. Stored as a packed struct to keep the propose/execute pair
    ///         atomic; storage is cleared inside `executeDutchAuction` / `cancelDutchAuction`.
    struct PendingDutchConfig {
        uint256 startPrice;
        uint256 endPrice;
        uint256 startTime;
        uint256 duration;
    }
    PendingDutchConfig public pendingDutchConfig;

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
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = p.sequencerFeed;

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
        // AUDIT FIX: V2-DROP-04: refuse to deploy directly into DUTCH_AUCTION with a
        // curve whose decay window has already fully elapsed at the deploy block. Prior
        // to this guard, a factory script that mis-computed `dutchStartTime` (e.g. used
        // a stale block.timestamp from a forked simulation) would silently launch the
        // drop at `dutchEndPrice` — creator only realises once mints come in at the floor.
        // Mirror pattern: Sudoswap LSSVMPair rejects expired auctions at entry.
        if (p.initialPhase == MintPhase.DUTCH_AUCTION && dutchConfigured) {
            if (p.dutchStartTime + p.dutchDuration <= block.timestamp) {
                revert DutchAuctionAlreadyEnded();
            }
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
    /// @dev AUDIT MICROSCOPE_2026_04_30 C1: `allowedAmount` is the per-claimer cap
    ///      baked into the Merkle leaf. The on-chain `allowlistClaimed[msg.sender]`
    ///      counter accumulates against `allowedAmount` and is INDEPENDENT of
    ///      `mintedPerWallet` — a `setMaxPerWallet` bump cannot retroactively reopen
    ///      a fully-consumed allowlist allocation. For PUBLIC / DUTCH phases the
    ///      `allowedAmount` parameter is ignored; pass 0 to make the calldata
    ///      explicit. Pattern of record: Manifold ERC721LazyPayableClaim leaf.
    function mint(uint256 quantity, uint256 allowedAmount, bytes32[] calldata proof)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (quantity == 0) revert ZeroQuantity();
        // AUDIT FIX (BATCH-H M8): hard per-tx mint cap. Pre-fix unbounded
        // `quantity` enabled self-DoS (caller passes maxSupply → tx OOGs)
        // and indexer/subgraph bloat from huge Transfer event bursts.
        // 50 matches MAX_POSITIONS_PER_HOLDER on TegridyStaking — same
        // operational ceiling rationale (fits in block gas, indexable).
        if (quantity > MAX_MINT_PER_TX) revert ExceedsMintBatchCap();
        if (mintPhase == MintPhase.CLOSED) revert MintClosed();
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        if (mintPhase == MintPhase.DUTCH_AUCTION && block.timestamp < dutchStartTime) {
            revert DutchAuctionNotActive();
        }
        if (totalSupply + quantity > maxSupply) revert ExceedsMaxSupply();
        if (maxPerWallet > 0 && mintedPerWallet[msg.sender] + quantity > maxPerWallet) {
            revert ExceedsWalletLimit();
        }

        // AUDIT FIX: DEEP-DROP-07: read the underlying typed-revert price at
        // mint-time so a sequencer outage produces a clean `SequencerDown` /
        // `SequencerGracePeriodNotOver` revert instead of routing through the
        // sentinel-wrapped public `currentPrice()` view. Indexers and UIs see
        // the sentinel; minters see the real revert and don't burn gas.
        uint256 price = mintPhase == MintPhase.DUTCH_AUCTION
            ? _dutchAuctionPrice()
            : mintPrice;
        uint256 totalCost = price * quantity;
        if (msg.value < totalCost) revert InsufficientPayment();

        if (mintPhase == MintPhase.ALLOWLIST) {
            // AUDIT MICROSCOPE_2026_04_30 C1: leaf NOW INCLUDES `allowedAmount`. Without
            // baking the per-claimer cap into the commitment, owner could `setMaxPerWallet`
            // any time and the same proof becomes good for `N` more mints. Off-chain tree
            // construction must apply:
            //   leaf = keccak256( bytes.concat( keccak256( abi.encode(drop, minter, amount) ) ) )
            // AUDIT NEW-L5 (preserved): double-hashed leaf per OZ MerkleTree to defeat the
            //   second-preimage attack. Both invariants compose.
            bytes32 leaf = keccak256(
                bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount)))
            );
            if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
            // AUDIT MICROSCOPE_2026_04_30 C1: enforce per-claimer cap against the leaf-bound
            // amount. Independent of `mintedPerWallet` so a future `setMaxPerWallet` bump
            // cannot reopen the allocation.
            if (allowlistClaimed[msg.sender] + quantity > allowedAmount) {
                revert AllowlistAllocationExceeded();
            }
            allowlistClaimed[msg.sender] += quantity;
        }

        // AUDIT R023 / M-02: Checks-Effects-Interactions ordering.
        // Update drop accounting (totalSupply, mintedPerWallet, paidPerWallet)
        // BEFORE calling `_safeMint`, which fires `onERC721Received` on contract
        // recipients. nonReentrant blocks self-reentry on `mint()`, but external
        // contracts the receiver hook can call into (or oracles / view-callers
        // hit during the hook) previously observed inconsistent drop state —
        // counters reflected pre-mint values while ownerOf() already reflected
        // the new tokens. Update counters first so the hook sees a coherent
        // post-mint snapshot.
        uint256 startId = totalSupply + 1;
        totalSupply += quantity;
        mintedPerWallet[msg.sender] += quantity;
        paidPerWallet[msg.sender] += totalCost;
        // AUDIT FIX M-7: track aggregate sale revenue (used by `withdraw()`).
        totalProceeds += totalCost;
        // AUDIT FIX: V2-DROP-02: removed the `unclaimedRefundPool += totalCost`
        // accumulator-write previously emitted here under DEEP-DROP-04. Post-DEEP-DROP-05
        // (cancel gated to `totalSupply == 0`), the entire DEEP-DROP-04 accounting path
        // is structurally unreachable: cancellation can only happen pre-mint, so neither
        // `refund()` (read pool slot) nor `rescueAfterCancellation()` (compares balance
        // against pool slot) ever sees a non-zero value here. Eliminating the SSTORE-warm
        // write saves ~2.9k gas per mint without weakening any safety property; the
        // slot is preserved for ABI compatibility (see `unclaimedRefundPool` declaration).

        for (uint256 i; i < quantity; ++i) {
            _safeMint(msg.sender, startId + i);
        }

        if (msg.value > totalCost) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, msg.value - totalCost);
        }

        emit Minted(msg.sender, startId, quantity, totalCost);
    }

    /// @notice AUDIT FIX: DEEP-DROP-07: indexer-safe price view. During an L2 sequencer
    ///         outage (or its grace window), the dutch-phase quote returns the SENTINEL
    ///         `type(uint256).max` instead of reverting so off-chain consumers (subgraphs,
    ///         mint-page UIs) see a consistent "paused" signal. CLOSED / ALLOWLIST /
    ///         PUBLIC reads always resolve cleanly. Mint-time enforcement is unchanged:
    ///         `mint()` calls `_dutchAuctionPrice()` directly which carries the reverting
    ///         `SequencerCheck.checkSequencerUp` — funds never move while the sentinel is live.
    /// @dev    AUDIT FIX: V2-DROP-05: refactored to use `SequencerCheck.tryCheckSequencerUp`
    ///         directly instead of wrapping `this.dutchAuctionPriceExternal()` in a
    ///         try/catch. The previous self-call paid ~2,400 gas per view call for the
    ///         STATICCALL (paid by every indexer / front-end poll across the dutch lifetime)
    ///         and added an exotic-pattern attack surface that future contributors might
    ///         unknowingly weaken. The lib already exposes the canonical non-reverting
    ///         primitive (`tryCheckSequencerUp`); this aligns with the SequencerCheck.sol
    ///         "single source of truth" guidance.
    /// @return The current price, OR `type(uint256).max` as a sentinel during a
    ///         dutch-auction sequencer outage. Consumers should treat the sentinel
    ///         as "minting paused — do not display a buy button."
    function currentPrice() public view returns (uint256) {
        if (mintPhase == MintPhase.DUTCH_AUCTION) {
            // AUDIT FIX: V2-DROP-05: canonical non-reverting sequencer probe.
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            (bool ok, ) = SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
            if (!ok) return type(uint256).max;
            return _dutchAuctionPriceWithoutSequencerCheck();
        }
        return mintPrice;
    }

    /// @notice AUDIT FIX: DEEP-DROP-07 (compat): external view used by older off-chain
    ///         tooling to fetch the underlying dutch quote with the reverting sequencer
    ///         gate. Kept stable for clones / indexers built against the original ABI.
    /// @dev    AUDIT FIX: V2-DROP-05: still routes through `_dutchAuctionPrice()` so the
    ///         SequencerDown / SequencerGracePeriodNotOver typed reverts remain available
    ///         to consumers that explicitly want the revert behaviour.
    function dutchAuctionPriceExternal() external view returns (uint256) {
        return _dutchAuctionPrice();
    }

    function _dutchAuctionPrice() internal view returns (uint256) {
        // R062 (HIGH): refuse to quote a dutch-auction price when the L2
        // sequencer is currently down or has just resumed within
        // SEQUENCER_GRACE_PERIOD. The price decay clock keeps ticking while
        // the chain is offline — without this gate, a buyer who waited out a
        // sequencer outage gets the post-outage decayed price applied to a
        // mint they could not have submitted during the outage. address(0)
        // sequencerFeed is a no-op (mainnet / non-L2 deployments).
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
        return _dutchAuctionPriceWithoutSequencerCheck();
    }

    /// @notice AUDIT FIX: V2-DROP-05: dutch curve math with NO sequencer gate. Internal-
    ///         use only — callers MUST gate on either `checkSequencerUp` (revert path,
    ///         used by `mint()`) or `tryCheckSequencerUp` (sentinel path, used by
    ///         `currentPrice()`). Splitting the math out lets `currentPrice()` skip the
    ///         self-call STATICCALL while keeping the mint-time enforcement strict.
    function _dutchAuctionPriceWithoutSequencerCheck() internal view returns (uint256) {
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
        // AUDIT R014 H-8: while a merkle-root rotation is queued, freeze phase
        // changes. Otherwise the owner could:
        //   1. propose root rotation while CLOSED (allowed by _canRotateMerkleRoot)
        //   2. setMintPhase(ALLOWLIST) — start active mint with old root
        //   3. wait until 24h elapses and execute the rotation mid-mint
        // ...exposing exactly the in-flight-claimer exclusion the timelock was
        // meant to prevent. Owner must `cancelMerkleRoot` first to unfreeze.
        if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
        // AUDIT FIX: V2-DROP-01 / V2-DROP-03: same booby-trap rule for the new
        // mint-price and dutch-config timelocks. If a price hike or dutch-curve reset
        // is pending, the phase MUST stay in CLOSED until the proposal is either
        // executed or cancelled — otherwise the owner would re-create the round-trip
        // bypass by opening to PUBLIC / DUTCH while a hostile change is sitting in the
        // queue ready to fire. Owner must `cancelMintPrice` / `cancelDutchAuction` to
        // unfreeze before re-opening. Reuses MerkleRotationPending error type to keep
        // the typed-revert surface narrow (the semantic is identical: "a queued admin
        // change is about to fire — cancel it first").
        if (_executeAfter[MINT_PRICE_CHANGE]   != 0) revert MerkleRotationPending();
        if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) revert MerkleRotationPending();
        if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
            revert DutchAuctionNotActive();
        }
        // AUDIT FIX: DEEP-DROP-03: mirror the initialize-time guard so an owner cannot
        // flip into ALLOWLIST with a zero merkleRoot — every claim would silently
        // fail on `MerkleProof.verify(_, bytes32(0), leaf)`, bricking the drop until
        // a propose/execute root rotation lands.
        if (phase == MintPhase.ALLOWLIST && merkleRoot == bytes32(0)) revert InvalidProof();
        // AUDIT FIX (2026-06-02 pre-deploy, MEDIUM): extend the H19 "toggle-to-free"
        // invariant to the phase machine, not just the setMintPrice path. A DUTCH_AUCTION
        // drop legitimately runs with storage mintPrice == 0 (price comes from the curve),
        // so flipping to PUBLIC after paid mints would set price 0 -> free mints, rugging
        // the dutch bidders. Block opening a zero-price PUBLIC phase once any token has
        // been minted; genesis free drops (totalSupply == 0) are still allowed. Mirrors
        // the executeMintPrice/proposeMintPrice guards (lines 787/806).
        // AUDIT FIX (2026-06-05, MEDIUM): extend the H19 invariant to ALLOWLIST too.
        // ALLOWLIST prices off the SAME storage `mintPrice` as PUBLIC (see mint(), the
        // `mintPhase == DUTCH_AUCTION ? _dutchAuctionPrice() : mintPrice` branch). A
        // DUTCH drop legitimately runs with storage mintPrice == 0, so a DUTCH -> ALLOWLIST
        // flip after paid mints re-opened the exact "toggle-to-free" rug the PUBLIC guard
        // closes (a captured owner sets an attacker-controlled merkleRoot, then mints the
        // remaining supply for free, rugging the dutch bidders). DUTCH stays excluded — its
        // price comes from the curve, and a zero floor there is a legitimate auction outcome.
        if (
            (phase == MintPhase.PUBLIC || phase == MintPhase.ALLOWLIST)
                && mintPrice == 0 && totalSupply > 0
        ) revert ZeroPricePostMint();
        mintPhase = phase;
        emit MintPhaseChanged(phase);
    }

    /// @notice DEPRECATED — direct one-step root rotation removed.
    ///         AUDIT R023 H-01 (HIGH): legacy setMerkleRoot let a compromised
    ///         owner rotate the root atomically mid-claim, excluding pending
    ///         allowlist claimers or rotating-minting for supply siphon.
    ///         Use proposeMerkleRoot / executeMerkleRoot (24h timelock) instead.
    function setMerkleRoot(bytes32) external pure {
        revert("Use proposeMerkleRoot()");
    }

    /// @notice Pending root for the timelocked rotation flow.
    bytes32 public pendingMerkleRoot;

    /// @dev R023: rotation is permitted only while the sale is closed,
    ///      cancelled, or paused. Active phases (ALLOWLIST/PUBLIC/DUTCH_AUCTION)
    ///      reject rotation so in-flight claimers can't be excluded mid-mint.
    function _canRotateMerkleRoot() internal view returns (bool) {
        return mintPhase == MintPhase.CLOSED
            || mintPhase == MintPhase.CANCELLED
            || paused();
    }

    /// @notice AUDIT R023 H-01: propose a merkle root rotation. The proposal
    ///         can execute after MERKLE_ROOT_DELAY (24h). Phase is rechecked
    ///         at execute time so a close→reopen window during the delay
    ///         cannot smuggle a hostile rotation into an active mint phase.
    function proposeMerkleRoot(bytes32 newRoot) external onlyOwner {
        if (!_canRotateMerkleRoot()) revert RootRotationBlocked();
        pendingMerkleRoot = newRoot;
        _propose(MERKLE_ROOT_CHANGE, MERKLE_ROOT_DELAY);
        emit MerkleRootProposed(newRoot, _executeAfter[MERKLE_ROOT_CHANGE]);
    }

    /// @notice AUDIT R023 H-01: execute a previously proposed root rotation.
    ///         Caller must pass the expected value to bind the execution to
    ///         a specific proposal — even though _propose stored the value,
    ///         this guards against a re-propose-with-different-root race
    ///         attempted within the same block as execute.
    /// @dev AUDIT FIX V3-DROP-03: gated by `whenNotPaused` so a queued merkle
    ///      root change can't fire mid-pause (sibling-miss vs. LaunchpadV2's
    ///      DEEP-LP-02 on its execute paths).
    /// @dev AUDIT FIX V3-DROP-02: `expectedExecuteAfter` value-bind so the
    ///      multisig signer's approval is bound to a specific proposal ETA
    ///      (sibling-miss vs. LaunchpadV2's V2-LP-01).
    /// @dev AUDIT FIX V3-DROP-04: reject `bytes32(0)` execute when phase is
    ///      ALLOWLIST — silently bricks the drop on unpause; mirror the
    ///      DEEP-DROP-03 setMintPhase guard.
    function executeMerkleRoot(bytes32 expectedRoot, uint256 expectedExecuteAfter) external onlyOwner whenNotPaused {
        require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH");
        if (_executeAfter[MERKLE_ROOT_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        if (expectedRoot == bytes32(0) && mintPhase == MintPhase.ALLOWLIST) revert InvalidProof();
        if (!_canRotateMerkleRoot()) revert RootRotationBlocked();
        _execute(MERKLE_ROOT_CHANGE);
        bytes32 oldRoot = merkleRoot;
        merkleRoot = expectedRoot;
        pendingMerkleRoot = bytes32(0);
        emit MerkleRootRotated(oldRoot, expectedRoot);
    }

    /// @notice AUDIT R023 H-01: cancel a pending root rotation.
    function cancelMerkleRoot() external onlyOwner {
        bytes32 cancelled = pendingMerkleRoot;
        _cancel(MERKLE_ROOT_CHANGE);
        pendingMerkleRoot = bytes32(0);
        emit MerkleRootCancelled(cancelled);
    }

    /// @notice DEPRECATED — direct one-step price change removed.
    ///         AUDIT FIX: V2-DROP-01: the original DEEP-DROP-02 phase-gate was bypassable
    ///         via `setMintPhase(CLOSED) → setMintPrice → setMintPhase(PUBLIC)` round-trip
    ///         delivered as an atomic MEV bundle. Use `proposeMintPrice` / `executeMintPrice`
    ///         (24h timelock) so pending buyers observe the queued change and can drop
    ///         their unconfirmed txs.
    function setMintPrice(uint256) external pure {
        revert UseProposeMintPrice();
    }

    /// @notice AUDIT FIX: V2-DROP-01: propose a new mint price. Executes after
    ///         MINT_PRICE_DELAY (24h). Pre-mint zero-price toggle is preserved by
    ///         the H19 invariant — `executeMintPrice` re-checks `price == 0 && totalSupply > 0`.
    ///         Pattern of record: Compound Timelock; same shape as `proposeMerkleRoot`.
    function proposeMintPrice(uint256 newPrice) external onlyOwner {
        if (mintPhase != MintPhase.CLOSED) revert PriceChangePhaseLocked();
        if (newPrice == 0 && totalSupply > 0) revert ZeroPricePostMint();
        pendingMintPrice = newPrice;
        _propose(MINT_PRICE_CHANGE, MINT_PRICE_DELAY);
        emit MintPriceProposed(newPrice, _executeAfter[MINT_PRICE_CHANGE]);
    }

    /// @notice AUDIT FIX: V2-DROP-01: execute a previously proposed mint price after the
    ///         24h delay. Caller passes the expected value to bind execution to a specific
    ///         proposal — mirrors `executeMerkleRoot(bytes32 expectedRoot)`.
    /// @param  expectedPrice Mint price the caller expects to land. Must equal
    ///                       `pendingMintPrice` or revert with `MintPriceMismatch`.
    /// @dev AUDIT FIX V3-DROP-02: `expectedExecuteAfter` value-bind.
    /// @dev AUDIT FIX V3-DROP-03: `whenNotPaused`.
    function executeMintPrice(uint256 expectedPrice, uint256 expectedExecuteAfter) external onlyOwner whenNotPaused {
        if (pendingMintPrice != expectedPrice) revert MintPriceMismatch();
        if (_executeAfter[MINT_PRICE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        // Re-check the H19 invariant at execute-time too: if a mint happened during the
        // 24h delay (impossible today since we require CLOSED at propose, but defensive
        // for future relaxations), zero-price is still rejected.
        if (expectedPrice == 0 && totalSupply > 0) revert ZeroPricePostMint();
        _execute(MINT_PRICE_CHANGE);
        mintPrice = expectedPrice;
        pendingMintPrice = 0;
        emit MintPriceChanged(expectedPrice);
    }

    /// @notice AUDIT FIX: V2-DROP-01: cancel a pending mint-price proposal.
    function cancelMintPrice() external onlyOwner {
        uint256 cancelled = pendingMintPrice;
        _cancel(MINT_PRICE_CHANGE);
        pendingMintPrice = 0;
        emit MintPriceCancelled(cancelled);
    }

    /// @dev AUDIT MICROSCOPE_2026_04_30 C1 (companion fix): `setMaxPerWallet` can no
    ///      longer reopen a consumed allowlist because each leaf now binds its own
    ///      `allowedAmount` (see `mint()`). We additionally gate this setter to the
    ///      CLOSED phase so the cap cannot be bumped mid-mint to drain supply via
    ///      the `mintedPerWallet` codepath. Pattern: Zora ERC721Drop sales-config struct.
    function setMaxPerWallet(uint256 max) external onlyOwner {
        if (mintPhase != MintPhase.CLOSED) revert MintClosed();
        maxPerWallet = max;
        emit MaxPerWalletChanged(max);
    }

    /// @dev AUDIT FIX: DEEP-DROP-06: setBaseURI is now gated against the post-reveal
    ///      window AND the one-shot `freezeBaseURI()` commitment. Once `revealed == true`
    ///      the placeholder slot is vestigial — mutating it is purely abuse surface.
    ///      Pattern of record: Sound Protocol `freezeMetadata`; Manifold `freezeBase`.
    function setBaseURI(string calldata uri) external onlyOwner {
        if (baseURIFrozen) revert BaseURIFrozen();
        if (revealed) revert AlreadyRevealed();
        _baseTokenURI = uri;
        emit BaseURIChanged(uri);
    }

    /// @notice AUDIT FIX: DEEP-DROP-06: one-shot commitment that freezes the placeholder
    ///         URI immutably. Idempotent at storage level (re-call simply re-emits the
    ///         event); the underlying flag is monotonic. Use this to publish placeholder
    ///         art that creators promise will not be soft-rugged into a generic JPEG
    ///         after FOMO drives a secondary floor on the high-value art.
    /// @dev    AUDIT FIX: V2-DROP-06: refuse to fire on an empty `_baseTokenURI`.
    ///         Without this guard, an owner who fat-fingers `freezeBaseURI()` BEFORE
    ///         `setBaseURI(realPlaceholder)` permanently commits the drop to an empty
    ///         placeholder — pre-reveal `tokenURI(id)` would return "" forever, and there
    ///         is no governance recovery path (the freeze flag is monotonic). Pattern of
    ///         record: Sound Protocol `freezeMetadata` requires non-empty URI; Manifold
    ///         `freezeBase` ditto.
    function freezeBaseURI() external onlyOwner {
        if (bytes(_baseTokenURI).length == 0) revert BaseURIEmpty();
        baseURIFrozen = true;
        emit BaseURIFrozenEvent();
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
        // AUDIT FIX 2026-05-16 LOW: reject empty reveal URI. Pre-fix, `reveal("")`
        // would permanently set `_revealURI = ""` (revealed flag is monotonic);
        // every subsequent `tokenURI(id)` then returned "" since the ternary at
        // line 463-468 short-circuits to "" when bytes(_revealURI).length == 0.
        // Marketplaces and previews showed broken/missing metadata with no recovery.
        // Mirror the asymmetric `freezeBaseURI` guard (`BaseURIEmpty` at line ~841)
        // so both immutable-URI paths reject empty input.
        if (bytes(revealURI).length == 0) revert RevealURIEmpty();
        revealed = true;
        _revealURI = revealURI;
        emit Revealed(revealURI);
    }

    /// @notice DEPRECATED — direct one-step dutch curve change removed.
    ///         AUDIT FIX: V2-DROP-03: the original DEEP-DROP-01 phase-gate was bypassable
    ///         via `setMintPhase(CLOSED) → configureDutchAuction(...) → setMintPhase(DUTCH_AUCTION)`
    ///         delivered as an atomic MEV bundle. Use `proposeDutchAuction` /
    ///         `executeDutchAuction` (24h timelock) so pending bidders observe the queued
    ///         curve change and can drop their unconfirmed txs.
    function configureDutchAuction(uint256, uint256, uint256, uint256) external pure {
        revert UseProposeDutchAuction();
    }

    /// @notice AUDIT FIX: V2-DROP-03: propose a new dutch auction curve. Executes after
    ///         DUTCH_CONFIG_DELAY (24h). Same per-field validation as the legacy setter;
    ///         `executeDutchAuction` re-validates at execute time so a mid-delay state
    ///         change cannot smuggle an invalid curve.
    function proposeDutchAuction(
        uint256 startPrice,
        uint256 endPrice,
        uint256 startTime,
        uint256 duration
    ) external onlyOwner {
        if (mintPhase != MintPhase.CLOSED) revert DutchConfigPhaseLocked();
        if (startPrice <= endPrice) revert InvalidDutchAuctionConfig();
        if (duration == 0) revert InvalidDutchAuctionConfig();
        if (startTime == 0) revert InvalidDutchAuctionConfig();
        if (startPrice - endPrice < duration) revert InvalidDutchAuctionConfig();

        pendingDutchConfig = PendingDutchConfig({
            startPrice: startPrice,
            endPrice: endPrice,
            startTime: startTime,
            duration: duration
        });
        _propose(DUTCH_CONFIG_CHANGE, DUTCH_CONFIG_DELAY);
        emit DutchAuctionProposed(startPrice, endPrice, startTime, duration, _executeAfter[DUTCH_CONFIG_CHANGE]);
    }

    /// @notice AUDIT FIX: V2-DROP-03: execute a previously proposed dutch curve after the
    ///         24h delay. Caller passes the full expected curve to bind execution to a
    ///         specific proposal — mirrors `executeMerkleRoot(bytes32)`.
    /// @dev AUDIT FIX V3-DROP-02: `expectedExecuteAfter` value-bind.
    /// @dev AUDIT FIX V3-DROP-03: `whenNotPaused`.
    /// @dev AUDIT FIX V3-DROP-01: also re-check that the curve has not already
    ///      ended at execute-time (mirror initialize's V2-DROP-04 guard).
    function executeDutchAuction(
        uint256 expectedStartPrice,
        uint256 expectedEndPrice,
        uint256 expectedStartTime,
        uint256 expectedDuration,
        uint256 expectedExecuteAfter
    ) external onlyOwner whenNotPaused {
        PendingDutchConfig memory cached = pendingDutchConfig;
        if (cached.startPrice != expectedStartPrice ||
            cached.endPrice   != expectedEndPrice   ||
            cached.startTime  != expectedStartTime  ||
            cached.duration   != expectedDuration) {
            revert DutchConfigMismatch();
        }
        if (_executeAfter[DUTCH_CONFIG_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
        // AUDIT FIX V3-DROP-01: prevent execute of an already-elapsed curve.
        if (expectedStartTime + expectedDuration <= block.timestamp) revert InvalidDutchAuctionConfig();
        _execute(DUTCH_CONFIG_CHANGE);
        dutchStartPrice = expectedStartPrice;
        dutchEndPrice   = expectedEndPrice;
        dutchStartTime  = expectedStartTime;
        dutchDuration   = expectedDuration;
        delete pendingDutchConfig;
        emit DutchAuctionConfigured(expectedStartPrice, expectedEndPrice, expectedStartTime, expectedDuration);
    }

    /// @notice AUDIT FIX: V2-DROP-03: cancel a pending dutch curve proposal.
    function cancelDutchAuction() external onlyOwner {
        PendingDutchConfig memory cached = pendingDutchConfig;
        _cancel(DUTCH_CONFIG_CHANGE);
        delete pendingDutchConfig;
        emit DutchAuctionCancelled(cached.startPrice, cached.endPrice, cached.startTime, cached.duration);
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

        // AUDIT FIX M-7: distribute only legitimate sale revenue (totalProceeds),
        // capped to the actual balance for safety. Any donated ETH (from
        // selfdestruct / coinbase set on which receive() doesn't fire) is left
        // in the contract — pre-fix it was drained alongside sale revenue and
        // the platformFeeBps applied on top, letting a donor front-run the
        // owner's withdraw to inflate the platform's take. The leftover
        // donation can be recovered via the existing rescueAfterCancellation
        // path (in the cancellation arm) or via the OZ Ownable owner's manual
        // tools — both prefer this stuck-ETH-no-rug posture.
        uint256 bal = address(this).balance;
        uint256 distributable = totalProceeds < bal ? totalProceeds : bal;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (distributable == 0) revert WithdrawFailed();

        // AUDIT H9: lock out cancelSale() going forward.
        withdrawn = true;
        totalProceeds = 0;

        uint256 platformAmount = (distributable * platformFeeBps) / 10000;
        uint256 creatorAmount = distributable - platformAmount;

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
    /// @dev AUDIT MICROSCOPE_2026_04_30 H18: cancellation is blocked once the
    ///      collection has sold out. Pattern: Zora `ERC721Drop` and Manifold both
    ///      freeze cancel after the sale completes (sold-out OR end-time). Without
    ///      this check the owner could rug secondary-market buyers by force-refunding
    ///      everyone post-sellout while the NFTs continue to circulate.
    /// @dev AUDIT FIX: DEEP-DROP-05: cancelSale is now gated to `totalSupply == 0`.
    ///      Once any mint has occurred, NFTs may have moved to secondary buyers via
    ///      transfer / marketplace sales. The original primary minter still holds the
    ///      `paidPerWallet` refund right while the secondary buyer holds the token —
    ///      cancelling at that point lets the original minter refund 1x while having
    ///      already collected secondary-flip proceeds, leaving secondary buyers with
    ///      an orphaned NFT and no recourse. Forcing cancellation pre-mint preserves
    ///      the social contract: once anyone has paid, the only path to drop death
    ///      is sellout-completion (via supply cap) or the rescue window long after
    ///      the project lifecycle. Pattern: Manifold disables cancellation entirely
    ///      once any token is minted.
    function cancelSale() external onlyOwner {
        if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
        if (withdrawn) revert WithdrawFailed();
        if (totalSupply > 0) revert CancelAfterFirstMint();
        mintPhase = MintPhase.CANCELLED;
        cancelledAt = block.timestamp; // AUDIT MICROSCOPE_2026_04_30 H20
        emit MintPhaseChanged(MintPhase.CANCELLED);
        emit SaleCancelledEvent(totalSupply, address(this).balance);
    }

    /// @notice Refund a minter their `paidPerWallet[msg.sender]` post-cancellation.
    /// @dev    AUDIT FIX: V2-DROP-02: STRUCTURALLY UNREACHABLE under current rules.
    ///         `cancelSale()` requires `totalSupply == 0`, so by the time `mintPhase ==
    ///         CANCELLED` no minter can have a non-zero `paidPerWallet[]` entry — every
    ///         caller hits `NothingToRefund`. The function is preserved for ABI / clone
    ///         compatibility AND to remain well-formed if a future reversal of DEEP-DROP-05
    ///         re-enables post-mint cancellation. The `unclaimedRefundPool -= owed` line
    ///         remains a no-op subtract-zero on any new clone (see V2-DROP-02 NatSpec on
    ///         the storage slot).
    function refund() external nonReentrant {
        if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
        // AUDIT FIX M-7: keep totalProceeds in sync on refund.
        uint256 owed = paidPerWallet[msg.sender];
        if (owed > 0 && totalProceeds >= owed) {
            totalProceeds -= owed;
        }
        if (owed == 0) revert NothingToRefund();
        paidPerWallet[msg.sender] = 0;
        // AUDIT FIX V3-DROP-06: removed the dead `unclaimedRefundPool -= owed`
        // decrement. Post-V2-DROP-02 the pool is never incremented, so the
        // subtract was a no-op AT BEST and a footgun (would underflow if a
        // future PR partially restored the increment without symmetric
        // updates). The storage slot is preserved for ABI compat.
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed);
        emit Refunded(msg.sender, owed);
    }

    /// @notice AUDIT MICROSCOPE_2026_04_30 H20: after a cancelSale, residual ETH belonging
    ///         to minters who never called `refund()` (lost keys, contract recipient with
    ///         broken receive even after the WETH fallback, or simply abandoned drops)
    ///         used to be permanently locked. After `POST_CANCEL_RESCUE_DELAY` (1 year)
    ///         from `cancelledAt`, the creator may sweep what remains.
    /// @dev    Patterns of record: 0xSplits `recover()` after lockout, Sound Protocol
    ///         "rescue stuck funds" gated to >365 days post sale-end.
    /// @dev AUDIT FIX: DEEP-DROP-04: the rescue can ONLY claim the residual delta
    ///      between the contract's balance and the still-outstanding refund pool.
    ///      Late refunders (year+1+ε) are guaranteed their owed amount because
    ///      `unclaimedRefundPool` reserves it. The rescue exists to recover dust
    ///      (donations, sweep-pad rounding from a buggy WETH wrapper, ETH a contract
    ///      mistakenly sent here, etc.) — not to clean out the refund obligation.
    /// @dev AUDIT FIX: V2-DROP-02: post-V2-DROP-02 the use case is now narrowed to
    ///      DUST ONLY — the only path that can produce balance > 0 in a CANCELLED drop
    ///      is a raw-ETH donation (since `cancelSale()` requires `totalSupply == 0` and
    ///      `unclaimedRefundPool` is no longer incremented at mint time). The rescue
    ///      exists exclusively to recover those donations after the 1-year window.
    function rescueAfterCancellation() external nonReentrant onlyOwner {
        if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
        if (cancelledAt == 0 || block.timestamp < cancelledAt + POST_CANCEL_RESCUE_DELAY) {
            revert RescueWindowActive();
        }
        uint256 balance = address(this).balance;
        // AUDIT FIX: DEEP-DROP-04: defensive — pool can never legitimately exceed
        // balance, but if it does (donations less than minted refunds), revert
        // rather than underflow-revert downstream so the typed error is surfaced.
        if (balance <= unclaimedRefundPool) revert NothingToRescue();
        uint256 amount = balance - unclaimedRefundPool;
        // The recipient is the creator (deploy-time-fixed), routed through the
        // WETH fallback so a contract creator with a heavy receive() doesn't brick
        // the rescue. Platform fee is NOT taken on residuals — these are unclaimed
        // refund dust, not a fresh withdraw.
        WETHFallbackLib.safeTransferETHOrWrap(weth, creator, amount);
        emit PostCancellationRescued(creator, amount);
    }

    // ─── Owner Management (2-step) ───────────────────────────────────
    /// @notice AUDIT FIX 2026-05-17 LOW: pending-transfer expiry window. Mirrors
    ///         OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY = 14 days (Compound
    ///         Timelock GRACE_PERIOD). DropV2 cannot inherit OwnableNoRenounce
    ///         directly because it is deployed via Clones.cloneDeterministic
    ///         (constructor-only init is incompatible with the EIP-1167 minimal-
    ///         proxy clone pattern). The expiry + cancel surface is added inline.
    uint256 public constant OWNERSHIP_TRANSFER_EXPIRY = 14 days;
    /// @notice AUDIT FIX 2026-05-17 LOW: wall-clock at which the current pending
    ///         ownership transfer expires. Zero when no pending transfer exists.
    uint256 public ownershipTransferExpiresAt;

    /// @notice AUDIT FIX 2026-05-17 LOW: typed errors replacing the string
    ///         "RENOUNCE_DISABLED" + the audit-finding gaps (expiry/cancel).
    ///         Aligns DropV2 with the cluster-wide typed-error convention used
    ///         by OwnableNoRenounce (RenounceDisabled / OwnershipTransferExpired /
    ///         NoPendingOwnershipTransfer).
    error RenounceDisabled();
    error OwnershipTransferExpired();
    error NoPendingOwnershipTransfer();

    /// @notice AUDIT FIX 2026-05-17 LOW: emitted when the owner cancels a
    ///         pending ownership transfer before acceptance.
    event OwnershipTransferCancelled(address indexed previousPendingOwner, string reason);

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        // AUDIT FIX 2026-05-17 LOW: stamp a 14-day expiry on the pending slot
        // so a malicious / misconfigured pendingOwner cannot freeze the
        // rotation surface indefinitely. After expiry the owner can either
        // call `cancelOwnershipTransfer` or `transferOwnership` to a fresh
        // recipient with a new 14-day window.
        ownershipTransferExpiresAt = block.timestamp + OWNERSHIP_TRANSFER_EXPIRY;
    }

    function acceptOwnership() external {
        // AUDIT FIX 2026-05-17 LOW: expiry check FIRST so the typed
        // OwnershipTransferExpired is more diagnostic than NotOwner for an
        // expired-but-still-set pending slot.
        uint256 expiry = ownershipTransferExpiresAt;
        if (expiry != 0 && block.timestamp > expiry) {
            revert OwnershipTransferExpired();
        }
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        ownershipTransferExpiresAt = 0; // AUDIT FIX 2026-05-17 LOW: clear expiry.
        // AUDIT MICROSCOPE_2026_04_30 M-D3: clear any in-flight timelocked merkle
        // root proposal at ownership-accept. The previous owner could otherwise
        // hand off ownership with a hostile root waiting in the queue, ready to
        // execute as soon as the 24h delay elapses — incoming owner inherits the
        // booby-trap. Pattern: OZ Governor cancels pending proposals on guardian
        // change; MakerDAO DSPause flushes plots when chief multisig changes.
        if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) {
            _cancel(MERKLE_ROOT_CHANGE);
            bytes32 cancelled = pendingMerkleRoot;
            pendingMerkleRoot = bytes32(0);
            emit MerkleRootCancelled(cancelled);
        }
        // AUDIT FIX: V2-DROP-01: same booby-trap pattern for the new mint-price
        // timelock — cancel any pending proposal at handoff so the incoming owner
        // doesn't inherit a queued price change.
        if (_executeAfter[MINT_PRICE_CHANGE] != 0) {
            uint256 cancelledPrice = pendingMintPrice;
            _cancel(MINT_PRICE_CHANGE);
            pendingMintPrice = 0;
            emit MintPriceCancelled(cancelledPrice);
        }
        // AUDIT FIX: V2-DROP-03: same for the dutch-config timelock.
        if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) {
            PendingDutchConfig memory cancelledDutch = pendingDutchConfig;
            _cancel(DUTCH_CONFIG_CHANGE);
            delete pendingDutchConfig;
            emit DutchAuctionCancelled(
                cancelledDutch.startPrice,
                cancelledDutch.endPrice,
                cancelledDutch.startTime,
                cancelledDutch.duration
            );
        }
    }

    /// @notice AUDIT FIX 2026-05-17 LOW: current owner can cancel a pending
    ///         ownership transfer before the pendingOwner accepts. Mirrors
    ///         OwnableNoRenounce.cancelOwnershipTransfer. Closes the bricked-
    ///         rotation primitive where a malicious / misconfigured pendingOwner
    ///         could freeze the rotation surface (the bespoke 2-step had no
    ///         native cancel path — relied on the owner re-calling
    ///         `transferOwnership` to a different recipient, which doesn't
    ///         instantly clear the prior pendingOwner's race window).
    function cancelOwnershipTransfer(string calldata reason) external onlyOwner {
        address prev = pendingOwner;
        if (prev == address(0)) revert NoPendingOwnershipTransfer();
        pendingOwner = address(0);
        ownershipTransferExpiresAt = 0;
        emit OwnershipTransferCancelled(prev, reason);
    }

    function renounceOwnership() external view onlyOwner {
        // AUDIT FIX 2026-05-17 LOW: typed error replaces the legacy string
        // revert. Aligns with OwnableNoRenounce.RenounceDisabled so off-chain
        // alerting can subscribe by 4-byte selector across the entire cluster.
        revert RenounceDisabled();
    }
}
