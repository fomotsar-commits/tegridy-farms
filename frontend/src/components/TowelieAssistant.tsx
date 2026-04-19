import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ART } from '../lib/artConfig';
import { randomToweliQuote } from '../lib/copy';

// ─────────────────────────────────────────────────────────────────
// Per-route greeting copy. First visit to a route gets the tailored
// line; subsequent visits get nothing (quiet by default). Click the
// avatar any time for a random quote.
// ─────────────────────────────────────────────────────────────────
const ROUTE_TIPS: Record<string, string> = {
  '/':            "Welcome to the farm. Don't forget your towel.",
  '/dashboard':   "This is your portfolio. Stake longer, earn more.",
  '/farm':        "4× boost at max lock. Math checks out, I think.",
  '/swap':        "Trade TOWELI here. Or whatever — I'm just a towel.",
  '/liquidity':   "Add liquidity, earn fees. Easy money. Probably.",
  '/community':   "Vote, post bounties, propose grants. Tegridy demands it.",
  '/nft-finance': "Lend, borrow, trade NFTs. No oracles, no rugs.",
  '/lore':        "The story of how Tegridy was lost and found.",
  '/tokenomics':  "1B supply. 100% of fees flow back to stakers.",
  '/security':    "Audited and bug-bountied. Safer than my last job.",
  '/leaderboard': "Climb the ranks. Earn points. Brag responsibly.",
  '/changelog':   "Every shipped feature, with Tegridy.",
  '/premium':     "Randy's Gold Card. Bonus rewards for the loyal.",
};

const STORAGE_DISABLED = 'towelie:disabled';
const STORAGE_SEEN_PREFIX = 'towelie:seen:'; // per-route flag
const SNOOZE_MS = 2 * 60 * 1000;             // dismiss → hide for 2 min
const IDLE_MS = 45_000;                       // 45s idle → "you there?"
const ROUTE_TIP_DELAY_MS = 2200;              // 2.2s after navigation

type BubbleSource = 'route' | 'idle' | 'click' | null;

export function TowelieAssistant() {
  const location = useLocation();
  const [disabled, setDisabled] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_DISABLED) === '1'; } catch { return false; }
  });
  const [bubble, setBubble] = useState<{ text: string; src: BubbleSource } | null>(null);
  const snoozedUntil = useRef<number>(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canShow = useCallback(() => !disabled && Date.now() >= snoozedUntil.current, [disabled]);

  // Route greeting — fires once per route per browser, after a short pause
  // so it doesn't punch over a navigation transition.
  useEffect(() => {
    if (!canShow()) return;
    const tip = ROUTE_TIPS[location.pathname];
    if (!tip) return;
    const seenKey = STORAGE_SEEN_PREFIX + location.pathname;
    try { if (localStorage.getItem(seenKey) === '1') return; } catch {/* noop */}
    const t = setTimeout(() => {
      if (!canShow()) return;
      setBubble({ text: tip, src: 'route' });
      try { localStorage.setItem(seenKey, '1'); } catch {/* noop */}
    }, ROUTE_TIP_DELAY_MS);
    return () => clearTimeout(t);
  }, [location.pathname, canShow]);

  // Idle nudge — resets on mouse/key/touch activity. Shows once per idle
  // period, then snoozes itself so it doesn't loop.
  useEffect(() => {
    if (disabled) return;
    const reset = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        if (!canShow()) return;
        setBubble({ text: "Still there? I'll be right here if you need me.", src: 'idle' });
        snoozedUntil.current = Date.now() + SNOOZE_MS;
      }, IDLE_MS);
    };
    reset();
    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [disabled, canShow]);

  const dismissBubble = () => {
    setBubble(null);
    snoozedUntil.current = Date.now() + SNOOZE_MS;
  };

  const disablePermanently = () => {
    setBubble(null);
    setDisabled(true);
    try { localStorage.setItem(STORAGE_DISABLED, '1'); } catch {/* noop */}
  };

  const handleAvatarClick = () => {
    if (bubble) { dismissBubble(); return; }
    setBubble({ text: randomToweliQuote(), src: 'click' });
  };

  if (disabled) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex items-end gap-2 pointer-events-none select-none">
      <AnimatePresence>
        {bubble && (
          <m.div
            key="bubble"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto max-w-[260px] mb-1 relative"
            role="status"
            aria-live="polite"
          >
            <div
              className="rounded-xl px-3 py-2.5 pr-7 text-[12px] leading-snug text-white shadow-lg"
              style={{
                background: 'rgba(13, 21, 48, 0.92)',
                border: '1px solid rgba(139, 92, 246, 0.35)',
                backdropFilter: 'blur(8px)',
              }}
            >
              {bubble.text}
              <button
                onClick={dismissBubble}
                aria-label="Dismiss Towelie"
                className="absolute top-1 right-1 w-5 h-5 rounded-md flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors text-[14px] leading-none"
              >
                ×
              </button>
              <button
                onClick={disablePermanently}
                className="block mt-1.5 text-[10px] text-white/40 hover:text-white/70 transition-colors"
              >
                Don't show again
              </button>
            </div>
            {/* Tail */}
            <div
              className="absolute -bottom-1 right-6 w-2.5 h-2.5 rotate-45"
              style={{
                background: 'rgba(13, 21, 48, 0.92)',
                borderRight: '1px solid rgba(139, 92, 246, 0.35)',
                borderBottom: '1px solid rgba(139, 92, 246, 0.35)',
              }}
            />
          </m.div>
        )}
      </AnimatePresence>

      <m.button
        type="button"
        onClick={handleAvatarClick}
        aria-label="Towelie says hi"
        className="pointer-events-auto relative w-14 h-14 sm:w-16 sm:h-16 rounded-full overflow-hidden cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:ring-offset-2 focus:ring-offset-[#060c1a]"
        style={{
          border: '2px solid rgba(139, 92, 246, 0.5)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset',
        }}
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
      >
        <img src={ART.bobowelie.src} alt="Towelie" className="w-full h-full object-cover" />
      </m.button>
    </div>
  );
}
