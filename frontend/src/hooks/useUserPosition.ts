import { useAccount, useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

// Dummy address for disabled queries (wagmi needs valid args shape)
const ZERO_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function useUserPosition() {
  const { address } = useAccount();
  const stakingAddr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(stakingAddr);
  const enabled = isDeployed && !!address;
  const userAddr = address ?? ZERO_ADDR;

  // Batch read: tokenId, wallet balance, allowance
  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr] },
      { address: TOWELI_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: TOWELI_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, stakingAddr] },
    ],
    query: { enabled, refetchInterval: 15_000, refetchOnWindowFocus: true },
  });

  const tokenId = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const walletBalance = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const allowance = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);

  // Get position details + earned if user has a staking NFT
  const hasTokenId = tokenId > 0n;
  const { data: posData, refetch: refetchPos } = useReadContracts({
    contracts: [
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasTokenId ? tokenId : 1n] },
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'earned', args: [hasTokenId ? tokenId : 1n] },
    ],
    query: { enabled: enabled && hasTokenId, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const position = (posData?.[0]?.status === 'success'
    ? posData[0].result as readonly [bigint, bigint, bigint, bigint, boolean, boolean]
    : undefined);

  const pendingReward = (posData?.[1]?.status === 'success' ? posData[1].result as bigint : 0n);

  const stakedAmount = position ? position[0] : 0n;
  const boostBps = position ? Number(position[1]) : 0;
  const lockEnd = position ? Number(position[2]) : 0;
  const lockDuration = position ? Number(position[3]) : 0;
  const autoMaxLock = position ? position[4] : false;
  const canWithdraw = position ? position[5] : false;

  const hasPosition = hasTokenId && stakedAmount > 0n;
  const isLocked = lockEnd > 0 && lockEnd > Math.floor(Date.now() / 1000);
  const boostMultiplier = boostBps > 0 ? boostBps / 10000 : 0;
  function needsApproval(amount?: bigint): boolean {
    const required = amount ?? walletBalance;
    return required > 0n && allowance < required;
  }

  const refetchAll = async () => {
    await Promise.all([refetch(), refetchPos()]);
  };

  return {
    tokenId,
    hasPosition,
    stakedAmount,
    stakedFormatted: formatEther(stakedAmount),
    pendingReward,
    pendingFormatted: pendingReward ? formatEther(pendingReward) : '0',
    walletBalance,
    walletBalanceFormatted: formatEther(walletBalance),
    allowance,
    needsApproval,
    boostBps,
    boostMultiplier,
    lockEnd,
    lockDuration,
    isLocked,
    canWithdraw,
    autoMaxLock,
    refetchAll,
    isDeployed,
    isLoading,
  };
}
