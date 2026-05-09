// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";

// â”€â”€â”€ Shared mocks (compatible with R028 fixture pattern) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract _Token is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1e30);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract _MockUniPair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 private constant Q112 = 2 ** 112;

    constructor(address t0, address t1) { token0 = t0; token1 = t1; }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0; reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
    function pokeCumulative(uint32 secs) external {
        if (reserve0 == 0 || reserve1 == 0) return;
        unchecked {
            price0CumulativeLast += ((uint256(reserve1) * Q112) / reserve0) * uint256(secs);
            price1CumulativeLast += ((uint256(reserve0) * Q112) / reserve1) * uint256(secs);
        }
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
}

contract _MockUniFactory {
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

contract _MockUniRouter {
    address public immutable WETH_ADDR;
    address public immutable factoryAddr;
    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth; factoryAddr = _factory;
    }
    function WETH() external view returns (address) { return WETH_ADDR; }
    function factory() external view returns (address) { return factoryAddr; }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2 && path[path.length - 1] == WETH_ADDR, "BAD_PATH");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        // Multi-hop simplification: price against path[0]/WETH if it exists, otherwise
        // priced against the FIRST hop's pair (path[0]/path[1]). Matches DEEP-R-H01 test
        // logic where the direct token/WETH pair is INTENTIONALLY ABSENT.
        address pair = _MockUniFactory(factoryAddr).getPair(path[0], WETH_ADDR);
        if (pair == address(0)) {
            pair = _MockUniFactory(factoryAddr).getPair(path[0], path[1]);
        }
        require(pair != address(0), "NO_PAIR");
        _MockUniPair p = _MockUniPair(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == path[0];
        uint256 reserveToken = tokenIs0 ? r0 : r1;
        uint256 reserveOut = tokenIs0 ? r1 : r0;
        uint256 amountOut = (amountIn * reserveOut) / (reserveToken + amountIn);
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT");
        p.setReserves(
            uint112(tokenIs0 ? reserveToken + amountIn : reserveOut - amountOut),
            uint112(tokenIs0 ? reserveOut - amountOut : reserveToken + amountIn)
        );
        (bool ok,) = to.call{value: amountOut}("");
        require(ok, "ETH_SEND_FAIL");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 d
    ) external {
        this.swapExactTokensForETH(amountIn, amountOutMin, path, to, d);
    }

    receive() external payable {}
}

// â”€â”€â”€ DEEP-R-H01: multi-hop conversion bypasses direct-pair TWAP â”€â”€â”€â”€â”€

contract Deep_R_H01_MultiHop is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;
    _Token public alt;   // ALT token: NO direct ALT/WETH pair â€” multi-hop required
    _Token public mid;
    _MockUniPair public altMidPair;

    address public treasury = makeAddr("treasury");
    uint112 constant ALT_RES = 100_000 ether;
    uint112 constant MID_RES = 100 ether;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        weth = new _Token("WETH", "WETH");
        alt  = new _Token("Alt",  "ALT");
        mid  = new _Token("Mid",  "MID");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        vm.deal(address(uniRouter), 10_000 ether);

        // Build ONLY the alt/mid pair. Critically, NO alt/weth pair.
        address t0 = address(alt) < address(mid) ? address(alt) : address(mid);
        address t1 = address(alt) < address(mid) ? address(mid) : address(alt);
        altMidPair = new _MockUniPair(t0, t1);
        factoryC.setPair(address(alt), address(mid), address(altMidPair));
        if (address(alt) == t0) altMidPair.setReserves(ALT_RES, MID_RES);
        else                    altMidPair.setReserves(MID_RES, ALT_RES);

        sfr = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    function _seedFees(uint256 amount) internal {
        alt.transfer(address(sfr), amount);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees moved from slot 8 to slot 9.
        bytes32 slot = keccak256(abi.encode(address(alt), uint256(9)));
        vm.store(address(sfr), slot, bytes32(amount));
    }

    /// @notice Pre-fix, `convertTokenFeesToETH` reverted `NoPairForToken()` even
    ///         though the caller-supplied path does not require a direct alt/WETH pair.
    ///         Post-fix, the multi-hop path bypasses the direct-pair TWAP and falls
    ///         back to caller-supplied minETHOut (owner-only gate).
    function test_multihop_convertWorksWithoutDirectPair() public {
        // Fund + seed fees.
        _seedFees(100 ether);

        address[] memory path = new address[](3);
        path[0] = address(alt); path[1] = address(mid); path[2] = address(weth);

        // AUDIT FIX V3-DEEP-R3-M01: minOut floor raised from `> 0` to
        // `>= MIN_MULTIHOP_ETH_OUT_WEI` (1e14 wei) â€” closes the
        // `minETHOut = 1` bypass.
        sfr.convertTokenFeesToETH(address(alt), path, sfr.MIN_MULTIHOP_ETH_OUT_WEI(), block.timestamp + 30 minutes);

        assertEq(sfr.accumulatedTokenFees(address(alt)), 0, "fees not consumed");
        assertGt(sfr.accumulatedETHFees(), 0, "no ETH credited");
    }

    /// @notice Multi-hop is owner-only; non-owner reverts with `MultiHopOwnerOnly()`.
    function test_multihop_nonOwnerReverts() public {
        _seedFees(100 ether);
        address[] memory path = new address[](3);
        path[0] = address(alt); path[1] = address(mid); path[2] = address(weth);
        // Capture the MIN_MULTIHOP_ETH_OUT_WEI BEFORE the prank â€” vm.prank only
        // applies to the next CALL, and a staticcall to the public constant
        // would consume the prank if read inside the convertTokenFeesToETH arg
        // list.
        uint256 minOut = sfr.MIN_MULTIHOP_ETH_OUT_WEI();
        vm.prank(address(0xBEEF));
        vm.expectRevert(SwapFeeRouter.MultiHopOwnerOnly.selector);
        sfr.convertTokenFeesToETH(address(alt), path, minOut, block.timestamp + 30 minutes);
    }
}

// â”€â”€â”€ DEEP-R-H02: pause guards on distribute / withdraw / recover â”€â”€â”€â”€â”€

contract Deep_R_H02_Pause is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;
    address public treasury = makeAddr("treasury");

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        sfr = new SwapFeeRouter(address(uniRouter), treasury, 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    function test_distributeFeesToStakers_revertsWhenPaused() public {
        sfr.pause();
        vm.expectRevert(); // PausableUpgradeable / OZ Pausable: EnforcedPause
        sfr.distributeFeesToStakers();
    }

    function test_withdrawPendingDistribution_revertsWhenPaused() public {
        sfr.pause();
        vm.expectRevert();
        sfr.withdrawPendingDistribution(address(0xBEEF));
    }

    function test_recoverCallerCredit_revertsWhenPaused() public {
        sfr.pause();
        vm.expectRevert();
        sfr.recoverCallerCredit();
    }
}

// â”€â”€â”€ DEEP-R-M01: admin replacement expiry â”€â”€â”€â”€â”€

contract Deep_R_M01_AdminExpiry is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    SwapFeeRouterAdmin public newAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        sfr = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
        newAdmin = new SwapFeeRouterAdmin(address(sfr));
    }

    /// @notice Pre-fix, a years-old proposal could be executed indefinitely.
    ///         Post-fix, `executeAdminReplacement` reverts after readyAt + 7 days.
    function test_executeAdminReplacement_revertsAfterValidityWindow() public {
        sfr.proposeAdminReplacement(address(newAdmin));
        // Skip past the 7-day timelock and the 7-day validity window.
        skip(7 days + 7 days + 1);
        vm.expectRevert(SwapFeeRouter.AdminReplacementUnavailable.selector);
        sfr.executeAdminReplacement();
    }

    /// @notice Inside the 7-day validity window, execute should still succeed.
    function test_executeAdminReplacement_succeedsInsideValidityWindow() public {
        sfr.proposeAdminReplacement(address(newAdmin));
        skip(7 days + 1 days); // ready + 1 day, well within 7-day window
        sfr.executeAdminReplacement();
        assertEq(sfr.swapFeeRouterAdmin(), address(newAdmin));
    }
}

// â”€â”€â”€ DEEP-R-M02: zero intermediate hop rejected â”€â”€â”€â”€â”€

contract Deep_R_M02_ZeroHop is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;
    _Token public alt;
    _MockUniPair public pair;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        alt  = new _Token("Alt", "ALT");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        address t0 = address(alt) < address(weth) ? address(alt) : address(weth);
        address t1 = address(alt) < address(weth) ? address(weth) : address(alt);
        pair = new _MockUniPair(t0, t1);
        factoryC.setPair(address(alt), address(weth), address(pair));
        sfr = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @notice Pre-fix, `[alt, address(0), weth]` passed validation and could brick
    ///         the FoT swap path. Post-fix, the validator rejects with `InvalidConversionPath`.
    function test_validateConversionPath_rejectsZeroIntermediate() public {
        alt.transfer(address(sfr), 100 ether);
        bytes32 slot = keccak256(abi.encode(address(alt), uint256(8)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));

        address[] memory path = new address[](3);
        path[0] = address(alt); path[1] = address(0); path[2] = address(weth);

        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(alt), path, 0, block.timestamp + 30 minutes);
    }
}

// â”€â”€â”€ DEEP-R-M04: applyPolAccumulator(0) blocked when polShareBps > 0 â”€

contract Deep_R_M04_PolZero is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        sfr = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @notice Setting polAccumulator = 0 while polShareBps > 0 must revert with
    ///         PolShareNonZero so governance is forced to first explicitly zero
    ///         the POL share via the proper feeSplit timelock.
    function test_applyPolAccumulator_zeroBlockedWhenShareNonZero() public {
        // First set fee split with a non-zero POL share via the admin.
        sfrAdmin.proposeFeeSplit(7500, 1500); // 75% staker / 15% pol
        skip(48 hours);
        sfrAdmin.executeFeeSplit();
        assertEq(sfr.polShareBps(), 1500);

        // Now propose+execute a zero-address POL accumulator. Apply must revert.
        sfrAdmin.proposePolAccumulator(address(0));
        skip(48 hours);
        vm.expectRevert(SwapFeeRouter.PolShareNonZero.selector);
        sfrAdmin.executePolAccumulator();
    }

    /// @notice With polShareBps == 0 (default), applyPolAccumulator(0) is allowed.
    function test_applyPolAccumulator_zeroAllowedWhenShareZero() public {
        // Default: polShareBps == 0
        assertEq(sfr.polShareBps(), 0);
        sfrAdmin.proposePolAccumulator(address(0));
        skip(48 hours);
        sfrAdmin.executePolAccumulator(); // should succeed
        assertEq(sfr.polAccumulator(), address(0));
    }
}

// â”€â”€â”€ DEEP-R-M05: TegridyRouter rejects to == address(this) â”€â”€â”€â”€â”€

contract Deep_R_M05_TegRouterTo is Test {
    TegridyRouter public router;
    TegridyFactory public factoryT;
    _Token public weth;
    _Token public tokenA;
    _Token public tokenB;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        tokenA = new _Token("A", "A");
        tokenB = new _Token("B", "B");
        factoryT = new TegridyFactory(address(this), address(this), address(this)); // F-30-9 initial guardian
        router = new TegridyRouter(address(factoryT), address(weth));
    }

    function test_swapExactTokensForTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(tokenB);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForTokens(1 ether, 0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapExactETHForTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(weth); path[1] = address(tokenA);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactETHForTokens{value: 1 ether}(0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapExactTokensForETH_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(weth);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForETH(1 ether, 0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapTokensForExactTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(tokenB);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapTokensForExactTokens(1 ether, type(uint256).max, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapTokensForExactETH_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(weth);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapTokensForExactETH(1 ether, type(uint256).max, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapETHForExactTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(weth); path[1] = address(tokenA);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapETHForExactTokens{value: 1 ether}(1 ether, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapExactTokensForTokensSupportingFeeOnTransferTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(tokenB);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1 ether, 0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapExactETHForTokensSupportingFeeOnTransferTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(weth); path[1] = address(tokenA);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1 ether}(0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_swapExactTokensForETHSupportingFeeOnTransferTokens_rejectsRouter() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(weth);
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(1 ether, 0, path, address(router), block.timestamp + 30 minutes);
    }

    function test_removeLiquidity_rejectsRouter() public {
        // No pair created yet â€” but the to==address(this) check fires first.
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.removeLiquidity(address(tokenA), address(tokenB), 1 ether, 0, 0, address(router), block.timestamp + 30 minutes);
    }

    function test_removeLiquidityETH_rejectsRouter() public {
        vm.expectRevert(TegridyRouter.InvalidRecipient.selector);
        router.removeLiquidityETH(address(tokenA), 1 ether, 0, 0, address(router), block.timestamp + 30 minutes);
    }
}

// â”€â”€â”€ DEEP-R-L02: removeLiquidity (non-ETH) rejects to == 0 â”€â”€â”€â”€â”€

contract Deep_R_L02_RemoveZeroTo is Test {
    TegridyRouter public router;
    TegridyFactory public factoryT;
    _Token public weth;
    _Token public tokenA;
    _Token public tokenB;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        tokenA = new _Token("A", "A");
        tokenB = new _Token("B", "B");
        factoryT = new TegridyFactory(address(this), address(this), address(this)); // F-30-9 initial guardian
        router = new TegridyRouter(address(factoryT), address(weth));
    }

    function test_removeLiquidity_rejectsZeroTo() public {
        vm.expectRevert(bytes("ZERO_TO"));
        router.removeLiquidity(address(tokenA), address(tokenB), 1 ether, 0, 0, address(0), block.timestamp + 30 minutes);
    }
}

// â”€â”€â”€ DEEP-R-M06: TWAP snapshot reset (timelocked) â”€â”€â”€â”€â”€

contract Deep_R_M06_SnapshotReset is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;
    _Token public alt;
    _MockUniPair public pair;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        weth = new _Token("WETH", "WETH");
        alt  = new _Token("Alt", "ALT");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        vm.deal(address(uniRouter), 1_000 ether);
        address t0 = address(alt) < address(weth) ? address(alt) : address(weth);
        address t1 = address(alt) < address(weth) ? address(weth) : address(alt);
        pair = new _MockUniPair(t0, t1);
        factoryC.setPair(address(alt), address(weth), address(pair));
        if (address(alt) == t0) pair.setReserves(100_000 ether, 100 ether);
        else                    pair.setReserves(100 ether, 100_000 ether);
        sfr = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @notice Bootstrapping seeds the snapshot. Reset must clear it back to zero
    ///         so the next conversion is treated as a bootstrap (owner-only).
    function test_resetTWAPSnapshot_clearsBootstrap() public {
        // Seed and bootstrap.
        alt.transfer(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees moved from slot 8 to slot 9.
        bytes32 slot = keccak256(abi.encode(address(alt), uint256(9)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        pair.pokeCumulative(uint32(60 minutes));
        skip(60 minutes);
        address[] memory path = new address[](2);
        path[0] = address(alt); path[1] = address(weth);
        sfr.convertTokenFeesToETH(address(alt), path, 0, block.timestamp + 30 minutes);

        // Snapshot is now non-zero.
        (uint32 ts0,) = sfr.lastConversionSnapshot(address(alt));
        assertGt(ts0, 0, "snapshot not seeded");

        // Propose + execute reset.
        sfr.proposeResetTWAPSnapshot(address(alt));
        skip(7 days + 1);
        sfr.executeResetTWAPSnapshot();

        // Snapshot now zero.
        (uint32 ts1,) = sfr.lastConversionSnapshot(address(alt));
        assertEq(ts1, 0, "snapshot not reset");
    }

    function test_resetTWAPSnapshot_revertsBeforeReady() public {
        sfr.proposeResetTWAPSnapshot(address(alt));
        // No skip â€” should revert.
        vm.expectRevert(SwapFeeRouter.TWAPSnapshotResetUnavailable.selector);
        sfr.executeResetTWAPSnapshot();
    }

    function test_resetTWAPSnapshot_revertsAfterValidity() public {
        sfr.proposeResetTWAPSnapshot(address(alt));
        skip(7 days + 7 days + 1); // past validity
        vm.expectRevert(SwapFeeRouter.TWAPSnapshotResetUnavailable.selector);
        sfr.executeResetTWAPSnapshot();
    }

    function test_resetTWAPSnapshot_cancellable() public {
        sfr.proposeResetTWAPSnapshot(address(alt));
        sfr.cancelResetTWAPSnapshot();
        assertEq(sfr.twapSnapshotResetReadyAt(), 0);
    }
}

// â”€â”€â”€ DEEP-R-L03: recoverCallerCredit cooldown â”€â”€â”€â”€â”€

contract _MockSplitter {
    function recordFee(address) external payable {}
    function withdrawCallerCredit() external {}
}

contract Deep_R_L03_RecoverCooldown is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    _MockUniRouter public uniRouter;
    _MockUniFactory public factoryC;
    _Token public weth;
    _MockSplitter public splitter;

    function setUp() public {
        weth = new _Token("WETH", "WETH");
        factoryC = new _MockUniFactory();
        uniRouter = new _MockUniRouter(address(weth), address(factoryC));
        splitter = new _MockSplitter();
        sfr = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(splitter));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @notice Two back-to-back calls from the same caller must trip the 30s cooldown.
    function test_recoverCallerCredit_cooldown() public {
        sfr.recoverCallerCredit();
        vm.expectRevert(SwapFeeRouter.RecoverCallerCreditCooldown.selector);
        sfr.recoverCallerCredit();
    }

    function test_recoverCallerCredit_clearsAfterCooldown() public {
        sfr.recoverCallerCredit();
        skip(31);
        sfr.recoverCallerCredit(); // should succeed
    }
}
