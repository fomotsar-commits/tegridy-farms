# Deploying the Tegridy indexer

Ponder 0.8 app, mainnet only, complete and deployed nowhere. Everything on the
client side is already built and waiting: `frontend/src/lib/indexer/client.ts`
plus the `useIndexed*` hooks read `VITE_INDEXER_URL` and self-gate to an
explicit "indexer unavailable" state while it is unset. Setting that one
variable to the URL produced by this runbook is what turns them on.

**The hosting choice is the operator's** — it costs money and creates an
account this repo cannot create. Everything up to that decision is done.

---

## 0. What you are deploying

| Piece | Where |
|---|---|
| Subscriptions, ABIs, start blocks | `ponder.config.ts` |
| Tables | `ponder.schema.ts` |
| Event handlers | `src/index.ts` |
| HTTP surface (GraphQL + CORS + query-complexity limits) | `src/api/index.ts` |
| Env vars | `.env.local.example` (the annotated list — read it, do not guess) |

Chain: Ethereum mainnet, start block **25263328** (the DeployMVP relaunch
batch). Historical sync from there is the long pole on first boot.

---

## 1. Hosting — recommendation, and why

**Recommended: Railway.** Reasons, in the order they matter here:

1. **Managed Postgres in the same project.** Ponder needs a real Postgres to
   survive a restart; on PGlite (the no-`DATABASE_URL` fallback) every redeploy
   re-indexes from block 25263328. Railway provisions it in one click and
   injects `DATABASE_URL` + `DATABASE_PRIVATE_URL` automatically.
2. **It is where the next three services land.** The keeper (F4), the API host
   (F5) and the realtime fan-out (F9) all need to sit next to this Postgres.
   Choosing a host that colocates them avoids paying cross-provider egress and
   latency on every one of them later.
3. **Long-running process, not serverless.** Ponder holds a websocket/poll loop
   and its own HTTP server; it is the wrong shape for Vercel. Related: the
   12-function Vercel cap is real — see `frontend/api/SERVERLESS_BUDGET.md`.
   **Do not add an `api/indexer.js` function.** The frontend talks to this
   service directly.

Fly.io is the reasonable alternative (cheaper at idle, better regions) at the
cost of provisioning Postgres separately. Anything without a persistent
Postgres attached is not a candidate.

---

## 2. Provision

1. Create the project and add a **Postgres** service. Note that Railway sets
   `DATABASE_URL` and `DATABASE_PRIVATE_URL`; Ponder prefers the private one,
   which is correct — leave both alone.
2. Add a service from this repo with **root directory `indexer/`**.
   - Build: `npm ci`
   - Start: `npm run start` (= `ponder start`)
   - Node: >= 20 (`package.json` engines).
3. Set the environment variables below.

### Environment variables

Exactly what the code reads. `.env.local.example` carries the same list with
the full annotations; this table is the deploy-time checklist.

| Variable | Read by | Required? | Notes |
|---|---|---|---|
| `PONDER_RPC_URL_1` | `ponder.config.ts` | **Yes** | Authenticated mainnet RPC (Alchemy). Unauthenticated public nodes rate-limit `eth_getLogs` hard enough to stall the historical sync. |
| `PONDER_RPC_URL_2..4` | `ponder.config.ts` | Recommended | Fallback endpoints. viem's `fallback` transport rotates on failure; with only one URL an outage stalls the sync. |
| `DATABASE_URL` / `DATABASE_PRIVATE_URL` | ponder | **Yes** | Postgres. Private wins when both are set. Without either, Ponder uses PGlite and loses state on restart. |
| `DATABASE_SCHEMA` | ponder | No | Defaults to `public`. Must stay stable across deploys of the same instance. |
| `PORT` | ponder | Host-set | GraphQL + health server. Defaults to 42069. Keep it private (§3). |
| `ALLOWED_ORIGINS` | `src/api/index.ts` | No | Comma-separated EXTRA browser origins for the `/graphql` CORS allowlist, on top of the three baked-in production origins. Add the preview domain here. |
| `TEGRIDY_STAKING_ADMIN_ADDRESS` | `ponder.config.ts` | No | Overrides the baked relaunch StakingAdmin address. Only for a different deployment. |
| `SWAP_FEE_ROUTER_ADMIN_ADDRESS` | `ponder.config.ts` | No | Same, for SwapFeeRouterAdmin. |
| `PONDER_LOG_LEVEL` | ponder | No | `error｜warn｜info｜debug｜trace`. |
| `PONDER_TELEMETRY_DISABLED` | ponder | No | Set to `1` to opt out. |

A wrong address override does not error — it indexes nothing and the table
stays empty, which is indistinguishable from "no governance activity" at a
glance. Verify against `contracts/broadcast/*/1/run-latest.json` before setting
either override.

---

## 3. The reverse proxy is MANDATORY, not a hardening nicety

Ponder ships **no authentication and no rate limiting**. The M3 note in
`ponder.config.ts` states this as a deploy requirement, and it is repeated here
because it is the one step that cannot be done in indexer code:

1. **Never expose the Ponder port to the public internet.** Bind the service
   privately; the proxy is the only public listener.
2. **Put a reverse proxy / gateway in front** (Cloudflare, the platform edge,
   nginx) enforcing **per-IP request and connection rate limits**.
3. **Expose only `/graphql`, `/health`, `/ready`.** Not `/status`, not
   `/metrics` — `/metrics` is an unauthenticated Prometheus dump and `/status`
   details sync internals.
4. If the API is meant to be private, the proxy enforces auth. Ponder provides
   none.

What is already done in code, and is *defence in depth only*: `src/api/index.ts`
re-mounts the GraphQL middleware with `maxOperationDepth: 12`,
`maxOperationAliases: 20`, `maxOperationTokens: 1000`, and replaces Hono's
default `origin: "*"` CORS with an explicit allowlist. Those cap the cost of a
single query. They do not cap the *number* of queries — that is the proxy's job,
and nothing in this repo can do it.

### Endpoints, and what each one actually means

Registered by the framework before our custom routes, so they survive the
`src/api/index.ts` mount:

| Path | Meaning |
|---|---|
| `/health` | Process is alive. **200 with an empty body, always** — it does not check the database or the sync. A green `/health` says nothing about data freshness. |
| `/ready` | 200 only when historical sync is complete on every chain; 503 with `Historical indexing is not complete.` otherwise. This is the liveness gate that matters for traffic. |
| `/status` | JSON `{ <network>: { block: { number, timestamp } \| null, ready } }`. Keep it internal. |
| `/metrics` | Prometheus text. Keep it internal. |
| `/graphql` (and `/`) | The GraphQL API. |

Point the platform's **health check at `/ready`**, not `/health` — otherwise a
process that is up but has indexed nothing gets traffic, and every consumer
sees empty result sets that look exactly like "there is no data".

The same distinction is what the frontend client encodes: the GraphQL
`_meta { status }` field carries `ready` and the synced block, every hook query
requests it, and an empty page from a not-ready indexer surfaces as
`backfilling`, never as a legitimate zero.

---

## 4. Bring-up

1. Deploy. Watch the logs — the first boot backfills from block 25263328 and
   takes a while; `/ready` answers 503 for the whole of it.
2. `curl https://<internal>/ready` → expect 200 once the backfill completes.
3. `curl -s -X POST https://<host>/graphql -H 'content-type: application/json' \
   -d '{"query":"{ _meta { status } }"}'` → expect a block number within ~10
   blocks of mainnet head.
4. Spot-check one table that should have rows, e.g.
   `{ swaps(limit: 1, orderBy: "timestamp", orderDirection: "desc") { items { id timestamp } } }`.
5. Rate-limit proof: hammer `/graphql` from one IP and confirm the proxy starts
   refusing. If it does not, step 3 of §3 is not done.
6. RPC fallback proof: revoke or break `PONDER_RPC_URL_1` and confirm the sync
   continues on `_2`. This is the failure the fallback transport exists for and
   it is worth proving once, deliberately, rather than during an outage.

## 5. Turning on the frontend

Set `VITE_INDEXER_URL` in the Vercel project to the **public proxy origin**
(no path — the client appends `/graphql` and `/health` itself), then redeploy
the frontend.

Until it is set, `isIndexerConfigured()` is false and every hook reports
`unavailable` with the reason "not configured". That is the intended resting
state, and it is why nothing needed to be feature-flagged separately: the
absence of the URL *is* the flag.

Verify the reverse of it too — unset the variable, redeploy, and confirm the
surface reads "unavailable" rather than rendering zeros or a stale cache.

---

## 6. Known gaps (so silence is not mistaken for absence)

- **Solana is not indexed by THIS service and never will be** — Ponder is
  EVM-only. The `indexer-solana/` leg is a separate Node process that writes
  `solana_`-prefixed tables into this same Postgres; see
  `indexer-solana/DEPLOY.md`. It is a second deploy on the same project, with
  its own env and its own `/ready`. Nothing here needs changing for it, and
  nothing here reports on it: a green `/ready` on this service says nothing
  about whether Solana is being indexed.
- **Factory governance is indexed as keyed timelock rows**
  (`timelockProposal`, `contract = "TegridyFactory"`), which say *that* a
  proposal is pending but not *which pair or token* it is about. The `key` is
  `keccak256(TYPE_CONSTANT ‖ subject)`, so a caller with a candidate subject can
  compute it forward; enumerating pending subjects needs a schema addition that
  has not been made. See the ABI comment in `ponder.config.ts`.
- **No new-pair NOTIFY trigger yet** — the F9 fan-out consumer has nothing to
  subscribe to.
- **`generated/schema.graphql` is gitignored build output** and the copy in a
  working tree may predate the current `ponder.schema.ts`. Regenerate with
  `npm run codegen`; never treat it as the source of truth.
