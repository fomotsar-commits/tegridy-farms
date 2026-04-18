# API Reference

Tegridy Farms exposes a small set of serverless HTTP endpoints for off-chain data (order book, quotes, subscriptions, notifications). On-chain interaction happens entirely via wagmi/viem against the deployed contracts — the API is **only** for data that doesn't belong on-chain.

All endpoints live under `frontend/api/*` (Vercel serverless functions) and are rate-limited via Upstash Redis.

## Base URL

Production: `https://tegridyfarms.xyz/api`

In development, the API is served by Vercel's dev proxy at `http://localhost:3000/api` when running `vercel dev`.

## Authentication

Most endpoints require a Sign-In-With-Ethereum (SIWE) session cookie. Obtain it via:

```
POST /api/auth/nonce       → { nonce }
POST /api/auth/verify      → { ok: true } (sets session cookie)
GET  /api/auth/session     → current session or 401
POST /api/auth/logout      → clears session cookie
```

Session cookies are `httpOnly`, `sameSite=strict`, and expire after 7 days. See [`frontend/supabase/migrations/001_siwe_auth_rls.sql`](../frontend/supabase/migrations/001_siwe_auth_rls.sql) for the RLS policies that authenticate table access.

## Rate limiting

Every request is rate-limited by IP + wallet address (when known) via Upstash sliding-window counters. Default caps:

- **Public (unauth):** 60 requests / minute per IP
- **Authenticated:** 300 requests / minute per wallet
- **Quote endpoints:** 120 requests / minute per IP

If `UPSTASH_REDIS_REST_URL` is unset (dev/preview), rate limiting fails **open** — log warning and pass request through. Never ship to production without Upstash configured.

## Endpoints

### Orderbook

- `POST /api/orderbook` — create an on-chain-settled order (native limit order). Requires SIWE session. Persists to `native_orders` table for relayer visibility.
- `GET  /api/orderbook?trader={address}` — list open orders for a trader.
- `DELETE /api/orderbook/{id}` — cancel an order (must be the order's trader).

### Quote

- `GET /api/quote?from={token}&to={token}&amount={uint}` — off-chain price quote. Aggregates native DEX + Uniswap V2 + fallback routing. Returns best route, estimated slippage, estimated gas.

### Price

- `GET /api/price/toweli` — TOWELI/USD reference price (GeckoTerminal + Chainlink composite). Cached 30s.

### Trade offers

- `POST /api/offers` — create a peer-to-peer trade offer (NFT-for-NFT, NFT-for-ETH).
- `GET  /api/offers?listing={nft}` — list open offers for an NFT.
- `POST /api/offers/{id}/accept` — accept an offer (settles on-chain via the Nakamigos contract).

### Push subscriptions

- `POST /api/push/subscribe` — register a browser push-subscription endpoint (persists to `push_subscriptions` table).
- `DELETE /api/push/subscribe` — unsubscribe.
- `POST /api/push/test` — send a test notification to the caller's subscriptions (authenticated only).

### Proposals (governance snapshot mirror)

- `GET /api/proposals` — list governance proposals from GaugeController indexer.
- `GET /api/proposals/{id}` — proposal detail + current vote tallies.

## Privacy & data collection

The API does **not**:

- Collect or log IP addresses beyond rate-limit window TTL
- Store browser fingerprints, cookies, or third-party analytics
- Sell, share, or expose wallet data to external services

The API **does** persist:

- Wallet addresses that create orders / offers (necessary for order book functionality)
- Browser push subscription endpoints (only when user opts in)
- SIWE session tokens (httpOnly cookies with 7-day expiry)

See [`frontend/src/pages/PrivacyPage.tsx`](../frontend/src/pages/PrivacyPage.tsx) for the complete privacy policy.

## Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created (POST that persisted data) |
| 204 | No Content (DELETE success) |
| 400 | Invalid request body / query params |
| 401 | Unauthenticated |
| 403 | Authenticated but not authorised for this resource |
| 404 | Not found |
| 409 | Conflict (duplicate order / race) |
| 429 | Rate limit exceeded — read `Retry-After` header |
| 500 | Server error — reported via Sentry if configured |

## Error response shape

All error responses are JSON:

```json
{
  "error": "short code (e.g. 'rate_limited')",
  "message": "Human-readable explanation",
  "requestId": "for support triage"
}
```

## SDK / client

The frontend consumes these endpoints via plain `fetch()` with a `useSWR` / `useQuery` layer. There is no published JS SDK; integrators are expected to call endpoints directly.

## Contributing

Adding a new endpoint:

1. Create `frontend/api/<your-endpoint>.ts` (or `.js`).
2. Wrap in the standard rate-limit middleware from `frontend/api/_lib/ratelimit.js`.
3. If it persists data, add a Supabase migration under `frontend/supabase/migrations/` with RLS policies.
4. Add the endpoint to this file with request/response shape.
5. Add a test in `frontend/api/__tests__/` (test infrastructure WIP).

---

*Last updated: 2026-04-17.*
