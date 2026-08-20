// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  BaseChainConfig — the Base (8453) address book and the guards every
///         Base script runs before it touches anything.
/// @notice One file holds every Base-specific constant so that adding the chain is
///         a config read rather than a hunt through five scripts, and so a wrong
///         WETH or a wrong sequencer feed is wrong in exactly one place.
///
/// @dev    ADDRESS PROVENANCE. Nothing here was derived; each line is a published
///         canonical address that an operator MUST re-read on-chain before the
///         first broadcast (`cast code`, then `cast call` where a view exists):
///           - WETH        mirrors script/CheckCanonicalWETH.s.sol's Base entry.
///           - SEQUENCER   mirrors src/lib/SequencerCheck.sol's Base entry.
///         If either file's Base entry ever moves, this one is wrong and the
///         mismatch is a deploy-stopper, not a merge conflict to resolve by taste.
library BaseChainConfig {
    /// @notice Base mainnet. Every script in this directory refuses every other id.
    uint256 internal constant CHAIN_ID = 8453;

    /// @notice Canonical WETH9 on Base (the OP-stack predeploy).
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice Chainlink L2 Sequencer Uptime feed for Base.
    /// @dev    Not optional on this chain. SequencerCheck reverts
    ///         `SequencerFeedNotConfigured()` on any chainid != 1 that reads with a
    ///         zero feed, so a Base deploy that skipped the wiring would not fail at
    ///         deploy — it would fail at the first fee conversion, in production.
    address internal constant SEQUENCER_UPTIME_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;

    /// @notice Protocol fee on native-route swaps, in bps. Held identical to the
    ///         mainnet DeployMVP value on purpose: a per-chain fee is a pricing
    ///         decision, and this slice deploys the same economics or none.
    uint256 internal constant SWAP_FEE_BPS = 50;

    /// @notice Runtime size of an EIP-7702 delegation designator (0xef0100 + 20 bytes).
    /// @dev    Such an account has code and is still one key. TegridyFactory rejects it
    ///         explicitly in `proposeGuardianChange` (`codeLen != 23`); the role checks
    ///         here reject it for the same reason, so `code.length > 0` cannot be
    ///         satisfied by a delegated EOA dressed as a Safe.
    uint256 internal constant EIP7702_DESIGNATOR_LENGTH = 23;

    error NotBaseChain(uint256 actual);
    error NotAContract(string role, address account);
    error DelegatedEOA(string role, address account);
    error ZeroRole(string role);
    error RolesNotDisjoint(string roleA, string roleB, address shared);

    /// @dev The single line that makes a mainnet misfire impossible. Mirrors
    ///      DeployMVP's `require(block.chainid == 1)` in the opposite direction.
    function requireBaseChain() internal view {
        if (block.chainid != CHAIN_ID) revert NotBaseChain(block.chainid);
    }

    /// @dev A role that holds funds or keys must be a Safe, not an EOA and not a
    ///      typo. The Squads loss and the 0xA360 signer-set finding both start with
    ///      an address nobody proved. `code.length > 0` is the cheap half of that
    ///      proof; the runbook's "signers proven, nonce > 0" is the other half and
    ///      no script can check it.
    function requireSafe(address account, string memory role) internal view {
        if (account == address(0)) revert ZeroRole(role);
        uint256 codeLen = account.code.length;
        if (codeLen == 0) revert NotAContract(role, account);
        if (codeLen == EIP7702_DESIGNATOR_LENGTH) revert DelegatedEOA(role, account);
    }

    /// @dev Same presence check without the delegation rejection, for addresses that
    ///      are contracts but not custody roles — a Chainlink aggregator is neither a
    ///      Safe nor an EOA and the 23-byte test says nothing useful about it.
    function requireHasCode(address account, string memory role) internal view {
        if (account == address(0)) revert ZeroRole(role);
        if (account.code.length == 0) revert NotAContract(role, account);
    }

    function requireDisjoint(
        address a,
        string memory roleA,
        address b,
        string memory roleB
    ) internal pure {
        if (a == b) revert RolesNotDisjoint(roleA, roleB, a);
    }
}
