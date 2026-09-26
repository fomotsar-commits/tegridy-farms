# Tegridy CP-AMM — Solana AMM (Phase 0)

Tegridy Farms' own Solana AMM, so the protocol earns a **protocol fee on every swap
across every pool it hosts** (the "own the venue" model), with an external-routing
fallback for pairs we don't host well.

- **Fork base:** [`raydium-io/raydium-cp-swap`](https://github.com/raydium-io/raydium-cp-swap) — Raydium's CPMM (constant-product), **Apache-2.0**, audited, running billions in TVL.
- **Strategy:** copy the audited program **verbatim**; change the absolute minimum. Small diff = small re-audit = small new attack surface. (Consistent with the protocol's minimal-attack-surface mandate.)
- **Decision:** operator chose to build our own venue (Model B) on 2026-07-10, over being just an LP (Model A), knowing the cost (Rust + audit + ~$11.7M/mo break-even + Jupiter-invisible-until-integrated).

> **Status as of 2026-08-19: NOT AUDITED. Nothing from this tree is executable on any
> cluster. Holds no real funds.**
>
> This line used to say the fork had never been on mainnet, and that stopped being true
> on 2026-08-08, when it was deployed at `3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y`
> ahead of the audit this document gates on. It was **closed on 2026-08-13**: the
> ProgramData account is deleted, so the program cannot execute and that id can never be
> redeployed. Its `AmmConfig` never existed, so no pool was ever created and no user funds
> were ever at risk — see `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md` for the verified
> account reads and the ~8.2M lamports left stranded.
>
> A restart is therefore a fresh deploy at a fresh id, with every PDA this fork owns
> re-derived, not a redeploy. Fund-holding deploy is still gated behind a professional
> audit (see §Audit) — a gate this project has already walked past once.
>
> **2026-09-26: the restart identities are in source, REGISTERED, NOT deployed.** The
> non-devnet `declare_id!` is `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` (a fresh
> keypair; absent on mainnet when read 2026-09-26), and both non-devnet authority
> constants are the Squads **vault PDA** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`
> (owner rulings 2026-09-25). `diff-guard` was re-pinned for exactly these three lines.

---

## The entire code diff from upstream

Exactly **four authority/identity constants** across **two files** — `lib.rs` and
`instructions/admin/create_support_mint_associated.rs`. **Nothing else** — all swap, curve,
and fee math is byte-identical to upstream. After the fork, **no external party retains any
authority on this program**; every authority is the Tegridy admin/treasury.

| Constant (file) | Upstream (Raydium, mainnet arm) | Tegridy — mainnet arm (committed) | Tegridy — devnet arm | Purpose |
|---|---|---|---|---|
| `declare_id!` — `lib.rs` | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` | `BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL` | our program address |
| `admin::ID` — `lib.rs` | `GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ` | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (Squads vault PDA) | `GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a` | create_config / update_config / update_pool_status + fallback fee collector |
| `create_pool_fee_reveiver::ID` — `lib.rs` | `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` (WSOL acct) | `2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa` (the vault's WSOL ATA) | `27AC7YwwAULHQcQXGErV7rHMsLZAUBWF6ozDNhSpTQE9` | flat pool-creation fee recipient — **must be a WSOL token account**, not a wallet |
| `create_support_mint_associated_owner::ID` — `create_support_mint_associated.rs` | `Rayv2LG4tFSMizZhMP8aSUYxDPjV8qJtx2NQY9RKYZy` | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (Squads vault PDA) | `GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a` | alt authority for the Token-2022 support-mint allowlist (was Raydium's key; now ours) |

The devnet values are throwaway keypairs in `keys/` (gitignored).

**Mainnet history of this table, so nobody repeats it.** The binary deployed 2026-08-08 at
the now-spent `3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y` had the Squads **multisig
account** `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` as `admin::ID` — an account that can
never sign, so `create_amm_config` was uncallable and nothing could graduate. Source then
moved `admin::ID` to the single operator-held key `Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7`
while leaving the support-mint owner on the multisig (a dead fallback). The restart
(2026-09-25 rulings) puts BOTH on the vault PDA: system-owned, 0 bytes, signs through a
Squads vault transaction, pays rent from its own lamports — so it must be funded before
`create_amm_config`. Neither `3ZvZXEBr…`, `Dcjink4…` nor `EVGSnRZ…` may appear in a mainnet
binary; `scripts/verify-program-constants.mjs` carries them as FORBIDDEN.

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
admin caller`** (the `admin::ID` key) — there is no treasury parameter; to hand collection authority to
a *distinct* treasury, call `update_config` (param 3 / 4) afterward. Either way, **every swap on
every pool using that config** accrues a protocol cut (per `protocol_fee_rate`) the treasury
receives at collection time — regardless of who provides the liquidity. That is the venue
economics the operator wanted. `protocol_fee_rate` is a fraction of the trade fee out of
1_000_000 (e.g. 120000 = 12% of the trade fee), bounded by `protocol_fee_rate + fund_fee_rate ≤
1_000_000`. (`fund_fee` → `fund_owner`, disabled-by-default `creator_fee` = separate levers.)

---

## Operator checklist — before MAINNET (each step is yours; keys never touch the assistant)

1. ✅ (2026-09-25) **Dedicated mainnet program keypair** generated → `EKS4C6x…` is in the non-devnet `declare_id!`. The keypair is held outside the repo; it is never committed.
2. ✅ (2026-09-25) `admin::ID` (mainnet) → the Squads **vault PDA** `GRMtSx…`: system-owned, signs through Squads, pays from its own lamports — **fund it before `create_amm_config`**. **NOT the Squads multisig account.** This step used to say "your Squads multisig", and following it is what bricked graduation on the 2026-08-08 deploy: `CreateAmmConfig` has `payer = owner`, the multisig account is a program-owned Squads account that the System Program cannot debit and that does not itself sign (a Squads v4 transaction signs as its *vault* PDA, which is a different address again), so `create_amm_config` became uncallable with no upgrade path — and closing the program was the only way out. Whatever you choose here must be provably able to sign *and* hold SOL **before** the build, because this constant is baked into the binary. See `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md` and the `squads-vault` correction in `frontend/scripts/addresses.json`.
3. ✅ `create_pool_fee_reveiver::ID` (mainnet) → your treasury's **WSOL token account** (`2sa31zce…`, the vault's WSOL ATA), not the treasury wallet — the create path reads it as a token account.
4. Build for mainnet (`anchor build` / `cargo build-sbf`, no `devnet` feature) + **verifiable build** so anyone can confirm on-chain bytecode == this source.
5. **Professional audit of the diff** (see below) — do not deploy fund-holding code before this.
6. Deploy; set the **program upgrade authority** to the Squads **vault PDA** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (or burn it) — **never the multisig account `EVGSnRZ…`**. Squads v4 signs as the vault; nothing can sign as the multisig account, so an upgrade authority set there can never upgrade again, a burn nobody chose. Same rule, same reason, for tegridy-launch's upgrade authority and its `GlobalConfig.authority` (MAINNET_RUNBOOK §0, "Which Squads address").
7. `create_config` with `protocol_fee_rate = <chosen>` (protocol_owner defaults to the admin caller — `update_config` param 3/4 to repoint to a distinct treasury); the `create_pool_fee` receiver must be the treasury's **WSOL ATA**; seed a pool with treasury capital.
7b. Create cp-swap's `Permission` account for tegridy-launch's migration authority `["migauth"]` (`create_permission_pda`, admin-only). Without it every graduation fails `MigrationPermissionMissing` (6021). MAINNET_RUNBOOK §5c.
8. **Submit to Jupiter's DEX integration** so retail routes to it (until then it's invisible — we drive volume via our own swap UI, which prefers our pools).

---

## Threat model

**Inherited (audited upstream, unchanged):** constant-product invariant, swap/deposit/withdraw
math, checked arithmetic, oracle, fee calc. Risk here ≈ the risk Raydium CPMM already carries in
production. We do not modify it.

**New surface introduced by the fork (the whole audit focus):**
- **`admin::ID`** — `create_config` / `update_config` / `update_pool_status` AND a fallback collector on `collect_protocol_fee` / `collect_fund_fee` (can sweep accrued protocol+fund fees to any recipient) — a **fund-touching** key, not config-only. Compromise ⇒ hostile configs, paused pools, swept fees. It also reaches **graduated launches**: it can freeze any pool's swaps (`update_pool_status`), burned-LP pools included; close the migration `Permission` account (`close_permission_pda`), which blocks every graduation; turn pool creation off (`update_config` param 6, `disable_create_pool`), which also blocks every graduation until it is set back; raise `create_pool_fee` (`update_config` param 5, unbounded) above `migration_reserve − 42,156,720`, which bricks every pending curve's graduation at once; and change the trade and creator fee rates (`update_config` params 0 and 7) of every pool on the config, graduated burned-LP pools included, since swaps read them live. **Mitigation:** an explicit owner decision on who holds it (MAINNET_RUNBOOK §5, "OWNER DECISION") — ruled 2026-09-25: the Squads vault PDA `GRMtSx…` (2-of-2), so every admin action is a two-signer proposal. It must be an account that can sign AND pay, so never the multisig account. Moving it is a program upgrade.
- **Program upgrade authority** — whoever holds it can replace the program bytecode (drain-class). **Mitigation:** the Squads vault PDA (not the multisig account) or a burned upgrade authority; verifiable build so the deployed bytes are provably this source.
- **Config misconfiguration** — wrong rates at `create_config`. The enforced bound is `protocol_fee_rate + fund_fee_rate ≤ 1_000_000` (NOT ≤ trade_fee_rate); the `create_pool_fee` receiver MUST be a WSOL token account or every pool creation reverts. **Mitigation:** the create_config step is scripted + reviewed in Phase 2.
- **`create_pool_fee_reveiver`** — only receives the flat creation fee; low impact.
- **`create_support_mint_associated_owner`** — alt authority for the niche Token-2022
  support-mint allowlist. Now the same Squads vault PDA as `admin::ID` (upstream it was a
  Raydium key — that residual external authority is removed; before 2026-09-25 it was the
  unsignable multisig account, which made the fallback dead). Add-only allowlist, no fund
  path; low impact.

**Non-code (operational) risks:** capital as LP bears impermanent loss; revenue depends on real
volume; Jupiter de-routes under-funded pools (30-min liquidity recheck) — keep pools funded.

---

## Audit

Scope is tiny and mechanical: **"confirm the only delta from audited upstream `raydium-cp-swap`
is the four identity/authority constants (program id, `admin`, fee receiver, support-mint
owner) + program name, and that the mainnet authorities are the Squads vault PDA and its WSOL
ATA."** Recommended Solana firms: OtterSec, Neodyme, Sec3, Zellic. This diff-audit
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
