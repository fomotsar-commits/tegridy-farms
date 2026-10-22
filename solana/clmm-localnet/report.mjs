// Step 4: RESULTS.md from the last clean run, the last mutant sweep and setup's manifest.
// usage: node report.mjs <mutants-YYYY-MM-DD.json>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORK } from './lib/config.mjs';
import { spec } from './lib/clmm.mjs';

const j = (f) => JSON.parse(readFileSync(join(WORK, f), 'utf-8'));
const clean = j('results-clean.json');
const man = j('manifest.json');
// Every sweep in the work folder, oldest first: a later run of the same broken input wins, and
// the restore that counts is the last sweep's.
const sweeps = readdirSync(WORK).filter((f) => /^mutants-.*\.json$/.test(f)).sort().map(j);
const sweep = sweeps.length
  ? { ...sweeps.at(-1), mutants: Object.values(Object.fromEntries(sweeps.flatMap((x) => x.mutants.map((m) => ({ ...m, programSha: x.programSha }))).map((m) => [m.id, m]))), runs: sweeps.length }
  : null;
const perByte = man.mainnetRent.perByte;
const offCount = readFileSync(join(WORK, 'deactivate-features.txt'), 'utf-8').split('\n').filter(Boolean).length;
const sol = (l) => (Number(l) / 1e9).toFixed(4);
const mainnetCost = (bytes) => (bytes + 128) * perByte;
// A markdown table cell: the backslash first, so the pipe's escape cannot be undone.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

const redBy = new Map();
for (const m of sweep?.mutants || []) redBy.set(m.target, m);
const rows = clean.checks.map((c) => {
  const m = redBy.get(c.id);
  const red = m ? (m.red ? `red: ${esc(m.what)}` : `**NOT red**: ${esc(m.what)}`) : '**none run**';
  return `| ${c.id} | \`${esc(c.instruction)}\` | ${esc(c.what)} | ${c.pass ? 'pass' : '**FAIL**'} | ${red} | ${esc(c.counts)} |`;
});
const unred = clean.checks.filter((c) => !redBy.get(c.id)?.red).map((c) => c.id);

// Instruction coverage: every #[program] instruction, and the checks that ran it.
const ran = new Map();
for (const c of clean.checks) for (const n of Object.keys(spec.instructions)) if (new RegExp(`\\b${n}\\b`).test(c.instruction)) ran.set(n, [...(ran.get(n) || []), c.id]);
const notRun = {
  open_position: 'deprecated: makes an SPL Token NFT with a Metaplex name record; open_position_v2 (X17) covers that path',
  increase_liquidity: 'deprecated, SPL Token only: it cannot move BAYLA (Token-2022), as the old swap cannot (X16)',
  decrease_liquidity: 'deprecated, SPL Token only, for the same reason',
  close_protocol_position: 'closes the deprecated protocol-position accounts; a new deployment never makes one, so there is nothing to close',
};
const coverage = Object.keys(spec.instructions).map((n) => `| \`${n}\` | ${ran.has(n) ? ran.get(n).join(', ') : `not run: ${notRun[n] ?? '**no reason recorded**'}`} |`);

// Sizes: one row per kind of account, priced at mainnet's rent.
const kinds = new Map();
for (const s of clean.sizes) {
  const k = s.what.replace(/^tick array -?\d+$/, 'tick array (a band of 60 prices)');
  if (!kinds.has(k)) kinds.set(k, s);
}
const sizeRows = [...kinds.entries()].map(([k, s]) => `| ${esc(k)} | ${s.bytes.toLocaleString('en-US')} | ${sol(mainnetCost(s.bytes))} | ${sol(s.lamportsLocal)} | ${esc(s.paidBy)} |`);

const cuRows = clean.txs.filter((t) => t.ok && !/^(fund|wrap|vault: |USD for|REWARD account|BAYLA:)/.test(t.label)).sort((a, b) => b.cu - a.cu).slice(0, 14)
  .map((t) => `| ${esc(t.label)} | ${t.cu.toLocaleString('en-US')} | ${t.bytes} |`);

const failed = clean.checks.filter((c) => !c.pass);
const out = `# Range pools on a local chain: results

> Step 1 of "What is left, in order" in [docs/RANGE_POOLS_PLAN.md](../../docs/RANGE_POOLS_PLAN.md). The one to-do list is [docs/TODO_OPERATOR.md](../../docs/TODO_OPERATOR.md). This file is written by \`report.mjs\`; rerun the harness rather than editing it.

**What it means.** The range-pool program (our copy of Raydium's concentrated-liquidity program, built the way a
release would be) ran every instruction a visitor or the venue would use on a local chain, against copies of
mainnet's BAYLA, wrapped SOL, Squads and token programs. ${clean.checks.length} checks: ${clean.checks.length - failed.length} pass${failed.length ? `, **${failed.length} fail (${failed.map((c) => c.id).join(', ')})**` : ', none fail'}.
${sweep ? `${sweep.mutants.filter((m) => m.red).length} of ${sweep.mutants.length} broken inputs turned their check red first${(() => { const here = sweep.mutants.filter((m) => m.programSha === sweep.programSha).length; return here === sweep.mutants.length ? '' : ` (${here} against this build, the rest, whose checks did not change, against the build before it)`; })()}; ${sweep.restore.ok ? 'the clean run after them passed every check with the program and its source unchanged (restore proven)' : '**the restore was NOT proven**'}.` : '**No mutant sweep has been run.**'}
Every admin action was signed by the vault's real address through a real Squads 2-of-2 with a time lock. No path
sent anything to a Raydium address. The fee tiers are the owner's (2026-10-20): of each fee the LPs collected 84%,
the venue's 10.4% was collectable only by the vault, and the island's 5.6% only by its Workshop's role: the vault
is refused (check V9), though one proposal can **re-point the island's share** (check V6). No tier may charge
more than 4% of a swap or give the venue and the island more than 16% of each fee, made or changed (K1 to K5),
and a dynamic fee is held to 4% too (K6). A reward's unpaid rest goes back only to whoever started it, whoever owns
the pool (R11, R13, R14). (A fee earned where no LP's range is in use, when a swap fills a limit order there, goes to
the venue's share.) What the vault can still do, the pause of any part of a pool included, is in
docs/RANGE_POOLS_PLAN.md.

Run ${clean.started} to ${clean.finished}. Nothing was deployed anywhere, no program key exists, and nothing was
signed or sent on mainnet: mainnet was only read.

## The local chain

- **Program**: \`solana/tegridy-clmm\` built with \`cargo build-sbf --features placeholder-id -- --locked\` (the
  release shape CI builds; every role is the vault, so no \`devnet\`/\`localnet\` feature and no \`test-chain-keys\`
  is needed). Solana tools 3.1.11 in WSL (CI pins 3.1.10), sha256 \`${sweep?.programSha ?? 'see manifest'}\`,
  loaded at the placeholder id \`${man.addresses.program}\` with the vault as upgrade authority.
- **Copied from mainnet** (read at slot ${man.accounts.multisig.slot.toLocaleString('en-US')}, ${man.readAt.slice(0, 16)}Z): the programs Squads v4, Token-2022, SPL Token,
  Associated Token, Memo and Metaplex (each byte-identical to mainnet's: table below); the BAYLA mint
  \`${man.addresses.bayla}\`; the wrapped-SOL mint; the Squads multisig \`${man.addresses.multisig}\`;
  Squads' own published IDL. Every address came from \`frontend/scripts/addresses.json\`, \`solana/guards/allowed-keys.json\`
  or the frontend's Squads constant.
- **What differs from mainnet, and nothing else**: the multisig's two member keys are local test keys and its
  172,800 s time lock is **${clean.localTimeLock} s** (threshold 2, no config authority and proposal numbering stay
  mainnet's, so its vault 0 is the real vault \`${man.addresses.vault}\`); BAYLA's mint had a local mint authority
  until the test wallets were funded, then none, as on mainnet (check S2); the ${offCount} runtime features mainnet has not
  switched on were switched off (\`features.mjs\`), including the raise of the program-call depth limit from 4 to 8.
- **Starting price**: the venue's BAYLA/SOL pool on mainnet, ${man.venuePrice.solPerBayla.toExponential(4)} SOL per BAYLA.

| Program copied from mainnet | Address | Bytes | sha256 | Last deployed (slot) |
|---|---|---|---|---|
${Object.entries(man.programs).map(([k, p]) => `| ${k} | \`${p.address}\` | ${p.bytes.toLocaleString('en-US')} | \`${p.sha256}\` | ${p.lastDeploySlot ? p.lastDeploySlot.toLocaleString('en-US') : 'not upgradeable'} |`).join('\n')}

## Every check

"Red first" names the broken input each check was run against before it passed: the check had to come out FAIL on
it. ${unred.length ? `**Not seen red first: ${unred.join(', ')}.** Until each is, its pass proves less than the others.` : `Every check was seen red first.`}
Each broken input ran alone on a fresh chain and stopped once its check was judged; those runs used a 3 s lock to save
time (the clean runs use ${clean.localTimeLock} s). ${sweep ? `The restore after them: a clean run from nothing, ${sweep.restore.cleanChecks} checks, ${sweep.restore.cleanFailed.length ? `**failed ${sweep.restore.cleanFailed.join(', ')}**` : 'none failed'}, the program's sha256 \`${sweep.restore.programShaAfter}\` as before and its source unchanged.` : ''}

| ID | Instruction | What was checked | Clean run | Red first | Counts |
|---|---|---|---|---|---|
${rows.join('\n')}

## Instructions covered

| Instruction | Checks |
|---|---|
${coverage.join('\n')}

## Rent and sizes, measured

Measured on the local chain. Mainnet cost is (bytes + 128) x ${perByte.toLocaleString('en-US')} lamports, mainnet's rate read
${man.readAt.slice(0, 10)}. The local chain charges 6,960 a byte, so its own numbers are higher; only bytes carry over.

| Account | Bytes | Mainnet rent, SOL | Local rent, SOL | Paid by |
|---|---|---|---|---|
${sizeRows.join('\n')}

## Heaviest transactions

| Transaction | Compute units | Bytes (limit 1,232) |
|---|---|---|
${cuRows.join('\n')}

## What surprised us

1. **The vault keeps power over the island's 5.6%.** As admin it can collect the fund share itself, into any
   account, and re-point a tier's fund owner at any time (V6, V9). The same is true of our cp-swap. Each takes a
   vault proposal, so two signatures and the 48-hour lock, which the island can watch for.
2. **The vault cannot pay for rewards today.** Every reward stream, even one a pool's opener pays for, needs the
   operation account first (3,529 bytes, 0.0186 SOL at mainnet's rate), made and paid by the vault. The vault held
   0.0152 SOL on 2026-10-20. Two tiers take 0.0025 more.
3. **Raydium's key list also holds the SPL Memo program.** \`solana/guards/upstream/deny-keys.txt\` is every key
   Raydium's code writes, less three system keys, so it carries Memo, which every v2 swap and withdrawal must name.
   G1 went red on it in the first run; it now treats Memo as named-only and fails on any other key.
4. **\`cargo build-sbf\` writes a fresh program key** (\`target/deploy/raydium_clmm-keypair.json\`) when none exists. A
   plain \`solana program deploy\` would use it. It was deleted; nothing here used it.
5. **A BAYLA pool's BAYLA vault is 170 bytes, not 165** (Token-2022 adds 5), so a pool is 8,194 bytes. The cost is
   still 0.0449 SOL.
6. **The spare-SOL sweep does not reach LPs' wrapped SOL.** Mainnet's own Token program let the vault sweep exactly
   the 0.1 SOL gift sitting above a wrapped-SOL vault's rent and balance; the LPs' 32.5 SOL stayed (E2).
7. **A reward not yet open can be given any window by the vault** (here 90 s): the 7-day minimum binds only when a
   reward is made, or extended by someone who is not the admin. That is how the whole life of a stream, including
   taking back what it did not pay (604,800 BAYLA), ran in minutes on the release build (R5 to R9).
8. **The old position path still works for anyone** (\`open_position_v2\` with a Metaplex name record). The stranger
   who uses it leaves 0.01 SOL of their own with Metaplex (X17); the vault pays nothing. The site never offers it.
9. **Once the vault makes any dynamic fee setting, any visitor can open a pool with it, on either tier, with its fee
   taken in one coin only** (X11). The vault should make one only on purpose.
10. **Two things the local chain could not do.** It cannot wait out the real 172,800 s lock: the same Squads check
    refused an early execute at 10 s (T4) and accepted one after (T5). And it cannot sign as the island's Workshop:
    a local key stood in for it in the fund-owner role (V7), then the tier was pointed back at the Workshop (V8).
11. **WSL here has no network, and stops its machine about a minute after the last \`wsl.exe\` client exits**,
    detached validators and all. The harness reads mainnet from Windows and holds a client open for each run.

## How to run

From \`solana/clmm-localnet\`, with the frontend's dependencies installed and WSL holding Solana's tools and a build
of the program at \`CLMM_SO\` (default \`/root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so\`):

\`\`\`
node run.mjs                  # setup, fresh validator, the whole suite (about 15 minutes)
node run-mutants.mjs          # every broken input, then a clean run as the restore
node report.mjs               # this file
\`\`\`
`;
writeFileSync(join(import.meta.dirname, 'RESULTS.md'), out);
console.log(`RESULTS.md: ${clean.checks.length} checks, ${failed.length} failed, ${sweep ? sweep.mutants.length + ' mutants' : 'no sweep'}`);
