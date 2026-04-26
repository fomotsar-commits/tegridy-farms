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

    // ─── Forfeit reclaim DOES execute at +48h on the current contract ──────
    //
    // R026 M-6 (STALE_RECLAIM_WINDOW=56d freshness floor) was deferred. We
    // pin the current behavior — owner can reclaim 1 ETH from `totalEarmarked`
    // 48h after a fresh distribution, which is the symptom R026 was meant to
    // fix. This test will fail (and require update) when R026 lands.
    function test_forfeitReclaim_AllowedImmediatelyAfterTimelock_DRIFT() public {
        staking.setTotalBoostedStake(1_000e18);
        staking.setHistoryPower(alice, 1_000e18);
        staking.setPower(alice, 1_000e18);

        vm.deal(address(rd), 5 ether);
        rd.distribute();

        rd.proposeForfeitReclaim(1 ether);
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 earmarkedBefore = rd.totalEarmarked();
        rd.executeForfeitReclaim();
        assertEq(rd.totalEarmarked(), earmarkedBefore - 1 ether, "earmarked drops by 1 ether");
        assertEq(rd.totalForfeited(), 1 ether, "forfeited bumps by 1 ether");
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
