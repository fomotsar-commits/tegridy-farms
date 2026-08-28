# What actually needs money — 2026-08-15, re-priced 2026-08-22

> ## ⚠️ RE-PRICED 2026-08-22 — READ THIS BEFORE QUOTING ANY DOLLAR FIGURE BELOW
>
> **Quote the token amount. Derive the dollars at the moment you quote them.** Every `$` in this
> file is a *derived* number with a shelf life; the ETH/SOL/TOWELI amounts are the real ones and
> they do not drift with the market.
>
> | | 2026-08-15 | 2026-08-22 | |
> |---|---|---|---|
> | ETH | $1,878.50 | **$2,510.71** | +33.7% |
> | SOL | $75.17 | **$96.94** | +29.0% |
> | TOWELI | $0.0000544 | **$0.0000717** | +31.8% (implied by the Uniswap pair) |
>
> *Sources: CoinGecko spot, 2026-08-22. Reserves re-read on chain the same run.*
>
> **The pool-deepen headline moved in BOTH directions at once, which is the whole point of this
> banner.** In ETH terms it got *cheaper* — 2.07 → **1.98 ETH** — because the native pair grew from
> 0.0230 to **0.0794 WETH** on its own. In dollars it got *more expensive* — $3,886 → **$4,964** —
> because ETH rose faster. Restamping a new ETH price onto the old derivation would have produced
> ~$5,197: wrong, and wrong in the confident direction. The derivation was re-run against live
> reserves, not re-multiplied. **Anything below quoted in dollars and not re-derived here should be
> treated as ±30%, not as a figure.**
>
> Re-priced figures: pool deepen **1.98 ETH ≈ $4,964** · Solana restart settled **8.46 SOL ≈ $820**
> · Solana restart peak float **13.4 SOL ≈ $1,299** · DBC config v2 **0.0082 SOL ≈ $0.79**.
>
> ⓘ Solana rent is denominated in lamports, so **a SOL price move changes what the restart costs in
> dollars, never how much SOL it needs.** And note the restart total is within 0.01 SOL of the
> 8.467 SOL that closing the two programs released — see `TODO_OPERATOR.md` §0.4, which is still
> unreconciled. If that SOL is in a wallet you hold, the Solana line is a transfer, not a funding ask.

Every dollar figure here is derived from a live on-chain read taken today, not from a doc.
Prices at original time of writing: **ETH $1,878.50** (Coinbase spot; Chainlink ETH/USD control
reads $1,879.94), **SOL $75.17**, **TOWELI $0.0000544** (implied by the Uniswap pair).

Two corrections come first, because both change what the list can even ask for.

---

## Correction 1 — you cannot re-fund a closed program

Both Solana programs are closed. The rent was reclaimed, and on Solana **a closed program's
address is not reusable**. There is nothing to top up. Restarting the rail means fresh
deploys at **new program IDs**, paying rent from zero:

USD re-priced 2026-08-22 at SOL $96.94. **The SOL column is the one that matters — rent is
denominated in lamports and does not move with the price.**

| | SOL | USD (2026-08-22) | was (SOL $75.17) |
|---|---|---|---|
| tegridy-launch programdata + stub | 3.582 | $347 | $269 |
| cp-swap fork programdata + stub | 4.887 | $474 | $367 |
| global PDA + AmmConfig + fee ATA + fee-recipient floor | 0.018 | $2 | $1 |
| deploy tx fees | ~0.010 | $1 | $1 |
| **settled total** | **8.487** | **$823** | $638 |
| write-buffer retry headroom (recoverable) | +4.89 | +$474 | +$368 |
| **peak float to ask for** | **13.4** | **$1,299** | $1,007 |

Ask for the peak, not the settled number. A deploy that dies mid-write strands a buffer, and
the retry needs its own rent before `--buffers` gives the first one back. That is how the
last attempt got expensive.

**Permanent burn per deploy-then-close cycle: 0.0082 SOL.** Everything else is recoverable.

Also: two **high** findings from the phase-04 audit are in segmented mode, and one of them
means a well-formed segment table can permanently brick every launch created under it. Those
are source findings — they carry forward into any new deploy. Fix before spending, not after.

## Correction 2 — we do not own the TOWELI the pool runbook assumes

`docs/GOLIVE_CORELOOP.md` sizes the pool deepen at **1.35 ETH + 50,000,000 TOWELI**, treating
the token side as inventory. It is not. Read today:

| holder | TOWELI | % supply |
|---|---:|---:|
| Uniswap pair (the only liquid market) | 266,581,270 | 26.66% |
| burn address `0x…dEaD` | 257,626,865 | 25.76% |
| public wallets / unindexed | ~469,600,000 | 46.96% |
| tegridy-staking | 4,531,245 | 0.45% |
| **deployer EOA (all we can spend)** | **813,751** | **0.08%** |
| native pair | 792,794 | 0.08% |
| premium-access | 30,000 | 0.00% |

**Protocol-spendable TOWELI: 813,751 tokens = $44.** The other side of any pool deepen has to
be *bought*, and buying it out of a 266M-token pool moves the price against us.

---

## The TWAP floor: the single most important number on this page

`TegridyTWAP.sol:201` sets `DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether`, and
`minReserveFloor1(native pair)` reads **0** on chain, so the default applies. The native pair
holds **0.0794 WETH** (re-read 2026-08-22; it was 0.0230 on 08-15, so it has deepened ~3.4× on its
own without anyone funding it). Below the floor, `consult()` reverts and every consumer fails closed.

To fill the native pool to 10 WETH at the current market ratio you would need **344,562,363
TOWELI — 1.29× the entire Uniswap pool.** Constant-product means you can never extract all of
a pool, so **that floor is not expensive, it is unreachable.** No amount of money clears it at
today's market size. It was set for a protocol with a much deeper pool than this one has.

The floor is owner-lowerable to anything ≥ 1000 wei via `proposeAdminMinReserveFloor1` → 24h →
`executeAdminMinReserveFloor1`. The TWAP owner reads as the deployer EOA, so that is **one
signature and a day's wait, no multisig**.

But lowering it alone is not a free win, and I want to be exact about that: dropping the floor
to something the pool already clears (0.02 WETH) makes the oracle "work" on a pool that can be
moved for about $10 — which is precisely the defect the floor exists to prevent. The
adversarial review in `GOLIVE_CORELOOP.md` fixed **1.0 WETH** as the safe stopping point.

So the real ask, priced from what we actually hold:

**Re-derived 2026-08-22** against live reserves — native pair **0.0794 WETH / 2,795,068 TOWELI**,
Uniswap pair **7.6697 WETH / 268,553,703 TOWELI**:

| step | cost |
|---|---|
| lower floor 10 → 1.0 WETH — **propose DONE 2026-08-22** (tx `0x29cd52c0…6771f`); execute is open and **expires 2026-08-30 18:03 UTC** | ~$0.02 of gas, half of it already spent |
| buy **32.43M TOWELI** (14.1% slippage against the Uniswap pool) | 1.0565 WETH = **$2,653** |
| add **0.9206 WETH + 32.43M TOWELI** proportionally to the native pair | 0.9206 WETH = **$2,311** |
| **all-in** | **≈ 1.98 ETH = $4,964** |

<details><summary>Superseded 2026-08-15 derivation (native pair held 0.0230 WETH, ETH $1,878.50)</summary>

| step | cost |
|---|---|
| buy 32,928,971 TOWELI (14.4% slippage) | 1.092 WETH = $2,051 |
| add 0.977 WETH + 33.74M TOWELI proportionally | 0.977 WETH = $1,835 |
| **all-in** | ≈ 2.07 ETH = $3,886 |

</details>

That is the number: **$4,964, not $36,600** — and it is **1.98 ETH**, which is the half that will
still be true next week. Re-quote at execution: the buy moves the ratio, and both legs are priced
off reserves that trade.

Worth noticing *how* it moved. The ETH cost fell (2.07 → 1.98) because the native pair deepened on
its own, while the dollar cost rose 28% because ETH outran it. Multiplying the old 2.07 by the new
ETH price would have said $5,197 — a number that is wrong, and wrong in the direction that makes
you over-ask. Re-derive; do not re-multiply.

**What it unblocks:** a protocol-owned TOWELI price (the site currently prices off the free
GeckoTerminal API), `POLAccumulator.accumulate()`, the TegridyLending oracle path, and native
limit orders.

---

## The treasury, read today

| account | ETH | USD |
|---|---:|---:|
| deployer EOA `0x1489…456E` | 0.009199 | **$17.28** |
| Treasury Safe `0x7D26…Bd7d` | 0 | $0 |
| RevenueDistributor | 0 | $0 |
| SwapFeeRouter | 0 | $0 |
| POLAccumulator | 0 | $0 |
| launcher-integrator | 0 | $0 |
| ReferralSplitter | 0.000003 | $0.01 |
| Solana deploy authority | — | does not exist on chain |

**Total protocol liquid assets: about $61.** That is the constraint every line below is
measured against.

---

## Tier 0 — costs nothing, and several are being mistaken for funding problems

Do all of these before spending a dollar.

1. **Set the three Supabase backup secrets** (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `BACKUP_PASSPHRASE`). Free, and the only item on this page whose downside is *permanent*.
   The weekly backup job has been green while backing up nothing.
2. **Set `MEMETICS_BIRTH_SECRET`** in Vercel production — unblocks Wave 3 phase 01.
3. **Propose the TWAP floor change.** Starts the 24h clock, costs a cent, commits nothing.
4. **Wire `polAccumulator` + a non-zero `polShareBps` on SwapFeeRouter.** Both read zero
   today, so POL receives nothing. This is a setter call. Once fees flow, the 0.01 ETH
   `accumulate()` threshold funds itself — do not hand-seed it.
5. **Recover the stranded fee rail.** 3e12 wei earned, 2.4e12 (80%) sitting in
   `ReferralSplitter.callerCredit`, `totalDistributed` still 0. Wiring
   `recoverCallerCredit()` is code, not capital.
6. **Set `ALCHEMY_API_KEY_FALLBACK`** (unset today) — captures most of the value of the paid
   Alchemy tier for $0.
7. **Send `solana/tegridy-amm/AUDIT_OUTREACH.md`** to the four named firms. Asking costs
   nothing and is the only way to turn the largest unpriced item on this page into a number.
8. **Fix `SERVERLESS_BUDGET.md:12`** — it says 12/12 when the real count is 11, so the next
   contributor will think we need Vercel Pro when we don't.
9. **Wire the free Halmos/Echidna equivalents** of the six Certora properties, which are
   already written.

## Tier 1 — under $50

| item | cost | unblocks |
|---|---:|---|
| **Meteora DBC config v2** — retires the 99% opening fee | 0.0082 SOL ($0.79 at SOL $96.94) | `/solana-launch` becomes tradeable at launch instead of ~4h later. **The payer wallet already holds 0.496 SOL** — no new money needed. Independent of the program restart; cheapest revenue-relevant action anywhere on this list |
| **Create the Tegridy Pro Pass collection** — one `createCollection()` on live LaunchpadV2 | ~$0.11–6.50 of gas, no protocol fee | Stands up a priced membership surface that currently renders "not deployed" behind a disabled button. Best dollar-per-effort item in the repo |
| **USB stick** for the keys and recovery material that exist in exactly one copy | $5–15 | The one-copy problem. `OPERATOR_PACKET` says back up *before* funding, and OneDrive has already eaten working state twice |
| **Deploy TegridyLending + LendingAdmin** | 9.67M gas — $1.44 at 0.08 gwei, $90 at 5 gwei | LendingPage. **Signable today** — this corrects `GATED_DEPLOY_RUNBOOK.md:104`, which claims it is blocked on the oracle |

## Tier 2 — $50 to $1,000

| item | cost | note |
|---|---:|---|
| **Hardware wallet** to retire the hot deployer EOA from disk | $60–150 | Prerequisite for the Safe rebuild, the 18-contract re-home, and destroying the on-disk key. Free substitute (`cast wallet import --interactive`) is real but strictly weaker |
| **Top up the deployer** for the remaining gated deploys | ~0.07 ETH ($176 at ETH $2,510.71) at 5 gwei; $2 at current gas | At today's gas the existing balance covers everything. This is gas-price insurance, not a blocker |
| **Solana rail restart, settled** | 8.487 SOL ($823 at SOL $96.94) | Gated on the two segmented-mode highs being fixed first |
| **Safe deployment + ownership re-home gas** | 0.01–0.15 ETH ($25–377 at ETH $2,510.71), realistically the low end | `SAFE_REHOME_RUNBOOK.md:171` forbids un-gating any fund-touching feature before its owner is a multisig |
| **Working ETH inside the rebuilt Safes** | 0.02 ETH ($50 at ETH $2,510.71) clears the documented need; 0.1 ETH is the recommendation | Not spent — recoverable. Do not size at 0.1 ETH on a $61 treasury. A Safe that cannot pay its own gas is one of the named ways ownership gets stranded |

## Tier 3 — $1,000 to $5,000

| item | cost | note |
|---|---:|---|
| **Native pool deepen to a 1.0 WETH floor** | **1.98 ETH ≈ $4,964** | The full derivation is above. This is the single highest-leverage spend on the page |
| **Solana restart, peak float** | 13.4 SOL ($1,299 at SOL $96.94) | Ask for this, not the $823 |

## Tier 4 — deferred, and honestly so

- **Winning routed quotes against Uniswap.** For the router to prefer our pair over Uniswap's
  we would need **more WETH than Uniswap's entire pool holds** — 7.42 WETH minimum, ~8 WETH to
  win a $1,000 trade. Until then every user swap routes direct to Uniswap and SwapFeeRouter
  earns exactly zero. This is why the EVM swap-fee rail has earned nothing, and it is a
  ~$30,000 problem, not a bug.
- **LP Farming rewards.** Funding this *early is worse than not funding it*: with
  `totalEffectiveSupply == 0` the emission accrues to nobody. Fund it when there is staked LP.
- **Restaking bonus rewards.** Blocked on a build, not on money — the runtime is 26,784 B
  against EIP-170's 24,576. A 24,743 B artifact already exists (see the restaking-split note).
- **Hardware keys for the other 12–18 Safe signers** ($850–3,000). Downstream of a free
  decision — *who the signers are* — which nobody has made. Do not buy hardware first.
- **Paid human audits.** Unpriced and correctly so; gated on TVL we do not have. The only
  in-repo comparables are for the unbuilt V4 stack ($500k–650k). `AUDITS.md` already labels
  our 14 internal AI sweeps honestly, so nothing misleads today.
- **Bug bounty.** $0 by design. Hats Finance is TOWELI-denominated and needs no cash;
  Immunefi is pay-on-results. Fix the stale claim at `AUDITS.md:178` for free first.
- **Legal entity / tax treatment.** Unpriced, genuinely deferrable at $61 of assets, and gets
  more expensive after revenue exists than before.
- **Operator-seeded cp-swap depth for Jupiter routing.** No threshold number exists anywhere.
  Deep liquidity with no users still earns nothing.

## Recurring

| item | cost | verdict |
|---|---:|---|
| **Domain renewals** — memetic.fun + memetics.finance | **$65–95/yr** | **PAY. Already being paid.** Both are hardcoded into the CORS allowlists of all 10 API handlers; a lapsed domain that someone else registers inherits pre-authorized access |
| TWAP keeper gas (12 updates/day) | $2.61/mo at current gas; **$269/mo at 5 gwei** | Build it, but know the cost is entirely gas-dependent. `update()` is permissionless and a GitHub Actions cron is free on a public repo. Update fees return to `owner()` via `withdrawFees` — confirm `feeRecipient()` on chain before relying on that |
| Supabase Pro | $25/mo | **Defer.** Best paid upgrade on the list, but free-tier auto-pause after ~7 days idle is the risk, and the synthetic monitor currently reads `degraded:true` as healthy — fix the monitor first, for free |
| Vercel Pro | $20/mo | **Do not fund.** Nothing breaks. We are at 11/12 functions, not 12/12 |
| Alchemy Growth | $49/mo | **Do not fund.** Free tier has large headroom at ~1,092 holders. Set the fallback key instead |
| Keyed Solana RPC | $0–49/mo | Free tiers suffice at this scale. The deploy burst is the stress case — a free Helius key before the restart is the right move |
| $5/mo box for the OpenZeppelin auto-pause trigger | $60/yr | Run it alert-only for $0 first. Downstream of the Guardian Safe existing |
| Ponder indexer hosting | $10–27/mo if started | **Do not fund.** Nothing reads it. The inventory's verdict is binary: wire it or delete it |
| Upstash Redis, GitHub Actions, Etherscan, OpenSea, WalletConnect, Dune, public RPCs | **$0** | Confirmed free at current scale. Two are free-but-losable: an OpenSea key can be revoked for inactivity |
| Third-party error tracking / uptime / analytics | **$0** | No such vendor is in the codebase. Do not add one — the free fixes in `OPEX.md:138` close the actual detection gap |

## Not a funding target

- **CommunityGrants `0xeBC3…D471`** is listed under `retiredDeploys` in the address registry —
  created and walked away from, wired into no frontend. The sweep proposed funding its vault.
  Do not. If it is meant to be live it needs re-classifying in the registry first.
- **Solana swap-fee ATAs.** Both already exist (created 2026-07-10). A valid zero. The
  untracked `create-fee-atas.mjs` in the repo root looks like pending work and is not.
- **nakamigos.gallery renewal.** Previously a safety spend; the CORS strip was completed, so
  dropping it is now safe. $0.
- **Per-launch and per-graduation Solana costs.** Trader- and creator-funded, not operator
  capital. They belong in the fact sheet, not in a funding ask.
- **TegridyFeeExecutorRouter deploy** ($0.47–29 of gas). Nothing references it and no surface
  changes. The real blockers are free-but-unfinished integration work.

---

## If money arrives, spend it in this order

1. **$0** — the whole of Tier 0. Nothing below is worth doing while the backup secrets are unset.
2. **$20** — USB stick, DBC config v2, Pro Pass collection. Three live surfaces for pocket change.
3. **$150** — hardware wallet. Gets the protocol's root key off a OneDrive-synced disk.
4. **$700** — Safe rebuild and ownership re-home, funded to sign.
5. **$4,950** (1.98 ETH) — native pool to a 1.0 WETH floor. The first spend that makes the protocol's own
   oracle real.
6. **$1,300** (13.4 SOL peak float) — Solana restart at new IDs, *after* the two segmented-mode highs are closed.

Total to clear everything through step 6: **about $7,100** at 2026-08-22 prices — up from $5,800 on
08-15, entirely because ETH and SOL rose. In token terms the ask barely moved: **1.98 ETH + 13.4 SOL**
plus ~$870 of fiat items (USB stick, hardware wallet, Safe gas). Quote it that way and it stops
needing a revision every week.

Everything above that number is deferred on purpose, and the standing rule still holds: the
protocol may not spend capital it has not earned.
