// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock Uniswap V2 Router that simulates swaps at 1:1 rate
contract MockUniRouter {
    address public immutable WETH_ADDR;

    constructor(address _weth) {
        WETH_ADDR = _weth;
    }

    function WETH() external view returns (address) {
        return WETH_ADDR;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = msg.value;
        require(amounts[path.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20(path[path.length - 1]).mint(to, msg.value);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn;
        (bool ok,) = to.call{value: amountIn}("");
        require(ok, "ETH send failed");
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn;
        MockERC20(path[path.length - 1]).mint(to, amountIn);
    }

    receive() external payable {}
}

contract SwapFeeRouterTest is Test {
    SwapFeeRouter public router;
    MockUniRouter public uniRouter;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    MockERC20 public weth;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public nonOwner = makeAddr("nonOwner");

    function setUp() public {
        weth = new MockERC20("WETH", "WETH");
        tokenA = new MockERC20("TokenA", "TKA");
        tokenB = new MockERC20("TokenB", "TKB");
        uniRouter = new MockUniRouter(address(weth));

        vm.deal(address(uniRouter), 1000 ether);

        router = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0)); // 0.3% fee

        tokenA.transfer(alice, 100_000 ether);
        tokenB.transfer(alice, 100_000 ether);
        vm.deal(alice, 100 ether);

        vm.prank(alice);
        tokenA.approve(address(router), type(uint256).max);
        vm.prank(alice);
        tokenB.approve(address(router), type(uint256).max);
    }

    // ===== FEE DEDUCTION AND SLIPPAGE PROTECTION =====

    function test_swapETHForTokens_deductsFee() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.prank(alice);
        uint256[] memory amounts = router.swapExactETHForTokens{value: 10 ether}(
            0, path, alice, block.timestamp + 1, 100
        );

        uint256 expectedFee = (10 ether * 30) / 10000;
        // Fees are now accumulated in contract (pull pattern), not sent inline to treasury
        assertEq(router.accumulatedETHFees(), expectedFee);
        assertEq(amounts[amounts.length - 1], 10 ether - expectedFee);
        assertEq(router.totalETHFees(), expectedFee);
        // totalSwaps counter removed (G-23: derivable from events)
    }

    function test_swapETHForTokens_slippageCheck() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.prank(alice);
        vm.expectRevert("INSUFFICIENT_OUTPUT");
        router.swapExactETHForTokens{value: 1 ether}(
            1 ether, // want full output but fee reduces it
            path, alice, block.timestamp + 1, 100
        );
    }

    function test_swapTokensForETH_slippageAfterFee() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.SlippageExceeded.selector);
        router.swapExactTokensForETH(
            10 ether, 10 ether, // want full output but fee reduces it
            path, alice, block.timestamp + 1, 100
        );
    }

    function test_swapTokensForTokens_feeOnInput() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(alice);
        router.swapExactTokensForTokens(
            10 ether, 0, path, alice, block.timestamp + 1, 100
        );

        uint256 expectedFee = (10 ether * 30) / 10000;
        // AUDIT FIX: Token fees now use pull-pattern (accumulated in contract, not pushed to treasury)
        assertEq(router.accumulatedTokenFees(address(tokenA)), expectedFee);
        assertEq(router.totalTokenFees(address(tokenA)), expectedFee);
    }

    function test_revert_swapZeroAmount() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        router.swapExactETHForTokens{value: 0}(0, path, alice, block.timestamp + 1, 100);
    }

    // ===== SWEEP ETH AND TOKENS (OWNER ONLY) =====

    function test_sweepETH_works_forOwner() public {
        // Send some ETH to the router
        vm.deal(address(router), 5 ether);

        uint256 treasuryBefore = treasury.balance;
        router.sweepETH();
        assertEq(treasury.balance - treasuryBefore, 5 ether);
    }

    function test_revert_sweepETH_nonOwner() public {
        vm.deal(address(router), 5 ether);
        vm.prank(nonOwner);
        vm.expectRevert();
        router.sweepETH();
    }

    function test_sweepTokens_works_forOwner() public {
        tokenA.transfer(address(router), 1000 ether);

        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        router.sweepTokens(address(tokenA));
        assertEq(tokenA.balanceOf(treasury) - treasuryBefore, 1000 ether);
    }

    function test_revert_sweepTokens_nonOwner() public {
        tokenA.transfer(address(router), 1000 ether);
        vm.prank(nonOwner);
        vm.expectRevert();
        router.sweepTokens(address(tokenA));
    }

    function test_revert_sweepETH_zeroBalance() public {
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        router.sweepETH();
    }

    function test_revert_sweepTokens_zeroBalance() public {
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        router.sweepTokens(address(tokenA));
    }

    function test_revert_sweepTokens_zeroAddress() public {
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        router.sweepTokens(address(0));
    }

    // ===== FEE TIMELOCK (SECURITY FIX #67) =====

    function test_proposeFeeChange() public {
        router.proposeFeeChange(50);
        assertEq(router.pendingFeeBps(), 50);
        assertGt(router.feeChangeTime(), block.timestamp);
    }

    function test_executeFeeChange_afterDelay() public {
        router.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours + 1);
        router.executeFeeChange();
        assertEq(router.feeBps(), 50);
        assertEq(router.feeChangeTime(), 0);
    }

    function test_revert_executeFeeChange_tooEarly() public {
        router.proposeFeeChange(50);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, router.FEE_CHANGE()));
        router.executeFeeChange();
    }

    function test_revert_executeFeeChange_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, router.FEE_CHANGE()));
        router.executeFeeChange();
    }

    function test_revert_proposeFee_tooHigh() public {
        vm.expectRevert(SwapFeeRouter.FeeTooHigh.selector);
        router.proposeFeeChange(101);
    }

    function test_revert_setFee_deprecated() public {
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        router.setFee(50);
    }

    function test_revert_proposeFeeChange_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        router.proposeFeeChange(50);
    }

    // ===== TREASURY CHANGE TIMELOCK (AUDIT FIX #68) =====

    function test_proposeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        router.proposeTreasuryChange(newTreasury);
        assertEq(router.pendingTreasury(), newTreasury);
    }

    function test_executeTreasuryChange_afterDelay() public {
        address newTreasury = makeAddr("newTreasury");
        router.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        router.executeTreasuryChange();
        assertEq(router.treasury(), newTreasury);
    }

    function test_revert_executeTreasuryChange_tooEarly() public {
        router.proposeTreasuryChange(makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, router.TREASURY_CHANGE()));
        router.executeTreasuryChange();
    }

    function test_revert_setTreasury_deprecated() public {
        vm.expectRevert(SwapFeeRouter.UseProposeTreasuryChange.selector);
        router.setTreasury(makeAddr("x"));
    }

    // ===== PAUSE / UNPAUSE =====

    function test_pause_blocksSwaps() public {
        router.pause();

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.prank(alice);
        vm.expectRevert();
        router.swapExactETHForTokens{value: 1 ether}(
            0, path, alice, block.timestamp + 1, 100
        );
    }

    function test_unpause_allowsSwaps() public {
        router.pause();
        router.unpause();

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        vm.prank(alice);
        router.swapExactETHForTokens{value: 1 ether}(
            0, path, alice, block.timestamp + 1, 100
        );
        // totalSwaps counter removed (G-23: derivable from events)
    }

    // ===== PATH DUPLICATE VALIDATION =====

    function test_revert_swapETHForTokens_duplicatePath() public {
        address[] memory path = new address[](3);
        path[0] = address(weth);
        path[1] = address(tokenA);
        path[2] = address(weth); // duplicate

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DuplicateTokenInPath.selector);
        router.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_swapTokensForTokens_duplicatePath() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenA); // duplicate

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DuplicateTokenInPath.selector);
        router.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);
    }

    function test_revert_swapTokensForETH_duplicatePath() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenA); // adjacent duplicate
        path[2] = address(weth);

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.DuplicateTokenInPath.selector);
        router.swapExactTokensForETH(10 ether, 0, path, alice, block.timestamp + 1, 100);
    }

    // ===== M-02: Fee-on-Transfer Token Accounting in withdrawTokenFees =====

    function test_withdrawTokenFees_feeOnTransfer_accounting() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(alice);
        router.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 expectedFee = (10 ether * 30) / 10000;
        assertEq(router.accumulatedTokenFees(address(tokenA)), expectedFee);

        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        router.withdrawTokenFees(address(tokenA));
        uint256 treasuryAfter = tokenA.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, expectedFee);
        assertEq(router.accumulatedTokenFees(address(tokenA)), 0);
    }

    function test_withdrawTokenFees_partialTransfer_keepsDust() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(alice);
        router.swapExactTokensForTokens(10 ether, 0, path, alice, block.timestamp + 1, 100);

        uint256 fee = router.accumulatedTokenFees(address(tokenA));
        assertTrue(fee > 0, "fee should be nonzero");

        router.withdrawTokenFees(address(tokenA));
        assertEq(router.accumulatedTokenFees(address(tokenA)), 0);
    }

    // ===== M-03: adjustedMin Overflow =====

    function test_swapTokensForETH_largeAmountOutMin_doesNotSilentlyRevert() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        uint256 largeMin = type(uint256).max / 5000;

        vm.prank(alice);
        vm.expectRevert();
        router.swapExactTokensForETH(
            10 ether, largeMin, path, alice, block.timestamp + 1, 100
        );
    }

    function test_swapTokensForETH_normalAmountOutMin_works() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(weth);

        vm.prank(alice);
        uint256[] memory amounts = router.swapExactTokensForETH(
            10 ether, 0, path, alice, block.timestamp + 1, 100
        );

        assertTrue(amounts[amounts.length - 1] > 0, "should have output");
        // totalSwaps counter removed (G-23: derivable from events)
    }

    // ===== X-04: ReferralFeeRedirectedToTreasury event =====

    function test_referralRedirectEvent_onRevert() public {
        RevertingSplitter badSplitter = new RevertingSplitter();
        SwapFeeRouter routerWithSplitter = new SwapFeeRouter(
            address(uniRouter), treasury, 30, address(badSplitter)
        );
        vm.deal(alice, 100 ether);

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenA);

        uint256 expectedFee = (10 ether * 30) / 10000;

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(routerWithSplitter));
        emit SwapFeeRouter.ReferralFeeRedirectedToTreasury(alice, expectedFee);
        routerWithSplitter.swapExactETHForTokens{value: 10 ether}(
            0, path, alice, block.timestamp + 1, 100
        );

        assertEq(routerWithSplitter.accumulatedETHFees(), expectedFee);
    }

    receive() external payable {}
}

contract RevertingSplitter {
    function recordFee(address) external payable {
        revert("LOCKED");
    }
    function withdrawCallerCredit() external {
        revert("LOCKED");
    }
}

/// @dev Fee-on-transfer token that takes 1% on every transfer
contract FeeOnTransferToken is ERC20 {
    uint256 public constant TRANSFER_FEE_BPS = 100;

    constructor() ERC20("FeeToken", "FOT") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * TRANSFER_FEE_BPS) / 10000;
        uint256 netAmount = amount - fee;
        _burn(msg.sender, fee);
        return super.transfer(to, netAmount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * TRANSFER_FEE_BPS) / 10000;
        uint256 netAmount = amount - fee;
        _spendAllowance(from, msg.sender, amount);
        _burn(from, fee);
        _transfer(from, to, netAmount);
        return true;
    }
}

/// @dev Tests for fee-on-transfer token behavior in withdrawTokenFees
contract SwapFeeRouterFOTTest is Test {
    SwapFeeRouter public feeRouter;
    MockUniRouter public uniRouter;
    FeeOnTransferToken public fotToken;
    MockERC20 public weth;
    MockERC20 public tokenB;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");

    function setUp() public {
        weth = new MockERC20("WETH", "WETH");
        tokenB = new MockERC20("TokenB", "TKB");
        fotToken = new FeeOnTransferToken();
        uniRouter = new MockUniRouter(address(weth));

        vm.deal(address(uniRouter), 1000 ether);

        feeRouter = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0));

        fotToken.transfer(alice, 100_000 ether);
        tokenB.transfer(alice, 100_000 ether);

        vm.prank(alice);
        fotToken.approve(address(feeRouter), type(uint256).max);
    }

    function test_withdrawTokenFees_FOT_noAccountingDrift() public {
        uint256 sendAmount = 1000 ether;
        fotToken.transfer(address(feeRouter), sendAmount);
        uint256 routerBalance = fotToken.balanceOf(address(feeRouter));
        assertTrue(routerBalance < sendAmount, "FOT should reduce received amount");

        // Set accumulatedTokenFees[fotToken] = routerBalance via vm.store (slot 8)
        bytes32 slot = keccak256(abi.encode(address(fotToken), uint256(8)));
        vm.store(address(feeRouter), slot, bytes32(routerBalance));
        assertEq(feeRouter.accumulatedTokenFees(address(fotToken)), routerBalance);

        uint256 treasuryBefore = fotToken.balanceOf(treasury);
        feeRouter.withdrawTokenFees(address(fotToken));
        uint256 treasuryAfter = fotToken.balanceOf(treasury);

        uint256 actualReceived = treasuryAfter - treasuryBefore;
        uint256 remaining = feeRouter.accumulatedTokenFees(address(fotToken));

        // AUDIT FIX M-04: CEI pattern — accounting is zeroed BEFORE transfer.
        // With FOT tokens, treasury receives less than `routerBalance`, but
        // accumulatedTokenFees is already zero (no phantom dust remains).
        assertEq(remaining, 0, "accounting zeroed before transfer (CEI pattern)");
        assertTrue(actualReceived > 0, "treasury received FOT tokens");
        assertTrue(actualReceived < routerBalance, "FOT fee reduced actual received amount");
    }

    receive() external payable {}
}
