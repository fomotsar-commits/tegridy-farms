// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

interface IReferralSplitter {
    function setApprovedCaller(address, bool) external;
    function completeSetup() external;
    function transferOwnership(address) external;
}

interface IVoteIncentives {
    function proposeWhitelistChange(address, bool) external;
    function transferOwnership(address) external;
}

interface IRevenueDistributor {
    function proposeRestakingChange(address) external;
    function transferOwnership(address) external;
}

interface ITegridyStaking {
    function transferOwnership(address) external;
}

interface IOwnable {
    function transferOwnership(address) external;
}

/// @title WireV2 — Post-deployment wiring for V2 contracts
/// @notice Sends the 14 wiring transactions that were dropped during initial broadcast.
contract WireV2Script is Script {
    // V2 deployed addresses
    address constant STAKING = 0x626644523d34B84818df602c991B4a06789C4819;
    address constant VOTE_INCENTIVES = 0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A;
    address constant RESTAKING = 0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4;
    address constant REFERRAL = 0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16;
    address constant SWAP_ROUTER = 0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0;
    address constant GRANTS = 0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032;
    address constant REV_DIST = 0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8;
    address constant BOUNTY = 0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9;
    address constant PREMIUM = 0xaA16dF3dC66c7A6aD7db153711329955519422Ad;

    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant MULTISIG = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        console.log("=== V2 WIRING TRANSACTIONS ===");

        vm.startBroadcast(deployerPrivateKey);

        // 1. ReferralSplitter: approve SwapFeeRouter + lock setup
        IReferralSplitter(REFERRAL).setApprovedCaller(SWAP_ROUTER, true);
        IReferralSplitter(REFERRAL).completeSetup();
        console.log("1. ReferralSplitter wired + locked");

        // 2. VoteIncentives: propose TOWELI whitelist
        IVoteIncentives(VOTE_INCENTIVES).proposeWhitelistChange(TOWELI, true);
        console.log("2. VoteIncentives TOWELI whitelist proposed");

        // 3. RevenueDistributor: propose restaking link
        IRevenueDistributor(REV_DIST).proposeRestakingChange(RESTAKING);
        console.log("3. RevenueDistributor restaking proposed");

        // 4. SIZE-REDUCTION SPRINT 2026-04-26: timelocked admin lives on TegridyStakingAdmin
        console.log("4. TegridyStaking restaking link must be proposed via TegridyStakingAdmin");

        // 5. Transfer ownership of all 9 to multisig
        ITegridyStaking(STAKING).transferOwnership(MULTISIG);
        IVoteIncentives(VOTE_INCENTIVES).transferOwnership(MULTISIG);
        IOwnable(RESTAKING).transferOwnership(MULTISIG);
        IReferralSplitter(REFERRAL).transferOwnership(MULTISIG);
        IOwnable(SWAP_ROUTER).transferOwnership(MULTISIG);
        IOwnable(GRANTS).transferOwnership(MULTISIG);
        IOwnable(REV_DIST).transferOwnership(MULTISIG);
        IOwnable(BOUNTY).transferOwnership(MULTISIG);
        IOwnable(PREMIUM).transferOwnership(MULTISIG);
        console.log("5. All 9 ownership transfers initiated");

        vm.stopBroadcast();

        console.log("");
        console.log("=== WIRING COMPLETE ===");
    }
}
