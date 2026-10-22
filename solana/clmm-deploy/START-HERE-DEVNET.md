# Start here: the devnet practice run of the range-program deploy

Staged {{STAGED}} from commit `{{COMMIT}}`, for {{FOR}}. About 45 minutes. No real money.

Devnet is Solana's practice network: its SOL is free and worth nothing. This folder is the mainnet
deploy step for step, with the same scripts, your own Solana tool and the same paying wallet's key
file, so that anything wrong shows up here first. Two things differ, on purpose:

- **The address is a throwaway one**, `{{PROGRAM_ID}}`, and the program file was built for it. The
  real address stays private until the mainnet deploy: anyone who learned it early could block it.
- **There are no fee tiers here.** The vault's multisig does not exist on devnet. The program is
  handed to the vault's address all the same; on devnet nobody can sign for it, so it stays as it is.

Every command is for Windows PowerShell. Copy the whole line. Where a line says `<BUFFER ADDRESS>`,
put that address in its place, without the angle brackets.

**Step 1. Get {{NEED_PAYER}} devnet SOL for the paying wallet.** Open https://faucet.solana.com,
choose **devnet**, and put in the paying wallet's address `{{PAYER}}`. Ask as many times as it lets
you until the wallet holds {{NEED_PAYER}} SOL (the faucet may ask you to sign in with GitHub, and
limits how often you ask). If it stops giving, step 2 says how much is still missing: ask again
later, or ask a session. Never send real SOL for this.

**Step 2. Run the check.** (Nobody signs. It only reads.)

```powershell
node "{{PACK}}\scripts\1-preflight.mjs"
```

You should see: lines that start with `PASS` or `note`, among them
`PASS    : {{BINARY_FILE}}: {{BYTES}} bytes, sha256 {{SHA256}}` and
`PASS    : {{PROGRAM_ID}} has no account yet: nothing is deployed there`, and at the end
`RESULT: every line passed. Go on to the next step in START-HERE.md.`

**Step 3. Make a one-time key file for the buffer, and print its address.** (Nobody signs.)

```powershell
& "{{KEYGEN}}" new --no-bip39-passphrase --silent --outfile "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}"
```

```powershell
& "{{SOLANA}}" address -k "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}"
```

You should see: `Wrote new keypair to` and that path, then the address. That is your **BUFFER
ADDRESS**. If the first command says `Refusing to overwrite`, the key file is already there: do not
add `--force`, just run the second command.

**Step 4. Upload.** (The paying wallet signs, on devnet.) It takes several minutes and sends about
1,500 small transactions.

```powershell
& "{{SOLANA}}" program write-buffer "{{PACK}}\{{BINARY_FILE_WIN}}" --buffer "{{PACK}}\owner-run\{{BUFFER_KEY_FILE}}" --buffer-authority "{{PAYER_KEY}}" --keypair "{{PAYER_KEY}}" --with-compute-unit-price {{CU_PRICE}} --url https://api.devnet.solana.com
```

You should see: `Buffer:` and your BUFFER ADDRESS. If it stops half way, run the very same command
again: it carries on.

**Step 5. Check the upload.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\2-verify-buffer.mjs" --buffer <BUFFER ADDRESS>
```

You should see: `PASS    : the buffer holds {{BYTES}} bytes, byte for byte the reviewed build (sha256 {{SHA256}})`
and `RESULT: every line passed. This buffer may be deployed.` If it says `THE UPLOAD IS NOT
FINISHED`, run step 4 again, then this step again.

**Step 6. The deploy, as a dry run.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\3-deploy.mjs" --buffer <BUFFER ADDRESS>
```

You should see: `RESULT: the dry run passed. Run the same command with --send to deploy.`

**Step 7. The deploy, and the hand-over.** (The paying wallet signs, on devnet.) One window only.

```powershell
node "{{PACK}}\scripts\3-deploy.mjs" --buffer <BUFFER ADDRESS> --send
```

You should see, in this order: `running, once:  solana.exe program deploy`, then
`Program Id: {{PROGRAM_ID}}`, then `PASS    : DEPLOYED: the program's code is byte for byte the build`,
`PASS    : exact size: the data account is {{DATA_BYTES}} bytes, no spare room`, then
`running, once:  solana.exe program set-upgrade-authority`, then
`PASS    : HANDED OVER: the upgrade authority is the vault {{VAULT}}`, and at the end
`RESULT: the program is deployed and the vault holds it.`

If the last lines say the hand-over is not confirmed, run the one command they print.

**Step 8. Check it.** (Nobody signs.)

```powershell
node "{{PACK}}\scripts\4-verify-program.mjs"
```

You should see: `RESULT: the program is live, byte for byte the reviewed build, and only the vault can change it.`

Tell a session the devnet run is done, and paste what steps 7 and 8 printed.

**If you want to stop after the upload** (before step 7) and take the devnet buffer's SOL back:

```powershell
node "{{PACK}}\scripts\7-close-buffer.mjs" --buffer <BUFFER ADDRESS> --send
```

## What the rehearsal covered, and what it could not

{{REHEARSAL}}
