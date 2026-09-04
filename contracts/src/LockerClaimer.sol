// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice The single call we need from Doppler's `StreamableFeesLocker`.
/// @dev    VERIFIED against the DEPLOYED mainnet locker 0xe24FC2F7191e850e2D4514aBb4d39305b1871eC6
///         (2026-07-30, `eth_getCode` + selector scan): `releaseFees(uint256)` = 0x4a719bd4 is
///         PRESENT, alongside `positions(uint256)`, `beneficiariesClaims(address,address)`,
///         `distributeFees(uint256)`, `approveMigrator/revokeMigrator` and `positionManager()`.
///         That selector set identifies it as the V1 (`legacy/src/lockers/StreamableFeesLocker.sol`)
///         shape — NOT the V2 `streams(bytes32)` shape. Do NOT widen this interface: every extra
///         selector is a way for a future edit to call the locker in a way this contract was never
///         audited for.
interface IStreamableFeesLocker {
    /// @notice Pays the CALLER whatever `beneficiariesClaims[msg.sender][currency]` holds for
    ///         `tokenId`'s pool, for both pool currencies, and zeroes those claims.
    ///         Reverts `PositionNotFound()` for an unknown tokenId and `InvalidBeneficiary()`
    ///         when `msg.sender` is not in `positions[tokenId].beneficiaries`.
    function releaseFees(uint256 tokenId) external;
}

/// @title LockerClaimer
/// @notice A no-owner, no-upgrade, no-state pass-through whose ONLY job is to be nameable as a
///         `StreamableFeesLocker` beneficiary for the protocol's fee line, and to push what it
///         claims onward to a destination fixed at construction.
///
/// ## Why this contract has to exist
///
/// The locker is PULL-based and SELF-ADDRESSED. `distributeFees` merely CREDITS
/// `beneficiariesClaims[beneficiary][currency]`; the money only moves when the beneficiary
/// ITSELF calls `releaseFees(tokenId)`, and it is paid to `msg.sender` only. A beneficiary that
/// cannot originate a transaction to the locker therefore accrues credit that no transaction
/// can ever collect.
///
/// `RevenueDistributor` (0xF993316E2fC079de4358c489A935E01e03E23E17) cannot originate that call:
/// its deployed ABI has 35 non-view functions and not one is an arbitrary call / multicall /
/// exec(target,data). Naming it directly as a locker beneficiary would strand 100% of the
/// protocol fee line, permanently and silently. That is why `launchService.protocolFeeSink()`
/// currently points the 15% at the Treasury Safe — which CAN originate the claim, at the cost
/// of the fee no longer being "real yield to veTOWELI stakers".
///
/// This contract closes that gap: it is an address that (a) can be named as a beneficiary and
/// (b) CAN originate `releaseFees`, and it forwards the proceeds to `revenueDistributor` where
/// stakers actually earn them.
///
/// ## Trust properties
///
/// - Both destinations are `immutable`. There is no owner, no setter, no timelock, no proxy and
///   no `selfdestruct`. A re-pointable fee sink is a rug vector; this one cannot be re-pointed,
///   so "check the constructor args once" is the whole audit of where the money goes.
/// - `claim` / `forwardETH` / `sweepToken` are permissionless. There is nothing to gate: every
///   path moves the entire balance to one address that was fixed at deployment.
/// - The contract is designed to hold a zero balance between transactions. Anything it does hold
///   is claimable to its fixed destination by anyone, so nothing can be stranded here.
///
/// ## The `receive()` trap — DO NOT put logic in it
///
/// The locker pays out through Uniswap v4's `CurrencyLibrary.transfer`, whose native branch is
/// `call(gas(), to, amount, 0, 0, 0, 0)` and which REVERTS the whole `releaseFees` if that call
/// fails. Two consequences:
///
///  1. There is no 2,300-gas stipend to fit — an opcode walk of the deployed locker's 7,198-byte
///     runtime (2026-07-30) finds 4 CALL sites, all 4 immediately preceded by GAS, and ZERO
///     occurrences of the 2300 stipend constant (PUSH2 0x08fc). All available gas is forwarded.
///  2. Precisely BECAUSE the failure is not swallowed, any revert inside our `receive()` bricks
///     the fee line for that position until someone calls the locker's `updateBeneficiary` to
///     re-point the slot — and THIS contract has no way to call it (see ADOPTION below), so from
///     here it is unrecoverable. A bare `receive()` cannot revert (no SSTORE that can hit a gas ceiling, no
///     guard that can trip, no external call that can fail), which is the only shape that is
///     safe under BOTH today's full-gas CALL and a hypothetical future `transfer`/`send` sender.
///
/// This is also why `receive()` is deliberately NOT `nonReentrant`: `claim` holds the guard while
/// `releaseFees` executes, so a guarded `receive()` would revert on the locker's own payout and
/// brick every claim.
///
/// ## Why the ERC20 leg goes to the Treasury, not to RevenueDistributor
///
/// A locker position always has TWO currencies. For our ETH-numeraire launches that is
/// (currency0 = native ETH, currency1 = the launched token); for an exotic TOWELI-numeraire
/// launch BOTH legs are ERC20. `RevenueDistributor` distributes `address(this).balance` — it is
/// ETH-only, and an ERC20 pushed into it is invisible to the distribution loop, so it would be
/// dead weight rather than staker yield. The honest destination for a non-ETH fee leg is the
/// Treasury Safe, which is exactly where `protocolFeeSink()` routes exotic-pair fees today and
/// which can convert it before any of it is presented as yield.
///
/// Battle-tested sources:
///  - ReentrancyGuard: OpenZeppelin (unmodified).
///  - SafeTransferLib: Solady (unmodified) — used by TegridyStaking / TegridyRestaking here.
///
/// @dev ADOPTION (operator): this contract intentionally does NOT wire itself in. To adopt it:
///      (1) deploy with (locker, RevenueDistributor, Treasury Safe), (2) verify on Etherscan and
///      read back `locker()` / `revenueDistributor()` / `treasury()` on-chain, (3) only THEN flip
///      `launchService.protocolFeeSink()` to the deployed address + label.
///
///      The flip governs FUTURE launches: the beneficiary SET (who is in it, and each share) is
///      fixed at launch-create time and no admin can rewrite it.
///
///      But an already-created launch is NOT stranded on its original sink. The deployed locker
///      exposes `updateBeneficiary(uint256 tokenId, address newBeneficiary)` — verified present in
///      the live runtime, selector 0x3e8eb5a4 — which lets the CURRENT beneficiary of a slot
///      re-point that slot to a new address (it releases what is owed to the caller first, then
///      rewrites the entry). So Treasury, as an existing beneficiary, can migrate its own slot to
///      a deployed LockerClaimer later. That is a Safe transaction per position, not a redeploy.
///
///      This contract deliberately CANNOT call `updateBeneficiary`: it holds no such function, so
///      once it is a beneficiary its slot is one-way. That is intentional — a fee sink that can
///      re-point itself is a rug vector, and the whole point here is that the destination is not
///      a parameter. The migration lever stays with the Safe, which is a human-authorised path.
contract LockerClaimer is ReentrancyGuard {
    using SafeTransferLib for address;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The Doppler StreamableFeesLocker this claimer pulls from.
    IStreamableFeesLocker public immutable locker;

    /// @notice Where every wei of claimed native ETH goes. ETH-only by design.
    address public immutable revenueDistributor;

    /// @notice Where every claimed ERC20 fee leg goes (RevenueDistributor cannot use tokens).
    address public immutable treasury;

    // ─── Events ───────────────────────────────────────────────────────

    /// @notice Emitted when ETH is pushed to `revenueDistributor`. Reconcile off-chain against
    ///         the locker's own `Release(tokenId, beneficiary, amount0, amount1)`.
    event FeesForwarded(address indexed caller, uint256 amount);

    /// @notice Emitted when an ERC20 fee leg is pushed to `treasury`.
    event TokenSwept(address indexed token, address indexed caller, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error ForwardFailed();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _locker, address _revenueDistributor, address _treasury) {
        if (_locker == address(0) || _revenueDistributor == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        locker = IStreamableFeesLocker(_locker);
        revenueDistributor = _revenueDistributor;
        treasury = _treasury;
    }

    // ─── Receive ETH ──────────────────────────────────────────────────

    /// @notice Accept native ETH. MUST stay empty — see the `receive()` trap note on the
    ///         contract: this body runs inside the locker's `releaseFees`, and any revert here
    ///         (gas ceiling, reentrancy guard, failed call) reverts the payout and bricks the
    ///         fee line for a position whose beneficiary set can never be changed.
    receive() external payable {}

    // ─── Claim ────────────────────────────────────────────────────────

    /// @notice Pull this contract's accrued fees for `tokenId` out of the locker and push the
    ///         resulting ETH to `revenueDistributor`. Permissionless — the money has exactly one
    ///         destination, so there is nothing a caller can redirect.
    /// @dev    Reverts (bubbled from the locker) when `tokenId` is unknown or when this contract
    ///         is not one of that position's beneficiaries. That is the correct loud failure: a
    ///         swallowed revert would let a keeper believe it had collected.
    ///         The ERC20 leg of the position is NOT moved here — call {sweepToken} for it.
    /// @param  tokenId The locker position (Uniswap v4 position-manager tokenId) to release.
    function claim(uint256 tokenId) external nonReentrant {
        locker.releaseFees(tokenId);
        _forwardETH();
    }

    /// @notice Push any native ETH sitting here to `revenueDistributor`. Permissionless.
    /// @dev    Exists so ETH that arrived WITHOUT a claim — a `selfdestruct` push, a block
    ///         reward, a stray transfer — is never stranded in a contract with no owner and no
    ///         rescue function. {claim} already flushes the full balance; this is the path for
    ///         when there is nothing claimable to attach it to.
    function forwardETH() external nonReentrant {
        _forwardETH();
    }

    /// @notice Push this contract's full balance of `token` to `treasury`. Permissionless.
    /// @dev    The non-ETH leg of a locker position (the launched token, or both legs of an
    ///         exotic TOWELI-numeraire launch) lands here on every {claim}; RevenueDistributor
    ///         cannot distribute it, so it goes to the Safe instead. `token` is caller-supplied
    ///         and therefore an arbitrary external call — hence `nonReentrant`, and hence the
    ///         destination being immutable rather than a parameter. A non-contract or non-ERC20
    ///         `token` reads as a zero balance under Solady's `balanceOf` and no-ops.
    /// @param  token The ERC20 to sweep.
    function sweepToken(address token) external nonReentrant {
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) return;
        token.safeTransfer(treasury, amount);
        emit TokenSwept(token, msg.sender, amount);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev Forwards the whole ETH balance; a zero balance is a silent no-op so a keeper batching
    ///      {claim} over several positions is never reverted by an empty one. Uses a full-gas
    ///      `call` because `RevenueDistributor.receive()` does a warm SSTORE plus a LOG2 (~7k gas)
    ///      and would OOG under a 2,300-gas `transfer`. A failed push reverts the entire
    ///      transaction — including the locker release — so credit is never consumed without the
    ///      ETH arriving.
    function _forwardETH() internal {
        uint256 amount = address(this).balance;
        // SLITHER 2026-08-30: empty-balance no-op so keeper batching never reverts; the sink is
        // immutable and the whole balance forwards unconditionally — no branch to game
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return;
        (bool ok,) = revenueDistributor.call{value: amount}("");
        if (!ok) revert ForwardFailed();
        emit FeesForwarded(msg.sender, amount);
    }
}
