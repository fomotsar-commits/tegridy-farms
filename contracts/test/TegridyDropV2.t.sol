// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

// ─── TegridyDropV2 — click-deploy ERC-721 drop template ──────────────────────
//
// Coverage targets the mint / phase / refund / withdraw semantics NOT already
// covered by TegridyLaunchpadV2.t.sol (the Launchpad suite is factory-flow
// focused: createCollection → initialize → event-shape). This file directly
// deploys a Drop clone via `new TegridyDropV2()` + initialize and exercises:
//
//   1. Mint-phase gating: CLOSED / CANCELLED / ALLOWLIST (proof) / PUBLIC /
//      DUTCH_AUCTION (time gate).
//   2. maxSupply + maxPerWallet caps.
//   3. Payment handling: insufficient reverts, overpayment refunds the
//      difference to the minter.
//   4. Allowlist merkle verification with a leaf = keccak256(this, minter).
//   5. Dutch-auction price decay: linear interpolation between dutchStartPrice
//      and dutchEndPrice across dutchDuration seconds.
//   6. withdraw() split (creator vs. platform) with the 10000-bps formula.
//   7. cancelSale → refund flow: minter can reclaim what they paid; can't
//      claim twice; non-minters can't claim.
//   8. reveal() is one-shot + onlyOwner, and toggles tokenURI semantics.
//   9. 2-step ownership (transferOwnership + acceptOwnership), with renounce
//      disabled.
//
// Shared state between tests is set up in `_init()` — a reusable helper that
// assembles sensible defaults plus targeted overrides via `InitParams`.
// ─────────────────────────────────────────────────────────────────────────────

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

contract TegridyDropV2Test is Test {
    TegridyDropV2 drop;
    MockWETH weth;

    address creator = makeAddr("creator");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant MAX_SUPPLY = 100;
    uint256 constant MINT_PRICE = 0.05 ether;
    uint256 constant MAX_PER_WALLET = 5;
    uint16 constant PLATFORM_FEE_BPS = 500; // 5%
    uint16 constant ROYALTY_BPS = 500;      // 5%

    function setUp() public {
        weth = new MockWETH();
        // The implementation contract calls _disableInitializers() in its
        // constructor — it's only meant to be cloned. Mirror the factory's
        // approach: deploy an implementation once, then operate on a
        // Clones.clone() of it per test.
        address impl = address(new TegridyDropV2());
        drop = TegridyDropV2(payable(Clones.clone(impl)));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // Build a fresh InitParams with sensible defaults; callers override fields
    // that matter for their scenario. `initialPhase` defaults to PUBLIC so
    // bare _init() yields a ready-to-mint drop.
    function _defaults() internal view returns (TegridyDropV2.InitParams memory p) {
        p.name = "Test Drop";
        p.symbol = "TD";
        p.maxSupply = MAX_SUPPLY;
        p.mintPrice = MINT_PRICE;
        p.maxPerWallet = MAX_PER_WALLET;
        p.royaltyBps = ROYALTY_BPS;
        p.creator = creator;
        p.platformFeeRecipient = platform;
        p.platformFeeBps = PLATFORM_FEE_BPS;
        p.weth = address(weth);
        p.placeholderURI = "ipfs://placeholder";
        p.contractURI_ = "ipfs://collection";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.PUBLIC;
    }

    function _init(TegridyDropV2.InitParams memory p) internal {
        drop.initialize(p);
    }

    // ── Phase gating ───────────────────────────────────────────────────

    function test_mint_revertsWhenClosed() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        _init(p);

        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.MintClosed.selector);
        drop.mint{value: MINT_PRICE}(1, 0, proof);
    }

    function test_mint_revertsOnZeroQuantity() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.ZeroQuantity.selector);
        drop.mint{value: 0}(0, 0, proof);
    }

    function test_publicMint_happyPath() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, 0, proof);

        assertEq(drop.totalSupply(), 2);
        assertEq(drop.balanceOf(alice), 2);
        assertEq(drop.ownerOf(1), alice);
        assertEq(drop.ownerOf(2), alice);
    }

    // ── maxSupply + maxPerWallet ───────────────────────────────────────

    function test_mint_revertsOnExceedMaxSupply() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.maxSupply = 2;
        p.maxPerWallet = 10; // remove the wallet cap from the equation
        _init(p);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, 0, proof);

        vm.prank(bob);
        vm.expectRevert(TegridyDropV2.ExceedsMaxSupply.selector);
        drop.mint{value: MINT_PRICE}(1, 0, proof);
    }

    function test_mint_revertsOnExceedWalletLimit() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.ExceedsWalletLimit.selector);
        drop.mint{value: MINT_PRICE * 6}(6, 0, proof);
    }

    // ── Payment ────────────────────────────────────────────────────────

    function test_mint_revertsOnInsufficientPayment() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.InsufficientPayment.selector);
        drop.mint{value: MINT_PRICE - 1}(1, 0, proof);
    }

    function test_mint_refundsOverpayment() public {
        _init(_defaults());
        uint256 aliceBefore = alice.balance;
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE + 0.1 ether}(1, 0, proof);

        // Alice should be down by exactly MINT_PRICE (the 0.1 ether overpay
        // gets refunded via WETHFallbackLib to either ETH or WETH).
        uint256 nativeDown = aliceBefore - alice.balance;
        uint256 wethGained = weth.balanceOf(alice);
        assertEq(nativeDown - wethGained, MINT_PRICE, "net cost == mintPrice");
    }

    // ── Allowlist merkle ────────────────────────────────────────────────

    function test_allowlistMint_rejectsInvalidProof() public {
        bytes32 badRoot = keccak256("bogus");
        TegridyDropV2.InitParams memory p = _defaults();
        p.merkleRoot = badRoot;
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        _init(p);

        bytes32[] memory emptyProof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        drop.mint{value: MINT_PRICE}(1, 0, emptyProof);
    }

    function test_allowlistMint_acceptsValidProof() public {
        // AUDIT FIX: MICROSCOPE C1 — leaf NOW INCLUDES `allowedAmount`. The
        // tree construction must apply:
        //   leaf = keccak256( bytes.concat( keccak256( abi.encode(drop, minter, amount) ) ) )
        // (NEW-L5 double-hash preserved.)
        TegridyDropV2.InitParams memory p = _defaults();
        address dropAddr = address(drop);
        uint256 allowedAmount = 5;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(dropAddr, alice, allowedAmount)))
        );
        p.merkleRoot = leaf;
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        _init(p);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, allowedAmount, proof);
        assertEq(drop.balanceOf(alice), 1);
    }

    function test_allowlistMint_crossUserLeafRejected() public {
        // AUDIT FIX: MICROSCOPE C1 — leaf includes (drop, minter, amount).
        // alice's leaf as root — bob tries to mint with the same proof; the
        // double-hashed leaf doesn't match his address so verification fails.
        TegridyDropV2.InitParams memory p = _defaults();
        uint256 allowedAmount = 5;
        p.merkleRoot = keccak256(
            bytes.concat(keccak256(abi.encode(address(drop), alice, allowedAmount)))
        );
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        _init(p);

        bytes32[] memory proof;
        vm.prank(bob);
        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        drop.mint{value: MINT_PRICE}(1, allowedAmount, proof);
    }

    // ── Dutch auction ──────────────────────────────────────────────────

    function test_dutchAuction_priceDecaysLinearly() public {
        uint256 startPrice = 1 ether;
        uint256 endPrice = 0.1 ether;
        uint256 duration = 3600; // 1h — needs to be ≤ (start - end) per validation
        uint256 start = block.timestamp + 100;

        TegridyDropV2.InitParams memory p = _defaults();
        p.dutchStartPrice = startPrice;
        p.dutchEndPrice = endPrice;
        p.dutchDuration = duration;
        p.dutchStartTime = start;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        _init(p);

        // Before start: price pegs at startPrice.
        assertEq(drop.currentPrice(), startPrice);

        // Halfway through: price is midway between start and end.
        vm.warp(start + duration / 2);
        uint256 halfway = drop.currentPrice();
        uint256 expectedHalf = startPrice - (startPrice - endPrice) / 2;
        // Linear math, no rounding issues at halfway.
        assertEq(halfway, expectedHalf);

        // Past duration: price floors at endPrice.
        vm.warp(start + duration + 1);
        assertEq(drop.currentPrice(), endPrice);
    }

    function test_dutchAuction_revertsBeforeStart() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.dutchStartPrice = 1 ether;
        p.dutchEndPrice = 0.1 ether;
        p.dutchDuration = 3600;
        p.dutchStartTime = block.timestamp + 1000;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        _init(p);

        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.DutchAuctionNotActive.selector);
        drop.mint{value: 1 ether}(1, 0, proof);
    }

    // ── Withdraw split ─────────────────────────────────────────────────

    function test_withdraw_splitsCreatorAndPlatform() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 4}(4, 0, proof);

        uint256 total = MINT_PRICE * 4;
        uint256 expectPlatform = (total * PLATFORM_FEE_BPS) / 10000;
        uint256 expectCreator = total - expectPlatform;

        // AUDIT NEW-L1: creator must explicitly end the sale before withdrawing.
        // Prior to this guard, withdraw() was callable mid-mint, allowing the creator
        // to drain batches and then block cancel (H9 bypass).
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);

        vm.prank(creator);
        drop.withdraw();

        // WETHFallbackLib should transfer ETH to both EOAs (cleanly).
        assertEq(platform.balance, expectPlatform);
        assertEq(creator.balance, expectCreator);
    }

    /// @notice AUDIT NEW-L1: withdraw must revert if the sale is still live (not CLOSED,
    ///         not sold out). Prior to the fix, withdraw() was unconditional — creator
    ///         could drain batch 1, accept batch 2 mints, drain batch 2; batch-2 minters
    ///         were then trapped because cancelSale() is blocked by `withdrawn=true`.
    function test_withdraw_revertsDuringActiveMint() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 4}(4, 0, proof);

        // Phase is still PUBLIC — withdraw must revert.
        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.WithdrawFailed.selector);
        drop.withdraw();

        // Closing the sale unlocks withdraw.
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        vm.prank(creator);
        drop.withdraw();
        assertTrue(drop.withdrawn());
    }

    /// @notice AUDIT NEW-L1: once withdraw has run, the sale cannot be re-opened —
    ///         else a second wave of minters would pay into a contract whose cancel
    ///         path is permanently blocked, reproducing the H9 bypass.
    function test_setMintPhase_revertsWhenReopeningAfterWithdraw() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, 0, proof);

        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        vm.prank(creator);
        drop.withdraw();

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.WithdrawFailed.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
    }

    // ── AUDIT 2026-06-02 (MEDIUM): block the DUTCH_AUCTION -> zero-price-PUBLIC
    //    free-mint toggle (extends the H19 invariant to the phase machine) ──
    function test_setMintPhase_revertsPublicZeroPriceAfterMint() public {
        // Dutch drop with storage mintPrice == 0 (price comes from the curve).
        TegridyDropV2.InitParams memory p = _defaults();
        p.mintPrice = 0;
        p.dutchStartPrice = 1 ether;
        p.dutchEndPrice = 0.1 ether;
        p.dutchDuration = 3600;
        p.dutchStartTime = block.timestamp;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        _init(p);

        // Mainnet deploy env: sequencerFeed == 0 is a no-op only on chainid 1
        // (SequencerCheck.checkSequencerUp); the dutch mint path needs it.
        vm.chainId(1);

        // A buyer mints during the dutch phase at the real curve price.
        vm.warp(block.timestamp + 900); // clearly inside the dutch window
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: 1 ether}(1, 0, proof);
        assertEq(drop.totalSupply(), 1);

        // Owner must NOT be able to flip to a zero-price PUBLIC phase post-mint —
        // that would make subsequent mints free and rug the dutch bidders (H19).
        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.ZeroPricePostMint.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
    }

    // ── AUDIT 2026-06-05 (MEDIUM, commit b4a4cf1): the H19 "toggle-to-free" guard
    //    also covers DUTCH_AUCTION -> ALLOWLIST. ALLOWLIST prices off the SAME
    //    storage `mintPrice` as PUBLIC (mint(): `mintPhase == DUTCH_AUCTION ?
    //    _dutchAuctionPrice() : mintPrice`), so the same zero-price rug applies.
    //    Sibling of the PUBLIC test above; the only structural difference is a
    //    non-zero merkleRoot, so the ALLOWLIST-zero-root guard (src line 700)
    //    does NOT fire first and mask the zero-price guard we're asserting. ──
    function test_setMintPhase_revertsAllowlistZeroPriceAfterMint() public {
        // Dutch drop with storage mintPrice == 0 (price comes from the curve) AND a
        // non-zero merkleRoot, so `phase == ALLOWLIST && merkleRoot == bytes32(0)`
        // can't short-circuit ahead of the ZeroPricePostMint guard under test.
        TegridyDropV2.InitParams memory p = _defaults();
        p.mintPrice = 0;
        p.merkleRoot = bytes32(uint256(1));
        p.dutchStartPrice = 1 ether;
        p.dutchEndPrice = 0.1 ether;
        p.dutchDuration = 3600;
        p.dutchStartTime = block.timestamp;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        _init(p);

        // Mainnet deploy env: sequencerFeed == 0 is a no-op only on chainid 1
        // (SequencerCheck.checkSequencerUp); the dutch mint path needs it.
        vm.chainId(1);

        // A buyer mints during the dutch phase at the real curve price.
        vm.warp(block.timestamp + 900); // clearly inside the dutch window
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: 1 ether}(1, 0, proof);
        assertEq(drop.totalSupply(), 1);

        // Owner must NOT be able to flip to a zero-price ALLOWLIST phase post-mint —
        // allowlist claims would price off storage mintPrice == 0 (free), rugging the
        // dutch bidders exactly like the PUBLIC variant (H19).
        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.ZeroPricePostMint.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);
    }

    function test_setMintPhase_allowsPublicZeroPriceBeforeAnyMint() public {
        // Genesis free drop: zero mintPrice, no mints yet -> opening PUBLIC is allowed.
        TegridyDropV2.InitParams memory p = _defaults();
        p.mintPrice = 0;
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        _init(p);

        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.PUBLIC));
    }

    function test_withdraw_revertsWhenCancelled() public {
        // AUDIT FIX: DEEP-DROP-05 — cancel is now blocked after ANY mint.
        // Cancel pre-mint (totalSupply == 0), then verify withdraw reverts
        // SaleCancelled. The legacy "mint then cancel" flow is no longer
        // reachable; instead we cancel first.
        _init(_defaults());
        vm.prank(creator);
        drop.cancelSale();

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.SaleCancelled.selector);
        drop.withdraw();
    }

    // ── Cancel + refund (DEEP-DROP-05 changed semantics) ───────────────

    function test_cancelSale_revertsAfterFirstMint() public {
        // AUDIT FIX: DEEP-DROP-05 — once any mint has occurred, cancel is
        // permanently disabled. Closes the partial-mint refund-arbitrage
        // rug primitive.
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 3}(3, 0, proof);

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.CancelAfterFirstMint.selector);
        drop.cancelSale();
    }

    function test_refund_revertsWhenNotCancelled() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 0, proof);
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.SaleNotCancelled.selector);
        drop.refund();
    }

    function test_refund_revertsForNonMinter() public {
        // AUDIT FIX: DEEP-DROP-05 — no minters can exist post-cancel under
        // the new rules (cancel must precede any mint). bob (or anyone) who
        // didn't mint would always hit NothingToRefund regardless. We
        // exercise that invariant via a pre-mint cancel.
        _init(_defaults());
        vm.prank(creator);
        drop.cancelSale();

        vm.prank(bob); // bob never minted
        vm.expectRevert(TegridyDropV2.NothingToRefund.selector);
        drop.refund();
    }

    // ── Reveal ─────────────────────────────────────────────────────────

    function test_reveal_togglesTokenURI() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 0, proof);

        // Pre-reveal: tokenURI is the placeholder.
        assertEq(drop.tokenURI(1), "ipfs://placeholder");

        vm.prank(creator);
        drop.reveal("ipfs://revealed/");
        // Post-reveal: tokenURI is revealURI + tokenId.
        assertEq(drop.tokenURI(1), "ipfs://revealed/1");
    }

    function test_reveal_onlyOwner() public {
        _init(_defaults());
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.NotOwner.selector);
        drop.reveal("ipfs://x");
    }

    function test_reveal_cannotRevealTwice() public {
        _init(_defaults());
        vm.prank(creator);
        drop.reveal("ipfs://first/");
        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.AlreadyRevealed.selector);
        drop.reveal("ipfs://second/");
    }

    // ── 2-step ownership ───────────────────────────────────────────────

    function test_transferOwnership_twoStep() public {
        _init(_defaults());

        vm.prank(creator);
        drop.transferOwnership(alice);
        assertEq(drop.pendingOwner(), alice);
        assertEq(drop.owner(), creator, "owner unchanged until accept");

        // Bob can't accept — only the pendingOwner can.
        vm.prank(bob);
        vm.expectRevert(TegridyDropV2.NotOwner.selector);
        drop.acceptOwnership();

        vm.prank(alice);
        drop.acceptOwnership();
        assertEq(drop.owner(), alice);
        assertEq(drop.pendingOwner(), address(0));
    }

    function test_renounceOwnership_disabled() public {
        _init(_defaults());
        vm.prank(creator);
        // AUDIT FIX 2026-05-17 LOW: TegridyDropV2 now uses a typed error
        // `RenounceDisabled()` instead of the legacy string revert
        // `"RENOUNCE_DISABLED"`. Aligns with the cluster-wide
        // OwnableNoRenounce.RenounceDisabled selector.
        vm.expectRevert(TegridyDropV2.RenounceDisabled.selector);
        drop.renounceOwnership();
    }

    // ── Init guards ────────────────────────────────────────────────────

    function test_init_rejectsZeroCreator() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.creator = address(0);
        vm.expectRevert(TegridyDropV2.ZeroAddress.selector);
        drop.initialize(p);
    }

    function test_init_rejectsZeroMaxSupply() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.maxSupply = 0;
        vm.expectRevert(TegridyDropV2.InvalidMaxSupply.selector);
        drop.initialize(p);
    }

    function test_init_onlyOnce() public {
        _init(_defaults());
        TegridyDropV2.InitParams memory p = _defaults();
        vm.expectRevert();
        drop.initialize(p);
    }
}
