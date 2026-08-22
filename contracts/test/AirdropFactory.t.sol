// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AirdropFactory} from "../src/AirdropFactory.sol";
import {TegridyAirdropDistributor} from "../src/TegridyAirdropDistributor.sol";
import {OwnableNoRenounce} from "../src/base/OwnableNoRenounce.sol";
import {PauseGuardian} from "../src/base/PauseGuardian.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import {AlreadyClaimed, InvalidProof} from "../src/vendor/uniswap-merkle-distributor/MerkleDistributor.sol";

// ─── Mocks ───────────────────────────────────────────────────────────

contract MockAirdropToken is ERC20 {
    constructor() ERC20("Airdrop", "AIR") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// @dev Takes `feeBps` on every transfer, so the factory's measured-funding path is
///      exercised against a token that does not deliver what it was asked to.
contract MockFeeOnTransferToken is ERC20 {
    uint256 public feeBps;

    constructor(uint256 _feeBps) ERC20("FoT", "FOT") {
        feeBps = _feeBps;
        _mint(msg.sender, 1_000_000 ether);
    }

    /// @dev Minting bypasses the transfer fee, so a test can put an exact balance on an
    ///      account even when the token takes 100% of every transfer.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Re-enters the distributor from inside `transfer`, the ERC-777-shaped attack the
///      vendored claim path is supposed to be immune to.
contract MockReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;

    constructor() ERC20("Reenter", "RNT") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && target != address(0)) {
            armed = false;
            (bool ok, bytes memory err) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(err, 0x20), mload(err))
                }
            }
        }
    }
}

contract RevertingSink {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev Re-enters the distributor from the fee-forward callback and RECORDS whether the
///      re-entry succeeded rather than bubbling its revert. Swallowing is deliberate: it
///      lets the test observe the guard's effect (the second claim never lands) instead
///      of only seeing the outer call fail, which a plain `FeeForwardFailed` would not
///      distinguish from a sink that simply rejects ETH.
contract ReentrantSink {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            reentryAttempted = true;
            (bool ok,) = target.call{value: 0}(payload);
            reentrySucceeded = ok;
        }
    }
}

contract PlainSink {
    receive() external payable {}
}

// ─── Merkle helper ───────────────────────────────────────────────────

/// @dev Builds the same tree shape OpenZeppelin's `MerkleProof.verify` consumes:
///      commutative (sorted-pair) hashing, odd nodes promoted. Leaf encoding matches the
///      vendored distributor exactly — `keccak256(abi.encodePacked(index, account, amount))`.
abstract contract MerkleHelper is Test {
    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index, account, amount));
    }

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

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[][] memory lv = _levels(leaves);
        return lv[lv.length - 1][0];
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[][] memory lv = _levels(leaves);
        bytes32[] memory tmp = new bytes32[](lv.length);
        uint256 count;
        uint256 idx = index;
        for (uint256 d = 0; d + 1 < lv.length; ++d) {
            uint256 sib = idx ^ 1;
            if (sib < lv[d].length) {
                tmp[count++] = lv[d][sib];
            }
            idx /= 2;
        }
        proof = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            proof[i] = tmp[i];
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

contract AirdropFactoryTest is MerkleHelper {
    AirdropFactory factory;
    MockAirdropToken token;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint64 constant WINDOW = 30 days;
    uint256 constant A_AMT = 100 ether;
    uint256 constant B_AMT = 250 ether;
    uint256 constant C_AMT = 1 ether;
    uint256 constant D_AMT = 0; // zero-amount leaf, deliberately

    bytes32[] leaves;
    uint256 totalLeafAmount;

    function setUp() public {
        factory = new AirdropFactory(owner);
        token = new MockAirdropToken();
        token.transfer(creator, 500_000 ether);

        leaves.push(_leaf(0, alice, A_AMT));
        leaves.push(_leaf(1, bob, B_AMT));
        leaves.push(_leaf(2, carol, C_AMT));
        leaves.push(_leaf(3, dave, D_AMT));
        totalLeafAmount = A_AMT + B_AMT + C_AMT + D_AMT;
    }

    function _create(uint256 funding) internal returns (TegridyAirdropDistributor d) {
        vm.startPrank(creator);
        token.approve(address(factory), funding);
        d = TegridyAirdropDistributor(factory.createCampaign(address(token), _root(leaves), funding, WINDOW));
        vm.stopPrank();
    }

    /// @dev Warps to the pending proposal's own `executeAfter`. Never `block.timestamp +
    ///      delay`: solc treats TIMESTAMP as movable within a function (true on-chain,
    ///      where it cannot change mid-transaction), so two `vm.warp(block.timestamp +
    ///      X)` calls in one test body both warp to the SAME instant and the second
    ///      timelock silently never matures.
    function _warpToReady(bytes32 key) internal {
        uint256 readyAt = factory.proposalExecuteAfter(key);
        assertGt(readyAt, 0, "no pending proposal for key");
        vm.warp(readyAt);
    }

    function _armFee(uint256 fee, address sink) internal {
        vm.startPrank(owner);
        factory.proposeFeeSink(sink);
        vm.stopPrank();
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        factory.executeFeeSink(sink);
        factory.proposeClaimFee(fee);
        vm.stopPrank();
        _warpToReady(factory.CLAIM_FEE_CHANGE());
        vm.prank(owner);
        factory.executeClaimFee(fee);
    }

    // ─── Happy path ──────────────────────────────────────────────────

    function test_HappyPath_AllLeavesClaim() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);

        assertEq(d.token(), address(token));
        assertEq(d.merkleRoot(), _root(leaves));
        assertEq(d.creator(), creator);
        assertEq(d.factory(), address(factory));
        assertEq(d.claimFeeWei(), 0, "fee must ship at zero");
        assertEq(d.feeSink(), address(0), "sink must ship unwired");
        assertEq(token.balanceOf(address(d)), totalLeafAmount);
        assertTrue(factory.isCampaign(address(d)));

        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        d.claim(1, bob, B_AMT, _proof(leaves, 1));
        d.claim(2, carol, C_AMT, _proof(leaves, 2));

        assertEq(token.balanceOf(alice), A_AMT);
        assertEq(token.balanceOf(bob), B_AMT);
        assertEq(token.balanceOf(carol), C_AMT);
        assertTrue(d.isClaimed(0));
        assertTrue(d.isClaimed(1));
        assertTrue(d.isClaimed(2));
        assertFalse(d.isClaimed(3));
        assertEq(token.balanceOf(address(d)), 0);
    }

    function test_HappyPath_ThirdPartyClaimsButTokensGoToLeafAccount() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.prank(bob); // bob pays gas to claim alice's leaf
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT, "tokens follow the leaf, not the caller");
        assertEq(token.balanceOf(bob), 0);
    }

    function test_CampaignInfo_ReadSurface() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        TegridyAirdropDistributor.CampaignInfo memory info = d.campaignInfo();
        assertEq(info.token, address(token));
        assertEq(info.creator, creator);
        assertTrue(info.claimsOpen);
        assertEq(info.remaining, totalLeafAmount);
        assertEq(info.claimFeeWei, 0);

        vm.warp(d.expiresAt());
        assertFalse(d.campaignInfo().claimsOpen);
    }

    // ─── Double claim ────────────────────────────────────────────────

    function test_DoubleClaim_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        vm.expectRevert(AlreadyClaimed.selector);
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT);
    }

    function test_DoubleClaim_AcrossBothEntryPoints_Reverts() public {
        _armFee(0.0005 ether, address(new PlainSink()));
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        d.claimWithFee{value: 0.0005 ether}(0, alice, A_AMT, _proof(leaves, 0));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(AlreadyClaimed.selector);
        d.claimWithFee{value: 0.0005 ether}(0, alice, A_AMT, _proof(leaves, 0));
    }

    // ─── Wrong proof ─────────────────────────────────────────────────

    function test_WrongProof_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(InvalidProof.selector);
        d.claim(0, alice, A_AMT, _proof(leaves, 1)); // bob's proof
    }

    function test_WrongAmount_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(InvalidProof.selector);
        d.claim(0, alice, A_AMT + 1, _proof(leaves, 0));
    }

    function test_WrongAccount_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(InvalidProof.selector);
        d.claim(0, bob, A_AMT, _proof(leaves, 0));
    }

    function test_EmptyProof_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(InvalidProof.selector);
        d.claim(0, alice, A_AMT, new bytes32[](0));
    }

    function test_UnlistedIndex_Reverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(InvalidProof.selector);
        d.claim(99, alice, A_AMT, _proof(leaves, 0));
    }

    // ─── Expiry boundary ─────────────────────────────────────────────

    function test_ExpiryBoundary_ClaimAtLastInstantSucceeds() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.warp(d.expiresAt() - 1);
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT);
    }

    function test_ExpiryBoundary_ClaimAtExpiryReverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        uint64 exp = d.expiresAt();
        vm.warp(exp);
        vm.expectRevert(abi.encodeWithSelector(TegridyAirdropDistributor.ClaimWindowClosed.selector, exp));
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
    }

    function test_ExpiryBoundary_ReclaimOneSecondEarlyReverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        uint64 exp = d.expiresAt();
        vm.warp(exp - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TegridyAirdropDistributor.ClaimWindowOpen.selector, exp));
        d.reclaim();
    }

    function test_ExpiryBoundary_ReclaimAtExactExpirySucceeds() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.warp(d.expiresAt());
        uint256 before = token.balanceOf(creator);
        vm.prank(creator);
        uint256 got = d.reclaim();
        assertEq(got, totalLeafAmount);
        assertEq(token.balanceOf(creator), before + totalLeafAmount);
        assertEq(token.balanceOf(address(d)), 0);
    }

    /// @dev The two paths are disjoint at every instant: there is no timestamp at which a
    ///      claimant and the creator can both be paid the same tokens.
    function test_ExpiryBoundary_ClaimAndReclaimNeverBothOpen() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        uint64 exp = d.expiresAt();
        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(exp - 1 + i);
            bool claimsOpen = d.claimsOpen();
            uint256 snap = vm.snapshotState();
            vm.prank(creator);
            (bool reclaimOk,) = address(d).call(abi.encodeWithSelector(d.reclaim.selector));
            vm.revertToState(snap);
            assertFalse(claimsOpen && reclaimOk, "creator can race claimants for the same tokens");
        }
    }

    // ─── Reclaim access ──────────────────────────────────────────────

    function test_Reclaim_OnlyCreator() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.warp(d.expiresAt());
        vm.prank(alice);
        vm.expectRevert(TegridyAirdropDistributor.NotCreator.selector);
        d.reclaim();
        vm.prank(owner); // the factory owner is not special here either
        vm.expectRevert(TegridyAirdropDistributor.NotCreator.selector);
        d.reclaim();
    }

    function test_Reclaim_EmptyCampaignReverts() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        d.claim(1, bob, B_AMT, _proof(leaves, 1));
        d.claim(2, carol, C_AMT, _proof(leaves, 2));
        vm.warp(d.expiresAt());
        vm.prank(creator);
        vm.expectRevert(TegridyAirdropDistributor.NothingToReclaim.selector);
        d.reclaim();
    }

    function test_Reclaim_ReturnsOnlyUnclaimedRemainder() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        d.claim(1, bob, B_AMT, _proof(leaves, 1));
        vm.warp(d.expiresAt());
        vm.prank(creator);
        uint256 got = d.reclaim();
        assertEq(got, totalLeafAmount - B_AMT);
    }

    // ─── Zero / edge amounts ─────────────────────────────────────────

    /// @dev Upstream behaviour, preserved: a zero-amount leaf is claimable and burns its
    ///      bitmap slot. Recorded as a test so anyone generating trees knows a zero leaf
    ///      is a real, one-shot entry rather than a no-op.
    function test_ZeroAmountLeaf_ClaimsAndConsumesTheSlot() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        d.claim(3, dave, D_AMT, _proof(leaves, 3));
        assertTrue(d.isClaimed(3));
        assertEq(token.balanceOf(dave), 0);
        vm.expectRevert(AlreadyClaimed.selector);
        d.claim(3, dave, D_AMT, _proof(leaves, 3));
    }

    function test_UnderfundedCampaign_ClaimRevertsOnTransfer() public {
        TegridyAirdropDistributor d = _create(A_AMT); // only enough for leaf 0
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        vm.expectRevert(); // ERC20InsufficientBalance
        d.claim(1, bob, B_AMT, _proof(leaves, 1));
    }

    function test_Create_ZeroFundingReverts() public {
        vm.prank(creator);
        vm.expectRevert(AirdropFactory.ZeroAmount.selector);
        factory.createCampaign(address(token), _root(leaves), 0, WINDOW);
    }

    function test_Create_ZeroRootReverts() public {
        vm.prank(creator);
        vm.expectRevert(AirdropFactory.ZeroMerkleRoot.selector);
        factory.createCampaign(address(token), bytes32(0), 1 ether, WINDOW);
    }

    function test_Create_ZeroTokenReverts() public {
        vm.prank(creator);
        vm.expectRevert(AirdropFactory.ZeroAddress.selector);
        factory.createCampaign(address(0), _root(leaves), 1 ether, WINDOW);
    }

    function test_Create_WindowBoundsEnforced() public {
        uint64 min = factory.MIN_CLAIM_WINDOW();
        uint64 max = factory.MAX_CLAIM_WINDOW();
        vm.startPrank(creator);
        token.approve(address(factory), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(AirdropFactory.InvalidClaimWindow.selector, min - 1, min, max));
        factory.createCampaign(address(token), _root(leaves), 1 ether, min - 1);

        vm.expectRevert(abi.encodeWithSelector(AirdropFactory.InvalidClaimWindow.selector, max + 1, min, max));
        factory.createCampaign(address(token), _root(leaves), 1 ether, max + 1);

        // Both endpoints are inclusive.
        address a = factory.createCampaign(address(token), _root(leaves), 1 ether, min);
        address b = factory.createCampaign(address(token), _root(leaves), 1 ether, max);
        vm.stopPrank();
        assertEq(TegridyAirdropDistributor(a).expiresAt(), uint64(block.timestamp) + min);
        assertEq(TegridyAirdropDistributor(b).expiresAt(), uint64(block.timestamp) + max);
    }

    function test_FeeOnTransferToken_FundedIsMeasuredNotAssumed() public {
        MockFeeOnTransferToken fot = new MockFeeOnTransferToken(500); // 5%
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(factory), 1000 ether);
        vm.recordLogs();
        address d = factory.createCampaign(address(fot), _root(leaves), 1000 ether, WINDOW);
        vm.stopPrank();
        assertEq(fot.balanceOf(d), 950 ether, "distributor holds what actually arrived");
        // The event must carry the measured figure, not the requested one.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("CampaignCreated(address,address,address,bytes32,uint256,uint64,uint256,address)")) {
                (, uint256 funded,,,) = abi.decode(logs[i].data, (bytes32, uint256, uint64, uint256, address));
                assertEq(funded, 950 ether, "event must report measured funding");
                found = true;
            }
        }
        assertTrue(found, "CampaignCreated not emitted");
    }

    function test_FullTakeToken_CreateReverts() public {
        MockFeeOnTransferToken fot = new MockFeeOnTransferToken(10_000); // takes 100%
        fot.mint(creator, 1000 ether);
        vm.startPrank(creator);
        fot.approve(address(factory), 1000 ether);
        vm.expectRevert(AirdropFactory.NoFundsReceived.selector);
        factory.createCampaign(address(fot), _root(leaves), 1000 ether, WINDOW);
        vm.stopPrank();
    }

    // ─── Fee: ships off, cannot be armed carelessly ──────────────────

    function test_Fee_ShipsAtZeroWithNoSink() public view {
        assertEq(factory.claimFeeWei(), 0);
        assertEq(factory.feeSink(), address(0));
    }

    function test_Fee_CannotArmWithoutSink() public {
        vm.prank(owner);
        vm.expectRevert(AirdropFactory.FeeSinkUnset.selector);
        factory.proposeClaimFee(0.0005 ether);
    }

    function test_Fee_CannotExceedHardCap() public {
        address sink = address(new PlainSink());
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        factory.executeFeeSink(sink);
        uint256 cap = factory.MAX_CLAIM_FEE_WEI();
        vm.expectRevert(abi.encodeWithSelector(AirdropFactory.FeeAboveCap.selector, cap + 1, cap));
        factory.proposeClaimFee(cap + 1);
        factory.proposeClaimFee(cap); // the cap itself is allowed
        vm.stopPrank();
    }

    function test_Fee_TimelockCannotBeSkipped() public {
        address sink = address(new PlainSink());
        vm.startPrank(owner);
        factory.proposeFeeSink(sink);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, factory.FEE_SINK_CHANGE()));
        factory.executeFeeSink(sink);
        vm.stopPrank();
    }

    function test_Fee_ExecuteIsValueBound() public {
        address sink = address(new PlainSink());
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.startPrank(owner);
        vm.expectRevert(AirdropFactory.PendingValueMismatch.selector);
        factory.executeFeeSink(address(0xBEEF));
        factory.executeFeeSink(sink);
        vm.stopPrank();
        assertEq(factory.feeSink(), sink);
    }

    function test_Fee_OnlyOwnerCanPropose() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.proposeFeeSink(address(0xBEEF));
    }

    function test_Fee_SinkCannotBeUnsetWhileFeeIsLive() public {
        _armFee(0.0005 ether, address(new PlainSink()));
        vm.prank(owner);
        vm.expectRevert(AirdropFactory.FeeSinkUnset.selector);
        factory.proposeFeeSink(address(0));
    }

    function test_Fee_ProposingUnchangedValueReverts() public {
        vm.prank(owner);
        vm.expectRevert(AirdropFactory.ValueUnchanged.selector);
        factory.proposeClaimFee(0);
    }

    // ─── Fee: behaviour once armed ───────────────────────────────────

    function test_Fee_SnapshotIsImmutableForExistingCampaigns() public {
        TegridyAirdropDistributor free = _create(totalLeafAmount);
        assertEq(free.claimFeeWei(), 0);

        _armFee(0.0005 ether, address(new PlainSink()));

        // The already-created campaign is untouched by the owner's fee change.
        assertEq(free.claimFeeWei(), 0, "existing campaign re-priced by owner");
        free.claim(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT);

        // Only the next campaign snapshots the new fee.
        TegridyAirdropDistributor paid = _create(totalLeafAmount);
        assertEq(paid.claimFeeWei(), 0.0005 ether);
    }

    function test_Fee_ForwardedToSinkOnEveryClaim() public {
        PlainSink sink = new PlainSink();
        _armFee(0.0005 ether, address(sink));
        TegridyAirdropDistributor d = _create(totalLeafAmount);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        d.claimWithFee{value: 0.0005 ether}(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(address(sink).balance, 0.0005 ether);
        assertEq(address(d).balance, 0, "distributor must never retain fee ETH");

        vm.deal(bob, 1 ether);
        vm.prank(bob);
        d.claimWithFee{value: 0.0005 ether}(1, bob, B_AMT, _proof(leaves, 1));
        assertEq(address(sink).balance, 0.001 ether);
    }

    function test_Fee_FreePathBlockedWhenFeeIsSet() public {
        _armFee(0.0005 ether, address(new PlainSink()));
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.expectRevert(abi.encodeWithSelector(TegridyAirdropDistributor.ClaimFeeRequired.selector, 0.0005 ether));
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
    }

    function test_Fee_ExactValueRequired() public {
        _armFee(0.0005 ether, address(new PlainSink()));
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.deal(alice, 1 ether);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyAirdropDistributor.IncorrectClaimFee.selector, 0.0005 ether, 0.0004 ether)
        );
        d.claimWithFee{value: 0.0004 ether}(0, alice, A_AMT, _proof(leaves, 0));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyAirdropDistributor.IncorrectClaimFee.selector, 0.0005 ether, 0.0006 ether)
        );
        d.claimWithFee{value: 0.0006 ether}(0, alice, A_AMT, _proof(leaves, 0));
    }

    function test_Fee_ZeroFeeCampaignAcceptsClaimWithFeeAtZeroValue() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.prank(alice);
        d.claimWithFee{value: 0}(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT);
    }

    function test_Fee_RevertingSinkFailsTheWholeClaim() public {
        _armFee(0.0005 ether, address(new RevertingSink()));
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyAirdropDistributor.FeeForwardFailed.selector);
        d.claimWithFee{value: 0.0005 ether}(0, alice, A_AMT, _proof(leaves, 0));
        assertFalse(d.isClaimed(0), "failed fee forward must not consume the claim");
        assertEq(token.balanceOf(alice), 0);
    }

    // ─── Reentrancy ──────────────────────────────────────────────────

    function test_Reentrancy_TokenCallbackCannotDoubleClaim() public {
        MockReentrantToken rt = new MockReentrantToken();
        rt.transfer(creator, 10_000 ether);

        bytes32[] memory rl = new bytes32[](2);
        rl[0] = _leaf(0, alice, 100 ether);
        rl[1] = _leaf(1, bob, 100 ether);

        vm.startPrank(creator);
        rt.approve(address(factory), 200 ether);
        TegridyAirdropDistributor d =
            TegridyAirdropDistributor(factory.createCampaign(address(rt), _root(rl), 200 ether, WINDOW));
        vm.stopPrank();

        bytes32[] memory p0 = _proof(rl, 0);
        rt.arm(address(d), abi.encodeWithSelector(bytes4(keccak256("claim(uint256,address,uint256,bytes32[])")), uint256(0), alice, uint256(100 ether), p0));

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        d.claim(0, alice, 100 ether, p0);
    }

    function test_Reentrancy_TokenCallbackCannotReclaimMidClaim() public {
        MockReentrantToken rt = new MockReentrantToken();
        rt.transfer(creator, 10_000 ether);

        bytes32[] memory rl = new bytes32[](2);
        rl[0] = _leaf(0, alice, 100 ether);
        rl[1] = _leaf(1, bob, 100 ether);

        vm.startPrank(creator);
        rt.approve(address(factory), 200 ether);
        TegridyAirdropDistributor d =
            TegridyAirdropDistributor(factory.createCampaign(address(rt), _root(rl), 200 ether, WINDOW));
        vm.stopPrank();

        rt.arm(address(d), abi.encodeWithSelector(d.reclaim.selector));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        d.claim(0, alice, 100 ether, _proof(rl, 0));
    }

    function test_Reentrancy_FeeSinkCannotReenterClaim() public {
        ReentrantSink sink = new ReentrantSink();
        _armFee(0.0005 ether, address(sink));
        TegridyAirdropDistributor d = _create(totalLeafAmount);

        bytes32[] memory p1 = _proof(leaves, 1);
        sink.arm(address(d), abi.encodeWithSelector(bytes4(keccak256("claim(uint256,address,uint256,bytes32[])")), uint256(1), bob, B_AMT, p1));

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        d.claimWithFee{value: 0.0005 ether}(0, alice, A_AMT, _proof(leaves, 0));

        assertTrue(sink.reentryAttempted(), "sink never got the chance to re-enter");
        assertFalse(sink.reentrySucceeded(), "re-entrant claim was allowed");
        assertTrue(d.isClaimed(0));
        assertFalse(d.isClaimed(1), "re-entrancy landed a second claim");
        assertEq(token.balanceOf(bob), 0);
    }

    function test_Reentrancy_TokenCallbackCannotReenterCreateCampaign() public {
        MockReentrantToken rt = new MockReentrantToken();
        rt.transfer(creator, 10_000 ether);
        bytes32[] memory rl = new bytes32[](2);
        rl[0] = _leaf(0, alice, 100 ether);
        rl[1] = _leaf(1, bob, 100 ether);

        rt.arm(
            address(factory),
            abi.encodeWithSelector(factory.createCampaign.selector, address(rt), _root(rl), 100 ether, WINDOW)
        );
        vm.startPrank(creator);
        rt.approve(address(factory), 1000 ether);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        factory.createCampaign(address(rt), _root(rl), 200 ether, WINDOW);
        vm.stopPrank();
    }

    // ─── Pause isolation ─────────────────────────────────────────────

    function test_Pause_BlocksCreationButNotClaimsOrReclaim() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);

        vm.prank(owner);
        factory.pause();

        vm.startPrank(creator);
        token.approve(address(factory), totalLeafAmount);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createCampaign(address(token), _root(leaves), totalLeafAmount, WINDOW);
        vm.stopPrank();

        // The live campaign is entirely unaffected — no admin here can reach it.
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
        assertEq(token.balanceOf(alice), A_AMT);
        vm.warp(d.expiresAt());
        vm.prank(creator);
        d.reclaim();
    }

    function test_Pause_GuardianCanPauseNotUnpause() public {
        vm.prank(owner);
        factory.setPauseGuardian(guardian);

        vm.prank(alice);
        vm.expectRevert(PauseGuardian.NotPauseGuardian.selector);
        factory.guardianPause();

        vm.prank(guardian);
        factory.guardianPause();
        assertTrue(factory.paused());

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.unpause();

        vm.prank(owner);
        factory.unpause();
        assertFalse(factory.paused());
    }

    // ─── Ownership ───────────────────────────────────────────────────

    function test_Ownership_RenounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(OwnableNoRenounce.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    function test_Ownership_TransferIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        factory.transferOwnership(newOwner);
        assertEq(factory.owner(), owner, "ownership must not move until accepted");
        vm.prank(newOwner);
        factory.acceptOwnership();
        assertEq(factory.owner(), newOwner);
    }

    /// @dev The distributor has no admin surface at all. Enumerated as a test because it
    ///      is the property that lets a campaign page promise the creator cannot be rugged
    ///      by the venue.
    function test_Distributor_HasNoOwnerOrPause() public {
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        (bool okOwner,) = address(d).call(abi.encodeWithSignature("owner()"));
        assertFalse(okOwner, "distributor must expose no owner()");
        (bool okPause,) = address(d).call(abi.encodeWithSignature("pause()"));
        assertFalse(okPause, "distributor must expose no pause()");
        (bool okSweep,) = address(d).call(abi.encodeWithSignature("sweep(address)", address(token)));
        assertFalse(okSweep, "distributor must expose no sweep()");
    }

    // ─── Registry views ──────────────────────────────────────────────

    function test_Registry_Views() public {
        TegridyAirdropDistributor d1 = _create(totalLeafAmount);
        TegridyAirdropDistributor d2 = _create(totalLeafAmount);

        assertEq(factory.campaignCount(), 2);
        assertEq(factory.campaignsOf(creator).length, 2);
        assertEq(factory.campaignsForToken(address(token)).length, 2);
        assertEq(factory.campaignsOf(alice).length, 0);

        (address[] memory page, uint256 next) = factory.campaignsSlice(0, 1);
        assertEq(page.length, 1);
        assertEq(page[0], address(d1));
        assertEq(next, 1, "partial scan must report a continuation offset");

        (page, next) = factory.campaignsSlice(1, 10);
        assertEq(page.length, 1);
        assertEq(page[0], address(d2));
        assertEq(next, 0, "complete scan must report zero");

        (page, next) = factory.campaignsSlice(5, 10);
        assertEq(page.length, 0);
        assertEq(next, 0);
    }

    function test_Registry_UnknownAddressIsNotVouchedFor() public view {
        assertFalse(factory.isCampaign(address(0xDEAD)));
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_ClaimPaysExactlyTheLeafAmount(uint96 rawA, uint96 rawB) public {
        // Bounded by what the creator actually holds; the property under test is
        // exact-payout, not the token's own balance arithmetic.
        uint256 a = bound(uint256(rawA), 0, 200_000 ether);
        uint256 b = bound(uint256(rawB), 0, 200_000 ether);
        vm.assume(a + b > 0);
        address u1 = address(0xA11CE);
        address u2 = address(0xB0B);

        bytes32[] memory fl = new bytes32[](2);
        fl[0] = _leaf(0, u1, a);
        fl[1] = _leaf(1, u2, b);
        uint256 total = uint256(a) + uint256(b);

        vm.startPrank(creator);
        token.approve(address(factory), total);
        TegridyAirdropDistributor d =
            TegridyAirdropDistributor(factory.createCampaign(address(token), _root(fl), total, 30 days));
        vm.stopPrank();

        d.claim(0, u1, a, _proof(fl, 0));
        d.claim(1, u2, b, _proof(fl, 1));
        assertEq(token.balanceOf(u1), a);
        assertEq(token.balanceOf(u2), b);
        assertEq(token.balanceOf(address(d)), 0, "campaign must be exactly drained");
    }

    function testFuzz_ClaimsAlwaysClosedAtOrAfterExpiry(uint64 offset) public {
        offset = uint64(bound(offset, 0, 3650 days));
        TegridyAirdropDistributor d = _create(totalLeafAmount);
        uint64 exp = d.expiresAt();
        vm.warp(uint256(exp) + offset);
        assertFalse(d.claimsOpen());
        vm.expectRevert(abi.encodeWithSelector(TegridyAirdropDistributor.ClaimWindowClosed.selector, exp));
        d.claim(0, alice, A_AMT, _proof(leaves, 0));
    }

    function testFuzz_FeeNeverExceedsCap(uint256 fee) public {
        address sink = address(new PlainSink());
        vm.prank(owner);
        factory.proposeFeeSink(sink);
        _warpToReady(factory.FEE_SINK_CHANGE());
        vm.prank(owner);
        factory.executeFeeSink(sink);

        uint256 cap = factory.MAX_CLAIM_FEE_WEI();
        if (fee > cap) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(AirdropFactory.FeeAboveCap.selector, fee, cap));
            factory.proposeClaimFee(fee);
        } else if (fee == 0) {
            vm.prank(owner);
            vm.expectRevert(AirdropFactory.ValueUnchanged.selector);
            factory.proposeClaimFee(fee);
        } else {
            vm.prank(owner);
            factory.proposeClaimFee(fee);
            _warpToReady(factory.CLAIM_FEE_CHANGE());
            vm.prank(owner);
            factory.executeClaimFee(fee);
            assertLe(factory.claimFeeWei(), cap);
        }
        assertLe(factory.claimFeeWei(), cap, "fee cap breached");
    }
}
