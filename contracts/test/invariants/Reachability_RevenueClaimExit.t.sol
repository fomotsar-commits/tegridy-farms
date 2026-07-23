// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/RevenueDistributor.sol";

/// @title  Reachability_RevenueClaimExit
/// @notice REACHABILITY ("no trapped value") for staker revenue claims.
///
///         SECOND IN THE SERIES (see Reachability_VoteIncentivesBribeExit).
///         The existing RevenueDistributor invariants pin CONSERVATION
///         (`invariant_voteWeightConservation`) and SOLVENCY
///         (`invariant_ETHSolvency`). Neither can catch a stranding bug: a
///         balance that is fully earmarked, fully solvent and perfectly
///         conserved can still be unclaimable. The catching property is:
///
///             a staker with a non-zero earned share of a distributed epoch
///             must be able to actually CALL claim() and receive it.
///
///         WHAT MAKES THIS ONE INTERESTING — a CROSS-CONTRACT exit blocker.
///         `claim()` / `claimUpTo()` are gated twice (RevenueDistributor.sol:765,
///         769 / :853, 855): by this contract's own `whenNotPaused`, AND by
///         `_isStakingPaused()`, which reads `votingEscrow.paused()` — state
///         owned by a DIFFERENT contract. So pausing TegridyStaking silently
///         freezes revenue claims here. That coupling is invisible to any
///         single-contract conservation invariant.
///
///         DISCLOSED, NOT A BUG — and this test is what keeps it honest. Both
///         pauses are emergency levers and both are REVERSIBLE, so the value is
///         gated, never lost; the recovery halves below pin that. This is also
///         exactly what /security now tells users ("emergency pause is immediate
///         and can halt entries and exits"). If a future change ever makes
///         either pause one-way, the recovery tests fail and the claim on the
///         Security page becomes false — which is the regression worth catching.
///
///         NOTE the pre-existing RevenueInvariants escrow mock hardcodes
///         `paused() => false`, so the staking-paused path is never exercised
///         there. This mock makes it settable.

contract RRCEscrow {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public totalLocked;
    uint256 private _nextTokenId = 1;
    bool public isPaused; // settable — the cross-contract exit blocker

    function setPaused(bool p) external {
        isPaused = p;
    }

    function setLock(address user, uint256 amount, uint256 end) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _nextTokenId++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        if (lockedAmounts[user] == 0) {
            totalLocked += amount;
        } else {
            totalLocked = totalLocked - lockedAmounts[user] + amount;
        }
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function locks(address user) external view returns (uint256, uint256) {
        return (lockedAmounts[user], lockEnds[user]);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool, uint256, bool)
    {
        address user = tokenOwner[tokenId];
        return
            (lockedAmounts[user], lockedAmounts[user], 10000, lockEnds[user], 0, false, int256(0), 0, false, 0, false);
    }

    function paused() external view returns (bool) {
        return isPaused;
    }
}

contract RRCWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract Reachability_RevenueClaimExitTest is Test {
    RevenueDistributor internal dist;
    RRCEscrow internal ve;
    RRCWETH internal weth;

    address internal treasury = makeAddr("rrc_treasury");
    address internal alice = makeAddr("rrc_alice");

    function setUp() public {
        vm.warp(5 hours); // clear distribute()'s initial cooldown
        ve = new RRCEscrow();
        weth = new RRCWETH();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));
        // Single locker: well-defined claim denominator, and clears MIN_DISTRIBUTE_STAKE.
        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
    }

    /// @dev fund + distribute so `alice` has a real, earned, claimable share.
    function _fundAndDistribute(uint256 amount) internal {
        vm.warp(block.timestamp + 4 hours + 1); // MIN_DISTRIBUTE_INTERVAL
        vm.deal(address(this), amount);
        (bool ok,) = address(dist).call{value: amount}("");
        require(ok, "fund failed");
        dist.distribute();
        vm.warp(block.timestamp + 1 hours); // let the epoch settle
    }

    /// @notice CONTROL: with nothing paused, the earned share IS reachable.
    ///         Without this the trap tests could pass for the wrong reason
    ///         (e.g. an epoch that was never funded has nothing to claim).
    function test_control_stakerCanClaim() public {
        _fundAndDistribute(10 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertGt(alice.balance, before, "control: staker must be able to claim earned revenue");
    }

    /// @notice CROSS-CONTRACT BLOCKER: pausing the STAKING contract freezes
    ///         revenue claims in RevenueDistributor. The funds remain earmarked
    ///         and solvent — conservation invariants stay happy — but the exit
    ///         is closed.
    function test_stakingPaused_blocksClaimExit() public {
        _fundAndDistribute(10 ether);

        ve.setPaused(true); // a DIFFERENT contract's state closes this exit

        vm.prank(alice);
        vm.expectRevert(); // StakingPaused
        dist.claim();

        vm.prank(alice);
        vm.expectRevert();
        dist.claimUpTo(1);

        // Still fully funded — the value is gated, not gone.
        assertGt(address(dist).balance, 0, "revenue still held while the exit is closed");
    }

    /// @notice RECOVERY (severity bound): unpausing staking restores the exit.
    ///         If this ever fails, the staking pause has become one-way and the
    ///         /security "pause is reversible" posture is no longer true.
    function test_unpauseStaking_restoresClaimExit() public {
        _fundAndDistribute(10 ether);

        ve.setPaused(true);
        vm.prank(alice);
        vm.expectRevert();
        dist.claim();

        ve.setPaused(false);

        uint256 before = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertGt(alice.balance, before, "unpausing staking must restore the claim exit");
    }

    /// @notice The distributor's OWN pause is the second, independent blocker —
    ///         and it is likewise reversible.
    function test_distributorPause_blocksThenRestoresClaimExit() public {
        _fundAndDistribute(10 ether);

        dist.pause();
        vm.prank(alice);
        vm.expectRevert();
        dist.claim();

        dist.unpause();
        uint256 before = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertGt(alice.balance, before, "unpausing the distributor must restore the claim exit");
    }

    /// @notice Fuzzed over distribution size: reachability must not depend on
    ///         magnitude. Guards against a "fix" that only works above a
    ///         threshold — the exact shape of the audit's M-1 (a floor that was
    ///         unreachable for small/low-decimal balances).
    function testFuzz_earnedRevenueAlwaysReachable(uint96 amt) public {
        uint256 amount = bound(uint256(amt), 1 ether, 500 ether);
        _fundAndDistribute(amount);

        uint256 before = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertGt(alice.balance, before, "any distributed amount must be claimable");
    }
}
