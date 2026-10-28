# Start here: range fee tier {{TIER}}, from {{FEE_FROM}} to {{FEE_TO}}

Staged {{STAGED}} from commit `{{COMMIT}}`, for {{FOR}}. Nothing in this folder has been sent
anywhere. You are the only one who signs. All times are UTC.

**Propose, approve and execute only on this folder's page. Never in the Squads app or any other
tool.** The page reads the proposal's stored instructions back from the chain and refuses one that
differs by a single byte from the one change below. Use ONE tab of the page. Before every press,
read the proposal number on the button and check it is the number you wrote down in step 2.

## What it does

One vault proposal with one instruction: fee tier {{TIER}} (`{{TIER_ADDRESS}}`) charges
{{FEE_TO}} of each swap instead of {{FEE_FROM}}. Nothing else changes: its price steps stay
{{SPACING}}, its split stays the island split, its owner stays the vault and its fund owner the
Workshop `{{WORKSHOP}}`. Tier {{OTHER_TIER}} (`{{OTHER_TIER_ADDRESS}}`, already 1%) is not touched.

| Tier {{TIER}} | Fee of each swap | LPs whose range is in use keep | The venue (the vault) | The island (Workshop) |
|---|---|---|---|---|
| Now | {{FEE_FROM}} | {{LP_FROM}} | {{VENUE_FROM}} | {{ISLAND_FROM}} |
| After | {{FEE_TO}} | {{LP_TO}} | {{VENUE_TO}} | {{ISLAND_TO}} |

How money moves after it: an LP earns 84% of the fee of every swap that trades through their range.
The venue's 10.4% of each fee collects in the pool and only the vault can take it out; the island's
5.6% collects too, and only the Workshop can take it out. Nobody pays anything to Raydium. The new
fee applies to every pool on the tier and to every position already in them.

Why: you ruled one tier of 1% on 2026-10-25. Proposal #19, executed 2026-10-27, made a 0.25% tier
too, and no instruction removes a tier. The website already never lists a pool on tier {{TIER}} or
routes a swap into one. After this, no range pool on our program charges 0.25%.

Who pays: member A pays about {{MEMBER_A_SOL}} SOL for the proposal's two accounts, plus network
fees; member B and whoever executes pay only network fees. The vault pays nothing.

## Where things stand

| | |
|---|---|
| The program | `{{PROGRAM_ID}}`, deployed in slot {{DEPLOYED_SLOT}}: byte for byte the build this folder was made against, sha256 `{{SHA256}}` ({{BYTES}} bytes). If it is upgraded before you execute (for example the opening-fee upgrade), the page stops and a session restages this folder |
| Who can change a tier | only the vault, `{{VAULT}}`: two approvals, then 48 hours |
| The members | A `{{MEMBER_A}}`, B `{{MEMBER_B}}` |
| The next proposal | #{{NEXT_INDEX}} when this folder was made. The page reads the real number when you propose: write down the one it shows |

## The sittings

| Sitting | When | What happens | Who signs |
|---|---|---|---|
| 1 | now | start the page; member A proposes and approves | member A |
| 2 | any time after | member B approves: the 48 hours start | member B |
| 3 | 48 hours after member B's approval | the execute, then the check | either member |

## The steps

Do them in order. If what you see is not what the step says, stop and read "If a step does not go
as written" below.

# SITTING 1: PROPOSE (member A signs)

**Step 1. Start the page.** Leave this window open until the end of the sitting.

```powershell
node "{{PACK}}\proposer\serve.mjs"
```

You should see: `Fee-tier page (MAINNET: real money): http://127.0.0.1:{{PORT}}/   (Ctrl+C to stop)`.
If the port is in use, another copy of this page is still running: stop it (Ctrl+C in its window)
and run this again.

Open **http://127.0.0.1:{{PORT}}/** in the browser that has your member wallets. The bar at the top
says **MAINNET: real money** and the title says **Range pools: fee tier {{TIER}}, from {{FEE_FROM}} to {{FEE_TO}}**.

**Step 2. Member A proposes.** Click **Connect a member wallet** and choose member A
(`{{MEMBER_A}}`). Every line under Checks says `OK`, and the last one says
`no fee proposal yet: #N will be created, with your approval`. **Write down N.**

Click **Sign: create the fee proposal and approve it**. Check your wallet shows member A, then
approve.

You should see: `Done: proposal #N is created and you approved it.`

# SITTING 2: APPROVE (member B signs; it starts the 48 hours)

**Step 3. Member B approves.** Start the page as in step 1 if it is not running. Click
**Disconnect / switch wallet**, switch your wallet to member B (`{{MEMBER_B}}`), and click
**Connect a member wallet**. The last line says
`#N is this page's proposal, waiting for your approval. Yours is the last one needed: it starts the 48-hour time lock`.

Read the button: **Approve proposal #N**. N must be the number you wrote down. Click it, check your
wallet shows member B, and approve.

You should see: `Done: you approved proposal #N.` Then the page says
`#N has both approvals. The time lock holds it until <TIME> by the network's clock`.
**Write down that time.** Stop the page (Ctrl+C in its window).

# SITTING 3: THE EXECUTE (from the time you wrote down)

**Step 4. Execute.** Start the page as in step 1 and connect either member. The last line says
`approved at <TIME>; the time lock was over at <TIME>` and the button reads
**EXECUTE proposal #N**. Read N, click it, and approve in your wallet.

You should see: `Done: proposal #N is EXECUTED. Run 8-verify-tier-fee.mjs.`

**Step 5. Check the change.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\8-verify-tier-fee.mjs"
```

You should see a `PASS` line for each tier and
`RESULT: tier {{TIER}} charges {{FEE_TO}} now, with the same split and owners, and the other tier is unchanged.`

Tell a session. The address registry's tier {{TIER}} row then says {{FEE_TO}} (its daily chain read
checks every rate of the tier and turns red until it does).

## If a step does not go as written

- **The page shows a red `STOP` line.** There is no button. Read the line. A proposal made outside
  this page that touches the range program or a tier is never approved: an Active one is rejected
  by one member in the Squads app, an Approved one cancelled by both (that can only stop it); then
  the page goes on.
- **The button names another number than the one you wrote down.** Do not press it. Ask a session.
- **The page offers "Sign: create the fee proposal" again after step 2.** Your proposal is not live
  any more (rejected or cancelled). Ask a session before proposing again.
- **A line says the program is not the build this folder was made against.** The program was
  upgraded. Nothing is wrong with the chain: a session restages this folder. Do not use this one.
- **A script says `STOPPED: this folder is not as it was staged`.** A file in this folder was changed
  or added. Do not go on: ask a session.
- **A line says `NOT KNOWN` or `UNREAD`.** Something did not answer. That is not a pass and not a
  fault. Check again later.
- **Anything else.** Stop, and paste what you see to a session.

## What the rehearsal covered, and what it could not

{{REHEARSAL}}

## What is in this folder

| File | What it is |
|---|---|
| `START-HERE.md` | this paper |
| `{{BINARY_FILE_WIN}}` | the deployed program file, kept so the checks can compare (sha256 `{{SHA256}}`) |
| `scripts\8-verify-tier-fee.mjs` | step 5 |
| `scripts\lib\` | what the script and the page share |
| `proposer\` | the local page of steps 1 to 4 (it holds no key; your wallet signs) |
| `config.json` | every pinned value, read from the repo and the chain when this folder was made |
| `SHA256SUMS` | the fingerprint of every file here (the script and the page check them before they run) |
| `owner-run\` | empty: nothing in these steps writes a file |
