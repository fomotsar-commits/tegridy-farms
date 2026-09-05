// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyRestaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// ======================================================================
//  Mocks (mirrors the AuditR014_Restaking harness)
// ======================================================================

contract SRG_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract SRG_MockJBAC is ERC721 {
    constructor() ERC721("JBAC", "JBAC") {}
}

contract SRG_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 100_000_000 ether);
    }
}

/// @notice A contract staker whose ERC721 hook can be switched off after it has
///         already taken custody. This is the ONE thing that still strands a
///         restake NFT after the upstream guard fix, and it is not contrived:
///         a contract wallet, a paused Safe module, or an EIP-7702 delegated EOA
///         whose hook starts reverting all present exactly this way. It accepts
///         the NFT on the way in (so it can stake and restake at all) and refuses
///         it on the way back.
contract ToggleReceiver {
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
        require(!rejecting, "ToggleReceiver: refusing");
        return this.onERC721Received.selector;
    }
}

/// @title  Stranded-restake return: the recovery path needs a destination
///
/// @notice REBASED 2026-09-05. This suite originally proved the fix against the
///         `stake -> restake -> stake` guard disagreement in
///         `StakingRewardLib.afterTokenTransfer`. **That path is CLOSED** — PR
///         #397 (`56ed6bd2`) relaxed the EOA single-position guard on the escrow
///         hop, so the return now delivers and nothing is stranded. Every test
///         here used to construct that scenario, and after #397 they failed for
///         the best possible reason: the bug they described was gone.
///
///         The fix under test is NOT gone, because stranding is still reachable.
///         `TegridyRestaking._returnNftSettleResidual` wraps the return in a
///         try/catch that books `strandedRestakeRecipient` on ANY
///         `safeTransferFrom` failure — the guard was only one cause. A recipient
///         whose `onERC721Received` reverts still strands the NFT today.
///
///         And on the pre-fix code that is terminal: `claimStrandedRestakeNFT`
///         took only a tokenId and transferred to `msg.sender`, which is the same
///         address that just refused delivery. The retry re-runs the identical
///         failing transfer forever. The `recipient` parameter is the whole exit.
///
/// @dev    WHY THE FIX STAYS ON THE RESTAKING SIDE. `StakingRewardLib` is deployed
///         and linked into the live `TegridyStaking`, so guard-side changes reach
///         production only through a redeploy. `TegridyRestaking` is not deployed
///         at all (`restakingContract()` reads address(0) on mainnet), so this
///         path is free to change today. Mirrors
///         `TegridyPositionMarket.cancel(orderId, recipient)`, which already
///         carries a recipient for the identical trap.
///
/// @dev    MUTATION CHECK. `test_strandedNFT_recoversToAnAddressThatCanReceive`
///         is the one that dies without the fix — revert the signature to
///         `(tokenId)` transferring to `msg.sender` and the recovery becomes
///         impossible, while the three refusal tests stay green. Those are the
///         anti-vacuity half: they prove the change widened WHERE the NFT may
///         land, not WHO may move it.
contract RestakingStrandedReturnGuardTest is Test {
    SRG_MockTOWELI toweli;
    SRG_MockJBAC jbac;
    SRG_MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;
    ToggleReceiver receiver;

    address alice = makeAddr("alice");
    address aliceAlt = makeAddr("aliceAlt"); // fresh EOA, always able to receive
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant LOCK = 7 days + 1;

    function setUp() public {
        toweli = new SRG_MockTOWELI();
        jbac = new SRG_MockJBAC();
        weth = new SRG_MockWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE
        );

        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        toweli.approve(address(staking), 500_000_000 ether);
        staking.notifyRewardAmount(500_000_000 ether);
        weth.transfer(address(restaking), 1_000_000 ether);

        toweli.transfer(alice, STAKE_AMOUNT * 4);
        toweli.transfer(bob, STAKE_AMOUNT * 4);

        receiver = new ToggleReceiver(staking, restaking);
        toweli.transfer(address(receiver), STAKE_AMOUNT * 2);
    }

    // --- helpers ------------------------------------------------------

    function _stake(address user, uint256 amount) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), amount);
        staking.stake(amount, LOCK);
        tokenId = staking.userTokenId(user);
        vm.stopPrank();
    }

    /// @dev Drives the still-reachable flow to the stranded state: the receiver
    ///      takes custody while its hook accepts, then stops accepting before the
    ///      return leg runs.
    function _driveToStrandedState() internal returns (uint256 restakedId) {
        receiver.doStake(IERC20(address(toweli)), STAKE_AMOUNT, LOCK);
        restakedId = staking.userTokenId(address(receiver));
        assertTrue(restakedId != 0, "receiver should hold a position");

        // TRANSFER_COOLDOWN is 24h from stakeTimestamp; the restaking hop is exempt
        // from the 1h rate limit but not from the cooldown.
        vm.warp(block.timestamp + 24 hours + 1);
        receiver.doRestake(restakedId);
        assertEq(staking.ownerOf(restakedId), address(restaking), "restaking should custody it");

        // The hook goes hostile only AFTER custody moved — the shape a contract
        // wallet takes when it is paused or upgraded mid-position.
        receiver.setRejecting(true);

        receiver.doUnrestake();

        assertEq(
            staking.ownerOf(restakedId),
            address(restaking),
            "NFT should still be custodied after the refused return"
        );
        assertEq(
            restaking.strandedRestakeRecipient(restakedId),
            address(receiver),
            "strand record should name the receiver"
        );
    }

    // --- the upstream fix, pinned so nobody rebuilds this on sand ------

    /// @notice #397 CLOSED THE ORIGINAL PATH. `stake -> restake -> stake` no
    ///         longer strands anything: the guard now relaxes on the escrow hop,
    ///         so `unrestake` delivers. This test exists so that if anyone
    ///         reintroduces the old scenario as a regression test, they find out
    ///         here instead of debugging a suite that cannot fail.
    function test_theOriginalGuardScenario_noLongerStrands() public {
        uint256 restakedId = _stake(alice, STAKE_AMOUNT);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), restakedId);
        restaking.restake(restakedId);
        vm.stopPrank();

        assertEq(staking.userTokenId(alice), 0, "restake zeroes the legacy pointer");
        uint256 secondId = _stake(alice, STAKE_AMOUNT);
        assertTrue(secondId != 0 && secondId != restakedId, "second position opens");

        vm.prank(alice);
        restaking.unrestake();

        assertEq(staking.ownerOf(restakedId), alice, "post-#397 the NFT comes home");
        assertEq(
            restaking.strandedRestakeRecipient(restakedId), address(0), "and nothing is stranded"
        );
    }

    // --- characterization: stranding is STILL reachable ----------------

    /// @notice Passes pre- and post-fix. It characterizes the remaining defect
    ///         rather than the fix: a recipient that refuses delivery strands the
    ///         NFT, and the exit still reports success.
    function test_refusingReceiver_stillStrandsTheNFT() public {
        uint256 restakedId = _driveToStrandedState();
        assertTrue(restakedId != 0, "stranded state reached");
    }

    // --- the fix ------------------------------------------------------

    /// @notice THE FIX. The entitled holder redirects the stranded NFT to an
    ///         address that can actually receive it, without needing its own hook
    ///         to start working again. FAILS pre-fix: the function hardcoded
    ///         `msg.sender`, the one destination guaranteed to refuse.
    function test_strandedNFT_recoversToAnAddressThatCanReceive() public {
        uint256 restakedId = _driveToStrandedState();

        receiver.doClaimStranded(restakedId, aliceAlt);

        assertEq(staking.ownerOf(restakedId), aliceAlt, "NFT recovered to a working address");
        assertEq(
            restaking.strandedRestakeRecipient(restakedId), address(0), "strand record cleared"
        );
    }

    // --- anti-vacuity: WHO may move it is unchanged --------------------

    /// @notice Retrying to the refusing address still fails. This is inherent to
    ///         the receiver, not a regression — and it is exactly why a recipient
    ///         parameter had to exist at all.
    function test_retryToSelf_stillFails_whichIsWhyTheParameterExists() public {
        uint256 restakedId = _driveToStrandedState();

        vm.expectRevert();
        receiver.doClaimStranded(restakedId, address(receiver));

        assertEq(
            restaking.strandedRestakeRecipient(restakedId),
            address(receiver),
            "strand record must survive a failed retry"
        );
    }

    /// @notice The parameter widened WHERE the NFT lands, never WHO may move it.
    ///         A stranger cannot redirect someone else's stranded NFT.
    function test_onlyTheEntitledRecipientMayRedirect() public {
        uint256 restakedId = _driveToStrandedState();

        vm.prank(bob);
        vm.expectRevert(TegridyRestaking.NotRestakedToken.selector);
        restaking.claimStrandedRestakeNFT(restakedId, bob);

        assertEq(
            restaking.strandedRestakeRecipient(restakedId),
            address(receiver),
            "strand record intact after an unauthorized attempt"
        );
    }

    /// @notice A zero recipient is refused with a typed error. Honest scope: this
    ///         is clarity, not security — Solady's transfer already reverts on the
    ///         zero address. It is pinned so the error cannot silently regress to
    ///         an opaque one.
    function test_zeroRecipient_isRefused() public {
        uint256 restakedId = _driveToStrandedState();

        vm.expectRevert(TegridyRestaking.ZeroAddress.selector);
        receiver.doClaimStranded(restakedId, address(0));

        assertEq(
            restaking.strandedRestakeRecipient(restakedId),
            address(receiver),
            "strand record intact after a rejected zero-recipient call"
        );
    }
}
