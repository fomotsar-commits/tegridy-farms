# Fork-vs-build: the bonding curve

**Decision record. Written 2026-08-08, because it should have been written 2026-07-28 and wasn't.**

Sibling to [`solana/tegridy-amm/TEGRIDY_FORK.md`](../solana/tegridy-amm/TEGRIDY_FORK.md), which asks and answers this same question for the **AMM**. There was no counterpart for the **curve** until now.

---

## Why this document exists

The AMM half of the own-venue stack has a written fork rationale:

> **Strategy:** copy the audited program **verbatim**; change the absolute minimum. Small diff = small re-audit = small new attack surface.

The curve half has none. A full search — every `.md` under `solana/` and `docs/`, all root `*.md`, the 40-commit history of `programs/tegridy-launch`, and the program's own module docs — found **no recorded reasoning for writing the curve from scratch, and no candidate that was examined and rejected.**

The timeline shows why. On **2026-07-28**: the owner directive, the scope doc that costed it, a retraction of that scope doc, and the first line of from-scratch curve code all landed. Design, costing, correction, and implementation in a single day. There was no window in which an evaluation could have happened.

So "from scratch" was never a rejected-fork verdict. **It was an unexamined default.** This document closes that gap.

## The claim that had hardened into doctrine

> "No upstream to compare against."

That sentence appears in at least six places — `SECURITY.md:29`, `AUDIT_RFQ.md:9-10`, `AUDIT_RFQ.md:43`, `docs/SOLANA_OWN_VENUE_SCOPE.md:43`, `MIGRATE_DESIGN.md:5-7`, `lib.rs:50-51` — always as settled fact, **never as the result of a search.**

It is also the sentence that justifies quoting Scope B as a full audit rather than a diff-review, and it is what `AUDIT_OUTREACH.md` tells auditors. It is now substantiated below. Before this evaluation it was not.

## Candidates, evaluated

Licence first, before a line of code is read. A candidate landing in `solana/tegridy-amm/` inherits that tree's Apache-2.0 posture, so it must be Apache-2.0-compatible **and** permit commercial use by a blockchain protocol.

| Candidate | Source | Licence | Verdict |
|---|---|---|---|
| **Meteora DBC** | ✅ published, audited ×16 | ❌ **Meteora Non-commercial Licence** | **BLOCKED — legally, not technically** |
| **Raydium LaunchLab** | ❌ IDL only, no `.rs` | — | **Nothing to fork** |
| pump.fun | ❌ docs + IDL only | none stated | Not viable |
| Doppler / Whetstone SVM | ❌ no Solana program repo | "Other" | Not viable |
| Metaplex Genesis | ❌ no public program repo | — | Not viable; fees are fixed protocol params |
| Moonshot | ❌ SDK only, deprecated | — | Not viable |
| Orca | ❌ ships no launchpad | — | Not viable |

### Meteora DBC — the near-miss, in detail

Everything that makes DBC attractive is true. The source is public, it carries **16 audit reports from three firms** (Offside Labs, Zenith, OtterSec), and the 20% cut we are trying to escape is a single compile-time constant:

```rust
// programs/dynamic-bonding-curve/src/constants.rs
pub const PROTOCOL_FEE_PERCENT: u8 = 20; // 20%
```

None of it matters. The [licence](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/license.md) grants only "noncommercial purposes", and its noncommercial-organisation carve-out explicitly excludes **"any organization which is affiliated with a blockchain project or protocol."** That exclusion is drafted to catch exactly this use. Violations terminate all licences immediately, with no cure period.

> ⚠️ **THE TRAP — read this before anyone "checks the licence" again.**
> The npm package we already vendor, `@meteora-ag/dynamic-bonding-curve-sdk`, declares **`"license": "MIT"`**. That MIT licence covers the **TypeScript client SDK only**. The on-chain Rust program is a separate repo under the non-commercial licence, which GitHub classifies as `NOASSERTION`.
>
> A web search for "Meteora DBC licence" returns *"licensed under the MIT License, which allows both commercial and non-commercial use."* **That is wrong.** It is the exact error that would get a fork approved in a meeting. Verify licences by reading the licence file **in the program repo** — never from npm metadata, a search result, or an LLM.

Two further points, so this is never reopened on a hunch:

- **Rebranding, a non-profit wrapper, or a downstream-operator structure do not help.** The bar is on commercial *use* of the code regardless of naming, and a separate "No Other Rights" clause forbids sublicensing.
- **Forking DBC would not even have removed the risk.** Its migration handlers target only Meteora's own AMMs (`meteora_damm`, `dynamic_amm_v2`). There is no cp-swap path. Our highest-risk instruction — the 20-account `migrate_to_amm` CPI — would still have been written net-new, unaudited, inside a codebase ~5× larger (110 files vs our 4).

**Continuing to *use* Meteora as an integrator is unaffected.** Using is not copying. Only forking and self-deploying is barred.

### Raydium LaunchLab — not forkable, but integrable

The cp-swap playbook does not transfer: Raydium publishes `raydium-cp-swap` under Apache-2.0, but the launchpad program source **is not published at all** — only a 147 KB IDL. There is nothing to diff-audit.

*Integration* is a real option, and confirmed permissionless by on-chain read: the WSOL `GlobalConfig` has `requires_platform_auth = 0`, `trade_fee_rate = 2500` (0.25% to Raydium), and lets a platform set its own fee on top. Audited by Halborn (Q2 2025). $6.4B all-time volume.

But `migrate_to_cpswap` **hardcodes the destination to Raydium's own CPMM program**. Tokens launched through LaunchLab can only graduate into Raydium's pools — so the perpetual post-graduation swap-fee stream accrues to Raydium, and our audited cp-swap fork is orphaned. That is the annuity the own-venue directive exists to capture, and it cannot be bought back later.

## Conclusion

**There is no permissively-licensed, audited, high-volume Solana bonding curve available to fork — from anyone.** The cp-swap situation (Apache-2.0 + audited + billions in volume) is genuinely unusual and does not repeat at the launchpad layer, because the bonding curve *is* the product these businesses sell.

The preference for battle-tested code over novel code is correct. It cannot be satisfied by substitution here. So the real choice is **integrate and give up the venue** versus **build and audit** — a venue-ownership decision, not a cost decision.

## The doctrine reversal, recorded

`frontend/src/lib/launcher/solana/dbc.ts:5-6` states a hard rule governing the currently live rail:

> "**Zero-Rust:** we deploy NO custom program. We integrate the audited DBC program via its TS SDK."

Shipping 1,170 nSLOC of custom fund-holding Rust reverses that. The repo documents its other doctrine reversal properly (`SOLANA_OWN_VENUE_SCOPE.md:74-78`); this one was never written down. The strongest recorded argument for the old doctrine — *"Phase 1 must be near-zero custom code and cheap enough that the modal outcome doesn't hurt"* (`LAUNCHER_STRATEGY.md:24`) — is also the argument for forking, and was never rebutted.

If the decision stays "build", state plainly why near-zero-custom-code no longer applies to the highest-risk program in the stack.

## Actions

1. ✅ **Recorded** — the Meteora licence bar is now written down, so the most natural fork is answered.
2. ⬜ **Fix the RFQ before `AUDIT_OUTREACH.md` is sent.** "No upstream to diff against" is now evidenced by this document — cite it. Sending auditors a claim we could not evidence is the same error the repo caught itself in twice (`325c383f`, `7c699541`).
3. ⬜ **Mine the 16 public Meteora audit reports as a free threat checklist** against `tegridy-launch` before paying for Scope B. They cover exactly our problem domain — virtual-reserve accounting, fee splits, migration, anti-snipe — and cost nothing.
4. ⬜ **Ask Meteora for a commercial licence.** One email. If granted, it dominates every other option: proven, heavily-audited curve code we are allowed to self-deploy.
5. ⬜ **Owner decision:** integrate LaunchLab (no audit, lose the annuity) vs keep `tegridy-launch` (audit Scope B, keep the venue).

## The sunk cost is smaller than it looks

Nothing is deployed — `getAccountInfo` on the program id returns `null` on **both** mainnet-beta and devnet. No audit has been invoiced. No user funds exist. The decision is ten days old. **Reopening costs almost nothing.**
