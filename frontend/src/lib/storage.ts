/**
 * Audit #56: Safe localStorage utilities with quota checking and eviction.
 */

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
 * Evict the oldest tegridy_ entries to free space.
 * Entries with a JSON `ts` field are sorted oldest-first; others are evicted first.
 */
function evictOldEntries(bytesNeeded: number): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const entries: { key: string; ts: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('tegridy_')) continue;
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
 * Checks available quota before writing and evicts oldest tegridy_ entries
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
 * Safe JSON.parse — returns null on any error rather than throwing.
 * R080: callers in cache readers (useToweliPrice, usePriceHistory) used to
 * directly catch JSON.parse exceptions; centralising here so a malformed
 * cache entry can never bubble a SyntaxError into a render path.
 */
export function safeJsonParse<T = unknown>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
