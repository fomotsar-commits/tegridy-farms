// THE LIVE POOL LEADS.
//
// The panel used to render the CLOSED Streamflow pool first and the live Lock Ladder
// beside it, so on a phone the product anyone can actually stake into began about
// 1,360px down the page, under a card whose only job left is paying out existing
// locks. The ladder now comes first in the DOM — not by CSS `order`, so keyboard and
// screen-reader order match what is on screen — and spans the full row.
//
// Both cards must still render: the closed pool's stakers need its claim controls.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';

vi.mock('./LighthousePoolLive', () => ({
  LighthousePoolLive: () => <div data-testid="lighthouse-card">lighthouse</div>,
}));
vi.mock('./SolanaLadderPoolLive', () => ({
  SolanaLadderPoolLive: () => <div data-testid="ladder-card">ladder</div>,
}));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const BOTH = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana', status: 'live',
  tagline: 'x.', address: '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL',
  stakePool: 'STREAMFLOW', ladderPool: 'LADDER', decimals: 6, pools: [],
} as unknown as Bungalow;

describe('BungalowFarmPanel layout', () => {
  it('⚠️ renders the LIVE ladder before the closed lighthouse pool, in DOM order', async () => {
    render(<MemoryRouter><BungalowFarmPanel bungalow={BOTH} /></MemoryRouter>);
    const ladder = await screen.findByTestId('ladder-card');
    const lighthouse = await screen.findByTestId('lighthouse-card');
    // DOCUMENT_POSITION_FOLLOWING: the lighthouse comes AFTER the ladder.
    expect(ladder.compareDocumentPosition(lighthouse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the ladder the full row, and keeps BOTH cards', async () => {
    render(<MemoryRouter><BungalowFarmPanel bungalow={BOTH} /></MemoryRouter>);
    const ladder = await screen.findByTestId('ladder-card');
    expect(ladder.parentElement!.className).toMatch(/lg:col-span-2/);
    expect(await screen.findByTestId('lighthouse-card')).toBeTruthy();
    // Visual order is DOM order: nothing reorders with CSS.
    expect(ladder.parentElement!.parentElement!.innerHTML).not.toMatch(/\border-/);
  });
});
