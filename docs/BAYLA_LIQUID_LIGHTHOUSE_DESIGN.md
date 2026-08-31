# The Liquid Lighthouse — design, threat model, and the gate for building it

Status: **DESIGN ONLY. No code written, nothing deployed.** Written 2026-08-29
after the operator chose "Option B" (a wrapper vault over Streamflow) in
response to `BAYLA_BUNGALOW.md` §5b — there is no early exit on Streamflow at
any price.

---

## 1. Read this first: what a wrapper does and does not do

**It does not break the lock.** A vault cannot unstake from Streamflow early
any more than a person can — it inherits the same `LockedStake` refusal. What
it changes is *who holds the position* and *what the user holds instead*.

The user's claim becomes a **transferable receipt token**, so they can leave
without the underlying stake moving. The BAYLA they receive on exit comes from
**someone else's money** — an idle buffer, new deposits, or a buyer on a DEX —
never from breaking the lock.

Three consequences that must be understood before spending a dollar on this:

1. It is a **liquidity** mechanism, not a guarantee. It works when the buffer
   or the market has depth.
2. It fails **exactly when everyone wants out at once**, which is the case
   people most want protection from. Under a run it degrades to "wait for
   maturity" — i.e. back to today's behaviour.
3. **Its value is proportional to the lock length.** Converting a *one-year*
   lock into a liquid token is transformative. Converting a *seven-day* lock
   into "pay a fee and leave now, usually" is a modest gain for an audited
   on-chain program.

> **Therefore this build only makes sense if the venue wants locks materially
> longer than a week.** If 7-day locks are acceptable, the short ceiling
> already shipped delivers most of the safety for none of the risk. The lock
> length decision and this build are ONE decision, not two.

## 2. Why a wrapper is possible at all

`deriveStakeEntryPDA` hashes the **authority** — the staker's key — into the
stake entry address, and the live pool sets `freezeStakeMint = true`, so a
user's position is non-transferable twice over (§5b).

The insight: if a **program PDA** is the authority, the *program* owns the
position, and it can mint its own receipts — tokens it controls, which it can
make freely transferable. The non-transferability is sidestepped, not broken.

This is the Marinade/Lido pattern applied to a Streamflow pool.

## 3. Architecture

**Accounts**

| Account | Seeds | Holds |
|---|---|---|
| `Vault` | `["vault", bayla_mint]` | config, internal accounting, admin |
| `Tranche` | `["tranche", vault, index]` | one Streamflow stake entry + maturity |
| `WithdrawTicket` | `["ticket", vault, owner, nonce]` | queued exit at a fixed NAV |

`Vault` fields: `stake_pool`, `receipt_mint` (authority = vault PDA),
`buffer` token account, `internal_buffer: u64`, `staked_principal: u64`,
`pending_liabilities: u64`, `exit_fee_bps: u16`, `lock_secs: u32`, `admin`.

**Instructions**

| # | Instruction | Who | Effect |
|---|---|---|---|
| 1 | `deposit(amount)` | user | BAYLA in, shares minted at current NAV, into buffer |
| 2 | `stake_buffer()` | anyone | buffer above target → open a new Streamflow tranche |
| 3 | `harvest()` | anyone | claim Streamflow rewards into buffer, NAV steps up |
| 4 | `unstake_matured(tranche)` | anyone | matured tranche → buffer |
| 5 | `instant_redeem(shares)` | user | burn shares, pay from buffer **minus `exit_fee_bps`**; fails if buffer short |
| 6 | `queue_redeem(shares)` | user | burn shares, mint a `WithdrawTicket` at current NAV, no fee |
| 7 | `claim_ticket(ticket)` | user | FIFO payout once the buffer allows |
| 8 | `set_params(...)` | admin | bounded config only — never touches funds |

Every keeper action (2, 3, 4) is **permissionless**, so a dead bot degrades
performance, never custody.

**Share math — deliberately boring**

- `total_assets = internal_buffer + staked_principal - pending_liabilities`
- **Accrued-but-unharvested rewards are NOT counted.** Valuing them on-chain
  means reimplementing Streamflow's reward math and creates a manipulable
  input. NAV instead steps up discretely on `harvest()`. Conservative, and
  there is nothing to game.
- **Donation-proof:** NAV reads `internal_buffer` (a tracked counter), never
  the raw token-account balance. Sending BAYLA to the vault cannot move NAV.
- **First-depositor inflation attack:** mint dead shares to the vault itself
  at init and make them permanently unredeemable.
- **All rounding favours the vault**, never the redeemer.
- The exit fee is not paid anywhere — it simply is not withdrawn, so it
  accrues to everyone who stayed. No separate fee accounting exists.

## 4. Honest failure modes

| Scenario | Result |
|---|---|
| Bank run, buffer empty | Everyone queues; max wait = `lock_secs`. **Degrades to today's behaviour** — no loss |
| Keeper offline | Rewards stop accruing; principal safe; matured funds sit in buffer (helps exits); anyone can crank |
| Streamflow halts | Vault inherits it; principal locked to maturity regardless |
| Exit fee set too low | Buffer drains to arbitrageurs; instant exits stop working until refilled |
| lBAYLA DEX market thin | The "sell it" exit path is theoretical; only the buffer is real |

The good property: **the worst case is the status quo.** The bad property: the
best case requires venue capital sitting idle in a buffer, earning nothing.

## 5. Threat model — what actually kills vaults

1. **Program upgrade authority.** Whoever holds it can replace the program and
   drain everything. This dwarfs every other risk here. Post-audit: burn it,
   or put it behind a Squads multisig **with a timelock**. Non-negotiable.
2. **Share accounting.** Inflation/rounding bugs are the #1 cause of vault
   exploits. Mitigations above; this is the part an audit must focus on.
3. **Admin power.** `set_params` must be provably unable to move funds, with
   hard bounds in-program (e.g. `exit_fee_bps <= 500`).
4. **Blast radius change.** Today a bug costs one user their own position.
   With a vault, one bug costs **every staker at once**. This is a real step
   up in risk and is the honest argument against building it at all.
5. **Inherited Streamflow risk**, unchanged, plus all of the above.

## 6. Cost

| Item | Estimate |
|---|---|
| Program + tests + integration | ~2–4 weeks of focused work |
| Audit (OtterSec / Neodyme / Zellic / Sec3 class) | **~$15k–$50k**, 1–3 weeks |
| Frontend (deposit, redeem, queue, NAV, tickets) | ~1 week; larger than the current panel |
| Keeper | trivial ongoing (cron + SOL for fees) |
| **Buffer capital** | Real, idle venue money. Instant exits do not exist without it |

## 7. The gate — when this is worth building

Build it only when **all** of these are true:

1. The venue wants locks **materially longer than 7 days** (see §1).
2. TVL is large enough that the audit is a small fraction of what it protects
   — rule of thumb **TVL > 10–20× audit cost**, i.e. roughly **$500k+ staked**.
3. Users are actually asking for liquidity, rather than it being assumed.
4. There is venue capital to seed and hold the buffer.

**As of 2026-08-29 none of these hold.** Staked TVL is 1,000 BAYLA (~$0.53) at
a ~$500k token market cap. Commissioning an audit today would spend tens of
thousands of dollars to protect fifty cents.

## 8. Phasing (so nothing is stranded either way)

- **Phase 0 — done.** Short ceiling (`--max-days` defaults to 7, >30 gated),
  lock picker defaults to the shortest lock (`defaultLockDays`, test-pinned),
  and the surface states the no-exit fact before signing.
- **Phase 1 — trigger, not a task.** Revisit when staked TVL passes ~$100k or
  users ask for early exit in numbers. Re-read §7.
- **Phase 2 — build.** Program → tests → audit → burn/timelock upgrade
  authority → seed buffer → frontend.
- **Phase 3 — migrate gently.** Never force-migrate. Run the vault alongside;
  let existing direct locks mature on their own. This is safe **only because
  Phase 0 locks are short** — which is the real reason to keep them short now.
