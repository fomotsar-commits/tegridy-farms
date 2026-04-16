import type { LPPool } from './poolConfig';

export type PoolStatus = LPPool['status'];

const styles: Record<PoolStatus, { bg: string; border: string; color: string; label: string }> = {
  live:  { bg: 'rgba(45,139,78,0.15)',  border: 'rgba(45,139,78,0.35)',  color: '#2D8B4E', label: 'LIVE' },
  new:   { bg: 'var(--color-purple-75)', border: 'var(--color-purple-75)', color: '#000000', label: 'NEW' },
  hot:   { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.35)',  color: '#ef4444', label: '\u{1F525} HOT' },
  soon:  { bg: 'var(--color-purple-75)', border: 'var(--color-purple-75)', color: '#000000', label: 'PROPOSED \u00B7 NOT GUARANTEED' },
};

export function PoolStatusBadge({ status }: { status: PoolStatus }) {
  const s = styles[status];
  return (
    <span
      className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
    >
      {s.label}
    </span>
  );
}
