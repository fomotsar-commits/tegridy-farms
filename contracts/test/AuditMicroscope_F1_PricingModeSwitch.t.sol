// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract MockWETH_PricingMode is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @title TegridyDropV2 F1 (2026-09-17 triage): switching pricing mode with no notice.
/// @notice A drop prices off `mintPrice` (ALLOWLIST / PUBLIC) or off the dutch curve.
///         Each has a 24h proposal before it can change, but `setMintPhase` could flip
///         between the two in one transaction. `mint()` charges the price at execution
///         and refunds only the excess, so a buyer who sent more than the price shown
///         paid the other mode's price. Now opening one mode switches the other off.
contract AuditMicroscope_F1_PricingModeSwitchTest is Test {
    TegridyDropV2 drop;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32[] noProof;

    uint256 constant PUBLIC_PRICE = 0.05 ether;
    uint256 constant CURVE_START = 1 ether;
    uint256 constant CURVE_END = 0.1 ether;
    uint256 constant CURVE_LENGTH = 12 hours;

    function setUp() public {
        // Mainnet: a zero sequencer feed is a no-op only on chain 1 (SequencerCheck).
        vm.chainId(1);
        drop = TegridyDropV2(payable(Clones.clone(address(new TegridyDropV2()))));
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _params(uint256 mintPrice, TegridyDropV2.MintPhase phase)
        internal
        returns (TegridyDropV2.InitParams memory p)
    {
        p.name = "Drop";
        p.symbol = "DRP";
        p.maxSupply = 100;
        p.mintPrice = mintPrice;
        p.creator = creator;
        p.platformFeeRecipient = makeAddr("platform");
        p.platformFeeBps = 500;
        p.weth = address(new MockWETH_PricingMode());
        p.dutchStartPrice = CURVE_START;
        p.dutchEndPrice = CURVE_END;
        p.dutchStartTime = block.timestamp;
        p.dutchDuration = CURVE_LENGTH;
        p.initialPhase = phase;
    }

    /// PUBLIC at 0.05 ETH with a dutch curve armed behind it. Alice sends 1 ETH and is
    /// shown 0.05; the owner flips to the curve in front of her and she pays 1 ETH.
    function test_F1_publicBuyerIsNotSwitchedOntoTheCurve() public {
        drop.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        assertEq(drop.currentPrice(), PUBLIC_PRICE);

        vm.prank(creator);
        try drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION) {} catch {}

        vm.prank(alice);
        drop.mint{value: 1 ether}(1, 0, noProof);
        assertEq(drop.paidPerWallet(alice), PUBLIC_PRICE, "F1: buyer charged the other pricing mode");
    }

    /// The mirror: a dutch drop at 0.55 ETH mid-curve with a 5 ETH fixed price stored
    /// behind it. After one paid mint the owner flips to PUBLIC in front of alice.
    function test_F1_curveBuyerIsNotSwitchedOntoAStoredPrice() public {
        drop.initialize(_params(5 ether, TegridyDropV2.MintPhase.CLOSED));
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);

        vm.warp(block.timestamp + CURVE_LENGTH / 2);
        uint256 curvePrice = drop.currentPrice();
        assertEq(curvePrice, 0.55 ether);
        vm.prank(bob);
        drop.mint{value: curvePrice}(1, 0, noProof);

        vm.prank(creator);
        try drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC) {} catch {}

        vm.prank(alice);
        drop.mint{value: 5 ether}(1, 0, noProof);
        assertEq(drop.paidPerWallet(alice), curvePrice, "F1: buyer charged the other pricing mode");
    }

    /// A drop that opens priced may not carry the other mode's price at all.
    function test_F1_initializeRefusesAPreArmedOtherMode() public {
        TegridyDropV2.InitParams memory p = _params(PUBLIC_PRICE, TegridyDropV2.MintPhase.PUBLIC);
        vm.expectRevert(TegridyDropV2.PricingModeConflict.selector);
        drop.initialize(p);

        p.initialPhase = TegridyDropV2.MintPhase.DUTCH_AUCTION;
        vm.expectRevert(TegridyDropV2.PricingModeConflict.selector);
        drop.initialize(p);

        p.mintPrice = 0;
        drop.initialize(p);
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.DUTCH_AUCTION));
    }

    /// Switching back is still possible, with the 24h notice every price change has.
    function test_F1_switchBackNeedsAFresh24hProposal() public {
        drop.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.startPrank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        vm.expectRevert(TegridyDropV2.DutchAuctionNotActive.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);

        uint256 start = vm.getBlockTimestamp() + 2 days;
        drop.proposeDutchAuction(CURVE_START, CURVE_END, start, CURVE_LENGTH);
        uint256 readyAt = vm.getBlockTimestamp() + drop.DUTCH_CONFIG_DELAY();
        vm.warp(readyAt);
        drop.executeDutchAuction(CURVE_START, CURVE_END, start, CURVE_LENGTH, readyAt);
        drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);
        vm.stopPrank();
        assertEq(drop.mintPrice(), 0, "opening the curve switches the fixed price off");
    }

    // ─── Review of the F1 fix (2026-10-14) ───────────────────────────

    /// Opening the curve zeroes the stored 0.05 ETH. With nothing sold, the old guard
    /// (zero price only after a sale) let PUBLIC open at 0: every token free, the
    /// creator and the platform fee paid nothing, and no price event said so.
    function test_F1_curveThenFixedPriceBeforeAnySaleIsNeverFree() public {
        drop.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.startPrank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        try drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC) {} catch {}
        vm.stopPrank();

        vm.prank(alice);
        try drop.mint{value: PUBLIC_PRICE}(1, 0, noProof) {} catch {}
        assertEq(drop.totalProceeds(), drop.totalSupply() * PUBLIC_PRICE, "F1: tokens went out free");

        vm.startPrank(creator);
        vm.expectRevert(TegridyDropV2.FixedPriceNeedsProposal.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        vm.stopPrank();
    }

    /// The same from an allowlist, and from a drop that opened straight into the auction.
    function test_F1_anOpenedAuctionBlocksEveryFixedPricePhase() public {
        TegridyDropV2.InitParams memory p = _params(0, TegridyDropV2.MintPhase.DUTCH_AUCTION);
        p.merkleRoot = keccak256("allowlist");
        drop.initialize(p);
        assertTrue(drop.fixedPriceNeedsProposal(), "an auction opened at initialize");
        vm.startPrank(creator);
        vm.expectRevert(TegridyDropV2.FixedPriceNeedsProposal.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        vm.expectRevert(TegridyDropV2.FixedPriceNeedsProposal.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);
        vm.stopPrank();
    }

    /// The way back to a fixed price is a 24h proposal, after which the sale charges it.
    function test_F1_fixedPriceReopensOnlyAfterA24hProposal() public {
        drop.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.startPrank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        drop.proposeMintPrice(0.2 ether);
        uint256 readyAt = vm.getBlockTimestamp() + drop.MINT_PRICE_DELAY();
        vm.warp(readyAt);
        drop.executeMintPrice(0.2 ether, readyAt);
        assertFalse(drop.fixedPriceNeedsProposal());
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        vm.stopPrank();

        vm.prank(alice);
        drop.mint{value: 1 ether}(1, 0, noProof);
        assertEq(drop.paidPerWallet(alice), 0.2 ether);
    }

    /// Each switch-off is logged, and a switched-off auction reads as no auction.
    function test_F1_switchingAModeOffEmitsItsEvent() public {
        drop.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.expectEmit(address(drop));
        emit TegridyDropV2.DutchAuctionConfigured(0, 0, 0, 0);
        vm.prank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        assertEq(drop.dutchStartPrice() + drop.dutchEndPrice() + drop.dutchStartTime() + drop.dutchDuration(), 0);

        TegridyDropV2 other = TegridyDropV2(payable(Clones.clone(address(new TegridyDropV2()))));
        other.initialize(_params(PUBLIC_PRICE, TegridyDropV2.MintPhase.CLOSED));
        vm.expectEmit(address(other));
        emit TegridyDropV2.MintPriceChanged(0);
        vm.prank(creator);
        other.setMintPhase(TegridyDropV2.MintPhase.DUTCH_AUCTION);
    }
}
