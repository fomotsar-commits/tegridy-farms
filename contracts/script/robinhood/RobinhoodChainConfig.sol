// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  RobinhoodChainConfig — the Robinhood Chain (4663) address book and the
///         guards every Robinhood script runs before it touches anything.
/// @notice One file holds every chain-specific constant so that adding the chain is
///         a config read rather than a hunt through five scripts, and so a wrong
///         WETH is wrong in exactly one place. Mirrors script/base/BaseChainConfig.sol
///         verbatim except where this chain genuinely differs — and it differs in
///         exactly one load-bearing way, documented at NO_CHAINLINK_UPTIME_FEED.
///
/// @dev    ADDRESS PROVENANCE. Nothing here was derived; each line was re-read
///         on-chain 2026-08-20 against https://rpc.mainnet.chain.robinhood.com
///         (block 42,788,875):
///           - CHAIN_ID    cast chain-id → 4663 (matches docs.robinhood.com/chain
///                         and the Doppler SDK's CHAIN_IDS.ROBINHOOD).
///           - WETH        cast call symbol()/decimals()/name() → "WETH" / 18 /
///                         "WETH" (matches docs.robinhood.com/chain/contracts and
///                         the Doppler SDK address book for 4663).
///         Safe infrastructure verified the same way: Safe 1.4.1 ProxyFactory,
///         1.3.0 ProxyFactory, and the 1.4.1 L2 singleton all carry code at their
///         canonical addresses, so the four-Safe role ceremony is possible on this
///         chain. An operator MUST re-run those reads before the first broadcast.
library RobinhoodChainConfig {
    /// @notice Robinhood Chain mainnet. Every script in this directory refuses
    ///         every other id — including the 46630 testnet.
    uint256 internal constant CHAIN_ID = 4663;

    /// @notice Canonical WETH9 on Robinhood Chain (Arbitrum Orbit; ETH is the gas
    ///         token, so the ETH-denominated fee caps across the launch rail keep
    ///         their intended meaning).
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @notice THERE IS NO CHAINLINK SEQUENCER UPTIME FEED ON THIS CHAIN (checked
    ///         against Chainlink's L2 sequencer feeds directory 2026-08-20 — Base,
    ///         Arbitrum One, OP et al. are listed; Robinhood Chain is not).
    ///
    ///         This is not a footnote. SequencerCheck reverts
    ///         `SequencerFeedNotConfigured()` on any chainid != 1 that reads with a
    ///         zero feed, so with no feed at all: SwapFeeRouter fee conversion,
    ///         TegridyTWAP update/consult, and every TegridyDropV2 dutch-auction
    ///         mint would revert in production, forever.
    ///
    ///         The leg therefore deploys src/AttestedSequencerUptimeFeed.sol — a
    ///         guardian-attested feed speaking the exact Chainlink dialect, one-shot
    ///         re-pointable to the real Chainlink feed the day one ships — and every
    ///         consumer here is constructed against THAT address. Scripts take the
    ///         feed as config rather than a constant precisely because it is a
    ///         deployment, not a known address.
    ///
    ///         Residual risk, stated honestly: attestation is manual. If the
    ///         attestor (the PAUSE_GUARDIAN hot Safe) sleeps through a real
    ///         sequencer outage, consumers get no post-resume grace window. That is
    ///         weaker than Chainlink automation and stronger than no gate at all,
    ///         and it ends the day `forwardTo(chainlinkFeed)` is called.

    /// @notice Protocol fee on native-route swaps, in bps. Held identical to the
    ///         mainnet DeployMVP value on purpose: a per-chain fee is a pricing
    ///         decision, and this leg deploys the same economics or none.
    uint256 internal constant SWAP_FEE_BPS = 50;

    // ─── Canonical Uniswap V4 stack on 4663 (graduation venue substrate) ─
    //
    // Provenance: Uniswap's own v4 deployments directory (developers.uniswap.org)
    // lists Robinhood Chain, and every address below was re-read on-chain
    // 2026-08-22: PoolManager carries ~24,010 bytes of runtime code and is the SAME
    // address Doppler's UniswapV4Initializer reports via poolManager();
    // PositionManager carries ~23,878 bytes of runtime code and its poolManager() returns the
    // PoolManager below (cross-bound, not just co-listed); Permit2 is the
    // canonical CREATE2 singleton. These are constants, not env vars, for the
    // same reason WETH is: an address that gets baked into an immutable
    // deserves better than an operator paste.

    /// @notice Uniswap V4 PoolManager (singleton) on Robinhood Chain.
    address internal constant UNISWAP_V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// @notice Uniswap V4 PositionManager on Robinhood Chain.
    address internal constant UNISWAP_V4_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @notice Canonical Permit2.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Doppler's Airlock on Robinhood Chain (owner: the same 3-of-6
    ///         Whetstone Safe as mainnet/Base — verified 2026-08-22). The
    ///         graduation migrator is an Airlock MODULE; launches cannot select
    ///         it until that Safe whitelists it via setModuleState(module, 4).
    address internal constant DOPPLER_AIRLOCK = 0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862;

    /// @notice Runtime size of an EIP-7702 delegation designator (0xef0100 + 20 bytes).
    /// @dev    Such an account has code and is still one key. TegridyFactory rejects it
    ///         explicitly in `proposeGuardianChange` (`codeLen != 23`); the role checks
    ///         here reject it for the same reason, so `code.length > 0` cannot be
    ///         satisfied by a delegated EOA dressed as a Safe.
    uint256 internal constant EIP7702_DESIGNATOR_LENGTH = 23;

    error NotRobinhoodChain(uint256 actual);
    error NotAContract(string role, address account);
    error DelegatedEOA(string role, address account);
    error ZeroRole(string role);
    error RolesNotDisjoint(string roleA, string roleB, address shared);

    /// @dev The single line that makes a mainnet (or testnet) misfire impossible.
    ///      Mirrors DeployMVP's `require(block.chainid == 1)` in the opposite direction.
    function requireRobinhoodChain() internal view {
        if (block.chainid != CHAIN_ID) revert NotRobinhoodChain(block.chainid);
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
    ///      are contracts but not custody roles — an uptime feed is neither a Safe
    ///      nor an EOA and the 23-byte test says nothing useful about it.
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
