import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther, formatEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_NFT_POOL_FACTORY_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_NFT_POOL_FACTORY_ABI, TEGRIDY_NFT_POOL_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatTokenAmount } from '../lib/formatting';
import { toast } from 'sonner';

const POOL_TYPES = ['BUY', 'SELL', 'TRADE'] as const;

function PoolInfo({ poolAddress }: { poolAddress: `0x${string}` }) {
  const { data: info } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getPoolInfo',
  });

  const { data: heldIds } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getHeldTokenIds',
  });

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
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestBuyPool',
    args: [collectionAddr as `0x${string}`, BigInt(numToBuy || '1')],
    query: { enabled: collectionAddr.length === 42 && action === 'buy' },
  });

  const { data: bestSell } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestSellPool',
    args: [collectionAddr as `0x${string}`, BigInt(1)],
    query: { enabled: collectionAddr.length === 42 && action === 'sell' },
  });

  const bestPool = action === 'buy' ? bestBuy : bestSell;
  const hasPool = bestPool && bestPool[0] !== '0x0000000000000000000000000000000000000000';
  const bestPoolAddr = hasPool ? bestPool[0] as `0x${string}` : undefined;

  // Get held token IDs for the best buy pool (so user can pick which to buy)
  const { data: heldIds } = useReadContract({
    address: bestPoolAddr,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getHeldTokenIds',
    query: { enabled: !!bestPoolAddr && action === 'buy' },
  });

  const handleBuy = () => {
    if (!bestPoolAddr || !heldIds || heldIds.length === 0) return toast.error('No NFTs available');
    const count = Number(numToBuy || '1');
    const ids = heldIds.slice(0, count);
    if (ids.length === 0) return toast.error('No NFTs available');

    writeContract({
      address: bestPoolAddr,
      abi: TEGRIDY_NFT_POOL_ABI,
      functionName: 'swapETHForNFTs',
      args: [ids],
      value: bestPool![1], // cost from quote
    }, {
      onSuccess: () => toast.success(`Bought ${ids.length} NFT(s)!`),
      onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Transaction failed'),
    });
  };

  const handleSell = () => {
    if (!bestPoolAddr) return toast.error('No sell pool found');
    const ids = tokenIdsInput.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return toast.error('Enter token IDs to sell');

    try {
      writeContract({
        address: bestPoolAddr,
        abi: TEGRIDY_NFT_POOL_ABI,
        functionName: 'swapNFTsForETH',
        args: [ids.map(id => BigInt(id)), BigInt(0)], // minOutput 0 for simplicity
      }, {
        onSuccess: () => { toast.success(`Sold ${ids.length} NFT(s)!`); setTokenIdsInput(''); },
        onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Transaction failed'),
      });
    } catch { toast.error('Invalid token IDs'); }
  };

  return (
    <div className="glass-card p-6 rounded-2xl">
      <h2 className="heading-luxury text-xl mb-4">Buy / Sell NFTs</h2>
      <div className="flex gap-2 mb-4">
        <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${action === 'buy' ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`} onClick={() => setAction('buy')}>Buy</button>
        <button className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${action === 'sell' ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`} onClick={() => setAction('sell')}>Sell</button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-white/50 mb-1 block">Collection Address</label>
          <input
            type="text"
            value={collectionAddr}
            onChange={(e) => setCollectionAddr(e.target.value)}
            placeholder="0x..."
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono"
          />
        </div>

        {action === 'buy' && (
          <div>
            <label className="text-xs text-white/50 mb-1 block">Quantity</label>
            <input
              type="number"
              value={numToBuy}
              onChange={(e) => setNumToBuy(e.target.value)}
              min="1"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm"
            />
          </div>
        )}

        {action === 'sell' && (
          <div>
            <label className="text-xs text-white/50 mb-1 block">Token IDs to Sell (comma-separated)</label>
            <input
              type="text"
              value={tokenIdsInput}
              onChange={(e) => setTokenIdsInput(e.target.value)}
              placeholder="1, 42, 100"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono"
            />
            <span className="text-xs text-white/30 mt-1 block">You must approve the pool contract first (ERC-721 setApprovalForAll).</span>
          </div>
        )}

        {collectionAddr.length === 42 && (
          <div className="text-sm text-white/60">
            {hasPool ? (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <p className="text-emerald-400">Best {action} pool found</p>
                <p className="text-white mt-1">
                  {action === 'buy' ? 'Cost' : 'Payout'}: {bestPool ? formatTokenAmount(formatEther(bestPool[1])) : '0'} ETH
                </p>
                <p className="text-xs text-white/40 mt-1">
                  Pool: {bestPool ? `${bestPool[0].slice(0, 8)}...${bestPool[0].slice(-6)}` : ''}
                </p>
                {action === 'buy' && heldIds && (
                  <p className="text-xs text-white/40 mt-1">
                    Available: {heldIds.length} NFT{heldIds.length !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-white/40">No {action} pools found for this collection</p>
            )}
          </div>
        )}

        {/* Execute button */}
        {hasPool && (
          <button
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm disabled:opacity-50"
            disabled={isConfirming || (action === 'sell' && !tokenIdsInput.trim())}
            onClick={action === 'buy' ? handleBuy : handleSell}
          >
            {isConfirming ? 'Confirming...' : action === 'buy'
              ? `Buy ${numToBuy} NFT${Number(numToBuy) !== 1 ? 's' : ''}`
              : `Sell NFT${tokenIdsInput.split(',').filter(s => s.trim()).length !== 1 ? 's' : ''}`
            }
          </button>
        )}
      </div>
    </div>
  );
}

export default function NFTAMMPage() {
  usePageTitle('NFT AMM');
  const { isConnected } = useAccount();
  const deployed = isDeployed(TEGRIDY_NFT_POOL_FACTORY_ADDRESS);

  // Create pool form
  const [showCreate, setShowCreate] = useState(false);
  const [nftAddr, setNftAddr] = useState('');
  const [poolType, setPoolType] = useState('2'); // TRADE
  const [spotPrice, setSpotPrice] = useState('0.1');
  const [delta, setDelta] = useState('0.01');
  const [feeBps, setFeeBps] = useState('200');
  const [ethLiquidity, setEthLiquidity] = useState('');
  const [nftIdsInput, setNftIdsInput] = useState('');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: poolCount } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolCount',
    query: { enabled: deployed },
  });

  // Fetch pools for a given collection
  const [browseAddr, setBrowseAddr] = useState('');
  const { data: pools } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolsForCollection',
    args: [browseAddr as `0x${string}`],
    query: { enabled: deployed && browseAddr.length === 42 },
  });

  const handleCreatePool = () => {
    if (nftAddr.length !== 42) return toast.error('Enter a valid NFT collection address');
    try {
      const initialIds = nftIdsInput.trim()
        ? nftIdsInput.split(',').map(s => BigInt(s.trim()))
        : [];

      writeContract({
        address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
        abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
        functionName: 'createPool',
        args: [
          nftAddr as `0x${string}`,
          Number(poolType),
          parseEther(spotPrice || '0'),
          parseEther(delta || '0'),
          BigInt(feeBps || '0'),
          initialIds,
        ],
        value: ethLiquidity ? parseEther(ethLiquidity) : BigInt(0),
      }, {
        onSuccess: () => { toast.success('Pool created!'); setShowCreate(false); setNftAddr(''); setNftIdsInput(''); },
        onError: (e: any) => toast.error(e.message?.slice(0, 80) || 'Transaction failed'),
      });
    } catch { toast.error('Invalid input values'); }
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.poolParty.src} alt="" className="w-full h-full object-cover" style={{ opacity: 1 }} />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(6,12,26,0.85) 50%, rgba(6,12,26,0.88) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16">
        <motion.div className="text-center mb-10" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl mb-3">NFT AMM</h1>
          <p className="text-white/60 max-w-lg mx-auto">Instant NFT liquidity with bonding-curve pools. Buy, sell, or provide two-sided liquidity for any ERC-721 collection.</p>
        </motion.div>

        {!isConnected ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <p className="text-white/60 mb-4">Connect your wallet to trade NFTs or create pools</p>
            <ConnectButton />
          </div>
        ) : !deployed ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <h2 className="heading-luxury text-xl mb-3">Coming Soon</h2>
            <p className="text-white/60">The Tegridy NFT AMM is being finalized. Create bonding-curve liquidity pools for any NFT collection with linear pricing, buy/sell/trade pool types, and protocol-level fee routing.</p>
          </div>
        ) : (
          <>
            {/* Stats + Create button */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
              <div className="glass-card px-5 py-3 rounded-xl">
                <p className="text-xs text-white/50">Total Pools</p>
                <p className="stat-value text-xl">{poolCount?.toString() ?? '0'}</p>
              </div>
              <button
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm"
                onClick={() => setShowCreate(!showCreate)}
              >
                {showCreate ? 'Close' : '+ Create Pool'}
              </button>
            </div>

            {/* Create pool form */}
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
                        <button
                          key={label}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                            poolType === String(i)
                              ? 'bg-emerald-600 text-white'
                              : 'bg-white/5 text-white/60 hover:text-white border border-white/10'
                          }`}
                          onClick={() => setPoolType(String(i))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="text-xs text-white/30 mt-1 block">
                      {poolType === '0' ? 'Buy NFTs only' : poolType === '1' ? 'Sell NFTs only' : 'Two-sided liquidity'}
                    </span>
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
                      <span className="text-xs text-white/40 mt-1 block">{Number(feeBps) / 100}% (TRADE pools only)</span>
                    </div>
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Initial ETH (optional)</label>
                      <input type="number" value={ethLiquidity} onChange={(e) => setEthLiquidity(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/50 mb-1 block">Initial NFT Token IDs (comma-separated, optional)</label>
                    <input
                      type="text"
                      value={nftIdsInput}
                      onChange={(e) => setNftIdsInput(e.target.value)}
                      placeholder="1, 42, 100"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors font-mono text-sm"
                    />
                    <span className="text-xs text-white/30 mt-1 block">Approve NFTs for the factory contract before creating the pool.</span>
                  </div>
                  <button
                    className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-50"
                    disabled={isConfirming || nftAddr.length !== 42}
                    onClick={handleCreatePool}
                  >
                    {isConfirming ? 'Creating Pool...' : 'Create Pool'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Buy/Sell panel + Pool browser */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <BuySellPanel />

              <div>
                <h2 className="heading-luxury text-xl mb-4">Browse Pools</h2>
                <div className="mb-4">
                  <input
                    type="text"
                    value={browseAddr}
                    onChange={(e) => setBrowseAddr(e.target.value)}
                    placeholder="Enter collection address to find pools..."
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors text-sm font-mono"
                  />
                </div>
                {browseAddr.length === 42 && pools ? (
                  pools.length === 0 ? (
                    <div className="glass-card p-6 rounded-xl text-center">
                      <p className="text-white/50 text-sm">No pools found for this collection</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pools.slice(0, 10).map((addr) => (
                        <PoolInfo key={addr} poolAddress={addr as `0x${string}`} />
                      ))}
                    </div>
                  )
                ) : (
                  <div className="glass-card p-6 rounded-xl text-center">
                    <p className="text-white/40 text-sm">Enter a collection address above to browse pools</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
