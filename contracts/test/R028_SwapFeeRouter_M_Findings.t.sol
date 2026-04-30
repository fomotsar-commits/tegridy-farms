// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";

contract MockToken_R028 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1e30);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal Uniswap V2 pair stub. Identical layout to Audit_SFR_H01.t.sol so the
///      contract's TWAP read is exercised end-to-end. Trimmed to what these tests need.
contract MockUniPair_R028 {
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

    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }

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

contract MockUniFactory_R028 {
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

/// @dev Mock router that handles arbitrary path lengths (so multi-hop tests work).
///      For multi-hop, the swap pricing uses the FIRST hop only — that's sufficient
///      for the test surface where we only need to verify path forwarding + slippage.
contract MockUniRouter_R028 {
    address public immutable WETH_ADDR;
    address public immutable factoryAddr;

    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth;
        factoryAddr = _factory;
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

        // Multi-hop simplification: price the entire swap against the path[0]/WETH
        // pair if it exists (works for both 2-hop and our multi-hop test paths).
        address pair = MockUniFactory_R028(factoryAddr).getPair(path[0], WETH_ADDR);
        require(pair != address(0), "NO_PAIR");
        MockUniPair_R028 p = MockUniPair_R028(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == path[0];
        uint256 reserveToken = tokenIs0 ? r0 : r1;
        uint256 reserveETH = tokenIs0 ? r1 : r0;
        uint256 amountOut = (amountIn * reserveETH) / (reserveToken + amountIn);
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT");

        p.setReserves(
            uint112(tokenIs0 ? reserveToken + amountIn : reserveETH - amountOut),
            uint112(tokenIs0 ? reserveETH - amountOut : reserveToken + amountIn)
        );

        (bool ok,) = to.call{value: amountOut}("");
        require(ok, "ETH_SEND_FAIL");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }

    receive() external payable {}
}

/// @title AUDIT SFR-M-01 — Caller-supplied conversion path with multi-hop owner gate
contract R028_SFR_M01 is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter_R028 public uniRouter;
    MockUniFactory_R028 public factory;
    MockUniPair_R028 public pair;
    MockToken_R028 public weth;
    MockToken_R028 public toweli;
    MockToken_R028 public mid; // middle hop for multi-hop tests

    address public treasury = makeAddr("treasury");
    address public attacker = makeAddr("attacker");
    address public keeper   = makeAddr("keeper");

    uint256 constant FEE_BPS = 30;
    uint112 constant BASELINE_TOWELI = 100_000 ether;
    uint112 constant BASELINE_WETH   = 100 ether;

    function setUp() public {
        weth = new MockToken_R028("WETH", "WETH");
        toweli = new MockToken_R028("Toweli", "TOWELI");
        mid = new MockToken_R028("Middle", "MID");

        factory = new MockUniFactory_R028();
        uniRouter = new MockUniRouter_R028(address(weth), address(factory));
        vm.deal(address(uniRouter), 10_000 ether);

        address t0 = address(toweli) < address(weth) ? address(toweli) : address(weth);
        address t1 = address(toweli) < address(weth) ? address(weth) : address(toweli);
        pair = new MockUniPair_R028(t0, t1);
        factory.setPair(address(toweli), address(weth), address(pair));

        bool tokenIs0 = address(toweli) == t0;
        if (tokenIs0) {
            pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        } else {
            pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        }

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @dev Park N tokens of accumulated fees in the router (mirrors Audit_SFR_H01).
    function _seedFees(uint256 amount) internal {
        toweli.transfer(address(sfr), amount);
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(8)));
        vm.store(address(sfr), slot, bytes32(amount));
        assertEq(sfr.accumulatedTokenFees(address(toweli)), amount, "fee balance seed failed");
    }

    function _direct() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(toweli);
        path[1] = address(weth);
    }

    function _multiHop3() internal view returns (address[] memory path) {
        path = new address[](3);
        path[0] = address(toweli);
        path[1] = address(mid);
        path[2] = address(weth);
    }

    function _bootstrap() internal {
        // Run a successful owner-only bootstrap so subsequent permissionless
        // conversions are unlocked for the tests that need them.
        pair.pokeCumulative(uint32(60 minutes));
        skip(60 minutes);
        _seedFees(100 ether);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
        // Reseed reserves at baseline + cumulative so the next conversion sees a clean TWAP.
        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        skip(2 hours);
        pair.pokeCumulative(uint32(2 hours));
    }

    function test_SFRM01_validPath_succeeds() public {
        _bootstrap();
        _seedFees(100 ether);
        // Permissionless 2-hop after bootstrap.
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_pathTooShort_reverts() public {
        _bootstrap();
        _seedFees(100 ether);
        address[] memory bad = new address[](1);
        bad[0] = address(toweli);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(toweli), bad, 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_pathTooLong_reverts() public {
        _bootstrap();
        _seedFees(100 ether);
        // length 5 (one over MAX_CONVERSION_PATH_LENGTH = 4)
        address[] memory bad = new address[](5);
        bad[0] = address(toweli);
        bad[1] = address(mid);
        bad[2] = makeAddr("hop2");
        bad[3] = makeAddr("hop3");
        bad[4] = address(weth);
        // owner call to bypass the multi-hop gate so we hit the length error
        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(toweli), bad, 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_pathStartMismatch_reverts() public {
        _bootstrap();
        _seedFees(100 ether);
        address[] memory bad = new address[](2);
        bad[0] = address(mid); // not the input token
        bad[1] = address(weth);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(toweli), bad, 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_pathEndMismatch_reverts() public {
        _bootstrap();
        _seedFees(100 ether);
        address[] memory bad = new address[](2);
        bad[0] = address(toweli);
        bad[1] = address(mid); // not WETH
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(toweli), bad, 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_pathDuplicate_reverts() public {
        _bootstrap();
        _seedFees(100 ether);
        address[] memory bad = new address[](3);
        bad[0] = address(toweli);
        bad[1] = address(toweli); // duplicate
        bad[2] = address(weth);
        // owner call to bypass multi-hop gate so we hit the duplicate error
        vm.expectRevert(SwapFeeRouter.InvalidConversionPath.selector);
        sfr.convertTokenFeesToETH(address(toweli), bad, 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_multiHop_blockedForNonOwner() public {
        _bootstrap();
        _seedFees(100 ether);
        // 3-hop path is owner-only because TWAP anchors only on the direct pair.
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.MultiHopOwnerOnly.selector);
        sfr.convertTokenFeesToETH(address(toweli), _multiHop3(), 0, block.timestamp + 30 minutes);
    }

    function test_SFRM01_multiHop_allowedForOwner() public {
        _bootstrap();
        _seedFees(100 ether);
        // Owner can use a multi-hop path even though the TWAP only knows about the direct pair.
        sfr.convertTokenFeesToETH(address(toweli), _multiHop3(), 0, block.timestamp + 30 minutes);
        // ETH was received and folded into accumulatedETHFees.
        assertGt(sfr.accumulatedETHFees(), 0, "owner multi-hop should produce ETH");
    }
}
