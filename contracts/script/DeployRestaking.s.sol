// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {TegridyRestakingAdmin} from "../src/TegridyRestakingAdmin.sol";
import {RestakingMonitorView} from "../src/RestakingMonitorView.sol";

/// @title  DeployRestaking — the Phase-7 restaking trio DeployMVP deliberately deferred
/// @notice Deploys `TegridyRestaking` + its two sisters and wires the admin pointer
///         before ownership leaves the deployer. Mirrors the staking trio's deploy
///         order in `DeployMVP.s.sol` (host first, sister second, one-shot wire third,
///         ownership last), because `setRestakingAdmin` is `onlyOwner` and one-shot:
///         handing ownership over before wiring costs a 48-hour rotation to recover.
///
/// @dev    RUN NOTHING FROM THIS FILE UNTIL THE EXTERNAL RE-AUDIT CLEARS. The split
///         this script deploys re-expressed previously-audited fund-touching bodies
///         (attribution credit, NFT rescue, residual-claimant write, sweep-to-staking)
///         across a new trust boundary. The audit gate is on the moved surface, not on
///         the size number.
///
/// @dev    Env: STAKING, STAKING_MONITOR_VIEW, TOWELI, BONUS_REWARD_TOKEN,
///         BONUS_REWARD_PER_SECOND (default 0), PAUSE_GUARDIAN, MULTISIG.
///
/// @dev    `BONUS_REWARD_PER_SECOND` defaults to ZERO on purpose. A non-zero rate at
///         construction starts the bonus clock the moment the first restaker arrives,
///         against a pool that has not been funded yet — every elapsed second would
///         emit a `BonusShortfall` and pay nothing. The operator sets the real rate
///         after funding, through the sister's 48-hour timelock. Funding must come
///         from realized protocol revenue.
contract DeployRestakingScript is Script {
    function run() external {
        address staking = vm.envAddress("STAKING");
        address stakingMonitorView = vm.envAddress("STAKING_MONITOR_VIEW");
        address toweli = vm.envAddress("TOWELI");
        address bonusRewardToken = vm.envAddress("BONUS_REWARD_TOKEN");
        uint256 bonusRewardPerSecond = vm.envOr("BONUS_REWARD_PER_SECOND", uint256(0));
        address pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        address multisig = vm.envAddress("MULTISIG");

        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(staking != address(0), "set STAKING");
        require(stakingMonitorView != address(0), "set STAKING_MONITOR_VIEW");
        require(toweli != address(0), "set TOWELI");
        require(bonusRewardToken != address(0), "set BONUS_REWARD_TOKEN");
        require(toweli != bonusRewardToken, "reward and bonus token must differ");
        require(multisig != address(0), "set MULTISIG");
        require(pauseGuardian != address(0), "set PAUSE_GUARDIAN");

        // A rail with no code deploys happily and then fails at the first user call.
        require(staking.code.length > 0, "STAKING has no code");
        require(stakingMonitorView.code.length > 0, "STAKING_MONITOR_VIEW has no code");
        require(toweli.code.length > 0, "TOWELI has no code");
        require(bonusRewardToken.code.length > 0, "BONUS_REWARD_TOKEN has no code");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        // PauseGuardian's threat model requires the guardian's signer set to be
        // disjoint from the owner's; address-level distinctness is the part a script
        // can check. The signer-set check is the operator's.
        require(pauseGuardian != multisig, "PAUSE_GUARDIAN must differ from MULTISIG");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);

        // 1. Host. Ships PAUSED-capable but unpaused; the operator pauses if needed.
        TegridyRestaking restaking =
            new TegridyRestaking(staking, stakingMonitorView, toweli, bonusRewardToken, bonusRewardPerSecond);
        console2.log("1. TegridyRestaking:      ", address(restaking));

        // 2. Admin sister. Constructor pins the host as `immutable`, so the host must
        //    exist first and the pair can never be re-pointed at a different host.
        TegridyRestakingAdmin restakingAdmin = new TegridyRestakingAdmin(address(restaking));
        console2.log("2. TegridyRestakingAdmin: ", address(restakingAdmin));

        // 3. One-shot wire, BEFORE ownership moves. After this the host's `applyXxx`
        //    hooks answer only to the sister.
        restaking.setRestakingAdmin(address(restakingAdmin));
        console2.log("3. restakingAdmin wired");

        // 4. Read-only sister. Holds no funds, has no privileged role. Frontends,
        //    indexers and monitors read pendingBonus / pendingBase / pendingTotal HERE.
        RestakingMonitorView restakingMonitorView = new RestakingMonitorView(address(restaking));
        console2.log("4. RestakingMonitorView:  ", address(restakingMonitorView));

        // 5. Pause guardian, also before ownership moves.
        restaking.setPauseGuardian(pauseGuardian);
        console2.log("5. pauseGuardian set:     ", pauseGuardian);

        // 6. Both contracts go to the same multisig. `onlyAdmin` on the host means
        //    "the wired sister"; `onlyOwner` on the sister means "the multisig".
        //    Transferring only one leaves a governance surface under the deployer key.
        restaking.transferOwnership(multisig);
        restakingAdmin.transferOwnership(multisig);
        console2.log("6. Ownership transfer initiated (both) to:", multisig);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership() on TegridyRestaking      ->", address(restaking));
        console2.log("2. MULTISIG.acceptOwnership() on TegridyRestakingAdmin ->", address(restakingAdmin));
        console2.log("   BOTH are required. Each contract's acceptOwnership flushes only its");
        console2.log("   OWN pending proposals; accepting one leaves the other's queued under");
        console2.log("   the outgoing owner.");
        console2.log("3. TegridyStakingAdmin.proposeRestakingContract(restaking) -> wait 48h ->");
        console2.log("   executeRestakingContract()");
        console2.log("4. RevenueDistributor: propose the RESTAKING_CHANGE -> wait 48h -> execute");
        console2.log("5. Fund the bonus pool via restaking.fundBonus(amount) BEFORE setting a");
        console2.log("   non-zero rate. Funding source must be realized protocol revenue.");
        console2.log("6. restakingAdmin.proposeBonusRate(rate) -> wait 48h -> executeBonusRateChange()");
        console2.log("7. Frontend: TEGRIDY_RESTAKING_ADDRESS  ->", address(restaking));
        console2.log("   Frontend: RESTAKING_MONITOR_VIEW      ->", address(restakingMonitorView));
        console2.log("");
        console2.log("=== INDEXER / MONITOR NOTE ===");
        console2.log("Governance *Proposed / *Cancelled events now come from the ADMIN address.");
        console2.log("Executions and every fund event stay on the HOST address.");
        console2.log("A filter bound to the host address alone will silently miss proposals.");
    }
}
