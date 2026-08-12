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

/// @title  [staking-attribution] a FOREIGN tracked holder's residue on the collateral
///         tokenId must not reduce what the borrower is paid at settlement.
///
/// @notice THE DEFECT (MEDIUM — borrower/lender UNDER-PAYMENT).
///         `TegridyLending.acceptOffer` snapshots the collateral's pre-existing reward
///         residue so the loan only pays out what IT earned:
///
///             loanRewardsSnapshot[loanId] = staking.unsettledRewardsByTokenId(_tokenId);
///                                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ AGGREGATE
///
///         and at settlement splits the drain against it:
///
///             priorShare = min(snapshot, totalDrained);
///             myShare    = totalDrained - priorShare;   // -> paid to the borrower
///
///         Under the per-(tokenId, holder) ledger those two quantities stopped being
///         the same thing. `totalDrained` comes from `claimUnsettledForTokenId`, which
///         drains ONLY the lending contract's OWN entry — but the snapshot read the
///         AGGREGATE `sum(_unsettledByTokenIdHolder[tokenId][*])`, which also counts a
///         FOREIGN tracked holder's undrained residue on the very same tokenId (here:
///         a restaking-style escrow that exited an earlier cycle against a starved
///         reward pool). The foreign residue is money lending can never touch, yet it
///         was subtracted from the borrower's payout as if it were a "prior holder's
///         slice" of THIS contract's drain.
///
///         Net effect: every wei of foreign residue silently suppressed a wei of the
///         borrower's earnings, and once foreign residue >= what the loan earned,
///         `myShare` collapsed to ZERO — the borrower was paid nothing at all while
///         the tokens sat in the lending contract, unattributed.
///
/// @notice THE FIX: snapshot (and every other "MY residue" read) uses the new
///         `staking.unsettledByTokenIdHolder(tokenId, address(this))`, so the snapshot
///         and the drain measure the SAME ledger entry again.
///
/// @dev    MUTATION-CHECKED. Reverting only TegridyLending's snapshot line to the
///         aggregate makes `test_foreignResidue_mustNotReduceBorrowerPayout` fail with
///         a real, non-trivial delta — see the agent notes for captured forge output.
contract StakingAttributionLendingUnderpayTest is Test {
    UnderpayToken public toweli;
    UnderpayNFT public jbac;
    UnderpayWETH public weth;
    UnderpayPair public pair;

    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyLending public lending;
    TegridyLendingAdmin public lendingAdmin;

    /// @dev The FOREIGN tracked holder — stands in for TegridyRestaking (or any other
    ///      whitelisted escrow). Whitelisted so `_isTrackedHolder` is true for it, which
    ///      is what lets it book a per-(tokenId, holder) entry of its own.
    UnderpayEscrow public foreign;

    address public treasury = makeAddr("up_treasury");
    address public alice = makeAddr("up_alice"); // borrower, owns the staking position
    address public dan = makeAddr("up_dan");     // lender

    uint256 public aliceTokenId;

    function setUp() public {
        vm.chainId(1);

        toweli = new UnderpayToken();
        jbac = new UnderpayNFT();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        weth = new UnderpayWETH();
        pair = new UnderpayPair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);
        TegridyTWAP twap = new TegridyTWAP(address(this), address(0));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        foreign = new UnderpayEscrow(staking);

        // Accept the staking NFT as collateral (48h timelock rolled forward).
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        // Whitelist BOTH the lending contract and the foreign escrow as tracked holders
        // in TegridyStaking, and raise the L-06 unsettled cap so a large shortfall books
        // in full. `pendingLendingContract` is a single slot, so these take two rounds.
        stakingAdmin.proposeLendingContract(address(lending), true);
        stakingAdmin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        stakingAdmin.executeLendingContract();
        stakingAdmin.executeMaxUnsettledRewards();

        stakingAdmin.proposeLendingContract(address(foreign), true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        stakingAdmin.executeLendingContract();

        assertTrue(staking.isLendingContract(address(lending)), "setup: lending must be tracked");
        assertTrue(staking.isLendingContract(address(foreign)), "setup: foreign must be tracked");

        // Alice stakes and gets her position NFT.
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 25 hours); // TRANSFER_COOLDOWN

        vm.deal(dan, 100 ether);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(uint256 amt) internal {
        toweli.approve(address(staking), amt);
        staking.notifyRewardAmount(amt);
    }

    /// @dev Bake elapsed emission into `rewardPerTokenStored` while the pool is still
    ///      healthy. Accrual is POOL-CAPPED, so without this a later drain would just
    ///      prevent the accrual rather than produce a bookable shortfall.
    function _bakeAccrual() internal {
        toweli.approve(address(staking), 1_000 ether); // MIN_NOTIFY_AMOUNT
        staking.notifyRewardAmount(1_000 ether);
    }

    function _rewardPool() internal view returns (uint256) {
        uint256 bal = toweli.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 d = pool - leavePool;
        if (d == 0) return;
        vm.prank(address(staking));
        toweli.transfer(address(0xDEAD), d);
    }

    /// @dev Give the FOREIGN escrow a real, undrained per-(tokenId, holder) entry on
    ///      Alice's tokenId, then hand the NFT back to Alice. This is the pre-existing
    ///      state a real tokenId carries after a restake cycle that exited while the
    ///      staking reward pool was short.
    function _seedForeignResidue() internal returns (uint256 residue) {
        _fund(50_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 100_000);

        vm.prank(alice);
        staking.transferFrom(alice, address(foreign), aliceTokenId);

        // Settle the transfer-window accrual cleanly first so the residue we book below
        // is the only thing on the ledger.
        foreign.callGetReward(aliceTokenId);

        // Let real time pass so there is fresh accrual to bake. Accrual is POOL-CAPPED,
        // so it must be baked into `rewardPerTokenStored` while the pool is still
        // healthy — only THEN starve the pool, so the next settle finds an owed amount
        // it cannot pay and books it as an unsettled per-tokenId shortfall credit.
        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bakeAccrual();
        _drainPoolTo(0);
        foreign.callGetReward(aliceTokenId);

        residue = staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign));
        assertGt(residue, 0, "setup: foreign holder must hold a real per-tokenId residue");

        // Hand the NFT back to Alice. Attribution is recorded at CREDIT time and never
        // re-derived from `ownerOf`, so the foreign entry survives the transfer — that
        // persistence is the whole point of the ledger (and of the C-1 post-transfer
        // drain the pins protect).
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        foreign.callTransfer(alice, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), alice, "setup: NFT returns to alice");
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign)),
            residue,
            "setup: foreign residue survives the transfer back"
        );
    }

    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(dan);
        uint256 offer = lending.createLoanOffer{value: 1 ether}(1000, 7 days, address(staking), 5000 ether, 0);
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);
        vm.prank(alice);
        loanId = lending.acceptOffer(offer, aliceTokenId);
    }

    // ═══════════════════════ THE UNDER-PAYMENT ═══════════════════════

    /// @notice A foreign tracked holder's residue on the collateral tokenId must not
    ///         reduce the borrower's settlement payout by even one wei.
    ///
    ///         PRE-FIX: `loanRewardsSnapshot` reads the AGGREGATE, which here is
    ///         `foreignResidue + 0` — a number lending can never drain. At repay,
    ///         `totalDrained` is lending's own entry only, so
    ///         `priorShare = min(snapshot, totalDrained) == totalDrained` and
    ///         `myShare == 0`: Alice is paid NOTHING. The final assertion fails.
    ///
    ///         POST-FIX: the snapshot reads lending's OWN entry (0 at open), so
    ///         `priorShare == 0` and Alice receives the full amount the loan earned.
    function test_foreignResidue_mustNotReduceBorrowerPayout() public {
        uint256 foreignResidue = _seedForeignResidue();

        // The aggregate is polluted by the foreign entry; lending's own entry is clean.
        // These two readings differing is precisely the condition the bug needed.
        assertEq(
            staking.unsettledRewardsByTokenId(aliceTokenId),
            foreignResidue,
            "precondition: aggregate carries the foreign residue"
        );

        uint256 loanId = _openLoan();

        // THE FIX, observed directly: the snapshot must be lending's OWN entry, NOT the
        // aggregate. Pre-fix this reads `foreignResidue`.
        uint256 snapshot = lending.loanRewardsSnapshot(loanId);
        uint256 lendingOwnAtOpen = staking.unsettledByTokenIdHolder(aliceTokenId, address(lending));
        assertEq(snapshot, lendingOwnAtOpen, "snapshot must equal LENDING'S OWN entry at open");
        assertLt(snapshot, foreignResidue, "snapshot must not have absorbed the foreign residue");

        // Refill the pool and let the loan earn. The pool must be HEALTHY at repay:
        // the close-transfer credits lending's ledger entry either way, but the
        // post-transfer `claimUnsettledForTokenId` can only actually pay out of a
        // funded pool, and it is that payout the split then attributes.
        _fund(50_000_000 ether);
        skip(3 days);

        uint256 aliceBefore = toweli.balanceOf(alice);
        uint256 lendingBefore = toweli.balanceOf(address(lending));

        uint256 repay = 1 ether + 0.05 ether;
        vm.deal(alice, repay);
        vm.prank(alice);
        lending.repayLoan{value: repay}(loanId);

        uint256 earned = toweli.balanceOf(alice) - aliceBefore;
        uint256 lendingRetained = toweli.balanceOf(address(lending)) - lendingBefore;

        // Sanity: the scenario must be non-degenerate — the loan really did earn and
        // really did drain something, otherwise the assertion below is vacuous.
        assertGt(earned + lendingRetained, 0, "scenario: the loan must have drained something");

        // THE ASSERTION THAT FAILS PRE-FIX. `priorShare = min(snapshot, totalDrained)`
        // is the slice lending WITHHOLDS from the borrower for a genuine prior holder.
        // Lending has no prior entry on this tokenId, so it must withhold NOTHING.
        // Pre-fix the snapshot was the aggregate, so lending withheld
        // `min(foreignResidue, totalDrained) > 0` — the borrower's own earnings,
        // stranded against another holder's residue that lending can never drain.
        // Asserted as an exact equality so it holds regardless of whether the foreign
        // residue happens to be larger or smaller than what the loan earned.
        assertEq(
            lendingRetained,
            0,
            "UNDER-PAYMENT: lending withheld the borrower's earnings against a FOREIGN holder's residue"
        );
        assertGt(earned, 0, "UNDER-PAYMENT: the borrower must receive what the loan earned");

        // And the foreign holder's own entry is untouched by any of it — lending never
        // drained, reduced, or laid claim to another holder's money.
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign)),
            foreignResidue,
            "foreign holder's ledger entry must be untouched by the loan lifecycle"
        );
    }

    /// @notice Sister assertion on the DEFAULT path (`claimDefaultedCollateral`), which
    ///         runs the same `priorShare / myShare` split for the LENDER. Same defect,
    ///         same fix; kept separate so a regression in either path is unambiguous.
    function test_foreignResidue_mustNotReduceLenderPayoutOnDefault() public {
        uint256 foreignResidue = _seedForeignResidue();
        uint256 loanId = _openLoan();

        assertLt(
            lending.loanRewardsSnapshot(loanId),
            foreignResidue,
            "snapshot must not have absorbed the foreign residue"
        );

        // Blow the deadline with a healthy pool so the close-transfer credits lending's
        // entry and the post-transfer pull can actually pay it out.
        _fund(50_000_000 ether);
        skip(8 days);

        uint256 danBefore = toweli.balanceOf(dan);
        uint256 lendingBefore = toweli.balanceOf(address(lending));
        vm.prank(dan);
        lending.claimDefaultedCollateral(loanId);

        uint256 lenderEarned = toweli.balanceOf(dan) - danBefore;
        uint256 lendingRetained = toweli.balanceOf(address(lending)) - lendingBefore;

        assertGt(lenderEarned + lendingRetained, 0, "scenario: the default must have drained something");
        assertEq(
            lendingRetained,
            0,
            "UNDER-PAYMENT: lending withheld the lender's earnings against a FOREIGN holder's residue"
        );
        assertGt(lenderEarned, 0, "UNDER-PAYMENT: the lender must receive what the loan earned");
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign)),
            foreignResidue,
            "foreign holder's ledger entry must be untouched by the default path"
        );
    }

    /// @notice The foreign holder can still drain its own residue afterwards — the fix
    ///         redirects the READ, it never strands the value.
    function test_foreignHolder_canStillDrainItsOwnResidueAfterTheLoan() public {
        uint256 foreignResidue = _seedForeignResidue();
        uint256 loanId = _openLoan();

        _fund(50_000_000 ether);
        skip(3 days);
        uint256 repay = 1 ether + 0.05 ether;
        vm.deal(alice, repay);
        vm.prank(alice);
        lending.repayLoan{value: repay}(loanId);

        // Refill so the pool can honour the foreign holder's claim.
        _fund(50_000_000 ether);

        address sink = makeAddr("up_sink");
        uint256 paid = foreign.callClaim(aliceTokenId, sink);

        assertEq(paid, foreignResidue, "foreign holder recovers its full residue");
        assertEq(toweli.balanceOf(sink), foreignResidue, "residue lands at the foreign holder's recipient");
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign)),
            0,
            "foreign entry fully drained"
        );
    }
}

// ─── Mocks ──────────────────────────────────────────────────────────

contract UnderpayToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract UnderpayNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JBAC", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract UnderpayWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    receive() external payable {}
}

contract UnderpayPair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address _token0, address _token1, uint112 _r0, uint112 _r1) {
        token0 = _token0;
        token1 = _token1;
        reserve0 = _r0;
        reserve1 = _r1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

/// @dev A whitelisted tracked holder standing in for TegridyRestaking.
contract UnderpayEscrow {
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

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
