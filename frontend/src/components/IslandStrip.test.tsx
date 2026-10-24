// The island today, on the home (the island's venue review, item 9): $BAYLA locked in
// the ladder, $BAYLA fed to the fire, the flames, then the season and the last torch with
// its room and its age. Read on load, never typed; a part that fails is left out, never a
// zero, and with nothing read there is no strip.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearTorchesCache } from '../lib/heat/torchesClient';

const ladder = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<{ symbol: string; raw: bigint; decimals: number } | null> => null),
}));
vi.mock('../lib/ladder/locked', () => ({ readLadderLocked: ladder.read }));

const { IslandStrip } = await import('./IslandStrip');

const PROXY_BODY = {
  places: [],
  last_torch: { kind: 'bungalow', place: 'jungle-bay', label: '$JBM', name: '_seacasa', amount: 75000, lit_at: '2026-10-15T21:05:11.000Z' },
  fire: { burned: 5716710 },
  season: { season: 1, ends_at: '2026-12-29T04:38:15.000Z' },
  flames: 134,
  as_of_unix: 1792746261,
};
const LOCKED = { symbol: 'BAYLA', raw: 15_104_482_123_456n, decimals: 6 };

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

const draw = () => render(<MemoryRouter><IslandStrip /></MemoryRouter>);

beforeEach(() => {
  clearTorchesCache();
  ladder.read.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T03:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the strip, every part read', () => {
  it('three live numbers, then the season and the last torch with its room and age', async () => {
    ladder.read.mockResolvedValue(LOCKED);
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    const { container } = draw();
    expect(await screen.findByTestId('island-strip-locked')).toHaveTextContent('15,104,482 $BAYLA locked');
    expect(screen.getByTestId('island-strip-fire')).toHaveTextContent('5,716,710 $BAYLA fed to the fire');
    expect(screen.getByTestId('island-strip-flames')).toHaveTextContent('134 flames');
    expect(screen.getByTestId('island-strip-season')).toHaveTextContent('67 days left in season one');
    expect(screen.getByTestId('island-strip-last')).toHaveTextContent('The last torch: $JBM, by _seacasa, 7 days ago');
    expect(screen.getByRole('link', { name: '$JBM' })).toHaveAttribute('href', '/jbm');
    expect(container.querySelector('[data-card-art]')).not.toBeNull();
  });
});

describe('the last torch, as the island counts it', () => {
  it('a feed to the fire is the last torch when it is the newest, and its place is the fire', async () => {
    ladder.read.mockResolvedValue(null);
    const feed = { kind: 'fire', place: 'fire', label: 'THE FIRE', name: '_seacasa', amount: 100000, lit_at: '2026-10-23T02:24:43.000Z' };
    vi.stubGlobal('fetch', answer(200, { ...PROXY_BODY, last_torch: feed }));
    draw();
    expect(await screen.findByTestId('island-strip-last')).toHaveTextContent('The last torch: the fire, by _seacasa, 35 minutes ago');
    expect(screen.queryByRole('link', { name: /THE FIRE/ })).toBeNull();
  });
});

describe('each part stands alone', () => {
  it('a ladder that could not be read is left out; the island\'s parts stay', async () => {
    ladder.read.mockResolvedValue(null);
    vi.stubGlobal('fetch', answer(200, PROXY_BODY));
    draw();
    expect(await screen.findByTestId('island-strip-fire')).toBeInTheDocument();
    expect(screen.queryByTestId('island-strip-locked')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0 \$BAYLA locked/);
  });

  it('an island part the proxy could not read is left out, never a zero', async () => {
    ladder.read.mockResolvedValue(LOCKED);
    vi.stubGlobal('fetch', answer(200, { ...PROXY_BODY, fire: null, flames: null, season: null }));
    draw();
    expect(await screen.findByTestId('island-strip-locked')).toBeInTheDocument();
    expect(await screen.findByTestId('island-strip-last')).toBeInTheDocument();
    expect(screen.queryByTestId('island-strip-fire')).toBeNull();
    expect(screen.queryByTestId('island-strip-flames')).toBeNull();
    expect(screen.queryByTestId('island-strip-season')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0 (?:\$BAYLA|flames)/);
  });

  it('with nothing read there is no strip', async () => {
    ladder.read.mockResolvedValue(null);
    const fetchMock = answer(502, { error: 'The island could not be read' });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = draw();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(ladder.read).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('where the strip is mounted', () => {
  it('on the venue home, directly under the doors', () => {
    const home = readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(home).toMatch(
      // (A JSX comment between the two leaves `{}` once the comment text is stripped.)
      /\{!bungalowIdentity && !isToweliArrival && <VenueDoors \/>\}\s*(?:\{\}\s*)*\{!bungalowIdentity && !isToweliArrival && <IslandStrip \/>\}/,
    );
  });
});
