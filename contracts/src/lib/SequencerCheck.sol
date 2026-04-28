// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal subset of the Chainlink AggregatorV3Interface that L2 Sequencer
///         Uptime Feeds expose. We only need `latestRoundData()`.
/// @dev    Reference: https://docs.chain.link/data-feeds/l2-sequencer-feeds
interface IChainlinkAggregator {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @title SequencerCheck — L2 Sequencer Uptime gating helper
/// @notice Library that lets price-sensitive consumers (TWAP consumers, LP harvesters,
///         dutch-auction price readers, lending grace-windows) refuse to read prices
///         when the L2 sequencer has been down or has just resumed within a grace
///         period. Without this, the moment a sequencer resumes after an outage all
///         AMM/oracle prices reflect the pre-outage state and an attacker can either
///         (a) buy/sell at stale prices before the chain catches up or (b) trigger
///         time-window checks (lending grace, drop dutch decay, bounty force-cancel)
///         that elapsed entirely while the chain was unavailable.
///
/// @dev    Battle-tested model: Aave V3 PriceOracleSentinel (`isAnswerNotStale`).
///         Spec: Chainlink L2 Sequencer Uptime Feeds. The feed returns:
///           - `answer == 0` → sequencer is up
///           - `answer == 1` → sequencer is down OR was down recently
///           - `startedAt`   → block.timestamp when the current `answer` was set;
///                             used to enforce a post-resume grace window during which
///                             oracle reads are still rejected so AMM reserves /
///                             cumulative-price observations have time to refresh.
///
/// Per-chain feed addresses (canonical, immutable post-deploy):
///   - Ethereum mainnet (no sequencer):     address(0)  → no-op
///   - Arbitrum One:    0xFdB631F5EE196F0ed6FAa767959853A9F217697D
///   - Optimism:        0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389
///   - Base:            0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
///
/// Consumers MUST store the feed address as `immutable` (single-write, set in
/// constructor) and pass `address(0)` for chains without an L2 sequencer.
library SequencerCheck {
    /// @dev Reverted when the sequencer is currently reporting "down" (answer == 1).
    error SequencerDown();

    /// @dev Reverted when the sequencer just resumed but the post-resume grace window
    ///      has not yet elapsed. Lets AMM reserves / TWAP observations refresh before
    ///      consumers trust the price.
    error SequencerGracePeriodNotOver();

    /// @notice Revert if the L2 sequencer is down or within `gracePeriod` of resume.
    /// @dev    Pass `feed == address(0)` to no-op (Ethereum mainnet and any chain
    ///         without a sequencer concept). `gracePeriod` is the buffer in seconds
    ///         after resume during which reads are still rejected; recommended value
    ///         is 1 hour (matches Aave V3 default for stable assets) but consumers
    ///         may tune up/down per use case.
    /// @param  feed         Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  gracePeriod  Seconds after sequencer resume during which reads still revert.
    function checkSequencerUp(address feed, uint256 gracePeriod) internal view {
        // Mainnet / non-L2 deployments: feed = address(0) → skip entirely.
        if (feed == address(0)) return;

        (
            /* uint80 roundId */,
            int256 answer,
            uint256 startedAt,
            /* uint256 updatedAt */,
            /* uint80 answeredInRound */
        ) = IChainlinkAggregator(feed).latestRoundData();

        // answer == 1 → sequencer is reporting "down" right now.
        if (answer == 1) revert SequencerDown();

        // Sequencer is up (answer == 0) BUT we additionally require that it has
        // been up for at least `gracePeriod` seconds. `startedAt` is the timestamp
        // at which the current `answer` was set, i.e. when the sequencer most
        // recently transitioned to "up". A startedAt of 0 means "no round yet"
        // (round-not-initialized) and we treat that conservatively as "in grace".
        if (startedAt == 0) revert SequencerGracePeriodNotOver();
        if (block.timestamp - startedAt < gracePeriod) {
            revert SequencerGracePeriodNotOver();
        }
    }

    /// @notice AUDIT R014 H-6: return the wall-clock timestamp at which the
    ///         sequencer most recently transitioned to "up", or zero if the
    ///         sequencer is currently down / the feed is the no-op address.
    ///
    /// @dev    `checkSequencerUp` only proves the sequencer is currently up AND
    ///         the post-resume grace window has elapsed. It does NOT expose
    ///         WHEN the resume happened — so a downstream consumer can pass the
    ///         gate while still consuming a stale oracle observation that
    ///         pre-dates the resume. This is the core H-6 staleness gap:
    ///
    ///           t0:   sequencer goes down
    ///           t0+1: TWAP `update()` records observation O1 (pre-outage spot)
    ///           t1:   sequencer resumes (`startedAt = t1`)
    ///           t1+G: grace window elapses; `checkSequencerUp` now passes
    ///                 — but a `consult()` here would still average over O1,
    ///                 which reflects pre-outage reserves. An attacker who
    ///                 watched the outage queue can extract value the moment
    ///                 the gate opens, BEFORE a fresh observation lands.
    ///
    ///         Consumers that have access to a per-observation timestamp (POL,
    ///         lending oracle, drop dutch price) should call this helper after
    ///         `checkSequencerUp` and reject reads where the observation
    ///         timestamp is older than `resumeAt + gracePeriod`. Mirrors
    ///         Aave V3's `PriceOracleSentinel` "isAnswerNotStale" extension.
    ///
    /// @param  feed Chainlink L2 Sequencer Uptime feed address.
    /// @return resumeAt The `startedAt` of the latest round (i.e. when the
    ///         current `answer` was posted). Zero if the sequencer is currently
    ///         reporting down OR if the feed is `address(0)` (mainnet no-op).
    ///         Callers MUST treat zero as "no resume gating applies" and rely
    ///         on `checkSequencerUp`'s revert semantics for the up/down decision.
    function getResumeTimestamp(address feed) internal view returns (uint256 resumeAt) {
        // Mainnet / non-L2: no feed → no resume timestamp to gate on. Return 0
        // and let the caller skip the staleness comparison entirely.
        if (feed == address(0)) return 0;

        (
            /* uint80 roundId */,
            int256 answer,
            uint256 startedAt,
            /* uint256 updatedAt */,
            /* uint80 answeredInRound */
        ) = IChainlinkAggregator(feed).latestRoundData();

        // If the sequencer is currently down, there is no meaningful "resume"
        // timestamp — return 0 and let `checkSequencerUp` produce the typed
        // revert. The H-6 staleness comparison is only relevant when the
        // sequencer is up; in the down case we already block via SequencerDown.
        if (answer != 0) return 0;

        return startedAt;
    }
}
