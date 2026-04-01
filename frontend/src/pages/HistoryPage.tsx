import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
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
    if (fn.includes('swap') || fn.includes('Swap')) return { type: 'Swap', color: 'text-primary' };
    return { type: 'Router', color: 'text-white/50' };
  }
  // Staking
  if (to === TEGRIDY_STAKING_ADDRESS.toLowerCase()) {
    if (fn === 'stake') return { type: 'Stake', color: 'text-success' };
    if (fn === 'withdraw') return { type: 'Unstake', color: 'text-warning' };
    if (fn === 'getReward') return { type: 'Claim', color: 'text-primary' };
    if (fn === 'earlyWithdraw') return { type: 'Early Exit', color: 'text-danger' };
    if (fn === 'toggleAutoMaxLock') return { type: 'Auto-Lock', color: 'text-white/50' };
    return { type: 'Farm', color: 'text-white/50' };
  }
  // Restaking
  if (to === TEGRIDY_RESTAKING_ADDRESS.toLowerCase()) {
    if (fn === 'restake') return { type: 'Restake', color: 'text-success' };
    if (fn === 'unrestake') return { type: 'Unrestake', color: 'text-warning' };
    if (fn === 'claimAll') return { type: 'Claim', color: 'text-primary' };
    return { type: 'Restake', color: 'text-white/50' };
  }
  // Revenue & Referrals
  if (to === REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase()) {
    if (fn === 'register') return { type: 'Register', color: 'text-success' };
    if (fn === 'claim') return { type: 'Revenue', color: 'text-primary' };
    return { type: 'Revenue', color: 'text-white/50' };
  }
  if (to === REFERRAL_SPLITTER_ADDRESS.toLowerCase()) {
    if (fn === 'claimReferralRewards') return { type: 'Referral', color: 'text-primary' };
    if (fn === 'setReferrer') return { type: 'Referral', color: 'text-success' };
    return { type: 'Referral', color: 'text-white/50' };
  }
  // Governance
  if (to === COMMUNITY_GRANTS_ADDRESS.toLowerCase()) {
    if (fn === 'createProposal') return { type: 'Proposal', color: 'text-primary' };
    if (fn === 'voteOnProposal') return { type: 'Vote', color: 'text-success' };
    if (fn === 'finalizeProposal') return { type: 'Finalize', color: 'text-warning' };
    return { type: 'Grants', color: 'text-white/50' };
  }
  // Bounties
  if (to === MEME_BOUNTY_BOARD_ADDRESS.toLowerCase()) {
    if (fn === 'createBounty') return { type: 'Bounty', color: 'text-primary' };
    if (fn === 'submitWork') return { type: 'Submit', color: 'text-success' };
    if (fn === 'voteForSubmission') return { type: 'Vote', color: 'text-success' };
    return { type: 'Bounty', color: 'text-white/50' };
  }
  // Premium
  if (to === PREMIUM_ACCESS_ADDRESS.toLowerCase()) {
    if (fn === 'subscribe') return { type: 'Subscribe', color: 'text-primary' };
    if (fn === 'claimNFTAccess') return { type: 'NFT Claim', color: 'text-success' };
    return { type: 'Premium', color: 'text-white/50' };
  }
  // Vote Incentives (Bribes)
  if (to === VOTE_INCENTIVES_ADDRESS.toLowerCase()) {
    if (fn === 'depositBribe' || fn === 'depositBribeETH') return { type: 'Bribe', color: 'text-primary' };
    if (fn === 'claimBribes' || fn === 'claimBribesBatch') return { type: 'Claim Bribe', color: 'text-success' };
    if (fn === 'advanceEpoch') return { type: 'Epoch', color: 'text-white/50' };
    return { type: 'Bribes', color: 'text-white/50' };
  }
  // Token approvals
  if (fn === 'approve') {
    return { type: 'Approve', color: 'text-white/40' };
  }
  return { type: 'Other', color: 'text-white/30' };
}

export default function HistoryPage() {
  usePageTitle('History');
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
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.ts === 'number' && Array.isArray(parsed.data) && Date.now() - parsed.ts < 300000) {
          setTxs(parsed.data.filter(isValidTxRecord).map(truncateTxFields));
          return;
        }
      }
    } catch {}

    setLoading(true);
    const contracts = [
      SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, TEGRIDY_STAKING_ADDRESS,
      TEGRIDY_RESTAKING_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
      COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, PREMIUM_ACCESS_ADDRESS,
      TOWELI_ADDRESS, VOTE_INCENTIVES_ADDRESS,
    ].map(a => a.toLowerCase());

    // Etherscan free-tier API key via VITE_ env var — intentionally public/client-side.
    // This key is rate-limited (5 req/s) and carries no privileged access.
    const etherscanKey = import.meta.env.VITE_ETHERSCAN_API_KEY || '';
    fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${etherscanKey}`)
      .then(r => r.json())
      .then(data => {
        if (data.status === '1' && Array.isArray(data.result)) {
          const relevant = data.result.filter((tx: unknown) =>
            isValidTxRecord(tx) && contracts.includes(tx.to?.toLowerCase())
          ).slice(0, 50).map(truncateTxFields);
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
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.96) 100%)' }} />
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
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.92) 60%, rgba(0,0,0,0.96) 100%)',
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
          Showing interactions with all Tegridy Farms protocol contracts.
        </p>
      </div>
    </div>
  );
}
