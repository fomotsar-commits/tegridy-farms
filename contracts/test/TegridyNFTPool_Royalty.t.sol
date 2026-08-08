// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";

/// Minimal WETH mock with failure toggles so the tests can drive
/// `WETHFallbackLib.safeTransferETHOrWrapNoRevert` into each of its modes:
///   mode 0 — raw ETH send succeeds
///   mode 1 — ETH leg fails, WETH wrap+transfer succeeds
///   mode 2 — ETH leg fails, deposit OK, WETH transfer fails  (ETH SPENT, WETH stranded here)
///   mode 3 — ETH leg fails, deposit fails                    (ETH UNTOUCHED in the pool)
contract ToggleWETH {
    mapping(address => uint256) public balanceOf;
    bool public depositBroken;
    mapping(address => bool) public transferBlocked;

    function setDepositBroken(bool v) external { depositBroken = v; }
    function setTransferBlocked(address to, bool v) external { transferBlocked[to] = v; }

    function deposit() external payable {
        require(!depositBroken, "DEPOSIT_BROKEN");
        balanceOf[msg.sender] += msg.value;
    }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferBlocked[to]) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// ERC-721 that implements ERC-2981 with a flat, collection-wide rate.
contract MockRoyaltyNFT is ERC721 {
    uint256 private _nextId = 1;
    address public royaltyReceiver;
    uint256 public royaltyBps;

    constructor(address receiver_, uint256 bps_) ERC721("RoyaltyMock", "RMOCK") {
        royaltyReceiver = receiver_;
        royaltyBps = bps_;
    }

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        return (royaltyReceiver, salePrice * royaltyBps / 10_000);
    }
}

/// ERC-721 whose `royaltyInfo` burns unbounded gas. Proves the 50k cap.
contract GasBurnerRoyaltyNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("BurnerMock", "BURN") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    /// ~30k keccak rounds ≈ 2.5M gas — two orders of magnitude past the 50k cap,
    /// but bounded so an UNCAPPED call terminates instead of hanging the test.
    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        uint256 acc = 1;
        for (uint256 i = 0; i < 30_000; i++) {
            acc = uint256(keccak256(abi.encode(acc, i)));
        }
        return (address(uint160(acc)), acc);
    }
}

/// ERC-721 whose `royaltyInfo` always reverts.
contract RevertingRoyaltyNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("RevertMock", "RVRT") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        revert("HOSTILE_ROYALTY");
    }
}

/// A royalty receiver that rejects plain ETH — forces the WETH fallback leg.
contract RoyaltyRejector {
    // no receive(), no fallback => every ETH transfer to it reverts
}

/// AUDIT: buy-side ERC-2981 royalty was paid out of POOL capital instead of
/// being charged to the buyer, and the buy/sell round trip is curve-neutral, so
/// an attacker-controlled royalty receiver could drain the pool at gas cost.
/// These tests pin the corrected economics, the make-whole behaviour when the
/// royalty cannot be delivered, and the gas-cap / view-scan robustness.
contract TegridyNFTPoolRoyaltyTest is Test {
    TegridyNFTPoolFactory public factory;
    MockRoyaltyNFT public nft;
    ToggleWETH public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // LP / pool owner
    address public bob = makeAddr("bob");     // trader
    address public royaltyReceiver = makeAddr("royaltyReceiver");

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;
    uint256 public constant BPS = 10_000;

    /// Exactly the 25% cap — `amount > totalSale >> 2` is a strict `>`, so a
    /// receiver sitting at exactly 2500 bps extracts the maximum.
    uint256 public constant ROYALTY_BPS = 2500;

    /// Local mirror of `TegridyNFTPool.RoyaltyOrphaned` so `vm.expectEmit` can
    /// match on the topic hash without depending on cross-contract `emit`.
    event RoyaltyOrphaned(address indexed receiver, uint256 amount, uint256 indexed tokenId);

    function _deployFactory() internal {
        weth = new ToggleWETH();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function _deploy(uint256 bps) internal {
        _deployFactory();
        nft = new MockRoyaltyNFT(royaltyReceiver, bps);
    }

    function _mintTo(address to, uint256 count) internal returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = nft.mint(to);
        }
    }

    function _tradePool(address collection, uint256[] memory ids, uint256 ethAmount)
        internal
        returns (TegridyNFTPool p)
    {
        vm.startPrank(alice);
        IERC721(collection).setApprovalForAll(address(factory), true);
        address pool = factory.createPool{value: ethAmount}(
            collection,
            TegridyNFTPool.PoolType.TRADE,
            SPOT_PRICE,
            DELTA,
            0, // no LP fee — isolates the royalty leg
            ids
        );
        vm.stopPrank();
        p = TegridyNFTPool(payable(pool));
    }

    function _tradePool(uint256[] memory ids, uint256 ethAmount) internal returns (TegridyNFTPool p) {
        return _tradePool(address(nft), ids, ethAmount);
    }

    function _single(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    // ── (1) ROOT CAUSE: the buyer must fund the royalty, not the pool ──────

    function test_buyRoyalty_isChargedToBuyer_notPoolCapital() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 baseCost = SPOT_PRICE;
        uint256 protocolFee = baseCost * PROTOCOL_FEE_BPS / BPS;
        uint256 royalty = baseCost * ROYALTY_BPS / BPS;

        // The quote the UI shows MUST include the royalty the buyer will be charged.
        (uint256 quoted, ) = p.getBuyQuote(1);
        assertEq(quoted, baseCost + protocolFee + royalty, "quote must include royalty");

        uint256 poolBefore = address(p).balance;
        uint256 receiverBefore = royaltyReceiver.balance;

        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);

        // Royalty was actually paid (guards against "just delete the call").
        assertEq(royaltyReceiver.balance - receiverBefore, royalty, "royalty must still be paid");
        // Pool keeps the full curve revenue + protocol fee — it funded nothing.
        assertEq(
            address(p).balance - poolBefore,
            baseCost + protocolFee,
            "pool must not fund the royalty"
        );
    }

    // ── (2) THE DRAIN: curve-neutral round trips must not bleed the pool ───

    function test_roundTripLoop_doesNotDrainPool() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);

        uint256 tokenId = ids[0];
        uint256 startBalance = address(p).balance;

        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        for (uint256 i = 0; i < 10; i++) {
            (uint256 cost, ) = p.getBuyQuote(1);
            p.swapETHForNFTs{value: cost}(_single(tokenId), type(uint256).max, block.timestamp + 1 hours);
            p.swapNFTsForETH(_single(tokenId), 0, block.timestamp + 1 hours);
        }
        vm.stopPrank();

        // Pre-fix this bled ~0.23 ETH per loop (20 ETH -> ~17.5 ETH).
        assertGe(address(p).balance, startBalance, "royalty receiver drained pool capital");
    }

    // ── (3) SELL SIDE: the quote must match what the seller actually gets ──

    function test_sellQuote_reflectsRoyaltyDeduction() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);
        uint256[] memory sellerIds = _mintTo(bob, 1);

        (uint256 quotedPayout, ) = p.getSellQuote(1);

        uint256 bobBefore = bob.balance;
        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        p.swapNFTsForETH(sellerIds, quotedPayout, block.timestamp + 1 hours);
        vm.stopPrank();

        assertEq(bob.balance - bobBefore, quotedPayout, "seller received less than quoted");
    }

    /// `minOutput` must gate the amount the seller ACTUALLY receives, not the
    /// pre-royalty gross. Pre-fix a seller demanding the full quoted gross
    /// silently received `gross - royalty`.
    function test_sellMinOutput_gatesNetProceeds() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);
        uint256[] memory sellerIds = _mintTo(bob, 1);

        // basePayout = 1*spot - delta*1*(1+1)/2 = spot - delta
        uint256 gross = SPOT_PRICE - DELTA;
        uint256 protocolFee = gross * PROTOCOL_FEE_BPS / BPS;
        uint256 netBeforeRoyalty = gross - protocolFee;

        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        vm.expectRevert(TegridyNFTPool.InsufficientPayout.selector);
        p.swapNFTsForETH(sellerIds, netBeforeRoyalty, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    /// THE INVARIANT, across the whole rate band: a buy may never reduce the
    /// pool's ETH. This is the property whose violation WAS the critical — the
    /// pool funded the royalty out of spot revenue, so every buy shrank it.
    function testFuzz_buyNeverReducesPoolETH(uint16 bpsRaw) public {
        uint256 bps = uint256(bpsRaw) % (BPS + 1); // 0..10000, incl. > the 25% cap
        _deploy(bps);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 50 ether);

        uint256 poolBefore = address(p).balance;
        (uint256 quoted, ) = p.getBuyQuote(1);

        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);

        assertGe(address(p).balance, poolBefore, "buy drained pool ETH");
        // And the pool keeps exactly the curve price + protocol fee: it neither
        // funds the royalty nor skims it.
        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        assertEq(address(p).balance - poolBefore, SPOT_PRICE + protocolFee, "pool take drifted");
    }

    /// Above the 25% cap `_royaltyQuote` returns zero — and quote and settlement
    /// must agree on that, or the swap reverts / the pool eats the difference.
    function test_royaltyAboveCap_isZeroInQuoteAndSettlement() public {
        _deploy(2501); // one bp over the `amount > totalSale >> 2` cap
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        (uint256 quoted, ) = p.getBuyQuote(1);
        assertEq(quoted, SPOT_PRICE + protocolFee, "over-cap royalty must not be quoted");

        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);
        assertEq(royaltyReceiver.balance, 0, "over-cap royalty must not be paid");
    }

    /// The buyer's slippage bound must cover the royalty. Pre-fix `maxTotalCost`
    /// gated a royalty-free price, so a buyer could not express a ceiling on the
    /// amount actually leaving their wallet.
    function test_maxTotalCost_coversRoyalty() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        uint256 preRoyaltyCost = SPOT_PRICE + protocolFee;

        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.MaxCostExceeded.selector);
        p.swapETHForNFTs{value: 10 ether}(_single(ids[0]), preRoyaltyCost, block.timestamp + 1 hours);
    }

    /// Sell side, above the cap: no royalty, and the seller receives the full
    /// quoted gross.
    function test_sellQuote_aboveCap_payoutIsFullGross() public {
        _deploy(2501);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);
        uint256[] memory sellerIds = _mintTo(bob, 1);

        uint256 gross = SPOT_PRICE - DELTA;
        uint256 protocolFee = gross * PROTOCOL_FEE_BPS / BPS;
        (uint256 quotedPayout, ) = p.getSellQuote(1);
        assertEq(quotedPayout, gross - protocolFee, "over-cap royalty must not be deducted");

        uint256 bobBefore = bob.balance;
        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        p.swapNFTsForETH(sellerIds, quotedPayout, block.timestamp + 1 hours);
        vm.stopPrank();
        assertEq(bob.balance - bobBefore, quotedPayout);
        assertEq(royaltyReceiver.balance, 0);
    }

    /// A royalty receiver that reverts on `receive()` must not brick the swap,
    /// and must not leave the pool funding the royalty either. WETHFallbackLib
    /// wraps to WETH; the buyer's payment still covers it.
    function test_revertingRoyaltyReceiver_doesNotBrickBuy_norChargePool() public {
        _deployFactory();
        address rejector = address(new RoyaltyRejector());
        nft = new MockRoyaltyNFT(rejector, ROYALTY_BPS);

        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 poolBefore = address(p).balance;
        (uint256 quoted, ) = p.getBuyQuote(1);

        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);

        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        assertEq(address(p).balance - poolBefore, SPOT_PRICE + protocolFee, "pool funded a failed royalty");
        assertEq(weth.balanceOf(rejector), SPOT_PRICE * ROYALTY_BPS / BPS, "royalty should land as WETH");
    }

    // ── (4) REGRESSION: collections with NO ERC-2981 are unaffected ────────

    function test_nonRoyaltyCollection_quoteAndFlowUnchanged() public {
        _deploy(0); // receiver set, but 0 bps => royaltyInfo returns amount 0
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 baseCost = SPOT_PRICE;
        uint256 protocolFee = baseCost * PROTOCOL_FEE_BPS / BPS;

        (uint256 quoted, uint256 qFee) = p.getBuyQuote(1);
        assertEq(quoted, baseCost + protocolFee);
        assertEq(qFee, protocolFee);

        uint256 poolBefore = address(p).balance;
        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);
        assertEq(address(p).balance - poolBefore, baseCost + protocolFee);
        assertEq(royaltyReceiver.balance, 0);
    }

    // ── (5) SOLVENCY FLOOR: the royalty must stay inside the requirement ──

    /// REVIEW ADD-ON. `_getSellPriceFull` now returns `outputAmount` NET of the
    /// royalty, so the pre-existing solvency `require` had to gain a `+ royalty`
    /// term to keep requiring the same total (`basePayout`). Nothing in the
    /// existing regression sweep pinned that term — dropping it left every
    /// suite green — so this test exists solely to make the omission loud.
    ///
    /// Total ETH the pool must be able to honour on a sell is
    ///   outputAmount + royalty + protocolFee + lpFee  ==  basePayout,
    /// because `outputAmount + royalty` physically leaves the balance while
    /// `protocolFee + lpFee` get BOOKED into the accumulators that
    /// `claimLPFees` / `claimProtocolFees` must later be able to pay.
    ///
    /// Numbers (feeBps = 0, 1% protocol fee, 2500 bps royalty, 1 item):
    ///   basePayout   = spot - delta             = 0.9     ether  <- correct floor
    ///   protocolFee  = 1% of basePayout         = 0.009   ether
    ///   sellerGross  = basePayout - protocolFee = 0.891   ether  <- ETH that leaves
    ///   royalty      = 25% of sellerGross       = 0.22275 ether
    ///   outputAmount = sellerGross - royalty    = 0.66825 ether
    ///   under-required floor (no royalty term)  = 0.67725 ether
    /// Funding the pool with 0.895 ether is chosen so the mutant does not merely
    /// revert LATER (which would be an ambiguous signal): it is
    ///   - above the under-required floor  -> the mutant's gate passes,
    ///   - above the ETH that actually leaves -> the mutant's settlement completes,
    ///   - below the correct floor          -> correct code must reject.
    /// The mutant therefore books `protocolFee` into `accumulatedProtocolFees`
    /// while leaving only 0.004 ETH behind — `claimProtocolFees` can no longer be
    /// paid. That is precisely the DEEP-NFTPOOL-05/07 + M-1 invariant.
    function test_sellSolvencyFloor_includesRoyalty() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 0.895 ether);

        uint256 basePayout = SPOT_PRICE - DELTA;
        uint256 protocolFee = basePayout * PROTOCOL_FEE_BPS / BPS;
        uint256 sellerGross = basePayout - protocolFee;
        uint256 royalty = sellerGross * ROYALTY_BPS / BPS;
        uint256 outputAmount = sellerGross - royalty;

        // Pin the arithmetic so a curve change can't silently move the pool's
        // funding out of the window and make this test vacuous.
        assertEq(address(p).balance, 0.895 ether, "pool funding");
        assertLt(
            outputAmount + protocolFee,
            address(p).balance,
            "funding must EXCEED the under-required floor, else the test proves nothing"
        );
        assertLe(
            outputAmount + royalty,
            address(p).balance,
            "the mutant must be able to COMPLETE the sell, not just revert later"
        );
        assertLt(
            address(p).balance,
            outputAmount + royalty + protocolFee,
            "funding must fall SHORT of the correct floor"
        );
        // ...and completing it would leave the pool unable to honour the protocol
        // fee it just booked.
        assertLt(
            address(p).balance - (outputAmount + royalty),
            protocolFee,
            "the mutant must leave booked fees unpayable, else the floor is cosmetic"
        );

        uint256[] memory sellerIds = _mintTo(bob, 1);
        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        vm.expectRevert(bytes("POOL_INSUFFICIENT_ETH"));
        p.swapNFTsForETH(sellerIds, 0, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    // ── (6) ORPHANED-ROYALTY MAKE-WHOLE (review finding (b)) ──────────────
    //
    // Trunk's `_settleRoyalty` returned `royaltyPaid == 0` when the transfer
    // failed, which on the SELL leg made the seller whole (they received the
    // full pre-royalty gross). Charging the royalty during PRICING must not
    // silently drop that: whoever FUNDED an undeliverable royalty gets it back,
    // but only when the ETH is physically still in the pool (mode 3). In mode 2
    // the ETH has already been converted to WETH held for the receiver, so a
    // refund would spend it twice — see `test_..._strandedWETH_...` below.

    /// mode 3 — ETH leg fails AND the WETH deposit fails, so the royalty ETH is
    /// untouched in the pool. The BUYER funded it, so the buyer gets it back.
    function test_buy_undeliverableRoyalty_refundsBuyer() public {
        _deployFactory();
        address rejector = address(new RoyaltyRejector());
        nft = new MockRoyaltyNFT(rejector, ROYALTY_BPS);
        weth.setDepositBroken(true); // force mode 3

        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        uint256 royalty = SPOT_PRICE * ROYALTY_BPS / BPS;
        (uint256 quoted, ) = p.getBuyQuote(1);
        assertEq(quoted, SPOT_PRICE + protocolFee + royalty);

        uint256 poolBefore = address(p).balance;
        uint256 bobBefore = bob.balance;

        vm.expectEmit(true, true, false, true, address(p));
        emit RoyaltyOrphaned(rejector, royalty, ids[0]);
        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);

        // The buyer is made whole for the royalty they funded but that never landed.
        assertEq(bobBefore - bob.balance, SPOT_PRICE + protocolFee, "buyer overpaid an undeliverable royalty");
        assertEq(address(p).balance - poolBefore, SPOT_PRICE + protocolFee, "pool skimmed an undeliverable royalty");
        assertEq(weth.balanceOf(address(p)), 0, "no WETH should have been minted");
    }

    /// mode 3 on the SELL leg — trunk's exact make-whole: the seller receives the
    /// full pre-royalty gross when the royalty cannot be delivered.
    function test_sell_undeliverableRoyalty_makesSellerWhole() public {
        _deployFactory();
        address rejector = address(new RoyaltyRejector());
        nft = new MockRoyaltyNFT(rejector, ROYALTY_BPS);
        weth.setDepositBroken(true); // force mode 3

        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);
        uint256[] memory sellerIds = _mintTo(bob, 1);

        uint256 basePayout = SPOT_PRICE - DELTA;
        uint256 protocolFee = basePayout * PROTOCOL_FEE_BPS / BPS;
        uint256 sellerGross = basePayout - protocolFee;
        uint256 royalty = sellerGross * ROYALTY_BPS / BPS;

        (uint256 quotedPayout, ) = p.getSellQuote(1);
        assertEq(quotedPayout, sellerGross - royalty, "quote must be net of royalty");

        uint256 bobBefore = bob.balance;
        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        p.swapNFTsForETH(sellerIds, quotedPayout, block.timestamp + 1 hours);
        vm.stopPrank();

        assertEq(bob.balance - bobBefore, sellerGross, "seller not made whole for an undeliverable royalty");
        assertEq(weth.balanceOf(address(p)), 0, "no WETH should have been minted");
    }

    /// mode 2 — deposit SUCCEEDS but the WETH transfer fails, so the royalty ETH
    /// has physically left the pool's ETH balance and now sits here as WETH
    /// earmarked for the receiver. There is nothing left to refund; refunding
    /// anyway would spend the same wei twice and break the pool's fee-solvency
    /// invariant. `rescueStrandedRoyalty` is the (pre-existing) recovery path.
    function test_sell_strandedWETHRoyalty_isNotRefundedTwice() public {
        _deployFactory();
        address rejector = address(new RoyaltyRejector());
        nft = new MockRoyaltyNFT(rejector, ROYALTY_BPS);
        weth.setTransferBlocked(rejector, true); // deposit OK, transfer fails => mode 2

        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);
        uint256[] memory sellerIds = _mintTo(bob, 1);

        uint256 basePayout = SPOT_PRICE - DELTA;
        uint256 protocolFee = basePayout * PROTOCOL_FEE_BPS / BPS;
        uint256 sellerGross = basePayout - protocolFee;
        uint256 royalty = sellerGross * ROYALTY_BPS / BPS;

        uint256 bobBefore = bob.balance;
        uint256 poolBefore = address(p).balance;
        vm.startPrank(bob);
        nft.setApprovalForAll(address(p), true);
        p.swapNFTsForETH(sellerIds, 0, block.timestamp + 1 hours);
        vm.stopPrank();

        assertEq(bob.balance - bobBefore, sellerGross - royalty, "seller paid twice for one royalty");
        assertEq(weth.balanceOf(address(p)), royalty, "royalty should be stranded as WETH in the pool");
        // Exactly `sellerGross` left the pool: `outputAmount` to the seller plus
        // `royalty` converted to WETH. Not a wei more.
        assertEq(poolBefore - address(p).balance, sellerGross, "pool paid out more than the curve owed");

        // The pre-existing owner recovery path still reaches it.
        vm.prank(alice);
        p.rescueStrandedRoyalty();
        assertEq(weth.balanceOf(alice), royalty);
    }

    // ── (6b) RECONCILIATION VIEWS (review finding (a)) ────────────────────
    //
    // `getBuyQuote` / `getSellQuote` keep their selectors but changed the value
    // they return. The escape hatch for an integrator holding a pre-fix
    // expectation is the royalty component, exposed separately so nobody has to
    // re-derive it (and nobody double-counts it by adding it on top).

    function test_getBuyQuoteWithRoyalty_reconcilesWithGetBuyQuote() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 10 ether);

        uint256 baseCost = SPOT_PRICE;
        uint256 expectedFee = baseCost * PROTOCOL_FEE_BPS / BPS;
        uint256 expectedRoyalty = baseCost * ROYALTY_BPS / BPS;

        (uint256 quoted, uint256 quotedFee) = p.getBuyQuote(1);
        (
            uint256 inputAmount,
            uint256 protocolFee,
            uint256 lpFee,
            address receiver,
            uint256 royalty
        ) = p.getBuyQuoteWithRoyalty(1);

        // Same number, richer breakdown — never a second, different quote.
        assertEq(inputAmount, quoted, "the two buy views must agree");
        assertEq(protocolFee, quotedFee, "protocolFee must agree");
        assertEq(royalty, expectedRoyalty, "royalty component");
        assertEq(receiver, royaltyReceiver, "royalty receiver");
        assertEq(lpFee, 0);
        // The documented reconciliation: strip the royalty to recover the
        // pre-fix `getBuyQuote` figure exactly.
        assertEq(inputAmount - royalty, baseCost + expectedFee, "pre-fix quote must be recoverable");
        // And the whole thing is exactly what the swap charges.
        uint256 poolBefore = address(p).balance;
        vm.prank(bob);
        p.swapETHForNFTs{value: inputAmount}(_single(ids[0]), inputAmount, block.timestamp + 1 hours);
        assertEq(address(p).balance - poolBefore, baseCost + expectedFee);
        assertEq(royaltyReceiver.balance, expectedRoyalty);
    }

    function test_getSellQuoteWithRoyalty_reconcilesWithGetSellQuote() public {
        _deploy(ROYALTY_BPS);
        uint256[] memory ids = _mintTo(alice, 1);
        TegridyNFTPool p = _tradePool(ids, 20 ether);

        uint256 basePayout = SPOT_PRICE - DELTA;
        uint256 expectedFee = basePayout * PROTOCOL_FEE_BPS / BPS;
        uint256 sellerGross = basePayout - expectedFee;
        uint256 expectedRoyalty = sellerGross * ROYALTY_BPS / BPS;

        (uint256 quoted, uint256 quotedFee) = p.getSellQuote(1);
        (
            uint256 outputAmount,
            uint256 protocolFee,
            uint256 lpFee,
            address receiver,
            uint256 royalty
        ) = p.getSellQuoteWithRoyalty(1);

        assertEq(outputAmount, quoted, "the two sell views must agree");
        assertEq(protocolFee, quotedFee, "protocolFee must agree");
        assertEq(royalty, expectedRoyalty, "royalty component");
        assertEq(receiver, royaltyReceiver, "royalty receiver");
        assertEq(lpFee, 0);
        // The documented invariant: the components re-sum to the curve payout.
        assertEq(
            outputAmount + royalty + protocolFee + lpFee,
            basePayout,
            "components must re-sum to the curve payout"
        );
        assertEq(outputAmount + royalty, sellerGross, "pre-fix quote must be recoverable");
    }

    // ── (7) HOSTILE royaltyInfo: gas cap + factory view scan (finding (c)) ─

    /// The quote path now makes a `royaltyInfo` staticcall it did not make
    /// before. It MUST stay inside the 50k cap: without it, `royaltyInfo`
    /// receives 63/64 of the caller's gas and a burner turns every quote into a
    /// multi-million-gas call (and, at realistic budgets, an OOG revert).
    function test_hostileRoyaltyInfo_quoteStaysGasCapped() public {
        _deployFactory();
        GasBurnerRoyaltyNFT burner = new GasBurnerRoyaltyNFT();
        uint256[] memory ids = new uint256[](1);
        ids[0] = burner.mint(alice);
        TegridyNFTPool p = _tradePool(address(burner), ids, 10 ether);

        uint256 g0 = gasleft();
        (uint256 quoted, ) = p.getBuyQuote(1);
        uint256 usedBuy = g0 - gasleft();

        g0 = gasleft();
        p.getSellQuote(1);
        uint256 usedSell = g0 - gasleft();

        // The burner costs ~2.5M gas uncapped; 50k + dispatch is well under 300k.
        assertLt(usedBuy, 300_000, "getBuyQuote is not honouring the 50k royaltyInfo cap");
        assertLt(usedSell, 300_000, "getSellQuote is not honouring the 50k royaltyInfo cap");

        // And the hostile collection earns nothing: the burner OOGs inside the
        // capped call, so the catch returns a zero royalty.
        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        assertEq(quoted, SPOT_PRICE + protocolFee, "hostile royaltyInfo must price as zero royalty");

        // The swap itself still settles.
        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);
        assertEq(burner.ownerOf(ids[0]), bob);
    }

    /// The factory's best-pool scan calls `getBuyQuote` / `getSellQuote` inside a
    /// `try`. A hostile `royaltyInfo` must not be able to knock a pool out of the
    /// scan (or OOG the whole scan) via the new staticcall.
    function test_hostileRoyaltyInfo_doesNotBrickFactoryScan() public {
        _deployFactory();
        GasBurnerRoyaltyNFT burner = new GasBurnerRoyaltyNFT();
        uint256[] memory ids = new uint256[](1);
        ids[0] = burner.mint(alice);
        TegridyNFTPool p = _tradePool(address(burner), ids, 10 ether);

        uint256 g0 = gasleft();
        (address bestBuy, uint256 bestCost) = factory.getBestBuyPool(address(burner), 1);
        uint256 usedScan = g0 - gasleft();

        (address bestSell, ) = factory.getBestSellPool(address(burner), 1);

        assertEq(bestBuy, address(p), "hostile royaltyInfo knocked the pool out of the buy scan");
        assertEq(bestSell, address(p), "hostile royaltyInfo knocked the pool out of the sell scan");
        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        assertEq(bestCost, SPOT_PRICE + protocolFee);
        assertLt(usedScan, 400_000, "factory scan is not bounded by the royaltyInfo gas cap");
    }

    /// A `royaltyInfo` that simply reverts must be indistinguishable from a
    /// collection with no ERC-2981 at all, on both the quote and the swap.
    function test_revertingRoyaltyInfo_quotesAndSwapsNormally() public {
        _deployFactory();
        RevertingRoyaltyNFT hostile = new RevertingRoyaltyNFT();
        uint256[] memory ids = new uint256[](1);
        ids[0] = hostile.mint(alice);
        TegridyNFTPool p = _tradePool(address(hostile), ids, 10 ether);

        uint256 protocolFee = SPOT_PRICE * PROTOCOL_FEE_BPS / BPS;
        (uint256 quoted, ) = p.getBuyQuote(1);
        assertEq(quoted, SPOT_PRICE + protocolFee);

        // Scan BEFORE the swap — afterwards the pool holds 0 NFTs and is
        // legitimately skipped by the buy scan for reasons unrelated to royalty.
        (address bestBuy, ) = factory.getBestBuyPool(address(hostile), 1);
        assertEq(bestBuy, address(p), "a reverting royaltyInfo must not brick the scan");

        uint256 poolBefore = address(p).balance;
        vm.prank(bob);
        p.swapETHForNFTs{value: quoted}(_single(ids[0]), type(uint256).max, block.timestamp + 1 hours);
        assertEq(address(p).balance - poolBefore, SPOT_PRICE + protocolFee);
    }
}
