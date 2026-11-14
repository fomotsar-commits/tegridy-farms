/**
 * The moment travels (island answer thirty-six): after a buy or an add in a room, the receipt's green button
 * hands X the moment as a GIF with the post's words and its one link. A GIF on a post plays in the feed; a
 * link card shows a GIF's first frame only. The island renders the ten clips from lib/shoreMoment.ts and
 * lib/floorMoment.ts, each under 5,000,000 bytes (X's cap from a phone); vercel.json serves them here.
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

/** The clip for a buy (the shore) or an add (the flash) of a coin with a room; a sale, or any other coin, has none. */
export function momentClip(receipt: Pick<Receipt, 'action' | 'coin'>): MomentClip | null {
  if (receipt.action === 'sold') return null;
  const room = sheetRoom(receipt.coin.mint);
  if (!room) return null;
  const kind: MomentKind = receipt.action === 'added' ? 'flash' : 'shore';
  const text = kind === 'flash'
    ? `${RECEIPT_WORDS.lpPost(room.symbol)} ${RECEIPT_WORDS.lpLink(room.id)}`
    : `${RECEIPT_WORDS.buyPost(room.symbol)} ${RECEIPT_WORDS.buyLink(room.id)}`;
  return {
    kind,
    url: `${MOMENT_PATH}/${kind}-${room.id}.gif`,
    name: `memetics-finance-${kind}-${room.id}.gif`,
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

/** The clip as a file; null when it cannot be read (not on the island yet, offline, not a GIF). */
export async function fetchMoment(clip: MomentClip, fetcher: typeof fetch = fetch): Promise<File | null> {
  try {
    const res = await fetcher(clip.url);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || (type !== '' && !type.startsWith('image/gif'))) return null;
    const bytes = await res.arrayBuffer();
    return bytes.byteLength > 0 ? new File([bytes], clip.name, { type: 'image/gif' }) : null;
  } catch {
    return null;
  }
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
