// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/GaugeController.sol";

contract MockTOWELICR is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBACCR is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
    function burnFrom(address owner, uint256 tokenId) external { require(ownerOf(tokenId) == owner); _burn(tokenId); }
}

/// @title GaugeController Commit-Reveal Test Suite (Audit H-2 closure)
/// @notice Exercises the contract-level commit-reveal flow added to close the
///         bribe-arbitrage vector that epoch-start snapshot voting (TF-04)
///         didn't fully address.
contract GaugeCommitRevealTest is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    MockTOWELICR public toweli;
    MockJBACCR public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public attacker = makeAddr("attacker");

    address public gauge1 = makeAddr("gauge1");
    address public gauge2 = makeAddr("gauge2");
    address public gauge3 = makeAddr("gauge3");

    uint256 internal aliceTokenId;
    uint256 internal bobTokenId;

    function setUp() public {
        toweli = new MockTOWELICR();
        jbac = new MockJBACCR();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        toweli.transfer(alice, 500_000 ether);
        toweli.transfer(bob, 500_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();
        aliceTokenId = staking.userTokenId(alice);

        vm.startPrank(bob);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();
        bobTokenId = staking.userTokenId(bob);

        _addGauge(gauge1);
        _addGauge(gauge2);
        _addGauge(gauge3);

        // Same rationale as GaugeControllerTest: advance one epoch so stakers have
        // checkpoints visible at epochStartTime(currentEpoch).
        vm.warp(block.timestamp + 7 days);
    }

    function _addGauge(address g) internal {
        gauge.proposeAddGauge(g);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeAddGauge();
    }

    /// @dev Move the clock into the reveal window of the current epoch.
    function _warpToRevealWindow() internal {
        uint256 epoch = gauge.currentEpoch();
        uint256 revealOpens = gauge.epochStartTime(epoch) + 7 days - 24 hours;
        vm.warp(revealOpens + 1);
    }

    function _buildBallot() internal view returns (address[] memory gauges, uint256[] memory weights) {
        gauges = new address[](2);
        gauges[0] = gauge1;
        gauges[1] = gauge2;
        weights = new uint256[](2);
        weights[0] = 6000;
        weights[1] = 4000;
    }

    // ═══════════════════════════════════════════════════════════════
    // HAPPY PATH
    // ═══════════════════════════════════════════════════════════════

    function test_commitThenReveal_happyPath() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("alice-secret-1");
        uint256 epoch = gauge.currentEpoch();

        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        assertEq(gauge.commitmentOf(aliceTokenId, epoch), hash, "commitment stored");
        assertEq(gauge.committerOf(aliceTokenId, epoch), alice, "committer recorded");

        _warpToRevealWindow();

        vm.prank(alice);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);

        // Vote is counted
        assertTrue(gauge.hasVotedInEpoch(aliceTokenId, epoch), "marked voted");
        // Commitment cleared
        assertEq(gauge.commitmentOf(aliceTokenId, epoch), bytes32(0), "commitment cleared");
        // Gauge weights populated
        assertGt(gauge.getGaugeWeight(gauge1), 0, "gauge1 weighted");
        assertGt(gauge.getGaugeWeight(gauge2), 0, "gauge2 weighted");
        assertEq(gauge.getGaugeWeight(gauge3), 0, "gauge3 untouched");
    }

    function test_isRevealWindowOpen_transitionsCorrectly() public {
        (, bool openBefore,,) = gauge.isRevealWindowOpen();
        assertFalse(openBefore, "closed during commit window");

        _warpToRevealWindow();

        (, bool openDuring,,) = gauge.isRevealWindowOpen();
        assertTrue(openDuring, "open during reveal window");

        vm.warp(block.timestamp + 24 hours);

        (, bool openAfter,,) = gauge.isRevealWindowOpen();
        assertFalse(openAfter, "closed after epoch rolls over");
    }

    // ═══════════════════════════════════════════════════════════════
    // COMMIT WINDOW ENFORCEMENT
    // ═══════════════════════════════════════════════════════════════

    function test_commit_revertsInsideRevealWindow() public {
        _warpToRevealWindow();

        bytes32 hash = keccak256("whatever");
        vm.prank(alice);
        vm.expectRevert(GaugeController.CommitWindowClosed.selector);
        gauge.commitVote(aliceTokenId, hash);
    }

    function test_commit_revertsOnZeroHash() public {
        vm.prank(alice);
        vm.expectRevert(GaugeController.ZeroCommitment.selector);
        gauge.commitVote(aliceTokenId, bytes32(0));
    }

    function test_commit_revertsIfNotOwner() public {
        bytes32 hash = keccak256("x");
        vm.prank(attacker);
        vm.expectRevert(GaugeController.NotTokenOwner.selector);
        gauge.commitVote(aliceTokenId, hash);
    }

    function test_commit_revertsOnDoubleCommit() public {
        bytes32 hash = keccak256("x");
        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        vm.prank(alice);
        vm.expectRevert(GaugeController.AlreadyCommitted.selector);
        gauge.commitVote(aliceTokenId, hash);
    }

    function test_commit_revertsAfterLegacyVote() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();

        // Legacy one-step vote() path first
        vm.prank(alice);
        gauge.vote(aliceTokenId, gauges, weights);

        // Then a commit attempt in the same epoch must fail.
        bytes32 hash = keccak256("x");
        vm.prank(alice);
        vm.expectRevert(GaugeController.AlreadyVotedThisEpoch.selector);
        gauge.commitVote(aliceTokenId, hash);
    }

    // ═══════════════════════════════════════════════════════════════
    // REVEAL WINDOW ENFORCEMENT
    // ═══════════════════════════════════════════════════════════════

    function test_reveal_revertsBeforeWindow() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");
        uint256 epoch = gauge.currentEpoch();
        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        // Still in commit window
        vm.prank(alice);
        vm.expectRevert(GaugeController.RevealWindowNotOpen.selector);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);
    }

    function test_reveal_revertsWithoutCommit() public {
        _warpToRevealWindow();

        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");

        vm.prank(alice);
        vm.expectRevert(GaugeController.NoCommitment.selector);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);
    }

    function test_reveal_revertsOnWrongSalt() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("real");
        uint256 epoch = gauge.currentEpoch();
        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        _warpToRevealWindow();

        vm.prank(alice);
        vm.expectRevert(GaugeController.CommitmentMismatch.selector);
        gauge.revealVote(aliceTokenId, gauges, weights, keccak256("fake"));
    }

    function test_reveal_revertsOnTamperedWeights() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");
        uint256 epoch = gauge.currentEpoch();
        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        _warpToRevealWindow();

        // Flip the weights — should fail the hash check.
        uint256[] memory tampered = new uint256[](2);
        tampered[0] = 4000;
        tampered[1] = 6000;

        vm.prank(alice);
        vm.expectRevert(GaugeController.CommitmentMismatch.selector);
        gauge.revealVote(aliceTokenId, gauges, tampered, salt);
    }

    function test_reveal_revertsIfNotCommitter() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");
        uint256 epoch = gauge.currentEpoch();
        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);

        _warpToRevealWindow();

        // Alice transfers the NFT to attacker mid-epoch. Attacker tries to reveal
        // but is not the original committer — reveal is bound to the committer.
        vm.prank(alice);
        staking.transferFrom(alice, attacker, aliceTokenId);

        vm.prank(attacker);
        vm.expectRevert(GaugeController.NotCommitter.selector);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);
    }

    // ═══════════════════════════════════════════════════════════════
    // REPLAY / CROSS-EPOCH PROTECTION
    // ═══════════════════════════════════════════════════════════════

    function test_commitment_cannotReplayAcrossEpochs() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");
        uint256 epoch0 = gauge.currentEpoch();

        // Commit + reveal in epoch0 successfully.
        bytes32 hash0 = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch0);
        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash0);
        _warpToRevealWindow();
        vm.prank(alice);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);

        // Advance to the START of the next epoch so we're inside its commit window.
        uint256 nextEpoch = epoch0 + 1;
        vm.warp(gauge.epochStartTime(nextEpoch) + 1 hours);
        uint256 epoch1 = gauge.currentEpoch();
        assertGt(epoch1, epoch0, "epoch advanced");
        (, bool openCheck,,) = gauge.isRevealWindowOpen();
        assertFalse(openCheck, "should be back in commit window for epoch1");

        // Try to replay the epoch0 commitment in epoch1. The hash includes epoch0,
        // so commitVote accepts it as a raw bytes32 but revealVote rebuilds the hash
        // with epoch1 and the two will mismatch.
        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash0);

        _warpToRevealWindow();

        vm.prank(alice);
        vm.expectRevert(GaugeController.CommitmentMismatch.selector);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);
    }

    // ═══════════════════════════════════════════════════════════════
    // INTEROP WITH LEGACY vote()
    // ═══════════════════════════════════════════════════════════════

    function test_legacyVote_revertsAfterReveal() public {
        (address[] memory gauges, uint256[] memory weights) = _buildBallot();
        bytes32 salt = keccak256("s");
        uint256 epoch = gauge.currentEpoch();
        bytes32 hash = gauge.computeCommitment(alice, aliceTokenId, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(aliceTokenId, hash);
        _warpToRevealWindow();
        vm.prank(alice);
        gauge.revealVote(aliceTokenId, gauges, weights, salt);

        // Legacy vote() must now fail with AlreadyVotedThisEpoch.
        vm.prank(alice);
        vm.expectRevert(GaugeController.AlreadyVotedThisEpoch.selector);
        gauge.vote(aliceTokenId, gauges, weights);
    }
}
