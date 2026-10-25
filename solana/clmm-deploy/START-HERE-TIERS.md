# Start here: the range program's one fee tier

Staged {{STAGED}} from commit `{{COMMIT}}`, for {{FOR}}. Nothing in this folder has been sent
anywhere. You are the only one who signs. All times are UTC.

**Approve and execute the new fee-tier proposal only on this folder's page. Never in the Squads app
or any other tool.** The page reads the proposal's stored instructions back from the chain and
refuses one that differs from the decided tier by a single byte, and it holds the execute until the
notice is public. The Squads app does neither. The one thing you do in the Squads app is sitting 1:
cancel #19.

## Where things stand

| | |
|---|---|
| The program's key, the devnet practice run and the deploy | **done**, in the earlier folders. The deploy's folder is `{{MAINNET_PACK}}`; its page and the first tiers folder's page are retired: use this one |
| The program | `{{PROGRAM_ID}}`, deployed in slot {{DEPLOYED_SLOT}}. Its address is public since the deploy |
| Its one build | `{{BINARY_FILE}}`, {{BYTES}} bytes, sha256 `{{SHA256}}`. The repo's CI rebuilt the very same bytes |
| Who can change it | only the vault, `{{VAULT}}` (multisig `{{MULTISIG}}`): two approvals, then 48 hours |
| The old fee-tier proposal | **#19 makes two tiers, 1% and 0.25%.** It has both approvals since 2026-10-21 and its lock ended 2026-10-23 13:45:21, so any member could execute it in the Squads app now. You ruled one tier on 2026-10-25: #19 must never execute. Sitting 1 cancels it |
| The fee notice on mvp-launch | `{{NOTICE_LINE}}`. It goes public with the pull request that made this folder |
| The earliest execute | 48 hours after the second approval (sitting 3), and never before the notice is public |

The fee tier, as you decided on 2026-10-25 ("there should only be one fee tier that is 1%"):

| Tier | Fee of each swap | Price steps (tick spacing) | LPs whose range is in use keep | The venue (the vault) | The island (Workshop `{{WORKSHOP}}`) |
|---|---|---|---|---|---|
| 0 | 1% | 120 | 0.84% | 0.104% | 0.056% |

How money moves once pools are open: an LP earns 84% of the fee of every swap that trades through
their range. The venue's 10.4% collects in the pool and only the vault can take it out. The island's
5.6% collects too, and only the Workshop can take it out. **The vault can still move it**: one
proposal (two approvals and 48 hours) can point the island's share at another account, the vault
included, and collect it there. No tier can charge more than 4% of a swap, or give the venue and the
island more than 16% of each fee together. When a swap fills a limit order where no LP's range is in
use, the LPs' 84% goes to the venue instead. Nobody pays anything to Raydium, ever.

The vault pays the tier's rent, {{TIERS_SOL}} SOL, locked in the tier account for good. The member who
proposes pays {{MEMBER_A_SOL}} SOL (the rent of the proposal's two accounts, which does not come
back), so let the member holding more SOL propose; the other one approves. Each cancel, the approval
and the execute cost about 0.00002 SOL in network fees.

## The sittings

| Sitting | When | What happens | Who signs |
|---|---|---|---|
| **1** | now, the sooner the better | **cancel #19**, in the Squads app | member A, then member B |
| **2** | after sitting 1 | check the program; **the new proposal**, on this page | one member, the one holding more SOL |
| **3** | after sitting 2, once the pull request that made this folder is merged | record the notice; **the second approval**, on this page: it starts the 48-hour lock | the other member |
| **4** | 48 hours after sitting 3 (the page names the minute) | **the execute**, on this page; then check the tier | either member |

## The steps

Do them in order. If what you see is not what the step says, stop and read "If a step does not go as
written" below.

# SITTING 1: CANCEL #19 (both members, in the Squads app)

A tier, once made, can never be removed, and #19 would make the 0.25% tier beside the 1% one. An
approved proposal of a 2-of-2 multisig ends only when both members cancel it, and until the second
cancel lands it can still be executed. So do steps 1 and 2 back to back, and never press Execute on
#19. A cancel can only stop a proposal: it moves no money.

**Step 1. Member A cancels #19.** Open **https://app.squads.so** in the browser that has your wallet,
connect member A (`{{MEMBER_A}}`) and open the multisig whose vault is `{{VAULT}}`. Under
Transactions, open **#19** and press **Cancel**; approve in your wallet.

Squads now counts one cancel of the two needed. #19 can still be executed until step 2.

**Step 2. Member B cancels #19** the same way, connected as member B (`{{MEMBER_B}}`).

You should see #19 marked **Cancelled**.

If the Squads app shows no Cancel for #19, or #19 says Executed, stop and tell a session.

# SITTING 2: THE NEW PROPOSAL (one member)

**Step 3. Check the program.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\4-verify-program.mjs"
```

You should see: `RESULT: the program is live, byte for byte the reviewed build, and only the vault can change it.`

**Step 4. Start the page.** (Nobody signs.) Leave this window open until the end of the sitting.

```powershell
node "{{PACK}}\proposer\serve.mjs"
```

You should see: `Fee-tier page (MAINNET: real money): http://127.0.0.1:{{PORT}}/   (Ctrl+C to stop)`.
If the port is in use, an older folder's page is still running: stop it (Ctrl+C in its window) and
run this again.

Open **http://127.0.0.1:{{PORT}}/** in the browser that has your wallet. The bar at the top says
**MAINNET: real money**. Use ONE tab of this page.

**Step 5. One member proposes.** (That member signs. It costs {{MEMBER_A_SOL}} SOL and the fee.)

1. Click **Connect a member wallet** and choose the member holding more SOL (member A is
   `{{MEMBER_A}}`, member B `{{MEMBER_B}}`).
2. Read the table: one tier, 1% with 120 price steps, the shares as in the table at the top of this
   paper.

You should see: every line under "Checks" starting with `OK`, and **Ready.** with the button
**Sign: create the tier proposal and approve it**. While #19 can still execute you see instead
`STOP: proposal #19 (Approved) touches the range program but is NOT this page's: never approve or execute it. Both members cancel it in the Squads app; then check again`:
go back to sitting 1.

3. Click it and approve the one transaction in your wallet.

You should see: `Done: proposal #N is created and you approved it.` N is the next proposal number:
#21 when this folder was made, or later if another proposal came first; the page always shows the
right one. Stop the page (Ctrl+C in its window).

# SITTING 3: THE SECOND APPROVAL (the other member, once the notice is public)

**Step 6. Record the notice.** (Nobody signs. It reads mvp-launch's history on GitHub.)

```powershell
node "{{PACK}}\scripts\5-record-notice.mjs"
```

The notice line comes with the pull request that made this folder. Until it is merged you see
`REFUSED : the line is NOT in CHANGELOG.md or docs/CHANGELOG_EARLIER.md at mvp-launch's newest commit`:
give your word to merge it, then run this again. After it you should see:
`PASS    : recorded: first seen public at <TIME> by the network's clock; the notice runs from <TIME>, so the fee tiers may execute from <TIME>, not before`.

Run this step again within the hour before steps 7 and 8: the page wants a fresh check. It reads every
merge to mvp-launch since this folder was made: while the newest one lacks the line, the page
stops, and if a merge ever drops it, the notice starts again from the merge that brings it back. So
leave the line where it is.

**Step 7. The other member approves.** Start the page as in step 4, then:

1. Click **Connect a member wallet** and choose the member who did not propose. The page shows the
   connected address. If it shows the one who proposed, switch the account inside your wallet, click
   **Disconnect / switch wallet**, then **Connect a member wallet** again.

You should see
`OK: #N is this page's proposal, waiting for your approval. Yours is the last one needed: it starts the 48-hour time lock`
and the button **Approve proposal #N**.

2. Click it and approve in your wallet.

You should see: `Done: you approved proposal #N.`, then after **Check again**:
`#N has both approvals. The time lock holds it until <TIME> by the network's clock`. Note that time.
Stop the page.

# SITTING 4: THE EXECUTE (from the time step 7 named)

**Step 8.** Run step 6 again, then start the page as in step 4, and connect either member.

You should see: `OK: the fee notice is public and` ... `has passed` and the button
**EXECUTE proposal #N**. If instead it names a later time, come back then.

Click **EXECUTE proposal #N** and approve in your wallet. (The vault pays the tier's {{TIERS_SOL}} SOL.)

You should see: `Done: proposal #N is EXECUTED. Run 6-verify-tiers.mjs.`

**Step 9. Check the tier.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\6-verify-tiers.mjs"
```

You should see a `PASS` line for tier 0 with its fee, its price steps, the vault as owner and the
Workshop as the fund's owner, then `PASS    : the program owns no other fee tier (1 account of a tier's size)`,
and `RESULT: the fee tier is live with the island split, and it is the only one. Anyone may now open a range pool on it.`

Tell a session. The website lists the tier once it exists (its own pull requests, each with your
word), and the address registry's tier row becomes "live".

## If a step does not go as written

- **A line says `REFUSED`.** Nothing was sent by that step. Do what the line says. Never work around it.
- **A line says `NOT KNOWN` or `UNREAD`.** Something did not answer. That is not a pass and not a
  fault. Read the line; run the same step again later.
- **A script says `STOPPED: this folder is not as it was staged`.** A file in this folder was changed
  or added. Do not go on: ask a session.
- **The page shows a red `STOP` line.** There is no button. Read the line. A proposal made outside
  this page that touches the range program is never approved: an Active one is rejected by one
  member in the Squads app, an Approved one cancelled by both (that can only stop it); then the
  page goes on.
- **#19 says Executed, or step 9 names a tier this pack does not make.** The 0.25% tier exists, and
  no instruction removes it. Stop and tell a session.
- **Anything else.** Stop, and paste what you see to a session.

## What the rehearsal covered, and what it could not

{{REHEARSAL}}

The rehearsal ran with a notice counted in days. The hold to the date the notice names is covered by
`solana/clmm-deploy/test/notice-gate.test.mjs` and `frontend/src/test/clmmTierGate.test.ts` in the
repo, not by the rehearsal, and by this folder's own code read against mainnet when it was staged:
the lock first, then that date, every other check still in force. The cancel of #19 was rehearsed
with a copy of #19 (the same two tiers, approved by both) and Squads' own cancel instruction, not
through the Squads app.

## What is in this folder

| File | What it is |
|---|---|
| `START-HERE.md` | this paper |
| `{{BINARY_FILE_WIN}}` | the deployed program file, kept so the checks can compare (sha256 `{{SHA256}}`) |
| `scripts\4-verify-program.mjs` | step 3 |
| `scripts\5-record-notice.mjs` | steps 6 and 8 |
| `scripts\6-verify-tiers.mjs` | step 9 |
| `scripts\lib\` | what the scripts and the page share |
| `proposer\` | the local page of steps 4, 5, 7 and 8 (it holds no key; your wallet signs) |
| `config.json` | every pinned value, read from the repo and the chain when this folder was made |
| `SHA256SUMS` | the fingerprint of every file here (the scripts check them before they run) |
| `owner-run\` | what your steps write: the notice record |
