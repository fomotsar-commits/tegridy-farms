// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";
import "../src/StakingMonitorView.sol";
import "../src/TegridyRestaking.sol";

/// @title  The restaking escrow round-trip must be able to hand the NFT back.
///
/// @notice THE DEFECT (`StakingRewardLib.afterTokenTransfer`, the middle of three guards).
///         `afterTokenTransfer` carries three guards in ~25 lines. Two of them carve out
///         the restaking escrow; the EOA single-position guard does not:
///
///           :862  bool isEscrowTo = (to == restakingContract) || isLendingContract[to];
///                     -> the MAX_POSITIONS cap carves restaking out.
///           :871  if (to != address(0) && userTokenId[to] != 0 &&
///                     (toCodeLen == 0 || toCodeLen == 23) && !isLendingContract[from])
///                     revert AlreadyHasPosition();
///                     -> relaxes for isLendingContract[from] ONLY.
///           :882  bool escrowHop = isLendingContract[from] || isLendingContract[to] ||
///                     from == restakingContract || to == restakingContract;
///                     -> autoMaxLock carves restaking out.
///
///         `restakingContract` and `isLendingContract` are separate slots written by
///         separate admin paths (`applyRestakingContract` / `applyLendingContract`), and
///         every other site in the codebase tests them TOGETHER as
///         `user == restakingContract || isLendingContract[user]` (TegridyStaking:800,
///         :863). The restaking contract is therefore never in `isLendingContract`, and
///         the middle guard never relaxes for it.
///
/// @notice THE SEQUENCE (a plain user, nothing malicious, four ordinary calls):
///           1. stake()             -> position #1, userTokenId[user] = 1
///           2. restake(#1)         -> NFT user -> restaking. The guard does not fire
///                                     (the escrow has code), and :889 zeroes
///                                     userTokenId[user].
///           3. stake()             -> position #2 is admitted PRECISELY BECAUSE step 2
///                                     zeroed the pointer (`stake` gates on
///                                     `userTokenId[msg.sender] != 0`).
///           4. unrestake()         -> NFT restaking -> user. `to` is now an EOA,
///                                     userTokenId[user] == 2, and
///                                     !isLendingContract[restaking] holds
///                                     -> revert AlreadyHasPosition().
///
/// @notice WHAT ACTUALLY HAPPENS AT STEP 4 (verified, and NOT what a static read of the
///         guard suggests): `unrestake` does not revert. It routes the return through
///         `TegridyRestaking._returnNftSettleResidual`, whose
///         `try stakingNFT.safeTransferFrom(...) { } catch { }` swallows the revert and
///         books `strandedRestakeRecipient[tokenId] = recipient`. So the exit SUCCEEDS,
///         the restaking-side position record is deleted, and the NFT stays behind at the
///         escrow. The user's only retry, `claimStrandedRestakeNFT`, calls
///         `safeTransferFrom` BARE - it reverts on every attempt for as long as the user
///         holds position #2. `emergencyWithdrawNFT` shares the same helper verbatim, so
///         the designated escape hatch strands identically.
///
/// @notice THE FIX: the middle guard relaxes on `from == restakingContract` too, which is
///         the same from-side predicate `escrowHop` already computes six lines below.
///         The MAX_POSITIONS cap is deliberately NOT relaxed - see
///         `test_positionCapIsASeparateBound_escrowReturnStillBlockedAtTheCap`.
contract StakingRestakeReturnStrandingTest is Test {
    StrandToken public toweli;
    StrandNFT public jbac;
    StrandWETH public weth;

    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyStakingJbacVault public vault;
    StakingMonitorView public monitor;
    TegridyRestaking public restaking;

    /// @dev A whitelisted `isLendingContract` escrow - the carve-out that ALREADY exists.
    StrandEscrow public lending;

    address public treasury = makeAddr("strand_treasury");
    address public alice = makeAddr("strand_alice");
    address public bob = makeAddr("strand_bob");
    address public carol = makeAddr("strand_carol");

    uint256 constant REWARD_RATE = 1e14;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant LOCK = 365 days;

    /// @dev Mirror of TegridyStaking.MAX_POSITIONS_PER_HOLDER (internal there).
    uint256 constant MAX_POSITIONS_PER_HOLDER = 50;

    uint256 public t1;

    function setUp() public {
        toweli = new StrandToken();
        jbac = new StrandNFT();
        weth = new StrandWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        restaking = new TegridyRestaking(
            address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE
        );
        lending = new StrandEscrow(staking);

        toweli.approve(address(staking), 2_000_000 ether);
        staking.notifyRewardAmount(2_000_000 ether);
        weth.transfer(address(restaking), 100_000 ether);

        stakingAdmin.proposeRestakingContract(address(restaking));
        stakingAdmin.proposeLendingContract(address(lending), true);
        stakingAdmin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        stakingAdmin.executeRestakingContract();
        stakingAdmin.executeLendingContract();
        stakingAdmin.executeMaxUnsettledRewards();

        assertEq(staking.restakingContract(), address(restaking), "setup: restaking linked");
        assertTrue(staking.isLendingContract(address(lending)), "setup: lending whitelisted");
        // THE PRECONDITION THE WHOLE DEFECT RESTS ON: the two registries are disjoint.
        assertFalse(
            staking.isLendingContract(address(restaking)),
            "setup: the restaking contract is NOT a lending contract"
        );

        toweli.transfer(alice, 4 * STAKE_AMOUNT);
        toweli.transfer(bob, STAKE_AMOUNT);
        toweli.transfer(carol, STAKE_AMOUNT);

        t1 = _stake(alice);

        // Clear TRANSFER_COOLDOWN (24h from stakeTimestamp) so the escrow hop is legal.
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
    }

    // --------------------------- helpers ---------------------------

    function _stake(address who) internal returns (uint256 id) {
        vm.startPrank(who);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, LOCK);
        id = staking.userTokenId(who);
        vm.stopPrank();
    }

    /// @dev Steps 1-3 of the sequence: escrow position #1 at restaking, then open #2.
    ///      Returns the tokenId of the second position.
    function _restakeThenStakeAgain() internal returns (uint256 t2) {
        vm.startPrank(alice);
        staking.approve(address(restaking), t1);
        restaking.restake(t1);
        vm.stopPrank();

        assertEq(staking.ownerOf(t1), address(restaking), "step 2: NFT escrowed at restaking");
        assertEq(staking.userTokenId(alice), 0, "step 2: the escrow hop zeroed the pointer");

        t2 = _stake(alice);
        assertTrue(t2 != 0 && t2 != t1, "step 3: a second position exists");
        assertEq(staking.userTokenId(alice), t2, "step 3: pointer now names position #2");

        vm.warp(vm.getBlockTimestamp() + 30 days);
    }

    /// @dev The post-return invariants. Every one of them fails pre-fix, because the
    ///      escrow still holds the NFT.
    function _assertReturned(uint256 t2) internal view {
        assertEq(staking.ownerOf(t1), alice, "the escrowed NFT must come home");
        assertEq(staking.ownerOf(t2), alice, "the second position is untouched");
        assertEq(staking.balanceOf(alice), 2, "alice holds both positions");
        assertEq(
            restaking.strandedRestakeRecipient(t1),
            address(0),
            "no stranded record may be booked on a healthy exit"
        );
        assertEq(staking.balanceOf(address(restaking)), 0, "the escrow keeps nothing");
    }

    // ================= THE DEFECT: unrestake strands the NFT =================

    /// PRE-FIX: `_returnNftSettleResidual`'s try/catch swallows AlreadyHasPosition, the
    ///          restaking-side record is already deleted, and the NFT sits at the escrow
    ///          with `strandedRestakeRecipient[t1] = alice`.
    /// POST-FIX: `from == restakingContract` relaxes the guard and the transfer lands.
    function test_unrestake_afterASecondStake_returnsTheEscrowedNFT() public {
        uint256 t2 = _restakeThenStakeAgain();

        vm.prank(alice);
        restaking.unrestake();

        _assertReturned(t2);
    }

    /// The designated escape hatch shares `_returnNftSettleResidual` verbatim, so it
    /// strands on exactly the same guard. Pinned separately: a fix that only taught
    /// `unrestake` to survive would leave the emergency path broken.
    function test_emergencyWithdrawNFT_afterASecondStake_returnsTheEscrowedNFT() public {
        uint256 t2 = _restakeThenStakeAgain();

        vm.prank(alice);
        restaking.emergencyWithdrawNFT();

        _assertReturned(t2);
    }

    /// The user-visible dead end, pinned on its own: pre-fix the ONLY retry path the
    /// contract offers (`claimStrandedRestakeNFT`, a BARE safeTransferFrom) reverts on
    /// every attempt for as long as position #2 is held, so the record it needs survives
    /// the rollback and the NFT never moves. Post-fix nothing is ever stranded, so the
    /// retry has nothing to claim.
    function test_noStrandedRecordSurvivesTheRoundTrip() public {
        _restakeThenStakeAgain();

        vm.prank(alice);
        restaking.unrestake();

        assertEq(
            restaking.strandedRestakeRecipient(t1),
            address(0),
            "pre-fix this is alice, and claimStrandedRestakeNFT reverts AlreadyHasPosition forever"
        );

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.NotRestakedToken.selector);
        restaking.claimStrandedRestakeNFT(t1);
    }

    // ================= BREADTH: the guard must still bite =================

    /// The relaxation is FROM-side and escrow-only. A plain holder-to-holder transfer into
    /// an EOA that already has a position must still revert. Passes pre- AND post-fix -
    /// it exists to catch an over-broad fix (e.g. dropping the guard, or relaxing on the
    /// `to` side).
    function test_plainTransferIntoAnOccupiedEOA_stillReverts() public {
        uint256 bobId = _stake(bob);
        _stake(carol);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(bob, carol, bobId);
    }

    /// A non-escrow CONTRACT sender is still not a carve-out either.
    function test_transferFromAPlainContractIntoAnOccupiedEOA_stillReverts() public {
        uint256 bobId = _stake(bob);
        _stake(carol);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);

        StrandEscrow plain = new StrandEscrow(staking); // deployed, never whitelisted
        vm.prank(bob);
        staking.transferFrom(bob, address(plain), bobId);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);

        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        plain.send(carol, bobId);
    }

    /// The pre-existing lending carve-out must survive the edit untouched: the same
    /// four-step sequence through a WHITELISTED lending escrow already returns the NFT.
    /// Passes pre- AND post-fix.
    function test_lendingRoundTripRelaxation_isUnchanged() public {
        vm.prank(alice);
        staking.transferFrom(alice, address(lending), t1);
        assertEq(staking.userTokenId(alice), 0, "lending hop zeroed the pointer");

        uint256 t2 = _stake(alice);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);

        lending.send(alice, t1); // relaxed by isLendingContract[from]

        assertEq(staking.ownerOf(t1), alice, "lending returns the NFT");
        assertEq(staking.ownerOf(t2), alice, "second position untouched");
        assertEq(staking.balanceOf(alice), 2, "alice holds both");
    }

    // ============ THE POSITION CAP: same shape, different verdict ============

    /// @notice The MAX_POSITIONS_PER_HOLDER guard has NO from-side relaxation at all -
    ///         not for lending, not for restaking - so a holder sitting exactly at the cap
    ///         when an escrow tries to hand a position back is stranded the same way.
    ///
    ///         It is NOT fixed the same way, and this test is the reason. The cap is what
    ///         BOUNDS the from-side relaxation: because the EOA guard relaxes on an escrow
    ///         return, a holder can legitimately climb past one position (escrow one, open
    ///         another, take the first back). Relaxing the cap on escrow returns would let
    ///         that loop run forever - return at 51, escrow one, receive one, return at
    ///         52, ... - and the cost of an unbounded set is NOT paid by the holder alone.
    ///         Per TegridyStaking:245 (AUDIT C-2, rated HIGH), the cap was cut 100 -> 50
    ///         because "every external integrator that reads votingPowerOf - ReferralSplitter
    ///         on each fee credit, RevenueDistributor's checkpoint-fallback path,
    ///         governance/voting consumers - pays the O(n) cost". If merely DOUBLING the
    ///         bound was a HIGH, removing it on a permissionless path is a regression, not
    ///         a fix. (Push-grief, the cap's other stated job, is not the constraint here:
    ///         restaking only ever returns a position to the address that deposited it.)
    ///
    ///         So the cap stays strict, and the stuck state it produces is BOUNDED and
    ///         SELF-RECOVERABLE: shed one position and the retry path clears it. This test
    ///         pins both halves. It passes pre- AND post-fix - the cap guard is not edited.
    function test_positionCapIsASeparateBound_escrowReturnStillBlockedAtTheCap() public {
        CapHolder holder = new CapHolder(staking, restaking);

        // Fill the holder to exactly the cap.
        uint256[] memory ids = new uint256[](MAX_POSITIONS_PER_HOLDER + 1);
        address[] memory owners = new address[](MAX_POSITIONS_PER_HOLDER + 1);
        for (uint256 i = 0; i < MAX_POSITIONS_PER_HOLDER + 1; i++) {
            owners[i] = address(uint160(uint256(keccak256(abi.encodePacked("capstaker", i)))));
            toweli.transfer(owners[i], STAKE_AMOUNT);
            ids[i] = _stake(owners[i]);
        }
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        for (uint256 i = 0; i < MAX_POSITIONS_PER_HOLDER; i++) {
            vm.prank(owners[i]);
            staking.transferFrom(owners[i], address(holder), ids[i]);
        }
        assertEq(staking.balanceOf(address(holder)), MAX_POSITIONS_PER_HOLDER, "holder is at the cap");

        // Escrow one (frees a slot), then take delivery of the spare so the holder is back
        // at the cap while the escrow still owes it a position.
        holder.doRestake(ids[0]);
        assertEq(staking.balanceOf(address(holder)), MAX_POSITIONS_PER_HOLDER - 1, "one slot freed");
        vm.prank(owners[MAX_POSITIONS_PER_HOLDER]);
        staking.transferFrom(owners[MAX_POSITIONS_PER_HOLDER], address(holder), ids[MAX_POSITIONS_PER_HOLDER]);
        assertEq(staking.balanceOf(address(holder)), MAX_POSITIONS_PER_HOLDER, "back at the cap");

        vm.warp(vm.getBlockTimestamp() + 30 days);

        // The exit reports success; the NFT does not arrive.
        holder.doUnrestake();
        assertEq(staking.ownerOf(ids[0]), address(restaking), "cap: the escrow still holds it");
        assertEq(
            restaking.strandedRestakeRecipient(ids[0]),
            address(holder),
            "cap: the return was recorded as stranded"
        );

        // The retry is blocked by the cap, not by the EOA guard - and stays blocked.
        vm.expectRevert(TegridyStaking.TooManyPositions.selector);
        holder.doClaimStranded(ids[0]);
        assertEq(
            restaking.strandedRestakeRecipient(ids[0]),
            address(holder),
            "cap: the failed retry rolled back, so the claim record survives"
        );

        // BOUNDED + SELF-RECOVERABLE: shed one, and the same retry clears.
        holder.send(carol, ids[1]);
        holder.doClaimStranded(ids[0]);
        assertEq(staking.ownerOf(ids[0]), address(holder), "cap: recovered after shedding one");
        assertEq(staking.balanceOf(address(holder)), MAX_POSITIONS_PER_HOLDER, "cap: still exactly at the cap");
    }
}

// --- Mocks ----------------------------------------------------------

contract StrandToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract StrandNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract StrandWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Stands in for TegridyLending when whitelisted, and for an ordinary
///      non-escrow contract holder when it is not.
contract StrandEscrow {
    TegridyStaking public immutable staking;

    constructor(TegridyStaking _staking) {
        staking = _staking;
    }

    function send(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev A contract holder that can sit at MAX_POSITIONS_PER_HOLDER and drive the
///      restaking round-trip itself.
contract CapHolder {
    TegridyStaking public immutable staking;
    TegridyRestaking public immutable restaking;

    constructor(TegridyStaking _staking, TegridyRestaking _restaking) {
        staking = _staking;
        restaking = _restaking;
    }

    function doRestake(uint256 tokenId) external {
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
    }

    function doUnrestake() external {
        restaking.unrestake();
    }

    function doClaimStranded(uint256 tokenId) external {
        restaking.claimStrandedRestakeNFT(tokenId);
    }

    function send(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
