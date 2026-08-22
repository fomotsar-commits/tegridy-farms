# Operator packet — 2026-08-12

Everything here needs a key, a credential, or money. Nothing here can be done from a
pull request, which is the only reason it is a separate document.

Every fact below was read live on 2026-08-12 and says how it was read, so you can
re-check it rather than trust it. Where a number is stale in some other doc, that is
called out — several were.

---

## 0. Ordered, if you only do some of it

| # | Action | Cost | Unblocks |
|---|---|---|---|
| 1 | Fund the Solana deploy authority + back up the keyfile | ~$5 + a USB stick | Everything Solana. It is currently **impossible**, not slow |
| 2 | Deploy the frontend to production | free | Six live user-facing defects, incl. a button writing false claims to mainnet |
| 3 | `setGaugeController` on VoteIncentives | ~$0.02 | Closes a live bribe market with a no-op gate |
| 4 | Pause MemeBountyBoard + VoteIncentives | ~$0.04 | Closes ~20 audit findings at zero product cost |
| 5 | Decide on 014+015 (login) | free | The social layer — **and** the largest authz cluster in the codebase |

---

## 1. 🔴 The Solana deploy authority is empty

**Read it yourself:**

```bash
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7"]}'
```

Returns `value: 0`. `getAccountInfo` returns `value: null` — the account does not exist;
it has been rent-collected. Control on the same RPC: the Squads vault
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` reads exactly `1000000` lamports, so the
RPC is fine and the zero is real.

`addresses.json` said "3.53 SOL left. Keep it funded" until today. That was from 08-08.

**Why it is a blocker rather than bookkeeping.** `deployer::ID` is baked into the live
`tegridy-launch` binary at build time, so this is the only key that can ever call
`initialize_global`. PR #281 also makes it cp-swap's `admin::ID`, where
`create_amm_config` declares `payer = owner` — it must **sign and pay**. A key with zero
lamports can do neither. Graduation is blocked on this even after the cp-swap upgrade
ships.

**Also:** there is no seed phrase. The keyfile in
`C:\Users\jimbo\tegridy-ops\solana\tegridy-amm\keys\` is the only copy, on one machine,
inside a OneDrive tree that has silently pruned directories mid-session before. Back it
up to removable media before funding it.

CI now enforces this: the `registry vs chain` job fails while the account is empty.

---

## 2. Deploy the frontend

Prod currently serves none of today's fixes. What is live right now:

- the EAS attest button writes `tier=0` + `liquidityUnlockAt=0` permanently to mainnet,
  one screen after the wizard renders FLAGSHIP
- staking destroys the unpaid residual when a holder extends a lock (~15,000 TOWELI on a
  10,000 TOWELI position)
- the transparency page's revenue donut omits ReferralSplitter, which holds 100% of the
  only fee ever collected
- `/deployer` 502s on any busy address
- `/community` tells visitors four deployed, unpaused contracts "aren't live yet"

```bash
npx vercel --prod --yes
```

Run it from the **repo root**, not `frontend/` — the Vercel project root setting appends
`frontend`, so deploying from inside it publishes the wrong tree. Auto-aliases
memetic.fun in one shot; no separate alias step.

**Verify by the rendered page, never `res.ok`.** `vercel.json`'s SPA fallback returns
200 HTML for any unmatched non-`api/` path, so a broken route looks healthy to a status
check. One good probe:

```bash
curl -sI https://memetic.fun/record/ethereum/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D.json | grep -i content-type
```

Must say `application/json`. If it says `text/html`, the function is not being routed and
the SPA swallowed it.

---

## 3. On-chain, deployer key (`--account deployer`)

`cast` is not on the PowerShell PATH — use `C:\Users\jimbo\.foundry\bin\cast.exe`.

### 3a. `setGaugeController` — do this before any VoteIncentives work

VoteIncentives `0x6e1dcb7ebd16e09edb574f414adc664b2a5e21af` is live and unpaused with
`gaugeController() == 0x0`, and `_requireGaugedPair` is a **no-op when zero** — so it is
a bribe market that will accept deposits against arbitrary pairs.

`setGaugeController` is `onlyOwner` and **ONE-SHOT** (`GaugeControllerAlreadySet`). A
typo is permanent. Verify first, and note the trap: the address in
`contracts/broadcast/DeployVoteIncentives.s.sol/1/run-latest.json` has **no code** — do
not wire from the broadcast file.

```bash
npm run oneshot-guard -- --check voteincentives.gaugeController --to 0x6c79522d47cf6d1051cb474e81d9b6f3996c1054
```

That simulates from the owner and refuses a code-less target. Only send after it passes.

### 3b. Pause the two permissionless contracts

`MemeBountyBoard.createBounty` and `VoteIncentives.advanceEpoch` are permissionless, both
contracts are unpaused, and neither has a UI. Pausing closes roughly twenty audit
findings for two transactions and costs nothing in product terms.

- MemeBountyBoard `0x6d2c6ec29d97fe8b6d1471091deee36baf69d890`
- VoteIncentives `0x6e1dcb7ebd16e09edb574f414adc664b2a5e21af`

### 3c. Do NOT fire these

Both `sequencerFeed` one-shots must never be set on mainnet — Chainlink L2 Sequencer
Uptime feeds are `address(0)` on L1 by design. `npm run oneshot-guard -- --list` shows
all seven remaining one-shots and which are spent.

---

## 4. Database

**Applied today: 005.** `native_orders.seaport_order_hash` now exists, with the partial
index and the `^0x[0-9a-f]{64}$` CHECK. This restores the orderbook create path, dead
since 2026-05-10. It was applied only after the relist defect was fixed in code — see
below, and keep that ordering rule.

**The ledger, read from the live DB rather than inferred from files:**

| migration | state |
|---|---|
| 001 | PARTIAL — §7 yes, §1 no |
| 002, 003, 007, 008, 009, 010/011, 012 | applied |
| **004** | **PARTIAL** — its §5 `rate_limit_messages` trigger EXISTS |
| 005 | ✅ applied 2026-08-12 |
| 006 | applied |
| 013, 014, 015 | not applied |

⚠️ **004 is partially applied**, which no plan before today accounted for. Do not run it
as a unit: §1 drops `"Anyone can read trades"` and kills the live public Trade Board, and
:174-183 re-creates client write policies that 007 deliberately removed, re-opening
direct PostgREST writes to `trade_offers` with no Seaport-signature or maker check.

**Never paste whole:** 001 (aborts 42710 at :21, 42703 at :126) · 003 (42710 at :34) ·
004 (above) · 008 (its blanket `GRANT … ON ALL TABLES` reverses every REVOKE in
004/010/011/013/014).

### The 014 decision

**21 of 40 policies are PERMISSIVE with `qual = true`.** Postgres OR-combines permissive
policies, so `true OR (wallet = jwt.wallet)` ≡ `true` — ownership is enforced nowhere on
`user_watchlist`, `user_favorites`, `user_profiles`, `votes` and `messages`.

Nothing is exposed **today** only because SIWE has never worked, so those tables are
empty. `014_siwe_nonces.sql` turns login on and populates them.

**015 must land in the same change-set as 014, never after.** And note the trap the
triage found: applying 015 §1 as written breaks voting, because `castVote` writes `votes`
directly with the anon key. Resolve that before you run either.

If you do not want the social layer yet, the correct action is to leave both unapplied.
That is a real option, not a deferral.

---

## 5. Meteora DBC config v2 — needs code, not just a signing session

The live config `4HVMW8TRZmXAxERH94hkVgM279fSXSBBsjonBYmxxxMn` opens at a **99% fee**
decaying over 6h — below 20% only at 2.1h, below 5% at 4.0h. pump.fun is a flat ~1% from
t=0. For a memecoin launchpad the first minutes are the entire dynamic, so this is
disqualifying, and DBC configs are **immutable**: fixing it means creating a v2.

This is listed here for completeness but it is **not purely an operator task** — the
builder work is incomplete on our side. Do not schedule a signing session for it yet.

---

## 6. Known-red, deliberately

`e2e-anvil` fails 5 of 20 on a live mainnet fork. Those money-path tests were skipped for
months; un-skipping them is what surfaced the failures. Two fail on preconditions a bare
fork cannot satisfy ("no borrowable offer", "no accrued rewards"); the rest are stake,
liquidity, and a `/farm` mount that passes in mock and fails on a fork.

It is left red rather than re-skipped or `continue-on-error`'d, because this repo removed
both of those for exactly this reason. The fix is seeding fork state.

`registry vs chain` is red for the reason in §1 and goes green when the account is funded.

---

## 7. Not done, and not startable by me

- **No succession document exists** — `git grep` for bus-factor/succession returns zero
  files. One person holds the deployer keystore (19 live contracts), both Solana
  keypairs, Vercel (sole record of 9 server-only env vars), GoDaddy, Supabase and GitHub.
- **No legal entity** (Terms §14 says so), no tax or accounting treatment for the revenue
  every month of the plan is built to earn.
- **Backup scope is one item wide** — only the Solana keypairs are covered. Missing: the
  deployer keystore, Safe recovery material, the Vercel env set.

These are cheap now and expensive the day they matter.
