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
        drop.mint{value: MINT_PRICE}(1, proof);
    }

    function test_mint_revertsOnZeroQuantity() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.ZeroQuantity.selector);
        drop.mint{value: 0}(0, proof);
    }

    function test_publicMint_happyPath() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, proof);

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
        drop.mint{value: MINT_PRICE * 2}(2, proof);

        vm.prank(bob);
        vm.expectRevert(TegridyDropV2.ExceedsMaxSupply.selector);
        drop.mint{value: MINT_PRICE}(1, proof);
    }

    function test_mint_revertsOnExceedWalletLimit() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.ExceedsWalletLimit.selector);
        drop.mint{value: MINT_PRICE * 6}(6, proof);
    }

    // ── Payment ────────────────────────────────────────────────────────

    function test_mint_revertsOnInsufficientPayment() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.InsufficientPayment.selector);
        drop.mint{value: MINT_PRICE - 1}(1, proof);
    }

    function test_mint_refundsOverpayment() public {
        _init(_defaults());
        uint256 aliceBefore = alice.balance;
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE + 0.1 ether}(1, proof);

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
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    function test_allowlistMint_acceptsValidProof() public {
        // Single-leaf merkle tree: root is just the hash of (this, alice).
        // Proof is an empty array — the leaf IS the root.
        TegridyDropV2.InitParams memory p = _defaults();
        address dropAddr = address(drop);
        bytes32 leaf = keccak256(abi.encodePacked(dropAddr, alice));
        p.merkleRoot = leaf;
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        _init(p);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, proof);
        assertEq(drop.balanceOf(alice), 1);
    }

    function test_allowlistMint_crossUserLeafRejected() public {
        // alice's leaf as root — bob tries to mint with the same (empty)
        // proof; the hash doesn't match his address so verification fails.
        TegridyDropV2.InitParams memory p = _defaults();
        p.merkleRoot = keccak256(abi.encodePacked(address(drop), alice));
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        _init(p);

        bytes32[] memory proof;
        vm.prank(bob);
        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        drop.mint{value: MINT_PRICE}(1, proof);
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
        drop.mint{value: 1 ether}(1, proof);
    }

    // ── Withdraw split ─────────────────────────────────────────────────

    function test_withdraw_splitsCreatorAndPlatform() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 4}(4, proof);

        uint256 total = MINT_PRICE * 4;
        uint256 expectPlatform = (total * PLATFORM_FEE_BPS) / 10000;
        uint256 expectCreator = total - expectPlatform;

        vm.prank(creator);
        drop.withdraw();

        // WETHFallbackLib should transfer ETH to both EOAs (cleanly).
        assertEq(platform.balance, expectPlatform);
        assertEq(creator.balance, expectCreator);
    }

    function test_withdraw_revertsWhenCancelled() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, proof);

        vm.prank(creator);
        drop.cancelSale();

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.SaleCancelled.selector);
        drop.withdraw();
    }

    // ── Cancel + refund ────────────────────────────────────────────────

    function test_cancelAndRefund_happyPath() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 3}(3, proof);

        vm.prank(creator);
        drop.cancelSale();

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        drop.refund();

        uint256 nativeGained = alice.balance - aliceBefore;
        uint256 wethGained = weth.balanceOf(alice);
        // Total refund == everything alice paid.
        assertEq(nativeGained + wethGained, MINT_PRICE * 3, "full refund");
        // paidPerWallet reset so a second call reverts.
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.NothingToRefund.selector);
        drop.refund();
    }

    function test_refund_revertsWhenNotCancelled() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, proof);
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.SaleNotCancelled.selector);
        drop.refund();
    }

    function test_refund_revertsForNonMinter() public {
        _init(_defaults());
        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, proof);
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
        drop.mint{value: MINT_PRICE}(1, proof);

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
        vm.expectRevert(bytes("RENOUNCE_DISABLED"));
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
