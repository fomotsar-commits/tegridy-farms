# Remediation Plan — g13_naka_analytics_social

Surface: Nakamigos analytics / whales / portfolio + chat / DMs / alerts / profile (Supabase / SIWE).
Branch: `mvp-launch` @ HEAD. All findings opened and confirmed against real source. Paths are absolute.

Verification note: several `live:` findings were captured against **stale prod** and are already fixed at HEAD (T1) — those are `redeploy-only`. Several `code:` findings cite line/behaviour that has since drifted (e.g. the hardcoded llamarpc in F725 is now `getReadProvider`); those are split into the still-valid vs already-fixed parts. The big chat/userdata cluster (F711–F716, F735) is real and load-bearing.

---

## BATCH supabase-write-proxy-port  (F711, F712, F714, F715, F716, F735)

**Why one batch:** every one of these is the same root cause (**T3/T5/standalone** — writes go through the bare anon `supabase` client which the JWT-gated RLS from migrations 001/004/006/007 rejects). The single underlying fix is "route writes through `/api/supabase-proxy` (or `/api/orderbook`) behind SIWE, and read the boolean/error result instead of faking success." `lib/dm.js` is the canonical `proxyCall` pattern to copy. The proxy already allowlists `messages`/`user_profiles`/`user_favorites`/`user_watchlist`/`votes` (`api/supabase-proxy.js:53`) and validates author/wallet against the JWT (`api/_lib/proxy-schemas.js`). These should land together because they share the new proxy plumbing and the SIWE gate, and because fixing them piecemeal leaves half the social layer silently localStorage-only.

### F711 — Chat posting writes with the anon client the RLS rejects (sending fails for everyone in live mode)
- verdict: **fix-now** · rootCause: **standalone** (shared cause with this batch) · severity: critical
- Confirmed: `lib/supabase.js:216-218` does a direct `supabase.from("messages").insert(...)`; migration `004_security_hardening.sql:97-102` requires `lower(author)=lower(jwt->>'wallet')`, which the anon JWT can't satisfy → insert rejected → `sendMessage` returns null → `CommunityChat.jsx:531` shows the generic connection error. The proxy already accepts a `messages` INSERT (`proxy-schemas.js:106-107`).
- approach: Add a `sendMessageViaProxy` path in `lib/supabase.js` that uses the `proxyCall` pattern from `lib/dm.js:22-41` (`POST /api/supabase-proxy`, `{ table:"messages", method:"INSERT", body:{author,text,token_id,slug} }`, `credentials:"include"`). In `CommunityChat.jsx:516-532`, call it; surface a 401/`needsAuth` as a "Sign in to chat" state (reuse the DirectMessages `needs-auth` gate at `DirectMessages.jsx:331-350` + `useSiweAuth`) rather than the generic error. Keep the existing localStorage fallback for `!CHAT_ENABLED`. Do not remove the composer or any chat UI — additive gate only.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\supabase.js:190-227`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx:498-549`
- effort: M · risk: med (touches the live chat write path) · test: add a unit test mocking `fetch` to assert `sendMessage` posts to `/api/supabase-proxy` with the right body; manual: sign in, send a message in prod-mode, confirm it persists across reload; sign out, confirm the "sign in to chat" gate.
- deps: [] · batchHint: `supabase-write-proxy-port`

### F712 — Like button is a silent no-op in live mode (toggle_like needs a JWT wallet claim the anon client can't supply)
- verdict: **fix-now** · rootCause: **standalone** (this batch) · severity: high
- Confirmed: `lib/supabase.js:255-257` calls `supabase.rpc("toggle_like", ...)` with the anon key; migration `006_audit_2026_05_26.sql:46-48` raises `Unauthorized` when the JWT wallet claim is null. `CommunityChat.jsx:559-565` has no else branch → heart does nothing. **Note:** the proxy currently forwards table writes only (`INSERT/UPDATE/DELETE/UPSERT/SELECT`) and has **no RPC path**, so this needs a small proxy extension.
- approach: Extend `api/supabase-proxy.js` with an `RPC` method branch (allowlist `toggle_like`/`toggle_reaction`, forward `POST /rest/v1/rpc/<fn>` with the cookie JWT as `Authorization`, same stage-2 wallet rate-limit + body validation). Route `toggleLike` in `lib/supabase.js` through it. On failure in `CommunityChat.handleLike` (`:559-565`), toast "Sign in to like" (mirror `handleReaction`'s failure toast at `CommunityChat.jsx:443-444`). Keep optimistic update + reconcile.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\api\supabase-proxy.js:139-144,287-325`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\supabase.js:234-267`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx:551-584`
- effort: M · risk: med (new server RPC surface — keep the fn allowlist tight) · test: proxy unit test that an un-allowlisted rpc name 400s and `toggle_like` forwards with `Authorization: Bearer <cookie>`; manual: signed-in like persists, signed-out shows the toast.
- deps: [F713] (share the RPC proxy branch) · batchHint: `supabase-write-proxy-port`

### F713 — toggle_reaction RPC has no JWT ownership check (anyone with the public anon key can react as ANY wallet)
- verdict: **fix-now** · rootCause: **standalone** (security) · severity: high
- Confirmed: `007_p2p_trades_and_chat.sql:119-149` defines `toggle_reaction` as `SECURITY DEFINER` validating only the emoji allowlist + `w !~ '^0x[0-9a-f]{40}$'` — unlike `toggle_like` (`006:46-59`) it never compares against `request.jwt.claims`. `008_grant_new_table_roles.sql:20` grants EXECUTE to anon. So reactions are both the only chat write that works from the anon client AND spoofable for any victim wallet.
- approach: New migration `010_*.sql` doing `CREATE OR REPLACE FUNCTION toggle_reaction` with the same JWT-derive-and-compare block as `toggle_like` (`006:45-60`): pull `lower(jwt->>'wallet')`, raise on null, ignore/require-match the `wallet` arg. Then route the call through the RPC proxy branch from F712. This is a migration (operator must apply) + a frontend route change.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\supabase\migrations\010_toggle_reaction_jwt_check.sql` (new), `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\supabase.js:278-303`
- effort: M · risk: med (changes a live RPC; old clients passing a wallet arg must still match) · test: SQL test that calling with a mismatched wallet raises; manual: react signed-in works, reacting as another wallet from devtools 401s.
- deps: [] · batchHint: `supabase-write-proxy-port` (frontend route) + operator applies the migration

### F714 — Entire userdata cloud-sync layer is dead in prod (writes AND favorites/watchlist reads go through the RLS-rejecting anon client)
- verdict: **fix-now** · rootCause: **standalone** (this batch) · severity: high
- Confirmed: every write in `lib/userdata.js` uses the bare anon client (`saveProfile :161-169`, `syncFavorites push :197-199`, `addFavoriteRemote :211`, `removeFavoriteRemote :218`, `syncWatchlist push :255-266`, `addWatchlistRemote :278`, `removeWatchlistRemote :291`, `castVote :325-327`). Migration `004:120-165` makes all of these require the JWT wallet AND replaced the public favorites/watchlist SELECT with owner-only (`004:157-165`) — so `syncFavorites`' read (`userdata.js:185-189`) silently returns zero rows. The header at `userdata.js:9-10` ("across devices") is false at runtime.
- approach: Port all `userdata.js` writes to `proxyCall` (`lib/dm.js` pattern) using `{table:"user_profiles"|"user_favorites"|"user_watchlist"|"votes", method:"UPSERT"|"DELETE", body, match}` — the proxy already allowlists + validates these (`proxy-schemas.js:37-64,109-127`). Gate on `useSiweAuth.isAuthenticated`; when not signed in, keep the localStorage path and don't claim sync. For reads, either read favorites/watchlist through the proxy SELECT (would need the proxy `SELECT_TABLES` extended to those tables) or restore a public SELECT policy in a migration — prefer the proxy SELECT to keep RLS owner-scoped. Until ported, drop "across devices" copy.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\userdata.js:147-332`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\api\supabase-proxy.js:59` (SELECT_TABLES if reading via proxy)
- effort: L · risk: med · test: unit-test each ported fn posts to the proxy; manual signed-in round-trip on a second browser to prove cross-device; signed-out still works locally.
- deps: [F715] (saveProfile result is consumed by EditProfile) · batchHint: `supabase-write-proxy-port`

### F715 — "Profile saved" success toast fires even when the cloud write was rejected
- verdict: **fix-now** · rootCause: **T5** (write didn't persist but UI claims success) · severity: high
- Confirmed: `EditProfile.jsx:92-99` `await saveProfile(...)` then unconditionally `addToast("Profile saved","success")`. `saveProfile` returns `false` on Supabase error (`userdata.js:171-175`) and never throws, so the catch (`EditProfile.jsx:100`) never runs.
- approach: Capture the boolean: `const ok = await saveProfile(...)`. On `true` toast "Profile saved"; on `false` toast "Saved locally — sign in to sync your profile" (info). Pairs naturally with the F714 proxy port (after which `true` means real sync).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\EditProfile.jsx:88-106`
- effort: S · risk: low · test: mock `saveProfile` to resolve false, assert the local-save toast; resolve true, assert the success toast.
- deps: [F714] · batchHint: `supabase-write-proxy-port`

### F716 — NftCompare uses the legacy userdata trade path that migration 007 revoked (trades become localStorage ghosts the counterparty never sees)
- verdict: **fix-now** · rootCause: **standalone** (this batch) · severity: high
- Confirmed: `NftCompare.jsx:8` imports `{createTradeOffer, getIncomingTrades, updateTradeStatus}` from `lib/userdata`; calls at `:424` and `:457`. Migration `007:47-54` drops client trade_offers write policies → service-role-only via `/api/orderbook`. `userdata.js:436-461` silently falls back to a local "pending" trade. The correct Seaport-settled path is `lib/trades.js` (used by TradeWindow/TradesPanel).
- approach: Point NftCompare's create/accept flow at `lib/trades.js` (`createTradeOffer`/`fetchTrades`/`updateTradeStatus` → `/api/orderbook`). NftCompare already builds the Seaport order locally (`:410-420`) so it can hand the signed params to the orderbook path. Then delete the dead `createTradeOffer`/`getIncomingTrades`/`getOutgoingTrades`/`updateTradeStatus` + trades-cache helpers from `userdata.js:397-546`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NftCompare.jsx:8,422-463`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\userdata.js:397-546`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\trades.js`
- effort: L · risk: med (trade settlement path — verify the orderbook payload matches what TradeWindow sends) · test: extend `trades.test.js`; manual: create a P2P offer from Compare and confirm it appears in TradesPanel for the counterparty.
- deps: [] · batchHint: `supabase-write-proxy-port`

### F735 — Supabase votes are global across collections while the local fallback is slug-scoped (and the write is RLS-dead)
- verdict: **fix-now** · rootCause: **T3** (schema drift) · severity: low
- Confirmed: `userdata.js:325-327` `castVote` upserts `{wallet, token_id, week}` with no collection column (PK `wallet,week`); `getWeekVotes :352-355` selects by week only. The local fallback is keyed `${slug}_votes` (`:312-321`). Voting in one collection clobbers another.
- approach: Migration adds `collection_slug` + composite PK `(wallet, week, collection_slug)` to `votes`; extend the proxy `votes` schema (`proxy-schemas.js:60-64`) with `collection_slug`; pass `slug` through `castVote`/`getWeekVotes`/`getUserVote`. Route the write via the proxy (rides on F714). Low priority — votes UI is niche.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\supabase\migrations\011_votes_collection_scope.sql` (new), `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\api\_lib\proxy-schemas.js:60-64`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\userdata.js:309-365`
- effort: M · risk: low · test: vote in two collections in the same week, assert tallies stay separate.
- deps: [F714] · batchHint: `supabase-write-proxy-port`

---

## BATCH dm-polling-and-auth  (F717, F718, F740, F737, F746)

**Why one batch:** all live in `DirectMessages.jsx` / `useSiweAuth.js` / `lib/dm.js` and are small, independent DM-pane hardening fixes that touch the same files.

### F717 — DM poll budget + the first 429 misclassified as "DMs aren't enabled yet"
- verdict: **fix-now** · rootCause: **T8** (poller) · severity: high
- Confirmed (partially mitigated at HEAD): the 15s poll already gates `!document.hidden` (`DirectMessages.jsx:220`). Still real: `loadThread` calls `markThreadRead` **unconditionally** every tick (`:196`), even with nothing unread (a PATCH each cycle, `dm.js:137-146`); and `classify` (`:169-175`) maps any `status < 500` → `"not-enabled"`, so a 429 replaces the pane with the migration-007-off copy (`:352-360`).
- approach: (1) In `loadThread`, only call `markThreadRead` when the thread actually has unread for me (`msgs.some(m => m.recipient===me && !m.readAt)`). (2) Add an explicit 429 branch in `classify` returning a new transient/retry state (reuse the existing `"error"` retry UI at `:362-372`, or add a "Slow down — retrying" state) instead of `"not-enabled"`. (3) Optional: lengthen the convo-list cadence while a thread is open, or merge the two SELECTs.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx:169-200,217-222,352-373`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\dm.js:137-146`
- effort: M · risk: med (changes the read-receipt + error UX) · test: mock a 429 from `proxyCall`, assert the pane shows the transient state not "not-enabled"; assert `markThreadRead` is skipped when nothing is unread.
- deps: [] · batchHint: `dm-polling-and-auth`

### F718 — Sign-in button throws an unhandled rejection when the user rejects the wallet signature
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `DirectMessages.jsx:341-344` `onClick={async () => { const ok = await signIn(); ... }}` with no try/catch; `useSiweAuth.signIn` throws `"Sign-in cancelled"` on 4001/ACTION_REJECTED (`useSiweAuth.js:122-126`). Header already does this correctly (`Header.jsx:296-304`) — copy that.
- approach: Wrap the onClick in try/catch and `addToast(err.message, "info"/"error")`. Mirror `Header.handleSignIn`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx:337-348`
- effort: S · risk: low · test: mock `signIn` to reject with `Sign-in cancelled`, assert a toast and no console rejection.
- deps: [] · batchHint: `dm-polling-and-auth`

### F740 — isAuthenticated never flips when the token expires while the page stays open
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `useSiweAuth.js:139-142` `useMemo(() => isSessionValid && !!authenticatedWallet && !isTokenExpired(), [isSessionValid, authenticatedWallet])` — `isTokenExpired()` reads localStorage but the memo only recomputes on those two deps, so mid-visit expiry still reads authenticated.
- approach: Add a state tick that re-evaluates expiry — a `setInterval`/`setTimeout` scheduled to the token's expiry (or a `visibilitychange` listener that re-checks) that flips `isSessionValid` false when `isTokenExpired()`. Include the tick in the memo deps.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useSiweAuth.js:24-30,139-142`
- effort: S · risk: low · test: stub `isTokenExpired` to flip true after a tick; assert `isAuthenticated` becomes false without a remount.
- deps: [] · batchHint: `dm-polling-and-auth`

### F737 — New-DM input only accepts raw 0x addresses — no ENS resolution despite useEns being loaded
- verdict: **fix-now** · rootCause: **standalone** (overlaps F753 ENS-input theme) · severity: low
- Confirmed: `DirectMessages.jsx:389/398` gate on `/^0x[a-fA-F0-9]{40}$/`; the component already imports `useEns` (`:4,:160`). Typing `vitalik.eth` can never open a thread.
- approach: On Open/Enter, if the input ends in `.eth`, resolve via `resolveEns` from `hooks/useEns.jsx` (already exported, dedups + caches) before `setPeer`. Show a brief "Resolving…" then open the thread or toast "Couldn't resolve that ENS name."
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx:385-403`
- effort: M · risk: low · test: mock `resolveEns("vitalik.eth")` → address, assert the thread opens to that peer.
- deps: [] · batchHint: `dm-polling-and-auth`

### F746 — Optimistic-send reconciliation matches on text+sender (dup texts can drop a bubble); trade-attach banner reads a ref during render
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed: `DirectMessages.jsx:194` filters pending by `m.text === p.text && m.sender===me` — two identical texts collapse one optimistic bubble. `:602` `{pendingTradeRef.current && (...)}` renders from a ref; it only re-renders because `handleSend`'s `setText` happens to.
- approach: Give each optimistic send a client id and echo it back: include a `client_id` in the proxy body / reconcile by timestamp window instead of text equality (the `key` already exists at `:264`). Mirror `pendingTradeRef` into a `pendingTrade` state so the banner re-renders deterministically.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx:159,188-200,246-277,602-606`
- effort: M · risk: low · test: send the same text twice quickly, assert both bubbles persist after the poll reconciles.
- deps: [] · batchHint: `dm-polling-and-auth`

---

## BATCH activity-sale-filter-and-sort  (F719, F720, F733, F743)

**Why one batch:** all are the merged-activity feed in `useCollection.js` + `Analytics.jsx` + `CollectionHealth.jsx` + `ActivityFeed.jsx`. The shared fix is "treat the merged stream as mixed event types: filter to `type==="sale"` for sale/volume math, sort by time desc, and map the live event-type labels." `ActivityFeed.jsx:186-194` already does the correct `type==="sale"` filter — reuse that convention.

### F719 — "Recent Sales" / "24H VOLUME" math counts live listing/bid prices as sales
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `useCollection.js:29-31` flattens `openSea.listings/sales/bids/cancellations` into `activities`; listings & bids carry `price>0` (`eventFeed.js:85-92`). `Analytics.jsx:131,143` filter `a.price>0` (not type) feeding AVG/HIGHEST/LOWEST/SALES COUNT (`:133-138`). `CollectionHealth.jsx:158` recentSales filters by time only, `:167` floorMetrics by `price>0`, `:199` dayVol labeled "24H VOLUME". Contrast `ActivityFeed.jsx:186-194` which correctly filters `type==="sale"`.
- approach: Add `a.type === "sale"` to the price filters in `Analytics.activityStats`/`priceDistribution` and `CollectionHealth.recentSales`/`floorMetrics`/`volumeMetrics`. One-line predicate change per memo.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Analytics.jsx:131,143`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CollectionHealth.jsx:156-199`
- effort: S · risk: low · test: feed a mixed activities array (1 sale + 2 listings), assert SALES COUNT=1 and 24H VOLUME excludes the listings.
- deps: [] · batchHint: `activity-sale-filter-and-sort`

### F720 — Feed not chronologically ordered when live events are present (two merge points skip sorting)
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `useCollection.js:112` `return [...newLive, ...activities].slice(0,500)` prepends without sorting; `ActivityFeed.jsx:124-141` `mergeBase()` concatenates and only sorts when `tradeEvents.length>0` (`:119-121`).
- approach: Sort the merged list `by (b.time||0)-(a.time||0)` in `mergeBase` (always), and in `useCollection.mergedActivities` after the prepend. `mergeEventStreams` (`eventFeed.js:168-183`) already sorts — reuse it where convenient.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useCollection.js:94-113`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\ActivityFeed.jsx:118-142`
- effort: S · risk: low · test: merge a 30-min-old live transfer with a 1-min-old fetched sale, assert the sale renders first.
- deps: [] · batchHint: `activity-sale-filter-and-sort`

### F733 — Live OpenSea stream events render uncolored raw type badges ("listing"/"cancellation" not in the label map)
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `eventFeed.js:61-66` normalizes to `listing`/`bid`/`cancellation`; the label/color maps key on `ask` not `listing` in `ActivityFeed.jsx:8-23`, `OnChainProfile.jsx:10-24`, `WhaleIntelligence.jsx` (`tx.type==="ask"` never matches). A live listing falls through to `#666` + raw "listing".
- approach: Add `listing` and `cancellation` keys to `EVENT_LABELS`/`EVENT_COLORS` in all three files (`listing → "Listed"/yellow`, `cancellation → "Cancelled"/dim`). Keep the existing `ask` alias for the polled feed. One-line-per-map additions.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\ActivityFeed.jsx:8-23`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\OnChainProfile.jsx:10-24`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WhaleIntelligence.jsx:1028-1032`
- effort: S · risk: low · test: render a `listing` event, assert a yellow "Listed" chip.
- deps: [] · batchHint: `activity-sale-filter-and-sort`

### F743 — Live rows keyed by array index; stat-window labels imply 24h/7d/30d but reflect a 50-event page
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed: `ActivityFeed.jsx:368` `key={a.hash ? \`${a.hash}-${i}\` : i}` — index in the key defeats reconciliation as live rows prepend (re-mount + replayed entrance). Stats source is the fetched page labeled by the chosen range.
- approach: Key by `${a.hash}-${a.token?.id}` (the dedup key already used at `useCollection.js:101`); caption header stats with "last N events" when not full-range.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\ActivityFeed.jsx:186-194,368`
- effort: S · risk: low · test: prepend a live row, assert existing rows don't replay their entrance animation.
- deps: [] · batchHint: `activity-sale-filter-and-sort`

---

## BATCH alerts-engine-consolidation  (F721, F726, F730, F741, F742, F747, F748, F780)

**Why one batch:** all are the three overlapping always-on alert pollers (`usePriceAlerts`, `useSmartAlerts`, WhaleIntelligence) and the NotificationCenter that surfaces them. The shared fix is "one alert engine in context, visibility-gated, one stats poller, with the user config actually honored." Doing these together avoids re-touching the same hooks three times.

### F721 — usePriceAlerts instantiated twice (App + panel) → duplicate 30s pollers and duplicate toasts/notifications
- verdict: **fix-now** · rootCause: **T8** · severity: medium
- Confirmed: `App.jsx:566` `usePriceAlerts(nfts.allTokens, addToast)` AND `PriceAlerts.jsx:415` inside `PriceAlertPanel` (mounted at `App.jsx:653`). Each has its own `fetchFloor` interval (`PriceAlerts.jsx:58-71`) and its own `checkAlerts` firing `new Notification` + `addToast`. `useSmartAlerts` (`App.jsx:569`) is a third 30s poller.
- approach: Lift `usePriceAlerts` into a context provider (single engine), consume it in `PriceAlertPanel` via props/context — mirror how `useSmartAlerts` feeds `NotificationCenter` through the `notificationCenter` prop. Remove the in-panel hook instance.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.jsx:566,653`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PriceAlerts.jsx:406-416`
- effort: M · risk: med (single engine — verify the panel still reads/writes alerts) · test: open the alerts tab and watch network — assert one `fetchCollectionStats` cadence, and an alert fires one toast not two.
- deps: [] · batchHint: `alerts-engine-consolidation`

### F726 — Three always-on 30s pollers ignore document.hidden; WhaleIntelligence re-pulls the full owner list every 30s
- verdict: **fix-now** · rootCause: **T8** (prod rate-limiter risk) · severity: medium
- Confirmed: `useSmartAlerts.js:329` `setInterval(check, ...)` with no visibility check; `PriceAlerts.jsx:69` same; `WhaleIntelligence.jsx:226-229` polls `fetchTopHolders+fetchActivity` every `REFRESH_MS=30000` with no gate — `fetchTopHolders` calls `getOwnersForContract withTokenBalances` (`api.js:562-565`) returning the whole owner set each time. Contrast `useActivityWebSocket.js:179` / `useOpenSeaStream.js:239` / `useDmUnread.js:32` which gate on `!document.hidden`.
- approach: Wrap each `setInterval` callback in `if (document.hidden) return;` (or skip scheduling while hidden). Share one `fetchCollectionStats` poller between usePriceAlerts and useSmartAlerts (rides on the F721 consolidation). Lengthen the WhaleIntelligence holders refresh (owner sets don't move at 30s) and/or only re-pull activity at 30s, holders at a few minutes.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useSmartAlerts.js:328-330`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PriceAlerts.jsx:68-70`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WhaleIntelligence.jsx:222-234`
- effort: M · risk: low · test: hide the tab (`document.hidden=true` in a test), assert no fetch fires on the next interval tick.
- deps: [F721] · batchHint: `alerts-engine-consolidation`

### F730 — "Normal rate" alert setting is dead — the engine ignores config.listingRate.normalRate
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `NotificationCenter.jsx:111` exposes `SettingInput label="Normal rate"` writing `config.listingRate.normalRate`, but `useSmartAlerts.js:293` computes `const normalRate = Math.max(1, Math.round((collection.supply||10000)/2500))` and never reads the user value.
- approach: `const normalRate = cfg.listingRate.normalRate ?? Math.max(1, Math.round((collection.supply||10000)/2500));`
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useSmartAlerts.js:293`
- effort: S · risk: low · test: set normalRate=10 in config, assert the listing-surge multiplier uses 10.
- deps: [] · batchHint: `alerts-engine-consolidation`

### F741 — Quiet hours drop alerts entirely — they never reach the notification history
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `useSmartAlerts.js:129-130` `if (isInQuietHours(config.quietHours)) return;` exits before the history append (`:145`), so quiet-hours events are unrecoverable.
- approach: Move the quiet-hours check to only suppress the toast/push (`:148-159`), not the `setHistory` append (`:145`). Append with `read:false` so it shows in history.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useSmartAlerts.js:123-160`
- effort: S · risk: low · test: stub `isInQuietHours`→true, fire an alert, assert history length grows but `addToast`/`sendLocalNotification` are not called.
- deps: [] · batchHint: `alerts-engine-consolidation`

### F742 — Browser notification uses bare new Notification() which throws on Android Chrome
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed: `PriceAlerts.jsx:148` `new Notification(...)` in try/catch (silently dropped on mobile). `lib/notifications.js:165-179` `sendLocalNotification` uses `registration.showNotification(...)` which works on Android.
- approach: Replace the `new Notification` call with `sendLocalNotification(title, body)` from `lib/notifications.js` (already used by useSmartAlerts at `:154`).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PriceAlerts.jsx:143-152`
- effort: S · risk: low · test: assert `sendLocalNotification` is called when an alert triggers with permission granted.
- deps: [] · batchHint: `alerts-engine-consolidation`

### F747 — True background alert delivery (floor/whale/listing pushes are client-side-poll only)
- verdict: **product-decision** · rootCause: **standalone** (missing-feature) · severity: low
- Confirmed in spirit: smart alerts only fire while the tab is open (client 30s polling); the `push_subscriptions` + VAPID infra exists (`lib/notifications.js`) but only trade alerts use it server-side.
- approach: Server-side floor/whale/listing watchers + web-push is a backend build (cron/edge fn querying the indexer + sending VAPID pushes to `push_subscriptions`). Needs an owner decision on cost/scope and depends on the indexer (operator pending task). Document as a roadmap item; no inline code now.
- files: (design) — would touch `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\api\` + a cron + `push_subscriptions`
- effort: L · risk: med · test: n/a until scoped.
- deps: [] · batchHint: `alerts-engine-consolidation`

### F748 — Watchlist target prices don't actually alert (copy says "set price alerts" but the target only paints a badge)
- verdict: **fix-now** · rootCause: **standalone** (missing wiring) · severity: low
- Confirmed: `Watchlist.jsx:127` subtitle "Track … and set price alerts"; the `targetPrice` only drives a `belowTarget` badge (`:175,:212`) and is never fed to `usePriceAlerts`/history/push.
- approach: When a watchlist `targetPrice` is set, register a corresponding price alert through the (now single) usePriceAlerts engine so it flows into notification history/push — additively, keeping the in-card badge. Until wired, soften the subtitle to "Track … and set target prices."
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Watchlist.jsx:100-112,127`
- effort: M · risk: low · test: set a target below floor, assert a price alert is registered and fires via the engine.
- deps: [F721] · batchHint: `alerts-engine-consolidation`

### F780 — Empty-state microcopy "No notifications in price" / "in whale" is awkward
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed: `NotificationCenter.jsx:384` `No notifications{activeTab !== "all" ? \` in ${activeTab}\` : ""}`.
- approach: Per-tab copy map, e.g. `price → "No price alerts yet — set thresholds in settings"`, `whale → "No whale alerts yet"`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NotificationCenter.jsx:381-385`
- effort: S · risk: low · test: switch to the Price tab empty, assert the new copy.
- deps: [] · batchHint: `alerts-engine-consolidation`

---

## BATCH portfolio-pnl-honesty  (F722, F723, F724, F729, F731, F732)

**Why one batch:** all live in `lib/portfolio.js` + `PortfolioTracker.jsx` + `OnChainProfile.jsx` and are P&L/holdings honesty fixes. F724 spans three callers (one shared error-state pattern).

### F722 — "GAS SPENT" stat is a hardcoded 0.003 ETH-per-token fiction presented as data
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `portfolio.js:175` `const GAS_ESTIMATE = 0.003;` and `:188` adds it for **every** held token (including mints/airdrops where `isMint:true`). Rendered as a primary red "GAS SPENT" with no qualifier (`PortfolioTracker.jsx:336-340`). At sub-gwei gas this is ~10–30× high.
- approach: Minimal honest fix: only charge gas for tokens with a real purchase record (`purchase` truthy, not mints), and relabel the stat "GAS (est.)" with a tooltip. Better: derive from the live gas price × a typical fulfillment gas; best (L): fetch real `gasUsed*effectiveGasPrice` from Alchemy receipts for the acquisition txs.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\portfolio.js:175,186-188`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PortfolioTracker.jsx:335-340`
- effort: M · risk: low · test: a held set of 2 buys + 1 mint, assert gas is charged for 2 not 3 and the label reads "est."
- deps: [] · batchHint: `portfolio-pnl-honesty`

### F723 — Realized P&L FIFO can pair a sale with a later buy; unmatched sells count full proceeds as profit
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `portfolio.js:216-229` matches `sortedBuys.find(s => tokenId===tid && !matched)` with **no** `buy.blockNumber < sale.blockNumber` constraint; when buy history is truncated (limit 100, `:136`), `buyPrice=0` → `realizedPnL += sellPrice-0`. `saleToEth` (`:47-53`) assumes 18-decimal ETH for every fee token (a USDC sale would be wildly wrong).
- approach: Constrain the match to `s.blockNumber < sale.blockNumber`; when no match, mark the sell "cost basis unknown" (exclude from realized P&L or flag it) instead of treating proceeds as pure profit. In `saleToEth`, check the fee token symbol/decimals and skip/convert non-ETH/WETH denominations.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\portfolio.js:47-53,204-230`
- effort: M · risk: med (P&L numbers change) · test: sell-then-rebuy the same token, assert the earlier buy is used; a sell with no prior buy is flagged not counted as full profit.
- deps: [] · batchHint: `portfolio-pnl-honesty`

### F724 — API outage renders as "this wallet holds 0 NFTs" — fetchWalletNfts' error field ignored by every caller
- verdict: **fix-now** · rootCause: **T11** (loading-vs-empty conflation) · severity: medium
- Confirmed: `api.js:610-613` returns `{tokens:[], totalCount:0, error:"Could not load…"}` on failure. `OnChainProfile.jsx:128-132` sets tokens/totalCount without reading `.error` → shows "does not hold any …" + "Observer" badge (`:501-503`); `WhaleIntelligence.toggleHolder` shows "No … held"; `PortfolioTracker.jsx:161-168` shows "No … Found" (`:278`).
- approach: One shared pattern: in each caller, if `data.error` is set, render a retryable error state (PortfolioTracker already has an `error`+Retry block at `:254-265` — reuse it) instead of the confident zero-holdings claim. Add an analogous error branch to OnChainProfile's badge/grid and WhaleIntelligence's expanded-holder view.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\OnChainProfile.jsx:122-138,498-503`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WhaleIntelligence.jsx:236-255`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PortfolioTracker.jsx:150-168`
- effort: M · risk: low · test: mock `fetchWalletNfts` to return `{error}`, assert each surface shows a retry state not "0 NFTs".
- deps: [] · batchHint: `portfolio-pnl-honesty`

### F729 — "Diamond Hands" claims unsupported by data; health "never sold" looks at only ~50 events
- verdict: **fix-now** · rootCause: **T4** (overstated claim) · severity: low
- Confirmed: `OnChainProfile.jsx:496` grants "Diamond Hands" on `isWhale` (`totalCount>=10`) alone — no hold-duration input. `CollectionHealth.jsx:262-269` computes `sellers` from the 50-event merged feed yet renders "{count} never sold" (`:493`).
- approach: Either gate the badge on real hold time (acquisition timestamps already exist via `lib/portfolio.js` `holdDays`) or relabel it "Whale". Relabel the health copy "no sells in recent activity" to match the 50-event window.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\OnChainProfile.jsx:496`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CollectionHealth.jsx:262-269,493`
- effort: S · risk: low · test: visual — a whale with recent sells no longer shows Diamond Hands (or the label changes); health copy reads "recent activity".
- deps: [] · batchHint: `portfolio-pnl-honesty`

### F731 — Top gainers/losers overlap when <6 tokens have cost basis
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `PortfolioTracker.jsx:204-210` one sorted array, `topGainers: sorted.slice(0,3)`, `topLosers: sorted.slice(-3).reverse()` — with 1–3 priced tokens the slices overlap and losers can render positive `pnlPercent` under the red header (`:558-569`).
- approach: Filter gainers to `pnlPercent>0` and losers to `pnlPercent<0` before slicing.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PortfolioTracker.jsx:202-211`
- effort: S · risk: low · test: a 2-token positive portfolio, assert TOP LOSERS is empty (not showing a +%).
- deps: [] · batchHint: `portfolio-pnl-honesty`

### F732 — Refresh button is a no-op for up to 5 minutes (calculatePnL serves its localStorage cache)
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `portfolio.js:122-125` returns the cache when present (TTL 5min, `:11`); the cached object bakes in floorPrice/currentValue. `PortfolioTracker.jsx:299-309` "Refresh" → `loadPortfolio` → `calculatePnL` → cache hit.
- approach: Add a `forceRefresh` arg to `calculatePnL` (and `getAcquisitionCost`) that bypasses/invalidates `readCache`; the Refresh button passes it. Keep the cache for the normal mount path.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\portfolio.js:62-66,122-125`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PortfolioTracker.jsx:299-309`
- effort: S · risk: low · test: click Refresh, assert a fresh fetch fires (cache bypassed).
- deps: [] · batchHint: `portfolio-pnl-honesty`

---

## BATCH whale-ens-and-fallback  (F725, F738)

### F725 — ENS resolver re-resolves misses every cycle, and the shared ens_cache format clashes with useEns
- verdict: **fix-now** (partially fixed at HEAD) · rootCause: **T8/standalone** · severity: medium
- Confirmed split: the **hardcoded llamarpc** part is ALREADY FIXED — both `WhaleIntelligence.jsx:363` and `OnChainProfile.jsx:158` now use `getReadProvider()` (`lib/rpcProvider.js`, publicnode+ankr first, llamarpc demoted, FallbackProvider). Still real: WhaleIntelligence only caches **successful** names (`:389-391 if (r.value.name)`) so misses re-resolve every 30s holders refresh (effect deps `[holders, whaleTransactions]`, new arrays each poll, `:409`); and it writes **plain strings** into `ens_cache` (`:390`) while `useEns.jsx` writes `{name, ts}` and prunes on `now - v.ts < CACHE_TTL` (`useEns.jsx:28`) — so useEns's startup prune wipes WhaleIntelligence's entries.
- approach: Replace WhaleIntelligence's hand-rolled batch resolver with `resolveEns()` from `hooks/useEns.jsx` (it dedups, caches misses as `{name:"", ts}`, and shares the `{name, ts}` format). Drop the local `pruneEnsCache`/plain-string writes. OnChainProfile's single-address resolve can also use `resolveEns`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WhaleIntelligence.jsx:321-409`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\OnChainProfile.jsx:151-184`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useEns.jsx`
- effort: M · risk: med (shared cache format — verify no other reader expects strings) · test: resolve a no-ENS address, assert it's cached as `{name:"",ts}` and not re-fetched on the next holders poll.
- deps: [] · batchHint: `whale-ens-and-fallback`

### F738 — Hardcoded fallback whale data shows with no "example data" banner
- verdict: **fix-now** · rootCause: **T4/T11** · severity: low
- Confirmed: `api.js:584-593` returns `FALLBACK_WHALES` with `fallback:true` on failure; WhaleIntelligence only drops the LIVE badge (`holdersLive=false`, `:184,:501`) — the canned wallets render as if real. `ActivityFeed.jsx:252-261` shows an explicit "⚠ Showing cached example data" banner for the same situation.
- approach: When `holdersLive===false && holders.length>0` (and likewise `activityLive`), render the same warning banner ActivityFeed uses (`:252-261`). Additive — don't remove the holders list.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WhaleIntelligence.jsx:495-523`
- effort: S · risk: low · test: stub `fetchTopHolders` → fallback, assert the banner shows above the holders list.
- deps: [] · batchHint: `whale-ens-and-fallback`

---

## BATCH activity-cursor-fix  (F734)

### F734 — Block cursor advances before the logs fetch succeeds — a failed eth_getLogs permanently skips that range
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `useActivityWebSocket.js:126` `lastBlockRef.current = currentBlock;` runs BEFORE `:128 fetchTransferLogs(...)`; if the fetch throws, the next poll starts after `currentBlock` and the missed range is never re-fetched.
- approach: Move `lastBlockRef.current = currentBlock;` to AFTER a successful `fetchTransferLogs` (after `:128`, before/at the success path), so a throw leaves the cursor where it was and the range retries next poll.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\hooks\useActivityWebSocket.js:108-158`
- effort: S · risk: low · test: mock `fetchTransferLogs` to throw once then succeed, assert the same fromBlock is retried.
- deps: [] · batchHint: `activity-cursor-fix`

---

## BATCH scatter-zoom  (F728, F739)

### F728 — "Reset Zoom" button visibility reads a ref during render — doesn't appear when you zoom
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `RarityPriceScatter.jsx:746` `{zoomRef.current.scale > 1 && (<button>Reset Zoom</button>)}` while `handleWheel` (`:574-589`) mutates `zoomRef` and calls `draw()` with no setState → React never re-renders → the button only shows after an unrelated state change.
- approach: Mirror `scale>1` into a state flag (`setIsZoomed`) inside `handleWheel` (and reset/pan handlers) and gate the button on that state.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\RarityPriceScatter.jsx:574-589,746`
- effort: S · risk: low · test: simulate a wheel-zoom, assert the Reset Zoom button renders.
- deps: [] · batchHint: `scatter-zoom`

### F739 — No touch zoom/pan + "scroll to zoom" microcopy on mobile; linear regression flags rare items as "underpriced"
- verdict: **fix-now** (touch) + **product-decision** (regression model) · rootCause: **T10** · severity: low
- Confirmed: only wheel/mouse handlers exist (`RarityPriceScatter.jsx:574-657`, wheel non-passive `:679`); project mandate is flawless iPhone/iPad. Trend math (`:250-262`) fits `price~rank` linearly; NFT price-rank curves are convex so top-rank items sit far above the line.
- approach: Additively add pinch-zoom/pan via pointer events and conditional microcopy on touch. The trend-model change (log-price fit toggle) is a product decision — offer a toggle rather than silently changing the trend semantics. Never remove the existing chart.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\RarityPriceScatter.jsx:250-262,574-679`
- effort: M · risk: low · test: manual on iPhone/iPad — pinch zooms the chart; microcopy reads "pinch to zoom" on touch.
- deps: [] · batchHint: `scatter-zoom`

---

## BATCH nav-routing-fix  (F756)

### F756 — Gallery nav button (and 'g' shortcut) is dead — routes to Floor instead of Gallery
- verdict: **fix-now** · rootCause: **standalone** (load-bearing routing bug) · severity: critical
- Confirmed root cause: `App.jsx:358` `handleTabChange` navigates gallery to `/nakamigos/${slug}/${newTab === "gallery" ? "" : newTab}` — i.e. an **empty** second segment. But `parseRoute` (`App.jsx:91`) maps an empty second segment to `"listings"` (`const second = segments[1] || "listings"`). So Gallery → `/nakamigos/nakamigos/` → parsed as **listings** (Floor). The `g` shortcut (`App.jsx:453`) calls the same `handleTabChange("gallery")`. Direct `/…/gallery` works because `"gallery"` is in `VALID_TABS`. Reproduced on localhost per the live agent — NOT fixed at HEAD.
- approach: Make gallery route explicitly: change `App.jsx:358` to `navigate(\`/nakamigos/${collectionSlug}/${newTab}\`)` (drop the `=== "gallery" ? ""` special case) so Gallery routes to `/…/gallery`. Keep Floor as the default landing tab via `parseRoute`'s `|| "listings"`. Extend `navRouting.test.jsx` to assert every nav target (esp. gallery) changes the route/tab.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.jsx:353-363,453`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\navRouting.test.jsx`
- effort: S · risk: med (routing — verify deep links / back button still work; ensure landing default stays Floor) · test: extend `navRouting.test.jsx` so `handleTabChange("gallery")` yields tab `gallery`; manual: click Gallery and press `g`, both land on the gallery grid.
- deps: [] · batchHint: `nav-routing-fix`

---

## BATCH wallet-modal-connectors  (F758)

### F758 — WalletConnect listed 3×; Safe/Base/MetaMask share one money-bag emoji
- verdict: **fix-now** · rootCause: **standalone** · severity: high
- Confirmed: `WalletModal.jsx:112` `availableConnectors.map(...)` with no de-dup by id; the icon fallback is `CONNECTOR_ICONS[connector.id] || "\u{1F4B0}"` (money bag) and Safe/Base aren't in `CONNECTOR_ICONS`/`CONNECTOR_LABELS`. So duplicate WalletConnect connectors all render and Safe/Base/MetaMask (when `connector.icon` is missing) get the money-bag.
- approach: De-dup `availableConnectors` by `connector.id` (and/or by name) before mapping. Add Safe (`safe`) and Base (`baseAccount`/`coinbaseWalletSDK`) entries to `CONNECTOR_ICONS`/`CONNECTOR_LABELS`, and prefer `connector.icon` when present. Optionally order MetaMask/WalletConnect first. The de-dup likely belongs in `WalletContext`'s `availableConnectors` selector so other consumers benefit.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\WalletModal.jsx:6-22,110-184`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\contexts\WalletContext.jsx`
- effort: M · risk: med (don't drop a legitimately-distinct connector) · test: with a connector list containing 3 walletConnect entries, assert one row renders; assert Safe/Base show real icons/labels.
- deps: [] · batchHint: `wallet-modal-connectors`

---

## BATCH splash-and-404  (F759, F775)

### F759 — Splash gate (~10–14s + mandatory click) replays on every full load, even deep links and 404s; not click-skippable early
- verdict: **fix-now** (click-skip + 404 bypass) + **product-decision** (auto-skip for returning visitors) · rootCause: **T10/standalone** · severity: high
- Confirmed: `App.jsx:138-163` splash is per-mount with NO seen-flag ("every entry to /nakamigos plays the splash" — an explicit prior user mandate per the comment). The gate at `:161` runs BEFORE the 404 check (`:170`) and isLanding, so even 404 routes play the full splash. `SplashScreen.handleEnter` (`:677-678`) is `if (phase !== "ready") return;` and `phase` only becomes "ready" after progress≥100 or the 8s safety (`:663-672`) — so early clicks do nothing (matches "two clicks at 8-9s hit nothing").
- approach: (1) Bypass the splash for 404 routes: move the `tab === "404"` check above the `!splashDone` gate (or skip the splash when `tab==="404"`). (2) Make the splash click-skippable immediately: allow `handleEnter` to short-circuit to `onComplete()` when clicked before "ready". (3) The auto-skip/shorten-for-returning-visitors is a **product decision** because the comment records an explicit user ask that every entry plays the full splash — surface that conflict to the owner before persisting a seen-flag. Keep the splash art intact (owner mandate).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.jsx:138-176`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\SplashScreen.jsx:663-698,754,1381`
- effort: M · risk: med (don't regress the intended first-visit experience) · test: navigate to a 404, assert no splash; click "CLICK TO ENTER" at t=2s, assert it skips.
- deps: [] · batchHint: `splash-and-404`

### F775 — 404 works but costs a full splash and offers only "Back to Home"; bad-collection URL doesn't name the issue
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `App.jsx:170-176` renders `NotFound` inside `LandingShell` (behind the splash, per F759). `parseRoute` returns `tab:"404"` for unknown collection slugs (`:97,:110`). `NotFound.jsx` only offers Back to Home.
- approach: Rides on the F759 404-splash-bypass. Additionally, when `collectionSlug` is set but `tab==="404"` (valid collection, bad tab) vs `collectionSlug` null (bad collection), branch the copy: bad-collection shows "Collection not found" plus the three valid collection cards (reuse `CollectionLanding` cards). Additive copy only.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.jsx:169-176`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NotFound.jsx`
- effort: M · risk: low · test: visit `/nakamigos/fakecollection/gallery`, assert "Collection not found" + the 3 valid cards, no splash.
- deps: [F759] · batchHint: `splash-and-404`

---

## BATCH onboarding-tour  (F767, F768)

### F767 — The identical 5-step tour re-fires for every collection
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `Onboarding.jsx:130` `storageKey = \`${collection.slug}_onboarded\`` — per-collection keys (`junglebay_onboarded`, `gnssart_onboarded`), so completing Nakamigos still re-shows it on JungleBay/GNSS.
- approach: Key the onboarding once per marketplace (e.g. `tradermigos_onboarded`) since the steps (Gallery/Floor/Wallet/Cart/Shortcuts) are not collection-specific. If a future step is collection-specific, add a secondary per-collection key only for that step.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Onboarding.jsx:130,139,220`
- effort: S · risk: low · test: complete the tour, switch collection, assert it doesn't reappear.
- deps: [] · batchHint: `onboarding-tour`

### F768 — Tour steps 1, 2, 4, 5 are centered modals that don't point at the feature
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: the tour HAS anchoring infra (`Onboarding.jsx:7-31` target selectors + spotlight clip-path `:274-295`). Step 3 (Wallet, `:19`) anchors to `.wallet-btn`. The others float center because their target selectors don't resolve when the tour fires (e.g. `.gallery-grid` isn't mounted on the Floor tab; the cart/shortcuts targets may be missing `data-tour` attrs).
- approach: Add the missing `data-tour` hooks to the Gallery tab button, cart icon, and Keys/shortcuts button so the existing spotlight resolves them; or make the tour navigate to the tab a step describes before measuring. No new tour engine needed — the spotlight code already works (proven by step 3).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Onboarding.jsx:7-31`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Header.jsx:387-391` (add `data-tour` to nav/cart/keys controls)
- effort: M · risk: low · test: run the tour, assert each step's `spotlightRect` is non-null and overlays the right control.
- deps: [] · batchHint: `onboarding-tour`

---

## BATCH modal-detail-fixes  (F757, F760, F761, F762, F766)

**Why one batch:** all are the NFT detail `Modal.jsx` (hero image, owner header, offer button, rarity badge, order-verify error).

### F757 — Detail-modal hero image never loads (503/pending) while grid thumbnails work; bottom-cropped at HEAD
- verdict: **fix-now** · rootCause: **standalone** · severity: high
- Confirmed: `NftImage.jsx` resolves via the Alchemy metadata proxy + a module-level `resolvedUrls` cache keyed `${contract}:${id}` (`:64`). The modal hero uses `nft.imageLarge || nft.image` (large path) and doesn't reuse the already-resolved grid thumbnail URL as an instant fallback, so when the large/CDN URL 503s it sits on the letter placeholder. Live agent also saw bottom-cropped positioning at HEAD.
- approach: In the modal hero, seed `NftImage`/the `<img>` from the grid's already-cached URL (`getCachedUrl(\`${contract}:${id}\`)` is shareable since `resolvedUrls` is module-level) as an instant fallback, and add a retry on the metadata fetch. Fix the hero positioning (object-fit/position) so the image isn't bottom-cropped.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx` (hero image block), `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NftImage.jsx:36-50`
- effort: M · risk: low · test: open a modal whose large URL 503s, assert the grid thumbnail shows immediately; visual: hero is centered not bottom-cropped.
- deps: [] · batchHint: `modal-detail-fixes`

### F760 — Unlabeled owner address in modal header reads like a contract; same snippet across collections smells stale
- verdict: **fix-now** · rootCause: **standalone** · severity: high
- Confirmed: `Modal.jsx:284-295` renders `· ERC-721 · {ownerEns || shortened nft.owner}` with no "Owner:" prefix — it's the owner (`nft.owner`, ENS via `useEns` at `:126`) but reads like a contract, and the CONTRACT field is separately shown below. The "identical 0x255d…1963 across two collections" suggests `nft.owner` is stale/bled across modals.
- approach: Prefix the line with "Owner:" (or an owner glyph). Verify the owner lookup is keyed per collection+token and reset when the modal's `nft` changes (don't reuse a previous token's owner). The ENS hook is fine; the concern is the upstream `nft.owner` population.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx:283-301`
- effort: S · risk: low · test: open two tokens in different collections, assert each shows its own owner labeled "Owner:".
- deps: [] · batchHint: `modal-detail-fixes`

### F761 — "Make Offer" button clipped to "Mak"/"Ma" at the modal's right edge
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `Modal.jsx:452-459` the offer button uses `style={{ flex: 0, whiteSpace:"nowrap", padding:"0 16px" }}` next to the Buy button (`flex:1`). `flex:0` leaves default `flex-shrink:1` with a 0 basis, so on a wide/constrained row the Buy button consumes the space and the offer button shrinks below its text width.
- approach: Set the offer button `flexShrink: 0` (and/or a `minWidth`) so it never clips. Keep the buy/offer row flex layout.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx:416-460`
- effort: S · risk: low · test: visual at a wide viewport — "Make Offer" renders in full.
- deps: [] · batchHint: `modal-detail-fixes`

### F762 — Rarity rank/trait % computed from a tiny loaded sample yet presented as authoritative (and baked into ShareCard)
- verdict: **product-decision** · rootCause: **T4** (overstated claim) · severity: medium
- Confirmed: `Modal.jsx:562` shows "(based on {loadedCount}/{supply} loaded)" yet the badge renders `RANK #{nft.rank}` (`:251`) and the ShareCard bakes `Rarity Score` (`ShareCard.jsx:71`). A rank from 80/20,000 tokens is statistically meaningless.
- approach: Two product paths: (a) ship precomputed full-collection rarity (the JungleBay About page already has full-supply trait counts; a static rarity JSON per collection would make ranks exact), or (b) label the badge "sample estimate" and keep the exact rank off the ShareCard until precomputed. Needs an owner choice on whether to invest in precomputed rarity. Until decided, the safe interim is (b).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx:251,562`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\ShareCard.jsx:60-71`
- effort: M (interim) / L (precompute) · risk: low · test: with a partial load, assert the badge reads "est." and the ShareCard omits the exact score.
- deps: [] · batchHint: `modal-detail-fixes`

### F766 — Raw ethers error dump rendered in the modal ("ORDER WARNING … missing revert data, invocation=null, code=CALL…")
- verdict: **fix-now** · rootCause: **standalone** (HEAD regression) · severity: medium
- Confirmed: `Modal.jsx:402-410` renders `orderWarning.reason` / `orderWarning.warnings.join("; ")` verbatim. If the order-verify path sets `reason` to a raw ethers exception string, it surfaces hex calldata + contract address. Prod didn't show it; it's a HEAD risk.
- approach: Where `orderWarning` is set (the order-validate/verify call), catch the ethers error and set a humanized `reason` ("Couldn't verify this listing right now — refresh or check OpenSea"), keeping the raw detail behind a collapsible/devtools log only. Don't render unhumanized exception text.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx:123,380-411`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\orderValidator.js`
- effort: M · risk: low · test: force the verify to throw, assert the modal shows the friendly copy not the raw stack.
- deps: [] · batchHint: `modal-detail-fixes`

---

## BATCH chat-room-richness  (F769)

### F769 — Disconnected chat is a dead room: no seeded content, tiny fixed-height message area
- verdict: **fix-now** · rootCause: **standalone** (missing) · severity: medium
- Confirmed in spirit: `CommunityChat.jsx` shows "Be the first to start a conversation" with a small fixed-height message area and presence "1 online". Nothing pulls a visitor in.
- approach: Additively inject live marketplace events (sales/listings from the ticker/`useCollection` activities) as system messages in the room, show total members (not just online), and let the message panel flex to fill the viewport. Don't replace the chat or remove the be-the-first state — interleave system events above it.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx:470-496,597-end`
- effort: M · risk: low · test: open chat on an empty room, assert recent sales render as system messages and the panel fills vertical space.
- deps: [] · batchHint: `chat-room-richness`

---

## BATCH watchlist-ux  (F727, F770, F782)

### F727 — Remote upsert fires on every keystroke of note/target; watched items outside the loaded set vanish silently
- verdict: **fix-now** · rootCause: **standalone** · severity: medium
- Confirmed: `Watchlist.jsx:199,208` `updateNote`/`updateTarget` call `addWatchlistRemote` inside onChange (no debounce). `:114 watchedNfts = tokens.filter(...)` — watched tokens outside the loaded gallery pages simply don't render; `Favorites.jsx:70-74` has a "{n} not yet loaded" hint, Watchlist has none.
- approach: Debounce the remote write (~500ms) in `updateNote`/`updateTarget`. Add the same "{n} watched NFTs not yet loaded" counter Favorites has. (Note: the remote write itself is RLS-dead until F714 ports it through the proxy — debounce now, real sync after F714.)
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Watchlist.jsx:86-120,166-221`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Favorites.jsx:70-74`
- effort: S · risk: low · test: type quickly into the note field, assert one debounced write; have a watched id outside `tokens`, assert the "not yet loaded" counter shows.
- deps: [] (better with F714) · batchHint: `watchlist-ux`

### F770 — "No watchlist feature anywhere" (live agent couldn't find an entry point)
- verdict: **fix-now** · rootCause: **standalone** (discoverability) · severity: medium
- Confirmed nuance: the Watchlist tab DOES exist (`App.jsx:638-639`, `MORE_NAV` "Watchlist" at `Header.jsx:139`) — but it's buried in the More menu and there's no per-token watch/star control on cards or in the detail modal, so a visitor can't add a token to it from where they browse (the live agent's real gap).
- approach: Add a per-token watch (star) + price-alert entry point on cards and in the detail `Modal.jsx`, feeding the existing watchlist + (post-F721) alert engine. Additive — don't remove the favorites heart; place the star alongside it.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Card.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Watchlist.jsx`
- effort: M · risk: low · test: click the star on a card, assert it appears in the Watchlist tab.
- deps: [F727] · batchHint: `watchlist-ux`

### F782 — Favorites empty state has good copy but no CTA button
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed in spirit: the favorites empty state guidance has no "Browse Gallery" button; the broken Gallery nav (F756) makes acting on the tip harder.
- approach: Add a "Browse Gallery" CTA to the favorites empty state that calls `setTab("gallery")` (now functional after F756). `Favorites.jsx`/`EmptyState.jsx` already accept an `onAction`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Favorites.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\EmptyState.jsx`
- effort: S · risk: low · test: open empty favorites, click Browse Gallery, assert it lands on the gallery grid.
- deps: [F756] · batchHint: `watchlist-ux`

---

## BATCH hub-and-badges  (F764, F765, F763)

### F764 — VOLUME shows "—" on all three hub cards + About TOTAL VOLUME, while the gallery header shows all-time vol
- verdict: **fix-now** · rootCause: **standalone** (data wiring) · severity: medium
- Confirmed: `CollectionLanding.jsx:584` renders VOLUME from `stats.volume` (dash when null). The hub's `fetchCollectionStats` path (`:621`) doesn't populate `volume` for these cards, yet the gallery header has shown "52.2K ETH all-time vol" — so the volume field exists from a different source/endpoint.
- approach: Surface the same volume value the gallery header uses into the hub-card stats and the About stat rows — either include `volume` in the hub's `fetchCollectionStats` result or pass the gallery's stats through. If volume comes only from an OpenSea endpoint not called on the hub, add that fetch to the hub stats loader.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CollectionLanding.jsx:578-600,613-645`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\api.js` (`fetchCollectionStats` volume field)
- effort: M · risk: low · test: load the hub, assert VOLUME is populated (not "—") for collections that have volume.
- deps: [] · batchHint: `hub-and-badges`

### F765 — Unexplained "• DEMO" badge on the hub (and dev) with no tooltip
- verdict: **redeploy-only** (tooltip) + **product-decision** (semantics) · rootCause: **T1** · severity: medium
- Confirmed partially fixed at HEAD: `Header.jsx:447-453` the api-badge now HAS a `title` ("Connected to live APIs" / "Using demo/fallback data — some features may be limited") and `role="status"`. The live agent's "no title attr" was stale prod → redeploy fixes the tooltip. Remaining: whether showing "DEMO" on a hub whose data is actually real is correct is a **product decision** (the badge reflects `isLive` from the stats/activity fetch).
- approach: Redeploy HEAD to ship the tooltip. Separately, decide with the owner whether the hub should compute `isLive` from real hub data (and hide DEMO when the hub data is live) — the badge semantics on the hub vs collection pages need an owner call.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Header.jsx:445-454`
- effort: S · risk: low · test: hover the badge on prod after redeploy, assert the tooltip; confirm with owner the hub DEMO/LIVE rule.
- deps: [] · batchHint: `hub-and-badges`

### F763 — Selected "5 min" cooldown chip nearly invisible (dark-on-dark)
- verdict: **redeploy-only** · rootCause: **T1** · severity: medium
- Confirmed FIXED at HEAD: `NotificationCenter.jsx:601-611` `pillStyle(active)` already uses `background: active ? "var(--gold)" : "var(--card)"` and `color: active ? "#000" : "var(--text-dim)"` — the selected chip is gold bg + black text (high contrast), exactly the inversion the finding asks for. The live agent saw the old dark-on-dark on stale prod.
- approach: No code change — ship HEAD. (If a visual re-check after redeploy still shows low contrast, revisit, but the code is correct.)
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NotificationCenter.jsx:601-611`
- effort: S · risk: low · test: after redeploy, open Alert Settings, assert the selected cooldown chip is gold/black and legible.
- deps: [] · batchHint: `hub-and-badges`

---

## BATCH provider-transport  (F774)

### F774 — eth.llamarpc.com is down (521) and retried on every page
- verdict: **redeploy-only** (mostly) · rootCause: **T1** · severity: low
- Confirmed largely fixed at HEAD: `lib/rpcProvider.js:12-16` puts publicnode + ankr first and **demotes llamarpc to last-resort** with a `stallTimeout`, and the comment records the 2026-06-11 521 incident. The ethers `FallbackProvider` only falls through to llamarpc when the first two stall. So the "only provider" breakage is resolved; prod is stale. The dead OPTIONS requests the agent saw come from llamarpc still being in the list (and possibly the wagmi transport in `src/lib/wagmi.ts`).
- approach: Redeploy HEAD. If the dead llamarpc requests are still undesirable, optionally drop llamarpc entirely from `RPC_ENDPOINTS` (and the wagmi transport list) — low priority since failover already handles it.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\rpcProvider.js:12-16`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\lib\wagmi.ts`
- effort: S · risk: low · test: after redeploy, confirm reads succeed with llamarpc cold; optionally confirm no llamarpc request when the first endpoints are healthy.
- deps: [] · batchHint: `provider-transport`

---

## BATCH copy-and-content  (F772, F773, F783, F745)

### F772 — Rug-to-Riches timeline out of chronological order
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed: `JungleBayShowcase.jsx:29-35` `TIMELINE_EVENTS` array has "May 2022 — Otherside" (`:34`) before "Nov 2021 — Sandbox" (`:35`); rendered in array order (`:264`), so they appear out of sequence.
- approach: Sort `TIMELINE_EVENTS` by parsed date before rendering (add a `Date`-parseable field or sort the array literal). Simplest: reorder the array literal so Nov-2021 Sandbox precedes May-2022 Otherside, or add a `ts` and `.sort`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\JungleBayShowcase.jsx:28-35,264`
- effort: S · risk: low · test: visual — timeline ascends Nov 2021 → … → Present.
- deps: [] · batchHint: `copy-and-content`

### F773 — Share card watermark points to "nakamigos.gallery" — not this app's domain
- verdict: **fix-now** · rootCause: **T4** (wrong domain) · severity: low
- Confirmed: `ShareCard.jsx:105` `ctx.fillText(\`${collection.slug}.gallery\`, ...)` → "nakamigos.gallery" for Nakamigos, not the app's domain.
- approach: Watermark with the real marketplace URL (`tegridyfarms.vercel.app/nakamigos`, or a per-collection deep link). Use a constant rather than `${slug}.gallery`.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\ShareCard.jsx:105`
- effort: S · risk: low · test: generate a share card, assert the footer reads the app URL.
- deps: [] · batchHint: `copy-and-content`

### F783 — GNSS species encyclopedia shows several "Supply TBD"
- verdict: **operator-action** (data backfill) · rootCause: **standalone** · severity: polish
- Confirmed in spirit: Cipr/Duqe/Genj/Naion/Que/Soco/Yami/Zuur cards read "Supply TBD" while others have exact counts; the collection is fully minted so the counts are knowable.
- approach: Backfill the per-species counts in the GNSS species data (a content/data task the owner can supply from the on-chain trait counts). The code renders whatever the data provides — this is data entry, not a code bug.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\SpeciesEncyclopedia.jsx` (or the GNSS species data source)
- effort: S · risk: low · test: after backfill, assert no card reads "Supply TBD".
- deps: [] · batchHint: `copy-and-content`

### F745 — Stale doc-comment schemas in notifications.js / supabase.js / userdata.js
- verdict: **fix-now** · rootCause: **T3** (doc drift that already caused real drift) · severity: polish
- Confirmed: `notifications.js:13-25` documents `keys jsonb` + `preferences jsonb` + `"Anyone can manage own subs" USING (true)` while the code writes flat p256dh/auth via the proxy and migration 004 dropped that policy. `supabase.js:77-79` still says "Author identity is NOT cryptographically verified" under a SIWE-verified header. `userdata.js:9-10` claims cross-device sync that's RLS-dead.
- approach: Prune the dead SQL blocks and contradictory notes; point each header at `supabase/migrations/` as the source of truth. Pure comment cleanup (these comments already caused the F745/F714 confusion).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\notifications.js:1-26`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\supabase.js:1-94`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\userdata.js:1-85`
- effort: S · risk: low · test: n/a (docs); confirm no code references the removed comment text.
- deps: [] · batchHint: `copy-and-content`

---

## BATCH ultrawide-and-polish  (F778, F779, F776, F781)

### F778 — About pages and chat strand 50–60% of the ultrawide viewport
- verdict: **fix-now** · rootCause: **standalone** (responsive) · severity: low
- Confirmed in spirit: About hero text is a ~600px left column with empty right two-thirds; chat is a short full-width strip; grids use width well by contrast.
- approach: On >2000px viewports, let About pull stats/timeline beside the hero (two-column) and let chat fill vertical space — additive CSS/layout, no content removal. Mandate-safe (no art/section removal).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\About.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\JungleBayShowcase.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.css`
- effort: M · risk: low · test: at 3000px, assert About is two-column and chat fills height.
- deps: [] · batchHint: `ultrawide-and-polish`

### F779 — Dotted separator above the footer reads as a debug border
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed in spirit: a full-width dashed/dotted bright line renders above the footer on every tab.
- approach: Soften to a low-opacity solid hairline or themed gradient in the footer/separator CSS.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.css` (footer separator rule)
- effort: S · risk: low · test: visual — the divider reads as designed, not a debug border.
- deps: [] · batchHint: `ultrawide-and-polish`

### F776 — Theme cycler is a mystery-meat button (cycles default → midnight → gold silently)
- verdict: **fix-now** · rootCause: **standalone** · severity: low
- Confirmed in spirit: `Header.jsx:462-469` cycles themes with only a hover `title`/aria-label as feedback; no toast/menu names the active theme.
- approach: On cycle, fire a small toast ("Theme: Midnight") naming the active theme (keep the fast cycle as the default path). Optionally a small dropdown. `cycleTheme` + `themeName` are already available.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Header.jsx:461-469`
- effort: S · risk: low · test: click the theme button, assert a toast names the new theme.
- deps: [] · batchHint: `ultrawide-and-polish`

### F781 — Rank badge "#17/20,000" on favorite cards reads like a token number
- verdict: **fix-now** · rootCause: **standalone** · severity: polish
- Confirmed in spirit: favorite cards show a top-left "#17/20,000" (title "Rank 17 of 20,000"); in the modal the same is correctly labeled "RANK #17". Two #numbers on one card confuse.
- approach: Use the "RANK #17" label style on cards too (the modal already does it) so it doesn't read like a token id.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Card.jsx` (rank badge), `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Favorites.jsx`
- effort: S · risk: low · test: visual — favorite card badge reads "RANK #17".
- deps: [] · batchHint: `ultrawide-and-polish`

---

## BATCH missing-roadmap  (F749, F750, F751, F752, F753, F754, F755, F784)

**Why one batch:** all are `missingVsBestInClass` roadmap gaps — none is a regression; each is a feature build or owner decision. Grouped so they're triaged as a roadmap, not slipped into a fix PR.

### F749 — Chat history pagination + DM realtime/typing/delivery state
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: `fetchMessages` caps at 100 (`supabase.js:150`) with no "load older"; DMs poll at 15s with no realtime channel/typing/delivery beyond a single read receipt.
- approach: Roadmap — add "load older" pagination (offset already supported) and consider a realtime channel for DMs (the proxy/RLS architecture makes Supabase Realtime for DMs non-trivial — see `dm.js` header). Owner decision on scope.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx`
- effort: L · risk: med · test: n/a until scoped.
- deps: [] · batchHint: `missing-roadmap`

### F750 — No USD per-token rows / cost-basis method choice / P&L CSV export / per-token price-history chart
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: only the two hero stats carry USD; no FIFO/specific-ID choice; Analytics has CSV export (`lib/csv.js`) but portfolio doesn't; `fetchTokenSalesHistory` exists in `api.js` but no per-token chart.
- approach: Roadmap — add USD to per-token rows (ethUsd already available), a P&L CSV export (reuse `lib/csv.js`), and a per-token price-history chart from `fetchTokenSalesHistory`. Cost-basis method choice depends on F723.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PortfolioTracker.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\csv.js`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\api.js`
- effort: L · risk: low · test: n/a until scoped.
- deps: [F723] · batchHint: `missing-roadmap`

### F751 — No deep links/shareability for analytics surfaces; notification items not clickable
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: profile drawer/alerts/notification items aren't URL-addressable and notification items don't link through to the token/event.
- approach: Roadmap — make the profile drawer/alerts URL-addressable (query param or sub-route) and make notification items link to the token/event they describe (the data carries token ids).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\App.jsx` (routing), `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NotificationCenter.jsx`
- effort: M · risk: low · test: n/a until scoped.
- deps: [] · batchHint: `missing-roadmap`

### F752 — No real historical series (holder trend synthetic, floor change from a 50-event window)
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: holder-count trend is synthetic (see F744); floor change uses sale-price proxies from a 50-event window.
- approach: Roadmap — persist periodic snapshots (the `saveSnapshot`/`loadSnapshots` pattern in `lib/portfolio.js:249-286` already exists for portfolio value) for holder count / floor, or pull an indexer/Dune feed (the indexer is an operator pending task). Owner/infra decision.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\lib\portfolio.js:249-286`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CollectionHealth.jsx`
- effort: L · risk: med · test: n/a until scoped.
- deps: [] · batchHint: `missing-roadmap`

### F753 — ENS-name input resolution (DM compose, watchlist/alert search) + ENS avatars in chat
- verdict: **fix-now** (input resolution overlaps F737) + **product-decision** (avatars) · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: the resolution infra (`resolveEns`, `useEns`) exists but is display-only in several inputs; chat doesn't show ENS avatars.
- approach: The DM-compose ENS input is F737. Extend the same `resolveEns` to watchlist/alert search inputs. ENS avatars in chat is a smaller additive enhancement (OnChainProfile already fetches avatars via `provider.getAvatar`).
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Watchlist.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\PriceAlerts.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CommunityChat.jsx`
- effort: M · risk: low · test: type an `.eth` name in watchlist search, assert it resolves.
- deps: [F737] · batchHint: `missing-roadmap`

### F754 — Canvas charts have no accessible alternative + no pinch-zoom on touch
- verdict: **fix-now** (touch overlaps F739/F728) + **product-decision** (a11y alternative) · rootCause: **T10** (missing) · severity: low
- Confirmed in spirit: canvas charts (RarityPriceScatter, sparklines) have no aria-label summary / data-table fallback and no pinch-zoom — against the iPhone/iPad-flawless mandate.
- approach: Touch/pinch is F728/F739. Add aria-label summaries (and optionally a visually-hidden data table) to the canvas charts for screen readers. Owner can decide how far the a11y fallback goes.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\RarityPriceScatter.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\CollectionHealth.jsx`
- effort: M · risk: low · test: screen-reader reads a chart summary; pinch zooms on touch (via F728/F739).
- deps: [F728, F739] · batchHint: `missing-roadmap`

### F755 — No tx-simulation/preview on the DM inline trade accept (signs and executes after one confirm)
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: the DM inline trade card "Accept trade → Confirm — sign & execute" (`DirectMessages.jsx:118-127`) signs and executes after one confirm; best-in-class shows a balance/approval preview first. TradesPanel/TradeWindow may have more; the DM card path is thinner.
- approach: Roadmap — add a balance/approval/price-impact preview step to the DM accept path (reuse whatever preview `TradeWindow` has). Owner decision on parity scope.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\DirectMessages.jsx:100-135`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\TradeWindow.jsx`
- effort: M · risk: med (trade execution path) · test: n/a until scoped.
- deps: [] · batchHint: `missing-roadmap`

### F784 — Biggest gaps vs OpenSea/Blur (real <a> nav hrefs, modal owner/activity tab, "where alerts arrive" note)
- verdict: **product-decision** · rootCause: **standalone** (missing) · severity: low
- Confirmed in spirit: nav tabs are `<button>` not `<a>` (`Header.jsx:387-391,563-567`) so middle-click/open-in-new-tab fails everywhere; modal lacks an owner/activity tab beyond the sparkline; no "where alerts arrive" hint in Alert Settings; offers section loads slowly with unlabeled skeletons.
- approach: Roadmap, highest-leverage: (a) make nav tabs real `<a href>` (anchors that also call the SPA navigate) so middle-click works — this is a concrete fix-now-able item; (b) add an owner/activity tab to the modal; (c) add a "alerts arrive in-app while this tab is open" note to Alert Settings. Owner prioritizes.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Header.jsx:386-435,560-569`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Modal.jsx`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NotificationCenter.jsx`
- effort: L · risk: med (anchor nav must not double-navigate) · test: middle-click a nav tab opens a new tab to the right route.
- deps: [F756] · batchHint: `missing-roadmap`

---

## BATCH card-skeletons  (F777)

### F777 — Card images pop in 5–10s late with no shimmer; first card sometimes never loads
- verdict: **fix-now** · rootCause: **T12** (no LQIP/skeleton) + **T1** (the prod batch-fetch lock was fixed 2026-06-11) · severity: low
- Confirmed in spirit: `NftImage.jsx:129-143` already renders a pulsing placeholder when `noSelfFetch && failCount<3` (the "pending" pulse) — so the shimmer EXISTS at HEAD for the batch-fetch path (the prod stall was the rate-limit lock fixed 2026-06-11, T1). Remaining: ensure the floor/listings grid passes `noSelfFetch`/`priority` so the pulse shows, and a failed thumbnail retries (currently `failCount>=3` latches to the letter placeholder).
- approach: Verify the floor/listings grid uses the `noSelfFetch` pulse path; add a bounded retry for a failed thumbnail (reset `failCount` after the metadata TTL like the cache already does for failures). Redeploy ships the existing pulse + the 2026-06-11 batch-fetch fix.
- files: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\NftImage.jsx:100-144`, `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\nakamigos\components\Listings.jsx`
- effort: S · risk: low · test: throttle the metadata proxy, assert cards pulse (not blank) and a transient failure retries.
- deps: [] · batchHint: `card-skeletons`
