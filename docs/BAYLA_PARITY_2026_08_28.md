# The Bayla parity sweep — market, tape, distribution, and the lighthouse

*Written 2026-08-28. Companion commit on `mvp-launch`, not pushed. Every figure
below was read live in a browser against the running app, not inferred.*

## What the bungalow was missing

`BAYLA_BUNGALOW.md` gave her an identity: hero, lore, farm panel, gallery wing,
doors. What it never gave her was a single **market fact**. Walking `/bayla`,
`/farm` and `/dashboard` in the browser, the gaps were:

| Gap | Why it was there |
|---|---|
| No price chart | `components/chart/PriceChart.tsx` was hardcoded to `networks/eth/pools/<TOWELI_WETH_LP>` and rendered **only** on `DashboardPage` — which a token-first bungalow replaces wholesale. So it appeared nowhere in her skin. |
| No price / volume / liquidity / FDV | The home page's stat pills are `!bungalowIdentity`-gated (they are TOWELI-denominated) and nothing replaced them. |
| No sign of life | `AppLayout` mutes `LiveActivity` in a bungalow for the same reason. |
| No holder view | Only an outbound link to `/scan`. |
| Lighthouse pool read as a permanent outage | A dev-proxy bug — see §4. |
| "Pro Charting" (`/chart`) marked SOON | ~~It builds candles from the EVM Ponder indexer's `TegridyPair` swaps. It can **never** chart a Solana pool; this is not a fix, it is a category mismatch, and it stays SOON.~~ **Rewritten 2026-09-02:** the reasoning held only while the page's single source was that indexer. `/chart` now charts any registry `market` — Solana included, on the same GeckoTerminal OHLCV rail this document put behind Bayla's own strip — and the indexer is an optional second source. |

## 1. The market — chart + numbers

`components/bungalow/BungalowMarket.tsx`, on her home page and her dashboard.

**The chart is the venue's own**, now parameterised. `lib/chart/market.ts` holds
a `ChartMarket = { network, pool, label }`; `PriceChart` takes it as a prop and
defaults to `TOWELI_MARKET`, so every pre-existing call site is byte-identical
in behaviour. Verified side by side: the classic dashboard still draws
TOWELI/WETH from Ethereum.

⚠️ **A bug caught in the parameterisation**: the in-memory OHLCV cache was keyed
by *timeframe alone*. Harmless with one pool; the moment a second existed it
becomes a cross-pool cache and Bayla's chart would have drawn TOWELI's candles
under her own ticker, with no error anywhere. The key now includes the pool, and
`lib/chart/market.test.ts` pins it.

**The numbers** come from `hooks/usePoolMarket.ts` (GeckoTerminal pool endpoint,
zod-validated per R080). Live read 2026-08-28: price **$0.000563**, 24h
**+0.16%**, liquidity **$67.3k**, 24h volume **$10.1k**, FDV **$559k**,
110 buys / 91 sells from 52 buyers / 47 sellers.

**FDV is labelled FDV.** GeckoTerminal returns `market_cap_usd: null` for her —
there is no circulating-supply record upstream — so the strip shows FDV and says
what it is. Printing FDV under "Market cap" is exactly the quiet substitution
`STAKING_LOOK_2026_08_24.md` exists to prevent. Pinned by a test.

**Nothing polls.** One read per mount plus a reader-driven Refresh, so the strip
can never imply a liveness the venue does not run. An unread figure renders "—";
a real zero renders 0. Those are different facts and the test suite says so.

## 2. The trade tape

`components/bungalow/BungalowTrades.tsx` + `hooks/usePoolTrades.ts` — the honest
replacement for the muted LiveActivity pill. Last fills on her own pool: side,
size in BAYLA, USD value, age, and a Solscan link per row so any line can be
checked.

⚠️ **The one real trap, guarded and mutation-tested**: GeckoTerminal reports a
fill as `from_token → to_token`. On a BUY the bungalow token is what you
RECEIVE; on a SELL it is what you GIVE. Reading the wrong leg prints the SOL
side as a token size — `0.61` instead of `116,200` — a plausible-looking number
nobody would catch. Inverting the branch turns the test red.

## 3. Distribution

`components/bungalow/BungalowHolders.tsx` runs the venue's **own** scanner
(`useTokenScan` → `scanTokenLive` → `fetchSolanaScan`) on the bungalow's mint —
the same audited path `/scan` uses, through the same hardened `/api/solrpc`
proxy. A second holder reader would have duplicated the exclusion rules, the
gate and the caveat set: the three things that make the number honest.

**Read on demand, not on mount.** One distribution read is a batched RPC scan,
and the free Solana endpoint rate-limits `getTokenLargestAccounts` hard enough
that a *single* call trips it (measured: mainnet-beta → 429; publicnode →
"Indexed requests require a personal token"). Auto-running it from two pages
would spend the RPC budget on readers who never asked and show them a 429 for
it. So the card asks first. The market strip above it stays automatic — that is
one cheap HTTP read, not a scan.

👉 **OPERATOR**: the card's success path needs a keyed `SOLANA_RPC_URL` (Helius
/ Triton / QuickNode) server-side. The prod allowlist already permits the method
— `api/solrpc.js` scopes `getProgramAccounts` to the three Streamflow programs
and lists `getTokenLargestAccounts` outright — so this is an env var, not code.
Until then the card shows its honest rate-limit line. Because that path cannot
be exercised from a keyless dev box, its render is pinned by
`BungalowHolders.test.tsx` against a mocked scan rather than by eyeball.

## 4. The lighthouse pool was never broken — the dev proxy was

`/farm` showed "The pool could not be read right now — that is an outage, not a
zero" on every load. The pool is fine: the account exists on mainnet, owned by
`STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH`.

**Root cause**: `api.mainnet-beta.solana.com` rejects any request carrying an
`Origin` header, and the vite dev proxy forwarded the browser's. Isolated
against the proxy itself:

| Headers sent | Result |
|---|---|
| `Origin` + `Referer` | 403 |
| `Referer` only | 200 |
| `Origin` only | **403** |
| neither | 200 |

The **production** function was never affected — `api/solrpc.js` builds a clean
upstream request with only `Content-Type`/`Accept`. The dev proxy now strips
`origin`, `referer` and `cookie` to match it. This broke **every** Solana read
in local dev, not just Bayla's.

`/farm` now reads live: reward vault **0 BAYLA**, total staked **0 BAYLA**, lock
window **1–365 days**, with the funding-last copy ("staking earns nothing until
it is funded — deposits are open") and a Connect Solana Wallet action. A real,
labelled zero, which is the whole contract.

Also fixed: `bungalowStaking.readPool` had a bare `catch {}` that swallowed the
cause, which is *why* nothing could diagnose this. It now warns with the real
error.

## Verification

- Full frontend suite green; `tsc -b` clean; eslint 0 errors (the new files add
  no warnings — the chart helpers moved to `lib/chart/market.ts` so
  `PriceChart.tsx` exports only components again and Fast Refresh stays intact).
- New tests: `usePoolMarket.test.ts` (6), `usePoolTrades.test.ts` (4, one
  mutation-verified), `BungalowHolders.test.tsx` (5), `lib/chart/market.test.ts`
  (5).
- Browser-verified in Chrome against the running app: the market strip, the
  chart at all four timeframes, the tape with live fills, the classic TOWELI
  chart unchanged, and the lighthouse pool reading real zeros.

## Still open

- ~~**`/chart` (Pro Charting)** stays SOON and stays EVM-only by design. A Solana
  equivalent would be a separate build, not a fix.~~ **Closed 2026-09-02:** it
  charts every registry pool on all three networks from GeckoTerminal OHLCV; the
  Solana equivalent was the parameter this document already added, not a build.
- **Distribution success path** waits on a keyed `SOLANA_RPC_URL` (§3).
- The **other 11 bungalows** get all of this for free the moment they declare a
  `market` pool in `lib/bungalows.ts` — every component here self-hides without
  one. Only Bayla has a live pool today.
