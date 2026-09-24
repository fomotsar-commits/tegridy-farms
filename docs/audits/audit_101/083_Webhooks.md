# Agent 083 — Webhook Signature Handling & Idempotency

**Scope:** `frontend/api/**` — incoming-webhook endpoints, HMAC verification, replay/idempotency, dead-letter handling, retry semantics, IP allow-listing.

**Verdict:** **NO INCOMING WEBHOOK SURFACE.** The repo exposes zero third-party webhook receivers. There is no Stripe/Alchemy-Notify/Svix/Inngest/QStash/GitHub-style HMAC-signed inbound endpoint to attack. The audit hunt list (HMAC absent, timing attack, replay nonce, idempotency-key, out-of-order delivery, DLQ, 5xx retry, IP allow-list) is therefore **not applicable** to the current frontend/api surface.

---

## 1 — Inventory of `frontend/api/` files

| File | Type | Direction | Auth model |
| --- | --- | --- | --- |
| `frontend/api/alchemy.js` | RPC/NFT proxy | Outbound (browser → Alchemy via Vercel fn) | Origin allow-list + rate-limit |
| `frontend/api/etherscan.js` | TX-history proxy | Outbound | Origin allow-list + rate-limit |
| `frontend/api/opensea.js` | OpenSea API proxy | Outbound | Origin allow-list + rate-limit |
| `frontend/api/orderbook.js` | Native Seaport orderbook (POST create / cancel / fill) | Inbound user POSTs | **EOA wallet signature** (`recoverMessageAddress`) — not a third-party webhook |
| `frontend/api/auth/siwe.js` | SIWE login (GET nonce, POST verify, DELETE logout) | Inbound user POSTs | **EIP-4361 signature verification** |
| `frontend/api/auth/me.js` | Session check | Inbound | JWT cookie |
| `frontend/api/supabase-proxy.js` | Supabase REST proxy | Inbound user reqs | JWT cookie |
| `frontend/api/v1/index.js` | Public dev API (read-only) | Outbound proxy | Public + rate-limit |
| `frontend/api/_lib/ratelimit.js` | Upstash sliding-window limiter | Helper | n/a |
| `frontend/api/_lib/proxy-schemas.js` | Zod request schemas | Helper | n/a |

**No file in `frontend/api/**` accepts an incoming HMAC-signed payload from a third party.** All `signature` references in the codebase are EOA wallet signatures from end users — the inverse trust model from a webhook (server *receives* user signature; user is the proven sender).

---

## 2 — `vercel.json` route audit

`frontend/vercel.json` rewrites whitelist (lines 59-69):

- `/api/odos`, `/api/cow`, `/api/lifi`, `/api/kyber`, `/api/openocean`, `/api/paraswap` — pure outbound aggregator pass-throughs.
- `/api/alchemy`, `/api/opensea`, `/api/orderbook` — internal Vercel fns above.
- catch-all `/(.*)` → `/index.html`.

No `/webhook`, `/callback`, `/notify`, `/hook`, `/events/incoming`, `/stripe`, `/payment-update`, `/cdp-event`, or `/alchemy-notify` route exists. No Vercel cron config (`crons` key absent). No queue worker / DLQ entry.

---

## 3 — Search-pattern coverage (negative results)

| Pattern (case-insensitive) | Hits in `frontend/api` (excl. node_modules) |
| --- | --- |
| `webhook` | 0 |
| `stripe` | 0 |
| `hmac` | 0 |
| `x-hub-signature`, `x-signature`, `x-stripe-signature`, `x-alchemy-signature` | 0 |
| `svix` | 0 |
| `inngest` | 0 |
| `qstash` | 0 |
| `verifyWebhookSignature` / `constructEvent` | 0 |
| `Idempotency-Key` (header consumption) | 0 |
| `crypto.timingSafeEqual` on inbound headers | 0 |

The single `webhook` glob hit `frontend/node_modules/@coinbase/cdp-sdk/.../webhooks/webhooks.js` is **vendor SDK boilerplate** (an outbound *client* for managing webhooks at Coinbase's end, never wired into our handler chain). No file under `frontend/src/**` imports it.

The grep matches for `nonce|signature|idempoten` resolve to:

- `frontend/api/auth/siwe.js` lines 124-220 — SIWE login flow. Nonce is server-generated, single-use (atomic DELETE-then-verify at line 187-200), signature verification uses the `siwe` library's `verify()` with explicit `time/domain/nonce` params (line 210-215). This is correct for SIWE; not a webhook.
- `frontend/api/orderbook.js` lines 232-252 — staleness window (`MAX_SIGNATURE_AGE_SEC = 300`) on Seaport `startTime` to bound replay window for create-order signatures. Recovery uses `recoverMessageAddress` (line 305) and matches `params.offerer` (line 309). Not a webhook.
- `frontend/api/auth/siwe.js` line 279 — `// ON CONFLICT DO NOTHING — double-logout is idempotent.` — concerns logout JWT-revocation insert, not webhook idempotency.

---

## 4 — Why "no webhook surface" is a security positive (and a watch-item)

Currently the system has **no inbound trust boundary that depends on HMAC verification**. All inbound auth is wallet-signature-based (EIP-191 / EIP-4361), where the *user* is the signer and the server merely recovers and matches an address. This sidesteps the entire webhook attack class.

**However**, several integrations *could* later motivate adding a webhook receiver:

1. **Alchemy Notify** for NFT-transfer / address-activity push (would replace some `getNFTSales` polling). Alchemy signs with `X-Alchemy-Signature` (HMAC-SHA256 of body, hex-encoded).
2. **Stripe** if fiat onramp / paid pro tier ships (sends `Stripe-Signature` with timestamp + `v1` HMAC; constant-time compare mandatory).
3. **OpenSea Stream API** — currently WebSocket-based, but a future push variant is plausible.
4. **Coinbase CDP** — the SDK is already in `node_modules` (unused). If activated, CDP signs with HMAC-SHA256 in `X-CC-Webhook-Signature`.
5. **GitHub Actions / Vercel deploy hooks** — usually outbound from GitHub to Vercel, not user-handled, but custom CI hooks exist.

If any of these get wired in, the handler **must**:

- (A) Reject any request lacking the canonical signature header.
- (B) Compute HMAC over the **raw request body** (not parsed JSON — this is the #1 webhook bug; Vercel's default `req.body` parsing rebuilds JSON with key-order/whitespace drift that breaks verification). Use `export const config = { api: { bodyParser: false } }` and read the raw stream.
- (C) Compare digests with `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))` — never `===`.
- (D) Enforce a **timestamp window** (Stripe-style: ±5 min) by hashing `t.{timestamp}.{body}` and rejecting old timestamps even if signature is valid (replay defense).
- (E) Persist a `(provider, event_id)` tuple in a Postgres unique-index table (or Upstash key with TTL) and **return 200 on duplicate** — never re-process. The endpoints that mutate state on receipt (e.g. Alchemy address-activity → marking an order filled in `native_orders`) are exactly where double-credit risk lives.
- (F) Apply an **IP allow-list at the edge** (Vercel firewall rules) for providers that publish CIDR ranges (Stripe, Alchemy do; GitHub does). Treat this as **defense-in-depth, not primary auth** — HMAC is primary.
- (G) Persist failed deliveries to a dead-letter table (`webhook_deadletter` with raw body + headers + error) and return 5xx so the provider retries with its built-in backoff. Do **not** swallow errors with 200 — that drops events permanently.
- (H) Order events by `provider_event_id` or `block_number + log_index` (for chain notifications) and reject monotonic-decreases on a per-resource basis (e.g. an order's status cannot move from `filled` back to `active`).

Until that work is undertaken, none of these failure modes can occur because the surface does not exist. **Recommendation: prefix any future webhook handler with `/api/webhooks/<provider>` and write a shared `_lib/verifyWebhook.js` that enforces (A)–(E) uniformly so individual providers don't re-implement.**

---

## 5 — Adjacent in-scope concerns (signature-bearing endpoints that *aren't* webhooks but share threat model)

These are not webhook surfaces, but the audit hunt list overlaps in two places worth a note:

### 5a. `orderbook.js` create-order replay window — OK but tight

`MAX_SIGNATURE_AGE_SEC = 300` (5 min). The signed message includes `StartTime: ${startSec}` so replays past 5 min fail. This is the project's only existing replay-defense pattern. Code path: lines 232-254. No idempotency table; duplicate POST with same signature would create a duplicate `native_orders` row with the same `signature` value. **Risk: low** — `order_hash` (computed from canonical Seaport params) is the natural unique key; the current schema (lines 49-67 in orderbook.js comments) does not show `order_hash UNIQUE`, so a duplicate POST with identical body could create two rows with the same hash. Worth an explicit `UNIQUE (order_hash)` index — but this is outside webhook scope; flagging only because the threat model is sibling.

### 5b. `siwe.js` nonce single-use — OK

Atomic `DELETE … WHERE nonce = ? AND expires_at > now() RETURNING nonce` (line 187-192) prevents double-claim races. Loser sees empty result and gets `400 Invalid or expired nonce` (line 198-200). This is the closest thing to a "replay nonce on incoming auth" pattern in the codebase and it's correctly implemented.

---

## 6 — Final tally

| Hunt item | Status |
| --- | --- |
| Webhook without HMAC (accept-anyone) | **n/a — no webhook** |
| Constant-time compare absent | **n/a — no webhook** |
| Replay nonce absent | **n/a — no webhook** (SIWE nonce flow correctly implemented) |
| Idempotency-Key not enforced | **n/a — no webhook** |
| Out-of-order webhook handling | **n/a — no webhook** |
| Missing dead-letter handling | **n/a — no webhook** |
| No retries on 5xx | **n/a — no webhook** |
| Webhook IP allow-list absent | **n/a — no webhook** |

**Findings counted: 0 critical, 0 high, 0 medium, 0 low.**
**Forward-looking recommendations: 1 (build the `_lib/verifyWebhook.js` helper *before* the first provider integration, not after).**
