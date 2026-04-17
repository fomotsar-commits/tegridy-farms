import { useState, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { TEGRIDY_DROP_ABI } from '../../lib/contracts';
import { ART } from '../../lib/artConfig';
import { toast } from 'sonner';
import { INPUT, LABEL, BTN_EMERALD, PHASE_LABELS } from './launchpadConstants';
import { ArtCard } from './launchpadShared';

export function OwnerAdminPanel({ dropAddress, deployed }: { dropAddress: string; deployed: boolean }) {
  const contractAddr = dropAddress as `0x${string}`;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('0');
  const [merkleRoot, setMerkleRoot] = useState('');
  const [revealURI, setRevealURI] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming || !deployed;

  const exec = useCallback(
    (fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
      if (!deployed) return;
      writeContract(
        { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: fn, args: args as never[] } as never,
        {
          onSuccess: () => {
            toast.success(`${fn} succeeded`);
            opts?.onSuccess?.();
          },
          onError: (e) => toast.error(e.message.slice(0, 80)),
        },
      );
    },
    [contractAddr, writeContract, deployed],
  );

  return (
    <ArtCard art={ART.roseApe} opacity={1} overlay="none" className="mt-6">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-sm"
      >
        <span className="text-black font-semibold tracking-wide uppercase text-[11px]">
          Owner Admin
        </span>
        <m.span
          animate={{ rotate: open ? 180 : 0 }}
          className="text-black/50 text-xs"
        >
          {'\u25BC'}
        </m.span>
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-4">
              {!deployed && (
                <p className="text-amber-400/70 text-xs text-center py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  Contract Not Deployed - Admin actions disabled
                </p>
              )}

              {/* Phase Control */}
              <div>
                <label className={LABEL}>Mint Phase</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {PHASE_LABELS.map((label, i) => (
                    <button
                      key={label}
                      className={`py-2 rounded-lg text-xs font-medium transition-all ${
                        phase === String(i)
                          ? 'bg-emerald-600 text-white shadow-[0_0_12px_-4px_rgba(16,185,129,0.4)]'
                          : 'bg-black/60 text-white hover:text-white border border-white/25 hover:border-white/20'
                      }`}
                      onClick={() => setPhase(String(i))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy}
                  onClick={() => exec('setMintPhase', [Number(phase)])}
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : 'Set Phase'}
                </button>
              </div>

              {/* Merkle Root */}
              <div>
                <label className={LABEL} htmlFor="admin-merkleRoot">Merkle Root</label>
                <input
                  id="admin-merkleRoot"
                  type="text"
                  value={merkleRoot}
                  onChange={(e) => setMerkleRoot(e.target.value)}
                  placeholder="0x..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)}
                  onClick={() =>
                    exec('setMerkleRoot', [merkleRoot as `0x${string}`], {
                      onSuccess: () => setMerkleRoot(''),
                    })
                  }
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : 'Set Merkle Root'}
                </button>
              </div>

              {/* Reveal */}
              <div>
                <label className={LABEL} htmlFor="admin-revealURI">Reveal Base URI</label>
                <input
                  id="admin-revealURI"
                  type="text"
                  value={revealURI}
                  onChange={(e) => setRevealURI(e.target.value)}
                  placeholder="ipfs://Qm..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy || !revealURI}
                  onClick={() =>
                    exec('reveal', [revealURI], { onSuccess: () => setRevealURI('') })
                  }
                >
                  {isPending || isConfirming ? 'Revealing...' : !deployed ? 'Contract Not Deployed' : 'Reveal Collection'}
                </button>
              </div>

              {/* Withdraw */}
              <button
                className="w-full py-2.5 rounded-lg bg-amber-600/70 hover:bg-amber-600 text-white text-xs font-medium border border-amber-500/20 transition-colors disabled:opacity-70 disabled:pointer-events-none"
                disabled={busy}
                onClick={() => exec('withdraw')}
              >
                {isPending || isConfirming ? 'Withdrawing...' : !deployed ? 'Contract Not Deployed' : 'Withdraw Mint Revenue'}
              </button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </ArtCard>
  );
}
