// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyLaunchpad.sol";
import "../src/TegridyDrop.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract TegridyLaunchpadTest is Test {
    TegridyLaunchpad public launchpad;

    address public admin = makeAddr("admin");
    address public platform = makeAddr("platform");
    address public creator = makeAddr("creator");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public weth = makeAddr("weth");

    uint16 public constant PROTOCOL_FEE_BPS = 500; // 5%
    uint256 public constant MINT_PRICE = 0.05 ether;
    uint256 public constant MAX_SUPPLY = 100;
    uint256 public constant MAX_PER_WALLET = 5;
    uint16 public constant ROYALTY_BPS = 750; // 7.5%

    function setUp() public {
        launchpad = new TegridyLaunchpad(admin, PROTOCOL_FEE_BPS, platform, weth);

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _createDefaultCollection() internal returns (uint256 id, address collection) {
        vm.prank(creator);
        (id, collection) = launchpad.createCollection(
            "TestDrop",
            "TDROP",
            MAX_SUPPLY,
            MINT_PRICE,
            MAX_PER_WALLET,
            ROYALTY_BPS
        );
    }

    function _openPublicMint(address collection) internal {
        TegridyDrop drop = TegridyDrop(collection);
        vm.prank(creator);
        drop.setMintPhase(TegridyDrop.MintPhase.PUBLIC);
    }

    function _buildMerkleTree(address[] memory addrs)
        internal
        pure
        returns (bytes32 root, bytes32[][] memory proofs)
    {
        // Simple 2-leaf Merkle tree
        bytes32[] memory leaves = new bytes32[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            leaves[i] = keccak256(abi.encodePacked(addrs[i]));
        }

        // For a 2-element tree: root = hash(sort(leaf0, leaf1))
        proofs = new bytes32[][](addrs.length);
        if (addrs.length == 2) {
            root = _hashPair(leaves[0], leaves[1]);
            proofs[0] = new bytes32[](1);
            proofs[0][0] = leaves[1];
            proofs[1] = new bytes32[](1);
            proofs[1][0] = leaves[0];
        } else {
            // Single leaf tree
            root = leaves[0];
            proofs[0] = new bytes32[](0);
        }
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    // ===== COLLECTION CREATION =====

    function test_createCollection_returnsCorrectAddress() public {
        (uint256 id, address collection) = _createDefaultCollection();
        assertEq(id, 0);
        assertTrue(collection != address(0));
        assertTrue(collection.code.length > 0);
    }

    function test_createCollection_configMatches() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        assertEq(drop.name(), "TestDrop");
        assertEq(drop.symbol(), "TDROP");
        assertEq(drop.maxSupply(), MAX_SUPPLY);
        assertEq(drop.mintPrice(), MINT_PRICE);
        assertEq(drop.maxPerWallet(), MAX_PER_WALLET);
        assertEq(drop.creator(), creator);
        assertEq(drop.owner(), creator);
        assertEq(drop.platformFeeRecipient(), platform);
        assertEq(drop.platformFeeBps(), PROTOCOL_FEE_BPS);
    }

    function test_createCollection_storedInLaunchpad() public {
        (uint256 id, address collection) = _createDefaultCollection();
        TegridyLaunchpad.CollectionInfo memory info = launchpad.getCollection(id);

        assertEq(info.id, id);
        assertEq(info.collection, collection);
        assertEq(info.creator, creator);
        assertEq(keccak256(bytes(info.name)), keccak256(bytes("TestDrop")));
        assertEq(keccak256(bytes(info.symbol)), keccak256(bytes("TDROP")));
        assertEq(launchpad.getCollectionCount(), 1);
    }

    // ===== PUBLIC MINTING =====

    function test_publicMint_correctPrice() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, emptyProof);

        assertEq(drop.totalSupply(), 1);
        assertEq(drop.ownerOf(1), alice);
        assertEq(balBefore - alice.balance, MINT_PRICE);
    }

    function test_publicMint_maxSupplyEnforced() public {
        // Create a tiny collection to test sold-out
        vm.prank(creator);
        (, address collection) = launchpad.createCollection(
            "TinyDrop", "TINY", 3, MINT_PRICE, 0, ROYALTY_BPS
        );
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 3}(3, emptyProof);
        assertEq(drop.totalSupply(), 3);

        // Next mint should revert
        vm.prank(bob);
        vm.expectRevert(TegridyDrop.ExceedsMaxSupply.selector);
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    function test_publicMint_maxPerWalletEnforced() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        // Mint max per wallet
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * MAX_PER_WALLET}(MAX_PER_WALLET, emptyProof);

        // One more should revert
        vm.prank(alice);
        vm.expectRevert(TegridyDrop.ExceedsWalletLimit.selector);
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    function test_publicMint_insufficientPayment_reverts() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(TegridyDrop.InsufficientPayment.selector);
        drop.mint{value: MINT_PRICE - 1}(1, emptyProof);
    }

    // ===== ALLOWLIST MINTING =====

    function test_allowlistMint_validProof() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        address[] memory allowlisted = new address[](2);
        allowlisted[0] = alice;
        allowlisted[1] = bob;
        (bytes32 root, bytes32[][] memory proofs) = _buildMerkleTree(allowlisted);

        vm.startPrank(creator);
        drop.setMerkleRoot(root);
        drop.setMintPhase(TegridyDrop.MintPhase.ALLOWLIST);
        vm.stopPrank();

        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, proofs[0]);
        assertEq(drop.ownerOf(1), alice);
    }

    function test_allowlistMint_invalidProof_reverts() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        address[] memory allowlisted = new address[](2);
        allowlisted[0] = alice;
        allowlisted[1] = bob;
        (bytes32 root,) = _buildMerkleTree(allowlisted);

        vm.startPrank(creator);
        drop.setMerkleRoot(root);
        drop.setMintPhase(TegridyDrop.MintPhase.ALLOWLIST);
        vm.stopPrank();

        // Carol is not allowlisted
        bytes32[] memory fakeProof = new bytes32[](1);
        fakeProof[0] = keccak256(abi.encodePacked(alice));

        vm.prank(carol);
        vm.expectRevert(TegridyDrop.InvalidProof.selector);
        drop.mint{value: MINT_PRICE}(1, fakeProof);
    }

    // ===== DUTCH AUCTION =====

    function test_dutchAuction_priceDecreasesOverTime() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        uint256 startPrice = 1 ether;
        uint256 endPrice = 0.1 ether;
        uint256 startTime = block.timestamp + 100;
        uint256 duration = 1000;

        vm.startPrank(creator);
        drop.configureDutchAuction(startPrice, endPrice, startTime, duration);
        drop.setMintPhase(TegridyDrop.MintPhase.DUTCH_AUCTION);
        vm.stopPrank();

        // Before auction starts: price should be startPrice
        vm.warp(startTime - 1);
        assertEq(drop.currentPrice(), startPrice);

        // At start: price should be startPrice
        vm.warp(startTime);
        assertEq(drop.currentPrice(), startPrice);

        // Halfway through: price should be between start and end
        vm.warp(startTime + duration / 2);
        uint256 midPrice = drop.currentPrice();
        assertGt(midPrice, endPrice);
        assertLt(midPrice, startPrice);

        // Expected midpoint: startPrice - (priceDrop * elapsed) / duration
        uint256 expectedMid = startPrice - ((startPrice - endPrice) * (duration / 2)) / duration;
        assertEq(midPrice, expectedMid);

        // After auction ends: price should be endPrice (floor)
        vm.warp(startTime + duration + 1);
        assertEq(drop.currentPrice(), endPrice);
    }

    function test_dutchAuction_mintAtCurrentPrice() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        uint256 startPrice = 1 ether;
        uint256 endPrice = 0.1 ether;
        uint256 startTime = block.timestamp + 100;
        uint256 duration = 1000;

        vm.startPrank(creator);
        drop.configureDutchAuction(startPrice, endPrice, startTime, duration);
        drop.setMintPhase(TegridyDrop.MintPhase.DUTCH_AUCTION);
        vm.stopPrank();

        // Warp to midpoint and mint
        vm.warp(startTime + duration / 2);
        uint256 price = drop.currentPrice();
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        drop.mint{value: price}(1, emptyProof);
        assertEq(drop.ownerOf(1), alice);
    }

    // ===== REVEAL =====

    function test_reveal_tokenURIChanges() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        vm.startPrank(creator);
        drop.setBaseURI("ipfs://placeholder/");
        drop.setMintPhase(TegridyDrop.MintPhase.PUBLIC);
        vm.stopPrank();

        bytes32[] memory emptyProof = new bytes32[](0);
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, emptyProof);

        // Pre-reveal: all tokens share the placeholder
        string memory preReveal = drop.tokenURI(1);
        assertEq(keccak256(bytes(preReveal)), keccak256(bytes("ipfs://placeholder/")));

        // Reveal
        vm.prank(creator);
        drop.reveal("ipfs://revealed/");

        // Post-reveal: token-specific URI
        string memory postReveal = drop.tokenURI(1);
        assertEq(keccak256(bytes(postReveal)), keccak256(bytes("ipfs://revealed/1")));
    }

    function test_reveal_cannotRevealTwice() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        vm.prank(creator);
        drop.reveal("ipfs://revealed/");

        vm.prank(creator);
        vm.expectRevert(TegridyDrop.AlreadyRevealed.selector);
        drop.reveal("ipfs://another/");
    }

    // ===== WITHDRAW =====

    function test_withdraw_revenueSplitCorrectly() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        // Mint 5 tokens
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 5}(5, emptyProof);

        uint256 totalRevenue = address(collection).balance;
        uint256 expectedPlatform = (totalRevenue * PROTOCOL_FEE_BPS) / 10000;
        uint256 expectedCreator = totalRevenue - expectedPlatform;

        uint256 creatorBefore = creator.balance;
        uint256 platformBefore = platform.balance;

        vm.prank(creator);
        drop.withdraw();

        assertEq(creator.balance - creatorBefore, expectedCreator);
        assertEq(platform.balance - platformBefore, expectedPlatform);
        assertEq(address(collection).balance, 0);
    }

    // ===== SOLD OUT =====

    function test_soldOut_mintRevertsWhenMaxSupplyReached() public {
        vm.prank(creator);
        (, address collection) = launchpad.createCollection(
            "SmallDrop", "SMALL", 2, MINT_PRICE, 0, ROYALTY_BPS
        );
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, emptyProof);

        vm.prank(bob);
        vm.expectRevert(TegridyDrop.ExceedsMaxSupply.selector);
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    // ===== ADMIN: TIMELOCKED FEE CHANGE =====

    function test_admin_timelockedFeeChange() public {
        uint16 newFee = 1000; // 10%

        vm.prank(admin);
        launchpad.proposeProtocolFee(newFee);

        // Cannot execute before delay
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, launchpad.FEE_CHANGE()));
        vm.prank(admin);
        launchpad.executeProtocolFee();

        // Warp past delay
        vm.warp(block.timestamp + launchpad.FEE_CHANGE_DELAY() + 1);

        vm.prank(admin);
        launchpad.executeProtocolFee();

        assertEq(launchpad.protocolFeeBps(), newFee);
    }

    function test_admin_cancelFeeChange() public {
        vm.prank(admin);
        launchpad.proposeProtocolFee(1000);

        vm.prank(admin);
        launchpad.cancelProtocolFee();

        assertEq(launchpad.pendingProtocolFeeBps(), 0);
        assertEq(launchpad.protocolFeeBps(), PROTOCOL_FEE_BPS);
    }

    // ===== ADMIN: PAUSE =====

    function test_admin_pauseBlocksCreation() public {
        vm.prank(admin);
        launchpad.pause();

        vm.prank(creator);
        vm.expectRevert();
        launchpad.createCollection("Paused", "PAUSE", 100, MINT_PRICE, 5, ROYALTY_BPS);
    }

    function test_admin_unpauseAllowsCreation() public {
        vm.prank(admin);
        launchpad.pause();

        vm.prank(admin);
        launchpad.unpause();

        vm.prank(creator);
        (, address collection) = launchpad.createCollection(
            "Unpaused", "UNPAUSE", 100, MINT_PRICE, 5, ROYALTY_BPS
        );
        assertTrue(collection != address(0));
    }

    // ===== MULTIPLE COLLECTIONS =====

    function test_multipleCollections_eachHasCorrectConfig() public {
        vm.prank(creator);
        (uint256 id1, address col1) = launchpad.createCollection(
            "Alpha", "ALPHA", 50, 0.01 ether, 3, 500
        );

        vm.prank(alice);
        (uint256 id2, address col2) = launchpad.createCollection(
            "Beta", "BETA", 200, 0.1 ether, 10, 1000
        );

        // Verify IDs
        assertEq(id1, 0);
        assertEq(id2, 1);
        assertTrue(col1 != col2);

        // Verify collection 1
        TegridyDrop drop1 = TegridyDrop(col1);
        assertEq(drop1.name(), "Alpha");
        assertEq(drop1.maxSupply(), 50);
        assertEq(drop1.mintPrice(), 0.01 ether);
        assertEq(drop1.maxPerWallet(), 3);
        assertEq(drop1.creator(), creator);

        // Verify collection 2
        TegridyDrop drop2 = TegridyDrop(col2);
        assertEq(drop2.name(), "Beta");
        assertEq(drop2.maxSupply(), 200);
        assertEq(drop2.mintPrice(), 0.1 ether);
        assertEq(drop2.maxPerWallet(), 10);
        assertEq(drop2.creator(), alice);

        // Verify count
        assertEq(launchpad.getCollectionCount(), 2);
        address[] memory allCols = launchpad.getAllCollections();
        assertEq(allCols.length, 2);
        assertEq(allCols[0], col1);
        assertEq(allCols[1], col2);
    }

    // ===== MINT PHASE CLOSED =====

    function test_mintClosed_reverts() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        // Phase defaults to CLOSED
        vm.prank(alice);
        vm.expectRevert(TegridyDrop.MintClosed.selector);
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    // ===== OVERPAYMENT REFUND =====

    function test_publicMint_overpaymentRefunded() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        uint256 overpay = 1 ether;
        uint256 balBefore = alice.balance;

        vm.prank(alice);
        drop.mint{value: overpay}(1, emptyProof);

        // Should only have spent MINT_PRICE, rest refunded
        assertEq(balBefore - alice.balance, MINT_PRICE);
    }

    // ===== DROP PAUSE =====

    function test_drop_pauseBlocksMinting() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(creator);
        drop.pause();

        vm.prank(alice);
        vm.expectRevert();
        drop.mint{value: MINT_PRICE}(1, emptyProof);
    }

    // ===== DUTCH AUCTION CONFIG VALIDATION =====

    function test_dutchAuction_invalidConfig_reverts() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        // endPrice >= startPrice should revert
        vm.prank(creator);
        vm.expectRevert(TegridyDrop.InvalidDutchAuctionConfig.selector);
        drop.configureDutchAuction(0.1 ether, 1 ether, block.timestamp, 1000);

        // duration == 0 should revert
        vm.prank(creator);
        vm.expectRevert(TegridyDrop.InvalidDutchAuctionConfig.selector);
        drop.configureDutchAuction(1 ether, 0.1 ether, block.timestamp, 0);
    }

    // ===== ZERO QUANTITY MINT =====

    function test_mint_zeroQuantity_reverts() public {
        (, address collection) = _createDefaultCollection();
        _openPublicMint(collection);

        TegridyDrop drop = TegridyDrop(collection);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(TegridyDrop.ZeroQuantity.selector);
        drop.mint{value: 0}(0, emptyProof);
    }

    // ===== INPUT VALIDATION EDGE CASES =====

    function test_createCollectionEmptyNameReverts() public {
        vm.prank(creator);
        vm.expectRevert("Empty name");
        launchpad.createCollection("", "TDROP", MAX_SUPPLY, MINT_PRICE, MAX_PER_WALLET, ROYALTY_BPS);
    }

    function test_createCollectionEmptySymbolReverts() public {
        vm.prank(creator);
        vm.expectRevert("Empty symbol");
        launchpad.createCollection("TestDrop", "", MAX_SUPPLY, MINT_PRICE, MAX_PER_WALLET, ROYALTY_BPS);
    }

    function test_createCollectionMaxSupplyTooLargeReverts() public {
        vm.prank(creator);
        vm.expectRevert("Max supply too large");
        launchpad.createCollection("TestDrop", "TDROP", 100_001, MINT_PRICE, MAX_PER_WALLET, ROYALTY_BPS);
    }

    function test_createCollectionMintPriceTooHighReverts() public {
        vm.prank(creator);
        vm.expectRevert("Mint price too high");
        launchpad.createCollection("TestDrop", "TDROP", MAX_SUPPLY, 101 ether, MAX_PER_WALLET, ROYALTY_BPS);
    }

    // ===== DUTCH AUCTION: CANNOT MINT BEFORE START =====

    function test_dutchAuctionCannotMintBeforeStart() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        uint256 startPrice = 1 ether;
        uint256 endPrice = 0.1 ether;
        uint256 startTime = block.timestamp + 1000;
        uint256 duration = 2000;

        vm.startPrank(creator);
        drop.configureDutchAuction(startPrice, endPrice, startTime, duration);
        drop.setMintPhase(TegridyDrop.MintPhase.DUTCH_AUCTION);
        vm.stopPrank();

        // Attempt to mint before the auction start time
        vm.warp(startTime - 1);
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(TegridyDrop.DutchAuctionNotActive.selector);
        drop.mint{value: startPrice}(1, emptyProof);
    }

    // ===== TWO-STEP OWNERSHIP =====

    function test_twoStepOwnership() public {
        (, address collection) = _createDefaultCollection();
        TegridyDrop drop = TegridyDrop(collection);

        address newOwner = bob;

        // Step 1: creator initiates transfer — owner should NOT change yet
        vm.prank(creator);
        drop.transferOwnership(newOwner);
        assertEq(drop.owner(), creator);

        // Step 2: new owner accepts — ownership transfers
        vm.prank(newOwner);
        drop.acceptOwnership();
        assertEq(drop.owner(), newOwner);

        // Verify renounceOwnership is disabled
        vm.prank(newOwner);
        vm.expectRevert("RENOUNCE_DISABLED");
        drop.renounceOwnership();
    }
}
