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

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();

        vm.startPrank(bob);
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
    function _addGauge(address g) internal {
        gauge.proposeAddGauge(g);
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
        gauge.proposeAddGauge(makeAddr("rogue"));
    }

    // ── Voting ──────────────────────────────────────────────────────

    function test_vote_basic() public {
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 10000;
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
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 10000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        vm.prank(alice);
        vm.expectRevert(GaugeController.AlreadyVotedThisEpoch.selector);
        gauge.vote(tokenId, g, w);
    }

    function test_vote_newEpochAllowsRevote() public {
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 10000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
    }

    // ── Weight Queries ──────────────────────────────────────────────

    function test_getRelativeWeight() public {
        uint256 aliceId = staking.userTokenId(alice);
        uint256 bobId = staking.userTokenId(bob);
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 10000;
        vm.prank(alice);
        gauge.vote(aliceId, g, w);
        g[0] = gauge2;
        vm.prank(bob);
        gauge.vote(bobId, g, w);
        // Equal stakers => ~50% each
        assertApproxEqAbs(gauge.getRelativeWeight(gauge1), 5000, 10);
        assertApproxEqAbs(gauge.getRelativeWeight(gauge2), 5000, 10);
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
        uint256 tokenId = staking.userTokenId(alice);
        (uint256 amount,,,, uint16 boostBps,,,,) = staking.positions(tokenId);
        uint256 expectedPower = (amount * uint256(boostBps)) / 10000;
        address[] memory g = new address[](1);
        uint256[] memory w = new uint256[](1);
        g[0] = gauge1; w[0] = 10000;
        vm.prank(alice);
        gauge.vote(tokenId, g, w);
        assertEq(gauge.getGaugeWeight(gauge1), expectedPower);
    }
}
