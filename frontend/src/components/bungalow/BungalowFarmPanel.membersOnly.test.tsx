// A MEMBERS-ONLY POOL IS NOT NAMED TO EVERY VISITOR. With the Streamflow pool closed
// and a ladder beside it, /farm shows the old pool only to wallets staked in it, so
// the hero, the page description and the loading line name the lock ladder instead.
// The pool slot is held suspended here, so the loading line is what renders.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';

const never = new Promise<never>(() => {});
const Suspends = () => { throw never; };
vi.mock('./SolanaPoolStack', () => ({ SolanaPoolStack: Suspends }));
vi.mock('./SolanaLadderPoolLive', () => ({ SolanaLadderPoolLive: Suspends }));
vi.mock('./LighthousePoolLive', () => ({ LighthousePoolLive: Suspends }));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const BASE = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana', status: 'live',
  tagline: 'The muse.', address: '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL',
  stakePool: 'STREAMFLOW', ladderPool: 'LADDER', decimals: 6, pools: [],
};
const draw = (b: object) => render(<MemoryRouter><BungalowFarmPanel bungalow={b as Bungalow} /></MemoryRouter>);
const description = () => document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
const EM_DASH = String.fromCharCode(0x2014);

describe('/farm for a members-only pool', () => {
  it('⚠️ names the lock ladder in the hero, the description and the loading line, never the lighthouse pool', async () => {
    draw({ ...BASE, depositsClosed: true });
    expect(await screen.findByText(/Loading the lock ladder/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/lighthouse/i);
    const hero = screen.getByText(/lock ladder is live for BAYLA/i);
    expect(hero.textContent).not.toContain(EM_DASH);
    expect(description()).toMatch(/lock ladder is live/i);
    expect(description()).not.toMatch(/lighthouse/i);
    expect(description()).not.toContain(EM_DASH);
  });

  it('a bungalow whose only pool is its ladder is told it is live, not "being built"', async () => {
    draw({ ...BASE, stakePool: undefined });
    await screen.findByText(/Loading the lock ladder/);
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/being built/i);
    expect(page).toMatch(/lock ladder is live for BAYLA/i);
  });

  it.each([
    ['an open pool beside a ladder', { ...BASE }],
    ['a closed pool with no ladder', { ...BASE, ladderPool: undefined, depositsClosed: true }],
  ])('%s still names the lighthouse pool', async (_label, b) => {
    draw(b);
    expect(await screen.findByText(/Loading the lighthouse/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/lighthouse pool is live for BAYLA/i);
    expect(description()).toMatch(/lighthouse pool is live/i);
  });
});
