import { useState, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { TEGRIDY_DROP_V2_ABI } from '../../lib/contracts';
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
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming || !deployed;

  // Read current on-chain phase so the admin panel can surface CANCELLED state.
  // MintPhase enum: 0=CLOSED, 1=ALLOWLIST, 2=PUBLIC, 3=DUTCH_AUCTION, 4=CLOSED_AGAIN, 5=CANCELLED.
  const { data: onchainPhase, refetch: refetchPhase } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'mintPhase',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const currentPhaseNum = onchainPhase !== undefined ? Number(onchainPhase) : -1;
  const isCancelled = currentPhaseNum === 5;
  // AUDIT NEW-L1: gate Withdraw button — contract rejects withdraw() unless
  // mintPhase == CLOSED (0) or sold out. `totalSupply` and `maxSupply` read
  // so we can surface sold-out as an alternative unlock.
  const isClosed = currentPhaseNum === 0;
  const { data: totalSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const { data: maxSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply',
    query: { enabled: deployed },
  });
  const soldOut = (totalSupplyData !== undefined && maxSupplyData !== undefined)
    ? (totalSupplyData as bigint) >= (maxSupplyData as bigint) && (maxSupplyData as bigint) > 0n
    : false;
  const canWithdraw = !isCancelled && (isClosed || soldOut);
  // Refetch phase after any successful tx (e.g. cancelSale) so the indicator
  // updates without a page reload.
  if (isSuccess) { void refetchPhase(); }

  const exec = useCallback(
    (fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
      if (!deployed) return;
      writeContract(
        { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: fn, args: args as never[] } as never,
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
        <span className="text-black font-semibold tracking-wide uppercase text-[11px] flex items-center gap-2">
          Owner Admin
          {isCancelled && (
            <span
              className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.45)',
                color: '#b91c1c',
              }}
              aria-label="Sale is cancelled — refunds are open"
            >
              Cancelled
            </span>
          )}
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
                  disabled={busy || isCancelled}
                  title={isCancelled ? 'Sale is cancelled — phase transitions blocked by the contract.' : undefined}
                  onClick={() => exec('setMintPhase', [Number(phase)])}
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : isCancelled ? 'Sale Cancelled' : 'Set Phase'}
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
                  disabled={busy || isCancelled || !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)}
                  title={isCancelled ? 'Sale is cancelled.' : undefined}
                  onClick={() =>
                    exec('setMerkleRoot', [merkleRoot as `0x${string}`], {
                      onSuccess: () => setMerkleRoot(''),
                    })
                  }
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : isCancelled ? 'Sale Cancelled' : 'Set Merkle Root'}
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
                  disabled={busy || isCancelled || !revealURI}
                  title={isCancelled ? 'Sale is cancelled.' : undefined}
                  onClick={() =>
                    exec('reveal', [revealURI], { onSuccess: () => setRevealURI('') })
                  }
                >
                  {isPending || isConfirming ? 'Revealing...' : !deployed ? 'Contract Not Deployed' : isCancelled ? 'Sale Cancelled' : 'Reveal Collection'}
                </button>
              </div>

              {/* Withdraw — AUDIT NEW-L1: contract rejects withdraw() unless
                   mintPhase == CLOSED or sold out. Surfacing that gate here so
                   creators don't hit a mid-mint revert and so the "commit to
                   delivery" signal is explicit. */}
              <button
                className="w-full py-2.5 rounded-lg bg-amber-600/70 hover:bg-amber-600 text-white text-xs font-medium border border-amber-500/20 transition-colors disabled:opacity-70 disabled:pointer-events-none"
                disabled={busy || !canWithdraw}
                title={
                  isCancelled
                    ? 'Withdraw blocked — sale is cancelled. Buyers may claim refunds.'
                    : canWithdraw
                      ? (soldOut ? 'Sold out — withdraw available.' : 'Sale is closed — withdraw available.')
                      : 'Close the mint (phase → CLOSED) or wait until sold out before withdrawing.'
                }
                onClick={() => exec('withdraw')}
              >
                {isPending || isConfirming
                  ? 'Withdrawing...'
                  : !deployed
                    ? 'Contract Not Deployed'
                    : isCancelled
                      ? 'Blocked — Sale Cancelled'
                      : !canWithdraw
                        ? 'Withdraw Mint Revenue (close sale first)'
                        : 'Withdraw Mint Revenue'}
              </button>

              {/* Danger Zone — cancelSale is IRREVERSIBLE; moves contract to
                   MintPhase.CANCELLED, blocks withdraw, enables buyer refunds. */}
              <div
                className="mt-6 rounded-lg p-3"
                style={{
                  background: 'rgba(239, 68, 68, 0.04)',
                  border: '1px solid rgba(239, 68, 68, 0.20)',
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <line x1="12" y1="8" x2="12" y2="13" />
                    <line x1="12" y1="16.5" x2="12" y2="16.5" />
                  </svg>
                  <span className="text-red-300 text-[11px] font-semibold uppercase tracking-wider">Danger zone</span>
                </div>
                <p className="text-white/60 text-[11px] leading-relaxed mb-3">
                  Cancel the sale permanently. This is <strong>irreversible</strong>: buyers become eligible for refunds, and future mint phases and withdrawals are blocked. Use only if the sale is abandoned.
                </p>
                <button
                  className="w-full py-2 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                  style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    borderColor: 'rgba(239, 68, 68, 0.35)',
                    color: '#fca5a5',
                  }}
                  disabled={busy || isCancelled}
                  title={isCancelled ? 'Sale already cancelled. Buyers can claim refunds via the collection page.' : undefined}
                  onClick={() => {
                    // Double-confirm destructive action.
                    const ok = typeof window !== 'undefined' && window.confirm(
                      'Cancel the sale? This cannot be undone. Buyers will be able to claim refunds and no further mints will be possible.'
                    );
                    if (ok) exec('cancelSale');
                  }}
                >
                  {isPending || isConfirming ? 'Cancelling…' : !deployed ? 'Contract Not Deployed' : isCancelled ? 'Already Cancelled' : 'Cancel Sale (Irreversible)'}
                </button>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </ArtCard>
  );
}
