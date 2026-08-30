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

/// @dev Attacker that acts as a borrower and tries to re-enter `acceptOffer`
///      when receiving the principal ETH. Two independent layers are supposed
///      to stop it: `WETHFallbackLib`'s gas stipend on the raw-ETH leg, and
///      `acceptOffer`'s own `nonReentrant` guard.
///
///      ── Why the arming state is a NON-ZERO sentinel, not a counter ──
///      `receive()` runs inside `WETHFallbackLib.ETH_TRANSFER_GAS_STIPEND`, so
///      every slot it touches is charged against that budget. An
///      `attackCount++` from 0 costs 20,000 gas (SSTORE_SET) by itself —
///      measured on forge 1.5.1 it was the dominant cost of this `receive()`,
///      leaving only ~27% headroom against the 32,300 available (30k stipend +
///      the 2,300 value stipend). That is thin enough that ordinary codegen
///      drift between toolchain releases can change this test's OUTCOME on
///      unchanged contract code — which is exactly how the sibling
///      `TegridyNFTPool_Reentrancy.t.sol` went red under forge 1.8.0. Arming
///      to a non-zero value first makes the write inside `receive()` a cheap
///      dirty-slot store (~100 gas).
///
///      0 = idle, 1 = armed, 2 = attempted and rejected, 3 = attempted and
///      SUCCEEDED (i.e. the reentrancy defence failed).
contract ReentrantBorrower {
    TegridyLending public lending;
    TegridyStaking public staking;
    bool public attacking;
    uint8 public attackState;
    uint256 public targetOfferId;
    uint256 public targetTokenId;

    /// @notice True once `receive()` has fired and made its one re-entrancy attempt.
    function attempted() external view returns (bool) {
        return attackState >= 2;
    }

    /// @notice True iff the re-entrant call actually returned successfully — i.e. the
    ///         reentrancy defence FAILED. Recorded rather than reverted on: a
    ///         `revert` here would unwind the whole `receive()` frame including the
    ///         successful re-entry's own state changes, so a broken guard would erase
    ///         its own evidence and become indistinguishable from a `receive()` that
    ///         merely ran out of gas.
    function reentrySucceeded() external view returns (bool) {
        return attackState == 3;
    }

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
        attackState = 1;
    }

    function acceptOffer(uint256 offerId, uint256 tokenId) external returns (uint256) {
        return lending.acceptOffer(offerId, tokenId);
    }

    function approveNFT(uint256 tokenId) external {
        staking.approve(address(lending), tokenId);
    }

    /// @dev When receiving principal ETH from acceptOffer, try to re-enter.
    ///      `acceptOffer` is not payable and this call carries no value, so it
    ///      reaches `nonReentrant` rather than dying at the callvalue check.
    receive() external payable {
        if (attacking && attackState == 1) {
            attackState = 2; // disarm first: one-shot, and cheap (dirty-slot store)
            try lending.acceptOffer(targetOfferId, targetTokenId) {
                attackState = 3; // re-entrancy SUCCEEDED — the defence failed
            } catch {
                // Expected: rejected by `nonReentrant` (verified by trace), or
                // starved by the stipend if the guard were ever removed.
            }
        }
    }
}

/// @dev Attacker that acts as a lender and tries to re-enter `cancelOffer`
///      when receiving the refund ETH. Two independent layers are supposed to
///      stop it: `WETHFallbackLib`'s gas stipend on the raw-ETH leg, and
///      `cancelOffer`'s own `nonReentrant` guard. See `ReentrantBorrower` above
///      for why `attackState` is a non-zero sentinel rather than a counter, and
///      why a successful re-entry is RECORDED rather than reverted on.
contract ReentrantLender {
    TegridyLending public lending;
    bool public attacking;
    uint8 public attackState;
    uint256 public targetOfferId;

    /// @notice True once `receive()` has fired and made its one re-entrancy attempt.
    function attempted() external view returns (bool) {
        return attackState >= 2;
    }

    /// @notice True iff the re-entrant call actually returned successfully — i.e. the
    ///         reentrancy defence FAILED.
    function reentrySucceeded() external view returns (bool) {
        return attackState == 3;
    }

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
        attackState = 1;
    }

    /// @dev When receiving the ETH refund from cancelOffer, try to re-enter.
    ///      `cancelOffer` is not payable and this call carries no value, so it
    ///      reaches `nonReentrant` rather than dying at the callvalue check.
    receive() external payable {
        if (attacking && attackState == 1) {
            attackState = 2; // disarm first: one-shot, and cheap (dirty-slot store)
            try lending.cancelOffer(targetOfferId) {
                attackState = 3; // re-entrancy SUCCEEDED — the defence failed
            } catch {
                // Expected: rejected by `nonReentrant` (verified by trace), or
                // starved by the stipend if the guard were ever removed.
            }
        }
    }
}

/// @dev Attacker that acts as a lender and tries to re-enter during repayLoan
///      when the lender receives their principal + interest via WETHFallbackLib.
///      Re-entry target is `claimDefaultedCollateral`, which shares the same
///      `nonReentrant` lock as `repayLoan`. See `ReentrantBorrower` above for
///      why `attackState` is a non-zero sentinel rather than a counter, and why
///      a successful re-entry is RECORDED rather than reverted on.
contract ReentrantRepayLender {
    TegridyLending public lending;
    bool public attacking;
    uint8 public attackState;
    uint256 public targetLoanId;

    /// @notice True once `receive()` has fired and made its one re-entrancy attempt.
    function attempted() external view returns (bool) {
        return attackState >= 2;
    }

    /// @notice True iff the re-entrant call actually returned successfully — i.e. the
    ///         reentrancy defence FAILED.
    function reentrySucceeded() external view returns (bool) {
        return attackState == 3;
    }

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
        attackState = 1;
    }

    function claimDefaultedCollateral(uint256 loanId) external {
        lending.claimDefaultedCollateral(loanId);
    }

    /// @dev When receiving repayment ETH, try to re-enter claimDefaultedCollateral.
    ///      That function is not payable and this call carries no value, so it
    ///      reaches `nonReentrant` rather than dying at the callvalue check.
    receive() external payable {
        if (attacking && attackState == 1) {
            attackState = 2; // disarm first: one-shot, and cheap (dirty-slot store)
            try lending.claimDefaultedCollateral(targetLoanId) {
                attackState = 3; // re-entrancy SUCCEEDED — the defence failed
            } catch {
                // Expected: rejected by `nonReentrant` (verified by trace), or
                // starved by the stipend if the guard were ever removed.
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

        // 0. The attack was actually attempted. Without this the test could pass
        //    vacuously if `receive()` never fired at all.
        assertTrue(attacker.attempted(), "re-entrancy must actually have been attempted");

        // 1. The borrower is made whole EXACTLY ONCE, counting ETH and WETH together.
        //    Asset-type agnostic on purpose: a WETH fallback only moves value from the
        //    ETH balance to the WETH balance, so the SUM is the invariant while the
        //    individual legs are not. Which leg delivers is decided by whether this
        //    attacker's `receive()` fits inside `WETHFallbackLib`'s stipend — a gas
        //    margin, not a security property.
        uint256 received = address(attacker).balance + weth.balanceOf(address(attacker));
        assertEq(received, 1 ether, "attacker received principal (ETH or WETH via fallback)");

        // 2. The re-entrant `acceptOffer` did not execute. Traced on forge 1.5.1: the
        //    inner call reaches the dispatcher and reverts with
        //    `ReentrancyGuardReentrantCall()` — it is rejected by the guard, not
        //    starved by the stipend and not bounced at a callvalue check.
        //
        //    Scope note (mutation-verified, forge 1.5.1): deleting `nonReentrant` from
        //    `acceptOffer` leaves this test GREEN, because CEI ordering independently
        //    blocks the re-entry — the collateral NFT is escrowed to the lending
        //    contract before the principal is paid out, so the inner call dies on
        //    `NotNFTOwner()` instead. That is defence in depth working as intended,
        //    not a gap here; `test_reentrancy_cancelOffer_blocked` is the test that
        //    pins the guard itself.
        assertFalse(attacker.reentrySucceeded(), "re-entrant acceptOffer must not succeed");

        // Offer2 is still active (re-entry was blocked)
        (,,,,,,, bool active,,) = lending.getOffer(offer2);
        assertTrue(active, "Offer2 should still be active - re-entry was blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: cancelOffer - lender re-entry during refund
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A malicious lender contract tries to re-enter `cancelOffer` while
    ///         receiving its ETH refund. It is refunded exactly once and the
    ///         re-entrant call does not execute.
    ///
    /// @dev    ASSERT THE SECURITY PROPERTY, NOT THE DELIVERY ASSET. Whether the
    ///         refund lands as raw ETH or as wrapped WETH is decided by whether
    ///         this attacker's `receive()` happens to fit inside
    ///         `WETHFallbackLib.ETH_TRANSFER_GAS_STIPEND` — a gas margin, not an
    ///         invariant. `safeTransferETHOrWrap` makes ONE
    ///         `to.call{gas: STIPEND}` and silently wraps to WETH if it fails, so
    ///         a codegen shift between toolchain releases can move the outcome
    ///         across that line with zero contract changes. That is exactly how
    ///         the sibling `TegridyNFTPool_Reentrancy.t.sol` was reddened by
    ///         forge 1.8.0, and this docstring used to assert the opposite of
    ///         what the code did: it claimed the refund "is sent as WETH", while
    ///         the comment 25 lines below claimed raw ETH. Traced on forge 1.5.1
    ///         the refund is in fact delivered as raw ETH — but that is an
    ///         outcome, not a promise, so nothing here depends on it.
    ///
    ///         The stipend is 30_000 (`ETH_TRANSFER_GAS_STIPEND`, M-36
    ///         [F-40-WFL-1]), not the 10_000 this file used to name.
    ///
    ///         What IS invariant, and what is asserted below:
    ///           1. the lender is made whole exactly once, counting ETH + WETH
    ///              together — a WETH fallback only moves value between those two
    ///              balances, so their sum is what holds;
    ///           2. the re-entrant `cancelOffer` does not execute — it is
    ///              recorded as rejected, and offer2 is still active afterwards.
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

        // 0. The attack was actually attempted, so the assertions below are not
        //    passing vacuously on a `receive()` that never fired.
        assertTrue(attacker.attempted(), "re-entrancy must actually have been attempted");

        // 1. Refunded EXACTLY ONCE, whichever leg carried it. See the docstring:
        //    the ETH-vs-WETH split is a gas-margin outcome, so the sum of the two
        //    balances is the thing that is actually invariant here.
        uint256 received = address(attacker).balance + weth.balanceOf(address(attacker)) - balBefore;
        assertEq(received, 1 ether, "Refund delivered (ETH or WETH) - reentry blocked by guard");

        // 2. The re-entrant `cancelOffer` did not execute. Traced on forge 1.5.1: the
        //    inner call reverts with `ReentrancyGuardReentrantCall()` — rejected by the
        //    guard, not starved by the stipend and not bounced at a callvalue check.
        //
        //    MUTATION-VERIFIED (forge 1.5.1), and this test is the one that genuinely
        //    pins the guard:
        //      | mutation                     | result                              |
        //      | ---------------------------- | ----------------------------------- |
        //      | none                         | GREEN                               |
        //      | `nonReentrant` removed       | RED — refund paid twice (2 ETH)     |
        //      | stipend raised to 500_000    | GREEN — guard still rejects         |
        //      | both                         | RED — refund paid twice (2 ETH)     |
        //
        //    Unlike the acceptOffer/repayLoan cases below, no state check stands in
        //    for the guard here: offer2 is a separate, still-active offer, so a
        //    re-entrant cancel is perfectly valid business logic and ONLY the lock
        //    stops it draining a second refund.
        assertFalse(attacker.reentrySucceeded(), "re-entrant cancelOffer must not succeed");

        // Offer2 is still active (re-entry was blocked)
        (,,,,,,, bool active,,) = lending.getOffer(offer2);
        assertTrue(active, "Offer2 should still be active - re-entry was blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: repayLoan - lender re-entry during repayment payout
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A malicious lender contract tries to re-enter during `repayLoan`
    ///         while receiving its principal + interest. It is paid once, the
    ///         re-entrant `claimDefaultedCollateral` does not execute, and the
    ///         borrower's NFT comes back.
    ///
    /// @dev    ASSERT THE SECURITY PROPERTY, NOT THE DELIVERY ASSET — same
    ///         reasoning as `test_reentrancy_cancelOffer_blocked` above. This
    ///         docstring used to claim the payout "is sent as WETH"; traced on
    ///         forge 1.5.1 it is actually delivered as raw ETH. Neither is a
    ///         promise: `safeTransferETHOrWrap` picks the leg by whether the
    ///         recipient's `receive()` fits the 30_000-gas stipend
    ///         (`ETH_TRANSFER_GAS_STIPEND`, M-36 [F-40-WFL-1] — not the 10_000
    ///         this file used to name), which is a gas margin that toolchain
    ///         drift can cross on unchanged contract code.
    ///
    ///         What IS invariant, and what is asserted below:
    ///           1. the lender is paid, counting ETH + WETH together;
    ///           2. the re-entrant `claimDefaultedCollateral` does not execute;
    ///           3. the loan is marked repaid and the collateral NFT returns to
    ///              the borrower — a successful re-entry would have seized it.
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

        // 0. The attack was actually attempted, so the assertions below are not
        //    passing vacuously on a `receive()` that never fired.
        assertTrue(attackerLender.attempted(), "re-entrancy must actually have been attempted");

        // 1. The lender was paid, counting ETH and WETH together — asset-agnostic
        //    for the reason given in the docstring.
        uint256 received = address(attackerLender).balance + weth.balanceOf(address(attackerLender));
        assertGt(received, 0, "Lender payout delivered (ETH or WETH) - reentry blocked by guard");

        // 2. The re-entrant `claimDefaultedCollateral` did not execute. Traced on
        //    forge 1.5.1: the inner call reverts with `ReentrancyGuardReentrantCall()`.
        //    This is the assertion that makes the NFT check below meaningful — a
        //    successful re-entry would have seized alice's collateral mid-repayment.
        //
        //    Scope note (mutation-verified, forge 1.5.1): deleting `nonReentrant` from
        //    `claimDefaultedCollateral` leaves this test GREEN, because CEI ordering
        //    independently blocks the re-entry — the loan is marked repaid before the
        //    lender is paid, so the inner call dies on `LoanAlreadyRepaid()` instead.
        //    Defence in depth working as intended; see
        //    `test_reentrancy_cancelOffer_blocked` for the case that pins the guard.
        assertFalse(attackerLender.reentrySucceeded(), "re-entrant claimDefaultedCollateral must not succeed");

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

        // Attacker accepts — receives principal as WETH. Unlike the gas-margin
        // cases above, this one IS deterministic: `ETHRejectingBorrower.receive()`
        // reverts unconditionally, so the raw-ETH leg fails at any stipend and the
        // WETH fallback is the only path. Asserting the asset here is therefore
        // legitimate; asserting it on a `receive()` that does real work is not.
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
