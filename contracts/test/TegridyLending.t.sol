// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

// ─── Mock Contracts ─────────────────────────────────────────────────

contract MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JBAC", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev Minimal WETH mock for testing WETHFallbackLib
contract MockWETHLending {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

/// @dev Contract that rejects ETH — used to test failed ETH transfers
contract ETHRejecter {
    receive() external payable {
        revert("no ETH");
    }
}

/// @dev Minimal TegridyPair mock used by TegridyLending's optional ETH-floor oracle.
///      Seeded with deterministic reserves so tests can reason about price deterministically.
contract MockTegridyPairLending {
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

    function setReserves(uint112 _r0, uint112 _r1) external {
        reserve0 = _r0;
        reserve1 = _r1;
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────

contract TegridyLendingTest is Test {
    MockToweli public toweli;
    MockJBAC public jbac;
    MockWETHLending public weth;
    MockTegridyPairLending public pair;
    TegridyStaking public staking;
    TegridyLending public lending;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // borrower — has staking NFT
    address public bob = makeAddr("bob");       // lender — has ETH
    address public carol = makeAddr("carol");   // unauthorized third party

    uint256 public aliceTokenId; // alice's staking position NFT

    function setUp() public {
        // 1. Deploy mock tokens
        toweli = new MockToweli();
        jbac = new MockJBAC();

        // 2. Deploy TegridyStaking
        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            1e18 // rewardRate
        );

        // 3. Deploy MockWETH + mock TegridyPair seeded with a 1 TOWELI = 0.001 ETH price,
        //    then TegridyLending. The pair price is irrelevant for tests that pass
        //    `minPositionETHValue = 0` (which is every test in this file by default).
        weth = new MockWETHLending();
        pair = new MockTegridyPairLending(
            address(toweli),
            address(weth),
            1_000_000 ether, // toweli reserve
            1_000 ether      // weth reserve → 1 TOWELI = 0.001 ETH
        );
        // R003: TegridyLending now consults a TWAP for the optional ETH-floor.
        // We deploy a real TegridyTWAP instance — tests in this file all pass
        // `minPositionETHValue = 0`, so `_positionETHValue` is never invoked
        // and the TWAP never needs to be bootstrapped. Tests that exercise
        // the floor live in TegridyLending_ETHFloor.t.sol.
        TegridyTWAP twap = new TegridyTWAP(address(0));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0)); // 5% protocol fee

        // 4. Fund alice with TOWELI and have her stake to get a position NFT
        toweli.transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Warp past the 24h transfer cooldown on the staking NFT
        vm.warp(block.timestamp + 25 hours);

        // Approve lending contract to transfer alice's NFT
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        // 5. Fund bob with ETH for lending
        vm.deal(bob, 100 ether);

        // Fund carol with some ETH
        vm.deal(carol, 10 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CREATION
    // ═══════════════════════════════════════════════════════════════════

    function test_createOffer_success() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000,                   // 10% APR
            30 days,                // duration
            address(staking),       // collateral contract
            5000 ether,             // min position value
            0                       // min position ETH value (0 = disabled)
        );

        assertEq(offerId, 0);
        (
            address lender,
            uint256 principal,
            uint256 aprBps,
            uint256 duration,
            address collateralContract,
            uint256 minPositionValue,
            uint256 minPositionETHValue,
            bool active
        ) = lending.getOffer(0);

        assertEq(lender, bob);
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(duration, 30 days);
        assertEq(collateralContract, address(staking));
        assertEq(minPositionValue, 5000 ether);
        assertEq(minPositionETHValue, 0);
        assertTrue(active);
        assertEq(lending.offerCount(), 1);
    }

    function test_createOffer_revert_zeroAmount() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.ZeroPrincipal.selector);
        lending.createLoanOffer{value: 0}(
            1000, 30 days, address(staking), 5000 ether, 0
        );
    }

    function test_createOffer_revert_principalTooLarge() public {
        vm.deal(bob, 1001 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.PrincipalTooLarge.selector);
        lending.createLoanOffer{value: 1001 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );
    }

    function test_createOffer_revert_aprTooHigh() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.AprTooHigh.selector);
        lending.createLoanOffer{value: 1 ether}(
            50001,                  // exceeds MAX_APR_BPS (50000)
            30 days,
            address(staking),
            5000 ether,
            0
        );
    }

    function test_createOffer_revert_durationTooShort() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooShort.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000,
            12 hours,               // below MIN_DURATION (1 day)
            address(staking),
            5000 ether,
            0
        );
    }

    function test_createOffer_revert_durationTooLong() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooLong.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000,
            366 days,               // exceeds MAX_DURATION (365 days)
            address(staking),
            5000 ether,
            0
        );
    }

    function test_createOffer_revert_zeroCollateralAddress() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.ZeroAddress.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(0), 5000 ether, 0
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CANCELLATION
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelOffer_success() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 5 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );

        uint256 bobBalanceBefore = bob.balance;
        vm.prank(bob);
        lending.cancelOffer(0);

        // ETH refunded
        assertEq(bob.balance, bobBalanceBefore + 5 ether);

        // Offer is no longer active
        (,,,,,,, bool active) = lending.getOffer(0);
        assertFalse(active);
    }

    function test_cancelOffer_revert_notOwner() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );

        vm.prank(carol);
        vm.expectRevert(TegridyLending.NotOfferLender.selector);
        lending.cancelOffer(0);
    }

    function test_cancelOffer_revert_alreadyCancelled() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );

        vm.prank(bob);
        lending.cancelOffer(0);

        vm.prank(bob);
        vm.expectRevert(TegridyLending.OfferNotActive.selector);
        lending.cancelOffer(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LOAN ACCEPTANCE
    // ═══════════════════════════════════════════════════════════════════

    function _createDefaultOffer() internal returns (uint256) {
        vm.prank(bob);
        return lending.createLoanOffer{value: 1 ether}(
            1000,                   // 10% APR
            30 days,
            address(staking),
            1000 ether,             // min position value (alice has 10_000)
            0                       // min position ETH value (0 = disabled)
        );
    }

    function test_acceptOffer_success() public {
        uint256 offerId = _createDefaultOffer();

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        assertEq(loanId, 0);

        // ETH sent to borrower
        assertEq(alice.balance, aliceBalanceBefore + 1 ether);

        // NFT escrowed by lending contract
        assertEq(staking.ownerOf(aliceTokenId), address(lending));

        // Offer deactivated
        (,,,,,,, bool active) = lending.getOffer(offerId);
        assertFalse(active);

        // Loan fields populated
        (
            address borrower,
            address lender,
            uint256 loanOfferId,
            uint256 tokenId,
            uint256 principal,
            uint256 aprBps,
            uint256 startTime,
            uint256 deadline,
            bool repaid,
            bool defaultClaimed
        ) = lending.getLoan(loanId);

        assertEq(borrower, alice);
        assertEq(lender, bob);
        assertEq(loanOfferId, offerId);
        assertEq(tokenId, aliceTokenId);
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(startTime, block.timestamp);
        assertEq(deadline, block.timestamp + 30 days);
        assertFalse(repaid);
        assertFalse(defaultClaimed);
        assertEq(lending.loanCount(), 1);
    }

    function test_acceptOffer_revert_insufficientCollateralValue() public {
        // Create offer with high min position value
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking),
            50_000 ether,           // alice only has 10_000 staked
            0
        );

        vm.prank(alice);
        vm.expectRevert(TegridyLending.InsufficientCollateralValue.selector);
        lending.acceptOffer(offerId, aliceTokenId);
    }

    function test_acceptOffer_revert_notNFTOwner() public {
        uint256 offerId = _createDefaultOffer();

        // Carol tries to use alice's NFT
        vm.prank(carol);
        vm.expectRevert(TegridyLending.NotNFTOwner.selector);
        lending.acceptOffer(offerId, aliceTokenId);
    }

    function test_acceptOffer_revert_offerNotActive() public {
        uint256 offerId = _createDefaultOffer();

        // Cancel offer first
        vm.prank(bob);
        lending.cancelOffer(offerId);

        vm.prank(alice);
        vm.expectRevert(TegridyLending.OfferNotActive.selector);
        lending.acceptOffer(offerId, aliceTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REPAYMENT
    // ═══════════════════════════════════════════════════════════════════

    function _createAndAcceptLoan() internal returns (uint256 loanId) {
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        loanId = lending.acceptOffer(offerId, aliceTokenId);
    }

    function test_repayLoan_interestMath() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp forward 30 days (full duration)
        vm.warp(block.timestamp + 30 days);

        // Calculate expected interest: principal * aprBps * elapsed / BPS / SECONDS_PER_YEAR
        // = 1 ether * 1000 * 30 days / 10000 / 365 days
        uint256 expectedInterest = lending.calculateInterest(1 ether, 1000, block.timestamp - 30 days, block.timestamp);
        uint256 totalRepayment = 1 ether + expectedInterest;

        // Fund alice for repayment
        vm.deal(alice, totalRepayment + 1 ether);

        uint256 bobBalanceBefore = bob.balance;
        uint256 treasuryBalanceBefore = treasury.balance;

        vm.prank(alice);
        lending.repayLoan{value: totalRepayment}(loanId);

        // Protocol fee = interest * 500 / 10000 = 5% of interest
        uint256 expectedFee = (expectedInterest * 500) / 10000;
        uint256 expectedLenderAmount = 1 ether + expectedInterest - expectedFee;

        // Lender received principal + interest - fee
        assertEq(bob.balance - bobBalanceBefore, expectedLenderAmount);

        // Treasury received fee
        assertEq(treasury.balance - treasuryBalanceBefore, expectedFee);

        // NFT returned to borrower
        assertEq(staking.ownerOf(aliceTokenId), alice);

        // Loan marked repaid
        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }

    function test_repayLoan_excessRefund() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 15 days);

        uint256 interest = lending.calculateInterest(1 ether, 1000, block.timestamp - 15 days, block.timestamp);
        uint256 totalDue = 1 ether + interest;
        uint256 overpayment = 0.5 ether;

        vm.deal(alice, totalDue + overpayment);

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        lending.repayLoan{value: totalDue + overpayment}(loanId);

        // Alice should get the overpayment refunded (her balance should drop by only totalDue)
        assertEq(aliceBalanceBefore - alice.balance, totalDue);
    }

    function test_repayLoan_revert_insufficientPayment() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 15 days);

        // Send less than required
        vm.deal(alice, 0.5 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyLending.InsufficientRepayment.selector);
        lending.repayLoan{value: 0.5 ether}(loanId);
    }

    function test_repayLoan_revert_notBorrower() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.deal(carol, 2 ether);
        vm.prank(carol);
        vm.expectRevert(TegridyLending.NotBorrower.selector);
        lending.repayLoan{value: 2 ether}(loanId);
    }

    function test_repayLoan_revert_alreadyRepaid() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 1 days);
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);

        vm.deal(alice, repaymentAmount * 2);
        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Try to repay again
        vm.prank(alice);
        vm.expectRevert(TegridyLending.LoanAlreadyRepaid.selector);
        lending.repayLoan{value: repaymentAmount}(loanId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEFAULT
    // ═══════════════════════════════════════════════════════════════════

    function test_claimDefault_success() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp past the deadline
        vm.warp(block.timestamp + 31 days);

        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        // Lender received the NFT
        assertEq(staking.ownerOf(aliceTokenId), bob);

        // Loan marked as default claimed
        (,,,,,,,,,bool defaultClaimed) = lending.getLoan(loanId);
        assertTrue(defaultClaimed);

        // isDefaulted returns false now (it was claimed)
        assertFalse(lending.isDefaulted(loanId));
    }

    function test_claimDefault_revert_deadlineNotReached() public {
        uint256 loanId = _createAndAcceptLoan();

        // Still within the loan period
        vm.warp(block.timestamp + 15 days);

        vm.prank(bob);
        vm.expectRevert(TegridyLending.DeadlineNotReached.selector);
        lending.claimDefaultedCollateral(loanId);
    }

    function test_claimDefault_revert_notLender() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 31 days);

        vm.prank(carol);
        vm.expectRevert(TegridyLending.NotLoanLender.selector);
        lending.claimDefaultedCollateral(loanId);
    }

    function test_cannotRepayAfterDefaultClaim() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 31 days);

        // Lender claims default
        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        // Borrower tries to repay — should fail
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyLending.LoanAlreadyDefaultClaimed.selector);
        lending.repayLoan{value: 2 ether}(loanId);
    }

    function test_isDefaulted_view() public {
        uint256 loanId = _createAndAcceptLoan();

        // Not defaulted yet
        assertFalse(lending.isDefaulted(loanId));

        // Still not defaulted at deadline edge
        vm.warp(block.timestamp + 30 days);
        assertFalse(lending.isDefaulted(loanId));

        // Defaulted after deadline
        vm.warp(block.timestamp + 1);
        assertTrue(lending.isDefaulted(loanId));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: TIMELOCKED FEE CHANGE
    // ═══════════════════════════════════════════════════════════════════

    function test_proposeAndExecuteFeeChange() public {
        // Propose new fee
        lending.proposeProtocolFeeChange(800); // 8%

        assertEq(lending.pendingProtocolFeeBps(), 800);

        // Cannot execute before timelock
        vm.expectRevert();
        lending.executeProtocolFeeChange();

        // Warp past 48h timelock
        vm.warp(block.timestamp + 48 hours);

        lending.executeProtocolFeeChange();

        assertEq(lending.protocolFeeBps(), 800);
        assertEq(lending.pendingProtocolFeeBps(), 0);
    }

    function test_proposeFeeChange_revert_tooHigh() public {
        vm.expectRevert(TegridyLending.FeeTooHigh.selector);
        lending.proposeProtocolFeeChange(1001); // exceeds MAX_PROTOCOL_FEE_BPS (1000)
    }

    function test_cancelFeeChange() public {
        lending.proposeProtocolFeeChange(800);

        lending.cancelProtocolFeeChange();

        assertEq(lending.pendingProtocolFeeBps(), 0);

        // Original fee unchanged
        assertEq(lending.protocolFeeBps(), 500);
    }

    function test_feeChange_revert_notOwner() public {
        vm.prank(carol);
        vm.expectRevert();
        lending.proposeProtocolFeeChange(800);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: PAUSE
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksNewOffers() public {
        lending.pause();

        vm.prank(bob);
        vm.expectRevert();
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );
    }

    function test_pause_blocksAcceptOffer() public {
        uint256 offerId = _createDefaultOffer();

        lending.pause();

        vm.prank(alice);
        vm.expectRevert();
        lending.acceptOffer(offerId, aliceTokenId);
    }

    function test_pause_blocksRepayment() public {
        uint256 loanId = _createAndAcceptLoan();

        lending.pause();

        vm.deal(alice, 2 ether);
        vm.prank(alice);
        vm.expectRevert();
        lending.repayLoan{value: 2 ether}(loanId);
    }

    function test_unpause_restoresOperations() public {
        lending.pause();
        lending.unpause();

        // Should work again after unpause
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether, 0
        );
        assertEq(offerId, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function test_calculateInterest_zeroDuration() public view {
        uint256 interest = lending.calculateInterest(1 ether, 1000, 100, 100);
        assertEq(interest, 0);
    }

    function test_calculateInterest_fullYear() public view {
        // principal=10 ether, 10% APR, 1 full year
        uint256 interest = lending.calculateInterest(10 ether, 1000, 0, 365 days);
        // 10 ether * 1000 * 365 days / 10000 / 365 days = 1 ether
        assertEq(interest, 1 ether);
    }

    function test_getRepaymentAmount() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 365 days);

        uint256 total = lending.getRepaymentAmount(loanId);
        // principal (1 ether) + 10% interest for 1 year = 1.1 ether
        assertEq(total, 1.1 ether);
    }

    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #1: LoanTooRecent (same-block repayment prevention)
    // ═══════════════════════════════════════════════════════════════════

    function test_repayLoan_revert_sameBlockRepayment() public {
        // Create offer
        uint256 offerId = _createDefaultOffer();

        // Accept offer and try to repay in the same block (same timestamp)
        vm.startPrank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Attempt repayment in the same block — should revert LoanTooRecent
        vm.deal(alice, 2 ether);
        vm.expectRevert(TegridyLending.LoanTooRecent.selector);
        lending.repayLoan{value: 2 ether}(loanId);
        vm.stopPrank();
    }

    function test_repayLoan_succeedsOneSecondAfterAcceptance() public {
        uint256 offerId = _createDefaultOffer();

        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Warp past staking NFT TRANSFER_RATE_LIMIT (1 hour)
        vm.warp(block.timestamp + 1 hours + 1);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #2: calculateInterest edge cases
    // ═══════════════════════════════════════════════════════════════════

    function test_calculateInterest_oneSecond() public view {
        // 1 ether principal, 10% APR, 1 second elapsed
        uint256 interest = lending.calculateInterest(1 ether, 1000, 0, 1);
        // With ceiling division, result is floor + 1 for non-exact divisions
        uint256 numerator = 1 ether * 1000 * uint256(1);
        uint256 denominator = 10000 * uint256(365 days);
        uint256 expected = (numerator + denominator - 1) / denominator; // ceil div
        assertEq(interest, expected);
        assertGt(interest, 0); // Must be non-zero
    }

    function test_calculateInterest_maxValues() public view {
        // MAX_PRINCIPAL (1000 ether), MAX_APR_BPS (50000 = 500%), MAX_DURATION (365 days)
        uint256 interest = lending.calculateInterest(
            1000 ether,     // max principal
            50000,          // max APR (500%)
            0,
            365 days        // max duration
        );
        // Expected: 1000 ether * 50000 * 365 days / 10000 / 365 days = 5000 ether
        assertEq(interest, 5000 ether);
    }

    function test_calculateInterest_reverseTimestamps() public view {
        // _currentTime < _startTime should return 0
        uint256 interest = lending.calculateInterest(1 ether, 1000, 200, 100);
        assertEq(interest, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #3: Staking contract paused during loan lifecycle
    // ═══════════════════════════════════════════════════════════════════

    function test_repayLoan_succeedsWhenStakingPaused() public {
        uint256 loanId = _createAndAcceptLoan();

        // Pause the staking contract (the lending contract's collateral source)
        staking.pause();

        vm.warp(block.timestamp + 15 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        // Repay should still succeed — staking's _update() is not gated by whenNotPaused
        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        assertEq(staking.ownerOf(aliceTokenId), alice);
        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }

    function test_claimDefault_succeedsWhenStakingPaused() public {
        uint256 loanId = _createAndAcceptLoan();

        staking.pause();

        vm.warp(block.timestamp + 31 days);

        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        assertEq(staking.ownerOf(aliceTokenId), bob);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #5: Multiple concurrent loans (different borrowers)
    // ═══════════════════════════════════════════════════════════════════

    function test_multipleConcurrentLoans() public {
        // Give carol a staking position too
        address dave = makeAddr("dave");
        toweli.transfer(dave, 100_000 ether);

        vm.startPrank(dave);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        uint256 daveTokenId = staking.userTokenId(dave);
        vm.stopPrank();

        vm.warp(block.timestamp + 25 hours);

        vm.prank(dave);
        staking.approve(address(lending), daveTokenId);

        // Create two separate offers
        vm.deal(bob, 100 ether);
        vm.prank(bob);
        uint256 offer1 = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        address lender2 = makeAddr("lender2");
        vm.deal(lender2, 100 ether);
        vm.prank(lender2);
        uint256 offer2 = lending.createLoanOffer{value: 2 ether}(
            2000, 60 days, address(staking), 1000 ether, 0
        );

        // Alice accepts offer 1
        vm.prank(alice);
        uint256 loan1 = lending.acceptOffer(offer1, aliceTokenId);

        // Dave accepts offer 2
        vm.prank(dave);
        uint256 loan2 = lending.acceptOffer(offer2, daveTokenId);

        assertEq(lending.loanCount(), 2);

        // Warp 15 days — alice repays loan1
        vm.warp(block.timestamp + 15 days);

        uint256 repayment1 = lending.getRepaymentAmount(loan1);
        vm.deal(alice, repayment1);
        vm.prank(alice);
        lending.repayLoan{value: repayment1}(loan1);

        (,,,,,,,,bool repaid1,) = lending.getLoan(loan1);
        assertTrue(repaid1);

        // Loan 2 should still be active
        (,,,,,,,,bool repaid2, bool defaulted2) = lending.getLoan(loan2);
        assertFalse(repaid2);
        assertFalse(defaulted2);

        // Dave repays loan2
        uint256 repayment2 = lending.getRepaymentAmount(loan2);
        vm.deal(dave, repayment2);
        vm.prank(dave);
        lending.repayLoan{value: repayment2}(loan2);

        (,,,,,,,,bool repaid2After,) = lending.getLoan(loan2);
        assertTrue(repaid2After);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #6: ETH transfer fails in repayLoan
    // ═══════════════════════════════════════════════════════════════════

    function test_repayLoan_lenderRejectsETH_getsWETH() public {
        // Deploy an ETH-rejecting contract as lender
        ETHRejecter rejecter = new ETHRejecter();
        vm.deal(address(rejecter), 10 ether);

        // Create offer from the rejecter
        vm.prank(address(rejecter));
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        // Alice accepts
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        vm.warp(block.timestamp + 15 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        // Repayment succeeds — lender gets WETH instead of ETH (WETHFallbackLib)
        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Verify loan is repaid
        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid, "Loan should be repaid even if lender rejects ETH");

        // Lender received WETH instead of raw ETH
        assertGt(IERC20(address(weth)).balanceOf(address(rejecter)), 0, "Lender should receive WETH");
    }

    function test_cancelOffer_lenderRejectsETH_getsWETH() public {
        // Deploy an ETH-rejecting contract as lender
        ETHRejecter rejecter = new ETHRejecter();
        vm.deal(address(rejecter), 10 ether);

        // Create offer from the rejecter
        vm.prank(address(rejecter));
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        // Cancel succeeds — lender gets WETH refund instead of ETH (WETHFallbackLib)
        vm.prank(address(rejecter));
        lending.cancelOffer(offerId);

        // Lender received WETH
        assertEq(IERC20(address(weth)).balanceOf(address(rejecter)), 1 ether, "Lender should receive WETH refund");
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #7: Treasury address change mid-loan
    // ═══════════════════════════════════════════════════════════════════

    function test_treasuryChangeMidLoan_feeGoesToNewTreasury() public {
        uint256 loanId = _createAndAcceptLoan();

        // Change treasury mid-loan via timelock
        address newTreasury = makeAddr("newTreasury");
        lending.proposeTreasuryChange(newTreasury);

        vm.warp(block.timestamp + 48 hours);
        lending.executeTreasuryChange();

        assertEq(lending.treasury(), newTreasury);

        // Continue warping to accumulate some interest
        vm.warp(block.timestamp + 10 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        uint256 newTreasuryBalanceBefore = newTreasury.balance;
        uint256 oldTreasuryBalanceBefore = treasury.balance;

        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // New treasury should receive the fee
        assertGt(newTreasury.balance - newTreasuryBalanceBefore, 0);
        // Old treasury should receive nothing
        assertEq(treasury.balance, oldTreasuryBalanceBefore);
    }

    function test_treasuryChangePropose_revert_zeroAddress() public {
        vm.expectRevert(TegridyLending.ZeroAddress.selector);
        lending.proposeTreasuryChange(address(0));
    }

    function test_treasuryChangeCancelAndVerify() public {
        address newTreasury = makeAddr("newTreasury");
        lending.proposeTreasuryChange(newTreasury);

        lending.cancelTreasuryChange();

        // Treasury unchanged
        assertEq(lending.treasury(), treasury);
        assertEq(lending.pendingTreasury(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #8: Gas limits with many offers
    // ═══════════════════════════════════════════════════════════════════

    function test_manyOffers_gasLimits() public {
        // Create 50 offers to verify no gas issues with array growth
        vm.deal(bob, 100 ether);
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(bob);
            lending.createLoanOffer{value: 0.1 ether}(
                1000, 30 days, address(staking), 1000 ether, 0
            );
        }
        assertEq(lending.offerCount(), 50);

        // Accept the last offer — should work without gas issues
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(49, aliceTokenId);

        (,,uint256 offerId,,,,,,, ) = lending.getLoan(loanId);
        assertEq(offerId, 49);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #9: Same user is both lender and borrower
    // ═══════════════════════════════════════════════════════════════════

    function test_sameUserLenderAndBorrower() public {
        // Alice creates an offer with her own ETH
        vm.deal(alice, 10 ether);

        vm.prank(alice);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        // Alice re-approves her NFT (it was approved in setUp for lending)
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        // Alice accepts her own offer
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Loan created with alice as both borrower and lender
        (address borrower, address lender,,,,,,,,) = lending.getLoan(loanId);
        assertEq(borrower, alice);
        assertEq(lender, alice);

        // Warp and repay — alice pays herself
        vm.warp(block.timestamp + 15 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Loan is repaid, NFT returned
        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
        assertEq(staking.ownerOf(aliceTokenId), alice);
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVERAGE GAP #10: No sweepETH — verify contract doesn't accept
    //                   stray ETH (no receive/fallback)
    // ═══════════════════════════════════════════════════════════════════

    function test_contractRejectsStrayETH() public {
        // TegridyLending has no receive() or fallback(), so direct ETH
        // sends should revert (only payable functions can accept ETH)
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        (bool success,) = address(lending).call{value: 1 ether}("");
        assertFalse(success, "Lending contract should reject stray ETH");
    }

    // ═══════════════════════════════════════════════════════════════════
    // BONUS: Invalid ID reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_getOffer_revert_invalidId() public {
        vm.expectRevert(TegridyLending.InvalidOfferId.selector);
        lending.getOffer(999);
    }

    function test_getLoan_revert_invalidId() public {
        vm.expectRevert(TegridyLending.InvalidLoanId.selector);
        lending.getLoan(999);
    }

    function test_repayLoan_revert_invalidId() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyLending.InvalidLoanId.selector);
        lending.repayLoan{value: 1 ether}(999);
    }

    function test_claimDefault_revert_invalidId() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.InvalidLoanId.selector);
        lending.claimDefaultedCollateral(999);
    }

    function test_isDefaulted_revert_invalidId() public {
        vm.expectRevert(TegridyLending.InvalidLoanId.selector);
        lending.isDefaulted(999);
    }

    function test_getRepaymentAmount_revert_invalidId() public {
        vm.expectRevert(TegridyLending.InvalidLoanId.selector);
        lending.getRepaymentAmount(999);
    }

    function test_cancelOffer_revert_invalidId() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.InvalidOfferId.selector);
        lending.cancelOffer(999);
    }

    // ═══════════════════════════════════════════════════════════════════
    // BONUS: Repay at exact deadline (boundary)
    // ═══════════════════════════════════════════════════════════════════

    function test_repayLoan_atExactDeadline() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp to exactly the deadline (30 days)
        vm.warp(block.timestamp + 30 days);

        // Should still be repayable (not defaulted until > deadline)
        assertFalse(lending.isDefaulted(loanId));

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // BONUS: Protocol fee change affects future repayments, not past
    // ═══════════════════════════════════════════════════════════════════

    function test_feeChangeMidLoan_usesNewFee() public {
        uint256 loanId = _createAndAcceptLoan();

        // Change protocol fee from 5% to 8% mid-loan
        lending.proposeProtocolFeeChange(800);
        vm.warp(block.timestamp + 48 hours);
        lending.executeProtocolFeeChange();

        assertEq(lending.protocolFeeBps(), 800);

        // Warp more for interest
        vm.warp(block.timestamp + 10 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount);

        uint256 treasuryBefore = treasury.balance;

        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Treasury fee should be 8% of interest (new fee)
        (,,,,,,uint256 startTime,,,) = lending.getLoan(loanId);
        uint256 interest = lending.calculateInterest(1 ether, 1000, startTime, block.timestamp);
        uint256 expectedFee = (interest * 800) / 10000;

        assertEq(treasury.balance - treasuryBefore, expectedFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTEREST ROUNDING FIX & EDGE CASES
    // ═══════════════════════════════════════════════════════════════════

    function test_interestRoundsUp() public {
        // Create a very small loan: 0.001 ether principal, 100 bps (1% APR), 1 day duration
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 0.001 ether}(
            100,                    // 1% APR
            1 days,                 // minimum duration
            address(staking),
            1000 ether,
            0
        );

        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        // Calculate interest — with ceilDiv, even tiny amounts should round up to > 0
        uint256 interest = lending.calculateInterest(0.001 ether, 100, block.timestamp - 1 days, block.timestamp);
        assertGt(interest, 0, "Interest must be > 0 even for tiny loan amounts (rounds up)");

        // Verify via the loan's repayment amount (should exceed principal)
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        assertGt(repaymentAmount, 0.001 ether, "Repayment must exceed principal");
    }

    function test_maxPrincipalOffer() public {
        // Exactly MAX_PRINCIPAL (1000 ether) should succeed
        vm.deal(bob, 2002 ether);
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1000 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
        (,uint256 principal,,,,,,) = lending.getOffer(offerId);
        assertEq(principal, 1000 ether);

        // 1001 ether should revert
        vm.prank(bob);
        vm.expectRevert(TegridyLending.PrincipalTooLarge.selector);
        lending.createLoanOffer{value: 1001 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
    }

    function test_maxAPROffer() public {
        // Exactly MAX_APR_BPS (50000 = 500%) should succeed
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            50000,                  // exactly MAX_APR_BPS
            30 days,
            address(staking),
            1000 ether,
            0
        );
        (,,uint256 aprBps,,,,,) = lending.getOffer(offerId);
        assertEq(aprBps, 50000);

        // 50001 should revert
        vm.prank(bob);
        vm.expectRevert(TegridyLending.AprTooHigh.selector);
        lending.createLoanOffer{value: 1 ether}(
            50001, 30 days, address(staking), 1000 ether, 0
        );
    }

    function test_repaymentBeforeMinDuration() public {
        // Create and accept an offer
        uint256 offerId = _createDefaultOffer();

        vm.startPrank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Try to repay in the same block (same timestamp) — must revert
        vm.deal(alice, 2 ether);
        vm.expectRevert(TegridyLending.LoanTooRecent.selector);
        lending.repayLoan{value: 2 ether}(loanId);
        vm.stopPrank();
    }

    function test_cannotClaimBeforeDeadline() public {
        uint256 offerId = _createDefaultOffer();

        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Record the deadline from the loan struct
        (,,,,,,, uint256 deadline,,) = lending.getLoan(loanId);

        // Warp to 1 second before the deadline
        vm.warp(deadline - 1);

        // Attempt to claim default — should revert (deadline not yet passed)
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DeadlineNotReached.selector);
        lending.claimDefaultedCollateral(loanId);

        // Warp to exactly the deadline — still should revert (requires > deadline)
        vm.warp(deadline);

        vm.prank(bob);
        vm.expectRevert(TegridyLending.DeadlineNotReached.selector);
        lending.claimDefaultedCollateral(loanId);

        // AUDIT M-1: after M-1 grace window, lender must wait deadline + GRACE_PERIOD (1h)
        // before claiming default. Inside the grace window the claim still reverts.
        vm.warp(deadline + lending.GRACE_PERIOD());

        vm.prank(bob);
        vm.expectRevert(TegridyLending.DeadlineNotReached.selector);
        lending.claimDefaultedCollateral(loanId);

        // One second past the grace window — should succeed
        vm.warp(deadline + lending.GRACE_PERIOD() + 1);

        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        // Verify lender received the NFT
        assertEq(staking.ownerOf(aliceTokenId), bob);

        // Verify loan marked as default claimed
        (,,,,,,,,,bool defaultClaimed) = lending.getLoan(loanId);
        assertTrue(defaultClaimed);
    }
}
