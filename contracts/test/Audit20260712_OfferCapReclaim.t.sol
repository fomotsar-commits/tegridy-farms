// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

// ─── Mocks (mirrored from TegridyLending.t.sol so this file compiles standalone) ───

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

contract MockWETHLending {
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
}

/// @title AUDIT FIX 2026-07-12 regression — reclaimable global offer cap
/// @notice The global MAX_TOTAL_OFFERS ceiling previously gated on the
///         append-only `offers.length`, so a gas-only create→cancel loop
///         (principal fully refunded) permanently consumed the 10k lifetime
///         budget and bricked offer creation for EVERY user. The fix gates on
///         a live `activeOfferCount` that is decremented on the two
///         active→inactive transitions (cancel + accept). This suite pins that
///         reclaim behaviour and the no-double-decrement invariant.
contract Audit20260712_OfferCapReclaimTest is Test {
    MockToweli public toweli;
    MockJBAC public jbac;
    MockWETHLending public weth;
    MockTegridyPairLending public pair;
    TegridyStaking public staking;
    TegridyLending public lending;
    TegridyLendingAdmin public lendingAdmin;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice"); // borrower — has staking NFT
    address public bob = makeAddr("bob"); // lender — has ETH

    uint256 public aliceTokenId;

    function setUp() public {
        vm.chainId(1);
        toweli = new MockToweli();
        jbac = new MockJBAC();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);

        weth = new MockWETHLending();
        pair = new MockTegridyPairLending(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);
        TegridyTWAP twap = new TegridyTWAP(address(this), address(0));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        vm.warp(block.timestamp + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        // Fund alice with TOWELI and stake to mint a collateral position NFT.
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Warp past the 24h transfer cooldown; approve lending to pull the NFT.
        vm.warp(block.timestamp + 25 hours);
        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(bob, 1_000 ether);
    }

    function _createOffer() internal returns (uint256) {
        vm.prank(bob);
        return lending.createLoanOffer{value: 1 ether}(
            1000, // 10% APR
            30 days,
            address(staking),
            1000 ether, // min position value (alice has 10_000)
            0 // min position ETH value (disabled)
        );
    }

    /// @dev CORE REGRESSION: a create→cancel loop grows the append-only array
    ///      but NOT the live counter. Under the pre-fix code the global cap
    ///      gated on `offerCount()` (the array length) which is what this asserts
    ///      diverges from `activeOfferCount()`. If the two were still coupled
    ///      (the bug), the 10k budget would be spent by lifetime creations.
    function test_createCancelLoop_reclaimsGlobalBudget() public {
        uint256 cycles = 5;
        for (uint256 i = 0; i < cycles; i++) {
            uint256 id = _createOffer();
            // While live, the counter tracks the open offer.
            assertEq(lending.activeOfferCount(), 1, "counter should be 1 while offer is live");
            vm.prank(bob);
            lending.cancelOffer(id);
            // After cancel, the live counter is fully reclaimed...
            assertEq(lending.activeOfferCount(), 0, "counter must reclaim to 0 on cancel");
        }

        // ...but the append-only array kept every lifetime slot (indices stable).
        assertEq(lending.offerCount(), cycles, "array is append-only across cycles");
        // The load-bearing invariant: live budget < lifetime creations.
        assertLt(lending.activeOfferCount(), lending.offerCount(), "cap must be reclaimable, not lifetime");

        // Creation still works with a low live counter despite many lifetime entries.
        uint256 fresh = _createOffer();
        assertEq(fresh, cycles, "next offerId continues the append-only sequence");
        assertEq(lending.activeOfferCount(), 1, "fresh live offer counted");
    }

    /// @dev acceptOffer is the OTHER active→inactive transition — it must also
    ///      decrement the global counter (exactly once).
    function test_acceptOffer_decrementsGlobalCounter() public {
        uint256 id = _createOffer();
        assertEq(lending.activeOfferCount(), 1);

        vm.prank(alice);
        lending.acceptOffer(id, aliceTokenId);

        assertEq(lending.activeOfferCount(), 0, "counter must reclaim to 0 on accept");
        assertEq(lending.offerCount(), 1, "array unchanged by accept");
    }

    /// @dev No double-decrement: an offer transitions active→inactive at most
    ///      once. A second cancel reverts (OfferNotActive) so the counter can
    ///      never be decremented twice for the same offer.
    function test_noDoubleDecrement_onSecondCancel() public {
        uint256 id = _createOffer();
        vm.prank(bob);
        lending.cancelOffer(id);
        assertEq(lending.activeOfferCount(), 0);

        // Second cancel is rejected before any state change.
        vm.prank(bob);
        vm.expectRevert(TegridyLending.OfferNotActive.selector);
        lending.cancelOffer(id);

        // Cannot be accepted after cancel either (would be a phantom decrement).
        vm.prank(alice);
        vm.expectRevert(TegridyLending.OfferNotActive.selector);
        lending.acceptOffer(id, aliceTokenId);

        assertEq(lending.activeOfferCount(), 0, "counter never goes negative / double-decrements");
    }
}
