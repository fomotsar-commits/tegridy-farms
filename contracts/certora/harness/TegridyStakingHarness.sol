// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TegridyStaking} from "../../src/TegridyStaking.sol";

/// @title  TegridyStakingHarness — Certora FV deployment harness
/// @notice Thin wrapper around `TegridyStaking` for Certora's prover. The
///         pattern matches OpenZeppelin's `fv/harnesses/AccessControlHarness.sol`
///         (`contracts/lib/openzeppelin-contracts/fv/harnesses/...`): the
///         harness exists only so the Certora frontend has a concrete
///         deployable contract to instantiate. No state or behaviour is
///         added or removed here — the production contract IS what is
///         being verified.
///
///         If, during engagement, the Certora team needs additional
///         internal-getter exposure for any of the 6 rules in
///         `certora/specs/TegridyStaking.spec`, those getters get added
///         here (NOT in the production contract). Keep the harness purely
///         additive.
contract TegridyStakingHarness is TegridyStaking {
    /// @param _toweli  TOWELI ERC20 stake token
    /// @param _jbac    JungleBay NFT contract (boost source)
    /// @param _treasury Protocol revenue treasury
    /// @param _rewardRate Initial reward rate (wei/sec)
    constructor(address _toweli, address _jbac, address _treasury, uint256 _rewardRate)
        TegridyStaking(_toweli, _jbac, _treasury, _rewardRate)
    {}
}
