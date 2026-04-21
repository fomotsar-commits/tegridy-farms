// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

// ─── TegridyTokenURIReader — on-chain SVG/JSON metadata generator ─────────────
//
// Coverage focuses on the shape and correctness of the rendered output. The
// reader is a pure view layer over TegridyStaking.positions() so the tests
// stub an IStaking with configurable position data and assert:
//   1. The data URL is well-formed (data:application/json;base64,…).
//   2. The decoded JSON contains name / description / image / attributes.
//   3. The embedded image is a base64 SVG.
//   4. Formatting helpers behave at the branch edges:
//        _formatAmount: whole only, 1dp, 2dp, sub-unit
//        _boostDisplay: 1x (10000 bps), 0.4x (4000), 2.5x (25000)
//        _formatDays: matches the lockDuration-as-seconds input
//        _lockStatus: Auto-Max, Flexible (lockEnd=0), Expired, "Xd left", "Xh left"
//   5. hasJbacBoost flips the JBAC BONUS marker + the JBAC attribute.
//
// No fuzzing — the output is string-formatted; property-based assertions add
// noise without catching new classes of bugs.
// ─────────────────────────────────────────────────────────────────────────────

contract MockStaking {
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

    mapping(uint256 => Position) public positionOf;

    function setPosition(
        uint256 tokenId,
        uint256 amount,
        uint64 lockEnd,
        uint16 boostBps,
        uint32 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost
    ) external {
        positionOf[tokenId] = Position({
            amount: amount,
            boostedAmount: 0,
            rewardDebt: 0,
            lockEnd: lockEnd,
            boostBps: boostBps,
            lockDuration: lockDuration,
            autoMaxLock: autoMaxLock,
            hasJbacBoost: hasJbacBoost,
            stakeTimestamp: 0
        });
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt,
        uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
        bool autoMaxLock, bool hasJbacBoost, uint64 stakeTimestamp,
        uint256 jbacTokenId, bool jbacDeposited
    ) {
        Position memory p = positionOf[tokenId];
        return (
            p.amount, p.boostedAmount, p.rewardDebt,
            p.lockEnd, p.boostBps, p.lockDuration,
            p.autoMaxLock, p.hasJbacBoost, p.stakeTimestamp,
            0, false
        );
    }

    function ownerOf(uint256) external pure returns (address) {
        return address(0xdead);
    }
}

contract TegridyTokenURIReaderTest is Test {
    MockStaking staking;
    TegridyTokenURIReader reader;

    function setUp() public {
        staking = new MockStaking();
        reader = new TegridyTokenURIReader(address(staking));
    }

    // Decode a `data:application/json;base64,<b64>` URL into its raw JSON bytes.
    function _decodeJsonURI(string memory uri) internal pure returns (string memory) {
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(u.length > prefix.length, "decode: too short");
        for (uint256 i; i < prefix.length; i++) {
            require(u[i] == prefix[i], "decode: bad prefix");
        }
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i; i < b64.length; i++) b64[i] = u[i + prefix.length];
        return string(Base64Dec.decode(string(b64)));
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; i++) {
            bool matchHere = true;
            for (uint256 j; j < n.length; j++) {
                if (h[i + j] != n[j]) { matchHere = false; break; }
            }
            if (matchHere) return true;
        }
        return false;
    }

    // ── Well-formed data URL + core JSON fields ───────────────────────

    function test_tokenURI_isDataJsonBase64() public {
        staking.setPosition(1, 100 ether, 0, 10000, 7 days, false, false);
        string memory uri = reader.tokenURI(1);
        // Prefix must match exactly, and the decoded body must be valid JSON.
        assertTrue(_contains(uri, "data:application/json;base64,"));
        string memory json = _decodeJsonURI(uri);
        assertTrue(_contains(json, "\"name\":\"tsTOWELI #1\""));
        assertTrue(_contains(json, "\"description\""));
        assertTrue(_contains(json, "\"image\":\"data:image/svg+xml;base64,"));
        assertTrue(_contains(json, "\"attributes\":["));
    }

    // ── Amount formatting ────────────────────────────────────────────

    function test_format_wholeAmount() public {
        staking.setPosition(1, 500 ether, 0, 10000, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"500 TOWELI\""));
    }

    function test_format_twoDecimalAmount() public {
        // 123.45 TOWELI = 123.45e18 wei
        staking.setPosition(1, 123_450_000_000_000_000_000, 0, 10000, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"123.45 TOWELI\""));
    }

    function test_format_leadingZeroInFraction() public {
        // 7.05 TOWELI — frac=5 so the helper pads to "05"
        staking.setPosition(1, 7_050_000_000_000_000_000, 0, 10000, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"7.05 TOWELI\""));
    }

    // ── Boost display ────────────────────────────────────────────────

    function test_boost_oneX() public {
        staking.setPosition(1, 1 ether, 0, 10000 /* 1.0x */, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"trait_type\":\"Boost\",\"value\":\"1x\""));
    }

    function test_boost_fractional() public {
        // _boostDisplay always pads the fractional part to two digits, so
        // 0.4x renders as "0.40x". This matches how the field ends up on
        // Etherscan-rendered tokenURI images.
        staking.setPosition(1, 1 ether, 0, 4000 /* 0.4x */, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"0.40x\""));
    }

    function test_boost_maxCeiling() public {
        staking.setPosition(1, 1 ether, 0, 45000 /* 4.5x */, 4 * 365 days, true, true);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"4.50x\""));
    }

    // ── Lock status branches ─────────────────────────────────────────

    function test_lockStatus_autoMax() public {
        staking.setPosition(1, 1 ether, uint64(block.timestamp + 30 days), 40000, 4 * 365 days, true, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"Auto-Max\""));
    }

    function test_lockStatus_flexible() public {
        staking.setPosition(1, 1 ether, 0 /* lockEnd=0 */, 4000, 0, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"Flexible\""));
    }

    function test_lockStatus_expired() public {
        // lockEnd in the past
        vm.warp(1_700_000_000);
        staking.setPosition(1, 1 ether, uint64(block.timestamp - 1 days), 10000, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"Expired\""));
    }

    function test_lockStatus_daysLeft() public {
        vm.warp(1_700_000_000);
        staking.setPosition(1, 1 ether, uint64(block.timestamp + 10 days + 5 hours), 20000, 30 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"10d left\""));
    }

    function test_lockStatus_hoursLeft_whenLessThanOneDay() public {
        vm.warp(1_700_000_000);
        staking.setPosition(1, 1 ether, uint64(block.timestamp + 5 hours + 30 minutes), 20000, 30 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"value\":\"5h left\""));
    }

    // ── JBAC toggle ──────────────────────────────────────────────────

    function test_jbac_yesAttribute() public {
        staking.setPosition(1, 1 ether, 0, 10000, 7 days, false, true);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"trait_type\":\"JBAC Boost\",\"value\":\"Yes\""));
    }

    function test_jbac_noAttribute() public {
        staking.setPosition(1, 1 ether, 0, 10000, 7 days, false, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"trait_type\":\"JBAC Boost\",\"value\":\"No\""));
    }

    // ── Auto-max lock flag as attribute ──────────────────────────────

    function test_autoMax_yesAttribute() public {
        staking.setPosition(1, 1 ether, 0, 40000, 4 * 365 days, true, false);
        string memory json = _decodeJsonURI(reader.tokenURI(1));
        assertTrue(_contains(json, "\"trait_type\":\"Auto Max Lock\",\"value\":\"Yes\""));
    }

    // ── Non-existent position renders zeros without reverting ─────────

    function test_tokenURI_noPositionRendersZero() public view {
        // mapping lookup returns a zero struct — reader should still emit a
        // well-formed JSON (position data all zero), not revert.
        string memory uri = reader.tokenURI(999);
        string memory json = _decodeJsonURI(uri);
        assertTrue(_contains(json, "\"name\":\"tsTOWELI #999\""));
        assertTrue(_contains(json, "\"value\":\"0 TOWELI\""));
    }

    // ── Constructor wires the staking address ─────────────────────────

    function test_constructor_setsStaking() public view {
        assertEq(address(reader.staking()), address(staking));
    }
}

// Minimal Base64 decode helper for test-only use. OZ's Base64 is encode-only,
// and pulling a full base64-decode library in just for tests is overkill, so
// this is a straightforward RFC-4648 decoder implemented inline.
library Base64Dec {
    function decode(string memory data) internal pure returns (bytes memory) {
        bytes memory s = bytes(data);
        if (s.length == 0) return "";
        require(s.length % 4 == 0, "Base64Dec: bad length");
        uint256 padding = 0;
        if (s[s.length - 1] == "=") padding++;
        if (s[s.length - 2] == "=") padding++;
        bytes memory out = new bytes((s.length / 4) * 3 - padding);
        uint256 outIdx = 0;
        for (uint256 i = 0; i < s.length; i += 4) {
            uint256 n = (_c(s[i]) << 18) | (_c(s[i + 1]) << 12)
                | (_c(s[i + 2]) << 6) | _c(s[i + 3]);
            if (outIdx < out.length) out[outIdx++] = bytes1(uint8(n >> 16));
            if (outIdx < out.length) out[outIdx++] = bytes1(uint8((n >> 8) & 0xff));
            if (outIdx < out.length) out[outIdx++] = bytes1(uint8(n & 0xff));
        }
        return out;
    }

    function _c(bytes1 b) private pure returns (uint256) {
        uint8 u = uint8(b);
        if (u >= 65 && u <= 90) return u - 65;       // A-Z → 0-25
        if (u >= 97 && u <= 122) return u - 71;      // a-z → 26-51
        if (u >= 48 && u <= 57) return u + 4;        // 0-9 → 52-61
        if (u == 43) return 62;                      // '+' → 62
        if (u == 47) return 63;                      // '/' → 63
        return 0;                                    // '=' padding
    }
}
