// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/VoteIncentives.sol";
// AUDIT FIX (pass-8): EIP170-03 split — propose/execute/cancel surface lives on
// VoteIncentivesAdmin. Wired post-deploy via setVoteIncentivesAdmin.
import "../src/VoteIncentivesAdmin.sol";

/// @title DeployVoteIncentives - Deploy the bribe market contract
/// @dev Deploys VoteIncentives and proposes initial token whitelisting.
///      SwapFeeRouter is NOT redeployed — the existing one was upgraded in-place
///      with dynamic fee tiers and premium discount support.
contract DeployVoteIncentivesScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    // Updated to new audit-fixed staking contract (April 2026 deployment)
    address constant TEGRIDY_STAKING = 0x626644523d34B84818df602c991B4a06789C4819;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant TEGRIDY_FACTORY = 0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6;

    uint256 constant BRIBE_FEE_BPS = 300; // 3%

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        console.log("=== Deploying VoteIncentives ===");
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast();
        console.log("Deployer:", msg.sender);

        // 1. Deploy VoteIncentives
        // AUDIT FIX FRESH-2026: F-69-1 — sequencer-buffer extension on
        // vote-end / reveal-deadline windows. SEQUENCER_FEED env is optional;
        // address(0) on mainnet (chainid==1) since L2 sequencer feeds don't apply.
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        VoteIncentives vi = new VoteIncentives(
            TEGRIDY_STAKING,
            TREASURY,
            WETH,
            TEGRIDY_FACTORY,
            TOWELI,            // AUDIT H-2: commit-reveal bond token
            SEQUENCER_FEED,    // AUDIT F-69-1: sequencer feed (0 on mainnet)
            BRIBE_FEE_BPS
        );
        console.log("1. VoteIncentives deployed:", address(vi));
        console.log("   Fee:", BRIBE_FEE_BPS, "bps");

        // 1b. AUDIT FIX (pass-8): EIP170-03 split — wire VoteIncentivesAdmin sister.
        VoteIncentivesAdmin viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));
        console.log("1b. VoteIncentivesAdmin deployed:", address(viAdmin));

        // 2. Propose TOWELI whitelist (24h timelock) — via admin sister contract
        viAdmin.proposeWhitelistChange(TOWELI, true);
        console.log("2. TOWELI whitelist proposed (24h timelock)");

        // 3. Propose WETH whitelist (must cancel+repropose after TOWELI executes,
        //    since only 1 pending whitelist at a time)
        //    Skip for now — do after TOWELI whitelist is executed.
        console.log("   NOTE: Whitelist WETH after executing TOWELI whitelist in 24h");

        // 4. Transfer ownership to multisig (Ownable2Step — multisig must acceptOwnership)
        //    Both contracts must hand off — admin owns the timelocked surface, vi owns
        //    `setVoteIncentivesAdmin` (idempotently locked once wired) and pause/unpause.
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");
        {
            vi.transferOwnership(multisig);
            viAdmin.transferOwnership(multisig);
            console.log("3. Ownership transfer initiated to:", multisig);
            console.log("   Multisig must call acceptOwnership() on BOTH vi and viAdmin");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("VoteIncentives:", address(vi));
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Wait 24h, then call executeWhitelistChange() to whitelist TOWELI");
        console.log("2. Propose + execute WETH whitelist");
        console.log("3. Update frontend VOTE_INCENTIVES_ADDRESS in constants.ts");
        console.log("4. If multisig set: call acceptOwnership() from multisig");
        console.log("5. On SwapFeeRouter (existing): call proposePremiumAccessChange(PremiumAccess)");
        console.log("6. On SwapFeeRouter: call proposePremiumDiscountChange(5000) for 50% discount");
    }
}
