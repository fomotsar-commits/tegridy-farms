// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IRestakingForView {
    function restakers(address) external view returns (uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime, uint256 unsettledSnapshot);
    function accBonusPerShare() external view returns (uint256);
    function lastBonusRewardTime() external view returns (uint256);
    function totalRestaked() external view returns (uint256);
    function bonusRewardPerSecond() external view returns (uint256);
    function bonusRewardToken() external view returns (address);
    // AUDIT FIX 2026-08-27 [BONUS-SOLVENCY]: the host's accrual cap now subtracts the
    // full outstanding liability (emitted - distributed), not just crystallized IOUs.
    function totalBonusEmitted() external view returns (uint256);
    function totalBonusDistributed() external view returns (uint256);
    function boostedAmountAt(address, uint256) external view returns (uint256);
    function unforwardedBonusRewards(address) external view returns (uint256);
    function monitor() external view returns (address);
}

interface IERC20BalanceView { function balanceOf(address) external view returns (uint256); }
interface IStakingMonitorEarned { function earned(uint256 tokenId) external view returns (uint256); }

/// @title  RestakingMonitorView — read-only sister exposing TegridyRestaking's display
///         views (pendingBonus / pendingBase / totalBonusClaimable / pendingTotal).
/// @notice EIP-170 split (2026-06-04): these views have ZERO on-chain consumers, so
///         relocating them off the host (frontends/indexers/tests read here instead)
///         frees host bytecode with no protocol-state or behaviour change. Mirrors the
///         StakingMonitorView sister already live in this codebase. Each view is a
///         byte-for-byte reproduction of the host's prior implementation, reading host
///         state through getters (boost via the host's lazy-decay-safe boostedAmountAt).
contract RestakingMonitorView {
    IRestakingForView public immutable restaking;
    uint256 private constant ACC_PRECISION = 1e18;

    error Int256Overflow();

    constructor(address _restaking) {
        restaking = IRestakingForView(_restaking);
    }

    function _safeInt256(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert Int256Overflow();
        return int256(value);
    }

    function pendingBonus(address _user) public view returns (uint256) {
        IRestakingForView r = restaking;
        // SLITHER 2026-08-30: fixed 6-field tuple of a public-mapping getter (cannot fail);
        // only tokenId + bonusDebt are consumed and the shape is dictated by the host
        // slither-disable-next-line unused-return
        (uint256 tokenId,,, int256 bonusDebt,,) = r.restakers(_user);
        if (tokenId == 0) return 0;

        uint256 currentAcc = r.accBonusPerShare();
        uint256 lastTime = r.lastBonusRewardTime();
        uint256 totalRestaked_ = r.totalRestaked();
        if (block.timestamp > lastTime && totalRestaked_ > 0) {
            uint256 elapsed = block.timestamp - lastTime;
            uint256 reward = elapsed * r.bonusRewardPerSecond();
            uint256 available = 0;
            try IERC20BalanceView(r.bonusRewardToken()).balanceOf(address(r)) returns (uint256 bal) {
                // AUDIT FIX 2026-08-27 [BONUS-SOLVENCY]: mirror the host's cap EXACTLY.
                // The host caps accrual against the outstanding minted-but-unpaid
                // liability (totalBonusEmitted - totalBonusDistributed), not just the
                // crystallized IOUs (totalUnforwardedBonus). This view MUST use the same
                // term or it over-reports pending bonus vs what claimAll actually pays.
                uint256 emitted = r.totalBonusEmitted();
                uint256 distributed = r.totalBonusDistributed();
                uint256 outstanding = emitted > distributed ? emitted - distributed : 0;
                available = bal > outstanding ? bal - outstanding : 0;
            } catch {
                available = 0;
            }
            if (reward > available) reward = available;
            currentAcc += (reward * ACC_PRECISION) / totalRestaked_;
        }

        uint256 effectiveBoost = r.boostedAmountAt(_user, block.timestamp);
        int256 accumulated = _safeInt256((effectiveBoost * currentAcc) / ACC_PRECISION);
        int256 diff = accumulated - bonusDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    function pendingBase(address _user) public view returns (uint256) {
        IRestakingForView r = restaking;
        // SLITHER 2026-08-30: fixed 6-field tuple of a public-mapping getter (cannot fail);
        // only tokenId is consumed and the shape is dictated by the host
        // slither-disable-next-line unused-return
        (uint256 tokenId,,,,,) = r.restakers(_user);
        if (tokenId == 0) return 0;
        return IStakingMonitorEarned(r.monitor()).earned(tokenId);
    }

    function totalBonusClaimable(address user) external view returns (uint256) {
        return pendingBonus(user) + restaking.unforwardedBonusRewards(user);
    }

    function pendingTotal(address _user) external view returns (uint256 base, uint256 bonus) {
        base = pendingBase(_user);
        bonus = pendingBonus(_user);
    }
}
