import { useState, useEffect, useCallback } from 'react';

const SEASONAL_EVENTS = [
  {
    id: 'harvest-season-q2-2026',
    name: 'Harvest Season',
    description: '2x points on all staking activity',
    startDate: '2026-06-01T00:00:00Z',
    endDate: '2026-06-05T00:00:00Z',
    multiplier: 2,
    color: '#f59e0b', // amber
  },
  {
    id: 'ape-month-2026',
    name: 'Ape Month',
    description: 'NFT boost bonus +10% for all holders',
    startDate: '2026-07-01T00:00:00Z',
    endDate: '2026-07-31T00:00:00Z',
    multiplier: 1.1,
    color: '#8b5cf6', // purple
  },
] as const;

type SeasonalEvent = (typeof SEASONAL_EVENTS)[number];

function getActiveEvent(): SeasonalEvent | null {
  const now = Date.now();
  return SEASONAL_EVENTS.find(
    (e) => now >= new Date(e.startDate).getTime() && now < new Date(e.endDate).getTime(),
  ) ?? null;
}

function isDismissed(id: string): boolean {
  try { return localStorage.getItem(`tegridy-event-dismissed-${id}`) === '1'; } catch { return false; }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0d 0h 0m';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${d}d ${h}h ${m}m`;
}

export function SeasonalEventBanner() {
  const [event, setEvent] = useState<SeasonalEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [countdown, setCountdown] = useState('');

  // Check for active event on mount and every 60s
  useEffect(() => {
    const check = () => {
      const active = getActiveEvent();
      setEvent(active);
      if (active) setDismissed(isDismissed(active.id));
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);

  // Countdown ticker
  useEffect(() => {
    if (!event) return;
    const tick = () => {
      const remaining = new Date(event.endDate).getTime() - Date.now();
      setCountdown(formatCountdown(remaining));
      if (remaining <= 0) setEvent(null);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [event]);

  const dismiss = useCallback(() => {
    if (!event) return;
    try { localStorage.setItem(`tegridy-event-dismissed-${event.id}`, '1'); } catch {}
    setDismissed(true);
  }, [event]);

  if (!event || dismissed) return null;

  return (
    <div
      className="relative z-30 mx-auto max-w-[1200px] px-4 md:px-6 mt-2"
    >
      <div
        className="rounded-xl backdrop-blur-md p-4 flex items-center justify-between gap-3 flex-wrap animate-pulse-border"
        style={{
          background: `linear-gradient(135deg, ${event.color}15, ${event.color}08)`,
          border: `1.5px solid ${event.color}`,
          boxShadow: `0 0 20px ${event.color}20`,
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-lg shrink-0" style={{ color: event.color }}>
            {event.multiplier >= 2 ? '\u2728' : '\u{1F680}'}
          </span>
          <div className="min-w-0">
            <p className="text-white text-[13px] font-semibold truncate">{event.name}</p>
            <p className="text-white/70 text-[11px] truncate">{event.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-white/80 text-[11px] font-mono">{countdown}</span>
          <button
            onClick={dismiss}
            className="text-white/70 hover:text-white text-[16px] leading-none transition-colors"
            aria-label="Dismiss event banner"
          >
            x
          </button>
        </div>
      </div>
    </div>
  );
}
