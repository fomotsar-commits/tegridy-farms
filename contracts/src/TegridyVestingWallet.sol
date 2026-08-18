// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title  TegridyVestingWallet — one linear-with-cliff vesting stream
/// @notice The vesting math is OpenZeppelin's, untouched: `VestingWallet` supplies the
///         linear schedule and `VestingWalletCliff` gates it behind the cliff. Neither is
///         copied into this repo — both are imported from the pinned
///         `lib/openzeppelin-contracts` submodule (v5.6.1), so there is no vendored fork
///         to drift and no diff to guard.
///
///         This contract adds provenance fields the launch scanner reads, a single-call
///         read surface for fact sheets, and one safety refusal. It adds no arithmetic.
///
/// @dev    Custody. The protocol cannot reach these funds, and that is structural rather
///         than promised:
///           - `release()` / `release(token)` are inherited unchanged and pay `owner()`,
///             the beneficiary, and only the beneficiary. They are permissionless to
///             CALL — a keeper or the beneficiary's own frontend may crank them — but the
///             destination is not a parameter, so a crank can only ever push vested funds
///             toward the person they already belong to.
///           - There is no owner-of-the-protocol here at all. The factory that deployed
///             this wallet is recorded for provenance and never called.
///           - There is no pause, no admin, no proxy, no clawback and no revoke.
///
/// @dev    No clawback, deliberately. A creator-revocable vest is not a vest: the launch
///         scanner's Tier-L "team allocation on-chain-vested" check would be reading a
///         promise the creator can withdraw at any moment, and printing a green badge for
///         it would be exactly the fabricated assurance the fact sheets exist to prevent.
///         If a creator wants recoverable funds, the lock vault is the rail for that.
contract TegridyVestingWallet is VestingWalletCliff {
    /// @notice The beneficiary may transfer this wallet (OZ semantics — see the
    ///         `VestingWallet` NOTE about selling unvested tokens) but may not renounce
    ///         it. Renouncing would set `owner()` to `address(0)`, permanently sending
    ///         every future `release` to the zero address: an irreversible burn of the
    ///         whole schedule from one mistaken call.
    error RenounceDisabled();

    /// @notice The factory that deployed this wallet. Provenance only; never called.
    address public immutable factory;

    /// @notice Whoever funded the stream. Carries no rights over the funds whatsoever —
    ///         recorded so a fact sheet can attribute a vest to the launch that made it.
    address public immutable creator;

    /// @notice The ERC-20 this wallet was created to vest.
    /// @dev    Advisory. A vesting wallet vests whatever it is sent, so this is the
    ///         DECLARED asset and not an exclusive one. A reader that needs certainty
    ///         must check the wallet's actual balances, not this field.
    address public immutable declaredToken;

    /// @param beneficiary     Receives every release. Must be non-zero (OZ `Ownable`
    ///                        rejects zero).
    /// @param startTimestamp  Schedule start.
    /// @param durationSeconds Total schedule length from `startTimestamp`.
    /// @param cliffSeconds    Seconds after start before anything is releasable; OZ
    ///                        rejects a cliff longer than the duration.
    /// @param token_          Declared asset, recorded for the scanner.
    /// @param creator_        Funder, recorded for attribution.
    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds,
        address token_,
        address creator_
    ) VestingWallet(beneficiary, startTimestamp, durationSeconds) VestingWalletCliff(cliffSeconds) {
        factory = msg.sender;
        creator = creator_;
        declaredToken = token_;
    }

    /// @notice Disabled. Mirrors the house-wide `OwnableNoRenounce` posture; this wallet
    ///         cannot inherit that base because OZ's `VestingWallet` fixes `Ownable` in
    ///         its own constructor chain, so the refusal is restated here.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Everything a fact sheet or the launch scanner needs about this stream.
    /// @dev    `locked` is `balance - releasable`: what is in the wallet and not yet
    ///         withdrawable right now. It is a live read of the token balance, so for a
    ///         rebasing or fee-on-transfer asset it reports what is actually there rather
    ///         than what the creator intended to deposit.
    struct VestingInfo {
        address beneficiary;
        address token;
        address creator;
        uint256 start;
        uint256 cliff;
        uint256 end;
        uint256 balance;
        uint256 released;
        uint256 releasable;
        uint256 locked;
        bool cliffReached;
        bool fullyVested;
    }

    /// @notice Single-call read surface for the declared token.
    function vestingInfo() external view returns (VestingInfo memory) {
        return vestingInfoFor(declaredToken);
    }

    /// @notice Same surface for any token this wallet happens to hold.
    /// @param  token Asset to report on.
    function vestingInfoFor(address token) public view returns (VestingInfo memory info) {
        uint256 bal = token == address(0) ? 0 : IERC20(token).balanceOf(address(this));
        uint256 free = token == address(0) ? 0 : releasable(token);
        info = VestingInfo({
            beneficiary: owner(),
            token: token,
            creator: creator,
            start: start(),
            cliff: cliff(),
            end: end(),
            balance: bal,
            released: token == address(0) ? 0 : released(token),
            releasable: free,
            locked: bal - free,
            cliffReached: block.timestamp >= cliff(),
            fullyVested: block.timestamp >= end()
        });
    }
}
