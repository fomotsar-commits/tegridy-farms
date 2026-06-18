# Solana Fee-Capture Plan

**Status:** Decided 2026-06-18 (research + red-team, 18 agents across 2 workflow runs). Implementation: Surface A foundation in progress.
**Owner decision driver:** "Be the multichain hub" → narrowed to **fee capture off specific Solana tokens the owner holds (e.g. Jungle Bay) + a swap surface for other SPL tokens.**

---

## Hard constraints (non-negotiable)

- **TOWELI never touches Solana.** No bridge, no wrapped/canonical TOWELI, no TOWELI emissions/gauges/rewards on Solana. TOWELI stays an immutable Ethereum ERC-20. (See `project_2026_06_18_solana_fee_capture` memory + `project_deep_pool_intention`.)
- **Minimal attack surface.** We integrate already-deployed, already-audited programs (Jupiter, Meteora, Raydium). We deploy **no custom on-chain program** of our own.
- **No outflow before its funding feature.** The free swap-fee rail ships first; the only real spend (LP capital) is committed per-token, explicitly, by the owner, and held in a multisig.

---

## Headline: we do NOT need our own Solana AMM

Both goals run entirely on existing rails that Jupiter already routes (~95% of Solana swap flow):

| Goal | How | Own program? | Audit? | Capital? |
|---|---|---|---|---|
| **A. Buy other SPL tokens on Tegridy, skim a fee** | Jupiter Swap API platform fee | No | No | None |
| **B. Host Jungle Bay et al.'s pools, earn trading fees** | Be LP / creator-fee recipient on Meteora & Raydium | No | No | Yes (owner-fronted LP) |

An own forked AMM (`raydium-cp-swap`, Apache-2.0) only adds the operator **protocol-fee** slice (~0.03% of volume) and **never breaks even below ~$11.7M/mo of own-pool volume** — plus it's invisible to retail until Jupiter manually integrates it. **Deferred indefinitely** (see §Graduation).

---

## Surface A — Swap-fee capture ("buy any Solana token on Tegridy, we skim a fee")

**Mechanism — Jupiter Swap API (Metis), NOT Ultra:**
1. `GET /quote` with `platformFeeBps` (integer bps; e.g. `100` = 1.0%). Default **ExactIn** for route coverage.
2. `POST /swap` with `feeAccount` = a plain Tegridy-owned associated token account (ATA).
3. Fee is deducted in-transaction → accrues to our ATA → swept like any balance. No own program, no claim contract.

**Since Jan 2025: no Referral Program, no whitelist, 100% fee retention.** (Ultra would force the Referral Program, cap bps, and skim 20% — do not use Ultra for fee capture.)

**Hard rules (violating these = silent $0 capture):**
- Fee mint must be a side of the pair: ExactIn → fee in input **or** output mint; ExactOut → input mint only. **Derive `feeAccount` per-quote from the actual pair; never hardcode.**
- Token-2022 mints: use a Token-2022 fee account + the correct instruction version. Avoid transfer-hook / non-transferable / exotic-extension mints → **curated allowlist only.**
- Log any quote where the response fee bps is 0.

**Fee level:** start **50–100 bps (0.5–1.0%)**, disclosed in UI. Above ~1% the quote degrades vs. free direct Jupiter and users bounce. Compete on curation/UX, not price (mirrors the EVM front-door discipline).

**Cost:** ~$0. No audit, no program, no liquidity. Build = a Solana swap UI + the Jupiter proxy folded into the existing aggregator catchall (0 net-new Vercel functions). One-time: a Solana fee wallet (multisig-owned) + pre-created ATAs (wSOL, USDC, listed mints).

---

## Surface B — Hosted-pool fee capture ("host Jungle Bay's pool, earn its trading fees")

Pool creation is **permissionless** on Meteora DAMM v2 and Raydium CPMM (no whitelist, no audit). **There is no free lunch** — to earn fees you must either be the LP, or use Meteora's creator-fee lever:

- **Meteora DAMM v2 (primary, ~0.022 SOL):** create + seed the pool, set a high **`creator_trading_fee_percentage`** (a slice of *every* trade regardless of who LPs — the one lever that earns off others' liquidity), optionally `permanent_lock_position` (locks principal forever, keeps `claim_position_fee` rights). Recipient = owner of the locked position → a Tegridy **Squads multisig**. ⚠️ Verify on devnet whether `creator_trading_fee_percentage` needs a permissioned config key from Meteora (agents disagreed).
- **Raydium CPMM (secondary, dual-list for routing):** create + seed, **Burn & Earn** to lock → receive a transferable **Fee Key NFT** = the right to harvest the locked position's fees forever. Custody the NFT in the multisig. Note: standard Raydium CPMM **creator fees are disabled at the program level** (LaunchLab-only), so the no-capital creator-fee lever does **not** exist here — Raydium = LP-fee capture only.
- **Avoid M3M3 / Stake2Earn** — it routes fees to top token stakers, not the treasury.

**Who earns what:** LP fee → whoever provides liquidity (scaled by share; ~84% of the trade fee on Raydium CPMM). Meteora creator fee → a configured slice of every trade. To "earn too," Tegridy must be the LP and/or the Meteora creator-fee recipient.

**Why these get Jupiter routing day one:** Jupiter already routes Meteora + Raydium; markets re-evaluate on a ~30-min cycle (routable once depth passes the $500 round-trip <30% / $1k impact <20% test). Opposite of a brand-new own AMM.

**Cost:** on-chain setup <1 SOL across a handful of tokens. Dominant cost = **owner-fronted LP capital per token** (perma-lock = permanently committed) + impermanent-loss exposure.

---

## Honest economics (at Jungle-Bay scale this is opex-coverage, not profit)

Reference: TOWELI does ~$266/day (~$8k/mo) on a single small token.

**Surface A — swap fee, 100% retention:**

| Fee | $1k/day | $10k/day | $100k/day | $1M/day |
|---|---|---|---|---|
| 50 bps | ~$150/mo | ~$1.5k/mo | ~$15k/mo | ~$150k/mo |
| 100 bps | ~$300/mo | ~$3k/mo | ~$30k/mo | ~$300k/mo |

**Surface B — sole-LP fee:**

| Effective take | $10k/mo routed | $100k/mo | $1M/mo | $10M/mo |
|---|---|---|---|---|
| ~0.25% (Raydium 0.25% tier) | ~$21/mo | ~$210/mo | ~$2.1k/mo | ~$21k/mo |
| ~0.85% (1% tier, full LP share) | ~$85/mo | ~$850/mo | ~$8.4k/mo | ~$84k/mo |

**Blunt truth:** at ~$8k/mo per token this nets tens of $/month. Material only at ~$50–100k+/day aggregate. The mechanisms are free/near-free to run → a no-downside incremental self-sustain rail, not budget income.

---

## Own-AMM graduation (the deferred path)

Forking `raydium-cp-swap` and re-pointing the protocol fee to a Tegridy PDA buys only ~0.03% of volume. All-in cost ≈ $3.5k/mo (≈$30k audit amortized + ~$1k/mo Squads/ops). Break-even ≈ **$11.7M/mo of own-pool volume**, before the volume lost to not being Jupiter-routed.

**Trigger to reopen (both required):** contract-free capture proves sustained 7–8 figure monthly volume for 3+ months **and** Jupiter integration is realistically attainable. Default state: **closed.**

---

## Phased plan (GO/NO-GO gates)

- **Phase 0 — Custody.** Solana Squads multisig + fee wallet + pre-created ATAs. *Gate: multisig live & tested before any mainnet funds move.*
- **Phase 1 — Surface A (free, ship first).** Jupiter swap-fee integration (ExactIn, 50–100 bps, curated allowlist, folded into catchall proxy), feature-flagged. *Gate: fees landing in the ATA on real flow.*
- **Phase 2 — Surface B, Jungle Bay only.** Seed + lock one Meteora pool via no-code UI, conservative size, multisig-owned. *Gate: only owner-approved LP capital per token; lock is permanent — treat as a treasury allocation. NO-GO on transfer-hook Token-2022 tokens.*
- **Phase 3 — Dual-list + scale.** Add Raydium CPMM (Burn & Earn) + replicate for the next 1–2 owned tokens. *Gate: top up depth only where measured volume justifies.*
- **Phase 4 — Own-AMM (deferred).** Reopen only on the §Graduation trigger. Default closed.

---

## Risk register (top)

| Risk | Sev | Mitigation |
|---|---|---|
| Fee-claim key / Raydium Fee Key NFT loss (losing/burning the NFT forfeits all future fees) | High | Custody position-owner wallet + Fee Key NFT in Squads multisig; document the NFT mint; never transfer/burn. |
| Permanent-lock = irreversible capital | High | Size locked liquidity conservatively per token; use an unlocked position if reversibility matters (still earns LP fee). |
| Silent $0 capture (wrong fee mint / Token-2022 handling) | Med | Default ExactIn; derive `feeAccount` per-quote; pre-create ATAs; log any 0-fee quote. |
| Thin-pool routability (Jupiter bypasses shallow pools) | Med | Provide enough depth to win the route; dual-list; monitor route share. |
| Scam-token exposure on the buy surface | Med | Curated allowlist only; no auto-listing arbitrary mints; avoid exotic Token-2022 extensions. |
| Vercel 12-function cap (9/12 used; catchall load-bearing) | Low | Fold Jupiter proxy into the existing catchall; don't split it. 0 net-new functions. |

---

## Critical path (cheapest first)

1. Solana Squads multisig + fee wallet + pre-created ATAs.
2. Ship Surface A (Jupiter swap fee) — $0, no capital, proves the fee rail.
3. Confirm fees landing in the ATA.
4. Confirm each owned token's mint type (SPL vs Token-2022 / transfer-hook).
5. Seed + lock Jungle Bay on Meteora (no-code UI, multisig-owned).
6. Dual-list on Raydium + replicate for next 1–2 tokens.
7. Instrument volume + route share; keep the own-AMM decision closed.

---

## What's needed from the operator

- A **Solana fee-account pubkey** (multisig-owned ATA) to receive Surface A platform fees — until set, the feature stays gated off via `isDeployed`.
- Per-token **LP capital approval** before any Surface B pool seed (perma-lock is irreversible).
- The list of owned Solana tokens to host (Jungle Bay + others) with their mint addresses.
