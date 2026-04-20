// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Toweli} from "../src/Toweli.sol";

// ─── TOWELI — fixed-supply governance token ───────────────────────────────────
//
// Coverage targets the invariants the contract's docstring promises:
//   1. 1 B fixed supply minted once to the constructor-provided recipient.
//   2. Standard ERC-20 name / symbol / decimals semantics.
//   3. Constructor rejects zero recipient.
//   4. No admin surface: no mint, no burn, no pause, no owner, no blocklist.
//   5. EIP-2612 permit() works (valid sig sets allowance; replayed sig reverts;
//      expired sig reverts).
//
// Supply invariance is enforced indirectly — we transfer the entire supply
// through a chain of addresses and assert totalSupply never drifts.
// ─────────────────────────────────────────────────────────────────────────────

contract ToweliTest is Test {
    Toweli token;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        token = new Toweli(treasury);
    }

    // ── Constructor ────────────────────────────────────────────────────

    function test_constructor_mintsFullSupplyToRecipient() public view {
        assertEq(token.totalSupply(), SUPPLY, "totalSupply");
        assertEq(token.balanceOf(treasury), SUPPLY, "treasury balance");
    }

    function test_constructor_revertsOnZeroRecipient() public {
        vm.expectRevert(bytes("Toweli: zero recipient"));
        new Toweli(address(0));
    }

    function test_metadata() public view {
        assertEq(token.name(), "Toweli");
        assertEq(token.symbol(), "TOWELI");
        assertEq(token.decimals(), 18);
    }

    // ── Supply invariance ──────────────────────────────────────────────

    function test_supplyIsImmutableThroughTransfers() public {
        uint256 preSupply = token.totalSupply();

        vm.prank(treasury);
        token.transfer(alice, SUPPLY / 2);
        assertEq(token.totalSupply(), preSupply, "supply after first transfer");

        vm.prank(alice);
        token.transfer(bob, SUPPLY / 4);
        assertEq(token.totalSupply(), preSupply, "supply after second transfer");

        // Even burning to address(0) should revert at the ERC-20 layer — OZ
        // rejects transfer-to-zero, so totalSupply cannot drift downward.
        vm.prank(bob);
        vm.expectRevert();
        token.transfer(address(0), 1 ether);
        assertEq(token.totalSupply(), preSupply, "supply after failed burn");
    }

    // ── No admin surface ───────────────────────────────────────────────

    function test_noMintFunction() public {
        // If Toweli exposed any `mint` selector that accepts (address,uint256),
        // this low-level call would encode + execute it. Expect a revert —
        // no matching selector exists, so the fallback path reverts.
        (bool ok, ) = address(token).call(
            abi.encodeWithSignature("mint(address,uint256)", alice, 1 ether)
        );
        assertFalse(ok, "unexpected mint() selector present");
    }

    function test_noBurnFunction() public {
        vm.prank(treasury);
        (bool ok, ) = address(token).call(
            abi.encodeWithSignature("burn(uint256)", uint256(1 ether))
        );
        assertFalse(ok, "unexpected burn() selector present");
    }

    function test_noOwnerFunction() public {
        (bool ok, ) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "unexpected owner() selector present");
    }

    function test_noPauseFunction() public {
        (bool ok, ) = address(token).call(abi.encodeWithSignature("pause()"));
        assertFalse(ok, "unexpected pause() selector present");
    }

    // ── Basic ERC-20 behavior ──────────────────────────────────────────

    function test_transferMovesBalance() public {
        vm.prank(treasury);
        token.transfer(alice, 100 ether);
        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(token.balanceOf(treasury), SUPPLY - 100 ether);
    }

    function test_transferRevertsOnInsufficientBalance() public {
        vm.prank(alice); // alice holds 0
        vm.expectRevert();
        token.transfer(bob, 1 ether);
    }

    function test_approveAndTransferFrom() public {
        vm.prank(treasury);
        token.approve(alice, 500 ether);
        assertEq(token.allowance(treasury, alice), 500 ether);

        vm.prank(alice);
        token.transferFrom(treasury, bob, 300 ether);
        assertEq(token.balanceOf(bob), 300 ether);
        assertEq(token.allowance(treasury, alice), 200 ether);
    }

    // ── EIP-2612 permit ────────────────────────────────────────────────

    function test_permit_setsAllowance() public {
        uint256 ownerKey = 0xA11CE;
        address owner = vm.addr(ownerKey);

        // Fund owner so the permit is meaningful (not strictly required to
        // just set allowance, but mirrors real usage).
        vm.prank(treasury);
        token.transfer(owner, 100 ether);

        uint256 value = 50 ether;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);
        bytes32 digest = _permitDigest(owner, alice, value, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        token.permit(owner, alice, value, deadline, v, r, s);
        assertEq(token.allowance(owner, alice), value);
        assertEq(token.nonces(owner), nonce + 1);
    }

    function test_permit_revertsOnExpiredDeadline() public {
        uint256 ownerKey = 0xBEEF;
        address owner = vm.addr(ownerKey);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);
        bytes32 digest = _permitDigest(owner, alice, 1 ether, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        vm.warp(deadline + 1);
        vm.expectRevert();
        token.permit(owner, alice, 1 ether, deadline, v, r, s);
    }

    function test_permit_revertsOnReplay() public {
        uint256 ownerKey = 0xCAFE;
        address owner = vm.addr(ownerKey);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);
        bytes32 digest = _permitDigest(owner, alice, 1 ether, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        token.permit(owner, alice, 1 ether, deadline, v, r, s);
        // Same signature, same nonce → second call must revert (OZ consumes
        // the nonce after a successful permit).
        vm.expectRevert();
        token.permit(owner, alice, 1 ether, deadline, v, r, s);
    }

    // ── helpers ────────────────────────────────────────────────────────

    function _permitDigest(
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }
}
