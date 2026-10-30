import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, LP_FARMING_ADDRESS } from './constants';

// Re-export the ABIs extracted from forge build artifacts.
// See frontend/scripts/extract-missing-abis.mjs — regenerate abi-supplement.ts
// whenever the underlying Solidity contracts change.
export * from './abi-supplement';

// ─── TegridyStaking (Unified Lock + Stake + Boost + Governance + NFT Positions) ───
export const TEGRIDY_STAKING_ABI = [
  // §2.5 (STAKING_LOOK): the claim receipt reads what was actually PAID from
  // this event — under a pool shortfall getReward transfers min(pending, pool)
  // and the tx-log amount is the only honest source (TegridyStaking.sol:411).
  { type: 'event', name: 'RewardPaid', inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'reward', type: 'uint256', indexed: false },
  ] },
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
  // Staking release 1 only (2026-10-18): the pot is paid out over four years. The first
  // contract has neither function; read them only through a contract set that says so.
  { type: 'function', name: 'periodFinish', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'REWARDS_DURATION', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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
  // The PAUSED door (`whenPaused`): full principal, no penalty, rewards FORFEITED.
  // emergencyExitPosition above is a different door - expired locks only, and it PAYS.
  { type: 'function', name: 'emergencyWithdrawPosition', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
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
  // Zero until the venue's one-sixth cut is switched on for the pair (TegridyPair.harvest).
  { type: 'function', name: 'kLast', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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
  // The referrer's cut, taken off the top of every fee BEFORE anything reaches
  // the staking distributor (ReferralSplitter.sol:400). Needed by the Farm
  // strip's "Fee Share" chip: SwapFeeRouter.stakerShareBps is 100% *of what
  // arrives*, so quoting it alone overstates what a staker actually receives.
  // Settable up to MAX_REFERRAL_FEE (3000) behind a timelock, so it must be
  // READ, never hardcoded.
  { type: 'function', name: 'referralFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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

// ─── Island lighthouse (vendored canonical Synthetix StakingRewards) ─────────
// The EVM bungalow staking pool: contracts/src/vendor/synthetix-staking-rewards/
// (provenance D8 — verbatim port, so THESE selectors are the canonical set;
// unlike TegridyLPFarming above, balanceOf/totalSupply DO exist here). One ABI,
// deployed per token per chain; addresses live in the bungalow registry.
export const LIGHTHOUSE_STAKING_ABI = [
  { type: 'function', name: 'stake', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getReward', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'exit', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earned', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'periodFinish', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardsDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getRewardForDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // The identity guard (TF-035) reads this to prove a pool really stakes the
  // token the registry claims, before any figure is trusted. It was missing
  // here while present on the LADDER abi, so EvmLighthousePoolLive failed to
  // typecheck and blocked every build. It is a real selector: the vendored
  // StakingRewards declares `IERC20 public stakingToken` (line 28), and a
  // public state variable has a getter — so this is an omission from the ABI,
  // not a capability the deployed pools lack.
  { type: 'function', name: 'stakingToken', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

// ─── Island lighthouse LADDER (contracts/src/LighthouseLadder.sol) ───────────
// The locked build that supersedes the plain StakingRewards pools: 0d..4y
// locks, 1.00x..4.00x boost, an early exit the card reads from the pool (the live
// six answer a flat EARLY_EXIT_PENALTY_BPS of 25%; the ladder's-law build answers
// MAX_EARLY_EXIT_PENALTY_BPS and quotes penaltyFor per position), an always-open emergency
// hatch, and reward payouts capped at balanceOf(pool) - totalSupply() so a
// payout can never spend principal. `withdraw` is deliberately NOT the
// canonical selector here — it takes a position id, not an amount, and reusing
// the name would have been a silent meaning change (a design-review finding).
export const LIGHTHOUSE_LADDER_ABI = [
  { type: 'function', name: 'stake', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'duration', type: 'uint256' }], outputs: [{ name: 'id', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdrawPosition', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earlyExit', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'emergencyWithdraw', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getReward', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'earned', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalBoosted', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'boostedBalanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // The honest vault figure, straight from the contract: what it can pay
  // without touching principal.
  { type: 'function', name: 'rewardSurplus', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'boostFor', inputs: [{ name: 'duration', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'positionsOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'positions', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }, { name: 'lockEnd', type: 'uint64' }, { name: 'amount', type: 'uint256' }, { name: 'boosted', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'periodFinish', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardsDuration', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'stakingToken', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'rewardsToken', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_LOCK_DURATION', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'EARLY_EXIT_PENALTY_BPS', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_EARLY_EXIT_PENALTY_BPS', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'penaltyFor', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'lockEnd', type: 'uint64' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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
  // Admin setters. setMerkleRoot, setMintPrice and configureDutchAuction are not
  // here: the contract (deployed template and source alike) reverts on all three.
  // Those changes go through a 24-hour propose / execute / cancel.
  { type: 'function', name: 'setMintPhase', inputs: [{ name: 'phase', type: 'uint8' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setMaxPerWallet', inputs: [{ name: 'max', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setBaseURI', inputs: [{ name: 'uri', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'reveal', inputs: [{ name: 'revealURI', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'proposeMintPrice', inputs: [{ name: 'newPrice', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeMintPrice', inputs: [{ name: 'expectedPrice', type: 'uint256' }, { name: 'expectedExecuteAfter', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelMintPrice', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingMintPrice', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'proposeDutchAuction', inputs: [
    { name: 'startPrice', type: 'uint256' },
    { name: 'endPrice', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeDutchAuction', inputs: [
    { name: 'expectedStartPrice', type: 'uint256' },
    { name: 'expectedEndPrice', type: 'uint256' },
    { name: 'expectedStartTime', type: 'uint256' },
    { name: 'expectedDuration', type: 'uint256' },
    { name: 'expectedExecuteAfter', type: 'uint256' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelDutchAuction', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingDutchConfig', inputs: [], outputs: [
    { name: 'startPrice', type: 'uint256' },
    { name: 'endPrice', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'proposeMerkleRoot', inputs: [{ name: 'newRoot', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'executeMerkleRoot', inputs: [{ name: 'expectedRoot', type: 'bytes32' }, { name: 'expectedExecuteAfter', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelMerkleRoot', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pendingMerkleRoot', inputs: [], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'proposalExecuteAfter', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Only on the template with the 2026-10-14 fixes (lib/dropRules.ts tells which one a drop runs).
  { type: 'function', name: 'fixedPriceNeedsProposal', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
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

export const ERC721_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setApprovalForAll', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isApprovedForAll', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getApproved', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
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
