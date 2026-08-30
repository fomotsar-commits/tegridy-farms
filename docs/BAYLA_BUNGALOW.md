# The Bayla bungalow — token-first venue + the lighthouse staking pool

*Written 2026-08-24, same day as the identity build. Companion commits on
`mvp-launch`. Research sources: memetics.wtf published canon (SPOTS +
SIGNSV2 registries), pump.fun coin metadata, Dexscreener pairs API — all
read 2026-08-24.*

## 1. Who Bayla is (canon, verbatim where quoted)

- pump.fun metadata: *"Bayla is the muse of Jungle Bay Island. Her pull
  reaches every kind of maker. The work is yours. The light is hers. Built
  by the JUNGLE BAY ARTISTS COLLECTIVE. Dank Memes + Time [DM+T] = Memetic
  Finance."*
- Island landing (memetics.wtf): BAYLA is **seated at the lighthouse**,
  status **NEWEST**, plaque line *"The muse was always here."* The island's
  tagline: *"An island in a sea of rugs. Built by the memes. Bungalows for
  token communities, an artist economy, and time held is what counts."*
- Token: **BAYLA**, Solana, mint `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump`,
  pump.fun launch 2026-08-03 (creator `G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu`),
  **graduated** (`complete: true`) into PumpSwap.
- Market snapshot 2026-08-24 (Dexscreener): ~$0.00053, MC/FDV ≈ $529k
  (ATH MC $1.45M on 2026-08-05), main pool **BAYLA/SOL on PumpSwap**
  (`8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n`, ~$62k liquidity, ~$23k
  24h volume), secondary **BAYLA/TBBB on Meteora DYN2**
  (`Bo16T7xgBdta2jDRozqhqNSvsB2iRHgBYdHMSVSR72WV`).

## 2. What shipped today (frontend, live in bayla mode)

Bayla mode is no longer a background reskin — it is a token-first venue
skin. With `?bungalow=bayla` (or the picker):

- **Hero speaks BAYLA** (`components/bungalow/BungalowHero.tsx`): "BAYLA. /
  The muse was always here." + muse copy, Trade BAYLA (Jupiter deep link,
  canon pattern — TOWELI's own sign uses a Uniswap deep link), Stake BAYLA
  (→ /farm), Scan BAYLA (→ `/scan?token=<mint>`), copyable contract chip
  with Solscan link. The TOWELI headline, yield calculator, Towelie quote
  ticker, Towelie assistant, TOWELI LiveActivity pill and TOWELI onboarding
  are all muted in this mode — and untouched in the default.
- **/farm renders the Bayla panel** (`components/bungalow/BungalowFarmPanel.tsx`)
  instead of the TOWELI stack: fullscreen Bayla art, "Stake BAYLA." header,
  an honest **"Not deployed yet"** pool-status card (asks for nothing, no
  addresses exist), the funding-routes card (§4), and a Live-today row:
  trade link, scanner, both real pools, contract chip.
- **Footer** carries the BAYLA blurb + BAYLA contract card (+ explorer) in
  bayla mode.
- Registry: `lib/bungalows.ts` now holds the **full island canon** — all 13
  bungalows with chains and addresses from the island's own SIGNSV2 (see
  `bungalows.test.ts` for the pinned table; addresses are canon-verbatim and
  the test exists so nobody "fixes" one).
- Verification: `scripts/verify-bungalows.mjs` now asserts the identity
  contract too (BAYLA hero present, TOWELI headline absent, assistant muted,
  farm self-gates) — 23/23 on ship day, plus vitest 15/15 on the registry.

### Round 2 (same day, operator's "do all you can" pass)

- **The URL format** — `memetics.finance/<bungalow>` is each bungalow's
  address. All 13 doors exist from day one (`BungalowDoor` + one route per
  island slug in App.tsx; `/towelie` is an alias for the `toweli` slug).
  Visiting a door IS entering the bungalow: persist + in-place reload, the
  address bar keeps the door path, and the picker now enters through doors
  so the format shows everywhere. Doors for not-yet-live bungalows render
  the current skin and start working the moment their slot flips live.
- **In-venue BAYLA trading** — BAYLA is a featured BUY-side token on
  `/solana` (decimals 6 per the pump.fun record; deliberately NOT marked
  Jupiter-verified — the Unverified chip is the honest state), and the swap
  accepts `?out=<mint>` to preset the buy side (curated mints resolve
  synchronously, unknown mints through Jupiter's resolver, bad links leave
  the default). Trade CTAs route in-venue when `isSolanaConfigured()`, else
  fall back to the canon Jupiter deep link — so the fee-capturing venue leg
  is used wherever it exists.
- **Heat on the farm page** — "Check your heat" card wired to the island's
  held-time oracle through the existing hardened proxy client; fail-closed
  copy ("The Island is quiet" ≠ cold).
- **The muse speaks** — her lore card on the bungalow home (canon copy +
  island/OpenSea/X links), a three-step Bayla welcome replacing the TOWELI
  onboarding, and a small MuseBubble line in the assistant's corner. The
  TOWELI fee-economy home sections (stat pills, contract strip, core loop,
  ProtocolStats/Pulse/ProofOfClaims/RealYieldProof, How-the-Farm-Works, FAQ
  teaser, referral widget) are default-only; venue-generic sections stay.
- **Gallery wing** — her 24 pieces hang ON TOP of the full classic
  collection (additive; shared lightbox + local votes).
- Verification after round 2: harness 33/33 (incl. the door flow at /bayla
  and /towelie), tsc + eslint clean (SolanaSwapPage stays at its 4-warning
  baseline), full vitest suite green.

## 3. The staking rail decision (Solana, BAYLA)

House rule applies (`feedback_minimal_surface`): battle-tested code only,
custom programs are where exploits come from. Candidates considered:

| Rail | Fit | Verdict |
|---|---|---|
| **Streamflow staking pools** | Purpose-built SPL staking-with-reward-pools product; audited; widely used by SPL communities; pools are created and funded through their app/SDK — zero custom program code on our side; non-custodial program-owned escrow | **RECOMMENDED** |
| Raydium farms / single-sided | Battle-tested but keyed to Raydium's own liquidity ecosystem; BAYLA's liquidity lives on PumpSwap + Meteora | Pass |
| Meteora farming on the existing DYN2 pool | Right tool for **LP** incentives on a pool that already exists — not single-sided staking | Complement, later |
| Our own cp-swap/curve stack | Both program ids are spent; redeploy is a parked operator ceremony; and it is a DEX, not a staking rail | N/A |
| Custom Anchor staking program | Maximum control, maximum new attack surface — exactly what the house rule exists to prevent | Last resort only |

**Recommendation: a Streamflow BAYLA staking pool** (stake BAYLA, rewards
in BAYLA), created by the operator through Streamflow's app with these
parameters as the starting frame: no forced lock or a short min-stake
period (island culture is "time held is what counts" — heat already
rewards holding; the pool shouldn't fight exits), rewards streamed at a
fixed rate, **funded before announced** (venue rule: a dry pool must read
as a real zero — the TOWELI staking look, `STAKING_LOOK_2026_08_24.md`,
documents exactly how a perpetual-rate pool misleads when it runs dry;
Bayla's pool starts honest by funding first).

⚠️ Operator verification at ceremony time (this doc was written from
knowledge + public reads, not a live Streamflow session): current
Streamflow staking product terms, creation + protocol fees, audit reports,
and program id. If Streamflow's current terms disappoint, the fallback
order is: Meteora LP farming only (no single-sided pool yet) → audited
open-source SPL staking template treated as new attack surface.

**Frontend phase B** (agent-buildable once the pool exists): read the pool
via Streamflow's SDK into BungalowFarmPanel (pool address, funded balance,
streamed rate, staker count), then wire stake/unstake through the existing
Solana wallet-adapter stack used by /solana. The panel's status card is
already the slot this drops into; the registry gets `stakePool?: string`.

## 4. Filling the reward pool — the incentive routes

Ranked by how real they are today:

1. **PumpSwap creator-fee share (live money, zero new code).** BAYLA
   graduated pump.fun; its PumpSwap pool pays the coin's creator wallet a
   share of swap fees. That claim belongs to the collective's creator
   wallet (`G2EHPse…Krbu`). Routing claimed fees → the staking reward pool
   is a pure operator flow (claim on pump.fun, transfer to the pool's
   funding account), and it scales with BAYLA's own volume. At ~$23k/day
   volume the absolute number is modest — fund expectations accordingly;
   the pool advertises only what is deposited.
2. **Venue swap fees, Solana leg.** The /solana surface captures a platform
   fee (SOL/USDC pairs) into the venue's fee account. A standing share of
   that toward bungalow reward pools is a policy decision — one the island
   can market ("the venue tithes to the bungalows") — and needs no new
   contracts, just the operator moving claimed fees.
3. **Community top-ups.** Direct transfers into the reward pool — same
   shape as TOWELI's one-time 6.4M seed, but visible and topped up in
   public. The Bayla panel already frames this.
4. **Later / cross-bungalow:** Meteora farm on BAYLA/TBBB (LP-side
   incentives), and if the venue's own Solana rail ever redeploys, its fee
   constitution can name bungalow pools as recipients.

## 5. What is deliberately NOT promised

- ⚠️ **SUPERSEDED 2026-08-28 for the first bullet only** — see
  `BAYLA_STAKING_SWAP_2026_08_28.md` §5. The pool now exists and publishes its
  own rate on-chain, so "no APR anywhere" became "print the rate the chain
  states, twice, and never conflate the two": the **configured** rate labeled
  as configuration, the **paying** rate as the real 0 it is while the vault is
  empty, and runway only when a funded vault and a live stake both exist. No
  number on the surface is synthesized. Every other bullet below still holds.
- No APR, no runway, no "coming soon" dates anywhere in the UI — the panel
  states the pool doesn't exist and describes the funding routes as
  evaluation, because that is the truth on 2026-08-24.
- BAYLA staking is **not** TegridyStaking: nothing about the Ethereum
  contract, its boosts, locks or its EIP-170 headroom transfers here.
- The venue wordmark stays TEGRIDY FARMS in bayla mode for now (chrome, not
  copy). If the operator wants full white-labeling per bungalow (wordmark,
  domain per bungalow, e.g. bayla.memetics.finance), that is a routing +
  branding decision to take deliberately — flagged, not assumed.

## 5b. THE RAIL'S HARD LIMIT — there is no early exit, at any price (2026-08-29)

Operator asked for a TOWELI-style emergency withdraw, then for a penalty-based
early exit. **Neither is possible on Streamflow.** This is a property of the
program, not of our UI, and it constrains the product permanently:

- The stake-pool program exposes exactly two staker instructions, `stake` and
  `unstake`. `unstake` is refused before the chosen duration elapses —
  error `6013 LockedStake`, "Stake is locked, unstake is not possible".
- There is **no** early-exit instruction, so there is no code path to attach a
  penalty or fee to. A penalty model cannot be built on top of a program that
  simply refuses.
- There is **no** admin release, pause, or forfeit-and-exit anywhere in the
  client — **not even for the pool authority**. TOWELI's `emergencyExit`
  works only because TegridyStaking is our own contract, gated on pause.
- The position cannot be sold to someone willing to wait, which would have
  been a market-priced exit: `deriveStakeEntryPDA` hashes in the staker's own
  wallet (only that wallet can ever unstake it) **and** the live pool has
  `freezeStakeMint = true`, so the receipt tokens are frozen and
  non-transferable. Both independently kill a secondary market or a venue
  buyback desk.
- `unstakePeriod` is **not** an escape hatch — it is an additional notice
  period (`6016 UnstakeRequestRequired`, `6017 UnstakeTooEarly`) that makes
  exits slower, never earlier.
- Streamflow's own docs state it plainly: "Once staked, your tokens cannot be
  withdrawn under any circumstances until the staking period you've committed
  to ends. There is no early unstake option."

**Therefore `--max-days` IS the exit policy** — the longest any staker can be
stuck with no recourse of any kind. The only failsafe this rail permits is a
short ceiling, so the ceremony script now defaults to `--max-days 7`, and
anything above 30 requires `--accept-long-lock`. The live pool's 365-day
ceiling is the single strongest reason to replace it; the operator's own
1,000 BAYLA dust test is locked there until ~2027-08-29 and cannot be
released by anyone, including the authority.

If a genuine mid-lock exit is ever a hard requirement, it means leaving
Streamflow for a custom staking program (write + audit), which cuts against
the repo's battle-tested-only rule. Not recommended; recorded as the known
cost of that requirement.

## 6b. Ceremony pre-flight (researched 2026-08-25, live reads)

**Streamflow — product verified current** (streamflow.finance/staking, read
via browser 2026-08-25):

- The staking product exists as described: **no-code staking pools for any
  SPL token**, configurable lock periods / APY / reward logic, reward
  **top-ups through their UI**, "fully automated stake reward distribution",
  pools "**fully non-custodial**", protocol **audited**, **public SDK** (our
  Phase-B integration path), and Streamflow is listed in the official Solana
  docs. Their own depletion rule matches our honesty law verbatim: *"If a
  pool's reward allocation is depleted, no additional rewards can be
  distributed."*
- Ceremony walk (operator, ~minutes by their claim): open the app from
  streamflow.finance with the creator/treasury wallet → Staking → create the
  BAYLA pool. Parameter frame from §3: no or short minimum lock (heat
  already rewards holding), fixed reward rate, claim cadence of your choice.
  **Record in this doc:** every parameter, the pool address, and the
  creation/protocol fees the app quotes (not published on the marketing
  page — they surface in-app).
- Then **fund before announcing** (§4 route 1 or 3), and hand the pool
  address to Claude — the farm panel's status card is the slot the live
  reads drop into (registry gets `stakePool`).

**pump.fun creator-fee claim:** the claim belongs to the creator wallet
(`G2EHPse…Krbu`) and is made in the pump.fun UI from the coin/profile
surface. Their support articles block automated reading — verify the
current claim flow and fee share in-app when signed in as the creator, and
note the observed rate here for the funding math.

## 6c. Also shipped without ceremony (2026-08-25)

- **Door unfurls**: `postbuild` renders `dist/bayla/index.html` with her own
  head identity (title, description, canonical, og/twitter tags, her
  BAYLA/SOL artwork as the og image) — sharing memetics.finance/bayla now
  unfurls as Bayla, not as the venue. Fail-loud transforms; parity with the
  registry pinned by `bungalowDoors.test.ts`; door paths get no-cache
  headers in vercel.json. (The white-label DECISION — task #15 — remains
  open; this was its mechanical half.)
- **Bungalow dashboard**: /dashboard in bayla mode is her standing page —
  connect a Solana wallet (read-only; nothing to sign), BAYLA balance via
  direct RPC, USD read only when Jupiter's price API actually answers, heat
  prefilled with the connected wallet, and the live-surface links. Lazy
  chunk: the EVM dashboard never loads the @solana stack.
- **CI-grade door coverage**: `e2e/bungalow-doors.spec.ts` (fixture-free —
  the wallet fixture pins toweli by design) walks /bayla, the /towelie
  alias, and a not-yet-live door across the four-device matrix.

## 6g. THE POOL WAS REPLACED (2026-08-30). Read this before §6f.

§6f below records the FIRST pool. It is retired. It shipped with
`maxWeight = 1.00x`, so its 1–365 day lock picker bought nothing — every
duration earned the identical rate (caught by the 2026-08-29 economics review).
`maxWeight` is a stake-pool field with **no update instruction**, so the only
fix was a new pool at a fresh nonce.

**THE LIVE POOL (nonce 1), created by the operator with the same ceremony key:**

- **Stake pool: `EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`**
  (tx `5zBxY9wzvg6C3JHVUh2BAK7nVGn3xSo18Hboib2FZRDV4X6J3BQD1c1hicB6spjE9zrT1XXnbRRYyHw8LcwXjz86`)
  — BAYLA mint, locks 1–365 days, **weight ramps 1.00x → 5.00x**, Token-2022.
- **Reward pool: `3ysyH5py46Q4XUXkumGy3DhWjPbNVhLMfQZmpQMdDruf`**
  (tx `4gVcSQR52Jh3wXyeLpDEBUm6yLKVdkU5Gi8KX5SV6kooWsg8aw6kmB2pCFBjrqK3UoVpTWeWG1JWK85AiYpQuBx1`)
  — 0.0006 BAYLA per staked BAYLA per day at 1.00x, **permissionless funding**.
  Reward vault: `5vcKG4rnmZ4TNy5ADdKNCwqcP8myQSLKitrkSeg6RHgq`.
- Verified on-chain post-creation: maxWeight 5x, min 1d, max 365d, rate
  0.0006, authority `GCCSLE7d…auV9`, totalStake 0, vault **0 — honest zero**.

The ladder the operator chose (pinned by test in `bungalowStakingRates.test.ts`):

| Lock | Weight | Simple APR |
|---|---|---|
| 1 day | 1.000x | 21.9% |
| 7 days | 1.066x | 23.3% |
| 30 days | 1.319x | 28.9% |
| 90 days | 1.978x | 43.3% |
| 180 days | 2.967x | 65.0% |
| 365 days | 5.000x | **109.5%** |

⚠️ **FUND THIS POOL, NOT THE OLD ONE:**
`node "<repo>\frontend\scripts\bayla-lighthouse-ceremony.mjs" --fund --pool EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f --amount <whole BAYLA> --keypair <id.json> --broadcast`

The retired pool still holds the operator's own 1,000 BAYLA dust-test stake,
locked until ~2027-08-29. Nothing can release it early (§5b) — it is ~$0.50
and is written off deliberately.

## 6f. THE FIRST MAINNET CEREMONY — RETIRED, see §6g (2026-08-26)

Executed by the operator with the designated ceremony key
(`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`, the pool's admin authority
going forward — note it lives as a keyfile in the OneDrive-synced faucet
folder; custody caveat accepted by the operator on 2026-08-26):

- **Stake pool: `4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp`**
  (tx `3vDxaGWo9ZrzrNWQumqe9AG2oUxJU4YRCoBBbthf8SykVTTQxmP5s2j1pvcPHZmA7PpET9vXV2s19rvMEFcAzeoB`)
  — BAYLA mint, locks 1–365 days, flat 1x weight, Token-2022 program
  auto-detected (`TokenzQd…` — the first broadcast died assuming legacy;
  detection is now baked into script + adapter).
- **Reward pool: `HdapJt3cJ92fBcoCiaeAyACicXGF9m6RGQdWRMX9L9XL`**
  (tx `3dgfyV2EgyxT1pszEc9k1RzBbFi9SNARtVKKDDE6SpBoJDbyuiMSu5EhihM6JXmeNGurKrkgyFiCyiburzBUCSR`)
  — 0.003 BAYLA per staked BAYLA per day, **permissionless public funding**.
- Verified independently through the app's own read path post-creation:
  pool live, totalStake 0, reward vault **0 raw — the honest zero**.
- The address ships **hardcoded in the registry** (env override retained),
  so no Vercel env var is load-bearing for the live pool.

⚠️ The `--fund --pool 4WCpdeQ2…GXPp` command that used to live here has been
removed: funding this retired pool would send BAYLA to a vault nobody is
staked against. **Use the §6g command instead.** The dust live-fire it called
for was completed on 2026-08-29 (1,000 BAYLA staked through the live UI with a
real wallet, read back on prod) — it is what proved the rail end to end, and
it is also what is now stranded here until ~2027-08-29.

## 6e. DEVNET REHEARSAL — the entire lifecycle executed (2026-08-26)

The full pool lifecycle ran on devnet with REAL transactions through the
exact SDK flows the app and the mainnet ceremony use (Streamflow deploys
the same program ids on both clusters). Final state after the round trip:
`totalStake = 0`, everything claimed and closed.

| Step | Devnet signature |
|---|---|
| createStakePool → `DcFMJPnUuaaVPfFBitgGEoDK4cpuazCTWC7Jp794kw48` | `bc93u5envgLQ…fwfEdQW` |
| createRewardPool → `4EehnXNUyJCokn7pe9QPhDT4QH9jcXaXkQEfZnuSYrxG` | `3BnXpgnhwS1H…JPyJPkA` |
| **fundPool (100,000 tokens — the task-#13 op)** | `NR71dGyJPRms…fjgMiGK` |
| stakeAndCreateEntries (1,000 tokens) | `2bnQsmuDA8D1…au8rTUUZ` |
| claimRewards | `5coBCKECGcc6…BYsE9bPp` |
| unstakeAndClaim (+close) | `2bTK9LXkESGb…naweJMyN` |

Explorer: https://solscan.io/account/DcFMJPnUuaaVPfFBitgGEoDK4cpuazCTWC7Jp794kw48?cluster=devnet

**Four traps found live and now BAKED into the tooling** (each one would
have burned the mainnet ceremony or a first-time staker):

1. `createRewardPool` requires `stakePoolNonce` and `lastClaimPeriodOpt` —
   the SDK README's example omits both; the shipped .d.ts is the truth.
2. `fundPool` must pass `feeValue: null` to route the fee check to the
   fee-manager's default config — omitting it derives a per-funder PDA that
   was never initialized (AccountNotInitialized).
3. Funding expects **Streamflow's treasury ATA for the reward mint** to
   exist — the ceremony script creates it idempotently first.
4. Staking expects the **staker's ATA for the stake-mint PDA** (the receipt
   token) — the frontend adapter now prepends an idempotent create to the
   SAME transaction via the SDK's prepare-path + execute, so first-time
   stakers can never hit it.

The rehearsal is rerunnable any time:
`node scripts/bayla-lighthouse-ceremony.mjs --rehearse [--funder <devnet-keypair.json>]`.

## 6d. THE FLIP — everything is built; funding is last (shipped 2026-08-26)

The live Streamflow integration is now IN the app, dark until configured.
The operator's remaining path, in order:

1. **Ceremony** (task #12): create the BAYLA stake pool + one fixed reward
   pool (reward mint = BAYLA; `permissionless: true` on the reward pool so
   anyone can top it up in public). Record every parameter + the stake-pool
   address here.
2. **Set `VITE_BAYLA_STAKE_POOL=<stake pool address>`** in Vercel env →
   redeploy. That single env var flips /farm in bayla mode from the dark
   card to the live lighthouse section: vault balance (a labeled 0 until
   funded), total staked, lock window, stake form, entries with
   claim/unstake — all direct on-chain reads through the venue's own RPC
   proxy. No code commit needed.
3. **Live-fire test (MANDATORY before announcing):** with a dust wallet —
   stake a token, claim (0), unstake — one full round trip. The write paths
   ride Streamflow's grouped SDK flows (`stakeAndCreateEntries`,
   `unstakeAndClaim`, `claimRewards` — argument shapes pinned against SDK
   13.3.1's own type definitions, claim's required `stakePoolMint`
   included), but the SDK notes ATAs are expected to exist; if the dust
   round-trip trips on a missing ATA, Claude adds the pre-instructions via
   the SDK's `prepare*` path — a bounded follow-up, not a redesign.
4. **Announce.** The page is honest at this point by construction: the
   vault reads 0 and says staking earns nothing yet.
5. **FUND LAST** (task #13): claim the PumpSwap creator fees → deposit into
   the reward pool (their UI or `fundPool`). The vault balance on the panel
   climbs with every top-up, publicly.

What ships in code (commit-level detail): `lib/bungalowStaking.ts` — the
thin adapter over @streamflow/staking 13.3.1 (dynamic imports only; zero
custom money math; all failures resolve as honest reasons, wallet
rejections read "You declined the signature — nothing moved.");
`LighthousePoolLive.tsx` — its own lazy chunk (~12 kB + SDK on demand), so
nothing loads until a pool is configured; registry `stakePool` env
plumbing; 7 adapter tests against a mocked SDK (vault 0 vs unreadable is
pinned: zero is a fact, unreadable is an outage); an env-keyed dev probe
verified the flip end-to-end (dark card ↔ live section) before commit.

## 6h. DRY-VAULT REHEARSAL — funding-last's missing proof, executed (2026-08-28)

The normal rehearsal (§6e) funded the vault BEFORE staking, so it never
exercised the one state funding-last guarantees on mainnet: accrued
entitlement > 0 against an empty vault. `--rehearse --dry-vault` (now a
permanent mode of the ceremony script) ran the whole question on devnet —
same program ids as mainnet, real transactions, pool
`4xou7RD99YQvZWhreb9RLpDnjcjv1rBfMCBzs49FNSpD` (devnet):

- **Claim against the empty vault: REVERTS** — Streamflow custom error
  **6012** (tx `2kb9xBte…3LBT`). It does not pay zero.
- **Unstake&claim against the empty vault: REVERTS with the same 6012**
  (tx `5q6G9MsY…ZKLx`) — **principal is HOSTAGE to vault funding**: the
  grouped exit pays rewards in the same transaction, so a staker cannot
  withdraw until the vault covers their accrual.
- **The backlog is NOT forfeited.** After funding, the first claim paid the
  FULL dry-window accrual (66,000,000 raw vs a 15,000,000-raw post-funding
  rate control — ~22 periods vs ~5). Patient stakers lose nothing once
  funding arrives; they just cannot exit before it.
- Mainnet state at proof time: totalStake **0**, vault **0** — nobody was
  exposed. The window to ship guardrails before the first staker was open,
  and they shipped the same day.

**Consequences shipped in code (2026-08-28):** the live panel DISABLES new
stakes while the vault is materially empty (< 1 whole token, or < 1 day of
burn at the current stake — dust cannot clear the gate), renders the
configured rate + the vault's runway as the exit-safety headline, labels
claims "Nothing claimable yet" during a dry window, and maps error 6012 to
its proven meaning instead of a generic failure. `writeFailure` also stops
claiming "nothing moved" on post-broadcast confirmation timeouts (outcome
unknown + signature instead).

⚠️ **Correction to step 3 above ("claim (0)")**: a dry claim does NOT
return 0 — it REVERTS with 6012. During the mainnet live-fire, a 6012 on
claim/unstake before funding is the PROGRAM WORKING AS PROVEN, not an
integration bug. Fund a sliver first (or run the live-fire after task #13)
if the round trip must fully complete.

## 6. Open operator items

0. **NEW 2026-08-28 — the pool has no duration bonus.** It was created with
   `minWeight == maxWeight == 1e9`, so a 365-day lock earns exactly what a
   1-day lock earns; only the exit date changes. If TOWELI-style "lock longer,
   earn more" was the intent, it needs a NEW stake pool (`maxWeight` is set at
   creation) and a staker migration — the UI already implements the program's
   real weight curve and would light up with zero changes. Decide.
   Details: `BAYLA_STAKING_SWAP_2026_08_28.md` §4.1.
0b. **NEW 2026-08-28 — the reward pool is `permissionless: true`.** A one-click
   "top up the reward vault" button is buildable (SDK `fundPool`) and was left
   out only because Streamflow takes a protocol fee on funding that must be
   read and disclosed first. Say the word.
1. Streamflow pool ceremony (or veto → fallback order in §3).
2. First reward-pool funding: source (creator-fee claim vs. top-up) and
   size; the panel flips to live numbers only after this.
3. Whether the venue's Solana platform fee tithes a share to bungalow
   pools (policy + %).
4. Full white-label question (§5).
5. The 10 other bungalows' art drops, if/when each community wants its
   skin — the recipe is `JUNGLE_BAY_ISLAND_PLAN.md` §2; the registry and
   picker already carry all 13 with canon addresses.
