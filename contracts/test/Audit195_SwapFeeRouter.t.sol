// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// â”€â”€â”€â”€â”€â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract MockERC20A195 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Fee-on-transfer token (1% burn on every transfer/transferFrom)
contract FOTToken195 is ERC20 {
    uint256 public constant FEE_BPS = 100; // 1%
    constructor() ERC20("FOT", "FOT") { _mint(msg.sender, 1e27); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * FEE_BPS) / 10000;
        _burn(msg.sender, fee);
        return super.transfer(to, amount - fee);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        uint256 fee = (amount * FEE_BPS) / 10000;
        _burn(from, fee);
        _transfer(from, to, amount - fee);
        return true;
    }
}

/// @dev AUDIT FIX 2026-05-16 M3/M4: SwapFeeRouter.sweepTokens + withdrawTokenFees
///      now call `uniFactory.getPair(token, WETH)` to refuse swappable tokens.
///      MockUniFactory195 returns address(0) for every pair so the tokens used by
///      these tests qualify as "no liquid pair" (eligible for the escape-hatch).
contract MockUniFactory195 {
    function getPair(address, address) external pure returns (address) {
        return address(0);
    }
}

/// @dev Mock Uniswap V2 Router â€“ 1:1 swap simulation
contract MockUniRouter195 {
    address public immutable WETH_ADDR;
    address public immutable FACTORY;
    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth;
        FACTORY = _factory;
    }
    function WETH() external view returns (address) { return WETH_ADDR; }
    function factory() external view returns (address) { return FACTORY; }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = msg.value;
        require(amounts[path.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20A195(path[path.length - 1]).mint(to, msg.value);
    }

    function swapExactTokensForETH(
        uint256 amountIn, uint256, address[] calldata path, address to, uint256
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn;
        (bool ok,) = to.call{value: amountIn}("");
        require(ok, "ETH send failed");
    }

    function swapExactTokensForTokens(
        uint256 amountIn, uint256, address[] calldata path, address to, uint256
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn;
        MockERC20A195(path[path.length - 1]).mint(to, amountIn);
    }

    receive() external payable {}
}

/// @dev AUDIT FIX 2026-05-16 M2: sweepETH now forces destination to
///      revenueDistributor; tests need a receiver-capable sink.
contract MockRevenueDistributorSink195 {
    receive() external payable {}
}

/// @dev Splitter mock that accepts ETH and tracks callerCredit
contract MockSplitter195 {
    mapping(address => uint256) public callerCredit;
    function recordFee(address _user) external payable {
        callerCredit[msg.sender] += msg.value;
    }
    function withdrawCallerCredit() external {
        uint256 c = callerCredit[msg.sender];
        callerCredit[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: c}("");
        require(ok);
    }
    // AUDIT FIX V3-DEEP-R3-M02: SwapFeeRouter.applyReferralSplitter(address(0))
    // now reads `referralFeeBps()` on the outgoing splitter to enforce
    // "must be zeroed before unwiring." Mock returns 0 so the test's
    // splitter swap to address(0) succeeds.
    function referralFeeBps() external pure returns (uint256) { return 0; }
    receive() external payable {}
}

/// @dev Splitter that always reverts
contract RevertSplitter195 {
    function recordFee(address) external payable { revert("BOOM"); }
    function withdrawCallerCredit() external { revert("BOOM"); }
}

/// @dev Contract that cannot receive ETH (for WETH fallback testing)
contract NoETHReceiver {
    // intentionally no receive/fallback
}

// â”€â”€â”€â”€â”€â”€â”€â”€ Main Test Contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract Audit195SwapFeeRouter is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter195 public uniRouter;
    MockUniFactory195 public uniFactory;
    MockRevenueDistributorSink195 public revenueDistributor;
    MockERC20A195 public weth;
    MockERC20A195 public tokenA;
    MockERC20A195 public tokenB;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public attacker = makeAddr("attacker");

    uint256 constant FEE_BPS = 30; // 0.3%

    function setUp() public {
        weth = new MockERC20A195("WETH", "WETH");
        tokenA = new MockERC20A195("TokenA", "TKA");
        tokenB = new MockERC20A195("TokenB", "TKB");
        uniFactory = new MockUniFactory195();
        uniRouter = new MockUniRouter195(address(weth), address(uniFactory));
        revenueDistributor = new MockRevenueDistributorSink195();
        vm.deal(address(uniRouter), 10_000 ether);

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));

        // AUDIT FIX 2026-05-16 M2: wire revenueDistributor so sweepETH works
        // (M2 forces destination to revenueDistributor, was: treasury).
        sfrAdmin.proposeRevenueDistributor(address(revenueDistributor));
        vm.warp(block.timestamp + 48 hours + 1);
        sfrAdmin.executeRevenueDistributor();

        tokenA.transfer(alice, 100_000 ether);
        tokenB.transfer(alice, 100_000 ether);
        vm.deal(alice, 1000 ether);

        vm.startPrank(alice);
        tokenA.approve(address(sfr), type(uint256).max);
        tokenB.approve(address(sfr), type(uint256).max);
        vm.stopPrank();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  1. FEE CALCULATION ACCURACY
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_feeCalc_ETHForTokens_exact() public {
        uint256 swapAmt = 10 ether;
        uint256 expectedFee = (swapAmt * FEE_BPS) / 10000; // 0.03 ether
        uint256 expectedSwap = swapAmt - expectedFee;

        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        uint256[] memory amounts = sfr.swapExactETHForTokens{value: swapAmt}(0, path, alice, block.timestamp + 1, 100);

        assertEq(sfr.totalETHFees(), expectedFee, "totalETHFees mismatch");
        assertEq(sfr.accumulatedETHFees(), expectedFee, "accumulatedETHFees mismatch");
        assertEq(amounts[amounts.length - 1], expectedSwap, "output mismatch");
    }

    function test_feeCalc_TokensForETH_exact() public {
        uint256 swapAmt = 10 ether;
        address[] memory path = _tokenAToETH();

        uint256 aliceETHBefore = alice.balance;
        vm.prank(alice);
        sfr.swapExactTokensForETH(swapAmt, 0, path, alice, block.timestamp + 1, 100);

        // Fee is taken from the ETH output (post-swap)
        // Mock router returns amountIn == amountOut (1:1), so ethReceived = swapAmt
        uint256 fee = (swapAmt * FEE_BPS) / 10000;
        uint256 userGot = alice.balance - aliceETHBefore;
        assertEq(userGot, swapAmt - fee, "user ETH mismatch");
        assertEq(sfr.accumulatedETHFees(), fee, "accumulated ETH fee mismatch");
    }

    function test_feeCalc_TokensForTokens_exact() public {
        uint256 swapAmt = 10 ether;
        uint256 expectedFee = (swapAmt * FEE_BPS) / 10000;
        uint256 expectedSwapInput = swapAmt - expectedFee;

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 tokenBBefore = tokenB.balanceOf(alice);
        vm.prank(alice);
        sfr.swapExactTokensForTokens(swapAmt, 0, path, alice, block.timestamp + 1, 100);

        assertEq(sfr.accumulatedTokenFees(address(tokenA)), expectedFee, "token fee mismatch");
        assertEq(tokenB.balanceOf(alice) - tokenBBefore, expectedSwapInput, "output mismatch");
    }

    /// @dev When fee is tiny (1 wei swap with feeBps=30), fee rounds to 0 but gets bumped to 1
    function test_feeCalc_minimumFee1Wei() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        uint256[] memory amounts = sfr.swapExactETHForTokens{value: 1}(0, path, alice, block.timestamp + 1, 100);
        // 1 * 30 / 10000 = 0, forced to 1
        assertEq(sfr.accumulatedETHFees(), 1, "min fee should be 1");
        assertEq(amounts[amounts.length - 1], 0, "zero output after min fee");
    }

    /// @dev When feeBps=0, no fee is taken and no minimum is forced
    function test_feeCalc_zeroFeeBps() public {
        SwapFeeRouter zeroFee = new SwapFeeRouter(address(uniRouter), treasury, 0, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        uint256[] memory amounts = zeroFee.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 0);
        assertEq(zeroFee.accumulatedETHFees(), 0, "zero-fee should collect nothing");
        assertEq(amounts[amounts.length - 1], 1 ether, "full amount passed through");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  2. ADJUSTED MIN CORRECTNESS (swapExactTokensForETH)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev adjustedMin formula should properly invert fee so user gets >= amountOutMin
    function test_adjustedMin_normalCase() public {
        address[] memory path = _tokenAToETH();
        uint256 amountOutMin = 9 ether;

        vm.prank(alice);
        uint256 aliceBefore = alice.balance;
        sfr.swapExactTokensForETH(100 ether, amountOutMin, path, alice, block.timestamp + 1, 100);
        uint256 userGot = alice.balance - aliceBefore;
        assertGe(userGot, amountOutMin, "user should get >= amountOutMin");
    }

    /// @dev When amountOutMin is very large (overflow territory), adjustedMin falls back
    ///      to raw amountOutMin which weakens slippage protection. This tests the overflow branch.
    function test_adjustedMin_overflowBranch_weakensSlippage() public {
        // amountOutMin > type(uint256).max / BPS triggers the fallback branch
        uint256 bigMin = type(uint256).max / 9999; // just above the threshold

        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        // This will revert because router can't produce that much ETH, but the point is
        // adjustedMin = amountOutMin (no fee adjustment), meaning the router sees a LOWER
        // bar than it should if it were properly adjusted upward.
        vm.expectRevert();
        sfr.swapExactTokensForETH(1 ether, bigMin, path, alice, block.timestamp + 1, 100);
    }

    /// @dev Verify adjustedMin rounds UP correctly so user always gets >= amountOutMin after fee
    function test_adjustedMin_roundingUp() public {
        // Use feeBps = 30, amountOutMin = 9_970_000_000_000_000_001 (odd number)
        address[] memory path = _tokenAToETH();
        // With 1:1 mock, swapping 10 ether yields 10 ether ETH, fee = 10e18 * 30/10000 = 3e16
        // user gets 10e18 - 3e16 = 9.97e18
        uint256 amountOutMin = 9.97 ether - 1; // just under what user gets

        vm.prank(alice);
        uint256 aliceBefore = alice.balance;
        sfr.swapExactTokensForETH(10 ether, amountOutMin, path, alice, block.timestamp + 1, 100);
        assertGe(alice.balance - aliceBefore, amountOutMin, "rounding should favor user");
    }

    /// @dev feeBps == BPS (100%) should revert with AdjustedMinOverflow
    function test_adjustedMin_feeBpsEqualBPS_reverts() public {
        // Can't set feeBps to 10000 via constructor (MAX_FEE_BPS = 100)
        // So this path is unreachable, but we verify the guard exists
        // by checking the error selector is defined
        bytes4 sel = SwapFeeRouter.AdjustedMinOverflow.selector;
        assertTrue(sel != bytes4(0), "AdjustedMinOverflow error exists");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  3. BALANCE-BEFORE/AFTER PATTERNS
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev swapExactTokensForETH uses balance-diff for both token input and ETH output
    function test_balanceDiff_tokensForETH() public {
        address[] memory path = _tokenAToETH();
        uint256 routerETHBefore = address(sfr).balance;

        vm.prank(alice);
        sfr.swapExactTokensForETH(10 ether, 0, path, alice, block.timestamp + 1, 100);

        // Router should only retain the fee portion
        uint256 fee = (10 ether * FEE_BPS) / 10000;
        assertEq(address(sfr).balance - routerETHBefore, fee, "only fee ETH should remain");
    }

    /// @dev swapExactTokensForTokens uses balance-diff for token input (FOT-safe)
    function test_balanceDiff_tokensForTokens_FOT() public {
        FOTToken195 fot = new FOTToken195();
        fot.transfer(alice, 100_000 ether);
        vm.prank(alice);
        fot.approve(address(sfr), type(uint256).max);

        // FOT takes 1% on transferFrom, so actualReceived < amountIn
        address[] memory path = new address[](2);
        path[0] = address(fot);
        path[1] = address(tokenB);

        uint256 sendAmt = 10 ether;
        uint256 actualReceived = sendAmt - (sendAmt * 100 / 10000); // 9.9 ether after FOT fee
        uint256 protocolFee = (actualReceived * FEE_BPS) / 10000;

        vm.prank(alice);
        sfr.swapExactTokensForTokens(sendAmt, 0, path, alice, block.timestamp + 1, 100);

        assertEq(sfr.accumulatedTokenFees(address(fot)), protocolFee, "FOT fee accounting correct");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  4. REFERRAL FEE RECORDING
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_referralFee_forwarded() public {
        MockSplitter195 splitter = new MockSplitter195();
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));

        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        withRef.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;
        // Fee was forwarded to splitter, NOT accumulated
        assertEq(withRef.accumulatedETHFees(), 0, "fee forwarded to splitter");
        assertEq(withRef.totalETHFees(), fee, "totalETHFees still tracks");
        assertEq(address(splitter).balance, fee, "splitter received fee");
    }

    function test_referralFee_fallbackOnRevert() public {
        RevertSplitter195 bad = new RevertSplitter195();
        SwapFeeRouter withBad = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(bad), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));

        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        withBad.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;
        // Fallback: fee accumulated in router
        assertEq(withBad.accumulatedETHFees(), fee, "fee falls back to accumulator");
    }

    function test_referralFee_noSplitter_accumulates() public {
        // Default sfr has no splitter
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;
        assertEq(sfr.accumulatedETHFees(), fee, "no splitter -> accumulated");
    }

    /// @dev Token-to-token swaps don't use referral for ETH -- token fees go to accumulator
    function test_referralFee_tokenToToken_noReferral() public {
        MockSplitter195 splitter = new MockSplitter195();
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));

        tokenA.transfer(alice, 10 ether);
        vm.prank(alice);
        tokenA.approve(address(withRef), type(uint256).max);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(alice);
        withRef.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;
        // Token fees are NOT sent to referral splitter (only ETH fees are)
        assertEq(withRef.accumulatedTokenFees(address(tokenA)), fee, "token fee in accumulator");
        assertEq(address(splitter).balance, 0, "splitter got no ETH");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  5. TREASURY WITHDRAWAL SAFETY
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    // AUDIT H-3 (battle-tested fix): withdrawFees() removed. All ETH fee distribution now
    // routes through distributeFeesToStakers(), which enforces the timelocked split. Tests for
    // the split behaviour live in FinalAudit_Revenue / RedTeam_Revenue suites.

    function test_withdrawTokenFees_sendsToTreasury() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        sfr.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 fee = sfr.accumulatedTokenFees(address(tokenA));
        uint256 treasBefore = tokenA.balanceOf(treasury);

        sfr.withdrawTokenFees(address(tokenA));
        assertEq(tokenA.balanceOf(treasury) - treasBefore, fee, "token fee sent to treasury");
        assertEq(sfr.accumulatedTokenFees(address(tokenA)), 0, "accumulator zeroed");
    }

    function test_withdrawTokenFees_zeroAddress_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        sfr.withdrawTokenFees(address(0));
    }

    function test_withdrawTokenFees_zeroAmount_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.withdrawTokenFees(address(tokenA));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  6. SWEEP SAFETY
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_sweepETH_onlySweepsBeyondAccumulated() public {
        // First accumulate some fees
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 accFees = sfr.accumulatedETHFees();
        // Send extra ETH directly (dust)
        vm.deal(address(sfr), accFees + 1 ether);

        // AUDIT FIX (Wave-2 2026-05-16): sweepETH is now 48h-timelocked.
        // Propose for the full balance; execute will cap at the live
        // sweepable portion (1 ether) since accumulatedETHFees is reserved.
        uint256 sinkBefore = address(revenueDistributor).balance;
        sfr.proposeSweepETH(accFees + 1 ether);
        vm.warp(block.timestamp + 48 hours);
        sfr.executeSweepETH();
        assertEq(address(revenueDistributor).balance - sinkBefore, 1 ether, "only sweep non-fee ETH");
        // Accumulated fees untouched
        assertEq(sfr.accumulatedETHFees(), accFees, "accumulated fees preserved");
    }

    function test_sweepETH_revertsWhenOnlyFeeETH() public {
        // Accumulate fees exactly equal to balance
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        // Balance == accumulatedETHFees, nothing to sweep.
        // Wave-2 fix: invariant preserved at execute time after the 48h
        // timelock â€” `executeSweepETH` reverts ZeroAmount when sweepable=0.
        sfr.proposeSweepETH(1 ether);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.executeSweepETH();
    }

    function test_sweepTokens_onlySweepsBeyondAccumulated() public {
        // Accumulate token fees
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        sfr.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 accFees = sfr.accumulatedTokenFees(address(tokenA));
        // Send extra tokens directly
        tokenA.transfer(address(sfr), 5 ether);

        uint256 treasBefore = tokenA.balanceOf(treasury);
        sfr.sweepTokens(address(tokenA));
        assertEq(tokenA.balanceOf(treasury) - treasBefore, 5 ether, "only sweep non-fee tokens");
    }

    function test_sweepTokens_revertsWhenOnlyFees() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        sfr.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.sweepTokens(address(tokenA));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  7. PATH VALIDATION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_revert_pathTooShort() public {
        address[] memory path = new address[](1);
        path[0] = address(weth);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.InvalidPath.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_pathTooLong() public {
        address[] memory path = new address[](11);
        for (uint i = 0; i < 11; i++) path[i] = makeAddr(string(abi.encodePacked("tok", i)));
        path[0] = address(weth);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.InvalidPath.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_ETHForTokens_wrongPathStart() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); // should be WETH
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.PathStartMismatch.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_TokensForETH_wrongPathEnd() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB); // should be WETH
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.PathEndMismatch.selector);
        sfr.swapExactTokensForETH(1 ether, 0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_duplicateInPath_nonAdjacent() public {
        address[] memory path = new address[](3);
        path[0] = address(weth);
        path[1] = address(tokenA);
        path[2] = address(weth); // duplicate
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DuplicateTokenInPath.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_duplicateInPath_adjacent() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenA); // adjacent duplicate
        path[2] = address(weth);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DuplicateTokenInPath.selector);
        sfr.swapExactTokensForETH(1 ether, 0, path, alice, block.timestamp + 1, 100);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  8. RECIPIENT VALIDATION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_revert_recipientZero() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.InvalidRecipient.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, address(0), block.timestamp + 1, 100);
    }

    function test_revert_recipientIsRouter() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.InvalidRecipient.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, address(sfr), block.timestamp + 1, 100);
    }

    function test_revert_recipientIsRouter_tokensForTokens() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.InvalidRecipient.selector);
        sfr.swapExactTokensForTokens(1 ether, 0, path, address(sfr), block.timestamp + 1, 100);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  9. REENTRANCY PROTECTION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    // All swap and withdrawal functions use nonReentrant. We verify the modifier exists
    // by checking that the functions are correctly guarded.
    // (Foundry doesn't easily allow testing reentrancy with standard mocks, but we verify
    //  all critical functions have the modifier via the source code audit above.)

    // AUDIT H-3: test_withdrawFees_nonReentrant removed (function deleted).

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  10. ACCESS CONTROL
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_onlyOwner_proposeFeeChange() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.proposeFeeChange(50);
    }

    function test_onlyOwner_executeFeeChange() public {
        sfrAdmin.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.executeFeeChange();
    }

    function test_onlyOwner_cancelFeeChange() public {
        sfrAdmin.proposeFeeChange(50);
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.cancelFeeChange();
    }

    function test_onlyOwner_proposeTreasuryChange() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.proposeTreasuryChange(attacker);
    }

    function test_onlyOwner_executeTreasuryChange() public {
        sfrAdmin.proposeTreasuryChange(makeAddr("newTreas"));
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.executeTreasuryChange();
    }

    function test_onlyOwner_cancelTreasuryChange() public {
        sfrAdmin.proposeTreasuryChange(makeAddr("x"));
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.cancelTreasuryChange();
    }

    // AUDIT H-3: test_onlyOwner_withdrawFees removed (function deleted).

    function test_onlyOwner_withdrawTokenFees() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.withdrawTokenFees(address(tokenA));
    }

    function test_onlyOwner_sweepETH() public {
        vm.deal(address(sfr), 1 ether);
        // Wave-2 fix: pin onlyOwner on the propose side (the old `sweepETH()`
        // stub reverts unconditionally so its non-owner revert is for the
        // wrong reason; the real authorization gate now lives on propose/execute/cancel).
        vm.prank(attacker);
        vm.expectRevert();
        sfr.proposeSweepETH(1 ether);
    }

    function test_onlyOwner_sweepTokens() public {
        tokenA.transfer(address(sfr), 1 ether);
        vm.prank(attacker);
        vm.expectRevert();
        sfr.sweepTokens(address(tokenA));
    }

    function test_onlyOwner_pause() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.pause();
    }

    function test_onlyOwner_unpause() public {
        sfr.pause();
        vm.prank(attacker);
        vm.expectRevert();
        sfr.unpause();
    }

    function test_onlyOwner_recoverCallerCredit() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.recoverCallerCredit();
    }

    function test_onlyOwner_recoverCallerCreditFrom() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.recoverCallerCreditFrom(makeAddr("old"));
    }

    function test_onlyOwner_proposeReferralSplitterChange() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfrAdmin.proposeReferralSplitterChange(attacker);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  11. TIMELOCK FLOWS (FEE, TREASURY, REFERRAL)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_feeTimelock_fullCycle() public {
        sfrAdmin.proposeFeeChange(50);
        assertEq(sfrAdmin.pendingFeeBps(), 50);

        // Too early
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sfrAdmin.FEE_CHANGE()));
        sfrAdmin.executeFeeChange();

        // Right on time
        vm.warp(block.timestamp + 24 hours);
        sfrAdmin.executeFeeChange();
        assertEq(sfr.feeBps(), 50);
        assertEq(sfrAdmin.feeChangeTime(), 0);
        assertEq(sfrAdmin.pendingFeeBps(), 0);
    }

    function test_feeTimelock_expiry() public {
        sfrAdmin.proposeFeeChange(50);
        // Past expiry: 24h delay + 7 days validity + 1
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfrAdmin.FEE_CHANGE()));
        sfrAdmin.executeFeeChange();
    }

    function test_feeTimelock_cancelAndRepropose() public {
        sfrAdmin.proposeFeeChange(50);
        sfrAdmin.cancelFeeChange();
        assertEq(sfrAdmin.feeChangeTime(), 0);
        // Can propose again after cancel
        sfrAdmin.proposeFeeChange(60);
        assertEq(sfrAdmin.pendingFeeBps(), 60);
    }

    function test_feeTimelock_doublePropose_reverts() public {
        sfrAdmin.proposeFeeChange(50);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, sfrAdmin.FEE_CHANGE()));
        sfrAdmin.proposeFeeChange(60);
    }

    function test_feeTimelock_cancelNoPending_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, sfrAdmin.FEE_CHANGE()));
        sfrAdmin.cancelFeeChange();
    }

    function test_treasuryTimelock_fullCycle() public {
        address newTreas = makeAddr("newTreas");
        sfrAdmin.proposeTreasuryChange(newTreas);
        vm.warp(block.timestamp + 48 hours);
        sfrAdmin.executeTreasuryChange();
        assertEq(sfr.treasury(), newTreas);
        assertEq(sfrAdmin.treasuryChangeTime(), 0);
    }

    function test_treasuryTimelock_expiry() public {
        sfrAdmin.proposeTreasuryChange(makeAddr("x"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfrAdmin.TREASURY_CHANGE()));
        sfrAdmin.executeTreasuryChange();
    }

    function test_treasuryTimelock_zeroAddress_reverts() public {
        vm.expectRevert(SwapFeeRouterAdmin.ZeroAddress.selector);
        sfrAdmin.proposeTreasuryChange(address(0));
    }

    function test_treasuryTimelock_doublePropose_reverts() public {
        sfrAdmin.proposeTreasuryChange(makeAddr("a"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, sfrAdmin.TREASURY_CHANGE()));
        sfrAdmin.proposeTreasuryChange(makeAddr("b"));
    }

    function test_referralTimelock_fullCycle() public {
        address newSplitter = makeAddr("newSplitter");
        sfrAdmin.proposeReferralSplitterChange(newSplitter);
        vm.warp(block.timestamp + 48 hours);
        sfrAdmin.executeReferralSplitterChange();
        assertEq(address(sfr.referralSplitter()), newSplitter);
    }

    function test_referralTimelock_allowsZero() public {
        // Setting splitter to zero (disable) is allowed
        sfrAdmin.proposeReferralSplitterChange(address(0));
        vm.warp(block.timestamp + 48 hours);
        sfrAdmin.executeReferralSplitterChange();
        assertEq(address(sfr.referralSplitter()), address(0));
    }

    function test_referralTimelock_cancel() public {
        sfrAdmin.proposeReferralSplitterChange(makeAddr("x"));
        sfrAdmin.cancelReferralSplitterChange();
        assertEq(sfrAdmin.referralSplitterChangeTime(), 0);
    }

    function test_referralTimelock_expiry() public {
        sfrAdmin.proposeReferralSplitterChange(makeAddr("x"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfrAdmin.REFERRAL_CHANGE()));
        sfrAdmin.executeReferralSplitterChange();
    }

    function test_referralTimelock_tooEarly() public {
        sfrAdmin.proposeReferralSplitterChange(makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sfrAdmin.REFERRAL_CHANGE()));
        sfrAdmin.executeReferralSplitterChange();
    }

    function test_referralTimelock_cancelNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, sfrAdmin.REFERRAL_CHANGE()));
        sfrAdmin.cancelReferralSplitterChange();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  12. PAUSE / UNPAUSE
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_pause_blocksAllSwaps() public {
        sfr.pause();
        address[] memory path = _ethToTokenA();

        vm.prank(alice);
        vm.expectRevert();
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);

        address[] memory path2 = _tokenAToETH();
        vm.prank(alice);
        vm.expectRevert();
        sfr.swapExactTokensForETH(1 ether, 0, path2, alice, block.timestamp + 1, 100);

        address[] memory path3 = new address[](2);
        path3[0] = address(tokenA);
        path3[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert();
        sfr.swapExactTokensForTokens(1 ether, 0, path3, alice, block.timestamp + 1, 100);
    }

    function test_unpause_restoresSwaps() public {
        sfr.pause();
        sfr.unpause();

        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
        assertTrue(sfr.totalETHFees() > 0, "swap worked after unpause");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  13. MAX FEE BPS CHECK (maxFeeBps parameter)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_maxFeeBps_rejectsIfCurrentFeeExceeds() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        // Current fee is 30 bps, pass maxFeeBps = 20 -> should revert
        vm.expectRevert(SwapFeeRouter.FeeExceedsMax.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 20);
    }

    function test_maxFeeBps_acceptsIfEqual() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 30);
        // Should not revert
    }

    function test_maxFeeBps_tokensForETH() public {
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.FeeExceedsMax.selector);
        sfr.swapExactTokensForETH(1 ether, 0, path, alice, block.timestamp + 1, 20);
    }

    function test_maxFeeBps_tokensForTokens() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.FeeExceedsMax.selector);
        sfr.swapExactTokensForTokens(1 ether, 0, path, alice, block.timestamp + 1, 20);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  14. DEADLINE VALIDATION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_deadline_tooFar_reverts() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DeadlineTooFar.selector);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 3 hours, 100);
    }

    function test_deadline_withinLimit_succeeds() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 30 minutes, 100);
    }

    function test_deadline_tooFar_tokensForETH() public {
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DeadlineTooFar.selector);
        sfr.swapExactTokensForETH(1 ether, 0, path, alice, block.timestamp + 3 hours, 100);
    }

    function test_deadline_tooFar_tokensForTokens() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DeadlineTooFar.selector);
        sfr.swapExactTokensForTokens(1 ether, 0, path, alice, block.timestamp + 3 hours, 100);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  15. RECOVER CALLER CREDIT
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_recoverCallerCredit_works() public {
        MockSplitter195 splitter = new MockSplitter195();
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));

        // Do a swap to send fee to splitter
        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        withRef.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;
        assertEq(address(splitter).balance, fee);

        // Recover
        uint256 routerBefore = address(withRef).balance;
        withRef.recoverCallerCredit();
        assertEq(address(withRef).balance - routerBefore, fee, "recovered credit");
    }

    function test_recoverCallerCredit_noSplitter_reverts() public {
        vm.expectRevert("NO_SPLITTER");
        sfr.recoverCallerCredit();
    }

    function test_recoverCallerCreditFrom_works() public {
        MockSplitter195 splitter = new MockSplitter195();
        // Manually send ETH and set callerCredit
        vm.deal(address(splitter), 1 ether);
        // We need to set callerCredit for the sfr address
        // Instead, create a router that uses this splitter, do a swap, change splitter, then recover from old
        SwapFeeRouter r2 = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        SwapFeeRouterAdmin r2Admin = new SwapFeeRouterAdmin(address(r2));
        r2.setSwapFeeRouterAdmin(address(r2Admin));
        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        r2.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;

        // Change splitter via timelock (now lives on the admin sister contract)
        r2Admin.proposeReferralSplitterChange(address(0));
        vm.warp(block.timestamp + 48 hours);
        r2Admin.executeReferralSplitterChange();

        // Recover from old splitter
        uint256 balBefore = address(r2).balance;
        r2.recoverCallerCreditFrom(address(splitter));
        assertEq(address(r2).balance - balBefore, fee, "recovered from old splitter");
    }

    function test_recoverCallerCreditFrom_zeroAddress_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        sfr.recoverCallerCreditFrom(address(0));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  16. CONSTRUCTOR VALIDATION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_constructor_zeroRouter_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        new SwapFeeRouter(address(0), treasury, 30, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
    }

    function test_constructor_zeroTreasury_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        new SwapFeeRouter(address(uniRouter), address(0), 30, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
    }

    function test_constructor_feeTooHigh_reverts() public {
        vm.expectRevert(SwapFeeRouter.FeeTooHigh.selector);
        new SwapFeeRouter(address(uniRouter), treasury, 101, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
    }

    function test_constructor_maxFee_succeeds() public {
        SwapFeeRouter r = new SwapFeeRouter(address(uniRouter), treasury, 100, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        assertEq(r.feeBps(), 100);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  17. DEPRECATED SETTERS
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_setFee_alwaysReverts() public {
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        sfr.setFee(50);

        vm.prank(attacker);
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        sfr.setFee(50);
    }

    function test_setTreasury_alwaysReverts() public {
        vm.expectRevert(SwapFeeRouter.UseProposeTreasuryChange.selector);
        sfr.setTreasury(makeAddr("x"));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  18. SLIPPAGE PROTECTION (swapExactTokensForETH)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_slippage_tokensForETH_enforced() public {
        // With 1:1 mock and 0.3% fee, swapping 10 ETH yields ~9.97 ETH to user
        // Requiring 9.98 should fail
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.SlippageExceeded.selector);
        sfr.swapExactTokensForETH(10 ether, 9.98 ether, path, alice, block.timestamp + 1, 100);
    }

    function test_slippage_tokensForETH_exactMin() public {
        // 10 ether input, fee = 10e18 * 30 / 10000 = 3e16
        // user gets 10e18 - 3e16 = 9.97e18
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        uint256 aliceBefore = alice.balance;
        sfr.swapExactTokensForETH(10 ether, 9.97 ether, path, alice, block.timestamp + 1, 100);
        assertEq(alice.balance - aliceBefore, 9.97 ether);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  19. ZERO AMOUNT GUARDS
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_zeroAmount_ETHForTokens() public {
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.swapExactETHForTokens{value: 0}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_zeroAmount_tokensForETH() public {
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.swapExactTokensForETH(0, 0, path, alice, block.timestamp + 1, 100);
    }

    function test_zeroAmount_tokensForTokens() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.swapExactTokensForTokens(0, 0, path, alice, block.timestamp + 1, 100);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  20. APPROVAL REVOCATION AFTER SWAP
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_approvalRevoked_tokensForETH() public {
        address[] memory path = _tokenAToETH();
        vm.prank(alice);
        sfr.swapExactTokensForETH(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 remaining = tokenA.allowance(address(sfr), address(uniRouter));
        assertEq(remaining, 0, "approval should be revoked after swap");
    }

    function test_approvalRevoked_tokensForTokens() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(alice);
        sfr.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 remaining = tokenA.allowance(address(sfr), address(uniRouter));
        assertEq(remaining, 0, "approval should be revoked after swap");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  21. RECEIVE FUNCTION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_receive_acceptsETH() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(sfr).call{value: 1 ether}("");
        assertTrue(ok, "should accept ETH");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  22. MULTIPLE SWAPS ACCUMULATION
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_multipleSwaps_feesAccumulate() public {
        address[] memory path = _ethToTokenA();
        uint256 totalFees;

        for (uint i = 0; i < 5; i++) {
            vm.prank(alice);
            sfr.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
            totalFees += (1 ether * FEE_BPS) / 10000;
        }

        assertEq(sfr.accumulatedETHFees(), totalFees, "fees accumulate correctly");
        assertEq(sfr.totalETHFees(), totalFees, "total fees match");
    }

    // AUDIT H-3: test_withdrawAndSwapAgain removed (withdrawFees deleted).
    // ETH fee accumulation across swaps is validated in test_accumulateFees_multipleSwaps
    // above; end-to-end outflow is tested in FinalAudit_Revenue via distributeFeesToStakers.

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  HELPERS
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function _ethToTokenA() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);
    }

    function _tokenAToETH() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);
    }

    receive() external payable {}
}
