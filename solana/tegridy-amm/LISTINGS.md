# Getting our pools in front of traders: the three listings

Why: the price robot earns only on what other people trade in our pools, and in 24 h on
2026-11-06/07 outsiders made 57 transactions ($1,480) across all 20 of them. Nothing routes
to our venue but our own site: our pool program is not among Jupiter's 110 routable programs,
and DexScreener and GeckoTerminal both answered "not found" for BAYLA/SOL (read 2026-11-07).
A listing is the first door to outside volume; the robot's income scales with it
(`reports/Solana arbitrage where the money is.md`, lever 1). The owner sends every request
below. Nothing in this folder sends anything.

## 1. GeckoTerminal (free; the adapter is built)

GeckoTerminal lists a DEX that is not one of its known forks through four HTTP endpoints the
DEX hosts, which its indexer polls every 2 s ("GeckoTerminal Integration API Standards"
v0.1). Ours are live once this branch deploys, at:

| GeckoTerminal calls | Ours |
|---|---|
| `GET /latest-block` | `https://memetics.finance/api/gt/latest-block` |
| `GET /asset?id=<mint>` | `https://memetics.finance/api/gt/asset?id=<mint>` |
| `GET /pair?id=<pool>` | `https://memetics.finance/api/gt/pair?id=<pool>` |
| `GET /events?fromBlock=&toBlock=` | `https://memetics.finance/api/gt/events?fromBlock=&toBlock=` |

Base URL for the form: `https://memetics.finance/api/gt`. Blocks are Solana slots; times are
UNIX seconds; every amount is a decimal string. Each swap carries the pool's fee in
`metadata.fees*` so GeckoTerminal computes the price itself; reserves are the vaults after
the transaction. Code and tests: `frontend/api/_lib/geckoterminal.js`,
`frontend/api/__tests__/geckoterminal.test.js` (held to real mainnet transactions).

**Before sending:** deploy this branch, then check the four URLs answer (the first two in a
browser; `/pair?id=ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4` should show `feeBps: 100`).

**The form:** https://docs.google.com/forms/d/e/1FAIpQLSeOAlwKZKTj6LFJfukUWSYS9XUIwtvITX9W5C5ZgUIC4NgX0Q/viewform
(linked from https://about.geckoterminal.com/dex-chain-listing). Pick **DEX Addition**,
**Regular Listing** (free; Express is $10,000 and does not skip the criteria). Answers:

- DEX name: Memetics. Website: https://memetics.finance. Chain: Solana.
- DEX type: constant-product AMM (a fork of Raydium's audited cp-swap, program
  `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`).
- Integration: non-EVM, via the Integration API Standards; base URL above.
- Rate limit we allow: 120 requests a minute from their indexer. Ask for a chunk of at most
  50,000 slots (`/events` refuses a wider range) — at our volume that is a dozen transactions.
- Contact: the owner's email and Telegram handle (the form requires both).
- Logo: the site's; links: Twitter/Discord if any.

GeckoTerminal says 5–10 working days for a non-EVM DEX, and that approval "remains subject to
GeckoTerminal's listing criteria", which it does not publish. Once live, our pools get a
chart page each and appear in CoinGecko's on-chain data, which is where DexScreener-style
bots and Jupiter's "traction" reviewers look.

## 2. DexScreener (free; a request in their Discord)

DexScreener has no adapter: its own indexer parses the programs it knows, and a new DEX is
added by request in their Discord (https://discord.gg/wpV9vZsbR4, per
https://docs.dexscreener.com/dex-listing). Their stated criteria are "a significant amount of
liquidity and daily volume", "open-sourced and audited smart contracts", and "an active
community", with no numbers, and a warning that low-liquidity DEXes "may not be listed at
all". Suggested request text:

> Hi — DEX listing request for Solana. Memetics (https://memetics.finance) runs a
> constant-product AMM at program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, a fork of
> Raydium's cp-swap (same account layouts; only the program id, authority constants and one
> LP-metadata instruction differ; source: https://github.com/fomotsar-commits/tegridy-farms/tree/mvp-launch/solana/tegridy-amm).
> 20 pools, ~$18k TVL, deepest BAYLA/SOL `ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4`.
> Pools and events are also served in GeckoTerminal's format at https://memetics.finance/api/gt
> if that helps your indexer. Thanks.

Expect "not yet" until the audit is done and volume is visible on GeckoTerminal; ask again
after both.

## 3. Jupiter (free; the SDK is rebuilt, the audit is the blocker)

Everything for Jupiter's AMM integrators form is in `jupiter-sdk/SUBMISSION.md` on the
branch `docs/jupiter-listing-pack` (5491039ea, not merged yet). The SDK was
re-proven against the live program build on 2026-11-07 (branch
`feat/jupiter-sdk-interface-070`, commit `8675c5d20`: 22 crate tests and the site's 52 parity
checks pass). Still missing: the Scope A audit report (`AUDIT_RFQ.md` has the quote request
ready to send) and traction, which listings 1 and 2 are meant to build.

## What each listing does for the money

- Venue fees: every routed trade pays the pool's 1% trade fee; LPs keep 84%, the venue 16%.
- The robot: more outside swaps in our pools mean more gaps to close. Once Jupiter routes
  through our pools, co-located arbitrageurs will compete for those gaps; the venue then
  earns fees on their trades instead.
