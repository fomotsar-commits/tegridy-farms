// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

interface ITegridyStaking {
    struct Position {
        uint256 amount;
        uint256 boostedAmount;
        int256 rewardDebt;
        uint64 lockEnd;
        uint16 boostBps;
        uint32 lockDuration;
        bool autoMaxLock;
        bool hasJbacBoost;
        uint64 stakeTimestamp;
    }
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt,
        uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
        bool autoMaxLock, bool hasJbacBoost, uint64 stakeTimestamp,
        uint256 jbacTokenId, bool jbacDeposited
    );
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title TegridyTokenURIReader
/// @notice Generates on-chain SVG metadata for TegridyStaking NFT positions
contract TegridyTokenURIReader {
    using Strings for uint256;
    using Strings for address;

    ITegridyStaking public immutable staking;

    // AUDIT FIX FRESH-2026: F-37-16 — typed custom errors replacing the
    //   bare-string `require`/`revert("...")` sites below. Custom errors:
    //     1. Save ~50 gas per revert path (4-byte selector vs string-encoded reason).
    //     2. Are easier for indexers/dApps/wallets to decode programmatically.
    //     3. Allow embedding the offending value (tokenId, amount, boost).
    //   `NonexistentToken` is the typed equivalent of EIP-721's "throw for
    //   non-existent NFTs" requirement — wallets / OpenSea decode it cleanly.
    error NonexistentToken(uint256 tokenId);
    error AmountOutOfBounds(uint256 amount);
    error BoostOutOfBounds(uint16 boostBps);
    // AUDIT FIX FRESH-2026: F-37-1 — typed error for zero-staking constructor
    //   guard so deploy scripts surface a clean revert instead of soft-bricking
    //   the reader by allowing `_staking == address(0)` and having every
    //   subsequent `tokenURI` call resolve to `NonexistentToken`.
    error ZeroStaking();

    /// @dev AUDIT FIX FRESH-2026: F-37-1 — explicit zero-address guard on the
    ///      staking parameter. Without this, `tokenURI(tokenId)` calls would
    ///      perpetually fall into the `NonexistentToken` catch path (no code
    ///      at zero ⇒ external call reverts), silently bricking the reader at
    ///      the indexer / marketplace level. Cheap, removes a footgun.
    constructor(address _staking) {
        if (_staking == address(0)) revert ZeroStaking();
        staking = ITegridyStaking(_staking);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        // AUDIT FIX: DEEP-URI-02: enforce EIP-721 — `tokenURI(_tokenId)` MUST
        // throw for non-existent NFTs. Without this, the reader synthesises
        // valid-looking JSON for any tokenId (including unminted IDs), which
        // is a phishing surface: a scammer crafts a fake marketplace listing
        // for tsTOWELI #999999 and the reader produces a normal-looking
        // metadata response. OZ ERC721 reverts in `ownerOf` for non-existent
        // tokens, so we wrap in try/catch to surface a typed `NONEXISTENT`
        // revert regardless of the upstream error type.
        // AUDIT FIX: V2-URI-01 (INFO, cross-cluster verified): `TegridyStaking._nextTokenId`
        // is initialized to `1` (see TegridyStaking.sol — `uint256 private _nextTokenId = 1;`).
        // Token ID 0 is therefore never minted by the staking contract; `ownerOf(0)`
        // always reverts with `ERC721NonexistentToken(0)`, and this function correctly
        // produces the typed `NONEXISTENT` revert. If a future migration or replacement
        // staking contract changes the initial counter to 0, this reader's behaviour for
        // tokenId == 0 must be revisited — the `holder != address(0)` post-check would
        // also need to differentiate between "non-existent" and "exists but zero-init holder".
        // AUDIT FIX FRESH-2026: F-37-16 — typed `NonexistentToken(tokenId)` replaces
        //   bare-string `"NONEXISTENT"` revert. Wallets/indexers can decode the
        //   selector and embed the offending tokenId without string-parsing.
        try staking.ownerOf(tokenId) returns (address holder) {
            if (holder == address(0)) revert NonexistentToken(tokenId);
        } catch {
            revert NonexistentToken(tokenId);
        }

        // AUDIT FIX FRESH-2026: F-37-17 — APPEND-ONLY INVARIANT.
        //   `staking.positions(tokenId)` returns 11 fields. We destructure 7
        //   (amount, lockEnd, boostBps, lockDuration, autoMaxLock, hasJbacBoost,
        //   stakeTimestamp via the trailing comma slot) and intentionally drop
        //   `boostedAmount`, `rewardDebt`, `jbacTokenId`, `jbacDeposited`. This
        //   destructuring is correct ONLY for an APPEND-ONLY tuple shape — any
        //   future migration of the staking-side `Position` struct MUST add
        //   new fields at the END of the tuple. INSERTING a field in the
        //   middle (or reordering existing fields) silently breaks this reader:
        //   `boostBps` could be reading what was supposed to be `lockEnd`,
        //   etc., with no compile-time signal because the types still align.
        //   Audit history H-1 (2026-04-20) shows the team has been following
        //   the safe append-only pattern (jbacTokenId + jbacDeposited were
        //   appended at the tail). Future contributors: if the struct shape
        //   needs to change non-additively, ADD a new view function on
        //   staking (e.g. `positionsV2`) and migrate this reader's interface
        //   in lockstep — do NOT reorder existing fields.
        (
            uint256 amount, , ,
            uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
            bool autoMaxLock, bool hasJbacBoost, , ,
        ) = staking.positions(tokenId);

        // AUDIT R014 (LOW): defensive range checks on staking-returned values
        // before they hit the SVG / JSON formatters. The staking contract
        // already enforces these bounds at write-time, but adding them here
        // makes the URI reader robust to any future relaxation upstream and
        // gives indexers a typed revert instead of a silently-malformed JSON
        // string. 1e9 ether covers the entire TOWELI supply with margin;
        // 50000 bps is well above the protocol's MAX_BOOST + JBAC_BONUS cap.
        // AUDIT FIX FRESH-2026: F-37-16 — typed errors with the offending value
        //   embedded so indexers/wallets can decode without string-matching.
        if (amount > 1e9 ether) revert AmountOutOfBounds(amount);
        if (boostBps > 50000) revert BoostOutOfBounds(boostBps);

        // AUDIT FIX FRESH-2026: F-37-18 — cache `_formatAmount(amount)` and
        //   `_boostDisplay(boostBps)` once at the `tokenURI` level instead of
        //   recomputing them inside both `_buildSVG` and `_buildJSON`. The SVG
        //   builder previously cached locally; the JSON builder called each
        //   helper TWICE per invocation. Caching here saves 4 redundant
        //   string-builds per `tokenURI` call (3 for amount + boost in JSON,
        //   plus the SVG's own pair which we now hand through). View-only gas
        //   is mostly irrelevant for off-chain RPC, but matters when this URI
        //   is consumed on-chain (e.g., a future protocol that reads metadata
        //   mid-transaction).
        string memory amountStr = _formatAmount(amount);
        string memory boostStr = _boostDisplay(boostBps);
        string memory svg = _buildSVG(tokenId, amountStr, boostStr, lockEnd, lockDuration, autoMaxLock, hasJbacBoost);
        string memory json = _buildJSON(tokenId, amountStr, boostStr, lockEnd, lockDuration, autoMaxLock, hasJbacBoost, svg);

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev AUDIT FIX FRESH-2026: F-37-4 — extended to 4-decimal precision so
    ///      that small-but-nonzero amounts (e.g., 0.0099 TOWELI) no longer
    ///      truncate to a misleading "0" display. Trailing zeros are stripped
    ///      so amounts that are clean multiples of 0.01 still render "12.50"
    ///      not "12.5000". Width is bounded: at most 4 fractional digits +
    ///      whole part, so the SVG/JSON template length stays predictable.
    ///
    ///      Examples:
    ///        9.999e15 wei  → "0.0099"  (was: "0", silently misleading)
    ///        1.5e18 wei    → "1.50"    (preserves the existing 2-dp clean look)
    ///        12345e15 wei  → "12.345"  (3-dp rendering keeps human-readable)
    ///        0             → "0"
    ///        1e18 wei      → "1"       (zero-fraction collapses to whole)
    function _formatAmount(uint256 amount) internal pure returns (string memory) {
        uint256 whole = amount / 1e18;
        uint256 frac = (amount % 1e18) / 1e14; // 4 decimal places
        if (frac == 0) return whole.toString();
        // Strip trailing zeros so "1.5000" renders as "1.50" / "1.5" cleanly.
        // We keep a minimum of 2 decimals when frac > 0 to preserve the
        // pre-fix two-decimal look for clean values; only the 3rd/4th decimals
        // are dropped if they're zero. This means 1.5e18 → frac=5000 → after
        // tail-trim → "50" → "1.50", and 9.999e15 → frac=99 → "0.0099" wins
        // on small-amount fidelity without bloating the typical render.
        // Tail-trim: drop trailing zeros until at most 2 remain.
        uint256 digits = 4;
        while (digits > 2 && frac % 10 == 0) {
            frac /= 10;
            digits -= 1;
        }
        // Pad-front with zeros so e.g. frac=99 with digits=4 renders as "0099".
        string memory fracStr = frac.toString();
        // Compute current digit count of `frac` to know how much front-padding to add.
        uint256 fracLen;
        {
            uint256 tmp = frac;
            if (tmp == 0) {
                fracLen = 1;
            } else {
                while (tmp != 0) {
                    fracLen++;
                    tmp /= 10;
                }
            }
        }
        while (fracLen < digits) {
            fracStr = string.concat("0", fracStr);
            fracLen++;
        }
        return string.concat(whole.toString(), ".", fracStr);
    }

    function _formatDays(uint32 duration) internal pure returns (string memory) {
        uint256 days_ = uint256(duration) / 86400;
        return string.concat(days_.toString(), "d");
    }

    function _boostDisplay(uint16 bps) internal pure returns (string memory) {
        uint256 whole = uint256(bps) / 10000;
        uint256 frac = (uint256(bps) % 10000) / 100;
        if (frac == 0) return string.concat(whole.toString(), "x");
        string memory fracStr = frac < 10 ? string.concat("0", frac.toString()) : frac.toString();
        return string.concat(whole.toString(), ".", fracStr, "x");
    }

    /// @notice AUDIT MICROSCOPE_2026_04_30 H22: stable status enum for the JSON
    ///         payload. Returning a time-dependent countdown ("5d left" / "12h left")
    ///         caused the encoded `tokenURI` data URI to mutate every block, which
    ///         drives off-chain caches (OpenSea, IPFS pinners, indexers that hash
    ///         the URI) into thrash mode — they re-fetch on every change and bill
    ///         the protocol's RPC quota. Discrete enum {Flexible, Auto-Max,
    ///         Active, Expired} flips at most once per position lifecycle. SVG
    ///         consumers that want countdown data should query `lockEnd` directly
    ///         and render off-chain.
    /// @dev    AUDIT FIX: DEEP-URI-03 (INFO): `_lockStatus` flips exactly once
    ///         per position lifetime — at the `block.timestamp >= lockEnd`
    ///         boundary. Indexers and IPFS pinners that hash the encoded data
    ///         URI to detect content changes will see a single hash mutation
    ///         around the lockEnd block, then permanent stability thereafter.
    ///         This is bounded behavior; any future contributor adding a
    ///         time-dependent field (e.g., "days remaining," "epoch number")
    ///         MUST keep the same single-flip property or this guarantee
    ///         degrades. Optionally: emit an off-chain-monitorable event from
    ///         the staking contract on lockEnd transition so consumers can
    ///         subscribe rather than poll.
    /// @dev    AUDIT FIX FRESH-2026: F-37-15 — SINGLE-FLIP INVARIANT, ENUMERATED.
    ///         The four return values form a closed enum {`Auto-Max`,
    ///         `Flexible`, `Active`, `Expired`}. Each branch is gated on a
    ///         monotonic-or-event-driven trigger:
    ///           - `Auto-Max` ↔ `Active` flips iff the user toggles
    ///             `autoMaxLock` (a discrete user event, NOT a timestamp leak).
    ///           - `Flexible` ↔ `Active` flips iff the user converts a
    ///             flexible position into a locked one (lockEnd 0 → nonzero,
    ///             also a discrete user event).
    ///           - `Active` → `Expired` flips exactly ONCE at the
    ///             `block.timestamp >= lockEnd` boundary — and never reverses
    ///             because the staking contract MUST NOT extend `lockEnd` on
    ///             an existing position (which would "un-Expire" it and break
    ///             the single-flip property; current TegridyStaking honours
    ///             this by issuing a NEW position on lock extension rather
    ///             than mutating in place).
    ///         The single-flip property is what keeps OpenSea/IPFS-pinner
    ///         caches stable: each position's `tokenURI` hash mutates at most
    ///         a small bounded number of times (≤ 3, in practice ≤ 1) over
    ///         its lifetime. Future contributors who introduce a field that
    ///         changes more frequently (block-by-block "remaining time",
    ///         epoch counters) MUST EITHER keep that field outside the
    ///         hashed URI (e.g., emit it as an event, return it from a
    ///         separate getter) OR accept that off-chain caches will thrash.
    function _lockStatus(uint64 lockEnd, bool autoMaxLock) internal view returns (string memory) {
        if (autoMaxLock) return "Auto-Max";
        if (lockEnd == 0) return "Flexible";
        if (block.timestamp >= lockEnd) return "Expired";
        return "Active";
    }

    // AUDIT FIX: DEEP-URI-01 (INFO): removed unused `_jsonEscape` helper. It was
    // a forward-looking guard for a string-injection vector that does not exist
    // today (every field in `_buildJSON` is numeric / constant). Keeping it
    // defined-but-uncalled is a footgun: a future contributor adding a string
    // field has no compile-time signal to wrap it. Re-add IN THE SAME PR that
    // introduces any attacker-controlled string so reviewers see both halves
    // together. Pattern of record: lazy guards live with their callers.

    /// @dev AUDIT FIX FRESH-2026: F-37-18 — `amountStr` and `boostStr` are
    ///      passed in pre-built (cached at the `tokenURI` level) instead of
    ///      being re-derived here. Saves the redundant `_formatAmount` /
    ///      `_boostDisplay` calls that previously ran twice per `tokenURI`
    ///      invocation (once in SVG, once in JSON, sometimes twice in JSON).
    function _buildSVG(
        uint256 tokenId, string memory amountStr, string memory boostStr,
        uint64 lockEnd, uint32 lockDuration, bool autoMaxLock, bool hasJbacBoost
    ) internal view returns (string memory) {
        string memory lockStr = _formatDays(lockDuration);
        string memory statusStr = _lockStatus(lockEnd, autoMaxLock);

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" style="background:#0a0e1a">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0%" stop-color="#1a1040"/><stop offset="100%" stop-color="#0d1a2d"/>'
            '</linearGradient></defs>',
            '<rect width="400" height="500" fill="url(#g)" rx="20"/>',
            '<rect x="16" y="16" width="368" height="468" rx="12" fill="none" stroke="#d4a017" stroke-width="1.5" opacity="0.4"/>',
            // Title
            '<text x="200" y="55" text-anchor="middle" fill="#d4a017" font-family="monospace" font-size="18" font-weight="bold">TEGRIDY FARMS</text>',
            '<text x="200" y="78" text-anchor="middle" fill="#8b5cf6" font-family="monospace" font-size="12">tsTOWELI Position #', tokenId.toString(), '</text>',
            // Divider
            '<line x1="40" y1="95" x2="360" y2="95" stroke="#d4a017" stroke-width="0.5" opacity="0.3"/>',
            _buildSVGBody(amountStr, boostStr, lockStr, statusStr, hasJbacBoost),
            '</svg>'
        );
    }

    function _buildSVGBody(
        string memory amountStr, string memory boostStr,
        string memory lockStr, string memory statusStr, bool hasJbacBoost
    ) internal pure returns (string memory) {
        return string.concat(
            // Amount
            '<text x="40" y="135" fill="#888" font-family="monospace" font-size="11">STAKED</text>',
            '<text x="40" y="165" fill="#fff" font-family="monospace" font-size="24" font-weight="bold">', amountStr, '</text>',
            '<text x="40" y="185" fill="#8b5cf6" font-family="monospace" font-size="12">TOWELI</text>',
            // Boost
            '<text x="40" y="225" fill="#888" font-family="monospace" font-size="11">BOOST</text>',
            '<text x="40" y="255" fill="#10b981" font-family="monospace" font-size="24" font-weight="bold">', boostStr, '</text>',
            hasJbacBoost
                ? '<text x="40" y="275" fill="#d4a017" font-family="monospace" font-size="11">+ JBAC BONUS</text>'
                : '',
            // Lock
            '<text x="40" y="315" fill="#888" font-family="monospace" font-size="11">LOCK DURATION</text>',
            '<text x="40" y="345" fill="#fff" font-family="monospace" font-size="20">', lockStr, '</text>',
            // Status
            '<text x="40" y="385" fill="#888" font-family="monospace" font-size="11">STATUS</text>',
            '<text x="40" y="415" fill="#d4a017" font-family="monospace" font-size="20">', statusStr, '</text>',
            // Footer
            '<line x1="40" y1="445" x2="360" y2="445" stroke="#d4a017" stroke-width="0.5" opacity="0.3"/>',
            '<text x="200" y="475" text-anchor="middle" fill="#555" font-family="monospace" font-size="10">tegridyfarms.fun</text>'
        );
    }

    /// @dev AUDIT FIX FRESH-2026: F-37-18 — `amountStr` and `boostStr` arrive
    ///      pre-built from `tokenURI`, not re-derived twice per call.
    /// @dev AUDIT FIX FRESH-2026: F-37-3 — `lockDuration` rendering uses
    ///      ROUND-UP day arithmetic `(d + 86399) / 86400` instead of floor
    ///      division. Floor division silently truncated sub-day components:
    ///      a 90,000-second lock (1d 1h) was rendered as `1` (losing the
    ///      1-hour tail), and a 86,399-second lock was rendered as `0`
    ///      (visibly zero despite a non-trivial lock). Round-up means a lock
    ///      always shows at least the day it actually occupies, which is
    ///      what users / OpenSea numeric-trait filters expect ("show me
    ///      positions locked >= 30 days" no longer misses positions with a
    ///      30-day-plus-1-second lock). The staking contract enforces
    ///      day-aligned lock durations in practice, so this is forward-defence
    ///      against any future relaxation of that invariant.
    function _buildJSON(
        uint256 tokenId, string memory amountStr, string memory boostStr,
        uint64 lockEnd, uint32 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        string memory svg
    ) internal view returns (string memory) {
        return string.concat(
            '{"name":"tsTOWELI #', tokenId.toString(),
            '","description":"Tegridy Farms staking position. ', amountStr, ' TOWELI staked at ', boostStr, ' boost.',
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":[',
            '{"trait_type":"Staked Amount","value":"', amountStr, ' TOWELI"},',
            '{"trait_type":"Boost","value":"', boostStr, '"},',
            '{"trait_type":"Lock Duration","display_type":"number","value":', uint256((uint256(lockDuration) + 86399) / 86400).toString(), '},',
            '{"trait_type":"Lock Status","value":"', _lockStatus(lockEnd, autoMaxLock), '"},',
            '{"trait_type":"Auto Max Lock","value":"', autoMaxLock ? 'Yes' : 'No', '"},',
            '{"trait_type":"JBAC Boost","value":"', hasJbacBoost ? 'Yes' : 'No', '"}',
            ']}'
        );
    }
}
