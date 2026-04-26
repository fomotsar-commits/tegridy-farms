// Lightweight, dependency-free analytics for Tegridy Farms
// Batches events and flushes every 10 seconds to VITE_ANALYTICS_ENDPOINT
//
// AUDIT R046 H-1: every track/* helper is gated behind hasConsent() so no
// telemetry leaves the browser before the user opts in via the ConsentBanner.
// AUDIT R046 M-1: trackError now routes both message and context through the
// shared sanitize() from errorReporting.ts (closes wallet-PII / secret-leak
// asymmetry between the analytics and error channels).

import { hasConsent } from './consent';
import { sanitize } from './errorReporting';

const FLUSH_INTERVAL_MS = 10_000;
const ENDPOINT = import.meta.env.VITE_ANALYTICS_ENDPOINT as string | undefined;
const IS_DEV = import.meta.env.DEV;

// ---------------------------------------------------------------------------
// Session ID (persisted per browser tab session)
// ---------------------------------------------------------------------------
function getSessionId(): string {
  const KEY = 'tegridy_session_id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

const sessionId = getSessionId();

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------
interface AnalyticsEvent {
  event: string;
  properties: Record<string, unknown>;
  sessionId: string;
  timestamp: string;
}

let queue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

async function flush(useBeacon = false) {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  if (IS_DEV || !ENDPOINT) {
    // In development or when no endpoint is configured, log to console
    for (const evt of batch) {
      console.log('[analytics]', evt.event, evt.properties);
    }
    return;
  }

  const body = JSON.stringify({ events: batch });

  // Use sendBeacon when the page is unloading — regular fetch gets cancelled
  if (useBeacon && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    if (!sent) queue = batch.concat(queue); // re-queue if beacon failed
    return;
  }

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // Re-queue on failure so events aren't lost (batch first, then pending queue)
    queue = [...batch, ...queue];
  }
}

// Flush remaining events when the tab is closing
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

// ---------------------------------------------------------------------------
// Core track function
// ---------------------------------------------------------------------------
export function track(eventName: string, properties?: Record<string, unknown>): void {
  // AUDIT R046 H-1: deny-by-default. No event is enqueued until consent is
  // granted, so trackPageView/trackWalletConnect/etc. all stay silent on
  // pages mounted before the user clicks "Accept" in the ConsentBanner.
  if (!hasConsent()) return;

  queue.push({
    event: eventName,
    properties: properties ?? {},
    sessionId,
    timestamp: new Date().toISOString(),
  });
  startFlushTimer();
}

// ---------------------------------------------------------------------------
// Typed event helpers
// ---------------------------------------------------------------------------
export function trackSwap(
  fromToken: string,
  toToken: string,
  amount: string,
  route: string,
): void {
  track('swap', { fromToken, toToken, amount, route });
}

export function trackStake(amount: string, lockDuration: number): void {
  track('stake', { amount, lockDuration });
}

export function trackUnstake(amount: string): void {
  track('unstake', { amount });
}

export function trackNFTPurchase(
  collection: string,
  tokenId: string,
  price: string,
): void {
  track('nft_purchase', { collection, tokenId, price });
}

export function trackPageView(pageName: string): void {
  track('page_view', { pageName });
}

export function trackWalletConnect(walletName: string): void {
  track('wallet_connect', { walletName });
}

export function trackError(error: unknown, context: string): void {
  // AUDIT R046 M-1: route both message and context through the shared
  // sanitize() from errorReporting.ts so wallet hex / private keys /
  // mnemonics / JWTs / bearer tokens / secret KVs are scrubbed identically
  // across the analytics and error channels.
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitize(rawMessage) ?? 'Unknown error';
  const cleanContext = sanitize(context) ?? '';
  track('error', { message, context: cleanContext });
}
