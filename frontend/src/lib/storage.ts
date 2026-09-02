/**
 * Audit #56: Safe localStorage utilities with quota checking and eviction.
 *
 * AUDIT R045 M4: live call-sites use both `tegridy_` (snake_case) and
 * `tegridy-` (kebab-case, used by theme/onboarding/price alerts/NFT-finance
 * pools). The eviction whitelist used to match only `tegridy_`, so kebab-
 * prefixed entries filled quota but were never freed and `safeSetItem`
 * silently returned `false` ("settings not saving"). Whitelist is now
 * exported and covers both prefixes.
 *
 * AUDIT R080: `safeJsonParse<T>(str, fallback)` exported helper — was
 * imported by `useToweliPrice.ts` and `usePriceHistory.ts` but never
 * exported, which would have crashed at runtime if those hooks ever hit
 * the catch path.
 */

/** AUDIT R045 M4: every key prefix the eviction sweeper is allowed to reclaim. */
export const EVICTABLE_PREFIXES = ['tegridy_', 'tegridy-'] as const;

/**
 * Keys that hold a USER CHOICE rather than a cache — never evicted. A cache
 * re-fetches; evicting a choice silently reverts the user's state. Worse,
 * these are plain-string values, so the ts-less "oldest first" rule made
 * them the FIRST entries the sweeper deleted under quota pressure (the
 * bungalow choice reverting to Towelie mid-session was the symptom).
 */
export const EVICTION_PROTECTED_KEYS = new Set<string>([
  'tegridy-bungalow',
  'tegridy-theme',
  'tegridy-onboarding-seen',
  'tegridy-onboarding-bayla-seen',
  'tegridy_telemetry_consent',
  // The terminal watchlist is a LIST the user built by hand, not a cache. It
  // stores as a ts-less JSON array, which put it at the very front of the
  // sweeper's "oldest first" queue: the first quota-pressured write of any
  // price cache silently emptied it. Nothing re-derives a watchlist.
  'tegridy-terminal-watchlist',
  // Alert rules are a CHOICE and the inbox is the ONLY record that an alert was
  // ever delivered; the priors blob is the engine's watermark. None of the three
  // is re-derivable, and all three store as ts-less JSON, which put them at the
  // front of the "oldest first" queue — a watch that silently stopped watching.
  'tegridy-alert-rules-v1',
  'tegridy-alert-inbox-v1',
  'tegridy-alert-priors-v1',
  // A follow list and its per-trade CAP. These carry a top-level `ts`, so unlike
  // the keys above they look like ordinary caches to the sweeper — which makes
  // them worse, not better: the one control bounding a mirror's size can vanish
  // under quota pressure and leave a cap that is purely decorative. They predate
  // the `tegridy-own-` namespace and keep their names, because renaming them now
  // would orphan every follow already saved in a real browser.
  'tegridy_copytrade_follows',
  'tegridy_copytrade_mirrors',
]);

/**
 * Whole NAMESPACES of user-authored data, protected by prefix.
 *
 * The exact-key set above cannot scale to data that is one entry PER THING —
 * an alert rule per pool, a follow per wallet — because the key is only known
 * at runtime. Anything a user typed, drew or chose belongs under
 * `tegridy-own-`; anything the app can re-fetch does not.
 *
 * The rule is the same one the exact-key set encodes: a cache that is evicted
 * re-fetches and the user never knows, whereas a saved thing that is evicted
 * is GONE, and it goes silently at the exact moment the user is doing enough
 * to be near quota. Keep this list short — every protected byte is a byte the
 * sweeper cannot reclaim, and a storage full of unevictable entries turns
 * `safeSetItem` into a function that always returns false.
 */
export const EVICTION_PROTECTED_PREFIXES = ['tegridy-own-'] as const;

/** True if `key` is a Tegridy-namespaced cache entry safe to evict. */
export function isEvictable(key: string): boolean {
  if (EVICTION_PROTECTED_KEYS.has(key)) return false;
  for (const p of EVICTION_PROTECTED_PREFIXES) {
    if (key.startsWith(p)) return false;
  }
  for (const p of EVICTABLE_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/** Rough estimate of remaining localStorage space (returns bytes). */
function estimateRemainingQuota(): number {
  try {
    // Inside the try on purpose: with storage access blocked (Chrome "block
    // all cookies" and kin) even `typeof localStorage` invokes the throwing
    // window getter — outside a try that turned safeSetItem into a throw.
    if (typeof localStorage === 'undefined') return 5_242_880;
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) used += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
    // Most browsers give 5 MB (~5_242_880 chars in UTF-16 = ~10 MB bytes).
    // Halved for UTF-16 safety — each JS char can be 2 bytes.
    const BUDGET = 2_621_440;
    return Math.max(0, BUDGET - used);
  } catch {
    return 0;
  }
}

/**
 * Evict the oldest tegridy entries to free space.
 * Entries with a JSON `ts` field are sorted oldest-first; others are evicted first.
 * Both `tegridy_` (snake_case) and `tegridy-` (kebab-case) prefixes are covered.
 */
function evictOldEntries(bytesNeeded: number): boolean {
  try {
    // Same blocked-storage rule as estimateRemainingQuota: the typeof probe
    // itself can throw, so it lives inside the try.
    if (typeof localStorage === 'undefined') return false;
    const entries: { key: string; ts: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      // AUDIT R045 M4: scan both casing conventions, never touch foreign keys.
      if (!k || !isEvictable(k)) continue;
      let ts = 0;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? '');
        ts = typeof parsed?.ts === 'number' ? parsed.ts : 0;
      } catch { /* not JSON or no ts — evict first */ }
      entries.push({ key: k, ts });
    }
    // Sort: entries without timestamps first, then oldest timestamps
    entries.sort((a, b) => a.ts - b.ts);

    let freed = 0;
    for (const entry of entries) {
      if (freed >= bytesNeeded) break;
      const val = localStorage.getItem(entry.key);
      freed += entry.key.length + (val?.length ?? 0);
      localStorage.removeItem(entry.key);
    }
    return freed >= bytesNeeded;
  } catch {
    return false;
  }
}

/**
 * Safe localStorage wrapper that handles quota exceeded errors.
 * Checks available quota before writing and evicts oldest tegridy entries
 * if space is insufficient.
 */
export function safeSetItem(key: string, value: string): boolean {
  const needed = key.length + value.length;

  // Pre-flight quota check
  if (estimateRemainingQuota() < needed * 2) {
    evictOldEntries(needed * 2);
  }

  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Quota exceeded despite pre-check — attempt eviction and retry
    if (evictOldEntries(needed * 4)) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch { /* give up */ }
    }
    return false;
  }
}

/**
 * Safe localStorage.getItem — returns null on any error.
 */
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * AUDIT R080: defensive JSON.parse with explicit fallback. Returns the
 * fallback on null/empty/parse-failure rather than throwing — so a
 * tampered or schema-drifted cache entry can never bubble a SyntaxError
 * into a render path.
 *
 * Generic `T` so callers preserve their inferred shape without casting.
 */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (typeof str !== 'string' || str.length === 0) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}
