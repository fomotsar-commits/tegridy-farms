import { useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatTokenAmount, formatNumber } from '../lib/formatting';
import {
  TEGRIDY_STAKING_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, PREMIUM_ACCESS_ADDRESS,
  LP_FARMING_ADDRESS,
} from '../lib/constants';
import {
  TEGRIDY_STAKING_ABI, SWAP_FEE_ROUTER_ABI, PREMIUM_ACCESS_ABI, LP_FARMING_ABI,
} from '../lib/contracts';

// Minimal ABI fragments for owner/admin reads not in the shared ABIs
const OWNER_ABI = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

const PENDING_FEE_ABI = [
  { type: 'function', name: 'pendingFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingTreasury', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface ContractCardProps {
  name: string;
  address: string;
  items: { label: string; value: string }[];
}

function ContractCard({ name, address, items }: ContractCardProps) {
  return (
    <div className="glass-card p-6 rounded-2xl space-y-4">
      <div>
        <h2 className="heading-luxury text-white text-[20px] tracking-tight">{name}</h2>
        <a
          href={`https://etherscan.io/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-white/40 hover:text-primary transition-colors font-mono"
        >
          {shortenAddress(address)}
        </a>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between items-center">
            <span className="text-sm text-white/60">{item.label}</span>
            <span className="stat-value text-sm text-white font-mono">{item.value}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-white/30 italic">
        Pending timelock operations are managed via direct contract interaction.
      </p>
    </div>
  );
}

export default function AdminPage() {
  usePageTitle('Admin');
  const { address, isConnected } = useAccount();

  // Check ownership via TegridyStaking.owner()
  const { data: owner, isLoading: ownerLoading } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: OWNER_ABI,
    functionName: 'owner',
  });

  const isOwner = useMemo(() => {
    if (!address || !owner) return false;
    return address.toLowerCase() === (owner as string).toLowerCase();
  }, [address, owner]);

  // Read contract data (only when owner)
  const { data: contractReads } = useReadContracts({
    contracts: [
      // SwapFeeRouter
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'feeBps' },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalSwaps' },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalETHFees' },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: PENDING_FEE_ABI, functionName: 'pendingFeeBps' },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: PENDING_FEE_ABI, functionName: 'pendingTreasury' },
      // PremiumAccess
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'monthlyFeeToweli' },
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'totalSubscribers' },
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'totalRevenue' },
      // TegridyStaking
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate' },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked' },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'paused' },
      // LP Farming
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardRate' },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalSupply' },
    ],
    query: { enabled: isOwner },
  });

  const safe = (index: number) => contractReads?.[index]?.result;

  const feeRouterItems = useMemo(() => {
    const feeBps = safe(0);
    const totalSwaps = safe(1);
    const totalETHFees = safe(2);
    const pendingFee = safe(3);
    const pendingTreasury = safe(4);

    return [
      { label: 'Current Fee', value: feeBps != null ? `${Number(feeBps)} bps (${(Number(feeBps) / 100).toFixed(2)}%)` : '...' },
      { label: 'Pending Fee', value: pendingFee != null ? `${Number(pendingFee)} bps` : 'None' },
      { label: 'Pending Treasury', value: pendingTreasury ? shortenAddress(pendingTreasury as string) : 'None' },
      { label: 'Total Swaps', value: totalSwaps != null ? formatNumber(Number(totalSwaps), 0) : '...' },
      { label: 'Total ETH Fees', value: totalETHFees != null ? `${Number(formatEther(totalETHFees as bigint)).toFixed(4)} ETH` : '...' },
    ];
  }, [contractReads]);

  const premiumItems = useMemo(() => {
    const monthlyFee = safe(5);
    const totalSubs = safe(6);
    const totalRev = safe(7);

    return [
      { label: 'Monthly Fee', value: monthlyFee != null ? `${formatTokenAmount(Number(formatEther(monthlyFee as bigint)))} TOWELI` : '...' },
      { label: 'Total Subscribers', value: totalSubs != null ? formatNumber(Number(totalSubs), 0) : '...' },
      { label: 'Total Revenue', value: totalRev != null ? `${formatTokenAmount(Number(formatEther(totalRev as bigint)))} TOWELI` : '...' },
    ];
  }, [contractReads]);

  const stakingItems = useMemo(() => {
    const rewardRate = safe(8);
    const totalStaked = safe(9);
    const paused = safe(10);

    return [
      { label: 'Reward Rate', value: rewardRate != null ? `${Number(formatEther(rewardRate as bigint)).toFixed(6)}/sec` : '...' },
      { label: 'Total Staked', value: totalStaked != null ? `${formatTokenAmount(Number(formatEther(totalStaked as bigint)))} TOWELI` : '...' },
      { label: 'Status', value: paused != null ? (paused ? 'PAUSED' : 'Active') : '...' },
    ];
  }, [contractReads]);

  const lpFarmItems = useMemo(() => {
    const rewardRate = safe(11);
    const totalSupply = safe(12);

    return [
      { label: 'Reward Rate', value: rewardRate != null ? `${Number(formatEther(rewardRate as bigint)).toFixed(6)}/sec` : '...' },
      { label: 'Total Staked LP', value: totalSupply != null ? `${formatTokenAmount(Number(formatEther(totalSupply as bigint)))}` : '...' },
    ];
  }, [contractReads]);

  // Not connected
  if (!isConnected) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="glass-card p-8 rounded-2xl text-center max-w-md">
          <h1 className="heading-luxury text-2xl text-white mb-3">Admin Panel</h1>
          <p className="text-white/60 text-sm">Connect your wallet to access this page.</p>
        </div>
      </div>
    );
  }

  // Loading
  if (ownerLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="glass-card p-8 rounded-2xl text-center max-w-md">
          <h1 className="heading-luxury text-2xl text-white mb-3">Admin Panel</h1>
          <p className="text-white/60 text-sm">Checking authorization...</p>
        </div>
      </div>
    );
  }

  // Not owner
  if (!isOwner) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="glass-card p-8 rounded-2xl text-center max-w-md">
          <h1 className="heading-luxury text-2xl text-white mb-3">Not Authorized</h1>
          <p className="text-white/60 text-sm">
            This page is restricted to the contract owner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-10 space-y-8">
      <div>
        <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">
          Admin Dashboard
        </h1>
        <p className="text-white/50 text-sm">
          Timelock overview for all Tegridy Farms contracts.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ContractCard
          name="Swap Fee Router"
          address={SWAP_FEE_ROUTER_ADDRESS}
          items={feeRouterItems}
        />
        <ContractCard
          name="Premium Access"
          address={PREMIUM_ACCESS_ADDRESS}
          items={premiumItems}
        />
        <ContractCard
          name="Tegridy Staking"
          address={TEGRIDY_STAKING_ADDRESS}
          items={stakingItems}
        />
        <ContractCard
          name="LP Farming"
          address={LP_FARMING_ADDRESS}
          items={lpFarmItems}
        />
      </div>

      <div className="glass-card p-4 rounded-xl">
        <p className="text-xs text-white/30 text-center">
          Admin panel for contract owner. Manage timelocks via direct contract interaction.
        </p>
      </div>
    </div>
  );
}
