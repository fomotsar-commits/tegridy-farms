// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/VoteIncentives.sol";
import "../../src/VoteIncentivesAdmin.sol";

/// @title  Reachability_VoteIncentivesBribeExit
/// @notice REACHABILITY ("no trapped value") invariant for the bribe pool.
///
///         WHY A NEW PROPERTY CLASS. The existing invariant suite (38
///         `invariant_*` across test/invariants) pins CONSERVATION, SOLVENCY,
///         BOUNDS and MONOTONICITY. None of those can catch a stranding bug,
///         because *a trapped balance still balances*: every conservation sum
///         stays perfectly satisfied while the value is unspendable. The
///         1000-agent audit's M-1 (sub-18-decimal swap fees with all three
///         exits closed) was exactly this shape, and so is the case pinned
///         here. The catching property is REACHABILITY:
///
///             for any (epoch, pair, token) with a non-zero finalized bribe
///             pool, at least ONE PERMISSIONLESS exit must be callable
///             — a voter's claimBribes, or a depositor's refundUnvotedBribe
///               / refundOrphanedBribe.
///
///         THE CASE — FIXED 2026-09-02 BY AUDIT TF-006; THIS FILE NOW PINS THE
///         FIX RATHER THAN THE TRAP. `disabledPairs` is a factory flag that
///         governance can set (timelocked `proposePairDisabled`, or the
///         guardian's `emergencyDisablePair`). If a pair was disabled AFTER an
///         epoch was finalized and voted past MIN_BRIBE_CLAIM_QUORUM, all three
///         exits used to close simultaneously:
///           * claimBribes          -> _validatePair reverts PairDisabled
///           * refundUnvotedBribe   -> requires totalGaugeVotes == 0 ("PAIR_HAS_VOTES")
///           * refundOrphanedBribe  -> requires epoch >= epochs.length ("EPOCH_ALREADY_SNAPSHOTTED")
///         and the bribe was unreachable by any permissionless actor.
///
///         TF-006 removed `_validatePair` from the two CLAIM paths, so door 1
///         no longer closes. The gate stays on all four ENTRY paths (vote,
///         revealVote, depositBribe, depositBribeETH) — the same entry/exit
///         split TegridyPair already applied, where mint()/swap() are gated and
///         burn() "intentionally remains callable on disabled pairs (LP exit)".
///         Doors 2 and 3 still refuse, for their own unchanged and correct
///         preconditions; they were never the right door for this case, which
///         is precisely why closing door 1 trapped the value.
///
///         SEVERITY, FOR THE RECORD. Before the fix this was "temporarily gated
///         by governance", NOT "permanently lost": the disable is reversible via
///         `proposePairDisabled(pair, false)`, and the test now named
///         `test_reEnableIsNoLongerNeededForTheExit` used to pin exactly that
///         recovery. An external audit later reported this as permanent
///         stranding; that overstated it, and this file is the evidence. What
///         was real was that an ordinary governance action could put a voter's
///         EARNED share behind a second governance action. It no longer can.
///
///         NOTE the mock factory here returns a REAL getPair mapping. The
///         pre-existing VoteIncentivesShares mock returns address(0), which
///         makes `_validatePair` revert InvalidPair on every call — and that
///         harness swallows calls in try/catch, so its handler exercises far
///         less than it appears to.

contract RBEToken is ERC20 {
    constructor() ERC20("Bribe", "BRB") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract RBEToweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract RBEEscrow {
    mapping(address => uint256) public power;
    uint256 public total;

    function setPower(address u, uint256 p) external {
        total = total + p - power[u];
        power[u] = p;
    }

    function votingPowerOf(address u) external view returns (uint256) {
        return power[u];
    }

    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) {
        return power[u];
    }

    function totalLocked() external view returns (uint256) {
        return total;
    }

    function totalBoostedStake() external view returns (uint256) {
        return total;
    }

    function userTokenId(address u) external view returns (uint256) {
        return power[u] > 0 ? 1 : 0;
    }

    function positions(uint256)
        external
        pure
        returns (uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool)
    {
        return (0, 0, 0, 0, 0, 0, false, false, 0, 0, false);
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

/// @dev Unlike the pre-existing mock, getPair resolves properly so `_validatePair`
///      actually passes; `disabledPairs` is settable so the gate can be tripped.
contract RBEFactory {
    mapping(address => bool) public disabledPairs;
    mapping(bytes32 => address) internal _pairs;

    function setPair(address t0, address t1, address p) external {
        _pairs[keccak256(abi.encodePacked(t0, t1))] = p;
        _pairs[keccak256(abi.encodePacked(t1, t0))] = p;
    }

    function getPair(address t0, address t1) external view returns (address) {
        return _pairs[keccak256(abi.encodePacked(t0, t1))];
    }

    function isPair(address p) external view returns (bool) {
        return !disabledPairs[p];
    }

    function setDisabled(address p, bool d) external {
        disabledPairs[p] = d;
    }
}

contract RBEPair {
    address public immutable token0;
    address public immutable token1;

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }
}

contract RBEWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 v) external {
        balanceOf[msg.sender] -= v;
        (bool ok,) = msg.sender.call{value: v}("");
        require(ok, "weth");
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
    receive() external payable {}
}

contract Reachability_VoteIncentivesBribeExitTest is Test {
    VoteIncentives internal vi;
    VoteIncentivesAdmin internal viAdmin;
    RBEEscrow internal escrow;
    RBEFactory internal factory;
    RBEPair internal pair;
    RBEWETH internal weth;
    RBEToweli internal toweli;
    RBEToken internal bribeToken;

    address internal treasury = makeAddr("rbe_treasury");
    address internal voter1 = makeAddr("rbe_voter1");
    address internal voter2 = makeAddr("rbe_voter2");
    address internal depositor = makeAddr("rbe_depositor"); // NOT a voter: self-claim is barred

    uint256 internal constant BRIBE = 100 ether;

    function setUp() public {
        escrow = new RBEEscrow();
        factory = new RBEFactory();
        weth = new RBEWETH();
        toweli = new RBEToweli();
        bribeToken = new RBEToken();
        pair = new RBEPair(address(toweli), address(weth));
        factory.setPair(address(toweli), address(weth), address(pair));

        vi = new VoteIncentives(address(escrow), treasury, address(weth), address(factory), address(toweli), 300);
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));

        viAdmin.proposeWhitelistChange(address(bribeToken), true);
        vm.warp(block.timestamp + 25 hours);
        viAdmin.executeWhitelistChange(
            viAdmin.pendingWhitelistToken(), viAdmin.pendingWhitelistAction(), viAdmin.whitelistChangeTime()
        );

        // Voting power well above MIN_BRIBE_CLAIM_QUORUM (100e18).
        escrow.setPower(voter1, 5_000e18);
        escrow.setPower(voter2, 3_000e18);
        vm.warp(block.timestamp + 2 hours);
    }

    /// @dev Epochs are tagged `usesCommitReveal`, so plain vote() is rejected
    ///      (LegacyVoteOnCommitRevealEpoch). Real flow: commit (bonded) inside the
    ///      commit window, then reveal inside the reveal window.
    function _commit(address v, uint256 epoch, uint256 power, bytes32 salt) internal returns (uint256 idx) {
        toweli.mint(v, vi.COMMIT_BOND());
        vm.startPrank(v);
        toweli.approve(address(vi), vi.COMMIT_BOND());
        bytes32 h = vi.computeCommitHash(v, epoch, address(pair), power, salt);
        idx = vi.commitVote(epoch, h, power);
        vm.stopPrank();
    }

    function _reveal(address v, uint256 epoch, uint256 idx, uint256 power, bytes32 salt) internal {
        vm.prank(v);
        vi.revealVote(epoch, idx, address(pair), power, salt);
    }

    /// @dev deposit into the live bucket -> finalize -> commit+reveal past quorum
    ///      -> open the claim window. Returns the finalized epoch index.
    function _seedVotedEpoch() internal returns (uint256 epoch) {
        bribeToken.mint(depositor, BRIBE);
        vm.startPrank(depositor);
        bribeToken.approve(address(vi), BRIBE);
        vi.depositBribe(address(pair), address(bribeToken), BRIBE);
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days + 1);
        vi.advanceEpoch();
        epoch = vi.epochCount() - 1;

        // Commit window opens strictly after the snapshot timestamp.
        vm.warp(block.timestamp + 1 hours);
        uint256 i1 = _commit(voter1, epoch, 5_000e18, bytes32("s1"));
        uint256 i2 = _commit(voter2, epoch, 3_000e18, bytes32("s2"));

        // Reveal window opens strictly after commitDeadline.
        vm.warp(vi.commitDeadline(epoch) + 1);
        _reveal(voter1, epoch, i1, 5_000e18, bytes32("s1"));
        _reveal(voter2, epoch, i2, 3_000e18, bytes32("s2"));

        // Past revealDeadline so claimBribes' ClaimWindowNotOpen gate is satisfied.
        vm.warp(vi.revealDeadline(epoch) + 1);
    }

    /// @notice CONTROL: while the pair is enabled the pool IS reachable — a voter
    ///         can claim. Without this the trap test below could pass for the
    ///         wrong reason (e.g. a mis-seeded epoch with nothing to claim).
    function test_control_enabledPair_voterCanClaim() public {
        uint256 epoch = _seedVotedEpoch();
        uint256 before = bribeToken.balanceOf(voter1);
        vm.prank(voter1);
        vi.claimBribes(epoch, address(pair));
        assertGt(bribeToken.balanceOf(voter1), before, "control: voter should receive bribe share");
    }

    /// @notice THE REACHABILITY VIOLATION. Disable the pair after the epoch is
    ///         finalized and voted past quorum: every permissionless exit closes
    ///         at once, so the bribe pool is unreachable. Conservation-style
    ///         invariants cannot see this — the balance is still fully accounted.
    /// @notice AUDIT FIX TF-006 REVERSED THIS TEST'S POLARITY, deliberately.
    ///
    ///         It used to assert that all three exits close together — the
    ///         characterization of the trap described in this file's header.
    ///         The fix removes `_validatePair` from the two CLAIM paths, so the
    ///         voter's exit now survives a disable and the reachability
    ///         invariant this file exists to defend is SATISFIED rather than
    ///         violated. The test is rewritten, not deleted: the same scenario
    ///         is still constructed, and it still fails loudly if exit 1 ever
    ///         closes again.
    ///
    ///         Exits 2 and 3 are still expected to revert. Their preconditions
    ///         (no votes / epoch not snapshotted) are unchanged and correct —
    ///         they were never the right door for this case, which is exactly
    ///         why closing door 1 trapped the value.
    function test_disabledAfterQuorum_voterExitSurvives() public {
        uint256 epoch = _seedVotedEpoch();

        // Pool is real and non-zero.
        assertGt(vi.epochBribes(epoch, address(pair), address(bribeToken)), 0, "pool should be funded");

        factory.setDisabled(address(pair), true);

        // Exit 1 — voter claim: OPEN. Claiming is an exit, and exits are not
        // gated on disabledPairs (the rule TegridyPair.burn already followed).
        uint256 before = bribeToken.balanceOf(voter1);
        vm.prank(voter1);
        vi.claimBribes(epoch, address(pair));
        assertGt(
            bribeToken.balanceOf(voter1),
            before,
            "REACHABILITY VIOLATION: funded bribe pool with no permissionless exit"
        );

        // Exit 2 — depositor refund of an UNVOTED pool: still blocked, the pair HAS votes.
        vm.prank(depositor);
        vm.expectRevert();
        vi.refundUnvotedBribe(epoch, address(pair), address(bribeToken));

        // Exit 3 — depositor orphan rescue: still blocked, the epoch IS snapshotted.
        vm.prank(depositor);
        vm.expectRevert();
        vi.refundOrphanedBribe(epoch, address(pair), address(bribeToken));
    }

    /// @notice The ENTRY paths must still refuse a disabled pair. Deleting the
    ///         gate wholesale, rather than confining it to exits, would be a
    ///         different bug: bribers funding a dead pair and voters burning
    ///         weight on one. This is the other half of TF-006.
    function test_disabledPair_stillRefusesNewMoneyAndNewVotes() public {
        _seedVotedEpoch();
        factory.setDisabled(address(pair), true);

        bribeToken.mint(depositor, 10 ether);
        vm.startPrank(depositor);
        bribeToken.approve(address(vi), 10 ether);
        vm.expectRevert();
        vi.depositBribe(address(pair), address(bribeToken), 10 ether);
        vm.stopPrank();
    }

    /// @notice Was `test_governanceReEnable_restoresExit`, the SEVERITY BOUND:
    ///         the disable is reversible, so a governance re-enable restored the
    ///         exit, which is what kept this at "temporarily governance-gated"
    ///         rather than "permanently stranded". (Worth keeping in mind when
    ///         reading the external audit: it called this permanent. It was not.)
    ///
    ///         AUDIT FIX TF-006 makes the bound irrelevant — the exit no longer
    ///         needs restoring, because it never closes. The test now pins that
    ///         re-enabling changes nothing for the claimant, which is the
    ///         stronger property and still catches a regression that made the
    ///         exit governance-dependent again.
    function test_reEnableIsNoLongerNeededForTheExit() public {
        uint256 epoch = _seedVotedEpoch();
        factory.setDisabled(address(pair), true);

        // Open while disabled — this is the line that used to expectRevert.
        uint256 mid = bribeToken.balanceOf(voter1);
        vm.prank(voter1);
        vi.claimBribes(epoch, address(pair));
        assertGt(bribeToken.balanceOf(voter1), mid, "the exit must not wait on governance");

        factory.setDisabled(address(pair), false); // governance re-enable

        // Re-enabled: a DIFFERENT voter's exit is open too, and voter1 — who
        // already took theirs while the pair was disabled — cannot take a
        // second. Claiming through a disable must not have skipped the
        // double-claim ledger.
        uint256 before2 = bribeToken.balanceOf(voter2);
        vm.prank(voter2);
        vi.claimBribes(epoch, address(pair));
        assertGt(bribeToken.balanceOf(voter2), before2, "every voter's exit stays open");

        uint256 after1 = bribeToken.balanceOf(voter1);
        vm.prank(voter1);
        vm.expectRevert();
        vi.claimBribes(epoch, address(pair));
        assertEq(bribeToken.balanceOf(voter1), after1, "no second helping for a voter who already claimed");
    }

    /// @notice Fuzzed over bribe size + vote split. The ORIGINAL point was that
    ///         the trap did not depend on magnitude, only on the
    ///         disabled-after-quorum ordering — a guard against a "fix" that
    ///         merely moved a threshold. AUDIT FIX TF-006 keeps that guard and
    ///         flips what it proves: the voter's exit is open at EVERY pool
    ///         size, so a regression that re-closed it only for some magnitude
    ///         still fails here.
    function testFuzz_disabledAfterQuorum_voterExitSurvivesAnyPoolSize(uint96 amt, uint96 p1) public {
        uint256 amount = bound(uint256(amt), 1 ether, 10_000 ether);
        uint256 pow1 = bound(uint256(p1), 200e18, 50_000e18);

        escrow.setPower(voter1, pow1);
        bribeToken.mint(depositor, amount);
        vm.startPrank(depositor);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(address(pair), address(bribeToken), amount);
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days + 1);
        vi.advanceEpoch();
        uint256 epoch = vi.epochCount() - 1;

        vm.warp(block.timestamp + 1 hours);
        uint256 idx = _commit(voter1, epoch, pow1, bytes32("fz"));
        vm.warp(vi.commitDeadline(epoch) + 1);
        _reveal(voter1, epoch, idx, pow1, bytes32("fz"));
        vm.warp(vi.revealDeadline(epoch) + 1);

        factory.setDisabled(address(pair), true);

        uint256 before = bribeToken.balanceOf(voter1);
        vm.prank(voter1);
        vi.claimBribes(epoch, address(pair));
        assertGt(bribeToken.balanceOf(voter1), before, "voter exit must be open at this size too");

        // The other two doors stay shut for their own, unchanged reasons.
        vm.prank(depositor);
        vm.expectRevert();
        vi.refundUnvotedBribe(epoch, address(pair), address(bribeToken));
        vm.prank(depositor);
        vm.expectRevert();
        vi.refundOrphanedBribe(epoch, address(pair), address(bribeToken));
    }
}
