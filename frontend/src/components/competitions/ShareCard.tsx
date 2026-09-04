import { useMemo } from 'react';
import { CopyButton } from '../ui/CopyButton';

// A RANK THAT TRAVELS WITH ITS CAVEATS.
//
// A screenshot of "#3" outlives the page it came from. So the shareable sentence
// carries the things that make the number mean anything: how many pools answered
// out of how many, the word "provisional" whenever the board is not complete,
// and the time of the newest fill the read actually saw. The text is built in
// lib/competitions/islandCup.ts (`cupShareText`) and rendered verbatim here —
// this component cannot quietly shorten it.
//
// The native share sheet is FEATURE-DETECTED, not assumed: `navigator.share` is
// absent on most desktop browsers, and an offered button that throws is worse
// than one that was never there. Copy always works and is always offered.

export interface ShareCardProps {
  text: string;
}

function canNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function ShareCard({ text }: ShareCardProps) {
  const nativeShare = useMemo(() => canNativeShare(), []);

  return (
    <div className="mt-3 rounded-lg border border-white/12 bg-black/25 p-3">
      <p className="text-[11px] uppercase tracking-wide text-white/55">Shareable, with its caveats</p>
      <p className="mt-1 text-xs leading-relaxed text-white/85">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <CopyButton
          text={text}
          display="Copy"
          className="min-h-[44px] rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white"
        />
        {nativeShare ? (
          <button
            type="button"
            onClick={() => {
              // Rejections here are the user dismissing the sheet, which is not
              // an error and must not raise one into the page.
              void navigator.share({ text }).catch(() => undefined);
            }}
            className="min-h-[44px] rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white hover:bg-white/10"
          >
            Share
          </button>
        ) : null}
      </div>
    </div>
  );
}
