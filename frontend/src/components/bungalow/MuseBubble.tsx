import { useEffect, useState } from 'react';

/**
 * The muse's voice — a quiet floating line in a token-first bungalow,
 * standing in the corner where the Towelie assistant lives in the default
 * skin. Deliberately smaller than the assistant: one rotating line of
 * canon, a dismiss that lasts the session, no chat, no knowledge base.
 * Rotation pauses in hidden tabs and never runs under reduced motion
 * (same manners as the hero's quote ticker).
 */
const LINES = [
  'The work is yours. The light is hers.',
  'The muse was always here.',
  'Her pull reaches every kind of maker.',
  'Time held is what counts.',
  'Dank Memes + Time = Memetic Finance.',
] as const;

const DISMISS_KEY = 'tegridy-muse-dismissed';

export function MuseBubble() {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [idx, setIdx] = useState(0);
  const [reduceMotion] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  });

  useEffect(() => {
    if (dismissed || reduceMotion) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setIdx((i) => (i + 1) % LINES.length);
    }, 9000);
    return () => window.clearInterval(id);
  }, [dismissed, reduceMotion]);

  if (dismissed) return null;

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
    setDismissed(true);
  };

  return (
    <div className="fixed right-4 bottom-20 md:bottom-4 z-[60] max-w-[280px] pointer-events-none select-none">
      <div
        className="pointer-events-auto rounded-xl px-3 py-2.5 pr-8 relative text-[12px] leading-snug shadow-lg"
        style={{
          background: 'rgba(4,18,12,0.88)',
          border: '1px solid rgba(142,240,216,0.35)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <span aria-hidden="true" className="absolute -top-2 -left-2 w-4 h-4 rounded-full" style={{ background: 'radial-gradient(circle, rgba(142,240,216,0.9), rgba(142,240,216,0) 70%)' }} />
        <p className="text-white/90 italic">&ldquo;{LINES[idx]}&rdquo;</p>
        <p className="text-[10px] not-italic mt-0.5" style={{ color: '#8ef0d8' }}>&mdash; the muse</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the muse's line for this session"
          className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center text-white/50 hover:text-white text-[13px] leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
