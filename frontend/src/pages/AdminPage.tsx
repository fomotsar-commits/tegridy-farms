import { useMemo, useEffect, useState } from 'react';
import { useAccount, useChains, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { usePageTitle } from '../hooks/usePageTitle';
import { ART } from '../lib/artConfig';
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

const PAUSE_ABI = [
  { type: 'function', name: 'pause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unpause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
] as const;

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface ContractCardProps {
  name: string;
  address: string;
  explorerBaseUrl: string;
  items: { label: string; value: string }[];
}

function ContractCard({ name, address, explorerBaseUrl, items }: ContractCardProps) {
  return (
    <div className="glass-card p-6 rounded-2xl space-y-4">
      <div>
        <h2 className="heading-luxury text-white text-[20px] tracking-tight">{name}</h2>
        <a
          href={`${explorerBaseUrl}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-white hover:text-white transition-colors font-mono"
        >
          {shortenAddress(address)}
        </a>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between items-center">
            <span className="text-sm text-white">{item.label}</span>
            <span className="stat-value text-sm text-white font-mono">{item.value}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-white italic">
        Pending timelock operations are managed via direct contract interaction.
      </p>
    </div>
  );
}

function PauseControls({ isPaused }: { isPaused: boolean }) {
  const { writeContract, data: txHash, isPending: isSigning } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  // Audit H-F7: typed-input confirmation before destructive toggle. A single misclick
  // on this button pauses staking / withdrawals / claims for every user — that must
  // require explicit intent, not a pointer landing in the wrong place.
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const expected = isPaused ? 'UNPAUSE' : 'PAUSE';

  useEffect(() => {
    if (isSuccess) {
      toast.success(isPaused ? 'Contract unpaused' : 'Contract paused');
      setConfirming(false);
      setTyped('');
    }
  }, [isSuccess, isPaused]);

  const handleConfirm = () => {
    if (typed.trim().toUpperCase() !== expected) return;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: PAUSE_ABI,
      functionName: isPaused ? 'unpause' : 'pause',
    });
  };

  return (
    <div className="glass-card p-6 rounded-2xl">
      <h2 className="heading-luxury text-white text-[20px] tracking-tight mb-2">Emergency Controls</h2>
      <p className="text-white/60 text-sm mb-4">
        Pause or unpause the TegridyStaking contract. When paused, staking, withdrawals, and claims are disabled.
      </p>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
          <span className={`text-sm font-semibold ${isPaused ? 'text-red-400' : 'text-emerald-400'}`}>
            {isPaused ? 'PAUSED' : 'ACTIVE'}
          </span>
        </div>
        {!confirming ? (
          <button
            onClick={() => { setConfirming(true); setTyped(''); }}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: isPaused
                ? 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))'
                : 'linear-gradient(135deg, rgb(239 68 68), rgb(185 28 28))',
              color: 'white',
            }}
          >
            {isPaused ? 'Unpause Contract' : 'Pause Contract'}
          </button>
        ) : (
          <button
            onClick={() => { setConfirming(false); setTyped(''); }}
            className="text-[12px] text-white/60 hover:text-white transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
      {confirming && (
        <div className="mt-4 p-4 rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <p className="text-[13px] text-red-400 font-semibold mb-2">
            {isPaused ? 'Unpause the contract?' : 'Pause the contract?'}
          </p>
          <p className="text-[12px] text-white/70 mb-3">
            {isPaused
              ? 'Resuming the contract will immediately allow staking, withdrawals, and claims again.'
              : 'Pausing will immediately halt staking, withdrawals, and claims for every user. Do not do this without coordinating with the team.'}
            {' '}Type <span className="font-mono text-white">{expected}</span> to confirm.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={expected}
              autoFocus
              aria-label={`Type ${expected} to confirm`}
              className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:border-red-500 outline-none transition-colors"
            />
            <button
              onClick={handleConfirm}
              disabled={typed.trim().toUpperCase() !== expected || isSigning || isConfirming}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
              style={{
                background: 'linear-gradient(135deg, rgb(239 68 68), rgb(185 28 28))',
                color: 'white',
              }}
            >
              {isSigning ? 'Confirm in Wallet...' : isConfirming ? 'Confirming...' : 'Execute'}
            </button>
          </div>
        </div>
      )}
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
    if (!address || !owner || typeof owner !== 'string') return false;
    return address.toLowerCase() === owner.toLowerCase();
  }, [address, owner]);

  // Chain-aware block explorer URL
  const chains = useChains();
  const explorerBaseUrl = chains[0]?.blockExplorers?.default?.url ?? 'https://etherscan.io';

  // Read contract data (only when owner)
  const { data: contractReads, error: contractReadsError } = useReadContracts({
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
  const safeBigInt = (index: number): bigint | undefined => {
    const v = safe(index);
    return typeof v === 'bigint' ? v : undefined;
  };
  const safeString = (index: number): string | undefined => {
    const v = safe(index);
    return typeof v === 'string' ? v : undefined;
  };

  const feeRouterItems = useMemo(() => {
    const feeBps = safe(0);
    const totalSwaps = safe(1);
    const totalETHFees = safeBigInt(2);
    const pendingFee = safe(3);
    const pendingTreasury = safeString(4);

    return [
      { label: 'Current Fee', value: feeBps != null ? `${Number(feeBps)} bps (${(Number(feeBps) / 100).toFixed(2)}%)` : '...' },
      { label: 'Pending Fee', value: pendingFee != null ? `${Number(pendingFee)} bps` : 'None' },
      { label: 'Pending Treasury', value: pendingTreasury ? shortenAddress(pendingTreasury) : 'None' },
      { label: 'Total Swaps', value: totalSwaps != null ? formatNumber(Number(totalSwaps), 0) : '...' },
      { label: 'Total ETH Fees', value: totalETHFees != null ? `${Number(formatEther(totalETHFees)).toFixed(4)} ETH` : '...' },
    ];
  }, [contractReads]);

  const premiumItems = useMemo(() => {
    const monthlyFee = safeBigInt(5);
    const totalSubs = safe(6);
    const totalRev = safeBigInt(7);

    return [
      { label: 'Monthly Fee', value: monthlyFee != null ? `${formatTokenAmount(Number(formatEther(monthlyFee)))} TOWELI` : '...' },
      { label: 'Total Subscribers', value: totalSubs != null ? formatNumber(Number(totalSubs), 0) : '...' },
      { label: 'Total Revenue', value: totalRev != null ? `${formatTokenAmount(Number(formatEther(totalRev)))} TOWELI` : '...' },
    ];
  }, [contractReads]);

  const stakingItems = useMemo(() => {
    const rewardRate = safeBigInt(8);
    const totalStaked = safeBigInt(9);
    const paused = safe(10);

    return [
      { label: 'Reward Rate', value: rewardRate != null ? `${Number(formatEther(rewardRate)).toFixed(6)}/sec` : '...' },
      { label: 'Total Staked', value: totalStaked != null ? `${formatTokenAmount(Number(formatEther(totalStaked)))} TOWELI` : '...' },
      { label: 'Status', value: paused != null ? (paused ? 'PAUSED' : 'Active') : '...' },
    ];
  }, [contractReads]);

  const lpFarmItems = useMemo(() => {
    const rewardRate = safeBigInt(11);
    const totalSupply = safeBigInt(12);

    return [
      { label: 'Reward Rate', value: rewardRate != null ? `${Number(formatEther(rewardRate)).toFixed(6)}/sec` : '...' },
      { label: 'Total Staked LP', value: totalSupply != null ? `${formatTokenAmount(Number(formatEther(totalSupply)))}` : '...' },
    ];
  }, [contractReads]);

  // Not connected
  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <div className="glass-card p-8 rounded-2xl text-center max-w-md">
            <h1 className="heading-luxury text-2xl text-white mb-3">Admin Panel</h1>
            <p className="text-white text-sm">Connect your wallet to access this page.</p>
          </div>
        </div>
      </div>
    );
  }

  // Loading
  if (ownerLoading) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <div className="glass-card p-8 rounded-2xl text-center max-w-md">
            <h1 className="heading-luxury text-2xl text-white mb-3">Admin Panel</h1>
            <p className="text-white text-sm">Checking authorization...</p>
          </div>
        </div>
      </div>
    );
  }

  // Not owner
  if (!isOwner) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <div className="glass-card p-8 rounded-2xl text-center max-w-md">
            <h1 className="heading-luxury text-2xl text-white mb-3">Not Authorized</h1>
            <p className="text-white text-sm">
              This page is restricted to the contract owner.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12 space-y-8">
        <div>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">
            Admin Dashboard
          </h1>
          <p className="text-white text-sm">
            Timelock overview for all Tegridy Farms contracts.
          </p>
        </div>

        {contractReadsError && (
          <div className="glass-card p-4 rounded-xl border border-red-500/40 bg-red-500/10">
            <p className="text-sm text-red-300">
              Failed to load contract data. {contractReadsError.message || 'Please try again later.'}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <ContractCard
            name="Swap Fee Router"
            address={SWAP_FEE_ROUTER_ADDRESS}
            explorerBaseUrl={explorerBaseUrl}
            items={feeRouterItems}
          />
          <ContractCard
            name="Premium Access"
            address={PREMIUM_ACCESS_ADDRESS}
            explorerBaseUrl={explorerBaseUrl}
            items={premiumItems}
          />
          <ContractCard
            name="Tegridy Staking"
            address={TEGRIDY_STAKING_ADDRESS}
            explorerBaseUrl={explorerBaseUrl}
            items={stakingItems}
          />
          <ContractCard
            name="LP Farming"
            address={LP_FARMING_ADDRESS}
            explorerBaseUrl={explorerBaseUrl}
            items={lpFarmItems}
          />
        </div>

        {/* Pause Controls */}
        <PauseControls isPaused={safe(10) === true} />

        <div className="glass-card p-4 rounded-xl">
          <p className="text-xs text-white text-center">
            Admin panel for contract owner. Manage timelocks via direct contract interaction.
          </p>
        </div>
      </div>
    </div>
  );
}
