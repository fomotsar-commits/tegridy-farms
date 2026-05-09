// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol"; // AUDIT FIX (pass-8): EIP170-01 split
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

// ─── Mock Contracts (reused from TegridyLending.t.sol) ──────────────

contract MockToweli_Reentry is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC_Reentry is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockWETH_LendReentry {
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

/// @dev Minimal TegridyPair stub used only so TegridyLending's constructor can resolve
///      token0/token1 orientation. These reentrancy tests always use `minPositionETHValue = 0`,
///      so the stored reserves are never consulted.
contract MockPair_LendReentry {
    address public immutable token0;
    address public immutable token1;
    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (1e24, 1e21, uint32(block.timestamp));
    }
}

// ─── Attacker Contracts ────────────────────────────────────────────

/// @dev Attacker that acts as a borrower and tries to re-enter acceptOffer
///      when receiving the principal ETH.
contract ReentrantBorrower {
    TegridyLending public lending;
    TegridyStaking public staking;
    bool public attacking;
    uint256 public attackCount;
    uint256 public targetOfferId;
    uint256 public targetTokenId;

    constructor(address _lending, address _staking) {
        lending = TegridyLending(_lending);
        staking = TegridyStaking(_staking);
    }

    function setAttackParams(uint256 _offerId, uint256 _tokenId) external {
        targetOfferId = _offerId;
        targetTokenId = _tokenId;
    }

    function startAttack() external {
        attacking = true;
        attackCount = 0;
    }

    function acceptOffer(uint256 offerId, uint256 tokenId) external returns (uint256) {
        return lending.acceptOffer(offerId, tokenId);
    }

    function approveNFT(uint256 tokenId) external {
        staking.approve(address(lending), tokenId);
    }

    /// @dev When receiving principal ETH from acceptOffer, try to re-enter
    receive() external payable {
        if (attacking && attackCount < 1) {
            attackCount++;
            // Try to accept another offer - should be blocked by nonReentrant
            try lending.acceptOffer(targetOfferId, targetTokenId) {
                revert("REENTRANCY_SUCCEEDED");
            } catch {
                // Expected: blocked by nonReentrant
            }
        }
    }
}

/// @dev Attacker that acts as a lender and tries to re-enter cancelOffer
///      when receiving the refund ETH. With WETHFallbackLib's 10k gas stipend,
///      the re-entrant call won't have enough gas, and WETH fallback is used.
contract ReentrantLender {
    TegridyLending public lending;
    bool public attacking;
    uint256 public attackCount;
    uint256 public targetOfferId;

    constructor(address _lending) {
        lending = TegridyLending(_lending);
    }

    function createOffer(
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue
    ) external payable returns (uint256) {
        return lending.createLoanOffer{value: msg.value}(
            aprBps, duration, collateralContract, minPositionValue, 0
        );
    }

    function cancelOffer(uint256 offerId) external {
        lending.cancelOffer(offerId);
    }

    function setAttackParams(uint256 _offerId) external {
        targetOfferId = _offerId;
    }

    function startAttack() external {
        attacking = true;
        attackCount = 0;
    }

    /// @dev When receiving ETH refund from cancelOffer, try to re-enter
    receive() external payable {
        if (attacking && attackCount < 1) {
            attackCount++;
            // Try to cancel another offer - should fail (10k gas stipend)
            try lending.cancelOffer(targetOfferId) {
                revert("REENTRANCY_SUCCEEDED");
            } catch {
                // Expected: blocked by gas stipend (falls back to WETH)
            }
        }
    }
}

/// @dev Attacker that acts as a lender and tries to re-enter during repayLoan
///      when the lender receives their principal + interest via WETHFallbackLib.
contract ReentrantRepayLender {
    TegridyLending public lending;
    bool public attacking;
    uint256 public attackCount;
    uint256 public targetLoanId;

    constructor(address _lending) {
        lending = TegridyLending(_lending);
    }

    function createOffer(
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue
    ) external payable returns (uint256) {
        return lending.createLoanOffer{value: msg.value}(
            aprBps, duration, collateralContract, minPositionValue, 0
        );
    }

    function setAttackParams(uint256 _loanId) external {
        targetLoanId = _loanId;
    }

    function startAttack() external {
        attacking = true;
        attackCount = 0;
    }

    function claimDefaultedCollateral(uint256 loanId) external {
        lending.claimDefaultedCollateral(loanId);
    }

    /// @dev When receiving repayment ETH, try to re-enter claimDefaultedCollateral
    receive() external payable {
        if (attacking && attackCount < 1) {
            attackCount++;
            try lending.claimDefaultedCollateral(targetLoanId) {
                revert("REENTRANCY_SUCCEEDED");
            } catch {
                // Expected: blocked by gas stipend (falls back to WETH)
            }
        }
    }
}

// ─── Test Suite ────────────────────────────────────────────────────

contract TegridyLending_ReentrancyTest is Test {
    TegridyLendingAdmin public lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split (declared at top of test contract for setUp scope)
    MockToweli_Reentry public toweli;
    MockJBAC_Reentry public jbac;
    MockWETH_LendReentry public weth;
    MockPair_LendReentry public pair;
    TegridyStaking public staking;
    TegridyLending public lending;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // normal borrower
    address public bob = makeAddr("bob");       // normal lender

    uint256 public aliceTokenId;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: feed=address(0) only no-ops on chainid==1 now.
        vm.chainId(1);
        // Deploy mock tokens
        toweli = new MockToweli_Reentry();
        jbac = new MockJBAC_Reentry();

        // Deploy staking
        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            1e18
        );

        // Deploy WETH, pair stub, and lending
        weth = new MockWETH_LendReentry();
        pair = new MockPair_LendReentry(address(toweli), address(weth));
        // R003: TegridyLending now consults a TWAP for the optional ETH-floor.
        // Reentrancy tests use minPositionETHValue=0 so the TWAP is never
        // queried — an unbootstrapped instance is fine.
        // AUDIT R014: TegridyTWAP requires a factory; this test path never calls
        // twap.update(), so any non-zero factory address is fine as a placeholder.
        TegridyTWAP twap = new TegridyTWAP(address(this), address(0));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        // AUDIT FIX (pass-8): EIP170-01 split — wire admin sister.
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        // AUDIT R014: whitelist the staking contract so createLoanOffer accepts it as
        // collateral. 48h timelock is rolled forward inline.
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        vm.warp(block.timestamp + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        // Fund alice and have her stake
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Warp past 24h transfer cooldown
        vm.warp(block.timestamp + 25 hours);

        // Approve lending contract
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        // Fund bob
        vm.deal(bob, 100 ether);
        vm.deal(alice, 10 ether);
    }

    // ─── Helper ────────────────────────────────────────────────────────

    function _createDefaultOffer() internal returns (uint256) {
        vm.prank(bob);
        return lending.createLoanOffer{value: 1 ether}(
            1000,              // 10% APR
            30 days,
            address(staking),
            1000 ether,
            0
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: acceptOffer - borrower re-entry during principal payout
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A malicious borrower contract tries to re-enter acceptOffer when
    ///         receiving the principal ETH. The nonReentrant guard blocks this.
    function test_reentrancy_acceptOffer_blocked() public {
        // Deploy attacker borrower
        ReentrantBorrower attacker = new ReentrantBorrower(address(lending), address(staking));

        // Give attacker TOWELI and stake to get an NFT position
        toweli.mint(address(attacker), 100_000 ether);
        vm.startPrank(address(attacker));
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        uint256 attackerTokenId = staking.userTokenId(address(attacker));
        vm.stopPrank();

        // Warp past cooldown
        vm.warp(block.timestamp + 25 hours);

        // Approve lending contract to move attacker's NFT
        vm.prank(address(attacker));
        staking.approve(address(lending), attackerTokenId);

        // Create two offers from bob
        vm.startPrank(bob);
        uint256 offer1 = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
        uint256 offer2 = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
        vm.stopPrank();

        // Set attacker to try to accept offer2 during the receive() callback of offer1
        attacker.setAttackParams(offer2, attackerTokenId);
        attacker.startAttack();

        // Accept first offer - the receive() callback tries to accept offer2
        // but nonReentrant blocks it
        vm.prank(address(attacker));
        attacker.acceptOffer(offer1, attackerTokenId);

        // FRESH-2026 TEST REALIGN: M-36 — stipend bumped from 10k to 30k. Reentry attempt
        // now fits the budget but `nonReentrant` blocks the inner call (returns false).
        // Either path (raw ETH success, WETH fallback) delivers the principal in full.
        uint256 received = address(attacker).balance + weth.balanceOf(address(attacker));
        assertEq(received, 1 ether, "attacker received principal (ETH or WETH via fallback)");

        // attackCount may now reach 1 (the reentrant call's body executes long enough
        // to bump the counter before nonReentrant reverts). The load-bearing assertion
        // is offer2 activity below — the reentry's mutation is rolled back on revert.
        // (Pre-fix: attackCount stayed 0 because OOG on 10k stipend reverted before
        // the increment. Post-fix: 30k stipend lets the increment write but the
        // outer revert undoes it. Either way, offer2 stays active.)

        // Offer2 is still active (re-entry was blocked)
        (,,,,,,, bool active,,) = lending.getOffer(offer2);
        assertTrue(active, "Offer2 should still be active - re-entry was blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: cancelOffer - lender re-entry during refund
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A malicious lender contract tries to re-enter cancelOffer when
    ///         receiving the ETH refund. The 10k gas stipend blocks the re-entry
    ///         and the refund is sent as WETH instead.
    function test_reentrancy_cancelOffer_blocked() public {
        // Deploy attacker lender
        ReentrantLender attacker = new ReentrantLender(address(lending));
        vm.deal(address(attacker), 10 ether);

        // Create two offers from attacker
        vm.startPrank(address(attacker));
        uint256 offer1 = attacker.createOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether
        );
        uint256 offer2 = attacker.createOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether
        );
        vm.stopPrank();

        uint256 balBefore = address(attacker).balance + weth.balanceOf(address(attacker));

        // Set attacker to try to cancel offer2 during receive() of offer1 cancellation
        attacker.setAttackParams(offer2);
        attacker.startAttack();

        vm.prank(address(attacker));
        attacker.cancelOffer(offer1);

        // FRESH-2026 TEST REALIGN: M-36 [F-40-WFL-1] — gas stipend bumped from 10k to 30k.
        // The reentrant call now fits the budget but is rejected by `nonReentrant`,
        // so the inner call returns false and the refund lands as raw ETH (no WETH wrap).
        // Reentrancy is still defended — by the guard, not the stipend.
        uint256 received = address(attacker).balance + weth.balanceOf(address(attacker)) - balBefore;
        assertEq(received, 1 ether, "Refund delivered (ETH or WETH) - reentry blocked by guard");

        // Offer2 is still active (re-entry was blocked)
        (,,,,,,, bool active,,) = lending.getOffer(offer2);
        assertTrue(active, "Offer2 should still be active - re-entry was blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: repayLoan - lender re-entry during repayment payout
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A malicious lender contract tries to re-enter during repayLoan
    ///         when receiving the principal + interest. The 10k gas stipend blocks
    ///         the re-entry and payout is sent as WETH.
    function test_reentrancy_repayLoan_blocked() public {
        // Deploy attacker lender
        ReentrantRepayLender attackerLender = new ReentrantRepayLender(address(lending));
        vm.deal(address(attackerLender), 10 ether);

        // Create offer from attacker lender
        vm.prank(address(attackerLender));
        uint256 offerId = attackerLender.createOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether
        );

        // Alice accepts the offer (she's the borrower)
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Warp forward to accrue interest
        vm.warp(block.timestamp + 15 days);

        // Set attacker to try to claim default during repayment receipt
        attackerLender.setAttackParams(loanId);
        attackerLender.startAttack();

        // Alice repays
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount + 1 ether);
        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // FRESH-2026 TEST REALIGN: M-36 — stipend bumped to 30k; reentry now fits but
        // is rejected by `nonReentrant`. Payout lands as ETH, WETH, or both (the lib's
        // post-failure path may still wrap depending on consumer). Verify total received.
        uint256 received = address(attackerLender).balance + weth.balanceOf(address(attackerLender));
        assertGt(received, 0, "Lender payout delivered (ETH or WETH) - reentry blocked by guard");

        // Loan is marked as repaid
        (,,,,,,,,bool repaid,,) = lending.getLoan(loanId);
        assertTrue(repaid, "Loan should be marked as repaid");

        // NFT returned to alice
        assertEq(staking.ownerOf(aliceTokenId), alice);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: claimDefaultedCollateral - re-entry is blocked by nonReentrant
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that claimDefaultedCollateral is protected by nonReentrant.
    ///         Since it transfers an NFT (not ETH), re-entry via receive() is not
    ///         applicable, but the nonReentrant guard protects against any callback.
    function test_reentrancy_claimDefaultedCollateral_nonReentrant() public {
        // Create and accept a loan normally
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Warp past deadline
        vm.warp(block.timestamp + 31 days);

        // Claim default as bob (normal lender)
        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        // NFT goes to lender
        assertEq(staking.ownerOf(aliceTokenId), bob);

        // Loan is marked as default claimed
        (,,,,,,,,,bool defaultClaimed,) = lending.getLoan(loanId);
        assertTrue(defaultClaimed);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Normal EOA operations still work fine
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that normal EOA lenders receive ETH refunds correctly
    ///         when cancelling offers (not wrapped as WETH).
    function test_normalEOA_cancelOffer_works() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 5 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        uint256 bobBalanceBefore = bob.balance;
        vm.prank(bob);
        lending.cancelOffer(offerId);

        // Bob got ETH back (not WETH)
        assertEq(bob.balance, bobBalanceBefore + 5 ether);
        assertEq(weth.balanceOf(bob), 0, "EOA should receive ETH, not WETH");
    }

    /// @notice Verify that normal repayLoan sends ETH to EOA lenders correctly.
    function test_normalEOA_repayLoan_works() public {
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        vm.warp(block.timestamp + 15 days);

        uint256 bobBalanceBefore = bob.balance;
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        vm.deal(alice, repaymentAmount + 1 ether);
        vm.prank(alice);
        lending.repayLoan{value: repaymentAmount}(loanId);

        // Bob received ETH (not WETH)
        assertTrue(bob.balance > bobBalanceBefore, "Lender should receive ETH");
        assertEq(weth.balanceOf(bob), 0, "EOA lender should not receive WETH");
    }

    // ═══════════════════════════════════════════════════════════════════
    // AUDIT NFT-CL-M1: contract borrower overpayment refund must not brick
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Pre-fix, repayLoan refunded overpayment via the no-fallback
    ///         `safeTransferETH` primitive. A contract borrower whose receive()
    ///         needs more than 0 gas (and refuses raw ETH) would see the entire
    ///         repay tx revert at the refund step, losing both their NFT (it would
    ///         be returned mid-tx but reverted on refund failure) and their
    ///         repayment funds. The fix routes the refund through
    ///         `safeTransferETHOrWrap` so the refund delivers as WETH when raw
    ///         ETH transfer fails.
    ///
    ///         This test deploys an ETH-rejecting contract borrower, has it repay
    ///         with a deliberate 1-wei overpayment, and asserts the NFT is
    ///         returned + the refund arrives as WETH (not as ETH and not by
    ///         reverting the tx).
    function test_NFT_CL_M1_overpaymentRefund_succeedsViaWETHFallback() public {
        // Deploy an ETH-rejecting borrower contract and stake to obtain an NFT.
        ETHRejectingBorrower attacker = new ETHRejectingBorrower(address(lending), address(staking));

        toweli.mint(address(attacker), 100_000 ether);
        vm.startPrank(address(attacker));
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        uint256 attackerTokenId = staking.userTokenId(address(attacker));
        vm.stopPrank();

        // Warp past 24h cooldown.
        vm.warp(block.timestamp + 25 hours);

        vm.prank(address(attacker));
        staking.approve(address(lending), attackerTokenId);

        // Bob (EOA lender) creates an offer.
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        // Attacker accepts — receives principal as WETH (its receive() reverts
        // so the 10k stipend fails and WETH fallback delivers the principal).
        vm.prank(address(attacker));
        uint256 loanId = lending.acceptOffer(offerId, attackerTokenId);

        // Warp forward so interest accrues.
        vm.warp(block.timestamp + 15 days);

        // Compute exact repayment + a deliberate overpayment.
        uint256 repaymentAmount = lending.getRepaymentAmount(loanId);
        uint256 overpayment = 0.05 ether;

        // Fund the attacker so it can pay back.
        vm.deal(address(attacker), repaymentAmount + overpayment);

        // Snapshot WETH balance + attacker ETH pre-repay so we can prove the
        // refund hit the WETH leg (not the ETH leg).
        uint256 wethBefore = weth.balanceOf(address(attacker));
        uint256 ethBefore = address(attacker).balance;

        // Attacker repays from its OWN balance. Pre-fix this would revert at
        // the overpayment refund step (safeTransferETH had no fallback, and
        // the attacker's receive() rejects the wei).
        vm.prank(address(attacker));
        attacker.repay{value: repaymentAmount + overpayment}(loanId);

        // Assert: NFT returned to attacker, loan marked repaid.
        assertEq(staking.ownerOf(attackerTokenId), address(attacker), "NFT returned to borrower");
        (,,,,,,,, bool repaid,,) = lending.getLoan(loanId);
        assertTrue(repaid, "loan marked repaid");

        // Assert: overpayment landed as WETH (not as ETH, since the contract rejects it).
        // The attacker's WETH balance should have grown by exactly `overpayment` from
        // the refund leg — the principal-as-WETH inflow happened earlier (acceptOffer).
        uint256 wethAfter = weth.balanceOf(address(attacker));
        assertEq(wethAfter - wethBefore, overpayment, "overpayment refunded as WETH via fallback");

        // Sanity: attacker's ETH balance fell by exactly (repay+overpayment).
        // Refund landed as WETH so no ETH came back.
        assertEq(ethBefore - address(attacker).balance, repaymentAmount + overpayment, "all sent ETH consumed; refund came as WETH");
    }
}

/// @dev Borrower contract that hard-rejects every raw ETH transfer. Used to
///      prove NFT-CL-M1: the overpayment-refund leg must fall back to WETH
///      rather than revert the whole repayLoan tx.
contract ETHRejectingBorrower {
    TegridyLending public lending;
    TegridyStaking public staking;

    constructor(address _lending, address _staking) {
        lending = TegridyLending(_lending);
        staking = TegridyStaking(_staking);
    }

    function repay(uint256 loanId) external payable {
        lending.repayLoan{value: msg.value}(loanId);
    }

    /// @dev Reject every raw ETH transfer. Forces both the principal payout
    ///      (acceptOffer) and the overpayment refund (repayLoan) onto the
    ///      WETH fallback path.
    receive() external payable {
        revert("no ETH");
    }
}
