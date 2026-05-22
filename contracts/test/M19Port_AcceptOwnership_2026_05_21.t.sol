// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// AUDIT FIX 2026-05-21 M19-PORT: regression tests for the `acceptOwnership` override
// port across the 14 remaining timelock-inheriting contracts. The canonical pattern
// (TegridyLaunchpadV2.acceptOwnership, TegridyLaunchpadV2.sol:426-438) flushes pending
// timelocked proposals on ownership handoff so the new owner cannot silently inherit a
// hostile booby-trap queued by the outgoing owner.
//
// For each contract: deploy → old owner proposes → transferOwnership(newOwner) →
// newOwner acceptOwnership → assert `_executeAfter[KEY] == 0` → assert re-propose works.

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MemeBountyBoard} from "../src/MemeBountyBoard.sol";
import {POLAccumulator} from "../src/POLAccumulator.sol";
import {GaugeController} from "../src/GaugeController.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {TegridyLPFarming} from "../src/TegridyLPFarming.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {TegridyNFTLending} from "../src/TegridyNFTLending.sol";
import {TegridyLendingAdmin} from "../src/TegridyLendingAdmin.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {VoteIncentivesAdmin} from "../src/VoteIncentivesAdmin.sol";

// ─── Shared mocks ───────────────────────────────────────────────────────────

contract MockTokenM19 is ERC20 {
    constructor() ERC20("MockToken", "MOCK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockWETHM19 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WETH_WITHDRAW_FAIL");
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @dev Implements the IStakingVote / IVotingEscrow / IStakingForReferral surface
///      required by ALL the consumer contracts in this regression file. Each consumer
///      only reads a subset of these functions; an over-implemented mock is cheaper
///      to maintain than 4 separate single-purpose mocks.
contract MockStakingM19 {
    function votingPowerOf(address) external pure returns (uint256) { return 0; }
    function votingPowerAt(address, uint256) external pure returns (uint256) { return 0; }
    function votingPowerAtTimestamp(address, uint256) external pure returns (uint256) { return 0; }
    function totalBoostedStake() external pure returns (uint256) { return 0; }
    function totalBoostedStakeAtTimestamp(uint256) external pure returns (uint256) { return 0; }
    function userTokenId(address u) external pure returns (uint256) { return uint256(uint160(u)); }
    function holdsToken(address, uint256) external pure returns (bool) { return true; }
    function userPositionCount(address) external pure returns (uint256) { return 1; }
}

// ─── Per-contract regression tests ──────────────────────────────────────────

contract M19Port_MemeBountyBoard_Test is Test {
    MemeBountyBoard board;
    MockTokenM19 token;
    MockWETHM19 weth;
    MockStakingM19 staking;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        token = new MockTokenM19();
        weth = new MockWETHM19();
        staking = new MockStakingM19();
        vm.prank(creator);
        board = new MemeBountyBoard(
            address(token), address(staking), address(weth), address(0), makeAddr("treasury")
        );
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        board.proposeTreasuryChange(hostile);
        assertTrue(board.hasPendingProposal(board.TREASURY_CHANGE()));

        vm.prank(creator);
        board.transferOwnership(newOwner);
        vm.prank(newOwner);
        board.acceptOwnership();

        assertFalse(board.hasPendingProposal(board.TREASURY_CHANGE()));
        assertEq(board.pendingTreasury(), address(0));

        // Slot was cleared — new owner can re-propose without ExistingProposalPending.
        vm.prank(newOwner);
        board.proposeTreasuryChange(makeAddr("safeTreasury"));
        assertTrue(board.hasPendingProposal(board.TREASURY_CHANGE()));
    }
}

/// @dev TegridyFeeHook is excluded from this regression file: its constructor takes
///      `IPoolManager` (Uniswap V4) and the hook address must satisfy `_v4HookFlagMask`
///      lower-14-bit constraints, which requires CREATE2 address-mining at deploy time.
///      The override added to TegridyFeeHook is byte-shape-identical to the others
///      covered here (same `if (_executeAfter[KEY] != 0)` → `_cancel(KEY)` → zero
///      mirror → emit typed event), and the existing TegridyFeeHook deployment
///      harness lives in `Audit195_PremiumHook.t.sol` / per-V4 test files. A follow-up
///      can add an FeeHook-specific acceptOwnership assertion using that harness.

contract M19Port_POLAccumulator_Test is Test {
    POLAccumulator pol;
    MockTokenM19 toweli;
    MockWETHM19 weth;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        toweli = new MockTokenM19();
        weth = new MockWETHM19();
        MockPOLFactoryM19 factory = new MockPOLFactoryM19();
        MockPOLLPTokenM19 lp = new MockPOLLPTokenM19();
        lp.setToken0(address(toweli));
        factory.setPair(address(lp));
        MockPOLRouterM19 router = new MockPOLRouterM19(address(weth), address(factory));
        MockPOLTWAPM19 twap = new MockPOLTWAPM19();
        vm.prank(creator);
        pol = new POLAccumulator(
            address(toweli),
            address(router),
            address(lp),
            makeAddr("treasury"),
            address(twap),
            address(0)
        );
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        pol.proposeTreasuryChange(hostile);
        assertTrue(pol.hasPendingProposal(pol.TREASURY_CHANGE()));

        vm.prank(creator);
        pol.transferOwnership(newOwner);
        vm.prank(newOwner);
        pol.acceptOwnership();

        assertFalse(pol.hasPendingProposal(pol.TREASURY_CHANGE()));
        assertEq(pol.pendingTreasury(), address(0));

        vm.prank(newOwner);
        pol.proposeTreasuryChange(makeAddr("safeTreasury"));
        assertTrue(pol.hasPendingProposal(pol.TREASURY_CHANGE()));
    }
}

// POLAccumulator dependency mocks (minimum surface for construction + a single propose).
contract MockPOLFactoryM19 {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}
contract MockPOLLPTokenM19 is ERC20 {
    address public token0;
    constructor() ERC20("LP", "LP") { _mint(msg.sender, 1_000 ether); }
    function setToken0(address _t0) external { token0 = _t0; }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (1 ether, 1 ether, uint32(block.timestamp));
    }
}
contract MockPOLRouterM19 {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    constructor(address _w, address _f) { wethAddr = _w; factoryAddr = _f; }
    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }
}
contract MockPOLTWAPM19 {
    function consult(address, uint256 amountIn) external pure returns (uint256) { return amountIn; }
    function getLatestObservation(address) external view returns (uint256 timestamp, uint256, uint256, bool) {
        return (block.timestamp, 0, 0, false);
    }
}

contract M19Port_GaugeController_Test is Test {
    GaugeController controller;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        address stakingAddr = makeAddr("staking");
        vm.etch(stakingAddr, hex"60006000fd");
        vm.prank(creator);
        controller = new GaugeController(stakingAddr, 1_000 ether);
    }

    function test_M19PORT_acceptOwnership_flushesEmissionBudgetChange() public {
        vm.prank(creator);
        controller.proposeEmissionBudgetChange(9999 ether);
        assertTrue(controller.hasPendingProposal(controller.EMISSION_BUDGET_CHANGE()));

        vm.prank(creator);
        controller.transferOwnership(newOwner);
        vm.prank(newOwner);
        controller.acceptOwnership();

        assertFalse(controller.hasPendingProposal(controller.EMISSION_BUDGET_CHANGE()));
        assertEq(controller.pendingEmissionBudget(), 0);

        vm.prank(newOwner);
        controller.proposeEmissionBudgetChange(500 ether);
        assertTrue(controller.hasPendingProposal(controller.EMISSION_BUDGET_CHANGE()));
    }
}

contract M19Port_SwapFeeRouterAdmin_Test is Test {
    SwapFeeRouterAdmin admin;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        MockSFRRouterM19 router = new MockSFRRouterM19();
        vm.prank(creator);
        admin = new SwapFeeRouterAdmin(address(router));
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        admin.proposeTreasuryChange(hostile);
        assertTrue(admin.hasPendingProposal(admin.TREASURY_CHANGE()));

        vm.prank(creator);
        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertEq(admin.pendingTreasury(), address(0));

        vm.prank(newOwner);
        admin.proposeTreasuryChange(makeAddr("safeTreasury"));
        assertTrue(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
    }
}

contract MockSFRRouterM19 {
    function MAX_FEE_BPS() external pure returns (uint256) { return 1000; }
    function feeBps() external pure returns (uint256) { return 30; }
}

contract M19Port_TegridyLPFarming_Test is Test {
    TegridyLPFarming farm;
    MockTokenM19 reward;
    MockTokenM19 staking;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        reward = new MockTokenM19();
        staking = new MockTokenM19();
        address stakingNFT = makeAddr("stakingNFT");
        vm.etch(stakingNFT, hex"60006000fd");
        vm.prank(creator);
        farm = new TegridyLPFarming(
            address(reward), address(staking), stakingNFT, makeAddr("treasury"), 7 days
        );
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        farm.proposeTreasuryChange(hostile);
        assertTrue(farm.hasPendingProposal(farm.TREASURY_CHANGE()));

        vm.prank(creator);
        farm.transferOwnership(newOwner);
        vm.prank(newOwner);
        farm.acceptOwnership();

        assertFalse(farm.hasPendingProposal(farm.TREASURY_CHANGE()));
        assertEq(farm.pendingTreasury(), address(0));

        vm.prank(newOwner);
        farm.proposeTreasuryChange(makeAddr("safeTreasury"));
        assertTrue(farm.hasPendingProposal(farm.TREASURY_CHANGE()));
    }
}

contract M19Port_ReferralSplitter_Test is Test {
    ReferralSplitter splitter;
    MockStakingM19 staking;
    MockWETHM19 weth;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        staking = new MockStakingM19();
        weth = new MockWETHM19();
        vm.prank(creator);
        splitter = new ReferralSplitter(
            1000, address(staking), makeAddr("treasury"), address(weth)
        );
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        splitter.proposeTreasury(hostile);
        assertTrue(splitter.hasPendingProposal(splitter.TREASURY_CHANGE()));

        vm.prank(creator);
        splitter.transferOwnership(newOwner);
        vm.prank(newOwner);
        splitter.acceptOwnership();

        assertFalse(splitter.hasPendingProposal(splitter.TREASURY_CHANGE()));
        assertEq(splitter.pendingTreasury(), address(0));

        vm.prank(newOwner);
        splitter.proposeTreasury(makeAddr("safeTreasury"));
        assertTrue(splitter.hasPendingProposal(splitter.TREASURY_CHANGE()));
    }
}

contract M19Port_RevenueDistributor_Test is Test {
    RevenueDistributor rev;
    MockStakingM19 staking;
    MockWETHM19 weth;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        staking = new MockStakingM19();
        weth = new MockWETHM19();
        vm.prank(creator);
        rev = new RevenueDistributor(address(staking), makeAddr("treasury"), address(weth));
    }

    function test_M19PORT_acceptOwnership_flushesTreasuryChange() public {
        vm.prank(creator);
        rev.proposeTreasuryChange(hostile);
        assertTrue(rev.hasPendingProposal(rev.TREASURY_CHANGE()));

        vm.prank(creator);
        rev.transferOwnership(newOwner);
        vm.prank(newOwner);
        rev.acceptOwnership();

        assertFalse(rev.hasPendingProposal(rev.TREASURY_CHANGE()));
        assertEq(rev.pendingTreasury(), address(0));

        vm.prank(newOwner);
        rev.proposeTreasuryChange(makeAddr("safeTreasury"));
        assertTrue(rev.hasPendingProposal(rev.TREASURY_CHANGE()));
    }
}

contract M19Port_TegridyNFTLending_Test is Test {
    TegridyNFTLending lending;
    MockWETHM19 weth;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        weth = new MockWETHM19();
        vm.prank(creator);
        // L1 deploy (chainid 1 by default in foundry tests, so sequencerFeed may be zero).
        vm.chainId(1);
        lending = new TegridyNFTLending(makeAddr("treasury"), 500, address(weth), address(0));
    }

    function test_M19PORT_acceptOwnership_flushesProtocolFeeChange() public {
        vm.prank(creator);
        lending.proposeProtocolFeeChange(750); // 7.5%
        assertTrue(lending.hasPendingProposal(lending.PROTOCOL_FEE_CHANGE()));

        vm.prank(creator);
        lending.transferOwnership(newOwner);
        vm.prank(newOwner);
        lending.acceptOwnership();

        assertFalse(lending.hasPendingProposal(lending.PROTOCOL_FEE_CHANGE()));
        // NOTE: TegridyNFTLending uses the compact `_forceCancel` form (size-constrained,
        // see acceptOwnership doc comment) — the `pendingProtocolFeeBps` slot is NOT zeroed
        // by the override (harmless because every `executeProtocolFeeChange` calls `_execute`
        // first which reverts NoPendingProposal on the cleared timelock slot). Slot is
        // overwritten by the next propose call below.

        vm.prank(newOwner);
        lending.proposeProtocolFeeChange(250);
        assertTrue(lending.hasPendingProposal(lending.PROTOCOL_FEE_CHANGE()));
        assertEq(lending.pendingProtocolFeeBps(), 250);
    }
}

contract M19Port_TegridyLendingAdmin_Test is Test {
    TegridyLendingAdmin admin;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        MockLendingTargetM19 lendingTarget = new MockLendingTargetM19();
        vm.prank(creator);
        admin = new TegridyLendingAdmin(address(lendingTarget));
    }

    function test_M19PORT_acceptOwnership_flushesProtocolFeeChange() public {
        vm.prank(creator);
        admin.proposeProtocolFeeChange(700);
        assertTrue(admin.hasPendingProposal(admin.PROTOCOL_FEE_CHANGE()));

        vm.prank(creator);
        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.PROTOCOL_FEE_CHANGE()));
        assertEq(admin.pendingProtocolFeeBps(), 0);

        vm.prank(newOwner);
        admin.proposeProtocolFeeChange(250);
        assertTrue(admin.hasPendingProposal(admin.PROTOCOL_FEE_CHANGE()));
    }
}

contract MockLendingTargetM19 {
    function MAX_PROTOCOL_FEE_BPS() external pure returns (uint256) { return 1000; }
    function protocolFeeBps() external pure returns (uint256) { return 500; }
    function treasury() external pure returns (address) { return address(0xBEEF); }
    function MAX_ORIGINATION_FEE_BPS() external pure returns (uint256) { return 500; }
    function originationFeeBps() external pure returns (uint256) { return 50; }
    function MAX_PRINCIPAL() external pure returns (uint256) { return 1_000_000 ether; }
    function MIN_PRINCIPAL() external pure returns (uint256) { return 1 ether; }
    function MIN_DURATION() external pure returns (uint256) { return 1 days; }
    function MAX_DURATION() external pure returns (uint256) { return 365 days; }
}

contract M19Port_CommunityGrants_Test is Test {
    CommunityGrants grants;
    MockStakingM19 staking;
    MockTokenM19 toweli;
    MockWETHM19 weth;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");
    address hostile = makeAddr("hostile");

    function setUp() public {
        staking = new MockStakingM19();
        toweli = new MockTokenM19();
        weth = new MockWETHM19();
        vm.prank(creator);
        grants = new CommunityGrants(
            address(staking), address(toweli), makeAddr("feeReceiver"), address(weth)
        );
    }

    function test_M19PORT_acceptOwnership_flushesFeeReceiverChange() public {
        vm.prank(creator);
        grants.proposeFeeReceiver(hostile);
        assertTrue(grants.hasPendingProposal(grants.FEE_RECEIVER_CHANGE()));

        vm.prank(creator);
        grants.transferOwnership(newOwner);
        vm.prank(newOwner);
        grants.acceptOwnership();

        assertFalse(grants.hasPendingProposal(grants.FEE_RECEIVER_CHANGE()));
        assertEq(grants.pendingFeeReceiver(), address(0));

        vm.prank(newOwner);
        grants.proposeFeeReceiver(makeAddr("safeReceiver"));
        assertTrue(grants.hasPendingProposal(grants.FEE_RECEIVER_CHANGE()));
    }
}

contract M19Port_TegridyRestaking_Test is Test {
    TegridyRestaking restaking;
    MockTokenM19 reward;
    MockTokenM19 bonus;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        reward = new MockTokenM19();
        bonus = new MockTokenM19();
        address stakingNFT = makeAddr("stakingNFT");
        vm.etch(stakingNFT, hex"60006000fd");
        vm.prank(creator);
        restaking = new TegridyRestaking(stakingNFT, address(reward), address(bonus), 0);
    }

    function test_M19PORT_acceptOwnership_flushesBonusRateChange() public {
        // bonusRewardToken has 18 decimals, max = 10 * 1e18. Stay below.
        vm.prank(creator);
        restaking.proposeBonusRate(1 ether);
        assertTrue(restaking.hasPendingProposal(restaking.BONUS_RATE_CHANGE()));

        vm.prank(creator);
        restaking.transferOwnership(newOwner);
        vm.prank(newOwner);
        restaking.acceptOwnership();

        assertFalse(restaking.hasPendingProposal(restaking.BONUS_RATE_CHANGE()));
        assertEq(restaking.pendingBonusRate(), 0);

        // BONUS_RATE_ACTION_COOLDOWN is 24h — wait through it before re-proposing.
        vm.warp(block.timestamp + 25 hours);
        vm.prank(newOwner);
        restaking.proposeBonusRate(2 ether);
        assertTrue(restaking.hasPendingProposal(restaking.BONUS_RATE_CHANGE()));
    }
}

contract M19Port_TegridyStakingAdmin_Test is Test {
    TegridyStakingAdmin admin;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        MockStakingTargetM19 stakingTarget = new MockStakingTargetM19();
        vm.prank(creator);
        admin = new TegridyStakingAdmin(address(stakingTarget));
    }

    function test_M19PORT_acceptOwnership_flushesRewardRateChange() public {
        vm.prank(creator);
        admin.proposeRewardRate(1e17);
        assertTrue(admin.hasPendingProposal(admin.REWARD_RATE_CHANGE()));

        vm.prank(creator);
        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.REWARD_RATE_CHANGE()));
        assertEq(admin.pendingRewardRate(), 0);

        vm.prank(newOwner);
        admin.proposeRewardRate(5e17);
        assertTrue(admin.hasPendingProposal(admin.REWARD_RATE_CHANGE()));
    }
}

contract MockStakingTargetM19 {
    function MAX_REWARD_RATE() external pure returns (uint256) { return 1e18; }
    function treasury() external pure returns (address) { return address(0xBEEF); }
    function rewardRate() external pure returns (uint256) { return 0; }
}

contract M19Port_VoteIncentivesAdmin_Test is Test {
    VoteIncentivesAdmin admin;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        MockVITargetM19 viTarget = new MockVITargetM19();
        vm.prank(creator);
        admin = new VoteIncentivesAdmin(address(viTarget));
    }

    function test_M19PORT_acceptOwnership_flushesFeeChange() public {
        vm.prank(creator);
        admin.proposeFeeChange(500);
        assertTrue(admin.hasPendingProposal(admin.FEE_CHANGE()));

        vm.prank(creator);
        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.FEE_CHANGE()));
        assertEq(admin.pendingFeeBps(), 0);

        vm.prank(newOwner);
        admin.proposeFeeChange(300);
        assertTrue(admin.hasPendingProposal(admin.FEE_CHANGE()));
    }
}

contract MockVITargetM19 {
    function MAX_FEE_BPS() external pure returns (uint256) { return 1000; }
    function bribeFeeBps() external pure returns (uint256) { return 300; }
    function commitRevealEnabled() external pure returns (bool) { return false; }
    function treasury() external pure returns (address) { return address(0xBEEF); }
}
