# Start here: the range program's key

Staged {{STAGED}} from commit `{{COMMIT}}`. Nothing in this folder sends anything. About ten minutes.
Nobody signs.

## What this is for

Range pools run on their own program. A program's address is fixed the moment it is built, so
the address must exist before the build that goes to mainnet. Today the program carries a
placeholder address that can never be deployed. In this sitting you make the real address: a key
file on your computer. It holds no money. After the deploy it has no power at all: the vault holds
the program.

Two rules:

1. **Use only the key file you make here.** When the program is built on a computer, the build
   tool writes a key file of its own next to it (`target\deploy\raydium_clmm-keypair.json`). That
   file is never the program's key. Every script of these folders refuses it.
2. **Keep the address private until the deploy.** Anyone who knows it before then can block it for
   good, by sending a little SOL to it (it costs them about 15 cents). Give it only to the session
   doing the deploy. It goes public on purpose in the deploy itself, and after that nobody can
   block it. Until the deploy, whoever holds the key file could also put their own program at the
   address first, so the file stays on this computer only.

## The steps

Every command is for Windows PowerShell. Copy the whole line.

**Step 1. Make the key file.** (Nobody signs.)

```powershell
& "{{KEYGEN}}" new --no-bip39-passphrase --silent --outfile "{{PROGRAM_KEY}}"
```

You should see one line, `Wrote new keypair to` and that path, and nothing else. (`--silent` keeps
the address and the recovery words off the screen. You do not need them: if the key file were ever lost before the
deploy, you would make a new one and the program would be rebuilt for it.)

If you see `Refusing to overwrite`, stop. Do not add `--force`. Tell a session: a key may already
have been made, and it must be checked before anything else.

**Step 2. Check the key.** (Nobody signs. It only reads: your Solana tool prints the key file's
address, and the script asks mainnet and devnet whether anything lives there.)

```powershell
node "{{PACK}}\scripts\0-program-key.mjs" --key "{{PROGRAM_KEY}}"
```

You should see: lines that each start with `PASS`, among them `PASS    : its data address ... holds
nothing on mainnet`, then `The range program's address will be:` and an address, and at the end
`RESULT: this key may become the range program's address.`

**Step 3. Give that address to the session doing the deploy, and to nobody else.** Do not paste it
anywhere public, and do not send the key file to anyone or move it.

## What happens next

1. **The devnet practice run** (its own folder, `{{DEVNET_PACK}}`): the same steps on
   Solana's practice network, with a throwaway address and free SOL. It can be done any day.
2. **The deploy day.** A session puts your address into the program on this computer only (one
   change: `solana/clmm-deploy/program-id-change.mjs`), builds the program twice in two fresh copies,
   checks both builds are byte for byte the same, and stages the mainnet folder
   (`{{MAINNET_PACK}}`). You then deploy it the same day: it hands the program to the vault at once.
3. **Right after the deploy**, the session publishes the change. The repo's checks build the program
   again and must get the very same bytes as the program on chain. The website's pull requests for
   range pools take the address and go live, the position link (#912) first.
4. **The fee tiers**: a notice in the changelog, the proposal, and its execute once the notice's
   date has come. The mainnet folder's START-HERE.md walks you through them.

Each merge to `mvp-launch` needs your word.

## What is in this folder

| File | What it is |
|---|---|
| `START-HERE.md` | this paper |
| `scripts\0-program-key.mjs` | step 2: checks a key file is fit to be the program's address |
| `scripts\lib\` | what the script shares with the deploy scripts |
| `config.json` | every pinned value, read from the repo when this folder was made |
| `SHA256SUMS` | the fingerprint of every file here (the scripts check them before they run) |
