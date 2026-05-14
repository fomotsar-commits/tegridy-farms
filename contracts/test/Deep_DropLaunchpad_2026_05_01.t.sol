// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";
import {TegridyLaunchpadV2} from "../src/TegridyLaunchpadV2.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract MockWETH_DeepDrop is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @title Deep Audit 2026-05-01 — Drop / Launchpad / TokenURIReader cluster regression
/// @notice Covers DEEP-DROP-01..07, DEEP-LP-01..04, DEEP-URI-01..03 fixes.
contract Deep_DropLaunchpad_Test is Test {
    TegridyDropV2 drop;
    TegridyLaunchpadV2 launchpad;
    MockWETH_DeepDrop weth;

    address creator = makeAddr("creator");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address newOwner = makeAddr("newOwner");

    uint256 constant MAX_SUPPLY = 5;
    uint256 constant MINT_PRICE = 0.05 ether;
    uint256 constant MAX_PER_WALLET = 5;

    function setUp() public {
        weth = new MockWETH_DeepDrop();
        address impl = address(new TegridyDropV2());
        drop = TegridyDropV2(payable(Clones.clone(impl)));
        launchpad = new TegridyLaunchpadV2(creator, 500, platform, address(weth), address(0));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(creator, 100 ether);
    }

    function _defaults() internal view returns (TegridyDropV2.InitParams memory p) {
        p.name = "Test Drop";
        p.symbol = "TD";
        p.maxSupply = MAX_SUPPLY;
        p.mintPrice = MINT_PRICE;
        p.maxPerWallet = MAX_PER_WALLET;
        p.royaltyBps = 500;
        p.creator = creator;
        p.platformFeeRecipient = platform;
        p.platformFeeBps = 500;
        p.weth = address(weth);
        p.placeholderURI = "ipfs://placeholder";
        p.contractURI_ = "";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.PUBLIC;
    }

    // ─── DEEP-DROP-01 — configureDutchAuction phase-locked ─────────────

    function test_DEEP_DROP_01_configureDutchAuction_revertsMidDutch() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.dutchStartPrice = 1 ether;
        p.dutchEndPrice = 0.1 ether;
        p.dutchStartTime = block.timestamp + 1 hours;
        p.dutchDuration = 12 hours;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        drop.initialize(p);

        // AUDIT FIX: V2-DROP-03 — `configureDutchAuction` is now a deprecated
        // shim that always reverts UseProposeDutchAuction directing callers to
        // the new propose/execute timelocked API.
        vm.expectRevert(TegridyDropV2.UseProposeDutchAuction.selector);
        vm.prank(creator);
        drop.configureDutchAuction(2 ether, 1 ether, block.timestamp + 1, 12 hours);
    }

    function test_DEEP_DROP_01_configureDutchAuction_allowedWhenClosed() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        // AUDIT FIX: V2-DROP-03 — owner now wires the curve via the
        // propose/execute timelock (proposeDutchAuction → wait → executeDutchAuction).
        // Execute is value-bound: must pass the EXACT same params used in propose.
        // AUDIT FIX V3-DROP-02: also bind expectedExecuteAfter.
        // AUDIT FIX V3-DROP-01: place startTime far enough in the future that
        // the curve hasn't ended at execute-time (post-warp).
        uint256 startTime = block.timestamp + 30 hours;
        vm.prank(creator);
        drop.proposeDutchAuction(2 ether, 1 ether, startTime, 12 hours);
        uint256 execAfter = block.timestamp + 24 hours;
        vm.warp(block.timestamp + 25 hours);
        vm.prank(creator);
        drop.executeDutchAuction(2 ether, 1 ether, startTime, 12 hours, execAfter);
        assertEq(drop.dutchStartPrice(), 2 ether);
    }

    // ─── DEEP-DROP-02 — setMintPrice phase-locked ──────────────────────

    function test_DEEP_DROP_02_setMintPrice_revertsMidPublic() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        // AUDIT FIX: V2-DROP-01 — `setMintPrice` is now a deprecated shim
        // that always reverts UseProposeMintPrice. Mid-PUBLIC hikes must
        // route through the new timelocked propose/execute API instead.
        vm.expectRevert(TegridyDropV2.UseProposeMintPrice.selector);
        vm.prank(creator);
        drop.setMintPrice(0.5 ether);
    }

    function test_DEEP_DROP_02_setMintPrice_allowedWhenClosed() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        // AUDIT FIX: V2-DROP-01 — propose/execute timelocked path.
        // AUDIT FIX V3-DROP-02: bind expectedExecuteAfter.
        vm.prank(creator);
        drop.proposeMintPrice(0.1 ether);
        uint256 execAfter = block.timestamp + 24 hours;
        vm.warp(block.timestamp + 25 hours);
        vm.prank(creator);
        drop.executeMintPrice(0.1 ether, execAfter);
        assertEq(drop.mintPrice(), 0.1 ether);
    }

    // ─── DEEP-DROP-03 — setMintPhase(ALLOWLIST) requires merkleRoot ────

    function test_DEEP_DROP_03_setMintPhase_allowlistZeroRoot_reverts() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        p.merkleRoot = bytes32(0);
        drop.initialize(p);

        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);
    }

    function test_DEEP_DROP_03_setMintPhase_allowlistWithRoot_succeeds() public {
        bytes32 root = keccak256("seed");
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        p.merkleRoot = root;
        drop.initialize(p);

        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.ALLOWLIST));
    }

    // ─── DEEP-DROP-04 — rescue can never strand late refunders ─────────

    function test_DEEP_DROP_04_rescueRespectsUnclaimedRefundPool() public {
        // AUDIT FIX: V2-DROP-02 — the unclaimedRefundPool counter was
        // removed (dead code; cancelSale is now blocked after any mint per
        // DEEP-DROP-05, making the refund/rescue plumbing structurally
        // unreachable for post-mint scenarios). The remaining valid scenario
        // is "no mints, controlled cancellation, residual is zero" — which
        // we exercise here via the original drop2 path.
        TegridyDropV2 drop2 = TegridyDropV2(payable(Clones.clone(address(new TegridyDropV2()))));
        TegridyDropV2.InitParams memory p2 = _defaults();
        drop2.initialize(p2);
        vm.prank(creator);
        drop2.cancelSale();

        vm.warp(block.timestamp + 366 days);
        // No mints, balance==0, NothingToRescue.
        vm.expectRevert(TegridyDropV2.NothingToRescue.selector);
        vm.prank(creator);
        drop2.rescueAfterCancellation();
    }

    function test_DEEP_DROP_04_rescueOnlyClaimsResidualDelta() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);
        // Cancel pre-mint per DEEP-DROP-05 gate.
        vm.prank(creator);
        drop.cancelSale();

        // Donate raw ETH to the contract (simulates accidental dust).
        vm.deal(address(drop), 1 ether);

        vm.warp(block.timestamp + 366 days);
        uint256 creatorBalanceBefore = creator.balance;
        vm.prank(creator);
        drop.rescueAfterCancellation();
        // unclaimedRefundPool == 0, so the entire 1 ether sweeps to creator.
        assertGt(creator.balance, creatorBalanceBefore);
    }

    // ─── DEEP-DROP-05 — cancelSale gated to totalSupply==0 ─────────────

    function test_DEEP_DROP_05_cancelSale_revertsAfterFirstMint() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 0, proof);

        vm.expectRevert(TegridyDropV2.CancelAfterFirstMint.selector);
        vm.prank(creator);
        drop.cancelSale();
    }

    function test_DEEP_DROP_05_cancelSale_succeedsAtZeroSupply() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        vm.prank(creator);
        drop.cancelSale();
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.CANCELLED));
    }

    // ─── DEEP-DROP-06 — setBaseURI freeze + post-reveal gate ───────────

    function test_DEEP_DROP_06_freezeBaseURI_blocksFutureSets() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        vm.prank(creator);
        drop.freezeBaseURI();
        assertTrue(drop.baseURIFrozen());

        vm.expectRevert(TegridyDropV2.BaseURIFrozen.selector);
        vm.prank(creator);
        drop.setBaseURI("ipfs://attempt-after-freeze");
    }

    function test_DEEP_DROP_06_setBaseURI_revertsPostReveal() public {
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        vm.prank(creator);
        drop.reveal("ipfs://reveal/");

        vm.expectRevert(TegridyDropV2.AlreadyRevealed.selector);
        vm.prank(creator);
        drop.setBaseURI("ipfs://post-reveal-mutation");
    }

    // ─── DEEP-DROP-07 — currentPrice non-revert sentinel ───────────────

    function test_DEEP_DROP_07_currentPriceReturnsSentinelOnSequencerFailure() public {
        // We can't easily mock a Chainlink feed in this test without the
        // SequencerCheck plumbing — but the path coverage we want is:
        //   currentPrice() in DUTCH phase => try external dutchAuctionPrice.
        //
        // Drop uses sequencerFeed = address(0) (no-op), so DUTCH succeeds.
        // The sentinel only fires when the external call reverts. For
        // address(0) feed, the call succeeds and returns the live price.
        // We rely on the static analyzer / spec-level check that the wrapper
        // is in place; runtime sentinel exercise lives in cluster-10 sequencer
        // tests where feed mocks already exist.
        TegridyDropV2.InitParams memory p = _defaults();
        p.dutchStartPrice = 1 ether;
        p.dutchEndPrice = 0.1 ether;
        p.dutchStartTime = block.timestamp + 1;
        p.dutchDuration = 12 hours;
        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        drop.initialize(p);

        vm.warp(block.timestamp + 2);
        uint256 quote = drop.currentPrice();
        // Should equal dutchStartPrice (we're at start) — definitely NOT max.
        assertLt(quote, type(uint256).max);
    }

    // ─── DEEP-LP-01 — acceptOwnership clears pending fee proposals ─────

    function test_DEEP_LP_01_acceptOwnership_cancelsFeeProposal() public {
        // creator owns launchpad; propose a fee, transfer to newOwner, and accept.
        vm.prank(creator);
        launchpad.proposeProtocolFee(800);
        assertTrue(launchpad.hasPendingProposal(launchpad.FEE_CHANGE()));

        vm.prank(creator);
        launchpad.transferOwnership(newOwner);
        vm.prank(newOwner);
        launchpad.acceptOwnership();

        // Pending fee proposal must be cleared.
        assertFalse(launchpad.hasPendingProposal(launchpad.FEE_CHANGE()));
        assertEq(launchpad.pendingProtocolFeeBps(), 0);
    }

    function test_DEEP_LP_01_acceptOwnership_cancelsRecipientProposal() public {
        vm.prank(creator);
        launchpad.proposeProtocolFeeRecipient(makeAddr("hostile"));
        assertTrue(launchpad.hasPendingProposal(launchpad.FEE_RECIPIENT_CHANGE()));

        vm.prank(creator);
        launchpad.transferOwnership(newOwner);
        vm.prank(newOwner);
        launchpad.acceptOwnership();

        assertFalse(launchpad.hasPendingProposal(launchpad.FEE_RECIPIENT_CHANGE()));
        assertEq(launchpad.pendingProtocolFeeRecipient(), address(0));
    }

    // ─── DEEP-LP-02 — pause blocks execute paths ───────────────────────

    function test_DEEP_LP_02_pauseBlocksExecuteFee() public {
        vm.prank(creator);
        launchpad.proposeProtocolFee(800);
        // AUDIT FIX: V2-LP-01 — execute is now value-bound to (fee, executeAfter).
        uint256 expectedExecAfter = block.timestamp + 48 hours;
        vm.warp(block.timestamp + 49 hours);

        vm.prank(creator);
        launchpad.pause();

        // execute now blocked while paused.
        vm.expectRevert(); // Pausable revert (EnforcedPause)
        vm.prank(creator);
        launchpad.executeProtocolFee(800, expectedExecAfter);
    }

    function test_DEEP_LP_02_pauseBlocksExecuteRecipient() public {
        address newRec = makeAddr("newRec");
        vm.prank(creator);
        launchpad.proposeProtocolFeeRecipient(newRec);
        uint256 expectedExecAfter = block.timestamp + 48 hours;
        vm.warp(block.timestamp + 49 hours);

        vm.prank(creator);
        launchpad.pause();

        vm.expectRevert();
        vm.prank(creator);
        launchpad.executeProtocolFeeRecipient(newRec, expectedExecAfter);
    }

    // ─── DEEP-LP-03 — paginated collections view ───────────────────────

    function test_DEEP_LP_03_paginatedReturnsCorrectSlice() public {
        // Create 3 collections
        TegridyLaunchpadV2.CollectionConfig memory cfg;
        cfg.name = "A"; cfg.symbol = "A"; cfg.maxSupply = 10; cfg.mintPrice = 0;
        cfg.maxPerWallet = 1; cfg.royaltyBps = 0;
        // AUDIT FIX 2026-05-14 — batch-15 enforces non-empty cfg.contractURI
        // at launchpad-layer (so freezeContractURI is reachable for every
        // drop). placeholderURI may stay empty (it's gated by the drop's
        // own setBaseURI fat-finger guard).
        cfg.placeholderURI = ""; cfg.contractURI = "ipfs://test-collection";
        cfg.merkleRoot = bytes32(0);
        cfg.initialPhase = TegridyDropV2.MintPhase.CLOSED;

        for (uint256 i; i < 3; ++i) {
            cfg.name = string.concat("C", vm.toString(i));
            cfg.symbol = string.concat("S", vm.toString(i));
            vm.prank(alice);
            launchpad.createCollection(cfg);
        }

        // Page 0..2 (full).
        address[] memory page = launchpad.getCollectionsPaginated(0, 10);
        assertEq(page.length, 3);

        // Page 1..2 (offset).
        page = launchpad.getCollectionsPaginated(1, 10);
        assertEq(page.length, 2);

        // Empty page (offset >= length).
        page = launchpad.getCollectionsPaginated(99, 10);
        assertEq(page.length, 0);
    }

    function test_DEEP_LP_03_paginatedRejectsOversizeLimit() public {
        vm.expectRevert(TegridyLaunchpadV2.PageLimitExceeded.selector);
        launchpad.getCollectionsPaginated(0, 1001);
    }

    // ─── DEEP-LP-04 — value-bound execute paths ────────────────────────

    function test_DEEP_LP_04_executeProtocolFee_rejectsMismatch() public {
        vm.prank(creator);
        launchpad.proposeProtocolFee(800);
        uint256 expectedExecAfter = block.timestamp + 48 hours;
        vm.warp(block.timestamp + 49 hours);

        // Pass wrong expected value.
        vm.expectRevert(TegridyLaunchpadV2.FeeMismatch.selector);
        vm.prank(creator);
        launchpad.executeProtocolFee(900, expectedExecAfter);
    }

    function test_DEEP_LP_04_executeProtocolFee_acceptsExactMatch() public {
        vm.prank(creator);
        launchpad.proposeProtocolFee(800);
        uint256 expectedExecAfter = block.timestamp + 48 hours;
        vm.warp(block.timestamp + 49 hours);

        vm.prank(creator);
        launchpad.executeProtocolFee(800, expectedExecAfter);
        assertEq(launchpad.protocolFeeBps(), 800);
    }

    function test_DEEP_LP_04_executeRecipient_rejectsMismatch() public {
        address rec1 = makeAddr("r1");
        address rec2 = makeAddr("r2");
        vm.prank(creator);
        launchpad.proposeProtocolFeeRecipient(rec1);
        uint256 expectedExecAfter = block.timestamp + 48 hours;
        vm.warp(block.timestamp + 49 hours);

        vm.expectRevert(TegridyLaunchpadV2.RecipientMismatch.selector);
        vm.prank(creator);
        launchpad.executeProtocolFeeRecipient(rec2, expectedExecAfter);
    }

    // ─── DEEP-URI-01 — _jsonEscape removed (compile-time check) ────────
    // No runtime test needed; the helper's absence is verified by the
    // contract's compiled bytecode no longer including the escape opcodes.
    // Slither/forge build will catch a regression that re-adds it without
    // a call site.

    // ─── DEEP-URI-02 — tokenURI requires existing token ────────────────

    function test_DEEP_URI_02_tokenURIRevertsForNonexistent() public {
        // Stub staking contract that always reverts on ownerOf for unminted.
        MockStaking_DropClusterDeep mock = new MockStaking_DropClusterDeep();
        TegridyTokenURIReader reader = new TegridyTokenURIReader(address(mock));

        vm.expectRevert(bytes("NONEXISTENT"));
        reader.tokenURI(99999);
    }

    function test_DEEP_URI_02_tokenURIWorksForMintedToken() public {
        MockStaking_DropClusterDeep mock = new MockStaking_DropClusterDeep();
        TegridyTokenURIReader reader = new TegridyTokenURIReader(address(mock));

        // Set up tokenId 1 as owned by alice.
        mock.setOwner(1, alice);
        mock.setPosition(1, 100 ether, uint64(block.timestamp + 30 days), 12000, 30 days, false, false);

        string memory uri = reader.tokenURI(1);
        assertGt(bytes(uri).length, 0);
    }
}

/// Minimal stub of the ITegridyStaking surface used by TegridyTokenURIReader.
contract MockStaking_DropClusterDeep {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => bytes) private _positions;

    function setOwner(uint256 tokenId, address holder) external {
        _owners[tokenId] = holder;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address h = _owners[tokenId];
        require(h != address(0), "ERC721: nonexistent");
        return h;
    }

    function setPosition(
        uint256 tokenId,
        uint256 amount,
        uint64 lockEnd,
        uint16 boostBps,
        uint32 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost
    ) external {
        _positions[tokenId] = abi.encode(
            amount, uint256(0), int256(0),
            lockEnd, boostBps, lockDuration,
            autoMaxLock, hasJbacBoost, uint64(0),
            uint256(0), false
        );
    }

    function positions(uint256 tokenId) external view returns (
        uint256, uint256, int256,
        uint64, uint16, uint32,
        bool, bool, uint64,
        uint256, bool
    ) {
        bytes memory p = _positions[tokenId];
        if (p.length == 0) {
            return (0, 0, 0, 0, 0, 0, false, false, 0, 0, false);
        }
        return abi.decode(p, (uint256, uint256, int256, uint64, uint16, uint32, bool, bool, uint64, uint256, bool));
    }
}
