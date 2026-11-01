// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";

interface ISwapFeeRouterRepoint {
    function referralSplitter() external view returns (address);
    function revenueDistributor() external view returns (address);
    function recoverCallerCredit() external;
    function paused() external view returns (bool);
}

/// @title  ExecuteStakingRelease1Repoint — step 2 of the staking release, 48 hours after step 1
/// @notice Points the live SwapFeeRouter at the new RevenueDistributor and ReferralSplitter that
///         `DeployStakingRelease1.s.sol` proposed. Before that, it empties the OLD splitter of
///         the two small balances it holds for us (read 2026-10-14):
///           - 0.0000006 ETH treasury share  -> Treasury Safe (`withdrawTreasuryFees`, owner)
///           - 0.0000024 ETH router credit   -> back into the router's fee pot
///             (`SwapFeeRouter.recoverCallerCredit`, permissionless)
///         so nothing of ours is left behind in a contract the router no longer calls.
///         Old referrers are owed nothing (`totalPendingETH` was 0).
///
/// @dev    Needs the two new addresses (printed by step 1) as env vars:
///             NEW_REVENUE_DISTRIBUTOR, NEW_REFERRAL_SPLITTER
///         Window: from the ready time printed by step 1 until 7 days after it. After that the
///         proposals expire, and the owner must cancel them and propose again (another 48h).
///
///         forge script script/ExecuteStakingRelease1Repoint.s.sol --rpc-url mainnet \
///           --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E --interactive --broadcast --slow
contract ExecuteStakingRelease1RepointScript is Script {
    address constant OWNER = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address constant OLD_REV_DIST = 0xF993316E2fC079de4358c489A935E01e03E23E17;
    address constant OLD_REF_SPLITTER = 0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c;
    address constant SWAP_FEE_ROUTER = 0x6d5791A660e79175F74C6D639584C98422d5956E;
    address constant SWAP_FEE_ROUTER_ADMIN = 0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        address newRevDist = vm.envAddress("NEW_REVENUE_DISTRIBUTOR");
        address newSplitter = vm.envAddress("NEW_REFERRAL_SPLITTER");

        SwapFeeRouterAdmin sfra = SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN);
        ISwapFeeRouterRepoint router = ISwapFeeRouterRepoint(SWAP_FEE_ROUTER);

        // The proposals must be exactly the ones step 1 made, and the new contracts must be the
        // 75% stack, so a typo in an env var cannot point the router somewhere else.
        require(sfra.pendingRevenueDistributor() == newRevDist, "queued distributor != NEW_REVENUE_DISTRIBUTOR");
        require(sfra.pendingReferralSplitter() == newSplitter, "queued splitter != NEW_REFERRAL_SPLITTER");
        address newStaking = address(RevenueDistributor(payable(newRevDist)).votingEscrow());
        require(address(ReferralSplitter(payable(newSplitter)).stakingContract()) == newStaking, "the two new contracts disagree on staking");
        require(TegridyStaking(newStaking).EARLY_WITHDRAWAL_PENALTY_BPS() == 7500, "not the 75% staking");
        require(TegridyStaking(newStaking).owner() == OWNER, "new staking not owned by the owner");
        require(ReferralSplitter(payable(newSplitter)).approvedCallers(SWAP_FEE_ROUTER), "new splitter does not accept the router");
        uint256 readyAt = sfra.revenueDistributorChangeTime();
        require(readyAt != 0 && block.timestamp >= readyAt, "48h not over yet: distributor");
        require(block.timestamp >= sfra.referralSplitterChangeTime(), "48h not over yet: splitter");
        require(block.timestamp <= readyAt + 7 days, "proposal expired: cancel and propose again");

        ReferralSplitter oldSplitter = ReferralSplitter(payable(OLD_REF_SPLITTER));
        uint256 treasuryShare = oldSplitter.accumulatedTreasuryETH();
        uint256 routerCredit = oldSplitter.callerCredit(SWAP_FEE_ROUTER);

        vm.startBroadcast();
        require(msg.sender == OWNER, "sender must be the owner 0x14898258122C0740106391E6e8E4F17F3b6d456E");
        if (treasuryShare > 0) oldSplitter.withdrawTreasuryFees();
        if (routerCredit > 0 && !router.paused()) router.recoverCallerCredit();
        sfra.executeRevenueDistributor();
        sfra.executeReferralSplitterChange();
        vm.stopBroadcast();

        require(router.revenueDistributor() == newRevDist, "router distributor not switched");
        require(router.referralSplitter() == newSplitter, "router splitter not switched");
        require(oldSplitter.accumulatedTreasuryETH() == 0, "old splitter still holds the treasury share");
        console2.log("router.revenueDistributor ->", newRevDist);
        console2.log("router.referralSplitter   ->", newSplitter);
        console2.log("old splitter treasury share sent to Treasury Safe (wei):", treasuryShare);
        console2.log("old splitter router credit left (wei):", oldSplitter.callerCredit(SWAP_FEE_ROUTER));
        console2.log("old distributor ETH left (wei):", OLD_REV_DIST.balance);
    }
}
