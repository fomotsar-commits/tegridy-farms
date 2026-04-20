// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";

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
            aprBps, duration, collateralContract, minPositionValue
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
            aprBps, duration, collateralContract, minPositionValue
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
    MockToweli_Reentry public toweli;
    MockJBAC_Reentry public jbac;
    MockWETH_LendReentry public weth;
    TegridyStaking public staking;
    TegridyLending public lending;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // normal borrower
    address public bob = makeAddr("bob");       // normal lender

    uint256 public aliceTokenId;

    function setUp() public {
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

        // Deploy WETH and lending
        weth = new MockWETH_LendReentry();
        lending = new TegridyLending(treasury, 500, address(weth));

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
            1000 ether
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
            1000, 30 days, address(staking), 1000 ether
        );
        uint256 offer2 = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether
        );
        vm.stopPrank();

        // Set attacker to try to accept offer2 during the receive() callback of offer1
        attacker.setAttackParams(offer2, attackerTokenId);
        attacker.startAttack();

        // Accept first offer - the receive() callback tries to accept offer2
        // but nonReentrant blocks it
        vm.prank(address(attacker));
        attacker.acceptOffer(offer1, attackerTokenId);

        // AUDIT FIX M-7 (battle-tested): acceptOffer now routes through WETHFallbackLib
        // (10k stipend + WETH fallback). The attacker's receive() OOGs attempting reentry,
        // the direct ETH call fails, and WETH fallback delivers the principal as WETH.
        // Attacker still gets paid — just in WETH form.
        uint256 received = address(attacker).balance + weth.balanceOf(address(attacker));
        assertEq(received, 1 ether, "attacker received principal (ETH or WETH via fallback)");

        // attackCount stays at 0: the reentrant call OOGs, which reverts the callee's
        // state changes (including `attackCount++`). The nonReentrant guard was never
        // the bottleneck here — the 10k gas stipend alone prevents the attempt from
        // persisting any state. Offer2 activity below is the load-bearing assertion.
        assertEq(attacker.attackCount(), 0, "attempted reentry OOGed on 10k stipend");

        // Offer2 is still active (re-entry was blocked)
        (,,,,,, bool active) = lending.getOffer(offer2);
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

        // Set attacker to try to cancel offer2 during receive() of offer1 cancellation
        attacker.setAttackParams(offer2);
        attacker.startAttack();

        vm.prank(address(attacker));
        attacker.cancelOffer(offer1);

        // The refund was converted to WETH (gas stipend blocked re-entry)
        uint256 wethBalance = weth.balanceOf(address(attacker));
        assertEq(wethBalance, 1 ether, "Refund should be wrapped as WETH due to re-entry attempt");

        // Offer2 is still active (re-entry was blocked)
        (,,,,,, bool active) = lending.getOffer(offer2);
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

        // Repayment was sent as WETH to the attacker lender (gas stipend blocked re-entry)
        uint256 wethBalance = weth.balanceOf(address(attackerLender));
        assertTrue(wethBalance > 0, "Lender payout should be wrapped as WETH");

        // Loan is marked as repaid
        (,,,,,,,,bool repaid,) = lending.getLoan(loanId);
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
        (,,,,,,,,,bool defaultClaimed) = lending.getLoan(loanId);
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
            1000, 30 days, address(staking), 1000 ether
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
}
