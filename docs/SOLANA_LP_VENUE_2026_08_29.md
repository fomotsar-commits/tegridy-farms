# Hosting liquidity pools on Solana — the client, the router, the surface (2026-08-29)

Operator ask, verbatim: *"we should showcase the fact that we can host liquidity
pools on solana so people can provide lp and we can get fees. the swap should
also route to our lps unless it is more efficient somewhere else… it shouldnt be
a route to jupiter it should be leveraging code from the best aggregator on
solana, battle tested never been exploited code only."*

Everything buildable without operator keys is built and green. What is left is a
keypair, a funded admin, and one instruction.

---

## 0. The finding that reframed the job

`solana/tegridy-amm/programs/cp-swap/` is **a verbatim fork of
raydium-cp-swap** pinned to upstream `78f254e1023751e706df7dc15c453fc3e046697c`.
CI's `diff-guard` proves it mechanically rather than by assertion: it clones
upstream, runs `diff -rq` across the whole `src/` tree, **refuses any differing
file outside two**, then canonicalises the remaining delta and sha256-hashes it
against a pinned value. Current delta: **86 lines across `lib.rs`,
`instructions/admin/create_support_mint_associated.rs` and `Cargo.toml`** — all
of it authority constants (`admin::ID`, the pool-fee receiver, `declare_id!`)
and comments.

So the curve, the swap, deposit, withdraw, the fee maths and the oracle are
**Raydium's, unmodified**. That is the "battle-tested, billion-dollar, unhacked"
bar the operator set, and it was already met — the only bespoke thing is who the
admin is and who gets paid.

**And LP hosting does not need the bonding curve at all.** The restart plan
bundles cp-swap with `tegridy-launch` because *graduation* needs both. Pool
hosting needs only cp-swap:

| capability | instruction | who can call it |
| --- | --- | --- |
| open a pool | `initialize` | **anyone** — `creator: Signer` has no address constraint |
| provide liquidity | `deposit` | anyone |
| withdraw | `withdraw` | any LP-token holder |
| set the fee tier | `create_amm_config` | `admin::ID` only |
| sweep our cut | `collect_protocol_fee` / `collect_fund_fee` | `protocol_owner` / `fund_owner` |

---

## 1. What shipped

### `lib/solana/cpswap/` — the client

Same discipline as the bonding-curve client, and it **reuses** that client's
account-fetch seam and `readDeployment` rather than building a second one.

- **`math.ts`** — a BigInt port of `fees.rs`, `constant_product.rs` and
  `CurveCalculator::swap_base_input`, plus `vault_amount_without_fee`. Imports
  nothing. Every `ceil_div` / `floor_div` distinction is preserved, because
  those decide who eats the rounding. `math.test.ts` runs the program's **own
  Rust test vectors** — all ten `constant_product_swap_rounding` cases and all
  three `trading_token_conversion` cases, copied verbatim, including the
  `fail_trading_token_conversion` overflow cases (BigInt has no u128 ceiling, so
  an explicit `U128_MAX` guard makes the port refuse where Rust panics).
- **`program.ts`** — identity, PDAs, discriminators, and the `AmmConfig` /
  `PoolState` layouts decoded by byte offset (there is no committed IDL).
- **`read.ts`** — venue status, pool + vault reads, the quote, and LP position
  value.
- **`ix.ts`** — `initialize` / `deposit` / `withdraw` / `swap_base_input`
  builders.
- **`venue.ts`** — the proposed fee sheet (§2).

### The guards, which are the point

The audit ledger records how a hand-encoded client rots, twice:
`decodeBondingCurve` used `BONDING_CURVE_SIZE = 162` against a program writing
716-byte accounts; `tradeKeys` shipped 9 of the program's 10 accounts. **Both
had green unit tests**, because those tests pinned the client's own constants
back to itself.

So neither guard here restates anything:

- **`program.test.ts`** parses `pub struct AmmConfig` and `pub struct PoolState`
  out of the Rust, maps each field's type to a byte width, **recomputes every
  offset**, and compares. It also asserts `#[repr(C, packed)]` is still there
  (with plain `repr(C)` half the offsets would silently shift), re-hashes every
  Anchor discriminator, and reads the PDA seed strings out of the program.
- **`ix.test.ts`** parses each `#[derive(Accounts)]` struct and compares our
  account lists **name, order, signer flag and writable flag**. An account added
  upstream fails the test instead of shipping a transaction that reverts.

### `lib/solana/route.ts` — the router

One rule: **route to our own pool unless somewhere else is more efficient**, with
the second half read as strictly as the first.

- A tie goes to our pool. Anything short of a tie does not.
- **No tolerance band, and deliberately no knob to add one** — a "within N bps,
  keep it in-house" band is how a best-execution promise becomes a marketing
  line. `route.test.ts` pins that one raw unit is enough to lose.
- Comparison is BigInt, so precision cannot decide a winner (there is a test at
  2⁵³+1 for exactly that).
- The aggregator candidate uses `outAmount`, **not** `otherAmountThreshold` —
  the latter is the post-slippage floor and would bias every comparison toward
  our own pool.

### `components/swap/SolanaRouteLine.tsx`

The disclosure, on the Solana swap under the quote, **in every state including
the ones where we lose or have nothing to offer**. A routing disclosure that
only appears when the house wins is an advert. Today it reads *"Routed to
Jupiter. This venue has no pool for this pair."*

### `pages/PoolsPage.tsx` — `/pools`

The showcase, driven by a **live chain probe** rather than copy. It names the
venue's real state precisely — no program id / closed / squatted / deployed but
no config / live — and shows the fee sheet with a `PROPOSAL` badge until an
`AmmConfig` exists to read. In the `no-config` state it prints the exact missing
instruction with its arguments.

The probe goes through `readDeployment`, **not** `getAccountInfo`: a closed
upgradeable program's stub stays executable-flagged, so the naive check reports
a spent id as deployed.

---

## 2. The fee sheet — competitive, and grounded

`RECOMMENDED_AMM_CONFIG` in `venue.ts`. Denominator is 1,000,000.

| parameter | value | meaning |
| --- | --- | --- |
| `trade_fee_rate` | `2500` | **0.25%** per trade |
| `protocol_fee_rate` | `120000` | 12% **of the fee** → 0.03% of volume |
| `fund_fee_rate` | `40000` | 4% of the fee → 0.01% of volume |
| `create_pool_fee` | `150000000` | **0.15 SOL** to open a pool |
| `creator_fee_rate` | `0` | off at launch |

**Trader pays 0.25%. LPs keep 0.21%. The venue takes 0.04%.**

This is Raydium's standard CPMM tier — the tier LPs and traders actually compare
against — and it is *already* the config this repo's own migration rehearsal
creates (`tegridy-launch-migration.test.ts`:
`createAmmConfig(index, 2500, 120000, 0, 0.15 SOL, 0)`). `venue.test.ts` reads
that test file and pins the agreement, so the proposal cannot drift from the
only end-to-end config the repo exercises. The one deliberate difference is
`fund_fee_rate: 40000` rather than 0, which splits the venue's cut across two
collectors so the treasury and the operating wallet can be different accounts
without a second fee tier.

`creator_fee_rate` ships at 0 because a creator fee is charged **on top of** the
trade fee — switching it on raises the cost of every trade in the pool. The
restart plan's open question 3 asks whether it should be on at all; nobody has
recorded a position, and `update_config` can raise it later.

⚠️ **These numbers describe a proposal, not a reading.** Every surface takes its
live fee from `readVenue()`, which reads the chain. `feeSplit()` is the same
function over both, so the disclosure and the proposal cannot drift.

---

## 3. What only the operator can do

The old program ids are permanently spent, so this is a fresh deploy.

1. **Fresh keypair + new `declare_id!`** for cp-swap.
2. **`admin::ID` must be a signable, system-owned, funded account.** It is
   resolved at compile time, so a wrong value costs another program upgrade.
   This is what bricked 2026-08-08: it was set to the Squads *multisig account*,
   which can neither sign a CPI nor pay rent, making `create_amm_config`
   permanently uncallable. Fund it above AmmConfig rent — the audit found it
   holding 0.001 SOL.
3. **`create_pool_fee_reveiver::ID` must be a WSOL token account, not a
   wallet** — the create path deserializes it as `InterfaceAccount<TokenAccount>`
   and calls `sync_native`. Also compile-time. Create the treasury's WSOL ATA
   *before* the deploy.
4. **Deploy, then run `create_amm_config`** with the §2 arguments. This two-step
   has never once run.
5. **Publish the new id as `VITE_SOLANA_CPSWAP_PROGRAM`.** Everything above then
   flips: `/pools` goes live, the fee sheet starts reading from chain, and the
   swap starts quoting our pools — no code change.
6. **Arm branch protection.** `diff-guard` is the fork's entire security
   invariant and it is currently *advisory* (zero required checks on
   `mvp-launch`). Unenforced, the thing keeping this "verbatim Raydium" is a
   comment.

Graduation (launches landing in our pools) additionally needs `tegridy-launch`
deployed and `create_permission_pda` — with the seed trap: the PDA is **created**
at `[PERMISSION_SEED, permission_authority]` but **consumed** at
`[PERMISSION_SEED, payer]`. Derive both and compare before sending.

---

## 4. The aggregator question

Two different things get called "Jupiter" and only one is worth removing.

- **The routing engine.** It carries the large majority of Solana aggregator
  volume and the longest track record of any router on the chain. Replacing it
  with a smaller aggregator would move us off the most-used code onto less-used
  code — backwards from the stated ethos, not toward it.
- **The hosted endpoint** (`lite-api.jup.ag` via our same-origin proxy). *This*
  is the real dependency: if it rate-limits or goes down, our swap dies. Jupiter
  ships a self-hostable swap API that is behaviourally identical to the public
  one, so routing can run on our own infra and our own RPC without changing the
  execution program.

**Recommendation: put our pools in front of the router (done), then move to
self-hosted routing to kill the service dependency — not swap the engine.**

⚠️ **One leg of this is unfinished.** The security-history research was stopped
partway. Nothing above rests on a claim about any aggregator's exploit record,
and no engine change is proposed — but if an engine swap is ever on the table,
that research has to be completed first.

---

## 5. What is NOT built, and why

**Executing a swap against our own pool.** The builders exist and are
source-verified, but no code path sends them, because the program is not
deployed and cannot be. Shipping an unexercised money-path execution is the
exact class of defect the audit ledger is full of. Today it is moot — with no
venue, `ownPoolCandidate` is always null and the router always picks the
aggregator. **Wiring execution is the first task after the redeploy**, and CI's
`migration-rehearsal` job (which deploys both programs to a validator) is where
it gets its first real execution.

Same for the LP deposit/withdraw forms on `/pools`: the instruction builders are
ready; the forms wait for a program to talk to.

---

## 6. Verification

- `npx tsc -b` clean; eslint clean on every new file.
- **444 test files / 6261 tests green** (105 new).
- New suites: `math.test.ts` (30, Rust vectors), `program.test.ts` (31, layouts
  re-derived from source), `ix.test.ts` (22, account lists parsed from source),
  `route.test.ts` (14, including every case where our pool loses),
  `venue.test.ts` (8, fee sheet pinned to the rehearsal config).
- Live in the browser: `/pools` renders the real "The AMM is being redeployed"
  status from a chain probe with the spent id; the fee card shows
  `0.25% / 0.21% / 0.04% / 0.15 SOL` under a `PROPOSAL` badge; the Solana swap
  shows `ROUTE — Routed to Jupiter. This venue has no pool for this pair.`
  against a live 0.1 SOL → BAYLA quote.
