# Vercel Serverless Function Budget — Hobby plan 12-function cap

**Constraint:** the Vercel project (`tegridy-farms`, fomotsar-3237's projects) is on the
**Hobby plan**, which allows **at most 12 Serverless Functions per deployment**. Exceeding it
fails the deploy with:

> Build Failed — No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.

The *build* succeeds (vite/tsc compile fine); only the *deploy* step trips the cap. So a code-clean
PR can still show a Vercel `Error` purely from function count.

## Current state (origin/main, 2026-06-01): 9 functions — 3 of headroom

Vercel counts each top-level handler under `frontend/api/` (NOT `_lib/`, `__tests__/`, or
`_`-prefixed files). The 9:

1. `api/alchemy.js`
2. `api/etherscan.js`
3. `api/opensea.js`
4. `api/orderbook.js`
5. `api/supabase-proxy.js`
6. `api/auth/me.js`
7. `api/auth/siwe.js`
8. `api/v1/index.js`
9. `api/aggregator/[provider]/[...path].js`  ← **the catchall**

## The catchall is load-bearing — do not split it

The 7 swap aggregators (odos, cow, lifi, kyber, openocean, paraswap, swapapi) ALL route through
the single `aggregator/[provider]/[...path].js` function via `vercel.json` rewrites
(`/api/odos/* → /api/aggregator/odos/*`, etc.). This was commit `9c2b0db`
("consolidate 7 aggregator proxies → 1 catchall (Hobby plan 12-fn limit)"). Splitting it back into
per-provider functions would be 9 → 15 and break the deploy. **Keep it consolidated.**

## Before adding ANY new `api/*.js` route

Count stays ≤ 12. At 9 today, you have room for 3 more standalone routes. Past that, either:
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
| `launch-cohort` | `_lib/launch-cohort.js` | Airlock `Create` enumeration |
| `heat` | `_lib/heat.js` | Jungle Bay Island held-time oracle (CORS-forced, not an optimisation) |
| `births` | `_lib/births.js` | HMAC-signed birth notify to the island's enrollment socket |
| `record` | `_lib/record.js` | A token's birth certificate as JSON, derived from chain on read |
| `alerts` | `_lib/alerts.js` | Per-wallet alert-rule CRUD under RLS (the user's own SIWE JWT is forwarded to PostgREST) |
| `airdrop` | `_lib/airdrop.js` | Airdrop manifest store: one claimant's own leaf + a server-generated proof; creator publish |

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

`births` is server-side for the same reason `heat` is not an optimisation: it holds the
shared signing secret, and a signature the browser could produce is one anybody could
produce.

`record` is reached through a **rewrite**, not by callers naming `?resource=`:
`/record/:chain/:ca.json` is the stable URL the island stores at enrollment. That rewrite
is load-bearing — the SPA fallback `/((?!api/).*)` only excludes `api/…`, so without it
`/record/…` answers **200 with the app shell**, forever, and a health check on `res.ok`
would call it healthy.

## Known offenders / watch-list
- **PR #25** (stale 72-file UX push) adds `api/indexer.js` → would be the 10th function. Still under
  cap alone, but another reason that PR needs a rebuild rather than a blind merge.
- **Dependabot preview deploys** occasionally show Vercel `Error` from build-cache replaying an
  older (larger) function set — transient, does not affect production `main`.
