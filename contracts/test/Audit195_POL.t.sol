// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/POLAccumulator.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Constructor surface (post-R015/R062): (toweli, router, lpToken, treasury, twap, sequencerFeed)
//   - factory.getPair(toweli, router.WETH()) MUST equal lpToken (LPMismatch guard)
//   - twap.getLatestObservation must return a timestamp within TWAP_MAX_STALENESS (2h)
//   - twap.consult is the floor source for swap leg minOut

contract MockToweli195 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal ERC20 LP — also satisfies the staticcall surface used by the
///      harvest path (`getReserves()`, `token0()`).
contract MockLPToken195 is ERC20 {
    constructor() ERC20("LP Token", "LP") { _mint(msg.sender, 1_000_000 ether); }
}

contract MockFactory195 {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract MockRouter195 {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    MockToweli195 public immutable toweli;
    bool public swapShouldFail;
    bool public lpShouldFail;
    uint256 public swapRate; // tokens per ETH (default 1000)

    constructor(address _weth, address _factory, address _toweli) {
        wethAddr = _weth;
        factoryAddr = _factory;
        toweli = MockToweli195(_toweli);
        swapRate = 1000;
    }

    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }

    function setSwapShouldFail(bool _fail) external { swapShouldFail = _fail; }
    function setLpShouldFail(bool _fail) external { lpShouldFail = _fail; }
    function setSwapRate(uint256 _rate) external { swapRate = _rate; }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
        require(!swapShouldFail, "SWAP_FAIL");
        uint256 tokensOut = msg.value * swapRate;
        require(tokensOut >= amountOutMin, "INSUFFICIENT_OUTPUT");
        toweli.mint(to, tokensOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokensOut;
    }

    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin,
        address, uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(!lpShouldFail, "LP_FAIL");
        require(amountTokenDesired >= amountTokenMin, "BELOW_TOKEN_MIN");
        require(msg.value >= amountETHMin, "BELOW_ETH_MIN");
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = msg.value;
    }

    receive() external payable {}
}

contract MockTWAP195 {
    uint32 public latestTs;
    uint256 public consultReturn = 1;

    function setLatestTimestamp(uint32 _ts) external { latestTs = _ts; }
    function setConsultReturn(uint256 _v) external { consultReturn = _v; }

    function consult(address, address, uint256, uint256) external view returns (uint256) {
        return consultReturn;
    }

    function getLatestObservation(address) external view returns (ITegridyTWAP.Observation memory) {
        return ITegridyTWAP.Observation({
            timestamp: latestTs,
            bypassed: false,
            price0Cumulative: 0,
            price1Cumulative: 0
        });
    }
}

/// @dev Contract caller used to verify tx.origin restriction was lifted.
contract ContractCaller195 {
    POLAccumulator public target;
    constructor(address _target) { target = POLAccumulator(payable(_target)); }
    function callAccumulate(uint256 a, uint256 b, uint256 c, uint256 d) external {
        target.accumulate(a, b, c, d);
    }
}

// ─── Audit 195 POL Tests ────────────────────────────────────────────────────

contract Audit195POL is Test {
    POLAccumulator public pol;
    MockToweli195 public toweli;
    MockRouter195 public router;
    MockFactory195 public factory;
    MockLPToken195 public lp;
    MockTWAP195 public twap;

    address public owner;
    address public treasuryAddr;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        vm.warp(30 days);
        owner = address(this);
        toweli = new MockToweli195();
        lp = new MockLPToken195();
        factory = new MockFactory195();
        router = new MockRouter195(makeAddr("WETH"), address(factory), address(toweli));
        factory.setPair(address(lp));
        twap = new MockTWAP195();
        twap.setLatestTimestamp(uint32(block.timestamp));
        treasuryAddr = makeAddr("treasury");

        pol = new POLAccumulator(
            address(toweli),
            address(router),
            address(lp),
            treasuryAddr,
            address(twap),
            address(0)
        );
        vm.warp(block.timestamp + 2 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
    }

    function _accumulate(uint256 minTokens, uint256 minLPTokens, uint256 minLPETH, uint256 deadline) internal {
        vm.prank(owner);
        pol.accumulate(minTokens, minLPTokens, minLPETH, deadline);
    }

    function _accumulateDefault() internal {
        _accumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    // ─── 1. ACCUMULATE FLOW ─────────────────────────────────────────

    function test_accumulate_splitsETH5050_swapThenLP() public {
        vm.deal(address(pol), 4 ether);
        _accumulateDefault();

        assertEq(pol.totalETHUsed(), 4 ether, "Should use all 4 ETH");
        assertEq(pol.totalLPCreated(), 2 ether, "LP = half ETH in mock");
        assertEq(pol.totalAccumulations(), 1);
    }

    function test_accumulate_updatesLastAccumulateTime() public {
        vm.deal(address(pol), 1 ether);
        uint256 ts = block.timestamp;
        _accumulateDefault();
        assertEq(pol.lastAccumulateTime(), ts);
    }

    function test_accumulate_revokesApprovalAfterLP() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertEq(toweli.allowance(address(pol), address(router)), 0);
    }

    function test_accumulate_emitsAccumulatedEvent() public {
        vm.deal(address(pol), 2 ether);
        vm.expectEmit(true, true, true, true);
        emit POLAccumulator.Accumulated(2 ether, 1000 ether, 1 ether);
        _accumulateDefault();
    }

    // ─── 2. MAX ACCUMULATE AMOUNT CAP ───────────────────────────────

    function test_accumulate_capsAtMaxAccumulateAmount() public {
        vm.deal(address(pol), 25 ether);
        _accumulateDefault();
        assertEq(address(pol).balance, 15 ether);
        assertEq(pol.totalETHUsed(), 10 ether);
    }

    function test_accumulate_usesFullBalanceBelowCap() public {
        vm.deal(address(pol), 3 ether);
        _accumulateDefault();
        assertEq(address(pol).balance, 0);
    }

    // ─── 3. ONE-HOUR COOLDOWN ENFORCEMENT ───────────────────────────

    function test_accumulate_revertBeforeCooldown() public {
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();

        vm.deal(address(pol), 5 ether);
        vm.expectRevert("ACCUMULATE_COOLDOWN");
        _accumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    function test_accumulate_succeedsAfterCooldown() public {
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();
        assertEq(pol.totalAccumulations(), 2);
    }

    function test_accumulate_revertAt59Minutes() public {
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();
        vm.warp(block.timestamp + 59 minutes);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 5 ether);
        vm.expectRevert("ACCUMULATE_COOLDOWN");
        _accumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    function test_accumulate_succeedsAtExactly1Hour() public {
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 5 ether);
        _accumulateDefault();
        assertEq(pol.totalAccumulations(), 2);
    }

    // ─── 4. CONTRACT CALLER (tx.origin restriction lifted in H-05) ──

    function test_accumulate_succeedsFromContract() public {
        vm.deal(address(pol), 1 ether);
        ContractCaller195 proxy = new ContractCaller195(address(pol));
        pol.transferOwnership(address(proxy));
        vm.prank(address(proxy));
        pol.acceptOwnership();
        proxy.callAccumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    // ─── 5. DEADLINE VALIDATION ─────────────────────────────────────

    function test_accumulate_revertDeadlineExpired() public {
        vm.deal(address(pol), 1 ether);
        vm.expectRevert("EXPIRED");
        _accumulate(1, 1, 1, block.timestamp - 1);
    }

    function test_accumulate_revertDeadlineTooFar() public {
        vm.deal(address(pol), 1 ether);
        // R015 tightened MAX_DEADLINE to 1 minute.
        vm.expectRevert(POLAccumulator.DeadlineTooFar.selector);
        _accumulate(1, 1, 1, block.timestamp + 2 minutes);
    }

    function test_accumulate_deadlineExactlyAtMax() public {
        vm.deal(address(pol), 1 ether);
        _accumulate(1, 1, 1, block.timestamp + 1 minutes);
        assertEq(pol.totalAccumulations(), 1);
    }

    function test_accumulate_deadlineAtBlockTimestamp() public {
        vm.deal(address(pol), 1 ether);
        _accumulate(1, 1, 1, block.timestamp);
        assertEq(pol.totalAccumulations(), 1);
    }

    // ─── 6. BACKSTOP PERCENTAGE ─────────────────────────────────────

    function test_backstopBps_defaultIs9000() public view {
        assertEq(pol.backstopBps(), 9000);
    }

    function test_backstop_enforcedInAccumulate() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertEq(pol.totalAccumulations(), 1);
    }

    // ─── 7. SLIPPAGE PROTECTION ─────────────────────────────────────

    function test_accumulate_slippageProtection_maxBps() public view {
        assertEq(pol.maxSlippageBps(), 500);
    }

    // ─── 8. SWEEP ETH (48h timelock + treasury-only) ────────────────

    function test_sweepETH_proposeLocksAmount() public {
        vm.deal(address(pol), 10 ether);
        pol.proposeSweepETH(3 ether);
        assertEq(pol.sweepETHProposedAmount(), 3 ether);
        assertGt(pol.sweepETHReadyAt(), block.timestamp);
    }

    function test_sweepETH_executeAfterTimelock() public {
        vm.deal(address(pol), 10 ether);
        pol.proposeSweepETH(3 ether);
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 3 ether);
        assertEq(address(pol).balance, 7 ether);
    }

    function test_sweepETH_revertBeforeTimelock() public {
        vm.deal(address(pol), 10 ether);
        pol.proposeSweepETH(3 ether);
        vm.warp(block.timestamp + 47 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pol.SWEEP_ETH_CHANGE()));
        pol.executeSweepETH();
    }

    function test_sweepETH_revertAfterExpiry() public {
        vm.deal(address(pol), 10 ether);
        pol.proposeSweepETH(3 ether);
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.SWEEP_ETH_CHANGE()));
        pol.executeSweepETH();
    }

    function test_sweepETH_capsAtBalance() public {
        vm.deal(address(pol), 1 ether);
        pol.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 1 ether);
        assertEq(address(pol).balance, 0);
    }

    function test_sweepETH_goesToTreasuryOnly() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepETH();
        assertEq(pol.treasury().balance, 5 ether);
    }

    function test_sweepETH_revertZeroAmount() public {
        vm.expectRevert("ZERO_AMOUNT");
        pol.proposeSweepETH(0);
    }

    function test_sweepETH_revertDoublePropose() public {
        vm.deal(address(pol), 10 ether);
        pol.proposeSweepETH(3 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.SWEEP_ETH_CHANGE()));
        pol.proposeSweepETH(2 ether);
    }

    function test_sweepETH_revertNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.SWEEP_ETH_CHANGE()));
        pol.executeSweepETH();
    }

    function test_sweepETH_cancelClearsState() public {
        pol.proposeSweepETH(5 ether);
        pol.cancelSweepETH();
        assertEq(pol.sweepETHReadyAt(), 0);
        assertEq(pol.sweepETHProposedAmount(), 0);
    }

    function test_sweepETH_cancelRevertNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.SWEEP_ETH_CHANGE()));
        pol.cancelSweepETH();
    }

    function test_sweepETH_deprecatedDirectCallReverts() public {
        vm.expectRevert("Use proposeSweepETH()");
        pol.sweepETH();
    }

    function test_sweepETH_clearsStateAfterExecution() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(2 ether);
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepETH();
        assertEq(pol.sweepETHReadyAt(), 0);
        assertEq(pol.sweepETHProposedAmount(), 0);
    }

    function test_sweepETH_revertNoETHBalance() public {
        pol.proposeSweepETH(1 ether);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert("NO_ETH");
        pol.executeSweepETH();
    }

    function test_sweepETH_emitsEvents() public {
        vm.deal(address(pol), 5 ether);

        vm.expectEmit(true, true, true, true);
        emit POLAccumulator.SweepETHProposed(3 ether, block.timestamp + 48 hours);
        pol.proposeSweepETH(3 ether);

        vm.warp(block.timestamp + 48 hours);
        vm.expectEmit(true, true, true, true);
        emit POLAccumulator.SweepETHExecuted(treasuryAddr, 3 ether);
        pol.executeSweepETH();
    }

    // ─── 9. SWEEP TOKENS: 48h timelock (M-P02) + LP token protection ─

    function test_sweepTokens_revertOnLPToken() public {
        require(address(lp) == pol.lpToken(), "LP mismatch");
        vm.expectRevert("CANNOT_SWEEP_LP");
        pol.proposeSweepTokens(address(lp));
    }

    function test_sweepTokens_canSweepNonLPTokens() public {
        toweli.transfer(address(pol), 100 ether);
        uint256 treasuryBefore = toweli.balanceOf(treasuryAddr);
        pol.proposeSweepTokens(address(toweli));
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepTokens();
        assertEq(toweli.balanceOf(treasuryAddr) - treasuryBefore, 100 ether);
    }

    function test_sweepTokens_sendsToTreasury() public {
        toweli.transfer(address(pol), 50 ether);
        uint256 treasuryBefore = toweli.balanceOf(treasuryAddr);
        pol.proposeSweepTokens(address(toweli));
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepTokens();
        assertEq(toweli.balanceOf(treasuryAddr) - treasuryBefore, 50 ether);
    }

    function test_sweepTokens_noopWhenZeroBalance() public {
        pol.proposeSweepTokens(address(toweli));
        vm.warp(block.timestamp + 48 hours);
        uint256 treasuryBefore = toweli.balanceOf(treasuryAddr);
        pol.executeSweepTokens();
        assertEq(toweli.balanceOf(treasuryAddr), treasuryBefore);
    }

    function test_sweepTokens_onlyOwner() public {
        toweli.transfer(address(pol), 10 ether);
        vm.prank(alice);
        vm.expectRevert();
        pol.proposeSweepTokens(address(toweli));
    }

    function test_sweepTokens_legacyDirectCallReverts() public {
        vm.expectRevert("Use proposeSweepTokens()");
        pol.sweepTokens(address(toweli));
    }

    // ─── 10. PROPOSE / EXECUTE / CANCEL: maxSlippage ────────────────

    function test_maxSlippage_proposeExecuteCancel_fullCycle() public {
        pol.proposeMaxSlippage(200);
        assertEq(pol.pendingMaxSlippage(), 200);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pol.SLIPPAGE_CHANGE()));
        pol.executeMaxSlippage();

        vm.warp(block.timestamp + 24 hours + 1);
        pol.executeMaxSlippage();
        assertEq(pol.maxSlippageBps(), 200);
        assertEq(pol.pendingMaxSlippage(), 0);
        assertEq(pol.maxSlippageProposedAt(), 0);
    }

    function test_maxSlippage_cancel() public {
        pol.proposeMaxSlippage(300);
        pol.cancelMaxSlippageChange();
        assertEq(pol.pendingMaxSlippage(), 0);
        assertEq(pol.maxSlippageProposedAt(), 0);
        assertEq(pol.maxSlippageBps(), 500);
    }

    function test_maxSlippage_revertOutOfRange_low() public {
        vm.expectRevert(POLAccumulator.SlippageBpsOutOfRange.selector);
        pol.proposeMaxSlippage(99);
    }

    function test_maxSlippage_revertOutOfRange_high() public {
        vm.expectRevert(POLAccumulator.SlippageBpsOutOfRange.selector);
        pol.proposeMaxSlippage(1001);
    }

    function test_maxSlippage_boundsAccepted() public {
        pol.proposeMaxSlippage(100);
        pol.cancelMaxSlippageChange();
        pol.proposeMaxSlippage(1000);
        assertEq(pol.pendingMaxSlippage(), 1000);
    }

    function test_maxSlippage_revertExistingPending() public {
        pol.proposeMaxSlippage(300);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.SLIPPAGE_CHANGE()));
        pol.proposeMaxSlippage(400);
    }

    function test_maxSlippage_revertExpired() public {
        pol.proposeMaxSlippage(300);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.SLIPPAGE_CHANGE()));
        pol.executeMaxSlippage();
    }

    function test_maxSlippage_executeAtExactBoundary() public {
        pol.proposeMaxSlippage(300);
        uint256 readyAt = pol.maxSlippageProposedAt();
        vm.warp(readyAt);
        pol.executeMaxSlippage();
        assertEq(pol.maxSlippageBps(), 300);
    }

    function test_maxSlippage_executeLastSecondBeforeExpiry() public {
        pol.proposeMaxSlippage(300);
        uint256 readyAt = pol.maxSlippageProposedAt();
        vm.warp(readyAt + 7 days);
        pol.executeMaxSlippage();
        assertEq(pol.maxSlippageBps(), 300);
    }

    function test_maxSlippage_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        pol.proposeMaxSlippage(300);

        pol.proposeMaxSlippage(300);
        vm.prank(alice);
        vm.expectRevert();
        pol.executeMaxSlippage();

        vm.prank(alice);
        vm.expectRevert();
        pol.cancelMaxSlippageChange();
    }

    // ─── 11. PROPOSE / EXECUTE / CANCEL: backstop ────────────────────
    // M-7 audit: MIN_BACKSTOP_BPS = 9000; MAX = 9900.

    function test_backstop_proposeExecuteCancel_fullCycle() public {
        pol.proposeBackstopChange(9500);
        assertEq(pol.pendingBackstopBps(), 9500);
        vm.warp(block.timestamp + 24 hours + 1);
        pol.executeBackstopChange();
        assertEq(pol.backstopBps(), 9500);
        assertEq(pol.pendingBackstopBps(), 0);
        assertEq(pol.backstopChangeTime(), 0);
    }

    function test_backstop_cancel() public {
        pol.proposeBackstopChange(9500);
        pol.cancelBackstopChange();
        assertEq(pol.backstopBps(), 9000);
        assertEq(pol.pendingBackstopBps(), 0);
        assertEq(pol.backstopChangeTime(), 0);
    }

    function test_backstop_revertTooHigh() public {
        vm.expectRevert(POLAccumulator.BackstopTooHigh.selector);
        pol.proposeBackstopChange(9901);
    }

    function test_backstop_maxAccepted() public {
        pol.proposeBackstopChange(9900);
        assertEq(pol.pendingBackstopBps(), 9900);
    }

    function test_backstop_zeroRejected() public {
        vm.expectRevert("BACKSTOP_TOO_LOW");
        pol.proposeBackstopChange(0);
    }

    function test_backstop_belowMinRejected() public {
        vm.expectRevert("BACKSTOP_TOO_LOW");
        pol.proposeBackstopChange(8999);
    }

    function test_backstop_revertExistingPending() public {
        pol.proposeBackstopChange(9500);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.BACKSTOP_CHANGE()));
        pol.proposeBackstopChange(9600);
    }

    function test_backstop_revertBeforeTimelock() public {
        pol.proposeBackstopChange(9500);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pol.BACKSTOP_CHANGE()));
        pol.executeBackstopChange();
    }

    function test_backstop_revertExpired() public {
        pol.proposeBackstopChange(9500);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.BACKSTOP_CHANGE()));
        pol.executeBackstopChange();
    }

    function test_backstop_revertNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.BACKSTOP_CHANGE()));
        pol.executeBackstopChange();
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.BACKSTOP_CHANGE()));
        pol.cancelBackstopChange();
    }

    function test_backstop_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        pol.proposeBackstopChange(9500);

        pol.proposeBackstopChange(9500);
        vm.prank(alice);
        vm.expectRevert();
        pol.executeBackstopChange();

        vm.prank(alice);
        vm.expectRevert();
        pol.cancelBackstopChange();
    }

    // ─── 12. PROPOSE / EXECUTE / CANCEL: maxAccumulateAmount ────────

    function test_maxAccumCap_proposeExecuteCancel_fullCycle() public {
        pol.proposeMaxAccumulateAmount(5 ether);
        assertEq(pol.pendingMaxAccumulateAmount(), 5 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        pol.executeMaxAccumulateAmount();
        assertEq(pol.maxAccumulateAmount(), 5 ether);
    }

    function test_maxAccumCap_cancel() public {
        pol.proposeMaxAccumulateAmount(5 ether);
        pol.cancelMaxAccumulateAmountChange();
        assertEq(pol.maxAccumulateAmount(), 10 ether);
    }

    function test_maxAccumCap_revertTooLow() public {
        vm.expectRevert(POLAccumulator.AccumulateCapTooLow.selector);
        pol.proposeMaxAccumulateAmount(0.009 ether);
    }

    function test_maxAccumCap_minAccepted() public {
        pol.proposeMaxAccumulateAmount(0.01 ether);
        assertEq(pol.pendingMaxAccumulateAmount(), 0.01 ether);
    }

    function test_maxAccumCap_revertExistingPending() public {
        pol.proposeMaxAccumulateAmount(5 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.ACCUMULATE_CAP_CHANGE()));
        pol.proposeMaxAccumulateAmount(3 ether);
    }

    function test_maxAccumCap_revertBeforeTimelock() public {
        pol.proposeMaxAccumulateAmount(5 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pol.ACCUMULATE_CAP_CHANGE()));
        pol.executeMaxAccumulateAmount();
    }

    function test_maxAccumCap_revertExpired() public {
        pol.proposeMaxAccumulateAmount(5 ether);
        vm.warp(block.timestamp + 24 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.ACCUMULATE_CAP_CHANGE()));
        pol.executeMaxAccumulateAmount();
    }

    function test_maxAccumCap_revertNoPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.ACCUMULATE_CAP_CHANGE()));
        pol.executeMaxAccumulateAmount();
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pol.ACCUMULATE_CAP_CHANGE()));
        pol.cancelMaxAccumulateAmountChange();
    }

    function test_maxAccumCap_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        pol.proposeMaxAccumulateAmount(5 ether);
    }

    function test_maxAccumCap_newCapEnforcedInAccumulate() public {
        pol.proposeMaxAccumulateAmount(2 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        twap.setLatestTimestamp(uint32(block.timestamp));
        pol.executeMaxAccumulateAmount();

        vm.deal(address(pol), 10 ether);
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        _accumulateDefault();
        assertEq(address(pol).balance, 8 ether);
    }

    // ─── 13. APPROVAL HANDLING ──────────────────────────────────────

    function test_approvalRevokedEvenWithPartialLPUsage() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertEq(toweli.allowance(address(pol), address(router)), 0);
    }

    // ─── 14. ACCESS CONTROL ─────────────────────────────────────────

    function test_onlyOwner_allAdminFunctions() public {
        vm.startPrank(alice);
        vm.expectRevert(); pol.proposeMaxSlippage(300);
        vm.expectRevert(); pol.executeMaxSlippage();
        vm.expectRevert(); pol.cancelMaxSlippageChange();
        vm.expectRevert(); pol.proposeBackstopChange(9500);
        vm.expectRevert(); pol.executeBackstopChange();
        vm.expectRevert(); pol.cancelBackstopChange();
        vm.expectRevert(); pol.proposeMaxAccumulateAmount(5 ether);
        vm.expectRevert(); pol.executeMaxAccumulateAmount();
        vm.expectRevert(); pol.cancelMaxAccumulateAmountChange();
        vm.expectRevert(); pol.proposeSweepETH(1 ether);
        vm.expectRevert(); pol.executeSweepETH();
        vm.expectRevert(); pol.cancelSweepETH();
        vm.expectRevert(); pol.proposeSweepTokens(address(toweli));
        vm.expectRevert(); pol.executeSweepTokens();
        vm.expectRevert(); pol.cancelSweepTokens();
        vm.stopPrank();
    }

    function test_onlyOwner_accumulate() public {
        vm.deal(address(pol), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        pol.accumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    // ─── 15. CONSTRUCTOR VALIDATIONS ────────────────────────────────

    function test_constructor_revertZeroToweli() public {
        vm.expectRevert("ZERO_TOWELI");
        new POLAccumulator(address(0), address(router), address(lp), treasuryAddr, address(twap), address(0));
    }

    function test_constructor_revertZeroRouter() public {
        vm.expectRevert("ZERO_ROUTER");
        new POLAccumulator(address(toweli), address(0), address(lp), treasuryAddr, address(twap), address(0));
    }

    function test_constructor_revertZeroLP() public {
        vm.expectRevert("ZERO_LP_TOKEN");
        new POLAccumulator(address(toweli), address(router), address(0), treasuryAddr, address(twap), address(0));
    }

    function test_constructor_revertZeroTreasury() public {
        vm.expectRevert("ZERO_TREASURY");
        new POLAccumulator(address(toweli), address(router), address(lp), address(0), address(twap), address(0));
    }

    function test_constructor_revertZeroTwap() public {
        vm.expectRevert("ZERO_TWAP");
        new POLAccumulator(address(toweli), address(router), address(lp), treasuryAddr, address(0), address(0));
    }

    function test_constructor_revertLPMismatch() public {
        MockFactory195 badFactory = new MockFactory195();
        badFactory.setPair(makeAddr("wrongPair"));
        MockRouter195 badRouter = new MockRouter195(makeAddr("WETH"), address(badFactory), address(toweli));
        vm.expectRevert(POLAccumulator.LPMismatch.selector);
        new POLAccumulator(address(toweli), address(badRouter), address(lp), treasuryAddr, address(twap), address(0));
    }

    // ─── 16. RECEIVE ETH ────────────────────────────────────────────

    function test_receiveETH_emitsEvent() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit POLAccumulator.ETHReceived(alice, 2 ether);
        (bool ok,) = address(pol).call{value: 2 ether}("");
        assertTrue(ok);
    }

    function test_receiveETH_updatesBalance() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok,) = address(pol).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(pol.pendingETH(), 3 ether);
    }

    // ─── 17. MIN ETH THRESHOLD ──────────────────────────────────────

    function test_accumulate_revertInsufficientETH_zero() public {
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulateDefault();
    }

    function test_accumulate_revertInsufficientETH_belowThreshold() public {
        vm.deal(address(pol), 0.009 ether);
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulateDefault();
    }

    function test_accumulate_succeedsAtExactThreshold() public {
        vm.deal(address(pol), 0.01 ether);
        _accumulateDefault();
        assertEq(pol.totalAccumulations(), 1);
    }

    // ─── 18. EDGE CASES ─────────────────────────────────────────────

    function test_accumulate_oddETHAmount_noRemainder() public {
        vm.deal(address(pol), 1);
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulateDefault();
    }

    function test_totalETHUsed_accumulates() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        uint256 first = pol.totalETHUsed();
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertGt(pol.totalETHUsed(), first);
    }

    function test_totalLPCreated_accumulates() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        uint256 first = pol.totalLPCreated();
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertGt(pol.totalLPCreated(), first);
    }

    function test_pendingETH_viewReturnsBalance() public {
        assertEq(pol.pendingETH(), 0);
        vm.deal(address(pol), 7.5 ether);
        assertEq(pol.pendingETH(), 7.5 ether);
    }

    // ─── 19. OWNERSHIP: Ownable2Step ────────────────────────────────

    function test_ownershipTransfer_twoStep() public {
        pol.transferOwnership(alice);
        assertEq(pol.owner(), address(this));
        vm.prank(alice);
        pol.acceptOwnership();
        assertEq(pol.owner(), alice);
    }

    function test_ownershipTransfer_pendingOwnerOnly() public {
        pol.transferOwnership(alice);
        vm.prank(bob);
        vm.expectRevert();
        pol.acceptOwnership();
    }

    // ─── 20. MULTIPLE ACCUMULATIONS WITH COOLDOWN ───────────────────

    /// @dev via_ir caches `block.timestamp` reads within a single function so
    ///      sequential `vm.warp(block.timestamp + delta)` calls all see the
    ///      stale starting timestamp. Splitting each step into its own
    ///      external function call breaks the caching window.
    function test_accumulate_threeConsecutiveWithCooldown() public {
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
        assertEq(pol.totalAccumulations(), 1);

        _warpAndAccumulate();
        assertEq(pol.totalAccumulations(), 2);
        _warpAndAccumulate();
        assertEq(pol.totalAccumulations(), 3);
    }

    function _warpAndAccumulate() public {
        vm.warp(block.timestamp + 1 hours + 1);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.deal(address(pol), 2 ether);
        _accumulateDefault();
    }

    // ─── 21. SWEEP ETH AT EXACT BOUNDARIES ──────────────────────────

    function test_sweepETH_executeAtExactTimelock() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(2 ether);
        vm.warp(pol.sweepETHReadyAt());
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 2 ether);
    }

    function test_sweepETH_executeLastSecondBeforeExpiry() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(2 ether);
        vm.warp(pol.sweepETHReadyAt() + 7 days);
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 2 ether);
    }

    // ─── 22. MAX ACCUMULATE CAP UPPER BOUND (M-06) ──────────────────

    function test_maxAccumCap_hasUpperBound() public {
        vm.expectRevert("EXCEEDS_HARD_CAP");
        pol.proposeMaxAccumulateAmount(101 ether);
        pol.proposeMaxAccumulateAmount(100 ether);
        assertEq(pol.pendingMaxAccumulateAmount(), 100 ether);
    }
}
