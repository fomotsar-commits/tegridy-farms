// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {BeneficiaryData} from "./TegridyLiquidityMigrator.sol";

/// @dev The ERC721 surface of the V4 PositionManager that this contract uses.
interface IPositionNft {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title  TegridyFeeLocker — holds a graduated launch's LP position and pays its
///         advertised fee constitution
///
/// @notice Every launch publishes a fee split (creator / attention / protocol /
///         Doppler) on its Fact Sheet. Doppler honours that by locking the LP in
///         its `StreamableFeesLocker` and streaming fees to the beneficiaries.
///         That contract is BUSL-1.1, so we cannot use or fork it — and without
///         an equivalent, `TegridyLiquidityMigrator` has to REJECT any launch
///         that declares a split, because paying it would be impossible and
///         accepting it silently would make the published Fact Sheet false.
///
///         This is that equivalent, written independently against the MIT
///         `BeneficiaryData` shape and the MIT v4-periphery interfaces.
///
/// @dev    ## Pull, not push
///
///         Fees are COLLECTED permissionlessly into this contract and CREDITED to
///         beneficiaries; each then withdraws for itself. A push-on-collect design
///         would let one hostile or contract-less beneficiary revert the whole
///         distribution and block everyone else's fees indefinitely. This mirrors
///         the pull pattern already used in `RevenueDistributor` and
///         `MemeBountyBoard` for the same reason.
///
/// @dev    ## What this contract does NOT do
///
///         It does not price, swap, or rebalance. It holds one position per
///         launch, splits whatever that position earns, and hands the position to
///         a named recipient once its lock expires. Keeping it that narrow is
///         deliberate — it is fund-holding code entering an external audit.
contract TegridyFeeLocker is IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @dev Shares are WAD-denominated and must sum to exactly this.
    uint256 internal constant WAD = 1e18;

    // ─── Errors ───────────────────────────────────────────────────────
    error NotAuthorizedLocker();
    error AlreadyLocked();
    error UnknownPosition();
    error NoBeneficiaries();
    error SharesMustSumToWad(uint256 got);
    error ZeroShare();
    error ZeroAddress();
    error DuplicateOrUnsortedBeneficiary();
    error StillLocked(uint32 unlockDate);
    error NothingToClaim();

    // ─── Events ───────────────────────────────────────────────────────
    event PositionLocked(uint256 indexed tokenId, address indexed recipient, uint32 unlockDate);
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event Credited(address indexed beneficiary, Currency indexed currency, uint256 amount);
    event Claimed(address indexed beneficiary, Currency indexed currency, uint256 amount);
    event PositionReleased(uint256 indexed tokenId, address indexed to);

    // ─── Immutables ───────────────────────────────────────────────────

    IPositionManager public immutable positionManager;
    IPositionNft public immutable positionNft;

    /// @notice The only address permitted to register a locked position — the
    ///         migrator. Anyone else could otherwise register a junk position and
    ///         spam beneficiary state.
    address public immutable locker;

    struct Lock {
        PoolKey poolKey;
        address recipient; // receives the position once unlocked
        uint32 unlockDate; // 0 => permanent; the position is never releasable
        bool exists;
        BeneficiaryData[] beneficiaries;
    }

    mapping(uint256 tokenId => Lock) internal _locks;

    /// @notice Withdrawable balance per beneficiary per currency.
    mapping(address beneficiary => mapping(Currency currency => uint256 amount)) public claimable;

    /// @dev Native ETH arrives here when a position's currency0 is the zero address.
    receive() external payable {}

    modifier onlyLocker() {
        if (msg.sender != locker) revert NotAuthorizedLocker();
        _;
    }

    constructor(IPositionManager positionManager_, address locker_) {
        if (address(positionManager_) == address(0) || locker_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        positionNft = IPositionNft(address(positionManager_));
        locker = locker_;
    }

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts the position NFT the migrator mints directly to this contract.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── Registration ─────────────────────────────────────────────────

    /// @notice Record the fee constitution for a position this contract now holds.
    /// @dev    Called by the migrator in the same transaction that mints the
    ///         position here. Validation is strict and up front: a split that does
    ///         not sum to WAD, or contains a zero share or a duplicate, would
    ///         silently mispay for the life of the launch.
    function lockPosition(
        uint256 tokenId,
        PoolKey calldata poolKey,
        address recipient,
        uint32 unlockDate,
        BeneficiaryData[] calldata beneficiaries
    ) external onlyLocker {
        if (_locks[tokenId].exists) revert AlreadyLocked();
        if (recipient == address(0)) revert ZeroAddress();
        if (beneficiaries.length == 0) revert NoBeneficiaries();

        uint256 total;
        address previous;
        for (uint256 i; i < beneficiaries.length; ++i) {
            BeneficiaryData calldata b = beneficiaries[i];
            if (b.beneficiary == address(0)) revert ZeroAddress();
            if (b.shares == 0) revert ZeroShare();
            // Ascending order with no repeats. Sorting is how the SDK emits them,
            // and requiring it here turns duplicate detection into a single
            // comparison instead of a quadratic scan — a duplicate would otherwise
            // silently double that beneficiary's take.
            if (b.beneficiary <= previous) revert DuplicateOrUnsortedBeneficiary();
            previous = b.beneficiary;
            total += b.shares;
        }
        if (total != WAD) revert SharesMustSumToWad(total);

        Lock storage l = _locks[tokenId];
        l.poolKey = poolKey;
        l.recipient = recipient;
        l.unlockDate = unlockDate;
        l.exists = true;
        for (uint256 i; i < beneficiaries.length; ++i) {
            l.beneficiaries.push(beneficiaries[i]);
        }

        emit PositionLocked(tokenId, recipient, unlockDate);
    }

    // ─── Fee collection ───────────────────────────────────────────────

    /// @notice Collect this position's accrued fees and credit the beneficiaries.
    /// @dev    Permissionless on purpose: it takes no parameters a caller can
    ///         choose beyond the position, moves nothing to the caller, and the
    ///         split is fixed at lock time. Anyone willing to pay the gas may
    ///         trigger a distribution, which is strictly better than depending on
    ///         a keeper.
    ///
    ///         A V4 fee collect is a DECREASE_LIQUIDITY of ZERO liquidity followed
    ///         by TAKE_PAIR — removing no principal and sweeping only what the
    ///         position has earned. Note the position's PRINCIPAL is never
    ///         touched by this function; only fees can leave.
    function collect(uint256 tokenId) external {
        Lock storage l = _locks[tokenId];
        if (!l.exists) revert UnknownPosition();

        Currency c0 = l.poolKey.currency0;
        Currency c1 = l.poolKey.currency1;

        uint256 before0 = _balanceOf(c0);
        uint256 before1 = _balanceOf(c1);

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        // liquidity 0 => collect fees only. amountMin 0 on both legs is correct
        // here rather than lax: we are not withdrawing principal, so there is no
        // slippage to bound — the only outputs are already-earned fees.
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(c0, c1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 amount0 = _balanceOf(c0) - before0;
        uint256 amount1 = _balanceOf(c1) - before1;

        _credit(l, c0, amount0);
        _credit(l, c1, amount1);

        emit FeesCollected(tokenId, amount0, amount1);
    }

    /// @dev Split `amount` across the lock's beneficiaries by share.
    ///
    ///      The final beneficiary receives the REMAINDER rather than its computed
    ///      share, so integer truncation can never strand dust in this contract
    ///      nor over-distribute. Without that, repeated collects would accumulate
    ///      an unclaimable residue forever.
    function _credit(Lock storage l, Currency currency, uint256 amount) internal {
        if (amount == 0) return;

        uint256 n = l.beneficiaries.length;
        uint256 distributed;
        for (uint256 i; i < n; ++i) {
            BeneficiaryData storage b = l.beneficiaries[i];
            uint256 share;
            if (i == n - 1) {
                share = amount - distributed;
            } else {
                share = (amount * uint256(b.shares)) / WAD;
                distributed += share;
            }
            if (share > 0) {
                claimable[b.beneficiary][currency] += share;
                emit Credited(b.beneficiary, currency, share);
            }
        }
    }

    // ─── Claiming ─────────────────────────────────────────────────────

    /// @notice Withdraw everything owed to the caller in `currency`.
    /// @dev    Caller-scoped by construction: a claimant can only ever move its
    ///         own balance, so this needs no access control.
    function claim(Currency currency) external {
        uint256 amount = claimable[msg.sender][currency];
        if (amount == 0) revert NothingToClaim();

        // Zero BEFORE transferring — this is the reentrancy-sensitive line in the
        // contract, since a native-ETH claimant receives control in `.call`.
        claimable[msg.sender][currency] = 0;

        if (Currency.unwrap(currency) == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(Currency.unwrap(currency)).safeTransfer(msg.sender, amount);
        }

        emit Claimed(msg.sender, currency, amount);
    }

    // ─── Release ──────────────────────────────────────────────────────

    /// @notice Hand the position to its recipient once the lock has expired.
    /// @dev    `unlockDate == 0` means PERMANENT: there is no code path that ever
    ///         releases such a position, which is what a "LP locked forever" claim
    ///         on a Fact Sheet has to mean to be true.
    ///
    ///         Fees already credited remain claimable afterwards — releasing the
    ///         position must not confiscate what beneficiaries have already earned.
    function release(uint256 tokenId) external {
        Lock storage l = _locks[tokenId];
        if (!l.exists) revert UnknownPosition();
        if (l.unlockDate == 0 || block.timestamp < l.unlockDate) revert StillLocked(l.unlockDate);

        address to = l.recipient;
        positionNft.safeTransferFrom(address(this), to, tokenId);
        emit PositionReleased(tokenId, to);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getLock(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, address recipient, uint32 unlockDate, BeneficiaryData[] memory beneficiaries)
    {
        Lock storage l = _locks[tokenId];
        if (!l.exists) revert UnknownPosition();
        return (l.poolKey, l.recipient, l.unlockDate, l.beneficiaries);
    }

    function _balanceOf(Currency currency) internal view returns (uint256) {
        return Currency.unwrap(currency) == address(0)
            ? address(this).balance
            : IERC20(Currency.unwrap(currency)).balanceOf(address(this));
    }
}
