/**
 * The moment travels (island answer thirty-six): after a buy or an add in a room, the receipt's green button
 * hands X the moment as a GIF with the post's words and its one link. A GIF on a post plays in the feed; a
 * link card shows a GIF's first frame only. The island renders the ten clips from lib/shoreMoment.ts and
 * lib/floorMoment.ts, each under 5,000,000 bytes (X's cap from a phone); vercel.json serves them here.
 *
 * The moment for every coin (the island, 11-19; the owner's word 11-10: every swap and every add plays its
 * moment, any coin): any other coin's clip is asked of the island by its mint, `<shore|flash>-<mint>.gif`, and
 * an add paired with anything but SOL names its pairing coin, `flash-<mint>-usdc.gif`. The island makes a coin's
 * two clips the first time anyone asks and keeps them; while it makes one it answers 202 with Retry-After.
 */
import { RECEIPT_WORDS } from './arrival';
import type { Receipt } from './receipt';
import { sheetRoom } from './sheet';

export type MomentKind = 'shore' | 'flash';

export interface MomentClip {
  kind: MomentKind;
  /** This site's own path to the GIF (vercel.json rewrites /share/moment/:file to memetics.wtf). */
  url: string;
  /** The file's name, as the phone and X see it. */
  name: string;
  /** The post: its words and its one link. */
  text: string;
  /** X's composer with the post written: the road when no GIF can be handed over. */
  intent: string;
}

export const MOMENT_PATH = '/share/moment';

/** An add's pairing coin as the island's file names it: SOL by no word, the venue's other six (quotes.ts) by theirs. */
const PAIR_IN_NAME: Readonly<Record<string, string>> = { SOL: '', USDC: '-usdc', BAYLA: '-bayla', BOBO: '-bobo', SOY: '-soy', BRAINLET: '-brainlet', RIZZ: '-rizz' };

/**
 * The clip for a buy (the shore) or an add (the flash). A room's buy, and a room's add paired with SOL, are the
 * ten files by the room's name. Any other coin, and a room's add paired with another coin, by the coin's mint,
 * named by a ticker of the coin's own (identity.ts): a copy's "fake X", an add left unnamed, or a pairing coin the
 * island makes no clip for, has none. A sale has none: its card shares as it did.
 */
export function momentClip(receipt: Pick<Receipt, 'action' | 'coin'> & Partial<Pick<Receipt, 'island' | 'pairing' | 'unnamed'>>): MomentClip | null {
  if (receipt.action === 'sold') return null;
  const kind: MomentKind = receipt.action === 'added' ? 'flash' : 'shore';
  const mint = receipt.coin.mint;
  const room = sheetRoom(mint);
  const pair = kind === 'flash' ? PAIR_IN_NAME[receipt.pairing ?? 'SOL'] : '';
  if (pair === undefined) return null;
  if (room && pair === '') {
    const text = kind === 'flash'
      ? `${RECEIPT_WORDS.lpPost(room.symbol)} ${RECEIPT_WORDS.lpLink(room.id)}`
      : `${RECEIPT_WORDS.buyPost(room.symbol)} ${RECEIPT_WORDS.buyLink(room.id)}`;
    return clipOf(kind, `${kind}-${room.id}`, room.id, text);
  }
  // Whether the ticker is the coin's own was read where the receipt was raised (identity.ts, Solana-side; this module
  // stays in the entry chunk with no Solana import): `unnamed` for a copy's "fake X" or no ticker at all.
  const ticker = room ? room.symbol : receipt.unnamed ? null : receipt.coin.symbol || null;
  if (!ticker) return null;
  const text = kind === 'flash'
    ? `${RECEIPT_WORDS.lpPost(ticker)} ${RECEIPT_WORDS.lpLink(room?.id ?? mint)}`
    : `${receipt.island ? RECEIPT_WORDS.buyPost(ticker) : RECEIPT_WORDS.buyPostAny(ticker)} ${RECEIPT_WORDS.buyLinkAny(mint)}`;
  const named = ticker.toLowerCase().replace(/[^a-z0-9]/g, '') || mint;
  return clipOf(kind, `${kind}-${mint}${pair}`, named + pair, text);
}

function clipOf(kind: MomentKind, file: string, named: string, text: string): MomentClip {
  return {
    kind,
    url: `${MOMENT_PATH}/${file}.gif`,
    name: `memetics-finance-${kind}-${named}.gif`,
    text,
    intent: `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
  };
}

/** This browser can hand a GIF file to another app (a phone's share sheet). Asked before the file is in hand. */
export function canShareGif(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || typeof File === 'undefined') return false;
  try {
    return nav.canShare({ files: [new File([new Uint8Array(0)], 'moment.gif', { type: 'image/gif' })] });
  } catch {
    return false;
  }
}

/**
 * How long a card waits for the island to make a coin's clip the first time anyone shares it. Measured on the island's
 * Vercel function, 11-19: a buy's clip about 107 s, an add's about 200 s. Six minutes leaves the slowest room to spare.
 */
export const MOMENT_WAIT_MS = 360_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The clip as a file; null when it cannot be read (no clip for the coin, offline, not a GIF). While the island makes
 * it (202), asked again after its Retry-After (2 to 15 s, else 8), never past MOMENT_WAIT_MS.
 *
 * Only a GIF is taken from the browser's cache. vercel.json stamps every answer under /share/ `Cache-Control: public,
 * max-age=604800`, the island's 202 ("making it") and its 404 as much as its GIF, and Chrome keeps a stamped 202 and
 * answers the next ask with it (seen in Chromium 153: five asks, one reached the server). So once an ask comes back
 * as anything but a GIF, every ask after it goes to the network (`cache: 'reload'`), the first of them at once. The
 * GIF that road brings is kept by the browser like any other, so the coin's next card has it at once.
 */
export async function fetchMoment(clip: MomentClip, fetcher: typeof fetch = fetch, wait: (ms: number) => Promise<void> = sleep): Promise<File | null> {
  const end = Date.now() + MOMENT_WAIT_MS;
  let network = false;
  try {
    for (;;) {
      const res = network ? await fetcher(clip.url, { cache: 'reload' }) : await fetcher(clip.url);
      const type = res.headers.get('content-type') ?? '';
      const gif = res.ok && res.status !== 202 && (type === '' || type.startsWith('image/gif'));
      if (!gif && !network) {
        network = true;
        continue;
      }
      if (res.status === 202) {
        const after = Math.min(15, Math.max(2, Number(res.headers.get('retry-after')) || 8)) * 1000;
        if (Date.now() + after > end) return null;
        await wait(after);
        continue;
      }
      if (!gif) return null;
      const bytes = await res.arrayBuffer();
      return bytes.byteLength > 0 ? new File([bytes], clip.name, { type: 'image/gif' }) : null;
    }
  } catch {
    return null;
  }
}

/** An ask made as the wallet signs, kept for the card that rises when the chain confirms; let go after five minutes. */
const ASK_KEEP_MS = 300_000;
const asked = new Map<string, { file: Promise<File | null> }>();

/**
 * Ask the island for the clip as the wallet signs (the moment for every coin): a coin's first clip takes the island
 * two to four minutes to make, and the card's first tap should carry it. The card takes this ask when it rises.
 */
export function askMoment(clip: MomentClip | null, fetcher: typeof fetch = fetch): void {
  if (!clip || asked.has(clip.url)) return;
  const entry = { file: fetchMoment(clip, fetcher) };
  asked.set(clip.url, entry);
  setTimeout(() => {
    if (asked.get(clip.url) === entry) asked.delete(clip.url);
  }, ASK_KEEP_MS);
}

/** The clip's file for the card: the ask made as the wallet signed, else one made now. */
export function takeMoment(clip: MomentClip, fetcher: typeof fetch = fetch): Promise<File | null> {
  const entry = asked.get(clip.url);
  asked.delete(clip.url);
  return entry ? entry.file : fetchMoment(clip, fetcher);
}

/**
 * The share sheet with the GIF and the words. Called inside the tap with the file in hand: a phone opens the
 * sheet only straight from a tap. 'closed' is the person closing it; 'failed' sends the caller to X's composer.
 */
export async function shareMoment(file: File, clip: MomentClip, nav: Navigator = navigator): Promise<'shared' | 'closed' | 'failed'> {
  try {
    if (!nav.canShare?.({ files: [file] })) return 'failed';
    await nav.share({ files: [file], text: clip.text });
    return 'shared';
  } catch (err) {
    return err instanceof DOMException && err.name === 'AbortError' ? 'closed' : 'failed';
  }
}

/** Save the GIF on a computer, to drop into X's composer. */
export function saveMoment(file: File, doc: Document = document): void {
  const href = URL.createObjectURL(file);
  const a = doc.createElement('a');
  a.href = href;
  a.download = file.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
