import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount, useChainId } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { ART } from '../lib/artConfig';
import { randomToweliQuote } from '../lib/copy';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import { useToweliQueueInternal } from '../hooks/useTowelie';

// ─────────────────────────────────────────────────────────────────
// Event copy banks. Pick a random line per event so repeat triggers
// don't get repetitive. Keep in voice — Towelie is a slacker towel.
// ─────────────────────────────────────────────────────────────────
const COPY = {
  walletConnected: [
    "Hey, you connected. Don't fuck this up.",
    "Wallet's in. The farm awaits.",
    "Connected. I have no idea what just happened, but cool.",
  ],
  txSuccess: [
    "Locked it down. With tegridy.",
    "Done. Easy money.",
    "Boom. That worked.",
    "Tegridy preserved.",
  ],
  txFail: [
    "Eh, shit happens. Try again.",
    "That didn't take. Wallet probably said no.",
    "Whoops. Maybe more gas?",
  ],
  wrongNetwork: [
    "Wrong network, dude. Hop to mainnet.",
    "We don't farm on that chain. Switch to Ethereum.",
  ],
  // Idle nudge bank — rotated so we don't say the same thing every time.
  idle: [
    "Still there? I'll be right here if you need me.",
    "You good? Take your time. I'm just a towel.",
    "Wanna get high? Oh wait, wrong farm.",
    "I should probably do something. Or not.",
    "Don't forget to bring a towel. Or do. I'm not your boss.",
  ],
} as const;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

// Type-on-screen for the bubble text. ~18ms per char ≈ ~1s for a typical
// line. Resets whenever the source text changes (i.e. new bubble).
function useTypewriter(text: string | undefined, charMs = 18): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!text) { setShown(''); return; }
    setShown('');
    let i = 0;
    const id = setInterval(() => {
      i++;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, charMs);
    return () => clearInterval(id);
  }, [text, charMs]);
  return shown;
}

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
  '/gallery':     "All the art. Look, don't lick.",
  '/history':     "Your tx receipts. Tegridy keeps the books.",
  '/faq':         "Got questions? I probably have shrugs.",
  '/risks':       "Read this. Seriously. With tegridy.",
  '/terms':       "Legal stuff. Required by grown-ups.",
  '/privacy':     "We don't track much. Towels respect privacy.",
  '/contracts':   "Where the magic happens. On-chain.",
  '/treasury':    "Watch the funds. Transparency, with tegridy.",
};

const STORAGE_DISABLED = 'towelie:disabled';
const STORAGE_SEEN_PREFIX = 'towelie:seen:'; // per-route flag
const SNOOZE_MS = 2 * 60 * 1000;             // dismiss → hide for 2 min
const IDLE_MS = 45_000;                       // 45s idle → "you there?"
const ROUTE_TIP_DELAY_MS = 2200;              // 2.2s after navigation
const EVENT_COOLDOWN_MS = 25_000;             // min gap between event-driven bubbles
const FATIGUE_THRESHOLD = 3;                  // dismissals before auto-snooze
const FATIGUE_WINDOW_MS = 5 * 60 * 1000;      // count dismissals over 5 min
const FATIGUE_SNOOZE_MS = 30 * 60 * 1000;     // snooze for 30 min when fatigued

type BubbleSource = 'route' | 'idle' | 'click' | 'event' | 'api' | null;

export function TowelieAssistant() {
  const location = useLocation();
  const [disabled, setDisabled] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_DISABLED) === '1'; } catch { return false; }
  });
  const [bubble, setBubble] = useState<{ text: string; src: BubbleSource } | null>(null);
  const typedText = useTypewriter(bubble?.text);
  const snoozedUntil = useRef<number>(0);
  const lastEventAt = useRef<number>(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fatigue tracking — if user dismisses N times in W minutes, take a hint
  // and snooze for 30 min so we stop being annoying. Cleared on page reload.
  const dismissTimes = useRef<number[]>([]);
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { receiptData } = useTransactionReceipt();
  const { queue, consume } = useToweliQueueInternal();
  const currentApiId = useRef<number | null>(null);

  const canShow = useCallback(() => !disabled && Date.now() >= snoozedUntil.current, [disabled]);

  // Event-driven nudge (wallet/tx/wrong-network). Throttled and only when
  // not actively showing another bubble.
  const fireEvent = useCallback((text: string) => {
    if (!canShow()) return;
    const now = Date.now();
    if (now - lastEventAt.current < EVENT_COOLDOWN_MS) return;
    lastEventAt.current = now;
    setBubble({ text, src: 'event' });
  }, [canShow]);

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

  // useTowelie() queue — drain as fast as bubble visibility allows.
  // Urgent messages bypass cooldown + replace whatever is showing. Info/flavor
  // wait until the assistant is free and respect the same 25s cooldown as
  // event-driven bubbles so we don't become a chatbox.
  useEffect(() => {
    if (disabled || queue.length === 0) return;
    const next = queue[0]!;
    const isUrgent = next.priority === 'urgent';
    if (!isUrgent) {
      if (bubble) return; // wait for current bubble to clear
      if (Date.now() < snoozedUntil.current) return;
      if (Date.now() - lastEventAt.current < EVENT_COOLDOWN_MS) return;
    }
    lastEventAt.current = Date.now();
    currentApiId.current = next.id;
    setBubble({ text: next.text, src: 'api' });
  }, [queue, bubble, disabled]);

  // Wallet connected — fires once per connection edge. Skips initial mount
  // (hydrated-already-connected shouldn't trigger a greeting every load).
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasConnected.current === null) { wasConnected.current = isConnected; return; }
    if (!wasConnected.current && isConnected) fireEvent(pick(COPY.walletConnected));
    wasConnected.current = isConnected;
  }, [isConnected, fireEvent]);

  // Tx success — receiptData going non-null means a tx just confirmed.
  const lastReceiptKey = useRef<string | null>(null);
  useEffect(() => {
    if (!receiptData) return;
    const key = receiptData.data.txHash ?? `${receiptData.type}:${receiptData.data.amount ?? ''}`;
    if (lastReceiptKey.current === key) return;
    lastReceiptKey.current = key;
    fireEvent(pick(COPY.txSuccess));
  }, [receiptData, fireEvent]);

  // Wrong network — only when connected to a non-mainnet chain.
  useEffect(() => {
    if (!isConnected) return;
    if (chainId === mainnet.id) return;
    fireEvent(pick(COPY.wrongNetwork));
  }, [isConnected, chainId, fireEvent]);

  // Idle nudge — resets on mouse/key/touch activity. Shows once per idle
  // period, then snoozes itself so it doesn't loop.
  useEffect(() => {
    if (disabled) return;
    const reset = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        if (!canShow()) return;
        setBubble({ text: pick(COPY.idle), src: 'idle' });
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
    if (currentApiId.current !== null) {
      consume(currentApiId.current);
      currentApiId.current = null;
    }
    setBubble(null);
    // API messages get a shorter snooze so the queue can drain naturally.
    const snooze = bubble?.src === 'api' ? EVENT_COOLDOWN_MS : SNOOZE_MS;
    snoozedUntil.current = Date.now() + snooze;
    // Track this dismissal. If the user has rage-dismissed N times in the
    // last 5 minutes, take the hint and snooze for 30 min — they're trying
    // to focus, not chat with a towel.
    const now = Date.now();
    dismissTimes.current = [...dismissTimes.current, now].filter((t) => now - t < FATIGUE_WINDOW_MS);
    if (dismissTimes.current.length >= FATIGUE_THRESHOLD) {
      snoozedUntil.current = now + FATIGUE_SNOOZE_MS;
      dismissTimes.current = [];
    }
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
    <div
      className="fixed right-4 z-[60] flex items-end gap-2 pointer-events-none select-none bottom-20 md:bottom-4"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
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
              {typedText || '\u00a0'}
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
        whileHover={{ scale: 1.06, rotate: [0, -10, 10, -6, 6, 0], transition: { duration: 0.7 } }}
        whileTap={{ scale: 0.94 }}
      >
        <img src={ART.bobowelie.src} alt="Towelie" className="w-full h-full object-cover" />
      </m.button>
    </div>
  );
}
