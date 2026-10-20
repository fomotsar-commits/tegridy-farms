#!/usr/bin/env node
// The one reviewed change that gives tegridy-clmm its real program id (step 7 of
// docs/RANGE_POOLS_PLAN.md): the id in lib.rs, Anchor.toml and the upstream test that names it;
// the placeholder feature and its compile_error! gate gone (the test-chain gate stays); the
// pinned patch regenerated exactly as `provenance.mjs --regenerate` would write it, and re-pinned;
// the allow-list's placeholder entry replaced by the id. A devnet build gets an address nobody
// holds a key for, so it can run nowhere. Every file it writes is one a pin pull request may touch
// (provenance.mjs REPIN_MAY_TOUCH), so that pull request carries nothing else. It refuses rather
// than guesses: a clean checkout, the id read from the key file, each edit found exactly once.
//
//   node solana/clmm-deploy/program-id-change.mjs --key <the owner's program key file> [--root <checkout>] [--date YYYY-MM-DD]
//
// Then: `node solana/guards/provenance.mjs tegridy-clmm uint` and key-guard with --release must
// pass (this script runs both and says so), and `git diff` shows the whole change.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(opt('--root') ?? process.cwd());
const DATE = opt('--date') ?? new Date().toISOString().slice(0, 10);
const PLACEHOLDER = 'RangePoo1PLACEHo1DERnotDep1oyed111111111111';
// The devnet build's id: like the placeholder, an address nobody holds a key for.
const DEVNET_ARM = 'RangePoo1DEVNETarmNotDep1oyed11111111111111';
const fail = (m) => { console.error(`STOPPED: ${m}\nNothing was written.`); process.exit(2); };

// ---- the id, read from the key file by the owner's Solana tool (never typed) ----------------
const RELEASE = 'C:/Users/jimbo/solana-launch-release-2026-09-26';
const KEY = opt('--key');
if (!KEY || !existsSync(KEY)) fail('--key <the program key file>: the id is read from it, never typed');
if (/[\\/]target[\\/]deploy[\\/][^\\/]*-keypair\.json$/i.test(resolve(KEY))) fail(`${KEY} is a key the build tool wrote; the program key is the owner's own file`);
const poolLib = readFileSync(join(RELEASE, 'pool-program-upgrade-2026-10', 'scripts', 'lib', 'pack.mjs'), 'utf-8');
const solanaExe = /^export const SOLANA_EXE = '([^']+)';$/m.exec(poolLib)?.[1]?.replace(/\\\\/g, '\\');
let ID;
try { ID = execFileSync(solanaExe, ['address', '-k', KEY], { encoding: 'utf-8' }).trim(); } catch (e) { fail(`the Solana tool could not read ${KEY} as a key (${e.message})`); }
const web3 = createRequire(`${RELEASE}/rehearsal/package.json`)('@solana/web3.js');
if (!web3.PublicKey.isOnCurve(new web3.PublicKey(ID).toBytes())) fail(`${ID} is not on the curve: no key file gives it`);
// A checkout with nothing else changed, so the pull request carries this change only.
let dirty;
try { dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf-8' }).trim(); } catch { fail(`${ROOT} is not a git checkout`); }
if (dirty) fail(`${ROOT} has uncommitted changes; this change goes in a clean checkout:\n${dirty.split('\n').slice(0, 8).join('\n')}`);

// ---- the id: 32 bytes of base58, not the placeholder, and no key anyone else holds ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s ?? '')) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return bytes.length === 32 ? bytes : null;
}
if (!decode(ID)) fail(`"${ID ?? ''}" is not a 32-byte base58 address`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) fail(`--date ${DATE} is not YYYY-MM-DD`);
if (ID === PLACEHOLDER || ID === DEVNET_ARM) fail('that is a placeholder, not a key');
const guards = join(ROOT, 'solana', 'guards');
const allow = JSON.parse(readFileSync(join(guards, 'allowed-keys.json'), 'utf-8'));
const deny = readFileSync(join(guards, 'upstream', 'deny-keys.txt'), 'utf-8').split('\n').map((l) => l.trim());
if (deny.includes(ID)) fail(`${ID} is a key Raydium's code hard-codes`);
for (const section of ['ours', 'system', 'keptUpstream']) if (allow[section]?.[ID]) fail(`${ID} is already named in allowed-keys.json (${section}): it is not a new program key`);
const known = JSON.parse(readFileSync(join(ROOT, 'frontend', 'scripts', 'addresses.json'), 'utf-8')).solana.find((r) => r.address === ID);
if (known) fail(`${ID} is already the venue's ${known.id} (frontend/scripts/addresses.json): it is not a new program key`);
if (!allow.placeholder?.[PLACEHOLDER]) fail('allowed-keys.json no longer names the placeholder: has this change already been made?');

// ---- what the patch says upstream's files are -----------------------------------------------
const P = await import(pathToFileURL(join(guards, 'provenance.mjs')).href);
const c = P.COPIES['tegridy-clmm'];
const clmm = join(ROOT, c.ours);
const deltaPath = join(guards, 'upstream', c.delta);
const sections = P.readDelta(readFileSync(deltaPath, 'utf-8'));
const manifest = P.readManifest(readFileSync(join(guards, 'upstream', c.manifest), 'utf-8'));
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const upstream = {};
for (const f of c.patched) {
  const ours = P.strip(readFileSync(join(clmm, f), 'utf-8'));
  const up = P.undoPatch(ours, sections.get(f));
  if (sha256(up) !== manifest.get(f)) fail(`${f}: undoing the pinned patch does not give upstream's file. Run provenance.mjs first`);
  upstream[f] = up;
}

// ---- the edits: each must match exactly once ------------------------------------------------
const edits = {
  'programs/amm/src/lib.rs': [
    // The internal review: the comment said no other line differs, but the build gates do.
    [`// No other line differs; the guards in solana/guards/ hold that (docs/RANGE_POOLS_PLAN.md).
`, `// Beside that only the build gates below differ; the guards in solana/guards/ hold that
// (docs/RANGE_POOLS_PLAN.md).
`],
    // The internal review: \`paramset\` (test-length reward periods) builds only for tests too.
    [`compile_error!("tegridy-clmm: devnet and localnet give every power to a test key; add the test-chain-keys feature to build one, and never deploy that build");
`, `compile_error!("tegridy-clmm: devnet and localnet give every power to a test key; add the test-chain-keys feature to build one, and never deploy that build");
// \`paramset\` shortens reward periods for tests: it too builds only with \`test-chain-keys\`.
#[cfg(all(feature = "paramset", not(feature = "test-chain-keys")))]
compile_error!("tegridy-clmm: paramset is for tests; add the test-chain-keys feature to build one, and never deploy that build");
`],
    [`// A placeholder, not a key: the owner's deploy pack makes the real program id. Until it does,
// any build without the \`placeholder-id\` feature stops here, so no release can carry it.
#[cfg(not(any(test, feature = "placeholder-id")))]
compile_error!("tegridy-clmm: the program id is still the placeholder; the deploy pack sets the real id and removes this gate");
`, `// The venue's program id, made by the owner on ${DATE} (step 7 of docs/RANGE_POOLS_PLAN.md).
`],
    [`#[cfg(feature = "devnet")]
declare_id!("${PLACEHOLDER}");
#[cfg(not(feature = "devnet"))]
declare_id!("${PLACEHOLDER}");`, `// A devnet build (every power to a test key) gets an address nobody holds a key for: it runs nowhere.
#[cfg(feature = "devnet")]
declare_id!("${DEVNET_ARM}");
#[cfg(not(feature = "devnet"))]
declare_id!("${ID}");`],
  ],
  'programs/amm/Cargo.toml': [
    [`# memetics.finance: builds with the placeholder program id. Never for a release (lib.rs).
placeholder-id = []
`, ''],
  ],
  'Anchor.toml': [
    [`# memetics.finance: the placeholder id in lib.rs, until the deploy pack makes the real one.
raydium_clmm = "${PLACEHOLDER}"`, `# memetics.finance: the venue's program id (lib.rs).
raydium_clmm = "${ID}"`],
  ],
  'programs/amm/src/states/tickarray_bitmap_extension.rs': [
    [`Pubkey::from_str("${PLACEHOLDER}").unwrap(), // Changed by memetics.finance: this copy's program id`,
      `Pubkey::from_str("${ID}").unwrap(), // Changed by memetics.finance: this copy's program id`],
  ],
  'README.md': [
    [`# tegridy-clmm: the venue's range-pool program (phase 0, not deployed)`, `# tegridy-clmm: the venue's range-pool program`],
    [`name, links and memos say memetics.finance. Its program id is a placeholder that no release
build accepts, and a \`devnet\` or \`localnet\` build is refused unless \`test-chain-keys\` is named.`,
      `name, links and memos say memetics.finance. Its program id is \`${ID}\`, made by the owner on
${DATE}, and a \`devnet\` or \`localnet\` build is refused unless \`test-chain-keys\` is named.`],
    [`- the build: compiles with \`--features placeholder-id\`, and is refused without it.`,
      `- the build: compiles with no features, prints the sha256 a deploy must match, and refuses a
  \`devnet\` or \`localnet\` build without \`test-chain-keys\`.`],
  ],
};
const written = {};
for (const [f, list] of Object.entries(edits)) {
  let text = P.strip(readFileSync(join(clmm, f), 'utf-8'));
  for (const [from, to] of list) {
    const n = text.split(from).length - 1;
    if (n !== 1) fail(`${f}: expected the text to change exactly once, found it ${n} times:\n${from.slice(0, 160)}`);
    text = text.replace(from, to);
  }
  if (text.includes(PLACEHOLDER) || /placeholder-id/.test(text)) fail(`${f} still names the placeholder after the edit`);
  written[f] = text;
}

// ---- the new patch, as --regenerate writes it: `diff upstream ours` per patched file -----------
const scratch = mkdtempSync(join(tmpdir(), 'clmm-id-'));
function diffNormal(a, b) {
  writeFileSync(join(scratch, '.a'), a);
  writeFileSync(join(scratch, '.b'), b);
  try { return execFileSync('diff', [join(scratch, '.a'), join(scratch, '.b')], { encoding: 'utf-8' }); } catch (e) {
    if (e.status === 1) return e.stdout;
    fail(`the diff tool could not run (${e.message}). Run this where GNU diff is on PATH (Git Bash, WSL, Linux)`);
  }
}
const newOurs = (f) => written[f] ?? P.strip(readFileSync(join(clmm, f), 'utf-8'));
const delta = c.patched.map((f) => `=== ${f} ===\n${diffNormal(upstream[f], newOurs(f))}`).join('');
rmSync(scratch, { recursive: true, force: true });
const deltaSha = sha256(delta);

// ---- write: the copy, the patch, its pin, the allow-list, the plan's id row ----------------
for (const [f, text] of Object.entries(written)) writeFileSync(join(clmm, f), text);
writeFileSync(deltaPath, delta);
const provPath = join(guards, 'provenance.mjs');
const prov = readFileSync(provPath, 'utf-8');
const pinLine = `deltaSha256: '${c.deltaSha256}',`;
if (prov.split(pinLine).length !== 2) fail(`provenance.mjs does not hold the pin ${c.deltaSha256} exactly once`);
writeFileSync(provPath, prov.replace(pinLine, `deltaSha256: '${deltaSha}',`));
// The allow-list, edited as text: the placeholder's three lines out, two entries in. Nothing else moves.
const allowPath = join(guards, 'allowed-keys.json');
const allowText = readFileSync(allowPath, 'utf-8');
const phBlock = `  "placeholder": {\n    "${PLACEHOLDER}": ${JSON.stringify(allow.placeholder[PLACEHOLDER])}\n  },\n`;
const oursOpen = '  "ours": {\n';
if (allowText.split(phBlock).length !== 2 || allowText.split(oursOpen).length !== 2) fail('allowed-keys.json is not laid out as this script expects');
const entry = (k, why) => `    "${k}": ${JSON.stringify(why)},\n`;
const newAllow = allowText.replace(phBlock, '').replace(oursOpen, oursOpen
  + entry(ID, `tegridy-clmm's program id, made by the owner on ${DATE}; its upgrade authority is the vault once deployed (docs/RANGE_POOLS_PLAN.md step 7).`)
  + entry(DEVNET_ARM, "tegridy-clmm's id in a devnet build only: not a key, nobody can deploy at it, so a devnet build (every power to a test key) runs nowhere. The release build never names it."));
JSON.parse(newAllow);
writeFileSync(allowPath, newAllow);
const planPath = join(ROOT, 'docs', 'RANGE_POOLS_PLAN.md');
const plan = readFileSync(planPath, 'utf-8');
const row = `| Program id | \`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK\` | a placeholder, \`${PLACEHOLDER}\` | Nothing: nobody holds its key and no release build accepts it |`;
if (plan.split(row).length !== 2) fail('docs/RANGE_POOLS_PLAN.md: the program id row is not the placeholder row');
writeFileSync(planPath, plan.replace(row, `| Program id | \`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK\` | \`${ID}\`, made by the owner on ${DATE} | Claimed by the first deploy; afterwards only its upgrade authority, the vault, can change the program |`));

// ---- prove it: the guards that hold the copy -----------------------------------------------
const changedLines = [...P.readDelta(delta).values()].flat().filter((l) => /^[<>] /.test(l)).length;
console.log(`wrote the id ${ID} into ${Object.keys(written).length} files of ${c.ours}`);
console.log(`${c.delta}: ${changedLines} changed lines, sha256 ${deltaSha} (pinned in provenance.mjs)`);
const run = (args) => { try { return { ok: true, out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf-8' }) }; } catch (e) { return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') }; } };
const pv = run([join(guards, 'provenance.mjs'), 'tegridy-clmm', 'uint']);
const kg = run([join(guards, 'key-guard.mjs'), '--release', '--allow', join(guards, 'allowed-keys.json'), '--deny', join(guards, 'upstream', 'deny-keys.txt'),
  '--ours', 'solana/tegridy-amm/programs/cp-swap', '--ours', 'solana/tegridy-clmm', '--ours', 'solana/tegridy-amm/programs/tegridy-launch', '--ours', 'solana/tegridy-amm/programs/bayla-ladder',
  '--clmm-lib', 'solana/tegridy-clmm/programs/amm/src/lib.rs']);
console.log(`provenance: ${pv.ok ? 'PASS' : 'FAIL'}\n${pv.out.trim().split('\n').slice(-3).join('\n')}`);
console.log(`key-guard --release: ${kg.ok ? 'PASS' : 'FAIL'}\n${kg.out.trim().split('\n').slice(-2).join('\n')}`);
process.exit(pv.ok && kg.ok ? 0 : 1);
