// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title PASS8 Phase 3.5 — TegridyLending offer expiry
/// @notice Validates the pass-8 batch-15 fix that closes the stale-quote
///         exposure on `acceptOffer`. Pre-fix, lender's quote at favorable
///         terms (e.g. ETH=4,000) remained accept-able indefinitely until
///         the lender remembered to call `cancelOffer` — combined with the
///         fixed `aprBps` and `minPositionETHValue`, a borrower could
///         acquire a loan at obsolete terms long after market drift.
///
///         Post-fix:
///         - LoanOffer struct gains a `uint64 expiry` field (Phase 3.5).
///         - `createLoanOffer(...)` (5-arg) auto-defaults expiry to MAX_OFFER_VALIDITY (90d).
///         - `createLoanOfferWithExpiry(...)` (6-arg) lets lenders choose a tighter expiry.
///         - `acceptOffer` reverts `OfferExpired()` once `block.timestamp > offer.expiry`.
///         - Bounds: `[block.timestamp + MIN_OFFER_VALIDITY, ... + MAX_OFFER_VALIDITY]`
///           — caller-supplied expiry outside this window reverts `InvalidOfferExpiry()`.

// ─── Mocks ───────────────────────────────────────────────────────────

contract P35_Toweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract P35_JBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 id = _nextId++; _mint(to, id); return id; }
}

contract P35_WETH {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

contract P35_Pair {
    address public token0;
    address public token1;
    uint112 reserve0;
    uint112 reserve1;
    uint32 blockTimestampLast;
    constructor(address t0, address t1, uint112 r0, uint112 r1) {
        token0 = t0; token1 = t1; reserve0 = r0; reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
    function price0CumulativeLast() external pure returns (uint256) { return 0; }
    function price1CumulativeLast() external pure returns (uint256) { return 0; }
}

contract P35_FactoryForTWAP {
    mapping(address => bool) internal _isPair;
    mapping(address => bool) public disabledPairs;
    function tagPair(address p) external { _isPair[p] = true; }
    function isPair(address p) external view returns (bool) { return _isPair[p]; }
}

// ─── Test ────────────────────────────────────────────────────────────

contract PASS8_PHASE_3_5 is Test {
    P35_Toweli toweli;
    P35_JBAC jbac;
    P35_WETH weth;
    P35_Pair pair;
    TegridyStaking staking;
    TegridyStakingAdmin stakingAdmin;
    TegridyStakingJbacVault vault;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin;
    TegridyTWAP twap;

    address treasury = makeAddr("p35_treasury");
    address alice = makeAddr("p35_alice"); // borrower
    address bob = makeAddr("p35_bob");     // lender

    uint256 aliceTokenId;

    function setUp() public {
        vm.warp(1_700_000_000);

        toweli = new P35_Toweli();
        jbac = new P35_JBAC();
        weth = new P35_WETH();
        pair = new P35_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 0.001 ether);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        // Bootstrap TWAP with 3 observations.
        P35_FactoryForTWAP fac = new P35_FactoryForTWAP();
        fac.tagPair(address(pair));
        twap = new TegridyTWAP(address(fac), address(0));
        twap.update(address(pair));
        skip(16 minutes);
        twap.update(address(pair));
        skip(30 minutes);
        twap.update(address(pair));

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        // Whitelist staking as collateral via 48h timelock with TWAP refreshes
        // to avoid bypass-cooldown trip.
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(22 hours); twap.update(address(pair));
        skip(22 hours); twap.update(address(pair));
        skip(4 hours + 1); twap.update(address(pair));
        lendingAdmin.executeAcceptedCollateral();

        // Alice stakes a position to collateralize.
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        staking.approve(address(lending), aliceTokenId);
        vm.stopPrank();

        vm.deal(bob, 100 ether);
    }

    /// @notice Backward-compat 5-arg form auto-defaults expiry to MAX_OFFER_VALIDITY.
    function test_phase35_5argDefaultsExpiryTo90Days() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
        (,,,,,,,,,, uint64 expiry,) = lending.offers(offerId);
        assertEq(expiry, uint64(block.timestamp + lending.MAX_OFFER_VALIDITY()));
    }

    /// @notice Custom-expiry form respects the caller's choice.
    function test_phase35_explicitExpiry() public {
        uint64 customExpiry = uint64(block.timestamp + 7 days);
        vm.prank(bob);
        uint256 offerId = lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0, customExpiry
        );
        (,,,,,,,,,, uint64 expiry,) = lending.offers(offerId);
        assertEq(expiry, customExpiry);
    }

    /// @notice Expiry below MIN_OFFER_VALIDITY reverts InvalidOfferExpiry.
    function test_phase35_revertsBelowMinValidity() public {
        // 30 minutes < MIN_OFFER_VALIDITY (1 hour)
        uint64 badExpiry = uint64(block.timestamp + 30 minutes);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.InvalidOfferExpiry.selector);
        lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0, badExpiry
        );
    }

    /// @notice Expiry above MAX_OFFER_VALIDITY reverts InvalidOfferExpiry.
    function test_phase35_revertsAboveMaxValidity() public {
        // 91 days > MAX_OFFER_VALIDITY (90 days)
        uint64 badExpiry = uint64(block.timestamp + 91 days);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.InvalidOfferExpiry.selector);
        lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0, badExpiry
        );
    }

    /// @notice Expiry in the past reverts InvalidOfferExpiry.
    function test_phase35_revertsPastExpiry() public {
        uint64 badExpiry = uint64(block.timestamp - 1);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.InvalidOfferExpiry.selector);
        lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0, badExpiry
        );
    }

    /// @notice Happy-path acceptance succeeds before expiry.
    function test_phase35_acceptBeforeExpiry() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0,
            uint64(block.timestamp + 7 days)
        );

        // Accept 1 day later — well within validity window.
        skip(1 days);
        vm.prank(alice);
        lending.acceptOffer(offerId, aliceTokenId);
        // No revert — acceptance landed.
    }

    /// @notice Acceptance after expiry reverts OfferExpired.
    function test_phase35_acceptAfterExpiryReverts() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0,
            uint64(block.timestamp + 7 days)
        );

        // Skip past the offer's expiry.
        skip(7 days + 1);

        vm.prank(alice);
        vm.expectRevert(TegridyLending.OfferExpired.selector);
        lending.acceptOffer(offerId, aliceTokenId);
    }

    /// @notice Lender can cancel an unexpired offer to recover principal.
    function test_phase35_cancelUnexpiredOfferRecoversPrincipal() public {
        uint256 bobBalBefore = bob.balance;
        vm.prank(bob);
        uint256 offerId = lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0,
            uint64(block.timestamp + 7 days)
        );

        // Cancel within validity window.
        vm.prank(bob);
        lending.cancelOffer(offerId);

        // Bob got their full principal + originationFee back.
        assertEq(bob.balance, bobBalBefore);
    }

    /// @notice Lender can cancel an EXPIRED offer to recover principal.
    function test_phase35_cancelExpiredOfferRecoversPrincipal() public {
        uint256 bobBalBefore = bob.balance;
        vm.prank(bob);
        uint256 offerId = lending.createLoanOfferWithExpiry{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0,
            uint64(block.timestamp + 7 days)
        );

        // Skip past expiry.
        skip(7 days + 1);

        // Cancel still works on an expired offer (cancelOffer doesn't check expiry).
        vm.prank(bob);
        lending.cancelOffer(offerId);

        assertEq(bob.balance, bobBalBefore);
    }

    /// @notice MIN_OFFER_VALIDITY and MAX_OFFER_VALIDITY constants are exposed.
    function test_phase35_constantsExposed() public view {
        assertEq(lending.MIN_OFFER_VALIDITY(), 1 hours);
        assertEq(lending.MAX_OFFER_VALIDITY(), 90 days);
    }
}
