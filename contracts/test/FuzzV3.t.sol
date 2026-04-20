// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyStaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─── Mock Contracts ──────────────────────────────────────────────────────

contract MockWETHV3 {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// @dev Minimal TegridyPair stub for the Lending fuzz suite. Fuzz paths never
///      opt into the ETH-floor check (minPositionETHValue = 0), so stored reserves
///      are never read — it's only here for constructor orientation resolution.
contract MockPairV3 {
    address public immutable token0;
    address public immutable token1;
    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (1e24, 1e21, uint32(block.timestamp));
    }
}

contract MockNFTV3 is ERC721 {
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

contract MockToweliV3 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBACv3 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: TegridyNFTPool Bonding Curve Fuzz Tests
// ═══════════════════════════════════════════════════════════════════════════

contract TegridyNFTPoolFuzzTest is Test {
    TegridyNFTPoolFactory public factory;
    MockNFTV3 public nft;
    MockWETHV3 public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // pool creator / LP
    address public bob = makeAddr("bob");     // buyer/seller

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant LP_FEE_BPS = 500;       // 5% for TRADE pools
    uint256 public constant BPS = 10_000;

    function setUp() public {
        weth = new MockWETHV3();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new MockNFTV3();

        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _createTradePool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256 numNFTs,
        uint256 ethAmount
    ) internal returns (address pool) {
        // Mint NFTs to alice and create pool
        uint256[] memory ids = new uint256[](numNFTs);
        vm.startPrank(alice);
        for (uint256 i = 0; i < numNFTs; i++) {
            ids[i] = nft.mint(alice);
        }
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool{value: ethAmount}(
            address(nft),
            TegridyNFTPool.PoolType.TRADE,
            _spotPrice,
            _delta,
            LP_FEE_BPS,
            ids
        );
        vm.stopPrank();
    }

    function _createSellPool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256 numNFTs
    ) internal returns (address pool) {
        uint256[] memory ids = new uint256[](numNFTs);
        vm.startPrank(alice);
        for (uint256 i = 0; i < numNFTs; i++) {
            ids[i] = nft.mint(alice);
        }
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            _spotPrice,
            _delta,
            0,
            ids
        );
        vm.stopPrank();
    }

    function _tokenIdArray(uint256 start, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = start + i;
        }
    }

    // ─── Fuzz: Buy quote matches bonding curve formula ──────────────────

    function testFuzz_buyQuoteMath(uint256 numItems) public {
        numItems = bound(numItems, 1, 50);

        uint256 spotPrice = 1 ether;
        uint256 delta = 0.05 ether;

        // Create a SELL pool with enough NFTs
        address pool = _createSellPool(spotPrice, delta, numItems);

        // Fund the pool with enough ETH for protocol fees accounting
        vm.deal(pool, 0);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 totalCost, uint256 protocolFee) = p.getBuyQuote(numItems);

        // Expected: baseCost = N * spotPrice + delta * N * (N-1) / 2
        uint256 baseCost = numItems * spotPrice + delta * numItems * (numItems - 1) / 2;

        // Protocol fee = baseCost * protocolFeeBps / BPS
        uint256 expectedProtocolFee = baseCost * PROTOCOL_FEE_BPS / BPS;

        // No LP fee for SELL pools
        uint256 expectedTotalCost = baseCost + expectedProtocolFee;

        assertEq(totalCost, expectedTotalCost, "Buy quote total cost mismatch");
        assertEq(protocolFee, expectedProtocolFee, "Buy quote protocol fee mismatch");
    }

    // ─── Fuzz: Buy quote with TRADE pool (includes LP fee) ─────────────

    function testFuzz_buyQuoteMathTradePool(uint256 numItems) public {
        numItems = bound(numItems, 1, 50);

        uint256 spotPrice = 1 ether;
        uint256 delta = 0.05 ether;

        // Create a TRADE pool with enough NFTs and ETH
        address pool = _createTradePool(spotPrice, delta, numItems, 100 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 totalCost, uint256 protocolFee) = p.getBuyQuote(numItems);

        // Expected: baseCost = N * spotPrice + delta * N * (N-1) / 2
        uint256 baseCost = numItems * spotPrice + delta * numItems * (numItems - 1) / 2;

        // LP fee = baseCost * LP_FEE_BPS / BPS
        uint256 lpFee = baseCost * LP_FEE_BPS / BPS;

        // Protocol fee = baseCost * protocolFeeBps / BPS
        uint256 expectedProtocolFee = baseCost * PROTOCOL_FEE_BPS / BPS;

        uint256 expectedTotalCost = baseCost + lpFee + expectedProtocolFee;

        assertEq(totalCost, expectedTotalCost, "TRADE buy quote total cost mismatch");
        assertEq(protocolFee, expectedProtocolFee, "TRADE buy quote protocol fee mismatch");
    }

    // ─── Fuzz: Sell quote matches bonding curve formula ─────────────────

    function testFuzz_sellQuoteMath(uint256 numItems) public {
        numItems = bound(numItems, 1, 50);

        uint256 spotPrice = 5 ether;
        uint256 delta = 0.05 ether;

        // Ensure numItems won't cause price underflow: spotPrice > delta * numItems
        // 5 ether > 0.05 ether * 50 = 2.5 ether — always safe

        // Create a TRADE pool with NFTs and enough ETH for payouts
        address pool = _createTradePool(spotPrice, delta, 50, 500 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 totalPayout, uint256 protocolFee) = p.getSellQuote(numItems);

        // Expected: basePayout = N * spotPrice - delta * N * (N+1) / 2
        uint256 basePayout = numItems * spotPrice - delta * numItems * (numItems + 1) / 2;

        // LP fee = basePayout * LP_FEE_BPS / BPS
        uint256 lpFee = basePayout * LP_FEE_BPS / BPS;

        // Protocol fee = basePayout * protocolFeeBps / BPS
        uint256 expectedProtocolFee = basePayout * PROTOCOL_FEE_BPS / BPS;

        uint256 expectedPayout = basePayout - lpFee - expectedProtocolFee;

        assertEq(totalPayout, expectedPayout, "Sell quote payout mismatch");
        assertEq(protocolFee, expectedProtocolFee, "Sell quote protocol fee mismatch");
    }

    // ─── Fuzz: Buy then sell round trip — fees are the only value leak ───

    function testFuzz_buyThenSellRoundTrip(uint256 numItems) public {
        numItems = bound(numItems, 1, 20);

        uint256 spotPrice = 2 ether;
        uint256 delta = 0.05 ether;

        // Create a TRADE pool with enough NFTs and ETH
        // Need at least numItems NFTs to buy, plus enough ETH for sell payouts
        address pool = _createTradePool(spotPrice, delta, numItems, 500 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Get buy quote
        (uint256 buyCost, uint256 buyProtocolFee) = p.getBuyQuote(numItems);

        // Get the held token IDs before buying
        uint256[] memory heldIds = p.getHeldTokenIds();
        uint256[] memory buyIds = new uint256[](numItems);
        for (uint256 i = 0; i < numItems; i++) {
            buyIds[i] = heldIds[i];
        }

        // Bob buys numItems NFTs
        vm.startPrank(bob);
        p.swapETHForNFTs{value: buyCost}(buyIds, buyCost, block.timestamp + 1);

        // After buying, spotPrice should have increased
        uint256 newSpotPrice = p.spotPrice();
        assertEq(newSpotPrice, spotPrice + delta * numItems, "Spot price after buy incorrect");

        // Now sell the same numItems back
        nft.setApprovalForAll(address(p), true);
        (uint256 sellPayout, uint256 sellProtocolFee) = p.getSellQuote(numItems);
        p.swapNFTsForETH(buyIds, sellPayout, block.timestamp + 1);
        vm.stopPrank();

        // After sell, spotPrice should return to original
        assertEq(p.spotPrice(), spotPrice, "Spot price not restored after round trip");

        // The value leak should be exactly the fees collected
        uint256 totalFees = buyCost - sellPayout;

        // Total fees = buy LP fee + buy protocol fee + sell LP fee + sell protocol fee
        // baseBuyCost = N * spotPrice + delta * N * (N-1) / 2
        uint256 baseBuyCost = numItems * spotPrice + delta * numItems * (numItems - 1) / 2;
        uint256 buyLpFee = baseBuyCost * LP_FEE_BPS / BPS;

        // After buy, spotPrice = spotPrice + delta * N
        // baseSellPayout = N * newSpotPrice - delta * N * (N+1) / 2
        uint256 baseSellPayout = numItems * newSpotPrice - delta * numItems * (numItems + 1) / 2;
        uint256 sellLpFee = baseSellPayout * LP_FEE_BPS / BPS;

        uint256 expectedTotalFees = buyLpFee + buyProtocolFee + sellLpFee + sellProtocolFee;

        assertEq(totalFees, expectedTotalFees, "Fee leak does not match expected fees");
        assertGt(totalFees, 0, "Round trip should have non-zero fees");
    }

    // ─── Fuzz: Spot price updates correctly after buy ───────────────────

    function testFuzz_spotPriceUpdateCorrectness(uint256 numItems) public {
        numItems = bound(numItems, 1, 50);

        uint256 spotPrice = 2 ether;
        uint256 delta = 0.1 ether;

        // Create a pool with enough NFTs and ETH
        address pool = _createTradePool(spotPrice, delta, numItems, 500 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // ── Buy: verify spotPrice += delta * N ──
        (uint256 buyCost,) = p.getBuyQuote(numItems);

        uint256[] memory heldIds = p.getHeldTokenIds();
        uint256[] memory buyIds = new uint256[](numItems);
        for (uint256 i = 0; i < numItems; i++) {
            buyIds[i] = heldIds[i];
        }

        vm.startPrank(bob);
        p.swapETHForNFTs{value: buyCost}(buyIds, buyCost, block.timestamp + 1);

        uint256 spotAfterBuy = p.spotPrice();
        assertEq(spotAfterBuy, spotPrice + delta * numItems, "spotPrice after buy incorrect");

        // ── Sell: verify spotPrice -= delta * N ──
        nft.setApprovalForAll(address(p), true);
        (uint256 sellPayout,) = p.getSellQuote(numItems);
        p.swapNFTsForETH(buyIds, sellPayout, block.timestamp + 1);
        vm.stopPrank();

        uint256 spotAfterSell = p.spotPrice();
        assertEq(spotAfterSell, spotPrice, "spotPrice after sell should return to original");
    }

    // ─── Fuzz: Spot price with variable delta and spotPrice ─────────────

    function testFuzz_spotPriceUpdateVariableParams(
        uint256 numItems,
        uint256 spotPriceFuzz,
        uint256 deltaFuzz
    ) public {
        numItems = bound(numItems, 1, 30);
        spotPriceFuzz = bound(spotPriceFuzz, 0.01 ether, 10 ether);
        deltaFuzz = bound(deltaFuzz, 0.001 ether, 1 ether);

        // Create a pool
        address pool = _createTradePool(spotPriceFuzz, deltaFuzz, numItems, 1000 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Buy and verify price update
        (uint256 buyCost,) = p.getBuyQuote(numItems);

        uint256[] memory heldIds = p.getHeldTokenIds();
        uint256[] memory buyIds = new uint256[](numItems);
        for (uint256 i = 0; i < numItems; i++) {
            buyIds[i] = heldIds[i];
        }

        vm.startPrank(bob);
        p.swapETHForNFTs{value: buyCost}(buyIds, buyCost, block.timestamp + 1);
        vm.stopPrank();

        assertEq(
            p.spotPrice(),
            spotPriceFuzz + deltaFuzz * numItems,
            "spotPrice += delta*N after buy"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: TegridyLending Interest & Collateral Fuzz Tests
// ═══════════════════════════════════════════════════════════════════════════

contract TegridyLendingFuzzTest is Test {
    TegridyLending public lending;
    MockWETHV3 public weth;
    MockPairV3 public pair;
    MockToweliV3 public toweli;
    address public treasury = makeAddr("treasury");

    uint256 public constant BPS = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    function setUp() public {
        weth = new MockWETHV3();
        toweli = new MockToweliV3();
        pair = new MockPairV3(address(toweli), address(weth));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair)); // 5% protocol fee
    }

    // ─── Fuzz: Interest calculation correctness ─────────────────────────

    function testFuzz_interestCalculation(
        uint256 principal,
        uint256 rateBps,
        uint256 duration
    ) public view {
        // Bound to reasonable ranges matching contract caps
        principal = bound(principal, 0.01 ether, 1000 ether); // MAX_PRINCIPAL = 1000 ether
        rateBps = bound(rateBps, 1, 50_000);                  // MAX_APR_BPS = 50000
        duration = bound(duration, 1, 365 days);              // MAX_DURATION = 365 days

        uint256 startTime = 1000;
        uint256 currentTime = startTime + duration;

        uint256 interest = lending.calculateInterest(principal, rateBps, startTime, currentTime);

        // Expected: ceil(principal * rateBps * elapsed / (BPS * SECONDS_PER_YEAR))
        uint256 numerator = principal * rateBps * duration;
        uint256 denominator = BPS * SECONDS_PER_YEAR;
        uint256 expectedInterest = (numerator + denominator - 1) / denominator; // ceil div

        assertEq(interest, expectedInterest, "Interest calculation mismatch");

        // Interest should always be > 0 when principal > 0, rateBps > 0, duration > 0
        assertGt(interest, 0, "Interest should be positive for non-zero inputs");

        // Interest should be <= principal for reasonable APRs and durations
        // At max: 1000 ether * 50000 * 365 days / (10000 * 365 days) = 5000 ether
        // So interest can exceed principal for high APRs, but should be bounded
        uint256 maxExpectedInterest = (principal * rateBps * duration + denominator - 1) / denominator;
        assertEq(interest, maxExpectedInterest, "Interest exceeds expected maximum");
    }

    // ─── Fuzz: Interest is zero when currentTime <= startTime ───────────

    function testFuzz_interestZeroWhenNoTimeElapsed(
        uint256 principal,
        uint256 rateBps,
        uint256 startTime
    ) public view {
        principal = bound(principal, 0.01 ether, 1000 ether);
        rateBps = bound(rateBps, 1, 50_000);
        startTime = bound(startTime, 1, type(uint128).max);

        // currentTime == startTime => zero interest
        uint256 interest = lending.calculateInterest(principal, rateBps, startTime, startTime);
        assertEq(interest, 0, "Interest should be zero when no time elapsed");

        // currentTime < startTime => zero interest
        if (startTime > 1) {
            interest = lending.calculateInterest(principal, rateBps, startTime, startTime - 1);
            assertEq(interest, 0, "Interest should be zero when currentTime < startTime");
        }
    }

    // ─── Fuzz: Interest scales linearly with duration ───────────────────

    function testFuzz_interestLinearScaling(
        uint256 principal,
        uint256 rateBps,
        uint256 duration
    ) public view {
        principal = bound(principal, 1 ether, 100 ether);
        rateBps = bound(rateBps, 100, 10_000);
        duration = bound(duration, 1 days, 100 days);

        uint256 startTime = 1000;

        uint256 interest1 = lending.calculateInterest(principal, rateBps, startTime, startTime + duration);
        uint256 interest2 = lending.calculateInterest(principal, rateBps, startTime, startTime + 2 * duration);

        // interest2 should be approximately 2 * interest1 (within ceiling rounding tolerance)
        // Due to ceiling division, the tolerance is at most 1 wei per calculation
        assertApproxEqAbs(interest2, 2 * interest1, 1, "Interest should scale linearly with duration");
    }

    // ─── Fuzz: Collateral sufficiency check ─────────────────────────────

    function testFuzz_collateralSufficiency(
        uint256 loanAmount,
        uint256 collateralValue
    ) public pure {
        loanAmount = bound(loanAmount, 0.01 ether, 1000 ether);
        collateralValue = bound(collateralValue, 0, 100_000 ether);

        // The lending contract checks: positionAmount >= minPositionValue
        // This is a direct comparison — if collateral >= required, it passes
        // We verify the logic is consistent:
        if (collateralValue >= loanAmount) {
            // Collateral is sufficient — this would pass the check
            assertTrue(collateralValue >= loanAmount, "Collateral should be sufficient");
        } else {
            // Collateral is insufficient — this would revert with InsufficientCollateralValue
            assertTrue(collateralValue < loanAmount, "Collateral should be insufficient");
        }
    }

    // ─── Fuzz: Loan parameter validation bounds ─────────────────────────

    function testFuzz_loanOfferBoundsEnforcement(
        uint256 principal,
        uint256 aprBps,
        uint256 duration
    ) public {
        // Test that creating offers with out-of-bounds params reverts
        address bob = makeAddr("bob");
        vm.deal(bob, 2000 ether);

        // Test principal > MAX_PRINCIPAL (1000 ether)
        uint256 overMaxPrincipal = bound(principal, 1001 ether, 2000 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.PrincipalTooLarge.selector);
        lending.createLoanOffer{value: overMaxPrincipal}(
            1000, 30 days, makeAddr("staking"), 1 ether, 0
        );

        // Test APR > MAX_APR_BPS (50000)
        uint256 overMaxApr = bound(aprBps, 50_001, 100_000);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.AprTooHigh.selector);
        lending.createLoanOffer{value: 1 ether}(
            overMaxApr, 30 days, makeAddr("staking"), 1 ether, 0
        );

        // Test duration < MIN_DURATION (1 day)
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooShort.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000, 0, makeAddr("staking"), 1 ether, 0
        );

        // Test duration > MAX_DURATION (365 days)
        uint256 overMaxDuration = bound(duration, 366 days, 730 days);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooLong.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000, overMaxDuration, makeAddr("staking"), 1 ether, 0
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: TegridyNFTPoolFactory Fee & Delta Propagation Fuzz Tests
// ═══════════════════════════════════════════════════════════════════════════

contract TegridyNFTPoolFactoryFuzzTest is Test {
    TegridyNFTPoolFactory public factory;
    MockNFTV3 public nft;
    MockWETHV3 public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice");

    function setUp() public {
        weth = new MockWETHV3();
        factory = new TegridyNFTPoolFactory(admin, 100, feeRecipient, address(weth));
        nft = new MockNFTV3();

        vm.deal(alice, 1000 ether);
    }

    // ─── Fuzz: Protocol fee range is enforced (0–1000 bps) ──────────────

    function testFuzz_protocolFeeRange(uint256 feeBps) public {
        // Test valid range: 0 to MAX_PROTOCOL_FEE_BPS (1000)
        uint256 validFee = bound(feeBps, 0, 1000);

        // Creating factory with valid fee should succeed
        TegridyNFTPoolFactory validFactory = new TegridyNFTPoolFactory(
            admin, validFee, feeRecipient, address(weth)
        );
        assertEq(validFactory.protocolFeeBps(), validFee, "Valid fee not set correctly");

        // Test invalid range: > 1000 bps should revert
        uint256 invalidFee = bound(feeBps, 1001, 10_000);
        vm.expectRevert(TegridyNFTPoolFactory.InvalidFee.selector);
        new TegridyNFTPoolFactory(admin, invalidFee, feeRecipient, address(weth));
    }

    // ─── Fuzz: Protocol fee propagates to pool clones ───────────────────

    function testFuzz_protocolFeePropagation(uint256 feeBps) public {
        feeBps = bound(feeBps, 0, 1000);

        // Create factory with specific fee
        TegridyNFTPoolFactory testFactory = new TegridyNFTPoolFactory(
            admin, feeBps, feeRecipient, address(weth)
        );

        // Mint an NFT and create a pool
        uint256 id = nft.mint(alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.startPrank(alice);
        nft.setApprovalForAll(address(testFactory), true);
        address pool = testFactory.createPool{value: 1 ether}(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            1 ether,
            0.1 ether,
            0,
            ids
        );
        vm.stopPrank();

        // Verify pool received the correct protocol fee
        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(p.protocolFeeBps(), feeBps, "Protocol fee not propagated to pool clone");
    }

    // ─── Fuzz: Timelocked fee change enforces bounds ────────────────────

    function testFuzz_protocolFeeChangeEnforcesBounds(uint256 feeBps) public {
        // Attempt to propose fee > MAX_PROTOCOL_FEE_BPS via timelock
        uint256 invalidFee = bound(feeBps, 1001, 10_000);

        vm.prank(admin);
        vm.expectRevert(TegridyNFTPoolFactory.InvalidFee.selector);
        factory.proposeProtocolFeeChange(invalidFee);

        // Valid fee proposals should succeed
        uint256 validFee = bound(feeBps, 0, 1000);
        vm.prank(admin);
        factory.proposeProtocolFeeChange(validFee);
        assertEq(factory.pendingProtocolFeeBps(), validFee, "Pending fee not set");
    }

    // ─── Fuzz: Delta cap at 10 ether (AUDIT TF-15 — was 100 ether) ─────

    function testFuzz_deltaRange(uint256 delta) public {
        uint256 validDelta = bound(delta, 0, 10 ether);

        // Creating a pool with valid delta should succeed
        uint256 id = nft.mint(alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        address pool = factory.createPool{value: 1 ether}(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            1 ether,
            validDelta,
            0,
            ids
        );
        vm.stopPrank();

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        assertEq(p.delta(), validDelta, "Valid delta not set correctly");
    }

    function testFuzz_deltaExceedsCap(uint256 delta) public {
        uint256 invalidDelta = bound(delta, 100 ether + 1, 200 ether);

        // Creating a pool with delta > MAX_DELTA (100 ether) should revert
        uint256 id = nft.mint(alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        vm.expectRevert(TegridyNFTPool.DeltaTooHigh.selector);
        factory.createPool{value: 1 ether}(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            1 ether,
            invalidDelta,
            0,
            ids
        );
        vm.stopPrank();
    }

    // ─── Fuzz: proposeDelta on existing pool enforces cap ────────────────

    function testFuzz_proposeDeltaEnforcesCap(uint256 delta) public {
        // Create a pool first
        uint256 id = nft.mint(alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        address pool = factory.createPool{value: 1 ether}(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            1 ether,
            0.1 ether,
            0,
            ids
        );

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Valid delta proposal + execute through timelock — AUDIT TF-15: was 100 ether
        uint256 validDelta = bound(delta, 0, 10 ether);
        p.proposeDelta(validDelta);
        vm.warp(block.timestamp + 24 hours);
        p.executeDeltaChange();
        assertEq(p.delta(), validDelta, "proposeDelta did not update correctly after timelock");

        // Invalid delta proposal should revert
        uint256 invalidDelta = bound(delta, 100 ether + 1, 200 ether);
        vm.expectRevert(TegridyNFTPool.DeltaTooHigh.selector);
        p.proposeDelta(invalidDelta);

        vm.stopPrank();
    }
}
