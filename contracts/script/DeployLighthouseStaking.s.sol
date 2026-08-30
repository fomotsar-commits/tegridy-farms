// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {StakingRewards} from "../src/vendor/synthetix-staking-rewards/StakingRewards.sol";
import {BaseChainConfig} from "./base/BaseChainConfig.sol";

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

/// @title  DeployLighthouseStaking - one island lighthouse pool (stake X, earn X).
/// @notice Deploys the VENDORED Synthetix StakingRewards (see
///         src/vendor/synthetix-staking-rewards/VENDOR.md + provenance D8) for
///         one bungalow token. Chain-gated but dual-chain: the island's EVM
///         residents live on Ethereum (PEPE) and Base (QR/MFER/BNKR/DRB/JBM/RIZZ),
///         so EXPECTED_CHAIN_ID is explicit env - the script refuses any other id,
///         same posture as BaseChainConfig.requireBaseChain but chosen per run.
///
/// @dev    WHY THIS CONTRACT: withdraw() is principal-only, so a staker's exit
///         can never be held hostage by an empty reward vault - the Streamflow
///         error-6012 class the Solana lighthouse proved on devnet is
///         structurally impossible here. That property is pinned by
///         test/vendor/StakingRewardsLighthouseTest.
///
/// @dev    ROLES (the factory-guardian lesson: no EOA roles, ever):
///           - There is NO owner on this contract at all. The only privileged
///             role is rewardsDistribution (can notify; cannot touch funds,
///             cannot pause, cannot rescue) - set it to the Fee-Remittance Safe.
///
/// @dev    WARNING: SAME-TOKEN FUNDING LAW (VENDOR.md, test-pinned): the canonical
///         notify guard counts staked PRINCIPAL as fundable balance. Every
///         notifyRewardAmount MUST be bounded by
///             reward <= token.balanceOf(pool) - pool.totalSupply()
///         (fund first, notify exactly what was funded). Over-notifying lets
///         reward payouts spend other stakers' principal and strands the last
///         withdrawer. The funding ceremony enforces this; nothing on-chain does.
///
/// @dev    Env vars:
///           EXPECTED_CHAIN_ID     - 1 (Ethereum) or 8453 (Base); refused otherwise
///           STAKING_TOKEN         - the bungalow token (staking == rewards token)
///           REWARDS_DISTRIBUTION  - the Safe allowed to notifyRewardAmount
contract DeployLighthouseStakingScript is Script {
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

    /// @notice Test entrypoint - same validation and deploy body, no env, no broadcast.
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
        // The island's EVM legs, and nothing else. An explicit env id (rather
        // than accepting whatever RPC was pasted) makes a wrong-chain broadcast
        // a config refusal instead of a deployed orphan.
        require(
            cfg.expectedChainId == 1 || cfg.expectedChainId == BaseChainConfig.CHAIN_ID,
            "EXPECTED_CHAIN_ID: lighthouse pools deploy on Ethereum (1) or Base (8453) only"
        );
        require(block.chainid == cfg.expectedChainId, "wrong chain for EXPECTED_CHAIN_ID");

        BaseChainConfig.requireSafe(cfg.rewardsDistribution, "REWARDS_DISTRIBUTION");
        BaseChainConfig.requireHasCode(cfg.stakingToken, "STAKING_TOKEN");

        // Mechanical truths only - economics stay operator decisions. decimals()
        // is read AND printed so the funding ceremony's whole-token arithmetic
        // starts from the chain's number, never an assumption (the Solana
        // ceremony learned this the readVerifiedDecimals way).
        uint8 dec = IERC20MetadataLike(cfg.stakingToken).decimals();
        require(dec > 0 && dec <= 18, "STAKING_TOKEN: decimals outside 1..18");
        require(
            IERC20MetadataLike(cfg.stakingToken).totalSupply() > 0,
            "STAKING_TOKEN: zero total supply - wrong address or unlaunched token"
        );
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        StakingRewards pool = new StakingRewards(
            cfg.rewardsDistribution,
            cfg.stakingToken, // rewardsToken - stake X, earn X is the island's shape
            cfg.stakingToken
        );
        d.pool = address(pool);
        console.log("1. StakingRewards lighthouse:", d.pool);
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        StakingRewards pool = StakingRewards(d.pool);
        require(address(pool.stakingToken()) == cfg.stakingToken, "L-INV-1: staking token mismatch");
        require(address(pool.rewardsToken()) == cfg.stakingToken, "L-INV-2: rewards token != staking token");
        require(pool.rewardsDistribution() == cfg.rewardsDistribution, "L-INV-3: distribution role mismatch");
        require(pool.rewardRate() == 0, "L-INV-4: pool must deploy unfunded (funding is LAST, in public)");
        require(pool.periodFinish() == 0, "L-INV-5: no reward period may exist at deploy");
        require(pool.totalSupply() == 0, "L-INV-6: nothing staked at deploy");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal view {
        console.log("");
        console.log("=== LIGHTHOUSE POOL DEPLOYED (UNFUNDED - that is correct) ===");
        console.log("Pool:      ", d.pool);
        console.log("Token:     ", cfg.stakingToken);
        console.log("Decimals:  ", IERC20MetadataLike(cfg.stakingToken).decimals());
        console.log("Notifier:  ", cfg.rewardsDistribution);
        console.log("");
        console.log("NO LOCKS ON THIS POOL: stake and withdraw are free at any time,");
        console.log("and withdraw() moves principal only - an empty reward vault can");
        console.log("never hold an exit hostage. Surfaces must say so (the Solana");
        console.log("lighthouse has locks; this one does not - do not copy that copy).");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Register the pool in frontend/scripts/addresses.json + the");
        console.log("     bungalow registry stakePool slot (hardcoded, not env).");
        console.log("  2. FUND LAST, IN PUBLIC, and obey the same-token law:");
        console.log("     transfer reward tokens to the pool, then notifyRewardAmount(R)");
        console.log("     from the distribution Safe with");
        console.log("       R <= token.balanceOf(pool) - pool.totalSupply()");
        console.log("     NEVER more - over-notifying spends stakers' principal");
        console.log("     (VENDOR.md, pinned by StakingRewardsLighthouseTest).");
        console.log("  3. rewardsDuration is fixed at 60 days (canonical constant):");
        console.log("     each notify starts/extends a 60-day runway; periodFinish is");
        console.log("     the exact on-chain runway end for the UI.");
    }
}
