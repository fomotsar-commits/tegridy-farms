// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  NullBoost — the boost source for chains that have no TegridyStaking.
/// @notice TegridyLPFarming's constructor refuses a zero `_tegridyStaking`, and
///         every user action except emergencyWithdraw live-calls
///         `aggregateActiveBoostBps(user)` on it. On Ethereum mainnet that is
///         TegridyStaking and the answer is a veTOWELI-weighted boost. TOWELI is
///         fixed-supply and lives on mainnet only (standing rule), so on any other
///         chain there is nothing truthful for that call to measure.
///
///         This contract is the honest answer: every user, always, 0 bps — which
///         TegridyLPFarming floors to BASE_BOOST_BPS, i.e. a flat 1.0x for
///         everyone (TegridyLPFarming.sol's `aggBps <= BASE_BOOST_BPS` branch).
///         No roles, no storage, no owner, nothing to attack, nothing to rot. The
///         farm's audited bytecode ships unchanged; only its boost input is flat.
///
/// @dev    Deliberately NOT upgradeable and NOT configurable. If a chain ever
///         earns a real boost source, deploy a new farm pointing at it — a farm's
///         boost semantics changing under stakers' feet is a rug-shaped surprise
///         even when benign.
contract NullBoost {
    /// @notice The one function TegridyLPFarming consumes. 0 = no boost anywhere,
    ///         which the farm floors to a flat 1.0x for every staker.
    function aggregateActiveBoostBps(address) external pure returns (uint256) {
        return 0;
    }
}
