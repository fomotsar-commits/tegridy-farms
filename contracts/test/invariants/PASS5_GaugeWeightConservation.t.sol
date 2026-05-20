// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import "../../src/GaugeController.sol";

/// @title PASS5-INV-D — GaugeController weight conservation
/// @notice The user spec called out: "gauge weight sum == BPS in GaugeController
///         (the V3-GOV-03/06 rewrite area)".
///
///         Two related invariants:
///           (D1) `sum(gaugeWeightByEpoch[e][g]) == totalWeightByEpoch[e]`
///                — basic accounting conservation under all vote flows.
///           (D2) `sum(_getRelativeWeightAt(g, e)) approximately BPS`
///                — the new Curve-style natural-distribution algorithm should
///                exact-distribute up to N-gauge integer rounding.
///
///         Pre-V3, the cap-and-renormalize formula leaked up to 50% in two
///         documented edges (V3-GOV-03/06). The Curve-style rewrite should
///         eliminate that leak; this invariant proves it across random vote
///         flows.

contract InvD_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract InvD_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 id = _id++; _mint(to, id); return id; }
}

contract InvD_Handler is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    address[] public actors;
    address[] public gauges;
    uint256 public actionCount;

    constructor(GaugeController _g, TegridyStaking _s, address[] memory _actors, address[] memory _gauges) {
        gauge = _g;
        staking = _s;
        actors = _actors;
        gauges = _gauges;
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @notice Each actor casts a single vote per epoch with random weight allocation
    ///         across 1-3 gauges. Weights forced to sum to 10000.
    function doVote(uint256 actorSeed, uint256 g0Weight, uint256 g1Weight) external {
        actionCount++;
        address actor = _pickActor(actorSeed);
        uint256 tokenId = staking.userTokenId(actor);
        if (tokenId == 0) return;

        uint256 epoch = gauge.currentEpoch();
        if (gauge.hasUserVotedInEpoch(actor, epoch)) return;

        // Build a 2-gauge or 3-gauge weight allocation.
        uint256 numGauges = (g0Weight % 2) + 2; // 2 or 3
        if (numGauges > gauges.length) numGauges = gauges.length;

        address[] memory selected = new address[](numGauges);
        uint256[] memory weights = new uint256[](numGauges);
        for (uint256 i = 0; i < numGauges; i++) {
            selected[i] = gauges[i];
        }

        if (numGauges == 2) {
            // weight in [1, 9999] for first, rest is second.
            uint256 w0 = bound(g0Weight, 1, 9999);
            weights[0] = w0;
            weights[1] = 10000 - w0;
        } else {
            uint256 w0 = bound(g0Weight, 1, 9998);
            uint256 w1 = bound(g1Weight, 1, 9999 - w0);
            weights[0] = w0;
            weights[1] = w1;
            weights[2] = 10000 - w0 - w1;
        }

        vm.prank(actor);
        try gauge.vote(tokenId, selected, weights) {} catch {}
    }

    function doAdvanceEpoch(uint256 secs) external {
        actionCount++;
        secs = bound(secs, 1 days, 7 days);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS5_INV_D_GaugeWeights is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    InvD_Toweli public toweli;
    InvD_JBAC public jbac;

    InvD_Handler public handler;

    address treasury = makeAddr("inv_d_treasury");
    address[] internal actorsArr;
    address[] internal gaugesArr;

    function setUp() public {
        toweli = new InvD_Toweli();
        jbac = new InvD_JBAC();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);

        // 4 actors with various stake amounts to create heterogeneous voting power.
        uint256[4] memory stakes = [uint256(50_000 ether), 200_000 ether, 1_000 ether, 10_000 ether];
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("inv_d_actor", i)))));
            actorsArr.push(a);
            toweli.transfer(a, stakes[i]);
            vm.prank(a);
            toweli.approve(address(staking), type(uint256).max);
            vm.prank(a);
            staking.stake(stakes[i], 365 days);
        }

        // 3 gauges — propose, wait full 24h timelock, execute, repeat
        address[3] memory gAddrs = [
            makeAddr("inv_d_gauge_0"),
            makeAddr("inv_d_gauge_1"),
            makeAddr("inv_d_gauge_2")
        ];
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 3; i++) {
            gaugesArr.push(gAddrs[i]);
            // AUDIT FIX G-02: proposeAddGauge requires gauge.code.length > 0.
            // AUDIT FIX (pass-8) GOV-INT-01: also requires non-zero `pair` arg.
            if (gAddrs[i].code.length == 0) vm.etch(gAddrs[i], hex"60006000fd");
            address gPair = address(uint160(gAddrs[i]) ^ uint160(1));
            if (gPair.code.length == 0) vm.etch(gPair, hex"60006000fd");
            gauge.proposeAddGauge(gAddrs[i], gPair);
            t = t + 25 hours;
            vm.warp(t);
            gauge.executeAddGauge();
        }

        // Advance 1 epoch so checkpoint snapshots are in-range (per existing test pattern).
        vm.warp(block.timestamp + 7 days);

        handler = new InvD_Handler(gauge, staking, actorsArr, gaugesArr);
        targetContract(address(handler));
    }

    /// @notice INVARIANT D1: per-epoch sum of per-gauge weights MUST equal totalWeightByEpoch
    function invariant_perGaugeWeightsSumToTotal() public view {
        uint256 epoch = gauge.currentEpoch();
        // Check current epoch and the few past epochs (via gaugeWeightByEpoch lookup).
        // No epochs storage iteration helper, so just check current.
        uint256 sum;
        for (uint256 i = 0; i < gaugesArr.length; i++) {
            sum += gauge.gaugeWeightByEpoch(epoch, gaugesArr[i]);
        }
        uint256 reported = gauge.totalWeightByEpoch(epoch);
        assertEq(sum, reported, "gauge weight sum != totalWeightByEpoch");
    }

    /// @notice INVARIANT D2: sum of relative weights == BPS (when total > 0 AND
    ///         quorum is met). Curve-style natural distribution should be exact
    ///         up to integer rounding (≤ num_gauges - 1 wei loss per epoch).
    /// @dev    AUDIT FIX FRESH-2026: GC-QUORUM-BAKE-IN [HIGH] — guard now also
    ///         skips when `quorumMet(epoch) == false`. Pre-PR-50, this
    ///         invariant only checked sum-to-BPS when `total > 0`; PR #50
    ///         baked a `quorumMet` gate into `_getRelativeWeightAt` so the
    ///         accessors return 0 for ALL gauges in any epoch with fewer
    ///         than MIN_VOTING_NFTS_PER_EPOCH (3) distinct voters. The
    ///         handler casts single-actor votes, so the 1-voter state
    ///         (which the runner asserts after every handler call) has
    ///         `total > 0` but `quorumMet == false`, producing `sum == 0`
    ///         and tripping the `assertGe(0, 9997)` boundary. Mirroring
    ///         the accessor's gate here preserves the invariant's intent
    ///         ("sum to BPS WHEN emissions actually distribute") without
    ///         asserting on the no-distribution sub-quorum window.
    function invariant_relativeWeightsSumToBPS() public view {
        uint256 epoch = gauge.currentEpoch();
        uint256 total = gauge.totalWeightByEpoch(epoch);
        if (total == 0) return; // no votes yet — trivially OK
        if (!gauge.quorumMet(epoch)) return; // sub-quorum — accessors fail closed by design

        uint256 sum;
        for (uint256 i = 0; i < gaugesArr.length; i++) {
            sum += gauge.getRelativeWeightAt(gaugesArr[i], epoch);
        }
        // Allow ≤ (numGauges - 1) wei rounding loss
        assertLe(sum, 10000, "relative weights overshoot BPS (cap leak?)");
        assertGe(sum, 10000 - gaugesArr.length, "relative weights underdistribute (>numGauges loss)");
    }
}
