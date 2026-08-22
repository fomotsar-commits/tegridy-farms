// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  TegridyCurveToken — the fixed-supply ERC20 a curve launch mints.
/// @notice The entire supply is minted ONCE, to the launcher, at construction —
///         no owner, no mint function, no rebasing, no fee-on-transfer, no
///         reflection. The one behavior it DOES have is the standard
///         bonding-curve transfer lock: until the launcher flips `graduated`,
///         the token can only move to or from the launcher (i.e. buying and
///         selling on the curve). This is not decoration — it is the fix for a
///         graduation-seeding theft (adversarial review 2026-08-22): without
///         it, anyone could buy dust, seed the token/WETH pair at a hostile
///         ratio, and capture most of the graduation liquidity when the
///         launcher minted into that pre-seeded pair. With tokens unable to
///         reach any pair before graduation, the graduation pool is always the
///         pair's FIRST mint, so the burned-liquidity floor is real.
///
/// @dev    Post-graduation the lock is permanently lifted and the token is a
///         plain, freely-transferable ERC20 forever. The lock is one-way:
///         `graduate()` can only be called by the launcher and can never be
///         un-set.
contract TegridyCurveToken is ERC20 {
    /// @notice The launcher that minted this token and runs its curve. The only
    ///         address transfers may touch while the curve is pre-graduation,
    ///         and the only caller of `graduate()`.
    address public immutable launcher;
    /// @notice False during the curve phase, true forever after the launcher
    ///         graduates the launch. Gates the transfer lock in `_update`.
    bool public graduated;

    /// @dev A transfer that isn't a mint, a burn, or launcher-involved was
    ///      attempted before graduation.
    error TransferLockedUntilGraduation();
    /// @dev A non-launcher address called `graduate()`.
    error OnlyLauncher();

    event Graduated();

    constructor(string memory name_, string memory symbol_, uint256 supply_, address launcher_)
        ERC20(name_, symbol_)
    {
        launcher = launcher_;
        _mint(launcher_, supply_);
    }

    /// @notice Permanently lift the transfer lock. Launcher-only, one-shot.
    ///         The launcher calls this as part of graduation, immediately
    ///         before it seeds the pool, so the pair is tradeable the instant
    ///         it holds liquidity.
    function graduate() external {
        if (msg.sender != launcher) revert OnlyLauncher();
        graduated = true;
        emit Graduated();
    }

    /// @dev The transfer lock. Mints (`from == 0`) and burns (`to == 0`) always
    ///      pass; while pre-graduation, every other transfer must have the
    ///      launcher on one side (a curve buy = launcher→buyer, a curve sell =
    ///      buyer→launcher, graduation seeding = launcher→pair). After
    ///      graduation the guard is inert and this is a vanilla ERC20.
    function _update(address from, address to, uint256 value) internal override {
        if (
            !graduated && from != address(0) && to != address(0) && from != launcher
                && to != launcher
        ) {
            revert TransferLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}
