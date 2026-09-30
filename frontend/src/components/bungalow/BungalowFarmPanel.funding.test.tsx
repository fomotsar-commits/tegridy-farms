// How a room's pool gets funded. The venue does not control a pump.fun coin's creator fee
// (the island's ledger: BAYLA's goes "Whole, no split."), so no room offers it as a route,
// pump-born or not. The live pool cards are stubbed: their copy is theirs to answer for.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';

vi.mock('./LighthousePoolLive', () => ({ LighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaLadderPoolLive', () => ({ SolanaLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLadderPoolLive', () => ({ EvmLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLighthousePoolLive', () => ({ EvmLighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaPoolStack', () => ({ SolanaPoolStack: () => <div data-testid="pool-card" /> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const ROOMS = BUNGALOWS.filter((b) => b.live && b.id !== 'toweli');

describe("a room's farm offers no creator-fee route", () => {
  it('judges the pump-born rooms, where the route used to show', () => {
    expect(ROOMS.filter((b) => b.address?.endsWith('pump')).map((b) => b.id).sort()).toEqual(
      ['bayla', 'bobo', 'brainlet', 'soy'],
    );
  });

  for (const b of ROOMS) {
    it(`${b.id}: venue swap fees and community top-ups, nothing else`, () => {
      const { unmount } = render(
        <MemoryRouter>
          <BungalowFarmPanel bungalow={b} />
        </MemoryRouter>,
      );
      const card = screen.getByRole('heading', { name: 'Routes under evaluation' }).parentElement!;
      const routes = within(card)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('strong')?.textContent);
      expect(routes).toEqual(['Venue swap fees', 'Community top-ups']);
      expect(card.textContent).not.toMatch(/creator.fee|pump\.fun/i);
      unmount();
    });
  }
});
