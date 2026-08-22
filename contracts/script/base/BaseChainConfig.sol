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

    // ─── Canonical Uniswap V4 stack on Base (graduation venue substrate) ─
    //
    // Provenance: Uniswap's own v4 deployments directory lists Base, and every
    // address below was re-read on-chain 2026-08-22 via https://mainnet.base.org:
    // PoolManager carries ~24,009 bytes of runtime code; PositionManager carries ~23,877
    // bytes of runtime code and its poolManager() returns the PoolManager below (cross-bound,
    // not just co-listed); Permit2 is the canonical CREATE2 singleton. Constants,
    // not env vars — an address baked into an immutable deserves better than an
    // operator paste.

    /// @notice Uniswap V4 PoolManager (singleton) on Base.
    address internal constant UNISWAP_V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    /// @notice Uniswap V4 PositionManager on Base.
    address internal constant UNISWAP_V4_POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;

    /// @notice Canonical Permit2.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Doppler's Airlock on Base (owner: the same 3-of-6 Whetstone Safe
    ///         as mainnet and 4663 — verified 2026-08-22). The graduation
    ///         migrator is an Airlock MODULE; launches cannot select it until
    ///         that Safe whitelists it via setModuleState(module, 4).
    address internal constant DOPPLER_AIRLOCK = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;

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


    error NotAnUptimeFeed(string role, address feed);

    /// @dev A feed that will be baked into immutables must speak the exact round
    ///      dialect SequencerCheck enforces, TODAY, before the broadcast — not
    ///      merely "have code" (a Safe has code). Mirrors SequencerCheck's gates:
    ///      160-byte latestRoundData, answer in {0,1}, initialized round
    ///      (updatedAt/startedAt non-zero), no future-dated clock, and the answer
    ///      not pre-dating its round. A target failing any of these would pass a
    ///      code-presence check and then revert every gated consumer in
    ///      production, unrecoverably where the slot is immutable.
    function requireUptimeDialect(address feed, string memory role) internal view {
        requireHasCode(feed, role);
        (bool ok, bytes memory data) = feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        if (!ok || data.length < 160) revert NotAnUptimeFeed(role, feed);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        if (answer != 0 && answer != 1) revert NotAnUptimeFeed(role, feed);
        if (updatedAt == 0 || startedAt == 0) revert NotAnUptimeFeed(role, feed);
        if (updatedAt > block.timestamp) revert NotAnUptimeFeed(role, feed);
        if (answeredInRound < roundId) revert NotAnUptimeFeed(role, feed);
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
