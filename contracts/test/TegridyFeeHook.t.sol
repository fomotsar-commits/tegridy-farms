// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyFeeHook.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @dev Minimal mock PoolManager — most admin/timelock tests just need a
///      non-zero address. The H-5 sync-direction tests also exercise the
///      on-chain credit check, so we expose a configurable `balanceOf`
///      stub matching the IERC6909Claims surface.
contract MockPoolManager {
    mapping(address => mapping(uint256 => uint256)) internal _credit;

    function setCredit(address holder, uint256 id, uint256 amount) external {
        _credit[holder][id] = amount;
    }

    function balanceOf(address holder, uint256 id) external view returns (uint256) {
        return _credit[holder][id];
    }
}

contract TegridyFeeHookTest is Test {
    TegridyFeeHook public hook;
    MockPoolManager public poolManager;

    address public owner;
    address public alice = makeAddr("alice");
    address public distributor = makeAddr("distributor");
    address public newDistributor = makeAddr("newDistributor");
    // AUDIT FIX (pass-8): TF-INT-02. Constructor now takes WETH; mock address suffices
    // for paths that don't exercise the unwrap leg.
    address public weth = makeAddr("weth");

    uint256 public constant INITIAL_FEE = 30; // 0.3%

    function setUp() public {
        owner = address(this);
        poolManager = new MockPoolManager();

        // The TegridyFeeHook constructor requires: uint160(address(this)) & 0x0044 == 0x0044
        // Use deployCodeTo to place the contract at a valid hook address.
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolManager)), distributor, INITIAL_FEE, owner, weth);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    // ─── Constructor validation ─────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(hook.poolManager()), address(poolManager));
        assertEq(hook.revenueDistributor(), distributor);
        assertEq(hook.feeBps(), INITIAL_FEE);
        assertEq(hook.WETH(), weth);
    }

    function test_constructor_revert_zeroPoolManager() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        new TegridyFeeHook(IPoolManager(address(0)), distributor, INITIAL_FEE, owner, weth);
    }

    function test_constructor_revert_zeroDistributor() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        new TegridyFeeHook(IPoolManager(address(poolManager)), address(0), INITIAL_FEE, owner, weth);
    }

    function test_constructor_revert_zeroWETH() public {
        // AUDIT FIX (pass-8): TF-INT-02. Zero WETH is rejected at construction.
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        new TegridyFeeHook(IPoolManager(address(poolManager)), distributor, INITIAL_FEE, owner, address(0));
    }

    function test_constructor_revert_zeroOwner() public {
        // OwnableNoRenounce(address(0)) reverts with OwnableInvalidOwner — we don't
        // duplicate the zero check in TegridyFeeHook's own body.
        vm.expectRevert(
            abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0))
        );
        new TegridyFeeHook(IPoolManager(address(poolManager)), distributor, INITIAL_FEE, address(0), weth);
    }

    function test_constructor_revert_feeTooHigh() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        new TegridyFeeHook(IPoolManager(address(poolManager)), distributor, 101, owner, weth);
    }

    // ─── Deprecated setFee() reverts ────────────────────────────────

    function test_setFee_reverts() public {
        vm.expectRevert("Use proposeFeeChange() + executeFeeChange()");
        hook.setFee(50);
    }

    // ─── Deprecated setRevenueDistributor() reverts ─────────────────

    function test_setRevenueDistributor_reverts() public {
        vm.expectRevert("Use proposeDistributorChange() + executeDistributorChange()");
        hook.setRevenueDistributor(alice);
    }

    // ═══════════════════════════════════════════════════════════════
    // Fee Timelock (24h)
    // ═══════════════════════════════════════════════════════════════

    function test_proposeFeeChange_setsState() public {
        hook.proposeFeeChange(100);
        assertEq(hook.pendingFee(), 100);
        assertEq(hook.feeChangeTime(), block.timestamp + 24 hours);
    }

    function test_proposeFeeChange_revertWhen_feeTooHigh() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        hook.proposeFeeChange(101);
    }

    function test_proposeFeeChange_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.proposeFeeChange(100);
    }

    function test_executeFeeChange_happyPath() public {
        uint256 newFee = 100;
        hook.proposeFeeChange(newFee);

        // Warp past timelock
        vm.warp(block.timestamp + 24 hours);

        hook.executeFeeChange();
        assertEq(hook.feeBps(), newFee);
        assertEq(hook.feeChangeTime(), 0, "feeChangeTime should be reset");
    }

    function test_executeFeeChange_emitsEvent() public {
        hook.proposeFeeChange(50);
        vm.warp(block.timestamp + 24 hours);

        vm.expectEmit(false, false, false, true);
        emit TegridyFeeHook.FeeUpdated(INITIAL_FEE, 50);
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_timelockNotExpired() public {
        hook.proposeFeeChange(100);

        // Warp to just before expiry
        vm.warp(block.timestamp + 24 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeFeeChange_revertWhen_notOwner() public {
        hook.proposeFeeChange(100);
        vm.warp(block.timestamp + 24 hours);

        vm.prank(alice);
        vm.expectRevert();
        hook.executeFeeChange();
    }

    // ═══════════════════════════════════════════════════════════════
    // Distributor Timelock (48h)
    // ═══════════════════════════════════════════════════════════════

    function test_proposeDistributorChange_setsState() public {
        hook.proposeDistributorChange(newDistributor);
        assertEq(hook.pendingDistributor(), newDistributor);
        assertEq(hook.distributorChangeTime(), block.timestamp + 48 hours);
    }

    function test_proposeDistributorChange_revertWhen_zeroAddress() public {
        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        hook.proposeDistributorChange(address(0));
    }

    function test_proposeDistributorChange_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.proposeDistributorChange(newDistributor);
    }

    function test_executeDistributorChange_happyPath() public {
        hook.proposeDistributorChange(newDistributor);

        vm.warp(block.timestamp + 48 hours);

        hook.executeDistributorChange();
        assertEq(hook.revenueDistributor(), newDistributor);
        assertEq(hook.distributorChangeTime(), 0, "distributorChangeTime should be reset");
    }

    function test_executeDistributorChange_emitsEvent() public {
        hook.proposeDistributorChange(newDistributor);
        vm.warp(block.timestamp + 48 hours);

        vm.expectEmit(true, true, false, false);
        emit TegridyFeeHook.DistributorUpdated(distributor, newDistributor);
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_timelockNotExpired() public {
        hook.proposeDistributorChange(newDistributor);

        vm.warp(block.timestamp + 48 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    function test_executeDistributorChange_revertWhen_notOwner() public {
        hook.proposeDistributorChange(newDistributor);
        vm.warp(block.timestamp + 48 hours);

        vm.prank(alice);
        vm.expectRevert();
        hook.executeDistributorChange();
    }

    // ─── Execute without proposal should revert ─────────────────────

    function test_executeFeeChange_withoutProposal_reverts() public {
        // feeChangeTime is 0 by default (no proposal)
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.FEE_CHANGE()));
        hook.executeFeeChange();
    }

    function test_executeDistributorChange_withoutProposal_reverts() public {
        // distributorChangeTime is 0 by default (no proposal)
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, hook.DISTRIBUTOR_CHANGE()));
        hook.executeDistributorChange();
    }

    // ─── Receive ETH ────────────────────────────────────────────────

    function test_receiveETH() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(hook).call{value: 0.5 ether}("");
        assertTrue(ok, "Hook should accept ETH");
    }

    // ─── MAX_FEE_BPS boundary ───────────────────────────────────────

    function test_proposeFeeChange_atMaxFee() public {
        hook.proposeFeeChange(100); // Exactly MAX_FEE_BPS (1%)
        assertEq(hook.pendingFee(), 100);
    }

    function test_proposeFeeChange_aboveMaxFee() public {
        vm.expectRevert(TegridyFeeHook.FeeTooHigh.selector);
        hook.proposeFeeChange(101);
    }

    // ═══════════════════════════════════════════════════════════════
    // X-05: Sync Accrued Fees Bounded Reduction
    // ═══════════════════════════════════════════════════════════════

    function test_syncAccruedFees_rejectsReductionOver50Percent() public {
        // H-01 audit fix: 50% cap was removed. Sync now succeeds with >50% reduction
        // as long as 24h timelock and 7-day cooldown are respected.
        address token = makeAddr("token");
        // Simulate accrued fees by writing to storage directly
        bytes32 slot = keccak256(abi.encode(token, uint256(9))); // accruedFees mapping slot (post-Wave-A storage layout)
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        assertEq(hook.accruedFees(token), 1000);
        // FRESH-2026: Wave A bound any sync to on-chain PoolManager credit. Seed credit ≥ target.
        poolManager.setCredit(address(hook), uint256(uint160(token)), 1000);

        // Propose syncing down to 400 (60% reduction — now allowed after H-01 fix)
        hook.proposeSyncAccruedFees(token, 400);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 400, "60% reduction allowed after H-01 fix");
    }

    function test_syncAccruedFees_allowsReductionAtExactly50Percent() public {
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(9))); // accruedFees mapping slot (post-Wave-A storage layout)
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        // FRESH-2026: Wave A bound any sync to on-chain PoolManager credit. Seed credit ≥ target.
        poolManager.setCredit(address(hook), uint256(uint160(token)), 1000);

        // Propose syncing down to 500 (exactly 50% reduction — should succeed)
        hook.proposeSyncAccruedFees(token, 500);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 500);
    }

    function test_syncAccruedFees_rejectsIncrease_aboveOnChainCredit() public {
        // H-5 update: upward syncs are now ALLOWED, but bounded by the
        // on-chain PoolManager credit. With on-chain credit = 0, any
        // upward sync (1500 > 1000) reverts with AboveOnChainCredit.
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(9))); // accruedFees mapping slot (post-Wave-A storage layout)
        vm.store(address(hook), slot, bytes32(uint256(1000)));

        hook.proposeSyncAccruedFees(token, 1500);
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(TegridyFeeHook.AboveOnChainCredit.selector);
        hook.executeSyncAccruedFees(token);
    }

    function test_syncAccruedFees_allowsIncrease_withinOnChainCredit() public {
        // H-5: upward sync is allowed up to the on-chain PoolManager credit.
        // AUDIT R014 (MAX_SYNC_INCREASE_BPS = 1000 = 10%): also bounded to
        // 10% of the prior accrued value per step. With old=1000, the largest
        // single-step increase is +100 → 1100. Each subsequent step needs
        // another 24h timelock + 7d cooldown (verified in AuditR014_Misc).
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(9))); // accruedFees mapping slot (post-Wave-A storage layout)
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        // Stub the PoolManager credit comfortably above the per-step ceiling
        poolManager.setCredit(address(hook), uint256(uint160(token)), 5000);

        hook.proposeSyncAccruedFees(token, 1100);
        vm.warp(block.timestamp + 7 days);
        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 1100);
    }

    function test_syncAccruedFees_allowsSmallReduction() public {
        address token = makeAddr("token");
        bytes32 slot = keccak256(abi.encode(token, uint256(9))); // accruedFees mapping slot (post-Wave-A storage layout)
        vm.store(address(hook), slot, bytes32(uint256(1000)));
        // FRESH-2026: Wave A bound any sync to on-chain PoolManager credit. Seed credit ≥ target.
        poolManager.setCredit(address(hook), uint256(uint160(token)), 1000);

        // Propose syncing down to 900 (10% reduction — should succeed)
        hook.proposeSyncAccruedFees(token, 900);
        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        hook.executeSyncAccruedFees(token);
        assertEq(hook.accruedFees(token), 900);
    }
}

// ─── AUDIT FIX (pass-8) TF-INT-02: ERC20 → ETH conversion path coverage ──

/// @dev Minimal ERC20 used by the conversion-path tests. Standard transfer/approve.
contract TF_INT_02_MockERC20 {
    string public constant name = "Mock";
    string public constant symbol = "MOCK";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// @dev Minimal WETH9 — supports deposit / withdraw / balanceOf / transfer.
contract TF_INT_02_MockWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "WETH_WITHDRAW_FAIL");
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address, uint256) external pure returns (bool) { return true; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// @dev Minimal V2 router — supports `WETH()` + `swapExactTokensForETH`.
contract TF_INT_02_MockV2Router {
    address public immutable WETH9;
    /// @dev Configurable rate: ethOut = (amountIn * rateBps) / 10_000
    uint256 public rateBps = 10_000; // 1:1 by default
    constructor(address _weth) payable { WETH9 = _weth; }
    function WETH() external view returns (address) { return WETH9; }
    function setRate(uint256 _bps) external { rateBps = _bps; }
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        // Pull token (uses approval the hook just granted via forceApprove).
        TF_INT_02_MockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 ethOut = (amountIn * rateBps) / 10_000;
        require(ethOut >= amountOutMin, "MIN_OUT");
        // Pay ETH to the recipient.
        (bool ok,) = to.call{value: ethOut}("");
        require(ok, "ROUTER_PAY_FAIL");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = ethOut;
    }
    receive() external payable {}
}

/// @dev Distributor that records received ETH within the 10k-gas WETHFallbackLib stipend.
///      The +1 to a hot-warm slot fits in <10k once the slot is pre-warmed.
///      AUDIT FIX (pass-8 batch-10 test): the recorder MUST keep its receive() under 10k
///      gas, otherwise WETHFallbackLib falls back to the WETH-wrap path and we see WETH
///      instead of ETH at the distributor. We pre-warm the slot via the constructor.
contract TF_INT_02_RecordingDistributor {
    uint256 public ethReceived;
    constructor() {
        // Pre-warm the slot so the receive() write costs ~5k (warm SSTORE) instead of
        // ~22k (cold SSTORE), keeping us under the WETHFallbackLib 10k stipend.
        ethReceived = 1;
    }
    receive() external payable { unchecked { ethReceived += msg.value; } }
}

contract TF_INT_02_ConvertTest is Test {
    TegridyFeeHook public hook;
    MockPoolManager public poolManager;
    TF_INT_02_MockERC20 public token;
    TF_INT_02_MockWETH public weth;
    TF_INT_02_MockV2Router public router;
    TF_INT_02_RecordingDistributor public distributor;

    address public owner;
    address public alice = makeAddr("alice_tfint02");

    function setUp() public {
        owner = address(this);
        poolManager = new MockPoolManager();
        token = new TF_INT_02_MockERC20();
        weth = new TF_INT_02_MockWETH();
        // Pre-fund the router with ETH so it can pay out swaps.
        router = new TF_INT_02_MockV2Router{value: 100 ether}(address(weth));
        distributor = new TF_INT_02_RecordingDistributor();

        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolManager)), address(distributor), uint256(30), owner, address(weth));
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    /// @notice Happy path: hook holds ERC20, owner converts to ETH, ETH lands at distributor.
    function test_convertERC20FeesToETH_happyPath() public {
        // Fund hook with 100 token; with 1:1 router rate, expect 100 ETH out.
        token.mint(address(hook), 100 ether);

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            99 ether, // minETHOut floor
            block.timestamp + 5 minutes
        );

        assertEq(token.balanceOf(address(hook)), 0, "hook must have drained ERC20");
        // Pre-warm baseline is 1 (set in constructor); add expected ETH on top.
        assertEq(distributor.ethReceived(), 1 + 100 ether, "distributor must have received ETH");
    }

    /// @notice Sandwich-floor sanity: minETHOut higher than achievable reverts InsufficientETHOut.
    function test_convertERC20FeesToETH_revertsBelowMinETHOut() public {
        token.mint(address(hook), 100 ether);
        router.setRate(5_000); // 50% rate → 50 ETH out for 100 token in

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        // Asking for 60 — router will refuse the trade because it under-pays vs minOut.
        // The router-side `MIN_OUT` revert fires inside the inner call, which bubbles
        // through Solidity's automatic forwarder. We don't pin the exact selector here.
        vm.expectRevert();
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            60 ether,
            block.timestamp + 5 minutes
        );
    }

    /// @notice Reverts for non-owner.
    function test_convertERC20FeesToETH_onlyOwner() public {
        token.mint(address(hook), 1 ether);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        vm.prank(alice);
        vm.expectRevert();
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            0,
            block.timestamp + 5 minutes
        );
    }

    /// @notice Path validation: end != WETH reverts InvalidConversionPath.
    function test_convertERC20FeesToETH_pathEndMustBeWETH() public {
        token.mint(address(hook), 1 ether);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(0xDEAD); // not WETH

        vm.expectRevert(TegridyFeeHook.InvalidConversionPath.selector);
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            0,
            block.timestamp + 5 minutes
        );
    }

    /// @notice Router whose WETH() doesn't match the immutable WETH reverts.
    function test_convertERC20FeesToETH_routerWETHMismatchReverts() public {
        token.mint(address(hook), 1 ether);
        // Router that reports a different WETH.
        TF_INT_02_MockWETH otherWETH = new TF_INT_02_MockWETH();
        TF_INT_02_MockV2Router otherRouter = new TF_INT_02_MockV2Router(address(otherWETH));

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth); // path-end matches the hook's WETH

        vm.expectRevert(TegridyFeeHook.InvalidConversionPath.selector);
        hook.convertERC20FeesToETH(
            address(token),
            address(otherRouter), // but router's WETH() != hook.WETH
            path,
            0,
            block.timestamp + 5 minutes
        );
    }

    /// @notice currency=WETH on the convert function reverts ZeroAddress (caller should use claimFees).
    function test_convertERC20FeesToETH_rejectsWETH() public {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(weth);

        vm.expectRevert(TegridyFeeHook.ZeroAddress.selector);
        hook.convertERC20FeesToETH(
            address(weth),
            address(router),
            path,
            0,
            block.timestamp + 5 minutes
        );
    }

    /// @notice Empty balance → NothingToConvert.
    /// @dev    BATCH-L4 M6: minETHOut now has a 1e14 floor (`InsufficientETHOut`)
    ///         that fires BEFORE the NothingToConvert check. Use a min above the
    ///         floor so we still exercise the zero-balance NothingToConvert path.
    function test_convertERC20FeesToETH_zeroBalanceReverts() public {
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        vm.expectRevert(TegridyFeeHook.NothingToConvert.selector);
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            1e14,
            block.timestamp + 5 minutes
        );
    }

    /// @notice Past-deadline reverts DeadlineOutOfRange.
    function test_convertERC20FeesToETH_pastDeadlineReverts() public {
        token.mint(address(hook), 1 ether);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        vm.expectRevert(TegridyFeeHook.DeadlineOutOfRange.selector);
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            0,
            block.timestamp - 1
        );
    }

    /// @notice Far-future deadline reverts DeadlineOutOfRange.
    function test_convertERC20FeesToETH_farFutureDeadlineReverts() public {
        token.mint(address(hook), 1 ether);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);

        vm.expectRevert(TegridyFeeHook.DeadlineOutOfRange.selector);
        hook.convertERC20FeesToETH(
            address(token),
            address(router),
            path,
            0,
            block.timestamp + 1 hours // > 30 minutes cap
        );
    }

    /// @notice claimFees(WETH, amount) unwraps WETH on the hook and forwards as ETH.
    function test_claimFees_unwrapsWETHAndForwards() public {
        // Pre-fund hook with 5 WETH and bump accruedFees so the gate passes.
        vm.deal(address(this), 5 ether);
        weth.deposit{value: 5 ether}();
        weth.transfer(address(hook), 5 ether);

        // FRESH-2026 TEST REALIGN: accruedFees moved from slot 7 to slot 9 (storage layout shift).
        bytes32 slot = keccak256(abi.encode(address(weth), uint256(9))); // accruedFees slot
        vm.store(address(hook), slot, bytes32(uint256(5 ether)));

        hook.claimFees(address(weth), 5 ether);
        assertEq(distributor.ethReceived(), 1 + 5 ether, "distributor must have received ETH from WETH unwrap");
        assertEq(weth.balanceOf(address(hook)), 0, "hook WETH balance must be zero post-unwrap");
    }
}
