// Guard for the inbox hook and the one channel that leaves the page.
//
// Two failures are being held shut here, and both are the kind that only show up
// in front of a user:
//
//   DOUBLE FIRE. The fold used to happen inside a setState updater. React runs
//     updaters twice under StrictMode, so the "newly added" rows were computed
//     twice and the OS notification fired twice — the exact bug
//     usePriceAlerts.ts already carries a comment about.
//
//   CLAIMED DELIVERY. A row must say "shown as a browser notification" only when
//     a show actually returned true. Stamping the delivery PLAN at ingest time
//     labels every row, including the ones whose show threw (Android Chrome) or
//     was refused.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import type { showNotification, requestWebNotificationPermission } from '../lib/alerts/webNotification';

// The mocks carry the REAL signatures of the functions they stand in for, so a
// change to the notification contract (a fourth argument, a different return)
// reds this file instead of letting it keep asserting against a shape the app no
// longer uses — and so `show.mock.calls[0][2]` below is the tag, checked.
const show = vi.hoisted(() => vi.fn<typeof showNotification>(async () => true));
const request = vi.hoisted(() =>
  vi.fn<typeof requestWebNotificationPermission>(async () => 'granted' as NotificationPermission),
);

vi.mock('../lib/alerts/webNotification', () => ({
  showNotification: show,
  requestWebNotificationPermission: request,
  notificationPermission: () => 'granted',
  hasNotificationApi: () => true,
}));

import { useNotifications } from './useNotifications';
import { INBOX_STORAGE_KEY } from '../lib/alerts/inbox';
import type { Evaluation } from '../lib/alerts/evaluate';

const NOW = 1_760_000_000;

function firedEvaluation(key = 'heat-tier:r1:a->b'): Evaluation {
  return {
    ruleId: 'r1',
    kind: 'heat-tier',
    verdict: 'fired',
    detail: 'changed',
    evaluatedAt: NOW,
    events: [
      {
        idempotencyKey: key,
        ruleId: 'r1',
        kind: 'heat-tier',
        title: 'Heat tier change',
        body: 'Observer → Builder.',
        provenance: 'Jungle Bay Island’s held-time oracle (memetics.wtf)',
        observedAt: NOW,
        anchor: null,
      },
    ],
  };
}

function gapEvaluation(): Evaluation {
  return {
    ruleId: 'r2',
    kind: 'whale-move',
    verdict: 'cannot-evaluate',
    detail: 'The indexer is not configured on this deployment.',
    evaluatedAt: NOW,
    events: [],
  };
}

const LABELS = { r1: 'Heat tier — 0x4206…8F9D', r2: 'Transfers of 0x4206…8F9D' };

/** StrictMode double-invokes effects and updaters, which is the point of using it here. */
const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

function setNotificationPermission(permission: NotificationPermission) {
  vi.stubGlobal('Notification', { permission, requestPermission: request });
}

beforeEach(() => {
  localStorage.clear();
  show.mockClear();
  show.mockResolvedValue(true);
  request.mockClear();
  setNotificationPermission('granted');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('one fired event produces exactly one notification', () => {
  it('shows once under StrictMode, and stamps the row only after it succeeded', async () => {
    const { result } = renderHook(() => useNotifications([firedEvaluation()], LABELS), { wrapper: strict });
    await act(async () => {
      await Promise.resolve();
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![2]).toBe('heat-tier:r1:a->b');
    expect(result.current.entries[0]!.channels).toEqual(['in-app', 'web-notification']);
  });

  it('a re-render with the same evaluations does not announce again', async () => {
    const { result, rerender } = renderHook(({ e }: { e: Evaluation[] }) => useNotifications(e, LABELS), {
      wrapper: strict,
      initialProps: { e: [firedEvaluation()] },
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ e: [firedEvaluation()] });
    await act(async () => {
      await Promise.resolve();
    });
    // The 60s loop hands the same pass back over and over; without the dedup this
    // would be a notification a minute for one fact.
    expect(show).toHaveBeenCalledTimes(1);
    expect(result.current.entries).toHaveLength(1);
  });
});

describe('a row never claims a notification that did not happen', () => {
  it('leaves the row in-app only when the show returns false', async () => {
    // Android Chrome with no registered worker: the constructor throws, the
    // fallback finds nothing, and nothing is shown.
    show.mockResolvedValue(false);
    const { result } = renderHook(() => useNotifications([firedEvaluation()], LABELS), { wrapper: strict });
    await act(async () => {
      await Promise.resolve();
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0]!.channels).toEqual(['in-app']);
  });

  it('shows nothing at all when permission is not granted', async () => {
    setNotificationPermission('default');
    const { result } = renderHook(() => useNotifications([firedEvaluation()], LABELS), { wrapper: strict });
    await act(async () => {
      await Promise.resolve();
    });
    expect(show).not.toHaveBeenCalled();
    expect(result.current.entries[0]!.channels).toEqual(['in-app']);
    expect(result.current.plan).not.toContain('web-notification');
  });

  it('never notifies for a gap', async () => {
    // An hour of outage would otherwise be an hour of buzzing about the same
    // unreadable source.
    const { result } = renderHook(() => useNotifications([gapEvaluation()], LABELS), { wrapper: strict });
    await act(async () => {
      await Promise.resolve();
    });
    expect(show).not.toHaveBeenCalled();
    expect(result.current.entries[0]!.kind).toBe('gap');
    expect(result.current.unread.gaps).toBe(1);
  });
});

describe('the channel list is live, not frozen at mount', () => {
  it('re-resolves after the permission request answers', async () => {
    setNotificationPermission('default');
    const { result } = renderHook(() => useNotifications([], LABELS), { wrapper: strict });
    expect(result.current.channels.find((c) => c.id === 'web-notification')!.state).toBe('off');

    setNotificationPermission('granted');
    await act(async () => {
      result.current.requestNotificationPermission();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalled();
    // Memoised once per mount, a grant would leave the panel saying "off" until
    // the next reload while notifications were already arriving.
    expect(result.current.channels.find((c) => c.id === 'web-notification')!.state).toBe('ready');
  });
});

describe('two tabs share one inbox', () => {
  it('adopts another tab’s entries on a storage event', async () => {
    // A STABLE array, the way the evaluation loop hands one over: a fresh array
    // each render would re-fold the pass and re-create the row this test is
    // watching disappear.
    const evaluations = [firedEvaluation()];
    const { result } = renderHook(() => useNotifications(evaluations, LABELS), { wrapper: strict });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.entries).toHaveLength(1);

    const foreign = JSON.stringify({
      entries: [
        {
          id: 'other',
          kind: 'event',
          ruleId: 'r9',
          ruleKind: 'launch-live',
          title: 'Launch live',
          body: 'A pool is live.',
          at: NOW,
          read: true,
          channels: ['in-app'],
        },
      ],
    });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: INBOX_STORAGE_KEY, newValue: foreign }));
    });
    // A row marked read in one tab must not look unread in the other.
    expect(result.current.entries.map((e) => e.id)).toEqual(['other']);
    expect(result.current.unread.total).toBe(0);
    // And adopting an inbox does not re-announce anything.
    expect(show).toHaveBeenCalledTimes(1);
  });
});
