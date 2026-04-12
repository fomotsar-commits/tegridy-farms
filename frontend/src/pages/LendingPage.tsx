import { useState, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther, formatEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LENDING_ADDRESS, TEGRIDY_STAKING_ADDRESS, TEGRIDY_NFT_POOL_FACTORY_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LENDING_ABI, TEGRIDY_STAKING_ABI, TEGRIDY_NFT_POOL_FACTORY_ABI, TEGRIDY_NFT_POOL_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatTokenAmount } from '../lib/formatting';
import { toast } from 'sonner';

const LaunchpadPage = lazy(() => import('./LaunchpadPage'));
const RestakePage = lazy(() => import('./RestakePage'));

type Section = 'lending' | 'amm' | 'launchpad' | 'restake';
type LendingTab = 'lend' | 'borrow' | 'loans';
const POOL_TYPES = ['BUY', 'SELL', 'TRADE'] as const;

// ─── Lending Components ──────────────────────────────────────────

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

  const { data: approvedAddr } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'getApproved',
    args: [BigInt(tokenId || '0')],
    query: { enabled: !!tokenId && tokenId !== '0' },
  });

  const isApproved = approvedAddr?.toLowerCase() === TEGRIDY_LENDING_ADDRESS.toLowerCase();
  const isConfirming = isConfirmingLending || isConfirmingApprove;

  if (!offer || !offer[6]) return null;

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
    query: { enabled: !!loan && !loan[8] && !loan[9] },
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

  const [borrower, lender, , tokenId, principal, aprBps, , deadline, repaid, defaultClaimed] = loan;
  const isBorrower = address?.toLowerCase() === borrower.toLowerCase();
  const isLender = address?.toLowerCase() === lender.toLowerCase();
  const isActive = !repaid && !defaultClaimed;
  const deadlineDate = new Date(Number(deadline) * 1000);
  const isOverdue = Date.now() / 1000 > Number(deadline);

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
      {isActive && isBorrower && !isOverdue && repayAmount && (
        <button
          className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
          disabled={isConfirming}
          onClick={() => {
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI,
              functionName: 'repayLoan', args: [BigInt(loanId)], value: repayAmount,
            }, { onSuccess: () => toast.success('Loan repaid! NFT returned.'), onError: (e) => toast.error(e.message.slice(0, 80)) });
          }}
        >
          {isConfirming ? 'Repaying...' : `Repay ${formatTokenAmount(formatEther(repayAmount))} ETH`}
        </button>
      )}
      {isActive && isLender && defaulted && (
        <button
          className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-700 transition-colors text-sm text-white font-medium disabled:opacity-50"
          disabled={isConfirming}
          onClick={() => {
            writeContract({
              address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI,
              functionName: 'claimDefaultedCollateral', args: [BigInt(loanId)],
            }, { onSuccess: () => toast.success('Collateral claimed!'), onError: (e) => toast.error(e.message.slice(0, 80)) });
          }}
        >
          {isConfirming ? 'Claiming...' : 'Claim Defaulted Collateral'}
        </button>
      )}
      {isActive && isBorrower && isOverdue && (
        <p className="text-xs text-orange-400 text-center">Loan is past deadline. Lender can claim your NFT.</p>
      )}
    </div>
  );
}

// ─── NFT AMM Components ──────────────────────────────────────────

function PoolInfo({ poolAddress }: { poolAddress: `0x${string}` }) {
  const { data: info } = useReadContract({ address: poolAddress, abi: TEGRIDY_NFT_POOL_ABI, functionName: 'getPoolInfo' });
  const { data: heldIds } = useReadContract({ address: poolAddress, abi: TEGRIDY_NFT_POOL_ABI, functionName: 'getHeldTokenIds' });

  if (!info) return <div className="glass-card p-4 rounded-xl animate-pulse h-36" />;

  const [collection, poolType, spotPrice, delta, feeBps, , , numNFTs, ethBalance] = info;
  const shortCol = `${collection.slice(0, 6)}...${collection.slice(-4)}`;
  const shortPool = `${poolAddress.slice(0, 6)}...${poolAddress.slice(-4)}`;
  const typeLabel = POOL_TYPES[Number(poolType)] ?? 'UNKNOWN';
  const typeColor = poolType === 0 ? 'text-blue-400 bg-blue-500/20' : poolType === 1 ? 'text-orange-400 bg-orange-500/20' : 'text-emerald-400 bg-emerald-500/20';

  return (
    <div className="glass-card p-5 rounded-xl hover:border-emerald-500/30 transition-all border border-white/5">
      <div className="flex justify-between items-start mb-3">
        <div>
          <a href={`https://etherscan.io/address/${poolAddress}`} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-400 hover:underline">{shortPool}</a>
          <p className="text-sm text-white/60 mt-0.5">Collection: {shortCol}</p>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs ${typeColor}`}>{typeLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm text-white/70">
        <div>Spot: <span className="text-white">{formatTokenAmount(formatEther(spotPrice))} ETH</span></div>
        <div>Delta: <span className="text-white">{formatTokenAmount(formatEther(delta))} ETH</span></div>
        <div>NFTs: <span className="text-white">{numNFTs.toString()}</span></div>
        <div>ETH: <span className="text-white">{formatTokenAmount(formatEther(ethBalance))}</span></div>
        <div>Fee: <span className="text-white">{Number(feeBps) / 100}%</span></div>
      </div>
      {heldIds && heldIds.length > 0 && (
        <div className="mt-2 text-xs text-white/40">
          Held IDs: {heldIds.slice(0, 8).map(id => `#${id.toString()}`).join(', ')}{heldIds.length > 8 ? ` +${heldIds.length - 8} more` : ''}
        </div>
      )}
    </div>
  );
}

function BuySellPanel() {
  const [collectionAddr, setCollectionAddr] = useState('');
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [tokenIdsInput, setTokenIdsInput] = useState('');
  const [numToBuy, setNumToBuy] = useState('1');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: bestBuy } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS, abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestBuyPool', args: [collectionAddr as `0x${string}`, BigInt(numToBuy || '1')],
    query: { enabled: collectionAddr.length === 42 && action === 'buy' },
  });
  const { data: bestSell } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS, abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestSellPool', args: [collectionAddr as `0x${string}`, BigInt(1)],
    query: { enabled: collectionAddr.length === 42 && action === 'sell' },
  });

  const bestPool = action === 'buy' ? bestBuy : bestSell;
  const hasPool = bestPool && bestPool[0] !== '0x0000000000000000000000000000000000000000';
  const bestPoolAddr = hasPool ? bestPool[0] as `0x${string}` : undefined;

  const { data: heldIds } = useReadContract({
    address: bestPoolAddr, abi: TEGRIDY_NFT_POOL_ABI, functionName: 'getHeldTokenIds',
    query: { enabled: !!bestPoolAddr && action === 'buy' },
  });

  const handleBuy = () => {
    if (!bestPoolAddr || !heldIds || heldIds.length === 0) return toast.error('No NFTs available');
    const ids = heldIds.slice(0, Number(numToBuy || '1'));
    writeContract({
      address: bestPoolAddr, abi: TEGRIDY_NFT_POOL_ABI, functionName: 'swapETHForNFTs',
      args: [ids], value: bestPool![1],
    }, { onSuccess: () => toast.success(`Bought ${ids.length} NFT(s)!`), onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Failed') });
  };

  const handleSell = () => {
    if (!bestPoolAddr) return toast.error('No sell pool found');
    const ids = tokenIdsInput.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return toast.error('Enter token IDs to sell');
    try {
      writeContract({
        address: bestPoolAddr, abi: TEGRIDY_NFT_POOL_ABI, functionName: 'swapNFTsForETH',
        args: [ids.map(id => BigInt(id)), BigInt(0)],
      }, { onSuccess: () => { toast.success(`Sold ${ids.length} NFT(s)!`); setTokenIdsInput(''); }, onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Failed') });
    } catch { toast.error('Invalid token IDs'); }
  };

  return (
    <div className="glass-card p-6 rounded-2xl">
      <h3 className="heading-luxury text-lg mb-4">Buy / Sell NFTs</h3>
      <div className="flex gap-2 mb-4">
        <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${action === 'buy' ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`} onClick={() => setAction('buy')}>Buy</button>
        <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${action === 'sell' ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`} onClick={() => setAction('sell')}>Sell</button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-white/50 mb-1 block">Collection Address</label>
          <input type="text" value={collectionAddr} onChange={(e) => setCollectionAddr(e.target.value)} placeholder="0x..."
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono" />
        </div>
        {action === 'buy' && (
          <div>
            <label className="text-xs text-white/50 mb-1 block">Quantity</label>
            <input type="number" value={numToBuy} onChange={(e) => setNumToBuy(e.target.value)} min="1"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm" />
          </div>
        )}
        {action === 'sell' && (
          <div>
            <label className="text-xs text-white/50 mb-1 block">Token IDs to Sell (comma-separated)</label>
            <input type="text" value={tokenIdsInput} onChange={(e) => setTokenIdsInput(e.target.value)} placeholder="1, 42, 100"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono" />
            <span className="text-xs text-white/30 mt-1 block">Approve the pool contract first (ERC-721 setApprovalForAll).</span>
          </div>
        )}
        {collectionAddr.length === 42 && (
          <div className="text-sm">
            {hasPool ? (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <p className="text-emerald-400">Best {action} pool found</p>
                <p className="text-white mt-1">{action === 'buy' ? 'Cost' : 'Payout'}: {bestPool ? formatTokenAmount(formatEther(bestPool[1])) : '0'} ETH</p>
                <p className="text-xs text-white/40 mt-1">Pool: {bestPool ? `${bestPool[0].slice(0, 8)}...${bestPool[0].slice(-6)}` : ''}</p>
                {action === 'buy' && heldIds && <p className="text-xs text-white/40 mt-1">Available: {heldIds.length} NFT{heldIds.length !== 1 ? 's' : ''}</p>}
              </div>
            ) : (
              <p className="text-white/40">No {action} pools found for this collection</p>
            )}
          </div>
        )}
        {hasPool && (
          <button
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm disabled:opacity-50"
            disabled={isConfirming || (action === 'sell' && !tokenIdsInput.trim())}
            onClick={action === 'buy' ? handleBuy : handleSell}
          >
            {isConfirming ? 'Confirming...' : action === 'buy' ? `Buy ${numToBuy} NFT${Number(numToBuy) !== 1 ? 's' : ''}` : 'Sell NFTs'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Lending Section ─────────────────────────────────────────────

function LendingSection({ address }: { address?: string }) {
  const deployed = isDeployed(TEGRIDY_LENDING_ADDRESS);
  const [tab, setTab] = useState<LendingTab>('lend');
  const [principal, setPrincipal] = useState('');
  const [aprBps, setAprBps] = useState('1000');
  const [durationDays, setDurationDays] = useState('30');
  const [minCollateral, setMinCollateral] = useState('0');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: offerCount } = useReadContract({ address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI, functionName: 'offerCount', query: { enabled: deployed } });
  const { data: loanCount } = useReadContract({ address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI, functionName: 'loanCount', query: { enabled: deployed } });
  const { data: feeBps } = useReadContract({ address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI, functionName: 'protocolFeeBps', query: { enabled: deployed } });

  const handleCreateOffer = () => {
    if (!principal || Number(principal) <= 0) return toast.error('Enter a valid principal amount');
    try {
      writeContract({
        address: TEGRIDY_LENDING_ADDRESS, abi: TEGRIDY_LENDING_ABI, functionName: 'createLoanOffer',
        args: [BigInt(aprBps || '0'), BigInt(Number(durationDays || '30') * 86400), TEGRIDY_STAKING_ADDRESS, parseEther(minCollateral || '0')],
        value: parseEther(principal),
      }, { onSuccess: () => { toast.success('Loan offer created!'); setPrincipal(''); }, onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Transaction failed') });
    } catch { toast.error('Invalid input values'); }
  };

  const offerIds = offerCount ? Array.from({ length: Number(offerCount) }, (_, i) => i).reverse().slice(0, 20) : [];
  const loanIds = loanCount ? Array.from({ length: Number(loanCount) }, (_, i) => i).reverse().slice(0, 20) : [];

  if (!deployed) {
    return (
      <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
        <h2 className="heading-luxury text-xl mb-3">P2P Lending — Coming Soon</h2>
        <p className="text-white/60">Borrow ETH against your staked TOWELI positions or earn fixed-rate yield by creating loan offers. Oracle-free, pure peer-to-peer.</p>
      </div>
    );
  }

  return (
    <>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
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
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(['lend', 'borrow', 'loans'] as LendingTab[]).map((t) => (
          <button key={t} className={`px-6 py-2.5 rounded-xl text-sm font-medium transition-all ${tab === t ? 'bg-emerald-600 text-white' : 'glass-card text-white/60 hover:text-white'}`} onClick={() => setTab(t)}>
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
            <button className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-50" disabled={isConfirming || !principal} onClick={handleCreateOffer}>
              {isConfirming ? 'Creating Offer...' : 'Create Loan Offer'}
            </button>
          </div>
        </motion.div>
      ) : tab === 'borrow' ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <h2 className="heading-luxury text-xl mb-4">Available Offers</h2>
          {offerIds.length === 0 ? (
            <div className="glass-card p-8 rounded-2xl text-center"><p className="text-white/50">No loan offers yet. Be the first to create one!</p></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {offerIds.map((id) => <OfferCard key={id} offerId={id} address={address} />)}
            </div>
          )}
        </motion.div>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <h2 className="heading-luxury text-xl mb-4">My Loans</h2>
          {loanIds.length === 0 ? (
            <div className="glass-card p-8 rounded-2xl text-center"><p className="text-white/50">No loans yet.</p></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {loanIds.map((id) => <LoanCard key={id} loanId={id} address={address} />)}
            </div>
          )}
        </motion.div>
      )}
    </>
  );
}

// ─── NFT AMM Section ─────────────────────────────────────────────

function AMMSection() {
  const deployed = isDeployed(TEGRIDY_NFT_POOL_FACTORY_ADDRESS);
  const [showCreate, setShowCreate] = useState(false);
  const [nftAddr, setNftAddr] = useState('');
  const [poolType, setPoolType] = useState('2');
  const [spotPrice, setSpotPrice] = useState('0.1');
  const [delta, setDelta] = useState('0.01');
  const [feeBps, setFeeBps] = useState('200');
  const [ethLiquidity, setEthLiquidity] = useState('');
  const [nftIdsInput, setNftIdsInput] = useState('');
  const [browseAddr, setBrowseAddr] = useState('');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: poolCount } = useReadContract({ address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS, abi: TEGRIDY_NFT_POOL_FACTORY_ABI, functionName: 'getPoolCount', query: { enabled: deployed } });
  const { data: pools } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS, abi: TEGRIDY_NFT_POOL_FACTORY_ABI, functionName: 'getPoolsForCollection',
    args: [browseAddr as `0x${string}`], query: { enabled: deployed && browseAddr.length === 42 },
  });

  const handleCreatePool = () => {
    if (nftAddr.length !== 42) return toast.error('Enter a valid NFT collection address');
    try {
      const initialIds = nftIdsInput.trim() ? nftIdsInput.split(',').map(s => BigInt(s.trim())) : [];
      writeContract({
        address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS, abi: TEGRIDY_NFT_POOL_FACTORY_ABI, functionName: 'createPool',
        args: [nftAddr as `0x${string}`, Number(poolType), parseEther(spotPrice || '0'), parseEther(delta || '0'), BigInt(feeBps || '0'), initialIds],
        value: ethLiquidity ? parseEther(ethLiquidity) : BigInt(0),
      }, { onSuccess: () => { toast.success('Pool created!'); setShowCreate(false); setNftAddr(''); setNftIdsInput(''); }, onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Failed') });
    } catch { toast.error('Invalid input values'); }
  };

  if (!deployed) {
    return (
      <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
        <h2 className="heading-luxury text-xl mb-3">NFT AMM — Coming Soon</h2>
        <p className="text-white/60">Create bonding-curve liquidity pools for any NFT collection with linear pricing, buy/sell/trade pool types, and protocol-level fee routing.</p>
      </div>
    );
  }

  return (
    <>
      {/* Stats + Create */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
        <div className="glass-card px-5 py-3 rounded-xl">
          <p className="text-xs text-white/50">Total Pools</p>
          <p className="stat-value text-xl">{poolCount?.toString() ?? '0'}</p>
        </div>
        <button className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Close' : '+ Create Pool'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <motion.div className="glass-card p-6 rounded-2xl mb-8 max-w-lg" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <h2 className="heading-luxury text-xl mb-4">Create Pool</h2>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-white/50 mb-1 block">NFT Collection Address</label>
              <input type="text" value={nftAddr} onChange={(e) => setNftAddr(e.target.value)} placeholder="0x..." className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors font-mono text-sm" />
            </div>
            <div>
              <label className="text-xs text-white/50 mb-1 block">Pool Type</label>
              <div className="flex gap-2">
                {POOL_TYPES.map((label, i) => (
                  <button key={label} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${poolType === String(i) ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/60 hover:text-white border border-white/10'}`} onClick={() => setPoolType(String(i))}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-white/30 mt-1 block">{poolType === '0' ? 'Buy NFTs only' : poolType === '1' ? 'Sell NFTs only' : 'Two-sided liquidity'}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-white/50 mb-1 block">Spot Price (ETH)</label>
                <input type="number" value={spotPrice} onChange={(e) => setSpotPrice(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
              </div>
              <div>
                <label className="text-xs text-white/50 mb-1 block">Delta (ETH)</label>
                <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-white/50 mb-1 block">LP Fee (bps)</label>
                <input type="number" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                <span className="text-xs text-white/40 mt-1 block">{Number(feeBps) / 100}% (TRADE only)</span>
              </div>
              <div>
                <label className="text-xs text-white/50 mb-1 block">Initial ETH</label>
                <input type="number" value={ethLiquidity} onChange={(e) => setEthLiquidity(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
              </div>
            </div>
            <div>
              <label className="text-xs text-white/50 mb-1 block">Initial NFT IDs (comma-separated)</label>
              <input type="text" value={nftIdsInput} onChange={(e) => setNftIdsInput(e.target.value)} placeholder="1, 42, 100" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors font-mono text-sm" />
              <span className="text-xs text-white/30 mt-1 block">Approve NFTs for the factory first.</span>
            </div>
            <button className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-50" disabled={isConfirming || nftAddr.length !== 42} onClick={handleCreatePool}>
              {isConfirming ? 'Creating Pool...' : 'Create Pool'}
            </button>
          </div>
        </motion.div>
      )}

      {/* Buy/Sell + Browse */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BuySellPanel />
        <div>
          <h3 className="heading-luxury text-lg mb-4">Browse Pools</h3>
          <div className="mb-4">
            <input type="text" value={browseAddr} onChange={(e) => setBrowseAddr(e.target.value)} placeholder="Enter collection address to find pools..."
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono" />
          </div>
          {browseAddr.length === 42 && pools ? (
            pools.length === 0 ? (
              <div className="glass-card p-6 rounded-xl text-center"><p className="text-white/50 text-sm">No pools found for this collection</p></div>
            ) : (
              <div className="space-y-3">{pools.slice(0, 10).map((addr) => <PoolInfo key={addr} poolAddress={addr as `0x${string}`} />)}</div>
            )
          ) : (
            <div className="glass-card p-6 rounded-xl text-center"><p className="text-white/40 text-sm">Enter a collection address above to browse pools</p></div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main Page ───────────────────────────────────────────────────

export default function LendingPage() {
  usePageTitle('NFT Finance');
  const { isConnected, address } = useAccount();
  const [section, setSection] = useState<Section>('lending');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.15 }} />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(6,12,26,0.85) 50%, rgba(6,12,26,0.98) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16">
        <motion.div className="text-center mb-8" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl mb-3">NFT Finance</h1>
          <p className="text-white/60 max-w-lg mx-auto">Lend, borrow, and trade NFTs — all in one place.</p>
        </motion.div>

        {!isConnected ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <p className="text-white/60 mb-4">Connect your wallet to access NFT Finance</p>
            <ConnectButton />
          </div>
        ) : (
          <>
            {/* Section Toggle */}
            <div className="flex justify-center flex-wrap gap-2 mb-8">
              {([
                { key: 'lending' as Section, label: 'P2P Lending' },
                { key: 'amm' as Section, label: 'NFT AMM' },
                { key: 'launchpad' as Section, label: 'Launchpad' },
                { key: 'restake' as Section, label: 'Restake' },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  className={`px-6 py-3 rounded-xl text-sm font-semibold transition-all ${section === key ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'glass-card text-white/60 hover:text-white'}`}
                  onClick={() => setSection(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Section Content */}
            <motion.div key={section} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
              {section === 'lending' && <LendingSection address={address} />}
              {section === 'amm' && <AMMSection />}
              {section === 'launchpad' && (
                <Suspense fallback={<div className="text-center py-20 text-white/40 animate-pulse">Loading...</div>}>
                  <LaunchpadPage embedded />
                </Suspense>
              )}
              {section === 'restake' && (
                <Suspense fallback={<div className="text-center py-20 text-white/40 animate-pulse">Loading...</div>}>
                  <RestakePage embedded />
                </Suspense>
              )}
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
}
