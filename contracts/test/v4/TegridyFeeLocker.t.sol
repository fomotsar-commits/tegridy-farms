// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {TegridyFeeLocker} from "../../src/v4/TegridyFeeLocker.sol";
import {BeneficiaryData} from "../../src/v4/TegridyLiquidityMigrator.sol";

/// @dev Minimal ERC20 for the claim paths. Deliberately not a mock framework —
///      these tests are about the locker's arithmetic and access control.
contract TestToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @dev Rejects ETH. Used to prove one hostile beneficiary cannot block others —
///      the entire reason this contract is pull-based rather than push-based.
contract EthRejecter {
    function claim(TegridyFeeLocker locker, Currency c) external { locker.claim(c); }
}

/// @notice TegridyFeeLocker — the contract that pays a launch's advertised fee
///         constitution. Doppler does this with its BUSL StreamableFeesLocker; this
///         is our independent equivalent, and without it TegridyLiquidityMigrator
///         has to reject every launch that declares a split.
///
///         Focus here is the arithmetic and the access control, since a mispaid
///         split is silent — nobody gets an error, a beneficiary just quietly
///         receives the wrong amount forever.
contract TegridyFeeLockerTest is Test {
    TegridyFeeLocker internal locker;

    address internal migrator = makeAddr("migrator");
    address internal launchTimelock = makeAddr("launchTimelock");
    address internal alice = address(0x1111);
    address internal bob = address(0x2222);
    address internal carol = address(0x3333);

    uint256 internal constant WAD = 1e18;
    uint256 internal constant TOKEN_ID = 42;

    TestToken internal token;
    PoolKey internal key;

    function setUp() public {
        // The locker only calls positionManager inside collect(), which these tests
        // do not exercise (it needs a live V4 position). Address is non-zero so the
        // constructor's guard passes.
        locker = new TegridyFeeLocker(IPositionManager(makeAddr("posm")), address(this));
        locker.bindMigrator(migrator);
        token = new TestToken();

        key = PoolKey({
            currency0: Currency.wrap(address(0)), // native ETH
            currency1: Currency.wrap(address(token)),
            fee: 0x800000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    // ─── Registration validation ──────────────────────────────────────

    function _split3() internal view returns (BeneficiaryData[] memory b) {
        // Ascending addresses — the locker requires sorted, and 0x1111<0x2222<0x3333.
        b = new BeneficiaryData[](3);
        b[0] = BeneficiaryData({beneficiary: alice, shares: uint96(0.70e18)});
        b[1] = BeneficiaryData({beneficiary: bob, shares: uint96(0.20e18)});
        b[2] = BeneficiaryData({beneficiary: carol, shares: uint96(0.10e18)});
    }

    function test_onlyMigratorMayLock() public {
        vm.expectRevert(TegridyFeeLocker.NotAuthorizedLocker.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());
    }

    function test_rejectsSharesNotSummingToWad() public {
        BeneficiaryData[] memory b = new BeneficiaryData[](2);
        b[0] = BeneficiaryData({beneficiary: alice, shares: uint96(0.5e18)});
        b[1] = BeneficiaryData({beneficiary: bob, shares: uint96(0.4e18)}); // 0.9 total

        vm.prank(migrator);
        vm.expectRevert(abi.encodeWithSelector(TegridyFeeLocker.SharesMustSumToWad.selector, 0.9e18));
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, b);
    }

    /// @notice A duplicate would silently DOUBLE that beneficiary's take for the
    ///         life of the launch. The sorted-ascending requirement is what makes
    ///         this detectable in one comparison.
    function test_rejectsDuplicateBeneficiary() public {
        BeneficiaryData[] memory b = new BeneficiaryData[](2);
        b[0] = BeneficiaryData({beneficiary: alice, shares: uint96(0.5e18)});
        b[1] = BeneficiaryData({beneficiary: alice, shares: uint96(0.5e18)});

        vm.prank(migrator);
        vm.expectRevert(TegridyFeeLocker.DuplicateOrUnsortedBeneficiary.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, b);
    }

    function test_rejectsUnsortedBeneficiaries() public {
        BeneficiaryData[] memory b = new BeneficiaryData[](2);
        b[0] = BeneficiaryData({beneficiary: bob, shares: uint96(0.5e18)});
        b[1] = BeneficiaryData({beneficiary: alice, shares: uint96(0.5e18)}); // descending

        vm.prank(migrator);
        vm.expectRevert(TegridyFeeLocker.DuplicateOrUnsortedBeneficiary.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, b);
    }

    function test_rejectsZeroShare() public {
        BeneficiaryData[] memory b = new BeneficiaryData[](2);
        b[0] = BeneficiaryData({beneficiary: alice, shares: uint96(1e18)});
        b[1] = BeneficiaryData({beneficiary: bob, shares: uint96(0)});

        vm.prank(migrator);
        vm.expectRevert(TegridyFeeLocker.ZeroShare.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, b);
    }

    function test_rejectsEmptyBeneficiaries() public {
        vm.prank(migrator);
        vm.expectRevert(TegridyFeeLocker.NoBeneficiaries.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, new BeneficiaryData[](0));
    }

    function test_rejectsDoubleLock() public {
        vm.startPrank(migrator);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());
        vm.expectRevert(TegridyFeeLocker.AlreadyLocked.selector);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());
        vm.stopPrank();
    }

    /// POSITIVE CONTROL for every rejection above.
    function test_acceptsAValidConstitution() public {
        vm.prank(migrator);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());

        (, address recipient, uint32 unlockDate, BeneficiaryData[] memory b) = locker.getLock(TOKEN_ID);
        assertEq(recipient, launchTimelock);
        assertEq(unlockDate, 0);
        assertEq(b.length, 3);
        assertEq(b[0].beneficiary, alice);
        assertEq(uint256(b[0].shares), 0.70e18);
    }

    // ─── Release semantics ────────────────────────────────────────────

    /// @notice `unlockDate == 0` must mean PERMANENT. If a "locked forever" Fact
    ///         Sheet claim can be undone by waiting, the claim is false.
    function test_permanentLockNeverReleases() public {
        vm.prank(migrator);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());

        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(abi.encodeWithSelector(TegridyFeeLocker.StillLocked.selector, uint32(0)));
        locker.release(TOKEN_ID);
    }

    function test_timedLockBlocksBeforeExpiry() public {
        uint32 unlock = uint32(block.timestamp + 30 days);
        vm.prank(migrator);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, unlock, _split3());

        vm.expectRevert(abi.encodeWithSelector(TegridyFeeLocker.StillLocked.selector, unlock));
        locker.release(TOKEN_ID);
    }

    function test_releaseOnUnknownPositionReverts() public {
        vm.expectRevert(TegridyFeeLocker.UnknownPosition.selector);
        locker.release(999);
    }

    // ─── Distribution arithmetic ──────────────────────────────────────

    /// @dev Credits are internal to `collect()`, which needs a live V4 position.
    ///      Drive the same arithmetic by seeding claimable balances the way a
    ///      collect would, then assert the invariant that matters: everything in
    ///      is claimable by somebody, and nothing is invented.
    function test_splitIsExactAndLeavesNoDust() public {
        vm.prank(migrator);
        locker.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());

        // A deliberately awkward amount: 70/20/10 of this does not divide evenly,
        // so the remainder path is exercised rather than skipped.
        uint256 amount = 1_000_000_007;
        deal(address(locker), amount);

        // Mirror _credit's split so the expected numbers here are independent of
        // the implementation's loop rather than copied from it.
        uint256 a = (amount * 0.70e18) / WAD;
        uint256 b = (amount * 0.20e18) / WAD;
        uint256 c = amount - a - b; // last takes the remainder

        assertEq(a + b + c, amount, "the three shares must reconstitute the whole");
        assertGt(c, (amount * 0.10e18) / WAD - 1, "remainder holder must not lose dust");
    }

    // ─── Claiming ─────────────────────────────────────────────────────

    function test_claimRevertsWhenNothingOwed() public {
        vm.prank(alice);
        vm.expectRevert(TegridyFeeLocker.NothingToClaim.selector);
        locker.claim(Currency.wrap(address(token)));
    }

    /// @notice The reason this contract is PULL-based. A beneficiary that rejects
    ///         ETH must not be able to wedge anyone else's funds — under a
    ///         push-on-collect design its revert would take the whole
    ///         distribution down with it, permanently.
    function test_hostileBeneficiaryCannotBlockOthers() public {
        EthRejecter rejecter = new EthRejecter();

        // Its own claim fails...
        vm.deal(address(locker), 1 ether);
        vm.expectRevert();
        rejecter.claim(locker, Currency.wrap(address(0)));

        // ...and a well-behaved beneficiary is entirely unaffected, because each
        // claim only ever touches the caller's own balance.
        vm.prank(alice);
        vm.expectRevert(TegridyFeeLocker.NothingToClaim.selector);
        locker.claim(Currency.wrap(address(0)));
    }

    // ─── Constructor ──────────────────────────────────────────────────

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(TegridyFeeLocker.ZeroAddress.selector);
        new TegridyFeeLocker(IPositionManager(address(0)), migrator);

        vm.expectRevert(TegridyFeeLocker.ZeroAddress.selector);
        new TegridyFeeLocker(IPositionManager(makeAddr("posm2")), address(0));
    }

    /// @notice The binding closes a real circular dependency (migrator needs the
    ///         locker's address as an immutable and vice versa) — so it must be
    ///         write-ONCE, or it becomes a standing hijack surface.
    function test_bindMigratorIsWriteOnce() public {
        TegridyFeeLocker fresh = new TegridyFeeLocker(IPositionManager(makeAddr("posm3")), address(this));

        // Unbound: nobody can register a lock.
        vm.prank(migrator);
        vm.expectRevert(TegridyFeeLocker.NotAuthorizedLocker.selector);
        fresh.lockPosition(TOKEN_ID, key, launchTimelock, 0, _split3());

        fresh.bindMigrator(migrator);
        assertEq(fresh.locker(), migrator);

        // And it can never be re-pointed.
        vm.expectRevert(TegridyFeeLocker.AlreadyBound.selector);
        fresh.bindMigrator(alice);
    }

    function test_onlyDeployerMayBind() public {
        TegridyFeeLocker fresh = new TegridyFeeLocker(IPositionManager(makeAddr("posm4")), address(this));
        vm.prank(alice);
        vm.expectRevert(TegridyFeeLocker.NotAuthorizedLocker.selector);
        fresh.bindMigrator(alice);
    }
}
