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

## Known offenders / watch-list
- **PR #25** (stale 72-file UX push) adds `api/indexer.js` → would be the 10th function. Still under
  cap alone, but another reason that PR needs a rebuild rather than a blind merge.
- **Dependabot preview deploys** occasionally show Vercel `Error` from build-cache replaying an
  older (larger) function set — transient, does not affect production `main`.
