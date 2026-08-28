// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {TegridyBoostedLPStaker} from "../../src/v4/TegridyBoostedLPStaker.sol";

contract MockReward is ERC20 {
    constructor() ERC20("Reward", "RWD") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev The veTOWELI boost source. Reads can be made to revert on demand, to
///      model a paused/broken staking contract or a future ABI break.
contract MockStakingBoost {
    uint256 public boost;
    bool public reverting;
    mapping(address => uint256) public override_;

    function setBoost(uint256 b) external {
        boost = b;
    }

    function setBoostFor(address who, uint256 b) external {
        override_[who] = b;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function aggregateActiveBoostBps(address who) external view returns (uint256) {
        require(!reverting, "STAKING_DOWN");
        uint256 o = override_[who];
        return o != 0 ? o : boost;
    }
}

/// @dev Minimal V4 PositionManager: one canonical pool, full-range positions,
///      settable liquidity, plain ownership tracking (no approval dance).
contract MockPositionMgr {
    using PoolIdLibrary for PoolKey;

    PoolKey public key;
    uint128 public liq;
    mapping(uint256 => address) public ownerOf;

    constructor(PoolKey memory k, uint128 liq_) {
        key = k;
        liq = liq_;
    }

    function mintTo(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "NOT_OWNER");
        ownerOf[tokenId] = to;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "NOT_OWNER");
        ownerOf[tokenId] = to;
    }

    function getPositionLiquidity(uint256) external view returns (uint128) {
        return liq;
    }

    function getPoolAndPositionInfo(uint256) external view returns (PoolKey memory, PositionInfo) {
        int24 spacing = key.tickSpacing;
        PositionInfo info =
            PositionInfoLibrary.initialize(key, TickMath.minUsableTick(spacing), TickMath.maxUsableTick(spacing));
        return (key, info);
    }
}

contract TegridyBoostedLPStakerTest is Test {
    using PoolIdLibrary for PoolKey;

    MockReward reward;
    MockStakingBoost staking;
    MockPositionMgr pm;
    TegridyBoostedLPStaker staker;

    address alice = makeAddr("alice");
    uint256 constant TOKEN_ID = 1;
    uint128 constant LIQ = 1_000e18;

    function setUp() public {
        reward = new MockReward();
        staking = new MockStakingBoost();
        staking.setBoost(20_000); // 2x by default

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0x1111)),
            currency1: Currency.wrap(address(0x2222)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        pm = new MockPositionMgr(key, LIQ);
        bytes32 poolId = PoolId.unwrap(key.toId());

        staker =
            new TegridyBoostedLPStaker(IERC20(address(reward)), address(staking), address(pm), poolId, address(this));

        pm.mintTo(alice, TOKEN_ID);
        pm.mintTo(bob, TOKEN_ID_2);
    }

    address bob = makeAddr("bob");
    uint256 constant TOKEN_ID_2 = 2;

    function _fundRewards(uint256 amount, uint256 duration) internal {
        reward.mint(address(this), amount);
        reward.approve(address(staker), amount);
        staker.notifyRewardAmount(amount, duration);
    }

    function _depositAs(address who, uint256 tokenId) internal {
        vm.prank(who);
        staker.deposit(tokenId);
    }

    function _deposit() internal {
        vm.prank(alice);
        staker.deposit(TOKEN_ID);
    }

    function test_DepositAppliesBoostWhenOracleHealthy() public {
        _deposit();
        assertEq(staker.liquidityOf(alice), LIQ, "raw liquidity");
        // 2x boost: effective = raw * 20000 / 10000
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ) * 2, "boosted balance");
        assertEq(pm.ownerOf(TOKEN_ID), address(staker), "NFT escrowed");
    }

    /// @notice THE PRINCIPAL-TRAP FIX. A staker must be able to withdraw their own
    ///         escrowed LP NFT even when the boost oracle is down. Before the fix,
    ///         withdraw() called _resync() which read the reverting oracle and
    ///         reverted, trapping the NFT.
    function test_WithdrawReturnsNFTEvenWhenBoostReadReverts() public {
        _deposit();

        // The staking contract goes down (paused / checkpoint bug / ABI break).
        staking.setReverting(true);

        vm.prank(alice);
        staker.withdraw(TOKEN_ID); // must NOT revert

        assertEq(pm.ownerOf(TOKEN_ID), alice, "NFT returned to the depositor");
        assertEq(staker.liquidityOf(alice), 0, "raw liquidity cleared");
        assertEq(staker.effectiveBalanceOf(alice), 0, "effective balance cleared");
    }

    /// @notice THE ANTI-DIVERSION INVARIANT. `refreshBoost` is permissionless. An
    ///         oracle outage must NOT let a stranger deflate a victim's boost to 1x —
    ///         that would skim the victim's future accrual onto everyone else (the
    ///         permissionless-write + degraded-read diversion the v2 distributor was
    ///         rebuilt to kill). So a refresh on a bad read REVERTS and leaves the
    ///         victim exactly as they were.
    function test_RefreshBoostRevertsDuringOutageAndCannotDeflateAVictim() public {
        _deposit();
        uint256 boostedBefore = staker.effectiveBalanceOf(alice);
        assertEq(boostedBefore, uint256(LIQ) * 2);

        staking.setReverting(true);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(bytes("STAKING_DOWN"));
        staker.refreshBoost(alice);

        // Untouched: the outage cost the victim nothing.
        assertEq(staker.effectiveBalanceOf(alice), boostedBefore, "victim boost deflated by a stranger");

        // And it self-heals: once the oracle is back, a refresh keeps the boost.
        staking.setReverting(false);
        staker.refreshBoost(alice);
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ) * 2, "boost not preserved on recovery");
    }

    /// @notice Deposit is strict too: on a bad read it reverts atomically, so the
    ///         caller keeps their NFT and simply retries. (Only the exit path is
    ///         allowed to proceed on a failed read.)
    function test_DepositRevertsDuringOutage() public {
        staking.setReverting(true);
        vm.prank(alice);
        vm.expectRevert(bytes("STAKING_DOWN"));
        staker.deposit(TOKEN_ID);
        assertEq(pm.ownerOf(TOKEN_ID), alice, "NFT not pulled on a failed deposit");
    }

    /// @notice RESIDUAL from the review: a mid-outage withdrawer exits tolerantly at
    ///         1x, and this must NOT retroactively cheapen what they already earned at
    ///         their real boost. `updateReward` crystallises BEFORE `_resync` degrades,
    ///         so the pre-outage accrual is banked at the boosted share and pays in full.
    ///         Two stakers with DIFFERENT boosts, so the boost actually drives the split.
    function test_WithdrawMidOutagePaysFullBoostedPreOutageAccrual() public {
        staking.setBoostFor(alice, 45_000); // 4.5x
        staking.setBoostFor(bob, 10_000); // 1x
        _depositAs(alice, TOKEN_ID);
        _depositAs(bob, TOKEN_ID_2);
        // alice effective = LIQ*4.5, bob = LIQ*1 → alice's share is 4.5/5.5.
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ) * 45_000 / 10_000);

        _fundRewards(5.5 ether, 30 days);
        skip(10 days);

        // Snapshot alice's earned at her real 4.5x share, at this exact instant.
        uint256 earnedBoosted = staker.earned(alice);
        assertGt(earnedBoosted, 0);

        // Oracle goes down; alice withdraws in the SAME block (no further accrual).
        staking.setReverting(true);
        vm.prank(alice);
        staker.withdraw(TOKEN_ID);

        // Crystallised at the boosted share, not re-split at the degraded 1x.
        assertEq(staker.rewards(alice), earnedBoosted, "boosted accrual cheapened on a tolerant exit");
        assertEq(pm.ownerOf(TOKEN_ID), alice, "NFT returned");

        // And it actually pays out in full.
        uint256 balBefore = reward.balanceOf(alice);
        vm.prank(alice);
        staker.getReward();
        assertEq(reward.balanceOf(alice) - balBefore, earnedBoosted, "did not pay the full boosted accrual");
    }

    // ── ABI-break coverage: emergencyWithdraw is the UNCONDITIONAL exit. ───────────
    //    The tolerant withdraw() survives a plain revert (test above), but re-traps on
    //    a no-code or malformed-return boost source — its high-level call reverts past
    //    the catch (extcodesize precheck / uint256 decode). These pin that limitation
    //    AND prove emergencyWithdraw (which reads the boost source not at all) recovers
    //    the NFT in every break mode.

    function test_EmergencyWithdrawReturnsNFTWhenBoostReadReturnsMalformed() public {
        _deposit();
        vm.etch(address(staking), hex"60006000f3"); // returns 0 bytes -> uint256 decode fails

        // Documented limitation: the tolerant withdraw() still re-traps here.
        vm.prank(alice);
        vm.expectRevert();
        staker.withdraw(TOKEN_ID);

        // The zero-oracle hatch always recovers the NFT.
        vm.prank(alice);
        staker.emergencyWithdraw(TOKEN_ID);
        assertEq(pm.ownerOf(TOKEN_ID), alice, "NFT recovered via the zero-oracle hatch");
        assertEq(staker.liquidityOf(alice), 0, "raw liquidity cleared");
        assertEq(staker.effectiveBalanceOf(alice), 0, "effective balance cleared");
        assertEq(staker.totalEffectiveSupply(), 0, "total effective supply cleared");
    }

    function test_EmergencyWithdrawReturnsNFTWhenBoostSourceHasNoCode() public {
        _deposit();
        vm.etch(address(staking), ""); // no code -> extcodesize precheck reverts

        vm.prank(alice);
        vm.expectRevert();
        staker.withdraw(TOKEN_ID);

        vm.prank(alice);
        staker.emergencyWithdraw(TOKEN_ID);
        assertEq(pm.ownerOf(TOKEN_ID), alice, "NFT recovered via the zero-oracle hatch");
        assertEq(staker.liquidityOf(alice), 0, "raw liquidity cleared");
        assertEq(staker.totalEffectiveSupply(), 0, "total effective supply cleared");
    }

    function test_EmergencyWithdrawIsDepositorGated() public {
        _deposit();
        vm.prank(bob); // not the depositor
        vm.expectRevert(TegridyBoostedLPStaker.NotDepositor.selector);
        staker.emergencyWithdraw(TOKEN_ID);
    }

    function test_EmergencyWithdrawPreservesRewards() public {
        _fundRewards(100 ether, 30 days);
        _deposit();
        vm.warp(block.timestamp + 10 days);
        uint256 owed = staker.earned(alice);
        assertGt(owed, 0, "accrued something");

        vm.etch(address(staking), ""); // boost source breaks
        vm.prank(alice);
        staker.emergencyWithdraw(TOKEN_ID);

        // Reward math is oracle-free, so the crystallized rewards still pay out.
        uint256 balBefore = reward.balanceOf(alice);
        vm.prank(alice);
        staker.getReward();
        assertEq(reward.balanceOf(alice) - balBefore, owed, "rewards preserved through the emergency exit");
    }
}
