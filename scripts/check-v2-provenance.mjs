#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-v2-provenance.mjs — make the V2 lineage of the AMM fork MECHANICAL.
//
// Why this script exists (docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md, the
// "honest caveat" + remediation row 7):
//
//   TegridyPair / TegridyFactory / TegridyRouter are forks of Uniswap V2, but
//   Uniswap V2 was never on disk to diff against. Every V2 comparison in every
//   audit of these files was reasoned FROM MEMORY of the canonical 0.5.16
//   source. That means drift into V2's audited surface — the k-invariant, the
//   1/6 protocol-fee formula, the kLast lifecycle — is INVISIBLE: no review
//   can see "this line used to match upstream and now doesn't."
//
//   Vendoring alone does not fix that (a vendored copy nobody diffs against is
//   just more files). The property this gate enforces is stronger:
//
//     ANY change to the three contracts' V2-relevant text FAILS CI until the
//     change is deliberately re-pinned — and re-pinning produces a reviewable
//     snapshot delta that shows exactly which divergence from canonical V2
//     was added, changed, or removed.
//
// How it works:
//   1. contracts/provenance/upstream/ holds the canonical Uniswap v2-core and
//      v2-periphery sources at COMMIT-PINNED upstream revisions. Each file's
//      sha256 (of LF-normalized bytes) is pinned in upstream.lock.json, so the
//      vendored copies cannot be quietly edited to make a diff "pass".
//   2. Both sides are NORMALIZED: comments stripped, pragma lines dropped,
//      quotes canonicalized, an explicit per-target identifier rename table
//      applied (Tegridy* -> UniswapV2* vocabulary), `uint`->`uint256` /
//      `now`->`block.timestamp` alias folding, then re-chunked to one
//      statement per line so formatting and line-wrapping cannot create or
//      hide drift. Everything the normalizer does NOT erase is treated as a
//      real divergence.
//   3. The normalized diff (ours vs upstream) is compared BYTE-EXACT against a
//      committed snapshot under contracts/provenance/expected/. The snapshot
//      IS the machine-readable allowlist: every divergence from canonical V2
//      is a visible hunk in a reviewed file. The human-readable allowlist —
//      each deliberate divergence NAMED, with a one-line rationale and the
//      test that pins it — is contracts/provenance/PROVENANCE.md.
//
// Modes:
//   (default)            verify hashes + verify diffs match snapshots. No
//                        network. This is what CI runs.
//   --refresh            re-download every vendored file from its pinned
//                        commit (network!) and rewrite upstream.lock.json
//                        hashes. Used only by the pin-bump ritual below.
//   --update-snapshots   regenerate expected/*.expected.diff from the current
//                        tree. Every hunk that changes MUST get a matching
//                        PROVENANCE.md allowlist entry in the same commit.
//   --dump <dir>         write the normalized sides per target (debugging).
//
// Pin-bump ritual (mirrors the .gitmodules H-37 header for the submodules):
//   1. edit `commit` in contracts/provenance/upstream.lock.json
//   2. node scripts/check-v2-provenance.mjs --refresh
//   3. node scripts/check-v2-provenance.mjs --update-snapshots
//   4. review the snapshot delta; update PROVENANCE.md entries to match
//   5. commit lock + vendored files + snapshots + doc TOGETHER
//
// Deliberately NOT a cron job, and deliberately no network in check mode:
// schedules die in idle repos and a fetch can flake — this runs on every PR
// via contracts-ci.yml against in-repo, hash-pinned upstream copies.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROV = path.join(ROOT, 'contracts', 'provenance');
const LOCK_PATH = path.join(PROV, 'upstream.lock.json');

// ---------------------------------------------------------------------------
// Targets. `upstream` files are concatenated (in order) to form the canonical
// base; `renames` translate OUR identifiers into upstream vocabulary so pure
// renames vanish from the diff and everything else stays visible. Renames are
// whole-identifier (\b-anchored) — an unmapped Tegridy* identifier shows up
// as a divergence hunk, which is exactly the review prompt we want.
// ---------------------------------------------------------------------------
const TARGETS = [
  {
    name: 'TegridyPair',
    ours: 'contracts/src/TegridyPair.sol',
    upstream: [
      'upstream/v2-core/UniswapV2Pair.sol',
      'upstream/v2-core/UniswapV2ERC20.sol', // ours replaces this with OZ ERC20 — the deletion hunk pins what was dropped (incl. permit)
      'upstream/v2-core/Math.sol', //          ours replaces with solmate FixedPointMathLib.sqrt
      'upstream/v2-core/UQ112x112.sol', //     ours inlines Q112 constant arithmetic in _update()
    ],
    snapshot: 'expected/TegridyPair.expected.diff',
    renames: [
      ['ITegridyFactory', 'IUniswapV2Factory'],
      ['TegridyPair', 'UniswapV2Pair'],
      ['FixedPointMathLib', 'Math'],
    ],
  },
  {
    name: 'TegridyFactory',
    ours: 'contracts/src/TegridyFactory.sol',
    upstream: ['upstream/v2-core/UniswapV2Factory.sol'],
    snapshot: 'expected/TegridyFactory.expected.diff',
    renames: [
      ['TegridyFactory', 'UniswapV2Factory'],
      ['TegridyPair', 'UniswapV2Pair'],
    ],
  },
  {
    name: 'TegridyRouter',
    ours: 'contracts/src/TegridyRouter.sol',
    upstream: [
      'upstream/v2-periphery/UniswapV2Router02.sol',
      'upstream/v2-periphery/UniswapV2Library.sol', // ours inlines the library as internal functions
    ],
    snapshot: 'expected/TegridyRouter.expected.diff',
    renames: [
      ['ITegridyFactoryRouter', 'IUniswapV2Factory'],
      ['TegridyRouter', 'UniswapV2Router02'],
      ['TegridyPair', 'IUniswapV2Pair'],
      ['_pairFor', 'pairFor'],
      ['_getReserves', 'getReserves'],
      ['_getAmountOut', 'getAmountOut'],
      ['_getAmountIn', 'getAmountIn'],
      ['_sortTokens', 'sortTokens'],
      ['_calculateLiquidity', '_addLiquidity'],
    ],
  },
];

// Floors so this gate can never pass over nothing (a gate that compared two
// empty streams would report "no drift" — same false-green shape as the CI
// slice guards). Values are well under the real sizes (see PROVENANCE.md).
const MIN_OURS_LINES = 100;
const MIN_UPSTREAM_LINES = 30;

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
const readLf = (p) => fs.readFileSync(p, 'utf8').replace(/\r/g, '');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// String-aware scanner. A regex cannot strip comments safely (a `//` inside a
// string literal is not a comment), so: a character state machine that yields
// alternating code/string segments with comments dropped (block comments
// become one space so `a/*x*/b` cannot fuse). Keeping strings as separate
// segments matters twice over: identifier renames must NOT rewrite string
// contents (an import path or a revert message is data, and divergence in it
// must stay visible), and the upstream `"UniswapV2: "` revert-prefix fold must
// ONLY touch strings.
function scanSegments(src) {
  const segs = [];
  let code = '';
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (code) segs.push({ t: 'code', s: code });
    code = '';
  };
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && c2 === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      code += ' ';
    } else if (c === '"' || c === "'") {
      const quote = c;
      let body = '';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          body += src[i] + src[i + 1];
          i += 2;
        } else {
          body += src[i];
          i++;
        }
      }
      i++; // closing quote
      flush();
      segs.push({ t: 'str', quote, body });
    } else {
      code += c;
      i++;
    }
  }
  flush();
  return segs;
}

// One statement per line: whitespace-immune, wrap-immune. Everything that
// survives this is semantic text, and any change to it changes the diff.
function normalizeSource(raw, renames, { isUpstream = false } = {}) {
  const segs = scanSegments(raw.replace(/\r/g, ''));
  let s = '';
  for (const seg of segs) {
    if (seg.t === 'str') {
      let body = seg.body;
      // fold upstream's revert-message namespace prefix so requires that are
      // otherwise verbatim compare equal; OUR message text is never rewritten.
      if (isUpstream) body = body.replace(/^UniswapV2(?:Router|Library)?: /, '');
      // canonicalize to double quotes when that cannot change the literal
      s += seg.quote === "'" && !body.includes('"') ? `"${body}"` : seg.quote + body + seg.quote;
      continue;
    }
    let c = seg.s;
    for (const [from, to] of renames) {
      c = c.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), to);
    }
    // exact-alias folding only — nothing here can change semantics:
    c = c.replace(/\buint\b/g, 'uint256'); //  0.5's `uint` == `uint256`
    c = c.replace(/\bnow\b/g, 'block.timestamp'); // 0.5's `now` alias
    // ours inlines UniswapV2Library, so fold upstream's qualifier at callsites
    // (the `library UniswapV2Library {` declaration line itself stays visible)
    c = c.replace(/\bUniswapV2Library\s*\./g, '');
    s += c;
  }
  // pragma is a compiler directive, normalized away per the provenance finding
  // (0.5.16/0.6.6 vs 0.8.26 is a NAMED divergence in PROVENANCE.md, not a hunk).
  s = s.replace(/\bpragma\s+[^;]*;/g, '');
  // unbrace `import {A, B} from "p";` so the statement chunker below cannot
  // split one import across three lines.
  s = s.replace(/\bimport\s*\{\s*([^}]*?)\s*\}\s*from/g, 'import $1 from');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/([;{}])/g, '$1\n');
  return s
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+,/g, ',')
        .replace(/\s+;/g, ';'),
    )
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Myers diff (O(ND)) with self-verifying backtrack.
// ---------------------------------------------------------------------------
function diffLines(a, b) {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const off = MAX;
  let v = new Int32Array(2 * MAX + 2);
  const trace = [];
  let dFinal = -1;
  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off])) x = v[k + 1 + off];
      else x = v[k - 1 + off] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= N && y >= M) {
        dFinal = d;
        break;
      }
    }
    if (dFinal >= 0) break;
  }
  // backtrack
  const ops = [];
  let x = N;
  let y = M;
  for (let d = dFinal; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && pv[k - 1 + off] < pv[k + 1 + off])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = pv[prevK + off];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1], ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ t: '+', line: b[y - 1], bi: y - 1 });
      y--;
    } else {
      ops.push({ t: '-', line: a[x - 1], ai: x - 1 });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: a[x - 1], ai: x - 1, bi: y - 1 });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ t: '-', line: a[x - 1], ai: x - 1 });
    x--;
  }
  while (y > 0) {
    ops.push({ t: '+', line: b[y - 1], bi: y - 1 });
    y--;
  }
  ops.reverse();
  // self-check: a diff that cannot reconstruct its inputs must never gate.
  const ra = ops.filter((o) => o.t !== '+').map((o) => o.line);
  const rb = ops.filter((o) => o.t !== '-').map((o) => o.line);
  if (ra.join('\n') !== a.join('\n') || rb.join('\n') !== b.join('\n')) {
    throw new Error('internal error: diff backtrack failed reconstruction self-check');
  }
  return ops;
}

// Nearest enclosing declaration per line, for hunk labels.
function scopeLabels(lines) {
  const labels = new Array(lines.length);
  let cur = '(file head)';
  const declRe = /^(contract|abstract contract|library|interface|function|constructor|receive|fallback|modifier)\b/;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) {
      cur = lines[i].split('{')[0].trim().slice(0, 90);
    }
    labels[i] = cur;
  }
  return labels;
}

const CONTEXT = 2;

function renderDiff(ops, aLabels, bLabels, header) {
  const changed = ops.map((o) => o.t !== ' ');
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (changed[i]) {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep[j] = true;
    }
  }
  const out = [...header];
  let i = 0;
  let hunks = 0;
  let minus = 0;
  let plus = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && keep[j]) j++;
    const slice = ops.slice(i, j);
    const first = slice[0];
    const aStart = first.ai !== undefined ? first.ai + 1 : (slice.find((o) => o.ai !== undefined)?.ai ?? 0) + 1;
    const bStart = first.bi !== undefined ? first.bi + 1 : (slice.find((o) => o.bi !== undefined)?.bi ?? 0) + 1;
    const firstOurs = slice.find((o) => o.bi !== undefined);
    const firstUp = slice.find((o) => o.ai !== undefined);
    const label = firstOurs ? bLabels[firstOurs.bi] : firstUp ? aLabels[firstUp.ai] : '';
    hunks++;
    out.push(`@@ up:${aStart} ours:${bStart} @@ ${label}`);
    for (const o of slice) {
      if (o.t === '-') minus++;
      if (o.t === '+') plus++;
      out.push(`${o.t === ' ' ? '  ' : o.t + ' '}${o.line}`);
    }
    i = j;
  }
  return { text: out.join('\n') + '\n', hunks, minus, plus };
}

// ---------------------------------------------------------------------------
// Lock handling
// ---------------------------------------------------------------------------
function readLock() {
  if (!fs.existsSync(LOCK_PATH)) {
    throw new Error(`missing ${rel(LOCK_PATH)} — the upstream pin file is gone`);
  }
  return JSON.parse(readLf(LOCK_PATH));
}

function allLockFiles(lock) {
  const out = [];
  for (const [srcName, src] of Object.entries(lock.sources)) {
    for (const f of src.files) out.push({ srcName, src, ...f });
  }
  return out;
}

function verifyVendored(lock) {
  let ok = true;
  const expected = new Set();
  for (const f of allLockFiles(lock)) {
    const p = path.join(PROV, f.vendored);
    expected.add(rel(p));
    if (!fs.existsSync(p)) {
      fail(`vendored upstream file missing: ${rel(p)} (pinned in upstream.lock.json)`);
      ok = false;
      continue;
    }
    const h = sha256(readLf(p));
    if (h !== f.sha256) {
      fail(
        `vendored upstream file DOES NOT MATCH its pinned hash: ${rel(p)}\n` +
          `   pinned : ${f.sha256}\n` +
          `   actual : ${h}\n` +
          `   The canonical copies must never be edited by hand. To legitimately move the\n` +
          `   pin, follow the ritual in the header of scripts/check-v2-provenance.mjs.`,
      );
      ok = false;
    }
  }
  // no stray files: an unpinned .sol under upstream/ would look canonical to a
  // reviewer while being checked by nothing.
  const strays = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sol') && !expected.has(rel(p))) strays.push(rel(p));
    }
  })(path.join(PROV, 'upstream'));
  if (strays.length) {
    fail(
      `unpinned .sol file(s) under contracts/provenance/upstream/ — every vendored file must\n` +
        `   be hash-pinned in upstream.lock.json:\n   ${strays.join('\n   ')}`,
    );
    ok = false;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Target computation
// ---------------------------------------------------------------------------
function computeTarget(t, lock) {
  const oursPath = path.join(ROOT, t.ours);
  if (!fs.existsSync(oursPath)) throw new Error(`target source missing: ${t.ours}`);
  const oursLines = normalizeSource(readLf(oursPath), t.renames);

  const upLines = [];
  for (const vendored of t.upstream) {
    upLines.push(`==== FILE ${vendored} ====`);
    upLines.push(...normalizeSource(readLf(path.join(PROV, vendored)), [], { isUpstream: true }));
  }

  if (oursLines.length < MIN_OURS_LINES) {
    throw new Error(`${t.name}: normalized OUR side is only ${oursLines.length} lines (< ${MIN_OURS_LINES}) — refusing to compare near-nothing`);
  }
  if (upLines.length < MIN_UPSTREAM_LINES) {
    throw new Error(`${t.name}: normalized UPSTREAM side is only ${upLines.length} lines (< ${MIN_UPSTREAM_LINES}) — refusing to compare near-nothing`);
  }

  const ops = diffLines(upLines, oursLines);
  const pins = Object.entries(lock.sources)
    .map(([n, s]) => `${n}@${s.commit.slice(0, 12)}`)
    .join(', ');
  const header = [
    `# v2-provenance expected diff — ${t.name}`,
    `# ours     : ${t.ours} (identifiers renamed to upstream vocabulary; see TARGETS in scripts/check-v2-provenance.mjs)`,
    `# upstream : ${t.upstream.join(' + ')} (${pins})`,
    `# GENERATED by \`node scripts/check-v2-provenance.mjs --update-snapshots\`. NEVER hand-edit.`,
    `# Line numbers refer to the NORMALIZED one-statement-per-line streams, not source lines.`,
    `# Every hunk below is a pinned deliberate divergence from canonical Uniswap V2.`,
    `# The named allowlist (rationale + pinning test per divergence) is contracts/provenance/PROVENANCE.md.`,
  ];
  const rendered = renderDiff(ops, scopeLabels(upLines), scopeLabels(oursLines), header);
  return { ...rendered, oursLines, upLines };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
async function refresh(lock) {
  for (const f of allLockFiles(lock)) {
    const url = `https://raw.githubusercontent.com/${f.src.repo}/${f.src.commit}/${f.path}`;
    process.stdout.write(`fetch ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const body = (await res.text()).replace(/\r/g, '');
    const p = path.join(PROV, f.vendored);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  for (const [, src] of Object.entries(lock.sources)) {
    for (const f of src.files) {
      const p = path.join(PROV, f.vendored);
      f.sha256 = sha256(readLf(p));
    }
  }
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(`\nupstream.lock.json hashes rewritten. Next: --update-snapshots, then update PROVENANCE.md.`);
}

function main() {
  const args = process.argv.slice(2);
  const doRefresh = args.includes('--refresh');
  const doUpdate = args.includes('--update-snapshots');
  const dumpIx = args.indexOf('--dump');
  const dumpDir = dumpIx >= 0 ? args[dumpIx + 1] : null;

  const lock = readLock();

  const run = async () => {
    if (doRefresh) await refresh(lock);

    if (!verifyVendored(lock)) {
      console.error('\nupstream integrity check FAILED — not comparing against untrusted copies.');
      process.exit(1);
    }

    let allOk = true;
    for (const t of TARGETS) {
      const got = computeTarget(t, lock);
      // "compared nothing" guard: every target is a heavy fork, so a tiny
      // changed-line volume means the comparison did not measure what it
      // claims to (hunk COUNT is the wrong metric — context merging collapses
      // many divergences into few hunks).
      if (got.minus + got.plus < 20) {
        fail(`${t.name}: only ${got.minus + got.plus} changed lines vs upstream — below any plausible floor for this fork; the comparison did not measure what it claims to measure`);
        allOk = false;
        continue;
      }
      const snapPath = path.join(PROV, t.snapshot);

      if (dumpDir) {
        fs.mkdirSync(dumpDir, { recursive: true });
        fs.writeFileSync(path.join(dumpDir, `${t.name}.ours.txt`), got.oursLines.join('\n') + '\n');
        fs.writeFileSync(path.join(dumpDir, `${t.name}.upstream.txt`), got.upLines.join('\n') + '\n');
      }

      if (doUpdate) {
        fs.mkdirSync(path.dirname(snapPath), { recursive: true });
        fs.writeFileSync(snapPath, got.text);
        console.log(`updated ${rel(snapPath)}  (${got.hunks} hunks, -${got.minus}/+${got.plus})`);
        continue;
      }

      if (!fs.existsSync(snapPath)) {
        fail(
          `${t.name}: pinned snapshot missing (${rel(snapPath)}).\n` +
            `   Run \`node scripts/check-v2-provenance.mjs --update-snapshots\`, review every hunk,\n` +
            `   and add/adjust the matching PROVENANCE.md allowlist entries in the same commit.`,
        );
        allOk = false;
        continue;
      }
      const want = readLf(snapPath).replace(/\n+$/, '');
      const have = got.text.replace(/\n+$/, '');
      if (want === have) {
        console.log(`✅ ${t.name}: matches pinned divergence set (ours ${got.oursLines.length} stmts vs upstream ${got.upLines.length}; ${got.hunks} hunks, -${got.minus}/+${got.plus})`);
        continue;
      }
      allOk = false;
      const meta = diffLines(want.split('\n'), have.split('\n'));
      const metaChanged = meta.filter((o) => o.t !== ' ');
      fail(
        `${t.name}: V2 divergence set CHANGED — the normalized diff against canonical Uniswap V2\n` +
          `   no longer matches ${rel(snapPath)}.\n` +
          `   This gate fires on ANY change to ${t.ours} that survives normalization — that is its job.\n` +
          `   If the change is deliberate: re-pin with --update-snapshots AND name the divergence in\n` +
          `   contracts/provenance/PROVENANCE.md (rationale + the test that pins it) in the same commit.\n` +
          `   If you did not mean to drift from V2: fix the source instead.\n` +
          `   Delta vs pinned snapshot (- expected / + now produced), ${metaChanged.length} changed lines:`,
      );
      let printed = 0;
      for (const o of meta) {
        if (o.t === ' ') continue;
        console.error(`   ${o.t} ${o.line}`);
        if (++printed >= 120) {
          console.error(`   … truncated (${metaChanged.length - printed} more changed lines)`);
          break;
        }
      }
    }

    if (!doUpdate) {
      if (!allOk) process.exit(1);
      console.log(`\n✅ V2 provenance: all ${TARGETS.length} targets match their pinned divergence sets.`);
    } else {
      console.log(
        `\n⚠️  Snapshots regenerated. EVERY changed hunk is a claim of deliberate V2 divergence:\n` +
          `   update contracts/provenance/PROVENANCE.md (name + rationale + pinning test) in the SAME commit,\n` +
          `   or the allowlist goes stale and this gate degrades into the memory-diffing it replaced.`,
      );
    }
  };

  run().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}

main();
