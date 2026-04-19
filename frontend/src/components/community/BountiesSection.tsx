import { useState, useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, type Address } from 'viem';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { MEME_BOUNTY_BOARD_ADDRESS } from '../../lib/constants';
import { MEME_BOUNTY_BOARD_ABI } from '../../lib/contracts';
import { shortenAddress, formatTimeAgo, formatWei } from '../../lib/formatting';
import { ART } from '../../lib/artConfig';

const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'var(--color-purple-12)';
const STAT_ARTS = [ART.beachVibes, ART.jbChristmas, ART.beachSunset, ART.poolParty];

const STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Open', color: 'text-emerald-400' },
  1: { label: 'Completed', color: 'text-blue-400' },
  2: { label: 'Cancelled', color: 'text-white/70' },
};

export function BountiesSection() {
  const { address } = useAccount();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedBounty, setExpandedBounty] = useState<number | null>(null);
  const [newDescription, setNewDescription] = useState('');
  const [newReward, setNewReward] = useState('');
  const [newDeadlineDays, setNewDeadlineDays] = useState('7');
  const [submitURI, setSubmitURI] = useState('');

  const bbAddr = MEME_BOUNTY_BOARD_ADDRESS as Address;
  const { writeContract, data: txHash, isPending: isSigning } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: bountyCount } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'bountyCount' });
  const { data: totalPosted } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'totalBountiesPosted' });
  const { data: totalPaidOut } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'totalPaidOut' });
  const { data: pendingPayout } = useReadContract({
    address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'pendingPayouts', args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const { data: pendingRefund } = useReadContract({
    address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'pendingRefund', args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const count = bountyCount !== undefined ? Number(bountyCount) : 0;
  const pageSize = Math.min(count, 10);

  const bountyContracts = useMemo(() => {
    const contracts: { address: Address; abi: typeof MEME_BOUNTY_BOARD_ABI; functionName: 'getBounty'; args: [bigint] }[] = [];
    for (let i = count - 1; i >= Math.max(0, count - pageSize); i--) {
      contracts.push({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'getBounty', args: [BigInt(i)] });
    }
    return contracts;
  }, [count, bbAddr, pageSize]);

  const { data: bountyResults } = useReadContracts({ contracts: bountyContracts, query: { enabled: count > 0 } });

  const handleCreate = () => {
    if (!newDescription || !newReward || !newDeadlineDays) return;
    const deadlineSecs = BigInt(Math.floor(Date.now() / 1000) + Number(newDeadlineDays) * 86400);
    writeContract({
      address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'createBounty',
      args: [newDescription, deadlineSecs],
      value: parseEther(newReward),
    });
    toast.info('Creating bounty...');
  };

  const handleSubmit = (bountyId: number) => {
    if (!submitURI) return;
    writeContract({
      address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'submitWork',
      args: [BigInt(bountyId), submitURI],
    });
    toast.info('Submitting work...');
  };

  const handleClaim = (type: 'payout' | 'refund') => {
    writeContract({
      address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI,
      functionName: type === 'payout' ? 'withdrawPayout' : 'withdrawRefund',
    });
  };

  const payoutBig = (pendingPayout as bigint) ?? 0n;
  const refundBig = (pendingRefund as bigint) ?? 0n;

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Bounties Posted', value: totalPosted !== undefined ? Number(totalPosted).toString() : '--' },
          { label: 'Total Paid Out', value: totalPaidOut !== undefined ? `${formatWei(totalPaidOut as bigint, 18, 4)} ETH` : '--' },
          { label: 'Your Pending Payout', value: `${formatWei(payoutBig, 18, 4)} ETH`, highlight: payoutBig > 0n },
          { label: 'Your Pending Refund', value: `${formatWei(refundBig, 18, 4)} ETH`, highlight: refundBig > 0n },
        ].map(({ label, value, highlight }, i) => (
          <div key={label} className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
            <div className="absolute inset-0">
              <img src={STAT_ARTS[i % STAT_ARTS.length].src} alt="" loading="lazy" className="w-full h-full object-cover" />
            </div>
            <div className="relative z-10 p-3">
              <p className="text-[10px] text-white/60 uppercase tracking-wider mb-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{label}</p>
              <p className={`text-sm font-semibold ${highlight ? 'text-emerald-400' : 'text-white'}`} style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Claim Buttons */}
      {(payoutBig > 0n || refundBig > 0n) && (
        <div className="flex gap-2">
          {payoutBig > 0n && (
            <button onClick={() => handleClaim('payout')} disabled={isSigning || isConfirming}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
              Claim {formatWei(payoutBig, 18, 4)} ETH Payout
            </button>
          )}
          {refundBig > 0n && (
            <button onClick={() => handleClaim('refund')} disabled={isSigning || isConfirming}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/25 transition-colors disabled:opacity-40">
              Claim {formatWei(refundBig, 18, 4)} ETH Refund
            </button>
          )}
        </div>
      )}

      {/* Create Bounty */}
      <button onClick={() => setShowCreate(!showCreate)}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: showCreate ? 'rgba(239,68,68,0.1)' : 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))',
          color: showCreate ? '#ef4444' : 'white',
          border: showCreate ? '1px solid rgba(239,68,68,0.3)' : 'none',
        }}>
        {showCreate ? 'Cancel' : 'Create New Bounty'}
      </button>

      {showCreate && (
        <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
          <div className="absolute inset-0">
            <img src={ART.chaosScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>New Meme Bounty</h3>
          <p className="text-[11px] text-white/80" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Fund a bounty with ETH. Community votes on submissions. Winner takes the reward.</p>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Description</label>
            <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Create the best Tegridy Farms meme..." rows={2}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-emerald-500 outline-none transition-colors resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Reward (ETH)</label>
              <input type="number" step="0.01" value={newReward} onChange={(e) => setNewReward(e.target.value)}
                placeholder="0.1" className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Deadline (days)</label>
              <input type="number" value={newDeadlineDays} onChange={(e) => setNewDeadlineDays(e.target.value)}
                placeholder="7" className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors" />
            </div>
          </div>
          <button onClick={handleCreate} disabled={!newDescription || !newReward || isSigning || isConfirming}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))', color: 'white' }}>
            {isSigning ? 'Confirm in Wallet...' : isConfirming ? 'Creating...' : `Post Bounty (${newReward || '0'} ETH)`}
          </button>
          </div>
        </m.div>
      )}

      {/* Bounty List */}
      <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <img src={ART.galleryCollage.src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Active Bounties</h3>
        </div>
        {count === 0 ? (
          <p className="px-5 py-8 text-center text-white/60 text-sm" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>No bounties yet. Post the first one.</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {bountyResults?.map((result, i) => {
              if (!result?.result) return null;
              const [creator, description, reward, deadline, , submCount, status] =
                result.result as [Address, string, bigint, bigint, Address, bigint, number, bigint];
              const bountyId = count - 1 - i;
              const isOpen = status === 0;
              const deadlineNum = Number(deadline);
              const isPastDeadline = deadlineNum > 0 && deadlineNum < Date.now() / 1000;
              const statusInfo = STATUS_LABELS[status] ?? { label: 'Unknown', color: 'text-white/70' };
              const isExpanded = expandedBounty === bountyId;

              return (
                <m.div key={bountyId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="px-5 py-4">
                  <button onClick={() => setExpandedBounty(isExpanded ? null : bountyId)} className="w-full text-left">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] text-white/30 font-mono">#{bountyId}</span>
                          <span className={`text-[11px] font-semibold ${statusInfo.color}`}>{statusInfo.label}</span>
                          <span className="text-[11px] text-white/30">{Number(submCount)} submissions</span>
                        </div>
                        <p className="text-[13px] text-white leading-relaxed line-clamp-2">{description}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[13px] font-semibold text-emerald-400">{formatWei(reward, 18, 4)}</p>
                        <p className="text-[10px] text-white/30">ETH</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] text-white/70 mt-1">
                      <span>By {shortenAddress(creator)}</span>
                      {deadlineNum > 0 && <span>{isPastDeadline ? 'Expired' : `${formatTimeAgo(deadlineNum).replace(' ago', ' left')}`}</span>}
                    </div>
                  </button>

                  {/* Expanded: Submit Work */}
                  {isExpanded && isOpen && !isPastDeadline && (
                    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      className="mt-3 pt-3 border-t border-white/5 space-y-2">
                      <label className="text-[11px] text-white/40 uppercase tracking-wider block">Submit Your Work</label>
                      <div className="flex gap-2">
                        <input type="text" value={submitURI} onChange={(e) => setSubmitURI(e.target.value)}
                          placeholder="Link to your submission (IPFS, URL, etc.)"
                          className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 outline-none transition-colors" />
                        <button onClick={() => handleSubmit(bountyId)} disabled={!submitURI || isSigning || isConfirming}
                          className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
                          Submit
                        </button>
                      </div>
                    </m.div>
                  )}
                </m.div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {/* Contract Link */}
      <div className="text-center pt-2">
        <a href={`https://etherscan.io/address/${MEME_BOUNTY_BOARD_ADDRESS}`} target="_blank" rel="noopener noreferrer"
          className="text-white/30 text-[11px] hover:text-white/70 transition-colors font-mono">
          MemeBountyBoard: {shortenAddress(MEME_BOUNTY_BOARD_ADDRESS)} &#8599;
        </a>
      </div>
    </div>
  );
}
