import {
  NOT_A_ZERO,
  feedBanner,
  type BannerTone,
  type FeedBannerContext,
  type MarketFeedState,
} from '../../lib/terminal/feedBanner';

// The market feed's banner. It renders `feedBanner()` and adds nothing.
//
// Every word on this surface lives in lib/terminal/feedBanner.ts, including
// which states must carry NOT_A_ZERO. That is not tidiness: a sentence written
// inline here would be reachable only through the DOM, and the one guarantee
// this page makes — that no state is ever left wordless, and that "could not
// read" never renders like "nothing found" — is exactly the kind that a
// component's conditional quietly drops.

const TONES: Record<BannerTone, string> = {
  neutral: 'border-white/20 bg-white/[0.03]',
  good: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  warn: 'border-amber-400/40 bg-amber-400/[0.07]',
};

export interface MarketFeedStatusProps {
  state: MarketFeedState;
  context: FeedBannerContext;
  onReload: () => void;
}

export function MarketFeedStatus({ state, context, onReload }: MarketFeedStatusProps) {
  const banner = feedBanner(state, context);

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[banner.tone]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{banner.title}</h2>
        {banner.showRetry ? (
          <button
            type="button"
            onClick={onReload}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-white/25 px-3 text-xs font-medium text-white hover:bg-white/10"
          >
            Re-read
          </button>
        ) : null}
      </div>

      <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-white/80">
        {banner.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {banner.notAZero ? <li className="text-white/70">{NOT_A_ZERO}</li> : null}
      </ul>
    </div>
  );
}
