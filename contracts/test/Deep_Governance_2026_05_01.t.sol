// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/VoteIncentives.sol";
import "../src/GaugeController.sol";
import "../src/CommunityGrants.sol";
import "../src/MemeBountyBoard.sol";
import "../src/TegridyStaking.sol";

/// @title Deep Audit 2026-05-01 — Governance cluster regression tests
/// @notice Three priority regressions for the DEEP-GOV findings:
///         - test_C3_minClampPreventsMultiNftDivestiture (DEEP-GOV-01)
///         - test_GaugeRelativeWeight_renormalizes (DEEP-GOV-03)
///         - test_executeRemoveGauge_revertsOnActiveEpochVotes (DEEP-GOV-14)

// ─── Mocks for VoteIncentives ──────────────────────────────────────

contract MockVE_DG {
    mapping(address => uint256) public _historical;
    mapping(address => uint256) public _current;
    uint256 public totalPower;
    bool public isPaused;

    function setHistorical(address user, uint256 v) external { _historical[user] = v; totalPower += v; }
    function setCurrent(address user, uint256 v) external { _current[user] = v; }

    function votingPowerOf(address user) external view returns (uint256) { return _current[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return _historical[user]; }
    function totalLocked() external view returns (uint256) { return totalPower; }
    function totalBoostedStake() external view returns (uint256) { return totalPower; }
    function userTokenId(address user) external pure returns (uint256) { return uint256(uint160(user)); }
    function holdsToken(address, uint256) external pure returns (bool) { return false; }
    function positions(uint256) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        return (100e18, 100e18, 0, block.timestamp + 365 days, 10000, 365 days, false, false, 1, 0, false);
    }
    function paused() external view returns (bool) { return isPaused; }
}

contract MockWETH_DG {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; (bool ok,) = msg.sender.call{value: amount}(""); require(ok); }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    receive() external payable {}
}

contract MockBribeToken_DG is ERC20 {
    constructor() ERC20("Bribe", "B") { _mint(msg.sender, 1_000_000e18); }
}

contract MockPair_DG {
    address public token0;
    address public token1;
    constructor(address _t0, address _t1) { token0 = _t0; token1 = _t1; }
}

contract MockFactory_DG {
    mapping(bytes32 => address) internal _pairs;
    mapping(address => bool) public disabledPairs;
    function registerPair(address t0, address t1, address pairAddr) external {
        _pairs[keccak256(abi.encodePacked(t0, t1))] = pairAddr;
        _pairs[keccak256(abi.encodePacked(t1, t0))] = pairAddr;
    }
    function getPair(address t0, address t1) external view returns (address) {
        return _pairs[keccak256(abi.encodePacked(t0, t1))];
    }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

// ─── DEEP-GOV-01 regression: min(historical, current) clamp ────────

contract DeepGov01_VoteIncentivesTest is Test {
    VoteIncentives public vi;
    MockVE_DG public ve;
    MockWETH_DG public weth;
    MockBribeToken_DG public bribeToken;
    MockFactory_DG public factory;

    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public treasury = address(0xBEEF);
    address public pair;

    function setUp() public {
        ve = new MockVE_DG();
        weth = new MockWETH_DG();
        bribeToken = new MockBribeToken_DG();
        factory = new MockFactory_DG();

        address t0 = address(0x1111);
        address t1 = address(0x2222);
        MockPair_DG mp = new MockPair_DG(t0, t1);
        pair = address(mp);
        factory.registerPair(t0, t1, pair);

        vi = new VoteIncentives(address(ve), treasury, address(weth), address(factory), address(bribeToken), 300);

        // alice held 100k power at snapshot.
        ve.setHistorical(alice, 100_000e18);
        // alice's CURRENT power is 1 wei (divested 99.999% post-snapshot).
        ve.setCurrent(alice, 1);

        // bob has full historical+current (legitimate baseline voter).
        ve.setHistorical(bob, 50_000e18);
        ve.setCurrent(bob, 50_000e18);

        vi.proposeWhitelistChange(address(bribeToken), true);
        vm.warp(block.timestamp + 24 hours + 1);
        vi.executeWhitelistChange();

        vm.warp(block.timestamp + 7 days);
        vi.advanceEpoch();
    }

    /// @notice DEEP-GOV-01: a voter whose CURRENT power < HISTORICAL must apply
    ///         only the smaller value, even if they kept a 1-wei sentinel position.
    function test_C3_minClampPreventsMultiNftDivestiture() public {
        // alice tries to vote 100k power (her historical). With the binary current
        // floor, this would have passed (current = 1 > 0). With the min clamp,
        // userPower clamps to min(100_000e18, 1) = 1, so vote(_, _, 100k) reverts
        // EXCEEDS_POWER.
        vm.prank(alice);
        vm.expectRevert(bytes("EXCEEDS_POWER"));
        vi.vote(0, pair, 100_000e18);

        // alice can still vote up to 1 wei (her current power).
        vm.prank(alice);
        vi.vote(0, pair, 1);
        assertEq(vi.userTotalVotes(alice, 0), 1, "alice can only apply current-clamped power");

        // bob is unaffected — he has full historical AND current.
        vm.prank(bob);
        vi.vote(0, pair, 50_000e18);
        assertEq(vi.userTotalVotes(bob, 0), 50_000e18, "bob unaffected by clamp");
    }
}

// ─── DEEP-GOV-03 / DEEP-GOV-14: GaugeController regression ─────────

contract MockTOWELI_DG is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBAC_DG is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
    function burnFrom(address owner, uint256 tokenId) external { require(ownerOf(tokenId) == owner); _burn(tokenId); }
}

contract DeepGov03_14_GaugeControllerTest is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    MockTOWELI_DG public toweli;
    MockJBAC_DG public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public g1 = makeAddr("g1");
    address public g2 = makeAddr("g2");
    address public g3 = makeAddr("g3");

    function setUp() public {
        toweli = new MockTOWELI_DG();
        jbac = new MockJBAC_DG();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        toweli.transfer(alice, 800_000 ether);
        toweli.transfer(bob, 200_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(800_000 ether, 365 days);
        vm.stopPrank();

        vm.startPrank(bob);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(200_000 ether, 365 days);
        vm.stopPrank();

        _addGauge(g1);
        _addGauge(g2);
        _addGauge(g3);

        vm.warp(block.timestamp + 7 days);
    }

    function _addGauge(address g) internal {
        gauge.proposeAddGauge(g);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeAddGauge();
    }

    /// @notice AUDIT FIX V3-GOV-03 + V3-GOV-06: the per-gauge cap +
    ///         renormalization formula was REMOVED entirely. Curve-style
    ///         natural distribution (`gw / total`) replaces it; the upstream
    ///         C2 + C3 + DEEP-GOV-01 guards now prevent the single-voter
    ///         attack the cap was originally designed for. This test verifies
    ///         the new pure-proportional semantic: weights sum to exactly BPS,
    ///         no cap, no leak.
    function test_GaugeRelativeWeight_renormalizes() public {
        // alice votes 80% to g1, 20% to g2.
        uint256 aliceTokenId = staking.userTokenId(alice);
        address[] memory g_a = new address[](2);
        uint256[] memory w_a = new uint256[](2);
        g_a[0] = g1; w_a[0] = 8000;
        g_a[1] = g2; w_a[1] = 2000;
        vm.prank(alice);
        gauge.vote(aliceTokenId, g_a, w_a);

        // bob votes 100% to g3.
        uint256 bobTokenId = staking.userTokenId(bob);
        address[] memory g_b = new address[](1);
        uint256[] memory w_b = new uint256[](1);
        g_b[0] = g3; w_b[0] = 10000;
        vm.prank(bob);
        gauge.vote(bobTokenId, g_b, w_b);

        uint256 g1w = gauge.getRelativeWeight(g1);
        uint256 g2w = gauge.getRelativeWeight(g2);
        uint256 g3w = gauge.getRelativeWeight(g3);

        // Pure proportional distribution — no cap, no leak.
        // Sum should equal BPS exactly (modulo 1-2 wei rounding).
        assertGt(g1w, g2w, "g1 should have largest share");
        assertGt(g1w, g3w, "g1 should outweigh g3");
        assertLe(g1w + g2w + g3w, 10000, "sum bounded by BPS");
        // Sum ≈ BPS (no leak) — no per-gauge cap removes the structural
        // emission shortfall of the old cap+renormalize formula.
        assertGe(g1w + g2w + g3w, 9990, "no significant emission leak");
    }

    /// @notice DEEP-GOV-14: executeRemoveGauge reverts mid-epoch when the gauge
    ///         already has votes cast for the current epoch.
    function test_executeRemoveGauge_revertsOnActiveEpochVotes() public {
        // alice votes some weight to g1.
        uint256 aliceTokenId = staking.userTokenId(alice);
        address[] memory g_a = new address[](1);
        uint256[] memory w_a = new uint256[](1);
        g_a[0] = g1; w_a[0] = 10000;
        vm.prank(alice);
        gauge.vote(aliceTokenId, g_a, w_a);

        // Owner proposes to remove g1.
        gauge.proposeRemoveGauge(g1);
        vm.warp(block.timestamp + 24 hours + 1);

        // Execute should revert because g1 has active-epoch votes.
        vm.expectRevert(GaugeController.GaugeHasActiveVotes.selector);
        gauge.executeRemoveGauge();

        // After advancing to next epoch, g1 has zero weight in that epoch.
        // (Note: voters' votes were in the OLD epoch, not the new one.)
        vm.warp(block.timestamp + 7 days);
        // Re-execute timelock now expired but proposal still pending — owner needs
        // to re-propose since proposal validity is 7 days.
        // Simpler: simply verify that the revert fires consistently while votes exist
        // in the current epoch — covered by the line above.
    }
}
