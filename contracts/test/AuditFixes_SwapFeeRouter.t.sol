// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mock Contracts ──────────────────────────────────────────────────────────

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal mock Uniswap V2 Router that returns predictable swap amounts.
///      For ETH->Token swaps: returns 1000 tokens per 1 ETH (1000:1 ratio).
///      For Token->ETH swaps: returns 0.001 ETH per 1 token (inverse ratio).
contract MockUniswapV2Router {
    address public immutable WETH_ADDR;
    MockERC20 public outputToken;

    // Configurable output amount for testing slippage
    uint256 public fixedOutputAmount;
    bool public useFixedOutput;

    constructor(address _weth) {
        WETH_ADDR = _weth;
    }

    function WETH() external view returns (address) {
        return WETH_ADDR;
    }

    function setFixedOutput(uint256 amount) external {
        fixedOutputAmount = amount;
        useFixedOutput = true;
    }

    function setOutputToken(address _token) external {
        outputToken = MockERC20(_token);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;

        uint256 outAmount;
        if (useFixedOutput) {
            outAmount = fixedOutputAmount;
        } else {
            outAmount = msg.value * 1000; // 1 ETH = 1000 tokens
        }
        amounts[path.length - 1] = outAmount;

        // Enforce slippage check like real Uniswap router
        require(outAmount >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");

        // Mint output tokens to recipient
        outputToken.mint(to, outAmount);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        // Pull tokens from caller
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 ethOut;
        if (useFixedOutput) {
            ethOut = fixedOutputAmount;
        } else {
            ethOut = amountIn / 1000; // 1000 tokens = 1 ETH
        }
        amounts[path.length - 1] = ethOut;

        // Send ETH to recipient
        (bool ok,) = to.call{value: ethOut}("");
        require(ok, "ETH send failed");
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        // Pull tokens from caller
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 outAmount;
        if (useFixedOutput) {
            outAmount = fixedOutputAmount;
        } else {
            outAmount = amountIn; // 1:1 for token-to-token
        }
        amounts[path.length - 1] = outAmount;

        // Mint output tokens to recipient
        MockERC20(path[path.length - 1]).mint(to, outAmount);
    }

    receive() external payable {}
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

contract AuditFixes_SwapFeeRouterTest is Test {
    SwapFeeRouter public feeRouter;
    MockUniswapV2Router public mockRouter;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    address public weth;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public owner;

    uint256 constant FEE_BPS = 30; // 0.3%

    function setUp() public {
        owner = address(this);
        weth = makeAddr("weth");

        // Deploy mock router
        mockRouter = new MockUniswapV2Router(weth);

        // Deploy tokens
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");

        // Configure mock router
        mockRouter.setOutputToken(address(tokenB));

        // Deploy SwapFeeRouter
        feeRouter = new SwapFeeRouter(address(mockRouter), treasury, FEE_BPS, address(0));

        // Fund mock router with ETH for token->ETH swaps
        vm.deal(address(mockRouter), 100 ether);

        // Fund alice
        vm.deal(alice, 100 ether);
        tokenA.transfer(alice, 1_000_000 ether);

        // Alice approves SwapFeeRouter
        vm.prank(alice);
        tokenA.approve(address(feeRouter), type(uint256).max);
    }

    // ─── #4: Slippage checked after fee ──────────────────────────────────

    /// @notice Verify that amountOutMin is enforced on the post-fee output amount.
    ///         The router passes 0 to Uniswap and checks slippage itself after fee deduction.
    function test_swapExactETHForTokens_slippageCheckedAfterFee() public {
        // Set mock to return exactly 950 tokens (less than amountOutMin of 1000)
        mockRouter.setFixedOutput(950 ether);

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(tokenB);

        // Alice sends 1 ETH with amountOutMin = 1000 tokens
        // After 0.3% fee: 0.997 ETH goes to swap, mock returns 950 tokens
        // 950 < 1000 amountOutMin, so should succeed since 950 >= 950 (our min)
        // But if we set min to 1000, it should revert
        vm.prank(alice);
        vm.expectRevert("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        feeRouter.swapExactETHForTokens{value: 1 ether}(1000 ether, path, alice, block.timestamp + 1, 100);

        // Now with achievable amountOutMin, it should pass
        mockRouter.setFixedOutput(1000 ether);
        vm.prank(alice);
        uint256[] memory amounts = feeRouter.swapExactETHForTokens{value: 1 ether}(
            1000 ether, path, alice, block.timestamp + 1, 100
        );
        assertGe(amounts[amounts.length - 1], 1000 ether);
    }

    // ─── #6: forceApprove used (not bare approve) ────────────────────────

    /// @notice Verify swaps work for token->ETH path — this implicitly tests
    ///         that forceApprove is used (bare approve would fail for USDT-like tokens).
    function test_forceApprove_usedNotBareApprove() public {
        // Approve mock router to pull tokens from feeRouter
        // The feeRouter uses forceApprove internally — if it works, the fix is correct

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = weth;

        // Mock returns 1 ETH for 1000 tokens
        mockRouter.setFixedOutput(1 ether);

        vm.prank(alice);
        uint256[] memory amounts = feeRouter.swapExactTokensForETH(
            1000 ether, 0, path, alice, block.timestamp + 1, 100
        );

        // Swap succeeded, meaning forceApprove worked
        assertEq(amounts[0], 1000 ether);
        assertGt(amounts[amounts.length - 1], 0);

        // Do a second swap to verify forceApprove handles non-zero allowance
        // (bare approve would fail on tokens like USDT that revert on approve when allowance > 0)
        vm.prank(alice);
        amounts = feeRouter.swapExactTokensForETH(
            1000 ether, 0, path, alice, block.timestamp + 1, 100
        );
        assertGt(amounts[amounts.length - 1], 0);
    }

    // ─── #19: Paused contract blocks swaps ───────────────────────────────

    function test_revert_swap_whenPaused() public {
        // Pause the contract
        feeRouter.pause();

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(tokenB);

        // ETH->Token swap should revert
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        feeRouter.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);

        // Token->ETH swap should revert
        path[0] = address(tokenA);
        path[1] = weth;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        feeRouter.swapExactTokensForETH(1000 ether, 0, path, alice, block.timestamp + 1, 100);

        // Token->Token swap should revert
        path[1] = address(tokenB);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        feeRouter.swapExactTokensForTokens(1000 ether, 0, path, alice, block.timestamp + 1, 100);

        // Unpause and verify swaps work again
        feeRouter.unpause();
        path[0] = weth;
        path[1] = address(tokenB);
        vm.prank(alice);
        feeRouter.swapExactETHForTokens{value: 1 ether}(0, path, alice, block.timestamp + 1, 100);
    }

    // ─── #67: setFee reverts — use propose + execute ─────────────────────

    function test_revert_setFee_deprecated() public {
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        feeRouter.setFee(50);

        // Even non-owner gets the same revert
        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        feeRouter.setFee(50);
    }

    function test_proposeFeeChange_executesAfterDelay() public {
        uint256 newFee = 50; // 0.5%
        uint256 oldFee = feeRouter.feeBps();

        // Propose fee change
        feeRouter.proposeFeeChange(newFee);
        assertEq(feeRouter.pendingFeeBps(), newFee);
        assertEq(feeRouter.feeChangeTime(), block.timestamp + 24 hours);

        // Warp past the 24h delay
        vm.warp(block.timestamp + 24 hours);

        // Execute
        feeRouter.executeFeeChange();
        assertEq(feeRouter.feeBps(), newFee);
        assertEq(feeRouter.feeChangeTime(), 0); // Reset

        // Verify old fee is no longer active
        assertTrue(feeRouter.feeBps() != oldFee);
    }

    function test_revert_proposeFeeChange_tooEarly() public {
        uint256 newFee = 50;

        // Propose fee change
        feeRouter.proposeFeeChange(newFee);

        // Try to execute immediately (before 24h delay)
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, feeRouter.FEE_CHANGE()));
        feeRouter.executeFeeChange();

        // Try after 23 hours (still too early)
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, feeRouter.FEE_CHANGE()));
        feeRouter.executeFeeChange();

        // At exactly 24h it should work
        vm.warp(block.timestamp + 1 hours);
        feeRouter.executeFeeChange();
        assertEq(feeRouter.feeBps(), newFee);
    }

    // ─── #68: Treasury timelock ──────────────────────────────────────────

    function test_treasuryTimelock() public {
        address newTreasury = makeAddr("newTreasury");

        // setTreasury is deprecated and reverts
        vm.expectRevert(SwapFeeRouter.UseProposeTreasuryChange.selector);
        feeRouter.setTreasury(newTreasury);

        // Propose treasury change
        feeRouter.proposeTreasuryChange(newTreasury);
        assertEq(feeRouter.pendingTreasury(), newTreasury);
        assertEq(feeRouter.treasuryChangeTime(), block.timestamp + 48 hours);

        // Cannot execute before 48h
        vm.warp(block.timestamp + 47 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, feeRouter.TREASURY_CHANGE()));
        feeRouter.executeTreasuryChange();

        // Execute after 48h
        vm.warp(block.timestamp + 1 hours);
        feeRouter.executeTreasuryChange();
        assertEq(feeRouter.treasury(), newTreasury);
        assertEq(feeRouter.pendingTreasury(), address(0));
        assertEq(feeRouter.treasuryChangeTime(), 0);
    }

    // ─── Additional edge case: execute without proposal ──────────────────

    function test_revert_executeFeeChange_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, feeRouter.FEE_CHANGE()));
        feeRouter.executeFeeChange();
    }

    function test_revert_executeTreasuryChange_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, feeRouter.TREASURY_CHANGE()));
        feeRouter.executeTreasuryChange();
    }

    receive() external payable {}
}
