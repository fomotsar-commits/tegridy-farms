import { useEffect, useState } from 'react';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';

/**
 * The resident's voice — a quiet floating line in a token-first bungalow,
 * standing in the corner where the Towelie assistant lives in the default
 * skin. Deliberately smaller than the assistant: one rotating line of
 * canon, a dismiss that lasts the session, no chat, no knowledge base.
 * Rotation pauses in hidden tabs and never runs under reduced motion
 * (same manners as the hero's quote ticker).
 *
 * Registry-driven since WO-1: the lines, the byline persona and the accent
 * all come from the active bungalow's own identity — this component knows
 * nothing about BAYLA. The dismissal is scoped per bungalow id, so hushing
 * one resident's voice never silences a different bungalow's.
 */
const FALLBACK_ACCENT = '#8ef0d8';

const dismissKey = (id: string) => `tegridy-muse-dismissed:${id}`;

export function MuseBubble({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  const { identity } = bungalow;
  const lines: readonly string[] =
    identity.museLines && identity.museLines.length > 0 ? identity.museLines : [identity.museLine];
  const byline = identity.museVoice ?? identity.museBy;
  const accent = bungalow.accent ?? FALLBACK_ACCENT;

  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(dismissKey(bungalow.id)) === '1'; } catch { return false; }
  });
  const [idx, setIdx] = useState(0);
  const [reduceMotion] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  });

  useEffect(() => {
    if (dismissed || reduceMotion || lines.length < 2) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setIdx((i) => (i + 1) % lines.length);
    }, 9000);
    return () => window.clearInterval(id);
  }, [dismissed, reduceMotion, lines.length]);

  if (dismissed) return null;

  const dismiss = () => {
    try { sessionStorage.setItem(dismissKey(bungalow.id), '1'); } catch { /* noop */ }
    setDismissed(true);
  };

  return (
    <div className="fixed right-4 bottom-20 md:bottom-4 z-[60] max-w-[280px] pointer-events-none select-none">
      <div
        className="pointer-events-auto rounded-xl px-3 py-2.5 pr-8 relative text-[12px] leading-snug shadow-lg"
        style={{
          background: 'rgba(4,18,12,0.88)',
          // Registry accents are 6-digit hex, so hex-alpha suffixes are safe.
          border: `1px solid ${accent}59`,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <span aria-hidden="true" className="absolute -top-2 -left-2 w-4 h-4 rounded-full" style={{ background: `radial-gradient(circle, ${accent}e6, ${accent}00 70%)` }} />
        <p className="text-white/90 italic">&ldquo;{lines[idx % lines.length]}&rdquo;</p>
        <p className="text-[10px] not-italic mt-0.5" style={{ color: accent }}>&mdash; {byline}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={`Dismiss ${byline}'s line for this session`}
          /* A11Y-R12, same as the Towelie bubble's dismiss: the 24px painted
             glyph stays, a transparent ::before takes the tap target to 44x44. */
          className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center text-white/50 hover:text-white text-[13px] leading-none before:absolute before:content-[''] before:-inset-[10px]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
