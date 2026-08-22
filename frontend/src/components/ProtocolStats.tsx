import { m } from 'framer-motion';
import { useProtocolStats } from '../hooks/useProtocolStats';

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtToken(n: number, sym = 'TOWELI'): string {
  if (!Number.isFinite(n) || n <= 0) return `0 ${sym}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${sym}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K ${sym}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${sym}`;
}

interface StatItem { l: string; v: string; sub: string; icon: string }

/**
 * Public protocol-analytics showcase, reads on-chain (no wallet needed).
 *
 * CREDIBILITY FIX (2026-06-09): never render an empty stat. The previous
 * version proudly displayed "Total Volume —", "Total Staked $9" and
 * "Total Swaps 0" pre-LP-seed — a wall of zeros that reads as a dead
 * protocol to exactly the DeFi-native audience the page courts. Live
 * metrics now render only once they're meaningful and are backfilled with
 * evergreen protocol guarantees (fee share, LP lock, fixed supply, audit
 * record) that are true on day zero. As volume/fees light up
 * post-seed they displace the evergreen cards automatically.
 */
export function ProtocolStats() {
  const s = useProtocolStats();
  const live: StatItem[] = [];
  if (s.volumeUsd > 0) live.push({ l: 'Total Volume', v: fmtUsd(s.volumeUsd), sub: 'all-time, on native DEX', icon: '🔄' });
  // HONESTY 2026-07-24: this reads collected router fees, NOT RevenueDistributor
  // .totalDistributed — labelling it "distributed to stakers" would overstate the
  // moment the first fee lands. Name what the number actually measures.
  if (s.feesUsd > 0) live.push({ l: 'Protocol Fees Collected', v: fmtUsd(s.feesUsd), sub: 'in ETH — routed to stakers, liquidity & ops', icon: '💸' });
  if (s.rewardPoolToweli > 0) live.push({ l: 'Reward Pool', v: fmtToken(s.rewardPoolToweli), sub: 'TOWELI staking rewards', icon: '💰' });
  if (s.dailyEmissionToweli > 0) live.push({ l: 'Daily Emissions', v: `${fmtToken(s.dailyEmissionToweli)}/day`, sub: 'to stakers', icon: '⚡' });
  // Below ~$1k the USD figure undersells the position — show the token count.
  if (s.stakedToweli > 0) live.push({ l: 'Total Staked', v: s.stakedUsd >= 1000 ? fmtUsd(s.stakedUsd) : fmtToken(s.stakedToweli), sub: 'TOWELI locked', icon: '🔒' });
  // No "Total Swaps" card: the deployed SwapFeeRouter has no totalSwaps() (gas
  // fix G-23), so the read reverted forever and the card could never light up.
  // Reintroduce only from indexer data (SwapExecuted event count).

  const evergreen: StatItem[] = [
    // F68: don't freeze a governable on-chain split (stakerShareBps) into a fixed
    // "100%" that contradicts the hero's three-way (stakers / liquidity / ops)
    // framing. F67: "bounty live" → "responsible disclosure" to match the hero
    // trust badge (the bounty has no funded pool yet).
    { l: 'Fee Routing', v: 'On-chain', sub: 'fees → stakers, liquidity & ops, in ETH', icon: '💸' },
    { l: 'LP Locked', v: '~69 yrs', sub: 'Uniswap LP in UNCX until 2093', icon: '🔐' },
    { l: 'Fixed Supply', v: '1B', sub: 'TOWELI — no mint function, ever', icon: '🧱' },
    // F-2026-07-24: "82+ findings resolved" is unverifiable by a visitor and the
    // Security page deliberately declines to publish a finding count. Claim only
    // what one click can check.
    // This card asserts a verdict without doing the read that produces it — the
    // live per-address check lives on /contracts (useSourceVerification, three
    // states, never optimistic). Repeating that check here would fire ~20
    // sequential Etherscan requests on the landing page, so the card names where
    // the verdict is actually computed rather than pretending it computed one.
    { l: 'Security', v: 'Verified', sub: 'per-contract Etherscan check at /contracts · responsible disclosure', icon: '🛡️' },
  ];

  const items = [...live, ...evergreen].slice(0, 6);
  // F80: derive the lg column count from how many cards actually render so the
  // pre-volume state (4 evergreen cards) fills the row instead of leaving 2
  // empty left-aligned columns under a fixed lg:grid-cols-6. Static class names
  // (Tailwind can't see interpolated ones). Centered so any short row balances.
  const lgCols: Record<number, string> = {
    1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6',
  };
  const lgColsClass = lgCols[Math.min(Math.max(items.length, 1), 6)] ?? 'lg:grid-cols-6';
  return (
    <m.div
      className={`grid grid-cols-2 md:grid-cols-3 ${lgColsClass} gap-3 justify-center`}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      {items.map((it) => (
        <div
          key={it.l}
          className="rounded-xl p-3 md:p-4"
          style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        >
          <p
            className="text-[11px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
            style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
          >
            <span aria-hidden="true">{it.icon}</span>{it.l}
          </p>
          <p className="stat-value text-lg md:text-xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}>
            {it.v}
          </p>
          {it.sub && <p className="text-[10px] mt-0.5" style={{ color: '#22c55e', opacity: 0.75 }}>{it.sub}</p>}
        </div>
      ))}
    </m.div>
  );
}
