import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { TEGRIDY_STAKING_ADDRESS, UNISWAP_V2_ROUTER, TOWELI_ADDRESS } from '../lib/constants';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { Skeleton } from '../components/ui/Skeleton';

interface TxRecord {
  hash: string;
  timeStamp: string;
  to: string;
  functionName: string;
  isError: string;
  value: string;
}

function categorizeTx(tx: TxRecord): { type: string; color: string } {
  const fn = tx.functionName?.split('(')[0] || '';
  const to = tx.to.toLowerCase();

  if (to === UNISWAP_V2_ROUTER.toLowerCase()) {
    if (fn.includes('swap')) return { type: 'Swap', color: 'text-primary' };
    return { type: 'Router', color: 'text-white/50' };
  }
  if (to === TEGRIDY_STAKING_ADDRESS.toLowerCase()) {
    if (fn === 'deposit') return { type: 'Stake', color: 'text-success' };
    if (fn === 'withdraw') return { type: 'Unstake', color: 'text-warning' };
    if (fn === 'claim') return { type: 'Claim', color: 'text-primary' };
    if (fn === 'emergencyWithdraw') return { type: 'Emergency', color: 'text-danger' };
    return { type: 'Farm', color: 'text-white/50' };
  }
  if (to === TOWELI_ADDRESS.toLowerCase() && fn === 'approve') {
    return { type: 'Approve', color: 'text-white/40' };
  }
  return { type: 'Other', color: 'text-white/30' };
}

export default function HistoryPage() {
  const { isConnected, address } = useAccount();
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!address) return;

    // Check cache first
    const cacheKey = `tegridy_tx_history_${address}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < 300000) { // 5 min cache
          setTxs(data);
          return;
        }
      }
    } catch {}

    setLoading(true);
    const contracts = [UNISWAP_V2_ROUTER, TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS].map(a => a.toLowerCase());

    fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=YourApiKeyToken`)
      .then(r => r.json())
      .then(data => {
        if (data.status === '1' && Array.isArray(data.result)) {
          const relevant = data.result.filter((tx: TxRecord) =>
            contracts.includes(tx.to?.toLowerCase())
          ).slice(0, 50);
          setTxs(relevant);
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ data: relevant, ts: Date.now() }));
          } catch {}
        }
      })
      .catch(() => setError('Failed to load history. Try again later.'))
      .finally(() => setLoading(false));
  }, [address]);

  const categorized = useMemo(() => txs.map(tx => ({
    ...tx,
    ...categorizeTx(tx),
  })), [txs]);

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.jungleDark.src} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.7) 100%)' }} />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Transaction History</h2>
            <p className="text-white/40 text-[13px] mb-6">Connect your wallet to view your history.</p>
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
        <img src={ART.jungleDark.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 40%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.3) 30%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0.8) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">History</h1>
          <p className="text-white/50 text-[14px]">Your recent transactions on Tegridy Farms</p>
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
            <div className="p-6 text-center text-danger text-[13px]">{error}</div>
          ) : categorized.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-white/30 text-[14px] mb-1">No transactions found</p>
              <p className="text-white/20 text-[12px]">Swap, stake, or claim to see your history here.</p>
            </div>
          ) : (
            <div>
              {/* Header */}
              <div className="px-5 py-3 flex items-center gap-4 text-[11px] text-white/30 uppercase tracking-wider"
                style={{ borderBottom: '1px solid rgba(139,92,246,0.08)' }}>
                <span className="w-20">Type</span>
                <span className="w-24">Function</span>
                <span className="flex-1">Tx Hash</span>
                <span className="w-20 text-right">Time</span>
                <span className="w-16 text-right">Status</span>
              </div>

              {/* Rows */}
              {categorized.map(tx => (
                <div key={tx.hash} className="px-5 py-3 flex items-center gap-4 hover:bg-white/[0.02] transition-colors"
                  style={{ borderBottom: '1px solid rgba(139,92,246,0.04)' }}>
                  <span className={`w-20 text-[12px] font-semibold ${tx.color}`}>{tx.type}</span>
                  <span className="w-24 text-[11px] text-white/25 font-mono truncate">{tx.functionName?.split('(')[0] || '–'}</span>
                  <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer"
                    className="flex-1 text-[11px] font-mono text-primary/70 hover:text-primary transition-colors truncate">
                    {shortenAddress(tx.hash, 8)}
                  </a>
                  <span className="w-20 text-right text-[11px] text-white/25">
                    {formatTimeAgo(parseInt(tx.timeStamp))}
                  </span>
                  <span className={`w-16 text-right text-[11px] font-medium ${tx.isError === '0' ? 'text-success' : 'text-danger'}`}>
                    {tx.isError === '0' ? 'OK' : 'Failed'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        <p className="text-white/15 text-[10px] text-center mt-4">
          Showing interactions with Tegridy Farm, Uniswap Router, and TOWELI contracts.
        </p>
      </div>
    </div>
  );
}
