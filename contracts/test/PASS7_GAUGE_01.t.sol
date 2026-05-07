// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/GaugeController.sol";

/// @title PASS7_GAUGE_01 — gaugeList duplicate via executeRemoveGaugeNextEpoch + re-add race
/// @notice Pass-7 finding: the `executeRemoveGaugeNextEpoch` path flips
///         `isGauge[G] = false` immediately but leaves `pendingGaugeRemove =
///         G` and `gaugeList` containing G. The expected lifecycle is:
///         (1) executeRemoveGaugeNextEpoch (sets isGauge=false), (2) wait an
///         epoch, (3) executeRemoveGaugeFinalize (cleans gaugeList, clears
///         pendingGaugeRemove).
///
///         BUT: between steps 1 and 3, the owner can call
///         `proposeAddGauge(G)` because `isGauge[G] == false` so the
///         "GaugeAlreadyExists" check passes. After the timelock,
///         `executeAddGauge` pushes G into gaugeList AGAIN — now the array
///         contains G twice. Worse, executeRemoveGaugeFinalize then reverts
///         with `GaugeAlreadyExists` (because isGauge[G] is now true again),
///         so the duplicate cannot be cleaned up.
///
///         Impact:
///         - `gaugeList` permanently contains a duplicate entry (off-chain
///           UIs render G twice).
///         - `gaugeList.length` is inflated; with each
///           "remove-then-re-add-without-finalize" cycle the list grows by
///           one duplicate slot. Fills toward MAX_TOTAL_GAUGES = 50,
///           eventually bricking `proposeAddGauge` for legitimate new gauges.
///         - The `pendingGaugeRemove != address(0)` check then DOS's all
///           future `proposeRemoveGauge` calls until `cancelRemoveGauge` is
///           manually invoked.
///
///         Severity: MEDIUM — owner-only mistake/captured-key abuse, but
///         permanent on-chain state corruption with no automatic cleanup
///         path. The N-1 pass-6 fix only blocks `proposeRemoveGauge` while
///         pending; it does not block this REVERSE re-add ordering.
///
///         Pre-fix workaround: owner must call `cancelRemoveGauge` to clear
///         pendingGaugeRemove, but the duplicate gaugeList entry persists.
///         There is no on-chain remediation path for the duplicate.

contract MockTOWELI_Gauge01 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBAC_Gauge01 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external {
        _mint(to, _nextId++);
    }
}

contract Pass7_Gauge_DuplicateOnReAdd is Test {
    GaugeController public gauge;
    TegridyStaking public staking;
    MockTOWELI_Gauge01 public toweli;
    MockJBAC_Gauge01 public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public gaugeAddr = makeAddr("gaugeG"); // Will be etched with code

    function setUp() public {
        toweli = new MockTOWELI_Gauge01();
        jbac = new MockJBAC_Gauge01();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        toweli.transfer(alice, 500_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();

        // Etch minimal bytecode at gaugeAddr (PUSH1 0; PUSH1 0; REVERT —
        // 5 bytes, satisfies G-02 NotAContract check).
        // AUDIT FIX (pass-8) GOV-INT-01: also etch the paired pair address.
        vm.etch(gaugeAddr, hex"60006000fd");
        address pairAddr = address(uint160(gaugeAddr) ^ uint160(1));
        vm.etch(pairAddr, hex"60006000fd");

        // Add gauge for the first time.
        gauge.proposeAddGauge(gaugeAddr, pairAddr);
        skip(25 hours);
        gauge.executeAddGauge();
        assertTrue(gauge.isGauge(gaugeAddr), "gauge added");

        // BATCH-J4 C4: per-vote per-gauge cap = 5000 BPS. Add a 2nd gauge so the
        // setUp's vote can split 50/50 across two gauges and still exercise the
        // primary gauge having votes.
        address gaugeAddr2 = makeAddr("gaugeG2");
        vm.etch(gaugeAddr2, hex"60006000fd");
        address pairAddr2 = address(uint160(gaugeAddr2) ^ uint160(1));
        vm.etch(pairAddr2, hex"60006000fd");
        gauge.proposeAddGauge(gaugeAddr2, pairAddr2);
        skip(25 hours);
        gauge.executeAddGauge();

        // Advance one epoch so the staker checkpoint is in-range.
        vm.warp(block.timestamp + 7 days);

        // Vote on the gauge so it has weight in the current epoch.
        uint256 tokenId = staking.userTokenId(alice);
        address[] memory gauges = new address[](2);
        uint256[] memory weights = new uint256[](2);
        gauges[0] = gaugeAddr;  weights[0] = 5000;
        gauges[1] = gaugeAddr2; weights[1] = 5000;
        vm.prank(alice);
        gauge.vote(tokenId, gauges, weights);
        assertGt(gauge.getGaugeWeight(gaugeAddr), 0, "gauge has votes");
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-GAUGE-H1 fix.
    ///         `proposeAddGauge(G)` now reverts `GaugeRemovePending` while
    ///         `pendingGaugeRemove == G`, blocking the cycle that previously
    ///         duplicated G in gaugeList. Owner must call
    ///         `executeRemoveGaugeFinalize()` (permissionless after the
    ///         current-epoch weight ages out) before re-adding G.
    function test_pass7_gauge_duplicateOnReAdd() public {
        uint256 lenBefore = gauge.gaugeCount();

        // Step 1+2: propose-remove + execute next-epoch.
        gauge.proposeRemoveGauge(gaugeAddr);
        skip(25 hours);
        gauge.executeRemoveGaugeNextEpoch();
        assertFalse(gauge.isGauge(gaugeAddr), "isGauge[G] flipped false");
        assertEq(gauge.pendingGaugeRemove(), gaugeAddr, "pendingGaugeRemove still set, awaiting finalize");

        // ─── PASS7-GAUGE-H1 FIX VALIDATION ────────────────────────────────
        // Pre-fix, `proposeAddGauge(G)` would have succeeded here, eventually
        // duplicating G in gaugeList and bricking the removal surface
        // permanently. Post-fix, the new guard
        // `if (pendingGaugeRemove == gauge) revert GaugeRemovePending();`
        // refuses the re-add until the staged removal is finalized.
        // AUDIT FIX (pass-8) GOV-INT-01: pass the paired pair to the new arg.
        address pairAddr = address(uint160(gaugeAddr) ^ uint160(1));
        vm.expectRevert(GaugeController.GaugeRemovePending.selector);
        gauge.proposeAddGauge(gaugeAddr, pairAddr);

        // The owner can recover by waiting an epoch (current-epoch weight
        // ages out) then calling `executeRemoveGaugeFinalize()`.
        vm.warp(block.timestamp + 7 days);
        gauge.executeRemoveGaugeFinalize();
        assertEq(gauge.pendingGaugeRemove(), address(0), "pendingGaugeRemove cleared by finalize");
        assertEq(gauge.gaugeCount(), lenBefore - 1, "G removed from gaugeList");

        // Now re-add succeeds normally.
        gauge.proposeAddGauge(gaugeAddr, pairAddr);
        skip(25 hours);
        gauge.executeAddGauge();
        assertTrue(gauge.isGauge(gaugeAddr), "G re-added cleanly");
        assertEq(gauge.gaugeCount(), lenBefore, "gaugeList back to original count (no duplicate)");

        // No duplicate.
        address[] memory list = gauge.getGauges();
        uint256 occurrences = 0;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == gaugeAddr) occurrences++;
        }
        assertEq(occurrences, 1, "FIX: G appears exactly once in gaugeList");

        emit log_string("PASS7-GAUGE-H1 FIX VALIDATED: re-add blocked while pending; finalize recovers cleanly");
    }

    /// @notice POST-FIX REGRESSION (minimal): single-cycle re-add must revert.
    function test_pass7_gauge_singleBrick() public {
        gauge.proposeRemoveGauge(gaugeAddr);
        skip(25 hours);
        gauge.executeRemoveGaugeNextEpoch();

        // PASS7-GAUGE-H1 FIX: re-add blocked while pendingGaugeRemove set.
        // AUDIT FIX (pass-8) GOV-INT-01: pass the paired pair to the new arg.
        address pairAddr2 = address(uint160(gaugeAddr) ^ uint160(1));
        vm.expectRevert(GaugeController.GaugeRemovePending.selector);
        gauge.proposeAddGauge(gaugeAddr, pairAddr2);

        emit log_string("PASS7-GAUGE-H1 FIX VALIDATED: single-cycle re-add reverts GaugeRemovePending");
    }
}
