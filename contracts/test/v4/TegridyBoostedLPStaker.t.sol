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
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @dev The veTOWELI boost source. Reads can be made to revert on demand, to
///      model a paused/broken staking contract or a future ABI break.
contract MockStakingBoost {
    uint256 public boost;
    bool public reverting;
    function setBoost(uint256 b) external { boost = b; }
    function setReverting(bool r) external { reverting = r; }
    function aggregateActiveBoostBps(address) external view returns (uint256) {
        require(!reverting, "STAKING_DOWN");
        return boost;
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

    function mintTo(address to, uint256 tokenId) external { ownerOf[tokenId] = to; }

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
        PositionInfo info = PositionInfoLibrary.initialize(
            key, TickMath.minUsableTick(spacing), TickMath.maxUsableTick(spacing)
        );
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

        staker = new TegridyBoostedLPStaker(
            IERC20(address(reward)), address(staking), address(pm), poolId, address(this)
        );

        pm.mintTo(alice, TOKEN_ID);
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

    /// @notice A boost-oracle outage degrades a remaining position to the 1x floor
    ///         rather than reverting — the safe, self-healing direction.
    function test_OutageDegradesToFloorAndSelfHeals() public {
        _deposit();
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ) * 2);

        staking.setReverting(true);
        staker.refreshBoost(alice); // permissionless poke; must not revert
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ), "degraded to 1x floor");

        // Oracle recovers; the next poke restores the boost.
        staking.setReverting(false);
        staker.refreshBoost(alice);
        assertEq(staker.effectiveBalanceOf(alice), uint256(LIQ) * 2, "re-boosted on recovery");
    }
}
