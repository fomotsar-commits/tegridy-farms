import { useState } from 'react';
import { useMevProtection } from '../../hooks/useMevProtection';
import { MEV_BLOCKER_FAST_RPC, MEV_BLOCKER_INFO_URL } from '../../lib/mevProtection';

// Compact settings panel that mirrors the sibling "Fee-on-transfer support"
// panel in TradePage so it inherits the same mobile-tuned spacing/typography.
// Additive only — protects every transaction (swaps, stakes, claims) by routing
// the wallet through MEV Blocker's protected RPC.
export function MevProtectionPanel() {
  const { status, enable } = useMevProtection();
  const [showManual, setShowManual] = useState(false);

  const label =
    status === 'pending' ? 'Adding…' : status === 'added' ? 'Added ✓' : 'Add to wallet';

  return (
    <div
      className="mt-1 mb-1 px-3 py-2.5 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          MEV protection
        </span>
        <button
          type="button"
          onClick={enable}
          disabled={status === 'pending'}
          className="px-3 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium text-white transition-all disabled:opacity-50"
          style={{ background: 'var(--color-stan)', border: '1px solid var(--color-stan)' }}
        >
          {label}
        </button>
      </div>
      {status === 'added' ? (
        // F204: steady state once the user has completed setup (persisted per
        // wallet). Remind them to actually select the protected network — we
        // can't detect the live RPC from the dapp — and keep a re-add path.
        <p className="mt-1 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          Added &mdash; select the &ldquo;Ethereum (MEV Blocker)&rdquo; network in your wallet to route
          transactions through the protected RPC.{' '}
          <button type="button" onClick={enable} className="underline underline-offset-2 hover:text-white">
            Re-add
          </button>
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          Routes your transactions through MEV Blocker&apos;s protected RPC to block sandwich attacks, and
          returns 90% of any backrun profit to you. One-time, user-confirmed wallet setup.
        </p>
      )}

      {status === 'manual' && (
        <div
          className="mt-2 px-2 py-1.5 rounded text-[10px] text-white/85"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}
        >
          <p className="mb-1">Your wallet declined the one-tap add. Add it manually in your network settings:</p>
          <p className="font-mono break-all">RPC URL: {MEV_BLOCKER_FAST_RPC}</p>
          <p className="font-mono">Chain ID: 1 &middot; Currency: ETH</p>
          <a
            href={MEV_BLOCKER_INFO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-1 underline underline-offset-2 hover:text-white"
          >
            mevblocker.io
          </a>
        </div>
      )}

      {status !== 'manual' && (
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="mt-1 text-[10px] text-white/55 hover:text-white/80 underline underline-offset-2 transition-colors"
        >
          {showManual ? 'Hide manual setup' : 'Prefer to add it manually?'}
        </button>
      )}
      {status !== 'manual' && showManual && (
        <div className="mt-1 text-[10px] text-white/75">
          <p className="font-mono break-all">RPC URL: {MEV_BLOCKER_FAST_RPC}</p>
          <p className="font-mono">Chain ID: 1 &middot; Currency: ETH</p>
        </div>
      )}
    </div>
  );
}
