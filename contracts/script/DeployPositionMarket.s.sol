// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyPositionMarket} from "../src/markets/TegridyPositionMarket.sol";

interface IStakingDeployCheck {
    function rewardToken() external view returns (address);
    function isLendingContract(address) external view returns (bool);
    function userTokenId(address) external view returns (uint256);
    function unsettledRewards(address) external view returns (uint256);
}

/// @title  DeployPositionMarket — escrowed secondary market for veTOWELI positions
///
/// @notice Env: STAKING (TegridyStaking, which is also the position NFT), WETH, MULTISIG.
///
/// @dev    The market ships with its fee dial at zero and NO sink wired, so it takes
///         nothing until the multisig explicitly calls `setFee`. Nothing else needs
///         wiring for it to function — it holds no privileged relationship to
///         TegridyStaking and must never be granted one.
///
/// @dev    DO NOT register this address as a lending contract on TegridyStaking. That
///         registration is a timelocked staking-admin action, and it would carve the
///         market out of the transfer cooldown and the transfer rate limit AND relax
///         the `AlreadyHasPosition` receiver guard for anything leaving this contract.
///         The market is designed to be correct while subject to all three; exempting
///         it would let a position land on a buyer who already holds one, which is
///         precisely the state the guard exists to prevent.
contract DeployPositionMarketScript is Script {
    function run() external {
        address staking = vm.envAddress("STAKING");
        address weth = vm.envAddress("WETH");
        address multisig = vm.envAddress("MULTISIG");

        require(staking != address(0) && weth != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(staking.code.length > 0, "STAKING must be a deployed contract");

        // Pre-flight the ABI couplings the market depends on. Each of these selectors is
        // `external` on TegridyStaking today; an EIP-170 golf pass has lowered a staking
        // selector to `internal` before (`userPositionCount`, 2026-05-31), and the
        // resulting empty-returndata revert is indistinguishable from a refusal on a
        // live money path. Fail here rather than there.
        IStakingDeployCheck s = IStakingDeployCheck(staking);
        require(s.rewardToken() != address(0), "STAKING.rewardToken() missing or zero");
        s.userTokenId(address(this));
        s.unsettledRewards(address(this));

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        TegridyPositionMarket marketContract = new TegridyPositionMarket(staking, weth, msg.sender);
        console2.log("TegridyPositionMarket deployed:", address(marketContract));

        require(!s.isLendingContract(address(marketContract)), "market must hold no staking escrow carve-out");
        require(marketContract.feeBps() == 0, "fee dial must ship at zero");
        require(marketContract.feeRecipient() == address(0), "fee sink must ship unwired");

        marketContract.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set POSITION_MARKET_ADDRESS in frontend/src/lib/constants.ts ->", address(marketContract));
        console2.log("3. Do NOT applyLendingContract() this address on TegridyStaking. See the notice above.");
        console2.log("4. Fee stays 0 / no sink until a RevenueDistributor path is agreed and timelocked.");
    }
}
