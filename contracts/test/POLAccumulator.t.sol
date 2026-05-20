// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/POLAccumulator.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mocks ──────────────────────────────────────────────────────────
//
// API surface required by the post-R015/R062 POLAccumulator constructor:
//   POLAccumulator(_toweli, _router, _lpToken, _treasury, _twap, _sequencerFeed)
//
//  - router must implement WETH() AND factory()
//  - factory.getPair(toweli, router.WETH()) must equal _lpToken (constructor LPMismatch guard)
//  - twap must satisfy ITegridyTWAP {consult, getLatestObservation}
//  - sequencerFeed may be address(0) (mainnet posture, gating disabled)
//  - lpToken must satisfy IERC20 (balanceOf, transfer, approve) for sweep / harvest paths

contract MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal ERC20 standing in for the Uniswap V2 LP pair.
/// @dev AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] —
///      `_assertSpotNearTWAP` now reads pair reserves + token0 via staticcall
///      before every accumulate. Mock surfaces both so the deviation gate can
///      compute spot. Defaults are symmetric (r0 = r1 = 1e18) matching the
///      MockTWAP default consult return (1e18), so the gate passes by default
///      and tests opt-in to manipulation scenarios when needed.
contract MockLPPair is ERC20 {
    address public token0;
    uint112 public r0 = 1 ether;
    uint112 public r1 = 1 ether;
    uint32 public ts;
    constructor() ERC20("LP", "LP") {
        _mint(msg.sender, 1_000_000 ether);
        ts = uint32(block.timestamp);
    }
    function setToken0(address _t0) external { token0 = _t0; }
    function setReserves(uint112 _r0, uint112 _r1) external {
        r0 = _r0;
        r1 = _r1;
        ts = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, ts);
    }
}

contract MockFactory {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract MockRouter {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    MockToweli public immutable toweli;
    uint256 public swapRate = 1000;

    constructor(address _weth, address _factory, address _toweli) {
        wethAddr = _weth;
        factoryAddr = _factory;
        toweli = MockToweli(_toweli);
    }

    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
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
    ) external payable returns (uint256, uint256, uint256) {
        require(amountTokenDesired >= amountTokenMin, "BELOW_TOKEN_MIN");
        require(msg.value >= amountETHMin, "BELOW_ETH_MIN");
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        return (amountTokenDesired, msg.value, msg.value);
    }

    receive() external payable {}
}

/// @dev TWAP mock — lets each test surgically control the latest observation
///      timestamp + the consult() return value.
contract MockTWAP {
    uint32 public latestTs;
    /// @dev AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] —
    ///      default raised from `1` to `1e18` so the new `_assertSpotNearTWAP`
    ///      gate matches MockLPPair's symmetric reserves (1e18 each) by
    ///      default. `_twapMinOut(weth, halfETH)` is still satisfied because
    ///      `consultReturn * (BPS - TWAP_SAFETY_BPS) / BPS ≈ 0.995e18` is far
    ///      below the swap-rate output the MockRouter mints (500e18 / ETH).
    uint256 public consultReturn = 1 ether;

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

    /// @notice PASS7-POL-02 FIX: mock returns 0 (no bypass observed) so the
    ///         POL bypass-cooldown gate is a no-op in legacy tests that don't
    ///         exercise the bypass scenario.
    function lastBypassUsed(address) external pure returns (uint256) {
        return 0;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

contract POLAccumulatorTest is Test {
    POLAccumulator public accumulator;
    MockToweli public toweli;
    MockLPPair public lp;
    MockFactory public factory;
    MockRouter public router;
    MockTWAP public twap;

    address public owner;
    address public alice = makeAddr("alice");
    address public treasuryAddr = makeAddr("treasury");

    function setUp() public {
        // FRESH-2026 TEST REALIGN: contracts now revert SequencerFeedNotConfigured()
        // when feed=address(0) AND chainid != 1. Set chainid to mainnet (1) so the
        // mainnet no-op path engages — these tests don't exercise the L2 sequencer feed.
        vm.chainId(1);
        // Warp to a comfortable baseline so SNAPSHOT/lookback math doesn't underflow
        // and the TWAP observation timestamp can be set "now" cleanly.
        vm.warp(30 days);
        owner = address(this);
        toweli = new MockToweli();
        lp = new MockLPPair();
        factory = new MockFactory();
        router = new MockRouter(makeAddr("WETH"), address(factory), address(toweli));
        // R015 constructor guard: factory.getPair(toweli, weth) MUST equal _lpToken.
        factory.setPair(address(lp));
        // AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] —
        //         wire token0 so `_assertSpotNearTWAP` resolves toweli's side
        //         of the spot ratio correctly. Symmetric reserve defaults
        //         match the default MockTWAP consult (both 1e18), so the
        //         deviation gate is a no-op for happy-path tests; specialized
        //         scenarios opt in via lp.setReserves / twap.setConsultReturn.
        lp.setToken0(address(toweli));
        twap = new MockTWAP();
        twap.setLatestTimestamp(uint32(block.timestamp));

        accumulator = new POLAccumulator(
            address(toweli),
            address(router),
            address(lp),
            treasuryAddr,
            address(twap),
            address(0) // mainnet posture (no sequencer gating)
        );

        // Warp past the 1-hour ACCUMULATE_COOLDOWN baked in at construction.
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
    }

    function _accumulateNow(uint256 a, uint256 b, uint256 c) internal {
        // MAX_DEADLINE was tightened to 1 minute (R015) — use 30s to stay clear.
        uint256 deadline = block.timestamp + 30 seconds;
        vm.prank(owner);
        accumulator.accumulate(a, b, c, deadline);
    }

    // ─── accumulate() happy path ────────────────────────────────────

    function test_accumulate_happyPath() public {
        vm.deal(address(accumulator), 1 ether);
        _accumulateNow(1, 1, 1);

        assertGt(accumulator.totalETHUsed(), 0, "totalETHUsed > 0");
        assertGt(accumulator.totalLPCreated(), 0, "totalLPCreated > 0");
        assertEq(accumulator.totalAccumulations(), 1);
    }

    function test_accumulate_multipleTimes() public {
        vm.deal(address(accumulator), 2 ether);
        _accumulateNow(1, 1, 1);
        // Re-fund and warp past cooldown + refresh TWAP staleness.
        vm.deal(address(accumulator), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        _accumulateNow(1, 1, 1);
        assertEq(accumulator.totalAccumulations(), 2);
    }

    function test_accumulate_emitsEvent() public {
        vm.deal(address(accumulator), 1 ether);
        vm.expectEmit(false, false, false, false);
        emit POLAccumulator.Accumulated(0, 0, 0); // event presence, not values
        _accumulateNow(1, 1, 1);
    }

    // ─── Revert: balance < 0.01 ether (InsufficientETH) ────────────

    function test_accumulate_revertWhen_insufficientETH() public {
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulateNow(1, 1, 1);
    }

    function test_accumulate_revertWhen_balanceBelowThreshold() public {
        vm.deal(address(accumulator), 0.009 ether);
        vm.expectRevert(POLAccumulator.InsufficientETH.selector);
        _accumulateNow(1, 1, 1);
    }

    function test_accumulate_succeedsAt_exactThreshold() public {
        vm.deal(address(accumulator), 0.01 ether);
        _accumulateNow(1, 1, 1);
        assertEq(accumulator.totalAccumulations(), 1);
    }

    // ─── onlyOwner access control ───────────────────────────────────

    function test_accumulate_revertWhen_notOwner() public {
        vm.deal(address(accumulator), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        accumulator.accumulate(1, 1, 1, block.timestamp + 30 seconds);
    }

    // ─── receive() ETH ─────────────────────────────────────────────

    function test_receiveETH() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok,) = address(accumulator).call{value: 2 ether}("");
        assertTrue(ok);
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
        assertEq(accumulator.owner(), address(this), "transfer not yet accepted");
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
        assertEq(accumulator.maxSlippageBps(), 500); // unchanged
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
        // Default cap 10 ether: 10 should be used, 10 left.
        _accumulateNow(1, 1, 1);
        assertEq(address(accumulator).balance, 10 ether);
    }

    function test_accumulate_usesFullBalanceWhenBelowCap() public {
        vm.deal(address(accumulator), 5 ether);
        _accumulateNow(1, 1, 1);
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

    // ─── sweepETH 48h timelock + treasury-only recipient ───────────

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
        assertEq(treasuryAddr.balance, 2 ether);
        assertEq(address(accumulator).balance, 3 ether);
    }

    function test_executeSweepETH_capsAtBalance() public {
        vm.deal(address(accumulator), 1 ether);
        accumulator.proposeSweepETH(5 ether);
        vm.warp(block.timestamp + 48 hours);
        accumulator.executeSweepETH();
        assertEq(treasuryAddr.balance, 1 ether);
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

    // ─── X-07: tx.origin check removed (H-05 audit fix) — contract callers now allowed ─

    function test_accumulate_succeedsFromContract() public {
        vm.deal(address(accumulator), 1 ether);

        // Deploy a proxy contract that calls accumulate as the owner.
        AccumulateProxy proxy = new AccumulateProxy(address(accumulator));
        accumulator.transferOwnership(address(proxy));
        vm.prank(address(proxy));
        accumulator.acceptOwnership();

        // H-05: tx.origin check removed → contract callers are allowed.
        proxy.callAccumulate(1, 1, 1, block.timestamp + 30 seconds);
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
