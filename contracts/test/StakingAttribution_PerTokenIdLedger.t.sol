// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";

/// @title  [staking-attribution] `claimUnsettledForTokenId` must drain the CALLER'S OWN
///         per-(tokenId, holder) entry, never the shared aggregate.
///
/// @notice THE DEFECT (pre-fix, src/TegridyStaking.sol :1787-1830, gate at :1801):
///
///           if (!_isTrackedHolder(msg.sender)) revert Unauthorized();
///           // ... "The full fix requires per-tokenId attribution tracking
///           //      (new storage slot) — a larger surgery deferred to a
///           //      dedicated PR."
///
///         The gate asked "is the caller *A* tracked holder?" — never "is the caller
///         *THE* holder whose bucket backs THIS tokenId?". The drain then read the
///         SHARED `unsettledRewardsByTokenId[tokenId]`, so any one whitelisted lending
///         escrow (or the restaking contract) could act on a tokenId escrowed at a
///         DIFFERENT tracked holder:
///
///           (1) DESTRUCTION — an attacker holder with an EMPTY `unsettledRewards`
///               bucket tripped the L-16 "zombie cleanup" branch in
///               `StakingRewardLib.claimUnsettledForTokenId` (`amount > 0 &&
///               holderUnsettled == 0  =>  unsettledRewardsByTokenId[tokenId] = 0`),
///               permanently zeroing the victim's attribution. Unrecoverable:
///               `claimUnsettled()` and `claimUnsettledFor()` BOTH revert
///               `Unauthorized` for a tracked holder (TegridyStaking :1719, :1751),
///               so `claimUnsettledForTokenId` is a tracked holder's ONLY drain route
///               and it now read 0.
///
///           (2) DIVERSION — an attacker holder that DOES hold a bucket drained the
///               victim's slice to an arbitrary `recipient`.
///
/// @notice THE FIX: `mapping(uint256 => mapping(address => uint256))
///         _unsettledByTokenIdHolder` — a per-(tokenId, holder) LEDGER. Credits are
///         UNCONDITIONAL on both the entry and the aggregate; the drain reads only the
///         caller's own entry and decrements entry + aggregate + bucket +
///         totalUnsettledRewards in lockstep. There is no conflict case, so there is
///         nothing to strand and no slot for two holders to contend over.
contract StakingAttributionPerTokenIdLedgerTest is Test {
    using stdStorage for StdStorage;

    // Local mirrors of the ledger-mutation events, required so `vm.expectEmit` has a
    // declaration to encode. Signatures must stay byte-identical to TegridyStaking's.
    event UnsettledClaimedForTokenId(uint256 indexed tokenId, address indexed recipient, uint256 amount);
    event UnsettledClaimedForTokenIdHolder(
        uint256 indexed tokenId, address indexed holder, address indexed recipient, uint256 amount
    );
    event UnsettledZombieEntryCleared(uint256 indexed tokenId, address indexed holder, uint256 amount);

    TegridyStaking public staking;
    TegridyStakingAdmin public admin;
    LedgerMockToken public token;
    LedgerMockNFT public nft;

    LedgerTrackedHolder public escrowA; // legitimate holder of the victim tokenId
    LedgerTrackedHolder public escrowB; // second, unrelated tracked holder (attacker)

    address public treasury = makeAddr("lg_treasury");
    address public alice = makeAddr("lg_alice");
    address public bob = makeAddr("lg_bob");
    address public thief = makeAddr("lg_thief");

    function setUp() public {
        token = new LedgerMockToken();
        nft = new LedgerMockNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        escrowA = new LedgerTrackedHolder(staking);
        escrowB = new LedgerTrackedHolder(staking);

        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        // Whitelist BOTH escrows as lending contracts (=> `_isTrackedHolder` true) and
        // raise the L-06 unsettled cap so a large shortfall books in full.
        admin.proposeLendingContract(address(escrowA), true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        admin.executeLendingContract();

        admin.proposeLendingContract(address(escrowB), true);
        admin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        admin.executeLendingContract();
        admin.executeMaxUnsettledRewards();

        assertTrue(staking.isLendingContract(address(escrowA)), "escrowA must be tracked");
        assertTrue(staking.isLendingContract(address(escrowB)), "escrowB must be tracked");
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(uint256 amt) internal {
        token.approve(address(staking), amt);
        staking.notifyRewardAmount(amt);
    }

    /// @dev Bake all elapsed emission into `rewardPerTokenStored` at the CURRENT
    ///      (healthy) pool. Accrual is POOL-CAPPED (`StakingRewardLib.accumulateRewards`
    ///      clamps `reward` to the free pool), so without this the later drain would
    ///      simply prevent the accrual instead of producing a real shortfall.
    function _bakeAccrual() internal {
        token.approve(address(staking), 1_000 ether); // MIN_NOTIFY_AMOUNT
        staking.notifyRewardAmount(1_000 ether);
    }

    /// @dev The free reward pool = balance - totalStaked - totalUnsettledRewards.
    function _rewardPool() internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 d = pool - leavePool;
        if (d == 0) return;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), d);
    }

    /// @dev Stake as `staker`, escrow the position NFT at `escrow`, and clear the
    ///      transfer-window accrual with a fully-funded `getReward` so the per-tokenId
    ///      mapping starts at a clean 0.
    function _seed(address staker, LedgerTrackedHolder escrow, uint256 principal)
        internal
        returns (uint256 tokenId)
    {
        vm.prank(staker);
        staking.stake(principal, 365 days);
        tokenId = staking.userTokenId(staker);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1); // TRANSFER_COOLDOWN
        // `from` is an EOA (not tracked), so this transfer books no per-tokenId credit.
        vm.prank(staker);
        staking.transferFrom(staker, address(escrow), tokenId);
        escrow.callGetReward(tokenId);
        assertEq(staking.unsettledRewardsByTokenId(tokenId), 0, "ISOLATION: clean baseline");
    }

    /// @dev Produce a real per-tokenId credit for `escrow`'s `tokenId` by baking accrual
    ///      at a healthy pool, then starving the pool and letting the escrow claim.
    function _bookShortfall(LedgerTrackedHolder escrow, uint256 tokenId, uint256 leavePool)
        internal
        returns (uint256 credit)
    {
        _bakeAccrual();
        _drainPoolTo(leavePool);
        uint256 perTokenBefore = staking.unsettledRewardsByTokenId(tokenId);
        uint256 bucketBefore = staking.unsettledRewards(address(escrow));
        escrow.callGetReward(tokenId);
        credit = staking.unsettledRewardsByTokenId(tokenId) - perTokenBefore;
        assertGt(credit, 0, "setup: escrow must have booked a per-tokenId shortfall credit");
        assertEq(
            staking.unsettledRewards(address(escrow)) - bucketBefore,
            credit,
            "setup: holder-bucket credit must mirror the per-tokenId credit"
        );
    }

    /// @dev Book a real credit for `escrow` measured on the HOLDER BUCKET. Needed for
    ///      the second holder, whose credit shares the tokenId's aggregate with the
    ///      incumbent's — measuring the aggregate delta would conflate the two.
    ///      By this point the FIRST holder's credit has inflated `totalUnsettledRewards`
    ///      and the pool has been drained, so the sequence must be:
    ///      refund -> let time pass -> bake the accrual -> and only THEN starve.
    function _bookShortfallBucket(LedgerTrackedHolder escrow, uint256 tokenId)
        internal
        returns (uint256 credit)
    {
        _fund(50_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bakeAccrual();
        _drainPoolTo(0);
        uint256 before = staking.unsettledRewards(address(escrow));
        escrow.callGetReward(tokenId);
        credit = staking.unsettledRewards(address(escrow)) - before;
        assertGt(credit, 0, "setup: escrow must have booked a real bucket credit");
    }

    // ═══════════════════════ (1) DESTRUCTION ═══════════════════════

    /// @notice An unrelated tracked holder with an EMPTY bucket must not be able to
    ///         erase another holder's per-tokenId attribution.
    ///
    ///         PRE-FIX: `escrowB.claimUnsettledForTokenId(idA, thief)` sails past the
    ///         `_isTrackedHolder(msg.sender)` gate, the library reads the SHARED
    ///         aggregate (`amount > 0`), sees `unsettledRewards[escrowB] == 0`, takes
    ///         the L-16 zombie branch and sets `unsettledRewardsByTokenId[idA] = 0`.
    ///         escrowA's backing is then stranded forever.
    ///         => the first assertion below FAILS (aggregate is 0, not `credit`), and
    ///            the last one FAILS too (escrowA recovers 0 instead of `credit`).
    ///
    ///         POST-FIX: escrowB's OWN entry is 0, so the call short-circuits to a
    ///         silent no-op before the zombie branch is reachable, and escrowA
    ///         recovers in full.
    function test_emptyBucketForeignHolder_cannotDestroyAttribution() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        uint256 credit = _bookShortfall(escrowA, idA, 1_000 ether);

        // escrowB is tracked but has NEVER been credited anything — the L-16 trigger.
        assertEq(staking.unsettledRewards(address(escrowB)), 0, "escrowB bucket must be empty");
        assertEq(staking.ownerOf(idA), address(escrowA), "idA is escrowed at escrowA");

        uint256 bucketABefore = staking.unsettledRewards(address(escrowA));

        // THE CALL UNDER TEST — a foreign tracked holder touching escrowA's tokenId.
        uint256 paidToThief = escrowB.callClaim(idA, thief);
        assertEq(paidToThief, 0, "foreign holder must be paid nothing");

        assertEq(
            staking.unsettledRewardsByTokenId(idA),
            credit,
            "victim per-tokenId attribution must survive the foreign-holder call"
        );
        assertEq(
            staking.unsettledRewards(address(escrowA)),
            bucketABefore,
            "victim holder bucket must survive the foreign-holder call"
        );

        // ...and escrowA still recovers the FULL credit once the pool is topped up.
        _fund(50_000_000 ether);
        address payee = makeAddr("lg_payee");
        assertEq(escrowA.callClaim(idA, payee), credit, "escrowA must recover its full credit");
        assertEq(token.balanceOf(payee), credit, "recovered credit must land at the recipient");
    }

    // ═══════════════════════ (2) DIVERSION ═══════════════════════

    /// @notice A FUNDED, unrelated tracked holder must not be able to drain another
    ///         holder's slice to an attacker-chosen recipient.
    ///
    ///         PRE-FIX: the drain succeeds — `min(aggregate[idA], bucket[escrowB],
    ///         pool)` is non-zero, so tokens move to `thief`, escrowA's attribution is
    ///         decremented and escrowB's own borrowers' backing is consumed.
    ///         => `token.balanceOf(thief)` assertion FAILS.
    ///
    ///         POST-FIX: escrowB's own entry on idA is 0 => silent no-op, nothing moves.
    function test_fundedForeignHolder_cannotDivertAnotherHoldersSlice() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);
        uint256 idB = _seed(bob, escrowB, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        uint256 creditA = _bookShortfall(escrowA, idA, 1_000 ether);
        uint256 creditB = _bookShortfall(escrowB, idB, 0);

        assertGt(staking.unsettledRewards(address(escrowB)), 0, "escrowB must hold its own bucket");

        // Refund the pool so a drain would actually move tokens.
        _fund(50_000_000 ether);

        uint256 bucketBBefore = staking.unsettledRewards(address(escrowB));
        uint256 thiefBefore = token.balanceOf(thief);

        // THE CALL UNDER TEST.
        uint256 paid = escrowB.callClaim(idA, thief);

        assertEq(paid, 0, "foreign holder must be paid nothing");
        assertEq(token.balanceOf(thief), thiefBefore, "no tokens may reach the attacker recipient");
        assertEq(
            staking.unsettledRewardsByTokenId(idA), creditA, "escrowA attribution must be untouched"
        );
        assertEq(
            staking.unsettledRewards(address(escrowB)),
            bucketBBefore,
            "escrowB bucket untouched (its own borrowers' backing preserved)"
        );

        // No-regression: each escrow still drains its OWN tokenId in full.
        address payeeA = makeAddr("lg_payeeA");
        address payeeB = makeAddr("lg_payeeB");
        assertEq(escrowA.callClaim(idA, payeeA), creditA, "escrowA drains its own slice");
        assertEq(escrowB.callClaim(idB, payeeB), creditB, "escrowB drains its own slice");
    }

    // ═══════════ NO STRANDING — the round-2 design's fatal flaw is absent ═══════════

    /// @notice THE ROUND-2 REGRESSION THIS PINS (ported from the reviewer's
    ///         `test_conflictSkippedCredit_permanentlyBricksDeWhitelist`, with the
    ///         expectation INVERTED).
    ///
    ///         The rejected round-2 design carried a single `mapping(uint256 => address)`
    ///         attribution slot plus a "conflict" rule that SKIPPED the per-tokenId
    ///         credit when another holder still had a live balance on that tokenId. The
    ///         skipped amount still landed in `unsettledRewards[escrowB]` with NO slot
    ///         backing it — and since a tracked holder is barred from `claimUnsettled`
    ///         (:1719) and `claimUnsettledFor` (:1751), it was permanently undrainable.
    ///         `applyLendingContract(escrowB, false)` then reverted `PendingLendingResidue`
    ///         (:2223) FOREVER, and the sister guard `PendingRestakingResidue` (:2189)
    ///         bricked restaking rotation the same way. The amount also stayed pinned
    ///         inside `totalUnsettledRewards`, permanently shrinking
    ///         `rewardPool = balance - totalStaked - totalUnsettledRewards` for EVERY user.
    ///
    ///         The per-holder LEDGER has no conflict case at all: escrowB's credit gets
    ///         its own entry, escrowB drains it in full, its bucket empties, and the
    ///         operator can retire it. No stranding, no admin lockout.
    function test_secondHolderCredit_drainsFully_andDeWhitelistSucceeds() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        uint256 creditA = _bookShortfall(escrowA, idA, 1_000 ether);

        // escrowA hands the NFT back with its residue still live (pool starved), and the
        // position moves on to a SECOND tracked holder — the round-2 "conflict" flow.
        escrowA.callTransfer(alice, idA);
        vm.prank(alice);
        staking.transferFrom(alice, address(escrowB), idA);
        assertEq(staking.ownerOf(idA), address(escrowB), "escrowB now holds it");
        assertGt(staking.unsettledRewardsByTokenId(idA), 0, "setup: escrowA residue still live");

        // escrowB books a real credit of its own on the SAME tokenId.
        uint256 creditB = _bookShortfallBucket(escrowB, idA);

        // Hand the NFT back so `PendingLendingPositions` is not the binding guard.
        escrowB.callTransfer(alice, idA);
        assertEq(staking.balanceOf(address(escrowB)), 0, "escrowB must escrow no positions");

        // Fund generously so no drain can be pool-limited.
        _fund(50_000_000 ether);

        // escrowB drains its OWN bucket to zero through its only legal route.
        escrowB.callClaim(idA, address(escrowB));
        assertEq(
            staking.unsettledRewards(address(escrowB)),
            0,
            "escrowB must be able to fully drain its own credit (round-2 stranded it here)"
        );

        // ...therefore the operator CAN retire escrowB. (Round-2: reverts forever.)
        admin.proposeLendingContract(address(escrowB), false);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        admin.executeLendingContract();
        assertFalse(staking.isLendingContract(address(escrowB)), "escrowB must be retirable");

        // And escrowA's slice was never touched by any of it.
        assertGe(staking.unsettledRewardsByTokenId(idA), creditA, "escrowA residue preserved");
        assertGt(creditB, 0, "sanity: escrowB really did hold a credit");
    }

    /// @notice NO GRIEFING. Round-2's "re-point the attribution slot only when it is
    ///         unset or fully drained" rule meant 1 wei of undrained residue denied the
    ///         per-tokenId path to EVERY future holder of that tokenId, permanently.
    ///         With a per-holder ledger there is no slot to deny: escrowA keeps an
    ///         un-drained residue live for the whole test and escrowB is still credited
    ///         and still drains in full.
    function test_undrainedResidue_doesNotDenyTheNextHolder() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bookShortfall(escrowA, idA, 1_000 ether);

        // The hand-back itself settles one last slice to escrowA (pool still starved),
        // so escrowA's entry is measured AFTER it, not from the first credit alone.
        escrowA.callTransfer(alice, idA);
        uint256 owedA = staking.unsettledRewardsByTokenId(idA);
        assertGt(owedA, 0, "setup: escrowA residue must be live");

        vm.prank(alice);
        staking.transferFrom(alice, address(escrowB), idA);

        uint256 creditB = _bookShortfallBucket(escrowB, idA);
        _fund(50_000_000 ether);

        // escrowA's residue is STILL live and undrained at this point — under the
        // rejected "re-point only when unset or stale" rule that alone denied escrowB
        // the per-tokenId path forever (a 1-wei griefing DoS).
        assertEq(
            staking.unsettledRewardsByTokenId(idA), owedA + creditB, "both slices present"
        );

        address payeeB = makeAddr("lg_payeeB_grief");
        assertEq(
            escrowB.callClaim(idA, payeeB),
            creditB,
            "escrowB must drain its FULL credit despite escrowA's live residue"
        );
        assertEq(token.balanceOf(payeeB), creditB, "escrowB's credit must reach its recipient");

        // ...and escrowA is still whole afterwards.
        address payeeA = makeAddr("lg_payeeA_grief");
        assertEq(escrowA.callClaim(idA, payeeA), owedA, "escrowA still drains its own residue");
        assertEq(
            staking.unsettledRewardsByTokenId(idA), 0, "aggregate fully drained by the two owners"
        );
    }

    /// @notice LOCKSTEP + the sum invariant, proved behaviourally: with two holders
    ///         credited on one tokenId, the public aggregate equals the sum of what each
    ///         holder can actually drain, and every drain moves aggregate,
    ///         totalUnsettledRewards and the holder bucket by the same amount.
    function test_aggregateEqualsSumOfWhatHoldersCanDrain() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bookShortfall(escrowA, idA, 1_000 ether);

        // Everything on the aggregate up to here is escrowA's (it is the only holder
        // that has ever been credited on idA), including the hand-back settlement.
        escrowA.callTransfer(alice, idA);
        uint256 entryA = staking.unsettledRewardsByTokenId(idA);
        assertGt(entryA, 0, "setup: escrowA entry must be live");

        vm.prank(alice);
        staking.transferFrom(alice, address(escrowB), idA);
        _bookShortfallBucket(escrowB, idA);
        escrowB.callTransfer(alice, idA);

        _fund(50_000_000 ether);

        uint256 aggBefore = staking.unsettledRewardsByTokenId(idA);
        uint256 entryB = aggBefore - entryA; // by the sum invariant
        assertGt(entryB, 0, "setup: escrowB must hold an entry of its own");

        uint256 totalBefore = staking.totalUnsettledRewards();
        uint256 bucketBBefore = staking.unsettledRewards(address(escrowB));

        uint256 paidB = escrowB.callClaim(idA, address(escrowB));
        assertEq(paidB, entryB, "escrowB drains exactly its own entry, never escrowA's");
        assertEq(staking.unsettledRewardsByTokenId(idA), aggBefore - paidB, "aggregate -= paid");
        assertEq(staking.totalUnsettledRewards(), totalBefore - paidB, "global total -= paid");
        assertEq(
            staking.unsettledRewards(address(escrowB)), bucketBBefore - paidB, "bucket -= paid"
        );

        uint256 paidA = escrowA.callClaim(idA, address(escrowA));
        assertEq(paidA, entryA, "escrowA drains exactly its own entry");
        assertEq(
            staking.unsettledRewardsByTokenId(idA),
            0,
            "SUM INVARIANT: aggregate == sum of the two holders' entries, so it is now 0"
        );
    }

    // ═══════════════ NO-REGRESSION PINS (must hold pre- AND post-fix) ═══════════════

    /// @notice REQUIREMENT 1 — the documented C-1 POST-transfer residue pull must keep
    ///         working. This is precisely what the reverted H-11
    ///         `ownerOf(tokenId) == msg.sender` check broke: TegridyRestaking.unrestake
    ///         and TegridyLending.repayLoan hand the NFT back to the user FIRST and
    ///         drain the per-tokenId residue AFTER, at which point `ownerOf` is the
    ///         user, not the crediting holder.
    ///
    ///         The fix records attribution at CREDIT time, so it survives the NFT moving
    ///         back — and the transfer-out itself credits the OUTGOING tracked holder
    ///         via `_settleRewardsOnTransfer(tokenId, from)`.
    function test_pin_postTransferResiduePull_stillWorks() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bookShortfall(escrowA, idA, 1_000 ether);

        // Hand the NFT back to the user, exactly like unrestake / repayLoan.
        escrowA.callTransfer(alice, idA);
        assertEq(staking.ownerOf(idA), alice, "user owns the NFT again");

        uint256 owed = staking.unsettledRewardsByTokenId(idA);
        assertGt(owed, 0, "pin setup: residue must survive the hand-back");

        _fund(50_000_000 ether);

        assertEq(
            escrowA.callClaim(idA, alice),
            owed,
            "crediting holder must still drain AFTER returning the NFT"
        );
        assertEq(staking.unsettledRewardsByTokenId(idA), 0, "residue fully drained");
    }

    /// @notice REQUIREMENT 1 (burn leg) — `withdraw` burns the NFT, so `ownerOf` reverts.
    ///         An attributed residue must still be drainable by its holder.
    function test_pin_residueSurvivesBurn_attributedHolderStillDrains() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bookShortfall(escrowA, idA, 1_000 ether);

        escrowA.callTransfer(alice, idA);
        vm.warp(vm.getBlockTimestamp() + 400 days);
        _fund(50_000_000 ether);
        vm.prank(alice);
        staking.withdraw(idA);

        vm.expectRevert();
        staking.ownerOf(idA);

        uint256 owed = staking.unsettledRewardsByTokenId(idA);
        if (owed > 0) {
            assertEq(escrowA.callClaim(idA, alice), owed, "attributed holder must drain post-burn");
        }
    }

    /// @notice With nothing attributed for a tokenId the call must stay a silent no-op
    ///         returning 0 — NOT a revert. All ten external call sites in
    ///         TegridyRestaking / TegridyLending are try-wrapped precisely because the
    ///         call is documented best-effort; turning "nothing of yours here" into a
    ///         revert would convert a benign no-op into a swallowed error.
    function test_pin_unattributedTokenId_isNoOpNotRevert() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        assertEq(staking.unsettledRewardsByTokenId(idA), 0, "pin setup: nothing credited yet");
        assertEq(escrowA.callClaim(idA, alice), 0, "rightful holder: no-op");
        assertEq(escrowB.callClaim(idA, bob), 0, "foreign holder: no-op, no revert");
    }

    /// @notice The two host-side guards are untouched by this change.
    function test_pin_hostGuardsUnchanged() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        // Untracked caller still reverts Unauthorized.
        vm.prank(thief);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledForTokenId(idA, thief);

        // Zero recipient still reverts ZeroAddress.
        vm.expectRevert(TegridyStaking.ZeroAddress.selector);
        escrowA.callClaim(idA, address(0));

        // Tracked holders are still barred from the bucket-wide drains — the property
        // that makes `claimUnsettledForTokenId` their ONLY route, and therefore the
        // reason a stranded credit would be unrecoverable.
        vm.prank(address(escrowA));
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettled();

        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(address(escrowA));
    }

    // ═══════════════════ (4) OBSERVABILITY — the ledger must be ═══════════════════
    // ═══════════════════     reconstructable off-chain           ═══════════════════

    /// @notice The public per-(tokenId, holder) view must report exactly the entry the
    ///         drain will use, per holder — and in particular must NOT collapse to the
    ///         aggregate when two holders share a tokenId. This view is what every
    ///         "MY residue" consumer in TegridyLending / TegridyRestaking now reads.
    function test_observability_perHolderView_isPerHolderNotAggregate() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);

        vm.warp(vm.getBlockTimestamp() + 100_000); // accrue, so there is something to bake
        uint256 creditA = _bookShortfall(escrowA, idA, 0);

        // Hand the NFT to the second tracked holder and give IT a credit on the SAME
        // tokenId, so the aggregate is genuinely the sum of two holders' entries.
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        escrowA.callTransfer(address(escrowB), idA);
        uint256 creditB = _bookShortfallBucket(escrowB, idA);

        assertEq(staking.unsettledByTokenIdHolder(idA, address(escrowA)), creditA, "escrowA's own entry");
        assertEq(staking.unsettledByTokenIdHolder(idA, address(escrowB)), creditB, "escrowB's own entry");
        assertEq(
            staking.unsettledRewardsByTokenId(idA),
            creditA + creditB,
            "aggregate must be the SUM of the two entries"
        );
        // The distinction the whole fix rests on: aggregate != either holder's entry.
        assertGt(staking.unsettledRewardsByTokenId(idA), creditA, "aggregate strictly exceeds A's entry");
        assertGt(staking.unsettledRewardsByTokenId(idA), creditB, "aggregate strictly exceeds B's entry");

        // An address that never held the tokenId reads zero.
        assertEq(staking.unsettledByTokenIdHolder(idA, thief), 0, "untracked address has no entry");
    }

    /// @notice The debit must be attributable to the HOLDER whose entry moved, not only
    ///         to the arbitrary payout `recipient`. Pre-fix only
    ///         `UnsettledClaimedForTokenId(tokenId, recipient, amount)` was emitted, so
    ///         an indexer could not tell WHOSE entry had been debited and the ledger was
    ///         not reconstructable from the debit side.
    /// @dev    The OLD event must still fire, unchanged, in the same call — deployed
    ///         indexers depend on it. Both are asserted.
    function test_observability_debitEventCarriesHolder() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);
        vm.warp(vm.getBlockTimestamp() + 100_000); // accrue, so there is something to bake
        uint256 credit = _bookShortfall(escrowA, idA, 0);
        _fund(50_000_000 ether); // refill so the claim actually pays

        // The pre-existing event, byte-identical (topic0 + args) to pre-fix.
        vm.expectEmit(true, true, false, true, address(staking));
        emit UnsettledClaimedForTokenId(idA, alice, credit);
        // The NEW event, naming the HOLDER (escrowA) alongside the recipient (alice).
        vm.expectEmit(true, true, true, true, address(staking));
        emit UnsettledClaimedForTokenIdHolder(idA, address(escrowA), alice, credit);

        assertEq(escrowA.callClaim(idA, alice), credit, "claim must pay the full entry");
    }

    /// @notice The L-16 zombie-cleanup branch mutates the ledger (entry -> 0, aggregate
    ///         down by that entry) while paying nothing. Pre-fix it emitted NOTHING at
    ///         all, so an off-chain reconstruction would stay permanently over-stated.
    function test_observability_zombieCleanupIsObservable() public {
        _fund(50_000_000 ether);
        uint256 idA = _seed(alice, escrowA, 100_000 ether);
        vm.warp(vm.getBlockTimestamp() + 100_000); // accrue, so there is something to bake
        uint256 credit = _bookShortfall(escrowA, idA, 0);

        // Force the invariant-break the branch defends: entry non-zero, bucket EMPTY.
        // The branch is documented as unreachable in normal flow (entry and bucket are
        // credited in lockstep), so the only honest way to exercise it is to write the
        // broken state directly. `stdstore` resolves the slot through the public getter
        // rather than hardcoding an index, so a future storage reshuffle cannot silently
        // turn this test into a no-op.
        stdstore.target(address(staking)).sig(staking.unsettledRewards.selector).with_key(address(escrowA))
            .checked_write(uint256(0));
        assertEq(staking.unsettledRewards(address(escrowA)), 0, "setup: bucket must be emptied");
        assertEq(
            staking.unsettledByTokenIdHolder(idA, address(escrowA)),
            credit,
            "setup: entry must still be non-zero (this is the invariant break)"
        );

        vm.expectEmit(true, true, false, true, address(staking));
        emit UnsettledZombieEntryCleared(idA, address(escrowA), credit);

        assertEq(escrowA.callClaim(idA, alice), 0, "zombie cleanup pays nothing");
        assertEq(staking.unsettledByTokenIdHolder(idA, address(escrowA)), 0, "entry zeroed");
    }
}

// ─── Fixtures ────────────────────────────────────────────────────────────

contract LedgerMockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract LedgerMockNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external {
        _mint(to, _nextId++);
    }
}

/// @notice Minimal stand-in for a TRACKED holder (lending escrow / restaking contract):
///         holds a staking position NFT, is flagged via `applyLendingContract` so
///         `_isTrackedHolder(this) == true`, and forwards calls so
///         `msg.sender == address(this)`.
contract LedgerTrackedHolder {
    TegridyStaking public immutable staking;

    constructor(TegridyStaking _staking) {
        staking = _staking;
    }

    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function callClaim(uint256 tokenId, address recipient) external returns (uint256) {
        return staking.claimUnsettledForTokenId(tokenId, recipient);
    }

    function callTransfer(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
