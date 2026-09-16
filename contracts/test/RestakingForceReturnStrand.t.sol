// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyRestaking.sol";
import "../src/TegridyRestakingAdmin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// ======================================================================
//  Mocks (mirrors the RestakingStrandedReturnGuard harness)
// ======================================================================

contract FRS_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract FRS_MockJBAC is ERC721 {
    constructor() ERC721("JBAC", "JBAC") {}
}

contract FRS_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 100_000_000 ether);
    }
}

/// @notice A contract restaker whose ERC721 hook can be switched off after it has
///         already taken custody — a contract wallet, a paused Safe module, or an
///         EIP-7702-delegated EOA whose hook starts reverting mid-position. It
///         accepts on the way in (so it can stake and restake at all) and refuses
///         on the way back, which is what puts `emergencyForceReturn` into its
///         catch arm.
contract FRS_ToggleReceiver {
    TegridyStaking public immutable staking;
    TegridyRestaking public immutable restaking;
    bool public rejecting;

    constructor(TegridyStaking _staking, TegridyRestaking _restaking) {
        staking = _staking;
        restaking = _restaking;
    }

    function setRejecting(bool v) external {
        rejecting = v;
    }

    function doStake(IERC20 token, uint256 amount, uint256 lock) external {
        token.approve(address(staking), amount);
        staking.stake(amount, lock);
    }

    function doRestake(uint256 tokenId) external {
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
    }

    function doUnrestake() external {
        restaking.unrestake();
    }

    function doClaimStranded(uint256 tokenId, address recipient) external {
        restaking.claimStrandedRestakeNFT(tokenId, recipient);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(!rejecting, "FRS_ToggleReceiver: refusing");
        return this.onERC721Received.selector;
    }
}

/// @title  emergencyForceReturn's strand branch, and the escrow-as-recipient foot-gun
///
/// @notice TWO GAPS, one harness.
///
///         GAP 1 — `TegridyRestaking.emergencyForceReturn`'s catch arm had no test
///         at all. Every other suite drives the strand through `unrestake` to a
///         `makeAddr` EOA, which always accepts. The force-return arm is a
///         DISTINCT assignment: it books `restaker` (not `msg.sender`), and unlike
///         `unrestake` / `emergencyWithdrawNFT` it PRESERVES `tokenIdToRestaker`,
///         which is what makes gap 2 bite hardest exactly here.
///
///         GAP 2 — the foot-gun PR #400 introduced. Widening
///         `claimStrandedRestakeNFT` to take a `recipient` made the escrow itself
///         a legal destination: `TegridyRestaking.onERC721Received` accepts ANY
///         transfer whose `msg.sender` is the staking NFT, so a claim to
///         `address(restaking)` SUCCEEDS. It deletes the strand record, the NFT
///         stays in escrow, and the user's self-service exit is gone. Impossible
///         before #400, when the destination was forced to `msg.sender`.
///
/// @dev    MEASURED SEVERITY (pre-fix, run 2026-09-10 against 37346f3c — recorded
///         here because the written-down account was wrong in both directions).
///
///           * On the FORCE-RETURN strand the owner's 48h rescue is NOT available:
///             `proposeRescueNFT` / `applyRescueNFT` both reject while
///             `tokenIdToRestaker != 0`, and this branch deliberately preserves it.
///             That is true before the foot-gun too — the memo's "recoverable only
///             by owner `applyRescueNFT`" does not hold on this branch.
///           * It is NOT unrecoverable either: a REPEAT `emergencyForceReturn`
///             still runs (empty `RestakeInfo`, zero-clamped arithmetic) and
///             re-arms `strandedRestakeRecipient`. So the claim that the foot-gun
///             defeats BOTH owner rescue paths is too strong.
///
///         Net: self-inflicted, and it converts a self-service exit into one that
///         needs the owner to PAUSE the whole contract and burn a rate-limited
///         emergency primitive. That is worth a one-line refusal, not a redesign.
///
/// @dev    WHY REJECTING `address(this)` IS SUFFICIENT.
///         `test_theEscrowIsTheOnlyProtocolAddressThatAcceptsThePosition` pins the
///         reason: every other protocol address (`staking`, the admin sister)
///         carries no `onERC721Received`, so `safeTransferFrom` reverts there on
///         its own and the strand record survives for another attempt. The escrow
///         is the single reachable orphan sink, so one comparison closes it. A
///         user-owned contract that forwards the NFT back into escrow is out of
///         reach of any destination check and stays the user's own business.
///
/// @dev    MUTATION CHECK. `test_claimToTheEscrowItself_isRefused` is the one that
///         dies without the fix: delete the `recipient == address(this)` line in
///         `claimStrandedRestakeNFT` and it fails with "call did not revert as
///         expected". The other five stay green either way — they are the
///         anti-vacuity half, proving the refusal did not narrow the legitimate
///         exit.
contract RestakingForceReturnStrandTest is Test {
    FRS_MockTOWELI toweli;
    FRS_MockJBAC jbac;
    FRS_MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;
    TegridyRestakingAdmin restakingAdmin;
    FRS_ToggleReceiver receiver;

    address alt = makeAddr("alt"); // fresh EOA, always able to receive
    address treasury = makeAddr("treasury");
    address rescueTo = makeAddr("rescueTo");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant LOCK = 30 days;

    event RestakeNFTStranded(uint256 indexed tokenId, address indexed to);
    event EmergencyForceReturn(address indexed restaker, uint256 indexed tokenId, bool nftReturned);

    function setUp() public {
        toweli = new FRS_MockTOWELI();
        jbac = new FRS_MockJBAC();
        weth = new FRS_MockWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE
        );
        restakingAdmin = new TegridyRestakingAdmin(address(restaking));
        restaking.setRestakingAdmin(address(restakingAdmin));

        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        toweli.approve(address(staking), 500_000_000 ether);
        staking.notifyRewardAmount(500_000_000 ether);
        weth.transfer(address(restaking), 1_000_000 ether);

        receiver = new FRS_ToggleReceiver(staking, restaking);
        toweli.transfer(address(receiver), STAKE_AMOUNT * 2);
    }

    // --- helpers ------------------------------------------------------

    /// @dev Custody moves while the hook accepts; the hook goes hostile only after,
    ///      so the owner's force-return lands in the catch arm.
    function _restakedPosition() internal returns (uint256 tokenId) {
        receiver.doStake(IERC20(address(toweli)), STAKE_AMOUNT, LOCK);
        tokenId = staking.userTokenId(address(receiver));
        assertTrue(tokenId != 0, "receiver should hold a position");

        // TRANSFER_COOLDOWN is 24h from stakeTimestamp; the restaking hop is exempt
        // from the 1h rate limit but not from the cooldown.
        vm.warp(block.timestamp + 24 hours + 1);
        receiver.doRestake(tokenId);
        assertEq(staking.ownerOf(tokenId), address(restaking), "restaking should custody it");

        receiver.setRejecting(true);
    }

    function _forceReturnStrand() internal returns (uint256 tokenId) {
        tokenId = _restakedPosition();
        restaking.pause();
        vm.warp(block.timestamp + restaking.FORCE_RETURN_COOLDOWN() + 1);
        restaking.emergencyForceReturn(tokenId);
    }

    // --- GAP 1: the force-return strand branch, previously untested ----

    /// @notice The catch arm at `TegridyRestaking.emergencyForceReturn` books the
    ///         strand and reports `nftReturned == false`, while the restaking-side
    ///         position state is torn down regardless.
    function test_emergencyForceReturn_strandsInsteadOfLosingTheNFT() public {
        uint256 tokenId = _restakedPosition();
        restaking.pause();
        vm.warp(block.timestamp + restaking.FORCE_RETURN_COOLDOWN() + 1);

        vm.expectEmit(true, true, false, true, address(restaking));
        emit RestakeNFTStranded(tokenId, address(receiver));
        vm.expectEmit(true, true, false, true, address(restaking));
        emit EmergencyForceReturn(address(receiver), tokenId, false);
        restaking.emergencyForceReturn(tokenId);

        assertEq(staking.ownerOf(tokenId), address(restaking), "NFT stays custodied on a refused return");
        assertEq(
            restaking.strandedRestakeRecipient(tokenId),
            address(receiver),
            "strand record must name the original restaker, not the caller"
        );
        (, uint256 positionAmount, uint256 boostedAmount,,,) = restaking.restakers(address(receiver));
        assertEq(positionAmount, 0, "restaking-side position torn down");
        assertEq(boostedAmount, 0, "boost zeroed before the transfer attempt (CEI)");
    }

    /// @notice The property that makes this branch its own case: `unrestake`
    ///         deletes `tokenIdToRestaker` before the transfer, `emergencyForceReturn`
    ///         keeps it. Both arrive at a stranded NFT; only one leaves the
    ///         restaker link standing. Asserted as the DIFFERENCE between the two
    ///         paths so a rename or a refactor that preserves the behaviour keeps
    ///         this green.
    function test_forceReturnStrand_keepsTheRestakerLink_unlikeTheUnrestakeStrand() public {
        uint256 forcedId = _forceReturnStrand();
        assertEq(
            restaking.tokenIdToRestaker(forcedId),
            address(receiver),
            "force-return preserves the restaker link on the strand"
        );

        // Same receiver, second position, strand reached through unrestake instead.
        restaking.unpause();
        receiver.setRejecting(false);
        receiver.doStake(IERC20(address(toweli)), STAKE_AMOUNT, LOCK);
        uint256 unrestakedId = staking.userTokenId(address(receiver));
        vm.warp(block.timestamp + 24 hours + 1);
        receiver.doRestake(unrestakedId);
        receiver.setRejecting(true);
        receiver.doUnrestake();

        assertEq(
            restaking.strandedRestakeRecipient(unrestakedId),
            address(receiver),
            "unrestake strands the same way"
        );
        assertEq(
            restaking.tokenIdToRestaker(unrestakedId),
            address(0),
            "but unrestake clears the restaker link, which is why the two branches differ"
        );
    }

    /// @notice The strand really is exitable: the entitled holder redirects to an
    ///         address that can receive. This is the behaviour the fix must not
    ///         narrow.
    function test_forceReturnStrand_recoversToAnAddressThatCanReceive() public {
        uint256 tokenId = _forceReturnStrand();

        receiver.doClaimStranded(tokenId, alt);

        assertEq(staking.ownerOf(tokenId), alt, "NFT recovered to a working address");
        assertEq(restaking.strandedRestakeRecipient(tokenId), address(0), "strand record cleared");
    }

    /// @notice Context for GAP 2, and true before it as well: on THIS branch the
    ///         owner's 48h rescue is unavailable, because it refuses while a
    ///         restaker link stands and this branch deliberately keeps one. The
    ///         claim path is therefore the only self-service exit, which is what
    ///         made destroying it costly.
    function test_forceReturnStrand_ownerRescueIsBlockedByThePreservedLink() public {
        uint256 tokenId = _forceReturnStrand();

        vm.expectRevert(TegridyRestakingAdmin.BadParam.selector);
        restakingAdmin.proposeRescueNFT(tokenId, rescueTo);

        // And host-side, past the sister, with the admin's own authority.
        vm.prank(address(restakingAdmin));
        vm.expectRevert(TegridyRestaking.BadParam.selector);
        restaking.applyRescueNFT(tokenId, rescueTo);
    }

    // --- GAP 2: THE FIX -----------------------------------------------

    /// @notice THE FIX. The escrow is not a destination. Pre-fix this call
    ///         SUCCEEDS — it deletes the strand record and leaves the NFT sitting
    ///         in escrow with nothing pointing at it.
    ///
    ///         Pinned as: the call reverts, the record survives, and the real exit
    ///         still works afterwards. The last clause is the point — the refusal
    ///         must cost the user nothing.
    function test_claimToTheEscrowItself_isRefused() public {
        uint256 tokenId = _forceReturnStrand();

        vm.expectRevert(TegridyRestaking.BadParam.selector);
        receiver.doClaimStranded(tokenId, address(restaking));

        assertEq(
            restaking.strandedRestakeRecipient(tokenId),
            address(receiver),
            "strand record must survive a refused claim"
        );
        assertEq(staking.ownerOf(tokenId), address(restaking), "NFT unmoved");

        receiver.doClaimStranded(tokenId, alt);
        assertEq(staking.ownerOf(tokenId), alt, "the legitimate exit is untouched by the refusal");
    }

    /// @notice The same refusal on the `unrestake` strand, so the guard is a
    ///         property of the function rather than of one producer.
    function test_claimToTheEscrowItself_isRefused_onTheUnrestakeStrand() public {
        uint256 tokenId = _restakedPosition();
        receiver.doUnrestake();
        assertEq(restaking.strandedRestakeRecipient(tokenId), address(receiver), "stranded via unrestake");

        vm.expectRevert(TegridyRestaking.BadParam.selector);
        receiver.doClaimStranded(tokenId, address(restaking));

        assertEq(
            restaking.strandedRestakeRecipient(tokenId), address(receiver), "strand record survives"
        );
    }

    /// @notice WHY ONE COMPARISON IS ENOUGH. The escrow is the only protocol
    ///         address that will take the position NFT — it is the one with an
    ///         `onERC721Received`. Aiming a claim at the staking contract or the
    ///         admin sister reverts inside `safeTransferFrom`, so those are
    ///         self-defending and the strand record survives untouched. If a future
    ///         change gives one of them a receiver hook, this test goes red and the
    ///         destination check needs widening with it.
    function test_theEscrowIsTheOnlyProtocolAddressThatAcceptsThePosition() public {
        uint256 tokenId = _forceReturnStrand();

        vm.expectRevert();
        receiver.doClaimStranded(tokenId, address(staking));
        assertEq(
            restaking.strandedRestakeRecipient(tokenId),
            address(receiver),
            "record intact after a claim the staking contract refused"
        );

        vm.expectRevert();
        receiver.doClaimStranded(tokenId, address(restakingAdmin));
        assertEq(
            restaking.strandedRestakeRecipient(tokenId),
            address(receiver),
            "record intact after a claim the admin sister refused"
        );

        assertEq(staking.ownerOf(tokenId), address(restaking), "NFT never moved");
    }
}
