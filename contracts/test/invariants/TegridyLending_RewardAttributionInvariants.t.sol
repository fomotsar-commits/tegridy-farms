// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../../src/TegridyStaking.sol";
import "../../src/TegridyStakingAdmin.sol";
import "../../src/TegridyLending.sol";
import "../../src/TegridyLendingAdmin.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";

/// @title TegridyLending — cross-loan reward-attribution invariants
///
/// @notice Per the project's threat-priority map (2026-05-16, Wave-2):
///         "Cross-contract reward-attribution (Lending + Staking + Restaking)
///          is the regression-prone surface; freeze the API and require
///          dedicated audit pass on any future change to loanRewardsSnapshot
///          / escrowRewardsOwed / _clearPosition."
///
///         The existing PASS7_LENDING_03 + FRESH2026_F_LD_CrossLoanPullThenCap
///         tests exercise end-to-end ATTACK scenarios. This file complements
///         them with FOCUSED INVARIANT PINS — small, named assertions that
///         a future regression PR can't ride past unnoticed.
///
///         If you find yourself editing this file because an assertion broke,
///         STOP and re-read the original audit (PASS7-LENDING-03 / 2026-05-16
///         M1 / D-DR-L1) before touching the snapshot / escrow accounting.
///         These invariants are the wall, not just the wallpaper.
///
/// Invariants pinned here:
///   (I1) loanRewardsSnapshot[loanId] == staking.unsettledRewardsByTokenId(tokenId)
///        EXACTLY at the moment of acceptOffer (no off-by-one, no transformation).
///   (I2) loanRewardsSnapshot[loanId] SURVIVES through the full settlement
///        lifecycle (repay + pullEscrowRewards). A regression that cleared
///        or overwrote the slot at settlement would break the priorShare /
///        myShare split on any later state inspection.
///   (I3) On a deferred settlement (staking paused), escrowRewardsOwed[loanId]
///        is incremented by the per-loan delta (current - snapshot), NOT by the
///        gross per-tokenId bucket.
///   (I4) totalEscrowRewardsOwed == sum(escrowRewardsOwed[i]) — at all times.
///   (I5) pullEscrowRewards decrements escrowRewardsOwed[loanId] by exactly
///        the paid amount; totalEscrowRewardsOwed by the same delta.
// ─────────────────────────────────────────────────────────────────────────────

contract LDInv_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract LDInv_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract LDInv_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract LDInv_Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0; token1 = _t1; reserve0 = _r0; reserve1 = _r1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

contract TegridyLending_RewardAttributionInvariants is Test {
    LDInv_Toweli toweli;
    LDInv_JBAC jbac;
    LDInv_WETH weth;
    LDInv_Pair pair;
    TegridyTWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin stakingAdmin;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address dan = makeAddr("dan");

    uint256 aliceTokenId;

    function setUp() public {
        // SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        toweli = new LDInv_Toweli();
        jbac = new LDInv_JBAC();
        weth = new LDInv_WETH();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        // High reward rate so credits are observable in a short test horizon.
        toweli.mint(address(staking), 10_000_000 ether);
        toweli.approve(address(staking), 1_000_000 ether);
        staking.notifyRewardAmount(1_000_000 ether);

        twap = new TegridyTWAP(address(this), address(0));
        pair = new LDInv_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        stakingAdmin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        stakingAdmin.executeLendingContract();

        toweli.transfer(alice, 100_000 ether);

        // Alice stakes (long lock so boostedAmount stays positive throughout).
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // 24h transfer cooldown.
        skip(25 hours);
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(dan, 100 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /// @dev Open a standard loan and return its id. Snapshots aliceTokenId
    ///      → loanRewardsSnapshot at the moment of acceptOffer.
    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(dan);
        uint256 offer = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(staking), 5000 ether, 0
        );
        vm.prank(alice);
        loanId = lending.acceptOffer(offer, aliceTokenId);
    }

    // ─── Invariants ──────────────────────────────────────────────────

    /// @notice (I1) + (I2): snapshot is the exact `unsettledRewardsByTokenId`
    ///         reading at acceptOffer, and survives through repay + pull so
    ///         the priorShare / myShare split remains computable.
    function test_invariant_loanRewardsSnapshot_exactCopyAndSurvives() public {
        // Open the loan and capture the snapshot. acceptOffer's transferFrom
        // triggers TegridyStaking._settleRewardsOnTransfer which credits the
        // per-tokenId bucket; the snapshot is captured immediately afterward
        // (TegridyLending.sol:1191). Read the staking-side value RIGHT AFTER
        // open so we observe the same post-transfer state the contract did.
        uint256 loanId = _openLoan();
        uint256 perTokenIdAtOpen = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 snapshot = lending.loanRewardsSnapshot(loanId);

        // (I1) Snapshot equals exactly the value the staking contract reported
        //      at the moment of acceptOffer. NO transformation, NO offset.
        assertEq(
            snapshot,
            perTokenIdAtOpen,
            "I1: loanRewardsSnapshot[loanId] must equal unsettledRewardsByTokenId(tokenId) at acceptOffer"
        );

        // (I2) Snapshot survives through the full settlement lifecycle
        //      (repay → pull). A regression that cleared / overwrote the
        //      slot at settlement would break the priorShare / myShare split
        //      on any later state inspection. Drive the full lifecycle.
        //      `skip(3 days)` AFTER open is essential — it lets reward-per-
        //      token accumulate during the loan window so the close-transfer
        //      credits a non-zero `myShare = current - snapshot`. Without it
        //      the deferred-settlement path books 0 and pullEscrowRewards
        //      reverts NoEscrowRewards.
        skip(3 days);
        staking.pause(); // force the deferred-settlement path on close
        uint256 repay = 1 ether + 0.05 ether;
        vm.deal(alice, repay);
        vm.prank(alice);
        lending.repayLoan{value: repay}(loanId);

        // After repay (with deferral) the snapshot must still equal the
        // acceptOffer-time value — proves repay does not clear it.
        assertEq(
            lending.loanRewardsSnapshot(loanId),
            snapshot,
            "I2a: snapshot survives repay (deferred-settlement path)"
        );

        // After pullEscrowRewards the snapshot must still equal the
        // acceptOffer-time value — proves pull does not clear it either.
        staking.unpause();
        skip(1 hours);
        vm.prank(alice);
        lending.pullEscrowRewards(loanId);
        assertEq(
            lending.loanRewardsSnapshot(loanId),
            snapshot,
            "I2b: snapshot survives pullEscrowRewards"
        );
    }

    /// @notice (I3) + (I4) + (I5): deferred settlement books the per-loan
    ///         delta (not the gross bucket); the sum invariant holds; pull
    ///         decrements exactly.
    function test_invariant_escrowRewardsOwed_andSumInvariant() public {
        uint256 loanId = _openLoan();
        uint256 snapshot = lending.loanRewardsSnapshot(loanId);

        // Accrue rewards during the loan, then PAUSE staking so the two-phase
        // pull at repay reverts and the deferred path runs.
        skip(3 days);
        staking.pause();

        // Pre-repay state.
        uint256 totalEscrowBefore = lending.totalEscrowRewardsOwed();
        uint256 owedBefore = lending.escrowRewardsOwed(loanId);
        assertEq(owedBefore, 0, "pre-defer: escrowRewardsOwed[loanId] starts at 0");

        // Repay — paused staking forces the deferral.
        uint256 repay = 1 ether + 0.05 ether;
        vm.deal(alice, repay);
        vm.prank(alice);
        lending.repayLoan{value: repay}(loanId);

        // After deferral the per-tokenId bucket holds the gross credits
        // (priorShare + myShare). escrowRewardsOwed must be incremented by
        // ONLY the per-loan share (myShare = current - snapshot), not the
        // gross bucket.
        uint256 perTokenIdAfter = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 owedAfter = lending.escrowRewardsOwed(loanId);
        uint256 totalEscrowAfter = lending.totalEscrowRewardsOwed();

        // (I3) Deferred booking equals (per-tokenId gross) - (snapshot at open).
        //      The snapshot is the "prior holder's slice" — must not be
        //      credited to this loan's deferral.
        assertGt(owedAfter, 0, "I3: deferred path must populate escrowRewardsOwed");
        assertEq(
            owedAfter,
            perTokenIdAfter - snapshot,
            "I3: escrowRewardsOwed[loanId] == per-tokenId-at-defer minus snapshot-at-open"
        );

        // (I4) Sum invariant after the deferral.
        assertEq(
            totalEscrowAfter,
            totalEscrowBefore + owedAfter,
            "I4: totalEscrowRewardsOwed sum invariant must hold across the deferral"
        );

        // Unpause + warp past any cooldown so pullEscrowRewards is callable.
        staking.unpause();
        skip(1 hours);

        // Capture pre-pull state.
        uint256 aliceBalanceBefore = toweli.balanceOf(alice);
        uint256 owedBeforePull = lending.escrowRewardsOwed(loanId);
        uint256 totalBeforePull = lending.totalEscrowRewardsOwed();

        // Pull.
        vm.prank(alice);
        lending.pullEscrowRewards(loanId);

        uint256 paid = toweli.balanceOf(alice) - aliceBalanceBefore;
        uint256 owedAfterPull = lending.escrowRewardsOwed(loanId);
        uint256 totalAfterPull = lending.totalEscrowRewardsOwed();

        // (I5) Decrement equals exactly the paid amount on both per-loan and
        //      cumulative slots. No over-decrement, no under-decrement.
        assertGt(paid, 0, "I5 pre: pull must transfer something");
        assertEq(
            owedBeforePull - owedAfterPull,
            paid,
            "I5a: escrowRewardsOwed[loanId] decrement must equal paid amount"
        );
        assertEq(
            totalBeforePull - totalAfterPull,
            paid,
            "I5b: totalEscrowRewardsOwed decrement must equal paid amount (sum invariant preserved)"
        );
    }
}
