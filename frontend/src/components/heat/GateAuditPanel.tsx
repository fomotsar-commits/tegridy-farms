// THE DOOR'S RECEIPT. The read half of the audit ring — "every decision is logged
// replayable" is only true if somebody can actually read it back.
//
// WHAT THIS SURFACE MUST NEVER DO (each of these is a way of lying with a table):
//  1. Render the CURRENT floor against an OLD decision. Every row carries the floor it
//     was taken against; a floor that moved since must be shown as a separate, present-
//     tense fact, never substituted into history.
//  2. Collapse `as_of` (when the ISLAND reckoned) into `decided_at` (when the DOOR
//     decided). They are hours or days apart and they answer different questions.
//  3. Show an empty list when storage is unavailable. "Nothing was recorded" and "this
//     browser will not let the page keep a record" are different facts, and an empty
//     table shown for both reads as "you were never denied".
//  4. Print 0° for a decision that never got a reading. `degrees: null` is an outage,
//     not a cold wallet — the distinction the whole heat surface is built around.
//
// LOCAL AND FIRST-PARTY. This reads the user's own device and sends nothing anywhere;
// see gateAudit.ts for why the record deliberately lives outside the analytics sink.

import { useId, useMemo, useState } from 'react';
import {
  readGateAuditState,
  isSameAuditAddress,
  type GateAuditRead,
  type GateAuditRow,
} from '../../lib/heat/gateAudit';
import { heatLaunchFloor } from '../../lib/heat/heatGateConfig';
import { shortenAddress, formatTimeAgo } from '../../lib/formatting';

/** Enough to cover a session's worth of doors without turning the panel into a log file. */
const DEFAULT_LIMIT = 12;

const VERDICT_COLOR: Record<GateAuditRow['verdict'], string> = {
  WARM: 'var(--color-kyle)',
  COLD: 'rgba(255,255,255,0.55)',
  STALE: '#fbbf24',
};

/** One level finer than the verdict, in the door's own terms. Audit-only vocabulary. */
const REASON_WORDS: Record<GateAuditRow['reason'], string> = {
  qualified: 'at or above the floor',
  'below-floor': 'below the floor',
  'stale-reading': 'the reading was too old to decide on',
  unreadable: 'the island could not be read at all',
};

/**
 * An absolute instant, in UTC, to the minute.
 *
 * UTC and not local time on purpose: this string is quoted into support threads
 * alongside a `gate_decision_id`, and a local-time stamp means the reader and the
 * person helping them are looking at two different numbers for one decision.
 */
function stamp(unix: number): string {
  return `${new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * The decision, re-derived from the row's OWN stored inputs.
 *
 * This is what "replayable" buys: the comparison is recomputed at render from
 * `degrees` and `floor` as they were, so the arithmetic on screen is the arithmetic the
 * door did — not the arithmetic today's dials would do.
 */
export function replayLine(row: GateAuditRow): string {
  if (row.degrees === null) {
    return `No degrees were read, so nothing was measured against the ${row.floor}° floor. That is an unread instrument, not a zero.`;
  }
  const d = row.degrees.toFixed(2);
  if (row.verdict === 'WARM') {
    return `${d}° measured against a ${row.floor}° floor — clear by ${(row.degrees - row.floor).toFixed(2)}°.`;
  }
  if (row.verdict === 'COLD') {
    return `${d}° measured against a ${row.floor}° floor — short by ${(row.floor - row.degrees).toFixed(2)}°.`;
  }
  return `${d}° was read, but the ${row.floor}° floor was never applied: a reading that old may not pass or fail anyone.`;
}

export interface GateAuditPanelProps {
  /**
   * The wallet whose decisions are shown. PINNED, never a lookup field — the door
   * answers the wallet standing in front of it and is not an instrument for reading
   * other people's history.
   */
  address: string;
  /**
   * Read the island again. Wired to the door's own read, so a wallet that was turned
   * away can replay the question rather than reload the page.
   */
  onReRead?: () => void;
  limit?: number;
}

/**
 * What the panel has to render, once the ring has been read and narrowed to one wallet.
 *
 * `total` is deliberately kept alongside `mine`: "nothing is recorded" and "plenty is
 * recorded, none of it about you" are different answers and the reader is owed the one
 * that is true.
 */
type View =
  | { kind: 'unavailable' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; mine: GateAuditRow[]; total: number; dropped: number };

export function GateAuditPanel({ address, onReRead, limit = DEFAULT_LIMIT }: GateAuditPanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Read on EXPAND rather than on mount, and read DURING render rather than through an
  // effect. The panel sits under a door that writes a row on every read, so deferring
  // means the list is taken after the current decision has landed; a collapsed panel
  // touches storage not at all; and re-reading is a pure `getItem`, so there is no
  // second state to fall out of step with the wallet on screen.
  const view = useMemo<View | null>(() => {
    if (!open) return null;
    const read: GateAuditRead = readGateAuditState();
    if (read.kind !== 'ok') return read;
    return {
      kind: 'ok',
      mine: read.rows.filter((r) => isSameAuditAddress(r.address, address)),
      total: read.rows.length,
      dropped: read.dropped,
    };
  }, [open, address]);

  const shown = view?.kind === 'ok' ? view.mine.slice(0, limit) : [];
  const floorNow = heatLaunchFloor();

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-[12px] underline underline-offset-2 transition-colors"
        style={{ color: 'var(--color-kyle)' }}
      >
        {open ? 'Hide what the door has read' : 'Why did the door answer this way?'}
      </button>

      {open && (
        <div
          id={panelId}
          className="mt-2 rounded-xl p-4"
          style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}
        >
          <p className="text-[11.5px] text-white/55 leading-relaxed mb-3">
            Every decision this door takes is written down on this device, with the reading it used.
            It is kept here and nowhere else — it is never sent anywhere, and it is not analytics.
            Each row shows the floor <strong className="text-white/80">that decision</strong> was taken
            against, so a floor that moves later cannot rewrite what you were measured against.
          </p>

          {view?.kind === 'unavailable' && (
            <Notice tone="warn">
              This browser is not letting the page keep a record — private mode, or site storage
              blocked. So there is nothing here to show. That is <strong>not</strong> the same as
              &ldquo;no decision was taken&rdquo;: the door still read you and still decided, the
              local copy simply has nowhere to live.
            </Notice>
          )}

          {view?.kind === 'unreadable' && (
            <Notice tone="warn">
              The stored record is not in the shape this page writes, so it cannot be read back.
              Nothing is being guessed from it — it is being ignored.
            </Notice>
          )}

          {/* `dropped` qualifies this one: if every stored row failed the shape check the
              record is damaged, not empty, and the notice below would be a false negative. */}
          {view?.kind === 'ok' && view.total === 0 && view.dropped === 0 && (
            <Notice>
              No gate decision has been recorded in this browser yet. An empty record is not a clean
              record: a decision taken on another device, or before this browser&apos;s storage was
              cleared, would not appear here.
            </Notice>
          )}

          {view?.kind === 'ok' && view.total > 0 && view.mine.length === 0 && (
            <Notice>
              {view.total} decision{view.total === 1 ? ' is' : 's are'} stored in this browser, but
              none of them were taken against {shortenAddress(address, 6)}.
            </Notice>
          )}

          {view?.kind === 'ok' && view.dropped > 0 && (
            <Notice tone="warn">
              {view.dropped} stored row{view.dropped === 1 ? ' was' : 's were'} unreadable and
              skipped, so this list is incomplete.
            </Notice>
          )}

          {shown.length > 0 && (
            <>
              <ul className="space-y-2">
                {shown.map((row) => (
                  <DecisionRow key={row.id} row={row} floorNow={floorNow} />
                ))}
              </ul>
              {view?.kind === 'ok' && view.mine.length > shown.length && (
                <p className="text-[11px] text-white/40 mt-2">
                  Showing the {shown.length} most recent of {view.mine.length} decisions for this wallet.
                </p>
              )}
            </>
          )}

          {onReRead && (
            <div className="mt-3">
              <button onClick={onReRead} className="btn-secondary px-4 py-1.5 text-[12.5px]">
                Read the island again
              </button>
              <p className="text-[11px] text-white/40 mt-1.5 leading-relaxed">
                Reads your warmth live and takes a fresh decision. It moves no funds and costs no gas.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionRow({ row, floorNow }: { row: GateAuditRow; floorNow: number }) {
  const color = VERDICT_COLOR[row.verdict];
  return (
    <li className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-purple-25)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color }}>
          {row.verdict} · {REASON_WORDS[row.reason]}
        </span>
        <span className="text-[10.5px] text-white/35 font-mono" title={row.id}>
          {row.id.slice(0, 8)}
        </span>
      </div>

      <p className="text-[12px] text-white/75 leading-relaxed mb-2">{replayLine(row)}</p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Field label="Degrees">
          {/* null is an unread instrument. Printing 0 here would be the exact
              outage-as-a-score inversion the heat surface exists to prevent. */}
          {row.degrees === null ? <span className="text-white/45">not read</span> : `${row.degrees.toFixed(2)}°`}
        </Field>
        <Field label="Tier">
          {row.tier ?? <span className="text-white/45">not read</span>}
        </Field>
        <Field label="Floor at the time">{row.floor}°</Field>
        <Field label="Island reckoned">
          {row.as_of === null ? (
            <span className="text-white/45">never — nothing measured</span>
          ) : (
            <span title={stamp(row.as_of)}>{stamp(row.as_of)}</span>
          )}
        </Field>
        <Field label="Door decided">
          <span title={stamp(row.decided_at)}>
            {stamp(row.decided_at)} · {formatTimeAgo(row.decided_at)}
          </span>
        </Field>
        <Field label="Wallet">
          <span className="font-mono" title={row.address}>{shortenAddress(row.address, 6)}</span>
        </Field>
      </dl>

      {row.floor !== floorNow && (
        <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: '#fbbf24' }}>
          The floor is {floorNow}° today. This decision was taken against {row.floor}° and is shown as
          it was taken.
        </p>
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-white/40">{label}</dt>
      <dd className="text-white/80">{children}</dd>
    </div>
  );
}

function Notice({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  const warn = tone === 'warn';
  return (
    <p
      className="rounded-lg px-3 py-2 text-[12px] leading-relaxed"
      style={{
        background: warn ? 'rgba(234,179,8,0.10)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${warn ? 'rgba(234,179,8,0.35)' : 'var(--color-purple-25)'}`,
        color: warn ? '#fbbf24' : 'rgba(255,255,255,0.65)',
      }}
    >
      {children}
    </p>
  );
}
