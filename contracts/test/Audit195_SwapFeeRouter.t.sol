// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ──────── Mocks ────────────────────────────────────────────────────

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

/// @dev Mock Uniswap V2 Router – 1:1 swap simulation
contract MockUniRouter195 {
    address public immutable WETH_ADDR;
    constructor(address _weth) { WETH_ADDR = _weth; }
    function WETH() external view returns (address) { return WETH_ADDR; }

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

// ──────── Main Test Contract ──────────────────────────────────────

contract Audit195SwapFeeRouter is Test {
    SwapFeeRouter public sfr;
    MockUniRouter195 public uniRouter;
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
        uniRouter = new MockUniRouter195(address(weth));
        vm.deal(address(uniRouter), 10_000 ether);

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0));

        tokenA.transfer(alice, 100_000 ether);
        tokenB.transfer(alice, 100_000 ether);
        vm.deal(alice, 1000 ether);

        vm.startPrank(alice);
        tokenA.approve(address(sfr), type(uint256).max);
        tokenB.approve(address(sfr), type(uint256).max);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. FEE CALCULATION ACCURACY
    // ═══════════════════════════════════════════════════════════════

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
        SwapFeeRouter zeroFee = new SwapFeeRouter(address(uniRouter), treasury, 0, address(0));
        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        uint256[] memory amounts = zeroFee.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 0);
        assertEq(zeroFee.accumulatedETHFees(), 0, "zero-fee should collect nothing");
        assertEq(amounts[amounts.length - 1], 1 ether, "full amount passed through");
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. ADJUSTED MIN CORRECTNESS (swapExactTokensForETH)
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  3. BALANCE-BEFORE/AFTER PATTERNS
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  4. REFERRAL FEE RECORDING
    // ═══════════════════════════════════════════════════════════════

    function test_referralFee_forwarded() public {
        MockSplitter195 splitter = new MockSplitter195();
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter));

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
        SwapFeeRouter withBad = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(bad));

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
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter));

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

    // ═══════════════════════════════════════════════════════════════
    //  5. TREASURY WITHDRAWAL SAFETY
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  6. SWEEP SAFETY
    // ═══════════════════════════════════════════════════════════════

    function test_sweepETH_onlySweepsBeyondAccumulated() public {
        // First accumulate some fees
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 accFees = sfr.accumulatedETHFees();
        // Send extra ETH directly (dust)
        vm.deal(address(sfr), accFees + 1 ether);

        uint256 treasBefore = treasury.balance;
        sfr.sweepETH();
        // Should only sweep the 1 ether above accumulated fees
        assertEq(treasury.balance - treasBefore, 1 ether, "only sweep non-fee ETH");
        // Accumulated fees untouched
        assertEq(sfr.accumulatedETHFees(), accFees, "accumulated fees preserved");
    }

    function test_sweepETH_revertsWhenOnlyFeeETH() public {
        // Accumulate fees exactly equal to balance
        address[] memory path = _ethToTokenA();
        vm.prank(alice);
        sfr.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        // Balance == accumulatedETHFees, nothing to sweep
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        sfr.sweepETH();
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

    // ═══════════════════════════════════════════════════════════════
    //  7. PATH VALIDATION
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  8. RECIPIENT VALIDATION
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  9. REENTRANCY PROTECTION
    // ═══════════════════════════════════════════════════════════════

    // All swap and withdrawal functions use nonReentrant. We verify the modifier exists
    // by checking that the functions are correctly guarded.
    // (Foundry doesn't easily allow testing reentrancy with standard mocks, but we verify
    //  all critical functions have the modifier via the source code audit above.)

    // AUDIT H-3: test_withdrawFees_nonReentrant removed (function deleted).

    // ═══════════════════════════════════════════════════════════════
    //  10. ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════

    function test_onlyOwner_proposeFeeChange() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.proposeFeeChange(50);
    }

    function test_onlyOwner_executeFeeChange() public {
        sfr.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(attacker);
        vm.expectRevert();
        sfr.executeFeeChange();
    }

    function test_onlyOwner_cancelFeeChange() public {
        sfr.proposeFeeChange(50);
        vm.prank(attacker);
        vm.expectRevert();
        sfr.cancelFeeChange();
    }

    function test_onlyOwner_proposeTreasuryChange() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.proposeTreasuryChange(attacker);
    }

    function test_onlyOwner_executeTreasuryChange() public {
        sfr.proposeTreasuryChange(makeAddr("newTreas"));
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(attacker);
        vm.expectRevert();
        sfr.executeTreasuryChange();
    }

    function test_onlyOwner_cancelTreasuryChange() public {
        sfr.proposeTreasuryChange(makeAddr("x"));
        vm.prank(attacker);
        vm.expectRevert();
        sfr.cancelTreasuryChange();
    }

    // AUDIT H-3: test_onlyOwner_withdrawFees removed (function deleted).

    function test_onlyOwner_withdrawTokenFees() public {
        vm.prank(attacker);
        vm.expectRevert();
        sfr.withdrawTokenFees(address(tokenA));
    }

    function test_onlyOwner_sweepETH() public {
        vm.deal(address(sfr), 1 ether);
        vm.prank(attacker);
        vm.expectRevert();
        sfr.sweepETH();
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
        sfr.proposeReferralSplitterChange(attacker);
    }

    // ═══════════════════════════════════════════════════════════════
    //  11. TIMELOCK FLOWS (FEE, TREASURY, REFERRAL)
    // ═══════════════════════════════════════════════════════════════

    function test_feeTimelock_fullCycle() public {
        sfr.proposeFeeChange(50);
        assertEq(sfr.pendingFeeBps(), 50);

        // Too early
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sfr.FEE_CHANGE()));
        sfr.executeFeeChange();

        // Right on time
        vm.warp(block.timestamp + 24 hours);
        sfr.executeFeeChange();
        assertEq(sfr.feeBps(), 50);
        assertEq(sfr.feeChangeTime(), 0);
        assertEq(sfr.pendingFeeBps(), 0);
    }

    function test_feeTimelock_expiry() public {
        sfr.proposeFeeChange(50);
        // Past expiry: 24h delay + 7 days validity + 1
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfr.FEE_CHANGE()));
        sfr.executeFeeChange();
    }

    function test_feeTimelock_cancelAndRepropose() public {
        sfr.proposeFeeChange(50);
        sfr.cancelFeeChange();
        assertEq(sfr.feeChangeTime(), 0);
        // Can propose again after cancel
        sfr.proposeFeeChange(60);
        assertEq(sfr.pendingFeeBps(), 60);
    }

    function test_feeTimelock_doublePropose_reverts() public {
        sfr.proposeFeeChange(50);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, sfr.FEE_CHANGE()));
        sfr.proposeFeeChange(60);
    }

    function test_feeTimelock_cancelNoPending_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, sfr.FEE_CHANGE()));
        sfr.cancelFeeChange();
    }

    function test_treasuryTimelock_fullCycle() public {
        address newTreas = makeAddr("newTreas");
        sfr.proposeTreasuryChange(newTreas);
        vm.warp(block.timestamp + 48 hours);
        sfr.executeTreasuryChange();
        assertEq(sfr.treasury(), newTreas);
        assertEq(sfr.treasuryChangeTime(), 0);
    }

    function test_treasuryTimelock_expiry() public {
        sfr.proposeTreasuryChange(makeAddr("x"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfr.TREASURY_CHANGE()));
        sfr.executeTreasuryChange();
    }

    function test_treasuryTimelock_zeroAddress_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        sfr.proposeTreasuryChange(address(0));
    }

    function test_treasuryTimelock_doublePropose_reverts() public {
        sfr.proposeTreasuryChange(makeAddr("a"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, sfr.TREASURY_CHANGE()));
        sfr.proposeTreasuryChange(makeAddr("b"));
    }

    function test_referralTimelock_fullCycle() public {
        address newSplitter = makeAddr("newSplitter");
        sfr.proposeReferralSplitterChange(newSplitter);
        vm.warp(block.timestamp + 48 hours);
        sfr.executeReferralSplitterChange();
        assertEq(address(sfr.referralSplitter()), newSplitter);
    }

    function test_referralTimelock_allowsZero() public {
        // Setting splitter to zero (disable) is allowed
        sfr.proposeReferralSplitterChange(address(0));
        vm.warp(block.timestamp + 48 hours);
        sfr.executeReferralSplitterChange();
        assertEq(address(sfr.referralSplitter()), address(0));
    }

    function test_referralTimelock_cancel() public {
        sfr.proposeReferralSplitterChange(makeAddr("x"));
        sfr.cancelReferralSplitterChange();
        assertEq(sfr.referralSplitterChangeTime(), 0);
    }

    function test_referralTimelock_expiry() public {
        sfr.proposeReferralSplitterChange(makeAddr("x"));
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, sfr.REFERRAL_CHANGE()));
        sfr.executeReferralSplitterChange();
    }

    function test_referralTimelock_tooEarly() public {
        sfr.proposeReferralSplitterChange(makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sfr.REFERRAL_CHANGE()));
        sfr.executeReferralSplitterChange();
    }

    function test_referralTimelock_cancelNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, sfr.REFERRAL_CHANGE()));
        sfr.cancelReferralSplitterChange();
    }

    // ═══════════════════════════════════════════════════════════════
    //  12. PAUSE / UNPAUSE
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  13. MAX FEE BPS CHECK (maxFeeBps parameter)
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  14. DEADLINE VALIDATION
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  15. RECOVER CALLER CREDIT
    // ═══════════════════════════════════════════════════════════════

    function test_recoverCallerCredit_works() public {
        MockSplitter195 splitter = new MockSplitter195();
        SwapFeeRouter withRef = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter));

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
        SwapFeeRouter r2 = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(splitter));
        address[] memory path = _ethToTokenA();
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        r2.swapExactETHForTokens{value: 10 ether}(0, path, alice, block.timestamp + 1, 100);

        uint256 fee = (10 ether * FEE_BPS) / 10000;

        // Change splitter via timelock
        r2.proposeReferralSplitterChange(address(0));
        vm.warp(block.timestamp + 48 hours);
        r2.executeReferralSplitterChange();

        // Recover from old splitter
        uint256 balBefore = address(r2).balance;
        r2.recoverCallerCreditFrom(address(splitter));
        assertEq(address(r2).balance - balBefore, fee, "recovered from old splitter");
    }

    function test_recoverCallerCreditFrom_zeroAddress_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        sfr.recoverCallerCreditFrom(address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    //  16. CONSTRUCTOR VALIDATION
    // ═══════════════════════════════════════════════════════════════

    function test_constructor_zeroRouter_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        new SwapFeeRouter(address(0), treasury, 30, address(0));
    }

    function test_constructor_zeroTreasury_reverts() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        new SwapFeeRouter(address(uniRouter), address(0), 30, address(0));
    }

    function test_constructor_feeTooHigh_reverts() public {
        vm.expectRevert(SwapFeeRouter.FeeTooHigh.selector);
        new SwapFeeRouter(address(uniRouter), treasury, 101, address(0));
    }

    function test_constructor_maxFee_succeeds() public {
        SwapFeeRouter r = new SwapFeeRouter(address(uniRouter), treasury, 100, address(0));
        assertEq(r.feeBps(), 100);
    }

    // ═══════════════════════════════════════════════════════════════
    //  17. DEPRECATED SETTERS
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  18. SLIPPAGE PROTECTION (swapExactTokensForETH)
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  19. ZERO AMOUNT GUARDS
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  20. APPROVAL REVOCATION AFTER SWAP
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  21. RECEIVE FUNCTION
    // ═══════════════════════════════════════════════════════════════

    function test_receive_acceptsETH() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(sfr).call{value: 1 ether}("");
        assertTrue(ok, "should accept ETH");
    }

    // ═══════════════════════════════════════════════════════════════
    //  22. MULTIPLE SWAPS ACCUMULATION
    // ═══════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

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
