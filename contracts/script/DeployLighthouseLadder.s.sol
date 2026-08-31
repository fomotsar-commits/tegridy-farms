// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {LighthouseLadder} from "../src/LighthouseLadder.sol";
import {BaseChainConfig} from "./base/BaseChainConfig.sol";

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

/// @title  DeployLighthouseLadder — the island's LOCKED EVM lighthouse.
/// @notice Replaces the no-lock StakingRewards pools deployed earlier on
///         2026-08-30 with the ladder build (owner decision: "toweli style is
///         the way for evm"). Same shape of ceremony as
///         DeployLighthouseStaking.s.sol, which it supersedes.
///
/// @dev    SAFE TO REPLACE, TODAY ONLY. Every pool from the first round has
///         totalSupply() == 0 and has never been funded, so swapping the
///         contract costs gas and harms nobody. Once anyone stakes, this stops
///         being a redeploy and becomes a migration.
///
/// @dev    WHAT CHANGED vs the first round: locks 0..4 years with a 1.00x..
///         4.00x boost, a 25% early-exit penalty that stays in the pool, an
///         always-open emergency hatch, and — the load-bearing one — reward
///         payouts capped at `balanceOf(pool) - totalSupply()`, so a payout can
///         never spend principal. In a SAME-TOKEN pool that is the difference
///         between a funding ritual and an on-chain guarantee.
///
/// @dev    ROLES: there is no owner. `rewardsDistribution` is the only
///         privileged role, it can only call notifyRewardAmount, and it is
///         immutable — set it to a Safe, never an EOA.
///
/// @dev    Env vars:
///           EXPECTED_CHAIN_ID     — 1 (Ethereum) or 8453 (Base); refused otherwise
///           STAKING_TOKEN         — the bungalow token (stake it, earn it)
///           REWARDS_DISTRIBUTION  — the Safe allowed to notifyRewardAmount
contract DeployLighthouseLadderScript is Script {
    struct Config {
        uint256 expectedChainId;
        address stakingToken;
        address rewardsDistribution;
    }

    struct Deployed {
        address pool;
    }

    function run() external {
        Config memory cfg = _loadConfig();
        _validate(cfg);

        vm.startBroadcast();
        Deployed memory d = _deploy(cfg);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d);
        _printSummary(cfg, d);
    }

    /// @notice Test entrypoint — same validation and body, no env, no broadcast.
    function runForTest(Config memory cfg) external returns (Deployed memory d) {
        _validate(cfg);
        d = _deploy(cfg);
        _assertDeployInvariants(cfg, d);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        cfg.stakingToken = vm.envAddress("STAKING_TOKEN");
        cfg.rewardsDistribution = vm.envAddress("REWARDS_DISTRIBUTION");
    }

    function _validate(Config memory cfg) internal view {
        require(
            cfg.expectedChainId == 1 || cfg.expectedChainId == BaseChainConfig.CHAIN_ID,
            "EXPECTED_CHAIN_ID: island lighthouses deploy on Ethereum (1) or Base (8453) only"
        );
        require(block.chainid == cfg.expectedChainId, "wrong chain for EXPECTED_CHAIN_ID");

        BaseChainConfig.requireSafe(cfg.rewardsDistribution, "REWARDS_DISTRIBUTION");
        BaseChainConfig.requireHasCode(cfg.stakingToken, "STAKING_TOKEN");

        uint8 dec = IERC20MetadataLike(cfg.stakingToken).decimals();
        require(dec > 0 && dec <= 18, "STAKING_TOKEN: decimals outside 1..18");
        require(
            IERC20MetadataLike(cfg.stakingToken).totalSupply() > 0,
            "STAKING_TOKEN: zero total supply - wrong address or unlaunched token"
        );
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        // stake X, earn X — the constructor refuses anything else, because the
        // solvency theorem is denominated in one token.
        LighthouseLadder pool = new LighthouseLadder(
            cfg.rewardsDistribution,
            cfg.stakingToken,
            cfg.stakingToken
        );
        d.pool = address(pool);
        console.log("1. LighthouseLadder:", d.pool);
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        LighthouseLadder pool = LighthouseLadder(d.pool);
        require(address(pool.stakingToken()) == cfg.stakingToken, "L-INV-1: staking token mismatch");
        require(address(pool.rewardsToken()) == cfg.stakingToken, "L-INV-2: rewards token != staking token");
        require(pool.rewardsDistribution() == cfg.rewardsDistribution, "L-INV-3: distribution role mismatch");
        require(pool.rewardRate() == 0, "L-INV-4: must deploy unfunded (funding is LAST, in public)");
        require(pool.periodFinish() == 0, "L-INV-5: no reward period may exist at deploy");
        require(pool.totalSupply() == 0, "L-INV-6: nothing staked at deploy");
        require(pool.totalBoosted() == 0, "L-INV-7: no boost weight at deploy");
        // The ladder itself, so a wrong build cannot be deployed unnoticed.
        require(pool.boostFor(7 days) == 4_000, "L-INV-8: seven days must be 0.4x");
        require(pool.boostFor(4 * 365 days) == 40_000, "L-INV-9: four years must be 4.00x");
        require(pool.rewardSurplus() == 0, "L-INV-10: surplus must start empty");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal view {
        console.log("");
        console.log("=== LOCKED LIGHTHOUSE DEPLOYED (UNFUNDED - that is correct) ===");
        console.log("Pool:      ", d.pool);
        console.log("Token:     ", cfg.stakingToken);
        console.log("Decimals:  ", IERC20MetadataLike(cfg.stakingToken).decimals());
        console.log("Notifier:  ", cfg.rewardsDistribution);
        console.log("");
        console.log("LADDER: 7 days = 0.40x (TOWELI parity - the same ladder)");
        console.log("        4 years = 4.00x, linear in between. Ten-fold spread.");
        console.log("EXITS:  after the lock  -> principal + rewards, no penalty");
        console.log("        before the lock -> principal - 25%, rewards paid");
        console.log("        ALWAYS          -> emergencyWithdraw, principal only,");
        console.log("                           needing nothing from the reward path");
        console.log("");
        console.log("THE PRINCIPAL PROMISE: every reward payout is capped at");
        console.log("balanceOf(pool) - totalSupply(), so a payout can never spend");
        console.log("principal and withdrawing your own deposit cannot fail for");
        console.log("want of balance. The Solana leg cannot make this promise.");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Give the address to the agent: it derives the EIP-55 form,");
        console.log("     wires the registry + addresses.json, and pushes.");
        console.log("  2. FUND LAST, IN PUBLIC. Transfer reward tokens to the pool,");
        console.log("     then notifyRewardAmount(R) from the distribution Safe.");
        console.log("     The contract itself now refuses an over-notify - R is");
        console.log("     bounded by the surplus, not the whole balance.");
        console.log("  3. rewardsDuration is 60 days; each notify starts/extends it.");
    }
}
