// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../TegridyPair.sol";

/// @title  TegridyFactoryLib
/// @notice EIP-170 split: the bytecode-heavy ERC-777 detection probing AND the
///         TegridyPair CREATE2 deployment extracted from TegridyFactory into a linked
///         (delegatecall) library. PURE SIZE REDUCTION — behaviour byte-identical.
///         The detection tail is view-only/storage-free (the `blockedTokens` gate stays
///         host-side), and `deployPair` carries the ~11KB `type(TegridyPair).creationCode`
///         blob out of the host into the library's own bytecode — the dominant size win.
library TegridyFactoryLib {
    /// @notice CREATE2-deploy a fresh TegridyPair for the given salt.
    /// @dev    Called via DELEGATECALL from TegridyFactory, so the CREATE2 executor is the
    ///         Factory: the deterministic pair address (deployer = Factory) is byte-identical
    ///         to the prior in-line deployment, and the pair's constructor sees
    ///         `msg.sender == Factory` (it sets `factory = msg.sender`). Relocating the
    ///         `type(TegridyPair).creationCode` reference here moves the entire creation-code
    ///         blob into THIS library's bytecode rather than the Factory's.
    function deployPair(bytes32 salt) public returns (address pair) {
        bytes memory bytecode = type(TegridyPair).creationCode;
        // slither-disable-next-line assembly
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        require(pair != address(0), "CREATE2_FAILED");
    }

    /// @notice Best-effort ERC-777 rejection. Verbatim move of the detection tail of
    ///         `TegridyFactory._rejectERC777` (everything after the `blockedTokens` gate).
    /// @dev    A4-M-10: ERC-777 tokens have transfer callbacks enabling cross-contract
    ///         reentrancy with stale reserves. We probe ERC-165 supportsInterface for the
    ///         ERC-777 interface id (0xe58e113c), the mandatory `granularity()` selector,
    ///         and all three ERC-1820 hook interfaces. Every external staticcall is capped
    ///         at 30k gas (D-AMM-INFO2) so a malicious token cannot OOG-grief createPair.
    function assertNotERC777(address token) public view {
        // ERC-777 token interface ID = 0xe58e113c
        (bool ok, bytes memory result) = token.staticcall{gas: 30_000}(
            abi.encodeWithSelector(0x01ffc9a7, bytes4(0xe58e113c)) // supportsInterface(0xe58e113c)
        );
        if (ok && result.length >= 32) {
            bool supported = abi.decode(result, (bool));
            require(!supported, "ERC777_NOT_SUPPORTED");
        }
        // L-32: fail-closed on AMBIGUOUS short returndata (1..31 bytes) — a non-abi-compliant
        // token could return deliberately ambiguous data to slip past the gate.
        if (ok && result.length > 0 && result.length < 32) {
            revert("ERC777_NOT_SUPPORTED");
        }

        // granularity() — mandatory ERC-777 function absent from standard ERC-20.
        (bool grOk, bytes memory grResult) = token.staticcall{gas: 30_000}(
            abi.encodeWithSelector(bytes4(keccak256("granularity()")))
        );
        if (grOk && grResult.length >= 32) {
            revert("ERC777_NOT_SUPPORTED");
        }

        // NEW-A9: ERC-1820 exposes THREE hook interfaces — a token could register
        // ERC777TokensSender alone (fires on outgoing transfers) without the full
        // ERC777Token interface. Check all three to close the gap.
        address ERC1820_REGISTRY = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
        if (ERC1820_REGISTRY.code.length > 0) {
            bytes32[3] memory hashes = [
                keccak256("ERC777Token"),
                keccak256("ERC777TokensRecipient"),
                keccak256("ERC777TokensSender")
            ];
            for (uint256 i = 0; i < 3; i++) {
                (bool regOk, bytes memory regResult) = ERC1820_REGISTRY.staticcall{gas: 30_000}(
                    abi.encodeWithSelector(0xaabbb8ca, token, hashes[i]) // getInterfaceImplementer
                );
                if (regOk && regResult.length >= 32) {
                    address implementer = abi.decode(regResult, (address));
                    require(implementer == address(0), "ERC777_NOT_SUPPORTED");
                }
            }
        }
    }
}
