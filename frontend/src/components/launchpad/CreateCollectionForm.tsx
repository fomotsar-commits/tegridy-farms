import { useState } from 'react';
import { m } from 'framer-motion';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { ART } from '../../lib/artConfig';
import { TEGRIDY_LAUNCHPAD_ADDRESS } from '../../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI } from '../../lib/contracts';
import { toast } from 'sonner';
import { INPUT, LABEL, BTN_EMERALD } from './launchpadConstants';
import { ArtCard, PhaseBadge } from './launchpadShared';

export function CreateCollectionForm({ onCreated, deployed }: { onCreated: () => void; deployed: boolean }) {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [maxSupply, setMaxSupply] = useState('10000');
  const [mintPrice, setMintPrice] = useState('0.05');
  const [maxPerWallet, setMaxPerWallet] = useState('5');
  const [royaltyBps, setRoyaltyBps] = useState(500);

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming;

  const royaltyPct = (royaltyBps / 100).toFixed(1);
  const royaltyFillPct = (royaltyBps / 1000) * 100;

  const handleCreate = () => {
    if (!deployed) return toast.error('Contracts not deployed yet');
    if (!name || !symbol) return toast.error('Name and symbol are required');
    if (Number(maxSupply) === 0) return toast.error('Max supply must be greater than 0');

    writeContract(
      {
        address: TEGRIDY_LAUNCHPAD_ADDRESS,
        abi: TEGRIDY_LAUNCHPAD_ABI,
        functionName: 'createCollection',
        args: [
          name,
          symbol,
          BigInt(maxSupply),
          parseEther(mintPrice || '0'),
          BigInt(maxPerWallet || '0'),
          royaltyBps,
        ],
      },
      {
        onSuccess: () => {
          toast.success('Collection deployed!');
          setName('');
          setSymbol('');
          onCreated();
        },
        onError: (e) => toast.error(e.message.slice(0, 80)),
      },
    );
  };

  return (
    <m.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-8"
    >
      <ArtCard art={ART.chaosScene} opacity={1} overlay="none" className="rounded-2xl">
        <div className="p-1 sm:p-3">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
            {/* Form Fields */}
            <div>
              <h2 className="heading-luxury text-xl mb-6">Create Collection</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
                <div>
                  <label className={LABEL} htmlFor="create-name">Name</label>
                  <input
                    id="create-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My NFT"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-symbol">Symbol</label>
                  <input
                    id="create-symbol"
                    type="text"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    placeholder="MNFT"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-maxSupply">Max Supply</label>
                  <input
                    id="create-maxSupply"
                    type="number"
                    value={maxSupply}
                    onChange={(e) => setMaxSupply(String(Math.max(0, parseInt(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-mintPrice">Mint Price (ETH)</label>
                  <input
                    id="create-mintPrice"
                    type="number"
                    value={mintPrice}
                    onChange={(e) => setMintPrice(String(Math.max(0, parseFloat(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-maxPerWallet">Max Per Wallet</label>
                  <input
                    id="create-maxPerWallet"
                    type="number"
                    value={maxPerWallet}
                    onChange={(e) => setMaxPerWallet(String(Math.max(0, parseInt(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                  <span className="text-[10px] text-white mt-1 block">0 = unlimited</span>
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-royalty">Royalty ({royaltyPct}%)</label>
                  <input
                    id="create-royalty"
                    type="range"
                    min={0}
                    max={1000}
                    step={25}
                    value={royaltyBps}
                    onChange={(e) => setRoyaltyBps(Number(e.target.value))}
                    className="w-full h-1.5 rounded-full appearance-none bg-black/60 accent-emerald-500 cursor-pointer mt-2"
                  />
                  {/* Royalty fill visualization */}
                  <div className="w-full h-1.5 rounded-full bg-black/60 overflow-hidden mt-1.5" role="progressbar" aria-valuenow={Math.round(royaltyFillPct)} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-300"
                      style={{ width: `${royaltyFillPct}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-white mt-1">
                    <span>0%</span>
                    <span className="text-black/60 font-mono">{royaltyBps} bps</span>
                    <span>10%</span>
                  </div>
                </div>
              </div>

              <button
                className={`mt-6 w-full py-3 rounded-xl text-sm ${BTN_EMERALD}`}
                disabled={busy || !name || !symbol || !deployed}
                onClick={handleCreate}
              >
                {!deployed
                  ? 'Contract Not Deployed'
                  : busy
                    ? 'Deploying...'
                    : 'Deploy Collection'}
              </button>
            </div>

            {/* Preview Card */}
            <div className="hidden lg:block">
              <label className={LABEL}>Live Preview</label>
              <ArtCard art={ART.galleryCollage} opacity={1} overlay="none" className="mt-1.5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center text-black font-bold text-xs">
                      {(symbol || '???').slice(0, 3)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-white font-medium truncate text-sm">{name || 'Collection Name'}</h3>
                      <span className="inline-block text-[10px] uppercase tracking-wider label-pill text-black/70 bg-emerald-500/30 px-1.5 py-0.5 rounded mt-0.5">
                        {symbol || 'SYM'}
                      </span>
                    </div>
                  </div>
                  <PhaseBadge phase={0} />
                </div>
                {/* Mini progress preview */}
                <div className="mb-3">
                  <div className="flex justify-between text-[10px] text-white mb-1">
                    <span className="font-mono">0/{maxSupply || '0'}</span>
                    <span className="font-mono">0%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-black/60" />
                </div>
                <div className="space-y-1.5 text-xs text-white">
                  <div className="flex justify-between">
                    <span>Supply</span>
                    <span className="text-white font-mono tabular-nums">{maxSupply || '0'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Price</span>
                    <span className="text-white font-mono tabular-nums">{mintPrice || '0'} ETH</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Royalty</span>
                    <span className="text-white font-mono tabular-nums">{royaltyPct}%</span>
                  </div>
                </div>
              </ArtCard>
            </div>
          </div>
        </div>
      </ArtCard>
    </m.div>
  );
}
