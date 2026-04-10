import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { toast } from 'sonner';
import { COMMUNITY_GRANTS_ABI } from '../lib/contracts';
import { COMMUNITY_GRANTS_ADDRESS } from '../lib/constants';
import { ART } from '../lib/artConfig';
import { shortenAddress, formatTokenAmount } from '../lib/formatting';
import { validateAddress } from '../lib/tokenList';
import { usePageTitle } from '../hooks/usePageTitle';

const STATUS_LABELS = ['Active', 'Approved', 'Rejected', 'Executed', 'Cancelled'];
const STATUS_COLORS = ['text-primary', 'text-success', 'text-danger', 'text-white/50', 'text-white/25'];

export default function GrantsPage() {
  usePageTitle('Governance');
  const { isConnected, address } = useAccount();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const { data: proposalCount, refetch, isLoading: isCountLoading } = useReadContract({
    address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'proposalCount',
  });

  const { data: totalGranted } = useReadContract({
    address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'totalGranted',
  });

  const count = Number(proposalCount ?? 0);

  const toastShownRef = useRef<string | null>(null);

  const handleCreate = () => {
    if (!recipient || !amount || !description) return;
    const validRecipient = validateAddress(recipient);
    if (!validRecipient) { toast.error('Invalid recipient address'); return; }
    writeContract({
      address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'createProposal',
      args: [validRecipient, parseEther(amount), description],
    });
  };

  useEffect(() => {
    if (isSuccess && hash && toastShownRef.current !== hash) {
      toastShownRef.current = hash;
      toast.success('Transaction confirmed');
      refetch();
    }
  }, [isSuccess, hash, refetch]);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.danceNight.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.88) 40%, rgba(0,0,0,0.96) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[700px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-6 flex items-center justify-between" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div>
            <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Governance</h1>
            <p className="text-white/50 text-[14px]">Community proposals &amp; grants — voted by veTOWELI holders</p>
          </div>
          {isConnected && (
            <button onClick={() => setShowCreate(!showCreate)} className="btn-secondary px-4 py-2 text-[13px]">
              {showCreate ? 'Cancel' : 'New Proposal'}
            </button>
          )}
        </motion.div>

        {/* Stats */}
        <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <img src={ART.porchChill.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 65%', opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
          </div>
          <div className="relative z-10 p-6 py-8 flex items-center gap-10">
            <div>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Proposals</p>
              <p className="stat-value text-[28px] text-white">{count}</p>
            </div>
            <div>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Total Granted</p>
              <p className="stat-value text-[28px] text-primary">{totalGranted ? formatTokenAmount(formatEther(totalGranted as bigint), 4) : '0'} ETH</p>
            </div>
            <div>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Treasury</p>
              <p className="stat-value text-[28px] text-success">Active</p>
            </div>
          </div>
        </motion.div>

        {/* Create Proposal */}
        {showCreate && (
          <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
            <div className="absolute inset-0">
              <img src={ART.smokingDuo.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.15 }} />
              <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
            </div>
            <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-3">Create Proposal</h3>
            <div className="space-y-3">
              <div>
                <label className="text-white/40 text-[11px] mb-1 block">Recipient Address</label>
                <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="0x..."
                  className="w-full bg-transparent text-[13px] font-mono text-white outline-none px-3 py-2.5 rounded-lg"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
              </div>
              <div>
                <label className="text-white/40 text-[11px] mb-1 block">Amount (ETH)</label>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.1"
                  className="w-full bg-transparent text-[13px] font-mono text-white outline-none px-3 py-2.5 rounded-lg token-input"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
              </div>
              <div>
                <label className="text-white/40 text-[11px] mb-1 block">Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this grant for?" maxLength={500}
                  rows={3} className="w-full bg-transparent text-[13px] text-white outline-none px-3 py-2.5 rounded-lg resize-none"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
              </div>
              <button onClick={handleCreate} disabled={isPending || isConfirming || !recipient || !amount || !description}
                className="btn-primary w-full py-3 text-[14px] disabled:opacity-35">
                {isPending || isConfirming ? 'Submitting...' : 'Submit Proposal'}
              </button>
            </div>
            </div>
          </motion.div>
        )}

        {/* Proposals List */}
        <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="absolute inset-0">
            <img src={ART.busCrew.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%', opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
          </div>
          <div className="relative z-10">
          {isCountLoading ? (
            <div className="p-10 text-center min-h-[60vh] flex flex-col items-center justify-center">
              <p className="text-white/40 text-[14px] animate-pulse">Loading proposals...</p>
            </div>
          ) : count === 0 ? (
            <div className="p-10 text-center min-h-[60vh] flex flex-col items-center justify-center">
              <p className="text-white/50 text-[22px] mb-3">No proposals yet</p>
              <p className="text-white/30 text-[14px]">Be the first to submit a grant proposal.</p>
            </div>
          ) : (
            <div>
              {Array.from({ length: Math.min(count, 20) }).map((_, i) => {
                const proposalId = count - 1 - i;
                return <ProposalRow key={proposalId} id={proposalId} address={address} />;
              })}
            </div>
          )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function ProposalRow({ id, address }: { id: number; address?: string }) {
  const { data } = useReadContract({
    address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'getProposal',
    args: [BigInt(id)],
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const [lastAction, setLastAction] = useState<'voteFor' | 'voteAgainst' | 'finalize' | null>(null);

  if (!data) return null;
  const [proposer, recipient, amount, description, votesFor, votesAgainst, deadline, status] = data as [string, string, bigint, string, bigint, bigint, bigint, number];

  const isActive = status === 0;
  const isExpired = Date.now() / 1000 > Number(deadline);

  return (
    <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(139,92,246,0.06)' }}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <p className="text-white/80 text-[13px] font-medium mb-0.5">{description}</p>
          <p className="text-white/25 text-[11px]">
            To {shortenAddress(recipient)} &middot; {formatEther(amount)} ETH &middot; By {shortenAddress(proposer)}
          </p>
        </div>
        <span className={`text-[11px] font-semibold ${STATUS_COLORS[status]}`}>{STATUS_LABELS[status]}</span>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-success text-[11px]">For: {formatTokenAmount(formatEther(votesFor), 0)}</span>
        <span className="text-danger text-[11px]">Against: {formatTokenAmount(formatEther(votesAgainst), 0)}</span>

        {isActive && !isExpired && address && (
          <div className="ml-auto flex gap-2">
            <button onClick={() => { setLastAction('voteFor'); writeContract({ address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'voteOnProposal', args: [BigInt(id), true] }); }}
              disabled={isPending || isConfirming} className="text-[11px] text-success hover:opacity-80 cursor-pointer disabled:opacity-40">
              {(isPending || isConfirming) && lastAction === 'voteFor' ? 'Voting...' : 'Vote For'}
            </button>
            <button onClick={() => { setLastAction('voteAgainst'); writeContract({ address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'voteOnProposal', args: [BigInt(id), false] }); }}
              disabled={isPending || isConfirming} className="text-[11px] text-danger hover:opacity-80 cursor-pointer disabled:opacity-40">
              {(isPending || isConfirming) && lastAction === 'voteAgainst' ? 'Voting...' : 'Vote Against'}
            </button>
          </div>
        )}

        {isActive && isExpired && (
          <button onClick={() => { setLastAction('finalize'); writeContract({ address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'finalizeProposal', args: [BigInt(id)] }); }}
            disabled={isPending || isConfirming} className="ml-auto text-[11px] text-primary hover:opacity-80 cursor-pointer disabled:opacity-40">
            {(isPending || isConfirming) && lastAction === 'finalize' ? 'Finalizing...' : 'Finalize'}
          </button>
        )}
      </div>
    </div>
  );
}
