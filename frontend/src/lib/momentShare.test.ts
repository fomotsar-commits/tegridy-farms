// Island answer thirty-six: the moment travels. The clip for a buy or an add in a room, the words it posts,
// the share sheet, the file saved on a computer, and the rewrite that brings the island's clips to this site.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canShareGif, fetchMoment, momentClip, saveMoment, shareMoment, MOMENT_PATH, type MomentClip } from './momentShare';
import { sheetRooms } from './sheet';
import { SITE_URL } from './constants';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const BOBO = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
// The ten clips the island ships to memetics.wtf/share/moment/ (its pull request 24): a room added here needs its two.
const SHIPPED = ['bayla', 'bobo', 'soy', 'brainlet', 'rizz'];

const posted = (intent: string) => {
  const u = new URL(intent);
  expect(`${u.origin}${u.pathname}`).toBe('https://x.com/intent/post');
  return u.searchParams.get('text') ?? '';
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the clip for a receipt', () => {
  it('a buy in a room: the shore, its post the shore line and the room with its Buy open', () => {
    const clip = momentClip({ action: 'bought', coin: { symbol: 'BAYLA', mint: BAYLA } });
    expect(clip).toEqual({
      kind: 'shore',
      url: `${MOMENT_PATH}/shore-bayla.gif`,
      name: 'memetics-finance-shore-bayla.gif',
      text: `Just bought $BAYLA. I'm on the shore now. Every light here holds it. ${SITE_URL}/bayla?sheet=buy`,
      intent: expect.stringMatching(/^https:\/\/x\.com\/intent\/post\?text=/),
    });
    expect(posted(clip!.intent)).toBe(clip!.text);
  });

  it('an add in a room: the flash, its post the venue’s own add line and the room’s add link', () => {
    const clip = momentClip({ action: 'added', coin: { symbol: 'BOBO', mint: BOBO } });
    expect(clip?.kind).toBe('flash');
    expect(clip?.url).toBe(`${MOMENT_PATH}/flash-bobo.gif`);
    expect(clip?.text).toBe(`Just added liquidity to $BOBO. I'm part of the floor now. Every trade in the pool pays me. ${SITE_URL}/lp/bobo`);
  });

  it('a sale, and any coin with no room, has no clip: its card shares as it did', () => {
    expect(momentClip({ action: 'sold', coin: { symbol: 'BAYLA', mint: BAYLA } })).toBeNull();
    expect(momentClip({ action: 'bought', coin: { symbol: 'WIF', mint: WIF } })).toBeNull();
    expect(momentClip({ action: 'added', coin: { symbol: 'WIF', mint: WIF } })).toBeNull();
  });

  it('every room has its two clips on the island, and every post fits X with its link, with no em dash', () => {
    expect(sheetRooms().map((r) => r.id).sort()).toEqual([...SHIPPED].sort());
    for (const r of sheetRooms()) {
      for (const action of ['bought', 'added'] as const) {
        const clip = momentClip({ action, coin: { symbol: r.symbol, mint: r.address! } })!;
        expect(clip.url).toBe(`${MOMENT_PATH}/${action === 'added' ? 'flash' : 'shore'}-${r.id}.gif`);
        const link = clip.text.slice(clip.text.lastIndexOf(' ') + 1);
        expect(link.startsWith(`${SITE_URL}/`)).toBe(true);
        expect(clip.text.length - link.length + 23).toBeLessThanOrEqual(280);
        expect(clip.text).not.toMatch(/—/);
      }
    }
  });
});

describe('vercel.json brings the island’s clips to this site', () => {
  const config = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8')) as { rewrites: { source: string; destination: string }[] };
  it('rewrites /share/moment/:file to memetics.wtf, before the app page takes every path', () => {
    const ours = config.rewrites.findIndex((r) => r.source === `${MOMENT_PATH}/:file`);
    const app = config.rewrites.findIndex((r) => r.destination === '/index.html');
    expect(ours, 'no /share/moment/:file rewrite').toBeGreaterThanOrEqual(0);
    expect(config.rewrites[ours]!.destination).toBe('https://memetics.wtf/share/moment/:file');
    expect(ours).toBeLessThan(app);
  });
});

describe('the GIF in hand', () => {
  const clip = momentClip({ action: 'added', coin: { symbol: 'BAYLA', mint: BAYLA } }) as MomentClip;
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

  it('a read GIF is a file with the clip’s name', async () => {
    const fetcher = vi.fn(async () => new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } }));
    const file = await fetchMoment(clip, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith('/share/moment/flash-bayla.gif');
    expect(file?.name).toBe('memetics-finance-flash-bayla.gif');
    expect(file?.type).toBe('image/gif');
    expect(file?.size).toBe(gif.length);
  });

  it('a missing clip, a page in its place, an empty answer or no network: no file', async () => {
    const answers = [
      async () => new Response('nope', { status: 404 }),
      async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/gif' } }),
      async () => {
        throw new TypeError('offline');
      },
    ];
    for (const answer of answers) expect(await fetchMoment(clip, vi.fn(answer) as unknown as typeof fetch)).toBeNull();
  });

  it('the share sheet gets the file and the words; closing it is no failure', async () => {
    const file = new File([gif], clip.name, { type: 'image/gif' });
    const share = vi.fn(async () => undefined);
    const nav = { canShare: () => true, share } as unknown as Navigator;
    expect(await shareMoment(file, clip, nav)).toBe('shared');
    expect(share).toHaveBeenCalledWith({ files: [file], text: clip.text });
    const closed = { canShare: () => true, share: vi.fn(async () => { throw new DOMException('closed', 'AbortError'); }) } as unknown as Navigator;
    expect(await shareMoment(file, clip, closed)).toBe('closed');
    const refused = { canShare: () => true, share: vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); }) } as unknown as Navigator;
    expect(await shareMoment(file, clip, refused)).toBe('failed');
    expect(await shareMoment(file, clip, { canShare: () => false, share } as unknown as Navigator)).toBe('failed');
  });

  it('asks, with no file in hand, whether a GIF can be handed on', () => {
    expect(canShareGif(undefined)).toBe(false);
    expect(canShareGif({} as Navigator)).toBe(false);
    expect(canShareGif({ share: vi.fn(), canShare: () => true } as unknown as Navigator)).toBe(true);
    expect(canShareGif({ share: vi.fn(), canShare: () => false } as unknown as Navigator)).toBe(false);
    expect(canShareGif({ share: vi.fn(), canShare: () => { throw new TypeError('no'); } } as unknown as Navigator)).toBe(false);
  });

  it('on a computer the GIF is saved under its name', () => {
    const had = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:moment');
    URL.revokeObjectURL = vi.fn();
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('memetics-finance-flash-bayla.gif');
        expect(this.getAttribute('href')).toBe('blob:moment');
      });
      saveMoment(new File([gif], clip.name, { type: 'image/gif' }));
      expect(click).toHaveBeenCalledTimes(1);
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      URL.createObjectURL = had.create;
      URL.revokeObjectURL = had.revoke;
    }
  });
});
