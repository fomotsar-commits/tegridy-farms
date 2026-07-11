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

Exactly **three authority/identity constants** in `programs/cp-swap/src/lib.rs`. **Nothing
else** — all swap, curve, and fee math is byte-identical to upstream.

| Constant | Upstream (Raydium) | Tegridy | Purpose |
|---|---|---|---|
| `declare_id!` (program ID) | `CPMMoo8L…qKP1C` | `BvBkt84Z…pDodL` (devnet) | Our program address |
| `admin::ID` | `GThUX1…hFMJ` | `GgE6AfEH…Wq5a` (devnet) | create_config / update_config / update_pool_status authority |
| `create_pool_fee_reveiver::ID` | `DNXge…dNC8` | `GgE6AfEH…Wq5a` (devnet) | flat pool-creation fee recipient |

Verify the minimality of the diff at any time:
```bash
# clone pristine upstream and diff the program src against our fork
git clone --depth 1 https://github.com/raydium-io/raydium-cp-swap /tmp/up
diff -r /tmp/up/programs/cp-swap/src programs/cp-swap/src   # only lib.rs constants differ
```

The current devnet values (`BvBkt84Z…`, `GgE6AfEH…`) are **throwaway devnet keypairs**
in `keys/` (gitignored, never committed, no real value).

---

## How Tegridy earns (no code change for the fee recipient)

The per-swap **protocol fee is config-driven**, not hardcoded:
- Fee **math**: `curve/fees.rs` — `protocol_fee = floor_div(amount, protocol_fee_rate, 1_000_000)` (audited upstream, untouched).
- Fee **rate**: `amm_config.protocol_fee_rate`, set once at `create_config` (admin-only).
- Fee **recipient**: `collect_protocol_fee` requires `owner == amm_config.protocol_owner`.

So Tegridy earns simply by creating an `AmmConfig` with **`protocol_owner = Tegridy treasury`**
and a chosen `protocol_fee_rate`. Then **every swap on every pool using that config** pays a
protocol cut to the treasury — regardless of who provides the liquidity. That is the venue
economics the operator wanted. (`fund_fee` → `amm_config.fund_owner` and the disabled-by-default
`creator_fee` are separate, optional levers.)

---

## Operator checklist — before MAINNET (each step is yours; keys never touch the assistant)

1. **Regenerate a dedicated mainnet program keypair** (`solana-keygen new`) → put its pubkey in the two mainnet `declare_id!` lines.
2. Set `admin::ID` (mainnet) → your **Squads multisig**.
3. Set `create_pool_fee_reveiver::ID` (mainnet) → your **treasury**.
4. Build for mainnet (`anchor build` / `cargo build-sbf`, no `devnet` feature) + **verifiable build** so anyone can confirm on-chain bytecode == this source.
5. **Professional audit of the diff** (see below) — do not deploy fund-holding code before this.
6. Deploy; set the **program upgrade authority** to the multisig (or burn it).
7. `create_config` with `protocol_owner = treasury`, `protocol_fee_rate = <chosen>`; seed a pool with treasury capital.
8. **Submit to Jupiter's DEX integration** so retail routes to it (until then it's invisible — we drive volume via our own swap UI, which prefers our pools).

---

## Threat model

**Inherited (audited upstream, unchanged):** constant-product invariant, swap/deposit/withdraw
math, checked arithmetic, oracle, fee calc. Risk here ≈ the risk Raydium CPMM already carries in
production. We do not modify it.

**New surface introduced by the fork (the whole audit focus):**
- **`admin::ID`** — holder can `create_config`, `update_config`, `update_pool_status`. Compromise ⇒ can create hostile configs / pause pools. **Mitigation:** mainnet admin = Squads multisig, disjoint signer set.
- **Program upgrade authority** — whoever holds it can replace the program bytecode (drain-class). **Mitigation:** multisig or burned upgrade authority; verifiable build so the deployed bytes are provably this source.
- **Config misconfiguration** — wrong `protocol_owner`/rates at `create_config`. **Mitigation:** the create_config step is scripted + reviewed in Phase 2; `protocol_fee_rate ≤ trade_fee_rate` is enforced upstream.
- **`create_pool_fee_reveiver`** — only receives the flat creation fee; low impact.

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
  lib.rs            ← the ONLY edited file (3 authority constants + fork header)
  curve/fees.rs     ← fee math (untouched, audited upstream)
  states/config.rs  ← AmmConfig: protocol_owner / fee rates (untouched)
  instructions/     ← swap / deposit / withdraw / admin (untouched)
keys/               ← devnet throwaway keypairs (gitignored)
```
