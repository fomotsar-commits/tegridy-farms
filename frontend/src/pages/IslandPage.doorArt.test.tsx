// Each island lobby door keeps its own art surface (lib/artSurfaces.ts, island idx 1, 3, 5),
// whichever doors the nav lists. By position, Venue Score leaving the nav (2026-10-15) moved
// "Treasury & numbers" onto Venue Score's painting. The Marketplace door (island idx 2) left
// the lobby with the nav on 2026-10-24.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/ui/CardArt', () => ({
  CardArt: ({ pageId, idx }: { pageId: string; idx: number }) => <span data-art={`${pageId}:${idx}`} />,
}));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/VenueCards', () => ({ VenueCards: () => <div data-testid="venue-cards" /> }));

import IslandPage from './IslandPage';

describe('the island lobby doors', () => {
  it('keep the art surface registered for each door', () => {
    render(
      <MemoryRouter initialEntries={['/island']}>
        <IslandPage />
      </MemoryRouter>,
    );
    const artOf = (name: RegExp) =>
      screen.getByRole('link', { name }).querySelector('[data-art]')?.getAttribute('data-art');
    expect(artOf(/^Gallery/)).toBe('island:1');
    expect(screen.queryByRole('link', { name: /^Marketplace/ }), 'no door to the marketplace').toBeNull();
    expect(artOf(/^Community/)).toBe('island:3');
    expect(artOf(/^Treasury & numbers/), "Venue Score's slot (4) is not this door's").toBe('island:5');
  });

  // The points program is deleted (owner, 2026-10-15): the lobby promises no score.
  it('speak of no score', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/island']}>
        <IslandPage />
      </MemoryRouter>,
    );
    expect(container.textContent).not.toMatch(/\bscore\b/i);
  });

  // The home's three cards, swap, lock BAYLA and add SOL + BAYLA, are on the lobby too (owner,
  // 2026-10-19: "lets put them there again"), above the board and the doors.
  it("carry the home's three cards, above the doors", () => {
    render(
      <MemoryRouter initialEntries={['/island']}>
        <IslandPage />
      </MemoryRouter>,
    );
    const cards = screen.getByTestId('venue-cards');
    const firstDoor = screen.getByRole('link', { name: /^Gallery/ });
    expect(cards.compareDocumentPosition(firstDoor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
