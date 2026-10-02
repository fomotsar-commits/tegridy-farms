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
- `VITE_0X_API_KEY` — **read by nothing as of 2026-09-20.** The value in
  `frontend/.env` is byte-identical to the placeholder committed in
  `frontend/.env.example`, so there is no live key here to rotate.
- `VITE_ETHERSCAN_API_KEY` — **NOT public by design. See the correction in Bucket B.**
  The same 34-character value was used as the server-only `ETHERSCAN_API_KEY`
  (`.audit_101/remediation/R001.md:11`), so classifying it here as "a public read key"
  made a Bucket B credential look like one whose disclosure cost nothing. A key does
  not become public-by-design because a `VITE_`-prefixed alias existed for it.
- `VITE_ALCHEMY_API_KEY` — **read by nothing as of 2026-09-20**, and has no value
  anywhere in the repo. The live Alchemy credential is the server-only
  `ALCHEMY_API_KEY` in Bucket B, reached through `/api/alchemy`.
- `VITE_SUPABASE_ANON_KEY` (protected by RLS, not a secret)
- `VITE_VAPID_PUBLIC_KEY` (intentionally public)

> **The bucket is a claim about a VALUE, not about a variable name.** Both corrections
> above are the same mistake: a name in Bucket A whose value was also a Bucket B secret,
> and two names in Bucket A that no longer have values at all. Before trusting a row
> here, check that something still reads the variable and that its value is not shared
> with a server-only one.

### Bucket B — server-only, never in git

These live in Vercel Project Settings → Environment Variables and are
read by `/api` serverless functions.

> ⚠️ **CORRECTED 2026-09-20 — "none of these has ever been committed" WAS FALSE.**
> This section used to claim that a grep of all history as of `05da2fa` confirmed no
> Bucket B key had ever been committed. `ETHERSCAN_API_KEY` had been. The 34-character
> key was pasted as evidence into `.audit_101/073_AppRoot.md` and
> `.audit_101/DETAILED_REPORT.md` in `9b59e212` (2026-04-26) and redacted **in tree
> only** by `00e10a07` (2026-05-02); the pre-redaction blobs are still reachable
> (`git show '00e10a07^:.audit_101/073_AppRoot.md'`), both commits are ancestors of
> `origin/main` **and** `origin/mvp-launch`, and this repository is **public**. So the
> value was world-readable from the moment it was pushed, and reading this section at
> HEAD — where the docs say `<redacted>` — told you the opposite.
>
> Two lessons, both worth more than the fix: (1) an assurance sentence needs a date, a
> method and a scope, because this one outlived the fact it described; (2) `gitleaks.yml`
> **cannot** catch this class at all — `gitleaks-action` scans only the push/PR commit
> range, never full history, so a secret that entered before the scanner did stays
> invisible to it forever. A full-history scan is the only thing that finds it.
>
> Status of that key as of 2026-09-20: the value **in use today differs** from the
> committed one (verified by comparing sha256 digests of the historical blob and the
> configured value — neither value was printed), so it was replaced at some point. That
> rotation was never recorded below, which is why this took an audit to establish.
> **The OLD key is REVOKED — confirmed 2026-09-20 by asking Etherscan.** The same harmless
> read (`module=account&action=balance`, chainid 1) was sent three ways: with no key
> (`NOTOK — Missing/Invalid API Key`), with today's key (`OK`, served), and with the old
> key read from the historical blob (`NOTOK — Invalid API Key (#err2)`). The two controls
> show the method tells "accepted" from "rejected", so the old key's rejection means it
> is dead, not that the check failed. The value is still world-readable in history, and
> that is now harmless.

Rotation is mandatory only if:
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
   to `tegridyfarms.vercel.app` + `tegridyfarms.vercel.app` + `tegridyfarms.vercel.app`.
2. Update the value in Vercel → Project Settings → Environment Variables
   → `VITE_<NAME>`. Apply to Production, Preview, Development.
3. Trigger a redeploy (Vercel dashboard → Deployments → Redeploy).
4. Confirm the new bundle is live. **Do not type any part of the old key.** Typing a
   prefix puts it in your shell history — one of the very surfaces a rotation exists to
   clear, and the surface that made the 2026-09-20 incident worse than the screenshot
   alone. Substitute it from the file instead, so the value never appears in a command
   you typed:

   ```bash
   curl -s https://tegridyfarms.vercel.app/assets/index-*.js \
     | grep -c "$(grep '^VITE_<NAME>=' frontend/.env.old | cut -d= -f2-)"
   ```

   should return `0`.
5. Revoke the old key in the provider dashboard.

### A key from Bucket B (server-only)

1. Generate a new key in the provider dashboard.
2. Update the value in Vercel → Project Settings → Environment Variables
   for Production, Preview, and Development.
3. Redeploy Production (so the serverless function picks up the new env).
4. Smoke-test the affected endpoint from Chrome against
   `https://tegridyfarms.vercel.app` — e.g. for Alchemy: open any page that
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
4. Run `git check-ignore -v frontend/.env` before every commit. It must print a rule —
   any rule. **Do not match it against a literal expected string.** This step used to
   demand exactly `.gitignore:3:.env  frontend/.env`; the real output on 2026-09-20 is
   `frontend/.gitignore:28:.env  frontend/.env`, because the rule lives in
   `frontend/.gitignore`, not the root one, and has moved line as that file grew. So the
   documented check reported a *regression* against a perfectly correct configuration —
   which trains people to ignore it. What matters is that the file is ignored and
   untracked, and those are the two things to assert:

   ```bash
   git check-ignore -v frontend/.env contracts/.env   # must print a rule for each
   git ls-files --error-unmatch frontend/.env         # must FAIL (not tracked)
   ```

   Both were verified on 2026-09-20: `frontend/.env` and `contracts/.env` are ignored and
   untracked.

## Auditing leaked values

If you suspect a specific string has leaked, search full history — **without typing the
string.** The obvious form, `git log --all -S "<first 8-12 chars>"`, works but writes a
prefix of the key into your shell history, and a prefix of a 34-character key is plenty
to correlate against a public blob. Substitute it instead:

```bash
git log --all --oneline -S "$(grep '^ETHERSCAN_API_KEY=' contracts/.env | cut -d= -f2-)"
```

To ask the question in the other direction — *is the key I use today the one that
leaked?* — compare digests rather than values, which never reveals either:

```bash
# the configured value
grep '^ETHERSCAN_API_KEY=' contracts/.env | cut -d= -f2- | tr -d '\r\n' | sha256sum
# the value in the historical blob, e.g. the 2026-04-26 audit-doc leak
git show '00e10a07^:.audit_101/073_AppRoot.md' \
  | grep -oE 'ETHERSCAN_API_KEY=[A-Za-z0-9]+' | cut -d= -f2- | tr -d '\r\n' | sha256sum
```

Equal digests mean the leaked key is still in use — rotate now. Different digests mean
only that the *value changed*; they say nothing about whether the old key was **revoked**
at the provider, which is a separate check and the one people skip.

**To answer "was it revoked?", ask the provider — with two controls.** Send one harmless
read three times: with no key, with the key you use today, and with the old key. If the
no-key call is rejected and today's key is served, the method can tell the difference, so
an old-key rejection means the key is dead. Without the controls, a rejection could just
as well mean the endpoint, the parameters or the network were wrong. Read the old value
from the blob inside the script rather than typing it, and never print a request URL or an
exception message, since either can carry the key. This is how the Etherscan row below
was closed; it needed no dashboard login.

If a history search returns commits, the key must be rotated *and* history rewritten
via `git filter-repo --replace-text` before the next push to a public
remote. Coordinate with the remote host (GitHub) to purge cached
object refs.

## Incident log

Record every actual rotation below so future audits can trace what
changed and why.

**This table read `_(none yet)_` until 2026-09-20, and that was wrong — at least two
rotations had already happened.** An empty ledger is not evidence that nothing was
rotated; it is evidence that nobody wrote it down, and the two are indistinguishable
from the outside. The 2026-09-20 audit had to reconstruct both rows from git blobs and
digest comparisons because this table said nothing. If you rotate something, add a row
in the same sitting.

| Date | Key | Bucket | Reason | Commit after redeploy |
|------|-----|--------|--------|----------------------|
| ≤2026-09-20 (exact date unknown) | `ETHERSCAN_API_KEY` / `VITE_ETHERSCAN_API_KEY` | B (was miscategorised as A) | The 34-char value was committed as audit evidence in `9b59e212` (2026-04-26) and redacted in tree only by `00e10a07` (2026-05-02); the blob is still public. Reconstructed 2026-09-20: the configured value's sha256 **differs** from the historical blob's, so it was replaced, and Etherscan **rejects the old key** (`Invalid API Key (#err2)`, with a no-key and a current-key control), so it was revoked. When and by whom were never recorded. | unknown |
| 2026-09-20 | Alchemy **Solana mainnet** app key (supplied by hand as `--rpc`) | not in any bucket — an operator-supplied endpoint credential, which this document did not model | `frontend/scripts/bayla-ladder-ops.mjs` printed the full `--rpc` URL in its header on every invocation, and a shared terminal screenshot during the BAYLA ladder mainnet go-live disclosed the key. Fixed in [#648](https://github.com/fomotsar-commits/tegridy-farms/pull/648): the host is printed, the credential masked (`scripts/lib/redact-url.mjs`, the one copy shared by frontend/, scripts/ and contracts/). | #648 |

**From the 2026-09-20 audit:**
- [x] Confirm the **old** Etherscan key is revoked, not merely superseded. **Done
      2026-09-20:** Etherscan answers the old key with `Invalid API Key (#err2)` while
      serving the current key, and rejects a no-key call — method under "Auditing leaked
      values". The value remains public in history, and is now harmless.
- [ ] Record the date and actor of the Etherscan rotation above, if either can still be
      established. If they cannot, write "unrecoverable" rather than leaving it blank.

**Not to be re-chased** (checked 2026-09-20, found fine — recorded so it is not
re-litigated): no other currently-configured credential appears anywhere in git history.
Every value in `frontend/.env` and `contracts/.env` was digested and compared against
127,514 distinct credential-shaped tokens extracted from the full history of all refs.
The only matches were `SEPOLIA_RPC_URL` and `VITE_0X_API_KEY`, both of which are
byte-identical to the placeholders committed in their `.env.example`, and
`VITE_WALLETCONNECT_PROJECT_ID`, which is a public client identifier that was previously
hardcoded in `frontend/src/lib/wagmi.ts`. `contracts/.env`'s `PRIVATE_KEY` is a 2-character
sentinel, not a key.
