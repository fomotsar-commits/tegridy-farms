// A room's torches (the island's venue review, item 6). Done means: /bayla shows its live
// "N of 12 lit · the next torch X $BAYLA", and a tap lands on the island's bungalow page.
// A failed read, or a room the venue has not pinned, draws nothing: never "0 of 12".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearTorchesCache } from '../lib/heat/torchesClient';
import { RoomTorches } from './RoomTorches';

const PROXY_BODY = {
  places: [{
    place: 'solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump', label: '$BAYLA', torches: 7, open_row: 1,
    next_price: 200000, slots_per_row: 12, last: { name: '_seacasa', amount: 175000, lit_at: '2026-10-15T00:27:48.000Z' },
  }, {
    place: 'pepe-unpinned-shape', label: '$X', torches: 1, open_row: 1, next_price: 50000, slots_per_row: 12, last: null,
  }, {
    place: 'ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933', label: '$PEPE', torches: 1, open_row: 1,
    next_price: 50000, slots_per_row: 12, last: { name: null, amount: 25000, lit_at: '2026-10-03T05:53:22.000Z' },
  }],
  last_torch: null, fire: null, season: null, flames: null, as_of_unix: 1792746261,
};

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

beforeEach(() => {
  clearTorchesCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T03:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RoomTorches on a room door', () => {
  it('BAYLA: the live line, the last torch, and Torch it to the island page', async () => {
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    const { container } = render(<RoomTorches roomId="bayla" />);
    expect(await screen.findByTestId('room-torches-line')).toHaveTextContent('7 of 12 lit · the next torch 200,000 $BAYLA');
    expect(screen.getByText('Last lit by _seacasa, 8 days ago')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Torch it/ });
    expect(link).toHaveAttribute('href', 'https://memetics.wtf/b/bayla');
    expect(link).toHaveAttribute('target', '_blank');
    // Every card keeps its art.
    expect(container.querySelector('[data-card-art]')).not.toBeNull();
  });

  it('a torch lit by someone with no name says so, instead of a blank', async () => {
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    render(<RoomTorches roomId="pepe" />);
    expect(await screen.findByText('Last lit by someone with no name yet, 19 days ago')).toBeInTheDocument();
  });

  it('a failed read draws nothing, and no zero', async () => {
    const fetchMock = answer(502, { error: 'The island could not be read' });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<RoomTorches roomId="bayla" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('a room the venue has not pinned draws nothing', async () => {
    const fetchMock = answer(200, PROXY_BODY);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<RoomTorches roomId="nb1" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('compact, inside a pool card: the same line, no art layer of its own', async () => {
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    const { container } = render(<RoomTorches roomId="bayla" compact />);
    expect(await screen.findByTestId('room-torches-line')).toHaveTextContent('7 of 12 lit');
    expect(container.querySelector('[data-card-art]')).toBeNull();
  });
});

describe('where the room torches are mounted', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('every room door, TOWELI\'s included, carries its torches under the hero', () => {
    expect(src('src/pages/HomePage.tsx')).toMatch(
      /\(bungalowIdentity \|\| isToweliArrival\) && <RoomTorches roomId=\{bungalowIdentity\?\.id \?\? 'toweli'\} \/>/,
    );
  });
});
