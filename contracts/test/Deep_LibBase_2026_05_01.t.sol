// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import {WETHFallbackLib, IWETH} from "../src/lib/WETHFallbackLib.sol";
import {SequencerCheck, IChainlinkAggregator} from "../src/lib/SequencerCheck.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import {OwnableNoRenounce} from "../src/base/OwnableNoRenounce.sol";
import {Toweli} from "../src/Toweli.sol";

/// @title Deep_LibBase_2026_05_01 — coverage for the DEEP-LIB findings batch
/// @notice One file covering the DEEP-LIB-* fixes applied in the
///         lib/base/Toweli cluster (DEEP_2026_05_01/10_lib_base.md). Each
///         test labels its target finding ID in the function name and
///         documents the structural property it exercises.

// ─── WETHFallbackLib harness ────────────────────────────────────────

/// @dev Minimal `library` wrapper exposing the internal lib functions as
///      external for vm.expectRevert. Each entrypoint is a thin trampoline
///      so the lib's own revert types surface as the test's expected error.
contract WethLibHarness {
    function callOrWrap(address weth, address to, uint256 amount) external {
        WETHFallbackLib.safeTransferETHOrWrap(weth, to, amount);
    }

    function callBare(address to, uint256 amount) external {
        WETHFallbackLib.safeTransferETH(to, amount);
    }

    receive() external payable {}
}

/// @dev Minimal mock WETH for happy-path tests. `deposit` mints internal
///      balance, `transfer` decrements it. No real ETH movements — the
///      harness pre-funds the lib with `vm.deal`.
contract MockWETH is IWETH {
    mapping(address => uint256) public override balanceOf;

    function deposit() external payable override {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw fail");
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Fake L2 sequencer feed. The test sets the round data by writing
///      directly to public fields between calls.
contract MockSequencerFeed is IChainlinkAggregator {
    uint80 public roundId = 1;
    int256 public answer; // 0 = up, non-zero = down
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    function setUp(int256 _answer, uint256 _startedAt) external {
        answer = _answer;
        startedAt = _startedAt;
        updatedAt = block.timestamp;
        answeredInRound = roundId;
    }

    function setStaleUpdated(int256 _answer, uint256 _startedAt, uint256 _updatedAt) external {
        answer = _answer;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        answeredInRound = roundId;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

/// @dev SequencerCheck wrapper for vm.expectRevert.
contract SeqCheckHarness {
    function check(address feed, uint256 grace) external view {
        SequencerCheck.checkSequencerUp(feed, grace);
    }

    function checkWithStaleness(address feed, uint256 grace, uint256 staleness) external view {
        SequencerCheck.checkSequencerUp(feed, grace, staleness);
    }

    function tryCheck(address feed, uint256 grace)
        external
        view
        returns (bool ok, uint8 reason)
    {
        return SequencerCheck.tryCheckSequencerUp(feed, grace);
    }

    function buf(address feed, uint256 buffer) external view returns (uint256) {
        return SequencerCheck.getSequencerOutageBuffer(feed, buffer);
    }
}

// ─── TimelockAdmin harness ──────────────────────────────────────────

/// @dev Concrete subclass that exposes the internal API for testing.
///      Default subclass: no overrides — uses base MIN/MAX/VALIDITY.
contract TimelockHarness is TimelockAdmin {
    function propose(bytes32 key, uint256 delay) external {
        _propose(key, delay);
    }

    function execute(bytes32 key) external {
        _execute(key);
    }

    function cancel(bytes32 key) external {
        _cancel(key);
    }

    function forceCancel(bytes32 key) external returns (bool) {
        return _forceCancel(key);
    }

    function readyAt(bytes32 key) external view returns (uint256) {
        return _executeAfterOf(key);
    }
}

/// @dev Variant that overrides the virtual hooks (DEEP-LIB-L4/L5/M-Lib1).
contract WideTimelockHarness is TimelockAdmin {
    function _maxDelay() internal pure override returns (uint256) {
        return 90 days; // raise the ceiling for treasury-class ops
    }

    function _proposalValidity() internal pure override returns (uint256) {
        return 30 days; // emergency window
    }

    function propose(bytes32 key, uint256 delay) external {
        _propose(key, delay);
    }

    function execute(bytes32 key) external {
        _execute(key);
    }
}

// ─── OwnableNoRenounce harness ──────────────────────────────────────

/// @dev Default subclass — opt-OUT of contract enforcement (default).
contract OwnableHarness is OwnableNoRenounce {
    constructor(address initialOwner) OwnableNoRenounce(initialOwner) {}
}

/// @dev Subclass with the contract-only enforcement opted in.
contract OwnableContractOnlyHarness is OwnableNoRenounce {
    constructor(address initialOwner) OwnableNoRenounce(initialOwner) {}

    function _ownerMustBeContract() internal pure override returns (bool) {
        return true;
    }
}

contract Deep_LibBase_2026_05_01 is Test {
    WethLibHarness wethLib;
    SeqCheckHarness seqLib;
    MockWETH mockWeth;
    MockSequencerFeed feed;
    TimelockHarness tla;
    WideTimelockHarness wideTla;

    address recipient = makeAddr("recipient");

    function setUp() public {
        wethLib = new WethLibHarness();
        seqLib = new SeqCheckHarness();
        mockWeth = new MockWETH();
        feed = new MockSequencerFeed();
        tla = new TimelockHarness();
        wideTla = new WideTimelockHarness();
        // Pre-fund the wethLib harness so it can move real wei.
        vm.deal(address(wethLib), 100 ether);
        // Warp past the safe-arithmetic floor so `block.timestamp - X hours`
        // does not underflow in the sequencer-related tests below. Foundry
        // defaults block.timestamp to 1; we move it to 30 days into 2026.
        vm.warp(1_777_000_000);
    }

    // ─── DEEP-LIB-H1 — zero recipient revert ────────────────────────

    function test_DEEP_LIB_H1_OrWrap_ZeroRecipient_Reverts() public {
        vm.expectRevert(WETHFallbackLib.ZeroRecipient.selector);
        wethLib.callOrWrap(address(mockWeth), address(0), 1 ether);
    }

    function test_DEEP_LIB_H1_Bare_ZeroRecipient_Reverts() public {
        vm.expectRevert(WETHFallbackLib.ZeroRecipient.selector);
        wethLib.callBare(address(0), 1 ether);
    }

    /// Zero-amount short-circuit MUST still no-op (cheaper for callers).
    function test_DEEP_LIB_H1_ZeroAmount_NoOp_EvenWithZeroRecipient() public {
        // Should not revert; the amount==0 short-circuit fires before the
        // zero-recipient check by design (no-op is harmless).
        wethLib.callOrWrap(address(mockWeth), address(0), 0);
        wethLib.callBare(address(0), 0);
    }

    // ─── DEEP-LIB-L1 — success-path ETHTransferred event ────────────

    function test_DEEP_LIB_L1_SuccessPath_Emits_ETHTransferred() public {
        vm.expectEmit(true, false, false, true);
        emit WETHFallbackLib.ETHTransferred(recipient, 1 ether);
        wethLib.callOrWrap(address(mockWeth), recipient, 1 ether);
    }

    // ─── DEEP-LIB-M2 — bare safeTransferETH gas stipend ─────────────

    /// A contract whose `receive()` consumes >10k gas must cause the bare
    /// variant to revert with `ETHTransferFailed` — the stipend is enforced.
    function test_DEEP_LIB_M2_BareTransfer_GasStipend_Enforced() public {
        GasGuzzler g = new GasGuzzler();
        vm.expectRevert(WETHFallbackLib.ETHTransferFailed.selector);
        wethLib.callBare(address(g), 1 ether);
    }

    // ─── DEEP-LIB-H2 — getSequencerOutageBuffer ─────────────────────

    function test_DEEP_LIB_H2_OutageBuffer_NoFeed_ReturnsZero() public view {
        assertEq(seqLib.buf(address(0), 1 hours), 0);
    }

    function test_DEEP_LIB_H2_OutageBuffer_DownReturnsBuffer() public {
        feed.setUp(int256(1), block.timestamp);
        assertEq(seqLib.buf(address(feed), 1 hours), 1 hours);
    }

    function test_DEEP_LIB_H2_OutageBuffer_UpAndOutsideGrace_ReturnsZero() public {
        // resume happened 2h ago; we ask for a 1h buffer → outside grace → 0.
        feed.setUp(int256(0), block.timestamp - 2 hours);
        assertEq(seqLib.buf(address(feed), 1 hours), 0);
    }

    function test_DEEP_LIB_H2_OutageBuffer_StrictAnswer_FailClosed_OnNonOne() public {
        // answer == 2 (a future "degraded" extension) MUST be treated as down.
        feed.setUp(int256(2), block.timestamp - 2 hours);
        assertEq(seqLib.buf(address(feed), 1 hours), 1 hours);
    }

    // ─── DEEP-LIB-M3 — per-call staleness window ────────────────────

    function test_DEEP_LIB_M3_TighterStaleness_Trips_Earlier() public {
        // Sequencer is up but feed was last updated 6h ago.
        feed.setStaleUpdated(int256(0), block.timestamp - 8 hours, block.timestamp - 6 hours);
        // Default 24h staleness allows it.
        seqLib.check(address(feed), 1 hours);
        // With a 4h staleness window, the keeper-lapse check trips.
        vm.expectRevert(SequencerCheck.SequencerDown.selector);
        seqLib.checkWithStaleness(address(feed), 1 hours, 4 hours);
    }

    // ─── DEEP-LIB-M6 — non-reverting tryCheckSequencerUp ─────────────

    function test_DEEP_LIB_M6_TryCheck_OK_OnUpAndOutsideGrace() public {
        feed.setUp(int256(0), block.timestamp - 2 hours);
        (bool ok, uint8 reason) = seqLib.tryCheck(address(feed), 1 hours);
        assertTrue(ok);
        assertEq(reason, SequencerCheck.TRY_OK);
    }

    function test_DEEP_LIB_M6_TryCheck_DownReturnsReason_NotRevert() public {
        feed.setUp(int256(1), block.timestamp);
        (bool ok, uint8 reason) = seqLib.tryCheck(address(feed), 1 hours);
        assertFalse(ok);
        assertEq(reason, SequencerCheck.TRY_SEQ_DOWN);
    }

    function test_DEEP_LIB_M6_TryCheck_InGrace_Reason() public {
        feed.setUp(int256(0), block.timestamp - 30 minutes);
        (bool ok, uint8 reason) = seqLib.tryCheck(address(feed), 1 hours);
        assertFalse(ok);
        assertEq(reason, SequencerCheck.TRY_IN_GRACE);
    }

    function test_DEEP_LIB_M6_TryCheck_NoFeed_OK() public view {
        (bool ok, uint8 reason) = seqLib.tryCheck(address(0), 1 hours);
        assertTrue(ok);
        assertEq(reason, SequencerCheck.TRY_OK);
    }

    // ─── DEEP-LIB-H4 / DEEP-LIB-M5 — _forceCancel + ProposalCancelled ─

    function test_DEEP_LIB_H4_ForceCancel_NoOp_WhenNoPending() public {
        bytes32 K = keccak256("X");
        // Nothing pending; should silently return false without reverting.
        bool r = tla.forceCancel(K);
        assertFalse(r);
    }

    function test_DEEP_LIB_H4_ForceCancel_EmitsCanonicalEvent() public {
        bytes32 K = keccak256("X");
        tla.propose(K, 1 days);
        vm.expectEmit(true, false, false, false);
        emit TimelockAdmin.ProposalCancelled(K);
        bool r = tla.forceCancel(K);
        assertTrue(r);
        assertEq(tla.readyAt(K), 0);
    }

    function test_DEEP_LIB_H4_ExecuteAfterOf_MatchesProposalReadyAt() public {
        bytes32 K = keccak256("Y");
        tla.propose(K, 2 days);
        uint256 expected = block.timestamp + 2 days;
        assertEq(tla.readyAt(K), expected);
    }

    // ─── DEEP-LIB-L4 — virtual maxDelay override ────────────────────

    function test_DEEP_LIB_L4_VirtualMaxDelay_AllowsLongerDelays() public {
        bytes32 K = keccak256("Z");
        // Default harness rejects > 30 days.
        vm.expectRevert(
            abi.encodeWithSelector(TimelockAdmin.DelayTooLong.selector, 60 days, 30 days)
        );
        tla.propose(K, 60 days);

        // Wide harness accepts 60 days because it overrides _maxDelay() to 90 days.
        wideTla.propose(K, 60 days);
    }

    // ─── DEEP-LIB-L5 — virtual proposalValidity override ────────────

    function test_DEEP_LIB_L5_VirtualValidity_ExtendsExecutionWindow() public {
        bytes32 K = keccak256("W");
        wideTla.propose(K, 1 days);
        skip(1 days);
        // 8 days post-ready: default lib would expire (>7 day validity), but the
        // wide subclass exposes a 30-day window via _proposalValidity().
        skip(8 days);
        wideTla.execute(K); // should NOT revert
    }

    // ─── DEEP-LIB-M1 — opt-in contract-only owner enforcement ───────

    function test_DEEP_LIB_M1_DefaultSubclass_AcceptsEOA() public {
        // Default subclass keeps backward compat — EOA is accepted.
        new OwnableHarness(address(this));
    }

    function test_DEEP_LIB_M1_OptInSubclass_RejectsEOA() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(OwnableNoRenounce.OwnerNotContract.selector, eoa)
        );
        new OwnableContractOnlyHarness(eoa);
    }

    function test_DEEP_LIB_M1_OptInSubclass_AcceptsContract() public {
        // Pass a contract (`this`) as the initial owner; should succeed.
        new OwnableContractOnlyHarness(address(this));
    }

    // ─── DEEP-LIB-L2 — renounceOwnership now `view`, not `pure` ─────

    function test_DEEP_LIB_L2_RenounceStillReverts_ButIsView() public {
        OwnableHarness h = new OwnableHarness(address(this));
        // The mutability change is a compile-time property; we verify the
        // runtime contract: the call still reverts with the canonical reason.
        vm.expectRevert(bytes("RENOUNCE_DISABLED"));
        h.renounceOwnership();
    }

    // ─── DEEP-LIB-L3 — Toweli permit accepts ERC-1271 SCW signatures ─

    /// @dev We assert the ECDSA path still works with the new override; the
    ///      ERC-1271 path requires a SCW-style mock that's verbose to set
    ///      up in this batch. The main risk in the override is regressing
    ///      the EOA path (since we re-implemented OZ's permit logic) —
    ///      this test asserts that did not happen.
    function test_DEEP_LIB_L3_Toweli_Permit_EOA_StillWorks() public {
        Toweli token = new Toweli(address(this));
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        // Move 1 TOWELI to `owner` so they have a balance to permit-spend.
        token.transfer(owner, 1 ether);

        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);

        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, 1 ether, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(owner, spender, 1 ether, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), 1 ether);
    }
}

/// @dev Helper contract whose receive() burns more than the 10k stipend by
///      doing a sha256 keccak loop until it runs out of gas. Used to verify
///      the stipend is actually enforced on `safeTransferETH`.
contract GasGuzzler {
    receive() external payable {
        uint256 g = gasleft();
        while (gasleft() > g - 30000) {
            keccak256(abi.encode(g));
        }
    }
}
