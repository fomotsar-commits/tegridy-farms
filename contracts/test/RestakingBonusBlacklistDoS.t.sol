// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import {RestakingMonitorView} from "../src/RestakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyRestaking.sol";
import {TegridyRestakingAdmin} from "../src/TegridyRestakingAdmin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// ═══════════════════════════════════════════════════════════════════════
//  Mocks
// ═══════════════════════════════════════════════════════════════════════

contract BLD_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract BLD_MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @notice Bonus token that blacklists recipients, USDC-style: `transfer` to a
///         blocked address reverts, while `balanceOf` keeps working. Modelling it
///         this way is deliberate — accrual reads `balanceOf` and is therefore
///         untouched, so any revert these tests observe is attributable to the
///         PAYOUT call and nothing else.
contract BLD_MockBlacklistWETH is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function setBlocked(address who, bool v) external { blocked[who] = v; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!blocked[to], "BLACKLISTED");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!blocked[to], "BLACKLISTED");
        return super.transferFrom(from, to, amount);
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  RestakingBonusBlacklistDoS
// ═══════════════════════════════════════════════════════════════════════

/// @title  Bonus-payout parity guard: every payout defers, none reverts
/// @notice REGRESSION TEST for AUDIT FIX 2026-09-04 [F-04-5 PARITY].
///
///         TegridyRestaking standardised long ago on paying bonus through the
///         `_safeBonusTransferExt` self-call inside a try/catch, so "a
///         blacklisted/bricked recipient cannot DoS the caller (F-04-5)"
///         (`_claimBonusWithDefer`). THREE payout sites never got the memo and
///         still paid with a bare `SafeTransferLib.safeTransfer`:
///
///           1. `_settlePreAccrueBonus`      — the stale-path settle shared by
///                                             refreshPosition / claimAll / unrestake.
///           2. `refreshPosition` non-stale  — a verbatim copy of `_claimBonusWithDefer`
///                                             that paid directly. This is the COMMON
///                                             path; fixing only (1) would have left
///                                             refreshPosition bricked in the ordinary case.
///           3. `_revalidateBoostCore`       — the only one that is NOT self-inflicted.
///
///         Sites (1) and (2) always pay `msg.sender`, so their DoS is SELF-inflicted:
///         nobody can brick another user's flow, and `emergencyWithdrawNFT` (no
///         `updateBonus` modifier, never calls the settle) always returns the NFT.
///         The user simply forfeited accrued bonus for no reason the file endorses.
///
///         Site (3) is the only one that is NOT self-inflicted: both revalidate
///         entrypoints accept `msg.sender == owner()` as well as the restaker, so a
///         blacklisted restaker made the OWNER's call revert — a stranger bricking an
///         operator function rather than only their own flow.
///
///         Its blast radius today is small, and saying otherwise would be overclaiming:
///         on a fresh deployment `staking.revalidateBoost` cannot actually downgrade
///         anything. Deposit-based positions revert `JbacDeposited()` before the settle
///         is reached, and the legacy `hasJbacBoost=true` + `jbacDeposited=false` shape
///         that CAN be downgraded is unconstructible (TegridyStaking.sol:1425-1428).
///         The entrypoint is therefore an expensive no-op poke. What survives is
///         narrower and still worth fixing: the bonus settle inside it DOES run and
///         DOES pay, so a blacklisted restaker reverted a call they were not the
///         caller of, and the payout moved `totalBonusDistributed` with no event.
///
///         STATUS: pre-deploy. `TEGRIDY_RESTAKING_ADDRESS` is the zero address
///         (frontend/src/lib/constants.ts:27) and CONTRACTS.md:48 records the
///         contract as not deployed; the three TegridyRestaking addresses in
///         frontend/scripts/addresses.json all sit under `retiredDeploys`. There is
///         no live bytecode to migrate and no live position to protect — the source
///         fix is the whole fix.
///
///         MUTATION CHECK: every test here reverts on pre-fix source. Restore any
///         one bare `SafeTransferLib.safeTransfer(address(bonusRewardToken), ...)`
///         and its matching test fails, the mock's BLACKLISTED string surfacing as
///         solady `TransferFailed()`.
contract RestakingBonusBlacklistDoS is Test {
    BLD_MockTOWELI toweli;
    BLD_MockJBAC jbac;
    BLD_MockBlacklistWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;
    TegridyRestakingAdmin restakingAdmin;
    RestakingMonitorView rMonitorView;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1e14;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;
    uint256 constant BONUS_FUNDING = 100_000 ether;
    uint256 constant LOCK = 30 days;

    event BonusTransferDeferred(address indexed restaker, uint256 amount);

    function setUp() public {
        toweli = new BLD_MockTOWELI();
        jbac = new BLD_MockJBAC();
        weth = new BLD_MockBlacklistWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE);
        restakingAdmin = new TegridyRestakingAdmin(address(restaking));
        restaking.setRestakingAdmin(address(restakingAdmin));
        rMonitorView = new RestakingMonitorView(address(restaking));

        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        toweli.approve(address(staking), 500_000 ether);
        staking.notifyRewardAmount(500_000 ether);

        weth.transfer(address(restaking), BONUS_FUNDING);

        toweli.transfer(alice, STAKE_AMOUNT);
        toweli.transfer(bob, STAKE_AMOUNT);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _stakeAndRestake(address user) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, LOCK);
        tokenId = staking.userTokenId(user);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    /// Pure accrual tick: re-apply the SAME bonus rate through the admin. This runs
    /// `_accrueBonusChecked()` and moves nothing else, so `accBonusPerShare` advances
    /// past the restaker's `bonusDebt` anchor without any claim. In production this
    /// same accrual rides every restake/claim/refresh/decay — it is the ordinary case.
    function _accrualTick() internal {
        vm.prank(address(restakingAdmin));
        restaking.applyBonusRate(BONUS_RATE);
    }

    /// Accrue real bonus for `user`, then blacklist them on the bonus token.
    /// Asserts non-zero pending FIRST: a test that blacklists a user with nothing
    /// owed would pass vacuously on pre-fix code, because every bare transfer sits
    /// behind an `if (bonus > 0)` guard and would simply never execute.
    function _accrueThenBlacklist(address user) internal {
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _accrualTick();
        assertGt(rMonitorView.pendingBonus(user), 0, "VACUITY GUARD: no bonus accrued, payout would be skipped");
        weth.setBlocked(user, true);
    }

    /// Drive the position stale by letting the lock expire: `_decayIfExpired`
    /// zeroes `boostedAmount` and leaves `amount` intact, so the restaking-side
    /// cache diverges and the `stale` branch is taken.
    function _makeStale() internal {
        vm.warp(vm.getBlockTimestamp() + LOCK + 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  1. `_settlePreAccrueBonus` — the stale path (all three callers)
    // ═══════════════════════════════════════════════════════════════════

    /// PRE-FIX: reverts. The stale branch reaches `_settlePreAccrueBonus`, whose bare
    /// safeTransfer to blacklisted alice reverts and takes refreshPosition with it.
    function test_refreshPosition_stalePath_defersInsteadOfReverting() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);
        _makeStale();

        vm.prank(alice);
        restaking.refreshPosition();

        assertGt(restaking.unforwardedBonusRewards(alice), 0, "credit must defer, not vanish");
        assertEq(weth.balanceOf(alice), 0, "blacklisted user receives nothing directly");
    }

    /// PRE-FIX: reverts, same mechanism via claimAll's stale branch.
    function test_claimAll_stalePath_defersInsteadOfReverting() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);
        _makeStale();

        vm.prank(alice);
        restaking.claimAll();

        assertGt(restaking.unforwardedBonusRewards(alice), 0, "credit must defer, not vanish");
    }

    /// PRE-FIX: reverts, same mechanism via unrestake's stale branch. This is the one
    /// that mattered most to the user: pre-fix their only remaining exit was
    /// `emergencyWithdrawNFT`, which returns the NFT but forfeits the bonus.
    function test_unrestake_stalePath_defersAndStillReturnsNft() public {
        uint256 tokenId = _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);
        _makeStale();

        vm.prank(alice);
        restaking.unrestake();

        assertEq(staking.ownerOf(tokenId), alice, "NFT returned through the normal exit");
        assertGt(restaking.unforwardedBonusRewards(alice), 0, "bonus deferred rather than forfeited");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  2. refreshPosition NON-stale path — the site the first report missed
    // ═══════════════════════════════════════════════════════════════════

    /// PRE-FIX: reverts. This path never touches `_settlePreAccrueBonus`, so a fix
    /// confined to that helper leaves this one broken — and this is the path
    /// refreshPosition takes whenever the cache is already in sync, i.e. normally.
    function test_refreshPosition_nonStalePath_defersInsteadOfReverting() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);

        // No expiry: the lock is still live, so the cache matches and `stale` is false.
        vm.prank(alice);
        restaking.refreshPosition();

        assertGt(restaking.unforwardedBonusRewards(alice), 0, "non-stale payout must defer too");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  3. `_revalidateBoostCore` — the cross-account DoS
    // ═══════════════════════════════════════════════════════════════════

    /// PRE-FIX: reverts — and the caller here is the OWNER, not alice. This is the
    /// finding that is not self-inflicted: a blacklisted restaker bricked a call they
    /// were not the caller of. (The poke itself is a no-op on a fresh deployment — see
    /// the contract-level notice — but the settle inside it still runs and still pays,
    /// which is what reverted.) bob is present as the honest bystander.
    function test_revalidateBoost_ownerCall_notBrickedByBlacklistedRestaker() public {
        uint256 tokenId = _stakeAndRestake(alice);
        _stakeAndRestake(bob);
        _accrueThenBlacklist(alice);

        // Owner (this test contract) drives the revalidation for alice's position.
        restaking.revalidateBoostForRestaked(tokenId);

        assertGt(restaking.unforwardedBonusRewards(alice), 0, "credit deferred, owner call survives");
    }

    /// The sister entrypoint resolves by address rather than tokenId; same core,
    /// so it must survive identically.
    function test_revalidateBoostForRestaker_ownerCall_notBricked() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);

        restaking.revalidateBoostForRestaker(alice);

        assertGt(restaking.unforwardedBonusRewards(alice), 0, "credit deferred, owner call survives");
    }

    /// The accounting half of the same fix: pre-fix `_revalidateBoostCore` moved
    /// `totalBonusDistributed` with NO `BonusClaimed` event, so an indexer
    /// reconstructing payouts from logs under-counted. A healthy (non-blacklisted)
    /// restaker must now emit on the success leg.
    function test_revalidateBoost_healthyRestaker_emitsBonusClaimed() public {
        uint256 tokenId = _stakeAndRestake(alice);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _accrualTick();
        assertGt(rMonitorView.pendingBonus(alice), 0, "VACUITY GUARD: nothing to pay");

        vm.recordLogs();
        restaking.revalidateBoostForRestaked(tokenId);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("BonusClaimed(address,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 1 && logs[i].topics[0] == sig
                    && address(uint160(uint256(logs[i].topics[1]))) == alice
            ) {
                found = true;
                break;
            }
        }
        assertTrue(found, "successful revalidate payout must emit BonusClaimed");
        assertGt(weth.balanceOf(alice), 0, "healthy restaker is still paid directly");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  4. Positive controls — the happy path is unchanged, and the
    //     deferred credit is really redeemable (not just parked)
    // ═══════════════════════════════════════════════════════════════════

    /// Guards against "fixing" the DoS by deferring everyone. A healthy restaker must
    /// still be paid in the same transaction, with nothing left in the bucket.
    function test_healthyRestaker_stillPaidDirectly_nothingDeferred() public {
        _stakeAndRestake(alice);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _accrualTick();
        _makeStale();

        vm.prank(alice);
        restaking.refreshPosition();

        assertGt(weth.balanceOf(alice), 0, "healthy restaker paid inline");
        assertEq(restaking.unforwardedBonusRewards(alice), 0, "nothing deferred for a healthy recipient");
    }

    /// End-to-end: the whole point of deferring is that the value stays recoverable.
    /// Blacklist, defer, un-blacklist, self-claim — alice ends up with her bonus.
    function test_deferredCredit_isClaimableOnceUnblocked() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);
        _makeStale();

        vm.prank(alice);
        restaking.refreshPosition();

        uint256 owed = restaking.unforwardedBonusRewards(alice);
        assertGt(owed, 0, "credit deferred");

        weth.setBlocked(alice, false);
        vm.prank(alice);
        restaking.claimPendingBonusPayout();

        assertEq(weth.balanceOf(alice), owed, "deferred bonus fully recovered");
        assertEq(restaking.unforwardedBonusRewards(alice), 0, "bucket drained");
    }

    /// Bookkeeping parity with the pre-existing deferral path: a deferred payout must
    /// land in `totalUnforwardedBonus` and must NOT be counted as distributed.
    function test_deferral_bookkeeping_matchesExistingPath() public {
        _stakeAndRestake(alice);
        _accrueThenBlacklist(alice);
        _makeStale();

        uint256 distributedBefore = restaking.totalBonusDistributed();

        vm.expectEmit(true, false, false, false, address(restaking));
        emit BonusTransferDeferred(alice, 0);

        vm.prank(alice);
        restaking.refreshPosition();

        uint256 owed = restaking.unforwardedBonusRewards(alice);
        assertEq(restaking.totalBonusDistributed(), distributedBefore, "deferred payout is not distributed");
        assertEq(restaking.totalUnforwardedBonus(), owed, "deferred payout tracked in the IOU total");
    }
}
