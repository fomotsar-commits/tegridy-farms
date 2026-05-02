// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract MockWETH_DropMicroscope is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @title AUDIT MICROSCOPE_2026_04_30 — TegridyDropV2 hardening regression
/// @notice Covers C1 (allowlist leaf with amount), H18 (cancelSale post-sellout),
///         H19 (zero-price toggle attack), H20 (post-cancel rescue window).
contract AuditMicroscope_DropV2Test is Test {
    TegridyDropV2 drop;
    MockWETH_DropMicroscope weth;

    address creator = makeAddr("creator");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant MAX_SUPPLY = 3;
    uint256 constant MINT_PRICE = 0.05 ether;
    uint256 constant MAX_PER_WALLET = 5;

    function setUp() public {
        weth = new MockWETH_DropMicroscope();
        address impl = address(new TegridyDropV2());
        drop = TegridyDropV2(payable(Clones.clone(impl)));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
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
        p.contractURI_ = "ipfs://collection";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.PUBLIC;
    }

    function _initWithRoot(bytes32 root) internal {
        TegridyDropV2.InitParams memory p = _defaults();
        p.merkleRoot = root;
        p.initialPhase = TegridyDropV2.MintPhase.ALLOWLIST;
        drop.initialize(p);
    }

    // ─── C1 — Allowlist leaf binds amount ──────────────────────────────

    function test_C1_proofMatchingLeafAmountAllowsExactCap() public {
        // alice's leaf binds her at allowedAmount = 2.
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(address(drop), alice, uint256(2))))
        );
        _initWithRoot(leaf);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 2}(2, 2, proof);
        assertEq(drop.balanceOf(alice), 2);
        assertEq(drop.allowlistClaimed(alice), 2);

        // A subsequent mint MUST fail — allocation exhausted, even before maxPerWallet.
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.AllowlistAllocationExceeded.selector);
        drop.mint{value: MINT_PRICE}(1, 2, proof);
    }

    function test_C1_setMaxPerWallet_cannotReopenConsumedAllocation() public {
        // alice's leaf binds her at allowedAmount = 1. She mints 1.
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(address(drop), alice, uint256(1))))
        );
        _initWithRoot(leaf);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 1, proof);
        assertEq(drop.allowlistClaimed(alice), 1);

        // Owner moves to CLOSED to bump maxPerWallet (gated to CLOSED phase post-fix).
        // The cap can be raised, but allowlistClaimed[alice] is independent so the
        // proof remains exhausted.
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        vm.prank(creator);
        drop.setMaxPerWallet(10);
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);

        // Alice still cannot remint — the leaf-bound amount is still 1.
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.AllowlistAllocationExceeded.selector);
        drop.mint{value: MINT_PRICE}(1, 1, proof);
    }

    function test_C1_proofWithFakeAmountRejected() public {
        // alice's leaf binds her at allowedAmount = 1. She tries to claim with
        // amount = 2 in the proof — leaf check must fail (different leaf hash).
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(address(drop), alice, uint256(1))))
        );
        _initWithRoot(leaf);

        bytes32[] memory proof;
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.InvalidProof.selector);
        drop.mint{value: MINT_PRICE * 2}(2, 2, proof);
    }

    // ─── H18 — cancelSale blocked post-sellout ─────────────────────────

    function test_H18_cancelSaleRejectedAfterSellout() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        bytes32[] memory proof;
        // Mint to maxSupply (3 tokens).
        vm.prank(alice);
        drop.mint{value: MINT_PRICE * 3}(3, 0, proof);
        assertEq(drop.totalSupply(), MAX_SUPPLY);

        // AUDIT FIX: DEEP-DROP-05 — cancel is now blocked the moment ANY
        // mint has happened (not just at full sellout per the original H18
        // fix). Sellout is a strict subset of "any mint occurred", so this
        // still verifies post-sellout protection — via the broader
        // CancelAfterFirstMint error.
        vm.expectRevert(TegridyDropV2.CancelAfterFirstMint.selector);
        vm.prank(creator);
        drop.cancelSale();
    }

    // ─── H19 — Zero-price toggle blocked post-mint ─────────────────────

    function test_H19_setMintPriceZeroRejectedAfterAnyMint() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        bytes32[] memory proof;
        vm.prank(alice);
        drop.mint{value: MINT_PRICE}(1, 0, proof);

        // AUDIT FIX: V2-DROP-01 — `setMintPrice` is now a deprecated shim
        // that always reverts UseProposeMintPrice (closes the round-trip
        // bypass via setMintPhase). The H19 invariant "post-mint zero price
        // is rejected" is now subsumed by "any post-mint price change must
        // route through the timelocked propose/execute path, which itself
        // gates on phase + zero-price rules."
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        vm.expectRevert(TegridyDropV2.UseProposeMintPrice.selector);
        vm.prank(creator);
        drop.setMintPrice(0);
    }

    function test_H19_setMintPriceZeroAllowedPreMint() public {
        // AUDIT FIX: V2-DROP-01 — pre-mint zero price is set via
        // proposeMintPrice + executeMintPrice. The deprecated shim
        // unconditionally reverts.
        TegridyDropV2.InitParams memory p = _defaults();
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        vm.prank(creator);
        drop.proposeMintPrice(0);
        vm.warp(block.timestamp + 25 hours);
        vm.prank(creator);
        drop.executeMintPrice(0);
        assertEq(drop.mintPrice(), 0);
    }

    // ─── H20 — Post-cancel rescue window ───────────────────────────────

    function test_H20_rescueRevertsWithinWindow() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        // AUDIT FIX: DEEP-DROP-05 — cancel is now blocked the moment any mint
        // happens, so we must cancel BEFORE any mint. Donate ETH directly to
        // exercise the rescue-after-cancel path.
        vm.deal(address(drop), MINT_PRICE);

        vm.prank(creator);
        drop.cancelSale();

        // Same block: rescue must fail.
        vm.expectRevert(TegridyDropV2.RescueWindowActive.selector);
        vm.prank(creator);
        drop.rescueAfterCancellation();

        // 364 days later: still inside window.
        vm.warp(block.timestamp + 364 days);
        vm.expectRevert(TegridyDropV2.RescueWindowActive.selector);
        vm.prank(creator);
        drop.rescueAfterCancellation();
    }

    function test_H20_rescueSucceedsAfterOneYear() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        // AUDIT FIX: DEEP-DROP-05 — cancel pre-any-mint only. Donate ETH
        // (no minter pool) so the rescue path can sweep it.
        vm.deal(address(drop), MINT_PRICE);

        vm.prank(creator);
        drop.cancelSale();

        // Donated balance stays in the contract.
        assertEq(address(drop).balance, MINT_PRICE);

        // 1 year + 1s after cancellation: creator can sweep the residual.
        vm.warp(block.timestamp + 365 days + 1);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        drop.rescueAfterCancellation();
        uint256 creatorAfter = creator.balance;
        assertEq(creatorAfter - creatorBefore, MINT_PRICE);
        assertEq(address(drop).balance, 0);
    }

    function test_H20_rescueRevertsWithoutCancel() public {
        TegridyDropV2.InitParams memory p = _defaults();
        drop.initialize(p);

        // No cancel ever — rescue must reject.
        vm.warp(block.timestamp + 365 days + 1);
        vm.expectRevert(TegridyDropV2.SaleNotCancelled.selector);
        vm.prank(creator);
        drop.rescueAfterCancellation();
    }
}
