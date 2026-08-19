// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AirdropFactory} from "../src/AirdropFactory.sol";
import {TegridyAirdropDistributor} from "../src/TegridyAirdropDistributor.sol";
import {MerkleHelper} from "./AirdropFactory.t.sol";

contract VectorToken is ERC20 {
    constructor() ERC20("Vector", "VEC") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// @title  Cross-language merkle vector
/// @notice Campaign trees are built in TypeScript by the claim frontend
///         (`frontend/src/lib/merkle/`), and verified in Solidity by the distributor.
///         Neither language can prove on its own that the two agree, and the cost of
///         them disagreeing is a funded campaign whose every claim reverts with
///         `InvalidProof`.
///
///         This file is the shared fact: one fixed leaf set, one root, one proof per
///         leaf — asserted here against Solidity's own hashing AND accepted by a real
///         funded campaign, and asserted against the TypeScript builder in
///         `frontend/src/lib/merkle/vector.test.ts`, which pins the identical hex.
///
/// @dev    The pinned hashes are OUTPUTS of this fixture, not parameters of it. If this
///         test fails, one implementation's leaf encoding, pair ordering, odd-node
///         promotion or index assignment moved. Establish which one before touching the
///         constants — re-pinning them is how a divergence gets laundered into a
///         green suite.
contract AirdropMerkleVectorTest is MerkleHelper {
    // Digit-only addresses: no EIP-55 case to transcribe wrongly between languages.
    address constant A1 = 0x1111111111111111111111111111111111111111;
    address constant A2 = 0x2222222222222222222222222222222222222222;
    address constant A3 = 0x3333333333333333333333333333333333333333;
    address constant A4 = 0x4444444444444444444444444444444444444444;
    address constant A5 = 0x5555555555555555555555555555555555555555;

    // FIVE leaves, deliberately: the bottom layer is odd, so its last node is promoted
    // unchanged instead of paired. A four-leaf fixture is a perfect binary tree and
    // would agree between the two implementations even if one of them duplicated the
    // odd node instead of promoting it.
    uint256 constant M1 = 1 ether;
    uint256 constant M2 = 2.5 ether;
    uint256 constant M3 = 3 ether;
    uint256 constant M4 = 4 ether;
    uint256 constant M5 = 5 ether;
    uint256 constant TOTAL = M1 + M2 + M3 + M4 + M5;

    bytes32 constant PINNED_ROOT = 0xdac60bc31939956e63b59cf73e032c5058ac5cdda9fdb5f1cad96c9a591799bf;

    bytes32 constant PINNED_LEAF_0 = 0x4da60c0f242c36ca0c001c2b61dcce6fb9a4bedf9e5695fc0257e1e844eab803;
    bytes32 constant PINNED_LEAF_1 = 0x50aa075e521cc443f33b4ef7ac4a4fac43bcfd06d61c5078de422e1f0d569039;
    bytes32 constant PINNED_LEAF_2 = 0xe1c82cab2726bcddd571159bc37c7e1dd890e2bc74af5e758d8e5df39a6ae02f;
    bytes32 constant PINNED_LEAF_3 = 0xf669f38582739dabd19073bfff6ccd4eeb6d5d1f14b0636d477a4e20b0d0b768;
    bytes32 constant PINNED_LEAF_4 = 0xe57b93b9982b54b9724c22cf33e7ab48a13e92489ddd586cb2df0fe7be44b721;

    /// @dev Index 4's proof is a single element — it is the promoted node, and it has no
    ///      sibling on either of the two lower layers.
    bytes32 constant PINNED_L4_PROOF_0 = 0x80a127bcde5206013830853f0d98d4f39dd125045a4d39f3c40a37246fb4921d;

    uint64 constant WINDOW = 30 days;

    AirdropFactory factory;
    VectorToken token;
    address creator = makeAddr("vectorCreator");
    address owner = makeAddr("vectorOwner");

    bytes32[] leaves;

    function setUp() public {
        leaves.push(_leaf(0, A1, M1));
        leaves.push(_leaf(1, A2, M2));
        leaves.push(_leaf(2, A3, M3));
        leaves.push(_leaf(3, A4, M4));
        leaves.push(_leaf(4, A5, M5));

        factory = new AirdropFactory(owner);
        token = new VectorToken();
        token.transfer(creator, TOTAL);
    }

    function test_LeafEncodingIsPinned() public view {
        assertEq(leaves[0], PINNED_LEAF_0, "leaf 0 moved");
        assertEq(leaves[1], PINNED_LEAF_1, "leaf 1 moved");
        assertEq(leaves[2], PINNED_LEAF_2, "leaf 2 moved");
        assertEq(leaves[3], PINNED_LEAF_3, "leaf 3 moved");
        assertEq(leaves[4], PINNED_LEAF_4, "leaf 4 moved");
    }

    function test_RootIsPinned() public view {
        assertEq(_root(leaves), PINNED_ROOT, "root moved");
    }

    function test_PromotedOddNodeProofIsPinned() public view {
        bytes32[] memory p = _proof(leaves, 4);
        assertEq(p.length, 1, "the promoted node takes exactly one proof element");
        assertEq(p[0], PINNED_L4_PROOF_0, "promoted-node proof moved");
    }

    /// @notice The half that makes the pinned hex mean something: a campaign funded
    ///         against PINNED_ROOT accepts the pinned proofs and pays the leaf accounts.
    function test_PinnedRootIsClaimableOnARealCampaign() public {
        vm.startPrank(creator);
        token.approve(address(factory), TOTAL);
        TegridyAirdropDistributor d =
            TegridyAirdropDistributor(factory.createCampaign(address(token), PINNED_ROOT, TOTAL, WINDOW));
        vm.stopPrank();

        assertEq(d.merkleRoot(), PINNED_ROOT);

        d.claim(0, A1, M1, _proof(leaves, 0));
        d.claim(1, A2, M2, _proof(leaves, 1));
        d.claim(2, A3, M3, _proof(leaves, 2));
        d.claim(3, A4, M4, _proof(leaves, 3));

        bytes32[] memory promoted = new bytes32[](1);
        promoted[0] = PINNED_L4_PROOF_0;
        d.claim(4, A5, M5, promoted);

        assertEq(token.balanceOf(A1), M1);
        assertEq(token.balanceOf(A2), M2);
        assertEq(token.balanceOf(A3), M3);
        assertEq(token.balanceOf(A4), M4);
        assertEq(token.balanceOf(A5), M5);
        assertEq(token.balanceOf(address(d)), 0, "the vector funds the campaign exactly");
    }
}
