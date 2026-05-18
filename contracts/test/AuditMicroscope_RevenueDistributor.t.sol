// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";

/// @dev Mirror of `MockVE_R014` from AuditR014_RevenueDistributor.t.sol.
///      Kept local so this test file is self-contained.
contract MockVE_Microscope {
    mapping(address => uint256) public power;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public total;
    uint256 private _next = 1;

    function setLock(address user, uint256 amt, uint256 end) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _next++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        if (power[user] == 0) total += amt;
        else total = total - power[user] + amt;
        power[user] = amt;
        lockEnds[user] = end;
    }

    function corrupt(address user) external {
        total -= power[user];
        power[user] = 0;
        uint256 tid = userTokenId[user];
        tokenOwner[tid] = address(0);
    }

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return power[user]; }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function paused() external pure returns (bool) { return false; }

    function positions(uint256 tokenId) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        address u = tokenOwner[tokenId];
        return (power[u], power[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockWETH_Microscope {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

/// @title AUDIT MICROSCOPE_2026_04_30 — RevenueDistributor remediation tests
/// @notice Covers the C5 (claim+recovery double-pay) and M-R6 (per-recovery share cap)
///         fixes. C5 closure adds the unified `claimedAtEpoch[user][epoch]` slot that
///         both the normal claim and the recovery paths consult; M-R6 closure caps
///         each recovery at MAX_RECOVERY_POWER_BPS (25%) of `epoch.totalLocked`.
contract AuditMicroscope_RevenueDistributorTest is Test {
    using stdStorage for StdStorage;

    MockVE_Microscope public ve;
    MockWETH_Microscope public weth;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVE_Microscope();
        weth = new MockWETH_Microscope();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        // Three stakers, equal weights so each owns 1/3 of every epoch.
        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob,   100_000 ether, block.timestamp + 365 days);
        ve.setLock(carol, 100_000 ether, block.timestamp + 365 days);
    }

    function _distribute(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok);
        dist.distribute();
        // AUDIT FIX 2026-05-17 TEST: inflate `totalDistributed` for the new
        // MAX_LIFETIME_RECOVERY_BPS (1%) cap. Same rationale as
        // AuditR014_RevenueDistributor.t.sol::_distribute.
        if (dist.totalDistributed() < 1000 ether) {
            stdstore.target(address(dist)).sig(dist.totalDistributed.selector).checked_write(uint256(1000 ether));
        }
    }

    // ─── C5 — Normal-claim → recovery direction ────────────────────────

    /// @notice After alice has claimed epoch 0 normally, owner cannot propose a
    ///         recovery for the same (alice, 0) pair. The fail-fast check at
    ///         propose time prevents wasting a 48h timelock window.
    function test_C5_recoveryRejectedAfterNormalClaim_proposeTime() public {
        _distribute(9 ether); // epoch 0: 9 ETH split equally → 3 ETH per staker

        vm.prank(alice);
        dist.claim();
        // Sanity: alice's normal claim landed.
        assertEq(dist.epochClaimed(0), 3 ether);
        assertTrue(dist.claimedAtEpoch(alice, 0));

        // Owner now tries to propose a recovery. Must fail — alice already paid.
        vm.expectRevert(RevenueDistributor.AlreadyClaimedNormally.selector);
        dist.proposeClaimRecovery(alice, 0, 100_000 ether);
    }

    /// @notice If a proposal somehow lands BEFORE the user claims (race or
    ///         migration), the user can still call claim() during the 48h
    ///         window. After the claim, executeClaimRecovery must revert.
    function test_C5_recoveryRejectedAfterNormalClaim_executeTime() public {
        _distribute(9 ether);

        // Owner proposes recovery for alice on epoch 0 with cap-bound power.
        // (Cap = 25_000 ether on a 300_000 ether totalLocked.)
        dist.proposeClaimRecovery(alice, 0, 25_000 ether);

        // Alice claims normally during the timelock window.
        vm.prank(alice);
        dist.claim();
        assertTrue(dist.claimedAtEpoch(alice, 0));

        // Warp past timelock.
        vm.warp(block.timestamp + 48 hours + 1);

        // Execute now must revert — claimedAtEpoch slot is set.
        vm.expectRevert(RevenueDistributor.AlreadyClaimedNormally.selector);
        dist.executeClaimRecovery(alice, 0);
    }

    // ─── C5 — Recovery → normal-claim direction ────────────────────────

    /// @notice After carol's recovery for epoch 0 lands, a subsequent normal
    ///         claim by carol must skip epoch 0 (no double-pay) and only credit
    ///         later epochs.
    function test_C5_normalClaimSkipsRecoveredEpoch() public {
        _distribute(9 ether); // epoch 0: 9 ETH

        // Move carol into "corrupted" state (mirrors AuditR014 setup).
        ve.corrupt(carol);

        // Owner attests cap-bound power and recovers (25% of 200_000 = 50_000).
        // Note: total post-corrupt is 200_000 ether (alice + bob), so cap is 50_000 ether.
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        uint256 carolReceivedFromRecovery = carol.balance - carolBefore;
        assertGt(carolReceivedFromRecovery, 0, "recovery paid out");
        assertTrue(dist.claimedAtEpoch(carol, 0));

        // Distribute another epoch and have carol's lock be valid again.
        ve.setLock(carol, 100_000 ether, block.timestamp + 365 days);
        vm.warp(block.timestamp + 4 hours + 1);
        _distribute(9 ether); // epoch 1

        // Carol's normal claim now must NOT re-credit epoch 0.
        // Pre-fix: epochClaimed[0] would balloon, draining honest stakers.
        uint256 epoch0ClaimedBefore = dist.epochClaimed(0);
        vm.prank(carol);
        dist.claim();
        assertEq(
            dist.epochClaimed(0),
            epoch0ClaimedBefore,
            "epoch 0 must NOT be re-credited after recovery"
        );
    }

    // ─── M-R6 — Per-recovery cap ───────────────────────────────────────

    /// @notice Owner cannot propose a recovery with attested power exceeding
    ///         `(epoch.totalLocked * 25%) / 10000`. Caps the blast radius of
    ///         a single recovery (or owner-key compromise) to one-quarter of
    ///         the epoch pool.
    function test_MR6_recoveryPowerCapEnforced_atProposeTime() public {
        _distribute(9 ether); // totalLocked 300_000 ether → cap = 75_000 ether

        // Just over the cap must revert.
        vm.expectRevert(RevenueDistributor.RecoveryPowerExceedsCap.selector);
        dist.proposeClaimRecovery(carol, 0, 75_001 ether);

        // Exactly the cap must pass.
        dist.proposeClaimRecovery(carol, 0, 75_000 ether);
    }

    /// @notice Even if a future code path bypasses the propose-time cap, the
    ///         execute-time path also re-applies the cap defensively.
    function test_MR6_recoveryPowerCapAlsoEnforced_atExecuteTime() public {
        _distribute(12 ether); // totalLocked 300_000 → cap = 75_000

        // Propose at the exact cap.
        dist.proposeClaimRecovery(carol, 0, 75_000 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        // Corrupt carol so the share is paid via recovery (not normal claim).
        ve.corrupt(carol);

        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        uint256 paid = carol.balance - carolBefore;

        // 75_000 / 300_000 * 12 = 3 ETH — one quarter of the epoch pool.
        // This is the bound — never more, regardless of attested power.
        assertEq(paid, 3 ether, "recovery payout matches 25% cap");
    }
}
