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

- No APR, no runway, no "coming soon" dates anywhere in the UI — the panel
  states the pool doesn't exist and describes the funding routes as
  evaluation, because that is the truth on 2026-08-24.
- BAYLA staking is **not** TegridyStaking: nothing about the Ethereum
  contract, its boosts, locks or its EIP-170 headroom transfers here.
- The venue wordmark stays TEGRIDY FARMS in bayla mode for now (chrome, not
  copy). If the operator wants full white-labeling per bungalow (wordmark,
  domain per bungalow, e.g. bayla.memetics.finance), that is a routing +
  branding decision to take deliberately — flagged, not assumed.

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

## 6. Open operator items

1. Streamflow pool ceremony (or veto → fallback order in §3).
2. First reward-pool funding: source (creator-fee claim vs. top-up) and
   size; the panel flips to live numbers only after this.
3. Whether the venue's Solana platform fee tithes a share to bungalow
   pools (policy + %).
4. Full white-label question (§5).
5. The 10 other bungalows' art drops, if/when each community wants its
   skin — the recipe is `JUNGLE_BAY_ISLAND_PLAN.md` §2; the registry and
   picker already carry all 13 with canon addresses.
