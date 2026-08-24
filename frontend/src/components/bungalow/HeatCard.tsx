import { useState } from 'react';
import { fetchHeat, isSupportedHeatAddress } from '../../lib/heat/heatClient';
import type { HeatReading } from '../../lib/heat/heatOracle';

/**
 * "Check your heat" — the island's held-time oracle, on the bungalow farm page.
 *
 * Heat IS the island's thesis ("time held is what counts") and the Bayla hero
 * says "hold her for heat", so the farm page answers the obvious next
 * question. Read-only: one address in, the oracle's reading out, through the
 * same hardened proxy every other heat surface uses (heatClient — CORS makes
 * a direct browser call impossible by design).
 *
 * Honesty rules inherited from heatClient: an unreachable oracle is an ERROR
 * state ("the island is quiet"), never rendered as cold/zero — "we could not
 * ask" and "you are cold" are different facts.
 */
export function HeatCard() {
  const [address, setAddress] = useState('');
  const [reading, setReading] = useState<HeatReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const supported = isSupportedHeatAddress(address);

  const check = async () => {
    if (!supported || loading) return;
    setLoading(true);
    setError(null);
    setReading(null);
    try {
      setReading(await fetchHeat(address.trim()));
    } catch {
      setError('The Island is quiet right now — the oracle could not be read. That is an outage, not a zero.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-6 rounded-2xl p-6" style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}>
      <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--color-kyle)' }}>Check your heat</p>
      <p className="text-white/70 text-[12px] mb-3">
        Time held is what counts. Give the Island an address — it answers with what you held.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="bungalow-heat-address" className="sr-only">Wallet address</label>
        <input
          id="bungalow-heat-address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void check(); }}
          placeholder="Solana or 0x… wallet address"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 min-w-[260px] rounded-lg px-3 py-2.5 text-[13px] font-mono text-white placeholder-white/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
          style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
        />
        <button
          type="button"
          onClick={() => void check()}
          disabled={!supported || loading}
          className="btn-secondary px-5 py-2.5 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Asking the Island…' : 'Check heat'}
        </button>
      </div>
      {address.trim() !== '' && !supported && (
        <p className="text-white/50 text-[11px] mt-2">Enter a full Solana address or a 0x… Ethereum/Base address.</p>
      )}
      {error && (
        <p className="text-[12px] mt-3" style={{ color: '#f0b26b' }}>{error}</p>
      )}
      {reading && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
          <span className="text-white">
            <span className="text-white/60">Heat:</span>{' '}
            <strong>{reading.degrees.toLocaleString(undefined, { maximumFractionDigits: 1 })}°</strong>
          </span>
          <span className="text-white"><span className="text-white/60">Standing:</span> <strong>{reading.tier}</strong></span>
          <span className="text-white/80">
            {reading.isCold
              ? 'Cold — the Island has no held-time rows for this wallet yet.'
              : `${reading.tokenCount} held token${reading.tokenCount === 1 ? '' : 's'}${reading.heldSinceUnix ? ` · holding since ${new Date(reading.heldSinceUnix * 1000).toLocaleDateString()}` : ''}`}
          </span>
        </div>
      )}
    </div>
  );
}
