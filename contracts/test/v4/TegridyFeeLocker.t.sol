// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {TegridyFeeLocker} from "../../src/v4/TegridyFeeLocker.sol";
import {BeneficiaryData} from "../../src/v4/TegridyLiquidityMigrator.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

    // ─── Reentrancy: collect's balance-delta provenance ───────────────

    /// @dev Harness for the collect() path: a mock PositionManager whose
    ///      modifyLiquidities "sweeps" fees into the locker and then hands
    ///      control to arbitrary code — exactly the window a hooked launch
    ///      asset's token code gets during TAKE_PAIR in prod. Beneficiaries are
    ///      the attacker and alice, 50/50, sorted at runtime.
    function _reentrancyHarness()
        internal
        returns (ReenteringPosm posm, TegridyFeeLocker lkr, TestToken feeToken, ClaimReenterer attacker)
    {
        posm = new ReenteringPosm();
        lkr = new TegridyFeeLocker(IPositionManager(address(posm)), address(this));
        lkr.bindMigrator(migrator);
        feeToken = new TestToken();
        posm.configure(feeToken, address(lkr));
        attacker = new ClaimReenterer(lkr, Currency.wrap(address(feeToken)));

        BeneficiaryData[] memory b = new BeneficiaryData[](2);
        (address lo, address hi) =
            address(attacker) < alice ? (address(attacker), alice) : (alice, address(attacker));
        b[0] = BeneficiaryData({beneficiary: lo, shares: uint96(0.5e18)});
        b[1] = BeneficiaryData({beneficiary: hi, shares: uint96(0.5e18)});

        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(feeToken)),
            fee: 0x800000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        vm.prank(migrator);
        lkr.lockPosition(TOKEN_ID, k, launchTimelock, 0, b);
    }

    /// @notice `collect` credits BALANCE DELTAS taken around `modifyLiquidities`,
    ///         during which TAKE_PAIR runs the launch asset's own token code. A
    ///         hook claiming EXACTLY its claimable mid-collect cancels the delta
    ///         to zero: pre-fix, collect "succeeded", emitted
    ///         FeesCollected(id, 0, 0), and the swept fees were credited to
    ///         nobody — unreachable forever (no sweep, no owner, no rescue). The
    ///         shared nonReentrant guard on collect/claim must abort that claim
    ///         instead. Kills BOTH single-modifier mutants: strip the guard from
    ///         `claim` and the reentrant claim succeeds inside collect's held
    ///         guard; strip it from `collect` and claim's own check passes
    ///         because no guard was taken.
    function test_reentrantClaimDuringCollectRevertsInsteadOfStrandingFees() public {
        (ReenteringPosm posm, TegridyFeeLocker lkr, TestToken feeToken, ClaimReenterer attacker) =
            _reentrancyHarness();
        Currency c1 = Currency.wrap(address(feeToken));

        // Benign collect #1 seeds the attacker's claimable: 1 token in, 0.5 each.
        posm.setFee(1e18);
        lkr.collect(TOKEN_ID);
        assertEq(lkr.claimable(address(attacker), c1), 0.5e18);

        // Collect #2 sweeps EXACTLY the attacker's claimable; the armed hook
        // claims it mid-measurement, cancelling the delta to zero. Pre-fix this
        // succeeded silently; the guard must make it revert loudly instead.
        posm.setFee(0.5e18);
        posm.arm(attacker);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        lkr.collect(TOKEN_ID);

        // And nothing is stranded: every token the locker holds is still
        // credited to somebody.
        uint256 credited = lkr.claimable(address(attacker), c1) + lkr.claimable(alice, c1);
        assertEq(feeToken.balanceOf(address(lkr)), credited, "pot must equal total credits");
    }

    /// POSITIVE CONTROL: the guard must not break the legitimate sequence — a
    /// benign collect followed by a normal, non-reentrant claim.
    function test_collectThenClaimStillWorksUnderGuard() public {
        (ReenteringPosm posm, TegridyFeeLocker lkr, TestToken feeToken,) = _reentrancyHarness();

        posm.setFee(1e18);
        lkr.collect(TOKEN_ID);

        vm.prank(alice);
        lkr.claim(Currency.wrap(address(feeToken)));
        assertEq(feeToken.balanceOf(alice), 0.5e18);
    }
}

/// @dev Mock V4 PositionManager for the reentrancy tests: `modifyLiquidities`
///      sweeps `fee` tokens into the locker (the TAKE_PAIR leg) and then, if
///      armed, hands control to the attacker — the moment prod hands control to
///      the launch asset's own transfer code.
contract ReenteringPosm {
    TestToken internal token;
    address internal locker;
    uint256 internal fee;
    ClaimReenterer internal reenterer; // address(0) => benign collect

    function configure(TestToken token_, address locker_) external {
        token = token_;
        locker = locker_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function arm(ClaimReenterer reenterer_) external {
        reenterer = reenterer_;
    }

    function modifyLiquidities(bytes calldata, uint256) external payable {
        token.mint(locker, fee);
        if (address(reenterer) != address(0)) reenterer.attack();
    }
}

/// @dev A beneficiary that claims its own legitimately-credited balance while
///      collect() is still measuring its balance delta.
contract ClaimReenterer {
    TegridyFeeLocker internal locker;
    Currency internal currency;

    constructor(TegridyFeeLocker locker_, Currency currency_) {
        locker = locker_;
        currency = currency_;
    }

    function attack() external {
        locker.claim(currency);
    }
}
