# Deploying the Solana indexing leg

Small Node service, no framework, designed to run **beside** the Ponder app
against the **same Postgres**. It follows Meteora DBC pools: trades, and the
partner fees actually claimed out of them. Everything it writes is prefixed
`solana_`, so one query surface serves both chains and neither service owns the
other's tables.

**The hosting and the RPC key are the operator's** — they cost money and create
accounts this repo cannot create. Everything up to that boundary is done.

---

## 0. What you are deploying

| Piece | Where |
|---|---|
| Env → config, and the "not configured" surface | `src/config.js` |
| Solana JSON-RPC over fetch (no web3.js) | `src/rpc.js` |
| Transaction → facts, or an explicit refusal | `src/classify.js` |
| Backward walk to the resume point, and its bound | `src/pagination.js` |
| The tick, and the whole failure policy | `src/ingest.js` |
| Postgres writes (the only module with SQL) | `src/store.js` |
| `/health` `/ready` `/status` | `src/health.js` |
| Tables | `sql/001_solana_tables.sql` |
| Env vars | `.env.local.example` (the annotated list — read it, do not guess) |

One runtime dependency (`pg`). Node >= 20 (`package.json` engines) — `fetch` is
a global there, which is why there is no HTTP client either.

Tests: `cd frontend && npx vitest run --root ../indexer-solana --environment node`.
They use the vitest installed in `frontend/` because this service ships no dev
tree; CI runs exactly that command in the **Solana indexer unit tests** step.

---

## 1. Hosting

**The same Railway project as `indexer/`.** This is not a preference, it is the
design: the service writes into the Ponder app's database, so it must be able
to reach it privately. Anywhere else means either exposing that Postgres or
paying cross-provider egress on every write.

Add a service from this repo with **root directory `indexer-solana/`**:

- Build: `npm ci`
- Start: `npm run start`
- Node: >= 20

It is a long-running poll loop, not a request handler — the same reason
`indexer/` is not on Vercel applies here, with the extra one that
`frontend/api/SERVERLESS_BUDGET.md` has no room. **Do not add an `api/solana-indexer.js`.**

---

## 2. Apply the schema

`sql/001_solana_tables.sql` is idempotent. Run it once against the Ponder
Postgres, from a shell with DDL rights:

```
cd indexer-solana && DATABASE_URL=… npm run migrate
```

Kept separate from boot on purpose: DDL rights and runtime rights are not the
same grant, and an operator is entitled to give the service only the second.
The service checks for `solana_watch` at boot and exits with this command in
the message if it is absent — rather than throwing "relation does not exist"
once per tick forever while `/health` answers 200.

---

## 3. Environment

`.env.local.example` carries the same list with the full annotations; this is
the deploy-time checklist.

| Variable | Required? | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | **Yes** | Authenticated mainnet-beta endpoint. `getSignaturesForAddress` + one `getTransaction` per signature is the exact pattern public endpoints throttle hardest. |
| `SOLANA_RPC_URL_2..4` | Recommended | Tried in order when one is *unreachable*. A refusal or a pruned range does not rotate — another node answers those the same way. |
| `DATABASE_URL` / `DATABASE_PRIVATE_URL` | **Yes** | The Ponder Postgres. Private wins when both are set. |
| `SOLANA_WATCH` | **Yes** | JSON array of pools. Without it the service starts, indexes nothing, and says so on `/ready`. |
| `SOLANA_STATUS_PORT` | No | Unset = no listener at all. |
| `SOLANA_STALE_AFTER_MS` | No | Default 120000. How stale the last successful tick may be before `/ready` turns 503. |
| `SOLANA_POLL_INTERVAL_MS` | No | Default 15000, clamped to [2000, 600000]. |
| `SOLANA_SIGNATURE_PAGE_LIMIT` | No | Default 200, clamped to the cluster's own 1000. |
| `SOLANA_MAX_PAGES_PER_TICK` | No | Default 20. See §6. |

### The archival question, which is separate from the rate-limit one

A standard RPC node retains only recent signature history. If a watched pool is
older than that retention, the span the node cannot serve is written to
`solana_gap` as `pruned-history` and **stays** there — it is not recoverable by
waiting or retrying, only by pointing `SOLANA_RPC_URL` at an archival provider
and letting the service walk it again. Decide this before the first launch, not
after: the cheapest moment to have full history is while it is still recent.

---

## 4. Endpoints

Only served when `SOLANA_STATUS_PORT` is set. Same three paths and same
meanings as the Ponder app (`indexer/DEPLOY.md` §3), so there is one vocabulary
for the whole data spine.

| Path | Meaning |
|---|---|
| `/health` | The process is up. 200 always. Says nothing about the database, the cluster, or the data. |
| `/ready` | 200 only when the service is fully configured **and** a tick succeeded within `SOLANA_STALE_AFTER_MS`. 503 with a `reason` naming what is wrong. Point the platform health check here. |
| `/status` | JSON: readiness, plus per-pool cursor, counts, and open gaps. Keep it internal. |

**A green `/ready` does not mean the data is complete.** That is a separate
field and it is deliberately not folded in: a service can be perfectly live,
perfectly fresh, and still be missing a week of history it could not read. One
boolean meaning both would get set for the first reason and believed for the
second. `/status` reports `complete`, `openGaps` and `standingLimitations`
separately, and `solana_launch_summary` carries the same three per pool.

No data endpoint exists here on purpose. The rows are read from Postgres by
whatever fronts them (the F5 api host); a second unauthenticated copy of that
surface with none of its controls is the exact mistake `indexer/DEPLOY.md` §3
spends a page on.

---

## 5. Bring-up

1. Apply the schema (§2), set the env (§3), deploy.
2. `curl http://<internal>:<port>/ready` → 503 until the first tick lands, with
   the reason. If the reason names a variable, that is the answer.
3. `curl -s http://<internal>:<port>/status | jq` → one entry per watched pool,
   each with a `cursor_signature` that moves between calls.
4. Make a real trade on a watched pool, wait one poll interval, then:
   `select * from solana_dbc_trade order by slot desc limit 1;`
   Direction, base and quote amounts are raw base units — divide by the mint's
   decimals yourself; the service never stores a float.
5. Claim partner fees to the configured Squads vault and confirm a
   `solana_fee_claim` row appears with that receiver.
6. Read the gaps once, deliberately:
   `select pool, kind, standing, detail from solana_gap where resolved_at is null;`
   Every watched pool should carry `accrual-not-indexed`, and a pool with no
   `feeReceiver` should also carry `fee-receiver-unset`. Anything else is a
   real hole and §6 says what each one means.
7. RPC fallback proof: break `SOLANA_RPC_URL` and confirm the logs show a
   rotation to `_2` and the cursor keeps moving. Worth proving once,
   deliberately, rather than during an outage.

---

## 6. Known-unknowns — what this leg does NOT know

Every one of these is a **row in `solana_gap`**, not a footnote. The whole point
of the table is that a consumer reading only SQL cannot mistake an outage for a
quiet market.

**Standing (`standing = true`) — true on a perfectly healthy day:**

- **`accrual-not-indexed`.** Partner fees *accrued but not yet claimed* live in
  the pool's account state. Reading them means decoding a layout this repo does
  not vendor, and the on-chain program is under a licence that forbids forking
  it (`docs/CURVE_FORK_EVALUATION.md`). So this service indexes **claims**, and
  `claimed_fee_total_observed` is fees **collected**, never fees **earned**. The
  column is named that way because a column called `fees` would be believed.
- **`fee-receiver-unset`.** With no `feeReceiver` in `SOLANA_WATCH` there is
  nothing to recognise a claim by, so claims for that pool are not indexed at
  all — which is not the same as a pool that has never been claimed from.

**Faults (`standing = false`) — should not be there:**

- **`history-not-backfilled`** — cold start with no `startSignature`. Only as
  far back as one bounded walk reached was ever requested.
- **`backlog-truncated`** — the resume point was not reached inside one tick's
  page budget (`SOLANA_MAX_PAGES_PER_TICK`). The named slot span was skipped so
  the service could keep making progress at the head. Raise the budget and it
  will not recur; the already-skipped span needs a manual re-walk.
- **`pruned-history`** — the RPC refuses the range as no longer retained. See §3.
- **`tx-unavailable`** — the cluster listed a signature and then would not hand
  over the transaction.
- **`undecodable`** — the transaction was read and its token movements do not
  resolve to one trade for this pool. Routed or batched swaps land here: which
  of several base-mint deltas belongs to this pool is not decidable from
  balances, and picking the largest would write a confident wrong number.

### The rule the whole service is built on

An error either **advances the cursor and leaves a row saying what was lost**,
or it **advances nothing at all**. Which one applies depends only on whether
the failure is transient:

- transient (the cluster did not answer) → advance nothing, retry next tick, no
  gap row: nobody told us anything is missing.
- terminal (the cluster will never answer, or answered something we cannot
  attribute) → advance past it, and write the gap row.

There is no third option. Skipping without advancing re-fails forever; advancing
without a row deletes the span from history with nothing recording it.

---

## 7. What this leg is NOT

- **Not a launch discovery service.** A pool it was never told about is not
  indexed. That is visible in `solana_watch` rather than inferred from an empty
  table.
- **Not a price feed.** Amounts are raw base units of the two mints. No USD, no
  oracle, no float anywhere in the write path.
- **Not a fee earner.** It reads. It holds no keys and signs nothing — which is
  also why it does not depend on `@solana/web3.js`: a read-only indexer has no
  business importing a signing surface.
