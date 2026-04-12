import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther, formatEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LENDING_ADDRESS, TEGRIDY_STAKING_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LENDING_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatTokenAmount } from '../lib/formatting';
import { toast } from 'sonner';

type Tab = 'lend' | 'borrow';

function OfferCard({ offerId, address }: { offerId: number; address?: string }) {
  const { data: offer } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getOffer',
    args: [BigInt(offerId)],
  });
  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  if (!offer || !offer[6]) return null; // not active

  const [lender, principal, aprBps, duration] = offer;
  const isOwner = address?.toLowerCase() === lender.toLowerCase();

  return (
    <div className="glass-card p-4 rounded-xl">
      <div className="flex justify-between items-start mb-3">
        <div>
          <span className="text-xs text-white/50">Offer #{offerId}</span>
          <p className="stat-value text-lg">{formatTokenAmount(formatEther(principal))} ETH</p>
        </div>
        <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/20 text-green-400">Active</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm text-white/70 mb-3">
        <div>APR: <span className="text-white">{Number(aprBps) / 100}%</span></div>
        <div>Duration: <span className="text-white">{Math.floor(Number(duration) / 86400)}d</span></div>
      </div>
      {isOwner ? (
        <button
          className="w-full py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-sm"
          disabled={isConfirming}
          onClick={() => {
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS,
              abi: TEGRIDY_LENDING_ABI,
              functionName: 'cancelOffer',
              args: [BigInt(offerId)],
            }, { onSuccess: () => toast.success('Offer cancelled'), onError: (e) => toast.error(e.message.slice(0, 80)) });
          }}
        >
          {isConfirming ? 'Cancelling...' : 'Cancel Offer'}
        </button>
      ) : (
        <button
          className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 transition-colors text-sm text-white font-medium"
          onClick={() => {
            const tokenId = prompt('Enter your TegridyStaking NFT token ID to use as collateral:');
            if (!tokenId) return;
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS,
              abi: TEGRIDY_LENDING_ABI,
              functionName: 'acceptOffer',
              args: [BigInt(offerId), BigInt(tokenId)],
            }, { onSuccess: () => toast.success('Loan accepted!'), onError: (e) => toast.error(e.message.slice(0, 80)) });
          }}
        >
          {isConfirming ? 'Accepting...' : 'Accept & Borrow'}
        </button>
      )}
    </div>
  );
}

export default function LendingPage() {
  usePageTitle('Lending');
  const { isConnected, address } = useAccount();
  const [tab, setTab] = useState<Tab>('lend');
  const deployed = isDeployed(TEGRIDY_LENDING_ADDRESS);

  // Form state
  const [principal, setPrincipal] = useState('');
  const [aprBps, setAprBps] = useState('1000');
  const [durationDays, setDurationDays] = useState('30');
  const [minCollateral, setMinCollateral] = useState('0');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: offerCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'offerCount',
    query: { enabled: deployed },
  });

  const { data: loanCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
    query: { enabled: deployed },
  });

  const { data: feeBps } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'protocolFeeBps',
    query: { enabled: deployed },
  });

  const handleCreateOffer = () => {
    if (!principal || Number(principal) <= 0) return toast.error('Enter a valid principal amount');
    try {
      writeContract({
        address: TEGRIDY_LENDING_ADDRESS,
        abi: TEGRIDY_LENDING_ABI,
        functionName: 'createLoanOffer',
        args: [
          BigInt(aprBps || '0'),
          BigInt(Number(durationDays || '30') * 86400),
          TEGRIDY_STAKING_ADDRESS,
          parseEther(minCollateral || '0'),
        ],
        value: parseEther(principal),
      }, {
        onSuccess: () => { toast.success('Loan offer created!'); setPrincipal(''); },
        onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Transaction failed'),
      });
    } catch { toast.error('Invalid input values'); }
  };

  const offerIds = offerCount ? Array.from({ length: Number(offerCount) }, (_, i) => i).reverse().slice(0, 20) : [];

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.15 }} />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(6,12,26,0.85) 50%, rgba(6,12,26,0.98) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16">
        <motion.div className="text-center mb-10" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl mb-3">P2P Lending</h1>
          <p className="text-white/60 max-w-lg mx-auto">Borrow ETH against your staking positions or earn yield by lending. No oracles, pure peer-to-peer.</p>
        </motion.div>

        {!isConnected ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <p className="text-white/60 mb-4">Connect your wallet to access P2P lending</p>
            <ConnectButton />
          </div>
        ) : !deployed ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <h2 className="heading-luxury text-xl mb-3">Coming Soon</h2>
            <p className="text-white/60">The Tegridy Lending protocol is being audited and will be deployed soon. Borrow ETH against your staked TOWELI positions or earn fixed-rate yield by creating loan offers.</p>
          </div>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <div className="glass-card p-4 rounded-xl text-center">
                <p className="text-xs text-white/50 mb-1">Total Offers</p>
                <p className="stat-value text-xl">{offerCount?.toString() ?? '0'}</p>
              </div>
              <div className="glass-card p-4 rounded-xl text-center">
                <p className="text-xs text-white/50 mb-1">Active Loans</p>
                <p className="stat-value text-xl">{loanCount?.toString() ?? '0'}</p>
              </div>
              <div className="glass-card p-4 rounded-xl text-center">
                <p className="text-xs text-white/50 mb-1">Protocol Fee</p>
                <p className="stat-value text-xl">{feeBps ? `${Number(feeBps) / 100}%` : '--'}</p>
              </div>
              <div className="glass-card p-4 rounded-xl text-center">
                <p className="text-xs text-white/50 mb-1">Collateral</p>
                <p className="stat-value text-xl">Staking NFT</p>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
              {(['lend', 'borrow'] as Tab[]).map((t) => (
                <button
                  key={t}
                  className={`px-6 py-2.5 rounded-xl text-sm font-medium transition-all ${tab === t ? 'bg-emerald-600 text-white' : 'glass-card text-white/60 hover:text-white'}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'lend' ? 'Lend' : 'Borrow'}
                </button>
              ))}
            </div>

            {tab === 'lend' ? (
              <motion.div className="glass-card p-6 rounded-2xl max-w-lg" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <h2 className="heading-luxury text-xl mb-4">Create Loan Offer</h2>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-white/50 mb-1 block">Principal (ETH)</label>
                    <input type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="0.0" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">APR (bps)</label>
                      <input type="number" value={aprBps} onChange={(e) => setAprBps(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                      <span className="text-xs text-white/40 mt-1 block">{Number(aprBps) / 100}% annual</span>
                    </div>
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Duration (days)</label>
                      <input type="number" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/50 mb-1 block">Min Collateral Value (ETH)</label>
                    <input type="number" value={minCollateral} onChange={(e) => setMinCollateral(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                  </div>
                  <button
                    className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-50"
                    disabled={isConfirming || !principal}
                    onClick={handleCreateOffer}
                  >
                    {isConfirming ? 'Creating Offer...' : 'Create Loan Offer'}
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <h2 className="heading-luxury text-xl mb-4">Available Offers</h2>
                {offerIds.length === 0 ? (
                  <div className="glass-card p-8 rounded-2xl text-center">
                    <p className="text-white/50">No loan offers yet. Be the first to create one!</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {offerIds.map((id) => (
                      <OfferCard key={id} offerId={id} address={address} />
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
