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
        uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool, uint256, bool
    ) {
        return (100e18, 100e18, 10000, block.timestamp + 365 days, 365 days, false, 0, block.timestamp, false, 0, false);
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

/// @dev Mock pair with token0/token1 so _validatePair passes
contract MockPair {
    address public token0;
    address public token1;
    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
}

/// @dev Mock factory that returns the registered pair for token0/token1
contract MockFactory {
    mapping(bytes32 => address) internal _pairs;

    function registerPair(address t0, address t1, address pairAddr) external {
        _pairs[keccak256(abi.encodePacked(t0, t1))] = pairAddr;
        _pairs[keccak256(abi.encodePacked(t1, t0))] = pairAddr;
    }

    function getPair(address t0, address t1) external view returns (address) {
        return _pairs[keccak256(abi.encodePacked(t0, t1))];
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

        // Create a proper mock pair with token0/token1 and register it in the factory
        address t0 = address(0x1111);
        address t1 = address(0x2222);
        MockPair mockPair = new MockPair(t0, t1);
        pair = address(mockPair);
        factory.registerPair(t0, t1, pair);

        vi = new VoteIncentives(address(ve), treasury, address(weth), address(factory), address(bribeToken), 300); // 3% fee, bond in bribeToken for tests

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
        new VoteIncentives(address(0), treasury, address(weth), address(factory), address(bribeToken), 300);
    }

    function test_constructor_reverts_fee_too_high() public {
        vm.expectRevert(VoteIncentives.FeeTooHigh.selector);
        new VoteIncentives(address(ve), treasury, address(weth), address(factory), address(bribeToken), 600);
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
        VoteIncentives vi2 = new VoteIncentives(address(emptyVE), treasury, address(weth), address(factory), address(bribeToken), 300);
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
        // ETH fees use pull pattern (accumulatedTreasuryETH), not direct transfer
        assertEq(vi.accumulatedTreasuryETH(), fee);
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

        // V2: Users must vote for the pair before claiming
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);
        vm.prank(bob);
        vi.vote(0, pair, 3000e18);

        // Alice has 70% of votes, Bob has 30%
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

        // V2: Both users vote so proportions are 70/30
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);
        vm.prank(bob);
        vi.vote(0, pair, 3000e18);

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

        // V2: Vote for epoch 0
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);

        vm.warp(block.timestamp + 1 hours + 1);

        vm.startPrank(alice);
        vi.depositBribe(pair, address(bribeToken), amount);
        vm.stopPrank();

        vi.advanceEpoch();

        // V2: Vote for epoch 1
        vm.prank(alice);
        vi.vote(1, pair, 7000e18);

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

        // V2: Must vote before claiming
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);

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

        // V2: Must vote before claimable returns nonzero
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);

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

        // V2: Must vote before claiming
        vm.prank(alice);
        vi.vote(0, pair, 7000e18);
        vm.prank(bob);
        vi.vote(0, pair, 3000e18);

        uint256 balBefore = bribeToken.balanceOf(alice);
        vm.prank(alice);
        vi.claimBribes(0, pair);
        uint256 claimed = bribeToken.balanceOf(alice) - balBefore;

        // Alice has 70% of votes, should get ~70% of net bribe
        uint256 netBribe = uint256(amount) - (uint256(amount) * 300 / 10000);
        uint256 expected = (netBribe * 7000e18) / 10000e18;
        assertApproxEqAbs(claimed, expected, 1e18); // Allow rounding
    }

    // ─── AUDIT H-2: Commit-Reveal Voting ───────────────────────────────
    //
    // Walks the full commit→reveal→vote-applied→bond-refunded flow, plus
    // the per-phase revert cases. Uses `bribeToken` as the bond token (set
    // in setUp via constructor) so the existing setup transfers to alice+bob
    // give them enough balance to cover bonds (10 TOWELI each).

    function _enableCommitReveal() internal returns (uint256 epochId) {
        vi.enableCommitReveal();
        vi.advanceEpoch();
        epochId = vi.epochCount() - 1;
        // epochs[epochId].timestamp = block.timestamp - 1 (set in advanceEpoch).
        // Move forward 1s so we're strictly after snapshot for commit window.
        vm.warp(block.timestamp + 1);
    }

    function test_h2_commitReveal_happyPath() public {
        uint256 epochId = _enableCommitReveal();

        bytes32 salt = bytes32(uint256(0xdeadbeef));
        uint256 power = 7000e18;
        bytes32 commitHash = vi.computeCommitHash(alice, epochId, pair, power, salt);

        uint256 aliceBalBefore = bribeToken.balanceOf(alice);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 commitIndex = vi.commitVote(epochId, commitHash);
        vm.stopPrank();
        assertEq(commitIndex, 0);
        assertEq(bribeToken.balanceOf(alice), aliceBalBefore - vi.COMMIT_BOND());

        vm.warp(vi.commitDeadline(epochId) + 1);

        vm.prank(alice);
        vi.revealVote(epochId, commitIndex, pair, power, salt);

        assertEq(vi.gaugeVotes(alice, epochId, pair), power);
        assertEq(vi.totalGaugeVotes(epochId, pair), power);
        assertEq(bribeToken.balanceOf(alice), aliceBalBefore);
    }

    function test_h2_commitReveal_multipleCommits_splitVote() public {
        uint256 epochId = _enableCommitReveal();

        address t0 = address(0x3333);
        address t1 = address(0x4444);
        MockPair pair2Contract = new MockPair(t0, t1);
        factory.registerPair(t0, t1, address(pair2Contract));

        bytes32 salt1 = bytes32(uint256(1));
        bytes32 salt2 = bytes32(uint256(2));
        bytes32 h1 = vi.computeCommitHash(alice, epochId, pair, 3000e18, salt1);
        bytes32 h2 = vi.computeCommitHash(alice, epochId, address(pair2Contract), 4000e18, salt2);

        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND() * 2);
        uint256 c1 = vi.commitVote(epochId, h1);
        uint256 c2 = vi.commitVote(epochId, h2);
        vm.stopPrank();

        vm.warp(vi.commitDeadline(epochId) + 1);

        vm.startPrank(alice);
        vi.revealVote(epochId, c1, pair, 3000e18, salt1);
        vi.revealVote(epochId, c2, address(pair2Contract), 4000e18, salt2);
        vm.stopPrank();

        assertEq(vi.gaugeVotes(alice, epochId, pair), 3000e18);
        assertEq(vi.gaugeVotes(alice, epochId, address(pair2Contract)), 4000e18);
        assertEq(vi.userTotalVotes(alice, epochId), 7000e18);
    }

    function test_h2_legacyVoteRejectedOnCommitRevealEpoch() public {
        uint256 epochId = _enableCommitReveal();
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.LegacyVoteOnCommitRevealEpoch.selector);
        vi.vote(epochId, pair, 7000e18);
    }

    function test_h2_commitRevertsAfterCommitDeadline() public {
        uint256 epochId = _enableCommitReveal();
        vm.warp(vi.commitDeadline(epochId) + 1);
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, bytes32(uint256(1)));
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        vm.expectRevert(VoteIncentives.CommitDeadlinePassed.selector);
        vi.commitVote(epochId, h);
        vm.stopPrank();
    }

    function test_h2_revealRevertsBeforeCommitDeadline() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(1));
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.expectRevert(VoteIncentives.RevealWindowNotOpen.selector);
        vi.revealVote(epochId, idx, pair, 7000e18, salt);
        vm.stopPrank();
    }

    function test_h2_revealRevertsAfterRevealDeadline() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(1));
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();
        vm.warp(vi.revealDeadline(epochId) + 1);
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.RevealWindowClosed.selector);
        vi.revealVote(epochId, idx, pair, 7000e18, salt);
    }

    function test_h2_revealRevertsOnWrongSalt() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(0xAA));
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();
        vm.warp(vi.commitDeadline(epochId) + 1);
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.CommitHashMismatch.selector);
        vi.revealVote(epochId, idx, pair, 7000e18, bytes32(uint256(0xBB)));
    }

    function test_h2_doubleReveal_reverts() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(0xCC));
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();
        vm.warp(vi.commitDeadline(epochId) + 1);
        vm.startPrank(alice);
        vi.revealVote(epochId, idx, pair, 7000e18, salt);
        vm.expectRevert(VoteIncentives.AlreadyRevealed.selector);
        vi.revealVote(epochId, idx, pair, 7000e18, salt);
        vm.stopPrank();
    }

    function test_h2_sweepForfeitedBond_transfersToTreasury() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, bytes32(uint256(0xDD)));
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();

        vm.warp(vi.revealDeadline(epochId) + 1);

        uint256 treasuryBefore = bribeToken.balanceOf(treasury);
        vi.sweepForfeitedBond(alice, epochId, idx);
        assertEq(bribeToken.balanceOf(treasury), treasuryBefore + vi.COMMIT_BOND());
    }

    function test_h2_sweepForfeitedBond_revertsBeforeRevealDeadline() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, bytes32(uint256(0xEE)));
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();

        vm.expectRevert(VoteIncentives.BondStillLocked.selector);
        vi.sweepForfeitedBond(alice, epochId, idx);
    }

    function test_h2_sweepForfeitedBond_revertsOnRevealedCommit() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(0xFF));
        bytes32 h = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        vm.startPrank(alice);
        bribeToken.approve(address(vi), vi.COMMIT_BOND());
        uint256 idx = vi.commitVote(epochId, h);
        vm.stopPrank();
        vm.warp(vi.commitDeadline(epochId) + 1);
        vm.prank(alice);
        vi.revealVote(epochId, idx, pair, 7000e18, salt);
        vm.warp(vi.revealDeadline(epochId) + 1);

        vm.expectRevert(VoteIncentives.AlreadyRevealed.selector);
        vi.sweepForfeitedBond(alice, epochId, idx);
    }

    function test_h2_commitHashIsChainBound() public {
        uint256 epochId = _enableCommitReveal();
        bytes32 salt = bytes32(uint256(0x1234));
        bytes32 got = vi.computeCommitHash(alice, epochId, pair, 7000e18, salt);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(vi), alice, epochId, pair, 7000e18, salt));
        assertEq(got, expected);
    }

    receive() external payable {}
}
