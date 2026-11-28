// Island answer thirty-six: the moment travels. The clip for a buy or an add in a room, the words it posts,
// the share sheet, the file saved on a computer, and the rewrite that brings the island's clips to this site.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { askMoment, canShareGif, fetchMoment, momentClip, saveMoment, shareMoment, takeMoment, MOMENT_PATH, MOMENT_WAIT_MS, type MomentClip } from './momentShare';
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

  it('a sale has no clip: its card shares as it did', () => {
    expect(momentClip({ action: 'sold', coin: { symbol: 'BAYLA', mint: BAYLA } })).toBeNull();
    expect(momentClip({ action: 'sold', coin: { symbol: 'WIF', mint: WIF } })).toBeNull();
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

// The moment for every coin (the owner, 11-19 1:29 PM: his $BIGBRAIN share posted words only, on his phone; his 11-10 word:
// every swap plays the flame and the shoreline, every add the pour and the flash, any coin). The island makes a coin's two
// clips the first time anyone asks and keeps them (memetics.wtf/share/moment/<shore|flash>-<mint>[-<pairing>].gif).
describe('the moment for every coin', () => {
  const BIG = '59tp4LoiCNNNFkwDYg7SFTbF8wJdjMS5DCyStHmbgBmZ';

  it('a buy of a coin with no room: the shore by its mint, its post the buy and the venue’s swap for that coin', () => {
    const clip = momentClip({ action: 'bought', coin: { symbol: 'BIGBRAIN', mint: BIG } });
    expect(clip).toEqual({
      kind: 'shore',
      url: `${MOMENT_PATH}/shore-${BIG}.gif`,
      name: 'memetics-finance-shore-bigbrain.gif',
      text: `Just bought $BIGBRAIN. ${SITE_URL}/solana?out=${BIG}`,
      intent: expect.stringMatching(/^https:\/\/x\.com\/intent\/post\?text=/),
    });
    expect(posted(clip!.intent)).toBe(clip!.text);
  });

  it('his $BIG BRAIN (J9zj…pump, a ticker with a space): its own shore by its mint, named as the venue names it', () => {
    const REAL = 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump';
    const clip = momentClip({ action: 'bought', coin: { symbol: 'BIG BRAIN', mint: REAL }, island: false });
    expect(clip?.url).toBe(`${MOMENT_PATH}/shore-${REAL}.gif`);
    expect(clip?.name).toBe('memetics-finance-shore-bigbrain.gif');
    expect(clip?.text).toBe(`Just bought $BIG BRAIN. ${SITE_URL}/solana?out=${REAL}`);
  });

  it('an add of a coin with no room: the flash by its mint, its post the add line and the coin’s add link', () => {
    const clip = momentClip({ action: 'added', coin: { symbol: 'BIGBRAIN', mint: BIG }, pairing: 'SOL' });
    expect(clip?.kind).toBe('flash');
    expect(clip?.url).toBe(`${MOMENT_PATH}/flash-${BIG}.gif`);
    expect(clip?.name).toBe('memetics-finance-flash-bigbrain.gif');
    expect(clip?.text).toBe(`Just added liquidity to $BIGBRAIN. I'm part of the floor now. Every trade in the pool pays me. ${SITE_URL}/lp/${BIG}`);
  });

  it('an add paired with another coin: the file names its pairing; a room keeps its own file only with SOL', () => {
    expect(momentClip({ action: 'added', coin: { symbol: 'BIGBRAIN', mint: BIG }, pairing: 'USDC' })?.url).toBe(`${MOMENT_PATH}/flash-${BIG}-usdc.gif`);
    expect(momentClip({ action: 'added', coin: { symbol: 'BIGBRAIN', mint: BIG }, pairing: 'BOBO' })?.url).toBe(`${MOMENT_PATH}/flash-${BIG}-bobo.gif`);
    const usdc = momentClip({ action: 'added', coin: { symbol: 'BAYLA', mint: BAYLA }, pairing: 'USDC' });
    expect(usdc?.url).toBe(`${MOMENT_PATH}/flash-${BAYLA}-usdc.gif`);
    expect(usdc?.text).toBe(`Just added liquidity to $BAYLA. I'm part of the floor now. Every trade in the pool pays me. ${SITE_URL}/lp/bayla`);
    expect(momentClip({ action: 'added', coin: { symbol: 'BAYLA', mint: BAYLA }, pairing: 'SOL' })?.url).toBe(`${MOMENT_PATH}/flash-bayla.gif`);
    expect(momentClip({ action: 'bought', coin: { symbol: 'BAYLA', mint: BAYLA } })?.url).toBe(`${MOMENT_PATH}/shore-bayla.gif`);
  });

  it('a coin on the island with no room says the shore line', () => {
    expect(momentClip({ action: 'bought', coin: { symbol: 'BIGBRAIN', mint: BIG }, island: true })?.text).toBe(
      `Just bought $BIGBRAIN. I'm on the shore now. Every light here holds it. ${SITE_URL}/solana?out=${BIG}`,
    );
  });

  it('no clip for a copy, a coin with no ticker of its own, an add left unnamed, or a pairing the island makes none for', () => {
    // A buy's own ticker is read where the swap raises its receipt (SolanaSwapPage, identity.ts ownTickerOf): unnamed.
    expect(momentClip({ action: 'bought', coin: { symbol: 'BAYLA', mint: BIG }, unnamed: true })).toBeNull();
    expect(momentClip({ action: 'bought', coin: { symbol: '', mint: BIG } })).toBeNull();
    expect(momentClip({ action: 'added', coin: { symbol: 'tokens', mint: BIG }, pairing: 'SOL', unnamed: true })).toBeNull();
    expect(momentClip({ action: 'added', coin: { symbol: 'BIGBRAIN', mint: BIG }, pairing: 'USDT' })).toBeNull();
  });

  it('every post for a coin with no room fits X with its link, with no em dash', () => {
    for (const action of ['bought', 'added'] as const) {
      const clip = momentClip({ action, coin: { symbol: 'W'.repeat(12), mint: BIG }, pairing: 'USDC' })!;
      const link = clip.text.slice(clip.text.lastIndexOf(' ') + 1);
      expect(link.startsWith(`${SITE_URL}/`)).toBe(true);
      expect(clip.text.length - link.length + 23).toBeLessThanOrEqual(280);
      expect(clip.text).not.toMatch(/—/);
    }
  });
});

describe('vercel.json brings the island’s clips to this site', () => {
  type Rewrite = { source: string; destination: string; has?: { type: string; key: string; value?: string }[] };
  const config = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8')) as { rewrites: Rewrite[] };
  const ours = config.rewrites.findIndex((r) => r.destination === 'https://memetics.wtf/share/moment/:file');
  const rule = config.rewrites[ours];
  it('rewrites /share/moment/<clip> to memetics.wtf, before the app page takes every path', () => {
    const app = config.rewrites.findIndex((r) => r.destination === '/index.html');
    expect(ours, 'no rewrite to memetics.wtf/share/moment/:file').toBeGreaterThanOrEqual(0);
    expect(rule!.source.startsWith(`${MOMENT_PATH}/:file(`)).toBe(true);
    expect(ours).toBeLessThan(app);
    const toWtf = config.rewrites.filter((r) => /^https:\/\//.test(r.destination) && new URL(r.destination).host === 'memetics.wtf');
    expect(toWtf, 'one door to memetics.wtf').toHaveLength(1);
  });

  // The rewrite makes memetics.wtf's answer this site's own. Two gates keep that to the clips, read by fetch():
  // only a clip's name passes (no other file of memetics.wtf, no %2F climbing out of the folder), and only a
  // fetch() (Sec-Fetch-Dest: empty, which a page cannot forge). A page opened at the address, or a script tag
  // pointed at it, gets this site's own app page instead, so nothing memetics.wtf serves runs as memetics.finance.
  it('passes only a clip’s name, and only to fetch()', () => {
    const name = new RegExp(`^${rule!.source.slice(`${MOMENT_PATH}/:file(`.length, -1)}$`);
    for (const r of sheetRooms()) {
      for (const action of ['bought', 'added'] as const) {
        const clip = momentClip({ action, coin: { symbol: r.symbol, mint: r.address! } })!;
        expect(clip.url.startsWith(`${MOMENT_PATH}/`)).toBe(true);
        expect(clip.url.slice(MOMENT_PATH.length + 1)).toMatch(name);
      }
    }
    for (const bad of ['index.html', 'shore-bayla.gif.html', 'shore-bayla.js', '..%2F..%2Findex.html', 'shore-..%2Fx.gif', 'shore-baylaXgif', 'Shore-bayla.gif', 'shore-.gif', 'moment.gif']) {
      expect(bad, bad).not.toMatch(name);
    }
    // Any coin's clip by its mint, and an add's pairing coin from the venue's seven (the moment for every coin, 11-19).
    const BIG = '59tp4LoiCNNNFkwDYg7SFTbF8wJdjMS5DCyStHmbgBmZ';
    for (const good of [`shore-${BIG}.gif`, `flash-${BIG}.gif`, `flash-${BIG}-usdc.gif`, `flash-${BAYLA}-rizz.gif`]) expect(good, good).toMatch(name);
    for (const bad of [`shore-${BIG}.gif.html`, `flash-${BIG}-wif.gif`, `flash-${BIG}-USDC.gif`, `shore-${BIG}%2F..gif`, `flash-${BIG}-sol.gif`, `shore-${'A'.repeat(31)}.gif`, `shore-${'A'.repeat(45)}.gif`, `shore-${BIG.replace('5', '0')}.gif`]) {
      expect(bad, bad).not.toMatch(name);
    }
    expect(rule!.has).toEqual([{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }]);
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

  it('while the island makes a coin’s clip (202): asked again after its Retry-After, until the GIF', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => (++n < 3 ? new Response('making it', { status: 202, headers: { 'retry-after': '8' } }) : new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } })));
    const waits: number[] = [];
    const file = await fetchMoment(clip, fetcher as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([8000]); // the first ask again goes at once (the next test); each one after it waits
    expect(file?.size).toBe(gif.length);
  });

  // vercel.json stamps every answer under /share/ `Cache-Control: public, max-age=604800`: the island's 202 ("making
  // it") and its 404 as much as its GIF. Chrome keeps a stamped 202 and answers the next ask with it (seen in
  // Chromium 153: five asks, one reached the server), so a card would wait out its six minutes on its own cache and
  // that browser would hold "making it" for the coin for a week.
  it('only a GIF is taken from the browser’s cache: after any other answer every ask goes to the network, the first at once', async () => {
    let n = 0;
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => (++n < 4 ? new Response('making it', { status: 202, headers: { 'retry-after': '8' } }) : new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } })));
    const waits: number[] = [];
    const file = await fetchMoment(clip, fetcher as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    const url = '/share/moment/flash-bayla.gif';
    expect(fetcher.mock.calls).toEqual([[url], [url, { cache: 'reload' }], [url, { cache: 'reload' }], [url, { cache: 'reload' }]]);
    expect(waits).toEqual([8000, 8000]);
    expect(file?.size).toBe(gif.length);
  });

  it('a kept "no such clip" or a kept page is not believed either: the network is asked once before the card goes without', async () => {
    const url = '/share/moment/flash-bayla.gif';
    const kept = [
      () => new Response('The page could not be found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ];
    for (const stale of kept) {
      // The coin's clip exists by now: the network has it.
      let n = 0;
      const made = vi.fn(async (_url: string, _init?: RequestInit) => (++n === 1 ? stale() : new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } })));
      expect((await fetchMoment(clip, made as unknown as typeof fetch))?.size).toBe(gif.length);
      expect(made.mock.calls).toEqual([[url], [url, { cache: 'reload' }]]);
      // Still none: two asks, no third.
      const none = vi.fn(async (_url: string, _init?: RequestInit) => stale());
      expect(await fetchMoment(clip, none as unknown as typeof fetch)).toBeNull();
      expect(none.mock.calls).toEqual([[url], [url, { cache: 'reload' }]]);
    }
  });

  it('the wait outlasts the island’s slowest first make (an add, 201 s on Vercel 11-19) by two minutes', () => {
    expect(MOMENT_WAIT_MS).toBeGreaterThanOrEqual(201_000 + 120_000);
  });

  it('a make that outlasts the wait: no file, and no ask past it', async () => {
    const fetcher = vi.fn(async () => new Response('making it', { status: 202, headers: { 'retry-after': '8' } }));
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const file = await fetchMoment(clip, fetcher as unknown as typeof fetch, async (ms) => { clock += ms; });
      expect(file).toBeNull();
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MOMENT_WAIT_MS / 8000 + 2); // + the one asked again at once
      expect(clock).toBeLessThanOrEqual(MOMENT_WAIT_MS);
    } finally {
      now.mockRestore();
    }
  });

  it('asked as the wallet signs, the card takes that same ask; a card with none asks itself', async () => {
    const fetcher = vi.fn(async () => new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } }));
    askMoment(clip, fetcher as unknown as typeof fetch);
    askMoment(clip, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await takeMoment(clip, fetcher as unknown as typeof fetch))?.size).toBe(gif.length);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await takeMoment(clip, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    askMoment(null, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
