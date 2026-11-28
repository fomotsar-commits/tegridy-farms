import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { RECEIPT_WORDS } from '../lib/arrival';
import { canShareGif, saveMoment, shareMoment, takeMoment, type MomentClip } from '../lib/momentShare';
import { withAmounts, type AmountsLine } from '../lib/momentAmounts';

type Step = 'idle' | 'getting' | 'ready' | 'saved' | 'none';

/**
 * What the GIF says went in (an add's: lib/momentAmounts.ts): the figures, 'reading' while the transaction is read,
 * or null for none (a buy, or an add whose figures could not be read: the island's GIF as it came).
 */
export type MomentAmounts = AmountsLine | 'reading' | null;

/** How long a GIF in hand waits for its add's figures before it goes as the island made it. */
export const AMOUNTS_WAIT_MS = 20_000;

/** A touch screen: its share sheet lists X. A computer's sheet does not, so a computer gets X's composer and the file. */
function touchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** This screen can use the moment's GIF: a computer saves it, a phone hands it to its share sheet. Asked before any fetch. */
export function momentWanted(): boolean {
  return !touchScreen() || canShareGif();
}

/**
 * The receipt's Share on X with the moment's GIF (island answer thirty-six). A phone that can hand a GIF on gets
 * the share sheet, the file fetched while the moment plays; tapped before it arrives, the next tap shares. A
 * computer opens X's composer (the link's own default) and saves the GIF. Any other phone, or no GIF to be had:
 * the composer with the words, as before. `note` is the line under the button.
 *
 * An add's GIF says what went in (the owner's word, 11-28): with `amounts`, the file is ready once the figures are
 * read and written across its top. Figures that cannot be read, or written, leave the island's GIF as it came.
 */
export function useMomentShare(clip: MomentClip | null, amounts: MomentAmounts = null): { onClick: (e: MouseEvent<HTMLAnchorElement>) => void; note: string | null } {
  const url = clip?.url ?? null;
  const file = useRef<File | null>(null);
  const pending = useRef<'share' | 'save' | null>(null);
  // The step belongs to one clip: a card raised for another clip starts idle.
  const [state, setState] = useState<{ url: string | null; step: Step }>({ url, step: 'idle' });
  const step: Step = state.url === url ? state.step : 'idle';
  const setStep = (s: Step) => setState({ url, step: s });
  // The island's GIF as fetched for this clip (null: none to be had), before any figures are written on it.
  const [got, setGot] = useState<{ url: string; file: File | null } | null>(null);
  // The clip whose wait for its figures ran out.
  const [waited, setWaited] = useState<string | null>(null);
  const line = amounts === 'reading' ? null : amounts;
  const reading = amounts === 'reading';
  const lineKey = line ? `${line.quote}|${line.coin}` : reading ? 'reading' : '';

  useEffect(() => {
    file.current = null;
    pending.current = null;
    if (!clip || !momentWanted()) return; // a phone with no share sheet for files: nothing to fetch
    let live = true;
    // The ask made as the wallet signed, when there was one (the moment for every coin); else one made now.
    void takeMoment(clip).then((f) => {
      if (live) setGot({ url: clip.url, file: f });
    });
    return () => {
      live = false;
    };
    // One fetch a clip, and the clip is its url: the card re-renders as the fee is read, the file stays in hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!got || got.url !== url) return;
    file.current = null;
    let live = true;
    const ready = (f: File | null) => {
      if (!live) return;
      file.current = f;
      const was = pending.current;
      pending.current = null;
      if (!f) setState({ url: got.url, step: 'none' });
      else if (was === 'share') setState({ url: got.url, step: 'ready' });
      else if (was === 'save') {
        saveMoment(f);
        setState({ url: got.url, step: 'saved' });
      }
    };
    const island = got.file;
    if (!island) ready(null);
    else if (line) void withAmounts(island, line).then((f) => ready(f ?? island));
    else if (reading && waited !== url) {
      const t = window.setTimeout(() => setWaited(url), AMOUNTS_WAIT_MS);
      return () => {
        live = false;
        window.clearTimeout(t);
      };
    } else ready(island);
    return () => {
      live = false;
    };
    // The figures are their words: a re-render with the same words keeps the file in hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [got, url, lineKey, waited]);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!clip || step === 'none') return; // X's composer with the words: the link's own default
    const f = file.current;
    if (touchScreen() && canShareGif()) {
      e.preventDefault();
      if (!f) {
        pending.current = 'share';
        setStep('getting');
        return;
      }
      setStep('idle');
      void shareMoment(f, clip).then((r) => {
        if (r !== 'failed') return;
        setState({ url: clip.url, step: 'none' });
        window.open(clip.intent, '_blank', 'noopener,noreferrer');
      });
      return;
    }
    if (touchScreen()) return; // a phone with no share sheet for files: the composer, as before
    if (f) {
      saveMoment(f);
      setStep('saved');
    } else pending.current = 'save';
  };

  const note = step === 'getting' ? RECEIPT_WORDS.momentGetting : step === 'ready' ? RECEIPT_WORDS.momentReady : step === 'saved' ? RECEIPT_WORDS.momentSaved : null;
  return { onClick, note };
}
