import { useState, useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, parseEther, isAddress, type Address } from 'viem';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { COMMUNITY_GRANTS_ADDRESS } from '../../lib/constants';
import { COMMUNITY_GRANTS_ABI } from '../../lib/contracts';
import { shortenAddress, formatTokenAmount, formatTimeAgo } from '../../lib/formatting';

const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'var(--color-purple-12)';

const STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Active', color: 'text-emerald-400' },
  1: { label: 'Passed', color: 'text-blue-400' },
  2: { label: 'Rejected', color: 'text-red-400' },
  3: { label: 'Executed', color: 'text-purple-400' },
  4: { label: 'Cancelled', color: 'text-white/40' },
  5: { label: 'Lapsed', color: 'text-yellow-400' },
};

export function GrantsSection() {
  const { address } = useAccount();
  const [showCreate, setShowCreate] = useState(false);
  const [newRecipient, setNewRecipient] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const gcAddr = COMMUNITY_GRANTS_ADDRESS as Address;
  const { writeContract, data: txHash, isPending: isSigning } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: proposalCount } = useReadContract({
    address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'proposalCount',
  });
  const { data: totalGranted } = useReadContract({
    address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'totalGranted',
  });

  const count = proposalCount !== undefined ? Number(proposalCount) : 0;
  const pageSize = Math.min(count, 10);
  const startIdx = Math.max(0, count - pageSize);

  // Read most recent proposals (up to 10)
  const proposalContracts = useMemo(() => {
    const contracts: { address: Address; abi: typeof COMMUNITY_GRANTS_ABI; functionName: 'getProposal'; args: [bigint] }[] = [];
    for (let i = count - 1; i >= startIdx; i--) {
      contracts.push({ address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'getProposal', args: [BigInt(i)] });
    }
    return contracts;
  }, [count, gcAddr, startIdx]);

  const { data: proposalResults } = useReadContracts({ contracts: proposalContracts, query: { enabled: count > 0 } });

  // Check if user has voted on each proposal
  const voteCheckContracts = useMemo(() => {
    if (!address || count === 0) return [];
    return Array.from({ length: pageSize }, (_, i) => ({
      address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'hasVotedOnProposal' as const,
      args: [BigInt(count - 1 - i), address],
    }));
  }, [address, count, pageSize, gcAddr]);

  const { data: voteChecks } = useReadContracts({ contracts: voteCheckContracts, query: { enabled: voteCheckContracts.length > 0 } });

  const handleVote = (proposalId: number, support: boolean) => {
    writeContract({
      address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'voteOnProposal',
      args: [BigInt(proposalId), support],
    });
    toast.info(support ? 'Voting FOR...' : 'Voting AGAINST...');
  };

  const handleFinalize = (proposalId: number) => {
    writeContract({
      address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'finalizeProposal',
      args: [BigInt(proposalId)],
    });
  };

  // Audit H-F6: validate recipient before coercing to Address and before any parseEther on amount.
  // Without this, user typos ("0xabc", random text) reach the contract call where the only
  // protection is on-chain revert — costing gas and surfacing a cryptic error.
  const recipientInvalid =
    newRecipient.length > 0 && !isAddress(newRecipient);
  let amountInvalid = false;
  if (newAmount.length > 0) {
    try {
      if (parseEther(newAmount) <= 0n) amountInvalid = true;
    } catch {
      amountInvalid = true;
    }
  }
  const canCreate =
    !!newRecipient &&
    !!newAmount &&
    !!newDescription &&
    !recipientInvalid &&
    !amountInvalid;

  const handleCreate = () => {
    if (!newRecipient || !newAmount || !newDescription) return;
    if (!isAddress(newRecipient)) {
      toast.error('Recipient is not a valid Ethereum address');
      return;
    }
    let amt: bigint;
    try {
      amt = parseEther(newAmount);
    } catch {
      toast.error('Amount is not a valid number');
      return;
    }
    if (amt <= 0n) {
      toast.error('Amount must be greater than zero');
      return;
    }
    writeContract({
      address: gcAddr, abi: COMMUNITY_GRANTS_ABI, functionName: 'createProposal',
      args: [newRecipient as Address, amt, newDescription],
    });
    toast.info('Creating proposal...');
  };

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">Total Proposals</p>
          <p className="text-lg font-semibold text-white">{count}</p>
        </div>
        <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">Total Granted</p>
          <p className="text-lg font-semibold text-emerald-400">
            {totalGranted !== undefined ? `${formatTokenAmount(formatEther(totalGranted as bigint), 0)} TOWELI` : '--'}
          </p>
        </div>
      </div>

      {/* Create Proposal Toggle */}
      <button
        onClick={() => setShowCreate(!showCreate)}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: showCreate ? 'rgba(239,68,68,0.1)' : 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))',
          color: showCreate ? '#ef4444' : 'white',
          border: showCreate ? '1px solid rgba(239,68,68,0.3)' : 'none',
          boxShadow: showCreate ? 'none' : '0 4px 15px rgba(16, 185, 129, 0.3)',
        }}
      >
        {showCreate ? 'Cancel' : 'Create New Proposal'}
      </button>

      {/* Create Form */}
      {showCreate && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="rounded-2xl p-5 space-y-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <h3 className="text-sm font-semibold text-white">New Grant Proposal</h3>
          <p className="text-[11px] text-white/70">Requires veTOWELI voting power. Quorum-based approval with 24h execution delay.</p>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Recipient Address</label>
            <input type="text" value={newRecipient} onChange={(e) => setNewRecipient(e.target.value)}
              placeholder="0x..."
              aria-invalid={recipientInvalid}
              className={`w-full bg-black/30 border rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors ${recipientInvalid ? 'border-red-500/60' : 'border-white/10'}`} />
            {recipientInvalid && (
              <p className="mt-1 text-[11px] text-red-400">Not a valid Ethereum address</p>
            )}
          </div>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Amount (TOWELI)</label>
            <input type="number" value={newAmount} onChange={(e) => setNewAmount(e.target.value)}
              placeholder="100000"
              aria-invalid={amountInvalid}
              className={`w-full bg-black/30 border rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors ${amountInvalid ? 'border-red-500/60' : 'border-white/10'}`} />
            {amountInvalid && (
              <p className="mt-1 text-[11px] text-red-400">Enter a positive number</p>
            )}
          </div>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Description</label>
            <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Describe what this grant funds..." rows={3}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-emerald-500 outline-none transition-colors resize-none" />
          </div>
          <button onClick={handleCreate} disabled={!canCreate || isSigning || isConfirming}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))', color: 'white' }}>
            {isSigning ? 'Confirm in Wallet...' : isConfirming ? 'Creating...' : 'Submit Proposal'}
          </button>
        </motion.div>
      )}

      {/* Proposal List */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Proposals</h3>
        </div>
        {count === 0 ? (
          <p className="px-5 py-8 text-center text-white/30 text-sm">No proposals yet. Be the first to create one.</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {proposalResults?.map((result, i) => {
              if (!result?.result) return null;
              const [proposer, recipient, amount, description, votesFor, votesAgainst, deadline, status] =
                result.result as [Address, Address, bigint, string, bigint, bigint, bigint, number];
              const proposalId = count - 1 - i;
              const hasVoted = voteChecks?.[i]?.result as boolean | undefined;
              const isActive = status === 0;
              const deadlineNum = Number(deadline);
              const isPastDeadline = deadlineNum > 0 && deadlineNum < Date.now() / 1000;
              const statusInfo = STATUS_LABELS[status] ?? { label: 'Unknown', color: 'text-white/40' };

              return (
                <motion.div key={proposalId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="px-5 py-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] text-white/30 font-mono">#{proposalId}</span>
                        <span className={`text-[11px] font-semibold ${statusInfo.color}`}>{statusInfo.label}</span>
                      </div>
                      <p className="text-[13px] text-white leading-relaxed line-clamp-2">{description}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-[13px] font-semibold text-emerald-400">{formatTokenAmount(formatEther(amount), 0)}</p>
                      <p className="text-[10px] text-white/30">TOWELI</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-[11px] text-white/40">
                    <span>By {shortenAddress(proposer)}</span>
                    <span>To {shortenAddress(recipient)}</span>
                    {deadlineNum > 0 && <span>{isPastDeadline ? 'Ended' : `Ends ${formatTimeAgo(deadlineNum).replace(' ago', ' left')}`}</span>}
                  </div>
                  {/* Vote Bars */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      {votesFor + votesAgainst > 0n && (
                        <div className="h-full bg-emerald-500 rounded-full"
                          style={{ width: `${Number(votesFor * 100n / (votesFor + votesAgainst))}%` }} />
                      )}
                    </div>
                    <span className="text-[10px] text-emerald-400">{formatTokenAmount(formatEther(votesFor), 0)} For</span>
                    <span className="text-[10px] text-red-400">{formatTokenAmount(formatEther(votesAgainst), 0)} Against</span>
                  </div>
                  {/* Actions */}
                  {isActive && !hasVoted && (
                    <div className="flex gap-2">
                      <button onClick={() => handleVote(proposalId, true)} disabled={isSigning || isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
                        Vote For
                      </button>
                      <button onClick={() => handleVote(proposalId, false)} disabled={isSigning || isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors disabled:opacity-40">
                        Vote Against
                      </button>
                    </div>
                  )}
                  {isActive && hasVoted && (
                    <p className="text-[11px] text-white/30 italic">You have already voted on this proposal</p>
                  )}
                  {isActive && isPastDeadline && (
                    <button onClick={() => handleFinalize(proposalId)} disabled={isSigning || isConfirming}
                      className="w-full py-2 rounded-lg text-[12px] font-semibold bg-purple-500/15 text-purple-400 border border-purple-500/20 hover:bg-purple-500/25 transition-colors disabled:opacity-40">
                      Finalize Proposal
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Contract Link */}
      <div className="text-center pt-2">
        <a href={`https://etherscan.io/address/${COMMUNITY_GRANTS_ADDRESS}`} target="_blank" rel="noopener noreferrer"
          className="text-white/30 text-[11px] hover:text-white/50 transition-colors font-mono">
          CommunityGrants: {shortenAddress(COMMUNITY_GRANTS_ADDRESS)} &#8599;
        </a>
      </div>
    </div>
  );
}
