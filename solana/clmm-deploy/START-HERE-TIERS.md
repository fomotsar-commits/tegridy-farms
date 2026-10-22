# Start here: the range program's two fee tiers

Staged {{STAGED}} from commit `{{COMMIT}}`, for {{FOR}}. Nothing in this folder has been sent
anywhere. You are the only one who signs. All times are UTC.

**Execute the fee-tier proposal only on this folder's page (step 4). Never in the Squads app or any
other tool.** The page reads the proposal's stored instructions back from the chain and refuses one
that differs from the decided tiers by a single byte, and it holds the execute until
{{NOTICE_WHEN}}. The Squads app does neither: from the end of the vault's 48-hour lock it would
execute at once.

## Where things stand

| | |
|---|---|
| Sittings 1 to 3 | **done**: the program's key, the devnet practice run and the deploy, in the earlier folders. The deploy's folder is `{{MAINNET_PACK}}`; its page is retired: use this one |
| The program | `{{PROGRAM_ID}}`, deployed in slot {{DEPLOYED_SLOT}}. Its address is public since the deploy |
| Its one build | `{{BINARY_FILE}}`, {{BYTES}} bytes, sha256 `{{SHA256}}`. The repo's CI rebuilt the very same bytes |
| Who can change it | only the vault, `{{VAULT}}`: two approvals, then 48 hours |
| The fee-tier proposal | #19, with both approvals since 2026-10-21. The vault's 48-hour lock ends 2026-10-23 13:45:21 |
| The fee notice on mvp-launch | `{{NOTICE_LINE}}` |
| The earliest execute | {{NOTICE_WHEN}}, and never before the lock ends |

Why that date: the notice first said seven days from 2026-10-21. #19's second approval came the same
day through the Squads app, so the chain allows its execute from 2026-10-23 13:45:21. On 2026-10-22
you updated the notice to name its own date, {{NOTICE_WHEN}}, and this page holds the execute until
then.

The two fee tiers, as you decided on 2026-10-20 (docs/RANGE_POOLS_PLAN.md in the repo):

| Tier | Fee of each swap | Price steps (tick spacing) | LPs whose range is in use keep | The venue (the vault) | The island (Workshop `{{WORKSHOP}}`) |
|---|---|---|---|---|---|
| 0 | 1% | 120 | 0.84% | 0.104% | 0.056% |
| 1 | 0.25% | 60 | 0.21% | 0.026% | 0.014% |

How money moves once pools are open: an LP earns 84% of the fee of every swap that trades through
their range. The venue's 10.4% collects in the pool and only the vault can take it out. The island's
5.6% collects too, and only the Workshop can take it out. **The vault can still move it**: one
proposal (two approvals and 48 hours) can point the island's share at another account, the vault
included, and collect it there. No tier can charge more than 4% of a swap, or give the venue and the
island more than 16% of each fee together. When a swap fills a limit order where no LP's range is in
use, the LPs' 84% goes to the venue instead. Nobody pays anything to Raydium, ever.

The vault pays the two tiers' rent, {{TIERS_SOL}} SOL, locked in the two tier accounts for good. The
member who executes pays about 0.00002 SOL in network fees.

## The sittings

| Sitting | When | What happens | Who signs |
|---|---|---|---|
| 1 | once a merge to mvp-launch has landed AFTER this folder was made (a session says so) | check the program, record the notice, read the page | nobody |
| **2** | from {{NOTICE_WHEN}} (the page names the minute) | **the execute**: both tiers are made | either member |

## The steps

Do them in order. If what you see is not what the step says, stop and read "If a step does not go as
written" below.

# SITTING 1: CHECK AND RECORD (nobody signs)

**Step 1. Check the program.**

```powershell
node "{{PACK}}\scripts\4-verify-program.mjs"
```

You should see: `RESULT: the program is live, byte for byte the reviewed build, and only the vault can change it.`

**Step 2. Record the notice.** (It reads mvp-launch's history on GitHub.)

```powershell
node "{{PACK}}\scripts\5-record-notice.mjs"
```

It counts only merges to mvp-launch made after this folder was staged ({{STAGED}}). The notice line
was merged before that, so until one more merge lands the step says
`UNREAD: the line is on mvp-launch's newest commit <COMMIT>, older than this folder (<TIME>): stop and ask`.
That is expected: tell a session, which times a merge. After it you should see:
`PASS    : recorded: first seen public at <TIME> by the network's clock; the notice runs from <TIME>, so the fee tiers may execute from {{NOTICE_WHEN_SCRIPT}}, not before`
(or a later time, if this step first sees the notice after {{NOTICE_WHEN}}).

Run this step again within the hour before step 4: the page wants a fresh check. It reads every
merge to mvp-launch since this folder was made: while the newest one lacks the line, the page
stops, and if a merge ever drops it, the notice starts again from the merge that brings it back. So
leave the line where it is.

**Step 3. Read the page.** Leave this window open until the end of the sitting.

```powershell
node "{{PACK}}\proposer\serve.mjs"
```

You should see: `Fee-tier page (MAINNET: real money): http://127.0.0.1:{{PORT}}/   (Ctrl+C to stop)`.
If the port is in use, the old folder's page is still running: stop it (Ctrl+C in its window) and
run this again.

Open **http://127.0.0.1:{{PORT}}/** in the browser that has your wallet. The bar at the top says
**MAINNET: real money**. Use ONE tab of this page. Click **Connect a member wallet** and choose
either member.

Until the lock ends you see `#19 has both approvals. The time lock holds it until 2026-10-23T13:45:21Z by the network's clock`.
After that, until {{NOTICE_WHEN}}, you see `the tiers may execute from {{NOTICE_WHEN_PAGE}} (the date the notice names), by the network's clock`.
Stop the page (Ctrl+C in its window).

# SITTING 2: THE EXECUTE (from {{NOTICE_WHEN}})

**Step 4.** Run step 2 again, then start the page as in step 3, and connect either member.

You should see: `OK: the fee notice is public and the date the notice names ({{NOTICE_WHEN_PAGE}}) has passed`
and the button **EXECUTE proposal #19**. If instead it names a later time, come back then.

Click **EXECUTE proposal #19** and approve in your wallet. (The vault pays the tiers' {{TIERS_SOL}} SOL.)

You should see: `Done: proposal #19 is EXECUTED. Run 6-verify-tiers.mjs.`

**Step 5. Check the tiers.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\6-verify-tiers.mjs"
```

You should see, for each tier, a `PASS` line with its fee, its price steps, the vault as owner and
the Workshop as the fund's owner, and
`RESULT: both fee tiers are live with the island split. Anyone may now open a range pool on them.`

Tell a session. The website then opens range pools (its own pull requests, each with your word), and
the address registry's two tier rows become "live".

## If a step does not go as written

- **A line says `REFUSED`.** Nothing was sent by that step. Do what the line says. Never work around it.
- **A line says `NOT KNOWN` or `UNREAD`.** Something did not answer, or (step 2, before the next merge)
  the notice cannot be counted yet. That is not a pass and not a fault. Read the line; run the same
  step again later.
- **A script says `STOPPED: this folder is not as it was staged`.** A file in this folder was changed
  or added. Do not go on: ask a session.
- **The page shows a red `STOP` line.** There is no button. Read the line. A proposal made outside
  this page that touches the range program is never approved: an Active one is rejected by one
  member in the Squads app, an Approved one cancelled by both (that can only stop it); then the
  page goes on.
- **The page offers "Approve proposal #N" instead.** That proposal lacks an approval, so it is not
  #19. Ask a session first.
- **Anything else.** Stop, and paste what you see to a session.

## What the rehearsal covered, and what it could not

{{REHEARSAL}}

The rehearsal ran with a notice counted in days. The hold to the date the notice names is covered by
`solana/clmm-deploy/test/notice-gate.test.mjs` and `frontend/src/test/clmmTierGate.test.ts` in the
repo, not by the rehearsal, and by this folder's own code read against mainnet when it was staged:
the lock first, then that date, every other check still in force.

## What is in this folder

| File | What it is |
|---|---|
| `START-HERE.md` | this paper |
| `{{BINARY_FILE_WIN}}` | the deployed program file, kept so the checks can compare (sha256 `{{SHA256}}`) |
| `scripts\4-verify-program.mjs` | step 1 |
| `scripts\5-record-notice.mjs` | steps 2 and 4 |
| `scripts\6-verify-tiers.mjs` | step 5 |
| `scripts\lib\` | what the scripts and the page share |
| `proposer\` | the local page of steps 3 and 4 (it holds no key; your wallet signs) |
| `config.json` | every pinned value, read from the repo and the chain when this folder was made |
| `SHA256SUMS` | the fingerprint of every file here (the scripts check them before they run) |
| `owner-run\` | what your steps write: the notice record |
