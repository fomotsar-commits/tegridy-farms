import { VENUE } from '../lib/arrival';
import { pageArt } from '../lib/artConfig';
import { artImgProps } from '../lib/artSrcSet';
import { setFirstFrameDraft } from '../lib/firstFrameDraft';

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
 */
export function FirstFrame() {
  const art = pageArt('venue-home', 0);
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
              className="ff-input"
              name="heat"
              placeholder="0x… or a Solana address"
              aria-label="Wallet address to read Heat for (Ethereum or Solana)"
              autoComplete="off"
              spellCheck={false}
              required
              onChange={(e) => setFirstFrameDraft(e.target.value)}
            />
            <button className="ff-btn" type="submit">Read Heat</button>
          </form>
        </div>
      </div>
    </div>
  );
}
