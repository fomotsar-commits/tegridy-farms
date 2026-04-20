# Secret Rotation Runbook

This document is the single place to look when rotating any credential
used by the frontend, API proxies, or indexer. It also documents the
actual leak surface for each key so you can make informed decisions
about what *must* be rotated vs. what *could* be.

## Leak surface by key

Every key falls into one of three buckets. Rotation urgency follows the
bucket, not the key.

### Bucket A — public by design (ship in the browser bundle)

These are intentionally embedded in the built JS and visible to anyone
who opens DevTools. Rotation does not undo disclosure; it only changes
*which* public key is active. Rotate only if:
- The key ties to a billable quota and you see abuse in dashboards, or
- You want to enforce a new origin-restriction policy

Keys in this bucket:
- `VITE_WALLETCONNECT_PROJECT_ID`
- `VITE_0X_API_KEY`
- `VITE_ETHERSCAN_API_KEY` (public read key)
- `VITE_ALCHEMY_API_KEY` (public read key)
- `VITE_SUPABASE_ANON_KEY` (protected by RLS, not a secret)
- `VITE_VAPID_PUBLIC_KEY` (intentionally public)

### Bucket B — server-only, never in git

These live in Vercel Project Settings → Environment Variables and are
read by `/api` serverless functions. A `grep` of all git history as of
commit `05da2fa` confirms none of these keys has ever been committed;
the only values that have ever touched the repo are the `process.env.X`
references. Rotation is mandatory only if:
- A contributor has ever shared their local `.env` (Slack, email, screenshot,
  screen-share) or
- A device with `.env` on disk has been lost, stolen, or had unauthorized access

Keys in this bucket:
- `ALCHEMY_API_KEY` (high-quota, proxied via `/api/alchemy`)
- `OPENSEA_API_KEY` (`/api/opensea`)
- `ETHERSCAN_API_KEY` (server-only variant used by `/api/etherscan`)
- `SUPABASE_SERVICE_KEY` — **root credential, bypasses RLS**
- `SUPABASE_JWT_SECRET` — signs the `siwe_jwt` cookie
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`

### Bucket C — deployer / governance

Contract ownership keys and deployer keys. These live entirely outside
this repo (hardware wallet, multisig Safe). Rotation = onchain `transferOwnership`.
Tracked per-contract in [`WAVE_0_RUNBOOK.md`](./WAVE_0_RUNBOOK.md).

## Rotation procedure

### A key from Bucket A (public)

1. Generate a new key in the provider dashboard; add origin restriction
   to `tegridyfarms.xyz` + `www.tegridyfarms.xyz` + `tegridyfarms.vercel.app`.
2. Update the value in Vercel → Project Settings → Environment Variables
   → `VITE_<NAME>`. Apply to Production, Preview, Development.
3. Trigger a redeploy (Vercel dashboard → Deployments → Redeploy).
4. Confirm new bundle is live: `curl -s https://tegridyfarms.xyz/assets/index-*.js | grep -c <old-key-prefix>` should return `0`.
5. Revoke the old key in the provider dashboard.

### A key from Bucket B (server-only)

1. Generate a new key in the provider dashboard.
2. Update the value in Vercel → Project Settings → Environment Variables
   for Production, Preview, and Development.
3. Redeploy Production (so the serverless function picks up the new env).
4. Smoke-test the affected endpoint from Chrome against
   `https://tegridyfarms.xyz` — e.g. for Alchemy: open any page that
   shows NFT data and confirm no 500/502 in the Network tab.
5. Revoke the old key in the provider dashboard.
6. If the key is `SUPABASE_JWT_SECRET`: this invalidates every existing
   `siwe_jwt` session cookie. All users will need to re-sign the
   SIWE message on next visit. Flag this in release notes.

### A key from Bucket C (deployer / owner)

See [`WAVE_0_RUNBOOK.md`](./WAVE_0_RUNBOOK.md) and
[`GOVERNANCE.md`](./GOVERNANCE.md). Always pair onchain `transferOwnership`
with the receiving address calling `acceptOwnership` from the destination
wallet (most contracts use the 2-step pattern).

## Local `.env` hygiene

Contributors must:
1. Copy `frontend/.env.example` → `frontend/.env`.
2. Fill in *only* the client (`VITE_*`) keys they actually need for local dev.
3. Never fill the server-only (Bucket B) keys locally unless they are
   actively developing `/api` handlers. If they do, they should
   generate scoped dev keys with narrow permissions, not copy prod values.
4. Run `git check-ignore -v frontend/.env` before every commit. Output must
   be `.gitignore:3:.env  frontend/.env` — anything else is a regression.

## Auditing leaked values

If you suspect a specific string has leaked, search full history:

```bash
# Replace <needle> with the first 8–12 chars of the key
git log --all -S "<needle>" --oneline
```

If that returns commits, the key must be rotated *and* history rewritten
via `git filter-repo --replace-text` before the next push to a public
remote. Coordinate with the remote host (GitHub) to purge cached
object refs.

## Incident log

Record every actual rotation below so future audits can trace what
changed and why.

| Date | Key | Bucket | Reason | Commit after redeploy |
|------|-----|--------|--------|----------------------|
| _(none yet)_ | | | | |
