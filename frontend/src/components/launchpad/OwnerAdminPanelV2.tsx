import { useMemo, useState, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_DROP_V2_ABI } from '../../lib/contracts';
import { ART } from '../../lib/artConfig';
import { INPUT, LABEL, BTN_EMERALD, PHASE_LABELS } from './launchpadConstants';
import { ArtCard } from './launchpadShared';

/// OwnerAdminPanelV2 — richer admin surface for TegridyDropV2 clones.
/// Extends the legacy panel with V2-only controls:
///   - setContractURI (ERC-7572 collection metadata update)
///   - configureDutchAuction full builder (legacy panel only toggles phase)
///   - pause / unpause
///   - 2-step ownership transfer
/// The legacy V1 panel still covers mintPhase / merkleRoot / reveal / withdraw
/// / cancelSale — don't duplicate those here. Choose the panel based on
/// whether the drop was deployed via v1 or v2 factory.
export function OwnerAdminPanelV2({ dropAddress, deployed }: {
  dropAddress: string;
  deployed: boolean;
}) {
  const contractAddr = dropAddress as `0x${string}`;
  const [open, setOpen] = useState(false);

  // Form state
  const [contractURI, setContractURI] = useState('');
  const [revealURI, setRevealURI] = useState('');
  const [baseURI, setBaseURI] = useState('');
  const [merkleRoot, setMerkleRoot] = useState('');
  const [mintPrice, setMintPrice] = useState('');
  const [maxPerWallet, setMaxPerWallet] = useState('');
  const [phase, setPhase] = useState('0');
  const [newOwner, setNewOwner] = useState('');
  const [dutchStartPrice, setDutchStartPrice] = useState('');
  const [dutchEndPrice, setDutchEndPrice] = useState('');
  const [dutchStartTime, setDutchStartTime] = useState('');
  const [dutchDuration, setDutchDuration] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming || !deployed;

  const { data: onchainPhase, refetch: refetchPhase } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'mintPhase',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const { data: currentContractURI, refetch: refetchContractURI } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'contractURI',
    query: { enabled: deployed },
  });
  const { data: isPaused, refetch: refetchPaused } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'paused',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  // AUDIT NEW-L1: read totalSupply + maxSupply to gate the Withdraw button —
  // contract now rejects withdraw() unless mintPhase == CLOSED or sold out.
  const { data: totalSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const { data: maxSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply',
    query: { enabled: deployed },
  });

  const currentPhaseNum = onchainPhase !== undefined ? Number(onchainPhase) : -1;
  const isCancelled = currentPhaseNum === 4;
  // AUDIT NEW-L1: withdraw only allowed when the sale is formally ended.
  const isClosed = currentPhaseNum === 0;
  const soldOut = (totalSupplyData !== undefined && maxSupplyData !== undefined)
    ? (totalSupplyData as bigint) >= (maxSupplyData as bigint) && (maxSupplyData as bigint) > 0n
    : false;
  const canWithdraw = !isCancelled && (isClosed || soldOut);

  if (isSuccess) {
    void refetchPhase();
    void refetchContractURI();
    void refetchPaused();
  }

  // R071 M-072-05: client-side Dutch-auction invariants mirror the Solidity
  // guards (TegridyDropV2.configureDutchAuction). Surfacing them inline lets
  // the operator fix the issue before signing — beats waiting for a revert.
  //   1. startTime > 0
  //   2. duration > 0
  //   3. startPrice > endPrice (strict)
  //   4. startPrice − endPrice >= duration (decay step ≥ 1 wei/sec — prevents
  //      a zero-decay revert from the contract)
  const dutchValidationError = useMemo<string | null>(() => {
    if (!dutchStartPrice && !dutchEndPrice && !dutchStartTime && !dutchDuration) return null;
    if (!dutchStartPrice || !dutchEndPrice || !dutchStartTime || !dutchDuration) {
      return 'Fill in all four Dutch fields to validate.';
    }
    let startWei: bigint;
    let endWei: bigint;
    try { startWei = parseEther(dutchStartPrice); } catch { return 'Start price must be a valid ETH amount.'; }
    try { endWei = parseEther(dutchEndPrice); } catch { return 'End price must be a valid ETH amount.'; }
    let startUnix: bigint;
    let durationSec: bigint;
    try { startUnix = BigInt(dutchStartTime); } catch { return 'Start time must be a unix integer.'; }
    try { durationSec = BigInt(dutchDuration); } catch { return 'Duration must be an integer (seconds).'; }
    if (startUnix <= 0n) return 'Start time must be greater than 0.';
    if (durationSec <= 0n) return 'Duration must be greater than 0.';
    if (startWei <= endWei) return 'Start price must be strictly greater than end price.';
    if (startWei - endWei < durationSec) return 'Decay step too small: (start − end) must be ≥ duration in seconds.';
    return null;
  }, [dutchStartPrice, dutchEndPrice, dutchStartTime, dutchDuration]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = useCallback((fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
    if (!deployed) return;
    writeContract(
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: fn, args: args as never[] } as any,
      {
        onSuccess: () => { toast.success(`${fn} succeeded`); opts?.onSuccess?.(); },
        onError: (e) => toast.error(e.message.slice(0, 80)),
      },
    );
  }, [contractAddr, writeContract, deployed]);

  return (
    <ArtCard art={ART.roseApe} opacity={1} overlay="none" className="mt-6">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-sm"
      >
        <span className="text-black font-semibold tracking-wide uppercase text-[11px] flex items-center gap-2">
          Owner Admin (V2)
          {isCancelled && (
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
              style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.45)', color: '#b91c1c' }}>
              Cancelled
            </span>
          )}
          {isPaused === true && (
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
              style={{ background: 'rgba(234, 179, 8, 0.15)', border: '1px solid rgba(234, 179, 8, 0.45)', color: '#a16207' }}>
              Paused
            </span>
          )}
        </span>
        <m.span animate={{ rotate: open ? 180 : 0 }} className="text-black/50 text-xs">▼</m.span>
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-4">
              {!deployed && (
                <p className="text-amber-400/70 text-xs text-center py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  Contract Not Deployed — Admin actions disabled
                </p>
              )}

              {/* Phase */}
              <AdminSection label="Mint Phase">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {PHASE_LABELS.map((label, i) => (
                    <button key={label}
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
                <ExecButton busy={busy} disabled={isCancelled} onClick={() => exec('setMintPhase', [Number(phase)])}>
                  Set Phase
                </ExecButton>
              </AdminSection>

              {/* contractURI (V2-only) */}
              <AdminSection label={`contractURI${currentContractURI ? ` (current: ${truncate(currentContractURI as string)})` : ''}`}>
                <input
                  value={contractURI}
                  onChange={(e) => setContractURI(e.target.value)}
                  placeholder="ar://…/contract.json"
                  className={`${INPUT} font-mono text-xs`}
                />
                <ExecButton busy={busy} disabled={isCancelled || !contractURI}
                  onClick={() => exec('setContractURI', [contractURI], { onSuccess: () => setContractURI('') })}>
                  Update contractURI
                </ExecButton>
              </AdminSection>

              {/* Base URI (pre-reveal placeholder) */}
              <AdminSection label="Pre-reveal Placeholder URI">
                <input
                  value={baseURI}
                  onChange={(e) => setBaseURI(e.target.value)}
                  placeholder="ar://…/placeholder"
                  className={`${INPUT} font-mono text-xs`}
                />
                <ExecButton busy={busy} disabled={isCancelled || !baseURI}
                  onClick={() => exec('setBaseURI', [baseURI], { onSuccess: () => setBaseURI('') })}>
                  Set Placeholder
                </ExecButton>
              </AdminSection>

              {/* Reveal */}
              <AdminSection label="Reveal Base URI (irreversible)">
                <input
                  value={revealURI}
                  onChange={(e) => setRevealURI(e.target.value)}
                  placeholder="ar://…/metadata/"
                  className={`${INPUT} font-mono text-xs`}
                />
                <ExecButton busy={busy} disabled={isCancelled || !revealURI}
                  onClick={() => exec('reveal', [revealURI], { onSuccess: () => setRevealURI('') })}>
                  Reveal
                </ExecButton>
              </AdminSection>

              {/* Merkle Root */}
              <AdminSection label="Merkle Root (allowlist)">
                <input
                  value={merkleRoot}
                  onChange={(e) => setMerkleRoot(e.target.value)}
                  placeholder="0x…"
                  className={`${INPUT} font-mono text-xs`}
                />
                <ExecButton busy={busy} disabled={isCancelled || !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)}
                  onClick={() => exec('setMerkleRoot', [merkleRoot as `0x${string}`], { onSuccess: () => setMerkleRoot('') })}>
                  Set Merkle Root
                </ExecButton>
              </AdminSection>

              {/* Mint price / wallet cap */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <AdminSection label="Mint Price (ETH)">
                  <input
                    type="number" step="0.001"
                    value={mintPrice}
                    onChange={(e) => setMintPrice(e.target.value)}
                    placeholder="0.05"
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <ExecButton busy={busy} disabled={isCancelled || !mintPrice}
                    onClick={() => exec('setMintPrice', [parseEther(mintPrice)], { onSuccess: () => setMintPrice('') })}>
                    Set Price
                  </ExecButton>
                </AdminSection>
                <AdminSection label="Max / Wallet">
                  <input
                    type="number"
                    value={maxPerWallet}
                    onChange={(e) => setMaxPerWallet(e.target.value)}
                    placeholder="5"
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <ExecButton busy={busy} disabled={isCancelled || !maxPerWallet}
                    onClick={() => exec('setMaxPerWallet', [BigInt(maxPerWallet)], { onSuccess: () => setMaxPerWallet('') })}>
                    Set Cap
                  </ExecButton>
                </AdminSection>
              </div>

              {/* Dutch Auction — full config builder */}
              <AdminSection label="Dutch Auction Configuration">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number" step="0.001"
                    value={dutchStartPrice}
                    onChange={(e) => setDutchStartPrice(e.target.value)}
                    placeholder="Start (ETH)"
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <input
                    type="number" step="0.001"
                    value={dutchEndPrice}
                    onChange={(e) => setDutchEndPrice(e.target.value)}
                    placeholder="End (ETH)"
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <input
                    type="number"
                    value={dutchStartTime}
                    onChange={(e) => setDutchStartTime(e.target.value)}
                    placeholder="Start (unix)"
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <input
                    type="number"
                    value={dutchDuration}
                    onChange={(e) => setDutchDuration(e.target.value)}
                    placeholder="Duration (sec)"
                    className={`${INPUT} font-mono text-xs`}
                  />
                </div>
                <ExecButton busy={busy}
                  disabled={isCancelled || !dutchStartPrice || !dutchEndPrice || !dutchStartTime || !dutchDuration}
                  onClick={() => exec('configureDutchAuction', [
                    parseEther(dutchStartPrice),
                    parseEther(dutchEndPrice),
                    BigInt(dutchStartTime),
                    BigInt(dutchDuration),
                  ])}>
                  Configure Dutch Auction
                </ExecButton>
              </AdminSection>

              {/* Pause */}
              <AdminSection label="Emergency Controls">
                <div className="grid grid-cols-2 gap-2">
                  <ExecButton busy={busy} disabled={isPaused === true || isCancelled} onClick={() => exec('pause')}>
                    Pause
                  </ExecButton>
                  <ExecButton busy={busy} disabled={isPaused !== true || isCancelled} onClick={() => exec('unpause')}>
                    Unpause
                  </ExecButton>
                </div>
              </AdminSection>

              {/* Ownership Transfer */}
              <AdminSection label="Transfer Ownership (2-step)">
                <input
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                  placeholder="0x… new owner address"
                  className={`${INPUT} font-mono text-xs`}
                />
                <ExecButton busy={busy} disabled={!/^0x[0-9a-fA-F]{40}$/.test(newOwner)}
                  onClick={() => exec('transferOwnership', [newOwner as `0x${string}`], { onSuccess: () => setNewOwner('') })}>
                  Initiate Transfer
                </ExecButton>
                <p className="text-[10px] text-black/60 mt-1">
                  New owner must call <code className="font-mono">acceptOwnership()</code> to complete.
                </p>
              </AdminSection>

              {/* Withdraw — AUDIT NEW-L1: contract rejects withdraw() unless the
                   sale is formally ended (mintPhase == CLOSED or sold-out). The
                   button + tooltip surface the gate so creators don't hit a
                   mid-mint revert. */}
              <button
                className="w-full py-2.5 rounded-lg bg-amber-600/70 hover:bg-amber-600 text-white text-xs font-medium border border-amber-500/20 transition-colors disabled:opacity-70"
                disabled={busy || !canWithdraw}
                title={
                  canWithdraw
                    ? 'Withdraw mint proceeds (creator + platform split)'
                    : soldOut
                      ? 'Sold out — withdraw available'
                      : 'Close the mint (phase → CLOSED) or wait until sold out before withdrawing.'
                }
                onClick={() => exec('withdraw')}
              >
                Withdraw Mint Revenue
                {!canWithdraw && !isCancelled && (
                  <span className="ml-2 text-[10px] opacity-70">(close sale first)</span>
                )}
              </button>

              {/* Danger Zone */}
              <div className="mt-6 rounded-lg p-3"
                style={{ background: 'rgba(239, 68, 68, 0.04)', border: '1px solid rgba(239, 68, 68, 0.20)' }}>
                <div className="text-red-300 text-[11px] font-semibold uppercase tracking-wider mb-2">
                  Danger zone
                </div>
                <p className="text-white/60 text-[11px] leading-relaxed mb-3">
                  Cancel the sale permanently. Buyers become eligible for refunds. Irreversible.
                </p>
                <button
                  className="w-full py-2 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                  style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    borderColor: 'rgba(239, 68, 68, 0.35)',
                    color: '#fca5a5',
                  }}
                  disabled={busy || isCancelled}
                  onClick={() => {
                    const ok = typeof window !== 'undefined' && window.confirm(
                      'Cancel the sale? This cannot be undone.'
                    );
                    if (ok) exec('cancelSale');
                  }}
                >
                  {isCancelled ? 'Already Cancelled' : 'Cancel Sale (Irreversible)'}
                </button>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </ArtCard>
  );
}

// ─── Internal helpers ────────────────────────────────────────────

function AdminSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
    </div>
  );
}

function ExecButton({
  busy,
  disabled,
  onClick,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD} disabled:opacity-40`}
      disabled={busy || disabled}
      onClick={onClick}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 3)}…` : s;
}
