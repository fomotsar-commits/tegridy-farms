import { m } from 'framer-motion';
import { useProtocolEvents } from '../hooks/useProtocolEvents';
import type { PulseItem } from '../lib/protocolEvents';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { shortenAddress } from '../lib/formatting';
import { PulseDot } from './PulseDot';
import { staggerContainer, staggerItem } from '../lib/motion';

/**
 * Live "Protocol Pulse" — real recent TOWELI buys/sells from the chain (via
 * GeckoTerminal). The research-backed "what's moving" daily-use hook.
 *
 * SELF-GATING (like RealYieldProof): renders NOTHING while the protocol is
 * dormant / loading / errored — it must never show an empty "activity" box
 * (that's the "advertises its own emptiness" trap). It appears automatically
 * the moment real trading exists (post-liquidity-seed / go-live).
 */

function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

const KIND_STYLE: Record<'fee' | 'pol' | 'gauge' | 'launch', { color: string; glyph: string }> = {
  fee: { color: '#22c55e', glyph: 'Ξ' },   // Ξ — ETH to stakers
  pol: { color: '#d4a843', glyph: '◈' },    // ◈ — protocol-owned liquidity
  gauge: { color: '#d4a843', glyph: '⚖' },  // ⚖ — gauge weight (dormant)
  launch: { color: '#d4a843', glyph: '★' }, // ★ — graded launch
};

// Protocol-level events (fee/pol/gauge/launch): a headline + detail row, not tied to
// a trader address. Links the tx when there is one, else a contract/token verify path.
function EventRow({ item }: { item: PulseItem }) {
  const style = KIND_STYLE[item.kind as 'fee' | 'pol' | 'gauge' | 'launch'] ?? KIND_STYLE.fee;
  const link = item.txHash ? `https://etherscan.io/tx/${item.txHash}` : item.href || undefined;
  const cls = 'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5';
  const ring = item.whale ? { boxShadow: 'inset 0 0 0 1px rgba(212,168,67,0.25)' } : undefined;
  const inner = (
    <>
      <span
        className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px]"
        style={{ background: 'rgba(0,0,0,0.5)', color: style.color, border: `1px solid ${style.color}` }}
        aria-hidden="true"
      >
        {style.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-white truncate">
          {item.whale && <span title="Notable event">{'\u{1F40B}'} </span>}
          <span style={{ color: style.color, fontWeight: 600 }}>{item.title}</span>
        </p>
        <p className="text-[11px] text-text-secondary truncate">
          {item.detail}{item.detail ? ' · ' : ''}{relTime(item.ts)}
        </p>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-text-secondary flex-shrink-0">
        {item.kind === 'launch' ? 'launch' : 'protocol'}
      </span>
    </>
  );
  return (
    <m.li variants={staggerItem} className="list-none">
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className={cls} style={ring}>{inner}</a>
      ) : (
        <div className={cls} style={ring}>{inner}</div>
      )}
    </m.li>
  );
}

function Row({ item, price }: { item: PulseItem; price: number }) {
  // Protocol-level events render via EventRow; the trade path continues below.
  if (item.kind !== 'buy' && item.kind !== 'sell') return <EventRow item={item} />;
  const isBuy = item.kind === 'buy';
  const color = isBuy ? '#22c55e' : 'var(--color-danger)';
  const toweli = price > 0 ? item.usd / price : 0;
  return (
    <m.li variants={staggerItem} className="list-none">
      <a
        href={`https://etherscan.io/tx/${item.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5"
        style={item.whale ? { boxShadow: 'inset 0 0 0 1px rgba(212,168,67,0.25)' } : undefined}
      >
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px]"
          style={{ background: 'rgba(0,0,0,0.5)', color, border: `1px solid ${color}` }}
          aria-hidden="true"
        >
          {isBuy ? '↑' : '↓'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-white truncate">
            {item.whale && <span title="Whale-sized trade">{'\u{1F40B}'} </span>}
            <span style={{ color, fontWeight: 600 }}>{isBuy ? 'Bought' : 'Sold'}</span>{' '}
            <span className="stat-value">{compact(toweli)}</span> TOWELI
          </p>
          <p className="text-[11px] text-text-secondary truncate">
            {shortenAddress(item.actor)} · {relTime(item.ts)}
          </p>
        </div>
        <span className="text-[12px] font-mono text-text-secondary flex-shrink-0">
          ${item.usd < 1 ? item.usd.toFixed(2) : item.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      </a>
    </m.li>
  );
}

export function ProtocolPulse({ limit = 8 }: { limit?: number }) {
  const { items, loading, error } = useProtocolEvents();
  const { priceInUsd } = useTOWELIPrice();

  // Self-gate: show nothing unless there is real activity to surface.
  if (loading || error || items.length === 0) return null;

  const shown = items.slice(0, limit);

  return (
    <m.div className="pb-16" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
      <div className="mb-6">
        <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          What&rsquo;s Moving
        </h2>
        <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Real protocol activity &mdash; TOWELI trades, fee distributions &amp; liquidity, live from the chain.
        </p>
      </div>
      <div className="glass-card rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <PulseDot color="#22c55e" size={7} />
            <h3 className="heading-luxury text-[15px] text-white">Live Protocol Pulse</h3>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-text-secondary">on-chain · live</span>
        </div>
        <m.ul variants={staggerContainer(0.05)} initial="hidden" animate="show" className="space-y-0.5 m-0 p-0">
          {shown.map((item) => (
            <Row key={item.id} item={item} price={priceInUsd} />
          ))}
        </m.ul>
      </div>
    </m.div>
  );
}
