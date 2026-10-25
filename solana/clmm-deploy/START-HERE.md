# Start here: deploy the range program, and its fee tier

Staged {{STAGED}} from commit `{{COMMIT}}`, for {{FOR}}. Nothing in this folder has been sent
anywhere. You are the only one who signs. All times are UTC.

**Approve or execute the fee-tier proposal only on this folder's page (steps 12 to 16). Never in
the Squads app or any other tool.** The page reads the proposal's stored instructions back from the
chain and refuses one that differs from the decided tiers by a single byte. The Squads app does not.

## What this does

Range pools run on their own program: the venue's copy of Raydium's range-pool program, with every
admin power held by the vault and none by Raydium. This folder puts it on mainnet and gives it its
one fee tier.

| | |
|---|---|
| The program's address | `{{PROGRAM_ID}}` (private until step 8 sends it: anyone who knew it earlier could block it) |
| The one program file | `{{BINARY_FILE}}`, {{BYTES}} bytes, sha256 `{{SHA256}}` (two separate builds, byte for byte the same) |
| Who can change it after the deploy | only the vault, `{{VAULT}}`: two approvals, then 48 hours |

The fee tier, as you decided on 2026-10-25 (docs/RANGE_POOLS_PLAN.md in the repo): one, 1%.

| Tier | Fee of each swap | Price steps (tick spacing) | LPs whose range is in use keep | The venue (the vault) | The island (Workshop `{{WORKSHOP}}`) |
|---|---|---|---|---|---|
| 0 | 1% | 120 | 0.84% | 0.104% | 0.056% |

How money moves once pools are open: an LP earns 84% of the fee of every swap that trades through
their range. The venue's 10.4% collects in the pool and only the vault can take it out. The island's
5.6% collects too, and only the Workshop can take it out. **The vault can still move it**: one
proposal (two approvals and 48 hours) can point the island's share at another account, the vault
included, and collect it there. No tier can charge more than 4% of a swap, or give the venue and the
island more than 16% of each fee together. When a swap fills a limit order where no LP's range is in
use, the LPs' 84% goes to the venue instead. Nobody pays anything to Raydium, ever. What else the
vault can do is listed in `docs/RANGE_POOLS_PLAN.md` ("What else the vault can still do").

## The sittings

| Sitting | When | What happens | Who signs |
|---|---|---|---|
| 1 | done | the program's key (the key folder) | nobody |
| 2 | any day | the devnet practice run, in its own folder: `{{DEVNET_PACK}}` | the paying wallet, on devnet |
| **3** | after sitting 2 went as written | **the deploy**: upload, deploy, hand-over to the vault. About one hour | the paying wallet |
| **4** | once the position link is live | **the notice and the proposal**: the changelog line goes public, member A proposes | member A |
| **5** | from 48 hours before the notice's date | **the second approval**: it starts the vault's 48-hour lock | member B |
| **6** | from {{NOTICE_WHEN}}, and 48 hours after sitting 5 (the page names the minute) | **the execute**: the fee tier is made | either member |

Why this date: the notice tells everyone, in the public changelog, what the fee will be and from
when: {{NOTICE_WHEN}}. This page holds the execute until that date or the chain's lock, whichever is
later. Any other tool could execute the proposal from the lock's end, so execute it only on this
page. #19, the two-tier proposal made before you ruled one tier, is cancelled by both members first:
the page refuses to go on while it can still execute.

**The pool pack shares two things with this folder.** It pays from the same wallet (see the money,
below), and its proposals are numbered #15 to #18 in its paper. Make the tier proposal (sitting 4)
only after the pool pack's Day 0 proposals exist, or tell a session first: the numbers would shift.

## What happens between sittings, without you

- **Before sitting 3**: a session puts the program's address into the code on this computer only,
  builds it twice in two fresh copies, and stages this folder. Nothing is published.
- **Right after sitting 3**: the session publishes that change (one pull request). The repo's checks
  build the program again and must get the very same bytes as the program now on chain
  (`solana/clmm-deploy/ci-matches-chain.mjs`). Then the website's range-pool pull requests take the
  address, the position link (#912) first. Every range position is an NFT whose link points at
  `https://memetics.finance/position/...`, and a wallet keeps that link for good, so the page
  refuses to approve or execute the tiers until that link answers for this program. Each merge
  needs your word.

## What it costs, and which wallet pays

Prices are mainnet's, read when this folder was staged ({{STAGED_DAY}}). Step 3 reads them again on the day.

| What | SOL | Who pays | Comes back? |
|---|---|---|---|
| The program's data, exact size | {{DATA_SOL}} | the paying wallet | Never: locked in the program for as long as it lives |
| The program account | {{PROG_SOL}} | the paying wallet | Never |
| The upload buffer | {{BUFFER_SOL}} | the paying wallet | Inside the deploy itself: the loader moves it into the program's data |
| Network fees (about 1,500 upload transactions) | about {{FEES_SOL}} | the paying wallet | Never |
| The tier proposal | {{MEMBER_A_SOL}} | member A | Never |
| Approve and execute | 0.00002 | member B, then either | Never |
| The fee tier | {{TIERS_SOL}} | the vault | Never: locked in the tier account |

**The paying wallet needs {{NEED_PAYER}} SOL for this deploy.** It never needs two buffers' worth:
the deploy moves the buffer's SOL into the program's data in the same step (the rehearsal measured
this; see the end of this paper). About {{SPENT_SOL}} SOL is spent for good.

**If the pool pack's Day 0 has not run yet, its {{POOL_PEAK}} SOL must be in the wallet too**: send
this deploy's {{NEED_PAYER}} on top of it, never counting the pool pack's SOL as this deploy's. Step 3
works this out by itself: it sets the pool pack's SOL aside until that pack's two buffers are parked
with the vault.

The wallets:

- **The paying wallet** is the deploy wallet, `{{PAYER}}`. Its key file is `{{PAYER_KEY}}` (the
  pool pack's paper names the same file). No script opens it: they hand its path to your Solana
  tool, which signs.
- **Member A** is `{{MEMBER_A}}`. Step 3 says whether it holds enough for the proposal; if it
  refuses, send member A 0.02 SOL and run step 3 again.
- **Member B** is `{{MEMBER_B}}`. It needs almost nothing.
- **The vault**, `{{VAULT}}`, pays the tier's rent. Step 3 checks it holds it.

Later, and not in this folder: before any pool can carry a reward (a second stream of tokens to
its LPs), the vault pays {{OP_SOL}} SOL once for the program's operation account. That is a
proposal of its own.

## The steps

Do them in order. Each step is one action. If what you see is not what the step says, stop and
read "If a step does not go as written" below.

Every command is for Windows PowerShell. Copy the whole line. Where a line says `<BUFFER ADDRESS>`,
put that address in its place, without the angle brackets.

# SITTING 3: THE DEPLOY (real money)

**Step 1. Send the paying wallet {{NEED_PAYER}} SOL** (on top of the pool pack's {{POOL_PEAK}} SOL if
its Day 0 has not run). From any wallet you control. Send a tiny test amount first, see it arrive,
then the rest. The paying wallet is `{{PAYER}}`.

**Step 2. Check the key file is the paying wallet's.** (Nobody signs. It prints an address and nothing secret.)

```powershell
& "{{SOLANA}}" address -k "{{PAYER_KEY}}"
```

You should see: `{{PAYER}}`. If you see another address, stop.

**Step 3. Run the check before anything is spent.** (Nobody signs. It only reads.)

```powershell
node "{{PACK}}\scripts\1-preflight.mjs"
```

You should see: lines that start with `PASS` or `note`, among them
`PASS    : the devnet practice run is done: ...` (sitting 2, read from devnet itself),
`PASS    : {{PROGRAM_ID}} has no account yet: nothing is deployed there`,
`PASS    : its data address ... holds nothing on mainnet`,
`PASS    : the paying wallet holds ... SOL; the deploy needs ... SOL at its peak`,
`PASS    : 2 approvals of 2 members: member A {{MEMBER_A}} and member B {{MEMBER_B}}`,
`PASS    : a time lock of 172,800 seconds (48 hours)`, and at the end
`RESULT: every line passed. Go on to the next step in START-HERE.md.`

If any line starts with `REFUSED`, do what it says and run this step again.

**Step 4. Make a one-time key file for the buffer, and print its address.** (Nobody signs.)

```powershell
& "{{KEYGEN}}" new --no-bip39-passphrase --silent --outfile "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}"
```

```powershell
& "{{SOLANA}}" address -k "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}"
```

You should see: `Wrote new keypair to` and that path, then the address. That is your **BUFFER
ADDRESS**. Copy it somewhere. If the first command says `Refusing to overwrite`, the key file is
already there: do not add `--force`, just run the second command.

**Step 5. Upload.** (The paying wallet signs. This parks {{BUFFER_SOL}} SOL in the buffer, which the
deploy then moves into the program.) It takes several minutes and sends about 1,500 small transactions.

```powershell
& "{{SOLANA}}" program write-buffer "{{PACK}}\{{BINARY_FILE_WIN}}" --buffer "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}" --buffer-authority "{{PAYER_KEY}}" --keypair "{{PAYER_KEY}}" --with-compute-unit-price {{CU_PRICE}} --url {{MAINNET_RPC}}
```

You should see: `Buffer:` and your BUFFER ADDRESS. If it stops half way, run the very same command
again: it carries on where it stopped.

**Step 6. Check the upload.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\2-verify-buffer.mjs" --buffer <BUFFER ADDRESS>
```

You should see: `PASS    : the buffer holds {{BYTES}} bytes, byte for byte the reviewed build (sha256 {{SHA256}})`,
`PASS    : its authority is the paying wallet {{PAYER}}: nobody else can use or close it`, and
`RESULT: every line passed. This buffer may be deployed.`

Until step 8 the paying wallet can take the buffer's SOL back alone (see "If a step does not go
as written").

**Step 7. The deploy, as a dry run.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\3-deploy.mjs" --buffer <BUFFER ADDRESS>
```

You should see: `RESULT: the dry run passed. Run the same command with --send to deploy.`

**Step 8. The deploy, and at once the hand-over to the vault.** (The paying wallet signs. This
locks {{DATA_SOL}} SOL in the program for good.) Run it in one window only, and wait until it has
finished.

```powershell
node "{{PACK}}\scripts\3-deploy.mjs" --buffer <BUFFER ADDRESS> --send
```

You should see, in this order: `running, once:  solana.exe program deploy`, then
`Program Id: {{PROGRAM_ID}}`, then `PASS    : DEPLOYED: the program's code is byte for byte the build`,
`PASS    : exact size: the data account is {{DATA_BYTES}} bytes, no spare room`, then
`running, once:  solana.exe program set-upgrade-authority`, then
`PASS    : HANDED OVER: the upgrade authority is the vault {{VAULT}}`, and at the end
`RESULT: the program is deployed and the vault holds it.`

For the few seconds between the deploy and the hand-over the paying wallet alone could change the
program. The script does both in one run for that reason, and runs the hand-over even if it could
not read the program back. If the last lines say the hand-over is not confirmed, run the one command
they print.

**Step 9. Check the program.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\4-verify-program.mjs"
```

You should see: `PASS    : its upgrade authority is the vault {{VAULT}}`,
`PASS    : the vault may make a fee tier: the program's admin is the vault`,
`PASS    : a fee tier asked for by <ADDRESS>, who is not the vault, is refused by the program (NotApproved): only the vault can make one`, and
`RESULT: the program is live, byte for byte the reviewed build, and only the vault can change it.`

Tell a session: the program is deployed. From here it is live but has no fee tier, so nobody can
open a pool on it yet.

# SITTING 4: THE NOTICE AND THE PROPOSAL (once the position link is live)

**Step 10. Make the notice public.**

1. Tell a session: "open the fee notice pull request". It adds exactly this one line under today's
   UTC date in `CHANGELOG.md` (adding that day's heading if it is not there), and nothing else:

   `{{NOTICE_LINE}}`

2. When its checks are green, give your word to merge it.

**Step 11. Record the notice.** (Nobody signs. It reads mvp-launch's history on GitHub.)

```powershell
node "{{PACK}}\scripts\5-record-notice.mjs"
```

You should see: `PASS    : recorded: first seen public at <TIME> by the network's clock; the notice runs from <TIME>, so the fee tiers may execute from <TIME>, not before`. That time is {{NOTICE_WHEN}}, or the time the line went public if that came later.

Run this step again within the hour before steps 14 and 15: the page wants a fresh check. It looks
at every merge to mvp-launch since the notice: if one of them ever lacked the line, the notice starts
again from the merge that brought it back, and the execute waits for that time if it comes after
{{NOTICE_WHEN}}. So leave the line where it is.

**Step 12. Start the page.** (Nobody signs.) Leave this window open until the end of the sitting.

```powershell
node "{{PACK}}\proposer\serve.mjs"
```

You should see: `Fee-tier page (MAINNET: real money): http://127.0.0.1:{{PORT}}/   (Ctrl+C to stop)`

Open **http://127.0.0.1:{{PORT}}/** in the browser that has your wallet. The bar at the top says
**MAINNET: real money**. Use ONE tab of this page.

**Step 13. Member A proposes.** (Member A signs. It costs member A {{MEMBER_A_SOL}} SOL.)

1. Click **Connect a member wallet** and choose member A.
2. Read the table: one tier, 1% with 120 price steps, the shares as in the table at the top of this
   paper.

You should see: every line under "Checks" starting with `OK`, and **Ready.** with the button
**Sign: create the tier proposal and approve it**.

3. Click it and approve the one transaction in your wallet.

You should see: `Done: proposal #N is created and you approved it.` (N is the next proposal number;
the page always shows the right one.) Stop the page (Ctrl+C in its window).

# SITTING 5: THE SECOND APPROVAL (48 hours before the notice's date at the earliest)

**Step 14.** Run step 11 again, then step 12, then:

1. Click **Connect a member wallet** and choose member B. The page shows the connected address. If
   it shows member A, switch the account inside your wallet, click **Disconnect / switch wallet**,
   then **Connect a member wallet** again.

If it is still too early you see `#N waits for your approval from <TIME> by the network's clock`:
come back then. Otherwise you see
`OK: #N is this page's proposal, waiting for your approval. Yours is the last one needed: it starts the 48-hour time lock`
and the button **Approve proposal #N**.

2. Click it and approve in your wallet.

You should see: `Done: you approved proposal #N.`, then after **Check again**:
`#N has both approvals. The time lock holds it until <TIME> by the network's clock`. Stop the page.

# SITTING 6: THE EXECUTE (from {{NOTICE_WHEN}}, and 48 hours after the second approval)

**Step 15.** Run step 11 again, then step 12, and connect either member.

You should see: `OK: the fee notice is public and the date the notice names (<TIME>) has passed` and the button
**EXECUTE proposal #N**. If instead it names a later time, come back then.

Click **EXECUTE proposal #N** and approve in your wallet. (The vault pays the tier's {{TIERS_SOL}} SOL.)

You should see: `Done: proposal #N is EXECUTED. Run 6-verify-tiers.mjs.`

**Step 16. Check the tier.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\6-verify-tiers.mjs"
```

You should see a `PASS` line for tier 0 with its fee, its price steps, the vault as owner and the
Workshop as the fund's owner, then `PASS    : the program owns no other fee tier (1 account of a tier's size)`,
and `RESULT: the fee tier is live with the island split, and it is the only one. Anyone may now open a range pool on it.`

Tell a session. The website then opens range pools (its own pull requests, each with your word).

## If a step does not go as written

- **A line says `REFUSED`.** Nothing was sent by that step. Do what the line says. Never work around it.
- **A line says `NOT KNOWN` or `UNREAD`.** The network did not answer. That is not a pass and not a
  fault. Run the same step again in a minute.
- **A script says `STOPPED: this folder is not as it was staged`.** A file in this folder was changed
  or added. Do not go on: ask a session.
- **Step 3 says the program's data address already holds SOL.** Someone learned the address and
  blocked it. Nothing is lost: do not upload. A session makes a new key folder, and the program is
  rebuilt for a new address.
- **The upload stopped half way.** Run the same upload command again. Then the check again.
- **You want to give up the deploy after the upload** (before step 8), to take the buffer's SOL back.
  This closes only a buffer of exactly this program file, held by the paying wallet, and sends its
  SOL only to the paying wallet. It refuses any other buffer (the pool pack's included). First as a
  dry run, then with `--send`:

```powershell
node "{{PACK}}\scripts\7-close-buffer.mjs" --buffer <BUFFER ADDRESS>
```

```powershell
node "{{PACK}}\scripts\7-close-buffer.mjs" --buffer <BUFFER ADDRESS> --send
```

  Never type `solana program close` yourself, and never with `--buffers`: that closes every buffer
  the wallet holds, the pool pack's too.
- **Step 8 said the deploy worked but the hand-over is not confirmed.** Run at once:

```powershell
node "{{PACK}}\scripts\3-deploy.mjs" --handover-only --send
```

- **Step 8 says `ALREADY RUNNING in another window`.** Look at the other window. If none is open,
  run step 9 to see where things are, then ask a session before deleting the lock file it names.
- **The page shows a red `STOP` line.** There is no button. Read the line. A proposal made outside
  this page that touches the range program is never approved: an Active one is rejected by one
  member in the Squads app, an Approved one cancelled by both (that can only stop it); then the
  page goes on.
- **Anything else.** Stop, and paste what you see to a session.

## What the rehearsal covered, and what it could not

{{REHEARSAL}}

## What is in this folder

| File | What it is |
|---|---|
| `START-HERE.md` | this paper |
| `{{BINARY_FILE_WIN}}` | the one program file to deploy (sha256 `{{SHA256}}`) |
| `scripts\1-preflight.mjs` | step 3: the check before anything is spent |
| `scripts\2-verify-buffer.mjs` | step 6: the upload is byte for byte the program file |
| `scripts\3-deploy.mjs` | steps 7 and 8: the deploy and the hand-over (sends only with `--send`) |
| `scripts\4-verify-program.mjs` | step 9 |
| `scripts\5-record-notice.mjs` | step 11 |
| `scripts\6-verify-tiers.mjs` | step 16 |
| `scripts\7-close-buffer.mjs` | only if the deploy is given up after the upload |
| `scripts\0-program-key.mjs` | sitting 1's key check, kept here |
| `scripts\lib\` | what the scripts and the page share |
| `proposer\` | the local page of steps 12 to 15 (it holds no key; your wallet signs) |
| `config.json` | every pinned value, read from the repo and the chain when this folder was made |
| `SHA256SUMS` | the fingerprint of every file here (the scripts check them before they run) |
| `owner-run\` | what your steps write: the buffer key file, the notice record |
