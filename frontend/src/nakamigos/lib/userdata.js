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

import { supabase, CHAT_ENABLED } from "./supabase";
// F715: cloud WRITES must go through the SIWE proxy — the anon client's writes
// are rejected by RLS (wallet must equal the JWT wallet), so favorites/profile/
// watchlist silently degraded to this-device-only localStorage. proxyWrite
// attaches the cookie JWT server-side; on a signed-out user it throws needsAuth,
// caught below to keep the existing localStorage fallback (no regression).
import { proxyWrite } from "./supabaseProxy";

const SYNC_ENABLED = CHAT_ENABLED; // reuse same Supabase credentials

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

export async function saveProfile(wallet, { displayName, bio, twitter }, slug) {
  if (!wallet) return false;
  const lower = wallet.toLowerCase();

  const profile = { wallet: lower, displayName, bio, twitter };

  // Always save locally -- preserve existing cache fields like avatarUrl
  const cache = loadProfileCache(slug);
  cache[lower] = { ...cache[lower], ...profile };
  saveProfileCache(cache, slug);

  if (!SYNC_ENABLED) return true;

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
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.error("[userdata] saveProfile cloud sync skipped:", err.message);
    return false;
  }
}

// ── Favorites ────────────────────────────────────────────────────────

export async function syncFavorites(wallet, localIds, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return localIds;
  const lower = wallet.toLowerCase();

  try {
    const { data } = await supabase
      .from("user_favorites")
      .select("token_id")
      .eq("wallet", lower)
      .eq("collection_slug", collectionSlug);

    const remoteIds = (data || []).map(r => r.token_id);
    const merged = [...new Set([...localIds.map(String), ...remoteIds.map(String)])];

    // Push any local-only favorites to remote
    const localOnly = localIds.filter(id => !remoteIds.includes(id));
    if (localOnly.length > 0) {
      await proxyWrite({
        table: "user_favorites",
        method: "UPSERT",
        body: localOnly.map(id => ({ wallet: lower, token_id: String(id), collection_slug: collectionSlug })),
      });
    }

    return merged;
  } catch {
    return localIds;
  }
}

export async function addFavoriteRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return;
  try {
    await proxyWrite({ table: "user_favorites", method: "UPSERT", body: { wallet: wallet.toLowerCase(), token_id: String(tokenId), collection_slug: collectionSlug } });
  } catch { /* signed-out or sync unavailable — the local favorite is already saved */ }
}

export async function removeFavoriteRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return;
  try {
    // RLS scopes the delete to the JWT wallet, so match on token_id + collection.
    await proxyWrite({ table: "user_favorites", method: "DELETE", match: { token_id: String(tokenId), collection_slug: collectionSlug } });
  } catch { /* silent */ }
}

// ── Watchlist ────────────────────────────────────────────────────────

export async function syncWatchlist(wallet, localItems, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return localItems;
  const lower = wallet.toLowerCase();

  try {
    const { data } = await supabase
      .from("user_watchlist")
      .select("token_id, target_price, note")
      .eq("wallet", lower)
      .eq("collection_slug", collectionSlug);

    const remoteMap = new Map((data || []).map(r => [r.token_id, r]));
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

    // Push any local-only items to remote
    const localOnly = [...localMap.keys()].filter(id => !remoteMap.has(id));
    if (localOnly.length > 0) {
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
    }

    return merged;
  } catch {
    return localItems;
  }
}

export async function addWatchlistRemote(wallet, tokenId, { targetPrice, note } = {}, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return;
  try {
    await proxyWrite({ table: "user_watchlist", method: "UPSERT", body: {
      wallet: wallet.toLowerCase(),
      token_id: String(tokenId),
      target_price: targetPrice != null ? Number(targetPrice) : null,
      note: note || null,
      collection_slug: collectionSlug,
    } });
  } catch { /* silent */ }
}

export async function removeWatchlistRemote(wallet, tokenId, collectionSlug = "nakamigos") {
  if (!SYNC_ENABLED || !wallet) return;
  try {
    await proxyWrite({ table: "user_watchlist", method: "DELETE", match: { token_id: String(tokenId), collection_slug: collectionSlug } });
  } catch { /* silent */ }
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

export async function castVote(wallet, tokenId, slug) {
  if (!wallet) return false;
  const week = getCurrentWeek();
  const votesKey = `${slug || "default"}_votes`;

  if (!SYNC_ENABLED) {
    // localStorage fallback
    try {
      const votes = JSON.parse(localStorage.getItem(votesKey) || "{}");
      votes[wallet.toLowerCase()] = { tokenId, week };
      localStorage.setItem(votesKey, JSON.stringify(votes));
      return true;
    } catch { return false; }
  }

  try {
    const { error } = await supabase
      .from("votes")
      .upsert({ wallet: wallet.toLowerCase(), token_id: tokenId, week });
    return !error;
  } catch {
    return false;
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
