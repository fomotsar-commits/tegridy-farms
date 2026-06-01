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
    /// @dev Reverted when the sequencer is currently reporting "down" (answer != 0).
    error SequencerDown();

    /// @dev Reverted when the sequencer just resumed but the post-resume grace window
    ///      has not yet elapsed. Lets AMM reserves / TWAP observations refresh before
    ///      consumers trust the price.
    error SequencerGracePeriodNotOver();

    /// @dev AUDIT FIX FRESH-2026: H-9 [F-74-1, F-74-2] — reverted when a
    ///      consumer on a non-mainnet chain (i.e. an L2) calls
    ///      `checkSequencerUp` with `feed == address(0)`. Pre-fix, the
    ///      `feed == address(0)` branch silently no-op'd on every chain,
    ///      so a deploy script that omitted `setSequencerFeed(...)` (or
    ///      passed `vm.envOr("SEQUENCER_FEED", address(0))` with the env
    ///      unset) would ship with sequencer protection inert on L2 with
    ///      no on-chain warning. The lib now refuses the no-op on any
    ///      chain except `chainid == 1` (Ethereum mainnet, which has no
    ///      sequencer concept). Mainnet keeps the no-op fast path.
    error SequencerFeedNotConfigured();

    /// @dev AUDIT FIX 2026-05-26 [M-23] — reverted when a consumer passes a
    ///      `gracePeriod` below `MIN_GRACE_PERIOD` (60s). Pre-fix, callers
    ///      could pass `gracePeriod = 0` and the post-resume window check
    ///      collapsed to `block.timestamp - startedAt < 0` which is always
    ///      false → silent bypass of the entire post-resume buffer. Mirrors
    ///      TimelockAdmin's MIN_DELAY floor pattern (loud failure > silent
    ///      acceptance — single revert, no inline clamping).
    error GraceTooShort();

    /// @notice AUDIT FIX 2026-05-26 [M-23] — protocol-wide minimum on the
    ///         post-resume grace window passed to `checkSequencerUp`. 1 minute
    ///         is the floor below which the gate is effectively inert (a single
    ///         block can elapse on most L2s). Honest consumers use 1h+ (Aave
    ///         V3 stable-asset default); the floor only catches misconfigured
    ///         deploys and `gracePeriod = 0` bypass attempts.
    uint256 internal constant MIN_GRACE_PERIOD = 60;

    /// @notice AUDIT MICROSCOPE_2026_04_30 M-Lib2 / DEEP-LIB-M3: max acceptable
    ///         staleness on the uptime feed itself. Chainlink's L2 uptime feed is
    ///         keeper-updated; if the keeper lapses, `latestRoundData` returns a
    ///         previously-cached round whose `answer` may no longer reflect reality.
    ///         Aave V3 `PriceOracleSentinel` and the Chainlink "Handling Outages"
    ///         docs require `block.timestamp - updatedAt <= MAX_FEED_STALENESS`
    ///         AND `answeredInRound >= roundId` to defend against this. 24h matches
    ///         Aave's stable-asset default.
    /// @dev    DEEP-LIB-M3: per-consumer tuning is offered through the `staleness`
    ///         overload of `checkSequencerUp`. Lending / drop pricing should pick a
    ///         tighter window (e.g. 4h) so a keeper lapse trips earlier on
    ///         price-sensitive paths.
    uint256 internal constant MAX_FEED_STALENESS = 24 hours;

    // ─── Reasons reported by `tryCheckSequencerUp` (DEEP-LIB-M6) ─────
    /// @dev Sequencer is up AND the post-resume grace window elapsed. Consumer
    ///      may safely consume the price/observation.
    uint8 internal constant TRY_OK = 0;
    /// @dev Round is not yet initialized (`updatedAt == 0`). Treat as "down".
    uint8 internal constant TRY_ROUND_UNINIT = 1;
    /// @dev `answeredInRound < roundId` — the answer pre-dates the round.
    uint8 internal constant TRY_STALE_ROUND = 2;
    /// @dev `block.timestamp - updatedAt > staleness` — keeper lapse.
    uint8 internal constant TRY_KEEPER_LAPSED = 3;
    /// @dev `answer != 0` — sequencer reporting down.
    uint8 internal constant TRY_SEQ_DOWN = 4;
    /// @dev `startedAt == 0` — round not yet initialized for the up answer.
    uint8 internal constant TRY_NO_RESUME = 5;
    /// @dev `block.timestamp - startedAt < gracePeriod` — within grace window.
    uint8 internal constant TRY_IN_GRACE = 6;
    // AUDIT FIX: V2-LIB-M1 — feed advertises a future-dated `updatedAt` /
    //   `startedAt` (clock skew on a bridged/relayed feed can post
    //   `updatedAt = block.timestamp + 1` on the very block of resume).
    //   Before this reason byte, the soft-fail path tripped a checked-math
    //   underflow `Panic(0x11)`, breaking the "non-reverting" promise that
    //   indexers / quoter eth_calls rely on.
    uint8 internal constant TRY_CLOCK_SKEW = 7;

    /// @notice Revert if the L2 sequencer is down or within `gracePeriod` of resume.
    /// @dev    Pass `feed == address(0)` to no-op (Ethereum mainnet and any chain
    ///         without a sequencer concept). `gracePeriod` is the buffer in seconds
    ///         after resume during which reads are still rejected; recommended value
    ///         is 1 hour (matches Aave V3 default for stable assets) but consumers
    ///         may tune up/down per use case.
    /// @dev    AUDIT FIX: DEEP-LIB-M3 — defaults to `MAX_FEED_STALENESS` (24h);
    ///         price-sensitive consumers can use the 3-argument overload to pass
    ///         a tighter staleness window.
    /// @param  feed         Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  gracePeriod  Seconds after sequencer resume during which reads still revert.
    function checkSequencerUp(address feed, uint256 gracePeriod) internal view {
        checkSequencerUp(feed, gracePeriod, MAX_FEED_STALENESS);
    }

    /// @notice AUDIT FIX: DEEP-LIB-M3 — overload that accepts a per-call
    ///         staleness window. Lending valuation, drop dutch-auction
    ///         pricing, and POL accumulator should call this with a tighter
    ///         window (e.g. 4h) so a Chainlink keeper outage trips before
    ///         the cached uptime answer drifts past safe-to-trust.
    /// @param  feed         Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  gracePeriod  Seconds after sequencer resume during which reads still revert.
    /// @param  staleness    Max acceptable `block.timestamp - updatedAt` on the feed.
    function checkSequencerUp(address feed, uint256 gracePeriod, uint256 staleness) internal view {
        // AUDIT FIX 2026-05-26 [M-23] — Reject sub-minimum grace at function
        // top. Pass-thru `gracePeriod = 0` would otherwise silently bypass
        // the post-resume buffer (block.timestamp - startedAt < 0 is always
        // false). Loud failure beats silent acceptance; mirrors
        // TimelockAdmin's MIN_DELAY floor at line 167.
        if (gracePeriod < MIN_GRACE_PERIOD) revert GraceTooShort();
        // Mainnet / non-L2 deployments: feed = address(0) → skip entirely.
        // AUDIT FIX FRESH-2026: H-9 [F-74-1, F-74-2] — but ONLY if we're
        // actually on mainnet. Pre-fix every L2 chain that shipped without
        // `setSequencerFeed(...)` got the no-op too, silently disabling
        // sequencer protection. The deploy-side fix (Wave C) requires
        // explicit feed wiring; this lib-side guard is the structural
        // backstop that makes the failure visible at first call rather
        // than silent at deploy time. NatSpec invariant: ANY non-mainnet
        // deploy MUST configure the feed; this revert surfaces the gap.
        if (feed == address(0)) {
            if (block.chainid != 1) revert SequencerFeedNotConfigured();
            return;
        }

        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IChainlinkAggregator(feed).latestRoundData();

        // AUDIT MICROSCOPE_2026_04_30 M-Lib2: round-validity / freshness checks
        // PRECEDE the up/down decision so a stale feed can never fall through the
        // `answer != 0` branch with a cached "up" reading. Pattern of record:
        // Aave V3 PriceOracleSentinel + Chainlink "Handling Outages" docs.
        if (updatedAt == 0) revert SequencerGracePeriodNotOver(); // round not initialized
        if (answeredInRound < roundId) revert SequencerDown();    // answer pre-dates round
        // AUDIT FIX: v3-LIB-M1 — directional ordering check BEFORE the
        // subtraction. A future-dated `updatedAt` (sub-second clock skew on
        // a bridged/relayed feed, common after sequencer replay on
        // Arbitrum/Base) would have underflowed checked-math with
        // `Panic(0x11)` — structurally distinct from the typed `SequencerDown`
        // selector that off-chain decoders / wagmi / ethers / viem branch on.
        // This restores typed-revert symmetry with `tryCheckSequencerUp` /
        // `getSequencerOutageBuffer` (closed in v2-LIB-M1) so the same input
        // class produces the same revert type across all three helpers.
        if (updatedAt > block.timestamp) revert SequencerDown(); // clock skew → fail-closed
        unchecked {
            if (block.timestamp - updatedAt > staleness) revert SequencerDown(); // keeper lapse
        }

        // AUDIT MICROSCOPE_2026_04_30 M-Lib3: strict equality to UP. Pre-fix
        // `answer == 1` only treats exactly 1 as down — values like 2 (a future
        // "degraded" extension), -1 (typed-bug from a bridged feed), etc. would
        // pass through as "up". The spec says `0` is up; canonical pattern is
        // `answer != 0` → fail closed. Aligned with `getResumeTimestamp` below.
        if (answer != 0) revert SequencerDown();

        // Sequencer is up. Additionally require it has been up for at least
        // `gracePeriod` seconds. A `startedAt` of 0 is treated as "no round yet".
        if (startedAt == 0) revert SequencerGracePeriodNotOver();
        // AUDIT FIX: v3-LIB-M1 — same future-dated guard for `startedAt` so
        // a clock-skew event on the resume timestamp also produces the typed
        // `SequencerGracePeriodNotOver` rather than `Panic(0x11)`.
        if (startedAt > block.timestamp) revert SequencerGracePeriodNotOver(); // clock skew on grace
        unchecked {
            if (block.timestamp - startedAt < gracePeriod) {
                revert SequencerGracePeriodNotOver();
            }
        }
    }

    /// @notice AUDIT FIX: DEEP-LIB-M6 — non-reverting sister of `checkSequencerUp`.
    ///         Returns `(ok, reason)` instead of reverting so view paths
    ///         (indexers, frontend `eth_call` simulators, aggregator quote paths)
    ///         can degrade gracefully during a sequencer outage instead of
    ///         gas-bombing every read.
    /// @dev    Security-critical write paths (lending liquidation, drop pricing,
    ///         POL harvest) MUST keep using the reverting `checkSequencerUp`.
    ///         This helper is for soft-fail UX scenarios only.
    /// @param  feed         Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  gracePeriod  Seconds after sequencer resume during which reads are still considered "in grace".
    /// @return ok           True iff the sequencer is up and outside the grace window.
    /// @return reason       One of TRY_OK..TRY_IN_GRACE describing the failure mode (TRY_OK on success).
    function tryCheckSequencerUp(address feed, uint256 gracePeriod)
        internal
        view
        returns (bool ok, uint8 reason)
    {
        return tryCheckSequencerUp(feed, gracePeriod, MAX_FEED_STALENESS);
    }

    /// @notice AUDIT FIX: DEEP-LIB-M6 — overload that accepts a per-call staleness window.
    function tryCheckSequencerUp(address feed, uint256 gracePeriod, uint256 staleness)
        internal
        view
        returns (bool ok, uint8 reason)
    {
        if (feed == address(0)) return (true, TRY_OK);

        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IChainlinkAggregator(feed).latestRoundData();

        if (updatedAt == 0) return (false, TRY_ROUND_UNINIT);
        if (answeredInRound < roundId) return (false, TRY_STALE_ROUND);
        // AUDIT FIX: V2-LIB-M1 — directional ordering check BEFORE the
        // subtraction. A future-dated `updatedAt` (clock skew on a bridged
        // feed) made `block.timestamp - updatedAt` underflow with
        // `Panic(0x11)`, breaking the "non-reverting" promise of this helper.
        // Treat any future-dated round as a clock-skew event (fail closed).
        if (updatedAt > block.timestamp) return (false, TRY_CLOCK_SKEW);
        unchecked {
            if (block.timestamp - updatedAt > staleness) return (false, TRY_KEEPER_LAPSED);
        }
        if (answer != 0) return (false, TRY_SEQ_DOWN);
        if (startedAt == 0) return (false, TRY_NO_RESUME);
        // AUDIT FIX: V2-LIB-M1 — same future-dated guard for `startedAt`.
        if (startedAt > block.timestamp) return (false, TRY_CLOCK_SKEW);
        unchecked {
            if (block.timestamp - startedAt < gracePeriod) return (false, TRY_IN_GRACE);
        }
        return (true, TRY_OK);
    }

    /// @notice AUDIT FIX: DEEP-LIB-H2 — canonical "should we extend the grace
    ///         window?" helper for non-revert contexts. Returns `buffer` if
    ///         the sequencer is currently down OR within `buffer` of resume,
    ///         otherwise 0. Same staleness/direction gates as
    ///         `checkSequencerUp` so re-implementations elsewhere in the
    ///         protocol can be retired in favour of this single source of
    ///         truth (closes the M-Lib3 sibling-miss in MemeBountyBoard's
    ///         duplicated `_sequencerBuffer`).
    /// @dev    Used by bounty refund / emergency-cancel windows that widen
    ///         the grace period when an L2 sequencer outage prevented honest
    ///         participation. Returns 0 when `feed == address(0)` (mainnet no-op).
    /// @param  feed   Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  buffer Seconds to extend the grace window when an outage is
    ///                detected. Returned as-is on outage; 0 otherwise.
    /// @dev    AUDIT FIX: V2-LIB-M2 — defaults to `MAX_FEED_STALENESS` (24h);
    ///         consumers that need a tighter staleness window (e.g. short-
    ///         deadline bounty refunds) should use the 3-argument overload
    ///         below for symmetry with `checkSequencerUp` /
    ///         `tryCheckSequencerUp`.
    function getSequencerOutageBuffer(address feed, uint256 buffer)
        internal
        view
        returns (uint256)
    {
        return getSequencerOutageBuffer(feed, buffer, MAX_FEED_STALENESS);
    }

    /// @notice AUDIT FIX: V2-LIB-M2 — overload that accepts a per-call
    ///         staleness window. Matches the (`feed, gracePeriod, staleness`)
    ///         shape of `checkSequencerUp` / `tryCheckSequencerUp` so the
    ///         helper trio shares a consistent API surface (closes the
    ///         M-Lib3 sibling-miss between the H2 helper and the M3
    ///         staleness fix).
    /// @param  feed      Chainlink L2 Sequencer Uptime feed address (or 0 for no-op).
    /// @param  buffer    Seconds to extend the grace window when an outage is detected.
    /// @param  staleness Max acceptable `block.timestamp - updatedAt` on the feed.
    function getSequencerOutageBuffer(address feed, uint256 buffer, uint256 staleness)
        internal
        view
        returns (uint256)
    {
        if (feed == address(0)) return 0;

        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IChainlinkAggregator(feed).latestRoundData();

        // Mirror the same fail-closed gates as `checkSequencerUp`. Any feed
        // anomaly (uninitialized round, stale answer, keeper lapse, non-zero
        // answer, missing startedAt) is treated as "outage" → return buffer.
        if (updatedAt == 0) return buffer;                                 // round not initialized
        if (answeredInRound < roundId) return buffer;                      // answer pre-dates round
        // AUDIT FIX: V2-LIB-M1 — directional ordering check BEFORE the
        // subtraction. A future-dated `updatedAt` (clock skew on a bridged
        // feed) would have underflowed with `Panic(0x11)`, breaking the
        // soft-fail contract this helper offers to non-reverting consumers
        // (MemeBountyBoard refund / cancel paths).
        if (updatedAt > block.timestamp) return buffer;                    // clock skew → treat as outage
        unchecked {
            if (block.timestamp - updatedAt > staleness) return buffer;    // keeper lapse
        }
        if (answer != 0) return buffer;                                    // sequencer down
        if (startedAt == 0) return buffer;                                 // no round yet
        // AUDIT FIX: V2-LIB-M1 — same future-dated guard for `startedAt`.
        if (startedAt > block.timestamp) return buffer;                    // clock skew → treat as outage
        unchecked {
            if (block.timestamp - startedAt < buffer) return buffer;       // within grace
        }
        return 0;
    }

    /// @notice AUDIT R014 H-6: return the wall-clock timestamp at which the
    ///         sequencer most recently transitioned to "up". Sentinel
    ///         semantics differ by failure mode — see the return-value doc below.
    ///
    /// @dev    `checkSequencerUp` only proves the sequencer is currently up AND
    ///         the post-resume grace window has elapsed. It does NOT expose
    ///         WHEN the resume happened — so a downstream consumer can pass the
    ///         gate while still consuming a stale oracle observation that
    ///         pre-dates the resume. This is the core H-6 staleness gap.
    /// @dev    AUDIT FIX FRESH-2026: M-34 [F-40-SEQ-2] — on every STALE
    ///         path (uninitialized round, stale answer, keeper lapse,
    ///         clock-skew on `updatedAt`) the lib now returns
    ///         `type(uint256).max` (a fail-CLOSED sentinel) instead of 0.
    ///         Pre-fix consumers computed `resumeAt + GRACE` and compared
    ///         against observation timestamps; with `resumeAt == 0` the
    ///         comparison `observation.timestamp >= 0 + GRACE` passed for
    ///         any post-2024 timestamp, silently bypassing the H6
    ///         staleness gate. Returning `type(uint256).max` makes the
    ///         comparison fail closed: `observation.timestamp >= max + GRACE`
    ///         overflows checked-math (or stays false if the consumer uses
    ///         unchecked), forcing the consumer to refuse the read. Mainnet
    ///         (feed == address(0)) and the "sequencer currently down"
    ///         (answer != 0) branches still return 0 — those are the
    ///         "use the up/down decision from checkSequencerUp" paths.
    /// @param  feed Chainlink L2 Sequencer Uptime feed address.
    /// @return resumeAt One of:
    ///           - `startedAt` (latest round's start) when the sequencer is
    ///             currently up and the feed is fresh — the resume gating
    ///             timestamp.
    ///           - 0 when `feed == address(0)` (mainnet no-op) OR the
    ///             sequencer is currently down (`answer != 0`); callers
    ///             must rely on `checkSequencerUp`'s typed revert for the
    ///             up/down decision.
    ///           - `type(uint256).max` when the feed is stale (round
    ///             uninitialized, keeper lapse, clock-skew, etc.); the
    ///             fail-closed sentinel makes any
    ///             `observation.timestamp >= resumeAt + GRACE` comparison
    ///             reject silently, preserving the H6 staleness gate.
    function getResumeTimestamp(address feed) internal view returns (uint256 resumeAt) {
        // Mainnet / non-L2: no feed → no resume timestamp to gate on. Return 0
        // and let the caller skip the staleness comparison entirely.
        if (feed == address(0)) return 0;

        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IChainlinkAggregator(feed).latestRoundData();

        // AUDIT MICROSCOPE_2026_04_30 M-Lib2: same freshness gates as
        // `checkSequencerUp`. A stale uptime feed must NOT contribute a
        // post-resume timestamp that consumers then trust as "fresh enough".
        // AUDIT FIX FRESH-2026: M-34 [F-40-SEQ-2] — return type(uint256).max
        // on each stale path so the consumer's `resumeAt + GRACE` comparison
        // fails closed (was: returned 0 → silently bypassed gate).
        if (updatedAt == 0) return type(uint256).max;
        if (answeredInRound < roundId) return type(uint256).max;
        // AUDIT FIX: v3-LIB-M1 — directional ordering check BEFORE the
        // subtraction so a future-dated `updatedAt` (clock skew on a
        // bridged/relayed feed) cannot underflow checked-math and propagate
        // a `Panic(0x11)` to consumers that expect this helper to return a
        // sentinel on stale feeds. Treat any future-dated round as stale.
        if (updatedAt > block.timestamp) return type(uint256).max;
        unchecked {
            if (block.timestamp - updatedAt > MAX_FEED_STALENESS) return type(uint256).max;
        }

        // If the sequencer is currently down, there is no meaningful "resume"
        // timestamp — return 0 and let `checkSequencerUp` produce the typed
        // revert. The H-6 staleness comparison is only relevant when the
        // sequencer is up; in the down case we already block via SequencerDown.
        if (answer != 0) return 0;

        // AUDIT FIX (BATCH-I M5): symmetric directional check on `startedAt`.
        // Pre-fix, `checkSequencerUp` rejected `startedAt > block.timestamp`
        // (v3-LIB-M1) but `getResumeTimestamp` propagated it unmodified.
        // Consumers compute `resumeAt + GRACE` for observation-validity
        // gates (TWAP, POL, SwapFeeRouter); a future-dated startedAt would
        // push that gate arbitrarily far into the future, blocking ALL
        // existing observations until on-chain time catches up — an
        // unintended DoS on bridged/relayed feeds with clock skew.
        // AUDIT FIX FRESH-2026: M-34 [F-40-SEQ-2] — clock-skew on startedAt
        // is also a stale-path → fail-closed sentinel.
        if (startedAt > block.timestamp) return type(uint256).max;

        return startedAt;
    }
}
