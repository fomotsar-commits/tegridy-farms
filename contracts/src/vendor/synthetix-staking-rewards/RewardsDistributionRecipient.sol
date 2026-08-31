// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Vendored from Uniswap/liquidity-staker@3edce550 (Synthetix's design; see
// VENDOR.md). 0.8 bridge only: `abstract` + `virtual` are the modern spelling
// of 0.5's implicitly-abstract contract with an unimplemented function.
abstract contract RewardsDistributionRecipient {
    address public rewardsDistribution;

    function notifyRewardAmount(uint256 reward) external virtual;

    modifier onlyRewardsDistribution() {
        require(msg.sender == rewardsDistribution, "Caller is not RewardsDistribution contract");
        _;
    }
}
