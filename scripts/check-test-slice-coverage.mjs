#!/usr/bin/env node
/**
 * Contracts CI test-slice coverage guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.github/workflows/contracts-ci.yml` runs the Foundry suite as a matrix of
 * `forge test --match-path <glob>` slices. That design has one silent failure
 * mode, and this repo has now hit it twice:
 *
 *   1. 2026-05-23 — every slice pattern was written in REGEX syntax. forge
 *      treats `--match-path` as a GLOB, so all six matched zero files. forge
 *      prints "No tests found in project!" and EXITS 0, so all six jobs went
 *      green while running nothing.
 *
 *   2. 2026-07-28 — every pattern is `test/<prefix>*.t.sol`, and a glob `*`
 *      does not cross `/`. So `test/v4/`, `test/pass5_pocs/` — and ten
 *      top-level files whose prefixes nobody added to a brace list — were
 *      never run. `TegridyV4Hook.t.sol::test_admin_discountConfigTimelockFlow`
 *      had been red since commit 38aaad2 (2026-06-07) and CI never noticed.
 *
 * Both are the same defect: the pattern list drifts away from the file tree
 * and NOTHING fails. `forge test` exiting 0 on an empty match is the root
 * cause, so a guard cannot be built out of forge's exit code alone.
 *
 * WHAT IT CHECKS
 * --------------
 *   coverage   every contracts/test/**\/*.t.sol is claimed by exactly one
 *              slice, or by an explicit `excluded` entry with a reason.
 *   dead       every slice/excluded pattern matches at least one file (this
 *              is the direct guard against failure mode 1).
 *   overlap    no file is claimed by two slices (double-run / unbalanced), and
 *              no file is both sliced and excluded (contradiction).
 *
 * The workflow additionally cross-checks this script's per-slice prediction
 * against forge's own `--list --json` output inside each slice job (see the
 * "Slice guard" step). That is what keeps the glob subset implemented below
 * honest: if it ever diverges from forge's `globset` semantics, the slice job
 * fails loudly instead of this script quietly over-claiming a file.
 *
 * Zero npm dependencies — Node builtins only, same as
 * scripts/check-interface-selectors.mjs, so CI needs no `npm ci`.
 *
 * USAGE
 *   node scripts/check-test-slice-coverage.mjs                # check (default)
 *   node scripts/check-test-slice-coverage.mjs --emit-matrix  # GH Actions matrix JSON
 *   node scripts/check-test-slice-coverage.mjs --emit-filter  # the --no-match-test regex
 *   node scripts/check-test-slice-coverage.mjs --expect <slice>  # predicted files, one per line
 *   node scripts/check-test-slice-coverage.mjs --verify-slice <slice>  # needs forge on PATH
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO_ROOT, '.github', 'contracts-test-slices.json');
const TEST_ROOT = join(REPO_ROOT, 'contracts', 'test');

// ── glob → RegExp ─────────────────────────────────────────────────────────
// Deliberately implements only the subset the manifest is allowed to use, and
// matches `globset` (the crate behind `forge --match-path`) on that subset:
//   {a,b}   alternation, non-nested; may contain `/`
//   *       any run of non-separator chars — does NOT cross `/`
//   ?       exactly one non-separator char
//   [...]   character class, passed through (e.g. `[0-9]`)
// Anything else is literal. A pattern using an unsupported construct (`**`,
// nested braces) is rejected rather than silently mis-matched.

/** Expand non-nested `{a,b,c}` groups into a flat list of brace-free patterns. */
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) throw new Error(`unbalanced '{' in pattern: ${pattern}`);
  const inner = pattern.slice(open + 1, close);
  if (inner.includes('{')) throw new Error(`nested braces are not supported: ${pattern}`);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return inner.split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

function globToRegExp(pattern) {
  if (pattern.includes('**')) {
    throw new Error(`'**' is not supported (forge slices must stay single-directory): ${pattern}`);
  }
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) throw new Error(`unbalanced '[' in pattern: ${pattern}`);
      re += pattern.slice(i, close + 1);
      i = close;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function compile(pattern) {
  return expandBraces(pattern).map(globToRegExp);
}

const matches = (regexps, file) => regexps.some((r) => r.test(file));

/**
 * The `--no-match-test` regex a slice actually runs under.
 *
 * The shared default excludes anything NAMED Invariant/Fuzz, which is right for
 * the unit slices but would silence a slice whose whole job is invariants — the
 * `invariants` slice would match its files, run zero tests, and exit 0. A slice
 * may therefore override it. The non-zero-test assertion in verifySlice() runs
 * against the EFFECTIVE filter, so an override that silences everything still
 * fails loudly rather than passing over nothing.
 */
const filterFor = (manifest, slice) => slice.noMatchTest ?? manifest.noMatchTest;

// ── inputs ────────────────────────────────────────────────────────────────

/** All `*.t.sol` under contracts/test, as `test/...`-relative POSIX paths. */
function findTestFiles(dir = TEST_ROOT, prefix = 'test') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...findTestFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.t.sol')) out.push(rel);
  }
  return out;
}

function loadManifest() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(m.slices) || m.slices.length === 0) throw new Error('manifest has no slices');
  if (!Array.isArray(m.excluded)) throw new Error('manifest has no excluded[] (use [] if truly empty)');
  if (typeof m.noMatchTest !== 'string') throw new Error('manifest has no noMatchTest string');
  for (const s of m.slices) {
    if (!s.slice || !s.pattern) throw new Error(`slice entry needs {slice, pattern}: ${JSON.stringify(s)}`);
    if (s.noMatchTest !== undefined && typeof s.noMatchTest !== 'string') {
      throw new Error(`slice "${s.slice}" has a non-string noMatchTest override`);
    }
  }
  for (const e of m.excluded) {
    if (!e.pattern || !e.reason) throw new Error(`excluded entry needs {pattern, reason}: ${JSON.stringify(e)}`);
  }
  return m;
}

// ── modes ─────────────────────────────────────────────────────────────────

function check(manifest, files) {
  const errors = [];
  const claimedBy = new Map(); // file -> [slice names]
  const excludedBy = new Map(); // file -> [excluded patterns]

  for (const s of manifest.slices) {
    const re = compile(s.pattern);
    const hit = files.filter((f) => matches(re, f));
    if (hit.length === 0) {
      errors.push(
        `slice "${s.slice}" pattern '${s.pattern}' matches ZERO test files. ` +
          `forge exits 0 on an empty match, so this slice would run nothing and still go green. ` +
          `Fix the glob (remember: '*' does not cross '/') or delete the slice.`,
      );
    }
    for (const f of hit) claimedBy.set(f, [...(claimedBy.get(f) ?? []), s.slice]);
  }

  for (const e of manifest.excluded) {
    const re = compile(e.pattern);
    const hit = files.filter((f) => matches(re, f));
    if (hit.length === 0) {
      errors.push(
        `excluded pattern '${e.pattern}' matches ZERO test files — stale exclusion, delete it. ` +
          `Reason on record: ${e.reason}`,
      );
    }
    for (const f of hit) excludedBy.set(f, [...(excludedBy.get(f) ?? []), e.pattern]);
  }

  const unclaimed = files.filter((f) => !claimedBy.has(f) && !excludedBy.has(f));
  if (unclaimed.length > 0) {
    errors.push(
      `${unclaimed.length} test file(s) are matched by NO slice and NO exclusion — they never run in CI:\n` +
        unclaimed.map((f) => `      contracts/${f}`).join('\n') +
        `\n    Add each to a slice pattern in .github/contracts-test-slices.json, or add an ` +
        `excluded[] entry with an honest reason.`,
    );
  }

  const doubled = [...claimedBy].filter(([, s]) => s.length > 1);
  if (doubled.length > 0) {
    errors.push(
      `test file(s) claimed by more than one slice (they would run twice and skew slice balance):\n` +
        doubled.map(([f, s]) => `      contracts/${f} → ${s.join(', ')}`).join('\n'),
    );
  }

  const contradictory = files.filter((f) => claimedBy.has(f) && excludedBy.has(f));
  if (contradictory.length > 0) {
    errors.push(
      `test file(s) are both sliced and excluded — the manifest contradicts itself:\n` +
        contradictory
          .map((f) => `      contracts/${f} → slice ${claimedBy.get(f).join(', ')} vs excluded ${excludedBy.get(f).join(', ')}`)
          .join('\n'),
    );
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`::error file=.github/contracts-test-slices.json::${e.split('\n')[0]}`);
      console.error(`  ✗ ${e}`);
    }
    console.error(`\n❌ test-slice coverage guard failed (${errors.length} problem(s)).`);
    process.exit(1);
  }

  const sliced = files.length - excludedBy.size;
  console.log(`✅ test-slice coverage: ${sliced}/${files.length} test files covered by ${manifest.slices.length} slices; ` +
    `${excludedBy.size} explicitly excluded.`);
  for (const s of manifest.slices) {
    const re = compile(s.pattern);
    const n = files.filter((f) => matches(re, f)).length;
    console.log(`   ${String(n).padStart(3)}  ${s.slice.padEnd(22)} ${s.pattern}`);
  }
  for (const e of manifest.excluded) {
    const re = compile(e.pattern);
    const n = files.filter((f) => matches(re, f)).length;
    console.log(`   ${String(n).padStart(3)}  ${'(excluded)'.padEnd(22)} ${e.pattern}`);
  }
}

// ── forge cross-check ─────────────────────────────────────────────────────
// Runs inside a slice job, where the slice's tests are already compiled. Two
// separate assertions, deliberately:
//
//   (a) FILE SET — `--list` WITHOUT the name filter, compared against this
//       script's own prediction. This is what keeps the hand-rolled glob
//       subset above honest against forge's `globset`. Without it, a matcher
//       bug that OVER-claims files (e.g. letting `*` cross `/`) would make the
//       coverage check pass while CI ran nothing.
//
//   (b) TEST COUNT — `--list` WITH the name filter, asserted non-zero. This is
//       the direct answer to `forge test` exiting 0 on "No tests found in
//       project!". A slice whose files all consist of Fuzz/Invariant-named
//       tests would compile, match files, run nothing, and go green.
//
// (a) and (b) are not redundant: (a) can hold while (b) is zero.

function forgeList(pattern, extraArgs) {
  const raw = execFileSync('forge', ['test', '--match-path', pattern, '--list', '--json', ...extraArgs], {
    cwd: join(REPO_ROOT, 'contracts'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // forge can precede the payload with log lines; take the last parseable line.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`could not parse JSON from 'forge test --list --json':\n${raw.slice(0, 800)}`);
}

/** forge keys files by path; normalise to the `test/...`-relative POSIX form. */
function normaliseKey(key) {
  const posix = key.replace(/\\/g, '/');
  const at = posix.lastIndexOf('/test/');
  return at === -1 ? posix.replace(/^\.\//, '') : posix.slice(at + 1);
}

const countTests = (listing) =>
  Object.values(listing).reduce(
    (total, suites) => total + Object.values(suites).reduce((n, fns) => n + fns.length, 0),
    0,
  );

function verifySlice(manifest, files, name) {
  const s = manifest.slices.find((x) => x.slice === name);
  if (!s) {
    console.error(`unknown slice '${name}'; known: ${manifest.slices.map((x) => x.slice).join(', ')}`);
    process.exit(1);
  }

  const predicted = files.filter((f) => matches(compile(s.pattern), f)).sort();
  const actual = [...new Set(Object.keys(forgeList(s.pattern, [])).map(normaliseKey))].sort();

  const missing = predicted.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !predicted.includes(f));
  let failed = false;

  if (missing.length > 0 || extra.length > 0) {
    failed = true;
    console.error(
      `::error::slice '${name}': forge's --match-path result disagrees with the coverage guard's prediction. ` +
        `The glob subset in scripts/check-test-slice-coverage.mjs has drifted from forge's globset semantics — ` +
        `the coverage guard cannot be trusted until this is reconciled.`,
    );
    for (const f of missing) console.error(`  ✗ predicted but forge did NOT match: contracts/${f}`);
    for (const f of extra) console.error(`  ✗ forge matched but NOT predicted:     contracts/${f}`);
  }

  const filter = filterFor(manifest, s);
  const runnable = countTests(forgeList(s.pattern, ['--no-match-test', filter]));
  if (runnable === 0) {
    failed = true;
    console.error(
      `::error::slice '${name}' pattern '${s.pattern}' resolves to ZERO runnable tests after ` +
        `--no-match-test '${filter}'. forge exits 0 on an empty selection, so this slice ` +
        `would report success without executing anything.`,
    );
  }

  if (failed) process.exit(1);
  console.log(
    `✅ slice '${name}': ${actual.length} file(s) matched (prediction agrees with forge), ` +
      `${runnable} runnable test(s) after the name filter.`,
  );
}

// ── entry ─────────────────────────────────────────────────────────────────

function main(argv) {
  const manifest = loadManifest();
  const files = findTestFiles();

  if (argv[0] === '--emit-matrix') {
    // Each entry carries its OWN resolved noMatchTest, so the workflow never has
    // to know about the default-vs-override distinction — it just uses
    // `matrix.noMatchTest`. Resolving here keeps that logic in one place.
    console.log(JSON.stringify({
      include: manifest.slices.map((s) => ({
        slice: s.slice,
        pattern: s.pattern,
        noMatchTest: filterFor(manifest, s),
      })),
    }));
  } else if (argv[0] === '--expect') {
    const name = argv[1];
    const s = manifest.slices.find((x) => x.slice === name);
    if (!s) throw new Error(`unknown slice '${name}'; known: ${manifest.slices.map((x) => x.slice).join(', ')}`);
    const re = compile(s.pattern);
    for (const f of files.filter((f) => matches(re, f))) console.log(f);
  } else if (argv[0] === '--verify-slice') {
    verifySlice(manifest, files, argv[1]);
  } else if (argv.length === 0 || argv[0] === '--check') {
    check(manifest, files);
  } else {
    throw new Error(`unknown argument: ${argv[0]}`);
  }
}

// A malformed manifest (bad JSON, unbalanced brace, unsupported `**`) must read
// as a CI annotation, not a raw stack trace — this file is edited by whoever
// adds a test directory, and the message is the whole point of the guard.
try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`::error file=.github/contracts-test-slices.json::${err.message}`);
  console.error(`❌ test-slice guard could not run: ${err.message}`);
  process.exit(1);
}
