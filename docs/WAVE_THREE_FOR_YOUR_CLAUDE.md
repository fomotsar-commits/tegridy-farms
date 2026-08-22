# Wave three — for your claude

From the venue, 2026-08-15. Feed this whole page in.

This is the counterpart to the wave page you sent us. It reports what we built, what we
could not, and the four things we need answered. **Verify us rather than trust us** — every
factual claim below carries the exact read that establishes it, and one of them contradicts
the wave's own premise, so it is worth your checking rather than our asserting.

---

## 00 What to do with this

1. Run the four verifications in §01. They take one RPC each. If any disagrees with what
   we report, that disagreement is the most important thing in this document and should
   come back to us before anything else.
2. Get the four answers in §04. Each names the shape of answer that unblocks us, so a
   one-line reply is enough for all four.
3. Note the rails in §05 — those are constraints we are holding ourselves to. If the
   island wants any of them relaxed, say so explicitly; we will not relax them on our own
   reading.

Our own record lives in the repo at `docs/ISLAND_WAVE_THREE_STATUS.md` (the phase table,
which we update in the same commit as every phase close) and
`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md` (the phase-04 ledger).

---

## 01 Verify these four things yourself

### 1.1 Both Solana programs are closed — this breaks phase 02's premise

The wave opens phase 02 with *"your upgrade authority sits at the multisig, so the live
program can still learn."* It cannot. Check the **ProgramData** account, not the program
account — the program stub survives a close and still reports `executable: true`, which is
why an explorer makes this look healthy.

```bash
# tegridy-launch ProgramData  -> expect value:null
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS",{"encoding":"base64"}]}'

# cp-swap fork ProgramData    -> expect value:null
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["6TnZb1GTHhPAYsrbtwfELkqQrXyqCfv7V6s27RJKXHAF",{"encoding":"base64"}]}'

# control: the program STUBS still exist -> expect lamports 1141440, executable true
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED",{"encoding":"jsonParsed"}]}'
```

**Method trap, because it nearly produced a false result for us:** do not pass
`dataSlice:{offset:0,length:0}` — it returns `null` for accounts that plainly exist, so it
reports the control as dead too. A method that kills the control is measuring nothing. Use
a non-zero slice or no slice, and always run the control in the same pass. Confirm on a
second RPC (`https://solana-rpc.publicnode.com`) before believing either of us.

A program whose ProgramData is closed cannot execute, and on Solana the address is not
reusable. **What happens to that rail is the venue's decision, not the island's — we are
not asking. It is here because phase 02 has no live target and should not sit in your
tracker as work in progress.**

### 1.2 The floor is already 80

`LAUNCH_FLOOR = 80` and the `Resident` tier floor is 80, pinned to each other by a test so
a tidy-up cannot drift one without the other. The wave's confirmation needed no change on
our side. Nothing to check unless you want to see the pin.

### 1.3 The birth wire is built and waiting on one variable

The relay reads the secret server-side only — `process.env.MEMETICS_BIRTH_SECRET` in the
serverless handler, never a `VITE_` variable, never committed. Production currently answers
`503 {"code":"no_secret"}`, which is the honest unconfigured state rather than a failure.

```bash
# expect 403 Origin not allowed  (a hostile origin never reaches the signer)
curl -s -X POST 'https://memetic.fun/api/aggregator?resource=births' \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example.com' --data '{}'
```

That 403 is new this wave and worth knowing about: the branch previously reached the signer
from any client, so an Origin-less request could have had our venue key sign an arbitrary
birth. It was never exploitable because the secret was unset — we closed it **before**
setting the secret, deliberately, rather than after.

The ops panel for the queue exists and is mounted. Once the variable is set we run the test
birth, the replay, and record the enrollment id in the status file.

### 1.4 The record route serves real JSON

```bash
curl -sI 'https://memetic.fun/record/ethereum/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D.json'
# expect content-type: application/json — NOT text/html
```

`text/html` here would mean the SPA fallback swallowed the route and the function never ran.
`res.ok` cannot tell those apart, which is why we check the content type.

---

## 02 What we shipped, in one line each

| phase | state | what changed |
|---|---|---|
| 01 prove the wire | blocked | built and verified; waits on the venue setting the secret |
| 02 governed upgrade | no target | see §1.1 |
| 03 fee custody | **done** | one read before submit, fails closed, above broadcast |
| 04 the swarm | **done** | 43 findings, 0 critical, 9 high; 16 confirmed / 3 refuted |
| 05 custody home | blocked | on-chain signing, ours to run |
| 06 small true things | **done** | lane mounted · explainer corrected · seam laid dark |

Detail your claude may want to reason about:

**03.** The `feeClaimer`-is-the-vault guarantee existed only in operator tooling and had
never run on the public submit path. It now runs once, before submit, refusing on a
mismatch, an unreadable account, a throwing RPC, **and on there being no configured
expectation**. That last branch is the one worth noting: with nothing to compare against, a
"match" is vacuous, and a vacuous pass is indistinguishable from a verified one at the call
site. Blanking the expectation is therefore not a way to disable the check.

**04.** The two sharpest findings are both segmented mode, which `segment_count = 0` was
the only thing holding shut. It bypasses the graduation-price continuity band entirely
(a published table could list at 35%–122% of curve price against a ±5% band enforced
everywhere else), and a well-formed table can permanently brick every launch created under
it — one replayed variant bricks on the very first buy. Not exploitable now because nothing
can be called; recorded as source findings.

**06.** The 180-day averaging window is removed. We had exported it under the header
*"confirmed by the island"* and built a decay mechanic on it — the window rolls, warmth is
not banked, a wallet that sells decays out of the average — and both were rendered to
users. It was not confirmed and we should not have published it. The surface now carries
only continuous · zero-anchored from first hold · velocity-blind, and says plainly the
period has not been published. A guard fails the build if a window length or a decay story
reappears anywhere a user can read.

---

## 03 What we will do the moment each answer lands

So your side can see the cost of each reply before sending it.

| answer | what unblocks | size |
|---|---|---|
| TWAB window semantics | preview work, or a decision to leave the surface descriptive | small either way |
| which half is immutable | one published table + the code matching the sentence | small |
| certification read path | one path change; the module and its tests already exist | trivial |
| voucher clock | expiry judgement in the seam; the seam is otherwise complete | small |

None of the four is large. All four are currently guesses we have refused to make.

---

## 04 The four answers we need

Each one names the shape of reply that unblocks us.

**1 — Exact TWAB window semantics.**
Having removed the unconfirmed figure, a preview cannot reproduce the curve and the surface
says so. *Shape of answer:* either the window length and whether it rolls, or "stay
descriptive until published".

**2 — Which half of the fee constitution is immutable.**
Our shape: rate snapshotted per curve, destination read live with no delay. We intend to
publish plainly that **the rate is fixed forever and the destination is operational**,
rather than timelock the destination — the timelock discipline on our other rail exists
because that rail holds user funds in the contract, which was never true here. *Shape of
answer:* "that is acceptable", or "the destination must be timelocked".

**3 — The certification read path.**
The wave pins it to a per-token path form; we have done that. Our record route is
`/record/:chain/:ca.json`. *Shape of answer:* either
`/record/:chain/:ca/certification.json`, or a root you name.

**4 — The voucher's clock.**
The pinned attestation shape carries `as_of_unix` and `expires_unix`. *Shape of answer:*
either "verifier's clock" or the island's freshness rule. We have not guessed one and the
seam deliberately does not judge expiry at all today.

---

## 05 Rails we are holding, so your side knows our constraints

These are ours, taken from the wave and from our own history. If the island wants any
relaxed, say so — we will not relax them on our own reading of a message.

- **The oracle is the only judge.** We verify the island's signature; we never form an
  opinion about a wallet.
- **Unknown is never zero and never a confident value — in both directions.** An
  unconfigured check is not a pass and not a denial. This is why the attestation seam
  returns a *state* and not a boolean, and exposes no `valid` property: a dark seam's
  characteristic failure is someone wiring it in, reading falsy as "not attested", and
  enforcing a verdict the island never gave.
- **Nothing self-declares certification.** The garden lane renders as a promise and is
  deliberately not selectable. There is no flag, config value or admin action on our side
  that can turn it green.
- **The six-field birth body stays six fields**, signed over the exact wire bytes, key
  order fixed rather than following object construction.
- **Secrets are server-side only and never committed.** We will not accept a secret value
  in a message, a file, or a commit; it goes in the deployment environment by the operator.
- **A denial never looks like a failed broadcast.** Every refusal on the launch path is
  thrown above broadcast, carries no signature, and reports "nothing was submitted"
  because that is literally true from where it is thrown.
- **We publish no claim the chain was not asked about.** The 180-day window was a breach of
  this and is the reason the rail is stated here explicitly.

---

## 06 One method note, offered rather than asked

The wave's rail — *every done-means becomes a failing test before it becomes code* — is why
three problems surfaced this week that a green suite had been hiding:

- a fee-custody position test that passed **with the check deleted**, because a different
  fail-closed guard refused first and absorbed the assertion. Two fail-closed guards in
  sequence cannot be pinned by one test with the network off;
- a test asserting the 180-day window in a case named *"pins the island-confirmed
  constants"* — it was protecting the fabrication, and made removing it look like a
  regression;
- an honesty guard that **required** a claim already established as false, so the test
  written to stop dishonest claims was mandating one.

We would keep the rail for wave four with one line added, and suggest your side adopt it
too: **after the test passes, break the fix and confirm the test fails.** A test that has
never been seen red is not yet evidence. All three above were caught that way and none by
the suite passing.
