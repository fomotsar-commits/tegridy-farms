import { useEffect, useRef, useState } from 'react';
import { resolveMint, type SolToken } from '../../lib/solanaTokenList';

/**
 * "What am I actually buying?" — the rug signals every 2026 memecoin trader
 * checks before a buy, from fields the Jupiter tokens/v2 payload already
 * carries: token age (first indexed pool), holder count, organic score, the
 * audit flags, and the project links. Opened from the ⓘ next to the selected
 * buy token.
 *
 * HARD RULE: no market cap, no FDV, no USD price in this dialog — the Solana
 * surfaces deliberately render none (house no-FDV rule). Age/holders/score/
 * links only. Missing fields simply don't render; nothing is invented.
 */

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days >= 0 ? days : null;
}

export function TokenDetail({ token, onClose }: { token: SolToken; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Curated consts (SOL/USDC/BAYLA…) don't carry the detail fields — resolve
  // them lazily on open. A failed lookup just renders fewer rows.
  const [detail, setDetail] = useState<SolToken>(token);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (token.holderCount !== undefined || token.firstPoolCreatedAt !== undefined) return;
    const ctrl = new AbortController();
    resolveMint(token.mint, ctrl.signal)
      .then((t) => { if (t) setDetail((d) => ({ ...t, ...pickTruthy(d) })); })
      .catch(() => { /* fewer rows, never a crash */ });
    return () => ctrl.abort();
  }, [token]);

  // Escape to close + scroll lock + focus restore (the TokenPicker pattern).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus();
    };
  }, [onClose]);

  const age = detail.firstPoolCreatedAt ? daysSince(detail.firstPoolCreatedAt) : null;
  const audit = detail.audit;

  async function copyMint() {
    try {
      await navigator.clipboard.writeText(detail.mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the address is still selectable */ }
  }

  const linkCls = 'underline underline-offset-2 text-white/80 hover:text-white inline-block px-1 -mx-1 py-2 -my-2';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`About ${detail.symbol}`}>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-2xl p-4 outline-none max-h-[calc(100dvh-2rem)] overflow-y-auto"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid rgba(255,255,255,0.14)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white text-[14px] font-semibold truncate">
            {detail.name} <span className="text-white/50 font-normal">({detail.symbol})</span>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close token details" className="text-white/60 hover:text-white p-3 -m-2 text-[14px]">✕</button>
        </div>

        <div className="space-y-1.5 text-[12px]">
          {age !== null && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">First traded</span>
              <span className={`font-mono ${age < 7 ? 'text-amber-300 font-semibold' : 'text-white/85'}`}>
                {age === 0 ? 'today' : `${age}d ago`}
                {age < 7 && ' · brand new'}
              </span>
            </div>
          )}
          {typeof detail.holderCount === 'number' && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Holders</span>
              <span className="text-white/85 font-mono">{detail.holderCount.toLocaleString('en-US')}</span>
            </div>
          )}
          {detail.organicScoreLabel && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Organic activity</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                detail.organicScoreLabel === 'high'
                  ? 'bg-green-500/20 text-green-300'
                  : detail.organicScoreLabel === 'medium'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-red-500/20 text-red-300'
              }`}>
                {detail.organicScoreLabel}
              </span>
            </div>
          )}
          {audit?.mintAuthorityDisabled !== undefined && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Mint authority</span>
              <span className={audit.mintAuthorityDisabled ? 'text-white/85' : 'text-red-300 font-semibold'}>
                {audit.mintAuthorityDisabled ? 'revoked' : 'ACTIVE — supply can grow'}
              </span>
            </div>
          )}
          {audit?.freezeAuthorityDisabled !== undefined && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Freeze authority</span>
              <span className={audit.freezeAuthorityDisabled ? 'text-white/85' : 'text-red-300 font-semibold'}>
                {audit.freezeAuthorityDisabled ? 'revoked' : 'ACTIVE — wallets can be frozen'}
              </span>
            </div>
          )}
          {typeof audit?.topHoldersPercentage === 'number' && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Top 10 holders</span>
              <span className={`font-mono ${audit.topHoldersPercentage > 50 ? 'text-amber-300' : 'text-white/85'}`}>
                {audit.topHoldersPercentage.toFixed(1)}%
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 text-[11px]" style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
          {detail.website && (
            <a href={detail.website} target="_blank" rel="noopener noreferrer" className={linkCls}>Website ↗</a>
          )}
          {detail.twitter && (
            <a href={detail.twitter} target="_blank" rel="noopener noreferrer" className={linkCls}>Twitter ↗</a>
          )}
          <a href={`https://solscan.io/token/${detail.mint}`} target="_blank" rel="noopener noreferrer" className={linkCls}>Solscan ↗</a>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <span className="text-white/50 text-[10px] font-mono truncate flex-1" title={detail.mint}>{detail.mint}</span>
          <button type="button" onClick={() => void copyMint()} className="text-white/60 text-[10px] hover:text-white px-2 py-2.5 -my-2 flex-shrink-0">
            {copied ? 'Copied ✓' : 'Copy mint'}
          </button>
        </div>

        <p className="text-white/55 text-[10px] mt-2">
          Data from Jupiter. Not an endorsement — a young token, an active authority or concentrated holders are the classic rug shapes.
        </p>
      </div>
    </div>
  );
}

/** Keep any already-known truthy fields when overlaying the resolved token. */
function pickTruthy(t: SolToken): Partial<SolToken> {
  const out: Partial<SolToken> = {};
  for (const [k, v] of Object.entries(t) as [keyof SolToken, unknown][]) {
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
