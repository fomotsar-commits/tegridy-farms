// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Read-only slice of `VestingFactory` this view depends on. Declared locally rather
///      than importing the factory so the view carries no code from either rail and stays
///      a pure read sister, in the shape of `StakingMonitorView` / `RestakingMonitorView`.
interface IVestingFactoryReader {
    function totalVestedInflow(address token) external view returns (uint256);
    function vestingCountForToken(address token) external view returns (uint256);
}

/// @dev Read-only slice of `TegridyLockVault`.
interface ILockVaultReader {
    function totalLocked(address token) external view returns (uint256);
    function tokenLockSummary(address token, uint256 offset, uint256 limit)
        external
        view
        returns (uint256 amountLocked, uint64 earliestUnlock, uint64 latestUnlock, uint256 activeCount, uint256 next);
}

/// @title  LaunchLockView — one call the launch scanner and fact sheets can trust
/// @notice Joins the two #28 rails — `VestingFactory` and `TegridyLockVault` — into a
///         single snapshot for a token, so `gate.ts`'s Tier-L "team allocation
///         on-chain-vested" and "LP locked ≥ 30d" checks read chain state instead of
///         defaults.
///
/// @dev    This contract holds no state, owns nothing, and has no non-view function. It
///         cannot move a token, pause anything, or be pointed at a different rail after
///         deploy: both addresses are `immutable`. Repointing means deploying a new view.
///
/// @dev    Honesty-gating is the entire point of the two `*SourceAvailable` flags, and
///         consumers must respect the distinction:
///
///           `available == false` means NO DATA. It is returned when the rail's address
///           is unset, or when the rail is set but the call reverted — a wrong address, a
///           contract that isn't the rail, a chain where it was never deployed. Every
///           numeric field alongside it is zero because there was nothing to read, NOT
///           because the answer was zero.
///
///           `available == true` with zeros means the rail answered and the answer is
///           genuinely zero: nothing vested, nothing locked.
///
///         A UI that renders both cases as "0 locked" turns an outage into a claim about
///         the token. The unavailable case must render as "unavailable", never as a green
///         badge and never as a zero.
contract LaunchLockView {
    /// @notice The vesting registry, or `address(0)` when that rail is not deployed.
    IVestingFactoryReader public immutable vestingFactory;
    /// @notice The lock vault, or `address(0)` when that rail is not deployed.
    ILockVaultReader public immutable lockVault;

    /// @notice Both rails unset would make every snapshot permanently unavailable — a
    ///         contract that can only ever answer "no data" is a deploy mistake, not a
    ///         configuration.
    error NoSourcesConfigured();

    struct LaunchLockSnapshot {
        /// @notice False means the vesting numbers below are NO DATA, not zero.
        bool vestingSourceAvailable;
        /// @notice False means the lock numbers below are NO DATA, not zero.
        bool lockSourceAvailable;
        /// @notice Cumulative measured deposits into vesting wallets for this token.
        /// @dev    INFLOW, not current balance: it does not decrease as beneficiaries
        ///         release. Label it "total vested to date", never "currently vesting".
        uint256 vestedInflow;
        /// @notice Vesting wallets created for this token.
        uint256 vestingWalletCount;
        /// @notice Currently locked in the vault for this token, across all locks.
        /// @dev    This figure is complete and pagination-independent — it is the vault's
        ///         running total, not a scan.
        uint256 lockedTotal;
        /// @notice Sum of active lock amounts SEEN IN THE SCANNED PAGE only.
        uint256 lockedScanned;
        /// @notice Earliest active unlock in the scanned page; 0 when the page had none.
        uint64 earliestUnlockAt;
        /// @notice Latest active unlock in the scanned page.
        uint64 latestUnlockAt;
        /// @notice Active locks counted in the scanned page.
        uint256 activeLockCount;
        /// @notice Non-zero means the lock scan is INCOMPLETE: the unlock timestamps and
        ///         `lockedScanned` above describe part of the token's locks only. Call
        ///         again with this offset and merge, or state the answer as partial. Do
        ///         not publish an expiry date derived from a truncated scan.
        uint256 nextLockOffset;
    }

    /// @param vestingFactory_ `VestingFactory`, or `address(0)` if that rail is dark.
    /// @param lockVault_      `TegridyLockVault`, or `address(0)` if that rail is dark.
    constructor(address vestingFactory_, address lockVault_) {
        if (vestingFactory_ == address(0) && lockVault_ == address(0)) revert NoSourcesConfigured();
        vestingFactory = IVestingFactoryReader(vestingFactory_);
        lockVault = ILockVaultReader(lockVault_);
    }

    /// @notice Snapshot both rails for one token.
    /// @param  token      Asset to report on.
    /// @param  lockOffset Start index for the lock scan.
    /// @param  lockLimit  Maximum locks to visit. Pass 0 to skip the per-lock scan and
    ///                    read only the vault's complete `lockedTotal`.
    function snapshot(address token, uint256 lockOffset, uint256 lockLimit)
        external
        view
        returns (LaunchLockSnapshot memory snap)
    {
        // The code-length gate is load-bearing, not defensive dressing. A call to an
        // address with no code SUCCEEDS with empty return data, and Solidity's `try`
        // cannot catch the decode failure that follows — it bubbles and reverts the whole
        // snapshot. Without this check a codeless rail address would take the working
        // rail down with it and surface as a hard revert instead of "no data".
        if (address(vestingFactory) != address(0) && address(vestingFactory).code.length > 0) {
            // try/catch rather than a bare call: a rail address that is wrong, or points
            // at a contract that is not the rail, must degrade to "unavailable" instead
            // of reverting the whole snapshot and taking the lock half down with it.
            try vestingFactory.totalVestedInflow(token) returns (uint256 inflow) {
                try vestingFactory.vestingCountForToken(token) returns (uint256 count) {
                    snap.vestingSourceAvailable = true;
                    snap.vestedInflow = inflow;
                    snap.vestingWalletCount = count;
                } catch {}
            } catch {}
        }

        if (address(lockVault) != address(0) && address(lockVault).code.length > 0) {
            try lockVault.totalLocked(token) returns (uint256 lockedTotal) {
                try lockVault.tokenLockSummary(token, lockOffset, lockLimit) returns (
                    uint256 amountLocked, uint64 earliest, uint64 latest, uint256 activeCount, uint256 next
                ) {
                    snap.lockSourceAvailable = true;
                    snap.lockedTotal = lockedTotal;
                    snap.lockedScanned = amountLocked;
                    snap.earliestUnlockAt = earliest;
                    snap.latestUnlockAt = latest;
                    snap.activeLockCount = activeCount;
                    snap.nextLockOffset = next;
                } catch {}
            } catch {}
        }
    }
}
