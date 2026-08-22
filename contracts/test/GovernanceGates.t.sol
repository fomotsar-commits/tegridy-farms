// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MemeBountyBoard.sol";
import "../src/VoteIncentives.sol";
import "../src/VoteIncentivesAdmin.sol";

// ═══════════════════════════════════════════════════════════════════════
// ║  Mocks                                                             ║
// ═══════════════════════════════════════════════════════════════════════

contract GGToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract GGStaking {
    mapping(address => uint256) public power;

    function setPower(address user, uint256 p) external {
        power[user] = p;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return power[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return power[user];
    }
}

contract GGWeth {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
    }

    receive() external payable {}
}

/// @dev Minimal VotingEscrow mock for VoteIncentives.
contract GGVe {
    mapping(address => uint256) public votingPowers;
    uint256 public totalPower;

    function setVotingPower(address user, uint256 p) external {
        totalPower = totalPower - votingPowers[user] + p;
        votingPowers[user] = p;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return votingPowers[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return votingPowers[user];
    }

    function totalLocked() external view returns (uint256) {
        return totalPower;
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalPower;
    }

    function userTokenId(address) external pure returns (uint256) {
        return 1;
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

contract GGFactory {
    mapping(address => bool) public disabledPairs;

    function getPair(address, address) external pure returns (address) {
        return address(0);
    }
}

/// @dev A real GaugeController-shaped registry — implements `pairToGauge`.
contract GGGaugeController {
    mapping(address => address) public pairToGauge;

    function setPairGauge(address pair, address gauge) external {
        pairToGauge[pair] = gauge;
    }
}

/// @dev A deployed contract that does NOT implement `pairToGauge(address)`.
///      Passes any `code.length > 0` check but bricks the bribe-eligibility
///      read at runtime with empty returndata.
contract GGNotAGaugeController {
    uint256 public somethingElse;

    function poke() external {
        somethingElse++;
    }
}

/// @dev Fallback-everything contract: never reverts, returns nothing. This is
///      the nastiest shape — a naive `try/catch` probe can decode-fail on it.
contract GGSilentFallback {
    fallback() external payable {}
}

/// @dev Local declarations of the NEW rotate surface. Declaring them here
///      rather than calling the concrete types lets every rotate-path test
///      assert a SPECIFIC revert selector while still COMPILING against
///      pre-fix source — which is what makes the mutation run (revert src,
///      keep tests) meaningful. Calling a selector that does not exist on
///      pre-fix bytecode reverts with EMPTY returndata, so
///      `vm.expectRevert(<specific selector>)` FAILS pre-fix rather than
///      passing vacuously.
interface IGGVoteIncentivesRotate {
    function applyGaugeControllerChange(address newGaugeController) external;
}

interface IGGVoteIncentivesAdminRotate {
    function proposeGaugeControllerChange(address newGaugeController) external;
    function executeGaugeControllerChange(address expectedGaugeController, uint256 expectedExecuteAfter) external;
    function gaugeControllerChangeTime() external view returns (uint256);
    function pendingGaugeController() external view returns (address);
}

// ═══════════════════════════════════════════════════════════════════════
// ║  (a) MemeBountyBoard — voter-diversity scoping                      ║
// ═══════════════════════════════════════════════════════════════════════

contract MemeBountyBoardGatesTest is Test {
    MemeBountyBoard public board;
    GGToweli public token;
    GGStaking public staking;
    GGWeth public weth;

    address public creator = makeAddr("gg_creator");
    address public artist1 = makeAddr("gg_artist1");
    address public artist2 = makeAddr("gg_artist2");
    address public whale = makeAddr("gg_whale");
    address public v1 = makeAddr("gg_v1");
    address public v2 = makeAddr("gg_v2");
    address public v3 = makeAddr("gg_v3");

    function setUp() public {
        token = new GGToweli();
        staking = new GGStaking();
        weth = new GGWeth();
        board = new MemeBountyBoard(address(token), address(staking), address(weth), address(0), address(this));
        vm.warp(1_000_000);
        vm.deal(creator, 100 ether);

        staking.setPower(artist1, 500 ether);
        staking.setPower(artist2, 500 ether);
        // Enough on its own to clear MIN_COMPLETION_VOTES (3000e18), but kept
        // small enough that the WHOLE BOARD's aggregate (3500 + 1000 + 1000 =
        // 5500) stays under the separate `MIN_COMPLETION_VOTES * 2` (6000e18)
        // heuristic branch in `emergencyForceCancel` — so these tests isolate
        // the voter-diversity SCOPING defect and nothing else.
        staking.setPower(whale, 3_500 ether);
    }

    function _openBountyWithTwoSubmissions() internal returns (uint256 id) {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Meme contest", block.timestamp + 7 days);
        id = 0;
        vm.prank(artist1);
        board.submitWork(id, "ipfs://a");
        vm.prank(artist2);
        board.submitWork(id, "ipfs://b");
    }

    function _vote(uint256 id, uint256 sub, address voter) internal {
        vm.prank(voter);
        board.voteForSubmission(id, sub);
    }

    /// @dev Sets up the defect shape: ONE wallet decides the top submission,
    ///      two unrelated wallets vote a LOSING submission. The per-BOUNTY
    ///      unique-voter count reads 3; the WINNING submission has 1 voter.
    function _undiverseTopSubmission() internal returns (uint256 id) {
        id = _openBountyWithTwoSubmissions();
        staking.setPower(v1, board.MIN_VOTE_BALANCE());
        staking.setPower(v2, board.MIN_VOTE_BALANCE());
        _vote(id, 0, whale);
        _vote(id, 1, v1);
        _vote(id, 1, v2);
        assertEq(board.topSubmissionId(id), 0, "whale's pick must be the top submission");
        assertEq(board.uniqueVoterCount(id), 3, "bounty-level diversity gate is satisfied");
    }

    /// @dev DEFECT (a1): MIN_UNIQUE_VOTERS is counted per-BOUNTY, so three
    ///      voters spread across DIFFERENT submissions satisfy the "diversity"
    ///      gate while the WINNING submission was chosen by exactly one wallet.
    ///
    ///      Pre-fix: `completeBounty` succeeds and pays the whale's pick.
    ///      Post-fix: reverts INSUFFICIENT_VOTER_DIVERSITY.
    function test_singleVoterCannotDecideWinner() public {
        uint256 id = _undiverseTopSubmission();

        vm.warp(block.timestamp + 7 days + 2 days + 1);

        vm.prank(creator);
        vm.expectRevert(bytes("INSUFFICIENT_VOTER_DIVERSITY"));
        board.completeBounty(id);
    }

    /// @dev DEFECT (a2): the same single-voter top submission ALSO trips the
    ///      `WinnerExists` guard on the permissionless refund path, so the
    ///      creator's ETH cannot be recovered even though `completeBounty`
    ///      can never pay it out.
    ///
    ///      Pre-fix: `refundStaleBounty` reverts WinnerExists.
    ///      Post-fix: refund succeeds (no qualified winner exists).
    function test_refundNotLockedOutByUndiverseTopSubmission() public {
        uint256 id = _undiverseTopSubmission();

        // deadline + DISPUTE_PERIOD + GRACE_PERIOD
        vm.warp(block.timestamp + 7 days + 2 days + 30 days + 1);

        uint256 balBefore = creator.balance;
        board.refundStaleBounty(id);

        assertEq(creator.balance - balBefore, 1 ether, "creator must be refundable");
        (,,,,,, MemeBountyBoard.BountyStatus status) = board.getBounty(id);
        assertEq(uint256(status), uint256(MemeBountyBoard.BountyStatus.Cancelled));
    }

    /// @dev DEFECT (a3): the owner's force-cancel is blocked by the same guard.
    ///      Pre-fix: `emergencyForceCancel` reverts WinnerExists.
    ///      Post-fix: succeeds.
    function test_forceCancelNotLockedOutByUndiverseTopSubmission() public {
        uint256 id = _undiverseTopSubmission();

        vm.warp(block.timestamp + 7 days + 7 days + 1);

        uint256 balBefore = creator.balance;
        board.emergencyForceCancel(id);
        assertEq(creator.balance - balBefore, 1 ether, "owner force-cancel must be available");
    }

    /// @dev CONTROL: an honest, genuinely-diverse, genuinely-funded coalition on
    ///      a single submission still completes and pays the winner.
    function test_control_honestCompletionStillPays() public {
        uint256 id = _openBountyWithTwoSubmissions();

        staking.setPower(v1, 10_000 ether);
        staking.setPower(v2, 10_000 ether);
        staking.setPower(v3, 10_000 ether);
        _vote(id, 0, v1);
        _vote(id, 0, v2);
        _vote(id, 0, v3);

        vm.warp(block.timestamp + 7 days + 2 days + 1);

        uint256 balBefore = artist1.balance;
        vm.prank(creator);
        board.completeBounty(id);
        assertEq(artist1.balance - balBefore, 1 ether, "honest winner must still be paid");
    }

    /// @dev CONTROL: the WinnerExists guard must still hold for a genuinely
    ///      qualified winner — refund paths stay closed.
    function test_control_refundStillBlockedWhenWinnerQualifies() public {
        uint256 id = _openBountyWithTwoSubmissions();

        staking.setPower(v1, 10_000 ether);
        staking.setPower(v2, 10_000 ether);
        staking.setPower(v3, 10_000 ether);
        _vote(id, 0, v1);
        _vote(id, 0, v2);
        _vote(id, 0, v3);

        vm.warp(block.timestamp + 7 days + 2 days + 30 days + 1);

        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        board.refundStaleBounty(id);
    }

    /// @dev DEFECT (a4): `setRestakingContract` is a one-shot wire with no
    ///      code-length guard, unlike the sibling one-shot setters
    ///      (GaugeController.propose/executeRestakingContract,
    ///      VoteIncentives.setVoteIncentivesAdmin / setGaugeController). A
    ///      typo'd EOA permanently bricks restaker vote power.
    ///      Pre-fix: accepts an EOA. Post-fix: reverts.
    function test_setRestakingContract_rejectsEOA() public {
        address eoa = makeAddr("gg_eoa");
        // Assert the SPECIFIC selector, not just "the call failed" —
        // `abi.encodeWithSignature` keeps this compiling against pre-fix
        // source (where `NotAContract` is not declared) so the mutation run
        // still exercises it.
        vm.expectRevert(abi.encodeWithSignature("NotAContract()"));
        board.setRestakingContract(eoa);
        assertEq(board.restakingContract(), address(0));
    }

    /// @dev CONTROL: a real contract is still accepted.
    function test_control_setRestakingContract_acceptsContract() public {
        board.setRestakingContract(address(staking));
        assertEq(board.restakingContract(), address(staking));
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ║  (b) VoteIncentives — gauge-controller probe + timelocked rotation  ║
// ═══════════════════════════════════════════════════════════════════════

contract VoteIncentivesGaugeWiringTest is Test {
    VoteIncentives public vi;
    VoteIncentivesAdmin public viAdmin;
    GGVe public ve;
    GGWeth public weth;
    GGFactory public factory;
    GGToweli public bond;

    function setUp() public {
        ve = new GGVe();
        weth = new GGWeth();
        factory = new GGFactory();
        bond = new GGToweli();
        vm.warp(1_000_000);

        vi = new VoteIncentives(address(ve), address(0xBEEF), address(weth), address(factory), address(bond), 300);
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));
    }

    /// @dev DEFECT (b1): the one-shot `setGaugeController` accepts ANY deployed
    ///      contract. Wiring an address that does not implement `pairToGauge`
    ///      permanently bricks `depositBribe` / `depositBribeETH`.
    ///      Pre-fix: the call succeeds. Post-fix: it reverts.
    function test_setGaugeController_rejectsContractWithoutPairToGauge() public {
        // Deployed BEFORE the expectRevert arm — otherwise the cheatcode binds
        // to the CREATE, not to the setter call.
        GGNotAGaugeController bad = new GGNotAGaugeController();
        vm.expectRevert(abi.encodeWithSignature("GaugeControllerProbeFailed()"));
        vi.setGaugeController(address(bad));
        assertEq(vi.gaugeController(), address(0), "bricked controller must not be wired");
    }

    /// @dev DEFECT (b1b): a silent fallback-everything contract returns success
    ///      with EMPTY returndata — the shape that defeats a naive probe.
    function test_setGaugeController_rejectsSilentFallback() public {
        GGSilentFallback bad = new GGSilentFallback();
        vm.expectRevert(abi.encodeWithSignature("GaugeControllerProbeFailed()"));
        vi.setGaugeController(address(bad));
        assertEq(vi.gaugeController(), address(0));
    }

    /// @dev CONTROL: a genuine GaugeController is accepted.
    function test_control_setGaugeController_acceptsRealController() public {
        GGGaugeController gc = new GGGaugeController();
        vi.setGaugeController(address(gc));
        assertEq(vi.gaugeController(), address(gc));
    }

    /// @dev CONTROL: the bare setter is STILL one-shot — it cannot re-target.
    function test_control_setGaugeController_isStillOneShot() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGGaugeController gc2 = new GGGaugeController();
        vi.setGaugeController(address(gc1));
        vm.expectRevert(VoteIncentives.GaugeControllerAlreadySet.selector);
        vi.setGaugeController(address(gc2));
    }

    /// @dev CONTROL: the zero-address guard on the bare setter is unchanged and
    ///      still fires BEFORE the one-shot check.
    function test_control_setGaugeController_rejectsZero() public {
        vm.expectRevert(abi.encodeWithSignature("ZeroAddress()"));
        vi.setGaugeController(address(0));
    }

    /// @dev DEFECT (b2): there is NO rotate path. A mis-wire is permanent.
    ///      Pre-fix: `proposeGaugeControllerChange` does not exist → the call
    ///      reverts with EMPTY returndata and the specific-selector cheatcode
    ///      below fails. Post-fix: rotation succeeds behind the EXISTING 48h
    ///      admin timelock.
    function test_gaugeControllerRotatesBehindTimelock() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGGaugeController gc2 = new GGGaugeController();
        vi.setGaugeController(address(gc1));

        IGGVoteIncentivesAdminRotate a = IGGVoteIncentivesAdminRotate(address(viAdmin));
        a.proposeGaugeControllerChange(address(gc2));

        uint256 eta = a.gaugeControllerChangeTime();
        assertEq(eta, block.timestamp + 48 hours, "rotation must sit behind the 48h treasury-class delay");

        // Not yet executable. Assert the SPECIFIC timelock error keyed on
        // GAUGE_CONTROLLER_CHANGE so this cannot pass because of an unrelated
        // revert (e.g. a value-binding mismatch).
        vm.expectRevert(
            abi.encodeWithSignature("ProposalNotReady(bytes32)", keccak256("BRIBE_GAUGE_CONTROLLER_CHANGE"))
        );
        a.executeGaugeControllerChange(address(gc2), eta);
        assertEq(vi.gaugeController(), address(gc1));

        vm.warp(eta + 1);
        a.executeGaugeControllerChange(address(gc2), eta);
        assertEq(vi.gaugeController(), address(gc2), "controller must be rotated");
    }

    /// @dev The rotate path is probed too — a bricked candidate cannot be wired
    ///      even through the timelock.
    function test_rotationAlsoProbesCandidate() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGNotAGaugeController bad = new GGNotAGaugeController();
        vi.setGaugeController(address(gc1));

        IGGVoteIncentivesAdminRotate a = IGGVoteIncentivesAdminRotate(address(viAdmin));
        a.proposeGaugeControllerChange(address(bad));

        uint256 eta = a.gaugeControllerChangeTime();
        vm.warp(eta + 1);
        vm.expectRevert(abi.encodeWithSignature("GaugeControllerProbeFailed()"));
        a.executeGaugeControllerChange(address(bad), eta);
        assertEq(vi.gaugeController(), address(gc1), "controller unchanged after failed rotation");
    }

    /// @dev DEFECT (b3): `VoteIncentives.setRestakingContract` is a ONE-SHOT
    ///      wire that carried no code-length guard, while its sibling one-shot
    ///      setters on the SAME contract (`setVoteIncentivesAdmin`,
    ///      `setGaugeController`) both do — as does
    ///      GaugeController.propose/executeRestakingContract. A typo'd EOA is
    ///      unrecoverable and silently zeroes every restaker's bribe vote power.
    ///      Pre-fix: an EOA is accepted and the slot is burned. Post-fix: reverts.
    function test_setRestakingContract_rejectsEOA() public {
        address eoa = makeAddr("gg_vi_eoa");
        vm.expectRevert(abi.encodeWithSignature("NotAContract()"));
        vi.setRestakingContract(eoa);
        assertEq(vi.restakingContract(), address(0), "burned one-shot slot must stay unset");
    }

    /// @dev CONTROL: a real contract is still accepted, and the wire is still one-shot.
    function test_control_setRestakingContract_acceptsContractAndStaysOneShot() public {
        GGGaugeController real = new GGGaugeController();
        // Both deployed BEFORE the expectRevert arm — otherwise the cheatcode
        // binds to the CREATE, not to the setter call.
        GGGaugeController second = new GGGaugeController();
        vi.setRestakingContract(address(real));
        assertEq(vi.restakingContract(), address(real));
        vm.expectRevert(VoteIncentives.RestakingAlreadySet.selector);
        vi.setRestakingContract(address(second));
    }

    /// @dev The rotate path must be admin-only (the timelock is the gate, not
    ///      the owner key alone). Pre-fix the function does not exist, so the
    ///      call reverts with EMPTY returndata and the specific-selector
    ///      cheatcode fails.
    function test_applyGaugeControllerChange_isAdminOnly() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGGaugeController gc2 = new GGGaugeController();
        vi.setGaugeController(address(gc1));

        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSignature("NotVoteIncentivesAdmin()"));
        IGGVoteIncentivesRotate(address(vi)).applyGaugeControllerChange(address(gc2));
        assertEq(vi.gaugeController(), address(gc1));
    }

    /// @dev The rotate path must ALSO be unreachable by the OWNER key directly:
    ///      the whole justification for relaxing the one-shot lock is that
    ///      rotation is gated by the sister admin's 48h timelock. If the owner
    ///      could call `applyGaugeControllerChange` straight through, the
    ///      documented "a captured owner cannot retarget the bribe-eligibility
    ///      check" control would be gone outright rather than merely delayed.
    ///      `address(this)` is the owner in this fixture.
    function test_applyGaugeControllerChange_rejectsOwnerDirectly() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGGaugeController gc2 = new GGGaugeController();
        vi.setGaugeController(address(gc1));
        assertEq(vi.owner(), address(this), "fixture assumption: test contract is the owner");

        vm.expectRevert(abi.encodeWithSignature("NotVoteIncentivesAdmin()"));
        IGGVoteIncentivesRotate(address(vi)).applyGaugeControllerChange(address(gc2));
        assertEq(vi.gaugeController(), address(gc1), "owner key alone must not retarget the controller");
    }

    /// @dev The rotation proposal must be flushed on ownership handoff, exactly
    ///      like every other pending proposal on this admin (the 2026-06-11
    ///      acceptOwnership pending-proposal-flush pattern). Otherwise a
    ///      pre-handoff rotation could fire under the NEW owner.
    function test_rotationProposalFlushedOnOwnershipHandoff() public {
        GGGaugeController gc1 = new GGGaugeController();
        GGGaugeController gc2 = new GGGaugeController();
        vi.setGaugeController(address(gc1));

        IGGVoteIncentivesAdminRotate a = IGGVoteIncentivesAdminRotate(address(viAdmin));
        a.proposeGaugeControllerChange(address(gc2));
        assertGt(a.gaugeControllerChangeTime(), 0, "proposal queued");

        address newOwner = makeAddr("gg_new_admin_owner");
        viAdmin.transferOwnership(newOwner);
        vm.prank(newOwner);
        viAdmin.acceptOwnership();

        assertEq(a.gaugeControllerChangeTime(), 0, "handoff must flush the queued rotation");
        assertEq(a.pendingGaugeController(), address(0), "handoff must clear the pending candidate");
    }
}
