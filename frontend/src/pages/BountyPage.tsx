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

export default function BountyPage() {
  usePageTitle('Bounties');
  const { isConnected } = useAccount();
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('');
  const [days, setDays] = useState('7');
  const [showCreate, setShowCreate] = useState(false);

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
                return <BountyRow key={bountyId} id={bountyId} />;
              })}
            </div>
          )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function BountyRow({ id }: { id: number }) {
  const { data } = useReadContract({
    address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'getBounty',
    args: [BigInt(id)],
  });

  if (!data) return null;
  const [creator, description, reward, deadline, winner, submCount, status] = data as [string, string, bigint, bigint, string, bigint, number, bigint];

  const isOpen = status === 0;
  const daysLeft = Math.max(0, Math.ceil((Number(deadline) - Date.now() / 1000) / 86400));

  return (
    <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(139,92,246,0.06)' }}>
      <div className="flex items-start justify-between mb-1">
        <p className="text-white/80 text-[13px] font-medium flex-1 mr-3">{description}</p>
        <span className={`text-[11px] font-semibold flex-shrink-0 ${STATUS_COLORS[status]}`}>{STATUS_LABELS[status]}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-white/30">
        <span className="stat-value text-success">{formatEther(reward)} ETH</span>
        <span>{Number(submCount)} submissions</span>
        <span>By {shortenAddress(creator)}</span>
        {isOpen && <span>{daysLeft}d left</span>}
        {winner !== '0x0000000000000000000000000000000000000000' && (
          <span className="text-primary">Winner: {shortenAddress(winner)}</span>
        )}
      </div>
    </div>
  );
}
