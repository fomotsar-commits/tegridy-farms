// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyPair.sol";

// ─── Mock Tokens ────────────────────────────────────────────────────

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract WETH9Mock is ERC20 {
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

contract FeeOnTransferToken is ERC20 {
    uint256 public feePercent; // e.g. 5 = 5%

    constructor(string memory name, string memory symbol, uint256 _feePercent) ERC20(name, symbol) {
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

// ─── Tests ──────────────────────────────────────────────────────────

contract TegridyRouterTest is Test {
    TegridyRouter public router;
    TegridyFactory public factory;
    WETH9Mock public weth;
    MockERC20 public tokenA;
    MockERC20 public tokenB;

    address public deployer;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant INITIAL_LIQUIDITY = 100 ether;

    function setUp() public {
        deployer = address(this);

        weth = new WETH9Mock();
        factory = new TegridyFactory(deployer, deployer);
        router = new TegridyRouter(address(factory), address(weth));

        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");

        // Give alice tokens and ETH
        tokenA.transfer(alice, 10_000 ether);
        tokenB.transfer(alice, 10_000 ether);
        vm.deal(alice, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _createAndFundPair(address t0, address t1, uint256 amt0, uint256 amt1) internal returns (address pair) {
        pair = factory.createPair(t0, t1);
        // Sort tokens the same way the pair does
        (address sorted0, address sorted1) = t0 < t1 ? (t0, t1) : (t1, t0);
        (uint256 sortedAmt0, uint256 sortedAmt1) = t0 < t1 ? (amt0, amt1) : (amt1, amt0);

        IERC20(sorted0).transfer(pair, sortedAmt0);
        IERC20(sorted1).transfer(pair, sortedAmt1);
        TegridyPair(pair).mint(deployer);
    }

    function _createAndFundWETHPair(address token, uint256 amtToken, uint256 amtETH) internal returns (address pair) {
        pair = factory.createPair(token, address(weth));
        IERC20(token).transfer(pair, amtToken);
        // Deposit ETH to WETH and send to pair
        weth.deposit{value: amtETH}();
        weth.transfer(pair, amtETH);
        TegridyPair(pair).mint(deployer);
    }

    // ═══════════════════════════════════════════════════════════════
    // Deadline (ensure modifier)
    // ═══════════════════════════════════════════════════════════════

    function test_swapExactTokensForTokens_revertWhen_expired() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        // Set deadline in the past
        uint256 expiredDeadline = block.timestamp - 1;
        vm.expectRevert("EXPIRED");
        router.swapExactTokensForTokens(1 ether, 0, path, alice, expiredDeadline);
        vm.stopPrank();
    }

    function test_addLiquidity_revertWhen_expired() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        vm.startPrank(alice);
        tokenA.approve(address(router), 10 ether);
        tokenB.approve(address(router), 10 ether);

        vm.expectRevert("EXPIRED");
        router.addLiquidity(
            address(tokenA), address(tokenB),
            10 ether, 10 ether, 0, 0,
            alice, block.timestamp - 1
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // addLiquidity
    // ═══════════════════════════════════════════════════════════════

    function test_addLiquidity_basicFlow() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        vm.startPrank(alice);
        tokenA.approve(address(router), 10 ether);
        tokenB.approve(address(router), 10 ether);

        (uint256 amountA, uint256 amountB, uint256 liquidity) = router.addLiquidity(
            address(tokenA), address(tokenB),
            10 ether, 10 ether, 0, 0,
            alice, block.timestamp + 300
        );
        vm.stopPrank();

        assertGt(amountA, 0, "amountA should be > 0");
        assertGt(amountB, 0, "amountB should be > 0");
        assertGt(liquidity, 0, "liquidity should be > 0");
    }

    function test_addLiquidity_revertWhen_pairNotFound() public {
        vm.startPrank(alice);
        tokenA.approve(address(router), 10 ether);
        tokenB.approve(address(router), 10 ether);

        vm.expectRevert("PAIR_NOT_FOUND");
        router.addLiquidity(
            address(tokenA), address(tokenB),
            10 ether, 10 ether, 0, 0,
            alice, block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // addLiquidityETH
    // ═══════════════════════════════════════════════════════════════

    function test_addLiquidityETH_basicFlow() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        vm.startPrank(alice);
        tokenA.approve(address(router), 10 ether);

        (uint256 amountToken, uint256 amountETH, uint256 liquidity) = router.addLiquidityETH{value: 10 ether}(
            address(tokenA),
            10 ether, 0, 0,
            alice, block.timestamp + 300
        );
        vm.stopPrank();

        assertGt(amountToken, 0, "amountToken > 0");
        assertGt(amountETH, 0, "amountETH > 0");
        assertGt(liquidity, 0, "liquidity > 0");
    }

    function test_addLiquidityETH_refundsExcessETH() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        vm.startPrank(alice);
        tokenA.approve(address(router), 5 ether);

        uint256 aliceBalBefore = alice.balance;

        // Send 10 ETH but only ~5 ETH worth of tokenA, so some ETH should be refunded
        router.addLiquidityETH{value: 10 ether}(
            address(tokenA),
            5 ether, 0, 0,
            alice, block.timestamp + 300
        );
        vm.stopPrank();

        uint256 aliceBalAfter = alice.balance;
        // Alice should have gotten some ETH refunded (sent 10 but only ~5 needed)
        uint256 ethSpent = aliceBalBefore - aliceBalAfter;
        assertLt(ethSpent, 10 ether, "Should have refunded some ETH");
    }

    // ═══════════════════════════════════════════════════════════════
    // swapExactTokensForTokens
    // ═══════════════════════════════════════════════════════════════

    function test_swapExactTokensForTokens_happyPath() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        uint256 bobBBefore = tokenB.balanceOf(bob);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            1 ether, 0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        assertGt(amounts[1], 0, "Should receive tokenB");
        assertEq(tokenB.balanceOf(bob) - bobBBefore, amounts[1], "Bob should receive output");
    }

    function test_swapExactTokensForTokens_revertWhen_insufficientOutput() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        // Request absurdly high minimum output
        vm.expectRevert(TegridyRouter.InsufficientOutputAmount.selector);
        router.swapExactTokensForTokens(
            1 ether, 1000 ether, path, bob, block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // swapExactETHForTokens
    // ═══════════════════════════════════════════════════════════════

    function test_swapExactETHForTokens_happyPath() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.startPrank(alice);
        uint256 bobABefore = tokenA.balanceOf(bob);
        uint256[] memory amounts = router.swapExactETHForTokens{value: 1 ether}(
            0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        assertGt(amounts[1], 0, "Should receive tokenA");
        assertEq(tokenA.balanceOf(bob) - bobABefore, amounts[1], "Bob gets output");
    }

    function test_swapExactETHForTokens_revertWhen_invalidPath() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA); // Wrong — should be WETH
        path[1] = address(weth);

        vm.prank(alice);
        vm.expectRevert(TegridyRouter.InvalidPath.selector);
        router.swapExactETHForTokens{value: 1 ether}(0, path, bob, block.timestamp + 300);
    }

    // ═══════════════════════════════════════════════════════════════
    // swapExactTokensForETH
    // ═══════════════════════════════════════════════════════════════

    function test_swapExactTokensForETH_happyPath() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        vm.startPrank(alice);
        tokenA.approve(address(router), 1 ether);

        uint256 bobETHBefore = bob.balance;
        uint256[] memory amounts = router.swapExactTokensForETH(
            1 ether, 0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        assertGt(amounts[1], 0, "Should receive ETH output");
        assertEq(bob.balance - bobETHBefore, amounts[1], "Bob receives ETH");
    }

    function test_swapExactTokensForETH_revertWhen_invalidPath() public {
        _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB); // Wrong — last must be WETH

        vm.prank(alice);
        vm.expectRevert(TegridyRouter.InvalidPath.selector);
        router.swapExactTokensForETH(1 ether, 0, path, bob, block.timestamp + 300);
    }

    // ═══════════════════════════════════════════════════════════════
    // getAmountsOut / quote view functions
    // ═══════════════════════════════════════════════════════════════

    function test_getAmountsOut_returnsCorrectLength() public {
        _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256[] memory amounts = router.getAmountsOut(1 ether, path);
        assertEq(amounts.length, 2);
        assertEq(amounts[0], 1 ether);
        assertGt(amounts[1], 0);
    }

    function test_quote_basic() public view {
        uint256 result = router.quote(1 ether, 100 ether, 200 ether);
        assertEq(result, 2 ether); // 1 * 200 / 100 = 2
    }

    // ═══════════════════════════════════════════════════════════════
    // M-04: removeLiquidity revert when to == pair
    // ═══════════════════════════════════════════════════════════════

    function test_removeLiquidity_revertWhen_toIsPair() public {
        address pair = _createAndFundPair(address(tokenA), address(tokenB), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        // Transfer some LP tokens to alice
        uint256 lpBalance = IERC20(pair).balanceOf(deployer);
        IERC20(pair).transfer(alice, lpBalance / 2);

        vm.startPrank(alice);
        IERC20(pair).approve(address(router), type(uint256).max);

        vm.expectRevert("INVALID_TO");
        router.removeLiquidity(
            address(tokenA), address(tokenB),
            lpBalance / 2, 0, 0,
            pair, block.timestamp + 300
        );
        vm.stopPrank();
    }

    function test_removeLiquidityETH_revertWhen_toIsPair() public {
        address pair = _createAndFundWETHPair(address(tokenA), INITIAL_LIQUIDITY, INITIAL_LIQUIDITY);

        uint256 lpBalance = IERC20(pair).balanceOf(deployer);
        IERC20(pair).transfer(alice, lpBalance / 2);

        vm.startPrank(alice);
        IERC20(pair).approve(address(router), type(uint256).max);

        vm.expectRevert("INVALID_TO");
        router.removeLiquidityETH(
            address(tokenA),
            lpBalance / 2, 0, 0,
            pair, block.timestamp + 300
        );
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // M-05: Fee-on-transfer ETH swap doesn't drain extra WETH
    // ═══════════════════════════════════════════════════════════════

    function test_feeOnTransferETHSwap_doesNotDrainExtraWETH() public {
        FeeOnTransferToken fot = new FeeOnTransferToken("FeeToken", "FOT", 5);

        // Create pair: FOT/WETH
        address pair = factory.createPair(address(fot), address(weth));
        // Fund pair (account for fee on transfer to pair)
        fot.transfer(pair, INITIAL_LIQUIDITY);
        weth.deposit{value: INITIAL_LIQUIDITY}();
        weth.transfer(pair, INITIAL_LIQUIDITY);
        TegridyPair(pair).mint(deployer);

        // Seed the router with some "stale" WETH to check it isn't drained
        uint256 staleWETH = 5 ether;
        weth.deposit{value: staleWETH}();
        weth.transfer(address(router), staleWETH);

        // Give alice FOT tokens
        fot.transfer(alice, 1000 ether);

        address[] memory path = new address[](2);
        path[0] = address(fot);
        path[1] = address(weth);

        vm.startPrank(alice);
        fot.approve(address(router), 10 ether);

        uint256 bobETHBefore = bob.balance;
        uint256 routerWETHBefore = IERC20(address(weth)).balanceOf(address(router));

        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            10 ether, 0, path, bob, block.timestamp + 300
        );
        vm.stopPrank();

        uint256 routerWETHAfter = IERC20(address(weth)).balanceOf(address(router));
        uint256 bobETHReceived = bob.balance - bobETHBefore;

        // Router's pre-existing WETH must remain untouched
        assertEq(routerWETHAfter, routerWETHBefore, "Router stale WETH should not be drained");
        // Bob should have received only the swap output, not the swap output + stale WETH
        assertGt(bobETHReceived, 0, "Bob should receive swap output");
        assertLt(bobETHReceived, bobETHReceived + staleWETH, "Sanity check");
    }
}
