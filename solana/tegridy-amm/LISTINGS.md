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
**Regular Listing** (free, a queue of up to 3 months; Express was USD 15,000 on 2026-11-25
and does not skip the criteria). Answers:

- DEX name: Memetics. Website: https://memetics.finance. Chain: Solana.
- DEX type: constant-product AMM (a fork of Raydium's audited cp-swap, program
  `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`).
- Integration: non-EVM, via the Integration API Standards; base URL above.
- Rate limit we allow: 120 requests a minute from their indexer. Ask for a chunk of at most
  50,000 slots (`/events` refuses a wider range) — at our volume that is a dozen transactions.
- Contact: the owner's email and Telegram handle (the form requires both).
- Logo: the site's; links: Twitter/Discord if any.

GeckoTerminal's FAQ says a request is reviewed in 3–5 working days, and that approval "remains
subject to GeckoTerminal's listing criteria", which it does not publish. Once live, our pools
get a chart page each and appear in CoinGecko's on-chain data, which is where
DexScreener-style bots and Jupiter's "traction" reviewers look.

**Following up:** if the pool is still missing after 5 working days, GeckoTerminal asks for a
ticket, not a second form (https://support.coingecko.com/hc/en-us/articles/22611791394585):
"Submit a request" at the top of support.coingecko.com, issue type **GeckoTerminal Related**,
page URL empty, subject **Follow up on GeckoTerminal's DEX/Chain addition request**, a
description naming the DEX (Memetics Finance) and the email the form was sent from, and the
form response attached as a PDF. Listed = this answers 200 instead of 404:
`https://api.geckoterminal.com/api/v2/networks/solana/pools/ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4`.

## 2. DexScreener (free; a request in their Discord; our feed already fits its adapter)

A new DEX is added by request in DexScreener's Discord (https://discord.gg/wpV9vZsbR4, per
https://docs.dexscreener.com/dex-listing): the `#dex-listing` forum, one post per DEX, and
every follow-up inside that post's thread. Their stated criteria are "a significant amount of
liquidity and daily volume", "open-sourced and audited smart contracts", and "an active
community", with no numbers, and a warning that low-liquidity DEXes "may not be listed at
all". The forum's pinned rules (read 2026-11-25) put DEXes with $500k liquidity and $50k a
day of volume first. Listing a DEX there is free and staff never DM: a reply linking another
Discord invite, or a member who moves to DMs and asks for SOL, is a scam
(both seen on our thread, 2026-11-25 and 11-26; the second had only the Member role).

DexScreener also publishes an adapter a DEX can host for its indexer, "Adapter Specs" v1.1
(https://docs.dexscreener.com/contact-us/adapter-specs): `/latest-block`, `/asset?id=`,
`/pair?id=`, `/events?fromBlock=&toBlock=`. GeckoTerminal's standard is a copy of it, so our
feed at `https://memetics.finance/api/gt` already meets it. Checked 2026-11-26 against a real
BAYLA/SOL swap and withdrawal: one coin in and one out per swap; `priceNative` is asset0 in
asset1 and never 0; `txnIndex` + `eventIndex` are unique in a block; reserves are the vaults
after each event; amounts are decimal strings of at most 50 places; `/latest-block` is the
newest finalized slot, so `/events` already holds it; `pair.feeBps` is 100 for 1%. The only
field beyond their schema is `asset.decimals`, an extra.

Suggested text for the first post:

> Hi — DEX listing request for Solana. Memetics (https://memetics.finance) runs a
> constant-product AMM at program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, a fork of
> Raydium's cp-swap (same account layouts; only the program id, authority constants and one
> LP-metadata instruction differ; source: https://github.com/fomotsar-commits/tegridy-farms/tree/mvp-launch/solana/tegridy-amm).
> 20 pools, ~$18k TVL, deepest BAYLA/SOL `ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4`.
> Pools and events are also served in GeckoTerminal's format at https://memetics.finance/api/gt
> if that helps your indexer. Thanks.

Expect "not yet" until the audit is done and volume is visible on GeckoTerminal; ask again
after both.

Follow-up for the same thread (a reply, never a new post), naming their own spec:

> Update: we host your Adapter Specs (v1.1) for this DEX, live on mainnet data, so your
> indexer can read us without a custom parser. Base URL: https://memetics.finance/api/gt
> (the same endpoints serve GeckoTerminal).
> - /latest-block → https://memetics.finance/api/gt/latest-block
> - /asset → https://memetics.finance/api/gt/asset?id=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump
> - /pair → https://memetics.finance/api/gt/pair?id=ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4
> - /events → https://memetics.finance/api/gt/events?fromBlock=474377383&toBlock=474377383
>
> Blocks are finalized Solana slots, times UNIX seconds, amounts decimal strings; up to
> 50,000 slots per /events call, 120 requests a minute. Program
> `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` (Raydium cp-swap fork, same account layouts).

## 3. Jupiter (free; the SDK is rebuilt, the audit is the blocker)

Everything for Jupiter's AMM integrators form is in `jupiter-sdk/SUBMISSION.md` on the
branch `docs/jupiter-listing-pack` (5491039ea, not merged yet). The SDK was
re-proven against the live program build on 2026-11-07 (branch
`feat/jupiter-sdk-interface-070`, commit `8675c5d20`: 22 crate tests and the site's 52 parity
checks pass). Still missing: the Scope A audit report (`AUDIT_RFQ.md` has the quote request
ready to send) and traction, which listings 1 and 2 are meant to build.

## 4. DexTools (free; the adapter is built)

DexTools reads a DEX it does not parse itself through its own HTTP API standard
(github.com/dextools-io/integration-sdk, `http-adapter`, v0.0.1). Ours, beside the
GeckoTerminal one and from the same chain reads, at `https://memetics.finance/api/dextools`:
`/latest-block`, `/block?number=`, `/asset?id=`, `/pair?id=`, `/events?fromBlock=&toBlock=`,
`/exchange?id=EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`. Code and tests:
`frontend/api/_lib/dextools.js`, `frontend/api/__tests__/dextools.test.js`.

Where it differs from GeckoTerminal's: eventIndex is unique in the block; a pool's opening
is a `creation` and a `join` of what it opened with (read from the `initialize`
instruction, since the program logs no event for it); errors are `{code, message, issues}`.
Not served: `/asset/holders` (a Solana holder list needs a scan of every token account of
the mint; DexTools has its own Solana index) and `/block?timestamp=` (the spec asks for it
only on sharded chains).

Requests are GitHub issues on `dextools-io/community-requests`; ours is #163.

## Sent

- 2026-11-25: GeckoTerminal form (queue up to 3 months, Express USD 15,000 declined),
  DexScreener's `#dex-listing` forum (one post per DEX; follow up inside the thread),
  DexTools issue #163.
- 2026-11-26: the live DexTools feed URLs, as a comment on #163.
- 2026-11-26: the adapter follow-up above, as a reply in the DexScreener thread.
- Read 2026-11-26: no reply yet on #163; GeckoTerminal still 404; DexScreener still no pair,
  and no staff reply in the thread.

## What each listing does for the money

- Venue fees: every routed trade pays the pool's 1% trade fee; LPs keep 84%, the venue 16%.
- The robot: more outside swaps in our pools mean more gaps to close. Once Jupiter routes
  through our pools, co-located arbitrageurs will compete for those gaps; the venue then
  earns fees on their trades instead.
