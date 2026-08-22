// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLPFarming} from "../../src/TegridyLPFarming.sol";
import {NullBoost} from "../../src/NullBoost.sol";
import {RobinhoodChainConfig} from "./RobinhoodChainConfig.sol";

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
}

interface IPairLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IFactoryLike {
    function getPair(address, address) external view returns (address);
}

/// @title  DeployRobinhoodLPFarming — boosted-LP farming on Robinhood Chain,
///         minus the boost. Mirrors script/base/DeployBaseLPFarming.s.sol; read that
///         header — everything it says applies here.
/// @notice TegridyLPFarming's audited bytecode ships unchanged. What changes per
///         chain is its two mainnet-only inputs:
///           - the boost source: mainnet uses TegridyStaking (veTOWELI-weighted);
///             this chain has no staking, so the farm points at NullBoost and
///             every staker gets a flat 1.0x. Honest, flat, nothing to game.
///           - the reward token: mainnet pays TOWELI, which is fixed-supply and
///             NEVER leaves mainnet (standing rule). The reward token here is an
///             OPERATOR DECISION passed by env — this script enforces only the
///             mechanical truths (a real 18-decimal token that is not the LP
///             token itself); what funds emissions on this chain is economics,
///             not engineering, and no script should pick it silently.
///
/// @dev    Deploy AFTER DeployRobinhoodMVP and after the pair you intend to farm
///         exists on the Robinhood TegridyFactory. STAKING_TOKEN must be that pair.
///
/// @dev    Env vars:
///           REWARD_TOKEN     — the 18-decimal ERC20 that funds emissions (see above)
///           STAKING_TOKEN    — the Robinhood TegridyPair LP token to farm
///           TREASURY         — recover/sweep destination Safe
///           MULTISIG         — Ownable role Safe
///           REWARDS_DURATION — optional, seconds; defaults to 7 days (mainnet parity)
contract DeployRobinhoodLPFarmingScript is Script {
    uint256 internal constant DEFAULT_REWARDS_DURATION = 7 days;

    struct Config {
        address rewardToken;
        address stakingToken;
        /// @dev This chain's TegridyFactory — STAKING_TOKEN must be one of its pairs.
        address factory;
        address treasury;
        address multisig;
        uint256 rewardsDuration;
    }

    struct Deployed {
        address nullBoost;
        address farm;
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

    /// @notice Test entrypoint — same validation and deploy body, no env, no broadcast.
    function runForTest(Config memory cfg) external returns (Deployed memory d) {
        _validate(cfg);
        d = _deploy(cfg);
        _assertDeployInvariants(cfg, d);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.rewardToken = vm.envAddress("REWARD_TOKEN");
        cfg.stakingToken = vm.envAddress("STAKING_TOKEN");
        cfg.factory = vm.envAddress("FACTORY");
        cfg.treasury = vm.envAddress("TREASURY");
        cfg.multisig = vm.envAddress("MULTISIG");
        cfg.rewardsDuration = vm.envOr("REWARDS_DURATION", DEFAULT_REWARDS_DURATION);
    }

    function _validate(Config memory cfg) internal view {
        RobinhoodChainConfig.requireRobinhoodChain();

        RobinhoodChainConfig.requireSafe(cfg.treasury, "TREASURY");
        RobinhoodChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.multisig, "MULTISIG");

        RobinhoodChainConfig.requireHasCode(cfg.rewardToken, "REWARD_TOKEN");
        RobinhoodChainConfig.requireHasCode(cfg.stakingToken, "STAKING_TOKEN");
        // The farm's reward math is written against 18 decimals (MIN_NOTIFY_AMOUNT
        // = 1000e18, MAX_REWARD_RATE = 1e18). A 6-decimal reward token would make
        // the minimum notify a thousand trillion tokens; catch it at config time.
        require(
            IERC20MetadataLike(cfg.rewardToken).decimals() == 18,
            "REWARD_TOKEN: farm reward math assumes 18 decimals"
        );

        // "Must be that pair" is a claim the chain can verify, so verify it: the
        // staking token must answer token0/token1 AND be the pair this chain's
        // TegridyFactory records for that token pair. Catches a pasted reward
        // token, a mainnet LP address, or any random ERC20 — all of which have
        // code and 18 decimals and would otherwise sail through to a farm nobody
        // can stake the intended pool into.
        RobinhoodChainConfig.requireHasCode(cfg.factory, "FACTORY");
        address token0 = IPairLike(cfg.stakingToken).token0();
        address token1 = IPairLike(cfg.stakingToken).token1();
        require(
            IFactoryLike(cfg.factory).getPair(token0, token1) == cfg.stakingToken,
            "STAKING_TOKEN: not a pair recorded by this chain's TegridyFactory"
        );
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        // The flat boost source. No roles, no storage — one per farm keeps the
        // wiring auditable at a glance (farm -> its own NullBoost, nothing shared).
        NullBoost boost = new NullBoost();
        d.nullBoost = address(boost);
        console.log("1. NullBoost:             ", d.nullBoost);

        TegridyLPFarming farm = new TegridyLPFarming(
            cfg.rewardToken,
            cfg.stakingToken,
            d.nullBoost,
            cfg.treasury,
            cfg.rewardsDuration
        );
        d.farm = address(farm);
        console.log("2. TegridyLPFarming:      ", d.farm);

        farm.transferOwnership(cfg.multisig);
        console.log("   -> ownership offered to multisig");
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        TegridyLPFarming farm = TegridyLPFarming(d.farm);
        require(address(farm.rewardToken()) == cfg.rewardToken, "F-INV-1: reward token mismatch");
        require(address(farm.stakingToken()) == cfg.stakingToken, "F-INV-2: staking token mismatch");
        require(address(farm.tegridyStaking()) == d.nullBoost, "F-INV-3: boost source != NullBoost");
        require(farm.treasury() == cfg.treasury, "F-INV-4: treasury mismatch");
        require(farm.rewardsDuration() == cfg.rewardsDuration, "F-INV-5: duration mismatch");
        // The property NullBoost exists to guarantee: flat 1.0x for everyone.
        require(
            NullBoost(d.nullBoost).aggregateActiveBoostBps(address(this)) == 0,
            "F-INV-6: boost source is not flat"
        );
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== ROBINHOOD LP FARMING COMPLETE ===");
        console.log("NullBoost:", d.nullBoost);
        console.log("Farm:     ", d.farm);
        console.log("");
        console.log("EVERY STAKER EARNS AT FLAT 1.0x ON THIS CHAIN - there is no veTOWELI here");
        console.log("to boost with, and surfaces must not imply otherwise.");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Safe acceptOwnership() on the farm within the 14-day expiry.");
        console.log("  2. Fund emissions: transfer reward tokens, then notifyRewardAmount()");
        console.log("     from the owner (>= 1000e18 per notify - the farm's floor).");
        console.log("  3. Register both addresses in frontend/scripts/addresses.json (per-chain).");
        console.log("  4. Reward token:", cfg.rewardToken);
        console.log("     Its emissions budget is an operator decision - document it before go-live.");
    }
}
