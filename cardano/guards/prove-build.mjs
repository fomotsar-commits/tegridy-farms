#!/usr/bin/env node
// Built with the compiler Minswap used, our copy with the reviewed patch undone is Minswap's
// mainnet code: it reproduces upstream's plutus.json, and Minswap's own mainnet parameters turn it
// into the six deployed scripts byte for byte. Our copy as it stands changes exactly the
// validators PATCH_CHANGES names, and every other one keeps Minswap's bytes. The role timelock
// builds with the same compiler, passes its tests, and reproduces its committed plutus.json.
//   node cardano/guards/prove-build.mjs [--chain] [--root <dir>]   (AIKEN=<path>, else aiken on PATH)
//   --chain also reads each script from its mainnet reference UTxO (Koios) and compares.
//   --root checks the cardano/ folder of another tree (the CI self-test hands it a tampered copy).

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DELTA, readPatch, upstreamText } from './provenance.mjs';

const at = process.argv.indexOf('--root');
const ROOT = at > 0 ? resolve(process.argv[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AIKEN = process.env.AIKEN || 'aiken';

// plutus.json's preamble names it; .github/workflows/cardano-ci.yml pins the release tarball.
export const COMPILER = 'aiken v1.0.24-alpha+982eff4';
// aiken.lock's aiken-lang/stdlib 1.7.0 is a tag; this is the commit it names. Built from it, not
// from what a download of the tag serves today.
export const STDLIB = { repo: 'https://github.com/aiken-lang/stdlib', commit: '97cd61345bcc8925c521b30d0f354859eb0148cd', version: '1.7.0' };

// Minswap's published mainnet hashes (README.md at the pin, deployed/mainnet/script.json) and the
// UTxOs holding each as a reference script (deployed/mainnet/references.json). Pinned here, so
// --chain sends Koios only these, and a changed references.json fails instead of steering it.
export const MAINNET = {
  authen: { title: 'authen_minting_policy.validate_authen', hash: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c', scriptKey: 'authenScript', refKey: 'authenTxId', ref: 'dbc1498500a6e79baa0f34d10de55cdb4289ca6c722bd70e1e1b78a858f136b9#0' },
  pool: { title: 'pool_validator.validate_pool', hash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b', scriptKey: 'poolScript', refKey: 'poolTxId', ref: '2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea#0' },
  poolBatching: { title: 'pool_validator.validate_pool_batching', hash: '1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a', scriptKey: 'poolBatchingScript', refKey: 'poolBatchingTxId', ref: 'd46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17#0' },
  expiredOrderCancel: { title: 'order_validator.validate_expired_order_cancel', hash: 'c8b0cc61374d409ff9c8512317003e7196a3e4d48553398c656cc124', scriptKey: 'expiredOrderCancelScript', refKey: 'expiredOrderCancelTxId', ref: 'ef3acc7dfc5a98bffe8f4d4400e65a9ade5a1316b2fcb7145c3b83dba38a66f5#0' },
  order: { title: 'order_validator.validate_order', hash: 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c', scriptKey: 'orderScript', refKey: 'orderTxId', ref: 'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776#0' },
  factory: { title: 'factory_validator.validate_factory', hash: '7bc5fbd41a95f561be84369631e0e35895efb0b73e0a7480bb9ed730', scriptKey: 'factoryScript', refKey: 'factoryTxId', ref: '59c7fa5c30cbab4e6d38f65e15d1adef71495321365588506ad089d237b602e0#0' },
};

// The fee-share floor the patch lowers is read only by pool_validation's pool-fee update, which
// only the pool validator calls. With Minswap's own mainnet parameters the pool's hash changes,
// and so do the three scripts whose parameters name it.
export const PATCH_CHANGES = ['pool_validator.validate_pool'];
export const PATCH_CHANGES_APPLIED = ['pool', 'poolBatching', 'order', 'factory'];

// Plutus Data as CBOR hex, encoded as Plutus itself does: a constructor's non-empty field list
// is indefinite-length.
const head = (major, n) => {
  const m = major << 5;
  if (n < 24) return (m | n).toString(16).padStart(2, '0');
  for (const [add, bytes] of [[24, 1], [25, 2], [26, 4]]) if (n < 256 ** bytes) return (m | add).toString(16).padStart(2, '0') + n.toString(16).padStart(bytes * 2, '0');
  throw new Error(`${n} is too large`);
};
export const cbor = {
  bytes: (hex) => head(2, hex.length / 2) + hex,
  int: (n) => head(0, n),
  constr: (i, fields) => `d8${(121 + i).toString(16)}${fields.length ? `9f${fields.join('')}ff` : '80'}`,
};
const credential = (c) => cbor.constr(c.type === 'Key' ? 0 : 1, [cbor.bytes(c.hash)]);

/** The bytes inside one CBOR byte-string wrapper. */
export function unwrapBytes(hex) {
  const b = Buffer.from(hex, 'hex');
  const add = b[0] & 31;
  if (b[0] >> 5 !== 2 || add > 26) throw new Error('not a definite CBOR byte string');
  const [len, at] = add < 24 ? [add, 1] : [b.readUIntBE(1, 2 ** (add - 24)), 1 + 2 ** (add - 24)];
  if (at + len !== b.length) throw new Error(`byte string holds ${len} bytes, ${b.length - at} follow`);
  return b.subarray(at).toString('hex');
}

/** stdout and stderr together, colours stripped; a non-zero exit throws with both. */
function run(args, cwd) {
  const r = spawnSync(AIKEN, args, { cwd, encoding: 'utf-8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (r.error || r.status !== 0) throw new Error(`aiken ${args.join(' ')} failed in ${cwd}:\n${r.error?.message ?? ''}${out}`);
  return out;
}

/** A project copied text-only with line endings stripped, the pinned stdlib in its packages. */
function stage(src, dst, stdlib) {
  const walk = (d) => {
    for (const name of readdirSync(join(src, d)).sort()) {
      const rel = d ? `${d}/${name}` : name;
      if (rel === 'build') continue;
      if (statSync(join(src, rel)).isDirectory()) walk(rel);
      else {
        mkdirSync(dirname(join(dst, rel)), { recursive: true });
        writeFileSync(join(dst, rel), readFileSync(join(src, rel), 'utf-8').replace(/\r$/gm, ''));
      }
    }
  };
  walk('');
  const pkgs = join(dst, 'build', 'packages');
  cpSync(stdlib, join(pkgs, 'aiken-lang-stdlib'), { recursive: true, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) });
  writeFileSync(join(pkgs, 'packages.toml'), `[[packages]]\nname = "aiken-lang/stdlib"\nversion = "${STDLIB.version}"\nsource = "github"\n`);
  return dst;
}

function build(dir) {
  const out = run(['build'], dir);
  if (/Downloaded/.test(out)) throw new Error(`aiken downloaded a package in ${dir} instead of building with the pinned one:\n${out}`);
  return JSON.parse(readFileSync(join(dir, 'plutus.json'), 'utf-8'));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fetchStdlib(work) {
  const dir = join(work, 'stdlib');
  const git = (args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir);
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--depth', '1', STDLIB.repo, STDLIB.commit]);
  git(['checkout', '--quiet', 'FETCH_HEAD']);
  if (git(['rev-parse', 'HEAD']) !== STDLIB.commit) throw new Error(`stdlib checkout is not ${STDLIB.commit}`);
  return dir;
}

/** Minswap's src/script.ts, step for step: each parameter applied as Minswap applied it. */
function applyMainnet(dir) {
  const params = JSON.parse(readFileSync(join(dir, 'deployed/mainnet/params.json'), 'utf-8'));
  const apply = (title, arg) => {
    const [m, v] = title.split('.');
    run(['blueprint', 'apply', '-m', m, '-v', v, arg, '-o', 'applied.json'], dir);
    cpSync(join(dir, 'applied.json'), join(dir, 'plutus.json'));
  };
  const hashOf = (title) => JSON.parse(readFileSync(join(dir, 'plutus.json'), 'utf-8')).validators.find((x) => x.title === title).hash;
  const [txId, index] = params.seedTxIn.split('#');
  apply(MAINNET.authen.title, cbor.constr(0, [cbor.constr(0, [cbor.bytes(txId)]), cbor.int(Number(index))]));
  const authen = hashOf(MAINNET.authen.title);
  apply(MAINNET.pool.title, cbor.bytes(authen));
  const pool = hashOf(MAINNET.pool.title);
  apply(MAINNET.poolBatching.title, cbor.bytes(authen));
  apply(MAINNET.poolBatching.title, cbor.constr(1, [cbor.bytes(pool)]));
  const batching = hashOf(MAINNET.poolBatching.title);
  const expired = hashOf(MAINNET.expiredOrderCancel.title);
  const stakeScript = (h) => cbor.constr(0, [cbor.constr(1, [cbor.bytes(h)])]);
  apply(MAINNET.order.title, stakeScript(batching));
  apply(MAINNET.order.title, stakeScript(expired));
  apply(MAINNET.factory.title, cbor.bytes(authen));
  const poolCreationAddress = cbor.constr(0, [cbor.constr(1, [cbor.bytes(pool)]), cbor.constr(0, [cbor.constr(0, [credential(params.poolStakeCredential)])])]);
  apply(MAINNET.factory.title, poolCreationAddress);
  apply(MAINNET.factory.title, stakeScript(batching));
  return JSON.parse(readFileSync(join(dir, 'plutus.json'), 'utf-8')).validators;
}

async function chainScripts() {
  const res = await fetch('https://api.koios.rest/api/v1/utxo_info', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.KOIOS_API_KEY ? { authorization: `Bearer ${process.env.KOIOS_API_KEY}` } : {}) },
    body: JSON.stringify({ _utxo_refs: Object.values(MAINNET).map((s) => s.ref), _extended: true }),
  });
  if (!res.ok) throw new Error(`Koios answered HTTP ${res.status}: the chain check did not complete`);
  return res.json();
}

async function main() {
  const chain = process.argv.includes('--chain');
  const problems = [];
  const version = run(['--version'], ROOT).trim();
  if (version !== COMPILER) throw new Error(`${AIKEN} is ${version}, not ${COMPILER}`);
  console.log(`compiler: ${version}`);
  const work = mkdtempSync(join(tmpdir(), 'cardano-prove-'));
  try {
    const stdlib = fetchStdlib(work);
    console.log(`stdlib: ${STDLIB.repo} @ ${STDLIB.commit} (${STDLIB.version})`);

    // Minswap's code: our copy with the reviewed patch undone.
    const patch = readPatch(join(ROOT, 'cardano/guards/upstream'));
    problems.push(...patch.problems);
    const ms = stage(join(ROOT, 'cardano/minswap-dex-v2'), join(work, 'minswap-dex-v2'), stdlib);
    for (const p of DELTA.patched) writeFileSync(join(ms, p), upstreamText(p, readFileSync(join(ms, p), 'utf-8'), patch.sections));
    const upstream = JSON.parse(readFileSync(join(ms, 'plutus.json'), 'utf-8'));
    const built = build(ms);
    if (!same(built, upstream)) problems.push('minswap-dex-v2: Minswap\'s code does not build to upstream\'s plutus.json');
    else console.log(`Minswap's code (our copy, patch undone): the build reproduces upstream's plutus.json (${built.validators.length} validators)`);

    const applied = applyMainnet(ms);
    const deployed = JSON.parse(readFileSync(join(ms, 'deployed/mainnet/script.json'), 'utf-8'));
    const refs = JSON.parse(readFileSync(join(ms, 'deployed/mainnet/references.json'), 'utf-8'));
    const onChain = chain ? await chainScripts() : [];
    for (const [name, s] of Object.entries(MAINNET)) {
      const v = applied.find((x) => x.title === s.title);
      const left = (v.parameters ?? []).length;
      if (left) problems.push(`${name}: ${left} parameter(s) not applied`);
      if (v.hash !== s.hash) problems.push(`${name}: builds to ${v.hash}, Minswap's mainnet script is ${s.hash}`);
      if (unwrapBytes(deployed[s.scriptKey].script) !== v.compiledCode) problems.push(`${name}: our bytes are not deployed/mainnet/script.json's ${s.scriptKey}`);
      if (refs[s.refKey] !== s.ref) problems.push(`${name}: references.json names ${refs[s.refKey]}, not the pinned ${s.ref}`);
      let line = `${name}: ${v.hash} = Minswap mainnet, ${v.compiledCode.length / 2} bytes = script.json`;
      if (chain) {
        const [tx, ix] = s.ref.split('#');
        const u = onChain.find((x) => x.tx_hash === tx && x.tx_index === Number(ix));
        if (!u?.reference_script) problems.push(`${name}: Koios returned no reference script at ${s.ref}: the chain check did not complete`);
        else if (u.reference_script.bytes !== v.compiledCode || u.reference_script.hash !== v.hash) problems.push(`${name}: the reference script at ${s.ref} is not our build`);
        else line += ` = the reference script at ${s.ref}${u.is_spent ? ' (spent)' : ''}`;
      }
      console.log(line);
    }

    // Ours: the copy as it stands, patch applied.
    const mine = stage(join(ROOT, 'cardano/minswap-dex-v2'), join(work, 'minswap-ours'), stdlib);
    const ours = build(mine);
    const changed = upstream.validators.filter((u) => ours.validators.find((v) => v.title === u.title)?.compiledCode !== u.compiledCode).map((u) => u.title);
    if (!same(ours.definitions, upstream.definitions) || ours.validators.length !== upstream.validators.length) problems.push('ours: the patch changed a type or the set of validators');
    if (changed.join('|') !== PATCH_CHANGES.join('|')) problems.push(`ours: the patch changes ${changed.join(', ') || 'no validator'}, not exactly ${PATCH_CHANGES.join(', ')}`);
    for (const u of upstream.validators) {
      const v = ours.validators.find((x) => x.title === u.title);
      console.log(`ours: ${u.title} ${changed.includes(u.title) ? `changed, ${u.hash} -> ${v.hash} (${u.compiledCode.length / 2} -> ${v.compiledCode.length / 2} bytes)` : `${v.hash} = Minswap's bytes`}`);
    }
    const oursApplied = applyMainnet(mine);
    const differ = Object.entries(MAINNET).filter(([, s]) => oursApplied.find((x) => x.title === s.title).hash !== s.hash).map(([n]) => n);
    if (differ.join('|') !== PATCH_CHANGES_APPLIED.join('|')) problems.push(`ours with Minswap's mainnet parameters: ${differ.join(', ') || 'nothing'} differs from mainnet, not exactly ${PATCH_CHANGES_APPLIED.join(', ')}`);
    for (const [name, s] of Object.entries(MAINNET)) {
      const h = oursApplied.find((x) => x.title === s.title).hash;
      console.log(`ours with Minswap's mainnet parameters: ${name} ${h === s.hash ? `${h} = Minswap mainnet` : `${h}, not mainnet's ${s.hash}`}`);
    }

    const rt = stage(join(ROOT, 'cardano/role-timelock'), join(work, 'role-timelock'), stdlib);
    const committed = JSON.parse(readFileSync(join(rt, 'plutus.json'), 'utf-8'));
    run(['fmt', '--check'], rt);
    const tests = run(['check'], rt);
    const counts = [...tests.matchAll(/━ (\S+) ━[\s\S]*?(\d+) tests \| (\d+) passed \| (\d+) failed/g)].map((m) => ({ module: m[1], tests: +m[2], failed: +m[4] }));
    const lockTests = counts.find((c) => c.module === 'role_timelock/lock_test');
    if (!lockTests || lockTests.tests < 80 || counts.some((c) => c.failed)) problems.push(`role-timelock: aiken check did not pass the lock's tests:\n${tests}`);
    else console.log(`role-timelock: aiken fmt --check clean; aiken check: ${counts.map((c) => `${c.module} ${c.tests}`).join(', ')}, none failed`);
    const blueprint = build(rt);
    if (!same(blueprint, committed)) problems.push('role-timelock: the build is not the committed plutus.json; rebuild and commit it');
    else for (const v of blueprint.validators) console.log(`role-timelock: ${v.title} ${v.hash} = the committed plutus.json`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const p of problems) console.log(`::error::${p}`);
  if (problems.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
