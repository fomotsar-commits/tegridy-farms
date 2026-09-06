// The board card. The load-bearing property is what it does when it CANNOT read:
// it renders nothing at all. A home page that says "nobody is on the island" because
// a proxy hiccuped is worse than a home page with one fewer section, and an empty
// board is a claim about the island rather than an absence of one.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Flame } from '../lib/heat/flamesClient';

const h = vi.hoisted(() => ({ fetchFlames: vi.fn() }));

vi.mock('../lib/heat/flamesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heat/flamesClient')>();
  return { ...actual, fetchFlames: (...args: unknown[]) => h.fetchFlames(...args) };
});

const { FlamesBoard } = await import('./FlamesBoard');

const AS_OF = 1_788_696_400; // 2026-09-06T12:06:40Z
const SINCE = 1_642_334_800; // 2022-01-16T12:06:40Z -> "Jan 2022"

const NAMED: Flame = {
  xHandle: '_seacasa',
  degrees: 1785.14,
  tier: 'Elder',
  heldSinceUnix: SINCE,
  tokenCount: 18,
};
const UNNAMED: Flame = {
  xHandle: null,
  degrees: 524.27,
  tier: 'Builder',
  heldSinceUnix: SINCE,
  tokenCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchFlames.mockResolvedValue({ flames: [NAMED, UNNAMED], asOfUnix: AS_OF });
});

describe('the board renders the island’s ranking', () => {
  it('paints rank, handle, degrees, tier, since and tokens', async () => {
    const { container } = render(<FlamesBoard limit={5} />);
    await screen.findByRole('link', { name: '@_seacasa' });

    const text = container.textContent ?? '';
    expect(text).toContain('1');
    expect(text).toContain('1785.1°');
    expect(text).toContain('Elder');
    expect(text).toContain('since Jan 2022');
    expect(text).toContain('18 tokens');
  });

  it('links a named flame to its profile, with one @', async () => {
    render(<FlamesBoard limit={5} />);
    const link = await screen.findByRole('link', { name: '@_seacasa' });
    expect(link.getAttribute('href')).toBe('https://x.com/_seacasa');
    expect(link.textContent).toBe('@_seacasa');
  });

  it('turns an unnamed row into the island’s own invitation', async () => {
    render(<FlamesBoard limit={5} />);
    const bait = await screen.findByRole('link', { name: 'No name yet. Yours?' });
    expect(bait.getAttribute('href')).toBe('https://memetics.wtf/register');
  });

  it('singularises the token count', async () => {
    const { container } = render(<FlamesBoard limit={5} />);
    await screen.findByRole('link', { name: '@_seacasa' });
    expect(container.textContent).toContain('1 token');
    expect(container.textContent).not.toContain('1 tokens');
  });

  it('states when the board was reckoned', async () => {
    const { container } = render(<FlamesBoard limit={5} />);
    await screen.findByRole('link', { name: '@_seacasa' });
    // UTC, because the island reckons in UTC and a viewer's zone must not move it.
    expect(container.textContent).toContain('read Sep 6, 12:06 UTC');
  });

  it('offers both island doors under the list', async () => {
    render(<FlamesBoard limit={5} />);
    expect((await screen.findByRole('link', { name: 'See the whole board' })).getAttribute('href')).toBe(
      'https://memetics.wtf/flames',
    );
    expect(screen.getByRole('link', { name: 'Put your name on it' }).getAttribute('href')).toBe(
      'https://memetics.wtf/register',
    );
  });

  it('asks for the size it was given, named flames only', async () => {
    render(<FlamesBoard limit={25} />);
    await screen.findByRole('link', { name: '@_seacasa' });
    expect(h.fetchFlames).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, claimed: true }));
  });
});

describe('it unmounts rather than apologising', () => {
  it('renders NOTHING when the island’s board is off', async () => {
    h.fetchFlames.mockResolvedValue(null);
    const { container } = render(<FlamesBoard limit={5} />);
    await waitFor(() => expect(h.fetchFlames).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders NOTHING when the board is unreachable', async () => {
    h.fetchFlames.mockRejectedValue(new Error('unreachable'));
    const { container } = render(<FlamesBoard limit={5} />);
    await waitFor(() => expect(h.fetchFlames).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders NOTHING for an empty board rather than an empty heading', async () => {
    h.fetchFlames.mockResolvedValue({ flames: [], asOfUnix: AS_OF });
    const { container } = render(<FlamesBoard limit={5} />);
    await waitFor(() => expect(h.fetchFlames).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('never shows the visitor an error string', async () => {
    h.fetchFlames.mockRejectedValue(new Error('Board unavailable'));
    const { container } = render(<FlamesBoard limit={5} />);
    await waitFor(() => expect(h.fetchFlames).toHaveBeenCalled());
    expect(container.textContent ?? '').not.toContain('unavailable');
  });
});
