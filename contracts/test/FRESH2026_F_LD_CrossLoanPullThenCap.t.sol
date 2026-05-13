// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title FRESH-2026 F-LD — TegridyLending cross-loan pull-then-cap
/// @notice POST-FIX REGRESSION (commit 2deb259).
///
///         BUG (pre-fix):
///         `pullEscrowRewards(loanId)` called
///             staking.claimUnsettledForTokenId(tokenId, recipient)
///         which transferred the FULL per-tokenId bucket directly to
///         `recipient`. The staking-side bucket has NO per-loan
///         attribution — it accumulates kicks for whichever loan was
///         active when the kick fired. When sequential loans on the
///         same tokenId both deferred (e.g. paused staking at each
///         settlement booked the deferred slice into
///         `escrowRewardsOwed[loanId]` but left the actual TOWELI in the
///         staking-side bucket), the FIRST claimant called
///         `pullEscrowRewards` and walked away with BOTH loans' slices
///         (X+Y). The second claimant's pullEscrowRewards then reverted
///         `NoEscrowRewards` because the bucket was empty AND the lending
///         contract's TOWELI balance was zero (pre-fix never lands a
///         spillover here).
///
///         FIX (TegridyLending.sol:2138-2153):
///         Pull the staking-side bucket to `address(this)` (lending),
///         then `transfer(recipient, min(received, owed[loanId]))`.
///         Excess `received - owed` stays in lending's TOWELI balance
///         and feeds the legacy pro-rata path for sibling loan claims.
///         Pattern of record: Aave V3 pull-then-cap (recipient is the
///         consumer, not the source).
///
///         POST-FIX VALIDATION (this test):
///         (1) Alice repays loan A while staking is paused. Two-phase
///             pull defers; `escrowRewardsOwed[loanA] += K1`.
///         (2) Alice transfers tokenId to Bob; Bob takes loan B.
///         (3) Bob repays while staking is paused. The bucket now
///             contains K1 (from A) + K2 (from B); Bob's repay logs
///             K2 deferral via the snapshot/delta math
///             (`escrowRewardsOwed[loanB] += K2`).
///         (4) Alice calls `pullEscrowRewards(loanA)` FIRST. POST-FIX:
///             pull-to-self drains K1+K2 to lending; lending forwards
///             min(K1+K2, K1) = K1 to Alice. Excess K2 stays at lending.
///         (5) Bob calls `pullEscrowRewards(loanB)`. POST-FIX: bucket
///             empty (Alice drained it), but lending's TOWELI balance
///             is K2; legacy pro-rata path pays Bob ~K2.
///         Total drained: K1 (Alice) + K2 (Bob) = bucket total. PRE-FIX,
///         step (4) would have given Alice K1+K2 and step (5) reverted.
///
///         This test extends the canonical PASS7-LENDING-03 setup
///         (PASS7_LENDING_03.t.sol:107-176) — same Toweli/JBAC/WETH/
///         TWAP/Pair/Staking/Lending wiring.

contract F_LD_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract F_LD_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract F_LD_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract F_LD_Pair {
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

contract FRESH2026_F_LD_CrossLoanPullThenCapTest is Test {
    F_LD_Toweli toweli;
    F_LD_JBAC jbac;
    F_LD_WETH weth;
    F_LD_Pair pair;
    TegridyTWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address dan = makeAddr("dan");

    uint256 aliceTokenId;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        toweli = new F_LD_Toweli();
        jbac = new F_LD_JBAC();
        weth = new F_LD_WETH();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        toweli.mint(address(staking), 10_000_000 ether);
        toweli.approve(address(staking), 1_000_000 ether);
        staking.notifyRewardAmount(1_000_000 ether);

        // Bump maxUnsettledRewards from default (100k) to 10M so the long
        // Alice-side accrual + K1 (lending) + K2 (lending) all fit. The
        // F-LD bug + fix are orthogonal to the L-06 cap; we want to test
        // the cross-loan attribution math in isolation.
        admin.proposeMaxUnsettledRewards(10_000_000 ether);
        skip(48 hours + 1);
        admin.executeMaxUnsettledRewards();

        twap = new TegridyTWAP(address(this), address(0));
        pair = new F_LD_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        admin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        admin.executeLendingContract();

        toweli.transfer(alice, 100_000 ether);
        toweli.transfer(bob, 100_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        skip(25 hours);
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(dan, 100 ether);
    }

    /// @notice POST-FIX REGRESSION: validates the F-LD pull-then-cap fix.
    ///         Pre-fix, Alice's first call to `pullEscrowRewards(loanA)`
    ///         drained BOTH her K1 deferred slice AND Bob's K2 deferred
    ///         slice (sequential loans on the same tokenId), leaving Bob
    ///         with `NoEscrowRewards` revert. Post-fix, the pull-to-self
    ///         pattern caps Alice's recovery at K1 and leaves K2 in
    ///         lending's TOWELI balance for Bob's claim via the legacy
    ///         pro-rata path.
    function test_F_LD_crossLoan_pullThenCap_caps_first_claimant() public {
        // ── PHASE 1: Alice opens loan-A. ────────────────────────────────
        vm.prank(dan);
        uint256 offerA = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(staking), 5000 ether, 0
        );
        vm.prank(alice);
        uint256 loanA = lending.acceptOffer(offerA, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), address(lending), "loan A: NFT escrowed");

        // Skip part of the loan period to accumulate reward-per-token.
        skip(3 days);

        // PAUSE STAKING — precondition for two-phase pull deferral.
        staking.pause();

        // Alice repays. The repay path:
        //   - try claimUnsettledForTokenId(tokenId, this) → REVERTS (paused) → defer
        //   - staking.transferFrom(this, alice, tokenId) → settle hook credits
        //     unsettledRewardsByTokenId[X] += K1 and unsettledRewards[lending] += K1
        //   - try claimUnsettledForTokenId(tokenId, this) → REVERTS (paused) → defer
        //   - the defer path then writes escrowRewardsOwed[loanA] += K1
        //     (per the snapshot+delta math in repayLoan lines 1385-1391)
        uint256 repayA = 1 ether + 0.05 ether;
        vm.deal(alice, repayA);
        vm.prank(alice);
        lending.repayLoan{value: repayA}(loanA);

        assertEq(staking.ownerOf(aliceTokenId), alice, "loan A: NFT returned to alice");

        uint256 perTokenIdAfterA = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 owedA = lending.escrowRewardsOwed(loanA);
        assertGt(perTokenIdAfterA, 0, "loan A: per-tokenId credited via _settleRewardsOnTransfer");
        assertGt(owedA, 0, "loan A: escrowRewardsOwed booked at deferral");

        // ── PHASE 2: Unpause briefly to allow Alice → Bob transfer. ────
        staking.unpause();

        // Wait out the 24h transfer cooldown (acceptOffer + repay reset it).
        skip(25 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, bob, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), bob, "Alice transferred to Bob");

        // ── PHASE 3: Bob opens loan-B and repays during a fresh pause. ─
        vm.prank(bob);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(dan, 1 ether);
        vm.prank(dan);
        uint256 offerB = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(staking), 5000 ether, 0
        );
        vm.prank(bob);
        uint256 loanB = lending.acceptOffer(offerB, aliceTokenId);

        skip(3 days);

        // PAUSE STAKING AGAIN — second deferral for loan B.
        staking.pause();

        uint256 repayB = 1 ether + 0.05 ether;
        vm.deal(bob, repayB);
        vm.prank(bob);
        lending.repayLoan{value: repayB}(loanB);

        uint256 perTokenIdAfterB = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 owedB = lending.escrowRewardsOwed(loanB);
        emit log_named_uint("perTokenIdAfterA (K1 only)", perTokenIdAfterA);
        emit log_named_uint("perTokenIdAfterB (K1+K2)", perTokenIdAfterB);
        emit log_named_uint("owedA (Alice's deferred K1)", owedA);
        emit log_named_uint("owedB (Bob's deferred K2)", owedB);
        assertGt(perTokenIdAfterB, perTokenIdAfterA, "bucket grew by K2 during loan B");
        assertGt(owedB, 0, "loan B: escrowRewardsOwed booked at deferral");

        // ── PHASE 4: Unpause so the per-tokenId pull can succeed. ──────
        staking.unpause();

        // ── CRITICAL CHECKPOINT — pre-pullEscrowRewards state ─────────
        uint256 lendingToweliBefore = toweli.balanceOf(address(lending));
        uint256 bucketBefore = staking.unsettledRewardsByTokenId(aliceTokenId);
        emit log_named_uint("bucket pre-pull (K1+K2)", bucketBefore);
        emit log_named_uint("lending toweli pre-pull", lendingToweliBefore);
        emit log_named_uint("escrowRewardsOwed[loanA]", owedA);
        emit log_named_uint("escrowRewardsOwed[loanB]", owedB);

        // ── PHASE 5: Alice calls pullEscrowRewards(loanA) FIRST. ───────
        // POST-FIX: pull-to-self drains the bucket to lending; lending
        // transfers min(received, owedA) = ~owedA to Alice, leaving the
        // excess parked in lending's balance for Bob's eventual claim.
        uint256 aliceToweliBeforePull = toweli.balanceOf(alice);
        vm.prank(alice);
        lending.pullEscrowRewards(loanA);
        uint256 aliceReceived = toweli.balanceOf(alice) - aliceToweliBeforePull;

        emit log_named_uint("alice received", aliceReceived);
        emit log_named_uint("lending toweli after alice pull", toweli.balanceOf(address(lending)));
        emit log_named_uint("bucket after alice pull", staking.unsettledRewardsByTokenId(aliceTokenId));

        // Alice's recovery is approximately owedA (small slippage due to
        // the snapshot/delta arithmetic + reward-rate division rounding).
        assertGt(aliceReceived, 0, "FIX: alice received non-zero K1");
        // Pre-fix, alice received K1+K2 ≈ bucketBefore (the entire shared bucket).
        // Post-fix, alice's receipt is capped at her per-loan owedA slice.
        assertLt(aliceReceived, bucketBefore, "FIX: alice did NOT drain bob's K2 slice");
        assertApproxEqAbs(
            aliceReceived,
            owedA,
            owedA / 5 + 1, // 20% tolerance for snapshot/delta + cap interactions
            "FIX: alice receipt capped at K1 (owedA)"
        );
        assertEq(lending.escrowRewardsOwed(loanA), 0, "FIX: alice's escrowRewardsOwed cleared post-pull");

        // ── CRITICAL: bucket fully drained, excess parked in lending ───
        uint256 bucketAfterAlicePull = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 lendingToweliAfterAlicePull = toweli.balanceOf(address(lending));
        assertEq(bucketAfterAlicePull, 0, "FIX: per-tokenId bucket fully drained");
        // Bob's K2 slice is now sitting in lending's TOWELI balance.
        // Pre-fix, the lending balance would still be 0 here (drain went
        // straight to Alice), so Bob's pull would revert.
        assertGt(lendingToweliAfterAlicePull, 0, "FIX: K2 spillover parked at lending for bob");

        // ── PHASE 6: Bob calls pullEscrowRewards(loanB). ───────────────
        // The bucket is empty so the per-tokenId pull is a no-op (received=0).
        // The legacy pro-rata path then pays Bob ~K2 from lending's balance.
        // PRE-FIX: lending balance was 0 → payout = 0 → revert NoEscrowRewards
        //          (or directPaid==0 && owed payout==0 → revert path).
        uint256 bobToweliBeforePull = toweli.balanceOf(bob);
        vm.prank(bob);
        lending.pullEscrowRewards(loanB);
        uint256 bobReceived = toweli.balanceOf(bob) - bobToweliBeforePull;

        emit log_named_uint("bob received", bobReceived);
        emit log_named_uint("lending toweli after bob pull", toweli.balanceOf(address(lending)));

        assertGt(bobReceived, 0, "FIX: bob's claim succeeded via legacy pro-rata path on K2 spillover");
        assertEq(lending.escrowRewardsOwed(loanB), 0, "FIX: bob's escrowRewardsOwed cleared post-pull");

        // ── INVARIANTS ─────────────────────────────────────────────────
        // Sum of (alice + bob) drained == bucket total + the snapshot
        // priorShare credits already forwarded during repay (latter zero
        // here because both repays deferred). Conservation law held:
        // pre-fix this sum was inflated to ~2*K1+K2 (alice double-counted
        // K1 via direct AND legacy paths) which leaked from lending's
        // pool. Post-fix the sum is bounded by the actual bucket total.
        uint256 totalDrained = aliceReceived + bobReceived;
        assertApproxEqAbs(
            totalDrained,
            bucketBefore,
            bucketBefore / 10 + 1, // 10% slack for snapshot/delta arithmetic
            "FIX: conservation - total drained ~= bucket total"
        );

        emit log_string("F-LD FIX VALIDATED: pull-then-cap caps first claimant; sibling claim succeeds");
    }
}
