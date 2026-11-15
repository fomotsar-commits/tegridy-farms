#!/usr/bin/env node
// Each copy is its pinned upstream files plus exactly the reviewed patch, proved with no clone:
// upstream/<repo>.sha256 holds the hash of every upstream file we take, at the pin, and
// upstream/<repo>.diff the patch, whose own hash is pinned below. Undoing the patch on our file
// must give upstream's hash; every other file must hash to upstream's; no file is added.
//   node cardano/guards/provenance.mjs                         check (run from the repo root)
//   node cardano/guards/provenance.mjs --self-test             each tamper below is refused
//   node cardano/guards/provenance.mjs --regenerate <scratch>  re-derive upstream/ from a clone

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDelta, undoPatch } from '../../solana/guards/provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UP_DIR = join(HERE, 'upstream');

export const REPO = 'https://github.com/minswap/minswap-dex-v2';
// main on 2024-07-10, "Release the official version by Minswap Labs (#58)". Its validators are
// unchanged since CertiK's re-audit commit d299bd1.
export const COMMIT = 'c3293ad435792ba502f5a2b1691c6736e5f167e6';
export const MANIFEST = 'minswap-dex-v2.sha256';

// Two owner rulings, nothing else:
// - 2026-10-24 ("0.3% fee, venue under 1/6"): the venue's fee share is 1333 / 10000 of the
//   trade fee, below Minswap's floor of 1666. utils.ak: that one constant; its comment above
//   still reads 16.66%, as upstream wrote it.
// - 2026-10-25 ("$15 worth of ADA", fixed ADA re-set by hand): opening a pool pays a fee in
//   lovelace to an address, both named by the GlobalSetting, which the 48-hour lock changes.
//   types.ak: the two fields, after Minswap's six; authen_minting_policy.ak: `..` where it
//   reads the six; factory_validator.ak: the GlobalSetting read from the reference inputs and
//   the payment checked.
export const DELTA = {
  file: 'minswap-dex-v2.diff',
  sha256: '9326b528bfd33fe59d4aa715e2fe2a84c71dc9bc3102bd39566bf3d068c2e9f9',
  patched: ['lib/amm_dex_v2/types.ak', 'lib/amm_dex_v2/utils.ak', 'validators/authen_minting_policy.ak', 'validators/factory_validator.ak'],
};

// What --regenerate wrote from a fresh clone at the pin. A reviewer reproduces it the same way.
export const PINNED = {
  [MANIFEST]: '0257c362be04c162f2c2ddfd7759363cb99b0b95eede71517535bdd3528f77da',
};

// What we take: the Aiken project, its compiled blueprint, the deploy record and the specs.
// Not taken: the TypeScript tooling (the batcher's session takes src/ when it needs it), the
// audit PDFs and the picture (linked at the pin instead).
export const TAKE = (p) =>
  ['aiken.toml', 'aiken.lock', 'plutus.json', 'LICENSE.md', 'README.md'].includes(p) ||
  /^(lib|validators|deployed)\//.test(p) ||
  /^amm-v2-docs\/[^/]+\.md$/.test(p);

export const COPIES = {
  'minswap-dex-v2': { ours: 'cardano/minswap-dex-v2', take: TAKE, map: (p) => p },
  // The role timelock compiles against Minswap's own library, and its tests run Minswap's checks.
  'role-timelock lib': {
    ours: 'cardano/role-timelock/lib/amm_dex_v2',
    take: (p) => /^lib\/amm_dex_v2\/[^/]+\.ak$/.test(p),
    map: (p) => p.replace(/^lib\/amm_dex_v2\//, ''),
  },
};

/** Line endings aside: a Windows checkout may carry CRLF, and upstream does not. */
export const strip = (t) => t.replace(/\r$/gm, '');
export const sha256 = (t) => createHash('sha256').update(t).digest('hex');

function files(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** `sha256  path` lines, `#` comments, into a Map. */
export function readManifest(text) {
  const m = new Map();
  for (const line of strip(text).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const hit = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!hit) throw new Error(`manifest line is not "sha256  path": ${line}`);
    m.set(hit[2], hit[1]);
  }
  return m;
}

/** The manifest itself hashes to its pin. */
export function checkPins(upDir = UP_DIR) {
  const problems = [];
  for (const [f, pin] of Object.entries(PINNED)) {
    const got = existsSync(join(upDir, f)) ? sha256(strip(readFileSync(join(upDir, f), 'utf-8'))) : 'nothing';
    if (got !== pin) problems.push(`upstream/${f} hashes to ${got}, not the pinned ${pin}: re-pin only what --regenerate reproduces`);
  }
  return problems;
}

/** The reviewed patch: its hash is the pin, and it patches exactly the files DELTA names. */
export function readPatch(upDir = UP_DIR) {
  const problems = [];
  const path = join(upDir, DELTA.file);
  const text = existsSync(path) ? strip(readFileSync(path, 'utf-8')) : '';
  const got = text ? sha256(text) : 'nothing';
  if (got !== DELTA.sha256) problems.push(`upstream/${DELTA.file} hashes to ${got}, not the reviewed ${DELTA.sha256}: read it, then re-pin DELTA.sha256 in the same pull request`);
  let sections = new Map();
  try {
    sections = readDelta(text);
  } catch (e) {
    problems.push(`upstream/${DELTA.file}: ${e.message}`);
  }
  if ([...sections.keys()].join('|') !== DELTA.patched.join('|')) problems.push(`upstream/${DELTA.file} patches ${[...sections.keys()].join(', ')}, not exactly ${DELTA.patched.join(', ')}`);
  const changed = [...sections.values()].flat().filter((l) => /^[<>] /.test(l)).length;
  return { problems, sections, changed };
}

/** Upstream's text of one of our files: the reviewed patch undone where it applies. */
export function upstreamText(upstreamPath, oursText, sections = readPatch().sections) {
  return sections.has(upstreamPath) ? undoPatch(strip(oursText), sections.get(upstreamPath)) : strip(oursText);
}

/** One copy against the manifest and the patch. Returns problems (empty = pass) and counts. */
export function checkCopy(name, root = process.cwd(), upDir = UP_DIR) {
  const c = COPIES[name];
  const dir = resolve(root, c.ours);
  const manifest = readManifest(readFileSync(join(upDir, MANIFEST), 'utf-8'));
  const { sections } = readPatch(upDir);
  const expected = new Map([...manifest].filter(([p]) => c.take(p)).map(([p, h]) => [c.map(p), { up: p, hash: h }]));
  const problems = [];
  if (expected.size === 0) problems.push(`${MANIFEST} lists no file this copy takes`);
  if (!existsSync(dir)) return { problems: [...problems, `${c.ours} does not exist`], compared: 0 };
  const actual = files(dir);
  for (const f of actual) if (!expected.has(f)) problems.push(`${c.ours}/${f} is not an upstream file we take: our own code lives outside the copy`);
  let compared = 0;
  let patched = 0;
  for (const [f, { up, hash }] of expected) {
    if (!actual.includes(f)) {
      problems.push(`${c.ours}/${f} is missing`);
      continue;
    }
    compared++;
    let text;
    try {
      text = upstreamText(up, readFileSync(join(dir, f), 'utf-8'), sections);
    } catch (e) {
      problems.push(`${c.ours}/${f}: ${e.message}`);
      continue;
    }
    if (sections.has(up)) patched++;
    if (sha256(text) !== hash) problems.push(`${c.ours}/${f} differs from upstream ${sections.has(up) ? 'beyond the reviewed patch' : 'and is not a patched file'}`);
  }
  return { problems, compared, patched };
}

export function checkAll(root = process.cwd(), upDir = UP_DIR) {
  const patch = readPatch(upDir);
  const out = { problems: [...checkPins(upDir), ...patch.problems], lines: [] };
  for (const name of Object.keys(COPIES)) {
    const r = checkCopy(name, root, upDir);
    out.problems.push(...r.problems.map((p) => `${name}: ${p}`));
    if (!r.problems.length) out.lines.push(`${name} = ${REPO} @ ${COMMIT.slice(0, 8)} plus the reviewed patch (${r.compared} upstream files compared, ${r.patched} patched, ${patch.changed} changed lines)`);
  }
  return out;
}

function regenerate(scratch) {
  const dir = join(resolve(scratch), 'minswap-dex-v2');
  if (!existsSync(join(dir, '.git'))) {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', REPO, dir], { stdio: 'inherit' });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', COMMIT], { cwd: dir });
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  if (head !== COMMIT) throw new Error(`${dir} is at ${head}, not ${COMMIT}`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf-8' }).split('\n').filter(Boolean);
  const take = tracked.filter((p) => Object.values(COPIES).some((c) => c.take(p))).sort();
  const body = take.map((p) => `${sha256(strip(readFileSync(join(dir, p), 'utf-8')))}  ${p}`);
  const text = [`# ${REPO} @ ${COMMIT}, line endings stripped.`, '# Written by: node cardano/guards/provenance.mjs --regenerate <scratch dir>', ...body, ''].join('\n');
  writeFileSync(join(UP_DIR, MANIFEST), text);
  console.log(`${MANIFEST}: ${body.length} upstream files, sha256 ${sha256(text)}`);
  // The patch, as `diff upstream ours` prints it, for the files DELTA names in our main copy.
  const ours = COPIES['minswap-dex-v2'];
  const delta = DELTA.patched
    .map((p) => {
      const a = join(resolve(scratch), '.upstream');
      const b = join(resolve(scratch), '.ours');
      writeFileSync(a, strip(readFileSync(join(dir, p), 'utf-8')));
      writeFileSync(b, strip(readFileSync(join(ours.ours, ours.map(p)), 'utf-8')));
      let out = '';
      try {
        out = execFileSync('diff', [a, b], { encoding: 'utf-8' });
      } catch (e) {
        if (e.status !== 1) throw e;
        out = e.stdout;
      }
      return `=== ${p} ===\n${out}`;
    })
    .join('');
  writeFileSync(join(UP_DIR, DELTA.file), delta);
  console.log(`${DELTA.file}: sha256 ${sha256(delta)}${sha256(delta) === DELTA.sha256 ? ' (the pinned value)' : `, pinned ${DELTA.sha256}: re-pin only after reading the patch`}`);
  for (const p of checkPins()) console.log(p);
}

// Each tamper must be refused, so a guard that passes everything cannot pass CI.
function selfTest(root = process.cwd()) {
  const base = checkAll(root);
  if (base.problems.length) throw new Error(`the checkout itself fails, so a self-test proves nothing:\n${base.problems.join('\n')}`);
  // A tamper whose text is not in the file would test nothing, so it throws instead.
  const edit = (d, f, from, to) => {
    const t = readFileSync(join(d, f), 'utf-8');
    if (!t.includes(from)) throw new Error(`self-test tamper: ${f} has no "${from}"`);
    writeFileSync(join(d, f), t.replace(from, to));
  };
  const tampers = [
    ['an edited validator', (d) => edit(d, 'cardano/minswap-dex-v2/lib/amm_dex_v2/pool_validation.ak', 'pool_in_value == pool_out_value', 'True')],
    ['a trailing space', (d) => edit(d, 'cardano/minswap-dex-v2/validators/order_validator.ak', '\n', ' \n')],
    ['an added file', (d) => writeFileSync(join(d, 'cardano/minswap-dex-v2/validators/extra.ak'), 'validator { fn spend(_d: Data, _r: Data, _c: Data) { True } }\n')],
    ['a missing file', (d) => rmSync(join(d, 'cardano/minswap-dex-v2/lib/amm_dex_v2/math.ak'))],
    ['an edited deploy record', (d) => edit(d, 'cardano/minswap-dex-v2/deployed/mainnet/params.json', '"poolNFTName": "MSP"', '"poolNFTName": "MSQ"')],
    ['an edited library copy', (d) => edit(d, 'cardano/role-timelock/lib/amm_dex_v2/types.ak', 'admin: PoolAuthorizationMethod', 'admin: Data')],
    ['a second edit in the patched file', (d) => edit(d, 'cardano/minswap-dex-v2/lib/amm_dex_v2/utils.ak', 'max_fee_sharing_numerator = 5000', 'max_fee_sharing_numerator = 9000')],
    ['the patch undone in one copy', (d) => edit(d, 'cardano/role-timelock/lib/amm_dex_v2/utils.ak', 'min_fee_sharing_numerator = 1333', 'min_fee_sharing_numerator = 1666')],
    ['a lower floor than reviewed', (d) => edit(d, 'cardano/minswap-dex-v2/lib/amm_dex_v2/utils.ak', 'min_fee_sharing_numerator = 1333', 'min_fee_sharing_numerator = 1')],
    ['an edited patch', (d) => edit(d, `cardano/guards/upstream/${DELTA.file}`, '= 1333', '= 1')],
    ['the opening fee check removed', (d) => edit(d, 'cardano/minswap-dex-v2/validators/factory_validator.ak', '      pool_creation_fee_paid >= global_setting.pool_creation_fee,\n', '')],
    ['the opening fee counted at any address', (d) => edit(d, 'cardano/minswap-dex-v2/validators/factory_validator.ak', 'if out_addr == global_setting.pool_creation_fee_receiver {', 'if True {')],
    ['the opening fee fields out of step in one copy', (d) => edit(d, 'cardano/role-timelock/lib/amm_dex_v2/types.ak', 'pool_creation_fee: Int,', 'pool_creation_fee: Data,')],
    ['an added file beside the library copy', (d) => writeFileSync(join(d, 'cardano/role-timelock/lib/amm_dex_v2/extra.ak'), '')],
    ['an edited manifest', (d) => edit(d, `cardano/guards/upstream/${MANIFEST}`, '\n8', '\n0')],
  ];
  let failed = 0;
  for (const [what, tamper] of tampers) {
    const d = mkdtempSync(join(tmpdir(), 'cardano-prov-'));
    try {
      for (const p of ['cardano/minswap-dex-v2', 'cardano/role-timelock/lib/amm_dex_v2', 'cardano/guards/upstream']) cpSync(join(root, p), join(d, p), { recursive: true });
      tamper(d);
      const r = checkAll(d, join(d, 'cardano/guards/upstream'));
      if (r.problems.length) console.log(`refused ${what}: ${r.problems[0]}`);
      else (failed++, console.log(`::error::the guard passed ${what}`));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
  if (failed) process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--regenerate') return regenerate(argv[1] ?? '.');
  if (argv[0] === '--self-test') return selfTest();
  if (argv.length) throw new Error(`unknown argument ${argv[0]}`);
  const r = checkAll();
  console.log(`--- the reviewed patch (cardano/guards/upstream/${DELTA.file}) ---`);
  console.log(readFileSync(join(UP_DIR, DELTA.file), 'utf-8').trimEnd());
  console.log('---');
  for (const p of r.problems) console.log(`::error::${p}`);
  for (const l of r.lines) console.log(l);
  if (r.problems.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
