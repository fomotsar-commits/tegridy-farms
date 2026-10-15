/**
 * Jungle Bay's music, as a quiet signature: plain links with a spoken name, in three
 * places and no others, and the same two artist pages in index.html's structured data.
 * The placement list is the guard that keeps the links out of trade and stake forms,
 * quotes, prices, wallet connect and warnings: a new mount has to be added here, on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { ISLAND_SOUND } from '../lib/islandSound';
import { IslandHum, IslandSoundLinks } from './IslandSound';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
}));

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(SRC, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');

function expectOutbound(link: HTMLElement, href: string) {
  expect(link.getAttribute('href')).toBe(href);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
}

describe('the music links', () => {
  it('name each artist page for a screen reader and open it in a new tab', () => {
    render(<IslandSoundLinks />);
    expectOutbound(screen.getByRole('link', { name: 'jungle bay on spotify (opens in new tab)' }), ISLAND_SOUND.spotify);
    expectOutbound(screen.getByRole('link', { name: 'jungle bay on youtube (opens in new tab)' }), ISLAND_SOUND.youtube);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('the empty-state line links the featured track, and says which one', () => {
    render(<IslandHum />);
    const link = screen.getByRole('link', { name: /^the island hums meanwhile: memetic sorcerer by jungle bay on spotify/ });
    expectOutbound(link, ISLAND_SOUND.track);
    expect(link).toHaveTextContent('the island hums meanwhile.');
  });

  it('the footer signs every page with the collective and both links', async () => {
    const { Footer } = await import('./layout/Footer');
    const { container } = render(<MemoryRouter initialEntries={['/tokenomics']}><Footer /></MemoryRouter>);
    const footer = container.querySelector('footer')!;
    expect(footer).toHaveTextContent('built by the jungle bay artists collective · spotify · youtube');
    expect(within(footer).getByRole('link', { name: 'jungle bay on spotify (opens in new tab)' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'jungle bay on youtube (opens in new tab)' })).toBeInTheDocument();
  });
});

describe('where the music may appear', () => {
  it('only the footer, the island lobby and an empty History mount it', () => {
    const mounts = sourceFiles(SRC)
      .filter((f) => /from '[./]*\/?(components\/)?IslandSound'/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    expect(mounts).toEqual(['components/layout/Footer.tsx', 'pages/HistoryPage.tsx', 'pages/IslandPage.tsx']);
  });

  it('no other file carries a music URL of its own', () => {
    const carriers = sourceFiles(SRC)
      .filter((f) => /open\.spotify\.com|youtube\.com\/@junglebayisland/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(carriers).toEqual(['lib/islandSound.ts']);
  });
});

describe("the site's structured data", () => {
  it('names the two artist pages as the collective that made it', () => {
    const html = readFileSync(join(FRONTEND, 'index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]')!.textContent ?? '');
    expect(ld.creator).toEqual({
      '@type': 'Organization',
      name: 'Jungle Bay Artists Collective',
      sameAs: [ISLAND_SOUND.spotify, ISLAND_SOUND.youtube],
    });
  });
});
