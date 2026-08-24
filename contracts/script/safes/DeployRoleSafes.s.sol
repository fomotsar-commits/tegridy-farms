// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

/// @title  DeployRoleSafes — the 4 role Safes a launchpad chain needs (Base / Robinhood).
/// @notice Deploys the Treasury / Multisig / Pause-Guardian / Fee-Remittance Safes at
///         DETERMINISTIC addresses through the canonical Safe 1.4.1 SafeProxyFactory, so the
///         SAME four addresses land on every chain this script runs on (the CREATE2 address
///         is a function of the factory + initializer + per-role salt — none of which depend
///         on the deployer, so the sender's wallet doesn't change them either). Each is a
///         2-of-2 Safe with the operator wallet + a mainnet signer.
///
/// @dev    Idempotent-by-revert: re-running on a chain where these already exist reverts on
///         the Create2 collision (the proxy is already there) — a loud "already deployed",
///         not a duplicate. The SafeL2 singleton (not the plain Safe) is used because these
///         are L2s and Safe's indexers/UI expect the event-emitting L2 variant.
///
/// @dev    Run (no --broadcast = simulation that prints the four addresses):
///           forge script script/safes/DeployRoleSafes.s.sol --rpc-url $BASE_RPC -vvv
///         Deploy for real (signing + gas are the operator's):
///           forge script script/safes/DeployRoleSafes.s.sol --rpc-url $BASE_RPC --broadcast --interactives 1
///         Then repeat with $ROBINHOOD_RPC — the four addresses come out identical.
contract DeployRoleSafes is Script {
    // Canonical Safe 1.4.1 — identical address on every EVM chain (verified live on
    // Base 8453 + Robinhood 4663, 2026-08-24: all three carry code).
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    // 2-of-2 owners: the operator deploy wallet + a mainnet Treasury Safe signer.
    address internal constant OWNER_1 = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address internal constant OWNER_2 = 0x28d7CB2F4D73C2750Ba0055c771871fec79260f8;
    uint256 internal constant THRESHOLD = 2;

    function run() external {
        require(SAFE_PROXY_FACTORY.code.length > 0, "S-1: no SafeProxyFactory on this chain");
        require(SAFE_L2_SINGLETON.code.length > 0, "S-2: no SafeL2 singleton on this chain");
        require(FALLBACK_HANDLER.code.length > 0, "S-3: no fallback handler on this chain");

        address[] memory owners = new address[](2);
        owners[0] = OWNER_1;
        owners[1] = OWNER_2;
        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (owners, THRESHOLD, address(0), hex"", FALLBACK_HANDLER, address(0), uint256(0), address(0))
        );

        vm.startBroadcast();
        address treasury = _deploy("TREASURY", initializer);
        address multisig = _deploy("MULTISIG", initializer);
        address guardian = _deploy("PAUSE_GUARDIAN", initializer);
        address feeRemit = _deploy("FEE_REMITTANCE", initializer);
        vm.stopBroadcast();

        console2.log("=== Role Safes deployed on chainid ===", block.chainid);
        console2.log("TREASURY:       ", treasury);
        console2.log("MULTISIG:       ", multisig);
        console2.log("PAUSE_GUARDIAN: ", guardian);
        console2.log("FEE_REMITTANCE: ", feeRemit);
        console2.log("2-of-2 owner:   ", OWNER_1);
        console2.log("2-of-2 owner:   ", OWNER_2);
        console2.log("These four addresses are IDENTICAL on every chain this runs on.");
        console2.log("Feed them to DeployBase/RobinhoodMVP as TREASURY/MULTISIG/PAUSE_GUARDIAN/FEE_REMITTANCE.");
    }

    function _deploy(string memory role, bytes memory initializer) internal returns (address safe) {
        // Per-role salt → four distinct deterministic addresses. Versioned so a future
        // owner-set change deploys at fresh addresses instead of colliding.
        uint256 salt = uint256(keccak256(abi.encodePacked("TEGRIDY_ROLE_SAFE_v1:", role)));
        safe = ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(
            SAFE_L2_SINGLETON, initializer, salt
        );
        // Read-back: a real, working Safe with exactly our owners + threshold.
        require(ISafe(safe).getThreshold() == THRESHOLD, "S-4: threshold mismatch");
        require(ISafe(safe).getOwners().length == 2, "S-5: owner count mismatch");
        require(ISafe(safe).isOwner(OWNER_1) && ISafe(safe).isOwner(OWNER_2), "S-6: owner mismatch");
    }
}
