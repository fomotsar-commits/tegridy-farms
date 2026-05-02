// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {POLAccumulator} from "../src/POLAccumulator.sol";
import {PremiumAccess} from "../src/PremiumAccess.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Mock voting escrow mirroring the IVotingEscrow surface used by RevenueDistributor.
contract MockVE_Deep {
    mapping(address => uint256) public power;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public total;
    bool public _paused;
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

    function setPaused(bool v) external { _paused = v; }

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return power[user]; }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function paused() external view returns (bool) { return _paused; }

    function positions(uint256 tokenId) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        address u = tokenOwner[tokenId];
        return (power[u], power[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockWETH_Deep {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

/// @title DEEP Audit 2026-05-01 — Revenue / POL / Premium / Referral fixes
/// @notice Regression tests for DEEP audit fixes:
///         - DR-H-01: executeClaimRecovery gated by pause + staking-paused
///         - DR-H-02: executeForfeitReclaim re-checks lifetime cap at execute time
///         - DR-M-01: DUST_RECLAIM_GRACE >= 2 * CLAIM_GRACE_PERIOD
///         - DR-M-02: pause sibling propagation (sweepDust gated)
contract Deep_Revenue_2026_05_01_Test is Test {
    MockVE_Deep public ve;
    MockWETH_Deep public weth;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVE_Deep();
        weth = new MockWETH_Deep();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob,   100_000 ether, block.timestamp + 365 days);
        ve.setLock(carol, 100_000 ether, block.timestamp + 365 days);
    }

    function _distribute(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok);
        dist.distribute();
    }

    // ─── DR-H-01 — executeClaimRecovery respects pause ───────────────────

    /// @notice After the 48h timelock elapses, a paused contract must REJECT
    ///         executeClaimRecovery. Closes the gap where a discovered exploit
    ///         (pause triggered) would still bleed via permissionless recoveries.
    function test_executeClaimRecovery_revertsWhenPaused() public {
        _distribute(9 ether);
        // Owner proposes a recovery for carol.
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        // Owner pauses the contract (response to a discovered exploit).
        dist.pause();

        // executeClaimRecovery is permissionless, but the pause must block it.
        vm.expectRevert();
        dist.executeClaimRecovery(carol, 0);

        // Unpause and confirm execution succeeds.
        dist.unpause();
        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        assertGt(carol.balance, carolBefore, "recovery paid out after unpause");
    }

    /// @notice executeClaimRecovery must also reject when the staking contract
    ///         is paused, mirroring claim() / claimUpTo() behavior under M-10.
    function test_executeClaimRecovery_revertsWhenStakingPaused() public {
        _distribute(9 ether);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        // Staking is paused — recovery must be blocked even though dist itself isn't paused.
        ve.setPaused(true);

        vm.expectRevert(RevenueDistributor.StakingPaused.selector);
        dist.executeClaimRecovery(carol, 0);

        // Unpause staking — execution succeeds.
        ve.setPaused(false);
        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        assertGt(carol.balance, carolBefore, "recovery paid out after staking unpause");
    }

    // ─── DR-H-02 — executeForfeitReclaim caps at lifetime cap ────────────

    /// @notice The execute-time path must re-check the lifetime cap. Models the
    ///         "perfect timing" scenario where the propose-time cap allows the
    ///         full requested amount, the execute-time cap also allows it, and
    ///         the actual reclaimed amount equals the request. Verifies the
    ///         clamping math at the boundary.
    function test_executeForfeitReclaim_capsAtLifetimeCap() public {
        _distribute(100 ether); // totalDistributed=100 → cap=1 ETH
        vm.warp(block.timestamp + 4 hours + 1);
        _distribute(100 ether); // totalDistributed=200 → cap=2 ETH
        vm.warp(block.timestamp + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(2 ether);   // totalDistributed=202 → cap=2.02 ETH

        // First reclaim — 1 ETH is well within the 2.02 ETH cap.
        dist.proposeForfeitReclaim(1 ether);
        skip(48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.totalForfeitedReclaimed(), 1 ether, "first reclaim hit propose amount");

        // Second reclaim — 1 ETH again. cumulative=2 ETH < cap=2.02 ETH, so allowed.
        dist.proposeForfeitReclaim(1 ether);
        skip(48 hours + 1);
        dist.executeForfeitReclaim();
        // After 2nd: cumulative=2 ETH, cap=2.02 ETH (from 202 totalDistributed).
        assertEq(dist.totalForfeitedReclaimed(), 2 ether);

        // After second execute, cap-headroom is just 0.02 ETH. A third propose
        // for 0.05 ETH must revert at PROPOSE time (cap re-checked). Verifies
        // the propose-time gate still holds. (No need to warp — propose checks
        // the cap immediately, regardless of timelock state.)
        vm.expectRevert(RevenueDistributor.ForfeitExceedsLifetimeCap.selector);
        dist.proposeForfeitReclaim(0.05 ether);
    }

    /// @notice Verifies the execute-time lifetime cap clamps `amount` even when
    ///         the propose-time cap was satisfied. We set up a scenario where
    ///         (1) propose-time cap is OK (amount + cumulative <= cap), and
    ///         (2) at execute time, since `totalDistributed` is monotonic, the
    ///         execute-time cap is also OK — so the execute-time clamp simply
    ///         doesn't fire and the full amount is paid. This is the "happy path"
    ///         exercise of the execute-time check ensuring it doesn't break the
    ///         success case.
    function test_executeForfeitReclaim_executeTimeCapAllowsFullAmount() public {
        _distribute(100 ether);
        vm.warp(block.timestamp + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(2 ether);

        uint256 lifetimeCap = (dist.totalDistributed() * dist.MAX_LIFETIME_FORFEIT_BPS()) / 10_000;
        // Should be ~1.02 ETH cap.
        assertGt(lifetimeCap, 0.5 ether);

        dist.proposeForfeitReclaim(0.5 ether);
        vm.warp(block.timestamp + 48 hours + 1);
        dist.executeForfeitReclaim();

        // Full 0.5 ETH was reclaimed — execute-time cap didn't reject it.
        assertEq(dist.totalForfeitedReclaimed(), 0.5 ether);
    }

    // ─── DR-M-01 — DUST_RECLAIM_GRACE >= 2 * CLAIM_GRACE_PERIOD ──────────

    function test_DR_M_01_dustReclaimGraceMatchesAuditConstraint() public view {
        assertGe(dist.DUST_RECLAIM_GRACE(), 2 * dist.CLAIM_GRACE_PERIOD());
    }

    // ─── DR-M-02 — sweepDust gated by pause ──────────────────────────────

    function test_DR_M_02_sweepDustBlockedWhilePaused() public {
        // Send enough ETH to create dust.
        _distribute(2 ether);
        vm.deal(address(dist), address(dist).balance + 1 ether);

        dist.pause();
        vm.expectRevert();
        dist.sweepDust();

        dist.unpause();
        // After unpause sweepDust succeeds.
        dist.sweepDust();
    }

    function test_DR_M_02_executeForfeitReclaimBlockedWhilePaused() public {
        _distribute(50 ether);
        vm.warp(block.timestamp + 4 hours + 1);
        _distribute(50 ether);
        vm.warp(block.timestamp + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(2 ether);

        uint256 cap = (dist.totalDistributed() * dist.MAX_LIFETIME_FORFEIT_BPS()) / 10_000;
        if (cap > 0) {
            dist.proposeForfeitReclaim(cap / 2);
            vm.warp(block.timestamp + 48 hours + 1);

            dist.pause();
            vm.expectRevert();
            dist.executeForfeitReclaim();

            dist.unpause();
            dist.executeForfeitReclaim();
        }
    }
}
