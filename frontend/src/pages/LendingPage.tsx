import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther, formatEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LENDING_ADDRESS, TEGRIDY_STAKING_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LENDING_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatTokenAmount } from '../lib/formatting';
import { toast } from 'sonner';

type Tab = 'lend' | 'borrow' | 'loans';

function OfferCard({ offerId, address }: { offerId: number; address?: string }) {
  const { data: offer } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getOffer',
    args: [BigInt(offerId)],
  });
  const { writeContract: writeLending, data: lendingHash } = useWriteContract();
  const { writeContract: writeApprove, data: approveHash } = useWriteContract();
  const { isLoading: isConfirmingLending } = useWaitForTransactionReceipt({ hash: lendingHash });
  const { isLoading: isConfirmingApprove } = useWaitForTransactionReceipt({ hash: approveHash });

  const [tokenId, setTokenId] = useState('');
  const [showAccept, setShowAccept] = useState(false);

  // Check if the entered token is approved for lending contract
  const { data: approvedAddr } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'getApproved',
    args: [BigInt(tokenId || '0')],
    query: { enabled: !!tokenId && tokenId !== '0' },
  });

  const isApproved = approvedAddr?.toLowerCase() === TEGRIDY_LENDING_ADDRESS.toLowerCase();
  const isConfirming = isConfirmingLending || isConfirmingApprove;

  if (!offer || !offer[6]) return null; // not active

  const [lender, principal, aprBps, duration] = offer;
  const isOwner = address?.toLowerCase() === lender.toLowerCase();

  const handleApprove = () => {
    if (!tokenId) return toast.error('Enter a token ID');
    writeApprove({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'approve',
      args: [TEGRIDY_LENDING_ADDRESS, BigInt(tokenId)],
    }, {
      onSuccess: () => toast.success('NFT approved for lending'),
      onError: (e) => toast.error(e.message.slice(0, 80)),
    });
  };

  const handleAccept = () => {
    if (!tokenId) return toast.error('Enter a token ID');
    writeLending({
      address: TEGRIDY_LENDING_ADDRESS,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'acceptOffer',
      args: [BigInt(offerId), BigInt(tokenId)],
    }, {
      onSuccess: () => { toast.success('Loan accepted!'); setShowAccept(false); setTokenId(''); },
      onError: (e) => toast.error(e.message.slice(0, 80)),
    });
  };

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
            writeLending({
              address: TEGRIDY_LENDING_ADDRESS,
              abi: TEGRIDY_LENDING_ABI,
              functionName: 'cancelOffer',
              args: [BigInt(offerId)],
            }, { onSuccess: () => toast.success('Offer cancelled'), onError: (e) => toast.error(e.message.slice(0, 80)) });
          }}
        >
          {isConfirming ? 'Cancelling...' : 'Cancel Offer'}
        </button>
      ) : !showAccept ? (
        <button
          className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 transition-colors text-sm text-white font-medium"
          onClick={() => setShowAccept(true)}
        >
          Accept & Borrow
        </button>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-white/50 mb-1 block">Your Staking NFT Token ID</label>
            <input
              type="number"
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              placeholder="e.g. 42"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-emerald-500 transition-colors text-sm"
            />
          </div>
          {tokenId && !isApproved ? (
            <button
              className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
              disabled={isConfirming}
              onClick={handleApprove}
            >
              {isConfirmingApprove ? 'Approving...' : '1. Approve NFT'}
            </button>
          ) : (
            <button
              className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
              disabled={isConfirming || !tokenId}
              onClick={handleAccept}
            >
              {isConfirmingLending ? 'Accepting...' : '2. Accept & Borrow'}
            </button>
          )}
          <button
            className="w-full py-1.5 text-xs text-white/40 hover:text-white/60 transition-colors"
            onClick={() => { setShowAccept(false); setTokenId(''); }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function LoanCard({ loanId, address }: { loanId: number; address?: string }) {
  const { data: loan } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getLoan',
    args: [BigInt(loanId)],
  });

  const { data: repayAmount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getRepaymentAmount',
    args: [BigInt(loanId)],
    query: { enabled: !!loan && !loan[8] && !loan[9] }, // only if not repaid/claimed
  });

  const { data: defaulted } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'isDefaulted',
    args: [BigInt(loanId)],
    query: { enabled: !!loan && !loan[8] && !loan[9] },
  });

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  if (!loan) return null;

  const [borrower, lender, , tokenId, principal, aprBps, startTime, deadline, repaid, defaultClaimed] = loan;
  const isBorrower = address?.toLowerCase() === borrower.toLowerCase();
  const isLender = address?.toLowerCase() === lender.toLowerCase();
  const isActive = !repaid && !defaultClaimed;
  const deadlineDate = new Date(Number(deadline) * 1000);
  const isOverdue = Date.now() / 1000 > Number(deadline);

  // Filter: only show loans relevant to current user
  if (!isBorrower && !isLender) return null;

  const statusLabel = repaid ? 'Repaid' : defaultClaimed ? 'Defaulted' : isOverdue ? 'Overdue' : 'Active';
  const statusColor = repaid ? 'bg-green-500/20 text-green-400' : defaultClaimed ? 'bg-red-500/20 text-red-400' : isOverdue ? 'bg-orange-500/20 text-orange-400' : 'bg-blue-500/20 text-blue-400';

  return (
    <div className="glass-card p-4 rounded-xl">
      <div className="flex justify-between items-start mb-3">
        <div>
          <span className="text-xs text-white/50">Loan #{loanId}</span>
          <p className="stat-value text-lg">{formatTokenAmount(formatEther(principal))} ETH</p>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs ${statusColor}`}>{statusLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm text-white/70 mb-3">
        <div>APR: <span className="text-white">{Number(aprBps) / 100}%</span></div>
        <div>NFT: <span className="text-white">#{tokenId.toString()}</span></div>
        <div>Role: <span className="text-white">{isBorrower ? 'Borrower' : 'Lender'}</span></div>
        <div>Due: <span className="text-white">{deadlineDate.toLocaleDateString()}</span></div>
      </div>

      {isActive && repayAmount && (
        <p className="text-xs text-white/50 mb-2">
          Repayment: <span className="text-white">{formatTokenAmount(formatEther(repayAmount))} ETH</span>
        </p>
      )}

      {/* Repay button for borrower */}
      {isActive && isBorrower && !isOverdue && repayAmount && (
        <button
          className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
          disabled={isConfirming}
          onClick={() => {
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS,
              abi: TEGRIDY_LENDING_ABI,
              functionName: 'repayLoan',
              args: [BigInt(loanId)],
              value: repayAmount,
            }, {
              onSuccess: () => toast.success('Loan repaid! NFT returned.'),
              onError: (e) => toast.error(e.message.slice(0, 80)),
            });
          }}
        >
          {isConfirming ? 'Repaying...' : `Repay ${formatTokenAmount(formatEther(repayAmount))} ETH`}
        </button>
      )}

      {/* Claim defaulted collateral for lender */}
      {isActive && isLender && defaulted && (
        <button
          className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
          disabled={isConfirming}
          onClick={() => {
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS,
              abi: TEGRIDY_LENDING_ABI,
              functionName: 'claimDefaultedCollateral',
              args: [BigInt(loanId)],
            }, {
              onSuccess: () => toast.success('Collateral claimed!'),
              onError: (e) => toast.error(e.message.slice(0, 80)),
            });
          }}
        >
          {isConfirming ? 'Claiming...' : 'Claim Defaulted Collateral'}
        </button>
      )}

      {/* Overdue warning for borrower */}
      {isActive && isBorrower && isOverdue && (
        <p className="text-xs text-orange-400 text-center">Loan is past deadline. Lender can claim your NFT.</p>
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
  const loanIds = loanCount ? Array.from({ length: Number(loanCount) }, (_, i) => i).reverse().slice(0, 20) : [];

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
                <p className="text-xs text-white/50 mb-1">Total Loans</p>
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
              {(['lend', 'borrow', 'loans'] as Tab[]).map((t) => (
                <button
                  key={t}
                  className={`px-6 py-2.5 rounded-xl text-sm font-medium transition-all ${tab === t ? 'bg-emerald-600 text-white' : 'glass-card text-white/60 hover:text-white'}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'lend' ? 'Lend' : t === 'borrow' ? 'Borrow' : 'My Loans'}
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
            ) : tab === 'borrow' ? (
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
            ) : (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <h2 className="heading-luxury text-xl mb-4">My Loans</h2>
                {loanIds.length === 0 ? (
                  <div className="glass-card p-8 rounded-2xl text-center">
                    <p className="text-white/50">No loans yet.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {loanIds.map((id) => (
                      <LoanCard key={id} loanId={id} address={address} />
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
