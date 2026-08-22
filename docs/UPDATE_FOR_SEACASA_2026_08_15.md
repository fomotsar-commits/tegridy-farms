# Wave three — status from the venue

2026-08-15. Everything in this wave that could be built has been built, merged and is
live in production. This is the account of it, and the four things we need in writing.

The repo carries the same record at `docs/ISLAND_WAVE_THREE_STATUS.md`, which is the file
the island reads, and the phase-04 ledger at
`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`.

---

## Where each phase stands

| phase | state |
|---|---|
| 01 prove the wire | **blocked** — waiting on the venue to set the secret in production |
| 02 governed upgrade | **cannot execute as written** — see below |
| 03 fee custody on the public path | **done** |
| 04 the swarm, pointed at the program | **done** |
| 05 custody comes home | **blocked** — on-chain signing, ours to run |
| 06 small true things | **done** |

**The floor is at 80, the Resident word.** We were already there — no change was needed.

---

## 02 — the premise is gone

The wave opens phase 02 with "your upgrade authority sits at the multisig, so the live
program can still learn."

It cannot. **Both Solana programs are closed on mainnet.** The ProgramData accounts for
`tegridy-launch` and for the cp-swap fork both return `null` with 0 lamports, verified on
two independent RPCs. The program stubs still exist and still report `executable: true`,
which is why this looks healthy from an explorer — the ProgramData account is where the
truth is.

A program whose ProgramData is closed cannot execute, and on Solana the address is not
reusable. So the creator-fee door, the decimals pin and the fee-constitution sentence are
all written against a rail that is no longer on chain.

We are not asking the island to decide what happens to that rail — that is ours. What
matters here is that phase 02 has no live target, so it is reported honestly rather than
left showing as work in progress.

The audit in phase 04 was still worth running. Its findings are about the **source**, and
they are exactly what any future deploy would carry forward.

---

## 03 — fee custody, verified where the public walks

The strongest guarantee on this rail is that the config's `feeClaimer` is the Squads
vault, so fees cannot be redirected to a person. That check existed, and it had never run
on the public submit path — it lived in operator tooling, so the one place a stranger's
money was at stake was the one place nothing asked the chain.

It now runs before submit: one read, refusing on a mismatch, an unreadable account, a
throwing RPC, and on there being no configured expectation at all. That last branch
matters — with nothing to compare against, a "match" is vacuous, and a vacuous pass is
indistinguishable from a verified one at the call site.

It sits above the SDK and far above broadcast, so a refusal is provably "nothing was
submitted" and carries no signature. A denial can never read as a failed broadcast.

---

## 04 — the swarm, pointed at the program

Six lanes over the launch program and the cp-swap fork diff. Every high and medium
finding was then handed to an independent verifier instructed to default to refuted.

**43 findings — 0 critical, 9 high, 10 medium, 10 low, 14 info. Verify pass: 16
confirmed, 3 refuted.** Each carries a disposition, in the same culture as our existing
remediation ledgers.

The two sharpest are both about segmented mode, which `segment_count = 0` was the only
thing holding shut — one authority signature away:

- **It bypasses the graduation-price continuity band entirely.** The economics check
  models only the constant-product curve and the segmented path never calls it, so a
  published table could list a launch at 35%–122% of its curve price, against a ±5% band
  the program enforces everywhere else.
- **A well-formed table can permanently brick every launch created under it.** Three were
  replayed against the live parameters; one bricks on the very first buy, with the
  creator's rent already spent and the mint authority already burned.

Plus three client defects that would have built valid-but-wrong transactions: a 162-byte
curve decode against a 716-byte account, a trade instruction omitting the creator
account, and a migration instruction omitting the fee recipient and shifting 21 accounts
by one position.

None is exploitable now, because nothing can be called. They are recorded as source
findings, to be closed before anything is deployed again.

---

## 06 — the three small true things

**The garden lane is mounted.** The certification module was correct and had no importer,
so the island's promise was invisible and the module's tests guarded code nobody could
reach. It now renders on the launch page as a promise, and is deliberately **not
selectable** — offering it as a choice would be the venue self-declaring certification,
which the spec forbids. When dark it shows the island's own reason, because a dark lane
that does not say why reads as broken, while one that says why reads as waiting. The read
is pinned to a per-token path, not a query parameter.

**The explainer is corrected.** We had exported a 180-day averaging window under the
header "confirmed by the island", and built a decay mechanic on top of it — that the
window rolls, that warmth is not banked, that a wallet which sells decays out of the
average. Both the number and the mechanic were being rendered to users.

It was not confirmed, and we should not have published it. The surface now carries only
the three properties the island has actually given — continuous, zero-anchored from first
hold, velocity-blind — and states plainly that the averaging period has not been
published, so the curve cannot be reproduced yet. A guard fails the build if a window
length or a decay story reappears anywhere a user can read it.

**The attestation seam is laid dark.** Config-shaped and inactive against the pinned
shape only: an island-key signature over canonical JSON of the seven fields, in the
island's order, with the public key read from a route that does not exist yet. No key, no
route, no activation.

The verdict it returns is a **state, not a boolean**, and there is no `valid` property to
read. That is deliberate. A dark seam's characteristic failure is becoming load-bearing
by accident — someone wires it in, it returns falsy because nothing is configured, the
caller reads falsy as "not attested", and a check that has never run starts deciding who
may launch. Unconfigured is not a denial either.

The canonical encoding fixes key order to the island's rather than to object
construction order, so two encoders of the same voucher produce identical bytes. Same
discipline the birth socket already keeps, and for the same reason.

---

## What we need in writing

1. **The exact TWAB window semantics.** Having removed the unconfirmed figure, a preview
   cannot reproduce the curve, and the surface now says so. Is a reproduction preview
   expected before the window is published, or should that surface stay descriptive until
   it is?

2. **Which half of the fee constitution is immutable.** Our shape is: rate snapshotted per
   curve, destination read live with no delay. We intend to publish plainly that **the
   rate is fixed forever and the destination is operational**, rather than move the
   destination behind a timelock — the timelock discipline on our other rail exists
   because that rail holds user funds in the contract, which was never true here. Confirm
   that is acceptable, or say the destination must be timelocked.

3. **The certification read path.** The wave pins it to a per-token path form. Our record
   route is already `/record/:chain/:ca.json`. Should certification hang off that same
   shape — `/record/:chain/:ca/certification.json` — or sit at its own root?

4. **The voucher's clock.** The pinned shape carries `as_of_unix` and `expires_unix`.
   When the seam activates, is expiry judged against the verifier's clock, or does the
   island expect a freshness rule of its own? We have not guessed one, and the seam does
   not currently judge expiry at all.

---

## One note on method, offered rather than asked

The wave's rail — every done-means becomes a failing test before it becomes code — is
the reason three separate problems surfaced this week that a passing suite had been
hiding:

- a fee-custody position test that passed **with the check deleted**, because a different
  fail-closed guard refused first and absorbed the assertion;
- a test asserting the 180-day window in a case named "pins the island-confirmed
  constants" — it was protecting the fabrication, and made removing it look like a
  regression;
- an honesty guard that **required** a claim we had already established was false, so the
  test written to stop dishonest claims was mandating one.

We would keep that rail for wave four, with one line added: after the test passes, break
the fix and confirm the test fails. A test that has never been seen red is not yet
evidence.
