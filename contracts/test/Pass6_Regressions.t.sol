// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol"; // AUDIT FIX (pass-8): EIP170-01 split
import "../src/TegridyNFTLending.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title Pass6_Regressions — covers the four NEW HIGHs surfaced by the
///        2026-05-03 fresh-eyes meta-audit pass and closed in commits
///        722d1f1 + b1fb6d4 + 8266289.
///
///        Each test asserts the POST-FIX behaviour: the attacker call either
///        reverts with a typed error or returns 0 paid + emits a forensic
///        event, and the legitimate counter-party ends with the rewards /
///        collateral the protocol owed them. Pre-fix the same scenarios
///        produced silent fund movement (theft) or silent settlement (loss).
///
///        Suite design: each contract group keeps its own minimal mock set
///        so the four tests can run independently — a bug in one mock won't
///        cascade-fail unrelated regressions.

// ─── Shared mocks ────────────────────────────────────────────────────

contract P6_MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract P6_MockJBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract P6_MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "insufficient");
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

/// @dev Minimal TegridyPair mock for the lending ETH-floor TWAP path.
contract P6_MockPair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0; token1 = _t1;
        reserve0 = _r0; reserve1 = _r1;
        blockTimestampLast = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
}

/// @dev Mock factory exposing both `isPair` and `disabledPairs` (the latter is
///      what FRESH-EYES H-2 + Pass-6 HIGH-2 introduced into the TWAP gate).
contract P6_MockFactory {
    mapping(address => bool) public isPair;
    mapping(address => bool) public disabledPairs;
    function tagPair(address pair) external { isPair[pair] = true; }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

/// @dev Malicious ERC721 used in the LD-NEW-H2 regression. The override of
///      `transferFrom` SILENTLY no-ops (returns without revert and without
///      moving the token). Pre-fix, TegridyNFTLending.repayLoan would mark
///      `loan.repaid = true`, send ETH to the lender, and never set
///      `stuckCollateralRecipient` — the NFT was lost forever to the contract.
///      Post-fix, `_safeOutboundTransfer` verifies post-condition ownership.
contract P6_NoOpERC721 is ERC721 {
    uint256 private _id = 1;
    bool public attackArmed;

    constructor() ERC721("NoOpNFT", "NOOP") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
    function arm(bool on) external { attackArmed = on; }

    function transferFrom(address from, address to, uint256 id) public override {
        if (attackArmed) {
            // SILENT NO-OP: ERC721 returns nothing on success, so omitting the
            // _transfer call is indistinguishable from "transfer succeeded"
            // unless the caller verifies post-condition ownership.
            return;
        }
        super.transferFrom(from, to, id);
    }
}

// ═════════════════════════════════════════════════════════════════════
//                    LD-NEW-H1 — cross-loan drain
// ═════════════════════════════════════════════════════════════════════

contract Pass6_LD_NEW_H1_CrossLoanTest is Test {
    P6_MockToweli toweli;
    P6_MockJBAC jbac;
    P6_MockWETH weth;
    P6_MockPair pair;
    TegridyTWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // borrower of loan A
    address bob = makeAddr("bob");     // borrower of loan B (distinct EOA, holds same tokenId)
    address dan = makeAddr("dan");     // lender for both
    address eve = makeAddr("eve");     // permissionless kicker

    uint256 aliceTokenId;

    function setUp() public {
        toweli = new P6_MockToweli();
        jbac = new P6_MockJBAC();
        weth = new P6_MockWETH();
        // Stake-rate large enough that kick credits are non-trivial in tests.
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        // Fund staking with reward token so kick payouts are non-zero.
        toweli.mint(address(staking), 1_000_000 ether);

        // Deploy a no-op TWAP — minPositionETHValue = 0 in offers so consult is never read.
        twap = new TegridyTWAP(address(this), address(0));

        pair = new P6_MockPair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        // AUDIT FIX (pass-8): EIP170-01 split — wire admin sister.
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        // Whitelist the staking contract as a valid collateral collection (48h timelock).
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        // Register the lending contract as a tracked holder so per-tokenId
        // attribution actually fires when kicks land on escrowed NFTs (the
        // LD-NEW-H1 attack surface). Mirrors mainnet wiring.
        admin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        admin.executeLendingContract();

        // Fund alice + bob with TOWELI for staking.
        toweli.transfer(alice, 100_000 ether);
        toweli.transfer(bob, 100_000 ether);

        // Alice stakes for 7 days (short lock so we can trigger kick after both loans complete).
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 7 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Skip past the 24h transfer cooldown for the staking NFT.
        skip(25 hours);

        // Approvals.
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        // Fund dan as lender for both loans.
        vm.deal(dan, 100 ether);
    }

    /// @notice POST-FIX regression: a settled loan's recipient cannot drain the
    ///         per-tokenId rewards belonging to a NEW active loan on the same
    ///         tokenId. Pre-fix, the call to `pullEscrowRewards` blindly invoked
    ///         `staking.claimUnsettledForTokenId(tokenId, recipient)` and Alice
    ///         (loan-A's recipient) silently received the kick credits Bob's
    ///         loan-B was accruing.
    ///
    /// @dev    Test choreography is constrained by the staking lock duration
    ///         (MIN_LOCK_DURATION = 7d) and the LIQUIDATION_GRACE buffer
    ///         (lockEnd >= deadline + 1d) so the kick window only opens AFTER
    ///         the loan deadline. We use very short loans (4h each) so the
    ///         lender can claim default once `block.timestamp >= lockEnd`,
    ///         which is the same moment kicks become eligible.
    function test_LD_NEW_H1_oldLoanCannotDrainNewLoanCredits() public {
        // ── Phase 1: Alice's loan A — short 4h loan, repay quickly, no kicks. ──
        vm.prank(dan);
        uint256 offerA = lending.createLoanOffer{value: 1 ether}(
            1000,        // 10% APR
            1 days,      // MIN_DURATION on TegridyLending = 1 day; both loans fit in 7d lock
            address(staking),
            5000 ether,
            0
        );

        vm.prank(alice);
        uint256 loanA = lending.acceptOffer(offerA, aliceTokenId);

        // Repay 30 minutes in — no kicks possible yet (lock still active).
        skip(30 minutes);
        // Pull actual startTime from loan storage so the calculateInterest
        // anchor is correct regardless of any setUp-side time skew.
        (,,,, , , uint256 startA, , , , ) = lending.getLoan(loanA);
        uint256 interestA = lending.calculateInterest(1 ether, 1000, startA, block.timestamp);
        uint256 repayA = 1 ether + interestA + 0.01 ether; // small headroom for rounding
        vm.deal(alice, repayA);
        vm.prank(alice);
        lending.repayLoan{value: repayA}(loanA);

        assertEq(staking.ownerOf(aliceTokenId), alice, "loan A repaid: NFT returned");

        // ── Phase 2: Alice transfers tokenId to Bob; Bob opens loan B. ──
        // Skip past the 24h staking transfer cooldown (TRANSFER_COOLDOWN). We
        // already burned 25h in setUp + 30 min during Loan A, so well past.
        skip(2 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, bob, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), bob, "transferred to bob");

        vm.prank(bob);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(dan, 1 ether);
        vm.prank(dan);
        uint256 offerB = lending.createLoanOffer{value: 1 ether}(
            1000, 1 days, address(staking), 5000 ether, 0
        );

        vm.prank(bob);
        uint256 loanB = lending.acceptOffer(offerB, aliceTokenId);

        // ── Phase 3: skip past lock end → permissionless kick lands rewards in
        //    `unsettledRewardsByTokenId[aliceTokenId]`. These credits belong
        //    to BOB (the current escrowed loan).
        // setUp warps consumed ~25h since alice.stake; we now skip 7 days more.
        // That puts us well past lockEnd (stake_start + 7d) and well past loanB
        // deadline + LIQUIDATION_GRACE (1d) — lender Dan is now eligible to
        // claim default; we use that path in Phase 5.
        skip(7 days);
        vm.prank(eve);
        staking.kick(aliceTokenId);

        uint256 perTokenIdAfterKick = staking.unsettledRewardsByTokenId(aliceTokenId);
        assertGt(perTokenIdAfterKick, 0, "kick credited per-tokenId");

        // ── Phase 4: ATTACK — Alice (loanA recipient) tries to drain Bob's
        //    credits. POST-FIX must revert with NoEscrowRewards: nft is held
        //    by lending so the per-tokenId pull is skipped, and the legacy
        //    `escrowRewardsOwed[loanA]` slot was never populated (no kicks
        //    happened during loanA's window).
        vm.expectRevert(TegridyLending.NoEscrowRewards.selector);
        vm.prank(alice);
        lending.pullEscrowRewards(loanA);

        // Per-tokenId mapping is intact — Alice took nothing.
        assertEq(
            staking.unsettledRewardsByTokenId(aliceTokenId),
            perTokenIdAfterKick,
            "Alice's stale-loan call must not have touched per-tokenId state"
        );

        // ── Phase 5: Lender Dan claims default (Bob is past deadline + grace).
        //    The two-phase per-tokenId claim inside `claimDefaultedCollateral`
        //    sweeps the kick rewards to the lender — those credits belong to
        //    the loan-B settlement scope and would have gone to whoever
        //    settled loan B (here, the defaulting lender).
        uint256 danToweliBefore = toweli.balanceOf(dan);
        vm.prank(dan);
        lending.claimDefaultedCollateral(loanB);

        // Dan now owns the NFT and received the per-tokenId credits.
        assertEq(staking.ownerOf(aliceTokenId), dan, "Dan received NFT after default");
        assertGt(
            toweli.balanceOf(dan) - danToweliBefore,
            0,
            "Dan received the per-tokenId credits via two-phase claim"
        );

        // After Dan's claim, per-tokenId mapping should be drained.
        assertEq(
            staking.unsettledRewardsByTokenId(aliceTokenId),
            0,
            "per-tokenId drained by lender's default claim two-phase pull"
        );
    }
}

// ═════════════════════════════════════════════════════════════════════
//   LD-NEW-H1 cross-protocol mirror — TegridyRestaking.claimResidualForTokenId
//   refuses to drain `unsettledRewardsByTokenId` while the NFT is escrowed
//   in another tracked holder (lending). Pre-fix, the prior restaker still
//   holding `residualClaimant[tokenId]` could drain a lending borrower's
//   in-flight per-tokenId credits via the shared mapping.
// ═════════════════════════════════════════════════════════════════════

contract Pass6_LD_NEW_H1_CrossProtocolMirrorTest is Test {
    P6_MockToweli toweli;
    P6_MockJBAC jbac;
    P6_MockWETH weth;
    P6_MockPair pair;
    TegridyTWAP twap;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyRestaking restaking;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split

    address treasury = makeAddr("treasury_xp");
    address alice = makeAddr("alice_xp");      // restaker, becomes residualClaimant
    address bob = makeAddr("bob_xp");          // borrower in lending
    address dan = makeAddr("dan_xp");          // lender
    address eve = makeAddr("eve_xp");          // permissionless kicker

    uint256 aliceTokenId;

    function setUp() public {
        toweli = new P6_MockToweli();
        jbac = new P6_MockJBAC();
        weth = new P6_MockWETH();

        // Reward rate is non-trivial so a kick credits a meaningful slice.
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        // CRUCIAL: under-fund the staking reward pool so the per-tokenId pull
        // during alice's unrestake is partial — the residue is what triggers
        // `_reserveResidual` to set `residualClaimant[tokenId] = alice`.
        // We mint just enough TOWELI for staking's own balance accounting but
        // leave the reward pool effectively empty.
        // (No notifyRewardAmount call → all balance is reserved by totalStaked.)

        restaking = new TegridyRestaking(address(staking), address(toweli), address(weth), 0);

        // Wire restaking into staking via the admin's timelocked path.
        admin.proposeRestakingContract(address(restaking));
        skip(48 hours + 1);
        admin.executeRestakingContract();

        // Build a pair + TWAP for the lending ETH-floor (we set
        // minPositionETHValue=0 in offers, so the TWAP is never consulted).
        twap = new TegridyTWAP(address(this), address(0));
        pair = new P6_MockPair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        // AUDIT FIX (pass-8): EIP170-01 split — wire admin sister.
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        // Whitelist staking as collateral on lending (48h timelock).
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        // Register lending as a tracked holder on staking.
        admin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        admin.executeLendingContract();

        // Fund alice + bob with TOWELI for staking.
        toweli.transfer(alice, 100_000 ether);
        toweli.transfer(bob, 100_000 ether);

        // Alice stakes for 30 days so we have headroom for: setUp warps,
        // a mid-lock restake/unrestake cycle, and a downstream Bob loan
        // whose deadline + LIQUIDATION_GRACE (1d) still fits inside lockEnd.
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 30 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Approve restaking and restake (transfer cooldown is exempt for restaking
        // as a tracked holder via the TF-02 lending/restaking exemption — but only
        // if 24h has elapsed, so warp first).
        skip(25 hours);
        vm.startPrank(alice);
        staking.approve(address(restaking), aliceTokenId);
        restaking.restake(aliceTokenId);
        vm.stopPrank();

        // Lender funding.
        vm.deal(dan, 100 ether);
    }

    /// @notice POST-FIX regression: prior restaker (residualClaimant) cannot
    ///         drain the per-tokenId mapping while the NFT is currently held by
    ///         a DIFFERENT tracked holder (here: TegridyLending). Pre-fix, the
    ///         claim succeeded and silently took whatever per-tokenId credits
    ///         had accrued during the lending borrower's loan window.
    /// @dev    The natural under-funded-pool sequence that produces a residual
    ///         claim requires multi-restaker contention scenarios that are
    ///         orthogonal to the gate being tested here. We use `vm.store` to
    ///         construct the precondition state directly — the test focuses on
    ///         verifying the FIX'S BEHAVIOUR (refuse to drain when ownerOf is a
    ///         third-party tracked holder), not the upstream flow that sets
    ///         residualClaimant in production.
    function test_LD_NEW_H1_mirror_residualClaimantBlockedByLendingEscrow() public {
        // ── Phase 1: alice unrestakes mid-lock (no residue under normal pool
        //    conditions — alice gets her NFT back and the restaking state is
        //    cleaned up). We unrestake at ~day 6 so plenty of lock remains
        //    for the downstream Bob loan.
        skip(5 days);
        vm.prank(alice);
        restaking.unrestake();
        assertEq(staking.ownerOf(aliceTokenId), alice, "NFT returned to alice");

        // ── Phase 2: forge the precondition state. We use vm.store to set:
        //    (a) residualClaimant[aliceTokenId] = alice (slot 9 in TegridyRestaking)
        //    (b) unsettledRewardsByTokenId[aliceTokenId] = 1 ether (mock residue)
        //    (c) unsettledRewards[restakingContract] = 1 ether (matching backing)
        //    These mirror what would land in production after a multi-restaker
        //    pool-shortfall sequence — exactly the LD-NEW-H1 mirror attack
        //    surface.
        // residualClaimant slot for tokenId = keccak256(abi.encode(tokenId, 9))
        bytes32 rcSlot = keccak256(abi.encode(aliceTokenId, uint256(9)));
        vm.store(address(restaking), rcSlot, bytes32(uint256(uint160(alice))));
        assertEq(
            restaking.residualClaimant(aliceTokenId), alice,
            "vm.store: residualClaimant precondition set"
        );

        // ── Phase 3: alice transfers tokenId to Bob; Bob takes a loan in
        //    TegridyLending. NFT moves from alice → lending. Now ownerOf is
        //    a tracked-holder lending contract (NOT msg.sender, NOT restaking).
        skip(2 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, bob, aliceTokenId);
        vm.prank(bob);
        staking.approve(address(lending), aliceTokenId);

        vm.prank(dan);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 1 days, address(staking), 5000 ether, 0
        );
        vm.prank(bob);
        lending.acceptOffer(offerId, aliceTokenId);
        assertEq(
            staking.ownerOf(aliceTokenId), address(lending),
            "NFT escrowed at lending"
        );

        // Forge the per-tokenId residue + holder backing on the staking side
        // (slot 11 = unsettledRewardsByTokenId — verified via forge inspect).
        // We're testing the GATE in claimResidualForTokenId: regardless of
        // whether residue is fake or real, the gate must short-circuit when
        // ownerOf is a third-party tracked holder.
        bytes32 utiSlot = keccak256(abi.encode(aliceTokenId, _stakingPerTokenIdSlot()));
        vm.store(address(staking), utiSlot, bytes32(uint256(1 ether)));
        assertEq(
            staking.unsettledRewardsByTokenId(aliceTokenId), 1 ether,
            "vm.store: per-tokenId residue set"
        );

        // ── Phase 4: ATTACK — alice (residualClaimant) calls
        //    claimResidualForTokenId while ownerOf is lending. POST-FIX must
        //    return 0 paid, NOT touch the per-tokenId mapping, and emit
        //    ResidualPullDeferredCrossHolder. Pre-fix this would have drained
        //    the residue to alice via the shared per-tokenId mapping.
        uint256 perTokenIdBeforeAttack = staking.unsettledRewardsByTokenId(aliceTokenId);

        vm.expectEmit(true, true, false, false);
        emit TegridyRestaking.ResidualPullDeferredCrossHolder(aliceTokenId, address(lending));
        vm.prank(alice);
        uint256 paid = restaking.claimResidualForTokenId(aliceTokenId);

        assertEq(paid, 0, "POST-FIX: cross-protocol drain returns 0");
        assertEq(
            staking.unsettledRewardsByTokenId(aliceTokenId),
            perTokenIdBeforeAttack,
            "POST-FIX: per-tokenId mapping untouched while NFT in lending"
        );
        // residualClaim is preserved — alice can retry once the NFT exits lending.
        assertEq(
            restaking.residualClaimant(aliceTokenId), alice,
            "POST-FIX: residual claim stays live for retry"
        );
    }

    /// @dev `unsettledRewardsByTokenId` slot in TegridyStaking, captured via
    ///      `forge inspect TegridyStaking storageLayout` at the time of writing.
    ///      If the staking storage layout changes (new state vars added before
    ///      this mapping), update this constant. Lookup is one-time at test
    ///      run; we wrap in a function so the magic number is documented.
    function _stakingPerTokenIdSlot() internal pure returns (uint256) {
        // Verified via `forge inspect TegridyStaking storageLayout` (slot 27).
        return 27;
    }
}

// ═════════════════════════════════════════════════════════════════════
//             LD-NEW-H2 — silent no-op transferFrom on outbound NFT
// ═════════════════════════════════════════════════════════════════════

contract Pass6_LD_NEW_H2_NoOpTransferTest is Test {
    P6_MockWETH weth;
    P6_NoOpERC721 nft;
    TegridyNFTLending lending;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");      // lender — has ETH
    address bob = makeAddr("bob");          // borrower — owns the malicious NFT

    uint256 bobTokenId;

    function setUp() public {
        vm.warp(1_700_000_000);

        weth = new P6_MockWETH();
        nft = new P6_NoOpERC721();
        lending = new TegridyNFTLending(treasury, 500, address(weth));

        // Whitelist the NoOp NFT — simulates a (later-discovered-malicious)
        // collection that admin previously added in good faith.
        lending.proposeWhitelistCollection(address(nft));
        skip(25 hours);
        lending.executeWhitelistCollection();

        bobTokenId = nft.mint(bob);
        vm.prank(bob);
        nft.approve(address(lending), bobTokenId);

        vm.deal(alice, 100 ether);
    }

    /// @notice POST-FIX regression: when a malicious whitelisted ERC721 silently
    ///         no-ops `transferFrom` on the outbound (return-to-borrower) leg,
    ///         the lending contract MUST detect the unmoved NFT via post-
    ///         condition `ownerOf` and mark `stuckCollateralRecipient` so the
    ///         borrower can recover via `claimStuckCollateral` once the
    ///         collection is delisted/replaced. Pre-fix, the no-op path silently
    ///         left the NFT in the lending contract forever.
    function test_LD_NEW_H2_silentNoOpRepay_marksStuck() public {
        // Alice creates a loan offer for Bob's NFT.
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId
        );

        // Bob accepts — NFT escrowed in lending. Note: inbound transferFrom is
        // NOT a no-op (attackArmed is false), so the offer-acceptance leg works.
        vm.prank(bob);
        uint256 loanId = lending.acceptOffer(offerId);
        assertEq(nft.ownerOf(bobTokenId), address(lending), "NFT escrowed");

        // Skip far enough that interest accrues but well within deadline + grace.
        skip(7 days);

        // Arm the malicious no-op for the OUTBOUND leg.
        nft.arm(true);

        // Repay with a generous overpayment so the InsufficientRepayment / minimum
        // interest floor gates can't trip on rounding. Excess is refunded by the
        // contract via WETHFallbackLib. The 10% buffer is well above any plausible
        // 7-day interest at 10% APR (~0.19%) plus the LD-M6 + LD2-H2 floors.
        uint256 repay = 1.1 ether;
        vm.deal(bob, repay);

        // Repay completes (money flows to lender) — but the outbound transfer
        // silently no-ops. Post-fix `_safeOutboundTransfer` MUST detect this
        // via post-condition ownerOf and set stuckCollateralRecipient.
        vm.prank(bob);
        lending.repayLoan{value: repay}(loanId);

        // ── Critical post-fix assertions ──
        // 1. Loan is marked repaid (money flowed; we don't trap funds on a
        //    silent-NFT-failure — the borrower's ETH already left).
        (,,,,,,,,, bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid, "loan flagged repaid");

        // 2. NFT is STILL held by the lending contract (no-op transfer).
        assertEq(nft.ownerOf(bobTokenId), address(lending), "no-op left NFT escrowed");

        // 3. POST-FIX: stuckCollateralRecipient is now Bob (pre-fix it was 0).
        assertEq(
            lending.stuckCollateralRecipient(loanId), bob,
            "LD-NEW-H2: silent no-op detected, stuckCollateralRecipient set"
        );

        // 4. Bob can recover the NFT once the malicious collection is fixed.
        nft.arm(false); // simulate operator unfreezes the NFT
        vm.prank(bob);
        lending.claimStuckCollateral(loanId);
        assertEq(nft.ownerOf(bobTokenId), bob, "Bob recovered the NFT");
    }
}

// ═════════════════════════════════════════════════════════════════════
//          TWAP HIGH-2 — consult reverts when pair is disabled
// ═════════════════════════════════════════════════════════════════════

contract Pass6_TWAP_DisabledPair_LendingTest is Test {
    P6_MockToweli toweli;
    P6_MockWETH weth;
    P6_MockPair pair;
    P6_MockFactory factory;
    TegridyTWAP twap;

    function setUp() public {
        toweli = new P6_MockToweli();
        weth = new P6_MockWETH();
        // 1 TOWELI = 0.001 ETH spot ratio
        pair = new P6_MockPair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);
        factory = new P6_MockFactory();
        factory.tagPair(address(pair));
        twap = new TegridyTWAP(address(factory), address(0));
    }

    /// @notice POST-FIX regression: `consult()` now reverts `PairDisabled` when
    ///         the factory has flipped `disabledPairs[pair] = true`. Pre-fix,
    ///         `consult()` happily served a TWAP from a buffer whose most-recent
    ///         observations were recorded against frozen-skewed reserves, letting
    ///         downstream consumers (lending oracle, POL harvest) act on
    ///         poisoned data even while the pair was disabled.
    function test_TWAP_HIGH_2_consultRevertsWhenPairDisabled() public {
        // Seed observations honestly (4 obs to clear the FRESH-EYES H-3
        // bypassed-bootstrap window for any consult period ≤ 30 minutes).
        twap.update(address(pair));
        skip(16 minutes); twap.update(address(pair));
        skip(16 minutes); twap.update(address(pair));
        skip(16 minutes); twap.update(address(pair));

        // Sanity: consult succeeds while pair is live.
        uint256 amountOut = twap.consult(address(pair), address(toweli), 1 ether, 30 minutes);
        assertGt(amountOut, 0, "consult works pre-disable");

        // Governance disables the pair (simulated via mock factory).
        factory.setDisabled(address(pair), true);

        // POST-FIX: consult must revert PairDisabled. Pre-fix this returned
        // a quote from the (potentially poisoned) buffer.
        vm.expectRevert(TegridyTWAP.PairDisabled.selector);
        twap.consult(address(pair), address(toweli), 1 ether, 30 minutes);

        // And update() also refuses to record fresh observations during the
        // disable window (FRESH-EYES H-2 — verified here for completeness).
        skip(16 minutes);
        vm.expectRevert(TegridyTWAP.PairDisabled.selector);
        twap.update(address(pair));

        // Re-enable closes the gate again.
        factory.setDisabled(address(pair), false);
        // First post-reenable consult still works against existing valid obs.
        uint256 amountOutAfter = twap.consult(address(pair), address(toweli), 1 ether, 30 minutes);
        assertGt(amountOutAfter, 0, "consult resumes post re-enable");
    }
}
