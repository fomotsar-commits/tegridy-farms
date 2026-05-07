// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import {RevenueDistributor} from "../src/RevenueDistributor.sol";

// ─── Mocks ────────────────────────────────────────────────────────────────

contract MockGoodWETH9R026 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v);
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    function withdraw(uint256 v) external {
        require(balanceOf[msg.sender] >= v);
        balanceOf[msg.sender] -= v;
        (bool ok,) = msg.sender.call{value: v}("");
        require(ok);
    }
    receive() external payable {}
}

contract MockStakingR026 {
    uint256 public totalBoostedStake;
    uint256 public totalLocked;
    bool public paused;
    mapping(address => uint256) private _power;
    mapping(address => uint256) private _historyPower;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => uint256) public posAmount;
    mapping(uint256 => uint256) public posLockEnd;

    function setTotalBoostedStake(uint256 v) external { totalBoostedStake = v; }
    function setTotalLocked(uint256 v) external { totalLocked = v; }
    function setPower(address u, uint256 v) external { _power[u] = v; }
    function setHistoryPower(address u, uint256 v) external { _historyPower[u] = v; }
    function setPosition(address u, uint256 tokenId, uint256 amount, uint256 lockEnd) external {
        userTokenId[u] = tokenId;
        posAmount[tokenId] = amount;
        posLockEnd[tokenId] = lockEnd;
    }
    function setPaused(bool p) external { paused = p; }

    function votingPowerOf(address u) external view returns (uint256) { return _power[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) {
        return _historyPower[u];
    }

    function positions(uint256 tokenId) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        return (posAmount[tokenId], posAmount[tokenId], int256(0), posLockEnd[tokenId],
                0, 0, false, false, 0, 0, false);
    }
}

contract MockRestakingR026 {
    struct R { uint256 tokenId; uint256 positionAmount; uint256 boostedAmount; int256 bonusDebt; uint256 depositTime; }
    mapping(address => R) private _r;
    mapping(address => uint256) private _historyBoosted;

    function setRestaker(address u, uint256 tokenId, uint256 positionAmount, uint256 boostedAmount) external {
        _r[u] = R(tokenId, positionAmount, boostedAmount, int256(0), block.timestamp);
    }
    function setHistoryBoostedAt(address u, uint256 v) external { _historyBoosted[u] = v; }

    function restakers(address u) external view returns (
        uint256, uint256, uint256, int256, uint256
    ) {
        R memory r = _r[u];
        return (r.tokenId, r.positionAmount, r.boostedAmount, r.bonusDebt, r.depositTime);
    }

    function boostedAmountAt(address u, uint256) external view returns (uint256) {
        return _historyBoosted[u];
    }
}

// ─── Test Body ────────────────────────────────────────────────────────────

/// @title R026 — RevenueDistributor reconciliation against current contract.
/// @notice DRIFT (RC10): the R026 design (single-snapshot `totalLockedAtEpoch`,
///         `AmbiguousPower` revert, `STALE_RECLAIM_WINDOW` + `ForfeitTooFresh`)
///         was deferred. The current contract still uses the min-of-two
///         denominator pattern, the staking/restaker fallback (no ambiguity
///         revert), and the basic 48h propose timelock with no freshness floor.
///         The tests below pin the CURRENT behavior so future drift is caught.
contract R026_RevenueDistributor is Test {
    MockGoodWETH9R026 internal weth;
    MockStakingR026 internal staking;
    MockRestakingR026 internal restaking;
    RevenueDistributor internal rd;

    address internal owner = address(this);
    address internal treasury = address(0xBEEF);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        weth = new MockGoodWETH9R026();
        staking = new MockStakingR026();
        restaking = new MockRestakingR026();
        rd = new RevenueDistributor(address(staking), treasury, address(weth));

        rd.proposeRestakingChange(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        rd.executeRestakingChange();

        // Move past MIN_DISTRIBUTE_INTERVAL and a healthy stake floor.
        vm.warp(block.timestamp + 5 hours);
        staking.setTotalBoostedStake(10_000e18);
        staking.setTotalLocked(10_000e18);
    }

    // ─── Happy-path: staking-only and restaker-only claims work ─────────────
    //
    // The R026 H-1 design (revert on dual non-zero power) was deferred. The
    // current contract uses the silent staking-priority fallback, so users
    // with a single source still receive correct amounts.
    function test_dualSource_StakingOnly_OK_RestakingOnly_OK() public {
        staking.setTotalBoostedStake(3_000e18);

        staking.setHistoryPower(alice, 1_000e18);
        staking.setPower(alice, 1_000e18);

        restaking.setHistoryBoostedAt(bob, 2_000e18);
        restaking.setRestaker(bob, 7, 2_000e18, 2_000e18);

        // Provide newETH > MIN_DISTRIBUTE_AMOUNT (1 ether).
        vm.deal(address(rd), 3 ether);
        rd.distribute();

        vm.prank(alice); rd.claim();
        vm.prank(bob);   rd.claim();

        // Alice 1/3, Bob 2/3 of 3 ETH.
        assertEq(alice.balance, 1 ether, "alice 1/3");
        assertEq(bob.balance, 2 ether, "bob 2/3");
    }

    // ─── 10-ether-per-call cap on forfeit reclaim survives ──────────────────
    function test_forfeitReclaim_PerCallCapEnforced() public {
        vm.expectRevert(bytes("INVALID_AMOUNT"));
        rd.proposeForfeitReclaim(10 ether + 1);
    }

    // ─── Forfeit reclaim is per-epoch-grace-gated (REV-H-01 lands the symptomatic
    //     fix R026 M-6 was meant to address). Proposing against a fresh epoch now
    //     reverts ForfeitExceedsEligibleDust(); only after DUST_RECLAIM_GRACE
    //     elapses does the epoch's unclaimed amount become reclaim-eligible.
    function test_forfeitReclaim_PerEpochGraceGate() public {
        staking.setTotalBoostedStake(1_000e18);
        staking.setHistoryPower(alice, 1_000e18);
        staking.setPower(alice, 1_000e18);

        vm.deal(address(rd), 5 ether);
        rd.distribute();

        // Fresh epoch — eligible dust pool is 0, propose must revert.
        vm.expectRevert(RevenueDistributor.ForfeitExceedsEligibleDust.selector);
        rd.proposeForfeitReclaim(1 ether);

        // After the per-epoch grace window elapses, the epoch's unclaimed pool
        // becomes eligible — but the lifetime cap (1% of totalDistributed = 0.05 ETH
        // here) bites. This is the belt-and-braces guard.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        vm.warp(block.timestamp + rd.DUST_RECLAIM_GRACE() + 1);
        vm.expectRevert(RevenueDistributor.ForfeitExceedsLifetimeCap.selector);
        rd.proposeForfeitReclaim(1 ether);

        // Within the lifetime cap (0.05 ETH = 1% * 5 ETH distributed), it succeeds.
        rd.proposeForfeitReclaim(0.05 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 earmarkedBefore = rd.totalEarmarked();
        rd.executeForfeitReclaim();
        assertEq(rd.totalEarmarked(), earmarkedBefore - 0.05 ether, "earmarked drops by 0.05 ETH");
        assertEq(rd.totalForfeited(), 0.05 ether, "forfeited bumps by 0.05 ETH");
        assertEq(rd.totalForfeitedReclaimed(), 0.05 ether, "lifetime reclaim counter bumps");
    }

    // ─── REV-H-01 — owner cannot slow-drain still-claimable ETH ────────────
    //
    // ATTACK MODEL: Without the per-epoch grace gate, owner could call
    // proposeForfeitReclaim(10 ether) immediately after a fresh distribution
    // and execute 48h later, permanently moving 10 ETH of still-claimable user
    // funds out of the contract per cycle (~1825 ETH/year theoretical drain).
    // Late claimers' inner .call would then return false (insufficient balance),
    // pushing their share to pendingWithdrawals where withdrawPending also
    // reverts — funds permanently inaccessible.
    function test_REV_H_01_proposeForfeitReclaim_revertsOnFreshEpoch() public {
        staking.setTotalBoostedStake(10_000e18);
        staking.setHistoryPower(alice, 10_000e18);
        staking.setPower(alice, 10_000e18);

        // Distribute 10 ETH at t=now. The full 10 ETH is "earmarked" but NOT
        // yet eligible for forfeit-reclaim because the per-epoch grace window
        // has not elapsed.
        vm.deal(address(rd), 10 ether);
        rd.distribute();

        // The pre-fix contract would have allowed this (gap = 10 ETH >= 10 ETH).
        // Post-fix, eligible dust = 0 (epoch is fresh) — must revert.
        vm.expectRevert(RevenueDistributor.ForfeitExceedsEligibleDust.selector);
        rd.proposeForfeitReclaim(10 ether);

        // Even a tiny request reverts — the entire epoch is in grace.
        vm.expectRevert(RevenueDistributor.ForfeitExceedsEligibleDust.selector);
        rd.proposeForfeitReclaim(0.001 ether);

        // Once we cross the DUST_RECLAIM_GRACE boundary, eligibility opens up,
        // but the 1% lifetime cap (0.1 ETH on 10 ETH distributed) keeps the
        // owner bounded.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        // BATCH-L1 M32: an extra 30-day "extendedCutoff" half-discounts dust
        // until the epoch is fully past primary grace + 30d. Warp +44d so the
        // epoch fully exits both windows and 10 ether becomes fully eligible.
        vm.warp(block.timestamp + rd.DUST_RECLAIM_GRACE() + 30 days + 1);
        vm.expectRevert(RevenueDistributor.ForfeitExceedsLifetimeCap.selector);
        rd.proposeForfeitReclaim(10 ether);

        // 0.1 ETH (= 1% lifetime cap) is allowed and execution succeeds.
        rd.proposeForfeitReclaim(0.1 ether);
        vm.warp(block.timestamp + 48 hours + 1);
        rd.executeForfeitReclaim();
        assertEq(rd.totalForfeitedReclaimed(), 0.1 ether, "lifetime reclaim recorded");

        // A second proposal in the same epoch is now blocked by the lifetime cap.
        vm.expectRevert(RevenueDistributor.ForfeitExceedsLifetimeCap.selector);
        rd.proposeForfeitReclaim(0.001 ether);
    }

    // ─── REV-H-01 — eligible-dust math sums multiple epochs correctly ──────
    /// @dev BATCH-L1 M32: dust is half-discounted in the [extendedCutoff, cutoff)
    ///      window. To verify FULL eligibility, epochs must be past `cutoff + 30 days`.
    function test_REV_H_01_reclaimEligibleAmount_sumsExpiredEpochsOnly() public {
        staking.setTotalBoostedStake(10_000e18);
        uint256 t0 = block.timestamp;

        // Epoch 0 at t=t0, then warp DUST_RECLAIM_GRACE + 30d + 1, distribute epoch 1.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        vm.deal(address(rd), 100 ether);
        rd.distribute(); // epoch 0: 100 ETH

        uint256 grace = rd.DUST_RECLAIM_GRACE();
        // Warp far enough that epoch 0 exits both grace + extendedCutoff.
        vm.warp(t0 + grace + 30 days + 1);

        vm.deal(address(rd), address(rd).balance + 50 ether);
        rd.distribute(); // epoch 1: 50 ETH (fresh)
        assertEq(rd.epochCount(), 2, "two epochs");

        // Eligible amount: only epoch 0 is past full grace → 100 ETH eligible.
        assertEq(rd.reclaimEligibleAmount(), 100 ether, "only expired epoch counts");

        // Wait for epoch 1 to also fully expire — eligible should jump to 150 ETH.
        vm.warp(t0 + 2 * (grace + 30 days) + 1);
        assertEq(rd.reclaimEligibleAmount(), 150 ether, "both epochs eligible after grace");
    }

    // ─── pendingETH for a single-source user matches claim payout ──────────
    function test_pendingETH_StakingOnly_MatchesClaim() public {
        staking.setTotalBoostedStake(2_000e18);
        staking.setHistoryPower(alice, 2_000e18);
        staking.setPower(alice, 2_000e18);

        vm.deal(address(rd), 2 ether);
        rd.distribute();

        uint256 pending = rd.pendingETH(alice);
        assertEq(pending, 2 ether, "alice owns 100% of epoch");

        vm.prank(alice);
        rd.claim();
        assertEq(alice.balance, 2 ether, "actual payout matches view");
    }
}
