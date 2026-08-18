// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AirdropFactory} from "../../src/AirdropFactory.sol";
import {TegridyAirdropDistributor} from "../../src/TegridyAirdropDistributor.sol";

/// @title  Airdrop distributor invariant suite — build plan item #65
/// @notice Stateful invariants over a single funded campaign under random sequences of
///         claims, reclaims and time travel.
///
///         The properties are the ones a campaign page's promises rest on:
///
///         - INV-CONSERVATION: every token that entered the campaign is either still in
///           the distributor, paid to the account named in its leaf, or returned to the
///           creator. Nothing evaporates and nothing is minted.
///
///         - INV-NO-OVERPAY: no account is ever paid more than its leaf. This is the
///           double-claim property stated as a balance rather than as a revert, so it
///           holds across BOTH claim entry points and any interleaving of them.
///
///         - INV-DISJOINT-WINDOW: `claimsOpen()` and "reclaim would succeed" are never
///           both true. If they could overlap, a creator could race claimants for the
///           same tokens.
///
///         - INV-NO-ETH-RETAINED: the distributor never holds ETH. Fee ETH is forwarded
///           inside the same call or the call reverts; the contract has no sweep path, so
///           any retained wei would be permanently stranded.
///
///         - INV-CLAIMED-BIT-MONOTONIC: a leaf that has ever been marked claimed stays
///           claimed. The bitmap is the only thing standing between one leaf and
///           unlimited draws on the campaign.
///
///         fail_on_revert is left at the foundry.toml default (false): handler actions
///         revert routinely by design (expired window, already claimed, nothing to
///         reclaim) and the invariants assert post-state instead.
contract AirdropInvToken is ERC20 {
    constructor() ERC20("Inv", "INV") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract AirdropInvHandler is Test {
    TegridyAirdropDistributor public dist;
    ERC20 public token;
    address public creator;

    address[] public accounts;
    uint256[] public amounts;
    bytes32[][] internal proofs;

    /// @notice Tokens the creator has taken back through `reclaim`.
    uint256 public totalReclaimed;
    /// @notice Set once any leaf has ever read as claimed, per index — the monotonicity
    ///         witness the invariant compares the live bitmap against.
    mapping(uint256 => bool) public everClaimed;

    constructor(
        TegridyAirdropDistributor _dist,
        ERC20 _token,
        address _creator,
        address[] memory _accounts,
        uint256[] memory _amounts,
        bytes32[][] memory _proofs
    ) {
        dist = _dist;
        token = _token;
        creator = _creator;
        for (uint256 i = 0; i < _accounts.length; ++i) {
            accounts.push(_accounts[i]);
            amounts.push(_amounts[i]);
            proofs.push(_proofs[i]);
        }
    }

    function leafCount() external view returns (uint256) {
        return accounts.length;
    }

    function claimFree(uint256 seed) public {
        uint256 i = seed % accounts.length;
        try dist.claim(i, accounts[i], amounts[i], proofs[i]) {} catch {}
        _record();
    }

    function claimPaid(uint256 seed) public {
        uint256 i = seed % accounts.length;
        try dist.claimWithFee{value: 0}(i, accounts[i], amounts[i], proofs[i]) {} catch {}
        _record();
    }

    /// @dev Deliberately wrong proof/amount pairings, so the fuzzer spends part of its
    ///      budget on the forgery surface rather than only on well-formed claims.
    function claimForged(uint256 seed, uint256 amountSeed) public {
        uint256 i = seed % accounts.length;
        uint256 j = (seed + 1) % accounts.length;
        try dist.claim(i, accounts[i], amountSeed, proofs[j]) {} catch {}
        _record();
    }

    function reclaim(uint256 seed) public {
        address caller = seed % 2 == 0 ? creator : accounts[seed % accounts.length];
        uint256 before = token.balanceOf(creator);
        vm.prank(caller);
        try dist.reclaim() {
            totalReclaimed += token.balanceOf(creator) - before;
        } catch {}
        _record();
    }

    function warpForward(uint256 seconds_) public {
        // Absolute target: solc may hoist TIMESTAMP within a function, so a relative
        // `block.timestamp + x` warp can silently repeat the same instant.
        uint256 target = block.timestamp + bound(seconds_, 1, 10 days);
        vm.warp(target);
        _record();
    }

    function _record() internal {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (dist.isClaimed(i)) everClaimed[i] = true;
        }
    }
}

contract AirdropDistributorInvariantsTest is Test {
    AirdropFactory factory;
    AirdropInvToken token;
    TegridyAirdropDistributor dist;
    AirdropInvHandler handler;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");

    uint256 constant LEAVES = 6;
    uint256 funded;
    address[] accounts;
    uint256[] amounts;

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _levels(bytes32[] memory leaves) internal pure returns (bytes32[][] memory lv) {
        uint256 depth = 1;
        uint256 c = leaves.length;
        while (c > 1) {
            c = (c + 1) / 2;
            ++depth;
        }
        lv = new bytes32[][](depth);
        lv[0] = leaves;
        for (uint256 d = 1; d < depth; ++d) {
            bytes32[] memory prev = lv[d - 1];
            uint256 m = (prev.length + 1) / 2;
            bytes32[] memory cur = new bytes32[](m);
            for (uint256 i = 0; i < m; ++i) {
                cur[i] = (2 * i + 1 < prev.length) ? _hashPair(prev[2 * i], prev[2 * i + 1]) : prev[2 * i];
            }
            lv[d] = cur;
        }
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[][] memory lv = _levels(leaves);
        bytes32[] memory tmp = new bytes32[](lv.length);
        uint256 count;
        uint256 idx = index;
        for (uint256 d = 0; d + 1 < lv.length; ++d) {
            uint256 sib = idx ^ 1;
            if (sib < lv[d].length) tmp[count++] = lv[d][sib];
            idx /= 2;
        }
        proof = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            proof[i] = tmp[i];
        }
    }

    function setUp() public {
        factory = new AirdropFactory(owner);
        token = new AirdropInvToken();
        token.transfer(creator, 500_000 ether);

        bytes32[] memory leaves = new bytes32[](LEAVES);
        bytes32[][] memory proofs = new bytes32[][](LEAVES);
        for (uint256 i = 0; i < LEAVES; ++i) {
            address a = address(uint160(0x1000 + i));
            // One deliberately zero-amount leaf so the edge is inside the invariant run.
            uint256 amt = i == LEAVES - 1 ? 0 : (i + 1) * 10 ether;
            accounts.push(a);
            amounts.push(amt);
            leaves[i] = keccak256(abi.encodePacked(i, a, amt));
            funded += amt;
        }
        for (uint256 i = 0; i < LEAVES; ++i) {
            proofs[i] = _proof(leaves, i);
        }
        bytes32[][] memory lv = _levels(leaves);
        bytes32 root = lv[lv.length - 1][0];

        vm.startPrank(creator);
        token.approve(address(factory), funded);
        dist = TegridyAirdropDistributor(factory.createCampaign(address(token), root, funded, 30 days));
        vm.stopPrank();

        handler = new AirdropInvHandler(dist, ERC20(address(token)), creator, accounts, amounts, proofs);
        targetContract(address(handler));
    }

    /// @notice INV-CONSERVATION
    function invariant_tokenConservation() public view {
        uint256 paid;
        for (uint256 i = 0; i < accounts.length; ++i) {
            paid += token.balanceOf(accounts[i]);
        }
        assertEq(paid + handler.totalReclaimed() + token.balanceOf(address(dist)), funded, "tokens created or destroyed");
    }

    /// @notice INV-NO-OVERPAY
    function invariant_noAccountOverpaid() public view {
        for (uint256 i = 0; i < accounts.length; ++i) {
            assertLe(token.balanceOf(accounts[i]), amounts[i], "leaf paid more than once");
        }
    }

    /// @notice INV-DISJOINT-WINDOW
    function invariant_claimAndReclaimNeverBothOpen() public {
        bool claimsOpen = dist.claimsOpen();
        uint256 snap = vm.snapshotState();
        vm.prank(creator);
        (bool reclaimWouldSucceed,) = address(dist).call(abi.encodeWithSelector(dist.reclaim.selector));
        vm.revertToState(snap);
        assertFalse(claimsOpen && reclaimWouldSucceed, "creator can race claimants");
    }

    /// @notice INV-NO-ETH-RETAINED
    function invariant_noEthRetained() public view {
        assertEq(address(dist).balance, 0, "distributor retained unsweepable ETH");
    }

    /// @notice INV-CLAIMED-BIT-MONOTONIC
    function invariant_claimedBitsAreMonotonic() public view {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (handler.everClaimed(i)) {
                assertTrue(dist.isClaimed(i), "a claimed leaf became unclaimed");
            }
        }
    }
}
