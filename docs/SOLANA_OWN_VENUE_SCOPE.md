# Solana own-venue graduation — what is actually left

Owner directive 2026-07-28: build a **pump.fun-style bonding curve of our own**, and have
launched tokens **graduate into a venue we own**.

> **Correction (2026-07-28).** An earlier draft of this file estimated the Solana AMM as a
> ~700–1,000 LoC from-scratch build with a $60–150k audit. **That was wrong.** It was
> written from memory without checking the repo. `solana/tegridy-amm/` already contains a
> working Anchor project — a verbatim fork of Raydium's audited CPMM — and the operator
> already took the own-venue decision there on **2026-07-10**. The AMM half is largely
> done. Only the curve is missing. Figures below are the corrected ones.

> **Correction (2026-08-02) — the curve now EXISTS.** Everything below that says the
> bonding curve "does not exist" was true when written and is now stale: `tegridy-launch`
> was built between 2026-07-28 and 2026-07-30 and is on trunk (`origin/mvp-launch`,
> `solana/tegridy-amm/programs/tegridy-launch/`). The scope estimates it gave were roughly
> right — the delivered program is **1,170 production nSLOC (2,528 raw)** against the
> ~700–1,100 LoC estimate. This block is the authority where it conflicts with the text
> below; individual stale claims are corrected in place and marked.
>
> **What changed, what did not:** the curve is written, tested and CI-green. It is
> **deployed to no cluster** (`getAccountInfo` returns `null` on mainnet-beta, devnet and
> testnet for all four program ids — re-verified 2026-08-02) and **not audited** (the RFQ
> in `AUDIT_OUTREACH.md` still reads `Hi [Firm],` and has never been sent). The two
> standing constraints in "The risk that did not change" below are **unchanged and still
> the whole ballgame**: Jupiter discovery, and break-even volume.

## Ground truth in the repo today

**`solana/tegridy-amm/` — Tegridy CP-AMM. EXISTS, 72 tracked files.**

- Verbatim fork of [`raydium-cp-swap`](https://github.com/raydium-io/raydium-cp-swap)
  @ `78f254e`, **Apache-2.0**, audited, billions in production TVL.
- **The entire delta from upstream is four authority/identity constants across two files.**
  All swap, curve, and fee math is byte-identical to upstream. `solana-ci.yml` has a
  `diff-guard` job that enforces this automatically.
- Protocol fee is **config-driven, not hardcoded** — `amm_config.protocol_fee_rate` set at
  `create_config`, collected by `protocol_owner`. So the venue economics need no code change.
- Ships with `AUDIT_RFQ.md`, `MAINNET_RUNBOOK.md`, `SECURITY.md`, and a devnet deploy script.
- **Status: Phase 0. NOT audited. Deployed to NO cluster** — not mainnet, not devnet, not
  testnet. It has only ever run on an ephemeral CI validator. Holds no real funds.
  *(Corrected 2026-08-02: this line previously read "Devnet", which overstated it.)*

**~~What does NOT exist: the bonding curve.~~ SUPERSEDED 2026-08-02 — it exists.**
`programs/` now contains **`cp-swap` and `tegridy-launch`**. The curve program implements six
instructions — `initialize_global`, `update_global`, `create_launch`, `buy`, `sell`,
`migrate_to_amm` — over a constant product on virtual reserves, and graduates atomically into
a Tegridy CP-AMM pool at our own PDA `["launchpool", mint]`, burning 100% of the LP.

There is deliberately **no standalone `graduate` instruction**: one existed and was removed in
`c5ea2711` because it set `complete` without moving liquidity, and since `buy`/`sell` both
require `!complete` and `sell` was the only SOL exit, any caller could permanently strand
every lamport raised. Graduation happens only inside `migrate_to_amm`.

## So the remaining work is deploy + audit + product, not the curve

| Piece | State | Remaining |
| --- | --- | --- |
| AMM to graduate into | **Built** (4-constant fork) | Diff-audit + mainnet deploy per the existing runbook |
| Bonding curve program | **Built** — 1,170 nSLOC, 6 instructions, CI-green | Audit; deploy; real program id (`declare_id!` is a labelled throwaway) |
| Curve → AMM graduation | **Built** — atomic inside `migrate_to_amm` | The highest-risk instruction; deepest audit focus. 264,128 CU — every client MUST raise the compute limit |
| Fee/treasury routing | Config-driven in the AMM; curve pays `global.fee_recipient` | Pick the actual fee values — **not one is chosen in the repo yet** |
| Creator fee share | **Does not exist — creator is paid ZERO** | Spec'd 2026-08-02: [`programs/tegridy-launch/CREATOR_FEE_SPEC.md`](../solana/tegridy-amm/programs/tegridy-launch/CREATOR_FEE_SPEC.md). Decide before the audit is scoped |
| Token metadata | **Does not exist** | `create_launch` takes no args and never touches Metaplex — launched tokens are nameless in every wallet and explorer |
| Discovery / feed | **Does not exist** | `getProgramAccounts` is off the RPC proxy allowlist; a launch is resolvable only if you already know its mint. No indexer, no DB table |
| Anti-snipe | **Does not exist** | Meteora's rail ships a 9900→100 bps 6h decay; ours has none, so block one is a free snipe |
| Frontend write path | **Does not exist** | `writeClient={null}` is hardcoded; `CurveWriteClient` declares only `buy`/`sell` and has zero implementations |
| Migration keeper | **Does not exist** | `migrate_to_amm` is permissionless but somebody must call it and retry through the accepted dust-`sell` stall |

### Corrected cost

- **AMM audit:** a *diff-audit* of four constants against audited upstream. Fast and cheap
  relative to a from-scratch AMM review — that is the entire point of the verbatim fork.
  `AUDIT_RFQ.md` is already written and names OtterSec / Neodyme / Sec3 / Zellic.
- **Curve audit:** this is where the real money goes. The curve and its graduation
  instruction are genuinely new, fund-holding code with no audited upstream to diff against.
- **Engineering:** roughly 3–6 weeks for the curve, not the 2–4 months the from-scratch
  framing implied.

## The risk that did not change

**The curve→AMM graduation instruction is where Solana launchpads get drained.** It moves
the entire raised balance in one instruction, and unlike the AMM it has no audited
reference to copy. Whatever else gets trimmed, that instruction deserves the deepest
review in the whole program.

Two other standing constraints, both unchanged:

- **Jupiter routing.** Our pools are invisible to retail until the Tegridy CP-AMM is
  submitted to Jupiter's DEX integration (step 8 of the mainnet runbook). Until then volume
  comes only from our own swap UI. Owning the venue costs discovery before it earns fees.
- **Break-even.** The ~$11.7M/mo figure is a property of running our own venue, not of how
  the AMM got written. Forking cheaply lowers the build cost, not the volume needed.

## The doctrine question, settled

`project_2026_06_18_solana_fee_capture`'s "no own AMM on Solana" was **superseded on
2026-07-10**, when the operator chose Model B (own venue) over Model A (be an LP) — recorded
in `TEGRIDY_FORK.md`. The 2026-07-28 directive continues that line rather than reversing it.

**"No TOWELI on Solana" is untouched and still absolute.** Nothing in the AMM fork or the
proposed curve puts TOWELI on Solana, and the two decisions must not be conflated.

## Recommended order

*Updated 2026-08-02. Step 1 is done; step 2 was recommended "now", in parallel, and never
happened — it is the critical path.*

1. ~~**Curve program**~~ — **DONE.** Built, tested, CI-green, on trunk.
2. 🔴 **Send the audit RFQ. This is the blocker.** `AUDIT_OUTREACH.md` is written and still
   reads `Hi [Firm],` — it has never been sent, so there is no quote, no start date and no
   scope-B price. The `$30k` in every break-even figure in this repo is an internal estimate
   from a document that was arguing *against* the build. This file said in July that "audit
   calendars — not engineering — are usually the schedule constraint," recommended sending
   in parallel with the build, and the build finished first anyway.
3. **Decide the creator fee split before that RFQ goes out** (`CREATOR_FEE_SPEC.md`).
   Adding a creator payout changes `buy`/`sell` and therefore the scope being quoted.
   Deciding it after the quote means re-scoping and re-quoting.
4. **Curve audit**, then remediation.
5. **Mainnet**, following the existing `MAINNET_RUNBOOK.md`: dedicated program keypair,
   `admin::ID` → Squads multisig, upgrade authority → multisig or burned, verifiable build,
   then Jupiter submission.

## Open decisions for the operator

**Settled since this list was written (2026-08-02):**

- ~~Curve shape~~ — **constant product on virtual reserves**, as recommended. `curve.rs`.
- ~~Per-launch or shared pool~~ — **per-launch**, at our own PDA `["launchpool", mint]`
  rather than cp-swap's canonical derivation, which is publicly squattable and would be a
  permanent graduation brick for the cost of one transaction.

**Still open, and now more urgent than they were:**

- 🔴 **Does the creator get paid anything?** Today they get **zero** — 100% of the trade fee
  goes to `global.fee_recipient`. Our own Meteora rail pays creators 48 bps and pump.fun
  pays 30 bps, so as built this venue is the least attractive of the three to the exact
  people it needs to attract. Post-graduation it is structurally zero too: our migration
  calls cp-swap's permissionless `initialize`, which hardcodes `enable_creator_fee = false`,
  and the fork has no setter — **the curve is the only place a creator can ever be paid.**
  Spec'd 2026-08-02 with a recommended 48 bps (parity with our own Meteora rail):
  [`programs/tegridy-launch/CREATOR_FEE_SPEC.md`](../solana/tegridy-amm/programs/tegridy-launch/CREATOR_FEE_SPEC.md).
- 🔴 **The actual fee values.** Not one is chosen anywhere in the repo. `trade_fee_bps`,
  `trade_fee_rate`, `protocol_fee_rate`, `fund_fee_rate` and `create_pool_fee` are all
  runtime arguments with no committed default. The only concrete numbers in-repo are the
  1000 bps curve ceiling, the 1e6 denominator, and the runbook's explicitly-labelled "e.g."
  values. Note the post-graduation trap: we burn 100% of the LP, so the only configuration
  where the graduated pool matches Meteora's locked-LP annuity is `protocol_fee_rate ≈ 100%`
  — which leaves third-party LPs nothing, so the pool can never deepen past its graduation
  size and fails Jupiter's routing threshold on day one.
- **Squads multisig + threshold** for `admin::ID` and the program upgrade authority.
  Threshold must be ≥2 — the existing `squads.ts` threshold requirement is already a
  documented go-live blocker. Both mainnet `admin::ID` constants are still fail-closed
  all-1s System-Program sentinels.
- **Ship-without-product question.** Metadata, discovery, price/mcap and anti-snipe are all
  absent (see the table above). A venue whose tokens are nameless and unlistable is not yet
  a competing product, regardless of how good the curve is.
