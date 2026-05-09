// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

interface IVoteIncentivesC2 {
    function commitVote(uint256 epoch, bytes32 commitHash, uint256 power) external returns (uint256);
    function committedPower(address user, uint256 epoch) external view returns (uint256);
    function COMMIT_BOND() external view returns (uint256);
    function commitDeadline(uint256 epoch) external view returns (uint256);
    function computeCommitHash(address user, uint256 epoch, address pair, uint256 power, bytes32 salt)
        external pure returns (bytes32);
}

/// @title AUDIT MICROSCOPE_2026_04_30 — VoteIncentives C2 multi-commit cap
/// @notice The repository's main VoteIncentives test harness exercises the happy path
///         and the per-(user,epoch) bond mechanics. This file targets the *new*
///         invariant: total committed power across all commits in an epoch cannot
///         exceed the voter's snapshot power. Prior to this fix, multi-commit
///         options arbitrage was the canonical Critical finding flagged in the
///         microscope review.
///
///         The unit-style assertions below run against the existing VoteIncentives
///         test scaffolding by re-importing the same fixtures. To keep this file
///         self-contained for `forge test --match-contract` filtering, we extend
///         the existing harness via inheritance; the parent already owns
///         the vi instance, the staking mock, the factory, etc.
import "./VoteIncentives.t.sol";

contract AuditMicroscope_VoteIncentivesTest is VoteIncentivesTest {
    /// @notice C2: a single voter cannot commit more total power than they hold.
    function test_C2_committedPowerCappedAtUserPower() public {
        uint256 epochId = _enableCommitReveal();

        // alice's snapshot power is 7000e18 (per the fixture's _enableCommitReveal()).
        bytes32 salt1 = bytes32(uint256(1));
        bytes32 salt2 = bytes32(uint256(2));
        bytes32 h1 = vi.computeCommitHash(alice, epochId, pair, 4000e18, salt1);
        bytes32 h2 = vi.computeCommitHash(alice, epochId, pair, 4000e18, salt2);

        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND() * 2);
        // First commit: 4000e18 — accepted (committedPower = 4000e18).
        vi.commitVote(epochId, h1, 4000e18);
        // Second commit: another 4000e18 would push committedPower to 8000e18 > 7000e18.
        // Pre-fix this would succeed (multi-commit options-arbitrage primitive).
        // Post-fix it must revert.
        vm.expectRevert(bytes("EXCEEDS_POWER"));
        vi.commitVote(epochId, h2, 4000e18);
        vm.stopPrank();

        assertEq(vi.committedPowerOf(alice, epochId), 4000e18, "first commit landed");
    }

    /// @notice C2: legitimate split across two pairs WITHIN the cap still works.
    function test_C2_splitWithinCapAccepted() public {
        uint256 epochId = _enableCommitReveal();

        bytes32 salt1 = bytes32(uint256(11));
        bytes32 salt2 = bytes32(uint256(22));
        bytes32 h1 = vi.computeCommitHash(alice, epochId, pair, 3000e18, salt1);
        bytes32 h2 = vi.computeCommitHash(alice, epochId, pair, 4000e18, salt2);

        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND() * 2);
        vi.commitVote(epochId, h1, 3000e18);
        vi.commitVote(epochId, h2, 4000e18); // total = 7000e18 = userPower
        vm.stopPrank();

        assertEq(vi.committedPowerOf(alice, epochId), 7000e18);
    }

    /// @notice C2: zero-power commit rejected (defensive against edge-case integer flow).
    function test_C2_zeroPowerCommitRejected() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 0, bytes32(uint256(33)));

        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        vm.expectRevert(VoteIncentives.ZeroAmount.selector);
        vi.commitVote(epochId, h, 0);
        vm.stopPrank();
    }
}
