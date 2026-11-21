// Mutation proof for every pinned check.
//
// For each line in src/ that ends with `// PIN:<id>`, this script deletes that one line
// (the check), runs the test suite, and requires the suite to fail with at least one failing
// test whose title names that pin (`PIN:<id>`). Then it restores the file and proves the
// restore: the sha256 of the file after equals the sha256 before. A pin whose removal no
// test notices is reported as SURVIVED and the script exits 1.
//
// A run cut short (Ctrl+C, a crash, a closed window) must not leave a mutant behind, so the
// original of the file being mutated is copied to test/.mutate-backup/ first and restored in
// a `finally`; a run that finds leftovers there restores them before doing anything else
// (and the signer itself refuses to start while that folder holds a file).
//
//   node test/mutate.mjs                  every pin
//   node test/mutate.mjs P7.max T.to      only these pins
//   node test/mutate.mjs --restore        only put back what a cut-short run left behind
//   node test/mutate.mjs --out report.json
//
// Not a test file: `node --test` runs every .mjs under test/, so under the test runner this
// script exits at once without doing anything.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BACKUP = path.join(ROOT, 'test', '.mutate-backup');
const MARK = /\/\/ PIN:([A-Za-z0-9.]+)\s*$/;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const say = (line) => process.stdout.write(`${line}\n`);

function restoreLeftovers() {
  if (!fs.existsSync(BACKUP)) return 0;
  let restored = 0;
  for (const name of fs.readdirSync(BACKUP).filter((n) => n.endsWith('.orig'))) {
    const base = name.slice(0, -'.orig'.length);
    const want = fs.readFileSync(path.join(BACKUP, `${base}.sha256`), 'utf8').trim();
    fs.copyFileSync(path.join(BACKUP, name), path.join(SRC, base));
    const got = sha256(path.join(SRC, base));
    if (got !== want) throw new Error(`restoring ${base}: sha256 ${got} is not the recorded ${want}`);
    say(`restored src/${base} from a cut-short run (sha256 ${got})`);
    restored++;
  }
  fs.rmSync(BACKUP, { recursive: true, force: true });
  return restored;
}

function collectPins() {
  const pins = [];
  for (const name of fs.readdirSync(SRC).filter((n) => n.endsWith('.mjs')).sort()) {
    fs.readFileSync(path.join(SRC, name), 'utf8').split('\n').forEach((text, i) => {
      const m = MARK.exec(text);
      if (m) pins.push({ id: m[1], file: name, line: i + 1 });
    });
  }
  const seen = new Map();
  for (const p of pins) {
    if (seen.has(p.id)) throw new Error(`pin ${p.id} is marked twice (${seen.get(p.id)} and ${p.file}:${p.line}); every pin needs its own id`);
    seen.set(p.id, `${p.file}:${p.line}`);
  }
  return pins;
}

const testFiles = () => fs.readdirSync(path.join(ROOT, 'test')).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => path.join('test', n));

function runSuiteOnce() {
  const env = { ...process.env };
  delete env.HOUSE_SIGNER_LIVE_RPC; // the mutation runs never touch the network
  // The suite takes seconds; a run still going after two minutes has hung and is retried.
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles()], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const stdout = r.stdout ?? '';
  const failed = [...stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1].trim()).filter((n) => !/\.test\.mjs$/.test(n));
  // A run that never started (the machine out of processes, a timeout) is not a pass and not
  // a kill: it has no exit code or no "# tests N" summary.
  const ran = !r.error && typeof r.status === 'number' && /^# tests \d+/m.test(stdout);
  return { ran, status: r.status, failed, error: r.error?.code ?? null };
}

/** The suite, retried (with a pause) when it did not run at all. */
function runSuite() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = runSuiteOnce();
    if (last.ran) return last;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000 * attempt);
  }
  return last;
}

const namesPin = (title, id) => new RegExp(`PIN:${id.replace(/\./g, '\\.')}(?![A-Za-z0-9.])`).test(title);

let current = null; // { file, original } while a mutant is on disk
function putBack() {
  if (!current) return;
  fs.writeFileSync(current.file, current.original);
  current = null;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    putBack();
    restoreLeftovers();
    process.exit(130);
  });
}

function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const only = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1));
  const leftovers = restoreLeftovers();
  if (args.includes('--restore')) {
    say(leftovers ? `restored ${leftovers} file(s)` : 'nothing to restore');
    return 0;
  }

  const pins = collectPins().filter((p) => only.length === 0 || only.includes(p.id));
  if (pins.length === 0) throw new Error('no pins matched');
  const before = Object.fromEntries(fs.readdirSync(SRC).map((n) => [n, sha256(path.join(SRC, n))]));

  const baseline = runSuite();
  if (!baseline.ran || baseline.status !== 0) throw new Error(`the unmutated suite does not pass (${baseline.ran ? baseline.failed.join('; ') : `did not run: ${baseline.error ?? 'no summary'}`}); fix that first`);
  say(`baseline: suite passes; ${pins.length} pins to mutate`);

  const results = [];
  for (const pin of pins) {
    const file = path.join(SRC, pin.file);
    const original = fs.readFileSync(file);
    const shaBefore = sha256(file);
    fs.mkdirSync(BACKUP, { recursive: true });
    fs.writeFileSync(path.join(BACKUP, `${pin.file}.orig`), original);
    fs.writeFileSync(path.join(BACKUP, `${pin.file}.sha256`), shaBefore);
    let run;
    let parses;
    let shaAfter;
    try {
      const lines = original.toString('utf8').split('\n');
      const indent = /^\s*/.exec(lines[pin.line - 1])[0];
      lines[pin.line - 1] = `${indent}// [mutate.mjs removed PIN:${pin.id}]`;
      current = { file, original };
      fs.writeFileSync(file, lines.join('\n'));
      parses = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status === 0;
      run = parses ? runSuite() : { ran: false, status: null, failed: [] };
    } finally {
      putBack();
      shaAfter = sha256(file);
      if (shaAfter !== shaBefore) throw new Error(`restore of ${pin.file} failed: ${shaAfter} != ${shaBefore}`);
      fs.rmSync(BACKUP, { recursive: true, force: true });
    }
    const named = run.failed.filter((t) => namesPin(t, pin.id));
    const killed = parses && run.ran && run.status !== 0 && named.length > 0;
    let label = killed ? 'KILLED  ' : 'SURVIVED';
    if (!parses) label = 'BROKEN  '; // the mutant did not even parse: proves nothing
    else if (!run.ran) label = 'NOT RUN '; // the suite never started: proves nothing either way
    results.push({
      pin: pin.id, at: `src/${pin.file}:${pin.line}`, parses, suiteRan: run.ran, suiteExit: run.status, failedTests: run.failed.length, failedForThisPin: named, killed, sha256Before: shaBefore, sha256After: shaAfter,
    });
    say(`${label} PIN:${pin.id.padEnd(22)} ${`src/${pin.file}:${pin.line}`.padEnd(26)} ${run.failed.length} failing; e.g. "${named[0] ?? run.failed[0] ?? '-'}"`);
  }

  const after = Object.fromEntries(fs.readdirSync(SRC).map((n) => [n, sha256(path.join(SRC, n))]));
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const final = runSuite();
  const survived = results.filter((r) => !r.killed);
  const report = {
    when: new Date().toISOString(),
    pins: results.length,
    killed: results.length - survived.length,
    survived: survived.filter((r) => r.parses && r.suiteRan).map((r) => r.pin),
    notProven: survived.filter((r) => !r.parses || !r.suiteRan).map((r) => r.pin),
    srcUnchanged: unchanged,
    finalSuitePasses: final.ran && final.status === 0,
    srcSha256: after,
    results,
  };
  say(`\n${report.killed}/${report.pins} pins killed; survived: ${report.survived.join(', ') || 'none'}; not proven (mutant broken or suite did not run): ${report.notProven.join(', ') || 'none'}; src unchanged after the run: ${unchanged}; suite passes after the run: ${report.finalSuitePasses}`);
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  return survived.length === 0 && unchanged && report.finalSuitePasses ? 0 : 1;
}

let code = 1;
try {
  code = main();
} finally {
  putBack();
  restoreLeftovers();
}
process.exit(code);
