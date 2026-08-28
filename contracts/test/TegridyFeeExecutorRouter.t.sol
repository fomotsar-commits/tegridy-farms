// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TegridyFeeExecutorRouter} from "../src/TegridyFeeExecutorRouter.sol";

// ─── Mocks ───────────────────────────────────────────────────────────

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev Fee-on-transfer token: burns `feeBps` on every transfer.
contract FoTToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 _feeBps) ERC20("FoT", "FOT") {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

address constant ETH_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

/// @dev Benign aggregator: pulls `amountIn` of tokenIn from caller (the router) via the
///      approval, delivers `amountOut` of tokenOut back. Mirrors how a real aggregator router
///      consumes an approval and returns output to the configured recipient (the router).
contract MockAggregator {
    receive() external payable {}

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external payable {
        if (tokenIn != ETH_SENTINEL) {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        }
        if (tokenOut == ETH_SENTINEL) {
            (bool ok,) = msg.sender.call{value: amountOut}("");
            require(ok, "eth out");
        } else {
            IERC20(tokenOut).transfer(msg.sender, amountOut);
        }
    }
}

/// @dev Allowlisted-but-malicious target. Tries to pull MORE than the scoped approval, drain a
///      different token the router holds, or re-enter. All must be contained by the router.
contract MaliciousAggregator {
    enum Mode {
        OverPull,
        DrainOther,
        Reenter
    }

    Mode public mode;
    address public otherToken;
    TegridyFeeExecutorRouter public router;

    // Reenter-mode arming: parameters for a fully VIABLE inner swap (this contract funded and
    // approved, benign allowlisted route) so the ONLY thing that can stop it is nonReentrant.
    uint256 public reentryAmountIn;
    address public reentryTokenOut;
    address public reentryRoute;
    bytes public reentryData;
    // Recorded outcome of the re-entrant call. `_execSwap` wraps ANY inner revert in
    // SwapCallFailed, so the guard selector is invisible outside — it must be captured here.
    bool public reentrySucceeded;
    bytes4 public reentryRevertSelector;

    function set(Mode m, address _otherToken, address _router) external {
        mode = m;
        otherToken = _otherToken;
        router = TegridyFeeExecutorRouter(payable(_router));
    }

    function armReentry(uint256 _amountIn, address _tokenOut, address _route, bytes calldata _swapData) external {
        reentryAmountIn = _amountIn;
        reentryTokenOut = _tokenOut;
        reentryRoute = _route;
        reentryData = _swapData;
    }

    function swap(address tokenIn, address, uint256 amountIn, uint256) external payable {
        if (mode == Mode.OverPull) {
            // Approval is exactly `net`; pulling more must revert.
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn * 2);
        } else if (mode == Mode.DrainOther) {
            // Router never approved this token to us → must revert.
            IERC20(otherToken).transferFrom(msg.sender, address(this), 1);
        } else {
            // Re-enter the router mid-swap with a call that is viable BUT FOR the guard (see
            // armReentry; the disarmed control test proves viability). Record the inner outcome
            // instead of letting it bubble: the router re-wraps it as SwapCallFailed, which
            // would make the assertion selector-blind (the old vacuous-gate defect).
            try router.swapERC20(
                tokenIn,
                reentryAmountIn,
                reentryTokenOut,
                0,
                100,
                reentryRoute,
                reentryRoute,
                reentryData,
                address(this),
                block.timestamp
            ) returns (uint256) {
                reentrySucceeded = true;
            } catch (bytes memory err) {
                reentryRevertSelector = bytes4(err);
            }
        }
    }
}

/// @dev Returns a large blob on success and reverts with a large blob on failure — exercises the
///      router's no-returndatacopy posture (must not OOG-grief).
contract BombAggregator {
    bool public shouldRevert;

    function set(bool r) external {
        shouldRevert = r;
    }

    function swap(address, address tokenOut, uint256, uint256 amountOut) external payable {
        if (shouldRevert) {
            bytes memory bomb = new bytes(64_000);
            assembly {
                revert(add(bomb, 0x20), mload(bomb))
            }
        }
        if (amountOut > 0) IERC20(tokenOut).transfer(msg.sender, amountOut);
        bytes memory blob = new bytes(64_000);
        assembly {
            return(add(blob, 0x20), mload(blob))
        }
    }
}

contract SimpleReceiver {
    receive() external payable {}
}

// ─── Tests ───────────────────────────────────────────────────────────

contract TegridyFeeExecutorRouterTest is Test {
    TegridyFeeExecutorRouter router;
    MockERC20 tokenIn;
    MockERC20 tokenOut;
    MockAggregator agg;
    SimpleReceiver revDist;
    address treasury;
    address weth;
    address user;

    uint256 constant FEE_BPS = 25; // 0.25%
    uint256 constant BPS = 10_000;

    function setUp() public {
        treasury = makeAddr("treasury");
        // Must carry code: the constructor code-checks WETH (AUDIT FIX 2026-08-25). The WETH
        // wrap fallback never triggers in these tests (all recipients accept raw ETH).
        weth = address(new SimpleReceiver());
        user = makeAddr("user");

        revDist = new SimpleReceiver();
        agg = new MockAggregator();
        tokenIn = new MockERC20("In", "IN");
        tokenOut = new MockERC20("Out", "OUT");

        address[] memory targets = new address[](1);
        targets[0] = address(agg);
        address[] memory spenders = new address[](1);
        spenders[0] = address(agg);

        router = new TegridyFeeExecutorRouter(weth, address(revDist), treasury, FEE_BPS, targets, spenders);

        tokenIn.mint(user, 1_000 ether);
        tokenOut.mint(address(agg), 1_000_000 ether);
    }

    function _net(uint256 amountIn) internal pure returns (uint256 fee, uint256 net) {
        fee = (amountIn * FEE_BPS) / BPS;
        if (fee == 0 && FEE_BPS > 0) fee = 1;
        net = amountIn - fee;
    }

    function _data(address t, address tIn, address tOut, uint256 net, uint256 out)
        internal
        pure
        returns (bytes memory)
    {
        // selector is identical across mock/malicious/bomb aggregators ("swap(address,address,uint256,uint256)")
        t; // silence unused
        return abi.encodeWithSignature("swap(address,address,uint256,uint256)", tIn, tOut, net, out);
    }

    // ── Happy path ──────────────────────────────────────────────────

    function test_swapERC20_skimsFee_andDelivers() public {
        uint256 amountIn = 100 ether;
        (uint256 fee, uint256 net) = _net(amountIn);
        uint256 out = 250 ether;

        vm.startPrank(user);
        tokenIn.approve(address(router), amountIn);
        uint256 got = router.swapERC20(
            address(tokenIn),
            amountIn,
            address(tokenOut),
            out,
            100,
            address(agg),
            address(agg),
            _data(address(agg), address(tokenIn), address(tokenOut), net, out),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();

        assertEq(got, out, "output");
        assertEq(tokenOut.balanceOf(user), out, "user received output");
        assertEq(router.accumulatedTokenFees(address(tokenIn)), fee, "fee accrued");
        // INVARIANT-1: no residual allowance, no residual tokenOut; only the skimmed fee held.
        assertEq(tokenIn.allowance(address(router), address(agg)), 0, "approval reset");
        assertEq(tokenOut.balanceOf(address(router)), 0, "no residual out");
        assertEq(tokenIn.balanceOf(address(router)), fee, "only fee held");
    }

    function test_swapNative_skimsFeeInETH() public {
        uint256 amountIn = 1 ether;
        (uint256 fee,) = _net(amountIn);
        (, uint256 net) = _net(amountIn);
        uint256 out = 1000 ether;

        vm.deal(user, amountIn);
        vm.prank(user);
        uint256 got = router.swapNative{value: amountIn}(
            address(tokenOut),
            out,
            100,
            address(agg),
            _data(address(agg), ETH_SENTINEL, address(tokenOut), net, out),
            user,
            block.timestamp + 600
        );

        assertEq(got, out, "output");
        assertEq(tokenOut.balanceOf(user), out, "user got output");
        assertEq(router.accumulatedETHFees(), fee, "eth fee accrued");
        assertEq(address(router).balance, fee, "only fee held");
    }

    function test_distributeFees_defaultAllToStakers() public {
        test_swapNative_skimsFeeInETH();
        uint256 fee = router.accumulatedETHFees();
        assertGt(fee, 0);
        uint256 before = address(revDist).balance;
        router.distributeFees();
        assertEq(address(revDist).balance - before, fee, "stakers got 100%");
        assertEq(router.accumulatedETHFees(), 0, "drained");
    }

    function test_sweepTokenFee_toTreasury() public {
        test_swapERC20_skimsFee_andDelivers();
        uint256 fee = router.accumulatedTokenFees(address(tokenIn));
        router.sweepTokenFee(address(tokenIn));
        assertEq(tokenIn.balanceOf(treasury), fee, "treasury got token fee");
        assertEq(router.accumulatedTokenFees(address(tokenIn)), 0, "drained");
    }

    function test_FoT_input_usesReceivedNotNominal() public {
        FoTToken fot = new FoTToken(100); // 1% burn
        fot.mint(user, 100 ether);
        uint256 amountIn = 100 ether;
        uint256 received = amountIn - (amountIn * 100) / 10_000; // post-FoT
        uint256 fee = (received * FEE_BPS) / BPS;
        uint256 net = received - fee;
        uint256 out = 10 ether;

        vm.startPrank(user);
        fot.approve(address(router), amountIn);
        router.swapERC20(
            address(fot),
            amountIn,
            address(tokenOut),
            out,
            100,
            address(agg),
            address(agg),
            _data(address(agg), address(fot), address(tokenOut), net, out),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
        assertEq(router.accumulatedTokenFees(address(fot)), fee, "fee on received, not nominal");
    }

    // ── minOut / deadline ───────────────────────────────────────────

    function test_revert_minOut() public {
        uint256 amountIn = 100 ether;
        (, uint256 net) = _net(amountIn);
        uint256 out = 10 ether;
        vm.startPrank(user);
        tokenIn.approve(address(router), amountIn);
        vm.expectRevert(TegridyFeeExecutorRouter.InsufficientOutput.selector);
        router.swapERC20(
            address(tokenIn),
            amountIn,
            address(tokenOut),
            out + 1,
            100,
            address(agg),
            address(agg),
            _data(address(agg), address(tokenIn), address(tokenOut), net, out),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    function test_revert_deadlineExpired() public {
        vm.warp(1000);
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.DeadlineExpired.selector);
        router.swapERC20(
            address(tokenIn), 1 ether, address(tokenOut), 0, 100, address(agg), address(agg), "", user, 999
        );
        vm.stopPrank();
    }

    function test_revert_deadlineTooFar() public {
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.DeadlineTooFar.selector);
        router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(agg),
            address(agg),
            "",
            user,
            block.timestamp + 3 hours
        );
        vm.stopPrank();
    }

    // ── Allowlist gates (the primary defense) ────────────────────────

    function test_revert_targetNotAllowed() public {
        address evil = address(new MockAggregator());
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.TargetNotAllowed.selector);
        router.swapERC20(
            address(tokenIn), 1 ether, address(tokenOut), 0, 100, evil, address(agg), "", user, block.timestamp + 600
        );
        vm.stopPrank();
    }

    function test_revert_spenderNotAllowed() public {
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.SpenderNotAllowed.selector);
        router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(agg),
            address(0xBEEF),
            "",
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    function test_revert_targetIsToken() public {
        router.proposeAllowTarget(address(tokenIn), address(agg));
        vm.warp(block.timestamp + 48 hours);
        router.executeAllowTarget();

        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.TokenIsTarget.selector);
        router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(tokenIn),
            address(agg),
            "",
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    // ── Malicious allowlisted target is contained ────────────────────

    function _allow(address a) internal {
        router.proposeAllowTarget(a, a);
        vm.warp(block.timestamp + 48 hours);
        router.executeAllowTarget();
    }

    function test_malicious_overPull_reverts() public {
        MaliciousAggregator m = new MaliciousAggregator();
        m.set(MaliciousAggregator.Mode.OverPull, address(0), address(router));
        _allow(address(m));
        (, uint256 net) = _net(100 ether);
        vm.startPrank(user);
        tokenIn.approve(address(router), 100 ether);
        vm.expectRevert(); // transferFrom > net allowance → SwapCallFailed
        router.swapERC20(
            address(tokenIn),
            100 ether,
            address(tokenOut),
            0,
            100,
            address(m),
            address(m),
            _data(address(m), address(tokenIn), address(tokenOut), net, 0),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    function test_malicious_drainOtherToken_reverts() public {
        MaliciousAggregator m = new MaliciousAggregator();
        m.set(MaliciousAggregator.Mode.DrainOther, address(tokenOut), address(router));
        _allow(address(m));
        tokenOut.mint(address(router), 5 ether); // a balance the attacker would love to take
        (, uint256 net) = _net(100 ether);
        vm.startPrank(user);
        tokenIn.approve(address(router), 100 ether);
        vm.expectRevert();
        router.swapERC20(
            address(tokenIn),
            100 ether,
            address(tokenOut),
            0,
            100,
            address(m),
            address(m),
            _data(address(m), address(tokenIn), address(tokenOut), net, 0),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
        assertEq(tokenOut.balanceOf(address(router)), 5 ether, "router balance untouched");
    }

    /// @dev Funds + approves the re-entrant caller and arms a benign route, so the inner swap
    ///      would SUCCEED but for `nonReentrant` (the disarmed control below proves that), then
    ///      asserts the recorded inner selector IS the guard error. The old form of this test
    ///      was a gate that could not fail: bare expectRevert around an inner call that reverted
    ///      for a guard-independent reason (unfunded caller), behind `_execSwap`'s SwapCallFailed
    ///      wrap — it passed with `nonReentrant` deleted. Modeled on the armed-hook + disarmed-
    ///      control pattern in test/vaults/TegridyHarvestVaultReentrancy.t.sol.
    function test_malicious_reentrancy_blockedByGuard() public {
        MaliciousAggregator m = new MaliciousAggregator();
        m.set(MaliciousAggregator.Mode.Reenter, address(0), address(router));
        _allow(address(m));
        tokenIn.mint(address(m), 10 ether);
        vm.prank(address(m));
        tokenIn.approve(address(router), type(uint256).max);
        (, uint256 netInner) = _net(1 ether);
        m.armReentry(
            1 ether,
            address(tokenOut),
            address(agg),
            _data(address(agg), address(tokenIn), address(tokenOut), netInner, 3 ether)
        );

        (, uint256 net) = _net(100 ether);
        vm.startPrank(user);
        tokenIn.approve(address(router), 100 ether);
        // The OUTER swap completes (minOut 0; the aggregator pulls nothing) so the recorded
        // inner outcome survives — an outer expectRevert could never see past SwapCallFailed.
        router.swapERC20(
            address(tokenIn),
            100 ether,
            address(tokenOut),
            0,
            100,
            address(m),
            address(m),
            _data(address(m), address(tokenIn), address(tokenOut), net, 0),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();

        assertFalse(m.reentrySucceeded(), "re-entrant swap executed");
        assertEq(
            bytes32(m.reentryRevertSelector()),
            bytes32(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "inner revert was not the reentrancy guard"
        );
    }

    /// @dev Disarmed control: the EXACT call armed above, executed outside the guard window,
    ///      succeeds — so the guard is the only thing stopping it mid-swap.
    function test_control_reentrantCallSucceedsOutsideGuard() public {
        MaliciousAggregator m = new MaliciousAggregator();
        m.set(MaliciousAggregator.Mode.Reenter, address(0), address(router));
        _allow(address(m));
        tokenIn.mint(address(m), 10 ether);
        vm.prank(address(m));
        tokenIn.approve(address(router), type(uint256).max);
        (, uint256 netInner) = _net(1 ether);

        vm.prank(address(m));
        uint256 got = router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(agg),
            address(agg),
            _data(address(agg), address(tokenIn), address(tokenOut), netInner, 3 ether),
            address(m),
            block.timestamp
        );
        assertEq(got, 3 ether, "armed re-entry call must be viable outside the guard");
    }

    function test_returnDataBomb_revertPath_doesNotOOG() public {
        BombAggregator b = new BombAggregator();
        b.set(true);
        _allow(address(b));
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        // Router uses (bool ok,) → no returndatacopy of the 64KB blob; reverts cleanly.
        vm.expectRevert(TegridyFeeExecutorRouter.SwapCallFailed.selector);
        router.swapERC20{gas: 3_000_000}(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(b),
            address(b),
            _data(address(b), address(tokenIn), address(tokenOut), 0, 0),
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    // ── Admin: allowlist timelock + fee bounds ───────────────────────

    function test_allowTarget_timelocked() public {
        MockAggregator a2 = new MockAggregator();
        router.proposeAllowTarget(address(a2), address(a2));
        vm.expectRevert(); // not ready
        router.executeAllowTarget();
        vm.warp(block.timestamp + 48 hours);
        router.executeAllowTarget();
        assertTrue(router.allowedTarget(address(a2)));
        assertTrue(router.allowedSpender(address(a2)));
        router.removeTarget(address(a2));
        assertFalse(router.allowedTarget(address(a2)));
    }

    function test_allowTarget_rejectsEOAandProtected() public {
        vm.expectRevert(TegridyFeeExecutorRouter.NotAContract.selector);
        router.proposeAllowTarget(address(0xEEE), address(agg)); // EOA, no code

        vm.expectRevert(TegridyFeeExecutorRouter.ProtectedAddress.selector);
        router.proposeAllowTarget(address(revDist), address(agg)); // protocol address
    }

    function test_setFeeBps_bounded() public {
        vm.expectRevert(TegridyFeeExecutorRouter.FeeTooHigh.selector);
        router.setFeeBps(101);
        router.setFeeBps(100);
        assertEq(router.feeBps(), 100);
    }

    function test_revert_feeExceedsCallerMax() public {
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.FeeExceedsMax.selector);
        router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenOut),
            0,
            10,
            address(agg),
            address(agg),
            "",
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    function test_onlyOwner_admin() public {
        vm.prank(user);
        vm.expectRevert();
        router.setFeeBps(50);
    }

    // ── Audit fixes 2026-08-25 ───────────────────────────────────────

    /// [fee-router-received-zero-underflow] A token that delivers a zero balance delta
    /// (100% fee-on-transfer) must revert with the typed ZeroAmount, not Panic(0x11).
    /// Pre-fix: dust rule forced fee=1, `received - fee` underflowed → this expectRevert
    /// (pinned to the ZeroAmount selector) fails on the panic data.
    function test_revert_zeroReceived_fullFoT() public {
        FoTToken fot = new FoTToken(10_000); // 100% burn → router receives 0
        fot.mint(user, 1 ether);
        vm.startPrank(user);
        fot.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.ZeroAmount.selector);
        router.swapERC20(
            address(fot),
            1 ether,
            address(tokenOut),
            0,
            100,
            address(agg),
            address(agg),
            "",
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }

    /// [wethfallback-unchecked-weth] Constructor must code-check WETH the way _assertAllowable
    /// code-checks every other trusted address. Pre-fix: a code-less _weth deployed fine →
    /// this expectRevert fails.
    function test_revert_constructor_wethNotAContract() public {
        address[] memory t = new address[](0);
        address[] memory s = new address[](0);
        vm.expectRevert(TegridyFeeExecutorRouter.NotAContract.selector);
        new TegridyFeeExecutorRouter(makeAddr("noCodeWeth"), address(revDist), treasury, FEE_BPS, t, s);
    }

    /// [executepolaccumulator-missing-reassert] The accumulator loses its code during the 48h
    /// timelock window; execute must re-assert allowability (mirrors executeAllowTarget).
    /// Pre-fix: execute installed the code-less address without reverting.
    function test_executePolAccumulator_reassertsAllowable() public {
        address acc = address(new SimpleReceiver());
        router.proposePolAccumulator(acc);
        vm.etch(acc, ""); // code vanishes mid-window (self-destruct analogue)
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(TegridyFeeExecutorRouter.NotAContract.selector);
        router.executePolAccumulator();
        assertEq(router.polAccumulator(), address(0), "code-less accumulator not installed");
    }

    /// [tokenin-tokenout-unchecked] tokenIn == tokenOut folds the caller's just-pulled principal
    /// into the outBefore baseline (read AFTER the pull); the invariant must be enforced, not
    /// incidental. Pre-fix: the call was accepted (safe only by algebra) → expectRevert fails.
    function test_revert_tokenInEqualsTokenOut() public {
        vm.startPrank(user);
        tokenIn.approve(address(router), 1 ether);
        vm.expectRevert(TegridyFeeExecutorRouter.SameToken.selector);
        router.swapERC20(
            address(tokenIn),
            1 ether,
            address(tokenIn),
            0,
            100,
            address(agg),
            address(agg),
            "",
            user,
            block.timestamp + 600
        );
        vm.stopPrank();
    }
}
