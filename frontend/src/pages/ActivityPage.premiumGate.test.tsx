/**
 * F523 / F9 — the Gold Card gate survives, in BOTH of its states.
 *
 * ActivityPage is the one tabbed host whose selected tab is not simply its URL.
 * While PREMIUM_ACCESS is dark it does two things at once: it drops the Gold Card
 * tab out of the strip (F9 — promoting a tab that dead-ends in a "not deployed"
 * placeholder), and it self-heals `/premium` to the live Points panel rather than
 * showing that placeholder to whoever followed an old link (F523).
 *
 * WHY THIS FILE EXISTS. That behaviour had no test. It survived the 2026-09-04
 * migration of this host onto the shared RouteTabs strip on inspection alone,
 * which is not a thing that can be said twice — the migration moved the strip out
 * of this file, so the next person to touch either side has nothing telling them
 * the two are coupled. It is also the branch nobody runs: PREMIUM_ACCESS_ADDRESS
 * is a real address today, so `PREMIUM_LIVE` is TRUE in every build and the dark
 * path is reachable only by mocking it. An untested branch that is also an
 * unexecuted branch is how a gate rots without anyone noticing.
 *
 * Both states are asserted. Pinning only the dark one would pass just as well
 * against a host that had simply deleted the Gold Card tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Flipped per test. A getter (not a literal) because the host reads PREMIUM_LIVE
// during render, so the value has to be live at access time, not frozen when the
// module factory ran.
let premiumLive = false;
vi.mock('../lib/navConfig', () => ({
  get PREMIUM_LIVE() {
    return premiumLive;
  },
}));

// The four hosted pages are lazy-loaded route content; the subject is the strip
// and the panel switch above them.
vi.mock('./LeaderboardPage', () => ({ default: () => <div>points panel</div> }));
vi.mock('./PremiumPage', () => ({ default: () => <div>gold panel</div> }));
vi.mock('./HistoryPage', () => ({ default: () => <div>history panel</div> }));
vi.mock('./ChangelogPage', () => ({ default: () => <div>changelog panel</div> }));

import ActivityPage from './ActivityPage';

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ActivityPage />
    </MemoryRouter>,
  );

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.trim());
const selected = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

describe('while PREMIUM_ACCESS is dark', () => {
  beforeEach(() => {
    premiumLive = false;
  });

  it('does not offer Gold Card as a tab', () => {
    at('/leaderboard');
    expect(tabNames()).toEqual(['Points', 'History', 'Changelog']);
  });

  it('sends /premium to the Points panel instead of the placeholder', async () => {
    at('/premium');
    expect(await screen.findByText('points panel')).toBeInTheDocument();
    expect(screen.queryByText('gold panel')).not.toBeInTheDocument();
  });

  it('highlights Points on /premium, so the strip agrees with the panel', () => {
    at('/premium');
    // The URL says /premium and the strip has no such tab; the one that IS
    // selected must be the one whose content is actually rendered below.
    expect(selected()).toHaveTextContent('Points');
    expect(tabNames()).not.toContain('Gold Card');
  });

  it('labels the panel by a tab that is really in the document', () => {
    at('/premium');
    // aria-labelledby pointing at the filtered-out Gold Card tab would be a
    // dangling reference: silent in a browser, invisible to a class assertion.
    const panel = screen.getByRole('tabpanel');
    const id = panel.getAttribute('aria-labelledby')!;
    expect(document.getElementById(id), `no tab with id "${id}" is rendered`).not.toBeNull();
    expect(document.getElementById(id)).toBe(selected());
  });
});

describe('once PREMIUM_ACCESS is live', () => {
  beforeEach(() => {
    premiumLive = true;
  });

  it('restores the Gold Card tab, in its original position', () => {
    at('/leaderboard');
    expect(tabNames()).toEqual(['Points', 'Gold Card', 'History', 'Changelog']);
  });

  it('stops self-healing /premium and shows the real Gold Card', async () => {
    at('/premium');
    expect(await screen.findByText('gold panel')).toBeInTheDocument();
    expect(selected()).toHaveTextContent('Gold Card');
  });
});

describe('the routes that were never gated', () => {
  beforeEach(() => {
    premiumLive = false;
  });

  it.each([
    ['/leaderboard', 'points panel', 'Points'],
    ['/history', 'history panel', 'History'],
    ['/changelog', 'changelog panel', 'Changelog'],
  ])('%s renders %s with %s selected', async (path, panel, tab) => {
    at(path);
    expect(await screen.findByText(panel)).toBeInTheDocument();
    expect(selected()).toHaveTextContent(tab);
  });
});
