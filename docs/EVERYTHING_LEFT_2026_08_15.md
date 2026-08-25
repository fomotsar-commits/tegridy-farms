# Everything left — updated 2026-08-22

This is the exhaustive remaining-work ledger. First written 2026-08-15 from a twelve-lane
verified sweep (220 candidates → 211 open → ~151 distinct). **Rewritten 2026-08-22** after a
five-lane reconciliation of every item against the tree, the chain, and live production —
because ~88 commits, a multichain feature branch, and three divergent copies of this very
document had accumulated in a week.

**What this rewrite absorbed, so nobody hunts for it elsewhere:** trunk's 08-19 reconciliation
layer · the 08-21 backend/env/nakamigos layer that lived only on `claude/sad-almeida-bde63d` ·
the M.1–M.18 multichain addenda that live only on `claude/jolly-ritchie-0d4dda` ·
`TODO_OPERATOR.md`'s 08-22 curated queue · and 186 per-item verdicts from today's
reconciliation. Where this file and `TODO_OPERATOR.md` disagree, **this file is now newer.**

**The score since 08-15:** of the original ~151 distinct items, roughly **45 closed**, **14
parked by your explicit instruction** (the custody chain), the rest still open — and the
feature spree plus the multichain branch added roughly **50 new ones**. Everything below is the
current state; nothing is carried forward unverified.

> **Merge note:** if merging `claude/jolly-ritchie-0d4dda` ever conflicts on this file, **keep
> this copy** — the branch's addenda are folded in below. Same for any `claude/sad-almeida-*` or
> `claude/todo-*` doc branch: their content is absorbed here; close them rather than merging.

---

## The state of the world, in seven lines — every one verified today

1. **Trunk has exactly 2 red checks** (both E2E). Lint/typecheck, Build, CodeQL, secrets, and
   all three advisory gates are green on HEAD. The contracts matrix is fully green on foundry
   1.9.1 — #306 and #205 are merged.
2. **Production redeployed since the CSP fix** — `uploader.irys.xyz` + `arweave.net` are in the
   **live** CSP header, so the Pro Pass upload block is gone. Do not redeploy for CSP.
3. **But the redeploy went out without the env vars**: the live bundle still
   `console.log`s every analytics event, SIWE login still returns **500** on both origins,
   analytics still **503**, births relay still **503 no_secret**. All probed today.
4. **The custody chain is DEFERRED by your instruction** (2026-08-21, on record in
   `WHAT_I_NEED_FROM_YOU.md` §0.3). It is not a blocker and no session may re-raise it.
5. **The multichain branch (`claude/jolly-ritchie-0d4dda`, 10 commits) is unmerged** — Base +
   Robinhood legs, the graduation stacks, the 5% reserve, the fee flips, and our own EVM launch
   curve all live there. It merges with exactly **4 content conflicts**.
6. **The Solana own-venue question (Decision 1) is still open**, and the **8.467 SOL** the
   program closes released on 08-13 is **unreconciled** — it went to an address the registry
   does not know. It is within 0.01 SOL of what a restart costs.
7. **You are being address-poisoned, actively.** `Dcj1fGKY…` (theirs) vs `Dcjink4R…` (the real
   deploy authority) — dust landed 59 seconds after a real deposit, twice, plus a second
   sprayer. **Addresses come from `frontend/scripts/addresses.json` only** — never wallet
   history, never an explorer feed, never a chat message, including mine.

**The six false blockers stand corrected** (Squads member B is your own key and the 2-of-2 is
proven usable · prod is current · the premium discount misleads nobody · `/solana` is already
live · the deploy authority buys nothing *unless* Decision 1 says restart · restaking is
**under** EIP-170 at 22,114 B since `c749c933`). One correction to the corrections:
**funding the deploy authority became conditional** — if Decision 1 is "restart", funding it is
legitimate, *after* `verify-program-constants.mjs` passes against the built binary.

---

## 2026-08-24 — the agent-side queue was EXECUTED. Read this before the sections below.

A full-scan-then-fix session closed most of "MY QUEUE" and changed several facts the sections
below still state in their pre-08-24 form:

1. **The multichain branch is MERGED** (`d48864e6`). The M.1–M.18 ceremony is now a trunk
   document, not a branch one. The 7-conflict resolution kept trunk's guardian-ordering docs,
   took the slice-manifest UNION (`{base,curve,markets,nftfi,robinhood,v2,vaults}`), and
   preserved the ParaSwap partner allowlist. #313's framer-motion caveat is now unblocked.
2. **Trunk can DEPLOY again** — the Vercel build was red because `tsc -b` swept
   `tsconfig.test.json` (741 test files, one importing outside `frontend/`); the build script
   now names app+node explicitly.
3. **The two E2E reds are explained and fixed**: the money-path red was a REAL bug, not
   seeding — repay sent a stale per-second quote as exact `msg.value`
   (`InsufficientRepayment` on every mid-term repay). Padded + error-surfaced; the
   "UNSEEDED" diagnosis is dead.
4. **The aggregator `?resource=` origin gates 403'd every same-origin browser GET in prod**
   (heat/launch gate, launch-radar, launcher-outcomes, alerts, referrals, commerce, airdrop —
   all dead for real users; invisible because probes hand-set Origin and dev/CI skip the
   gate). One shared `isRequestOriginAllowed` now serves all ten sites, with a
   Sec-Fetch-Site check that is strictly stronger. **Probe rule: never verify a browser GET
   with `curl -H Origin:` alone.**
5. **The receipt-status class is closed repo-wide** (reverted tx rendered as success on ~20
   write paths; now 3-of-3 → all; the broken R044 shared hook read fields that existed only
   in its own mock — fixed, and the mock scaffold now models real wagmi).
6. Honesty batch landed: Meteora ghost links (+ tripwire for in-page links), og.svg/png
   retracted-claim + origin + 4.0× boost, security.txt canonical, /tradermigos + /scanner
   redirects, theme-init dark-only, cp-swap header deletion (delta re-pinned, comment-only),
   AUDIT_RFQ "not deployed" corrected, Immunefi dead link removed, referrals parity test now
   EXISTS (the comment cited it for weeks).
7. Indexer batch landed: prod origins in the CORS allowlist, pg error-listener exit,
   stalled-cursor honesty into /ready, Staked onConflictDoUpdate, resume-aged-out gap
   detection (+ tests).
8. **022 and 023 are WRITTEN** (`frontend/supabase/migrations/`) — the vanished
   native_orders/trade_offers REVOKE (preflight + decision framing inline) and the 004 §2
   prune lockdown standalone. 016–021 now carry the self-recording ledger INSERTs.
9. Dependabot: the queue turned over — the old #310/#313/#316/#318 are gone; all 8 open PRs
   (#324–#331) are fresh minor/patch bumps and got `@dependabot rebase` onto the merged trunk.
10. **§1.3 (DBC config v2) is MOOT as written** — the Meteora rail was retired 2026-08-23;
    mint a v2 config only if the rail is ever deliberately revived.
11. Left for the operator, unchanged: §0.1–§0.4, §1.1–§1.2, the switchboard, Decision 1, the
    multichain broadcasts (M.2+ — Safes need a nonce≥1 smoke test first; forge cannot
    broadcast to 4663, use the cast-replay method), external sends, and deleting the two
    remaining absorbed doc branches (`claude/sad-almeida-bde63d`, `todo-update`) — remote
    branch deletion is gated away from the agent.

**2026-08-25 UPDATE — §0.1, §0.2 and the deploy are DONE, live-verified:** the operator ran
the eight DROPs + 014 + 013 (SIWE nonce = 200, the first successful login response production
has ever returned; analytics probe = `accepted:1`), `VITE_ANALYTICS_ENDPOINT` + `VAPID_SUBJECT`
were added to Vercel (⚠️ the §0.2 table was STALE — the VAPID keypair had been set since
Jun 10; only those two plus `MEMETICS_BIRTH_SECRET` were actually missing), and
`npx vercel --prod --yes` shipped the 08-24 trunk. Verified live: launch gate reads heat
(4.87° Drifter panel renders), all four formerly-403 aggregator GETs clear the gate from
page context, vanity redirects 307, security.txt canonical, new og.png bytes serving.
§0.1/§0.2 rows below are closed; §0.3/§0.4, §1.1–§1.2, MEMETICS_BIRTH_SECRET (unless pasted
during the session) and everything after remain open.

---

# YOUR QUEUE — ordered by unlock per minute

## 0.1 ⭐ The login change-set — still the single biggest unlock, unchanged for a week

`/api/auth/siwe?action=nonce` → `500` on both origins, re-probed today. The whole
authenticated tier — profiles, DMs, watchlists, votes, push, referral claims, real analytics —
is dark behind it. The cause is nailed: `siwe_nonces` does not exist in production (PGRST205);
migration **014** is the fix, and **015 §1 must run first.**

Follow `TODO_OPERATOR.md` §0.1 exactly — it carries the eight DROPs inline, both verify
queries (including the `votes` **upsert twins** check), and the 42501-vs-23502 proof. Three
things settled since the sweep:

- ✅ **The 21-vs-12 policy gap is resolved.** The live DB was enumerated: all 21 permissive
  policies are accounted for — 8 targets of 015 §1, 4 deferred read-side, **9 intentional**
  (public chat/orderbook/service-role). Expected count after the change-set: **13**.
- ✅ The `castVote` proxy precondition shipped 08-18 (`c66e6064`) — all eight user-data writes
  go through the SIWE proxy, with a tripwire test. *(It turned out `castVote` had zero callers,
  so the "kills voting silently" fear was about the library, not a live path.)*
- ⛔ The 008 rule got **wider** (today's find): never run 008 after 014 — **or after any of
  016–021.** 017/018 deliberately REVOKE what 008 blanket-grants, and 008's
  `ALTER DEFAULT PRIVILEGES` auto-grants anon on every future table.

Two planned steps **silently fell out of every newer list** — they exist nowhere and need an
explicit decision, not amnesia: the `native_orders`/`trade_offers` **REVOKE SELECT** (its old
number 016 was taken by alert_rules; the SQL was never written; next free number is 022) and
the `prune_revoked_jwts` REVOKE from 004 §2. I'll draft both; you run them or veto them.

## 0.2 One Vercel session — set four, confirm two, run 013, redeploy

`VITE_*` is baked at build time; setting without redeploying changes nothing.

| Set | Value |
|---|---|
| `VITE_ANALYTICS_ENDPOINT` | `/api/analytics` — today every event prints to the visitor's own console and vanishes (verified in the live bundle today) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `VITE_VAPID_PUBLIC_KEY` | same public value |
| `VAPID_SUBJECT` | `mailto:` you — it currently points at a dead domain |

**Confirm, don't change:** `SUPABASE_SERVICE_KEY` present, and the SIWE JWT carries a `jti`
claim — the write proxy fails closed without them, so every write would 503 the moment login
works. Then run `013_analytics_events.sql` and redeploy once more so both halves land.

## 0.3 Back up the deployer keystore + password — and `mainnet-deploy-authority.json`, same trip

Offline, two locations. `OwnableNoRenounce` has no renounce path: lose the keystore and **18
mainnet contracts become permanently unownable.** The Solana deploy-authority keyfile has **no
seed phrase** — the file *is* the backup. Hygiene verified 08-22: keys dir gitignored, nothing
ever committed. Explicitly carved **out** of the custody deferral.

## 0.4 Two sentences of Solana bookkeeping

- **Where did the 8.467 SOL go?** The close instruction named a recipient not in
  `addresses.json`. You know where you sent it. One sentence closes the largest unreconciled
  number in the Solana column — and decides whether a restart is a *transfer* or a *funding ask*.
- **The swap-fee-account key (`DVGiHe98…`, ~0.010 SOL) is not on this machine** — every keypair
  in all three key dirs was derived and none matches. Key elsewhere, or write it off?

## 1.1 Host the indexer (~$5–20/mo) — the biggest built-but-dark unlock

Six finished surfaces render "unavailable" for exactly one reason: **the pro terminal,
copy-trading, competitions, charting, portfolio history, tax reports.** Runbook:
`indexer/DEPLOY.md`. Railway → Postgres → deploy `indexer/` → `PONDER_RPC_URL_1` = your keyed
RPC (`_1..4` all work now with fallback-wrapping) → ⛔ **behind a rate-limited proxy, never the
raw port** (Ponder ships no auth) → `VITE_INDEXER_URL` = the proxy origin → redeploy. The
Solana indexing leg (`indexer-solana/`) rides the same host. Tell me when the URL is live and
the consumer pages get wired the same hour.

## 1.2 Set `MEMETICS_BIRTH_SECRET` — still 503 today

Server-side var, never `VITE_`. Must be **seacasa's exact HMAC key** (you hold it, per your
08-18 answer). After setting: `200 enrolled` = done · `422 retryable:false` = wrong/rotated
secret · `503 no_secret` = didn't reach the deployment, redeploy · `502` = their side, retry.

## 1.3 Mint DBC config v2 — cheapest revenue-relevant act on this page

Both code gates shipped 08-18 (`21835d1d`) — the feeClaimer offset fix (and #265 nearly
reverted it; the bad hunk was caught and dropped) and the explicit fee flags. Nothing blocks
you. Print without `--send`, read the resolved schedule, sign.
⛔ **Never publish `VITE_SOLANA_DBC_CONFIG` before v2 exists** — the live v1 opens at a 99%
fee, ~4 hours untradeable. Independent of Decision 1: this is Meteora's program, not ours.

## 2 — The switchboard the feature spree built (all deliberately off)

**Six migrations, written and unapplied: 016–021.** Every surface fails closed until its file
runs — five answer `503 schema-missing` with the migration path attached; 017 answers its own
`api_keys_not_configured`. Ordering that matters (verified in the files today):
⛔ **017 runs AFTER 015** (its own header says so) · 019/020/021 end with `NOTIFY pgrst` — do
not stop early · the rest are order-free. Two gotchas: **017 also needs Upstash**
(`metering_not_configured` without it), and **021's webhooks need `COMMERCE_WEBHOOK_SECRET`**
(settlements still record without it). *(The self-recording ledger `MIGRATIONS.md` describes is
fiction for 016–021 — only 000 has the INSERT. Mine to fix before you paste.)*

**The deploy gates — 12 zero-address constants in `constants.ts`, plus friends.** Filling the
address is the whole activation step for: `AIRDROP_FACTORY`, `VESTING_FACTORY`,
`TEGRIDY_LOCK_VAULT`, `LAUNCH_LOCK_VIEW`, `POSITION_MARKET`, `TEGRIDY_PRO_PASS`,
`TEGRIDY_LENDING` ⛔ *(oracle-gated — after the pool deepen + TWAP warm-up, or every valuation
reverts)*, `TEGRIDY_RESTAKING` ⛔ *(gated on the external re-audit, not size — the split landed;
`constants.ts:23`'s "DEFERRED to Phase 7" comment is stale)*, and the governance four
*(deployed 07-16, zeroed on purpose because they spend)*. The 13th (ERC-4626 harvest vault)
lives in `zap/venues.ts`. **Three have no constant at all yet** — `LaunchRugEscrow`,
`DecayingFeeHook`, and the spree's NFT-fi vault/BNPL + StreamingRevenueDistributor — those need
a constant *added* plus wiring, not just filled.

Orderings that cost money if reversed, each verified in source:
- ⛔ **Escrow: `setFeeSink` before `setCleanReleaseFee`** — a fee set before the sink
  **silently snapshots zero** for every escrow opened until the sink lands. *(The
  airdrop/vesting factories are safe the other way: they revert `FeeSinkUnset` loudly.)*
- ⛔ **Rug escrow openings ship disabled** — `setOpeningsEnabled(true)` is its own deliberate act.
- ⛔ **DecayingFeeHook's owner is decided before deploy** — the CREATE2 salt is mined over the
  constructor args; changing the owner changes the address and invalidates the mine.
- ⛔ **Never register `POSITION_MARKET` via `applyLendingContract`** on TegridyStaking — it
  would exempt it from the cooldown/rate-limit/AlreadyHasPosition guards.
- ⛔ `setGaugeController` remains **one-shot with no rotation path in deployed bytecode.**

**Fee dials — nothing charges anything today.** `VITE_SWAP_FEE_BPS` + `VITE_SWAP_FEE_RECIPIENT`
(fails closed; capped 100 bps) · `VITE_LAUNCH_TIER_PRICING=on` + the full five-tier
`VITE_LAUNCH_TIER_VENUE_BPS` table (partial tables are refused wholesale; tiers can only
*discount*, never exceed the standard line — verified in the resolver) ·
`VITE_CREATOR_FEE_SHARE=on` + bps. Plus three dials no list carried until today:
`VITE_COW_STOP_LOSS_HANDLER` + `VITE_TRIGGER_PRICE_FEEDS` (trigger orders — needs you to
verify a canonical ComposableCoW handler address first; a wrong one registers orders that never
fire), `VITE_YIELD_FEED_URL`, `VITE_ONRAMP_PARTNER_FEE_BPS`.

**Two one-line changes with outsized effect** (mine, listed so you know they exist): add
`getcontractcreation` to the Etherscan proxy allowlist — it is the whole deployer-reputation
differentiator, most terminal rows honestly show UNRATED without it; add an output column to
the indexer's `swap` table — no realised return is computable anywhere until it exists (the
pair events carry outputs, but not user-attributably).

**The Telegram bot** (`bot/DEPLOY.md`): zero npm dependencies (verified in the manifest),
non-custodial by construction. Needs `TELEGRAM_BOT_TOKEN` + `BOT_LINK_SECRET` — the **same**
secret on the bot host and Vercel, or link tokens verify on one side only.

## Decision 1 ⭐ — does the Solana own venue restart at all?

Both program ids are permanently spent; every PDA is orphaned (the `global` PDA holds
0.0059 SOL owned by a program that no longer exists); graduation never ran once (`admin::ID`
was the multisig account — fixed in source, undeployable now; #282 closed for that reason).
A restart = fresh keypairs, new `declare_id!`, **8.46 SOL settled / 13.4 SOL peak float** —
and note the shape: that is within 0.01 SOL of the 8.467 the closes released. §0.4's answer
decides whether this is a transfer or an ask.

Three honest options: **restart** (fund it; the runbook's "THE RESTART, IN ORDER" R1–R9 exists
on the multichain branch; `verify-program-constants.mjs` gates the spend) · **stay on Meteora**
(then 1.3's config v2 is the whole Solana story) · **park Solana** (then the audit RFQ and the
seacasa packet come off the critical path). Say which.

**Decision 2** — the PWA install name ("Tegridy Farms" vs memetic.fun; description already
fixed, both manifest files must move together). **Decision 3** — the flagged wing (perps,
synthetic dollar, gambling): confirmed nothing built, each blocked by a named house law that
would need amending in a commit first. **Decision 4** (new, from the contrast fix): ~25 pages'
light-mode art murals sit at 1.39:1 behind `.glass` — keep the dark murals or add a light
scrim. Lives only in CSS comments at `index.css:601-630`; no list carried it until now.

## Parked by your instruction — recorded so it is preserved, not re-litigated

The custody chain is deferred (your call, 2026-08-21): Safe topology, signer recruitment, the
3 Safes, the 18 re-homes, the NFTPoolFactory rescue via `0xA360`, pauseGuardian ×4, the
TegridyFactory unjamming (three cancels), `setGaugeController`, POL wiring, and the Community
un-gates behind them. Facts preserved: two Safes still at nonce 0; two of three signers share
one EIP-7702 delegate; the live factory guardian is still the hot key. **Three things fell out
of the curated lists without a recorded decision — flagging, not re-raising:** pausing
MemeBountyBoard + VoteIncentives (2 txs, ~20 audit findings), the Squads 2-of-3 repair + the
Treasury Safe third owner (cheap-insurance items your WINFY doc still lists), and the un-gate
waiver `SAFE_REHOME_RUNBOOK.md:171` still requires in writing. One correction that survives
the deferral: the incident-response fast path was fixed 08-19 — the documented `pause()` call
**reverts** for the guardian; the real entry point is `guardianPause()` (`607cdce8`).

## External sends — long lead times

| Send | State |
|---|---|
| **Seacasa wave-three packet** | Written, never handed over. Add the fifth question — the island's attestation signing key and route. The answer plugs into `VITE_ISLAND_KEY_ROUTE` + `VITE_ISLAND_CERTIFICATION_URL`, named here so it is actionable the day it lands. Note: the live record route still 400s the certification sub-path — Island Q3 remains genuinely open. |
| **Solana audit RFQ** | ⛔ Still misstates history — `AUDIT_RFQ.md:106-108` says "Not deployed… documented placeholder," untouched since 08-01. The 08-15 precondition (fix it first) was never done. Mine, then you send. Only if Decision 1 ≠ park. |
| **Whetstone petition** | ⛔ **Send after the multichain branch merges,** or it goes without the Base + 4663 rider (`b51e6be1`/`b201f469`, branch-only). The §15 on-chain reads date to 07-31 — re-run before sending. |
| **Immunefi** | Fix the 404'd link first — it is at `AUDITS.md:177` now, still unfixed. |
| SEAL 911 / Safe Harbor · legal + tax scoping | Free; none started; nothing pending on anyone else. |
| Paid EVM audit | Was sequenced "after the re-home." With custody deferred indefinitely, that sequencing is ambiguous — worth one sentence: wait, or book against the current admin model. |

## ⏰ Clocks

| When | What | If missed |
|---|---|---|
| **~2026-10-11** | Staking reserve runway ends | Claims silently pay **partial with IOUs** — no revert, worse for trust |
| **2026-11-16** | The npm-advisory baseline expires — 32 GHSA ids stop being suppressed | Every untriaged one starts **blocking CI**, including the bigint-buffer overflow whose only npm fix is a semver-major downgrade — a product decision, not a bump |
| **~Aug 2027** | `memetics.finance` renewal | A production domain lapses while monitoring stays green |
| Standing | EIP-170 headroom: **TegridyStaking 22 B**, VoteIncentives 99 B | A crossing is a **red CI run** (verified by execution), not a silent artifact — but do not casually edit those two files |

---

# THE MULTICHAIN CEREMONY — M.1–M.18, currently on the unmerged branch

Everything below lives on `claude/jolly-ritchie-0d4dda` (10 commits). **Merging it is my work
and comes first** — see my queue. Decided already: **M.7** (Shape A extended to 4663, not
Shape B revived) and **M.11** (reserve custody: interim = the operator EOA at 3.69%, actually
set in `config.ts` on the branch tip — the "still 0x0" note in older docs is stale; repointable
via `setLaunchConfig` for future launches).

| # | Step | Gate |
|---|---|---|
| M.1 | **4 disjoint Safes per chain** (Treasury / Multisig / PauseGuardian / FeeRemittance), proven signers, nonce > 0 | Precedes everything. Safe factories verified on 4663; Safe{Wallet} UI support there unverified — may need safe-cli |
| M.2 | `DeployBase/RobinhoodMVP` → accepts → Verify green | 4663 deploys the **AttestedSequencerUptimeFeed** first (no Chainlink there); the attestor duty goes into INCIDENT_RESPONSE **before** go-live. Guardian is set at construction — the F-30-10 lesson is baked in |
| M.3 | LaunchRail per chain (5 accepts each) | RugEscrow openings ship **disabled**; 4663 needs M.2's feed address |
| M.4 | LP farming per chain | Blocked on an **economics decision** — the reward token; the scripts refuse to pick one. Research verdict on record: fixed amounts, never APR targets; supply-mining is the documented dead pattern |
| M.5 | Frontend go-live per chain = ONE change-set | Fill zeroed ChainConfig from broadcast artifacts; a structural test fails the build if 4663 goes live with a null feed |
| M.6 | Vercel env on BOTH deploy paths | CSP half already done in code; env half open |
| M.7 | Robinhood graduation stack | Decided. Remaining: after M.2, broadcast → Blockscout verify → 48h initializer allowance → petition rider. ⚠️ **No third-party module has ever been whitelisted on any Airlock** — Whetstone blessing the module also satisfies the directive |
| M.8 | Monitoring legs per chain | ⚠️ **Code, not ceremony — still unwritten.** Without it the fee-rail-invisible-for-weeks incident repeats on Base day one |
| M.9 | Base graduation stack | After Base Safes; substrate triple-verified |
| M.10 | Whetstone petition + multichain rider | One conversation, three chains, same 3-of-6 Safe |
| M.12 | Doppler-rail reserve activation | Operator on-chain write (the Fact Sheet is an EAS schema — new disclosure column = re-registered schema). ⛔ Never lump the reserve into `teamAllocationVestedBps` — the truth suite pins it creator-only |
| M.13 | **CoW partner-fee flip** (pricing) | Largest uncollected line the fee-leak audit found. Verify CoW's `partnerFee` schema + one canary order first; the flip re-derives doc+hash atomically |
| M.14 | **Jupiter referral accounts** (Solana on-chain) | Until then our limit-order fee ships off, documented |
| M.15 | **Criteria-offer fee canary** | One live offer on a test wallet with the flag on; flip only if OpenSea round-trips it |
| M.16 | **Own EVM curve go-live per chain** | `GRADUATION_ETH_WEI` is a pricing decision the script refuses to default (floor 0.1 ETH). Mainnet can go **now** (TegridyFactory is live); 8453/4663 wait on M.2. Owner = multisig at birth; defaults 1% fee, creator 50%, reserve 3.69%, continuity-exact virtual reserves |
| M.17 | **Solana restart R1–R9** | Only if Decision 1 = restart. The runbook section is branch-only until the merge. Generate + offline-back-up fresh keypairs at R2 — the old ids are spent and the prior keys were never backed up |
| M.18 | **`recoverCallerCredit()` BEFORE any pool-deepen dollar** | Re-verified against trunk source today (`SwapFeeRouter.sol:1829`, permissionless). Every routed dollar parks 80% in the splitter the same way until this one tx is sent |

The fee-leak audit's verdict stands: **zero bug-leaks** — every outbound flow is a priced toll
(ledger: `FEE_LEAK_LEDGER.md`, branch-only until the merge). All four real findings were *our*
fee uncollected, and M.13–M.15 are their flips.

---

# MY QUEUE — what needs nobody but an agent

**First: merge the multichain branch, carefully.** Exactly 4 content conflicts
(`contracts-test-slices.json` — take the **union** or tests silently never run;
`DeployMVP.s.sol` + `GOLIVE_HANDOFF.md` — the same guardian fix authored twice, diff before
choosing; `useAirdropCampaign.ts` — keep trunk's type fixes AND the branch's chainId pins).
The feared add/add on this document auto-merges — but per the #205 lesson, **the auto-merges
are the dangerous part**: re-verify `aggregator.js` keeps the branch's paraswap
`partnerAddress`/`partnerFeeBps` allowlist (or M.13's flip 403s), and `foundry.toml` keeps both
sides. 16 files changed on both sides; diff them all post-merge.

**Then, in rough order:**
- **E2E, the last 2 red checks — the diagnosis FLIPPED late on 08-22 (`05aff561`), measured
  not argued.** The standing "order-dependent, do not add more seeding" guidance is
  **disproven**: Anvil is healthy (positive proof — a real money-path spec passes in 1.6 s with
  a matched receipt), the ~21 s clustering is a copy-pasted `{ timeout: 20_000 }` in four
  specs, and the reducedMotion hypothesis is dead (16 of 20 tests finish in 0.9–2.7 s). The
  four failing specs each **name what they need in their own assertion message** — the fixture
  seeds two things and they need more. Per-spec recipes are in `TODO_OPERATOR.md` §1a; the trap
  is named: warp time for reward accrual rather than writing the accumulator.
- **Dependabot queue:** trunk's `no-fallthrough` fix (`a0c83c42`) post-dates every open PR's
  merge base — one more `@dependabot rebase` should green ~8 of the 14. **Not all inherited:**
  #313 (framer-motion 13, major), #316 (jose), #318 (doppler-sdk) fail typecheck **on their own
  bumps** — per-PR triage, and #313 waits until after the branch merge (it would shift the
  typecheck surface under ~30 new TS files). #310 (docs): its six DBC constraints were
  salvaged into trunk (`4a222be7`) — close it.
- **Slither — narrowed by measurement on 08-22 (`05aff561`, `a790f954`): only 48 of the 362
  gate anything, 5 High across two files.** The config question is settled — it loads, and its
  promoted-detector list has not gutted the set. A 56-verdict triage is persisted at
  `SLITHER_TRIAGE_2026_08_22.md` but is **recorded as NOT actionable**: the adversarial
  refutation pass was killed before it ran, and a clean sweep with no independent check is
  precisely the shape this repo keeps shipping. Remaining work: run the refutation pass over
  the 56, then suppress line-by-line with reasons. Never lower `fail-on`.
- **Migration ledger truth:** add the self-recording INSERTs 016–021 are missing (the
  `MIGRATIONS.md` example is fiction today), write the `native_orders`/`trade_offers` REVOKE as
  **022** (or record the explicit decision not to), write the `prune_revoked_jwts` standalone,
  and widen the 008 warning in TODO_OPERATOR.
- **Nakamigos:** the 08-02 sweep's full record is now rescued into
  `docs/audits/nakamigos-sweep-2026-08-02-full.json` (it lived only in an OS-cleanable temp
  dir). ~90 findings remain open; **`portfolio.js:145` first** — a failed Alchemy sales fetch
  logs nothing in prod and renders the entire portfolio as pure profit. Then `api.js:780`
  (outage renders as a styled success), `MarketIntegrity.jsx:203`, `NftCompare.jsx:248`
  (SEND TRADE is a dead control). Re-check RaritySniper before acting — possibly overstated.
- **Doc surgery, all cheap:** the cp-swap `lib.rs` header still instructs the exact `admin::ID`
  mistake that bricked graduation (delete the two paragraphs, don't soften) · `security.txt`
  still never names memetic.fun (`Canonical:` is repeatable) · 3 "Last reviewed: July 2026"
  stamps · `contracts-ci.yml:117` still claims 239 B of TegridyStaking headroom, real figure
  22 B · `constants.ts:23`'s stale restaking comment · README's pool figures are stale *again*
  in the other direction (the 08-22 re-derivation supersedes its "8–11 WETH").
- **Coverage gaps:** `canUpdate()` answers only 1 of 4 preconditions `update()` enforces —
  widen it (moot on mainnet until the TWAP is bootstrappable, but the mismatch stands) ·
  teach `verify-addresses.mjs` to walk `additionalContracts[]` (land separately from flipping
  check 6, or CI goes red against 36 unclassified addresses at once) · tests for
  `TegridyNativeBuyRouter` (270 load-bearing lines, zero tests, fate = your call),
  `VotePowerOracle`, `notifyBirth.ts`, `launch-radar.js` (`heat.js` got its suite 08-18) ·
  the two unapplied zod schemas (aggregator, opensea; geckoTerminal is applied) · convert the
  three vendored Solidity trees to submodules (OZ, 833 files, frozen at paste-time).
- **Repo hygiene (grows every session):** 26 GB in `.git/worktrees` · 117 worktrees ·
  121 of 336 branches fully merged and safe to delete (verify against `origin/mvp-launch`,
  never `main`) · 12 stashes, nine on `main` — read before dropping · the bare `*.mp4` ignore ·
  and the **doc-branch sprawl**: `sad-almeida`, `todo-remaining-2026-08-21`, `todo-update`,
  `todo-completeness`, `reprice-capital`, `cranky-dhawan`, `interesting-gagarin`,
  `hopeful-swartz` all carry doc layers now absorbed here — close them, do not merge them.
- **Branch protection: `mvp-launch` has NONE** — the API 404s; no rulesets. The 08-22 shim
  deletion made required checks *possible*; nothing yet *requires* them. Arm only with the
  corrected context strings and the scope-job shape, after E2E greens.
- **Release identity:** `release.yml` has never run (no semver tag exists). One tag from real —
  but decide first what a tag claims, since prod deploys via two separate Vercel paths.

---

# CLOSED SINCE 08-15 — so nobody re-opens them

**08-18** (`ea56321f`, `abdbf38a`, `15ef4263`, `1d67f8e1`, `6891a2c4`, `ea4f982f`, `c66e6064`,
`21835d1d`): LP-boost auto-refresh mounted with tests · zod at the price boundaries ·
one-click stake mounted + `hooksAreMounted` ratchet (launch-buy exempted by design) · iPhone
15 + iPad in the Playwright matrix · a11y equality-asserted across **all 55 routes** (was
2 of 43) · `heat.js` test suite · **CSP: Irys + arweave, verified live in prod today** ·
castVote proxy + tripwire · both DBC code gates · coverage ratchet armed (at 0 — arming for
real is one `update_floor` dispatch; expect `forge coverage` to fail Yul-deep, and that is the
finding) · broadcast receipts committed (63 files) · advisory gate created.

**08-19** (`012c6f58`, `6b78e15b`, `c749c933`, `607cdce8`, `762e421f`, `f33aaa73`, `dc446f17`,
`33850b8c`): registry records both programs closed with **ProgramData `expect:absent`**
entries · ROADMAP rewritten with a status vocabulary · NEXT_SESSION retired · PWA description
fixed both files · **`000_base_schema.sql`** — the DB is rebuildable (all five missing tables
verified present) · **restaking EIP-170 solved** (host 22,114 B) · incident fast-path corrected
(`guardianPause()`) · arb-linkage on the PR gate · every test file sliced · guardian-at-
construction for future deploys · the colliding migration renumbered.

**08-21** (`01b26b86`, `cbc60f15`, `2fa85898`, `e1251c42`): typecheck covers test files, 53
errors fixed, mutation-verified both directions · registry chain read batched + Solana drift
covered (#280) + `readDeployment`-class stub-trap closed in CI · registry asserts what each
address *is*.

**08-22** (`514942c5`, `b0484908`, `5565506b`, `cdd58b06`, `dce626c3`, `6dedcb53`, `047f0cd4`,
`461d8b1e`, `0d4ec7e4`, `22823be3`): the eight-file "LIVE ON MAINNET" purge (two found by scan,
not list, + a source-scan tripwire) · **`readDeployment` reads ProgramData** — the one place
the chain read agreed with the wrong comment · the advisory gate **actually ran for the first
time** (errexit had killed it since arming; 0 blocking, everything baselined) · the four
echo-shim required checks deleted (third instance of the class — measured, not argued) ·
**#306 + #205 merged: the contracts matrix is green on foundry 1.9.1** after ~2 days of
silently skipping · chromium E2E greened (two real a11y defects) · #265 merged with the
gateway-404 block softened and the offset-revert hunk dropped · #304 merged (6-field
RestakeInfo) · the foundry mute lifted · #278 and #282 closed correctly.

**And the question ledger:** you hold the birth secret (believed) · `6VHowW4p…` is your own
key · the 21-policy enumeration is done · M.7 and M.11 are decided · the PR queue verdicts
(#278 close / #280 merge / #282 superseded by #281 / #205+#265+#304+#306 merged) all executed.

---

# Where doing it early is worse than never — the current table

| Doing this early | Costs you |
|---|---|
| **014 before 015 §1** | Login opens while permissive policies are live — every user's rows world-readable and writable |
| **017 before 015** | Its own header forbids it — new today |
| **008 after 014 — or after any of 016–021** | Blanket re-grant + `ALTER DEFAULT PRIVILEGES` auto-grants anon on every future table — widened today |
| **Publishing `VITE_SOLANA_DBC_CONFIG` before config v2** | Every public launch untradeable ~4h at a 99% fee; not recoverable by fixing it later |
| **Escrow `setCleanReleaseFee` before `setFeeSink`** | Every escrow until the sink lands silently snapshots a **zero** fee |
| **`applyLendingContract(POSITION_MARKET)`** | Exempts it from the staking guards — never, not early |
| **`setGaugeController` from the hot key** | One-shot, no rotation path in deployed bytecode |
| **Raising `polShareBps` before wiring the accumulator** | The slice silently folds into treasury |
| **Naming any authority before proving it signs** | The already-paid-for 8.4 SOL failure; two EVM Safes still sit at nonce 0 |
| **Funding the Solana deploy authority before Decision 1** | Buys nothing and reads as progress |
| **Deploying TegridyLending before the TWAP is warm** | Reverts on every valuation |
| **Deploying restaking before the external re-audit** | The deploy script's own header forbids it |
| **Merging #313 (framer-motion major) before the multichain branch** | Shifts the typecheck surface under ~30 new files |
| **Resolving the slices conflict lazily** | Dropped slice = those tests silently never run again |
| **Sending the Whetstone petition before the branch merges** | It goes without the Base + 4663 rider |
| **Sending the audit RFQ unfixed** | Tells four firms nothing was ever deployed — both halves now false |
| **Lumping the 5% reserve into `teamAllocationVestedBps`** | The truth suite pins that field creator-only; the disclosure becomes a lie |
| **Arming branch protection as originally written** | Wrong context strings + paths-filtered workflows = worse than today's honest zero |
| **A committed guessed coverage floor** | `contractsCoverageFloor.test.ts` fails it by design — measure or leave 0 |
| **Buying hardware keys / re-opening custody** | Parked by your instruction — and you cannot size hardware before naming signers |
| **Immunefi before the 404 fix + tier honesty** | Worse than no page |
| **DefiLlama before the pool deepen** | Publishes a 0.08-WETH pair |

---

# Do not chase — verified dead or deliberately closed

Everything on the 08-15 kill list stands (spot-checked today — nothing was resurrected).
Additions since: **don't re-open the Supabase backup** (green and real since the 08-12
rewrite) · **don't re-raise custody** (operator instruction) · **don't hunt dead selectors on
TegridyStaking** (all 60 have consumers — verified) · **don't re-redeploy for CSP** (it is
live) · **don't re-run the 08-15 probes against `/api/record` or `/api/births`** (not routes —
they are aggregator branches; 11 of 12 serverless functions) · **don't chase the 36-selector
restaking diff** (its own artifact was 167 B over) · **don't quote dollar figures from any doc
without re-deriving** — quote tokens; the 08-22 repricing memo shows the pool deepen got
cheaper in ETH while getting dearer in USD, in the same week.
