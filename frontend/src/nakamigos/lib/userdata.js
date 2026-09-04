/**
 * SIWE-VERIFIED RLS POLICIES
 *
 * All user data tables (user_profiles, user_favorites, user_watchlist, votes)
 * now use JWT-verified RLS policies that check the `wallet` claim from the
 * SIWE-issued JWT. See supabase/migrations/001_siwe_auth_rls.sql for the
 * secure policy definitions.
 *
 * Supabase-backed user data persistence with localStorage fallback.
 * Handles favorites, watchlist, and profiles across devices.
 *
 * --- Required Supabase tables (run in SQL editor): ---
 *
 *   CREATE TABLE user_profiles (
 *     wallet text PRIMARY KEY,
 *     display_name text CHECK (char_length(display_name) <= 32),
 *     bio text CHECK (char_length(bio) <= 160),
 *     twitter text CHECK (char_length(twitter) <= 40),
 *     avatar_url text,
 *     updated_at timestamptz DEFAULT now()
 *   );
 *
 *   ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can read profiles" ON user_profiles FOR SELECT USING (true);
 *   CREATE POLICY "Owner can upsert own profile" ON user_profiles FOR INSERT WITH CHECK (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *   CREATE POLICY "Owner can update own profile" ON user_profiles FOR UPDATE USING (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *
 *   -- MIGRATION: Drop old insecure policies if they exist:
 *   --   DROP POLICY IF EXISTS "Anyone can upsert own profile" ON user_profiles;
 *   --   DROP POLICY IF EXISTS "Anyone can update own profile" ON user_profiles;
 *
 *   CREATE TABLE user_favorites (
 *     wallet text NOT NULL,
 *     token_id text NOT NULL,
 *     collection_slug text NOT NULL DEFAULT 'nakamigos',
 *     created_at timestamptz DEFAULT now(),
 *     PRIMARY KEY (wallet, token_id, collection_slug)
 *   );
 *
 *   ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can read favorites" ON user_favorites FOR SELECT USING (true);
 *   CREATE POLICY "Owner can insert favorites" ON user_favorites FOR INSERT WITH CHECK (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *   CREATE POLICY "Owner can delete favorites" ON user_favorites FOR DELETE USING (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *
 *   -- MIGRATION: Drop old insecure policies if they exist:
 *   --   DROP POLICY IF EXISTS "Anyone can insert favorites" ON user_favorites;
 *   --   DROP POLICY IF EXISTS "Anyone can delete favorites" ON user_favorites;
 *
 *   CREATE TABLE user_watchlist (
 *     wallet text NOT NULL,
 *     token_id text NOT NULL,
 *     collection_slug text NOT NULL DEFAULT 'nakamigos',
 *     target_price numeric,
 *     note text,
 *     created_at timestamptz DEFAULT now(),
 *     PRIMARY KEY (wallet, token_id, collection_slug)
 *   );
 *
 *   ALTER TABLE user_watchlist ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can read watchlist" ON user_watchlist FOR SELECT USING (true);
 *   CREATE POLICY "Owner can insert watchlist" ON user_watchlist FOR INSERT WITH CHECK (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *   CREATE POLICY "Owner can delete watchlist" ON user_watchlist FOR DELETE USING (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *
 *   -- MIGRATION: Drop old insecure policies if they exist:
 *   --   DROP POLICY IF EXISTS "Anyone can insert watchlist" ON user_watchlist;
 *   --   DROP POLICY IF EXISTS "Anyone can delete watchlist" ON user_watchlist;
 *
 *   CREATE TABLE votes (
 *     wallet text NOT NULL,
 *     token_id text NOT NULL,
 *     week text NOT NULL,
 *     created_at timestamptz DEFAULT now(),
 *     PRIMARY KEY (wallet, week)
 *   );
 *
 *   ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can read votes" ON votes FOR SELECT USING (true);
 *   CREATE POLICY "Owner can insert votes" ON votes FOR INSERT WITH CHECK (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *   CREATE POLICY "Owner can update own vote" ON votes FOR UPDATE USING (wallet = current_setting('request.jwt.claims', true)::json->>'wallet');
 *
 *   -- MIGRATION: Drop old insecure policies if they exist:
 *   --   DROP POLICY IF EXISTS "Anyone can insert votes" ON votes;
 *   --   DROP POLICY IF EXISTS "Anyone can update own vote" ON votes;
 *
 */

// READS stay on the anon client on purpose. Migration 015 §2 (the read-side
// `Anyone can read …` policies) is a deliberately deferred product decision —
// see the migration header. Only WRITES move.
import { supabase, CHAT_ENABLED } from "./supabase";
// F715: cloud WRITES must go through the SIWE proxy — the anon client's writes
// are rejected by RLS (wallet must equal the JWT wallet), so favorites/profile/
// watchlist silently degraded to this-device-only localStorage. proxyWrite
// attaches the cookie JWT server-side; on a signed-out user it throws needsAuth,
// caught below to keep the existing localStorage fallback (no regression).
//
// The proxy takes the acting wallet from the SIWE JWT in the httpOnly cookie.
// The `wallet` field in each body below is NOT what the server trusts: it is
// compared against the JWT claim by api/_lib/proxy-schemas.js `validateBody`
// and a mismatch is a 400. Sending it is required (the row schemas mark it
// non-optional), spoofing it is not possible.
import { proxyRead, proxyWrite } from "./supabaseProxy";

const SYNC_ENABLED = CHAT_ENABLED; // reuse same Supabase credentials

// ── Sync result contract ─────────────────────────────────────────────
//
// Every mutating export below returns a discriminated result instead of a
// bare boolean (or `undefined`). A bare `false` cannot tell "the server
// REFUSED this row" apart from "nothing needed changing", which is exactly
// the failure mode migration 015 §1 arms: once the permissive `qual = true`
// write policies are DROPped, an unauthenticated or mis-scoped write is
// refused by RLS (PostgREST 403 / SQLSTATE 42501). The old `castVote`
// returned `!error` and the UI had no error path at all — a vote just
// vanished. Callers switch on `status`, or hand the result straight to
// `syncFailureToast()` for user-facing copy.
export const SYNC_STATUS = Object.freeze({
  /** The cloud write landed. */
  OK: "ok",
  /** Supabase is not configured; localStorage is the whole store. Not an error. */
  LOCAL_ONLY: "local-only",
  /** No SIWE cookie (proxy 401). The local copy is still saved. */
  NEEDS_AUTH: "needs-auth",
  /** Authenticated but refused — RLS 403 (42501), or the proxy schema said no. */
  DENIED: "denied",
  /** Transient: the request never landed, was rate-limited, or upstream 5xx'd. */
  NETWORK: "network",
});

const okResult = (status = SYNC_STATUS.OK) => ({ ok: true, status });

/**
 * Map a proxyWrite rejection onto a SYNC_STATUS. supabaseProxy sets
 * `err.needsAuth` for 401 and `err.status` for every other non-2xx; a fetch
 * that never reached the proxy at all carries neither.
 */
function classifySyncError(err) {
  if (err?.needsAuth) return SYNC_STATUS.NEEDS_AUTH;
  const status = err?.status;
  if (typeof status !== "number") return SYNC_STATUS.NETWORK; // never left the browser
  if (status === 429) return SYNC_STATUS.NETWORK;             // rate limited — retryable
  if (status >= 500) return SYNC_STATUS.NETWORK;              // proxy/upstream fault
  // 403 is the post-015 RLS refusal (PostgREST maps 42501 → 403). 400 is the
  // proxy's own schema / JWT-ownership rejection. Neither is retryable as-is.
  return SYNC_STATUS.DENIED;
}

function failResult(err, where) {
  const status = classifySyncError(err);
  if (import.meta.env.DEV) console.error(`[userdata] ${where} ${status}:`, err?.message || err);
  return { ok: false, status, error: err?.message || String(err) };
}

/**
 * User-facing copy for a failed sync, or `null` when there is nothing to say.
 * One place for the wording so every surface reports a denial the same way.
 *
 * @param {{ ok: boolean, status: string } | undefined} result
 * @param {string} what - the noun the toast talks about ("profile", "vote", …)
 * @returns {{ message: string, type: "info" | "error" } | null}
 */
export function syncFailureToast(result, what = "changes") {
  if (!result || result.ok) return null;
  switch (result.status) {
    case SYNC_STATUS.NEEDS_AUTH:
      return { message: `Saved on this device — sign in to sync your ${what} across devices.`, type: "info" };
    case SYNC_STATUS.DENIED:
      return { message: `Couldn't sync your ${what} — the server rejected the change. Sign in again, then retry.`, type: "error" };
    case SYNC_STATUS.NETWORK:
      return { message: `Couldn't reach sync — your ${what} are saved on this device only.`, type: "info" };
    default:
      return { message: `Couldn't sync your ${what}.`, type: "error" };
  }
}

// ── Profiles ────────────────────────────────────────────────────────

function profileCacheKey(slug) {
  return `${slug || "default"}_profiles`;
}

function loadProfileCache(slug) {
  try { return JSON.parse(localStorage.getItem(profileCacheKey(slug)) || "{}"); } catch { return {}; }
}

function saveProfileCache(cache, slug) {
  try { localStorage.setItem(profileCacheKey(slug), JSON.stringify(cache)); } catch { /* quota */ }
}

export async function getProfile(wallet, slug) {
  if (!wallet) return null;
  const lower = wallet.toLowerCase();

  if (!SYNC_ENABLED) {
    const cache = loadProfileCache(slug);
    return cache[lower] || null;
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("wallet", lower)
      .maybeSingle();

    if (error) {
      if (import.meta.env.DEV) console.error("[userdata] getProfile error:", error.message);
      const cache = loadProfileCache(slug);
      return cache[lower] || null;
    }
    if (!data) return null;
    const profile = {
      wallet: data.wallet,
      displayName: data.display_name,
      bio: data.bio,
      twitter: data.twitter,
      avatarUrl: data.avatar_url,
    };

    // Cache locally
    const cache = loadProfileCache(slug);
    cache[lower] = profile;
    saveProfileCache(cache, slug);

    return profile;
  } catch {
    const cache = loadProfileCache(slug);
    return cache[lower] || null;
  }
}

/**
 * Persist a profile. Always writes the local cache first, then attempts the
 * cloud upsert through the SIWE proxy.
 * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
 */
export async function saveProfile(wallet, { displayName, bio, twitter }, slug) {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  const lower = wallet.toLowerCase();

  const profile = { wallet: lower, displayName, bio, twitter };

  // Always save locally -- preserve existing cache fields like avatarUrl
  const cache = loadProfileCache(slug);
  cache[lower] = { ...cache[lower], ...profile };
  saveProfileCache(cache, slug);

  if (!SYNC_ENABLED) return okResult(SYNC_STATUS.LOCAL_ONLY);

  try {
    await proxyWrite({
      table: "user_profiles",
      method: "UPSERT",
      body: {
        wallet: lower,
        display_name: displayName || null,
        bio: bio || null,
        twitter: twitter || null,
        updated_at: new Date().toISOString(),
      },
    });
    return okResult();
  } catch (err) {
    return failResult(err, "saveProfile");
  }
}

// ── Favorites ────────────────────────────────────────────────────────

/**
 * Merge local + remote favorites and push the local-only ones back up.
 * Still returns the merged id list (unchanged contract); the outcome of the
 * PUSH — which is a real write and can be refused — is reported through the
 * optional `onPushResult` callback so a background merge stops failing mute.
 *
 * @param {(result: { ok: boolean, status: string }) => void} [onPushResult]
 */
export async function syncFavorites(wallet, localIds, collectionSlug = "nakamigos", onPushResult) {
  if (!SYNC_ENABLED || !wallet) return localIds;
  const lower = wallet.toLowerCase();

  try {
    // AUDIT FIX TF-007: read through the SIWE proxy, not the anon key. The
    // anon key carries no wallet claim, so an anon read can only be served by
    // a `USING (true)` policy — the one that also serves every OTHER wallet's
    // favourites to anyone holding the key. No SIWE session means no proven
    // wallet, which the catch below already degrades to local-only.
    const data = await proxyRead({
      table: "user_favorites",
      match: { wallet: lower, collection_slug: collectionSlug },
    });

    const remoteIds = (Array.isArray(data) ? data : []).map(r => r.token_id);
    const merged = [...new Set([...localIds.map(String), ...remoteIds.map(String)])];

    // Push any local-only favorites to remote. Its own try/catch: a refused
    // push must not discard the merge we just computed (the old single
    // try/catch threw the merged list away and returned localIds).
    const localOnly = localIds.filter(id => !remoteIds.includes(id));
    if (localOnly.length > 0) {
      try {
        await proxyWrite({
          table: "user_favorites",
          method: "UPSERT",
          body: localOnly.map(id => ({ wallet: lower, token_id: String(id), collection_slug: collectionSlug })),
        });
        onPushResult?.(okResult());
      } catch (err) {
        onPushResult?.(failResult(err, "syncFavorites push"));
      }
    }

    return merged;
  } catch {
    return localIds;
  }
}

/** @returns {Promise<{ ok: boolean, status: string, error?: string }>} */
export async function addFavoriteRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  if (!SYNC_ENABLED) return okResult(SYNC_STATUS.LOCAL_ONLY);
  try {
    await proxyWrite({ table: "user_favorites", method: "UPSERT", body: { wallet: wallet.toLowerCase(), token_id: String(tokenId), collection_slug: collectionSlug } });
    return okResult();
  } catch (err) {
    // The local favorite is already saved; the caller decides how loud to be.
    return failResult(err, "addFavoriteRemote");
  }
}

/** @returns {Promise<{ ok: boolean, status: string, error?: string }>} */
export async function removeFavoriteRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  if (!SYNC_ENABLED) return okResult(SYNC_STATUS.LOCAL_ONLY);
  try {
    // RLS scopes the delete to the JWT wallet, so match on token_id + collection.
    await proxyWrite({ table: "user_favorites", method: "DELETE", match: { token_id: String(tokenId), collection_slug: collectionSlug } });
    return okResult();
  } catch (err) {
    return failResult(err, "removeFavoriteRemote");
  }
}

// ── Watchlist ────────────────────────────────────────────────────────

/**
 * Merge local + remote watchlist and push the local-only items back up.
 * Same contract as syncFavorites: the merged array is the return value, and
 * the push outcome arrives through the optional `onPushResult` callback.
 *
 * @param {(result: { ok: boolean, status: string }) => void} [onPushResult]
 */
export async function syncWatchlist(wallet, localItems, collectionSlug = "nakamigos", onPushResult) {
  if (!SYNC_ENABLED || !wallet) return localItems;
  const lower = wallet.toLowerCase();

  try {
    // AUDIT FIX TF-004: read through the SIWE proxy, not the anon key. Of the
    // four user-owned tables this is the most sensitive — target_price and
    // note are a statement of trading intent, joinable to on-chain history by
    // the wallet column — and it was world-readable to anyone who pulled the
    // anon key out of the shipped bundle. Same reasoning as syncFavorites.
    const data = await proxyRead({
      table: "user_watchlist",
      match: { wallet: lower, collection_slug: collectionSlug },
    });

    const remoteMap = new Map((Array.isArray(data) ? data : []).map(r => [r.token_id, r]));
    const localMap = new Map(localItems.map(item => [String(item.id), item]));

    // Merge: local items take precedence, but add remote-only items
    const mergedIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
    const merged = [];
    for (const id of mergedIds) {
      const local = localMap.get(id);
      const remote = remoteMap.get(id);
      merged.push({
        id: local?.id ?? id,
        addedAt: local?.addedAt ?? Date.now(),
        targetPrice: local?.targetPrice ?? remote?.target_price ?? null,
        note: local?.note ?? remote?.note ?? "",
      });
    }

    // Push any local-only items to remote. Own try/catch — see syncFavorites.
    const localOnly = [...localMap.keys()].filter(id => !remoteMap.has(id));
    if (localOnly.length > 0) {
      try {
        await proxyWrite({
          table: "user_watchlist",
          method: "UPSERT",
          body: localOnly.map(id => {
            const item = localMap.get(id);
            return {
              wallet: lower,
              token_id: String(id),
              collection_slug: collectionSlug,
              target_price: item?.targetPrice != null ? Number(item.targetPrice) : null,
              note: item?.note || null,
            };
          }),
        });
        onPushResult?.(okResult());
      } catch (err) {
        onPushResult?.(failResult(err, "syncWatchlist push"));
      }
    }

    return merged;
  } catch {
    return localItems;
  }
}

/** @returns {Promise<{ ok: boolean, status: string, error?: string }>} */
export async function addWatchlistRemote(wallet, tokenId, { targetPrice, note } = {}, collectionSlug = "nakamigos") {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  if (!SYNC_ENABLED) return okResult(SYNC_STATUS.LOCAL_ONLY);
  try {
    await proxyWrite({ table: "user_watchlist", method: "UPSERT", body: {
      wallet: wallet.toLowerCase(),
      token_id: String(tokenId),
      target_price: targetPrice != null ? Number(targetPrice) : null,
      note: note || null,
      collection_slug: collectionSlug,
    } });
    return okResult();
  } catch (err) {
    return failResult(err, "addWatchlistRemote");
  }
}

/** @returns {Promise<{ ok: boolean, status: string, error?: string }>} */
export async function removeWatchlistRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  if (!SYNC_ENABLED) return okResult(SYNC_STATUS.LOCAL_ONLY);
  try {
    await proxyWrite({ table: "user_watchlist", method: "DELETE", match: { token_id: String(tokenId), collection_slug: collectionSlug } });
    return okResult();
  } catch (err) {
    return failResult(err, "removeWatchlistRemote");
  }
}

// ── Votes (NFT of the Week) ────────────────────────────────────────

export function getCurrentWeek() {
  const now = new Date();
  // ISO 8601 week calculation — weeks start on Monday, week 1 contains Jan 4
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1..Sun=7)
  const dayNum = d.getUTCDay() || 7; // convert Sun=0 to 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Cast (or change) this wallet's vote for the current ISO week.
 *
 * F-015: this was the last DIRECT anon-key mutation in the app. Migration 015
 * §1 DROPs `"Anyone can insert votes"` / `"Anyone can update own vote"`, and
 * the surviving owner-scoped twins compare `wallet` against the SIWE JWT — a
 * claim the anon key does not carry. The old `supabase.from("votes").upsert()`
 * would have started returning 42501 and this function returned `!error`, i.e.
 * a bare `false` that no caller could distinguish from "nothing changed".
 * Routed through the proxy (JWT from the httpOnly cookie, verified
 * server-side) and returning a discriminated result.
 *
 * NOTE: `slug` scopes only the localStorage fallback. The `votes` table has no
 * `collection_slug` column and the proxy schema does not accept one, so cloud
 * votes remain collection-agnostic (pre-existing; see plan g13). Nothing here
 * widens the server allowlist.
 *
 * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
 */
export async function castVote(wallet, tokenId, slug) {
  if (!wallet) return { ok: false, status: SYNC_STATUS.NEEDS_AUTH, error: "no wallet" };
  const week = getCurrentWeek();
  const votesKey = `${slug || "default"}_votes`;

  if (!SYNC_ENABLED) {
    // localStorage fallback — unchanged shape so getUserVote/getWeekVotes
    // keep reading it exactly as before.
    try {
      const votes = JSON.parse(localStorage.getItem(votesKey) || "{}");
      votes[wallet.toLowerCase()] = { tokenId, week };
      localStorage.setItem(votesKey, JSON.stringify(votes));
      return okResult(SYNC_STATUS.LOCAL_ONLY);
    } catch (err) {
      return { ok: false, status: SYNC_STATUS.NETWORK, error: err?.message || "localStorage unavailable" };
    }
  }

  try {
    await proxyWrite({
      table: "votes",
      method: "UPSERT",
      // String(): the proxy schema is z.string().max(64); a numeric tokenId
      // (the gallery passes numbers) would be rejected as "Invalid payload
      // shape". Mirrors the coercion used everywhere else in this file.
      body: { wallet: wallet.toLowerCase(), token_id: String(tokenId), week },
    });
    return okResult();
  } catch (err) {
    return failResult(err, "castVote");
  }
}

export async function getWeekVotes(week, slug) {
  if (!week) week = getCurrentWeek();
  const votesKey = `${slug || "default"}_votes`;

  if (!SYNC_ENABLED) {
    try {
      const votes = JSON.parse(localStorage.getItem(votesKey) || "{}");
      const weekVotes = {};
      for (const [, v] of Object.entries(votes)) {
        if (v.week === week) {
          weekVotes[v.tokenId] = (weekVotes[v.tokenId] || 0) + 1;
        }
      }
      return weekVotes;
    } catch { return {}; }
  }

  try {
    const { data } = await supabase
      .from("votes")
      .select("token_id")
      .eq("week", week);

    const tally = {};
    for (const row of (data || [])) {
      tally[row.token_id] = (tally[row.token_id] || 0) + 1;
    }
    return tally;
  } catch {
    return {};
  }
}

export async function getUserVote(wallet, week, slug) {
  if (!wallet) return null;
  if (!week) week = getCurrentWeek();
  const votesKey = `${slug || "default"}_votes`;

  if (!SYNC_ENABLED) {
    try {
      const votes = JSON.parse(localStorage.getItem(votesKey) || "{}");
      const v = votes[wallet.toLowerCase()];
      return v?.week === week ? v.tokenId : null;
    } catch { return null; }
  }

  try {
    const { data, error } = await supabase
      .from("votes")
      .select("token_id")
      .eq("wallet", wallet.toLowerCase())
      .eq("week", week)
      .maybeSingle();
    if (error) {
      if (import.meta.env.DEV) console.error("[userdata] getUserVote error:", error.message);
      return null;
    }
    return data?.token_id || null;
  } catch {
    return null;
  }
}
