# What I need from you

Everything that could be built without you has been built. This is the list of things that
**structurally cannot** be done by an agent — because they need a key, a credential, a payment,
a human signature, a legal identity, or a decision that is yours to make.

It is ordered so that each item unlocks the most work per minute you spend. Nothing here takes
more than an hour except where marked.

**Two rules that protect you, and one honest note.**
1. I never type a secret into a field. Where a step involves a key, you set it yourself — never
   paste it into a chat, including to me.
2. I never change security settings on live infrastructure or sign anything that moves value.
3. Some of this cannot be compressed. Audit firms have calendars, signers are people, and a
   staking reserve runs down on its own schedule. Where a date matters, it is marked ⏰.

---

## 🔴 Read this one first

**Your incident-response runbook told the pause guardian to call a function that reverts.**

`INCIDENT_RESPONSE.md` §3 documented the fast path as `pause()`. That function is `onlyOwner` on
every contract, so the guardian calling it fails. In a live incident the responder would have
followed the runbook, watched the transaction revert, and spent the opening minutes of an emergency
debugging the runbook instead of stopping the loss. The real entry point is a separate function,
`guardianPause()` (selector `0xd4593872`, no arguments). Corrected in the doc, verified against
source across all nine contracts that expose it.

Two things follow that are yours:
- **`0xCDCA` has never signed anything** (nonce 0) and it is the address that would make that call.
  Your incident plan assumes a two-minute pause from a Safe that has never proven it can assemble a
  signature. Proving it costs one cheap transaction today.
- **Unpausing is not symmetric.** `unpause()` is `onlyOwner`, so a guardian pause commits you to a
  multisig round trip to undo. Correct asymmetry, but it means pausing is not a free action.

---

## Tier 0 — do these first (free, minutes each, unlock the most)

### 0.1 Run the login change-set ⭐ the single biggest unlock
**What:** eight `DROP POLICY` statements, then migration 014, in one Supabase SQL session.
**Why it's first:** it turns on SIWE login, which gates the entire social tier — profiles, DMs,
watchlists, votes, push notifications, and real analytics instead of events printed to the
visitor's own console and discarded. It also closes a live write-side exposure on four user tables.
**Steps, verification queries and the traps** are in [`OPERATOR_NEXT.md`](OPERATOR_NEXT.md) §A.
**Already verified for you:** I ran the enumeration against your live database. All 21 permissive
policies are accounted for — 8 are the targets, 4 are the deferred read-side, 9 are intentional
public/service-role. The migration is safe exactly as written.
**Tell me:** the row count when you re-run the enumeration afterward. It should be 13.

### 0.2 Redeploy Vercel
**Why:** several shipped fixes only take effect on a new build — the CSP that currently
browser-blocks Pro Pass collection creation, the write-proxy repoint, and the analytics endpoint.
`VITE_*` variables are baked in at build time, so setting one without redeploying changes nothing.

### 0.3 Name the Safe topology
**What:** pick **8 keys** (2-of-3 Admin / 2-of-3 Treasury / 1-of-2 Guardian — recommended),
or **3 keys** (Admin only, self-held on three separate hardware devices).
**Why it's free and urgent:** every previous attempt stalled at "we need 15 signers and have 3."
The 15 is the problem, not the recruiting. Naming a reachable number unblocks the longest
dependency chain in the repo: signer recruitment → Safe deployment → 18 ownership transfers →
the audits, the governance un-gates, and the lending deploy that all wait behind it.

### 0.4 Back up the deployer keystore + password, offline, two locations
**Why:** `OwnableNoRenounce` disables renounce. Lose that one file before the ownership migration
and **18 mainnet contracts become permanently unownable.** Cheapest item on this page, worst tail.

### 0.5 Squads 2-of-2 → 2-of-3, and add a third Treasury Safe owner
**Why:** a 2-of-2 cannot repair itself, and the repair is itself a 2-of-2 transaction — so it is
only possible **while both keys still work**. Same argument on the Ethereum side.

---

## Tier 1 — one account, unlocks the largest revenue cluster

### 1.1 Host the indexer (~$5–20/month)
**What:** a Railway account, Postgres, deploy `indexer/`, put it behind a rate-limited proxy, set
`VITE_INDEXER_URL` in Vercel.
**Why:** it is the chokepoint under the trading terminal, leaderboards, copy-trading, portfolio and
tax APIs — the biggest revenue cluster in the top-100 list. Everything client-side is already
built and honesty-gated: with no URL set, every surface says "unavailable" rather than inventing a
zero.
**Runbook:** [`indexer/DEPLOY.md`](../indexer/DEPLOY.md) — env vars, the mandatory proxy (Ponder
ships no auth and no rate limiting; the raw port must never be public), and bring-up.

### 1.2 Set `MEMETICS_BIRTH_SECRET`
**What:** a **server-side** Vercel variable (never `VITE_`, which would ship it to every browser),
then redeploy.
**Why:** production answers `503 no_secret`, so nothing launched on your venue is enrolled with the
island and no launch accrues Heat from birth.
**It must be the exact secret seacasa issued** — it is a shared HMAC key, and a self-generated
value fails on their side where you cannot see it. After setting it, launch or replay a birth:
`200 enrolled` means the key matches, `422` means the island rejected the signature, `503` means
the variable never reached the deployment, `502` means their socket is down and says nothing about
the key.

### 1.3 Provision VAPID keys
`npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VITE_VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (currently pointing at a dead domain). Push
notifications and the alerts product need these; nothing can subscribe until login works, so this
follows 0.1.

---

## Tier 2 — switches, all of them deliberately off

Everything below was built, tested, and shipped **inert**. Each line is the exact act that turns
one on. None of them can turn on by accident, and several are ordered — the order is stated where
getting it backwards costs you something.

### 2.1 Mount three finished surfaces *(one line each; I could not reach the files)*
`AlertsPanel`, the trigger-order tab, and the launch-pricing call site all sit outside the
ownership fences the build slices ran under, so they are complete and unrouted:
- Alerts: route `src/components/notifications/AlertsPanel.tsx` and add it to `lib/navConfig.ts`.
- Triggers: add a `trigger` tab to `pages/TradePage.tsx`, mirroring the existing TWAP tab.
- Launch pricing: thread `pricing` through `pages/LaunchPage.tsx` — until then both fee flags
  below are inert end-to-end no matter what you set.
- `/airdrop` and `/vesting` are reachable by URL but not in the nav, which suits rails that are
  still undeployed. Adding them should be a deliberate act.

### 2.2 Apply two migrations by hand *(this database has no migration ledger)*
`016_alert_rules.sql` and `017_api_keys.sql`. Both written, neither applied. Until `016` runs,
every alerts call answers 503 `schema-missing` and says so — it does not pretend to have no rules.
⚠️ They were briefly both numbered 016 by two independent slices; I renumbered the API one. If you
ever see two files sharing a number again, that is the bug — you apply one, see "016 done", and the
other never lands.

### 2.3 Deploy the contracts that are written and deployed nowhere
`AirdropFactory` · `TegridyAirdropDistributor` · `VestingFactory` · `TegridyVestingWallet` ·
`TegridyLockVault` · `LaunchLockView` · `LaunchRugEscrow` · `DecayingFeeHook` — plus the
long-standing `TegridyLending` (oracle-gated) and `TegridyLiquidityMigrator`.
Filling their addresses into `constants.ts` is the entire activation step; every surface is
already gated on them. Deploy scripts exist, are mainnet-chainid-guarded, require `MULTISIG` to be
a contract, and have **never been run**.

⚠️ **Fee-dial ordering, both new contracts:** call `setFeeSink(...)` **before** `setFee(...)`. A
fee with a zero sink is snapshotted as zero, so the reverse order silently ships free escrows until
the next one opens.
⚠️ **The escrow ships with openings disabled.** `setOpeningsEnabled(true)` is a separate deliberate
act, and nothing about a launch changes just because the contract exists.
⚠️ **The decaying-fee hook's owner is set in the constructor** because the deploy script mines a
CREATE2 address over the constructor args. Rotating the owner afterwards changes the address and
invalidates the mine — decide the owner before deploying, not after.

### 2.4 Two fee decisions (a flag and a price are two separate decisions)
- **Heat-tier launch pricing:** `VITE_LAUNCH_TIER_PRICING=on` plus a full five-tier bps table. All
  five tier words must be named or it refuses to apply — a partial table would silently price
  someone at a default they never chose.
- **Creator revenue share:** `VITE_CREATOR_FEE_SHARE=on` plus `VITE_CREATOR_FEE_SHARE_BPS`.
- **Swap/trigger fee:** `VITE_SWAP_FEE_BPS` + `VITE_SWAP_FEE_RECIPIENT`.
The venue's take is **structurally capped** at today's rate: no configuration of these dials can
raise it, because the resolver rejects any tier priced above the standard line.

### 2.5 The graduation venue — pick the shape first
The repo now contains **two different versions of #2** and they are not compatible: the battle
plan specifies a new V2-fork migrator burning LP to a dead address, while the tree already has
`TegridyLiquidityMigrator` graduating into a V4 hooked pool with LP time-locked in the fee locker.
**Choose one before anything is deployed.** Then, in order: deploy the migrator → get Whetstone to
whitelist the module (`Airlock.setModuleState(<migrator>, 4)`, executed by the Airlock owner — a
petition, not a transaction you can send) → grant the hook's initializer allowance via a 48h
timelocked admin action → *only then* set `TEGRIDY_V4_MIGRATOR_ADDRESS` and redeploy. Skipping the
whitelist means graduation reverts at pool initialization.

### 2.6 Known product gap, needs your call
**Airdrop manifest hosting is unsolved,** and it is the biggest gap in that feature. The chain
stores a 32-byte root and no list, so today a claimant must paste JSON the creator hands them.
Either host manifests (indexer tables, or IPFS/Arweave pinning), or accept the paste flow and say
so in the UI. Right now the UI is honest about it, which is not the same as it being good.

### 2.7a Migrations, updated — FOUR now, applied in this order
`016_alert_rules` · `017_api_keys` · `018_airdrop_manifests` · `019_referral_codes` ·
`020_telegram_links`. All written, none applied. Two things to know:
- Each surface answers `503 schema-missing` with the migration path attached until you run its
  file — never a confident empty result. So a surface that looks broken is telling you which
  migration is missing.
- `019` and `020` end with `NOTIFY pgrst, 'reload schema'`. Do not stop before that line, or the
  table will exist while every call insists it does not — the same failure that kept login dark.

### 2.7b Services built and hosted nowhere
Three now, each with its own runbook, each deployed by you:
- **The indexer** — `indexer/DEPLOY.md`. Still the biggest single unlock: the terminal,
  copy-trading, competitions, charting and tax reports all read through it and all currently say
  "unavailable" rather than rendering an empty result.
- **The Solana indexing leg** — same host, runs beside the Ponder app.
- **The Telegram bot** — `bot/DEPLOY.md`. Zero npm dependencies on purpose, so no postinstall in
  any dependency tree can reach its secret. It is non-custodial by construction: its credential can
  bind a chat and can *never* attach a wallet, so a compromised bot host has nothing to spend.

### 2.7c Two boundaries worth knowing before you judge a surface
- **The terminal will show most rows as UNRATED**, and that is correct. There is no creator lookup:
  Etherscan's `getcontractcreation` is not in the API's allowed actions, so a token's deployer
  cannot be resolved automatically. Adding that action is a small change and it is what turns the
  terminal from honest-but-sparse into the product. Worth doing early.
- **No leaderboard anywhere shows realised PnL**, because the indexed swap row carries no output
  amount and no price. It is not caution — the number does not exist in the schema. Adding an
  output amount to the indexer's swap table is what would make returns computable.

### 2.7 Branding decision
The PWA manifest no longer describes a single-chain farming product, but the **name** is still a
question only you can answer — the app is "Tegridy Farms" at memetic.fun with a Tradermigos
marketplace inside it, and installing from the marketplace produces an app named after the venue.

---

## Tier 3 — external, long lead times, start early

### 3.1 Send the Solana audit RFQ
Written, never sent. Audit calendars — not engineering — are usually the schedule constraint, so
this goes out before you think you need it. Fix `AUDIT_RFQ.md:107` first: it currently tells four
firms nothing was ever deployed and nothing holds funds, and both are now false.

### 3.2 Book the EVM firm audit — **after** the ownership migration
Auditing a system whose admin model is about to change out from under the report wastes the report.

### 3.3 Send the wave-three packet to seacasa
Written, pushed, never handed over. Add the fifth question: **when will the island publish its
attestation signing key, and at what route?** Without it the Heat gate stays advisory — anyone who
reads the Airlock ABI can launch around it. It is the largest thing they owe you.

### 3.4 The rest
SEAL 911 / Safe Harbor registration (free, no dependencies) · Immunefi listing (fix the 404'd link
in `AUDITS.md:178` first, and don't publish reward tiers a $61 treasury cannot honour) · DefiLlama
listing (only after the pool deepen) · legal entity and tax scoping (nobody has been contacted, so
nothing is pending on anyone's side).

---

## ⏰ Clocks that run whether or not you act

| When | What | If missed |
|---|---|---|
| **~2026-10-11** | Staking reserve runway ends | Claims silently pay partial with IOUs — quieter than a revert and worse for trust |
| **~Aug 2027** | `memetics.finance` renewal (registered 1 year, 2026-08-02) | A second production domain lapses while monitoring stays green |
| Now → re-home | One EOA owns 18 contracts; one keystore, one machine | Loss is permanent unownability; compromise is everything |
| Every day dark | Solana rail armed with zero launches; social layer off; governance idle | The wedge dulls while competitors compound |

---

## Things I deliberately did NOT do, and why

- **Run your SQL.** Modifying security policies on a live database is not something I'll do even
  when told not to ask. If I fat-finger a policy name or run the wrong section, you are the one who
  has to notice and unwind it — and you can't do that if you weren't the one driving.
- **Type any secret.** Birth secret, VAPID keys, RPC keys. I don't put credentials into fields.
- **Deploy any contract, enable any fee, or wire any live address.** Everything new ships
  zero-address-gated or flag-off, so switching it on is your decision and your signature.
- **Merge the Solana segmented-mode removal.** It's sound and its client half has landed, but it
  deletes a capability, so it waits on your sign-off — see "Decisions waiting on you".
