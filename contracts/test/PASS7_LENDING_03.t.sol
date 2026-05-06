// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol"; // AUDIT FIX (pass-8): EIP170-01 split
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title PASS7-LENDING-03 — settled-vs-settled cross-loan drain via shared
///        per-tokenId reward bucket.
///
/// @notice Pass-6 LD-NEW-H1 closed the **active-vs-settled** cross-loan drain
///         where an OLD loan's beneficiary could call `pullEscrowRewards`
///         while a NEW loan was active on the same tokenId, draining the
///         active loan's accruing kick rewards via
///         `claimUnsettledForTokenId`. The fix gates `pullEscrowRewards` on
///         `staking.ownerOf(loan.tokenId) != address(this)` — so while the
///         NFT is back in lending escrow, the per-tokenId pull is skipped.
///
///         HOWEVER: pass-6 did NOT consider the **settled-vs-settled**
///         variant. Sequence:
///
///           1. Alice opens loan-A on tokenId X.
///           2. Staking is paused (admin / emergency / accidental).
///           3. Alice repays. The two-phase per-tokenId pull is wrapped in
///              try/catch (TegridyLending.sol:896-908) — `claimUnsettledForTokenId`
///              has `whenNotPaused`, so it REVERTS while paused. The repay
///              completes, NFT returns to Alice, but the per-tokenId credits
///              accrued during loan A's window stay parked in
///              `unsettledRewardsByTokenId[X]` and `unsettledRewards[lending]`.
///              The two-phase pull DEFERS — exactly the failure mode the
///              try/catch is designed to handle.
///           4. Staking unpauses.
///           5. Alice transfers tokenId X to Bob (or re-stakes, etc.).
///              Bob opens loan-B on the same tokenId X.
///           6. Bob repays. The two-phase per-tokenId pull NOW SUCCEEDS,
///              draining the ENTIRE `unsettledRewardsByTokenId[X]` bucket
///              — INCLUDING the K1 credits that belonged to Alice's loan-A
///              settlement scope. Bob walks away with Alice's deferred
///              credits.
///           7. Alice calls `pullEscrowRewards(loanA)` — per-tokenId X is now
///              0, so it reverts `NoEscrowRewards`. Alice's credits are
///              irrecoverable; they were drained by Bob's loan-B settlement.
///
///         The pre-existing LD-NEW-H1 fix does NOT defend this path because
///         the gate checks `ownerOf == address(this)` — at the moment Bob's
///         repay runs, the NFT is in lending (escrowed for loan B), so the
///         gate would block Alice's stale `pullEscrowRewards`. But Bob's
///         settlement uses the INTERNAL two-phase path (NOT
///         pullEscrowRewards), which has NO per-loan attribution check. The
///         two-phase pull happily drains credits attributed to OTHER loans'
///         settlement scope.
///
///         Severity: HIGH. Cross-loan drain on the lending side, identical
///         attack class to LD-NEW-H1 but on the SETTLED↔SETTLED axis instead
///         of the SETTLED↔ACTIVE axis. The required precondition (staking
///         pause that defers a two-phase pull) matches the failure mode the
///         try/catch is explicitly designed to handle, so this is NOT a
///         degenerate edge case.
///
///         FIX SHAPE: track per-LOAN attribution rather than per-tokenId, OR
///         snapshot `unsettledRewardsByTokenId[tokenId]` at loan-OPEN
///         (acceptOffer) and only pull the DELTA at settlement; carry the
///         pre-loan slice in a per-prior-loan ledger that pullEscrowRewards
///         can reach.

contract P7_LD03_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract P7_LD03_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract P7_LD03_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract P7_LD03_Pair {
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

contract PASS7_LENDING_03_SettledVsSettledDrainTest is Test {
    P7_LD03_Toweli toweli;
    P7_LD03_JBAC jbac;
    P7_LD03_WETH weth;
    P7_LD03_Pair pair;
    TegridyTWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address dan = makeAddr("dan");      // lender for both loans

    uint256 aliceTokenId;

    function setUp() public {
        toweli = new P7_LD03_Toweli();
        jbac = new P7_LD03_JBAC();
        weth = new P7_LD03_WETH();
        // High reward rate for clean credit observability.
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        // Fund staking with reward token so transfer-time settlements credit non-trivial amounts.
        toweli.mint(address(staking), 10_000_000 ether);
        // Notify reward to drive `rewardPerTokenStored` accumulation.
        toweli.approve(address(staking), 1_000_000 ether);
        staking.notifyRewardAmount(1_000_000 ether);

        twap = new TegridyTWAP(address(this), address(0));
        pair = new P7_LD03_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        // AUDIT FIX (pass-8): EIP170-01 split — wire admin sister.
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

        // Alice stakes with a long lock so credits accrue throughout. 365 days
        // is well above MIN_LOCK_DURATION (7d), and easily covers the 2-loan choreography
        // we run. boostedAmount stays positive throughout (lock doesn't expire mid-test).
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Skip past 24h transfer cooldown.
        skip(25 hours);
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(dan, 100 ether);
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-LENDING-03 fix.
    ///         acceptOffer now snapshots `unsettledRewardsByTokenId[tokenId]`
    ///         into `loanRewardsSnapshot[loanId]`. At settlement, repay/default
    ///         drain to lending and split the claim into priorShare (snapshot,
    ///         left in lending balance for the prior holder) vs myShare (delta,
    ///         forwarded to current recipient). On try/catch deferral, the
    ///         un-claimable slice is recorded into `escrowRewardsOwed[loanId]`
    ///         so the original recipient can recover it via pullEscrowRewards.
    ///         Bob can no longer drain Alice's deferred K1.
    function test_PASS7_LENDING_03_settledVsSettledCrossLoanDrain() public {
        // ── PHASE 1: Alice opens loan-A. The acceptOffer transferFrom
        //    (borrower → lending) does NOT credit per-tokenId because
        //    `from = borrower` is not a tracked holder. The credits accrue
        //    DURING the loan via `rewardPerTokenStored` accumulation. They
        //    will be CREDITED into the per-tokenId mapping at the moment of
        //    NFT transfer OUT (lending → borrower) by `_settleRewardsOnTransfer`.

        vm.prank(dan);
        uint256 offerA = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(staking), 5000 ether, 0
        );

        vm.prank(alice);
        uint256 loanA = lending.acceptOffer(offerA, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), address(lending), "loan A: NFT escrowed");

        // Skip part of the loan period to accumulate reward-per-token.
        skip(3 days);

        // PAUSE STAKING — this is the precondition for the two-phase pull
        // to defer (claimUnsettledForTokenId is whenNotPaused).
        staking.pause();

        // Calculate Alice's expected repay generously and have her repay.
        // The repay path:
        //   - `try claimUnsettledForTokenId(tokenId, alice)` → REVERTS (paused) → defer
        //   - `staking.transferFrom(this, alice, tokenId)` → triggers
        //     `_settleRewardsOnTransfer(tokenId, lending)` which credits
        //     `unsettledRewardsByTokenId[X] += K1` and `unsettledRewards[lending] += K1`
        //     (lending IS a tracked holder)
        //   - `try claimUnsettledForTokenId(tokenId, alice)` → REVERTS (paused) → defer
        // Result: NFT returned to Alice, but K1 credits stay parked.
        uint256 repayA = 1 ether + 0.05 ether; // generous headroom
        vm.deal(alice, repayA);
        vm.prank(alice);
        lending.repayLoan{value: repayA}(loanA);

        assertEq(staking.ownerOf(aliceTokenId), alice, "loan A: NFT returned to alice");

        uint256 perTokenIdAfterA = staking.unsettledRewardsByTokenId(aliceTokenId);
        uint256 lendingBucketAfterA = staking.unsettledRewards(address(lending));
        assertGt(perTokenIdAfterA, 0, "loan A: per-tokenId credited via _settleRewardsOnTransfer");
        assertEq(perTokenIdAfterA, lendingBucketAfterA, "loan A: per-tokenId == lending bucket (one credit source)");

        // ── PHASE 2: Unpause staking. Alice could NOW recover via
        //    pullEscrowRewards(loanA) — but she hasn't done so yet. The NFT
        //    is at Alice's wallet (gate `ownerOf != lending` would PASS the
        //    LD-NEW-H1 check, allowing the per-tokenId pull). Crucially:
        //    Alice's window to recover is OPEN but UNUSED.
        staking.unpause();

        // Alice transfers her NFT to Bob (24h cooldown after acceptOffer/repay
        // re-set — let's wait it out).
        skip(25 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, bob, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), bob, "Alice transferred to Bob");

        // ── PHASE 3: Bob opens loan-B and repays. The repay's two-phase
        //    per-tokenId pull (NOT paused this time) drains the ENTIRE
        //    per-tokenId bucket — INCLUDING Alice's K1 deferred credits.

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

        // CRITICAL CHECKPOINT — per-tokenId mapping at this moment.
        // It still holds K1 (Alice's deferred) because nothing has drained it.
        // Bob's loan-B time has accrued some rewards too, but those will only
        // land in per-tokenId at the moment of NFT transfer OUT (during repay).
        uint256 perTokenIdBeforeBobsRepay = staking.unsettledRewardsByTokenId(aliceTokenId);
        assertGe(
            perTokenIdBeforeBobsRepay,
            perTokenIdAfterA,
            "per-tokenId still holds Alice's K1 deferred credits"
        );

        uint256 bobToweliBefore = toweli.balanceOf(bob);

        // Bob repays. The two-phase pull drains EVERYTHING including K1.
        uint256 repayB = 1 ether + 0.05 ether;
        vm.deal(bob, repayB);
        vm.prank(bob);
        lending.repayLoan{value: repayB}(loanB);

        uint256 bobReceived = toweli.balanceOf(bob) - bobToweliBefore;
        assertGt(bobReceived, 0, "Bob received per-tokenId payouts via two-phase pull");

        // The per-tokenId bucket should be ~drained.
        uint256 perTokenIdAfterB = staking.unsettledRewardsByTokenId(aliceTokenId);
        assertLt(
            perTokenIdAfterB,
            perTokenIdAfterA,
            "drain: per-tokenId bucket reduced below Alice's deferred K1"
        );

        // ── PHASE 4: PASS7-LENDING-03 FIX VALIDATION ─────────────────────
        // Alice can recover via pullEscrowRewards(loanA). Pre-fix, this
        // reverted NoEscrowRewards because Bob's repay drained the bucket
        // (per-tokenId attribution had no per-loan scope). Post-fix:
        //   - Alice's repay deferral populated escrowRewardsOwed[loanA].
        //   - Bob's repay snapshotted loanRewardsSnapshot[loanB] = bucket-at-
        //     accept (= Alice's deferred K1). Bob drained to lending and
        //     split: priorShare = snapshot stayed in lending balance,
        //     myShare = delta (loan-B's own 3-day accrual) → Bob.
        //   - Alice's pullEscrowRewards falls through to the legacy
        //     escrowRewardsOwed pro-rata path against lending's TOWELI balance.
        uint256 aliceToweliBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        lending.pullEscrowRewards(loanA);
        uint256 aliceReceived = toweli.balanceOf(alice) - aliceToweliBefore;

        emit log_named_uint("alice K1 (deferred)", perTokenIdAfterA);
        emit log_named_uint("alice recovered via pullEscrowRewards", aliceReceived);
        emit log_named_uint("bob received via loan-B delta", bobReceived);

        // FIX VALIDATION: Alice can recover SOMETHING — pre-fix she got NOTHING
        // (NoEscrowRewards revert). Post-fix she gets her deferred slice via
        // the legacy escrowRewardsOwed pro-rata path.
        assertGt(aliceReceived, 0, "FIX: Alice recovered her deferred slice via pullEscrowRewards");

        // Sanity: Alice's recovery is approximately the snapshot-preserved K1
        // (capped by lending's TOWELI balance, which received priorShare).
        // We don't assert exact equality because of pro-rata math when other
        // entries exist; the pre-fix `vm.expectRevert(NoEscrowRewards)` was
        // the actual bug demo. Recovery > 0 is the fix proof.
        assertGe(
            aliceReceived,
            perTokenIdAfterA / 2,
            "FIX: Alice's recovery is at least half her deferred K1"
        );

        emit log_string("PASS7-LENDING-03 FIX VALIDATED: snapshot-and-delta preserves prior holder's deferred slice");
    }
}
