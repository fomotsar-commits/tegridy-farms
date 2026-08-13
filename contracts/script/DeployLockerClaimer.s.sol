// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {LockerClaimer} from "../src/LockerClaimer.sol";

/// @title  DeployLockerClaimer — the address the Doppler fee locker can actually PAY
/// @notice LockerClaimer is live at 0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7 (deployed and
///         verified 2026-08-01) and is load-bearing for the entire Doppler protocol-fee line.
///         It had no deploy script: the live instance was deployed by hand, which means the
///         one thing that decides where every claimed wei goes — the constructor args — was
///         never reviewable, never re-runnable, and never guarded.
///
///         That gap matters more here than for any sibling. LockerClaimer has NO owner, NO
///         setters, NO proxy and NO selfdestruct; `locker`, `revenueDistributor` and `treasury`
///         are `immutable`. There is no post-deploy correction. A wrong constructor arg is not
///         a misconfiguration to fix later, it is a permanent, silent redirection of the fee
///         line to an address nobody chose — and the contract would look and behave completely
///         normally. "Check the constructor args once" is the whole audit, so this script is
///         where that check has to live.
///
/// @dev    Env: LOCKER (default = the live Doppler StreamableFeesLocker), REVENUE_DISTRIBUTOR,
///         TREASURY, SEQUENCER_FEED (optional — must be address(0) on mainnet),
///         REDEPLOY_ACK (required, see below).
///
/// @dev    Fleet-standard guards, matching DeployNFTLending / DeployNFTPoolFactory:
///         `block.chainid == 1`, a Safe-owner code check, and the mainnet sequencer-feed
///         assertion. The Safe check is repointed at TREASURY rather than at an owner, because
///         this contract has no owner — TREASURY is the only address here that must be the
///         Safe, and it is where every ERC20 fee leg lands forever.
contract DeployLockerClaimerScript is Script {
    /// @dev Doppler's StreamableFeesLocker. Verified against the deployed mainnet runtime on
    ///      2026-07-30 by selector scan: `releaseFees(uint256)` = 0x4a719bd4 present, alongside
    ///      the V1 `beneficiariesClaims(address,address)` shape — NOT the V2 `streams(bytes32)`
    ///      one. LockerClaimer's interface is written against V1 and would silently no-op or
    ///      revert against V2. Overridable via env so a fork test can point elsewhere; the
    ///      default is the address the live claimer was actually built against.
    address constant DOPPLER_FEE_LOCKER = 0xe24FC2F7191e850e2D4514aBb4d39305b1871eC6;

    /// @dev RELAUNCH 2026-06-06 sinks (frontend/src/lib/constants.ts, and the address registry).
    address constant REVENUE_DISTRIBUTOR = 0xF993316E2fC079de4358c489A935E01e03E23E17;
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;

    /// @dev The instance that is already live. Deploying a second one is not harmful on its own,
    ///      but it is never what you want by accident: the new one is wired to nothing, and two
    ///      plausible LockerClaimer addresses in the registry is exactly the confusion the
    ///      address-registry incident was about.
    address constant LIVE_LOCKER_CLAIMER = 0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7;

    function run() external {
        address locker = vm.envOr("LOCKER", DOPPLER_FEE_LOCKER);
        address revenueDistributor = vm.envOr("REVENUE_DISTRIBUTOR", REVENUE_DISTRIBUTOR);
        address treasury = vm.envOr("TREASURY", TREASURY);
        // L2 sequencer uptime feed. This contract consumes none — it has no oracle and no
        // staleness window — so the assertion exists purely to catch an L2-shaped env being run
        // against mainnet. Kept identical to the siblings on purpose: a guard that is present on
        // four scripts and absent on the fifth is the one that gets forgotten.
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));

        require(block.chainid == 1, "MAINNET_ONLY: the Doppler locker only exists on Ethereum mainnet");
        require(sequencerFeed == address(0), "mainnet: SEQUENCER_FEED must be address(0)");

        // Every destination is immutable, so each one gets checked before it is frozen.
        require(locker != address(0) && revenueDistributor != address(0) && treasury != address(0), "zero env");

        // A destination with no code is the failure that cannot be undone. All three are
        // contracts; an EOA here means a typo, and the ETH would be forwarded to it forever.
        require(locker.code.length > 0, "LOCKER has no code -- wrong address or wrong chain");
        require(revenueDistributor.code.length > 0, "REVENUE_DISTRIBUTOR has no code");
        require(treasury.code.length > 0, "TREASURY must be a contract (Safe)");

        // Distinctness. `_forwardETH` sends to revenueDistributor and `sweepToken` sends to
        // treasury; collapsing them silently sends the ETH leg somewhere it is not distributed,
        // and pointing either at the locker would loop the fee line back into its own source.
        require(revenueDistributor != treasury, "REVENUE_DISTRIBUTOR == TREASURY -- the ETH and ERC20 legs must differ");
        require(locker != revenueDistributor && locker != treasury, "LOCKER collides with a payout destination");

        // RevenueDistributor is ETH-only: it distributes `address(this).balance`, so an ERC20
        // pushed into it is invisible to the distribution loop. That is why the token leg goes
        // to the Safe. Assert the ETH sink can actually receive — a destination that reverts on
        // a bare `call` bricks every claim, and `claim` reverts the locker release with it.
        (bool ethSinkAccepts,) = revenueDistributor.call{value: 0}("");
        require(ethSinkAccepts, "REVENUE_DISTRIBUTOR rejects a plain ETH call -- claim() would always revert");

        // One live instance already exists. Make a second deploy a decision, not an accident.
        if (LIVE_LOCKER_CLAIMER.code.length > 0) {
            require(
                vm.envOr("REDEPLOY_ACK", false),
                "A LockerClaimer is ALREADY LIVE at 0xD2Ac3dC1... Set REDEPLOY_ACK=true to deploy a SECOND one. The new one is wired to nothing until a beneficiary slot is migrated to it via the locker's updateBeneficiary."
            );
        }

        console2.log("=== Deploying LockerClaimer ===");
        console2.log("Locker (Doppler):    ", locker);
        console2.log("ETH   -> RevenueDistributor:", revenueDistributor);
        console2.log("ERC20 -> Treasury Safe:     ", treasury);

        vm.startBroadcast();
        console2.log("Deployer:            ", msg.sender);
        LockerClaimer claimer = new LockerClaimer(locker, revenueDistributor, treasury);
        console2.log("LockerClaimer deployed:", address(claimer));
        vm.stopBroadcast();

        // Read the immutables back OUT OF THE DEPLOYED CODE. The constructor could not have
        // stored anything else, but this is the one contract where "we passed the right args"
        // and "the right args are what is frozen in the bytecode" should not be assumed to be
        // the same statement, and the assertion costs nothing.
        require(address(claimer.locker()) == locker, "readback: locker mismatch");
        require(claimer.revenueDistributor() == revenueDistributor, "readback: revenueDistributor mismatch");
        require(claimer.treasury() == treasury, "readback: treasury mismatch");
        console2.log("Immutables read back from the deployed contract: OK");

        console2.log("");
        console2.log("=== NEXT (operator) ===");
        console2.log("1. Verify on Etherscan, then read locker()/revenueDistributor()/treasury() on-chain");
        console2.log("   -- from the explorer, not from this log. There is no owner and no setter:");
        console2.log("   if any of the three is wrong, the only fix is a redeploy.");
        console2.log("2. Register the address in frontend/scripts/addresses.json (CI fails until you do)");
        console2.log("3. Set LOCKER_CLAIMER_ADDRESS in frontend/src/lib/constants.ts ->", address(claimer));
        console2.log("4. Flip launchService.protocolFeeSink() to it. That governs FUTURE launches only --");
        console2.log("   a launch's beneficiary set is fixed at create time and no admin can rewrite it.");
        console2.log("5. For launches that ALREADY exist: Treasury (as the current beneficiary) calls the");
        console2.log("   locker's updateBeneficiary(tokenId, newBeneficiary) per position. One Safe tx each.");
        console2.log("   LockerClaimer deliberately cannot call it -- a fee sink that can re-point itself");
        console2.log("   is a rug vector, so that lever stays with the Safe.");
    }
}
