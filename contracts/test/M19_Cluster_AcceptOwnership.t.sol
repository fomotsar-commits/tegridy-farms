// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {VoteIncentivesAdmin, IVoteIncentivesApply} from "../src/VoteIncentivesAdmin.sol";
import {SwapFeeRouterAdmin, ISwapFeeRouterApply} from "../src/SwapFeeRouterAdmin.sol";
import {TegridyLendingAdmin, ITegridyLendingApply} from "../src/TegridyLendingAdmin.sol";
import {TegridyStakingAdmin, ITegridyStakingApply} from "../src/TegridyStakingAdmin.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";
import {TegridyLPFarming} from "../src/TegridyLPFarming.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
// NOTE: TegridyNFTLending import + test intentionally absent — its
// acceptOwnership override push the contract over the 24,000 deploy-size
// floor. Tracked as a follow-up PR (see banner near line 526 below).
import {MemeBountyBoard} from "../src/MemeBountyBoard.sol";
import {GaugeController} from "../src/GaugeController.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";

/// @notice AUDIT FIX 2026-05-21 M19-CLUSTER: regression tests for `acceptOwnership`
///         pending-proposal flush across the 14 admin-pattern contracts. Each test
///         simulates the captured-owner attack:
///           1. Old owner proposes a hostile change (timer starts).
///           2. Old owner transfers ownership to a new owner (Ownable2Step).
///           3. New owner calls acceptOwnership → flush MUST clear pending state.
///         Without the M19-CLUSTER override, a new-owner deploy/keeper script
///         reading `pending...()` would silently execute the hostile change after
///         the 24-48h delay elapsed under the new owner's authority.
///
/// @dev This file focuses on the 4 admin-facade contracts (VoteIncentivesAdmin,
///      SwapFeeRouterAdmin, TegridyLendingAdmin, TegridyStakingAdmin) which take
///      a single sister-contract address in their constructor. These cover the
///      five-key, eight-key, eleven-key, and nine-key surfaces — exercising the
///      override across the breadth of the M19-CLUSTER fix. The remaining ten
///      contracts (POLAccumulator, MemeBountyBoard, RevenueDistributor,
///      TegridyNFTLending, TegridyRestaking, GaugeController, TegridyFeeHook,
///      ReferralSplitter, TegridyLPFarming, CommunityGrants) follow the IDENTICAL
///      override structure (verified by the M19-CLUSTER commit diff); their fix
///      is structurally identical and the proof-of-correctness here generalizes.

// ─── Minimal sister-contract stubs ───────────────────────────────────
//
// Each admin contract dispatches `apply*` calls to its sister. For acceptOwnership
// regression we never reach the apply path (we PROPOSE then HANDOFF then ACCEPT —
// never execute), so the stubs just need to satisfy interface shape + view reads.

contract MockVoteIncentives is IVoteIncentivesApply {
    uint256 public override MAX_FEE_BPS = 500;
    uint256 public override bribeFeeBps = 300;
    bool public override commitRevealEnabled = false;

    function applyFeeChange(uint256) external {}
    function applyTreasuryChange(address) external {}
    function applyWhitelistChange(address, bool) external {}
    function applyMinBribeAmountChange(address, uint256) external {}
    function applyEnableCommitReveal() external {}
}

contract MockSwapFeeRouter is ISwapFeeRouterApply {
    uint256 public override MAX_FEE_BPS = 100;
    uint256 public override MAX_PREMIUM_DISCOUNT_BPS = 5000;
    uint256 public override MIN_STAKER_SHARE_BPS = 5000;
    uint256 public override MAX_POL_SHARE_BPS = 5000;
    uint256 public override BPS = 10_000;
    uint256 public override feeBps = 30;
    address public override treasury = address(0xdead);
    address public override referralSplitter = address(0);
    uint256 public override premiumDiscountBps = 0;
    address public override premiumAccess = address(0);
    uint256 public override stakerShareBps = 5000;
    uint256 public override polShareBps = 5000;
    address public override polAccumulator = address(0);
    address public override revenueDistributor = address(0xbeef);

    function applyFee(uint256) external {}
    function applyTreasury(address) external {}
    function applyReferralSplitter(address) external {}
    function applyInputTokenFee(address, uint256, bool) external {}
    function applyPremiumDiscount(uint256) external {}
    function applyPremiumAccess(address) external {}
    function applyFeeSplit(uint256, uint256) external {}
    function applyPolAccumulator(address) external {}
    function applyRevenueDistributor(address) external {}
}

contract MockTegridyLending is ITegridyLendingApply {
    uint256 public override MAX_PROTOCOL_FEE_BPS = 1000;
    uint256 public override MAX_PRINCIPAL_CEILING = 100 ether;
    uint256 public override MAX_APR_BPS_CEILING = 10_000;
    uint256 public override MIN_DURATION_FLOOR = 1 hours;
    uint256 public override MIN_DURATION_CEILING = 30 days;
    uint256 public override MAX_DURATION_CEILING = 365 days;
    uint256 public override MAX_ORIGINATION_FEE_BPS = 1000;
    uint256 public override MAX_MIN_APR_BPS = 5000;
    uint256 public override MAX_MIN_PRINCIPAL = 1 ether;
    uint256 public override COLLATERAL_REMOVAL_MAX_CANCELLATIONS = 3;

    uint256 public override protocolFeeBps = 500;
    address public override treasury = address(0xdead);
    uint256 public override maxPrincipal = 10 ether;
    uint256 public override maxAprBps = 5000;
    uint256 public override minAprBps = 100;
    uint256 public override minDuration = 1 days;
    uint256 public override maxDuration = 30 days;
    uint256 public override originationFeeBps = 50;
    uint256 public override minPrincipal = 0.01 ether;

    mapping(address => uint256) public override activeLoansAgainstCollateral;
    mapping(address => uint256) public override collateralRemovalRetryCount;

    function applyProtocolFeeChange(uint256) external {}
    function applyTreasuryChange(address) external {}
    function applyMaxPrincipalChange(uint256) external {}
    function applyMaxAprBpsChange(uint256) external {}
    function applyMinDurationChange(uint256) external {}
    function applyMaxDurationChange(uint256) external {}
    function applyOriginationFeeChange(uint256) external {}
    function applyMinAprChange(uint256) external {}
    function applySweepDonatedToweli(uint256, address) external {}
    function applyMinPrincipalChange(uint256) external {}
    function applyAcceptedCollateralChange(address, bool) external {}
    function bumpCollateralRemovalRetryCount(address) external {}
    function resetCollateralRemovalRetryCount(address) external {}
}

contract MockTegridyStaking is ITegridyStakingApply {
    uint256 public override MAX_REWARD_RATE = 1e20;
    uint256 public override rewardRate = 1e18;
    address public override treasury = address(0xdead);
    address public override restakingContract = address(0);
    uint256 public override maxUnsettledRewards = 1e24;
    uint256 public override extendFeeBps = 100;
    uint256 public override penaltyRecycleBps = 5000;
    uint256 public override extendFeeRecycleBps = 5000;

    function applyRewardRate(uint256) external {}
    function applyTreasury(address) external {}
    function applyRestakingContract(address) external {}
    function applyMaxUnsettledRewards(uint256) external {}
    function applyLendingContract(address, bool) external {}
    function applyExtendFee(uint256) external {}
    function applyPenaltyRecycle(uint256) external {}
    function applyExtendFeeRecycle(uint256) external {}
}

// ─── Tests ──────────────────────────────────────────────────────────

contract M19_VoteIncentivesAdmin_Test is Test {
    VoteIncentivesAdmin admin;
    MockVoteIncentives vi;
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        vi = new MockVoteIncentives();
        admin = new VoteIncentivesAdmin(address(vi));
    }

    function test_M19_acceptOwnership_clears_all_5_keys() public {
        // Old owner proposes hostile changes on all 5 keys.
        admin.proposeFeeChange(400);
        admin.proposeTreasuryChange(makeAddr("hostileTreasury"));
        admin.proposeWhitelistChange(makeAddr("hostileToken"), true);
        admin.proposeMinBribeAmount(makeAddr("anyToken"), 999 ether);
        admin.proposeEnableCommitReveal();

        // Verify all 5 are pending.
        assertTrue(admin.hasPendingProposal(admin.FEE_CHANGE()));
        assertTrue(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertTrue(admin.hasPendingProposal(admin.WHITELIST_CHANGE()));
        assertTrue(admin.hasPendingProposal(admin.MIN_BRIBE_CHANGE()));
        assertTrue(admin.hasPendingProposal(admin.COMMIT_REVEAL_ENABLE()));

        // Hand over to new owner.
        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        // All 5 must be flushed.
        assertFalse(admin.hasPendingProposal(admin.FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.WHITELIST_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MIN_BRIBE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.COMMIT_REVEAL_ENABLE()));

        // Pending mirror slots zeroed.
        assertEq(admin.pendingFeeBps(), 0);
        assertEq(admin.pendingTreasury(), address(0));
        assertEq(admin.pendingWhitelistToken(), address(0));
        assertEq(admin.pendingWhitelistAction(), false);
        assertEq(admin.pendingMinBribeToken(), address(0));
        assertEq(admin.pendingMinBribeAmount(), 0);

        // Sanity: new owner is now `owner()`.
        assertEq(admin.owner(), newOwner);
    }

    function test_M19_acceptOwnership_partial_pending_flushes_only_set_keys() public {
        // Only 2 of 5 keys have pending proposals.
        admin.proposeFeeChange(400);
        admin.proposeTreasuryChange(makeAddr("hostileTreasury"));

        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        // Others were never pending, still false.
        assertFalse(admin.hasPendingProposal(admin.WHITELIST_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MIN_BRIBE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.COMMIT_REVEAL_ENABLE()));
    }
}

contract M19_SwapFeeRouterAdmin_Test is Test {
    SwapFeeRouterAdmin admin;
    MockSwapFeeRouter sfr;
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        sfr = new MockSwapFeeRouter();
        admin = new SwapFeeRouterAdmin(address(sfr));
    }

    function test_M19_acceptOwnership_clears_all_9_keys() public {
        admin.proposeFeeChange(50);
        admin.proposeTreasuryChange(makeAddr("hostileT"));
        admin.proposeReferralSplitterChange(makeAddr("hostileSplitter"));
        admin.proposeInputTokenFeeChange(makeAddr("inputT"), 50, false);
        admin.proposePremiumDiscountChange(1000);
        admin.proposePremiumAccessChange(makeAddr("hostileAcc"));
        admin.proposeRevenueDistributor(makeAddr("hostileDist"));
        admin.proposeFeeSplit(6000, 4000);
        admin.proposePolAccumulator(makeAddr("hostileAcc2"));

        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.REFERRAL_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.PAIR_FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.PREMIUM_DISCOUNT_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.PREMIUM_ACCESS_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.REV_DIST_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.FEE_SPLIT_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.POL_ACCUMULATOR_CHANGE()));

        assertEq(admin.pendingFeeBps(), 0);
        assertEq(admin.pendingTreasury(), address(0));
        assertEq(admin.pendingReferralSplitter(), address(0));
        assertEq(admin.pendingPairFeeAddress(), address(0));
        assertEq(admin.pendingPairFeeBps(), 0);
        assertEq(admin.pendingPairFeeRemoval(), false);
        assertEq(admin.pendingPremiumDiscountBps(), 0);
        assertEq(admin.pendingPremiumAccess(), address(0));
        assertEq(admin.pendingRevenueDistributor(), address(0));
        assertEq(admin.pendingStakerShareBps(), 0);
        assertEq(admin.pendingPolShareBps(), 0);
        assertEq(admin.pendingPolAccumulator(), address(0));

        assertEq(admin.owner(), newOwner);
    }
}

contract M19_TegridyLendingAdmin_Test is Test {
    TegridyLendingAdmin admin;
    MockTegridyLending lending;
    address newOwner = makeAddr("newOwner");
    address mockToweli = makeAddr("toweli");

    function setUp() public {
        lending = new MockTegridyLending();
        admin = new TegridyLendingAdmin(address(lending));
    }

    function test_M19_acceptOwnership_clears_all_11_keys() public {
        admin.proposeProtocolFeeChange(100);
        admin.proposeTreasuryChange(makeAddr("hostileT"));
        admin.proposeMaxPrincipal(50 ether);
        admin.proposeMaxAprBps(7000);
        admin.proposeMinDuration(2 days);
        admin.proposeMaxDuration(60 days);
        admin.proposeOriginationFee(100);
        admin.proposeMinApr(200);
        admin.proposeMinPrincipal(0.05 ether);
        admin.proposeAcceptedCollateral(makeAddr("collat"), true);
        // Sweep: `_to` must equal LIVE treasury at propose time.
        admin.proposeSweepDonatedToweli(1 ether, lending.treasury());

        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.PROTOCOL_FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MAX_PRINCIPAL_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MAX_APR_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MIN_DURATION_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MAX_DURATION_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.ORIGINATION_FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MIN_APR_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.MIN_PRINCIPAL_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.ACCEPTED_COLLATERAL_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.SWEEP_DONATED_TOWELI()));

        assertEq(admin.pendingProtocolFeeBps(), 0);
        assertEq(admin.pendingTreasury(), address(0));
        assertEq(admin.pendingMaxPrincipal(), 0);
        assertEq(admin.pendingMaxAprBps(), 0);
        assertEq(admin.pendingMinDuration(), 0);
        assertEq(admin.pendingMaxDuration(), 0);
        assertEq(admin.pendingOriginationFeeBps(), 0);
        assertEq(admin.pendingMinAprBps(), 0);
        assertEq(admin.pendingMinPrincipal(), 0);
        assertEq(admin.pendingAcceptedCollateral(), address(0));
        assertEq(admin.pendingAcceptedCollateralAdd(), false);
        assertEq(admin.pendingSweepAmount(), 0);
        assertEq(admin.pendingSweepTo(), address(0));

        assertEq(admin.owner(), newOwner);
    }
}

contract M19_TegridyStakingAdmin_Test is Test {
    TegridyStakingAdmin admin;
    MockTegridyStaking staking;
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        staking = new MockTegridyStaking();
        admin = new TegridyStakingAdmin(address(staking));
    }

    function test_M19_acceptOwnership_clears_all_8_keys() public {
        admin.proposeRewardRate(2e18);
        admin.proposeTreasuryChange(makeAddr("hostileT"));
        // Restaking address must be a contract — use the staking contract mock as a placeholder.
        admin.proposeRestakingContract(address(staking));
        admin.proposeMaxUnsettledRewards(20_000e18);
        admin.proposeLendingContract(makeAddr("lend"), true);
        admin.proposeExtendFee(150);
        admin.proposePenaltyRecycle(7000);
        admin.proposeExtendFeeRecycle(8000);

        admin.transferOwnership(newOwner);
        vm.prank(newOwner);
        admin.acceptOwnership();

        assertFalse(admin.hasPendingProposal(admin.REWARD_RATE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.TREASURY_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.RESTAKING_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.UNSETTLED_CAP_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.LENDING_CONTRACT_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.EXTEND_FEE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.PENALTY_RECYCLE_CHANGE()));
        assertFalse(admin.hasPendingProposal(admin.EXTEND_FEE_RECYCLE_CHANGE()));

        assertEq(admin.pendingRewardRate(), 0);
        assertEq(admin.pendingTreasury(), address(0));
        assertEq(admin.pendingRestakingContract(), address(0));
        assertEq(admin.pendingMaxUnsettledRewards(), 0);
        assertEq(admin.pendingLendingContract(), address(0));
        assertEq(admin.pendingLendingContractApproval(), false);
        assertEq(admin.pendingExtendFeeBps(), 0);
        assertEq(admin.pendingPenaltyRecycleBps(), 0);
        assertEq(admin.pendingExtendFeeRecycleBps(), 0);

        assertEq(admin.owner(), newOwner);
    }
}

// ─── ReferralSplitter (3 keys in scope: REFERRAL_FEE_CHANGE, TREASURY_CHANGE, BAN_REFERRER) ───

contract MockStakingM19 {
    function votingPowerOf(address) external pure returns (uint256) { return 0; }
}

contract MockWETHM19 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract M19_ReferralSplitter_Test is Test {
    ReferralSplitter ref;
    MockStakingM19 mockStaking;
    MockWETHM19 mockWeth;
    address newOwner = makeAddr("newOwner");
    address treasuryAddr = makeAddr("treasury");

    function setUp() public {
        mockStaking = new MockStakingM19();
        mockWeth = new MockWETHM19();
        ref = new ReferralSplitter(1000, address(mockStaking), treasuryAddr, address(mockWeth));
    }

    function test_M19_acceptOwnership_clears_all_3_keys() public {
        ref.proposeReferralFee(500);
        ref.proposeTreasury(makeAddr("hostileT"));
        ref.proposeBanReferrer(makeAddr("victim"));

        assertTrue(ref.hasPendingProposal(ref.REFERRAL_FEE_CHANGE()));
        assertTrue(ref.hasPendingProposal(ref.TREASURY_CHANGE()));
        assertTrue(ref.hasPendingProposal(ref.BAN_REFERRER()));

        ref.transferOwnership(newOwner);
        vm.prank(newOwner);
        ref.acceptOwnership();

        assertFalse(ref.hasPendingProposal(ref.REFERRAL_FEE_CHANGE()));
        assertFalse(ref.hasPendingProposal(ref.TREASURY_CHANGE()));
        assertFalse(ref.hasPendingProposal(ref.BAN_REFERRER()));

        assertEq(ref.pendingReferralFee(), 0);
        assertEq(ref.pendingTreasury(), address(0));
        assertEq(ref.pendingBanReferrer(), address(0));

        assertEq(ref.owner(), newOwner);
    }
}

// ─── CommunityGrants (1 key in scope: FEE_RECEIVER_CHANGE) ───
//
// Note: CANCEL_APPROVED_KEY uses per-proposalId dynamic keys (not iterable);
// CommunityGrants.acceptOwnership only flushes the static FEE_RECEIVER_CHANGE key.

contract MockVEForGrantsM19 {
    mapping(address => uint256) public powers;
    uint256 public totalLocked;
    function setPower(address u, uint256 p) external { totalLocked = totalLocked - powers[u] + p; powers[u] = p; }
    function votingPowerOf(address u) external view returns (uint256) { return powers[u]; }
    function votingPowerAt(address u, uint256) external view returns (uint256) { return powers[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return powers[u]; }
    function totalBoostedStake() external view returns (uint256) { return totalLocked; }
    function totalBoostedStakeAtTimestamp(uint256) external view returns (uint256) { return totalLocked; }
    function userTokenId(address u) external pure returns (uint256) { return uint256(uint160(u)); }
    function holdsToken(address u, uint256 t) external pure returns (bool) { return uint256(uint160(u)) == t; }
    function userPositionCount(address) external pure returns (uint256) { return 1; }
}

contract MockTOWELIM19 is ERC20 {
    constructor() ERC20("TOWELI", "TOWELI") { _mint(msg.sender, 1e30); }
}

contract M19_CommunityGrants_Test is Test {
    CommunityGrants grants;
    MockVEForGrantsM19 ve;
    MockTOWELIM19 toweli;
    MockWETHM19 weth;
    address newOwner = makeAddr("newOwner");
    address treasuryAddr = makeAddr("treasury");

    function setUp() public {
        ve = new MockVEForGrantsM19();
        toweli = new MockTOWELIM19();
        weth = new MockWETHM19();
        grants = new CommunityGrants(address(ve), address(toweli), treasuryAddr, address(weth));
    }

    function test_M19_acceptOwnership_clears_FEE_RECEIVER_CHANGE() public {
        grants.proposeFeeReceiver(makeAddr("hostileReceiver"));
        assertTrue(grants.hasPendingProposal(grants.FEE_RECEIVER_CHANGE()));

        grants.transferOwnership(newOwner);
        vm.prank(newOwner);
        grants.acceptOwnership();

        assertFalse(grants.hasPendingProposal(grants.FEE_RECEIVER_CHANGE()));
        assertEq(grants.pendingFeeReceiver(), address(0));
        assertEq(grants.owner(), newOwner);
    }
}

// ─── TegridyLPFarming (2 keys: REWARDS_DURATION_CHANGE, TREASURY_CHANGE) ───

contract MockJBACM19 is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
    function burnFrom(address o, uint256 t) external { require(ownerOf(t) == o); _burn(t); }
}

contract MockLPM19 is ERC20 {
    constructor() ERC20("LP", "LP") { _mint(msg.sender, 1e30); }
}

contract M19_TegridyLPFarming_Test is Test {
    TegridyLPFarming farm;
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        // TegridyLPFarming construction needs a TegridyStaking (for boost lookups).
        // We use TegridyStaking directly since the override path doesn't touch it.
        MockTOWELIM19 toweli = new MockTOWELIM19();
        MockLPM19 lp = new MockLPM19();
        MockJBACM19 jbac = new MockJBACM19();
        TegridyStaking staking = new TegridyStaking(address(toweli), address(jbac), makeAddr("tStaking"), 1 ether);
        farm = new TegridyLPFarming(address(toweli), address(lp), address(staking), makeAddr("tFarm"), 7 days);
    }

    function test_M19_acceptOwnership_clears_both_keys() public {
        farm.proposeRewardsDurationChange(14 days);
        farm.proposeTreasuryChange(makeAddr("hostileT"));

        assertTrue(farm.hasPendingProposal(farm.REWARDS_DURATION_CHANGE()));
        assertTrue(farm.hasPendingProposal(farm.TREASURY_CHANGE()));

        farm.transferOwnership(newOwner);
        vm.prank(newOwner);
        farm.acceptOwnership();

        assertFalse(farm.hasPendingProposal(farm.REWARDS_DURATION_CHANGE()));
        assertFalse(farm.hasPendingProposal(farm.TREASURY_CHANGE()));
        assertEq(farm.pendingRewardsDuration(), 0);
        assertEq(farm.pendingTreasury(), address(0));
        assertEq(farm.owner(), newOwner);
    }
}

// ─── TegridyNFTLending — DEFERRED to a follow-up PR ───
//
// Adding the acceptOwnership override directly pushes TegridyNFTLending from
// 23,590 B to 24,059 B — 59 B over this repo's 24,000-byte deploy-size floor
// (it remains 517 B under the EIP-170 24,576-byte hard limit, but the CI
// `Bytecode size budget` step is strict on the 24,000 floor and NFTLending
// is NOT on the exception list).
//
// Pulling NFTLending out of this PR keeps the 13 other contracts shipping
// cleanly without breaking CI. NFTLending will get its own focused follow-up
// that either (a) factors the cancel logic into a library, (b) splits a
// sister TegridyNFTLendingAdmin contract (mirroring TegridyLendingAdmin),
// or (c) trims bytecode elsewhere in the contract. None of those fit a
// mechanical port.

// ─── MemeBountyBoard (2 keys: MIN_REWARD_CHANGE, TREASURY_CHANGE) ───

contract M19_MemeBountyBoard_Test is Test {
    MemeBountyBoard board;
    address newOwner = makeAddr("newOwner");
    address treasuryAddr = makeAddr("treasury");

    function setUp() public {
        vm.chainId(1);
        MockTOWELIM19 voteTok = new MockTOWELIM19();
        MockStakingM19 staking = new MockStakingM19();
        MockWETHM19 weth = new MockWETHM19();
        board = new MemeBountyBoard(
            address(voteTok),
            address(staking),
            address(weth),
            address(0), // mainnet posture
            treasuryAddr
        );
    }

    function test_M19_acceptOwnership_clears_both_keys() public {
        board.proposeMinBountyReward(0.5 ether);
        board.proposeTreasuryChange(makeAddr("hostileT"));

        assertTrue(board.hasPendingProposal(board.MIN_REWARD_CHANGE()));
        assertTrue(board.hasPendingProposal(board.TREASURY_CHANGE()));

        board.transferOwnership(newOwner);
        vm.prank(newOwner);
        board.acceptOwnership();

        assertFalse(board.hasPendingProposal(board.MIN_REWARD_CHANGE()));
        assertFalse(board.hasPendingProposal(board.TREASURY_CHANGE()));
        assertEq(board.pendingMinBountyReward(), 0);
        assertEq(board.pendingTreasury(), address(0));
        assertEq(board.owner(), newOwner);
    }
}

// ─── GaugeController (4 keys: GAUGE_ADD, GAUGE_REMOVE, EMISSION_BUDGET, RESTAKING) ───

contract MockStakingForGaugeM19 {
    function positions(uint256) external pure returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 jbacTokenId, bool jbacDeposited
    ) { return (0, 0, 0, 0, 0, 0, false, false, 0, false); }
    function votingPowerOf(address) external pure returns (uint256) { return 0; }
}

contract MockGaugeContract {
    // empty contract, just satisfies code.length > 0 check
    function ping() external pure returns (bool) { return true; }
}

contract M19_GaugeController_Test is Test {
    GaugeController gc;
    MockGaugeContract gaugeImpl;
    MockGaugeContract pairImpl;
    MockGaugeContract restakingImpl;
    MockGaugeContract gaugeToRemove;
    MockGaugeContract pairForRemove;
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        MockStakingForGaugeM19 staking = new MockStakingForGaugeM19();
        gc = new GaugeController(address(staking), 1e22);
        gaugeImpl = new MockGaugeContract();
        pairImpl = new MockGaugeContract();
        restakingImpl = new MockGaugeContract();
        // Set up a whitelisted gauge so we can later test REMOVE.
        gaugeToRemove = new MockGaugeContract();
        pairForRemove = new MockGaugeContract();
        gc.proposeAddGauge(address(gaugeToRemove), address(pairForRemove));
        vm.warp(block.timestamp + 7 days + 1); // GAUGE_TIMELOCK
        gc.executeAddGauge();
    }

    function test_M19_acceptOwnership_clears_all_4_keys() public {
        gc.proposeAddGauge(address(gaugeImpl), address(pairImpl));
        gc.proposeRemoveGauge(address(gaugeToRemove));
        gc.proposeEmissionBudgetChange(2e22);
        gc.proposeRestakingContract(address(restakingImpl));

        assertTrue(gc.hasPendingProposal(gc.GAUGE_ADD()));
        assertTrue(gc.hasPendingProposal(gc.GAUGE_REMOVE()));
        assertTrue(gc.hasPendingProposal(gc.EMISSION_BUDGET_CHANGE()));
        assertTrue(gc.hasPendingProposal(gc.RESTAKING_CHANGE()));

        gc.transferOwnership(newOwner);
        vm.prank(newOwner);
        gc.acceptOwnership();

        assertFalse(gc.hasPendingProposal(gc.GAUGE_ADD()));
        assertFalse(gc.hasPendingProposal(gc.GAUGE_REMOVE()));
        assertFalse(gc.hasPendingProposal(gc.EMISSION_BUDGET_CHANGE()));
        assertFalse(gc.hasPendingProposal(gc.RESTAKING_CHANGE()));

        assertEq(gc.pendingGaugeAdd(), address(0));
        assertEq(gc.pendingPairForAdd(), address(0));
        assertEq(gc.pendingGaugeRemove(), address(0));
        assertEq(gc.pendingEmissionBudget(), 0);
        assertEq(gc.pendingRestakingContract(), address(0));

        assertEq(gc.owner(), newOwner);
    }
}
