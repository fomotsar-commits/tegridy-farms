# Vercel Serverless Function Budget — Hobby plan 12-function cap

**Constraint:** the Vercel project (`tegridy-farms`, fomotsar-3237's projects) is on the
**Hobby plan**, which allows **at most 12 Serverless Functions per deployment**. Exceeding it
fails the deploy with:

> Build Failed — No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.

The *build* succeeds (vite/tsc compile fine); only the *deploy* step trips the cap. So a code-clean
PR can still show a Vercel `Error` purely from function count.

## Current state (counted in the tree, 2026-09-02): 11 functions — 1 of headroom

Vercel counts each top-level handler under `frontend/api/` (NOT `_lib/`, `__tests__/`, or
`_`-prefixed files). The 11:

1. `api/alchemy.js`
2. `api/etherscan.js`
3. `api/opensea.js`
4. `api/orderbook.js`
5. `api/supabase-proxy.js`
6. `api/analytics.js`
7. `api/solrpc.js`
8. `api/auth/me.js`
9. `api/auth/siwe.js`
10. `api/v1/index.js`
11. `api/aggregator.js`  ← **the catchall**

## The catchall is load-bearing — do not split it

The 8 swap aggregators (odos, cow, lifi, kyber, openocean, paraswap, swapapi, jupiter) ALL route
through the single `api/aggregator.js` function via `vercel.json` rewrites
(`/api/odos/* → /api/aggregator?provider=odos&p=*`, etc.). This was commit `9c2b0db`
("consolidate 7 aggregator proxies → 1 catchall (Hobby plan 12-fn limit)"). Splitting it back into
per-provider functions would be 11 → 18 and break the deploy. **Keep it consolidated.**

## Before adding ANY new `api/*.js` route

Count stays ≤ 12. At 11 today, you have room for exactly 1 more standalone route. Past that, either:
- consolidate (route multiple paths through one `[...catchall].js` handler + a `vercel.json` rewrite), or
- upgrade to Vercel Pro (removes the cap — a billing decision).

## `?resource=` branches on the catchall — zero function cost

Small, low-traffic first-party resources live on the catchall behind a `?resource=` branch
and a LAZY dynamic import, so the swap hot path never loads them and the function count is
unchanged. Each branch MUST sit above the `const provider` line in `api/aggregator.js` — a
`?resource=` call carries no provider, so a branch placed after it never runs and falls
into the 404.

| `?resource=` | Module | What it is |
|---|---|---|
| `launcher-outcomes` | `_lib/launcher-outcomes.js` | LaunchExplorer market + chain stats |
| `launch-radar` | `_lib/launch-radar.js` | Market-wide GeckoTerminal `new_pools` |
| `pool-market` | `_lib/pool-market.js` | ONE pool's market facts for the bungalow strip. Exists for its `s-maxage`, not for the proxying — the browser read the same keyless host directly before, and a proxy without the cache header would be WORSE (one origin IP instead of each visitor's own budget). Do not remove the header |
| `launch-cohort` | `_lib/launch-cohort.js` | Airlock `Create` enumeration |
| `heat` | `_lib/heat.js` | Jungle Bay Island held-time oracle (CORS-forced, not an optimisation) |
| `births` | `_lib/births.js` | HMAC-signed birth notify to the island's enrollment socket |
| `record` | `_lib/record.js` | A token's birth certificate as JSON, derived from chain on read |
| `alerts` | `_lib/alerts.js` | Per-wallet alert-rule CRUD under RLS (the user's own SIWE JWT is forwarded to PostgREST) |
| `airdrop` | `_lib/airdrop.js` | Airdrop manifest store: one claimant's own leaf + a server-generated proof; creator publish |
| `referrals` | `_lib/referrals.js` | Short-code store for `/?r=code` referral links: one code in, at most one wallet out |
| `commerce` | `_lib/commerce.js` | Merchant invoice store + settlement record behind `/checkout`: one id in, one invoice out. OPTIONAL short-link enrichment only — the signed `#i=` payment link is verified in the buyer's browser and needs none of it, so this resource is not on the path that moves money |
| `bot-link` | `_lib/botLink.js` | Telegram chat ↔ wallet binding: the bot's only server surface, and the reason it never holds a key |

`airdrop` is the one resource here whose absent branch is the security property. It has no
endpoint that returns a campaign's recipient list, because a recipient list is a
wallet-targeting database and there is no caller for whom the whole thing is the right
answer. The two queries it makes against the entry table are shape-pinned by
`api/_lib/__tests__/airdrop.test.js`: the tree rebuild selects no address column, and the
claimant lookup is filtered to one address. Do not add a third.

`alerts` is CRUD only and cannot ever be the evaluator: a serverless function runs only
when something calls it, so nothing here can watch a rule while the user's tab is shut.
Rules are evaluated in the browser, and the response's `delivery` block says so — do not
"fix" this by adding a cron that pretends to be the F9 worker.

`referrals` is the second resource here whose ABSENT capability is the point. It has no
endpoint that returns more than one row: the single public read is service-role with a
pinned `code=eq.<one code>&limit=1` filter, shape-pinned by
`api/__tests__/referrals-surface-parity.test.js`. A wider read would be a downloadable
list of every referrer's wallet — the same shape `airdrop` refuses. It is also NOT the
referral ledger: earnings, referee counts and claimable balances are ReferralSplitter's
on-chain state and are never mirrored into the table. Note that this resource being
entirely absent degrades to a WORKING feature rather than a broken one — `/?ref=0x…`
links resolve in the browser with no server, and the share surface mints those by default.

`bot-link` is the third resource here whose ABSENT capability is the design. It has no
endpoint that binds a chat to a wallet on the bot's say-so: the bot's HMAC credential can
mint a pending code, read ONE chat's state, and destroy a binding, and the only path that
attaches a wallet is a browser call carrying that wallet's own SIWE cookie. It also has no
endpoint that returns a second row and no field, in either direction, that carries key
material — `api/__tests__/bot-noncustodial.test.js` pins that across this file, the bot
service and migration 020. The bot process itself is NOT hosted on Vercel and must not be:
it is a long-running poller, the wrong shape for a function, and there is no twelfth slot
for it. See `bot/DEPLOY.md`.

`commerce` is the third resource here whose ABSENT capabilities are the design. It is
**not custodial and structurally cannot become so**: no key is held, derived or accepted
anywhere on the checkout path, and both legs of a payment are signed by the buyer in their
own wallet with the merchant as the direct recipient. It is **not an oracle** — a settlement
row is written `verification: "client-reported"` from a hardcoded literal, never from the
request body, because nothing in that file reads a receipt and nothing that has not read one
may write a word that means it did. It is **not a directory**: the single public read is
service-role with a pinned `id=eq.<one id>&limit=1` filter and an explicit column list (which
excludes `webhook_url`), shape-pinned by `api/__tests__/commerce-surface-parity.test.js`, for
the same reason `airdrop` has no recipient list and `referrals` has no referrer roster — a
listable invoice table is a downloadable ledger of who sells what to whom for how much.

Its webhook is ONE inline POST inside the settle request, HMAC-signed, `redirect: "manual"`,
3s timeout, response read to a 4 KB cap and discarded. `retries: "none"` is the policy, not a
placeholder: same constraint as `alerts` above — a serverless function runs only when
something calls it, so there is nothing here to schedule a second attempt. Do not "fix" this
with a cron that pretends to be a delivery queue. Without `COMMERCE_WEBHOOK_SECRET` no
callback is attempted at all, because an unsigned webhook is one anybody could forge and a
forged one tells a merchant a payment landed that did not.

`births` is server-side for the same reason `heat` is not an optimisation: it holds the
shared signing secret, and a signature the browser could produce is one anybody could
produce.

`record` is reached through a **rewrite**, not by callers naming `?resource=`:
`/record/:chain/:ca.json` is the stable URL the island stores at enrollment. That rewrite
is load-bearing — the SPA fallback `/((?!api/).*)` only excludes `api/…`, so without it
`/record/…` answers **200 with the app shell**, forever, and a health check on `res.ok`
would call it healthy.

## Known offenders / watch-list
- **PR #25** (stale 72-file UX push) adds `api/indexer.js` → would be the 12th function, spending the
  last slot exactly. It no longer leaves headroom behind it, which is another reason that PR needs a
  rebuild rather than a blind merge.
- **Dependabot preview deploys** occasionally show Vercel `Error` from build-cache replaying an
  older (larger) function set — transient, does not affect production `main`.
