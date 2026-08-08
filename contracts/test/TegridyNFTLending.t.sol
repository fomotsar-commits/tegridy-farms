// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import "../src/TegridyNFTLending.sol";
import "../src/TegridyNFTLendingAdmin.sol"; // AUDIT FIX: EIP170-01 split

// ─── Mock Contracts ─────────────────────────────────────────────────

contract MockERC721 is ERC721 {
    uint256 private _nextId = 1;

    constructor(string memory name, string memory symbol) ERC721(name, symbol) {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    /// @dev Test-only burn helper for AUDIT NFT-CL-L3 regression test.
    function burn(uint256 tokenId) external {
        _burn(tokenId);
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

/// @dev AUDIT FIX L-2 regression mock: an ERC721 whose `transferFrom` reverts
/// when the `frozen` flag is set. Covers hostile/buggy collections that
/// brick repayLoan / claimDefault by reverting on the NFT-return leg.
contract HostileNFT is ERC721 {
    uint256 private _nextId = 1;
    bool public frozen;

    constructor() ERC721("Hostile", "HOST") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    function setFrozen(bool _f) external {
        frozen = _f;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        if (frozen) revert("HOSTILE_FROZEN");
        super.transferFrom(from, to, id);
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────

contract TegridyNFTLendingTest is Test {
    MockERC721 public nft;
    MockERC721 public nft2;        // second whitelisted collection
    MockERC721 public nftBad;      // not whitelisted
    MockWETHNFTLending public weth;
    TegridyNFTLending public lending;
    TegridyNFTLendingAdmin public nftLendingAdmin; // AUDIT FIX: EIP170-01 split

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // lender — has ETH
    address public bob = makeAddr("bob");       // borrower — has NFT
    address public carol = makeAddr("carol");   // unauthorized third party

    uint256 public bobTokenId; // bob's NFT token

    function setUp() public {
        // FRESH-2026 TEST REALIGN: TegridyNFTLending now requires chainid==1 OR
        // a non-zero sequencer feed at construction (L2_SEQUENCER_FEED_REQUIRED).
        // Set mainnet for the address(0) feed path used by the test fixture.
        vm.chainId(1);
        // Start at a realistic timestamp to avoid edge cases
        vm.warp(1_700_000_000);

        // 1. Deploy mock NFTs
        nft = new MockERC721("TestNFT", "TNFT");
        nft2 = new MockERC721("TestNFT2", "TNFT2");
        nftBad = new MockERC721("BadNFT", "BNFT");

        // 2. Deploy MockWETH and TegridyNFTLending
        weth = new MockWETHNFTLending();
        lending = new TegridyNFTLending(treasury, 500, address(weth), address(0)); // 5% protocol fee
        // AUDIT FIX: EIP170-01 split — deploy + wire the timelock admin sister.
        nftLendingAdmin = new TegridyNFTLendingAdmin(address(lending));
        lending.setNftLendingAdmin(address(nftLendingAdmin));

        // 3. Whitelist our test NFT collections (via timelock on the admin)
        nftLendingAdmin.proposeWhitelistCollection(address(nft));
        vm.warp(1_700_000_000 + 25 hours);
        nftLendingAdmin.executeWhitelistCollection();

        nftLendingAdmin.proposeWhitelistCollection(address(nft2));
        vm.warp(1_700_000_000 + 50 hours);
        nftLendingAdmin.executeWhitelistCollection();

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
            bobTokenId,             // specific tokenId
            uint64(block.timestamp + 30 days)
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

    // AUDIT 2026-06-19 (econ pass) REGRESSION: the global MAX_TOTAL_OFFERS cap
    // must track LIVE OPEN offers, not lifetime creations. Pre-fix the cap gated
    // on the append-only `offers.length`, which is never popped on cancel/accept,
    // so cancelled offers permanently consumed global capacity — createOffer would
    // brick protocol-wide once 10k were EVER created (griefable at gas-only cost
    // via a create->cancel loop, since cancel fully refunds). This asserts the new
    // `openOffersCount` decrements on cancel while `offerCount()` (lifetime) grows,
    // proving cancelled offers free the slot and the DoS is closed.
    function test_globalOfferCap_tracksOpenNotLifetime() public {
        uint256[] memory ids = new uint256[](5);
        vm.startPrank(alice);
        for (uint256 i = 0; i < 5; i++) {
            // createOffer discards ownerOf(), so re-using bobTokenId is fine —
            // this mirrors the griefing loop (no NFT ownership required).
            ids[i] = lending.createOffer{value: 1 ether}(
                1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
            );
        }
        vm.stopPrank();
        assertEq(lending.openOffersCount(), 5, "5 open after creates");
        assertEq(lending.offerCount(), 5, "lifetime 5 after creates");

        // Cancel all 5. Global OPEN count must return to zero; lifetime stays 5.
        vm.startPrank(alice);
        for (uint256 i = 0; i < 5; i++) {
            lending.cancelOffer(ids[i]);
        }
        vm.stopPrank();
        assertEq(lending.openOffersCount(), 0, "0 open after cancels (slot freed)");
        assertEq(lending.offerCount(), 5, "lifetime unchanged at 5 (append-only)");

        // A fresh create after the cancel churn still succeeds and re-increments
        // the OPEN count — pre-fix this path is what would eventually brick.
        vm.prank(alice);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );
        assertEq(lending.openOffersCount(), 1, "1 open after post-churn create");
        assertEq(lending.offerCount(), 6, "lifetime now 6");
    }

    function test_createOffer_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.ZeroPrincipal.selector);
        lending.createOffer{value: 0}(
            0, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );
    }

    function test_createOffer_revert_msgValueMismatch() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.MsgValueMismatch.selector);
        lending.createOffer{value: 1 ether}(
            2 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );
    }

    function test_createOffer_revert_principalTooLarge() public {
        vm.deal(alice, 1001 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.PrincipalTooLarge.selector);
        lending.createOffer{value: 1001 ether}(
            1001 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
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
            bobTokenId,
            uint64(block.timestamp + 30 days)
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
            bobTokenId,
            uint64(block.timestamp + 30 days)
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
            bobTokenId,
            uint64(block.timestamp + 30 days)
        );
    }

    function test_createOffer_revert_zeroCollateralAddress() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.ZeroAddress.selector);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(0), bobTokenId, uint64(block.timestamp + 30 days)
        );
    }

    function test_createOffer_revert_collectionNotWhitelisted() public {
        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.CollectionNotWhitelisted.selector);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nftBad), bobTokenId, uint64(block.timestamp + 30 days)
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // OFFER CANCELLATION
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelOffer_success() public {
        vm.prank(alice);
        lending.createOffer{value: 5 ether}(
            5 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
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
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );

        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotOfferLender.selector);
        lending.cancelOffer(0);
    }

    function test_cancelOffer_revert_alreadyCancelled() public {
        vm.prank(alice);
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
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
            bobTokenId,
            uint64(block.timestamp + 30 days)
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
            1 ether, 1000, 30 days, address(nftBad), badTokenId, uint64(block.timestamp + 30 days)
        );
    }

    function test_acceptOffer_revert_wrongCollection() public {
        // Try to create an offer for nft2 with a tokenId that doesn't exist there.
        // ERC721.ownerOf reverts with ERC721NonexistentToken — the existence check
        // now fires at createOffer rather than acceptOffer.
        vm.prank(alice);
        vm.expectRevert();
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft2), bobTokenId, uint64(block.timestamp + 30 days)
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

    // ═══════════════════════════════════════════════════════════════════
    // AUDIT FIX L-2: stuck-collateral recovery
    // ═══════════════════════════════════════════════════════════════════
    // A hostile or buggy whitelisted collection that reverts on
    // `transferFrom` previously bricked repayLoan / claimDefault — borrower
    // had paid (or default-window had elapsed) but the NFT-return leg's
    // revert rolled the entire settlement back. The fix wraps the NFT
    // transfer in try/catch, lets the money flow, and reserves the NFT
    // for later recovery via `claimStuckCollateral`.

    HostileNFT internal hostile;

    /// @dev Whitelist a fresh HostileNFT and put a loan against it on the
    ///      books. Returns the loanId. Hostile starts un-frozen so accept
    ///      succeeds; tests flip `setFrozen(true)` before repay/default.
    function _setupHostileLoan() internal returns (uint256 loanId, uint256 hostileTokenId) {
        hostile = new HostileNFT();
        nftLendingAdmin.proposeWhitelistCollection(address(hostile));
        vm.warp(block.timestamp + 25 hours);
        nftLendingAdmin.executeWhitelistCollection();

        hostileTokenId = hostile.mint(bob);

        vm.prank(bob);
        hostile.approve(address(lending), hostileTokenId);

        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(hostile), hostileTokenId, uint64(block.timestamp + 30 days)
        );

        vm.prank(bob);
        loanId = lending.acceptOffer(offerId);
    }

    function test_L2_repayLoan_collateralStuckThenClaimed() public {
        (uint256 loanId, uint256 tokenId) = _setupHostileLoan();

        vm.warp(block.timestamp + 15 days);
        uint256 repayment = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repayment);

        // Collection turns hostile right before repay — NFT-return leg will revert.
        hostile.setFrozen(true);

        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        lending.repayLoan{value: repayment}(loanId);

        // Money still flowed to lender (minus protocol fee).
        assertGt(alice.balance, aliceBefore, "lender paid even when NFT stuck");

        // Loan flipped to repaid, NFT still in escrow, recipient = borrower.
        (,,,,,,,,,bool repaid,) = lending.getLoan(loanId);
        assertTrue(repaid, "loan marked repaid");
        assertEq(hostile.ownerOf(tokenId), address(lending), "NFT still escrowed");
        assertEq(lending.stuckCollateralRecipient(loanId), bob, "borrower is recipient");

        // Collection becomes healthy → borrower recovers via claimStuckCollateral.
        hostile.setFrozen(false);
        vm.prank(bob);
        lending.claimStuckCollateral(loanId);
        assertEq(hostile.ownerOf(tokenId), bob, "NFT returned to borrower");
        assertEq(lending.stuckCollateralRecipient(loanId), address(0), "recipient cleared");
    }

    function test_L2_claimDefault_collateralStuckThenClaimed() public {
        (uint256 loanId, uint256 tokenId) = _setupHostileLoan();

        // Default window elapses.
        vm.warp(block.timestamp + 31 days);
        // Collection becomes hostile.
        hostile.setFrozen(true);

        vm.prank(alice);
        lending.claimDefault(loanId);

        // Default-claimed flag set, NFT still escrowed, recipient = lender.
        (,,,,,,,,,,bool defaultClaimed) = lending.getLoan(loanId);
        assertTrue(defaultClaimed, "default-claimed flipped");
        assertEq(hostile.ownerOf(tokenId), address(lending));
        assertEq(lending.stuckCollateralRecipient(loanId), alice);

        // Collection unfreezes — lender recovers.
        hostile.setFrozen(false);
        vm.prank(alice);
        lending.claimStuckCollateral(loanId);
        assertEq(hostile.ownerOf(tokenId), alice);
        assertEq(lending.stuckCollateralRecipient(loanId), address(0));
    }

    function test_L2_claimStuckCollateral_revertNotRecipient() public {
        (uint256 loanId,) = _setupHostileLoan();
        vm.warp(block.timestamp + 15 days);
        uint256 repayment = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repayment);
        hostile.setFrozen(true);
        vm.prank(bob);
        lending.repayLoan{value: repayment}(loanId);

        hostile.setFrozen(false);
        // carol is not the recipient (bob is).
        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NotStuckCollateralRecipient.selector);
        lending.claimStuckCollateral(loanId);
    }

    function test_L2_claimStuckCollateral_revertNoStuck() public {
        // A normal happy-path repay leaves no stuck-collateral entry.
        uint256 loanId = _createAndAcceptLoan();
        vm.warp(block.timestamp + 15 days);
        uint256 repayment = lending.getRepaymentAmount(loanId);
        vm.deal(bob, repayment);
        vm.prank(bob);
        lending.repayLoan{value: repayment}(loanId);

        // No stuck collateral → revert.
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.NoStuckCollateral.selector);
        lending.claimStuckCollateral(loanId);
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

        // AUDIT FIX: DEEP-LD-M3 — isDefaulted now mirrors the claimDefault
        // gate: `block.timestamp > effectiveDeadline + GRACE_PERIOD`.
        // Pre-fix the view fired at deadline + 1; post-fix it requires the
        // additional grace window to elapse.
        vm.warp(block.timestamp + 1);
        assertFalse(lending.isDefaulted(loanId));

        // Defaulted after deadline + grace
        vm.warp(block.timestamp + lending.GRACE_PERIOD());
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
        nftLendingAdmin.proposeWhitelistCollection(address(newNft));

        // Cannot execute before timelock
        vm.expectRevert();
        nftLendingAdmin.executeWhitelistCollection();

        // Warp past 24h timelock
        vm.warp(block.timestamp + 24 hours);
        nftLendingAdmin.executeWhitelistCollection();

        assertTrue(lending.whitelistedCollections(address(newNft)));
    }

    function test_removeCollection_timelocked() public {
        // nft is already whitelisted
        assertTrue(lending.whitelistedCollections(address(nft)));

        // Propose removal
        nftLendingAdmin.proposeRemoveCollection(address(nft));

        // Cannot execute before timelock
        vm.expectRevert();
        nftLendingAdmin.executeRemoveCollection();

        // Warp past 24h timelock
        vm.warp(block.timestamp + 24 hours);
        nftLendingAdmin.executeRemoveCollection();

        assertFalse(lending.whitelistedCollections(address(nft)));
    }

    function test_whitelist_revert_alreadyWhitelisted() public {
        vm.expectRevert(TegridyNFTLendingAdmin.CollectionAlreadyWhitelisted.selector);
        nftLendingAdmin.proposeWhitelistCollection(address(nft));
    }

    function test_removeCollection_revert_notWhitelisted() public {
        vm.expectRevert(TegridyNFTLendingAdmin.CollectionNotCurrentlyWhitelisted.selector);
        nftLendingAdmin.proposeRemoveCollection(address(nftBad));
    }

    function test_whitelist_revert_notOwner() public {
        MockERC721 newNft = new MockERC721("New", "NEW");
        vm.prank(carol);
        vm.expectRevert();
        nftLendingAdmin.proposeWhitelistCollection(address(newNft));
    }

    function test_cancelWhitelist() public {
        MockERC721 newNft = new MockERC721("New", "NEW");
        nftLendingAdmin.proposeWhitelistCollection(address(newNft));

        nftLendingAdmin.cancelWhitelistCollection();

        assertFalse(lending.whitelistedCollections(address(newNft)));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: TIMELOCKED FEE CHANGE
    // ═══════════════════════════════════════════════════════════════════

    function test_proposeAndExecuteFeeChange() public {
        nftLendingAdmin.proposeProtocolFeeChange(800); // 8%

        assertEq(nftLendingAdmin.pendingProtocolFeeBps(), 800);

        // Cannot execute before timelock
        vm.expectRevert();
        nftLendingAdmin.executeProtocolFeeChange();

        // Warp past 48h timelock
        vm.warp(block.timestamp + 48 hours);

        nftLendingAdmin.executeProtocolFeeChange();

        assertEq(lending.protocolFeeBps(), 800);
        assertEq(nftLendingAdmin.pendingProtocolFeeBps(), 0);
    }

    function test_proposeFeeChange_revert_tooHigh() public {
        vm.expectRevert(TegridyNFTLendingAdmin.FeeTooHigh.selector);
        nftLendingAdmin.proposeProtocolFeeChange(1001); // exceeds MAX_PROTOCOL_FEE_BPS (1000)
    }

    function test_cancelFeeChange() public {
        nftLendingAdmin.proposeProtocolFeeChange(800);

        nftLendingAdmin.cancelProtocolFeeChange();

        assertEq(nftLendingAdmin.pendingProtocolFeeBps(), 0);

        // Original fee unchanged
        assertEq(lending.protocolFeeBps(), 500);
    }

    function test_feeChange_revert_notOwner() public {
        vm.prank(carol);
        vm.expectRevert();
        nftLendingAdmin.proposeProtocolFeeChange(800);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN: PAUSE
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksNewOffers() public {
        lending.pause();

        vm.prank(alice);
        vm.expectRevert();
        lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
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

    // ─── AUDIT NEW-L3: whitelist removal blocked by active loans ────────

    /// @notice AUDIT NEW-L3: while an active loan has a collection as its
    ///         collateral, `executeRemoveCollection` must revert. The proposal
    ///         stays queued; once the loan concludes (repay or default), the
    ///         owner can execute.
    function test_NEWL3_removeCollectionBlockedByActiveLoan() public {
        // Alice creates offer, bob accepts — active loan created against nft.
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );
        vm.prank(bob);
        lending.acceptOffer(offerId);

        assertEq(lending.activeLoansOfCollection(address(nft)), 1);

        // Propose removal — OK; execute must REVERT while loan is active.
        // AUDIT FIX LD3-L2: typed error replaces the legacy string revert.
        nftLendingAdmin.proposeRemoveCollection(address(nft));
        vm.warp(block.timestamp + 25 hours);
        vm.expectRevert(abi.encodeWithSelector(TegridyNFTLendingAdmin.ActiveLoansPresent.selector, address(nft), 1));
        nftLendingAdmin.executeRemoveCollection();

        // Borrower repays the loan — now removal can proceed.
        // NFT lives in the lending contract during the loan; repayLoan moves
        // it back to bob, no approve needed.
        uint256 repayAmount = 1.01 ether; // approx principal + a bit of interest
        vm.deal(bob, repayAmount);
        vm.warp(block.timestamp + 1); // avoid LoanTooRecent (same-block repay)
        vm.prank(bob);
        lending.repayLoan{value: repayAmount}(0);
        assertEq(lending.activeLoansOfCollection(address(nft)), 0);

        nftLendingAdmin.executeRemoveCollection();
        assertFalse(lending.whitelistedCollections(address(nft)));
    }

    /// @notice AUDIT NEW-L3: active-loan counter decrements on defaulted claim
    ///         too (not only repay), so whitelist removal unblocks after either
    ///         terminal state.
    function test_NEWL3_defaultAlsoDecrementsActiveLoans() public {
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );
        vm.prank(bob);
        lending.acceptOffer(offerId);
        assertEq(lending.activeLoansOfCollection(address(nft)), 1);

        // Warp past deadline + GRACE_PERIOD so default is claimable.
        vm.warp(block.timestamp + 30 days + 2 hours);
        vm.prank(alice);
        lending.claimDefault(0);

        assertEq(lending.activeLoansOfCollection(address(nft)), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // AUDIT NFT-CL-M2: calculateInterest uses overflow-safe mulDiv
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Pre-fix `calculateInterest` used `_principal * _aprBps * elapsed`
    ///         which had no 512-bit headroom — at upper-bound inputs the triple
    ///         product flirted with overflow. The fix swaps to OZ
    ///         `Math.mulDiv` with `Math.Rounding.Ceil`, mirroring
    ///         TegridyLending's safer pattern at lines 889-894.
    ///
    ///         This test asserts the NFT-lending `calculateInterest` output
    ///         matches the canonical Math.mulDiv(...,Ceil) computation for the
    ///         same inputs across a spread of representative scenarios — small
    ///         loan / short duration, mid-cap, and the upper-bound corner that
    ///         would have come closest to the old overflow risk.
    function test_NFT_CL_M2_calculateInterest_matchesMulDivCeil() public view {
        uint256 BPS = lending.BPS();
        uint256 SECONDS_PER_YEAR = lending.SECONDS_PER_YEAR();

        // Case A: 1 ETH @ 10% APR for 30 days.
        _assertMulDivCeil(1 ether, 1000, 30 days, BPS, SECONDS_PER_YEAR);

        // Case B: 100 ETH @ 25% APR for 90 days.
        _assertMulDivCeil(100 ether, 2500, 90 days, BPS, SECONDS_PER_YEAR);

        // Case C: 1 ETH @ 100% APR for 1 second — exercises ceil rounding on
        // a sub-1-wei pro-rata fraction (interest must round up to >=1 wei).
        _assertMulDivCeil(1 ether, 10000, 1, BPS, SECONDS_PER_YEAR);

        // Case D: max-cap corner — 1000 ETH @ 500% APR (50000 bps) for 365 days.
        // Pre-fix triple product = 1e21 * 5e4 * ~3.15e7 ~= 1.58e33 — within uint256
        // but uncomfortably close to anything that might compose with it. Math.mulDiv
        // performs the multiplication in 512-bit so the cap is irrelevant.
        _assertMulDivCeil(1000 ether, 50000, 365 days, BPS, SECONDS_PER_YEAR);
    }

    function _assertMulDivCeil(
        uint256 principal,
        uint256 aprBps,
        uint256 elapsed,
        uint256 BPS,
        uint256 SECONDS_PER_YEAR
    ) internal view {
        uint256 expected = Math.mulDiv(
            principal * aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
        // calculateInterest takes (principal, aprBps, startTime, currentTime).
        // Pass startTime=0 and currentTime=elapsed so the internal `_currentTime - _startTime`
        // resolves to `elapsed`.
        uint256 actual = lending.calculateInterest(principal, aprBps, 0, elapsed);
        assertEq(actual, expected, "calculateInterest must equal Math.mulDiv(_,_,_,Ceil)");
    }

    // ─── AUDIT NFT-CL-L3: burn-during-flight typed-error regression ──────

    /// @notice If the collateral NFT is burned between offer creation and
    ///         acceptOffer, the borrower must see the typed
    ///         `CollateralBurnedSinceOffer` error rather than an opaque
    ///         underlying-ERC721 revert.
    function test_acceptOffer_revertsWithTypedError_whenCollateralBurned() public {
        // Lender creates an offer for bob's specific tokenId.
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether,
            1000,
            30 days,
            address(nft),
            bobTokenId,
            uint64(block.timestamp + 30 days)
        );

        // Burn the NFT (e.g., bob exercises a burn flow on the underlying
        // collection, perhaps for an unrelated game mechanic).
        vm.prank(bob);
        nft.burn(bobTokenId);

        // Bob (or anyone) tries to accept — must hit the typed error.
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.CollateralBurnedSinceOffer.selector);
        lending.acceptOffer(offerId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // AUDIT FIX 2026-08 (round 2) — NFTLEND-PAUSE-INFLIGHT /
    // NFTLEND-ESCROW-INDEX / NFTLEND-STRANDED-*
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Non-destructive probe: does `claimDefault` revert RIGHT NOW?
    ///      State (including the warped timestamp, which is captured by the
    ///      snapshot taken after the warp) is restored before returning, so
    ///      the probe can be run at many sample times inside one test.
    function _claimDefaultReverts(uint256 loanId) internal returns (bool) {
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (bool ok, ) = address(lending).call(
            abi.encodeWithSelector(TegridyNFTLending.claimDefault.selector, loanId)
        );
        vm.revertToState(snap);
        return !ok;
    }

    /// @notice ROUND-2 BLOCKER PIN — view/logic agreement across the pause
    ///         boundary.
    ///
    ///         Two defects are pinned by one invariant:
    ///
    ///         (1) NFTLEND-PAUSE-INFLIGHT. `_effectiveDeadlineStrict` adds the
    ///             WHOLE in-flight pause (`block.timestamp - pauseStartTime`)
    ///             to the deadline, so in `claimDefault`'s gate
    ///               `block.timestamp <= effDeadline + grace + buffer`
    ///             the `block.timestamp` terms CANCEL. Any pause begun before
    ///             `deadline + grace` blocked the lender's claim FOREVER, however
    ///             long the pause ran — while `repayLoan` stayed open the whole
    ///             time. That made `MAX_PAUSE_BLOCK_LIQUIDATION` (7 days) inert,
    ///             the opposite of what its NatSpec promises.
    ///
    ///         (2) The round-1 patch clamped ONLY the internal strict helper, so
    ///             `isDefaulted()` / `effectiveDeadline()` kept reporting the
    ///             UNCLAMPED fact — the UI would show "not defaulted" while
    ///             `claimDefault` succeeded. The clamp must live where the fact
    ///             is COMPUTED so every reader of that fact agrees.
    ///
    ///         The invariant asserted here — `isDefaulted(id)` is true exactly
    ///         when `claimDefault(id)` would succeed — is what both fixes must
    ///         jointly satisfy, and it is not a literal, so it survives a change
    ///         to the cap's value.
    function test_AUDIT2026R2_isDefaultedAgreesWithClaimDefaultAcrossPause() public {
        uint256 loanId = _createAndAcceptLoan();
        uint256 start = vm.getBlockTimestamp(); // loan deadline = start + 30 days

        // Owner pauses for incident response BEFORE the loan's deadline.
        vm.warp(start + 1 days);
        lending.pause();

        uint256 cap = lending.MAX_PAUSE_BLOCK_LIQUIDATION();
        uint256 grace = lending.GRACE_PERIOD();
        // Derived, not hard-coded: the instant the bounded deadline + the
        // maximum pause-extended grace elapses.
        uint256 boundary = 30 days + cap + 2 * grace;

        uint256[9] memory samples = [
            uint256(5 days),
            20 days,
            29 days,
            31 days,
            boundary - 1,
            boundary,
            boundary + 1,
            60 days,
            120 days
        ];

        for (uint256 i = 0; i < samples.length; i++) {
            vm.warp(start + samples[i]);
            bool viewSaysDefaulted = lending.isDefaulted(loanId);
            bool claimReverts = _claimDefaultReverts(loanId);
            assertEq(
                viewSaysDefaulted,
                !claimReverts,
                "isDefaulted() must agree with claimDefault() at every instant"
            );
        }

        // ...and the bound must actually BITE: 119 days into a continuous pause
        // the lender can seize, and the view says so.
        vm.warp(start + 120 days);
        assertTrue(lending.isDefaulted(loanId), "view must report defaulted past the cap");
        vm.prank(alice);
        lending.claimDefault(loanId);
        assertEq(nft.ownerOf(bobTokenId), alice, "lender seized the collateral");
    }

    /// @notice NFTLEND-PAUSE-INFLIGHT (companion): bounding the in-flight pause
    ///         term must NEVER let a lender claim before the loan's own base
    ///         deadline. Guards against over-correcting the fix.
    function test_AUDIT2026R2_pauseBoundDoesNotEnableEarlyClaim() public {
        uint256 loanId = _createAndAcceptLoan();
        uint256 start = vm.getBlockTimestamp();

        vm.warp(start + 1 days);
        lending.pause();
        // 10 days paused, but the loan's base 30-day deadline has not passed.
        vm.warp(start + 11 days);

        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.LoanNotDefaulted.selector);
        lending.claimDefault(loanId);
        assertFalse(lending.isDefaulted(loanId), "view agrees: not defaulted yet");
    }

    /// @notice NFTLEND-PAUSE-INFLIGHT (symmetry): this contract's own NatSpec
    ///         says "both repay and claim see the same effectiveDeadline + grace
    ///         + outage" window. Clamping inside the deadline computation keeps
    ///         that promise — the borrower's repay window and the lender's claim
    ///         window flip at the SAME instant. Clamping only the lender's gate
    ///         (round 1) would have opened a window where BOTH are live.
    ///
    ///         `repayLoan` carries no `whenNotPaused`, so the borrower is never
    ///         blocked from repaying during the pause; only the extension is
    ///         bounded.
    function test_AUDIT2026R2_repayAndClaimWindowsStaySymmetricUnderPause() public {
        uint256 loanId = _createAndAcceptLoan();
        uint256 start = vm.getBlockTimestamp();

        vm.warp(start + 1 days);
        lending.pause();

        // Well inside the bounded window: borrower may still repay, lender may not claim.
        vm.warp(start + 35 days);
        assertTrue(_claimDefaultReverts(loanId), "claim still closed inside the bound");
        uint256 owed = lending.getRepaymentAmount(loanId);
        vm.deal(bob, owed);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        lending.repayLoan{value: owed}(loanId);
        vm.revertToState(snap);

        // Past the bound: the claim window is open, so the repay window must be
        // CLOSED. Pre-fix the repay window stayed open forever (the asymmetry).
        vm.warp(start + 60 days);
        assertFalse(_claimDefaultReverts(loanId), "claim open past the bound");
        uint256 owed2 = lending.getRepaymentAmount(loanId);
        vm.deal(bob, owed2);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.LoanNotDefaulted.selector);
        lending.repayLoan{value: owed2}(loanId);
    }

    /// @notice NFTLEND-STRANDED-CUSTODY: `applySweepUnsolicitedNFT` wrote a
    ///         PERMANENT, custody-unvalidated `strandedNFTRecipient` grant.
    ///         Pre-fix the owner could grant a token this contract does not
    ///         hold; the grant survives forever, so once that token later
    ///         arrives as REAL loan collateral the grantee walks off with the
    ///         lender's collateral via `claimStrandedNFT`.
    function test_AUDIT2026R2_strandedGrant_requiresCustodyAtGrantTime() public {
        // bob holds bobTokenId — the lending contract does NOT hold it, and no
        // loan exists, so the active-collateral guard passes.
        assertEq(nft.ownerOf(bobTokenId), bob, "precondition: bob holds it");

        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, carol);
        vm.warp(vm.getBlockTimestamp() + 25 hours);

        vm.expectRevert(TegridyNFTLending.NFTNotHeldByContract.selector);
        nftLendingAdmin.executeSweepUnsolicitedNFT();

        bytes32 key = keccak256(abi.encode(address(nft), bobTokenId));
        assertEq(lending.strandedNFTRecipient(key), address(0), "no grant written");
    }

    /// @notice NFTLEND-STRANDED-RECHECK: `claimStrandedNFT` re-validated
    ///         NOTHING. Even a grant that was legitimate when written must not
    ///         be redeemable once the same (collection, tokenId) has become live
    ///         loan collateral. Reachable whenever the collection can move its
    ///         own tokens out of escrow (hostile / upgradeable ERC-721) — the
    ///         threat model this file already defends against elsewhere.
    function test_AUDIT2026R2_claimStranded_refusesLiveLoanCollateral() public {
        // 1. bob donates the NFT to the contract (unsolicited transfer).
        vm.prank(bob);
        nft.transferFrom(bob, address(lending), bobTokenId);
        assertEq(nft.ownerOf(bobTokenId), address(lending), "donated");

        // 2. Owner legitimately sweeps it to carol. Custody holds, no loan.
        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, carol);
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        nftLendingAdmin.executeSweepUnsolicitedNFT();
        bytes32 key = keccak256(abi.encode(address(nft), bobTokenId));
        assertEq(lending.strandedNFTRecipient(key), carol, "grant recorded");

        // 3. carol sits on the grant. The collection moves the token back out of
        //    escrow (simulating a hostile / upgradeable collection).
        vm.prank(address(lending));
        nft.transferFrom(address(lending), bob, bobTokenId);

        // 4. bob now takes a REAL loan against that exact token.
        vm.prank(bob);
        nft.approve(address(lending), bobTokenId);
        uint256 loanId = _createAndAcceptLoan();
        assertEq(nft.ownerOf(bobTokenId), address(lending), "escrowed as collateral");

        // 5. carol tries to redeem the stale grant against LIVE collateral.
        vm.prank(carol);
        vm.expectRevert(TegridyNFTLending.NFTIsActiveCollateral.selector);
        lending.claimStrandedNFT(address(nft), bobTokenId);

        // Collateral is untouched and the loan still settles normally.
        assertEq(nft.ownerOf(bobTokenId), address(lending), "collateral intact");
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.prank(alice);
        lending.claimDefault(loanId);
        assertEq(nft.ownerOf(bobTokenId), alice, "lender got the collateral");
    }

    /// @notice NFTLEND-STRANDED-OVERWRITE: a second sweep of the same
    ///         (collection, tokenId) silently clobbered the first grantee.
    ///         The overwrite stays PERMITTED (the grant has no revocation path,
    ///         so refusing it would make a mistyped recipient an unrecoverable
    ///         NFT lock) but it is no longer silent.
    function test_AUDIT2026R2_strandedGrant_overwriteEmitsDistinctEvent() public {
        vm.prank(bob);
        nft.transferFrom(bob, address(lending), bobTokenId);

        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, carol);
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        nftLendingAdmin.executeSweepUnsolicitedNFT();

        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, bob);
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        vm.expectEmit(true, true, true, true, address(lending));
        emit TegridyNFTLending.StrandedNFTGrantOverwritten(address(nft), bobTokenId, carol, bob);
        nftLendingAdmin.executeSweepUnsolicitedNFT();

        bytes32 key = keccak256(abi.encode(address(nft), bobTokenId));
        assertEq(lending.strandedNFTRecipient(key), bob, "grant retargeted");
    }

    /// @notice NFTLEND-ESCROW-INDEX: `applySweepUnsolicitedNFT` walked the
    ///         append-only `loans[]` array TWICE, an O(lifetime-loans) scan that
    ///         gas-bricks the stranded-NFT recovery path once the array grows.
    ///         Replaced by the sibling's O(1) `collateralEscrowLoanIdPlus1`
    ///         reverse-index, which must track real custody EXACTLY — set on
    ///         confirmed escrow, cleared only when the NFT physically leaves.
    function test_AUDIT2026R2_escrowIndex_tracksCustody() public {
        assertEq(lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId), 0, "clean");

        uint256 loanId = _createAndAcceptLoan();
        assertEq(
            lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId),
            loanId + 1,
            "set on escrow"
        );

        vm.warp(vm.getBlockTimestamp() + 10 days);
        uint256 owed = lending.getRepaymentAmount(loanId);
        vm.deal(bob, owed);
        vm.prank(bob);
        lending.repayLoan{value: owed}(loanId);

        assertEq(nft.ownerOf(bobTokenId), bob, "NFT returned");
        assertEq(lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId), 0, "cleared on exit");
    }

    /// @notice NFTLEND-ESCROW-INDEX (stuck branch): when the outbound transfer
    ///         no-ops/reverts the NFT is still HERE, so the index must SURVIVE
    ///         — the sweep must keep refusing it — and clear only once
    ///         `claimStuckCollateral` actually moves it.
    function test_AUDIT2026R2_escrowIndex_survivesStuckCollateral() public {
        (uint256 loanId, uint256 hostileTokenId) = _setupHostileLoan();
        address hostileAddr = address(hostile);

        vm.warp(vm.getBlockTimestamp() + 31 days);
        hostile.setFrozen(true);
        vm.prank(alice);
        lending.claimDefault(loanId);

        assertEq(lending.stuckCollateralRecipient(loanId), alice, "stuck recorded");
        assertEq(
            lending.collateralEscrowLoanIdPlus1(hostileAddr, hostileTokenId),
            loanId + 1,
            "index survives the stuck branch"
        );

        hostile.setFrozen(false);
        vm.prank(alice);
        lending.claimStuckCollateral(loanId);
        assertEq(lending.collateralEscrowLoanIdPlus1(hostileAddr, hostileTokenId), 0, "cleared");
    }

    /// @notice NFTLEND-ESCROW-INDEX (clear on the claimDefault SUCCESS branch).
    ///         Dropping this `delete` would permanently jam the index against
    ///         that (collection, tokenId), bricking every later sweep AND every
    ///         later loan on that NFT after one ordinary liquidation.
    function test_AUDIT2026R2_escrowIndex_clearedOnDefaultClaim() public {
        uint256 loanId = _createAndAcceptLoan();
        assertEq(lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId), loanId + 1, "set");

        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.prank(alice);
        lending.claimDefault(loanId);

        assertEq(nft.ownerOf(bobTokenId), alice, "lender got collateral");
        assertEq(lending.stuckCollateralRecipient(loanId), address(0), "not stuck");
        assertEq(
            lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId),
            0,
            "index must clear on the claimDefault success branch"
        );
    }

    /// @notice NFTLEND-ESCROW-INDEX (replacement for the retired FIRST
    ///         `loans[]` scan): the admin sweep must still refuse a token
    ///         escrowed as LIVE collateral. Nothing in the suite covered this
    ///         guard before, so a replacement that never fired would look green.
    function test_AUDIT2026R2_sweep_refusesLiveCollateral() public {
        _createAndAcceptLoan();
        assertEq(nft.ownerOf(bobTokenId), address(lending), "escrowed");

        vm.expectRevert(TegridyNFTLending.NFTIsActiveCollateral.selector);
        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, carol);
    }

    /// @notice NFTLEND-ESCROW-INDEX (replacement for the retired SECOND
    ///         `loans[]` scan — the 2026-05-16 M9 stuck-collateral re-check):
    ///         once a settlement leg fails and the NFT is reserved for a
    ///         `claimStuckCollateral` recipient, the admin sweep must not
    ///         front-run that recipient. The loan is `defaultClaimed` by then,
    ///         so the FIRST scan would have let this through.
    function test_AUDIT2026R2_sweep_refusesStuckCollateral() public {
        (uint256 loanId, uint256 hostileTokenId) = _setupHostileLoan();

        vm.warp(vm.getBlockTimestamp() + 31 days);
        hostile.setFrozen(true);
        vm.prank(alice);
        lending.claimDefault(loanId);
        assertEq(lending.stuckCollateralRecipient(loanId), alice, "stuck recorded");

        vm.expectRevert(TegridyNFTLending.NFTIsActiveCollateral.selector);
        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(hostile), hostileTokenId, carol);
    }

    /// @notice The patch adds new reverts inside the grant write AND inside
    ///         `claimStrandedNFT`. Nothing in the suite drives the sweep happy
    ///         path end-to-end, so a fix that ALWAYS reverted would still look
    ///         green. This is that pin.
    function test_AUDIT2026R2_strandedSweepHappyPathStillWorks() public {
        vm.prank(bob);
        nft.transferFrom(bob, address(lending), bobTokenId);

        nftLendingAdmin.proposeSweepUnsolicitedNFT(address(nft), bobTokenId, carol);
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        nftLendingAdmin.executeSweepUnsolicitedNFT();

        bytes32 key = keccak256(abi.encode(address(nft), bobTokenId));
        assertEq(lending.strandedNFTRecipient(key), carol, "grant recorded");
        assertEq(lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId), 0, "never escrowed");

        vm.prank(carol);
        lending.claimStrandedNFT(address(nft), bobTokenId);

        assertEq(nft.ownerOf(bobTokenId), carol, "stranded NFT delivered");
        assertEq(lending.strandedNFTRecipient(key), address(0), "grant consumed");
    }

    /// @notice NFTLEND-ESCROW-INDEX (clobber guard). The single-slot index must
    ///         be clobber-proof, exactly as in the sibling
    ///         `TegridyLending.acceptLoanOffer` which pairs the same index with a
    ///         `CollateralInUse` guard. A hostile / upgradeable whitelisted
    ///         collection can yank an escrowed token back out to the borrower; if
    ///         the borrower could then re-escrow it under a SECOND loan, settling
    ///         loan #1 would delete loan #2's entry and re-open the sweep /
    ///         stranded-claim path onto LIVE collateral.
    function test_AUDIT2026R2_escrowIndex_cannotBeClobberedBySecondLoan() public {
        uint256 loanId = _createAndAcceptLoan();
        assertEq(lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId), loanId + 1, "loan 1");

        vm.prank(address(lending));
        nft.transferFrom(address(lending), bob, bobTokenId);
        assertEq(nft.ownerOf(bobTokenId), bob, "yanked out of escrow");

        vm.prank(bob);
        nft.approve(address(lending), bobTokenId);
        uint256 offerId2 = _createDefaultOffer();

        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.NFTIsActiveCollateral.selector);
        lending.acceptOffer(offerId2);

        assertEq(
            lending.collateralEscrowLoanIdPlus1(address(nft), bobTokenId),
            loanId + 1,
            "index still belongs to loan 1"
        );
    }

    /// @notice NFTLEND-SELFDEAL: `acceptOffer` never checked
    ///         `msg.sender != offer.lender`. Raises the cost of pushing rows
    ///         onto the append-only `loans[]` array (a self-dealt
    ///         create->accept->repay cycle round-trips the attacker's own
    ///         principal, so it costs only gas + the protocol fee).
    ///
    ///         NOT a DoS fix on its own — it is trivially sidestepped with a
    ///         second address. The array-growth DoS is closed by the O(1)
    ///         `collateralEscrowLoanIdPlus1` index above, which removes the
    ///         unbounded `loans[]` walks entirely.
    function test_AUDIT2026R2_acceptOffer_revertsOnSelfDeal() public {
        uint256 aliceToken = nft.mint(alice);
        vm.prank(alice);
        nft.approve(address(lending), aliceToken);

        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), aliceToken, uint64(block.timestamp + 30 days)
        );

        vm.prank(alice);
        vm.expectRevert(TegridyNFTLending.SelfDeal.selector);
        lending.acceptOffer(offerId);

        // The offer is untouched — alice can still cancel and get her ETH back.
        vm.prank(alice);
        lending.cancelOffer(offerId);
    }
}
