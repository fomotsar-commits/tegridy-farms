// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @title Verify.s.sol — FRESH-EYES M-14 post-deploy invariant runner
/// @notice Asserts the wiring invariants that the deploy/wiring scripts SHOULD have set
///         but historically dropped (notably the TegridyStaking → restakingContract link
///         that WireV2/DeployRemaining/DeployFinal/DeploySepolia/DeployV2/DeployAuditFixes
///         all log as a "manual step" but never actually execute).
///
/// **Run via:** `forge script script/Verify.s.sol --rpc-url $RPC --account deployer`
///   (no --broadcast — this script is read-only).
///
/// **Workflow:** the operator MUST run this script and see ALL ✓ lines BEFORE transferring
/// ownership of any contract to the multisig. If any invariant fails, the deploy is
/// incomplete and the multisig handover should be aborted until the missing step lands.
///
/// **Pattern of record:** Aave / Compound deploy verifier scripts that gate ownership
/// rotation on a post-deploy invariant pass. Same approach used by OpenZeppelin's
/// `forge-deploy-utils` / Safe deploy harness.
interface ITegridyStaking_Verify {
    function restakingContract() external view returns (address);
    function paused() external view returns (bool);
    function owner() external view returns (address);
}

interface IVoteIncentives_Verify {
    function whitelistedTokens(address) external view returns (bool);
    function paused() external view returns (bool);
    function owner() external view returns (address);
}

interface IRevenueDistributor_Verify {
    function restakingContract() external view returns (address);
    function paused() external view returns (bool);
    function owner() external view returns (address);
}

interface IReferralSplitter_Verify {
    function setupComplete() external view returns (bool);
    function approvedCallers(address) external view returns (bool);
    function owner() external view returns (address);
}

interface IPair_Verify {
    function feeTo() external view returns (address);
    function disabledPairs(address) external view returns (bool);
    function feeToSetter() external view returns (address);
}

interface IOwnable_Verify {
    function owner() external view returns (address);
}

interface IPausable_Verify {
    function paused() external view returns (bool);
}

contract VerifyScript is Script {
    // ---- Fill in addresses for the chain being verified -------------------
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

    // Failure counter so the script reports ALL failures rather than reverting on the first.
    uint256 private failures;

    function run() external {
        console.log("=== TEGRIDY POST-DEPLOY INVARIANT VERIFY ===");
        console.log("chain.id:", block.chainid);
        console.log("");

        // ----- INV-1: TegridyStaking -> RESTAKING wired ----------------------
        // Critical: WireV2/DeployRemaining/etc. all SKIP this step. Without it, every
        // restaking-side flow that reads `staking.restakingContract()` returns address(0).
        _expectEq(
            "INV-1 staking.restakingContract == RESTAKING",
            ITegridyStaking_Verify(STAKING).restakingContract(),
            RESTAKING
        );

        // ----- INV-2: RevenueDistributor -> RESTAKING wired ------------------
        _expectEq(
            "INV-2 revDist.restakingContract == RESTAKING",
            IRevenueDistributor_Verify(REV_DIST).restakingContract(),
            RESTAKING
        );

        // ----- INV-3: VoteIncentives whitelists TOWELI -----------------------
        _expectTrue(
            "INV-3 voteIncentives.whitelistedTokens[TOWELI]",
            IVoteIncentives_Verify(VOTE_INCENTIVES).whitelistedTokens(TOWELI)
        );

        // ----- INV-4: ReferralSplitter setup is COMPLETE & SwapFeeRouter approved
        _expectTrue(
            "INV-4a referral.setupComplete()",
            IReferralSplitter_Verify(REFERRAL).setupComplete()
        );
        _expectTrue(
            "INV-4b referral.approvedCallers[SWAP_ROUTER]",
            IReferralSplitter_Verify(REFERRAL).approvedCallers(SWAP_ROUTER)
        );

        // ----- INV-5: ALL 9 V2 contracts owned by MULTISIG -------------------
        _expectEq("INV-5a staking.owner == MULTISIG", IOwnable_Verify(STAKING).owner(), MULTISIG);
        _expectEq("INV-5b voteInc.owner == MULTISIG", IOwnable_Verify(VOTE_INCENTIVES).owner(), MULTISIG);
        _expectEq("INV-5c restaking.owner == MULTISIG", IOwnable_Verify(RESTAKING).owner(), MULTISIG);
        _expectEq("INV-5d referral.owner == MULTISIG", IOwnable_Verify(REFERRAL).owner(), MULTISIG);
        _expectEq("INV-5e swapRouter.owner == MULTISIG", IOwnable_Verify(SWAP_ROUTER).owner(), MULTISIG);
        _expectEq("INV-5f grants.owner == MULTISIG", IOwnable_Verify(GRANTS).owner(), MULTISIG);
        _expectEq("INV-5g revDist.owner == MULTISIG", IOwnable_Verify(REV_DIST).owner(), MULTISIG);
        _expectEq("INV-5h bounty.owner == MULTISIG", IOwnable_Verify(BOUNTY).owner(), MULTISIG);
        _expectEq("INV-5i premium.owner == MULTISIG", IOwnable_Verify(PREMIUM).owner(), MULTISIG);

        // ----- INV-6: contracts are NOT paused at the moment of handover ----
        // (We expect a fresh deploy to be live; flip these expectations if a different
        // initial state is intended for this rollout.)
        _expectFalse("INV-6a staking !paused", IPausable_Verify(STAKING).paused());
        _expectFalse("INV-6b voteInc !paused", IPausable_Verify(VOTE_INCENTIVES).paused());
        _expectFalse("INV-6c revDist !paused", IPausable_Verify(REV_DIST).paused());
        _expectFalse("INV-6d grants !paused", IPausable_Verify(GRANTS).paused());

        // ----- Final tally ---------------------------------------------------
        console.log("");
        if (failures == 0) {
            console.log("=== ALL INVARIANTS PASS - ownership handover is SAFE ===");
        } else {
            console.log("=== FAIL COUNT:", failures);
            console.log("=== DO NOT TRANSFER OWNERSHIP OR ANNOUNCE LIVE UNTIL ALL INVARIANTS PASS");
            // Revert at the very end so CI can detect failure via exit code while still
            // logging every failing line above for the operator.
            revert("VERIFY_FAILED");
        }
    }

    // ---- helpers ----------------------------------------------------------
    function _expectEq(string memory label, address actual, address expected) private {
        if (actual == expected) {
            console.log(string.concat("  PASS: ", label));
        } else {
            console.log(string.concat("  FAIL: ", label));
            console.log("    expected:", expected);
            console.log("    actual:  ", actual);
            failures += 1;
        }
    }

    function _expectTrue(string memory label, bool actual) private {
        if (actual) {
            console.log(string.concat("  PASS: ", label));
        } else {
            console.log(string.concat("  FAIL: ", label));
            failures += 1;
        }
    }

    function _expectFalse(string memory label, bool actual) private {
        if (!actual) {
            console.log(string.concat("  PASS: ", label));
        } else {
            console.log(string.concat("  FAIL: ", label));
            failures += 1;
        }
    }
}
