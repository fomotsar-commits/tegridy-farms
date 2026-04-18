// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Toweli — Tegridy Farms governance & revenue-accrual token
/// @notice Fixed-supply ERC-20 token for Tegridy Farms protocol. Immutable supply,
///         no mint function, no burn entrypoint, no pause, no blocklist, no owner.
///         EIP-2612 permit() support included for gasless approvals.
///
/// @dev Canonical deployment is `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` on
///      Ethereum Mainnet. The vanity address prefix (`0x420698`) was produced via
///      CREATE2 salt-mining pre-deployment — see docs/TOKEN_DEPLOY.md.
///
///      This source file documents the intended and deployed behavior. The live
///      bytecode is verified on Etherscan; always prefer the verified source on
///      Etherscan as the canonical reference if any divergence is observed:
///      https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#code
///
/// @dev Design goals:
///      1. Fixed 1,000,000,000 supply, minted once in constructor, sent to deployer.
///      2. No owner — token has no admin surface; there is nothing to rug.
///      3. No mint / burn / pause / blocklist — token is pure ERC-20 + permit.
///      4. Compatible with Uniswap V2 routing, standard DEX adapters, and
///         account abstraction flows via ERC-2612 permit.
contract Toweli is ERC20, ERC20Permit {
    /// @notice 1,000,000,000 TOWELI, fixed, in 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    /// @param recipient Address that receives the entire 1B TOWELI supply at deploy.
    ///                  Expected to be a multisig treasury that then distributes to
    ///                  LP seed, staking rewards, team, and community per the
    ///                  allocation in TOKENOMICS.md.
    constructor(address recipient)
        ERC20("Toweli", "TOWELI")
        ERC20Permit("Toweli")
    {
        require(recipient != address(0), "Toweli: zero recipient");
        _mint(recipient, TOTAL_SUPPLY);
    }
}
