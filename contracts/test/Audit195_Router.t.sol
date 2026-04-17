// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyPair.sol";

// ─── Mock Tokens ────────────────────────────────────────────────────

contract MockERC20_195 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract WETH9Mock_195 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract FeeOnTransferToken_195 is ERC20 {
    uint256 public feePercent; // e.g. 5 = 5%

    constructor(string memory name_, string memory symbol_, uint256 _feePercent) ERC20(name_, symbol_) {
        feePercent = _feePercent;
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && feePercent > 0) {
            uint256 fee = (amount * feePercent) / 100;
            super._update(from, address(0), fee); // burn fee
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev Contract that cannot receive ETH (no receive/fallback), used to test WETH fallback
contract NoReceiveContract {
    TegridyRouter public router;

    constructor(TegridyRouter _router) {
        router = _router;
    }

    function doSwapTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external returns (uint256[] memory) {
        IERC20(path[0]).approve(address(router), amountIn);
        return router.swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
    }

    function doRemoveLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        uint256 deadline
    ) external returns (uint256, uint256) {
        IERC20 pair = IERC20(TegridyFactory(router.factory()).getPair(token, router.WETH()));
        pair.approve(address(router), liquidity);
        return router.removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
    }

    function doAddLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        uint256 deadline
    ) external payable returns (uint256, uint256, uint256) {
        IERC20(token).approve(address(router), amountTokenDesired);
        return router.addLiquidityETH{value: msg.value}(
            token, amountTokenDesired, amountTokenMin, amountETHMin, address(this), deadline
        );
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

contract Audit195RouterTest is Test {
    TegridyRouter public router;
    TegridyFactory public factory;
    WETH9Mock_195 public weth;
    MockERC20_195 public tokenA;
    MockERC20_195 public tokenB;
    MockERC20_195 public tokenC;

    address public deployer;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant INITIAL_LIQUIDITY = 100 ether;

    function setUp() public {
        deployer = address(this);

        weth = new WETH9Mock_195();
        factory = new TegridyFactory(deployer, deployer);
        router = new TegridyRouter(address(factory), address(weth));

        tokenA = new MockERC20_195("Token A", "TKA");
        tokenB = new MockERC20_195("Token B", "TKB");
        tokenC = new MockERC20_195("Token C", "TKC");

        // Give alice tokens and ETH
        tokenA.transfer(alice, 10_000 ether);
        tokenB.transfer(alice, 10_000 ether);
        tokenC.transfer(alice, 10_000 ether);
        vm.deal(alice, 100 ether);
        vm.deal(deployer, 1000 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _createAndFundPair(address t0, address t1, uint256 amt0, uint256 amt1) internal returns (address pair) {
        pair = factory.createPair(t0, t1);
        (address sorted0, address sorted1) = t0 < t1 ? (t0, t1) : (t1, t0);
        (uint256 sortedAmt0, uint256 sortedAmt1) = t0 < t1 ? (amt0, amt1) : (amt1, amt0);

        IERC20(sorted0).transfer(pair, sortedAmt0);
        IERC20(sorted1).transfer(pair, sortedAmt1);
        TegridyPair(pair).mint(deployer);
    }

    function _createAndFundWETHPair(address token, uint256 amtToken, uint256 amtETH) internal returns (address pair) {
        pair = factory.createPair(token, address(weth));
        IERC20(token).transfer(pair, amtToken);
        weth.deposit{value: amtETH}();
        weth.transfer(pair, amtETH);
        TegridyPair(pair).mint(deployer);
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 1 (LOW): Fee-on-transfer swap functions lack path
    //   length limit. getAmountsOut/getAmountsIn enforce <= 10 hops,
    //   but the SupportingFeeOnTransfer variants call
    //   _swapSupportingFeeOnTransferTokens directly which has
    //   no path.length <= 10 check.
    //
    //   Impact: Unbounded O(n^2) cyclic-path check + unbounded loop
    //   iterations. Long paths waste gas and the cyclic check grows
    //   quadratically. A 50-hop path means 1225 pair comparisons.
    //   Mitigated by gas limits, but inconsistent with normal swap
    //   functions.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding1_FeeOnTransferSwap_NoPathLengthLimit() public {
        // Demonstrate that swapExactTokensForTokensSupportingFeeOnTransferTokens
        // does NOT revert with PATH_TOO_LONG for an 11-element path,
        // while swapExactTokensForTokens would revert.

        // We only need a 2-hop path to show the difference. Create an 11-hop
        // path array and show getAmountsOut reverts but the FoT variant only
        // reverts later (PAIR_NOT_FOUND, not PATH_TOO_LONG).
        address[] memory longPath = new address[](11);
        longPath[0] = address(tokenA);
        for (uint256 i = 1; i < 11; i++) {
            // Alternate tokens — these pairs don't exist, but the point
            // is to demonstrate the missing length check.
            longPath[i] = i % 2 == 0 ? address(tokenA) : address(tokenB);
        }

        // getAmountsOut (used by normal swap) reverts with PATH_TOO_LONG
        vm.expectRevert(TegridyRouter.PathTooLong.selector);
        router.getAmountsOut(1 ether, longPath);

        // After the fix, the FoT variant now also checks path length
        // and reverts with PATH_TOO_LONG, same as the normal swap variant.
        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        // FoT variant now correctly rejects paths that are too long
        vm.expectRevert(TegridyRouter.PathTooLong.selector);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            1 ether, 0, longPath, bob, block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 2 (INFO): swapExactETHForTokens — msg.value is fully
    //   consumed (amounts[0] == msg.value). No ETH can be "stuck",
    //   but unlike swapETHForExactTokens, there is no refund path.
    //   Users sending extra ETH get it all swapped.
    //   This is by-design but verify the invariant holds.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding2_swapExactETHForTokens_AllMsgValueConsumed() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.startPrank(alice);
        uint256 ethBefore = alice.balance;

        uint256[] memory amounts = router.swapExactETHForTokens{value: 5 ether}(
            0, path, alice, block.timestamp + 300
        );
        vm.stopPrank();

        // amounts[0] must equal msg.value — all ETH consumed
        assertEq(amounts[0], 5 ether, "amounts[0] should equal msg.value");
        // Alice spent exactly 5 ETH
        assertEq(ethBefore - alice.balance, 5 ether, "All ETH consumed");
        // Router should hold 0 ETH and 0 WETH
        assertEq(address(router).balance, 0, "Router holds no ETH");
        assertEq(IERC20(address(weth)).balanceOf(address(router)), 0, "Router holds no WETH");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 3 (LOW): quote() rounds to zero for dust on
    //   imbalanced pools: amountA * reserveB < reserveA => 0.
    //   _calculateLiquidity uses quote(), so with amountBMin = 0,
    //   addLiquidity could try to add 0 of tokenB.
    //   However, TegridyPair.mint() will revert if amount0 or
    //   amount1 is 0 (INSUFFICIENT_LIQUIDITY_MINTED), so this is
    //   safely caught at the pair level.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding3_QuoteRoundsToZero() public pure {
        // Small amountA with large reserveA and small reserveB
        // amountA=1, reserveA=1e18, reserveB=1e6
        // quote = (1 * 1e6) / 1e18 = 0
        uint256 result = _quoteInternal(1, 1e18, 1e6);
        assertEq(result, 0, "quote rounds to zero for dust");
    }

    function _quoteInternal(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256) {
        return (amountA * reserveB) / reserveA;
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 4 (LOW): addLiquidityETH WETH fallback for contracts
    //   that cannot receive ETH. Excess ETH refund falls back to
    //   WETH transfer. The user contract gets WETH instead of ETH.
    //   Verify the fallback works correctly.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding4_addLiquidityETH_WETHFallback_NoReceiveContract() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        NoReceiveContract noRcv = new NoReceiveContract(router);
        tokenA.transfer(address(noRcv), 1000 ether);
        vm.deal(address(noRcv), 50 ether);

        // The contract sends 10 ETH but only ~5 ETH will be needed for 5 ether of tokenA
        // The excess should be refunded as WETH since NoReceiveContract has no receive()
        uint256 wethBefore = IERC20(address(weth)).balanceOf(address(noRcv));

        (uint256 amountToken, uint256 amountETH,) = noRcv.doAddLiquidityETH{value: 10 ether}(
            address(tokenA), 5 ether, 0, 0, block.timestamp + 300
        );

        uint256 wethAfter = IERC20(address(weth)).balanceOf(address(noRcv));
        uint256 ethRefundAsWETH = wethAfter - wethBefore;

        // The contract should have received WETH as refund for excess ETH
        assertGt(amountToken, 0, "Should add some tokenA");
        assertGt(amountETH, 0, "Should add some ETH");
        // If less than 10 ETH was used, the rest should be WETH
        if (amountETH < 10 ether) {
            uint256 expectedRefund = 10 ether - amountETH;
            assertEq(ethRefundAsWETH, expectedRefund, "Excess returned as WETH");
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 5 (LOW): swapExactTokensForETH — WETH fallback for
    //   contracts without receive(). Verify the to address gets
    //   WETH instead of ETH.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding5_swapTokensForETH_WETHFallback_NoReceiveContract() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        NoReceiveContract noRcv = new NoReceiveContract(router);
        tokenA.transfer(address(noRcv), 1000 ether);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        uint256 wethBefore = IERC20(address(weth)).balanceOf(address(noRcv));

        uint256[] memory amounts = noRcv.doSwapTokensForETH(
            1 ether, 0, path, block.timestamp + 300
        );

        uint256 wethAfter = IERC20(address(weth)).balanceOf(address(noRcv));

        // NoReceiveContract gets WETH instead of ETH
        assertGt(amounts[1], 0, "Should receive output");
        assertEq(wethAfter - wethBefore, amounts[1], "Received as WETH");
        assertEq(address(noRcv).balance, 0, "No ETH balance (cannot receive)");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 6 (LOW): removeLiquidityETH — WETH fallback for
    //   contracts without receive(). Verify correctness.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding6_removeLiquidityETH_WETHFallback_NoReceiveContract() public {
        address pair = _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        NoReceiveContract noRcv = new NoReceiveContract(router);

        // Give the NoReceiveContract some LP tokens
        uint256 lpBal = IERC20(pair).balanceOf(deployer);
        IERC20(pair).transfer(address(noRcv), lpBal / 4);

        uint256 wethBefore = IERC20(address(weth)).balanceOf(address(noRcv));
        uint256 tokenBefore = tokenA.balanceOf(address(noRcv));

        (uint256 amountToken, uint256 amountETH) = noRcv.doRemoveLiquidityETH(
            address(tokenA), lpBal / 4, 0, 0, block.timestamp + 300
        );

        uint256 wethAfter = IERC20(address(weth)).balanceOf(address(noRcv));
        uint256 tokenAfter = tokenA.balanceOf(address(noRcv));

        // Token received normally
        assertEq(tokenAfter - tokenBefore, amountToken, "Token received");
        // ETH received as WETH since contract cannot accept ETH
        assertEq(wethAfter - wethBefore, amountETH, "ETH received as WETH");
        assertEq(address(noRcv).balance, 0, "No ETH balance");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 7 (INFO): Deadline enforcement — ensure modifier
    //   rejects deadlines more than 2 hours in the future.
    //   This is a DoS/griefing protection. Verify it works.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding7_DeadlineTooFar_Reverts() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        // Deadline > 2 hours from now should revert
        uint256 tooFarDeadline = block.timestamp + 3 hours;
        vm.expectRevert("DEADLINE_TOO_FAR");
        router.swapExactTokensForTokens(1 ether, 0, path, alice, tooFarDeadline);

        // Deadline exactly 2 hours should succeed
        uint256 exactDeadline = block.timestamp + 2 hours;
        router.swapExactTokensForTokens(1 ether, 0, path, alice, exactDeadline);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 8 (MEDIUM): _getAmountOut overflow for extreme inputs.
    //   amountIn * 997 can overflow if amountIn > type(uint256).max / 997.
    //   However, reserves are uint112, so reserveOut * amountInWithFee
    //   is bounded by uint112.max * (uint256.max) which IS possible
    //   if someone sends tokens directly to the pair.
    //   In practice, reserves are capped at uint112, so actual
    //   amountIn that matters is bounded. Verify that Solidity 0.8
    //   safely reverts on overflow.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding8_GetAmountOut_OverflowReverts() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        // amountIn so large that amountIn * 997 overflows uint256
        uint256 hugeAmount = type(uint256).max / 996; // Will overflow on * 997

        // This should revert with arithmetic overflow (Solidity 0.8 built-in)
        vm.expectRevert(); // Arithmetic overflow
        router.getAmountsOut(hugeAmount, path);
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 9 (INFO): Cyclic path rejection. Verify that _swap
    //   and _swapSupportingFeeOnTransferTokens both reject cyclic
    //   paths (A->B->A).
    // ═══════════════════════════════════════════════════════════════

    function test_Finding9_CyclicPathReverts() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        // Path A -> B -> A uses the same pair twice
        address[] memory cyclicPath = new address[](3);
        cyclicPath[0] = address(tokenA);
        cyclicPath[1] = address(tokenB);
        cyclicPath[2] = address(tokenA);

        vm.startPrank(alice);
        tokenA.approve(address(router), 10 ether);

        vm.expectRevert(TegridyRouter.CyclicPath.selector);
        router.swapExactTokensForTokens(1 ether, 0, cyclicPath, alice, block.timestamp + 300);

        // Also test FoT variant
        vm.expectRevert(TegridyRouter.CyclicPath.selector);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            1 ether, 0, cyclicPath, alice, block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 10 (INFO): Verify swapExactTokensForETH to == pair
    //   is rejected (H-09 fix).
    // ═══════════════════════════════════════════════════════════════

    function test_Finding10_SwapToPairReverts() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address pair = factory.getPair(address(tokenA), address(weth));

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForETH(1 ether, 0, path, pair, block.timestamp + 300);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 11 (INFO): Multi-hop swap works correctly through
    //   3 pools. Verify amounts chain correctly.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding11_MultiHopSwap() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);
        _createAndFundPair(address(tokenB), address(tokenC), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        uint256 cBefore = tokenC.balanceOf(bob);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            1 ether, 0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        assertEq(amounts.length, 3, "3 amounts for 3-hop");
        assertEq(amounts[0], 1 ether, "Input amount");
        assertGt(amounts[1], 0, "Intermediate amount");
        assertGt(amounts[2], 0, "Final output");
        assertEq(tokenC.balanceOf(bob) - cBefore, amounts[2], "Bob receives final output");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 12 (LOW): Fee-on-transfer token swap correctly
    //   measures actual received balance, not nominal amountIn.
    //   A 5% FoT token means the pair receives 95% of amountIn.
    //   Verify the output is based on actual received amount.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding12_FeeOnTransferTokenSwapCorrectness() public {
        FeeOnTransferToken_195 fot = new FeeOnTransferToken_195("FeeToken", "FOT", 5);

        address pair = factory.createPair(address(fot), address(tokenB));
        fot.transfer(pair, INITIAL_LIQUIDITY); // pair receives 95 ether
        tokenB.transfer(pair, INITIAL_LIQUIDITY);
        TegridyPair(pair).mint(deployer);

        fot.transfer(alice, 100 ether); // alice receives 95 ether

        address[] memory path = new address[](2);
        path[0] = address(fot);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        fot.approve(address(router), 10 ether);

        uint256 bobBBefore = tokenB.balanceOf(bob);

        // Normal swap would fail because the pair receives less than amountIn
        // due to the transfer fee. The FoT variant handles this.
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            10 ether, 0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        uint256 bobReceived = tokenB.balanceOf(bob) - bobBBefore;
        assertGt(bobReceived, 0, "Bob should receive tokenB");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 13 (INFO): Slippage protection — amountOutMin is
    //   enforced on all swap variants. Verify each path.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding13_SlippageProtectionEnforced() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        // swapExactTokensForTokens
        {
            address[] memory path = new address[](2);
            path[0] = address(tokenA);
            path[1] = address(tokenB);

            vm.startPrank(alice);
            tokenA.approve(address(router), 1 ether);
            vm.expectRevert(TegridyRouter.InsufficientOutputAmount.selector);
            router.swapExactTokensForTokens(1 ether, 1000 ether, path, alice, block.timestamp + 300);
            vm.stopPrank();
        }

        // swapExactETHForTokens
        {
            address[] memory path = new address[](2);
            path[0] = address(weth);
            path[1] = address(tokenA);

            vm.prank(alice);
            vm.expectRevert(TegridyRouter.InsufficientOutputAmount.selector);
            router.swapExactETHForTokens{value: 1 ether}(1000 ether, path, alice, block.timestamp + 300);
        }

        // swapExactTokensForETH
        {
            address[] memory path = new address[](2);
            path[0] = address(tokenA);
            path[1] = address(weth);

            vm.startPrank(alice);
            tokenA.approve(address(router), 1 ether);
            vm.expectRevert(TegridyRouter.InsufficientOutputAmount.selector);
            router.swapExactTokensForETH(1 ether, 1000 ether, path, alice, block.timestamp + 300);
            vm.stopPrank();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 14 (INFO): removeLiquidity slippage protection —
    //   amountAMin/amountBMin enforced.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding14_RemoveLiquidity_SlippageEnforced() public {
        address pair = _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        uint256 lpBal = IERC20(pair).balanceOf(deployer);
        IERC20(pair).transfer(alice, lpBal / 4);

        vm.startPrank(alice);
        IERC20(pair).approve(address(router), type(uint256).max);

        vm.expectRevert("INSUFFICIENT_A_AMOUNT");
        router.removeLiquidity(
            address(tokenA), address(tokenB),
            lpBal / 4,
            1000 ether, // way too high
            0,
            alice,
            block.timestamp + 300
        );

        vm.expectRevert("INSUFFICIENT_B_AMOUNT");
        router.removeLiquidity(
            address(tokenA), address(tokenB),
            lpBal / 4,
            0,
            1000 ether, // way too high
            alice,
            block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 15 (INFO): to == address(0) rejected on all public
    //   functions that accept a `to` parameter.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding15_ZeroAddressToReverts() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), type(uint256).max);

        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForTokens(1 ether, 0, path, address(0), block.timestamp + 300);

        path[0] = address(weth);
        path[1] = address(tokenA);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactETHForTokens{value: 1 ether}(0, path, address(0), block.timestamp + 300);

        vm.expectRevert("ZERO_TO");
        router.removeLiquidityETH(address(tokenA), 1, 0, 0, address(0), block.timestamp + 300);

        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 16 (INFO): _pairFor reverts for disabled pairs.
    //   Verify swaps fail if a pair is disabled via factory.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding16_DisabledPairSwapReverts() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);
        address pair = factory.getPair(address(tokenA), address(tokenB));

        // Propose and execute pair disable (timelocked)
        factory.proposePairDisabled(pair, true);
        vm.warp(block.timestamp + 48 hours);
        factory.executePairDisabled(pair);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        vm.expectRevert(TegridyRouter.PairDisabled.selector);
        router.swapExactTokensForTokens(1 ether, 0, path, alice, block.timestamp + 300);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 17 (INFO): getAmountsIn inverse calculation correct.
    //   Verify amountsIn -> swap -> receive amountOut.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding17_SwapTokensForExactTokens_Correctness() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 desiredOut = 1 ether;
        uint256[] memory amountsNeeded = router.getAmountsIn(desiredOut, path);

        vm.startPrank(alice);
        tokenA.approve(address(router), amountsNeeded[0]);

        uint256 bobBBefore = tokenB.balanceOf(bob);
        uint256[] memory amounts = router.swapTokensForExactTokens(
            desiredOut, amountsNeeded[0], path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        assertEq(amounts[amounts.length - 1], desiredOut, "Got exact desired output");
        assertEq(tokenB.balanceOf(bob) - bobBBefore, desiredOut, "Bob got exact amount");
    }

    // ═══════════════════════════════════════════════════════════════
    // FINDING 18 (INFO): ETH refund in swapETHForExactTokens works.
    // ═══════════════════════════════════════════════════════════════

    function test_Finding18_SwapETHForExactTokens_RefundsExcess() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        uint256 desiredOut = 1 ether;
        uint256[] memory amountsNeeded = router.getAmountsIn(desiredOut, path);

        vm.startPrank(alice);
        uint256 ethBefore = alice.balance;

        // Send way more ETH than needed
        uint256[] memory amounts = router.swapETHForExactTokens{value: 50 ether}(
            desiredOut, path, alice, block.timestamp + 300
        );
        vm.stopPrank();

        uint256 ethSpent = ethBefore - alice.balance;
        // Only amountsNeeded[0] should be spent, rest refunded
        assertEq(ethSpent, amounts[0], "Only required ETH spent");
        assertEq(amounts[0], amountsNeeded[0], "Matches getAmountsIn");
        assertLt(ethSpent, 50 ether, "Excess ETH refunded");
    }
}
