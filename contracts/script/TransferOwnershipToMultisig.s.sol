// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @dev Minimal Ownable2Step surface — every protocol contract that inherits
///      OwnableNoRenounce exposes these. We don't import the concrete contracts
///      to keep the script independent of contract source layout and trivially
///      replayable against future deploys.
interface IOwnable2Step {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @dev TegridyFactory uses a feeToSetter / propose-accept pattern instead of
///      Ownable2Step. Its admin role migrates via a separate 2-step flow.
interface ITegridyFactoryAuth {
    function feeToSetter() external view returns (address);
    function proposeFeeToSetter(address _newSetter) external;
}

/// @title  TransferOwnershipToMultisig — bulk-migrate every owner-controlled
///         protocol contract from the deployer EOA to a Safe multisig.
/// @notice This script handles ONLY the outgoing side of the 2-step transfer.
///         The Safe must subsequently call `acceptOwnership()` (or
///         `acceptFeeToSetter()` for TegridyFactory) within 14 days; build that
///         batch via the Safe Transaction Builder per
///         [docs/MULTISIG_MIGRATION.md § 6](../../docs/MULTISIG_MIGRATION.md).
///
/// @dev    Env vars (all optional EXCEPT MULTISIG — set address(0) or omit to
///         skip a contract):
///           MULTISIG                        — required, target Safe address
///           TEGRIDY_STAKING                 — Ownable2Step
///           TEGRIDY_STAKING_ADMIN           — Ownable2Step (sister; see § 7)
///           TEGRIDY_TWAP                    — Ownable2Step
///           REVENUE_DISTRIBUTOR             — Ownable2Step
///           REFERRAL_SPLITTER               — Ownable2Step
///           SWAP_FEE_ROUTER                 — Ownable2Step
///           SWAP_FEE_ROUTER_ADMIN           — Ownable2Step (sister; see § 7)
///           POL_ACCUMULATOR                 — Ownable2Step
///           TEGRIDY_LP_FARMING              — Ownable2Step (non-MVP)
///           GAUGE_CONTROLLER                — Ownable2Step (non-MVP)
///           VOTE_INCENTIVES                 — Ownable2Step (non-MVP)
///           TEGRIDY_LENDING                 — Ownable2Step (non-MVP)
///           TEGRIDY_NFT_LENDING             — Ownable2Step (non-MVP)
///           TEGRIDY_NFT_POOL_FACTORY        — Ownable2Step (non-MVP)
///           TEGRIDY_LAUNCHPAD_V2            — Ownable2Step (non-MVP)
///           COMMUNITY_GRANTS                — Ownable2Step (non-MVP)
///           MEME_BOUNTY_BOARD               — Ownable2Step (non-MVP)
///           PREMIUM_ACCESS                  — Ownable2Step (non-MVP)
///           TEGRIDY_FACTORY                 — feeToSetter pattern (special)
///
///         The TegridyFeeHook contract owner is the Arachnid CREATE2 proxy
///         (not the deployer); it requires a constructor patch + redeploy
///         BEFORE migration is even possible. NOT handled here.
///
/// @dev    Run as:
///           forge script script/TransferOwnershipToMultisig.s.sol \
///             --rpc-url $RPC --sender $DEPLOYER -vvv
///         Add `--broadcast --private-key $DEPLOYER_KEY` for the real run.
///         Dry-run first; read every line before adding --broadcast.
contract TransferOwnershipToMultisig is Script {
    /// @dev Sized to fit the full 22-contract inventory + a few buffer slots
    ///      for future contracts. The script iterates and skips address(0)
    ///      entries, so unused slots are harmless.
    uint256 constant MAX_CONTRACTS = 24;

    /// @dev Public so a foundry test can read the planned migration set
    ///      after `_collect()` runs in dry-run mode.
    address[MAX_CONTRACTS] public ownableContracts;
    string[MAX_CONTRACTS]  public ownableLabels;
    uint256 public ownableCount;

    address public factoryContract;

    address public multisig;

    /// @notice Forge script entrypoint. Wraps the migration in vm.startBroadcast()
    ///         so the deployer key from `--private-key` / `--account` signs every
    ///         transferOwnership call.
    function run() external {
        _loadConfig();
        _collect();
        _printPlan();
        _runPreChecks(msg.sender);

        vm.startBroadcast();
        _executeTransfers();
        vm.stopBroadcast();

        _printDone();
    }

    /// @notice Test-only entrypoint. Performs the same logic as `run()` but
    ///         without env-var reading or vm.startBroadcast. Caller passes the
    ///         inventory + multisig directly, and the script pranks as `sender`
    ///         around the actual transferOwnership calls so the mock contracts
    ///         see the correct msg.sender.
    /// @dev    Public so foundry tests can drive the migration logic
    ///         deterministically without env-var state bleeding across tests
    ///         or fighting vm.startBroadcast's prank semantics. The real script
    ///         entrypoint above remains the only way to actually move ownership
    ///         on mainnet.
    function runForTest(
        address sender,
        address _multisig,
        address[] memory _ownables,
        string[] memory _labels,
        address _factory
    ) external {
        require(_ownables.length == _labels.length, "ownables/labels length mismatch");
        require(_multisig != address(0), "MULTISIG required");
        require(_multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        // Wipe + repopulate inventory state from the explicit args.
        multisig = _multisig;
        ownableCount = 0;
        for (uint256 i = 0; i < _ownables.length; i++) {
            if (_ownables[i] == address(0)) continue;
            require(ownableCount < MAX_CONTRACTS, "ownable inventory overflow");
            ownableContracts[ownableCount] = _ownables[i];
            ownableLabels[ownableCount] = _labels[i];
            ownableCount++;
        }
        factoryContract = _factory;

        _runPreChecks(sender);

        // vm.startPrank persists across nested external calls FROM this
        // contract, so the transferOwnership / proposeFeeToSetter calls inside
        // _executeTransfers will see msg.sender == sender as intended.
        vm.startPrank(sender);
        _executeTransfers();
        vm.stopPrank();
    }

    /// @dev Idempotent — reload from env on every invocation so tests can mutate
    ///      env between calls.
    function _loadConfig() internal {
        multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");
        // Belt-and-suspenders: the SCRIPT shouldn't be the thing that
        // accidentally points at an EOA. The runbook's smoke-test in § 3.4
        // is the canonical check; this is a last-mile safety net.
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
    }

    function _runPreChecks(address sender) internal view {
        // Per-contract pre-check: every target MUST be currently owned by
        // the broadcaster. Catches typo'd env vars that point at random
        // contracts (which would still accept transferOwnership against
        // the wrong owner).
        for (uint256 i = 0; i < ownableCount; i++) {
            address c = ownableContracts[i];
            address currentOwner = IOwnable2Step(c).owner();
            require(
                currentOwner == sender,
                string.concat(
                    "owner() != sender on ",
                    ownableLabels[i],
                    " (",
                    vm.toString(c),
                    ") - current owner: ",
                    vm.toString(currentOwner)
                )
            );
        }
        if (factoryContract != address(0)) {
            address factorySetter = ITegridyFactoryAuth(factoryContract).feeToSetter();
            require(
                factorySetter == sender,
                string.concat(
                    "feeToSetter() != sender on TegridyFactory (",
                    vm.toString(factoryContract),
                    ") - current setter: ",
                    vm.toString(factorySetter)
                )
            );
        }
    }

    function _executeTransfers() internal {
        for (uint256 i = 0; i < ownableCount; i++) {
            address c = ownableContracts[i];
            IOwnable2Step(c).transferOwnership(multisig);
            console.log("transferOwnership ->", ownableLabels[i], c);
        }
        if (factoryContract != address(0)) {
            ITegridyFactoryAuth(factoryContract).proposeFeeToSetter(multisig);
            console.log("proposeFeeToSetter -> TegridyFactory", factoryContract);
        }
    }

    function _printPlan() internal view {
        console.log("");
        console.log("=== TransferOwnership Plan ===");
        console.log("Multisig target:", multisig);
        console.log("Ownable2Step contracts to migrate:", ownableCount);
        console.log("Factory contract (feeToSetter pattern):",
                    factoryContract == address(0) ? "skip" : "yes");
        console.log("");
    }

    function _printDone() internal pure {
        console.log("");
        console.log("=== Done ===");
        console.log("Multisig must now acceptOwnership / acceptFeeToSetter");
        console.log("within 14 days. Build the batch per");
        console.log("docs/MULTISIG_MIGRATION.md Section 6.");
    }

    /// @dev Populates the migration set from env vars. Each lookup defaults
    ///      to address(0), and address(0) entries are skipped — letting the
    ///      script work for partial-deploy scenarios (e.g. MVP scope only)
    ///      without code changes.
    ///      Idempotent: resets state on every call so test reruns and
    ///      partial-replay scenarios don't accumulate stale entries.
    function _collect() internal {
        ownableCount = 0;
        factoryContract = address(0);
        // Note: not clearing the trailing slots of ownableContracts/ownableLabels —
        // the iteration is bounded by ownableCount, so stale tail entries are unreached.

        // MVP scope (post-relaunch baseline).
        _addOwnable("TEGRIDY_STAKING",         "TegridyStaking");
        _addOwnable("TEGRIDY_STAKING_ADMIN",   "TegridyStakingAdmin");
        _addOwnable("TEGRIDY_TWAP",            "TegridyTWAP");
        _addOwnable("REVENUE_DISTRIBUTOR",     "RevenueDistributor");
        _addOwnable("REFERRAL_SPLITTER",       "ReferralSplitter");
        _addOwnable("SWAP_FEE_ROUTER",         "SwapFeeRouter");
        _addOwnable("SWAP_FEE_ROUTER_ADMIN",   "SwapFeeRouterAdmin");
        _addOwnable("POL_ACCUMULATOR",         "POLAccumulator");

        // Non-MVP / next-wave (set the env vars when these are live).
        _addOwnable("TEGRIDY_LP_FARMING",       "TegridyLPFarming");
        _addOwnable("GAUGE_CONTROLLER",         "GaugeController");
        _addOwnable("VOTE_INCENTIVES",          "VoteIncentives");
        _addOwnable("TEGRIDY_LENDING",          "TegridyLending");
        _addOwnable("TEGRIDY_NFT_LENDING",      "TegridyNFTLending");
        _addOwnable("TEGRIDY_NFT_POOL_FACTORY", "TegridyNFTPoolFactory");
        _addOwnable("TEGRIDY_LAUNCHPAD_V2",     "TegridyLaunchpadV2");
        _addOwnable("COMMUNITY_GRANTS",         "CommunityGrants");
        _addOwnable("MEME_BOUNTY_BOARD",        "MemeBountyBoard");
        _addOwnable("PREMIUM_ACCESS",           "PremiumAccess");

        // Special — feeToSetter rather than Ownable2Step.
        factoryContract = vm.envOr("TEGRIDY_FACTORY", address(0));
    }

    function _addOwnable(string memory envKey, string memory label) internal {
        address a = vm.envOr(envKey, address(0));
        if (a == address(0)) return;
        require(ownableCount < MAX_CONTRACTS, "ownable inventory overflow");
        ownableContracts[ownableCount] = a;
        ownableLabels[ownableCount] = label;
        ownableCount++;
    }
}
