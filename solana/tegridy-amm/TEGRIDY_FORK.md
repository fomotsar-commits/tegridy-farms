# Tegridy CP-AMM — Solana AMM (Phase 0)

Tegridy Farms' own Solana AMM, so the protocol earns a **protocol fee on every swap
across every pool it hosts** (the "own the venue" model), with an external-routing
fallback for pairs we don't host well.

- **Fork base:** [`raydium-io/raydium-cp-swap`](https://github.com/raydium-io/raydium-cp-swap) — Raydium's CPMM (constant-product), **Apache-2.0**, audited, running billions in TVL.
- **Strategy:** copy the audited program **verbatim**; change the absolute minimum. Small diff = small re-audit = small new attack surface. (Consistent with the protocol's minimal-attack-surface mandate.)
- **Decision:** operator chose to build our own venue (Model B) on 2026-07-10, over being just an LP (Model A), knowing the cost (Rust + audit + ~$11.7M/mo break-even + Jupiter-invisible-until-integrated).

> **Status: Phase 0 (devnet groundwork). NOT AUDITED. NOT ON MAINNET. Holds no real funds.**
> Fund-holding mainnet deploy is gated behind a professional audit (see §Audit).

---

## The entire code diff from upstream

Exactly **four authority/identity constants** across **two files** — `lib.rs` and
`instructions/admin/create_support_mint_associated.rs`. **Nothing else** — all swap, curve,
and fee math is byte-identical to upstream. After the fork, **no external party retains any
authority on this program**; every authority is the Tegridy admin/treasury.

| Constant (file) | Upstream (Raydium) | Tegridy | Purpose |
|---|---|---|---|
| `declare_id!` — `lib.rs` | `CPMMoo8L…qKP1C` | `BvBkt84Z…pDodL` (devnet) | our program address |
| `admin::ID` — `lib.rs` | `GThUX1…hFMJ` | `GgE6AfEH…Wq5a` (devnet) | create_config / update_config / update_pool_status |
| `create_pool_fee_reveiver::ID` — `lib.rs` | `DNXge…dNC8` (WSOL acct) | `27AC7Yww…TQE9` (devnet WSOL ATA) | flat pool-creation fee recipient — **must be a WSOL token account**, not a wallet |
| `create_support_mint_associated_owner::ID` — `create_support_mint_associated.rs` | `Rayv2…RKYZy` | `GgE6AfEH…Wq5a` (devnet) | alt authority for the Token-2022 support-mint allowlist (was Raydium's key; now ours) |

The devnet values (`BvBkt84Z…`, `GgE6AfEH…`) are throwaway keypairs in `keys/` (gitignored).
The mainnet values are set to the Squads multisig / treasury by the operator before mainnet.

Verify the minimality of the diff at any time (also enforced automatically by `solana-ci.yml`):
```bash
git clone https://github.com/raydium-io/raydium-cp-swap /tmp/up && git -C /tmp/up checkout 78f254e
diff -rq /tmp/up/programs/cp-swap/src programs/cp-swap/src   # only the 2 authority files differ
```

The current devnet values (`BvBkt84Z…`, `GgE6AfEH…`) are **throwaway devnet keypairs**
in `keys/` (gitignored, never committed, no real value).

---

## How Tegridy earns (no code change for the fee recipient)

The per-swap **protocol fee is config-driven**, not hardcoded:
- Fee **math**: `curve/fees.rs` — `protocol_fee = floor_div(amount, protocol_fee_rate, 1_000_000)` (audited upstream, untouched).
- Fee **rate**: `amm_config.protocol_fee_rate`, set once at `create_config` (admin-only).
- Fee **recipient**: `collect_protocol_fee` requires `owner == amm_config.protocol_owner`.

So Tegridy earns by creating an `AmmConfig` with a chosen **`protocol_fee_rate`** (via
`create_config`, admin-only). Note: `create_config` sets **`protocol_owner = fund_owner = the
admin caller`** (the multisig) — there is no treasury parameter; to hand collection authority to
a *distinct* treasury, call `update_config` (param 3 / 4) afterward. Either way, **every swap on
every pool using that config** accrues a protocol cut (per `protocol_fee_rate`) the treasury
receives at collection time — regardless of who provides the liquidity. That is the venue
economics the operator wanted. `protocol_fee_rate` is a fraction of the trade fee out of
1_000_000 (e.g. 120000 = 12% of the trade fee), bounded by `protocol_fee_rate + fund_fee_rate ≤
1_000_000`. (`fund_fee` → `fund_owner`, disabled-by-default `creator_fee` = separate levers.)

---

## Operator checklist — before MAINNET (each step is yours; keys never touch the assistant)

1. **Regenerate a dedicated mainnet program keypair** (`solana-keygen new`) → put its pubkey in the two mainnet `declare_id!` lines.
2. Set `admin::ID` (mainnet) → your **Squads multisig**.
3. Set `create_pool_fee_reveiver::ID` (mainnet) → your **treasury**.
4. Build for mainnet (`anchor build` / `cargo build-sbf`, no `devnet` feature) + **verifiable build** so anyone can confirm on-chain bytecode == this source.
5. **Professional audit of the diff** (see below) — do not deploy fund-holding code before this.
6. Deploy; set the **program upgrade authority** to the multisig (or burn it).
7. `create_config` with `protocol_fee_rate = <chosen>` (protocol_owner defaults to the admin caller — `update_config` param 3/4 to repoint to a distinct treasury); the `create_pool_fee` receiver must be the treasury's **WSOL ATA**; seed a pool with treasury capital.
8. **Submit to Jupiter's DEX integration** so retail routes to it (until then it's invisible — we drive volume via our own swap UI, which prefers our pools).

---

## Threat model

**Inherited (audited upstream, unchanged):** constant-product invariant, swap/deposit/withdraw
math, checked arithmetic, oracle, fee calc. Risk here ≈ the risk Raydium CPMM already carries in
production. We do not modify it.

**New surface introduced by the fork (the whole audit focus):**
- **`admin::ID`** — `create_config` / `update_config` / `update_pool_status` AND a fallback collector on `collect_protocol_fee` / `collect_fund_fee` (can sweep accrued protocol+fund fees to any recipient) — a **fund-touching** key, not config-only. Compromise ⇒ hostile configs, paused pools, swept fees. **Mitigation:** mainnet admin = Squads multisig, disjoint signer set; the non-devnet default is a fail-closed sentinel until set.
- **Program upgrade authority** — whoever holds it can replace the program bytecode (drain-class). **Mitigation:** multisig or burned upgrade authority; verifiable build so the deployed bytes are provably this source.
- **Config misconfiguration** — wrong rates at `create_config`. The enforced bound is `protocol_fee_rate + fund_fee_rate ≤ 1_000_000` (NOT ≤ trade_fee_rate); the `create_pool_fee` receiver MUST be a WSOL token account or every pool creation reverts. **Mitigation:** the create_config step is scripted + reviewed in Phase 2.
- **`create_pool_fee_reveiver`** — only receives the flat creation fee; low impact.
- **`create_support_mint_associated_owner`** — alt authority for the niche Token-2022
  support-mint allowlist. Now the Tegridy admin (upstream it was a Raydium key — that
  residual external authority is now removed). Add-only allowlist, no fund path; low impact.

**Non-code (operational) risks:** capital as LP bears impermanent loss; revenue depends on real
volume; Jupiter de-routes under-funded pools (30-min liquidity recheck) — keep pools funded.

---

## Audit

Scope is tiny and mechanical: **"confirm the only delta from audited upstream `raydium-cp-swap`
is the three authority constants + program name, and that the mainnet authorities are the
multisig/treasury."** Recommended Solana firms: OtterSec, Neodyme, Sec3, Zellic. This diff-audit
should be fast and inexpensive relative to a from-scratch AMM audit — which is the entire point
of the verbatim-fork approach.

---

## Layout
```
programs/cp-swap/src/
  lib.rs            ← 3 of the 4 authority constants (+ fork header)
  instructions/admin/create_support_mint_associated.rs  ← 4th authority constant
  curve/fees.rs     ← fee math (untouched, audited upstream)
  states/config.rs  ← AmmConfig: protocol_owner / fee rates (untouched)
  instructions/     ← swap / deposit / withdraw / admin (otherwise untouched)
keys/               ← devnet throwaway keypairs (gitignored)
```
