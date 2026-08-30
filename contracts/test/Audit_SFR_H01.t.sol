// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
// ROW-8 re-anchor: the canonical-port equivalence suite at the bottom of this file
// exercises the library directly against the same mock pair the conversion tests use.
import {UniswapV2OracleLibrary} from "../src/lib/UniswapV2OracleLibrary.sol";
// ROW8 side-selection pin: the wrapper's token0()==token ternary is the ONE line
// that inverts prices if it regresses. Named import — SwapFeeRouter.sol imports
// these with braces, which does not re-export, so no collision here.
import {SwapFeeRouterConvertLib, IUniswapV2Router02, ISwapFeeRouterUniFactory} from "../src/lib/SwapFeeRouterConvertLib.sol";

/// @title AUDIT SFR-H-01 â€” TWAP-floor minETHOut prevents permissionless conversion sandwich
/// @notice Regression test for the senior-recon HIGH finding on
///         `SwapFeeRouter.convertTokenFeesToETH{,FoT}`. Pre-fix, a permissionless caller
///         could:
///           1. Front-run with a tokenâ†’WETH sell that pushed the spot price down.
///           2. Call convertTokenFeesToETH with `minETHOut = 1 wei` so the conversion
///              executed at the depressed price.
///           3. Back-run with the inverse buy, capturing the spread.
///         The 1h CONVERSION_COOLDOWN throttled repetition but did NOT defend a single
///         MEV bundle.
///
///         The fix derives a TWAP-based minETHOut floor inside the contract from the
///         Uniswap V2 pair's cumulative-price accumulator, applies a 1.5% safety margin,
///         and enforces `effectiveMin = max(callerMinETHOut, twapMinETHOut)`. Caller can
///         only TIGHTEN the floor.
///
///         These tests stand up an in-memory Uniswap V2 pair + factory + router that
///         honors `getReserves` / `price{0,1}CumulativeLast` exactly the way real
///         mainnet pairs do, so the contract's TWAP read is exercised end-to-end. The
///         router's "swap" trades at whatever spot price the attacker sets just before
///         the conversion lands â€” which is the on-chain primitive a sandwich exploits.

contract MockToken_SFR is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1e30);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function burn(address from, uint256 amount) external { _burn(from, amount); }
}

/// @dev Minimal Uniswap V2 pair stub. Holds reserves + cumulative price accumulators
///      identical to the real mainnet pair surface read by SwapFeeRouter.
///      Tests advance the cumulative explicitly via `pokeCumulative` to simulate a
///      stable price baseline being established before the sandwich attempt.
contract MockUniPair_SFR {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 private constant Q112 = 2 ** 112;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// @dev Helper: set reserves (instant price set). Does NOT advance the cumulative â€”
    ///      tests use this to reset the pre-snapshot baseline and to simulate
    ///      attacker-induced spot-price changes between snapshot + conversion.
    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }

    /// @dev Helper: bump the cumulative forward by `secondsElapsed` seconds at the
    ///      CURRENT spot price. Mirrors what _update would do on every swap.
    ///      Tests call this to seed a stable baseline that the SwapFeeRouter snapshot
    ///      then reads, then later the test changes reserves to simulate a sandwich.
    function pokeCumulative(uint32 secondsElapsed) external {
        if (reserve0 == 0 || reserve1 == 0) return;
        uint256 spot0 = (uint256(reserve1) * Q112) / reserve0;
        uint256 spot1 = (uint256(reserve0) * Q112) / reserve1;
        unchecked {
            price0CumulativeLast += spot0 * uint256(secondsElapsed);
            price1CumulativeLast += spot1 * uint256(secondsElapsed);
        }
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
}

contract MockUniFactory_SFR {
    mapping(bytes32 => address) public pairs;

    function setPair(address t0, address t1, address pair) external {
        pairs[_key(t0, t1)] = pair;
        pairs[_key(t1, t0)] = pair;
    }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        return pairs[_key(tokenA, tokenB)];
    }

    function _key(address a, address b) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, b));
    }
}

/// @dev Mock V2 router that honors the SwapFeeRouter constructor's `factory()` read
///      and routes swaps through a per-test in-memory pair. The swap's output ETH
///      amount tracks whatever spot price the test has set on the pair right before
///      the call â€” this is precisely the surface a real sandwich attack manipulates.
contract MockUniRouter_SFR {
    address public immutable WETH_ADDR;
    address public immutable factoryAddr;

    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth;
        factoryAddr = _factory;
    }

    function WETH() external view returns (address) { return WETH_ADDR; }
    function factory() external view returns (address) { return factoryAddr; }

    /// @dev token â†’ ETH swap: prices at the pair's CURRENT spot reserves. The router
    ///      deposits the input tokens and sends out an ETH amount equal to the
    ///      constant-product-respecting output (no fee, no slippage curve â€” kept
    ///      simple so tests assert against an exact expected value).
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2 && path[1] == WETH_ADDR, "BAD_PATH");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        // Look up the pair, compute the constant-product output, send ETH out.
        address pair = MockUniFactory_SFR(factoryAddr).getPair(path[0], WETH_ADDR);
        require(pair != address(0), "NO_PAIR");
        MockUniPair_SFR p = MockUniPair_SFR(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == path[0];
        uint256 reserveToken = tokenIs0 ? r0 : r1;
        uint256 reserveETH = tokenIs0 ? r1 : r0;
        // Uniswap V2 constant-product output formula (no fee for simplicity here).
        uint256 amountOut = (amountIn * reserveETH) / (reserveToken + amountIn);
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT");

        // Update the pair's reserves to reflect the swap (so the cumulative tracking
        // remains consistent with subsequent reads).
        p.setReserves(
            uint112(tokenIs0 ? reserveToken + amountIn : reserveETH - amountOut),
            uint112(tokenIs0 ? reserveETH - amountOut : reserveToken + amountIn)
        );

        (bool ok,) = to.call{value: amountOut}("");
        require(ok, "ETH_SEND_FAIL");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    receive() external payable {}
}

/// @dev Exposes the internal `_readCurrentCumulative` so its token-side selection
///      can be pinned directly (the 2026-08-28 fleet critique's one named gap:
///      the ROW8 tests exercised the canonical library, and the wrapper's
///      side-pick ternary only end-to-end).
contract ConvertLibCumulReader {
    function read(SwapFeeRouterConvertLib.Cfg memory cfg, address token)
        external
        view
        returns (address pair, uint256 currentCum, uint32 currentTs)
    {
        return SwapFeeRouterConvertLib._readCurrentCumulative(cfg, token);
    }
}

contract Audit_SFR_H01 is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter_SFR public uniRouter;
    MockUniFactory_SFR public factory;
    MockUniPair_SFR public pair;
    MockToken_SFR public weth;
    MockToken_SFR public toweli;

    address public treasury = makeAddr("treasury");
    address public attacker = makeAddr("attacker");
    address public keeper   = makeAddr("keeper"); // permissionless conversion caller

    uint256 constant FEE_BPS = 30; // 0.3% global fee (irrelevant to this test surface)

    /// @dev Baseline reserves: 100k TOWELI : 100 ETH â‡’ spot price 1 TOWELI = 0.001 ETH.
    ///      Picked so a sandwich-induced 50% reserve imbalance produces a numerically
    ///      obvious price gap (TWAP says ~0.001 ETH/TOWELI; sandwich-spot says ~0.0005).
    uint112 constant BASELINE_TOWELI = 100_000 ether;
    uint112 constant BASELINE_WETH   = 100 ether;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        weth = new MockToken_SFR("WETH", "WETH");
        toweli = new MockToken_SFR("Toweli", "TOWELI");

        factory = new MockUniFactory_SFR();
        uniRouter = new MockUniRouter_SFR(address(weth), address(factory));
        vm.deal(address(uniRouter), 10_000 ether); // ETH float for swap output

        // Deploy pair with deterministic token0/token1 ordering (TOWELI < WETH iff its
        // address is lower; we sort here so the test is robust against `new` ordering).
        address t0 = address(toweli) < address(weth) ? address(toweli) : address(weth);
        address t1 = address(toweli) < address(weth) ? address(weth) : address(toweli);
        pair = new MockUniPair_SFR(t0, t1);
        factory.setPair(address(toweli), address(weth), address(pair));

        // Seed reserves at the baseline price.
        bool tokenIs0 = address(toweli) == t0;
        if (tokenIs0) {
            pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        } else {
            pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        }

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));

        // Park 100 TOWELI of accumulated fees in the router via vm.store + a direct
        // ERC20 transfer. The vm.store writes `accumulatedTokenFees[address(toweli)]`.
        toweli.transfer(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: storage layout shifted (ownershipTransferExpiresAt
        // added at slot 2, swapFeeRouterAdmin packed with _paused). `accumulatedTokenFees`
        // is now slot 10 (mvp-launch PauseGuardian add shifted +1). Verified via `forge inspect SwapFeeRouter storage-layout`.
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(11)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        assertEq(sfr.accumulatedTokenFees(address(toweli)), 100 ether, "fee balance seed failed");
    }

    /// @dev Helper: poke the cumulative forward by `dt` seconds at the current pair
    ///      spot price + advance block.timestamp by `dt`. Simulates the pair sitting
    ///      idle (no swaps) for the period â€” the canonical prerequisite for a clean
    ///      TWAP read.
    function _advanceTime(uint32 dt) internal {
        pair.pokeCumulative(dt);
        skip(uint256(dt));
    }

    /// @dev AUDIT SFR-M-01 (2026-04-28): canonical 2-hop direct path used by every test
    ///      in this file. Replaces the prior contract-built `[token, WETH]` array now
    ///      that the path is caller-supplied.
    function _directPath() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(toweli);
        path[1] = address(weth);
    }

    /// @dev Helper: simulate the attacker's front-running TOWELIâ†’WETH sell that pushes
    ///      the TOWELI price down right before the keeper's conversion. We just slam
    ///      the reserves to a depressed-TOWELI ratio â€” the swap that lands next will
    ///      see this price.
    function _frontrunSandwich() internal {
        bool tokenIs0 = address(toweli) < address(weth);
        // Push TOWELI reserves up by ~50% (attacker dumped TOWELI), pull WETH down by ~50%.
        if (tokenIs0) {
            pair.setReserves(BASELINE_TOWELI * 3 / 2, BASELINE_WETH * 2 / 3);
        } else {
            pair.setReserves(BASELINE_WETH * 2 / 3, BASELINE_TOWELI * 3 / 2);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Bootstrap gate: first conversion is owner-only
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    function test_SFR_H01_bootstrap_rejects_nonOwner() public {
        // No prior snapshot â†’ permissionless caller hits TWAPBootstrapRequired.
        _advanceTime(60 minutes);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.TWAPBootstrapRequired.selector);
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, block.timestamp + 1 hours);
    }

    function test_SFR_H01_bootstrap_succeeds_forOwner() public {
        _advanceTime(60 minutes);
        // Owner bootstraps â€” caller-supplied minETHOut acts as the only floor for this
        // single call (treasury policy off-chain). Snapshot is written for next time.
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, block.timestamp + 1 hours);
        // Snapshot is non-zero: subsequent calls are permissionless.
        (uint32 ts,) = sfr.lastConversionSnapshot(address(toweli));
        assertGt(ts, 0, "bootstrap snapshot not written");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Sandwich attack: TWAP floor blocks the depressed-price conversion
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev The headline regression: bootstrap â†’ wait the cooldown + TWAP period â†’
    ///      attacker front-runs to push spot price down â†’ permissionless caller tries
    ///      to convert with minETHOut=0 â†’ conversion REVERTS at the inner router's
    ///      INSUFFICIENT_OUTPUT because the contract-derived effectiveMin is the
    ///      TWAP-derived floor, not 1 wei. Without SFR-H-01 the conversion would
    ///      have settled at the depressed price and the attacker's back-run captured
    ///      the spread.
    function test_SFR_H01_sandwich_blocked_by_TWAP_floor() public {
        // 1) Bootstrap snapshot at the baseline price (owner call).
        _advanceTime(60 minutes); // pre-bootstrap idle window so cumulative is meaningful
        uint256 d1 = block.timestamp + 30 minutes;
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, d1);

        // After the bootstrap swap the router consumed 100 TOWELI from the pair, so
        // re-seed reserves at baseline + reseed accumulated fees so the next call has
        // something to convert. We also re-poke the cumulative at the baseline so the
        // second snapshot's TWAP reflects the baseline price, not the post-swap drift.
        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);

        // Clear cooldown gate + accumulate enough TWAP integral.
        skip(2 hours);
        // Re-establish accumulated balance so the next convert has work to do.
        toweli.mint(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(11)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));

        // 2) The 2h skip moved block.timestamp forward, so we need to seed the
        // cumulative integral over those 2 hours at the baseline price for the TWAP
        // to read a clean (non-attacker) baseline. This is the mainnet-realistic
        // scenario: the pair sat at the stable price for the cooldown window, accruing
        // cumulative integral.
        pair.pokeCumulative(uint32(2 hours));

        // 3) Attacker front-runs: dump TOWELI to push spot down by ~33%.
        _frontrunSandwich();

        // 4) Permissionless keeper attempts conversion with minETHOut = 0.
        //    Without SFR-H-01: would settle at the depressed spot, attacker captures spread.
        //    With SFR-H-01:    effectiveMin = TWAP-derived floor; inner router reverts
        //                      INSUFFICIENT_OUTPUT because attacker's price < floor.
        // NOTE: see happyPath test for via_ir+block.timestamp miscompilation note.
        uint256 d2 = vm.getBlockTimestamp() + 30 minutes;
        vm.prank(keeper);
        vm.expectRevert("INSUFFICIENT_OUTPUT");
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, d2);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Caller can only TIGHTEN the floor (never relax)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev Mirror of the sandwich test, but the caller passes a HIGHER minETHOut than
    ///      the TWAP floor. The contract enforces `max(callerMin, twapMin) = callerMin`
    ///      and the inner router still reverts (callerMin > attacker price). Confirms
    ///      that "tightening" works and doesn't accidentally bypass the TWAP gate.
    function test_SFR_H01_callerMinETHOut_can_only_tighten() public {
        // Bootstrap.
        _advanceTime(60 minutes);
        uint256 d1 = block.timestamp + 30 minutes;
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, d1);

        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        vm.warp(block.timestamp + 2 hours);
        toweli.mint(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(11)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        pair.pokeCumulative(uint32(2 hours));

        // Sandwich front-run.
        _frontrunSandwich();

        // Caller passes minETHOut = 1 ether (way above what the depressed spot would
        // produce on 100 TOWELI). Conversion still reverts because the inner router
        // sees the attacker's spot.
        // NOTE: see happyPath test for via_ir+block.timestamp miscompilation note.
        uint256 d2 = vm.getBlockTimestamp() + 30 minutes;
        vm.prank(keeper);
        vm.expectRevert("INSUFFICIENT_OUTPUT");
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 1 ether, d2);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Happy path: no sandwich, conversion settles at TWAP-floor or above
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev Sanity: when the pair sits at the baseline price the keeper's conversion
    ///      goes through cleanly. Confirms SFR-H-01 isn't a false-positive that
    ///      bricks the legitimate conversion path.
    function test_SFR_H01_happyPath_legitimateConversion_succeeds() public {
        // Bootstrap.
        _advanceTime(60 minutes);
        uint256 d1 = block.timestamp + 30 minutes;
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, d1);

        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        vm.warp(block.timestamp + 2 hours);
        toweli.mint(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(11)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        pair.pokeCumulative(uint32(2 hours));
        // No front-run; pair stays at baseline.

        uint256 ethBefore = address(sfr).balance;
        // AUDIT note: foundry+via_ir misoptimizes consecutive `block.timestamp + N`
        // reads in this exact callsite (see issue thread: when block.timestamp value
        // changes mid-function via vm.warp, the second `block.timestamp + literal`
        // expression returns a stale value). Workaround: bypass the constant-folding
        // by reading via vm.getBlockTimestamp() which is not foldable.
        uint256 nowTs = vm.getBlockTimestamp();
        uint256 d2 = nowTs + 30 minutes;
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(toweli), _directPath(), 0, d2);
        uint256 ethReceived = address(sfr).balance - ethBefore;
        assertGt(ethReceived, 0, "conversion produced no ETH on happy path");
        // Snapshot updated.
        (uint32 ts,) = sfr.lastConversionSnapshot(address(toweli));
        assertGt(ts, 0, "snapshot not updated after second conversion");
    }

    // ═════════════════════════════════════════════════════════════════
    //  ROW-8 re-anchor (docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md):
    //  SwapFeeRouterConvertLib._readCurrentCumulative now delegates to the
    //  provenance-pinned 0.8 port of canonical UniswapV2OracleLibrary.
    //  These tests pin the port to the exact PRE-refactor integral (the
    //  hand-derived formula this file's fixtures were built around), so a
    //  drifting port fails here even before the provenance gate sees it.
    // ═════════════════════════════════════════════════════════════════

    /// @dev Idle-window bridge: library output must equal storedCum + spot×elapsed on
    ///      BOTH sides, with the uint32-truncated current timestamp — byte-equivalent
    ///      to the removed hand-derivation.
    function test_SFR_ROW8_currentCumulativePrices_matchesPairIntegral() public {
        // _advanceTime pokes FIRST (stamping the pair at the pre-skip timestamp) and
        // then skips, so after this line the pair is already 45 minutes stale.
        _advanceTime(45 minutes);
        uint256 storedCum0 = pair.price0CumulativeLast();
        uint256 storedCum1 = pair.price1CumulativeLast();
        skip(30 minutes); // extend the idle window — bridge must now cover 75 minutes

        (uint112 r0, uint112 r1, uint32 pairTs) = pair.getReserves();
        (uint256 p0, uint256 p1, uint32 ts) = UniswapV2OracleLibrary.currentCumulativePrices(address(pair));

        assertEq(ts, uint32(block.timestamp % 2 ** 32), "blockTimestamp must be uint32-truncated now");
        uint32 elapsed = ts - pairTs;
        assertEq(uint256(elapsed), 75 minutes, "idle window mis-measured");
        assertEq(p0, storedCum0 + ((uint256(r1) << 112) / r0) * elapsed, "price0 counterfactual != stored + spot*elapsed");
        assertEq(p1, storedCum1 + ((uint256(r0) << 112) / r1) * elapsed, "price1 counterfactual != stored + spot*elapsed");
    }

    /// @dev Same-block read: when the pair was touched in this very block the canonical
    ///      library skips the bridge (`blockTimestampLast != blockTimestamp` gate) —
    ///      output must be exactly the stored accumulators.
    function test_SFR_ROW8_sameBlock_noCounterfactual() public {
        _advanceTime(45 minutes);
        // Re-stamp the pair at the CURRENT timestamp with a zero-length poke (adds
        // nothing to the accumulators), then read in the same block: the canonical
        // `blockTimestampLast != blockTimestamp` gate must skip the bridge entirely.
        pair.pokeCumulative(0);

        (uint256 p0, uint256 p1, uint32 ts) = UniswapV2OracleLibrary.currentCumulativePrices(address(pair));

        assertEq(ts, uint32(block.timestamp % 2 ** 32), "blockTimestamp");
        assertEq(p0, pair.price0CumulativeLast(), "same-block read must not add a counterfactual (price0)");
        assertEq(p1, pair.price1CumulativeLast(), "same-block read must not add a counterfactual (price1)");
    }

    /// @dev Accumulator wrap: canonical semantics REQUIRE the counterfactual addition to
    ///      wrap modulo 2^256 ("addition overflow is desired"). Two max-length pokes at
    ///      an extreme reserve ratio park the stored cumulative at exactly 2^256 - 2^225,
    ///      so the next bridge addition provably crosses 2^256. If someone strips the
    ///      port's `unchecked` block, this test dies on Panic(0x11) instead of passing.
    function test_SFR_ROW8_accumulatorWrap_noPanic() public {
        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(1, type(uint112).max);
        else pair.setReserves(type(uint112).max, 1);
        // Each poke adds spotMax * (2^32 - 1) = 2^256 - 2^224 (mod 2^256) to the token
        // side; after two, that side's stored cumulative is exactly 2^256 - 2^225.
        pair.pokeCumulative(type(uint32).max);
        pair.pokeCumulative(type(uint32).max);
        skip(1 hours); // idle window: bridge adds ~2^235.8 >> 2^225 → the add wraps

        (uint112 r0, uint112 r1, uint32 pairTs) = pair.getReserves();
        (uint256 p0, uint256 p1, uint32 ts) = UniswapV2OracleLibrary.currentCumulativePrices(address(pair));

        uint32 elapsed;
        unchecked {
            elapsed = ts - pairTs;
        }
        uint256 want0;
        uint256 want1;
        unchecked {
            want0 = pair.price0CumulativeLast() + ((uint256(r1) << 112) / r0) * elapsed;
            want1 = pair.price1CumulativeLast() + ((uint256(r0) << 112) / r1) * elapsed;
        }
        assertEq(p0, want0, "price0 must wrap modulo 2^256 (canonical V2 semantics)");
        assertEq(p1, want1, "price1 must wrap modulo 2^256 (canonical V2 semantics)");
    }

    /// @dev The inlined FixedPoint.fraction must match the uniswap-lib value + guard:
    ///      (numerator << 112) / denominator, reverting on a zero denominator.
    function test_SFR_ROW8_fraction_matchesFixedPoint() public {
        assertEq(uint256(UniswapV2OracleLibrary.fraction(3, 2)), (uint256(3) << 112) / 2, "fraction value");
        assertEq(
            uint256(UniswapV2OracleLibrary.fraction(type(uint112).max, 1)),
            uint256(type(uint112).max) << 112,
            "fraction at the uint224 ceiling"
        );
        vm.expectRevert(bytes("FixedPoint: DIV_BY_ZERO"));
        this.fractionExternal(1, 0);
    }

    /// @dev expectRevert needs an external call frame; internal library calls inline.
    function fractionExternal(uint112 n, uint112 d) external pure returns (uint224) {
        return UniswapV2OracleLibrary.fraction(n, d);
    }

    /// @dev ROW8 (fleet-critique gap): pin the wrapper's side selection under BOTH
    ///      token orderings. Reserves are asymmetric so price0Cum != price1Cum —
    ///      a flipped ternary cannot return the right number by coincidence.
    ///      Same-block read (poke stamps now) => bridge term is zero and the
    ///      expected value is EXACTLY the stored accumulator for the token side.
    function test_SFR_ROW8_readCurrentCumulative_picksTokenSide_bothOrderings() public {
        ConvertLibCumulReader reader = new ConvertLibCumulReader();
        SwapFeeRouterConvertLib.Cfg memory cfg = SwapFeeRouterConvertLib.Cfg({
            weth: address(weth),
            router: IUniswapV2Router02(address(uniRouter)),
            uniFactory: ISwapFeeRouterUniFactory(address(factory)),
            sequencerFeed: address(0),
            owner: address(this)
        });

        // Case A: token IS token0 of its pair.
        MockToken_SFR tokA = new MockToken_SFR("SideA", "SDA");
        MockUniPair_SFR pairA = new MockUniPair_SFR(address(tokA), address(weth));
        factory.setPair(address(tokA), address(weth), address(pairA));
        pairA.setReserves(100 ether, 5 ether); // asymmetric on purpose
        pairA.pokeCumulative(1000);
        assertTrue(
            pairA.price0CumulativeLast() != pairA.price1CumulativeLast(),
            "fixture must make the two sides distinguishable"
        );
        (address gotPairA, uint256 cumA, uint32 tsA) = reader.read(cfg, address(tokA));
        assertEq(gotPairA, address(pairA));
        assertEq(tsA, uint32(block.timestamp % 2 ** 32));
        assertEq(cumA, pairA.price0CumulativeLast(), "token==token0 must read the price0 accumulator");

        // Case B: token IS token1 of its pair (constructor order reversed).
        MockToken_SFR tokB = new MockToken_SFR("SideB", "SDB");
        MockUniPair_SFR pairB = new MockUniPair_SFR(address(weth), address(tokB));
        factory.setPair(address(tokB), address(weth), address(pairB));
        pairB.setReserves(5 ether, 100 ether);
        pairB.pokeCumulative(1000);
        assertTrue(pairB.price0CumulativeLast() != pairB.price1CumulativeLast());
        (address gotPairB, uint256 cumB,) = reader.read(cfg, address(tokB));
        assertEq(gotPairB, address(pairB));
        assertEq(cumB, pairB.price1CumulativeLast(), "token==token1 must read the price1 accumulator");
    }
}

