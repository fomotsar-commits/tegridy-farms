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

/** True if `key` is a Tegridy-namespaced cache entry safe to evict. */
export function isEvictable(key: string): boolean {
  for (const p of EVICTABLE_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/** Rough estimate of remaining localStorage space (returns bytes). */
function estimateRemainingQuota(): number {
  if (typeof localStorage === 'undefined') return 5_242_880;
  try {
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
  if (typeof localStorage === 'undefined') return false;
  try {
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
