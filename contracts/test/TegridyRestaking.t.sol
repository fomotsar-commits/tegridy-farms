// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockTOWELI is ERC20 {
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

contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TegridyRestakingTest is Test {
    MockTOWELI toweli;
    MockJBAC jbac;
    MockWETH weth;
    TegridyStaking staking;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether; // 1 TOWELI per second
    uint256 constant BONUS_RATE = 0.1 ether; // 0.1 WETH per second
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    function setUp() public {
        toweli = new MockTOWELI();
        jbac = new MockJBAC();
        weth = new MockWETH();

        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            REWARD_RATE
        );

        restaking = new TegridyRestaking(
            address(staking),
            address(toweli),
            address(weth),
            BONUS_RATE
        );

        // Fund staking with rewards
        toweli.transfer(address(staking), 500_000 ether);
        staking.fund(0); // Just to track, tokens already there

        // Fund restaking with bonus rewards
        weth.transfer(address(restaking), 100_000 ether);

        // Give alice tokens
        toweli.transfer(alice, STAKE_AMOUNT);

        // Give bob tokens
        toweli.transfer(bob, STAKE_AMOUNT);
    }

    // ─── Basic Restaking ────────────────────────────────────────────

    function test_restake_basic() public {
        // Alice stakes in TegridyStaking
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);

        uint256 tokenId = staking.userTokenId(alice);
        assertEq(tokenId, 1);

        // Alice approves and restakes the NFT
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        // Verify NFT is now held by restaking contract
        assertEq(staking.ownerOf(tokenId), address(restaking));

        // Verify restake info
        (uint256 rTokenId, uint256 posAmount,,, uint256 depositTime) = restaking.restakers(alice);
        assertEq(rTokenId, tokenId);
        assertEq(posAmount, STAKE_AMOUNT);
        assertGt(depositTime, 0);

        // Verify totalRestaked
        assertEq(restaking.totalRestaked(), STAKE_AMOUNT);
    }

    function test_restake_earns_both_rewards() public {
        // Alice stakes and restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        // Advance time
        vm.warp(block.timestamp + 100);

        // Check pending rewards
        uint256 pendingBase = restaking.pendingBase(alice);
        uint256 pendingBonus = restaking.pendingBonus(alice);

        assertGt(pendingBase, 0, "Should have base rewards");
        assertGt(pendingBonus, 0, "Should have bonus rewards");
    }

    function test_claimAll_sends_both_tokens() public {
        // Alice stakes and restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        // Advance time
        vm.warp(block.timestamp + 100);

        uint256 toweliBalBefore = toweli.balanceOf(alice);
        uint256 wethBalBefore = weth.balanceOf(alice);

        // Claim all
        vm.prank(alice);
        restaking.claimAll();

        uint256 toweliEarned = toweli.balanceOf(alice) - toweliBalBefore;
        uint256 wethEarned = weth.balanceOf(alice) - wethBalBefore;

        assertGt(toweliEarned, 0, "Should receive TOWELI base rewards");
        assertGt(wethEarned, 0, "Should receive WETH bonus rewards");
    }

    function test_unrestake_returns_nft() public {
        // Alice stakes and restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);

        // Advance time
        vm.warp(block.timestamp + 50);

        // Unrestake
        restaking.unrestake();
        vm.stopPrank();

        // NFT should be back with Alice
        assertEq(staking.ownerOf(tokenId), alice);

        // Restake info should be cleared
        (uint256 rTokenId,,,,) = restaking.restakers(alice);
        assertEq(rTokenId, 0);

        // totalRestaked should be 0
        assertEq(restaking.totalRestaked(), 0);
    }

    function test_unrestake_claims_all_rewards() public {
        // Alice stakes and restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);

        vm.warp(block.timestamp + 100);

        uint256 toweliBalBefore = toweli.balanceOf(alice);
        uint256 wethBalBefore = weth.balanceOf(alice);

        restaking.unrestake();
        vm.stopPrank();

        assertGt(toweli.balanceOf(alice) - toweliBalBefore, 0, "Should receive base on unrestake");
        assertGt(weth.balanceOf(alice) - wethBalBefore, 0, "Should receive bonus on unrestake");
    }

    // ─── Multiple Restakers ─────────────────────────────────────────

    function test_two_restakers_fair_split() public {
        // Alice stakes and restakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenIdA = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenIdA);
        restaking.restake(tokenIdA);
        vm.stopPrank();

        // Bob stakes and restakes
        vm.startPrank(bob);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 90 days);
        uint256 tokenIdB = staking.userTokenId(bob);
        staking.approve(address(restaking), tokenIdB);
        restaking.restake(tokenIdB);
        vm.stopPrank();

        // Advance time
        vm.warp(block.timestamp + 100);

        // Both should have bonus rewards
        uint256 aliceBonus = restaking.pendingBonus(alice);
        uint256 bobBonus = restaking.pendingBonus(bob);

        // Both have equal position amounts, so bonus should be roughly equal
        assertGt(aliceBonus, 0);
        assertGt(bobBonus, 0);
        // Allow 1% tolerance for rounding
        assertApproxEqRel(aliceBonus, bobBonus, 0.01e18);
    }

    // ─── Error Cases ────────────────────────────────────────────────

    function test_cannot_restake_twice() public {
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);

        // Try restaking again — should fail
        vm.expectRevert(TegridyRestaking.AlreadyRestaked.selector);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    function test_cannot_unrestake_without_position() public {
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.NotRestaked.selector);
        restaking.unrestake();
    }

    function test_cannot_claim_without_position() public {
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.NotRestaked.selector);
        restaking.claimAll();
    }

    function test_cannot_restake_others_nft() public {
        // Alice stakes
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Bob tries to restake Alice's NFT
        vm.prank(bob);
        vm.expectRevert(TegridyRestaking.NotNFTOwner.selector);
        restaking.restake(tokenId);
    }

    // ─── Admin Functions ────────────────────────────────────────────

    function test_fundBonus() public {
        uint256 amount = 50_000 ether;
        weth.approve(address(restaking), amount);
        restaking.fundBonus(amount);
        assertEq(restaking.totalBonusFunded(), amount);
    }

    function test_setBonusRate() public {
        uint256 newRate = 0.5 ether;
        restaking.setBonusRewardPerSecond(newRate);
        assertEq(restaking.bonusRewardPerSecond(), newRate);
    }

    function test_onlyOwner_setBonusRate() public {
        vm.prank(alice);
        vm.expectRevert();
        restaking.setBonusRewardPerSecond(1 ether);
    }

    // ─── Edge Cases ─────────────────────────────────────────────────

    function test_no_bonus_when_pool_empty() public {
        // Deploy restaking with no bonus funds
        TegridyRestaking emptyRestaking = new TegridyRestaking(
            address(staking),
            address(toweli),
            address(weth),
            BONUS_RATE
        );

        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(emptyRestaking), tokenId);
        emptyRestaking.restake(tokenId);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        // Bonus should be 0 (no funds)
        uint256 bonus = emptyRestaking.pendingBonus(alice);
        assertEq(bonus, 0);
    }

    function test_pendingTotal_view() public {
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 30 days);
        uint256 tokenId = staking.userTokenId(alice);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        (uint256 base, uint256 bonus) = restaking.pendingTotal(alice);
        assertGt(base, 0);
        assertGt(bonus, 0);
    }
}
