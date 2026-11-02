// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLPFarming.sol";

contract MS7Token is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MS7LP is ERC20 {
    constructor() ERC20("Tegridy LP", "TLP") { _mint(msg.sender, 1_000_000 ether); }
}

contract MS7JBAC is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @dev A contract holder (a Safe, a vault): the only kind of account that can hold
///      more than one staking position, because `stake` allows one per wallet.
contract MS7MultiHolder is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function farmStake(TegridyLPFarming farm, IERC20 lp, uint256 amount) external {
        lp.approve(address(farm), amount);
        farm.stake(amount);
    }
}

/// @title AUDIT MICROSCOPE_2026_04_30 M-S7: the LP farm boost of a holder with several
///        staking positions at different boosts.
/// @notice The farm weights a holder's LP by `aggregateActiveBoostBps`. That average used
///         to round DOWN, docking the holder up to 1 bps of boost. Numbers below: positions
///         of 101 TOWELI at 40,000 bps and 200 TOWELI at 4,000 bps average exactly
///         16,079.73 bps. The floor returned 16,079, so 1,000 LP counted as 1,607.9 instead
///         of 1,607.97. The fix rounds up to 16,080, never above the best single position.
contract AuditMicroscope_MS7_BoostRoundingTest is Test {
    MS7Token token;
    MS7LP lp;
    TegridyStaking staking;
    TegridyLPFarming farm;
    MS7MultiHolder holder;
    uint256 idLong;
    uint256 idShort;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant AMOUNT_LONG = 101 ether;  // 4-year lock: 40,000 bps
    uint256 constant AMOUNT_SHORT = 200 ether; // 7-day lock: 4,000 bps
    uint256 constant LP_STAKED = 1_000 ether;

    function setUp() public {
        token = new MS7Token();
        lp = new MS7LP();
        staking = new TegridyStaking(address(token), address(new MS7JBAC()), treasury);
        farm = new TegridyLPFarming(address(token), address(lp), address(staking), treasury, 7 days);
        holder = new MS7MultiHolder();

        token.transfer(alice, AMOUNT_LONG);
        token.transfer(bob, AMOUNT_SHORT);
        vm.startPrank(alice);
        token.approve(address(staking), AMOUNT_LONG);
        staking.stake(AMOUNT_LONG, staking.MAX_LOCK_DURATION());
        vm.stopPrank();
        vm.startPrank(bob);
        token.approve(address(staking), AMOUNT_SHORT);
        staking.stake(AMOUNT_SHORT, staking.MIN_LOCK_DURATION());
        vm.stopPrank();

        // Past the 24h transfer cooldown, inside the 7-day lock.
        vm.warp(block.timestamp + 1 days + 1);
        idLong = staking.userTokenId(alice);
        idShort = staking.userTokenId(bob);
        vm.prank(alice);
        staking.transferFrom(alice, address(holder), idLong);
        vm.prank(bob);
        staking.transferFrom(bob, address(holder), idShort);

        lp.transfer(address(holder), LP_STAKED);
    }

    function test_MS7_twoBoostsAverageRoundsUpNotDown() public view {
        (, , , , uint16 boostLong, , , , , , ) = staking.positions(idLong);
        (, , , , uint16 boostShort, , , , , , ) = staking.positions(idShort);
        assertEq(boostLong, 40_000);
        assertEq(boostShort, 4_000);
        // 101e18 * 40,000 + 200e18 * 4,000 = 4,840,000e18, over 301e18 = 16,079.73...
        assertEq(staking.aggregateActiveBoostBps(address(holder)), 16_080, "M-S7: average must round up");
    }

    function test_MS7_farmCountsTheHolderAtLeastTheExactAverage() public {
        holder.farmStake(farm, lp, LP_STAKED);
        uint256 effective = farm.effectiveBalanceOf(address(holder));
        // Exact weight, one division at the end: 1,607.973... LP.
        uint256 exact = (LP_STAKED * (AMOUNT_LONG * 40_000 + AMOUNT_SHORT * 4_000))
            / ((AMOUNT_LONG + AMOUNT_SHORT) * 10_000);
        assertGe(effective, exact, "M-S7: multi-position holder counted below its exact boost");
        // ...and never more than 1 bps of the raw stake above it.
        assertLe(effective - exact, LP_STAKED / 10_000);
    }
}
