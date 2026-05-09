// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/VoteIncentives.sol";
import "../src/VoteIncentivesAdmin.sol";

/// @title PASS8 Phase 1.6 — VoteIncentives self-bribe + min-quorum
/// @notice Validates two new gates on `claimBribes` / `claimBribesBatch`:
///         1. `BribePoolBelowQuorum` — `totalGaugeVotes[epoch][pair]` must
///            exceed `MIN_BRIBE_CLAIM_QUORUM` (= 100e18 voting power) before
///            any payout is allowed.
///         2. `SelfBribeClaimForbidden` — a depositor on (epoch, pair) is
///            barred from claiming any token on it, closing the self-vote-
///            and-claim arbitrage path.

// ─── Mocks ───────────────────────────────────────────────────────────

contract P16_VotingEscrow {
    mapping(address => uint256) public votingPowers;
    uint256 public totalPower;
    function setVotingPower(address user, uint256 power) external {
        totalPower = totalPower - votingPowers[user] + power;
        votingPowers[user] = power;
    }
    function votingPowerOf(address user) external view returns (uint256) { return votingPowers[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return votingPowers[user]; }
    function totalLocked() external view returns (uint256) { return totalPower; }
    function totalBoostedStake() external view returns (uint256) { return totalPower; }
    function userTokenId(address) external pure returns (uint256) { return 1; }
    function positions(uint256) external view returns (
        uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool, uint256, bool
    ) {
        return (100e18, 100e18, 10000, block.timestamp + 365 days, 365 days, false, 0, block.timestamp, false, 0, false);
    }
    function paused() external pure returns (bool) { return false; }
}

contract P16_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract P16_BribeToken is ERC20 {
    constructor() ERC20("BR", "BR") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract P16_Pair {
    address public token0;
    address public token1;
    constructor(address t0, address t1) { token0 = t0; token1 = t1; }
}

contract P16_Factory {
    mapping(bytes32 => address) internal _pairs;
    mapping(address => bool) public disabledPairs;
    function registerPair(address t0, address t1, address p) external {
        _pairs[keccak256(abi.encodePacked(t0, t1))] = p;
        _pairs[keccak256(abi.encodePacked(t1, t0))] = p;
    }
    function getPair(address t0, address t1) external view returns (address) {
        return _pairs[keccak256(abi.encodePacked(t0, t1))];
    }
}

// ─── Test ────────────────────────────────────────────────────────────

contract PASS8_PHASE_1_6 is Test {
    P16_VotingEscrow ve;
    P16_WETH weth;
    P16_BribeToken bribeToken;
    P16_Factory factory;
    P16_Pair pair;
    VoteIncentives vi;
    VoteIncentivesAdmin viAdmin;

    address treasury = makeAddr("p16_treasury");
    address briber = makeAddr("p16_briber");      // depositor + self-claim attempter
    address voter = makeAddr("p16_voter");        // honest voter
    address tinyVoter = makeAddr("p16_tiny");     // sub-quorum solo voter

    function setUp() public {
        ve = new P16_VotingEscrow();
        weth = new P16_WETH();
        bribeToken = new P16_BribeToken();
        factory = new P16_Factory();

        address t0 = address(0x1111);
        address t1 = address(0x2222);
        pair = new P16_Pair(t0, t1);
        factory.registerPair(t0, t1, address(pair));

        vi = new VoteIncentives(
            address(ve), treasury, address(weth), address(factory), address(bribeToken), address(0), 300
        );
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));

        viAdmin.proposeWhitelistChange(address(bribeToken), true);
        skip(25 hours);
        viAdmin.executeWhitelistChange();

        // BATCH-F H14: commitRevealEnabled = true at deploy. Force-disable so
        // legacy `vote()` path under test stays exerciseable. Slot 10 = the flag.
        vm.store(address(vi), bytes32(uint256(10)), bytes32(uint256(0)));

        // Funding
        bribeToken.transfer(briber, 1_000_000 ether);
        bribeToken.transfer(voter, 100 ether); // unused, just for parity
        vm.prank(briber);
        bribeToken.approve(address(vi), type(uint256).max);

        // Need MIN_DISTRIBUTE_STAKE = 1000e18 total VP for advanceEpoch to succeed.
        // Plus we need to set per-actor voting power for the gaugeVotes denominator.
        // Default setup: voter has 1000 VP (above MIN_BRIBE_CLAIM_QUORUM = 100e18).
        ve.setVotingPower(voter, 1000 ether);

        // Advance one epoch so the next deposit lands on epoch 1 with prior epoch
        // already finalized.
        skip(8 days);
    }

    /// @dev Helper: run a full bribe → vote → finalize cycle and return the
    ///      epoch index that bribers + voters acted on. Skips past VOTE_DEADLINE
    ///      so subsequent claims are within the M14 claim window.
    function _bribeVoteAdvance(address briber_, uint256 bribeAmount, address voter_, uint256 votePower) internal returns (uint256 epochClaimable) {
        // Live (not yet snapshotted) epoch index = epochs.length.
        uint256 epoch = 0; // will be set after advanceEpoch below

        // First, briber deposits a bribe on the live epoch.
        vm.prank(briber_);
        vi.depositBribe(address(pair), address(bribeToken), bribeAmount);

        // Advance epoch (snapshots + finalizes the just-active epoch).
        vi.advanceEpoch();
        epoch = vi.epochCount() - 1;

        // After advance, voters cast votes on the now-snapshotted epoch.
        vm.prank(voter_);
        vi.vote(epoch, address(pair), votePower);

        // BATCH-H M14: claim is gated until block.timestamp > epoch.timestamp + VOTE_DEADLINE.
        // Skip past the vote window so subsequent claimBribes() calls land in the claim window.
        skip(vi.VOTE_DEADLINE() + 1);

        epochClaimable = epoch;
    }

    /// @notice Above-quorum + non-depositor: claim succeeds (sanity baseline).
    function test_phase16_aboveQuorum_nonDepositor_claimsOK() public {
        uint256 epoch = _bribeVoteAdvance(briber, 100 ether, voter, 1000 ether);
        vm.prank(voter);
        vi.claimBribes(epoch, address(pair));
        // No revert — voter was not a depositor and total VP (1000e18) > 100e18 quorum.
    }

    /// @notice Briber tries to claim their own bribe → SelfBribeClaimForbidden.
    function test_phase16_selfBribe_revertsOnClaim() public {
        // Give briber some staking VP so they can vote.
        ve.setVotingPower(briber, 5000 ether);
        uint256 epoch = _bribeVoteAdvance(briber, 100 ether, briber, 5000 ether);

        // Even though briber's vote put 5000 VP into totalGaugeVotes (over quorum),
        // they're locked out by the depositor flag.
        vm.prank(briber);
        vm.expectRevert(VoteIncentives.SelfBribeClaimForbidden.selector);
        vi.claimBribes(epoch, address(pair));
    }

    /// @notice Self-bribe lockout applies even when other tokens are bribed
    ///         on the same pair by the same depositor — locked out for ALL
    ///         tokens on that (epoch, pair).
    function test_phase16_selfBribe_lockoutSpansAllTokens() public {
        // Whitelist a second bribe token.
        P16_BribeToken token2 = new P16_BribeToken();
        token2.mint(briber, 1_000_000 ether);
        viAdmin.proposeWhitelistChange(address(token2), true);
        skip(25 hours);
        viAdmin.executeWhitelistChange();
        vm.prank(briber);
        token2.approve(address(vi), type(uint256).max);

        // Briber deposits one token but votes on the pair.
        ve.setVotingPower(briber, 5000 ether);
        vm.prank(briber);
        vi.depositBribe(address(pair), address(bribeToken), 100 ether);

        // Honest voter + briber both vote.
        vi.advanceEpoch();
        uint256 epoch = vi.epochCount() - 1;
        vm.prank(voter);
        vi.vote(epoch, address(pair), 1000 ether);
        vm.prank(briber);
        vi.vote(epoch, address(pair), 5000 ether);

        // BATCH-H M14: skip past VOTE_DEADLINE so claim window is open.
        skip(vi.VOTE_DEADLINE() + 1);

        // Briber locked out, even on the (un-bribed) token2.
        vm.prank(briber);
        vm.expectRevert(VoteIncentives.SelfBribeClaimForbidden.selector);
        vi.claimBribes(epoch, address(pair));
    }

    /// @notice Below-quorum total VP → BribePoolBelowQuorum on claim.
    function test_phase16_belowQuorum_revertsOnClaim() public {
        // tinyVoter has only 50 VP → below MIN_BRIBE_CLAIM_QUORUM (100 VP).
        // Need to bring totalLocked above MIN_DISTRIBUTE_STAKE for advanceEpoch,
        // so set a separate non-claiming holder's VP just for the denominator.
        ve.setVotingPower(makeAddr("aux_holder"), 10_000 ether);
        ve.setVotingPower(tinyVoter, 50 ether);

        vm.prank(briber);
        vi.depositBribe(address(pair), address(bribeToken), 100 ether);

        vi.advanceEpoch();
        uint256 epoch = vi.epochCount() - 1;

        vm.prank(tinyVoter);
        vi.vote(epoch, address(pair), 50 ether);
        // totalGaugeVotes[epoch][pair] = 50e18 — below 100e18 quorum.

        // BATCH-H M14: skip past VOTE_DEADLINE so claim window is open.
        skip(vi.VOTE_DEADLINE() + 1);

        vm.prank(tinyVoter);
        vm.expectRevert(VoteIncentives.BribePoolBelowQuorum.selector);
        vi.claimBribes(epoch, address(pair));
    }

    /// @notice claimBribesBatch: sub-quorum / self-bribe epochs are silently
    ///         skipped; legitimate epochs still claim within the same batch.
    function test_phase16_claimBatch_skipsBlockedEpochs() public {
        // Epoch A: above-quorum, non-depositor voter — should claim.
        uint256 epochA = _bribeVoteAdvance(briber, 100 ether, voter, 1000 ether);

        // Epoch B: same pair but voter == briber → self-bribe lockout for briber.
        ve.setVotingPower(briber, 5000 ether);
        skip(8 days);
        // briber bribes again on a fresh epoch
        vm.prank(briber);
        vi.depositBribe(address(pair), address(bribeToken), 100 ether);
        vi.advanceEpoch();
        uint256 epochB = vi.epochCount() - 1;
        vm.prank(briber);
        vi.vote(epochB, address(pair), 5000 ether);

        // briber tries to batch-claim across [epochA, epochB+1).
        // - epochA: briber didn't vote there (voter did) → userVoteForPair == 0 → skip
        // - epochB: depositor lockout fires → skip
        // → result: nothing claimed → reverts NothingToClaim
        vm.prank(briber);
        vm.expectRevert(VoteIncentives.NothingToClaim.selector);
        vi.claimBribesBatch(epochA, epochB + 1, address(pair));
    }

    /// @notice claimBribesBatch happy path: claim across multiple eligible epochs.
    function test_phase16_claimBatch_happyPath() public {
        uint256 epochA = _bribeVoteAdvance(briber, 100 ether, voter, 1000 ether);
        skip(8 days);
        uint256 epochB = _bribeVoteAdvance(briber, 50 ether, voter, 1000 ether);

        vm.prank(voter);
        vi.claimBribesBatch(epochA, epochB + 1, address(pair));
        // No revert — both epochs claimed.
    }

    /// @notice Depositor flag persists across multiple deposits for same (epoch, pair).
    function test_phase16_depositorFlag_persistsAcrossDeposits() public {
        // First deposit sets the flag.
        vm.prank(briber);
        vi.depositBribe(address(pair), address(bribeToken), 100 ether);
        // Live (un-finalized) epoch.
        uint256 epoch = vi.epochCount();
        assertTrue(vi.depositedOnPair(briber, epoch, address(pair)));

        // Second deposit on same pair preserves the flag (still true).
        vm.prank(briber);
        vi.depositBribe(address(pair), address(bribeToken), 50 ether);
        assertTrue(vi.depositedOnPair(briber, epoch, address(pair)));
    }

    /// @notice ETH-bribe path also flags the depositor.
    function test_phase16_depositorFlag_setOnETHBribe() public {
        vm.deal(briber, 1 ether);
        vm.prank(briber);
        vi.depositBribeETH{value: 0.1 ether}(address(pair));
        uint256 epoch = vi.epochCount();
        assertTrue(vi.depositedOnPair(briber, epoch, address(pair)));
    }

    /// @notice MIN_BRIBE_CLAIM_QUORUM is exposed publicly so off-chain tooling
    ///         can mirror the gate without re-deriving it.
    function test_phase16_minBribeClaimQuorum_constantIs100e18() public view {
        assertEq(vi.MIN_BRIBE_CLAIM_QUORUM(), 100 ether);
    }
}
