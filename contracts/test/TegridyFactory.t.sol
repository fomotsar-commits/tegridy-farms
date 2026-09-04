// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyPair.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockERC20Factory is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract TegridyFactoryTest is Test {
    TegridyFactory public factory;
    MockERC20Factory public tokenA;
    MockERC20Factory public tokenB;
    address public admin = makeAddr("admin");
    address public newSetter = makeAddr("newSetter");
    address public random = makeAddr("random");

    function setUp() public {
        factory = new TegridyFactory(admin, admin, admin); // F-30-9 initial guardian
        tokenA = new MockERC20Factory("Token A", "TKA");
        tokenB = new MockERC20Factory("Token B", "TKB");
    }

    // ===== 2-STEP feeToSetter TRANSFER (AUDIT FIX #34) =====

    function test_proposeFeeToSetter() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);
        assertEq(factory.pendingFeeToSetter(), newSetter);
    }

    function test_acceptFeeToSetter() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        // AUDIT FIX: Must wait 48h timelock before accepting
        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        assertEq(factory.feeToSetter(), newSetter);
        assertEq(factory.pendingFeeToSetter(), address(0));
    }

    function test_revert_proposeFeeToSetter_notCurrentSetter() public {
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposeFeeToSetter(newSetter);
    }

    function test_revert_proposeFeeToSetter_zeroAddress() public {
        vm.prank(admin);
        vm.expectRevert("ZERO_ADDRESS");
        factory.proposeFeeToSetter(address(0));
    }

    /// @notice ONLY pending setter can accept
    function test_revert_acceptFeeToSetter_notPending() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        // Random cannot accept
        vm.prank(random);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }

    function test_revert_acceptFeeToSetter_noPending() public {
        // No one proposed
        vm.prank(random);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }

    /// @notice After 2-step transfer, new setter can propose + execute feeTo change
    function test_newSetter_canSetFeeTo() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        address newFeeTo = makeAddr("newFeeTo");
        vm.prank(newSetter);
        factory.proposeFeeToChange(newFeeTo);

        // Advance past feeTo change timelock (another 48h from current time)
        vm.warp(block.timestamp + 49 hours);

        vm.prank(newSetter);
        factory.executeFeeToChange();
        assertEq(factory.feeTo(), newFeeTo);
    }

    /// @notice Old setter cannot propose feeTo change after transfer
    function test_revert_oldSetter_cannotSetFeeTo() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        vm.prank(admin);
        vm.expectRevert("FORBIDDEN");
        factory.proposeFeeToChange(makeAddr("x"));
    }

    /// @notice Deprecated setFeeTo reverts
    function test_revert_setFeeTo_deprecated() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToChange()");
        factory.setFeeTo(makeAddr("x"));
    }

    /// @notice Deprecated setFeeToSetter reverts
    function test_revert_setFeeToSetter_deprecated() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToSetter()");
        factory.setFeeToSetter(newSetter);
    }

    // ===== CREATE PAIR =====

    function test_createPair() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertGt(pair.code.length, 0);
        assertEq(factory.allPairsLength(), 1);
    }

    function test_revert_createPair_duplicate() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert("PAIR_EXISTS");
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_revert_createPair_identicalAddresses() public {
        vm.expectRevert("IDENTICAL_ADDRESSES");
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_getPair_bidirectional() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair);
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair);
    }

    // ===== M-12: TOKEN BLOCKLIST =====

    function test_setTokenBlocked() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();
        assertTrue(factory.blockedTokens(address(tokenA)));
    }

    function test_revert_createPair_blockedToken() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        vm.expectRevert("TOKEN_BLOCKED");
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_unblockToken_allowsCreatePair() public {
        // Block tokenA
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        uint256 t1 = block.timestamp + 24 hours + 1;
        vm.warp(t1);
        factory.executeTokenBlocked(address(tokenA));

        // Unblock tokenA
        factory.proposeTokenBlocked(address(tokenA), false);
        uint256 t2 = t1 + 24 hours + 1;
        vm.warp(t2);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertGt(pair.code.length, 0);
    }

    function test_revert_proposeTokenBlocked_notSetter() public {
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposeTokenBlocked(address(tokenA), true);
    }

    // ===== M-12: GRANULARITY CHECK =====

    function test_revert_createPair_erc777WithGranularity() public {
        MockERC777WithGranularity erc777 = new MockERC777WithGranularity();
        vm.expectRevert("ERC777_NOT_SUPPORTED");
        factory.createPair(address(erc777), address(tokenB));
    }

    // ===== M-13: DISABLED PAIRS =====

    function test_proposePairDisabled() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);
        assertEq(factory.pendingPairDisableTime(pair), block.timestamp + 48 hours);
        assertTrue(factory.pendingPairDisableValue(pair));
    }

    function test_executePairDisabled() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertTrue(factory.disabledPairs(pair));
    }

    function test_reEnablePair() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        // Disable
        vm.prank(admin);
        factory.proposePairDisabled(pair, true);
        vm.warp(48 hours + 1);
        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertTrue(factory.disabledPairs(pair));

        // Re-enable
        vm.prank(admin);
        factory.proposePairDisabled(pair, false);
        vm.warp(96 hours + 2);
        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertFalse(factory.disabledPairs(pair));
    }

    function test_revert_executePairDisabled_timelockNotElapsed() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        // Try before timelock
        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pairKey));
        factory.executePairDisabled(pair);
    }

    function test_revert_executePairDisabled_noPending() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pairKey));
        factory.executePairDisabled(pair);
    }

    function test_revert_proposePairDisabled_notSetter() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposePairDisabled(pair, true);
    }

    // --- AUDIT NEW-A2: guardian emergency-pause lane ---
    // Post-fix (F-30-9 / H-16): guardian is set at construction (must be
    // non-zero) and rotations require a multisig-class contract address. The
    // legacy `setGuardian` one-shot is now a recovery path only reachable if
    // `pendingGuardian` rotation lands `address(0)`.

    /// @notice AUDIT NEW-A2 / F-30-9 / H-16: setGuardian is callable only while
    ///         guardian == address(0) AND requires a multisig-class contract.
    /// @dev    AUDIT FIX 2026-05-26 [L-26]: rotation to address(0) is now
    ///         forbidden in proposeGuardianChange (constructor likewise
    ///         requires non-zero), so the recovery path's prerequisite —
    ///         guardian == address(0) — is no longer reachable from any
    ///         production code path. We use vm.store to forcibly zero the
    ///         guardian slot for this test so the recovery-path's auth +
    ///         multisig-class guards remain covered. See
    ///         test_NEWA2_proposeGuardian_zeroNowForbidden below for the
    ///         L-26 tightening itself.
    function test_NEWA2_setGuardian_recoveryPath() public {
        // Forcibly zero the guardian slot (slot 4, per `forge inspect` storage layout)
        // since the production path that previously reached this state has been removed.
        vm.store(address(factory), bytes32(uint256(4)), bytes32(0));
        assertEq(factory.guardian(), address(0), "vm.store should zero guardian");

        // Random cannot call setGuardian.
        DummyMultisig newGuardian = new DummyMultisig();
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.setGuardian(address(newGuardian));

        // EOA rejected (multisig requirement).
        vm.prank(admin);
        vm.expectRevert("GUARDIAN_NOT_MULTISIG");
        factory.setGuardian(random);

        // Contract-class address accepted.
        vm.prank(admin);
        factory.setGuardian(address(newGuardian));
        assertEq(factory.guardian(), address(newGuardian));
    }

    /// @notice AUDIT FIX 2026-05-26 [L-26]: proposeGuardianChange(address(0))
    ///         is now explicitly rejected. The prior "rotate to zero, then
    ///         setGuardian" recovery path is closed by design — non-zero
    ///         multisig is the only supported guardian state.
    function test_NEWA2_proposeGuardian_zeroNowForbidden() public {
        vm.prank(admin);
        vm.expectRevert(bytes("ZERO_GUARDIAN"));
        factory.proposeGuardianChange(address(0));
    }

    /// @notice AUDIT NEW-A2: guardian can INSTANTLY disable a pair, no timelock.
    function test_NEWA2_guardianEmergencyDisableInstant() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        // admin is the initial guardian (set at construction).
        assertFalse(factory.disabledPairs(pair));
        vm.prank(admin);
        factory.emergencyDisablePair(pair);
        assertTrue(factory.disabledPairs(pair));
    }

    /// @notice AUDIT NEW-A2: feeToSetter can also call emergencyDisablePair.
    function test_NEWA2_setterCanEmergencyDisable() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(admin);
        factory.emergencyDisablePair(pair);
        assertTrue(factory.disabledPairs(pair));
    }

    /// @notice AUDIT NEW-A2: random address cannot emergencyDisablePair.
    function test_NEWA2_randomCannotEmergencyDisable() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(random);
        vm.expectRevert("NOT_GUARDIAN");
        factory.emergencyDisablePair(pair);
    }

    /// @notice AUDIT NEW-A2: emergencyDisablePair force-cancels a pending re-enable.
    function test_NEWA2_emergencyDisableCancelsPendingReEnable() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(admin);
        factory.proposePairDisabled(pair, true);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        factory.executePairDisabled(pair);

        // Queue a re-enable (disabled = false) that would pass in 48h.
        vm.prank(admin);
        factory.proposePairDisabled(pair, false);
        assertTrue(factory.pendingPairDisableTime(pair) != 0, "proposal queued");

        // Guardian (admin) triggers emergency - re-enable proposal is wiped.
        vm.prank(admin);
        factory.emergencyDisablePair(pair);
        assertTrue(factory.disabledPairs(pair), "still disabled");
        assertEq(factory.pendingPairDisableTime(pair), 0, "pending re-enable force-cancelled");
        assertFalse(factory.pendingPairDisableValue(pair), "pending value cleared");
    }

    /// @notice AUDIT FIX F-30-1 / M-21 (MED): emergencyDisablePair rejects
    ///         arbitrary addresses that aren't factory-registered pairs.
    function test_F30_1_emergencyDisablePair_rejectsNonFactoryPair() public {
        address fakePair = makeAddr("fakeNotAPair");
        vm.prank(admin);
        vm.expectRevert(TegridyFactory.NotAPair.selector);
        factory.emergencyDisablePair(fakePair);
    }

    /// @notice AUDIT FIX H-16 / F-94-02 (HIGH): emergencyDisablePair is
    ///         per-day rate-limited at MAX_EMERGENCY_DISABLES_PER_DAY = 3.
    function test_H16_emergencyDisablePair_rateLimited() public {
        MockERC20Factory tokenC = new MockERC20Factory("Token C", "TKC");
        MockERC20Factory tokenD = new MockERC20Factory("Token D", "TKD");
        MockERC20Factory tokenE = new MockERC20Factory("Token E", "TKE");
        address[] memory pairs = new address[](4);
        pairs[0] = factory.createPair(address(tokenA), address(tokenB));
        pairs[1] = factory.createPair(address(tokenA), address(tokenC));
        pairs[2] = factory.createPair(address(tokenA), address(tokenD));
        pairs[3] = factory.createPair(address(tokenA), address(tokenE));

        // First 3 disables in same day succeed.
        vm.startPrank(admin);
        factory.emergencyDisablePair(pairs[0]);
        factory.emergencyDisablePair(pairs[1]);
        factory.emergencyDisablePair(pairs[2]);
        // 4th in same day reverts.
        vm.expectRevert(TegridyFactory.EmergencyDisableRateLimited.selector);
        factory.emergencyDisablePair(pairs[3]);
        vm.stopPrank();

        // Counter resets on new UTC day.
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        factory.emergencyDisablePair(pairs[3]);
        assertTrue(factory.disabledPairs(pairs[3]));
    }

    /// @notice AUDIT TF-031: the daily cap is GLOBAL — 3 per day across every
    ///         caller and every pair — so a slot spent is a slot the circuit
    ///         breaker no longer has. Re-disabling an ALREADY-disabled pair
    ///         changes no state, and used to burn one of the three. Three such
    ///         no-ops exhausted the day's budget and left a real rug
    ///         undisableable until the next UTC rollover.
    function test_TF031_repeatDisableDoesNotSpendARateLimitSlot() public {
        MockERC20Factory tokenA = new MockERC20Factory("Token A", "TKA");
        MockERC20Factory tokenB = new MockERC20Factory("Token B", "TKB");
        MockERC20Factory tokenC = new MockERC20Factory("Token C", "TKC");
        address victim = factory.createPair(address(tokenA), address(tokenB));
        address real = factory.createPair(address(tokenA), address(tokenC));

        vm.startPrank(admin);
        factory.emergencyDisablePair(victim); // slot 1 — a real disable
        // Three no-ops on the SAME already-disabled pair. Pre-fix these spent
        // slots 2, 3 and then reverted RateLimited on the fourth call.
        factory.emergencyDisablePair(victim);
        factory.emergencyDisablePair(victim);
        factory.emergencyDisablePair(victim);

        // THE INVARIANT: the breaker still works on a pair that needs it.
        factory.emergencyDisablePair(real);
        vm.stopPrank();

        assertTrue(factory.disabledPairs(real), "TF-031: no-ops must not exhaust the daily budget");
        assertTrue(factory.disabledPairs(victim), "the repeat calls must still leave it disabled");
    }

    /// @notice Non-vacuity: the cap itself must still bite on REAL disables.
    function test_TF031_realDisablesStillHitTheDailyCap() public {
        MockERC20Factory a = new MockERC20Factory("A", "A");
        address[] memory p = new address[](4);
        p[0] = factory.createPair(address(a), address(new MockERC20Factory("B", "B")));
        p[1] = factory.createPair(address(a), address(new MockERC20Factory("C", "C")));
        p[2] = factory.createPair(address(a), address(new MockERC20Factory("D", "D")));
        p[3] = factory.createPair(address(a), address(new MockERC20Factory("E", "E")));

        vm.startPrank(admin);
        factory.emergencyDisablePair(p[0]);
        factory.emergencyDisablePair(p[1]);
        factory.emergencyDisablePair(p[2]);
        vm.expectRevert(TegridyFactory.EmergencyDisableRateLimited.selector);
        factory.emergencyDisablePair(p[3]);
        vm.stopPrank();
    }

    /// @notice AUDIT FIX F-30-2 / M-22 (MED): FEE_TO_SETTER_DELAY is now 24h
    ///         (vs FEE_TO_CHANGE_DELAY = 48h).
    function test_F30_2_setterRotation_fasterThanFeeChange() public {
        assertEq(factory.FEE_TO_SETTER_DELAY(), 24 hours, "setter delay 24h");
        assertEq(factory.FEE_TO_CHANGE_DELAY(), 48 hours, "fee change delay 48h");
    }

    /// @notice AUDIT FIX F-30-2 / M-22 (MED): guardian can also cancel a
    ///         pending FEE_TO_CHANGE proposal (second-layer veto).
    function test_F30_2_guardianCanCancelFeeToChange() public {
        vm.prank(admin);
        factory.proposeFeeToChange(makeAddr("attackerFeeTo"));

        // Rotate guardian to a separate multisig-class address.
        DummyMultisig newGuardian = new DummyMultisig();
        vm.prank(admin);
        factory.proposeGuardianChange(address(newGuardian));
        vm.warp(block.timestamp + factory.GUARDIAN_CHANGE_DELAY());
        vm.prank(admin);
        factory.executeGuardianChange();

        // Guardian aborts the fee redirection.
        vm.prank(address(newGuardian));
        factory.cancelFeeToChange();
        assertEq(factory.pendingFeeTo(), address(0));
    }

    /// @notice AUDIT FIX F-30-5 (MED): pendingTokenBlocks view exposes
    ///         pending block + readyAt for frontends.
    function test_F30_5_pendingTokenBlocksView() public {
        // No proposal - both fields zero.
        (bool blocked, uint256 readyAt) = factory.pendingTokenBlocks(address(tokenA));
        assertFalse(blocked);
        assertEq(readyAt, 0);

        vm.prank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        (blocked, readyAt) = factory.pendingTokenBlocks(address(tokenA));
        assertTrue(blocked);
        assertEq(readyAt, block.timestamp + 24 hours);
    }

    /// @notice AUDIT FIX F-30-10 (INFO): acceptFeeToSetter force-cancels a
    ///         pending GUARDIAN_CHANGE proposed by the OLD setter.
    function test_F30_10_setterAccept_cancelsPendingGuardianChange() public {
        // Old setter (admin) queues a guardian rotation.
        DummyMultisig hostileGuardian = new DummyMultisig();
        vm.prank(admin);
        factory.proposeGuardianChange(address(hostileGuardian));
        assertTrue(factory.proposalExecuteAfter(factory.GUARDIAN_CHANGE()) != 0);

        // Rotate setter (24h delay per F-30-2).
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        // Pending guardian change was force-cancelled.
        assertEq(factory.proposalExecuteAfter(factory.GUARDIAN_CHANGE()), 0);
        assertEq(factory.pendingGuardian(), address(0));
    }

    /// @notice DEPLOY-M6: the old DeployMVP guardian-rotation runbook, executed
    ///         exactly as it was written, and the point at which it dies.
    ///
    ///         DeployMVP used to construct the factory with the deployer EOA as
    ///         guardian and queue `proposeGuardianChange(pauseGuardian)` at deploy,
    ///         then instruct the multisig to run (3) `acceptFeeToSetter()` and
    ///         (3b) `executeGuardianChange()`. Step 3 destroys step 3b: F-30-10
    ///         force-cancels the queued proposal, so 3b reverts and the deployer EOA
    ///         keeps the factory's instant pair-disable power indefinitely — which is
    ///         precisely what audit M6 existed to remove. VerifyMVP INV-11c asserted
    ///         the end state of a step that could never run.
    ///
    ///         Pins BOTH halves: the runbook order fails, and the reachable order
    ///         (accept, THEN propose, THEN 48h, THEN execute) succeeds. The sibling
    ///         test above pins the storage effect; this one pins the CALL that the
    ///         runbook told an operator to make next.
    function test_DeployM6_runbookOrder_executeGuardianChangeRevertsAfterAcceptance() public {
        // ── Deploy-time state: guardian is the deployer EOA (`admin` here, which
        //    setUp passes as all three constructor roles), pauseGuardian queued.
        DummyMultisig pauseGuardian = new DummyMultisig();
        DummyMultisig govSafe = new DummyMultisig();
        // Read the key up front. Calling a getter between `vm.prank` and the call
        // under test consumes the prank, and `executeGuardianChange` would then
        // revert FORBIDDEN instead of the NoPendingProposal this test is about —
        // a green-looking bare `expectRevert()` that proves nothing.
        bytes32 guardianKey = factory.GUARDIAN_CHANGE();

        vm.prank(admin);
        factory.proposeGuardianChange(address(pauseGuardian));
        vm.prank(admin);
        factory.proposeFeeToSetter(address(govSafe));

        // ── Runbook step 3: the Safe accepts feeToSetter after the 24h delay.
        vm.warp(block.timestamp + factory.FEE_TO_SETTER_DELAY());
        vm.prank(address(govSafe));
        factory.acceptFeeToSetter();
        assertEq(factory.feeToSetter(), address(govSafe), "step 3 should hand over the setter role");

        // The acceptance took the queued rotation with it (F-30-10).
        assertEq(factory.pendingGuardian(), address(0), "acceptFeeToSetter must clear pendingGuardian");
        assertEq(factory.proposalExecuteAfter(guardianKey), 0, "GUARDIAN_CHANGE slot must be cleared");

        // ── Runbook step 3b: this is the call the printed runbook said to make
        //    next. Even from the correct caller, and even after the full 48h, there
        //    is no longer anything to execute.
        vm.warp(block.timestamp + factory.GUARDIAN_CHANGE_DELAY());
        vm.prank(address(govSafe));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, guardianKey));
        factory.executeGuardianChange();

        // And so the deployer EOA still holds emergencyDisablePair — the M6 gap.
        assertEq(factory.guardian(), admin, "guardian must still be the deployer EOA after a failed step 3b");

        // ── The reachable order: the NEW setter proposes for itself, waits the full
        //    48h, and executes. Nothing force-cancels it, because nothing runs after.
        vm.prank(address(govSafe));
        factory.proposeGuardianChange(address(pauseGuardian));
        vm.warp(block.timestamp + factory.GUARDIAN_CHANGE_DELAY());
        vm.prank(address(govSafe));
        factory.executeGuardianChange();

        assertEq(factory.guardian(), address(pauseGuardian), "post-acceptance rotation must land");
        assertEq(factory.pendingGuardian(), address(0));
    }

    receive() external payable {}
}

contract MockERC777WithGranularity is ERC20 {
    constructor() ERC20("ERC777Mock", "E777") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function granularity() external pure returns (uint256) {
        return 1;
    }
}

/// @notice AUDIT FIX H-16 / F-94-02 - minimal contract used in tests as a
///         stand-in for a guardian multisig. The factory rejects EOAs
///         (code.length 0) and EIP-7702 delegations (code.length 23); any
///         non-trivial contract bytecode satisfies the gate.
contract DummyMultisig {
    fallback() external {}
}
