// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {TegridyCurveToken} from "./TegridyCurveToken.sol";

interface ITegridyFactoryMinimal {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface ITegridyPairMinimal {
    function mint(address to) external returns (uint256 liquidity);
    function totalSupply() external view returns (uint256);
}

interface IWETHMinimal {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title  TegridyCurveLauncher — the own EVM launch curve (zero third-party tolls).
/// @notice A pump.fun-shape virtual-reserve bonding curve that WE own end to end:
///         100% of the 1% trade fee stays inside the house (split with the launch
///         creator), and graduation adds liquidity into OUR TegridyFactory pair
///         with the LP minted directly to 0xdead — no Doppler carve, no Meteora
///         20%, no locker line, no migrator, not a satoshi to anyone but the
///         creator and us.
///
///         Economics are a faithful port of the audited Solana own-curve
///         (project_2026_08_02_own_curve_creator_split):
///           - trade fee `feeBps` (default 1%) on every buy (of ETH in) and
///             every sell (of ETH out);
///           - `creatorFeeShareBps` is a share OF THE FEE (default 50/50),
///             creator's cut rounds DOWN, protocol keeps the remainder, so
///             creator + protocol == fee exactly, always;
///           - the whole economics tuple is SNAPSHOTTED onto the launch at
///             `create` — owner config changes touch FUTURE launches only,
///             never live ones (why the setter needs no timelock: it cannot
///             act retroactively on anyone's position).
///
///         Fee payout is PULL, never push. The Solana curve's rent-band defect
///         (an inline per-trade credit to the creator's account could brick
///         every SELL) has an exact EVM analog: an inline `.call` to a creator
///         contract with a reverting receive() would brick the trade path.
///         Fees therefore accrue internally (`creatorFeeOf` / `protocolFees`)
///         and are claimed out-of-band; the trade path performs no value
///         transfer to any address a third party controls.
///
///         Pricing is a constant product over VIRTUAL reserves:
///             (virtualEth + ethReserve) * tokenReserve = k
///         with k struck at create as virtualEth * saleSupply. Buys round
///         tokens-out down, sells round eth-out down — both roundings grow k,
///         so the real-ETH solvency invariant (selling every outstanding token
///         back can never draw more than `ethReserve`) only ever gets safer.
///         Pricing is path-independent and needs no oracle — this contract has
///         NO sequencer-feed dependency and deploys identically on L1 and L2s.
///
///         Graduation: the buy that lifts `ethReserve` to `graduationEth`
///         completes the curve AND graduates it in the same transaction.
///         Overshoot is allowed (no clamp, no refund leg): every wei past the
///         threshold deepens the pool. On graduation the launcher flips the
///         token's transfer lock, wraps the raised ETH, pairs it with the
///         unsold curve tokens on OUR factory, and mints ALL LP to 0xdead —
///         liquidity is burned, not "locked by us", so the credibility story
///         needs no trust in our keys. The ecosystem reserve tranche (default
///         5% of supply, carved at create) transfers to protocol custody ONLY
///         at graduation; a launch that never graduates leaves its reserve —
///         and its unsold supply — inert in this contract forever, which is
///         the burn-on-failure semantics the reserve architecture decided
///         (docs/ULTIMATE_LAUNCHPAD_PLAN.md) with zero extra code or surface.
///
///         Graduation-seeding defense (adversarial review 2026-08-22): the
///         burned-LP floor is only real if graduation is the pair's FIRST
///         mint. TegridyCurveToken enforces that at the source — it is
///         transfer-locked to launcher-only until graduation, so no third party
///         can move tokens into a pair to pre-seed it at a hostile ratio.
///         `_graduate` adds a defense-in-depth pristine check (reserves must be
///         zero) and, rather than reverting the completing buy if it ever can't
///         get a clean pair (a full-factory MAX_PAIRS revert, or the
///         should-never-happen non-pristine pair), it DEFERS: the curve becomes
///         complete-but-sell-open and a permissionless `finalizeGraduation` can
///         retry. Holders always exit — buys stop, sells never do — so a
///         deferred graduation strands nobody.
///
///         Pause semantics: guardian or owner can pause, which halts CREATE
///         and BUY only. Sells, fee claims, and the graduation leg of an
///         in-flight buy are never pausable — the holders' exit can never be
///         blocked, the same invariant the Solana curve enforces.
contract TegridyCurveLauncher is OwnableNoRenounce, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────── Types ───────────────────────────────

    /// @notice Owner-tunable economics for FUTURE launches. Snapshotted in
    ///         full onto each launch at `create`.
    struct LaunchConfig {
        // Virtual ETH reserve seeding the curve price. Larger = flatter early
        // curve (lower opening price, less early-buyer advantage).
        uint128 virtualEth;
        // Real-ETH reserve level at which the curve completes + graduates.
        uint128 graduationEth;
        // Trade fee in bps of ETH-in (buys) / ETH-out (sells). Capped 3%.
        uint16 feeBps;
        // The trade fee is split THREE ways (creator / treasury / protocol),
        // each a share OF THE FEE in bps. Creator + treasury are set here;
        // protocol takes the remainder (fee - creator - treasury), so the three
        // always sum to exactly the fee. creator + treasury must be <= 10000.
        //   - creatorFeeShareBps: the volume magnet — the creator's cut, which
        //     is what brings order flow (the binding launcher constraint).
        //   - treasuryFeeShareBps: the Jungle Bay treasury — ecosystem survival
        //     funding (buybacks / bid-wall / community grants), a SECOND
        //     ecosystem stream alongside the supply reserve.
        //   - protocol (remainder): keeps the launchpad's own lights on.
        uint16 creatorFeeShareBps;
        uint16 treasuryFeeShareBps;
        // Ecosystem reserve carved off total supply at create, in bps. Cap 10%.
        uint16 reserveBps;
        // Custody the reserve tranche transfers to at graduation. Must be
        // nonzero whenever reserveBps > 0 — this launcher refuses to burn 5%
        // of a launch by misconfiguration (mirrors the Doppler facade guard).
        address reserveRecipient;
    }

    struct Launch {
        // Immutable-after-create identity + snapshotted economics.
        address creator;
        uint128 virtualEth;
        uint128 graduationEth;
        uint16 feeBps;
        uint16 creatorFeeShareBps;
        uint16 treasuryFeeShareBps;
        address reserveRecipient;
        uint256 saleSupply; // tokens placed on the curve at create
        uint256 reserveAmount; // tokens earmarked for the ecosystem reserve
        // Live curve state.
        uint256 ethReserve; // real ETH backing the curve (fees excluded)
        uint256 tokenReserve; // unsold tokens remaining on the curve
        bool graduated;
    }

    // ────────────────────────────── Errors ───────────────────────────────

    error ZeroAddress();
    error ConfigOutOfBounds();
    error ReserveNeedsRecipient();
    error BadTokenMetadata();
    error UnknownLaunch(address token);
    error AlreadyGraduated(address token);
    error ZeroTradeAmount();
    error SlippageExceeded(uint256 actual, uint256 minOut);
    error InsufficientCurveEth(uint256 wanted, uint256 available);
    error NotLaunchCreator(address caller);
    error NothingToClaim();
    error EthSendFailed(address to);
    error NotGuardianOrOwner(address caller);
    error CurveComplete(address token);
    error NotComplete(address token);
    error GraduationBlocked(address token);
    error FeeSharesExceedFee();

    // ────────────────────────────── Events ───────────────────────────────

    event LaunchCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 saleSupply,
        uint256 reserveAmount,
        uint128 virtualEth,
        uint128 graduationEth,
        uint16 feeBps,
        uint16 creatorFeeShareBps,
        uint16 treasuryFeeShareBps
    );
    event CurveBuy(
        address indexed token,
        address indexed buyer,
        uint256 ethIn,
        uint256 fee,
        uint256 tokensOut,
        uint256 ethReserve,
        uint256 tokenReserve
    );
    event CurveSell(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 fee,
        uint256 ethOut,
        uint256 ethReserve,
        uint256 tokenReserve
    );
    event Graduated(
        address indexed token,
        address indexed pair,
        uint256 ethToPool,
        uint256 tokensToPool,
        uint256 reserveToCustody,
        address reserveRecipient
    );
    /// @notice The completing buy raised the curve to its target but graduation
    ///         could not finalize this transaction (a full factory, or a
    ///         non-pristine pair). The curve is now complete-but-sell-open;
    ///         anyone can `finalizeGraduation` once a clean pair is available.
    event GraduationDeferred(address indexed token, uint256 ethReserve);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    event TreasuryFeesSwept(address indexed treasury, uint256 amount);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event LaunchConfigUpdated(LaunchConfig config);
    event PauseGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);

    // ───────────────────────────── Constants ─────────────────────────────

    /// @notice Every launch mints exactly this much — 1B tokens, 18 decimals
    ///         (the wizard-default supply across all our rails).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant BPS = 10_000;
    /// @notice Trade-fee ceiling — economics can never be quietly ratcheted
    ///         past 3% on future launches.
    uint16 public constant MAX_FEE_BPS = 300;
    /// @notice Ecosystem-reserve ceiling — 10% of supply.
    uint16 public constant MAX_RESERVE_BPS = 1_000;
    /// @notice Max allowed price gap between the curve's final spot price and
    ///         the pool's listing price, in bps. Ported from the Solana
    ///         own-curve (`PRICE_CONTINUITY_BAND_BPS`), whose test suite
    ///         proved the naive pump.fun-shaped parameters list ~7x BELOW the
    ///         final curve price — a rug-shaped candle on every graduation.
    ///         In this contract's shape (all raised ETH + all unsold tokens
    ///         into the pool) the listing/curve price ratio is exactly
    ///         `graduationEth / (virtualEth + graduationEth)`, so continuity
    ///         within 5% requires `graduationEth >= 19 * virtualEth`.
    ///         Overshoot on the completing buy only ever raises the ratio
    ///         (more real ETH), so the config-time check is the worst case.
    uint256 public constant PRICE_CONTINUITY_BAND_BPS = 500;
    /// @notice Absolute floors mirrored on-chain (adversarial review 2026-08-22
    ///         L-finding): the deploy script's CV-4 floor only guards the
    ///         constructor, so without these a later `setLaunchConfig` could
    ///         push a degenerate curve (1-wei virtualEth ⇒ first-buyer-takes-all;
    ///         dust graduationEth ⇒ an untradeable pool). Chosen so the
    ///         continuity default (`virtualEth = graduationEth / 19`) always
    ///         clears MIN_VIRTUAL_ETH at MIN_GRADUATION_ETH.
    uint256 public constant MIN_VIRTUAL_ETH = 0.005 ether;
    uint256 public constant MIN_GRADUATION_ETH = 0.1 ether;
    /// @notice The graduation pool's burn address — all LP goes here.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ──────────────────────────── Immutables ─────────────────────────────

    /// @notice OUR factory — graduation liquidity lands here and nowhere else.
    ITegridyFactoryMinimal public immutable FACTORY;
    /// @notice Canonical WETH for this chain (the pair's quote side).
    IWETHMinimal public immutable WETH;

    // ────────────────────────────── Storage ──────────────────────────────

    /// @notice Economics applied to launches created from now on.
    LaunchConfig public launchConfig;
    /// @notice Guardian that can pause create/buy (owner can too). Sells and
    ///         claims are never pausable.
    address public pauseGuardian;
    /// @notice The Jungle Bay treasury — destination of the treasury fee share.
    ///         Owner-settable, always non-zero. `sweepTreasuryFees` is
    ///         permissionless but can only ever pay THIS address, so a keeper
    ///         (or anyone) can flush the treasury with no custody risk.
    address public treasury;

    mapping(address token => Launch) internal _launches;
    address[] public allLaunches;

    /// @notice Accrued, unclaimed creator fees per launch token (pull-payment).
    mapping(address token => uint256) public creatorFeeOf;
    /// @notice Accrued, unclaimed protocol fees across all launches.
    uint256 public protocolFees;
    /// @notice Accrued, unswept Jungle Bay treasury fees across all launches.
    uint256 public treasuryFees;

    // ──────────────────────────── Construction ───────────────────────────

    constructor(
        address factory_,
        address weth_,
        address owner_,
        address pauseGuardian_,
        address treasury_,
        LaunchConfig memory config_
    ) OwnableNoRenounce(owner_) {
        if (
            factory_ == address(0) || weth_ == address(0) || pauseGuardian_ == address(0)
                || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        // Both integration points must already be real contracts — a fat-
        // fingered constructor arg here strands every launch's graduation.
        if (factory_.code.length == 0 || weth_.code.length == 0) revert ZeroAddress();
        FACTORY = ITegridyFactoryMinimal(factory_);
        WETH = IWETHMinimal(weth_);
        pauseGuardian = pauseGuardian_;
        treasury = treasury_;
        _setLaunchConfig(config_);
    }

    // ──────────────────────────── Launch: create ─────────────────────────

    /// @notice Deploy a fixed-supply token and open its bonding curve. Any
    ///         attached ETH executes the creator's first buy atomically —
    ///         nobody can trade the token before its creator's opening
    ///         position, because the token does not exist until this call.
    /// @return token The launch token address.
    function create(string calldata name, string calldata symbol)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        // Bound metadata so event consumers and the token's own storage can't
        // be griefed with megabyte strings.
        if (bytes(name).length == 0 || bytes(name).length > 64) revert BadTokenMetadata();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 16) revert BadTokenMetadata();

        LaunchConfig memory cfg = launchConfig;
        uint256 reserveAmount = (TOTAL_SUPPLY * cfg.reserveBps) / BPS;
        uint256 saleSupply = TOTAL_SUPPLY - reserveAmount;

        token = address(new TegridyCurveToken(name, symbol, TOTAL_SUPPLY, address(this)));

        Launch storage l = _launches[token];
        l.creator = msg.sender;
        l.virtualEth = cfg.virtualEth;
        l.graduationEth = cfg.graduationEth;
        l.feeBps = cfg.feeBps;
        l.creatorFeeShareBps = cfg.creatorFeeShareBps;
        l.treasuryFeeShareBps = cfg.treasuryFeeShareBps;
        l.reserveRecipient = cfg.reserveRecipient;
        l.saleSupply = saleSupply;
        l.reserveAmount = reserveAmount;
        l.tokenReserve = saleSupply;
        allLaunches.push(token);

        emit LaunchCreated(
            token,
            msg.sender,
            name,
            symbol,
            saleSupply,
            reserveAmount,
            cfg.virtualEth,
            cfg.graduationEth,
            cfg.feeBps,
            cfg.creatorFeeShareBps,
            cfg.treasuryFeeShareBps
        );

        if (msg.value > 0) {
            // The creator's opening buy is deterministic (fresh curve, no
            // competing orders possible), so no slippage floor is needed.
            _buy(token, l, msg.value, 0);
        }
    }

    // ───────────────────────────── Launch: buy ───────────────────────────

    /// @notice Buy `token` from its curve with the attached ETH.
    /// @param  minTokensOut Slippage floor — the trade reverts below it.
    function buy(address token, uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut)
    {
        Launch storage l = _requireLive(token);
        tokensOut = _buy(token, l, msg.value, minTokensOut);
    }

    function _buy(address token, Launch storage l, uint256 ethGross, uint256 minTokensOut)
        internal
        returns (uint256 tokensOut)
    {
        if (ethGross == 0) revert ZeroTradeAmount();
        // A launch whose graduation DEFERRED sits at ethReserve >= graduationEth
        // with graduated == false: it is complete, so no more buys (sells stay
        // open). The completing buy itself starts strictly below the target, so
        // this never blocks it — only a buy arriving into the deferred window.
        if (l.ethReserve >= l.graduationEth) revert CurveComplete(token);

        uint256 fee = (ethGross * l.feeBps) / BPS;
        uint256 ethIn = ethGross - fee;
        // Constant product over virtual reserves; tokens-out rounds DOWN
        // (curve-favoring — k can only grow).
        uint256 x = uint256(l.virtualEth) + l.ethReserve;
        tokensOut = (l.tokenReserve * ethIn) / (x + ethIn);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        // A dust buy that prices to zero tokens would be a donation — reject.
        if (tokensOut == 0) revert ZeroTradeAmount();

        l.ethReserve += ethIn;
        l.tokenReserve -= tokensOut;
        _accrueFee(token, l, fee);

        emit CurveBuy(token, msg.sender, ethIn, fee, tokensOut, l.ethReserve, l.tokenReserve);

        IERC20(token).safeTransfer(msg.sender, tokensOut);

        // The completing buy graduates in the same transaction. If graduation
        // can't finalize cleanly (full factory, or a pair that isn't pristine)
        // it DEFERS instead of reverting the buy: the curve stays
        // complete-but-sell-open and `finalizeGraduation` retries. Holders are
        // never trapped — sells keep working against the intact reserve.
        if (l.ethReserve >= l.graduationEth) {
            if (!_graduate(token, l)) emit GraduationDeferred(token, l.ethReserve);
        }
    }

    // ───────────────────────────── Launch: sell ──────────────────────────

    /// @notice Sell `tokensIn` of `token` back to its curve for ETH.
    /// @dev    Requires prior ERC-20 approval to this contract. Deliberately
    ///         NOT pausable: the holders' exit can never be blocked.
    /// @param  minEthOut Slippage floor on the NET (post-fee) ETH out.
    function sell(address token, uint256 tokensIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        Launch storage l = _requireLive(token);
        if (tokensIn == 0) revert ZeroTradeAmount();

        // Gross ETH released by the curve; rounds DOWN (k grows).
        uint256 x = uint256(l.virtualEth) + l.ethReserve;
        uint256 grossOut = (x * tokensIn) / (l.tokenReserve + tokensIn);
        // Unreachable under the k-invariant (buys/sells both round in the
        // curve's favor), kept as a loud failure over a silent misdraw.
        if (grossOut > l.ethReserve) revert InsufficientCurveEth(grossOut, l.ethReserve);

        uint256 fee = (grossOut * l.feeBps) / BPS;
        ethOut = grossOut - fee;
        if (ethOut < minEthOut) revert SlippageExceeded(ethOut, minEthOut);
        if (ethOut == 0) revert ZeroTradeAmount();

        l.ethReserve -= grossOut;
        l.tokenReserve += tokensIn;
        _accrueFee(token, l, fee);

        emit CurveSell(token, msg.sender, tokensIn, fee, ethOut, l.ethReserve, l.tokenReserve);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _sendEth(msg.sender, ethOut);
    }

    // ─────────────────────────────── Fees ────────────────────────────────

    /// @dev Three-way split (Solana-parity rounding): creator and treasury each
    ///      round DOWN, protocol keeps the remainder — the three cuts always sum
    ///      to exactly `fee`, and the remainder can never underflow because
    ///      creatorShare + treasuryShare <= BPS is enforced at config time.
    function _accrueFee(address token, Launch storage l, uint256 fee) internal {
        uint256 creatorCut = (fee * l.creatorFeeShareBps) / BPS;
        uint256 treasuryCut = (fee * l.treasuryFeeShareBps) / BPS;
        creatorFeeOf[token] += creatorCut;
        treasuryFees += treasuryCut;
        protocolFees += fee - creatorCut - treasuryCut;
    }

    /// @notice Claim the accrued creator fees for `token`. Pull-payment — a
    ///         creator address that reverts on receive can only hurt itself,
    ///         never the trade path. Never pausable.
    function claimCreatorFees(address token) external nonReentrant returns (uint256 amount) {
        Launch storage l = _launches[token];
        if (l.creator == address(0)) revert UnknownLaunch(token);
        if (msg.sender != l.creator) revert NotLaunchCreator(msg.sender);
        amount = creatorFeeOf[token];
        if (amount == 0) revert NothingToClaim();
        creatorFeeOf[token] = 0;
        emit CreatorFeesClaimed(token, msg.sender, amount);
        _sendEth(msg.sender, amount);
    }

    /// @notice Withdraw accrued protocol fees to `to`. Owner (multisig) only.
    function withdrawProtocolFees(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = protocolFees;
        if (amount == 0) revert NothingToClaim();
        protocolFees = 0;
        emit ProtocolFeesWithdrawn(to, amount);
        _sendEth(to, amount);
    }

    /// @notice Flush accrued Jungle Bay treasury fees to the treasury address.
    ///         Permissionless — a keeper (or anyone) can call it — but it can
    ///         only ever pay `treasury`, so there is no custody risk in leaving
    ///         it open. Never pausable (an ecosystem stream shouldn't be
    ///         freezable by a compromised guardian).
    function sweepTreasuryFees() external nonReentrant returns (uint256 amount) {
        amount = treasuryFees;
        if (amount == 0) revert NothingToClaim();
        treasuryFees = 0;
        address to = treasury; // always non-zero (constructor + setter enforce)
        emit TreasuryFeesSwept(to, amount);
        _sendEth(to, amount);
    }

    // ──────────────────────────── Graduation ─────────────────────────────

    /// @notice Permissionless retry of a DEFERRED graduation. A completing buy
    ///         that couldn't get a clean pair (full factory) leaves the launch
    ///         complete-but-sell-open; anyone calls this once a pristine pair is
    ///         obtainable to finalize the migration. Not pausable — a stuck
    ///         graduation must always be completable, like the holders' exit.
    /// @dev    Reverts if the launch isn't complete, already graduated, or
    ///         graduation still can't finalize (so the caller isn't charged for
    ///         a silent no-op).
    function finalizeGraduation(address token) external nonReentrant returns (bool) {
        Launch storage l = _launches[token];
        if (l.creator == address(0)) revert UnknownLaunch(token);
        if (l.graduated) revert AlreadyGraduated(token);
        if (l.ethReserve < l.graduationEth) revert NotComplete(token);
        if (!_graduate(token, l)) revert GraduationBlocked(token);
        return true;
    }

    /// @dev Returns true if graduation finalized, false if it must DEFER (no
    ///      state change on a false return, so the caller can leave the curve
    ///      complete-but-sell-open and retry). All curve state is finalized
    ///      before the external seeding calls (CEI); the whole path runs under
    ///      the caller's nonReentrant frame, and every external callee
    ///      (FACTORY, the pristine pair, WETH, the launch token) is trusted.
    function _graduate(address token, Launch storage l) internal returns (bool) {
        // Resolve a PRISTINE pair, or defer. Reuse an existing pair (created
        // empty by anyone — harmless) only if it still has zero reserves.
        address pair = FACTORY.getPair(token, address(WETH));
        if (pair == address(0)) {
            // The factory can be at MAX_PAIRS; never let that revert the
            // completing buy and wedge the curve. Defer and retry instead.
            try FACTORY.createPair(token, address(WETH)) returns (address created) {
                pair = created;
            } catch {
                return false;
            }
        }
        // Defense in depth: graduation must be the pair's FIRST mint, or the
        // burned-LP floor is not a floor (a pre-seeded hostile ratio would
        // route most of the deposit to a squatter's LP — the 08-22 review's
        // CRITICAL). The seedability precondition is "no LP outstanding", i.e.
        // totalSupply == 0 — NOT "reserves == 0". Reserves are the wrong gate:
        // WETH is not transfer-locked, so anyone can donate 1 wei and call the
        // permissionless sync() to make reserves non-zero IRREVERSIBLY (no LP
        // to burn, and the locked token can't be swapped in to drain them),
        // which would defer graduation forever. totalSupply is immune to that:
        // the token's transfer lock makes it impossible for any third party to
        // mint LP (LP needs tokens IN the pair), and TegridyPair.mint's
        // first-mint branch computes deposits as balance-minus-reserve, so it
        // absorbs a stray WETH donation as pool depth and still burns 100% of
        // the LP to 0xdead. If totalSupply is ever non-zero here (a transfer-
        // lock bug), DEFER rather than mint into a pool someone else holds.
        if (ITegridyPairMinimal(pair).totalSupply() != 0) return false;

        l.graduated = true;
        uint256 ethToPool = l.ethReserve;
        uint256 tokensToPool = l.tokenReserve;
        uint256 reserveOut = l.reserveAmount;
        address reserveRecipient = l.reserveRecipient;
        l.ethReserve = 0;
        l.tokenReserve = 0;

        // Lift the token's curve-phase transfer lock, so the pool is tradeable
        // the instant it holds liquidity. Launcher-only, one-shot.
        TegridyCurveToken(token).graduate();

        WETH.deposit{value: ethToPool}();
        // House WETH check-the-bool convention (canonical WETH9 returns true).
        if (!WETH.transfer(pair, ethToPool)) revert EthSendFailed(pair);
        IERC20(token).safeTransfer(pair, tokensToPool);
        // Mint ALL LP to 0xdead: liquidity is burned, not custodied. Nobody —
        // including us — can ever pull this floor out from under holders.
        ITegridyPairMinimal(pair).mint(DEAD);

        // The ecosystem reserve exists only for launches that made it — a
        // failed launch's tranche never leaves this contract (burn-on-failure).
        if (reserveOut > 0) {
            IERC20(token).safeTransfer(reserveRecipient, reserveOut);
        }

        emit Graduated(token, pair, ethToPool, tokensToPool, reserveOut, reserveRecipient);
        return true;
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function getLaunch(address token) external view returns (Launch memory) {
        Launch memory l = _launches[token];
        if (l.creator == address(0)) revert UnknownLaunch(token);
        return l;
    }

    function launchCount() external view returns (uint256) {
        return allLaunches.length;
    }

    /// @notice Slice of `allLaunches` — same pagination shape as the factory.
    function allLaunchesPaginated(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = allLaunches.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        page = new address[](end - start);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = allLaunches[start + i];
        }
    }

    /// @notice Quote a buy: net ETH applied, fee, and tokens out for `ethGross`.
    function previewBuy(address token, uint256 ethGross)
        external
        view
        returns (uint256 tokensOut, uint256 fee, bool wouldGraduate)
    {
        Launch storage l = _requireLive(token);
        fee = (ethGross * l.feeBps) / BPS;
        uint256 ethIn = ethGross - fee;
        uint256 x = uint256(l.virtualEth) + l.ethReserve;
        tokensOut = (l.tokenReserve * ethIn) / (x + ethIn);
        wouldGraduate = l.ethReserve + ethIn >= l.graduationEth;
    }

    /// @notice Quote a sell: net ETH out and fee for `tokensIn`.
    function previewSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 ethOut, uint256 fee)
    {
        Launch storage l = _requireLive(token);
        uint256 x = uint256(l.virtualEth) + l.ethReserve;
        uint256 grossOut = (x * tokensIn) / (l.tokenReserve + tokensIn);
        fee = (grossOut * l.feeBps) / BPS;
        ethOut = grossOut - fee;
    }

    // ─────────────────────────────── Admin ───────────────────────────────

    /// @notice Update economics for FUTURE launches. Live launches are frozen
    ///         at their creation snapshot, which is why this needs no
    ///         timelock: the setter cannot act retroactively on anyone.
    function setLaunchConfig(LaunchConfig calldata config_) external onlyOwner {
        _setLaunchConfig(config_);
    }

    function _setLaunchConfig(LaunchConfig memory config_) internal {
        // Absolute floors (mirrors the deploy script's CV-4, which only guards
        // the constructor). Without these an in-bounds config could still be
        // degenerate: 1-wei virtualEth => a first-buyer-takes-all curve, dust
        // graduationEth => an untradeable pool.
        if (config_.virtualEth < MIN_VIRTUAL_ETH) revert ConfigOutOfBounds();
        if (config_.graduationEth < MIN_GRADUATION_ETH) revert ConfigOutOfBounds();
        // Price continuity at graduation (see PRICE_CONTINUITY_BAND_BPS):
        // listing/curve ratio = T/(Vs+T) must sit within the band of 1.
        if (
            (uint256(config_.graduationEth) * BPS)
                / (uint256(config_.virtualEth) + uint256(config_.graduationEth))
                < BPS - PRICE_CONTINUITY_BAND_BPS
        ) revert ConfigOutOfBounds();
        if (config_.feeBps > MAX_FEE_BPS) revert ConfigOutOfBounds();
        // The three fee shares must sum to <= the whole fee: creator + treasury
        // <= BPS, so protocol's remainder (fee - creator - treasury) can never
        // underflow in _accrueFee. Each individually is therefore also <= BPS.
        if (uint256(config_.creatorFeeShareBps) + config_.treasuryFeeShareBps > BPS) {
            revert FeeSharesExceedFee();
        }
        if (config_.reserveBps > MAX_RESERVE_BPS) revert ConfigOutOfBounds();
        if (config_.reserveBps > 0 && config_.reserveRecipient == address(0)) {
            revert ReserveNeedsRecipient();
        }
        launchConfig = config_;
        emit LaunchConfigUpdated(config_);
    }

    /// @notice Guardian or owner can pause create/buy. Sells, claims, and the
    ///         graduation leg of an in-flight buy are never pausable.
    function pause() external {
        if (msg.sender != pauseGuardian && msg.sender != owner()) {
            revert NotGuardianOrOwner(msg.sender);
        }
        _pause();
    }

    /// @notice Unpause is owner-only — a compromised guardian can halt new
    ///         inflows but cannot re-open them.
    function unpause() external onlyOwner {
        _unpause();
    }

    function setPauseGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit PauseGuardianUpdated(pauseGuardian, newGuardian);
        pauseGuardian = newGuardian;
    }

    /// @notice Repoint the Jungle Bay treasury. Owner-only, never zero. Only
    ///         affects where FUTURE `sweepTreasuryFees` calls send — already-
    ///         accrued `treasuryFees` follow the new address on the next sweep,
    ///         which is the intended behavior for a treasury rotation.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ────────────────────────────── Internal ─────────────────────────────

    function _requireLive(address token) internal view returns (Launch storage l) {
        l = _launches[token];
        if (l.creator == address(0)) revert UnknownLaunch(token);
        if (l.graduated) revert AlreadyGraduated(token);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed(to);
    }
}
