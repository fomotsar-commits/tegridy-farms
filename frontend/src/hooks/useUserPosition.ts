import { useAccount, useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_FARM_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_FARM_ADDRESS } from '../lib/constants';

export function useUserPosition(pid: bigint, lpTokenAddress: `0x${string}`) {
  const { address } = useAccount();
  const farmAddr = TEGRIDY_FARM_ADDRESS;
  const isDeployed = farmAddr !== '0x0000000000000000000000000000000000000000';
  const enabled = isDeployed && !!address;

  const { data: userInfo, refetch: refetchUserInfo } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'userInfo',
    args: [pid, address!],
    query: { enabled },
  });

  const { data: pendingReward, refetch: refetchPending } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'pendingReward',
    args: [pid, address!],
    query: { enabled, refetchInterval: 10_000 },
  });

  const { data: walletBalance, refetch: refetchBalance } = useReadContract({
    address: lpTokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: lpTokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, farmAddr],
    query: { enabled },
  });

  const stakedAmount = userInfo ? userInfo[0] : 0n;
  const boostedAmount = userInfo ? userInfo[1] : 0n;
  const lockExpiry = userInfo ? Number(userInfo[3]) : 0;
  const boostBps = userInfo ? Number(userInfo[4]) : 0;
  const currentAllowance = allowance ?? 0n;
  const currentWalletBalance = walletBalance ?? 0n;

  const isLocked = lockExpiry > 0 && lockExpiry > Math.floor(Date.now() / 1000);
  const boostMultiplier = boostBps > 0 ? boostBps / 10000 : 1;

  // Check if allowance is sufficient for the user's wallet balance (what they could deposit)
  const needsApproval = currentAllowance < currentWalletBalance && currentWalletBalance > 0n;

  const refetchAll = async () => {
    await Promise.all([
      refetchUserInfo(),
      refetchPending(),
      refetchBalance(),
      refetchAllowance(),
    ]);
  };

  return {
    stakedAmount,
    stakedFormatted: formatEther(stakedAmount),
    pendingReward: pendingReward ?? 0n,
    pendingFormatted: pendingReward ? formatEther(pendingReward) : '0',
    walletBalance: currentWalletBalance,
    walletBalanceFormatted: walletBalance ? formatEther(walletBalance) : '0',
    allowance: currentAllowance,
    needsApproval,
    refetchAll,
    isDeployed,
    isLocked,
    lockExpiry,
    boostMultiplier,
    boostBps,
    boostedAmount,
  };
}
