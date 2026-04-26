// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @title CheckCanonicalWETH — Audit R032 post-deploy invariant script
/// @notice Asserts that every deployed Tegriddy contract that stores a `weth` (or `WETH`)
///         immutable points at the canonical WETH9 for the active chain. Run after every
///         mainnet / fork / L2 deploy as the final smoke check before the multisig accepts
///         ownership.
///
///         Per-chain canonical WETH9:
///           - Ethereum mainnet (1):     0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
///           - Optimism (10):            0x4200000000000000000000000000000000000006
///           - Arbitrum One (42161):     0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
///           - Base (8453):              0x4200000000000000000000000000000000000006
///           - Sepolia (11155111):       0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
///         Other / unknown chain ids are accepted but require an explicit
///         `--sig 'check(address,address[])'` invocation passing the expected fork WETH.
///
/// @dev    Usage examples:
///           forge script script/CheckCanonicalWETH.s.sol --rpc-url $MAINNET_RPC --sig 'run(address[])' '[<addr1>,<addr2>,...]'
///           forge script script/CheckCanonicalWETH.s.sol --rpc-url $FORK_RPC --sig 'check(address,address[])' '0x<forkWeth>' '[<addrs>]'
contract CheckCanonicalWETH is Script {
    error WrongWETH(address contractAddr, address actual, address expected);
    error UnknownChain(uint256 chainId);

    /// @notice WETH wrapper interface plus optional helpers. We probe the wrapper directly
    ///         (it must be the canonical WETH9) and every passed contract must expose
    ///         either a `weth()` or `WETH()` view returning the address it stores.
    function _canonicalWETHForChain(uint256 chainId) internal pure returns (address) {
        if (chainId == 1) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        if (chainId == 10) return 0x4200000000000000000000000000000000000006;
        if (chainId == 42161) return 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
        if (chainId == 8453) return 0x4200000000000000000000000000000000000006;
        if (chainId == 11155111) return 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
        return address(0);
    }

    function run(address[] calldata deployments) external view {
        address expected = _canonicalWETHForChain(block.chainid);
        if (expected == address(0)) revert UnknownChain(block.chainid);
        check(expected, deployments);
    }

    function check(address expected, address[] calldata deployments) public view {
        for (uint256 i = 0; i < deployments.length; i++) {
            address d = deployments[i];
            address stored = _readWETH(d);
            if (stored != expected) revert WrongWETH(d, stored, expected);
            console2.log("OK", d, stored);
        }
    }

    /// @dev Tries `weth()` first (returns address), then `WETH()` (returns address).
    ///      A contract that stores neither view will revert here, which is the
    ///      correct outcome — the operator should not blindly accept it.
    function _readWETH(address d) internal view returns (address) {
        (bool ok, bytes memory ret) = d.staticcall(abi.encodeWithSignature("weth()"));
        if (ok && ret.length == 32) return abi.decode(ret, (address));
        (ok, ret) = d.staticcall(abi.encodeWithSignature("WETH()"));
        require(ok && ret.length == 32, "NO_WETH_VIEW");
        return abi.decode(ret, (address));
    }
}
