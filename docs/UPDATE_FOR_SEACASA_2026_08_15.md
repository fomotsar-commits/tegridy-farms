# Status for seacasa — 2026-08-15

Everything that could be done without a key, a credential, or money is done, merged to
`mvp-launch`, and live in production. This is where things stand, what I need from you,
and what I need from the island.

Two documents carry the detail and are both in the repo:
`docs/ISLAND_WAVE_THREE_STATUS.md` (the file the island reads) and
`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md` (the phase-04 ledger).

---

## 1. The thing you should read first

**Both Solana programs are closed on mainnet.** `tegridy-launch` and the cp-swap fork
both have their ProgramData deleted — `null`, 0 lamports — verified on two independent
RPCs. The program *stubs* still exist and still report `executable: true`, which is why
this looks fine from an explorer; you have to check the ProgramData account, not the
program account.

A program whose ProgramData is closed cannot execute. On Solana the address is also not
reusable, so **`CpFnacrA…` and `3ZvZXEBr…` are spent forever.** Relaunching means new
program IDs, a new `deployer::ID` baked into a new binary, new config, new custody.

This matches the close runbook that was on file to reclaim the ~8.47 SOL of rent. I am
not treating it as an accident — but I could not find the money. It is not in the Squads
vault (0.001 SOL), the multisig (0.00434), the deploy authority (0), or member A
(0.0221). The `global` PDA still holds 5,922,960 lamports, owned by a program that
cannot run.

**Why this matters for Wave 3:** phase 02 is written on the premise that "your upgrade
authority sits at the multisig, so the live program can still learn." There is nothing to
upgrade. That phase cannot be executed as written, and it is now a question for the
island rather than a signature from you.

---

## 2. Wave 3 — where each phase actually is

| phase | state | who is holding it |
|---|---|---|
| 01 prove the wire | **BLOCKED** | **you** — one env var |
| 02 creator-fee door, decimals, fee constitution | **BLOCKED, premise gone** | **the island** — a decision |
| 03 fee custody on the public path | **DONE** | — |
| 04 audit swarm on the program | **DONE** | — |
| 05 custody comes home | **BLOCKED** | **you** — on-chain signing |
| 06 small true things | **DONE** | — |

### What is done, and what it actually changed

**03 — fee custody, verified where the public walks.** The venue's strongest Solana
guarantee is that the config's `feeClaimer` is the Squads vault. That check existed in
operator tooling and had never once run on the public submit path — the one place a
stranger's money is at stake. It now runs: one read, before submit, refusing on a
mismatch, an unreadable account, a throwing RPC, *and* on there being no configured
expectation. Placed above the SDK, so a refusal is provably "nothing was submitted".

**04 — the audit, pointed at the program for the first time.** 43 findings, 0 critical,
9 high, then every high and medium handed to an independent verifier told to default to
REFUTED: 16 confirmed, 3 refuted. The two sharpest are both about segmented mode, which
`segment_count = 0` was the only thing preventing — one signature away:

- it **bypasses the graduation-price continuity band entirely**, so a published table
  could list a launch at 35%–122% of its curve price against a ±5% band the program
  enforces everywhere else;
- a **well-formed table can permanently brick every launch** created under it — three
  were replayed against the live parameters and one bricks on the very first buy, with
  the creator's rent already spent and the mint authority already burned.

Plus three client bugs that would have built valid-but-wrong transactions. None is
exploitable now because nothing can be called — they are findings about the **source**,
and they are exactly what a redeploy would carry forward.

**06 — the three small true things.**
- The garden lane is mounted. `certification.ts` was correct and had no importer, so the
  island's promise was invisible. It renders as a promise and is deliberately **not
  selectable**, because offering it as a choice would be the venue self-declaring
  certification. The read is now a per-token path, not a query parameter.
- The 180-day averaging window is gone, along with the decay story built on it. It was
  labelled "CONFIRMED BY THE ISLAND 2026-08-07" and it was not, and both the number and
  the mechanic were being shown to users. The card now carries the three confirmed
  properties and says plainly that the period has not been published.
- The attestation seam is laid dark. The verdict is a **state, not a boolean**, with no
  `.valid` to read — so nobody can wire it in, treat "never ran" as "not attested", and
  start enforcing a verdict the island never gave.

**Floor confirmed at 80, the Resident word — we were already at 80. No change needed.**

---

## 3. What I need from you

Ordered by value per minute of your time.

### 3.1 Set `MEMETICS_BIRTH_SECRET` in Vercel production — unblocks phase 01

This is one environment variable and it is the whole of phase 01. Everything else is
built and verified: the relay reads it server-side only (never a `VITE_` variable, never
committed), the ops panel for stuck births exists and is mounted on `/admin`, and the
client already treats `already_enrolled` as a success carrying the island's original
enrollment id. Live production currently answers `503 no_secret`.

**Do not send me the value.** Set it in the Vercel dashboard yourself. I will then run
the test birth, the replay, and confirm zero stuck pending, and record the enrollment id
in the status file.

### 3.2 Decide whether the Solana leg is being relaunched or retired

I need this before I write another line of Solana code. Right now the repo contains a
launcher, a curve, a client and an operator harness for programs that no longer exist.
That is not neutral — it is the exact "half-built thing that reads as live" pattern we
spent this week removing everywhere else.

If it is being retired, say so and I will mark the surfaces honestly and stop.
If it is being relaunched, the phase-04 highs get fixed **before** the new deploy, not
after.

### 3.3 Run the EVM custody re-home — phase 05

`docs/SAFE_REHOME_RUNBOOK.md`. Ownership behind the multisig at a named threshold,
published address, integrator fee recipient re-pointed in the same motion. This is
entirely unaffected by the Solana situation. Once the on-chain move lands I will banner
the superseded checklist and update the front-door risk paragraph in the same pass.

### 3.4 The things that are cheap now and expensive later

- **There is still no succession document.** One person holds the deployer keystore for
  19 live contracts, the Vercel environment (the only record of 9 server-only variables),
  GoDaddy, Supabase and GitHub. `git grep` for succession or bus-factor returns nothing.
- **Backups cover one item.** Only the Solana keypairs were ever in scope, and those are
  now the keys to closed programs. The deployer keystore, Safe recovery material and the
  Vercel variable set are not backed up anywhere.
- **No legal entity and no tax treatment**, against a protocol every month of the plan is
  built to earn from.

---

## 4. What I need from the island

These are in the status file's notes as well, which is where the island reads them.

1. **Phase 02 assumes a live program and there is not one.** Does the island want this
   rail redeployed under new program IDs — new deploy, new config, new custody, phase-04
   highs fixed first — or is the Solana leg retired? Everything else in Wave 3 is
   unaffected either way.

2. **The exact TWAB window semantics.** We removed the 180-day figure because it was
   never island-confirmed. The consequence is that a preview cannot reproduce the curve,
   and the surface now says so. Is a reproduction preview expected before the window is
   published, or should the surface stay descriptive?

3. **Which half of the fee constitution is immutable.** Our shape is: rate snapshotted
   per curve, destination read live. We intend to publish plainly that **the rate is
   fixed forever and the destination is operational**, rather than timelock the
   destination — the EVM rail's timelock discipline exists because that rail holds user
   funds in the contract, which was never true here. Confirm, or say the destination must
   be timelocked.

4. **The certification read path shape.** We pinned it to a per-token path. Our record
   route is `/record/:chain/:ca.json`. Should certification hang off that same shape
   (`/record/:chain/:ca/certification.json`), or sit at its own root?

---

## 5. Information that would make this go faster

Not blockers — things that cost me real time this week, that you can settle in a line.

- **Where did the ~8.47 SOL of reclaimed rent go, and was the close deliberate?** I can
  see the effect on chain but not the intent, and the answer changes whether I treat the
  Solana tree as retired or as between deployments.
- **Can Squads member B (`6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY`) sign?** It has
  never appeared in any proposal's `approved[]`, holds 0 SOL, and has no keyfile on this
  machine. If it cannot, the multisig is effectively 1-of-1-that-cannot-act and every
  plan resting on it is fiction. If the close ran, something signed — I would like to
  know what.
- **Is `VITE_SOLANA_FEE_ACCOUNT` deliberately unset?** It gates the whole `/solana` swap
  surface behind an honest "not live yet" wall. I have left it alone because the wall is
  truthful, but if the intent was for that surface to be live, it has been dark for
  weeks.
- **Which of the 19 open PRs do you actually want?** Most are dependabot. I have been
  working around them rather than through them.
- **What is `indexer/` for?** 1,832 lines, no CI job, no consumer, no deploy config, and
  26,018 files on disk. Its fate is a decision, not a code problem.
- **Is there a staging Supabase project?** Every migration decision this week was made
  against production because there is nowhere else to rehearse. Migration 004 is
  partially applied and running it as a unit would kill the live Trade Board; that is the
  kind of thing a staging project makes cheap to establish.

---

## 6. One process note, offered rather than asked

Three times this week a test passed that was proving nothing, and each time it was the
mutation check that caught it rather than the test suite:

- a fee-custody position test that passed with the check deleted, because a different
  fail-closed guard refused first;
- a test asserting `TWAB_WINDOW_DAYS === 180` in a case named "pins the island-confirmed
  constants" — it was protecting a fabrication, and made removing it look like a
  regression;
- an honesty guard that **required** the string "100% of protocol fees", so the test
  written to stop dishonest revenue claims was mandating one.

The wave's "done-means becomes a failing test before it becomes code" rail is the reason
all three surfaced. It is worth keeping for wave four, and worth extending with one line:
*after the test passes, break the fix and confirm the test fails.* A test that has never
been seen red is not yet evidence.
