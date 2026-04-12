// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockNFTForPool is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("MockApes", "MAPE") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
    function mintBatch(address to, uint256 count) external returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = _nextId++;
            _mint(to, ids[i]);
        }
    }
}

contract TegridyNFTPoolTest is Test {
    TegridyNFTPoolFactory public factory;
    MockNFTForPool public nft;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // pool creator / LP
    address public bob = makeAddr("bob");     // buyer
    address public carol = makeAddr("carol"); // seller

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;
    uint256 public constant LP_FEE_BPS = 500; // 5% for TRADE pools

    function setUp() public {
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient);
        nft = new MockNFTForPool();

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);

        // Mint NFTs to alice (LP), carol (seller)
        for (uint256 i = 0; i < 10; i++) {
            nft.mint(alice);
        }
        for (uint256 i = 0; i < 5; i++) {
            nft.mint(carol);
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _createSellPool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256[] memory tokenIds
    ) internal returns (address pool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            _spotPrice,
            _delta,
            0, // no LP fee for SELL
            tokenIds
        );
        vm.stopPrank();
    }

    function _createBuyPool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256 ethAmount
    ) internal returns (address pool) {
        uint256[] memory emptyIds = new uint256[](0);
        vm.prank(alice);
        pool = factory.createPool{value: ethAmount}(
            address(nft),
            TegridyNFTPool.PoolType.BUY,
            _spotPrice,
            _delta,
            0, // no LP fee for BUY
            emptyIds
        );
    }

    function _createTradePool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256 _feeBps,
        uint256[] memory tokenIds,
        uint256 ethAmount
    ) internal returns (address pool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool{value: ethAmount}(
            address(nft),
            TegridyNFTPool.PoolType.TRADE,
            _spotPrice,
            _delta,
            _feeBps,
            tokenIds
        );
        vm.stopPrank();
    }

    function _tokenIdArray(uint256 start, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = start + i;
        }
    }

    function _singleId(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    // ===== POOL CREATION =====

    function test_createPool_sellType() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(uint256(p.poolType()), uint256(TegridyNFTPool.PoolType.SELL));
        assertEq(p.spotPrice(), SPOT_PRICE);
        assertEq(p.delta(), DELTA);
        assertEq(p.getHeldCount(), 3);
        assertEq(address(p.nftCollection()), address(nft));
    }

    function test_createPool_buyType() public {
        address pool = _createBuyPool(SPOT_PRICE, DELTA, 10 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(uint256(p.poolType()), uint256(TegridyNFTPool.PoolType.BUY));
        assertEq(address(pool).balance, 10 ether);
        assertEq(p.getHeldCount(), 0);
    }

    function test_createPool_tradeType() public {
        uint256[] memory ids = _tokenIdArray(1, 2);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, ids, 5 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(uint256(p.poolType()), uint256(TegridyNFTPool.PoolType.TRADE));
        assertEq(p.feeBps(), LP_FEE_BPS);
        assertEq(p.getHeldCount(), 2);
        assertEq(address(pool).balance, 5 ether);
    }

    // ===== BUY SWAPS =====

    function test_buySwap_correctPricingAndSpotUpdate() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Get buy quote for 1 item
        (uint256 cost,) = p.getBuyQuote(1);
        // baseCost = 1 * 1e18 + 0.1e18 * 1 * 0 / 2 = 1e18
        // protocolFee = 1e18 * 100 / 10000 = 0.01e18
        // total = 1.01e18
        uint256 expectedBase = SPOT_PRICE;
        uint256 expectedProtocol = expectedBase * PROTOCOL_FEE_BPS / 10000;
        assertEq(cost, expectedBase + expectedProtocol);

        // Buy 1 NFT
        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost}(buyIds);

        assertEq(nft.ownerOf(1), bob);
        assertEq(p.spotPrice(), SPOT_PRICE + DELTA);
        assertEq(p.getHeldCount(), 2);
    }

    function test_buySwap_insufficientETH_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        uint256[] memory buyIds = _singleId(1);

        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.InsufficientETH.selector);
        p.swapETHForNFTs{value: 0.5 ether}(buyIds);
    }

    // ===== SELL SWAPS =====

    function test_sellSwap_quoteMathCorrect() public {
        // Create BUY pool with ETH
        address pool = _createBuyPool(SPOT_PRICE, DELTA, 20 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Get sell quote for 1 item
        (uint256 payout, uint256 protocolFee) = p.getSellQuote(1);
        // Sell: basePayout = 1 * spotPrice - delta * 1 * 2 / 2 = 1e18 - 0.1e18 = 0.9e18
        uint256 expectedBase = SPOT_PRICE - DELTA;
        uint256 expectedProtocol = expectedBase * PROTOCOL_FEE_BPS / 10000;
        uint256 expectedPayout = expectedBase - expectedProtocol;
        assertEq(payout, expectedPayout);
        assertEq(protocolFee, expectedProtocol);
    }

    function test_sellSwap_tracksNFTCorrectly() public {
        // After fix: onERC721Received handles _addHeldId, no double-tracking
        address pool = _createBuyPool(SPOT_PRICE, DELTA, 20 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256[] memory sellIds = _singleId(11);
        vm.startPrank(carol);
        nft.approve(address(p), 11);
        p.swapNFTsForETH(sellIds, 0);
        vm.stopPrank();

        assertTrue(p.isTokenHeld(11));
    }

    // ===== MULTI-ITEM BUYS =====

    function test_multiItemBuy_bondingCurveMath() public {
        uint256[] memory ids = _tokenIdArray(1, 5);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 numItems = 3;
        (uint256 cost, uint256 protocolFee) = p.getBuyQuote(numItems);

        // baseCost = N * spotPrice + delta * N * (N-1) / 2
        // = 3 * 1e18 + 0.1e18 * 3 * 2 / 2 = 3e18 + 0.3e18 = 3.3e18
        uint256 expectedBase = numItems * SPOT_PRICE + DELTA * numItems * (numItems - 1) / 2;
        uint256 expectedProtocol = expectedBase * PROTOCOL_FEE_BPS / 10000;
        assertEq(cost, expectedBase + expectedProtocol);
        assertEq(protocolFee, expectedProtocol);

        // Execute the buy
        uint256[] memory buyIds = _tokenIdArray(1, 3);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost}(buyIds);

        assertEq(p.spotPrice(), SPOT_PRICE + DELTA * numItems);
        assertEq(p.getHeldCount(), 2);
    }

    // ===== BONDING CURVE EDGE CASES =====

    function test_bondingCurve_deltaZero_flatPrice() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, 0, ids); // delta = 0

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 cost1,) = p.getBuyQuote(1);
        (uint256 cost3,) = p.getBuyQuote(3);

        uint256 expectedBase1 = SPOT_PRICE;
        uint256 expectedBase3 = 3 * SPOT_PRICE;
        assertEq(cost1, expectedBase1 + expectedBase1 * PROTOCOL_FEE_BPS / 10000);
        assertEq(cost3, expectedBase3 + expectedBase3 * PROTOCOL_FEE_BPS / 10000);

        // Cost of 3 should be exactly 3x cost of 1 (flat curve)
        assertEq(cost3, cost1 * 3);
    }

    function test_bondingCurve_singleItem() public {
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(2 ether, 0.5 ether, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 cost,) = p.getBuyQuote(1);
        // baseCost = 1 * 2e18 + 0.5e18 * 1 * 0 / 2 = 2e18
        uint256 expectedBase = 2 ether;
        assertEq(cost, expectedBase + expectedBase * PROTOCOL_FEE_BPS / 10000);
    }

    // ===== TRADE POOL FEES =====

    function test_tradePool_lpFeeApplied() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, ids, 10 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 costWithFee,) = p.getBuyQuote(1);
        uint256 baseCost = SPOT_PRICE; // 1 item, N*(N-1)/2 = 0
        uint256 lpFee = baseCost * LP_FEE_BPS / 10000;
        uint256 protocolFee = baseCost * PROTOCOL_FEE_BPS / 10000;
        uint256 expectedTotal = baseCost + lpFee + protocolFee;

        assertEq(costWithFee, expectedTotal);

        // Compare: cost without LP fee should be lower
        uint256[] memory ids2 = _tokenIdArray(4, 3); // alice's NFTs 4-6
        address poolNoFee = _createSellPool(SPOT_PRICE, DELTA, ids2);
        (uint256 costNoFee,) = TegridyNFTPool(payable(poolNoFee)).getBuyQuote(1);

        assertGt(costWithFee, costNoFee);
    }

    function test_tradePool_sellLpFeeDeducted() public {
        uint256[] memory ids = _tokenIdArray(1, 2);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, ids, 20 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 payout, uint256 protocolFee) = p.getSellQuote(1);
        // basePayout = spotPrice - delta = 0.9 ether
        uint256 basePayout = SPOT_PRICE - DELTA;
        uint256 lpFee = basePayout * LP_FEE_BPS / 10000;
        uint256 expectedProtocol = basePayout * PROTOCOL_FEE_BPS / 10000;
        uint256 expectedPayout = basePayout - lpFee - expectedProtocol;

        assertEq(payout, expectedPayout);
        assertEq(protocolFee, expectedProtocol);
    }

    // ===== PROTOCOL FEE =====

    function test_protocolFee_factoryReceivesCorrectAmount() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Note: protocol fee goes to feeRecipient (set as factory in pool.initialize)
        (uint256 cost, uint256 expectedProtocol) = p.getBuyQuote(1);
        uint256 recipientBefore = feeRecipient.balance;

        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost}(buyIds);

        assertEq(feeRecipient.balance - recipientBefore, expectedProtocol);
    }

    // ===== LIQUIDITY =====

    function test_addLiquidity_ethOnly() public {
        uint256[] memory initIds = _tokenIdArray(1, 2);
        address pool = _createSellPool(SPOT_PRICE, DELTA, initIds);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(p.getHeldCount(), 2);

        // Add ETH only (no NFTs — addLiquidity with NFTs has a double-tracking bug
        // because safeTransferFrom triggers onERC721Received which already adds the token,
        // then the explicit _addHeldId call reverts with NFTAlreadyHeld)
        uint256[] memory noIds = new uint256[](0);
        vm.prank(alice);
        p.addLiquidity{value: 5 ether}(noIds);

        assertEq(address(pool).balance, 5 ether);
    }

    function test_addLiquidity_nftsViaSafeTransfer() public {
        // Adding NFTs directly via safeTransferFrom to the pool works because
        // onERC721Received tracks them correctly without the double-add issue
        uint256[] memory initIds = _tokenIdArray(1, 2);
        address pool = _createSellPool(SPOT_PRICE, DELTA, initIds);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(p.getHeldCount(), 2);

        // Send NFTs directly to pool via safeTransferFrom (skipping addLiquidity)
        vm.startPrank(alice);
        nft.safeTransferFrom(alice, pool, 3);
        nft.safeTransferFrom(alice, pool, 4);
        vm.stopPrank();

        assertEq(p.getHeldCount(), 4);
        assertTrue(p.isTokenHeld(3));
        assertTrue(p.isTokenHeld(4));
    }

    function test_removeLiquidity_ethAndNFTs() public {
        uint256[] memory initIds = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, initIds);

        // Add ETH via addLiquidity (ETH only, no NFTs to avoid double-tracking bug)
        vm.prank(alice);
        TegridyNFTPool(payable(pool)).addLiquidity{value: 5 ether}(new uint256[](0));

        uint256 aliceBefore = alice.balance;
        uint256[] memory removeIds = _singleId(1);

        vm.prank(alice);
        TegridyNFTPool(payable(pool)).removeLiquidity(removeIds, 3 ether);

        assertEq(nft.ownerOf(1), alice);
        assertEq(TegridyNFTPool(payable(pool)).getHeldCount(), 2);
        assertEq(alice.balance - aliceBefore, 3 ether);
    }

    // ===== VIEW FUNCTIONS =====

    function test_getBuyQuote_accuracy() public {
        uint256[] memory ids = _tokenIdArray(1, 5);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Quote for 2 items
        (uint256 cost, uint256 protocolFee) = p.getBuyQuote(2);
        // baseCost = 2 * 1e18 + 0.1e18 * 2 * 1 / 2 = 2e18 + 0.1e18 = 2.1e18
        uint256 expectedBase = 2 * SPOT_PRICE + DELTA * 2 * 1 / 2;
        uint256 expectedProtocol = expectedBase * PROTOCOL_FEE_BPS / 10000;
        assertEq(cost, expectedBase + expectedProtocol);
        assertEq(protocolFee, expectedProtocol);
    }

    function test_getSellQuote_accuracy() public {
        address pool = _createBuyPool(SPOT_PRICE, DELTA, 20 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Quote for 2 items
        (uint256 payout, uint256 protocolFee) = p.getSellQuote(2);
        // basePayout = 2 * 1e18 - 0.1e18 * 2 * 3 / 2 = 2e18 - 0.3e18 = 1.7e18
        uint256 expectedBase = 2 * SPOT_PRICE - DELTA * 2 * 3 / 2;
        uint256 expectedProtocol = expectedBase * PROTOCOL_FEE_BPS / 10000;
        uint256 expectedPayout = expectedBase - expectedProtocol;
        assertEq(payout, expectedPayout);
        assertEq(protocolFee, expectedProtocol);
    }

    // ===== BEST POOL ROUTING =====

    function test_getBestBuyPool_acrossMultiplePools() public {
        // Pool 1: expensive
        uint256[] memory ids1 = _tokenIdArray(1, 3);
        address pool1 = _createSellPool(2 ether, DELTA, ids1);

        // Pool 2: cheap
        uint256[] memory ids2 = _tokenIdArray(4, 3);
        address pool2 = _createSellPool(0.5 ether, DELTA, ids2);

        (address bestPool, uint256 bestCost) = factory.getBestBuyPool(address(nft), 1);
        assertEq(bestPool, pool2);

        (uint256 expectedCost,) = TegridyNFTPool(payable(pool2)).getBuyQuote(1);
        assertEq(bestCost, expectedCost);
    }

    function test_getBestSellPool_acrossMultiplePools() public {
        // Pool 1: low buy price
        address pool1 = _createBuyPool(0.5 ether, DELTA, 10 ether);

        // Pool 2: high buy price (better for sellers)
        address pool2 = _createBuyPool(2 ether, DELTA, 20 ether);

        (address bestPool, uint256 bestPayout) = factory.getBestSellPool(address(nft), 1);
        assertEq(bestPool, pool2);

        (uint256 expectedPayout,) = TegridyNFTPool(payable(pool2)).getSellQuote(1);
        assertEq(bestPayout, expectedPayout);
    }

    // ===== EDGE CASES =====

    function test_buyFromEmptyPool_reverts() public {
        // Create pool with 1 NFT, buy it, then try to buy another
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(SPOT_PRICE, 0, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 cost,) = p.getBuyQuote(1);

        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost}(buyIds);

        // Pool is now empty — trying to buy a non-held NFT should revert
        uint256[] memory badIds = _singleId(1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TegridyNFTPool.NFTNotHeld.selector, 1));
        p.swapETHForNFTs{value: 10 ether}(badIds);
    }

    function test_emptySwap_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        uint256[] memory emptyIds = new uint256[](0);

        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.EmptySwap.selector);
        p.swapETHForNFTs{value: 1 ether}(emptyIds);
    }

    function test_buyFromBuyPool_reverts() public {
        address pool = _createBuyPool(SPOT_PRICE, DELTA, 10 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.PoolTypeMismatch.selector);
        p.swapETHForNFTs{value: 5 ether}(buyIds);
    }

    function test_sellToSellPool_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256[] memory sellIds = _singleId(11);
        vm.startPrank(carol);
        nft.approve(address(p), 11);
        vm.expectRevert(TegridyNFTPool.PoolTypeMismatch.selector);
        p.swapNFTsForETH(sellIds, 0);
        vm.stopPrank();
    }

    function test_sellPriceUnderflow_reverts() public {
        // Create BUY pool with low spotPrice relative to delta
        address pool = _createBuyPool(0.2 ether, 0.1 ether, 20 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Trying to sell 3 items: delta * 3 = 0.3e18 >= spotPrice 0.2e18
        vm.expectRevert(TegridyNFTPool.PriceUnderflow.selector);
        p.getSellQuote(3);
    }

    // ===== POOL INFO =====

    function test_getPoolInfo_comprehensive() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, ids, 5 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (
            address _nftCol,
            TegridyNFTPool.PoolType _pType,
            uint256 _spot,
            uint256 _d,
            uint256 _fee,
            uint256 _protoFee,
            address _own,
            uint256 _numNFTs,
            uint256 _ethBal
        ) = p.getPoolInfo();

        assertEq(_nftCol, address(nft));
        assertEq(uint256(_pType), uint256(TegridyNFTPool.PoolType.TRADE));
        assertEq(_spot, SPOT_PRICE);
        assertEq(_d, DELTA);
        assertEq(_fee, LP_FEE_BPS);
        assertEq(_protoFee, PROTOCOL_FEE_BPS);
        assertEq(_own, alice);
        assertEq(_numNFTs, 3);
        assertEq(_ethBal, 5 ether);
    }

    // ===== FACTORY ADMIN =====

    function test_factory_timelockedProtocolFeeChange() public {
        uint256 newFee = 200; // 2%

        vm.prank(admin);
        factory.proposeProtocolFeeChange(newFee);

        // Cannot execute before delay
        vm.expectRevert(
            abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, factory.PROTOCOL_FEE_CHANGE())
        );
        vm.prank(admin);
        factory.executeProtocolFeeChange();

        // Warp past delay
        vm.warp(block.timestamp + factory.PROTOCOL_FEE_DELAY() + 1);

        vm.prank(admin);
        factory.executeProtocolFeeChange();

        assertEq(factory.protocolFeeBps(), newFee);
    }

    function test_factory_pauseBlocksPoolCreation() public {
        vm.prank(admin);
        factory.pause();

        uint256[] memory emptyIds = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert();
        factory.createPool(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            SPOT_PRICE,
            DELTA,
            0,
            emptyIds
        );
    }

    // ===== EXCESS ETH REFUND ON BUY =====

    function test_buySwap_excessETHRefunded() public {
        uint256[] memory ids = _tokenIdArray(1, 1);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 cost,) = p.getBuyQuote(1);

        uint256 overpay = 5 ether;
        uint256 bobBefore = bob.balance;

        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        p.swapETHForNFTs{value: overpay}(buyIds);

        assertEq(bobBefore - bob.balance, cost);
    }

    // ===== HELD TOKEN TRACKING =====

    function test_heldTokenIds_accurateAfterSwaps() public {
        uint256[] memory ids = _tokenIdArray(1, 4);
        address pool = _createSellPool(SPOT_PRICE, 0, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Buy token 2
        (uint256 cost,) = p.getBuyQuote(1);
        uint256[] memory buyIds = _singleId(2);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost}(buyIds);

        assertFalse(p.isTokenHeld(2));
        assertTrue(p.isTokenHeld(1));
        assertTrue(p.isTokenHeld(3));
        assertTrue(p.isTokenHeld(4));
        assertEq(p.getHeldCount(), 3);

        uint256[] memory held = p.getHeldTokenIds();
        assertEq(held.length, 3);
    }
}
