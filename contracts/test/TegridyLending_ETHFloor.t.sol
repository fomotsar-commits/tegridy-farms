// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLending.sol";

// ─── Mock Contracts ─────────────────────────────────────────────────

contract MockToweliETHFloor is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBACETHFloor is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockWETHETHFloor {
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

/// @dev Mutable TegridyPair mock. Tests seed reserves so the spot price is
///      deterministic, then can shift reserves to simulate a price drop.
contract MockTegridyPairETHFloor {
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

/// @title TegridyLending_ETHFloorTest — AUDIT critique 5.4 coverage
/// @notice Exercises the optional ETH-denominated collateral floor added to
///         TegridyLending.createLoanOffer / acceptOffer. Floor is gated on the
///         lender opting in (non-zero minPositionETHValue); zero is a no-op.
contract TegridyLending_ETHFloorTest is Test {
    MockToweliETHFloor public toweli;
    MockJBACETHFloor public jbac;
    MockWETHETHFloor public weth;
    MockTegridyPairETHFloor public pair;
    TegridyStaking public staking;
    TegridyLending public lending;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");   // borrower
    address public bob = makeAddr("bob");       // lender

    uint256 public aliceTokenId;
    uint256 public constant STAKE_AMOUNT = 10_000 ether;

    // Seed reserves: 1_000_000 TOWELI vs 1_000 WETH ⇒ spot price = 1 TOWELI = 0.001 ETH.
    //   => 10_000 TOWELI ≈ 10 ETH.
    uint112 public constant INITIAL_TOWELI_RESERVE = 1_000_000 ether;
    uint112 public constant INITIAL_WETH_RESERVE = 1_000 ether;

    function setUp() public {
        toweli = new MockToweliETHFloor();
        jbac = new MockJBACETHFloor();
        weth = new MockWETHETHFloor();

        // Seed pair so `10_000 TOWELI` values at ~10 ETH.
        pair = new MockTegridyPairETHFloor(
            address(toweli),
            address(weth),
            INITIAL_TOWELI_RESERVE,
            INITIAL_WETH_RESERVE
        );

        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            1e18
        );

        lending = new TegridyLending(treasury, 500, address(weth), address(pair));

        // Fund alice and have her stake for a collateral position.
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(STAKE_AMOUNT, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Warp past the staking NFT transfer cooldown.
        vm.warp(block.timestamp + 25 hours);

        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        vm.deal(bob, 100 ether);
    }

    // ─── zero-floor backward compatibility ─────────────────────────

    /// @notice minPositionETHValue = 0 disables the ETH-floor check. Borrower
    ///         accepts regardless of the pair's current spot price. This is the
    ///         pre-batch-7d behaviour — confirms lender opt-in default stays cheap.
    function test_zeroFloor_isNoOp() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );

        // Tank the ETH value of TOWELI by 99% — floor is off, so this is irrelevant.
        pair.setReserves(INITIAL_TOWELI_RESERVE, INITIAL_WETH_RESERVE / 100);

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        assertEq(alice.balance - aliceBalBefore, 1 ether);
        (,,,,,,,, bool repaid,) = lending.getLoan(loanId);
        assertFalse(repaid);
        assertEq(staking.ownerOf(aliceTokenId), address(lending));
    }

    // ─── floor met ────────────────────────────────────────────────

    /// @notice Standard happy path: floor is set, reserves value the position
    ///         above the floor, acceptOffer succeeds.
    function test_floorMet() public {
        // Floor: 5 ETH. Alice's position values at ~10 ETH per setUp reserves.
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 5 ether
        );

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        lending.acceptOffer(offerId, aliceTokenId);

        assertEq(alice.balance - aliceBalBefore, 1 ether);
        assertEq(staking.ownerOf(aliceTokenId), address(lending));

        // Sanity: the offer persists the floor and getOffer surfaces the 7th field.
        (,,,,,, uint256 minPositionETHValue,) = lending.getOffer(offerId);
        assertEq(minPositionETHValue, 5 ether);
    }

    // ─── floor breached ───────────────────────────────────────────

    /// @notice Reserves shift 10% down before acceptance, dropping the ETH
    ///         value of alice's 10_000 TOWELI position below the 9.5 ETH floor.
    ///         acceptOffer reverts InsufficientCollateralValue (the same error
    ///         shared with the TOWELI-floor check — one failure signal).
    function test_floorBreached_reverts() public {
        // Create offer at a 9.5 ETH floor (5% safety buffer above the current ~10 ETH value).
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 9.5 ether
        );

        // Drop WETH-side reserve 10% → new spot = 0.0009 ETH/TOWELI → 10_000 TOWELI ≈ 9 ETH.
        pair.setReserves(INITIAL_TOWELI_RESERVE, (INITIAL_WETH_RESERVE * 90) / 100);

        vm.prank(alice);
        vm.expectRevert(TegridyLending.InsufficientCollateralValue.selector);
        lending.acceptOffer(offerId, aliceTokenId);
    }

    // ─── sandwich risk — documentation test ───────────────────────

    /// @notice DOCUMENTATION TEST. The ETH-floor reads spot reserves, which are
    ///         manipulable inside the same transaction (sandwich attacks). This test
    ///         demonstrates the known risk: a borrower who briefly moves reserves in
    ///         their favour can satisfy the floor check even when the "true" price
    ///         would not. The mitigations (lender-opt-in, 2h min-duration bound,
    ///         TWAP migration once V3 lands) are tracked in docs/SECURITY_DEFERRED.md.
    ///         If this test ever starts reverting, someone likely added a TWAP /
    ///         invariant check — update SECURITY_DEFERRED.md accordingly.
    function test_sandwich_sameBlockManipulation_succeeds() public {
        // Floor that WOULD reject the position at current reserves.
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 50 ether
        );

        // Simulate a sandwich: attacker pumps the WETH-side reserve 10× right before
        // acceptOffer, making the same 10_000 TOWELI position value at ~100 ETH.
        //   10_000 * (10_000 ether) / (1_000_000 ether) = 100 ether ≥ 50 ether ⇒ passes.
        pair.setReserves(INITIAL_TOWELI_RESERVE, INITIAL_WETH_RESERVE * 10);

        vm.prank(alice);
        lending.acceptOffer(offerId, aliceTokenId);

        // Attack "succeeded" — the borrower got the loan at a manipulated price.
        assertEq(staking.ownerOf(aliceTokenId), address(lending));
    }

    // ─── getOffer roundtrip ──────────────────────────────────────

    /// @notice Non-zero minPositionETHValue roundtrips through storage and the
    ///         getOffer view. Guards against silent ABI drift in later refactors.
    function test_getOffer_returnsMinPositionETHValue() public {
        vm.prank(bob);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 3.14 ether
        );

        (
            address lender,
            uint256 principal,
            uint256 aprBps,
            uint256 duration,
            address collateralContract,
            uint256 minPositionValue,
            uint256 minPositionETHValue,
            bool active
        ) = lending.getOffer(offerId);

        assertEq(lender, bob);
        assertEq(principal, 1 ether);
        assertEq(aprBps, 1000);
        assertEq(duration, 30 days);
        assertEq(collateralContract, address(staking));
        assertEq(minPositionValue, 1000 ether);
        assertEq(minPositionETHValue, 3.14 ether);
        assertTrue(active);
    }

    // ─── orientation — TOWELI on token1 slot ─────────────────────

    /// @notice Independent fixture where the pair stores TOWELI on `token1()`
    ///         instead of `token0()`. Exercises the inverse branch of the
    ///         orientation resolver in `_positionETHValue`.
    function test_reserveOrientation_token1Side() public {
        // Deploy a second pair with TOWELI on the token1 slot.
        MockTegridyPairETHFloor inversePair = new MockTegridyPairETHFloor(
            address(weth),
            address(toweli),
            INITIAL_WETH_RESERVE,        // reserve0 = WETH
            INITIAL_TOWELI_RESERVE       // reserve1 = TOWELI
        );

        TegridyLending inverseLending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(inversePair)
        );

        // Re-approve alice's NFT onto the new lending contract.
        vm.prank(alice);
        staking.approve(address(inverseLending), aliceTokenId);

        vm.deal(bob, 5 ether);
        vm.prank(bob);
        uint256 offerId = inverseLending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 5 ether
        );

        // Alice's 10_000 TOWELI ≈ 10 ETH via the same reserves, just rotated.
        vm.prank(alice);
        inverseLending.acceptOffer(offerId, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), address(inverseLending));
    }
}
