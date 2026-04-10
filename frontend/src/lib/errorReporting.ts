const STORAGE_KEY = 'tegridy_error_log';
const MAX_BUFFER = 50;
const DEDUP_WINDOW_MS = 60_000;
const DEDUP_MAX_ENTRIES = 500;
const BATCH_INTERVAL_MS = 5_000;

/** Patterns that indicate sensitive data which must never be reported. */
const SENSITIVE_PATTERNS =
  /\b(0x[0-9a-fA-F]{64})\b|(\b(?:[a-z]+\s){11,23}[a-z]+\b)|bearer\s+[^\s]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;

/** Max length for any single string field sent in a report. */
const MAX_FIELD_LENGTH = 500;

interface ErrorEntry {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: number;
  url: string;
}

let batch: ErrorEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const recentKeys = new Map<string, number>();

/** Strip sensitive material (private keys, mnemonics, bearer tokens, JWTs) from a string. */
function sanitize(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(SENSITIVE_PATTERNS, '[REDACTED]').slice(0, MAX_FIELD_LENGTH);
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

function persistToLocalStorage(entries: ErrorEntry[]) {
  try {
    const existing: ErrorEntry[] = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const merged = [...existing, ...entries].slice(-MAX_BUFFER);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // localStorage full or unavailable
  }
}

/** Validate the error endpoint to prevent exfiltration to unexpected origins. */
function isAllowedEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
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

function flush() {
  if (batch.length === 0) return;
  const toSend = batch.splice(0);
  const endpoint = import.meta.env.VITE_ERROR_ENDPOINT;

  if (endpoint && isAllowedEndpoint(endpoint)) {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toSend),
    }).catch(() => {
      persistToLocalStorage(toSend);
    });
  } else {
    persistToLocalStorage(toSend);
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

export function installGlobalHandlers() {
  window.onerror = (_msg, _source, _line, _col, error) => {
    reportError(error ?? _msg);
  };

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason);
  });
}
