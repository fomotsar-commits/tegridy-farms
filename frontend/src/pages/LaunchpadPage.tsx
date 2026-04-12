import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LAUNCHPAD_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { useNFTDrop } from '../hooks/useNFTDrop';
import { toast } from 'sonner';

function CollectionCard({ collectionId, isSelected, onSelect }: { collectionId: number; isSelected: boolean; onSelect: (addr: string) => void }) {
  const { data: collection } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollection',
    args: [BigInt(collectionId)],
  });

  if (!collection) return <div className="glass-card p-4 rounded-xl animate-pulse h-32" />;

  const [, contractAddr, creator, name, symbol] = collection;
  const shortAddr = `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}`;
  const shortCreator = `${creator.slice(0, 6)}...${creator.slice(-4)}`;

  return (
    <div
      className={`glass-card p-5 rounded-xl hover:border-emerald-500/30 transition-all cursor-pointer ${isSelected ? 'border-emerald-500/50 ring-1 ring-emerald-500/20' : 'border border-white/5'}`}
      onClick={() => onSelect(contractAddr)}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-sm">
          {symbol.slice(0, 3)}
        </div>
        <div>
          <h3 className="text-white font-medium">{name}</h3>
          <p className="text-xs text-white/40">{symbol}</p>
        </div>
      </div>
      <div className="space-y-1.5 text-sm text-white/60">
        <div className="flex justify-between">
          <span>Contract</span>
          <a
            href={`https://etherscan.io/address/${contractAddr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {shortAddr}
          </a>
        </div>
        <div className="flex justify-between">
          <span>Creator</span>
          <span className="text-white/80">{shortCreator}</span>
        </div>
      </div>
    </div>
  );
}

function CollectionDetail({ dropAddress, onClose }: { dropAddress: string; onClose: () => void }) {
  const drop = useNFTDrop(dropAddress);
  const [mintQty, setMintQty] = useState(1);
  const shortAddr = `${dropAddress.slice(0, 6)}...${dropAddress.slice(-4)}`;

  return (
    <motion.div className="glass-card p-6 rounded-2xl mb-8" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="heading-luxury text-xl">Collection Details</h2>
        <button onClick={onClose} className="text-white/40 hover:text-white text-sm">Close</button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <div>
          <p className="text-xs text-white/50 mb-0.5">Phase</p>
          <p className="text-white font-medium">{drop.phaseLabel}</p>
        </div>
        <div>
          <p className="text-xs text-white/50 mb-0.5">Mint Price</p>
          <p className="text-white font-medium">{drop.mintPriceFormatted} ETH</p>
        </div>
        <div>
          <p className="text-xs text-white/50 mb-0.5">Minted</p>
          <p className="text-white font-medium">{drop.totalMinted} / {drop.maxSupply}</p>
        </div>
        <div>
          <p className="text-xs text-white/50 mb-0.5">Contract</p>
          <a href={`https://etherscan.io/address/${dropAddress}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline text-sm">{shortAddr}</a>
        </div>
      </div>

      {/* Progress bar */}
      {drop.maxSupply > 0 && (
        <div className="w-full h-2 rounded-full bg-white/5 mb-5 overflow-hidden">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${drop.maxSupply > 0 ? Math.min(100, (drop.totalMinted / drop.maxSupply) * 100) : 0}%` }}
          />
        </div>
      )}

      {/* Mint section */}
      {drop.isSoldOut ? (
        <p className="text-white/50 text-center text-sm">Sold out</p>
      ) : drop.currentPhase === 0 ? (
        <p className="text-white/50 text-center text-sm">Minting is paused</p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              className="w-8 h-8 rounded-lg bg-white/5 text-white hover:bg-white/10 transition-colors"
              onClick={() => setMintQty(Math.max(1, mintQty - 1))}
            >-</button>
            <span className="text-white font-medium w-8 text-center">{mintQty}</span>
            <button
              className="w-8 h-8 rounded-lg bg-white/5 text-white hover:bg-white/10 transition-colors"
              onClick={() => setMintQty(mintQty + 1)}
            >+</button>
          </div>
          <button
            className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm disabled:opacity-50"
            disabled={drop.isPending || drop.isConfirming}
            onClick={() => drop.mint(mintQty)}
          >
            {drop.isPending ? 'Confirm in wallet...' : drop.isConfirming ? 'Confirming...' : `Mint ${mintQty} (${((drop.mintPriceFormatted || 0) * mintQty).toFixed(4)} ETH)`}
          </button>
        </div>
      )}

      {drop.isOwner && (
        <p className="text-xs text-emerald-400/60 mt-3 text-center">You are the owner of this collection</p>
      )}
    </motion.div>
  );
}

export default function LaunchpadPage() {
  usePageTitle('Launchpad');
  const { isConnected } = useAccount();
  const deployed = isDeployed(TEGRIDY_LAUNCHPAD_ADDRESS);

  // Form state
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [maxSupply, setMaxSupply] = useState('10000');
  const [mintPrice, setMintPrice] = useState('0.05');
  const [maxPerWallet, setMaxPerWallet] = useState('5');
  const [royaltyBps, setRoyaltyBps] = useState('500');
  const [showForm, setShowForm] = useState(false);
  const [selectedDrop, setSelectedDrop] = useState<string | null>(null);

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: collectionCount } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollectionCount',
    query: { enabled: deployed },
  });

  const collectionIds = collectionCount
    ? Array.from({ length: Number(collectionCount) }, (_, i) => i).reverse().slice(0, 24)
    : [];

  const handleCreate = () => {
    if (!name || !symbol) return toast.error('Name and symbol are required');
    if (Number(maxSupply) === 0) return toast.error('Max supply must be > 0');
    writeContract({
      address: TEGRIDY_LAUNCHPAD_ADDRESS,
      abi: TEGRIDY_LAUNCHPAD_ABI,
      functionName: 'createCollection',
      args: [
        name,
        symbol,
        BigInt(maxSupply),
        parseEther(mintPrice || '0'),
        BigInt(maxPerWallet || '0'),
        Number(royaltyBps) as unknown as number,
      ],
    }, {
      onSuccess: () => { toast.success('Collection deployed!'); setName(''); setSymbol(''); setShowForm(false); },
      onError: (e) => toast.error(e.message.slice(0, 80)),
    });
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.15 }} />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(6,12,26,0.85) 50%, rgba(6,12,26,0.98) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16">
        <motion.div className="text-center mb-10" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl mb-3">NFT Launchpad</h1>
          <p className="text-white/60 max-w-lg mx-auto">Launch your NFT collection with built-in allowlists, Dutch auctions, reveals, and ERC-2981 royalties.</p>
        </motion.div>

        {!isConnected ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <p className="text-white/60 mb-4">Connect your wallet to launch or browse collections</p>
            <ConnectButton />
          </div>
        ) : !deployed ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <h2 className="heading-luxury text-xl mb-3">Coming Soon</h2>
            <p className="text-white/60">The Tegridy Launchpad is under development. Deploy NFT collections as minimal-proxy clones with multi-phase minting, Merkle allowlists, and Dutch auctions -- all on-chain.</p>
          </div>
        ) : (
          <>
            {/* Stats + Create button */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
              <div className="flex gap-4">
                <div className="glass-card px-5 py-3 rounded-xl">
                  <p className="text-xs text-white/50">Collections</p>
                  <p className="stat-value text-xl">{collectionCount?.toString() ?? '0'}</p>
                </div>
              </div>
              <button
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium text-sm"
                onClick={() => setShowForm(!showForm)}
              >
                {showForm ? 'Close' : '+ Launch Collection'}
              </button>
            </div>

            {/* Create form */}
            {showForm && (
              <motion.div className="glass-card p-6 rounded-2xl mb-8 max-w-lg" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
                <h2 className="heading-luxury text-xl mb-4">Create Collection</h2>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Name</label>
                      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My NFT" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Symbol</label>
                      <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MNFT" className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Max Supply</label>
                      <input type="number" value={maxSupply} onChange={(e) => setMaxSupply(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Mint Price (ETH)</label>
                      <input type="number" value={mintPrice} onChange={(e) => setMintPrice(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Max Per Wallet</label>
                      <input type="number" value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                      <span className="text-xs text-white/40 mt-1 block">0 = unlimited</span>
                    </div>
                    <div>
                      <label className="text-xs text-white/50 mb-1 block">Royalty (bps)</label>
                      <input type="number" value={royaltyBps} onChange={(e) => setRoyaltyBps(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors" />
                      <span className="text-xs text-white/40 mt-1 block">{Number(royaltyBps) / 100}%</span>
                    </div>
                  </div>
                  <button
                    className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-50"
                    disabled={isConfirming || !name || !symbol}
                    onClick={handleCreate}
                  >
                    {isConfirming ? 'Deploying...' : 'Deploy Collection'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Selected collection detail */}
            {selectedDrop && (
              <CollectionDetail dropAddress={selectedDrop} onClose={() => setSelectedDrop(null)} />
            )}

            {/* Collection grid */}
            <h2 className="heading-luxury text-xl mb-4">Collections</h2>
            {collectionIds.length === 0 ? (
              <div className="glass-card p-8 rounded-2xl text-center">
                <p className="text-white/50">No collections launched yet. Be the first!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {collectionIds.map((id) => (
                  <CollectionCard key={id} collectionId={id} isSelected={false} onSelect={(addr) => setSelectedDrop(addr)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
