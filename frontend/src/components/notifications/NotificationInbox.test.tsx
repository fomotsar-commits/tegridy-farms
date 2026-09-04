// Honesty guard for the inbox surface.
//
// An empty inbox is the most dangerous thing this feature renders, because the
// reassuring reading of it ("nothing happened") is only true in one of the four
// ways it can be empty. These tests pin the other three to their own sentences,
// and pin the reassuring one to the condition that earns it: rules exist AND a
// pass completed.
//
// They also pin the rendering of gaps: a row that says a rule was not checked
// must not be dressed with a source name (nothing was read, so no source said
// anything), and an event that was recorded only in this inbox must say that no
// push was sent — otherwise a user infers a phone notification that never came.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotificationInbox, emptyStateMessage } from './NotificationInbox';
import type { InboxEntry } from '../../lib/alerts/inbox';

const NOW = 1_760_000_000;
const noop = () => {};

const UNREAD_NONE = { events: 0, gaps: 0, total: 0 };

function eventEntry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'e1',
    kind: 'event',
    ruleId: 'r1',
    ruleKind: 'heat-tier',
    title: 'Heat tier change — 0x4206…8F9D',
    body: 'Observer → Builder.',
    provenance: 'Jungle Bay Island’s held-time oracle (memetics.wtf)',
    at: NOW,
    read: false,
    anchor: null,
    channels: ['in-app'],
    ...over,
  };
}

function gapEntry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'g1',
    kind: 'gap',
    ruleId: 'r2',
    ruleKind: 'whale-move',
    title: 'Could not evaluate — Transfers of 0x4206…8F9D over $10,000',
    body: 'This deployment has no indexer configured.',
    provenance: '',
    at: NOW,
    read: false,
    anchor: null,
    channels: ['in-app'],
    ...over,
  };
}

function renderInbox(props: Partial<React.ComponentProps<typeof NotificationInbox>> = {}) {
  return render(
    <NotificationInbox
      entries={[]}
      unread={UNREAD_NONE}
      coverage="Rules are evaluated in this browser tab, only while this page is open."
      lastRunAt={NOW}
      ruleCount={1}
      onMarkRead={noop}
      onMarkAllRead={noop}
      onDismiss={noop}
      {...props}
    />,
  );
}

describe('the empty state says which kind of empty this is', () => {
  it('no rules → says nothing is being watched, not that the market is quiet', () => {
    const message = emptyStateMessage(0, NOW);
    expect(message).toMatch(/nothing is being watched/i);
    expect(message).toMatch(/not because the market is quiet/i);
  });

  it('rules but no completed pass → says nothing has been read', () => {
    const message = emptyStateMessage(3, null);
    expect(message).toMatch(/have not been evaluated yet/i);
    expect(message).toMatch(/not because nothing happened/i);
  });

  it('rules and a completed pass → the reassuring sentence, and only then', () => {
    const message = emptyStateMessage(3, NOW);
    expect(message).toMatch(/none of them matched/i);
    expect(message).toMatch(/real negative/i);
  });

  it('the three sentences are all different', () => {
    const set = new Set([emptyStateMessage(0, NOW), emptyStateMessage(3, null), emptyStateMessage(3, NOW)]);
    expect(set.size).toBe(3);
  });

  it('renders the no-rules sentence when there are no rules', () => {
    renderInbox({ ruleCount: 0 });
    expect(screen.getByRole('status').textContent).toMatch(/nothing is being watched/i);
  });
});

describe('coverage is always stated', () => {
  it('renders the coverage sentence even with entries present', () => {
    renderInbox({ entries: [eventEntry()], unread: { events: 1, gaps: 0, total: 1 } });
    expect(screen.getByText(/only while this page is open/i)).toBeInTheDocument();
  });

  it('says plainly when no pass has completed', () => {
    renderInbox({ lastRunAt: null });
    expect(screen.getByText(/No evaluation pass has completed yet/i)).toBeInTheDocument();
  });
});

describe('gaps are rows, and they are counted apart', () => {
  it('renders a gap entry with its reason', () => {
    renderInbox({ entries: [gapEntry()], unread: { events: 0, gaps: 1, total: 1 } });
    expect(screen.getByText(/no indexer configured/i)).toBeInTheDocument();
  });

  it('a gap cites no source — nothing was read, so nothing said anything', () => {
    renderInbox({ entries: [gapEntry()], unread: { events: 0, gaps: 1, total: 1 } });
    expect(screen.getByText(/there is no source to cite/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Source:/)).not.toBeInTheDocument();
  });

  it('the header counts alerts and gaps separately', () => {
    renderInbox({
      entries: [eventEntry(), gapEntry()],
      unread: { events: 1, gaps: 1, total: 2 },
    });
    expect(screen.getByText(/1 unread alert · 1 unread gap/)).toBeInTheDocument();
  });
});

describe('events disclose what was actually delivered', () => {
  it('an in-app-only event says no notification was shown', () => {
    renderInbox({ entries: [eventEntry()], unread: { events: 1, gaps: 0, total: 1 } });
    expect(screen.getByText(/no notification was shown/i)).toBeInTheDocument();
  });

  it('an event names its source', () => {
    renderInbox({ entries: [eventEntry()], unread: { events: 1, gaps: 0, total: 1 } });
    expect(screen.getByText(/Jungle Bay Island/)).toBeInTheDocument();
  });

  it('an event stamped with a shown notification says so instead', () => {
    // The stamp is only applied after a show returned true, so this row is a
    // record of something that happened rather than of something planned.
    renderInbox({
      entries: [eventEntry({ channels: ['in-app', 'web-notification'] })],
      unread: { events: 1, gaps: 0, total: 1 },
    });
    expect(screen.queryByText(/no notification was shown/i)).not.toBeInTheDocument();
    expect(screen.getByText(/shown as a browser notification/i)).toBeInTheDocument();
  });

  it('a pool quote row says “read at”, not “as of”', () => {
    // "as of" is the SOURCE'S claim about when a fact was true. GeckoTerminal
    // makes no such claim about a pool quote, so a row that said "as of" would
    // attribute our own fetch clock to them.
    renderInbox({
      entries: [eventEntry({ observedAtKind: 'read' })],
      unread: { events: 1, gaps: 0, total: 1 },
    });
    expect(screen.getByText(/read at/i)).toBeInTheDocument();
    expect(screen.queryByText(/· as of/i)).not.toBeInTheDocument();
  });

  it('every row control is a 44px target', () => {
    renderInbox({ entries: [eventEntry()], unread: { events: 1, gaps: 0, total: 1 } });
    for (const name of ['Mark all read', 'Mark read', 'Dismiss']) {
      expect(screen.getByRole('button', { name }).className, name).toContain('min-h-11');
    }
  });
});

describe('interaction', () => {
  it('mark-all-read is offered only while something is unread', () => {
    const onMarkAllRead = vi.fn();
    const { rerender } = renderInbox({
      entries: [eventEntry()],
      unread: { events: 1, gaps: 0, total: 1 },
      onMarkAllRead,
    });
    expect(screen.getByText('Mark all read')).toBeInTheDocument();
    rerender(
      <NotificationInbox
        entries={[eventEntry({ read: true })]}
        unread={UNREAD_NONE}
        coverage="c"
        lastRunAt={NOW}
        ruleCount={1}
        onMarkRead={noop}
        onMarkAllRead={onMarkAllRead}
        onDismiss={noop}
      />,
    );
    expect(screen.queryByText('Mark all read')).not.toBeInTheDocument();
  });
});
