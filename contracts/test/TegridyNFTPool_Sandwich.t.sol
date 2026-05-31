// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";
import {IWETH} from "../src/lib/WETHFallbackLib.sol";

// ─── Mock Contracts (reused patterns from TegridyNFTPool.t.sol) ────

contract MockWETH_Sandwich {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

contract MockNFT_Sandwich is ERC721 {
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

// ─── Test Suite ────────────────────────────────────────────────────

contract TegridyNFTPool_SandwichTest is Test {
    TegridyNFTPoolFactory public factory;
    MockNFT_Sandwich public nft;
    MockWETH_Sandwich public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice");       // pool creator / LP
    address public victim = makeAddr("victim");     // sandwich victim
    address public attacker = makeAddr("attacker"); // sandwich attacker

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;
    uint256 public constant LP_FEE_BPS = 500; // 5%

    function setUp() public {
        weth = new MockWETH_Sandwich();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new MockNFT_Sandwich();

        vm.deal(alice, 1000 ether);
        vm.deal(victim, 1000 ether);
        vm.deal(attacker, 1000 ether);

        // Mint 20 NFTs to alice (LP)
        for (uint256 i = 0; i < 20; i++) {
            nft.mint(alice);
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────

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
            0,
            tokenIds
        );
        vm.stopPrank();
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

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Sandwich attack scenario — maxTotalCost prevents it
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Classic sandwich: attacker front-runs victim's buy, inflating the price,
    ///         then back-runs by selling. The victim's maxTotalCost protects them.
    function test_sandwich_maxTotalCost_protectsVictim() public {
        // Create a SELL pool with 10 NFTs at 1 ETH each, 0.1 ETH delta
        uint256[] memory ids = _tokenIdArray(1, 10);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Victim wants to buy token 3. Gets a quote before submitting tx.
        // At current spotPrice = 1 ETH, cost for 1 item = 1 ETH + 1% protocol fee = 1.01 ETH
        (uint256 victimExpectedCost,) = p.getBuyQuote(1);

        // FRONT-RUN: Attacker buys tokens 1 and 2 first, raising the spot price
        uint256[] memory attackerBuyIds = _tokenIdArray(1, 2);
        (uint256 attackerCost,) = p.getBuyQuote(2);
        vm.prank(attacker);
        p.swapETHForNFTs{value: attackerCost}(attackerBuyIds, type(uint256).max, block.timestamp + 1 hours);

        // Spot price is now 1 ETH + 0.1*2 = 1.2 ETH
        assertEq(p.spotPrice(), SPOT_PRICE + DELTA * 2);

        // The cost to buy 1 NFT is now higher than what the victim expected
        (uint256 newCost,) = p.getBuyQuote(1);
        assertTrue(newCost > victimExpectedCost, "Price should be inflated after front-run");

        // VICTIM TX: Victim set maxTotalCost to their original expected cost.
        // This tx should REVERT because the price was inflated above their limit.
        uint256[] memory victimBuyIds = _singleId(3);
        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.MaxCostExceeded.selector);
        p.swapETHForNFTs{value: newCost}(victimBuyIds, victimExpectedCost, block.timestamp + 1 hours);
    }

    /// @notice When maxTotalCost is set too high (type(uint256).max), the victim
    ///         is NOT protected and pays the inflated price.
    function test_sandwich_noSlippageProtection_victimPaysMore() public {
        uint256[] memory ids = _tokenIdArray(1, 10);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Get original cost
        (uint256 originalCost,) = p.getBuyQuote(1);

        // Attacker front-runs: buys 2 NFTs
        uint256[] memory attackerBuyIds = _tokenIdArray(1, 2);
        (uint256 attackerCost,) = p.getBuyQuote(2);
        vm.prank(attacker);
        p.swapETHForNFTs{value: attackerCost}(attackerBuyIds, type(uint256).max, block.timestamp + 1 hours);

        // Victim buys with no slippage protection (maxTotalCost = max)
        (uint256 inflatedCost,) = p.getBuyQuote(1);
        uint256[] memory victimBuyIds = _singleId(3);
        vm.prank(victim);
        p.swapETHForNFTs{value: inflatedCost}(victimBuyIds, type(uint256).max, block.timestamp + 1 hours);

        // Victim paid more than the original cost
        assertTrue(inflatedCost > originalCost, "Victim paid inflated price without slippage protection");
        assertEq(nft.ownerOf(3), victim);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: minOutput prevents sell-side manipulation
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Attacker manipulates the pool to lower sell price, but the seller's
    ///         minOutput parameter protects them from receiving less than expected.
    function test_sandwich_minOutput_protectsSeller() public {
        // Create a TRADE pool with NFTs and ETH
        uint256[] memory poolIds = _tokenIdArray(1, 10);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, poolIds, 50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Mint NFTs for the seller (victim) and attacker
        uint256 victimNftId = nft.mint(victim);
        uint256 attackerNftId1 = nft.mint(attacker);
        uint256 attackerNftId2 = nft.mint(attacker);

        // Approve pool
        vm.prank(victim);
        nft.approve(pool, victimNftId);
        vm.prank(attacker);
        nft.setApprovalForAll(pool, true);

        // Victim checks the sell quote before submitting
        (uint256 victimExpectedPayout,) = p.getSellQuote(1);
        assertTrue(victimExpectedPayout > 0);

        // FRONT-RUN: Attacker sells NFTs to the pool, lowering the spot price
        uint256[] memory attackerSellIds = _singleId(attackerNftId1);
        vm.prank(attacker);
        p.swapNFTsForETH(attackerSellIds, 0, block.timestamp + 1 hours);

        // Spot price decreased
        assertTrue(p.spotPrice() < SPOT_PRICE, "Spot price should have decreased after sell");

        // Victim's sell would now pay less than expected
        (uint256 reducedPayout,) = p.getSellQuote(1);
        assertTrue(reducedPayout < victimExpectedPayout, "Payout should be reduced after manipulation");

        // Victim's tx should REVERT because minOutput protects them
        uint256[] memory victimSellIds = _singleId(victimNftId);
        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.InsufficientPayout.selector);
        p.swapNFTsForETH(victimSellIds, victimExpectedPayout, block.timestamp + 1 hours);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: deadline parameter works
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that expired deadlines cause swapETHForNFTs to revert.
    function test_deadline_swapETHForNFTs_expired() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 cost,) = p.getBuyQuote(1);
        uint256[] memory buyIds = _singleId(1);

        // Set deadline in the past
        uint256 pastDeadline = block.timestamp - 1;

        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.Expired.selector);
        p.swapETHForNFTs{value: cost}(buyIds, type(uint256).max, pastDeadline);
    }

    /// @notice Verify that expired deadlines cause swapNFTsForETH to revert.
    function test_deadline_swapNFTsForETH_expired() public {
        uint256[] memory poolIds = _tokenIdArray(1, 5);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, poolIds, 50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 sellerNftId = nft.mint(victim);
        vm.prank(victim);
        nft.approve(pool, sellerNftId);

        uint256[] memory sellIds = _singleId(sellerNftId);
        uint256 pastDeadline = block.timestamp - 1;

        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.Expired.selector);
        p.swapNFTsForETH(sellIds, 0, pastDeadline);
    }

    /// @notice Verify that a deadline that has not yet passed allows the swap.
    function test_deadline_swapETHForNFTs_valid() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 cost,) = p.getBuyQuote(1);
        uint256[] memory buyIds = _singleId(1);

        // Set deadline in the future
        uint256 futureDeadline = block.timestamp + 1 hours;

        vm.prank(victim);
        p.swapETHForNFTs{value: cost}(buyIds, type(uint256).max, futureDeadline);

        assertEq(nft.ownerOf(1), victim);
    }

    /// @notice Verify that deadline works correctly when time passes after mempool wait.
    ///         Simulates a tx sitting in the mempool and being included after deadline.
    function test_deadline_mempoolDelay_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        (uint256 cost,) = p.getBuyQuote(1);
        uint256[] memory buyIds = _singleId(1);

        // Deadline is 5 minutes from now
        uint256 deadline = block.timestamp + 5 minutes;

        // Simulate mempool delay: 10 minutes pass before tx is included
        vm.warp(block.timestamp + 10 minutes);

        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.Expired.selector);
        p.swapETHForNFTs{value: cost}(buyIds, type(uint256).max, deadline);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: proposeDelta upper bound enforcement (MAX_DELTA cap)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that proposeDelta rejects values above MAX_DELTA (100 ether).
    function test_proposeDelta_rejectsAboveMax() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Try to propose delta above MAX_DELTA
        vm.prank(alice); // alice is the pool owner
        vm.expectRevert(TegridyNFTPool.DeltaTooHigh.selector);
        p.proposeDelta(101 ether);
    }

    /// @notice Verify that proposeDelta accepts MAX_DELTA exactly (after timelock).
    function test_proposeDelta_acceptsExactMax() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // AUDIT TF-15: MAX_DELTA tightened 100 ETH → 10 ETH
        vm.prank(alice);
        p.proposeDelta(10 ether);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(alice);
        p.executeDeltaChange();

        assertEq(p.delta(), 10 ether);
    }

    /// @notice Verify that proposeDelta accepts zero (after timelock).
    function test_proposeDelta_acceptsZero() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        vm.prank(alice);
        p.proposeDelta(0);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(alice);
        p.executeDeltaChange();

        assertEq(p.delta(), 0);
    }

    /// @notice Verify that initialization also enforces the MAX_DELTA cap.
    function test_initialize_deltaTooHigh_reverts() public {
        uint256[] memory emptyIds = new uint256[](0);

        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.DeltaTooHigh.selector);
        factory.createPool{value: 1 ether}(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            SPOT_PRICE,
            101 ether, // delta above MAX_DELTA
            0,
            emptyIds
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Full sandwich attack scenario (buy, victim buy, sell)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Simulates a full sandwich attack and shows the attacker's profit/loss.
    ///         With proper slippage protection, the victim's tx reverts, making the
    ///         sandwich unprofitable.
    function test_sandwich_fullScenario_attackerLosesWithSlippage() public {
        // Create a TRADE pool with 10 NFTs and 50 ETH
        uint256[] memory poolIds = _tokenIdArray(1, 10);
        address pool = _createTradePool(SPOT_PRICE, DELTA, LP_FEE_BPS, poolIds, 50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 attackerBalanceBefore = attacker.balance;

        // Step 1: Attacker FRONT-RUNS — buys 2 NFTs
        uint256[] memory attackerBuyIds = _tokenIdArray(1, 2);
        (uint256 attackerBuyCost,) = p.getBuyQuote(2);
        vm.prank(attacker);
        p.swapETHForNFTs{value: attackerBuyCost}(attackerBuyIds, type(uint256).max, block.timestamp + 1 hours);

        uint256 spotAfterFrontRun = p.spotPrice();

        // Step 2: Victim tries to buy with tight slippage — REVERTS
        uint256[] memory victimBuyIds = _singleId(3);
        // Victim's maxTotalCost was based on the pre-attack price
        // 1 ETH * 1.01 (with protocol fee) ≈ 1.01 ETH
        uint256 victimMaxCost = 1.02 ether; // tight slippage limit
        (uint256 currentCostForVictim,) = p.getBuyQuote(1);
        assertTrue(currentCostForVictim > victimMaxCost, "Inflated price should exceed victim's limit");

        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.MaxCostExceeded.selector);
        p.swapETHForNFTs{value: currentCostForVictim}(victimBuyIds, victimMaxCost, block.timestamp + 1 hours);

        // Step 3: Attacker BACK-RUNS — sells the 2 NFTs back
        // Attacker needs to approve pool
        vm.prank(attacker);
        nft.setApprovalForAll(pool, true);

        (uint256 attackerSellPayout,) = p.getSellQuote(2);
        vm.prank(attacker);
        p.swapNFTsForETH(attackerBuyIds, 0, block.timestamp + 1 hours);

        uint256 attackerBalanceAfter = attacker.balance;

        // Since the victim's tx reverted, the attacker bought and sold at the
        // same price level. Due to LP fees (5%) and protocol fees (1%), the
        // attacker LOSES money on the round trip.
        assertTrue(
            attackerBalanceAfter < attackerBalanceBefore,
            "Attacker should lose money when victim uses slippage protection"
        );

        // Calculate the loss
        uint256 attackerLoss = attackerBalanceBefore - attackerBalanceAfter;
        // Also check WETH balance (in case payout was wrapped)
        uint256 attackerWeth = weth.balanceOf(attacker);

        // Total value (ETH + WETH) should still be less than before (fees eaten)
        assertTrue(
            attackerBalanceAfter + attackerWeth < attackerBalanceBefore,
            "Attacker total value should be less than before (fees)"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Buying more than available NFTs reverts
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that trying to buy an NFT not held by the pool reverts.
    function test_buyNFT_notHeld_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Try to buy token 5, which is not in the pool
        uint256[] memory buyIds = _singleId(5);
        (uint256 cost,) = p.getBuyQuote(1);
        vm.prank(victim);
        vm.expectRevert(abi.encodeWithSelector(TegridyNFTPool.NFTNotHeld.selector, 5));
        p.swapETHForNFTs{value: cost}(buyIds, type(uint256).max, block.timestamp + 1 hours);
    }

    /// @notice Verify that TooManyItems is enforced (max 100 per swap).
    function test_tooManyItems_reverts() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Try to buy 101 items
        uint256[] memory buyIds = _tokenIdArray(1, 101);
        vm.prank(victim);
        vm.expectRevert(TegridyNFTPool.TooManyItems.selector);
        p.swapETHForNFTs{value: 200 ether}(buyIds, type(uint256).max, block.timestamp + 1 hours);
    }
}
