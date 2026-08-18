# Operator: what to do next

Written 2026-08-18. This is the short list of things **only you can do**, in the order that
makes each one safe, with the exact steps and the exact traps. Everything else in
[BATTLE_PLAN.md](BATTLE_PLAN.md) is blocked behind these.

**How to use this:** work one step at a time. Each step says what you run, what you should
see, and what to tell Claude afterwards. If a "you should see" does not match, stop and say
so — a surprise here is information, not a nuisance.

**The two rules that protect you:**
1. Claude never handles a secret value. You paste secrets into Vercel/Supabase yourself; you
   never put them in chat. If a step seems to ask for one, it is asking you to *set* it, not
   to share it.
2. Nothing here signs a transaction or moves money. Those steps are marked and stay yours.

---

## Track A — free, today, no new accounts

The biggest unlock in the repo, and it costs nothing. It ends with login working, which turns
on profiles, DMs, watchlists, votes, push, and real analytics — and it closes a live data
exposure on the way.

### A0. Code precondition — ✅ **done 2026-08-18** (`c66e6064`)

Every user-data write now goes through the SIWE-authed server proxy, which takes the wallet
from the verified JWT rather than trusting the client. Denials surface as toasts instead of
silent no-ops, and a tripwire test fails if a direct anon-key write ever reappears.

Smaller than the plan feared, in two ways worth knowing: seven of the eight writes had already
moved to the proxy in an earlier pass — only `castVote` was still direct — and `castVote` has
no callers, because the vote UI was never wired. So the "kills voting silently" warning was
true of the library, not of a live user path.

**You must redeploy before step A2** (see A5), so the deployed bundle is the one that writes
through the proxy. A1 is read-only and safe to run any time.

### A1. Enumerate what is actually live *(2 minutes, read-only)*

The migration was written against a database read on 2026-08-12. Confirm it still matches
before changing anything. In the **Supabase dashboard → SQL Editor**, run:

```sql
select tablename, cmd, policyname, permissive,
       coalesce(qual, with_check) as expr
  from pg_policies
 where schemaname = 'public'
   and permissive = 'PERMISSIVE'
   and coalesce(qual, with_check) = 'true'
 order by tablename, cmd, policyname;
```

This lists every policy that grants unconditional access. Paste the result back to Claude.

**What it should show:** eight write-side rows across `user_favorites`, `user_profiles`,
`user_watchlist` and `votes` (these are what 015 §1 removes), plus a handful of rows on
`messages`, `native_orders`, `trade_offers` and `revoked_jwts` that are **intended** — those
are a public chat and a public orderbook, and 015 deliberately leaves them alone. Anything
outside those two groups is new information and Claude should look at it before you continue.

### A2. Run 015 §1 — the eight DROPs *(the security fix)*

Still in the SQL Editor, run **Section 1 only** of
`frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql`.
Section 2 is commented out on purpose — leave it commented; it is a separate decision that
needs an aggregate view built first, or the public vote tally goes blank.

Every statement is `IF EXISTS`, so re-running is safe.

**Verify — run BOTH of the file's checks, not just the first.** The second one matters more
than it looks: the `votes` write is an upsert, so it needs **both** owner twins
(`"Owner can insert votes"` *and* `"Owner can update own vote"`) to have survived. If only one
is left, voting writes fail after the drops.

Check one — must return **zero rows**:

```sql
select tablename, cmd, policyname
  from pg_policies
 where schemaname = 'public'
   and permissive = 'PERMISSIVE'
   and cmd <> 'SELECT'
   and coalesce(qual, with_check) = 'true'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
 order by tablename, cmd;
```

Check two — the owner policies must have **survived** (expect one row per command per table,
including both `votes` twins):

```sql
select tablename, cmd, policyname, coalesce(qual, with_check) as expr
  from pg_policies
 where schemaname = 'public'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
 order by tablename, cmd, policyname;
```

### A3. Run 014 — the login fix *(same session, right after)*

Run `frontend/supabase/migrations/014_siwe_nonces.sql` whole. It creates the `siwe_nonces`
table that login has always needed — its absence is why every sign-in returns a 500 today.

⚠️ It **ends with `NOTIFY pgrst, 'reload schema'`**. Do not stop before that line: without it
the table exists but the API keeps insisting it doesn't.

⚠️ **Never run migration 008 after this.** It contains a blanket grant that undoes 014's
protection. If you have already run it at some point, tell Claude — it is repairable, but it
has to be known.

### A4. Prove the lock actually bit *(2 minutes)*

The whole point of A2 is that unauthorized writes now fail. Confirm it, don't assume it:

- With the **anon key** (not the service key), attempt an insert into `user_favorites`.
  You want it to be **rejected** — a permission error, code `42501`. A "not-null violation"
  (`23502`) instead means the policy did *not* bite and the write got through; stop and say so.
- Then load the site and sign in. `/api/auth/siwe?action=nonce` should return **200**, and
  signing should land you logged in.

Tell Claude both results.

### A5. Redeploy, then finish the tail

A code change and any `VITE_*` variable only take effect on a **new Vercel deployment**
(those values are baked in at build time — setting them without redeploying changes nothing).

In Vercel → your project → Deployments → **Redeploy** the latest commit.

Then, still in Vercel → Settings → Environment Variables, set:

| Variable | Value | Why |
|---|---|---|
| `VITE_ANALYTICS_ENDPOINT` | `/api/analytics` | Today every analytics event is printed to the visitor's own console and thrown away |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generate with `npx web-push generate-vapid-keys` | Push notifications; nothing can subscribe until login works, so this belongs here |
| `VITE_VAPID_PUBLIC_KEY` | same public value as above | The browser needs the public half |
| `VAPID_SUBJECT` | `mailto:` your address | Currently points at a dead domain |

**While you are in the environment settings, confirm two that already exist**, because the
write proxy fails closed without them and every write would 503 after login starts working:
`SUPABASE_SERVICE_KEY` must be present, and the SIWE JWT must carry a `jti` claim (a token
without one is rejected with 401). Check, do not change.

Also run migration `013_analytics_events.sql`, then redeploy once more so both halves land.

**When Track A is done, tell Claude.** The entire social tier becomes buildable that hour.

---

## Track B — needs one account, runs in parallel with A

### B1. The indexer host *(the single biggest build unlock)*

The Ponder indexer is finished and running nowhere. It is the chokepoint for the trading
terminal, leaderboards, copy-trading, portfolio APIs, tax reports, and every paid data
product in the top-100 list. Full runbook: [`indexer/DEPLOY.md`](../indexer/DEPLOY.md).

What you do:
1. Create a **Railway** account (recommended in the runbook — managed Postgres in one click,
   and it can host the keeper and API services later too). Budget roughly $5–20/month.
2. Provision Postgres, deploy the `indexer/` directory.
3. Set `PONDER_RPC_URL_1` to an authenticated mainnet RPC (your Alchemy key). Public nodes
   rate-limit hard enough that the historical backfill never finishes.
4. ⚠️ **Put it behind a proxy with a rate limit and never expose the raw port.** Ponder ships
   with no authentication and no rate limiting of its own. This is not optional hardening.
5. In Vercel, set `VITE_INDEXER_URL` to the **public proxy origin, no path**, and redeploy.

Until that variable is set, every indexer-backed surface honestly reports "unavailable" —
there is no fake-data path to worry about. Tell Claude the URL is live and the first consumer
pages get wired immediately.

### B2. Two questions only you can answer — ✅ **answered 2026-08-18**

- **The birth secret.** *Operator holds it (believed).* Set `MEMETICS_BIRTH_SECRET` in Vercel
  as a **server-side** variable — never a `VITE_` one, which would ship it to every browser —
  then redeploy. Do not paste it in chat.

  ⚠️ **It must be the exact secret seacasa issued, not a self-generated one.** It is an
  HMAC-SHA256 *shared* key: `api/_lib/births.js` signs the birth payload with it and the
  island verifies using their copy. A mismatched value fails on their side, not ours.

  **How to tell, without guessing:** after setting it, launch a token (or replay a queued
  birth from the admin Birth Queue panel) and read the response.
  - `200` with `status: enrolled` (or `replay: true`) → **the secret is correct.**
  - `422` with `retryable: false` → **wrong or rotated secret** — the island rejected the
    signature. Nothing retries; it needs the real value.
  - `503 no_secret` → the variable did not reach the deployment (redeploy).
  - `502` → the island's socket is down; retry later, the secret is not implicated.

- **The Squads co-signer.** ✅ *`6VHowW4p…` is the operator's own key.* No stranger co-signs the
  vault holding Solana fee custody. The 2-of-2 → 2-of-3 repair in C2 still matters (a 2-of-2
  cannot repair itself), but this is no longer a trust question.

---

## Track C — start the clock, finish later

### C1. Name the Safe topology *(free, minutes, unblocks the longest chain in the repo)*

Every contract is still owned by one hot key. The re-home has stalled repeatedly because the
runbook demands **15 independent signers** and you have three. **The target is the problem,
not the recruiting.** Pick one:

- **8 keys** — 2-of-3 Admin / 2-of-3 Treasury / 1-of-2 Guardian. The recommended answer.
- **3 keys** — Admin only, self-held on three separate hardware devices.
- **Hold at 15** and accept that the stall continues.

Either of the first two is dramatically better than one hot key across 19 authority surfaces.
Write your answer into `docs/SAFE_REHOME_RUNBOOK.md §3` (or tell Claude and it will), and the
whole downstream chain — signer recruitment, Safe deployment, the 18 ownership transfers —
becomes schedulable.

### C2. Cheap insurance you can do any time

- **Back up the deployer keystore + password** to two offline locations. If that one file is
  lost, 18 mainnet contracts become permanently unownable — there is no renounce path. This is
  the cheapest item on this page and the worst tail risk.
- **Squads 2-of-2 → 2-of-3.** A 2-of-2 cannot repair itself, and the repair *is* a 2-of-2
  transaction — so it is only possible while both keys still work.
- **Add a third owner to the Treasury Safe.** Same argument on the Ethereum side; executable
  today from the existing quorum.

*(These three involve signing. They are yours alone — Claude will not and cannot do them.)*

---

## Do NOT do these yet

| Tempting | Why not |
|---|---|
| Run 014 before 015 §1 | Publishes every user's rows to anyone holding the anon key on day one |
| Publish `VITE_SOLANA_DBC_CONFIG` | The live config opens at a 99% fee — every launch untradeable for hours. Needs a v2 config first |
| Call `setGaugeController` from the hot key | One-shot, no rotation path in the deployed bytecode. A typo bricks the bribe market permanently |
| Fund the Solana deploy authority | Buys the ability to call a program that no longer exists |
| Turn on the swap fee | The collection path isn't built — the fee would attach to routes nobody takes |
| Arm branch protection | Now *possible* (the checks report correctly), but do it after Track A so you aren't fighting two things |

---

## Where each track lands you

| You finish | You unlock |
|---|---|
| Track A | Profiles, DMs, watchlists, votes, push, real analytics — the entire social tier of the top-100 list |
| B1 | The trading terminal, leaderboards, copy-trading, portfolio/tax APIs — the largest revenue cluster |
| B2 birth secret | Tokens launched here start accruing Heat from birth instead of waiting |
| C1 | The ownership migration, and with it the audits, the governance un-gates, and the lending deploy |
