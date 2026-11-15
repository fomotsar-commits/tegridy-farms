import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { RECEIPT_WORDS } from '../lib/arrival';
import { canShareGif, fetchMoment, saveMoment, shareMoment, type MomentClip } from '../lib/momentShare';

type Step = 'idle' | 'getting' | 'ready' | 'saved' | 'none';

/** A touch screen: its share sheet lists X. A computer's sheet does not, so a computer gets X's composer and the file. */
function touchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * The receipt's Share on X with the moment's GIF (island answer thirty-six). A phone that can hand a GIF on gets
 * the share sheet, the file fetched while the moment plays; tapped before it arrives, the next tap shares. A
 * computer opens X's composer (the link's own default) and saves the GIF. Any other phone, or no GIF to be had:
 * the composer with the words, as before. `note` is the line under the button.
 */
export function useMomentShare(clip: MomentClip | null): { onClick: (e: MouseEvent<HTMLAnchorElement>) => void; note: string | null } {
  const url = clip?.url ?? null;
  const file = useRef<File | null>(null);
  const pending = useRef<'share' | 'save' | null>(null);
  // The step belongs to one clip: a card raised for another clip starts idle.
  const [state, setState] = useState<{ url: string | null; step: Step }>({ url, step: 'idle' });
  const step: Step = state.url === url ? state.step : 'idle';
  const setStep = (s: Step) => setState({ url, step: s });

  useEffect(() => {
    file.current = null;
    pending.current = null;
    if (!clip || (touchScreen() && !canShareGif())) return; // a phone with no share sheet for files: nothing to fetch
    let live = true;
    void fetchMoment(clip).then((f) => {
      if (!live) return;
      file.current = f;
      const was = pending.current;
      pending.current = null;
      if (!f) setState({ url: clip.url, step: 'none' });
      else if (was === 'share') setState({ url: clip.url, step: 'ready' });
      else if (was === 'save') {
        saveMoment(f);
        setState({ url: clip.url, step: 'saved' });
      }
    });
    return () => {
      live = false;
    };
    // One fetch a clip, and the clip is its url: the card re-renders as the fee is read, the file stays in hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

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
