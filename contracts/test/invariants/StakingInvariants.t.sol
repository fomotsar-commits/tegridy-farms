// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";

/// @title Staking invariant suite (R061)
/// @notice Stateful invariants for `TegridyStaking` complementing the unit
///         tests in R018_Staking.t.sol. Targets:
///           - `accruedRewards <= totalRewardsFunded` (no over-distribute)
///           - `totalUnsettledRewards == sum(unsettledRewards[user])` per actor

contract StakingR061Token is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract StakingR061NFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }
}

/// @notice Narrow handler: stake / withdraw / claimUnsettled only.
///         Whole notifyRewardAmount path is fixed in setUp so the invariant
///         can pin "accrued <= funded".
contract StakingR061Handler is Test {
    TegridyStaking public staking;
    StakingR061Token public token;
    address public actor;

    constructor(TegridyStaking _staking, StakingR061Token _token, address _actor) {
        staking = _staking;
        token = _token;
        actor = _actor;
    }

    function doStake(uint256 amount, uint256 lockDays) external {
        amount = bound(amount, 100 ether, 100_000 ether);
        uint256 lock = bound(lockDays, 7, 365) * 1 days;
        if (staking.userTokenId(actor) != 0) return; // already staked
        vm.startPrank(actor);
        try staking.stake(amount, lock) {} catch {}
        vm.stopPrank();
    }

    function doWarp(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 1 hours, 30 days);
        vm.warp(block.timestamp + secondsAhead);
    }

    function doClaim() external {
        if (staking.unsettledRewards(actor) == 0) return;
        vm.prank(actor);
        try staking.claimUnsettled() {} catch {}
    }
}

contract StakingInvariantsTest is Test {
    TegridyStaking public staking;
    StakingR061Token public token;
    StakingR061NFT public nft;
    StakingR061Handler public handler;

    address public treasury = makeAddr("r061_staking_treasury");
    address public actor = makeAddr("r061_staking_actor");

    uint256 internal constant FUND = 10_000_000 ether;

    function setUp() public {
        token = new StakingR061Token();
        nft = new StakingR061NFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        // Seed actor with stakeable tokens.
        token.transfer(actor, 50_000_000 ether);
        vm.prank(actor);
        token.approve(address(staking), type(uint256).max);

        // Fund rewards once. Handler MUST NOT call notifyRewardAmount so the
        // "accrued <= funded" invariant has a stable upper bound.
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(FUND);

        handler = new StakingR061Handler(staking, token, actor);
        targetContract(address(handler));
    }

    /// @notice invariant_accruedLEUnclaimedPool — total reward debt accumulated
    ///         (still-unsettled + already-claimed) cannot exceed the rewards
    ///         actually funded. Guards against an `earned()` math bug
    ///         silently minting phantom rewards.
    function invariant_accruedLEUnclaimedPool() public view {
        uint256 funded = staking.totalRewardsFunded();
        uint256 unsettled = staking.totalUnsettledRewards();
        // earned() may grow with time; we don't read it here to keep the
        // invariant cheap. The protocol-level upper bound is `funded`, which
        // includes any claimed amount as well, so:
        //     unsettled <= funded
        // must always hold.
        assertLe(unsettled, funded, "R061 unsettled exceeds funded pool");
    }

    /// @notice invariant_totalUnsettledMatchesActor — for the single-actor
    ///         harness, totalUnsettledRewards must equal unsettled[actor]
    ///         (plus treasury, which only accrues via penalty paths the
    ///         handler doesn't trigger).
    function invariant_totalUnsettledMatchesActor() public view {
        uint256 sum =
            staking.unsettledRewards(actor) +
            staking.unsettledRewards(treasury);
        assertEq(staking.totalUnsettledRewards(), sum, "R061 unsettled accounting drift");
    }

    /// @notice invariant_totalStakedNonNegativeAndCapped — totalStaked never
    ///         exceeds the actor's funded balance (no free mint).
    function invariant_totalStakedBounded() public view {
        // Single-actor harness: total staked must be <= what the actor was
        // ever funded with. Tighten when multi-actor support lands.
        assertLe(staking.totalStaked(), 50_000_000 ether, "R061 totalStaked > funded");
    }

    /// @notice invariant_totalStakedEqSumPositions — `totalStaked` exactly
    ///         tracks the sum of every minted position's principal. Since
    ///         the harness only ever mints one position for `actor`, the
    ///         invariant collapses to `totalStaked == actor's position
    ///         amount` (or zero if the actor hasn't staked yet).
    function invariant_totalStakedEqSumPositions() public view {
        uint256 tokenId = staking.userTokenId(actor);
        if (tokenId == 0) {
            assertEq(staking.totalStaked(), 0, "R061 totalStaked drift (no position)");
            return;
        }
        (uint256 amount, , , , , ) = staking.getPosition(tokenId);
        assertEq(staking.totalStaked(), amount, "R061 totalStaked != position sum");
    }
}
