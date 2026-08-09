// THE OPS SURFACE for the birth notify queue.
//
// "The notify NEVER blocks a launch and NEVER fails silently. Queue with visible retry
//  and an ops surface."
//
// This IS the "never fails silently" half. Without a surface, a queue is just a quieter
// way to drop things: the failure gets written to storage nobody reads and the operator
// still cannot tell an enrolled token from a lost one. So this panel shows every queued
// birth, its attempt count, and the exact error — including the ones that succeeded, so
// an empty pending list is legible as "all delivered" rather than "nothing ever tried".

import { useCallback, useState } from 'react';
import {
  readBirthQueue,
  flushBirthQueue,
  removeBirth,
  birthQueueSummary,
  type BirthQueueItem,
} from '../lib/launcher/birthNotify';

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const STATUS_COLOR: Record<BirthQueueItem['status'], string> = {
  pending: '#fbbf24',
  delivered: 'var(--color-kyle)',
  rejected: '#fca5a5',
};

export function BirthQueuePanel() {
  // Seeded from storage at mount rather than synced by an effect: the queue is a plain
  // synchronous read, so an effect would only add a render in which the panel claims an
  // empty queue that is not empty.
  const [items, setItems] = useState<BirthQueueItem[]>(() => readBirthQueue());
  const [flushing, setFlushing] = useState(false);

  const refresh = useCallback(() => setItems(readBirthQueue()), []);

  const retryNow = useCallback(async () => {
    setFlushing(true);
    try {
      await flushBirthQueue();
    } finally {
      setFlushing(false);
      refresh();
    }
  }, [refresh]);

  const summary = birthQueueSummary();

  return (
    <div
      className="rounded-2xl p-5"
      style={{ background: 'rgba(6,12,26,0.78)', border: '1px solid var(--color-purple-40)' }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="heading-luxury text-lg text-white tracking-tight">Birth notifications</h2>
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/45">Jungle Bay Island · enrollment</span>
      </div>
      <p className="text-white/55 text-[12px] leading-relaxed mb-4 max-w-2xl">
        Every token launched here is announced to the island so its Heat is measured from birth rather than
        after a half-year wait. A launch never waits on this: if the island is unreachable the birth stays
        queued and retries, and the chain plus the token&apos;s JSON record remain the backfill truth.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Stat label="Pending" value={summary.pending} color={STATUS_COLOR.pending} />
        <Stat label="Delivered" value={summary.delivered} color={STATUS_COLOR.delivered} />
        <Stat label="Rejected" value={summary.rejected} color={STATUS_COLOR.rejected} />
        <button
          onClick={() => void retryNow()}
          disabled={flushing || summary.pending === 0}
          className="btn-secondary px-4 py-1.5 text-[12.5px] disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
        >
          {flushing ? 'Retrying…' : 'Retry now'}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-white/45 text-[12.5px]">
          No births have been queued in this browser. The queue is per-browser by design — a launch made
          elsewhere is not missing, it is simply not visible from here.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li
              key={i.id}
              className="rounded-lg px-3 py-2.5 text-[12px]"
              style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-mono text-white/80 truncate max-w-[260px]" title={i.body.ca}>
                  {i.body.ca}
                </span>
                <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: STATUS_COLOR[i.status] }}>
                  {i.status}
                </span>
              </div>
              <div className="text-white/45 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                <span>{i.body.chain}</span>
                <span>block {i.body.birth_block}</span>
                <span>queued {ago(i.queuedAt)}</span>
                {i.attempts > 0 && <span>{i.attempts} attempt{i.attempts === 1 ? '' : 's'}</span>}
                {i.enrollmentId !== null && <span>enrollment #{i.enrollmentId}</span>}
              </div>
              {i.lastError && (
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: STATUS_COLOR[i.status] }}>
                  {i.lastError}
                </p>
              )}
              <div className="text-[10.5px] text-white/35 mt-1.5 break-all">
                gate {i.body.gate_decision_id} · <a href={i.body.record_url} className="underline underline-offset-2" target="_blank" rel="noreferrer">record</a>
              </div>
              {i.status === 'rejected' && (
                <button
                  onClick={() => {
                    removeBirth(i.id);
                    refresh();
                  }}
                  className="text-[11px] underline underline-offset-2 mt-1.5 text-white/50 hover:text-white/80"
                >
                  Drop from queue
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="stat-value text-[22px] leading-none" style={{ color }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-white/45 mt-0.5">{label}</div>
    </div>
  );
}
