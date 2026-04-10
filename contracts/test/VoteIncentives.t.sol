// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/VoteIncentives.sol";

// ─── Mocks ───────────────────────────────────────────────────────────

contract MockVE {
    mapping(address => uint256) public votingPowers;
    uint256 public totalPower;
    bool public isPaused;

    function setVotingPower(address user, uint256 power) external {
        totalPower = totalPower - votingPowers[user] + power;
        votingPowers[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return votingPowers[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return votingPowers[user];
    }

    function totalLocked() external view returns (uint256) {
        return totalPower;
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalPower;
    }

    function userTokenId(address) external pure returns (uint256) {
        return 1;
    }

    function positions(uint256) external view returns (
        uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool
    ) {
        return (100e18, 100e18, 10000, block.timestamp + 365 days, 365 days, false, 0, block.timestamp, false);
    }

    function paused() external view returns (bool) { return isPaused; }
    function setPaused(bool _p) external { isPaused = _p; }
}

contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    receive() external payable {}
}

contract MockBribeToken is ERC20 {
    constructor() ERC20("Mock Bribe", "BRIBE") {
        _mint(msg.sender, 1_000_000e18);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock factory that says every address with code is a valid pair
contract MockFactory {
    function getPair(address, address) external pure returns (address) {
        return address(0); // Not used by _validatePair currently
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

contract VoteIncentivesTest is Test {
    VoteIncentives public vi;
    MockVE public ve;
    MockWETH public weth;
    MockBribeToken public bribeToken;
    MockFactory public factory;

    address public owner = address(this);
    address public treasury = address(0xBEEF);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public pair;

    function setUp() public {
        ve = new MockVE();
        weth = new MockWETH();
        bribeToken = new MockBribeToken();
        factory = new MockFactory();

        // Use a contract address as pair so _validatePair passes (has code)
        pair = address(bribeToken); // Any deployed contract works

        vi = new VoteIncentives(address(ve), treasury, address(weth), address(factory), 300); // 3% fee

        // Setup voting power
        ve.setVotingPower(alice, 7000e18);
        ve.setVotingPower(bob, 3000e18);

        // Whitelist the bribe token via timelock
        vi.proposeWhitelistChange(address(bribeToken), true);
        vm.warp(block.timestamp + 24 hours + 1);
        vi.executeWhitelistChange();

        // Fund alice and bob
        bribeToken.transfer(alice, 100_000e18);
        bribeToken.transfer(bob, 100_000e18);
    }

    // ─── Constructor ─────────────────────────────────────────────────

    function test_constructor() public view {
        assertEq(address(vi.votingEscrow()), address(ve));
        assertEq(vi.treasury(), treasury);
        assertEq(vi.bribeFeeBps(), 300);
    }

    function test_constructor_reverts_zero_address() public {
        vm.expectRevert(VoteIncentives.ZeroAddress.selector);
        new VoteIncentives(address(0), treasury, address(weth), address(factory), 300);
    }

    function test_constructor_reverts_fee_too_high() public {
        vm.expectRevert(VoteIncentives.FeeTooHigh.selector);
        new VoteIncentives(address(ve), treasury, address(weth), address(factory), 600);
    }

    // ─── Epoch Management ────────────────────────────────────────────

    function test_advanceEpoch() public {
        vi.advanceEpoch();
        assertEq(vi.epochCount(), 1);
    }

    function test_advanceEpoch_reverts_too_soon() public {
        vi.advanceEpoch();
        vm.expectRevert(VoteIncentives.EpochTooSoon.selector);
        vi.advanceEpoch();
    }

    function test_advanceEpoch_after_cooldown() public {
        vi.advanceEpoch();
        vm.warp(block.timestamp + 1 hours + 1);
        vi.advanceEpoch();
        assertEq(vi.epochCount(), 2);
    }

    function test_advanceEpoch_reverts_no_stakers() public {
        MockVE emptyVE = new MockVE();
        VoteIncentives vi2 = new VoteIncentives(address(emptyVE), treasury, address(weth), address(factory), 300);
        vm.expectRevert(VoteIncentives.NoStakers.selector);
        vi2.advanceEpoch();
    }

    // ─── ERC20 Bribe Deposits ────────────────────────────────────────

    function test_depositBribe() public {
        uint256 amount = 10_000e18;
        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        // 3% fee taken
        uint256 expectedNet = amount - (amount * 300 / 10000);
        uint256 epoch = vi.currentEpoch();
        // Bribes go into the current (not yet snapshotted) epoch
        assertEq(vi.epochBribes(epoch, pair, address(bribeToken)), expectedNet);

        // Treasury received fee
        assertEq(bribeToken.balanceOf(treasury), amount - expectedNet);
    }

    function test_depositBribe_reverts_not_whitelisted() public {
        MockBribeToken other = new MockBribeToken();
        vm.startPrank(alice);
        other.approve(address(vi), 100e18);
        vm.expectRevert(VoteIncentives.TokenNotWhitelisted.selector);
        vi.depositBribe(pair, address(other), 100e18);
        vm.stopPrank();
    }

    function test_depositBribe_reverts_zero_amount() public {
        vm.expectRevert(VoteIncentives.ZeroAmount.selector);
        vi.depositBribe(pair, address(bribeToken), 0);
    }

    function test_depositBribe_reverts_invalid_pair() public {
        vm.expectRevert(VoteIncentives.InvalidPair.selector);
        vi.depositBribe(address(0), address(bribeToken), 100e18);
    }

    // ─── ETH Bribe Deposits ─────────────────────────────────────────

    function test_depositBribeETH() public {
        uint256 amount = 1 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        vi.depositBribeETH{value: amount}(pair);

        uint256 fee = amount * 300 / 10000;
        uint256 epoch = vi.currentEpoch();
        assertEq(vi.epochBribes(epoch, pair, address(0)), amount - fee);
        assertEq(treasury.balance, fee);
    }

    function test_depositBribeETH_reverts_zero() public {
        vm.expectRevert(VoteIncentives.ZeroAmount.selector);
        vi.depositBribeETH{value: 0}(pair);
    }

    // ─── Claiming ────────────────────────────────────────────────────

    function test_claimBribes_proportional() public {
        // Deposit bribe
        uint256 amount = 10_000e18;
        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        // Advance epoch to snapshot
        vi.advanceEpoch();

        // Alice has 70% of voting power, Bob has 30%
        uint256 netBribe = amount - (amount * 300 / 10000);
        uint256 aliceExpected = (netBribe * 7000e18) / 10000e18; // 70%
        uint256 bobExpected = (netBribe * 3000e18) / 10000e18;   // 30%

        uint256 aliceBefore = bribeToken.balanceOf(alice);
        vm.prank(alice);
        vi.claimBribes(0, pair);
        assertEq(bribeToken.balanceOf(alice) - aliceBefore, aliceExpected);

        uint256 bobBefore = bribeToken.balanceOf(bob);
        vm.prank(bob);
        vi.claimBribes(0, pair);
        assertEq(bribeToken.balanceOf(bob) - bobBefore, bobExpected);
    }

    function test_claimBribes_reverts_nothing() public {
        vi.advanceEpoch();
        // Carol has no voting power
        address carol = address(0xCA201);
        vm.prank(carol);
        vm.expectRevert(VoteIncentives.NothingToClaim.selector);
        vi.claimBribes(0, pair);
    }

    function test_claimBribes_reverts_invalid_epoch() public {
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.InvalidEpoch.selector);
        vi.claimBribes(999, pair);
    }

    function test_claimBribes_ETH() public {
        uint256 amount = 5 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        vi.depositBribeETH{value: amount}(pair);

        vi.advanceEpoch();

        uint256 netBribe = amount - (amount * 300 / 10000);
        uint256 aliceExpected = (netBribe * 7000e18) / 10000e18;

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        vi.claimBribes(0, pair);
        assertEq(alice.balance - aliceBalBefore, aliceExpected);
    }

    function test_claimBribesBatch() public {
        // Deposit in epoch 0, advance, deposit in epoch 1, advance
        uint256 amount = 1000e18;

        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount * 2);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();
        vm.warp(block.timestamp + 1 hours + 1);

        vm.startPrank(alice);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();

        uint256 aliceBefore = bribeToken.balanceOf(alice);
        vm.prank(alice);
        vi.claimBribesBatch(0, 2, pair);
        uint256 claimed = bribeToken.balanceOf(alice) - aliceBefore;
        assertTrue(claimed > 0);
    }

    function test_double_claim_prevented() public {
        uint256 amount = 1000e18;
        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();

        vm.prank(alice);
        vi.claimBribes(0, pair);

        // Second claim should revert (nothing left to claim)
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.NothingToClaim.selector);
        vi.claimBribes(0, pair);
    }

    // ─── Staking Pause Guard ─────────────────────────────────────────

    function test_claimBribes_reverts_when_staking_paused() public {
        uint256 amount = 1000e18;
        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();
        ve.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(VoteIncentives.StakingPaused.selector);
        vi.claimBribes(0, pair);
    }

    // ─── Pull-Pattern Withdrawals ────────────────────────────────────

    function test_withdrawPendingETH_reverts_when_empty() public {
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.NoPendingWithdrawal.selector);
        vi.withdrawPendingETH();
    }

    // ─── Timelocked Fee Change ───────────────────────────────────────

    function test_proposeFeeChange() public {
        vi.proposeFeeChange(500);
        assertEq(vi.pendingFeeBps(), 500);
    }

    function test_executeFeeChange() public {
        vi.proposeFeeChange(200);
        vm.warp(block.timestamp + 24 hours + 1);
        vi.executeFeeChange();
        assertEq(vi.bribeFeeBps(), 200);
    }

    function test_cancelFeeChange() public {
        vi.proposeFeeChange(200);
        vi.cancelFeeChange();
        assertEq(vi.pendingFeeBps(), 0);
    }

    function test_feeChange_reverts_too_high() public {
        vm.expectRevert(VoteIncentives.FeeTooHigh.selector);
        vi.proposeFeeChange(501);
    }

    function test_feeChange_reverts_not_ready() public {
        vi.proposeFeeChange(200);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, vi.FEE_CHANGE()));
        vi.executeFeeChange();
    }

    // ─── Timelocked Treasury Change ──────────────────────────────────

    function test_executeTreasuryChange() public {
        address newTreasury = address(0xDE1);
        vi.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        vi.executeTreasuryChange();
        assertEq(vi.treasury(), newTreasury);
    }

    function test_treasuryChange_reverts_zero() public {
        vm.expectRevert(VoteIncentives.ZeroAddress.selector);
        vi.proposeTreasuryChange(address(0));
    }

    // ─── Timelocked Whitelist Change ─────────────────────────────────

    function test_whitelistRemove() public {
        assertTrue(vi.whitelistedTokens(address(bribeToken)));
        vi.proposeWhitelistChange(address(bribeToken), false);
        vm.warp(block.timestamp + 24 hours + 1);
        vi.executeWhitelistChange();
        assertFalse(vi.whitelistedTokens(address(bribeToken)));
    }

    function test_whitelistAdd_new_token() public {
        MockBribeToken newToken = new MockBribeToken();
        vi.proposeWhitelistChange(address(newToken), true);
        vm.warp(block.timestamp + 24 hours + 1);
        vi.executeWhitelistChange();
        assertTrue(vi.whitelistedTokens(address(newToken)));
    }

    // ─── Max Bribe Tokens Cap ────────────────────────────────────────

    function test_maxBribeTokensCap() public {
        // Whitelist and deposit 20 different tokens (the max)
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < 20; i++) {
            MockBribeToken t = new MockBribeToken();
            vi.proposeWhitelistChange(address(t), true);
            ts += 24 hours + 1;
            vm.warp(ts);
            vi.executeWhitelistChange();
            t.approve(address(vi), 100e18);
            vi.depositBribe(pair, address(t), 100e18);
        }

        // 21st token should revert
        MockBribeToken excess = new MockBribeToken();
        vi.proposeWhitelistChange(address(excess), true);
        ts += 24 hours + 1;
        vm.warp(ts);
        vi.executeWhitelistChange();
        excess.approve(address(vi), 100e18);
        vm.expectRevert(VoteIncentives.TooManyBribeTokens.selector);
        vi.depositBribe(pair, address(excess), 100e18);
    }

    // ─── Pause ───────────────────────────────────────────────────────

    function test_pause_blocks_deposits() public {
        vi.pause();
        vm.startPrank(alice);
        bribeToken.approve(address(vi), 100e18);
        vm.expectRevert();
        vi.depositBribe(pair, address(bribeToken), 100e18);
        vm.stopPrank();
    }

    function test_unpause_allows_deposits() public {
        vi.pause();
        vi.unpause();
        vm.startPrank(alice);
        bribeToken.approve(address(vi), 100e18);
        vi.depositBribe(pair, address(bribeToken), 100e18);
        vm.stopPrank();
    }

    // ─── View Functions ──────────────────────────────────────────────

    function test_claimable_view() public {
        uint256 amount = 10_000e18;
        vm.startPrank(alice);
        bribeToken.approve(address(vi), amount);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();

        (address[] memory tokens, uint256[] memory amounts) = vi.claimable(alice, 0, pair);
        assertEq(tokens.length, 1);
        assertEq(tokens[0], address(bribeToken));
        assertTrue(amounts[0] > 0);
    }

    function test_getWhitelistedTokens() public view {
        address[] memory list = vi.getWhitelistedTokens();
        assertEq(list.length, 1);
        assertEq(list[0], address(bribeToken));
    }

    // ─── Sweep Functions ─────────────────────────────────────────────

    function test_sweepToken() public {
        // Send some tokens directly (not via deposit)
        bribeToken.transfer(address(vi), 500e18);
        vi.sweepToken(address(bribeToken));
        assertTrue(bribeToken.balanceOf(treasury) > 0);
    }

    function test_sweepExcessETH() public {
        // Send ETH directly
        vm.deal(address(vi), 1 ether);
        vi.sweepExcessETH();
        assertEq(treasury.balance, 1 ether);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_depositAndClaim(uint96 amount) public {
        vm.assume(amount > 1e18 && amount < 100_000e18);

        vm.startPrank(alice);
        bribeToken.approve(address(vi), uint256(amount));
        vi.depositBribe(pair, address(bribeToken), uint256(amount));
        vm.stopPrank();

        vi.advanceEpoch();

        uint256 balBefore = bribeToken.balanceOf(alice);
        vm.prank(alice);
        vi.claimBribes(0, pair);
        uint256 claimed = bribeToken.balanceOf(alice) - balBefore;

        // Alice has 70% of voting power, should get ~70% of net bribe
        uint256 netBribe = uint256(amount) - (uint256(amount) * 300 / 10000);
        uint256 expected = (netBribe * 7000e18) / 10000e18;
        assertApproxEqAbs(claimed, expected, 1e18); // Allow rounding
    }

    receive() external payable {}
}
