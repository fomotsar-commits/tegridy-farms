import { useState, useMemo, useEffect } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { parseEther, type Address } from 'viem';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { MEME_BOUNTY_BOARD_ADDRESS, CHAIN_ID } from '../../lib/constants';
import { MEME_BOUNTY_BOARD_ABI } from '../../lib/contracts';
import { shortenAddress, formatTimeUntil, formatWei } from '../../lib/formatting';
import { pageArt } from '../../lib/artConfig';
import { ArtImg } from '../ArtImg';
// F321: classify wallet-rejection vs revert for the write effect.
import { surfaceTxError } from '../../lib/txErrors';
// R069: user-submitted text + URIs reach the contract verbatim and render
// back to other users. Sanitise on write; allowlist URI scheme; render
// stored content via SafeText to harden against pre-fix payloads.
import { sanitizeUserText, isAllowedSubmissionUri, SUBMISSION_URI_ERROR, DEFAULT_DESCRIPTION_LIMIT } from '../../lib/textSafety';
import { SafeText } from '../ui/SafeText';

const CARD_BORDER = 'var(--color-purple-12)';
const STAT_ARTS = [pageArt('bounties', 0), pageArt('bounties', 1), pageArt('bounties', 2), pageArt('bounties', 3)];

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
  const chainId = useChainId();
  // AUDIT FIX M-8: refuse on wrong chain so the user doesn't burn ETH
  // creating a bounty / submitting / claiming on Sepolia/Base/Arbitrum.
  const _ensureChain = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    return true;
  };
  const { writeContract, data: txHash, isPending: isSigning, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: bountyCount, isLoading: countLoading, refetch: refetchCount } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'bountyCount' });
  const { data: totalPosted, refetch: refetchPosted } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'totalBountiesPosted' });
  const { data: totalPaidOut, refetch: refetchPaidOut } = useReadContract({ address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'totalPaidOut' });
  const { data: pendingPayout, refetch: refetchPayout } = useReadContract({
    address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'pendingPayouts', args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const { data: pendingRefund, refetch: refetchRefund } = useReadContract({
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

  const { data: bountyResults, isLoading: resultsLoading, refetch: refetchBounties } = useReadContracts({ contracts: bountyContracts, query: { enabled: count > 0 } });

  // F326 (T11): separate loading from empty so "No bounties yet" doesn't flash
  // while bountyCount is still in flight.
  const isListLoading = countLoading || bountyCount === undefined || (count > 0 && resultsLoading);

  // F321 (T5): on a confirmed write refetch the bounty list + payout/refund reads
  // so a new bounty, a fresh submission, or a claimed payout reflects immediately
  // without a window refocus. On rejection/revert surface a classified toast.
  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed!');
      refetchCount();
      refetchPosted();
      refetchPaidOut();
      refetchPayout();
      refetchRefund();
      refetchBounties();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      if (writeError) surfaceTxError(writeError, toast, { component: 'BountiesSection' });
      else toast.error('Transaction failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetchCount, refetchPosted, refetchPaidOut, refetchPayout, refetchRefund, refetchBounties, reset]);

  const handleCreate = () => {
    // T7 fix: gate on a connected account before touching state. Disconnected,
    // useChainId() returns the default (mainnet === CHAIN_ID) so _ensureChain()
    // alone passes; without this the form-clear below would wipe input on a
    // guaranteed-failing write.
    if (!address) { toast.error('Connect your wallet first'); return; }
    if (!_ensureChain()) return;
    if (!newDescription || !newReward || !newDeadlineDays) return;
    // R069: strip BiDi/control chars + cap length client-side. Defence-in-depth
    // before the on-chain calldata.
    const clean = sanitizeUserText(newDescription);
    if (!clean) {
      toast.error('Description cannot be empty');
      return;
    }
    // F330: parseEther throws on exponent notation ("1e5") that number inputs
    // permit — guard it so the click handler doesn't throw uncaught. Mirrors
    // GrantsSection's validation.
    let rewardWei: bigint;
    try {
      rewardWei = parseEther(newReward);
    } catch {
      toast.error('Reward is not a valid ETH amount');
      return;
    }
    if (rewardWei <= 0n) {
      toast.error('Reward must be greater than zero');
      return;
    }
    // F330: a 0/negative deadline produces an in-past timestamp that reverts
    // on-chain after gas. "0" is truthy so the guard above doesn't catch it.
    const deadlineDays = Number(newDeadlineDays);
    if (!Number.isFinite(deadlineDays) || deadlineDays < 1) {
      toast.error('Deadline must be at least 1 day');
      return;
    }
    const deadlineSecs = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86400);
    writeContract({
      chainId: CHAIN_ID,
      address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'createBounty',
      args: [clean, deadlineSecs],
      value: rewardWei,
    });
    // F321: clear the form on submit; the success effect confirms + refetches.
    setNewDescription('');
    setNewReward('');
    setNewDeadlineDays('7');
    setShowCreate(false);
  };

  const handleSubmit = (bountyId: number) => {
    if (!address) { toast.error('Connect your wallet first'); return; }
    if (!submitURI) return;
    // R069: enforce https/ipfs/ar — no data:/javascript:/file:.
    if (!isAllowedSubmissionUri(submitURI)) {
      toast.error(SUBMISSION_URI_ERROR);
      return;
    }
    if (!_ensureChain()) return;
    writeContract({
      chainId: CHAIN_ID,
      address: bbAddr, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'submitWork',
      args: [BigInt(bountyId), submitURI.trim()],
    });
    // F321: clear the submission field on submit; the success effect confirms
    // + refetches the bounty list so the new submission count appears.
    setSubmitURI('');
  };

  const submitURIInvalid = submitURI.length > 0 && !isAllowedSubmissionUri(submitURI);
  const descriptionRemaining = DEFAULT_DESCRIPTION_LIMIT - newDescription.length;

  // F330: derive create-form validity so the submit button is disabled on
  // invalid reward ("1e5", 0) or deadline (0/negative) rather than throwing
  // or reverting on click.
  let rewardInvalid = false;
  if (newReward.length > 0) {
    try {
      if (parseEther(newReward) <= 0n) rewardInvalid = true;
    } catch {
      rewardInvalid = true;
    }
  }
  const deadlineInvalid =
    newDeadlineDays.length > 0 && !(Number(newDeadlineDays) >= 1);
  const canCreate =
    !!newDescription && !!newReward && !rewardInvalid && !deadlineInvalid;

  const handleClaim = (type: 'payout' | 'refund') => {
    if (!address) { toast.error('Connect your wallet first'); return; }
    if (!_ensureChain()) return;
    writeContract({
      chainId: CHAIN_ID,
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
              <img src={STAT_ARTS[i % STAT_ARTS.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
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
            <button onClick={() => handleClaim('payout')} disabled={!address || isSigning || isConfirming}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
              Claim {formatWei(payoutBig, 18, 4)} ETH Payout
            </button>
          )}
          {refundBig > 0n && (
            <button onClick={() => handleClaim('refund')} disabled={!address || isSigning || isConfirming}
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
            <ArtImg pageId="bounties" idx={4} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>New Meme Bounty</h3>
          <p className="text-[11px] text-white/80" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Fund a bounty with ETH. Community votes on submissions. Winner takes the reward.</p>
          <div>
            <label htmlFor="bounty-description" className="text-[11px] text-white/70 uppercase tracking-wider block mb-1">Description</label>
            <textarea id="bounty-description" value={newDescription}
              onChange={(e) => setNewDescription(e.target.value.slice(0, DEFAULT_DESCRIPTION_LIMIT))}
              maxLength={DEFAULT_DESCRIPTION_LIMIT}
              placeholder="Create the best Tegridy Farms meme..." rows={2}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-emerald-500 outline-none transition-colors resize-none" />
            <p className={`mt-1 text-[10px] text-right font-mono ${descriptionRemaining < 50 ? 'text-amber-400' : 'text-white/40'}`}>
              {descriptionRemaining} chars remaining
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="bounty-reward" className="text-[11px] text-white/70 uppercase tracking-wider block mb-1">Reward (ETH)</label>
              <input id="bounty-reward" type="number" step="0.01" value={newReward} onChange={(e) => setNewReward(e.target.value)}
                placeholder="0.1"
                aria-invalid={rewardInvalid}
                aria-describedby={rewardInvalid ? 'bounty-reward-error' : undefined}
                className={`w-full bg-black/30 border rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors ${rewardInvalid ? 'border-red-500/60' : 'border-white/10'}`} />
              {rewardInvalid && (
                <p id="bounty-reward-error" role="alert" className="mt-1 text-[11px] text-red-400">Enter a positive ETH amount</p>
              )}
            </div>
            <div>
              <label htmlFor="bounty-deadline" className="text-[11px] text-white/70 uppercase tracking-wider block mb-1">Deadline (days)</label>
              <input id="bounty-deadline" type="number" min="1" value={newDeadlineDays} onChange={(e) => setNewDeadlineDays(e.target.value)}
                placeholder="7"
                aria-invalid={deadlineInvalid}
                aria-describedby={deadlineInvalid ? 'bounty-deadline-error' : undefined}
                className={`w-full bg-black/30 border rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors ${deadlineInvalid ? 'border-red-500/60' : 'border-white/10'}`} />
              {deadlineInvalid && (
                <p id="bounty-deadline-error" role="alert" className="mt-1 text-[11px] text-red-400">At least 1 day</p>
              )}
            </div>
          </div>
          <button onClick={handleCreate} disabled={!address || !canCreate || isSigning || isConfirming}
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
          <ArtImg pageId="bounties" idx={5} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Active Bounties</h3>
        </div>
        {isListLoading ? (
          /* F326 (T11): shape-matching skeleton rows during loading. */
          <div className="divide-y divide-white/[0.04]" role="status" aria-label="Loading bounties">
            {[0, 1, 2].map((i) => (
              <div key={i} className="px-5 py-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="h-4 w-40 rounded bg-white/10 animate-pulse" />
                  <div className="h-4 w-16 rounded bg-white/10 animate-pulse" />
                </div>
                <div className="h-3 w-2/3 rounded bg-white/5 animate-pulse" />
                <div className="h-2 w-full rounded bg-white/5 animate-pulse" />
              </div>
            ))}
            <span className="sr-only">Loading bounties…</span>
          </div>
        ) : count === 0 ? (
          <p className="px-5 py-8 text-center text-white/60 text-sm" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>No bounties yet. Post the first one.</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {bountyResults?.map((result, i) => {
              if (!result?.result) return null;
              const [creator, description, reward, deadline, , submCount, status] =
                result.result as [Address, string, bigint, bigint, Address, bigint, number];
              const bountyId = count - 1 - i;
              const isOpen = status === 0;
              const deadlineNum = Number(deadline);
              const isPastDeadline = deadlineNum > 0 && deadlineNum < Date.now() / 1000;
              const statusInfo = STATUS_LABELS[status] ?? { label: 'Unknown', color: 'text-white/70' };
              const isExpanded = expandedBounty === bountyId;

              return (
                <m.div key={bountyId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="px-5 py-4">
                  {/* F329: row header is a div role="button" (not a <button>) so the
                      SafeText "show more" control inside the description isn't a nested
                      button — invalid HTML + an a11y hazard. Mirrors the gallery card. */}
                  <div role="button" tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedBounty(isExpanded ? null : bountyId)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedBounty(isExpanded ? null : bountyId); } }}
                    className="w-full text-left cursor-pointer">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] text-white/30 font-mono">#{bountyId}</span>
                          <span className={`text-[11px] font-semibold ${statusInfo.color}`}>{statusInfo.label}</span>
                          <span className="text-[11px] text-white/30">{Number(submCount)} submissions</span>
                        </div>
                        <p className="text-[13px] text-white leading-relaxed line-clamp-2">
                          <SafeText value={description} previewChars={180} />
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[13px] font-semibold text-emerald-400">{formatWei(reward, 18, 4)}</p>
                        <p className="text-[10px] text-white/30">ETH</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] text-white/70 mt-1">
                      <span>By {shortenAddress(creator)}</span>
                      {deadlineNum > 0 && <span>{isPastDeadline ? 'Expired' : formatTimeUntil(deadlineNum)}</span>}
                    </div>
                  </div>

                  {/* Expanded: Submit Work */}
                  {isExpanded && isOpen && !isPastDeadline && (
                    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      className="mt-3 pt-3 border-t border-white/5 space-y-2">
                      <label htmlFor={`bounty-submit-${bountyId}`} className="text-[11px] text-white/70 uppercase tracking-wider block">Submit Your Work</label>
                      <div className="flex gap-2">
                        <input id={`bounty-submit-${bountyId}`} type="text" value={submitURI}
                          onChange={(e) => setSubmitURI(e.target.value)}
                          aria-invalid={submitURIInvalid}
                          aria-describedby={submitURIInvalid ? `bounty-submit-error-${bountyId}` : undefined}
                          placeholder="https://, ipfs://, or ar://"
                          className={`flex-1 bg-black/30 border rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 outline-none transition-colors ${submitURIInvalid ? 'border-red-500/60' : 'border-white/10'}`} />
                        <button onClick={() => handleSubmit(bountyId)}
                          disabled={!address || !submitURI || submitURIInvalid || isSigning || isConfirming}
                          className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
                          Submit
                        </button>
                      </div>
                      {submitURIInvalid && (
                        <p id={`bounty-submit-error-${bountyId}`} role="alert" className="mt-1 text-[11px] text-red-400">
                          {SUBMISSION_URI_ERROR}
                        </p>
                      )}
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
