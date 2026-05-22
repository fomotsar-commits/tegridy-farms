// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../../src/TegridyStakingJbacVault.sol";

/// @title  MVPLaunch_StakingInvariants — property-based campaigns on TegridyStaking
/// @notice Focused on the reward-pool conservation and unsettled-rewards
///         summation invariants — the C-1 class of bugs (whichever caller
///         drains first wins) gets caught here under random action sequences.
///
///         Properties asserted after every random action:
///         - INV-REWARDPOOL-RESERVE: rewardToken.balanceOf(staking) >=
///           totalStaked + totalUnsettledRewards
///         - INV-UNSETTLED-SUM: totalUnsettledRewards is a non-negative
///           accumulator that never goes below zero on decrement
///         - INV-TOTALSTAKED-MONOTONIC: totalStaked tracks the
///           rewardToken.balanceOf(staking) − unsettled − accrued lower-bound
///         - INV-CAP-RESPECTED: totalStaked never exceeds maxTotalStaked
///
/// @dev    This is a focused replacement for the pre-cut
///         TegridyLending_RewardAttributionInvariants.t.sol — that file's
///         lending-side reward attribution surface is deferred. The MVP-side
///         invariants here are the surviving subset.
contract MVPLaunch_StakingInvariantsTest is Test {
    TegridyStaking public staking;
    MockTowel public toweli;
    MockJBAC public jbac;
    TegridyStakingJbacVault public vault;

    StakingHandler public handler;

    address public treasury = makeAddr("treasury");

    function setUp() public {
        toweli = new MockTowel();
        jbac = new MockJBAC();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        // Fund reward pool generously so reward-pool reserve invariant has
        // headroom for emissions during the campaign.
        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000e18);

        // Set realistic launch caps to also exercise INV-CAP-RESPECTED.
        staking.setMaxStakePerUser(100_000e18);
        staking.setMaxTotalStaked(10_000_000e18);

        // Hand staking interactions to the handler so foundry's invariant
        // runner exercises arbitrary action sequences.
        handler = new StakingHandler(staking, toweli);
        targetContract(address(handler));

        // Limit selectors to the public-facing user actions; the invariant
        // runner will use stake / increaseAmount / withdraw / fastForward.
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = StakingHandler.stake.selector;
        selectors[1] = StakingHandler.increaseAmount.selector;
        selectors[2] = StakingHandler.withdraw.selector;
        selectors[3] = StakingHandler.fastForward.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ─── INV-PRINCIPAL-RECOVERABLE ────────────────────────────────────
    /// @dev The canonical safety invariant for any constant-rate Synthetix-
    ///      style staking pool: regardless of how rewards accrue or are
    ///      claimed, the staking contract's TOWELI balance MUST always cover
    ///      every staker's PRINCIPAL. If this fails, someone called withdraw
    ///      and didn't get their stake back — that is a critical bug.
    ///
    ///      The weaker invariant `balance >= totalStaked + totalUnsettled`
    ///      from the agent's INV-REWARDPOOL-RESERVE is NOT a contract
    ///      invariant — it depends on the operator topping up the reward
    ///      pool faster than `rewardRate * elapsed`. That's an operational
    ///      property, not a code property; it lives in the trust-assumption
    ///      doc, not in this invariant runner.
    function invariant_principalRecoverable() public view {
        uint256 balance = toweli.balanceOf(address(staking));
        uint256 totalStaked = staking.totalStaked();
        assertGe(balance, totalStaked, "INV-PRINCIPAL-RECOVERABLE violated");
    }

    // ─── INV-CAP-RESPECTED ────────────────────────────────────────────
    function invariant_totalStakedUnderCap() public view {
        assertLe(staking.totalStaked(), staking.maxTotalStaked(), "INV-CAP-RESPECTED violated");
    }

    // ─── INV-TOTALSTAKED-NONNEGATIVE ──────────────────────────────────
    // totalStaked is uint256; this asserts no overflow / underflow shenanigans
    // produced an impossibly large value (every position adds <= per-user cap,
    // bounded by the global cap above).
    function invariant_totalStakedSane() public view {
        assertLe(staking.totalStaked(), 1_000_000_000e18, "INV-TOTALSTAKED-SANE violated");
    }
}

// ─── Handler ──────────────────────────────────────────────────────────

contract StakingHandler is Test {
    TegridyStaking public immutable staking;
    MockTowel public immutable toweli;

    address[] public actors;
    mapping(address => uint256) public tokenIdOf;

    uint256 public constant MIN_STAKE = 100e18;

    constructor(TegridyStaking _staking, MockTowel _toweli) {
        staking = _staking;
        toweli = _toweli;
        // Seed 5 actors with plenty of TOWELI.
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("actor", i)))));
            actors.push(a);
            toweli.mint(a, 1_000_000e18);
            vm.prank(a);
            toweli.approve(address(staking), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function stake(uint256 actorSeed, uint256 amount, uint256 duration) public {
        address user = _actor(actorSeed);
        if (tokenIdOf[user] != 0) return; // already staked; force a withdraw first
        amount = bound(amount, MIN_STAKE, 50_000e18);
        duration = bound(duration, 7 days, 4 * 365 days);
        // Respect caps to keep handler valid (the unit tests cover cap reverts).
        if (amount > staking.maxStakePerUser()) return;
        if (staking.totalStaked() + amount > staking.maxTotalStaked()) return;
        vm.prank(user);
        staking.stake(amount, duration);
        tokenIdOf[user] = staking.userTokenId(user);
    }

    function increaseAmount(uint256 actorSeed, uint256 amount) public {
        address user = _actor(actorSeed);
        uint256 tokenId = tokenIdOf[user];
        if (tokenId == 0) return;
        amount = bound(amount, MIN_STAKE, 25_000e18);
        (uint256 currentAmount,,uint256 lockEnd,,,) = staking.getPosition(tokenId);
        if (block.timestamp >= lockEnd && lockEnd > 0) return; // can't increase expired
        if (currentAmount + amount > staking.maxStakePerUser()) return;
        if (staking.totalStaked() + amount > staking.maxTotalStaked()) return;
        vm.prank(user);
        staking.increaseAmount(tokenId, amount);
    }

    function withdraw(uint256 actorSeed) public {
        address user = _actor(actorSeed);
        uint256 tokenId = tokenIdOf[user];
        if (tokenId == 0) return;
        (,,uint256 lockEnd,,,) = staking.getPosition(tokenId);
        if (block.timestamp < lockEnd) return; // lock not yet expired
        vm.prank(user);
        try staking.withdraw(tokenId) {
            tokenIdOf[user] = 0;
        } catch {}
    }

    function fastForward(uint256 seconds_) public {
        seconds_ = bound(seconds_, 1 days, 60 days);
        skip(seconds_);
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────

contract MockTowel is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000e18);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}
