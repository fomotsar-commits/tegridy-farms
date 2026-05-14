// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";

contract MockTOWELI_REVM01 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBAC_REVM01 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @dev Mock voting escrow for AUDIT REV-M-01 (2026-04-28). Implements the new
///      `totalBoostedStakeAtTimestamp` view alongside the legacy IVotingEscrow
///      surface so we can simulate same-block dilution and verify _distribute
///      pins the denominator at (block.timestamp - 1).
contract MockVE_REVM01 {
    mapping(address => uint256) public power;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public total; // live spot value

    // Historical totalBoostedStake checkpoints — single trace, no per-user split needed.
    struct Checkpoint { uint256 ts; uint256 value; }
    Checkpoint[] private _totalCheckpoints;

    uint256 private _next = 1;

    function _writeTotalCheckpoint() private {
        // Mirror OZ Checkpoints.Trace208 push-on-change semantics: skip if unchanged.
        if (_totalCheckpoints.length > 0 &&
            _totalCheckpoints[_totalCheckpoints.length - 1].ts == block.timestamp) {
            // Same-timestamp overwrite (Trace208 collapses same-key writes).
            _totalCheckpoints[_totalCheckpoints.length - 1].value = total;
            return;
        }
        _totalCheckpoints.push(Checkpoint({ts: block.timestamp, value: total}));
    }

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
        _writeTotalCheckpoint();
    }

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return power[user]; }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function paused() external pure returns (bool) { return false; }

    /// @notice AUDIT REV-M-01: historical totalBoostedStake at `ts`. upperLookup
    ///         semantics — most recent checkpoint with key <= ts. Returns 0 when
    ///         no checkpoint at or before ts.
    function totalBoostedStakeAtTimestamp(uint256 ts) external view returns (uint256) {
        uint256 n = _totalCheckpoints.length;
        if (n == 0) return 0;
        // Linear scan is fine for a mock — production uses OZ binary search.
        uint256 best;
        bool found;
        for (uint256 i = 0; i < n; i++) {
            if (_totalCheckpoints[i].ts <= ts) {
                best = _totalCheckpoints[i].value;
                found = true;
            } else {
                break;
            }
        }
        return found ? best : 0;
    }

    function totalBoostedStakeNumCheckpoints() external view returns (uint256) {
        return _totalCheckpoints.length;
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    ) {
        address u = tokenOwner[tokenId];
        return (power[u], power[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

/// @dev Mock that does NOT implement totalBoostedStakeAtTimestamp — exercises the
///      try/catch fallback in _distribute. Identical to the AUDIT R014 mock.
contract MockVE_REVM01_Legacy {
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

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return power[user]; }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function paused() external pure returns (bool) { return false; }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    ) {
        address u = tokenOwner[tokenId];
        return (power[u], power[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockWETH_REVM01 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

/// @dev AUDIT FIX 2026-05-13 — H-REV-3 — minimal restaking mock for the new
///      immutable `_restaking` constructor arg. Returns zero/empty for every
///      view so the staking-priority path remains the active source in these
///      tests (no test in this file exercises the restaker fallback).
contract MockRestaking_REVM01 {
    function restakers(address) external pure returns (
        uint256, uint256, uint256, int256, uint256
    ) { return (0, 0, 0, int256(0), 0); }
    function boostedAmountAt(address, uint256) external pure returns (uint256) { return 0; }
}

/// @title AUDIT REV-M-01 — RevenueDistributor _distribute denominator pinning
/// @notice Verifies that _distribute reads the historical totalBoostedStake from
///         the staking contract's Trace208 checkpoint at `block.timestamp - 1`,
///         excluding any same-block stake that landed before the distribute() call.
contract R027_RevenueDistributor_TotalStakeCheckpoint is Test {
    MockVE_REVM01 public ve;
    MockVE_REVM01_Legacy public veLegacy;
    MockWETH_REVM01 public weth;
    MockRestaking_REVM01 public restaking;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");
    address public attacker = makeAddr("attacker");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVE_REVM01();
        weth = new MockWETH_REVM01();
        restaking = new MockRestaking_REVM01();
        dist = new RevenueDistributor(address(ve), treasury, address(weth), address(restaking));

        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob,   100_000 ether, block.timestamp + 365 days);

        // Move to a fresh block so the alice/bob stakes are at T-1 relative to the
        // first distribute() call.
        vm.warp(block.timestamp + 1 hours);
    }

    function _distribute(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok);
        dist.distribute();
    }

    /// @notice Same-block dilution attempt: a flash-staker bumps `totalBoostedStake`
    ///         to 2x just before distribute() lands. With REV-M-01, the epoch
    ///         denominator is pinned at the T-1 historical checkpoint (which only
    ///         saw alice + bob), so the attacker's same-block stake is EXCLUDED
    ///         and legitimate claimers get their full pre-flash share.
    function test_REVM01_sameBlockDilutionExcluded() public {
        // alice + bob each have 100_000. Total at T-1 = 200_000.
        // Now in the SAME block, attacker joins with 200_000 (same-block stake).
        ve.setLock(attacker, 200_000 ether, block.timestamp + 365 days);
        // Live total = 400_000, but T-1 checkpoint is still 200_000 (alice+bob).

        // Confirm the historical view returns the pre-attacker total at (block.timestamp - 1).
        uint256 histAtTm1 = ve.totalBoostedStakeAtTimestamp(block.timestamp - 1);
        assertEq(histAtTm1, 200_000 ether, "T-1 sees only pre-attacker total");
        assertEq(ve.totalBoostedStake(), 400_000 ether, "live spot is post-attacker");

        // Distribute 10 ETH.
        _distribute(10 ether);

        // The epoch denominator should be 200_000 (pre-attacker), so alice's
        // share is 100_000/200_000 * 10 = 5 ETH (NOT 100_000/400_000 * 10 = 2.5 ETH
        // which would be the pre-fix dilution outcome).
        (uint256 ethAmt, uint256 totalLocked, ) = dist.getEpoch(0);
        assertEq(ethAmt, 10 ether);
        assertEq(totalLocked, 200_000 ether, "denominator pinned at T-1, attacker excluded");

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance - aliceBefore, 5 ether, "alice gets full pre-flash share");
    }

    /// @notice The historical-checkpoint read also excludes a same-block UNSTAKE.
    ///         If a holder yanks their stake just before distribute(), the
    ///         denominator stays at the pre-yank value — protecting the holder
    ///         from being told their share doesn't exist anymore.
    function test_REVM01_sameBlockUnstakeExcluded() public {
        // T-1 sees alice + bob at 200_000. Now in SAME block bob unstakes.
        ve.setLock(bob, 0, block.timestamp + 365 days);
        // Live total = 100_000, T-1 checkpoint = 200_000.

        _distribute(10 ether);
        (, uint256 totalLocked, ) = dist.getEpoch(0);
        // Denominator pinned at T-1: 200_000.
        assertEq(totalLocked, 200_000 ether, "denominator excludes same-block unstake");
    }

    /// @notice Legacy fallback: if the staking contract doesn't implement the new
    ///         totalBoostedStakeAtTimestamp view, _distribute falls back to the
    ///         live `totalBoostedStake()` value via try/catch. Exercises the
    ///         graceful-degradation path against pre-upgrade staking ABIs.
    function test_REVM01_fallsBackToLiveSpotWhenViewMissing() public {
        // Re-deploy the distributor against the legacy mock (no historical view).
        veLegacy = new MockVE_REVM01_Legacy();
        veLegacy.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        veLegacy.setLock(bob,   100_000 ether, block.timestamp + 365 days);
        RevenueDistributor d = new RevenueDistributor(address(veLegacy), treasury, address(weth), address(restaking));

        vm.warp(block.timestamp + 1 hours);
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(d).call{value: 10 ether}("");
        assertTrue(ok);
        d.distribute();

        // Distribution succeeded — legacy ABI doesn't brick distribute().
        (, uint256 totalLocked, ) = d.getEpoch(0);
        // Fallback uses live spot value, which on the legacy mock equals the sum
        // of alice + bob (200_000) since no same-block stake happened in this test.
        assertEq(totalLocked, 200_000 ether, "fallback to live spot when view missing");
    }
}

/// @title AUDIT REV-M-01 — TegridyStaking-side total checkpoint tests
/// @notice Exercises the new `totalBoostedStakeAtTimestamp` and the checkpoint
///         writes around stake/unstake/extendLock on the REAL staking contract.
contract R027_TegridyStaking_TotalStakeCheckpoint is Test {
    TegridyStaking public staking;
    TegridyStakingAdmin public admin;
    MockTOWELI_REVM01 public token;
    MockJBAC_REVM01 public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");

    function setUp() public {
        token = new MockTOWELI_REVM01();
        jbac = new MockJBAC_REVM01();
        staking = new TegridyStaking(address(token), address(jbac), treasury, 1 ether);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        token.transfer(alice, 1_000_000 ether);
        token.transfer(bob,   1_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
    }

    /// @notice Stake writes a checkpoint at block.timestamp. A read at
    ///         block.timestamp - 1 returns 0 (excludes the same-block stake).
    function test_REVM01_stakeWritesCheckpoint_excludesSameBlock() public {
        uint256 stakeTs = 1000;
        vm.warp(stakeTs);

        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);

        // Read AT stakeTs sees the stake.
        uint256 spot = staking.totalBoostedStake();
        uint256 atTs = staking.totalBoostedStakeAtTimestamp(stakeTs);
        assertEq(atTs, spot, "AT stakeTs sees the stake");
        assertGt(spot, 0);

        // Read AT (stakeTs - 1) is 0 — same-block stakes excluded.
        uint256 beforeStake = staking.totalBoostedStakeAtTimestamp(stakeTs - 1);
        assertEq(beforeStake, 0, "T-1 EXCLUDES same-block stake");
    }

    /// @notice Multiple sequential stakes produce monotonic checkpoint reads.
    function test_REVM01_sequentialStakesAccumulate() public {
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);
        uint256 boostedAfterBob = staking.totalBoostedStake();

        vm.warp(2000);
        vm.prank(alice);
        staking.stake(300_000 ether, 365 days);
        uint256 boostedAfterAlice = staking.totalBoostedStake();

        // Historical reads.
        assertEq(staking.totalBoostedStakeAtTimestamp(999),  0,                  "before any stake");
        assertEq(staking.totalBoostedStakeAtTimestamp(1000), boostedAfterBob,    "after bob's stake");
        assertEq(staking.totalBoostedStakeAtTimestamp(1500), boostedAfterBob,    "between stakes");
        assertEq(staking.totalBoostedStakeAtTimestamp(2000), boostedAfterAlice,  "after alice's stake");
        assertGt(boostedAfterAlice, boostedAfterBob);
    }

    /// @notice Withdraw decrements the historical checkpoint at withdraw time.
    ///         A read AT withdraw time reflects the post-withdraw total.
    function test_REVM01_withdrawWritesCheckpoint() public {
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(500_000 ether, 7 days);
        uint256 afterStake = staking.totalBoostedStake();
        assertGt(afterStake, 0);

        // Wait for lock to expire.
        uint256 withdrawTs = 1000 + 7 days + 1;
        vm.warp(withdrawTs);
        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.withdraw(tokenId);

        // After withdraw, totalBoostedStake collapses to 0.
        assertEq(staking.totalBoostedStake(), 0);

        // Historical reads.
        assertEq(staking.totalBoostedStakeAtTimestamp(999),         0,           "before stake");
        assertEq(staking.totalBoostedStakeAtTimestamp(1000),        afterStake,  "at stake");
        assertEq(staking.totalBoostedStakeAtTimestamp(withdrawTs - 1), afterStake, "T-1 of withdraw still sees stake");
        assertEq(staking.totalBoostedStakeAtTimestamp(withdrawTs),  0,           "at withdraw collapses");
    }

    /// @notice extendLock rewrites totalBoostedStake (boost increases). The
    ///         checkpoint records the new (post-extend) value.
    function test_REVM01_extendLockWritesCheckpoint() public {
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);
        uint256 boostShort = staking.totalBoostedStake();

        // Extend to 4 years (max boost) at t=2000.
        vm.warp(2000);
        uint256 tokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.extendLock(tokenId, 4 * 365 days);
        uint256 boostLong = staking.totalBoostedStake();
        assertGt(boostLong, boostShort, "max-lock yields higher boost");

        // T-1 of extend still sees the old (short) boost.
        assertEq(staking.totalBoostedStakeAtTimestamp(1999), boostShort, "T-1 sees pre-extend");
        // AT extend sees the new (long) boost.
        assertEq(staking.totalBoostedStakeAtTimestamp(2000), boostLong,  "AT extend sees post-extend");
    }
}
