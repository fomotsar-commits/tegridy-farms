import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VENUE } from '../lib/arrival';
import { pageArt } from '../lib/artConfig';
import { artImgProps } from '../lib/artSrcSet';
import {
  blurFirstFrameField,
  clearFirstFrameDraft,
  peekFirstFrameDraft,
  setFirstFrameDraft,
  setFirstFrameFocus,
} from '../lib/firstFrameDraft';

/**
 * WAVE SEVEN, answer ten, ruling 2: THE FIRST FRAME, WHILE THE HOME PAGE LOADS.
 *
 * index.html ships the venue hero as static markup so a stranger reads it before any
 * script runs. React's first commit replaces #root, and on `/` the home page is a
 * lazy chunk, so the route's Suspense fallback is the next thing on screen. That
 * fallback was the generic skeleton: the word "Loading..." in the middle of the
 * page, painted OVER a hero the visitor had already been reading. The island
 * measured it: a full second of it on a phone.
 *
 * So `/` falls back to the same frame instead, drawn with the ff-* classes the
 * static markup uses (their CSS is inline in index.html, so it exists before any
 * stylesheet), and the swap from HTML to React to the real hero does not move.
 *
 * DELIBERATELY WALLET-FREE. No wagmi, no framer, nothing that needs a provider:
 * this renders while those chunks may still be arriving.
 *
 * `aria-busy` IS LOAD-BEARING. The e2e readiness probe waits for main#main-content
 * with no busy descendant; without it, specs would start typing into a field
 * React is about to throw away.
 *
 * IT IS THE SAME FIELD, NOT A NEW ONE. This commit replaces a field the visitor may be
 * typing in, so it takes over what that field held (lib/firstFrameDraft.ts): the typed
 * value, and the focus, or a phone's keyboard closes mid-address. It also carries every
 * query parameter but `heat` as a hidden input, as the static form does: the home
 * page is the only place a ?ref= is recorded, and it is exactly the chunk that has not
 * arrived yet, so a submit from here must not drop the referral.
 */
export function FirstFrame() {
  const art = pageArt('venue-home', 0);
  const [params] = useSearchParams();
  const heatParam = params.get('heat');
  const carried = Array.from(params.entries()).filter(([key]) => key !== 'heat');
  const field = useRef<HTMLInputElement>(null);

  // Before paint and before any microtask: the static field was removed in this same
  // commit, and anything typed into it since this render began is in the draft.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const { value, focused } = peekFirstFrameDraft();
    if (value !== null && el.value !== value) el.value = value;
    if (focused && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  // Leaving `/` before the hero ever mounts: nothing will take the draft, so it goes
  // now rather than coming back on a later visit. On `/` the hero is what unmounts
  // this, and the hero clears it once it has it.
  useEffect(
    () => () => {
      if (window.location.pathname !== '/') clearFirstFrameDraft();
    },
    [],
  );

  return (
    <div className="ff-in-layout" aria-busy="true">
      <div className="ff-bg">
        <img src={art.src} {...artImgProps(art.src, 'eager')} alt="" width={1200} height={800} decoding="async" />
      </div>
      <div className="ff-wrap">
        <div className="ff-col">
          <h1 className="ff-h1">
            {VENUE.heroTitle}{' '}<br /><span>{VENUE.heroLine}</span>
          </h1>
          <p className="ff-plain">{VENUE.heroPlain}</p>
          <p className="ff-hook">{VENUE.heroHook}</p>
          {/* The same native form as the static frame, so a submit here still
              lands on /?heat= with no script. What is TYPED here (and not yet
              submitted) is handed to the real hero when it mounts, instead of
              vanishing with this fallback. */}
          <form className="ff-form" method="get" action="/">
            <input
              ref={field}
              className="ff-input"
              name="heat"
              placeholder="0x… or a Solana address"
              aria-label="Wallet address to read Heat for (Ethereum or Solana)"
              autoComplete="off"
              spellCheck={false}
              required
              defaultValue={peekFirstFrameDraft().value ?? heatParam?.trim().slice(0, 64) ?? ''}
              onChange={(e) => setFirstFrameDraft(e.target.value)}
              onFocus={() => setFirstFrameFocus(true)}
              onBlur={(e) => blurFirstFrameField(e.currentTarget)}
            />
            {carried.map(([key, value], i) => (
              <input key={`${key}-${i}`} type="hidden" name={key} value={value} />
            ))}
            <button className="ff-btn" type="submit">Read Heat</button>
          </form>
        </div>
      </div>
    </div>
  );
}
