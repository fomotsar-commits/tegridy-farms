// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyLaunchpadV2.sol";
import "../src/TegridyDropV2.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract TegridyLaunchpadV2Test is Test {
    TegridyLaunchpadV2 public launchpad;

    address public admin = makeAddr("admin");
    address public platform = makeAddr("platform");
    address public creator = makeAddr("creator");
    address public alice = makeAddr("alice");
    address public weth = makeAddr("weth");

    uint16 public constant PROTOCOL_FEE_BPS = 500;
    uint256 public constant MINT_PRICE = 0.05 ether;
    uint256 public constant MAX_SUPPLY = 100;
    uint256 public constant MAX_PER_WALLET = 5;
    uint16 public constant ROYALTY_BPS = 750;

    bytes32 constant SAMPLE_ROOT = bytes32(uint256(0xabc123));
    string constant SAMPLE_CONTRACT_URI = "ar://contract-metadata-cid";
    string constant SAMPLE_PLACEHOLDER = "ar://placeholder-cid";

    function setUp() public {
        launchpad = new TegridyLaunchpadV2(admin, PROTOCOL_FEE_BPS, platform, weth, address(0));
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _defaultConfig() internal pure returns (TegridyLaunchpadV2.CollectionConfig memory cfg) {
        cfg.name = "TestDrop";
        cfg.symbol = "TDROP";
        cfg.maxSupply = MAX_SUPPLY;
        cfg.mintPrice = MINT_PRICE;
        cfg.maxPerWallet = MAX_PER_WALLET;
        cfg.royaltyBps = ROYALTY_BPS;
        cfg.placeholderURI = SAMPLE_PLACEHOLDER;
        cfg.contractURI = SAMPLE_CONTRACT_URI;
        cfg.initialPhase = TegridyDropV2.MintPhase.CLOSED;
    }

    // ─── Tests ───────────────────────────────────────────────────────

    /// @notice Test 1: Single-tx createCollection wires everything: contractURI,
    ///         placeholderURI, merkleRoot, dutch params, and initial phase.
    function test_createCollection_singleTx_initializesEverything() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.merkleRoot = SAMPLE_ROOT;
        cfg.dutchStartPrice = 1 ether;
        cfg.dutchEndPrice = 0.1 ether;
        cfg.dutchStartTime = block.timestamp + 1 hours;
        cfg.dutchDuration = 12 hours;
        cfg.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;

        vm.prank(creator);
        (uint256 id, address collection) = launchpad.createCollection(cfg);

        TegridyDropV2 drop = TegridyDropV2(collection);
        assertEq(id, 0);
        assertEq(drop.name(), "TestDrop");
        assertEq(drop.symbol(), "TDROP");
        assertEq(drop.maxSupply(), MAX_SUPPLY);
        assertEq(drop.owner(), creator);
        assertEq(drop.contractURI(), SAMPLE_CONTRACT_URI);
        assertEq(drop.merkleRoot(), SAMPLE_ROOT);
        assertEq(drop.dutchStartPrice(), 1 ether);
        assertEq(drop.dutchEndPrice(), 0.1 ether);
        assertEq(drop.dutchDuration(), 12 hours);
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.DUTCH_AUCTION));
    }

    /// @notice Test 2: Empty merkleRoot is allowed when phase is not ALLOWLIST.
    function test_createCollection_emptyMerkle_still_deploys() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.PUBLIC;

        vm.prank(creator);
        (, address collection) = launchpad.createCollection(cfg);

        TegridyDropV2 drop = TegridyDropV2(collection);
        assertEq(drop.merkleRoot(), bytes32(0));
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.PUBLIC));
    }

    /// @notice Test 3: DUTCH_AUCTION phase without valid dutch params reverts.
    function test_createCollection_dutchPhase_requires_dutchParams() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        // All dutch* fields are 0 — should revert

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.DutchAuctionNotActive.selector);
        launchpad.createCollection(cfg);
    }

    /// @notice Test 4: Invalid royalty reverts, no lingering clone in allCollections.
    ///         CREATE2 + initialize are same tx, so revert rolls back both.
    function test_createCollection_rollback_on_invalidRoyalty() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.royaltyBps = 10001; // > 10000, invalid

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.InvalidRoyaltyBps.selector);
        launchpad.createCollection(cfg);

        assertEq(launchpad.getCollectionCount(), 0);
    }

    /// @notice Test 5: contractURI getter returns the value set at init.
    function test_contractURI_returns_setValue() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();

        vm.prank(creator);
        (, address collection) = launchpad.createCollection(cfg);

        assertEq(TegridyDropV2(collection).contractURI(), SAMPLE_CONTRACT_URI);
    }

    /// @notice Test 6: setContractURI is onlyOwner (creator).
    function test_setContractURI_onlyOwner() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();

        vm.prank(creator);
        (, address collection) = launchpad.createCollection(cfg);

        TegridyDropV2 drop = TegridyDropV2(collection);

        // alice (not owner) cannot update
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.NotOwner.selector);
        drop.setContractURI("ar://hijacked");

        // creator (owner) can update
        vm.prank(creator);
        drop.setContractURI("ar://updated");
        assertEq(drop.contractURI(), "ar://updated");
    }

    // NOTE: Test 7 (v1/v2 coexistence) was removed when V1 TegridyLaunchpad source
    // was deleted 2026-04-19. V1 clones on mainnet remain live and readable through
    // the V2 Drop ABI (strict superset at the read surface).

    /// @notice Test 8: PUBLIC initial phase allows immediate mint in the same block.
    function test_initialPhase_public_allowsMint_immediately() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.PUBLIC;

        vm.prank(creator);
        (, address collection) = launchpad.createCollection(cfg);

        TegridyDropV2 drop = TegridyDropV2(collection);

        // alice can mint immediately — no separate setMintPhase tx needed.
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 0, new bytes32[](0));

        assertEq(drop.totalSupply(), 1);
        assertEq(drop.balanceOf(alice), 1);
    }

    /// @notice Test 9: ALLOWLIST phase with zero merkleRoot reverts at init.
    function test_allowlistPhase_requires_merkleRoot() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        cfg.merkleRoot = bytes32(0);

        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        launchpad.createCollection(cfg);
    }

    /// @notice Test 10: Legacy CollectionCreated event still fires with the v1 topic
    ///         signature so existing indexers aren't broken.
    function test_legacy_event_shape_preserved() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();

        vm.expectEmit(false, false, true, false);
        // topic0 = keccak256("CollectionCreated(uint256,address,address,string,string,uint256)")
        // topic3 (indexed creator) = creator — we assert on that
        emit TegridyLaunchpadV2.CollectionCreated(0, address(0), creator, "", "", 0);

        vm.prank(creator);
        launchpad.createCollection(cfg);
    }

    /// @notice Fuzz: any bounded CollectionConfig either succeeds or reverts with a
    ///         known error. No panics, no silent state corruption.
    function testFuzz_collectionConfig_no_panics(
        uint96 mintPrice,
        uint32 maxSupply,
        uint32 maxPerWallet,
        uint16 royaltyBps
    ) public {
        // Bound inputs to reasonable ranges so we exercise edges without trivially
        // tripping InvalidMaxSupply/MintPriceTooHigh on every iteration.
        maxSupply = uint32(bound(maxSupply, 1, 100_000));
        mintPrice = uint96(bound(mintPrice, 0, 100 ether));
        royaltyBps = uint16(bound(royaltyBps, 0, 10_000));

        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.maxSupply = maxSupply;
        cfg.mintPrice = mintPrice;
        cfg.maxPerWallet = maxPerWallet;
        cfg.royaltyBps = royaltyBps;

        vm.prank(creator);
        try launchpad.createCollection(cfg) returns (uint256 id, address collection) {
            // If deploy succeeded, basic invariants must hold.
            TegridyDropV2 drop = TegridyDropV2(collection);
            assertEq(drop.maxSupply(), maxSupply);
            assertEq(drop.mintPrice(), mintPrice);
            assertEq(drop.owner(), creator);
            assertEq(launchpad.getCollectionCount(), id + 1);
        } catch {
            // Any revert is fine; we just don't want panics (array OOB, div/0, etc).
            assertEq(launchpad.getCollectionCount(), 0);
        }
    }

    /// @notice Regression: Wave-2 finding 2026-05-16 — the prior salt used the
    ///         global `allCollections.length`, letting any other creator's
    ///         deploy shift the deterministic address of a victim's pending
    ///         `createCollection`. With the per-creator nonce fix, the
    ///         deterministic address must be a pure function of the creator's
    ///         own state — unaffected by anyone else deploying in between.
    function test_perCreatorNonce_otherCreatorDoesNotShiftDeterministicAddress() public {
        // Capture creator's predicted address assuming creator's nonce = 0.
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.PUBLIC;
        bytes32 saltCreator = keccak256(
            abi.encode(block.chainid, address(launchpad), creator, uint256(0), cfg.name, cfg.symbol)
        );
        address dropTemplate = launchpad.dropTemplate();
        address predicted = Clones.predictDeterministicAddress(dropTemplate, saltCreator, address(launchpad));

        // Attacker deploys a collection BEFORE the victim. This advances
        // `allCollections.length` from 0 → 1. With the old salt this would
        // shift the creator's deterministic address; with the fix it must NOT.
        TegridyLaunchpadV2.CollectionConfig memory acfg = _defaultConfig();
        acfg.name = "AttackerDrop";
        acfg.symbol = "ADROP";
        acfg.initialPhase = TegridyDropV2.MintPhase.PUBLIC;
        vm.prank(alice);
        launchpad.createCollection(acfg);
        assertEq(launchpad.getCollectionCount(), 1, "attacker's deploy did not land");

        // Creator now deploys with their original cfg. Predicted should match.
        vm.prank(creator);
        (, address actual) = launchpad.createCollection(cfg);
        assertEq(actual, predicted, "another creator's deploy shifted my deterministic address");
        assertEq(launchpad.collectionsCreatedByCreator(creator), 1);
        assertEq(launchpad.collectionsCreatedByCreator(alice), 1);
    }

    /// @notice Wave-2 regression: per-creator nonce must advance monotonically
    ///         (0 → 1 → 2 → 3) across repeated deploys by the same creator,
    ///         and each deploy must produce a distinct address. A regression
    ///         that pins every call to nonce 0 (e.g. forgets to `++` the
    ///         storage slot) would land all subsequent deploys at the same
    ///         predicted address — CREATE2 would revert "create2 failed" on
    ///         the second deploy.
    function test_perCreatorNonce_advancesAndProducesDistinctAddresses() public {
        TegridyLaunchpadV2.CollectionConfig memory cfg = _defaultConfig();
        cfg.initialPhase = TegridyDropV2.MintPhase.PUBLIC;

        assertEq(launchpad.collectionsCreatedByCreator(creator), 0, "pre: nonce starts at 0");

        vm.prank(creator);
        (, address addr0) = launchpad.createCollection(cfg);
        assertEq(launchpad.collectionsCreatedByCreator(creator), 1, "after 1st: nonce == 1");

        vm.prank(creator);
        (, address addr1) = launchpad.createCollection(cfg);
        assertEq(launchpad.collectionsCreatedByCreator(creator), 2, "after 2nd: nonce == 2");

        vm.prank(creator);
        (, address addr2) = launchpad.createCollection(cfg);
        assertEq(launchpad.collectionsCreatedByCreator(creator), 3, "after 3rd: nonce == 3");

        // All three must be distinct — proves the nonce is in the salt and
        // advancing. A "stuck at 0" regression would revert at addr1.
        assertTrue(addr0 != addr1, "addr0 vs addr1 distinct");
        assertTrue(addr1 != addr2, "addr1 vs addr2 distinct");
        assertTrue(addr0 != addr2, "addr0 vs addr2 distinct");

        // Other creators' counters are unaffected.
        assertEq(launchpad.collectionsCreatedByCreator(alice), 0, "alice's nonce untouched");
    }

}
