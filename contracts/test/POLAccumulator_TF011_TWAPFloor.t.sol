// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/POLAccumulator.sol";

/**
 * TF-011 - the TWAP floor was priced against a swap that cannot exist.
 *
 * `_twapMinOut` derives its floor from `TegridyTWAP.consult`, which returns
 * `mulDiv(amountIn, priceDiff, elapsed * Q112)`: a LINEAR time-weighted price with
 * no swap fee and no price-impact term. It was then compared against the output of
 * a real constant-product pool that charges 0.3% and moves against the trade. So
 * the 50 bps TWAP_SAFETY_BPS budget had to pay the 30 bps fee before it could
 * absorb any impact at all, and accumulate() reverted on ordinary-sized deployments.
 *
 * WHY EVERY EXISTING POL TEST IS BLIND TO THIS. MockRouter in POLAccumulator.t.sol
 * mints msg.value * 1000 - no reserves, no fee, no impact - and MockTWAP.consult
 * returns a CONSTANT that ignores amountIn entirely. Under that pair of mocks the
 * floor is slack by orders of magnitude and the defect is unreachable. The harness
 * here is therefore the test: a router that runs the real getAmountOut with its
 * 0.3% fee, and an oracle that SCALES with amountIn off the pool reserves.
 *
 * SIZING, AND WHY THESE NUMBERS. For a constant-product swap of dx into reserve X,
 * output over the linear quote is 997 / (1000 + 997 * dx/X). These tests put 1 ETH
 * in the accumulator, so halfETH = 0.5 ETH against a 150 ETH reserve - dx/X = 1/300,
 * giving a ratio of 0.99370.
 *   pre-fix floor  = 0.9950          -> 0.99370 is BELOW it; no swap can clear it
 *   post-fix floor = 0.9950 * 0.997  =  0.99202 -> 0.99370 clears it
 * Both margins are ~13-17 bps: wide enough not to be rounding noise, tight enough
 * that the test is really about the fee term rather than about slack.
 */

contract TF011Toweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @dev Doubles as the LP token AND the reserve source, exactly like a real pair.
contract TF011Pair is ERC20 {
    address public token0;
    uint112 public r0;
    uint112 public r1;
    uint32 public ts;
    constructor() ERC20("LP", "LP") { ts = uint32(block.timestamp); }
    function setToken0(address t) external { token0 = t; }
    function setReserves(uint112 a, uint112 b) external { r0 = a; r1 = b; ts = uint32(block.timestamp); }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, ts); }
    function mintLP(address to, uint256 a) external { _mint(to, a); }
}

contract TF011Factory {
    address public pair;
    function setPair(address p) external { pair = p; }
    function getPair(address, address) external view returns (address) { return pair; }
}

/// @dev The honest router: canonical UniswapV2 getAmountOut, fee and all.
contract TF011Router {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    TF011Toweli public immutable toweli;
    TF011Pair public immutable pair;

    constructor(address _weth, address _factory, TF011Toweli _toweli, TF011Pair _pair) {
        wethAddr = _weth; factoryAddr = _factory; toweli = _toweli; pair = _pair;
    }
    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }

    function _reserves() internal view returns (uint256 tokenR, uint256 ethR) {
        (uint112 a, uint112 b, ) = pair.getReserves();
        return pair.token0() == address(toweli) ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
    }

    /// @dev Verbatim UniswapV2Library.getAmountOut.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256)
    {
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256)
        external payable returns (uint256[] memory amounts)
    {
        (uint256 tokenR, uint256 ethR) = _reserves();
        uint256 out = getAmountOut(msg.value, ethR, tokenR);
        require(out >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        toweli.mint(to, out);
        _write(tokenR - out, ethR + msg.value);
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = out;
    }

    function addLiquidityETH(address, uint256 amountTokenDesired, uint256, uint256, address to, uint256)
        external payable returns (uint256, uint256, uint256)
    {
        (uint256 tokenR, uint256 ethR) = _reserves();
        _write(tokenR + amountTokenDesired, ethR + msg.value);
        pair.mintLP(to, msg.value);
        return (amountTokenDesired, msg.value, msg.value);
    }

    function _write(uint256 tokenR, uint256 ethR) internal {
        if (pair.token0() == address(toweli)) pair.setReserves(uint112(tokenR), uint112(ethR));
        else pair.setReserves(uint112(ethR), uint112(tokenR));
    }
    receive() external payable {}
}

/// @dev The oracle the real one is: LINEAR IN amountIn, and fee-free.
///      driftBps skews it above spot to model oracle divergence.
contract TF011LinearTWAP {
    TF011Pair public immutable pair;
    TF011Toweli public immutable toweli;
    uint32 public latestTs;
    uint256 public driftBps;

    constructor(TF011Pair _pair, TF011Toweli _t) { pair = _pair; toweli = _t; latestTs = uint32(block.timestamp); }
    function setLatestTimestamp(uint32 t) external { latestTs = t; }
    function setDriftBps(uint256 b) external { driftBps = b; }

    function consult(address, address tokenIn, uint256 amountIn, uint256) external view returns (uint256) {
        (uint112 a, uint112 b, ) = pair.getReserves();
        (uint256 tokenR, uint256 ethR) =
            pair.token0() == address(toweli) ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        uint256 quote = tokenIn == address(toweli)
            ? (amountIn * ethR) / tokenR
            : (amountIn * tokenR) / ethR;
        return quote + (quote * driftBps) / 10_000;
    }

    function getLatestObservation(address) external view returns (ITegridyTWAP.Observation memory) {
        return ITegridyTWAP.Observation({ timestamp: latestTs, bypassed: false, price0Cumulative: 0, price1Cumulative: 0 });
    }
    function lastBypassUsed(address) external pure returns (uint256) { return 0; }
}

contract TF011POLAccumulatorTWAPFloor is Test {
    TF011Toweli toweli;
    TF011Pair pair;
    TF011Factory factory;
    TF011Router router;
    TF011LinearTWAP twap;
    POLAccumulator pol;

    address constant WETH_ADDR = 0x1111111111111111111111111111111111111111;
    uint256 constant ETH_RESERVE = 150 ether;
    uint256 constant TOWELI_RESERVE = 150_000_000 ether;

    function setUp() public {
        vm.warp(10_000);
        // SequencerCheck.sol:165 only permits a zero feed on chain 1; forge
        // defaults to 31337, where a zero feed is a typed refusal by design.
        vm.chainId(1);
        toweli = new TF011Toweli();
        pair = new TF011Pair();
        factory = new TF011Factory();
        factory.setPair(address(pair));
        router = new TF011Router(WETH_ADDR, address(factory), toweli, pair);
        twap = new TF011LinearTWAP(pair, toweli);

        pair.setToken0(address(toweli));
        pair.setReserves(uint112(TOWELI_RESERVE), uint112(ETH_RESERVE));
        twap.setLatestTimestamp(uint32(block.timestamp));

        pol = new POLAccumulator(
            address(toweli), address(router), address(pair), address(this), address(twap), address(0)
        );
        vm.deal(address(pol), 1 ether);
        vm.deal(address(router), 1_000 ether);
    }

    /// The defect itself. 0.5 ETH into a 150 ETH reserve is 33 bps of impact; adding
    /// the 30 bps fee puts the achievable output under the pre-fix 50 bps floor, so
    /// accumulate() reverted on a pool behaving perfectly normally.
    ///
    /// MUTATION: drop the * 997 / 1000 from internalSwapMinOut in POLAccumulator.sol
    /// and this reverts with INSUFFICIENT_OUTPUT_AMOUNT.
    function test_TF011_accumulateClearsTheFloorOnAnOrdinaryPool() public {
        uint256 before = pol.totalAccumulations();
        pol.accumulate(1, 1, 1, block.timestamp + 30);
        assertEq(pol.totalAccumulations(), before + 1, "accumulate must clear its own floor");
    }

    /// ANTI-VACUITY. Passes before AND after the fix by design; its job is to be
    /// mutation-checked against the FIX ITSELF, so the netting cannot quietly become
    /// a blank cheque. Widen it from * 997 / 1000 to * 900 / 1000 and the drift below
    /// starts clearing the floor - this test goes red. It pins the invariant (an
    /// oracle reading above spot still binds the swap), not a literal constant.
    ///
    /// 30 bps is chosen to land in the only window that tests the SWAP FLOOR: the
    /// separate spot-deviation gate (HARVEST_TWAP_DEVIATION_BPS = 50) rejects
    /// anything above 50 bps before the swap is ever attempted, and below ~17 bps the
    /// post-fix floor is satisfied. A larger drift would pass this test for the wrong
    /// reason - ReservesDeviateFromTWAP, not the floor.
    ///   floor    = 1.0030 * 0.9950 * 0.9970 = 0.99499
    ///   available =                            0.99370  -> refused, correctly
    ///   mutated  = 1.0030 * 0.9950 * 0.9000 = 0.89819  -> would clear, test reds
    function test_TF011_anOracleAboveSpotStillBindsTheSwap() public {
        twap.setDriftBps(30);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        pol.accumulate(1, 1, 1, block.timestamp + 30);
    }

    /// The floor must still BIND. Guards against the fix being read as "slippage
    /// protection is optional": the same 0.5 ETH swap into a 5 ETH reserve is ~10%
    /// impact, far beyond any budget, and must still be refused.
    function test_TF011_floorStillBindsAgainstAThinPool() public {
        pair.setReserves(uint112(TOWELI_RESERVE), uint112(5 ether));
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        pol.accumulate(1, 1, 1, block.timestamp + 30);
    }

    receive() external payable {}
}
