#!/usr/bin/env node
// Each copied program is its pinned upstream plus exactly the reviewed identity patch, proved
// with no clone: upstream/<repo>.sha256 holds every upstream file's hash at the pin, and
// upstream/<copy>.diff the patch, whose own hash is pinned below. Undoing the patch on our file
// must give back upstream's hash; every other file must hash to upstream's; no file is added.
//   node solana/guards/provenance.mjs [<copy>...] [--ours <dir>]   check (run from the repo root)
//   node solana/guards/provenance.mjs --regenerate <scratch dir>   re-derive upstream/ from clones

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeKey, scanTree } from './key-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UP_DIR = join(HERE, 'upstream');

// What --regenerate wrote from fresh clones at the pins. Editing a file in upstream/ means
// re-pinning it here too, and a reviewer can reproduce each value with --regenerate.
export const PINNED = {
  'raydium-clmm.sha256': '522f72803ccc79b84790c66b8b654301093b720851d972dc7e834479cc01e91e',
  'parity-common-uint.sha256': 'aa732379604aad5b429692a1f312b25863c10f795e20ab526457309bacc7e97a',
  'raydium-cp-swap.sha256': 'b695714e31afd52e7ac6a68b661c9c97ac77ae994502ba1aa636bd8abef10d53',
  'deny-keys.txt': '5c9632f8614d0ffbe3044638891234ad86ceed6006f25bba081065e025224111',
};

export const COPIES = {
  // The live mainnet program CAMMCzo5... was last deployed at slot 451,479,902 (2026-09-29
  // 00:27 UTC) and carries text that first appears in this commit's tree.
  'tegridy-clmm': {
    ours: 'solana/tegridy-clmm',
    repo: 'https://github.com/raydium-io/raydium-clmm',
    commit: 'ed1eb41519d5355755f7df52b43fa9610938b60b',
    manifest: 'raydium-clmm.sha256',
    take: (p) => p.startsWith('programs/amm/') || ['Anchor.toml', 'Cargo.toml', 'Cargo.lock', 'LICENSE'].includes(p),
    map: (p) => p,
    delta: 'tegridy-clmm.diff',
    deltaSha256: '97a0a612ff4781ee3f864476bd1da5e5f9cf996a7c75fd290cdcc0be943ea693',
    patched: [
      'Anchor.toml',
      'Cargo.toml',
      'programs/amm/Cargo.toml',
      'programs/amm/src/lib.rs',
      'programs/amm/src/instructions/admin/collect_fund_fee.rs',
      'programs/amm/src/instructions/admin/create_amm_config.rs',
      'programs/amm/src/instructions/admin/create_permission_pda.rs',
      'programs/amm/src/instructions/admin/create_support_mint_associated.rs',
      'programs/amm/src/instructions/admin/transfer_reward_owner.rs',
      'programs/amm/src/instructions/admin/update_amm_config.rs',
      'programs/amm/src/instructions/collect_remaining_rewards.rs',
      'programs/amm/src/instructions/decrease_liquidity.rs',
      'programs/amm/src/instructions/open_position.rs',
      'programs/amm/src/instructions/swap_v2.rs',
      'programs/amm/src/states/config.rs',
      'programs/amm/src/states/pool_fee.rs',
      'programs/amm/src/states/tickarray_bitmap_extension.rs',
      'programs/amm/src/util/token.rs',
    ],
    oursOnly: ['README.md'],
    nested: ['vendor/uint'],
    // Raydium's lock pruned to the program's own crates, with uint read from vendor/uint.
    // Any change, even to a version upstream's lock also lists, needs a re-pin here.
    lock: { file: 'Cargo.lock', sha256: '1409dfcddb562ac832b9764b09a6123d2c75e2ef2e4173b86a3312bc44735478' },
  },
  // Raydium's fork of uint 0.9.5 (MIT OR Apache-2.0), the commit tegridy-clmm's lock named.
  uint: {
    ours: 'solana/tegridy-clmm/vendor/uint',
    repo: 'https://github.com/raydium-io/parity-common',
    commit: '43a0303b9c2a23a00508816bd6d5a2e9381f143c',
    manifest: 'parity-common-uint.sha256',
    take: (p) => p.startsWith('uint/') || p === 'LICENSE-APACHE2' || p === 'LICENSE-MIT',
    map: (p) => p.replace(/^uint\//, ''),
    patched: [],
    oursOnly: [],
  },
  // The program on mainnet since 2026-09-26. The pin's history is in the commit bodies of
  // .github/workflows/solana-ci.yml, where this hash lived until 2026-10-14.
  'cp-swap': {
    ours: 'solana/tegridy-amm/programs/cp-swap',
    repo: 'https://github.com/raydium-io/raydium-cp-swap',
    commit: '78f254e1023751e706df7dc15c453fc3e046697c',
    manifest: 'raydium-cp-swap.sha256',
    take: (p) => p.startsWith('programs/cp-swap/'),
    map: (p) => p.replace(/^programs\/cp-swap\//, ''),
    delta: 'cp-swap.diff',
    deltaSha256: '42f378caa75f89b554596067e20898ce9dbc6a02af9d51d2086bc0c5ffc4251e',
    patched: ['src/lib.rs', 'src/instructions/admin/create_support_mint_associated.rs', 'src/instructions/initialize.rs', 'Cargo.toml'],
    oursOnly: [],
    // The workspace cargo builds cp-swap in. Its manifest (patch tables, the release profile,
    // members) is pinned whole; its lock, for the crates cp-swap compiles; programs/ holds only
    // these folders, since each one there joins the workspace.
    workspace: {
      dir: 'solana/tegridy-amm',
      manifest: { file: 'Cargo.toml', sha256: '507aabe0bca91903c94d71f7dc259919b3f02f1eed82eaa664c2f0c0ad10e1a2' },
      lock: { file: 'Cargo.lock', root: 'raydium-cp-swap', sha256: '2fafdb6b101e39ab4f42dbe52c6f62c648da217b91e453e3473c71f945f189c0' },
      programs: ['bayla-ladder', 'cp-swap', 'tegridy-launch'],
    },
  },
};

// A pull request that changes a file in solana/guards/ (a pin, the reviewed patch, the
// allow-list, a guard) may change only these, so the person reading it reads nothing else.
export const REPIN_MAY_TOUCH = [
  'solana/guards/',
  ...Object.values(COPIES).map((c) => `${c.ours}/`),
  'solana/tegridy-amm/Cargo.toml',
  'solana/tegridy-amm/Cargo.lock',
  'solana/tegridy-amm/TEGRIDY_FORK.md',
  // A patch that changes behaviour carries its validator test (solana-ci.yml runs them).
  'solana/tegridy-amm/tests/',
  'docs/RANGE_POOLS_PLAN.md',
  'CHANGELOG.md',
  'frontend/src/test/solanaGuardTampers.test.ts',
  'frontend/src/test/solanaKeyGuard.test.ts',
  '.github/workflows/solana-ci.yml',
];

/** Line endings aside: the copies carry CRLF in places, and upstream does not. */
export const strip = (t) => t.replace(/\r$/gm, '');
export const sha256 = (t) => createHash('sha256').update(t).digest('hex');

function files(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name === '.git') continue;
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

/** The delta file's sections: path -> its `diff` output (normal format). */
export function readDelta(text) {
  const sections = new Map();
  let cur = null;
  for (const line of strip(text).split('\n')) {
    const h = /^=== (.+) ===$/.exec(line);
    if (h) {
      cur = h[1];
      sections.set(cur, []);
    } else if (cur !== null) sections.get(cur).push(line);
    else if (line !== '') throw new Error(`delta text before the first section: ${line}`);
  }
  for (const [k, v] of sections) {
    while (v.length && v[v.length - 1] === '') v.pop();
    sections.set(k, v);
  }
  return sections;
}

function lines(t) {
  if (t === '') return { lines: [], eol: true };
  const parts = t.split('\n');
  const eol = parts[parts.length - 1] === '';
  if (eol) parts.pop();
  return { lines: parts, eol };
}

/**
 * Upstream's text, from our file and the `diff upstream ours` hunks for it. Strict: every line
 * a hunk says we added must be in our file exactly where it says, or this throws.
 */
export function undoPatch(oursText, hunkLines) {
  const hunks = [];
  let h = null;
  let block = null;
  for (const line of hunkLines) {
    const head = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(line);
    if (head) {
      const [a1, a2, op, b1, b2] = [+head[1], +(head[2] ?? head[1]), head[3], +head[4], +(head[5] ?? head[4])];
      h = { old: [], new: [], oldNoEol: false, newNoEol: false };
      h.oldStart = op === 'a' ? a1 + 1 : a1;
      h.oldCount = op === 'a' ? 0 : a2 - a1 + 1;
      h.newStart = op === 'd' ? b1 + 1 : b1;
      h.newCount = op === 'd' ? 0 : b2 - b1 + 1;
      hunks.push(h);
      block = null;
    } else if (h && line.startsWith('< ')) (block = 'old'), h.old.push(line.slice(2));
    else if (h && line.startsWith('> ')) (block = 'new'), h.new.push(line.slice(2));
    else if (h && line === '---') block = null;
    else if (h && block && line === '\\ No newline at end of file') h[`${block}NoEol`] = true;
    else throw new Error(`not a line of a normal diff: ${line}`);
  }
  const ours = lines(oursText);
  const out = [];
  let p = 0;
  let upEol = ours.eol;
  for (const k of hunks) {
    if (k.old.length !== k.oldCount || k.new.length !== k.newCount) throw new Error(`hunk at ${k.newStart} has the wrong line count`);
    const at = k.newStart - 1;
    if (at < p || at + k.newCount > ours.lines.length) throw new Error(`hunk at ${k.newStart} is outside our file`);
    out.push(...ours.lines.slice(p, at));
    if (out.length !== k.oldStart - 1) throw new Error(`hunk at ${k.newStart} does not line up with upstream's line ${k.oldStart}`);
    for (let i = 0; i < k.newCount; i++) {
      if (ours.lines[at + i] !== k.new[i]) throw new Error(`our line ${at + i + 1} is not the reviewed one`);
    }
    const reachesEnd = at + k.newCount === ours.lines.length;
    if (k.newCount > 0 && reachesEnd && k.newNoEol !== !ours.eol) throw new Error('our last line ending is not the reviewed one');
    out.push(...k.old);
    p = at + k.newCount;
    if (reachesEnd) upEol = k.old.length ? !k.oldNoEol : k.newCount ? true : ours.eol;
  }
  out.push(...ours.lines.slice(p));
  return out.length ? out.join('\n') + (upEol ? '\n' : '') : '';
}

/** Every file in upstream/ that --regenerate writes still hashes to its pin. */
export function checkPins() {
  const problems = [];
  for (const [f, pin] of Object.entries(PINNED)) {
    const got = existsSync(join(UP_DIR, f)) ? sha256(strip(readFileSync(join(UP_DIR, f), 'utf-8'))) : 'nothing';
    if (got !== pin) problems.push(`upstream/${f} hashes to ${got}, not the pinned ${pin}: re-pin only what --regenerate reproduces`);
  }
  return problems;
}

/** `name version source checksum` of every crate `root` builds with in a Cargo.lock, sorted. */
export function lockClosure(lock, root) {
  const pkgs = strip(lock)
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .map((b) => {
      const get = (k) => new RegExp(`^${k} = "([^"]*)"$`, 'm').exec(b)?.[1] ?? '';
      const deps = /^dependencies = \[([^\]]*)\]/m.exec(b)?.[1] ?? '';
      return { name: get('name'), version: get('version'), source: get('source'), checksum: get('checksum'), deps: [...deps.matchAll(/"([^"]+)"/g)].map((m) => m[1]) };
    });
  const find = (spec) => {
    const [, name, version, source] = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(spec) ?? [];
    const hits = pkgs.filter((p) => p.name === name && (!version || p.version === version) && (!source || p.source === source));
    if (hits.length !== 1) throw new Error(`names the dependency "${spec}", which matches ${hits.length} crates`);
    return hits[0];
  };
  const start = pkgs.filter((p) => p.name === root && !p.source);
  if (start.length !== 1) throw new Error(`holds ${start.length} local crates named ${root}`);
  const seen = new Set();
  for (const todo = [start[0]]; todo.length; ) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    todo.push(...p.deps.map(find));
  }
  return [...seen].map((p) => [p.name, p.version, p.source, p.checksum].join(' ')).sort();
}

/** The workspace a copy builds in: manifest, the copy's crates in the lock, its members. */
export function checkWorkspace(w, root) {
  const dir = resolve(root, w.dir);
  const read = (f) => (existsSync(join(dir, f)) ? strip(readFileSync(join(dir, f), 'utf-8')) : null);
  const problems = [];
  const manifest = read(w.manifest.file);
  const got = manifest === null ? 'nothing' : sha256(manifest);
  if (got !== w.manifest.sha256) problems.push(`${w.dir}/${w.manifest.file} hashes to ${got}, not the pinned ${w.manifest.sha256}: it sets how the program builds (patch tables, release profile, members), so a change needs a re-pin here`);
  let crates = [];
  try {
    const lock = read(w.lock.file);
    if (lock === null) throw new Error('is missing');
    crates = lockClosure(lock, w.lock.root);
    const h = sha256(crates.join('\n'));
    if (h !== w.lock.sha256) problems.push(`the ${crates.length} crates ${w.lock.root} builds with in ${w.dir}/${w.lock.file} hash to ${h}, not the pinned ${w.lock.sha256}: re-pin only after reading which crate changed`);
  } catch (e) {
    problems.push(`${w.dir}/${w.lock.file} ${e.message}`);
  }
  const progs = existsSync(join(dir, 'programs')) ? readdirSync(join(dir, 'programs')).sort() : [];
  if (progs.join('|') !== w.programs.join('|')) problems.push(`${w.dir}/programs holds ${progs.join(', ')}, not exactly ${w.programs.join(', ')}: each folder there joins the workspace`);
  return { problems, crates: crates.length };
}

/** A clean checkout has no build folder, and cargo may reuse what one holds: refuse its files. */
export function committedBuildFiles(dirs, root) {
  const present = dirs.filter((d) => existsSync(d));
  if (!present.length) return [];
  let top = null;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    top = null;
  }
  const problems = [];
  for (const d of present) {
    const rel = relative(resolve(root), d).split(sep).join('/');
    const tracked = top !== null && relative(resolve(top), resolve(root)) === '' && !rel.startsWith('..') && !isAbsolute(rel);
    const found = tracked ? git(['ls-files', '-z', '--', rel], root).split('\0').filter(Boolean) : files(d).map((f) => `${rel}/${f}`);
    for (const f of found) problems.push(`${f} is in a build folder ${tracked ? 'and is committed' : 'outside a git checkout'}: cargo may reuse it`);
  }
  return problems;
}

/** `git diff --name-status` of a pull request: one that changes solana/guards/ changes nothing else. */
export function repinAlone(nameStatus) {
  const rows = strip(nameStatus).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const pins = rows.filter(([s, p]) => p?.startsWith('solana/guards/') && s !== 'A').map(([, p]) => p);
  if (!pins.length) return [];
  const mayTouch = (p) => REPIN_MAY_TOUCH.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
  return rows.map(([, p]) => p).filter((p) => !mayTouch(p)).map((p) => `${p}: this pull request changes ${pins.join(', ')}, so it may change nothing outside solana/guards/ and the programs they pin`);
}

/** Check one copy. Returns problems (empty = pass) and what was compared. */
export function checkCopy(name, oursDir, root = process.cwd()) {
  const c = COPIES[name];
  const dir = resolve(root, oursDir ?? c.ours);
  const problems = [];
  const manifest = readManifest(readFileSync(join(UP_DIR, c.manifest), 'utf-8'));
  if (manifest.size === 0) problems.push(`${c.manifest} lists no file`);
  let sections = new Map();
  let changed = 0;
  if (c.delta) {
    const text = readFileSync(join(UP_DIR, c.delta), 'utf-8');
    const got = sha256(strip(text));
    if (got !== c.deltaSha256) {
      problems.push(`${c.delta} hashes to ${got}, not the reviewed ${c.deltaSha256}. Read it; if it is still identity only, re-pin deltaSha256 in provenance.mjs in the same pull request`);
    }
    sections = readDelta(text);
    changed = [...sections.values()].flat().filter((l) => /^[<>] /.test(l)).length;
    const listed = [...sections.keys()].join('|');
    if (listed !== c.patched.join('|')) problems.push(`${c.delta} patches ${listed}, not exactly ${c.patched.join('|')}`);
  }
  if (!existsSync(dir)) return { problems: [...problems, `${dir} does not exist`], compared: 0, changed };

  const nested = (c.nested ?? []).map((n) => `${n}/`);
  const actual = files(dir).filter((f) => !f.startsWith('target/') && !nested.some((n) => f.startsWith(n)));
  const expected = new Set([...manifest.keys(), ...c.oursOnly]);
  for (const f of actual) if (!expected.has(f)) problems.push(`${f} is in our copy but is not upstream's, and no rule names it as ours`);
  for (const f of expected) if (!actual.includes(f)) problems.push(`${f} is missing from our copy`);
  for (const n of c.nested ?? []) if (!Object.values(COPIES).some((o) => o.ours === `${c.ours}/${n}`)) problems.push(`${n} is nested but no copy checks it`);

  let compared = 0;
  for (const [f, upHash] of manifest) {
    if (!actual.includes(f)) continue;
    compared++;
    const text = strip(readFileSync(join(dir, f), 'utf-8'));
    if (c.lock && f === c.lock.file) {
      const got = sha256(text);
      if (got !== c.lock.sha256) problems.push(`${f} hashes to ${got}, not the pinned ${c.lock.sha256}: a lock change needs a re-pin after --regenerate proves it is upstream's crates`);
      continue;
    }
    if (sections.has(f)) {
      let up;
      try {
        up = undoPatch(text, sections.get(f));
      } catch (e) {
        problems.push(`${f}: ${e.message}`);
        continue;
      }
      if (sha256(up) !== upHash) problems.push(`${f} differs from upstream beyond the reviewed patch`);
    } else if (sha256(text) !== upHash) {
      problems.push(`${f} differs from upstream and is not a patched file`);
    }
  }
  for (const f of sections.keys()) if (!manifest.has(f)) problems.push(`${c.delta} patches ${f}, which upstream does not have`);
  const ws = c.workspace ? checkWorkspace(c.workspace, root) : null;
  if (ws) problems.push(...ws.problems);
  problems.push(...committedBuildFiles([join(dir, 'target'), ...(ws ? [resolve(root, c.workspace.dir, 'target')] : [])], root));
  return { problems, compared, changed, patched: sections.size, crates: ws?.crates };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function diffNormal(a, b, scratch) {
  const fa = join(scratch, '.a');
  const fb = join(scratch, '.b');
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  try {
    return execFileSync('diff', [fa, fb], { encoding: 'utf-8' });
  } catch (e) {
    if (e.status === 1) return e.stdout;
    throw e;
  }
}

/** crate name|version|source|checksum lines of a Cargo.lock. */
export function crates(lock) {
  const out = new Set();
  for (const block of strip(lock).split('[[package]]').slice(1)) {
    const get = (k) => new RegExp(`^${k} = (.*)$`, 'm').exec(block)?.[1] ?? '';
    out.add([get('name'), get('version'), get('source'), get('checksum')].join('|'));
  }
  return out;
}

function regenerate(scratch, root) {
  mkdirSync(scratch, { recursive: true });
  const clones = {};
  for (const [name, c] of Object.entries(COPIES)) {
    const dir = join(scratch, name);
    if (!existsSync(join(dir, '.git'))) {
      execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', c.repo, dir], { stdio: 'inherit' });
      git(['-c', 'core.autocrlf=false', 'checkout', '--quiet', c.commit], dir);
    }
    if (git(['rev-parse', 'HEAD'], dir) !== c.commit) throw new Error(`${dir} is not at ${c.commit}`);
    clones[name] = dir;
    const taken = files(dir).filter(c.take);
    const body = taken.map((p) => `${sha256(strip(readFileSync(join(dir, p), 'utf-8')))}  ${c.map(p)}`).sort((x, y) => (x.slice(66) < y.slice(66) ? -1 : 1));
    writeFileSync(
      join(UP_DIR, c.manifest),
      [`# ${c.repo} @ ${c.commit}, line endings stripped.`, '# Written by: node solana/guards/provenance.mjs --regenerate <scratch dir>', ...body, ''].join('\n'),
    );
    console.log(`${c.manifest}: ${body.length} upstream files`);
    if (c.delta) {
      const text = c.patched
        .map((f) => {
          const up = strip(readFileSync(join(dir, taken.find((p) => c.map(p) === f)), 'utf-8'));
          return `=== ${f} ===\n${diffNormal(up, strip(readFileSync(join(root, c.ours, f), 'utf-8')), scratch)}`;
        })
        .join('');
      writeFileSync(join(UP_DIR, c.delta), text);
      const got = sha256(text);
      console.log(`${c.delta}: sha256 ${got}${got === c.deltaSha256 ? ' (the pinned value)' : `, pinned ${c.deltaSha256}: re-pin only after reading the delta`}`);
    }
  }
  // tegridy-clmm's lock: upstream's crates only, uint now from vendor/ at the commit it named.
  const c = COPIES['tegridy-clmm'];
  const oursLock = strip(readFileSync(join(root, c.ours, c.lock.file), 'utf-8'));
  const upLock = crates(readFileSync(join(clones['tegridy-clmm'], 'Cargo.lock'), 'utf-8'));
  const uintUp = [...upLock].filter((l) => l.startsWith('"uint"|'));
  const extra = [...crates(oursLock)].filter((l) => {
    if (upLock.has(l)) return false;
    const [n, v, s, sum] = l.split('|');
    return !(n === '"uint"' && s === '' && sum === '' && uintUp.join() === `"uint"|${v}|"git+${COPIES.uint.repo}#${COPIES.uint.commit}"|`);
  });
  if (extra.length) throw new Error(`Cargo.lock names crates upstream's lock does not:\n${extra.join('\n')}`);
  const lockHash = sha256(oursLock);
  console.log(`Cargo.lock: ${crates(oursLock).size} crates, all upstream's; sha256 ${lockHash}${lockHash === c.lock.sha256 ? ' (the pinned value)' : `, pinned ${c.lock.sha256}`}`);
  // The keys both pinned upstreams hard-code, less the system addresses anyone may name.
  const allow = JSON.parse(readFileSync(join(HERE, 'allowed-keys.json'), 'utf-8'));
  const deny = new Set();
  for (const name of ['tegridy-clmm', 'cp-swap']) for (const k of scanTree(clones[name]).keys.keys()) if (!allow.system?.[k] && decodeKey(k)) deny.add(k);
  const head = ['# Keys the two pinned upstreams hard-code (whole repositories), less the system addresses', '# allowed-keys.json names. Any of them in our copies fails key-guard.mjs.'];
  head.push(`# ${COPIES['tegridy-clmm'].repo} @ ${COPIES['tegridy-clmm'].commit}`, `# ${COPIES['cp-swap'].repo} @ ${COPIES['cp-swap'].commit}`);
  head.push('# Written by: node solana/guards/provenance.mjs --regenerate <scratch dir>');
  writeFileSync(join(UP_DIR, 'deny-keys.txt'), [...head, ...[...deny].sort(), ''].join('\n'));
  console.log(`deny-keys.txt: ${deny.size} keys`);
  for (const p of checkPins()) console.log(p);
  console.log('Now: git diff --stat solana/guards/upstream (no change = the committed files are upstream\'s)');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--regenerate') return regenerate(resolve(argv[1] ?? '.'), process.cwd());
  if (argv[0] === '--pr-files') {
    const problems = repinAlone(readFileSync(argv[1], 'utf-8'));
    for (const p of problems) console.log(`::error::${p}`);
    if (problems.length) process.exit(1);
    return console.log('no pin, patch, allow-list or guard changed alongside other work');
  }
  const names = [];
  let oursDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ours') oursDir = argv[++i];
    else if (COPIES[argv[i]]) names.push(argv[i]);
    else throw new Error(`unknown argument ${argv[i]}; copies: ${Object.keys(COPIES).join(', ')}`);
  }
  if (oursDir && names.length !== 1) throw new Error('--ours needs exactly one copy');
  const pins = checkPins();
  for (const p of pins) console.log(`::error::${p}`);
  let fail = pins.length > 0;
  for (const name of names.length ? names : Object.keys(COPIES)) {
    const c = COPIES[name];
    const r = checkCopy(name, oursDir);
    if (c.delta) {
      console.log(`--- ${name}: the reviewed patch (solana/guards/upstream/${c.delta}) ---`);
      console.log(readFileSync(join(UP_DIR, c.delta), 'utf-8').trimEnd());
      console.log('---');
    }
    for (const p of r.problems) console.log(`::error::${name}: ${p}`);
    if (r.problems.length) fail = true;
    else {
      const lock = c.lock ? `, ${c.lock.file} pinned` : r.crates ? `; workspace ${c.workspace.dir}: Cargo.toml pinned, the ${r.crates} crates it builds with in Cargo.lock pinned, programs/ exact` : '';
      const how = c.delta ? 'plus the reviewed patch' : 'exactly';
      console.log(`${name} = ${c.repo} @ ${c.commit.slice(0, 8)} ${how} (${r.compared} upstream files compared, ${r.patched ?? 0} patched, ${r.changed} changed lines${lock})`);
    }
  }
  if (fail) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
