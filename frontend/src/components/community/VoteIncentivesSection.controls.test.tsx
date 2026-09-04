/**
 * A11Y-R10 — the bribe-leaderboard filter row is named.
 *
 * A search input named only by `placeholder`, a `<select>` with no accessible
 * name at all, and a 14px checkbox — on /community, in a section the route
 * sweep never reaches because it only mounts once the gauge contracts are
 * wired. `getByRole('combobox', { name: /sort/i })` THROWS on the pre-change
 * component, which is the whole point of writing it that way.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 1,
}));

import { LeaderboardControls } from './VoteIncentivesSection';

const noop = () => {};

function renderControls() {
  return render(
    <LeaderboardControls
      search=""
      setSearch={noop}
      sort="bribe"
      setSort={noop}
      hideEmpty={false}
      setHideEmpty={noop}
      total={12}
      shown={12}
    />,
  );
}

describe('LeaderboardControls', () => {
  it('names the search input and the sort select', () => {
    renderControls();
    expect(screen.getByRole('textbox', { name: /search gauges/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /sort/i })).toBeInTheDocument();
  });

  it('gives the checkbox row a 44px target and a 16px box', () => {
    renderControls();
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.className).toContain('w-4');
    expect(checkbox.className).toContain('h-4');
    expect(checkbox.closest('label')!.className).toContain('min-h-[44px]');
  });
});
