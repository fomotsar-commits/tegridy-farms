// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";

contract MockERC20Pair is ERC20 {
    uint8 private _dec;

    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) {
        _dec = dec_;
        _mint(msg.sender, 1_000_000_000 * 10 ** dec_);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Token with >18 decimals to test rejection
contract MockERC20HighDecimals is ERC20 {
    uint8 private _dec;

    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) {
        _dec = dec_;
        _mint(msg.sender, 1_000_000_000 * 10 ** uint256(dec_));
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }
}

contract TegridyPairTest is Test {
    TegridyFactory public factory;
    TegridyPair public pair;
    MockERC20Pair public tokenA;
    MockERC20Pair public tokenB;
    address public feeTo = makeAddr("feeTo");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        factory = new TegridyFactory(address(this), address(this));
        // AUDIT FIX: Use timelocked feeTo change
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        tokenA = new MockERC20Pair("Token A", "TKA", 18);
        tokenB = new MockERC20Pair("Token B", "TKB", 18);

        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pair = TegridyPair(pairAddr);

        tokenA.transfer(alice, 100_000_000 ether);
        tokenB.transfer(alice, 100_000_000 ether);
        tokenA.transfer(bob, 100_000_000 ether);
        tokenB.transfer(bob, 100_000_000 ether);
    }

    // ===== Helpers =====

    function _addLiquidity(address user, uint256 amountA, uint256 amountB) internal returns (uint256 liquidity) {
        vm.startPrank(user);
        tokenA.transfer(address(pair), amountA);
        tokenB.transfer(address(pair), amountB);
        liquidity = pair.mint(user);
        vm.stopPrank();
    }

    function _swapAForB(address user, uint256 amountIn) internal returns (uint256 amountOut) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        amountOut = (amountIn * 997 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 997);

        vm.startPrank(user);
        tokenA.transfer(address(pair), amountIn);
        pair.swap(0, amountOut, user, "");
        vm.stopPrank();
    }

    // ===== INITIALIZE CAN ONLY BE CALLED ONCE =====

    function test_revert_doubleInitialize() public {
        vm.prank(address(factory));
        vm.expectRevert(bytes("ALREADY_INITIALIZED"));
        pair.initialize(address(tokenA), address(tokenB));
    }

    function test_revert_initializeNotFactory() public {
        TegridyPair newPair = new TegridyPair();
        vm.prank(alice);
        vm.expectRevert("FORBIDDEN");
        newPair.initialize(address(tokenA), address(tokenB));
    }

    // ===== TOKENS WITH >18 DECIMALS ARE REJECTED =====

    function test_token0_highDecimals_accepted() public {
        MockERC20HighDecimals highDec = new MockERC20HighDecimals("High", "HIGH", 24);
        MockERC20Pair normal = new MockERC20Pair("Normal", "NORM", 18);

        address t0 = address(highDec) < address(normal) ? address(highDec) : address(normal);
        address t1 = address(highDec) < address(normal) ? address(normal) : address(highDec);

        // High-decimal tokens are now accepted (skim validation handles balance discrepancies)
        address pairAddr = factory.createPair(t0, t1);
        assertTrue(pairAddr != address(0));
    }

    // ===== FIRST DEPOSITOR MINIMUM LIQUIDITY PREVENTS INFLATION ATTACK =====

    function test_revert_firstDeposit_tooSmall() public {
        vm.startPrank(alice);
        tokenA.transfer(address(pair), 100); // very small, below 1000 minimum
        tokenB.transfer(address(pair), 100);
        vm.expectRevert("MIN_INITIAL_TOKENS");
        pair.mint(alice);
        vm.stopPrank();
    }

    function test_firstDeposit_minimumLiquidity_lockedToDead() public {
        uint256 liquidity = _addLiquidity(alice, 10_000 ether, 10_000 ether);
        assertGt(liquidity, 0);
        assertEq(pair.balanceOf(address(0xdead)), 1000); // MINIMUM_LIQUIDITY locked
    }

    // ===== SWAP FEE IS 0.3% (NOT 1%) =====

    function test_swap_feeIs03Percent() public {
        _addLiquidity(alice, 1_000_000 ether, 1_000_000 ether);

        uint256 amountIn = 10_000 ether;
        // Expected output with 0.3% fee: amountIn * 997 * r1 / (r0 * 1000 + amountIn * 997)
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 expected = (amountIn * 997 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 997);

        uint256 bobBBefore = tokenB.balanceOf(bob);
        _swapAForB(bob, amountIn);
        uint256 bobBAfter = tokenB.balanceOf(bob);

        assertEq(bobBAfter - bobBBefore, expected, "Output should match 0.3% fee formula");

        // Verify it's significantly more than 1% fee would give
        uint256 expectedWith1Pct = (amountIn * 990 * uint256(r1)) / (uint256(r0) * 1000 + amountIn * 990);
        assertGt(expected, expectedWith1Pct, "0.3% fee should give more output than 1%");
    }

    // ===== K-INVARIANT HOLDS AFTER SWAPS =====

    function test_swap_kInvariantHoldsAfterSwap() public {
        _addLiquidity(alice, 100_000 ether, 100_000 ether);

        (uint112 r0Before, uint112 r1Before,) = pair.getReserves();
        uint256 kBefore = uint256(r0Before) * uint256(r1Before);

        _swapAForB(bob, 1_000 ether);

        (uint112 r0After, uint112 r1After,) = pair.getReserves();
        uint256 kAfter = uint256(r0After) * uint256(r1After);

        // k should increase (or stay equal) due to fees
        assertGe(kAfter, kBefore, "K should not decrease after swap");
    }

    function test_swap_kInvariantEnforced() public {
        _addLiquidity(alice, 100_000 ether, 100_000 ether);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amountIn = 1_000 ether;
        // Calculate output WITHOUT fee (would break k)
        uint256 unfairOutput = (amountIn * uint256(r1)) / uint256(r0);

        vm.startPrank(bob);
        tokenA.transfer(address(pair), amountIn);
        vm.expectRevert(bytes("K"));
        pair.swap(0, unfairOutput, bob, "");
        vm.stopPrank();
    }

    // ===== BASIC OPERATIONS =====

    function test_mint_firstLiquidity() public {
        uint256 liquidity = _addLiquidity(alice, 10_000 ether, 10_000 ether);
        assertGt(liquidity, 0);
        assertGt(pair.balanceOf(alice), 0);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 10_000 ether);
        assertEq(r1, 10_000 ether);
    }

    function test_mint_subsequent() public {
        _addLiquidity(alice, 10_000 ether, 10_000 ether);
        uint256 bobLiquidity = _addLiquidity(bob, 5_000 ether, 5_000 ether);
        assertGt(bobLiquidity, 0);
    }

    function test_swap_basicAForB() public {
        _addLiquidity(alice, 100_000 ether, 100_000 ether);

        uint256 bobBBefore = tokenB.balanceOf(bob);
        uint256 amountOut = _swapAForB(bob, 1_000 ether);

        uint256 bobBAfter = tokenB.balanceOf(bob);
        assertEq(bobBAfter - bobBBefore, amountOut);
        assertGt(amountOut, 0);
    }

    function test_burn_redeemLP() public {
        uint256 liquidity = _addLiquidity(alice, 10_000 ether, 10_000 ether);

        vm.startPrank(alice);
        pair.transfer(address(pair), liquidity);
        (uint256 amount0, uint256 amount1) = pair.burn(alice);
        vm.stopPrank();

        assertGt(amount0, 0);
        assertGt(amount1, 0);
    }

    function test_mintFee_protocolShare() public {
        _addLiquidity(alice, 100_000 ether, 100_000 ether);

        for (uint256 i = 0; i < 10; i++) {
            _swapAForB(bob, 1_000 ether);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            uint256 bIn = 500 ether;
            uint256 aOut = (bIn * 997 * uint256(r0)) / (uint256(r1) * 1000 + bIn * 997);
            vm.startPrank(bob);
            tokenB.transfer(address(pair), bIn);
            pair.swap(aOut, 0, bob, "");
            vm.stopPrank();
        }

        uint256 feeToBalBefore = pair.balanceOf(feeTo);
        _addLiquidity(alice, 1_000 ether, 1_000 ether);
        uint256 feeToBalAfter = pair.balanceOf(feeTo);

        assertGt(feeToBalAfter, feeToBalBefore, "feeTo should receive protocol fee LP tokens");
    }

    function test_pairInitialization() public view {
        assertEq(pair.token0(), address(tokenA));
        assertEq(pair.token1(), address(tokenB));
        assertEq(pair.factory(), address(factory));
    }

    function test_lpTokenMetadata() public view {
        assertEq(pair.name(), "Tegridy LP");
        assertEq(pair.symbol(), "TGLP");
    }

    // ===== FIRST DEPOSITOR MINIMUM PER-TOKEN CHECK =====

    function test_revert_firstDeposit_dustToken0() public {
        TegridyPair freshPair = TegridyPair(factory.createPair(
            address(new MockERC20Pair("X", "X", 18)),
            address(new MockERC20Pair("Y", "Y", 18))
        ));
        address t0 = freshPair.token0();
        address t1 = freshPair.token1();

        // 999 wei of token0 is below the 1000 minimum
        MockERC20Pair(t0).mint(alice, 10_000 ether);
        MockERC20Pair(t1).mint(alice, 10_000 ether);
        vm.startPrank(alice);
        IERC20(t0).transfer(address(freshPair), 999);
        IERC20(t1).transfer(address(freshPair), 10_000 ether);
        vm.expectRevert("MIN_INITIAL_TOKENS");
        freshPair.mint(alice);
        vm.stopPrank();
    }

    function test_revert_firstDeposit_dustToken1() public {
        TegridyPair freshPair = TegridyPair(factory.createPair(
            address(new MockERC20Pair("X2", "X2", 18)),
            address(new MockERC20Pair("Y2", "Y2", 18))
        ));
        address t0 = freshPair.token0();
        address t1 = freshPair.token1();

        MockERC20Pair(t0).mint(alice, 10_000 ether);
        MockERC20Pair(t1).mint(alice, 10_000 ether);
        vm.startPrank(alice);
        IERC20(t0).transfer(address(freshPair), 10_000 ether);
        IERC20(t1).transfer(address(freshPair), 500);
        vm.expectRevert("MIN_INITIAL_TOKENS");
        freshPair.mint(alice);
        vm.stopPrank();
    }

    function test_firstDeposit_exactMinimumTokens() public {
        TegridyPair freshPair = TegridyPair(factory.createPair(
            address(new MockERC20Pair("X3", "X3", 18)),
            address(new MockERC20Pair("Y3", "Y3", 18))
        ));
        address t0 = freshPair.token0();
        address t1 = freshPair.token1();

        // 1000 of each should pass the per-token check but may still fail the
        // INSUFFICIENT_INITIAL_LIQUIDITY check (sqrt(1000*1000)=1000, needs >1_000_000).
        // Use amounts that pass both checks.
        MockERC20Pair(t0).mint(alice, 100_000 ether);
        MockERC20Pair(t1).mint(alice, 100_000 ether);
        vm.startPrank(alice);
        IERC20(t0).transfer(address(freshPair), 10_000 ether);
        IERC20(t1).transfer(address(freshPair), 10_000 ether);
        uint256 liquidity = freshPair.mint(alice);
        vm.stopPrank();
        assertGt(liquidity, 0);
    }

    receive() external payable {}
}
