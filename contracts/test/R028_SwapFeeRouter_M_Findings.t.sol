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
///      For multi-hop, the swap pricing uses the FIRST hop only â€” that's sufficient
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

/// @title AUDIT SFR-M-01 â€” Caller-supplied conversion path with multi-hop owner gate
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
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
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

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @dev Park N tokens of accumulated fees in the router (mirrors Audit_SFR_H01).
    function _seedFees(uint256 amount) internal {
        toweli.transfer(address(sfr), amount);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(10)));
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
        // AUDIT FIX V3-DEEP-R3-M01: minOut floor now `>= MIN_MULTIHOP_ETH_OUT_WEI`.
        // AUDIT FIX 2026-05-26 [H-02]: when a direct token/WETH pair exists, the
        // effective floor also includes the TWAP-derived minETHOut (1.5% safety).
        // With BASELINE reserves of 100_000 toweli : 100 WETH (price 1:1000) and a
        // 100-toweli seed, the TWAP floor lands â‰ˆ 4.9e16 wei after the safety bps.
        // We pass 5e16 (just above the floor) so the H-02 gate passes and the
        // Uniswap-side slippage check still has headroom against actual output.
        // Pre-H-02 this test used `MIN_MULTIHOP_ETH_OUT_WEI` (1e14); that is now
        // strictly below the H-02 floor, so the call would revert ZeroMinOut.
        uint256 minOut = 5e16;
        sfr.convertTokenFeesToETH(address(toweli), _multiHop3(), minOut, block.timestamp + 30 minutes);
        // ETH was received and folded into accumulatedETHFees.
        assertGt(sfr.accumulatedETHFees(), 0, "owner multi-hop should produce ETH");
    }
}

/// @title AUDIT SFR-M-02 â€” Minimum token-fee balance gate before cooldown
contract R028_SFR_M02 is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter_R028 public uniRouter;
    MockUniFactory_R028 public factory;
    MockUniPair_R028 public pair;
    MockToken_R028 public weth;
    MockToken_R028 public toweli;

    address public treasury = makeAddr("treasury");
    address public attacker = makeAddr("attacker");
    address public keeper   = makeAddr("keeper");

    uint256 constant FEE_BPS = 30;
    uint112 constant BASELINE_TOWELI = 100_000 ether;
    uint112 constant BASELINE_WETH   = 100 ether;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        weth = new MockToken_R028("WETH", "WETH");
        toweli = new MockToken_R028("Toweli", "TOWELI");
        factory = new MockUniFactory_R028();
        uniRouter = new MockUniRouter_R028(address(weth), address(factory));
        vm.deal(address(uniRouter), 10_000 ether);

        address t0 = address(toweli) < address(weth) ? address(toweli) : address(weth);
        address t1 = address(toweli) < address(weth) ? address(weth) : address(toweli);
        pair = new MockUniPair_R028(t0, t1);
        factory.setPair(address(toweli), address(weth), address(pair));
        bool tokenIs0 = address(toweli) == t0;
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    function _direct() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(toweli);
        path[1] = address(weth);
    }

    function _bootstrap() internal {
        pair.pokeCumulative(uint32(60 minutes));
        skip(60 minutes);
        toweli.transfer(address(sfr), 100 ether);
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(10)));
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
        bool tokenIs0 = address(toweli) < address(weth);
        if (tokenIs0) pair.setReserves(BASELINE_TOWELI, BASELINE_WETH);
        else          pair.setReserves(BASELINE_WETH, BASELINE_TOWELI);
        skip(2 hours);
        pair.pokeCumulative(uint32(2 hours));
    }

    function test_SFRM02_belowMinimum_reverts() public {
        _bootstrap();
        // Drain accumulatedTokenFees down to a dust amount (1 wei) â€” the bootstrap
        // zeroed it out, so we just write a sub-MIN value.
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(10)));
        vm.store(address(sfr), slot, bytes32(uint256(1))); // 1 wei
        assertEq(sfr.accumulatedTokenFees(address(toweli)), 1);

        // Permissionless caller hits the gate BEFORE the cooldown stamp updates.
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
    }

    function test_SFRM02_atMinimum_succeeds() public {
        _bootstrap();
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(10)));
        vm.store(address(sfr), slot, bytes32(uint256(1e18))); // exactly the minimum
        toweli.mint(address(sfr), 1e18);

        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
        assertEq(sfr.accumulatedTokenFees(address(toweli)), 0);
    }

    /// @notice Headline regression: an attacker can NOT brick the keeper bot's
    ///         legitimate-sized conversion by triggering the cooldown with dust.
    ///         Pre-fix, calling convertTokenFeesToETH with 1 wei accumulated would
    ///         start the 1h cooldown timer for the entire token; post-fix the
    ///         attempt reverts BEFORE the cooldown stamp is updated.
    function test_SFRM02_dustTrigger_doesNotBrickLegitimateConversion() public {
        _bootstrap();

        // Attacker triggers with dust (1 wei). Pre-fix this would have set
        // lastConvertedAt[token] = block.timestamp.
        // FRESH-2026 TEST REALIGN: accumulatedTokenFees at slot 10 (mvp-launch PauseGuardian add shifted +1).
        bytes32 slot = keccak256(abi.encode(address(toweli), uint256(10)));
        vm.store(address(sfr), slot, bytes32(uint256(1)));
        vm.prank(attacker);
        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);

        // Cooldown stamp was NOT updated (attack failed early).
        // Now the keeper's legitimate conversion (above MIN) should succeed in
        // the SAME block â€” pre-fix it would have hit CONVERSION_COOLDOWN_ACTIVE.
        vm.store(address(sfr), slot, bytes32(uint256(100 ether)));
        toweli.mint(address(sfr), 100 ether);
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(toweli), _direct(), 0, block.timestamp + 30 minutes);
    }
}

/// @title AUDIT SFR-M-04 â€” Admin replaceability with 7d timelock
contract R028_SFR_M04 is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter_R028 public uniRouter;
    MockUniFactory_R028 public factory;
    MockToken_R028 public weth;

    address public treasury = makeAddr("treasury");
    uint256 constant FEE_BPS = 30;

    function setUp() public {
        weth = new MockToken_R028("WETH", "WETH");
        factory = new MockUniFactory_R028();
        uniRouter = new MockUniRouter_R028(address(weth), address(factory));
        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    function test_SFRM04_proposeAdminReplacement_setsState() public {
        SwapFeeRouterAdmin newAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.proposeAdminReplacement(address(newAdmin));
        assertEq(sfr.pendingSwapFeeRouterAdmin(), address(newAdmin));
        assertEq(sfr.adminReplacementReadyAt(), block.timestamp + sfr.ADMIN_REPLACEMENT_TIMELOCK());
    }

    function test_SFRM04_executeBeforeTimelock_reverts() public {
        SwapFeeRouterAdmin newAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.proposeAdminReplacement(address(newAdmin));
        // Try to execute before timelock matures.
        vm.expectRevert(SwapFeeRouter.AdminReplacementUnavailable.selector);
        sfr.executeAdminReplacement();
    }

    function test_SFRM04_executeAfterTimelock_swapsAdmin() public {
        SwapFeeRouterAdmin newAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.proposeAdminReplacement(address(newAdmin));
        skip(sfr.ADMIN_REPLACEMENT_TIMELOCK() + 1);
        sfr.executeAdminReplacement();
        assertEq(sfr.swapFeeRouterAdmin(), address(newAdmin));
        // Pending state cleared.
        assertEq(sfr.pendingSwapFeeRouterAdmin(), address(0));
        assertEq(sfr.adminReplacementReadyAt(), 0);
    }

    function test_SFRM04_cancelClearsProposal() public {
        SwapFeeRouterAdmin newAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.proposeAdminReplacement(address(newAdmin));
        sfr.cancelAdminReplacement();
        assertEq(sfr.pendingSwapFeeRouterAdmin(), address(0));
        assertEq(sfr.adminReplacementReadyAt(), 0);
    }

    function test_SFRM04_cannotProposeWhileAnotherPending() public {
        SwapFeeRouterAdmin newAdmin1 = new SwapFeeRouterAdmin(address(sfr));
        SwapFeeRouterAdmin newAdmin2 = new SwapFeeRouterAdmin(address(sfr));
        sfr.proposeAdminReplacement(address(newAdmin1));
        vm.expectRevert(SwapFeeRouter.AdminReplacementUnavailable.selector);
        sfr.proposeAdminReplacement(address(newAdmin2));
    }

    function test_SFRM04_cannotProposeIfNoAdminSet() public {
        // Deploy a fresh router without setting swapFeeRouterAdmin.
        SwapFeeRouter fresh = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        SwapFeeRouterAdmin adm = new SwapFeeRouterAdmin(address(fresh));
        vm.expectRevert(SwapFeeRouter.Unauthorized.selector);
        fresh.proposeAdminReplacement(address(adm));
    }

    function test_SFRM04_setSwapFeeRouterAdmin_stillOneShot() public {
        SwapFeeRouterAdmin other = new SwapFeeRouterAdmin(address(sfr));
        // Already set in setUp(); calling setSwapFeeRouterAdmin again must revert.
        // AUDIT FIX 2026-05-26 [L-08]: error swapped Unauthorized â†’ AdminAlreadySet
        // for clearer caller diagnostics. One-shot semantic unchanged; rotation
        // still requires the 7-day proposeAdminReplacement timelock.
        vm.expectRevert(SwapFeeRouter.AdminAlreadySet.selector);
        sfr.setSwapFeeRouterAdmin(address(other));
    }

    function test_SFRM04_buggyAdminCannotBlockReplacement() public {
        // Demonstrate the inline state design: even if the admin contract is
        // entirely broken, the router's own proposeAdminReplacement /
        // executeAdminReplacement remain callable by the owner.
        SwapFeeRouterAdmin newAdmin = new SwapFeeRouterAdmin(address(sfr));

        // Simulate a buggy admin by setting the wired admin to an address that
        // reverts on any call (a contract with no fallback). We do this via
        // proposing then executing a replacement to that "bad" address.
        BadAdmin bad = new BadAdmin();
        sfr.proposeAdminReplacement(address(bad));
        skip(sfr.ADMIN_REPLACEMENT_TIMELOCK() + 1);
        sfr.executeAdminReplacement();
        assertEq(sfr.swapFeeRouterAdmin(), address(bad));

        // Now propose REPLACEMENT of the bad admin. The propose lives ON THE
        // ROUTER, not the admin, so the buggy admin cannot block its own removal.
        sfr.proposeAdminReplacement(address(newAdmin));
        skip(sfr.ADMIN_REPLACEMENT_TIMELOCK() + 1);
        sfr.executeAdminReplacement();
        assertEq(sfr.swapFeeRouterAdmin(), address(newAdmin));
    }
}

/// @dev Stub used by `test_SFRM04_buggyAdminCannotBlockReplacement` to model an
///      entirely-broken admin contract that has no fallback / doesn't honor the
///      ISwapFeeRouterApply interface. The router's replacement path must still work.
contract BadAdmin {
    // No functions â€” every call reverts.
}

/// @dev WETH9-shaped mock supporting deposit/withdraw â€” required for the
///      M4-revised regression tests because the production `convertTokenFeesToETH`
///      now calls `IWETH(WETH).withdraw(amount)` on the WETH branch.
contract MockWETH_R028 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "WETH_WITHDRAW_FAIL");
    }
    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @title R028 M4-REVISED â€” `accumulatedTokenFees[WETH]` unwrap path
/// @notice Pre-fix, WETH-input swaps populated `accumulatedTokenFees[WETH]` at
///         line 837 in `swapExactTokensForTokens`. The 2026-05-16 M4 `getPair`
///         gate in `withdrawTokenFees` passed for WETH because UniV2 rejects
///         same-token pairs (`getPair(WETH, WETH) == address(0)`), so the only
///         exit was 100%-to-treasury, bypassing the 50/30/20 staker/POL/treasury
///         split. M4-REVISED adds an unwrap branch in `convertTokenFeesToETH`
///         that folds WETH balance into `accumulatedETHFees` (via `IWETH.withdraw`)
///         AND adds an explicit `token == WETH` reject in `withdrawTokenFees`.
///         Discovered by the defensive scan of PR #28.
contract R028_SFR_M04_REVISED is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniFactory_R028 public factory;
    MockUniRouter_R028 public uniRouter;
    MockWETH_R028 public weth; // real-WETH-shaped (deposit/withdraw)

    address public treasury = makeAddr("treasury");
    address public keeper   = makeAddr("keeper");

    uint256 constant FEE_BPS = 30;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=0 on chainid != 1.
        vm.chainId(1);
        weth = new MockWETH_R028();
        factory = new MockUniFactory_R028();
        uniRouter = new MockUniRouter_R028(address(weth), address(factory));
        vm.deal(address(uniRouter), 10_000 ether);

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    /// @dev Park `amount` WETH on the router and bump `accumulatedTokenFees[WETH]`
    ///      to match. Mirrors `_seedFees` from R028_SFR_M01 â€” slot 10 is the storage
    ///      index of `accumulatedTokenFees`.
    function _seedWETHFees(uint256 amount) internal {
        // Mint actual WETH to the router (so the unwrap has something to burn).
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(sfr), amount);
        // Bump the accumulated counter to mirror what the swap-time accumulation
        // would have written.
        bytes32 slot = keccak256(abi.encode(address(weth), uint256(10)));
        vm.store(address(sfr), slot, bytes32(amount));
        assertEq(sfr.accumulatedTokenFees(address(weth)), amount, "WETH fee seed failed");
    }

    function _emptyPath() internal pure returns (address[] memory path) {
        // convertTokenFeesToETH WETH branch returns BEFORE touching `path`, so
        // a zero-length array is fine. Foundry's calldata cast still wants an
        // initialized array of the right type.
        path = new address[](0);
    }

    /// @notice Core M4-revised contract: WETH unwrap moves balance into
    ///         accumulatedETHFees (so it flows through the standard split)
    ///         instead of staying in accumulatedTokenFees[WETH] (where the only
    ///         exit was 100%-to-treasury via withdrawTokenFees).
    function test_M4_revised_WETHFeesUnwrapToETHFees() public {
        uint256 seed = 5 ether; // above MIN_TOKEN_FEE_FOR_CONVERSION (1e18)
        _seedWETHFees(seed);

        uint256 ethFeesBefore = sfr.accumulatedETHFees();
        uint256 ethBalanceBefore = address(sfr).balance;

        // Permissionless â€” keeper can call.
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(weth), _emptyPath(), 0, block.timestamp + 30 minutes);

        // accumulatedTokenFees[WETH] zeroed; accumulatedETHFees += seed.
        assertEq(sfr.accumulatedTokenFees(address(weth)), 0, "WETH accumulator must zero");
        assertEq(
            sfr.accumulatedETHFees(),
            ethFeesBefore + seed,
            "accumulatedETHFees must grow by the unwrapped WETH amount"
        );
        // ETH actually landed on the router (via receive() during WETH.withdraw).
        assertEq(
            address(sfr).balance,
            ethBalanceBefore + seed,
            "router balance must grow by the unwrapped ETH"
        );
    }

    /// @notice withdrawTokenFees(WETH) must revert. Pre-fix this was the gap
    ///         that drained 100% to treasury.
    function test_M4_revised_withdrawTokenFees_rejectsWETH() public {
        _seedWETHFees(5 ether);
        vm.expectRevert(SwapFeeRouter.UseConvertTokenFeesToETH.selector);
        sfr.withdrawTokenFees(address(weth));
    }

    /// @notice Dust-grief floor still enforced on the WETH branch: balance below
    ///         MIN_TOKEN_FEE_FOR_CONVERSION (1e18) reverts so an attacker can't
    ///         spam unwrap calls on wei-scale dust.
    function test_M4_revised_WETHUnwrap_belowFloorReverts() public {
        _seedWETHFees(0.5 ether); // below MIN_TOKEN_FEE_FOR_CONVERSION
        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(weth), _emptyPath(), 0, block.timestamp + 30 minutes);
    }

    /// @notice After the WETH unwrap, `distributeFeesToStakers` (the timelocked
    ///         50/30/20 split) sees the WETH proceeds as part of accumulatedETHFees.
    ///         Pre-fix the same WETH stayed in accumulatedTokenFees[WETH] and the
    ///         next withdrawTokenFees(WETH) sent 100% to treasury.
    function test_M4_revised_postUnwrap_flowsThroughETHSplitNotTreasury100Pct() public {
        uint256 seed = 5 ether;
        _seedWETHFees(seed);

        uint256 treasuryBefore = treasury.balance;
        uint256 ethFeesBefore = sfr.accumulatedETHFees();

        // Unwrap.
        vm.prank(keeper);
        sfr.convertTokenFeesToETH(address(weth), _emptyPath(), 0, block.timestamp + 30 minutes);

        // Treasury hasn't received anything directly â€” proceeds are in the
        // ETH-fees pool, awaiting the timelocked distribute call.
        assertEq(treasury.balance, treasuryBefore, "treasury MUST NOT receive direct ETH on unwrap");
        assertEq(
            sfr.accumulatedETHFees(),
            ethFeesBefore + seed,
            "ETH-fees pool absorbs the unwrapped WETH"
        );
        // Treasury split path is exercised in dedicated distributeFeesToStakers
        // tests (Audit_SFR_H01, SwapFeeRouter.t.sol). The M4-revised property
        // we prove here is the routing-into-the-pool, not the split math.
    }
}
