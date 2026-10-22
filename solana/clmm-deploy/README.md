# The range program's deploy pack (step 7 of docs/RANGE_POOLS_PLAN.md)

The owner's folders for putting `solana/tegridy-clmm` on mainnet and giving it its two fee tiers.
The owner signs every step; nothing here signs or sends unless the owner adds `--send`, and no
script opens a key file (addresses are asked of the owner's own Solana tool). Every script checks
its folder against `SHA256SUMS` before it does anything.

## The order, and why the address stays private until the deploy

Anyone who knows a program's address before it is deployed can block it for good: SOL sent to its
data address makes the loader's create fail (rehearsal check S1). So the real address is published
only by the deploy itself:

1. **The key folder** (`stage.mjs --kind key`): the owner makes the program key at
   `C:\Users\jimbo\solana-keys\mainnet\tegridy-clmm-program-keypair.json` and checks it
   (`0-program-key.mjs`, which also checks its data address is empty). Never the build tool's
   `target/deploy/raydium_clmm-keypair.json`.
2. **The devnet practice run** (`--kind devnet`): the same scripts with a throwaway key and a build
   for it, so the real address never touches devnet.
3. **Deploy day, on this computer only**: `node solana/clmm-deploy/program-id-change.mjs --key <the
   owner's key file>` in a clean checkout, on a branch that is not pushed. It reads the id from the
   key file, removes the placeholder and its `compile_error!` (the test-chain gate stays), gives a
   devnet build an address nobody holds a key for, regenerates and re-pins
   `solana/guards/upstream/tegridy-clmm.diff`, edits the allow-list as text, and runs the provenance
   and release key guards. Then two builds in two fresh copies (no features, `--locked`), which must
   be byte for byte the same, and `stage.mjs --kind mainnet --binary <one> --rebuilt <the other>
   --expect-sha256 <hash> --rehearsal <results>`. The owner deploys the same day.
4. **Right after the deploy**: push that branch as its own pull request. CI's `clmm-build` builds
   with no features and keeps the build (`tegridy-clmm-release`) only from the push to mvp-launch;
   `node solana/clmm-deploy/ci-matches-chain.mjs --run <that run>` must say the same bytes are on
   chain. Then the site's pull requests take the id (#911, #912, #913, #915, #916, another
   session's). **#912's 404 answer must name the program it serves** (`program: <id>` beside
   `error`): the page refuses to approve or execute the tiers until
   `https://memetics.finance/position/<random>.json` answers 404 for this program.
5. **The fee tiers**: the notice line merged to CHANGELOG.md; `5-record-notice.mjs` walks
   mvp-launch's merge line on GitHub and restarts the notice at any merge without the line; member A
   proposes on the page; the second approval (which starts the 48-hour lock) is offered only from the
   notice's end - 48 hours, so the chain itself holds the execute to the notice; the execute. The
   notice ends 7 days after it went public, or at the date it names (`notice.notBefore`; mainnet:
   2026-10-23 14:00 UTC, the owner's ruling of 2026-10-22 after #19 was approved around the page).
   Tests of that gate: `node --test "solana/clmm-deploy/test/*.test.mjs"`, and in CI
   `frontend/src/test/clmmTierGate.test.ts`. `stage.mjs --kind mainnet --tiers-only` makes the
   folder for that last sitting (`START-HERE-TIERS.md`: scripts 4, 5 and 6 and the page), because
   the deploy folder is in use and is never restaged over.

## Files

| | |
|---|---|
| `stage.mjs` | makes a folder (key, devnet, mainnet, rehearsal): scripts, the bundled page, the program file, the filled paper, `config.json`, `SHA256SUMS`. Every address from `frontend/scripts/addresses.json`, `solana/guards/allowed-keys.json`, the pool pack or the chain. Builds beside the target and moves it in at the end; never replaces a folder it did not make or one whose `owner-run\` holds files. |
| `START-HERE-KEY.md`, `START-HERE-DEVNET.md`, `START-HERE.md`, `START-HERE-TIERS.md` | the owner's papers, templates (`{{BLANK}}`s filled at staging; a blank left unfilled refuses the staging) |
| `program-id-change.mjs` | step 3 above |
| `ci-matches-chain.mjs` | step 4 above |
| `scripts/` | `0` key, `1` preflight, `2` buffer check, `3` deploy + hand-over, `4` program check, `5` notice record, `6` tier check, `7` buffer return (pinned to this build: the paying wallet also runs the pool pack, whose SOL `1` sets aside until that pack's buffers are parked); `lib/pack.mjs` shared; `lib/tiers.mjs` the proposal core the page and scripts share |
| `proposer/` | the local page (127.0.0.1 only, never framed; a relay with a method allow-list and a second, separate RPC for reads, checked one against the other before every signature; one tab) |
| `rehearsal/rehearse.mjs` | the whole mainnet folder end to end on a local chain (`solana/clmm-localnet`'s copies, `validator.mjs --no-clmm`), with the owner's Solana tool, a stand-in for GitHub and the website (`fake-github.mjs`) and the real page in headless Chromium; every refusal tried |

## The rehearsal

```
node solana/clmm-deploy/rehearsal/rehearse.mjs --binary <a build for a throwaway id> --program-key <that id's key>
```

env `CLMM_WORK` (the harness's work folder), `CLMM_TIME_LOCK` (seconds standing in for 48 hours).
The binary is this source run through `program-id-change.mjs --key <throwaway key> --root <a clean
scratch clone>`, built with no features. It writes `rehearsal/rehearsal-results.json` in the work
folder, which staging a devnet or mainnet folder requires (every step passed).
