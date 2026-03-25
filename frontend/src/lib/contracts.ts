import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS } from './constants';

// ─── TegridyStaking (Unified Lock + Stake + Boost + Governance + NFT Positions) ───
export const TEGRIDY_STAKING_ABI = [
  { type: 'function', name: 'stake', inputs: [{ name: '_amount', type: 'uint256' }, { name: '_lockDuration', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earlyWithdraw', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claim', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'toggleAutoMaxLock', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'fund', inputs: [{ name: '_amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // View functions
  { type: 'function', name: 'calculateBoost', inputs: [{ name: '_duration', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'pure' },
  { type: 'function', name: 'votingPowerOf', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingReward', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingRewardOf', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPosition', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostBps', type: 'uint256' }, { name: 'lockEnd', type: 'uint256' }, { name: 'lockDuration', type: 'uint256' }, { name: 'autoMaxLock', type: 'bool' }, { name: 'canWithdraw', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'positions', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostedAmount', type: 'uint256' }, { name: 'rewardDebt', type: 'int256' }, { name: 'lockEnd', type: 'uint256' }, { name: 'boostBps', type: 'uint256' }, { name: 'lockDuration', type: 'uint256' }, { name: 'autoMaxLock', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'userTokenId', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardPerSecond', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalStaked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBoostedStake', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalLocked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRewardsFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPenaltiesCollected', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPenaltiesRedistributed', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // ERC721
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
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
] as const;

export const UNISWAP_V2_FACTORY_ABI = [
  { type: 'function', name: 'getPair', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }], stateMutability: 'view' },
] as const;

export const UNISWAP_V2_PAIR_ABI = [
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ name: '_reserve0', type: 'uint112' }, { name: '_reserve1', type: 'uint112' }, { name: '_blockTimestampLast', type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── Chainlink ──────────────────────────────────────────────────
export const CHAINLINK_FEED_ABI = [
  { type: 'function', name: 'latestRoundData', inputs: [], outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }], stateMutability: 'view' },
] as const;

// ─── RevenueDistributor ─────────────────────────────────────────
export const REVENUE_DISTRIBUTOR_ABI = [
  { type: 'function', name: 'register', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claim', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingETH', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'hasRegistered', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
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
] as const;

// ─── SwapFeeRouter ──────────────────────────────────────────────
export const SWAP_FEE_ROUTER_ABI = [
  { type: 'function', name: 'swapExactETHForTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETH', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalETHFees', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSwaps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── PremiumAccess ──────────────────────────────────────────────
export const PREMIUM_ACCESS_ABI = [
  { type: 'function', name: 'hasPremium', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'subscribe', inputs: [{ name: 'months', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimNFTAccess', inputs: [], outputs: [], stateMutability: 'nonpayable' },
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

// ─── Configs ────────────────────────────────────────────────────
export const stakingConfig = {
  address: TEGRIDY_STAKING_ADDRESS,
  abi: TEGRIDY_STAKING_ABI,
} as const;

export const toweliConfig = {
  address: TOWELI_ADDRESS,
  abi: ERC20_ABI,
} as const;
