// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTLending.sol";

// ─── Mock Contracts ─────────────────────────────────────────────────

contract MockERC721 is ERC721 {
    uint256 private _nextId = 1;

    constructor(string memory name, string memory symbol) ERC721(name, symbol) {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev Minimal WETH mock for testing WETHFallbackLib
contract MockWETHNFTLending {
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
contract ETHRejecterNFTLending {
    receive() external payable {
        revert("no ETH");
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────

contract TegridyNFTLendingTest is Test {
    MockERC721 public nft;
    MockERC721 public nft2;        // second whitelisted collection
    MockERC721 public nftBad;      // not whitelisted
    MockWETHNFTLending public weth;
    TegridyNFTLending public lending;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // lender — has ETH
    address public bob = makeAddr("bob");       // borrower — has NFT
    address public carol = makeAddr("carol");   // unauthorized third party

    uint256 public bobTokenId; // bob's NFT token

    function setUp() public {
        // Start at a realistic timestamp to avoid edge cases
        vm.warp(1_700_000_000);

        // 1. Deploy mock NFTs
        nft = new MockERC721("TestNFT", "TNFT");
        nft2 = new MockERC721("TestNFT2", "TNFT2");
        nftBad = new MockERC721("BadNFT", "BNFT");

        // 2. Deploy MockWETH and TegridyNFTLending
        weth = new MockWETHNFTLending();
        lending = new TegridyNFTLending(treasury, 500, address(weth)); // 5% protocol fee

        // 3. Whitelist our test NFT collections (via timelock)
        lending.proposeWhitelistCollection(address(nft));
        vm.warp(1_700_000_000 + 25 hours);
        lending.executeWhitelistCollection();

        lending.proposeWhitelistCollection(address(nft2));
        vm.warp(1_700_000_000 + 50 hours);
        lending.executeWhitelistCollection();

        // 4. Mint an NFT to bob
        bobTokenId = nft.mint(bob);

        // 5. Approve lending contract to transfer bob's NFT
        vm.prank(bob);
        nft.approve(address(lending), bobTokenId);

        // 6. Fund alice with ETH for lending
        vm.deal(alice, 100 ether);

        // Fund carol with some ETH
        vm.deal(carol, 10 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CREATION
    // ═══════════════════════════════════════════════════════════════════

    function test_createOffer_success() public {
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether,
            1000,                   // 10% APR
            30 days,                // duration
            address(nft),           // collateral contract
            bobTokenId              // specific tokenId
        );

        assertEq(offerId, 0);
        (
            address lender,
            uint256 principal,
            uint256 aprBps,
            uint256 duration,
            address collateralContract,
            uint256 tokenId,
            bool active
        ) = lending.getOffer(0);

        assertEq(lender, alice);
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(duration, 30 days);
        assertEq(collateralContract, address(nft));
        assertEq(tokenId, bobTokenId);
        assertTrue(active);
        assertEq(lending.offerCount(), 1);
    }

    function test_createOffer_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.ZeroPrincipal.selector);
        lending.createOffer{value: 0}(
            0, 1000, 30 days, address(nft), bobTokenId
        );
    }

    function test_createOffer_revert_msgValueMismatch() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.MsgValueMismatch.selector);
        lending.createOffer{value: 1 ether}(
            2 ether, 1000, 30 days, address(nft), bobTokenId
        );
    }

    function test_createOffer_revert_principalTooLarge() public {
        vm.deal(alice, 1001 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.PrincipalTooLarge.selector);
        lending.createOffer{value: 1001 ether}(
            1001 ether, 1000, 30 days, address(nft), bobTokenId
        );
    }

    function test_createOffer_revert_aprTooHigh() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.AprTooHigh.selector);
        lending.createOffer{value: 1 ether}(
            1 ether,
            50001,                  // exceeds MAX_APR_BPS (50000)
            30 days,
            address(nft),
            bobTokenId
        );
    }

    function test_createOffer_revert_durationTooShort() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.DurationTooShort.selector);
        lending.createOffer{value: 1 ether}(
            1 ether,
            1000,
            12 hours,               // below MIN_DURATION (1 day)
            address(nft),
            bobTokenId
        );
    }

    function test_createOffer_revert_durationTooLong() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.DurationTooLong.selector);
        lending.createOffer{value: 1 ether}(
            1 ether,
            1000,
            366 days,               // exceeds MAX_DURATION (365 days)
            address(nft),
            bobTokenId
        );
    }

    function test_createOffer_revert_zeroCollateralAddress() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.ZeroAddress.selector);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(0), bobTokenId
        );
    }

    function test_createOffer_revert_collectionNotWhitelisted() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.CollectionNotWhitelisted.selector);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nftBad), bobTokenId
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CANCELLATION
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelOffer_success() public {
        vm.prank(alice);
        lending.createOffer{value: 5 ether}(
            5 ether, 1000, 30 days, address(nft), bobTokenId
        );

        uint256 aliceBalanceBefore = alice.balance;
        vm.prank(alice);
        lending.cancelOffer(0);

        // ETH refunded
        assertEq(alice.balance, aliceBalanceBefore + 5 ether);

        // Offer is no longer active
        (,,,,,, bool active) = lending.getOffer(0);
        assertFalse(active);
    }

    function test_cancelOffer_revert_notLender() public {
        vm.prank(alice);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId
        );

        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotOfferLender.selector);
        lending.cancelOffer(0);
    }

    function test_cancelOffer_revert_alreadyCancelled() public {
        vm.prank(alice);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId
        );

        vm.prank(alice);
        lending.cancelOffer(0);

        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.OfferNotActive.selector);
        lending.cancelOffer(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LOAN ACCEPTANCE
    // ═══════════════════════════════════════════════════════════════════

    function _createDefaultOffer() internal returns (uint256) {
        vm.prank(alice);
        return lending.createOffer{value: 1 ether}(
            1 ether,
            1000,                   // 10% APR
            30 days,
            address(nft),
            bobTokenId
        );
    }

    function test_acceptOffer_success() public {
        uint256 offerId = _createDefaultOffer();

        uint256 bobBalanceBefore = bob.balance;

        vm.prank(bob);
        uint256 loanId = lending.acceptOffer(offerId);

        assertEq(loanId, 0);

        // ETH sent to borrower
        assertEq(bob.balance, bobBalanceBefore + 1 ether);

        // NFT escrowed by lending contract
        assertEq(nft.ownerOf(bobTokenId), address(lending));

        // Offer deactivated
        (,,,,,, bool active) = lending.getOffer(offerId);
        assertFalse(active);

        // Loan fields populated
        (
            address borrower,
            address lender,
            uint256 loanOfferId,
            uint256 tokenId,
            address collateralContract,
            uint256 principal,
            uint256 aprBps,
            uint256 startTime,
            uint256 deadline,
            bool repaid,
            bool defaultClaimed
        ) = lending.getLoan(loanId);

        assertEq(borrower, bob);
        assertEq(lender, alice);
        assertEq(loanOfferId, offerId);
        assertEq(tokenId, bobTokenId);
        assertEq(collateralContract, address(nft));
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(startTime, block.timestamp);
        assertEq(deadline, block.timestamp + 30 days);
        assertFalse(repaid);
        assertFalse(defaultClaimed);
        assertEq(lending.loanCount(), 1);
    }

    function test_acceptOffer_revert_notNFTOwner() public {
        // Offer stores bobTokenId. Carol (who doesn't own it) tries to accept.
        uint256 offerId = _createDefaultOffer();

        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotNFTOwner.selector);
        lending.acceptOffer(offerId);
    }

    function test_acceptOffer_revert_offerNotActive() public {
        uint256 offerId = _createDefaultOffer();

        // Cancel offer first
        vm.prank(alice);
        lending.cancelOffer(offerId);

        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.OfferNotActive.selector);
        lending.acceptOffer(offerId);
    }

    function test_acceptOffer_revert_collectionNotWhitelisted() public {
        // Mint an NFT from the non-whitelisted collection
        uint256 badTokenId = nftBad.mint(bob);
        vm.prank(bob);
        nftBad.approve(address(lending), badTokenId);

        // Create offer for the bad collection — this should revert at createOffer
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.CollectionNotWhitelisted.selector);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nftBad), badTokenId
        );
    }

    function test_acceptOffer_revert_wrongCollection() public {
        // Try to create an offer for nft2 with a tokenId that doesn't exist there.
        // ERC721.ownerOf reverts with ERC721NonexistentToken — the existence check
        // now fires at createOffer rather than acceptOffer.
        vm.prank(alice);
        vm.expectRevert();
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft2), bobTokenId
        );
    }

    /// @notice Proves the 7c fix: a borrower cannot swap in a different (worse) tokenId
    /// at acceptance time. The contract escrows the tokenId that was fixed in the
    /// offer storage, regardless of which NFT the borrower may also own.
    function test_acceptOffer_revert_borrowerCannotPickDifferentTokenId() public {
        // Offer locked to bobTokenId (minted in setUp)
        uint256 offerId = _createDefaultOffer();

        // Bob acquires a second token (simulating a worse-valued NFT)
        uint256 bobTokenId2 = nft.mint(bob);
        vm.prank(bob);
        nft.approve(address(lending), bobTokenId2);

        // Bob accepts — no tokenId arg, contract must use offer.tokenId
        vm.prank(bob);
        uint256 loanId = lending.acceptOffer(offerId);

        // Verify the ESCROWED token is bobTokenId (the one Alice chose), NOT bobTokenId2
        assertEq(nft.ownerOf(bobTokenId), address(lending));
        assertEq(nft.ownerOf(bobTokenId2), bob);

        // Loan stores the offer's tokenId, not bobTokenId2
        (,,, uint256 loanTokenId,,,,,,,) = lending.getLoan(loanId);
        assertEq(loanTokenId, bobTokenId);
        assertTrue(loanTokenId != bobTokenId2);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REPAYMENT
    // ═══════════════════════════════════════════════════════════════════

    function _createAndAcceptLoan() internal returns (uint256 loanId) {
        uint256 offerId = _createDefaultOffer();
        vm.prank(bob);
        loanId = lending.acceptOffer(offerId);
    }

    function test_repayLoan_interestMath() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp forward 30 days (full duration)
        vm.warp(block.timestamp + 30 days);

        // Calculate expected interest: principal * aprBps * elapsed / BPS / SECONDS_PER_YEAR
        uint256 expectedInterest = lending.calculateInterest(1 ether, 1000, block.timestamp - 30 days, block.timestamp);
        uint256 totalRepayment = 1 ether + expectedInterest;

        // Fund bob for repayment
        vm.deal(bob, totalRepayment + 1 ether);

        uint256 aliceBalanceBefore = alice.balance;
        uint256 treasuryBalanceBefore = treasury.balance;

        vm.prank(bob);
        lending.repayLoan{value: totalRepayment}(loanId);

        // Protocol fee = interest * 500 / 10000 = 5% of interest
        uint256 expectedFee = (expectedInterest * 500) / 10000;
        uint256 expectedLenderAmount = 1 ether + expectedInterest - expectedFee;

        // Lender received principal + interest - fee
        assertEq(alice.balance - aliceBalanceBefore, expectedLenderAmount);

        // Treasury received fee
        assertEq(treasury.balance - treasuryBalanceBefore, expectedFee);

        // NFT returned to borrower
        assertEq(nft.ownerOf(bobTokenId), bob);

        // Loan marked repaid
        (,,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }

    function test_repayLoan_excessRefund() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 15 days);

        uint256 interest = lending.calculateInterest(1 ether, 1000, block.timestamp - 15 days, block.timestamp);
        uint256 totalDue = 1 ether + interest;
        uint256 overpayment = 0.5 ether;

        vm.deal(bob, totalDue + overpayment);

        uint256 bobBalanceBefore = bob.balance;

        vm.prank(bob);
        lending.repayLoan{value: totalDue + overpayment}(loanId);

        // Bob should get the overpayment refunded (balance drops by only totalDue)
        assertEq(bobBalanceBefore - bob.balance, totalDue);
    }

    function test_repayLoan_revert_insufficientPayment() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 15 days);

        // Send less than required
        vm.deal(bob, 0.5 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.InsufficientRepayment.selector);
        lending.repayLoan{value: 0.5 ether}(loanId);
    }

    function test_repayLoan_revert_notBorrower() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.deal(carol, 2 ether);
        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotBorrower.selector);
        lending.repayLoan{value: 2 ether}(loanId);
    }

    function test_repayLoan_revert_alreadyRepaid() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 1 days);
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);

        vm.deal(bob, repaymentAmount * 2);
        vm.prank(bob);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Try to repay again
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.LoanAlreadyRepaid.selector);
        lending.repayLoan{value: repaymentAmount}(loanId);
    }

    function test_repayLoan_revert_pastDeadline() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp past deadline
        vm.warp(block.timestamp + 31 days);

        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repaymentAmount);

        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.LoanNotDefaulted.selector);
        lending.repayLoan{value: repaymentAmount}(loanId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEFAULT
    // ═══════════════════════════════════════════════════════════════════

    function test_claimDefault_success() public {
        uint256 loanId = _createAndAcceptLoan();

        // Warp past the deadline
        vm.warp(block.timestamp + 31 days);

        vm.prank(alice);
        lending.claimDefault(loanId);

        // Lender received the NFT
        assertEq(nft.ownerOf(bobTokenId), alice);

        // Loan marked as default claimed
        (,,,,,,,,,,bool defaultClaimed) = lending.getLoan(loanId);
        assertTrue(defaultClaimed);

        // isDefaulted returns false now (it was claimed)
        assertFalse(lending.isDefaulted(loanId));
    }

    function test_claimDefault_revert_deadlineNotReached() public {
        uint256 loanId = _createAndAcceptLoan();

        // Still within the loan period
        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.LoanNotDefaulted.selector);
        lending.claimDefault(loanId);
    }

    function test_claimDefault_revert_notLender() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 31 days);

        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotLoanLender.selector);
        lending.claimDefault(loanId);
    }

    function test_claimDefault_revert_alreadyClaimed() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 31 days);

        vm.prank(alice);
        lending.claimDefault(loanId);

        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.LoanAlreadyDefaultClaimed.selector);
        lending.claimDefault(loanId);
    }

    function test_claimDefault_revert_alreadyRepaid() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 1 days);
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repaymentAmount);
        vm.prank(bob);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Warp past deadline and try to claim
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.LoanAlreadyRepaid.selector);
        lending.claimDefault(loanId);
    }

    function test_cannotRepayAfterDefaultClaim() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 31 days);

        // Lender claims default
        vm.prank(alice);
        lending.claimDefault(loanId);

        // Borrower tries to repay — should fail
        vm.deal(bob, 2 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.LoanAlreadyDefaultClaimed.selector);
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
    // INTEREST CALCULATION ACCURACY
    // ═══════════════════════════════════════════════════════════════════

    function test_interestCalculation_30days() public view {
        // 1 ETH at 10% APR for 30 days
        // Expected: 1e18 * 1000 * 2592000 / 10000 / 31536000 = ~8219178082191780
        uint256 interest = lending.calculateInterest(1 ether, 1000, 0, 30 days);
        // Ceil div rounds up, so check approximate value
        assertGt(interest, 0);
        // Exact: ceil(1e18 * 1000 * 2592000 / (10000 * 31536000))
        uint256 numerator = 1 ether * 1000 * uint256(30 days);
        uint256 denominator = 10000 * uint256(365 days);
        uint256 expected = (numerator + denominator - 1) / denominator;
        assertEq(interest, expected);
    }

    function test_interestCalculation_zeroElapsed() public view {
        uint256 interest = lending.calculateInterest(1 ether, 1000, 100, 100);
        assertEq(interest, 0);
    }

    function test_interestCalculation_fullYear() public view {
        // 1 ETH at 10% APR for 365 days should be ~0.1 ETH
        uint256 interest = lending.calculateInterest(1 ether, 1000, 0, 365 days);
        // ceil(1e18 * 1000 * 31536000 / (10000 * 31536000)) = ceil(1e18 / 10) = 1e17
        assertEq(interest, 0.1 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PROTOCOL FEE CORRECTNESS
    // ═══════════════════════════════════════════════════════════════════

    function test_protocolFee_calculatedCorrectly() public {
        uint256 loanId = _createAndAcceptLoan();

        vm.warp(block.timestamp + 10 days);

        uint256 interest = lending.calculateInterest(1 ether, 1000, block.timestamp - 10 days, block.timestamp);
        uint256 expectedFee = (interest * 500) / 10000;

        // Ensure fee is nonzero
        assertGt(expectedFee, 0);

        uint256 totalDue = 1 ether + interest;
        vm.deal(bob, totalDue);

        uint256 treasuryBefore = treasury.balance;

        vm.prank(bob);
        lending.repayLoan{value: totalDue}(loanId);

        assertEq(treasury.balance - treasuryBefore, expectedFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    // WHITELIST ADD / REMOVE
    // ═══════════════════════════════════════════════════════════════════

    function test_whitelistCollection_timelocked() public {
        MockERC721 newNft = new MockERC721("New", "NEW");

        // Propose
        lending.proposeWhitelistCollection(address(newNft));

        // Cannot execute before timelock
        vm.expectRevert();
        lending.executeWhitelistCollection();

        // Warp past 24h timelock
        vm.warp(block.timestamp + 24 hours);
        lending.executeWhitelistCollection();

        assertTrue(lending.whitelistedCollections(address(newNft)));
    }

    function test_removeCollection_timelocked() public {
        // nft is already whitelisted
        assertTrue(lending.whitelistedCollections(address(nft)));

        // Propose removal
        lending.proposeRemoveCollection(address(nft));

        // Cannot execute before timelock
        vm.expectRevert();
        lending.executeRemoveCollection();

        // Warp past 24h timelock
        vm.warp(block.timestamp + 24 hours);
        lending.executeRemoveCollection();

        assertFalse(lending.whitelistedCollections(address(nft)));
    }

    function test_whitelist_revert_alreadyWhitelisted() public {
        vm.expectRevert(TegridyNFTLending.CollectionAlreadyWhitelisted.selector);
        lending.proposeWhitelistCollection(address(nft));
    }

    function test_removeCollection_revert_notWhitelisted() public {
        vm.expectRevert(TegridyNFTLending.CollectionNotCurrentlyWhitelisted.selector);
        lending.proposeRemoveCollection(address(nftBad));
    }

    function test_whitelist_revert_notOwner() public {
        MockERC721 newNft = new MockERC721("New", "NEW");
        vm.prank(carol);
        vm.expectRevert();
        lending.proposeWhitelistCollection(address(newNft));
    }

    function test_cancelWhitelist() public {
        MockERC721 newNft = new MockERC721("New", "NEW");
        lending.proposeWhitelistCollection(address(newNft));

        lending.cancelWhitelistCollection();

        assertFalse(lending.whitelistedCollections(address(newNft)));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: TIMELOCKED FEE CHANGE
    // ═══════════════════════════════════════════════════════════════════

    function test_proposeAndExecuteFeeChange() public {
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
        vm.expectRevert(TegridyNFTLending.FeeTooHigh.selector);
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

        vm.prank(alice);
        vm.expectRevert();
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId
        );
    }

    function test_repayLoan_worksWhilePaused() public {
        uint256 loanId = _createAndAcceptLoan();

        lending.pause();

        vm.warp(block.timestamp + 1 days);
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repaymentAmount);

        vm.prank(bob);
        lending.repayLoan{value: repaymentAmount}(loanId);

        (,,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid);
    }
}
