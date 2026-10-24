import { hasConsent } from './consent';
// The start date is the server's constant, not a copy (api/_lib/errorPolicy.js).
import { ERROR_REPORTING_STARTS_AT_MS, errorReportingOpen } from '../../api/_lib/errorPolicy.js';

const STORAGE_KEY = 'tegridy_error_log';
const MAX_BUFFER = 50;
const DEDUP_WINDOW_MS = 60_000;
const DEDUP_MAX_ENTRIES = 500;
const BATCH_INTERVAL_MS = 5_000;

/**
 * DELIVERY WHEN THE SINK IS NOT READY (2026-10-02).
 *
 * /api/errors answers 503 until the operator has applied migration 026 and set
 * Upstash, and 429 when one visitor sends too much. Either way the batch goes
 * back into the localStorage buffer and nothing is sent again until a wait has
 * passed: one minute, doubling on each refusal up to an hour, or longer if the
 * server's Retry-After asks for it. The wait lives in localStorage because a
 * crash loop reloads the page, and a wait held only in memory would restart at
 * zero on every reload. The buffer is sent when the wait is over, on the next
 * error or the next page load, at most MAX_BUFFER entries a request, and
 * entries older than a week are not sent at all.
 *
 * NOTHING BEFORE THE START DATE (owner, 2026-10-02). The Privacy page gives 14 days'
 * notice, as its section 9 promises, so before ERROR_REPORTING_STARTS_AT nothing is
 * sent even if VITE_ERROR_ENDPOINT is set, and after it an entry captured before it
 * is dropped, never sent. api/errors.js refuses both again on its side. The date is
 * written once, in api/_lib/errorPolicy.js; this file never spells it.
 */
const BACKOFF_KEY = 'tegridy_error_backoff';
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60_000;
/** Fired by consent.ts's setConsent(). */
const CONSENT_EVENT = 'tegridy:consent-changed';

/**
 * Patterns that indicate sensitive *values* which must never be reported.
 * AUDIT R046 M-2 / R057: extended with 40-hex EVM wallet addresses.
 *  - 64-hex private keys
 *  - BIP-39 mnemonics (12–24 lowercase words)
 *  - JWTs (eyJ.x.y)
 *  - bearer tokens
 *  - 40-hex wallet addresses (de-anonymise users in stack traces / revert msgs)
 */
const SENSITIVE_PATTERNS =
  /\b(0x[0-9a-fA-F]{64})\b|(\b(?:[a-z]+\s){11,23}[a-z]+\b)|bearer\s+[^\s]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|0x[a-fA-F0-9]{40}\b/gi;

/**
 * AUDIT R057: key-name patterns. Redacts the *value* attached to a known
 * secret key name (e.g. `apiKey=sk_live_...`, `Authorization: Bearer ...`,
 * `password = hunter2`) while keeping the key for debug attribution.
 * Mirrors the surface defended on the server in `api/_lib/logSafe.js`.
 */
const SECRET_KV_PATTERN =
  /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|token|password|auth)(\s*[:=]\s*)["']?([^"'\s,;}]+)["']?/gi;

/** Max length for any single string field sent in a report. */
const MAX_FIELD_LENGTH = 500;

interface ErrorEntry {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: number;
  url: string;
}

const batch: ErrorEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const recentKeys = new Map<string, number>();

/**
 * Strip sensitive material (private keys, mnemonics, bearer tokens, JWTs,
 * EVM wallet addresses, and `<secret-key>=<value>` pairs) from a string.
 *
 * AUDIT R057: exported so analytics.ts can share the same sanitiser surface.
 */
export function sanitize(value: string | undefined): string | undefined {
  if (!value) return value;
  let out = value.replace(SENSITIVE_PATTERNS, '[REDACTED]');
  // Then redact secret-keyed values while keeping the key for debug.
  out = out.replace(SECRET_KV_PATTERN, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  return out.slice(0, MAX_FIELD_LENGTH);
}

/** Strip query params / fragments that may contain tokens from URLs. */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString().slice(0, MAX_FIELD_LENGTH);
  } catch {
    return raw.slice(0, MAX_FIELD_LENGTH);
  }
}

function dedupeKey(entry: ErrorEntry): string {
  return `${entry.message}::${entry.stack?.slice(0, 200) ?? ''}`;
}

function isDuplicate(entry: ErrorEntry): boolean {
  const key = dedupeKey(entry);
  const lastSeen = recentKeys.get(key);
  const now = Date.now();
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  // Evict oldest entries when the map grows too large to prevent memory leaks.
  if (recentKeys.size >= DEDUP_MAX_ENTRIES) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [k, ts] of recentKeys) {
      if (ts < cutoff) recentKeys.delete(k);
    }
    // If still over limit after eviction, clear entirely.
    if (recentKeys.size >= DEDUP_MAX_ENTRIES) recentKeys.clear();
  }
  recentKeys.set(key, now);
  return false;
}

function readBuffer(): ErrorEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? (parsed as ErrorEntry[]) : [];
  } catch {
    return [];
  }
}

function writeBuffer(entries: ErrorEntry[]) {
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_BUFFER)));
  } catch {
    // localStorage full or unavailable
  }
}

function persistToLocalStorage(entries: ErrorEntry[]) {
  if (entries.length === 0) return;
  writeBuffer([...readBuffer(), ...entries]);
}

/** Consent withdrawn: nothing captured under it is kept for sending. */
function discardAll() {
  batch.length = 0;
  writeBuffer([]);
}

interface Backoff {
  until: number;
  failures: number;
}

/** Mirrors the stored wait, so a browser that refuses localStorage still waits. */
let memoryBackoff: Backoff = { until: 0, failures: 0 };

function readBackoff(): Backoff {
  try {
    const v = JSON.parse(localStorage.getItem(BACKOFF_KEY) || 'null') as Partial<Backoff> | null;
    if (v && Number.isFinite(v.until) && Number.isFinite(v.failures) && (v.until as number) > memoryBackoff.until) {
      return { until: v.until as number, failures: v.failures as number };
    }
  } catch {
    // unreadable: fall back to the in-memory copy
  }
  return memoryBackoff;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. 0 when absent or unreadable. */
function retryAfterMs(header: string | null | undefined): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function noteFailure(serverAskedMs = 0) {
  const failures = readBackoff().failures + 1;
  const doubling = BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10);
  const wait = Math.min(BACKOFF_MAX_MS, Math.max(doubling, serverAskedMs));
  memoryBackoff = { until: Date.now() + wait, failures };
  try {
    localStorage.setItem(BACKOFF_KEY, JSON.stringify(memoryBackoff));
  } catch {
    // memoryBackoff still holds it for this page
  }
}

function noteSuccess() {
  memoryBackoff = { until: 0, failures: 0 };
  try {
    localStorage.removeItem(BACKOFF_KEY);
  } catch {
    // nothing stored to clear
  }
}

/**
 * A stored entry worth sending: the right shape (it came from localStorage), under a
 * week old, and captured on or after the start date.
 */
function isReplayable(e: unknown, now: number): e is ErrorEntry {
  if (!e || typeof e !== 'object') return false;
  const { message, timestamp } = e as Partial<ErrorEntry>;
  return typeof message === 'string'
    && typeof timestamp === 'number'
    && timestamp >= ERROR_REPORTING_STARTS_AT_MS
    && now - timestamp <= MAX_REPLAY_AGE_MS;
}

/** Validate the error endpoint to prevent exfiltration to unexpected origins. */
function isAllowedEndpoint(url: string): boolean {
  try {
    // A SAME-ORIGIN PATH IS THE NORMAL CONFIGURATION, AND IT USED TO THROW.
    // `.env.example` sets the analytics twin as `/api/analytics`, so an
    // operator wiring this one copies that shape - and `new URL('/api/errors')`
    // with no base raises TypeError, the catch below returns false, and flush()
    // silently diverts every batch to the write-only localStorage buffer. The
    // endpoint would read as "configured" while errors kept vanishing: exactly
    // the bug this reporter exists to end, rebuilt one layer down.
    //
    // Resolve ONLY a genuine same-origin path. The `//` exclusion is
    // load-bearing: `new URL('//evil.example/x', origin)` resolves to
    // `https://evil.example/x`, so accepting protocol-relative input here would
    // widen the exfiltration control this function exists to enforce. Those
    // still fall through to the bare parse, which rejects them as before.
    const sameOriginPath = url.startsWith('/') && !url.startsWith('//');
    const parsed = sameOriginPath
      ? new URL(url, window.location.origin)
      : new URL(url);
    const h = parsed.hostname;
    // Block non-HTTPS (except localhost for dev)
    if (parsed.protocol !== 'https:' && h !== 'localhost') return false;
    // Block loopback / unspecified addresses
    if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('127.') || h === '0.0.0.0' || h === '::1' || h === '[::]') {
      // Allow localhost only when NOT using https (dev-only escape above already passed)
      // For https://localhost we still allow it, but block https://127.0.0.1 etc.
      return h === 'localhost';
    }
    // Block cloud metadata / link-local addresses
    if (h.startsWith('169.254.') || h === 'metadata.google.internal') return false;
    // Block private IPv4 ranges
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h)) return false;
    // Block IPv6 private/link-local (fc00::/7 unique-local, fe80::/10 link-local)
    if (/^(fc|fd|fe[89ab])/i.test(h) || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

let inFlight = false;

function flush() {
  // Consent is read again at SEND time. reportError() checked it at capture, but
  // the visitor can withdraw it in the five seconds a batch waits, or between the
  // visit that buffered an entry and the one that would send it.
  if (!hasConsent()) {
    discardAll();
    return;
  }

  const endpoint = import.meta.env.VITE_ERROR_ENDPOINT;
  const now = Date.now();
  // Before the start date the browser sends nothing, whatever the endpoint says.
  if (!endpoint || !errorReportingOpen(now) || !isAllowedEndpoint(endpoint) || inFlight || now < readBackoff().until) {
    persistToLocalStorage(batch.splice(0));
    return;
  }

  // Take the buffer with the new batch, newest MAX_BUFFER only. It is cleared
  // now and put back if the send fails, so two flushes cannot send it twice.
  const toSend = [...readBuffer(), ...batch.splice(0)]
    .filter((e) => isReplayable(e, now))
    .slice(-MAX_BUFFER);
  writeBuffer([]);
  if (toSend.length === 0) return;

  const putBack = (serverAskedMs = 0) => {
    if (hasConsent()) writeBuffer([...toSend, ...readBuffer()]);
    noteFailure(serverAskedMs);
  };

  inFlight = true;
  try {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: 'granted', errors: toSend }),
      // No cookie and no Referer: the sign-in cookie would tie a record to a
      // wallet session, and the Referer would carry the query string that
      // sanitizeUrl() strips from the record itself.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then((r) => {
      // fetch only rejects on network error; a 4xx/5xx resolves with ok=false.
      if (r.ok) noteSuccess();
      else putBack(retryAfterMs(r.headers.get('Retry-After')));
    }).catch(() => {
      putBack();
    }).finally(() => {
      inFlight = false;
    });
  } catch {
    inFlight = false;
    putBack();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, BATCH_INTERVAL_MS);
}

export function reportError(
  error: unknown,
  componentStack?: string,
): void {
  // AUDIT R046 H-1: deny-by-default consent gate. No telemetry leaves the
  // browser until the user has affirmatively granted consent via the banner.
  if (!hasConsent()) return;

  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack : undefined;

  const entry: ErrorEntry = {
    message: sanitize(rawMessage) ?? 'Unknown error',
    stack: sanitize(rawStack),
    componentStack: sanitize(componentStack),
    timestamp: Date.now(),
    url: sanitizeUrl(window.location.href),
  };

  if (isDuplicate(entry)) return;

  batch.push(entry);
  scheduleFlush();
}

let installed = false;

export function installGlobalHandlers() {
  if (installed) return;
  installed = true;

  // Withdrawn consent empties the buffer at once, not at the next flush.
  window.addEventListener(CONSENT_EVENT, (event) => {
    if ((event as CustomEvent).detail !== 'granted') discardAll();
  });

  // Whatever an earlier visit buffered: dropped without consent, otherwise sent
  // once any backoff has passed. flush() does both checks.
  if (!hasConsent()) discardAll();
  else if (readBuffer().length > 0) scheduleFlush();

  window.addEventListener('error', (event) => {
    try {
      reportError(event.error ?? event.message);
    } catch {
      // Prevent the error handler itself from throwing
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      reportError(event.reason);
    } catch {
      // Prevent the error handler itself from throwing
    }
  });
}
