import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, VOTE_INCENTIVES_ADDRESS, LP_FARMING_ADDRESS } from './constants';

// Re-export the 8 ABIs extracted from forge build artifacts (AUDIT_FINDINGS H1).
// See scripts/extract-missing-abis.mjs — regenerate abi-supplement.ts whenever
// the underlying Solidity contracts change.
export * from './abi-supplement';

// ─── TegridyStaking (Unified Lock + Stake + Boost + Governance + NFT Positions) ───
export const TEGRIDY_STAKING_ABI = [
  { type: 'function', name: 'stake', inputs: [{ name: '_amount', type: 'uint256' }, { name: '_lockDuration', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earlyWithdraw', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getReward', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'claimed', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'toggleAutoMaxLock', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'notifyRewardAmount', inputs: [{ name: '_amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // View functions
  { type: 'function', name: 'calculateBoost', inputs: [{ name: '_duration', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'pure' },
  { type: 'function', name: 'votingPowerOf', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'votingPowerAtTimestamp', inputs: [{ name: 'user', type: 'address' }, { name: 'ts', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'earned', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPosition', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostBps', type: 'uint256' }, { name: 'lockEnd', type: 'uint256' }, { name: 'lockDuration', type: 'uint256' }, { name: 'autoMaxLock', type: 'bool' }, { name: 'canWithdraw', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'positions', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostedAmount', type: 'uint256' }, { name: 'rewardDebt', type: 'int256' }, { name: 'lockEnd', type: 'uint64' }, { name: 'boostBps', type: 'uint16' }, { name: 'lockDuration', type: 'uint32' }, { name: 'autoMaxLock', type: 'bool' }, { name: 'hasJbacBoost', type: 'bool' }, { name: 'stakeTimestamp', type: 'uint64' }], stateMutability: 'view' },
  { type: 'function', name: 'userTokenId', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalStaked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBoostedStake', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalLocked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRewardsFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPenaltiesCollected', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPenaltiesRedistributed', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Extended staking operations
  { type: 'function', name: 'extendLock', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: '_newLockDuration', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'emergencyExitPosition', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimUnsettled', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unsettledRewards', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'revalidateBoost', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // ERC721
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getApproved', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── TegridyRestaking (Bonus yield layer) ───────────────────────
export const TEGRIDY_RESTAKING_ABI = [
  { type: 'function', name: 'restake', inputs: [{ name: '_tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unrestake', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimAll', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingBonus', inputs: [{ name: '_user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingBase', inputs: [{ name: '_user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingTotal', inputs: [{ name: '_user', type: 'address' }], outputs: [{ name: 'base', type: 'uint256' }, { name: 'bonus', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'restakers', inputs: [{ name: '', type: 'address' }], outputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'positionAmount', type: 'uint256' }, { name: 'boostedAmount', type: 'uint256' }, { name: 'bonusDebt', type: 'int256' }, { name: 'depositTime', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRestaked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBonusFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBonusDistributed', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'bonusRewardPerSecond', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── ERC20 ──────────────────────────────────────────────────────
export const ERC20_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── Uniswap V2 (external fallback routing) ────────────────────
export const UNISWAP_V2_ROUTER_ABI = [
  { type: 'function', name: 'swapExactETHForTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETH', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactETHForTokensSupportingFeeOnTransferTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETHSupportingFeeOnTransferTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getAmountsOut', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'WETH', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'addLiquidityETH', inputs: [{ name: 'token', type: 'address' }, { name: 'amountTokenDesired', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'removeLiquidityETH', inputs: [{ name: 'token', type: 'address' }, { name: 'liquidity', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }], stateMutability: 'nonpayable' },
] as const;

export const UNISWAP_V2_FACTORY_ABI = [
  { type: 'function', name: 'getPair', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }], stateMutability: 'view' },
] as const;

export const UNISWAP_V2_PAIR_ABI = [
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ name: '_reserve0', type: 'uint112' }, { name: '_reserve1', type: 'uint112' }, { name: '_blockTimestampLast', type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── Chainlink ──────────────────────────────────────────────────
export const CHAINLINK_FEED_ABI = [
  { type: 'function', name: 'latestRoundData', inputs: [], outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }], stateMutability: 'view' },
] as const;

// ─── RevenueDistributor ─────────────────────────────────────────
export const REVENUE_DISTRIBUTOR_ABI = [
  { type: 'function', name: 'claim', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimUpTo', inputs: [{ name: 'maxEpochs', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingETH', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalDistributed', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalClaimed', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── CommunityGrants ────────────────────────────────────────────
export const COMMUNITY_GRANTS_ABI = [
  { type: 'function', name: 'createProposal', inputs: [{ name: '_recipient', type: 'address' }, { name: '_amount', type: 'uint256' }, { name: '_description', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'voteOnProposal', inputs: [{ name: '_proposalId', type: 'uint256' }, { name: '_support', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'finalizeProposal', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'proposalCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getProposal', inputs: [{ name: '_id', type: 'uint256' }], outputs: [{ name: 'proposer', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'description', type: 'string' }, { name: 'votesFor', type: 'uint256' }, { name: 'votesAgainst', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'status', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'hasVotedOnProposal', inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'totalGranted', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'executeProposal', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelProposal', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'lapseProposal', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

// ─── MemeBountyBoard ────────────────────────────────────────────
export const MEME_BOUNTY_BOARD_ABI = [
  { type: 'function', name: 'createBounty', inputs: [{ name: '_description', type: 'string' }, { name: '_deadline', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'submitWork', inputs: [{ name: '_bountyId', type: 'uint256' }, { name: '_contentURI', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'voteForSubmission', inputs: [{ name: '_bountyId', type: 'uint256' }, { name: '_submissionId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'completeBounty', inputs: [{ name: '_bountyId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelBounty', inputs: [{ name: '_bountyId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'bountyCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getBounty', inputs: [{ name: '_id', type: 'uint256' }], outputs: [{ name: 'creator', type: 'address' }, { name: 'description', type: 'string' }, { name: 'reward', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'winner', type: 'address' }, { name: 'submCount', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'dummy', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSubmission', inputs: [{ name: '_bountyId', type: 'uint256' }, { name: '_submissionId', type: 'uint256' }], outputs: [{ name: 'submitter', type: 'address' }, { name: 'contentURI', type: 'string' }, { name: 'votes', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'submissionCount', inputs: [{ name: '_bountyId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBountiesPosted', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPaidOut', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'withdrawPayout', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdrawRefund', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingPayouts', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingRefund', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'hasVotedOnBounty', inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'refundStaleBounty', inputs: [{ name: '_bountyId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

// ─── SwapFeeRouter ──────────────────────────────────────────────
export const SWAP_FEE_ROUTER_ABI = [
  // AUDIT FIX: Added maxFeeBps parameter to all swap functions for fee frontrunning protection
  { type: 'function', name: 'swapExactETHForTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETH', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalETHFees', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSwaps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getEffectiveFeeBps', inputs: [{ name: 'pairOrToken', type: 'address' }, { name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'premiumDiscountBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── PremiumAccess ──────────────────────────────────────────────
export const PREMIUM_ACCESS_ABI = [
  { type: 'function', name: 'hasPremium', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // AUDIT FIX H-02: Added maxCost parameter for fee frontrunning protection
  { type: 'function', name: 'subscribe', inputs: [{ name: 'months', type: 'uint256' }, { name: 'maxCost', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimNFTAccess', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'activateNFTPremium', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'monthlyFeeToweli', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSubscription', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'expiresAt', type: 'uint256' }, { name: 'lifetime', type: 'bool' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSubscribers', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRevenue', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── ReferralSplitter ───────────────────────────────────────────
export const REFERRAL_SPLITTER_ABI = [
  { type: 'function', name: 'setReferrer', inputs: [{ name: '_referrer', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimReferralRewards', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'referrerOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingETH', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getReferralInfo', inputs: [{ name: '_referrer', type: 'address' }], outputs: [{ name: 'referred', type: 'uint256' }, { name: 'earned', type: 'uint256' }, { name: 'pending', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalReferralsPaid', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── TegridyFactory (Native DEX Factory) ───────────────────────
export const TEGRIDY_FACTORY_ABI = [
  { type: 'function', name: 'getPair', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'createPair', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allPairsLength', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allPairs', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── TegridyRouter (Native DEX Router — Liquidity + Swaps) ─────
export const TEGRIDY_ROUTER_ABI = [
  // Liquidity
  { type: 'function', name: 'addLiquidityETH', inputs: [{ name: 'token', type: 'address' }, { name: 'amountTokenDesired', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'addLiquidity', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'amountADesired', type: 'uint256' }, { name: 'amountBDesired', type: 'uint256' }, { name: 'amountAMin', type: 'uint256' }, { name: 'amountBMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'removeLiquidity', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'liquidity', type: 'uint256' }, { name: 'amountAMin', type: 'uint256' }, { name: 'amountBMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'removeLiquidityETH', inputs: [{ name: 'token', type: 'address' }, { name: 'liquidity', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }], stateMutability: 'nonpayable' },
  // Swaps (standard Uniswap V2 Router interface)
  { type: 'function', name: 'swapExactETHForTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETH', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  // View
  { type: 'function', name: 'getAmountsOut', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'quote', inputs: [{ name: 'amountA', type: 'uint256' }, { name: 'reserveA', type: 'uint256' }, { name: 'reserveB', type: 'uint256' }], outputs: [{ name: 'amountB', type: 'uint256' }], stateMutability: 'pure' },
  { type: 'function', name: 'factory', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'WETH', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── VoteIncentives (Bribe Market) ──────────────────────────────
export const VOTE_INCENTIVES_ABI = [
  { type: 'function', name: 'epochCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'currentEpoch', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // EpochInfo struct has 3 public fields — include usesCommitReveal so the
  // UI can detect which voting path applies.
  { type: 'function', name: 'epochs', inputs: [{ name: '', type: 'uint256' }], outputs: [
    { name: 'totalPower', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'usesCommitReveal', type: 'bool' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'epochBribes', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }, { name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getEpochBribeTokens', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'claimable', inputs: [{ name: 'user', type: 'address' }, { name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [{ name: 'tokens', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'claimBribes', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimBribesBatch', inputs: [{ name: 'epochStart', type: 'uint256' }, { name: 'epochEnd', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'depositBribe', inputs: [{ name: 'pair', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'depositBribeETH', inputs: [{ name: 'pair', type: 'address' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'advanceEpoch', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'bribeFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeChangeTime', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getWhitelistedTokens', inputs: [], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'whitelistedTokens', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'minBribeAmounts', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MIN_BRIBE_AMOUNT', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'BRIBE_RESCUE_DELAY', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochBribeFirstDeposit', inputs: [{ name: 'epoch', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Pull-pattern withdrawals (ETH + ERC20)
  { type: 'function', name: 'withdrawPendingETH', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingETHWithdrawals', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'withdrawPendingToken', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingTokenWithdrawals', inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Legacy (non-commit-reveal) gauge voting
  { type: 'function', name: 'vote', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }, { name: 'power', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'gaugeVotes', inputs: [{ name: 'user', type: 'address' }, { name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalGaugeVotes', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'pair', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'userTotalVotes', inputs: [{ name: 'user', type: 'address' }, { name: 'epoch', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'VOTE_DEADLINE', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Commit-reveal gauge voting (Phase-1/Phase-2 anti-arbitrage)
  { type: 'function', name: 'commitRevealEnabled', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'COMMIT_BOND', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'COMMIT_RATIO_BPS', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'commitDeadline', inputs: [{ name: 'epoch', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'revealDeadline', inputs: [{ name: 'epoch', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'computeCommitHash', inputs: [
    { name: 'user', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'pair', type: 'address' },
    { name: 'power', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'commitVote', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'commitHash', type: 'bytes32' }], outputs: [{ name: 'commitIndex', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'revealVote', inputs: [
    { name: 'epoch', type: 'uint256' },
    { name: 'commitIndex', type: 'uint256' },
    { name: 'pair', type: 'address' },
    { name: 'power', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'sweepForfeitedBond', inputs: [{ name: 'user', type: 'address' }, { name: 'epoch', type: 'uint256' }, { name: 'commitIndex', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'voterCommits', inputs: [{ name: '', type: 'address' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }], outputs: [
    { name: 'commitHash', type: 'bytes32' },
    { name: 'bond', type: 'uint96' },
    { name: 'revealed', type: 'bool' },
  ], stateMutability: 'view' },
] as const;

export const voteIncentivesConfig = {
  address: VOTE_INCENTIVES_ADDRESS,
  abi: VOTE_INCENTIVES_ABI,
} as const;

// ─── LP Farming (Synthetix StakingRewards) ──────────────────────
export const LP_FARMING_ABI = [
  { type: 'function', name: 'stake', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getReward', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'exit', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'emergencyWithdraw', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'notifyRewardAmount', inputs: [{ name: 'reward', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earned', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'periodFinish', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardsDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRewardsFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardPerToken', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getRewardForDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lastTimeRewardApplicable', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const lpFarmingConfig = {
  address: LP_FARMING_ADDRESS,
  abi: LP_FARMING_ABI,
} as const;

// ─── TegridyLending (P2P NFT-Collateralized Lending) ───────────
export const TEGRIDY_LENDING_ABI = [
  { type: 'function', name: 'createLoanOffer', inputs: [{ name: '_aprBps', type: 'uint256' }, { name: '_duration', type: 'uint256' }, { name: '_collateralContract', type: 'address' }, { name: '_minPositionValue', type: 'uint256' }], outputs: [{ name: 'offerId', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'cancelOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptOffer', inputs: [{ name: '_offerId', type: 'uint256' }, { name: '_tokenId', type: 'uint256' }], outputs: [{ name: 'loanId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'repayLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'claimDefaultedCollateral', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [{ name: 'lender', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'duration', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'minPositionValue', type: 'uint256' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'borrower', type: 'address' }, { name: 'lender', type: 'address' }, { name: 'offerId', type: 'uint256' }, { name: 'tokenId', type: 'uint256' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'startTime', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'repaid', type: 'bool' }, { name: 'defaultClaimed', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getRepaymentAmount', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'total', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isDefaulted', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'offerCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'loanCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── TegridyLaunchpadV2 (Click-Deploy Factory — CollectionConfig struct input) ──
// V1 TegridyLaunchpad was deleted 2026-04-19. Historical clones created by the V1
// factory remain live and readable through the V2 Drop ABI (strict superset at the
// read surface). See docs/MIGRATION_HISTORY.md for address ledger.
export const TEGRIDY_LAUNCHPAD_V2_ABI = [
  { type: 'function', name: 'createCollection', inputs: [{ name: 'cfg', type: 'tuple', components: [
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'maxSupply', type: 'uint256' },
    { name: 'mintPrice', type: 'uint256' },
    { name: 'maxPerWallet', type: 'uint256' },
    { name: 'royaltyBps', type: 'uint16' },
    { name: 'placeholderURI', type: 'string' },
    { name: 'contractURI', type: 'string' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'dutchStartPrice', type: 'uint256' },
    { name: 'dutchEndPrice', type: 'uint256' },
    { name: 'dutchStartTime', type: 'uint256' },
    { name: 'dutchDuration', type: 'uint256' },
    { name: 'initialPhase', type: 'uint8' },
  ]}], outputs: [{ name: 'id', type: 'uint256' }, { name: 'collection', type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getCollection', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'id', type: 'uint256' },
    { name: 'collection', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
  ]}], stateMutability: 'view' },
  { type: 'function', name: 'getCollectionCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getAllCollections', inputs: [], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'dropTemplate', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ name: '', type: 'uint16' }], stateMutability: 'view' },
  { type: 'event', name: 'CollectionCreated', inputs: [
    { name: 'id', type: 'uint256', indexed: true },
    { name: 'collection', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'name', type: 'string', indexed: false },
    { name: 'symbol', type: 'string', indexed: false },
    { name: 'maxSupply', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'CollectionCreatedV2', inputs: [
    { name: 'id', type: 'uint256', indexed: true },
    { name: 'collection', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'contractURI', type: 'string', indexed: false },
    { name: 'merkleRoot', type: 'bytes32', indexed: false },
    { name: 'initialPhase', type: 'uint8', indexed: false },
  ] },
] as const;

// ─── TegridyDropV2 (V2 clone — adds contractURI + setContractURI) ─────
export const TEGRIDY_DROP_V2_ABI = [
  // Mint surface (same bytes4s as v1)
  { type: 'function', name: 'mint', inputs: [{ name: 'quantity', type: 'uint256' }, { name: 'proof', type: 'bytes32[]' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'currentPrice', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'mintPhase', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'merkleRoot', inputs: [], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'mintPrice', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxPerWallet', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'creator', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'paidPerWallet', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'mintedPerWallet', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'revealed', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // V2-only: ERC-7572 contractURI surface
  { type: 'function', name: 'contractURI', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'setContractURI', inputs: [{ name: 'uri', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  // Admin setters
  { type: 'function', name: 'setMintPhase', inputs: [{ name: 'phase', type: 'uint8' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setMerkleRoot', inputs: [{ name: 'root', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setMintPrice', inputs: [{ name: 'price', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setMaxPerWallet', inputs: [{ name: 'max', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setBaseURI', inputs: [{ name: 'uri', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'reveal', inputs: [{ name: 'revealURI', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'configureDutchAuction', inputs: [
    { name: 'startPrice', type: 'uint256' },
    { name: 'endPrice', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unpause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelSale', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'refund', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transferOwnership', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptOwnership', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'tokenURI', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
] as const;

// ─── TegridyNFTPool (Sudoswap-style NFT AMM Pool) ─────────────
export const TEGRIDY_NFT_POOL_ABI = [
  // ─── Trading (public) ──────────────────────────────────────────
  { type: 'function', name: 'swapETHForNFTs', inputs: [{ name: 'tokenIds', type: 'uint256[]' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'swapNFTsForETH', inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'minOutput', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getBuyQuote', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'inputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSellQuote', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'outputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getHeldTokenIds', inputs: [], outputs: [{ name: '', type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'getPoolInfo', inputs: [], outputs: [{ name: '_nftCollection', type: 'address' }, { name: '_poolType', type: 'uint8' }, { name: '_spotPrice', type: 'uint256' }, { name: '_delta', type: 'uint256' }, { name: '_feeBps', type: 'uint256' }, { name: '_protocolFeeBps', type: 'uint256' }, { name: '_owner', type: 'address' }, { name: '_numNFTs', type: 'uint256' }, { name: '_ethBalance', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'spotPrice', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'delta', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // ─── Liquidity (owner) ─────────────────────────────────────────
  { type: 'function', name: 'addLiquidity', inputs: [{ name: 'tokenIds', type: 'uint256[]' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'removeLiquidity', inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'ethAmount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // ─── Timelocked parameter changes (owner) ──────────────────────
  { type: 'function', name: 'proposeSpotPrice', inputs: [{ name: 'newPrice', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeSpotPriceChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelSpotPriceChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'proposeDelta', inputs: [{ name: 'newDelta', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeDeltaChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelDeltaChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingSpotPrice', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingSpotPriceExecuteAfter', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingDelta', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingDeltaExecuteAfter', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'PARAMETER_TIMELOCK', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // ─── Immediate owner actions ───────────────────────────────────
  { type: 'function', name: 'changeFee', inputs: [{ name: 'newFee', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdrawETH', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdrawNFTs', inputs: [{ name: 'tokenIds', type: 'uint256[]' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unpause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  // ─── Events (for trade history) ────────────────────────────────
  {
    type: 'event', name: 'SwapETHForNFTs', anonymous: false, inputs: [
      { indexed: true, name: 'buyer', type: 'address' },
      { indexed: false, name: 'tokenIds', type: 'uint256[]' },
      { indexed: false, name: 'totalCost', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'SwapNFTsForETH', anonymous: false, inputs: [
      { indexed: true, name: 'seller', type: 'address' },
      { indexed: false, name: 'tokenIds', type: 'uint256[]' },
      { indexed: false, name: 'totalPayout', type: 'uint256' },
    ],
  },
] as const;

// ─── TegridyNFTPoolFactory (NFT AMM Pool Factory) ─────────────
export const TEGRIDY_NFT_POOL_FACTORY_ABI = [
  { type: 'function', name: 'createPool', inputs: [{ name: 'nftCollection', type: 'address' }, { name: '_poolType', type: 'uint8' }, { name: '_spotPrice', type: 'uint256' }, { name: '_delta', type: 'uint256' }, { name: '_feeBps', type: 'uint256' }, { name: 'initialTokenIds', type: 'uint256[]' }], outputs: [{ name: 'pool', type: 'address' }], stateMutability: 'payable' },
  { type: 'function', name: 'getPoolsForCollection', inputs: [{ name: 'collection', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'getBestBuyPool', inputs: [{ name: 'collection', type: 'address' }, { name: 'numItems', type: 'uint256' }], outputs: [{ name: 'bestPool', type: 'address' }, { name: 'bestCost', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getBestSellPool', inputs: [{ name: 'collection', type: 'address' }, { name: 'numItems', type: 'uint256' }], outputs: [{ name: 'bestPool', type: 'address' }, { name: 'bestPayout', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPoolCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'event', name: 'PoolCreated', anonymous: false,
    inputs: [
      { indexed: true, name: 'pool', type: 'address' },
      { indexed: true, name: 'nftCollection', type: 'address' },
      { indexed: false, name: 'poolType', type: 'uint8' },
      { indexed: false, name: 'spotPrice', type: 'uint256' },
      { indexed: false, name: 'delta', type: 'uint256' },
      { indexed: false, name: 'feeBps', type: 'uint256' },
      { indexed: true, name: 'owner', type: 'address' },
    ],
  },
] as const;

// ─── Configs ────────────────────────────────────────────────────
export const stakingConfig = {
  address: TEGRIDY_STAKING_ADDRESS,
  abi: TEGRIDY_STAKING_ABI,
} as const;

export const toweliConfig = {
  address: TOWELI_ADDRESS,
  abi: ERC20_ABI,
} as const;

// ─── TegridyNFTLending (P2P NFT Lending) ─────────────────────
export const TEGRIDY_NFT_LENDING_ABI = [
  { type: 'function', name: 'createOffer', inputs: [{ name: '_principal', type: 'uint256' }, { name: '_aprBps', type: 'uint256' }, { name: '_duration', type: 'uint256' }, { name: '_collateralContract', type: 'address' }], outputs: [{ name: 'offerId', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'cancelOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptOffer', inputs: [{ name: '_offerId', type: 'uint256' }, { name: '_tokenId', type: 'uint256' }], outputs: [{ name: 'loanId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'repayLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'claimDefault', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [{ name: 'lender', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'duration', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'borrower', type: 'address' }, { name: 'lender', type: 'address' }, { name: 'offerId', type: 'uint256' }, { name: 'tokenId', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'startTime', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'repaid', type: 'bool' }, { name: 'defaultClaimed', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getRepaymentAmount', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'total', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'offerCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'loanCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'whitelistedCollections', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── GaugeController (Curve-style emission voting) ─────────────
export const GAUGE_CONTROLLER_ABI = [
  { type: 'function', name: 'vote', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'gauges', type: 'address[]' }, { name: 'weights', type: 'uint256[]' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'currentEpoch', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getGaugeWeight', inputs: [{ name: 'gauge', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getRelativeWeight', inputs: [{ name: 'gauge', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getGaugeEmission', inputs: [{ name: 'gauge', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getGauges', inputs: [], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'gaugeCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'emissionBudget', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lastVotedEpoch', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'EPOCH_DURATION', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'genesisEpoch', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalWeightByEpoch', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // ─── Commit-Reveal (Audit H-2 closure) ──────────────────────────
  { type: 'function', name: 'REVEAL_WINDOW', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochStartTime', inputs: [{ name: 'epoch', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'computeCommitment',
    inputs: [
      { name: 'voter', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'gauges', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
      { name: 'salt', type: 'bytes32' },
      { name: 'epoch', type: 'uint256' },
    ], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'pure' },
  { type: 'function', name: 'commitVote',
    inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'commitmentHash', type: 'bytes32' }],
    outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'revealVote',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'gauges', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
      { name: 'salt', type: 'bytes32' },
    ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isRevealWindowOpen', inputs: [],
    outputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'open', type: 'bool' },
      { name: 'revealOpensAt', type: 'uint256' },
      { name: 'revealClosesAt', type: 'uint256' },
    ], stateMutability: 'view' },
  { type: 'function', name: 'commitmentOf',
    inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'hasVotedInEpoch',
    inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // Events (indexed in event logs, helpful for wagmi event hooks)
  { type: 'event', name: 'VoteCommitted', inputs: [
    { name: 'voter', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'epoch', type: 'uint256', indexed: true },
    { name: 'commitmentHash', type: 'bytes32', indexed: false },
  ], anonymous: false },
  { type: 'event', name: 'VoteRevealed', inputs: [
    { name: 'voter', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'epoch', type: 'uint256', indexed: true },
    { name: 'gauges', type: 'address[]', indexed: false },
    { name: 'weights', type: 'uint256[]', indexed: false },
  ], anonymous: false },
] as const;

export const ERC721_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setApprovalForAll', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isApprovedForAll', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getApproved', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;
