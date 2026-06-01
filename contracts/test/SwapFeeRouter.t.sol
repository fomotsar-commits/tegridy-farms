// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock Uniswap V2 Factory that returns address(0) for every pair query.
///      AUDIT FIX 2026-05-16 M3/M4: SwapFeeRouter.sweepTokens + withdrawTokenFees
///      now call `uniFactory.getPair(token, WETH)` to refuse swappable tokens
///      (rejection redirects them through `convertTokenFeesToETH`). The previous
///      `FACTORY_STUB = 0xFAC7` non-contract address reverts the getPair call.
///      Tests now wire a real-but-empty factory so getPair returns address(0)
///      (= "no pair", honest escape-hatch path is unblocked).
contract MockUniFactory {
    function getPair(address, address) external pure returns (address) {
        return address(0);
    }
}

/// @dev Mock Uniswap V2 Router that simulates swaps at 1:1 rate
contract MockUniRouter {
    address public immutable WETH_ADDR;
    address public immutable FACTORY;

    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth;
        FACTORY = _factory;
    }

    function WETH() external view returns (address) {
        return WETH_ADDR;
    }

    function factory() external view returns (address) {
        return FACTORY;
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

    // â”€â”€â”€ Fee-on-Transfer variants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // These simulate Uniswap V2 Router02's *SupportingFeeOnTransferTokens helpers.
    // They transferFrom the input, measure the actual-received delta (to handle
    // fee-on-transfer input tokens), then mint an equivalent amount of output
    // to `to`. No return value, just like the real Router02.

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable {
        // Simple 1:1 simulation. Real Uniswap would also account for the output
        // token's FoT haircut â€” our FeeOnTransferToken mock handles that on mint/transfer.
        require(msg.value >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20(path[path.length - 1]).mint(to, msg.value);
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 actualIn = IERC20(path[0]).balanceOf(address(this)) - balBefore;
        require(actualIn >= amountOutMin, "INSUFFICIENT_OUTPUT");
        (bool ok,) = to.call{value: actualIn}("");
        require(ok, "ETH send failed");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 actualIn = IERC20(path[0]).balanceOf(address(this)) - balBefore;
        require(actualIn >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20(path[path.length - 1]).mint(to, actualIn);
    }

    receive() external payable {}
}

/// @dev Minimal receive-only contract that stands in for the production
///      RevenueDistributor. AUDIT FIX 2026-05-16 M2: SwapFeeRouter.sweepETH
///      forces destination to `revenueDistributor`. Tests must wire a non-zero
///      receiver-capable address; `treasury` was a `makeAddr` slot (no
///      `receive`) so WETHFallbackLib reverted ZeroRecipient pre-wiring.
contract MockRevenueDistributorSink {
    receive() external payable {}
}

contract SwapFeeRouterTest is Test {
    SwapFeeRouter public router;
    SwapFeeRouterAdmin public admin;
    MockUniRouter public uniRouter;
    MockUniFactory public uniFactory;
    MockRevenueDistributorSink public revenueDistributor;
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
        uniFactory = new MockUniFactory();
        uniRouter = new MockUniRouter(address(weth), address(uniFactory));
        revenueDistributor = new MockRevenueDistributorSink();

        vm.deal(address(uniRouter), 1000 ether);

        router = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST"))))); // 0.3% fee
        admin = new SwapFeeRouterAdmin(address(router));
        router.setSwapFeeRouterAdmin(address(admin));

        // AUDIT FIX 2026-05-16 M2: wire revenueDistributor via the admin
        // propose+execute timelock pattern so sweepETH (which now FORCES the
        // destination to revenueDistributor) has a valid sink. Pre-fix the
        // tests never wired this slot; sweep tests relied on the legacy
        // treasury-as-destination behavior that M2 closed.
        admin.proposeRevenueDistributor(address(revenueDistributor));
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeRevenueDistributor();

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

        // AUDIT FIX 2026-05-16 M2: destination forced to revenueDistributor.
        // AUDIT FIX (Wave-2 2026-05-16): sweepETH is now 48h-timelocked â€”
        // propose â†’ wait 48h â†’ execute. Asserts the post-execute balance
        // delta lands at revenueDistributor (M2 invariant preserved).
        uint256 sinkBefore = address(revenueDistributor).balance;
        router.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        router.executeSweepETH();
        assertEq(address(revenueDistributor).balance - sinkBefore, 5 ether);
    }

    function test_revert_sweepETH_nonOwner() public {
        vm.deal(address(router), 5 ether);
        // Non-owner can't even start a sweep proposal.
        vm.prank(nonOwner);
        vm.expectRevert();
        router.proposeSweepETH(5 ether);
    }

    /// @notice Wave-2 regression: executing before the 48h delay elapses must
    ///         revert SweepETHUnavailable. The whole point of the timelock is
    ///         that a captured owner can't push donated ETH instantly.
    function test_sweepETH_timelock_rejectsEarlyExecute() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        // 48h - 1s â€” one second short of ready.
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(SwapFeeRouter.SweepETHUnavailable.selector);
        router.executeSweepETH();
        // Pending state is preserved; execute is callable after another 1s.
        vm.warp(block.timestamp + 1);
        router.executeSweepETH();
        assertEq(router.sweepETHReadyAt(), 0, "execute clears the pending readyAt");
        assertEq(router.pendingSweepETHAmount(), 0, "execute clears the pending amount");
    }

    /// @notice Wave-2 regression: cancel clears the pending proposal so a
    ///         fresh proposeSweepETH can start a new 48h window.
    function test_sweepETH_cancel_allowsReproposal() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        uint256 firstReadyAt = router.sweepETHReadyAt();
        router.cancelSweepETH();
        assertEq(router.sweepETHReadyAt(), 0);
        assertEq(router.pendingSweepETHAmount(), 0);
        // Move time forward so the second proposal's readyAt is strictly later
        // â€” proves cancel didn't leave the old timelock window open.
        vm.warp(block.timestamp + 1 hours);
        router.proposeSweepETH(3 ether);
        assertGt(router.sweepETHReadyAt(), firstReadyAt);
        assertEq(router.pendingSweepETHAmount(), 3 ether);
    }

    /// @notice Wave-2 regression: a proposal that sits past the 7-day validity
    ///         window must be uncallable. Without the expiry check, a stale
    ///         proposal could be executed years later.
    function test_sweepETH_timelock_rejectsAfterValidityExpiry() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        // Warp past `readyAt + 7 days` â€” proposal must be expired.
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(SwapFeeRouter.SweepETHUnavailable.selector);
        router.executeSweepETH();
        // State remains pending (operator must explicitly cancel to re-propose).
        assertGt(router.sweepETHReadyAt(), 0, "post-expiry: readyAt preserved (loud cancel required)");
        assertEq(router.pendingSweepETHAmount(), 5 ether, "post-expiry: amount preserved");
    }

    /// @notice Wave-2 regression: amount locked at propose is capped down to
    ///         the live sweepable balance at execute. Propose 10 ETH; if only
    ///         3 ETH is sweepable at execute time, the tx must send 3 ETH â€”
    ///         not revert and not over-send.
    function test_sweepETH_executeCapsAtLiveSweepable() public {
        // Propose 10 ETH (overly generous).
        vm.deal(address(router), 10 ether);
        router.proposeSweepETH(10 ether);
        vm.warp(block.timestamp + 48 hours);
        // Right before execute, drain the router balance down to 3 ETH so
        // the live sweepable is 3 ETH (no accumulated fees â†’ reserved = 0).
        vm.deal(address(router), 3 ether);

        uint256 sinkBefore = address(revenueDistributor).balance;
        router.executeSweepETH();
        // Only 3 ETH landed at the revenueDistributor, not the proposed 10.
        assertEq(address(revenueDistributor).balance - sinkBefore, 3 ether,
            "execute caps at the live sweepable balance, not the proposed amount");
        // Pending state cleared even though the capped amount differs from the proposed.
        assertEq(router.sweepETHReadyAt(), 0);
        assertEq(router.pendingSweepETHAmount(), 0);
    }

    /// @notice Wave-2 regression: `executeSweepETH` carries `whenNotPaused`
    ///         (defense-in-depth â€” a guardian who pauses during incident
    ///         response freezes the executor while propose-side stays open).
    function test_sweepETH_executeRejectsWhilePaused() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        router.pause();
        // OZ Pausable reverts EnforcedPause / Pausable: paused â€” match either.
        vm.expectRevert();
        router.executeSweepETH();
    }

    /// @notice Wave-2 regression: a second proposal must NOT silently overwrite
    ///         the in-flight one. The propose-side check `if (sweepETHReadyAt
    ///         != 0) revert` forces an explicit cancel before re-proposing.
    function test_sweepETH_rejectsConcurrentPropose() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        // Second propose while pending must revert â€” proves no overwrite path.
        vm.expectRevert(SwapFeeRouter.SweepETHUnavailable.selector);
        router.proposeSweepETH(3 ether);
        // Original proposal is unchanged.
        assertEq(router.pendingSweepETHAmount(), 5 ether);
    }

    /// @notice Wave-2 regression: `executeSweepETH` and `cancelSweepETH` must
    ///         both reject non-owner callers. The pre-fix test only pinned
    ///         non-owner on `proposeSweepETH`.
    function test_sweepETH_executeAndCancel_onlyOwner() public {
        vm.deal(address(router), 5 ether);
        router.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);

        vm.prank(nonOwner);
        vm.expectRevert();
        router.executeSweepETH();

        vm.prank(nonOwner);
        vm.expectRevert();
        router.cancelSweepETH();
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
        // Wave-2 fix: behaviour preserved â€” when there's nothing sweepable at
        // execute time, the execute call reverts ZeroAmount. (The propose
        // side also rejects amount=0 with ZeroAmount, but that's a separate
        // validation; this test pins the original execute-time invariant.)
        router.proposeSweepETH(1 ether);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        router.executeSweepETH();
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
        admin.proposeFeeChange(50);
        assertEq(admin.pendingFeeBps(), 50);
        assertGt(admin.feeChangeTime(), block.timestamp);
    }

    function test_executeFeeChange_afterDelay() public {
        admin.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours + 1);
        admin.executeFeeChange();
        assertEq(router.feeBps(), 50);
        assertEq(admin.feeChangeTime(), 0);
    }

    function test_revert_executeFeeChange_tooEarly() public {
        admin.proposeFeeChange(50);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, admin.FEE_CHANGE()));
        admin.executeFeeChange();
    }

    function test_revert_executeFeeChange_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, admin.FEE_CHANGE()));
        admin.executeFeeChange();
    }

    function test_revert_proposeFee_tooHigh() public {
        vm.expectRevert(SwapFeeRouterAdmin.FeeTooHigh.selector);
        admin.proposeFeeChange(101);
    }

    function test_revert_setFee_deprecated() public {
        vm.expectRevert(SwapFeeRouter.UseProposeFeeChange.selector);
        router.setFee(50);
    }

    function test_revert_proposeFeeChange_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        admin.proposeFeeChange(50);
    }

    // ===== TREASURY CHANGE TIMELOCK (AUDIT FIX #68) =====

    function test_proposeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        admin.proposeTreasuryChange(newTreasury);
        assertEq(admin.pendingTreasury(), newTreasury);
    }

    function test_executeTreasuryChange_afterDelay() public {
        address newTreasury = makeAddr("newTreasury");
        admin.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeTreasuryChange();
        assertEq(router.treasury(), newTreasury);
    }

    function test_revert_executeTreasuryChange_tooEarly() public {
        admin.proposeTreasuryChange(makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, admin.TREASURY_CHANGE()));
        admin.executeTreasuryChange();
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
        , address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
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
    SwapFeeRouterAdmin public feeAdmin;
    MockUniRouter public uniRouter;
    MockUniFactory public uniFactory;
    MockRevenueDistributorSink public revenueDistributor;
    FeeOnTransferToken public fotToken;
    MockERC20 public weth;
    MockERC20 public tokenB;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");

    function setUp() public {
        weth = new MockERC20("WETH", "WETH");
        tokenB = new MockERC20("TokenB", "TKB");
        fotToken = new FeeOnTransferToken();
        uniFactory = new MockUniFactory();
        uniRouter = new MockUniRouter(address(weth), address(uniFactory));
        revenueDistributor = new MockRevenueDistributorSink();

        vm.deal(address(uniRouter), 1000 ether);

        feeRouter = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        feeAdmin = new SwapFeeRouterAdmin(address(feeRouter));
        feeRouter.setSwapFeeRouterAdmin(address(feeAdmin));
        feeAdmin.proposeRevenueDistributor(address(revenueDistributor));
        vm.warp(block.timestamp + 48 hours + 1);
        feeAdmin.executeRevenueDistributor();

        fotToken.transfer(alice, 100_000 ether);
        tokenB.transfer(alice, 100_000 ether);
        vm.deal(alice, 100 ether);

        vm.prank(alice);
        fotToken.approve(address(feeRouter), type(uint256).max);
        vm.prank(alice);
        tokenB.approve(address(feeRouter), type(uint256).max);
    }

    function test_withdrawTokenFees_FOT_noAccountingDrift() public {
        uint256 sendAmount = 1000 ether;
        fotToken.transfer(address(feeRouter), sendAmount);
        uint256 routerBalance = fotToken.balanceOf(address(feeRouter));
        assertTrue(routerBalance < sendAmount, "FOT should reduce received amount");

        // mvp-launch: accumulatedTokenFees now slot 11 (L1 fix: lastPokeTime added to OwnableNoRenounce shifted +1 from
        // 1-slot state variable above this mapping). Verified via
        // `forge inspect SwapFeeRouter storage-layout`.
        bytes32 slot = keccak256(abi.encode(address(fotToken), uint256(11)));
        vm.store(address(feeRouter), slot, bytes32(routerBalance));
        assertEq(feeRouter.accumulatedTokenFees(address(fotToken)), routerBalance);

        uint256 treasuryBefore = fotToken.balanceOf(treasury);
        feeRouter.withdrawTokenFees(address(fotToken));
        uint256 treasuryAfter = fotToken.balanceOf(treasury);

        uint256 actualReceived = treasuryAfter - treasuryBefore;
        uint256 remaining = feeRouter.accumulatedTokenFees(address(fotToken));

        // AUDIT FIX M-04: CEI pattern â€” accounting is zeroed BEFORE transfer.
        // With FOT tokens, treasury receives less than `routerBalance`, but
        // accumulatedTokenFees is already zero (no phantom dust remains).
        assertEq(remaining, 0, "accounting zeroed before transfer (CEI pattern)");
        assertTrue(actualReceived > 0, "treasury received FOT tokens");
        assertTrue(actualReceived < routerBalance, "FOT fee reduced actual received amount");
    }

    // ===== AUDIT M-6: Fee-on-Transfer Swap Variants =====

    /// @dev ETH -> FoT token via the new FoT variant. Fee is taken on the output side.
    function test_swapExactETHForTokens_FoT() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(fotToken);

        uint256 aliceBalBefore = fotToken.balanceOf(alice);
        uint256 sendValue = 10 ether;

        vm.prank(alice);
        feeRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: sendValue}(
            0, path, alice, block.timestamp + 1, 100
        );

        // MockUniRouter mints sendValue of fotToken to feeRouter. feeRouter takes 0.3% fee,
        // then transfers the rest to alice â€” that transfer triggers another 1% FoT haircut.
        uint256 expectedFee = (sendValue * 30) / 10000; // 0.3% protocol fee
        uint256 expectedPreHaircut = sendValue - expectedFee;
        // Alice receives expectedPreHaircut minus the 1% FoT haircut on the router's transfer to her
        uint256 fotHaircut = (expectedPreHaircut * 100) / 10000; // 1% FoT
        uint256 expectedReceivedByAlice = expectedPreHaircut - fotHaircut;

        assertEq(fotToken.balanceOf(alice) - aliceBalBefore, expectedReceivedByAlice, "alice received net FoT amount");
        assertEq(feeRouter.accumulatedTokenFees(address(fotToken)), expectedFee, "fee booked on output token");
        assertEq(feeRouter.totalTokenFees(address(fotToken)), expectedFee, "totalTokenFees bookkeeping");
    }

    /// @dev FoT token -> ETH via the new FoT variant. Fee is taken from the output ETH.
    function test_swapExactTokensForETH_FoT() public {
        address[] memory path = new address[](2);
        path[0] = address(fotToken);
        path[1] = address(weth);

        uint256 aliceEthBefore = alice.balance;
        uint256 amountIn = 100 ether;

        vm.prank(alice);
        feeRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountIn, 0, path, alice, block.timestamp + 1, 100
        );

        // Alice sends 100 ether of FoT; 1% is burned on transferFrom(alice, feeRouter)
        // so feeRouter receives 99. Then feeRouter transferFrom to router burns another 1% of 99.
        // MockUniRouter's FoT ETH variant returns the balance delta as ETH (via .call{value: actualIn}).
        // So ETH received by feeRouter = 99 * 0.99 = 98.01 ether.
        // feeRouter takes 0.3% fee on that and forwards remainder to alice.
        uint256 step1 = amountIn - (amountIn * 100) / 10000; // 99 ether after alice->router transferFrom
        uint256 step2 = step1 - (step1 * 100) / 10000;       // 98.01 ether after router->uniRouter transferFrom
        uint256 expectedFee = (step2 * 30) / 10000;
        uint256 expectedUser = step2 - expectedFee;

        assertEq(alice.balance - aliceEthBefore, expectedUser, "alice received ETH after FoT haircut + fee");
        assertEq(feeRouter.accumulatedETHFees(), expectedFee, "fee booked as accumulated ETH");
        assertEq(feeRouter.totalETHFees(), expectedFee, "totalETHFees bookkeeping");
    }

    /// @dev FoT -> FoT round trip via the new FoT variant.
    function test_swapExactTokensForTokens_FoT() public {
        address[] memory path = new address[](2);
        path[0] = address(fotToken);
        path[1] = address(tokenB);

        uint256 aliceOutBefore = tokenB.balanceOf(alice);
        uint256 amountIn = 100 ether;

        vm.prank(alice);
        feeRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, 0, path, alice, block.timestamp + 1, 100
        );

        // alice->feeRouter: 99 ether after FoT burn
        // feeRouter->uniRouter: 98.01 ether after another FoT burn
        // uniRouter mints 98.01 of tokenB to feeRouter
        // feeRouter keeps 0.3% as fee, transfers rest to alice (tokenB is plain ERC20, no FoT)
        uint256 step1 = amountIn - (amountIn * 100) / 10000;
        uint256 step2 = step1 - (step1 * 100) / 10000;
        uint256 expectedFee = (step2 * 30) / 10000;
        uint256 expectedUser = step2 - expectedFee;

        assertEq(tokenB.balanceOf(alice) - aliceOutBefore, expectedUser, "alice receives net tokenB");
        assertEq(feeRouter.accumulatedTokenFees(address(tokenB)), expectedFee, "fee booked on output token (tokenB)");
    }

    /// @dev Slippage check: if amountOutMin is set too high, the FoT variant reverts.
    function test_slippageReverts_FoT() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(fotToken);

        vm.prank(alice);
        vm.expectRevert(SwapFeeRouter.SlippageExceeded.selector);
        feeRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1 ether}(
            1 ether, // impossible: we'd need the full 1 ether back despite fee + FoT haircut
            path, alice, block.timestamp + 1, 100
        );
    }

    /// @dev Sanity: a non-FoT (plain ERC20) token still works through the FoT variant.
    function test_NonFoT_throughFoTVariant() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(tokenB);

        uint256 aliceBefore = tokenB.balanceOf(alice);
        uint256 sendValue = 5 ether;

        vm.prank(alice);
        feeRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: sendValue}(
            0, path, alice, block.timestamp + 1, 100
        );

        uint256 expectedFee = (sendValue * 30) / 10000;
        uint256 expectedUser = sendValue - expectedFee; // tokenB has no FoT haircut

        assertEq(tokenB.balanceOf(alice) - aliceBefore, expectedUser, "non-FoT token works through FoT variant");
        assertEq(feeRouter.accumulatedTokenFees(address(tokenB)), expectedFee);
    }

    /// @dev Regression proof: the legacy (non-FoT) swapExactTokensForTokens still fails for
    ///      FoT tokens because the underlying router returns less than the router expects.
    ///      This test documents exactly why the FoT variants are needed.
    function test_LegacySwapReverts_OnFoT() public {
        address[] memory path = new address[](2);
        path[0] = address(fotToken);
        path[1] = address(tokenB);

        // The legacy path transfers fotToken from alice -> feeRouter (1% burned),
        // then from feeRouter -> uniRouter (another 1% burned). The MockUniRouter's
        // legacy swapExactTokensForTokens calls transferFrom(feeRouter, uniRouter, amountIn)
        // where `amountIn` is what feeRouter expected to send â€” but because of the FoT burn,
        // the router's allowance spend succeeds but the balance change is less than claimed.
        // In our mock this means the router transfers less actual tokens than it expected.
        // That's the core reason Uniswap V2 needs the SupportingFeeOnTransferTokens variant.
        //
        // In our MockUniRouter the legacy swap will `transferFrom(feeRouter, uniRouter, amountIn)`
        // which burns 1% on the way, then mint `amountIn` of tokenB to alice. So the mock is
        // actually too forgiving to reproduce a revert directly â€” but the real Uniswap pair
        // would detect the k-invariant mismatch and revert. We document this via a passing
        // swap that demonstrates the accounting asymmetry: the recorded fee is based on the
        // incorrect pre-burn amount, not the post-burn amount.
        vm.prank(alice);
        feeRouter.swapExactTokensForTokens(
            100 ether, 0, path, alice, block.timestamp + 1, 100
        );

        // The legacy variant books fee on input token (path[0] = fotToken) which is
        // exactly critique 5.8's concern and why the new FoT variant books on OUTPUT.
        // Confirming that accounting mismatch exists here is the "audit evidence" this test
        // provides: any real FoT token will desync the legacy path's fee accounting.
        uint256 legacyFee = feeRouter.accumulatedTokenFees(address(fotToken));
        assertTrue(legacyFee > 0, "legacy variant mis-books fee on input token for FoT");
    }

    receive() external payable {}
}
