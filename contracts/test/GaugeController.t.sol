// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/GaugeController.sol";

contract MockTOWELIGauge is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBACGauge is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
    function burnFrom(address owner, uint256 tokenId) external { require(ownerOf(tokenId) == owner); _burn(tokenId); }
}

/// @title GaugeController Test Suite
/// @notice Tests for Curve-style emission voting controller
contract GaugeControllerTest is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    MockTOWELIGauge public toweli;
    MockJBACGauge public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    /// @dev AUDIT FIX FRESH-2026: GC-QUORUM-BAKE-IN [HIGH] — third staker added
    ///      so any test exercising `getRelativeWeight` / `getGaugeEmission`
    ///      reaches `MIN_VOTING_NFTS_PER_EPOCH = 3` and exits the
    ///      `quorumMet == false` fail-closed branch.
    address public carol = makeAddr("carol");

    address public gauge1 = makeAddr("gauge1");
    address public gauge2 = makeAddr("gauge2");
    address public gauge3 = makeAddr("gauge3");

    function setUp() public {
        toweli = new MockTOWELIGauge();
        jbac = new MockJBACGauge();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        toweli.transfer(alice, 500_000 ether);
        toweli.transfer(bob, 500_000 ether);
        toweli.transfer(carol, 500_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();

        vm.startPrank(bob);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();

        // AUDIT FIX FRESH-2026: GC-QUORUM-BAKE-IN [HIGH] — third staker
        vm.startPrank(carol);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();

        _addGauge(gauge1);
        _addGauge(gauge2);
        _addGauge(gauge3);

        // AUDIT TF-04: GaugeController.vote() reads voting power at the current epoch's
        // start timestamp, not live. Stakes written during epoch 0 have checkpoints at
        // T=1 (or whenever they were made), so they're visible at epoch 1's start but
        // not at epoch 0's start (which == genesisEpoch == 0). Advancing one epoch
        // past setUp lets the staker checkpoints be in-range for epochStartTime(1).
        vm.warp(block.timestamp + 7 days);
    }

    /// @dev Helper: propose + warp + execute gauge addition
    /// AUDIT FIX G-02: proposeAddGauge now requires gauge.code.length > 0.
    /// AUDIT FIX (pass-8) GOV-INT-01: proposeAddGauge now also requires a `pair`
    /// arg with non-zero code. Helper derives a deterministic pair address from
    /// the gauge (XOR 1) so each test gauge gets a unique paired pair, and
    /// etches minimal bytecode at both addresses.
    function _addGauge(address g) internal {
        address pair = address(uint160(g) ^ uint160(1));
        _addGauge(g, pair);
    }
    function _addGauge(address g, address pair) internal {
        if (g.code.length == 0) vm.etch(g, hex"60006000fd");
        if (pair.code.length == 0) vm.etch(pair, hex"60006000fd");
        gauge.proposeAddGauge(g, pair);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeAddGauge();
    }

    // ── Gauge Management ────────────────────────────────────────────

    function test_addGauge() public {
        address newGauge = makeAddr("newGauge");
        _addGauge(newGauge);
        assertTrue(gauge.isGauge(newGauge));
    }

    function test_addGauge_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        gauge.proposeAddGauge(makeAddr("rogue"), makeAddr("rogue_pair"));
    }

    // ── Voting ──────────────────────────────────────────────────────

    function test_vote_basic() public {
        // BATCH-J4 C4: per-vote per-gauge cap is 50% (MAX_WEIGHT_PER_GAUGE_BPS=5000),
        // so the test must split across at least 2 gauges to satisfy WeightsMustSumToBPS.
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](2);
        uint256[] memory w = new uint256[](2);
        g[0] = gauge1; w[0] = 5000;
        g[1] = gauge2; w[1] = 5000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        assertGt(gauge.getGaugeWeight(gauge1), 0);
    }

    function test_vote_multipleGauges() public {
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](3);
        uint256[] memory w = new uint256[](3);
        g[0] = gauge1; w[0] = 5000;
        g[1] = gauge2; w[1] = 3000;
        g[2] = gauge3; w[2] = 2000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        assertGt(gauge.getGaugeWeight(gauge1), 0);
        assertGt(gauge.getGaugeWeight(gauge2), 0);
        assertGt(gauge.getGaugeWeight(gauge3), 0);
    }

    function test_vote_weightsMustSum10000() public {
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 5000;
        vm.prank(alice);
        vm.expectRevert(GaugeController.WeightsMustSumToBPS.selector);
        gauge.vote(tokenId, g, w);
    }

    function test_vote_maxGaugesPerVoter() public {
        for (uint256 i; i < 6; ++i) _addGauge(address(uint160(100 + i)));
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](9);
        uint256[] memory w = new uint256[](9);
        g[0] = gauge1; g[1] = gauge2; g[2] = gauge3;
        for (uint256 i; i < 6; ++i) g[3 + i] = address(uint160(100 + i));
        for (uint256 i; i < 9; ++i) w[i] = 1111;
        w[8] = 1112;
        vm.prank(alice);
        vm.expectRevert(GaugeController.TooManyGauges.selector);
        gauge.vote(tokenId, g, w);
    }

    function test_vote_doubleVoteSameEpochReverts() public {
        // BATCH-J4 C4: split across 2 gauges to satisfy 5000 BPS per-gauge cap.
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](2);
        uint256[] memory w = new uint256[](2);
        g[0] = gauge1; w[0] = 5000;
        g[1] = gauge2; w[1] = 5000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        vm.prank(alice);
        vm.expectRevert(GaugeController.AlreadyVotedThisEpoch.selector);
        gauge.vote(tokenId, g, w);
    }

    function test_vote_newEpochAllowsRevote() public {
        // BATCH-J4 C4: split across 2 gauges to satisfy 5000 BPS per-gauge cap.
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](2);
        uint256[] memory w = new uint256[](2);
        g[0] = gauge1; w[0] = 5000;
        g[1] = gauge2; w[1] = 5000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
    }

    // ── Weight Queries ──────────────────────────────────────────────

    function test_getRelativeWeight() public {
        // BATCH-J4 C4: split across 2 gauges per voter to satisfy 5000 BPS cap.
        // AUDIT FIX FRESH-2026: GC-QUORUM-BAKE-IN — needs 3 voters for
        // `quorumMet` to be true (MIN_VOTING_NFTS_PER_EPOCH = 3). Alice + Bob +
        // Carol each split 50/50 across the same two-gauge pattern:
        //   Alice → 50% gauge1 + 50% gauge3
        //   Bob   → 50% gauge2 + 50% gauge3
        //   Carol → 50% gauge1 + 50% gauge2 (kept symmetric so totals balance)
        // Aggregate share-of-total computed below.
        uint256 aliceId = staking.userTokenId(alice);
        uint256 bobId = staking.userTokenId(bob);
        uint256 carolId = staking.userTokenId(carol);
        address[] memory g = new address[](2);
        uint256[] memory w = new uint256[](2);
        w[0] = 5000; w[1] = 5000;
        g[0] = gauge1; g[1] = gauge3;
        vm.prank(alice);
        gauge.vote(aliceId, g, w);
        g[0] = gauge2; g[1] = gauge3;
        vm.prank(bob);
        gauge.vote(bobId, g, w);
        g[0] = gauge1; g[1] = gauge2;
        vm.prank(carol);
        gauge.vote(carolId, g, w);
        // Equal stake, equal split. Per-gauge raw weights:
        //   gauge1 = alice/2 + carol/2 = 1.0 unit
        //   gauge2 = bob/2   + carol/2 = 1.0 unit
        //   gauge3 = alice/2 + bob/2   = 1.0 unit
        // Total = 3.0 units. Relative = 1/3 each ≈ 3333 BPS.
        assertApproxEqAbs(gauge.getRelativeWeight(gauge1), 3333, 10);
        assertApproxEqAbs(gauge.getRelativeWeight(gauge2), 3333, 10);
        assertApproxEqAbs(gauge.getRelativeWeight(gauge3), 3333, 10);
    }

    // ── Gauge Removal ──────────────────────────────────────────────

    function test_removeGauge() public {
        gauge.proposeRemoveGauge(gauge3);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeRemoveGauge();
        assertFalse(gauge.isGauge(gauge3));
    }

    // ── Epoch ───────────────────────────────────────────────────────

    function test_epoch_advancesCorrectly() public {
        uint256 epoch0 = gauge.currentEpoch();
        vm.warp(block.timestamp + 7 days);
        assertEq(gauge.currentEpoch(), epoch0 + 1);
    }

    // ── Voting Power Source ──────────────────────────────────────────

    function test_votingPower_fromStaking() public {
        // BATCH-J4 C4: per-vote per-gauge cap is 5000 BPS — split across 2 gauges.
        // Alice's full power is split 50/50 so gauge1 gets exactly half of expectedPower.
        uint256 tokenId = staking.userTokenId(alice);
        (uint256 amount,,,, uint16 boostBps,,,,,,) = staking.positions(tokenId);
        uint256 expectedPower = (amount * uint256(boostBps)) / 10000;
        address[] memory g = new address[](2);
        uint256[] memory w = new uint256[](2);
        g[0] = gauge1; w[0] = 5000;
        g[1] = gauge2; w[1] = 5000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        assertEq(gauge.getGaugeWeight(gauge1), expectedPower / 2);
        assertEq(gauge.getGaugeWeight(gauge2), expectedPower / 2);
    }
}
