import {
  createUseReadContract,
  createUseWriteContract,
  createUseSimulateContract,
  createUseWatchContractEvent,
} from 'wagmi/codegen'

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CommunityGrants
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const communityGrantsAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_recipient', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_description', type: 'string' },
    ],
    name: 'createProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_proposalId', type: 'uint256' },
      { name: '_support', type: 'bool' },
    ],
    name: 'voteOnProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_proposalId', type: 'uint256' }],
    name: 'finalizeProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'proposalCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_id', type: 'uint256' }],
    name: 'getProposal',
    outputs: [
      { name: 'proposer', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'description', type: 'string' },
      { name: 'votesFor', type: 'uint256' },
      { name: 'votesAgainst', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    name: 'hasVotedOnProposal',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalGranted',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_proposalId', type: 'uint256' }],
    name: 'executeProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_proposalId', type: 'uint256' }],
    name: 'cancelProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_proposalId', type: 'uint256' }],
    name: 'lapseProposal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const communityGrantsAddress =
  '0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032' as const

export const communityGrantsConfig = {
  address: communityGrantsAddress,
  abi: communityGrantsAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GaugeController
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const gaugeControllerAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'gauges', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
    ],
    name: 'vote',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'currentEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'gauge', type: 'address' }],
    name: 'getGaugeWeight',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'gauge', type: 'address' }],
    name: 'getRelativeWeight',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'gauge', type: 'address' }],
    name: 'getGaugeEmission',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getGauges',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'gaugeCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'emissionBudget',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    name: 'lastVotedEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'EPOCH_DURATION',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'genesisEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    name: 'totalWeightByEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'REVEAL_WINDOW',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', type: 'uint256' }],
    name: 'epochStartTime',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'voter', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'gauges', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
      { name: 'salt', type: 'bytes32' },
      { name: 'epoch', type: 'uint256' },
    ],
    name: 'computeCommitment',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'commitmentHash', type: 'bytes32' },
    ],
    name: 'commitVote',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'gauges', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
      { name: 'salt', type: 'bytes32' },
    ],
    name: 'revealVote',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'isRevealWindowOpen',
    outputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'open', type: 'bool' },
      { name: 'revealOpensAt', type: 'uint256' },
      { name: 'revealClosesAt', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
    name: 'commitmentOf',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
    name: 'hasVotedInEpoch',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'voter', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'commitmentHash', type: 'bytes32', indexed: false },
    ],
    name: 'VoteCommitted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'voter', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'gauges', type: 'address[]', indexed: false },
      { name: 'weights', type: 'uint256[]', indexed: false },
    ],
    name: 'VoteRevealed',
  },
] as const

export const gaugeControllerAddress =
  '0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb' as const

export const gaugeControllerConfig = {
  address: gaugeControllerAddress,
  abi: gaugeControllerAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// LPFarming
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const lpFarmingAbi = [
  {
    type: 'function',
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'stake',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getReward',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'exit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'emergencyWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'reward', type: 'uint256' }],
    name: 'notifyRewardAmount',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    name: 'earned',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardRate',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'periodFinish',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardsDuration',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalRewardsFunded',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardPerToken',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getRewardForDuration',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'lastTimeRewardApplicable',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const lpFarmingAddress =
  '0xa7EF711Be3662B9557634502032F98944eC69ec1' as const

export const lpFarmingConfig = {
  address: lpFarmingAddress,
  abi: lpFarmingAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MemeBountyBoard
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const memeBountyBoardAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_description', type: 'string' },
      { name: '_deadline', type: 'uint256' },
    ],
    name: 'createBounty',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_bountyId', type: 'uint256' },
      { name: '_contentURI', type: 'string' },
    ],
    name: 'submitWork',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_bountyId', type: 'uint256' },
      { name: '_submissionId', type: 'uint256' },
    ],
    name: 'voteForSubmission',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_bountyId', type: 'uint256' }],
    name: 'completeBounty',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_bountyId', type: 'uint256' }],
    name: 'cancelBounty',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'bountyCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_id', type: 'uint256' }],
    name: 'getBounty',
    outputs: [
      { name: 'creator', type: 'address' },
      { name: 'description', type: 'string' },
      { name: 'reward', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'winner', type: 'address' },
      { name: 'submCount', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'dummy', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_bountyId', type: 'uint256' },
      { name: '_submissionId', type: 'uint256' },
    ],
    name: 'getSubmission',
    outputs: [
      { name: 'submitter', type: 'address' },
      { name: 'contentURI', type: 'string' },
      { name: 'votes', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_bountyId', type: 'uint256' }],
    name: 'submissionCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalBountiesPosted',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalPaidOut',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'withdrawPayout',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'withdrawRefund',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'pendingPayouts',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'pendingRefund',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    name: 'hasVotedOnBounty',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_bountyId', type: 'uint256' }],
    name: 'refundStaleBounty',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const memeBountyBoardAddress =
  '0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9' as const

export const memeBountyBoardConfig = {
  address: memeBountyBoardAddress,
  abi: memeBountyBoardAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PremiumAccess
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const premiumAccessAbi = [
  {
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    name: 'hasPremium',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'months', type: 'uint256' },
      { name: 'maxCost', type: 'uint256' },
    ],
    name: 'subscribe',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'claimNFTAccess',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'activateNFTPremium',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'monthlyFeeToweli',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getSubscription',
    outputs: [
      { name: 'expiresAt', type: 'uint256' },
      { name: 'lifetime', type: 'bool' },
      { name: 'active', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSubscribers',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalRevenue',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const premiumAccessAddress =
  '0xaA16dF3dC66c7A6aD7db153711329955519422Ad' as const

export const premiumAccessConfig = {
  address: premiumAccessAddress,
  abi: premiumAccessAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ReferralSplitter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const referralSplitterAbi = [
  {
    type: 'function',
    inputs: [{ name: '_referrer', type: 'address' }],
    name: 'setReferrer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'claimReferralRewards',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'referrerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'pendingETH',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_referrer', type: 'address' }],
    name: 'getReferralInfo',
    outputs: [
      { name: 'referred', type: 'uint256' },
      { name: 'earned', type: 'uint256' },
      { name: 'pending', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalReferralsPaid',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const referralSplitterAddress =
  '0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16' as const

export const referralSplitterConfig = {
  address: referralSplitterAddress,
  abi: referralSplitterAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// RevenueDistributor
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const revenueDistributorAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'maxEpochs', type: 'uint256' }],
    name: 'claimUpTo',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    name: 'pendingETH',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalDistributed',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalClaimed',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'epochCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const revenueDistributorAddress =
  '0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8' as const

export const revenueDistributorConfig = {
  address: revenueDistributorAddress,
  abi: revenueDistributorAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SwapFeeRouter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const swapFeeRouterAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactETHForTokens',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactTokensForETH',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactTokensForTokens',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxFeeBps', type: 'uint256' },
    ],
    name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'feeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalETHFees',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSwaps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'pairOrToken', type: 'address' },
      { name: 'user', type: 'address' },
    ],
    name: 'getEffectiveFeeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'premiumDiscountBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const swapFeeRouterAddress =
  '0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0' as const

export const swapFeeRouterConfig = {
  address: swapFeeRouterAddress,
  abi: swapFeeRouterAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyDropV2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyDropV2Abi = [
  {
    type: 'function',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'currentPrice',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'maxSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'mintPhase',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'merkleRoot',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'mintPrice',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'maxPerWallet',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'creator',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'paidPerWallet',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'mintedPerWallet',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'revealed',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'paused',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'contractURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'uri', type: 'string' }],
    name: 'setContractURI',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'phase', type: 'uint8' }],
    name: 'setMintPhase',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'root', type: 'bytes32' }],
    name: 'setMerkleRoot',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'price', type: 'uint256' }],
    name: 'setMintPrice',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'max', type: 'uint256' }],
    name: 'setMaxPerWallet',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'uri', type: 'string' }],
    name: 'setBaseURI',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'revealURI', type: 'string' }],
    name: 'reveal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'startPrice', type: 'uint256' },
      { name: 'endPrice', type: 'uint256' },
      { name: 'startTime', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
    ],
    name: 'configureDutchAuction',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pause',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'unpause',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cancelSale',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'refund',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'acceptOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyFactory
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyFactoryAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    name: 'getPair',
    outputs: [{ name: 'pair', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    name: 'createPair',
    outputs: [{ name: 'pair', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'allPairsLength',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    name: 'allPairs',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const

export const tegridyFactoryAddress =
  '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' as const

export const tegridyFactoryConfig = {
  address: tegridyFactoryAddress,
  abi: tegridyFactoryAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyLaunchpad
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyLaunchpadAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_name', type: 'string' },
      { name: '_symbol', type: 'string' },
      { name: '_maxSupply', type: 'uint256' },
      { name: '_mintPrice', type: 'uint256' },
      { name: '_maxPerWallet', type: 'uint256' },
      { name: '_royaltyBps', type: 'uint16' },
    ],
    name: 'createCollection',
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'collection', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'getCollection',
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'collection', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getCollectionCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const tegridyLaunchpadAddress =
  '0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2' as const

export const tegridyLaunchpadConfig = {
  address: tegridyLaunchpadAddress,
  abi: tegridyLaunchpadAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyLaunchpadV2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyLaunchpadV2Abi = [
  {
    type: 'function',
    inputs: [
      {
        name: 'cfg',
        type: 'tuple',
        components: [
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
        ],
      },
    ],
    name: 'createCollection',
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'collection', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'getCollection',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'collection', type: 'address' },
          { name: 'creator', type: 'address' },
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getCollectionCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getAllCollections',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'dropTemplate',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'protocolFeeBps',
    outputs: [{ name: '', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'collection', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'maxSupply', type: 'uint256', indexed: false },
    ],
    name: 'CollectionCreated',
  },
  {
    type: 'event',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'collection', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'contractURI', type: 'string', indexed: false },
      { name: 'merkleRoot', type: 'bytes32', indexed: false },
      { name: 'initialPhase', type: 'uint8', indexed: false },
    ],
    name: 'CollectionCreatedV2',
  },
] as const

export const tegridyLaunchpadV2Address =
  '0x0000000000000000000000000000000000000000' as const

export const tegridyLaunchpadV2Config = {
  address: tegridyLaunchpadV2Address,
  abi: tegridyLaunchpadV2Abi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyLending
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyLendingAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_aprBps', type: 'uint256' },
      { name: '_duration', type: 'uint256' },
      { name: '_collateralContract', type: 'address' },
      { name: '_minPositionValue', type: 'uint256' },
    ],
    name: 'createLoanOffer',
    outputs: [{ name: 'offerId', type: 'uint256' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_offerId', type: 'uint256' }],
    name: 'cancelOffer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_offerId', type: 'uint256' },
      { name: '_tokenId', type: 'uint256' },
    ],
    name: 'acceptOffer',
    outputs: [{ name: 'loanId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'repayLoan',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'claimDefaultedCollateral',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_offerId', type: 'uint256' }],
    name: 'getOffer',
    outputs: [
      { name: 'lender', type: 'address' },
      { name: 'principal', type: 'uint256' },
      { name: 'aprBps', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
      { name: 'collateralContract', type: 'address' },
      { name: 'minPositionValue', type: 'uint256' },
      { name: 'active', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'getLoan',
    outputs: [
      { name: 'borrower', type: 'address' },
      { name: 'lender', type: 'address' },
      { name: 'offerId', type: 'uint256' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'principal', type: 'uint256' },
      { name: 'aprBps', type: 'uint256' },
      { name: 'startTime', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'repaid', type: 'bool' },
      { name: 'defaultClaimed', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'getRepaymentAmount',
    outputs: [{ name: 'total', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'isDefaulted',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'offerCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'loanCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'protocolFeeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const tegridyLendingAddress =
  '0xd471e5675EaDbD8C192A5dA2fF44372D5713367f' as const

export const tegridyLendingConfig = {
  address: tegridyLendingAddress,
  abi: tegridyLendingAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyNFTLending
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyNftLendingAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_principal', type: 'uint256' },
      { name: '_aprBps', type: 'uint256' },
      { name: '_duration', type: 'uint256' },
      { name: '_collateralContract', type: 'address' },
    ],
    name: 'createOffer',
    outputs: [{ name: 'offerId', type: 'uint256' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_offerId', type: 'uint256' }],
    name: 'cancelOffer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_offerId', type: 'uint256' },
      { name: '_tokenId', type: 'uint256' },
    ],
    name: 'acceptOffer',
    outputs: [{ name: 'loanId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'repayLoan',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'claimDefault',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_offerId', type: 'uint256' }],
    name: 'getOffer',
    outputs: [
      { name: 'lender', type: 'address' },
      { name: 'principal', type: 'uint256' },
      { name: 'aprBps', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
      { name: 'collateralContract', type: 'address' },
      { name: 'active', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'getLoan',
    outputs: [
      { name: 'borrower', type: 'address' },
      { name: 'lender', type: 'address' },
      { name: 'offerId', type: 'uint256' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'collateralContract', type: 'address' },
      { name: 'principal', type: 'uint256' },
      { name: 'aprBps', type: 'uint256' },
      { name: 'startTime', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'repaid', type: 'bool' },
      { name: 'defaultClaimed', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_loanId', type: 'uint256' }],
    name: 'getRepaymentAmount',
    outputs: [{ name: 'total', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'offerCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'loanCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'whitelistedCollections',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'protocolFeeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const tegridyNftLendingAddress =
  '0x05409880aDFEa888F2c93568B8D88c7b4aAdB139' as const

export const tegridyNftLendingConfig = {
  address: tegridyNftLendingAddress,
  abi: tegridyNftLendingAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyNFTPoolFactory
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyNftPoolFactoryAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'nftCollection', type: 'address' },
      { name: '_poolType', type: 'uint8' },
      { name: '_spotPrice', type: 'uint256' },
      { name: '_delta', type: 'uint256' },
      { name: '_feeBps', type: 'uint256' },
      { name: 'initialTokenIds', type: 'uint256[]' },
    ],
    name: 'createPool',
    outputs: [{ name: 'pool', type: 'address' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'collection', type: 'address' }],
    name: 'getPoolsForCollection',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'numItems', type: 'uint256' },
    ],
    name: 'getBestBuyPool',
    outputs: [
      { name: 'bestPool', type: 'address' },
      { name: 'bestCost', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'numItems', type: 'uint256' },
    ],
    name: 'getBestSellPool',
    outputs: [
      { name: 'bestPool', type: 'address' },
      { name: 'bestPayout', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getPoolCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'pool', type: 'address', indexed: true },
      { name: 'nftCollection', type: 'address', indexed: true },
      { name: 'poolType', type: 'uint8', indexed: false },
      { name: 'spotPrice', type: 'uint256', indexed: false },
      { name: 'delta', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint256', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
    name: 'PoolCreated',
  },
] as const

export const tegridyNftPoolFactoryAddress =
  '0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0' as const

export const tegridyNftPoolFactoryConfig = {
  address: tegridyNftPoolFactoryAddress,
  abi: tegridyNftPoolFactoryAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyRestaking
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyRestakingAbi = [
  {
    type: 'function',
    inputs: [{ name: '_tokenId', type: 'uint256' }],
    name: 'restake',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'unrestake',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'claimAll',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_user', type: 'address' }],
    name: 'pendingBonus',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_user', type: 'address' }],
    name: 'pendingBase',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_user', type: 'address' }],
    name: 'pendingTotal',
    outputs: [
      { name: 'base', type: 'uint256' },
      { name: 'bonus', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'restakers',
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'positionAmount', type: 'uint256' },
      { name: 'boostedAmount', type: 'uint256' },
      { name: 'bonusDebt', type: 'int256' },
      { name: 'depositTime', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalRestaked',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalBonusFunded',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalBonusDistributed',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'bonusRewardPerSecond',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const tegridyRestakingAddress =
  '0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4' as const

export const tegridyRestakingConfig = {
  address: tegridyRestakingAddress,
  abi: tegridyRestakingAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyRouter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyRouterAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountTokenDesired', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'addLiquidityETH',
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountADesired', type: 'uint256' },
      { name: 'amountBDesired', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'addLiquidity',
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'removeLiquidity',
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'removeLiquidityETH',
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'swapExactETHForTokens',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'swapExactTokensForETH',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    name: 'swapExactTokensForTokens',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'reserveA', type: 'uint256' },
      { name: 'reserveB', type: 'uint256' },
    ],
    name: 'quote',
    outputs: [{ name: 'amountB', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'factory',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'WETH',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const

export const tegridyRouterAddress =
  '0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F' as const

export const tegridyRouterConfig = {
  address: tegridyRouterAddress,
  abi: tegridyRouterAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TegridyStaking
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const tegridyStakingAbi = [
  {
    type: 'function',
    inputs: [
      { name: '_amount', type: 'uint256' },
      { name: '_lockDuration', type: 'uint256' },
    ],
    name: 'stake',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'earlyWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'getReward',
    outputs: [{ name: 'claimed', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'toggleAutoMaxLock',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_amount', type: 'uint256' }],
    name: 'notifyRewardAmount',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_duration', type: 'uint256' }],
    name: 'calculateBoost',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    name: 'votingPowerOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'ts', type: 'uint256' },
    ],
    name: 'votingPowerAtTimestamp',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'earned',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'getPosition',
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'boostBps', type: 'uint256' },
      { name: 'lockEnd', type: 'uint256' },
      { name: 'lockDuration', type: 'uint256' },
      { name: 'autoMaxLock', type: 'bool' },
      { name: 'canWithdraw', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    name: 'positions',
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'boostedAmount', type: 'uint256' },
      { name: 'rewardDebt', type: 'int256' },
      { name: 'lockEnd', type: 'uint64' },
      { name: 'boostBps', type: 'uint16' },
      { name: 'lockDuration', type: 'uint32' },
      { name: 'autoMaxLock', type: 'bool' },
      { name: 'hasJbacBoost', type: 'bool' },
      { name: 'stakeTimestamp', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'userTokenId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardRate',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalStaked',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalBoostedStake',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalLocked',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalRewardsFunded',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalPenaltiesCollected',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalPenaltiesRedistributed',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: '_newLockDuration', type: 'uint256' },
    ],
    name: 'extendLock',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'emergencyExitPosition',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'claimUnsettled',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    name: 'unsettledRewards',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'revalidateBoost',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'paused',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'getApproved',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const tegridyStakingAddress =
  '0x626644523d34B84818df602c991B4a06789C4819' as const

export const tegridyStakingConfig = {
  address: tegridyStakingAddress,
  abi: tegridyStakingAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Toweli
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const toweliAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const toweliAddress =
  '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const

export const toweliConfig = { address: toweliAddress, abi: toweliAbi } as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// VoteIncentives
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const voteIncentivesAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'epochCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'currentEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    name: 'epochs',
    outputs: [
      { name: 'totalPower', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'usesCommitReveal', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    name: 'epochBribes',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'getEpochBribeTokens',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'claimable',
    outputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'claimBribes',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epochStart', type: 'uint256' },
      { name: 'epochEnd', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'claimBribesBatch',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'pair', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'depositBribe',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'pair', type: 'address' }],
    name: 'depositBribeETH',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'advanceEpoch',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'bribeFeeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pendingFeeBps',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'feeChangeTime',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getWhitelistedTokens',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    name: 'whitelistedTokens',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    name: 'minBribeAmounts',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MIN_BRIBE_AMOUNT',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'BRIBE_RESCUE_DELAY',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', type: 'uint256' }],
    name: 'epochBribeFirstDeposit',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'withdrawPendingETH',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    name: 'pendingETHWithdrawals',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    name: 'withdrawPendingToken',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    name: 'pendingTokenWithdrawals',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
      { name: 'power', type: 'uint256' },
    ],
    name: 'vote',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'gaugeVotes',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
    ],
    name: 'totalGaugeVotes',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'epoch', type: 'uint256' },
    ],
    name: 'userTotalVotes',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'VOTE_DEADLINE',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'commitRevealEnabled',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'COMMIT_BOND',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'COMMIT_RATIO_BPS',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', type: 'uint256' }],
    name: 'commitDeadline',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', type: 'uint256' }],
    name: 'revealDeadline',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'epoch', type: 'uint256' },
      { name: 'pair', type: 'address' },
      { name: 'power', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    name: 'computeCommitHash',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'commitHash', type: 'bytes32' },
    ],
    name: 'commitVote',
    outputs: [{ name: 'commitIndex', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'commitIndex', type: 'uint256' },
      { name: 'pair', type: 'address' },
      { name: 'power', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    name: 'revealVote',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'epoch', type: 'uint256' },
      { name: 'commitIndex', type: 'uint256' },
    ],
    name: 'sweepForfeitedBond',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', type: 'address' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
    name: 'voterCommits',
    outputs: [
      { name: 'commitHash', type: 'bytes32' },
      { name: 'bond', type: 'uint96' },
      { name: 'revealed', type: 'bool' },
    ],
    stateMutability: 'view',
  },
] as const

export const voteIncentivesAddress =
  '0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A' as const

export const voteIncentivesConfig = {
  address: voteIncentivesAddress,
  abi: voteIncentivesAbi,
} as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// React
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link communityGrantsAbi}__
 */
export const useReadCommunityGrants = /*#__PURE__*/ createUseReadContract({
  abi: communityGrantsAbi,
  address: communityGrantsAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"proposalCount"`
 */
export const useReadCommunityGrantsProposalCount =
  /*#__PURE__*/ createUseReadContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'proposalCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"getProposal"`
 */
export const useReadCommunityGrantsGetProposal =
  /*#__PURE__*/ createUseReadContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'getProposal',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"hasVotedOnProposal"`
 */
export const useReadCommunityGrantsHasVotedOnProposal =
  /*#__PURE__*/ createUseReadContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'hasVotedOnProposal',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"totalGranted"`
 */
export const useReadCommunityGrantsTotalGranted =
  /*#__PURE__*/ createUseReadContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'totalGranted',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__
 */
export const useWriteCommunityGrants = /*#__PURE__*/ createUseWriteContract({
  abi: communityGrantsAbi,
  address: communityGrantsAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"createProposal"`
 */
export const useWriteCommunityGrantsCreateProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'createProposal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"voteOnProposal"`
 */
export const useWriteCommunityGrantsVoteOnProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'voteOnProposal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"finalizeProposal"`
 */
export const useWriteCommunityGrantsFinalizeProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'finalizeProposal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"executeProposal"`
 */
export const useWriteCommunityGrantsExecuteProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'executeProposal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"cancelProposal"`
 */
export const useWriteCommunityGrantsCancelProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'cancelProposal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"lapseProposal"`
 */
export const useWriteCommunityGrantsLapseProposal =
  /*#__PURE__*/ createUseWriteContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'lapseProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__
 */
export const useSimulateCommunityGrants =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"createProposal"`
 */
export const useSimulateCommunityGrantsCreateProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'createProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"voteOnProposal"`
 */
export const useSimulateCommunityGrantsVoteOnProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'voteOnProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"finalizeProposal"`
 */
export const useSimulateCommunityGrantsFinalizeProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'finalizeProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"executeProposal"`
 */
export const useSimulateCommunityGrantsExecuteProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'executeProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"cancelProposal"`
 */
export const useSimulateCommunityGrantsCancelProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'cancelProposal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link communityGrantsAbi}__ and `functionName` set to `"lapseProposal"`
 */
export const useSimulateCommunityGrantsLapseProposal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: communityGrantsAbi,
    address: communityGrantsAddress,
    functionName: 'lapseProposal',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__
 */
export const useReadGaugeController = /*#__PURE__*/ createUseReadContract({
  abi: gaugeControllerAbi,
  address: gaugeControllerAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"currentEpoch"`
 */
export const useReadGaugeControllerCurrentEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'currentEpoch',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"getGaugeWeight"`
 */
export const useReadGaugeControllerGetGaugeWeight =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'getGaugeWeight',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"getRelativeWeight"`
 */
export const useReadGaugeControllerGetRelativeWeight =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'getRelativeWeight',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"getGaugeEmission"`
 */
export const useReadGaugeControllerGetGaugeEmission =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'getGaugeEmission',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"getGauges"`
 */
export const useReadGaugeControllerGetGauges =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'getGauges',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"gaugeCount"`
 */
export const useReadGaugeControllerGaugeCount =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'gaugeCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"emissionBudget"`
 */
export const useReadGaugeControllerEmissionBudget =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'emissionBudget',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"lastVotedEpoch"`
 */
export const useReadGaugeControllerLastVotedEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'lastVotedEpoch',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"EPOCH_DURATION"`
 */
export const useReadGaugeControllerEpochDuration =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'EPOCH_DURATION',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"genesisEpoch"`
 */
export const useReadGaugeControllerGenesisEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'genesisEpoch',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"totalWeightByEpoch"`
 */
export const useReadGaugeControllerTotalWeightByEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'totalWeightByEpoch',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"REVEAL_WINDOW"`
 */
export const useReadGaugeControllerRevealWindow =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'REVEAL_WINDOW',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"epochStartTime"`
 */
export const useReadGaugeControllerEpochStartTime =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'epochStartTime',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"computeCommitment"`
 */
export const useReadGaugeControllerComputeCommitment =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'computeCommitment',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"isRevealWindowOpen"`
 */
export const useReadGaugeControllerIsRevealWindowOpen =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'isRevealWindowOpen',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"commitmentOf"`
 */
export const useReadGaugeControllerCommitmentOf =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'commitmentOf',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"hasVotedInEpoch"`
 */
export const useReadGaugeControllerHasVotedInEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'hasVotedInEpoch',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link gaugeControllerAbi}__
 */
export const useWriteGaugeController = /*#__PURE__*/ createUseWriteContract({
  abi: gaugeControllerAbi,
  address: gaugeControllerAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"vote"`
 */
export const useWriteGaugeControllerVote = /*#__PURE__*/ createUseWriteContract(
  {
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'vote',
  },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"commitVote"`
 */
export const useWriteGaugeControllerCommitVote =
  /*#__PURE__*/ createUseWriteContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'commitVote',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"revealVote"`
 */
export const useWriteGaugeControllerRevealVote =
  /*#__PURE__*/ createUseWriteContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'revealVote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link gaugeControllerAbi}__
 */
export const useSimulateGaugeController =
  /*#__PURE__*/ createUseSimulateContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"vote"`
 */
export const useSimulateGaugeControllerVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'vote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"commitVote"`
 */
export const useSimulateGaugeControllerCommitVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'commitVote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link gaugeControllerAbi}__ and `functionName` set to `"revealVote"`
 */
export const useSimulateGaugeControllerRevealVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    functionName: 'revealVote',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link gaugeControllerAbi}__
 */
export const useWatchGaugeControllerEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link gaugeControllerAbi}__ and `eventName` set to `"VoteCommitted"`
 */
export const useWatchGaugeControllerVoteCommittedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    eventName: 'VoteCommitted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link gaugeControllerAbi}__ and `eventName` set to `"VoteRevealed"`
 */
export const useWatchGaugeControllerVoteRevealedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: gaugeControllerAbi,
    address: gaugeControllerAddress,
    eventName: 'VoteRevealed',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__
 */
export const useReadLpFarming = /*#__PURE__*/ createUseReadContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"earned"`
 */
export const useReadLpFarmingEarned = /*#__PURE__*/ createUseReadContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'earned',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"balanceOf"`
 */
export const useReadLpFarmingBalanceOf = /*#__PURE__*/ createUseReadContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'balanceOf',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"totalSupply"`
 */
export const useReadLpFarmingTotalSupply = /*#__PURE__*/ createUseReadContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'totalSupply',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"rewardRate"`
 */
export const useReadLpFarmingRewardRate = /*#__PURE__*/ createUseReadContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'rewardRate',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"periodFinish"`
 */
export const useReadLpFarmingPeriodFinish = /*#__PURE__*/ createUseReadContract(
  {
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'periodFinish',
  },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"rewardsDuration"`
 */
export const useReadLpFarmingRewardsDuration =
  /*#__PURE__*/ createUseReadContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'rewardsDuration',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"totalRewardsFunded"`
 */
export const useReadLpFarmingTotalRewardsFunded =
  /*#__PURE__*/ createUseReadContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'totalRewardsFunded',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"rewardPerToken"`
 */
export const useReadLpFarmingRewardPerToken =
  /*#__PURE__*/ createUseReadContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'rewardPerToken',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"getRewardForDuration"`
 */
export const useReadLpFarmingGetRewardForDuration =
  /*#__PURE__*/ createUseReadContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'getRewardForDuration',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"lastTimeRewardApplicable"`
 */
export const useReadLpFarmingLastTimeRewardApplicable =
  /*#__PURE__*/ createUseReadContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'lastTimeRewardApplicable',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__
 */
export const useWriteLpFarming = /*#__PURE__*/ createUseWriteContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"stake"`
 */
export const useWriteLpFarmingStake = /*#__PURE__*/ createUseWriteContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'stake',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteLpFarmingWithdraw = /*#__PURE__*/ createUseWriteContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'withdraw',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"getReward"`
 */
export const useWriteLpFarmingGetReward = /*#__PURE__*/ createUseWriteContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'getReward',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"exit"`
 */
export const useWriteLpFarmingExit = /*#__PURE__*/ createUseWriteContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
  functionName: 'exit',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"emergencyWithdraw"`
 */
export const useWriteLpFarmingEmergencyWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'emergencyWithdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"notifyRewardAmount"`
 */
export const useWriteLpFarmingNotifyRewardAmount =
  /*#__PURE__*/ createUseWriteContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'notifyRewardAmount',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__
 */
export const useSimulateLpFarming = /*#__PURE__*/ createUseSimulateContract({
  abi: lpFarmingAbi,
  address: lpFarmingAddress,
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"stake"`
 */
export const useSimulateLpFarmingStake =
  /*#__PURE__*/ createUseSimulateContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'stake',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateLpFarmingWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"getReward"`
 */
export const useSimulateLpFarmingGetReward =
  /*#__PURE__*/ createUseSimulateContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'getReward',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"exit"`
 */
export const useSimulateLpFarmingExit = /*#__PURE__*/ createUseSimulateContract(
  { abi: lpFarmingAbi, address: lpFarmingAddress, functionName: 'exit' },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"emergencyWithdraw"`
 */
export const useSimulateLpFarmingEmergencyWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'emergencyWithdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link lpFarmingAbi}__ and `functionName` set to `"notifyRewardAmount"`
 */
export const useSimulateLpFarmingNotifyRewardAmount =
  /*#__PURE__*/ createUseSimulateContract({
    abi: lpFarmingAbi,
    address: lpFarmingAddress,
    functionName: 'notifyRewardAmount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__
 */
export const useReadMemeBountyBoard = /*#__PURE__*/ createUseReadContract({
  abi: memeBountyBoardAbi,
  address: memeBountyBoardAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"bountyCount"`
 */
export const useReadMemeBountyBoardBountyCount =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'bountyCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"getBounty"`
 */
export const useReadMemeBountyBoardGetBounty =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'getBounty',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"getSubmission"`
 */
export const useReadMemeBountyBoardGetSubmission =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'getSubmission',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"submissionCount"`
 */
export const useReadMemeBountyBoardSubmissionCount =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'submissionCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"totalBountiesPosted"`
 */
export const useReadMemeBountyBoardTotalBountiesPosted =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'totalBountiesPosted',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"totalPaidOut"`
 */
export const useReadMemeBountyBoardTotalPaidOut =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'totalPaidOut',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"pendingPayouts"`
 */
export const useReadMemeBountyBoardPendingPayouts =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'pendingPayouts',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"pendingRefund"`
 */
export const useReadMemeBountyBoardPendingRefund =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'pendingRefund',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"hasVotedOnBounty"`
 */
export const useReadMemeBountyBoardHasVotedOnBounty =
  /*#__PURE__*/ createUseReadContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'hasVotedOnBounty',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__
 */
export const useWriteMemeBountyBoard = /*#__PURE__*/ createUseWriteContract({
  abi: memeBountyBoardAbi,
  address: memeBountyBoardAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"createBounty"`
 */
export const useWriteMemeBountyBoardCreateBounty =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'createBounty',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"submitWork"`
 */
export const useWriteMemeBountyBoardSubmitWork =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'submitWork',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"voteForSubmission"`
 */
export const useWriteMemeBountyBoardVoteForSubmission =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'voteForSubmission',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"completeBounty"`
 */
export const useWriteMemeBountyBoardCompleteBounty =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'completeBounty',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"cancelBounty"`
 */
export const useWriteMemeBountyBoardCancelBounty =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'cancelBounty',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"withdrawPayout"`
 */
export const useWriteMemeBountyBoardWithdrawPayout =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'withdrawPayout',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"withdrawRefund"`
 */
export const useWriteMemeBountyBoardWithdrawRefund =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'withdrawRefund',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"refundStaleBounty"`
 */
export const useWriteMemeBountyBoardRefundStaleBounty =
  /*#__PURE__*/ createUseWriteContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'refundStaleBounty',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__
 */
export const useSimulateMemeBountyBoard =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"createBounty"`
 */
export const useSimulateMemeBountyBoardCreateBounty =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'createBounty',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"submitWork"`
 */
export const useSimulateMemeBountyBoardSubmitWork =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'submitWork',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"voteForSubmission"`
 */
export const useSimulateMemeBountyBoardVoteForSubmission =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'voteForSubmission',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"completeBounty"`
 */
export const useSimulateMemeBountyBoardCompleteBounty =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'completeBounty',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"cancelBounty"`
 */
export const useSimulateMemeBountyBoardCancelBounty =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'cancelBounty',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"withdrawPayout"`
 */
export const useSimulateMemeBountyBoardWithdrawPayout =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'withdrawPayout',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"withdrawRefund"`
 */
export const useSimulateMemeBountyBoardWithdrawRefund =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'withdrawRefund',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link memeBountyBoardAbi}__ and `functionName` set to `"refundStaleBounty"`
 */
export const useSimulateMemeBountyBoardRefundStaleBounty =
  /*#__PURE__*/ createUseSimulateContract({
    abi: memeBountyBoardAbi,
    address: memeBountyBoardAddress,
    functionName: 'refundStaleBounty',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__
 */
export const useReadPremiumAccess = /*#__PURE__*/ createUseReadContract({
  abi: premiumAccessAbi,
  address: premiumAccessAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"hasPremium"`
 */
export const useReadPremiumAccessHasPremium =
  /*#__PURE__*/ createUseReadContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'hasPremium',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"monthlyFeeToweli"`
 */
export const useReadPremiumAccessMonthlyFeeToweli =
  /*#__PURE__*/ createUseReadContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'monthlyFeeToweli',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"getSubscription"`
 */
export const useReadPremiumAccessGetSubscription =
  /*#__PURE__*/ createUseReadContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'getSubscription',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"totalSubscribers"`
 */
export const useReadPremiumAccessTotalSubscribers =
  /*#__PURE__*/ createUseReadContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'totalSubscribers',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"totalRevenue"`
 */
export const useReadPremiumAccessTotalRevenue =
  /*#__PURE__*/ createUseReadContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'totalRevenue',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link premiumAccessAbi}__
 */
export const useWritePremiumAccess = /*#__PURE__*/ createUseWriteContract({
  abi: premiumAccessAbi,
  address: premiumAccessAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"subscribe"`
 */
export const useWritePremiumAccessSubscribe =
  /*#__PURE__*/ createUseWriteContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'subscribe',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"claimNFTAccess"`
 */
export const useWritePremiumAccessClaimNftAccess =
  /*#__PURE__*/ createUseWriteContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'claimNFTAccess',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"activateNFTPremium"`
 */
export const useWritePremiumAccessActivateNftPremium =
  /*#__PURE__*/ createUseWriteContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'activateNFTPremium',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link premiumAccessAbi}__
 */
export const useSimulatePremiumAccess = /*#__PURE__*/ createUseSimulateContract(
  { abi: premiumAccessAbi, address: premiumAccessAddress },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"subscribe"`
 */
export const useSimulatePremiumAccessSubscribe =
  /*#__PURE__*/ createUseSimulateContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'subscribe',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"claimNFTAccess"`
 */
export const useSimulatePremiumAccessClaimNftAccess =
  /*#__PURE__*/ createUseSimulateContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'claimNFTAccess',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link premiumAccessAbi}__ and `functionName` set to `"activateNFTPremium"`
 */
export const useSimulatePremiumAccessActivateNftPremium =
  /*#__PURE__*/ createUseSimulateContract({
    abi: premiumAccessAbi,
    address: premiumAccessAddress,
    functionName: 'activateNFTPremium',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link referralSplitterAbi}__
 */
export const useReadReferralSplitter = /*#__PURE__*/ createUseReadContract({
  abi: referralSplitterAbi,
  address: referralSplitterAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"referrerOf"`
 */
export const useReadReferralSplitterReferrerOf =
  /*#__PURE__*/ createUseReadContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'referrerOf',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"pendingETH"`
 */
export const useReadReferralSplitterPendingEth =
  /*#__PURE__*/ createUseReadContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'pendingETH',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"getReferralInfo"`
 */
export const useReadReferralSplitterGetReferralInfo =
  /*#__PURE__*/ createUseReadContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'getReferralInfo',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"totalReferralsPaid"`
 */
export const useReadReferralSplitterTotalReferralsPaid =
  /*#__PURE__*/ createUseReadContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'totalReferralsPaid',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link referralSplitterAbi}__
 */
export const useWriteReferralSplitter = /*#__PURE__*/ createUseWriteContract({
  abi: referralSplitterAbi,
  address: referralSplitterAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"setReferrer"`
 */
export const useWriteReferralSplitterSetReferrer =
  /*#__PURE__*/ createUseWriteContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'setReferrer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"claimReferralRewards"`
 */
export const useWriteReferralSplitterClaimReferralRewards =
  /*#__PURE__*/ createUseWriteContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'claimReferralRewards',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link referralSplitterAbi}__
 */
export const useSimulateReferralSplitter =
  /*#__PURE__*/ createUseSimulateContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"setReferrer"`
 */
export const useSimulateReferralSplitterSetReferrer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'setReferrer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link referralSplitterAbi}__ and `functionName` set to `"claimReferralRewards"`
 */
export const useSimulateReferralSplitterClaimReferralRewards =
  /*#__PURE__*/ createUseSimulateContract({
    abi: referralSplitterAbi,
    address: referralSplitterAddress,
    functionName: 'claimReferralRewards',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link revenueDistributorAbi}__
 */
export const useReadRevenueDistributor = /*#__PURE__*/ createUseReadContract({
  abi: revenueDistributorAbi,
  address: revenueDistributorAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"pendingETH"`
 */
export const useReadRevenueDistributorPendingEth =
  /*#__PURE__*/ createUseReadContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'pendingETH',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"totalDistributed"`
 */
export const useReadRevenueDistributorTotalDistributed =
  /*#__PURE__*/ createUseReadContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'totalDistributed',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"totalClaimed"`
 */
export const useReadRevenueDistributorTotalClaimed =
  /*#__PURE__*/ createUseReadContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'totalClaimed',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"epochCount"`
 */
export const useReadRevenueDistributorEpochCount =
  /*#__PURE__*/ createUseReadContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'epochCount',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link revenueDistributorAbi}__
 */
export const useWriteRevenueDistributor = /*#__PURE__*/ createUseWriteContract({
  abi: revenueDistributorAbi,
  address: revenueDistributorAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"claim"`
 */
export const useWriteRevenueDistributorClaim =
  /*#__PURE__*/ createUseWriteContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'claim',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"claimUpTo"`
 */
export const useWriteRevenueDistributorClaimUpTo =
  /*#__PURE__*/ createUseWriteContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'claimUpTo',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link revenueDistributorAbi}__
 */
export const useSimulateRevenueDistributor =
  /*#__PURE__*/ createUseSimulateContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"claim"`
 */
export const useSimulateRevenueDistributorClaim =
  /*#__PURE__*/ createUseSimulateContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'claim',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link revenueDistributorAbi}__ and `functionName` set to `"claimUpTo"`
 */
export const useSimulateRevenueDistributorClaimUpTo =
  /*#__PURE__*/ createUseSimulateContract({
    abi: revenueDistributorAbi,
    address: revenueDistributorAddress,
    functionName: 'claimUpTo',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__
 */
export const useReadSwapFeeRouter = /*#__PURE__*/ createUseReadContract({
  abi: swapFeeRouterAbi,
  address: swapFeeRouterAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"feeBps"`
 */
export const useReadSwapFeeRouterFeeBps = /*#__PURE__*/ createUseReadContract({
  abi: swapFeeRouterAbi,
  address: swapFeeRouterAddress,
  functionName: 'feeBps',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"totalETHFees"`
 */
export const useReadSwapFeeRouterTotalEthFees =
  /*#__PURE__*/ createUseReadContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'totalETHFees',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"totalSwaps"`
 */
export const useReadSwapFeeRouterTotalSwaps =
  /*#__PURE__*/ createUseReadContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'totalSwaps',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"getEffectiveFeeBps"`
 */
export const useReadSwapFeeRouterGetEffectiveFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'getEffectiveFeeBps',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"premiumDiscountBps"`
 */
export const useReadSwapFeeRouterPremiumDiscountBps =
  /*#__PURE__*/ createUseReadContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'premiumDiscountBps',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__
 */
export const useWriteSwapFeeRouter = /*#__PURE__*/ createUseWriteContract({
  abi: swapFeeRouterAbi,
  address: swapFeeRouterAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactETHForTokens"`
 */
export const useWriteSwapFeeRouterSwapExactEthForTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactETHForTokens',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForETH"`
 */
export const useWriteSwapFeeRouterSwapExactTokensForEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForTokens"`
 */
export const useWriteSwapFeeRouterSwapExactTokensForTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForTokens',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactETHForTokensSupportingFeeOnTransferTokens"`
 */
export const useWriteSwapFeeRouterSwapExactEthForTokensSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForETHSupportingFeeOnTransferTokens"`
 */
export const useWriteSwapFeeRouterSwapExactTokensForEthSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForTokensSupportingFeeOnTransferTokens"`
 */
export const useWriteSwapFeeRouterSwapExactTokensForTokensSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__
 */
export const useSimulateSwapFeeRouter = /*#__PURE__*/ createUseSimulateContract(
  { abi: swapFeeRouterAbi, address: swapFeeRouterAddress },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactETHForTokens"`
 */
export const useSimulateSwapFeeRouterSwapExactEthForTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactETHForTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForETH"`
 */
export const useSimulateSwapFeeRouterSwapExactTokensForEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForTokens"`
 */
export const useSimulateSwapFeeRouterSwapExactTokensForTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactETHForTokensSupportingFeeOnTransferTokens"`
 */
export const useSimulateSwapFeeRouterSwapExactEthForTokensSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForETHSupportingFeeOnTransferTokens"`
 */
export const useSimulateSwapFeeRouterSwapExactTokensForEthSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link swapFeeRouterAbi}__ and `functionName` set to `"swapExactTokensForTokensSupportingFeeOnTransferTokens"`
 */
export const useSimulateSwapFeeRouterSwapExactTokensForTokensSupportingFeeOnTransferTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: swapFeeRouterAbi,
    address: swapFeeRouterAddress,
    functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__
 */
export const useReadTegridyDropV2 = /*#__PURE__*/ createUseReadContract({
  abi: tegridyDropV2Abi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"currentPrice"`
 */
export const useReadTegridyDropV2CurrentPrice =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'currentPrice',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"totalSupply"`
 */
export const useReadTegridyDropV2TotalSupply =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'totalSupply',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"maxSupply"`
 */
export const useReadTegridyDropV2MaxSupply =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'maxSupply',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"mintPhase"`
 */
export const useReadTegridyDropV2MintPhase =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'mintPhase',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"merkleRoot"`
 */
export const useReadTegridyDropV2MerkleRoot =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'merkleRoot',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"mintPrice"`
 */
export const useReadTegridyDropV2MintPrice =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'mintPrice',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"maxPerWallet"`
 */
export const useReadTegridyDropV2MaxPerWallet =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'maxPerWallet',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"owner"`
 */
export const useReadTegridyDropV2Owner = /*#__PURE__*/ createUseReadContract({
  abi: tegridyDropV2Abi,
  functionName: 'owner',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"creator"`
 */
export const useReadTegridyDropV2Creator = /*#__PURE__*/ createUseReadContract({
  abi: tegridyDropV2Abi,
  functionName: 'creator',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"paidPerWallet"`
 */
export const useReadTegridyDropV2PaidPerWallet =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'paidPerWallet',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"mintedPerWallet"`
 */
export const useReadTegridyDropV2MintedPerWallet =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'mintedPerWallet',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"revealed"`
 */
export const useReadTegridyDropV2Revealed = /*#__PURE__*/ createUseReadContract(
  { abi: tegridyDropV2Abi, functionName: 'revealed' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"paused"`
 */
export const useReadTegridyDropV2Paused = /*#__PURE__*/ createUseReadContract({
  abi: tegridyDropV2Abi,
  functionName: 'paused',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"contractURI"`
 */
export const useReadTegridyDropV2ContractUri =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyDropV2Abi,
    functionName: 'contractURI',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"tokenURI"`
 */
export const useReadTegridyDropV2TokenUri = /*#__PURE__*/ createUseReadContract(
  { abi: tegridyDropV2Abi, functionName: 'tokenURI' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__
 */
export const useWriteTegridyDropV2 = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyDropV2Abi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"mint"`
 */
export const useWriteTegridyDropV2Mint = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyDropV2Abi,
  functionName: 'mint',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setContractURI"`
 */
export const useWriteTegridyDropV2SetContractUri =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setContractURI',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMintPhase"`
 */
export const useWriteTegridyDropV2SetMintPhase =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMintPhase',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMerkleRoot"`
 */
export const useWriteTegridyDropV2SetMerkleRoot =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMerkleRoot',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMintPrice"`
 */
export const useWriteTegridyDropV2SetMintPrice =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMintPrice',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMaxPerWallet"`
 */
export const useWriteTegridyDropV2SetMaxPerWallet =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMaxPerWallet',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setBaseURI"`
 */
export const useWriteTegridyDropV2SetBaseUri =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'setBaseURI',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"reveal"`
 */
export const useWriteTegridyDropV2Reveal = /*#__PURE__*/ createUseWriteContract(
  { abi: tegridyDropV2Abi, functionName: 'reveal' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"configureDutchAuction"`
 */
export const useWriteTegridyDropV2ConfigureDutchAuction =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'configureDutchAuction',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"pause"`
 */
export const useWriteTegridyDropV2Pause = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyDropV2Abi,
  functionName: 'pause',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"unpause"`
 */
export const useWriteTegridyDropV2Unpause =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'unpause',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteTegridyDropV2Withdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"cancelSale"`
 */
export const useWriteTegridyDropV2CancelSale =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'cancelSale',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"refund"`
 */
export const useWriteTegridyDropV2Refund = /*#__PURE__*/ createUseWriteContract(
  { abi: tegridyDropV2Abi, functionName: 'refund' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"transferOwnership"`
 */
export const useWriteTegridyDropV2TransferOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"acceptOwnership"`
 */
export const useWriteTegridyDropV2AcceptOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyDropV2Abi,
    functionName: 'acceptOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__
 */
export const useSimulateTegridyDropV2 = /*#__PURE__*/ createUseSimulateContract(
  { abi: tegridyDropV2Abi },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"mint"`
 */
export const useSimulateTegridyDropV2Mint =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'mint',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setContractURI"`
 */
export const useSimulateTegridyDropV2SetContractUri =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setContractURI',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMintPhase"`
 */
export const useSimulateTegridyDropV2SetMintPhase =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMintPhase',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMerkleRoot"`
 */
export const useSimulateTegridyDropV2SetMerkleRoot =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMerkleRoot',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMintPrice"`
 */
export const useSimulateTegridyDropV2SetMintPrice =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMintPrice',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setMaxPerWallet"`
 */
export const useSimulateTegridyDropV2SetMaxPerWallet =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setMaxPerWallet',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"setBaseURI"`
 */
export const useSimulateTegridyDropV2SetBaseUri =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'setBaseURI',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"reveal"`
 */
export const useSimulateTegridyDropV2Reveal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'reveal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"configureDutchAuction"`
 */
export const useSimulateTegridyDropV2ConfigureDutchAuction =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'configureDutchAuction',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"pause"`
 */
export const useSimulateTegridyDropV2Pause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'pause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"unpause"`
 */
export const useSimulateTegridyDropV2Unpause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'unpause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateTegridyDropV2Withdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"cancelSale"`
 */
export const useSimulateTegridyDropV2CancelSale =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'cancelSale',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"refund"`
 */
export const useSimulateTegridyDropV2Refund =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'refund',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"transferOwnership"`
 */
export const useSimulateTegridyDropV2TransferOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyDropV2Abi}__ and `functionName` set to `"acceptOwnership"`
 */
export const useSimulateTegridyDropV2AcceptOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyDropV2Abi,
    functionName: 'acceptOwnership',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyFactoryAbi}__
 */
export const useReadTegridyFactory = /*#__PURE__*/ createUseReadContract({
  abi: tegridyFactoryAbi,
  address: tegridyFactoryAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyFactoryAbi}__ and `functionName` set to `"getPair"`
 */
export const useReadTegridyFactoryGetPair = /*#__PURE__*/ createUseReadContract(
  {
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
    functionName: 'getPair',
  },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyFactoryAbi}__ and `functionName` set to `"allPairsLength"`
 */
export const useReadTegridyFactoryAllPairsLength =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
    functionName: 'allPairsLength',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyFactoryAbi}__ and `functionName` set to `"allPairs"`
 */
export const useReadTegridyFactoryAllPairs =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
    functionName: 'allPairs',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyFactoryAbi}__
 */
export const useWriteTegridyFactory = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyFactoryAbi,
  address: tegridyFactoryAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyFactoryAbi}__ and `functionName` set to `"createPair"`
 */
export const useWriteTegridyFactoryCreatePair =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
    functionName: 'createPair',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyFactoryAbi}__
 */
export const useSimulateTegridyFactory =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyFactoryAbi}__ and `functionName` set to `"createPair"`
 */
export const useSimulateTegridyFactoryCreatePair =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyFactoryAbi,
    address: tegridyFactoryAddress,
    functionName: 'createPair',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__
 */
export const useReadTegridyLaunchpad = /*#__PURE__*/ createUseReadContract({
  abi: tegridyLaunchpadAbi,
  address: tegridyLaunchpadAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__ and `functionName` set to `"getCollection"`
 */
export const useReadTegridyLaunchpadGetCollection =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadAbi,
    address: tegridyLaunchpadAddress,
    functionName: 'getCollection',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__ and `functionName` set to `"getCollectionCount"`
 */
export const useReadTegridyLaunchpadGetCollectionCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadAbi,
    address: tegridyLaunchpadAddress,
    functionName: 'getCollectionCount',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__
 */
export const useWriteTegridyLaunchpad = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyLaunchpadAbi,
  address: tegridyLaunchpadAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__ and `functionName` set to `"createCollection"`
 */
export const useWriteTegridyLaunchpadCreateCollection =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLaunchpadAbi,
    address: tegridyLaunchpadAddress,
    functionName: 'createCollection',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__
 */
export const useSimulateTegridyLaunchpad =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLaunchpadAbi,
    address: tegridyLaunchpadAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLaunchpadAbi}__ and `functionName` set to `"createCollection"`
 */
export const useSimulateTegridyLaunchpadCreateCollection =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLaunchpadAbi,
    address: tegridyLaunchpadAddress,
    functionName: 'createCollection',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__
 */
export const useReadTegridyLaunchpadV2 = /*#__PURE__*/ createUseReadContract({
  abi: tegridyLaunchpadV2Abi,
  address: tegridyLaunchpadV2Address,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"getCollection"`
 */
export const useReadTegridyLaunchpadV2GetCollection =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'getCollection',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"getCollectionCount"`
 */
export const useReadTegridyLaunchpadV2GetCollectionCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'getCollectionCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"getAllCollections"`
 */
export const useReadTegridyLaunchpadV2GetAllCollections =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'getAllCollections',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"dropTemplate"`
 */
export const useReadTegridyLaunchpadV2DropTemplate =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'dropTemplate',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"protocolFeeBps"`
 */
export const useReadTegridyLaunchpadV2ProtocolFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'protocolFeeBps',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__
 */
export const useWriteTegridyLaunchpadV2 = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyLaunchpadV2Abi,
  address: tegridyLaunchpadV2Address,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"createCollection"`
 */
export const useWriteTegridyLaunchpadV2CreateCollection =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'createCollection',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__
 */
export const useSimulateTegridyLaunchpadV2 =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `functionName` set to `"createCollection"`
 */
export const useSimulateTegridyLaunchpadV2CreateCollection =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    functionName: 'createCollection',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__
 */
export const useWatchTegridyLaunchpadV2Event =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `eventName` set to `"CollectionCreated"`
 */
export const useWatchTegridyLaunchpadV2CollectionCreatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    eventName: 'CollectionCreated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link tegridyLaunchpadV2Abi}__ and `eventName` set to `"CollectionCreatedV2"`
 */
export const useWatchTegridyLaunchpadV2CollectionCreatedV2Event =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: tegridyLaunchpadV2Abi,
    address: tegridyLaunchpadV2Address,
    eventName: 'CollectionCreatedV2',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__
 */
export const useReadTegridyLending = /*#__PURE__*/ createUseReadContract({
  abi: tegridyLendingAbi,
  address: tegridyLendingAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"getOffer"`
 */
export const useReadTegridyLendingGetOffer =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'getOffer',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"getLoan"`
 */
export const useReadTegridyLendingGetLoan = /*#__PURE__*/ createUseReadContract(
  {
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'getLoan',
  },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"getRepaymentAmount"`
 */
export const useReadTegridyLendingGetRepaymentAmount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'getRepaymentAmount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"isDefaulted"`
 */
export const useReadTegridyLendingIsDefaulted =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'isDefaulted',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"offerCount"`
 */
export const useReadTegridyLendingOfferCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'offerCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"loanCount"`
 */
export const useReadTegridyLendingLoanCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'loanCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"protocolFeeBps"`
 */
export const useReadTegridyLendingProtocolFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'protocolFeeBps',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__
 */
export const useWriteTegridyLending = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyLendingAbi,
  address: tegridyLendingAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"createLoanOffer"`
 */
export const useWriteTegridyLendingCreateLoanOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'createLoanOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"cancelOffer"`
 */
export const useWriteTegridyLendingCancelOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'cancelOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"acceptOffer"`
 */
export const useWriteTegridyLendingAcceptOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'acceptOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"repayLoan"`
 */
export const useWriteTegridyLendingRepayLoan =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'repayLoan',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"claimDefaultedCollateral"`
 */
export const useWriteTegridyLendingClaimDefaultedCollateral =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'claimDefaultedCollateral',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__
 */
export const useSimulateTegridyLending =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"createLoanOffer"`
 */
export const useSimulateTegridyLendingCreateLoanOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'createLoanOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"cancelOffer"`
 */
export const useSimulateTegridyLendingCancelOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'cancelOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"acceptOffer"`
 */
export const useSimulateTegridyLendingAcceptOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'acceptOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"repayLoan"`
 */
export const useSimulateTegridyLendingRepayLoan =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'repayLoan',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyLendingAbi}__ and `functionName` set to `"claimDefaultedCollateral"`
 */
export const useSimulateTegridyLendingClaimDefaultedCollateral =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyLendingAbi,
    address: tegridyLendingAddress,
    functionName: 'claimDefaultedCollateral',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__
 */
export const useReadTegridyNftLending = /*#__PURE__*/ createUseReadContract({
  abi: tegridyNftLendingAbi,
  address: tegridyNftLendingAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"getOffer"`
 */
export const useReadTegridyNftLendingGetOffer =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'getOffer',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"getLoan"`
 */
export const useReadTegridyNftLendingGetLoan =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'getLoan',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"getRepaymentAmount"`
 */
export const useReadTegridyNftLendingGetRepaymentAmount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'getRepaymentAmount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"offerCount"`
 */
export const useReadTegridyNftLendingOfferCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'offerCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"loanCount"`
 */
export const useReadTegridyNftLendingLoanCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'loanCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"whitelistedCollections"`
 */
export const useReadTegridyNftLendingWhitelistedCollections =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'whitelistedCollections',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"protocolFeeBps"`
 */
export const useReadTegridyNftLendingProtocolFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'protocolFeeBps',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__
 */
export const useWriteTegridyNftLending = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyNftLendingAbi,
  address: tegridyNftLendingAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"createOffer"`
 */
export const useWriteTegridyNftLendingCreateOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'createOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"cancelOffer"`
 */
export const useWriteTegridyNftLendingCancelOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'cancelOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"acceptOffer"`
 */
export const useWriteTegridyNftLendingAcceptOffer =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'acceptOffer',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"repayLoan"`
 */
export const useWriteTegridyNftLendingRepayLoan =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'repayLoan',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"claimDefault"`
 */
export const useWriteTegridyNftLendingClaimDefault =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'claimDefault',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__
 */
export const useSimulateTegridyNftLending =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"createOffer"`
 */
export const useSimulateTegridyNftLendingCreateOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'createOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"cancelOffer"`
 */
export const useSimulateTegridyNftLendingCancelOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'cancelOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"acceptOffer"`
 */
export const useSimulateTegridyNftLendingAcceptOffer =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'acceptOffer',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"repayLoan"`
 */
export const useSimulateTegridyNftLendingRepayLoan =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'repayLoan',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftLendingAbi}__ and `functionName` set to `"claimDefault"`
 */
export const useSimulateTegridyNftLendingClaimDefault =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftLendingAbi,
    address: tegridyNftLendingAddress,
    functionName: 'claimDefault',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__
 */
export const useReadTegridyNftPoolFactory = /*#__PURE__*/ createUseReadContract(
  { abi: tegridyNftPoolFactoryAbi, address: tegridyNftPoolFactoryAddress },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"getPoolsForCollection"`
 */
export const useReadTegridyNftPoolFactoryGetPoolsForCollection =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'getPoolsForCollection',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"getBestBuyPool"`
 */
export const useReadTegridyNftPoolFactoryGetBestBuyPool =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'getBestBuyPool',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"getBestSellPool"`
 */
export const useReadTegridyNftPoolFactoryGetBestSellPool =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'getBestSellPool',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"getPoolCount"`
 */
export const useReadTegridyNftPoolFactoryGetPoolCount =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'getPoolCount',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__
 */
export const useWriteTegridyNftPoolFactory =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"createPool"`
 */
export const useWriteTegridyNftPoolFactoryCreatePool =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'createPool',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__
 */
export const useSimulateTegridyNftPoolFactory =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `functionName` set to `"createPool"`
 */
export const useSimulateTegridyNftPoolFactoryCreatePool =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    functionName: 'createPool',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__
 */
export const useWatchTegridyNftPoolFactoryEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link tegridyNftPoolFactoryAbi}__ and `eventName` set to `"PoolCreated"`
 */
export const useWatchTegridyNftPoolFactoryPoolCreatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: tegridyNftPoolFactoryAbi,
    address: tegridyNftPoolFactoryAddress,
    eventName: 'PoolCreated',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__
 */
export const useReadTegridyRestaking = /*#__PURE__*/ createUseReadContract({
  abi: tegridyRestakingAbi,
  address: tegridyRestakingAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"pendingBonus"`
 */
export const useReadTegridyRestakingPendingBonus =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'pendingBonus',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"pendingBase"`
 */
export const useReadTegridyRestakingPendingBase =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'pendingBase',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"pendingTotal"`
 */
export const useReadTegridyRestakingPendingTotal =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'pendingTotal',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"restakers"`
 */
export const useReadTegridyRestakingRestakers =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'restakers',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"totalRestaked"`
 */
export const useReadTegridyRestakingTotalRestaked =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'totalRestaked',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"totalBonusFunded"`
 */
export const useReadTegridyRestakingTotalBonusFunded =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'totalBonusFunded',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"totalBonusDistributed"`
 */
export const useReadTegridyRestakingTotalBonusDistributed =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'totalBonusDistributed',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"bonusRewardPerSecond"`
 */
export const useReadTegridyRestakingBonusRewardPerSecond =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'bonusRewardPerSecond',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRestakingAbi}__
 */
export const useWriteTegridyRestaking = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyRestakingAbi,
  address: tegridyRestakingAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"restake"`
 */
export const useWriteTegridyRestakingRestake =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'restake',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"unrestake"`
 */
export const useWriteTegridyRestakingUnrestake =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'unrestake',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"claimAll"`
 */
export const useWriteTegridyRestakingClaimAll =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'claimAll',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRestakingAbi}__
 */
export const useSimulateTegridyRestaking =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"restake"`
 */
export const useSimulateTegridyRestakingRestake =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'restake',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"unrestake"`
 */
export const useSimulateTegridyRestakingUnrestake =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'unrestake',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRestakingAbi}__ and `functionName` set to `"claimAll"`
 */
export const useSimulateTegridyRestakingClaimAll =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRestakingAbi,
    address: tegridyRestakingAddress,
    functionName: 'claimAll',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRouterAbi}__
 */
export const useReadTegridyRouter = /*#__PURE__*/ createUseReadContract({
  abi: tegridyRouterAbi,
  address: tegridyRouterAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"getAmountsOut"`
 */
export const useReadTegridyRouterGetAmountsOut =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'getAmountsOut',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"quote"`
 */
export const useReadTegridyRouterQuote = /*#__PURE__*/ createUseReadContract({
  abi: tegridyRouterAbi,
  address: tegridyRouterAddress,
  functionName: 'quote',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"factory"`
 */
export const useReadTegridyRouterFactory = /*#__PURE__*/ createUseReadContract({
  abi: tegridyRouterAbi,
  address: tegridyRouterAddress,
  functionName: 'factory',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"WETH"`
 */
export const useReadTegridyRouterWeth = /*#__PURE__*/ createUseReadContract({
  abi: tegridyRouterAbi,
  address: tegridyRouterAddress,
  functionName: 'WETH',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__
 */
export const useWriteTegridyRouter = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyRouterAbi,
  address: tegridyRouterAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"addLiquidityETH"`
 */
export const useWriteTegridyRouterAddLiquidityEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'addLiquidityETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"addLiquidity"`
 */
export const useWriteTegridyRouterAddLiquidity =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'addLiquidity',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"removeLiquidity"`
 */
export const useWriteTegridyRouterRemoveLiquidity =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'removeLiquidity',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"removeLiquidityETH"`
 */
export const useWriteTegridyRouterRemoveLiquidityEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'removeLiquidityETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactETHForTokens"`
 */
export const useWriteTegridyRouterSwapExactEthForTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactETHForTokens',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactTokensForETH"`
 */
export const useWriteTegridyRouterSwapExactTokensForEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactTokensForETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactTokensForTokens"`
 */
export const useWriteTegridyRouterSwapExactTokensForTokens =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactTokensForTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__
 */
export const useSimulateTegridyRouter = /*#__PURE__*/ createUseSimulateContract(
  { abi: tegridyRouterAbi, address: tegridyRouterAddress },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"addLiquidityETH"`
 */
export const useSimulateTegridyRouterAddLiquidityEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'addLiquidityETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"addLiquidity"`
 */
export const useSimulateTegridyRouterAddLiquidity =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'addLiquidity',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"removeLiquidity"`
 */
export const useSimulateTegridyRouterRemoveLiquidity =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'removeLiquidity',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"removeLiquidityETH"`
 */
export const useSimulateTegridyRouterRemoveLiquidityEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'removeLiquidityETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactETHForTokens"`
 */
export const useSimulateTegridyRouterSwapExactEthForTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactETHForTokens',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactTokensForETH"`
 */
export const useSimulateTegridyRouterSwapExactTokensForEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactTokensForETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyRouterAbi}__ and `functionName` set to `"swapExactTokensForTokens"`
 */
export const useSimulateTegridyRouterSwapExactTokensForTokens =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyRouterAbi,
    address: tegridyRouterAddress,
    functionName: 'swapExactTokensForTokens',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__
 */
export const useReadTegridyStaking = /*#__PURE__*/ createUseReadContract({
  abi: tegridyStakingAbi,
  address: tegridyStakingAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"calculateBoost"`
 */
export const useReadTegridyStakingCalculateBoost =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'calculateBoost',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"votingPowerOf"`
 */
export const useReadTegridyStakingVotingPowerOf =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'votingPowerOf',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"votingPowerAtTimestamp"`
 */
export const useReadTegridyStakingVotingPowerAtTimestamp =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'votingPowerAtTimestamp',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"earned"`
 */
export const useReadTegridyStakingEarned = /*#__PURE__*/ createUseReadContract({
  abi: tegridyStakingAbi,
  address: tegridyStakingAddress,
  functionName: 'earned',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"getPosition"`
 */
export const useReadTegridyStakingGetPosition =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'getPosition',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"positions"`
 */
export const useReadTegridyStakingPositions =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'positions',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"userTokenId"`
 */
export const useReadTegridyStakingUserTokenId =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'userTokenId',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"rewardRate"`
 */
export const useReadTegridyStakingRewardRate =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'rewardRate',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalStaked"`
 */
export const useReadTegridyStakingTotalStaked =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalStaked',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalBoostedStake"`
 */
export const useReadTegridyStakingTotalBoostedStake =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalBoostedStake',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalLocked"`
 */
export const useReadTegridyStakingTotalLocked =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalLocked',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalRewardsFunded"`
 */
export const useReadTegridyStakingTotalRewardsFunded =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalRewardsFunded',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalPenaltiesCollected"`
 */
export const useReadTegridyStakingTotalPenaltiesCollected =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalPenaltiesCollected',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"totalPenaltiesRedistributed"`
 */
export const useReadTegridyStakingTotalPenaltiesRedistributed =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'totalPenaltiesRedistributed',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"unsettledRewards"`
 */
export const useReadTegridyStakingUnsettledRewards =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'unsettledRewards',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"paused"`
 */
export const useReadTegridyStakingPaused = /*#__PURE__*/ createUseReadContract({
  abi: tegridyStakingAbi,
  address: tegridyStakingAddress,
  functionName: 'paused',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"ownerOf"`
 */
export const useReadTegridyStakingOwnerOf = /*#__PURE__*/ createUseReadContract(
  {
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'ownerOf',
  },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"getApproved"`
 */
export const useReadTegridyStakingGetApproved =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'getApproved',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"balanceOf"`
 */
export const useReadTegridyStakingBalanceOf =
  /*#__PURE__*/ createUseReadContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'balanceOf',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__
 */
export const useWriteTegridyStaking = /*#__PURE__*/ createUseWriteContract({
  abi: tegridyStakingAbi,
  address: tegridyStakingAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"stake"`
 */
export const useWriteTegridyStakingStake = /*#__PURE__*/ createUseWriteContract(
  {
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'stake',
  },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteTegridyStakingWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"earlyWithdraw"`
 */
export const useWriteTegridyStakingEarlyWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'earlyWithdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"getReward"`
 */
export const useWriteTegridyStakingGetReward =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'getReward',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"toggleAutoMaxLock"`
 */
export const useWriteTegridyStakingToggleAutoMaxLock =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'toggleAutoMaxLock',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"notifyRewardAmount"`
 */
export const useWriteTegridyStakingNotifyRewardAmount =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'notifyRewardAmount',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"extendLock"`
 */
export const useWriteTegridyStakingExtendLock =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'extendLock',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"emergencyExitPosition"`
 */
export const useWriteTegridyStakingEmergencyExitPosition =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'emergencyExitPosition',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"claimUnsettled"`
 */
export const useWriteTegridyStakingClaimUnsettled =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'claimUnsettled',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"revalidateBoost"`
 */
export const useWriteTegridyStakingRevalidateBoost =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'revalidateBoost',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"approve"`
 */
export const useWriteTegridyStakingApprove =
  /*#__PURE__*/ createUseWriteContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'approve',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__
 */
export const useSimulateTegridyStaking =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"stake"`
 */
export const useSimulateTegridyStakingStake =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'stake',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateTegridyStakingWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"earlyWithdraw"`
 */
export const useSimulateTegridyStakingEarlyWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'earlyWithdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"getReward"`
 */
export const useSimulateTegridyStakingGetReward =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'getReward',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"toggleAutoMaxLock"`
 */
export const useSimulateTegridyStakingToggleAutoMaxLock =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'toggleAutoMaxLock',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"notifyRewardAmount"`
 */
export const useSimulateTegridyStakingNotifyRewardAmount =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'notifyRewardAmount',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"extendLock"`
 */
export const useSimulateTegridyStakingExtendLock =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'extendLock',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"emergencyExitPosition"`
 */
export const useSimulateTegridyStakingEmergencyExitPosition =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'emergencyExitPosition',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"claimUnsettled"`
 */
export const useSimulateTegridyStakingClaimUnsettled =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'claimUnsettled',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"revalidateBoost"`
 */
export const useSimulateTegridyStakingRevalidateBoost =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'revalidateBoost',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link tegridyStakingAbi}__ and `functionName` set to `"approve"`
 */
export const useSimulateTegridyStakingApprove =
  /*#__PURE__*/ createUseSimulateContract({
    abi: tegridyStakingAbi,
    address: tegridyStakingAddress,
    functionName: 'approve',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__
 */
export const useReadToweli = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"allowance"`
 */
export const useReadToweliAllowance = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'allowance',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"balanceOf"`
 */
export const useReadToweliBalanceOf = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'balanceOf',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"decimals"`
 */
export const useReadToweliDecimals = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'decimals',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"symbol"`
 */
export const useReadToweliSymbol = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'symbol',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"totalSupply"`
 */
export const useReadToweliTotalSupply = /*#__PURE__*/ createUseReadContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'totalSupply',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link toweliAbi}__
 */
export const useWriteToweli = /*#__PURE__*/ createUseWriteContract({
  abi: toweliAbi,
  address: toweliAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"approve"`
 */
export const useWriteToweliApprove = /*#__PURE__*/ createUseWriteContract({
  abi: toweliAbi,
  address: toweliAddress,
  functionName: 'approve',
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link toweliAbi}__
 */
export const useSimulateToweli = /*#__PURE__*/ createUseSimulateContract({
  abi: toweliAbi,
  address: toweliAddress,
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link toweliAbi}__ and `functionName` set to `"approve"`
 */
export const useSimulateToweliApprove = /*#__PURE__*/ createUseSimulateContract(
  { abi: toweliAbi, address: toweliAddress, functionName: 'approve' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__
 */
export const useReadVoteIncentives = /*#__PURE__*/ createUseReadContract({
  abi: voteIncentivesAbi,
  address: voteIncentivesAddress,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"epochCount"`
 */
export const useReadVoteIncentivesEpochCount =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'epochCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"currentEpoch"`
 */
export const useReadVoteIncentivesCurrentEpoch =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'currentEpoch',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"epochs"`
 */
export const useReadVoteIncentivesEpochs = /*#__PURE__*/ createUseReadContract({
  abi: voteIncentivesAbi,
  address: voteIncentivesAddress,
  functionName: 'epochs',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"epochBribes"`
 */
export const useReadVoteIncentivesEpochBribes =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'epochBribes',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"getEpochBribeTokens"`
 */
export const useReadVoteIncentivesGetEpochBribeTokens =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'getEpochBribeTokens',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"claimable"`
 */
export const useReadVoteIncentivesClaimable =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'claimable',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"bribeFeeBps"`
 */
export const useReadVoteIncentivesBribeFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'bribeFeeBps',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"pendingFeeBps"`
 */
export const useReadVoteIncentivesPendingFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'pendingFeeBps',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"feeChangeTime"`
 */
export const useReadVoteIncentivesFeeChangeTime =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'feeChangeTime',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"getWhitelistedTokens"`
 */
export const useReadVoteIncentivesGetWhitelistedTokens =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'getWhitelistedTokens',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"whitelistedTokens"`
 */
export const useReadVoteIncentivesWhitelistedTokens =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'whitelistedTokens',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"minBribeAmounts"`
 */
export const useReadVoteIncentivesMinBribeAmounts =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'minBribeAmounts',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"MIN_BRIBE_AMOUNT"`
 */
export const useReadVoteIncentivesMinBribeAmount =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'MIN_BRIBE_AMOUNT',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"BRIBE_RESCUE_DELAY"`
 */
export const useReadVoteIncentivesBribeRescueDelay =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'BRIBE_RESCUE_DELAY',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"epochBribeFirstDeposit"`
 */
export const useReadVoteIncentivesEpochBribeFirstDeposit =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'epochBribeFirstDeposit',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"pendingETHWithdrawals"`
 */
export const useReadVoteIncentivesPendingEthWithdrawals =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'pendingETHWithdrawals',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"pendingTokenWithdrawals"`
 */
export const useReadVoteIncentivesPendingTokenWithdrawals =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'pendingTokenWithdrawals',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"gaugeVotes"`
 */
export const useReadVoteIncentivesGaugeVotes =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'gaugeVotes',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"totalGaugeVotes"`
 */
export const useReadVoteIncentivesTotalGaugeVotes =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'totalGaugeVotes',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"userTotalVotes"`
 */
export const useReadVoteIncentivesUserTotalVotes =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'userTotalVotes',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"VOTE_DEADLINE"`
 */
export const useReadVoteIncentivesVoteDeadline =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'VOTE_DEADLINE',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"commitRevealEnabled"`
 */
export const useReadVoteIncentivesCommitRevealEnabled =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'commitRevealEnabled',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"COMMIT_BOND"`
 */
export const useReadVoteIncentivesCommitBond =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'COMMIT_BOND',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"COMMIT_RATIO_BPS"`
 */
export const useReadVoteIncentivesCommitRatioBps =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'COMMIT_RATIO_BPS',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"commitDeadline"`
 */
export const useReadVoteIncentivesCommitDeadline =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'commitDeadline',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"revealDeadline"`
 */
export const useReadVoteIncentivesRevealDeadline =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'revealDeadline',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"computeCommitHash"`
 */
export const useReadVoteIncentivesComputeCommitHash =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'computeCommitHash',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"voterCommits"`
 */
export const useReadVoteIncentivesVoterCommits =
  /*#__PURE__*/ createUseReadContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'voterCommits',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__
 */
export const useWriteVoteIncentives = /*#__PURE__*/ createUseWriteContract({
  abi: voteIncentivesAbi,
  address: voteIncentivesAddress,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"claimBribes"`
 */
export const useWriteVoteIncentivesClaimBribes =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'claimBribes',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"claimBribesBatch"`
 */
export const useWriteVoteIncentivesClaimBribesBatch =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'claimBribesBatch',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"depositBribe"`
 */
export const useWriteVoteIncentivesDepositBribe =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'depositBribe',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"depositBribeETH"`
 */
export const useWriteVoteIncentivesDepositBribeEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'depositBribeETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"advanceEpoch"`
 */
export const useWriteVoteIncentivesAdvanceEpoch =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'advanceEpoch',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"withdrawPendingETH"`
 */
export const useWriteVoteIncentivesWithdrawPendingEth =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'withdrawPendingETH',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"withdrawPendingToken"`
 */
export const useWriteVoteIncentivesWithdrawPendingToken =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'withdrawPendingToken',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"vote"`
 */
export const useWriteVoteIncentivesVote = /*#__PURE__*/ createUseWriteContract({
  abi: voteIncentivesAbi,
  address: voteIncentivesAddress,
  functionName: 'vote',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"commitVote"`
 */
export const useWriteVoteIncentivesCommitVote =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'commitVote',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"revealVote"`
 */
export const useWriteVoteIncentivesRevealVote =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'revealVote',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"sweepForfeitedBond"`
 */
export const useWriteVoteIncentivesSweepForfeitedBond =
  /*#__PURE__*/ createUseWriteContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'sweepForfeitedBond',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__
 */
export const useSimulateVoteIncentives =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"claimBribes"`
 */
export const useSimulateVoteIncentivesClaimBribes =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'claimBribes',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"claimBribesBatch"`
 */
export const useSimulateVoteIncentivesClaimBribesBatch =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'claimBribesBatch',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"depositBribe"`
 */
export const useSimulateVoteIncentivesDepositBribe =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'depositBribe',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"depositBribeETH"`
 */
export const useSimulateVoteIncentivesDepositBribeEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'depositBribeETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"advanceEpoch"`
 */
export const useSimulateVoteIncentivesAdvanceEpoch =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'advanceEpoch',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"withdrawPendingETH"`
 */
export const useSimulateVoteIncentivesWithdrawPendingEth =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'withdrawPendingETH',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"withdrawPendingToken"`
 */
export const useSimulateVoteIncentivesWithdrawPendingToken =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'withdrawPendingToken',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"vote"`
 */
export const useSimulateVoteIncentivesVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'vote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"commitVote"`
 */
export const useSimulateVoteIncentivesCommitVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'commitVote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"revealVote"`
 */
export const useSimulateVoteIncentivesRevealVote =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'revealVote',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link voteIncentivesAbi}__ and `functionName` set to `"sweepForfeitedBond"`
 */
export const useSimulateVoteIncentivesSweepForfeitedBond =
  /*#__PURE__*/ createUseSimulateContract({
    abi: voteIncentivesAbi,
    address: voteIncentivesAddress,
    functionName: 'sweepForfeitedBond',
  })
