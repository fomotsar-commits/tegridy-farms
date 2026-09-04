import { IN_APP_LIMITATION } from '../../lib/alerts/channels';
import type { InboxEntry } from '../../lib/alerts/inbox';

// The inbox.
//
// THE EMPTY STATE IS THE HARD PART. "No alerts" is a claim, and it is only true
// when rules exist, were evaluated, and found nothing. Every other way of being
// empty — no rules, never run, everything unevaluatable — is a different sentence,
// and this component refuses to render the reassuring one unless it was earned.
//
// Gaps are rendered as rows, not as a banner that can be dismissed and forgotten.
// A gap is the record that a rule was NOT checked, and it stays visible in the
// same list as the events so nobody reads a short list as a calm week.

interface Props {
  entries: readonly InboxEntry[];
  unread: { events: number; gaps: number; total: number };
  /** How this loop is scoped — always rendered, never optional. */
  coverage: string;
  /** Unix seconds of the last completed pass, or null when none has run. */
  lastRunAt: number | null;
  /** How many rules exist at all. Distinguishes "no rules" from "nothing fired". */
  ruleCount: number;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
}

function whenLabel(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return 'time not reported';
  return new Date(unix * 1000).toLocaleString();
}

/**
 * The empty-state sentence, chosen from what is actually known.
 *
 * Exported so the choice is unit-testable: the failure this guards against is a
 * refactor that collapses these four into one friendly "You're all caught up",
 * which would be false in three of them.
 */
export function emptyStateMessage(ruleCount: number, lastRunAt: number | null): string {
  if (ruleCount === 0) {
    return 'No alert rules yet. Nothing is being watched, so this inbox is empty by definition — not because the market is quiet.';
  }
  if (lastRunAt === null) {
    return 'Your rules have not been evaluated yet in this tab. This inbox is empty because nothing has been read, not because nothing happened.';
  }
  return 'Your rules were evaluated and none of them matched. This is a real negative — anything that could not be checked appears here as a “could not evaluate” row.';
}

export function NotificationInbox({
  entries,
  unread,
  coverage,
  lastRunAt,
  ruleCount,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: Props) {
  return (
    <section
      className="rounded-xl p-4"
      style={{ background: 'transparent' }}
      aria-label="Notification inbox"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-white text-[13px] font-medium">Inbox</h3>
        {/* Counted apart, always. One combined badge would let an hour of outage
            look like an hour of alerts. */}
        <span className="text-white/50 text-[11px]">
          {unread.events} unread alert{unread.events === 1 ? '' : 's'} · {unread.gaps} unread gap
          {unread.gaps === 1 ? '' : 's'}
        </span>
      </div>

      <p className="mt-2 text-white/55 text-[11px] leading-snug">{coverage}</p>
      <p className="mt-1 text-white/45 text-[11px] leading-snug">
        {lastRunAt === null ? 'No evaluation pass has completed yet.' : `Last pass: ${whenLabel(lastRunAt)}.`}
      </p>

      {entries.length === 0 ? (
        <p className="mt-3 text-white/70 text-[11px] leading-snug" role="status">
          {emptyStateMessage(ruleCount, lastRunAt)}
        </p>
      ) : (
        <>
          {unread.total > 0 && (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="mt-3 min-h-11 min-w-11 px-2 text-white/70 text-[11px] underline"
            >
              Mark all read
            </button>
          )}
          <ul className="mt-3 space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="py-2"
                style={{ borderTop: '1px solid var(--color-purple-75)' }}
                data-entry-kind={entry.kind}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium" style={{ color: entry.kind === 'gap' ? '#FFD37C' : '#fff' }}>
                      {!entry.read && <span aria-label="unread">• </span>}
                      {entry.title}
                    </p>
                    <p className="mt-1 text-white/70 text-[11px] leading-snug">{entry.body}</p>
                    {/* A gap has no provenance because it has no fact. Rendering a
                        source name on one would make an outage look like something
                        the source said. */}
                    {entry.kind === 'event' ? (
                      <p className="mt-1 text-white/45 text-[11px] leading-snug">
                        {/* "as of" is the SOURCE'S claim about when a fact was
                            true. A GeckoTerminal pool quote carries no such
                            claim, so those rows say "read at" — our clock,
                            labelled as ours. */}
                        Source: {entry.provenance} ·{' '}
                        {entry.observedAtKind === 'read' ? 'read at' : 'as of'} {whenLabel(entry.at)}
                        {entry.anchor && ` · ${entry.anchor.chain}:${entry.anchor.ref.slice(0, 12)}…`}
                      </p>
                    ) : (
                      <p className="mt-1 text-white/45 text-[11px] leading-snug">
                        Nothing was read, so there is no source to cite. Recorded {whenLabel(entry.at)}.
                      </p>
                    )}
                    {/* The row states what was DELIVERED, not what was planned:
                        `channels` is stamped after a send returned true, so a
                        notification the browser refused or threw on leaves this
                        line saying nothing was shown. */}
                    {entry.kind === 'event' && (
                      <p className="mt-1 text-white/40 text-[11px] leading-snug">
                        {entry.channels.includes('web-notification')
                          ? 'Shown as a browser notification (a tab was open).'
                          : 'Recorded in this inbox only — no notification was shown.'}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!entry.read && (
                      <button
                        type="button"
                        onClick={() => onMarkRead(entry.id)}
                        className="min-h-11 min-w-11 px-2 text-white/70 text-[11px] underline"
                      >
                        Mark read
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDismiss(entry.id)}
                      className="min-h-11 min-w-11 px-2 text-white/50 text-[11px] underline"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-3 text-white/40 text-[11px] leading-snug">{IN_APP_LIMITATION}</p>
    </section>
  );
}

export default NotificationInbox;
