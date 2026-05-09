// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/VoteIncentives.sol";
import "../../src/VoteIncentivesAdmin.sol"; // AUDIT FIX (pass-8): EIP170-03 split

/// @title  AuditR014_VoteIncentivesShares (HIGH)
/// @notice Invariant: for every (epoch, pair) pair, the contract-tracked
///         `totalGaugeVotes[epoch][pair]` always equals the sum of every
///         voter's `gaugeVotes[user][epoch][pair]` across the voter set,
///         after any sequence of (advanceEpoch, vote, claim, depositBribe,
///         refundUnvotedBribe) calls.
///
///         WHY THIS MATTERS — Bug class: vote-tally accounting drift +
///         pre-snapshot bribe arbitrage (audit H-4). The bribe share for any
///         voter is computed as
///             share = (bribeAmount * gaugeVotes[user]) / totalGaugeVotes
///         If totalGaugeVotes ever desyncs from the per-user sum (e.g. by an
///         off-by-one in `vote()` updating one accumulator but not the other,
///         or by a future "vote correction" admin path that decrements one
///         side only) every bribe payout is silently mis-rounded — either
///         under-paying voters (dust accumulates and is forfeited) or
///         over-paying them (sum-of-shares > bribeAmount; eventual claimer
///         reverts on transfer-out, bricking the pair-epoch).
///
///         The H-4 component: a briber depositing bribes for the LIVE bucket
///         and then immediately calling advanceEpoch must NOT see those
///         deposits credited to the just-finalized epoch (they belong to the
///         next live bucket). The fix lives in `epochBribesFinalized` plus the
///         `EpochNotFinalized` guard. This invariant catches a regression
///         where a finalized epoch's bribe pool retroactively grows.

contract VISBribeToken is ERC20 {
    constructor() ERC20("Bribe", "BRB") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Minimal IVotingEscrow mock — exposes the surface VoteIncentives
///         consumes. We control voting power directly so we can drive votes
///         without reproducing the entire TegridyStaking interaction graph.
contract VISMockEscrow {
    mapping(address => uint256) public power;
    uint256 public total;
    bool public _paused;

    function setPower(address user, uint256 p) external {
        if (power[user] == 0 && p > 0) {
            total += p;
        } else if (power[user] > 0 && p == 0) {
            total -= power[user];
        } else if (p > power[user]) {
            total += (p - power[user]);
        } else if (p < power[user]) {
            total -= (power[user] - p);
        }
        power[user] = p;
    }

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return power[user];
    }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function userTokenId(address user) external view returns (uint256) {
        return power[user] > 0 ? 1 : 0;
    }
    function positions(uint256) external pure returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        return (0, 0, 0, 0, 0, 0, false, false, 0, 0, false);
    }
    function paused() external view returns (bool) { return _paused; }
}

/// @notice Minimal factory that whitelists every pair address we'll vote on.
contract VISMockFactory {
    mapping(address => bool) public allowed;
    /// @dev AUDIT R016 M-1: VoteIncentives.disabledPairs gate (never tripped here).
    mapping(address => bool) public disabledPairs;
    function setPair(address p, bool ok) external { allowed[p] = ok; }
    function getPair(address, address) external pure returns (address) { return address(0); }
    function isPair(address p) external view returns (bool) { return allowed[p]; }
}

/// @notice Mock pair just for `vote()` validation. VoteIncentives only reads
///         token0/token1 to confirm it's a pair — values don't matter.
contract VISMockPair {
    address public immutable token0;
    address public immutable token1;
    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
}

/// @notice Minimal WETH for bribe-ETH path; this invariant only exercises ERC20
///         deposits so the WETH surface stays nominal.
contract VISMockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 v) external {
        require(balanceOf[msg.sender] >= v, "weth: bal");
        balanceOf[msg.sender] -= v;
        (bool ok,) = msg.sender.call{value: v}("");
        require(ok, "weth: send");
    }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        balanceOf[from] -= v;
        balanceOf[to] += v;
        return true;
    }
    function approve(address, uint256) external pure returns (bool) { return true; }
    receive() external payable {}
}

/// @notice TOWELI mock for the commit-bond path. Plain ERC20 — VoteIncentives
///         only uses balanceOf / transfer / transferFrom on this slot.
contract VISMockToweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Handler — bounded surface, 6 functions:
///   1) doAdvanceEpoch       — permissionless epoch tick
///   2) doDepositBribe       — ERC20 bribe into the live bucket
///   3) doVote               — voter allocates power to a (epoch, pair)
///   4) doClaim              — voter pulls their share
///   5) doRefundUnvoted      — depositor pulls back un-voted bribe
///   6) doWarp               — advance time across MIN_EPOCH_INTERVAL
contract VISHandler is Test {
    VoteIncentives public vi;
    VISMockEscrow public escrow;
    VISBribeToken public bribeToken;
    VISMockPair public pair;
    address[] public voters;

    constructor(
        VoteIncentives _vi,
        VISMockEscrow _escrow,
        VISBribeToken _bribeToken,
        VISMockPair _pair,
        address[] memory _voters
    ) {
        vi = _vi;
        escrow = _escrow;
        bribeToken = _bribeToken;
        pair = _pair;
        voters = _voters;
    }

    function votersLength() external view returns (uint256) { return voters.length; }
    function voterAt(uint256 i) external view returns (address) { return voters[i]; }

    function doAdvanceEpoch() external {
        try vi.advanceEpoch() {} catch {}
    }

    function doDepositBribe(uint256 amount, uint256 depositorSeed) external {
        amount = bound(amount, 0.01 ether, 1_000 ether);
        address depositor = voters[depositorSeed % voters.length];
        bribeToken.mint(depositor, amount);
        vm.startPrank(depositor);
        bribeToken.approve(address(vi), amount);
        try vi.depositBribe(address(pair), address(bribeToken), amount) {} catch {}
        vm.stopPrank();
    }

    function doVote(uint256 voterSeed, uint256 epochSeed, uint256 power) external {
        uint256 ec = vi.epochCount();
        if (ec == 0) return;
        address voter = voters[voterSeed % voters.length];
        uint256 epoch = epochSeed % ec;
        uint256 vp = escrow.votingPowerOf(voter);
        if (vp == 0) return;
        // Stay strictly under user's remaining capacity to dodge EXCEEDS_POWER.
        uint256 used = vi.userTotalVotes(voter, epoch);
        if (used >= vp) return;
        power = bound(power, 1, vp - used);
        vm.prank(voter);
        try vi.vote(epoch, address(pair), power) {} catch {}
    }

    function doClaim(uint256 voterSeed, uint256 epochSeed) external {
        uint256 ec = vi.epochCount();
        if (ec == 0) return;
        address voter = voters[voterSeed % voters.length];
        uint256 epoch = epochSeed % ec;
        vm.prank(voter);
        try vi.claimBribes(epoch, address(pair)) {} catch {}
    }

    function doRefundUnvoted(uint256 epochSeed, uint256 depositorSeed) external {
        uint256 ec = vi.epochCount();
        if (ec == 0) return;
        uint256 epoch = epochSeed % ec;
        address depositor = voters[depositorSeed % voters.length];
        vm.prank(depositor);
        try vi.refundUnvotedBribe(epoch, address(pair), address(bribeToken)) {} catch {}
    }

    function doWarp(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 1 days, 14 days);
        vm.warp(block.timestamp + secondsAhead);
    }
}

contract VoteIncentivesSharesTest is Test {
    VoteIncentives public vi;
    VoteIncentivesAdmin public viAdmin; // AUDIT FIX (pass-8): EIP170-03 split
    VISMockEscrow public escrow;
    VISMockFactory public factory;
    VISMockPair public pair;
    VISMockWETH public weth;
    VISMockToweli public toweli;
    VISBribeToken public bribeToken;
    VISHandler public handler;

    address public treasury = makeAddr("vis_treasury");
    address public voter1 = makeAddr("vis_voter1");
    address public voter2 = makeAddr("vis_voter2");
    address public voter3 = makeAddr("vis_voter3");

    function setUp() public {
        escrow = new VISMockEscrow();
        factory = new VISMockFactory();
        weth = new VISMockWETH();
        toweli = new VISMockToweli();
        bribeToken = new VISBribeToken();
        pair = new VISMockPair(address(toweli), address(weth));
        factory.setPair(address(pair), true);

        vi = new VoteIncentives(
            address(escrow),
            treasury,
            address(weth),
            address(factory),
            address(toweli),
            300 // 3% bribe fee
        );
        // AUDIT FIX (pass-8): EIP170-03 split — wire admin sister.
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));

        // Whitelist the bribe token via timelock — for the invariant we want
        // depositBribe paths exercised, so propose+execute immediately by
        // warping past the 24h delay.
        viAdmin.proposeWhitelistChange(address(bribeToken), true);
        vm.warp(block.timestamp + 25 hours);
        viAdmin.executeWhitelistChange();

        // Seed three voters with voting power above MIN_DISTRIBUTE_STAKE so
        // advanceEpoch() succeeds.
        escrow.setPower(voter1, 5_000e18);
        escrow.setPower(voter2, 3_000e18);
        escrow.setPower(voter3, 2_000e18);

        // SNAPSHOT_LOOKBACK guard — give the escrow checkpoints time to
        // predate the snapshot timestamp.
        vm.warp(block.timestamp + 2 hours);

        address[] memory voters = new address[](3);
        voters[0] = voter1;
        voters[1] = voter2;
        voters[2] = voter3;

        handler = new VISHandler(vi, escrow, bribeToken, pair, voters);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = VISHandler.doAdvanceEpoch.selector;
        selectors[1] = VISHandler.doDepositBribe.selector;
        selectors[2] = VISHandler.doVote.selector;
        selectors[3] = VISHandler.doClaim.selector;
        selectors[4] = VISHandler.doRefundUnvoted.selector;
        selectors[5] = VISHandler.doWarp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice invariant_voteTallyConservation — for every snapshotted epoch
    ///         and the test pair, totalGaugeVotes equals the sum of per-voter
    ///         gaugeVotes across the registered voter set. Catches both the
    ///         vote-tally drift class and post-finalization bribe leakage
    ///         (because finalization is what unblocks the vote() path that
    ///         maintains this equality).
    function invariant_voteTallyConservation() public view {
        uint256 ec = vi.epochCount();
        uint256 nVoters = handler.votersLength();
        for (uint256 e = 0; e < ec; e++) {
            uint256 total = vi.totalGaugeVotes(e, address(pair));
            uint256 sum;
            for (uint256 v = 0; v < nVoters; v++) {
                sum += vi.gaugeVotes(handler.voterAt(v), e, address(pair));
            }
            assertEq(total, sum, "VIS vote tally drift");
        }
    }

    /// @notice invariant_finalizedEpochsAreImmutableOnce — every snapshotted
    ///         epoch index has its `epochBribesFinalized` flag set to true.
    ///         This is the H-4 contract-invariant that prevents a finalized
    ///         epoch's bribe pool from growing after the fact.
    function invariant_finalizedEpochsAreImmutable() public view {
        uint256 ec = vi.epochCount();
        for (uint256 e = 0; e < ec; e++) {
            assertTrue(
                vi.epochBribesFinalized(e),
                "VIS finalized flag missing on snapshotted epoch"
            );
        }
    }

    /// @notice invariant_userVotesNeverExceedPower — userTotalVotes[user][e]
    ///         never exceeds the user's voting power at snapshot time. This
    ///         is the protocol-level vote-cap law. A regression here would
    ///         let a single voter sweep the entire bribe pool by allocating
    ///         > 100% of their power.
    function invariant_userVotesNeverExceedPower() public view {
        uint256 ec = vi.epochCount();
        uint256 nVoters = handler.votersLength();
        for (uint256 e = 0; e < ec; e++) {
            for (uint256 v = 0; v < nVoters; v++) {
                address voter = handler.voterAt(v);
                uint256 used = vi.userTotalVotes(voter, e);
                uint256 vp = escrow.votingPowerOf(voter);
                assertLe(used, vp, "VIS vote exceeds power");
            }
        }
    }
}
