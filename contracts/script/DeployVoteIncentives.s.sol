// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {VoteIncentives} from "../src/VoteIncentives.sol";
import {VoteIncentivesAdmin} from "../src/VoteIncentivesAdmin.sol";

/// @title  DeployVoteIncentives — per-wave deploy for the restored bribe market (+ Admin)
/// @notice Cartman's Market: epoch-pinned vote-power bribes, commit-reveal, WETH-fallback
///         claims. Deploys VoteIncentives + its EIP-170 Admin split, wires them (one-time
///         setVoteIncentivesAdmin while the deployer still owns), then hands BOTH to the
///         multisig (2-step). BRIBE_FEE_BPS is deploy-time policy — REVIEW.
/// @dev    Env: STAKING (votingEscrow), TREASURY, WETH, FACTORY (TegridyFactory),
///         TOWELI, BRIBE_FEE_BPS (default 300 = 3% last-known), MULTISIG.
contract DeployVoteIncentivesScript is Script {
    function run() external {
        address votingEscrow = vm.envAddress("STAKING");
        address treasury = vm.envAddress("TREASURY");
        address weth = vm.envAddress("WETH");
        address factory = vm.envAddress("FACTORY");
        address toweli = vm.envAddress("TOWELI");
        uint256 bribeFeeBps = vm.envOr("BRIBE_FEE_BPS", uint256(300)); // REVIEW — 3% last-known live value
        address multisig = vm.envAddress("MULTISIG");
        require(votingEscrow != address(0) && treasury != address(0) && weth != address(0) && factory != address(0) && toweli != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Bribe fee (bps):", bribeFeeBps);

        VoteIncentives vi = new VoteIncentives(votingEscrow, treasury, weth, factory, toweli, bribeFeeBps);
        console2.log("VoteIncentives deployed:", address(vi));

        VoteIncentivesAdmin admin = new VoteIncentivesAdmin(address(vi));
        console2.log("VoteIncentivesAdmin deployed:", address(admin));

        vi.setVoteIncentivesAdmin(address(admin)); // onlyOwner — wire BEFORE handing off ownership
        console2.log("Wired vi.setVoteIncentivesAdmin ->", address(admin));

        vi.transferOwnership(multisig);
        admin.transferOwnership(multisig);
        console2.log("Ownership of both transferred to multisig (2-step):", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership() on BOTH VoteIncentives and VoteIncentivesAdmin");
        console2.log("2. Set VOTE_INCENTIVES_ADDRESS in frontend/src/lib/constants.ts ->", address(vi));
    }
}
