import { useEffect, useMemo, useState, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { parseEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_DROP_V2_ABI } from '../../lib/contracts';
import { CHAIN_ID } from '../../lib/constants';
import { safeParseEther } from '../../lib/safeParseEther';
import { pageArt } from '../../lib/artConfig';
import { INPUT, LABEL, BTN_EMERALD, PHASE_LABELS } from './launchpadConstants';
import { ArtCard } from './launchpadShared';
import { TypedConfirmation } from '../ui/TypedConfirmation';

/** Whole non-negative integer, as typed. `type=number` still admits "1.5" and "1e3". */
function safeWholeBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** unix seconds ⇄ the local-time shape `datetime-local` requires. */
function unixToLocalInput(unix: string): string {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToUnix(value: string): string {
  if (!value) return '';
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : '';
}

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
  // null = follow the chain. The grid must not open on a phase the contract
  // isn't in — that turns one stray click into a closed live mint.
  const [phase, setPhase] = useState<string | null>(null);
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
    chainId: CHAIN_ID,
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const { data: currentContractURI, refetch: refetchContractURI } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'contractURI',
    chainId: CHAIN_ID,
    query: { enabled: deployed },
  });
  const { data: isPaused, refetch: refetchPaused } = useReadContract({
    address: contractAddr,
    abi: TEGRIDY_DROP_V2_ABI,
    functionName: 'paused',
    chainId: CHAIN_ID,
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  // AUDIT NEW-L1: read totalSupply + maxSupply to gate the Withdraw button —
  // contract now rejects withdraw() unless mintPhase == CLOSED or sold out.
  const { data: totalSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply',
    chainId: CHAIN_ID,
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const { data: maxSupplyData } = useReadContract({
    address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply',
    chainId: CHAIN_ID,
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
  const selectedPhase =
    phase ?? (currentPhaseNum >= 0 && currentPhaseNum <= 3 ? String(currentPhaseNum) : '0');

  // F250: refetch in an effect, not the render body — `isSuccess` stays true
  // until the next tx, so a render-body refetch resolved → re-render → refetched
  // indefinitely. Keyed on isSuccess so it fires once per confirmed tx.
  useEffect(() => {
    if (isSuccess) {
      void refetchPhase();
      void refetchContractURI();
      void refetchPaused();
    }
  }, [isSuccess, refetchPhase, refetchContractURI, refetchPaused]);

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

  // A throw out of a click handler is caught by the page ErrorBoundary, not by
  // anything that can tell the operator what was wrong with the field. Both
  // inputs are `type=number`, which still admits "1e3" and "1.5" — values viem
  // and BigInt reject by throwing.
  const mintPriceWei = useMemo(() => safeParseEther(mintPrice), [mintPrice]);
  const maxPerWalletBig = useMemo(() => safeWholeBigInt(maxPerWallet), [maxPerWallet]);

  const chainId = useChainId();

  const exec = useCallback((fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
    // AUDIT FIX M-8: refuse on wrong chain so admin actions aren't sent to a
    // phantom address on Sepolia/Base/Arbitrum.
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!deployed) return;
    // wagmi's writeContract argument is a discriminated union over functionName;
    // we pass a runtime-chosen `fn`, so the typed shape can't be derived. Cast
    // to a structural Parameters[0] to satisfy the type without `any`.
    type WriteArg = Parameters<typeof writeContract>[0];
    writeContract(
      { chainId: CHAIN_ID, address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: fn, args: args as never[] } as unknown as WriteArg,
      {
        onSuccess: () => { toast.success(`${fn} succeeded`); opts?.onSuccess?.(); },
        onError: (e) => toast.error(e.message.slice(0, 80)),
      },
    );
  }, [contractAddr, writeContract, deployed, chainId]);

  return (
    <ArtCard art={pageArt('launchpad-owner', 0)} opacity={1} overlay="none" className="mt-6">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-sm"
      >
        <span className="text-white font-semibold tracking-wide uppercase text-[11px] flex items-center gap-2">
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
        <m.span animate={{ rotate: open ? 180 : 0 }} className="text-white/50 text-xs">▼</m.span>
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

              {/* Phase — R071 H-072-01: only 0..3 are settable via setMintPhase.
                  CANCELLED (4) is reachable only via cancelSale() in the Danger
                  Zone; the contract reverts on setMintPhase(CANCELLED). */}
              <AdminSection label="Mint Phase">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {PHASE_LABELS.slice(0, 4).map((label, i) => {
                    const isLive = currentPhaseNum === i;
                    return (
                      <button key={label}
                        aria-pressed={selectedPhase === String(i)}
                        className={`py-2 rounded-lg text-xs font-medium transition-all ${
                          selectedPhase === String(i)
                            ? 'bg-emerald-600 text-white shadow-[0_0_12px_-4px_rgba(16,185,129,0.4)]'
                            : 'bg-black/60 text-white hover:text-white border border-white/25 hover:border-white/20'
                        } ${isLive ? 'ring-1 ring-emerald-400/60' : ''}`}
                        onClick={() => setPhase(String(i))}
                      >
                        {label}
                        {isLive && <span className="block text-[9px] opacity-80">on-chain now</span>}
                      </button>
                    );
                  })}
                </div>
                {/* A stray click here can close a live mint. The grid opens on
                    the phase the contract is actually in, and the write is
                    refused when it would be a no-op, so "Set Phase" is only
                    ever reachable as a deliberate change. */}
                <p className="text-[10px] text-white/60 mt-2">
                  {currentPhaseNum >= 0
                    ? `Contract is currently in ${PHASE_LABELS[currentPhaseNum] ?? 'an unknown phase'}.`
                    : 'Current phase not read yet — the selection below is not confirmed against the contract.'}
                </p>
                <ExecButton
                  busy={busy}
                  disabled={isCancelled || currentPhaseNum < 0 || selectedPhase === String(currentPhaseNum)}
                  onClick={() => exec('setMintPhase', [Number(selectedPhase)])}
                >
                  {selectedPhase === String(currentPhaseNum)
                    ? 'Already in this phase'
                    : `Set Phase → ${PHASE_LABELS[Number(selectedPhase)] ?? selectedPhase}`}
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
                  {mintPrice !== '' && mintPriceWei === null && (
                    <p role="alert" className="mt-1 text-[11px] text-red-400">
                      Enter a plain decimal amount — no exponent notation, at most 18 decimals.
                    </p>
                  )}
                  <ExecButton busy={busy} disabled={isCancelled || mintPriceWei === null}
                    onClick={() => exec('setMintPrice', [mintPriceWei], { onSuccess: () => setMintPrice('') })}>
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
                  {maxPerWallet !== '' && maxPerWalletBig === null && (
                    <p role="alert" className="mt-1 text-[11px] text-red-400">
                      Enter a whole number of tokens.
                    </p>
                  )}
                  <ExecButton busy={busy} disabled={isCancelled || maxPerWalletBig === null}
                    onClick={() => exec('setMaxPerWallet', [maxPerWalletBig], { onSuccess: () => setMaxPerWallet('') })}>
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
                  {/* Stored as unix seconds — the contract's unit — but typed as
                      a wall-clock time, because a hand-converted epoch is how an
                      auction starts a month off by one digit. */}
                  <input
                    type="datetime-local"
                    aria-label="Dutch auction start time"
                    value={unixToLocalInput(dutchStartTime)}
                    onChange={(e) => setDutchStartTime(localInputToUnix(e.target.value))}
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
                <div className="mt-2 flex items-center gap-2 text-[10px] text-white/60">
                  <button
                    type="button"
                    className="px-2 py-1 rounded border border-white/20 hover:border-white/40 transition-colors"
                    onClick={() => setDutchStartTime(String(Math.floor(Date.now() / 1000) + 3600))}
                  >
                    Start in 1 hour
                  </button>
                  {dutchStartTime && (
                    <span className="font-mono">unix {dutchStartTime}</span>
                  )}
                </div>
                {dutchValidationError && (
                  <p role="alert" className="mt-2 text-[11px] text-red-400">
                    {dutchValidationError}
                  </p>
                )}
                <ExecButton busy={busy}
                  disabled={isCancelled || !dutchStartPrice || !dutchEndPrice || !dutchStartTime || !dutchDuration || dutchValidationError !== null}
                  onClick={() => {
                    // R071: re-check at click in case the memo lags one tick
                    // behind a typed-then-rage-click race.
                    if (dutchValidationError) return;
                    let startWei: bigint, endWei: bigint;
                    try { startWei = parseEther(dutchStartPrice); endWei = parseEther(dutchEndPrice); } catch { return; }
                    let startUnix: bigint, durationSec: bigint;
                    try { startUnix = BigInt(dutchStartTime); durationSec = BigInt(dutchDuration); } catch { return; }
                    exec('configureDutchAuction', [startWei, endWei, startUnix, durationSec]);
                  }}>
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
                <p className="text-[10px] text-white/60 mt-1">
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
                {isCancelled ? (
                  <p className="text-[11px] text-red-300/80">Sale already cancelled.</p>
                ) : (
                  // window.confirm is one keypress from a dismissed dialog, and
                  // this write is not reversible: it ends the sale and opens
                  // refunds for every buyer.
                  <TypedConfirmation
                    phrase="CANCEL SALE"
                    description="Cancelling ends the sale permanently and makes every buyer eligible for a refund. There is no way back."
                    ctaLabel="Cancel Sale (Irreversible)"
                    executeLabel="Cancel Sale"
                    pending={busy}
                    onConfirm={() => exec('cancelSale')}
                  />
                )}
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
