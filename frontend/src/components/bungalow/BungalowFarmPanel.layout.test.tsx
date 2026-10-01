// THE LIVE POOL LEADS. The ladder comes first in the DOM (never CSS `order`, so
// keyboard and screen-reader order match the screen) and spans the full row. An OPEN
// Streamflow pool keeps its full card beside the funding card. A CLOSED one beside a
// ladder is members-only (owner, 2026-09-21): its claim strip stacks under the ladder
// in the same full-row cell, and the funding card spans row 2 alone.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./LighthousePoolLive', () => ({
  LighthousePoolLive: () => <div data-testid="lighthouse-card">lighthouse</div>,
  LighthouseClaimStrip: () => <div data-testid="claim-strip">strip</div>,
}));
vi.mock('./SolanaLadderPoolLive', () => ({
  SolanaLadderPoolLive: () => <div data-testid="ladder-card">ladder</div>,
  SolanaLadderPoolCard: () => <div data-testid="ladder-card">ladder</div>,
}));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const BASE = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana', status: 'live',
  tagline: 'x.', address: '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL',
  stakePool: 'STREAMFLOW', ladderPool: 'LADDER', decimals: 6, pools: [],
};
const OPEN_BESIDE_LADDER = { ...BASE, depositsClosed: undefined } as unknown as Bungalow;
const MEMBERS_ONLY = { ...BASE, depositsClosed: true } as unknown as Bungalow;
const CLOSED_NO_LADDER = { ...BASE, ladderPool: undefined, depositsClosed: true } as unknown as Bungalow;

const draw = (b: Bungalow) => render(<MemoryRouter><BungalowFarmPanel bungalow={b} /></MemoryRouter>);
const fundingCard = () => screen.getByText('How the pool gets funded').closest('div.rounded-2xl')!;

describe('BungalowFarmPanel layout', () => {
  describe('an open Streamflow pool beside a ladder', () => {
    it('⚠️ renders the LIVE ladder before the lighthouse pool, in DOM order', async () => {
      draw(OPEN_BESIDE_LADDER);
      const ladder = await screen.findByTestId('ladder-card');
      const lighthouse = await screen.findByTestId('lighthouse-card');
      // DOCUMENT_POSITION_FOLLOWING: the lighthouse comes AFTER the ladder.
      expect(ladder.compareDocumentPosition(lighthouse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('gives the ladder the full row, and keeps BOTH full cards', async () => {
      draw(OPEN_BESIDE_LADDER);
      const ladder = await screen.findByTestId('ladder-card');
      expect(ladder.parentElement!.className).toMatch(/lg:col-span-2/);
      expect(await screen.findByTestId('lighthouse-card')).toBeTruthy();
      expect(screen.queryByTestId('claim-strip')).toBeNull();
      // Visual order is DOM order: nothing reorders with CSS.
      expect(ladder.parentElement!.parentElement!.innerHTML).not.toMatch(/\border-/);
    });
  });

  describe('a CLOSED Streamflow pool beside a ladder (members-only)', () => {
    it('⚠️ stacks the claim strip under the ladder in ONE full-row cell, and draws no full card', async () => {
      draw(MEMBERS_ONLY);
      const ladder = await screen.findByTestId('ladder-card');
      const strip = screen.getByTestId('claim-strip');
      expect(screen.queryByTestId('lighthouse-card')).toBeNull();
      expect(ladder.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const cell = ladder.closest('.lg\\:col-span-2')!;
      expect(cell.className).toMatch(/\bmin-w-0\b/);
      expect(cell.contains(strip)).toBe(true);
      expect(cell.parentElement!.className).toMatch(/\bgrid\b/);
      expect(cell.parentElement!.innerHTML).not.toMatch(/\border-/);
    });

    it('lets the funding card span row 2, so it never sits beside a hole', async () => {
      draw(MEMBERS_ONLY);
      await screen.findByTestId('ladder-card');
      expect(fundingCard().className).toMatch(/lg:col-span-2/);
    });
  });

  it('a closed pool with NO ladder keeps its full card: the page is never left without a pool', async () => {
    draw(CLOSED_NO_LADDER);
    expect(await screen.findByTestId('lighthouse-card')).toBeTruthy();
    expect(screen.queryByTestId('claim-strip')).toBeNull();
    expect(screen.queryByTestId('ladder-card')).toBeNull();
  });

  it('an open pool beside a ladder shares row 2 with the funding card', async () => {
    draw(OPEN_BESIDE_LADDER);
    await screen.findByTestId('lighthouse-card');
    expect(fundingCard().className).not.toMatch(/lg:col-span-2/);
  });
});
