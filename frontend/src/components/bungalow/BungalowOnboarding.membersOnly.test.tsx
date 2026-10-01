// THE WELCOME DOES NOT INTRODUCE A MEMBERS-ONLY POOL. It is shown only to the wallets
// still in it, and a welcome cannot tell who those are, so the last step introduces the
// lock ladder. Every other bungalow keeps the step it had.

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { BungalowOnboarding } from './BungalowOnboarding';

type Welcomed = Bungalow & { identity: BungalowIdentity };
const BASE = {
  id: 'bayla', name: 'Bayla', symbol: 'BAYLA', chain: 'solana', status: 'LIVE', tagline: 'Test.',
  identity: { heroCopy: 'Hello.' }, stakePool: 'EFWpStreamflow111111111111111111111111111111',
};
const MEMBERS_ONLY = { ...BASE, ladderPool: 'LadderPool1111111111111111111111111111111111', depositsClosed: true } as unknown as Welcomed;

/** Open the welcome and walk to its last step. */
function lastStep(b: Welcomed) {
  render(<ThemeProvider><MemoryRouter><BungalowOnboarding bungalow={b} invitedOpen /></MemoryRouter></ThemeProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  return document.body.textContent ?? '';
}

describe('the welcome’s last step', () => {
  it('introduces the ladder, and never the members-only pool', () => {
    const text = lastStep(MEMBERS_ONLY);
    expect(text).toContain('The lock ladder');
    expect(text).toMatch(/BAYLA staking runs on the venue's own lock ladder/);
    expect(text).not.toMatch(/lighthouse/i);
    expect(screen.getByRole('link', { name: 'See the ladder' }).getAttribute('href')).toBe('/farm');
  });

  it.each([
    ['an open Streamflow pool (BOBO, SOY, BRAINLET, RIZZ)', { ...BASE, id: 'bobo', symbol: 'BOBO' }],
    ['a closed pool with NO ladder configured', { ...BASE, depositsClosed: true }],
  ])('%s keeps the lighthouse step it had', (_label, b) => {
    const text = lastStep(b as unknown as Welcomed);
    expect(text).toContain('The lighthouse pool');
    expect(text).toMatch(/the lighthouse pool is on-chain and the farm page reads it directly/);
    expect(screen.getByRole('link', { name: 'See the lighthouse' })).toBeTruthy();
  });
});
