// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The Doppler Airlock's migrator interface. Doppler core is BUSL-1.1 and is
///      NOT vendored — but `src/interfaces/ILiquidityMigrator.sol` is MIT, so this
///      restatement is the licensed surface, not a fork. Verified byte-for-byte
///      against the deployed Airlock's verified source (2026-07-28).
interface ILiquidityMigrator {
    function initialize(address asset, address numeraire, bytes calldata data) external returns (address pool);
    function migrate(uint160 sqrtPriceX96, address token0, address token1, address recipient)
        external
        payable
        returns (uint256 liquidity);
}

/// @dev Minimal Permit2 surface. Declared locally rather than remapped: `permit2/`
///      resolves only inside v4-periphery's own build context, and adding a root
///      remapping for one function would widen the import graph for every contract.
///      Mirrors the locally-declared `IPremiumAccess` in TegridyV4Hook.
/// @dev The one Airlock getter this migrator needs. Doppler's Airlock exposes `owner()`
///      (its Whetstone Safe); the protocol-owner fee floor is measured against it, read
///      LIVE rather than pinned so a Safe rotation cannot brick every graduation.
interface IAirlockOwner {
    function owner() external view returns (address);
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev The slice of `TegridyFeeLocker` this migrator calls. Declared here rather
///      than imported to keep the dependency one-directional — the locker imports
///      `BeneficiaryData` from this file.
interface ITegridyFeeLocker {
    function lockPosition(
        uint256 tokenId,
        PoolKey calldata poolKey,
        address recipient,
        uint32 unlockDate,
        BeneficiaryData[] calldata beneficiaries
    ) external;
}

/// @dev Mirrors Doppler's MIT `src/types/BeneficiaryData.sol`. Restated rather
///      than imported because Doppler core is not vendored — the type is MIT, so
///      this is the licensed surface. Field order and widths are load-bearing:
///      they must match what the SDK's `encodeAbiParameters` produces.
struct BeneficiaryData {
    address beneficiary;
    uint96 shares;
}

/// @title  TegridyLiquidityMigrator — graduate a Doppler launch into a Tegridy-hooked V4 pool
///
/// @notice Doppler's Airlock lets an integrator supply its own `LiquidityMigrator`
///         module (module state 4). This is ours. Instead of graduating a launch
///         into a bare canonical Uniswap V4 pool, it graduates into a canonical V4
///         pool that carries `TegridyV4Hook` — so the protocol earns the pool's fee
///         skim for as long as the pool trades, while the pool itself stays fully
///         canonical (Uniswap routing, aggregators, and the Uniswap UI all work).
///
/// @dev    WHAT WE TAKE, AND WHAT WE DO NOT. The protocol's capture is the HOOK's
///         fee skim — an annuity on trade flow. The LP position itself is minted to
///         the Airlock-supplied `recipient` (the launch's own timelock), never to
///         us. Retaining a launch's graduated liquidity would be a rug, and no
///         amount of venue ownership justifies it. Owning the venue ≠ owning the
///         liquidity; keep that seam where it is.
///
/// @dev    LICENSE POSTURE. `ILiquidityMigrator` (MIT), `TickLibrary` (MIT) and the
///         Uniswap v4-core / v4-periphery libraries (MIT) are the only external
///         surfaces used. Doppler's own `UniswapV4Migrator.sol`, `Airlock.sol`,
///         `StreamableFeesLocker.sol` and `DERC20.sol` are BUSL-1.1 with NO
///         registered Additional Use Grant (checked 2026-07-16 and re-checked
///         2026-07-28: `doppler-license-grants.whetstoneresearch.eth` unregistered),
///         so production forking is barred until 2027-12-31. This implementation is
///         independent — do NOT "simplify" it later by copying theirs.
///
/// @dev    GOING LIVE takes two things this contract cannot do for itself:
///           1. Whetstone must whitelist this address on the Airlock:
///              `setModuleState(address(this), 4)`. Airlock owner is the Whetstone
///              multisig; `Airlock.create` reverts on a non-whitelisted module.
///           2. `TegridyV4Hook` must grant this address a standing initializer
///              allowance (`admin.proposeInitializerAllowed` → 48h →
///              `executeInitializerAllowed`). WITHOUT IT `migrate()` REVERTS at
///              `poolManager.initialize` with `PoolNotAllowed()` — and because
///              `Airlock.migrate` is permissionless and transfers the graduated
///              balances to this contract BEFORE calling us, a revert there strands
///              them here until the grant lands. `sweepStuck` is the escape hatch.
contract TegridyLiquidityMigrator is ILiquidityMigrator {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error NotAirlock();
    error ZeroAddress();
    error InvalidTickSpacing();
    error PoolNotConfigured();
    error ZeroLiquidity();
    error TickOutOfRange();
    /// @dev The launch declared a fee-beneficiary split this migrator cannot pay.
    ///      See `initialize` — failing closed beats publishing an unbacked split.
    /// @notice The beneficiary list does not include the Airlock owner at all.
    /// @dev    Selector 0xdfa06864 — byte-identical to Doppler's own `UniswapV4Migrator`,
    ///         verified by probing the deployed 0x0820a4d0…05f5 with `from = Airlock`.
    error InvalidProtocolOwnerBeneficiary();

    /// @notice The Airlock owner is present but below the protocol floor.
    /// @dev    Selector 0x2b6dc823, matching Doppler's. Args are (expected, actual) in WAD.
    error InvalidProtocolOwnerShares(uint96 expected, uint96 actual);

    error FeeConstitutionUnsupported();
    /// @dev The launch declared an LP lock duration this migrator does not implement.
    error LockDurationUnsupported();

    // ─── Events ───────────────────────────────────────────────────────
    event MigrationConfigured(address indexed asset, address indexed numeraire, PoolId indexed poolId, int24 tickSpacing);
    event Migrated(
        PoolId indexed poolId, address indexed recipient, uint160 sqrtPriceX96, uint256 liquidity, uint256 tokenId
    );
    event StuckSwept(address indexed token, address indexed to, uint256 amount);
    /// @notice A post-migration residue could not be returned to the launch — the
    ///         recipient rejected the ETH. The migration itself SUCCEEDED; only the
    ///         leftover dust is stuck, and `sweepStuck` recovers it. Emitted rather
    ///         than reverted so a recipient that cannot receive ETH can never undo
    ///         a completed graduation. Watch for this: it is the only signal that
    ///         value is sitting in this contract.
    event RefundFailed(address indexed to, uint256 amount);

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The Doppler Airlock. Sole authorized caller of initialize/migrate.
    /// @notice Doppler's protocol fee floor: 5% of the streamed fees, in WAD.
    /// @dev    Doppler's `UniswapV4Migrator` enforces this and reverts below it — probed
    ///         live against the deployed module, which returned expected 5e16 / actual 4e16
    ///         for a 4% owner share. We enforce the SAME floor: a migrator that quietly
    ///         dropped it would be asking Whetstone to whitelist a module that removes
    ///         their own revenue, and no honest petition survives that.
    uint96 public constant PROTOCOL_OWNER_MIN_SHARES = 5e16; // 5% of 1e18

    address public immutable airlock;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IPermit2Approve public immutable permit2;

    /// @notice TegridyV4Hook. Every pool this migrator opens carries it — that is
    ///         the entire point of the contract.
    IHooks public immutable hook;

    /// @notice Recovery sink for liquidity stranded by a failed migrate (see the
    ///         go-live note above). Set once at deploy to the protocol multisig.
    address public immutable rescueRecipient;

    /// @notice Where a launch's LP position goes when it declares a fee split, and
    ///         what pays that split. See `TegridyFeeLocker`.
    ITegridyFeeLocker public immutable feeLocker;

    struct MigrationConfig {
        PoolKey key;
        /// @dev Duration, not a date — converted to an unlock date at migrate time.
        uint32 lockDuration;
        BeneficiaryData[] beneficiaries;
    }

    /// @dev Per-pair migration config, keyed the way `migrate` receives it.
    mapping(address token0 => mapping(address token1 => MigrationConfig)) internal _configs;

    /// @notice The pool key a pair will graduate into.
    function getPoolKey(address token0, address token1) external view returns (PoolKey memory) {
        return _configs[token0][token1].key;
    }

    /// @notice The fee constitution recorded for a pair at create time.
    function getFeeConstitution(address token0, address token1)
        external
        view
        returns (uint32 lockDuration, BeneficiaryData[] memory beneficiaries)
    {
        MigrationConfig storage c = _configs[token0][token1];
        return (c.lockDuration, c.beneficiaries);
    }

    /// @dev The Airlock sends the numeraire leg as native ETH when token0 is the
    ///      zero address, so this contract must be able to receive it.
    receive() external payable {}

    modifier onlyAirlock() {
        if (msg.sender != airlock) revert NotAirlock();
        _;
    }

    constructor(
        address airlock_,
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IPermit2Approve permit2_,
        IHooks hook_,
        address rescueRecipient_,
        ITegridyFeeLocker feeLocker_
    ) {
        if (
            airlock_ == address(0) || address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || address(hook_) == address(0) || rescueRecipient_ == address(0)
        ) revert ZeroAddress();
        airlock = airlock_;
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        hook = hook_;
        rescueRecipient = rescueRecipient_;
        // Intentionally MAY be zero: a deployment with no locker still serves
        // launches that declare no fee split, and `initialize` fails closed on any
        // that do. Zero here is a deliberate capability limit, not a misconfig.
        feeLocker = feeLocker_;
    }

    // ─── ILiquidityMigrator ───────────────────────────────────────────

    /// @inheritdoc ILiquidityMigrator
    /// @dev Called by the Airlock during `create`, long before the launch graduates.
    ///      Returns the zero address because a V4 pool has no address of its own —
    ///      it is a `PoolId` inside the singleton PoolManager. The Airlock passes
    ///      this straight to `DERC20.lockPool`, which is why the V4 path is
    ///      lock-exempt by construction.
    function initialize(address asset, address numeraire, bytes calldata data)
        external
        onlyAirlock
        returns (address)
    {
        // MUST match what the Doppler SDK encodes for a `uniswapV4` migration —
        // (uint24 fee, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[]) —
        // NOT a shape of our own choosing. The SDK builds this payload from its
        // own migration config; a migrator that decoded anything else would
        // revert on every real launch. An earlier version decoded a bare
        // `int24`, which would have failed the first time it was actually used.
        (uint24 fee_, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[] memory beneficiaries) =
            abi.decode(data, (uint24, int24, uint32, BeneficiaryData[]));

        // `fee` is decoded but deliberately NOT used: this pool is dynamic-fee
        // (TegridyV4Hook reverts otherwise), so the caller's static fee cannot
        // apply. Silently accepting a fee we do not honour would be worse than
        // ignoring it loudly, hence this comment rather than a variable rename.
        fee_;

        // FEE CONSTITUTION — fail closed rather than publish a split we do not pay.
        //
        // Those beneficiaries ARE the launch's advertised fee split (creator /
        // attention / protocol / Doppler). Doppler honours them by locking the LP
        // in its StreamableFeesLocker and streaming fees out. That locker is
        // BUSL-1.1 and we do not have an equivalent yet: this migrator mints the
        // position to the launch's timelock and the hook skims protocol fees, so
        // there is no mechanism here that would pay a beneficiary list.
        //
        // Accepting the list and dropping it would make every Fact Sheet's
        // published constitution false — precisely the disclosure failure this
        // product exists to prevent. `TegridyFeeLocker` is what pays it, so a
        // constitution is only acceptable if we actually have one wired.
        if (beneficiaries.length > 0 && address(feeLocker) == address(0)) {
            revert FeeConstitutionUnsupported();
        }

        // DOPPLER'S 5% PROTOCOL FLOOR — enforced here, not assumed upstream.
        //
        // Doppler's own `UniswapV4Migrator` requires the Airlock owner to appear in the
        // beneficiary list with >= 5% of the streamed fees, and reverts otherwise. That
        // floor is how Doppler earns from launches that use its Airlock. Because a custom
        // LiquidityMigrator REPLACES their module, anything it does not enforce is simply
        // not enforced — so a migrator that omitted this would be asking Whetstone to
        // whitelist a module that deletes their revenue. We enforce the same rule, with
        // the same selectors, so the two modules are indistinguishable on this point.
        //
        // The owner is read LIVE from the Airlock rather than pinned at construction:
        // Whetstone's owner is a 3-of-6 Safe and can be rotated, and a pinned copy would
        // turn a rotation into a revert on every graduation.
        if (beneficiaries.length > 0) {
            address protocolOwner = IAirlockOwner(airlock).owner();
            uint96 ownerShares = 0;
            bool found = false;
            for (uint256 i = 0; i < beneficiaries.length; ++i) {
                if (beneficiaries[i].beneficiary == protocolOwner) {
                    // Sum rather than break: a list may legitimately name an address twice,
                    // and taking only the first entry would under-count the owner's real
                    // take and reject a list Doppler itself would accept.
                    ownerShares += beneficiaries[i].shares;
                    found = true;
                }
            }
            if (!found) revert InvalidProtocolOwnerBeneficiary();
            if (ownerShares < PROTOCOL_OWNER_MIN_SHARES) {
                revert InvalidProtocolOwnerShares(PROTOCOL_OWNER_MIN_SHARES, ownerShares);
            }
        }
        // A lock with nobody to pay is meaningless — and it would silently become
        // a PERMANENT lock in the locker's semantics, stranding the position.
        if (lockDuration > 0 && beneficiaries.length == 0) revert LockDurationUnsupported();
        // Mirrors v4-core's own bounds (PoolManager.initialize reverts outside them).
        if (tickSpacing < TickMath.MIN_TICK_SPACING || tickSpacing > TickMath.MAX_TICK_SPACING) {
            revert InvalidTickSpacing();
        }

        bool assetIsToken0 = asset < numeraire;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(assetIsToken0 ? asset : numeraire),
            currency1: Currency.wrap(assetIsToken0 ? numeraire : asset),
            // FORCED, never caller-supplied: TegridyV4Hook._afterInitialize reverts
            // `NotDynamicFee()` on anything else, so accepting a fee from `data`
            // would only create a config that cannot migrate.
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: tickSpacing,
            hooks: hook
        });

        MigrationConfig storage cfg = _configs[Currency.unwrap(key.currency0)][Currency.unwrap(key.currency1)];
        cfg.key = key;
        cfg.lockDuration = lockDuration;
        delete cfg.beneficiaries;
        for (uint256 i; i < beneficiaries.length; ++i) {
            cfg.beneficiaries.push(beneficiaries[i]);
        }

        emit MigrationConfigured(asset, numeraire, key.toId(), tickSpacing);

        return address(0);
    }

    /// @inheritdoc ILiquidityMigrator
    /// @dev The Airlock transfers both legs to this contract and THEN calls this, so
    ///      the amounts to deploy are simply our own balances. A single full-range
    ///      position is deliberate: it is the standard, auditable shape, and it
    ///      leaves no protocol-chosen band that could be read as front-running the
    ///      launch's own price discovery.
    function migrate(uint160 sqrtPriceX96, address token0, address token1, address recipient)
        external
        payable
        onlyAirlock
        returns (uint256 liquidity)
    {
        MigrationConfig storage cfg = _configs[token0][token1];
        PoolKey memory key = cfg.key;
        // currency1 is never the zero address in a valid config, so this doubles as
        // an "initialize was never called for this pair" guard.
        if (Currency.unwrap(key.currency1) == address(0)) revert PoolNotConfigured();
        if (recipient == address(0)) revert ZeroAddress();

        // WHERE THE POSITION GOES. With a declared fee split the position must be
        // held by the locker — that is the only thing that can pay the split the
        // launch advertised. Without one it goes straight to the launch's timelock.
        // Either way it never stays here, and we never keep it.
        bool hasConstitution = cfg.beneficiaries.length > 0;
        address positionOwner = hasConstitution ? address(feeLocker) : recipient;

        // SLITHER 2026-07-28: the returned tick is genuinely unused — we mint the
        // full usable range, so there is no current-tick-relative band to place.
        // slither-disable-next-line unused-return
        poolManager.initialize(key, sqrtPriceX96);

        uint256 amount0 = token0 == address(0) ? address(this).balance : IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

        int24 lowerTick = TickMath.minUsableTick(key.tickSpacing);
        int24 upperTick = TickMath.maxUsableTick(key.tickSpacing);
        if (lowerTick >= upperTick) revert TickOutOfRange();

        // ROUNDING HEADROOM — load-bearing, do not "simplify" back to the raw
        // balances. `getLiquidityForAmounts` rounds DOWN, but minting that liquidity
        // rounds UP when it computes what to actually pull, so the mint can demand
        // one wei more than the figure we sized it from. Size the position off
        // `balance - 1` and leave the true balance as the cap, so that wei has
        // somewhere to come from. Without this the overshoot reverts `migrate()` —
        // and the Airlock has ALREADY transferred the graduated funds here by then,
        // so the launch strands rather than simply failing.
        // SLITHER 2026-07-28 (incorrect-equality, ×3 below): the detector targets
        // balance-equality checks an attacker can break by force-sending tokens.
        // These are plain zero-guards on locally-derived values — underflow and
        // zero-liquidity protection — with no adversarially reachable equality.
        // slither-disable-next-line incorrect-equality
        uint256 sizing0 = amount0 == 0 ? 0 : amount0 - 1;
        // slither-disable-next-line incorrect-equality
        uint256 sizing1 = amount1 == 0 ? 0 : amount1 - 1;

        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(lowerTick),
            TickMath.getSqrtPriceAtTick(upperTick),
            sizing0,
            sizing1
        );
        // slither-disable-next-line incorrect-equality
        if (liquidity == 0) revert ZeroLiquidity();

        uint256 tokenId = positionManager.nextTokenId();
        _mintFullRange(key, lowerTick, upperTick, liquidity, amount0, amount1, positionOwner);

        if (hasConstitution) {
            // Register the split in the SAME transaction that hands the locker the
            // position. A gap would leave a position sitting in the locker with no
            // recorded beneficiaries — collectable by nobody and releasable by
            // nobody, i.e. permanently stranded.
            //
            // lockDuration is a DURATION; the locker stores an unlock DATE. A
            // declared split with no duration means the position is never
            // released and fees stream forever, which is exactly the locker's
            // `unlockDate == 0` permanent case — so pass 0 straight through
            // rather than turning it into `block.timestamp`, which would make it
            // instantly releasable.
            uint32 unlockDate =
                cfg.lockDuration == 0 ? 0 : uint32(block.timestamp) + cfg.lockDuration;
            feeLocker.lockPosition(tokenId, key, recipient, unlockDate, cfg.beneficiaries);
        }

        // Whatever the position did not consume belongs to the launch, not to us.
        // This goes to the launch's timelock even when the POSITION went to the
        // locker — residual dust is not fee revenue and has no beneficiary claim.
        _refund(token0, recipient);
        _refund(token1, recipient);

        emit Migrated(key.toId(), positionOwner, sqrtPriceX96, liquidity, tokenId);
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _mintFullRange(
        PoolKey memory key,
        int24 lowerTick,
        int24 upperTick,
        uint256 liquidity,
        uint256 amount0,
        uint256 amount1,
        address recipient
    ) internal {
        // The PositionManager pulls ERC20s through Permit2 (PositionManager._pay
        // takes the permit2 branch whenever payer != the PositionManager itself).
        // Native ETH is paid by value instead, so only the ERC20 legs need this.
        _approveViaPermit2(Currency.unwrap(key.currency0), amount0);
        _approveViaPermit2(Currency.unwrap(key.currency1), amount1);

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP), uint8(Actions.SWEEP)
        );

        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(
            key,
            lowerTick,
            upperTick,
            liquidity,
            // Caps, not slippage bounds: we are depositing a fixed pot that the
            // Airlock already handed us, so the maximums ARE the balances.
            _toUint128(amount0),
            _toUint128(amount1),
            recipient,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        // Reclaim anything the mint left sitting in the PositionManager (native dust
        // in particular) so `_refund` can pass it on to the launch.
        params[2] = abi.encode(key.currency0, address(this));
        params[3] = abi.encode(key.currency1, address(this));

        uint256 nativeValue = Currency.unwrap(key.currency0) == address(0) ? amount0 : 0;
        positionManager.modifyLiquidities{value: nativeValue}(abi.encode(actions, params), block.timestamp);
    }

    function _approveViaPermit2(address token, uint256 amount) internal {
        // SLITHER 2026-07-28: zero-guard, not a balance equality. Native ETH has no
        // ERC20 to approve and a zero amount needs no allowance — both are skips.
        // slither-disable-next-line incorrect-equality
        if (token == address(0) || amount == 0) return;
        IERC20(token).forceApprove(address(permit2), amount);
        // `type(uint48).max` = never expires. The allowance is consumed inside this
        // same call; a residual approval to the PositionManager grants nothing an
        // attacker could use, since this contract only ever holds funds mid-migrate.
        permit2.approve(token, address(positionManager), _toUint128(amount), type(uint48).max);
    }

    function _refund(address token, address to) internal {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                // SLITHER 2026-07-28: not arbitrary — `to` is `migrate`'s `recipient`,
                // which only the Airlock can supply (`onlyAirlock`), and which the
                // Airlock sets to the launch's own timelock. No caller-chosen path
                // reaches here. Failure is swallowed on purpose (see below).
                // slither-disable-next-line arbitrary-send-eth
                (bool ok,) = to.call{value: bal}("");
                // Best-effort: a recipient that rejects ETH must not undo a
                // completed migration. Surface it as an event instead of
                // swallowing it — the residue stays recoverable via sweepStuck,
                // but nobody can act on that unless the failure is observable.
                if (!ok) emit RefundFailed(to, bal);
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }

    function _toUint128(uint256 x) internal pure returns (uint128) {
        return x > type(uint128).max ? type(uint128).max : uint128(x);
    }

    // ─── Recovery ─────────────────────────────────────────────────────

    /// @notice Sweep assets stranded by a failed migration to the immutable
    ///         `rescueRecipient`.
    /// @dev    Permissionless BY DESIGN, and safe because the destination is fixed
    ///         at construction: the caller chooses nothing, so there is no value in
    ///         calling it except to unstick funds. This exists because
    ///         `Airlock.migrate` moves the graduated balances here BEFORE invoking
    ///         `migrate()` — if that call reverts (e.g. the hook's initializer grant
    ///         was revoked between create and graduation), the funds are already
    ///         sitting in this contract with no other way out. Steady-state this is
    ///         a no-op: a successful `migrate` refunds every residue to the launch.
    function sweepStuck(address token) external {
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            // SLITHER 2026-07-28 (incorrect-equality, both branches): a
            // nothing-to-sweep early return. Anyone force-sending value here only
            // makes the guard pass, and the destination is immutable regardless.
            // slither-disable-next-line incorrect-equality
            if (amount == 0) return;
            // SLITHER 2026-07-28: `rescueRecipient` is immutable, set at
            // construction — not caller-influenced despite the open entrypoint.
            // slither-disable-next-line arbitrary-send-eth
            (bool ok,) = rescueRecipient.call{value: amount}("");
            if (!ok) revert ZeroAddress();
        } else {
            amount = IERC20(token).balanceOf(address(this));
            // slither-disable-next-line incorrect-equality
            if (amount == 0) return;
            IERC20(token).safeTransfer(rescueRecipient, amount);
        }
        emit StuckSwept(token, rescueRecipient, amount);
    }
}
