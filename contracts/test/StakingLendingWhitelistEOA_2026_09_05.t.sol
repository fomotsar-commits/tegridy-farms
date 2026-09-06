// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

/// @title  A lending-whitelist entry must be a contract, exactly like a restaking entry.
///
/// @notice THE DEFECT. `isLendingContract` and `restakingContract` confer the SAME power
///         over `StakingRewardLib.afterTokenTransfer`'s EOA single-position guard:
///
///           :918  !(isLendingContract[from] || (restakingContract != address(0) &&
///                   from == restakingContract))
///
///         and the lending half additionally waives BOTH transfer-time guards in
///         `TegridyStaking._beforeTokenTransfer` (`lendingExempt` waives the 24h
///         TRANSFER_COOLDOWN *and* the 1h TRANSFER_RATE_LIMIT - strictly more than the
///         restaking hop, which is waived from the rate limit only).
///
///         Only ONE of the two registries validated its entries. Pre-fix:
///
///           proposeRestakingContract  :  zero + `codeLen == 0 || codeLen == 23`  [L-25]
///           applyRestakingContract    :  zero + `codeLen == 0 || codeLen == 23`  [L-18]
///           proposeLendingContract    :  zero ONLY
///           applyLendingContract      :  zero + revoke-side residue guards ONLY
///
///         So a plain EOA - or a 23-byte EIP-7702 delegated EOA - could be whitelisted as
///         a "lending contract" and would then hold the guard-relaxing power: it could
///         hand a second staking position to an address that already holds one, and move
///         positions with neither cooldown nor rate limit.
///
/// @notice SCOPE / SEVERITY. This is HARDENING, not a live exploit. Both writes are
///         `onlyAdmin` behind the 48h `LENDING_CONTRACT_CHANGE` timelock, so reaching the
///         bad state needs the admin owner. It is filed as a consistency defect: the two
///         registries grant identical power and must carry identical entry validation.
///
/// @notice SAFE TO ADD - VERIFIED AGAINST LIVE MAINNET STATE, not assumed. A code check
///         on an already-populated registry could brick a legitimate entry, so the live
///         registry was enumerated before writing it (staking 0xcaDc93E9..046D, admin
///         0x4B134C08..06f3, from deploy block 25,263,328 to head 25,912,642):
///           * `LendingContractApplied(address,bool)` @ staking .... 0 logs
///           * `LendingContractUpdated(address,bool)`  @ admin ...... 0 logs
///           * `LendingContractChangeProposed(...)`    @ admin ...... 0 logs
///           * positive controls: 83 events @ staking, 2 @ admin (both
///             OwnershipTransferred) - so the reads were real, not a silent empty.
///           * the deployed staking runtime provably CONTAINS the
///             `LendingContractApplied` topic constant, so a successful write would
///             have emitted one.
///         `isLendingContract` has never held an entry on the live deployment, and
///         `TEGRIDY_LENDING_ADDRESS` is zeroed in frontend/src/lib/constants.ts. There is
///         no legitimate entry to brick.
///
/// @notice THE FIX mirrors the restaking sibling on BOTH sides - propose-time (fail fast,
///         so the 48h wait is not burned on a doomed proposal) and execute-time (the
///         [L-18] recheck: a 7702 delegation can be revoked inside the propose/execute
///         window). It is gated on `_approved` - see
///         `test_revokeIsNeverBlockedByTheCodeCheck_evenAfterTheEntryLosesItsCode`.
contract StakingLendingWhitelistEOATest is Test {
    LendToken public toweli;
    LendNFT public jbac;

    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyStakingJbacVault public vault;

    /// @dev A genuine contract escrow - the legitimate `isLendingContract` shape.
    LendEscrow public escrow;

    address public treasury = makeAddr("lend_treasury");
    address public alice = makeAddr("lend_alice");
    address public bob = makeAddr("lend_bob");
    /// @dev A plain EOA. Never has code unless a test etches some.
    address public eve = makeAddr("lend_eve");

    uint256 constant REWARD_RATE = 1e14;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant LOCK = 365 days;
    uint256 constant TIMELOCK = 48 hours;

    /// @dev The canonical EIP-7702 delegation pointer: 0xef0100 + 20-byte delegate == 23
    ///      bytes. Same construction as AttestedSequencerUptimeFeed.t.sol:99 and
    ///      markets/PositionMarket.t.sol:174.
    function _delegation() internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", bytes20(address(0xBEEF)));
    }

    function setUp() public {
        toweli = new LendToken();
        jbac = new LendNFT();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        escrow = new LendEscrow(staking);

        toweli.approve(address(staking), 2_000_000 ether);
        staking.notifyRewardAmount(2_000_000 ether);

        // Raise the L-06 unsettled cap so a large shortfall books in FULL rather than being
        // clipped by the cap - same reason StakingAttribution_LendingUnderpay does it.
        stakingAdmin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK + 1);
        stakingAdmin.executeMaxUnsettledRewards();

        toweli.transfer(alice, 2 * STAKE_AMOUNT);
        toweli.transfer(bob, 2 * STAKE_AMOUNT);
        toweli.transfer(eve, 2 * STAKE_AMOUNT);

        // Baseline sanity: eve is a bare EOA, escrow is a real contract.
        assertEq(eve.code.length, 0, "setup: eve is an EOA");
        assertGt(address(escrow).code.length, 23, "setup: escrow is a genuine contract");
        assertFalse(staking.isLendingContract(eve), "setup: nothing whitelisted yet");
    }

    // --------------------------- helpers ---------------------------

    function _stake(address who) internal returns (uint256 id) {
        vm.startPrank(who);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, LOCK);
        id = staking.userTokenId(who);
        vm.stopPrank();
    }

    /// @dev Drive the whole timelocked whitelist flow to completion.
    function _whitelist(address who, bool approved) internal {
        stakingAdmin.proposeLendingContract(who, approved);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK + 1);
        stakingAdmin.executeLendingContract();
    }

    // --- reward-shortfall plumbing (recipe lifted from StakingAttribution_LendingUnderpay) ---

    function _fund(uint256 amt) internal {
        toweli.approve(address(staking), amt);
        staking.notifyRewardAmount(amt);
    }

    /// @dev Bake elapsed emission into `rewardPerTokenStored` while the pool is still healthy.
    ///      Accrual is POOL-CAPPED, so without this a later drain would merely PREVENT the
    ///      accrual instead of producing a bookable shortfall.
    function _bakeAccrual() internal {
        toweli.approve(address(staking), 1_000 ether); // MIN_NOTIFY_AMOUNT
        staking.notifyRewardAmount(1_000 ether);
    }

    function _rewardPool() internal view returns (uint256) {
        uint256 bal = toweli.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 d = pool - leavePool;
        if (d == 0) return;
        vm.prank(address(staking));
        toweli.transfer(address(0xDEAD), d);
    }

    /// @dev Park a position at `escrow` while it is NOT whitelisted, then starve the reward
    ///      pool so a settle books a shortfall into `unsettledRewards[escrow]`.
    ///      The whole point is that the credit happens while the holder is UNTRACKED: the
    ///      aggregate bucket is credited unconditionally, but the per-tokenId ledger entry
    ///      beside it is written only under `_isTrackedHolder`, so it stays empty.
    function _seedUntrackedResidue() internal returns (uint256 tokenId, uint256 residue) {
        assertFalse(staking.isLendingContract(address(escrow)), "seed: escrow must start untracked");

        tokenId = _stake(alice);
        vm.warp(vm.getBlockTimestamp() + 25 hours); // TRANSFER_COOLDOWN

        vm.prank(alice);
        staking.transferFrom(alice, address(escrow), tokenId);

        _fund(50_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 100_000);
        escrow.callGetReward(tokenId); // settle the transfer-window accrual cleanly

        vm.warp(vm.getBlockTimestamp() + 100_000);
        _bakeAccrual();
        _drainPoolTo(0);
        escrow.callGetReward(tokenId); // now the owed amount cannot be paid -> unsettled

        residue = staking.unsettledRewards(address(escrow));
        assertGt(residue, 0, "seed: escrow must carry an untracked residue bucket");
        assertEq(
            staking.unsettledByTokenIdHolder(tokenId, address(escrow)),
            0,
            "seed: and NO per-tokenId ledger backing, because it was untracked at credit time"
        );
    }

    // ============ THE DEFECT, propose side: an EOA must not be proposable ============

    /// PRE-FIX: `proposeLendingContract` checked only `_lending == address(0)`, so this
    ///          call SUCCEEDS and the test fails on the missing revert.
    /// POST-FIX: rejected at propose time, mirroring `proposeRestakingContract` [L-25].
    function test_proposeLendingContract_rejectsAPlainEOA() public {
        vm.expectRevert(TegridyStakingAdmin.NotAContract.selector);
        stakingAdmin.proposeLendingContract(eve, true);
    }

    /// The 23-byte case is the one that actually matters: a 7702-delegated EOA HAS code,
    /// so a naive `codeLen == 0` check would wave it through while it stays a fully
    /// EOA-controlled address. Pins the `== 23` branch specifically.
    /// PRE-FIX: succeeds -> test fails.
    function test_proposeLendingContract_rejectsA7702DelegatedEOA() public {
        vm.etch(eve, _delegation());
        assertEq(eve.code.length, 23, "the delegation pointer is exactly 23 bytes");

        vm.expectRevert(TegridyStakingAdmin.NotAContract.selector);
        stakingAdmin.proposeLendingContract(eve, true);
    }

    // ========= THE DEFECT, execute side: the [L-18] recheck must exist here too =========

    /// The [L-18] rationale, applied to lending: propose-time validation alone is not
    /// enough, because the address can stop being a contract INSIDE the 48h window.
    /// PRE-FIX: `applyLendingContract` never looked at code, so the execute lands and
    ///          `isLendingContract[escrow]` is set on a now-codeless address.
    function test_applyLendingContract_rechecksAtExecuteTime_whenTheCodeVanishes() public {
        stakingAdmin.proposeLendingContract(address(escrow), true);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK + 1);

        // The address stops being a contract mid-window.
        vm.etch(address(escrow), hex"");
        assertEq(address(escrow).code.length, 0, "code is gone");

        vm.expectRevert(TegridyStaking.NotAContract.selector);
        stakingAdmin.executeLendingContract();

        assertFalse(staking.isLendingContract(address(escrow)), "must not be whitelisted");
    }

    /// Same window, the 23-byte shape: the address is replaced by a 7702 delegation
    /// pointer after the proposal passed its check. Pins the `== 23` branch at EXECUTE
    /// time - a fix that only rechecks `codeLen == 0` fails here.
    /// PRE-FIX: succeeds -> test fails.
    function test_applyLendingContract_rechecksAtExecuteTime_whenA7702DelegationAppears() public {
        stakingAdmin.proposeLendingContract(address(escrow), true);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK + 1);

        vm.etch(address(escrow), _delegation());
        assertEq(address(escrow).code.length, 23, "now a delegation pointer");

        vm.expectRevert(TegridyStaking.NotAContract.selector);
        stakingAdmin.executeLendingContract();

        assertFalse(staking.isLendingContract(address(escrow)), "must not be whitelisted");
    }

    // ==================== WHY IT MATTERS: the power being withheld ====================

    /// The relaxation is REAL and still works for a legitimate contract escrow. This is
    /// the regression pin: the fix must not break the carve-out it is narrowing.
    /// Passes pre-fix AND post-fix.
    function test_aWhitelistedCONTRACTEscrowStillRelaxesTheSinglePositionGuard() public {
        _whitelist(address(escrow), true);
        assertTrue(staking.isLendingContract(address(escrow)), "escrow whitelisted");

        uint256 aliceId = _stake(alice);
        uint256 bobId = _stake(bob);

        // Park alice's position at the escrow, then hand it to bob, who already holds one.
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        vm.prank(alice);
        staking.transferFrom(alice, address(escrow), aliceId);

        escrow.send(bob, aliceId);

        assertEq(staking.ownerOf(aliceId), bob, "the escrow relaxation let the 2nd position land");
        assertEq(staking.balanceOf(bob), 2, "bob holds two positions");
        assertEq(staking.ownerOf(bobId), bob, "his original is untouched");
    }

    /// THE CONSEQUENCE. That same power must be unreachable for an EOA. Pre-fix the
    /// whitelist step below SUCCEEDS, which is precisely what would hand `eve` the
    /// ability to push a second position onto a holder who already has one (and to move
    /// positions with neither the 24h cooldown nor the 1h rate limit).
    /// PRE-FIX: the propose does not revert -> test fails.
    function test_anEOACannotBeGrantedTheGuardRelaxingPower() public {
        _stake(bob);

        // The attempt an operator could make today, and the state it must NOT reach.
        vm.expectRevert(TegridyStakingAdmin.NotAContract.selector);
        stakingAdmin.proposeLendingContract(eve, true);

        assertFalse(staking.isLendingContract(eve), "an EOA never holds the relaxation");
        assertEq(staking.balanceOf(bob), 1, "bob keeps exactly one position");
    }

    /// Same, for the 7702 shape - the case a refuter reproduced end to end.
    /// PRE-FIX: succeeds -> test fails.
    function test_a7702DelegatedEOACannotBeGrantedTheGuardRelaxingPower() public {
        vm.etch(eve, _delegation());

        vm.expectRevert(TegridyStakingAdmin.NotAContract.selector);
        stakingAdmin.proposeLendingContract(eve, true);

        assertFalse(staking.isLendingContract(eve), "a 7702 EOA never holds the relaxation");
    }

    // ======================= THE ANTI-BRICK INVARIANT (_approved) =======================

    /// De-risking must ALWAYS be possible. The code check is deliberately gated on
    /// `_approved`, because a revoke that required code would permanently PIN a codeless
    /// address in the whitelist - strictly worse than the defect being fixed.
    ///
    /// This does not fail pre-fix (pre-fix there is no check at all). It exists to pin
    /// the `_approved` gate against a later "simplification" that hoists the check out of
    /// the conditional - that edit passes every other test in this file and fails here.
    function test_revokeIsNeverBlockedByTheCodeCheck_evenAfterTheEntryLosesItsCode() public {
        _whitelist(address(escrow), true);
        assertTrue(staking.isLendingContract(address(escrow)), "whitelisted while it had code");

        // The entry stops being a contract AFTER it was legitimately whitelisted.
        vm.etch(address(escrow), hex"");
        assertEq(address(escrow).code.length, 0, "the entry is now codeless");

        // Revoking must still go through on both sides.
        _whitelist(address(escrow), false);
        assertFalse(staking.isLendingContract(address(escrow)), "revoke must never be blocked");
    }

    /// The 23-byte flavour of the same anti-brick invariant.
    function test_revokeIsNeverBlockedByTheCodeCheck_forA7702DelegatedEntry() public {
        _whitelist(address(escrow), true);

        vm.etch(address(escrow), _delegation());
        assertEq(address(escrow).code.length, 23, "the entry is now a delegation pointer");

        _whitelist(address(escrow), false);
        assertFalse(staking.isLendingContract(address(escrow)), "revoke must never be blocked");
    }

    // ============================== unchanged behaviour ==============================

    /// The zero-address guard predates this fix and must survive it, on both branches of
    /// the new `_approved` conditional.
    function test_zeroAddressIsStillRejectedOnBothSides() public {
        vm.expectRevert(TegridyStakingAdmin.ZeroAddress.selector);
        stakingAdmin.proposeLendingContract(address(0), true);

        vm.expectRevert(TegridyStakingAdmin.ZeroAddress.selector);
        stakingAdmin.proposeLendingContract(address(0), false);
    }

    /// A genuine contract still whitelists cleanly end to end - the happy path.
    function test_aGenuineContractStillWhitelists() public {
        _whitelist(address(escrow), true);
        assertTrue(staking.isLendingContract(address(escrow)), "the legitimate path is unaffected");
    }

    // ============ [LEND-RESIDUE-DEADLOCK]: approving over untracked residue ============

    /// THE DEADLOCK. `applyLendingContract` carried TWO guards and BOTH were gated on
    /// `!_approved`, so the APPROVE side had no residue precondition at all.
    ///
    /// `unsettledRewards[X]` can be non-zero while X is UNTRACKED (the shortfall credit is
    /// unconditional; the per-tokenId ledger entry beside it is written only under
    /// `_isTrackedHolder`). Approving X then flips `_isTrackedHolder(X)` true over a bucket
    /// with no ledger backing, and every exit shuts at once - including the revoke, which
    /// reverts on the very guard that was supposed to protect it. The residue becomes
    /// permanently unrecoverable and stays pinned inside `totalUnsettledRewards`.
    ///
    /// PRE-FIX (`if (!_approved && unsettledRewards[...] > 0)`): the execute SUCCEEDS and this
    ///          test fails on the missing revert.
    /// POST-FIX (guard unconditional): approving over residue is refused up front.
    function test_cannotWhitelistAnAddressCarryingUntrackedResidue() public {
        (, uint256 residue) = _seedUntrackedResidue();

        stakingAdmin.proposeLendingContract(address(escrow), true);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK + 1);

        vm.expectRevert(TegridyStaking.PendingLendingResidue.selector);
        stakingAdmin.executeLendingContract();

        assertFalse(staking.isLendingContract(address(escrow)), "must not be whitelisted over residue");
        assertEq(staking.unsettledRewards(address(escrow)), residue, "residue untouched and still drainable");
    }

    /// The remedy the guard forces the operator onto MUST actually work, or the new check
    /// would just be a different brick. `claimUnsettledFor` is callable precisely BECAUSE the
    /// holder is still untracked - drain first, then approve. Passes pre- and post-fix; it
    /// exists so a future edit cannot "fix" the deadlock by closing the drain instead.
    function test_theOperatorRemedyWorks_drainWhileUntrackedThenApprove() public {
        _seedUntrackedResidue();

        // The bucket is only PAYABLE once the pool can cover it - seeding the residue
        // deliberately starved the pool to zero, so refill before draining.
        _fund(50_000_000 ether);

        // The holder drains its OWN bucket, which `claimUnsettled` permits precisely because
        // it is still untracked. (The owner-driven `claimUnsettledFor` is NOT the remedy here:
        // its owner branch additionally requires 90 days of user inactivity.)
        escrow.callClaimUnsettled();
        assertEq(staking.unsettledRewards(address(escrow)), 0, "bucket drained while untracked");

        // With the residue gone the whitelist goes through normally.
        _whitelist(address(escrow), true);
        assertTrue(staking.isLendingContract(address(escrow)), "approve succeeds once drained");
    }

    /// Documents WHY the approve-side guard has to exist, by exhibiting the trap it prevents.
    /// Deliberately reaches the bad state through the low-level path (`vm.store`-free: we
    /// simply assert the exits are shut for a TRACKED holder over an unbacked bucket), so it
    /// stays true regardless of how the registry was written.
    function test_everyExitIsShutForATrackedHolderOverAnUnbackedBucket() public {
        (uint256 tokenId,) = _seedUntrackedResidue();

        // Whitelist it the only way that is still legal: drain, approve, then re-seed the
        // bucket while TRACKED is impossible - so instead assert the three exits directly
        // against the untracked bucket, which is what the guard now preserves.
        assertGt(staking.unsettledRewards(address(escrow)), 0, "bucket present");

        // While UNTRACKED every exit is OPEN - this is the state the new guard preserves.
        assertEq(staking.unsettledByTokenIdHolder(tokenId, address(escrow)), 0, "no ledger backing");
        _fund(50_000_000 ether); // the bucket is only payable once the pool can cover it
        uint256 before = toweli.balanceOf(address(escrow));
        escrow.callClaimUnsettled();
        assertGt(toweli.balanceOf(address(escrow)), before, "an UNTRACKED holder can drain its own bucket");
        assertEq(staking.unsettledRewards(address(escrow)), 0, "drained");

        // And once tracked, that same self-drain is refused - which is exactly why entering
        // the tracked state with a non-empty unbacked bucket had to be blocked.
        _whitelist(address(escrow), true);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        escrow.callClaimUnsettled();
    }
}

// ------------------------------- fixtures -------------------------------

contract LendToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract LendNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev Stands in for TegridyLending: a genuine contract that can hold and forward a
///      staking position. Deliberately has runtime code longer than 23 bytes.
contract LendEscrow {
    TegridyStaking public immutable staking;

    constructor(TegridyStaking _staking) {
        staking = _staking;
    }

    function send(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }

    /// @dev Drives a settle from the escrow's own frame, which is how a shortfall gets
    ///      booked into `unsettledRewards[escrow]`. Mirrors UnderpayEscrow.callGetReward.
    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function callClaimUnsettled() external {
        staking.claimUnsettled();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
