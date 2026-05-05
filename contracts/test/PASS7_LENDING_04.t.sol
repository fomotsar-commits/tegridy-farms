// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyLending.sol";

/// @title PASS7-LENDING-04 — directPaid + legacy double-claim regression
///        introduced by the PASS7-LENDING-03 deferred-slice tracking fix.
///        POST-FIX REGRESSION test.
///
/// @notice Surfaced by the Pass7_LendingExtSolvency invariant
///         (`invariant_p7a_toweliCoversEscrowOwed`). Fix landed in
///         `pullEscrowRewards` at TegridyLending.sol — see the PASS7-LENDING-04
///         AUDIT FIX block right after `uint256 owed = escrowRewardsOwed[_loanId];`
///
///         Sequence:
///           1. Alice opens loan A on tokenId X.
///           2. Time passes — kick rewards accrue in the per-tokenId bucket via
///              kicks during the loan window.
///           3. Staking is paused.
///           4. Alice repays. Two try{claimUnsettledForTokenId} legs both
///              revert (paused). The transfer-out hook still credits
///              `unsettledRewardsByTokenId[X] += K` via _settleRewardsOnTransfer
///              (the from-side hook is not gated by pause). The deferral-tracker
///              at TegridyLending.sol:1023-1028 records:
///                escrowRewardsOwed[loanA] += K
///                totalEscrowRewardsOwed   += K
///              (K = the deferred slice the borrower should be able to recover
///              via pullEscrowRewards once staking is unpaused.)
///           5. Staking unpauses.
///           6. Alice calls pullEscrowRewards(loanA). The directPaid path
///              succeeds: `claimUnsettledForTokenId(X, alice)` drains K from
///              the staking bucket DIRECTLY to alice. `directPaid = K`.
///           7. The legacy pro-rata path then runs with:
///                owed = escrowRewardsOwed[loanA] = K
///                available = toweli.balanceOf(lending) = 0  (just got drained out)
///                payout = mulDiv(owed, 0, total) = 0
///              `escrowRewardsOwed[loanA]` and `totalEscrowRewardsOwed` are
///              decremented by `payout = 0`, so they STAY at K.
///
///         RESULT: alice has been paid K via directPaid, but the lending
///         contract still records K as "owed to alice". Any future TOWELI
///         inflow to lending (donation, priorShare landing from a sibling
///         loan, sweep-recipient quirk) becomes claimable AGAIN by alice via
///         a second pullEscrowRewards call against the legacy pro-rata path.
///
///         Effectively double-pay of the same accrued reward slice. Trigger
///         requires only that staking gets paused at any point during a loan
///         and the borrower repays during the pause window — not adversarial
///         conditions, since admin pauses are a real operational lever.
///
///         FIX SHAPE (NOT applied here — proposing the test is enough):
///         in `pullEscrowRewards`, after computing directPaid, reconcile:
///           uint256 reconcile = directPaid > owed ? owed : directPaid;
///           escrowRewardsOwed[_loanId] = owed - reconcile;
///           totalEscrowRewardsOwed -= reconcile (saturating);
///           owed = escrowRewardsOwed[_loanId];  // refresh for legacy branch
///         The directPaid economically pays off the same deferred slice that
///         was booked into escrowRewardsOwed at repay-time; they MUST decrement
///         together.

contract P7_LD04_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract P7_LD04_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract P7_LD04_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract P7_LD04_Pair {
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

contract P7_LD04_TWAP {
    struct Observation {
        uint32 timestamp;
        bool bypassed;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }
    function consult(address, address, uint256 amountIn, uint256) external pure returns (uint256) {
        return amountIn / 1000;
    }
    function getLatestObservation(address) external view returns (Observation memory o) {
        o.timestamp = uint32(block.timestamp);
    }
    function lastBypassUsed(address) external pure returns (uint256) { return 0; }
}

contract PASS7_LENDING_04_DoubleClaimReproTest is Test {
    P7_LD04_Toweli toweli;
    P7_LD04_JBAC jbac;
    P7_LD04_WETH weth;
    P7_LD04_Pair pair;
    P7_LD04_TWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyLending lending;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address dan = makeAddr("dan");
    uint256 aliceTokenId;

    function setUp() public {
        toweli = new P7_LD04_Toweli();
        jbac = new P7_LD04_JBAC();
        weth = new P7_LD04_WETH();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        toweli.mint(address(staking), 10_000_000 ether);
        toweli.approve(address(staking), 1_000_000 ether);
        staking.notifyRewardAmount(1_000_000 ether);

        twap = new P7_LD04_TWAP();
        pair = new P7_LD04_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        lending.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lending.executeAcceptedCollateral();

        admin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        admin.executeLendingContract();

        toweli.transfer(alice, 100_000 ether);
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

    function test_PASS7_LENDING_04_directPaid_legacy_double_claim() public {
        // ── Phase 1: open + accept loan A.
        vm.prank(dan);
        uint256 offerA = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(staking), 5000 ether, 0
        );

        vm.prank(alice);
        uint256 loanA = lending.acceptOffer(offerA, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), address(lending), "loan A escrowed");

        // Accumulate rewards during the loan window.
        skip(3 days);

        // ── Phase 2: pause staking.
        staking.pause();

        // ── Phase 3: alice repays during the pause. Both two-phase pulls
        //    revert; the transfer-out _settleRewardsOnTransfer hook still
        //    runs and credits unsettledRewardsByTokenId[X] += K. The
        //    deferral-tracker at TegridyLending.sol:1023-1028 records
        //    escrowRewardsOwed[loanA] += K.
        uint256 repayA = 1 ether + 0.05 ether;
        vm.deal(alice, repayA);
        vm.prank(alice);
        lending.repayLoan{value: repayA}(loanA);

        uint256 owedAfterRepay = lending.escrowRewardsOwed(loanA);
        uint256 totalAfterRepay = lending.totalEscrowRewardsOwed();
        assertGt(owedAfterRepay, 0, "deferral-tracker recorded a slice");
        assertEq(owedAfterRepay, totalAfterRepay, "single loan, equal counters");

        // ── Phase 4: unpause staking.
        staking.unpause();

        // ── Phase 5: alice calls pullEscrowRewards once. directPaid drains
        //    the per-tokenId bucket directly to alice. POST-FIX: the
        //    reconcile block at TegridyLending.sol:pullEscrowRewards
        //    decrements escrowRewardsOwed[loanA] AND totalEscrowRewardsOwed
        //    by min(directPaid, owed) — both must zero out (single-loan case,
        //    directPaid >= owed).
        uint256 aliceTwBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        lending.pullEscrowRewards(loanA);
        uint256 aliceFirstReceived = toweli.balanceOf(alice) - aliceTwBefore;

        uint256 owedAfterPull = lending.escrowRewardsOwed(loanA);
        uint256 totalAfterPull = lending.totalEscrowRewardsOwed();

        emit log_named_uint("alice received via directPaid", aliceFirstReceived);
        emit log_named_uint("escrowRewardsOwed[loanA] AFTER pull (POST-FIX should be 0)", owedAfterPull);
        emit log_named_uint("totalEscrowRewardsOwed AFTER pull (POST-FIX should be 0)", totalAfterPull);

        // FIX VALIDATION: alice was paid via directPaid AND the legacy ledger
        // got reconciled in lockstep.
        assertGt(aliceFirstReceived, 0, "alice was paid via directPaid");
        assertEq(
            owedAfterPull,
            0,
            "FIX: escrowRewardsOwed reconciled to 0 against directPaid"
        );
        assertEq(
            totalAfterPull,
            0,
            "FIX: totalEscrowRewardsOwed reconciled to 0 against directPaid"
        );

        // ── Phase 6: regression-prove the double-claim is closed. Donate
        //    TOWELI to lending and have alice call pullEscrowRewards again.
        //    Pre-fix she could drain the donation. Post-fix the second call
        //    reverts NoEscrowRewards because directPaid = 0 (bucket already
        //    drained) AND owed = 0 (reconciled in the previous call).
        uint256 donation = owedAfterRepay; // size of the previously phantom debt
        toweli.transfer(address(lending), donation);

        uint256 aliceTwBefore2 = toweli.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(TegridyLending.NoEscrowRewards.selector);
        lending.pullEscrowRewards(loanA);
        uint256 aliceSecondReceived = toweli.balanceOf(alice) - aliceTwBefore2;

        assertEq(
            aliceSecondReceived,
            0,
            "FIX: alice cannot double-claim - second call reverts cleanly"
        );

        // Sanity: the donation is still parked at lending (would need to
        // exit via the timelocked `proposeSweepDonatedToweli` path).
        assertEq(
            toweli.balanceOf(address(lending)),
            donation,
            "FIX: donation untouched by the failed second-claim attempt"
        );

        emit log_string("PASS7-LENDING-04 FIX VALIDATED: directPaid + legacy ledger reconcile in lockstep - double-claim closed");
    }
}
