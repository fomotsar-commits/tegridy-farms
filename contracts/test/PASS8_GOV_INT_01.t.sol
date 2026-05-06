// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/VoteIncentives.sol";
import "../src/VoteIncentivesAdmin.sol";
import "../src/GaugeController.sol";

/// @title PASS8 GOV-INT-01 — gauge ↔ bribe registry coupling
/// @notice Validates the pass-8 batch-11 fix that closes the
///         "GaugeController and VoteIncentives are disjoint" bug. Bribers
///         now MUST target a pair that has a registered gauge in
///         GaugeController, otherwise depositBribe / depositBribeETH revert
///         with NoGaugeForPair() instead of stranding the bond.
///
///         Pre-fix: VoteIncentives accepted bribes for any factory-validated
///         pair, regardless of whether that pair had a gauge with emission
///         weight. Bribes deposited on un-gauged pairs sat in the contract
///         with no recovery path until orphan-rescue / sweep windows opened.

// ─── Mocks ───────────────────────────────────────────────────────────

contract GovInt01_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract GovInt01_Bribe is ERC20 {
    constructor() ERC20("Bribe", "BRIBE") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract GovInt01_WETH {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "ins");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @dev Real-shape mock pair with token0/token1 so VoteIncentives._validatePair passes.
contract GovInt01_Pair {
    address public token0;
    address public token1;
    constructor(address t0, address t1) { token0 = t0; token1 = t1; }
}

contract GovInt01_Factory {
    mapping(bytes32 => address) internal _pairs;
    mapping(address => bool) public disabledPairs;
    function registerPair(address t0, address t1, address p) external {
        _pairs[keccak256(abi.encodePacked(t0, t1))] = p;
        _pairs[keccak256(abi.encodePacked(t1, t0))] = p;
    }
    function getPair(address t0, address t1) external view returns (address) {
        return _pairs[keccak256(abi.encodePacked(t0, t1))];
    }
}

contract GovInt01_VotingEscrow {
    mapping(address => uint256) public votingPowers;
    uint256 public totalPower;
    function setVotingPower(address user, uint256 power) external {
        totalPower = totalPower - votingPowers[user] + power;
        votingPowers[user] = power;
    }
    function votingPowerOf(address user) external view returns (uint256) { return votingPowers[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return votingPowers[user]; }
    function totalLocked() external view returns (uint256) { return totalPower; }
    function totalBoostedStake() external view returns (uint256) { return totalPower; }
    function userTokenId(address) external pure returns (uint256) { return 1; }
    function positions(uint256) external view returns (
        uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool, uint256, bool
    ) {
        return (100e18, 100e18, 10000, block.timestamp + 365 days, 365 days, false, 0, block.timestamp, false, 0, false);
    }
    function paused() external pure returns (bool) { return false; }
}

/// @dev Minimal staking surface needed by GaugeController constructor.
contract GovInt01_Staking {
    mapping(address => uint256) public votingPowers;
    function setPower(address u, uint256 p) external { votingPowers[u] = p; }
    function votingPowerOf(address u) external view returns (uint256) { return votingPowers[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return votingPowers[u]; }
    function ownerOf(uint256) external view returns (address) { return msg.sender; }
    function positions(uint256) external pure returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        return (100e18, 100e18, 0, 0, 10000, 365 days, false, false, 0, 0, false);
    }
}

// ─── Test ────────────────────────────────────────────────────────────

contract PASS8_GOV_INT_01 is Test {
    GovInt01_Toweli toweli;
    GovInt01_Bribe bribeToken;
    GovInt01_WETH weth;
    GovInt01_VotingEscrow ve;
    GovInt01_Staking staking;
    GovInt01_Factory factory;
    GovInt01_Pair pairGauged;     // factory-registered AND gauge-mapped
    GovInt01_Pair pairUngauged;   // factory-registered, NO gauge mapping

    VoteIncentives vi;
    VoteIncentivesAdmin viAdmin;
    GaugeController gc;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address gaugeAddr;

    function setUp() public {
        toweli = new GovInt01_Toweli();
        bribeToken = new GovInt01_Bribe();
        weth = new GovInt01_WETH();
        ve = new GovInt01_VotingEscrow();
        staking = new GovInt01_Staking();
        factory = new GovInt01_Factory();

        // Two factory-registered pairs: one will get a gauge, one won't.
        address t0 = address(0x1111);
        address t1 = address(0x2222);
        pairGauged = new GovInt01_Pair(t0, t1);
        factory.registerPair(t0, t1, address(pairGauged));

        address u0 = address(0x3333);
        address u1 = address(0x4444);
        pairUngauged = new GovInt01_Pair(u0, u1);
        factory.registerPair(u0, u1, address(pairUngauged));

        // Stand up VoteIncentives + admin sister.
        vi = new VoteIncentives(
            address(ve), treasury, address(weth), address(factory), address(toweli), 300
        );
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));

        // Stand up GaugeController + register a gauge for `pairGauged` only.
        gc = new GaugeController(address(staking), 1_000_000 ether);
        gaugeAddr = makeAddr("gaugeAddr_for_pairGauged");
        vm.etch(gaugeAddr, hex"60006000fd");
        gc.proposeAddGauge(gaugeAddr, address(pairGauged));
        skip(25 hours);
        gc.executeAddGauge();

        // Whitelist the bribe token via the admin's timelocked path.
        viAdmin.proposeWhitelistChange(address(bribeToken), true);
        skip(25 hours);
        viAdmin.executeWhitelistChange();

        // Voting power for alice so the contract has a non-zero denominator.
        ve.setVotingPower(alice, 1000 ether);

        // Fund alice with bribe token + ETH for direct bribe attempts.
        bribeToken.transfer(alice, 1_000_000 ether);
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        bribeToken.approve(address(vi), type(uint256).max);
    }

    /// @notice Pre-wiring: gaugeController is unset; bribes flow as before
    ///         (legacy behavior preserved for backwards compat with fixtures
    ///         that don't wire a GaugeController). This validates the
    ///         conditional gate: no GC wired = no check.
    function test_GOV_INT_01_preWiring_bribesFlowOnAnyPair() public {
        // No setGaugeController call — gaugeController stays address(0).
        assertEq(vi.gaugeController(), address(0));

        vm.prank(alice);
        vi.depositBribe(address(pairUngauged), address(bribeToken), 100 ether);
        // No revert — pre-wiring permits any factory pair.
    }

    /// @notice Post-wiring: depositBribe on an ungauged pair reverts NoGaugeForPair.
    function test_GOV_INT_01_postWiring_revertsOnUngauged() public {
        vi.setGaugeController(address(gc));

        vm.prank(alice);
        vm.expectRevert(VoteIncentives.NoGaugeForPair.selector);
        vi.depositBribe(address(pairUngauged), address(bribeToken), 100 ether);
    }

    /// @notice Post-wiring: depositBribeETH on an ungauged pair reverts NoGaugeForPair.
    function test_GOV_INT_01_postWiring_revertsETHBribeOnUngauged() public {
        vi.setGaugeController(address(gc));

        vm.prank(alice);
        vm.expectRevert(VoteIncentives.NoGaugeForPair.selector);
        vi.depositBribeETH{value: 1 ether}(address(pairUngauged));
    }

    /// @notice Post-wiring: bribes on a registered gauged pair succeed normally.
    function test_GOV_INT_01_postWiring_succeedsOnGauged() public {
        vi.setGaugeController(address(gc));

        vm.prank(alice);
        vi.depositBribe(address(pairGauged), address(bribeToken), 100 ether);
        // No revert; bribe lands.
    }

    /// @notice After a gauge is removed, the pair → gauge mapping is cleared,
    ///         so subsequent bribes on the now-orphaned pair revert.
    function test_GOV_INT_01_postRemove_revertsOnDearmedPair() public {
        vi.setGaugeController(address(gc));

        // Confirm bribe initially succeeds while the gauge exists.
        vm.prank(alice);
        vi.depositBribe(address(pairGauged), address(bribeToken), 100 ether);

        // Stage the next-epoch removal (clears `pairToGauge` immediately).
        gc.proposeRemoveGauge(gaugeAddr);
        skip(25 hours);
        gc.executeRemoveGaugeNextEpoch();
        assertEq(gc.pairToGauge(address(pairGauged)), address(0));

        // Now bribes on the same pair revert.
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.NoGaugeForPair.selector);
        vi.depositBribe(address(pairGauged), address(bribeToken), 100 ether);
    }

    /// @notice setGaugeController is one-shot — second call reverts.
    function test_GOV_INT_01_setGaugeController_oneShot() public {
        vi.setGaugeController(address(gc));
        vm.expectRevert(VoteIncentives.GaugeControllerAlreadySet.selector);
        vi.setGaugeController(address(gc));
    }

    /// @notice setGaugeController rejects non-contract input.
    function test_GOV_INT_01_setGaugeController_rejectsEOA() public {
        vm.expectRevert();
        vi.setGaugeController(makeAddr("eoa_gc"));
    }

    /// @notice setGaugeController rejects address(0).
    function test_GOV_INT_01_setGaugeController_rejectsZero() public {
        vm.expectRevert(VoteIncentives.ZeroAddress.selector);
        vi.setGaugeController(address(0));
    }

    /// @notice GaugeController side: can't add two gauges for the same pair.
    function test_GOV_INT_01_GC_pairAlreadyMapped() public {
        address otherGauge = makeAddr("other_gauge");
        vm.etch(otherGauge, hex"60006000fd");

        vm.expectRevert(GaugeController.PairAlreadyMapped.selector);
        gc.proposeAddGauge(otherGauge, address(pairGauged));
    }

    /// @notice GaugeController side: zero pair rejected.
    function test_GOV_INT_01_GC_zeroPairRejected() public {
        address newGauge = makeAddr("new_gauge");
        vm.etch(newGauge, hex"60006000fd");

        vm.expectRevert(GaugeController.InvalidPair.selector);
        gc.proposeAddGauge(newGauge, address(0));
    }

    /// @notice GaugeController side: EOA pair rejected (must be a contract).
    function test_GOV_INT_01_GC_eoaPairRejected() public {
        address newGauge = makeAddr("new_gauge_eoa");
        vm.etch(newGauge, hex"60006000fd");
        address eoaPair = makeAddr("eoa_pair");

        vm.expectRevert(GaugeController.InvalidPair.selector);
        gc.proposeAddGauge(newGauge, eoaPair);
    }

    /// @notice GaugeController side: cancelAddGauge clears pendingPairForAdd.
    function test_GOV_INT_01_GC_cancelClearsPendingPair() public {
        address newGauge = makeAddr("cancel_gauge");
        address newPair = makeAddr("cancel_pair");
        vm.etch(newGauge, hex"60006000fd");
        vm.etch(newPair, hex"60006000fd");

        gc.proposeAddGauge(newGauge, newPair);
        assertEq(gc.pendingPairForAdd(), newPair);

        gc.cancelAddGauge();
        assertEq(gc.pendingPairForAdd(), address(0));

        // Pair was never mapped (cancel before execute); it stays unmapped.
        assertEq(gc.pairToGauge(newPair), address(0));
    }
}
