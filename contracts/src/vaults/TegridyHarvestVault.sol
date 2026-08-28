// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "../base/TimelockAdmin.sol";

/// @dev Subset of TegridyLPFarming. `rawBalanceOf` and not `effectiveBalanceOf` is the
///      recoverable principal: the effective balance is a boost-weighted reward number and
///      withdrawing against it would over-state what the farm will actually return.
interface IHarvestFarm {
    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function getReward() external;
    function emergencyWithdraw() external;
    function rawBalanceOf(address account) external view returns (uint256);
    function earned(address account) external view returns (uint256);
    function paused() external view returns (bool);
    function MIN_STAKE() external view returns (uint256);
    function stakingToken() external view returns (address);
    function rewardToken() external view returns (address);
}

interface IHarvestRouter {
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IHarvestPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title TegridyHarvestVault — ERC-4626 auto-compounder over TegridyLPFarming
/// @notice Depositors supply the TOWELI/WETH LP token and receive vault shares. The vault
///         stakes that LP into the already-deployed `TegridyLPFarming`, and a keeper
///         periodically calls `harvest()` to claim TOWELI rewards, convert them back into
///         the same LP, and re-stake — so each share is redeemable for a growing amount of
///         LP without the depositor transacting.
///
/// ─── SHARE-PRICE MANIPULATION SURFACE (read this before integrating) ────────────────
/// Every ERC-4626 vault exposes the "donation" / "inflation" attack: `totalAssets()` is a
/// balance the attacker can raise without minting shares, so a first depositor can be made
/// to round down to zero shares while the attacker's single wei-share captures the deposit.
/// The mitigation here is the one used by the battle-tested implementations rather than a
/// bespoke scheme — OpenZeppelin's virtual shares/assets, via `_decimalsOffset() == 6`.
/// The offset makes the attacker's required donation ~10^6× the value they can extract, so
/// the attack is unprofitable at every deposit size instead of merely inconvenient.
/// It does not make donation *impossible*: an unsolicited transfer of LP to this contract
/// is still a gift to existing shareholders, which is the intended and harmless outcome.
///
/// The second manipulation surface is the harvest swap, and it is why `harvest()` is not
/// permissionless — see `onlyKeeper` below.
///
/// ─── veTOWELI BOOST: WHAT DEPOSITORS DO AND DO NOT GET ──────────────────────────────
/// TegridyLPFarming multiplies a staker's effective balance by
/// `TegridyStaking.aggregateActiveBoostBps(staker)`, floored at 1.0×. The staker here is
/// THIS CONTRACT, not the depositor. This vault holds no TegridyStaking position NFT and
/// is not an ERC-721 receiver, so `aggregateActiveBoostBps(vault)` returns 0 and the farm
/// floors the vault to `BASE_BOOST_BPS` — 1.0×, the base rate.
///
/// Therefore: depositors DO NOT inherit their own veTOWELI boost through this vault, and
/// boosts do not pool. A depositor who holds a boosted TegridyStaking position earns
/// strictly more TOWELI by staking their LP into TegridyLPFarming directly (up to 4.5× the
/// vault's rate) and forgoing auto-compounding. This vault is for un-boosted LP only; the
/// compounding frequency is the entire edge it offers. Any interface that presents this
/// vault as boosted, or that shows a boosted APY next to it, is misreporting.
///
/// ─── PRINCIPAL SAFETY ───────────────────────────────────────────────────────────────
/// The owner has no path that moves the LP asset anywhere except back to this contract:
/// there is no token-recovery function, no withdraw-to-owner, and no fee taken in the
/// asset. The performance fee is charged in the REWARD token, from rewards the farm has
/// already paid out, at harvest only. A vault holding zero rewards yields a zero fee.
///
/// @dev Base: OpenZeppelin Contracts v5.6.1 `ERC4626` (imported from the pinned submodule,
///      not copied). The compounding, the farm integration and the fee are the delta; the
///      accounting core (convertToShares/Assets, rounding direction, virtual offset) is
///      untouched OpenZeppelin.
contract TegridyHarvestVault is ERC4626, OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the performance fee. Immutable by construction (a `constant`
    ///         in bytecode of a non-upgradeable contract), so the fee this vault can ever
    ///         charge is bounded at deploy time and not by owner discretion. 1000 bps
    ///         leaves headroom above the 9.5% total skim the plan models for this lane.
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 1000;

    bytes32 public constant PERFORMANCE_FEE_CHANGE = keccak256("HARVEST_VAULT_PERFORMANCE_FEE");
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("HARVEST_VAULT_FEE_RECIPIENT");
    uint256 public constant PERFORMANCE_FEE_TIMELOCK = 48 hours;
    uint256 public constant FEE_RECIPIENT_TIMELOCK = 48 hours;

    // ─── Immutables ─────────────────────────────────────────────────
    IHarvestFarm public immutable farm;
    IHarvestRouter public immutable router;
    /// @notice TOWELI — what the farm pays out and what harvest converts.
    IERC20 public immutable rewardToken;
    /// @notice The LP's other leg. Half the harvest is swapped into it to re-add liquidity.
    IERC20 public immutable pairedToken;
    /// @notice `TegridyLPFarming.MIN_STAKE` snapshotted at deploy. The farm rejects any
    ///         `stake()` below this floor, so deposits smaller than it are held idle in
    ///         this contract until the idle buffer clears the floor. Idle LP is counted in
    ///         `totalAssets` and is withdrawable, so buffering costs yield, never principal.
    uint256 public immutable farmMinStake;

    // ─── Fee state ──────────────────────────────────────────────────
    /// @notice Ships at zero. Both this AND `feeRecipient` must be set for any fee to be
    ///         charged, and each move costs a separate 48h timelock.
    uint256 public performanceFeeBps;
    /// @notice Ships unwired (address(0)) — the zero-address gate. While it is zero the
    ///         fee branch is dead code regardless of `performanceFeeBps`.
    address public feeRecipient;

    uint256 public pendingPerformanceFeeBps;
    address public pendingFeeRecipient;

    /// @notice Addresses permitted to call `harvest`. The owner is always permitted.
    mapping(address => bool) public isKeeper;

    // ─── Lifetime accounting (observability only — never an input to share price) ────
    uint256 public totalHarvested;
    uint256 public totalFeesCharged;
    uint256 public lastHarvestTimestamp;

    // ─── Events ─────────────────────────────────────────────────────
    event Harvested(
        address indexed caller,
        uint256 rewardsConverted,
        uint256 performanceFee,
        uint256 lpCompounded,
        uint256 totalAssetsAfter
    );
    event IdleDeployed(uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event PerformanceFeeProposed(uint256 newFeeBps, uint256 executeAfter);
    event PerformanceFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientProposed(address newRecipient, uint256 executeAfter);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event Panicked(uint256 lpRecovered, uint256 rewardsForfeited);

    // ─── Errors ─────────────────────────────────────────────────────
    error ZeroAddress();
    error NotKeeper();
    error FeeAboveCap();
    error AssetFarmMismatch();
    error RewardTokenMismatch();
    error PairLegMismatch();
    error InsufficientLiquidityUnwound();
    error SlippageTooHigh();
    error NothingToCompound();
    error NothingStaked();
    error ZeroMinLpOut();

    modifier onlyKeeper() {
        if (msg.sender != owner() && !isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    /// @param _asset       The TOWELI/WETH LP token (a TegridyPair).
    /// @param _farm        Live TegridyLPFarming whose `stakingToken` is `_asset`.
    /// @param _router      TegridyRouter used for the harvest swap and the re-add.
    /// @param _owner       Initial owner; rotate to the Safe via the 2-step flow.
    /// @dev The three cross-checks below make a misconfigured deploy revert at construction
    ///      rather than silently stranding funds in a farm that pays a token this vault
    ///      cannot convert, or against an LP whose legs it cannot re-mint.
    constructor(
        address _asset,
        address _farm,
        address _router,
        address _owner,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) ERC4626(IERC20(_asset)) OwnableNoRenounce(_owner) {
        if (_asset == address(0) || _farm == address(0) || _router == address(0)) revert ZeroAddress();

        farm = IHarvestFarm(_farm);
        router = IHarvestRouter(_router);

        if (farm.stakingToken() != _asset) revert AssetFarmMismatch();

        address reward = farm.rewardToken();
        rewardToken = IERC20(reward);

        address weth = router.WETH();
        address t0 = IHarvestPair(_asset).token0();
        address t1 = IHarvestPair(_asset).token1();

        // The harvest route is reward → paired → re-mint LP. It only closes if the LP's two
        // legs are exactly {rewardToken, WETH}; anything else needs a multi-hop route this
        // contract deliberately does not carry.
        if (t0 == reward && t1 == weth) {
            pairedToken = IERC20(weth);
        } else if (t1 == reward && t0 == weth) {
            pairedToken = IERC20(weth);
        } else {
            revert PairLegMismatch();
        }

        // The farm forbids rewardToken == stakingToken; re-assert it here because this
        // vault's `totalAssets` would otherwise conflate principal with unconverted yield.
        if (reward == _asset) revert RewardTokenMismatch();

        farmMinStake = farm.MIN_STAKE();
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  ERC-4626 ACCOUNTING                                        ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice LP held idle here plus LP staked in the farm.
    /// @dev Pending farm rewards are DELIBERATELY excluded. Valuing unclaimed TOWELI would
    ///      make the share price a function of an oracle price for a token this vault has
    ///      not yet sold, which is both a manipulation surface and a claim the vault cannot
    ///      substantiate. Rewards enter the share price only once `harvest()` has actually
    ///      converted them to LP. Consequence: share price steps up at harvest rather than
    ///      accruing continuously, and a depositor who exits immediately before a harvest
    ///      forfeits their share of the pending rewards to the remaining holders.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + farm.rawBalanceOf(address(this));
    }

    /// @dev The virtual-offset mitigation for the inflation attack. See the contract-level
    ///      natspec. Six decimals of offset is OpenZeppelin's documented setting for making
    ///      the donation attack unprofitable rather than merely expensive.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Pausing closes deposits only. It must never close withdrawals — a paused vault
    ///      that traps principal converts an operational incident into a loss.
    function maxDeposit(address) public view override returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        _deployIdle();
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _unwind(assets);
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  FARM POSITION                                              ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Push idle LP into the farm. Permissionless: it can only move the asset from
    ///         this contract into the farm position this contract owns, so there is nothing
    ///         to extract by calling it, and leaving it callable means idle LP stranded by a
    ///         paused farm starts earning again without an owner transaction.
    function deployIdle() external nonReentrant {
        _deployIdle();
    }

    function _deployIdle() internal {
        // A paused vault has been taken off risk deliberately — most likely by `panic()`,
        // which exists precisely to get out of the farm. Nothing may push it back in until
        // the owner unpauses.
        if (paused()) return;
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        // Below the farm's own floor the stake() call would revert and take the deposit
        // with it; holding the dust is the correct behaviour, not an error.
        if (idle < farmMinStake) return;
        // A paused farm must not brick deposits. The LP simply waits, withdrawable.
        if (farm.paused()) return;
        IERC20(asset()).forceApprove(address(farm), idle);
        farm.stake(idle);
        emit IdleDeployed(idle);
    }

    /// @dev Free `assets` of LP for an outgoing transfer, pulling from the farm only for the
    ///      shortfall. Reverting here rather than under-delivering is deliberate: a partial
    ///      transfer would silently hand the withdrawer fewer assets than their burnt shares
    ///      entitled them to.
    function _unwind(uint256 assets) internal {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle >= assets) return;
        uint256 shortfall = assets - idle;
        if (shortfall > farm.rawBalanceOf(address(this))) revert InsufficientLiquidityUnwound();
        farm.withdraw(shortfall);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  HARVEST                                                    ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Claim farm rewards, convert them to LP, and re-stake.
    /// @param minPairedOut Minimum `pairedToken` the reward→paired swap must return.
    /// @param minLpOut     Minimum LP the re-add must mint. Must be nonzero: it is the only
    ///                     price bound on the re-add, and a bound the caller can zero out is
    ///                     not a bound.
    /// @return lpCompounded LP minted and re-staked by this call.
    ///
    /// @dev NOT permissionless, and the reason is the swap. The reward leg and the LP share
    ///      the same pool, so a caller who supplies `minPairedOut = 0` can sandwich the
    ///      vault's own swap and keep the difference. Slippage bounds supplied by an
    ///      untrusted caller are not bounds. Restricting the trigger to an allow-list is the
    ///      mitigation the battle-tested vaults use (Yearn V3 gates `report()` the same way)
    ///      and it costs nothing in decentralisation that a TWAP floor would not cost in new
    ///      core math on a money path.
    ///
    ///      Keeper membership is NOT timelocked, and that is a bounded decision: a rogue
    ///      keeper's entire blast radius is the yield of a single harvest. This function
    ///      moves reward tokens and mints LP; there is no branch that withdraws principal
    ///      from the farm or transfers the asset out of this contract.
    function harvest(uint256 minPairedOut, uint256 minLpOut)
        external
        nonReentrant
        onlyKeeper
        returns (uint256 lpCompounded)
    {
        // Both operands of the NothingToCompound check below are raw balances anyone can
        // raise by donation, so `minLpOut` is the one bound on the addLiquidity ratio that
        // an outsider cannot skew. Reject zero here so an allow-listed keeper cannot
        // disable it and expose the re-add to unbounded ratio-skew loss.
        if (minLpOut == 0) revert ZeroMinLpOut();

        farm.getReward();

        // Every reward-token unit held here is yield: the vault's principal is the LP, and
        // no deposit path ever leaves reward tokens in this contract. Dust left by a prior
        // harvest's rounding is therefore also yield and is swept in with this one.
        uint256 rewards = rewardToken.balanceOf(address(this));
        if (rewards == 0) return 0;

        // AUDIT FIX 2026-08-25 (dust-donation harvest grief): gate on the swap's
        // OUTPUT quote, computed BEFORE any fee is charged — not on a raw
        // reward-wei threshold. The swap leg is half the post-fee rewards; if it
        // quotes to zero output the swap reverts (INSUFFICIENT_OUTPUT) or leaves
        // pairedSide == 0 and hits NothingToCompound below — either one rolls back
        // getReward(), so a reward-token donation of 1..~(reserveIn/reserveOut) wei
        // could block every keeper harvest while farm rewards are near zero, at
        // economically zero cost. A fixed `rewards < k` cannot close it: the yield
        // depends on pool price, not wei count (a 2-wei donation into a 1000:1 pool
        // still quotes to 0 out and reverts). No-op'ing leaves the wei as the
        // sweepable dust described above and self-heals once real rewards accrue;
        // charging the fee only past the gate keeps a no-op from ever charging a fee
        // against nothing compounded.
        address[] memory path = new address[](2);
        path[0] = address(rewardToken);
        path[1] = address(pairedToken);
        uint256 swapAmount = (rewards - _performanceFee(rewards)) / 2;
        if (swapAmount == 0 || router.getAmountsOut(swapAmount, path)[1] == 0) return 0;

        // Past the gate: the swap and re-add cannot dust-revert, so the fee is safe to take.
        uint256 fee = _chargePerformanceFee(rewards);
        uint256 toConvert = rewards - fee;
        swapAmount = toConvert / 2; // == the gated value (same pure fee formula)

        rewardToken.forceApprove(address(router), swapAmount);
        // The router's deadline window is a mempool-staleness guard, not a price guard.
        // Price protection on this call is `minPairedOut` and nothing else.
        router.swapExactTokensForTokens(swapAmount, minPairedOut, path, address(this), block.timestamp);

        uint256 rewardSide = rewardToken.balanceOf(address(this));
        uint256 pairedSide = pairedToken.balanceOf(address(this));
        // Reached only on a reward balance too small to split into a swap leg and a
        // liquidity leg. Reverting rather than returning rolls back the fee transfer above,
        // so a dust harvest can never charge a fee against nothing compounded.
        if (rewardSide == 0 || pairedSide == 0) revert NothingToCompound();

        rewardToken.forceApprove(address(router), rewardSide);
        pairedToken.forceApprove(address(router), pairedSide);
        // Per-leg minimums are left at zero and the bound is taken on the LP minted instead:
        // addLiquidity returns the unused remainder of whichever leg was over-supplied, so a
        // leg minimum here would reject harmless ratio drift while `minLpOut` bounds the
        // thing that actually determines what depositors receive.
        (,, lpCompounded) = router.addLiquidity(
            address(rewardToken),
            address(pairedToken),
            rewardSide,
            pairedSide,
            0,
            0,
            address(this),
            block.timestamp
        );
        if (lpCompounded < minLpOut) revert SlippageTooHigh();

        // Approvals are zeroed rather than left dangling: the router is trusted for the call
        // it was just given, not standing.
        rewardToken.forceApprove(address(router), 0);
        pairedToken.forceApprove(address(router), 0);

        totalHarvested += rewards;
        lastHarvestTimestamp = block.timestamp;

        _deployIdle();

        emit Harvested(msg.sender, rewards, fee, lpCompounded, totalAssets());
    }

    /// @dev Both gates must be open for a fee to exist. Returns the amount actually sent.
    /// @dev Pure calculation of the performance fee on `rewards` — no transfer.
    ///      Kept as the single formula so the pre-charge swap-output gate in
    ///      `harvest` reasons about exactly the fee `_chargePerformanceFee` will take.
    function _performanceFee(uint256 rewards) internal view returns (uint256) {
        address recipient = feeRecipient;
        uint256 bps = performanceFeeBps;
        if (recipient == address(0) || bps == 0) return 0;
        return (rewards * bps) / BPS_DENOMINATOR;
    }

    function _chargePerformanceFee(uint256 rewards) internal returns (uint256 fee) {
        fee = _performanceFee(rewards);
        if (fee == 0) return 0;
        totalFeesCharged += fee;
        rewardToken.safeTransfer(feeRecipient, fee);
    }

    /// @notice Rewards claimable by this vault at the farm, before fee and conversion.
    /// @dev Reported in reward-token units and NOT converted to an asset value. A caller
    ///      that needs the LP-denominated figure has to price it themselves; this contract
    ///      will not quote a price it has not realised.
    function pendingRewards() external view returns (uint256) {
        return farm.earned(address(this));
    }

    /// @notice LP currently staked in the farm, as distinct from idle LP held here.
    function stakedAssets() external view returns (uint256) {
        return farm.rawBalanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  KEEPERS                                                    ║
    // ═══════════════════════════════════════════════════════════════

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED FEE ADMIN                                       ║
    // ═══════════════════════════════════════════════════════════════

    function proposePerformanceFee(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PERFORMANCE_FEE_BPS) revert FeeAboveCap();
        pendingPerformanceFeeBps = newFeeBps;
        _propose(PERFORMANCE_FEE_CHANGE, PERFORMANCE_FEE_TIMELOCK);
        emit PerformanceFeeProposed(newFeeBps, block.timestamp + PERFORMANCE_FEE_TIMELOCK);
    }

    function executePerformanceFee() external onlyOwner {
        _execute(PERFORMANCE_FEE_CHANGE);
        uint256 old = performanceFeeBps;
        uint256 next = pendingPerformanceFeeBps;
        // Re-checked at execution: the cap must hold against the value being written, not
        // only against the value proposed, so a constant change under a future refactor
        // cannot let a stale proposal through above the ceiling.
        if (next > MAX_PERFORMANCE_FEE_BPS) revert FeeAboveCap();
        performanceFeeBps = next;
        pendingPerformanceFeeBps = 0;
        emit PerformanceFeeUpdated(old, next);
    }

    function cancelPerformanceFeeProposal() external onlyOwner {
        _cancel(PERFORMANCE_FEE_CHANGE);
        pendingPerformanceFeeBps = 0;
    }

    function proposeFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingFeeRecipient = newRecipient;
        _propose(FEE_RECIPIENT_CHANGE, FEE_RECIPIENT_TIMELOCK);
        emit FeeRecipientProposed(newRecipient, block.timestamp + FEE_RECIPIENT_TIMELOCK);
    }

    function executeFeeRecipient() external onlyOwner {
        _execute(FEE_RECIPIENT_CHANGE);
        address old = feeRecipient;
        feeRecipient = pendingFeeRecipient;
        pendingFeeRecipient = address(0);
        emit FeeRecipientUpdated(old, feeRecipient);
    }

    function cancelFeeRecipientProposal() external onlyOwner {
        _cancel(FEE_RECIPIENT_CHANGE);
        pendingFeeRecipient = address(0);
    }

    /// @notice Hand the incoming owner a clean timelock queue. Mirrors TegridyLPFarming.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_proposalReadyAt(PERFORMANCE_FEE_CHANGE) != 0) {
            _cancel(PERFORMANCE_FEE_CHANGE);
            pendingPerformanceFeeBps = 0;
        }
        if (_proposalReadyAt(FEE_RECIPIENT_CHANGE) != 0) {
            _cancel(FEE_RECIPIENT_CHANGE);
            pendingFeeRecipient = address(0);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  EMERGENCY                                                  ║
    // ═══════════════════════════════════════════════════════════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pull the whole farm position back to this contract and stop new deposits.
    /// @dev The escape hatch exists because the farm's ordinary `withdraw` runs
    ///      `updateReward`, which calls out to TegridyStaking for the boost figure. If that
    ///      call ever reverts, ordinary withdrawal reverts with it and depositor principal is
    ///      trapped in the farm. `emergencyWithdraw` on the farm makes no external call
    ///      beyond the LP transfer, which is exactly why it is the right hatch — at the cost
    ///      of forfeiting the pending rewards, which is why it is not the ordinary path.
    ///      The LP lands here, still owned by depositors, still withdrawable share-for-share.
    function panic() external onlyOwner nonReentrant {
        uint256 staked = farm.rawBalanceOf(address(this));
        if (staked == 0) revert NothingStaked();
        uint256 forfeited = farm.earned(address(this));
        farm.emergencyWithdraw();
        if (!paused()) _pause();
        emit Panicked(staked, forfeited);
    }
}
