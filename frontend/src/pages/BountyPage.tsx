import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { toast } from 'sonner';
import { MEME_BOUNTY_BOARD_ABI } from '../lib/contracts';
import { MEME_BOUNTY_BOARD_ADDRESS } from '../lib/constants';
import { ART } from '../lib/artConfig';
import { shortenAddress, formatTokenAmount } from '../lib/formatting';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import { usePageTitle } from '../hooks/usePageTitle';

const STATUS_LABELS = ['Open', 'Completed', 'Cancelled'];
const STATUS_COLORS = ['text-success', 'text-primary', 'text-white/25'];

/* ------------------------------------------------------------------ */
/*  Withdraw Banner                                                    */
/* ------------------------------------------------------------------ */
function WithdrawBanner() {
  const { address } = useAccount();
  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const { data: payoutRaw, refetch: refetchPayout } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'pendingPayouts',
    args: address ? [address] : undefined,
  });
  const { data: refundRaw, refetch: refetchRefund } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'pendingRefund',
    args: address ? [address] : undefined,
  });

  const payout = payoutRaw ? (payoutRaw as bigint) : 0n;
  const refund = refundRaw ? (refundRaw as bigint) : 0n;

  useEffect(() => {
    if (isSuccess) { refetchPayout(); refetchRefund(); toast.success('Withdrawal confirmed'); }
  }, [isSuccess, refetchPayout, refetchRefund]);

  if (!address || (payout === 0n && refund === 0n)) return null;

  return (
    <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(34,197,94,0.2)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.95)' }} />
      <div className="relative z-10 p-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <p className="text-white text-[14px] font-semibold mb-1">Funds Available</p>
          <div className="flex flex-wrap gap-4 text-[13px]">
            {payout > 0n && <span className="text-success">Payout: {formatTokenAmount(formatEther(payout), 6)} ETH</span>}
            {refund > 0n && <span className="text-primary">Refund: {formatTokenAmount(formatEther(refund), 6)} ETH</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {payout > 0n && (
            <button disabled={isPending || isConfirming} onClick={() => writeContract({
              address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'withdrawPayout',
            })} className="btn-primary px-4 py-2 min-h-[44px] text-[13px] disabled:opacity-35">
              {isPending || isConfirming ? 'Withdrawing...' : 'Withdraw Payout'}
            </button>
          )}
          {refund > 0n && (
            <button disabled={isPending || isConfirming} onClick={() => writeContract({
              address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'withdrawRefund',
            })} className="btn-secondary px-4 py-2 min-h-[44px] text-[13px] disabled:opacity-35">
              {isPending || isConfirming ? 'Withdrawing...' : 'Withdraw Refund'}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Submission Row                                                     */
/* ------------------------------------------------------------------ */
function SubmissionRow({ bountyId, submissionId, onVoted }: { bountyId: number; submissionId: number; onVoted: () => void }) {
  const { address } = useAccount();
  const { data } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'getSubmission',
    args: [BigInt(bountyId), BigInt(submissionId)],
  });
  const { data: hasVoted } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'hasVotedOnBounty',
    args: address ? [BigInt(bountyId), address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });
  const alreadyVoted = hasVoted === true;
  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) { toast.success('Vote recorded'); onVoted(); }
  }, [isSuccess, onVoted]);

  if (!data) return null;
  const [submitter, contentURI, votes] = data as [string, string, bigint];

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-white/50">{shortenAddress(submitter)}</span>
          <span className="text-white/20">|</span>
          <span className="text-white/30">{Number(votes)} vote{Number(votes) !== 1 ? 's' : ''}</span>
        </div>
        <a href={contentURI} target="_blank" rel="noopener noreferrer"
          className="text-primary text-[12px] hover:underline truncate block mt-0.5">
          {contentURI.length > 60 ? contentURI.slice(0, 60) + '...' : contentURI}
        </a>
      </div>
      {alreadyVoted ? (
        <span className="text-[10px] text-white/30 flex-shrink-0">Voted</span>
      ) : (
        <button disabled={isPending || isConfirming} onClick={() => writeContract({
          address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'voteForSubmission',
          args: [BigInt(bountyId), BigInt(submissionId)],
        })} className="btn-secondary px-3 py-1.5 min-h-[36px] text-[11px] flex-shrink-0 disabled:opacity-35">
          {isPending || isConfirming ? '...' : 'Vote'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */
export default function BountyPage() {
  usePageTitle('Bounties');
  const { isConnected } = useAccount();
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('');
  const [days, setDays] = useState('7');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedBounty, setExpandedBounty] = useState<number | null>(null);

  const { showReceipt } = useTransactionReceipt();
  const receiptShownHashRef = useRef<string | null>(null);

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const { data: bountyCount, refetch, isLoading: isCountLoading } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'bountyCount',
  });

  const { data: totalPaid } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'totalPaidOut',
  });

  const count = Number(bountyCount ?? 0);

  const handleCreate = () => {
    if (!description || !reward) return;
    if (parseFloat(reward) < 0.001) { toast.error("Minimum reward is 0.001 ETH"); return; }
    const parsedDays = parseInt(days);
    if (isNaN(parsedDays) || parsedDays <= 0) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + parsedDays * 86400);
    writeContract({
      address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'createBounty',
      args: [description, deadline], value: parseEther(reward),
    });
  };

  useEffect(() => {
    if (isSuccess && hash) {
      toast.success('Bounty transaction confirmed');
      refetch();
      if (receiptShownHashRef.current !== hash) {
        receiptShownHashRef.current = hash;
        showReceipt({
          type: 'bounty',
          data: {
            bountyTitle: description.slice(0, 80) || 'Meme Bounty',
            bountyReward: reward,
            txHash: hash,
          },
        });
      }
    }
  }, [isSuccess, hash, refetch, description, reward, showReceipt]);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.wrestler.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 0%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.88) 40%, rgba(0,0,0,0.96) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[700px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div>
            <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Bounty Board</h1>
            <p className="text-white/50 text-[14px]">Seize the memes of production — get paid for creating</p>
          </div>
          {isConnected && (
            <button onClick={() => setShowCreate(!showCreate)} className="btn-secondary px-4 py-2 min-h-[44px] text-[13px]">
              {showCreate ? 'Cancel' : 'Post Bounty'}
            </button>
          )}
        </motion.div>

        {/* Withdraw Banner */}
        {isConnected && <WithdrawBanner />}

        {/* Stats */}
        <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <img src={ART.beachSunset.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%', opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
          </div>
          <div className="relative z-10 p-6 py-8 flex flex-wrap items-center gap-6 md:gap-10">
            <div>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Bounties</p>
              <p className="stat-value text-[28px] text-white">{count}</p>
            </div>
            <div>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Total Paid</p>
              <p className="stat-value text-[28px] text-success">{totalPaid ? formatTokenAmount(formatEther(totalPaid as bigint), 4) : '0'} ETH</p>
            </div>
          </div>
        </motion.div>

        {/* Create */}
        {showCreate && (
          <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="absolute inset-0">
              <img src={ART.mumuBull.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.15 }} />
              <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
            </div>
            <div className="relative z-10 p-5">
              <h3 className="text-white text-[15px] font-semibold mb-3">Post a Bounty</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-white/40 text-[11px] mb-1 block">What do you need?</label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500}
                    placeholder="Create a meme of Towelie riding Mumu the Bull..." rows={3}
                    className="w-full bg-transparent text-[13px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg resize-none"
                    style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-white/40 text-[11px] mb-1 block">Reward (ETH)</label>
                    <input type="number" inputMode="decimal" value={reward} onChange={e => setReward(e.target.value)} placeholder="0.05"
                      className="w-full bg-transparent text-[13px] font-mono text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
                      style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
                  </div>
                  <div>
                    <label className="text-white/40 text-[11px] mb-1 block">Duration (days)</label>
                    <input type="number" inputMode="decimal" value={days} onChange={e => setDays(e.target.value)} placeholder="7" min="1" max="90"
                      className="w-full bg-transparent text-[13px] font-mono text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
                      style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
                  </div>
                </div>
                <button onClick={handleCreate} disabled={isPending || isConfirming || !description || !reward}
                  className="btn-primary w-full py-3 min-h-[44px] text-[14px] disabled:opacity-35">
                  {isPending || isConfirming ? 'Posting...' : `Post Bounty (${reward || '0'} ETH)`}
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* Bounties */}
        <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="absolute inset-0">
            <img src={ART.boxingRing.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%', opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
          </div>
          <div className="relative z-10">
          {isCountLoading ? (
            <div className="p-10 text-center min-h-[60vh] flex flex-col items-center justify-center">
              <p className="text-white/40 text-[14px] animate-pulse">Loading bounties...</p>
            </div>
          ) : count === 0 ? (
            <div className="p-10 text-center min-h-[60vh] flex flex-col items-center justify-center">
              <p className="text-white/50 text-[22px] mb-3">No bounties yet</p>
              <p className="text-white/30 text-[14px]">Post the first bounty and get the community creating.</p>
            </div>
          ) : (
            <div>
              {Array.from({ length: Math.min(count, 20) }).map((_, i) => {
                const bountyId = count - 1 - i;
                return <BountyRow key={bountyId} id={bountyId} expanded={expandedBounty === bountyId}
                  onToggle={() => setExpandedBounty(expandedBounty === bountyId ? null : bountyId)} />;
              })}
            </div>
          )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Bounty Row                                                         */
/* ------------------------------------------------------------------ */
function BountyRow({ id, expanded, onToggle }: { id: number; expanded: boolean; onToggle: () => void }) {
  const { address } = useAccount();
  const [contentURI, setContentURI] = useState('');

  const { data, refetch: refetchBounty } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'getBounty',
    args: [BigInt(id)],
  });

  const { data: subCountRaw, refetch: refetchSubCount } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'submissionCount',
    args: [BigInt(id)],
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed');
      refetchBounty();
      refetchSubCount();
      setContentURI('');
    }
  }, [isSuccess, refetchBounty, refetchSubCount]);

  if (!data) return null;
  const [creator, description, reward, deadline, winner, _submCount, status] = data as [string, string, bigint, bigint, string, bigint, number, bigint];

  const isOpen = status === 0;
  const nowSec = Date.now() / 1000;
  const deadlineSec = Number(deadline);
  const daysLeft = Number.isFinite(deadlineSec) ? Math.max(0, Math.ceil((deadlineSec - nowSec) / 86400)) : 0;
  const deadlinePassed = Number.isFinite(deadlineSec) ? nowSec >= deadlineSec : true;
  const isCreator = address && creator.toLowerCase() === address.toLowerCase();
  const subCount = Number(subCountRaw ?? _submCount ?? 0);

  return (
    <div style={{ borderBottom: '1px solid rgba(139,92,246,0.06)' }}>
      {/* Header row - clickable */}
      <div className="px-5 py-4 cursor-pointer hover:bg-white/[0.02] transition-colors" onClick={onToggle}>
        <div className="flex items-start justify-between mb-1">
          <p className="text-white/80 text-[13px] font-medium flex-1 mr-3">{description}</p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-[11px] font-semibold ${STATUS_COLORS[status]}`}>{STATUS_LABELS[status]}</span>
            <span className="text-white/20 text-[11px]">{expanded ? '\u25B2' : '\u25BC'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-white/30 flex-wrap">
          <span className="stat-value text-success">{formatEther(reward)} ETH</span>
          <span>{subCount} submission{subCount !== 1 ? 's' : ''}</span>
          <span>By {shortenAddress(creator)}</span>
          {isOpen && !deadlinePassed && <span>{daysLeft}d left</span>}
          {isOpen && deadlinePassed && <span className="text-warning">Deadline passed</span>}
          {winner !== '0x0000000000000000000000000000000000000000' && (
            <span className="text-primary">Winner: {shortenAddress(winner)}</span>
          )}
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="px-5 pb-4 space-y-3">
          {/* Creator actions */}
          {isCreator && isOpen && (
            <div className="flex gap-2">
              {deadlinePassed && (
                <button disabled={isPending || isConfirming} onClick={() => writeContract({
                  address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'completeBounty',
                  args: [BigInt(id)],
                })} className="btn-primary px-4 py-2 min-h-[44px] text-[12px] disabled:opacity-35">
                  {isPending || isConfirming ? 'Completing...' : 'Complete Bounty'}
                </button>
              )}
              <button disabled={isPending || isConfirming} onClick={() => writeContract({
                address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'cancelBounty',
                args: [BigInt(id)],
              })} className="btn-secondary px-4 py-2 min-h-[44px] text-[12px] disabled:opacity-35">
                {isPending || isConfirming ? 'Cancelling...' : 'Cancel Bounty'}
              </button>
            </div>
          )}

          {/* Submit work form */}
          {isOpen && !deadlinePassed && address && (
            <div className="flex gap-2">
              <input type="text" value={contentURI} onChange={e => setContentURI(e.target.value)}
                placeholder="Content URI (IPFS or URL)"
                className="flex-1 bg-transparent text-[13px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
              <button disabled={isPending || isConfirming || !contentURI.trim()} onClick={() => writeContract({
                address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'submitWork',
                args: [BigInt(id), contentURI.trim()],
              })} className="btn-primary px-4 py-2 min-h-[44px] text-[12px] flex-shrink-0 disabled:opacity-35">
                {isPending || isConfirming ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          )}

          {/* Submissions list */}
          {subCount > 0 ? (
            <div className="space-y-2">
              <p className="text-white/40 text-[11px] uppercase tracking-wider">Submissions</p>
              {Array.from({ length: subCount }).map((_, i) => (
                <SubmissionRow key={i} bountyId={id} submissionId={i} onVoted={() => refetchSubCount()} />
              ))}
            </div>
          ) : (
            <p className="text-white/25 text-[12px]">No submissions yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
