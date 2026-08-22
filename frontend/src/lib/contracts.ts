import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, VOTE_INCENTIVES_ADDRESS, LP_FARMING_ADDRESS } from './constants';

// Re-export the ABIs extracted from forge build artifacts.
// See frontend/scripts/extract-missing-abis.mjs — regenerate abi-supplement.ts
// whenever the underlying Solidity contracts change.
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
  // earned/getPosition are NOT on the live (EIP-170-golfed) TegridyStaking —
  // call them at STAKING_MONITOR_VIEW_ADDRESS (or the legacy exit contracts),
  // never at TEGRIDY_STAKING_ADDRESS, where they revert with empty returndata.
  { type: 'function', name: 'earned', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPosition', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostBps', type: 'uint256' }, { name: 'lockEnd', type: 'uint256' }, { name: 'lockDuration', type: 'uint256' }, { name: 'autoMaxLock', type: 'bool' }, { name: 'canWithdraw', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'positions', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'boostedAmount', type: 'uint256' }, { name: 'rewardDebt', type: 'int256' }, { name: 'lockEnd', type: 'uint64' }, { name: 'boostBps', type: 'uint16' }, { name: 'lockDuration', type: 'uint32' }, { name: 'autoMaxLock', type: 'bool' }, { name: 'hasJbacBoost', type: 'bool' }, { name: 'stakeTimestamp', type: 'uint64' }], stateMutability: 'view' },
  { type: 'function', name: 'userTokenId', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalStaked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxStakePerUser', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxTotalStaked', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBoostedStake', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // totalLocked() was removed from the deployed contract (2026-05-30 EIP-170
  // golf) — the selector reverts on-chain. Do not re-add.
  { type: 'function', name: 'totalRewardsFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPenaltiesCollected', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Public state var auto-getter (TegridyStaking.sol:268) — needed to compute
  // the true remaining reward pool: balanceOf(staking) - totalStaked - this.
  { type: 'function', name: 'totalUnsettledRewards', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // AUDIT R010: removed phantom `totalPenaltiesRedistributed` view — never
  // existed in `TegridyStaking.sol`. Calling it would have reverted with
  // "function does not exist" and any UI relying on it would have shown 0n
  // forever. Only `totalPenaltiesCollected` is on-chain.
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
  // pendingBonus / pendingBase were golfed off TegridyRestaking (they live on
  // RestakingMonitorView now) and had no call site left — removed rather than
  // re-pointed. pendingTotal is still read by useRestaking, but at
  // TEGRIDY_RESTAKING_ADDRESS, where the selector does not exist; the read is
  // dormant only because that address is still 0x0. Re-point it at the
  // RestakingMonitorView deployment before restaking goes live.
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
  // `transfer` was missing until 2026-08-20, which made the commerce checkout's
  // pay call reference a function its own ABI did not contain — it would have
  // thrown at the wallet and settled nothing. The compiler said so; the repo's
  // solution-file tsconfig meant `tsc --noEmit` was checking zero files and
  // nobody heard it. Standard ERC-20, and the only write path checkout has.
  { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
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
  { type: 'function', name: 'getProposal', inputs: [{ name: '_id', type: 'uint256' }], outputs: [{ name: 'proposer', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'description', type: 'string' }, { name: 'votesFor', type: 'uint256' }, { name: 'votesAgainst', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'snapshotTimestamp', type: 'uint256' }, { name: 'snapshotTotalStake', type: 'uint256' }], stateMutability: 'view' },
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
  { type: 'function', name: 'getBounty', inputs: [{ name: '_id', type: 'uint256' }], outputs: [{ name: 'creator', type: 'address' }, { name: 'description', type: 'string' }, { name: 'reward', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'winner', type: 'address' }, { name: 'submCount', type: 'uint256' }, { name: 'status', type: 'uint8' }], stateMutability: 'view' },
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
  // AUDIT M-6: Fee-on-transfer variants. No outputs (mirror Uniswap V2 Router02 behaviour).
  { type: 'function', name: 'swapExactETHForTokensSupportingFeeOnTransferTokens', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'swapExactTokensForETHSupportingFeeOnTransferTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalETHFees', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // NOTE: totalSwaps() does NOT exist on the deployed router (removed by gas fix
  // G-23 — swap count is derivable from SwapExecuted events via an indexer).
  // Do not re-add: the selector reverts with empty returndata on mainnet.
  // F109: governable fee split — read live so the "100% to stakers" copy can't
  // drift if governance retunes the split (TreasuryPage already reads this).
  { type: 'function', name: 'stakerShareBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getEffectiveFeeBps', inputs: [{ name: 'pairOrToken', type: 'address' }, { name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'premiumDiscountBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // R070: paused() + treasury() surfaced on the Treasury page so users see when
  // fee routing is halted and whether the on-chain treasury matches the address
  // we render. Both are read-only — no new write ABIs added.
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'treasury', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
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
  { type: 'function', name: 'commitVote', inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'commitHash', type: 'bytes32' }, { name: 'power', type: 'uint256' }], outputs: [{ name: 'commitIndex', type: 'uint256' }], stateMutability: 'nonpayable' },
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
  // R075: events used by useWatchContractEvent in useBribes / useGaugeList
  { type: 'event', name: 'BribeDeposited', inputs: [
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'pair', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'epoch', type: 'uint256', indexed: false },
  ], anonymous: false },
  { type: 'event', name: 'BribeDepositedETH', inputs: [
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'pair', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'epoch', type: 'uint256', indexed: false },
  ], anonymous: false },
  { type: 'event', name: 'BribeClaimed', inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'pair', type: 'address', indexed: true },
    { name: 'epoch', type: 'uint256', indexed: false },
  ], anonymous: false },
  { type: 'event', name: 'GaugeVoted', inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'epoch', type: 'uint256', indexed: true },
    { name: 'pair', type: 'address', indexed: true },
    { name: 'power', type: 'uint256', indexed: false },
  ], anonymous: false },
  { type: 'event', name: 'EpochAdvanced', inputs: [
    { name: 'epoch', type: 'uint256', indexed: true },
    { name: 'totalPower', type: 'uint256', indexed: false },
  ], anonymous: false },
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
  // No notifyRewardAmount entry: the deployed farm's signature is
  // (uint256 amount, uint256 duration), not the 1-arg Synthetix one this file
  // used to declare — the wrong selector could only revert. Funding is an
  // operator script action, not a dApp action.
  { type: 'function', name: 'earned', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // No balanceOf entry: the farm tracks rawBalanceOf + effectiveBalanceOf and
  // has never exported a plain balanceOf. Every LP balance read goes through
  // ERC20_ABI against the LP token, so this had no call site — only the
  // potential to acquire one that could not work.
  { type: 'function', name: 'totalRawSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'periodFinish', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardsDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRewardsFunded', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardPerToken', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getRewardForDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lastTimeRewardApplicable', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // F-7 boost surface — required by useLPFarming.refreshBoost + useAutoRefreshBoost.
  { type: 'function', name: 'rawBalanceOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'effectiveBalanceOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'refreshBoost', inputs: [{ name: 'account', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'MIN_STAKE', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const lpFarmingConfig = {
  address: LP_FARMING_ADDRESS,
  abi: LP_FARMING_ABI,
} as const;

// ─── TegridyLending (P2P NFT-Collateralized Lending) ───────────
export const TEGRIDY_LENDING_ABI = [
  { type: 'function', name: 'createLoanOffer', inputs: [{ name: '_aprBps', type: 'uint256' }, { name: '_duration', type: 'uint256' }, { name: '_collateralContract', type: 'address' }, { name: '_minPositionValue', type: 'uint256' }, { name: '_minPositionETHValue', type: 'uint256' }], outputs: [{ name: 'offerId', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'cancelOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptOffer', inputs: [{ name: '_offerId', type: 'uint256' }, { name: '_tokenId', type: 'uint256' }], outputs: [{ name: 'loanId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'repayLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'claimDefaultedCollateral', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [{ name: 'lender', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'duration', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'minPositionValue', type: 'uint256' }, { name: 'minPositionETHValue', type: 'uint256' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
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
  // Mint surface — matches Solidity:
  //   function mint(uint256 quantity, uint256 allowedAmount, bytes32[] calldata proof)
  // AUDIT FIX FE-HIGH-01: prior 2-arg ABI (`mint(uint256,bytes32[])`) had a different
  // 4-byte selector, causing every Drop V2 mint UI call to revert at the dispatcher.
  // The 3rd argument `allowedAmount` is the leaf-encoded per-wallet cap for ALLOWLIST
  // phase (zero for PUBLIC / DUTCH where the merkle proof is unused). Frontend hooks
  // that previously passed only (quantity, proof) MUST be updated to pass
  // (quantity, allowedAmount, proof).
  { type: 'function', name: 'mint', inputs: [{ name: 'quantity', type: 'uint256' }, { name: 'allowedAmount', type: 'uint256' }, { name: 'proof', type: 'bytes32[]' }], outputs: [], stateMutability: 'payable' },
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
  { type: 'function', name: 'swapETHForNFTs', inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'maxTotalCost', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'swapNFTsForETH', inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'minOutput', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // AUDIT FIX FRESH-2026 (NFTPOOL-ROYALTY): `getBuyQuote.inputAmount` is now
  // ROYALTY-INCLUSIVE and `getSellQuote.outputAmount` is now ROYALTY-NET. Same
  // selectors, same tuple shapes — only the numbers moved, and they moved to
  // match what the swap actually charges/pays. So `inputAmount` stays the right
  // thing to send as `msg.value`/`maxTotalCost`, and `outputAmount` stays the
  // right basis for `minOutput`. DO NOT add or subtract a royalty on top of
  // either: read `get{Buy,Sell}QuoteWithRoyalty` below if you need the split.
  { type: 'function', name: 'getBuyQuote', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'inputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSellQuote', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'outputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }], stateMutability: 'view' },
  // Reconciliation views: identical `inputAmount`/`outputAmount` to the two
  // above, plus the ERC-2981 component so a fee breakdown can show it.
  { type: 'function', name: 'getBuyQuoteWithRoyalty', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'inputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'lpFee', type: 'uint256' }, { name: 'royaltyReceiver', type: 'address' }, { name: 'royalty', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSellQuoteWithRoyalty', inputs: [{ name: 'numItems', type: 'uint256' }], outputs: [{ name: 'outputAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'lpFee', type: 'uint256' }, { name: 'royaltyReceiver', type: 'address' }, { name: 'royalty', type: 'uint256' }], stateMutability: 'view' },
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
  { type: 'function', name: 'proposeFeeChange', inputs: [{ name: 'newFee', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeFeeChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelFeeChange', inputs: [], outputs: [], stateMutability: 'nonpayable' },
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
  { type: 'function', name: 'createOffer', inputs: [{ name: '_principal', type: 'uint256' }, { name: '_aprBps', type: 'uint256' }, { name: '_duration', type: 'uint256' }, { name: '_collateralContract', type: 'address' }, { name: '_tokenId', type: 'uint256' }, { name: '_expiry', type: 'uint64' }], outputs: [{ name: 'offerId', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'cancelOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [{ name: 'loanId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'repayLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'claimDefault', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getOffer', inputs: [{ name: '_offerId', type: 'uint256' }], outputs: [{ name: 'lender', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'duration', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getLoan', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'borrower', type: 'address' }, { name: 'lender', type: 'address' }, { name: 'offerId', type: 'uint256' }, { name: 'tokenId', type: 'uint256' }, { name: 'collateralContract', type: 'address' }, { name: 'principal', type: 'uint256' }, { name: 'aprBps', type: 'uint256' }, { name: 'startTime', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'repaid', type: 'bool' }, { name: 'defaultClaimed', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getRepaymentAmount', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: 'total', type: 'uint256' }], stateMutability: 'view' },
  // The deadline the claim path acts on, not the raw one on the loan struct: a
  // contract pause extends it, and the two diverge by exactly that much.
  { type: 'function', name: 'effectiveDeadline', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isDefaulted', inputs: [{ name: '_loanId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'GRACE_PERIOD', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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
    ], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
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
  // R075: gauge add/remove + simple Voted event
  { type: 'event', name: 'GaugeAdded', inputs: [
    { name: 'gauge', type: 'address', indexed: true },
  ], anonymous: false },
  { type: 'event', name: 'GaugeRemoved', inputs: [
    { name: 'gauge', type: 'address', indexed: true },
  ], anonymous: false },
  { type: 'event', name: 'Voted', inputs: [
    { name: 'voter', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'epoch', type: 'uint256', indexed: true },
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

// ─── AirdropFactory (#65) ───────────────────────────────────────
// Reads only, plus the one write the create flow needs. No fee-administration
// entries: proposeClaimFee / executeClaimFee / proposeFeeSink and the pause
// controls are 48h-timelocked owner ceremonies operated by direct contract
// interaction, exactly like the staking/router admin pairs (see the note in
// scripts/extract-missing-abis.mjs). A selector the dApp cannot legitimately
// call is a selector the dApp must not carry.
export const AIRDROP_FACTORY_ABI = [
  { type: 'function', name: 'createCampaign', inputs: [
    { name: 'token', type: 'address' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'fundingAmount', type: 'uint256' },
    { name: 'claimWindow', type: 'uint64' },
  ], outputs: [{ name: 'distributor', type: 'address' }], stateMutability: 'nonpayable' },
  // Read immediately before signing createCampaign and print the result — a landed
  // timelock proposal can move the fee a campaign will snapshot between page load
  // and signature.
  { type: 'function', name: 'currentCampaignFee', inputs: [], outputs: [{ name: 'fee', type: 'uint256' }, { name: 'sink', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'campaignCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'campaignsOf', inputs: [{ name: 'creator', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'campaignsForToken', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  // Provenance for a distributor address arriving from a link or a pasted manifest:
  // false means this factory never bounds-checked its parameters.
  { type: 'function', name: 'isCampaign', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'MIN_CLAIM_WINDOW', inputs: [], outputs: [{ name: '', type: 'uint64' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_CLAIM_WINDOW', inputs: [], outputs: [{ name: '', type: 'uint64' }], stateMutability: 'view' },
  { type: 'event', name: 'CampaignCreated', inputs: [
    { name: 'distributor', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: true },
    { name: 'merkleRoot', type: 'bytes32', indexed: false },
    { name: 'funded', type: 'uint256', indexed: false },
    { name: 'expiresAt', type: 'uint64', indexed: false },
    { name: 'claimFeeWei', type: 'uint256', indexed: false },
    { name: 'feeSink', type: 'address', indexed: false },
  ], anonymous: false },
] as const;

// ─── TegridyAirdropDistributor (one campaign) ───────────────────
// `claim` and `claimWithFee` are siblings, not variants: Solidity forbids widening
// the vendored `claim` to payable, so a fee-bearing campaign is claimable ONLY
// through claimWithFee. The claim surface picks by the campaign's own
// claimFeeWei, never by a cached factory value.
export const AIRDROP_DISTRIBUTOR_ABI = [
  { type: 'function', name: 'claim', inputs: [
    { name: 'index', type: 'uint256' },
    { name: 'account', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'merkleProof', type: 'bytes32[]' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimWithFee', inputs: [
    { name: 'index', type: 'uint256' },
    { name: 'account', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'merkleProof', type: 'bytes32[]' },
  ], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'reclaim', inputs: [], outputs: [{ name: 'amount', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isClaimed', inputs: [{ name: 'index', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'campaignInfo', inputs: [], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'token', type: 'address' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'creator', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'claimsOpen', type: 'bool' },
    { name: 'claimFeeWei', type: 'uint256' },
    { name: 'feeSink', type: 'address' },
    // Live token balance, not a bookkeeping figure. For a fee-on-transfer or
    // rebasing token this is what is actually there, which is not the same as
    // "unclaimed allocation" — never labelled as such.
    { name: 'remaining', type: 'uint256' },
  ]}], stateMutability: 'view' },
  { type: 'function', name: 'merkleRoot', inputs: [], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'token', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── VestingFactory (#28) ───────────────────────────────────────
// Registry reads only. The dashboard shows streams; it does not create them —
// stream creation belongs to the launch wizard's vesting step, which is not this
// surface. No fee-administration or pause entries, same reasoning as the airdrop
// factory above.
export const VESTING_FACTORY_ABI = [
  { type: 'function', name: 'vestingsForBeneficiary', inputs: [{ name: 'beneficiary', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'vestingsForCreator', inputs: [{ name: 'creator', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'vestingsForToken', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'vestingCountForToken', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Cumulative INFLOW per token. Never decreases as beneficiaries release, so it is
  // "total vested to date", never "currently vesting".
  { type: 'function', name: 'totalVestedInflow', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isVesting', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'vestingCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ─── TegridyVestingWallet (one stream) ──────────────────────────
// `release(address)` is permissionless to call and pays owner() — the beneficiary —
// so a third party cranking it can only push vested funds toward the person they
// already belong to. There is no clawback, no revoke and no admin selector to add.
export const VESTING_WALLET_ABI = [
  { type: 'function', name: 'release', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'vestingInfo', inputs: [], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'beneficiary', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'start', type: 'uint256' },
    { name: 'cliff', type: 'uint256' },
    { name: 'end', type: 'uint256' },
    { name: 'balance', type: 'uint256' },
    { name: 'released', type: 'uint256' },
    { name: 'releasable', type: 'uint256' },
    { name: 'locked', type: 'uint256' },
    { name: 'cliffReached', type: 'bool' },
    { name: 'fullyVested', type: 'bool' },
  ]}], stateMutability: 'view' },
  { type: 'function', name: 'declaredToken', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── LaunchLockView (#28 read joiner) ───────────────────────────
// The two `*SourceAvailable` booleans are the honesty contract of this ABI: false
// means NO DATA (rail unset, wrong address, or the call reverted) and every numeric
// field beside it is zero because nothing was read. Rendering that as "0 locked"
// turns an outage into a claim about the token — see the contract's own header note.
export const LAUNCH_LOCK_VIEW_ABI = [
  { type: 'function', name: 'snapshot', inputs: [
    { name: 'token', type: 'address' },
    { name: 'lockOffset', type: 'uint256' },
    { name: 'lockLimit', type: 'uint256' },
  ], outputs: [{ name: 'snap', type: 'tuple', components: [
    { name: 'vestingSourceAvailable', type: 'bool' },
    { name: 'lockSourceAvailable', type: 'bool' },
    { name: 'vestedInflow', type: 'uint256' },
    { name: 'vestingWalletCount', type: 'uint256' },
    { name: 'lockedTotal', type: 'uint256' },
    { name: 'lockedScanned', type: 'uint256' },
    { name: 'earliestUnlockAt', type: 'uint64' },
    { name: 'latestUnlockAt', type: 'uint64' },
    { name: 'activeLockCount', type: 'uint256' },
    // Non-zero means the lock scan is INCOMPLETE and the unlock dates above
    // describe part of the token's locks only.
    { name: 'nextLockOffset', type: 'uint256' },
  ]}], stateMutability: 'view' },
  { type: 'function', name: 'vestingFactory', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'lockVault', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;
