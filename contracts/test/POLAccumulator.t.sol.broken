// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/POLAccumulator.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mocks ──────────────────────────────────────────────────────────

contract MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockWETH {
    function WETH() external view returns (address) {
        return address(this);
    }
}

/// @dev Mock router that simulates swapExactETHForTokens and addLiquidityETH
contract MockRouter {
    address public immutable weth;
    MockToweli public immutable toweli;

    constructor(address _weth, address _toweli) {
        weth = _weth;
        toweli = MockToweli(_toweli);
    }

    function WETH() external view returns (address) {
        return weth;
    }

    /// @dev Simulate swap: mint 1000 tokens per ETH sent
    function swapExactETHForTokens(
        uint256, address[] calldata, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
        uint256 tokensOut = msg.value * 1000; // 1000 TOWELI per ETH
        toweli.mint(to, tokensOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokensOut;
    }

    /// @dev Simulate addLiquidityETH: accept all tokens + ETH, return LP count = ethUsed
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256, uint256, address, uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        // Pull tokens from sender
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = msg.value; // LP tokens = ETH used (simplified)
    }

    receive() external payable {}
}

// ─── Tests ──────────────────────────────────────────────────────────

contract POLAccumulatorTest is Test {
    POLAccumulator public accumulator;
    MockToweli public toweli;
    MockRouter public router;

    address public owner;
    address public alice = makeAddr("alice");

    function setUp() public {
        owner = address(this);
        toweli = new MockToweli();
        router = new MockRouter(makeAddr("WETH"), address(toweli));
        accumulator = new POLAccumulator(address(toweli), address(router), makeAddr("lpToken"), makeAddr("treasury"));
        // Warp past the 1-hour accumulate cooldown from deployment
        vm.warp(block.timestamp + 1 hours);
    }

    function _accumulate(uint256 a, uint256 b, uint256 c, uint256 d) internal {
        vm.prank(address(this), address(this));
        accumulator.accumulate(a, b, c, d);
    }

    function _accumulateNow(uint256 a, uint256 b, uint256 c) internal {
        uint256 deadline = block.timestamp + 2 minutes;
        vm.prank(address(this), address(this));
        accumulator.accumulate(a, b, c, deadline);
    }

    // ─── accumulate() happy path ────────────────────────────────────

    function test_accumulate_happyPath() public {
        // Fund the accumulator with 1 ETH
        vm.deal(address(accumulator), 1 ether);

        // Owner calls accumulate with reasonable slippage params
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);

        // Verify stats updated
        assertGt(accumulator.totalETHUsed(), 0, "totalETHUsed should be > 0");
        assertGt(accumulator.totalLPCreated(), 0, "totalLPCreated should be > 0");
        assertEq(accumulator.totalAccumulations(), 1, "totalAccumulations should be 1");
    }

    function test_accumulate_multipleTimes() public {
        vm.deal(address(accumulator), 2 ether);

        _accumulateNow(1, 1, 1);
        // Fund again and warp past cooldown
        vm.deal(address(accumulator), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        _accumulateNow(1, 1, 1);

        assertEq(accumulator.totalAccumulations(), 2);
    }

    function test_accumulate_emitsEvent() public {
        vm.deal(address(accumulator), 1 ether);
        vm.expectEmit(false, false, false, false);
        emit POLAccumulator.Accumulated(0, 0, 0); // We just check event is emitted
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
    }

    // ─── Revert: _minTokens == 0 (SlippageTooHigh) ─────────────────

    function test_accumulate_revertWhen_minTokensZero() public {
        vm.deal(address(accumulator), 1 ether);
        vm.expectRevert(POLAccumulator.SlippageTooHigh.selector);
        _accumulate(0, 1, 1, block.timestamp + 2 minutes);
    }

    // ─── Revert: balance < 0.01 ether (InsufficientETH) ────────────

    function test_accumulate_revertWhen_insufficientETH() public {
        // No ETH in contract
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
    }

    function test_accumulate_revertWhen_balanceBelowThreshold() public {
        // Fund with just below 0.01 ether
        vm.deal(address(accumulator), 0.009 ether);
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
    }

    function test_accumulate_succeedsAt_exactThreshold() public {
        // Fund with exactly 0.01 ether — should pass
        vm.deal(address(accumulator), 0.01 ether);
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
        assertEq(accumulator.totalAccumulations(), 1);
    }

    // ─── onlyOwner access control ───────────────────────────────────

    function test_accumulate_revertWhen_notOwner() public {
        vm.deal(address(accumulator), 1 ether);
        vm.prank(alice, alice);
        vm.expectRevert();
        accumulator.accumulate(1, 1, 1, block.timestamp + 2 minutes);
    }

    // ─── receive() ETH ─────────────────────────────────────────────

    function test_receiveETH() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok,) = address(accumulator).call{value: 2 ether}("");
        assertTrue(ok, "Should accept ETH");
        assertEq(accumulator.pendingETH(), 2 ether);
    }

    // ─── pendingETH view ────────────────────────────────────────────

    function test_pendingETH_returnsBalance() public {
        assertEq(accumulator.pendingETH(), 0);
        vm.deal(address(accumulator), 3 ether);
        assertEq(accumulator.pendingETH(), 3 ether);
    }

    // ─── Ownable2Step: transferOwnership requires accept ────────────

    function test_ownershipTransfer_twoStep() public {
        accumulator.transferOwnership(alice);
        // Owner is still this contract until alice accepts
        assertEq(accumulator.owner(), address(this));

        vm.prank(alice);
        accumulator.acceptOwnership();
        assertEq(accumulator.owner(), alice);
    }

    // ─── MaxSlippage timelock tests ──────────────────────────────────

    function test_proposeMaxSlippage_setsState() public {
        accumulator.proposeMaxSlippage(300);
        assertEq(accumulator.pendingMaxSlippage(), 300);
        assertGt(accumulator.maxSlippageProposedAt(), 0);
    }

    function test_executeMaxSlippage_afterDelay() public {
        accumulator.proposeMaxSlippage(300);
        vm.warp(block.timestamp + 24 hours + 1);
        accumulator.executeMaxSlippage();
        assertEq(accumulator.maxSlippageBps(), 300);
        assertEq(accumulator.pendingMaxSlippage(), 0);
        assertEq(accumulator.maxSlippageProposedAt(), 0);
    }

    function test_revert_executeMaxSlippage_beforeDelay() public {
        accumulator.proposeMaxSlippage(300);
        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, accumulator.SLIPPAGE_CHANGE()));
        accumulator.executeMaxSlippage();
    }

    function test_revert_executeMaxSlippage_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, accumulator.SLIPPAGE_CHANGE()));
        accumulator.executeMaxSlippage();
    }

    function test_revert_executeMaxSlippage_expired() public {
        accumulator.proposeMaxSlippage(300);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, accumulator.SLIPPAGE_CHANGE()));
        accumulator.executeMaxSlippage();
    }

    function test_cancelMaxSlippageChange() public {
        accumulator.proposeMaxSlippage(300);
        accumulator.cancelMaxSlippageChange();
        assertEq(accumulator.pendingMaxSlippage(), 0);
        assertEq(accumulator.maxSlippageProposedAt(), 0);
        // Original value unchanged
        assertEq(accumulator.maxSlippageBps(), 500);
    }

    function test_revert_cancelMaxSlippage_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, accumulator.SLIPPAGE_CHANGE()));
        accumulator.cancelMaxSlippageChange();
    }

    function test_revert_proposeMaxSlippage_existingPending() public {
        accumulator.proposeMaxSlippage(300);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, accumulator.SLIPPAGE_CHANGE()));
        accumulator.proposeMaxSlippage(200);
    }

    function test_revert_proposeMaxSlippage_outOfRange() public {
        vm.expectRevert(POLAccumulator.SlippageBpsOutOfRange.selector);
        accumulator.proposeMaxSlippage(50); // below 100
        vm.expectRevert(POLAccumulator.SlippageBpsOutOfRange.selector);
        accumulator.proposeMaxSlippage(1500); // above 1000
    }

    function test_revert_proposeMaxSlippage_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        accumulator.proposeMaxSlippage(300);
    }

    // ─── M-15: maxAccumulateAmount cap tests ─────────────────────────

    function test_accumulate_capsAtMaxAccumulateAmount() public {
        vm.deal(address(accumulator), 20 ether);
        // Default maxAccumulateAmount is 10 ETH, so only 10 ETH should be used
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
        // After accumulation, 10 ETH should remain (20 - 10 capped)
        assertEq(address(accumulator).balance, 10 ether);
    }

    function test_accumulate_usesFullBalanceWhenBelowCap() public {
        vm.deal(address(accumulator), 5 ether);
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
        assertEq(address(accumulator).balance, 0);
    }

    function test_proposeMaxAccumulateAmount_setsState() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        assertEq(accumulator.pendingMaxAccumulateAmount(), 5 ether);
        assertGt(accumulator.maxAccumulateAmountProposedAt(), 0);
    }

    function test_executeMaxAccumulateAmount_afterDelay() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        accumulator.executeMaxAccumulateAmount();
        assertEq(accumulator.maxAccumulateAmount(), 5 ether);
        assertEq(accumulator.pendingMaxAccumulateAmount(), 0);
    }

    function test_revert_executeMaxAccumulateAmount_beforeDelay() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, accumulator.ACCUMULATE_CAP_CHANGE()));
        accumulator.executeMaxAccumulateAmount();
    }

    function test_revert_executeMaxAccumulateAmount_expired() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, accumulator.ACCUMULATE_CAP_CHANGE()));
        accumulator.executeMaxAccumulateAmount();
    }

    function test_revert_proposeMaxAccumulateAmount_tooLow() public {
        vm.expectRevert(POLAccumulator.AccumulateCapTooLow.selector);
        accumulator.proposeMaxAccumulateAmount(0.001 ether);
    }

    function test_revert_proposeMaxAccumulateAmount_existingPending() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, accumulator.ACCUMULATE_CAP_CHANGE()));
        accumulator.proposeMaxAccumulateAmount(3 ether);
    }

    function test_cancelMaxAccumulateAmountChange() public {
        accumulator.proposeMaxAccumulateAmount(5 ether);
        accumulator.cancelMaxAccumulateAmountChange();
        assertEq(accumulator.pendingMaxAccumulateAmount(), 0);
        assertEq(accumulator.maxAccumulateAmountProposedAt(), 0);
        assertEq(accumulator.maxAccumulateAmount(), 10 ether);
    }

    // ─── M-16: sweepETH amount cap and treasury-only recipient ───────

    function test_proposeSweepETH_locksAmount() public {
        vm.deal(address(accumulator), 5 ether);
        accumulator.proposeSweepETH(2 ether);
        assertEq(accumulator.sweepETHProposedAmount(), 2 ether);
    }

    function test_executeSweepETH_onlySendsProposedAmount() public {
        vm.deal(address(accumulator), 5 ether);
        accumulator.proposeSweepETH(2 ether);
        vm.warp(block.timestamp + 48 hours);
        accumulator.executeSweepETH();
        // Treasury should have received exactly 2 ETH
        assertEq(makeAddr("treasury").balance, 2 ether);
        // Contract should still have 3 ETH
        assertEq(address(accumulator).balance, 3 ether);
    }

    function test_executeSweepETH_capsAtBalance() public {
        vm.deal(address(accumulator), 1 ether);
        accumulator.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        accumulator.executeSweepETH();
        // Treasury gets all available (1 ETH), not the proposed 5
        assertEq(makeAddr("treasury").balance, 1 ether);
    }

    function test_executeSweepETH_goesToTreasury() public {
        vm.deal(address(accumulator), 3 ether);
        accumulator.proposeSweepETH(3 ether);
        vm.warp(block.timestamp + 48 hours);
        accumulator.executeSweepETH();
        assertEq(accumulator.treasury().balance, 3 ether);
    }

    function test_revert_proposeSweepETH_zeroAmount() public {
        vm.expectRevert("ZERO_AMOUNT");
        accumulator.proposeSweepETH(0);
    }

    // ===== X-07: tx.origin check removed (H-05 audit fix) — contract callers now allowed =====

    function test_accumulate_revertsFromContract() public {
        vm.deal(address(accumulator), 1 ether);

        // Deploy a proxy contract that tries to call accumulate
        AccumulateProxy proxy = new AccumulateProxy(address(accumulator));
        accumulator.transferOwnership(address(proxy));
        vm.prank(address(proxy));
        accumulator.acceptOwnership();

        // H-05 audit fix: tx.origin check was removed, so contract callers
        // are now allowed. Verify accumulate() succeeds (does not revert).
        proxy.callAccumulate(1, 1, 1, block.timestamp + 2 minutes);
    }
}

contract AccumulateProxy {
    POLAccumulator public target;

    constructor(address _target) {
        target = POLAccumulator(payable(_target));
    }

    function callAccumulate(uint256 a, uint256 b, uint256 c, uint256 d) external {
        target.accumulate(a, b, c, d);
    }
}
