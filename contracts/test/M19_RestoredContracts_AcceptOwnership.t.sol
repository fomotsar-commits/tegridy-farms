// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/CommunityGrants.sol";
import "../src/GaugeController.sol";
import "../src/MemeBountyBoard.sol";

/// @notice AUDIT FIX 2026-06-01 M19-CLUSTER regression tests for the `acceptOwnership`
///         override ported to the three restored contracts that were still missing it
///         (CommunityGrants, GaugeController, MemeBountyBoard). The peers in the cluster
///         (POLAccumulator / ReferralSplitter / RevenueDistributor / the *Admin sisters)
///         already had + tested the same override; these three were restored from archive
///         in the MVP-cut → re-add and so lacked it post-merge.
///
///         Threat: an OUTGOING / compromised owner queues a hostile timelock proposal
///         immediately before `transferOwnership`. Without the override, that proposal's
///         `_executeAfter` timer keeps running and the new owner inherits an executable
///         booby-trap. Each test proves: propose (pending set) → transferOwnership →
///         new owner acceptOwnership → ALL pending state + `_executeAfter` cleared.

contract M19Mock20 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract M19MockStaking {
    function votingPowerOf(address) external pure returns (uint256) { return 0; }
    function votingPowerAt(address, uint256) external pure returns (uint256) { return 0; }
    function votingPowerAtTimestamp(address, uint256) external pure returns (uint256) { return 0; }
    function totalBoostedStake() external pure returns (uint256) { return 0; }
}

contract M19MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    receive() external payable {}
}

contract M19_RestoredContracts_AcceptOwnership_Test is Test {
    address newOwner = address(0xBEEF);

    // ── CommunityGrants ──────────────────────────────────────────────────
    function test_M19_CommunityGrants_acceptOwnership_clears_pending_feeReceiver() public {
        M19Mock20 toweli = new M19Mock20();
        M19MockStaking ve = new M19MockStaking();
        M19MockWETH weth = new M19MockWETH();
        CommunityGrants g = new CommunityGrants(address(ve), address(toweli), address(this), address(weth));

        // Outgoing owner queues a hostile fee-receiver change.
        g.proposeFeeReceiver(address(0xDEAD));
        assertEq(g.pendingFeeReceiver(), address(0xDEAD), "pending set");
        assertTrue(g.feeReceiverChangeReadyAt() != 0, "timelock armed");

        // Hand off. New owner accepts → the override must flush the proposal.
        g.transferOwnership(newOwner);
        vm.prank(newOwner);
        g.acceptOwnership();

        assertEq(g.pendingFeeReceiver(), address(0), "pending cleared on accept");
        assertEq(g.feeReceiverChangeReadyAt(), 0, "timelock cancelled on accept");
        assertEq(g.owner(), newOwner, "ownership transferred");
    }

    // ── GaugeController ──────────────────────────────────────────────────
    function test_M19_GaugeController_acceptOwnership_clears_all_pending() public {
        M19MockStaking staking = new M19MockStaking();
        GaugeController gc = new GaugeController(address(staking), 1_000 ether);

        // gauge + pair + restaking must be real contracts (G-02 / F-60-2). Use deployed mocks.
        address gauge = address(new M19MockStaking());
        address pair = address(new M19MockStaking());
        address restaking = address(new M19MockStaking());

        // Queue hostile proposals across every global key.
        gc.proposeAddGauge(gauge, pair);
        gc.proposeEmissionBudgetChange(777 ether);
        gc.proposeRestakingContract(restaking);
        assertEq(gc.pendingGaugeAdd(), gauge, "gaugeAdd pending");
        assertEq(gc.pendingPairForAdd(), pair, "pairForAdd pending");
        assertEq(gc.pendingEmissionBudget(), 777 ether, "emission pending");
        assertEq(gc.pendingRestakingContract(), restaking, "restaking pending");

        gc.transferOwnership(newOwner);
        vm.prank(newOwner);
        gc.acceptOwnership();

        assertEq(gc.pendingGaugeAdd(), address(0), "gaugeAdd cleared");
        assertEq(gc.pendingPairForAdd(), address(0), "pairForAdd cleared");
        assertEq(gc.pendingEmissionBudget(), 0, "emission cleared");
        assertEq(gc.pendingRestakingContract(), address(0), "restaking cleared");
        assertEq(gc.restakingChangeReadyAt(), 0, "restaking timelock cancelled");
        assertEq(gc.owner(), newOwner, "ownership transferred");
    }

    // ── MemeBountyBoard ──────────────────────────────────────────────────
    function test_M19_MemeBountyBoard_acceptOwnership_clears_treasury_and_minReward() public {
        M19Mock20 token = new M19Mock20();
        M19MockStaking staking = new M19MockStaking();
        M19MockWETH weth = new M19MockWETH();
        MemeBountyBoard b = new MemeBountyBoard(address(token), address(staking), address(weth), address(0), address(this));

        b.proposeTreasuryChange(address(0xDEAD));
        b.proposeMinBountyReward(0.5 ether); // <= 1 ether cap
        assertEq(b.pendingTreasury(), address(0xDEAD), "treasury pending");
        assertEq(b.pendingMinBountyReward(), 0.5 ether, "minReward pending");
        assertTrue(b.treasuryChangeReadyAt() != 0 && b.minBountyRewardChangeTime() != 0, "timelocks armed");

        b.transferOwnership(newOwner);
        vm.prank(newOwner);
        b.acceptOwnership();

        assertEq(b.pendingTreasury(), address(0), "treasury cleared");
        assertEq(b.pendingMinBountyReward(), 0, "minReward cleared");
        assertEq(b.treasuryChangeReadyAt(), 0, "treasury timelock cancelled");
        assertEq(b.minBountyRewardChangeTime(), 0, "minReward timelock cancelled");
        assertEq(b.owner(), newOwner, "ownership transferred");
    }

    // ── Negative control: accept with NO pending proposals must not revert ──
    function test_M19_acceptOwnership_noPending_doesNotRevert() public {
        M19MockStaking staking = new M19MockStaking();
        GaugeController gc = new GaugeController(address(staking), 1_000 ether);
        gc.transferOwnership(newOwner);
        vm.prank(newOwner);
        gc.acceptOwnership(); // each _cancel is guarded on _executeAfter != 0
        assertEq(gc.owner(), newOwner, "clean handoff with no pending proposals");
    }
}
