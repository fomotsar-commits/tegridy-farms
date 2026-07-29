# Solana own-venue graduation — scope before we write Rust

Owner directive 2026-07-28: build a **pump.fun-style bonding curve of our own** on
Solana, and have launched tokens **graduate into a venue we own**.

This document exists so that decision is costed before anyone opens an Anchor project.
Nothing here is built yet.

> **Unchanged and still absolute: no TOWELI on Solana.** The operator changed the
> venue-ownership call, not the token-deployment doctrine. Nothing in this plan puts
> TOWELI on Solana, and nothing here should be read as loosening that.

## Why this is a build and not a config change

On EVM, Doppler's Airlock accepts a pluggable `LiquidityMigrator` module, so owning the
graduation venue is one new contract plus a whitelist. **Solana has no equivalent.**

`frontend/src/lib/launcher/solana/dbc.ts:483` pins `migrationOption: MIGRATE_TO_DAMM_V2`,
and Meteora's `MigrationOption` enum offers exactly two values — DAMM v1 and DAMM v2.
There is no custom-migrator hook, no callback, no "graduate to an arbitrary program"
escape. Meteora's curve graduates into Meteora's AMM, full stop.

So owning graduation on Solana means replacing **both** halves:

1. our own bonding curve (replacing Meteora DBC), and
2. our own AMM for it to graduate into (replacing DAMM v2).

You cannot do only one. A curve of ours that still graduates into DAMM v2 leaves the
annuity with Meteora; an AMM of ours with no curve feeding it has nothing to graduate.

## What has to be written

| Component | Est. LoC (Rust/Anchor) | Notes |
| --- | --- | --- |
| Bonding curve program | 700–1,100 | Virtual constant-product reserves, buy/sell, fee schedule, anti-snipe decay, immutable/no-mint SPL, graduation trigger |
| AMM program | 700–1,000 | Constant-product pool, LP accounting, swap, fee split, permanent-lock path |
| Migration instruction | 150–250 | Atomic curve→AMM handoff; the highest-risk surface in the whole design |
| Fee/treasury routing | 150–250 | Squads-vault-only claim path, mirroring the custody invariant already in `dbc.ts` |
| **Total** | **~1,700–2,600** | From scratch |

Plus: TypeScript client, an operator harness, and a full test suite (Anchor + a
localnet/fork integration pass).

## Cost and schedule

- **Engineering:** ~2–4 months to audit-ready, assuming Rust/Anchor familiarity.
- **Audit:** this is new, novel, custody-bearing Rust. Comparable Solana AMM/curve audits
  land in the **$60k–150k** range; a cheap audit on this surface is worse than none.
- **Ongoing:** program upgrade-authority custody (must be Squads, never an EOA), plus a
  standing security contact.

## The honest risk assessment

**This is the highest-risk thing the protocol would have ever shipped.** The existing
Solana leg is a config-and-frontend integration on top of Meteora's audited program with
zero custody surface of our own. Replacing it with ~2,000 lines of our own Rust holding
user funds inverts that posture completely.

Three specific hazards worth naming before committing:

1. **The migration instruction is where Solana launchpads get drained.** The
   curve→AMM handoff moves the entire raised balance in one instruction. It is the single
   most attacked surface in this class of program and it is the part we would be writing
   from scratch with no audited reference to copy.
2. **We lose Jupiter routing and the JupPro Launchpad Screener**, both of which only
   index DBC launchpads. Our own venue starts with no aggregator flow and no discovery —
   the exact distribution problem that the earlier research named as the *binding*
   constraint. Owning the venue makes discovery worse before it makes revenue better.
3. **Break-even is far away.** The earlier assessment put own-pool break-even around
   **$11.7M/mo volume**. Current launcher throughput is approximately zero. This is a moat
   and optionality play; it should not be budgeted as revenue.

None of this is an argument not to do it — the operator has weighed it and chosen. It is
an argument for sequencing it **after** the EVM leg proves the graduation thesis, and for
not skimping on the audit.

## Recommended sequencing

1. **Land the EVM leg first.** `TegridyLiquidityMigrator` + `TegridyV4Hook` are written
   and tested; they need the Whetstone whitelist and the V4 audit. That leg proves
   whether own-venue graduation actually attracts launches — for a fraction of the cost,
   because the hook already existed.
2. **Watch one real signal.** If graduated EVM launches produce measurable fee flow, the
   Solana build has an evidence base. If they do not, we have learned that cheaply.
3. **Then commit the Solana budget** — and budget the audit at the same time as the
   engineering, not after.

If you would rather run both in parallel, the fastest way to de-risk is to commission the
audit slot early: audit calendars, not engineering, are usually the schedule constraint.

## Open decisions for the operator

- Parallel with EVM, or sequenced behind it? (Recommendation: sequenced.)
- Audit firm and budget ceiling.
- Program upgrade authority: which Squads multisig, at what threshold? (Must be ≥2 —
  the existing `squads.ts` threshold requirement is a documented go-live blocker.)
- Do we keep the Meteora DBC rail alive alongside ours, or replace it? Keeping both
  doubles the surface to maintain and to describe honestly in the Fact Sheet.
