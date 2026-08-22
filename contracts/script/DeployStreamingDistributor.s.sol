// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {StreamingRevenueDistributor} from "../src/v2/StreamingRevenueDistributor.sol";

/// @title DeployStreamingDistributor
/// @notice Deploy script for `src/v2/StreamingRevenueDistributor.sol`.
///
///         THIS BELONGS TO THE AUDITED v2 BATCH AND MUST NOT BE BROADCAST BEFORE IT.
///         The contract is reward accounting on a money path; it has not been through
///         an audit wave. Dry-run only (`forge script` with no `--broadcast`).
///
///         The script deliberately deploys with streaming DISABLED and with the
///         restaking pointer UNSET. Both are behind timelocks on the contract and
///         both are operator steps taken after the cutover reads below, not deploy
///         parameters. A deploy that arrives already enabled would be able to open a
///         schedule before the fee leg is redirected, which is the exact ordering
///         mistake the migration sequence exists to prevent.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  CUTOVER SEQUENCE (mirrors the MIGRATION block in the contract header)
/// ─────────────────────────────────────────────────────────────────────────────
///  Order is load-bearing. Redirecting the fee leg before closing v1's open epoch
///  strands whatever is sitting in v1 below its 1 ETH distribute floor.
///
///   0. READ FIRST, against the live v1 distributor (publicnode, no key needed):
///        cast call $V1 "epochs(uint256)(uint256,uint256,uint256)" <length-1>
///        cast call $V1 "totalEarmarked()(uint256)"
///        cast call $V1 "totalClaimed()(uint256)"
///        cast balance $V1
///      Un-reserved residue = balance - (totalEarmarked - totalClaimed).
///
///   1. Deploy v2 (this script). Owner = the Safe that owns v1.
///   2. If the residue from step 0 is >= 1 ETH:
///        cast send $V1 "distributePermissionless()"
///      If it is < 1 ETH, it can never form an epoch. Either top v1 up over the
///      floor and then distribute, or accept recovery through v1's 48h
///      `proposeEmergencyWithdrawExcess`. Do NOT proceed to step 3 first.
///   3. Redirect the staker fee leg from v1 to v2 (SwapFeeRouterAdmin, 48h).
///   4. v2: `proposeEnableStreaming()` -> 48h -> `executeEnableStreaming()`.
///   5. v2: `syncMany(<staker set>)` in the same block range as step 4, and again
///      right after the first `notifyRewardAmount()`. Accrual is NOT retroactive:
///      any staker unsynced at the first notify earns nothing for as long as they
///      stay unsynced, and that share accrues to the accounts that are synced.
///      This is the one operational obligation the epoch design did not carry.
///   6. Frontend: gate every earnings figure on `isSynced(account)`. An unsynced
///      account's zero is "not registered", never "no revenue yet".
///   7. v1 stays claimable forever. Do NOT point the same fee leg at both.
contract DeployStreamingDistributorScript is Script {
    // Live relaunch TegridyStaking (veTOWELI). Source: frontend/src/lib/constants.ts.
    // OPERATOR: re-read this on-chain before any broadcast — it is the sole source of
    // every balance this contract pays out over.
    address constant TEGRIDY_STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant MULTISIG = 0xA36053477568Fb5382492F3A5970D35Fe896b7F8;

    /// @dev Matches the LP-farming cadence and v1's practical distribution rhythm.
    ///      Changing it later is period-gated + 24h timelocked on the contract.
    uint256 constant REWARDS_DURATION = 7 days;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        console.log("=== StreamingRevenueDistributor (v2 batch - DRY RUN ONLY) ===");
        console.log("votingEscrow (TegridyStaking):", TEGRIDY_STAKING);
        console.log("WETH:", WETH);
        console.log("rewardsDuration (sec):", REWARDS_DURATION);

        vm.startBroadcast();

        StreamingRevenueDistributor d = new StreamingRevenueDistributor(
            TEGRIDY_STAKING,
            WETH,
            REWARDS_DURATION
        );
        console.log("deployed:", address(d));

        d.transferOwnership(MULTISIG);
        console.log("ownership transfer initiated to:", MULTISIG);

        vm.stopBroadcast();

        console.log("");
        console.log("streamingEnabled at deploy:", d.streamingEnabled());
        console.log("restakingContract at deploy:", address(d.restakingContract()));
        console.log("");
        console.log("Post-deploy, in order - see the CUTOVER SEQUENCE in this file:");
        console.log("  a) Safe: acceptOwnership()");
        console.log("  b) close v1's open epoch BEFORE redirecting any fee leg");
        console.log("  c) redirect the staker leg to this address (48h)");
        console.log("  d) proposeRestakingChange(<TegridyRestaking>) -> 48h -> execute");
        console.log("  e) proposeEnableStreaming() -> 48h -> executeEnableStreaming()");
        console.log("  f) syncMany(<full staker set>) at enable AND after first notify");
    }
}
