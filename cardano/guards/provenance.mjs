#!/usr/bin/env node
// Each copy is its pinned upstream files, unchanged, proved with no clone: upstream/<repo>.sha256
// holds the hash of every upstream file we take, at the pin. Any edit, added or missing file
// fails. Line endings aside, the bytes are upstream's.
//   node cardano/guards/provenance.mjs                         check (run from the repo root)
//   node cardano/guards/provenance.mjs --self-test             each tamper below is refused
//   node cardano/guards/provenance.mjs --regenerate <scratch>  re-derive upstream/ from a clone

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UP_DIR = join(HERE, 'upstream');

export const REPO = 'https://github.com/minswap/minswap-dex-v2';
// main on 2024-07-10, "Release the official version by Minswap Labs (#58)". Its validators are
// unchanged since CertiK's re-audit commit d299bd1.
export const COMMIT = 'c3293ad435792ba502f5a2b1691c6736e5f167e6';
export const MANIFEST = 'minswap-dex-v2.sha256';

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

/** One copy against the manifest. Returns problems (empty = pass) and how many files compared. */
export function checkCopy(name, root = process.cwd(), upDir = UP_DIR) {
  const c = COPIES[name];
  const dir = resolve(root, c.ours);
  const manifest = readManifest(readFileSync(join(upDir, MANIFEST), 'utf-8'));
  const expected = new Map([...manifest].filter(([p]) => c.take(p)).map(([p, h]) => [c.map(p), h]));
  const problems = [];
  if (expected.size === 0) problems.push(`${MANIFEST} lists no file this copy takes`);
  if (!existsSync(dir)) return { problems: [...problems, `${c.ours} does not exist`], compared: 0 };
  const actual = files(dir);
  for (const f of actual) if (!expected.has(f)) problems.push(`${c.ours}/${f} is not an upstream file we take: our own code lives outside the copy`);
  let compared = 0;
  for (const [f, up] of expected) {
    if (!actual.includes(f)) {
      problems.push(`${c.ours}/${f} is missing`);
      continue;
    }
    compared++;
    if (sha256(strip(readFileSync(join(dir, f), 'utf-8'))) !== up) problems.push(`${c.ours}/${f} differs from upstream: a vendored file is never edited`);
  }
  return { problems, compared };
}

export function checkAll(root = process.cwd(), upDir = UP_DIR) {
  const out = { problems: checkPins(upDir), lines: [] };
  for (const name of Object.keys(COPIES)) {
    const r = checkCopy(name, root, upDir);
    out.problems.push(...r.problems.map((p) => `${name}: ${p}`));
    if (!r.problems.length) out.lines.push(`${name} = ${REPO} @ ${COMMIT.slice(0, 8)} exactly (${r.compared} upstream files compared)`);
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
  for (const p of r.problems) console.log(`::error::${p}`);
  for (const l of r.lines) console.log(l);
  if (r.problems.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
