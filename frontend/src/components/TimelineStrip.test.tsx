// THE TIMELINE (island answer twenty-four, build 7): one strip in every room and on the home,
// the newest piece hung on the island with its picture and its artist, the island's line, and
// one tap to the island where it hangs. It rides the torches read the doors already make; a
// read that failed, or one with no piece hung, draws nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRENCHER_WORDS } from '../lib/arrival';
import { clearTorchesCache } from '../lib/heat/torchesClient';
import { TimelineStrip } from './TimelineStrip';

// /api/aggregator?resource=torches with the piece the island hung newest on 2026-11-03.
const PIECE = {
  image: 'https://junglebayisland.com/api/storage-image?key=gallery%2Floground%2F7f4dc061-e10a-4ae3-b73f-83e078efad26%2Flarge.webp',
  artist: 'loground',
  title: 'Halloween',
  door: 'https://memetics.wtf/b/ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933',
  lit_at: '2026-10-28T20:55:02.000Z',
};
const PROXY_BODY = { places: [], last_torch: null, last_piece: PIECE, fire: null, season: null, flames: null, as_of_unix: 1793677136 };

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

beforeEach(() => clearTorchesCache());
afterEach(() => vi.unstubAllGlobals());

describe('the strip, read', () => {
  it('the piece’s picture, its title and artist, the island’s line, and one tap to where it hangs', async () => {
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    const { container } = render(<TimelineStrip />);
    const strip = await screen.findByTestId('timeline-strip');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', PIECE.door);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(strip).toContainElement(link);
    const img = link.querySelector(`img[src="${PIECE.image}"]`);
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(link).toHaveTextContent('Halloween');
    expect(link).toHaveTextContent('loground');
    expect(link).toHaveTextContent(TRENCHER_WORDS.timeline);
    expect(link).toHaveTextContent('Art on this timeline since 2021, every day.');
    // Every card keeps its art.
    expect(container.querySelector('[data-card-art]')).not.toBeNull();
    expect(strip.textContent).not.toMatch(/—/);
  });

  it('a piece with no title is credited by its artist alone', async () => {
    vi.stubGlobal('fetch', answer(200, { ...PROXY_BODY, last_piece: { ...PIECE, title: null } }));
    render(<TimelineStrip />);
    const link = await screen.findByRole('link');
    expect(link).toHaveTextContent('loground');
    expect(link).not.toHaveTextContent('null');
  });

  it('a picture that does not load leaves the words and the tap, never a broken image', async () => {
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    render(<TimelineStrip />);
    const link = await screen.findByRole('link');
    // The piece's own picture; the card's art behind the strip is another <img>.
    const piece = () => link.querySelector(`img[src="${PIECE.image}"]`);
    fireEvent.error(piece()!);
    expect(piece()).toBeNull();
    expect(link).toHaveTextContent(TRENCHER_WORDS.timeline);
  });
});

describe('unread, it is left out', () => {
  it.each([
    ['the island could not be read', () => answer(502, { error: 'The island could not be read' })],
    ['no piece is hung', () => answer(200, { ...PROXY_BODY, last_piece: null })],
    ['the proxy is older than the piece', () => answer(200, { ...PROXY_BODY, last_piece: undefined })],
  ])('draws nothing when %s', async (_why, fetchImpl) => {
    const f = fetchImpl();
    vi.stubGlobal('fetch', f);
    const { container } = render(<TimelineStrip />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });
});

describe('where it hangs: every room and the home', () => {
  // Comments stripped, so a placement named in a comment does not count as one.
  const home = readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('in every room, beside the room’s torches and under the same gate', () => {
    expect(home).toContain('{(bungalowIdentity || isToweliArrival) && <RoomTorches');
    expect(home).toMatch(/\{\(bungalowIdentity \|\| isToweliArrival\) && <TimelineStrip className="mt-6" \/>\}/);
  });

  it('on the home, beside the island today and under the same gate', () => {
    expect(home).toContain('{!bungalowIdentity && !isToweliArrival && <IslandStrip />}');
    expect(home).toMatch(/\{!bungalowIdentity && !isToweliArrival && <TimelineStrip className="pb-16" \/>\}/);
  });
});
