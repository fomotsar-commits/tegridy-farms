// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";
import {TegridyLiquidityMigrator, IPermit2Approve, BeneficiaryData, ITegridyFeeLocker} from "../../src/v4/TegridyLiquidityMigrator.sol";
import {TegridyFeeLocker} from "../../src/v4/TegridyFeeLocker.sol";

// PosmTestSetup deploys the PositionManager stack through `vm.getCode(...)`, which
// resolves against compiled ARTIFACTS rather than the import graph. Our sources only
// reference `IPositionManager`, so without these three concrete imports forge never
// compiles the implementations and `setUp()` dies with
// "vm.getCode: no matching artifact found". Imported for their build side effect only.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice TegridyLiquidityMigrator — graduation of a Doppler launch into a
///         Tegridy-hooked canonical V4 pool.
///
///         The load-bearing test here is `test_initializerGrantIsLoadBearing`.
///         TegridyV4Hook gates `_beforeInitialize` on a per-pool allowlist behind a
///         48h multisig timelock. A launcher cannot use that path: the migration
///         pool's key contains the launched token, so its id does not exist until
///         the token does. Without the standing-initializer grant added alongside
///         this contract, EVERY graduation reverts — and because `Airlock.migrate`
///         hands the graduated balances to the migrator BEFORE calling it, that
///         revert strands them. That test asserts both directions of the grant.
contract TegridyLiquidityMigratorTest is PosmTestSetup {
    TegridyV4Hook internal tegridyHook;
    TegridyLiquidityMigrator internal migrator;
    TegridyFeeLocker internal feeLocker;

    address internal airlockMock = makeAddr("airlock");
    /// @dev Doppler's protocol owner. `initialize` reads it LIVE off the Airlock, so the
    ///      mock airlock must answer `owner()` — see the vm.mockCall in setUp.
    address internal protocolOwner = makeAddr("dopplerProtocolOwner");
    address internal launchTimelock = makeAddr("launchTimelock");
    address internal rescue = makeAddr("rescue");
    address internal treasury = makeAddr("treasury");

    uint24 internal constant MIN_FEE = 500;
    uint24 internal constant MAX_FEE = 30_000;
    uint24 internal constant BASE_FEE = 3_000;
    uint16 internal constant MAX_POL_BPS = 1_000;
    uint16 internal constant POL_BPS = 100;
    uint48 internal constant BLOCK_OFFSET = 10;

    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant SEED = 10 ether;

    function setUp() public {
        // The migrator reads `Airlock.owner()` to enforce Doppler's 5% protocol floor.
        // airlockMock is a bare address with no code, so stub the one call it must answer.
        vm.mockCall(airlockMock, abi.encodeWithSignature("owner()"), abi.encode(protocolOwner));

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        deployAndApprovePosm(manager);

        // paramAdmin = this test, so the timelocked admin can be bypassed here. The
        // admin triplet is covered separately in TegridyV4HookAdmin's own tests.
        tegridyHook = _mineAndDeployHook(address(this));

        feeLocker = new TegridyFeeLocker(IPositionManager(address(lpm)), address(this));
        migrator = new TegridyLiquidityMigrator(
            airlockMock,
            manager,
            IPositionManager(address(lpm)),
            IPermit2Approve(address(permit2)),
            IHooks(address(tegridyHook)),
            rescue,
            ITegridyFeeLocker(address(feeLocker))
        );

        // Close the circular dependency: the locker learns the migrator's address
        // only after the migrator has been constructed with the locker's.
        feeLocker.bindMigrator(address(migrator));

        tegridyHook.setInitializerAllowed(address(migrator), true);
    }

    // ─── Happy path ───────────────────────────────────────────────────

    function test_migrate_mintsFullRangePositionToRecipient() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        _fundMigrator(t0, t1);

        uint256 tokenId = lpm.nextTokenId();

        vm.prank(airlockMock);
        uint256 liquidity = migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);

        assertGt(liquidity, 0, "no liquidity deployed");
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), launchTimelock, "position not owned by the launch");
    }

    /// @notice The protocol's capture is the HOOK's fee skim, never the launch's
    ///         liquidity. Retaining the LP would be a rug; assert we hold nothing.
    function test_migrate_migratorRetainsNothing() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        _fundMigrator(t0, t1);

        vm.prank(airlockMock);
        migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);

        assertEq(IERC20(t0).balanceOf(address(migrator)), 0, "migrator kept token0");
        assertEq(IERC20(t1).balanceOf(address(migrator)), 0, "migrator kept token1");
    }

    /// @notice The pool the launch graduates into must carry OUR hook — that is the
    ///         entire point of the module. Assert the configured key says so.
    function test_migrate_poolCarriesTegridyHook() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);

        PoolKey memory k = migrator.getPoolKey(t0, t1);
        (uint24 fee, int24 tickSpacing, IHooks hooks) = (k.fee, k.tickSpacing, k.hooks);
        assertEq(address(hooks), address(tegridyHook), "graduated pool is not Tegridy-hooked");
        assertEq(tickSpacing, TICK_SPACING, "tick spacing not carried through");
        assertTrue(LPFeeLibrary.isDynamicFee(fee), "fee must be the dynamic flag");
    }

    // ─── The regression this whole change exists for ──────────────────

    /// @notice Proves the standing-initializer grant is load-bearing in BOTH
    ///         directions: revoked => graduation reverts; granted => it succeeds.
    ///         Run against a TegridyV4Hook without `allowedInitializers`, the second
    ///         half of this test fails — which is the point.
    function test_initializerGrantIsLoadBearing() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        _fundMigrator(t0, t1);

        // Revoked: the hook refuses to let the migrator open the pool.
        tegridyHook.setInitializerAllowed(address(migrator), false);
        vm.prank(airlockMock);
        vm.expectRevert();
        migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);

        // Granted: the identical call goes through.
        tegridyHook.setInitializerAllowed(address(migrator), true);
        vm.prank(airlockMock);
        uint256 liquidity = migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);
        assertGt(liquidity, 0, "grant did not unblock graduation");
    }

    /// @dev The per-pool allowlist must still work on its own — the new standing
    ///      grant is an ADDITIONAL path, not a replacement (Cork defense intact).
    function test_perPoolAllowlistStillWorksWithoutStandingGrant() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        _fundMigrator(t0, t1);

        tegridyHook.setInitializerAllowed(address(migrator), false);
        tegridyHook.setPoolAllowed(migrator.getPoolKey(t0, t1), true);

        vm.prank(airlockMock);
        uint256 liquidity = migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);
        assertGt(liquidity, 0, "explicit per-pool allowlist should still admit the pool");
    }

    // ─── Access control ───────────────────────────────────────────────

    function test_initialize_onlyAirlock() public {
        (address t0, address t1) = _tokens();
        vm.expectRevert(TegridyLiquidityMigrator.NotAirlock.selector);
        migrator.initialize(t0, t1, abi.encode(TICK_SPACING));
    }

    function test_migrate_onlyAirlock() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        _fundMigrator(t0, t1);

        vm.expectRevert(TegridyLiquidityMigrator.NotAirlock.selector);
        migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);
    }

    function test_migrate_revertsOnUnconfiguredPair() public {
        (address t0, address t1) = _tokens();
        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.PoolNotConfigured.selector);
        migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);
    }

    function test_initialize_rejectsOutOfRangeTickSpacing() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory none = new BeneficiaryData[](0);
        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.InvalidTickSpacing.selector);
        migrator.initialize(t0, t1, _migratorData(int24(0), 0, none));
    }

    /// @notice A fee split is only acceptable if something can actually PAY it.
    ///         With a locker wired it is recorded; with no locker it must be
    ///         REJECTED rather than silently dropped, or every Fact Sheet
    ///         publishing that split would be false.
    function test_initialize_recordsBeneficiariesWhenALockerCanPayThem() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](2);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        // Doppler's 5% floor — see test_initialize_enforcesDopplerProtocolFloor.
        bens[1] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(5e16)});

        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));

        (uint32 lockDuration, BeneficiaryData[] memory stored) = migrator.getFeeConstitution(t0, t1);
        assertEq(lockDuration, 0, "duration must round-trip");
        assertEq(stored.length, 2, "the split must be recorded, not dropped");
        assertEq(uint256(stored[0].shares), 95e16);
    }

    /// @notice The fail-closed half. A migrator deployed WITHOUT a locker cannot
    ///         pay anyone, so it must refuse the launch outright.
    function test_initialize_rejectsBeneficiariesWhenNoLockerIsWired() public {
        TegridyLiquidityMigrator lockerless = new TegridyLiquidityMigrator(
            airlockMock,
            manager,
            IPositionManager(address(lpm)),
            IPermit2Approve(address(permit2)),
            IHooks(address(tegridyHook)),
            rescue,
            ITegridyFeeLocker(address(0))
        );

        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](1);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(1e18)});

        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.FeeConstitutionUnsupported.selector);
        lockerless.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));
    }

    /// @notice With a split declared, the POSITION must go to the locker — that is
    ///         the only contract that can pay the beneficiaries. Sending it to the
    ///         launch timelock instead would silently strand the constitution.
    function test_migrate_routesPositionToLockerWhenSplitDeclared() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](2);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        bens[1] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(5e16)});

        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));
        _fundMigrator(t0, t1);

        uint256 tokenId = lpm.nextTokenId();
        vm.prank(airlockMock);
        migrator.migrate(SQRT_PRICE_1_1, t0, t1, launchTimelock);

        assertEq(
            IERC721(address(lpm)).ownerOf(tokenId),
            address(feeLocker),
            "position must be held by the locker so the split can be paid"
        );

        // And the lock must be registered in the SAME transaction — a position in
        // the locker with no recorded split is collectable and releasable by
        // nobody, i.e. permanently stranded.
        (, address recipient, uint32 unlockDate, BeneficiaryData[] memory b) = feeLocker.getLock(tokenId);
        assertEq(recipient, launchTimelock, "release recipient must be the launch");
        assertEq(unlockDate, 0, "zero duration must stay PERMANENT, not become releasable now");
        assertEq(b.length, 1);
    }

    /// @notice Same reasoning for an LP lock we do not implement.
    function test_initialize_rejectsLockDurationItCannotHonour() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory none = new BeneficiaryData[](0);

        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.LockDurationUnsupported.selector);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 30 days, none));
    }

    /// @notice POSITIVE CONTROL for both rejections: the SDK's exact payload shape
    ///         with no beneficiaries and no lock is accepted and configures the pool.
    function test_initialize_acceptsTheSdkPayloadShape() public {
        (address t0, address t1) = _tokens();
        _configure(t0, t1);
        PoolKey memory k2 = migrator.getPoolKey(t0, t1);
        (uint24 fee, int24 spacing) = (k2.fee, k2.tickSpacing);
        assertTrue(LPFeeLibrary.isDynamicFee(fee), "must force the dynamic-fee flag");
        assertEq(spacing, TICK_SPACING, "tick spacing must come from the payload");
    }

    // ─── Recovery ─────────────────────────────────────────────────────

    /// @notice `sweepStuck` is permissionless but its destination is immutable, so
    ///         an arbitrary caller cannot redirect anything.
    function test_sweepStuck_sendsToFixedRescueRecipient() public {
        (address t0,) = _tokens();
        IERC20(t0).transfer(address(migrator), SEED);

        vm.prank(makeAddr("randomCaller"));
        migrator.sweepStuck(t0);

        assertEq(IERC20(t0).balanceOf(rescue), SEED, "stranded funds not recovered");
        assertEq(IERC20(t0).balanceOf(address(migrator)), 0, "migrator still holding");
    }

    function test_sweepStuck_noopWhenEmpty() public {
        (address t0,) = _tokens();
        migrator.sweepStuck(t0); // must not revert
        assertEq(IERC20(t0).balanceOf(rescue), 0);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _tokens() internal view returns (address t0, address t1) {
        t0 = Currency.unwrap(currency0);
        t1 = Currency.unwrap(currency1);
    }

    /// @dev Encodes EXACTLY what the Doppler SDK emits for a uniswapV4 migration:
    ///      (uint24 fee, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[]).
    ///      Hand-rolling a convenient shape here would let the migrator pass tests
    ///      and revert on the first real launch.
    function _migratorData(int24 tickSpacing, uint32 lockDuration, BeneficiaryData[] memory bens)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(uint24(3000), tickSpacing, lockDuration, bens);
    }

    function _configure(address t0, address t1) internal {
        BeneficiaryData[] memory none = new BeneficiaryData[](0);
        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, none));
    }

    /// @dev Stands in for `Airlock.migrate`, which transfers both legs to the
    ///      migrator before invoking it.
    function _fundMigrator(address t0, address t1) internal {
        IERC20(t0).transfer(address(migrator), SEED);
        IERC20(t1).transfer(address(migrator), SEED);
    }

    function _mineAndDeployHook(address paramAdmin_) internal returns (TegridyV4Hook h) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs =
            abi.encode(manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury);
        (address hookAddr_, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TegridyV4Hook).creationCode, ctorArgs);
        h = new TegridyV4Hook{salt: salt}(
            manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        require(address(h) == hookAddr_, "hook addr mismatch");
    }

    // ─── Doppler's 5% protocol floor ────────────────────────────────────────
    //
    // A custom LiquidityMigrator REPLACES Doppler's own module, so anything theirs
    // enforces and ours does not is simply not enforced. Their `UniswapV4Migrator`
    // requires the Airlock owner to hold >= 5% of the streamed fees; probing the
    // deployed 0x0820a4d0…05f5 with `from = Airlock` returns InvalidProtocolOwnerBeneficiary()
    // when the owner is absent and InvalidProtocolOwnerShares(5e16, 4e16) at 4%.
    // Dropping it would mean petitioning Whetstone to whitelist a module that deletes
    // their revenue. These pin that we enforce the same rule, with the same selectors.

    function test_initialize_rejectsAConstitutionThatOmitsTheProtocolOwner() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](1);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(1e18)});

        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.InvalidProtocolOwnerBeneficiary.selector);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));
    }

    function test_initialize_rejectsAProtocolOwnerShareBelowTheFloor() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](2);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(96e16)});
        bens[1] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(4e16)}); // 4%

        vm.prank(airlockMock);
        vm.expectRevert(
            abi.encodeWithSelector(
                TegridyLiquidityMigrator.InvalidProtocolOwnerShares.selector, uint96(5e16), uint96(4e16)
            )
        );
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));
    }

    function test_initialize_acceptsExactlyTheFloor() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](2);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        bens[1] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(5e16)});

        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));

        (, BeneficiaryData[] memory stored) = migrator.getFeeConstitution(t0, t1);
        assertEq(stored.length, 2, "a floor-satisfying constitution must be recorded");
    }

    /// @notice A list may name the owner twice. Taking only the first entry would
    ///         under-count their real take and reject a split Doppler itself accepts.
    function test_initialize_sumsDuplicateProtocolOwnerEntries() public {
        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](3);
        bens[0] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(3e16)});
        bens[1] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        bens[2] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(2e16)}); // 3+2 = 5%

        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));

        (, BeneficiaryData[] memory stored) = migrator.getFeeConstitution(t0, t1);
        assertEq(stored.length, 3, "duplicate owner entries must sum, not reject");
    }

    /// @notice The owner is read LIVE, not pinned: Whetstone's owner is a 3-of-6 Safe
    ///         and can rotate. A pinned copy would turn a rotation into a revert on
    ///         every graduation.
    function test_initialize_followsAnAirlockOwnerRotation() public {
        address rotated = makeAddr("rotatedDopplerOwner");
        vm.mockCall(airlockMock, abi.encodeWithSignature("owner()"), abi.encode(rotated));

        (address t0, address t1) = _tokens();
        BeneficiaryData[] memory bens = new BeneficiaryData[](2);
        bens[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        bens[1] = BeneficiaryData({beneficiary: rotated, shares: uint96(5e16)});

        vm.prank(airlockMock);
        migrator.initialize(t0, t1, _migratorData(TICK_SPACING, 0, bens));

        // And the OLD owner no longer satisfies it.
        BeneficiaryData[] memory stale = new BeneficiaryData[](2);
        stale[0] = BeneficiaryData({beneficiary: makeAddr("creator"), shares: uint96(95e16)});
        stale[1] = BeneficiaryData({beneficiary: protocolOwner, shares: uint96(5e16)});
        vm.prank(airlockMock);
        vm.expectRevert(TegridyLiquidityMigrator.InvalidProtocolOwnerBeneficiary.selector);
        migrator.initialize(makeAddr("t2"), makeAddr("t3"), _migratorData(TICK_SPACING, 0, stale));
    }
}
