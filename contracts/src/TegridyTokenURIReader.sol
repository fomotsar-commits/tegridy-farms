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

    constructor(address _staking) {
        staking = ITegridyStaking(_staking);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        (
            uint256 amount, , ,
            uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
            bool autoMaxLock, bool hasJbacBoost, , ,
        ) = staking.positions(tokenId);

        string memory svg = _buildSVG(tokenId, amount, boostBps, lockEnd, lockDuration, autoMaxLock, hasJbacBoost);
        string memory json = _buildJSON(tokenId, amount, boostBps, lockEnd, lockDuration, autoMaxLock, hasJbacBoost, svg);

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _formatAmount(uint256 amount) internal pure returns (string memory) {
        uint256 whole = amount / 1e18;
        uint256 frac = (amount % 1e18) / 1e16; // 2 decimal places
        if (frac == 0) return whole.toString();
        string memory fracStr = frac < 10 ? string.concat("0", frac.toString()) : frac.toString();
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

    function _lockStatus(uint64 lockEnd, bool autoMaxLock) internal view returns (string memory) {
        if (autoMaxLock) return "Auto-Max";
        if (lockEnd == 0) return "Flexible";
        if (block.timestamp >= lockEnd) return "Expired";
        uint256 remaining = lockEnd - block.timestamp;
        uint256 days_ = remaining / 86400;
        if (days_ > 0) return string.concat(days_.toString(), "d left");
        uint256 hours_ = remaining / 3600;
        return string.concat(hours_.toString(), "h left");
    }

    function _buildSVG(
        uint256 tokenId, uint256 amount, uint16 boostBps,
        uint64 lockEnd, uint32 lockDuration, bool autoMaxLock, bool hasJbacBoost
    ) internal view returns (string memory) {
        string memory amountStr = _formatAmount(amount);
        string memory boostStr = _boostDisplay(boostBps);
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

    function _buildJSON(
        uint256 tokenId, uint256 amount, uint16 boostBps,
        uint64 lockEnd, uint32 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        string memory svg
    ) internal view returns (string memory) {
        return string.concat(
            '{"name":"tsTOWELI #', tokenId.toString(),
            '","description":"Tegridy Farms staking position. ', _formatAmount(amount), ' TOWELI staked at ', _boostDisplay(boostBps), ' boost.',
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":[',
            '{"trait_type":"Staked Amount","value":"', _formatAmount(amount), ' TOWELI"},',
            '{"trait_type":"Boost","value":"', _boostDisplay(boostBps), '"},',
            '{"trait_type":"Lock Duration","display_type":"number","value":', uint256(lockDuration / 86400).toString(), '},',
            '{"trait_type":"Lock Status","value":"', _lockStatus(lockEnd, autoMaxLock), '"},',
            '{"trait_type":"Auto Max Lock","value":"', autoMaxLock ? 'Yes' : 'No', '"},',
            '{"trait_type":"JBAC Boost","value":"', hasJbacBoost ? 'Yes' : 'No', '"}',
            ']}'
        );
    }
}
