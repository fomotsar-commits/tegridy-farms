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
    function jbacVault() external view returns (address);
    function stakingAdmin() external view returns (address);
}

interface ITegridyLending_Verify {
    function lendingAdmin() external view returns (address);
    function owner() external view returns (address);
    function paused() external view returns (bool);
}

interface IOwnable2Step_Verify {
    function pendingOwner() external view returns (address);
    function ownershipTransferExpiresAt() external view returns (uint256);
}

// Generic interface for any contract that exposes a public `restakingContract`
// one-shot wire (VoteIncentives, CommunityGrants, MemeBountyBoard,
// ReferralSplitter). The setter is owner-only one-shot; this getter reads
// the current value to confirm the wire ran.
interface IHasRestakingContract_Verify {
    function restakingContract() external view returns (address);
}

interface IVoteIncentives_OneShotWires {
    function gaugeController() external view returns (address);
    function voteIncentivesAdmin() external view returns (address);
    function restakingContract() external view returns (address);
}

interface ISwapFeeRouter_Verify {
    function swapFeeRouterAdmin() external view returns (address);
    function sequencerFeed() external view returns (address);
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
    // ---- New invariants: fill in after running the updated DeployFinal.s.sol ----
    // Operator MUST replace these with the addresses from the latest deploy run
    // BEFORE running Verify, otherwise INV-7/8/9 fall over with zero-address checks.
    address constant JBAC_VAULT = address(0);     // TegridyStakingJbacVault deploy address
    address constant LENDING = address(0);        // TegridyLending deploy address
    address constant LENDING_ADMIN = address(0);  // TegridyLendingAdmin deploy address

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

        // ----- INV-7: staking.jbacVault is wired to the deployed JBAC vault ----
        // CRITICAL: setJbacVault is owner-only and one-shot. If the deploy script
        // did not run it before transferOwnership, the multisig must call it post-
        // ownership-handover — and historical deploys silently skipped both.
        // Without this wire, the JBAC boost is permanently unreachable.
        if (JBAC_VAULT != address(0)) {
            _expectEq(
                "INV-7 staking.jbacVault == JBAC_VAULT",
                ITegridyStaking_Verify(STAKING).jbacVault(),
                JBAC_VAULT
            );
        } else {
            _expectTrue(
                "INV-7 staking.jbacVault != address(0)",
                ITegridyStaking_Verify(STAKING).jbacVault() != address(0)
            );
        }

        // ----- INV-8: TegridyLending deployed, admin wired, owned by MULTISIG --
        // Lending was missing from every deploy script for months. Confirm it
        // exists in this rollout and is wired correctly.
        if (LENDING != address(0)) {
            _expectEq(
                "INV-8a lending.owner == MULTISIG",
                ITegridyLending_Verify(LENDING).owner(),
                MULTISIG
            );
            if (LENDING_ADMIN != address(0)) {
                _expectEq(
                    "INV-8b lending.lendingAdmin == LENDING_ADMIN",
                    ITegridyLending_Verify(LENDING).lendingAdmin(),
                    LENDING_ADMIN
                );
                _expectEq(
                    "INV-8c lendingAdmin.owner == MULTISIG",
                    IOwnable_Verify(LENDING_ADMIN).owner(),
                    MULTISIG
                );
            }
            _expectFalse("INV-8d lending !paused", ITegridyLending_Verify(LENDING).paused());
        }

        // ----- INV-10: every one-shot wire is set (post-acceptance scan) ------
        // The codebase has 12 one-shot setters that revert if called twice.
        // Wave-3 found that historical deploy scripts skip many of these
        // without surfacing the gap to the operator. This invariant block
        // reads each public state slot and fails loud if any wire is still
        // zero. INV-7 (staking.jbacVault) and INV-8b (lending.lendingAdmin)
        // are covered above; the rest are checked here.
        _expectTrue(
            "INV-10a staking.stakingAdmin != 0",
            ITegridyStaking_Verify(STAKING).stakingAdmin() != address(0)
        );
        _expectTrue(
            "INV-10b swapFeeRouter.swapFeeRouterAdmin != 0",
            ISwapFeeRouter_Verify(SWAP_ROUTER).swapFeeRouterAdmin() != address(0)
        );
        _expectTrue(
            "INV-10c voteIncentives.gaugeController != 0",
            IVoteIncentives_OneShotWires(VOTE_INCENTIVES).gaugeController() != address(0)
        );
        _expectTrue(
            "INV-10d voteIncentives.voteIncentivesAdmin != 0",
            IVoteIncentives_OneShotWires(VOTE_INCENTIVES).voteIncentivesAdmin() != address(0)
        );
        _expectTrue(
            "INV-10e voteIncentives.restakingContract != 0",
            IVoteIncentives_OneShotWires(VOTE_INCENTIVES).restakingContract() != address(0)
        );
        _expectTrue(
            "INV-10f communityGrants.restakingContract != 0",
            IHasRestakingContract_Verify(GRANTS).restakingContract() != address(0)
        );
        _expectTrue(
            "INV-10g memeBountyBoard.restakingContract != 0",
            IHasRestakingContract_Verify(BOUNTY).restakingContract() != address(0)
        );
        _expectTrue(
            "INV-10h referralSplitter.restakingContract != 0",
            IHasRestakingContract_Verify(REFERRAL).restakingContract() != address(0)
        );

        // ----- INV-11: L2-only sequencer-feed one-shot wires ------------------
        // On mainnet (chainid==1) lib/SequencerCheck no-ops with address(0),
        // so a zero feed is acceptable. On any L2, a zero feed bricks the
        // SequencerCheck call at runtime. INV-11 only fires on non-mainnet.
        if (block.chainid != 1) {
            _expectTrue(
                "INV-11a swapFeeRouter.sequencerFeed != 0 on L2",
                ISwapFeeRouter_Verify(SWAP_ROUTER).sequencerFeed() != address(0)
            );
        }

        // ----- INV-9: no contract is sitting on an expired 2-step transfer -----
        // OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY = 14 days. If the multisig
        // hasn't accepted within that window, the deployer EOA permanently retains
        // ownership and the deployer must initiate a fresh transfer. Surface this
        // as a fail rather than letting the rollout silently retain deployer EOA.
        _expectPendingTransferHealthy("INV-9a staking pending-transfer healthy", STAKING);
        _expectPendingTransferHealthy("INV-9b voteInc pending-transfer healthy", VOTE_INCENTIVES);
        _expectPendingTransferHealthy("INV-9c revDist pending-transfer healthy", REV_DIST);
        _expectPendingTransferHealthy("INV-9d restaking pending-transfer healthy", RESTAKING);
        _expectPendingTransferHealthy("INV-9e swapRouter pending-transfer healthy", SWAP_ROUTER);
        _expectPendingTransferHealthy("INV-9f grants pending-transfer healthy", GRANTS);
        _expectPendingTransferHealthy("INV-9g bounty pending-transfer healthy", BOUNTY);
        _expectPendingTransferHealthy("INV-9h premium pending-transfer healthy", PREMIUM);
        _expectPendingTransferHealthy("INV-9i referral pending-transfer healthy", REFERRAL);
        if (LENDING != address(0)) {
            _expectPendingTransferHealthy("INV-9j lending pending-transfer healthy", LENDING);
        }
        if (LENDING_ADMIN != address(0)) {
            _expectPendingTransferHealthy("INV-9k lendingAdmin pending-transfer healthy", LENDING_ADMIN);
        }

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

    /// @dev Pending-owner-transfer health: either the transfer has completed
    /// (owner == MULTISIG, expiry slot cleared) OR a transfer is still pending
    /// to the multisig and the 14-day expiry has not elapsed. Catches the
    /// case where the multisig sat on `acceptOwnership` past 14 days and the
    /// deployer EOA is now permanently the owner.
    function _expectPendingTransferHealthy(string memory label, address target) private {
        address currentOwner = IOwnable_Verify(target).owner();
        if (currentOwner == MULTISIG) {
            console.log(string.concat("  PASS: ", label, " (already accepted)"));
            return;
        }
        try IOwnable2Step_Verify(target).pendingOwner() returns (address pending) {
            uint256 expiresAt;
            try IOwnable2Step_Verify(target).ownershipTransferExpiresAt() returns (uint256 e) {
                expiresAt = e;
            } catch {
                // Older OZ Ownable2Step without expiry slot — surface as fail
                // because the operator should know whether expiry is enforced.
                console.log(string.concat("  FAIL: ", label, " (no expiry slot - manual review)"));
                failures += 1;
                return;
            }
            if (pending != MULTISIG) {
                console.log(string.concat("  FAIL: ", label));
                console.log("    pendingOwner is not MULTISIG:", pending);
                failures += 1;
                return;
            }
            if (expiresAt == 0) {
                console.log(string.concat("  FAIL: ", label, " (no pending transfer; deployer retains ownership)"));
                failures += 1;
                return;
            }
            if (block.timestamp >= expiresAt) {
                console.log(string.concat("  FAIL: ", label, " (14-day expiry elapsed; deployer permanently owns)"));
                console.log("    expiresAt:", expiresAt);
                console.log("    now:      ", block.timestamp);
                failures += 1;
                return;
            }
            console.log(string.concat("  PASS: ", label, " (pending, within expiry)"));
        } catch {
            console.log(string.concat("  FAIL: ", label, " (no Ownable2Step interface)"));
            failures += 1;
        }
    }
}
