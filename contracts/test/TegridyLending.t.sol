// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";

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

/// @dev Contract that rejects ETH — used to test failed ETH transfers
contract ETHRejecter {
    receive() external payable {
        revert("no ETH");
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────

contract TegridyLendingTest is Test {
    MockToweli public toweli;
    MockJBAC public jbac;
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

        // 3. Deploy TegridyLending (constructor: treasury, protocolFeeBps)
        lending = new TegridyLending(treasury, 500); // 5% protocol fee

        // 4. Fund alice with TOWELI and have her stake to get a position NFT
        toweli.transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 30 days);
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
            5000 ether              // min position value
        );

        assertEq(offerId, 0);
        (
            address lender,
            uint256 principal,
            uint256 aprBps,
            uint256 duration,
            address collateralContract,
            uint256 minPositionValue,
            bool active
        ) = lending.getOffer(0);

        assertEq(lender, bob);
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(duration, 30 days);
        assertEq(collateralContract, address(staking));
        assertEq(minPositionValue, 5000 ether);
        assertTrue(active);
        assertEq(lending.offerCount(), 1);
    }

    function test_createOffer_revert_zeroAmount() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.ZeroPrincipal.selector);
        lending.createLoanOffer{value: 0}(
            1000, 30 days, address(staking), 5000 ether
        );
    }

    function test_createOffer_revert_principalTooLarge() public {
        vm.deal(bob, 1001 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.PrincipalTooLarge.selector);
        lending.createLoanOffer{value: 1001 ether}(
            1000, 30 days, address(staking), 5000 ether
        );
    }

    function test_createOffer_revert_aprTooHigh() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.AprTooHigh.selector);
        lending.createLoanOffer{value: 1 ether}(
            50001,                  // exceeds MAX_APR_BPS (50000)
            30 days,
            address(staking),
            5000 ether
        );
    }

    function test_createOffer_revert_durationTooShort() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooShort.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000,
            12 hours,               // below MIN_DURATION (1 day)
            address(staking),
            5000 ether
        );
    }

    function test_createOffer_revert_durationTooLong() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DurationTooLong.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000,
            366 days,               // exceeds MAX_DURATION (365 days)
            address(staking),
            5000 ether
        );
    }

    function test_createOffer_revert_zeroCollateralAddress() public {
        vm.prank(bob);
        vm.expectRevert(TegridyLending.ZeroAddress.selector);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(0), 5000 ether
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CANCELLATION
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelOffer_success() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 5 ether}(
            1000, 30 days, address(staking), 5000 ether
        );

        uint256 bobBalanceBefore = bob.balance;
        vm.prank(bob);
        lending.cancelOffer(0);

        // ETH refunded
        assertEq(bob.balance, bobBalanceBefore + 5 ether);

        // Offer is no longer active
        (,,,,,, bool active) = lending.getOffer(0);
        assertFalse(active);
    }

    function test_cancelOffer_revert_notOwner() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether
        );

        vm.prank(carol);
        vm.expectRevert(TegridyLending.NotOfferLender.selector);
        lending.cancelOffer(0);
    }

    function test_cancelOffer_revert_alreadyCancelled() public {
        vm.prank(bob);
        lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 5000 ether
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
            1000 ether              // min position value (alice has 10_000)
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
        (,,,,,, bool active) = lending.getOffer(offerId);
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
            50_000 ether            // alice only has 10_000 staked
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
        vm.expectRevert(TegridyLending.LoanNotDefaulted.selector);
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
            1000, 30 days, address(staking), 5000 ether
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
            1000, 30 days, address(staking), 5000 ether
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
}
