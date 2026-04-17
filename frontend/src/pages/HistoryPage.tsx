import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useChainId } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { getTxUrl } from '../lib/explorer';
import { ART } from '../lib/artConfig';
import {
  TEGRIDY_STAKING_ADDRESS, TEGRIDY_RESTAKING_ADDRESS, UNISWAP_V2_ROUTER,
  SWAP_FEE_ROUTER_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, PREMIUM_ACCESS_ADDRESS,
  TOWELI_ADDRESS, VOTE_INCENTIVES_ADDRESS,
} from '../lib/constants';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { Skeleton } from '../components/ui/Skeleton';
import { usePageTitle } from '../hooks/usePageTitle';

interface TxRecord {
  hash: string;
  timeStamp: string;
  to: string;
  functionName: string;
  isError: string;
  value: string;
}

function isValidTxRecord(tx: unknown): tx is TxRecord {
  if (!tx || typeof tx !== 'object') return false;
  const r = tx as Record<string, unknown>;
  return typeof r.hash === 'string' && typeof r.timeStamp === 'string' && typeof r.to === 'string'
    && typeof r.functionName === 'string' && typeof r.isError === 'string' && typeof r.value === 'string';
}

function truncateTxFields(tx: TxRecord): TxRecord {
  return {
    hash: tx.hash.slice(0, 66),
    timeStamp: tx.timeStamp.slice(0, 12),
    to: tx.to.slice(0, 42),
    functionName: tx.functionName.slice(0, 128),
    isError: tx.isError,
    value: tx.value.slice(0, 32),
  };
}

function categorizeTx(tx: TxRecord): { type: string; color: string } {
  const fn = tx.functionName?.split('(')[0] || '';
  const to = tx.to.toLowerCase();

  // Swap routers
  if (to === SWAP_FEE_ROUTER_ADDRESS.toLowerCase() || to === UNISWAP_V2_ROUTER.toLowerCase()) {
    if (fn.includes('swap') || fn.includes('Swap')) return { type: 'Swap', color: 'text-white' };
    return { type: 'Router', color: 'text-white' };
  }
  // Staking
  if (to === TEGRIDY_STAKING_ADDRESS.toLowerCase()) {
    if (fn === 'stake') return { type: 'Stake', color: 'text-success' };
    if (fn === 'withdraw') return { type: 'Unstake', color: 'text-warning' };
    if (fn === 'getReward') return { type: 'Claim', color: 'text-white' };
    if (fn === 'earlyWithdraw') return { type: 'Early Exit', color: 'text-danger' };
    if (fn === 'toggleAutoMaxLock') return { type: 'Auto-Lock', color: 'text-white' };
    return { type: 'Farm', color: 'text-white' };
  }
  // Restaking
  if (to === TEGRIDY_RESTAKING_ADDRESS.toLowerCase()) {
    if (fn === 'restake') return { type: 'Restake', color: 'text-success' };
    if (fn === 'unrestake') return { type: 'Unrestake', color: 'text-warning' };
    if (fn === 'claimAll') return { type: 'Claim', color: 'text-white' };
    return { type: 'Restake', color: 'text-white' };
  }
  // Revenue & Referrals
  if (to === REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase()) {
    if (fn === 'register') return { type: 'Register', color: 'text-success' };
    if (fn === 'claim') return { type: 'Revenue', color: 'text-white' };
    return { type: 'Revenue', color: 'text-white' };
  }
  if (to === REFERRAL_SPLITTER_ADDRESS.toLowerCase()) {
    if (fn === 'claimReferralRewards') return { type: 'Referral', color: 'text-white' };
    if (fn === 'setReferrer') return { type: 'Referral', color: 'text-success' };
    return { type: 'Referral', color: 'text-white' };
  }
  // Governance
  if (to === COMMUNITY_GRANTS_ADDRESS.toLowerCase()) {
    if (fn === 'createProposal') return { type: 'Proposal', color: 'text-white' };
    if (fn === 'voteOnProposal') return { type: 'Vote', color: 'text-success' };
    if (fn === 'finalizeProposal') return { type: 'Finalize', color: 'text-warning' };
    return { type: 'Grants', color: 'text-white' };
  }
  // Bounties
  if (to === MEME_BOUNTY_BOARD_ADDRESS.toLowerCase()) {
    if (fn === 'createBounty') return { type: 'Bounty', color: 'text-white' };
    if (fn === 'submitWork') return { type: 'Submit', color: 'text-success' };
    if (fn === 'voteForSubmission') return { type: 'Vote', color: 'text-success' };
    return { type: 'Bounty', color: 'text-white' };
  }
  // Premium
  if (to === PREMIUM_ACCESS_ADDRESS.toLowerCase()) {
    if (fn === 'subscribe') return { type: 'Subscribe', color: 'text-white' };
    if (fn === 'claimNFTAccess') return { type: 'NFT Claim', color: 'text-success' };
    return { type: 'Premium', color: 'text-white' };
  }
  // Vote Incentives (Bribes)
  if (to === VOTE_INCENTIVES_ADDRESS.toLowerCase()) {
    if (fn === 'depositBribe' || fn === 'depositBribeETH') return { type: 'Bribe', color: 'text-white' };
    if (fn === 'claimBribes' || fn === 'claimBribesBatch') return { type: 'Claim Bribe', color: 'text-success' };
    if (fn === 'advanceEpoch') return { type: 'Epoch', color: 'text-white' };
    return { type: 'Bribes', color: 'text-white' };
  }
  // Token approvals
  if (fn === 'approve') {
    return { type: 'Approve', color: 'text-white' };
  }
  return { type: 'Other', color: 'text-white' };
}

export default function HistoryPage() {
  usePageTitle('History', 'Your transaction history — swaps, stakes, claims, and on-chain activity.');
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchHistory = useCallback((addr: string, signal: AbortSignal, skipCache = false) => {
    // Check cache first
    const cacheKey = `tegridy_tx_history_${addr}`;
    if (!skipCache) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed.ts === 'number' && Array.isArray(parsed.data) && Date.now() - parsed.ts < 300000) {
            setTxs(parsed.data.filter(isValidTxRecord).map(truncateTxFields));
            return;
          }
        }
      } catch {}
    }

    setLoading(true);
    setError('');
    const contracts = [
      SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, TEGRIDY_STAKING_ADDRESS,
      TEGRIDY_RESTAKING_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
      COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, PREMIUM_ACCESS_ADDRESS,
      TOWELI_ADDRESS, VOTE_INCENTIVES_ADDRESS,
    ].map(a => a.toLowerCase());

    // SECURITY FIX: Route Etherscan calls through server-side proxy to keep API key hidden.
    // Previously used VITE_ETHERSCAN_API_KEY which was exposed in client-side bundle.
    fetch(`/api/etherscan?module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&sort=desc`, { signal })
      .then(r => r.json())
      .then(data => {
        if (signal.aborted) return;
        if (data.status === '1' && Array.isArray(data.result)) {
          const relevant = data.result.filter((tx: unknown) =>
            isValidTxRecord(tx) && contracts.includes(tx.to?.toLowerCase())
          ).slice(0, 50).map(truncateTxFields);
          setTxs(relevant);
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ data: relevant, ts: Date.now() }));
          } catch {}
        } else if (data.status === '0' && data.message === 'No transactions found') {
          setTxs([]);
        } else {
          setError(data.message || 'Failed to load history. Try again later.');
        }
      })
      .catch((err) => {
        if (!signal.aborted) setError(err?.message || 'Failed to load history. Try again later.');
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    fetchHistory(address, controller.signal);
    return () => controller.abort();
  }, [address, fetchHistory]);

  const handleRetry = useCallback(() => {
    if (!address) return;
    const cacheKey = `tegridy_tx_history_${address}`;
    try { localStorage.removeItem(cacheKey); } catch {}
    const controller = new AbortController();
    fetchHistory(address, controller.signal, true);
  }, [address, fetchHistory]);

  const categorized = useMemo(() => txs.map(tx => ({
    ...tx,
    ...categorizeTx(tx),
  })), [txs]);

  const exportCSV = useCallback(() => {
    if (categorized.length === 0) return;
    const headers = ['Date', 'Type', 'Function', 'Tx Hash', 'To', 'Value (Wei)', 'Status'];
    const rows = categorized.map(tx => [
      new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString(),
      tx.type,
      tx.functionName?.split('(')[0] || '',
      tx.hash,
      tx.to,
      tx.value || '0',
      tx.isError === '0' ? 'OK' : 'Failed',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegridy-transactions-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [categorized]);

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.jungleDark.src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Transaction History</h2>
            <p className="text-white text-[13px] mb-6">Connect your wallet to view your history.</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">Connect Wallet</button>
                </div>
              )}
            </ConnectButton.Custom>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.jungleDark.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 40%' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <motion.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">History</h1>
              <p className="text-white text-[14px]">Your recent transactions on Tegridy Farms</p>
            </div>
            {categorized.length > 0 && (
              <button onClick={exportCSV} className="btn-primary flex items-center gap-2 px-4 py-2 text-[12px] shrink-0" title="Export transactions as CSV">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export CSV
              </button>
            )}
          </div>
        </motion.div>

        <motion.div className="glass-card rounded-xl overflow-hidden" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {loading ? (
            <div className="p-6 space-y-3">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton width={60} height={20} />
                  <Skeleton width={120} height={16} />
                  <div className="flex-1" />
                  <Skeleton width={80} height={16} />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-6 text-center">
              <p className="text-danger text-[13px] mb-3">{error}</p>
              <button onClick={handleRetry} className="btn-primary px-5 py-1.5 text-[12px]">Retry</button>
            </div>
          ) : categorized.length === 0 ? (
            <div className="rounded-xl p-8 text-center" style={{ background: 'rgba(13, 21, 48, 0.6)', border: '1px solid var(--color-purple-12)' }}>
              <p className="text-white/40 text-[13px]">No transactions found. Start trading or staking to see your history here.</p>
              <p className="text-white/25 text-[11px] mt-1">Swaps, stakes, claims, and governance actions will appear automatically.</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="hidden md:table-header-group">
                <tr className="text-[11px] text-white uppercase tracking-wider label-pill"
                  style={{ borderBottom: '1px solid var(--color-purple-75)' }}>
                  <th className="px-4 md:px-5 py-3 text-left font-normal w-20">Type</th>
                  <th className="py-3 text-left font-normal w-24">Function</th>
                  <th className="py-3 text-left font-normal">Tx Hash</th>
                  <th className="py-3 text-right font-normal w-20">Time</th>
                  <th className="px-4 md:px-5 py-3 text-right font-normal w-16">Status</th>
                </tr>
              </thead>
              <tbody>
                {categorized.map(tx => (
                  <tr key={tx.hash} className="hover:bg-black/60 transition-colors"
                    style={{ borderBottom: '1px solid var(--color-purple-75)' }}>
                    {/* Desktop cells */}
                    <td className="hidden md:table-cell px-4 md:px-5 py-3">
                      <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                        className={`text-[12px] font-semibold ${tx.color}`}>{tx.type}</a>
                    </td>
                    <td className="hidden md:table-cell py-3">
                      <span className="text-[11px] text-white font-mono truncate block w-24">{tx.functionName?.split('(')[0] || '–'}</span>
                    </td>
                    <td className="hidden md:table-cell py-3">
                      <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                        className="text-[11px] font-mono text-white truncate block">
                        {shortenAddress(tx.hash, 8)}
                      </a>
                    </td>
                    <td className="hidden md:table-cell py-3 text-right text-[11px] text-white">
                      {formatTimeAgo(parseInt(tx.timeStamp, 10))}
                    </td>
                    <td className="hidden md:table-cell px-4 md:px-5 py-3 text-right">
                      <span className={`text-[11px] font-medium ${tx.isError === '0' ? 'text-success' : 'text-danger'}`}>
                        {tx.isError === '0' ? 'OK' : 'Failed'}
                      </span>
                    </td>
                    {/* Mobile cell — single cell spanning full width */}
                    <td className="md:hidden px-4 py-3" colSpan={5}>
                      <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-[12px] font-semibold flex-shrink-0 ${tx.color}`}>{tx.type}</span>
                          <span className="text-[11px] font-mono text-white truncate">
                            {shortenAddress(tx.hash, 6)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[11px] text-white">{formatTimeAgo(parseInt(tx.timeStamp, 10))}</span>
                          <span className={`text-[11px] font-medium ${tx.isError === '0' ? 'text-success' : 'text-danger'}`}>
                            {tx.isError === '0' ? 'OK' : 'Fail'}
                          </span>
                        </div>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </motion.div>

        <p className="text-white/15 text-[10px] text-center mt-4">
          Showing interactions with all Tegridy Farms protocol contracts.
        </p>
      </div>
    </div>
  );
}
